import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  chmodSync,
} from "node:fs";
import path from "node:path";
import { restrictRemotePath } from "./remote-tls";

/** Open and migrate the private durable Codex ledger using the native schema. */
export function openManagedLedger(dataDir: string, create = false): DatabaseSync | null {
  const directory = path.join(dataDir, "codex-managed");
  const file = path.join(directory, "executions.sqlite");
  if (!existsSync(file) && !create) return null;
  if (create) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    if (!existsSync(file)) {
      let fd: number | undefined;
      try {
        fd = openSync(
          file,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
          0o600,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  }
  const directoryStat = lstatSync(directory);
  const fileStat = lstatSync(file);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    fileStat.isSymbolicLink() ||
    !fileStat.isFile()
  )
    throw new Error("invalid-managed-ledger");
  restrictRemotePath(directory, true);
  restrictRemotePath(file);

  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
    database.exec(
      "CREATE TABLE IF NOT EXISTS managed_sessions(id TEXT PRIMARY KEY, record TEXT NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS managed_commands(request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, phase TEXT NOT NULL, result TEXT);" +
        "CREATE TABLE IF NOT EXISTS managed_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_id TEXT NOT NULL, event TEXT NOT NULL, UNIQUE(session_id,event_id));",
    );
    const columns = new Set(
      (
        database.prepare("PRAGMA table_info(managed_commands)").all() as Array<{ name: string }>
      ).map((column) => column.name),
    );
    if (!columns.has("evidence"))
      database.exec("ALTER TABLE managed_commands ADD COLUMN evidence TEXT");
    if (!columns.has("device_id"))
      database.exec("ALTER TABLE managed_commands ADD COLUMN device_id TEXT NOT NULL DEFAULT ''");
    if (!columns.has("claim_version"))
      database.exec(
        "ALTER TABLE managed_commands ADD COLUMN claim_version INTEGER NOT NULL DEFAULT 0",
      );
    database.exec("COMMIT");
    if (create) chmodSync(file, 0o600);
    return database;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // A failed commit may already have ended the transaction.
    }
    database.close();
    throw error;
  }
}

export function readManagedRecord(
  dataDir: string,
  sessionId: string,
): Record<string, unknown> | null {
  const database = openManagedLedger(dataDir);
  if (!database) return null;
  try {
    const row = database
      .prepare("SELECT record FROM managed_sessions WHERE id=?")
      .get(sessionId) as { record: string } | undefined;
    if (!row) return null;
    const record: unknown = JSON.parse(row.record);
    if (!isObject(record) || record.id !== sessionId) throw new Error("invalid-managed-record");
    return record;
  } finally {
    database.close();
  }
}

export function listManagedRecords(dataDir: string): Array<Record<string, unknown>> {
  const database = openManagedLedger(dataDir);
  if (!database) return [];
  try {
    const rows = database
      .prepare("SELECT record FROM managed_sessions ORDER BY rowid DESC LIMIT 20000")
      .all() as Array<{ record: string }>;
    return rows.map(({ record: value }) => {
      const record: unknown = JSON.parse(value);
      if (!isObject(record)) throw new Error("invalid-managed-record");
      return record;
    });
  } finally {
    database.close();
  }
}

