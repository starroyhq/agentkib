// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeBridge, type ClaudeBridgeTarget } from "../../../packages/backend/src/claude-bridge";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { ClaudeManagedRunnerProcess } from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeSessionOwnerProbe } from "../../../packages/backend/src/claude-session-owner";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { BackendStore } from "../../../packages/backend/src/store";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import {
  claimManagedCommand,
  dispatchManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import type { Commands } from "../../../packages/backend/src/commands";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

function fixture(
  options: { idleTimeoutMs?: number; badRegistry?: boolean; managedAliasOnly?: boolean } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-bridge-auto-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const home = path.join(root, "home");
  const config = path.join(home, ".claude");
  const bin = path.join(root, "bin");
  const managed = path.join(root, "claude-managed");
  for (const directory of [workspace, home, config, bin, managed])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const sessionId = randomUUID();
  const nativeId = randomUUID();
  const indexedId = options.managedAliasOnly ? `indexed-${nativeId}` : sessionId;
  const transcript = path.join(config, `${nativeId}.jsonl`);
  const userId = randomUUID();
  writeFileSync(
    transcript,
    [
      {
        type: "user",
        uuid: userId,
        sessionId: nativeId,
        cwd: workspace,
        message: { role: "user", content: "Synthetic existing question" },
      },
      {
        type: "assistant",
        uuid: randomUUID(),
        parentUuid: userId,
        sessionId: nativeId,
        cwd: workspace,
        message: { role: "assistant", stop_reason: "end_turn", content: [] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const log = path.join(root, "frames.jsonl");
  writeFileSync(
    path.join(bin, "claude"),
    `#!${process.execPath}\n${String.raw`
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("2.1.302 (Claude Code)"); process.exit(0); }
const log = value => fs.appendFileSync(process.env.BRIDGE_AUTO_LOG, JSON.stringify(value) + "\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\n");
log({ started: true, pid: process.pid, args: process.argv.slice(2) });
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line); log(frame);
  if (frame.type === "control_request") send({ type: "control_response", response: {
    subtype: "success", request_id: frame.request_id, response: { models: [], commands: [] }
  }});
  else if (frame.type === "user") {
    fs.appendFileSync(process.env.CLAUDE_CONFIG_DIR + "/" + frame.session_id + ".jsonl",
      JSON.stringify({ type: "user", uuid: frame.uuid, sessionId: frame.session_id,
        cwd: process.cwd(), message: frame.message }) + "\n");
    send({ type: "assistant", parent_tool_use_id: null, message: {
      id: frame.uuid, model: "fixture-model", usage: { input_tokens: 1 }, content: []
    }});
    send({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: { "fixture-model": { contextWindow: 100 } } });
  }
});
`}`,
    { mode: 0o700 },
  );
  const environment = {
    PATH: bin,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    XDG_DATA_HOME: path.join(home, "data"),
    BRIDGE_AUTO_LOG: log,
  };
  const target: ClaudeBridgeTarget = {
    sessionId,
    nativeId,
    workspaceId: "workspace",
    workspace,
    registeredWorkspace: workspace,
  };
  const ownership = vi
    .spyOn(ClaudeSessionOwnerProbe.prototype, "check")
    .mockResolvedValue({ kind: "idle" });
  let bridge: ClaudeBridge;
  const continuation = {
    idleTimeoutMs: options.idleTimeoutMs ?? 600_000,
    maintenanceIntervalMs: 20,
    isSessionBridged: (id: string) => {
      bridge.assertCanAdopt();
      return bridge.blocksManagedResume(id);
    },
  };
  const owner = new ClaudeManagedReadOwner(
    {
      workspacePath: () => workspace,
      sessions: {
        id: (_agent: string, id: string) => (id === nativeId ? indexedId : id),
        get: (id: string) =>
          id === indexedId
            ? {
                agent: "claude-code",
                workspace_id: "workspace",
                sidechain: false,
              }
            : undefined,
      },
    } as unknown as BackendStore,
    {
      verifiedClaudeControlTarget: (id: string) => {
        if (id !== nativeId) throw new Error("unverified-session-identity");
        return transcript;
      },
      verifiedClaudeReadSource: () => ({
        nativeId,
        workspaceId: "workspace",
        workspace,
        transcript,
      }),
      claudeControlWorkspace: () => workspace,
      list: async () => ({ sessions: [{ native_ref: nativeId, sidechain: false }] }),
      document: async () => ({ source: { agent: "claude-code", workspace_id: "workspace" } }),
    } as unknown as SessionReaders,
    {
      run: vi.fn(async (_command: string, args: string[]) => {
        expect(args).toEqual(["--version"]);
        return { success: true, bytes: Buffer.from("2.1.302 (Claude Code)\n") };
      }),
    } as unknown as Commands,
    root,
    environment,
    randomUUID(),
    undefined,
    continuation,
  );
  cleanups.push(() => owner.shutdown());
  writeFileSync(
    path.join(managed, `${sessionId}.json`),
    JSON.stringify({
      version: 1,
      id: sessionId,
      workspaceId: "workspace",
      workspace,
      registeredWorkspace: workspace,
      home: config,
      nativeId,
      title: "Synthetic",
      createdAt: new Date().toISOString(),
      adopted: true,
      released: false,
      fresh: false,
      fingerprint: createHash("sha256")
        .update(JSON.stringify([nativeId.toLowerCase(), workspace]))
        .update(readFileSync(transcript))
        .digest("hex"),
      completedRequests: [],
      snapshot: {
        status: "idle",
        revision: 0,
        turnId: null,
        sendEnabled: true,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
      },
    }),
    { mode: 0o600 },
  );
  if (options.badRegistry) {
    mkdirSync(path.join(root, "claude-bridge"), { mode: 0o700 });
    writeFileSync(path.join(root, "claude-bridge", "bindings-v1.json"), "{corrupt", {
      mode: 0o600,
    });
  }
  bridge = new ClaudeBridge({
    dataDir: root,
    bootId: owner.bootId,
    platform: "darwin",
    pluginDirectory: path.join(root, "plugin"),
    target: (id, sourceId) => owner.nativeBridgeTarget(id, sourceId),
    validate: (value, forControl, bindingId) =>
      owner.validateNativeBridgeTarget(value, forControl, bindingId),
    publish: () => {},
  });
  cleanups.push(() => bridge.close());
  const sends = vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send");
  const frames = (): Array<Record<string, unknown>> =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const send = async (id = sessionId) => {
    const live = await owner.live(id, true);
    return owner.request({
      operation: "send",
      sessionId: id,
      requestId: randomUUID(),
      deviceId: "agentkib-local-owner",
      runtimeBootId: owner.bootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      text: "Synthetic continuation",
    });
  };
  const running = () => sends.mock.contexts.findLast((runner) => runner.sessionId === nativeId)!;
  const dispatch = async () => {
    await expect(send()).resolves.toMatchObject({ accepted: true });
    await expect.poll(() => running().snapshot().status).toBe("idle");
  };
  const connect = async () => {
    const result = (await bridge.management({
      operation: "bridge-challenge",
      sessionId,
      deviceId: "agentkib-local-owner",
    })) as { challenge: string };
    const ticket = JSON.parse(Buffer.from(result.challenge, "base64url").toString()) as {
      socketPath: string;
      ticket: string;
    };
    const paired = await new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve, reject) => {
        const req = request(
          {
            socketPath: ticket.socketPath,
            path: "/v1/pair",
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
        req.end(
          JSON.stringify({
            protocol: 1,
            nativeId,
            cwd: workspace,
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
            instanceId: randomUUID(),
            ticket: ticket.ticket,
          }),
        );
      },
    );
    expect(paired.status, JSON.stringify(paired.body)).toBe(200);
    expect(bridge.handles(sessionId)).toBe(true);
    return paired.body as { bindingId: string };
  };
  return {
    root,
    owner,
    bridge,
    target,
    ownership,
    sends,
    send,
    dispatch,
    running,
    frames,
    connect,
    environment,
    indexedId,
  };
}

