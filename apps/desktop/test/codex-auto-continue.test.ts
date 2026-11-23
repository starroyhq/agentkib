import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerError,
  CodexAppServerSession,
} from "../../../packages/backend/src/agents/codex/codex-app-server";
import { CodexFollowerBridge } from "../../../packages/backend/src/agents/codex/codex-follower-bridge";
import {
  CodexTitleThreads,
  parseThreadTitle,
  threadTitleModel,
  threadTitlePrompt,
} from "../../../packages/backend/src/agents/codex/codex-thread-title";
import {
  CodexDesktopConnectionError,
  CodexFollowerConnection,
} from "../../../packages/backend/src/agents/codex/codex-follower-connection";
import { CodexFollowerState } from "../../../packages/backend/src/agents/codex/codex-follower-state";
import { CodexDesktopApp } from "../../../packages/backend/src/agents/codex/codex-desktop-app";
import { AUTO_CONTINUE_TEXT } from "../../../packages/backend/src/usage-limit";
import * as codexFollowerLocks from "../../../packages/backend/src/agents/codex/codex-follower-operation-lock";
import { CodexRuntimePreflight } from "../../../packages/backend/src/agents/codex/codex-runtime-preflight";
import { CodexSessionProvider } from "../../../packages/backend/src/agents/codex/session-provider";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  openManagedLedger,
  readManagedEvents,
  readManagedRecord,
  readUnknownManagedCommands,
  saveManagedRecord,
} from "../../../packages/backend/src/managed-ledger";
import { ManagedCodexState } from "../../../packages/backend/src/agents/codex/managed-codex-state";
import {
  acquireManagedSessionLease,
  acquirePortableFileLease,
} from "../../../packages/backend/src/managed-session-lock";
import * as managedSessionLocks from "../../../packages/backend/src/managed-session-lock";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { CodexSessions } from "../../../packages/backend/src/agents/codex/codex-sessions";
import type { Commands } from "../../../packages/backend/src/commands";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { OrchestrationService } from "../../../packages/backend/src/orchestration-service";
import { projectAgentFixture } from "./fixtures/project-agent";

const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const forkId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function commandOperations(root: string, sessionId: string) {
  const database = openManagedLedger(root)!;
  try {
    return database
      .prepare(
        "SELECT json_extract(evidence,'$.operation') AS operation FROM managed_commands WHERE session_id=? ORDER BY rowid",
      )
      .all(sessionId)
      .map((row) => row.operation);
  } finally {
    database.close();
  }
}

function dispatchLegacyAdoption(f: ReturnType<typeof fixture>) {
  const requestId = randomUUID();
  saveManagedRecord(f.root, {
    id: f.summary.id,
    workspace_id: "workspace",
    workspace: f.workspace,
    cwd: f.workspace,
    home: f.home,
    native_id: nativeId,
    title: f.summary.title,
    created_at: "2026-10-19T00:00:00Z",
    policy_id: "workspace-write-on-request",
    adopted: true,
    released: false,
    archived: false,
    snapshot: { status: "outcome-unknown", reason: "control-outcome-unconfirmed", revision: 1 },
  });
  claimManagedCommand(f.root, requestId, f.summary.id, "legacy-adopt", "fixture", {
    operation: "adopt",
    workspaceId: "workspace",
    executionMode: "codex-managed",
  });
  dispatchManagedCommand(f.root, requestId);
  return requestId;
}

function fixture(
  compressedHistory = false,
  registeredRoot?: string,
  runtimeEnvironment: NodeJS.ProcessEnv = {},
  publishConversationEvent?: (
    sessionId: string,
    type: "state" | "text-delta" | "item-upsert" | "snapshot",
    payload: Record<string, unknown>,
    live: Record<string, unknown>,
  ) => void,
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-codex-auto-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    workspace = registeredRoot === "home" ? root : (registeredRoot ?? path.join(root, "project"));
  mkdirSync(home);
  mkdirSync(workspace, { recursive: true });
  let executionCwd = workspace;
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(executable, "fixture executable");
  chmodSync(executable, 0o700);
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-10-19T00:00:00Z",
  );
  const summary = {
    id: "indexed-session",
    workspace_id: "workspace",
    agent: "codex",
    title: "Original",
    sidechain: false,
    archived: false,
  };
  const transcript = path.join(home, "sessions", `rollout-${nativeId}.jsonl`);
  const history =
    [
      { type: "session_meta", payload: { id: nativeId, cwd: workspace, source: "cli" } },
      { type: "event_msg", payload: { type: "user_message", message: "Earlier user input" } },
      { type: "event_msg", payload: { type: "agent_message", message: "Earlier answer" } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  let readers: SessionReaders;
  if (compressedHistory) {
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(`${transcript}.zst`, zstdCompressSync(history));
    const nativeDb = new DatabaseSync(path.join(home, "state_5.sqlite"));
    try {
      nativeDb.exec(
        "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,archived INTEGER)",
      );
      nativeDb
        .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)")
        .run(nativeId, transcript, workspace, summary.title, "cli", 0);
    } finally {
      nativeDb.close();
    }
    const environment = { CODEX_HOME: home, HOME: root, PATH: bin };
    const listing = new CodexSessions(environment).list(workspace);
    store.sessions.sync(
      "workspace",
      "codex",
      listing.sessions.map((item) => item.session),
    );
    summary.id = store.sessions.id("codex", nativeId);
    readers = new SessionReaders(store.sessions, {} as Commands, environment, {
      profiles: async () => [],
    });
    cleanups.push(() => readers.close());
  } else {
    vi.spyOn(store.sessions, "get").mockImplementation((id) =>
      id === summary.id ? (summary as ReturnType<typeof store.sessions.get>) : undefined,
    );
    readers = {
      codexHome: () => home,
      resolve: vi.fn(async () => ({
        summary,
        native: { agent: "codex", native_ref: nativeId },
        workspace,
      })),
      verifiedCodexControlIds: () => new Set([nativeId]),
      verifiedCodexControlDirectory: () => ({ id: nativeId, cwd: executionCwd }),
    } as unknown as SessionReaders;
  }
  const version = vi
    .spyOn(CodexRuntimePreflight.prototype, "check")
    .mockResolvedValue({ executable, reason: null });
  const follower = vi
    .spyOn(CodexFollowerBridge, "connect")
    .mockRejectedValue(new Error("must-not-follow-desktop"));
  // Never look for, or open anything in, the machine's real Codex app.
  vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(false);
  vi.spyOn(CodexDesktopApp.prototype, "openThread").mockResolvedValue(false);
  let nativeFailure: unknown;
  let turnFailure: unknown;
  // What `account/rateLimits/read` answers; an API-key login has no ChatGPT limits to read.
  let rateLimits: unknown = new Error("account-rate-limits-unavailable");
  const methods: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let broadSandbox = false;
  let sandboxRootsOverride: { value: unknown } | undefined;
  let policyReply: Record<string, unknown> = {};
  let readCwd: string | undefined;
  let readTurns: unknown[] | undefined;
  let wrongReplyCwd: "top" | "thread" | undefined;
  let sourceModel: string | null = "model-a";
  let sourceEffort: string | null = "low";
  let configuredModel = "model-a";
  let models: Array<Record<string, unknown>> = [
    { model: "model-a", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
  ];
  // The presets CLI 0.163.0 lists (CollaborationModeMask rows).
  let collaborationModes: unknown = {
    data: [
      { name: "Plan", mode: "plan", model: null, reasoning_effort: "medium" },
      { name: "Default", mode: "default", model: null, reasoning_effort: null },
    ],
  };
  let queueSupported = true;
  let exitOn: string | undefined;
  let serverUserAgent: string | null = null;
  let deleteFailure: unknown;
  let startThreadId = nativeId;
  /** Answers a request first when it returns anything; an Error is thrown. */
  let intercept:
    | ((method: string, params: Record<string, unknown>, server: OfflineServer) => unknown)
    | undefined;
  const deletes: Array<{ server: number; othersOpen: number }> = [];
  const servers: OfflineServer[] = [];
  class OfflineServer extends EventEmitter {
    connected = true;
    closed = false;
    userAgent = serverUserAgent;
    closeFailure?: Error;
    async request(method: string, params: unknown, dispatch?: () => void): Promise<unknown> {
      dispatch?.();
      methods.push(method);
      requests.push({ method, params });
      const intercepted = intercept?.(method, (params ?? {}) as Record<string, unknown>, this);
      if (intercepted instanceof Error) throw intercepted;
      if (intercepted !== undefined) return intercepted;
      if (method === exitOn) {
        // The CLI exits before it answers.
        this.connected = false;
        this.emit("close");
        throw new Error("app-server exited");
      }
      if (method === "thread/resume" && nativeFailure) throw nativeFailure;
      if (method === "model/list") return { data: models };
      if (method === "collaborationMode/list") {
        if (collaborationModes instanceof Error) throw collaborationModes;
        return collaborationModes;
      }
      if (method === "thread/goal/get") return { goal: null };
      if (method === "account/rateLimits/read") {
        if (rateLimits instanceof Error) throw rateLimits;
        return rateLimits;
      }
      if (method === "skills/list") return { data: [] };
      if (method === "thread/read")
        return {
          thread: {
            id: (params as { threadId?: string }).threadId ?? nativeId,
            cwd: readCwd ?? executionCwd,
            model: sourceModel,
            reasoningEffort: sourceEffort,
            status: { type: "idle" },
            turns: readTurns ?? [{ id: "finished-turn", status: "completed", items: [] }],
          },
        };
      if (method === "turn/start") {
        if (turnFailure) throw turnFailure;
        return { turn: { id: "new-turn", status: "inProgress" } };
      }
      if (method === "turn/steer") return { turnId: "new-turn" };
      if (method === "thread/backgroundTerminals/clean") return {};
      if (method === "thread/delete") {
        deletes.push({
          server: servers.indexOf(this),
          othersOpen: servers.filter((server) => server !== this && !server.closed).length,
        });
        if (deleteFailure) throw deleteFailure;
        // CLI 0.163.0 answers {} and removes the rollout and the state row.
        return {};
      }
      if (method === "thread/compact/start") {
        // CLI 0.163.0 answers first, then starts the compaction's own turn.
        setTimeout(
          () =>
            this.emit("notification", {
              method: "turn/started",
              params: { threadId: nativeId, turn: { id: "compact-turn", status: "inProgress" } },
            }),
          30,
        );
        return {};
      }
      if (method === "thread/queue/add")
        return {
          queuedSubmission: {
            id: "queued",
            clientUserMessageId: (params as Record<string, unknown>).clientUserMessageId,
          },
        };
      if (method === "thread/queue/list") {
        // CLI 0.147.0's answer; the connection stays open.
        if (!queueSupported)
          throw new CodexAppServerError({
            code: -32600,
            message: "Invalid request: unknown variant `thread/queue/list`, expected one of …",
          });
        return { data: [], nextCursor: null };
      }
      if (["thread/resume", "thread/start", "thread/fork", "thread/unarchive"].includes(method))
        return {
          thread: {
            id:
              method === "thread/fork"
                ? forkId
                : ((params as { threadId?: string }).threadId ?? startThreadId),
            cwd: wrongReplyCwd === "thread" ? workspace : executionCwd,
            status: { type: "idle" },
            turns: [],
          },
          cwd: wrongReplyCwd === "top" ? workspace : executionCwd,
          model: (params as Record<string, unknown>).model ?? configuredModel,
          reasoningEffort:
            (params as { config?: Record<string, unknown> }).config?.model_reasoning_effort ?? null,
          serviceTier: (params as Record<string, unknown>).serviceTier ?? null,
          approvalPolicy: (params as Record<string, unknown>).approvalPolicy,
          approvalsReviewer: (params as Record<string, unknown>).approvalsReviewer,
          sandbox:
            (params as Record<string, unknown>).sandbox === "danger-full-access"
              ? { type: "dangerFullAccess" }
              : {
                  type: "workspaceWrite",
                  writableRoots: sandboxRootsOverride
                    ? sandboxRootsOverride.value
                    : broadSandbox
                      ? [workspace]
                      : [],
                  networkAccess: false,
                  excludeTmpdirEnvVar:
                    (params as { config?: Record<string, unknown> }).config?.[
                      "sandbox_workspace_write.exclude_tmpdir_env_var"
                    ] === true,
                  excludeSlashTmp:
                    (params as { config?: Record<string, unknown> }).config?.[
                      "sandbox_workspace_write.exclude_slash_tmp"
                    ] === true,
                },
          ...policyReply,
        };
      throw new Error(`unexpected-native-method:${method}`);
    }
    async close() {
      this.connected = false;
      if (this.closeFailure) throw this.closeFailure;
      this.closed = true;
      this.emit("close");
    }
    respond() {}
    complete(turn: Record<string, unknown> = {}) {
      this.emit("notification", {
        method: "turn/completed",
        params: { threadId: nativeId, turn: { id: "new-turn", status: "completed", ...turn } },
      });
    }
    activateGoal() {
      this.emit("notification", {
        method: "thread/goal/updated",
        params: { threadId: nativeId, goal: { objective: "Continue the task", status: "active" } },
      });
    }
  }
  const start = vi
    .spyOn(CodexAppServerSession, "start")
    .mockImplementation(
      async (_executable, _workspace, _home, _environment, _notification, onStarted) => {
        const server = new OfflineServer();
        onStarted?.(server as unknown as CodexAppServerSession);
        servers.push(server);
        return server as unknown as CodexAppServerSession;
      },
    );
  let observed = true;
  const catalogChanged = vi.fn();
  const web = new WebReadRequests(
    store,
    readers,
    root,
    () => 0n,
    { CODEX_HOME: home, HOME: root, PATH: bin, ...runtimeEnvironment },
    publishConversationEvent,
    () => observed,
    undefined,
    catalogChanged,
  );
  cleanups.push(() => web.closeAsync());
  const live = () =>
    web.request({ operation: "live", sessionId: summary.id, experimentalEnabled: true });
  const sendWithState = (
    state: Awaited<ReturnType<typeof live>>,
    fields: Record<string, unknown> = {},
    restrictNativePolicy?: boolean,
  ) =>
    web.managedControl(
      {
        operation: "send",
        sessionId: summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        text: "Continue",
        ...fields,
      },
      restrictNativePolicy,
    );
  const send = async (fields: Record<string, unknown> = {}) => sendWithState(await live(), fields);
  return {
    root,
    home,
    bin,
    workspace,
    summary,
    store,
    readers,
    compressedTranscript: `${transcript}.zst`,
    history,
    web,
    live,
    send,
    sendWithState,
    methods,
    requests,
    servers,
    version,
    follower,
    start,
    catalogChanged,
    intercept: (
      value: (method: string, params: Record<string, unknown>, server: OfflineServer) => unknown,
    ) => {
      intercept = value;
    },
    setCwd: (cwd: string) => {
      executionCwd = cwd;
    },
    setReadCwd: (cwd: string) => {
      readCwd = cwd;
    },
    setReadTurns: (turns: unknown[]) => {
      readTurns = turns;
    },
    setSourceSettings: (model: string | null, effort: string | null) => {
      sourceModel = model;
      sourceEffort = effort;
    },
    setConfiguredModel: (model: string) => {
      configuredModel = model;
    },
    setModels: (value: Array<Record<string, unknown>>) => {
      models = value;
    },
    setCollaborationModes: (value: unknown) => {
      collaborationModes = value;
    },
    withoutQueue: () => {
      queueSupported = false;
    },
    setRateLimits: (value: unknown) => {
      rateLimits = value;
    },
    exitOn: (method: string | undefined) => {
      exitOn = method;
    },
    deletes,
    setDeleteFailure: (error: unknown) => {
      deleteFailure = error;
    },
    mismatchReply: (field: "top" | "thread") => {
      wrongReplyCwd = field;
    },
    widenSandbox: () => {
      broadSandbox = true;
    },
    setSandboxRoots: (value: unknown) => {
      sandboxRootsOverride = { value };
    },
    setPolicyReply: (value: Record<string, unknown>) => {
      policyReply = value;
    },
    setFailure: (error: unknown) => {
      nativeFailure = error;
    },
    setServerUserAgent: (value: string | null) => {
      serverUserAgent = value;
    },
    setStartThreadId: (value: string) => {
      startThreadId = value;
    },
    setTurnFailure: (error: unknown) => {
      turnFailure = error;
    },
    leave: () => {
      observed = false;
    },
    observe: () => {
      observed = true;
    },
  };
}

describe("restarting an AgentKib Codex worker", () => {
  async function runningWorker() {
    const f = fixture(true);
    const provider = f.web.codexSessionProvider();
    if (!(provider instanceof CodexSessionProvider)) throw new Error("missing Codex provider");
    expect(await f.send()).toMatchObject({ accepted: true });
    const live = await f.live();
    const request = {
      sessionId: f.summary.id,
      workspaceId: f.summary.workspace_id,
      deviceId: "project-owner",
      requestId: randomUUID(),
      runtimeBootId: String(live.runtimeBootId),
      expectedRevision: Number(live.revision),
      turnId: String(live.turnId),
      experimentalEnabled: true as const,
    };
    return { f, provider, request };
  }

  it("interrupts the same thread, preserving its native queue and history", async () => {
    const { f, provider, request } = await runningWorker();
    const pending = { id: "pending", input: [{ type: "text", text: "Queued user message" }] };
    f.intercept((method) => {
      if (method === "thread/queue/list") return { data: [pending], nextCursor: null };
      if (method === "turn/interrupt") return {};
    });
    const check = vi.fn();
    await expect(provider.restartWorker(request, check)).resolves.toMatchObject({
      accepted: true,
      controlOutcome: "accepted",
    });
    await expect(provider.restartWorker(request, check)).resolves.toMatchObject({
      accepted: true,
      controlOutcome: "accepted",
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.requests.filter(({ method }) => method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId: nativeId, turnId: "new-turn" } },
    ]);
    expect(
      readControlReceipt(f.root, { requestId: request.requestId, deviceId: request.deviceId }),
    ).toMatchObject({
      operation: "stop",
      status: "accepted",
    });
    expect(f.servers[0]?.connected).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(1);
    await expect(
      f.web.managedQueueList({ operation: "queue-list", sessionId: request.sessionId }),
    ).resolves.toMatchObject({ data: [pending] });
    await expect(
      f.readers.events({ sessionId: request.sessionId, limit: 25 }),
    ).resolves.toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ content: "Earlier answer" })]),
    });
  });

  it("leaves the idle process running when it cannot prove a safe retirement", async () => {
    const { f, provider, request } = await runningWorker();
    f.servers[0]!.complete();
    await expect.poll(async () => (await f.live()).status).toBe("idle");
    const check = vi.fn();
    await expect(
      provider.restartWorker({ ...request, turnId: null }, check),
    ).resolves.toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "worker-restart-unsupported",
    });
    expect(check).not.toHaveBeenCalled();
    expect(f.servers[0]?.connected).toBe(true);
  });

  it("rejects a restart if its delegation changed before dispatch", async () => {
    const { f, provider, request } = await runningWorker();
    await expect(
      provider.restartWorker(request, () => {
        throw new Error("delegation-paused");
      }),
    ).resolves.toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "delegation-paused",
    });
    expect(f.methods).not.toContain("turn/interrupt");
  });

  it("replays an uncertain interrupt receipt without dispatching again", async () => {
    const { f, provider, request } = await runningWorker();
    f.exitOn("turn/interrupt");
    const check = vi.fn();
    for (let attempt = 0; attempt < 2; attempt++)
      await expect(provider.restartWorker(request, check)).resolves.toMatchObject({
        accepted: false,
        controlOutcome: "unknown",
      });
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.methods.filter((method) => method === "turn/interrupt")).toHaveLength(1);
  });
});

