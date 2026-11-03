export type MessageImageLoader = ((
  imageId: string,
  signal: AbortSignal,
) => Promise<{ mimeType: string; base64: string }>) & { cacheScope?: string };

export type MessageImageSnapshot =
  | { readonly phase: "idle" | "loading" | "error" }
  | { readonly phase: "ready"; readonly src: string; readonly bytes: number };

/** Warm eviction can reload on visibility; withdrawal and cancellation need a new action. */
export type MessageImageCacheNotification = "withdrawn" | "cancelled";
type Listener = (event?: MessageImageCacheNotification) => void;

export interface MessageImageCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  idleTtlMs?: number;
  pendingAbortDelayMs?: number;
}

const idle: MessageImageSnapshot = Object.freeze({ phase: "idle" });
const loading: MessageImageSnapshot = Object.freeze({ phase: "loading" });
const error: MessageImageSnapshot = Object.freeze({ phase: "error" });
const loaderScopes = new WeakMap<MessageImageLoader, string>();
const legacyNamespace = `legacy-image-loader:${Math.random().toString(36).slice(2)}:`;
let nextScope = 0;

/** An explicit identity survives callback recreation; legacy callers remain isolated. */
export function messageImageScope(load: MessageImageLoader): string {
  if (typeof load.cacheScope === "string" && load.cacheScope.length > 0) return load.cacheScope;
  let scope = loaderScopes.get(load);
  if (!scope) {
    scope = `${legacyNamespace}${++nextScope}`;
    loaderScopes.set(load, scope);
  }
  return scope;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const mimeTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function imageBlob(value: { mimeType: string; base64: string }): Blob {
  if (
    !value ||
    !mimeTypes.has(value.mimeType) ||
    typeof value.base64 !== "string" ||
    !value.base64 ||
    value.base64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)
  )
    throw new Error("invalid-image");
  const text = atob(value.base64);
  if (!text.length || text.length > MAX_IMAGE_BYTES) throw new Error("invalid-image");
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
  return new Blob([bytes], { type: value.mimeType });
}

interface Flight {
  abort: AbortController;
}
interface Entry {
  key: string;
  scope: string;
  id: string;
  state: MessageImageSnapshot;
  readers: number;
  touched: number;
  flight?: Flight;
  load?: MessageImageLoader;
  timer?: ReturnType<typeof setTimeout>;
}

/** In-memory verified media only. Active readers may exceed the warm-cache budget. */
export class MessageImageCache {
  #entries = new Map<string, Entry>();
  #listeners = new Map<string, Set<Listener>>();
  #bytes = 0;
  #clock = 0;
  #trimQueued = false;
  readonly #maxBytes: number;
  readonly #maxEntries: number;
  readonly #idleTtlMs: number;
  readonly #pendingAbortDelayMs: number;

  constructor(options: MessageImageCacheOptions = {}) {
    const limit = (value: number | undefined, fallback: number) => {
      const result = value ?? fallback;
      if (!Number.isSafeInteger(result) || result < 0) throw new RangeError("invalid-cache-limit");
      return result;
    };
    this.#maxBytes = limit(options.maxBytes, 64 * 1024 * 1024);
    this.#maxEntries = limit(options.maxEntries, 128);
    this.#idleTtlMs = limit(options.idleTtlMs, 5 * 60 * 1000);
    this.#pendingAbortDelayMs = limit(options.pendingAbortDelayMs, 150);
  }

  snapshot(scope: string, id: string): MessageImageSnapshot {
    return this.#entries.get(this.#key(scope, id))?.state ?? idle;
  }

