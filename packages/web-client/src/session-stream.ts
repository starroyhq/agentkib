import {
  parseRemoteErrorCode,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
} from "@agentkib/runtime-protocol";
import { ApiError, decodeApiError } from "./api-error";

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
  /** Reports when automated recovery has stopped and a fresh read is needed. */
  error: (error?: unknown, recovery?: "stopped") => void;
}

const errorContract = new Map<
  string,
  (typeof REMOTE_ERROR_CONTRACT)[keyof typeof REMOTE_ERROR_CONTRACT]
>(Object.values(REMOTE_ERROR_CONTRACT).map((entry) => [entry.code, entry]));
const MAX_RECONNECT_ATTEMPTS = 6;

function decodeStreamReason(data: string) {
  try {
    const reason = parseRemoteErrorCode(JSON.parse(data)?.reason);
    return reason === REMOTE_ERROR_CODES.accessEnded ? undefined : reason;
  } catch {
    return undefined;
  }
}

async function handshakeFailure(response: Response): Promise<ApiError> {
  const { status } = response;
  const options = {
    retryAfter: response.headers.get("Retry-After"),
    defaultCode:
      status === 429 ? REMOTE_ERROR_CODES.rateLimited : REMOTE_ERROR_CODES.streamUnavailable,
  };
  let body: unknown;
  const reader = response.body?.getReader();
  if (reader) {
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => {});
    }, 1000);
    try {
      const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim();
      if (mediaType?.toLowerCase() === "application/json") {
        const decoder = new TextDecoder();
        let bytes = 0;
        let text = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (!timedOut) body = JSON.parse(text + decoder.decode());
            break;
          }
          bytes += value.byteLength;
          if (bytes > 4096) break;
          text += decoder.decode(value, { stream: true });
        }
      }
    } catch {
      // A missing or incomplete body supplies no proof of an ended authorization.
    } finally {
      clearTimeout(deadline);
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  const failure = decodeApiError(status, body, options);
  if (failure.code === REMOTE_ERROR_CODES.accessEnded && status !== 401)
    return decodeApiError(status, undefined, options);
  // A proxy can rate limit a stream without the host's structured error body.
  return status !== 429 ||
    failure.code === REMOTE_ERROR_CODES.rateLimited ||
    failure.code === REMOTE_ERROR_CODES.streamLimit
    ? failure
    : decodeApiError(status, undefined, options);
}

function streamError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    if (parseRemoteErrorCode(error.code)) return error;
    const failure = new ApiError(error.status, REMOTE_ERROR_CODES.streamUnavailable);
    failure.retryAfterMs = error.retryAfterMs;
    return failure;
  }
  const code = error instanceof Error ? parseRemoteErrorCode(error.message) : undefined;
  return new ApiError(
    0,
    (code !== REMOTE_ERROR_CODES.accessEnded && code) || REMOTE_ERROR_CODES.streamUnavailable,
  );
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
          const reason = decodeStreamReason(data) ?? REMOTE_ERROR_CODES.streamUnavailable;
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
    if (failure.status === 401 && failure.code === REMOTE_ERROR_CODES.accessEnded) {
      handlers.event("access-ended", "");
      close();
      return;
    }
    const retry = errorContract.get(failure.code)?.retry;
    // Reopening an interrupted read stream verifies its updated scope at the host.
    const scopeChanged = failure === terminal && failure.code === REMOTE_ERROR_CODES.accessChanged;
    if (openedAt !== undefined && Date.now() - openedAt >= 10_000) failures = 0;
    if (
      (scopeChanged || retry === "after-backoff") &&
      failure.status !== 401 &&
      failure.status !== 403 &&
      failures < MAX_RECONNECT_ATTEMPTS
    ) {
      const delay = Math.max(
        conversationReconnectDelay(failures++, 2000, 30_000),
        failure.retryAfterMs ?? 0,
      );
      if (delay <= 2_147_483_647) {
        handlers.error(failure);
        if (!closed) timer = setTimeout(() => void run(), delay);
        return;
      }
    }
    close();
    handlers.error(failure, "stopped");
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
