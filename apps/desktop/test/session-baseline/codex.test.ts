// @vitest-environment node
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  RUNTIME_METHODS,
  sessionProviderDeclaration,
  type SessionActivity,
  type SessionSubscription,
} from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "../../../../packages/backend/src/codex-app-server";
import { CodexDesktopApp } from "../../../../packages/backend/src/codex-desktop-app";
import { CodexFollowerBridge } from "../../../../packages/backend/src/codex-follower-bridge";
import { CodexRuntimePreflight } from "../../../../packages/backend/src/codex-runtime-preflight";
import { startBackend, startHost } from "./harness";

const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const turnId = "offline-turn";
const textInput = (text: string) => [{ type: "text", text }];
const model = (id: string, isDefault: boolean) => ({
  model: id,
  displayName: id,
  isDefault,
  defaultReasoningEffort: "low",
  supportedReasoningEfforts: [{ reasoningEffort: "low" }],
});

type Body = Record<string, unknown>;
type NativeCall = { method: string; params: Body };

class OfflineAppServer extends EventEmitter {
  connected = true;
  userAgent = null;
  #model = "offline-default";
  #approvalPolicy = "on-request";
  #reviewer = "user";
  #queue: Body[] = [];

  constructor(
    private readonly workspace: string,
    private readonly calls: NativeCall[],
  ) {
    super();
  }

  async request(method: string, params: Body, dispatch?: () => void): Promise<unknown> {
    dispatch?.();
    this.calls.push({ method, params });
    switch (method) {
      case "model/list":
        return { data: [model("offline-default", true), model("offline-alternate", false)] };
      case "collaborationMode/list":
        return { data: [], nextCursor: null };
      case "thread/queue/list":
        return { data: this.#queue, nextCursor: null };
      case "thread/goal/get":
        return { goal: null };
      case "skills/list":
        return { data: [] };
      case "config/read":
        return { config: {} };
      case "account/rateLimits/read":
        throw new Error("account-rate-limits-unavailable");
      case "thread/start":
      case "thread/resume":
        this.#model = String(params.model ?? this.#model);
        this.#approvalPolicy = String(params.approvalPolicy ?? this.#approvalPolicy);
        this.#reviewer = String(params.approvalsReviewer ?? this.#reviewer);
        return {
          thread: this.#thread(),
          cwd: this.workspace,
          model: this.#model,
          reasoningEffort: (params.config as Body | undefined)?.model_reasoning_effort ?? null,
          serviceTier: params.serviceTier ?? null,
          approvalPolicy: this.#approvalPolicy,
          approvalsReviewer: this.#reviewer,
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        };
      case "thread/read":
        return { thread: this.#thread() };
      case "turn/start":
        return { turn: { id: turnId, status: "inProgress" } };
      case "turn/steer":
        return { turnId };
      case "thread/queue/add": {
        const queuedSubmission = {
          id: `offline-queue-item-${this.#queue.length + 1}`,
          clientUserMessageId: params.clientUserMessageId,
          input: params.input,
        };
        this.#queue.push(queuedSubmission);
        return { queuedSubmission };
      }
      case "thread/unsubscribe":
        return {};
      case "turn/interrupt":
        return {};
      default:
        throw new Error(`unexpected offline app-server method: ${method}`);
    }
  }

  #thread() {
    return {
      id: threadId,
      cwd: this.workspace,
      model: this.#model,
      status: { type: "idle" },
      turns: [],
    };
  }

  async close() {
    this.connected = false;
    this.emit("close");
  }

  respond(id: unknown, result: unknown) {
    this.calls.push({ method: "response", params: { id, result } });
    this.emit("notification", {
      method: "serverRequest/resolved",
      params: { threadId, requestId: id },
    });
  }

  interruptComplete() {
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "interrupted" } },
    });
  }

  prompt(id: number, method: string, payload: Body) {
    this.emit("serverRequest", { id, method, params: { threadId, turnId, ...payload } });
  }
}