describe("a Codex Project Agent's thread", () => {
  async function queuedWorker(change: (server: EventEmitter, turnId: string) => void) {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(await f.sendWithState(await f.live(), { operation: "queue-add" })).toMatchObject({
      accepted: true,
    });
    const worker = f.summary.id;
    const server = f.servers.at(-1)!;
    const turnId = "queued-turn";
    server.complete();
    server.emit("notification", {
      method: "turn/started",
      params: { threadId: nativeId, turn: { id: turnId, status: "inProgress" } },
    });
    const before = await f.live();
    expect(before).toMatchObject({ status: "running", turnId });

    const provider = f.web.codexSessionProvider() as CodexSessionProvider;
    const lead = new OrchestrationService(
      f.root,
      "fixture-boot",
      {
        control: async (request, intent) => {
          expect(intent).toBe("codex-worker-turn");
          expect(request.expectedRevision).toBe(before.revision);
          expect(request.turnId).toBe(turnId);
          change(server, turnId);
          await f.live();
          return provider.workerTurnSend(request);
        },
        live: f.live,
        events: async () => [],
        session: (sessionId) =>
          sessionId === worker ? { agent: "codex", workspaceId: "workspace", title: null } : null,
        managed: async () => true,
        workspaces: () => [{ id: "workspace", name: "Fixture" }],
      },
      (id) => id === "project-agent",
      () => false,
    );
    cleanups.push(() => lead.close());
    await lead.assignWorkers({
      sessionId: "project-agent",
      deviceId: "fixture",
      workspaceId: "workspace",
      workers: [worker],
    });
    return { f, lead, server, turnId, before };
  }

  function workerUsage(server: EventEmitter, turnId: string, totalTokens = 10) {
    server.emit("notification", {
      method: "thread/tokenUsage/updated",
      params: { threadId: nativeId, turnId, tokenUsage: { total: { totalTokens } } },
    });
  }

  describe.each([
    ["steer", "steer", "turn/steer"],
    ["queue", "queue-add", "thread/queue/add"],
  ] as const)("Project Agent %s of a native queued turn", (mode, operation, nativeMethod) => {
    it("accepts same-turn usage and streamed output updates across admission and dispatch", async () => {
      const { f, lead, server, turnId, before } = await queuedWorker(workerUsage);
      server.emit("notification", {
        method: "item/commandExecution/terminalInteraction",
        params: { threadId: nativeId, turnId, itemId: "running-command" },
      });
      expect(await f.live()).toMatchObject({ revision: before.revision, turnId });
      f.intercept((method, params, current) => {
        if (method === "model/list") {
          workerUsage(current, turnId, 20);
          current.emit("notification", {
            method: "item/agentMessage/delta",
            params: { threadId: nativeId, turnId, delta: "Worker output" },
          });
        }
        if (method === "turn/steer") return { turnId: params.expectedTurnId };
      });
      const priorCalls = f.methods.filter((method) => method === nativeMethod).length;
      const result = await lead.call("project-agent", "worker_send", {
        worker: "worker-1",
        mode,
        text: "New instruction",
      });
      const live = await f.live();
      expect(live).toMatchObject({ turnId, status: "running", streamText: "Worker output" });
      expect(live.revision).toBeGreaterThan(before.revision);
      expect(JSON.parse(result.text), result.text).toMatchObject({ accepted: true, operation });
      expect(f.methods.filter((method) => method === nativeMethod)).toHaveLength(priorCalls + 1);
      if (mode === "steer")
        expect(f.requests.findLast(({ method }) => method === nativeMethod)?.params).toMatchObject({
          threadId: nativeId,
          expectedTurnId: turnId,
        });
    });

    it.each(["turn", "settings", "goal", "identity"] as const)(
      "rejects a change to the worker's %s during native preflight without dispatching",
      async (change) => {
        const { f, lead, turnId } = await queuedWorker(workerUsage);
        const record = readManagedRecord(f.root, f.summary.id)!;
        let changed = false;
        f.intercept((method, _params, server) => {
          if (method !== "model/list") return;
          changed = true;
          if (change === "identity") {
            saveManagedRecord(f.root, { ...record, native_id: forkId });
          } else if (change === "turn") {
            server.complete({ id: turnId });
            server.emit("notification", {
              method: "turn/started",
              params: { threadId: nativeId, turn: { id: "replacement", status: "inProgress" } },
            });
          } else if (change === "settings") {
            for (const settings of [
              { ...(record.native_settings as object), effort: "high" },
              record.native_settings,
            ])
              server.emit("notification", {
                method: "thread/settings/updated",
                params: { threadId: nativeId, threadSettings: settings },
              });
          } else {
            server.activateGoal();
            server.emit("notification", {
              method: "thread/goal/cleared",
              params: { threadId: nativeId },
            });
          }
        });
        const priorCalls = f.methods.filter((method) => method === nativeMethod).length;
        const result = await lead.call("project-agent", "worker_send", {
          worker: "worker-1",
          mode,
          text: "Do not dispatch this instruction",
        });
        expect(changed).toBe(true);
        expect(JSON.parse(result.text), result.text).toMatchObject({
          accepted: false,
          operation,
          reason: change === "identity" ? "session-unavailable" : "stale-or-disabled-control",
        });
        expect(f.methods.filter((method) => method === nativeMethod)).toHaveLength(priorCalls);
      },
    );

    it("keeps strict public revision checks for a direct control", async () => {
      const { f, server, turnId, before } = await queuedWorker(() => {});
      workerUsage(server, turnId);
      expect((await f.live()).revision).toBeGreaterThan(before.revision);
      const priorCalls = f.methods.filter((method) => method === nativeMethod).length;
      await expect(f.sendWithState(before, { operation, turnId })).rejects.toThrow(
        "stale-or-disabled-control",
      );
      expect(f.methods.filter((method) => method === nativeMethod)).toHaveLength(priorCalls);
    });
  });

  it.each(["idle retirement", "backend shutdown"] as const)(
    "starts the first assigned Worker task after %s closes its unwritten native thread",
    async (retirement) => {
      const f = fixture(true);
      const emptyThreadId = "11111111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const replacementId = "22222222-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      f.setStartThreadId(emptyThreadId);
      const created = await f.web.sessionProviderCreate("codex", {
        requestId: randomUUID(),
        deviceId: "fixture",
        workspaceId: "workspace",
        policyId: "workspace-write-on-request",
        model: "model-a",
      });
      expect(created).toMatchObject({ accepted: true });
      const worker = created.sessionId as string;
      expect(f.methods).not.toContain("turn/start");
      const initialServer = f.servers.at(-1)!;
      let web = f.web;
      if (retirement === "idle retirement") {
        f.leave();
        await vi.waitFor(() => expect(initialServer.closed).toBe(true), { timeout: 3_000 });
      } else {
        await f.web.closeAsync();
        expect(initialServer.closed).toBe(true);
        web = new WebReadRequests(f.store, f.readers, f.root, () => 0n, {
          HOME: f.root,
          CODEX_HOME: f.home,
          PATH: f.bin,
        });
        cleanups.push(() => web.closeAsync());
      }

      // Codex writes a thread with its first message. The server that allocated this
      // transient ID is gone, and the new server cannot resume it.
      f.intercept((method, params) =>
        method === "thread/resume" && params.threadId === emptyThreadId
          ? new CodexAppServerError({ code: -32600, message: "thread not found" })
          : undefined,
      );
      f.setStartThreadId(replacementId);
      const delivered: string[] = [];
      const lead = new OrchestrationService(
        f.root,
        "fixture-boot",
        {
          control: (request) => web.managedControl(request),
          live: (sessionId) =>
            web.request({ operation: "live", sessionId, experimentalEnabled: true }),
          events: async (sessionId, limit) =>
            (
              (await web.request({ operation: "events", sessionId, limit })) as {
                events: Array<Record<string, unknown>>;
              }
            ).events,
          session: (sessionId) =>
            sessionId === worker ? { agent: "codex", workspaceId: "workspace", title: null } : null,
          managed: async () => true,
          workspaces: () => [{ id: "workspace", name: "Fixture" }],
        },
        (id) => id === "project-agent",
        (_id, _deviceId, report) => {
          delivered.push(report);
          return false;
        },
      );
      cleanups.push(() => lead.close());
      web.observeLanes({
        turnEnded: (...args) => void lead.laneTurnEnded(...args),
        waiting: () => {},
      });
      await lead.assignWorkers({
        sessionId: "project-agent",
        deviceId: "fixture",
        workspaceId: "workspace",
        workers: [worker],
      });
      const result = await lead.call("project-agent", "worker_send", {
        worker: "worker-1",
        text: "Do the first task.",
      });
      expect(JSON.parse(result.text), result.text).toMatchObject({
        accepted: true,
        operation: "send",
      });
      expect(f.requests.filter(({ method }) => method === "thread/resume")).toEqual([]);
      const dispatched = f.requests.filter(({ method }) => method === "turn/start");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.params).toMatchObject({
        threadId: replacementId,
        input: [expect.objectContaining({ type: "text", text: "Do the first task." })],
      });
      expect(readManagedRecord(f.root, worker)).toMatchObject({
        id: worker,
        native_id: replacementId,
      });
      const server = f.servers.at(-1)!;
      server.emit("notification", {
        method: "item/completed",
        params: {
          threadId: replacementId,
          turnId: "new-turn",
          item: { type: "agentMessage", id: "first-reply", text: "First task complete." },
        },
      });
      server.emit("notification", {
        method: "turn/completed",
        params: { threadId: replacementId, turn: { id: "new-turn", status: "completed" } },
      });
      await vi.waitFor(() =>
        expect(delivered).toEqual([expect.stringContaining("First task complete.")]),
      );
    },
  );

  it("merges consecutive Worker reports queued through the backend into one automatic turn", async () => {
    const f = fixture(true);
    const sessionId = f.summary.id;
    expect(await f.send()).toMatchObject({ accepted: true });
    f.servers.at(-1)!.complete();
    await vi.waitFor(async () => expect(await f.live()).toMatchObject({ status: "idle" }));
    await f.web.closeAsync();

    const workerId = "offline-worker";
    saveManagedRecord(f.root, {
      ...readManagedRecord(f.root, sessionId)!,
      id: workerId,
      native_id: null,
      adopted: false,
    });
    writeFileSync(
      path.join(f.root, "preferences.json"),
      JSON.stringify({ session_index_enabled: false, session_content_search_enabled: false }),
    );
    vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
    vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
    const observe = vi.spyOn(WebReadRequests.prototype, "observeLanes");
    const backend = new TypeScriptBackend({
      HOME: f.home,
      CODEX_HOME: f.home,
      PATH: f.bin,
    });
    cleanups.push(() => backend.closeAsync());
    const rpc = async (method: string, params: unknown) => {
      const response = await backend.handleAsync({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      });
      expect(response.error).toBeUndefined();
      return response.result;
    };
    const deviceId = "agentkib-local-owner";
    const lead = (operation: string, fields: Record<string, unknown> = {}) =>
      rpc("session.request", {
        host: { target: "claude-code", request: { operation, sessionId, deviceId, ...fields } },
      });
    const codex = (request: Record<string, unknown>) =>
      rpc("session.request", {
        host: { request: { sessionId, experimentalEnabled: true, ...request } },
      });

    const queued: Array<{ id: string; clientUserMessageId: unknown; input: unknown }> = [];
    f.intercept((method, params) => {
      if (method === "thread/queue/list") return { data: queued, nextCursor: null };
      if (method === "thread/queue/add") {
        const queuedSubmission = {
          id: `report-${queued.length + 1}`,
          clientUserMessageId: params.clientUserMessageId,
          input: params.input,
        };
        queued.push(queuedSubmission);
        return { queuedSubmission };
      }
      if (method === "thread/queue/update") {
        const target = queued.find(({ id }) => id === params.queuedSubmissionId);
        if (!target) throw new Error("unexpected queued report");
        target.input = params.input;
        return { queuedSubmission: target };
      }
    });

    await rpc("backend.initialize", { dataDir: f.root });
    expect(await lead("lead-assign-workers", { workers: [workerId] })).toMatchObject({
      lead: { workers: [{ sessionId: workerId }], autoTurns: 0 },
    });
    const state = (await codex({ operation: "live" })) as Record<string, unknown>;
    expect(
      await codex({
        operation: "send",
        requestId: randomUUID(),
        deviceId,
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        text: "Review the project",
      }),
    ).toMatchObject({ accepted: true });
    expect(await codex({ operation: "live" })).toMatchObject({ status: "running" });

    const observer = observe.mock.lastCall![0]!;
    observer.turnEnded(workerId, "worker-turn-one", "completed", null, undefined, "First reply");
    await vi.waitFor(() => {
      expect(queued).toHaveLength(1);
      expect(
        readControlReceipt(f.root, { requestId: queued[0]!.clientUserMessageId, deviceId }),
      ).toMatchObject({ status: "accepted", operation: "queue-add" });
    });
    const queueMutations = () =>
      f.methods.filter(
        (method) => method === "thread/queue/add" || method === "thread/queue/update",
      );
    observer.turnEnded(workerId, "worker-turn-two", "completed", null, undefined, "Second reply");
    await vi.waitFor(() => expect(queueMutations()).toHaveLength(2));

    expect(queueMutations()).toEqual(["thread/queue/add", "thread/queue/update"]);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.input).toEqual([
      expect.objectContaining({ text: expect.stringMatching(/First reply[\s\S]+Second reply/) }),
    ]);
    await vi.waitFor(async () =>
      expect(await lead("lead-status")).toMatchObject({ lead: { paused: false, autoTurns: 1 } }),
    );
  });

  it("starts with its worker tools, and again without them once it no longer leads", async () => {
    const f = fixture();
    const lead = projectAgentFixture(f.summary.id, f.summary.workspace_id);
    cleanups.push(lead.close);
    const endpoint = await lead.service.leadEndpoint(f.summary.id);
    if (!endpoint) throw new Error("Missing Project Agent endpoint");
    const { url } = endpoint;
    let enabled = true;
    f.web.leadEndpoints(async (id) => (enabled && id === f.summary.id ? endpoint : null));
    const attached = () =>
      f.requests.filter(({ method }) => ["thread/start", "thread/resume"].includes(method));
    const config = () =>
      (attached().at(-1)?.params as { config?: Record<string, unknown> } | undefined)?.config;
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(config()).toMatchObject({ "mcp_servers.agentkib_workers.url": url });
    expect(f.web.codexLeadCapable(f.summary.id)).toBe(true);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const request = (body: Record<string, unknown>) =>
      fetch(String(config()?.["mcp_servers.agentkib_workers.url"]), {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      });
    const initialize = await request({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "offline-codex", version: "1" },
      },
    });
    expect(initialize.ok).toBe(true);
    headers["mcp-session-id"] = String(initialize.headers.get("mcp-session-id"));
    await initialize.json();
    await request({ method: "notifications/initialized" });
    const listed = await request({ id: 2, method: "tools/list" });
    const { result } = await listed.json();
    expect(result.tools.map(({ name }: { name: string }) => name)).toEqual([
      "worker_list",
      "worker_send",
      "worker_read",
      "worker_stop",
      "worker_restart",
    ]);
    // Released while its turn runs: the thread starts again once the turn ends.
    enabled = false;
    await f.web.restartManagedRunner(f.summary.id);
    const server = f.servers.at(-1)!;
    expect(server.closed).toBe(false);
    const before = attached().length;
    server.complete();
    await vi.waitFor(() => expect(server.closed).toBe(true), { timeout: 5_000 });
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(attached()).toHaveLength(before + 1);
    expect(config()).not.toHaveProperty("mcp_servers.agentkib_workers.url");
    // Kept as AgentKib's, not released to the Codex app.
    expect(f.web.isManagedSession(f.summary.id)).toBe(true);
  });
});

describe("Codex manual compaction", () => {
  async function compact(f: ReturnType<typeof fixture>) {
    const state = await f.live();
    return f.web.managedControl({
      operation: "compact",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
    });
  }
  const capabilities = (f: ReturnType<typeof fixture>) =>
    f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.summary.id,
      experimentalEnabled: true,
    }) as Promise<{ features: Record<string, { available: boolean; reason?: string }> }>;

  it("starts Codex's compaction and returns once its turn runs", async () => {
    const f = fixture();
    // Like send, it starts the runner for a session that has none.
    expect((await capabilities(f)).features.compact).toEqual({ available: true });
    expect(await compact(f)).toMatchObject({ accepted: true, completed: false });
    expect(f.requests.find(({ method }) => method === "thread/compact/start")?.params).toEqual({
      threadId: nativeId,
    });
    // Nothing can be sent between the reply and the compaction's turn.
    expect(await f.live()).toMatchObject({
      status: "running",
      turnId: "compact-turn",
      sendEnabled: false,
    });
    expect((await capabilities(f)).features.compact).toMatchObject({ available: false });
    f.servers.at(-1)!.emit("notification", {
      method: "turn/completed",
      params: { threadId: nativeId, turn: { id: "compact-turn", status: "completed" } },
    });
    await vi.waitFor(async () =>
      expect((await capabilities(f)).features.compact).toEqual({ available: true }),
    );
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
  });

  it("is not started while a turn runs", async () => {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(await compact(f)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    expect(f.methods).not.toContain("thread/compact/start");
  });
});

describe("Codex control routing", () => {
  // The browser and the desktop window reach these through web.request; the IPC path uses
  // codex.managed. Both must hand them to their owner, as they do send.
  it.each([
    ["web.request", "compact", "managedControl"],
    ["web.request", "terminals-clean", "managedControl"],
    ["web.request", "delete", "managedDelete"],
    ["codex.managed", "compact", "managedControl"],
    ["codex.managed", "terminals-clean", "managedControl"],
    ["codex.managed", "delete", "managedDelete"],
  ] as const)("routes %s %s to %s", async (method, operation, owner) => {
    const f = fixture();
    await f.web.closeAsync();
    writeFileSync(
      path.join(f.root, "preferences.json"),
      JSON.stringify({ session_index_enabled: false, session_content_search_enabled: false }),
    );
    vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
    vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
    const control = vi
      .spyOn(WebReadRequests.prototype, owner)
      .mockResolvedValue({ accepted: true, operation } as never);
    const backend = new TypeScriptBackend({
      HOME: f.home,
      CODEX_HOME: f.home,
      PATH: path.join(f.root, "bin"),
    });
    cleanups.push(() => backend.closeAsync());
    const rpc = (name: string, params: unknown) =>
      backend.handleAsync({ jsonrpc: "2.0", id: randomUUID(), method: name, params });
    expect((await rpc("backend.initialize", { dataDir: f.root })).error).toBeUndefined();
    const params = {
      operation,
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: "boot",
      expectedRevision: 0,
      experimentalEnabled: true,
    };
    const response = await rpc(method, params);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ accepted: true, operation });
    expect(control).toHaveBeenCalledExactlyOnceWith(params);
  });
});

describe("Codex start probes", () => {
  it.each(["collaborationMode/list", "thread/queue/list"])(
    "fail the start, without a turn, when the CLI exits answering %s",
    async (method) => {
      const f = fixture();
      f.exitOn(method);
      expect(await f.send()).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
      expect(f.methods).toContain(method);
      expect(f.methods).not.toContain("turn/start");
      expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
      expect(commandOperations(f.root, f.summary.id)).toEqual(["send"]);
    },
  );
});

describe("Codex queued messages", () => {
  it("are not offered by a CLI without thread/queue, such as 0.147.0", async () => {
    const f = fixture();
    f.withoutQueue();
    const features = async () =>
      (
        (await f.web.managedQuery({
          operation: "capabilities",
          sessionId: f.summary.id,
          experimentalEnabled: true,
        })) as { features: Record<string, { available: boolean; reason?: string }> }
      ).features;
    expect(await f.send()).toMatchObject({ accepted: true });
    const capabilities = { features: await features() };
    for (const operation of [
      "queue-list",
      "queue-add",
      "queue-update",
      "queue-delete",
      "queue-reorder",
    ])
      expect(capabilities.features[operation]).toEqual({
        available: false,
        reason: "unsupported-codex-cli-version",
      });
    // Steering stays: it is turn/steer.
    expect(capabilities.features.steer).toEqual({ available: true });
    await expect(
      f.web.managedQueueList({ operation: "queue-list", sessionId: f.summary.id }),
    ).rejects.toThrow("unsupported-codex-cli-version");
    const state = await f.live();
    const before = f.methods.filter((method) => method === "thread/queue/add").length;
    expect(
      await f.web.managedControl({
        operation: "queue-add",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        turnId: "new-turn",
        text: "Later",
      }),
    ).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: "unsupported-codex-cli-version",
    });
    expect(f.methods.filter((method) => method === "thread/queue/add")).toHaveLength(before);
    const latest = await f.live();
    expect(
      await f.web.managedControl({
        operation: "queue-delete",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: latest.runtimeBootId,
        expectedRevision: latest.revision,
        experimentalEnabled: true,
        queuedSubmissionId: "queued-1",
      }),
    ).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: "unsupported-codex-cli-version",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
  });
});

describe("Codex background terminals", () => {
  it("ends them while the runner has any, as the terminal's /stop does", async () => {
    const f = fixture();
    const clean = async () => {
      const state = await f.live();
      return f.web.managedControl({
        operation: "terminals-clean",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
      });
    };
    // Without a runner there is nothing to end, and nothing is started for it.
    expect(await clean()).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "session-not-running",
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(await clean()).toMatchObject({ accepted: true, completed: true });
    expect(
      f.requests.find(({ method }) => method === "thread/backgroundTerminals/clean")?.params,
    ).toEqual({ threadId: nativeId });
    // The turn keeps running.
    expect(await f.live()).toMatchObject({ status: "running", turnId: "new-turn" });
  });
});

describe("Codex delete", () => {
  async function remove(
    f: ReturnType<typeof fixture>,
    requestId = randomUUID(),
    sessionId = f.summary.id,
  ) {
    const state = await f.live();
    return f.web.managedDelete({
      operation: "delete",
      sessionId,
      requestId,
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: sessionId === f.summary.id ? state.revision : 0,
      experimentalEnabled: true,
    });
  }
  const features = async (f: ReturnType<typeof fixture>) =>
    (
      (await f.web.managedQuery({
        operation: "capabilities",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      })) as { features: Record<string, { available: boolean; reason?: string }> }
    ).features;
  const gone = (message: string) => new CodexAppServerError({ code: -32600, message });

  it("deletes the thread in Codex and drops the conversation from AgentKib's index", async () => {
    const f = fixture(true);
    expect(f.store.sessions.get(f.summary.id)).toMatchObject({ agent: "codex" });
    expect((await features(f)).delete).toEqual({ available: true });
    expect(await remove(f)).toMatchObject({ accepted: true, completed: true, deleted: true });
    // One process of its own, which asked for nothing else: no resume, no turn.
    expect(f.methods).toEqual(["thread/delete"]);
    expect(f.requests).toEqual([{ method: "thread/delete", params: { threadId: nativeId } }]);
    expect(f.servers).toHaveLength(1);
    expect(f.servers[0]!.closed).toBe(true);
    expect(f.store.sessions.get(f.summary.id)).toBeNull();
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
  });

  it("closes AgentKib's own runner first and deletes from a process of its own", async () => {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    f.servers.at(-1)!.complete();
    await vi.waitFor(async () => expect(await f.live()).toMatchObject({ status: "idle" }));
    expect((await features(f)).delete).toEqual({ available: true });
    expect(readManagedRecord(f.root, f.summary.id)).not.toBeNull();
    // The ledger's copy of the transcript goes too.
    const ledger = openManagedLedger(f.root)!;
    try {
      ledger
        .prepare("INSERT INTO managed_events(session_id,event_id,event) VALUES(?,?,?)")
        .run(
          f.summary.id,
          "synthetic-item",
          JSON.stringify({ type: "message", text: "Synthetic" }),
        );
    } finally {
      ledger.close();
    }
    expect(readManagedEvents(f.root, f.summary.id, null, 100).events).toMatchObject([
      { id: "codex-turn-end:new-turn", turn_meta: { outcome: "completed" } },
      { id: "synthetic-item", text: "Synthetic" },
    ]);
    expect(await remove(f)).toMatchObject({ accepted: true, completed: true, deleted: true });
    // Codex lets one process write a thread: the runner had exited before the delete was sent.
    expect(f.deletes).toEqual([{ server: 1, othersOpen: 0 }]);
    expect(f.servers.every((server) => server.closed)).toBe(true);
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
    expect(readManagedEvents(f.root, f.summary.id, null, 100).events).toEqual([]);
  });

  it("waits for a running turn", async () => {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    expect((await features(f)).delete).toMatchObject({ available: false });
    expect(await remove(f)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "session-busy",
    });
    expect(f.methods).not.toContain("thread/delete");
    expect(f.servers.at(-1)!.closed).toBe(false);
  });

  it("says another Codex process holds the thread and starts nothing", async () => {
    const f = fixture();
    const directory = path.join(f.home, "thread-writer-locks");
    mkdirSync(directory, { recursive: true });
    cleanups.push(acquirePortableFileLease(path.join(directory, `${nativeId}.lock`)));
    expect((await features(f)).delete).toEqual({ available: false, reason: "codex-owner-busy" });
    expect(await remove(f)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("keeps the conversation when Codex answers that another process writes it", async () => {
    const f = fixture(true);
    f.setDeleteFailure(gone(`thread ${nativeId} already has an active writer`));
    expect(await remove(f)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    });
    expect(f.store.sessions.get(f.summary.id)).toMatchObject({ agent: "codex" });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
  });

  it("clears AgentKib's copies of a thread already deleted in Codex", async () => {
    const f = fixture(true);
    f.setDeleteFailure(gone(`no rollout found for thread id ${nativeId}`));
    expect(await remove(f)).toMatchObject({ accepted: true, deleted: true });
    expect(f.store.sessions.get(f.summary.id)).toBeNull();
  });

  it("offers and deletes an archived conversation, as Codex Desktop's archived list does", async () => {
    const f = fixture();
    f.summary.archived = true;
    expect((await features(f)).delete).toEqual({ available: true });
    expect(await remove(f)).toMatchObject({ accepted: true, deleted: true });
    expect(f.deletes).toEqual([{ server: 0, othersOpen: 0 }]);
  });

  it("resolves an unconfirmed delete by deleting again", async () => {
    const f = fixture(true);
    f.exitOn("thread/delete");
    const first = randomUUID();
    expect(await remove(f, first)).toMatchObject({
      accepted: false,
      controlOutcome: "unknown",
      reason: "control-outcome-unconfirmed",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(1);
    // Only another delete is offered: it is how that outcome resolves.
    const offered = await features(f);
    expect(offered.delete).toEqual({ available: true });
    expect(offered.send).toMatchObject({ available: false });
    f.exitOn(undefined);
    f.setDeleteFailure(gone(`no rollout found for thread id ${nativeId}`));
    expect(await remove(f)).toMatchObject({ accepted: true, deleted: true });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(readControlReceipt(f.root, { requestId: first, deviceId: "fixture" })).toMatchObject({
      status: "accepted",
      operation: "delete",
    });
  });

  it("refuses while another operation's outcome is unconfirmed", async () => {
    const f = fixture();
    const requestId = randomUUID();
    claimManagedCommand(f.root, requestId, f.summary.id, "synthetic-unknown", "fixture", {
      operation: "send",
    });
    dispatchManagedCommand(f.root, requestId);
    expect((await features(f)).delete).toEqual({
      available: false,
      reason: "control-outcome-unconfirmed",
    });
    expect(await remove(f)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("deletes a conversation that never reached Codex without starting anything", async () => {
    const f = fixture();
    saveManagedRecord(f.root, {
      id: "draft-session",
      workspace_id: "workspace",
      workspace: f.workspace,
      home: f.home,
      native_id: null,
      title: "Draft",
      created_at: "2026-10-28T00:00:00Z",
      released: true,
      adopted: false,
      archived: false,
      snapshot: { revision: 0 },
    });
    expect(await remove(f, randomUUID(), "draft-session")).toMatchObject({
      accepted: true,
      deleted: true,
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(readManagedRecord(f.root, "draft-session")).toBeNull();
  });

  it("replays the answer for a repeated request", async () => {
    const f = fixture(true);
    const state = await f.live();
    const request = {
      operation: "delete",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
    };
    const first = await f.web.managedDelete(request);
    expect(first).toMatchObject({ accepted: true, deleted: true });
    // The conversation is gone, but its answer is not.
    expect(await f.web.managedDelete(request)).toEqual(first);
    expect(f.methods).toEqual(["thread/delete"]);
  });
});

describe("Codex MCP requests", () => {
  // The approval CLI 0.163.0 asks before a non-read-only MCP tool runs.
  const toolApproval = {
    id: 41,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: nativeId,
      turnId: "new-turn",
      serverName: "stubmcp",
      mode: "form",
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        persist: ["session", "always"],
        tool_title: "Write stub record",
      },
      message: 'Allow the stubmcp MCP server to run tool "write"?',
      requestedSchema: { type: "object", properties: {} },
    },
  };
  async function running(request: Record<string, unknown> = toolApproval) {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    const server = f.servers.at(-1)!;
    const replies: unknown[] = [];
    (server as unknown as { respond: (id: unknown, result: unknown) => void }).respond = (
      id,
      result,
    ) => {
      replies.push([id, result]);
      server.emit("notification", {
        method: "serverRequest/resolved",
        params: { threadId: nativeId, requestId: id },
      });
    };
    server.emit("serverRequest", request);
    await vi.waitFor(async () => expect((await f.live()).approvals).toHaveLength(1));
    return { f, replies };
  }
  async function approve(f: ReturnType<typeof fixture>, fields: Record<string, unknown>) {
    const state = await f.live();
    return f.web.managedControl({
      operation: "approve",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      turnId: "new-turn",
      approvalId: 41,
      ...fields,
    });
  }

  it.each([
    ["allow once", { decision: "accept" }, { action: "accept", content: {} }],
    [
      "allow for this session",
      { nativeDecision: { action: "accept", content: {}, _meta: { persist: "session" } } },
      { action: "accept", content: {}, _meta: { persist: "session" } },
    ],
    ["decline", { decision: "decline" }, { action: "decline" }],
    ["cancel the turn", { decision: "cancel" }, { action: "cancel" }],
  ])("answers the MCP tool approval: %s", async (_name, fields, reply) => {
    const { f, replies } = await running();
    expect(await approve(f, fields)).toMatchObject({ accepted: true });
    expect(replies).toEqual([[41, reply]]);
    expect(await f.live()).toMatchObject({ status: "running", approvals: [] });
  });

  it("does not accept a form it cannot fill in, or always-allow", async () => {
    const { f, replies } = await running({
      ...toolApproval,
      params: {
        ...toolApproval.params,
        _meta: null,
        message: "Pick a color.",
        requestedSchema: { type: "object", properties: { color: { type: "string" } } },
      },
    });
    for (const fields of [
      { decision: "accept" },
      { nativeDecision: { action: "accept", content: {}, _meta: { persist: "always" } } },
    ])
      expect(await approve(f, fields)).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        error: "unsupported-decision",
      });
    expect(replies).toEqual([]);
    expect(await approve(f, { decision: "decline" })).toMatchObject({ accepted: true });
    expect(replies).toEqual([[41, { action: "decline" }]]);
  });
});

describe("Codex attachments", () => {
  const capabilities = (f: ReturnType<typeof fixture>, experimentalEnabled = true) =>
    f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.summary.id,
      experimentalEnabled,
    }) as Promise<{ features: Record<string, { available: boolean; reason?: string }> }>;

  it("opens uploads with send and passes an image to Codex as native image input", async () => {
    const f = fixture();
    // Before any runner, a send with attachments starts one, as a plain send does.
    const inactive = await capabilities(f);
    expect(inactive.features.attachments).toEqual({ available: true });
    expect((await capabilities(f, false)).features.attachments).toEqual(
      (await capabilities(f, false)).features.send,
    );
    const image = path.join(f.root, "attachment.png");
    writeFileSync(image, Buffer.from("89504e470d0a1a0a", "hex"));
    // The host turns uploads into these rows (AttachmentStore.input for Codex).
    expect(
      await f.send({
        text: undefined,
        input: [
          { type: "text", text: "What is in this image?", text_elements: [] },
          { type: "localImage", path: image },
          {
            type: "text",
            text: `User attached file "notes.txt": ${f.root}/notes`,
            text_elements: [],
          },
        ],
      }),
    ).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      input: [
        { type: "text", text: "What is in this image?" },
        { type: "localImage", path: image },
        { type: "text", text: `User attached file "notes.txt": ${f.root}/notes` },
      ],
    });
    // Steer and queue-add take attachments while the turn runs.
    expect((await capabilities(f)).features.attachments).toEqual({ available: true });
    expect((await capabilities(f, false)).features.attachments).toMatchObject({
      available: false,
      reason: "control-disabled",
    });
  });

  it("rejects an image that is no longer a file before sending anything", async () => {
    const f = fixture();
    expect(
      await f.send({
        text: undefined,
        input: [
          { type: "text", text: "Look", text_elements: [] },
          { type: "localImage", path: path.join(f.root, "missing.png") },
        ],
      }),
    ).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
    expect(f.methods).not.toContain("turn/start");
  });
});