export function saveManagedRecord(dataDir: string, record: Record<string, unknown>): void {
  if (typeof record.id !== "string" || record.id.length === 0)
    throw new Error("invalid-managed-record");
  const database = openManagedLedger(dataDir, true);
  if (!database) throw new Error("session-unavailable");
  try {
    database
      .prepare(
        "INSERT INTO managed_sessions(id,record) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      )
      .run(record.id, JSON.stringify(record));
  } finally {
    database.close();
  }
}

/** Return a completed receipt or a fail-closed result for any earlier claim. */
export function replayManagedCommand(
  dataDir: string,
  requestId: string,
  fingerprint: string,
): Record<string, unknown> | null {
  const database = openManagedLedger(dataDir);
  if (!database) return null;
  try {
    const row = database
      .prepare("SELECT fingerprint,phase,result FROM managed_commands WHERE request_id=?")
      .get(requestId) as { fingerprint: string; phase: string; result: string | null } | undefined;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new Error("request-id-reused-with-different-input");
    if (row.result) {
      const result: unknown = JSON.parse(row.result);
      if (!isObject(result)) throw new Error("invalid-managed-command-result");
      return result;
    }
    return {
      accepted: false,
      completed: false,
      requestId,
      controlOutcome: "unknown",
      reason: row.phase === "prepared" ? "request-interrupted" : "control-outcome-unconfirmed",
    };
  } finally {
    database.close();
  }
}

/** Claim a command atomically before any external side effect can be dispatched. */
export function claimManagedCommand(
  dataDir: string,
  requestId: string,
  sessionId: string,
  fingerprint: string,
  deviceId: string | null,
  evidence: Record<string, unknown>,
): Record<string, unknown> | null {
  if (typeof evidence.operation !== "string" || evidence.operation.length === 0)
    throw new Error("missing-command-operation");
  const database = openManagedLedger(dataDir, true);
  if (!database) throw new Error("session-unavailable");
  try {
    database.exec("BEGIN IMMEDIATE");
    const prior = database
      .prepare("SELECT fingerprint,phase,result FROM managed_commands WHERE request_id=?")
      .get(requestId) as { fingerprint: string; phase: string; result: string | null } | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error("request-id-reused-with-different-input");
      database.exec("COMMIT");
      if (prior.result) {
        const result: unknown = JSON.parse(prior.result);
        if (!isObject(result)) throw new Error("invalid-managed-command-result");
        return result;
      }
      return {
        accepted: false,
        completed: false,
        requestId,
        controlOutcome: "unknown",
        reason: prior.phase === "prepared" ? "request-interrupted" : "control-outcome-unconfirmed",
      };
    }
    database
      .prepare(
        "INSERT INTO managed_commands(request_id,session_id,fingerprint,phase,result,device_id,evidence,claim_version) VALUES(?,?,?,'prepared',NULL,?,?,1)",
      )
      .run(requestId, sessionId, fingerprint, deviceId ?? "", JSON.stringify(evidence));
    database.exec("COMMIT");
    return null;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the transaction error if SQLite already ended the transaction.
    }
    throw error;
  } finally {
    database.close();
  }
}

export function dispatchManagedCommand(dataDir: string, requestId: string): void {
  const database = openManagedLedger(dataDir);
  if (!database) throw new Error("session-unavailable");
  try {
    const changed = database
      .prepare(
        "UPDATE managed_commands SET phase='dispatched' WHERE request_id=? AND phase='prepared'",
      )
      .run(requestId).changes;
    if (changed !== 1) throw new Error("control-ledger-not-prepared");
  } finally {
    database.close();
  }
}

export function annotateManagedCommand(
  dataDir: string,
  requestId: string,
  evidence: Record<string, unknown>,
): void {
  const database = openManagedLedger(dataDir);
  if (!database) throw new Error("session-unavailable");
  try {
    const changed = database
      .prepare("UPDATE managed_commands SET evidence=? WHERE request_id=? AND phase='prepared'")
      .run(JSON.stringify(evidence), requestId).changes;
    if (changed !== 1) throw new Error("control-ledger-not-prepared");
  } finally {
    database.close();
  }
}

export function finishManagedCommand(
  dataDir: string,
  requestId: string,
  result: Record<string, unknown>,
): void {
  const database = openManagedLedger(dataDir);
  if (!database) throw new Error("session-unavailable");
  try {
    database
      .prepare("UPDATE managed_commands SET phase='resolved',result=? WHERE request_id=?")
      .run(JSON.stringify(result), requestId);
  } finally {
    database.close();
  }
}

export function managedSessionHasUnknownCommands(dataDir: string, sessionId: string): boolean {
  const database = openManagedLedger(dataDir);
  if (!database) return false;
  try {
    const row = database
      .prepare(
        "SELECT EXISTS(SELECT 1 FROM managed_commands WHERE session_id=? AND phase='dispatched') AS found",
      )
      .get(sessionId) as { found: number };
    return row.found === 1;
  } finally {
    database.close();
  }
}

