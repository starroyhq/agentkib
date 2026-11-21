import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunnerState } from "../../../packages/backend/src/claude-managed-runner";
import {
  ClaudeManagedReadOwner,
  supportsClaudeVersion,
} from "../../../packages/backend/src/claude-managed-read";
import {
  claimManagedCommand,
  dispatchManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import type { Commands } from "../../../packages/backend/src/commands";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { BackendStore } from "../../../packages/backend/src/store";
import {
  AcpCompactionState,
  AntigravityAcp,
  acpCompatibility,
  verifyAcpControlIdentity,
} from "../../../packages/backend/src/agents/antigravity/antigravity-acp";
import { AntigravityManagedRunner } from "../../../packages/backend/src/agents/antigravity/antigravity-managed-runner";
import { parseAntigravityReplay } from "../../../packages/backend/src/agents/antigravity/antigravity-replay";
import { parseAcpJson, stringifyAcpJson } from "../../../packages/backend/src/acp-json";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.restoreAllMocks();
});

function claude() {
  const state = new ClaudeRunnerState("session");
  state.initialized = true;
  state.begin("hello", randomUUID());
  return state;
}
function assistant(
  state: ClaudeRunnerState,
  usage: Record<string, unknown>,
  model = "native-model",
  parent: string | null = null,
) {
  state.frame({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { model, usage, content: [] },
  });
}
function result(
  state: ClaudeRunnerState,
  modelUsage: Record<string, unknown> = { "native-model": { contextWindow: 1000 } },
) {
  state.frame({
    type: "result",
    subtype: "success",
    usage: { input_tokens: 9000000, output_tokens: 8000000 },
    modelUsage,
  });
}
const compact = (id: string, status: string, patch: Record<string, unknown> = {}) => ({
  sessionUpdate: "compaction_update",
  compactionId: id,
  status,
  ...patch,
});
const chunk = (id: string, text: string) => ({
  sessionUpdate: "compaction_summary_chunk",
  compactionId: id,
  content: { type: "text", text },
});

