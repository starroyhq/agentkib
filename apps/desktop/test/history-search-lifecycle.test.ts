// @vitest-environment node
import { mkdtemp, realpath, writeFile, rm, stat, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  HISTORY_SEARCH_METHODS as methods,
  type HistoryLocatedRecord,
  type HistorySearchResult,
  type HistorySearchStatus,
} from "@agentkib/runtime-protocol";
import { HistorySearch } from "../../../packages/backend/src/history-search";
import {
  HistorySearchStore,
  contentHash,
} from "../../../packages/backend/src/history-search-store";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { BackendStore } from "../../../packages/backend/src/store";
import { HermesSessions } from "../../../packages/backend/src/hermes-sessions";
import { OpenClawSessions } from "../../../packages/backend/src/openclaw-sessions";
import { CursorSessions } from "../../../packages/backend/src/cursor-sessions";
import { HistorySearchWorker } from "../../../packages/backend/src/history-search-worker";

// These cases start real workers and reopen SQLite caches; Windows CI can spend
// several seconds in that setup before reaching the ownership assertions.
vi.setConfig({ testTimeout: 15_000 });
const waitForIndexing = (assertion: () => Promise<void>) =>
  vi.waitFor(assertion, { timeout: 5000 });

const tracked = vi.hoisted(() => ({ workers: [] as import("node:worker_threads").Worker[] }));
vi.mock("node:worker_threads", async (original) => {
  const actual = await original<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        tracked.workers.push(this);
      }
    },
  };
});
const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  // A regression must fail the assertion, not leave the test runner hanging.
  await Promise.all(tracked.workers.splice(0).map((worker) => worker.terminate()));
});

async function ownershipFixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "history-owner-read-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "hermes"),
    project = path.join(root, "project"),
    other = path.join(root, "other");
  await Promise.all([home, project, other].map((directory) => mkdir(directory)));
  const native = new DatabaseSync(path.join(home, "state.db"));
  cleanups.push(() => native.close());
  native.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT,title TEXT,cwd TEXT,started_at TEXT,updated_at TEXT); CREATE TABLE messages(session_id TEXT,role TEXT,content TEXT,timestamp TEXT);",
  );
  const timestamp = "2026-10-08T00:00:00Z";
  for (const id of ["changed", "retained"]) {
    native
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
      .run(id, id, project, timestamp, timestamp);
    native
      .prepare("INSERT INTO messages VALUES(?,?,?,?)")
      .run(id, "assistant", `synthetic-ownership-marker ${id}`, timestamp);
  }
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "registered",
    project,
    "Synthetic",
    "registered",
    "healthy",
    timestamp,
  );
  const environment = {
    HOME: root,
    USERPROFILE: root,
    PATH: root,
    HERMES_HOME: home,
    CURSOR_CONFIG_DIR: path.join(root, "cursor"),
  };
  store.sessions.sync(
    "registered",
    "hermes",
    new HermesSessions(environment).list(project).sessions.map(({ session }) => session),
  );
  await writeFile(
    path.join(root, "preferences.json"),
    JSON.stringify({ session_content_search_enabled: true }),
  );
  const open = () => {
    const index = new HistorySearch(
      store,
      root,
      environment,
      { profiles: () => [] },
      { workerFilename: path.resolve("dist-electron/backend-history-search.cjs") },
    );
    cleanups.push(() => index.close());
    return index;
  };
  const index = open();
  index.refresh();
  const query = (target = index) =>
    target.request(methods.query, {
      query: "synthetic-ownership-marker",
    }) as Promise<HistorySearchResult>;
  await waitForIndexing(async () => expect((await query()).status.coverage.ready).toBe(2));
  const hits = (await query()).hits;
  const changed = hits.find((hit) => hit.title === "changed")!;
  const retained = hits.find((hit) => hit.title === "retained")!;
  return {
    root,
    index,
    native,
    query,
    open,
    changed,
    retained,
    project,
    other,
    store,
    environment,
  };
}

