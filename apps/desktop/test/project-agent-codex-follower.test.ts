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
import {
  CodexDesktopConnectionError,
  CodexFollowerConnection,
} from "../../../packages/backend/src/agents/codex/codex-follower-connection";
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
  readonly userAgent = "codex/0.167.0";

  constructor(
    private readonly nativeId: string,
    private readonly workspace: string,
    private readonly calls: NativeRequest[],
    private readonly catalogModel: string,
    private readonly transcript: string,
  ) {
    super();
  }

  async request(method: string, params: NativeRequest["params"], dispatch?: () => void) {
    dispatch?.();
    this.calls.push({ method, params });
    switch (method) {
      case "model/list":
        return { data: [{ model: this.catalogModel, isDefault: true }] };
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
            path: this.transcript,
            status: { type: "idle" },
            turns: [],
          },
          cwd: this.workspace,
          model: "fixture-model",
          reasoningEffort: null,
          ...(params.sandbox === "workspace-write"
            ? {
                approvalPolicy: "on-request",
                approvalsReviewer: params.approvalsReviewer,
                sandbox: {
                  type: "workspaceWrite",
                  writableRoots: [this.workspace],
                  networkAccess: false,
                  excludeTmpdirEnvVar: true,
                  excludeSlashTmp: true,
                },
              }
            : { ...nativePolicy, sandbox: { type: "dangerFullAccess" } }),
        };
      case "turn/start":
        return { turn: { id: "dispatched-turn", status: "inProgress" } };
      case "thread/unsubscribe":
        return {};
      default:
        throw new Error(`Unexpected Worker app-server method: ${method}`);
    }
  }

  complete(reply: string) {
    this.emit("notification", {
      method: "item/completed",
      params: {
        threadId: this.nativeId,
        turnId: "dispatched-turn",
        item: { id: "worker-reply", type: "agentMessage", phase: "final_answer", text: reply },
      },
    });
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: this.nativeId, turn: { id: "dispatched-turn", status: "completed" } },
    });
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
      if (oldDesktop) throw new CodexDesktopConnectionError("codex-desktop-version-too-old");
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
          if (method === "thread-owner-discovery") {
            const owner = discovery(params);
            if (!owner.handledByClientId)
              throw new CodexDesktopConnectionError("codex-desktop-owner-missing");
            return owner;
          }
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
  { indexSessions = false, catalogModel = "fixture-model", assign = true } = {},
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
  const writerLock = join(codexHome, "thread-writer-locks", `${nativeId}.lock`);
  let unlock = owner !== "released" ? acquirePortableFileLease(writerLock) : undefined;
  const releaseWriter = ({ keepFile = false } = {}) => {
    unlock?.();
    unlock = undefined;
    if (!keepFile) rmSync(writerLock, { force: true });
  };
  if (unlock) disposers.push(releaseWriter);
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
  let lastWriter: ReleasedWorkerServer | undefined;
  const allowWriter = () =>
    writer.mockImplementation(async (command, cwd, _home, _env, _notify, onStarted) => {
      expect(command).toBe(executable);
      expect(cwd).toBe(workspace);
      lastWriter = new ReleasedWorkerServer(
        nativeId,
        workspace,
        nativeCalls,
        catalogModel,
        transcript,
      );
      const session = lastWriter as unknown as CodexAppServerSession;
      onStarted?.(session);
      return session;
    });
  if (owner === "released") allowWriter();
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
  const backend = await startBackend({
    data,
    workspace,
    environment,
    indexSessions: indexSessions || fakeDesktop,
  });
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
    native_id: randomUUID(),
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
  const request = (
    params: Record<string, unknown>,
    target?: "claude-code",
    restrictCodexNativePolicy?: true,
  ) =>
    backend.rpc(RUNTIME_METHODS.sessionRequest, {
      host: { request: params, target, restrictCodexNativePolicy },
    });
  if (assign)
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
    allowWriter,
    releaseWriter,
    completeWorkerTurn: (reply: string) => {
      if (!lastWriter) throw new Error("fake app-server has not started");
      lastWriter.complete(reply);
    },
    time,
    request,
    workerId,
    state,
    append,
    nativeId,
    writerLock,
    nativeCalls,
    data,
    desktop,
    openThread,
    workspace,
  };
}

const worker = { worker: "worker-1" };

