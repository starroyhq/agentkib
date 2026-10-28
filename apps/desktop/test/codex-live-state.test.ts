import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import { CodexFollowerConnection } from "../../../packages/backend/src/codex-follower-connection";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexFollowerState } from "../../../packages/backend/src/codex-follower-state";
import {
  ManagedCodexEventBridge,
  ManagedCodexState,
} from "../../../packages/backend/src/managed-codex-state";
import { versionAtLeast } from "../../../packages/backend/src/native-version";

const threadId = "01234567-89ab-cdef-0123-456789abcdef";
const report = (used = 20, window: number | null = 100) => ({
  last: { totalTokens: used },
  total: { totalTokens: 9876 },
  modelContextWindow: window,
});
function managed(saved = {}) {
  return new ManagedCodexState({
    id: "managed",
    workspace_id: "workspace",
    workspace: "/fixture",
    native_id: threadId,
    ...saved,
  });
}
function notify(state: ManagedCodexState, method: string, params: Record<string, unknown> = {}) {
  return state.apply({ method, params: { threadId, ...params } });
}
function start(state: ManagedCodexState, id = "turn-a") {
  notify(state, "turn/started", { turn: { id, status: "inProgress" } });
}
function compact(
  state: ManagedCodexState,
  method = "item/started",
  id = "compact-a",
  turnId = "turn-a",
) {
  return notify(state, method, { turnId, item: { id, type: "contextCompaction" } });
}
function usage(state: ManagedCodexState, raw = report(), turnId: string | null = "turn-a") {
  return notify(state, "thread/tokenUsage/updated", { turnId, tokenUsage: raw });
}
function snapshot(turns: unknown[] = [], raw: unknown = report()) {
  return {
    id: threadId,
    hostId: "local",
    threadRuntimeStatus: { type: turns.length ? "active" : "idle" },
    turns,
    requests: [],
    latestTokenUsageInfo: raw,
  };
}
const turn = (id = "turn-a", items: unknown[] = [], status = "inProgress") => ({
  turnId: id,
  status,
  items,
});
const compaction = (id = "compact-a", completed = false) => ({
  id,
  type: "contextCompaction",
  completed,
});
function frame(revision: number, change: Record<string, unknown>) {
  return {
    type: "broadcast",
    method: "thread-stream-state-changed",
    version: 11,
    sourceClientId: "owner",
    params: { conversationId: threadId, hostId: "local", change: { revision, ...change } },
  };
}
function full(state: CodexFollowerState, revision: number, body = snapshot()) {
  state.notification(frame(revision, { type: "snapshot", conversationState: body }));
}
function patches(state: CodexFollowerState, revision: number, values: unknown[]) {
  state.notification(
    frame(revision, { type: "patches", baseRevision: revision - 1, patches: values }),
  );
}
const usageOf = (live: Record<string, unknown>) => live.usage as Record<string, unknown>;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex Desktop application minimums", () => {
  it.each([
    ["26.917.62050", false, false],
    ["26.917.62051", true, false],
    ["26.924.22137", true, false],
    ["26.924.22138", true, true],
    ["26.930.51102", true, true],
    ["27.0.0", true, true],
    ["26.930.51102-beta", false, false],
    ["26.930", false, false],
    ["26.930.9007199254740992", false, false],
  ])(
    "checks %s numerically while keeping per-method protocol versions",
    (version, basic, settings) => {
      expect(versionAtLeast(version, "26.917.62051")).toBe(basic);
      const socket = { on() {}, destroyed: false };
      const connection = Reflect.construct(CodexFollowerConnection, [
        socket,
        version,
        "/fixture/ipc.sock",
      ]) as CodexFollowerConnection;
      expect(connection.supportsThreadSettings).toBe(settings);
    },
  );
});