async function openClawReadFixture() {
  const f = await ownershipFixture();
  const directory = path.join(f.root, ".openclaw", "agents", "main", "agent");
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, "openclaw-agent.sqlite");
  const edit = (operation: (native: DatabaseSync) => void) => {
    const native = new DatabaseSync(filename);
    try {
      operation(native);
    } finally {
      native.close();
    }
  };
  const timestamp = "2026-10-08T00:00:00.000Z";
  edit((native) => {
    // A complete schema-23 projection with one source; unrelated Hermes records stay readable.
    native.exec(`PRAGMA user_version=23; PRAGMA journal_mode=WAL;
      CREATE TABLE schema_meta(meta_key TEXT,role TEXT,schema_version INTEGER,agent_id TEXT,app_version TEXT);
      INSERT INTO schema_meta VALUES('primary','agent',23,'main','2026.9.6');
      CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_utf8_bytes INTEGER);
      CREATE TABLE session_windows(session_id TEXT,session_key TEXT,created_at TEXT,transcript_updated_at TEXT,updated_at TEXT,display_name TEXT,acp_owned INTEGER,plugin_owner_id TEXT,agent_harness_id TEXT,session_scope TEXT);
      CREATE TABLE session_nodes(session_key TEXT,entry_json TEXT,entry_valid INTEGER,archived_at TEXT,current_session_id TEXT);
      CREATE TABLE session_transcript_cold_archives(session_id TEXT);
      CREATE TABLE session_transcript_index_state(session_id TEXT,indexed_seq INTEGER,needs_rebuild INTEGER,active_event_count INTEGER,active_message_count INTEGER);
      CREATE TABLE transcript_rewrite_watermarks(session_id TEXT,generation INTEGER);
      CREATE TABLE session_transcript_active_events(session_id TEXT,event_seq INTEGER,active_position INTEGER,message_position INTEGER,context_eligible INTEGER);
      INSERT INTO session_nodes VALUES('changed','{}',1,NULL,'changed');
      INSERT INTO session_transcript_index_state VALUES('changed',1,0,1,1);
      INSERT INTO transcript_rewrite_watermarks VALUES('changed',1);
      INSERT INTO session_transcript_active_events VALUES('changed',1,0,0,1);`);
    native
      .prepare(
        "INSERT INTO session_windows VALUES('changed','changed',?,?,?, ?,0,NULL,'pi','conversation')",
      )
      .run(timestamp, timestamp, timestamp, "OpenClaw changed");
    const events = [
      { type: "session", version: 4, id: "changed", cwd: f.project, timestamp },
      {
        type: "message",
        id: "message-changed",
        timestamp,
        message: { role: "assistant", content: "synthetic-ownership-marker OpenClaw body" },
      },
    ];
    for (const [seq, event] of events.entries()) {
      const json = JSON.stringify(event);
      native
        .prepare("INSERT INTO transcript_events VALUES('changed',?,?,?)")
        .run(seq, json, Buffer.byteLength(json));
    }
  });
  f.store.sessions.sync(
    "registered",
    "open-claw",
    new OpenClawSessions(f.environment).list(f.project).sessions.map(({ session }) => session),
  );
  f.index.refresh();
  await waitForIndexing(async () => expect((await f.query()).status.coverage.ready).toBe(3));
  expect(tracked.workers).toHaveLength(2);
  const hits = (await f.query()).hits;
  const changed = hits.find((hit) => hit.agent === "open-claw")!;
  const safeIds = hits
    .filter((hit) => hit.agent === "hermes")
    .map((hit) => hit.location.sessionId)
    .sort();
  expect(safeIds).toHaveLength(2);
  const located = (await f.index.request(methods.locate, {
    location: changed.location,
  })) as HistoryLocatedRecord;
  const retained = (await f.index.request(methods.locate, {
    location: f.retained.location,
  })) as HistoryLocatedRecord;
  return {
    ...f,
    safeIds,
    params: (method: string) =>
      method === methods.locate
        ? { location: changed.location }
        : {
            references: [retained, located].map((record) => ({
              ...record.location,
              start: 0,
              end: 5,
              contentHash: record.contentHash,
            })),
          },
    change: (field: "cwd" | "agent_id" | "role") => {
      edit((native) => {
        if (field === "cwd") {
          const row = native
            .prepare(
              "SELECT event_json FROM transcript_events WHERE session_id='changed' AND seq=0",
            )
            .get()!;
          const event = JSON.parse(String(row.event_json));
          const json = JSON.stringify({ ...event, cwd: f.other });
          native
            .prepare(
              "UPDATE transcript_events SET event_json=?,event_utf8_bytes=? WHERE session_id='changed' AND seq=0",
            )
            .run(json, Buffer.byteLength(json));
        } else if (field === "agent_id") {
          native.exec("UPDATE schema_meta SET agent_id='foreign' WHERE meta_key='primary'");
        } else {
          native.exec("UPDATE schema_meta SET role='gateway' WHERE meta_key='primary'");
        }
      });
    },
    offline: () => rename(filename, `${filename}.offline`),
  };
}