describe("Claude native context and lifecycle", () => {
  it("starts a new report generation when the runner state is rebuilt", () => {
    const prior = claude();
    const priorGeneration = prior.snapshot().usage.reportGeneration!;
    expect(Number.isSafeInteger(priorGeneration)).toBe(true);
    expect(priorGeneration).toBeGreaterThan(0);
    expect(prior.snapshot().usage.state).toBe("unavailable");
    assistant(prior, { input_tokens: 800 });
    assistant(prior, { input_tokens: 800 });
    result(prior);
    expect(prior.snapshot().usage).toMatchObject({
      reportGeneration: priorGeneration,
      reportId: 2,
      percent: 80,
    });

    const restored = claude();
    const restoredGeneration = restored.snapshot().usage.reportGeneration!;
    expect(restoredGeneration).toBeGreaterThan(priorGeneration);
    expect(restored.usageReportId).toBe(0);
    assistant(restored, { input_tokens: 50 });
    result(restored);
    expect(restored.snapshot().usage).toMatchObject({
      reportGeneration: restoredGeneration,
      reportId: 1,
      percent: 5,
      state: "ready",
    });
    const checkpoint = restored.checkpoint();
    restored.begin("next", randomUUID());
    restored.frame({ type: "system", subtype: "status", status: "compacting" });
    restored.restoreUndispatched(checkpoint);
    expect(restored.snapshot().usage).toMatchObject({
      reportGeneration: restoredGeneration,
      reportId: 1,
      state: "pending",
    });
  });

  it("uses latest main-loop input including caches, never output or result totals", () => {
    const state = claude();
    state.frame({
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_start",
        message: {
          model: "native-model",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 30,
            output_tokens: 900,
          },
        },
      },
    });
    expect(state.snapshot().usage).toMatchObject({ usedTokens: 60, state: "pending" });
    assistant(state, {
      input_tokens: 100,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 300,
      output_tokens: 9000,
    });
    assistant(state, { input_tokens: 999 }, "subagent-model", "parent-tool");
    result(state);
    expect(state.snapshot().usage).toMatchObject({
      usedTokens: 600,
      contextWindow: 1000,
      percent: 60,
      state: "ready",
      reportId: 2,
    });
    expect(state.snapshot().usage.totalTokens).toBeUndefined();
  });
  it("requires an exact native model window and does not infer aliases", () => {
    const state = claude();
    assistant(state, { input_tokens: 70 });
    result(state, { alias: { contextWindow: 200000 } });
    expect(state.snapshot().usage).toMatchObject({ usedTokens: 70, state: "pending" });
    expect(state.snapshot().usage.percent).toBeUndefined();
    state.begin("next", randomUUID());
    assistant(state, { input_tokens: 90 }, "other-model");
    result(state);
    expect(state.snapshot().usage.contextWindow).toBeUndefined();
  });
  it("uses the final ordinary iteration instead of auxiliary aggregate counters", () => {
    const state = claude();
    assistant(state, {
      input_tokens: 9000,
      iterations: [
        { type: "message", input_tokens: 20, cache_read_input_tokens: 30 },
        { type: "compaction", input_tokens: 8000 },
        { type: "advisor_message", input_tokens: 1000 },
      ],
    });
    result(state);
    expect(state.snapshot().usage.usedTokens).toBe(50);
  });
  it.each([undefined, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "10"])(
    "does not fabricate a context value from invalid input %s",
    (input) => {
      const state = claude();
      assistant(state, { input_tokens: input });
      result(state);
      expect(state.snapshot().usage.available).toBe(false);
      expect(state.snapshot().usage.usedTokens).toBeUndefined();
    },
  );
  it("keeps configuration separate from compaction and awaits a new API report", () => {
    const state = claude();
    assistant(state, { input_tokens: 400 });
    result(state);
    state.begin("next", randomUUID());
    expect(state.snapshot().usage.state).toBe("pending");
    state.frame({
      type: "autocompact_state",
      value: { enabled: true, effective_window: 200, threshold: 150 },
    });
    expect(state.snapshot().activity).toBeNull();
    state.frame({ type: "system", subtype: "status", status: "compacting" });
    expect(state.snapshot()).toMatchObject({
      activity: "compacting",
      status: "running",
      stopEnabled: true,
    });
    expect(() => state.begin("blocked")).toThrow("session-compacting");
    assistant(state, { input_tokens: 1 });
    expect(state.snapshot().usage).toMatchObject({
      state: "pending",
      reason: "context-report-pending",
      usedTokens: 1,
      reportId: 2,
    });
    expect(state.snapshot().usage.percent).toBeUndefined();
    state.frame({ type: "system", subtype: "status", status: null, compact_result: "success" });
    state.frame({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 400, post_tokens: 2 },
    });
    expect(state.snapshot()).toMatchObject({
      activity: null,
      status: "running",
      usage: { state: "stale", usedTokens: 1, reportId: 2 },
    });
    expect(state.snapshot().usage.percent).toBeUndefined();
    assistant(state, { input_tokens: 120 });
    expect(state.snapshot().usage).toMatchObject({ state: "ready", usedTokens: 120, percent: 12 });
    state.fail("offline");
    expect(state.snapshot().usage).toMatchObject({ state: "stale", usedTokens: 120 });
    expect(state.snapshot().usage.percent).toBeUndefined();
  });
  it.each(["status", "boundary", "result"])(
    "retains a candidate without promoting it when compaction ends through %s",
    (terminal) => {
      const state = claude();
      assistant(state, { input_tokens: 400 });
      result(state);
      state.begin("next", randomUUID());
      state.frame({ type: "system", subtype: "status", status: "compacting" });
      assistant(state, {
        input_tokens: 7,
        cache_read_input_tokens: 11,
        cache_creation_input_tokens: 13,
      });
      expect(state.snapshot().usage).toMatchObject({
        state: "pending",
        usedTokens: 31,
        contextWindow: 1000,
        reportId: 2,
      });
      expect(state.snapshot().usage.percent).toBeUndefined();
      if (terminal === "result") result(state);
      else
        state.frame(
          terminal === "boundary"
            ? { type: "system", subtype: "compact_boundary" }
            : { type: "system", subtype: "status", status: null },
        );
      expect(state.snapshot().usage).toMatchObject({
        state: "stale",
        reason: "compaction-completed",
        usedTokens: 31,
        reportId: 2,
      });
      expect(state.snapshot().usage.percent).toBeUndefined();
    },
  );
  it("does not promote a candidate from a newly supplied window or a turn without a report", () => {
    const state = claude();
    state.frame({ type: "system", subtype: "status", status: "compacting" });
    assistant(state, { input_tokens: 30 });
    expect(state.snapshot().usage).toMatchObject({
      state: "pending",
      reason: "context-report-pending",
      usedTokens: 30,
      reportId: 1,
    });
    expect(state.snapshot().usage.contextWindow).toBeUndefined();
    result(state);
    expect(state.snapshot().usage).toMatchObject({
      state: "stale",
      usedTokens: 30,
      contextWindow: 1000,
      reportId: 1,
    });
    expect(state.snapshot().usage.percent).toBeUndefined();
    state.begin("without a report", randomUUID());
    result(state);
    expect(state.snapshot().usage.state).toBe("pending");
    expect(state.snapshot().usage.reportId).toBe(1);
    expect(state.snapshot().usage.percent).toBeUndefined();
    state.begin("ordinary request", randomUUID());
    assistant(state, { input_tokens: 0 });
    expect(state.snapshot().usage).toMatchObject({
      state: "ready",
      usedTokens: 0,
      percent: 0,
      reportId: 2,
    });
  });
  it("excludes auxiliary reports while preserving the latest main compaction candidate", () => {
    const state = claude();
    assistant(state, { input_tokens: 100 });
    result(state);
    state.begin("next", randomUUID());
    state.frame({ type: "system", subtype: "status", status: "compacting" });
    assistant(state, { input_tokens: 25 });
    assistant(state, { input_tokens: 999 }, "native-model", "subagent");
    assistant(state, { input_tokens: 999 }, "<synthetic>");
    state.frame({
      type: "assistant",
      isUnmetered: true,
      message: { model: "native-model", usage: { input_tokens: 999 }, content: [] },
    });
    assistant(state, {
      input_tokens: 999,
      iterations: [
        { type: "advisor_message", input_tokens: 900 },
        { type: "compaction", input_tokens: 99 },
      ],
    });
    expect(state.snapshot().usage).toMatchObject({ state: "pending", usedTokens: 25, reportId: 2 });
    assistant(state, {
      input_tokens: 999,
      iterations: [
        { type: "message", input_tokens: 7 },
        { type: "compaction", input_tokens: 900 },
        { type: "fallback_message", input_tokens: 20, cache_read_input_tokens: 10 },
        { type: "advisor_message", input_tokens: 99 },
      ],
    });
    result(state);
    expect(state.snapshot().usage).toMatchObject({ state: "stale", usedTokens: 30, reportId: 3 });
    expect(state.snapshot().usage.percent).toBeUndefined();
  });
  it("preserves valid approval and stop during compaction", () => {
    const state = claude();
    state.frame({ type: "system", subtype: "status", status: "compacting" });
    state.frame({
      type: "control_request",
      request_id: "approval",
      request: {
        subtype: "can_use_tool",
        tool_name: "Read",
        input: { file_path: "/workspace/file" },
      },
    });
    const live = state.snapshot();
    expect(
      state.approve("approval", live.turnId, "deny", live.revision).response.response.behavior,
    ).toBe("deny");
    state.assertCanStop(state.turnId, state.revision);
    expect(state.snapshot().activity).toBe("compacting");
  });
  it("restores an undispatched turn without losing incoming native compaction evidence", () => {
    const state = claude();
    assistant(state, { input_tokens: 200 });
    result(state);
    const checkpoint = state.checkpoint();
    state.begin("not dispatched", randomUUID());
    state.frame({ type: "system", subtype: "status", status: "compacting" });
    assistant(state, { input_tokens: 150 });
    const revision = state.revision;
    state.restoreUndispatched(checkpoint);
    expect(state.snapshot()).toMatchObject({
      status: "idle",
      turnId: checkpoint.turnId,
      activity: "compacting",
      sendEnabled: false,
      usage: { state: "pending", usedTokens: 150, reportId: 2 },
    });
    expect(state.revision).toBeGreaterThan(revision);
  });
  it("ends compaction waiting on a terminal result even without an explicit boundary", () => {
    const state = claude();
    assistant(state, { input_tokens: 100 });
    result(state);
    state.begin("next", randomUUID());
    state.frame({ type: "system", subtype: "status", status: "compacting" });
    result(state);
    expect(state.snapshot()).toMatchObject({
      activity: null,
      status: "idle",
      sendEnabled: true,
      usage: { state: "stale", usedTokens: 100 },
    });
  });
  it("revokes a prior ready report when a new main API starts without valid usage", () => {
    const state = claude();
    assistant(state, { input_tokens: 100 });
    result(state);
    state.begin("next", randomUUID());
    assistant(state, { input_tokens: 200 });
    state.frame({
      type: "stream_event",
      event: { type: "message_start", message: { model: "native-model" } },
    });
    expect(state.snapshot().usage).toMatchObject({ state: "pending", usedTokens: 200 });
    assistant(state, { input_tokens: -1 });
    expect(state.snapshot().usage).toMatchObject({
      state: "stale",
      usedTokens: 200,
      reason: "invalid-context-report",
    });
    expect(state.snapshot().usage.percent).toBeUndefined();
  });
  it.each([
    "2.1.263 (Claude Code)",
    "2.1.285 (Claude Code)",
    "2.1.286 (Claude Code)",
    "3.0.0 (Claude Code)",
  ])("tries a compatible version %s", (version) =>
    expect(supportsClaudeVersion(version)).toBe(true),
  );
  it.each([
    "2.1.262 (Claude Code)",
    "2.1.286-beta (Claude Code)",
    "2.1.286",
    "prefix 2.1.286 (Claude Code)",
  ])("rejects an invalid version %s", (version) =>
    expect(supportsClaudeVersion(version)).toBe(false),
  );
  it("keeps foreground Bash gated at its own minimum", () => {
    expect(supportsClaudeVersion("2.1.263 (Claude Code)", "2.1.285")).toBe(false);
    expect(supportsClaudeVersion("2.1.286 (Claude Code)", "2.1.285")).toBe(true);
  });
});

