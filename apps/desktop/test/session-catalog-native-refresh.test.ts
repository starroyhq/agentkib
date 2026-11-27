// @vitest-environment node
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0).reverse()) close();
});

const nativeId = "013a010f-2f4d-42dd-916d-a70a1e9b5678";
const created = "2026-11-27T10:00:00.000Z";
const updated = "2026-11-27T10:01:00.000Z";
const start = () => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-native-catalog-")));
  const workspace = path.join(home, "workspace");
  const claude = path.join(home, "claude");
  const projects = path.join(claude, "projects", "project");
  const codex = path.join(home, "codex");
  const devin = path.join(home, "devin");
  for (const folder of [workspace, projects, path.join(codex, "sessions"), path.join(devin, "cli")])
    mkdirSync(folder, { recursive: true });
  dispose.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new BackendStore(path.join(home, "agentkib.db"));
  dispose.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES (?,?,?,?,?)",
    "w",
    workspace,
    "Fixture",
    "healthy",
    created,
  );
  const commands = new Commands();
  dispose.push(() => commands.close());
  const readers = new SessionReaders(
    store.sessions,
    commands,
    {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: claude,
      CODEX_HOME: codex,
      DEVIN_SESSIONS_DIR: devin,
      PATH: path.join(home, "bin"),
    },
    { profiles: () => [] },
  );
  dispose.push(() => readers.close());
  const fullList = vi.spyOn(readers, "list");
  const waiters = new Set<() => void>();
  const index = new SessionIndex(
    store.sessions,
    readers,
    () => true,
    undefined,
    undefined,
    undefined,
    () => {
      for (const waiter of waiters) waiter();
    },
  );
  dispose.push(() => index.close());
  const read = () => store.sessions.list("w");
  type Rows = ReturnType<typeof read>;
  const next = (matches: (rows: Rows) => boolean, change: () => void) =>
    new Promise<Rows>((resolve) => {
      const inspect = () => {
        const rows = read();
        if (!matches(rows)) return;
        waiters.delete(inspect);
        resolve(rows);
      };
      waiters.add(inspect);
      change();
    });
  return { workspace, projects, codex, devin, fullList, next, read, store };
};

it("updates a Claude session from real transcript creation, rename, append and removal", async () => {
  const f = start();
  const file = path.join(f.projects, nativeId + ".jsonl");
  const rows = await f.next(
    (rows) => rows.length === 1,
    () =>
      writeFileSync(
        file,
        JSON.stringify({
          type: "user",
          cwd: f.workspace,
          sessionId: nativeId,
          uuid: nativeId,
          timestamp: created,
          message: { role: "user", content: "Original prompt" },
        }) + "\n",
      ),
  );
  const id = rows[0]!.id;
  await f.next(
    (rows) => rows.some((row) => row.id === id && row.title === "New title"),
    () => {
      appendFileSync(
        file,
        JSON.stringify({ type: "custom-title", sessionId: nativeId, customTitle: "New title" }) +
          "\n",
      );
    },
  );
  await f.next(
    (rows) =>
      rows.some((row) => row.id === id && Date.parse(row.updated_at ?? "") >= Date.parse(updated)),
    () => {
      appendFileSync(
        file,
        JSON.stringify({
          type: "assistant",
          cwd: f.workspace,
          sessionId: nativeId,
          uuid: "fixture-answer",
          timestamp: updated,
          message: { role: "assistant", content: [{ type: "text", text: "Reply" }] },
        }) + "\n",
      );
    },
  );
  await f.next(
    (rows) => rows.length === 0,
    () => unlinkSync(file),
  );
  expect(f.fullList).not.toHaveBeenCalled();
});

