// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { HomeSession } from "@agentkib/session-catalog";
import type { Access } from "@agentkib/web-client";
import { openPushEnvelope } from "../push/envelope-fixture";
import { PushNotifier } from "../push/notifier";
import { NotificationPolicyStore } from "../push/policy";
import type { PushSendInput, RelayOptions, RelayStatus } from "./relay/manager";

const { relays } = vi.hoisted(() => ({
  relays: [] as {
    options: RelayOptions;
    status: RelayStatus;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    accountLoginContext: { deviceId: string; accountId: string };
    redeemAccountLogin: ReturnType<typeof vi.fn>;
    verifyAccountLogins: ReturnType<typeof vi.fn>;
    pushSend: ReturnType<typeof vi.fn<(input: PushSendInput) => Promise<{ delivered: true }>>>;
    report(status: RelayStatus): void;
  }[],
}));
vi.mock("./relay/manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./relay/manager")>()),
  RelayManager: class {
    status: RelayStatus = { phase: "disabled" };
    accountLoginContext = { deviceId: "a".repeat(32), accountId: "owner" };
    redeemAccountLogin = vi.fn(async () => ({
      id: "b".repeat(36),
      accountId: "owner",
      sessionId: "c".repeat(36),
      expiresAt: Date.now() + 86_400_000,
    }));
    verifyAccountLogins = vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, active: true, expiresAt: Date.now() + 86_400_000 })),
    );
    pushSend = vi.fn(async (_input: PushSendInput) => ({ delivered: true as const }));
    constructor(readonly options: RelayOptions) {
      relays.push(this);
    }
    start = vi.fn(async () => {
      this.report({ phase: "registering" });
    });
    stop = vi.fn(async () => {
      this.report({ phase: "disabled" });
    });
    report(status: RelayStatus) {
      this.status = status;
      this.options.onStatus?.(status);
    }
  },
}));
import { WebAccessService, type WebConfig } from "./service";

