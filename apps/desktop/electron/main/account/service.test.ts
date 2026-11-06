// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DesktopAccountService } from "./service";

const storageFailure = vi.hoisted(() => ({ blockedDelete: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]) === storageFailure.blockedDelete) {
        throw Object.assign(new Error("Synthetic credential deletion failure"), { code: "EACCES" });
      }
      return actual.rm(...args);
    },
  };
});

const profile = {
  id: "account-a",
  username: "alice",
  status: "active",
  deviceLimit: 3,
  deviceCount: 1,
  totpEnabled: false,
};
const tokens = {
  accessToken: "a".repeat(43),
  refreshToken: "r".repeat(43),
  expiresIn: 600,
  refreshRecovery: true,
  account: profile,
};
let directory: string;
let service: DesktopAccountService;
let opened: string;
let network: ReturnType<typeof vi.fn>;
let pause: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
let identity:
  | {
      deviceId: string;
      credential: string;
      accountId?: string;
      accountClaimPending?: boolean;
      accountClaimAccountId?: string;
    }
  | undefined;
let available: boolean;
let computer: (() => Promise<string | undefined>) | undefined;
async function setup() {
  service = new DesktopAccountService({
    directory,
    storage: {
      available: () => available,
      encrypt: (value) => Buffer.from(Buffer.from(value).map((byte) => byte ^ 0x55)),
      decrypt: (value) => Buffer.from(value.map((byte) => byte ^ 0x55)).toString(),
    },
    openExternal: async (url) => {
      opened = url;
    },
    pauseRemote: pause,
    identity: async () => identity,
    prepareIdentityClaim: async (id) => {
      identity!.accountClaimPending = true;
      identity!.accountClaimAccountId = id;
    },
    bindIdentity: async (id) => {
      identity!.accountId = id;
      delete identity!.accountClaimPending;
      delete identity!.accountClaimAccountId;
    },
    ...(computer ? { computerName: computer } : {}),
    fetch: network as typeof fetch,
  });
  await service.initialize();
}
async function callback(state?: string) {
  const params = new URLSearchParams(new URL(opened).hash.split("?")[1]);
  const url = new URL(params.get("redirectUri")!);
  url.searchParams.set("state", state ?? params.get("state")!);
  url.searchParams.set("code", "c".repeat(43));
  const result = await fetch(url);
  await vi.waitFor(async () => expect((await service.status()).phase).not.toBe("signing-in"));
  return result;
}
beforeEach(async () => {
  storageFailure.blockedDelete = "";
  directory = await mkdtemp(join(tmpdir(), "agentkib-account-"));
  opened = "";
  available = true;
  identity = undefined;
  computer = undefined;
  network = vi.fn<typeof fetch>(async () => Response.json(tokens));
  pause = vi.fn(async () => undefined);
  await setup();
});
afterEach(async () => {
  storageFailure.blockedDelete = "";
  service.shutdown();
  await rm(directory, { recursive: true, force: true });
});

