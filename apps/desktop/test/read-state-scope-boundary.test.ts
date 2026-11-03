// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationReadStates } from "../../../packages/backend/src/conversation-read-state";
import { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import { BackendStore } from "../../../packages/backend/src/store";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { Commands } from "../../../packages/backend/src/commands";
import { saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function fixture(indexed: boolean) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-read-scope-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    workspace = path.join(root, "allowed"),
    outside = path.join(root, "other-project"),
    bin = path.join(root, "bin");
  for (const directory of [home, workspace, outside, bin, path.join(home, "sessions")])
    mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(bin, "codex"), "offline", { mode: 0o700 });
  const nativeId = randomUUID(),
    file = path.join(home, "sessions", `${nativeId}.jsonl`);
  const transcript = (cwd: string) =>
    [
      { type: "session_meta", payload: { id: nativeId, cwd, source: "cli" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n";
  writeFileSync(file, transcript(workspace));
  const nativeDb = new DatabaseSync(path.join(home, "state_5.sqlite"));
  cleanups.push(() => nativeDb.close());
  nativeDb.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,archived INTEGER)",
  );
  nativeDb
    .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)")
    .run(nativeId, file, workspace, "Fixture", "cli", 0);
  const environment = { HOME: root, CODEX_HOME: home, PATH: bin };
  const store = new BackendStore(path.join(root, "backend.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Allowed",
    "healthy",
    "2026-11-03T00:00:00Z",
  );
  if (indexed)
    store.sessions.sync(
      "workspace",
      "codex",
      new CodexSessions(environment).list(workspace).sessions.map((source) => source.session),
    );
  const id = indexed ? store.sessions.id("codex", nativeId) : "managed";
  if (!indexed)
    saveManagedRecord(root, {
      id,
      workspace_id: "workspace",
      workspace,
      home,
      native_id: nativeId,
      title: "Fixture",
      created_at: "2026-11-03T00:00:00Z",
      released: false,
      adopted: true,
    });
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const readers = new SessionReaders(store.sessions, commands, environment, {
    profiles: () => [],
  } as unknown as CursorBridge);
  cleanups.push(() => readers.close());
  let unread = true,
    reads = 0,
    failAtRead = Infinity;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/read") {
      if (++reads === failAtRead) throw new Error("temporary native read transport failure");
      const row = nativeDb.prepare("SELECT cwd FROM threads WHERE id=?").get(nativeId) as {
        cwd: string;
      };
      return {
        thread: { id: nativeId, cwd: row.cwd },
        readState: {
          revision: unread ? "one" : "two",
          firstUnread: unread ? { type: "turn", turnId: "turn" } : null,
        },
      };
    }
    if (method === "thread/turns/list")
      return { data: [{ id: "turn", status: "completed", completedAt: 1 }] };
    if (method === "thread/readState/update") {
      unread = false;
      return { readState: { revision: "two", firstUnread: null } };
    }
    throw new Error(`unexpected native operation ${method}`);
  });
  const session = Object.assign(new EventEmitter(), { request, close: async () => {} });
  vi.spyOn(CodexAppServerSession, "start").mockResolvedValue(
    session as unknown as CodexAppServerSession,
  );
  const owner = new ConversationReadStates(
    store,
    readers,
    root,
    environment,
    () => null,
    () => {},
    () => false,
  );
  cleanups.push(() => owner.close());
  return {
    id,
    owner,
    readers,
    request,
    moveOutside() {
      nativeDb.prepare("UPDATE threads SET cwd=? WHERE id=?").run(outside, nativeId);
      writeFileSync(file, transcript(outside));
    },
    failWritePreflight() {
      // update() first observes a complete snapshot (two reads), then rechecks immediately before writing.
      failAtRead = reads + 3;
    },
  };
}
describe("read-state native identity boundaries", () => {
  it("refuses an unindexed managed thread whose native cwd moved outside its registered workspace", async () => {
    const f = fixture(false),
      before = await f.owner.get(f.id, "account:owner");
    expect(before.status).toBe("unread");
    f.moveOutside();
    await expect(
      f.owner.update(f.id, "account:owner", before.version!, before.latestResult!.id),
    ).rejects.toThrow("read-state-unavailable");
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/readState/update"),
    ).toHaveLength(0);
  });
  it("refuses an indexed thread moved after resolving its authorized source, before verifying native cwd", async () => {
    const f = fixture(true),
      before = await f.owner.get(f.id, "account:owner");
    const resolve = f.readers.resolve.bind(f.readers);
    vi.spyOn(f.readers, "resolve").mockImplementationOnce(async (id) => {
      const source = await resolve(id);
      f.moveOutside();
      return source;
    });
    await expect(
      f.owner.update(f.id, "account:owner", before.version!, before.latestResult!.id),
    ).rejects.toThrow("read-state-unavailable");
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/readState/update"),
    ).toHaveLength(0);
  });
  it("normalizes native read transport failure immediately before a write without dispatching an update", async () => {
    const f = fixture(true),
      before = await f.owner.get(f.id, "account:owner");
    f.failWritePreflight();
    await expect(
      f.owner.update(f.id, "account:owner", before.version!, before.latestResult!.id),
    ).rejects.toThrow("read-state-unavailable");
    expect(
      f.request.mock.calls.filter(([method]) => method === "thread/readState/update"),
    ).toHaveLength(0);
  });
});