it("adopts the verified native Codex thread only when an owner confirms its worker assignment", async () => {
  const replay = await fixture("released", false, { assign: false });
  const lead = { sessionId: replay.workerId, deviceId, workers: [leadId] };
  const options = () =>
    replay.request(
      { ...lead, operation: "lead-assignment-options", candidateIds: [leadId] },
      "claude-code",
    );
  const confirm = () =>
    replay.request({ ...lead, operation: "lead-assign-workers" }, "claude-code");
  const hold = acquirePortableFileLease(replay.writerLock);
  try {
    await expect(options()).resolves.toMatchObject({ capable: false, reason: "codex-owner-busy" });
    await expect(confirm()).rejects.toThrow("codex-owner-busy");
    expect(replay.writer).not.toHaveBeenCalled();
  } finally {
    hold();
  }
  await expect(options()).resolves.toMatchObject({ capable: true });
  expect(replay.writer).not.toHaveBeenCalled();
  expect(readManagedRecord(replay.data, replay.workerId)).toBeNull();

  await expect(confirm()).resolves.toMatchObject({
    capable: true,
    lead: { sessionId: replay.workerId },
  });
  expect(replay.writer).toHaveBeenCalledTimes(1);
  expect(replay.nativeCalls).toContainEqual({
    method: "thread/resume",
    params: expect.objectContaining({
      threadId: replay.nativeId,
      cwd: replay.workspace,
      deferGoalContinuation: true,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    }),
  });
  expect(replay.nativeCalls.map(({ method }) => method)).not.toContain("turn/start");
  expect(replay.openThread).not.toHaveBeenCalled();
  expect(readManagedRecord(replay.data, replay.workerId)).toMatchObject({
    native_id: replay.nativeId,
    released: false,
  });

  const live = (await replay.request({
    operation: "live",
    sessionId: replay.workerId,
    experimentalEnabled: true,
  })) as { runtimeBootId: string; revision: number };
  await expect(
    replay.request({
      operation: "send",
      sessionId: replay.workerId,
      requestId: randomUUID(),
      deviceId,
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      text: "First real turn",
    }),
  ).resolves.toMatchObject({ accepted: true });
  expect(replay.nativeCalls.filter(({ method }) => method === "thread/resume").at(-1)).toEqual({
    method: "thread/resume",
    params: expect.objectContaining({
      threadId: replay.nativeId,
      config: expect.objectContaining({ "mcp_servers.agentkib_workers.url": expect.any(String) }),
    }),
  });
});

it("does not turn a released record or a failed native resume into managed lead eligibility", async () => {
  const replay = await fixture("released", false, { assign: false });
  const request = (operation: string) =>
    replay.request({ operation, sessionId: replay.workerId, deviceId }, "claude-code");
  replay.writer.mockRejectedValueOnce(new Error("codex-app-server-unavailable"));
  await expect(request("lead-designate")).rejects.toThrow("codex-app-server-unavailable");
  expect(readManagedRecord(replay.data, replay.workerId)).toBeNull();

  // A previous managed attachment keeps its release marker and must face current writer checks.
  await expect(request("lead-designate")).resolves.toMatchObject({ capable: true });
  const adopted = readManagedRecord(replay.data, replay.workerId)!;
  saveManagedRecord(replay.data, { ...adopted, released: true });
  const hold = acquirePortableFileLease(replay.writerLock);
  try {
    await expect(request("lead-status")).resolves.toMatchObject({ capable: false });
    await expect(request("lead-designate")).rejects.toThrow("codex-owner-busy");
    expect(replay.writer).toHaveBeenCalledTimes(2);
    expect(readManagedRecord(replay.data, replay.workerId)).toMatchObject({ released: true });
  } finally {
    hold();
  }
});