describe("desktop account boundary", () => {
  it("reads configured account relay usage without changing the private computer quota", async () => {
    const usage = {
      periodStart: 1,
      periodEnd: 100,
      limitBytes: 100_000_000_000,
      usedBytes: 0,
      remainingBytes: 100_000_000_000,
      exhausted: false,
      updatedAt: 10,
    };
    network.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname === "/v1/account/relay-usage"
          ? usage
          : url.pathname === "/v1/account"
            ? profile
            : tokens,
      ),
    );
    await service.request({ operation: "login" });
    await callback();
    await vi.waitFor(async () => expect((await service.status()).relayUsage).toEqual(usage));
    expect((await service.status()).account?.deviceLimit).toBe(3);
    expect(JSON.stringify((await service.status()).relayUsage)).not.toContain(tokens.accessToken);
  });
  it("does not let a pre-logout usage response overwrite a newer login", async () => {
    let finishOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      finishOld = resolve;
    });
    const fresh = {
      periodStart: 1,
      periodEnd: 100,
      limitBytes: 5_000_000_000,
      usedBytes: 1,
      remainingBytes: 4_999_999_999,
      exhausted: false,
      updatedAt: 10,
    };
    let reads = 0;
    network.mockImplementation(async (url: URL) =>
      url.pathname === "/v1/account/relay-usage"
        ? ++reads === 1
          ? old
          : Response.json(fresh)
        : Response.json(url.pathname === "/v1/account" ? profile : tokens),
    );
    await service.request({ operation: "login" });
    await callback();
    await vi.waitFor(() => expect(reads).toBe(1));
    await service.request({ operation: "logout" });
    await service.request({ operation: "login" });
    await callback();
    await vi.waitFor(async () => expect((await service.status()).relayUsage).toEqual(fresh));
    finishOld(
      Response.json({ ...fresh, limitBytes: 100_000_000_000, remainingBytes: 99_999_999_999 }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.status()).relayUsage).toEqual(fresh);
  });
  it("hides unsupported usage and reports failed reads without inventing an allowance", async () => {
    network.mockImplementation(async (url: URL) =>
      url.pathname === "/v1/account/relay-usage"
        ? Response.json({}, { status: 404 })
        : Response.json(url.pathname === "/v1/account" ? profile : tokens),
    );
    await service.request({ operation: "login" });
    await callback();
    await vi.waitFor(() =>
      expect(
        network.mock.calls.some(([url]) => (url as URL).pathname === "/v1/account/relay-usage"),
      ).toBe(true),
    );
    expect((await service.status()).relayUsage).toBeUndefined();
    expect((await service.status()).relayUsageUnavailable).toBeUndefined();
    network.mockImplementation(async (url: URL) =>
      url.pathname === "/v1/account/relay-usage"
        ? Response.json({}, { status: 503 })
        : Response.json(url.pathname === "/v1/account" ? profile : tokens),
    );
    (service as unknown as { usageReadAt: number }).usageReadAt = 0;
    const status = await service.request({ operation: "status" });
    expect(status.relayUsageUnavailable).toBe(true);
    expect(status.relayUsage).toBeUndefined();
    expect(status.phase).toBe("signed-in");
  });
  it("uses a real loopback PKCE callback and only publishes safe profile data", async () => {
    expect((await service.request({ operation: "login" })).phase).toBe("signing-in");
    const params = new URLSearchParams(new URL(opened).hash.split("?")[1]);
    expect(new URL(opened).origin).toBe("https://account.agentkib.com");
    expect((await callback()).status).toBe(200);
    const [endpoint, request] = network.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(request.body as string);
    expect(endpoint.pathname).toBe("/v1/auth/token");
    expect(createHash("sha256").update(body.codeVerifier).digest("base64url")).toBe(
      params.get("codeChallenge"),
    );
    expect(body.grantType).toBe("authorization_code");
    const state = await service.status();
    expect(state.account).toEqual(profile);
    expect(JSON.stringify(state)).not.toContain(tokens.accessToken);
    expect(JSON.stringify(state)).not.toContain(tokens.refreshToken);
    expect((await readFile(join(directory, "refresh.enc"))).toString()).not.toContain(
      tokens.refreshToken,
    );
  });
  it("rejects wrong state and allows cancel without redeeming a code", async () => {
    await service.request({ operation: "login" });
    const params = new URLSearchParams(new URL(opened).hash.split("?")[1]);
    const url = new URL(params.get("redirectUri")!);
    url.searchParams.set("state", "wrong");
    url.searchParams.set("code", "c".repeat(43));
    expect((await fetch(url)).status).toBe(400);
    await service.request({ operation: "cancel-login" });
    expect(network).not.toHaveBeenCalled();
    expect((await service.status()).phase).toBe("signed-out");
  });
  it("does not open browser or persist plaintext without secure storage", async () => {
    available = false;
    expect((await service.request({ operation: "login" })).error).toBe(
      "account_secure_storage_unavailable",
    );
    expect(opened).toBe("");
    await expect(readFile(join(directory, "refresh.enc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("retains a legacy uncertain session without replaying its refresh token", async () => {
    network.mockImplementation(async () => Response.json({ ...tokens, refreshRecovery: false }));
    await service.request({ operation: "login" });
    await callback();
    service.shutdown();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    try {
      network.mockClear();
      network.mockRejectedValue(new Error("connection reset"));
      await setup();
      expect(network).toHaveBeenCalledTimes(1);
      expect((await service.status()).phase).toBe("error");
      expect((await service.status()).account).toEqual(profile);
      expect(service.signedIn).toBe(false);
      service.shutdown();
      await setup();
      expect(network).toHaveBeenCalledTimes(1);
      expect((await service.status()).account).toEqual(profile);
      expect((await service.request({ operation: "login" })).phase).toBe("signing-in");
    } finally {
      clock.mockRestore();
    }
  });
  it("restores valid encrypted access without rotating on every restart", async () => {
    await service.request({ operation: "login" });
    await callback();
    service.shutdown();
    network.mockClear();
    network.mockRejectedValue(new Error("offline"));
    await setup();
    expect(await service.accessToken()).toBe(tokens.accessToken);
    expect((await service.status()).account).toEqual(profile);
    expect(network).not.toHaveBeenCalled();
  });
  it("recovers a lost refresh response after restart with the same durable request ID", async () => {
    await service.request({ operation: "login" });
    await callback();
    service.shutdown();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    const requests: Record<string, string>[] = [];
    let lose = true;
    network.mockImplementation(async (url: URL, init: RequestInit) => {
      if (url.pathname !== "/v1/auth/token") return Response.json({});
      requests.push(JSON.parse(init.body as string));
      if (lose) throw new Error("response lost");
      return Response.json({
        ...tokens,
        accessToken: "b".repeat(43),
        refreshToken: "s".repeat(43),
      });
    });
    try {
      await setup();
      expect((await service.status()).phase).toBe("error");
      expect((await service.status()).account).toEqual(profile);
      expect(requests).toHaveLength(1);
      expect(requests[0].refreshRequestId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      service.shutdown();
      lose = false;
      await setup();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(await service.accessToken()).toBe("b".repeat(43));
      expect((await service.status()).phase).toBe("signed-in");
      expect(JSON.stringify(await service.status())).not.toContain(requests[0].refreshRequestId);
    } finally {
      clock.mockRestore();
    }
  });
  it("migrates a previous encrypted refresh token without a new storage dependency", async () => {
    await writeFile(
      join(directory, "refresh.enc"),
      Buffer.from(Buffer.from(tokens.refreshToken).map((byte) => byte ^ 0x55)),
    );
    network.mockClear();
    await setup();
    expect(await service.accessToken()).toBe(tokens.accessToken);
    const stored = JSON.parse(
      Buffer.from(
        (await readFile(join(directory, "refresh.enc"))).map((byte) => byte ^ 0x55),
      ).toString(),
    );
    expect(stored.version).toBe(1);
    expect(stored.refreshRecovery).toBe(true);
    expect(stored.pending).toBeUndefined();
  });
  it("retains the recoverable journal if saving a successful rotation fails", async () => {
    await service.request({ operation: "login" });
    await callback();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    const requests: Record<string, string>[] = [];
    let failSave = true;
    network.mockImplementation(async (url: URL, init: RequestInit) => {
      if (url.pathname !== "/v1/auth/token") return Response.json({});
      requests.push(JSON.parse(init.body as string));
      if (failSave) await mkdir(join(directory, "refresh.enc.tmp"));
      return Response.json({
        ...tokens,
        accessToken: "b".repeat(43),
        refreshToken: "s".repeat(43),
      });
    });
    try {
      await expect(service.accessToken()).rejects.toBeDefined();
      expect((await service.status()).account).toEqual(profile);
      await rm(join(directory, "refresh.enc.tmp"), { recursive: true });
      failSave = false;
      expect(await service.accessToken()).toBe("b".repeat(43));
      expect(requests[1]).toEqual(requests[0]);
    } finally {
      clock.mockRestore();
    }
  });
  it("waits for an in-flight rotation before retrying an old access 401 read", async () => {
    await service.request({ operation: "login" });
    await callback();
    let rejectOld!: (value: Response) => void;
    let rotate!: (value: Response) => void;
    let reads = 0,
      rotations = 0;
    network.mockImplementation(async (url: URL) => {
      if (url.pathname === "/v1/account/sessions") {
        if (++reads === 1)
          return new Promise<Response>((resolve) => {
            rejectOld = resolve;
          });
        return Response.json({ sessions: [{ id: "phone", kind: "mobile" }] });
      }
      if (url.pathname === "/v1/auth/token") {
        rotations++;
        return new Promise<Response>((resolve) => {
          rotate = resolve;
        });
      }
      return Response.json({});
    });
    const oldRead = service.liveSessions();
    await vi.waitFor(() => expect(rejectOld).toBeDefined());
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    try {
      const refresh = service.accessToken();
      await vi.waitFor(() => expect(rotate).toBeDefined());
      rejectOld(Response.json({ error: "authentication_required" }, { status: 401 }));
      rotate(
        Response.json({ ...tokens, accessToken: "b".repeat(43), refreshToken: "s".repeat(43) }),
      );
      expect(await refresh).toBe("b".repeat(43));
      expect((await oldRead).accountId).toBe(profile.id);
      expect(rotations).toBe(1);
      expect(reads).toBe(2);
      expect((await service.status()).phase).toBe("signed-in");
    } finally {
      clock.mockRestore();
    }
  });
  it("does not replay a rejected mutation after recovering authentication", async () => {
    await service.request({ operation: "login" });
    await callback();
    let registrations = 0,
      rotations = 0;
    network.mockImplementation(async (url: URL) => {
      if (url.pathname === "/v1/account/devices") {
        registrations++;
        return Response.json({ error: "authentication_required" }, { status: 401 });
      }
      if (url.pathname === "/v1/auth/token") {
        rotations++;
        return Response.json({
          ...tokens,
          accessToken: "b".repeat(43),
          refreshToken: "s".repeat(43),
        });
      }
      return Response.json({});
    });
    await expect(
      service.registerDevice({ registrationId: "test", credential: "private" }),
    ).rejects.toThrow("account_login_required");
    expect(registrations).toBe(1);
    expect(rotations).toBe(1);
    expect((await service.status()).phase).toBe("signed-in");
  });
  it("does not discard login for an HTML 401 followed by an unavailable token endpoint", async () => {
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async (url: URL) =>
      url.pathname === "/v1/auth/token"
        ? new Response("gateway down", { status: 503 })
        : new Response("<html>gateway auth</html>", { status: 401 }),
    );
    await expect(service.liveSessions()).rejects.toBeDefined();
    expect((await service.status()).account).toEqual(profile);
    expect(await readFile(join(directory, "refresh.enc"))).toBeDefined();
  });
  it("does not let an old 401 refresh or retry as a newly signed-in account", async () => {
    await service.request({ operation: "login" });
    await callback();
    let finish!: (value: Response) => void;
    let reads = 0;
    const other = { ...profile, id: "account-b", username: "bob" };
    network.mockImplementation(async (url: URL) => {
      if (url.pathname === "/v1/account/sessions") {
        reads++;
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }
      return Response.json(url.pathname === "/v1/auth/token" ? { ...tokens, account: other } : {});
    });
    const old = service.liveSessions();
    const rejection = expect(old).rejects.toThrow("account_identity_changed");
    await vi.waitFor(() => expect(finish).toBeDefined());
    await service.request({ operation: "logout" });
    await service.request({ operation: "login" });
    await callback();
    finish(Response.json({ error: "authentication_required" }, { status: 401 }));
    await rejection;
    expect(reads).toBe(1);
    expect((await service.status()).account).toEqual(other);
  });
  it("logout wins over a rotation in flight and prevents later session resurrection", async () => {
    await service.request({ operation: "login" });
    await callback();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    let rotate!: (value: Response) => void;
    network.mockImplementation(async (url: URL) =>
      url.pathname === "/v1/auth/token"
        ? new Promise<Response>((resolve) => {
            rotate = resolve;
          })
        : Response.json({ ok: true }),
    );
    try {
      const refresh = service.accessToken();
      await vi.waitFor(() => expect(rotate).toBeDefined());
      const logout = service.request({ operation: "logout" });
      await vi.waitFor(() => expect(pause).toHaveBeenCalledOnce());
      rotate(
        Response.json({ ...tokens, accessToken: "b".repeat(43), refreshToken: "s".repeat(43) }),
      );
      await refresh;
      await logout;
      expect((await service.status()).phase).toBe("signed-out");
      expect(service.signedIn).toBe(false);
      await expect(readFile(join(directory, "refresh.enc"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clock.mockRestore();
    }
  });
  it("can replace an uncertain cached account by signing in as another account", async () => {
    await service.request({ operation: "login" });
    await callback();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 601_000);
    try {
      network.mockRejectedValue(new Error("response lost"));
      await expect(service.accessToken()).rejects.toBeDefined();
      expect((await service.status()).account).toEqual(profile);
      const other = { ...profile, id: "account-b", username: "bob" };
      network.mockImplementation(async (url: URL) =>
        Response.json(url.pathname === "/v1/auth/token" ? { ...tokens, account: other } : {}),
      );
      await service.request({ operation: "login" });
      await callback();
      expect((await service.status()).account).toEqual(other);
      expect((await service.status()).phase).toBe("signed-in");
    } finally {
      clock.mockRestore();
    }
  });
  it("detects a crash marker before using old refresh credentials", async () => {
    await service.request({ operation: "login" });
    await callback();
    service.shutdown();
    await writeFile(
      join(directory, "refresh.enc"),
      Buffer.from(Buffer.from(tokens.refreshToken).map((byte) => byte ^ 0x55)),
    );
    await writeFile(join(directory, "rotation-pending"), "pending");
    network.mockClear();
    await setup();
    expect(network).not.toHaveBeenCalled();
    expect((await service.status()).error).toBe("account_login_required");
  });
  it("persists remote pause before logout network and preserves the device identity", async () => {
    identity = { deviceId: "device", credential: "private", accountId: profile.id };
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async () => {
      expect(pause).toHaveBeenCalledOnce();
      throw new Error("offline");
    });
    const state = await service.request({ operation: "logout" });
    expect(state.error).toBe("account_remote_logout_unconfirmed");
    expect(state.phase).toBe("signed-out");
    expect(identity.credential).toBe("private");
    await expect(service.ensureDeviceOwner(profile.id)).rejects.toBeDefined();
  });
  it("does not restore cached access after logout cannot delete the credential file", async () => {
    await service.request({ operation: "login" });
    await callback();
    storageFailure.blockedDelete = join(directory, "refresh.enc");
    network.mockRejectedValue(new Error("offline"));
    const loggedOut = await service.request({ operation: "logout" });
    expect(loggedOut.phase).toBe("signed-out");
    expect(loggedOut.error).toBeDefined();
    expect(await readFile(join(directory, "refresh.enc"))).toBeDefined();
    service.shutdown();
    storageFailure.blockedDelete = "";
    network.mockClear();
    await setup();
    expect((await service.status()).phase).toBe("signed-out");
    expect((await service.status()).account).toBeUndefined();
    expect(service.signedIn).toBe(false);
    expect(network).not.toHaveBeenCalled();
    await expect(service.accessToken()).rejects.toThrow("account_login_required");
    network.mockImplementation(async () => Response.json(tokens));
    await service.request({ operation: "login" });
    await callback();
    expect((await service.status()).phase).toBe("signed-in");
    service.shutdown();
    await setup();
    expect(await service.accessToken()).toBe(tokens.accessToken);
  });
  it("does not report a replacement login before removing the logout tombstone", async () => {
    await service.request({ operation: "login" });
    await callback();
    await service.request({ operation: "logout" });
    expect(await readFile(join(directory, "rotation-pending"), "utf8")).toBe("signed-out");
    storageFailure.blockedDelete = join(directory, "rotation-pending");
    await service.request({ operation: "login" });
    await callback();
    expect((await service.status()).phase).toBe("signed-out");
    expect((await service.status()).error).toBeDefined();
    expect(service.signedIn).toBe(false);
    expect(await readFile(join(directory, "refresh.enc"))).toBeDefined();
    service.shutdown();
    storageFailure.blockedDelete = "";
    network.mockClear();
    await setup();
    expect((await service.status()).phase).toBe("signed-out");
    expect(network).not.toHaveBeenCalled();
    await service.request({ operation: "login" });
    await callback();
    expect((await service.status()).phase).toBe("signed-in");
    await expect(readFile(join(directory, "rotation-pending"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    service.shutdown();
    await setup();
    expect((await service.status()).phase).toBe("signed-in");
    expect(await service.accessToken()).toBe(tokens.accessToken);
  });
  it("still deletes credentials and reports IO failure if the logout tombstone cannot be written", async () => {
    await service.request({ operation: "login" });
    await callback();
    await mkdir(join(directory, "rotation-pending.tmp"));
    const result = await service.request({ operation: "logout" });
    expect(result.phase).toBe("signed-out");
    expect(result.error).toBeDefined();
    await expect(readFile(join(directory, "refresh.enc"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    service.shutdown();
    network.mockClear();
    await setup();
    expect((await service.status()).phase).toBe("signed-out");
    expect(network).not.toHaveBeenCalled();
  });
  it("blocks a concurrent relay enable while logout revocation is in flight", async () => {
    await service.request({ operation: "login" });
    await callback();
    let release!: () => void;
    network.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return Response.json({ ok: true });
    });
    const logout = service.request({ operation: "logout" });
    await vi.waitFor(() => expect(release).toBeDefined());
    await expect(service.ensureDeviceOwner(profile.id)).rejects.toThrow("account_login_required");
    await expect(service.ensureDeviceOwner()).rejects.toThrow("account_login_required");
    expect(service.signedIn).toBe(false);
    release();
    await logout;
  });
  it("does not clear credentials if durable pause fails", async () => {
    await service.request({ operation: "login" });
    await callback();
    pause.mockRejectedValue(new Error("disk failure"));
    const state = await service.request({ operation: "logout" });
    expect(state.phase).toBe("signed-in");
    expect(await readFile(join(directory, "refresh.enc"))).toBeDefined();
  });
  it("claims only through the desktop credential and rejects another owner", async () => {
    identity = { deviceId: "device", credential: "private" };
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname === "/v1/account" ? profile : { deviceId: "device", accountId: profile.id },
      ),
    );
    expect((await service.request({ operation: "claim" })).device?.ownership).toBe("owned");
    const request = network.mock.calls.find(
      (call) => (call[0] as URL).pathname === "/v1/account/devices/claim",
    )![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      deviceId: "device",
      credential: "private",
    });
    identity.accountId = "another-account";
    expect((await service.request({ operation: "claim" })).error).toBe("account_device_conflict");
  });
  it("a definite profile rejection clears cached login and encrypted refresh state", async () => {
    await service.request({ operation: "login" });
    await callback();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
    network.mockImplementation(async () =>
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );
    try {
      const state = await service.request({ operation: "status" });
      expect(state.phase).toBe("signed-out");
      expect(state.account).toBeUndefined();
      expect(state.error).toBe("account_login_required");
      await expect(readFile(join(directory, "refresh.enc"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clock.mockRestore();
    }
  });
  it("claim 401 clears authentication but permission and quota rejections preserve login", async () => {
    identity = { deviceId: "device", credential: "private" };
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async () =>
      Response.json({ error: "device_limit_reached" }, { status: 409 }),
    );
    expect((await service.request({ operation: "claim" })).error).toBe("account_device_limit");
    expect((await service.status()).phase).toBe("signed-in");
    network.mockImplementation(async () =>
      Response.json({ error: "device_unavailable" }, { status: 403 }),
    );
    expect((await service.request({ operation: "claim" })).error).toBe("account_forbidden");
    expect((await service.status()).phase).toBe("signed-in");
    network.mockImplementation(async () =>
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );
    expect((await service.request({ operation: "claim" })).phase).toBe("signed-out");
  });
  it("account registration 401 publishes signed-out state and arbitrary errors stay private", async () => {
    await service.request({ operation: "login" });
    await callback();
    network.mockImplementation(async () =>
      Response.json({ error: "sensitive-debug-data" }, { status: 409 }),
    );
    await expect(
      service.registerDevice({ registrationId: "test", credential: "private" }),
    ).rejects.toThrow("account_device_conflict");
    expect(JSON.stringify(await service.status())).not.toContain("sensitive-debug-data");
    network.mockImplementation(async () =>
      Response.json({ error: "authentication_required" }, { status: 401 }),
    );
    await expect(
      service.registerDevice({ registrationId: "test", credential: "private" }),
    ).rejects.toThrow("account_login_required");
    expect((await service.status()).phase).toBe("signed-out");
  });
  it("does not auto-claim for a different account after an uncertain claim", async () => {
    identity = { deviceId: "device", credential: "private" };
    await service.request({ operation: "login" });
    await callback();
    network.mockRejectedValue(new Error("request never reached server"));
    await service.request({ operation: "claim" });
    expect(identity.accountClaimAccountId).toBe(profile.id);
    expect(identity.accountId).toBeUndefined();
    await service.request({ operation: "logout" });
    const other = { ...profile, id: "account-b", username: "bob" };
    network.mockClear();
    network.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname === "/v1/auth/token" ? { ...tokens, account: other } : { ok: true },
      ),
    );
    await service.request({ operation: "login" });
    await callback();
    const state = await service.request({ operation: "status" });
    expect(state.phase).toBe("signed-in");
    expect(state.account?.id).toBe(other.id);
    expect(state.error).toBe("account_claim_pending");
    expect((await service.request({ operation: "claim" })).error).toBe("account_claim_pending");
    expect(
      network.mock.calls.some((call) => (call[0] as URL).pathname === "/v1/account/devices/claim"),
    ).toBe(false);
    expect(identity.accountId).toBeUndefined();
  });
  it("reconciles a pending claim only after the intended account signs in again", async () => {
    identity = {
      deviceId: "device",
      credential: "private",
      accountClaimPending: true,
      accountClaimAccountId: profile.id,
    };
    network.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname === "/v1/auth/token"
          ? tokens
          : url.pathname === "/v1/account"
            ? profile
            : { deviceId: "device", accountId: profile.id },
      ),
    );
    await service.request({ operation: "login" });
    await callback();
    const state = await service.request({ operation: "status" });
    expect(state.device?.ownership).toBe("owned");
    expect(identity.accountClaimPending).toBeUndefined();
    expect(identity.accountClaimAccountId).toBeUndefined();
    expect(
      network.mock.calls.filter(
        (call) => (call[0] as URL).pathname === "/v1/account/devices/claim",
      ),
    ).toHaveLength(1);
  });
  it("rejects injected paths or native RPC parameters", async () => {
    await expect(
      service.request({ operation: "login", url: "https://attacker.invalid" } as never),
    ).rejects.toThrow("invalid_account_request");
  });
});

describe("computer names", () => {
  const deviceId = "d".repeat(32);
  const calls = (path: string, method?: string) =>
    network.mock.calls
      .filter(
        ([url, init]) =>
          (url as URL).pathname === path &&
          (!method || ((init as RequestInit).method ?? "GET") === method),
      )
      .map(([, init]) => {
        const body = (init as RequestInit).body;
        return body ? JSON.parse(body as string) : undefined;
      });
  /** Routes by path; anything else answers with the token response used by login. */
  function broker(routes: Record<string, (init: RequestInit) => Response>) {
    network.mockImplementation(async (url: URL, init: RequestInit) => {
      const route = routes[`${init.method ?? "GET"} ${url.pathname}`];
      return route ? route(init) : Response.json(url.pathname === "/v1/account" ? profile : tokens);
    });
  }
  async function signIn() {
    await service.request({ operation: "login" });
    await callback();
  }
  beforeEach(async () => {
    service.shutdown();
    computer = async () => "  Alice’s\tMacBook ";
    await setup();
  });

  it("sends the normalised name on register and keeps the name the account reports", async () => {
    broker({
      "POST /v1/account/devices": () =>
        Response.json({ deviceId, accountId: profile.id, name: "Alice’s MacBook (2)" }),
    });
    await signIn();
    const result = await service.registerDevice({
      registrationId: "r".repeat(16),
      credential: "c",
    });
    expect(result.name).toBe("Alice’s MacBook (2)");
    expect(calls("/v1/account/devices", "POST")).toEqual([
      { registrationId: "r".repeat(16), credential: "c", name: "Alice’s MacBook" },
    ]);
    identity = { deviceId, credential: "c", accountId: profile.id };
    expect((await service.status()).device).toEqual({
      deviceId,
      ownership: "owned",
      name: "Alice’s MacBook (2)",
    });
  });
  it("an old broker ignores the name: one register request, no name shown", async () => {
    broker({
      "POST /v1/account/devices": () => Response.json({ deviceId, accountId: profile.id }),
    });
    await signIn();
    await service.registerDevice({ registrationId: "r".repeat(16), credential: "c" });
    expect(calls("/v1/account/devices", "POST")).toHaveLength(1);
    identity = { deviceId, credential: "c", accountId: profile.id };
    expect((await service.status()).device).toEqual({ deviceId, ownership: "owned" });
  });
  it("retries register and claim once without the name on 400 invalid_name only", async () => {
    const invalid = (init: RequestInit) =>
      JSON.parse(init.body as string).name
        ? Response.json({ error: "invalid_name" }, { status: 400 })
        : Response.json({ deviceId, accountId: profile.id });
    broker({ "POST /v1/account/devices": invalid, "POST /v1/account/devices/claim": invalid });
    await signIn();
    await service.registerDevice({ registrationId: "r".repeat(16), credential: "c" });
    expect(calls("/v1/account/devices", "POST").map((body) => body.name)).toEqual([
      "Alice’s MacBook",
      undefined,
    ]);
    identity = { deviceId, credential: "private" };
    expect((await service.request({ operation: "claim" })).device?.ownership).toBe("owned");
    expect(calls("/v1/account/devices/claim")).toEqual([
      { deviceId, credential: "private", name: "Alice’s MacBook" },
      { deviceId, credential: "private" },
    ]);
    network.mockClear();
    broker({
      "POST /v1/account/devices": () =>
        Response.json({ error: "invalid_registration_identity" }, { status: 400 }),
    });
    await expect(
      service.registerDevice({ registrationId: "bad", credential: "c" }),
    ).rejects.toThrow("account_request_failed");
    expect(calls("/v1/account/devices", "POST")).toHaveLength(1);
  });
  it("registers without a name when detection fails", async () => {
    service.shutdown();
    computer = async () => {
      throw new Error("scutil missing");
    };
    await setup();
    broker({
      "POST /v1/account/devices": () => Response.json({ deviceId, accountId: profile.id }),
    });
    await signIn();
    await service.registerDevice({ registrationId: "r".repeat(16), credential: "c" });
    expect(calls("/v1/account/devices", "POST")).toEqual([
      { registrationId: "r".repeat(16), credential: "c" },
    ]);
  });
  it("backfills a registered device without a name once after sign-in", async () => {
    identity = { deviceId, credential: "c", accountId: profile.id };
    broker({
      "GET /v1/account/devices": () => Response.json({ devices: [{ deviceId, name: null }] }),
      [`PATCH /v1/account/devices/${deviceId}`]: (init) =>
        Response.json({ deviceId, name: JSON.parse(init.body as string).name }),
    });
    await signIn();
    await vi.waitFor(async () =>
      expect((await service.status()).device?.name).toBe("Alice’s MacBook"),
    );
    expect(calls(`/v1/account/devices/${deviceId}`, "PATCH")).toEqual([
      { name: "Alice’s MacBook" },
    ]);
    const request = network.mock.calls.find(
      ([, init]) => (init as RequestInit).method === "PATCH",
    )!;
    expect(((request[1] as RequestInit).headers as Record<string, string>).authorization).toBe(
      `Bearer ${tokens.accessToken}`,
    );
    expect(await service.backfillName()).toBe(false);
    expect(calls("/v1/account/devices", "GET")).toHaveLength(1);
  });
  it("backfills on startup and never patches a device that already has a name", async () => {
    identity = { deviceId, credential: "c", accountId: profile.id };
    await signIn();
    service.shutdown();
    network.mockClear();
    broker({
      "GET /v1/account/devices": () =>
        Response.json({ devices: [{ deviceId, name: "Renamed by user" }] }),
    });
    await setup();
    await vi.waitFor(async () =>
      expect((await service.status()).device?.name).toBe("Renamed by user"),
    );
    expect(calls(`/v1/account/devices/${deviceId}`, "PATCH")).toHaveLength(0);
  });
  it("skips PATCH when the broker does not report names, and ignores 404/405/409", async () => {
    identity = { deviceId, credential: "c", accountId: profile.id };
    broker({ "GET /v1/account/devices": () => Response.json({ devices: [{ deviceId }] }) });
    await signIn();
    await vi.waitFor(() => expect(calls("/v1/account/devices", "GET")).toHaveLength(1));
    expect(await service.backfillName()).toBe(false);
    expect(network.mock.calls.some(([, init]) => (init as RequestInit).method === "PATCH")).toBe(
      false,
    );
    for (const [status, error] of [
      [404, "not_found"],
      [405, "method_not_allowed"],
      [409, "name_already_set"],
    ] as const) {
      service.shutdown();
      network.mockClear();
      broker({
        "GET /v1/account/devices": () => Response.json({ devices: [{ deviceId, name: null }] }),
        [`PATCH /v1/account/devices/${deviceId}`]: () => Response.json({ error }, { status }),
      });
      await setup();
      await vi.waitFor(() =>
        expect(calls(`/v1/account/devices/${deviceId}`, "PATCH")).toHaveLength(1),
      );
      expect(await service.backfillName()).toBe(false);
      const state = await service.status();
      expect(state.phase).toBe("signed-in");
      expect(state.error).toBeUndefined();
      expect(state.device?.name).toBeUndefined();
    }
  });

  it("refreshes account names on status after 30 seconds without repeating the automatic write", async () => {
    identity = { deviceId, credential: "c", accountId: profile.id };
    let name = "Original name";
    broker({
      "GET /v1/account/devices": () => Response.json({ devices: [{ deviceId, name }] }),
    });
    await signIn();
    await vi.waitFor(async () => expect((await service.status()).device?.name).toBe(name));
    const timestamp = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(timestamp);
    try {
      name = "Named from the phone";
      expect((await service.request({ operation: "status" })).device?.name).toBe("Original name");
      expect(calls("/v1/account/devices", "GET")).toHaveLength(1);
      clock.mockReturnValue(timestamp + 30_001);
      expect((await service.request({ operation: "status" })).device?.name).toBe(name);
      expect(calls("/v1/account/devices", "GET")).toHaveLength(2);
      expect(calls(`/v1/account/devices/${deviceId}`, "PATCH")).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
  });

  it("reads the winning user name after a backfill conflict without retrying PATCH", async () => {
    identity = { deviceId, credential: "c", accountId: profile.id };
    let name: string | null = null;
    broker({
      "GET /v1/account/devices": () => Response.json({ devices: [{ deviceId, name }] }),
      [`PATCH /v1/account/devices/${deviceId}`]: () => {
        name = "User named this computer";
        return Response.json({ error: "name_already_set" }, { status: 409 });
      },
    });
    await signIn();
    await vi.waitFor(async () =>
      expect((await service.status()).device?.name).toBe("User named this computer"),
    );
    expect(calls("/v1/account/devices", "GET")).toHaveLength(2);
    expect(calls(`/v1/account/devices/${deviceId}`, "PATCH")).toHaveLength(1);
    expect(await service.backfillName()).toBe(false);
  });

  it("does not publish an old name read after signing out and signing back in", async () => {
    identity = { deviceId, credential: "c", accountId: profile.id };
    let resolveOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      resolveOld = resolve;
    });
    let reads = 0;
    network.mockImplementation(async (url: URL) => {
      if (url.pathname === "/v1/account/devices") {
        if (++reads === 1) return old;
        return Response.json({ devices: [{ deviceId, name: "Current name" }] });
      }
      return Response.json(url.pathname === "/v1/account" ? profile : tokens);
    });
    await signIn();
    await vi.waitFor(() => expect(reads).toBe(1));
    await service.request({ operation: "logout" });
    await signIn();
    await vi.waitFor(async () =>
      expect((await service.status()).device?.name).toBe("Current name"),
    );
    resolveOld(Response.json({ devices: [{ deviceId, name: "Stale name" }] }));
    await new Promise((resolve) => setImmediate(resolve));
    expect((await service.status()).device?.name).toBe("Current name");
  });
});
