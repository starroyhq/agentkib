import { REMOTE_ERROR_CODES, REMOTE_ERROR_CONTRACT } from "@agentkib/runtime-protocol";
import { ApiError, parseRetryAfter } from "./api-error";

// The host sends a heartbeat every 15 seconds, apart from backpressure.
const STALE_STREAM_MS = 45_000;

type FetchAttempt = {
  abort: AbortController;
  lastBytesAt: number;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
};

export function conversationReconnectDelay(attempt: number, initialMs: number, maxMs: number) {
  // Leave room for jitter even at the cap so clients do not synchronize retries.
  const base = Math.min(initialMs * 2 ** attempt, maxMs / 1.2);
  return Math.round(base * (1 + 0.2 * Math.random()));
}

export interface SessionStreamHandlers {
  /** Return the last cursor actually applied by the consumer; rejected frames never advance it. */
  event: (type: string, data: string, cursor?: string) => void | false | string;
  open: () => void;
  error: (error?: unknown) => void;
}

const errorContract = new Map<
  string,
  (typeof REMOTE_ERROR_CONTRACT)[keyof typeof REMOTE_ERROR_CONTRACT]
>(Object.values(REMOTE_ERROR_CONTRACT).map((entry) => [entry.code, entry]));
const MAX_RECONNECT_ATTEMPTS = 6;

function streamReason(data: unknown, field: "error" | "reason") {
  if (!data || typeof data !== "object" || !(field in data)) return;
  const value = (data as Record<string, unknown>)[field];
  if (typeof value === "string") return errorContract.get(value)?.code;
}

function decodeFailure(data: string, field: "error" | "reason") {
  try {
    return streamReason(JSON.parse(data), field);
  } catch {
    return undefined;
  }
}

async function handshakeFailure(response: Response): Promise<ApiError> {
  const { status } = response;
  const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
  const fallback =
    status === 429 ? REMOTE_ERROR_CODES.rateLimited : REMOTE_ERROR_CODES.streamUnavailable;
  let code: string = fallback;
  const reader = response.body?.getReader();
  if (reader) {
    const deadline = setTimeout(() => void reader.cancel().catch(() => {}), 1000);
    try {
      if (response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            code = decodeFailure(text, "error") ?? fallback;
            break;
          }
          bytes += value.byteLength;
          if (bytes > 4096) break;
          text += decoder.decode(value, { stream: true });
        }
      }
    } catch {
      // Without a complete error body, the HTTP status and retry header still apply.
    } finally {
      clearTimeout(deadline);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const failure = new ApiError(status, code);
  failure.retryAfterMs = retryAfterMs;
  return failure;
}

function streamError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    if (errorContract.has(error.code)) return error;
    const failure = new ApiError(error.status, REMOTE_ERROR_CODES.streamUnavailable);
    failure.retryAfterMs = error.retryAfterMs;
    return failure;
  }
  const code = error instanceof Error ? errorContract.get(error.message)?.code : undefined;
  return new ApiError(0, code ?? REMOTE_ERROR_CODES.streamUnavailable);
}