describe("managed Codex activity and context usage", () => {
  it("projects last-report occupancy, retains cumulative consumption and does not turn every revision into a report", () => {
    const state = managed();
    start(state);
    usage(state);
    const first = usageOf(state.snapshot("boot", true));
    expect(first).toMatchObject({
      available: true,
      state: "ready",
      usedTokens: 20,
      totalTokens: 9876,
      contextWindow: 100,
      percent: 20,
      reportId: 1,
    });
    notify(state, "thread/settings/updated", { threadSettings: {} });
    notify(state, "item/agentMessage/delta", { turnId: "turn-a", delta: "text" });
    const next = usageOf(state.snapshot("boot", true));
    expect(next.reportId).toBe(1);
    expect(next.updatedAt).toBe(first.updatedAt);
    expect(next.revision).toBeGreaterThan(first.revision as number);
    expect(state.snapshot("boot", true).tokenUsage).toEqual(report());
  });

  it("keeps zero occupancy and missing/invalid window as supported incomplete reports", () => {
    const state = managed();
    start(state);
    usage(state, report(0));
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      state: "ready",
      usedTokens: 0,
      percent: 0,
    });
    usage(state, report(20, null));
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      available: true,
      state: "pending",
      usedTokens: 20,
    });
    expect(usageOf(state.snapshot("boot", true))).not.toHaveProperty("percent");
  });

  it("invalidates model selection while retaining unrelated settings and waits for applied model reports", () => {
    const state = managed({ model: "model-a", native_settings: { model: "model-a" } });
    start(state);
    usage(state);
    notify(state, "thread/settings/updated", {
      threadSettings: { model: "model-a", effort: "high" },
    });
    state.commitManagedMutation({ effort: "high" });
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({ state: "ready", reportId: 1 });
    state.commitManagedMutation({ model: "model-b" });
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      state: "stale",
      usedTokens: 20,
      reportId: 1,
    });
    notify(state, "turn/completed", { turn: { id: "turn-a", status: "completed" } });
    start(state, "turn-b");
    usage(state, report(30), "turn-b");
    expect(usageOf(state.snapshot("boot", true)).state).toBe("stale");
    notify(state, "thread/settings/updated", { threadSettings: { model: "model-b" } });
    usage(state, report(30), "turn-b");
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      state: "ready",
      reportId: 3,
      percent: 30,
    });
  });

  it("invalidates native effective model changes without treating metadata revisions as reports", () => {
    const state = managed({ native_settings: { model: "model-a" } });
    start(state);
    usage(state);
    notify(state, "thread/settings/updated", { threadSettings: { model: "model-b" } });
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({ state: "stale", reportId: 1 });
    usage(state, report(30));
    expect(usageOf(state.snapshot("boot", true)).state).toBe("stale");
    notify(state, "turn/completed", { turn: { id: "turn-a", status: "completed" } });
    start(state, "turn-b");
    usage(state, report(30), "turn-b");
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({ state: "ready", reportId: 3 });
  });

  it("tracks overlapping stages and preserves stop without changing the native turn lifecycle", () => {
    const state = managed();
    start(state);
    usage(state);
    compact(state);
    compact(state, "item/started", "compact-b");
    expect(state.snapshot("boot", true)).toMatchObject({
      activity: "compacting",
      status: "running",
      turnId: "turn-a",
      sendEnabled: false,
      stopEnabled: true,
    });
    compact(state, "item/completed");
    expect(state.activity).toBe("compacting");
    compact(state, "item/completed", "compact-b");
    expect(state.activity).toBeNull();
    expect(state.status).toBe("running");
    expect(compact(state, "item/started").changed).toBe(false);
  });

  it("retains usage arriving before completion, then restores fresh usage only on a subsequent known turn", () => {
    const state = managed();
    start(state);
    usage(state);
    compact(state);
    usage(state, report(80));
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      state: "pending",
      reportId: 2,
      usedTokens: 80,
    });
    compact(state, "item/completed");
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      state: "stale",
      reportId: 2,
      usedTokens: 80,
    });
    expect(usageOf(state.snapshot("boot", true))).not.toHaveProperty("percent");
    usage(state, report(15));
    expect(usageOf(state.snapshot("boot", true)).state).toBe("stale");
    notify(state, "turn/completed", { turn: { id: "turn-a", status: "completed" } });
    start(state, "turn-b");
    usage(state, report(15), "turn-b");
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      state: "ready",
      reportId: 4,
      percent: 15,
    });
    expect(usage(state, report(90), "turn-a").changed).toBe(false);
  });

  it("does not invent a turn for a manual compaction item before turn/started", () => {
    const state = managed();
    state.hydrate({ id: threadId, turns: [], status: { type: "idle" } });
    compact(state);
    expect(state.snapshot("boot", true)).toMatchObject({
      activity: "compacting",
      turnId: null,
      sendEnabled: false,
      stopEnabled: false,
    });
    expect(() => state.acceptStartedTurn("fabricated", state.revision)).toThrow(
      "stale-or-disabled-control",
    );
    start(state);
    expect(state.activity).toBe("compacting");
  });

  it.each(["completed", "failed", "interrupted"])(
    "clears activity on native terminal turn %s and rejects delayed starts",
    (status) => {
      const state = managed();
      start(state);
      compact(state);
      notify(state, "turn/completed", { turn: { id: "turn-a", status } });
      expect(state.activity).toBeNull();
      expect(state.turnId).toBeNull();
      expect(compact(state).changed).toBe(false);
    },
  );

  it("rejects unrelated thread reports and marks disconnected reports stale", () => {
    const state = managed();
    start(state);
    usage(state);
    compact(state);
    expect(
      notify(state, "thread/tokenUsage/updated", {
        threadId: "other",
        turnId: "turn-a",
        tokenUsage: report(90),
      }).changed,
    ).toBe(false);
    notify(state, "agentkib/disconnected");
    expect(state.snapshot("boot", true)).toMatchObject({
      status: "outcome-unknown",
      activity: null,
      sendEnabled: false,
      stopEnabled: false,
    });
    expect(usageOf(state.snapshot("boot", true))).toMatchObject({
      state: "stale",
      usedTokens: 20,
      reportId: 1,
    });
  });

  it("fences stale hydrate replies while permitting metadata-only updates", () => {
    const state = managed();
    const readRevision = state.revision;
    start(state);
    compact(state);
    state.hydrate({ id: threadId, turns: [], status: { type: "idle" } }, true, readRevision);
    expect(state.snapshot("boot", true)).toMatchObject({
      turnId: "turn-a",
      status: "running",
      activity: "compacting",
    });
    const terminalRead = state.revision;
    state.hydrate(
      { id: threadId, turns: [{ id: "turn-a", status: "completed", items: [] }] },
      true,
      terminalRead,
    );
    expect(state.activity).toBeNull();
    expect(state.turnId).toBeNull();
    expect(compact(state).changed).toBe(false);
    start(state, "turn-b");
    const metadataRead = state.revision;
    usage(state, report(), "turn-b");
    state.hydrate({ id: threadId, turns: [] }, true, metadataRead);
    expect(state.status).toBe("idle");
    expect(usageOf(state.snapshot("boot", true)).reportId).toBe(1);
  });

  it("does not resurrect a completed turn through an earlier read", () => {
    const state = managed();
    start(state);
    const readRevision = state.revision;
    notify(state, "turn/completed", { turn: { id: "turn-a", status: "completed" } });
    state.hydrate(
      { id: threadId, turns: [{ id: "turn-a", status: "inProgress", items: [] }] },
      true,
      readRevision,
    );
    expect(state.status).toBe("idle");
    expect(state.turnId).toBeNull();
  });

  it("treats a saved active compaction as recovery evidence rather than current activity", () => {
    const state = managed({
      token_usage: report(),
      snapshot: { activity: "compacting", turnId: "turn-a" },
    });
    state.hydrate({
      id: threadId,
      turns: [
        { id: "turn-a", status: "inProgress", items: [{ id: "old", type: "contextCompaction" }] },
      ],
    });
    expect(state.snapshot("boot", true)).toMatchObject({
      activity: null,
      status: "outcome-unknown",
      reason: "compaction-state-unconfirmed",
      stopEnabled: false,
    });
    compact(state, "item/completed");
    expect(state.reason).toBeNull();
    expect(state.status).toBe("running");
  });

  it("does not use a compaction completion to clear unrelated unknown outcomes", () => {
    const state = managed({ snapshot: { activity: "compacting", turnId: "turn-a" } });
    state.hydrate({ id: threadId, turns: [{ id: "turn-a", status: "inProgress", items: [] }] });
    state.fail("control-outcome-unconfirmed");
    compact(state, "item/completed");
    expect(state.snapshot("boot", true)).toMatchObject({
      status: "outcome-unknown",
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
      stopEnabled: false,
    });
  });
});

