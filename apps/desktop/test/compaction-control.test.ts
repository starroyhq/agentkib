import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexAppServerError,
  CodexAppServerSession,
} from "../../../packages/backend/src/codex-app-server";
import { CodexRuntimePreflight } from "../../../packages/backend/src/codex-runtime-preflight";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexFollowerState } from "../../../packages/backend/src/codex-follower-state";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { Commands } from "../../../packages/backend/src/commands";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import {
  readManagedRecord,
  readUnknownManagedCommands,
  saveManagedRecord,
} from "../../../packages/backend/src/managed-ledger";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

type Json = Record<string, unknown>;
const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  vi.spyOn(CodexRuntimePreflight.prototype, "check").mockResolvedValue({
    executable: "/fixture/codex",
    reason: null,
  });
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-compaction-control-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    workspace = path.join(root, "project"),
    bin = path.join(root, "bin");
  for (const directory of [home, workspace, bin]) mkdirSync(directory);
  // Resolution uses this isolated executable; its contents must never run.
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(executable, "offline fixture must not execute\n");
  chmodSync(executable, 0o700);
  const skillPath = path.join(workspace, "fixture-skill.md");
  writeFileSync(skillPath, "fixture");
  const skillId = createHash("sha256").update(Buffer.from(skillPath)).digest("hex");
  const environment = { CODEX_HOME: home, HOME: root, USERPROFILE: root, PATH: bin };
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-10-06T00:00:00Z",
  );
  const database = new DatabaseSync(path.join(home, "state_1.sqlite"));
  cleanups.push(() => database.close());
  database.exec(
    "CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,thread_source TEXT)",
  );
  const rollout = path.join(home, "fixture.jsonl");
  writeFileSync(
    rollout,
    JSON.stringify({
      type: "session_meta",
      payload: { id: nativeId, cwd: workspace, source: "cli", thread_source: "user" },
    }) + "\n",
  );
  database
    .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)")
    .run(nativeId, rollout, workspace, "Fixture", "cli", "user");
  store.sessions.sync(
    "workspace",
    "codex",
    new CodexSessions(environment).list(workspace).sessions.map((source) => source.session),
  );
  const indexedId = store.sessions.id("codex", nativeId);
  const commands = new Commands();
  const command = vi
    .spyOn(commands, "run")
    .mockRejectedValue(new Error("unexpected-native-command"));
  cleanups.push(() => commands.close());
  const readers = new SessionReaders(store.sessions, commands, environment, {} as CursorBridge);
  cleanups.push(() => readers.close());

  class OfflineAppServer extends EventEmitter {
    connected = true;
    sent: string[] = [];
    beforeRequest?: (method: string) => void | Promise<void>;
    beforeWrite?: (method: string) => void;
    afterWrite?: (method: string) => void;

    async request(method: string, _params: unknown, onDispatch?: () => void): Promise<unknown> {
      await this.beforeRequest?.(method);
      this.beforeWrite?.(method);
      onDispatch?.();
      this.sent.push(method);
      this.afterWrite?.(method);
      if (method === "model/list")
        return { data: [{ model: "model-a", isDefault: true, supportedReasoningEfforts: [] }] };
      if (method === "thread/goal/get") return { goal: null };
      if (method === "turn/start") return { turn: { id: "sent-turn", status: "inProgress" } };
      if (method === "turn/interrupt") return {};
      if (method === "skills/list")
        return {
          data: [{ cwd: workspace, skills: [{ name: "Fixture", path: skillPath, enabled: true }] }],
        };
      if (method === "thread/start" || method === "thread/resume")
        return {
          thread: { id: nativeId, cwd: workspace, turns: [], status: { type: "idle" } },
          cwd: workspace,
          model: "model-a",
          reasoningEffort: null,
          serviceTier: null,
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          },
        };
      throw new Error(`unexpected-offline-request:${method}`);
    }

    respond(): void {
      throw new Error("unexpected-offline-response");
    }
    async close(): Promise<void> {
      this.connected = false;
      this.emit("close");
    }
    compaction(turnId = "manual-turn"): void {
      this.emit("notification", {
        method: "item/started",
        params: {
          threadId: nativeId,
          turnId,
          item: { id: "compact", type: "contextCompaction" },
        },
      });
    }
  }
  const app = new OfflineAppServer();
  const start = vi
    .spyOn(CodexAppServerSession, "start")
    .mockResolvedValue(app as unknown as CodexAppServerSession);
  let followerRevision = 0;
  const followerState = new CodexFollowerState(nativeId, "fixture-owner");
  function followerSnapshot(compacting = false) {
    followerState.notification({
      type: "broadcast",
      sourceClientId: "fixture-owner",
      method: "thread-stream-state-changed",
      version: 11,
      params: {
        conversationId: nativeId,
        hostId: "local",
        change: {
          type: "snapshot",
          revision: ++followerRevision,
          conversationState: {
            id: nativeId,
            hostId: "local",
            requests: [],
            threadRuntimeStatus: { type: compacting ? "active" : "idle" },
            turns: compacting
              ? [
                  {
                    turnId: null,
                    status: "inProgress",
                    items: [
                      {
                        id: "pending-manual-context-compaction",
                        type: "contextCompaction",
                        completed: false,
                      },
                    ],
                  },
                ]
              : [],
          },
        },
      },
    });
  }
  followerSnapshot();
  const follower = {
    connected: true,
    selectedState: followerState,
    supportsThreadSettings: true,
    observeLive: vi.fn(async () => followerState),
    close: vi.fn(() => {}),
  };
  const connect = vi
    .spyOn(CodexFollowerBridge, "connect")
    .mockResolvedValue(follower as unknown as CodexFollowerBridge);
  const web = new WebReadRequests(store, readers, root, () => 0n, environment);
  cleanups.push(async () => {
    web.close();
    await app.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  async function create() {
    const result = await web.managedLifecycle({
      operation: "create",
      requestId: randomUUID(),
      deviceId: "fixture",
      workspaceId: "workspace",
      policyId: "workspace-write-on-request",
    });
    expect(result).toMatchObject({ accepted: true, completed: true });
    app.sent.length = 0;
    return result as { sessionId: string; runtimeBootId: string; live: Json };
  }
  async function observe() {
    const live = (await web.request({
      operation: "live",
      sessionId: indexedId,
      experimentalEnabled: true,
    })) as Json;
    expect(connect).not.toHaveBeenCalled();
    expect(live).toMatchObject({
      executionMode: "codex-managed",
      status: "idle",
      executionLocation: null,
      revision: 0,
    });
    return live;
  }

  function releasedRecord(adopted = true, savedSnapshot: Json = {}) {
    saveManagedRecord(root, {
      id: indexedId,
      workspace_id: "workspace",
      workspace,
      home,
      native_id: nativeId,
      title: "Fixture",
      created_at: "2026-10-06T00:00:00Z",
      released: true,
      adopted,
      archived: false,
      policy_id: "workspace-write-on-request",
      snapshot: { revision: 1, status: "released", ...savedSnapshot },
    });
  }
  return {
    root,
    web,
    app,
    start,
    command,
    indexedId,
    skillId,
    create,
    observe,
    releasedRecord,
    followerSnapshot,
    followerState,
  };
}

function sendRequest(created: { sessionId: string; runtimeBootId: string; live: Json }) {
  return {
    operation: "send",
    sessionId: created.sessionId,
    requestId: randomUUID(),
    deviceId: "fixture",
    runtimeBootId: created.runtimeBootId,
    expectedRevision: created.live.revision,
    experimentalEnabled: true,
    text: "offline input",
  };
}

describe("Web managed control compaction barriers", () => {
  it("rejects an idle manual compaction before claiming or dispatching send", async () => {
    const f = fixture(),
      created = await f.create();
    f.app.compaction();
    const live = (await f.web.request({ operation: "live", sessionId: created.sessionId })) as Json;
    expect(live).toMatchObject({
      status: "idle",
      activity: "compacting",
      turnId: null,
      sendEnabled: false,
      stopEnabled: false,
    });
    const request = { ...sendRequest(created), expectedRevision: live.revision };
    expect(await f.web.managedControl(request)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "session-compacting",
    });
    expect(f.app.sent).toEqual([]);
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toEqual([]);
    expect(f.command).not.toHaveBeenCalled();
  });

  it("rechecks activity after an asynchronous native resource read", async () => {
    const f = fixture(),
      created = await f.create();
    f.app.beforeRequest = (method) => {
      if (method === "skills/list") f.app.compaction();
    };
    const request = { ...sendRequest(created), resourceRefs: [{ kind: "skill", id: f.skillId }] };
    expect(await f.web.managedControl(request)).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: "session-compacting",
    });
    expect(f.app.sent).toEqual(["model/list", "skills/list"]);
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toEqual([]);
    expect(f.command).not.toHaveBeenCalled();
  });

  it("rejects compaction observed after preflight at the actual native write boundary", async () => {
    const f = fixture(),
      created = await f.create();
    f.app.beforeRequest = async (method) => {
      if (method !== "turn/start") return;
      f.app.compaction();
      const live = await f.web.request({ operation: "live", sessionId: created.sessionId });
      expect(live).toMatchObject({ activity: "compacting", sendEnabled: false });
    };
    const request = sendRequest(created);
    const result = await f.web.managedControl(request);
    expect(result).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: "session-compacting",
      requestId: request.requestId,
    });
    expect(f.app.sent).toEqual(["model/list"]);
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toEqual([]);
    // A retry reads the same receipt and must not send once compaction finishes.
    f.app.emit("notification", {
      method: "item/completed",
      params: {
        threadId: nativeId,
        turnId: "manual-turn",
        item: { id: "compact", type: "contextCompaction" },
      },
    });
    expect(await f.web.request({ operation: "live", sessionId: created.sessionId })).toMatchObject({
      activity: null,
      sendEnabled: true,
    });
    expect(await f.web.managedControl(request)).toEqual(result);
    expect(f.app.sent).toEqual(["model/list"]);
    expect(f.command).not.toHaveBeenCalled();
  });

  it("rejects a changed turn revision at the actual native write boundary", async () => {
    const f = fixture(),
      created = await f.create();
    f.app.beforeRequest = async (method) => {
      if (method !== "turn/start") return;
      f.app.emit("notification", {
        method: "turn/started",
        params: { threadId: nativeId, turn: { id: "other-turn" } },
      });
      await f.web.request({ operation: "live", sessionId: created.sessionId });
    };
    expect(await f.web.managedControl(sendRequest(created))).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: "stale-or-disabled-control",
    });
    expect(f.app.sent).toEqual(["model/list"]);
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toEqual([]);
  });

  it("rechecks local settings after a native catalog read without committing during compaction", async () => {
    const f = fixture(),
      created = await f.create();
    const revision = readManagedRecord(f.root, created.sessionId)?.snapshot.revision;
    f.app.beforeRequest = async (method) => {
      if (method !== "model/list") return;
      f.app.compaction();
      await f.web.request({ operation: "live", sessionId: created.sessionId });
    };
    expect(
      await f.web.managedControl({
        ...sendRequest(created),
        operation: "settings",
        text: undefined,
      }),
    ).toMatchObject({
      accepted: false,
      controlOutcome: "not-dispatched",
      error: "session-compacting",
    });
    expect(f.app.sent).toEqual(["model/list"]);
    expect(readManagedRecord(f.root, created.sessionId)?.snapshot.revision).toBe(
      Number(revision) + 1,
    );
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toEqual([]);
  });

  it("dispatches a valid idle send once and keeps its replay receipt", async () => {
    const f = fixture(),
      created = await f.create();
    const request = sendRequest(created);
    const result = await f.web.managedControl(request);
    expect(result).toMatchObject({ accepted: true, requestId: request.requestId });
    expect(f.app.sent).toEqual(["model/list", "turn/start"]);
    expect(await f.web.managedControl(request)).toEqual(result);
    expect(f.app.sent).toEqual(["model/list", "turn/start"]);
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toEqual([]);
  });

  it("preserves the unknown-result barrier if the native write was dispatched", async () => {
    const f = fixture(),
      created = await f.create();
    f.app.afterWrite = (method) => {
      if (method === "turn/start") throw new Error("offline-response-lost");
    };
    const request = sendRequest(created);
    const result = await f.web.managedControl(request);
    expect(result).toMatchObject({
      accepted: false,
      controlOutcome: "unknown",
      reason: "control-outcome-unconfirmed",
    });
    expect(f.app.sent).toEqual(["model/list", "turn/start"]);
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toMatchObject([
      { requestId: request.requestId },
    ]);
    expect(await f.web.managedControl(request)).toMatchObject({
      controlOutcome: "unknown",
      reason: "control-outcome-unconfirmed",
    });
    expect(f.app.sent).toEqual(["model/list", "turn/start"]);
  });

  it("keeps native stop available for a confirmed turn during compaction", async () => {
    const f = fixture(),
      created = await f.create();
    f.app.emit("notification", {
      method: "turn/started",
      params: { threadId: nativeId, turn: { id: "running-turn" } },
    });
    f.app.compaction("running-turn");
    const live = (await f.web.request({ operation: "live", sessionId: created.sessionId })) as Json;
    expect(live).toMatchObject({ activity: "compacting", stopEnabled: true });
    expect(
      await f.web.managedControl({
        ...sendRequest(created),
        operation: "stop",
        text: undefined,
        turnId: "running-turn",
        expectedRevision: live.revision,
      }),
    ).toMatchObject({ accepted: true });
    expect(f.app.sent).toEqual(["turn/interrupt"]);
    expect(readUnknownManagedCommands(f.root, created.sessionId)).toEqual([]);
  });
});