describe("Codex indexed native execution policy", () => {
  const full = {
    approval_policy: "never",
    sandbox_policy: { type: "danger-full-access" },
  };
  const setNativePolicy = (f: ReturnType<typeof fixture>, policy: Record<string, unknown>) => {
    writeFileSync(
      f.compressedTranscript,
      zstdCompressSync(
        f.history +
          JSON.stringify({ type: "turn_context", payload: { ...policy, cwd: f.workspace } }) +
          "\n",
      ),
    );
  };
  const settings = (f: ReturnType<typeof fixture>) =>
    f.web.managedSettingsState({
      operation: "settings-state",
      sessionId: f.summary.id,
      includeHistorical: true,
    });

  it("presents and resumes the original full-access policy", async () => {
    const f = fixture(true);
    setNativePolicy(f, full);
    f.setPolicyReply({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(await settings(f)).toMatchObject({
      available: true,
      settings: {
        current: { policyId: "full-access-on-request" },
        selected: { policyId: "full-access-on-request" },
        writable: { policy: true },
      },
    });
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "thread/resume")?.params).toMatchObject({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it.each(["never", "on-request"] as const)(
    "denies a restricted device before adopting a privileged native policy (%s)",
    async (approvalPolicy) => {
      const f = fixture(true);
      const fullAccess = approvalPolicy === "never";
      setNativePolicy(
        f,
        fullAccess
          ? full
          : {
              approval_policy: approvalPolicy,
              approvals_reviewer: "agent",
              sandbox_policy: {
                type: "workspace-write",
                writable_roots: [],
                network_access: false,
                exclude_tmpdir_env_var: true,
                exclude_slash_tmp: true,
              },
            },
      );
      f.setPolicyReply(
        fullAccess
          ? { approvalPolicy, approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" } }
          : { approvalPolicy, approvalsReviewer: "auto_review" },
      );
      const live = await f.live();
      const requestId = randomUUID();
      expect(
        await f.sendWithState(live, { requestId, deviceId: "restricted-device" }, true),
      ).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "native-policy-full-access-required",
      });
      expect(f.methods).not.toContain("thread/resume");
      expect(f.methods).not.toContain("turn/start");
      expect(
        readControlReceipt(f.root, { requestId, deviceId: "restricted-device" }),
      ).toMatchObject({
        status: "not-dispatched",
      });

      expect(await f.send({ deviceId: "full-access-device" })).toMatchObject({ accepted: true });
      expect(f.methods).toContain("thread/resume");
      expect(f.methods).toContain("turn/start");

      f.servers.at(-1)!.complete();
      const resident = await f.live();
      expect(resident.status).toBe("idle");
      expect(
        await f.sendWithState(resident, { deviceId: "restricted-device" }, true),
      ).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        error: "native-policy-full-access-required",
      });
      expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
    },
  );

  it("allows a restricted device to adopt the native default workspace policy", async () => {
    const f = fixture(true);
    setNativePolicy(f, {
      approval_policy: "on-request",
      approvals_reviewer: "user",
      sandbox_policy: {
        type: "workspace-write",
        writable_roots: [],
        network_access: false,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    });
    expect(
      await f.sendWithState(await f.live(), { deviceId: "restricted-device" }, true),
    ).toMatchObject({ accepted: true });
  });

  it("keeps a differing native policy visible and refuses to run or replace it", async () => {
    const f = fixture(true);
    setNativePolicy(f, {
      approval_policy: "on-request",
      approvals_reviewer: "user",
      sandbox_policy: {
        type: "workspace-write",
        network_access: true,
        writable_roots: [],
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: true,
      },
    });
    const reason = "native-policy-sandbox-network-mismatch";
    expect(await settings(f)).toMatchObject({
      available: true,
      policies: [],
      settings: {
        current: { policyId: null },
        selected: { policyId: null },
        writable: { policy: { available: false, reason } },
      },
    });
    expect(await f.send()).toMatchObject({ controlOutcome: "not-dispatched", reason });
    const state = await f.live();
    expect(
      await f.web.managedControl({
        operation: "settings",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        policyId: "full-access-on-request",
      }),
    ).toMatchObject({ controlOutcome: "not-dispatched", reason });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
  });

  it("offers execution policy without waiting for the cold model catalog", async () => {
    const invalidated = vi.fn();
    const f = fixture(true, undefined, {}, invalidated);
    setNativePolicy(f, full);
    const models = { data: [{ model: "cold-model", isDefault: true }] };
    f.intercept((method) =>
      method === "model/list"
        ? new Promise((resolve) => setTimeout(() => resolve(models), 500))
        : undefined,
    );
    const started = performance.now();
    const early = await settings(f);
    const elapsed = performance.now() - started;
    if (process.env.AGENTKIB_MEASURE_CODEX_SETTINGS === "1")
      console.info("Cold Codex policy response (500 ms model fixture):", elapsed.toFixed(1), "ms");
    expect(elapsed).toBeLessThan(400);
    expect(early).toMatchObject({
      available: true,
      policies: expect.arrayContaining([expect.objectContaining({ id: "full-access-on-request" })]),
    });
    expect(early).toHaveProperty("settings.writable.policy", true);
    await vi.waitFor(
      () => {
        expect(invalidated).toHaveBeenCalledWith(f.summary.id, "invalidate", {
          domains: ["settings"],
        });
      },
      { timeout: 2_000 },
    );
    expect(await settings(f)).toMatchObject({ models: [{ id: "cold-model" }] });
    expect(f.methods).not.toContain("thread/resume");
  });

  it("rechecks writer ownership for the execution policy as soon as Desktop exits", async () => {
    const f = fixture(true);
    setNativePolicy(f, full);
    const writerLocks = path.join(f.home, "thread-writer-locks");
    mkdirSync(writerLocks, { recursive: true });
    const release = acquirePortableFileLease(path.join(writerLocks, nativeId + ".lock"));
    try {
      expect(await settings(f)).toMatchObject({ available: false, reason: "codex-owner-busy" });
    } finally {
      release();
    }
    expect(await settings(f)).toMatchObject({
      available: true,
      settings: { current: { policyId: "full-access-on-request" }, writable: { policy: true } },
    });
  });
});

describe("Codex Plan mode", () => {
  async function control(
    f: ReturnType<typeof fixture>,
    operation: "send" | "settings",
    fields: Record<string, unknown> = {},
  ) {
    const state = await f.live();
    return f.web.managedControl({
      operation,
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      ...(operation === "send" ? { text: "Plan this" } : {}),
      ...fields,
    });
  }
  const settingsState = (f: ReturnType<typeof fixture>) =>
    f.web.managedSettingsState({ operation: "settings-state", sessionId: f.summary.id }) as Promise<
      Record<string, any>
    >;

  it.each<[string, Record<string, unknown>]>([
    [
      "model, effort, Fast and Plan",
      { model: "model-b", effort: "high", serviceTier: "priority", mode: "plan" },
    ],
    ["effort", { effort: "high" }],
    ["Fast", { serviceTier: "priority" }],
    ["Plan", { mode: "plan" }],
    ["mode clear", { mode: null }],
  ])(
    "stages a policy with %s without claiming the native writer until send",
    async (_name, fields) => {
      const f = fixture();
      f.setModels([
        {
          model: "model-a",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
        {
          model: "model-b",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
      ]);
      f.setFailure(new Error("must not claim the native writer while saving settings"));
      const state = await f.live();
      const requestId = randomUUID();
      const change = {
        operation: "settings",
        sessionId: f.summary.id,
        requestId,
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        policyId: "full-access-on-request",
        ...fields,
      };
      const saved = await f.web.managedControl(change);
      expect(saved).toMatchObject({ accepted: true, requestId, appliesTo: "next-turn" });
      expect(await f.web.managedControl(change)).toEqual(saved);
      await expect(
        f.web.managedControl({ ...change, policyId: "workspace-write-on-request" }),
      ).rejects.toThrow("request-id-reused-with-different-input");
      expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
        status: "accepted",
        sessionId: f.summary.id,
        operation: "settings",
        ack: saved,
      });
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
        policy_id: "full-access-on-request",
        released: true,
        ...(fields.model !== undefined ? { model: fields.model } : {}),
        ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
        ...(fields.serviceTier !== undefined ? { service_tier: fields.serviceTier } : {}),
        ...(fields.mode !== undefined ? { mode: fields.mode } : {}),
        snapshot: { settingsStaged: true, revision: state.revision + 1 },
      });
      expect(commandOperations(f.root, f.summary.id)).toEqual(["settings"]);
      expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
      for (const method of ["thread/resume", "thread/start", "turn/start"])
        expect(f.methods).not.toContain(method);
      expect(f.follower).not.toHaveBeenCalled();
      await expect(
        f.web.managedControl({ ...change, policyId: "workspace-write-on-request" }),
      ).rejects.toThrow("request-id-reused-with-different-input");

      f.setFailure(undefined);
      expect(await f.send()).toMatchObject({ accepted: true });
      expect(f.requests.find(({ method }) => method === "thread/resume")?.params).toMatchObject({
        threadId: nativeId,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      });
      expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
        model: fields.model ?? "model-a",
        ...(fields.effort !== undefined ? { effort: fields.effort } : {}),
        ...(fields.serviceTier !== undefined ? { serviceTier: fields.serviceTier } : {}),
        ...(fields.mode ? { collaborationMode: { mode: fields.mode } } : {}),
      });
      expect(commandOperations(f.root, f.summary.id)).toEqual(["settings", "send"]);
    },
  );

  it("rolls back an attached Plan change when storing its accepted receipt fails", async () => {
    const f = fixture();
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    f.servers.at(-1)!.complete();
    const before = await f.live();
    expect(before).toMatchObject({ status: "idle", settings: { selected: { mode: null } } });
    const requestId = randomUUID();
    const database = openManagedLedger(f.root)!;
    try {
      database.exec(`
        CREATE TRIGGER refuse_accepted_setting BEFORE UPDATE OF result ON managed_commands
        WHEN json_extract(OLD.evidence, '$.operation') = 'settings'
          AND json_extract(NEW.result, '$.accepted') = 1
        BEGIN
          SELECT RAISE(ABORT, 'fixture receipt failure');
        END;
      `);
      expect(await control(f, "settings", { mode: "plan", requestId })).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
      });
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
        mode: null,
        snapshot: { revision: before.revision },
      });
      expect(await f.live()).toMatchObject({
        revision: before.revision,
        status: "idle",
        settings: { selected: { mode: null } },
      });
      expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
      expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
        status: "not-dispatched",
      });
    } finally {
      database.exec("DROP TRIGGER IF EXISTS refuse_accepted_setting");
      database.close();
    }
    expect(await control(f, "settings", { mode: "plan" })).toMatchObject({ accepted: true });
    expect((await settingsState(f)).settings).toMatchObject({ selected: { mode: "plan" } });
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("saves a new model, effort and policy during a turn for the next send", async () => {
    const f = fixture();
    f.setModels([
      {
        model: "model-a",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      },
      { model: "model-b", supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    ]);
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    const running = await f.live();
    expect(running.status).toBe("running");
    expect(
      await f.web.managedQuery({
        operation: "capabilities",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      }),
    ).toMatchObject({ features: { settings: { available: true } } });

    const requestId = randomUUID();
    const result = await control(f, "settings", {
      requestId,
      model: "model-b",
      effort: "high",
      policyId: "workspace-write-auto-review",
    });
    expect(result).toMatchObject({ accepted: true, appliesTo: "next-turn" });
    expect(await f.live()).toMatchObject({ status: "running", turnId: running.turnId });
    expect((await settingsState(f)).settings).toMatchObject({
      selected: { model: "model-b", effort: "high", policyId: "workspace-write-auto-review" },
    });
    expect(f.methods).not.toContain("thread/settings/update");
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);

    f.servers.at(-1)!.complete();
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.requests.filter(({ method }) => method === "turn/start").at(-1)?.params).toMatchObject(
      {
        model: "model-b",
        effort: "high",
        approvalsReviewer: "auto_review",
      },
    );
  });

  it("returns the same settings revision and Plan selection after a delayed catalog read", async () => {
    const f = fixture();
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    f.servers.at(-1)!.complete();
    expect(await f.live()).toMatchObject({ status: "idle" });
    const entered = Promise.withResolvers<void>();
    const catalog = Promise.withResolvers<unknown>();
    let delayNextCatalog = true;
    f.intercept((method) => {
      if (method !== "model/list" || !delayNextCatalog) return;
      delayNextCatalog = false;
      entered.resolve();
      return catalog.promise;
    });
    const pending = settingsState(f);
    let revision: unknown;
    try {
      await entered.promise;
      expect(await control(f, "settings", { mode: "plan" })).toMatchObject({ accepted: true });
      const live = await f.live();
      expect(live).toMatchObject({ settings: { selected: { mode: "plan" } } });
      revision = live.revision;
    } finally {
      catalog.resolve({ data: [{ model: "model-a", isDefault: true }] });
    }
    expect(await pending).toMatchObject({ revision, settings: { selected: { mode: "plan" } } });
  });

  it("clears only explicit Fast and incompatible effort selections", async () => {
    const f = fixture();
    f.setModels([
      {
        model: "model-a",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        serviceTiers: [{ id: "fast" }],
      },
      { model: "model-b", supportedReasoningEfforts: [], serviceTiers: [] },
    ]);
    expect(
      await control(f, "settings", {
        model: "model-a",
        effort: "low",
        serviceTier: "fast",
        policyId: "full-access-on-request",
        mode: "plan",
      }),
    ).toMatchObject({ accepted: true });
    expect(await control(f, "settings", { serviceTier: null })).toMatchObject({ accepted: true });
    expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
      model: "model-a",
      effort: "low",
      service_tier: null,
      policy_id: "full-access-on-request",
      mode: "plan",
    });
    expect(await control(f, "settings", { model: "model-b", effort: null })).toMatchObject({
      accepted: true,
    });
    expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
      model: "model-b",
      effort: null,
      service_tier: null,
      policy_id: "full-access-on-request",
      mode: "plan",
    });
  });

  it.each(["default", "plan"] as const)(
    "clears Fast and inherited effort on the next turn without changing native %s mode",
    async (mode) => {
      const f = fixture();
      f.setModels([
        {
          model: "model-a",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
        { model: "model-b", supportedReasoningEfforts: [], serviceTiers: [] },
      ]);
      expect(
        await control(f, "settings", {
          model: "model-a",
          effort: "low",
          serviceTier: "priority",
          ...(mode === "plan" ? { mode } : {}),
        }),
      ).toMatchObject({ accepted: true });
      expect(await control(f, "send")).toMatchObject({ accepted: true });
      expect(
        f.requests.filter((item) => item.method === "turn/start").at(-1)?.params,
      ).toMatchObject({ serviceTier: "priority", effort: "low" });
      const acknowledge = (model: string, effort: string | null, serviceTier: string) => {
        f.servers.at(-1)!.emit("notification", {
          method: "thread/settings/updated",
          params: {
            threadId: nativeId,
            threadSettings: {
              model,
              effort,
              serviceTier,
              cwd: f.workspace,
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: [f.workspace],
                networkAccess: false,
              },
              collaborationMode: {
                mode,
                settings: { model, reasoning_effort: effort, developer_instructions: null },
              },
            },
          },
        });
      };
      acknowledge("model-a", "low", "priority");
      await vi.waitFor(async () =>
        expect((await settingsState(f)).settings.applicationStatus).toBe("confirmed"),
      );
      f.servers.at(-1)!.complete();
      await vi.waitFor(async () => expect((await f.live()).status).toBe("idle"));
      expect(
        await control(f, "settings", { model: "model-b", effort: null, serviceTier: null }),
      ).toMatchObject({ accepted: true });
      expect(await control(f, "send")).toMatchObject({ accepted: true });
      expect(
        f.requests.filter((item) => item.method === "turn/start").at(-1)?.params,
      ).toMatchObject({
        model: "model-b",
        serviceTier: null,
        approvalPolicy: "on-request",
        collaborationMode: { mode, settings: { model: "model-b", reasoning_effort: null } },
      });
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
        mode: mode === "plan" ? "plan" : null,
      });
      acknowledge("model-b", null, "default");
      await vi.waitFor(async () =>
        expect((await settingsState(f)).settings).toMatchObject({
          selected: { model: "model-b", effort: null, serviceTier: null },
          current: { model: "model-b", effort: null, serviceTier: null, mode },
          applicationStatus: "confirmed",
        }),
      );
    },
  );

  it("does not save an effort clear when the native mode cannot be verified", async () => {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    f.servers.at(-1)!.complete();
    await vi.waitFor(async () => expect((await f.live()).status).toBe("idle"));
    expect(await control(f, "settings", { model: "model-a", effort: "low" })).toMatchObject({
      accepted: true,
    });
    f.servers.at(-1)!.emit("notification", {
      method: "thread/settings/updated",
      params: {
        threadId: nativeId,
        threadSettings: {
          model: "model-a",
          effort: "low",
          serviceTier: null,
          collaborationMode: null,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [f.workspace],
            networkAccess: false,
          },
        },
      },
    });
    await vi.waitFor(async () =>
      expect((await settingsState(f)).settings.current.effort).toBe("low"),
    );
    expect(await control(f, "settings", { effort: null })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    expect(readManagedRecord(f.root, f.summary.id)?.effort).toBe("low");
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("preserves pending clears across a restart instead of restoring inherited native settings", async () => {
    const f = fixture();
    expect(await control(f, "settings", { model: "model-a", effort: "low" })).toMatchObject({
      accepted: true,
    });
    await f.web.closeAsync();
    const record = readManagedRecord(f.root, f.summary.id)!;
    const collaborationMode = {
      mode: "default",
      settings: { model: "model-a", reasoning_effort: "low", developer_instructions: null },
    };
    saveManagedRecord(f.root, {
      ...record,
      effort: null,
      service_tier: null,
      native_settings: {
        ...record.native_settings,
        effort: "low",
        serviceTier: "priority",
        collaborationMode,
      },
    });
    f.setPolicyReply({ reasoningEffort: "low", serviceTier: "default", collaborationMode });
    const restarted = new WebReadRequests(f.store, f.readers, f.root, () => 0n, {
      CODEX_HOME: f.home,
      HOME: f.root,
      PATH: f.bin,
    });
    cleanups.push(() => restarted.closeAsync());
    const state = await restarted.request({
      operation: "live",
      sessionId: f.summary.id,
      experimentalEnabled: true,
    });
    expect(
      await restarted.managedControl({
        operation: "send",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        text: "Continue after clear",
      }),
    ).toMatchObject({ accepted: true });
    expect(
      f.requests.filter((item) => item.method === "thread/resume").at(-1)?.params,
    ).toMatchObject({ serviceTier: null });
    expect(f.requests.filter((item) => item.method === "turn/start").at(-1)?.params).toMatchObject({
      serviceTier: null,
      collaborationMode: { mode: "default", settings: { reasoning_effort: null } },
    });
    expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
      effort: null,
      service_tier: null,
      mode: null,
    });
  });

  it("offers the native presets, sends the turn in Plan, and confirms it from the CLI", async () => {
    const f = fixture();
    f.setModels([
      {
        model: "model-a",
        isDefault: true,
        supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        serviceTiers: [{ id: "priority", name: "Fast" }],
      },
    ]);
    // Before any runner: read with a metadata-only reader.
    const inactive = await settingsState(f);
    expect(inactive.collaborationModes).toEqual([
      { id: "plan", name: "Plan" },
      { id: "default", name: "Default" },
    ]);
    expect(inactive.settings.writable.mode).toEqual({ available: true });
    const requestId = randomUUID();
    const staged = await control(f, "settings", { mode: "plan", requestId });
    expect(staged).toMatchObject({ accepted: true, appliesTo: "next-turn", requestId });
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      status: "accepted",
      sessionId: f.summary.id,
      operation: "settings",
      ack: staged,
    });
    expect((await settingsState(f)).settings).toMatchObject({
      selected: { mode: "plan" },
      current: { mode: null },
      applicationStatus: "pending",
    });
    expect(await f.live()).toMatchObject({
      status: "idle",
      executionLocation: null,
      sendEnabled: true,
    });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("thread/start");
    expect(f.methods).not.toContain("turn/start");

    f.setPolicyReply({ reasoningEffort: "low", serviceTier: "priority" });
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      model: "model-a",
      effort: "low",
      serviceTier: "priority",
      collaborationMode: {
        mode: "plan",
        // Null asks Codex for its own Plan instructions; AgentKib never copies them.
        settings: { model: "model-a", reasoning_effort: "low", developer_instructions: null },
      },
    });
    expect((await settingsState(f)).settings).toMatchObject({
      selected: { mode: "plan" },
      current: { mode: null },
      applicationStatus: "pending",
    });
    // CLI 0.163.0 reports the applied mode before turn/started.
    f.servers.at(-1)!.emit("notification", {
      method: "thread/settings/updated",
      params: {
        threadId: nativeId,
        threadSettings: {
          model: "model-a",
          modelProvider: "openai",
          effort: "low",
          serviceTier: "priority",
          cwd: f.workspace,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [f.workspace],
            networkAccess: false,
          },
          collaborationMode: {
            mode: "plan",
            settings: { model: "model-a", reasoning_effort: "low", developer_instructions: "…" },
          },
        },
      },
    });
    await vi.waitFor(async () =>
      expect((await settingsState(f)).settings).toMatchObject({
        current: { mode: "plan" },
        applicationStatus: "confirmed",
      }),
    );
    f.servers.at(-1)!.complete();
    const active = await settingsState(f);
    expect(active.collaborationModes).toHaveLength(2);
    expect(active.settings.writable.mode).toEqual({ available: true });
    expect(await control(f, "settings", { mode: "default" })).toMatchObject({ accepted: true });
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.requests.filter(({ method }) => method === "turn/start").at(-1)?.params).toMatchObject(
      { collaborationMode: { mode: "default" } },
    );
  });

  it.each([
    ["a CLI without presets", new Error("Method not found")],
    ["a catalog without Default", { data: [{ name: "Plan", mode: "plan" }] }],
    ["an unknown mode only", { data: [{ name: "Pair", mode: "pair_programming" }] }],
  ])("keeps Plan unavailable for %s", async (_name, catalog) => {
    const f = fixture();
    f.setCollaborationModes(catalog);
    const inactive = await settingsState(f);
    expect(inactive.collaborationModes).toEqual([]);
    expect(inactive.settings.writable.mode).toEqual({
      available: false,
      reason: "native-collaboration-modes-unavailable",
    });
    // Models stay readable, and the session still starts.
    expect(inactive.models).toHaveLength(1);
    expect(await control(f, "settings", { mode: "plan" })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "native-collaboration-modes-unavailable",
    });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("thread/start");
    expect(f.methods).not.toContain("turn/start");
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).not.toHaveProperty(
      "collaborationMode",
    );
  });

  it("keeps already staged model settings when Plan is selected before the first send", async () => {
    const f = fixture();
    f.setModels([
      { model: "model-a", isDefault: true },
      {
        model: "model-b",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        serviceTiers: [{ id: "priority", name: "Fast" }],
      },
    ]);
    expect(
      await control(f, "settings", { model: "model-b", effort: "high", serviceTier: "priority" }),
    ).toMatchObject({ accepted: true, appliesTo: "next-turn" });
    expect(await control(f, "settings", { mode: "plan" })).toMatchObject({
      accepted: true,
      appliesTo: "next-turn",
    });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
    expect((await settingsState(f)).settings).toMatchObject({
      selected: { model: "model-b", effort: "high", serviceTier: "priority", mode: "plan" },
    });
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      model: "model-b",
      effort: "high",
      serviceTier: "priority",
      collaborationMode: {
        mode: "plan",
        settings: { model: "model-b", reasoning_effort: "high" },
      },
    });
  });

  it("does not send a normal turn when Codex stops offering Plan after staging", async () => {
    const f = fixture();
    expect(await control(f, "settings", { mode: "plan" })).toMatchObject({
      accepted: true,
      appliesTo: "next-turn",
    });
    f.setCollaborationModes(new Error("Method not found"));
    expect(await control(f, "send")).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: "native-collaboration-modes-unavailable",
    });
    expect(f.methods).not.toContain("turn/start");
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);

    const readsBeforeClear = f.methods.length;
    let modelUnavailable = true;
    f.intercept((method) =>
      method === "model/list" && modelUnavailable ? new Error("model list unavailable") : undefined,
    );
    const requestId = randomUUID();
    expect(await control(f, "settings", { mode: null, requestId })).toMatchObject({
      accepted: true,
      appliesTo: "next-turn",
    });
    expect(f.methods.slice(readsBeforeClear)).not.toContain("model/list");
    expect(f.methods.slice(readsBeforeClear)).not.toContain("collaborationMode/list");
    expect(f.methods).not.toContain("turn/start");
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      status: "accepted",
    });
    modelUnavailable = false;
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    const turns = f.requests.filter(({ method }) => method === "turn/start");
    expect(turns).toHaveLength(1);
    expect(turns[0]?.params).not.toHaveProperty("collaborationMode");
  });

  it("clears a staged Plan without opening a cold thread or reading catalogs", async () => {
    const f = fixture();
    expect(await control(f, "settings", { mode: "plan" })).toMatchObject({ accepted: true });
    f.setCollaborationModes(new Error("Unknown method"));
    let modelUnavailable = true;
    f.intercept((method) =>
      method === "model/list" && modelUnavailable ? new Error("model list unavailable") : undefined,
    );
    const readsBeforeClear = f.methods.length;
    expect(await control(f, "settings", { mode: null })).toMatchObject({
      accepted: true,
      appliesTo: "next-turn",
    });
    expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({ mode: null });
    expect(f.methods.slice(readsBeforeClear)).not.toContain("model/list");
    expect(f.methods.slice(readsBeforeClear)).not.toContain("collaborationMode/list");
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
    modelUnavailable = false;
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).not.toHaveProperty(
      "collaborationMode",
    );
  });

  it("cannot stage Plan while another writer owns the native thread", async () => {
    const f = fixture();
    const lockDirectory = path.join(f.home, "thread-writer-locks");
    mkdirSync(lockDirectory, { recursive: true });
    cleanups.push(acquirePortableFileLease(path.join(lockDirectory, `${nativeId}.lock`)));
    const requestId = randomUUID();
    expect(await control(f, "settings", { mode: "plan", requestId })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    });
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      status: "not-dispatched",
    });
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
  });
});

