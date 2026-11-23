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
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "../../../packages/backend/src/agents/codex/codex-app-server";
import { CodexDesktopApp } from "../../../packages/backend/src/agents/codex/codex-desktop-app";
import { CodexFollowerBridge } from "../../../packages/backend/src/agents/codex/codex-follower-bridge";
import { CodexFollowerConnection } from "../../../packages/backend/src/agents/codex/codex-follower-connection";
import * as codexFollowerLocks from "../../../packages/backend/src/agents/codex/codex-follower-operation-lock";
import { CodexFollowerState } from "../../../packages/backend/src/agents/codex/codex-follower-state";
import { CodexRuntimePreflight } from "../../../packages/backend/src/agents/codex/codex-runtime-preflight";
import { CodexSessions } from "../../../packages/backend/src/agents/codex/codex-sessions";
import { readManagedRecord, saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";
import { OrchestrationService } from "../../../packages/backend/src/orchestration-service";
import { BackendStore } from "../../../packages/backend/src/store";
import { startBackend } from "./session-baseline/harness";

const leadId = "synthetic-lead";
const turnId = "external-turn";
const deviceId = "agentkib-local-owner";
const nativePolicy = {
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: "danger-full-access",
};
const disposers: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  try {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
  } finally {
    vi.restoreAllMocks();
  }
});

type NativeRequest = { method: string; params: Record<string, unknown> };

class ReleasedWorkerServer extends EventEmitter {
  connected = true;
  readonly userAgent = null;

  constructor(
    private readonly nativeId: string,
    private readonly workspace: string,
    private readonly calls: NativeRequest[],
  ) {
    super();
  }

  async request(method: string, params: NativeRequest["params"], dispatch?: () => void) {
    dispatch?.();
    this.calls.push({ method, params });
    switch (method) {
      case "model/list":
        return { data: [{ model: "fixture-model", isDefault: true }] };
      case "collaborationMode/list":
      case "thread/queue/list":
        return { data: [], nextCursor: null };
      case "thread/goal/get":
        return { goal: null };
      case "thread/resume":
        return {
          thread: {
            id: this.nativeId,
            cwd: this.workspace,
            status: { type: "idle" },
            turns: [],
          },
          cwd: this.workspace,
          model: "fixture-model",
          reasoningEffort: null,
          ...nativePolicy,
          sandbox: { type: "dangerFullAccess" },
        };
      case "turn/start":
        return { turn: { id: "dispatched-turn", status: "inProgress" } };
      case "thread/unsubscribe":
        return {};
      default:
        throw new Error(`Unexpected Worker app-server method: ${method}`);
    }
  }

  async close() {
    this.connected = false;
    this.emit("close");
  }
}

function desktopOwnerFixture(endpoint: string, nativeId: string, oldDesktop: boolean) {
  const ownerClientId = "fixture-owner";
  let ownerAvailable = false;
  let revision = 1;
  let turns: unknown[] = [];
  let requests: unknown[] = [];
  let running = false;
  let onReadable: (() => void) | undefined;
  const received: unknown[] = [];
  const startTurn = vi.fn();
  const discovery = vi.fn(() => (ownerAvailable ? { handledByClientId: ownerClientId } : {}));
  const queueSnapshot = () => {
    received.push({
      type: "broadcast",
      sourceClientId: ownerClientId,
      method: "thread-stream-state-changed",
      version: 11,
      params: {
        conversationId: nativeId,
        hostId: "local",
        change: {
          type: "snapshot",
          revision,
          conversationState: {
            id: nativeId,
            hostId: "local",
            requests,
            threadRuntimeStatus: { type: running ? "active" : "idle" },
            turns,
          },
        },
      },
    });
  };
  const connect = vi
    .spyOn(CodexFollowerConnection, "connectInstalled")
    .mockImplementation(async () => {
      if (oldDesktop) throw new Error("codex-desktop-version-too-old");
      const connection = {
        endpoint,
        clientId: "fixture-follower",
        connected: true,
        supportsThreadSettings: false,
        get hasPendingMessages() {
          return received.length > 0;
        },
        disconnect() {
          connection.connected = false;
          received.length = 0;
        },
        onReadable(listener: () => void) {
          onReadable = listener;
          return () => {
            onReadable = undefined;
          };
        },
        async receive() {
          return received.shift() ?? null;
        },
        async broadcast(_method: string, params: { following: boolean }) {
          if (params.following) queueSnapshot();
        },
        async request(
          method: string,
          params: unknown,
          target?: string,
          _notification?: (message: unknown) => void,
          dispatch?: () => void,
        ) {
          if (method === "thread-owner-discovery") return discovery(params);
          if (method !== "thread-follower-start-turn")
            throw new Error(`unexpected IPC method ${method}`);
          dispatch?.();
          startTurn(params, target);
          return { method, handledByClientId: ownerClientId, result: {} };
        },
      };
      return connection as unknown as CodexFollowerConnection;
    });
  // Only this lock depends on the real desktop platform and writes to the user's home.
  vi.spyOn(codexFollowerLocks, "acquireCodexFollowerOperationLock").mockReturnValue(() => {});
  return {
    connect,
    discovery,
    startTurn,
    nativeId,
    exposeOwner() {
      ownerAvailable = true;
    },
    publish(turn: { status: string; turnId: string; items: unknown[] }, pending: unknown[] = []) {
      revision += 1;
      turns = [turn];
      requests = pending;
      running = turn.status === "inProgress";
      queueSnapshot();
      onReadable?.();
    },
  };
}