export function readUnknownManagedCommands(
  dataDir: string,
  sessionId: string,
): Array<{ requestId: string; evidence: Record<string, unknown> | null }> {
  const database = openManagedLedger(dataDir);
  if (!database) return [];
  try {
    const rows = database
      .prepare(
        "SELECT request_id,evidence FROM managed_commands WHERE session_id=? AND phase='dispatched'",
      )
      .all(sessionId) as Array<{ request_id: string; evidence: string | null }>;
    return rows.map((row) => {
      const value: unknown = row.evidence === null ? null : JSON.parse(row.evidence);
      return {
        requestId: row.request_id,
        evidence: isObject(value) ? value : null,
      };
    });
  } finally {
    database.close();
  }
}

export function readManagedEvents(
  dataDir: string,
  sessionId: string,
  cursor: string | null | undefined,
  limit: number,
) {
  const database = openManagedLedger(dataDir);
  if (!database) throw new Error("session-unavailable");
  try {
    let before = 9_223_372_036_854_775_807n;
    if (cursor !== undefined && cursor !== null) {
      if (!/^\d+$/.test(cursor)) throw new Error("invalid-cursor");
      before = BigInt(cursor);
      if (before > 18_446_744_073_709_551_615n) throw new Error("invalid-cursor");
    }
    const pageSize = Math.min(100, Math.max(1, limit));
    const statement = database.prepare(
      "SELECT sequence,event FROM managed_events WHERE session_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
    );
    statement.setReadBigInts(true);
    const rows = statement.all(sessionId, before, pageSize + 1) as Array<{
      sequence: bigint;
      event: string;
    }>;
    const more = rows.length > pageSize;
    const page = rows.slice(0, pageSize);
    return {
      events: page.map((row) => JSON.parse(row.event) as unknown).reverse(),
      next_cursor: more && page.length ? String(page.at(-1)!.sequence) : null,
      warnings: [],
    };
  } finally {
    database.close();
  }
}

/** Persist a native goal refresh only while the managed identity and snapshot stay current. */
export function persistManagedGoal(
  dataDir: string,
  expected: {
    id: string;
    workspaceId: string;
    nativeId: string;
    workspace: string;
    home: string;
    goal: unknown;
  },
  goal: Record<string, unknown> | null,
): number | null {
  const database = openManagedLedger(dataDir);
  if (!database) return null;
  try {
    database.exec("BEGIN IMMEDIATE");
    const row = database
      .prepare("SELECT record FROM managed_sessions WHERE id=?")
      .get(expected.id) as { record: string } | undefined;
    if (!row) {
      database.exec("COMMIT");
      return null;
    }
    const record: unknown = JSON.parse(row.record);
    if (
      !isObject(record) ||
      record.workspace_id !== expected.workspaceId ||
      record.native_id !== expected.nativeId ||
      record.workspace !== expected.workspace ||
      record.home !== expected.home ||
      !sameJson(record.goal ?? null, expected.goal ?? null)
    ) {
      database.exec("COMMIT");
      return null;
    }

    const previousGoal = isObject(record.goal) ? record.goal : null;
    const revision =
      isObject(record.snapshot) &&
      Number.isSafeInteger(record.snapshot.revision) &&
      Number(record.snapshot.revision) >= 0
        ? Number(record.snapshot.revision)
        : 0;
    const invalidatesRevision = ["objective", "status", "tokenBudget"].some(
      (key) => previousGoal?.[key] !== goal?.[key],
    );
    const snapshot = isObject(record.snapshot) ? record.snapshot : {};
    record.goal = goal;
    record.snapshot = {
      ...snapshot,
      ...(invalidatesRevision ? { revision: revision + 1 } : { revision }),
      goal,
    };
    database
      .prepare("UPDATE managed_sessions SET record=? WHERE id=?")
      .run(JSON.stringify(record), expected.id);
    database.exec("COMMIT");
    return invalidatesRevision ? revision + 1 : revision;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may already have committed before a later close error.
    }
    throw error;
  } finally {
    database.close();
  }
}

