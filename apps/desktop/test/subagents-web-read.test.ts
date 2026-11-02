// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { WebReadRequests } from "../../../packages/backend/src/web-read";
import { CodexFollowerState } from "../../../packages/backend/src/codex-follower-state";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexFollowerConnection } from "../../../packages/backend/src/codex-follower-connection";
import { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import { CodexRuntimePreflight } from "../../../packages/backend/src/codex-runtime-preflight";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";
import type { Commands } from "../../../packages/backend/src/commands";
import type { SubagentCatalog } from "@agentkib/runtime-protocol";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});
const write = (file: string, rows: unknown[]) =>
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-subagent-owner-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace"),
    home = path.join(root, "codex"),
    bin = path.join(root, "bin");
  for (const folder of [
    workspace,
    home,
    bin,
    path.join(home, "sessions"),
    path.join(home, "thread-writer-locks"),
  ])
    mkdirSync(folder, { recursive: true });
  const executable = path.join(bin, "codex");
  writeFileSync(executable, "synthetic executable", { mode: 0o700 });
  const nativeId = randomUUID(),
    childId = randomUUID(),
    transcript = path.join(home, "sessions", `${nativeId}.jsonl`),
    child = path.join(home, "sessions", `${childId}.jsonl`);
  write(transcript, [
    { type: "session_meta", payload: { id: nativeId, cwd: workspace, source: "cli" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "parent-turn" } },
    {
      type: "response_item",
      payload: { type: "SubAgentActivity", kind: "started", agent_thread_id: childId },
    },
  ]);
  write(child, [
    {
      type: "session_meta",
      payload: {
        id: childId,
        cwd: workspace,
        source: { subagent: { thread_spawn: { parent_thread_id: nativeId } } },
      },
    },
    { type: "event_msg", payload: { type: "task_started", turn_id: "child-turn" } },
    { type: "event_msg", payload: { type: "agent_message", message: "Synthetic child body" } },
  ]);
  const native = new DatabaseSync(path.join(home, "state_5.sqlite"));
  native.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,parent_thread_id TEXT,archived INTEGER)",
  );
  native
    .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?)")
    .run(nativeId, transcript, workspace, "Synthetic parent", "cli", null, 0);
  native
    .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?)")
    .run(
      childId,
      child,
      workspace,
      "Synthetic worker",
      JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: nativeId } } }),
      nativeId,
      0,
    );
  native.close();
  const environment = { CODEX_HOME: home, HOME: root, PATH: bin };
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Synthetic",
    "healthy",
    new Date().toISOString(),
  );
  const listing = new CodexSessions(environment).list(workspace);
  store.sessions.sync(
    "workspace",
    "codex",
    listing.sessions.map((source) => source.session),
  );
  const sessionId = store.sessions.id("codex", nativeId);
  const readers = new SessionReaders(store.sessions, {} as Commands, environment, {
    profiles: async () => [],
  });
  cleanups.push(() => readers.close());
  vi.spyOn(CodexRuntimePreflight.prototype, "check").mockResolvedValue({
    executable,
    reason: null,
  });
  vi.spyOn(CodexFollowerConnection, "supported").mockReturnValue(true);
  const nativeStart = vi
    .spyOn(CodexAppServerSession, "start")
    .mockRejectedValue(new Error("Read-only test must not start a writer"));
  cleanups.push(
    acquirePortableFileLease(path.join(home, "thread-writer-locks", `${nativeId}.lock`)),
  );
  let revision = 0;
  let state = new CodexFollowerState(nativeId, "synthetic-owner");
  const update = (turnId: string | null) => {
    state.notification({
      type: "broadcast",
      sourceClientId: state.ownerClientId,
      method: "thread-stream-state-changed",
      version: 11,
      params: {
        conversationId: nativeId,
        hostId: "local",
        change: {
          type: "snapshot",
          revision: ++revision,
          conversationState: {
            id: nativeId,
            hostId: "local",
            requests: [],
            threadRuntimeStatus: { type: turnId ? "active" : "idle" },
            turns: turnId ? [{ turnId, status: "inProgress", items: [] }] : [],
          },
        },
      },
    });
  };
  update("parent-turn");
  const connection = { clientId: randomUUID(), endpoint: path.join(home, "ipc", "ipc.sock") };
  const bridge = {
    connected: true,
    connection,
    get selectedState() {
      return state;
    },
    observeLive: async () => state,
    close: () => {
      bridge.connected = false;
    },
  };
  vi.spyOn(CodexFollowerBridge, "connect").mockResolvedValue(
    bridge as unknown as CodexFollowerBridge,
  );
  const web = new WebReadRequests(
    store,
    readers,
    root,
    () => 0n,
    environment,
    undefined,
    () => true,
  );
  cleanups.push(() => web.closeAsync());
  const list = () => web.request({ operation: "subagents", sessionId }) as Promise<SubagentCatalog>;
  return {
    web,
    list,
    update,
    child,
    transcript,
    sessionId,
    nativeStart,
    bridge,
    replaceOwner: () => {
      state = new CodexFollowerState(nativeId, "replacement-owner");
      revision = 0;
      update(null);
    },
  };
}

describe("read-only subagents through WebReadRequests", () => {
  it("connects verified Codex child history to the resident follower and keeps background runs across parent turns", async () => {
    const f = fixture();
    expect((await f.list()).agents[0].status).toBe("unknown");
    expect(
      await f.web.request({ operation: "live", sessionId: f.sessionId, experimentalEnabled: true }),
    ).toMatchObject({ executionMode: "codex-follower", status: "running" });
    expect((await f.list()).agents[0].status).toBe("running");
    f.update(null);
    expect((await f.list()).agents[0].status).toBe("running");
    f.update("new-parent-turn");
    expect((await f.list()).agents[0].status).toBe("running");
    const selected = (await f.list()).agents[0];
    expect(
      await f.web.request({
        operation: "subagent-events",
        sessionId: f.sessionId,
        subagentId: selected.id,
        limit: 50,
      }),
    ).toMatchObject({
      sessionId: f.sessionId,
      subagentId: selected.id,
      events: expect.arrayContaining([
        expect.objectContaining({ content: "Synthetic child body" }),
      ]),
    });
    appendFileSync(
      f.child,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: "child-turn" },
      }) + "\n",
    );
    expect((await f.list()).agents[0].status).toBe("completed");
    expect(f.nativeStart).not.toHaveBeenCalled();
  });
  it("drops child liveness when the follower owner changes on the same socket", async () => {
    const f = fixture();
    await f.web.request({ operation: "live", sessionId: f.sessionId, experimentalEnabled: true });
    expect((await f.list()).agents[0].status).toBe("running");
    f.replaceOwner();
    expect((await f.list()).agents[0].status).toBe("unknown");
    expect(f.nativeStart).not.toHaveBeenCalled();
  });
  it("drops child liveness immediately when the resident follower connection is lost", async () => {
    const f = fixture();
    await f.web.request({ operation: "live", sessionId: f.sessionId, experimentalEnabled: true });
    expect((await f.list()).agents[0].status).toBe("running");
    f.bridge.connected = false;
    expect((await f.list()).agents[0].status).toBe("unknown");
    expect(f.nativeStart).not.toHaveBeenCalled();
  });
});
