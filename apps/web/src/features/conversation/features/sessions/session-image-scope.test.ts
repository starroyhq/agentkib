// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { ApiError, WebClient, type Access } from "@agentkib/web-client";
import { clearMessageImageCache, messageImageCache, messageImageScope } from "@agentkib/session-ui";
import {
  acceptSessionImageAccess,
  createSessionImageLoader,
  forgetSessionImages,
  restoreSessionImages,
  invalidateSessionImages,
  mountSessionImages,
  noteSessionImageBoot,
  readSessionImageAccess,
  sessionImageCacheScope,
  sessionImageRevision,
  setSessionImageIndexEnabled,
} from "./session-image-scope";

const access: Access = {
  status: "approved",
  protocolVersion: 2,
  csrfToken: "csrf",
  bootId: "boot",
  historySearchScope: "workspace-grant",
  experimentalEnabled: true,
  device: { id: "device", name: "Browser", send: true, approve: true },
};
const data = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
const create = vi.fn(() => "blob:scoped-image");
const revoke = vi.fn();
const releases = new Set<() => void>();
function track(release: () => void) {
  let active = true;
  const stop = () => {
    if (active) {
      active = false;
      release();
      releases.delete(stop);
    }
  };
  releases.add(stop);
  return stop;
}
function host() {
  const client = new WebClient();
  const read = vi.spyOn(client, "sessionImage").mockResolvedValue(data);
  return { client, read };
}
function enter(client: WebClient, value: Access = access) {
  const stop = track(mountSessionImages(client));
  acceptSessionImageAccess(client, value);
  return stop;
}
async function warm(client: WebClient, sessionId = "session", value: Access = access) {
  const loader = createSessionImageLoader(client, value, sessionId, true, () => true);
  expect(loader.cacheScope).toBeTruthy();
  const scope = messageImageScope(loader);
  const stop = track(messageImageCache.acquire(scope, "image", loader));
  await waitFor(() => expect(messageImageCache.snapshot(scope, "image").phase).toBe("ready"));
  return { scope, loader, stop };
}
beforeEach(() => {
  invalidateSessionImages();
  create.mockClear();
  revoke.mockClear();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    },
  );
});
afterEach(() => {
  for (const stop of [...releases]) stop();
  clearMessageImageCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session image authority scopes", () => {
  it("rejects an unmounted partial client without inspecting its connection or reading media", async () => {
    const inspect = vi.fn(() => {
      throw new Error("Connection is not ready");
    });
    const read = vi.fn().mockResolvedValue(data);
    const client = {
      get connection() {
        return inspect();
      },
      sessionImage: read,
    } as unknown as WebClient;
    expect(sessionImageRevision(undefined as unknown as WebClient)).toBe(-1);
    expect(sessionImageCacheScope(client, access, "session", true)).toBeUndefined();
    const loader = createSessionImageLoader(client, access, "session", true, () => true);
    expect(loader.cacheScope).toBeUndefined();
    await expect(loader("image", new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["foreign", "unverified", "unmounted"] as const)(
    "rejects a %s client before inspecting its unavailable connection",
    async (state) => {
      const current = host();
      const leave = track(mountSessionImages(current.client));
      if (state !== "unverified") acceptSessionImageAccess(current.client, access);
      if (state === "unmounted") leave();
      const target = state === "foreign" ? host() : current;
      const inspect = vi.fn(() => {
        throw new Error("Connection is not ready");
      });
      const connection = Object.getOwnPropertyDescriptor(target.client, "connection")!;
      Object.defineProperty(target.client, "connection", { configurable: true, get: inspect });
      try {
        expect(sessionImageCacheScope(target.client, access, "session", true)).toBeUndefined();
        const loader = createSessionImageLoader(target.client, access, "session", true, () => true);
        expect(loader.cacheScope).toBeUndefined();
        await expect(loader("image", new AbortController().signal)).rejects.toMatchObject({
          name: "AbortError",
        });
        expect(inspect).not.toHaveBeenCalled();
        expect(target.read).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(target.client, "connection", connection);
      }
    },
  );

  it("reuses warm images after leaving only after a fresh approved access read", async () => {
    const first = host();
    const leave = enter(first.client);
    const image = await warm(first.client);
    image.stop();
    leave();
    expect(revoke).not.toHaveBeenCalled();
    const next = host();
    const stop = track(mountSessionImages(next.client));
    expect(sessionImageCacheScope(next.client, access, "session", true)).toBeUndefined();
    acceptSessionImageAccess(next.client, { ...access, csrfToken: "rotated" });
    const resumed = await warm(next.client);
    expect(resumed.scope).toBe(image.scope);
    expect(first.read).toHaveBeenCalledOnce();
    expect(next.read).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    stop();
  });

  it("uses stable identity rather than callback identity, CSRF or a device display name", () => {
    const current = host();
    enter(current.client);
    const first = createSessionImageLoader(current.client, access, "session", true, () => true);
    const next = { ...access, csrfToken: "new", device: { ...access.device!, name: "Renamed" } };
    acceptSessionImageAccess(current.client, next);
    const second = createSessionImageLoader(current.client, next, "session", true, () => false);
    expect(second).not.toBe(first);
    expect(second.cacheScope).toBe(first.cacheScope);
  });

  it("clears the previous controller bytes when fresh access identifies a different account", async () => {
    const first = host();
    const leave = enter(first.client);
    const image = await warm(first.client);
    image.stop();
    leave();
    const next = host();
    track(mountSessionImages(next.client));
    const account: Access = {
      ...access,
      accountLogin: {
        required: true,
        proofVersion: 1,
        deviceId: "computer",
        challenge: "nonce",
        bound: true,
        accountId: "another-account",
      },
    };
    acceptSessionImageAccess(next.client, account);
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
    expect(sessionImageCacheScope(next.client, account, "session", true)).toBeTruthy();
  });

  it.each(["boot", "grant", "workspaces", "account"] as const)(
    "invalidates warm bytes when %s authority changes",
    async (change) => {
      const current = host();
      enter(current.client);
      const image = await warm(current.client);
      const next: Access =
        change === "boot"
          ? { ...access, bootId: "new-boot" }
          : change === "grant"
            ? { ...access, device: { ...access.device!, send: false } }
            : change === "workspaces"
              ? { ...access, historySearchScope: "other-workspaces" }
              : {
                  ...access,
                  accountLogin: {
                    required: true,
                    proofVersion: 1,
                    deviceId: "computer",
                    challenge: "nonce",
                    bound: true,
                    accountId: "account-b",
                  },
                };
      acceptSessionImageAccess(current.client, next);
      expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
      expect(sessionImageCacheScope(current.client, next, "session", true)).not.toBe(
        image.loader.cacheScope,
      );
      expect(revoke).toHaveBeenCalledOnce();
    },
  );

  it("retains cached bytes on blur and ordinary routes, but clears storage changes while away", async () => {
    const current = host();
    const leave = enter(current.client);
    const image = await warm(current.client);
    image.stop();
    leave();
    window.dispatchEvent(new Event("blur"));
    history.replaceState(null, "", "#/sessions/another");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("ready");
    window.dispatchEvent(new StorageEvent("storage", { key: "agentkib.remote.login.v1" }));
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
    history.replaceState(null, "", location.pathname);
  });

  it("clears a legacy computer-switch hash immediately", async () => {
    const current = host();
    enter(current.client);
    const image = await warm(current.client);
    history.replaceState(null, "", "#connect=http%3A%2F%2F192.168.1.2%3A3000");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
    history.replaceState(null, "", location.pathname);
  });

  it("keeps warm bytes for cross-window preferences but clears storage.clear", async () => {
    const current = host();
    enter(current.client);
    const image = await warm(current.client);
    for (const key of [
      "agentkib.send-while-running",
      "agentkib.accent-theme",
      "agentkib.effective-locale",
    ])
      window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("ready");
    expect(current.read).toHaveBeenCalledOnce();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
  });

  it("reads a legacy bound grant freshly without sharing its private proof across mounts", async () => {
    const current = host();
    const legacy: Access = {
      ...access,
      accountLogin: {
        required: true,
        proofVersion: 1,
        deviceId: "computer",
        challenge: "nonce",
        bound: true,
      },
    };
    const leave = enter(current.client, legacy);
    const first = await warm(current.client, "session", legacy);
    first.stop();
    leave();
    expect(messageImageCache.snapshot(first.scope, "image").phase).toBe("idle");
    track(mountSessionImages(current.client));
    expect(sessionImageCacheScope(current.client, legacy, "session", true)).toBeUndefined();
    acceptSessionImageAccess(current.client, legacy);
    const second = await warm(current.client, "session", legacy);
    expect(second.scope).not.toBe(first.scope);
    expect(current.read).toHaveBeenCalledTimes(2);
  });

  it("blocks reuse for non-approved or unbound identities and disabled indexes", () => {
    const current = host();
    enter(current.client);
    for (const value of [
      { ...access, status: "pending" as const },
      {
        ...access,
        accountLogin: {
          required: true as const,
          proofVersion: 1 as const,
          deviceId: "computer",
          challenge: "nonce",
          bound: false,
        },
      },
    ]) {
      acceptSessionImageAccess(current.client, value);
      expect(sessionImageCacheScope(current.client, value, "session", true)).toBeUndefined();
    }
    acceptSessionImageAccess(current.client, access);
    setSessionImageIndexEnabled(current.client, false);
    setSessionImageIndexEnabled(current.client, true);
    expect(sessionImageCacheScope(current.client, access, "session", true)).toBeUndefined();
    acceptSessionImageAccess(current.client, access);
    expect(sessionImageCacheScope(current.client, access, "session", true)).toBeTruthy();
  });

  it.each([401, 403])(
    "invalidates all cached sessions for a current image %s rejection",
    async (status) => {
      const current = host();
      enter(current.client);
      const image = await warm(current.client);
      const loader = createSessionImageLoader(current.client, access, "second", true, () => true);
      current.read.mockRejectedValueOnce(new ApiError(status, "forbidden"));
      await expect(loader("other-image", new AbortController().signal)).rejects.toMatchObject({
        status,
      });
      expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
      setSessionImageIndexEnabled(current.client, true);
      expect(sessionImageCacheScope(current.client, access, "session", true)).toBeUndefined();
    },
  );

  it("forgets only a confirmed deleted session and refuses its late image result", async () => {
    const current = host();
    enter(current.client);
    const first = await warm(current.client, "one");
    const second = await warm(current.client, "two");
    let finish!: (value: typeof data) => void;
    current.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = first.loader("late", new AbortController().signal);
    forgetSessionImages(current.client, "one");
    finish(data);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(messageImageCache.snapshot(first.scope, "image").phase).toBe("idle");
    expect(messageImageCache.snapshot(second.scope, "image").phase).toBe("ready");
  });

  it("restores trusted readability with a new session generation and fences late success or denial", async () => {
    const current = host();
    enter(current.client);
    const first = await warm(current.client);
    let success!: (value: typeof data) => void, failure!: (error: Error) => void;
    current.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            success = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            failure = reject;
          }),
      );
    const oldSuccess = first.loader("late-success", new AbortController().signal);
    const oldFailure = first.loader("late-failure", new AbortController().signal);
    forgetSessionImages(current.client, "session");
    expect(sessionImageCacheScope(current.client, access, "session", true)).toBeUndefined();
    restoreSessionImages(current.client, "session");
    const next = await warm(current.client);
    expect(next.scope).not.toBe(first.scope);
    success(data);
    failure(new ApiError(403, "forbidden"));
    await expect(oldSuccess).rejects.toMatchObject({ name: "AbortError" });
    await expect(oldFailure).rejects.toMatchObject({ name: "AbortError" });
    expect(messageImageCache.snapshot(next.scope, "image").phase).toBe("ready");
  });

  it("does not cancel another session image while a different row is withdrawn and restored", async () => {
    const current = host();
    enter(current.client);
    const other = await warm(current.client, "other");
    let finish!: (value: typeof data) => void;
    current.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const active = createSessionImageLoader(current.client, access, "active", true, () => true);
    const pending = active("pending", new AbortController().signal);
    forgetSessionImages(current.client, "other");
    restoreSessionImages(current.client, "other");
    finish(data);
    await expect(pending).resolves.toEqual(data);
    expect(sessionImageCacheScope(current.client, access, "active", true)).toBe(active.cacheScope);
    expect(messageImageCache.snapshot(other.scope, "image").phase).toBe("idle");
  });

  it("evicts bounded session metadata together with bytes and never resurrects the retired scope", async () => {
    const current = host();
    enter(current.client);
    const first = await warm(current.client);
    first.stop();
    for (let index = 0; index < 260; index++)
      createSessionImageLoader(current.client, access, `session-${index}`, true, () => true);
    expect(messageImageCache.snapshot(first.scope, "image").phase).toBe("idle");
    await expect(first.loader("late", new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    const next = await warm(current.client);
    expect(next.scope).not.toBe(first.scope);
    expect(current.read).toHaveBeenCalledTimes(2);
  });

  it("turns late success and failure into cancellation after the old controller leaves", async () => {
    const current = host();
    const leave = enter(current.client);
    let finish!: (value: typeof data) => void;
    let fail!: (error: Error) => void;
    current.read
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      );
    const loader = createSessionImageLoader(current.client, access, "session", true, () => true);
    const success = loader("success", new AbortController().signal);
    const failure = loader("failure", new AbortController().signal);
    leave();
    enter(current.client);
    finish(data);
    fail(new Error("old network failure"));
    await expect(success).rejects.toMatchObject({ name: "AbortError" });
    await expect(failure).rejects.toMatchObject({ name: "AbortError" });
  });

  it("does not let an old authorization failure erase the next controller cache", async () => {
    const old = host();
    const leave = enter(old.client);
    let fail!: (error: Error) => void;
    old.read.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    const loader = createSessionImageLoader(old.client, access, "session", true, () => true);
    const pending = loader("late", new AbortController().signal);
    leave();
    const next = host();
    enter(next.client);
    const image = await warm(next.client);
    fail(new ApiError(403, "forbidden"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("ready");
  });

  it("does a current LAN access read after a boundary instead of trusting a shared old flight", async () => {
    const client = new WebClient(undefined, {
      type: "lan-http",
      origin: "http://192.168.1.2:3000",
    });
    const leave = enter(client);
    leave();
    track(mountSessionImages(client));
    let finish!: (value: Access) => void;
    const ended: Access = { ...access, status: "ended", device: undefined };
    const read = vi
      .spyOn(client, "access")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(ended);
    const pending = readSessionImageAccess(client);
    finish(access);
    await expect(pending).resolves.toEqual(ended);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("clears warm bytes on a known runtime boot transition", async () => {
    const current = host();
    enter(current.client);
    noteSessionImageBoot(current.client, "runtime-one");
    const image = await warm(current.client);
    noteSessionImageBoot(current.client, "runtime-two");
    expect(messageImageCache.snapshot(image.scope, "image").phase).toBe("idle");
  });
});