it("retains a previously indexed Claude title across transcript writes without a title record", async () => {
  const f = start();
  const file = path.join(f.projects, nativeId + ".jsonl");
  const assistant =
    JSON.stringify({
      type: "assistant",
      cwd: f.workspace,
      sessionId: nativeId,
      uuid: nativeId,
      timestamp: created,
      message: { role: "assistant", content: "Recorded reply" },
    }) + "\n";
  const [first] = await f.next(
    (rows) => rows.length === 1,
    () => writeFileSync(file, assistant),
  );
  f.store.sql.run(
    "UPDATE conversation_sessions SET title=? WHERE id=?",
    "Source decision",
    first!.id,
  );

  const [next] = await f.next(
    (rows) => rows.some((row) => row.id === first!.id && row.updated_at !== first!.updated_at),
    () => appendFileSync(file, assistant),
  );
  expect(next?.title).toBe("Source decision");
  await f.next(
    (rows) => rows.some((row) => row.id === first!.id && row.title === "Renamed decision"),
    () =>
      appendFileSync(
        file,
        JSON.stringify({
          type: "custom-title",
          sessionId: nativeId,
          customTitle: "Renamed decision",
        }) + "\n",
      ),
  );
});

it("reconciles Codex shared metadata once a WAL changes and preserves the row identity", async () => {
  const f = start();
  const rollout = path.join(f.codex, "sessions", nativeId + ".jsonl");
  const database = new DatabaseSync(path.join(f.codex, "state_5.sqlite"));
  dispose.push(() => database.close());
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT,
      archived INTEGER, created_at INTEGER, updated_at INTEGER);`);
  const expectRow =
    (title: string, archived = false) =>
    (rows: ReturnType<typeof f.read>) =>
      rows.some((row) => row.title === title && row.archived === archived);
  const rows = await f.next(expectRow("Initial"), () => {
    writeFileSync(
      rollout,
      JSON.stringify({
        type: "session_meta",
        payload: { id: nativeId, cwd: f.workspace, source: "cli" },
      }) + "\n",
    );
    database
      .prepare("INSERT INTO threads VALUES(?,?,?,?,?,0,?,?)")
      .run(
        nativeId,
        rollout,
        f.workspace,
        "Initial",
        "cli",
        Date.parse(created) / 1000,
        Date.parse(created) / 1000,
      );
  });
  const id = rows[0]!.id;
  const [row] = await f.next(expectRow("Automatic title", true), () => {
    database
      .prepare("UPDATE threads SET title=?, archived=1, updated_at=?")
      .run("Automatic title", Date.parse(updated) / 1000);
  });
  expect(row).toMatchObject({ id, updated_at: "2026-11-27T10:01:00Z" });
  await f.next(
    (rows) => rows.length === 0,
    () => database.exec("DELETE FROM threads"),
  );
  expect(f.fullList).not.toHaveBeenCalled();
}, 15_000);

it("pushes Devin discovery, title and activity from committed SQLite metadata changes", async () => {
  const f = start();
  const database = new DatabaseSync(path.join(f.devin, "cli", "sessions.db"));
  dispose.push(() => database.close());
  database.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, working_directory TEXT, title TEXT, hidden INTEGER,
      created_at INTEGER, last_activity_at INTEGER);`);
  await f.next(
    (rows) => rows.some((row) => row.title === "New Devin"),
    () => {
      database
        .prepare("INSERT INTO sessions VALUES(?,?,?,0,?,?)")
        .run(nativeId, f.workspace, "New Devin", Date.parse(created), Date.parse(created));
    },
  );
  await f.next(
    (rows) =>
      rows.some(
        (row) =>
          row.title === "Renamed Devin" && Date.parse(row.updated_at ?? "") === Date.parse(updated),
      ),
    () =>
      database
        .prepare("UPDATE sessions SET title=?, last_activity_at=?")
        .run("Renamed Devin", Date.parse(updated)),
  );
  await f.next(
    (rows) => rows.length === 0,
    () => database.exec("DELETE FROM sessions"),
  );
  expect(f.fullList).not.toHaveBeenCalled();
}, 15_000);