async function fixture(
  owner: "available" | "missing" | "released" | "no-desktop-owner" | "old-desktop",
  active = true,
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentkib-project-follower-")));
  disposers.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const bin = join(root, "bin");
  const data = join(root, "data");
  for (const folder of [
    workspace,
    bin,
    join(codexHome, "sessions"),
    join(codexHome, "thread-writer-locks"),
  ])
    mkdirSync(folder, { recursive: true });
  const executable = join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(executable, "synthetic executable", { mode: 0o700 });
  const nativeId = randomUUID();
  if (owner !== "released")
    disposers.push(
      acquirePortableFileLease(join(codexHome, "thread-writer-locks", `${nativeId}.lock`)),
    );
  const time = Date.now();
  const startedAt = new Date(time).toISOString();
  const transcript = join(codexHome, "sessions", `${nativeId}.jsonl`);
  const rows = [
    { type: "session_meta", payload: { id: nativeId, cwd: workspace, source: "cli" } },
    ...(owner === "released"
      ? [
          {
            type: "turn_context",
            payload: {
              cwd: workspace,
              model: "fixture-model",
              approval_policy: "never",
              sandbox_policy: { type: "danger-full-access" },
            },
          },
        ]
      : []),
    ...(active
      ? [
          {
            timestamp: startedAt,
            type: "event_msg",
            payload: { type: "task_started", turn_id: turnId },
          },
        ]
      : []),
  ];
  writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const native = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  try {
    native.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,archived INTEGER)",
    );
    native
      .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)")
      .run(nativeId, transcript, workspace, "Synthetic Worker", "cli", 0);
  } finally {
    native.close();
  }

  const environment = { HOME: home, CODEX_HOME: codexHome, PATH: bin };
  vi.spyOn(CodexRuntimePreflight.prototype, "check").mockResolvedValue({
    executable,
    reason: null,
  });
  const fakeDesktop = owner === "no-desktop-owner" || owner === "old-desktop";
  vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(fakeDesktop);
  const openThread = vi.spyOn(CodexDesktopApp.prototype, "openThread").mockResolvedValue(false);
  vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(owner !== "missing");
  const writer = vi
    .spyOn(CodexAppServerSession, "start")
    .mockRejectedValue(new Error("unexpected writer"));
  const nativeCalls: NativeRequest[] = [];
  if (owner === "released")
    writer.mockImplementation(async (command, cwd, _home, _env, _notify, onStarted) => {
      expect(command).toBe(executable);
      expect(cwd).toBe(workspace);
      const server = new ReleasedWorkerServer(nativeId, workspace, nativeCalls);
      const session = server as unknown as CodexAppServerSession;
      onStarted?.(session);
      return session;
    });
  const state = new CodexFollowerState(nativeId, "fixture-owner");
  // The owner has answered discovery, but its stream has not delivered the turn yet.
  state.notification({
    type: "broadcast",
    sourceClientId: "fixture-owner",
    method: "thread-stream-state-changed",
    version: 11,
    params: {
      conversationId: nativeId,
      hostId: "local",
      change: {
        type: "snapshot",
        revision: 1,
        conversationState: {
          id: nativeId,
          hostId: "local",
          requests: [],
          threadRuntimeStatus: { type: "idle" },
          turns: [],
        },
      },
    },
  });
  const mutate = vi.fn(async () => {
    throw new Error("unexpected owner mutation");
  });
  const bridge = {
    connected: true,
    selectedState: state,
    observeLive: vi.fn(async () => state),
    refresh: vi.fn(async () => state),
    close: vi.fn(() => {
      bridge.connected = false;
    }),
    mutate,
  };
  const desktop = fakeDesktop
    ? desktopOwnerFixture(join(codexHome, "ipc", "ipc.sock"), nativeId, owner === "old-desktop")
    : undefined;
  const follow = vi.spyOn(CodexFollowerBridge, "connect");
  if (!desktop) follow.mockResolvedValue(bridge as unknown as CodexFollowerBridge);
  const backend = await startBackend({ data, workspace, environment, indexSessions: fakeDesktop });
  disposers.push(backend.close);

  const store = new BackendStore(join(data, "agentkib.db"));
  let workerId: string;
  try {
    const listing = new CodexSessions(environment).list(workspace);
    store.sessions.sync(
      "workspace",
      "codex",
      listing.sessions.map(({ session }) => session),
    );
    workerId = store.sessions.id("codex", nativeId);
  } finally {
    store.close();
  }
  saveManagedRecord(data, {
    id: leadId,
    workspace_id: "workspace",
    workspace,
    cwd: workspace,
    home: codexHome,
    native_id: null,
    title: "Synthetic Project Agent",
    created_at: startedAt,
    policy_id: "workspace-write-on-request",
    adopted: false,
    released: false,
    archived: false,
    snapshot: { status: "idle", revision: 0 },
  });
  const assignWorkers = OrchestrationService.prototype.assignWorkers;
  let orchestration!: OrchestrationService;
  vi.spyOn(OrchestrationService.prototype, "assignWorkers").mockImplementation(
    function (this: OrchestrationService, input) {
      orchestration = this;
      return assignWorkers.call(this, input);
    },
  );
  const request = (params: Record<string, unknown>, target?: "claude-code") =>
    backend.rpc(RUNTIME_METHODS.sessionRequest, { host: { request: params, target } });
  await request(
    { operation: "lead-assign-workers", sessionId: leadId, deviceId, workers: [workerId] },
    "claude-code",
  );
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse((await orchestration.call(leadId, name, args)).text);
  const append = (row: unknown) => appendFileSync(transcript, JSON.stringify(row) + "\n");
  return {
    orchestration,
    call,
    mutate,
    follow,
    writer,
    time,
    request,
    workerId,
    state,
    append,
    nativeId,
    nativeCalls,
    data,
    desktop,
    openThread,
    workspace,
  };
}