describe("Codex fork model recovery", () => {
  const catalog = [
    { model: "model-a", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    {
      model: "source-model",
      isDefault: false,
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
    },
  ];
  async function forkResult(f: ReturnType<typeof fixture>) {
    const state = await f.live();
    return f.web.managedControl({
      operation: "fork",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
    });
  }
  async function fork(f: ReturnType<typeof fixture>) {
    const result = await forkResult(f);
    expect(result.accepted).toBe(true);
    return result.sessionId as string;
  }
  async function action(
    f: ReturnType<typeof fixture>,
    id: string,
    operation: "send" | "settings",
    fields: Record<string, unknown> = {},
  ) {
    const state = await f.web.request({
      operation: "live",
      sessionId: id,
      experimentalEnabled: true,
    });
    return f.web.managedControl({
      operation,
      sessionId: id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      ...(operation === "send" ? { text: "One continued message" } : {}),
      ...fields,
    });
  }

  it("inherits the verified source model and effort instead of the CLI configuration default", async () => {
    const f = fixture();
    f.setModels(catalog);
    f.setSourceSettings("source-model", "low");
    f.setConfiguredModel("configuration-only-model");
    const id = await fork(f);
    expect(f.requests.find(({ method }) => method === "thread/fork")?.params).toMatchObject({
      model: "source-model",
      config: { model_reasoning_effort: "low" },
    });
    expect(readManagedRecord(f.root, id)).toMatchObject({ model: "source-model", effort: "low" });
    expect(await action(f, id, "send")).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      model: "source-model",
      effort: "low",
    });
  });

  it.each([false, true])(
    "keeps an unlisted source fork recoverable through explicit next-turn settings after release=%s",
    async (release) => {
      const f = fixture();
      f.setModels(catalog);
      f.setSourceSettings("unlisted-source-model", "low");
      const id = await fork(f);
      expect(readManagedRecord(f.root, id)).toMatchObject({
        model: "unlisted-source-model",
        effort: "low",
      });
      if (release)
        await f.web.managedLifecycle({
          operation: "release",
          sessionId: id,
          requestId: randomUUID(),
          deviceId: "fixture",
        });
      const requestId = randomUUID();
      expect(await action(f, id, "send", { requestId })).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        error: "unsupported-model",
      });
      expect(f.methods).not.toContain("turn/start");
      expect(readUnknownManagedCommands(f.root, id)).toEqual([]);
      expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
        found: true,
        status: "not-dispatched",
        operation: "send",
        ack: { error: "unsupported-model" },
      });
      expect(await action(f, id, "settings", { model: "model-a", effort: "low" })).toMatchObject({
        accepted: true,
      });
      expect(await action(f, id, "send")).toMatchObject({ accepted: true });
      expect(f.requests.filter(({ method }) => method === "turn/start")).toEqual([
        expect.objectContaining({
          params: expect.objectContaining({ model: "model-a", effort: "low" }),
        }),
      ]);
    },
  );

  it.each([
    [{ model: "invented-model" }, "unsupported-model"],
    [{ model: "model-a", effort: "invented-effort" }, "unsupported-effort"],
  ] as const)("continues to validate explicit user settings %s", async (settings, error) => {
    const f = fixture();
    f.setModels(catalog);
    const id = await fork(f);
    const before = readManagedRecord(f.root, id);
    expect(await action(f, id, "settings", settings)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error,
    });
    expect(readManagedRecord(f.root, id)?.model).toBe(before?.model);
    expect(f.methods).not.toContain("turn/start");
  });

  it("does not create a branch with the configuration default when the source model is unavailable", async () => {
    const f = fixture();
    f.setSourceSettings(null, null);
    const rejection = await forkResult(f);
    expect(rejection).toMatchObject({
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: "native-model-unconfirmed",
      sessionId: f.summary.id,
      requestId: expect.any(String),
      runtimeBootId: expect.any(String),
    });
    expect(
      readControlReceipt(f.root, { requestId: rejection.requestId, deviceId: "fixture" }),
    ).toMatchObject({
      status: "not-dispatched",
      operation: "fork",
      ack: { reason: "native-model-unconfirmed" },
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(f.methods).not.toContain("thread/fork");
  });

  it("does not inherit configuration effort when the native source effort is unconfirmed", async () => {
    const f = fixture();
    f.setSourceSettings("model-a", null);
    const rejection = await forkResult(f);
    expect(rejection).toMatchObject({
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: "native-effort-unconfirmed",
      sessionId: f.summary.id,
      requestId: expect.any(String),
      runtimeBootId: expect.any(String),
    });
    expect(
      readControlReceipt(f.root, { requestId: rejection.requestId, deviceId: "fixture" }),
    ).toMatchObject({
      status: "not-dispatched",
      operation: "fork",
      ack: { reason: "native-effort-unconfirmed" },
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(f.methods).not.toContain("thread/fork");
    expect(f.methods).not.toContain("turn/start");
  });

  it("uses the source ledger's confirmed model selection when the native effort is unavailable", async () => {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    f.servers[0]!.complete();
    expect(
      await action(f, f.summary.id, "settings", { model: "model-a", effort: "low" }),
    ).toMatchObject({ accepted: true });
    f.setSourceSettings("model-a", null);
    const id = await fork(f);
    expect(f.requests.find(({ method }) => method === "thread/fork")?.params).toMatchObject({
      model: "model-a",
      config: { model_reasoning_effort: "low" },
    });
    expect(readManagedRecord(f.root, id)).toMatchObject({ model: "model-a", effort: "low" });
  });

  it("uses matching effective native settings when neither the current read nor selected effort is available", async () => {
    const f = fixture();
    expect(await f.send()).toMatchObject({ accepted: true });
    f.servers[0]!.complete();
    await f.web.managedLifecycle({
      operation: "release",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
    });
    const source = readManagedRecord(f.root, f.summary.id)!;
    const native = source.native_settings as Record<string, unknown>;
    saveManagedRecord(f.root, {
      ...source,
      effort: null,
      native_settings: { ...native, model: "model-a", effort: "low" },
    });
    f.setSourceSettings("model-a", null);
    const id = await fork(f);
    expect(readManagedRecord(f.root, id)).toMatchObject({ model: "model-a", effort: "low" });
  });

  it("does not apply ledger effort from a different model to an unconfirmed native source", async () => {
    const f = fixture();
    f.setModels(catalog);
    expect(await f.send()).toMatchObject({ accepted: true });
    f.servers[0]!.complete();
    expect(
      await action(f, f.summary.id, "settings", { model: "model-a", effort: "low" }),
    ).toMatchObject({ accepted: true });
    f.setSourceSettings("source-model", null);
    expect(await forkResult(f)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "native-effort-unconfirmed",
    });
    expect(f.methods).not.toContain("thread/fork");
  });

  it("rejects an explicitly chosen unavailable model before creating a native thread", async () => {
    const f = fixture();
    expect(
      await f.web.managedLifecycle({
        operation: "create",
        requestId: randomUUID(),
        deviceId: "fixture",
        workspaceId: "workspace",
        policyId: "workspace-write-on-request",
        model: "invented-model",
      }),
    ).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "unsupported-model",
    });
    expect(f.methods).not.toContain("thread/start");
    expect(f.methods).not.toContain("turn/start");
  });

  it("keeps a dispatched turn uncertain and blocks model changes without resending", async () => {
    const f = fixture();
    const id = await fork(f);
    f.setTurnFailure(new Error("Codex app-server request timed out"));
    const requestId = randomUUID();
    expect(await action(f, id, "send", { requestId })).toMatchObject({
      accepted: false,
      controlOutcome: "unknown",
      reason: "control-outcome-unconfirmed",
    });
    expect(readUnknownManagedCommands(f.root, id)).toHaveLength(1);
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      status: "unknown",
    });
    await expect(action(f, id, "settings", { model: "model-a" })).rejects.toThrow(
      "control-outcome-unconfirmed",
    );
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });
});

