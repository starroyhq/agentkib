import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendStore } from "../../../packages/backend/src/store";
import { HermesSessions } from "../../../packages/backend/src/hermes-sessions";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { RuntimeRouter } from "../electron/main/runtime-router";
import { createStdioTransport, type RuntimeTransport } from "../electron/main/runtime-transport";
import {
  HISTORY_SEARCH_METHODS as methods,
  RUNTIME_METHODS,
  type HistorySearchResult,
  type HistorySearchStatus,
  type HistoryLocatedRecord,
} from "@agentkib/runtime-protocol";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
});
const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as {
  createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv;
};
const timestamp = "2026-10-08T00:00:00Z";

async function fixture(
  slow: boolean | "query" | "owner" = false,
  agent: "claude-code" | "hermes" = "claude-code",
) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "history-runtime-")));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const dataDir = path.join(root, "data"),
    project = path.join(root, "project"),
    dist = path.join(root, "dist"),
    bin = path.join(root, "bin");
  const history = path.join(root, ".claude/projects/synthetic");
  await Promise.all(
    [project, dist, bin, history, path.join(root, "tmp")].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  const native = randomUUID(),
    userId = randomUUID(),
    answerId = randomUUID(),
    file = path.join(history, `${native}.jsonl`);
  const body =
    "Beginning. " + "ordinary filler ".repeat(22_000) + " runtime-marker-8de29 🙂 unicode end";
  const values = [
    {
      type: "user",
      uuid: userId,
      parentUuid: null,
      sessionId: native,
      cwd: project,
      timestamp,
      message: { role: "user", content: "Where is the previous decision?" },
    },
    {
      type: "assistant",
      uuid: answerId,
      parentUuid: userId,
      sessionId: native,
      cwd: project,
      timestamp,
      message: { role: "assistant", content: body },
    },
  ];
  if (agent === "claude-code")
    await fs.writeFile(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const environment = {
    ...createIsolatedWorkerEnvironment(root),
    PATH: bin,
    // These tests change a source and expect the next refresh to index it at once.
    AGENTKIB_SEARCH_PASS_INTERVAL_MS: "0",
    AGENTKIB_SEARCH_RETRY_WAIT_MS: "0",
  };
  let nativeDatabase: DatabaseSync | undefined;
  if (agent === "hermes") {
    const home = path.join(root, ".hermes");
    await fs.mkdir(home);
    environment.HERMES_HOME = home;
    nativeDatabase = new DatabaseSync(path.join(home, "state.db"));
    cleanup.push(async () => nativeDatabase!.close());
    nativeDatabase.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
      CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,started_at TEXT,updated_at TEXT);
      CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT,timestamp TEXT);`);
    nativeDatabase
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
      .run(native, "Fixture", project, timestamp, timestamp);
    nativeDatabase
      .prepare("INSERT INTO messages VALUES(?,?,?,?)")
      .run(native, "assistant", "runtime-marker-8de29 original body", timestamp);
  }
  const store = new BackendStore(path.join(dataDir, "agentkib.db"));
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "fixture",
    project,
    "Fixture",
    "fixture",
    "healthy",
    timestamp,
  );
  const summaries =
    agent === "hermes"
      ? new HermesSessions(environment).list(project).sessions.map((source) => source.session)
      : [
          {
            native_ref: native,
            agent: "claude-code",
            title: "Fixture",
            created_at: timestamp,
            updated_at: timestamp,
            message_count: 2,
            git_branch: null,
            archived: false,
            sidechain: false,
            availability: "readable",
            origin: "interactive",
          },
        ];
  expect(summaries).toHaveLength(1);
  store.sessions.sync("fixture", agent, summaries);
  const sessionId = store.sessions.id(agent, summaries[0]!.native_ref);
  store.close();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  await fs.writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
      session_index_enabled: true,
    }),
  );
  for (const name of await fs.readdir("dist-electron"))
    if (name.startsWith("backend") && name.endsWith(".cjs"))
      await fs.copyFile(path.join("dist-electron", name), path.join(dist, name));
  if (process.platform === "win32")
    await fs.cp("dist-electron/native", path.join(dist, "native"), { recursive: true });
  const marker = path.join(root, slow === "query" ? "query-entered" : "index-entered");
  if (slow) {
    await fs.rename(
      path.join(dist, "backend-history-search.cjs"),
      path.join(dist, "history-real.cjs"),
    );
    await fs.writeFile(
      path.join(dist, "backend-history-search.cjs"),
      slow === "owner"
        ? `
const fs=require('node:fs'),{workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const prepare=DatabaseSync.prototype.prepare;let changed=false;
DatabaseSync.prototype.prepare=function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  if(workerData.writable&&sql.includes('FROM sessions ORDER BY rowid DESC')){
    const all=statement.all;
    statement.all=function(...bindings){
      const rows=all.apply(this,bindings);
      if(!changed){
        changed=true;
        const native=new DatabaseSync(${JSON.stringify(path.join(root, ".hermes/state.db"))});
        try{
          native.prepare('UPDATE sessions SET cwd=?').run(${JSON.stringify(path.join(root, "other"))});
          native.prepare('UPDATE messages SET content=?').run('FOREIGN_WORKSPACE_BODY');
          fs.writeFileSync(${JSON.stringify(marker)},'native owner changed');
        }finally{native.close()}
      }
      return rows;
    };
  }
  return statement;
};
require('./history-real.cjs');`
        : slow === "query"
          ? `
const fs=require('node:fs'),{workerData,threadId}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
const prepare=DatabaseSync.prototype.prepare;let held=false;
DatabaseSync.prototype.prepare=function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  if(!workerData.writable&&sql.includes('FROM chunks c JOIN sessions')&&!sql.includes('chunks_fts')){
    const iterate=statement.iterate;
    statement.iterate=function(...bindings){
      const iterator=iterate.apply(this,bindings),next=iterator.next;
      iterator.next=function(...values){
        const row=next.apply(this,values);
        if(!held&&!row.done){
          held=true;
          fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({threadId,writable:workerData.writable,sessionId:row.value.session_id}));
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200);
        }
        return row;
      };
      return iterator;
    };
  }
  return statement;
};
require('./history-real.cjs');`
          : `
