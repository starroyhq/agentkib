// @vitest-environment node
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBridge, type ClaudeBridgeTarget } from "../../../packages/backend/src/claude-bridge";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import { openManagedLedger } from "../../../packages/backend/src/managed-ledger";
import { CLAUDE_BRIDGE_COMPATIBILITY, type ClaudeBridgeSnapshot } from "@agentkib/runtime-protocol";
import { createConversationState, reduceSessionStreamEvent } from "@agentkib/conversation-state";
import { register as registerPlugin } from "../../../packages/claude-bridge-plugin/hooks/register.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(timeout = 1000) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-bridge-test-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const target: ClaudeBridgeTarget = {
    sessionId: "indexed-session",
    nativeId: randomUUID(),
    workspaceId: "workspace",
    workspace,
    registeredWorkspace: workspace,
  };
  const publish = vi.fn();
  let valid = true;
  const options = {
    dataDir: path.join(root, "data"),
    bootId: randomUUID(),
    pluginDirectory: path.join(root, "plugin"),
    platform: "darwin" as const,
    commandTimeoutMs: timeout,
    publish,
    target: async (id: string, nativeId?: string) => {
      if (!valid || id !== target.sessionId || (nativeId && nativeId !== target.nativeId))
        throw new Error("source unavailable");
      return { ...target };
    },
    validate: () => {
      if (!valid) throw new Error("source unavailable");
    },
  };
  let bridge = new ClaudeBridge(options);
  cleanups.push(async () => {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  });
  const manage = (operation: string) =>
    bridge.management({ operation, sessionId: target.sessionId, deviceId: "agentkib-local-owner" });
  const challenge = (await manage("bridge-challenge")) as { challenge: string; expiresAt: string };
  const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
  const instanceId = randomUUID();
  const hello = {
    protocol: 1,
    nativeId: target.nativeId,
    cwd: workspace,
    cliVersion: "2.1.301",
    instanceId,
    pluginVersion: "0.3.1",
    nativeCapabilities: {
      version: 1 as const,
      available: [
        "session-identity",
        "session-messages",
        "session-usage",
        "credential-store",
        "credential-read",
      ],
    },
  };
  function http(
    url: string,
    value: unknown,
    token?: string,
  ): Promise<{ status: number; body: Record<string, any> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: ticket.socketPath,
          path: url,
          method: "POST",
          headers: {
            Host: "localhost",
            "Content-Type": "application/json",
            Connection: "close",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.on("end", () =>
            resolve({
              status: response.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(value));
    });
  }
  const pair = await http("/v1/pair", { ...hello, ticket: ticket.ticket });
  expect(pair.status).toBe(200);
  let connection = pair.body;
  const lease = () => ({
    bindingId: connection.bindingId,
    leaseId: connection.leaseId,
    nativeId: target.nativeId,
    cwd: workspace,
    instanceId,
  });
  const post = (url: string, value: object) =>
    http(url, { ...lease(), ...value }, connection.token);
  let seq = 0;
  const snapshot: ClaudeBridgeSnapshot = {
    ...hello,
    cliVersion: "2.1.301",
    pluginVersion: "0.3.1",
    nativeCapabilities: {
      version: 1 as const,
      available: [
        "session-identity",
        "session-messages",
        "session-usage",
        "credential-store",
        "credential-read",
      ],
    },
    revision: 0,
    currentTurnId: null,
    status: "idle",
    waiting: null,
    messages: [],
    toolItems: [],
    streamText: "",
    usage: null,
    capabilities: { read: true, send: true, stop: true, approve: false, answer: false },
  };
  const events = (...entries: unknown[]) =>
    post("/v1/events", { events: entries.map((event) => ({ seq: ++seq, event })) });
  expect((await events({ type: "snapshot", snapshot })).status).toBe(200);
  const live = () => bridge.live(target.sessionId, true);
  const control = (operation = "send", extra: object = {}) => ({
    operation,
    sessionId: target.sessionId,
    requestId: randomUUID(),
    deviceId: "browser-a",
    runtimeBootId: options.bootId,
    expectedRevision: live().revision,
    experimentalEnabled: true,
    ...(operation === "send" ? { text: "synthetic message" } : { turnId: live().turnId }),
    ...extra,
  });
  const poll = () => post("/v1/commands", { afterCommandId: null, waitMs: 0 });
  const reconnectFailure = {
    protocol: 1,
    pluginVersion: "0.3.1",
    bindingId: connection.bindingId,
    nativeId: target.nativeId,
    cwd: workspace,
    instanceId,
    connectionError: "bridge-capabilities-missing",
    cliVersion: "2.1.307",
    missingCapabilities: ["session-messages"],
  };
  return {
    root,
    target,
    options,
    publish,
    ticket,
    hello,
    snapshot,
    http,
    post,
    events,
    live,
    control,
    poll,
    reconnectFailure,
    manage,
    get bridge() {
      return bridge;
    },
    get connection() {
      return connection;
    },
    invalidate: () => {
      valid = false;
    },
    async reconnect() {
      const response = await http(
        "/v1/reconnect",
        { ...hello, bindingId: connection.bindingId },
        connection.token,
      );
      expect(response.status).toBe(200);
      connection = response.body;
      seq = 0;
      return response;
    },
    async restart(reconnect = true) {
      await bridge.close();
      bridge = new ClaudeBridge(options);
      bridge.initialize();
      if (!reconnect) return;
      await expect.poll(() => existsSync(ticket.socketPath)).toBe(true);
      await this.reconnect();
    },
  };
}