const worker = { worker: "worker-1" };

it.each([
  { choice: undefined, ...nativePolicy },
  {
    choice: "workspace-write-auto-review",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  },
])("sends to an idle indexed Worker using its current policy ($sandbox)", async (scenario) => {
  const f = await fixture("released", false);
  if (scenario.choice) {
    const live = (await f.request({
      operation: "live",
      sessionId: f.workerId,
      experimentalEnabled: true,
    })) as { runtimeBootId: string; revision: number };
    expect(
      await f.request({
        operation: "settings",
        sessionId: f.workerId,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        requestId: randomUUID(),
        deviceId,
        experimentalEnabled: true,
        policyId: scenario.choice,
      }),
    ).toMatchObject({ accepted: true, appliesTo: "next-turn" });
    expect(readManagedRecord(f.data, f.workerId)).toMatchObject({ policy_id: scenario.choice });
  }
  expect(f.writer).not.toHaveBeenCalled();
  const text = "Send a task from the lead";
  const outcome = await f.call("worker_send", { ...worker, text });
  expect(outcome, JSON.stringify(outcome)).toMatchObject({
    accepted: true,
    operation: "send",
    requestId: expect.any(String),
  });
  const policy = {
    approvalPolicy: scenario.approvalPolicy,
    approvalsReviewer: scenario.approvalsReviewer,
    sandbox: scenario.sandbox,
  };
  expect(f.nativeCalls.filter(({ method }) => method === "thread/resume")).toEqual([
    {
      method: "thread/resume",
      params: expect.objectContaining({
        threadId: f.nativeId,
        ...nativePolicy,
      }),
    },
  ]);
  expect(f.nativeCalls.filter(({ method }) => method === "turn/start")).toEqual([
    {
      method: "turn/start",
      params: expect.objectContaining({
        threadId: f.nativeId,
        clientUserMessageId: outcome.requestId,
        input: [expect.objectContaining({ type: "text", text })],
        ...policy,
      }),
    },
  ]);
  expect(f.follow).not.toHaveBeenCalled();
});