async function cursorCliReadFixture() {
  const f = await ownershipFixture();
  const varint = (value: number) => {
    const bytes: number[] = [];
    do {
      const byte = value & 127;
      value >>>= 7;
      bytes.push(value ? byte | 128 : byte);
    } while (value);
    return Buffer.from(bytes);
  };
  const field = (number: number, value: Buffer | string) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
  };
  const source = async (id: string) => {
    const directory = path.join(f.environment.CURSOR_CONFIG_DIR, "chats", "project", id);
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, "store.db");
    const edit = <T>(operation: (native: DatabaseSync) => T): T => {
      const native = new DatabaseSync(filename);
      try {
        return operation(native);
      } finally {
        native.close();
      }
    };
    const blob = (native: DatabaseSync, bytes: Buffer) => {
      const hash = createHash("sha256").update(bytes).digest();
      native.prepare("INSERT OR IGNORE INTO blobs VALUES(?,?)").run(hash.toString("hex"), bytes);
      return hash;
    };
    const metadata = (native: DatabaseSync, bytes: Buffer) => {
      const root = blob(native, bytes);
      native
        .prepare("INSERT OR REPLACE INTO meta VALUES('0',?)")
        .run(
          Buffer.from(
            JSON.stringify({ name: `Cursor CLI ${id}`, latestRootBlobId: root.toString("hex") }),
          ).toString("hex"),
        );
      return root.toString("hex");
    };
    // Cursor CLI v1 stores protobuf messages under their SHA-256 blob identities.
    const turn = edit((native) => {
      native.exec(
        "PRAGMA user_version=1; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY,data BLOB);",
      );
      const user = blob(native, field(1, `synthetic-ownership-marker Cursor CLI ${id}`));
      const assistant = blob(native, field(1, field(1, "Synthetic answer")));
      return blob(native, field(1, Buffer.concat([field(1, user), field(2, assistant)])));
    });
    const rootBytes = (workspaces: string[]) =>
      Buffer.concat([
        field(8, turn),
        ...workspaces.map((cwd) => field(9, pathToFileURL(cwd).href)),
      ]);
    let rootId = "";
    const change = (workspaces: string[]) => {
      rootId = edit((native) => metadata(native, rootBytes(workspaces)));
    };
    change([f.project]);
    return {
      change,
      offline: () => rename(filename, `${filename}.offline`),
      corrupt: (kind: "invalid-root" | "invalid-root-hash") =>
        edit((native) => {
          if (kind === "invalid-root") {
            // A hash-valid protobuf root with no workspace cannot prove revocation.
            metadata(native, field(8, turn));
          } else {
            // The bytes claim another owner, but no longer match their root identity.
            native.prepare("UPDATE blobs SET data=? WHERE id=?").run(rootBytes([f.other]), rootId);
          }
        }),
    };
  };
  const changedSource = await source("changed");
  const retainedSource = await source("retained");
  const listing = new CursorSessions(f.environment).list(f.project).sessions;
  expect(listing).toHaveLength(2);
  f.store.sessions.sync("registered", "cursor", listing);
  f.index.refresh();
  await waitForIndexing(async () => expect((await f.query()).hits).toHaveLength(4));
  expect(tracked.workers).toHaveLength(2);
  const hits = (await f.query()).hits;
  const changed = hits.find((hit) => hit.title === "Cursor CLI changed")!;
  const retained = hits.find((hit) => hit.title === "Cursor CLI retained")!;
  const ids = (result: HistorySearchResult) =>
    result.hits.map((hit) => hit.location.sessionId).sort();
  const cachedIds = ids(await f.query());
  const safeIds = cachedIds.filter((id) => id !== changed.location.sessionId);
  const records = await Promise.all(
    [f.retained, retained, changed].map(
      (hit) =>
        f.index.request(methods.locate, {
          location: hit.location,
        }) as Promise<HistoryLocatedRecord>,
    ),
  );
  return {
    ...f,
    changed,
    changedSource,
    retainedSource,
    cachedIds,
    safeIds,
    ids,
    records,
    nativeRef: listing.find((session) => session.title === changed.title)!.native_ref,
    params: (method: string) =>
      method === methods.locate
        ? { location: changed.location }
        : {
            references: records.map((record) => ({
              ...record.location,
              start: 0,
              end: 5,
              contentHash: record.contentHash,
            })),
          },
  };
}

