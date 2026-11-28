import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { captureTranscriptShape } from "./session-shape-transcript.mjs";

const JSON_LIMIT = 2 * 1024 * 1024;
const ROW_LIMIT = 128;
const EVIDENCE_LIMIT = 16 * 1024;
const PHASES = ["prepared", "dispatched", "resolved"];
const OPERATIONS = [
  "create",
  "send",
  "resume",
  "steer",
  "stop",
  "settings",
  "rename",
  "fork",
  "compact",
  "answer",
  "approve",
  "adopt-terminal",
  "handover-terminal",
  "queue-add",
  "queue-update",
  "queue-delete",
  "queue-reorder",
  "queue-start",
  "queue-pause",
  "queue-resume",
  "queue-steer",
  "goal-set",
  "goal-pause",
  "goal-resume",
  "goal-clear",
  "usage-limit-continue",
  "usage-limit-cancel",
  "delete",
  "archive",
  "unarchive",
  "report",
  "orchestration-report",
  "open-model-picker",
];
const PERMISSIONS = ["default", "plan", "acceptEdits", "auto", "bypassPermissions", "dontAsk"];
const WORK_KINDS = ["queue", "goal", "report", "continue"];
const WORK_STATES = [
  "pending",
  "claimed",
  "dispatched",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
];
const SESSION_STATES = [
  "idle",
  "running",
  "waiting-approval",
  "waiting-input",
  "outcome-unknown",
  "failed",
  "ended",
  "unavailable",
];
const EXECUTION_MODES = ["claude-managed", "claude-follower", "claude-terminal"];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function kind(value) {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function flag(value) {
  return typeof value === "boolean" ? value : kind(value);
}

function enumeration(value, allowed) {
  return allowed.includes(value) ? value : value === undefined ? "absent" : "other";
}

function arraySize(value) {
  return Array.isArray(value) ? value.length : kind(value);
}

function parseObject(text) {
  const value = JSON.parse(text);
  if (!object(value)) throw new Error("invalid-shape-source");
  return value;
}

function observe(read) {
  try {
    return { status: "ok", ...read() };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "missing" : "unavailable" };
  }
}

function sourcePath(root, ...parts) {
  let directory = root;
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    if (!lstatSync(directory).isDirectory()) throw new Error("invalid-shape-directory");
  }
  return path.join(directory, parts.at(-1));
}

function readObject(file) {
  const entry = lstatSync(file);
  if (!entry.isFile()) throw new Error("invalid-shape-file");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino ||
      before.size > JSON_LIMIT
    ) {
      throw new Error("invalid-shape-file");
    }
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!read) throw new Error("incomplete-shape-file");
      offset += read;
    }
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error("changed-shape-file");
    }
    return parseObject(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

function selectManaged(record) {
  const snapshot = object(record.snapshot) ? record.snapshot : {};
  const result = object(snapshot.terminalResult) ? snapshot.terminalResult : {};
  return {
    adopted: flag(record.adopted),
    released: flag(record.released),
    fresh: flag(record.fresh),
    terminalHandover: flag(record.terminalHandover),
    terminalHandoverLeaseId: kind(record.terminalHandoverLeaseId),
    completedRequests: arraySize(record.completedRequests),
    snapshot: {
      status: enumeration(snapshot.status, SESSION_STATES),
      turnOrigin: enumeration(snapshot.turnOrigin, ["host", "self"]),
      lastOutcome: enumeration(snapshot.lastOutcome, ["succeeded", "failed", "cancelled", null]),
      turnId: kind(snapshot.turnId),
      terminalResult: kind(snapshot.terminalResult),
      terminalResultMatchesTurn:
        typeof snapshot.turnId === "string" && result.turnId === snapshot.turnId,
      terminalResultSuccess: flag(result.success),
    },
  };
}

function selectBridge(registry, sessionId) {
  if (!Array.isArray(registry.bindings)) throw new Error("invalid-shape-registry");
  const matches = registry.bindings.filter((binding) => binding?.target?.sessionId === sessionId);
  return {
    matchingBindings: matches.length,
    bindings: matches.slice(0, ROW_LIMIT).map((binding) => ({
      revoked: flag(binding.revoked),
      inflight: kind(binding.inflight),
      hasInflightTurn: typeof binding.inflight?.turnId === "string",
    })),
    liveLease: "not-observed",
  };
}

function withReadTransaction(file, read) {
  if (!lstatSync(file).isFile()) throw new Error("invalid-shape-database");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = lstatSync(file + suffix, { throwIfNoEntry: false });
    if (sidecar && !sidecar.isFile()) throw new Error("invalid-shape-sidecar");
  }
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec(
      "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=150;" +
        "PRAGMA temp_store=MEMORY; PRAGMA cache_size=-512; PRAGMA mmap_size=0; BEGIN",
    );
    const result = read(database);
    database.exec("COMMIT");
    return result;
  } finally {
    database.close();
  }
}

function hasTable(db, table) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table),
  );
}