describe("Codex managed sandbox verification", () => {
  const policies = [
    ["workspace-write-on-request", "on-request", "user", "workspaceWrite"],
    ["workspace-write-auto-review", "on-request", "auto_review", "workspaceWrite"],
    ["full-access-on-request", "never", "user", "dangerFullAccess"],
  ] as const;
  const create = (f: ReturnType<typeof fixture>, policyId: (typeof policies)[number][0]) =>
    f.web.managedLifecycle({
      operation: "create",
      requestId: randomUUID(),
      deviceId: "fixture",
      workspaceId: "workspace",
      policyId,
      model: "model-a",
    });

  it("creates an empty Codex session through the provider and replays legacy receipts", async () => {
    const f = fixture();
    await expect(f.web.sessionProviderOptions("constructor")).rejects.toThrow(
      "unsupported-session-provider",
    );
    const options = await f.web.sessionProviderOptions("codex");
    expect(options).toMatchObject({
      available: true,
      models: expect.arrayContaining([expect.objectContaining({ id: "model-a" })]),
      provider: {
        create: { mode: "empty", attachments: true },
        models: { selection: "independent" },
        contextUsage: "live",
      },
    });
    const input = {
      requestId: randomUUID(),
      deviceId: "fixture",
      workspaceId: "workspace",
      policyId: "workspace-write-on-request",
      model: "model-a",
    };
    await expect(
      f.web.sessionProviderCreate("codex", { ...input, prompt: "No" }),
    ).rejects.toThrow();
    expect(f.methods).not.toContain("thread/start");
    const created = await f.web.sessionProviderCreate("codex", input);
    expect(created).toMatchObject({ accepted: true });
    expect(await f.web.managedLifecycle({ ...input, operation: "create" })).toEqual(created);
    expect(f.methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(f.methods).not.toContain("turn/start");
    expect(
      await f.web.sessionProviderSettingsState({
        operation: "settings-state",
        sessionId: created.sessionId,
      }),
    ).toMatchObject({ available: true, provider: options.provider });
  });

  it("applies Codex Fast chosen at creation to the first turn", async () => {
    const f = fixture();
    const fast = { id: "priority", name: "Fast" };
    f.setModels([{ model: "model-a", displayName: "Model A", serviceTiers: [fast] }]);
    expect(await f.web.sessionProviderOptions("codex")).toMatchObject({
      models: [{ id: "model-a", serviceTierIds: [fast.id] }],
      serviceTiers: [fast],
      provider: { create: { serviceTiers: true } },
    });
    f.setPolicyReply({ serviceTier: fast.id });
    const created = await f.web.sessionProviderCreate("codex", {
      requestId: randomUUID(),
      deviceId: "fixture",
      workspaceId: "workspace",
      policyId: "workspace-write-on-request",
      model: "model-a",
      serviceTier: fast.id,
    });
    expect(created).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "thread/start")?.params).toMatchObject({
      serviceTier: fast.id,
    });
    const live = (await f.web.request({
      operation: "live",
      sessionId: created.sessionId,
      experimentalEnabled: true,
    })) as Record<string, unknown>;
    expect(
      await f.web.managedControl({
        operation: "send",
        sessionId: created.sessionId,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "The first task",
      }),
    ).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      serviceTier: fast.id,
    });
  });

  it("uses Codex Plan chosen at creation on its first turn without a separate settings receipt", async () => {
    const f = fixture();
    expect(await f.web.sessionProviderOptions("codex")).toMatchObject({
      provider: { create: { planMode: "mode", workspaceResources: true, goal: true } },
    });
    expect(f.methods).not.toContain("thread/start");
    // The live runner must recheck the presets, even when they were available on the home screen.
    f.setCollaborationModes({ data: [] });
    const create = {
      deviceId: "fixture",
      workspaceId: "workspace",
      policyId: "workspace-write-on-request",
      mode: "plan",
    };
    expect(
      await f.web.sessionProviderCreate("codex", { ...create, requestId: randomUUID() }),
    ).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "native-collaboration-modes-unavailable",
    });
    expect(f.methods).not.toContain("thread/start");

    f.setCollaborationModes({
      data: [
        { mode: "plan", name: "Plan" },
        { mode: "default", name: "Default" },
      ],
    });
    const created = await f.web.sessionProviderCreate("codex", {
      ...create,
      requestId: randomUUID(),
    });
    expect(created).toMatchObject({
      accepted: true,
      live: { settings: { selected: { mode: "plan" } } },
    });
    expect(f.methods).not.toContain("turn/start");
    const live = (await f.web.request({
      operation: "live",
      sessionId: created.sessionId,
      experimentalEnabled: true,
    })) as Record<string, unknown>;
    expect(
      await f.web.managedControl({
        operation: "send",
        sessionId: created.sessionId,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "Plan the first task",
      }),
    ).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      collaborationMode: { mode: "plan", settings: { model: "model-a" } },
    });
  });

  // The runner of a session it creates holds a record without the native ID until it is saved.
  it("tells a lead when a session it just created ends its first turn", async () => {
    const f = fixture();
    const ended: unknown[] = [];
    f.web.observeLanes({ turnEnded: (...args) => ended.push(args), waiting: () => {} });
    const result = await create(f, "workspace-write-on-request");
    expect(result).toMatchObject({ accepted: true });
    const live = (await f.web.request({
      operation: "live",
      sessionId: result.sessionId,
      experimentalEnabled: true,
    })) as Record<string, unknown>;
    expect(
      await f.web.managedControl({
        operation: "send",
        sessionId: result.sessionId,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "The first task",
      }),
    ).toMatchObject({ accepted: true });
    f.servers.at(-1)!.complete({ durationMs: 5_000 });
    await vi.waitFor(() =>
      expect(ended).toEqual([[result.sessionId, "new-turn", "completed", 5_000]]),
    );
  });

  it.each(policies)("confirms the native %s policy", async (policyId, approval, reviewer, type) => {
    const f = fixture();
    const result = await create(f, policyId);
    expect(result).toMatchObject({ accepted: true });
    expect(readManagedRecord(f.root, result.sessionId!)?.native_settings).toMatchObject({
      approvalPolicy: approval,
      approvalsReviewer: reviewer,
      sandboxPolicy: { type },
    });
    expect(f.methods).not.toContain("turn/start");
  });

  it.each(
    policies.flatMap(
      (policy) =>
        [
          [policy[0], "approvalPolicy", policy[1] === "never" ? "on-request" : "never"],
          [policy[0], "approvalsReviewer", policy[2] === "user" ? "auto_review" : "user"],
          [
            policy[0],
            "sandbox",
            { type: policy[3] === "workspaceWrite" ? "dangerFullAccess" : "workspaceWrite" },
          ],
        ] as const,
    ),
  )("rejects a changed %s %s after native dispatch", async (policyId, field, value) => {
    const f = fixture();
    f.setPolicyReply({ [field]: value });
    expect(await create(f, policyId)).toMatchObject({ accepted: false, controlOutcome: "unknown" });
    expect(f.methods).not.toContain("turn/start");
  });

  it.each(["implicit", "explicit", "duplicate", "canonical-alias"] as const)(
    "accepts only the verified cwd with %s native extra roots",
    async (kind) => {
      const f = fixture();
      const roots =
        kind === "implicit"
          ? []
          : kind === "duplicate"
            ? [f.workspace, f.workspace]
            : [kind === "canonical-alias" ? `${f.workspace}${path.sep}.` : f.workspace];
      f.setSandboxRoots(roots);
      expect(await f.send()).toMatchObject({ accepted: true });
      expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
        cwd: f.workspace,
        sandboxPolicy: { writableRoots: [f.workspace], networkAccess: false },
      });
    },
  );

  it.each([
    "root",
    "home",
    "outside",
    "descendant",
    "missing",
    "relative",
    "non-string",
    "absent",
    "null",
    "not-array",
  ] as const)("rejects unsafe or unconfirmed native extra roots: %s", async (kind) => {
    const f = fixture();
    const child = path.join(f.workspace, "child");
    mkdirSync(child);
    const roots: unknown =
      kind === "root"
        ? [path.parse(f.root).root]
        : kind === "home"
          ? [homedir()]
          : kind === "outside"
            ? [f.home]
            : kind === "descendant"
              ? [child]
              : kind === "missing"
                ? [path.join(f.workspace, "missing")]
                : kind === "relative"
                  ? ["."]
                  : kind === "non-string"
                    ? [null]
                    : kind === "absent"
                      ? undefined
                      : kind === "null"
                        ? null
                        : f.workspace;
    f.setSandboxRoots(roots);
    const rejected = await f.send();
    expect(rejected).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
    expect(f.methods).not.toContain("turn/start");
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(0);
    expect(
      readControlReceipt(f.root, { requestId: rejected.requestId, deviceId: "fixture" }),
    ).toMatchObject({ status: "not-dispatched" });
  });

  it.each(["workspace-write-on-request", "workspace-write-auto-review"] as const)(
    "rejects network access for %s even with implicit cwd roots",
    async (policyId) => {
      const f = fixture();
      f.setPolicyReply({
        sandbox: {
          type: "workspaceWrite",
          writableRoots: [],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      expect(await create(f, policyId)).toMatchObject({
        accepted: false,
        controlOutcome: "unknown",
      });
      expect(f.methods).not.toContain("turn/start");
    },
  );

  it.each(
    (["workspace-write-on-request", "workspace-write-auto-review"] as const).flatMap((policyId) =>
      (["excludeTmpdirEnvVar", "excludeSlashTmp"] as const).flatMap((field) =>
        [false, undefined, null, "true", 1].map((value) => [policyId, field, value] as const),
      ),
    ),
  )("rejects %s when native %s is %s", async (policyId, field, value) => {
    const f = fixture();
    f.setPolicyReply({
      sandbox: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: true,
        excludeSlashTmp: true,
        [field]: value,
      },
    });
    const result = await create(f, policyId);
    expect(result).toMatchObject({ accepted: false, controlOutcome: "unknown" });
    expect(f.methods).not.toContain("turn/start");
    expect(readUnknownManagedCommands(f.root, result.sessionId!)).toHaveLength(1);
  });

  it.each(
    (["workspace-write-on-request", "workspace-write-auto-review"] as const).flatMap((policyId) =>
      (["root", "home"] as const).map((tmpdir) => [policyId, tmpdir] as const),
    ),
  )("keeps %s inside cwd when its child environment TMPDIR is %s", async (policyId, kind) => {
    const runtimeTmpdir = kind === "root" ? path.parse(process.cwd()).root : homedir();
    const f = fixture(false, undefined, { TMPDIR: runtimeTmpdir });
    const result = await create(f, policyId);
    expect(result).toMatchObject({ accepted: true });
    const live = await f.web.request({
      operation: "live",
      sessionId: result.sessionId!,
      experimentalEnabled: true,
    });
    expect(
      await f.web.managedControl({
        operation: "send",
        sessionId: result.sessionId!,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "Continue only in cwd",
      }),
    ).toMatchObject({ accepted: true });
    expect(f.start.mock.calls[0]?.[3]?.TMPDIR).toBe(runtimeTmpdir);
    for (const request of f.requests.filter(({ method }) =>
      ["thread/start", "turn/start"].includes(method),
    ))
      expect(request.params).toMatchObject({
        cwd: f.workspace,
        config: {
          "sandbox_workspace_write.writable_roots": [],
          "sandbox_workspace_write.exclude_tmpdir_env_var": true,
          "sandbox_workspace_write.exclude_slash_tmp": true,
        },
        sandboxPolicy: {
          writableRoots: [f.workspace],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
  });
});

describe("Codex automatic CLI continuation", () => {
  function notifyDuringSend(
    f: ReturnType<typeof fixture>,
    notification: (server: EventEmitter, sessionId: string) => void,
  ) {
    const start = f.start.getMockImplementation()!;
    f.start.mockImplementation(async (...args) => {
      const server = await start(...args);
      const request = server.request.bind(server);
      let attached = false;
      vi.spyOn(server, "request").mockImplementation(async (method, params, dispatch) => {
        if (method === "model/list" && attached) {
          attached = false;
          notification(server, f.summary.id);
        }
        const result = await request(method, params, dispatch);
        if (["thread/start", "thread/resume"].includes(method)) attached = true;
        return result;
      });
      return server;
    });
  }

  it.each(["thread-started", "usage", "same-settings", "restored-usage-and-empty-goal"] as const)(
    "sends a legacy root registration on the first attempt after a late %s observation",
    async (notification) => {
      const f = fixture(false, path.parse(process.cwd()).root);
      const cwd = path.join(f.root, "legacy-project");
      mkdirSync(cwd);
      f.setCwd(cwd);
      saveManagedRecord(f.root, {
        id: f.summary.id,
        workspace_id: "workspace",
        workspace: f.workspace,
        home: f.home,
        native_id: nativeId,
        title: "Legacy adoption",
        created_at: "2026-10-19T00:00:00Z",
        adopted: true,
        released: true,
        archived: false,
        model: "model-a",
        effort: "low",
        policy_id: "workspace-write-on-request",
        snapshot: { revision: 15 },
      });
      notifyDuringSend(f, (server, id) => {
        server.emit("notification", {
          method:
            notification === "thread-started"
              ? "thread/started"
              : notification === "usage" || notification === "restored-usage-and-empty-goal"
                ? "thread/tokenUsage/updated"
                : "thread/settings/updated",
          params:
            notification === "thread-started"
              ? { thread: { id: nativeId } }
              : notification === "usage" || notification === "restored-usage-and-empty-goal"
                ? { threadId: nativeId, tokenUsage: { total: { totalTokens: 10 } } }
                : {
                    threadId: nativeId,
                    threadSettings: readManagedRecord(f.root, id)!.native_settings,
                  },
        });
        if (notification === "restored-usage-and-empty-goal")
          server.emit("notification", {
            method: "thread/goal/cleared",
            params: { threadId: nativeId },
          });
      });
      const requestId = randomUUID();
      const result = await f.send({ requestId });
      expect(result.error ?? result.reason).toBeUndefined();
      expect(result).toMatchObject({ accepted: true });
      expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
      expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
        workspace: f.workspace,
        cwd,
      });
      expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
        status: "accepted",
      });
    },
  );

  it.each([
    "model",
    "cwd",
    "sandbox",
    "effort",
    "mode",
    "turn",
    "goal",
    "transient-turn",
    "transient-goal",
    "transient-model",
  ] as const)(
    "still rejects a first send when native %s changes after automatic resume",
    async (changed) => {
      const f = fixture();
      notifyDuringSend(f, (server, id) => {
        const current = readManagedRecord(f.root, id)!;
        const kind = changed.startsWith("transient-")
          ? changed.slice("transient-".length)
          : changed;
        server.emit("notification", {
          method:
            kind === "turn"
              ? "turn/started"
              : kind === "goal"
                ? "thread/goal/updated"
                : "thread/settings/updated",
          params: {
            threadId: nativeId,
            ...(!["turn", "goal"].includes(kind)
              ? {
                  threadSettings: {
                    ...(current.native_settings as Record<string, unknown>),
                    ...(kind === "model"
                      ? { model: "other-model" }
                      : kind === "cwd"
                        ? { cwd: f.home }
                        : kind === "sandbox"
                          ? { sandboxPolicy: { type: "dangerFullAccess" } }
                          : kind === "effort"
                            ? { effort: "high" }
                            : { collaborationMode: { mode: "plan" } }),
                  },
                }
              : kind === "turn"
                ? { turn: { id: "external-turn", status: "inProgress" } }
                : { goal: { objective: "Changed goal", status: "active" } }),
          },
        });
        if (changed.startsWith("transient-"))
          server.emit("notification", {
            method:
              kind === "turn"
                ? "turn/completed"
                : kind === "goal"
                  ? "thread/goal/cleared"
                  : "thread/settings/updated",
            params: {
              threadId: nativeId,
              ...(kind === "turn"
                ? { turn: { id: "external-turn", status: "completed" } }
                : kind === "model"
                  ? { threadSettings: current.native_settings }
                  : {}),
            },
          });
      });
      expect(await f.send()).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        error: "stale-or-disabled-control",
      });
      expect(f.methods).not.toContain("turn/start");
    },
  );

  it("sends a newly created session once when its thread-started notification arrives late", async () => {
    const f = fixture();
    notifyDuringSend(f, (server) => {
      server.emit("notification", {
        method: "thread/started",
        params: { thread: { id: nativeId } },
      });
    });
    const created = await f.web.managedLifecycle({
      operation: "create",
      workspaceId: "workspace",
      requestId: randomUUID(),
      deviceId: "fixture",
      policyId: "workspace-write-on-request",
      model: "model-a",
      effort: "low",
    });
    const state = await f.web.request({ operation: "live", sessionId: created.sessionId! });
    expect(
      await f.web.managedControl({
        operation: "send",
        sessionId: created.sessionId!,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        text: "The first message",
      }),
    ).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "thread/start")).toHaveLength(1);
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("keeps a simultaneous context reader separate from the single writer used by first send", async () => {
    const f = fixture();
    const state = await f.live();
    const start = f.start.getMockImplementation()!;
    let entered!: () => void;
    let finish!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.start.mockImplementationOnce(async (...args) => {
      const server = await start(...args);
      const request = server.request.bind(server);
      vi.spyOn(server, "request").mockImplementation(async (method, ...rest) => {
        if (method === "thread/read") {
          entered();
          await gate;
        }
        return request(method, ...rest);
      });
      return server;
    });
    const context = f.web.request({ operation: "context", sessionId: f.summary.id });
    await reading;
    expect(await f.sendWithState(state)).toMatchObject({ accepted: true });
    expect(f.start).toHaveBeenCalledTimes(2);
    expect(f.servers.every((server) => server.connected)).toBe(true);
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
    finish();
    expect(await context).toMatchObject({ available: true });
    expect(f.servers[0]!.closed).toBe(true);
    expect(f.servers[1]!.connected).toBe(true);
    expect(f.follower).not.toHaveBeenCalled();
  });

  it.each([path.parse(process.cwd()).root, "home"])(
    "uses the session subdirectory when the registered workspace is %s, including after retirement",
    async (registered) => {
      vi.useFakeTimers();
      const f = fixture(false, registered);
      const cwd = path.join(f.root, "session-project");
      mkdirSync(cwd);
      f.setCwd(cwd);
      expect(await f.send()).toMatchObject({ accepted: true });
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
        workspace: f.workspace,
        cwd,
      });
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await f.send()).toMatchObject({ accepted: true });
      for (const request of f.requests.filter(({ method }) =>
        ["thread/resume", "turn/start"].includes(method),
      ))
        expect(request.params).toMatchObject({ cwd, sandboxPolicy: { writableRoots: [cwd] } });
      expect(f.start.mock.calls.every((call) => call[1] === cwd)).toBe(true);
    },
  );

  it.each(["root", "home", "real-home", "missing", "file", "outside", "relative", "symlink"])(
    "keeps an unsafe session directory view only without starting Codex: %s",
    async (kind) => {
      const f = fixture();
      let cwd = f.workspace;
      let reason = "codex-session-directory-unsafe";
      if (kind === "root") cwd = path.parse(f.root).root;
      if (kind === "home") cwd = f.root;
      if (kind === "real-home") cwd = homedir();
      if (kind === "missing") {
        cwd = path.join(f.workspace, "removed");
        reason = "codex-session-directory-missing";
      }
      if (kind === "file") {
        cwd = path.join(f.workspace, "file");
        writeFileSync(cwd, "file");
        reason = "codex-session-directory-not-directory";
      }
      if (kind === "outside") {
        cwd = f.home;
        reason = "codex-context-outside-workspace";
      }
      if (kind === "relative") {
        cwd = "project";
        reason = "codex-session-directory-unverified";
      }
      if (kind === "symlink") {
        cwd = path.join(f.workspace, "linked");
        symlinkSync(f.home, cwd);
        reason = "codex-context-outside-workspace";
      }
      f.setCwd(cwd);
      expect(await f.live()).toMatchObject({ status: "unsupported", sendEnabled: false, reason });
      expect(await f.send()).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason,
      });
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it("forks with the source session directory and keeps the registered authorization root", async () => {
    const f = fixture(false, path.parse(process.cwd()).root);
    const cwd = path.join(f.root, "source-project");
    mkdirSync(cwd);
    f.setCwd(cwd);
    f.setReadCwd(f.workspace);
    const state = await f.live();
    const result = await f.web.managedControl({
      operation: "fork",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
    });
    expect(result).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "thread/fork")?.params).toMatchObject({
      cwd,
      sandboxPolicy: { writableRoots: [cwd] },
    });
    expect(readManagedRecord(f.root, result.sessionId!)).toMatchObject({
      workspace: f.workspace,
      cwd,
    });
  });

  it.each(["sandbox", "top", "thread"] as const)(
    "rejects a %s reply that widens the session directory to the registered root",
    async (field) => {
      const f = fixture();
      const cwd = path.join(f.workspace, "session-project");
      mkdirSync(cwd);
      f.setCwd(cwd);
      if (field === "sandbox") f.widenSandbox();
      else f.mismatchReply(field);
      expect(await f.send()).toMatchObject({ accepted: false });
      expect(f.methods).not.toContain("turn/start");
    },
  );

  it("uses the verified rollout directory when an earlier resume broadened SQLite cwd", async () => {
    const f = fixture(true, path.parse(process.cwd()).root);
    const cwd = path.join(f.root, "original-project");
    mkdirSync(cwd);
    const rows = f.history
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    rows[0].payload.cwd = cwd;
    writeFileSync(
      f.compressedTranscript,
      zstdCompressSync(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    );
    f.setCwd(cwd);
    expect(f.readers.verifiedCodexResumeIdentity(nativeId)).toBeUndefined();
    expect(f.readers.verifiedCodexControlDirectory(nativeId)).toEqual({ id: nativeId, cwd });
    saveManagedRecord(f.root, {
      id: f.summary.id,
      workspace_id: "workspace",
      workspace: f.workspace,
      home: f.home,
      native_id: nativeId,
      title: "Legacy adoption",
      created_at: "2026-10-19T00:00:00Z",
      adopted: true,
      released: true,
      archived: false,
      policy_id: "workspace-write-on-request",
      snapshot: { revision: 0 },
    });
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "thread/resume")?.params).toMatchObject({
      cwd,
      sandboxPolicy: { writableRoots: [cwd] },
    });
  });

  it.each([true, false])(
    "revalidates a legacy adopted ledger without cwd after restart (native proof: %s)",
    async (proof) => {
      const f = fixture(false, path.parse(process.cwd()).root);
      const cwd = path.join(f.root, "legacy-project");
      mkdirSync(cwd);
      f.setCwd(cwd);
      expect(await f.send()).toMatchObject({ accepted: true });
      f.servers[0]!.complete();
      await f.live();
      await f.web.closeAsync();
      const legacy = readManagedRecord(f.root, f.summary.id)!;
      delete legacy.cwd;
      legacy.released = true;
      saveManagedRecord(f.root, legacy);
      if (!proof) vi.spyOn(f.readers, "verifiedCodexControlDirectory").mockReturnValue(undefined);
      const restarted = new WebReadRequests(f.store, f.readers, f.root, () => 0n, {
        CODEX_HOME: f.home,
        HOME: f.root,
        PATH: f.bin,
      });
      cleanups.push(() => restarted.closeAsync());
      const live = await restarted.request({
        operation: "live",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      });
      expect(live).toMatchObject({
        sendEnabled: proof,
        reason: proof ? null : "codex-session-directory-unverified",
      });
      const result = await restarted.managedControl({
        operation: "send",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "Continue after restart",
      });
      expect(result).toMatchObject({ accepted: proof });
      if (proof)
        expect(
          f.requests.filter(({ method }) => method === "thread/resume").at(-1)?.params,
        ).toMatchObject({ cwd, sandboxPolicy: { writableRoots: [cwd] } });
      else expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    },
  );

  it.each(["root", "home"])(
    "projects an unsafe %s native collection view only without granting collection controls",
    async (kind) => {
      const f = fixture(true, kind === "root" ? path.parse(process.cwd()).root : "home");
      f.summary.workspace_id = "session-collection:codex:unclassified";
      f.store.sessions.sync(
        f.summary.workspace_id,
        "codex",
        new CodexSessions({ CODEX_HOME: f.home, HOME: f.root })
          .list(null)
          .sessions.map((source) => source.session),
      );
      expect(await f.live()).toMatchObject({
        status: "unsupported",
        sendEnabled: false,
        reason: "codex-session-directory-unsafe",
      });
      await expect(f.send()).rejects.toThrow("Workspace does not exist");
      expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
      expect(f.start).not.toHaveBeenCalled();
    },
  );

  it("does not replace an unverified native identity with an unsafe-directory projection", async () => {
    const f = fixture(true, path.parse(process.cwd()).root);
    f.summary.workspace_id = "session-collection:codex:unclassified";
    f.store.sessions.sync(
      f.summary.workspace_id,
      "codex",
      new CodexSessions({ CODEX_HOME: f.home, HOME: f.root })
        .list(null)
        .sessions.map((source) => source.session),
    );
    writeFileSync(f.compressedTranscript, zstdCompressSync(f.history.replace(nativeId, forkId)));
    await expect(f.live()).rejects.toThrow("unverified-session-identity");
    expect(f.start).not.toHaveBeenCalled();
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
  });

  it("reads a compressed native history and continues automatically through the CLI", async () => {
    const f = fixture(true);
    expect((await f.readers.resolve(f.summary.id)).transcript).toBe(f.compressedTranscript);
    expect(await f.readers.events({ sessionId: f.summary.id, limit: 20 })).toMatchObject({
      events: expect.arrayContaining([expect.objectContaining({ content: "Earlier answer" })]),
    });
    const live = await f.live();
    expect(live).toMatchObject({ sendEnabled: true, executionLocation: null });
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.sendWithState(live)).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(f.start.mock.calls[0]?.[2]).toBe(f.home);
    expect(f.follower).not.toHaveBeenCalled();
  });

  it("resumes with one turn and pages older native history while the runner is connected", async () => {
    const f = fixture(true);
    f.setServerUserAgent("agentkib/0.167.0 (Mac OS 26.0.0; arm64) fixture");
    f.setPolicyReply({
      thread: { id: nativeId, cwd: f.workspace, status: { type: "idle" }, turns: [] },
      initialTurnsPage: {
        data: [{ id: "finished-turn", status: "completed", items: [] }],
        nextCursor: "older-turns",
      },
    });

    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.requests.filter(({ method }) => method === "thread/resume")).toMatchObject([
      {
        params: {
          threadId: nativeId,
          excludeTurns: true,
          initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
        },
      },
    ]);
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(f.servers[0]?.connected).toBe(true);

    const request = { operation: "events", sessionId: f.summary.id, limit: 1 };
    const page = await f.web.request(request);
    expect(page.events).toEqual([expect.objectContaining({ content: "Earlier answer" })]);
    expect(page.next_cursor).toMatch(/^codex-native-v1:/);
    expect(await f.web.request({ ...request, cursor: page.next_cursor })).toMatchObject({
      events: [expect.objectContaining({ content: "Earlier user input" })],
    });
    expect(f.requests).not.toContainEqual(
      expect.objectContaining({
        method: "thread/read",
        params: expect.objectContaining({ includeTurns: true }),
      }),
    );
  });

  it("keeps an active turn from the resume page and does not start another turn", async () => {
    const f = fixture(true);
    f.setServerUserAgent("agentkib/0.167.0 (Mac OS 26.0.0; arm64) fixture");
    f.setPolicyReply({
      thread: { id: nativeId, cwd: f.workspace, status: { type: "active" }, turns: [] },
      initialTurnsPage: {
        data: [{ id: "existing-turn", status: "inProgress", items: [] }],
        nextCursor: "older-turns",
      },
    });

    expect(await f.send()).toMatchObject({
      accepted: false,
      error: "session-busy",
      controlOutcome: "not-dispatched",
    });
    expect(await f.live()).toMatchObject({ status: "running", turnId: "existing-turn" });
    expect(f.methods).not.toContain("turn/start");
  });

  it("resets history cursors when switching between native read-only history and a managed runner", async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    await f.send();
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(61_000);
    const executable = f.start.mock.calls[0]![0];
    f.version.mockResolvedValue({ executable, reason: "codex-cli-version-too-old" });
    f.version.mockClear();
    const page = await f.web.request({ operation: "events", sessionId: f.summary.id, limit: 1 });
    expect(page.next_cursor).toMatch(/^codex-native-v1:/);
    expect(page.events).toEqual([expect.objectContaining({ content: "Earlier answer" })]);
    expect(f.version).not.toHaveBeenCalled();
    expect(f.start).toHaveBeenCalledOnce();
    f.version.mockResolvedValue({ executable, reason: null });
    expect(await f.send()).toMatchObject({ accepted: true });
    await expect(
      f.web.request({
        operation: "events",
        sessionId: f.summary.id,
        limit: 1,
        cursor: page.next_cursor,
      }),
    ).rejects.toThrow("TRANSCRIPT_CURSOR_STALE");
    f.servers[1]!.complete();
    await vi.advanceTimersByTimeAsync(61_000);
    await expect(
      f.web.request({ operation: "events", sessionId: f.summary.id, limit: 1, cursor: "42" }),
    ).rejects.toThrow("TRANSCRIPT_CURSOR_STALE");
  });

  it("stops before the first turn when the started Codex reports a release without the writer lock", async () => {
    const f = fixture(true);
    // `--version` named nothing readable, so the check let this CLI through.
    f.setServerUserAgent("agentkib/0.146.0 (Mac OS 26.0.0; arm64) fixture");
    expect(await f.send()).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "codex-cli-version-too-old",
    });
    expect(f.methods).not.toContain("turn/start");
    expect(f.servers.every((server) => server.closed || !server.connected)).toBe(true);
    f.setServerUserAgent("agentkib/0.167.0-alpha.4.1 (Mac OS 26.0.0; arm64) fixture");
    expect(await f.send()).toMatchObject({ accepted: true });
  });

  it("tells a lead when one of its lanes ends a turn", async () => {
    const f = fixture(true);
    const ended: unknown[] = [];
    f.web.observeLanes({ turnEnded: (...args) => ended.push(args), waiting: () => {} });
    expect(await f.send()).toMatchObject({ accepted: true });
    f.servers[0]!.complete({ durationMs: 192_000 });
    await vi.waitFor(() =>
      expect(ended).toEqual([[f.summary.id, "new-turn", "completed", 192_000]]),
    );
  });

  it("keeps native writer conflicts authoritative for compressed history", async () => {
    const f = fixture(true);
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(false);
    f.setFailure(
      new CodexAppServerError({
        code: -32600,
        message: `thread ${nativeId} already has an active writer`,
      }),
    );
    expect(await f.send()).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    });
    expect(f.methods).not.toContain("turn/start");
    expect(await f.live()).toMatchObject({ sendEnabled: false, executionLocation: "external" });
    expect(f.follower).not.toHaveBeenCalled();
  });

  it("leaves compressed-history messages unsent when native resume times out", async () => {
    const f = fixture(true);
    f.setFailure(new Error("Codex app-server request timed out"));
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(commandOperations(f.root, f.summary.id)).toEqual(["send"]);
    await f.live();
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.methods).not.toContain("turn/start");
    expect(f.follower).not.toHaveBeenCalled();
  });

  it("rejects a changed compressed session identity before any CLI continuation", async () => {
    const f = fixture(true);
    writeFileSync(f.compressedTranscript, zstdCompressSync(f.history.replace(nativeId, forkId)));
    await expect(f.live()).rejects.toThrow("unverified-session-identity");
    expect(f.start).not.toHaveBeenCalled();
    expect(f.follower).not.toHaveBeenCalled();
  });

  it.each(["backend.initialize", "agentkib.shutdown"])(
    "closes an initializing automatic runner before acknowledging %s",
    async (method) => {
      const f = fixture(true);
      await f.send();
      await f.web.closeAsync();
      writeFileSync(
        path.join(f.root, "preferences.json"),
        JSON.stringify({ session_index_enabled: false, session_content_search_enabled: false }),
      );
      vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
      vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
      const backend = new TypeScriptBackend({
        HOME: f.home,
        CODEX_HOME: f.home,
        PATH: path.join(f.root, "bin"),
      });
      cleanups.push(() => backend.closeAsync());
      const rpc = (name: string, params: unknown) =>
        backend.handleAsync({ jsonrpc: "2.0", id: randomUUID(), method: name, params });
      expect((await rpc("backend.initialize", { dataDir: f.root })).error).toBeUndefined();
      const liveResponse = await rpc("web.request", {
        operation: "live",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      });
      expect(liveResponse.error).toBeUndefined();
      const live = liveResponse.result as Record<string, unknown>;
      const original = f.start.getMockImplementation()!;
      let resume!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      f.start.mockImplementation(async (...args) => {
        const server = await original(...args);
        entered();
        await gate;
        return server;
      });
      const requestId = randomUUID();
      const sending = rpc("codex.managed", {
        operation: "send",
        sessionId: f.summary.id,
        requestId,
        deviceId: "fixture",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        text: "Continue",
      });
      await started;
      f.methods.length = 0;
      let acknowledged = false;
      const closing = rpc(method, method === "backend.initialize" ? { dataDir: f.root } : {}).then(
        (response) => {
          acknowledged = true;
          return response;
        },
      );
      // Let the real Backend reach WebReadRequests.closeAsync without releasing startup.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const earlyAcknowledgement = acknowledged;
      resume();
      const [sent, closed] = await Promise.all([sending, closing]);
      expect(closed.error).toBeUndefined();
      expect(earlyAcknowledgement).toBe(false);
      expect(f.servers.at(-1)?.closed).toBe(true);
      expect(f.methods).not.toContain("thread/resume");
      expect(f.methods).not.toContain("turn/start");
      expect(sent.error).toBeUndefined();
      expect(sent.result).toMatchObject({ controlOutcome: "not-dispatched" });
      expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
        status: "not-dispatched",
      });
      const release = acquireManagedSessionLease(f.root, f.summary.id);
      release();
    },
  );

  it.each(["thread/resume", "turn/start"])(
    "preserves the correct send receipt when shutdown interrupts %s",
    async (method) => {
      const f = fixture();
      const live = await f.live();
      const original = f.start.getMockImplementation()!;
      let entered!: () => void;
      const dispatched = new Promise<void>((resolve) => (entered = resolve));
      f.start.mockImplementation(async (...args) => {
        const server = await original(...args);
        const request = server.request.bind(server);
        vi.spyOn(server, "request").mockImplementation(async (name, params, dispatch) => {
          const response = request(name, params, dispatch);
          if (name !== method) return response;
          entered();
          await new Promise<void>((_resolve, reject) => {
            server.once("close", () => reject(new Error("native response lost during shutdown")));
          });
          return response;
        });
        return server;
      });
      const requestId = randomUUID();
      const sending = f.sendWithState(live, { requestId });
      await dispatched;
      const closing = f.web.closeAsync();
      const sent = await sending;
      await closing;
      expect(sent).toMatchObject({
        controlOutcome: method === "thread/resume" ? "not-dispatched" : "unknown",
      });
      const unresolved = readUnknownManagedCommands(f.root, f.summary.id);
      expect(unresolved).toEqual(
        method === "thread/resume"
          ? []
          : [
              expect.objectContaining({
                requestId,
                evidence: expect.objectContaining({ operation: "send" }),
              }),
            ],
      );
      expect(commandOperations(f.root, f.summary.id)).toEqual(["send"]);
      expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
        status: method === "thread/resume" ? "not-dispatched" : "unknown",
      });
      expect(f.servers[0]?.closed).toBe(true);
      const release = acquireManagedSessionLease(f.root, f.summary.id);
      release();
      await expect(f.sendWithState(live)).rejects.toThrow("backend-closing");
    },
  );

  it("retains an initializing runner's lease when shutdown cannot confirm process closure", async () => {
    const f = fixture();
    const originalCleanup = cleanups.pop()!;
    cleanups.push(async () => {
      await expect(originalCleanup()).rejects.toThrow("process did not close after termination");
    });
    const live = await f.live();
    const original = f.start.getMockImplementation()!;
    let resume!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    f.start.mockImplementation(async (...args) => {
      const session = await original(...args);
      f.servers.at(-1)!.closeFailure = new Error("process did not close after termination");
      entered();
      await gate;
      return session;
    });
    const sending = f.sendWithState(live);
    await started;
    const closing = f.web.closeAsync();
    const rejectedClose = expect(closing).rejects.toThrow(
      "process did not close after termination",
    );
    resume();
    expect(await sending).toMatchObject({ controlOutcome: "not-dispatched" });
    await rejectedClose;
    expect(f.methods).not.toContain("thread/resume");
    expect(() => acquireManagedSessionLease(f.root, f.summary.id)).toThrow(
      "session-managed-by-another-runtime",
    );
    const server = f.servers.at(-1)!;
    server.closed = true;
    server.emit("close");
    const release = acquireManagedSessionLease(f.root, f.summary.id);
    release();
  });

  it("does not rewrite a new owner when a shutdown startup settles after lease transfer", async () => {
    const f = fixture();
    const live = await f.live();
    const acquire = acquireManagedSessionLease;
    let afterRelease: (() => void) | undefined;
    vi.spyOn(managedSessionLocks, "acquireManagedSessionLease").mockImplementation((data, id) => {
      const release = acquire(data, id);
      return () => {
        release();
        const transferred = afterRelease;
        afterRelease = undefined;
        transferred?.();
      };
    });
    const start = f.start.getMockImplementation()!;
    let resume!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    const started = new Promise<void>((resolve) => (entered = resolve));
    cleanups.push(() => resume());
    f.start.mockImplementation(async (...args) => {
      const server = await start(...args);
      entered();
      await gate;
      return server;
    });
    const sending = f.sendWithState(live);
    await started;
    let otherRelease: (() => void) | undefined;
    cleanups.push(() => otherRelease?.());
    afterRelease = () => {
      otherRelease = acquire(f.root, f.summary.id);
      saveManagedRecord(f.root, {
        ...readManagedRecord(f.root, f.summary.id)!,
        released: false,
        snapshot: { status: "running", revision: 99, turnId: "other-runtime-turn" },
      });
    };
    const closing = f.web.closeAsync();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(otherRelease).toBeDefined();
    resume();
    expect(await sending).toMatchObject({ controlOutcome: "not-dispatched" });
    await closing;
    expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
      released: false,
      snapshot: { status: "running", revision: 99, turnId: "other-runtime-turn" },
    });
  });

  it("closes a runner returned across the startup registration microtask boundary", async () => {
    const f = fixture();
    const live = await f.live();
    const hydrate = ManagedCodexState.prototype.hydrate;
    let closing: Promise<void> | undefined;
    vi.spyOn(ManagedCodexState.prototype, "hydrate").mockImplementation(function (...args) {
      const result = hydrate.apply(this, args);
      queueMicrotask(() => {
        closing = f.web.closeAsync();
      });
      return result;
    });
    expect(await f.sendWithState(live)).toMatchObject({ controlOutcome: "not-dispatched" });
    expect(closing).toBeDefined();
    await closing;
    expect(f.servers[0]?.closed).toBe(true);
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.methods).not.toContain("turn/start");
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    const release = acquireManagedSessionLease(f.root, f.summary.id);
    release();
  });

  it("records a subscription installed synchronously after control admission", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.leave();
    const live = await f.live();
    const sending = f.sendWithState(live);
    f.observe();
    f.web.observeSession(f.summary.id);
    f.leave();
    expect(await sending).toMatchObject({ accepted: true });
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.servers[0]?.closed).toBe(true);
  });

  it.each([false, true])(
    "closes a transient queue reader during shutdown and retains failed closure leases (%s)",
    async (failClose) => {
      vi.useFakeTimers();
      const f = fixture();
      if (failClose) {
        const originalCleanup = cleanups.pop()!;
        cleanups.push(async () => {
          await expect(originalCleanup()).rejects.toThrow("queue reader did not close");
        });
      }
      await f.send();
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(61_000);
      saveManagedRecord(f.root, { ...readManagedRecord(f.root, f.summary.id)!, released: false });
      const original = f.start.getMockImplementation()!;
      let resume!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => (resume = resolve));
      const started = new Promise<void>((resolve) => (entered = resolve));
      f.start.mockImplementation(async (...args) => {
        const session = await original(...args);
        if (failClose) f.servers.at(-1)!.closeFailure = new Error("queue reader did not close");
        entered();
        await gate;
        return session;
      });
      const reading = f.web.managedQueueList({ operation: "queue-list", sessionId: f.summary.id });
      const rejectedRead = expect(reading).rejects.toThrow(
        failClose ? "queue reader did not close" : "backend-closing",
      );
      await started;
      const closing = f.web.closeAsync();
      const closed = failClose
        ? expect(closing).rejects.toThrow("queue reader did not close")
        : closing;
      resume();
      await Promise.all([rejectedRead, closed]);
      const server = f.servers.at(-1)!;
      if (failClose) {
        expect(() => acquireManagedSessionLease(f.root, f.summary.id)).toThrow(
          "session-managed-by-another-runtime",
        );
        server.closed = true;
        server.emit("close");
      } else expect(server.closed).toBe(true);
      const release = acquireManagedSessionLease(f.root, f.summary.id);
      release();
    },
  );

  it("reads an inactive session without a runner and only resumes it on send", async () => {
    const f = fixture();
    expect(await f.live()).toMatchObject({
      status: "idle",
      executionLocation: null,
      sendEnabled: true,
      ownershipReason: null,
    });
    expect(f.start).not.toHaveBeenCalled();
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods).toContain("thread/resume");
    expect(f.methods).toContain("turn/start");
    expect(commandOperations(f.root, f.summary.id)).toEqual(["send"]);
    expect(f.follower).not.toHaveBeenCalled();
    expect(await f.live()).toMatchObject({ executionLocation: "agentkib" });
  });

  it.each([true, false])(
    "saves a cold session policy without resuming and verifies it on send (native match: %s)",
    async (nativeMatch) => {
      const f = fixture();
      f.setModels([
        {
          model: "model-a",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          serviceTiers: [{ id: "priority" }],
        },
      ]);
      const state = await f.live();
      const requestId = randomUUID();
      const change = {
        operation: "settings",
        sessionId: f.summary.id,
        requestId,
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        policyId: "workspace-write-auto-review",
      };
      const saved = await f.web.managedControl(change);
      expect(saved).toMatchObject({ accepted: true, requestId, appliesTo: "next-turn" });
      expect(await f.web.managedControl(change)).toEqual(saved);
      expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
        status: "accepted",
        sessionId: f.summary.id,
      });
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
        policy_id: "workspace-write-auto-review",
        released: true,
        snapshot: { revision: 1 },
      });
      expect(f.start).not.toHaveBeenCalled();
      expect(commandOperations(f.root, f.summary.id)).toEqual(["settings"]);

      f.setPolicyReply({
        ...(!nativeMatch ? { approvalsReviewer: "user" } : {}),
        reasoningEffort: "high",
        serviceTier: "priority",
      });
      const sent = await f.send();
      expect(f.requests.find(({ method }) => method === "thread/resume")?.params).toMatchObject({
        threadId: nativeId,
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandbox: "workspace-write",
      });
      const turn = f.requests.find(({ method }) => method === "turn/start");
      if (nativeMatch) {
        expect(sent).toMatchObject({ accepted: true });
        expect(turn?.params).toMatchObject({
          approvalsReviewer: "auto_review",
          effort: "high",
          serviceTier: "priority",
        });
      } else {
        expect(sent).toMatchObject({
          controlOutcome: "not-dispatched",
          reason: "codex-policy-mismatch",
        });
        expect(turn).toBeUndefined();
      }
      expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
      expect(commandOperations(f.root, f.summary.id)).toEqual(["settings", "send"]);
    },
  );

  it.each([
    { name: "on", serviceTier: "priority" },
    { name: "off", serviceTier: null },
  ])(
    "saves the next-turn model and effort with Fast $name without resuming Codex",
    async ({ serviceTier }) => {
      const f = fixture();
      f.setModels([
        { model: "model-a", isDefault: true },
        {
          model: "model-b",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          serviceTiers: [{ id: "priority", name: "Fast" }],
        },
      ]);
      const readSettings = () =>
        f.web.managedSettingsState({ operation: "settings-state", sessionId: f.summary.id });
      expect(await readSettings()).toMatchObject({ available: true });
      expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
      const state = await f.live();
      expect(
        await f.web.managedControl({
          operation: "settings",
          sessionId: f.summary.id,
          requestId: randomUUID(),
          deviceId: "fixture",
          runtimeBootId: state.runtimeBootId,
          expectedRevision: state.revision,
          experimentalEnabled: true,
          model: "model-b",
          effort: "high",
          serviceTier,
        }),
      ).toMatchObject({ accepted: true });
      expect(await readSettings()).toMatchObject({
        available: true,
        settings: {
          applicationStatus: "pending",
          selected: { model: "model-b", effort: "high", serviceTier },
          current: { model: null, serviceTier: null },
        },
      });
      expect(await f.live()).toMatchObject({ sendEnabled: true, executionLocation: null });
      expect(f.methods).not.toContain("thread/resume");
      expect(f.methods).not.toContain("turn/start");
      expect(commandOperations(f.root, f.summary.id)).toEqual(["settings"]);

      // Codex can still report its inherited Fast tier while the local clear is pending.
      if (serviceTier === null) f.setPolicyReply({ serviceTier: "priority" });
      const requestId = randomUUID();
      expect(await f.send({ requestId })).toMatchObject({ accepted: true, requestId });
      expect(f.requests.find(({ method }) => method === "thread/resume")?.params).toMatchObject({
        threadId: nativeId,
        cwd: f.workspace,
        approvalPolicy: "on-request",
        serviceTier,
      });
      expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
        threadId: nativeId,
        clientUserMessageId: requestId,
        model: "model-b",
        effort: "high",
        serviceTier,
        approvalPolicy: "on-request",
      });
      expect(commandOperations(f.root, f.summary.id)).toEqual(["settings", "send"]);
    },
  );

  it("reports a definite writer refusal without an unknown command or follower fallback", async () => {
    const f = fixture();
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(false);
    f.setFailure(
      new CodexAppServerError({
        code: -32600,
        message: `thread ${nativeId} already has an active writer`,
      }),
    );
    const result = await f.send();
    expect(result).toMatchObject({
      accepted: false,
      completed: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(await f.live()).toMatchObject({
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      sendEnabled: false,
    });
    expect(f.follower).not.toHaveBeenCalled();
    expect(f.methods).not.toContain("turn/start");
  });

  it("keeps an observed unknown outcome above a cached writer conflict in catalog without another ownership probe", async () => {
    const f = fixture();
    vi.spyOn(f.store.sessions, "list").mockReturnValue([
      f.summary as ReturnType<typeof f.store.sessions.list>[number],
    ]);
    const lockDirectory = path.join(f.home, "thread-writer-locks");
    mkdirSync(lockDirectory, { recursive: true });
    const release = acquirePortableFileLease(path.join(lockDirectory, `${nativeId}.lock`));
    cleanups.push(release);
    expect(await f.live()).toMatchObject({ reason: "codex-owner-busy" });
    const requestId = randomUUID();
    claimManagedCommand(f.root, requestId, f.summary.id, "synthetic-unknown", "fixture", {
      operation: "send",
    });
    dispatchManagedCommand(f.root, requestId);
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
    });
    f.version.mockClear();
    const methods = [...f.methods];
    const catalog = (await f.web.request({ operation: "catalog" })) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(catalog.sessions.find((row) => row.id === f.summary.id)?.continuation).toMatchObject({
      reason: "control-outcome-unconfirmed",
      ownershipReason: null,
    });
    expect(f.version).not.toHaveBeenCalled();
    expect(f.methods).toEqual(methods);
  });
  it("leaves the message unsent when native resume times out and never retries it automatically", async () => {
    const f = fixture();
    f.setFailure(new Error("Codex app-server request timed out"));
    const requestId = randomUUID();
    expect(await f.send({ requestId })).toMatchObject({
      requestId,
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      found: true,
      status: "not-dispatched",
      operation: "send",
      ack: { controlOutcome: "not-dispatched" },
    });
    expect(commandOperations(f.root, f.summary.id)).toEqual(["send"]);
    f.setFailure(undefined);
    expect(await f.live()).toMatchObject({ sendEnabled: true });
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.follower).not.toHaveBeenCalled();
    expect(f.methods).not.toContain("turn/start");
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("reconciles a legacy adoption with one read-only Codex probe and restores controls", async () => {
    const f = fixture();
    const requestId = dispatchLegacyAdoption(f);
    f.intercept((method) =>
      method === "thread/read"
        ? { thread: { id: nativeId, cwd: f.workspace, status: { type: "notLoaded" } } }
        : undefined,
    );
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      status: "unknown",
    });
    const [live, capabilities] = await Promise.all([
      f.live(),
      f.web.managedQuery({
        operation: "capabilities",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      }),
    ]);
    expect(live).toMatchObject({ sendEnabled: true, executionLocation: null });
    expect(capabilities).toMatchObject({
      features: { send: { available: true }, settings: { available: true } },
    });
    expect(f.requests.filter(({ method }) => method === "thread/read")).toEqual([
      { method: "thread/read", params: { threadId: nativeId, includeTurns: false } },
    ]);
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      status: "accepted",
      operation: "adopt",
      ack: { reconciled: true, completed: false },
    });
    expect(commandOperations(f.root, f.summary.id)).toEqual(["adopt"]);
    expect(
      await f.web.managedSettingsState({ operation: "settings-state", sessionId: f.summary.id }),
    ).toMatchObject({ available: true });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
  });

  it.each([true, false])(
    "reconciles a lost turn response on restart only for the same request ID (match: %s)",
    async (matches) => {
      const f = fixture();
      const firstLive = await f.live();
      const requestId = randomUUID();
      f.setTurnFailure(new Error("native turn response lost"));
      expect(await f.sendWithState(firstLive, { requestId })).toMatchObject({
        controlOutcome: "unknown",
      });
      await f.web.closeAsync();
      f.setReadTurns([
        {
          id: "started-before-shutdown",
          status: "completed",
          items: [{ type: "userMessage", clientId: matches ? requestId : randomUUID() }],
        },
      ]);
      const readStart = f.requests.length;
      const restarted = new WebReadRequests(f.store, f.readers, f.root, () => 0n, {
        CODEX_HOME: f.home,
        HOME: f.root,
        PATH: f.bin,
      });
      cleanups.push(() => restarted.closeAsync());
      const [live, capabilities] = await Promise.all([
        restarted.request({
          operation: "live",
          sessionId: f.summary.id,
          experimentalEnabled: true,
        }),
        restarted.managedQuery({
          operation: "capabilities",
          sessionId: f.summary.id,
          experimentalEnabled: true,
        }),
      ]);
      expect(live).toMatchObject({
        executionLocation: null,
        sendEnabled: matches,
        reason: matches ? null : "control-outcome-unconfirmed",
      });
      expect(capabilities).toMatchObject({
        features: { send: { available: matches }, settings: { available: matches } },
      });
      expect(f.requests.slice(readStart)).toEqual([
        { method: "thread/read", params: { threadId: nativeId, includeTurns: true } },
      ]);
      const receipt = readControlReceipt(f.root, { requestId, deviceId: "fixture" });
      if (matches) {
        expect(receipt).toMatchObject({
          status: "accepted",
          operation: "send",
          requestId,
          ack: { runtimeBootId: firstLive.runtimeBootId, reconciled: true, completed: false },
        });
        expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
      } else {
        expect(receipt).toMatchObject({ status: "unknown", operation: "send", requestId });
        expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(1);
      }
      expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
    },
  );

  it("retains the legacy adoption fence if the native read returns another thread", async () => {
    const f = fixture();
    const requestId = dispatchLegacyAdoption(f);
    f.intercept((method) =>
      method === "thread/read"
        ? { thread: { id: forkId, cwd: f.workspace, status: { type: "idle" } } }
        : undefined,
    );
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
    });
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      status: "unknown",
    });
    expect(f.methods).toContain("thread/read");
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
  });

  it("rejects a fresh standalone adoption without opening a runner or creating a receipt", async () => {
    const f = fixture();
    const requestId = randomUUID();
    await expect(
      f.web.managedLifecycle({
        operation: "adopt",
        requestId,
        deviceId: "fixture",
        sessionId: f.summary.id,
      }),
    ).rejects.toThrow();
    expect(f.start).not.toHaveBeenCalled();
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      found: false,
    });
  });

  it("forks a busy source through a reader without resuming or changing the source", async () => {
    const f = fixture();
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(false);
    const directory = path.join(f.home, "thread-writer-locks");
    mkdirSync(directory);
    const release = acquirePortableFileLease(path.join(directory, `${nativeId}.lock`));
    cleanups.push(release);
    const state = await f.live();
    expect(state).toMatchObject({ reason: "codex-owner-busy" });
    const result = await f.web.managedControl({
      operation: "fork",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
    });
    expect(result).toMatchObject({ accepted: true, sourceSessionId: f.summary.id });
    expect(f.methods).toContain("thread/read");
    expect(f.methods).toContain("thread/fork");
    expect(f.methods).not.toContain("thread/resume");
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
    expect(f.follower).not.toHaveBeenCalled();
    const catalog = (await f.web.request({ operation: "catalog" })) as {
      sessions: Array<Record<string, unknown>>;
    };
    expect(catalog.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: result.sessionId,
          forked_from_session_id: f.summary.id,
        }),
      ]),
    );
  });

  it("releases after a completed turn is idle and automatically resumes an old released adoption", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.send();
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(f.servers[0]!.connected).toBe(false);
    expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
      adopted: true,
      released: true,
    });
    expect(await f.live()).toMatchObject({ sendEnabled: true, executionLocation: null });
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(2);
  });

  it.each(["idle", "leave", "release"] as const)(
    "finishes %s retirement before transferring its lease to another runtime",
    async (reason) => {
      vi.useFakeTimers();
      const acquire = acquireManagedSessionLease;
      let afterRelease: (() => void) | undefined;
      vi.spyOn(managedSessionLocks, "acquireManagedSessionLease").mockImplementation((data, id) => {
        const release = acquire(data, id);
        return () => {
          release();
          const transferred = afterRelease;
          afterRelease = undefined;
          transferred?.();
        };
      });
      const f = fixture();
      await f.send();
      f.servers[0]!.complete();
      await f.live();
      let transferredRecord: Record<string, unknown> | null = null;
      let otherRelease: (() => void) | undefined;
      cleanups.push(() => otherRelease?.());
      afterRelease = () => {
        // Another process can acquire immediately after the native file lease is released.
        otherRelease = acquire(f.root, f.summary.id);
        transferredRecord = readManagedRecord(f.root, f.summary.id)!;
        saveManagedRecord(f.root, {
          ...transferredRecord,
          released: false,
          snapshot: { status: "running", revision: 99, turnId: "other-runtime-turn" },
        });
      };
      if (reason === "release") {
        expect(
          await f.web.managedLifecycle({
            operation: "release",
            sessionId: f.summary.id,
            requestId: randomUUID(),
            deviceId: "fixture",
          }),
        ).toMatchObject({ accepted: true, released: true });
      } else {
        if (reason === "leave") f.leave();
        await vi.advanceTimersByTimeAsync(reason === "leave" ? 1000 : 61_000);
      }
      expect(transferredRecord).toMatchObject({ released: true });
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({
        released: false,
        snapshot: { status: "running", revision: 99, turnId: "other-runtime-turn" },
      });
    },
  );

  it.each(["resume", "create", "fork"] as const)(
    "records a refused %s startup before transferring its lease",
    async (operation) => {
      vi.useFakeTimers();
      const f = fixture();
      if (operation === "resume") {
        await f.send();
        f.servers[0]!.complete();
        await vi.advanceTimersByTimeAsync(61_000);
      }
      const live = await f.live();
      const start = f.start.getMockImplementation()!;
      f.start.mockImplementation(async (...args) => {
        const server = await start(...args);
        const request = server.request.bind(server);
        vi.spyOn(server, "request").mockImplementation(async (method, ...params) => {
          if (method === "model/list") throw new Error("fixture-startup-refused");
          return request(method, ...params);
        });
        return server;
      });
      const acquire = acquireManagedSessionLease;
      let transferredRecord: Record<string, unknown> | null = null;
      let otherRelease: (() => void) | undefined;
      cleanups.push(() => otherRelease?.());
      vi.spyOn(managedSessionLocks, "acquireManagedSessionLease").mockImplementation((data, id) => {
        const release = acquire(data, id);
        let transferred = false;
        return () => {
          release();
          if (transferred) return;
          transferred = true;
          otherRelease = acquire(data, id);
          transferredRecord = readManagedRecord(data, id)!;
          saveManagedRecord(data, {
            ...transferredRecord,
            released: false,
            snapshot: { status: "running", revision: 99, turnId: "other-runtime-turn" },
          });
        };
      });
      const request = { requestId: randomUUID(), deviceId: "fixture" };
      const result =
        operation === "fork"
          ? await f.web.managedControl({
              ...request,
              operation,
              sessionId: f.summary.id,
              runtimeBootId: live.runtimeBootId,
              expectedRevision: live.revision,
              experimentalEnabled: true,
            })
          : operation === "resume"
            ? await f.web.managedResume({
                ...request,
                operation,
                sessionId: f.summary.id,
                runtimeBootId: live.runtimeBootId,
                expectedRevision: live.revision,
                experimentalEnabled: true,
              })
            : await f.web.managedLifecycle({
                ...request,
                operation,
                ...(operation === "create"
                  ? { workspaceId: "workspace", policyId: "workspace-write-on-request" }
                  : { sessionId: f.summary.id }),
              });
      expect(result).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "fixture-startup-refused",
      });
      expect(transferredRecord).toMatchObject({
        released: true,
        snapshot: { reason: "fixture-startup-refused" },
      });
      expect(readManagedRecord(f.root, String(result.sessionId))).toMatchObject({
        released: false,
        snapshot: { status: "running", revision: 99, turnId: "other-runtime-turn" },
      });
    },
  );

  it.each([false, true])(
    "keeps an unarchive lease through its durable result (closure fails: %s)",
    async (failClose) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.send();
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(61_000);
      saveManagedRecord(f.root, { ...readManagedRecord(f.root, f.summary.id)!, archived: true });
      const live = await f.live();
      const start = f.start.getMockImplementation()!;
      f.start.mockImplementation(async (...args) => {
        const server = await start(...args);
        if (failClose) f.servers.at(-1)!.closeFailure = new Error("unarchive did not close");
        return server;
      });
      const acquire = acquireManagedSessionLease;
      let transferredRecord: Record<string, unknown> | null = null;
      vi.spyOn(managedSessionLocks, "acquireManagedSessionLease").mockImplementation((data, id) => {
        const release = acquire(data, id);
        return () => {
          transferredRecord = readManagedRecord(data, id);
          release();
        };
      });
      const pending = f.web.managedUnarchive({
        operation: "unarchive",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
      });
      if (failClose) {
        await expect(pending).rejects.toThrow("unarchive did not close");
        expect(transferredRecord).toBeNull();
        expect(() => acquire(f.root, f.summary.id)).toThrow("session-managed-by-another-runtime");
        const server = f.servers.at(-1)!;
        server.closed = true;
        server.emit("close");
        const release = acquire(f.root, f.summary.id);
        release();
      } else {
        expect(await pending).toMatchObject({ accepted: true, requiresResume: true });
        expect(transferredRecord).toMatchObject({ archived: false, released: true });
      }
    },
  );

  it.each([false, true])(
    "waits for the active turn after the last subscriber leaves, then releases (active goal: %s)",
    async (activeGoal) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.send();
      if (activeGoal) f.servers[0]!.activateGoal();
      expect(await f.live()).toMatchObject({ status: "running" });
      f.leave();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.servers[0]!.connected).toBe(true);
      expect(f.methods).not.toContain("turn/interrupt");
      f.servers[0]!.complete();
      if (activeGoal) expect(await f.live()).toMatchObject({ goal: { status: "active" } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(false);
      expect(readManagedRecord(f.root, f.summary.id)).toMatchObject({ released: true });
    },
  );

  it("preserves an idle active goal while a subscriber still observes the session", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.send();
    f.servers[0]!.activateGoal();
    f.servers[0]!.complete();
    expect(await f.live()).toMatchObject({ status: "idle", goal: { status: "active" } });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(f.servers[0]!.connected).toBe(true);
    expect(f.methods).not.toContain("turn/interrupt");
  });

  it.each([
    ["spawn", false],
    ["spawn", true],
    ["preflight", false],
    ["preflight", true],
  ] as const)(
    "remembers a subscriber leaving during %s (active goal: %s)",
    async (phase, activeGoal) => {
      vi.useFakeTimers();
      const f = fixture();
      const state = await f.live();
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (phase === "spawn") {
        const implementation = f.start.getMockImplementation()!;
        f.start.mockImplementation(async (...args) => {
          entered();
          await gate;
          return implementation(...args);
        });
      } else {
        f.version.mockImplementationOnce(async () => {
          entered();
          await gate;
          return { reason: null };
        });
      }
      const pending = f.sendWithState(state);
      await started;
      f.leave();
      await vi.advanceTimersByTimeAsync(3000);
      release();
      expect(await pending).toMatchObject({ accepted: true });
      if (activeGoal) f.servers[0]!.activateGoal();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.servers[0]!.connected).toBe(true);
      expect(f.methods).not.toContain("turn/interrupt");
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(false);
    },
  );

  it.each([false, true])(
    "does not invent a departing subscriber for background startup (active goal: %s)",
    async (activeGoal) => {
      vi.useFakeTimers();
      const f = fixture();
      f.leave();
      // Historical observations without a runner or an admitted control do not survive.
      f.web.observeSession(f.summary.id);
      await f.send();
      if (activeGoal) f.servers[0]!.activateGoal();
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(true);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.servers[0]!.connected).toBe(activeGoal);
      expect(f.methods).not.toContain("turn/interrupt");
    },
  );

  it("records a short subscription during startup until the last concurrent control finishes", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.leave();
    const state = await f.live();
    const implementation = f.start.getMockImplementation()!;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.start.mockImplementation(async (...args) => {
      entered();
      await gate;
      return implementation(...args);
    });
    const pending = f.sendWithState(state);
    await started;
    f.web.observeSession(f.summary.id);
    expect(await f.sendWithState(state, { operation: "stop" })).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
    });
    release();
    expect(await pending).toMatchObject({ accepted: true });
    f.servers[0]!.activateGoal();
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.servers[0]!.connected).toBe(false);
    expect(f.methods).not.toContain("turn/interrupt");
  });

  it("retains a short subscription between constructing and registering the startup runner", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.leave();
    const state = await f.live();
    const hydrate = ManagedCodexState.prototype.hydrate;
    let observed = false;
    vi.spyOn(ManagedCodexState.prototype, "hydrate").mockImplementationOnce(function (
      this: ManagedCodexState,
      ...args
    ) {
      const result = hydrate.apply(this, args);
      // Attach constructs its return value synchronously after hydration; this
      // runs before its awaiting caller can register that runner.
      queueMicrotask(() => {
        observed = true;
        f.web.observeSession(f.summary.id);
      });
      return result;
    });
    expect(await f.sendWithState(state)).toMatchObject({ accepted: true });
    expect(observed).toBe(true);
    f.servers[0]!.activateGoal();
    f.servers[0]!.complete();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.servers[0]!.connected).toBe(false);
    expect(f.methods).not.toContain("turn/interrupt");
  });

  it.each(["subscription", "live"] as const)(
    "records an existing runner observation through %s before the next timer tick",
    async (via) => {
      vi.useFakeTimers();
      const f = fixture();
      f.leave();
      await f.send();
      if (via === "subscription") f.web.observeSession(f.summary.id);
      else {
        f.observe();
        await f.live();
        f.leave();
      }
      f.servers[0]!.activateGoal();
      f.servers[0]!.complete();
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.servers[0]!.connected).toBe(false);
    },
  );

  it("keeps the runner and lease fenced when shutdown is not confirmed, then cleans up on real close", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.send();
    const server = f.servers[0]!;
    server.complete();
    server.closeFailure = new Error("process did not close after termination");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(server.connected).toBe(false);
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      executionLocation: "agentkib",
      sendEnabled: false,
    });
    expect(() => acquireManagedSessionLease(f.root, f.summary.id)).toThrow(
      "session-managed-by-another-runtime",
    );
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
    server.closed = true;
    server.emit("close");
    const release = acquireManagedSessionLease(f.root, f.summary.id);
    release();
    expect(await f.live()).toMatchObject({ executionLocation: null, sendEnabled: true });
  });

  it("keeps an old CLI read only and rejects sending with a correlated reason", async () => {
    const f = fixture();
    f.version.mockResolvedValue({
      executable: "/fixture/codex",
      reason: "codex-cli-version-too-old",
    });
    expect(await f.live()).toMatchObject({
      sendEnabled: false,
      reason: "codex-cli-version-too-old",
    });
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "codex-cli-version-too-old",
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("refreshes ownership after the other writer leaves without changing the source", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const directory = path.join(f.home, "thread-writer-locks");
    mkdirSync(directory);
    const release = acquirePortableFileLease(path.join(directory, `${nativeId}.lock`));
    try {
      expect(await f.live()).toMatchObject({ ownershipReason: "codex-owner-busy" });
    } finally {
      release();
    }
    await vi.advanceTimersByTimeAsync(4000);
    expect(await f.live()).toMatchObject({
      ownershipReason: null,
      executionLocation: null,
      sendEnabled: true,
    });
    expect(f.start).not.toHaveBeenCalled();
  });

  it("uses metadata-only app-server readers for inspection, settings, resources and goals", async () => {
    const f = fixture();
    expect(
      await f.web.managedReconcile({
        operation: "reconcile",
        sessionId: f.summary.id,
        deviceId: "fixture",
        requestId: randomUUID(),
      }),
    ).toMatchObject({ reconciled: true });
    expect(
      await f.web.managedSettingsState({ operation: "settings-state", sessionId: f.summary.id }),
    ).toMatchObject({ available: true });
    expect(await f.web.request({ operation: "resources", sessionId: f.summary.id })).toMatchObject({
      available: true,
      executionMode: "codex-managed",
    });
    expect(await f.web.request({ operation: "goal", sessionId: f.summary.id })).toMatchObject({
      available: true,
      executionMode: "codex-managed",
    });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.follower).not.toHaveBeenCalled();
    expect(f.servers.every((server) => !server.connected)).toBe(true);
  });

  it("reads settings and the last usage report of an idle indexed session without resuming it", async () => {
    const f = fixture(true);
    const updatedAt = "2026-10-19T00:01:00Z";
    const events = [
      { type: "turn_context", payload: { model: "last-model", effort: "xhigh" } },
      {
        type: "event_msg",
        timestamp: updatedAt,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: { total_tokens: 75584 },
            total_token_usage: { total_tokens: 397857 },
            model_context_window: 258400,
          },
        },
      },
    ];
    writeFileSync(
      f.compressedTranscript,
      zstdCompressSync(f.history + events.map((event) => JSON.stringify(event) + "\n").join("")),
    );

    const settings = { operation: "settings-state", sessionId: f.summary.id };
    expect(await f.web.managedSettingsState(settings)).not.toHaveProperty("historicalSettings");
    const read = () => f.web.sessionProviderSettingsState({ ...settings, includeHistorical: true });
    expect(await read()).toMatchObject({
      available: true,
      provider: { contextUsage: "live" },
      historicalSettings: { modelId: "last-model", effort: "xhigh" },
      historicalUsage: {
        historical: true,
        state: "stale",
        usedTokens: 75584,
        contextWindow: 258400,
        updatedAt,
      },
      settings: { selected: { model: null, effort: null }, current: { model: null, effort: null } },
    });
    f.version.mockResolvedValue({ reason: "codex-cli-unavailable" });
    expect(await read()).toMatchObject({
      available: false,
      historicalSettings: { modelId: "last-model", effort: "xhigh" },
      historicalUsage: { historical: true, usedTokens: 75584 },
    });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
    expect(readManagedRecord(f.root, f.summary.id)).toBeNull();
  });

  it("preserves native steering and automatically consumed queue operations", async () => {
    const f = fixture();
    await f.send();
    const state = await f.live();
    const base = {
      sessionId: f.summary.id,
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      turnId: "new-turn",
      text: "More",
    };
    expect(
      await f.web.managedControl({ ...base, operation: "steer", requestId: randomUUID() }),
    ).toMatchObject({ accepted: true });
    expect(
      await f.web.managedControl({ ...base, operation: "queue-add", requestId: randomUUID() }),
    ).toMatchObject({ accepted: true });
    expect(f.methods).toContain("turn/steer");
    expect(f.methods).toContain("thread/queue/add");
  });

  it("keeps a missing CLI distinct from an old CLI", async () => {
    const f = fixture();
    f.version.mockResolvedValue({ reason: "codex-cli-unavailable" });
    expect(await f.live()).toMatchObject({ reason: "codex-cli-unavailable", sendEnabled: false });
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "codex-cli-unavailable",
    });
    expect(f.start).not.toHaveBeenCalled();
  });
});