const fs=require('node:fs'),{workerData}=require('node:worker_threads');
const original=fs.readSync;let held=false;
fs.readSync=function(...args){if(workerData.writable&&!held){held=true;fs.writeFileSync(${JSON.stringify(marker)},'indexing');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1200)}return original.apply(this,args)};
require('./history-real.cjs');`,
    );
  }
  let transport: RuntimeTransport | undefined;
  const host = new DesktopRuntimeHost({
    executablePath: process.execPath,
    args: [path.join(dist, "backend.cjs")],
    clientVersion: "0.15.1",
    maxRestarts: 0,
    // Keep the real transport while excluding the host's inherited Agent settings.
    createTransport: (options) => (transport = createStdioTransport({ ...options, environment })),
  });
  const router = new RuntimeRouter(host, dataDir);
  cleanup.push(async () => {
    await router.stop();
    // File cleanup may retry a Windows image lock, but must not hide a live Runtime.
    expect(transport?.hasExited).toBe(true);
  });
  await router.start();
  const request = <T = unknown>(method: string, params: Record<string, unknown> = {}) =>
    router.request<T>(method, params);
  const status = () => request<HistorySearchStatus>(methods.status);
  const query = () =>
    request<HistorySearchResult>(methods.query, { query: "runtime-marker-8de29" });
  const ready = async () =>
    vi.waitFor(
      async () => {
        const result = await query();
        expect(result.hits.length).toBeGreaterThan(0);
        return result;
      },
      { timeout: 10_000, interval: 30 },
    );
  const enable = async () => {
    await request(methods.configure, { enabled: true });
    return ready();
  };
  return {
    root,
    file,
    values,
    dataDir,
    marker,
    request,
    status,
    query,
    ready,
    enable,
    sessionId,
    nativeDatabase,
  };
}

describe("history search runtime lifecycle", () => {
  it("never publishes a foreign native body under the cached workspace during indexing", async () => {
    const f = await fixture("owner", "hermes");
    await fs.mkdir(path.join(f.root, "other"));
    await f.request(methods.configure, { enabled: true });
    await vi.waitFor(
      async () => {
        expect(await fs.readFile(f.marker, "utf8")).toBe("native owner changed");
        const state = await f.status();
        expect(state.coverage.unavailable).toBe(1);
        expect(state.coverage.limitations).toContain("source-owner-changed");
      },
      { timeout: 10_000, interval: 30 },
    );
    for (const query of ["FOREIGN_WORKSPACE_BODY", "runtime-marker-8de29"])
      expect(
        (
          await f.request<HistorySearchResult>(methods.query, {
            query,
            allowedSessionIds: [f.sessionId],
          })
        ).hits,
      ).toEqual([]);
    const cache = new DatabaseSync(path.join(f.dataDir, "session-search.sqlite"), {
      readOnly: true,
    });
    try {
      expect(cache.prepare("SELECT COUNT(*) AS count FROM chunks").get()?.count).toBe(0);
    } finally {
      cache.close();
    }
  }, 20_000);
  it.each(["claude-code", "hermes"] as const)(
    "preserves %s NUL text through the real Router, Workers and reference preview",
    async (agent) => {
      const f = await fixture(false, agent);
      const content = "runtime-marker-8de29 before\0AFTER_NUL_TOKEN🙂\0ending";
      if (f.nativeDatabase) f.nativeDatabase.prepare("UPDATE messages SET content=?").run(content);
      else {
        f.values[1]!.message.content = content;
        await fs.writeFile(
          f.file,
          f.values.map((value) => JSON.stringify(value)).join("\n") + "\n",
        );
      }
      await f.enable();
      for (const query of ["NU", "NUL_TOKEN", "\0AFTER", "🙂\0e"]) {
        const result = await f.request<HistorySearchResult>(methods.query, { query });
        expect(result.hits).toHaveLength(1);
        const location = result.hits[0]!.location;
        const located = await f.request<HistoryLocatedRecord>(methods.locate, { location });
        expect(located.content).toBe(content);
        const resolved = await f.request<{ references: Array<{ content: string }>; text: string }>(
          methods.references,
          {
            references: [
              { ...location, start: 0, end: content.length, contentHash: located.contentHash },
            ],
          },
        );
        expect(resolved.references[0]!.content).toBe(content);
        expect(resolved.text).toContain(content);
        expect(result.status.coverage.ready).toBe(1);
      }
    },
    20_000,
  );
  it("withdraws a cached source when structured redaction fails instead of retaining searchable stale text", async () => {
    const f = await fixture();
    const initial = await f.enable();
    const oldLocation = initial.hits[0]!.location;
    const marker = "synthetic-password-must-not-be-cached";
    // Native Workers have a larger stack than Vitest; stay within the record limit
    // while reliably exhausting structured redaction in the real packaged worker.
    f.values[1]!.message.content =
      "[".repeat(25_000) + JSON.stringify({ password: marker }) + "]".repeat(25_000);
    expect(Buffer.byteLength(f.values[1]!.message.content)).toBeLessThan(64 * 1024);
    await fs.writeFile(f.file, f.values.map((value) => JSON.stringify(value)).join("\n") + "\n");
    await f.request(RUNTIME_METHODS.refreshWorkspaceSessions, {
      workspaceId: "fixture",
      force: true,
    });
    await vi.waitFor(
      async () => {
        expect((await f.status()).coverage).toMatchObject({ unavailable: 1, stale: 0, ready: 0 });
      },
      { timeout: 10_000, interval: 30 },
    );
    for (const query of [marker, "runtime-marker-8de29"])
      expect((await f.request<HistorySearchResult>(methods.query, { query })).hits).toEqual([]);
    await expect(f.request(methods.locate, { location: oldLocation })).rejects.toThrow(
      "history-source-stale",
    );
    const cache = new DatabaseSync(path.join(f.dataDir, "session-search.sqlite"), {
      readOnly: true,
    });
    try {
      expect(cache.prepare("SELECT COUNT(*) AS count FROM chunks").get()?.count).toBe(0);
    } finally {
      cache.close();
    }
  }, 20_000);
  it("invalidates quoted source labels after a WAL-only rename before generating new send text", async () => {
    const f = await fixture(false, "hermes");
    const previous = await f.enable(),
      location = previous.hits[0]!.location;
    const located = await f.request<HistoryLocatedRecord>(methods.locate, { location });
    const reference = {
      ...location,
      start: 0,
      end: located.content.length,
      contentHash: located.contentHash,
    };
    const preview = await f.request<{ text: string }>(methods.references, {
      references: [reference],
    });
    expect(preview.text).toContain("[History reference: Fixture · hermes · assistant]");
    f.nativeDatabase!.prepare("UPDATE sessions SET title=?").run("Renamed source");
    // Source validation must use native metadata before the catalog has refreshed.
    await expect(f.request(methods.references, { references: [reference] })).rejects.toThrow(
      "history-source-stale",
    );
    await expect(f.request(methods.locate, { location })).rejects.toThrow("history-source-stale");
    await f.request(RUNTIME_METHODS.refreshWorkspaceSessions, {
      workspaceId: "fixture",
      force: true,
    });
    const current = await vi.waitFor(
      async () => {
        const result = await f.query();
        expect(result.hits[0]?.title).toBe("Renamed source");
        expect(result.hits[0]?.location.sourceRevision).not.toBe(location.sourceRevision);
        expect(result.status.coverage.ready).toBe(1);
        return result.hits[0]!;
      },
      { timeout: 10_000, interval: 30 },
    );
    await expect(f.request(methods.references, { references: [reference] })).rejects.toThrow(
      "history-source-stale",
    );
    await expect(f.request(methods.locate, { location })).rejects.toThrow("history-source-stale");
    expect(current.location.sourceRevision).not.toBe(location.sourceRevision);
    const next = await f.request<HistoryLocatedRecord>(methods.locate, {
      location: current.location,
    });
    expect(next.content).toBe(located.content);
    const confirmed = await f.request<{ text: string }>(methods.references, {
      references: [
        { ...current.location, start: 0, end: next.content.length, contentHash: next.contentHash },
      ],
    });
    expect(confirmed.text).toBe(preview.text.replace("Fixture", "Renamed source"));
  }, 20_000);
  it("leaves an unchanged transcript alone and writes only the turn appended to it", async () => {
    const f = await fixture();
    await f.enable();
    const cache = new DatabaseSync(path.join(f.dataDir, "session-search.sqlite"), {
      readOnly: true,
    });
    cleanup.push(async () => cache.close());
    const rows = () =>
      cache
        .prepare("SELECT id FROM chunks ORDER BY ordinal,start")
        .all()
        .map((row) => Number(row.id));
    const committed = () =>
      cache.prepare("SELECT generation,source_revision,indexed_at FROM sessions").get();
    const refresh = () =>
      f.request(RUNTIME_METHODS.refreshWorkspaceSessions, { workspaceId: "fixture", force: true });
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
    // The body is long enough to span several chunks.
    const before = rows();
    expect(before.length).toBeGreaterThan(10);
    // The first listing replaces the synthetic summary; its text is the same, so no row moves.
    await refresh();
    await settle();
    expect(rows()).toEqual(before);
    const first = committed();
    expect(cache.prepare("SELECT COUNT(*) AS count FROM source_stamps").get()?.count).toBe(1);
    for (let pass = 0; pass < 3; pass++) await refresh();
    await settle();
    expect(rows()).toEqual(before);
    expect(committed()).toEqual(first);
    const appended = {
      ...f.values[1]!,
      uuid: randomUUID(),
      parentUuid: f.values[1]!.uuid,
      message: { role: "assistant", content: "appended-turn-5c1e marker" },
    };
    await fs.appendFile(f.file, JSON.stringify(appended) + "\n");
    await refresh();
    await vi.waitFor(
      async () => {
        const result = await f.request<HistorySearchResult>(methods.query, {
          query: "appended-turn-5c1e",
        });
        expect(result.hits).toHaveLength(1);
      },
      { timeout: 10_000, interval: 30 },
    );
    const after = rows();
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect((await f.query()).hits.length).toBeGreaterThan(0);
  }, 20_000);
  it("refreshes changed SQLite WAL bodies even when directory summaries are identical", async () => {
    const f = await fixture(false, "hermes");
    const previous = await f.enable();
    const oldLocation = previous.hits[0]!.location;
    const before = await f.request<unknown[]>(RUNTIME_METHODS.workspaceSessions, {
      workspaceId: "fixture",
    });
    f.nativeDatabase!.prepare("UPDATE messages SET content=?").run(
      "wal-replacement-71ac changed body",
    );
    const after = await f.request<unknown[]>(RUNTIME_METHODS.refreshWorkspaceSessions, {
      workspaceId: "fixture",
      force: true,
    });
    expect(after).toEqual(before);
    await vi.waitFor(
      async () => {
        const result = await f.request<HistorySearchResult>(methods.query, {
          query: "wal-replacement-71ac",
        });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]!.location.sourceRevision).not.toBe(oldLocation.sourceRevision);
        expect(result.status.coverage.ready).toBe(1);
      },
      { timeout: 10_000, interval: 30 },
    );
    expect((await f.query()).hits).toEqual([]);
    await expect(f.request(methods.locate, { location: oldLocation })).rejects.toThrow(
      "history-source-stale",
    );
    expect(f.nativeDatabase!.prepare("SELECT content FROM messages").get()?.content).toBe(
      "wal-replacement-71ac changed body",
    );
  }, 20_000);
  it("defaults off and resolves a full-body hit through location and explicit references", async () => {
    const f = await fixture();
    expect((await f.status()).enabled).toBe(false);
    expect((await f.query()).hits).toEqual([]);
    await expect(fs.stat(path.join(f.dataDir, "session-search.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const result = await f.enable(),
      hit = result.hits[0];
    expect(hit.location.sessionId).toBe(f.sessionId);
    expect(hit.snippet).toContain("runtime-marker-8de29");
    const location = hit.location;
    const located = await f.request<HistoryLocatedRecord>(methods.locate, { location });
    expect(located.content).toContain("runtime-marker-8de29");
    expect(Buffer.byteLength(located.content)).toBeLessThanOrEqual(16 * 1024);
    const start = located.content.indexOf("runtime-marker-8de29"),
      end = start + "runtime-marker-8de29".length;
    const reference = { ...location, start, end, contentHash: located.contentHash };
    const resolved = await f.request<{ references: Array<{ content: string }>; text: string }>(
      methods.references,
      { references: [reference] },
    );
    expect(resolved.references[0].content).toBe("runtime-marker-8de29");
    expect(resolved.text).toContain("[History reference:");
    expect(
      (
        await f.request<HistorySearchResult>(methods.query, {
          query: "runtime-marker-8de29",
          allowedSessionIds: [],
        })
      ).hits,
    ).toEqual([]);
    await expect(f.request(methods.locate, { location, allowedSessionIds: [] })).rejects.toThrow(
      "history-source-unavailable",
    );
    await fs.appendFile(
      f.file,
      JSON.stringify({
        type: "assistant",
        uuid: randomUUID(),
        parentUuid: f.values[1].uuid,
        sessionId: f.values[1].sessionId,
        cwd: f.values[1].cwd,
        timestamp,
        message: { role: "assistant", content: "source changed" },
      }) + "\n",
    );
    await expect(f.request(methods.locate, { location })).rejects.toThrow("history-source-stale");
    await expect(f.request(methods.references, { references: [reference] })).rejects.toThrow(
      "history-source-stale",
    );
  }, 20_000);

  it("clears the derived cache, rebuilds it and removes workspace-owned visibility immediately", async () => {
    const f = await fixture();
    await f.enable();
    await f.request(methods.clear);
    await expect(fs.stat(path.join(f.dataDir, "session-search.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await f.query()).hits).toEqual([]);
    await f.request(methods.refresh);
    await f.ready();
    await f.request(RUNTIME_METHODS.excludeWorkspace, { id: "fixture" });
    expect((await f.query()).hits).toEqual([]);
    expect((await f.status()).coverage.total).toBe(0);
  }, 20_000);

  it("clears bodies with the global session-index switch and requires it before enabling content search", async () => {
    const f = await fixture();
    await f.enable();
    await f.request(RUNTIME_METHODS.setSessionIndexEnabled, { enabled: false });
    expect((await f.status()).enabled).toBe(false);
    expect((await f.query()).hits).toEqual([]);
    await expect(fs.stat(path.join(f.dataDir, "session-search.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(f.request(methods.configure, { enabled: true })).rejects.toThrow("index-disabled");
  }, 20_000);

  it("keeps ordinary RPC responsive during ingestion and fences a disabled in-flight build", async () => {
    const f = await fixture(true);
    await f.request(methods.configure, { enabled: true });
    await vi.waitFor(async () => expect(await fs.readFile(f.marker, "utf8")).toBe("indexing"), {
      timeout: 5000,
    });
    const start = performance.now();
    await f.request(RUNTIME_METHODS.workspaceSessions, { workspaceId: "fixture" });
    expect(performance.now() - start).toBeLessThan(800);
    await f.request(methods.configure, { enabled: false });
    expect((await f.status()).enabled).toBe(false);
    expect((await f.query()).hits).toEqual([]);
    await expect(fs.stat(path.join(f.dataDir, "session-search.sqlite"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  }, 20_000);

  it("keeps ordinary reads below one second during a short-term scan and isolates cancelled queries", async () => {
    const f = await fixture("query");
    await f.enable();
    const requestId = randomUUID();
    let settled = false;
    const old = f.request<HistorySearchResult>(methods.query, { query: "a", requestId }).then(
      (result) => {
        settled = true;
        return { accepted: true, result };
      },
      (error: unknown) => {
        settled = true;
        return { accepted: false, error };
      },
    );
    // The pause is inside the packaged read Worker's real SQLite iterator,
    // immediately before the scan checkpoint, rather than in the Backend loop.
    await vi.waitFor(
      async () => {
        const entered = JSON.parse(await fs.readFile(f.marker, "utf8")) as {
          threadId: number;
          writable: boolean;
          sessionId: string;
        };
        expect(entered.threadId).toBeGreaterThan(0);
        expect(entered).toMatchObject({ writable: false, sessionId: f.sessionId });
      },
      { timeout: 5000, interval: 10 },
    );
    expect(settled).toBe(false);
    const timings: Record<string, number> = {};
    async function measured<T>(method: string, params: Record<string, unknown> = {}) {
      const start = performance.now();
      const result = await f.request<T>(method, params);
      timings[method] = performance.now() - start;
      expect(timings[method]).toBeLessThan(1000);
      return result;
    }
    const [runtime, workspaces, sessions] = await Promise.all([
      measured<{ app_name: string }>(RUNTIME_METHODS.runtimeInfo),
      measured<Array<{ id: string }>>(RUNTIME_METHODS.listWorkspaces),
      measured<Array<{ id: string }>>(RUNTIME_METHODS.workspaceSessions, {
        workspaceId: "fixture",
      }),
    ]);
    expect(runtime.app_name).toBe("AgentKib");
    expect(workspaces).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "fixture" })]),
    );
    expect(sessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: f.sessionId })]),
    );
    expect(settled).toBe(false);
    const next = f.request<HistorySearchResult>(methods.query, {
      query: "runtime-marker-8de29",
      requestId: randomUUID(),
    });
    await f.request(methods.cancel, { requestId });
    expect(await old).toMatchObject({ accepted: false, error: expect.any(Error) });
    const result = await next;
    expect(result.hits).toEqual([
      expect.objectContaining({ snippet: expect.stringContaining("runtime-marker-8de29") }),
    ]);
    // A late repeated cancellation only addresses the retired old read.
    await f.request(methods.cancel, { requestId });
    const short = await f.request<HistorySearchResult>(methods.query, {
      query: "or",
      requestId: randomUUID(),
    });
    expect(short.hits).toEqual([
      expect.objectContaining({ location: expect.objectContaining({ sessionId: f.sessionId }) }),
    ]);
    console.info("short-term scan ordinary RPC latency (ms)", timings);
  }, 20_000);
});