async function rejection(action: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    return (await action) as Record<string, unknown>;
  } catch (error) {
    return { accepted: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude automatic continuation and terminal bridge exclusion",
  () => {
    it("admits the terminal plugin after automatic idle retirement without manual release", async () => {
      const f = fixture({ idleTimeoutMs: 50 });
      await f.dispatch();
      await expect.poll(() => f.running().hasWorker).toBe(false);
      await expect(
        f.owner.nativeBridgeTarget(f.target.sessionId, f.target.nativeId),
      ).resolves.toEqual(f.target);
      expect(() => f.owner.validateNativeBridgeTarget(f.target, false)).not.toThrow();
      expect(() => f.owner.validateNativeBridgeTarget(f.target, true)).not.toThrow();
      await f.connect();
    });

    it("rejects bridge admission while an owned worker is alive", async () => {
      const f = fixture();
      await f.dispatch();
      expect(f.running().hasWorker).toBe(true);
      await expect(
        f.owner.nativeBridgeTarget(f.target.sessionId, f.target.nativeId),
      ).rejects.toThrow("session-already-managed");
      expect(() => f.owner.validateNativeBridgeTarget(f.target, false)).toThrow(
        "session-already-managed",
      );
    });

    it("fences bridge admission during the asynchronous startup guard", async () => {
      const f = fixture();
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const entered = new Promise<void>((resolve) => (reached = resolve));
      f.ownership.mockImplementation(async () => {
        if (f.sends.mock.calls.length > 0) {
          reached();
          await blocked;
        }
        return { kind: "idle" };
      });
      const sending = f.send();
      try {
        await entered;
        expect(f.frames()).toEqual([]);
        await expect(
          f.owner.nativeBridgeTarget(f.target.sessionId, f.target.nativeId),
        ).rejects.toThrow("session-already-managed");
        expect(() => f.owner.validateNativeBridgeTarget(f.target, false)).toThrow(
          "session-already-managed",
        );
      } finally {
        release();
        await sending;
      }
    });

    it("rejects bridge admission while a prior dispatched command is unresolved", async () => {
      const f = fixture();
      const id = randomUUID();
      claimManagedCommand(f.root, id, f.target.sessionId, "a".repeat(64), "agentkib-local-owner", {
        operation: "send",
      });
      dispatchManagedCommand(f.root, id);
      await expect(
        f.owner.nativeBridgeTarget(f.target.sessionId, f.target.nativeId),
      ).rejects.toThrow();
      expect(() => f.owner.validateNativeBridgeTarget(f.target, true)).toThrow();
      expect(f.frames()).toEqual([]);
    });

    it("allows only the authenticated binding to report its matching unresolved terminal command", async () => {
      const f = fixture();
      const binding = await f.connect();
      const id = randomUUID();
      claimManagedCommand(f.root, id, f.target.sessionId, "d".repeat(64), "agentkib-local-owner", {
        operation: "send",
        executionMode: "claude-follower",
        nativeId: f.target.nativeId,
        workspaceId: f.target.workspaceId,
        bindingId: binding.bindingId,
      });
      dispatchManagedCommand(f.root, id);
      expect(() =>
        f.owner.validateNativeBridgeTarget(f.target, false, binding.bindingId),
      ).not.toThrow();
      expect(() => f.owner.validateNativeBridgeTarget(f.target, false, randomUUID())).toThrow(
        "control-outcome-unconfirmed",
      );
      expect(() => f.owner.validateNativeBridgeTarget(f.target, false)).toThrow(
        "control-outcome-unconfirmed",
      );
      await expect(
        f.owner.nativeBridgeTarget(f.target.sessionId, f.target.nativeId),
      ).rejects.toThrow("control-outcome-unconfirmed");
    });

    it("never treats a managed command as a terminal binding's recovery evidence", async () => {
      const f = fixture();
      const binding = await f.connect();
      const id = randomUUID();
      claimManagedCommand(f.root, id, f.target.sessionId, "e".repeat(64), "agentkib-local-owner", {
        operation: "send",
        executionMode: "claude-managed",
        nativeId: f.target.nativeId,
        workspaceId: f.target.workspaceId,
        bindingId: binding.bindingId,
      });
      dispatchManagedCommand(f.root, id);
      expect(() => f.owner.validateNativeBridgeTarget(f.target, false, binding.bindingId)).toThrow(
        "control-outcome-unconfirmed",
      );
      expect(f.frames()).toEqual([]);
    });

    it("does not start another worker when a terminal bridge already owns the session", async () => {
      const f = fixture();
      await f.connect();
      await expect(rejection(f.send())).resolves.toMatchObject({
        accepted: false,
        error: "session-already-bridged",
      });
      expect(f.frames()).toEqual([]);
      expect(f.bridge.handles(f.target.sessionId)).toBe(true);
      expect(() => f.owner.validateNativeBridgeTarget(f.target, true)).not.toThrow();
    });

    it("does not infer freedom from a corrupt bridge credential registry", async () => {
      const f = fixture({ badRegistry: true });
      await expect(rejection(f.send())).resolves.toMatchObject({
        accepted: false,
        error: "claude-bridge-registry-invalid",
      });
      expect(f.frames()).toEqual([]);
      expect(() => f.bridge.assertCanAdopt()).toThrow("claude-bridge-registry-invalid");
      expect(readFileSync(path.join(f.root, "claude-bridge", "bindings-v1.json"), "utf8")).toBe(
        "{corrupt",
      );
    });

    it("protects a fresh terminal connection before its first display snapshot", async () => {
      const f = fixture();
      await f.connect();
      expect(f.bridge.live(f.target.sessionId, false)).toMatchObject({
        status: "unsupported",
        executionLocation: null,
      });
      expect(f.bridge.blocksManagedResume(f.target.sessionId)).toBe(true);
      await expect(rejection(f.send())).resolves.toMatchObject({
        accepted: false,
        error: "session-already-bridged",
      });
      expect(f.frames()).toEqual([]);
    });

    it("resumes automatically after a clean terminal lease expires without disconnecting credentials", async () => {
      const f = fixture();
      await f.connect();
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 40_000);
      expect(f.bridge.handles(f.target.sessionId)).toBe(true);
      expect(f.bridge.blocksManagedResume(f.target.sessionId)).toBe(false);
      await expect(f.send()).resolves.toMatchObject({ accepted: true });
      expect(f.frames().filter((frame) => frame.started)).toHaveLength(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
      expect(existsSync(path.join(f.root, "claude-bridge", "bindings-v1.json"))).toBe(true);
    });

    it("keeps expired terminal leases fenced when native control is unresolved", async () => {
      const f = fixture();
      await f.connect();
      const id = randomUUID();
      claimManagedCommand(f.root, id, f.target.sessionId, "c".repeat(64), "agentkib-local-owner", {
        operation: "send",
        executionMode: "claude-follower",
      });
      dispatchManagedCommand(f.root, id);
      const realNow = Date.now.bind(Date);
      vi.spyOn(Date, "now").mockImplementation(() => realNow() + 40_000);
      expect(f.bridge.blocksManagedResume(f.target.sessionId)).toBe(true);
      await expect(rejection(f.send())).resolves.toMatchObject({ accepted: false });
      expect(f.frames()).toEqual([]);
    });

    it("allows a retired managed alias without inventing an indexed session identity", async () => {
      const f = fixture({ idleTimeoutMs: 50, managedAliasOnly: true });
      await f.dispatch();
      await expect.poll(() => f.running().hasWorker).toBe(false);
      await expect(
        f.owner.nativeBridgeTarget(f.target.sessionId, f.target.nativeId),
      ).resolves.toEqual(f.target);
      expect(() => f.owner.validateNativeBridgeTarget(f.target, true)).not.toThrow();
      await expect(f.owner.nativeBridgeTarget(f.target.sessionId, randomUUID())).rejects.toThrow(
        "unverified-session-identity",
      );
      expect(() =>
        f.owner.validateNativeBridgeTarget({ ...f.target, nativeId: randomUUID() }, true),
      ).toThrow("unverified-session-identity");
      await f.connect();
    });

    it("rejects indexed-alias bridge admission while the same native session has an owned worker", async () => {
      const f = fixture({ managedAliasOnly: true });
      await f.dispatch();
      expect(f.running().hasWorker).toBe(true);
      await expect(f.owner.nativeBridgeTarget(f.indexedId, f.target.nativeId)).rejects.toThrow(
        "session-already-managed",
      );
      expect(() =>
        f.owner.validateNativeBridgeTarget({ ...f.target, sessionId: f.indexedId }, true),
      ).toThrow("session-already-managed");
    });

    it("rejects indexed-alias bridge admission when another managed alias has unknown control", async () => {
      const f = fixture({ managedAliasOnly: true });
      const id = randomUUID();
      claimManagedCommand(f.root, id, f.target.sessionId, "b".repeat(64), "agentkib-local-owner", {
        operation: "send",
      });
      dispatchManagedCommand(f.root, id);
      await expect(f.owner.nativeBridgeTarget(f.indexedId, f.target.nativeId)).rejects.toThrow(
        "control-outcome-unconfirmed",
      );
      expect(() =>
        f.owner.validateNativeBridgeTarget({ ...f.target, sessionId: f.indexedId }, true),
      ).toThrow("control-outcome-unconfirmed");
    });

    it("does not start the indexed alias while the same native session is bound through a managed alias", async () => {
      const f = fixture({ managedAliasOnly: true });
      await f.connect();
      await expect(rejection(f.send(f.indexedId))).resolves.toMatchObject({
        accepted: false,
        error: "session-already-bridged",
      });
      expect(f.frames()).toEqual([]);
      expect(f.bridge.handles(f.target.sessionId)).toBe(true);
      expect(() => f.owner.validateNativeBridgeTarget(f.target, true)).not.toThrow();
    });

    it("keeps real Backend automatic sends fenced by an unreadable bridge registry", async () => {
      const f = fixture({ badRegistry: true });
      const history = path.join(f.environment.CLAUDE_CONFIG_DIR, "projects", "synthetic");
      mkdirSync(history, { recursive: true });
      writeFileSync(
        path.join(history, `${f.target.nativeId}.jsonl`),
        readFileSync(path.join(f.environment.CLAUDE_CONFIG_DIR, `${f.target.nativeId}.jsonl`)),
      );
      writeFileSync(
        path.join(f.root, "preferences.json"),
        JSON.stringify({
          session_index_enabled: true,
          session_content_search_enabled: false,
        }),
      );
      const store = new BackendStore(path.join(f.root, "agentkib.db"));
      let indexedId: string;
      try {
        store.sql.run(
          "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
          "workspace",
          f.target.workspace,
          "Synthetic",
          "healthy",
          "2026-10-19T00:00:00Z",
        );
        store.sessions.sync("workspace", "claude-code", [
          {
            native_ref: f.target.nativeId,
            agent: "claude-code",
            title: "Synthetic",
            created_at: "2026-10-19T00:00:00Z",
            updated_at: "2026-10-19T00:00:00Z",
            message_count: 2,
            git_branch: null,
            archived: false,
            sidechain: false,
            availability: "readable",
            origin: "interactive",
          },
        ]);
        indexedId = store.sessions.id("claude-code", f.target.nativeId);
      } finally {
        store.close();
      }
      vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
      vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
      const backend = new TypeScriptBackend(f.environment);
      cleanups.push(() => backend.close());
      const rpc = (method: string, params: unknown) =>
        backend.handleAsync({
          jsonrpc: "2.0",
          id: randomUUID(),
          method,
          params,
        });
      const initialized = await rpc("backend.initialize", { dataDir: f.root });
      expect(initialized.error).toBeUndefined();
      const command = await rpc("web.request", {
        operation: "resume-command",
        sessionId: indexedId,
      });
      expect(command.error).toBeUndefined();
      expect(command.result).toMatchObject({ available: true, runOn: "host" });
      expect((command.result as { command: string }).command).toContain(
        `claude --resume '${f.target.nativeId}'`,
      );
      const state = await rpc("claude.managed", {
        operation: "live",
        sessionId: indexedId,
        experimentalEnabled: true,
      });
      expect(state.error).toBeUndefined();
      const live = state.result as { runtimeBootId: string; revision: number };
      const sent = await rpc("claude.managed", {
        operation: "send",
        sessionId: indexedId,
        requestId: randomUUID(),
        deviceId: "agentkib-local-owner",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "Synthetic continuation",
      });
      expect(sent.error || (sent.result as { accepted?: boolean }).accepted === false).toBeTruthy();
      expect(JSON.stringify(sent)).toContain("claude-bridge-registry-invalid");
      expect(f.frames()).toEqual([]);
      expect(readFileSync(path.join(f.root, "claude-bridge", "bindings-v1.json"), "utf8")).toBe(
        "{corrupt",
      );
    });
  },
);