describe("Codex writer lock replaces Desktop ownership observations", () => {
  it.each(["adopt", "resume"])(
    "allows %s without confirmation when the native writer is free",
    async (operation) => {
      const f = fixture(),
        observed = await f.observe();
      if (operation === "resume") f.releasedRecord();
      const base = {
        operation,
        sessionId: f.indexedId,
        requestId: randomUUID(),
        deviceId: "fixture",
        handoffConfirmed: true,
      };
      const result =
        operation === "adopt"
          ? await f.web.managedLifecycle(base)
          : await f.web.managedResume({
              ...base,
              runtimeBootId: observed.runtimeBootId,
              experimentalEnabled: true,
            });
      expect(result).toMatchObject({ accepted: true, completed: true });
      // The preset probe fails on this fixture, as on a CLI without collaboration modes.
      expect(f.app.sent).toEqual([
        "model/list",
        "collaborationMode/list",
        "thread/goal/get",
        "thread/resume",
      ]);
      expect(readManagedRecord(f.root, f.indexedId)?.released).toBe(false);
      expect(f.command).not.toHaveBeenCalled();
    },
  );

  it("does not permanently block resume based on a saved compaction marker", async () => {
    const f = fixture(),
      observed = await f.observe();
    f.releasedRecord(true, { activity: "compacting", turnId: "old-manual-turn" });
    const result = await f.web.managedResume({
      operation: "resume",
      sessionId: f.indexedId,
      requestId: randomUUID(),
      deviceId: "fixture",
      handoffConfirmed: true,
      runtimeBootId: observed.runtimeBootId,
      experimentalEnabled: true,
    });
    expect(result).toMatchObject({
      accepted: true,
      completed: true,
      live: { activity: null, status: "idle" },
    });
    expect(f.app.sent).toContain("thread/resume");
  });

  it.each(["adopt", "resume"])(
    "does not use a compacting follower snapshot to gate %s",
    async (operation) => {
      const f = fixture(),
        observed = await f.observe();
      if (operation === "resume") f.releasedRecord();
      f.followerSnapshot(true);
      const base = {
        operation,
        sessionId: f.indexedId,
        requestId: randomUUID(),
        deviceId: "fixture",
        handoffConfirmed: true,
      };
      const result =
        operation === "adopt"
          ? await f.web.managedLifecycle(base)
          : await f.web.managedResume({
              ...base,
              runtimeBootId: observed.runtimeBootId,
              experimentalEnabled: true,
            });
      expect(result).toMatchObject({ accepted: true, completed: true });
      expect(f.start).toHaveBeenCalledOnce();
      // The preset probe fails on this fixture, as on a CLI without collaboration modes.
      expect(f.app.sent).toEqual([
        "model/list",
        "collaborationMode/list",
        "thread/goal/get",
        "thread/resume",
      ]);
      expect(readManagedRecord(f.root, f.indexedId)?.released).toBe(false);
      expect(f.command).not.toHaveBeenCalled();
    },
  );

  it.each(["adopt", "resume"])(
    "reports a writer acquired immediately before %s as a definite native rejection",
    async (operation) => {
      const f = fixture(),
        observed = await f.observe();
      if (operation === "resume") f.releasedRecord();
      f.app.afterWrite = (method) => {
        if (method === "thread/resume")
          throw new CodexAppServerError({
            code: -32600,
            message: "thread already has an active writer",
          });
      };
      const base = {
        operation,
        sessionId: f.indexedId,
        requestId: randomUUID(),
        deviceId: "fixture",
        handoffConfirmed: true,
      };
      const result =
        operation === "adopt"
          ? await f.web.managedLifecycle(base)
          : await f.web.managedResume({
              ...base,
              runtimeBootId: observed.runtimeBootId,
              experimentalEnabled: true,
            });
      expect(result).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "codex-owner-busy",
      });
      // The preset probe fails on this fixture, as on a CLI without collaboration modes.
      expect(f.app.sent).toEqual([
        "model/list",
        "collaborationMode/list",
        "thread/goal/get",
        "thread/resume",
      ]);
      expect(readManagedRecord(f.root, f.indexedId)?.released).toBe(true);
      expect(readUnknownManagedCommands(f.root, f.indexedId)).toEqual([]);
      expect(f.command).not.toHaveBeenCalled();
    },
  );

  it.each(["adopt", "resume"])(
    "keeps the final writer rejection authoritative for %s after model/goal reads",
    async (operation) => {
      const f = fixture(),
        observed = await f.observe();
      if (operation === "resume") f.releasedRecord();
      f.app.beforeRequest = (method) => {
        if (method === "model/list") f.followerSnapshot(true);
      };
      f.app.afterWrite = (method) => {
        if (method === "thread/resume")
          throw new CodexAppServerError({
            code: -32600,
            message: "thread already has an active writer",
          });
      };
      const base = {
        operation,
        sessionId: f.indexedId,
        requestId: randomUUID(),
        deviceId: "fixture",
        handoffConfirmed: true,
      };
      const result =
        operation === "adopt"
          ? await f.web.managedLifecycle(base)
          : await f.web.managedResume({
              ...base,
              runtimeBootId: observed.runtimeBootId,
              experimentalEnabled: true,
            });
      expect(result).toMatchObject({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "codex-owner-busy",
      });
      // The preset probe fails on this fixture, as on a CLI without collaboration modes.
      expect(f.app.sent).toEqual([
        "model/list",
        "collaborationMode/list",
        "thread/goal/get",
        "thread/resume",
      ]);
      expect(readManagedRecord(f.root, f.indexedId)?.released).toBe(true);
    },
  );

  it.each(["adopt", "resume"])(
    "keeps %s independent of an unconnected follower stream reset",
    async (operation) => {
      const f = fixture(),
        observed = await f.observe();
      if (operation === "resume") f.releasedRecord();
      f.app.beforeWrite = (method) => {
        if (method === "thread/resume") f.followerState.invalidate("disconnected");
      };
      const base = {
        operation,
        sessionId: f.indexedId,
        requestId: randomUUID(),
        deviceId: "fixture",
        handoffConfirmed: true,
      };
      const result =
        operation === "adopt"
          ? await f.web.managedLifecycle(base)
          : await f.web.managedResume({
              ...base,
              runtimeBootId: observed.runtimeBootId,
              experimentalEnabled: true,
            });
      expect(result).toMatchObject({ accepted: true, completed: true });
      // The preset probe fails on this fixture, as on a CLI without collaboration modes.
      expect(f.app.sent).toEqual([
        "model/list",
        "collaborationMode/list",
        "thread/goal/get",
        "thread/resume",
      ]);
      expect(readUnknownManagedCommands(f.root, f.indexedId)).toEqual([]);
    },
  );
});