describe("Codex Desktop follow", () => {
  function holdWriterLock(f: ReturnType<typeof fixture>) {
    const directory = path.join(f.home, "thread-writer-locks");
    mkdirSync(directory, { recursive: true });
    const release = acquirePortableFileLease(path.join(directory, `${nativeId}.lock`));
    cleanups.push(release);
    return release;
  }

  function followerFixture(
    options: {
      revision?: number;
      turn?: boolean;
      approval?: boolean;
      question?: boolean;
      settings?: boolean;
      publish?: (
        sessionId: string,
        type: "state" | "text-delta" | "item-upsert" | "snapshot",
        payload: Record<string, unknown>,
        live: Record<string, unknown>,
      ) => void;
    } = {},
  ) {
    const f = fixture(false, undefined, {}, options.publish);
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(true);
    vi.spyOn(codexFollowerLocks, "acquireCodexFollowerOperationLock").mockReturnValue(() => {});
    const release = holdWriterLock(f);
    const turnId = options.turn || options.approval || options.question ? "followed-turn" : null;
    const requests = options.approval
      ? [
          {
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: nativeId,
              turnId: "followed-turn",
              command: "ls",
              cwd: f.workspace,
              availableDecisions: ["accept", "decline"],
            },
          },
        ]
      : options.question
        ? [
            {
              id: "question-1",
              method: "item/tool/requestUserInput",
              params: {
                threadId: nativeId,
                turnId: "followed-turn",
                questions: [
                  {
                    id: "choice",
                    question: "Pick one",
                    options: [{ label: "A" }, { label: "B" }],
                  },
                ],
              },
            },
          ]
        : [];
    const state = new CodexFollowerState(nativeId, "fixture-owner");
    const setSnapshot = (revision = options.revision ?? 1, model = "model-a", effort = "low") =>
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
            revision,
            conversationState: {
              id: nativeId,
              hostId: "local",
              requests,
              threadRuntimeStatus: { type: turnId ? "active" : "idle" },
              turns: turnId ? [{ turnId, status: "inProgress", items: [] }] : [],
              ...(options.settings
                ? {
                    modelProvider: "openai",
                    latestModel: model,
                    latestReasoningEffort: effort,
                    cwd: f.workspace,
                  }
                : {}),
            },
          },
        },
      });
    setSnapshot();
    if (options.settings) {
      f.intercept((method) =>
        method === "config/read" ? { config: { model_provider: "openai" } } : undefined,
      );
      f.setModels([
        {
          model: "model-a",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
        },
        {
          model: "model-b",
          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
          defaultReasoningEffort: "medium",
        },
      ]);
    }
    const bridge = {
      connected: true,
      selectedState: state,
      connection: {
        endpoint: path.join(f.home, "ipc", "ipc.sock"),
        clientId: "fixture-follower",
        settingsCatalogExecutable: options.settings ? path.join(f.bin, "codex") : undefined,
      },
      supportsThreadSettings: options.settings === true,
      observeLive: vi.fn(async () => state),
      refresh: vi.fn(async () => state),
      readModelSettings: vi.fn(async () => state.nativeModelSettings()),
      updateModelSettings: vi.fn<CodexFollowerBridge["updateModelSettings"]>(),
      verifyModelSettings: vi.fn<CodexFollowerBridge["verifyModelSettings"]>(),
      mutate: vi.fn(
        async (
          _method: string,
          _params: Record<string, unknown>,
          _revision: number,
          onDispatch: () => void,
        ) => {
          onDispatch();
          return {};
        },
      ),
      close: vi.fn(() => {
        bridge.connected = false;
      }),
    };
    f.follower.mockResolvedValue(bridge as unknown as CodexFollowerBridge);
    return { f, state, bridge, release, setSnapshot };
  }

  it("projects writable Codex follower model and effort while keeping Fast read-only", async () => {
    const { f, state } = followerFixture({ settings: true });
    expect(
      await f.web.sessionProviderSettingsState({
        operation: "settings-state",
        sessionId: f.summary.id,
      }),
    ).toMatchObject({
      executionMode: "codex-follower",
      writeScope: state.settingsWriteScope,
      revision: 1,
      models: [{ id: "model-a" }, { id: "model-b" }],
      settings: {
        current: { model: "model-a", effort: "low" },
        writable: { model: true, effort: true, serviceTier: false },
      },
    });
    expect(
      await f.web.managedQuery({
        operation: "capabilities",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      }),
    ).toMatchObject({
      features: { settings: { available: true } },
    });
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("thread/start");
  });

  it.each([
    "accepted",
    "declined",
    "readback-failed",
    "ack-missing",
    "stale-scope",
    "fast",
    "unlisted",
    "policy",
    "running",
  ])("uses scoped Codex follower settings receipts for %s", async (scenario) => {
    const { f, state, bridge, setSnapshot } = followerFixture({
      settings: true,
      turn: scenario === "running" || scenario === "policy",
    });
    const live = await f.live();
    bridge.updateModelSettings.mockImplementation(async ({ onDispatch, onApplied, next }) => {
      onDispatch();
      if (scenario === "declined") return false;
      if (scenario === "ack-missing") throw new Error("missing ack");
      onApplied();
      if (scenario === "readback-failed") throw new Error("missing readback");
      setSnapshot(2, next.model, next.effort ?? "low");
      return true;
    });
    const request = {
      operation: "settings",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      expectedSettingsScope: scenario === "stale-scope" ? randomUUID() : state.settingsWriteScope,
      experimentalEnabled: true,
      model: scenario === "unlisted" ? "unknown-model" : "model-b",
      ...(scenario === "fast" ? { serviceTier: "fast" } : {}),
      ...(scenario === "policy" ? { policyId: "full-access-on-request" } : {}),
    };
    if (scenario === "running") {
      expect(
        await f.web.managedQuery({
          operation: "capabilities",
          sessionId: f.summary.id,
          experimentalEnabled: true,
        }),
      ).toMatchObject({ features: { settings: { available: true } } });
    }
    const result = await f.web.managedControl(request);
    if (scenario === "accepted" || scenario === "running") {
      expect(result).toMatchObject({ accepted: true, completed: true, appliesTo: "next-turn" });
      expect(bridge.updateModelSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          next: { model: "model-b", effort: "medium", modelProvider: "openai" },
        }),
      );
      if (scenario === "running") {
        expect(state.status).toBe("running");
        expect(state.activeTurn()).toBe("followed-turn");
      }
    } else if (scenario === "readback-failed" || scenario === "ack-missing") {
      expect(result).toMatchObject({ accepted: false, controlOutcome: "unknown" });
      const pending = readUnknownManagedCommands(f.root, f.summary.id);
      expect(pending).toHaveLength(1);
      if (scenario === "readback-failed")
        expect(pending[0]!.evidence).toHaveProperty("followerSettings");
      else expect(pending[0]!.evidence).not.toHaveProperty("followerSettings");
      setSnapshot(2, "model-b", "medium");
      bridge.verifyModelSettings.mockResolvedValue(true);
      await f.live();
      expect(bridge.verifyModelSettings).toHaveBeenCalledTimes(
        scenario === "readback-failed" ? 1 : 0,
      );
      expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(
        scenario === "readback-failed" ? 0 : 1,
      );
    } else {
      expect(result).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
      expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
      expect(bridge.updateModelSettings).toHaveBeenCalledTimes(scenario === "declined" ? 1 : 0);
    }
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("thread/start");
  });

  it("follows the Codex owner when the writer lock is held", async () => {
    const { f, bridge } = followerFixture({ revision: 7 });
    const live = await f.live();
    expect(live).toMatchObject({
      executionMode: "codex-follower",
      executionLocation: "external",
      ownershipReason: null,
      reason: null,
      sendEnabled: true,
      revision: 7,
      workspaceId: "workspace",
      sessionId: f.summary.id,
    });
    expect(f.follower).toHaveBeenCalledWith(
      path.join(f.home, "ipc", "ipc.sock"),
      nativeId,
      expect.any(Function),
    );
    expect(bridge.observeLive).toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.methods).not.toContain("thread/resume");
  });

  it("tells a lead when a lane's turn in the Codex app waits or ends", async () => {
    const { f, state } = followerFixture({ approval: true, revision: 3 });
    const ended: unknown[] = [];
    const waiting: unknown[] = [];
    f.web.observeLanes({
      turnEnded: (...args) => ended.push(args),
      waiting: (...args) => waiting.push(args),
    });
    expect(await f.live()).toMatchObject({ executionMode: "codex-follower" });
    const publish = f.follower.mock.calls[0]![2] as (snapshot: unknown) => void;
    const change = (revision: number, turns: unknown[], requests: unknown[] = []) => {
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
            revision,
            conversationState: {
              id: nativeId,
              hostId: "local",
              requests,
              threadRuntimeStatus: { type: requests.length ? "active" : "idle" },
              turns,
            },
          },
        },
      });
      publish(state.streamSnapshot());
    };
    const running = [{ turnId: "followed-turn", status: "inProgress", items: [] }];
    // The approval it waits for is told once, however often the Codex app's state changes.
    change(4, running, [
      {
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: nativeId,
          turnId: "followed-turn",
          command: "ls",
          cwd: f.workspace,
          availableDecisions: ["accept", "decline"],
        },
      },
    ]);
    change(5, running, [
      {
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          threadId: nativeId,
          turnId: "followed-turn",
          command: "ls",
          cwd: f.workspace,
          availableDecisions: ["accept", "decline"],
        },
      },
    ]);
    expect(waiting).toEqual([[f.summary.id, "followed-turn", "awaiting-approval"]]);
    change(6, running);
    change(7, [{ turnId: "followed-turn", status: "completed", durationMs: 61_000, items: [] }]);
    change(8, [{ turnId: "followed-turn", status: "completed", durationMs: 61_000, items: [] }]);
    expect(ended).toEqual([[f.summary.id, "followed-turn", "completed", 61_000]]);
  });

  it("keeps the busy choice and backs off when no Codex owner is found", async () => {
    const f = fixture();
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(true);
    holdWriterLock(f);
    f.follower.mockRejectedValue(new CodexDesktopConnectionError("codex-desktop-owner-missing"));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect(await f.live()).toMatchObject({
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      sendEnabled: true,
      ownerWaitAvailable: true,
    });
    expect(f.follower).toHaveBeenCalledTimes(1);
    expect(await f.live()).toMatchObject({ ownershipReason: "codex-owner-busy" });
    expect(f.follower).toHaveBeenCalledTimes(1);
    now += 5_001;
    expect(await f.live()).toMatchObject({ ownershipReason: "codex-owner-busy" });
    expect(f.follower).toHaveBeenCalledTimes(2);
    expect(f.start).not.toHaveBeenCalled();
  });

  it("keeps the busy choice when the platform does not support following", async () => {
    const f = fixture();
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(false);
    holdWriterLock(f);
    expect(await f.live()).toMatchObject({
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      sendEnabled: true,
      ownerWaitAvailable: true,
    });
    expect(f.follower).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  // What Codex's app-server answers a resume while another process writes the thread.
  const activeWriter = () =>
    new CodexAppServerError({
      code: -32600,
      message: `thread ${nativeId} already has an active writer`,
    });

  it("keeps sending open while the Codex app holds the thread with no window on it", async () => {
    const f = fixture();
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(true);
    holdWriterLock(f);
    f.setFailure(activeWriter());
    f.follower.mockRejectedValue(new CodexDesktopConnectionError("codex-desktop-owner-missing"));
    const running = vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(true);
    const open = vi.spyOn(CodexDesktopApp.prototype, "openThread").mockResolvedValue(true);
    expect(await f.live()).toMatchObject({
      executionLocation: "external",
      ownershipReason: "codex-owner-busy",
      sendEnabled: true,
      ownerHandoff: true,
    });
    const capabilities = (await f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.summary.id,
      experimentalEnabled: true,
    })) as { features: Record<string, unknown> };
    expect(capabilities.features).toMatchObject({
      send: { available: true },
      attachments: { available: true },
      settings: { available: false, reason: "codex-owner-busy" },
      "queue-add": { available: false, reason: "codex-owner-busy" },
    });
    // Looking at the session does not move the app's page.
    expect(open).not.toHaveBeenCalled();

    // With no desktop route, the confirmed lock permits one deferred send.
    running.mockResolvedValue(false);
    const busy = await f.live();
    expect(busy).toMatchObject({
      ownershipReason: "codex-owner-busy",
      sendEnabled: true,
      ownerWaitAvailable: true,
    });
    expect(busy).not.toHaveProperty("ownerHandoff");
    const receipt = await f.sendWithState(busy, { deviceId: "desktop-local" });
    expect(receipt).toMatchObject({
      accepted: true,
      status: "waiting-for-owner",
      reason: "codex-waiting-for-owner",
    });
    expect(
      await f.web.managedQueueList({
        operation: "queue-list",
        sessionId: f.summary.id,
      }),
    ).toMatchObject({
      data: [{ id: receipt.requestId, status: "pending", reason: "codex-waiting-for-owner" }],
    });
    expect(open).not.toHaveBeenCalled();
    expect(f.methods).not.toContain("turn/start");
  });

  it("asks the Codex app to show the thread when a message is sent, then sends through it", async () => {
    const { f, bridge } = followerFixture({ revision: 4 });
    f.setFailure(activeWriter());
    let shown = false;
    f.follower.mockImplementation(async () => {
      if (!shown) throw new CodexDesktopConnectionError("codex-desktop-owner-missing");
      return bridge as unknown as CodexFollowerBridge;
    });
    vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(true);
    const open = vi.spyOn(CodexDesktopApp.prototype, "openThread").mockImplementation(async () => {
      shown = true;
      return true;
    });
    const state = await f.live();
    expect(state).toMatchObject({ sendEnabled: true, ownerHandoff: true });
    const requestId = randomUUID();
    expect(await f.sendWithState(state, { requestId })).toMatchObject({ accepted: true });
    expect(open).toHaveBeenCalledExactlyOnceWith(nativeId);
    // The message goes to the app under its own receipt, against the app's revision.
    expect(bridge.mutate).toHaveBeenCalledWith(
      "thread-follower-start-turn",
      {
        conversationId: nativeId,
        turnStart: {
          request: {
            threadId: nativeId,
            clientUserMessageId: requestId,
            input: [{ type: "text", text: "Continue", text_elements: [] }],
          },
        },
      },
      4,
      expect.any(Function),
    );
    expect(f.methods).not.toContain("turn/start");
    const ledger = openManagedLedger(f.root)!;
    try {
      const row = ledger
        .prepare("SELECT evidence FROM managed_commands WHERE request_id=?")
        .get(requestId) as { evidence: string };
      expect(JSON.parse(row.evidence)).toMatchObject({ executionMode: "codex-follower" });
    } finally {
      ledger.close();
    }
    // From now on the session follows the app.
    expect(await f.live()).toMatchObject({
      executionMode: "codex-follower",
      ownershipReason: null,
    });
  });

  it("offers a Worker send an owner handoff before opening a window or starting a writer", async () => {
    const { f, bridge } = followerFixture({ revision: 4 });
    let shown = false;
    f.follower.mockImplementation(async () => {
      if (!shown) throw new CodexDesktopConnectionError("codex-desktop-owner-missing");
      return bridge as unknown as CodexFollowerBridge;
    });
    vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(true);
    const open = vi.spyOn(CodexDesktopApp.prototype, "openThread").mockImplementation(async () => {
      shown = true;
      return true;
    });
    const provider = f.web.codexSessionProvider() as CodexSessionProvider;
    const state = await provider.workerLive(f.summary.id, true, "send");
    expect(state).toMatchObject({
      ownershipReason: "codex-owner-busy",
      sendEnabled: true,
      ownerHandoff: true,
    });
    expect(open).not.toHaveBeenCalled();
    const requestId = randomUUID();
    expect(
      await provider.workerDesktopSend({
        operation: "send",
        sessionId: f.summary.id,
        requestId,
        deviceId: "fixture-worker-lead",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        text: "Continue",
      }),
    ).toMatchObject({ accepted: true });
    expect(open).toHaveBeenCalledExactlyOnceWith(nativeId);
    expect(bridge.mutate).toHaveBeenCalledExactlyOnceWith(
      "thread-follower-start-turn",
      {
        conversationId: nativeId,
        turnStart: {
          request: {
            threadId: nativeId,
            clientUserMessageId: requestId,
            input: [{ type: "text", text: "Continue", text_elements: [] }],
          },
        },
      },
      4,
      expect.any(Function),
    );
    expect(f.start).not.toHaveBeenCalled();
  });

  it("queues without dispatching when the Codex app does not take the thread", async () => {
    const f = fixture(false, undefined, { AGENTKIB_CODEX_HANDOFF_TIMEOUT_MS: "600" });
    vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(true);
    holdWriterLock(f);
    f.setFailure(activeWriter());
    f.follower.mockRejectedValue(new CodexDesktopConnectionError("codex-desktop-owner-missing"));
    vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(true);
    const open = vi.spyOn(CodexDesktopApp.prototype, "openThread").mockResolvedValue(true);
    const state = await f.live();
    expect(state).toMatchObject({ ownerHandoff: true });
    expect(
      await f.sendWithState(state, { requestId: randomUUID(), deviceId: "desktop-local" }),
    ).toMatchObject({
      accepted: true,
      status: "waiting-for-owner",
      reason: "codex-waiting-for-owner",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(f.methods).not.toContain("turn/start");
    // The waiting message occupies the one available slot.
    const after = await f.live();
    expect(after).toMatchObject({ ownershipReason: "codex-owner-busy", sendEnabled: false });
    expect(after).not.toHaveProperty("ownerHandoff");
  });

  it("forwards a send to the owner instead of resuming", async () => {
    const { f, bridge } = followerFixture({ revision: 3 });
    const state = await f.live();
    const requestId = randomUUID();
    expect(await f.sendWithState(state, { requestId })).toMatchObject({ accepted: true });
    expect(bridge.mutate).toHaveBeenCalledWith(
      "thread-follower-start-turn",
      {
        conversationId: nativeId,
        turnStart: {
          request: {
            threadId: nativeId,
            clientUserMessageId: requestId,
            input: [{ type: "text", text: "Continue", text_elements: [] }],
          },
        },
      },
      3,
      expect.any(Function),
    );
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
    expect(f.start).not.toHaveBeenCalled();
    const ledger = openManagedLedger(f.root)!;
    try {
      const row = ledger
        .prepare("SELECT evidence FROM managed_commands WHERE request_id=?")
        .get(requestId) as { evidence: string };
      expect(JSON.parse(row.evidence)).toMatchObject({
        executionMode: "codex-follower",
        workspaceId: "workspace",
      });
    } finally {
      ledger.close();
    }
  });

  it("hands the owner an image as a local file, as AgentKib's own runner does", async () => {
    const { f, bridge } = followerFixture({ revision: 3 });
    const state = await f.live();
    const image = path.join(realpathSync(f.root), "shot.png");
    writeFileSync(image, "png bytes");
    const requestId = randomUUID();
    const input = [
      { type: "text", text: "What is in this picture?", text_elements: [] },
      { type: "localImage", path: image },
    ];
    expect(await f.sendWithState(state, { requestId, text: undefined, input })).toMatchObject({
      accepted: true,
    });
    expect(bridge.mutate).toHaveBeenCalledWith(
      "thread-follower-start-turn",
      {
        conversationId: nativeId,
        turnStart: { request: { threadId: nativeId, clientUserMessageId: requestId, input } },
      },
      3,
      expect.any(Function),
    );
    expect(f.start).not.toHaveBeenCalled();
  });

  it("forwards a stop to the owner during a followed turn", async () => {
    const { f, bridge } = followerFixture({ revision: 2, turn: true });
    const state = await f.live();
    expect(state).toMatchObject({ status: "running", turnId: "followed-turn" });
    // While the owner runs a turn, an image waits with the message: neither can go yet.
    const running = (await f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.summary.id,
      experimentalEnabled: true,
    })) as { features: Record<string, { available: boolean; reason?: string }> };
    expect(running.features.send?.available).toBe(false);
    expect(running.features.attachments).toEqual(running.features.send);
    bridge.mutate.mockImplementation(async (_m, _p, _r, onDispatch: () => void) => {
      onDispatch();
      return { ok: true, interruptedTurnId: "followed-turn" };
    });
    const result = await f.web.managedControl({
      operation: "stop",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      turnId: "followed-turn",
    });
    expect(result).toMatchObject({ accepted: true });
    expect(bridge.mutate).toHaveBeenCalledWith(
      "thread-follower-interrupt-turn",
      { conversationId: nativeId, mode: "user-stop", expectedTurnId: "followed-turn" },
      2,
      expect.any(Function),
    );
    expect(f.start).not.toHaveBeenCalled();
  });

  it("forwards an approval decision to the owner", async () => {
    const { f, bridge } = followerFixture({ revision: 4, approval: true });
    const state = await f.live();
    expect(state).toMatchObject({ status: "awaiting-approval" });
    const result = await f.web.managedControl({
      operation: "approve",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      turnId: "followed-turn",
      approvalId: "approval-1",
      decision: "accept",
    });
    expect(result).toMatchObject({ accepted: true });
    expect(bridge.mutate).toHaveBeenCalledWith(
      "thread-follower-command-approval-decision",
      { conversationId: nativeId, requestId: "approval-1", decision: "accept" },
      4,
      expect.any(Function),
    );
    expect(f.start).not.toHaveBeenCalled();
  });

  it.each(["settings", "rename", "compact", "steer", "answer"])(
    "rejects %s while following without dispatching",
    async (operation) => {
      const { f, bridge } = followerFixture({ revision: 5 });
      const state = await f.live();
      const result = await f.web.managedControl({
        operation,
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        turnId: "followed-turn",
      });
      expect(result).toMatchObject({
        controlOutcome: "not-dispatched",
        reason: "follower-operation-unverified",
      });
      expect(bridge.mutate).not.toHaveBeenCalled();
      expect(f.start).not.toHaveBeenCalled();
      expect(f.methods).not.toContain("thread/resume");
    },
  );

  it("rejects a stale expected revision while following", async () => {
    const { f, bridge } = followerFixture({ revision: 2 });
    const state = await f.live();
    const result = await f.sendWithState({
      revision: 1,
      runtimeBootId: state.runtimeBootId,
    } as Awaited<ReturnType<typeof f.live>>);
    expect(result).toMatchObject({ controlOutcome: "not-dispatched" });
    expect(bridge.mutate).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
  });

  it("returns to the managed path once the owner releases the lock", async () => {
    const { f, bridge, release } = followerFixture();
    await f.live();
    expect(f.follower).toHaveBeenCalledTimes(1);
    bridge.connected = false;
    bridge.observeLive.mockRejectedValue(new Error("Codex session owner changed"));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    expect(await f.live()).toMatchObject({ ownershipReason: "codex-owner-busy" });
    expect(bridge.close).toHaveBeenCalled();
    now += 4_001;
    // The owner went away: the writer lock frees and AgentKib manages again.
    release();
    expect(await f.live()).toMatchObject({
      executionLocation: null,
      sendEnabled: true,
      ownershipReason: null,
    });
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods).toContain("thread/resume");
    expect(f.methods).toContain("turn/start");
  });

  it("resumes through the native writer after ownership release while the cached follower is live", async () => {
    const { f, bridge, release } = followerFixture({ revision: 7 });
    expect(await f.live()).toMatchObject({
      executionMode: "codex-follower",
      revision: 7,
      sendEnabled: true,
    });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    release();
    now += 4_001;
    expect(bridge.connected).toBe(true);
    const state = await f.live();
    expect(state).toMatchObject({ executionMode: "codex-managed", sendEnabled: true });
    expect(await f.sendWithState(state)).toMatchObject({ accepted: true });
    expect(bridge.mutate).not.toHaveBeenCalled();
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("disables follower sending after the Desktop owner takes over a staged Plan", async () => {
    const { f, bridge, release } = followerFixture({ revision: 7 });
    release();
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const inactive = await f.live();
    expect(inactive).toMatchObject({ executionMode: "codex-managed", sendEnabled: true });
    expect(
      await f.web.managedControl({
        operation: "settings",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: inactive.runtimeBootId,
        expectedRevision: inactive.revision,
        experimentalEnabled: true,
        mode: "plan",
      }),
    ).toMatchObject({ accepted: true });
    holdWriterLock(f);
    now += 4_001;
    const state = await f.live();
    expect(state).toMatchObject({
      executionMode: "codex-follower",
      sendEnabled: false,
      revision: 7,
    });
    const capabilities = await f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.summary.id,
      experimentalEnabled: true,
    });
    expect(capabilities).toMatchObject({
      executionMode: "codex-follower",
      features: { send: { available: false, reason: "codex-owner-busy" } },
    });
    expect(await f.sendWithState(state)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "codex-owner-busy",
    });
    expect(bridge.mutate).not.toHaveBeenCalled();
    expect(f.methods).not.toContain("thread/resume");
    expect(f.methods).not.toContain("turn/start");
  });

  it("projects follower capabilities", async () => {
    const { f } = followerFixture();
    await f.live();
    const capabilities = (await f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.summary.id,
      experimentalEnabled: true,
    })) as {
      executionMode: string;
      features: Record<string, { available: boolean; reason?: string }>;
    };
    expect(capabilities).toMatchObject({
      executionMode: "codex-follower",
      executionLocation: "external",
      ownershipReason: null,
    });
    expect(capabilities.features.send).toEqual({ available: true });
    // Images go with a message the owner starts a turn from.
    expect(capabilities.features.attachments).toEqual({ available: true });
    expect(capabilities.features.stop).toEqual({
      available: false,
      reason: "no-active-turn",
    });
    expect(capabilities.features.approve).toEqual({
      available: false,
      reason: "no-supported-approval",
    });
    expect(capabilities.features.fork).toEqual({ available: true });
    expect(capabilities.features.delete).toEqual({
      available: false,
      reason: "codex-owner-busy",
    });
    for (const operation of [
      "answer",
      "resume",
      "steer",
      "queue-add",
      "rename",
      "archive",
      "settings",
      "compact",
      "goal-set",
      "terminals-clean",
    ])
      expect(capabilities.features[operation]).toEqual({
        available: false,
        reason: "follower-operation-unverified",
      });
    expect(capabilities.features["settings-state"]).toEqual({ available: true });
    expect(capabilities.features.goal).toEqual({ available: true });
    expect(capabilities.features.resources).toEqual({ available: true });
  });

  it("retires an unwatched follower and reconnects on the next live", async () => {
    vi.useFakeTimers();
    const { f, bridge } = followerFixture();
    await f.live();
    expect(f.follower).toHaveBeenCalledTimes(1);
    f.leave();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(bridge.close).toHaveBeenCalled();
    f.observe();
    await f.live();
    expect(f.follower).toHaveBeenCalledTimes(2);
  });

  it("marks a dispatched follower send unknown and reconciles it from the thread", async () => {
    const { f, bridge } = followerFixture({ revision: 2 });
    const state = await f.live();
    const requestId = randomUUID();
    bridge.mutate.mockImplementation(async (_m, _p, _r, onDispatch: () => void) => {
      onDispatch();
      throw new Error("Codex IPC disconnected");
    });
    expect(await f.sendWithState(state, { requestId })).toMatchObject({
      controlOutcome: "unknown",
      reason: "control-outcome-unconfirmed",
    });
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
    });
    f.setReadTurns([
      {
        id: "followed-turn",
        status: "completed",
        items: [{ type: "userMessage", clientId: requestId }],
      },
    ]);
    expect(
      await f.web.managedReconcile({
        operation: "reconcile",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
      }),
    ).toMatchObject({ reconciled: true });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
  });

  it("reconciles an unknown follower approval once the owner drops the request", async () => {
    const { f, state, bridge } = followerFixture({ revision: 6, approval: true });
    const live = await f.live();
    const requestId = randomUUID();
    bridge.mutate.mockImplementation(async (_m, _p, _r, onDispatch: () => void) => {
      onDispatch();
      throw new Error("Codex IPC disconnected");
    });
    const result = await f.web.managedControl({
      operation: "approve",
      sessionId: f.summary.id,
      requestId,
      deviceId: "fixture",
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      turnId: "followed-turn",
      approvalId: "approval-1",
      decision: "accept",
    });
    expect(result).toMatchObject({ controlOutcome: "unknown" });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(1);
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
          revision: 7,
          conversationState: {
            id: nativeId,
            hostId: "local",
            requests: [],
            threadRuntimeStatus: { type: "idle" },
            turns: [{ turnId: "followed-turn", status: "completed", items: [] }],
          },
        },
      },
    });
    expect(
      await f.web.managedQuery({
        operation: "inspect",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      }),
    ).toMatchObject({ reconciled: true });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
  });

  it("forks while following using the follower revision", async () => {
    const { f, bridge } = followerFixture({ revision: 9 });
    const state = await f.live();
    const result = await f.web.managedControl({
      operation: "fork",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
    });
    expect(result).toMatchObject({ accepted: true, sourceSessionId: f.summary.id });
    expect(f.methods).toContain("thread/read");
    expect(f.methods).toContain("thread/fork");
    expect(f.methods).not.toContain("thread/resume");
    expect(bridge.mutate).not.toHaveBeenCalled();
  });

  it("rejects a fork with a stale follower revision", async () => {
    const { f, bridge } = followerFixture({ revision: 9 });
    const state = await f.live();
    const result = await f.web.managedControl({
      operation: "fork",
      sessionId: f.summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: 1,
      experimentalEnabled: true,
    });
    expect(result).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "stale-or-disabled-control",
    });
    expect(bridge.mutate).not.toHaveBeenCalled();
    expect(f.methods).not.toContain("thread/fork");
  });

  it("projects followed user-input requests as unsupported", async () => {
    const { f } = followerFixture({ revision: 3, question: true });
    const live = await f.live();
    expect(live).toMatchObject({ status: "waiting-input" });
    expect((live.questions as Array<Record<string, unknown>>)[0]).toMatchObject({
      supported: false,
    });
    const capabilities = (await f.web.managedQuery({
      operation: "capabilities",
      sessionId: f.summary.id,
      experimentalEnabled: true,
    })) as { features: Record<string, { available: boolean; reason?: string }> };
    expect(capabilities.features.answer).toEqual({
      available: false,
      reason: "follower-operation-unverified",
    });
  });

  it("publishes followed messages by identity without concatenated fallback text", async () => {
    const publish = vi.fn();
    const { f } = followerFixture({ publish, turn: true });
    await f.live();
    const states = publish.mock.calls.filter((call) => call[1] === "state");
    expect(states.length).toBeGreaterThan(0);
    for (const [, , payload] of states) {
      expect(payload).toMatchObject({ executionMode: "codex-follower" });
      expect(payload).not.toHaveProperty("items");
    }
    expect(publish.mock.calls.some((call) => call[1] === "snapshot")).toBe(false);
    const onSnapshot = f.follower.mock.calls[0]![2]!;
    publish.mockClear();
    onSnapshot({
      live: { streamText: "partial" },
      items: [
        {
          id: "desktop-user-item",
          kind: "user-message",
          turn_id: "followed-turn",
          content: "x",
        },
        {
          id: "desktop-agent-item",
          kind: "agent-message",
          turn_id: "followed-turn",
          content: "partial",
          ephemeral: true,
        },
      ],
    });
    const updates = publish.mock.calls.filter((call) => call[1] === "state");
    expect(updates.length).toBeGreaterThan(0);
    const last = updates.at(-1)![2] as Record<string, unknown>;
    expect(last.streamText).toBe("");
    expect(last).not.toHaveProperty("items");
    expect(publish.mock.calls.filter((call) => call[1] === "item-upsert")).toEqual([
      [
        f.summary.id,
        "item-upsert",
        expect.objectContaining({
          id: "desktop-agent-item",
          content: "partial",
        }),
        expect.objectContaining({ streamText: "" }),
        undefined,
      ],
    ]);
    expect(publish.mock.calls.some((call) => call[1] === "snapshot")).toBe(false);
  });
});

