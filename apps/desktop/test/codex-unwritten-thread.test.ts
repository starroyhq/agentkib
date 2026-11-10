import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import { CodexRuntimePreflight } from "../../../packages/backend/src/codex-runtime-preflight";
import { Commands } from "../../../packages/backend/src/commands";
import { ConversationReadStates } from "../../../packages/backend/src/conversation-read-state";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import { readManagedRecord } from "../../../packages/backend/src/managed-ledger";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const threadId = "0aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-unwritten-thread-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    workspace = path.join(root, "project"),
    bin = path.join(root, "bin");
  for (const directory of [home, workspace, bin]) mkdirSync(directory);
  // Resolution uses this isolated executable; its contents must never run.
  const executable = path.join(bin, process.platform === "win32" ? "codex.exe" : "codex");
  writeFileSync(executable, "offline fixture must not execute\n");
  chmodSync(executable, 0o700);
  const environment = { CODEX_HOME: home, HOME: root, USERPROFILE: root, PATH: bin };
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-11-09T00:00:00Z",
  );
  // Codex's state database exists but has no row for a started thread until its first message.
  const database = new DatabaseSync(path.join(home, "state_1.sqlite"));
  cleanups.push(() => database.close());
  database.exec(
    "CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,thread_source TEXT)",
  );
  const commands = new Commands();
  vi.spyOn(commands, "run").mockRejectedValue(new Error("unexpected-native-command"));
  cleanups.push(() => commands.close());
  const readers = new SessionReaders(store.sessions, commands, environment, {} as CursorBridge);
  cleanups.push(() => readers.close());

  class OfflineAppServer extends EventEmitter {
    connected = true;
    async request(method: string, _params: unknown, onDispatch?: () => void): Promise<unknown> {
      onDispatch?.();
      if (method === "model/list")
        return { data: [{ model: "model-a", isDefault: true, supportedReasoningEfforts: [] }] };
      if (method === "thread/goal/get") return { goal: null };
      if (method === "skills/list") return { data: [] };
      if (method === "thread/start")
        return {
          thread: { id: threadId, cwd: workspace, turns: [], status: { type: "idle" } },
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
  }
  const app = new OfflineAppServer();
  vi.spyOn(CodexAppServerSession, "start").mockResolvedValue(
    app as unknown as CodexAppServerSession,
  );
  const web = new WebReadRequests(store, readers, root, () => 0n, environment);
  cleanups.push(async () => {
    web.close();
    await app.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  async function create() {
    const result = (await web.managedLifecycle({
      operation: "create",
      requestId: randomUUID(),
      deviceId: "fixture",
      workspaceId: "workspace",
      policyId: "workspace-write-on-request",
    })) as { sessionId: string };
    expect(result).toMatchObject({ accepted: true, completed: true });
    return result.sessionId;
  }
  /** What Codex writes with the first message: the state row and the rollout header. */
  function writeThread(headerId = threadId) {
    const rollout = path.join(home, "rollout.jsonl");
    writeFileSync(
      rollout,
      JSON.stringify({ type: "session_meta", payload: { id: headerId, cwd: workspace } }) + "\n",
    );
    database
      .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)")
      .run(threadId, rollout, workspace, "Fixture", "cli", "user");
  }
  function readStates() {
    const states = new ConversationReadStates(
      store,
      readers,
      root,
      environment,
      () => null,
      () => {},
      () => false,
    );
    cleanups.push(() => states.close());
    return states;
  }
  return { root, web, create, writeThread, readStates };
}

describe("a Codex thread started by AgentKib before its first message", () => {
  it("reads the new session's history before Codex writes the thread", async () => {
    const f = fixture();
    const sessionId = await f.create();
    expect(readManagedRecord(f.root, sessionId)).toMatchObject({ native_id: threadId });

    await expect(
      f.web.request({ operation: "events", sessionId, limit: 50 }),
    ).resolves.toMatchObject({ events: expect.any(Array) });
  });

  it("has nothing to read before Codex writes the thread", async () => {
    const f = fixture();
    const sessionId = await f.create();

    await expect(f.readStates().get(sessionId, "local")).resolves.toMatchObject({
      status: "read",
      freshness: "current",
      firstUnread: null,
      latestResult: null,
    });
  });

  it("still refuses a written thread whose rollout belongs to another thread", async () => {
    const f = fixture();
    const sessionId = await f.create();
    f.writeThread("11111111-2222-4333-8444-555555555555");

    await expect(f.web.request({ operation: "events", sessionId, limit: 50 })).rejects.toThrow(
      "unverified-session-identity",
    );
  });

  it("reads the history once Codex has written a matching thread", async () => {
    const f = fixture();
    const sessionId = await f.create();
    f.writeThread();

    await expect(
      f.web.request({ operation: "events", sessionId, limit: 50 }),
    ).resolves.toMatchObject({ events: expect.any(Array) });
  });
});