function claudeOwnerFixture(status = "idle") {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-live-")));
  const home = path.join(directory, "home"),
    workspace = path.join(directory, "workspace"),
    bin = path.join(directory, "bin");
  for (const target of [home, workspace, bin, path.join(directory, "claude-managed")])
    mkdirSync(target, { mode: 0o700 });
  const executable = path.join(bin, "claude");
  writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const id = randomUUID(),
    boot = randomUUID();
  writeFileSync(
    path.join(directory, "claude-managed", `${id}.json`),
    JSON.stringify({
      version: 1,
      id,
      workspaceId: "workspace",
      workspace,
      registeredWorkspace: workspace,
      home,
      nativeId: randomUUID(),
      title: "Synthetic",
      createdAt: new Date().toISOString(),
      adopted: false,
      released: false,
      fresh: true,
      fingerprint: null,
      completedRequests: [],
      snapshot: {
        status,
        activity: "compacting",
        revision: 3,
        turnId: null,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
        streamText: "",
        usage: {
          available: true,
          state: "ready",
          usedTokens: 100,
          contextWindow: 1000,
          reportGeneration: 99999,
        },
      },
    }),
    { mode: 0o600 },
  );
  const readOnlyProbes: Array<[string, string[]]> = [
    [executable, ["--version"]],
    [executable, ["agents", "--json"]],
    ["/bin/ps", ["-axo", "pid=,pgid=,lstart=,command="]],
  ];
  const run = vi.fn(async (command: string, args: string[]) => {
    const probe = readOnlyProbes.findIndex(
      ([allowedCommand, allowedArgs]) =>
        command === allowedCommand && JSON.stringify(args) === JSON.stringify(allowedArgs),
    );
    if (probe < 0) throw new Error("unexpected mutating Claude command");
    return {
      success: true,
      bytes: Buffer.from(probe === 0 ? "2.1.286 (Claude Code)\n" : probe === 1 ? "[]\n" : ""),
    };
  });
  const owner = new ClaudeManagedReadOwner(
    { workspacePath: () => workspace } as unknown as BackendStore,
    {} as SessionReaders,
    { run } as unknown as Commands,
    directory,
    { PATH: bin, CLAUDE_CONFIG_DIR: home },
    boot,
  );
  cleanups.push(() => {
    owner.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (operation: string) => ({
    operation,
    sessionId: id,
    requestId: randomUUID(),
    deviceId: "agentkib-local-owner",
    runtimeBootId: boot,
    expectedRevision: 2,
    experimentalEnabled: true,
    ...(operation === "send" ? { text: "never dispatched" } : {}),
  });
  return { owner, id, boot, directory, run, request, readOnlyProbes };
}

describe.skipIf(process.platform !== "darwin")("Claude offline owner fences", () => {
  it.each(["send", "release"])(
    "returns a correlated compaction rejection before revision checking for %s",
    async (operation) => {
      const f = claudeOwnerFixture();
      const request = f.request(operation);
      if (operation === "release") {
        delete (request as Record<string, unknown>).experimentalEnabled;
      }
      await expect(f.owner.request(request)).resolves.toMatchObject({
        accepted: false,
        completed: false,
        controlOutcome: "not-dispatched",
        requestId: request.requestId,
        sessionId: f.id,
        runtimeBootId: f.boot,
        reason: "session-compacting",
      });
      for (const [command, args] of f.run.mock.calls)
        expect(f.readOnlyProbes).toContainEqual([command, args]);
    },
  );
  it.each(["send", "release"])(
    "keeps a prior unknown command fence ahead of compaction rejection for %s",
    async (operation) => {
      const f = claudeOwnerFixture();
      const prior = randomUUID();
      claimManagedCommand(
        f.directory,
        prior,
        f.id,
        "synthetic-fingerprint",
        "agentkib-local-owner",
        { operation: "send" },
      );
      dispatchManagedCommand(f.directory, prior);
      const request = f.request(operation);
      if (operation === "release") delete (request as Record<string, unknown>).experimentalEnabled;
      await expect(f.owner.request(request)).rejects.toThrow("control-outcome-unconfirmed");
    },
  );
  it("does not relabel an unknown native state as definitely undispatched", async () => {
    const f = claudeOwnerFixture("outcome-unknown");
    await expect(f.owner.request(f.request("send"))).rejects.toThrow("control-outcome-unconfirmed");
  });
  it("keeps usage independent of control grants and marks a disconnected saved report stale", async () => {
    const f = claudeOwnerFixture();
    const capabilities = (await f.owner.request({
      operation: "capabilities",
      sessionId: f.id,
    })) as { features: Record<string, unknown> };
    expect(capabilities.features.usage).toEqual({ available: true });
    const usage = await f.owner.request({ operation: "usage", sessionId: f.id });
    expect(usage).toMatchObject({
      available: true,
      state: "stale",
      usedTokens: 100,
      contextWindow: 1000,
    });
    expect((usage as Record<string, unknown>).percent).toBeUndefined();
    expect((usage as Record<string, unknown>).reportGeneration).toBeUndefined();
  });
});

describe("ACP native compatibility and compaction", () => {
  it.each(["agy_acp_server_1.1.1", "agy_acp_server_1.1.10", "agy_acp_server_2.0.0"])(
    "accepts compatible server %s",
    (version) =>
      expect(() =>
        verifyAcpControlIdentity({ agentInfo: { name: "antigravity-acp", version } }),
      ).not.toThrow(),
  );
  it.each([
    "agy_acp_server_1.1.0",
    "agy_acp_server_1.1.1-beta",
    "xagy_acp_server_1.1.1",
    "agy_acp_server_1.1",
    "agy_acp_server_9007199254740992.0.0",
  ])("rejects unverified version %s", (version) =>
    expect(() =>
      verifyAcpControlIdentity({ agentInfo: { name: "antigravity-acp", version } }),
    ).toThrow(),
  );
  it("preserves protocol and identity gates independently of app version", () => {
    expect(() =>
      verifyAcpControlIdentity({ agentInfo: { name: "other", version: "agy_acp_server_2.0.0" } }),
    ).toThrow();
    expect(() => acpCompatibility({ protocolVersion: 2n, agentCapabilities: {} })).toThrow(
      "requires ACP v1",
    );
    expect(
      acpCompatibility({ protocolVersion: 1n, agentCapabilities: { loadSession: true } }),
    ).toMatchObject({ loadSession: true, resumeSession: false });
  });
  it("preserves first receipt, chunks, terminal replacement and nullable patches", () => {
    const state = new AcpCompactionState();
    state.apply({ sessionUpdate: "agent_message_chunk" });
    state.apply(compact("one", "in_progress"));
    state.apply(chunk("one", "draft"));
    state.apply(compact("two", "completed", { summary: [{ type: "text", text: "second" }] }));
    state.apply(
      compact("one", "completed", {
        summary: [{ type: "text", text: "final" }],
        _meta: { native: true },
      }),
    );
    state.apply(compact("one", "completed"));
    expect(state.active).toBe(false);
    expect(state.snapshot().map((entry) => [entry.compactionId, entry.position])).toEqual([
      ["one", 1],
      ["two", 3],
    ]);
    expect(state.snapshot()[0]).toMatchObject({
      chunks: [],
      summary: [{ type: "text", text: "final" }],
      _meta: { native: true },
    });
    state.apply(compact("one", "completed", { summary: null, _meta: null }));
    expect(state.snapshot()[0]).toMatchObject({ summary: null, _meta: null });
    expect(() => state.apply(chunk("one", "late"))).toThrow("outside active");
  });
  it("does not infer completion from an unknown status or another compaction ID", () => {
    const state = new AcpCompactionState();
    state.apply(compact("one", "in_progress"));
    state.apply(compact("one", "future-status"));
    state.apply(compact("other", "completed"));
    expect(state.active).toBe(true);
    expect(state.snapshot()[0].status).toBe("future-status");
    state.apply(compact("one", "failed", { error: "native failure" }));
    state.apply(compact("one", "failed", { error: null }));
    expect(state.active).toBe(false);
    expect(state.snapshot()[0].error).toBeNull();
  });
  it("rejects orphan chunks, invalid phase fields and oversized summaries atomically", () => {
    const state = new AcpCompactionState();
    expect(() => state.apply(chunk("missing", "orphan"))).toThrow();
    expect(() =>
      state.apply(compact("one", "in_progress", { summary: [{ type: "text", text: "too soon" }] })),
    ).toThrow();
    expect(() => state.apply(compact("one", "completed", { error: "wrong phase" }))).toThrow();
    expect(() =>
      state.apply(
        compact("one", "completed", { summary: [{ type: "text", text: "x".repeat(1024 * 1024) }] }),
      ),
    ).toThrow("limit");
    expect(state.snapshot()).toEqual([]);
  });
  it("accepts terminal-first history without moving or duplicating transcript messages", () => {
    const replay = parseAntigravityReplay([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "message",
        content: { type: "text", text: "before " },
      },
      compact("history", "completed", { summary: [{ type: "text", text: "internal summary" }] }),
      compact("history", "completed", { summary: null }),
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "message",
        content: { type: "text", text: "after" },
      },
    ]);
    expect(replay.events).toHaveLength(1);
    expect(replay.events[0].content).toBe("before after");
    expect(JSON.stringify(replay.turns)).not.toContain("internal summary");
  });
});