it.each([methods.locate, methods.references, methods.refresh])(
  "withdraws only the moved Cursor CLI source through %s and restores it only after a full reindex",
  async (method) => {
    const f = await cursorCliReadFixture();
    f.changedSource.change([f.other]);
    const moved = new CursorSessions(f.environment).list(f.other).sessions;
    expect(moved.map((session) => session.native_ref)).toEqual([f.nativeRef]);
    expect(f.store.sessions.get(f.changed.location.sessionId)?.workspace_id).toBe("registered");
    if (method === methods.refresh) {
      f.index.refresh();
      await waitForIndexing(async () =>
        expect((await f.query()).status.coverage.limitations).toContain("source-owner-changed"),
      );
    } else {
      await expect(f.index.request(method, f.params(method))).rejects.toThrow(
        "history-source-owner-changed",
      );
    }
    expect(f.ids(await f.query())).toEqual(f.safeIds);
    for (const safe of f.records.slice(0, 2)) {
      await expect(
        f.index.request(methods.locate, { location: safe.location }),
      ).resolves.toMatchObject({
        content: safe.content,
        contentHash: safe.contentHash,
      });
    }
    await f.index.close();
    const reopened = f.open();
    expect(f.ids(await f.query(reopened))).toEqual(f.safeIds);
    f.changedSource.change([f.project]);
    expect(f.ids(await f.query(reopened))).toEqual(f.safeIds);
    reopened.refresh();
    await waitForIndexing(async () => expect(f.ids(await f.query(reopened))).toEqual(f.cachedIds));
    const restored = (await f.query(reopened)).hits.find(
      (hit) => hit.location.sessionId === f.changed.location.sessionId,
    )!;
    await expect(
      reopened.request(methods.locate, { location: restored.location }),
    ).resolves.toMatchObject({
      content: f.records[2]!.content,
    });
  },
);

it.each(
  (["missing-db", "invalid-root", "invalid-root-hash"] as const).flatMap((problem) =>
    [methods.locate, methods.references].map((method) => ({ problem, method })),
  ),
)(
  "retains Cursor CLI cache across reopen when $method rejects $problem without verified ownership",
  async ({ problem, method }) => {
    const f = await cursorCliReadFixture();
    if (problem === "missing-db") await f.changedSource.offline();
    else f.changedSource.corrupt(problem);
    await expect(f.index.request(method, f.params(method))).rejects.toThrow(
      "history-source-unavailable",
    );
    expect(f.ids(await f.query())).toEqual(f.cachedIds);
    await f.index.close();
    expect(f.ids(await f.query(f.open()))).toEqual(f.cachedIds);
  },
);