function selectCommands(db, sessionId) {
  return observe(() => {
    const columns = db.prepare("PRAGMA table_info(managed_commands)").all();
    if (!columns.length) return { table: "missing" };
    const haveEvidence = columns.some(({ name }) => name === "evidence");
    // Legacy stores lack the evidence column. Limit values before handing them to JS.
    const evidence = haveEvidence
      ? "CASE WHEN length(CAST(evidence AS BLOB)) <= ? THEN evidence END"
      : "NULL";
    const query = db.prepare(
      "SELECT rowid AS position, substr(phase, 1, 24) AS phase, " +
        evidence +
        " AS evidence, result IS NOT NULL AS hasResult FROM managed_commands" +
        " WHERE session_id=? ORDER BY CASE phase WHEN 'dispatched' THEN 0" +
        " WHEN 'prepared' THEN 1 ELSE 2 END, rowid DESC LIMIT ?",
    );
    const rows = haveEvidence
      ? query.all(EVIDENCE_LIMIT, sessionId, ROW_LIMIT + 1)
      : query.all(sessionId, ROW_LIMIT + 1);
    return {
      limited: rows.length > ROW_LIMIT,
      evidenceColumn: haveEvidence,
      commands: rows
        .slice(0, ROW_LIMIT)
        .sort((a, b) => a.position - b.position)
        .map((row) => {
          const evidence = observe(() => selectCommandEvidence(parseObject(row.evidence)));
          return {
            phase: enumeration(row.phase, PHASES),
            evidence: row.evidence === null ? { status: "not-observed" } : evidence,
            hasResult: row.hasResult === 1,
          };
        }),
    };
  });
}

function selectCommandEvidence(evidence) {
  return {
    operation: enumeration(evidence.operation, OPERATIONS),
    executionMode: enumeration(evidence.executionMode, EXECUTION_MODES),
    turnId: kind(evidence.turnId),
  };
}

function selectStoredObject(db, table, sessionId, project) {
  return observe(() => {
    if (!hasTable(db, table)) return { table: "missing" };
    const row = db
      .prepare(
        "SELECT CASE WHEN length(CAST(record AS BLOB)) <= ? THEN record END AS record" +
          " FROM " +
          table +
          " WHERE session_id=?",
      )
      .get(JSON_LIMIT, sessionId);
    if (!row) return { matchingRow: false };
    return { matchingRow: true, ...project(parseObject(row.record)) };
  });
}

function selectHost(state) {
  return {
    paused: flag(state.paused),
    goal: kind(state.goal),
    permissionMode: enumeration(state.settings?.permissionMode, PERMISSIONS),
    workCount: arraySize(state.work),
    work: Array.isArray(state.work)
      ? state.work.slice(-ROW_LIMIT).map((item) => ({
          kind: enumeration(item?.kind, WORK_KINDS),
          status: enumeration(item?.status, WORK_STATES),
          requiresAttachments: flag(item?.requiresAttachments),
        }))
      : [],
  };
}

function selectLead(lead) {
  return {
    paused: flag(lead.paused),
    lanes: arraySize(lead.lanes),
    pendingReports: arraySize(lead.pendingReports),
    deliveringReports: arraySize(lead.deliveringReports),
    pendingQuitReports: arraySize(lead.pendingQuitReports),
    reportDeliveries: arraySize(lead.reportDeliveries),
  };
}

function selectReadCursors(db, managed) {
  return observe(() => {
    if (!hasTable(db, "conversation_read_cursors")) return { table: "missing" };
    if (typeof managed?.nativeId !== "string" || typeof managed?.home !== "string") {
      return { scope: "not-observed" };
    }
    // Match conversationReadKey for existing paths. Never include the key or raw reader scopes.
    let home = managed.home;
    try {
      home = realpathSync.native(home);
    } catch {}
    if (process.platform === "win32") {
      home = home.replaceAll("/", "\\").toLowerCase();
      if (home.length > path.parse(home).root.length) home = home.replace(/\\+$/, "");
    } else {
      home = home.replace(/\/+$/, "") || "/";
    }
    const key = createHash("sha256")
      .update(JSON.stringify(["claude-code", home, managed.nativeId]))
      .digest("hex");
    const scopes = db
      .prepare(
        "SELECT CASE WHEN reader_scope='local' THEN 'local'" +
          " WHEN substr(reader_scope, 1, 8)='account:' THEN 'account' ELSE 'other' END AS scope," +
          " count(*) AS rows, count(CASE WHEN read_sequence > 0 THEN 1 END) AS advanced" +
          " FROM conversation_read_cursors WHERE key=? GROUP BY scope ORDER BY scope",
      )
      .all(key);
    return { scopes: scopes.map(({ scope, rows, advanced }) => ({ scope, rows, advanced })) };
  });
}

export function captureSessionShape({ root, sessionId, transcript }) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId)) throw new Error("invalid-session");
  const data = realpathSync(root);
  let record;
  const managed = observe(() => {
    record = readObject(sourcePath(data, "claude-managed", sessionId + ".json"));
    if (record.id !== sessionId) {
      record = undefined;
      throw new Error("record-mismatch");
    }
    return selectManaged(record);
  });
  return {
    schemaVersion: 1,
    provider: "claude-code",
    consistency: "independent-sources",
    managed,
    ledger: observe(() =>
      withReadTransaction(sourcePath(data, "codex-managed", "executions.sqlite"), (db) => ({
        receipts: selectCommands(db, sessionId),
        host: selectStoredObject(db, "claude_host_states", sessionId, selectHost),
        lead: selectStoredObject(db, "orchestration_leads", sessionId, selectLead),
        readCursors: selectReadCursors(db, record),
      })),
    ),
    catalog: observe(() =>
      withReadTransaction(sourcePath(data, "agentkib.db"), (db) => ({
        tables: Object.fromEntries(
          ["workspaces", "conversation_sessions", "conversation_collection_sessions"].map(
            (table) => [
              table,
              hasTable(db, table)
                ? db.prepare("SELECT count(*) AS rows FROM " + table).get().rows
                : "missing",
            ],
          ),
        ),
      })),
    ),
    bridge: observe(() =>
      selectBridge(readObject(sourcePath(data, "claude-bridge", "bindings-v1.json")), sessionId),
    ),
    transcript:
      record?.nativeId && path.basename(transcript) !== record.nativeId + ".jsonl"
        ? { status: "mismatch" }
        : captureTranscriptShape(transcript),
  };
}
