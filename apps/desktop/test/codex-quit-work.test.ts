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
import { RUNTIME_METHODS, type QuitWorkPreview } from "@agentkib/runtime-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerError,
  CodexAppServerSession,
} from "../../../packages/backend/src/agents/codex/codex-app-server";
import { CodexDesktopApp } from "../../../packages/backend/src/agents/codex/codex-desktop-app";
import { CodexFollowerBridge } from "../../../packages/backend/src/agents/codex/codex-follower-bridge";
import { CodexRuntimePreflight } from "../../../packages/backend/src/agents/codex/codex-runtime-preflight";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import { HistorySearch } from "../../../packages/backend/src/history-search";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { MessageLeadReports } from "../../../packages/backend/src/message-lead-reports";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { BackendStore } from "../../../packages/backend/src/store";

type Body = Record<string, unknown>;
type Turn = { id: string; status: "completed" | "interrupted" | "inProgress"; items: Body[] };
const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const model = "offline-quit-model";
const effort = "medium";
const deviceId = "desktop-local";
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

async function fixture({
  cannotReorder = false,
  incompleteQueue = false,
  lostContinuationAdd = false,
}: {
  cannotReorder?: boolean;
  incompleteQueue?: boolean;
  lostContinuationAdd?: boolean;
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ak-codex-quit-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const data = join(root, "data");
  const codexHome = join(home, ".codex");
  const workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const lock = join(codexHome, "thread-writer-locks", threadId + ".lock");
  const transcript = join(codexHome, "sessions", "rollout-" + threadId + ".jsonl");
  for (const folder of [
    data,
    workspace,
    bin,
    join(codexHome, "sessions"),
    join(codexHome, "thread-writer-locks"),
  ])
    mkdirSync(folder, { recursive: true });
  writeFileSync(join(data, "preferences.json"), JSON.stringify({ session_index_enabled: false }));
  const executable = join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(executable, "fixture executable", { mode: 0o700 });
  writeFileSync(
    transcript,
    JSON.stringify({
      type: "session_meta",
      payload: { id: threadId, cwd: workspace, source: "cli" },
    }) + "\n",
  );
  const db = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  try {
    db.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,archived INTEGER)",
    );
    db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)").run(
      threadId,
      transcript,
      workspace,
      "Quit fixture",
      "cli",
      0,
    );
  } finally {
    db.close();
  }
  const store = new BackendStore(join(data, "agentkib.db"));
  try {
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "workspace",
      workspace,
      "Offline workspace",
      "healthy",
      "2026-11-20T00:00:00Z",
    );
  } finally {
    store.close();
  }

  const turns: Turn[] = [];
  const queued: Body[] = [];
  const starts: Body[] = [];
  const requests: { method: string; params: Body }[] = [];
  const nativeRuns: string[] = [];
  const runSettings: Body[] = [];
  let owner: OfflineServer | undefined;
  const sandbox = {
    type: "workspaceWrite",
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
  const append = (type: string, payload: Body) =>
    appendFileSync(
      transcript,
      JSON.stringify({ timestamp: new Date().toISOString(), type, payload }) + "\n",
    );
  const appendEvent = (type: string, turn: Turn) => append("event_msg", { type, turn_id: turn.id });
  const latest = () => turns.at(-1);
  const thread = (includeTurns: boolean) => ({
    id: threadId,
    cwd: workspace,
    model,
    name: "Quit fixture",
    status: { type: latest()?.status === "inProgress" ? "active" : "idle" },
    turns: includeTurns ? [...turns] : [],
  });

  class OfflineServer extends EventEmitter {
    connected = true;
    closed = false;
    userAgent = "codex/0.167.0";
    queueHeld = false;
    release?: () => void;
    settings: Body = {};

    start(params: Body) {
      const turn: Turn = {
        id: "test-turn-" + (turns.length + 1),
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: "message-" + (turns.length + 1),
            clientId: params.clientUserMessageId,
            content: params.input,
          },
        ],
      };
      turns.push(turn);
      nativeRuns.push(String((params.input as Body[])[0]?.text));
      const applied = { ...this.settings };
      for (const key of [
        "model",
        "effort",
        "serviceTier",
        "approvalPolicy",
        "approvalsReviewer",
        "sandboxPolicy",
      ])
        if (Object.hasOwn(params, key)) applied[key] = params[key];
      this.settings = applied;
      const policy = applied.sandboxPolicy as typeof sandbox;
      runSettings.push({
        ...applied,
        // WorkspaceWrite includes cwd even when there are no explicit additional roots.
        sandboxPolicy: {
          ...policy,
          writableRoots: [...new Set([workspace, ...policy.writableRoots])],
        },
      });
      appendEvent("task_started", turn);
      append("turn_context", {
        turn_id: turn.id,
        cwd: workspace,
        model: applied.model,
        effort: applied.effort,
        service_tier: applied.serviceTier,
        approval_policy: applied.approvalPolicy,
        approvals_reviewer: applied.approvalsReviewer,
        sandbox_policy: {
          type: "workspace-write",
          writable_roots: [],
          network_access: false,
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true,
        },
      });
      this.emit("notification", {
        method: "turn/started",
        params: { threadId, turn },
      });
      return turn;
    }

    finish(status: "completed" | "interrupted") {
      const turn = latest();
      if (!turn || turn.status !== "inProgress") throw new Error("Offline turn is not running");
      turn.status = status;
      appendEvent(status === "interrupted" ? "turn_aborted" : "task_complete", turn);
      this.emit("notification", {
        method: "turn/completed",
        params: { threadId, turn: { ...turn } },
      });
      if (status === "completed" && !this.queueHeld) {
        const next = queued.shift();
        if (next) this.start(next);
      }
    }

    async request(method: string, params: Body, dispatch?: () => void): Promise<unknown> {
      dispatch?.();
      requests.push({ method, params });
      switch (method) {
        case "model/list":
          return {
            data: [
              {
                model,
                isDefault: true,
                defaultReasoningEffort: effort,
                supportedReasoningEfforts: [{ reasoningEffort: effort }],
              },
            ],
          };
        case "collaborationMode/list":
          return { data: [] };
        case "thread/goal/get":
          return { goal: null };
        case "account/rateLimits/read":
          throw new Error("offline rate limits");
        case "thread/start":
        case "thread/resume": {
          this.release = acquirePortableFileLease(lock);
          owner = this;
          this.queueHeld = method === "thread/resume" && latest()?.status === "interrupted";
          this.settings = {
            model: params.model ?? model,
            effort: (params.config as Body | undefined)?.model_reasoning_effort ?? effort,
            serviceTier: params.serviceTier ?? "fast",
            approvalPolicy: params.approvalPolicy ?? "on-request",
            approvalsReviewer: params.approvalsReviewer ?? "user",
            sandboxPolicy: sandbox,
          };
          return {
            thread: thread(params.excludeTurns !== true),
            initialTurnsPage: { data: turns.slice(-1), nextCursor: null },
            cwd: workspace,
            ...this.settings,
            reasoningEffort: this.settings.effort,
            sandbox,
          };
        }
        case "thread/read":
          return { thread: thread(params.includeTurns !== false) };
        case "thread/turns/list":
          return {
            data: [...turns].reverse().slice(0, Number(params.limit ?? 1)),
            nextCursor: null,
          };
        case "thread/queue/list":
          return { data: [...queued], nextCursor: incompleteQueue ? "repeated-cursor" : null };
        case "thread/queue/add": {
          const submission = {
            id: "queued-" + (queued.length + 1),
            clientUserMessageId: params.clientUserMessageId,
            input: params.input,
          };
          queued.push(submission);
          // The native API always enqueues, even when a client user message ID repeats.
          if (latest()?.status !== "inProgress" && !this.queueHeld) {
            const next = queued.shift();
            if (next) this.start(next);
          }
          if (lostContinuationAdd && this.queueHeld)
            throw new Error("Lost native reply after enqueue");
          return { queuedSubmission: submission };
        }
        case "thread/queue/reorder": {
          const ids = params.queuedSubmissionIds as string[];
          expect(params.threadId).toBe(threadId);
          expect([...ids].sort()).toEqual(queued.map((entry) => entry.id).sort());
          if (cannotReorder)
            throw new CodexAppServerError({ code: -32601, message: "No queue reorder method" });
          const items = ids.map((id) => queued.find((item) => item.id === id)!);
          queued.splice(0, queued.length, ...items);
          return {};
        }
        case "thread/queue/start": {
          expect(params).toEqual({ threadId, queuedSubmissionId: expect.any(String) });
          if (latest()?.status === "inProgress") throw new Error("Thread is busy");
          const index = queued.findIndex((item) => item.id === params.queuedSubmissionId);
          if (index === -1) throw new Error("Queued submission not found");
          const [item] = queued.splice(index, 1);
          this.queueHeld = false;
          return { turn: this.start(item!) };
        }
        case "thread/queue/delete": {
          expect(params).toEqual({ threadId, queuedSubmissionId: expect.any(String) });
          const index = queued.findIndex((item) => item.id === params.queuedSubmissionId);
          if (index === -1) return { deleted: false };
          queued.splice(index, 1);
          return { deleted: true };
        }
        case "turn/start":
          this.queueHeld = false;
          starts.push(params);
          return { turn: this.start(params) };
        case "turn/interrupt":
          expect(params).toEqual({ threadId, turnId: latest()?.id });
          this.queueHeld = true;
          this.finish("interrupted");
          return {};
        case "thread/unsubscribe":
          return {};
        default:
          throw new Error("Unexpected offline Codex method " + method);
      }
    }

    async close() {
      this.connected = false;
      this.closed = true;
      this.release?.();
      this.emit("close");
    }
  }

  const follower = vi.spyOn(CodexFollowerBridge, "connect").mockRejectedValue(new Error("offline"));
  vi.spyOn(CodexDesktopApp.prototype, "running").mockResolvedValue(false);
  vi.spyOn(CodexDesktopApp.prototype, "openThread").mockResolvedValue(false);
  vi.spyOn(CodexRuntimePreflight.prototype, "check").mockResolvedValue({
    executable,
    reason: null,
  });
  vi.spyOn(CodexRuntimePreflight.prototype, "preferred").mockReturnValue(executable);
  vi.spyOn(CodexAppServerSession, "start").mockImplementation(
    async (file, _cwd, _home, _env, _notify, onStarted) => {
      expect(file).toBe(executable);
      const server = new OfflineServer() as unknown as CodexAppServerSession;
      onStarted?.(server);
      return server;
    },
  );
  vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
  vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
  vi.spyOn(HistorySearch.prototype, "refresh").mockImplementation(() => {});
  vi.spyOn(HistorySearch.prototype, "clear").mockResolvedValue();
  const boot = async () => {
    const backend = new TypeScriptBackend({
      HOME: home,
      USERPROFILE: home,
      PATH: bin,
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      DSH_HOME: join(home, ".dsh"),
      DEVIN_SESSIONS_DIR: join(home, "devin"),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      AGENTKIB_HOME: join(home, ".agentkib"),
      AGENTKIB_DSH_PLUGIN_DIR: "",
    });
    let closed = false;
    cleanups.push(() => (closed ? undefined : backend.closeAsync()));
    const rpc = async <T = Body>(method: string, params: Body = {}) => {
      const response = await backend.handleAsync({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params,
      });
      expect(response.error).toBeUndefined();
      return response.result as T;
    };
    await rpc("backend.initialize", { dataDir: data });
    const session = (request: Body, target?: string) =>
      rpc(RUNTIME_METHODS.sessionRequest, { host: { request, ...(target && { target }) } });
    const control = async (sessionId: string, operation: string, fields: Body = {}) => {
      const live = await session({ operation: "live", sessionId, experimentalEnabled: true });
      return session({
        operation,
        sessionId,
        requestId: randomUUID(),
        deviceId,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: live.revision,
        experimentalEnabled: true,
        ...fields,
      });
    };
    return {
      backend,
      rpc,
      session,
      control,
      preview: () => rpc<QuitWorkPreview>(RUNTIME_METHODS.quitWorkPrepare),
      quit: async (ticket: string, resume = true) => {
        await rpc(RUNTIME_METHODS.shutdown, { quitWork: { ticket, resume } });
        closed = true;
      },
    };
  };

  const before = await boot();
  const created = await before.session({
    operation: "provider-create",
    agent: "codex",
    workspaceId: "workspace",
    requestId: randomUUID(),
    deviceId,
    model,
    effort,
    policyId: "workspace-write-on-request",
  });
  expect(created.accepted, JSON.stringify(created)).toBe(true);
  expect(created.sessionId).toEqual(expect.any(String));
  const sessionId = String(created.sessionId);
  expect(await before.control(sessionId, "send", { text: "Original task" })).toMatchObject({
    accepted: true,
  });
  const firstTurn = latest()!.id;
  expect(
    await before.session({ operation: "live", sessionId, experimentalEnabled: true }),
  ).toMatchObject({ status: "running", turnId: firstTurn, executionMode: "codex-managed" });

  return {
    boot,
    before,
    data,
    sessionId,
    firstTurn,
    follower,
    queued,
    starts,
    requests,
    nativeRuns,
    runSettings,
    assignLead: async () => {
      const lead = "offline-quit-lead";
      const leadDevice = "agentkib-local-owner";
      const report = vi.spyOn(MessageLeadReports.prototype, "send").mockResolvedValue(false);
      saveManagedRecord(data, {
        id: lead,
        native_id: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
        workspace_id: "workspace",
        workspace,
        cwd: workspace,
        home: codexHome,
        title: "Offline Project Agent",
        created_at: "2026-11-20T00:00:00Z",
        policy_id: "workspace-write-on-request",
        adopted: false,
        released: false,
        archived: false,
      });
      expect(
        await before.session(
          {
            operation: "lead-assign-workers",
            sessionId: lead,
            deviceId: leadDevice,
            workers: [sessionId],
            experimentalEnabled: true,
          },
          "claude-code",
        ),
      ).toMatchObject({ lead: { sessionId: lead }, capable: true });
      return { lead, leadDevice, report };
    },
    finish: () => owner!.finish("completed"),
    takeOver: () => {
      const release = acquirePortableFileLease(lock);
      cleanups.push(release);
    },
    laterTurn: () => {
      const external: Turn = { id: "later-external-turn", status: "completed", items: [] };
      turns.push(external);
      appendEvent("task_started", external);
      appendEvent("task_complete", external);
    },
  };
}