describe("a managed Codex turn that meets the usage limit", () => {
  // Codex 0.167.0's own shapes: the final `error` and the failed turn carry
  // `codexErrorInfo: "usageLimitExceeded"` and no reset time; `account/rateLimits/read` has the
  // account's windows, `resetsAt` in seconds.
  const message =
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again at 3:05 PM.";
  const limitError = { message, codexErrorInfo: "usageLimitExceeded" };
  function meetLimit(f: ReturnType<typeof fixture>) {
    const server = f.servers.at(-1)!;
    server.emit("notification", {
      method: "error",
      params: { threadId: nativeId, turnId: "new-turn", willRetry: false, error: limitError },
    });
    server.complete({ status: "failed", error: limitError });
  }
  const windows = (resetsAt: number) => ({
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
      secondary: { usedPercent: 41, windowDurationMins: 10080, resetsAt: resetsAt + 86_400 },
      planType: "plus",
    },
  });

  afterEach(() => vi.useRealTimers());

  const features = async (f: ReturnType<typeof fixture>) =>
    (
      (await f.web.managedQuery({
        operation: "capabilities",
        sessionId: f.summary.id,
        experimentalEnabled: true,
      })) as { features: Record<string, { available: boolean; reason?: string }> }
    ).features;

  it("stays usable, says when the limit resets, and continues on its own after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    vi.spyOn(Math, "random").mockReturnValue(0);
    const f = fixture();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    f.setRateLimits(windows(resetsAt));
    expect(await f.send()).toMatchObject({ accepted: true });
    meetLimit(f);
    await vi.waitFor(async () =>
      expect(await f.live()).toMatchObject({
        status: "idle",
        sendEnabled: true,
        usageLimit: {
          agent: "codex",
          resetsAt: resetsAt * 1000,
          kind: "five-hour",
          continueAt: resetsAt * 1000 + 30_000,
          manual: null,
          message,
        },
      }),
    );
    expect((await features(f))["usage-limit-cancel"]).toEqual({ available: true });
    const starts = () => f.requests.filter(({ method }) => method === "turn/start");
    expect(starts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3600_000 + 30_000);
    await vi.waitFor(() => expect(starts()).toHaveLength(2));
    expect(JSON.stringify(starts().at(-1)!.params)).toContain(AUTO_CONTINUE_TEXT.codex);
    await vi.waitFor(async () =>
      expect((await f.live()).usageLimit).toMatchObject({ continueAt: null, autoContinues: 1 }),
    );
    // The continue went through: the limit is over.
    f.servers.at(-1)!.complete();
    await vi.waitFor(async () => expect((await f.live()).usageLimit ?? null).toBeNull());
  });

  it("gives way to the person's message, and can be turned off", async () => {
    const f = fixture();
    f.setRateLimits(windows(Math.floor(Date.now() / 1000) + 3600));
    await f.send();
    meetLimit(f);
    await vi.waitFor(async () =>
      expect((await f.live()).usageLimit).toMatchObject({ manual: null }),
    );
    const state = await f.live();
    expect(
      await f.web.managedControl({
        operation: "usage-limit-cancel",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
      }),
    ).toMatchObject({ accepted: true, completed: true });
    expect((await f.live()).usageLimit).toMatchObject({ continueAt: null, manual: "cancelled" });
    expect((await features(f))["usage-limit-cancel"]?.available).toBe(false);
    // And on again, for this time.
    expect((await features(f))["usage-limit-continue"]).toEqual({ available: true });
    const again = await f.live();
    expect(
      await f.web.managedControl({
        operation: "usage-limit-continue",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: again.runtimeBootId,
        expectedRevision: again.revision,
        experimentalEnabled: true,
      }),
    ).toMatchObject({ accepted: true, completed: true });
    expect((await f.live()).usageLimit).toMatchObject({ manual: null, autoContinues: 0 });
    expect(typeof (await f.live()).usageLimit?.continueAt).toBe("number");
    await f.send();
    expect((await f.live()).usageLimit ?? null).toBeNull();
  });

  it("says try again later when Codex cannot read the account's limits", async () => {
    const f = fixture();
    await f.send();
    meetLimit(f);
    await vi.waitFor(async () =>
      expect((await f.live()).usageLimit).toMatchObject({
        resetsAt: null,
        continueAt: null,
        manual: "reset-unknown",
      }),
    );
  });
});