it("retains Cursor CLI cache when a changed multi-workspace root still owns the registered workspace", async () => {
  const f = await cursorCliReadFixture();
  f.changedSource.change([f.other, f.project]);
  for (const method of [methods.locate, methods.references]) {
    await expect(f.index.request(method, f.params(method))).rejects.toThrow("history-source-stale");
    expect(f.ids(await f.query())).toEqual(f.cachedIds);
  }
  f.index.refresh();
  await waitForIndexing(async () => {
    const changed = (await f.query()).hits.find(
      (hit) => hit.location.sessionId === f.changed.location.sessionId,
    )!;
    expect(changed.location.sourceRevision).not.toBe(f.changed.location.sourceRevision);
    await expect(
      f.index.request(methods.locate, { location: changed.location }),
    ).resolves.toMatchObject({
      content: f.records[2]!.content,
    });
  });
  expect(f.ids(await f.query())).toEqual(f.cachedIds);
});

it("does not revoke a missing Cursor CLI source because a different native reference moved workspaces", async () => {
  const f = await cursorCliReadFixture();
  await f.changedSource.offline();
  f.retainedSource.change([f.other]);
  const unrelated = new CursorSessions(f.environment).list(f.other).sessions;
  expect(unrelated).toHaveLength(1);
  expect(unrelated[0]!.native_ref).not.toBe(f.nativeRef);
  for (const method of [methods.locate, methods.references]) {
    const changed = f.records[2]!;
    const params =
      method === methods.locate
        ? { location: changed.location }
        : {
            references: [
              { ...changed.location, start: 0, end: 5, contentHash: changed.contentHash },
            ],
          };
    await expect(f.index.request(method, params)).rejects.toThrow("history-source-unavailable");
    expect(f.ids(await f.query())).toEqual(f.cachedIds);
  }
  await f.index.close();
  expect(f.ids(await f.query(f.open()))).toEqual(f.cachedIds);
});

it.each(
  (["cwd", "agent_id", "role"] as const).flatMap((field) =>
    [methods.locate, methods.references].map((method) => ({ field, method })),
  ),
)(
  "withdraws OpenClaw after $field changes via $method without a refresh",
  async ({ field, method }) => {
    const f = await openClawReadFixture();
    f.change(field);
    await expect(f.index.request(method, f.params(method))).rejects.toThrow(
      "history-source-owner-changed",
    );
    expect((await f.query()).hits.map((hit) => hit.location.sessionId).sort()).toEqual(f.safeIds);
    await f.index.close();
    expect((await f.query(f.open())).hits.map((hit) => hit.location.sessionId).sort()).toEqual(
      f.safeIds,
    );
  },
);

it.each([methods.locate, methods.references])(
  "retains OpenClaw cache across reopen after %s rejects a temporarily offline source",
  async (method) => {
    const f = await openClawReadFixture();
    const cachedIds = (await f.query()).hits.map((hit) => hit.location.sessionId).sort();
    await f.offline();
    await expect(f.index.request(method, f.params(method))).rejects.toThrow(
      "history-source-unavailable",
    );
    expect((await f.query()).hits.map((hit) => hit.location.sessionId).sort()).toEqual(cachedIds);
    await f.index.close();
    expect((await f.query(f.open())).hits.map((hit) => hit.location.sessionId).sort()).toEqual(
      cachedIds,
    );
  },
);

it.each([methods.locate, methods.references])(
  "withdraws only a confirmed changed owner after %s and keeps it withdrawn on reopen",
  async (method) => {
    const f = await ownershipFixture();
    const record = (await f.index.request(methods.locate, { location: f.changed.location })) as {
      contentHash: string;
    };
    const retainedRecord = (await f.index.request(methods.locate, {
      location: f.retained.location,
    })) as { contentHash: string };
    f.native.prepare("UPDATE sessions SET cwd=? WHERE id='changed'").run(f.other);
    const params =
      method === methods.locate
        ? { location: f.changed.location }
        : {
            references: [
              { ...f.retained.location, start: 0, end: 5, contentHash: retainedRecord.contentHash },
              { ...f.changed.location, start: 0, end: 5, contentHash: record.contentHash },
            ],
          };
    await expect(f.index.request(method, params)).rejects.toThrow("history-source-owner-changed");
    expect((await f.query()).hits.map((hit) => hit.location.sessionId)).toEqual([
      f.retained.location.sessionId,
    ]);
    await f.index.close();
    const reopened = f.open();
    expect((await f.query(reopened)).hits.map((hit) => hit.location.sessionId)).toEqual([
      f.retained.location.sessionId,
    ]);
    // Recovery requires a successful full source read, not merely the old catalog identity.
    f.native.prepare("UPDATE sessions SET cwd=? WHERE id='changed'").run(f.project);
    reopened.refresh();
    await waitForIndexing(async () => expect((await f.query(reopened)).hits).toHaveLength(2));
  },
);

