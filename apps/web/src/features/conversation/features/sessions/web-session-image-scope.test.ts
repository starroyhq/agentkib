// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { WebClient, type Access } from "@agentkib/web-client";
import { clearMessageImageCache, messageImageCache, messageImageScope } from "@agentkib/session-ui";
import {
  acceptSessionImageAccess,
  createSessionImageLoader,
  invalidateSessionImages,
  mountSessionImages,
  readSessionImageAccess,
  sessionImageCacheScope,
  setSessionImageIndexEnabled,
} from "../../web-session-images";

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
});
