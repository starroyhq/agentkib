// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MessageImageCache,
  clearMessageImageCache,
  messageImageCache,
  messageImageScope,
  type MessageImageCacheOptions,
  type MessageImageLoader,
} from "@agentkib/session-ui";

const data = (bytes = 3) => ({
  mimeType: "image/png",
  base64: Buffer.alloc(bytes, 1).toString("base64"),
});
const caches: MessageImageCache[] = [];
const create = vi.fn<(blob: Blob) => string>();
const revoke = vi.fn<(src: string) => void>();
function cache(options: MessageImageCacheOptions = {}) {
  const value = new MessageImageCache(options);
  caches.push(value);
  return value;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function settle() {
  for (let step = 0; step < 8; step++) await Promise.resolve();
}
async function ready(value: MessageImageCache, scope: string, id: string, bytes = 3) {
  const load = vi.fn().mockResolvedValue(data(bytes));
  const release = value.acquire(scope, id, load);
  await settle();
  expect(value.snapshot(scope, id).phase).toBe("ready");
  return { release, load, state: value.snapshot(scope, id) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-11-04T01:00:00Z");
  create.mockReset().mockImplementation(() => `blob:cached-${create.mock.calls.length}`);
  revoke.mockReset();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
});
afterEach(() => {
  for (const value of caches.splice(0)) value.clear();
  clearMessageImageCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("message image scope and stable snapshots", () => {
  it("uses the explicit identity across recreated callbacks and isolates legacy loaders", () => {
    const first = Object.assign(vi.fn().mockResolvedValue(data()), {
      cacheScope: "same-approved-reader",
    });
    const second = Object.assign(vi.fn().mockResolvedValue(data()), {
      cacheScope: "same-approved-reader",
    });
    expect(messageImageScope(first)).toBe("same-approved-reader");
    expect(messageImageScope(second)).toBe(messageImageScope(first));
    const legacy: MessageImageLoader = vi.fn().mockResolvedValue(data());
    const other: MessageImageLoader = vi.fn().mockResolvedValue(data());
    expect(messageImageScope(legacy)).toBe(messageImageScope(legacy));
    expect(messageImageScope(legacy)).not.toBe(messageImageScope(other));
  });

  it("keeps snapshot identities stable until a real load or eviction changes them", async () => {
    const value = cache();
    expect(value.snapshot("scope", "image")).toBe(value.snapshot("scope", "image"));
    const load = vi.fn().mockResolvedValue(data());
    const states: string[] = [];
    const stop = value.subscribe("scope", "image", () =>
      states.push(value.snapshot("scope", "image").phase),
    );
    const release = value.acquire("scope", "image", load);
    const loading = value.snapshot("scope", "image");
    expect(loading.phase).toBe("loading");
    expect(value.snapshot("scope", "image")).toBe(loading);
    await settle();
    const loaded = value.snapshot("scope", "image");
    expect(loaded).toEqual({ phase: "ready", src: "blob:cached-1", bytes: 3 });
    expect(value.snapshot("scope", "image")).toBe(loaded);
    release();
    expect(value.snapshot("scope", "image")).toBe(loaded);
    value.clear("scope");
    expect(states).toEqual(["loading", "ready", "idle"]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-1");
    stop();
    value.clear();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("allows the public singleton to be cleared with the raw explicit scope", async () => {
    const load = Object.assign(vi.fn().mockResolvedValue(data()), { cacheScope: "explicit-scope" });
    const scope = messageImageScope(load);
    const release = messageImageCache.acquire(scope, "image", load);
    await settle();
    clearMessageImageCache("explicit-scope");
    expect(messageImageCache.snapshot(scope, "image").phase).toBe("idle");
    expect(revoke).toHaveBeenCalledOnce();
    release();
  });

  it("reports explicit withdrawal after removing ready and pending resources, without notifying unrelated scopes", async () => {
    const value = cache();
    const loaded = await ready(value, "scope", "ready");
    const result = deferred<ReturnType<typeof data>>();
    const releasePending = value.acquire("scope", "pending", () => result.promise);
    const other = await ready(value, "other", "ready");
    const readyUpdates = vi.fn((event?: string) => ({
      event,
      phase: value.snapshot("scope", "ready").phase,
    }));
    const pendingUpdates = vi.fn((event?: string) => ({
      event,
      phase: value.snapshot("scope", "pending").phase,
    }));
    const otherUpdates = vi.fn();
    value.subscribe("scope", "ready", readyUpdates);
    value.subscribe("scope", "pending", pendingUpdates);
    value.subscribe("other", "ready", otherUpdates);
    value.clear("scope");
    expect(readyUpdates).toHaveReturnedWith({ event: "withdrawn", phase: "idle" });
    expect(pendingUpdates).toHaveReturnedWith({ event: "withdrawn", phase: "idle" });
    expect(otherUpdates).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-1");
    value.clear("scope");
    result.resolve(data());
    await settle();
    expect(readyUpdates).toHaveBeenCalledOnce();
    expect(pendingUpdates).toHaveBeenCalledOnce();
    expect(value.snapshot("other", "ready").phase).toBe("ready");
    expect(create).toHaveBeenCalledTimes(2);
    loaded.release();
    releasePending();
    other.release();
  });
});

describe("shared image loads and pinned readers", () => {
  it("does not invoke a queued loader after its identity has been cleared", async () => {
    const value = cache();
    const load = vi.fn().mockResolvedValue(data());
    const release = value.acquire("scope", "image", load);
    value.clear("scope");
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(value.snapshot("scope", "image").phase).toBe("idle");
    release();
  });

  it("merges concurrent loads and cannot cancel a preview when another reader leaves", async () => {
    const value = cache({ pendingAbortDelayMs: 50 });
    const result = deferred<ReturnType<typeof data>>();
    const load = vi.fn<MessageImageLoader>(() => result.promise);
    const other = vi.fn().mockResolvedValue(data(4));
    const first = value.acquire("scope", "image", load);
    const preview = value.acquire("scope", "image", other);
    await settle();
    expect(load).toHaveBeenCalledOnce();
    expect(other).not.toHaveBeenCalled();
    first();
    first();
    vi.advanceTimersByTime(1_000);
    expect((load.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
    result.resolve(data());
    await settle();
    expect(create).toHaveBeenCalledOnce();
    preview();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("reuses the same pending request when the viewport returns during its abort grace period", async () => {
    const value = cache({ pendingAbortDelayMs: 100 });
    const result = deferred<ReturnType<typeof data>>();
    const load = vi.fn<MessageImageLoader>(() => result.promise);
    const first = value.acquire("scope", "image", load);
    await settle();
    first();
    vi.advanceTimersByTime(99);
    const second = value.acquire("scope", "image", vi.fn().mockResolvedValue(data(4)));
    vi.advanceTimersByTime(200);
    expect((load.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
    result.resolve(data());
    await settle();
    expect(load).toHaveBeenCalledOnce();
    expect(value.snapshot("scope", "image")).toMatchObject({ phase: "ready", bytes: 3 });
    second();
  });

  it("aborts abandoned pending work and ignores its late result without creating a URL", async () => {
    const value = cache({ pendingAbortDelayMs: 100 });
    const result = deferred<ReturnType<typeof data>>();
    const load = vi.fn<MessageImageLoader>(() => result.promise);
    const release = value.acquire("scope", "image", load);
    const updates = vi.fn();
    value.subscribe("scope", "image", updates);
    await settle();
    release();
    vi.advanceTimersByTime(100);
    expect((load.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    expect(value.snapshot("scope", "image").phase).toBe("idle");
    expect(updates).toHaveBeenCalledExactlyOnceWith(undefined);
    result.resolve(data());
    await settle();
    expect(create).not.toHaveBeenCalled();
  });

  it("does not let pre-clear work or its old release overwrite and unpin a newer load", async () => {
    const value = cache({ idleTtlMs: 20, pendingAbortDelayMs: 10 });
    const old = deferred<ReturnType<typeof data>>();
    const current = deferred<ReturnType<typeof data>>();
    const previousLoad = vi.fn<MessageImageLoader>(() => old.promise);
    const nextLoad = vi.fn<MessageImageLoader>(() => current.promise);
    const releaseOld = value.acquire("scope", "image", previousLoad);
    await settle();
    value.clear("scope");
    const releaseNew = value.acquire("scope", "image", nextLoad);
    await settle();
    releaseOld();
    vi.advanceTimersByTime(100);
    expect((nextLoad.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
    old.resolve(data());
    await settle();
    expect(create).not.toHaveBeenCalled();
    current.resolve(data(4));
    await settle();
    expect(value.snapshot("scope", "image")).toMatchObject({ phase: "ready", bytes: 4 });
    vi.advanceTimersByTime(100);
    expect(value.snapshot("scope", "image").phase).toBe("ready");
    releaseNew();
  });

  it("does not cache a navigation AbortError or retry the same fenced callback automatically", async () => {
    const value = cache();
    const load = vi.fn().mockRejectedValue(new DOMException("Navigation changed", "AbortError"));
    const updates = vi.fn((event?: string) => ({
      event,
      phase: value.snapshot("scope", "image").phase,
    }));
    value.subscribe("scope", "image", updates);
    const release = value.acquire("scope", "image", load);
    await settle();
    expect(value.snapshot("scope", "image").phase).toBe("idle");
    expect(load).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_000);
    await settle();
    expect(load).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(updates.mock.results.map((result) => result.value)).toEqual([
      { event: undefined, phase: "loading" },
      { event: "cancelled", phase: "idle" },
    ]);
    const current = await ready(value, "scope", "image");
    release();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(value.snapshot("scope", "image")).toBe(current.state);
    current.release();
  });

  it("hands a cancelled controller's shared flight to the new view's callback", async () => {
    const value = cache();
    const old = deferred<ReturnType<typeof data>>();
    const previous = vi.fn<MessageImageLoader>(() => old.promise);
    const current = vi.fn().mockResolvedValue(data(4));
    const updates = vi.fn();
    value.subscribe("scope", "image", updates);
    const releasePrevious = value.acquire("scope", "image", previous);
    await settle();
    const releaseCurrent = value.acquire("scope", "image", current);
    releasePrevious();
    old.reject(new DOMException("Obsolete controller", "AbortError"));
    await settle();
    expect(previous).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledOnce();
    expect(value.snapshot("scope", "image")).toMatchObject({ phase: "ready", bytes: 4 });
    expect(create).toHaveBeenCalledOnce();
    expect(updates.mock.calls.every(([event]) => event === undefined)).toBe(true);
    releaseCurrent();
  });

  it("removes an idle navigation-cancelled entry so a later view can read it normally", async () => {
    const value = cache();
    const old = deferred<ReturnType<typeof data>>();
    const previous = vi.fn<MessageImageLoader>(() => old.promise);
    const release = value.acquire("scope", "image", previous);
    await settle();
    release();
    old.reject(new DOMException("Obsolete controller", "AbortError"));
    await settle();
    expect(value.snapshot("scope", "image").phase).toBe("idle");
    const current = await ready(value, "scope", "image");
    expect(current.state.phase).toBe("ready");
    current.release();
  });
});

describe("warm LRU, idle expiry and resource withdrawal", () => {
  it("keeps ready media warm for five idle minutes and synchronously notifies subscribers on expiry", async () => {
    const value = cache();
    const loaded = await ready(value, "scope", "image");
    const phases: string[] = [];
    value.subscribe("scope", "image", (event) => {
      expect(event).toBeUndefined();
      phases.push(value.snapshot("scope", "image").phase);
    });
    loaded.release();
    vi.advanceTimersByTime(5 * 60 * 1_000 - 1);
    expect(value.snapshot("scope", "image")).toBe(loaded.state);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(["idle"]);
    expect(revoke).toHaveBeenCalledOnce();
    expect(value.snapshot("scope", "image").phase).toBe("idle");
  });

  it("updates recency on reacquire and evicts the least recently used idle entry", async () => {
    const value = cache({ maxEntries: 2 });
    (await ready(value, "scope", "a")).release();
    (await ready(value, "scope", "b")).release();
    value.acquire("scope", "a", vi.fn())();
    const phases: string[] = [];
    value.subscribe("scope", "b", (event) => {
      expect(event).toBeUndefined();
      phases.push(value.snapshot("scope", "b").phase);
    });
    const current = await ready(value, "scope", "c");
    expect(value.snapshot("scope", "a").phase).toBe("ready");
    expect(value.snapshot("scope", "b").phase).toBe("idle");
    expect(phases).toEqual(["idle"]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-2");
    current.release();
  });

  it("accounts for Blob bytes and evicts idle resources before the warm budget is exceeded", async () => {
    const value = cache({ maxBytes: 4 });
    (await ready(value, "scope", "a", 3)).release();
    const second = await ready(value, "scope", "b", 3);
    expect(value.snapshot("scope", "a").phase).toBe("idle");
    expect(value.snapshot("scope", "b").phase).toBe("ready");
    expect(create.mock.calls[1]![0]).toBeInstanceOf(Blob);
    expect(create.mock.calls[1]![0].size).toBe(3);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-1");
    second.release();
  });

  it("temporarily exceeds the warm budget for pinned resources and restores it after release", async () => {
    const value = cache({ maxBytes: 1, maxEntries: 1 });
    const first = await ready(value, "scope", "a");
    const second = await ready(value, "scope", "b");
    expect(revoke).not.toHaveBeenCalled();
    first.release();
    await settle();
    expect(value.snapshot("scope", "a").phase).toBe("idle");
    expect(value.snapshot("scope", "b").phase).toBe("ready");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-1");
    second.release();
    await settle();
    expect(revoke).toHaveBeenCalledTimes(2);
    value.clear();
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("does not revoke a still-visible over-budget image during a same-commit callback handoff", async () => {
    const value = cache({ maxBytes: 1, maxEntries: 1 });
    const previous = await ready(value, "scope", "image", 3);
    const replacement = vi.fn().mockResolvedValue(data(4));
    previous.release();
    const release = value.acquire("scope", "image", replacement);
    await settle();
    expect(value.snapshot("scope", "image")).toBe(previous.state);
    expect(replacement).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    release();
    await settle();
    expect(value.snapshot("scope", "image").phase).toBe("idle");
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("isolates matching image IDs between identities and clears unpinned ready subscribers immediately", async () => {
    const value = cache();
    (await ready(value, "identity-a", "image")).release();
    const second = await ready(value, "identity-b", "image");
    const updates = vi.fn();
    value.subscribe("identity-a", "image", () => updates(value.snapshot("identity-a", "image")));
    value.clear("identity-a");
    expect(updates).toHaveBeenCalledExactlyOnceWith({ phase: "idle" });
    expect(value.snapshot("identity-b", "image").phase).toBe("ready");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-1");
    second.release();
  });
});

describe("failure and media validation", () => {
  it("does not retry an error on viewport reacquisition, but an explicit retry can recover", async () => {
    const value = cache();
    const load = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(data());
    const first = value.acquire("scope", "image", load);
    await settle();
    expect(value.snapshot("scope", "image").phase).toBe("error");
    first();
    const second = value.acquire("scope", "image", load);
    await settle();
    expect(load).toHaveBeenCalledOnce();
    value.retry("scope", "image", load);
    value.retry("scope", "image", load);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(value.snapshot("scope", "image").phase).toBe("ready");
    second();
  });

  it("withdraws a decode failure as an error and revokes its pinned URL exactly once", async () => {
    const value = cache();
    const first = await ready(value, "scope", "image");
    const second = value.acquire("scope", "image", first.load);
    const phases: string[] = [];
    value.subscribe("scope", "image", () => phases.push(value.snapshot("scope", "image").phase));
    value.invalidate("scope", "image");
    expect(phases).toEqual(["error"]);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:cached-1");
    first.release();
    second();
    value.clear();
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("cancels an invalidated pending request and prevents its late body from becoming ready", async () => {
    const value = cache();
    const result = deferred<ReturnType<typeof data>>();
    const load = vi.fn<MessageImageLoader>(() => result.promise);
    const release = value.acquire("scope", "image", load);
    await settle();
    value.invalidate("scope", "image");
    result.resolve(data());
    await settle();
    expect((load.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
    expect(value.snapshot("scope", "image").phase).toBe("error");
    expect(create).not.toHaveBeenCalled();
    release();
  });

  it.each([
    { mimeType: "image/svg+xml", base64: "PHN2Zz4=" },
    { mimeType: "text/html", base64: "PGh0bWw+" },
    { mimeType: "image/png", base64: "" },
    { mimeType: "image/png", base64: "not base64" },
    { mimeType: "image/png", base64: "data:image/png;base64,YQ==" },
    { mimeType: "image/png", base64: "a" },
  ])(
    "rejects invalid content without creating an ObjectURL ($mimeType, $base64)",
    async (invalid) => {
      const value = cache();
      const release = value.acquire("scope", "image", vi.fn().mockResolvedValue(invalid));
      await settle();
      expect(value.snapshot("scope", "image").phase).toBe("error");
      expect(create).not.toHaveBeenCalled();
      release();
    },
  );

  it("accepts the 8 MiB decoded limit and rejects the next byte", async () => {
    const value = cache();
    const accepted = await ready(value, "scope", "limit", 8 * 1024 * 1024);
    expect(accepted.state).toMatchObject({ phase: "ready", bytes: 8 * 1024 * 1024 });
    const rejected = value.acquire(
      "scope",
      "over",
      vi.fn().mockResolvedValue(data(8 * 1024 * 1024 + 1)),
    );
    await settle();
    expect(value.snapshot("scope", "over").phase).toBe("error");
    expect(create).toHaveBeenCalledOnce();
    accepted.release();
    rejected();
  });
});