it("fences a completed query held in flight when locate confirms an ownership change", async () => {
  const f = await ownershipFixture();
  const original = HistorySearchWorker.prototype.request;
  let ready!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hold = true;
  vi.spyOn(HistorySearchWorker.prototype, "request").mockImplementation(function <T>(
    this: HistorySearchWorker,
    operation: string,
    input: unknown,
    options = {},
  ) {
    const result = original.call(this, operation, input, options) as Promise<T>;
    if (operation !== "query" || !hold) return result;
    hold = false;
    return result.then(async (value) => {
      ready();
      await gate;
      return value;
    });
  });
  const late = f.query();
  const assertion = expect(late).rejects.toThrow("history-source-stale");
  await held;
  try {
    f.native.prepare("UPDATE sessions SET cwd=? WHERE id='changed'").run(f.other);
    await expect(f.index.request(methods.locate, { location: f.changed.location })).rejects.toThrow(
      "history-source-owner-changed",
    );
  } finally {
    release();
  }
  await assertion;
  expect((await f.query()).hits.map((hit) => hit.location.sessionId)).toEqual([
    f.retained.location.sessionId,
  ]);
});

it("retains safe cache after a temporarily unavailable source is rejected by locate", async () => {
  const f = await ownershipFixture();
  f.native.prepare("DELETE FROM sessions WHERE id='changed'").run();
  await expect(f.index.request(methods.locate, { location: f.changed.location })).rejects.toThrow(
    "history-source-unavailable",
  );
  expect((await f.query()).hits).toHaveLength(2);
});

it("cannot resurrect withdrawn text after the write worker has failed", async () => {
  const f = await ownershipFixture();
  await tracked.workers[0]!.terminate();
  f.native.prepare("UPDATE sessions SET cwd=? WHERE id='changed'").run(f.other);
  await expect(f.index.request(methods.locate, { location: f.changed.location })).rejects.toThrow(
    "history-source-owner-changed",
  );
  expect(
    (await f.query()).hits.some((hit) => hit.location.sessionId === f.changed.location.sessionId),
  ).toBe(false);
  await f.index.close();
  const reopened = f.open();
  expect(
    (await f.query(reopened)).hits.some(
      (hit) => hit.location.sessionId === f.changed.location.sessionId,
    ),
  ).toBe(false);
});

it("restores a quarantined source in the same host only after a successful reindex", async () => {
  const f = await ownershipFixture();
  f.native.prepare("UPDATE sessions SET cwd=? WHERE id='changed'").run(f.other);
  await expect(f.index.request(methods.locate, { location: f.changed.location })).rejects.toThrow(
    "history-source-owner-changed",
  );
  expect((await f.query()).hits).toHaveLength(1);
  f.native.prepare("UPDATE sessions SET cwd=? WHERE id='changed'").run(f.project);
  expect((await f.query()).hits).toHaveLength(1);
  f.index.refresh();
  await waitForIndexing(async () => expect((await f.query()).hits).toHaveLength(2));
});