describe("a managed Codex thread without a name", () => {
  const namingThread = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";
  const preview = "Fix the flaky upload test in CI";
  const answer = '{"title":"Fix flaky upload test"}';
  type Emit = (method: string, params: Record<string, unknown>) => void;
  type Script = {
    /** The name Codex has for the session's thread; null when it has none. */
    name?: string | null;
    /** The final agent message of the title's turn. */
    answer?: string;
    /** How the title's turn ends, over a completed one. */
    end?: Record<string, unknown>;
    /** Nothing of the title's turn shows before this settles. */
    hold?: Promise<unknown>;
    /** What else the title's turn sends before its answer. */
    during?: (emit: Emit, server: EventEmitter) => void;
  };

  /**
   * Codex 0.167.0's side: the session's thread as `thread/read` shows it, the temporary thread
   * that names it with its one turn, and the name the thread gets.
   */
  function codexNames(f: ReturnType<typeof fixture>, script: Script = {}) {
    const thread = { name: script.name === undefined ? null : script.name };
    f.intercept((method, params, server) => {
      if (method === "thread/read" && params.threadId === nativeId)
        return {
          thread: {
            id: nativeId,
            name: thread.name,
            preview,
            model: "model-a",
            ephemeral: false,
            status: { type: "active", activeFlags: [] },
            turns: [],
          },
        };
      // The person's config.toml for this directory, with two MCP servers.
      if (method === "config/read")
        return {
          config: {
            model: "model-a",
            mcp_servers: {
              linear: { url: "https://mcp.linear.app/mcp" },
              docs: { command: "docs-mcp", args: ["--stdio"] },
            },
          },
          origins: {},
          layers: null,
        };
      if (method === "thread/start" && params.ephemeral === true)
        return {
          thread: {
            id: namingThread,
            name: null,
            preview: "",
            ephemeral: true,
            status: { type: "idle" },
            turns: [],
          },
          cwd: params.cwd,
          model: params.model,
          reasoningEffort: null,
          approvalPolicy: "never",
          sandbox: { type: "readOnly", networkAccess: false },
        };
      if (method === "turn/start" && params.threadId === namingThread) {
        const emit: Emit = (name, values) =>
          server.emit("notification", {
            method: name,
            params: { threadId: namingThread, ...values },
          });
        void (async () => {
          await script.hold;
          await new Promise((resolve) => setTimeout(resolve, 0));
          const turn = { id: "naming-turn", items: [] };
          emit("turn/started", { turn: { ...turn, status: "inProgress" } });
          // The prompt is the thread's user message: no client ID, as a person's in Codex.
          emit("item/started", {
            turnId: turn.id,
            item: {
              type: "userMessage",
              id: "naming-prompt",
              clientId: null,
              content: params.input,
            },
          });
          script.during?.(emit, server);
          const text = script.answer ?? answer;
          emit("item/agentMessage/delta", {
            turnId: turn.id,
            itemId: "naming-answer",
            delta: text,
          });
          emit("item/completed", {
            turnId: turn.id,
            item: { type: "agentMessage", id: "naming-answer", text, phase: "final_answer" },
          });
          const usage = { totalTokens: 1_200, inputTokens: 1_100, outputTokens: 100 };
          emit("thread/tokenUsage/updated", {
            turnId: turn.id,
            tokenUsage: { total: usage, last: usage, modelContextWindow: 272_000 },
          });
          emit("turn/completed", {
            turn: { ...turn, status: "completed", durationMs: 900, ...script.end },
          });
        })();
        return { turn: { id: "naming-turn", status: "inProgress", items: [] } };
      }
      if (method === "thread/unsubscribe") return { status: "unsubscribed" };
      if (method === "thread/name/set") {
        thread.name = String(params.name);
        return {};
      }
      return undefined;
    });
    return thread;
  }

  /** The person's message starts the session's turn, as Codex shows it. */
  function personWrites(f: ReturnType<typeof fixture>, text = "Continue") {
    const server = f.servers.at(-1)!;
    server.emit("notification", {
      method: "turn/started",
      params: { threadId: nativeId, turn: { id: "new-turn", status: "inProgress", items: [] } },
    });
    server.emit("notification", {
      method: "item/started",
      params: {
        threadId: nativeId,
        turnId: "new-turn",
        item: {
          type: "userMessage",
          id: "person-message",
          clientId: "person",
          content: [{ type: "text", text }],
        },
      },
    });
  }

  const sent = (f: ReturnType<typeof fixture>, method: string) =>
    f.requests
      .filter((request) => request.method === method)
      .map((request) => request.params as Record<string, unknown>);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const withLuna = [
    { model: "model-a", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
    {
      model: "gpt-5.6-luna",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }],
    },
  ];

  it("gets the title Codex's terminal client would give it, once", async () => {
    const f = fixture();
    f.setModels(withLuna);
    const thread = codexNames(f);
    expect(await f.send()).toMatchObject({ accepted: true });
    personWrites(f);
    await vi.waitFor(() => expect(thread.name).toBe("Fix flaky upload test"));
    // The TUI's temporary thread: kept by nothing, read-only, never asking, and with nothing to
    // run: no tools, hooks or plugins, and none of the person's MCP servers.
    expect(sent(f, "config/read")).toEqual([{ includeLayers: false, cwd: f.workspace }]);
    expect(sent(f, "thread/start")).toEqual([
      {
        cwd: f.workspace,
        model: "gpt-5.6-luna",
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        threadSource: "thread_title",
        config: {
          ...Object.fromEntries(
            [
              "apps",
              "code_mode",
              "code_mode_only",
              "context_management",
              "current_time_reminder",
              "deferred_executor",
              "enable_fanout",
              "goals",
              "hooks",
              "image_generation",
              "memories",
              "multi_agent",
              "multi_agent_v2",
              "plugins",
              "request_permissions_tool",
              "shell_snapshot",
              "shell_tool",
              "standalone_web_search",
              "token_budget",
              "tool_suggest",
              "unified_exec",
              "view_image",
            ].map((feature) => [`features.${feature}`, false]),
          ),
          "cloud.skills.enabled": false,
          "skills.include_instructions": false,
          "tools.experimental_request_user_input.enabled": false,
          "tools.update_plan.enabled": false,
          web_search: "disabled",
          default_permissions: ":read-only",
          mcp_servers: { docs: { enabled: false }, linear: { enabled: false } },
        },
      },
    ]);
    const turn = sent(f, "turn/start").find((params) => params.threadId === namingThread);
    expect(turn).toEqual({
      threadId: namingThread,
      input: [{ type: "text", text: threadTitlePrompt(preview) }],
      outputSchema: {
        type: "object",
        properties: { title: { type: "string", minLength: 1, maxLength: 36 } },
        required: ["title"],
        additionalProperties: false,
      },
      effort: "low",
    });
    expect(threadTitlePrompt(preview)).toBe(
      "Generate a concise, single-line task title of at most 36 characters and under five " +
        "words where possible. Start with an imperative verb. Capitalize only the first word " +
        "unless the user's language, proper nouns, acronyms, or code terms require otherwise. " +
        "Preserve ticket references exactly. Write in the user's language. Do not use quotes, " +
        "markdown, or trailing punctuation. Do not answer the request.\n\nUser prompt:\n" +
        preview,
    );
    expect(sent(f, "thread/unsubscribe")).toEqual([{ threadId: namingThread }]);
    expect(sent(f, "thread/name/set")).toEqual([
      { threadId: nativeId, name: "Fix flaky upload test" },
    ]);
    await vi.waitFor(() => expect(f.catalogChanged).toHaveBeenCalled());
    // Not again while AgentKib runs, even for a thread that lost its name.
    f.servers.at(-1)!.complete();
    await vi.waitFor(async () => expect((await f.live()).status).toBe("idle"));
    thread.name = null;
    expect(await f.send({ text: "And the docs" })).toMatchObject({ accepted: true });
    personWrites(f, "And the docs");
    await settle();
    expect(sent(f, "thread/start")).toHaveLength(1);
    expect(sent(f, "thread/name/set")).toHaveLength(1);
  });

  it("uses the session's own model at its lowest effort without the title model", async () => {
    const f = fixture();
    f.setModels([
      {
        model: "model-a",
        isDefault: true,
        supportedReasoningEfforts: ["medium", "low", "minimal"].map((reasoningEffort) => ({
          reasoningEffort,
        })),
      },
    ]);
    const thread = codexNames(f);
    await f.send();
    personWrites(f);
    await vi.waitFor(() => expect(thread.name).toBe("Fix flaky upload test"));
    expect(sent(f, "thread/start")[0]).toMatchObject({ model: "model-a" });
    expect(sent(f, "turn/start").find((params) => params.threadId === namingThread)).toMatchObject({
      effort: "minimal",
    });
  });

  it("keeps the name the thread has", async () => {
    const f = fixture();
    const thread = codexNames(f, { name: "Upload test fix" });
    await f.send();
    personWrites(f);
    await vi.waitFor(() => expect(sent(f, "thread/read")).toHaveLength(1));
    await settle();
    expect(sent(f, "thread/start")).toEqual([]);
    expect(sent(f, "thread/name/set")).toEqual([]);
    expect(thread.name).toBe("Upload test fix");
  });

  it("keeps a name the thread gets while its title is made", async () => {
    const f = fixture();
    let release!: () => void;
    const thread = codexNames(f, { hold: new Promise<void>((resolve) => (release = resolve)) });
    await f.send();
    personWrites(f);
    await vi.waitFor(() => expect(sent(f, "turn/start")).toHaveLength(2));
    // The person renames the thread in AgentKib once the turn ends.
    f.servers.at(-1)!.complete();
    await vi.waitFor(async () => expect((await f.live()).status).toBe("idle"));
    const state = await f.live();
    expect(
      await f.web.managedControl({
        operation: "rename",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
        runtimeBootId: state.runtimeBootId,
        expectedRevision: state.revision,
        experimentalEnabled: true,
        name: "Upload fixes",
      }),
    ).toMatchObject({ accepted: true });
    release();
    await vi.waitFor(() => expect(sent(f, "thread/unsubscribe")).toHaveLength(1));
    await settle();
    expect(sent(f, "thread/name/set")).toEqual([{ threadId: nativeId, name: "Upload fixes" }]);
    expect(thread.name).toBe("Upload fixes");
  });

  it("keeps Codex's own title when the title's turn fails, without a usage limit", async () => {
    const f = fixture();
    // Codex 0.167.0's shapes when the account is out of usage.
    const limit = { message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" };
    const thread = codexNames(f, {
      during: (emit) => emit("error", { turnId: "naming-turn", willRetry: false, error: limit }),
      end: { status: "failed", error: limit },
    });
    expect(await f.send()).toMatchObject({ accepted: true });
    personWrites(f);
    await vi.waitFor(() => expect(sent(f, "thread/unsubscribe")).toHaveLength(1));
    await settle();
    expect(thread.name).toBeNull();
    expect(sent(f, "thread/name/set")).toEqual([]);
    expect(f.web.usageLimited(f.summary.id)).toBe(false);
    expect(await f.live()).toMatchObject({
      status: "running",
      turnId: "new-turn",
      reason: null,
      usageLimit: null,
    });
    // The session's own turn ends as usual; nothing waits for a reset.
    f.servers.at(-1)!.complete();
    await vi.waitFor(async () =>
      expect(await f.live()).toMatchObject({ status: "idle", sendEnabled: true, usageLimit: null }),
    );
    expect(f.web.usageLimited(f.summary.id)).toBe(false);
    expect(sent(f, "account/rateLimits/read")).toEqual([]);
  });

  it("keeps Codex's own title when the answer is not a title", async () => {
    const f = fixture();
    const thread = codexNames(f, { answer: "Fix flaky upload test" });
    await f.send();
    personWrites(f);
    await vi.waitFor(() => expect(sent(f, "thread/unsubscribe")).toHaveLength(1));
    await settle();
    expect(thread.name).toBeNull();
    expect(sent(f, "thread/name/set")).toEqual([]);
  });

  it("keeps the temporary thread's turn out of the session", async () => {
    const published: unknown[][] = [];
    const f = fixture(false, undefined, {}, (...args) => published.push(args));
    const lanes = { turnEnded: vi.fn(), waiting: vi.fn(), ownTurn: vi.fn(), limitEnded: vi.fn() };
    f.web.observeLanes(lanes);
    let release!: () => void;
    const thread = codexNames(f, {
      hold: new Promise<void>((resolve) => (release = resolve)),
      // It asks for something, as an MCP server's form: declined at once.
      during: (_emit, server) =>
        server.emit("serverRequest", {
          id: 91,
          method: "mcpServer/elicitation/request",
          params: {
            threadId: namingThread,
            turnId: "naming-turn",
            serverName: "docs",
            mode: "form",
            message: "Allow the docs server?",
            requestedSchema: { type: "object", properties: {} },
          },
        }),
    });
    await f.send();
    const server = f.servers.at(-1)!;
    const respond = vi.spyOn(server, "respond");
    personWrites(f);
    const before = await f.live();
    release();
    await vi.waitFor(() => expect(thread.name).toBe("Fix flaky upload test"));
    const after = await f.live();
    expect(after.revision).toBe(before.revision);
    expect(after).toMatchObject({
      status: "running",
      turnId: "new-turn",
      approvals: [],
      streamText: "",
      tokenUsage: null,
    });
    expect(respond).toHaveBeenCalledWith(91, { action: "decline" });
    expect(lanes.ownTurn).not.toHaveBeenCalled();
    expect(lanes.waiting).not.toHaveBeenCalled();
    expect(lanes.turnEnded).not.toHaveBeenCalled();
    expect(JSON.stringify(published)).not.toMatch(/naming-|Fix flaky upload test/);
    // The session's own turn ends with its own rows only.
    server.emit("notification", {
      method: "item/completed",
      params: {
        threadId: nativeId,
        turnId: "new-turn",
        item: { type: "agentMessage", id: "reply", text: "Done." },
      },
    });
    server.complete();
    await vi.waitFor(() =>
      expect(lanes.turnEnded).toHaveBeenCalledWith(f.summary.id, "new-turn", "completed", null),
    );
    expect(lanes.turnEnded).toHaveBeenCalledTimes(1);
    expect(
      readManagedEvents(f.root, f.summary.id, null, 100).events.map((event) => event.id),
    ).toEqual(["reply"]);
  });

  it("stops a title turn that does not end in time, and never touches the session's thread", async () => {
    const calls: Array<[string, unknown]> = [];
    let reply: (method: string) => unknown = () => ({});
    const session = Object.assign(new EventEmitter(), {
      connected: true,
      request: async (method: string, params: unknown) => {
        calls.push([method, params]);
        return reply(method);
      },
      respond: vi.fn(),
      respondError: vi.fn(),
    });
    const titles = new CodexTitleThreads();
    const generate = () =>
      titles.generate(session as unknown as CodexAppServerSession, {
        threadId: nativeId,
        cwd: "/work",
        model: "gpt-5.6-luna",
        effort: "low",
        message: "Fix the upload test",
        timeoutMs: 30,
      });
    const started = (thread: Record<string, unknown>) => (method: string) =>
      method === "config/read"
        ? { config: { model: null }, origins: {}, layers: null }
        : method === "thread/start"
          ? { thread, sandbox: { type: "readOnly", networkAccess: false } }
          : method === "turn/start"
            ? { turn: { id: "naming-turn", status: "inProgress" } }
            : {};
    reply = started({ id: namingThread, ephemeral: true });
    expect(await generate()).toBeNull();
    expect(calls).toEqual([
      ["config/read", { includeLayers: false, cwd: "/work" }],
      [
        "thread/start",
        expect.objectContaining({
          ephemeral: true,
          config: expect.objectContaining({ "features.shell_tool": false, mcp_servers: {} }),
        }),
      ],
      ["turn/start", expect.objectContaining({ threadId: namingThread })],
      ["turn/interrupt", { threadId: namingThread, turnId: "naming-turn" }],
      ["thread/unsubscribe", { threadId: namingThread }],
    ]);
    expect(session.listenerCount("notification") + session.listenerCount("serverRequest")).toBe(0);
    // Its late messages stay out of the session.
    expect(titles.owns({ method: "turn/completed", params: { threadId: namingThread } })).toBe(
      true,
    );
    // A thread/start that answers with the session's own thread runs nothing on it.
    calls.length = 0;
    reply = started({ id: nativeId, ephemeral: true });
    expect(await generate()).toBeNull();
    expect(calls.map(([method]) => method)).toEqual(["config/read", "thread/start"]);
    expect(titles.owns({ method: "turn/started", params: { threadId: nativeId } })).toBe(false);
    // Nor does a thread Codex would keep.
    calls.length = 0;
    reply = started({ id: "kept-thread", ephemeral: false });
    expect(await generate()).toBeNull();
    expect(calls.map(([method]) => method)).toEqual([
      "config/read",
      "thread/start",
      "thread/unsubscribe",
    ]);
    // Without the person's MCP servers known, no thread starts, as in the TUI.
    for (const failure of [{ origins: {} }, new Error("Invalid request: unknown variant")]) {
      calls.length = 0;
      reply = (method) => {
        if (method !== "config/read") return {};
        if (failure instanceof Error) throw failure;
        return failure;
      };
      expect(await generate()).toBeNull();
      expect(calls.map(([method]) => method)).toEqual(["config/read"]);
    }
  });

  it("parses and bounds a title as Codex's terminal client does", () => {
    expect(parseThreadTitle('  {"title":"  “Fix the login bug.” "}')).toBe("Fix the login bug");
    expect(parseThreadTitle('{"title":"Add\\n  dark\\tmode support!?"}')).toBe(
      "Add dark mode support",
    );
    expect(parseThreadTitle('{"title":"' + "x".repeat(40) + '"}')).toBe("x".repeat(36));
    expect(parseThreadTitle('{"title":"修复 上传测试"}')).toBe("修复 上传测试");
    for (const reply of ['Title: {"title":"x"}', '{"title":"x","why":"y"}', '{"title":" ."}', "{"])
      expect(parseThreadTitle(reply)).toBeNull();
    // 960 bytes of the message, no character split.
    const prompt = threadTitlePrompt(`  ${"é".repeat(600)}  `);
    expect(prompt.endsWith(`User prompt:\n${"é".repeat(480)}`)).toBe(true);
    expect(threadTitleModel({ data: [] }, null)).toBeNull();
    expect(threadTitleModel({ data: [{ model: "other" }] }, "other")).toEqual({
      model: "other",
      effort: null,
    });
  });
});
