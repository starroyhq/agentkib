import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { Commands } from "../../../packages/backend/src/commands";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { Sql } from "../../../packages/backend/src/sql";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture(count = 1) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-codex-resolve-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const workspace = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(workspace);
  const environment = { CODEX_HOME: home, HOME: root, USERPROFILE: root, PATH: "" };
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Project",
    "healthy",
    "2026-11-12T00:00:00Z",
  );
  function database(directory: string, name = "state_1.sqlite") {
    mkdirSync(directory, { recursive: true });
    const db = new DatabaseSync(path.join(directory, name));
    cleanups.push(() => db.close());
    db.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,thread_source TEXT)",
    );
    return db;
  }
  const db = database(home);
  function add(nativeRef: string, target = db, file = path.join(home, `${nativeRef}.jsonl`)) {
    writeFileSync(
      file,
      JSON.stringify({
        type: "session_meta",
        payload: { id: nativeRef, cwd: workspace, source: "cli" },
      }) + "\n",
    );
    target
      .prepare("INSERT INTO threads VALUES(?,?,?,?,NULL,'user')")
      .run(nativeRef, file, workspace, nativeRef);
    return file;
  }
  for (let index = 0; index < count; index += 1) add(`thread-${index}`);
  const codex = new CodexSessions(environment);
  store.sessions.sync(
    "workspace",
    "codex",
    codex.list(workspace).sessions.map((source) => source.session),
  );
  const commands = new Commands();
  vi.spyOn(commands, "run").mockRejectedValue(new Error("unexpected-native-command"));
  cleanups.push(() => commands.close());
  function newReaders() {
    const readers = new SessionReaders(store.sessions, commands, environment, {} as CursorBridge);
    cleanups.push(() => readers.close());
    return readers;
  }
  const readers = newReaders();
  return {
    root,
    home,
    workspace,
    environment,
    store,
    codex,
    db,
    readers,
    newReaders,
    add,
    database,
  };
}

function trackThreadRows() {
  const queries: Array<{ sql: string; bindings: SQLInputValue[]; rows: number }> = [];
  const rows = Sql.prototype.rows;
  vi.spyOn(Sql.prototype, "rows").mockImplementation(function (this: Sql, sql, ...bindings) {
    const result = rows.call(this, sql, ...bindings);
    if (sql.includes(" FROM threads")) queries.push({ sql, bindings, rows: result.length });
    return result;
  });
  return queries;
}