it("quarantines before cleanup waits and drains a stopped writer's fallback before close returns", async () => {
  const f = await ownershipFixture();
  const original = HistorySearchWorker.prototype.request;
  let ready!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(HistorySearchWorker.prototype, "request").mockImplementation(function <T>(
    this: HistorySearchWorker,
    operation: string,
    input: unknown,
    options = {},
  ) {
    if (operation !== "withdraw")
      return original.call(this, operation, input, options) as Promise<T>;
    ready();
    return gate.then(() => original.call(this, operation, input, options) as Promise<T>);
  });
  f.native.prepare("UPDATE sessions SET cwd=? WHERE id='changed'").run(f.other);
  const locating = f.index.request(methods.locate, { location: f.changed.location });
  const rejected = expect(locating).rejects.toThrow("history-source-owner-changed");
  await held;
  let closing: Promise<void>;
  try {
    expect((await f.query()).hits.map((hit) => hit.location.sessionId)).toEqual([
      f.retained.location.sessionId,
    ]);
    closing = f.index.close();
  } finally {
    release();
  }
  await rejected;
  await closing!;
  for (const suffix of ["", "-wal", "-shm"])
    await expect(stat(path.join(f.root, `session-search.sqlite${suffix}`))).rejects.toMatchObject({
      code: "ENOENT",
    });
  expect((await f.query(f.open())).hits).toEqual([]);
});
it("reclaims every failed initializer before retry, clear, rebuild and close", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "history-lifecycle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  await writeFile(
    path.join(root, "preferences.json"),
    JSON.stringify({ session_content_search_enabled: true }),
  );
  await writeFile(path.join(root, "session-search.sqlite"), "damaged SQLite fixture");
  const index = new HistorySearch(
    store,
    root,
    {},
    { profiles: () => [] },
    {
      workerFilename: path.resolve("dist-electron/backend-history-search.cjs"),
    },
  );
  cleanups.push(() => index.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(index.request(methods.status, {})).rejects.toThrow(
      "history-search-cache-unavailable",
    );
    expect(tracked.workers.map((worker) => worker.threadId)).toEqual(Array(attempt + 1).fill(-1));
  }
  await index.clear();
  await expect(stat(path.join(root, "session-search.sqlite"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(index.request(methods.refresh, {})).resolves.toMatchObject({ enabled: true });
  await expect(index.request(methods.query, { query: "fixture" })).resolves.toMatchObject({
    hits: [],
  });
  await index.close();
  expect(tracked.workers.length).toBe(4);
  expect(tracked.workers.every((worker) => worker.threadId === -1)).toBe(true);
});

it.each([methods.status, methods.query])(
  "projects pending source coverage as unavailable after the indexing worker exits for %s",
  async (method) => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "history-lifecycle-coverage-")),
    );
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const store = new BackendStore(path.join(root, "agentkib.db"));
    cleanups.push(() => store.close());
    const timestamp = "2026-10-08T00:00:00Z";
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      "fixture",
      root,
      "Synthetic workspace",
      "fixture",
      "healthy",
      timestamp,
    );
    const session = (native_ref: string, agent: NativeSession["agent"]): NativeSession => ({
      native_ref,
      agent,
      title: `Synthetic ${native_ref}`,
      created_at: timestamp,
      updated_at: timestamp,
      message_count: 1,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    });
    const ready = session("ready", "codex");
    store.sessions.sync("fixture", "codex", [ready, session("pending-codex", "codex")]);
    store.sessions.sync("fixture", "cursor", [session("pending-cursor", "cursor")]);
    const readyId = store.sessions.id("codex", ready.native_ref);
    const cache = new HistorySearchStore(path.join(root, "session-search.sqlite"), true);
    try {
      const generation = cache.begin({
        sessionId: readyId,
        workspaceId: "fixture",
        agent: "codex",
        title: ready.title,
        updatedAt: timestamp,
        archived: false,
        ownerKey: contentHash(JSON.stringify(["fixture", root, "codex", []])),
      });
      cache.append(
        readyId,
        generation,
        {
          recordId: "synthetic-record",
          ordinal: 0,
          kind: "assistant",
          timestamp,
          toolName: null,
          content: "worker-exit-coverage-marker",
        },
        () => {},
      );
      cache.finish(readyId, generation, "synthetic-revision", "ready", []);
    } finally {
      cache.close();
    }
    await writeFile(
      path.join(root, "preferences.json"),
      JSON.stringify({ session_content_search_enabled: true }),
    );
    const index = new HistorySearch(
      store,
      root,
      { HOME: root, USERPROFILE: root, PATH: root },
      { profiles: () => [] },
      { workerFilename: path.resolve("dist-electron/backend-history-search.cjs") },
    );
    cleanups.push(() => index.close());
    expect(await index.request(methods.status, {})).toMatchObject({
      coverage: { total: 3, ready: 1, building: 2, unavailable: 0 },
    });
    expect(tracked.workers).toHaveLength(2);
    // Initialization creates the writer first and then an independent reader.
    const [writer, reader] = tracked.workers;
    await writer!.terminate();
    expect(writer!.threadId).toBe(-1);
    expect(reader!.threadId).not.toBe(-1);
    const coverage = (total: number, ready: number, unavailable: number) => ({
      total,
      ready,
      building: 0,
      partial: 0,
      stale: 0,
      unavailable,
      limitations: ["index-worker-unavailable-rebuild-required"],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      let status: HistorySearchStatus;
      if (method === methods.status) {
        status = (await index.request(method, {})) as HistorySearchStatus;
      } else {
        const result = (await index.request(method, {
          query: "worker-exit-coverage-marker",
        })) as HistorySearchResult;
        expect(result.hits.map((hit) => hit.location.sessionId)).toEqual([readyId]);
        status = result.status;
      }
      expect(status.coverage).toEqual(coverage(3, 1, 2));
      expect(status.sources).toEqual([
        { agent: "codex", body: "partial", tools: "partial", coverage: coverage(2, 1, 1) },
        { agent: "cursor", body: "unavailable", tools: "unsupported", coverage: coverage(1, 0, 1) },
      ]);
    }
    expect(tracked.workers).toHaveLength(2);
    expect(reader!.threadId).not.toBe(-1);
  },
);