// The order and shape of what CLI 0.163.0 sent while a local stub failed every request: each
// retry, the thread's idle error flag, the final error, then the failed completion.
describe("managed Codex failed turns", () => {
  const retry = (attempt: number, detail: string, status: number | null = null) => ({
    error: {
      message: `Reconnecting... ${attempt}/2`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: status } },
      additionalDetails: detail,
      misalignment: null,
    },
    willRetry: true,
    turnId: "turn-a",
  });
  const unauthorized =
    "unexpected status 401 Unauthorized: invalid key, url: http://127.0.0.1:1/v1/responses";
  const failedTurn = (error: unknown = { message: unauthorized }) => ({
    turn: {
      id: "turn-a",
      status: "failed",
      error,
      completedAt: 1_793_174_557,
      durationMs: 783,
    },
  });

  it("reports retries, then ends the turn with the CLI's error and stays usable", () => {
    const state = managed();
    start(state);
    const before = state.mutationRevision;
    notify(state, "error", retry(1, unauthorized, 401));
    expect(state.snapshot("boot", true).apiRetry).toEqual({
      attempt: 1,
      maxRetries: 2,
      status: 401,
      error: "responseStreamDisconnected",
      detail: unauthorized,
    });
    notify(state, "error", retry(2, unauthorized, 401));
    expect(state.snapshot("boot", true).apiRetry).toMatchObject({ attempt: 2, maxRetries: 2 });
    // Retries are observations, not control changes.
    expect(state.mutationRevision).toBe(before);
    expect(notify(state, "thread/status/changed", { status: { type: "systemError" } })).toEqual({
      changed: false,
    });
    notify(state, "error", {
      error: {
        message: unauthorized,
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } },
      },
      willRetry: false,
      turnId: "turn-a",
    });
    expect(state.snapshot("boot", true).apiRetry).toBeNull();
    const ended = notify(state, "turn/completed", failedTurn());
    expect(ended.event).toEqual({
      id: "codex-turn-error:turn-a",
      kind: "agent-message",
      turn_id: "turn-a",
      timestamp: expect.any(String),
      content: unauthorized,
      tool_name: null,
      tool_status: null,
      duration_ms: null,
      attachment_count: 0,
      truncated: false,
      cli_output: true,
      turn_meta: { outcome: "failed", duration_ms: 783 },
    });
    expect(state.snapshot("boot", true)).toMatchObject({
      status: "idle",
      reason: null,
      sendEnabled: true,
      apiRetry: null,
    });
  });

  it("clears a retry once output arrives", () => {
    const state = managed();
    start(state);
    notify(state, "error", retry(1, "We’re currently experiencing high demand."));
    expect(state.snapshot("boot", true).apiRetry).toMatchObject({ attempt: 1, status: null });
    notify(state, "item/started", {
      turnId: "turn-a",
      item: { type: "userMessage", id: "u", content: [] },
    });
    expect(state.snapshot("boot", true).apiRetry).not.toBeNull();
    notify(state, "item/agentMessage/delta", { turnId: "turn-a", itemId: "m", delta: "Hi" });
    expect(state.snapshot("boot", true).apiRetry).toBeNull();
    notify(state, "error", retry(1, "again"));
    notify(state, "item/started", {
      turnId: "turn-a",
      item: { type: "reasoning", id: "r", summary: [], content: [] },
    });
    expect(state.snapshot("boot", true).apiRetry).toBeNull();
    // Another turn's report is not this turn's retry.
    expect(notify(state, "error", { ...retry(1, "x"), turnId: "turn-b" }).changed).toBe(false);
    expect(state.snapshot("boot", true).apiRetry).toBeNull();
  });

  it("uses the final error when the completion carries none, and keeps details", () => {
    const state = managed();
    start(state);
    notify(state, "error", {
      error: {
        message: "Stream failed.",
        additionalDetails: "upstream closed",
        codexErrorInfo: "other",
      },
      willRetry: false,
      turnId: "turn-a",
    });
    expect(notify(state, "turn/completed", failedTurn(null)).event).toMatchObject({
      id: "codex-turn-error:turn-a",
      content: "Stream failed.\nupstream closed",
      turn_meta: { outcome: "failed" },
    });
    // A completed or interrupted turn ends as before.
    start(state, "turn-b");
    notify(state, "item/completed", {
      turnId: "turn-b",
      item: { type: "agentMessage", id: "m", text: "Done." },
    });
    expect(
      notify(state, "turn/completed", {
        turn: { id: "turn-b", status: "completed", durationMs: 5 },
      }).event,
    ).toMatchObject({ id: "m", turn_meta: { outcome: "completed", duration_ms: 5 } });
  });

  it("restores the error row of a failed turn from the native thread", () => {
    const state = managed();
    const { events } = state.hydrate({
      id: threadId,
      status: { type: "systemError" },
      turns: [
        {
          id: "turn-a",
          status: "failed",
          error: { message: unauthorized, codexErrorInfo: "unauthorized" },
          completedAt: 1_793_174_557,
          durationMs: 783,
          items: [{ type: "userMessage", id: "u", content: [{ type: "text", text: "Hello" }] }],
        },
      ],
    });
    expect(events.map((event) => [event.id, event.turn_meta ?? null])).toEqual([
      ["u", null],
      ["codex-turn-error:turn-a", { outcome: "failed", duration_ms: 783 }],
    ]);
    expect(state.snapshot("boot", true)).toMatchObject({ status: "idle", reason: null });
  });
});

