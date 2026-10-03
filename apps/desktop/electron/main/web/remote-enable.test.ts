// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { RelayOptions, RelayStatus } from "./relay/manager";

const { relays } = vi.hoisted(() => ({
  relays: [] as {
    options: RelayOptions;
    status: RelayStatus;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    report(status: RelayStatus): void;
  }[],
}));
vi.mock("./relay/manager", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./relay/manager")>()),
  RelayManager: class {
    status: RelayStatus = { phase: "disabled" };
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
let dir: string;
let service: WebAccessService;
let port: number;
let occupied: ReturnType<typeof createServer> | undefined;
async function status() {
  return service.request({ operation: "status" });
}
async function pairBrowser() {
  const access = await fetch(`http://127.0.0.1:${port}/api/web/v1/access`);
  const browser = await access.json();
  const headers = {
    Cookie: access.headers.get("set-cookie")!.split(";")[0],
    Origin: `http://127.0.0.1:${port}`,
    "X-CSRF-Token": browser.csrfToken,
    "Content-Type": "application/json",
  };
  const code = (await service.request({ operation: "generate-code" })).code!.value;
  const paired = await fetch(`http://127.0.0.1:${port}/api/web/v1/pair`, {
    method: "POST",
    headers,
    body: JSON.stringify({ code, name: "Test browser" }),
  });
  expect((await paired.json()).status).toBe("approved");
  return headers;
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
  dir = await mkdtemp(join(tmpdir(), "agentkib-remote-enable-"));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  service = new WebAccessService({
    dataDir: dir,
    staticDir: dir,
    runtimeRequest: async () => ({}),
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
    expect(relays[0].options.inviteCode).toBe("test-invite");
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
  it("refuses account-owned remote enable without an account bridge", async () => {
    await saveIdentity({ accountId: "owner" });
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
});
