import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaudeBridgeSnapshot } from "@agentkib/runtime-protocol";
import { expect, vi } from "vitest";
import {
  ClaudeBridge,
  type BridgeLead,
  type ClaudeBridgeTarget,
} from "../../../../packages/backend/src/agents/claude/claude-bridge";
import type { ClaudeTranscriptObservation } from "../../../../packages/backend/src/agents/claude/claude-context-usage";
import type { ClaudeObservedPermissionMode } from "../../../../packages/backend/src/agents/claude/claude-managed-runner";

export function createClaudeBridgeFixture(cleanups: Array<() => Promise<void>>) {
  return async function fixture(
    timeout = 1000,
    lead?: BridgeLead,
    observation?: (target: ClaudeBridgeTarget) => ClaudeTranscriptObservation,
    permission?: (target: ClaudeBridgeTarget) => ClaudeObservedPermissionMode | null,
    pluginVersion = "0.4.0",
  ) {
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
      observation,
      permission,
      target: async (id: string, nativeId?: string) => {
        if (!valid || id !== target.sessionId || (nativeId && nativeId !== target.nativeId))
          throw new Error("source unavailable");
        return { ...target };
      },
      validate: () => {
        if (!valid) throw new Error("source unavailable");
      },
      ...(lead ? { lead } : {}),
    };
    let bridge = new ClaudeBridge(options);
    cleanups.push(async () => {
      await bridge.close();
      rmSync(root, { recursive: true, force: true });
    });
    const manage = (operation: string) =>
      bridge.management({
        operation,
        sessionId: target.sessionId,
        deviceId: "agentkib-local-owner",
      });
    const challenge = (await manage("bridge-challenge")) as {
      challenge: string;
      expiresAt: string;
    };
    const ticket = JSON.parse(Buffer.from(challenge.challenge, "base64url").toString());
    const instanceId = randomUUID();
    const hello = {
      protocol: 1,
      nativeId: target.nativeId,
      cwd: workspace,
      cliVersion: "2.1.301",
      instanceId,
      pluginVersion,
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
      pluginVersion,
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
      outbox: [],
      capabilities: {
        read: true,
        send: true,
        steer: true,
        queue: true,
        stop: true,
        approve: false,
        answer: false,
      },
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
      ...(operation === "send"
        ? { text: "synthetic message" }
        : operation === "open-model-picker"
          ? {}
          : { turnId: live().turnId }),
      ...extra,
    });
    const poll = () => post("/v1/commands", { afterCommandId: null, waitMs: 0 });
    const reconnectFailure = {
      protocol: 1,
      pluginVersion: "0.4.0",
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
      restore: () => {
        valid = true;
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
      async restart(reconnect = true, bootId = options.bootId) {
        await bridge.close();
        options.bootId = bootId;
        bridge = new ClaudeBridge(options);
        bridge.initialize();
        if (!reconnect) return;
        await expect.poll(() => existsSync(ticket.socketPath)).toBe(true);
        await this.reconnect();
      },
    };
  };
}
