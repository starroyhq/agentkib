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
} from "../../../packages/backend/src/codex-app-server";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexRuntimePreflight } from "../../../packages/backend/src/codex-runtime-preflight";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  readManagedRecord,
  readUnknownManagedCommands,
  saveManagedRecord,
} from "../../../packages/backend/src/managed-ledger";
import { ManagedCodexState } from "../../../packages/backend/src/managed-codex-state";
import {
  acquireManagedSessionLease,
  acquirePortableFileLease,
} from "../../../packages/backend/src/managed-session-lock";
import * as managedSessionLocks from "../../../packages/backend/src/managed-session-lock";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import type { Commands } from "../../../packages/backend/src/commands";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";

const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const forkId = "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff";
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture(
  compressedHistory = false,
  registeredRoot?: string,
  runtimeEnvironment: NodeJS.ProcessEnv = {},
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
  let nativeFailure: unknown;
  let turnFailure: unknown;
  const methods: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  let broadSandbox = false;
  let sandboxRootsOverride: { value: unknown } | undefined;
  let policyReply: Record<string, unknown> = {};
  let readCwd: string | undefined;
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
  const servers: OfflineServer[] = [];
  class OfflineServer extends EventEmitter {
    connected = true;
    closed = false;
    closeFailure?: Error;
    async request(method: string, params: unknown, dispatch?: () => void): Promise<unknown> {
      dispatch?.();
      methods.push(method);
      requests.push({ method, params });
      if (method === "thread/resume" && nativeFailure) throw nativeFailure;
      if (method === "model/list") return { data: models };
      if (method === "collaborationMode/list") {
        if (collaborationModes instanceof Error) throw collaborationModes;
        return collaborationModes;
      }
      if (method === "thread/goal/get") return { goal: null };
      if (method === "skills/list") return { data: [] };
      if (method === "thread/read")
        return {
          thread: {
            id: (params as { threadId?: string }).threadId ?? nativeId,
            cwd: readCwd ?? executionCwd,
            model: sourceModel,
            reasoningEffort: sourceEffort,
            status: { type: "idle" },
            turns: [{ id: "finished-turn", status: "completed", items: [] }],
          },
        };
      if (method === "turn/start") {
        if (turnFailure) throw turnFailure;
        return { turn: { id: "new-turn", status: "inProgress" } };
      }
      if (method === "turn/steer") return { turnId: "new-turn" };
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
      if (method === "thread/queue/list") return { data: [], nextCursor: null };
      if (["thread/resume", "thread/start", "thread/fork", "thread/unarchive"].includes(method))
        return {
          thread: {
            id:
              method === "thread/fork"
                ? forkId
                : ((params as { threadId?: string }).threadId ?? nativeId),
            cwd: wrongReplyCwd === "thread" ? workspace : executionCwd,
            status: { type: "idle" },
            turns: [],
          },
          cwd: wrongReplyCwd === "top" ? workspace : executionCwd,
          model: (params as Record<string, unknown>).model ?? configuredModel,
          reasoningEffort:
            (params as { config?: Record<string, unknown> }).config?.model_reasoning_effort ?? null,
          serviceTier: null,
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
    complete() {
      this.emit("notification", {
        method: "turn/completed",
        params: { threadId: nativeId, turn: { id: "new-turn", status: "completed" } },
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
  const web = new WebReadRequests(
    store,
    readers,
    root,
    () => 0n,
    { CODEX_HOME: home, HOME: root, PATH: bin, ...runtimeEnvironment },
    undefined,
    () => observed,
  );
  cleanups.push(() => web.closeAsync());
  const live = () =>
    web.request({ operation: "live", sessionId: summary.id, experimentalEnabled: true });
  const sendWithState = (
    state: Awaited<ReturnType<typeof live>>,
    fields: Record<string, unknown> = {},
  ) =>
    web.managedControl({
      operation: "send",
      sessionId: summary.id,
      requestId: randomUUID(),
      deviceId: "fixture",
      runtimeBootId: state.runtimeBootId,
      expectedRevision: state.revision,
      experimentalEnabled: true,
      text: "Continue",
      ...fields,
    });
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
    setCwd: (cwd: string) => {
      executionCwd = cwd;
    },
    setReadCwd: (cwd: string) => {
      readCwd = cwd;
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

  it("offers the native presets, sends the turn in Plan, and confirms it from the CLI", async () => {
    const f = fixture();
    // Before any runner: read with a metadata-only reader.
    const inactive = await settingsState(f);
    expect(inactive.collaborationModes).toEqual([
      { id: "plan", name: "Plan" },
      { id: "default", name: "Default" },
    ]);
    expect(inactive.settings.writable.mode).toEqual({ available: true });
    expect(await control(f, "settings", { mode: "plan" })).toMatchObject({ accepted: true });
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).toMatchObject({
      collaborationMode: {
        mode: "plan",
        // Null asks Codex for its own Plan instructions; AgentKib never copies them.
        settings: { model: "model-a", developer_instructions: null },
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
          effort: null,
          serviceTier: null,
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
            settings: { model: "model-a", reasoning_effort: null, developer_instructions: "…" },
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
      error: "native-collaboration-modes-unavailable",
    });
    expect(await control(f, "send")).toMatchObject({ accepted: true });
    expect(f.requests.find(({ method }) => method === "turn/start")?.params).not.toHaveProperty(
      "collaborationMode",
    );
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
    expect(await f.send()).toMatchObject({ accepted: false, controlOutcome: "not-dispatched" });
    expect(f.methods).not.toContain("turn/start");
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(1);
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

  it("keeps native writer conflicts authoritative for compressed history", async () => {
    const f = fixture(true);
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

  it("keeps lost native resume receipts blocking compressed-history resends", async () => {
    const f = fixture(true);
    f.setFailure(new Error("Codex app-server request timed out"));
    expect(await f.send()).toMatchObject({ reason: "control-outcome-unconfirmed" });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(1);
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
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
      const f = fixture();
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
    "preserves the unknown receipt when shutdown interrupts dispatched %s",
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
        reason: "control-outcome-unconfirmed",
      });
      const unresolved = readUnknownManagedCommands(f.root, f.summary.id);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.evidence?.operation).toBe(
        method === "thread/resume" ? "adopt" : "send",
      );
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

  it("reads an inactive session without a runner and automatically adopts on send", async () => {
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
    expect(f.follower).not.toHaveBeenCalled();
    expect(await f.live()).toMatchObject({ executionLocation: "agentkib" });
  });

  it("reports a definite writer refusal without an unknown command or follower fallback", async () => {
    const f = fixture();
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
  it("keeps a lost resume uncertain without stranding the original unsent message's receipt", async () => {
    const f = fixture();
    f.setFailure(new Error("Codex app-server request timed out"));
    const requestId = randomUUID();
    expect(await f.send({ requestId })).toMatchObject({
      requestId,
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toHaveLength(1);
    expect(readControlReceipt(f.root, { requestId, deviceId: "fixture" })).toMatchObject({
      found: true,
      status: "not-dispatched",
      operation: "send",
      ack: { controlOutcome: "not-dispatched" },
    });
    const child = readUnknownManagedCommands(f.root, f.summary.id)[0]!;
    expect(
      readControlReceipt(f.root, { requestId: child.requestId, deviceId: "fixture" }),
    ).toMatchObject({ found: true, status: "unknown" });
    expect(await f.live()).toMatchObject({
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
    });
    expect(await f.send()).toMatchObject({
      controlOutcome: "not-dispatched",
      reason: "control-outcome-unconfirmed",
    });
    expect(f.methods.filter((method) => method === "thread/resume")).toHaveLength(1);
    expect(f.follower).not.toHaveBeenCalled();
    expect(
      await f.web.managedReconcile({
        operation: "reconcile",
        sessionId: f.summary.id,
        requestId: randomUUID(),
        deviceId: "fixture",
      }),
    ).toMatchObject({ reconciled: true });
    expect(readUnknownManagedCommands(f.root, f.summary.id)).toEqual([]);
    expect(f.methods).not.toContain("turn/start");
    f.setFailure(undefined);
    expect(await f.send()).toMatchObject({ accepted: true });
    expect(f.methods.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("forks a busy source through a reader without resuming or changing the source", async () => {
    const f = fixture();
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

  it.each(["adopt", "resume", "create", "fork"] as const)(
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