async function acpFixture(replayUpdates: Record<string, unknown>[] = []) {
  const reader = new PassThrough(),
    writer = new PassThrough();
  const client = new AntigravityAcp(reader, writer);
  const requests: Record<string, unknown>[] = [];
  const write = (frame: Record<string, unknown>) => reader.write(`${stringifyAcpJson(frame)}\n`);
  writer.on("data", (data) => {
    const request = parseAcpJson(data) as Record<string, unknown>;
    requests.push(request);
    if (request.method === "initialize")
      write({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: 1n,
          agentInfo: { name: "antigravity-acp", version: "agy_acp_server_1.2.0" },
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
        },
      });
    if (request.method === "session/resume") {
      for (const update of replayUpdates)
        write({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: "session", update },
        });
      write({ jsonrpc: "2.0", id: request.id, result: {} });
    }
  });
  vi.spyOn(AntigravityAcp, "spawn").mockReturnValue(client);
  const runner = await AntigravityManagedRunner.connect(
    "/synthetic/acp",
    "/synthetic/workspace",
    "session",
    {},
  );
  cleanups.push(() => runner.close());
  const update = (value: Record<string, unknown>) =>
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session", update: value },
    });
  return { runner, client, requests, update, write };
}

describe("ACP offline managed stream", () => {
  it("starts a new report generation after disconnecting and reconnecting", async () => {
    const prior = await acpFixture();
    const priorGeneration = (prior.runner.snapshot().usage as Record<string, unknown>)
      .reportGeneration as number;
    expect(Number.isSafeInteger(priorGeneration)).toBe(true);
    expect(priorGeneration).toBeGreaterThan(0);
    expect(prior.runner.snapshot().usage).toMatchObject({ state: "unavailable" });
    prior.update({ sessionUpdate: "usage_update", used: 800n, size: 1000n });
    prior.update({ sessionUpdate: "usage_update", used: 800n, size: 1000n });
    await vi.waitFor(() =>
      expect(prior.runner.snapshot().usage).toMatchObject({
        reportGeneration: priorGeneration,
        reportId: 2,
        percent: 80,
      }),
    );
    prior.client.shutdown();
    await vi.waitFor(() => expect(prior.runner.snapshot().status).toBe("failed"));
    expect(prior.runner.snapshot().usage).toMatchObject({
      reportGeneration: priorGeneration,
      reportId: 2,
      state: "stale",
    });

    const restored = await acpFixture();
    const restoredGeneration = (restored.runner.snapshot().usage as Record<string, unknown>)
      .reportGeneration as number;
    expect(restoredGeneration).toBeGreaterThan(priorGeneration);
    expect((restored.runner.snapshot().usage as Record<string, unknown>).reportId).toBeUndefined();
    restored.update({ sessionUpdate: "usage_update", used: 50n, size: 1000n });
    await vi.waitFor(() =>
      expect(restored.runner.snapshot().usage).toMatchObject({
        reportGeneration: restoredGeneration,
        reportId: 1,
        percent: 5,
        state: "ready",
      }),
    );
    restored.update(compact("new-stage", "in_progress"));
    await vi.waitFor(() =>
      expect(restored.runner.snapshot().usage).toMatchObject({
        reportGeneration: restoredGeneration,
        reportId: 1,
        state: "pending",
      }),
    );
  });

  it("negotiates compaction, reports bigint context and keeps turn completion separate", async () => {
    const f = await acpFixture();
    expect(f.requests[0].params).toMatchObject({
      protocolVersion: 1n,
      clientCapabilities: { session: { compaction: {} } },
    });
    f.update({ sessionUpdate: "usage_update", used: 250n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({
        state: "ready",
        usedTokens: 250,
        percent: 25,
      }),
    );
    await f.runner.send("hello", Number(f.runner.snapshot().revision));
    const prompt = f.requests.find((request) => request.method === "session/prompt")!;
    expect(f.runner.snapshot().usage).toMatchObject({ state: "pending", usedTokens: 250 });
    f.update(compact("one", "in_progress"));
    await vi.waitFor(() => expect(f.runner.snapshot().activity).toBe("compacting"));
    await expect(f.runner.send("blocked", Number(f.runner.snapshot().revision))).rejects.toThrow(
      "session-compacting",
    );
    f.write({
      jsonrpc: "2.0",
      id: 55n,
      method: "session/request_permission",
      params: {
        sessionId: "session",
        toolCall: {
          toolCallId: "read",
          kind: "read",
          title: "Read file",
          rawInput: { path: "/synthetic/file" },
        },
        options: [{ optionId: "native-allow", name: "Allow once", kind: "allow_once" }],
      },
    });
    await vi.waitFor(() =>
      expect((f.runner.snapshot().approvals as Record<string, unknown>[])[0]?.supported).toBe(true),
    );
    const approval = f.runner.snapshot();
    await f.runner.approve(
      "55",
      String(approval.turnId),
      "native-allow",
      Number(approval.revision),
    );
    expect(f.requests.at(-1)).toMatchObject({
      id: 55n,
      result: { outcome: { outcome: "selected", optionId: "native-allow" } },
    });
    const live = f.runner.snapshot();
    await f.runner.stop(String(live.turnId), Number(live.revision));
    expect(f.requests.at(-1)?.method).toBe("session/cancel");
    f.update(compact("one", "completed"));
    await vi.waitFor(() => expect(f.runner.snapshot().activity).toBeNull());
    expect(f.runner.snapshot().status).toBe("running");
    expect(f.runner.snapshot().usage).toMatchObject({ state: "stale", usedTokens: 250 });
    f.update({ sessionUpdate: "usage_update", used: 1n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().revision).toBeGreaterThan(Number(live.revision) + 1),
    );
    expect(f.runner.snapshot().usage).toMatchObject({ state: "stale", usedTokens: 250 });
    f.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "ordinary",
      content: { type: "text", text: "ordinary output" },
    });
    f.update({ sessionUpdate: "usage_update", used: 100n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({ state: "ready", usedTokens: 100 }),
    );
    f.write({ jsonrpc: "2.0", id: prompt.id, result: { stopReason: "cancelled" } });
    await vi.waitFor(() => expect(f.runner.snapshot().status).toBe("idle"));
    f.runner.close();
    expect(f.runner.snapshot().usage).toMatchObject({ state: "stale", usedTokens: 100 });
    expect(f.runner.snapshot().sendEnabled).toBe(false);
  });
  it("retains pending candidates across consecutive compactions without ordinary output", async () => {
    const f = await acpFixture();
    f.update({ sessionUpdate: "usage_update", used: 250n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({ state: "ready", reportId: 1 }),
    );
    f.update(compact("first", "in_progress"));
    f.update({ sessionUpdate: "usage_update", used: 100n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot()).toMatchObject({
        activity: "compacting",
        sendEnabled: false,
        usage: { state: "pending", usedTokens: 100, reportId: 2 },
      }),
    );
    expect((f.runner.snapshot().usage as Record<string, unknown>).percent).toBeUndefined();
    f.update(compact("first", "completed"));
    await vi.waitFor(() =>
      expect(f.runner.snapshot()).toMatchObject({
        activity: null,
        sendEnabled: true,
        usage: {
          state: "stale",
          reason: "compaction-completed",
          usedTokens: 100,
          reportId: 2,
        },
      }),
    );
    f.update(compact("second", "in_progress"));
    f.update({ sessionUpdate: "usage_update", used: 40n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot()).toMatchObject({
        activity: "compacting",
        sendEnabled: false,
        usage: { state: "pending", usedTokens: 40, reportId: 3 },
      }),
    );
    expect((f.runner.snapshot().usage as Record<string, unknown>).percent).toBeUndefined();
    f.update(compact("second", "completed"));
    await vi.waitFor(() =>
      expect(f.runner.snapshot()).toMatchObject({
        activity: null,
        sendEnabled: true,
        usage: {
          state: "stale",
          reason: "compaction-completed",
          usedTokens: 40,
          reportId: 3,
        },
      }),
    );
    expect((f.runner.snapshot().usage as Record<string, unknown>).percent).toBeUndefined();
    const completedRevision = Number(f.runner.snapshot().revision);
    f.update({ sessionUpdate: "usage_update", used: 1n, size: 1000n });
    await vi.waitFor(() => expect(f.runner.snapshot().revision).toBeGreaterThan(completedRevision));
    expect(f.runner.snapshot().usage).toMatchObject({
      state: "stale",
      usedTokens: 40,
      reportId: 3,
    });
    expect((f.runner.snapshot().usage as Record<string, unknown>).percent).toBeUndefined();
    f.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "ordinary",
      content: { type: "text", text: "ordinary output" },
    });
    f.update({ sessionUpdate: "usage_update", used: 60n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({
        state: "ready",
        usedTokens: 60,
        percent: 6,
        reportId: 4,
      }),
    );
  });
  it("keeps unsafe native counts unavailable without synthesizing zero", async () => {
    const f = await acpFixture();
    f.update({ sessionUpdate: "usage_update", used: 9007199254740992n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({
        available: false,
        reason: "invalid-context-report",
      }),
    );
    expect((f.runner.snapshot().usage as Record<string, unknown>).usedTokens).toBeUndefined();
    expect(f.runner.snapshot().status).toBe("idle");
  });
  it("rechecks compaction at native prompt dispatch after an asynchronous gap", async () => {
    const f = await acpFixture();
    const prompt = f.client.prompt.bind(f.client);
    vi.spyOn(f.client, "prompt").mockImplementationOnce(async (session, text, beforeDispatch) => {
      f.update(compact("race", "in_progress"));
      await vi.waitFor(() => expect(f.runner.snapshot().activity).toBe("compacting"));
      return prompt(session, text, beforeDispatch);
    });
    const dispatch = vi.fn();
    await expect(
      f.runner.send("blocked", Number(f.runner.snapshot().revision), dispatch),
    ).rejects.toThrow("session-compacting");
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.requests.some((request) => request.method === "session/prompt")).toBe(false);
    expect(f.runner.snapshot()).toMatchObject({
      status: "idle",
      activity: "compacting",
      sendEnabled: false,
    });
  });
  it("validates resume compactions without activating a historical execution lock", async () => {
    const f = await acpFixture([
      compact("old", "completed"),
      { sessionUpdate: "usage_update", used: 200n, size: 1000n },
      compact("current", "in_progress"),
      chunk("current", "draft"),
    ]);
    expect(f.runner.snapshot()).toMatchObject({
      status: "idle",
      activity: null,
      sendEnabled: true,
      usage: { state: "stale", usedTokens: 200 },
    });
    expect((f.runner.snapshot().usage as Record<string, unknown>).percent).toBeUndefined();
    f.update(compact("current", "in_progress"));
    await vi.waitFor(() =>
      expect(f.runner.snapshot()).toMatchObject({ activity: "compacting", sendEnabled: false }),
    );
  });
  it("revokes a prior model report until ordinary work and a new native usage report", async () => {
    const f = await acpFixture();
    f.update({ sessionUpdate: "usage_update", used: 200n, size: 1000n });
    await vi.waitFor(() => expect(f.runner.snapshot().usage).toMatchObject({ state: "ready" }));
    f.update({ sessionUpdate: "current_model_update", currentModelId: "other" });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({
        state: "stale",
        reason: "model-context-changed",
      }),
    );
    f.update({ sessionUpdate: "usage_update", used: 1n, size: 2000n });
    f.update({
      sessionUpdate: "agent_message_chunk",
      messageId: "ordinary",
      content: { type: "text", text: "new model" },
    });
    f.update({ sessionUpdate: "usage_update", used: 50n, size: 2000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({
        state: "ready",
        usedTokens: 50,
        contextWindow: 2000,
        percent: 2.5,
      }),
    );
  });
  it("retains a compaction candidate while awaiting ordinary context after a model change", async () => {
    const f = await acpFixture();
    f.update({ sessionUpdate: "usage_update", used: 200n, size: 1000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({ state: "ready", reportId: 1 }),
    );
    f.update({ sessionUpdate: "current_model_update", currentModelId: "other" });
    await vi.waitFor(() =>
      expect(f.runner.snapshot().usage).toMatchObject({
        state: "stale",
        reason: "model-context-changed",
      }),
    );
    f.update(compact("new-model", "in_progress"));
    f.update({ sessionUpdate: "usage_update", used: 80n, size: 2000n });
    await vi.waitFor(() =>
      expect(f.runner.snapshot()).toMatchObject({
        activity: "compacting",
        sendEnabled: false,
        usage: { state: "pending", usedTokens: 80, contextWindow: 2000, reportId: 2 },
      }),
    );
    expect((f.runner.snapshot().usage as Record<string, unknown>).percent).toBeUndefined();
    f.update(compact("new-model", "completed"));
    await vi.waitFor(() =>
      expect(f.runner.snapshot()).toMatchObject({
        activity: null,
        sendEnabled: true,
        usage: {
          state: "stale",
          reason: "compaction-completed",
          usedTokens: 80,
          contextWindow: 2000,
          reportId: 2,
        },
      }),
    );
    expect((f.runner.snapshot().usage as Record<string, unknown>).percent).toBeUndefined();
  });
});
