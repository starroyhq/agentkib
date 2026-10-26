// @vitest-environment node
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBridge, type ClaudeBridgeTarget } from "../../../packages/backend/src/claude-bridge";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const capabilities = {
  version: 1 as const,
  available: [
    "session-identity",
    "session-messages",
    "session-usage",
    "credential-store",
    "credential-read",
  ],
};

async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-bridge-auto-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const target: ClaudeBridgeTarget = {
    sessionId: "indexed-session",
    nativeId: randomUUID(),
    workspaceId: "workspace",
    workspace,
    registeredWorkspace: workspace,
  };
  const discoveryFile = path.join(root, "agentkib-home", "claude-bridge", "auto-v1.json");
  const autoTarget = vi.fn(async (nativeId: string, cwd: string) => {
    if (nativeId !== target.nativeId || cwd !== workspace) throw new Error("not registered");
    return { ...target };
  });
  const options = {
    dataDir: path.join(root, "data"),
    bootId: randomUUID(),
    pluginDirectory: path.join(root, "plugin"),
    platform: "darwin" as const,
    publish: vi.fn(),
    target: async (id: string) => {
      if (id !== target.sessionId) throw new Error("source unavailable");
      return { ...target };
    },
    validate: () => {},
    autoTarget,
    discoveryFile,
  };
  let bridge = new ClaudeBridge(options);
  bridge.initialize();
  cleanups.push(async () => {
    await bridge.close();
    rmSync(root, { recursive: true, force: true });
  });
  await vi.waitFor(() => expect(existsSync(discoveryFile)).toBe(true));
  const discovery = () =>
    JSON.parse(readFileSync(discoveryFile, "utf8")) as { socketPath: string; autoKey: string };
  const hello = {
    protocol: 1,
    nativeId: target.nativeId,
    cwd: workspace,
    cliVersion: "2.1.301",
    instanceId: randomUUID(),
    pluginVersion: "0.3.0",
    nativeCapabilities: capabilities,
  };
  function http(
    url: string,
    value: unknown,
  ): Promise<{ status: number; body: Record<string, any> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: discovery().socketPath,
          path: url,
          method: "POST",
          headers: { Host: "localhost", "Content-Type": "application/json", Connection: "close" },
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
  const autoPair = (extra: object = {}) =>
    http("/v1/auto-pair", { ...hello, autoKey: discovery().autoKey, ...extra });
  const manage = (operation: string, extra: object = {}) =>
    bridge.management({
      operation,
      sessionId: target.sessionId,
      deviceId: "agentkib-local-owner",
      ...extra,
    }) as Promise<Record<string, any>>;
  return {
    root,
    target,
    options,
    discoveryFile,
    discovery,
    hello,
    http,
    autoPair,
    manage,
    autoTarget,
    get bridge() {
      return bridge;
    },
    async restart() {
      await bridge.close();
      bridge = new ClaudeBridge(options);
      bridge.initialize();
      await vi.waitFor(() => expect(existsSync(discoveryFile)).toBe(true));
    },
  };
}

describe("Claude bridge automatic pairing", () => {
  it("publishes a private discovery file and removes it on close", async () => {
    const f = await fixture();
    expect(statSync(f.discoveryFile).mode & 0o777).toBe(0o600);
    expect(f.discovery().autoKey).toMatch(/^[a-f0-9]{64}$/);
    await f.bridge.close();
    expect(existsSync(f.discoveryFile)).toBe(false);
  });

  it("pairs a session in a registered workspace without a code", async () => {
    const f = await fixture();
    const response = await f.autoPair();
    expect(response.status).toBe(200);
    expect(response.body.bindingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(statSync(response.body.credentialPath).mode & 0o777).toBe(0o600);
    const status = await f.manage("bridge-status");
    expect(status.hasBinding).toBe(true);
    expect(status.autoConnect).toEqual({ available: true, enabled: true, declined: false });
  });

  it("rejects a wrong or rotated key", async () => {
    const f = await fixture();
    expect((await f.autoPair({ autoKey: "0".repeat(64) })).status).toBe(401);
    const old = f.discovery().autoKey;
    await f.restart();
    expect(f.discovery().autoKey).not.toBe(old);
    expect((await f.autoPair({ autoKey: old })).status).toBe(401);
  });

  it("asks the terminal to retry while the session is not indexed", async () => {
    const f = await fixture();
    f.autoTarget.mockRejectedValueOnce(new Error("session-unavailable"));
    const first = await f.autoPair();
    expect(first).toMatchObject({ status: 409, body: { error: "bridge-auto-unavailable" } });
    expect((await f.autoPair()).status).toBe(200);
  });

  it("respects a workspace that turned automatic connection off", async () => {
    const f = await fixture();
    const off = await f.manage("bridge-auto-connect", { enabled: false });
    expect(off.autoConnect).toEqual({ available: true, enabled: false, declined: false });
    expect(await f.autoPair()).toMatchObject({
      status: 409,
      body: { error: "bridge-auto-disabled" },
    });
    // The choice survives a Runtime restart.
    await f.restart();
    expect((await f.manage("bridge-status")).autoConnect.enabled).toBe(false);
    await f.manage("bridge-auto-connect", { enabled: true });
    expect((await f.autoPair()).status).toBe(200);
  });

  it("does not reconnect a session the user disconnected until a new code", async () => {
    const f = await fixture();
    expect((await f.autoPair()).status).toBe(200);
    await f.manage("bridge-disconnect");
    expect((await f.manage("bridge-status")).autoConnect.declined).toBe(true);
    expect(await f.autoPair()).toMatchObject({
      status: 409,
      body: { error: "bridge-auto-declined" },
    });
    await f.restart();
    expect((await f.autoPair()).body.error).toBe("bridge-auto-declined");
    const challenge = (await f.manage("bridge-challenge")) as { challenge: string };
    const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
    expect((await f.http("/v1/pair", { ...f.hello, ticket: ticket.ticket })).status).toBe(200);
    await f.manage("bridge-disconnect");
    // The explicit code cleared the refusal; the new disconnect records it again.
    expect((await f.autoPair()).body.error).toBe("bridge-auto-declined");
  });

  it("rejects a terminal whose identity does not match the resolved session", async () => {
    const f = await fixture();
    f.autoTarget.mockResolvedValueOnce({ ...f.target, workspace: path.join(f.root, "other") });
    expect((await f.autoPair()).body.error).toBe("bridge-identity-mismatch");
  });

  it("validates the auto-connect management request", async () => {
    const f = await fixture();
    await expect(f.manage("bridge-auto-connect")).rejects.toThrow();
    await expect(f.manage("bridge-status", { enabled: true })).rejects.toThrow();
  });
});