describe("Codex single-thread resolution", () => {
  it("uses a bound native ID after the first opaque lookup without changing directory lists", async () => {
    const f = fixture(40);
    const id = f.store.sessions.id("codex", "thread-17");
    const queries = trackThreadRows();
    const first = await f.readers.resolve(id);
    expect(first.native.native_ref).toBe("thread-17");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatchObject({ bindings: [], rows: 40 });
    for (let index = 0; index < 8; index += 1) expect(await f.readers.resolve(id)).toEqual(first);
    expect(queries.slice(1)).toHaveLength(8);
    for (const query of queries.slice(1)) {
      expect(query.sql).toContain(" WHERE id=?");
      expect(query).toMatchObject({ bindings: ["thread-17"], rows: 1 });
    }
    expect(f.codex.list(f.workspace).sessions).toHaveLength(40);
    expect(queries.at(-1)).toMatchObject({ bindings: [], rows: 40 });
    expect(await f.newReaders().resolve(id)).toEqual(first);
    expect(queries.at(-1)).toMatchObject({ bindings: [], rows: 40 });
  });

  it("binds ID text rather than treating it as SQL", () => {
    const f = fixture(2);
    expect(f.codex.list(f.workspace, { nativeRef: "' OR 1=1 --" }).sessions).toEqual([]);
    expect(f.codex.list(f.workspace, { nativeRef: "thread-1" }).sessions).toHaveLength(1);
  });

  it("revalidates a changed working directory and current workspace root", async () => {
    const f = fixture();
    const id = f.store.sessions.id("codex", "thread-0");
    await f.readers.resolve(id);
    const outside = path.join(f.root, "outside");
    mkdirSync(outside);
    f.db.prepare("UPDATE threads SET cwd=?").run(outside);
    await expect(f.readers.resolve(id)).rejects.toThrow("transcript is no longer available");
    f.db.prepare("UPDATE threads SET cwd=?").run(f.workspace);
    expect((await f.readers.resolve(id)).workspace).toBe(f.workspace);
    f.store.sql.run("UPDATE workspaces SET canonical_path=? WHERE id='workspace'", outside);
    await expect(f.readers.resolve(id)).rejects.toThrow("transcript is no longer available");
  });

  it("rechecks projectless ownership and removed metadata after a successful lookup", async () => {
    const f = fixture();
    const id = f.store.sessions.id("codex", "thread-0");
    await f.readers.resolve(id);
    const state = path.join(f.home, ".codex-global-state.json");
    writeFileSync(state, JSON.stringify({ "projectless-thread-ids": ["thread-0"] }));
    await expect(f.readers.resolve(id)).rejects.toThrow("transcript is no longer available");
    f.store.sessions.sync(
      "session-collection:codex:projectless",
      "codex",
      f.codex.list(null, { collection: "projectless" }).sessions.map((source) => source.session),
    );
    expect((await f.readers.resolve(id)).summary.workspace_id).toBe(
      "session-collection:codex:projectless",
    );
    writeFileSync(state, "{}");
    await expect(f.readers.resolve(id)).rejects.toThrow("transcript is no longer available");
    writeFileSync(state, JSON.stringify({ "projectless-thread-ids": ["thread-0"] }));
    expect((await f.readers.resolve(id)).native.native_ref).toBe("thread-0");
    f.db.prepare("DELETE FROM threads WHERE id=?").run("thread-0");
    await expect(f.readers.resolve(id)).rejects.toThrow("transcript is no longer available");
  });

  it("uses the current Codex home and sqlite fallback rather than retaining transcript paths", async () => {
    const f = fixture();
    const id = f.store.sessions.id("codex", "thread-0");
    await f.readers.resolve(id);
    const home = path.join(f.root, "next-home");
    const next = f.database(path.join(home, "sqlite"));
    f.environment.CODEX_HOME = home;
    await expect(f.readers.resolve(id)).rejects.toThrow("transcript is no longer available");
    const file = f.add("thread-0", next, path.join(home, "replacement.jsonl"));
    expect((await f.readers.resolve(id)).transcript).toBe(file);
  });

  it("rereads replacement headers and follows rollout compression without caching file access", async () => {
    const f = fixture();
    const id = f.store.sessions.id("codex", "thread-0");
    const original = await f.readers.resolve(id);
    expect(original.native.origin).toBe("interactive");
    const file = original.transcript!;
    const replacement = `${file}.next`;
    writeFileSync(
      replacement,
      JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-0", cwd: f.workspace, source: "exec" },
      }) + "\n",
    );
    renameSync(replacement, file);
    expect((await f.readers.resolve(id)).native.origin).toBe("execution");
    writeFileSync(`${file}.zst`, zstdCompressSync(readFileSync(file)));
    rmSync(file);
    expect(await f.readers.resolve(id)).toMatchObject({
      transcript: `${file}.zst`,
      native: { origin: "execution", availability: "readable" },
    });
    rmSync(`${file}.zst`);
    expect((await f.readers.resolve(id)).native.availability).toBe("metadata-only");
  });

  it("does not allow a working-directory symlink to bypass the current workspace boundary", async () => {
    const f = fixture();
    const id = f.store.sessions.id("codex", "thread-0");
    await f.readers.resolve(id);
    const outside = path.join(f.root, "outside");
    const link = path.join(f.workspace, "linked");
    mkdirSync(outside);
    symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    f.db.prepare("UPDATE threads SET cwd=?").run(link);
    await expect(f.readers.resolve(id)).rejects.toThrow("transcript is no longer available");
  });

  it("preserves index precedence when the same thread is present in multiple databases", async () => {
    const f = fixture();
    const id = f.store.sessions.id("codex", "thread-0");
    const initial = await f.readers.resolve(id);
    const next = f.database(f.home, "state_2.sqlite");
    f.add("thread-0", next, path.join(f.home, "newer.jsonl"));
    const expected = f.codex.list(f.workspace).sessions[0];
    const resolved = await f.readers.resolve(id);
    expect(resolved.transcript).toBe(expected.transcript);
    expect(resolved.native).toEqual({ ...expected.session, cwd: expected.cwd });
    // An empty replacement index must not mask the remaining original index.
    next.prepare("DELETE FROM threads").run();
    expect(await f.readers.resolve(id)).toEqual(initial);
  });

  // Opt-in timing companion to the deterministic row-count regression above.
  // AGENTKIB_BENCHMARK_CODEX_LOOKUP=1 pnpm --filter @agentkib/desktop exec vitest run test/codex-session-resolve.test.ts
  if (process.env.AGENTKIB_BENCHMARK_CODEX_LOOKUP === "1") {
    it("measures repeated lookup against an isolated multi-workspace index", async () => {
      const threads = 5_000;
      const iterations = 60;
      const f = fixture(threads);
      // Only the target belongs to the current workspace; the old query still
      // materialized and HMAC-compared all metadata before filtering ownership.
      const update = f.db.prepare("UPDATE threads SET cwd=? WHERE id=?");
      for (let index = 1; index < threads; index += 1) {
        update.run(path.join(f.root, `project-${index % 50}`), `thread-${index}`);
      }
      const id = f.store.sessions.id("codex", "thread-0");
      const queries = trackThreadRows();
      const original = CodexSessions.prototype.list;
      const query = vi.spyOn(CodexSessions.prototype, "list");
      const results = [];
      for (const targeted of [false, true]) {
        query.mockImplementation(function (this: CodexSessions, workspace, selection = {}) {
          return original.call(
            this,
            workspace,
            targeted ? selection : { ...selection, nativeRef: undefined },
          );
        });
        await f.readers.resolve(id);
        queries.length = 0;
        const cpu = process.cpuUsage();
        const started = performance.now();
        for (let index = 0; index < iterations; index += 1) {
          const result = await f.readers.resolve(id);
          expect(result.native.native_ref).toBe("thread-0");
        }
        const elapsedMs = performance.now() - started;
        const used = process.cpuUsage(cpu);
        results.push({
          mode: targeted ? "targeted-id" : "full-index",
          elapsedMs: Math.round(elapsedMs),
          cpuMs: Math.round((used.user + used.system) / 1_000),
          sqliteRowsReturned: queries.reduce((sum, entry) => sum + entry.rows, 0),
          sqliteQueries: queries.length,
        });
      }
      expect(results[0].sqliteRowsReturned).toBe(threads * iterations);
      expect(results[1].sqliteRowsReturned).toBe(iterations);
      console.info(JSON.stringify({ threads, workspaces: 51, iterations, results }));
    }, 30_000);
  }
});