// Requests as CLI 0.163.0 sent them while a local MCP stub ran its tools.
describe("managed Codex server requests", () => {
  const elicitation = (id: number | string, params: Record<string, unknown>) => ({
    id,
    method: "mcpServer/elicitation/request",
    params: { threadId, turnId: "turn-a", serverName: "stubmcp", _meta: null, ...params },
  });
  const toolApproval = elicitation(7, {
    mode: "form",
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_title: "Write stub record",
      tool_description: "Stub tool that changes a stub record.",
      tool_params: { name: "x" },
      tool_params_display: [],
    },
    message: 'Allow the stubmcp MCP server to run tool "write"?',
    requestedSchema: { type: "object", properties: {} },
  });

  it("shows the approval Codex asks before an MCP tool runs", () => {
    const state = managed();
    start(state);
    expect(state.apply(toolApproval)).toEqual({ changed: true });
    const live = state.snapshot("boot", true);
    expect(live).toMatchObject({ status: "awaiting-approval", stopEnabled: true });
    const [approval] = live.approvals as Record<string, unknown>[];
    expect(approval).toMatchObject({
      requestId: 7,
      turnId: "turn-a",
      method: "mcpServer/elicitation/request",
      toolName: "stubmcp · Write stub record",
      input: {
        kind: "tool-approval",
        server: "stubmcp",
        message: 'Allow the stubmcp MCP server to run tool "write"?',
        tool: "Write stub record",
        description: "Stub tool that changes a stub record.",
        params: { name: "x" },
      },
      availableDecisions: ["accept", "decline", "cancel"],
      supported: true,
      requiresExtendedApproval: false,
    });
    // "Always" would write the user's Codex config; only this session is offered.
    expect(approval!.decisionOptions).toEqual([
      expect.objectContaining({ label: "accept", decision: { action: "accept", content: {} } }),
      expect.objectContaining({
        label: "acceptForSession",
        scope: "session",
        decision: { action: "accept", content: {}, _meta: { persist: "session" } },
      }),
      expect.objectContaining({ label: "decline", decision: { action: "decline" } }),
      expect.objectContaining({ label: "cancel", decision: { action: "cancel" } }),
    ]);
    notify(state, "serverRequest/resolved", { requestId: 7 });
    expect(state.snapshot("boot", true)).toMatchObject({ status: "running", approvals: [] });
    expect(state.hasResolvedRequest("turn-a", 7)).toBe(true);
  });

  it("offers only declining for a form with fields or a link", () => {
    const state = managed();
    start(state);
    state.apply(
      elicitation("form", {
        mode: "form",
        message: "Pick a color for the stub.",
        requestedSchema: {
          type: "object",
          properties: { color: { type: "string", enum: ["red", "blue"], title: "Color" } },
          required: ["color"],
        },
      }),
    );
    state.apply(
      elicitation("link", {
        mode: "url",
        message: "Open the stub page to finish.",
        url: "https://example.invalid/stub",
        elicitationId: "stub-elicitation-1",
      }),
    );
    state.apply(
      elicitation("confirm", {
        mode: "form",
        message: "Continue?",
        requestedSchema: { type: "object", properties: {} },
      }),
    );
    expect(
      (state.snapshot("boot", true).approvals as Record<string, unknown>[]).map((approval) => [
        approval.requestId,
        (approval.input as Record<string, unknown>).kind,
        approval.availableDecisions,
        approval.decisionOptions,
      ]),
    ).toEqual([
      ["form", "form", ["decline"], undefined],
      ["link", "url", ["decline"], undefined],
      // A server's own confirmation; cancelling only dismisses it, so it is not offered.
      ["confirm", "confirmation", ["accept", "decline"], undefined],
    ]);
    const [form, link] = state.snapshot("boot", true).approvals as Record<string, any>[];
    expect(form!.input.fields).toEqual([{ name: "color", title: "Color" }]);
    expect(link!.input.url).toBe("https://example.invalid/stub");
  });

  it("declines a request it cannot show with the running turn", () => {
    const state = managed();
    expect(state.apply(toolApproval)).toEqual({
      changed: false,
      reply: { id: 7, result: { action: "decline" } },
    });
    start(state);
    expect(
      state.apply({ ...toolApproval, params: { ...toolApproval.params, turnId: "turn-b" } }),
    ).toMatchObject({ reply: { result: { action: "decline" } } });
    expect(state.snapshot("boot", true).approvals).toEqual([]);
  });

  it("answers any other request with an error instead of waiting forever", () => {
    const state = managed();
    start(state);
    const revision = state.revision;
    expect(
      state.apply({
        id: 9,
        method: "item/tool/call",
        params: { threadId, turnId: "turn-a", callId: "c", tool: "x", arguments: {} },
      }),
    ).toEqual({
      changed: false,
      reply: {
        id: 9,
        error: { code: -32601, message: "AgentKib does not handle item/tool/call" },
      },
    });
    expect(state.revision).toBe(revision);
    expect(state.snapshot("boot", true)).toMatchObject({
      status: "running",
      reason: null,
      approvals: [],
    });
  });

  it("sends those replies through the app-server session", async () => {
    const session = Object.assign(new EventEmitter(), {
      connected: true,
      respond: vi.fn(),
      respondError: vi.fn(),
      close: vi.fn(async () => {}),
    });
    const state = managed();
    const bridge = new ManagedCodexEventBridge(
      session as unknown as CodexAppServerSession,
      state,
      () => {},
    );
    session.emit("serverRequest", toolApproval);
    session.emit("notification", {
      method: "turn/started",
      params: { threadId, turn: { id: "turn-a", status: "inProgress" } },
    });
    session.emit("serverRequest", { id: 9, method: "attestation/generate", params: {} });
    await bridge.flush();
    expect(session.respond).toHaveBeenCalledExactlyOnceWith(7, { action: "decline" });
    expect(session.respondError).toHaveBeenCalledExactlyOnceWith(
      9,
      -32601,
      "AgentKib does not handle attestation/generate",
    );
    expect(state.snapshot("boot", true)).toMatchObject({ status: "running", reason: null });
  });
});