describe("Codex quit continuation through the backend runtime", () => {
  it("resumes the same thread once with its native settings and puts the existing FIFO behind the continuation", async () => {
    const f = await fixture();
    for (const text of ["First queued", "Second queued"])
      expect(await f.before.control(f.sessionId, "queue-add", { text })).toMatchObject({
        accepted: true,
      });
    const lead = await f.assignLead();
    const originalIds = f.queued.map((item) => item.id);
    const preview = await f.before.preview();
    expect(preview.work).toContainEqual(
      expect.objectContaining({ agent: "codex", resumable: true }),
    );
    const id = preview.work.find((item) => item.agent === "codex")!.id;
    await f.before.quit(preview.ticket);
    expect(f.requests.filter((call) => call.method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId, turnId: f.firstTurn } },
    ]);
    expect(f.queued).toHaveLength(2);
    expect(f.nativeRuns).toEqual(["Original task"]);
    const beforeOpen = f.requests.length;

    const after = await f.boot();
    after.backend.activateQuitWork();
    await vi.waitFor(() =>
      expect(readControlReceipt(f.data, { requestId: id, deviceId })).toMatchObject({
        found: true,
        status: "accepted",
        sessionId: f.sessionId,
        executionMode: "codex-managed",
      }),
    );
    const queueWrites = f.requests
      .slice(beforeOpen)
      .filter(({ method }) =>
        ["thread/queue/add", "thread/queue/reorder", "thread/queue/start", "turn/start"].includes(
          method,
        ),
      );
    expect(queueWrites).toEqual([
      {
        method: "thread/queue/add",
        params: {
          threadId,
          clientUserMessageId: id,
          input: [
            expect.objectContaining({ type: "text", text: expect.stringContaining("interrupted") }),
          ],
        },
      },
      {
        method: "thread/queue/reorder",
        params: { threadId, queuedSubmissionIds: ["queued-3", ...originalIds] },
      },
      { method: "thread/queue/start", params: { threadId, queuedSubmissionId: "queued-3" } },
    ]);
    expect(f.runSettings[1]).toMatchObject({
      model,
      effort,
      serviceTier: "fast",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
    });
    expect(f.runSettings[1]).toMatchObject(f.runSettings[0]!);
    expect(f.nativeRuns).toHaveLength(2);
    expect(f.queued.map((item) => item.id)).toEqual(originalIds);
    expect(f.follower).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(lead.report).toHaveBeenCalledExactlyOnceWith(
        lead.lead,
        lead.leadDevice,
        expect.stringMatching(
          /\[AgentKib report\][\s\S]*interrupted when AgentKib quit[\s\S]*continuation/,
        ),
      ),
    );
    const continuation = f.nativeRuns[1];
    f.finish();
    f.finish();
    f.finish();
    expect(f.nativeRuns).toEqual(["Original task", continuation, "First queued", "Second queued"]);
    await after.backend.closeAsync();
    const reopened = await f.boot();
    reopened.backend.activateQuitWork();
    await reopened.rpc(RUNTIME_METHODS.quitWorkList);
    expect(f.requests.filter(({ method }) => method === "thread/queue/start")).toHaveLength(1);
    expect(f.starts).toHaveLength(1);
  });

  it.each(["native completion before quit", "later native turn", "other owner"])(
    "skips after %s",
    async (change) => {
      const f = await fixture();
      const preview = await f.before.preview();
      expect(preview.work).toContainEqual(
        expect.objectContaining({ agent: "codex", resumable: true }),
      );
      if (change === "native completion before quit") f.finish();
      await f.before.quit(preview.ticket, false);
      if (change === "later native turn") f.laterTurn();
      if (change === "other owner") f.takeOver();
      const after = await f.boot();
      after.backend.activateQuitWork();
      await expect(after.rpc(RUNTIME_METHODS.quitWorkList)).resolves.toEqual([]);
      expect(f.starts).toHaveLength(1);
      expect(f.follower).not.toHaveBeenCalled();
    },
  );

  it("leaves an unchecked Codex turn available for one explicit continuation", async () => {
    const f = await fixture();
    const preview = await f.before.preview();
    const work = preview.work.find((item) => item.agent === "codex");
    expect(work).toMatchObject({ id: expect.any(String), resumable: true });
    const id = work!.id;
    await f.before.quit(preview.ticket, false);

    const after = await f.boot();
    after.backend.activateQuitWork();
    await expect(after.rpc(RUNTIME_METHODS.quitWorkList)).resolves.toEqual([
      expect.objectContaining({
        id,
        sessionId: f.sessionId,
        status: "interrupted",
        resumable: true,
      }),
    ]);
    expect(f.starts).toHaveLength(1);
    await expect(after.rpc(RUNTIME_METHODS.quitWorkResume, { id })).resolves.toEqual({
      outcome: "continued",
    });
    await expect(after.rpc(RUNTIME_METHODS.quitWorkResume, { id })).resolves.toEqual({
      outcome: "skipped",
    });
    expect(f.starts).toHaveLength(2);
    expect(f.starts[1]).toMatchObject({ threadId, clientUserMessageId: id });
    expect(f.requests.filter(({ method }) => method === "thread/queue/start")).toEqual([]);
  });

  it.each(["unsafe queue at quit", "unsupported reorder at restart"] as const)(
    "leaves a manual session link after %s without changing the user's pending messages",
    async (scenario) => {
      const incompleteQueue = scenario === "unsafe queue at quit";
      const f = await fixture({ incompleteQueue, cannotReorder: !incompleteQueue });
      expect(
        await f.before.control(f.sessionId, "queue-add", { text: "First queued" }),
      ).toMatchObject({ accepted: true });
      const originalQueue = f.queued.slice();
      const preview = await f.before.preview();
      expect(preview.work).toContainEqual(
        expect.objectContaining({
          agent: "codex",
          resumable: !incompleteQueue,
        }),
      );
      const id = preview.work.find((item) => item.agent === "codex")!.id;
      await f.before.quit(preview.ticket);

      const after = await f.boot();
      after.backend.activateQuitWork();
      await vi.waitFor(async () =>
        expect(await after.rpc(RUNTIME_METHODS.quitWorkList)).toEqual([
          expect.objectContaining({
            id,
            sessionId: f.sessionId,
            resumable: false,
            status: "interrupted",
            openSession: true,
          }),
        ]),
      );
      expect(f.queued).toEqual(originalQueue);
      expect(f.nativeRuns).toEqual(["Original task"]);
      expect(f.requests.filter(({ method }) => method === "thread/queue/start")).toEqual([]);
      expect(f.requests.filter(({ method }) => method === "thread/queue/delete")).toEqual(
        incompleteQueue
          ? []
          : [
              {
                method: "thread/queue/delete",
                params: { threadId, queuedSubmissionId: "queued-2" },
              },
            ],
      );
    },
  );

  it("keeps a lost continuation enqueue unconfirmed across restart without resubmitting", async () => {
    const f = await fixture({ lostContinuationAdd: true });
    expect(
      await f.before.control(f.sessionId, "queue-add", { text: "First queued" }),
    ).toMatchObject({ accepted: true });
    const preview = await f.before.preview();
    const id = preview.work.find((item) => item.agent === "codex")!.id;
    await f.before.quit(preview.ticket);

    const after = await f.boot();
    after.backend.activateQuitWork();
    const unconfirmed = [
      expect.objectContaining({ id, sessionId: f.sessionId, status: "unknown", resumable: false }),
    ];
    await vi.waitFor(async () =>
      expect(await after.rpc(RUNTIME_METHODS.quitWorkList)).toEqual(unconfirmed),
    );
    expect(f.queued.map((item) => item.id)).toEqual(["queued-1", "queued-2"]);
    expect(f.queued[1]).toMatchObject({ clientUserMessageId: id });
    await after.backend.closeAsync();

    const reopened = await f.boot();
    reopened.backend.activateQuitWork();
    await expect(reopened.rpc(RUNTIME_METHODS.quitWorkList)).resolves.toEqual(unconfirmed);
    expect(
      f.requests.filter(
        ({ method, params }) => method === "thread/queue/add" && params.clientUserMessageId === id,
      ),
    ).toHaveLength(1);
    expect(f.nativeRuns).toEqual(["Original task"]);
  });
});