/** Persist one ordered runner event without overwriting a concurrent ledger revision. */
export function persistManagedSnapshot(
  dataDir: string,
  expected: {
    id: string;
    workspaceId: string;
    workspace: string;
    home: string;
    nativeId: string | null;
    ledgerRevision: number;
  },
  snapshot: Record<string, unknown>,
  updates: {
    nativeId: string | null;
    tokenUsage: unknown;
    goal: unknown;
    nativeSettings: unknown;
    model?: unknown;
    effort?: unknown;
    serviceTier?: unknown;
    policyId?: unknown;
    mode?: unknown;
    title?: unknown;
    archived?: unknown;
  },
  event?: Record<string, unknown> | Record<string, unknown>[],
): number {
  const nextRevision = revisionOf(snapshot.revision);
  if (nextRevision === null) throw new Error("invalid-managed-revision");
  const database = openManagedLedger(dataDir);
  if (!database) throw new Error("session-unavailable");
  try {
    database.exec("BEGIN IMMEDIATE");
    const row = database
      .prepare("SELECT record FROM managed_sessions WHERE id=?")
      .get(expected.id) as { record: string } | undefined;
    if (!row) throw new Error("session-unavailable");
    const record: unknown = JSON.parse(row.record);
    const currentSnapshot = isObject(record) && isObject(record.snapshot) ? record.snapshot : {};
    const currentNative =
      isObject(record) && typeof record.native_id === "string" ? record.native_id : null;
    if (
      !isObject(record) ||
      record.workspace_id !== expected.workspaceId ||
      record.workspace !== expected.workspace ||
      record.home !== expected.home ||
      record.released === true ||
      record.archived === true ||
      currentNative !== expected.nativeId ||
      (revisionOf(currentSnapshot.revision) ?? 0) !== expected.ledgerRevision
    )
      throw new Error("managed-snapshot-changed");

    record.snapshot = snapshot;
    record.native_id = updates.nativeId;
    record.token_usage = updates.tokenUsage;
    record.goal = updates.goal;
    record.native_settings = updates.nativeSettings;
    if (updates.model !== undefined) record.model = updates.model;
    if (updates.effort !== undefined) record.effort = updates.effort;
    if (updates.serviceTier !== undefined) record.service_tier = updates.serviceTier;
    if (updates.policyId !== undefined) record.policy_id = updates.policyId;
    if (updates.mode !== undefined) record.mode = updates.mode;
    if (updates.title !== undefined) record.title = updates.title;
    if (updates.archived !== undefined) record.archived = updates.archived;
    database
      .prepare("UPDATE managed_sessions SET record=? WHERE id=?")
      .run(JSON.stringify(record), expected.id);
    for (const item of event ? (Array.isArray(event) ? event : [event]) : []) {
      if (typeof item.id !== "string") continue;
      const { id, ...payload } = item;
      database
        .prepare("INSERT OR IGNORE INTO managed_events(session_id,event_id,event) VALUES(?,?,?)")
        .run(expected.id, id, JSON.stringify(payload));
    }
    database.exec("COMMIT");
    return nextRevision;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may have failed before it started or already rolled back.
    }
    throw error;
  } finally {
    database.close();
  }
}

/** Bind ordered state writes to one managed session identity and its current DB revision. */
export function createManagedSnapshotWriter(
  dataDir: string,
  record: {
    id: string;
    workspace_id: string;
    workspace: string;
    home: string;
    native_id?: string | null;
    snapshot?: Record<string, unknown>;
  },
) {
  let nativeId = typeof record.native_id === "string" ? record.native_id : null;
  let ledgerRevision = revisionOf(record.snapshot?.revision) ?? 0;
  return (
    state: {
      nativeId: string | null;
      record: Readonly<Record<string, unknown>>;
      snapshot(runtimeBootId: string, controls: boolean): Record<string, unknown>;
    },
    event?: Record<string, unknown> | Record<string, unknown>[],
  ) => {
    const current = state.record;
    const snapshot = state.snapshot("", false);
    const nextRevision = persistManagedSnapshot(
      dataDir,
      {
        id: record.id,
        workspaceId: record.workspace_id,
        workspace: record.workspace,
        home: record.home,
        nativeId,
        ledgerRevision,
      },
      snapshot,
      {
        nativeId: state.nativeId,
        tokenUsage: current.token_usage ?? null,
        goal: current.goal ?? null,
        nativeSettings: current.native_settings ?? null,
        model: current.model ?? null,
        effort: current.effort ?? null,
        serviceTier: current.service_tier ?? null,
        policyId: current.policy_id ?? null,
        mode: current.mode ?? null,
        title: current.title ?? null,
        archived: current.archived ?? false,
      },
      event,
    );
    nativeId = state.nativeId;
    ledgerRevision = nextRevision;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function revisionOf(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