it("treats a verified external turn as running while following Codex Desktop and refuses unsupported queueing", async () => {
  const f = await fixture("available");
  expect(f.follow).toHaveBeenCalledTimes(1);
  const live = await f.request({
    operation: "live",
    sessionId: f.workerId,
    experimentalEnabled: true,
  });
  expect(live).toMatchObject({ executionMode: "codex-follower" });
  expect(f.state.live(true)).toMatchObject({ status: "idle", sendEnabled: true });
  expect(await f.call("worker_list")).toMatchObject({
    workers: [{ ...worker, status: "running" }],
  });
  expect(await f.call("worker_read", worker)).toMatchObject({ ...worker, status: "running" });
  expect(await f.call("worker_send", { ...worker, text: "Follow-up work" })).toMatchObject({
    accepted: false,
    reason: "follower-operation-unverified",
  });
  expect(f.mutate).not.toHaveBeenCalled();
  expect(f.writer).not.toHaveBeenCalled();
});

it("reports a stalled external turn through the real host observation path", async () => {
  const f = await fixture("available");
  const clock = vi.spyOn(Date, "now").mockReturnValue(f.time);
  f.orchestration.registry.update(leadId, (lead) => {
    lead.scope.stallMinutes = 3;
  });
  f.orchestration.pause(leadId);
  await f.orchestration.catchUp();
  clock.mockReturnValue(f.time + 90_000);
  f.append({
    type: "response_item",
    payload: { type: "function_call_output", call_id: "poll-one", output: "Process still running" },
  });
  await f.orchestration.catchUp();
  clock.mockReturnValue(f.time + 181_000);
  await f.orchestration.catchUp();
  expect(f.orchestration.status(leadId)?.pendingReports).toEqual([
    expect.stringMatching(/no observed progress|may be stalled/),
  ]);
  clock.mockReturnValue(f.time + 190_000);
  f.append({
    type: "event_msg",
    payload: { type: "agent_message", turn_id: turnId, message: "Actual Worker output" },
  });
  await f.orchestration.catchUp();
  clock.mockReturnValue(f.time + 360_000);
  await f.orchestration.catchUp();
  expect(f.orchestration.status(leadId)?.pendingReports).toHaveLength(1);
  clock.mockReturnValue(f.time + 371_000);
  await f.orchestration.catchUp();
  expect(f.orchestration.status(leadId)?.pendingReports).toHaveLength(2);
  expect(f.writer).not.toHaveBeenCalled();
});

it("shows a held writer lock without turn evidence as busy rather than idle", async () => {
  const f = await fixture("missing", false);
  const { workers } = await f.call("worker_list");
  expect(workers).toEqual([expect.objectContaining({ ...worker, reason: "codex-owner-busy" })]);
  expect(workers[0].status).not.toBe("idle");
  const state = await f.call("worker_read", worker);
  expect(state.status).not.toBe("idle");
  expect(state).not.toHaveProperty("noProgressForMs");
  expect(f.writer).not.toHaveBeenCalled();
});

