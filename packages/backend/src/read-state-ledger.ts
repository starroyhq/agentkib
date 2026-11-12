import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import path from "node:path";
import type { ConversationReadResult, ConversationReadState } from "@agentkib/runtime-protocol";
import { openManagedLedger } from "./managed-ledger";
import { pathIdentity } from "./paths";

export function conversationReadKey(provider: string, home: string, nativeId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([provider, pathIdentity(home), nativeId]))
    .digest("hex");
}

export type ReadCheckpoint = {
  file: string;
  identity: string;
  offset: number;
  baselineEnd: number;
  lastItemId: string | null;
  lastTurnId: string | null;
};
type Source = {
  baseline_done: number;
  checkpoint: string | null;
};
type ReadProjection = {
  key: string;
  revision: number;
  baseline_done: number;
  read_sequence: number | null;
  manual_unread: number | null;
  latest_result: string | null;
  first_unread: string | null;
};
const projectionColumns = `source.key, source.revision, source.baseline_done,
  cursor.read_sequence, cursor.manual_unread, latest.result AS latest_result,
  (SELECT result FROM conversation_read_results
    WHERE key=source.key AND baseline=0 AND sequence>COALESCE(cursor.read_sequence,0)
    ORDER BY sequence LIMIT 1) AS first_unread`;
const projectionJoins = `LEFT JOIN conversation_read_cursors cursor
    ON cursor.key=source.key AND cursor.reader_scope=?
  LEFT JOIN conversation_read_results latest
    ON latest.key=source.key AND latest.result_id=source.latest_id`;