it("keeps the original Codex policy boundary and rolls back a rejected assignment", async () => {
  const replay = await fixture("released", false, { assign: false });
  const request = (operation: string, device = deviceId) =>
    replay.request({ operation, sessionId: replay.workerId, deviceId: device }, "claude-code");
  await expect(request("lead-designate", "different-device")).rejects.toThrow(
    "native-policy-full-access-required",
  );
  expect(replay.writer).not.toHaveBeenCalled();

  vi.spyOn(OrchestrationService.prototype, "designate").mockImplementationOnce(() => {
    throw new Error("session-is-a-worker");
  });
  await expect(request("lead-designate")).rejects.toThrow("session-is-a-worker");
  expect(readManagedRecord(replay.data, replay.workerId)).toBeNull();

  replay.append({
    type: "turn_context",
    payload: {
      cwd: replay.workspace,
      model: "fixture-model",
      approval_policy: "on-request",
      approvals_reviewer: "user",
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [],
        network_access: false,
        exclude_tmpdir_env_var: false,
        exclude_slash_tmp: false,
      },
    },
  });
  await expect(request("lead-status")).resolves.toMatchObject({ capable: false });
  await expect(request("lead-designate")).rejects.toThrow("native-policy-sandbox-tmpdir-mismatch");
  expect(replay.writer).toHaveBeenCalledTimes(1);
  expect(readManagedRecord(replay.data, replay.workerId)).toBeNull();
});

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
  const live = () =>
    f.request({
      operation: "live",
      sessionId: f.workerId,
      experimentalEnabled: true,
    }) as Promise<{ runtimeBootId: string; revision: number }>;
  if (scenario.choice) {
    const state = await live();
    expect(
      await f.request({
        operation: "settings",
        sessionId: f.workerId,
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        requestId: randomUUID(),
        deviceId,
        experimentalEnabled: true,
        policyId: scenario.choice,
      }),
    ).toMatchObject({ accepted: true, appliesTo: "next-turn" });
    expect(readManagedRecord(f.data, f.workerId)).toMatchObject({ policy_id: scenario.choice });
  }
  const state = await live();
  expect(
    await f.request(
      {
        operation: "send",
        sessionId: f.workerId,
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        requestId: randomUUID(),
        deviceId: "restricted-device",
        experimentalEnabled: true,
        text: "Restricted host send",
      },
      undefined,
      true,
    ),
  ).toMatchObject({
    accepted: false,
    controlOutcome: "not-dispatched",
    reason: "native-policy-full-access-required",
  });
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