  subscribe(scope: string, id: string, listener: Listener): () => void {
    const key = this.#key(scope, id);
    let listeners = this.#listeners.get(key);
    if (!listeners) this.#listeners.set(key, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size && this.#listeners.get(key) === listeners) this.#listeners.delete(key);
    };
  }

  acquire(scope: string, id: string, load: MessageImageLoader): () => void {
    const entry = this.#entry(scope, id);
    this.#cancelTimer(entry);
    entry.readers++;
    entry.touched = ++this.#clock;
    if (entry.state.phase === "idle") this.#start(entry, load);
    else if (entry.state.phase === "loading") entry.load = load;
    this.#trim();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.#entries.get(entry.key) !== entry) return;
      entry.readers--;
      if (!entry.readers) {
        entry.touched = ++this.#clock;
        this.#expire(entry);
        this.#trimAfterRelease();
      }
    };
  }

  /** Existing failures are retried only by an explicit user action. */
  retry(scope: string, id: string, load: MessageImageLoader): void {
    const entry = this.#entry(scope, id);
    if (entry.state.phase === "ready") return;
    if (entry.state.phase === "loading") {
      entry.load = load;
      return;
    }
    entry.touched = ++this.#clock;
    this.#start(entry, load);
    if (!entry.readers) this.#expire(entry);
    this.#trim();
  }

  /** A decode failure withdraws its resource and remains an error until retried. */
  invalidate(scope: string, id: string): void {
    const entry = this.#entries.get(this.#key(scope, id));
    if (!entry) return;
    this.#cancelTimer(entry);
    this.#abort(entry);
    this.#revoke(entry);
    entry.state = error;
    entry.touched = ++this.#clock;
    if (!entry.readers) this.#expire(entry);
    this.#notify(entry.key);
    this.#trim();
  }

  /** Identity changes revoke even pinned views; obsolete flights cannot reinsert. */
  clear(scope?: string): void {
    const removed: string[] = [];
    for (const entry of this.#entries.values())
      if (scope === undefined || scope === entry.scope) {
        this.#remove(entry, false);
        removed.push(entry.key);
      }
    for (const key of removed) this.#notify(key, "withdrawn");
  }

  #key(scope: string, id: string): string {
    return JSON.stringify([scope, id]);
  }

  #entry(scope: string, id: string): Entry {
    const key = this.#key(scope, id);
    let entry = this.#entries.get(key);
    if (!entry) {
      entry = { key, scope, id, state: idle, readers: 0, touched: ++this.#clock };
      this.#entries.set(key, entry);
    }
    return entry;
  }

  #notify(key: string, event?: MessageImageCacheNotification): void {
    for (const listener of [...(this.#listeners.get(key) ?? [])]) listener(event);
  }

  #cancelTimer(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  #abort(entry: Entry): void {
    const flight = entry.flight;
    entry.flight = undefined;
    entry.load = undefined;
    flight?.abort.abort();
  }

  #revoke(entry: Entry): void {
    if (entry.state.phase !== "ready") return;
    this.#bytes -= entry.state.bytes;
    URL.revokeObjectURL(entry.state.src);
    entry.state = idle;
  }

  #remove(entry: Entry, notify = true): void {
    if (this.#entries.get(entry.key) !== entry) return;
    this.#entries.delete(entry.key);
    this.#cancelTimer(entry);
    this.#abort(entry);
    this.#revoke(entry);
    if (notify) this.#notify(entry.key);
  }

  #expire(entry: Entry): void {
    this.#cancelTimer(entry);
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        if (!entry.readers) this.#remove(entry);
      },
      entry.state.phase === "loading" ? this.#pendingAbortDelayMs : this.#idleTtlMs,
    );
  }

  #trim(): void {
    while (this.#bytes > this.#maxBytes || this.#entries.size > this.#maxEntries) {
      let oldest: Entry | undefined;
      for (const entry of this.#entries.values())
        if (!entry.readers && (!oldest || entry.touched < oldest.touched)) oldest = entry;
      // Never revoke resources still displayed by a thumbnail or preview.
      if (!oldest) break;
      this.#remove(oldest);
    }
  }

  #trimAfterRelease(): void {
    if (this.#trimQueued) return;
    this.#trimQueued = true;
    // React replaces an effect's callback by releasing and reacquiring in the
    // same commit. Keep that still-visible reader pinned across the handoff,
    // including when active media temporarily exceeds the warm-cache budget.
    void Promise.resolve().then(() => {
      this.#trimQueued = false;
      this.#trim();
    });
  }

  #start(entry: Entry, load: MessageImageLoader): void {
    this.#cancelTimer(entry);
    const flight: Flight = { abort: new AbortController() };
    entry.flight = flight;
    entry.load = load;
    entry.state = loading;
    this.#notify(entry.key);
    const current = () =>
      this.#entries.get(entry.key) === entry &&
      entry.flight === flight &&
      !flight.abort.signal.aborted;
    void Promise.resolve()
      .then(() => (current() ? load(entry.id, flight.abort.signal) : undefined))
      .then((result) => {
        if (!current() || !result) return;
        const blob = imageBlob(result);
        if (!current()) return;
        const src = URL.createObjectURL(blob);
        if (!current()) {
          URL.revokeObjectURL(src);
          return;
        }
        this.#cancelTimer(entry);
        entry.flight = undefined;
        entry.load = undefined;
        entry.state = Object.freeze({ phase: "ready", src, bytes: blob.size });
        this.#bytes += blob.size;
        entry.touched = ++this.#clock;
        if (!entry.readers) this.#expire(entry);
        this.#trim();
        if (this.#entries.get(entry.key) === entry) this.#notify(entry.key);
      })
      .catch((cause: unknown) => {
        if (!current()) return;
        this.#cancelTimer(entry);
        entry.flight = undefined;
        const nextLoad = entry.load;
        entry.load = undefined;
        if (cause && typeof cause === "object" && "name" in cause && cause.name === "AbortError") {
          // An obsolete controller can fence its own request after another view
          // already joined. Only that new reader's callback may replace it;
          // retrying the same cancelled callback could otherwise loop forever.
          entry.state = idle;
          if (entry.readers && nextLoad && nextLoad !== load) this.#start(entry, nextLoad);
          else {
            this.#remove(entry, false);
            this.#notify(entry.key, "cancelled");
          }
          return;
        }
        entry.state = error;
        if (!entry.readers) this.#expire(entry);
        this.#notify(entry.key);
        this.#trim();
      });
  }
}

export const messageImageCache = new MessageImageCache();
export const clearMessageImageCache = (scope?: string): void => messageImageCache.clear(scope);