describe.skipIf(process.platform === "win32")("native Claude borrowed-host broker", () => {
  it("recovers actual production-hook overflow through the real broker without losing turn identity", async () => {
    const f = await fixture();
    await f.manage("bridge-disconnect");
    const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
    type Hook = (api: any, event: any, next: (event: any) => any) => any;
    const hooks = new Map<string, Array<{ match: Record<string, unknown>; hook: Hook }>>();
    const timers: Array<() => Promise<void>> = [];
    const statuses: number[] = [];
    registerPlugin((name: string, matcher: Hook | Record<string, unknown>, handler?: Hook) => {
      const hook = typeof matcher === "function" ? matcher : handler!;
      hooks.set(name, [
        ...(hooks.get(name) ?? []),
        { match: typeof matcher === "function" ? {} : matcher, hook },
      ]);
      return { catch() {} };
    });
    const store = new Map<string, unknown>();
    const api = {
      plugin: { root: "/synthetic/plugin" },
      fs: { read: async () => JSON.stringify({ version: "0.3.1" }) },
      session: {
        id: async () => f.target.nativeId,
        cwd: async () => f.target.workspace,
        version: async () => ({ version: "2.1.301" }),
        messages: async () => [],
        usage: async () => null,
      },
      command: { register: async () => undefined },
      store: {
        get: async (key: string) => store.get(key),
        set: async (key: string, value: unknown) => {
          store.set(key, value);
        },
      },
      clock: { every: (_ms: number, callback: () => Promise<void>) => timers.push(callback) },
      http: {
        fetch: async (url: string, init: any) => {
          const response = await f.http(
            new URL(url).pathname,
            JSON.parse(init.body),
            init.headers.Authorization?.replace(/^Bearer /, ""),
          );
          statuses.push(response.status);
          return {
            ok: response.status === 200,
            status: response.status,
            text: JSON.stringify(response.body),
          };
        },
      },
    };
    const run = (name: string, event: any, bottom: (value: any) => any = (value) => value): any => {
      const rows = (hooks.get(name) ?? []).filter(({ match }) =>
        Object.entries(match).every(([key, value]) => event[key] === value),
      );
      const visit = (index: number, value: any): any =>
        index === rows.length
          ? bottom(value)
          : rows[index].hook(api, value, (next) => visit(index + 1, next));
      return visit(0, event);
    };
    await run("session.start", {
      cwd: f.target.workspace,
      isInteractive: true,
      surface: "terminal",
    });
    await run("ui.render", { component: "AbovePrompt", props: { isWorking: false } });
    await run("command.run", { command: "agentkib-connect", args: prepared.challenge });
    const turnId = randomUUID();
    await run("turn.start", { turnId, text: "original terminal input" });
    await timers[0]!();
    expect(f.live()).toMatchObject({ turnId, stopEnabled: true, sendEnabled: false });
    const stream = run("turn.step", { turnId, index: 0 }, async function* () {
      for (let index = 0; index < 300; index++) yield { kind: "text", text: `chunk-${index} ` };
      return { answer: "done" };
    });
    for await (const _chunk of stream) {
      /* Consume native chunks without ticking the network. */
    }
    f.publish.mockClear();
    for (let index = 0; index < 12; index++) await timers[0]!();
    expect(statuses.every((status) => status === 200)).toBe(true);
    expect(
      f.publish.mock.calls.some(
        ([, , , live]) => live.reason === "claude-bridge-event-gap" && live.stopEnabled === false,
      ),
    ).toBe(true);
    expect(f.live()).toMatchObject({ turnId, status: "running", stopEnabled: true });
    expect(String(f.live().streamText)).toContain("chunk-299");
    await run("turn.complete", { turnId, answer: "done", isAborted: false });
    await timers[0]!();
    expect(f.live()).toMatchObject({ turnId: null, status: "idle", stopEnabled: false });
  });
  it("reclaims revoked resolved bindings instead of exhausting a lifetime connection limit", async () => {
    const f = await fixture();
    for (let i = 0; i < 65; i++) {
      await f.manage("bridge-disconnect");
      f.target.sessionId = `indexed-session-${i}`;
      f.target.nativeId = randomUUID();
      const challenge = (await f.manage("bridge-challenge")) as { challenge: string };
      const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
      const pair = await f.http("/v1/pair", {
        ...f.hello,
        nativeId: f.target.nativeId,
        ticket: ticket.ticket,
      });
      expect(pair.status).toBe(200);
    }
    const registry = JSON.parse(
      readFileSync(path.join(f.root, "data/claude-bridge/bindings-v1.json"), "utf8"),
    );
    expect(registry.bindings).toHaveLength(1);
  });

  it("restores private permissions before loading an existing credential registry", async () => {
    const f = await fixture();
    const root = path.join(f.root, "data/claude-bridge");
    const file = path.join(root, "bindings-v1.json");
    chmodSync(root, 0o755);
    chmodSync(file, 0o644);
    await f.restart();
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("binds the selected native identity and stores credentials only in private files", async () => {
    const f = await fixture();
    expect(f.live()).toMatchObject({
      executionMode: "claude-follower",
      executionLocation: "terminal",
      ownershipReason: null,
      status: "idle",
      sendEnabled: true,
    });
    expect(statSync(f.ticket.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(f.connection.credentialPath).mode & 0o777).toBe(0o600);
    const status = await f.manage("bridge-status");
    expect(JSON.stringify(status)).not.toContain(f.connection.token);
    expect(status).toMatchObject({ supported: true, connected: true, hasBinding: true });
    expect(JSON.stringify(status)).not.toContain(f.connection.bindingId);
    expect(JSON.stringify(status)).not.toContain(f.connection.credentialPath);
    expect((status as { installInstructions: string }).installInstructions).toContain(
      "claude plugin update agentkib-bridge@agentkib-local",
    );
  });
  it("retains a verified binding after terminal exit and broker restart before the first snapshot", async () => {
    const f = await fixture();
    await f.events({ type: "invalidated", reason: "synthetic-terminal-exit", revision: 1 });
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: true });
    expect(f.live()).toMatchObject({ sendEnabled: false, stopEnabled: false });
    await f.restart(false);
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: true });
    await expect.poll(() => existsSync(f.ticket.socketPath)).toBe(true);
    await f.reconnect();
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: true });
    await f.events({ type: "snapshot", snapshot: f.snapshot });
    expect(await f.manage("bridge-status")).toMatchObject({ connected: true, hasBinding: true });
  });
  it("keeps an expired lease recoverable without granting control", async () => {
    const f = await fixture();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 35_001);
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: true });
    expect(f.live()).toMatchObject({ sendEnabled: false, stopEnabled: false });
    expect(f.bridge.blocksManagedResume(f.target.sessionId)).toBe(false);
  });
  it("persists revocation of an offline binding and rejects its saved credential", async () => {
    const f = await fixture();
    await f.events({ type: "invalidated", reason: "synthetic-terminal-exit", revision: 1 });
    await f.manage("bridge-disconnect");
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
    expect(existsSync(f.connection.credentialPath)).toBe(false);
    expect(
      await f.http(
        "/v1/reconnect",
        { ...f.hello, bindingId: f.connection.bindingId },
        f.connection.token,
      ),
    ).toMatchObject({ status: 410, body: { error: "bridge-binding-revoked" } });
    await f.restart(false);
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
  });
  it("does not infer a binding from pending, rejected or expired connection codes", async () => {
    const f = await fixture();
    f.target.sessionId = "unbound-session";
    f.target.nativeId = randomUUID();
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
    const challenge = (await f.manage("bridge-challenge")) as {
      challenge: string;
      expiresAt: string;
    };
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
    const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
    expect(
      await f.http("/v1/pair", {
        ticket: ticket.ticket,
        connectionError: "unsupported-native-identity",
      }),
    ).toMatchObject({ status: 409 });
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(challenge.expiresAt) + 1);
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
  });
  it.each(["sessionId", "nativeId", "workspaceId", "workspace", "registeredWorkspace"] as const)(
    "does not report a binding when the current %s no longer matches its identity",
    async (field) => {
      const f = await fixture();
      vi.spyOn(f.options, "target").mockResolvedValue({
        ...f.target,
        [field]: `${f.target[field]}-changed`,
      });
      expect(await f.manage("bridge-status")).toMatchObject({
        connected: false,
        hasBinding: false,
      });
    },
  );
  it("requires validation of the original binding as well as the current target", async () => {
    const f = await fixture();
    const validate = vi.spyOn(f.options, "validate").mockImplementation((...args: unknown[]) => {
      if (args[2]) throw new Error("binding-source-unavailable");
    });
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: false });
    expect(validate).toHaveBeenCalledWith(f.target, false, f.connection.bindingId);
  });
  it("preserves current-target permission failures instead of reporting a usable binding", async () => {
    const f = await fixture();
    vi.spyOn(f.options, "validate").mockImplementation(() => {
      throw new Error("session-index-disabled");
    });
    await expect(f.manage("bridge-status")).rejects.toThrow("session-index-disabled");
  });
  it("reports no verified binding when the session or registry cannot be validated", async () => {
    const f = await fixture();
    f.invalidate();
    expect(await f.manage("bridge-status")).toMatchObject({
      connected: false,
      hasBinding: false,
      reason: "claude-bridge-session-unavailable",
    });
    await f.bridge.close();
    const registry = path.join(f.root, "data/claude-bridge/bindings-v1.json");
    writeFileSync(registry, "{invalid synthetic registry");
    await f.restart(false);
    expect(await f.manage("bridge-status")).toMatchObject({
      connected: false,
      hasBinding: false,
      reason: "claude-bridge-registry-invalid",
    });
    expect(readFileSync(registry, "utf8")).toBe("{invalid synthetic registry");
  });
  it.each(["linux", "win32"] as const)(
    "does not report a recoverable binding on %s",
    async (platform) => {
      const f = await fixture();
      await f.bridge.close();
      const unsupported = new ClaudeBridge({ ...f.options, platform });
      cleanups.push(() => unsupported.close());
      expect(
        await unsupported.management({
          operation: "bridge-status",
          sessionId: f.target.sessionId,
          deviceId: "agentkib-local-owner",
        }),
      ).toMatchObject({
        supported: false,
        connected: false,
        hasBinding: false,
        reason: "platform-unsupported",
      });
    },
  );
  it("reports unverified native send without disabling the separately verified current-turn cancel", async () => {
    const f = await fixture();
    await f.events({
      type: "snapshot",
      snapshot: { ...f.snapshot, capabilities: { ...f.snapshot.capabilities, send: false } },
    });
    expect(f.live()).toMatchObject({
      sendEnabled: false,
      status: "idle",
      reason: "claude-follower-send-unverified",
    });
    const capabilities = f.bridge.capabilities(f.target.sessionId, true) as any;
    expect(capabilities.features.send).toEqual({
      available: false,
      reason: "claude-follower-send-unverified",
    });
    await expect(f.bridge.request(f.control())).rejects.toThrow();
    await f.events({
      type: "snapshot",
      snapshot: {
        ...f.snapshot,
        revision: 1,
        status: "running",
        currentTurnId: randomUUID(),
        capabilities: { ...f.snapshot.capabilities, send: false },
      },
    });
    expect(f.live()).toMatchObject({ sendEnabled: false, stopEnabled: true, status: "running" });
  });
  it.each(["2.1.301", "2.1.307", "2.2.0", "3.0.0"])(
    "checks capabilities and retains actual CLI %s across pairing and reconnect",
    async (cliVersion) => {
      const f = await fixture();
      await f.manage("bridge-disconnect");
      const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
      const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
      const hello = { ...f.hello, cliVersion };
      const paired = await f.http("/v1/pair", { ...hello, ticket: ticket.ticket });
      expect(paired.status).toBe(200);
      const credential = JSON.parse(readFileSync(paired.body.credentialPath, "utf8"));
      expect(credential.cliVersion).toBe(cliVersion);
      const compatibility = {
        cliVersion,
        status: CLAUDE_BRIDGE_COMPATIBILITY.verifiedCliVersions.includes(cliVersion)
          ? "verified"
          : "unverified",
      };
      expect(await f.manage("bridge-status")).toMatchObject({ bridgeCompatibility: compatibility });
      const reconnect = await f.http(
        "/v1/reconnect",
        { ...hello, bindingId: paired.body.bindingId },
        paired.body.token,
      );
      expect(reconnect.status).toBe(200);
      expect(reconnect.body.leaseId).not.toBe(paired.body.leaseId);
      expect(f.live()).toMatchObject({
        cliVersion: `${cliVersion} (Claude Code)`,
        bridgeCompatibility: compatibility,
      });
    },
  );
  it.each([
    "session-identity",
    "session-messages",
    "session-usage",
    "credential-store",
    "credential-read",
  ])("refuses missing %s on pairing and authenticated reconnect", async (missing) => {
    const f = await fixture();
    const fields = {
      nativeCapabilities: {
        version: 1,
        available: f.hello.nativeCapabilities.available.filter((name) => name !== missing),
      },
    };
    const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
    const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
    expect(
      await f.http("/v1/pair", { ...f.hello, ...fields, ticket: ticket.ticket }),
    ).toMatchObject({
      status: 409,
      body: {
        error: "bridge-capabilities-missing",
        missingCapabilities: [missing],
        cliVersion: "2.1.301",
      },
    });
    expect(await f.manage("bridge-status")).toMatchObject({
      connectionError: "bridge-capabilities-missing",
      connectionCliVersion: "2.1.301",
      connectionMissingCapabilities: [missing],
    });
    expect(
      await f.http(
        "/v1/reconnect",
        { ...f.hello, ...fields, bindingId: f.connection.bindingId },
        f.connection.token,
      ),
    ).toMatchObject({ status: 409, body: { error: "bridge-capabilities-missing" } });
    // A failed compatibility attempt cannot consume a still-current code or replace a live lease.
    expect(f.live().connectionGeneration).toBe(f.connection.leaseId);
    expect((await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).status).toBe(200);
  });
  it.each([
    [{ cliVersion: "2.1.300" }, "bridge-cli-too-old"],
    [{ cliVersion: "2.1.307-preview" }, "bridge-cli-unsupported"],
    [{ pluginVersion: "0.1.0" }, "bridge-plugin-update-required"],
    [{ protocol: 2 }, "bridge-plugin-update-required"],
    [{ nativeCapabilities: undefined }, "bridge-capabilities-missing"],
  ])(
    "rejects incompatible native metadata without weakening the current binding",
    async (fields, reason) => {
      const f = await fixture();
      const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
      const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
      expect(
        await f.http("/v1/pair", { ...f.hello, ...fields, ticket: ticket.ticket }),
      ).toMatchObject({ status: 409, body: { error: reason } });
      expect(f.live().connectionGeneration).toBe(f.connection.leaseId);
      expect((await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).status).toBe(200);
    },
  );
  it("consumes the challenge and refuses mismatched session, cwd and version", async () => {
    const f = await fixture();
    expect((await f.http("/v1/pair", { ...f.hello, ticket: f.ticket.ticket })).status).toBe(409);
    for (const fields of [{ nativeId: randomUUID() }, { cwd: f.root }, { cliVersion: "2.1.300" }]) {
      const challenge = (await f.manage("bridge-challenge")) as { challenge: string };
      const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
      expect(
        (await f.http("/v1/pair", { ...f.hello, ...fields, ticket: ticket.ticket })).status,
      ).toBe(409);
    }
  });
  it.each([
    { cliVersion: "2.1.307" },
    { pluginVersion: "0.1.0" },
    { nativeCapabilities: { version: 1, available: ["session-identity"] } },
  ])("rejects snapshot metadata that was not negotiated by the current lease", async (fields) => {
    const f = await fixture();
    expect(
      (await f.events({ type: "snapshot", snapshot: { ...f.snapshot, ...fields, revision: 1 } }))
        .status,
    ).toBe(409);
    expect(f.live().cliVersion).toBe("2.1.301 (Claude Code)");
    expect(f.live().connectionGeneration).toBe(f.connection.leaseId);
    expect(f.live().revision).toBeGreaterThanOrEqual(0);
  });
  it("explicitly clears public compatibility when a source is invalid or disconnected", async () => {
    const f = await fixture();
    expect(f.live().bridgeCompatibility).toEqual({ cliVersion: "2.1.301", status: "verified" });
    await f.manage("bridge-disconnect");
    expect(f.live().bridgeCompatibility).toBeNull();
    expect(await f.manage("bridge-status")).toHaveProperty("bridgeCompatibility", null);
    f.invalidate();
    expect(f.live().bridgeCompatibility).toBeNull();
    const active = await fixture();
    active.invalidate();
    expect(active.live().bridgeCompatibility).toBeNull();
  });
  it.each([
    ["bridge-cli-too-old", "2.1.300"],
    ["bridge-cli-unsupported", undefined],
    ["bridge-capabilities-missing", "2.1.307"],
    ["bridge-plugin-update-required", "2.1.307"],
  ])(
    "reports authenticated offline reconnect failure %s without granting a lease",
    async (reason, cliVersion) => {
      const f = await fixture();
      expect(f.live()).toHaveProperty("bridgeConnectionFailure", null);
      await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
      const report = { ...f.reconnectFailure, connectionError: reason, cliVersion };
      expect(await f.http("/v1/reconnect", report, f.connection.token)).toEqual({
        status: 200,
        body: { reported: true },
      });
      const failure = { reason, cliVersion, missingCapabilities: ["session-messages"] };
      expect(f.live()).toMatchObject({
        reason,
        bridgeConnectionFailure: failure,
        status: "unsupported",
        sendEnabled: false,
        stopEnabled: false,
      });
      expect(await f.manage("bridge-status")).toMatchObject({
        connected: false,
        connectionError: reason,
        connectionCliVersion: cliVersion,
        connectionMissingCapabilities: ["session-messages"],
      });
      expect((await f.post("/v1/events", { events: [] })).status).toBe(409);
    },
  );
  it.each([
    [{}, undefined, 401],
    [{}, "0".repeat(64), 401],
    [{ bindingId: randomUUID() }, "correct", 401],
    [{ nativeId: randomUUID() }, "correct", 409],
    [{ cwd: "/synthetic/other-workspace" }, "correct", 409],
  ] as const)(
    "rejects unauthenticated or mismatched reconnect failure %j",
    async (fields, token, status) => {
      const f = await fixture();
      await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
      expect(
        await f.http(
          "/v1/reconnect",
          { ...f.reconnectFailure, ...fields },
          token === "correct" ? f.connection.token : token,
        ),
      ).toMatchObject({ status });
      expect(f.live()).toHaveProperty("bridgeConnectionFailure", null);
      expect(await f.manage("bridge-status")).not.toHaveProperty(
        "connectionError",
        expect.any(String),
      );
    },
  );
  it.each(["revoked", "invalid-source"] as const)(
    "rejects reconnect failure for %s bindings",
    async (state) => {
      const f = await fixture();
      await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
      if (state === "revoked") await f.manage("bridge-disconnect");
      else f.invalidate();
      expect(await f.http("/v1/reconnect", f.reconnectFailure, f.connection.token)).toMatchObject({
        status: 410,
      });
      expect(f.live()).toHaveProperty("bridgeConnectionFailure", null);
      if (state === "invalid-source")
        expect(f.live().reason).toBe("claude-bridge-session-unavailable");
    },
  );
  it.each([
    { protocol: 2 },
    { pluginVersion: "0.1.0" },
    { instanceId: "not-a-uuid" },
    { cliVersion: "2.1.307-beta" },
    { missingCapabilities: ["private-unknown-capability"] },
    { connectionError: "native-identity-changed" },
    { token: "untrusted-extra-field" },
  ])("rejects malformed reconnect failure reports %j", async (fields) => {
    const f = await fixture();
    await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
    expect(
      await f.http("/v1/reconnect", { ...f.reconnectFailure, ...fields }, f.connection.token),
    ).toMatchObject({ status: 409 });
    expect(f.live()).toHaveProperty("bridgeConnectionFailure", null);
  });
  it("ignores late reconnect failures while a current lease or manual connection code owns the session", async () => {
    const f = await fixture();
    expect(await f.http("/v1/reconnect", f.reconnectFailure, f.connection.token)).toEqual({
      status: 200,
      body: { reported: false },
    });
    expect(f.live().connectionGeneration).toBe(f.connection.leaseId);
    expect(f.live()).toHaveProperty("bridgeConnectionFailure", null);
    expect((await f.post("/v1/events", { events: [] })).status).toBe(200);
    await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
    const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
    expect(await f.http("/v1/reconnect", f.reconnectFailure, f.connection.token)).toEqual({
      status: 200,
      body: { reported: false },
    });
    expect(await f.manage("bridge-status")).not.toHaveProperty(
      "connectionError",
      expect.any(String),
    );
    const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
    expect((await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).status).toBe(200);
    expect(await f.http("/v1/reconnect", f.reconnectFailure, f.connection.token)).toMatchObject({
      status: 401,
    });
    expect(f.live()).toHaveProperty("bridgeConnectionFailure", null);
  });
  it.each(["pair", "reconnect"] as const)(
    "clears authenticated failure feedback after successful %s",
    async (operation) => {
      const f = await fixture();
      await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
      expect((await f.http("/v1/reconnect", f.reconnectFailure, f.connection.token)).body).toEqual({
        reported: true,
      });
      if (operation === "reconnect") await f.reconnect();
      else {
        const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
        const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
        expect((await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).status).toBe(200);
      }
      expect(f.live()).toHaveProperty("bridgeConnectionFailure", null);
      expect(await f.manage("bridge-status")).not.toHaveProperty(
        "connectionError",
        expect.any(String),
      );
    },
  );
  it("keeps repeated authenticated reconnect failure reports idempotent", async () => {
    const f = await fixture();
    await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
    const report = () => f.http("/v1/reconnect", f.reconnectFailure, f.connection.token);
    expect((await report()).body).toEqual({ reported: true });
    const revision = f.live().revision;
    const publications = f.publish.mock.calls.length;
    expect((await report()).body).toEqual({ reported: true });
    expect(f.live().revision).toBe(revision);
    expect(f.publish).toHaveBeenCalledTimes(publications);
  });
  it("keeps binding feedback when an unrelated challenge cleans up an expired code", async () => {
    const f = await fixture();
    await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
    const prepared = (await f.manage("bridge-challenge")) as { expiresAt: string };
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(prepared.expiresAt) + 300_001);
    expect((await f.http("/v1/reconnect", f.reconnectFailure, f.connection.token)).body).toEqual({
      reported: true,
    });
    vi.spyOn(f.options, "target").mockResolvedValue({ ...f.target, sessionId: "other-session" });
    await f.bridge.management({
      operation: "bridge-challenge",
      sessionId: "other-session",
      deviceId: "agentkib-local-owner",
    });
    expect(f.live()).toMatchObject({
      bridgeConnectionFailure: { reason: "bridge-capabilities-missing" },
    });
  });
  it("keeps unknown outcomes and invalid sources ahead of authenticated compatibility feedback", async () => {
    const f = await fixture();
    const pending = f.bridge.request(f.control());
    expect((await f.poll()).body.commands).toHaveLength(1);
    await f.events({ type: "invalidated", reason: "synthetic-offline", revision: 1 });
    expect(await pending).toMatchObject({ controlOutcome: "unknown" });
    expect((await f.http("/v1/reconnect", f.reconnectFailure, f.connection.token)).body).toEqual({
      reported: true,
    });
    expect(f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      status: "outcome-unknown",
      sendEnabled: false,
      stopEnabled: false,
    });
    f.invalidate();
    expect(f.live()).toMatchObject({
      reason: "claude-bridge-session-unavailable",
      bridgeConnectionFailure: null,
      sendEnabled: false,
      stopEnabled: false,
    });
  });
  it("reports expired connection codes to the desktop and clears the failure for a new code", async () => {
    const f = await fixture();
    await f.manage("bridge-disconnect");
    const prepared = (await f.manage("bridge-challenge")) as {
      challenge: string;
      expiresAt: string;
    };
    const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(prepared.expiresAt) + 1);
    expect(await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).toMatchObject({
      status: 409,
      body: { error: "expired-bridge-challenge" },
    });
    expect(await f.manage("bridge-status")).toMatchObject({
      connectionError: "expired-bridge-challenge",
      connected: false,
    });
    await f.manage("bridge-challenge");
    expect(await f.manage("bridge-status")).not.toHaveProperty(
      "connectionError",
      expect.any(String),
    );
  });
  it.each(["replaced", "revoked", "paired"] as const)(
    "ignores a pending pair failure after its connection code was %s",
    async (transition) => {
      const f = await fixture();
      await f.manage("bridge-disconnect");
      const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
      const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
      const target = f.options.target;
      let entered!: () => void;
      let resume!: () => void;
      const paused = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let held = false;
      vi.spyOn(f.options, "target").mockImplementation(async (id, nativeId) => {
        if (nativeId && !held) {
          held = true;
          entered();
          await paused;
        }
        return target(id, nativeId);
      });
      const previousPair = f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket });
      await started;
      try {
        if (transition === "revoked") await f.manage("bridge-disconnect");
        else {
          const next = (await f.manage("bridge-challenge")) as { challenge: string };
          if (transition === "paired") {
            const current = JSON.parse(Buffer.from(next.challenge, "base64url").toString());
            expect((await f.http("/v1/pair", { ...f.hello, ticket: current.ticket })).status).toBe(
              200,
            );
          }
        }
      } finally {
        resume();
      }
      expect(await previousPair).toMatchObject({
        status: 409,
        body: { error: "invalid-bridge-challenge" },
      });
      expect(await f.manage("bridge-status")).not.toHaveProperty(
        "connectionError",
        expect.any(String),
      );
    },
  );
  it.each([
    [{ cliVersion: "2.1.300" }, "bridge-cli-too-old"],
    [{ cwd: "/another/workspace" }, "bridge-identity-mismatch"],
  ])(
    "explains failed identity validation without granting a connection",
    async (fields, reason) => {
      const f = await fixture();
      await f.manage("bridge-disconnect");
      const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
      const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
      expect(
        await f.http("/v1/pair", { ...f.hello, ...fields, ticket: ticket.ticket }),
      ).toMatchObject({ status: 409, body: { error: reason } });
      expect(await f.manage("bridge-status")).toMatchObject({
        connected: false,
        connectionError: reason,
      });
      expect((await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).status).toBe(200);
      expect(await f.manage("bridge-status")).not.toHaveProperty(
        "connectionError",
        expect.any(String),
      );
    },
  );
  it("accepts only bounded native failure reports possessing a current connection code", async () => {
    const f = await fixture();
    await f.manage("bridge-disconnect");
    const prepared = (await f.manage("bridge-challenge")) as { challenge: string };
    const ticket = JSON.parse(Buffer.from(prepared.challenge, "base64url").toString());
    expect(
      await f.http("/v1/pair", {
        ticket: "a".repeat(64),
        connectionError: "bridge-version-mismatch",
      }),
    ).toMatchObject({ status: 409 });
    expect(await f.manage("bridge-status")).not.toHaveProperty(
      "connectionError",
      expect.any(String),
    );
    expect(
      await f.http("/v1/pair", {
        ticket: ticket.ticket,
        connectionError: "bridge-version-mismatch",
      }),
    ).toMatchObject({ status: 409 });
    expect(await f.manage("bridge-status")).toMatchObject({
      connected: false,
      connectionError: "bridge-plugin-update-required",
    });
    await f.manage("bridge-disconnect");
    expect(await f.manage("bridge-status")).not.toHaveProperty(
      "connectionError",
      expect.any(String),
    );
  });
  it("disconnect also revokes unused reconnect challenges and old credentials", async () => {
    const f = await fixture();
    const challenge = (await f.manage("bridge-challenge")) as { challenge: string };
    const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
    await f.manage("bridge-disconnect");
    expect((await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).status).toBe(409);
    expect(
      (
        await f.http(
          "/v1/reconnect",
          { ...f.hello, bindingId: f.connection.bindingId },
          f.connection.token,
        )
      ).status,
    ).toBe(410);
    expect(existsSync(f.connection.credentialPath)).toBe(false);
  });
  it("rejects wrong token, lease and per-request identity", async () => {
    const f = await fixture();
    for (const fields of [
      { leaseId: randomUUID() },
      { cwd: f.root },
      { nativeId: randomUUID() },
      { instanceId: randomUUID() },
    ])
      expect((await f.post("/v1/events", { ...fields, events: [] })).status).toBe(410);
    expect(
      (
        await f.http(
          "/v1/reconnect",
          { ...f.hello, bindingId: f.connection.bindingId },
          "0".repeat(64),
        )
      ).status,
    ).toBe(401);
  });
  it("dispatches at most once and returns an identical persistent receipt", async () => {
    const f = await fixture();
    const input = f.control();
    const result = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0];
    expect(command).toMatchObject({ kind: "send", requestId: input.requestId, text: input.text });
    expect((await f.poll()).body.commands).toEqual([]);
    const turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 1,
      turnId,
    });
    const accepted = await result;
    expect(accepted).toMatchObject({ accepted: true, completed: false });
    expect(await f.bridge.request(input)).toEqual(accepted);
    expect((await f.poll()).body.commands).toEqual([]);
    await expect(f.bridge.request({ ...input, text: "different" })).rejects.toThrow(
      "request-id-reused",
    );
    await f.events({ type: "turn-complete", turnId, revision: 2, text: "reply", aborted: false });
    const invalidation = f.publish.mock.calls.find(([, type]) => type === "invalidate")!;
    const base = {
      protocolVersion: 2 as const,
      sessionId: f.target.sessionId,
      subscriptionId: "subscription",
      runtimeBootId: f.options.bootId,
      epoch: "epoch",
      cursor: "cursor",
    };
    const baseline = reduceSessionStreamEvent(createConversationState(f.target.sessionId), {
      ...base,
      seq: 0,
      type: "snapshot",
      payload: { live: f.live(), items: [] },
    });
    const state = reduceSessionStreamEvent(baseline, {
      ...base,
      seq: 1,
      type: "invalidate",
      payload: invalidation[2],
    });
    expect(state.invalidatedDomains).toEqual(["history", "catalog", "receipts"]);
    expect(
      f.bridge.receipt(
        readControlReceipt(f.options.dataDir, {
          requestId: input.requestId,
          deviceId: input.deviceId,
        }),
      ),
    ).toMatchObject({ status: "accepted", completionObserved: true });
    expect(f.live().sendEnabled).toBe(true);
  });
  it("handles completion before the send acknowledgement", async () => {
    const f = await fixture();
    const result = f.bridge.request(f.control());
    const command = (await f.poll()).body.commands[0],
      turnId = randomUUID();
    await f.events(
      { type: "turn-start", turnId, revision: 1 },
      { type: "turn-complete", turnId, revision: 2, text: "reply", aborted: false },
    );
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 2,
      turnId,
    });
    expect(await result).toMatchObject({ accepted: true, completed: true });
    expect(f.live().sendEnabled).toBe(true);
  });
  it("rejects a concurrent second send without queueing", async () => {
    const f = await fixture();
    const first = f.bridge.request(f.control());
    await expect(f.bridge.request(f.control())).rejects.toThrow("session-busy");
    await f.manage("bridge-disconnect");
    expect(await first).toMatchObject({ controlOutcome: "not-dispatched" });
  });
  it("keeps dispatched-but-unconfirmed commands unknown across restart and idle snapshots", async () => {
    const f = await fixture();
    const input = f.control();
    const first = f.bridge.request(input);
    expect((await f.poll()).body.commands).toHaveLength(1);
    await f.restart();
    expect(await first).toMatchObject({ controlOutcome: "unknown" });
    expect(await f.manage("bridge-status")).toMatchObject({ connected: false, hasBinding: true });
    await expect(f.manage("bridge-challenge")).rejects.toThrow("control-outcome-unconfirmed");
    await f.events({ type: "snapshot", snapshot: f.snapshot });
    expect(f.live()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
    expect(await f.bridge.request(input)).toMatchObject({ controlOutcome: "unknown" });
    expect((await f.poll()).body.commands).toEqual([]);
  });
  it("keeps accepted unfinished turns unknown when their completion was not observed", async () => {
    const f = await fixture();
    const input = f.control();
    const first = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0],
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 1,
      turnId,
    });
    await first;
    await f.restart();
    await f.events({ type: "snapshot", snapshot: f.snapshot });
    expect(f.live()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
    expect((await f.poll()).body.commands).toEqual([]);
  });
  it("times out before dispatch without claiming that a native action ran", async () => {
    const f = await fixture(30);
    const input = f.control();
    expect(await f.bridge.request(input)).toMatchObject({ controlOutcome: "not-dispatched" });
    expect(f.live().sendEnabled).toBe(true);
    expect((await f.poll()).body.commands).toEqual([]);
  });
  it("recovers only a matching late acknowledgement, without replay", async () => {
    const f = await fixture(30);
    const input = f.control();
    const first = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0];
    expect(await first).toMatchObject({ controlOutcome: "unknown" });
    const turnId = randomUUID();
    await f.events(
      { type: "turn-start", turnId, revision: 1 },
      { type: "turn-complete", turnId, revision: 2, text: "reply", aborted: false },
    );
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 2,
      turnId,
    });
    expect(await f.bridge.request(input)).toMatchObject({ accepted: true, completed: true });
  });
  it("requires the exact current turn to cancel and does not kill a host process", async () => {
    const f = await fixture();
    const turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    await expect(f.bridge.request(f.control("stop", { turnId: randomUUID() }))).rejects.toThrow(
      "stale-turn",
    );
    const result = f.bridge.request(f.control("stop"));
    const command = (await f.poll()).body.commands[0];
    expect(command).toMatchObject({ kind: "stop", turnId });
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 1,
      turnId,
    });
    expect(await result).toMatchObject({ accepted: true });
    await f.events({ type: "turn-complete", turnId, revision: 2, text: "", aborted: true });
    expect(f.live().status).toBe("idle");
  });
  it("persists an accepted stop completion without replacing its acknowledgement or dispatching again", async () => {
    const f = await fixture(),
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    const input = f.control("stop"),
      result = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0];
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 1,
      turnId,
    });
    const accepted = await result;
    expect(accepted).toMatchObject({ accepted: true, completed: false });
    const receipt = () =>
      f.bridge.receipt(
        readControlReceipt(f.options.dataDir, {
          requestId: input.requestId,
          deviceId: input.deviceId,
        }),
      );
    const identity = () => {
      const database = openManagedLedger(f.options.dataDir)!;
      try {
        return database
          .prepare(
            "SELECT session_id,fingerprint,evidence,device_id,claim_version FROM managed_commands WHERE request_id=?",
          )
          .get(input.requestId);
      } finally {
        database.close();
      }
    };
    const originalIdentity = identity();
    expect(receipt()).toMatchObject({ status: "accepted", completionObserved: false });
    await f.events({ type: "turn-complete", turnId, revision: 2, text: "", aborted: true });
    expect(receipt()).toMatchObject({ status: "accepted", completionObserved: true });
    const completed = { ...accepted, completed: true, completionObserved: true };
    expect(await f.bridge.request(input)).toEqual(completed);
    await f.events({ type: "turn-complete", turnId, revision: 2, text: "", aborted: true });
    expect(await f.bridge.request(input)).toEqual(completed);
    expect(identity()).toEqual(originalIdentity);
    expect((await f.poll()).body.commands).toEqual([]);
    await f.restart();
    await f.events({ type: "snapshot", snapshot: { ...f.snapshot, revision: 2 } });
    expect(receipt()).toMatchObject({ status: "accepted", completionObserved: true });
    expect(await f.bridge.request(input)).toEqual(completed);
    expect((await f.poll()).body.commands).toEqual([]);
  });
  it("retains an aborted completion arriving before the stop acknowledgement", async () => {
    const f = await fixture(),
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    const input = f.control("stop"),
      result = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0];
    await f.events({ type: "turn-complete", turnId, revision: 2, text: "", aborted: true });
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 2,
      turnId,
    });
    expect(await result).toMatchObject({ accepted: true, completed: true });
    expect(
      f.bridge.receipt(
        readControlReceipt(f.options.dataDir, {
          requestId: input.requestId,
          deviceId: input.deviceId,
        }),
      ),
    ).toMatchObject({ status: "accepted", completionObserved: true });
    expect((await f.poll()).body.commands).toEqual([]);
  });
  it.each(["before", "after"])(
    "does not treat a normal completion %s a stop acknowledgement as cancellation evidence",
    async (order) => {
      const f = await fixture(),
        turnId = randomUUID();
      await f.events({ type: "turn-start", turnId, revision: 1 });
      const input = f.control("stop"),
        result = f.bridge.request(input);
      const command = (await f.poll()).body.commands[0];
      const complete = () =>
        f.events({ type: "turn-complete", turnId, revision: 2, text: "done", aborted: false });
      if (order === "before") await complete();
      await f.post("/v1/results", {
        commandId: command.commandId,
        status: "accepted",
        revision: 2,
        turnId,
      });
      expect(await result).toMatchObject({ accepted: true, completed: false });
      if (order === "after") await complete();
      expect(
        f.bridge.receipt(
          readControlReceipt(f.options.dataDir, {
            requestId: input.requestId,
            deviceId: input.deviceId,
          }),
        ),
      ).toMatchObject({ status: "accepted", completionObserved: false });
      expect((await f.poll()).body.commands).toEqual([]);
    },
  );
  it("only completes a stop for the matching native identity and turn, including after restart", async () => {
    const f = await fixture(),
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    const input = f.control("stop"),
      result = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0];
    expect(
      (
        await f.post("/v1/results", {
          commandId: command.commandId,
          status: "accepted",
          revision: 1,
          turnId: randomUUID(),
        })
      ).status,
    ).toBe(409);
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 1,
      turnId,
    });
    await result;
    const receipt = () =>
      f.bridge.receipt(
        readControlReceipt(f.options.dataDir, {
          requestId: input.requestId,
          deviceId: input.deviceId,
        }),
      );
    await f.events({
      type: "turn-complete",
      turnId: randomUUID(),
      revision: 2,
      text: "",
      aborted: true,
    });
    expect(
      (
        await f.post("/v1/events", {
          nativeId: randomUUID(),
          events: [
            {
              seq: 3,
              event: { type: "turn-complete", turnId, revision: 2, text: "", aborted: true },
            },
          ],
        })
      ).status,
    ).toBe(410);
    expect(receipt()).toMatchObject({ status: "accepted", completionObserved: false });
    await f.restart();
    await f.events({ type: "turn-complete", turnId, revision: 2, text: "", aborted: true });
    expect(receipt()).toMatchObject({ status: "accepted", completionObserved: true });
    expect((await f.poll()).body.commands).toEqual([]);
  });
  it("does not use a new binding's aborted turn to complete an earlier binding's stop", async () => {
    const f = await fixture(),
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    const input = f.control("stop"),
      result = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0];
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 1,
      turnId,
    });
    await result;
    await f.manage("bridge-disconnect");
    const challenge = (await f.manage("bridge-challenge")) as { challenge: string };
    const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
    const paired = await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket });
    expect(paired.status).toBe(200);
    expect(paired.body.bindingId).not.toBe(f.connection.bindingId);
    expect(
      (
        await f.http(
          "/v1/events",
          {
            nativeId: f.target.nativeId,
            cwd: f.target.workspace,
            instanceId: f.hello.instanceId,
            bindingId: paired.body.bindingId,
            leaseId: paired.body.leaseId,
            events: [
              {
                seq: 1,
                event: { type: "turn-complete", turnId, revision: 2, text: "", aborted: true },
              },
            ],
          },
          paired.body.token,
        )
      ).status,
    ).toBe(200);
    expect(
      f.bridge.receipt(
        readControlReceipt(f.options.dataDir, {
          requestId: input.requestId,
          deviceId: input.deviceId,
        }),
      ),
    ).toMatchObject({ status: "accepted", completionObserved: false });
  });
  it("preserves terminal permission and question ownership", async () => {
    const f = await fixture();
    for (const waiting of ["permission", "question"] as const) {
      await f.events({
        type: "snapshot",
        snapshot: { ...f.snapshot, revision: 1, status: "waiting", waiting },
      });
      expect(f.live().sendEnabled).toBe(false);
      const caps = f.bridge.capabilities(f.target.sessionId, true) as Record<string, any>;
      expect(caps.features.approve.available).toBe(false);
      expect(caps.features.answer.available).toBe(false);
      await expect(
        f.bridge.request({
          ...f.control(),
          operation: waiting === "permission" ? "approve" : "answer",
        }),
      ).rejects.toThrow("operation-unavailable");
    }
  });
  it("does not accept attachment blocks or enable controls for a read-only caller", async () => {
    const f = await fixture();
    await expect(
      f.bridge.request(f.control("send", { text: undefined, input: [{ type: "image" }] })),
    ).rejects.toThrow("invalid-text");
    expect(f.bridge.live(f.target.sessionId, false).sendEnabled).toBe(false);
    await expect(
      f.bridge.request(f.control("send", { experimentalEnabled: false })),
    ).rejects.toThrow("control-unavailable");
  });
  it("hides cached text after source invalidation and rejects queued control", async () => {
    const f = await fixture();
    await f.events({ type: "snapshot", snapshot: { ...f.snapshot, streamText: "private marker" } });
    const first = f.bridge.request(f.control());
    f.invalidate();
    expect(f.live()).toMatchObject({
      sendEnabled: false,
      streamText: "",
      reason: "claude-bridge-session-unavailable",
    });
    expect((await f.poll()).status).toBe(410);
    await f.bridge.close();
    expect(await first).toMatchObject({ controlOutcome: "not-dispatched" });
  });
  it("marks an event gap until a verified replacement snapshot and ignores duplicates", async () => {
    const f = await fixture();
    expect(
      (
        await f.post("/v1/events", {
          events: [{ seq: 5, event: { type: "turn-start", turnId: randomUUID(), revision: 1 } }],
        })
      ).status,
    ).toBe(409);
    expect(f.live()).toMatchObject({ sendEnabled: false, reason: "claude-bridge-event-gap" });
    expect(
      (
        await f.post("/v1/events", {
          events: [{ seq: 6, event: { type: "snapshot", snapshot: f.snapshot } }],
        })
      ).status,
    ).toBe(200);
    const revision = f.live().revision;
    await f.post("/v1/events", {
      events: [{ seq: 6, event: { type: "snapshot", snapshot: f.snapshot } }],
    });
    expect(f.live().revision).toBe(revision);
    expect(f.live().sendEnabled).toBe(true);
  });
  it("fences queued controls on an explicit overflow gap until a replacement snapshot", async () => {
    const f = await fixture(),
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    const pending = f.bridge.request(f.control("stop"));
    const gap = await f.post("/v1/events", {
      events: [{ seq: 50, event: { type: "gap", revision: 1 } }],
    });
    expect(gap).toMatchObject({ status: 200, body: { ackSeq: 50 } });
    expect(await pending).toMatchObject({ controlOutcome: "not-dispatched" });
    expect(f.live()).toMatchObject({
      sendEnabled: false,
      stopEnabled: false,
      reason: "claude-bridge-event-gap",
    });
    expect((await f.poll()).body.commands).toEqual([]);
    expect(f.publish).toHaveBeenCalledWith(
      f.target.sessionId,
      "invalidate",
      { domains: ["history"] },
      expect.any(Object),
    );
    await f.post("/v1/events", {
      events: [
        {
          seq: 51,
          event: {
            type: "snapshot",
            snapshot: { ...f.snapshot, currentTurnId: turnId, status: "running", revision: 1 },
          },
        },
      ],
    });
    expect(f.live()).toMatchObject({ stopEnabled: true, status: "running" });
  });
  it("does not infer idle or confirmed approval waiting from incomplete native activity", async () => {
    const f = await fixture();
    await f.events({
      type: "snapshot",
      snapshot: {
        ...f.snapshot,
        status: "running",
        capabilities: { ...f.snapshot.capabilities, send: false, stop: false },
      },
    });
    expect(f.live()).toMatchObject({
      status: "running",
      turnId: null,
      stopEnabled: false,
      reason: "claude-follower-turn-unconfirmed",
    });
    await f.events({
      type: "snapshot",
      snapshot: {
        ...f.snapshot,
        status: "running",
        currentTurnId: randomUUID(),
        waiting: "unknown",
      },
    });
    expect(f.live()).toMatchObject({
      status: "running",
      reason: "claude-terminal-permission-unconfirmed",
    });
  });
  it("expires old leases and clears text when a plugin reloads", async () => {
    const f = await fixture();
    const old = f.connection.leaseId;
    await f.events({ type: "snapshot", snapshot: { ...f.snapshot, streamText: "old" } });
    await f.reconnect();
    expect(f.live().connectionGeneration).not.toBe(old);
    expect(f.live().streamText).toBe("");
    expect((await f.post("/v1/events", { leaseId: old, events: [] })).status).toBe(410);
    await f.events({ type: "snapshot", snapshot: f.snapshot });
    expect(f.live().sendEnabled).toBe(true);
  });
  it("does not block lightweight requests while a native command or long poll waits", async () => {
    const f = await fixture();
    const poll = f
      .post("/v1/commands", { afterCommandId: null, waitMs: 20_000 })
      .catch(() => ({ status: 0, body: {} }));
    const start = performance.now();
    expect(await f.manage("bridge-status")).toMatchObject({ connected: true });
    expect(performance.now() - start).toBeLessThan(1000);
    await f.bridge.close();
    await poll;
  });
  it.each(["bridge-status", "bridge-challenge", "bridge-disconnect"])(
    "checks the local owner before %s",
    async (operation) => {
      const f = await fixture();
      await expect(
        f.bridge.management({
          operation,
          sessionId: f.target.sessionId,
          deviceId: "browser-a",
        }),
      ).rejects.toThrow();
      expect(readFileSync(f.connection.credentialPath, "utf8")).toContain(f.connection.token);
    },
  );
  it("retains matching completion evidence received before the first reconnect snapshot", async () => {
    const f = await fixture();
    const input = f.control();
    const first = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0],
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "accepted",
      revision: 1,
      turnId,
    });
    await first;
    await f.reconnect();
    f.publish.mockClear();
    await f.events(
      { type: "turn-complete", turnId, revision: 2, text: "complete", aborted: false },
      { type: "snapshot", snapshot: { ...f.snapshot, revision: 2 } },
    );
    expect(f.publish).toHaveBeenCalledWith(
      f.target.sessionId,
      "invalidate",
      { domains: ["history", "catalog", "receipts"] },
      expect.any(Object),
    );
    expect(f.live()).toMatchObject({ status: "idle", sendEnabled: true });
    expect(
      f.bridge.receipt(
        readControlReceipt(f.options.dataDir, {
          requestId: input.requestId,
          deviceId: input.deviceId,
        }),
      ),
    ).toMatchObject({ completionObserved: true });
  });
  it("settles a matching late rejected stop without unlocking unknown writes from idle alone", async () => {
    const f = await fixture(30),
      turnId = randomUUID();
    await f.events({ type: "turn-start", turnId, revision: 1 });
    const input = f.control("stop"),
      first = f.bridge.request(input);
    const command = (await f.poll()).body.commands[0];
    expect(await first).toMatchObject({ controlOutcome: "unknown" });
    await f.events({
      type: "turn-complete",
      turnId,
      revision: 2,
      text: "normal completion",
      aborted: false,
    });
    expect(f.live()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
    await expect(f.manage("bridge-challenge")).rejects.toThrow("control-outcome-unconfirmed");
    await f.reconnect();
    await f.events({ type: "snapshot", snapshot: { ...f.snapshot, revision: 2 } });
    await f.post("/v1/results", {
      commandId: command.commandId,
      status: "rejected",
      revision: 2,
      reason: "turn-conflict",
    });
    expect(f.live().sendEnabled).toBe(true);
    expect(await f.bridge.request(input)).toMatchObject({ controlOutcome: "not-dispatched" });
    expect((await f.poll()).body.commands).toEqual([]);
  });
  it("revocation fences a command before the plugin can receive it", async () => {
    const f = await fixture();
    const first = f.bridge.request(f.control());
    f.bridge.invalidate("browser-a");
    expect(await first).toMatchObject({ controlOutcome: "not-dispatched" });
    expect((await f.poll()).body.commands).toEqual([]);
  });
});