it("uses the released Worker's native model even when it is absent from the local catalog", async () => {
  const f = await fixture("released", false, { catalogModel: "catalog-only-model" });

  const outcome = await f.call("worker_send", { ...worker, text: "Continue on the native model" });

  expect(outcome).toMatchObject({
    accepted: true,
    operation: "send",
    requestId: expect.any(String),
  });
  expect(f.nativeCalls.map(({ method }) => method)).toContain("model/list");
  expect(f.nativeCalls.filter(({ method }) => method === "turn/start")).toEqual([
    {
      method: "turn/start",
      params: expect.objectContaining({
        threadId: f.nativeId,
        clientUserMessageId: outcome.requestId,
        model: "fixture-model",
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
  clock.mockReturnValue(f.time + 360_000);
  await f.orchestration.catchUp();
  expect(f.orchestration.status(leadId)?.pendingReports).toEqual([]);
  clock.mockReturnValue(f.time + 361_000);
  await f.orchestration.catchUp();
  expect(f.orchestration.status(leadId)?.pendingReports).toEqual([
    expect.stringMatching(/no observed progress|may be stalled/),
  ]);
  clock.mockReturnValue(f.time + 370_000);
  f.append({
    type: "event_msg",
    payload: { type: "agent_reasoning", turn_id: turnId, text: "Actual Worker reasoning" },
  });
  await f.orchestration.catchUp();
  clock.mockReturnValue(f.time + 730_000);
  await f.orchestration.catchUp();
  expect(f.orchestration.status(leadId)?.pendingReports).toHaveLength(1);
  clock.mockReturnValue(f.time + 731_000);
  await f.orchestration.catchUp();
  expect(f.orchestration.status(leadId)?.pendingReports).toHaveLength(2);
  expect(f.writer).not.toHaveBeenCalled();
});

it.each(["tool call", "native execution"])(
  "suppresses external stalls during a %s",
  async (source) => {
    const f = await fixture("missing");
    const clock = vi.spyOn(Date, "now").mockReturnValue(f.time);
    const nativeExecution = source === "native execution";
    f.orchestration.registry.update(leadId, (lead) => {
      lead.scope.stallMinutes = 3;
    });
    f.orchestration.pause(leadId);
    f.append({
      type: "response_item",
      timestamp: new Date(f.time).toISOString(),
      payload: { type: "function_call", name: "exec_command", call_id: "shell-1", turn_id: turnId },
    });
    if (nativeExecution)
      f.append({
        type: "event_msg",
        timestamp: new Date(f.time).toISOString(),
        payload: {
          type: "item_started",
          turn_id: turnId,
          item: { type: "CommandExecution", id: "shell-1", status: "in_progress" },
        },
      });
    await f.orchestration.catchUp();
    clock.mockReturnValue(f.time + 361_000);
    f.append({
      type: "response_item",
      // A tool can return while its matching native execution item is still open.
      payload: {
        type: "function_call_output",
        call_id: nativeExecution ? "shell-1" : "other-call",
        turn_id: turnId,
        output: "ok",
      },
    });
    await f.orchestration.catchUp();
    expect(f.orchestration.status(leadId)?.pendingReports).toEqual([]);

    f.append(
      nativeExecution
        ? {
            type: "event_msg",
            payload: {
              type: "item_completed",
              turn_id: turnId,
              item: { type: "CommandExecution", id: "shell-1", status: "completed" },
            },
          }
        : {
            type: "response_item",
            payload: {
              type: "function_call_output",
              call_id: "shell-1",
              turn_id: turnId,
              output: "ok",
            },
          },
    );
    await f.orchestration.catchUp();
    clock.mockReturnValue(f.time + 721_000);
    await f.orchestration.catchUp();
    expect(f.orchestration.status(leadId)?.pendingReports).toEqual([]);
    clock.mockReturnValue(f.time + 722_000);
    await f.orchestration.catchUp();
    expect(f.orchestration.status(leadId)?.pendingReports).toEqual([
      expect.stringMatching(/no observed progress|may be stalled/),
    ]);
    expect(f.follow).not.toHaveBeenCalled();
    expect(f.writer).not.toHaveBeenCalled();
  },
);

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

it("catches up once on a turn of an untouched indexed Worker that began after assignment", async () => {
  const f = await fixture("missing", false, { indexSessions: true });
  expect(readManagedRecord(f.data, f.workerId)).toBeNull();
  const status = () => f.orchestration.status(leadId)!;
  const joined = Date.parse(status().lanes[0]!.createdAt);
  const timestamp = (offset: number) => new Date(joined + offset).toISOString();
  const rollout = (offset: number, turn: string, type: string, message?: string) =>
    f.append({
      timestamp: timestamp(offset),
      type: "event_msg",
      payload: { type, turn_id: turn, ...(message === undefined ? {} : { message }) },
    });
  f.orchestration.pause(leadId);

  // The first turn ends after assignment, but it started before the Worker joined.
  const previousTurn = "before-assignment";
  const joinedTurn = "after-assignment";
  rollout(-30_000, previousTurn, "task_started");
  rollout(1_000, previousTurn, "task_complete");
  rollout(2_000, "unknown-start", "task_complete");
  rollout(10_000, joinedTurn, "task_started");
  await f.orchestration.catchUp(joined + 20_000);
  expect(status().pendingReports).toEqual([]);

  // The scanner must retain the start timestamp across an incremental rollout read.
  rollout(21_000, joinedTurn, "agent_message", "Result from the indexed Worker");
  rollout(30_000, joinedTurn, "task_complete");
  await f.orchestration.catchUp(joined + 40_000);
  expect(status().pendingReports).toEqual([]);
  await f.orchestration.catchUp(joined + 50_000);
  expect(status().pendingReports).toEqual([
    expect.stringMatching(/turn ended: completed after 20s[\s\S]*Result from the indexed Worker/),
  ]);
  expect(status().lanes[0]!.reportedTurns).toEqual([joinedTurn]);
  expect(await f.orchestration.lanes.endedTurns?.(f.workerId)).toEqual([
    {
      turnId: previousTurn,
      outcome: "completed",
      startedAt: timestamp(-30_000),
      endedAt: timestamp(1_000),
      superseded: true,
    },
    {
      turnId: joinedTurn,
      outcome: "completed",
      startedAt: timestamp(10_000),
      endedAt: timestamp(30_000),
    },
  ]);

  await f.orchestration.catchUp(joined + 60_000);
  expect(status().pendingReports).toHaveLength(1);
  expect(status().lanes[0]!.reportedTurns).toEqual([joinedTurn]);
  expect(readManagedRecord(f.data, f.workerId)).toBeNull();
  expect(f.follow).not.toHaveBeenCalled();
  expect(f.writer).not.toHaveBeenCalled();
});

it("silently catches up on an old empty Codex turn once a newer turn has started", async () => {
  const f = await fixture("missing", false, { indexSessions: true });
  const status = () => f.orchestration.status(leadId)!;
  const joined = Date.parse(status().lanes[0]!.createdAt);
  const clock = vi.spyOn(Date, "now");
  const record = (offset: number, turn: string, type: "task_started" | "task_complete") =>
    f.append({
      timestamp: new Date(joined + offset).toISOString(),
      type: "event_msg",
      payload: { type, turn_id: turn },
    });
  const poll = async (offset: number) => {
    clock.mockReturnValue(joined + offset);
    await f.orchestration.catchUp();
  };
  // Held reports expose everything that would wake the lead, without starting its runner.
  f.orchestration.pause(leadId);
  record(1_000, "old", "task_started");
  record(2_000, "old", "task_complete");
  record(65_000, "current", "task_started");
  await poll(70_000);
  expect(await f.call("worker_read", worker)).toMatchObject({ status: "running" });
  expect(status().pendingReports).toEqual([]);
  expect(status().lanes[0]!.reportedTurns).toEqual(["old"]);

  await poll(75_000);
  expect(status().pendingReports).toEqual([]);
  expect(status().lanes[0]!.reportedTurns).toEqual(["old"]);

  record(80_000, "current", "task_complete");
  record(82_000, "successor", "task_started");
  await poll(100_000);
  expect(status().pendingReports).toEqual([
    expect.stringMatching(/turn ended: completed after 15s[\s\S]*\(no reply was recorded\)/),
  ]);
  expect(status().lanes[0]!.reportedTurns).toEqual(["old", "current"]);
  expect(f.follow).not.toHaveBeenCalled();
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

it("opens an ownerless desktop thread only for the admitted Worker send", async () => {
  const f = await fixture("no-desktop-owner", false);
  const desktop = f.desktop!;
  f.openThread.mockImplementation(async () => {
    desktop.exposeOwner();
    return true;
  });

  await f.orchestration.catchUp();
  expect(f.openThread).not.toHaveBeenCalled();
  const outcome = await f.call("worker_send", { ...worker, text: "Send through the desktop" });
  expect(outcome).toMatchObject({ accepted: true, requestId: expect.any(String) });
  expect(f.openThread).toHaveBeenCalledExactlyOnceWith(desktop.nativeId);
  expect(desktop.startTurn).toHaveBeenCalledExactlyOnceWith(
    {
      conversationId: desktop.nativeId,
      turnStart: {
        request: {
          threadId: desktop.nativeId,
          clientUserMessageId: outcome.requestId,
          input: [{ type: "text", text: "Send through the desktop", text_elements: [] }],
        },
      },
    },
    "fixture-owner",
  );
  expect(f.writer).not.toHaveBeenCalled();
});

it("waits on an unavailable desktop socket and can cancel without interrupting the desktop", async () => {
  const f = await fixture("no-desktop-owner", false);
  f.desktop!.connect.mockRejectedValue(
    new CodexDesktopConnectionError("codex-desktop-ipc-unavailable"),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const outcome = await f.call("worker_send", { ...worker, text: "Cancel this unsent task" });
    const waiting = { status: "waiting-for-owner", reason: "codex-waiting-for-owner" };
    expect(outcome).toMatchObject({ accepted: true, ...waiting });
    expect(await f.call("worker_read", worker)).toMatchObject(waiting);
    expect(await f.call("worker_list")).toMatchObject({ workers: [{ ...worker, ...waiting }] });
    expect(f.desktop!.startTurn).not.toHaveBeenCalled();
    expect(f.openThread).not.toHaveBeenCalled();
    expect(f.writer).not.toHaveBeenCalled();

    expect(await f.call("worker_stop", worker)).toMatchObject({
      accepted: true,
      cancelled: true,
      requestId: outcome.requestId,
    });
    f.releaseWriter();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.writer).not.toHaveBeenCalled();
    expect(await f.call("worker_read", worker)).not.toMatchObject(waiting);
  } finally {
    vi.useRealTimers();
  }
});

it("sends after the lock clears with fresh policy and reports intervening desktop turns", async () => {
  const f = await fixture("no-desktop-owner", false);
  f.append({
    type: "turn_context",
    payload: {
      cwd: f.workspace,
      model: "fixture-model",
      approval_policy: "never",
      sandbox_policy: { type: "danger-full-access" },
    },
  });
  const text = "Continue after the desktop releases";
  const outcome = await f.call("worker_send", { ...worker, text });
  expect(outcome).toMatchObject({
    accepted: true,
    status: "waiting-for-owner",
    reason: "codex-waiting-for-owner",
  });
  expect(f.openThread).toHaveBeenCalledExactlyOnceWith(f.nativeId);
  expect(f.desktop?.startTurn).not.toHaveBeenCalled();
  expect(f.writer).not.toHaveBeenCalled();

  const timestamp = new Date().toISOString();
  f.append({
    timestamp,
    type: "event_msg",
    payload: { type: "task_started", turn_id: "intervening-turn" },
  });
  expect(await f.call("worker_read", worker)).toMatchObject({
    status: "waiting-for-owner",
    reason: "codex-waiting-for-owner",
  });
  f.append({
    type: "turn_context",
    payload: {
      turn_id: "intervening-turn",
      cwd: f.workspace,
      model: "fixture-model",
      approval_policy: "on-request",
      approvals_reviewer: "user",
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [f.workspace],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    },
  });
  f.append({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "intervening-turn" },
  });
  expect(f.writer).not.toHaveBeenCalled();
  // Observe the report without dispatching a turn in the fictitious lead session.
  const transport = vi.spyOn(f.orchestration, "sendReport").mockImplementation(() => false);
  f.allowWriter();
  f.releaseWriter({ keepFile: true });
  const policy = {
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  };
  await vi.waitFor(
    () => {
      expect(f.nativeCalls.filter(({ method }) => method === "thread/resume")).toEqual([
        { method: "thread/resume", params: expect.objectContaining({ ...policy }) },
      ]);
      expect(f.nativeCalls.filter(({ method }) => method === "turn/start")).toEqual([
        {
          method: "turn/start",
          params: expect.objectContaining({
            ...policy,
            threadId: f.nativeId,
            clientUserMessageId: expect.any(String),
            input: [expect.objectContaining({ type: "text", text })],
          }),
        },
      ]);
      expect(transport).toHaveBeenCalledWith(
        leadId,
        deviceId,
        expect.stringContaining("ChatGPT ran other turns while it waited"),
        expect.any(Function),
        expect.any(String),
      );
    },
    { timeout: 4_000 },
  );
  const turnEnded = vi.spyOn(f.orchestration, "laneTurnEnded");
  const reply = "The worker finished the task after the lock cleared.";
  f.completeWorkerTurn(reply);
  await vi.waitFor(() => {
    expect(turnEnded).toHaveBeenCalledWith(
      f.workerId,
      "dispatched-turn",
      "completed",
      null,
      undefined,
      reply,
    );
    expect(transport).toHaveBeenCalledWith(
      leadId,
      deviceId,
      expect.stringMatching(
        /turn ended: completed[\s\S]*The worker finished the task after the lock cleared\./,
      ),
      expect.any(Function),
      expect.any(String),
    );
  });
  expect(f.nativeCalls.filter(({ method }) => method === "turn/start")).toHaveLength(1);
});

it("reports native policy refusal at delivery without starting a writer", async () => {
  const f = await fixture("no-desktop-owner", false);
  const nativeContext = (approval_policy: string) => ({
    type: "turn_context",
    payload: {
      cwd: f.workspace,
      model: "fixture-model",
      approval_policy,
      sandbox_policy: { type: "danger-full-access" },
    },
  });
  f.append(nativeContext("never"));
  expect(
    await f.call("worker_send", { ...worker, text: "Only with a supported policy" }),
  ).toMatchObject({
    accepted: true,
    status: "waiting-for-owner",
  });
  f.append(nativeContext("on-request"));
  const transport = vi.spyOn(f.orchestration, "sendReport").mockImplementation(() => false);
  f.releaseWriter();
  await vi.waitFor(
    () =>
      expect(transport).toHaveBeenCalledWith(
        leadId,
        deviceId,
        expect.stringContaining("native-policy-approval-policy-mismatch"),
        expect.any(Function),
        expect.any(String),
      ),
    { timeout: 4_000 },
  );
  expect(f.writer).not.toHaveBeenCalled();
  expect(f.desktop?.startTurn).not.toHaveBeenCalled();
  expect(await f.call("worker_read", worker)).not.toHaveProperty("status", "waiting-for-owner");
});

it("keeps the explicit older-desktop refusal without starting a writer", async () => {
  const f = await fixture("old-desktop", false);
  expect(await f.call("worker_send", { ...worker, text: "Must not be sent" })).toMatchObject({
    accepted: false,
    reason: "codex-desktop-version-too-old",
  });
  expect(f.desktop?.connect).toHaveBeenCalled();
  expect(f.desktop?.startTurn).not.toHaveBeenCalled();
  expect(f.writer).not.toHaveBeenCalled();
  expect(f.openThread).not.toHaveBeenCalled();
});
