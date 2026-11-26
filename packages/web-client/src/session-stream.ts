import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";

// The host sends a heartbeat every 15 seconds, apart from backpressure.
const STALE_LAN_STREAM_MS = 45_000;

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

export function openWebSessionStream(
  path: string,
  handlers: SessionStreamHandlers,
  fetchStream?: (path: string, signal: AbortSignal) => Promise<Response>,
) {
  let failures = 0;
  let openedAt: number | undefined;
  const opened = () => {
    openedAt = Date.now();
    handlers.open();
  };
  const retryDelay = () => {
    if (openedAt !== undefined && Date.now() - openedAt >= 10_000) failures = 0;
    openedAt = undefined;
    return conversationReconnectDelay(failures++, 2000, 30_000);
  };
  if (!fetchStream) {
    let closed = false;
    let source: EventSource | undefined;
    let cursor: string | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const disconnect = (current: EventSource) => {
      if (closed || source !== current) return;
      // EventSource's implicit Last-Event-ID includes unaccepted frames. Recreate
      // the connection ourselves using only the reducer's applied cursor.
      current.close();
      source = undefined;
      handlers.error();
      if (!closed) retry = setTimeout(connect, retryDelay());
    };
    const probe = () => {
      // Chromium and Safari own the socket. Check its native CLOSED state before
      // a foreground or network wakeup can trigger a fresh connection.
      if (globalThis.document?.visibilityState !== "hidden" && source?.readyState === 2)
        disconnect(source);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      source?.close();
      clearTimeout(retry);
      globalThis.document?.removeEventListener("visibilitychange", probe);
      globalThis.window?.removeEventListener("focus", probe);
      globalThis.window?.removeEventListener("online", probe);
    };
    const connect = () => {
      if (closed) return;
      const current = new EventSource(
        cursor ? `${path}&afterCursor=${encodeURIComponent(cursor)}` : path,
      );
      source = current;
      for (const type of [
        "session-event",
        "session-ready",
        "control-changed",
        "catalog-invalidated",
        "access-changed",
        "unavailable",
        "access-ended",
      ])
        current.addEventListener(type, (e) => {
          if (closed || source !== current) return;
          const event = e as MessageEvent;
          const applied = handlers.event(type, event.data, event.lastEventId || undefined);
          if (typeof applied === "string") cursor = applied;
          if (type === "access-ended") close();
        });
      current.onopen = () => {
        if (!closed && source === current) opened();
      };
      current.onerror = () => disconnect(current);
    };
    globalThis.document?.addEventListener("visibilitychange", probe);
    globalThis.window?.addEventListener("focus", probe);
    globalThis.window?.addEventListener("online", probe);
    connect();
    return close;
  }
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
    try {
      const streamPath = cursor ? `${path}&afterCursor=${encodeURIComponent(cursor)}` : path;
      const response = await fetchStream(streamPath, attempt.abort.signal);
      if (closed) return;
      if (attempt.abort.signal.aborted) throw new Error(REMOTE_ERROR_CODES.streamUnavailable);
      if (response.status === 401 || response.status === 403) {
        handlers.event("access-ended", "");
        close();
        return;
      }
      if (
        !response.ok ||
        !response.body ||
        !response.headers.get("content-type")?.includes("text/event-stream")
      )
        throw new Error(REMOTE_ERROR_CODES.streamUnavailable);
      opened();
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      attempt.reader = reader;
      const parser = new SseParser((type, data, id) => {
        if (closed || attempt.abort.signal.aborted) return;
        const applied = handlers.event(type, data, id);
        if (typeof applied === "string") cursor = applied;
        if (type === "access-ended") close();
      });
      try {
        while (!attempt.abort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          attempt.lastBytesAt = Date.now();
          parser.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!closed) handlers.error();
    } catch (error) {
      if (!closed) handlers.error(error);
    } finally {
      active = undefined;
    }
    if (!closed) timer = setTimeout(() => void run(), retryDelay());
  };
  const stopAttempt = () => {
    active?.abort.abort();
    void active?.reader?.cancel().catch(() => {});
  };
  const probe = () => {
    if (
      globalThis.document?.visibilityState !== "hidden" &&
      active &&
      Date.now() - active.lastBytesAt >= STALE_LAN_STREAM_MS
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