it("actively discovers an idle desktop owner after a read miss and forwards the worker turn", async () => {
  const f = await fixture("no-desktop-owner", false);
  const desktop = f.desktop!;
  // An expired read miss cannot hide a passive connection attempt. The explicit
  // live request below records a fresh miss before the owner becomes available.
  vi.spyOn(Date, "now").mockReturnValue(f.time + 10_000);
  const connections = desktop.connect.mock.calls.length;
  await f.orchestration.catchUp();
  expect(desktop.connect).toHaveBeenCalledTimes(connections);
  await f.request({ operation: "live", sessionId: f.workerId });
  expect(desktop.connect).toHaveBeenCalledTimes(connections + 1);
  expect(desktop.discovery).toHaveBeenLastCalledWith({
    hostId: "local",
    conversationId: desktop.nativeId,
  });

  desktop.exposeOwner();
  const result = await f.call("worker_send", { ...worker, text: "Work in the desktop thread" });
  expect(result).toMatchObject({
    accepted: true,
    operation: "send",
    requestId: expect.any(String),
  });
  expect(desktop.connect).toHaveBeenCalledTimes(connections + 2);
  expect(desktop.startTurn).toHaveBeenCalledExactlyOnceWith(
    {
      conversationId: desktop.nativeId,
      turnStart: {
        request: {
          threadId: desktop.nativeId,
          clientUserMessageId: result.requestId,
          input: [{ type: "text", text: "Work in the desktop thread", text_elements: [] }],
        },
      },
    },
    "fixture-owner",
  );
  expect(f.writer).not.toHaveBeenCalled();
  expect(f.openThread).not.toHaveBeenCalled();

  // Keep real reports pending so the fixture never needs a Claude runner.
  f.orchestration.pause(leadId);
  const rolloutEvent = (payload: Record<string, unknown>) =>
    f.append({
      timestamp: new Date(Date.now()).toISOString(),
      type: "event_msg",
      payload: { turn_id: turnId, ...payload },
    });
  rolloutEvent({ type: "task_started" });
  const activeTurn = { turnId, status: "inProgress", items: [] };
  desktop.publish(activeTurn, [
    {
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: desktop.nativeId,
        turnId,
        questions: [
          { id: "choice", question: "Pick one", options: [{ label: "A" }, { label: "B" }] },
        ],
      },
    },
  ]);
  await vi.waitFor(async () => {
    expect(await f.call("worker_read", worker)).toMatchObject({
      status: "waiting-input",
      waitingForUser: [
        {
          kind: "question",
          id: "question-1",
          youMayDecide: false,
          questions: [{ id: "choice", question: "Pick one", options: ["A", "B"] }],
        },
      ],
    });
    expect(f.orchestration.status(leadId)?.pendingReports).toEqual([
      expect.stringContaining("answer to its question"),
    ]);
  });
  desktop.publish(activeTurn, [
    {
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: desktop.nativeId,
        turnId,
        command: "pwd",
        cwd: f.workspace,
        availableDecisions: ["accept", "decline"],
      },
    },
  ]);
  await vi.waitFor(async () => {
    expect(await f.call("worker_read", worker)).toMatchObject({
      status: "awaiting-approval",
      waitingForUser: [
        {
          kind: "approval",
          id: "approval-1",
          approval: "command",
          command: "pwd",
          youMayDecide: false,
        },
      ],
    });
    expect(f.orchestration.status(leadId)?.pendingReports).toEqual([
      expect.stringContaining("answer to its question"),
      expect.stringContaining("waiting for the user's approval"),
    ]);
  });
  // The owner reports state over IPC and records the reply in its native
  // rollout. The lead report reads its reply from the verified history.
  rolloutEvent({ type: "agent_message", message: "Desktop worker finished" });
  rolloutEvent({ type: "task_complete" });
  desktop.publish({
    turnId,
    status: "completed",
    items: [{ id: "assistant-reply", type: "agentMessage", text: "Desktop worker finished" }],
  });
  await vi.waitFor(() => {
    expect(f.orchestration.status(leadId)?.pendingReports).toEqual([
      expect.stringContaining("answer to its question"),
      expect.stringContaining("waiting for the user's approval"),
      expect.stringMatching(/turn ended: completed[\s\S]*Desktop worker finished/),
    ]);
  });
});

it.each([
  ["no-desktop-owner", "codex-desktop-owner-missing"],
  ["old-desktop", "codex-desktop-version-too-old"],
] as const)("refuses a worker send with %s without starting a writer", async (owner, reason) => {
  const f = await fixture(owner, false);
  expect(await f.call("worker_send", { ...worker, text: "Must not be sent" })).toMatchObject({
    accepted: false,
    reason,
  });
  expect(f.desktop?.connect).toHaveBeenCalled();
  expect(f.desktop?.startTurn).not.toHaveBeenCalled();
  expect(f.writer).not.toHaveBeenCalled();
  expect(f.openThread).not.toHaveBeenCalled();
});