const brokerUrl = "https://api.agentkib.com";
const ready: RelayStatus = { phase: "ready", publicUrl: "https://device.control.example.com" };
const account = {
  signedIn: vi.fn(() => true),
  accountId: vi.fn<() => string | undefined>(() => "owner"),
  ensureDeviceOwner: vi.fn(async (accountId?: string) => {
    if (accountId && accountId !== "owner") throw new Error("account_device_conflict");
  }),
  registerDevice: vi.fn(async () => ({ accountId: "owner" })),
};
let dir: string;
let service: WebAccessService;
let port: number;
let occupied: ReturnType<typeof createServer> | undefined;
async function status() {
  return service.request({ operation: "status" });
}
async function loginBrowser() {
  const access = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`);
  const browser = await access.json();
  const headers = {
    Cookie: access.headers.get("set-cookie")!.split(";")[0],
    Origin: `http://127.0.0.1:${port}`,
    "X-CSRF-Token": browser.csrfToken,
    "Content-Type": "application/json",
  };
  await cloudLogin(headers, browser);
  return headers;
}
async function pairBrowser() {
  const headers = await loginBrowser();
  const code = (await service.request({ operation: "generate-code" })).code!.value;
  const paired = await fetch(`http://127.0.0.1:${port}/api/web/v1/pair`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code, name: "Test browser" }),
  });
  expect((await paired.json()).status).toBe("approved");
  return headers;
}
async function cloudLogin(
  headers: Record<string, string>,
  browser: { accountLogin?: { required: boolean; challenge: string } },
) {
  if (!browser.accountLogin?.required) return;
  const response = await fetch(`http://127.0.0.1:${port}/api/web/v1/account-binding`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      code: "p".repeat(43),
      codeVerifier: "v".repeat(43),
      hostChallenge: browser.accountLogin.challenge,
      redemptionId: "r".repeat(43),
    }),
  });
  expect(await response.json()).toEqual({ bound: true });
}
function pauseNextSave() {
  const internal = service as unknown as {
    save(config?: WebConfig, initialized?: boolean): Promise<void>;
  };
  const save = internal.save.bind(service);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(internal, "save").mockImplementationOnce(async (...args) => {
    entered();
    await gate;
    return save(...args);
  });
  return { started, release };
}
async function configured() {
  return service.request({
    operation: "configure",
    ...(await status()).config,
    enabled: false,
    port,
    allowedWorkspaceIds: ["workspace"],
    experimentalEnabled: false,
  });
}
beforeEach(async () => {
  relays.length = 0;
  account.signedIn.mockReset().mockReturnValue(true);
  account.accountId.mockReset().mockReturnValue("owner");
  account.ensureDeviceOwner.mockClear();
  account.registerDevice.mockClear();
  dir = await mkdtemp(join(tmpdir(), "agentkib-remote-enable-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  service = new WebAccessService({
    dataDir: dir,
    staticDir: dir,
    runtimeRequest: async () => ({}),
    account,
  });
  await service.initialize();
  await configured();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await service.shutdown();
  if (occupied) await new Promise<void>((resolve) => occupied!.close(() => resolve()));
  occupied = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("relay broker validation", () => {
  it("treats a trailing slash as the same broker instead of a provider change", async () => {
    await service.request({ operation: "remote-enable", brokerUrl, inviteCode: "x" });
    relays[0].report(ready);
    const headers = await pairBrowser();
    relays[0].report({ phase: "offline", reason: "network" });
    const result = await service.request({
      operation: "remote-enable",
      brokerUrl: `${brokerUrl}/`,
    });
    expect(result.config.relay?.brokerUrl).toBe(brokerUrl);
    expect(result.devices).toHaveLength(1);
    const access = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`, { headers });
    expect((await access.json()).status).toBe("approved");
  });

  it("rejects a malformed broker with a configuration error", async () => {
    for (const bad of [undefined, 42, "not a url", "http://api.agentkib.com", "https://a.com/x"])
      await expect(
        service.request({ operation: "remote-enable", brokerUrl: bad as never }),
      ).rejects.toThrow("invalid_relay_configuration");
  });
});

describe("recovering saved Web settings", () => {
  it("clears an invalid saved configuration only after a successful disabled save", async () => {
    await service.shutdown();
    const configuration = join(dir, "web-access.json");
    await writeFile(configuration, "unreadable settings");
    await service.initialize();
    const initial = await status();
    expect(initial).toMatchObject({
      running: false,
      error: "invalid_saved_configuration",
      config: { enabled: false },
    });

    await mkdir(`${configuration}.tmp`);
    const request = { operation: "configure", ...initial.config } as const;
    await expect(service.request(request)).rejects.toThrow("web_state_save_failed");
    expect((await status()).error).toBe("invalid_saved_configuration");
    await rm(`${configuration}.tmp`, { recursive: true });

    const repaired = await service.request(request);
    expect(repaired.error).toBeUndefined();
    expect(repaired.running).toBe(false);
    expect(JSON.parse(await readFile(configuration, "utf8")).config).toEqual(repaired.config);
  });

  it("reports an invalid external origin with a fixed reason", async () => {
    await expect(
      service.request({
        operation: "configure",
        ...(await status()).config,
        externalOrigin: "not a URL with private details",
      }),
    ).rejects.toThrow("invalid_external_origin");
  });
});

describe("quitting during remote enable", () => {
  it("waits for an in-flight enable and leaves no listener or relay behind", async () => {
    const paused = pauseNextSave();
    const enabling = service.request({ operation: "remote-enable", brokerUrl, inviteCode: "x" });
    await paused.started;
    const disposing = service.dispose();
    paused.release();
    await enabling;
    await disposing;
    const internal = service as unknown as { server?: { listening: boolean } };
    expect(internal.server?.listening ?? false).toBe(false);
    expect(relays.every((relay) => relay.stop.mock.calls.length > 0)).toBe(true);
    await expect(status()).rejects.toThrow("web_unavailable");
  });
});

describe("remote enable orchestration", () => {
  it("starts the listener and relay without broadening permissions, and deduplicates concurrent clicks", async () => {
    await Promise.all([
      service.request({ operation: "remote-enable", brokerUrl, inviteCode: "test-invite" }),
      service.request({ operation: "remote-enable", brokerUrl, inviteCode: "test-invite" }),
    ]);
    const result = await status();
    expect(result.running).toBe(true);
    expect(result.config.allowedWorkspaceIds).toEqual(["workspace"]);
    expect(result.config.experimentalEnabled).toBe(false);
    expect(result.devices).toEqual([]);
    expect(result.code).toBeUndefined();
    expect(relays).toHaveLength(1);
    expect(relays[0].options.inviteCode).toBeUndefined();
    expect(relays[0].options.registrationAccountId).toBe("owner");
    expect(relays[0].options.registerAccount).toBeTypeOf("function");
    expect(await readFile(join(dir, "web-access.json"), "utf8")).not.toContain("test-invite");
  });
  it("issues a code only once after readiness, never rotates it on polling, expiry or restart", async () => {
    await service.request({ operation: "remote-enable", brokerUrl });
    relays[0].report({ phase: "error", reason: "certificate" });
    expect((await status()).code).toBeUndefined();
    relays[0].report(ready);
    const first = (await status()).code;
    expect(first?.value).toMatch(/^\d{8}$/);
    relays[0].report({ phase: "offline", reason: "network" });
    relays[0].report(ready);
    expect((await status()).code).toEqual(first);
    const now = vi.spyOn(Date, "now").mockReturnValue(first!.expiresAt + 1);
    relays[0].report(ready);
    expect((await status()).code?.value).not.toBeDefined();
    now.mockRestore();
    await service.shutdown();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: async () => ({}),
      account,
    });
    await service.initialize();
    relays.at(-1)!.report(ready);
    expect((await status()).code).toBeUndefined();
    expect((await service.request({ operation: "generate-code" })).code?.value).toMatch(/^\d{8}$/);
  });
  it("does not replace an existing valid manually generated code", async () => {
    await service.request({ operation: "remote-enable", brokerUrl });
    const first = (await service.request({ operation: "generate-code" })).code;
    relays[0].report(ready);
    expect((await status()).code).toEqual(first);
  });
  it("keeps disabled settings and starts no network work if persistence fails", async () => {
    await mkdir(join(dir, "web-access.json.tmp"));
    expect((await service.request({ operation: "remote-enable", brokerUrl })).error).toBe(
      "web_state_save_failed",
    );
    expect((await status()).running).toBe(false);
    expect((await status()).config.enabled).toBe(false);
    expect((await status()).error).toBe("web_state_save_failed");
    expect(relays).toHaveLength(0);
    await rm(join(dir, "web-access.json.tmp"), { recursive: true });
    await service.request({ operation: "remote-enable", brokerUrl });
    expect((await status()).running).toBe(true);
  });
  it("reports port failure without starting a relay and allows retry", async () => {
    occupied = createServer();
    await new Promise<void>((resolve) => occupied!.listen(port, "127.0.0.1", resolve));
    await service.request({ operation: "remote-enable", brokerUrl });
    expect((await status()).error).toBe("port_in_use");
    expect((await status()).running).toBe(false);
    expect(relays).toHaveLength(0);
    await new Promise<void>((resolve) => occupied!.close(() => resolve()));
    occupied = undefined;
    await service.request({ operation: "remote-enable", brokerUrl });
    expect((await status()).running).toBe(true);
    expect((await status()).error).toBeUndefined();
  });
  it("explicitly switches provider without copying registration or reviving late callbacks", async () => {
    await service.request({ operation: "remote-enable", brokerUrl: "https://remote.agentkib.com" });
    const old = relays[0];
    await mkdir(old.options.stateDirectory, { recursive: true });
    const registration = join(old.options.stateDirectory, "registration.json");
    await writeFile(registration, "private-test-state");
    old.report(ready);
    await status();
    await service.request({ operation: "remote-enable", brokerUrl, inviteCode: "new-invite" });
    expect(old.stop).toHaveBeenCalled();
    const next = relays[1];
    expect(next.options.stateDirectory).not.toBe(old.options.stateDirectory);
    expect(await readFile(registration, "utf8")).toBe("private-test-state");
    await expect(
      readFile(join(next.options.stateDirectory, "registration.json")),
    ).rejects.toThrow();
    await old.options.onOrigins?.({
      publicUrl: "https://old.example.com",
      previewUrl: "https://preview.old.example.com",
    });
    old.report(ready);
    expect((await status()).config.externalOrigin).toBe("");
    expect((await status()).code).toBeUndefined();
    next.report(ready);
    expect((await status()).code).toBeDefined();
  });
  it("does not issue pairing codes on a late ready event after pause", async () => {
    await service.request({ operation: "remote-enable", brokerUrl });
    await service.request({ operation: "relay-stop" });
    relays[0].report(ready);
    expect((await status()).code).toBeUndefined();
    expect((await status()).config.relay?.enabled).toBe(false);
  });
  it("does not consume the first pairing code when readiness is lost during persistence", async () => {
    await service.request({ operation: "remote-enable", brokerUrl });
    const save = pauseNextSave();
    relays[0].report(ready);
    await save.started;
    relays[0].report({ phase: "offline", reason: "network" });
    save.release();
    expect((await status()).code).toBeUndefined();
    const persisted = JSON.parse(await readFile(join(dir, "web-access.json"), "utf8"));
    expect(persisted.remotePairingInitialized).toBe(false);
    relays[0].report(ready);
    expect((await status()).code).toBeDefined();
  });
  it("serializes logout with a delayed provider switch without restoring the old config", async () => {
    await service.request({ operation: "remote-enable", brokerUrl });
    const headers = await pairBrowser();
    const save = pauseNextSave();
    const nextBroker = "https://my-relay.example.com";
    const change = service.request({ operation: "remote-enable", brokerUrl: nextBroker });
    await save.started;
    // The HTTP handler is admitted before the switch, but its transaction waits.
    const logout = fetch(`http://127.0.0.1:${port}/api/web/v1/logout`, {
      method: "POST",
      headers,
      body: "{}",
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    save.release();
    await change;
    expect((await logout).status).toBe(200);
    const persisted = JSON.parse(await readFile(join(dir, "web-access.json"), "utf8"));
    expect(persisted.config.relay.brokerUrl).toBe(nextBroker);
    expect(persisted.credentials).toEqual([]);
    expect((await status()).devices).toEqual([]);
  });
  it("denies LAN and HTTP clients access to remote enable", async () => {
    const lan = new WebAccessService({
      dataDir: join(dir, "lan"),
      staticDir: "",
      mode: "lan",
      runtimeRequest: async () => ({}),
    });
    await lan.initialize();
    await expect(lan.request({ operation: "remote-enable", brokerUrl })).rejects.toThrow(
      "remote_enable_unavailable",
    );
    await lan.shutdown();
    await service.request({ operation: "remote-enable", brokerUrl });
    const response = await fetch(`http://127.0.0.1:${port}/api/web/v1/remote-enable`, {
      method: "POST",
    });
    expect(response.status).toBe(401);
    const access = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`);
    const browser = await access.json();
    const cookie = access.headers.get("set-cookie")!.split(";")[0];
    const headers = {
      Cookie: cookie,
      Origin: `http://127.0.0.1:${port}`,
      "X-CSRF-Token": browser.csrfToken,
      "Content-Type": "application/json",
    };
    await cloudLogin(headers, browser);
    const code = (await service.request({ operation: "generate-code" })).code!.value;
    const paired = await fetch(`http://127.0.0.1:${port}/api/web/v1/pair`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code, name: "Test browser" }),
    });
    expect((await paired.json()).status).toBe("approved");
    const authorized = await fetch(`http://127.0.0.1:${port}/api/web/v1/remote-enable`, {
      method: "POST",
      headers,
      body: JSON.stringify({ brokerUrl: "https://another.example.com" }),
    });
    expect(authorized.status).toBe(404);
    expect(relays).toHaveLength(1);
    await service.request({ operation: "remote-enable", brokerUrl: "https://another.example.com" });
    expect((await status()).devices).toEqual([]);
    const oldBrowser = await fetch(`http://127.0.0.1:${port}/api/web/v1/catalog`, { headers });
    expect(oldBrowser.status).toBe(401);
  });
});