const pendingObservations = new Map<string, Map<string, ConversationReadResult>>();

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_read_sources(
    key TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,baseline_done INTEGER NOT NULL DEFAULT 0,checkpoint TEXT,latest_id TEXT);
    CREATE TABLE IF NOT EXISTS conversation_read_results(
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,key TEXT NOT NULL,result_id TEXT NOT NULL,result TEXT NOT NULL,baseline INTEGER NOT NULL,position INTEGER,
    UNIQUE(key,result_id));
    CREATE INDEX IF NOT EXISTS conversation_read_result_order ON conversation_read_results(key,sequence);
    CREATE TABLE IF NOT EXISTS conversation_read_cursors(
    key TEXT NOT NULL,reader_scope TEXT NOT NULL,read_sequence INTEGER NOT NULL DEFAULT 0,manual_unread INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(key,reader_scope));
    CREATE TABLE IF NOT EXISTS conversation_native_read_receipts(key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversation_native_read_handoffs(key TEXT NOT NULL,reader_scope TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(key,reader_scope));`);
  const columns = db.prepare("PRAGMA table_info(conversation_read_cursors)").all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "manual_unread"))
    db.exec(
      "ALTER TABLE conversation_read_cursors ADD COLUMN manual_unread INTEGER NOT NULL DEFAULT 0",
    );
  if (
    !(
      db.prepare("PRAGMA table_info(conversation_read_sources)").all() as Array<{ name: string }>
    ).some((column) => column.name === "latest_id")
  )
    db.exec("ALTER TABLE conversation_read_sources ADD COLUMN latest_id TEXT");
  if (
    !(
      db.prepare("PRAGMA table_info(conversation_read_results)").all() as Array<{ name: string }>
    ).some((column) => column.name === "position")
  )
    db.exec("ALTER TABLE conversation_read_results ADD COLUMN position INTEGER");
}

/** Separate from command receipts: viewing a result never locks execution or approvals. */
export class ReadStateLedger {
  constructor(readonly dataDir: string) {}

  #write<T>(operation: (db: DatabaseSync) => T): T {
    const db = openManagedLedger(this.dataDir, true)!;
    try {
      db.exec("BEGIN IMMEDIATE");
      migrate(db);
      const result = operation(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* Preserve the original failure. */
      }
      throw error;
    } finally {
      db.close();
    }
  }

  #read<T>(operation: (db: DatabaseSync) => T, absent: T): T {
    const directory = path.join(this.dataDir, "codex-managed"),
      file = path.join(directory, "executions.sqlite");
    try {
      if (!lstatSync(directory).isDirectory() || !lstatSync(file).isFile())
        throw new Error("invalid-managed-ledger");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
      throw error;
    }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=3000; BEGIN");
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_read_sources'").get())
        return absent;
      return operation(db);
    } finally {
      db.close();
    }
  }

  checkpoint(key: string): { complete: boolean; checkpoint: ReadCheckpoint | null } {
    return this.#read(
      (db) => {
        const row = db
          .prepare("SELECT baseline_done,checkpoint FROM conversation_read_sources WHERE key=?")
          .get(key) as Source | undefined;
        return {
          complete: row?.baseline_done === 1,
          checkpoint: row?.checkpoint ? (JSON.parse(row.checkpoint) as ReadCheckpoint) : null,
        };
      },
      { complete: false, checkpoint: null },
    );
  }

  /** Commit one reliable transcript slice and its checkpoint together. */
  observe(
    key: string,
    results: Array<{ result: ConversationReadResult; baseline: boolean; position?: number }>,
    checkpoint: ReadCheckpoint | null,
    complete: boolean,
  ): boolean {
    // A transcript that has not grown is observed every few seconds while a window is open.
    // Recording the same checkpoint again was a write transaction per session per poll.
    if (!results.length) {
      const saved = this.#read(
        (db) =>
          db
            .prepare("SELECT baseline_done,checkpoint FROM conversation_read_sources WHERE key=?")
            .get(key) as Source | undefined,
        undefined,
      );
      if (
        saved &&
        saved.checkpoint === (checkpoint ? JSON.stringify(checkpoint) : null) &&
        (saved.baseline_done === 1 || !complete)
      )
        return false;
    }
    return this.#write((db) => {
      db.prepare("INSERT OR IGNORE INTO conversation_read_sources(key) VALUES(?)").run(key);
      let changed = false;
      const insert = db.prepare(
        "INSERT OR IGNORE INTO conversation_read_results(key,result_id,result,baseline,position) VALUES(?,?,?,?,?)",
      );
      for (const { result, baseline, position } of results) {
        const inserted = insert.run(
          key,
          result.id,
          JSON.stringify(result),
          baseline ? 1 : 0,
          position ?? null,
        );
        if (position !== undefined)
          db.prepare(
            "UPDATE conversation_read_results SET position=? WHERE key=? AND result_id=?",
          ).run(position, key, result.id);
        if (inserted.changes) {
          changed = true;
          const latest = db
            .prepare(
              "SELECT r.baseline FROM conversation_read_sources s JOIN conversation_read_results r ON r.key=s.key AND r.result_id=s.latest_id WHERE s.key=?",
            )
            .get(key) as { baseline: number } | undefined;
          // Historical baseline rows must not displace a completion observed live during that scan.
          if (!latest || !baseline || latest.baseline === 1)
            db.prepare("UPDATE conversation_read_sources SET latest_id=? WHERE key=?").run(
              result.id,
              key,
            );
        }
      }
      db.prepare(
        "UPDATE conversation_read_sources SET checkpoint=?,baseline_done=MAX(baseline_done,?),revision=revision+? WHERE key=?",
      ).run(checkpoint ? JSON.stringify(checkpoint) : null, complete ? 1 : 0, changed ? 1 : 0, key);
      return changed;
    });
  }

  record(key: string, result: ConversationReadResult): boolean {
    // A live completion precedes an initial history scan; keep it outside that baseline.
    const pendingKey = `${pathIdentity(this.dataDir)}\0${key}`;
    try {
      const prior = this.checkpoint(key);
      const changed = this.observe(
        key,
        [{ result, baseline: false }],
        prior.checkpoint,
        prior.complete,
      );
      pendingObservations.get(pendingKey)?.delete(result.id);
      if (pendingObservations.get(pendingKey)?.size === 0) pendingObservations.delete(pendingKey);
      return changed;
    } catch {
      const pending =
        pendingObservations.get(pendingKey) ?? new Map<string, ConversationReadResult>();
      if (!pending.has(result.id))
        console.warn("Conversation read-state observation could not be persisted");
      pending.set(result.id, result);
      pendingObservations.set(pendingKey, pending);
      return false;
    }
  }

  retryObservations(key: string): void {
    for (const result of [
      ...(pendingObservations.get(`${pathIdentity(this.dataDir)}\0${key}`)?.values() ?? []),
    ])
      this.record(key, result);
  }

  get(key: string, scope: string): ConversationReadState {
    const state = this.#read((db) => this.#project(db, key, scope), this.#unknown());
    return this.#withPending(state, key, pathIdentity(this.dataDir));
  }

  /** Catalog rows share one read transaction and a bounded number of SQL statements. */
  catalogStates(
    keys: ReadonlyMap<string, boolean>,
    scope: string,
  ): Map<string, ConversationReadState> {
    if (!keys.size) return new Map();
    const directory = pathIdentity(this.dataDir);
    return this.#read((db) => {
      const rows = db
        .prepare(
          `SELECT ${projectionColumns}
            FROM json_each(?) requested
            JOIN conversation_read_sources source ON source.key=requested.value
            ${projectionJoins}`,
        )
        .all(JSON.stringify([...keys.keys()]), scope) as ReadProjection[];
      const states = new Map(
        rows.map((row) => [
          row.key,
          this.#withPending(this.#state(row, scope), row.key, directory),
        ]),
      );
      const nativeKeys = [...keys].filter(([, native]) => native).map(([key]) => key);
      if (!nativeKeys.length) return states;

      // A ledger from an earlier version may have neither native receipt table.
      const tables = new Set(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name IN ('conversation_native_read_receipts','conversation_native_read_handoffs')",
          )
          .all()
          .map((row) => row.name),
      );
      if (!tables.has("conversation_native_read_receipts")) return states;
      const hasHandoffs = tables.has("conversation_native_read_handoffs");
      const joins = hasHandoffs
        ? "LEFT JOIN conversation_native_read_handoffs handoff ON handoff.key=receipt.key AND handoff.reader_scope=?"
        : "";
      const receipts = db
        .prepare(
          `SELECT receipt.key, receipt.fingerprint, receipt.snapshot, ${hasHandoffs ? "handoff.fingerprint" : "NULL"} AS applied
            FROM json_each(?) requested
            JOIN conversation_native_read_receipts receipt ON receipt.key=requested.value
            ${joins}`,
        )
        .all(
          ...(hasHandoffs ? [JSON.stringify(nativeKeys), scope] : [JSON.stringify(nativeKeys)]),
        ) as Array<{ key: string; fingerprint: string; snapshot: string; applied: string | null }>;
      for (const receipt of receipts) {
        const state = JSON.parse(receipt.snapshot) as ConversationReadState;
        if (state.status === "unread" && receipt.fingerprint !== receipt.applied)
          states.set(receipt.key, {
            ...state,
            source: "agentkib",
            freshness: "stale",
            version: null,
          });
      }
      return states;
    }, new Map());
  }

  #withPending(
    state: ConversationReadState,
    key: string,
    directory: string,
  ): ConversationReadState {
    return pendingObservations.has(`${directory}\0${key}`)
      ? { ...state, freshness: "stale" }
      : state;
  }

  #unknown(): ConversationReadState {
    return {
      source: "agentkib",
      status: "unknown",
      freshness: "stale",
      version: null,
      firstUnread: null,
      latestResult: null,
    };
  }

  #project(db: DatabaseSync, key: string, scope: string): ConversationReadState {
    const row = db
      .prepare(
        `SELECT ${projectionColumns} FROM conversation_read_sources source ${projectionJoins} WHERE source.key=?`,
      )
      .get(scope, key) as ReadProjection | undefined;
    return row ? this.#state(row, scope) : this.#unknown();
  }

  #state(row: ReadProjection, scope: string): ConversationReadState {
    const read = row.read_sequence ?? 0;
    const unread = row.first_unread;
    const result = unread !== null ? (JSON.parse(unread) as ConversationReadResult) : null;
    const manual = row.manual_unread === 1;
    const reliable = row.baseline_done === 1 || unread !== null || manual;
    return {
      source: "agentkib",
      status: unread !== null || manual ? "unread" : reliable ? "read" : "unknown",
      freshness: reliable ? "current" : "stale",
      version: reliable
        ? `agentkib:${createHash("sha256")
            .update(JSON.stringify([row.key, scope, row.revision, read, manual]))
            .digest("base64url")}`
        : null,
      firstUnread: manual
        ? { type: "threadStart" }
        : result
          ? { type: "result", resultId: result.id, turnId: result.turnId }
          : null,
      latestResult:
        row.latest_result !== null
          ? (JSON.parse(row.latest_result) as ConversationReadResult)
          : null,
    };
  }

  update(
    key: string,
    scope: string,
    expectedVersion: string,
    seenResultId: string | null,
  ): ConversationReadState {
    if (pendingObservations.has(`${pathIdentity(this.dataDir)}\0${key}`))
      throw new Error("read-state-unavailable");
    return this.#write((db) => {
      const current = this.#project(db, key, scope);
      if (!current.version || current.freshness !== "current")
        throw new Error("read-state-unavailable");
      if (
        current.version !== expectedVersion ||
        (current.latestResult?.id ?? null) !== seenResultId
      )
        throw new Error("read-state-conflict");
      const latest = db
        .prepare(
          "SELECT MAX(sequence) AS sequence FROM conversation_read_results WHERE key=? AND baseline=0",
        )
        .get(key) as { sequence: number | null };
      db.prepare(
        "INSERT INTO conversation_read_cursors(key,reader_scope,read_sequence) VALUES(?,?,?) ON CONFLICT(key,reader_scope) DO UPDATE SET read_sequence=MAX(read_sequence,excluded.read_sequence),manual_unread=0",
      ).run(key, scope, latest.sequence ?? 0);
      return this.#project(db, key, scope);
    });
  }

  /** A source handoff copies only verified native evidence, never guesses from silence. */
  handoff(key: string, scope: string, previous: ConversationReadState, fingerprint?: string): void {
    if (previous.source !== "codex-native" || previous.status === "unknown") return;
    this.#write((db) => {
      db.prepare("INSERT OR IGNORE INTO conversation_read_sources(key) VALUES(?)").run(key);
      if (fingerprint) {
        const prior = db
          .prepare(
            "SELECT fingerprint FROM conversation_native_read_handoffs WHERE key=? AND reader_scope=?",
          )
          .get(key, scope) as { fingerprint: string } | undefined;
        if (prior?.fingerprint === fingerprint) return;
      }
      if (previous.latestResult)
        db.prepare(
          "INSERT OR IGNORE INTO conversation_read_results(key,result_id,result,baseline) VALUES(?,?,?,1)",
        ).run(key, previous.latestResult.id, JSON.stringify(previous.latestResult));
      let sequence = 0;
      const first = previous.firstUnread;
      if (previous.status === "unread" && first?.type === "result") {
        const marker: ConversationReadResult = {
          id: first.resultId,
          turnId: first.turnId,
          itemId: null,
          outcome: "ended",
          completedAt: null,
        };
        db.prepare(
          "INSERT OR IGNORE INTO conversation_read_results(key,result_id,result,baseline) VALUES(?,?,?,0)",
        ).run(key, marker.id, JSON.stringify(marker));
        db.prepare(
          "UPDATE conversation_read_results SET baseline=0 WHERE key=? AND result_id=?",
        ).run(key, marker.id);
        const row = db
          .prepare("SELECT sequence FROM conversation_read_results WHERE key=? AND result_id=?")
          .get(key, marker.id) as { sequence: number };
        sequence = row.sequence - 1;
        const position = db
          .prepare("SELECT position FROM conversation_read_results WHERE key=? AND result_id=?")
          .get(key, marker.id) as { position: number | null };
        db.prepare(
          position.position === null
            ? "UPDATE conversation_read_results SET baseline=0 WHERE key=? AND sequence>? AND baseline=0"
            : "UPDATE conversation_read_results SET baseline=0 WHERE key=? AND position>=?",
        ).run(key, position.position ?? sequence);
      } else if (previous.status === "read") {
        const row = previous.latestResult
          ? (db
              .prepare("SELECT sequence FROM conversation_read_results WHERE key=? AND result_id=?")
              .get(key, previous.latestResult.id) as { sequence: number } | undefined)
          : undefined;
        sequence = row?.sequence ?? 0;
        const position = previous.latestResult
          ? (db
              .prepare("SELECT position FROM conversation_read_results WHERE key=? AND result_id=?")
              .get(key, previous.latestResult.id) as { position: number | null } | undefined)
          : undefined;
        if (position?.position !== null && position?.position !== undefined)
          db.prepare(
            "UPDATE conversation_read_results SET baseline=0 WHERE key=? AND position>?",
          ).run(key, position.position);
      }
      db.prepare(
        "INSERT INTO conversation_read_cursors(key,reader_scope,read_sequence,manual_unread) VALUES(?,?,?,?) ON CONFLICT(key,reader_scope) DO UPDATE SET read_sequence=excluded.read_sequence,manual_unread=excluded.manual_unread",
      ).run(
        key,
        scope,
        sequence,
        previous.status === "unread" && first?.type === "threadStart" ? 1 : 0,
      );
      db.prepare("UPDATE conversation_read_sources SET revision=revision+1 WHERE key=?").run(key);
      if (previous.latestResult)
        db.prepare(
          "UPDATE conversation_read_sources SET latest_id=COALESCE(latest_id,?) WHERE key=?",
        ).run(previous.latestResult.id, key);
      if (fingerprint)
        db.prepare(
          "INSERT INTO conversation_native_read_handoffs(key,reader_scope,fingerprint) VALUES(?,?,?) ON CONFLICT(key,reader_scope) DO UPDATE SET fingerprint=excluded.fingerprint",
        ).run(key, scope, fingerprint);
    });
  }

  saveNative(key: string, state: ConversationReadState, nativeRevision: string): void {
    if (
      state.source !== "codex-native" ||
      state.freshness !== "current" ||
      state.status === "unknown"
    )
      return;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([nativeRevision, state.firstUnread, state.latestResult]))
      .digest("hex");
    // Foreground polling usually observes the same receipt. Avoid opening a writable
    // ledger (including schema checks) unless there is a durable semantic change.
    if (this.nativeSnapshot(key)?.fingerprint === fingerprint) return;
    this.#write((db) => {
      const previous = db
        .prepare("SELECT fingerprint FROM conversation_native_read_receipts WHERE key=?")
        .get(key) as { fingerprint: string } | undefined;
      if (previous?.fingerprint === fingerprint) return;
      db.prepare(
        "INSERT INTO conversation_native_read_receipts(key,fingerprint,snapshot) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET fingerprint=excluded.fingerprint,snapshot=excluded.snapshot",
      ).run(key, fingerprint, JSON.stringify(state));
    });
  }

  nativeSnapshot(key: string): { fingerprint: string; state: ConversationReadState } | null {
    return this.#read((db) => {
      if (
        !db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='conversation_native_read_receipts'")
          .get()
      )
        return null;
      const row = db
        .prepare("SELECT fingerprint,snapshot FROM conversation_native_read_receipts WHERE key=?")
        .get(key) as { fingerprint: string; snapshot: string } | undefined;
      return row
        ? { fingerprint: row.fingerprint, state: JSON.parse(row.snapshot) as ConversationReadState }
        : null;
    }, null);
  }
}