describe("Codex follower activity and usage", () => {
  it("separates fresh observer reports from the prior report counter", () => {
    const prior = new CodexFollowerState(threadId, "owner");
    const priorGeneration = usageOf(prior.live(true)).reportGeneration as number;
    expect(Number.isSafeInteger(priorGeneration)).toBe(true);
    expect(priorGeneration).toBeGreaterThan(0);
    full(prior, 1, snapshot([turn()], report(80)));
    patches(prior, 2, [{ op: "replace", path: ["latestTokenUsageInfo"], value: report(80) }]);
    prior.invalidate("disconnected");
    expect(usageOf(prior.live(true))).toMatchObject({
      reportGeneration: priorGeneration,
      reportId: 2,
      state: "stale",
    });

    const restored = new CodexFollowerState(threadId, "owner");
    const restoredGeneration = usageOf(restored.live(true)).reportGeneration as number;
    expect(restoredGeneration).toBeGreaterThan(priorGeneration);
    expect(usageOf(restored.live(true))).toMatchObject({ reportId: 0, state: "pending" });
    full(restored, 1, snapshot([turn("turn-b")], report(5)));
    expect(usageOf(restored.live(true))).toMatchObject({
      reportGeneration: restoredGeneration,
      reportId: 1,
      percent: 5,
      state: "ready",
    });
    patches(restored, 2, [{ op: "add", path: ["turns", 0, "items", 0], value: compaction() }]);
    expect(usageOf(restored.live(true))).toMatchObject({
      reportGeneration: restoredGeneration,
      reportId: 1,
      state: "pending",
    });
  });

  it("uses native unfinished items, including canonical history, and retains strict stop", () => {
    const state = new CodexFollowerState(threadId, "owner");
    const body = snapshot([], report());
    Object.assign(body, {
      turnHistory: {
        kind: "canonical",
        history: {
          entitiesByKey: { a: turn("turn-a", [compaction()]) },
          islands: [{ entries: [{ value: "a" }] }],
        },
      },
    });
    full(state, 1, body);
    expect(state.live(true)).toMatchObject({
      activity: "compacting",
      status: "running",
      sendEnabled: false,
      stopEnabled: true,
    });
    expect(usageOf(state.live(true)).state).toBe("pending");
    expect(() => state.assertMutationAllowed("thread-follower-start-turn", {}, 1)).toThrow(
      "session-compacting",
    );
    expect(() =>
      state.assertMutationAllowed(
        "thread-follower-interrupt-turn",
        { expectedTurnId: "turn-a" },
        1,
      ),
    ).not.toThrow();
  });

  it("keeps same numeric usage patches as new reports but not snapshot-only revisions", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1, snapshot([turn()]));
    expect(usageOf(state.live(true))).toMatchObject({ state: "ready", reportId: 1 });
    full(state, 2, snapshot([turn()]));
    expect(usageOf(state.live(true)).reportId).toBe(1);
    patches(state, 3, [{ op: "replace", path: ["latestTokenUsageInfo"], value: report() }]);
    expect(usageOf(state.live(true)).reportId).toBe(2);
  });

  it("retains pre-completion candidates and requires an attributable later-turn report for Gauge", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1, snapshot([turn()]));
    patches(state, 2, [{ op: "add", path: ["turns", 0, "items", 0], value: compaction() }]);
    patches(state, 3, [{ op: "replace", path: ["latestTokenUsageInfo"], value: report(70) }]);
    patches(state, 4, [
      { op: "replace", path: ["turns", 0, "items", 0, "completed"], value: true },
    ]);
    expect(state.activity).toBeNull();
    expect(usageOf(state.live(true))).toMatchObject({
      state: "stale",
      usedTokens: 70,
      reportId: 2,
    });
    full(state, 5, snapshot([turn("turn-b")], report(70)));
    expect(usageOf(state.live(true)).state).toBe("stale");
    patches(state, 6, [{ op: "replace", path: ["latestTokenUsageInfo"], value: report(70) }]);
    expect(usageOf(state.live(true))).toMatchObject({ state: "ready", percent: 70, reportId: 3 });
  });

  it("invalidates an old Gauge when a completed compaction is first observed", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1, snapshot([turn()]));
    patches(state, 2, [
      { op: "add", path: ["turns", 0, "items", 0], value: compaction("missed-start", true) },
    ]);
    expect(state.activity).toBeNull();
    expect(usageOf(state.live(true))).toMatchObject({
      state: "stale",
      reportId: 1,
      usedTokens: 20,
    });
    expect(usageOf(state.live(true))).not.toHaveProperty("percent");
    full(state, 3, snapshot([turn("turn-b")], report()));
    patches(state, 4, [{ op: "replace", path: ["latestTokenUsageInfo"], value: report() }]);
    expect(usageOf(state.live(true))).toMatchObject({ state: "ready", reportId: 2 });
  });

  it("does not attribute a report from a different native turn to current context", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1, snapshot([turn("turn-a", [compaction("done", true)])]));
    full(state, 2, snapshot([turn("turn-b")], report()));
    patches(state, 3, [
      {
        op: "replace",
        path: ["latestTokenUsageInfo"],
        value: { ...report(90), turnId: "unrelated" },
      },
    ]);
    expect(usageOf(state.live(true))).toMatchObject({ state: "stale", reportId: 2 });
    patches(state, 4, [
      { op: "replace", path: ["latestTokenUsageInfo"], value: { ...report(15), turnId: "turn-b" } },
    ]);
    expect(usageOf(state.live(true))).toMatchObject({ state: "ready", reportId: 3, percent: 15 });
  });

  it("keeps overlapping native stages pending until all unfinished items complete", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1, snapshot([turn("turn-a", [compaction("a"), compaction("b")])]));
    patches(state, 2, [
      { op: "replace", path: ["turns", 0, "items", 0, "completed"], value: true },
    ]);
    expect(state.activity).toBe("compacting");
    patches(state, 3, [
      { op: "replace", path: ["turns", 0, "items", 1, "completed"], value: true },
    ]);
    expect(state.activity).toBeNull();
    expect(usageOf(state.live(true)).state).toBe("stale");
  });

  it("preserves report identity and a stale barrier across same-thread reselection", () => {
    const prior = new CodexFollowerState(threadId, "owner");
    full(prior, 1, snapshot([turn("turn-a", [compaction("done", true)])]));
    prior.invalidate("disconnected");
    const restored = new CodexFollowerState(threadId, "new-owner", prior.usageRecovery());
    const restoredGeneration = usageOf(restored.live(true)).reportGeneration as number;
    expect(restoredGeneration).toBeGreaterThan(
      usageOf(prior.live(true)).reportGeneration as number,
    );
    const reportFromOwner = (revision: number, body: ReturnType<typeof snapshot>) =>
      restored.notification({
        ...frame(revision, { type: "snapshot", conversationState: body }),
        sourceClientId: "new-owner",
      });
    reportFromOwner(1, snapshot([turn("turn-b")], report()));
    expect(usageOf(restored.live(true))).toMatchObject({
      state: "stale",
      reportId: 1,
      reportGeneration: restoredGeneration,
    });
    restored.notification({
      ...frame(2, {
        type: "patches",
        baseRevision: 1,
        patches: [{ op: "replace", path: ["latestTokenUsageInfo"], value: report() }],
      }),
      sourceClientId: "new-owner",
    });
    expect(usageOf(restored.live(true))).toMatchObject({
      state: "ready",
      reportId: 2,
      reportGeneration: restoredGeneration,
    });
  });

  it("invalidates effective model identity, including native settings precedence", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1, Object.assign(snapshot([turn()]), { latestModel: "model-a" }));
    patches(state, 2, [{ op: "replace", path: ["latestModel"], value: "model-b" }]);
    expect(usageOf(state.live(true))).toMatchObject({ state: "stale", reportId: 1 });
    full(
      state,
      3,
      Object.assign(snapshot([turn("turn-b")]), {
        latestModel: "model-b",
        latestThreadSettings: { model: "model-b" },
      }),
    );
    patches(state, 4, [{ op: "replace", path: ["latestTokenUsageInfo"], value: report(30) }]);
    expect(usageOf(state.live(true))).toMatchObject({ state: "ready", reportId: 2 });
    patches(state, 5, [{ op: "replace", path: ["latestModel"], value: "fallback-model" }]);
    expect(usageOf(state.live(true)).state).toBe("ready");
    patches(state, 6, [
      { op: "replace", path: ["latestThreadSettings", "model"], value: "model-c" },
    ]);
    expect(usageOf(state.live(true))).toMatchObject({ state: "stale", reportId: 2 });
  });

  it("does not count historic/missing phase items as active or fabricate a manual turn", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1, snapshot([turn("turn-a", [compaction()], "interrupted")]));
    expect(state.activity).toBeNull();
    const pending = new CodexFollowerState(threadId, "owner");
    full(
      pending,
      1,
      snapshot([
        {
          turnId: null,
          status: "inProgress",
          items: [compaction("pending-manual-context-compaction")],
        },
      ]),
    );
    expect(pending.live(true)).toMatchObject({
      activity: "compacting",
      stopEnabled: false,
      sendEnabled: false,
    });
  });

  it("invalidates on wrong stream version/revision or owner reset without restoring old Gauge", () => {
    const state = new CodexFollowerState(threadId, "owner");
    full(state, 1);
    state.notification({
      ...frame(2, { type: "snapshot", conversationState: snapshot() }),
      version: 12,
    });
    expect(state.revision).toBeNull();
    expect(usageOf(state.live(true)).state).toBe("stale");
    full(state, 3);
    expect(state.revision).toBeNull();
    const reset = new CodexFollowerState(threadId, "owner");
    full(reset, 1, snapshot([turn("turn-a", [compaction()])]));
    reset.notification({
      type: "broadcast",
      method: "ipc-connection-reset",
      sourceClientId: "owner",
      params: {},
    });
    expect(reset.activity).toBeNull();
    expect(reset.live(true).sendEnabled).toBe(false);
  });
});