export function openWebSessionStream(
  path: string,
  handlers: SessionStreamHandlers,
  fetchStream: (path: string, signal: AbortSignal) => Promise<Response>,
) {
  let failures = 0;
  let closed = false;
  let active: FetchAttempt | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cursor: string | undefined;
  const run = async () => {
    if (closed || active) return;
    const attempt: FetchAttempt = {
      abort: new AbortController(),
      lastBytesAt: Date.now(),
    };
    active = attempt;
    let openedAt: number | undefined;
    let terminal: ApiError | undefined;
    let failure: ApiError;
    try {
      const streamPath = cursor ? `${path}&afterCursor=${encodeURIComponent(cursor)}` : path;
      const response = await fetchStream(streamPath, attempt.abort.signal);
      if (attempt.abort.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        if (closed) return;
        throw new ApiError(0, REMOTE_ERROR_CODES.streamUnavailable);
      }
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        handlers.event("access-ended", "");
        close();
        return;
      }
      if (!response.ok) throw await handshakeFailure(response);
      const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
      if (!response.body || mediaType?.toLowerCase() !== "text/event-stream") {
        void response.body?.cancel().catch(() => {});
        throw new ApiError(response.status, REMOTE_ERROR_CODES.streamInvalidResponse);
      }
      openedAt = Date.now();
      handlers.open();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      attempt.reader = reader;
      const parser = new SseParser((type, data, id) => {
        if (closed || terminal || attempt.abort.signal.aborted) return;
        if (type === "unavailable") {
          const reason = decodeFailure(data, "reason") ?? REMOTE_ERROR_CODES.streamUnavailable;
          terminal = new ApiError(0, reason);
          handlers.event(type, JSON.stringify({ reason }));
          return;
        }
        const applied = handlers.event(type, data, id);
        if (typeof applied === "string") cursor = applied;
        if (type === "access-ended") close();
      });
      try {
        while (!terminal && !attempt.abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          attempt.lastBytesAt = Date.now();
          parser.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      failure = terminal ?? new ApiError(0, REMOTE_ERROR_CODES.streamUnavailable);
    } catch (error) {
      failure = streamError(error);
    } finally {
      active = undefined;
    }
    if (closed) return;
    if (failure.status === 401 || failure.status === 403) {
      handlers.event("access-ended", "");
      close();
      return;
    }
    handlers.error(failure);
    const retry = errorContract.get(failure.code)?.retry;
    if (
      closed ||
      (failure.status !== 429 &&
        retry !== "after-backoff" &&
        !(retry === "unclassified" && failure.status >= 500))
    )
      return;
    if (openedAt !== undefined && Date.now() - openedAt >= 10_000) failures = 0;
    if (failures >= MAX_RECONNECT_ATTEMPTS) return;
    const delay = Math.max(
      conversationReconnectDelay(failures++, 2000, 30_000),
      failure.retryAfterMs ?? 0,
    );
    if (delay <= 2_147_483_647) timer = setTimeout(() => void run(), delay);
  };
  const stopAttempt = () => {
    active?.abort.abort();
    void active?.reader?.cancel().catch(() => {});
  };
  const probe = () => {
    if (
      globalThis.document?.visibilityState !== "hidden" &&
      active &&
      Date.now() - active.lastBytesAt >= STALE_STREAM_MS
    )
      stopAttempt();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopAttempt();
    clearTimeout(timer);
    globalThis.document?.removeEventListener("visibilitychange", probe);
    globalThis.window?.removeEventListener("focus", probe);
    globalThis.window?.removeEventListener("online", probe);
  };
  globalThis.document?.addEventListener("visibilitychange", probe);
  globalThis.window?.addEventListener("focus", probe);
  globalThis.window?.addEventListener("online", probe);
  void run();
  return close;
}

export class SseParser {
  private lineParts: string[] = [];
  private lineBytes = 0;
  private lastCodeUnit = 0;
  private event = "message";
  private id: string | undefined;
  private data: string[] = [];
  private dataBytes = 0;
  private encoder = new TextEncoder();
  constructor(private readonly emit: (event: string, data: string, cursor?: string) => void) {}
  push(chunk: string) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const part = chunk.slice(start, end < 0 ? chunk.length : end);
      if (part) {
        this.lineBytes += this.encoder.encode(part).byteLength;
        // A surrogate pair split between push calls encodes as four bytes, not
        // two replacement characters (six bytes). TextDecoder normally avoids this.
        const first = part.charCodeAt(0);
        if (
          this.lastCodeUnit >= 0xd800 &&
          this.lastCodeUnit <= 0xdbff &&
          first >= 0xdc00 &&
          first <= 0xdfff
        )
          this.lineBytes -= 2;
        this.lastCodeUnit = part.charCodeAt(part.length - 1);
        if (this.lineBytes + this.dataBytes > 4 * 1024 * 1024 + 1024)
          throw new Error(REMOTE_ERROR_CODES.streamTooLarge);
        this.lineParts.push(part);
      }
      if (end < 0) return;
      // Join only completed lines: neither scanning nor byte accounting revisits
      // an accumulated near-4 MiB prefix on every network chunk.
      const line = this.lineParts.join("").replace(/\r$/, "");
      this.lineParts = [];
      this.lineBytes = 0;
      this.lastCodeUnit = 0;
      start = end + 1;
      if (!line) {
        if (this.data.length) {
          if (this.id) this.emit(this.event, this.data.join("\n"), this.id);
          else this.emit(this.event, this.data.join("\n"));
        }
        this.event = "message";
        this.data = [];
        this.dataBytes = 0;
      } else if (line.startsWith("id:")) {
        const id = line.slice(3).replace(/^ /, "");
        if (id.length > 4096) throw new Error(REMOTE_ERROR_CODES.streamCursorTooLarge);
        if (!id.includes("\0")) this.id = id;
      } else if (line.startsWith("event:")) {
        if (line.length > 128) throw new Error(REMOTE_ERROR_CODES.streamTooLarge);
        this.event = line.slice(6).replace(/^ /, "");
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.dataBytes += this.encoder.encode(value).byteLength + (this.data.length ? 1 : 0);
        if (this.dataBytes > 4 * 1024 * 1024) throw new Error(REMOTE_ERROR_CODES.streamTooLarge);
        this.data.push(value);
      }
    }
  }
}