describe("account ownership and durable pause", () => {
  async function saveIdentity(extra: object = {}) {
    const directory = join(
      dir,
      "relay",
      createHash("sha256").update(brokerUrl).digest("hex").slice(0, 24),
    );
    await mkdir(directory, { recursive: true });
    const value = {
      deviceId: "a".repeat(32),
      credential: "b".repeat(43),
      brokerUrl,
      controlHost: "device.control.example.com",
      previewHost: "device.preview.example.com",
      tunnelHost: "tunnel.example.com",
      tunnelPort: 443,
      ...extra,
    };
    await writeFile(join(directory, "registration.json"), JSON.stringify(value));
    return value;
  }
  it.each([
    ["code", 403, "invalid_pairing_code"],
    ["browser", 401, "access_ended"],
    ["binding", 401, "account_login_required"],
    ["owner", 503, "account_login_unavailable"],
  ])("rechecks the pairing %s after waiting for the relay", async (changed, status, error) => {
    await service.request({ operation: "remote-enable", brokerUrl });
    const relay = relays[0]!;
    relay.report(ready);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const generate = async () =>
      (await service.request({ operation: "generate-code" })).code!.value;
    let code = changed === "code" ? await generate() : undefined;
    if (changed === "code") now += 1_000;
    if (changed === "binding") {
      relay.redeemAccountLogin.mockResolvedValueOnce({
        id: "b".repeat(36),
        accountId: "owner",
        sessionId: "c".repeat(36),
        expiresAt: now + 5_000,
      });
    }
    const headers = await loginBrowser();
    if (changed === "browser") now += 1_000;
    code ??= await generate();

    let release!: () => void;
    const verified = new Promise<void>((resolve) => (release = resolve));
    relay.verifyAccountLogins.mockImplementationOnce(async (ids: string[]) => {
      await verified;
      return ids.map((id) => ({ id, active: true, expiresAt: now + 86_400_000 }));
    });
    const pending = fetch(`http://127.0.0.1:${port}/api/web/v1/pair`, {
      method: "POST",
      headers,
      body: JSON.stringify({ code, name: "Test browser" }),
    });
    try {
      await vi.waitFor(() => expect(relay.verifyAccountLogins).toHaveBeenCalledOnce());
      if (changed === "owner") account.accountId.mockReturnValue("other");
      else now += changed === "binding" ? 5_000 : 299_000;
    } finally {
      release();
    }
    const response = await pending;
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(JSON.parse(await readFile(join(dir, "web-access.json"), "utf8")).credentials).toEqual(
      [],
    );
  });

  it("pauses official access on account loss and restores the same pairing on owner login", async () => {
    await saveIdentity({ accountId: "owner" });
    await service.request({ operation: "remote-enable", brokerUrl });
    relays[0].report(ready);
    const headers = await pairBrowser();
    account.signedIn.mockReturnValue(false);
    account.accountId.mockReturnValue(undefined);
    await service.updateOfficialRelayAccount(false);

    expect(relays[0].stop).toHaveBeenCalledTimes(1);
    expect(await status()).toMatchObject({
      config: { relay: { enabled: true } },
      relay: { phase: "offline", reason: "account-required" },
      devices: [expect.objectContaining({ accountBound: true })],
    });
    const persisted = JSON.parse(await readFile(join(dir, "web-access.json"), "utf8"));
    expect(persisted.config.relay.enabled).toBe(true);
    for (const route of ["access", "catalog"]) {
      const denied = await fetch(`http://127.0.0.1:${port}/api/web/v1/${route}`, { headers });
      expect(denied.status).toBe(503);
      expect(await denied.json()).toMatchObject({ error: "account_login_unavailable" });
    }

    account.signedIn.mockReturnValue(true);
    account.accountId.mockReturnValue("other");
    await service.updateOfficialRelayAccount(true);
    expect(relays).toHaveLength(1);
    expect((await status()).relay).toMatchObject({ phase: "offline", reason: "account-required" });

    account.accountId.mockReturnValue("owner");
    await service.updateOfficialRelayAccount(true);
    expect(relays).toHaveLength(2);
    expect(relays[1].options.reenroll).toBeUndefined();
    relays[1].report(ready);
    const access = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`, { headers });
    expect(access.status).toBe(200);
    expect(await access.json()).toMatchObject({
      status: "approved",
      accountLogin: { bound: true },
    });

    await service.request({ operation: "relay-stop" });
    await service.updateOfficialRelayAccount(true);
    expect(relays).toHaveLength(2);
  });
  it("holds an approval alert during account loss and resumes notifications for the same pairing", async () => {
    await service.shutdown();
    const policy = new NotificationPolicyStore(dir);
    const savedPolicy = await policy.update(
      { onlyAway: false, categories: { question: false } },
      () => {},
    );
    const waiting: HomeSession = {
      id: "waiting-session",
      agent: "codex",
      title: "Synthetic approval",
      availability: "readable",
      workspace_id: "workspace",
      updated_at: "2026-11-25T00:00:00.000Z",
      continuation: { status: "awaiting-approval" },
    };
    let sessions: HomeSession[] = [];
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: async () => ({
        workspaces: [{ id: "workspace", name: "Test workspace", path: dir }],
        sessions,
      }),
      account,
      notificationPolicy: policy,
    });
    await service.initialize();
    await configured();
    await saveIdentity({ accountId: "owner" });
    await service.request({ operation: "remote-enable", brokerUrl });
    relays[0].report(ready);
    const headers = await pairBrowser();
    const request = (route: string, body?: object) =>
      fetch(`http://127.0.0.1:${port}/api/web/v1/${route}`, {
        headers,
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      });
    const phone = generateKeyPairSync("x25519");
    const publicKey = phone.publicKey.export({ format: "jwk" }).x!;
    const subscription = { publicKey, ref: "test-phone", alerts: true, liveActivity: false };
    expect((await request("push/subscribe", subscription)).status).toBe(200);
    const before = (await (await request("access")).json()) as Access;
    expect(before.device?.id).toBeTruthy();
    const targets = service.pushTargets();
    expect(targets).toHaveLength(1);
    const notifier = new PushNotifier({
      targets: () => service.pushTargets(),
      recoveringTargets: () => service.pushRecoveringTargets(),
      deviceId: () => service.pushDeviceId(),
      send: (input) => service.pushSend(input),
      alertContext: (target, session, kind) =>
        service.notificationAlertContext(target, session, kind),
      delivery: (kind, present, now) => policy.delivery(kind, present, now),
    });
    const unsubscribe = service.onPushChanged(() => notifier.refresh());
    try {
      notifier.update(sessions);
      account.signedIn.mockReturnValue(false);
      account.accountId.mockReturnValue(undefined);
      const paused = service.updateOfficialRelayAccount(false);
      expect(service.pushDeviceId()).toBeUndefined();
      expect(service.pushTargets()).toEqual([]);
      await paused;
      sessions = [waiting];
      notifier.update(sessions);
      expect(service.pushTargets()).toEqual([]);
      expect((await request("push/activity")).status).toBe(503);

      account.signedIn.mockReturnValue(true);
      account.accountId.mockReturnValue("other");
      await service.updateOfficialRelayAccount(true);
      expect(relays).toHaveLength(1);
      expect((await request("push/policy")).status).toBe(503);
      expect(relays[0].pushSend).not.toHaveBeenCalled();

      account.accountId.mockReturnValue("owner");
      await service.updateOfficialRelayAccount(true);
      expect(relays).toHaveLength(2);
      relays[1].report(ready);
      await vi.waitFor(() => expect(relays[1].pushSend).toHaveBeenCalledOnce());
      const sent = relays[1].pushSend.mock.calls[0][0];
      expect(sent).toMatchObject({ session: targets[0].session, kind: "alert" });
      if (sent.kind !== "alert") throw new Error("fixture_missing_alert");
      expect(
        openPushEnvelope(
          sent.envelope,
          phone.privateKey,
          publicKey,
          relays[1].accountLoginContext.deviceId,
        ),
      ).toMatchObject({ kind: "approval", sessionId: waiting.id });
      expect(await (await request("access")).json()).toMatchObject({
        device: before.device,
        push: { subscribed: true, alerts: true, liveActivity: false },
      });
      expect((await request("push/subscribe", subscription)).status).toBe(200);
      expect(service.pushTargets()).toEqual(targets);
      expect(await (await request("push/policy")).json()).toEqual({ policy: savedPolicy });
      expect(await (await request("push/activity")).json()).toMatchObject({
        activity: {
          version: expect.any(String),
          waiting: 1,
          running: 0,
          priority: { category: "approval", sessionId: waiting.id },
        },
      });
      await service.updateOfficialRelayAccount(true);
      relays[1].report(ready);
      notifier.update(sessions);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(relays[1].pushSend).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
      await notifier.stop();
    }
  });
  it("waits for an account at host startup with saved official enablement", async () => {
    await saveIdentity({ accountId: "owner" });
    await service.request({ operation: "remote-enable", brokerUrl });
    await service.shutdown();
    account.signedIn.mockReturnValue(false);
    account.accountId.mockReturnValue(undefined);
    await service.initialize();
    expect(relays).toHaveLength(1);
    expect((await status()).relay).toMatchObject({ phase: "offline", reason: "account-required" });
    account.signedIn.mockReturnValue(true);
    account.accountId.mockReturnValue("owner");
    await service.updateOfficialRelayAccount(true);
    expect(relays).toHaveLength(2);
  });
  it("still stops the previous relay when another account signs in before queued account loss runs", async () => {
    await saveIdentity({ accountId: "owner" });
    await service.request({ operation: "remote-enable", brokerUrl });
    relays[0].report(ready);
    const headers = await pairBrowser();
    const internals = service as unknown as { adminQueue: Promise<void> };
    let release!: () => void;
    internals.adminQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pause!: Promise<void>;
    let login!: Promise<void>;
    try {
      account.signedIn.mockReturnValue(false);
      account.accountId.mockReturnValue(undefined);
      pause = service.updateOfficialRelayAccount(false);
      account.signedIn.mockReturnValue(true);
      account.accountId.mockReturnValue("other");
      login = service.updateOfficialRelayAccount(true);
      expect(relays[0].status.phase).toBe("ready");
      const access = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`, { headers });
      expect(access.status).toBe(503);
      expect(await access.json()).toMatchObject({ error: "account_login_unavailable" });
    } finally {
      release();
    }
    await Promise.all([pause, login, service.checkAccountBindings()]);

    expect(relays[0].stop).toHaveBeenCalledTimes(1);
    expect(relays).toHaveLength(1);
    expect(await status()).toMatchObject({
      config: { relay: { enabled: true } },
      relay: { phase: "offline", reason: "account-required" },
      devices: [expect.objectContaining({ accountBound: true })],
    });
    account.accountId.mockReturnValue("owner");
    await service.updateOfficialRelayAccount(true);
    expect(relays).toHaveLength(2);
    relays[1].report(ready);
    const restored = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`, { headers });
    expect(await restored.json()).toMatchObject({
      status: "approved",
      accountLogin: { bound: true },
    });
  });
  it("refuses account-owned remote enable without an account bridge", async () => {
    await saveIdentity({ accountId: "owner" });
    await service.shutdown();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: async () => ({}),
    });
    await service.initialize();
    await expect(service.request({ operation: "remote-enable", brokerUrl })).rejects.toThrow(
      "account_login_required",
    );
    expect(relays).toHaveLength(0);
  });
  it("blocks an uncertain claim across restart until binding is confirmed", async () => {
    await saveIdentity();
    await service.prepareAccountClaim("owner");
    expect((await service.accountIdentity())?.accountClaimPending).toBe(true);
    expect((await service.accountIdentity())?.accountClaimAccountId).toBe("owner");
    await expect(service.prepareAccountClaim("other")).rejects.toThrow("account_claim_pending");
    await expect(service.bindAccountIdentity("other")).rejects.toThrow("account_claim_pending");
    await service.shutdown();
    service = new WebAccessService({
      dataDir: dir,
      staticDir: dir,
      runtimeRequest: async () => ({}),
      account,
    });
    await service.initialize();
    await expect(service.request({ operation: "remote-enable", brokerUrl })).rejects.toThrow(
      "account_claim_pending",
    );
    await service.bindAccountIdentity("owner");
    expect(await service.accountIdentity()).toMatchObject({
      accountId: "owner",
      deviceId: "a".repeat(32),
      credential: "b".repeat(43),
    });
    expect((await service.accountIdentity())?.accountClaimPending).toBeUndefined();
  });
  it("writes disabled intent before stopping and retains browser grants", async () => {
    await service.request({ operation: "remote-enable", brokerUrl });
    await pairBrowser();
    relays[0].stop.mockImplementationOnce(async () => {
      const persisted = JSON.parse(await readFile(join(dir, "web-access.json"), "utf8"));
      expect(persisted.config.relay.enabled).toBe(false);
      expect(persisted.credentials).toHaveLength(1);
    });
    await service.request({ operation: "relay-stop" });
    expect((await status()).devices).toHaveLength(1);
  });
  it("reports an unreadable saved account registration without exposing its contents", async () => {
    const directory = join(
      dir,
      "relay",
      createHash("sha256").update(brokerUrl).digest("hex").slice(0, 24),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "registration.json"), "not valid JSON with private contents");
    await expect(service.request({ operation: "remote-enable", brokerUrl })).rejects.toThrow(
      "invalid_account_registration",
    );
    expect(relays).toHaveLength(0);
  });

  it("requires login for first official registration even with a stale invitation", async () => {
    account.signedIn.mockReturnValue(false);
    await expect(
      service.request({ operation: "remote-enable", brokerUrl, inviteCode: "obsolete" }),
    ).rejects.toThrow("account_login_required");
    expect(relays).toHaveLength(0);
    expect((await status()).config.enabled).toBe(false);
  });
  it("allows official reenrollment without an invitation and checks the saved owner", async () => {
    await saveIdentity({ accountId: "owner" });
    await service.request({ operation: "remote-enable", brokerUrl, reenroll: true });
    expect(account.ensureDeviceOwner).toHaveBeenCalledWith("owner");
    expect(relays[0].options).toMatchObject({ reenroll: true, registrationAccountId: "owner" });
    expect(relays[0].options.inviteCode).toBeUndefined();
  });
  it("does not reenroll a device owned by another account", async () => {
    await saveIdentity({ accountId: "other" });
    await expect(
      service.request({ operation: "remote-enable", brokerUrl, reenroll: true }),
    ).rejects.toThrow("account_device_conflict");
    expect(relays).toHaveLength(0);
  });
  it("fails closed if login ends before relay authorization", async () => {
    await service.request({ operation: "remote-enable", brokerUrl });
    account.signedIn.mockReturnValue(false);
    await expect(relays[0].options.authorizeAccount?.("owner")).rejects.toThrow(
      "account_login_required",
    );
  });
  it("keeps explicit invitation reenrollment for independent brokers", async () => {
    const independent = "https://relay.example.com";
    await expect(
      service.request({ operation: "remote-enable", brokerUrl: independent, reenroll: true }),
    ).rejects.toThrow("invitation_required_for_reenrollment");
    account.signedIn.mockReturnValue(false);
    await service.request({
      operation: "remote-enable",
      brokerUrl: independent,
      reenroll: true,
      inviteCode: "self-hosted-invitation",
    });
    expect(relays[0].options.inviteCode).toBe("self-hosted-invitation");
    expect(relays[0].options.registerAccount).toBeUndefined();
    expect(relays[0].options.authorizeAccount).toBeUndefined();
  });
});