describe("follower final dispatch compaction gate", () => {
  it("rechecks a state change immediately before the socket write callback", async () => {
    const received: unknown[] = [frame(1, { type: "snapshot", conversationState: snapshot() })];
    let bridge: CodexFollowerBridge;
    const sent: string[] = [];
    const connection = {
      clientId: "follower",
      connected: true,
      supportsThreadSettings: true,
      disconnect() {},
      broadcast: vi.fn(async () => {}),
      receive: vi.fn(async () => received.shift() ?? null),
      request: vi.fn(
        async (
          method: string,
          _params: unknown,
          _owner?: string,
          _notification?: unknown,
          dispatch?: () => void,
        ) => {
          if (method === "thread-owner-discovery") return { handledByClientId: "owner" };
          full(bridge.selectedState!, 2, snapshot([turn("turn-a", [compaction()])]));
          dispatch?.();
          sent.push(method);
          return { method, handledByClientId: "owner", result: {} };
        },
      ),
    };
    vi.spyOn(CodexFollowerConnection, "connectInstalled").mockResolvedValue(
      connection as unknown as CodexFollowerConnection,
    );
    bridge = await CodexFollowerBridge.connect("/fixture/ipc.sock", threadId);
    const dispatch = vi.fn();
    await expect(bridge.mutate("thread-follower-start-turn", {}, 1, dispatch)).rejects.toThrow(
      "session-compacting",
    );
    expect(sent).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    bridge.close();
  });
});