it("indexes DeepSeek Harness sessions read from the running DSH, after each turn", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "history-lifecycle-dsh-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  const timestamp = "2026-10-08T00:00:00Z";
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "fixture",
    root,
    "Synthetic workspace",
    "fixture",
    "healthy",
    timestamp,
  );
  store.sessions.sync("fixture", "deepseek-harness", [
    {
      native_ref: "session-dsh",
      agent: "deepseek-harness",
      title: "Synthetic DSH",
      created_at: null,
      updated_at: timestamp,
      message_count: null,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    },
  ]);
  const id = store.sessions.id("deepseek-harness", "session-dsh");
  await writeFile(
    path.join(root, "preferences.json"),
    JSON.stringify({ session_content_search_enabled: true }),
  );
  let reads = 0,
    checks = 0,
    running = false,
    marker = "dsh-search-marker-first";
  const dsh = {
    nativeId: (sessionId: string) => (sessionId === id ? "session-dsh" : undefined),
    documentStatus: () => ({ status: "supported" as const }),
    running: () => (checks++, running),
    conversation: async () => ({
      revision: ++reads,
      records: [
        {
          seq: 1,
          time: null,
          current: true,
          position: 0,
          kind: "user" as const,
          text: marker,
          truncated: false,
          images: [],
          files: 0,
        },
      ],
    }),
  };
  const index = new HistorySearch(
    store,
    root,
    { HOME: root, USERPROFILE: root, PATH: root },
    { profiles: () => [] },
    {
      workerFilename: path.resolve("dist-electron/backend-history-search.cjs"),
      dsh: () => dsh,
    },
  );
  cleanups.push(() => index.close());
  const hits = async (query: string) =>
    ((await index.request(methods.query, { query })) as HistorySearchResult).hits;
  index.refresh();
  await waitForIndexing(async () => expect(await hits("dsh-search-marker-first")).toHaveLength(1));
  expect((await hits("dsh-search-marker-first"))[0]).toMatchObject({ agent: "deepseek-harness" });
  expect(reads).toBe(1);
  // While DSH runs a turn every record reports a change; the session is read after the turn.
  running = true;
  marker = "dsh-search-marker-second";
  const before = checks;
  index.refresh(id);
  await waitForIndexing(async () => expect(checks).toBeGreaterThan(before));
  expect(reads).toBe(1);
  running = false;
  index.refresh(id);
  await waitForIndexing(async () =>
    expect(await hits("dsh-search-marker-second")).toHaveLength(1),
  );
  expect(reads).toBe(2);
  // Listed as it was when last indexed, the session is not read again.
  index.refresh();
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(reads).toBe(2);
});