describe("Codex session baseline through HTTP and backend RPC", () => {
  let root: string;
  let workspace: string;
  let backend: Awaited<ReturnType<typeof startBackend>> | undefined;
  let host: Awaited<ReturnType<typeof startHost>>;
  let nativeCalls: NativeCall[];
  let runtime: OfflineAppServer;

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "agentkib-baseline-codex-")));
    workspace = join(root, "workspace");
    const home = join(root, "home");
    mkdirSync(workspace);
    mkdirSync(join(home, ".codex"), { recursive: true });
    nativeCalls = [];
    const executable = join(root, "synthetic-codex");
    writeFileSync(executable, "fixture executable", { mode: 0o700 });
    vi.spyOn(CodexRuntimePreflight.prototype, "check").mockResolvedValue({
      executable,
      reason: null,
    });
    vi.spyOn(CodexRuntimePreflight.prototype, "preferred").mockReturnValue(executable);
    vi.spyOn(CodexFollowerBridge, "connect").mockRejectedValue(new Error("offline fixture"));
    vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(false);
    vi.spyOn(CodexDesktopApp.prototype, "openThread").mockResolvedValue(false);
    vi.spyOn(CodexAppServerSession, "start").mockImplementation(
      async (command, cwd, _home, _env, _notify, onStarted) => {
        expect(command).toBe(executable);
        const offline = new OfflineAppServer(cwd, nativeCalls);
        if (cwd === workspace) runtime = offline;
        const session = offline as unknown as CodexAppServerSession;
        onStarted?.(session);
        return session;
      },
    );
    backend = await startBackend({
      data: join(root, "backend"),
      workspace,
      environment: {
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: join(home, ".codex"),
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        DSH_HOME: join(home, ".dsh"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        AGENTKIB_HOME: join(home, ".agentkib"),
        PATH: "/usr/bin:/bin",
      },
    });
    host = await startHost({ root, workspace, rpc: backend.rpc });
  });

  afterEach(async () => {
    try {
      await host?.dispose();
    } finally {
      try {
        await backend?.close();
      } finally {
        if (root) rmSync(root, { recursive: true, force: true });
        vi.restoreAllMocks();
      }
    }
  });

  async function receipt(requestId: string, operation: string, sessionId: string, ack: Body) {
    expect(await host.http(`/requests/${requestId}`)).toMatchObject({
      status: 200,
      body: {
        found: true,
        status: "accepted",
        requestId,
        operation,
        sessionId,
        workspaceId: "workspace",
        executionMode: "codex-managed",
        ack,
      },
    });
  }

  async function create(prompt?: string) {
    const requestId = randomUUID();
    const request = {
      agent: "codex",
      bootId: host.bootId,
      workspaceId: "workspace",
      requestId,
      ...(prompt === undefined ? {} : { prompt }),
    };
    const result = await host.http("/managed/create", request);
    expect(result).toMatchObject({
      status: 200,
      body: { accepted: true, completed: true, requestId, sessionId: expect.any(String) },
    });
    const sessionId = String(result.body.sessionId);
    expect(
      host.calls.find((call) => (call.params as Body).operation === "provider-create"),
    ).toEqual({
      method: "web.request",
      params: {
        operation: "provider-create",
        agent: "codex",
        workspaceId: "workspace",
        requestId,
        deviceId: host.deviceId,
        policyId: "workspace-write-on-request",
      },
    });
    await receipt(requestId, "create", sessionId, { accepted: true, completed: true });
    return sessionId;
  }

  async function live(sessionId: string) {
    const live = await host.http(`/live?sessionId=${sessionId}`);
    expect(live).toMatchObject({
      status: 200,
      body: { executionMode: "codex-managed", revision: expect.any(Number) },
    });
    expect(host.calls).toContainEqual({
      method: "web.request",
      params: { operation: "live", sessionId, experimentalEnabled: true },
    });
    return live.body;
  }

  async function control(
    sessionId: string,
    path: string,
    operation: string,
    fields: Body,
  ): Promise<string> {
    const state = await live(sessionId);
    const requestId = randomUUID();
    const response = await host.http(path, {
      sessionId,
      bootId: host.bootId,
      requestId,
      expectedRevision: state.revision,
      ...(path === "/managed/action" ? { operation, agent: "codex" } : {}),
      ...fields,
    });
    const ack = {
      accepted: true,
      completed: !["send", "stop", "steer"].includes(operation),
      requestId,
      sessionId,
      runtimeBootId: expect.any(String),
      ...(operation === "settings" ? { appliesTo: "next-turn" } : {}),
    };
    expect(response).toMatchObject({ status: 200, body: ack });
    expect(
      host.calls.find(
        (call) => (call.params as Body).requestId === requestId && (call.params as Body).operation,
      ),
    ).toMatchObject({
      method: "web.request",
      params: {
        operation,
        deviceId: host.deviceId,
        sessionId,
        requestId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        runtimeBootId: expect.any(String),
        ...fields,
      },
    });
    await receipt(requestId, operation, sessionId, ack);
    return requestId;
  }

  it.each([
    ["without a first message", undefined],
    ["with an ignored first message", "Ignored at creation"],
  ])("creates a native thread %s", async (_label, prompt) => {
    const sessionId = await create(prompt);
    const starts = nativeCalls.filter((call) => call.method === "thread/start");
    expect(starts).toMatchObject([
      {
        method: "thread/start",
        params: {
          cwd: workspace,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: "workspace-write",
        },
      },
    ]);
    expect(nativeCalls.map((call) => call.method)).not.toContain("turn/start");
    expect(await live(sessionId)).toMatchObject({
      status: "idle",
      sendEnabled: true,
      stopEnabled: false,
      turnId: null,
    });
  });

  it("publishes parent-scoped Codex subagent activity in stream snapshots and preserves child history", async () => {
    const sessionId = await create();
    const childNativeId = randomUUID();
    const childTurnId = "offline-worker-turn";
    const codexHome = join(root, "home", ".codex");
    const sessions = join(codexHome, "sessions");
    const writeRollout = (id: string, source: unknown, rows: Body[]) => {
      const transcript = join(sessions, `rollout-${id}.jsonl`);
      writeFileSync(
        transcript,
        [{ type: "session_meta", payload: { id, cwd: workspace, source } }, ...rows]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      return transcript;
    };
    mkdirSync(sessions, { recursive: true });
    const parent = writeRollout(threadId, "cli", [
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      {
        type: "response_item",
        payload: { type: "SubAgentActivity", kind: "started", agent_thread_id: childNativeId },
      },
    ]);
    const childSource = { subagent: { thread_spawn: { parent_thread_id: threadId } } };
    const child = writeRollout(childNativeId, childSource, [
      { type: "event_msg", payload: { type: "task_started", turn_id: childTurnId } },
      {
        type: "event_msg",
        timestamp: "2026-11-20T00:00:00Z",
        payload: { type: "agent_message", message: "Offline child result" },
      },
    ]);
    const state = new DatabaseSync(join(codexHome, "state_5.sqlite"));
    try {
      state.exec(
        "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT)",
      );
      const add = state.prepare("INSERT INTO threads VALUES(?,?,?,?,?)");
      add.run(threadId, parent, workspace, "Offline parent", JSON.stringify("cli"));
      add.run(childNativeId, child, workspace, "Offline worker", JSON.stringify(childSource));
    } finally {
      state.close();
    }

    expect(sessionProviderDeclaration("codex")?.activities).toEqual({
      kinds: ["subagent"],
      canStopIndividually: false,
      canOpenSubagentHistory: true,
    });
    await control(sessionId, "/send", "send", { text: "Start parent work" });
    expect(await live(sessionId)).not.toHaveProperty("activities");
    const children = await host.http(`/subagents?sessionId=${sessionId}`);
    expect(children).toMatchObject({
      status: 200,
      body: {
        agents: [
          { id: expect.stringMatching(/^[a-f0-9]{64}$/), status: "running", readable: true },
        ],
      },
    });
    const rpc = backend!.rpc;
    const streamLive = async () => {
      const subscription = (await rpc(RUNTIME_METHODS.sessionsSubscribe, {
        sessionId,
      })) as SessionSubscription;
      try {
        return subscription.events.find(({ type }) => type === "snapshot")?.payload.live as Record<
          string,
          unknown
        >;
      } finally {
        await rpc(RUNTIME_METHODS.sessionsUnsubscribe, {
          subscriptionId: subscription.subscriptionId,
        });
      }
    };
    const published = (await streamLive()).activities as SessionActivity[];
    expect(published).toMatchObject([
      { id: expect.any(String), kind: "subagent", title: "Offline worker", status: "running" },
    ]);
    const activity = published[0]!;
    expect(activity.childId).toMatch(/^[a-f0-9]{64}$/);
    expect(activity.actions).toBeUndefined();
    expect(JSON.stringify(published)).not.toContain(childNativeId);
    expect(JSON.stringify(published)).not.toContain(workspace);
    expect(children).toMatchObject({
      body: { agents: [{ id: activity.childId, status: "running", readable: true }] },
    });
    expect(
      await host.http(`/subagent/events?sessionId=${sessionId}&subagentId=${activity.childId}`),
    ).toMatchObject({
      status: 200,
      body: {
        subagentId: activity.childId,
        events: expect.arrayContaining([
          expect.objectContaining({ content: "Offline child result" }),
        ]),
      },
    });

    appendFileSync(
      child,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: childTurnId },
      }) + "\n",
    );
    await expect.poll(streamLive, { timeout: 3_500 }).toMatchObject({
      activities: [{ id: activity.id, childId: activity.childId, status: "completed" }],
    });
  });

  it("sends, steers, queues, and interrupts through generic and legacy routes", async () => {
    const sessionId = await create();
    const send = await control(sessionId, "/send", "send", { text: "Start work" });
    expect(await live(sessionId)).toMatchObject({ status: "running", turnId, stopEnabled: true });
    const steer = await control(sessionId, "/managed/action", "steer", {
      text: "Steer the turn",
      turnId,
    });
    const queue = await control(sessionId, "/managed/action", "queue-add", {
      text: "Web queue entry",
    });
    const legacyQueue = await control(sessionId, "/codex/queue-add", "queue-add", {
      text: "Phone queue entry",
    });
    const queueEntries = [
      { id: "offline-queue-item-1", text: "Web queue entry", hasAttachments: false },
      { id: "offline-queue-item-2", text: "Phone queue entry", hasAttachments: false },
    ];
    const queueReadsStart = host.calls.length;
    const nativeQueueReadsStart = nativeCalls.length;
    for (const route of ["/managed/queue", "/codex/queue"]) {
      expect(await host.http(`${route}?sessionId=${sessionId}`)).toEqual({
        status: 200,
        body: {
          sessionId,
          ...(route === "/managed/queue" ? { paused: false, requiresResume: false } : {}),
          data: queueEntries,
        },
      });
    }
    const queueRead = {
      method: "web.request",
      params: { operation: "queue-list", sessionId },
    };
    expect(
      host.calls
        .slice(queueReadsStart)
        .filter(({ params }) => (params as Body).operation === "queue-list"),
    ).toEqual([queueRead, queueRead]);
    const nativeQueueRead = {
      method: "thread/queue/list",
      params: { threadId, cursor: null, limit: 100 },
    };
    expect(
      nativeCalls
        .slice(nativeQueueReadsStart)
        .filter(({ method }) => method === "thread/queue/list"),
    ).toEqual([nativeQueueRead, nativeQueueRead]);
    await control(sessionId, "/stop", "stop", { turnId });
    expect(
      nativeCalls.filter(({ method }) => /^(turn\/|thread\/queue\/add$)/.test(method)),
    ).toMatchObject([
      {
        method: "turn/start",
        params: { threadId, clientUserMessageId: send, input: textInput("Start work") },
      },
      {
        method: "turn/steer",
        params: {
          threadId,
          expectedTurnId: turnId,
          clientUserMessageId: steer,
          input: textInput("Steer the turn"),
        },
      },
      {
        method: "thread/queue/add",
        params: { threadId, clientUserMessageId: queue, input: textInput("Web queue entry") },
      },
      {
        method: "thread/queue/add",
        params: {
          threadId,
          clientUserMessageId: legacyQueue,
          input: textInput("Phone queue entry"),
        },
      },
      { method: "turn/interrupt", params: { threadId, turnId } },
    ]);
    runtime.interruptComplete();
    await expect.poll(() => live(sessionId)).toMatchObject({ status: "idle", turnId: null });
  });

  it("projects tool interactions and sends the correlated native approval and answer", async () => {
    const sessionId = await create();
    await control(sessionId, "/send", "send", { text: "Wait for approval, then ask" });
    runtime.prompt(41, "item/commandExecution/requestApproval", {
      cwd: workspace,
      itemId: "offline-command",
      command: "printf offline",
    });
    await expect
      .poll(() => live(sessionId))
      .toMatchObject({
        status: "awaiting-approval",
        approvals: [{ requestId: 41, turnId, supported: true }],
      });
    await control(sessionId, "/approve", "approve", { turnId, approvalId: 41, decision: "accept" });
    runtime.prompt(42, "item/tool/requestUserInput", {
      questions: [
        {
          id: "destination",
          header: "Destination",
          question: "Choose where to write",
          options: [{ label: "Here", description: "Use the offline workspace" }],
        },
      ],
    });
    await expect
      .poll(() => live(sessionId))
      .toMatchObject({
        status: "waiting-input",
        questions: [{ requestId: 42, turnId, supported: true }],
      });
    await control(sessionId, "/answer", "answer", {
      turnId,
      questionId: 42,
      answers: { destination: ["Here"] },
    });
    expect(nativeCalls.filter(({ method }) => method === "response")).toEqual([
      { method: "response", params: { id: 41, result: { decision: "accept" } } },
      {
        method: "response",
        params: { id: 42, result: { answers: { destination: { answers: ["Here"] } } } },
      },
    ]);
    await expect
      .poll(() => live(sessionId))
      .toMatchObject({
        status: "running",
        approvals: [],
        questions: [],
      });
  });

  it("loads options and capability projections, then applies model and permission settings", async () => {
    const options = await host.http("/managed/options?agent=codex&workspaceId=workspace");
    expect(options, String(options.body.reason)).toMatchObject({
      status: 200,
      body: {
        available: true,
        executionMode: "codex-managed",
        models: [{ id: "offline-default" }, { id: "offline-alternate" }],
        policies: [
          { id: "workspace-write-on-request", approvalPolicy: "on-request" },
          { id: "full-access-on-request", approvalPolicy: "never" },
          { id: "workspace-write-auto-review", approvalsReviewer: "auto_review" },
        ],
      },
    });
    expect(host.calls).toContainEqual({
      method: "web.request",
      params: { operation: "provider-options", agent: "codex" },
    });
    const sessionId = await create();
    for (const route of ["/managed/capabilities", "/codex/capabilities"]) {
      expect(await host.http(`${route}?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: {
          executionMode: "codex-managed",
          features: {
            send: { available: true },
            stop: { available: false },
            settings: { available: true },
          },
        },
      });
    }
    expect(await host.http(`/managed/inspect?sessionId=${sessionId}`)).toMatchObject({
      status: 200,
      body: {
        sessionId,
        reconciled: true,
        unresolvedCount: 0,
        nativeStatus: { type: "idle" },
        executionUnchanged: true,
      },
    });
    expect(nativeCalls).toContainEqual({
      method: "thread/read",
      params: { threadId, includeTurns: true },
    });
    for (const operation of ["capabilities", "inspect"]) {
      expect(host.calls).toContainEqual({
        method: "web.request",
        params: { operation, sessionId, experimentalEnabled: true },
      });
    }
    await control(sessionId, "/managed/action", "settings", { model: "offline-alternate" });
    await control(sessionId, "/codex/settings", "settings", {
      policyId: "workspace-write-auto-review",
    });
    for (const route of ["/managed/settings", "/codex/session-settings"]) {
      expect(await host.http(`${route}?sessionId=${sessionId}`)).toMatchObject({
        status: 200,
        body: {
          sessionId,
          selected: { modelId: "offline-alternate", policyId: "workspace-write-auto-review" },
        },
      });
    }
    expect(nativeCalls).toContainEqual({
      method: "model/list",
      params: { limit: 100 },
    });
    expect(nativeCalls.map(({ method }) => method)).not.toContain("thread/resume");
    expect(await live(sessionId)).toMatchObject({ status: "idle", sendEnabled: true });
    await control(sessionId, "/send", "send", { text: "Use next-turn settings" });
    expect(nativeCalls).toContainEqual(
      expect.objectContaining({
        method: "turn/start",
        params: expect.objectContaining({
          threadId,
          model: "offline-alternate",
          approvalsReviewer: "auto_review",
        }),
      }),
    );
  });
});
