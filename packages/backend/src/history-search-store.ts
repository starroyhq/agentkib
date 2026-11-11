import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, type Stats } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { z } from "zod";
import type {
  HistoryCoverage,
  HistoryLocatedRecord,
  HistoryLocation,
  HistoryRecordKind,
  HistorySearchHit,
  HistorySearchQuery,
  HistorySearchResult,
  HistorySearchStatus,
} from "@agentkib/runtime-protocol";
import { literalHistoryMatchRanges, normalizeHistorySearchText } from "@agentkib/runtime-protocol";
import { isReparseOrSymlink } from "./native-files";
import {
  HISTORY_SEARCH_SANITIZER_VERSION,
  type OpenClawHistorySourceBinding,
} from "./history-search-source-types";

export const CONTENT_SEARCH_BUDGET = 1024 * 1024 * 1024;
/**
 * The share of the budget one session's text may take. Stored text costs about seven times its
 * size (two copies and the trigram index), so a single very long history fills about a quarter
 * of the cache instead of displacing the rest.
 */
const SESSION_TEXT_SHARE = 1 / 32;
const SESSION_TEXT_FLOOR = 32 * 1024 * 1024;
const CHUNK_SIZE = 8192;
const CHUNK_OVERLAP = 512; // At least 256 Unicode query characters, including surrogate pairs.
const MAX_SCANNED_CHUNKS = 20_000;
type Row = Record<string, unknown>;
export interface SearchSession {
  sessionId: string;
  workspaceId: string;
  agent: string;
  title: string | null;
  updatedAt: string | null;
  archived: boolean;
  ownerKey: string;
}
type CoverageSession = Pick<SearchSession, "sessionId" | "agent">;
type ExistingChunk = { id: number; identity: string };
/** Where a chunk sits in its session; equal content at the same place is the same chunk. */
const chunkPlace = (ordinal: number, start: number, recordId: string) =>
  `${ordinal}\0${start}\0${recordId}`;
const chunkIdentity = (
  hash: string,
  kind: string,
  toolName: string | null,
  timestamp: string | null,
) => JSON.stringify([hash, kind, toolName, timestamp]);
/** Stays under a statement's bound-parameter limit. */
const DELETE_BATCH = 500;
export interface SearchRecord {
  recordId: string;
  ordinal: number;
  kind: HistoryRecordKind;
  toolName: string | null;
  timestamp: string | null;
  content: string;
}
export const historyLocationSchema = z.object({
  sessionId: z.string().min(1).max(256),
  recordId: z.string().min(1).max(1024),
  chunkId: z.string().min(1).max(128),
  sourceRevision: z.string().min(1).max(256),
});
export const historyReferenceSchema = historyLocationSchema.extend({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const historyQuerySchema = z.object({
  query: z
    .string()
    .refine((value) => Array.from(value).length <= 256 && Buffer.byteLength(value) <= 4096),
  workspaceIds: z.array(z.string().min(1).max(256)).max(2000).optional(),
  agents: z.array(z.string().max(40)).max(8).optional(),
  kinds: z
    .array(z.enum(["user", "assistant", "tool-input", "tool-output"]))
    .max(4)
    .optional(),
  archived: z.boolean().optional(),
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(30),
});
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function emptyCoverage(): HistoryCoverage {
  return { total: 0, ready: 0, building: 0, partial: 0, stale: 0, unavailable: 0, limitations: [] };
}
const toolOnlyLimitations = new Set([
  "unsupported-tool-input",
  "damaged-tool-input",
  "damaged-tool-output",
  "unsupported-tool-record",
  "unsupported-tool-content",
]);
const bodyOnlyLimitations = new Set(["damaged-text-block", "unsupported-text-content"]);
function recordCoverageState(
  state: string,
  limitations: string[],
  agent: string,
  kind: "body" | "tools",
): string {
  // Derive each kind from persisted evidence, including caches written before this
  // projection existed. Unknown omissions and nonterminal states affect both kinds.
  if (
    state === "partial" &&
    limitations.length > 0 &&
    limitations.every((code) =>
      kind === "body"
        ? toolOnlyLimitations.has(code) ||
          (agent === "cursor" && code === "cursor-tools-unsupported")
        : bodyOnlyLimitations.has(code),
    )
  )
    return "ready";
  return state;
}
function addCoverage(coverage: HistoryCoverage, state: string): void {
  coverage.total++;
  if (
    state === "ready" ||
    state === "building" ||
    state === "partial" ||
    state === "stale" ||
    state === "unavailable"
  )
    coverage[state]++;
}
function contentCoverage(coverage: HistoryCoverage): "supported" | "partial" | "unavailable" {
  return coverage.ready === coverage.total
    ? "supported"
    : coverage.ready + coverage.partial + coverage.stale > 0
      ? "partial"
      : "unavailable";
}
export function emptySearchStatus(enabled = false): HistorySearchStatus {
  return {
    enabled,
    generation: "",
    bytes: 0,
    limitBytes: CONTENT_SEARCH_BUDGET,
    budgetExceeded: false,
    coverage: emptyCoverage(),
  };
}
export function unicodeBoundary(text: string, offset: number): boolean {
  return (
    offset >= 0 &&
    offset <= text.length &&
    !(
      offset > 0 &&
      offset < text.length &&
      /[\uD800-\uDBFF]/.test(text[offset - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[offset]!)
    )
  );
}
export function* textChunks(content: string): Generator<{ start: number; content: string }> {
  for (let start = 0; start < content.length;) {
    let end = Math.min(content.length, start + CHUNK_SIZE);
    if (!unicodeBoundary(content, end)) end--;
    yield { start, content: content.slice(start, end) };
    if (end === content.length) break;
    start = end - CHUNK_OVERLAP;
    if (!unicodeBoundary(content, start)) start--;
  }
}
export function matchRanges(content: string, needle: string): Array<[number, number]> {
  return literalHistoryMatchRanges(content, needle);
}

// Node 22's SQLite TEXT decoder truncates at NUL; BLOB projections retain every UTF-8 byte.
function sqliteText(value: unknown): string {
  if (!(value instanceof Uint8Array)) throw new Error("Invalid content search text");
  return Buffer.from(value).toString("utf8");
}
function nullableSqliteText(value: unknown): string | null {
  return value === null ? null : sqliteText(value);
}

const SOURCE_VALIDATION_VERSION = "6";
// Casing tables can change with the bundled Node runtime as well as this algorithm.
const NORMALIZATION_VERSION = `1:${process.versions.unicode}`;
const openClawBindingSchema = z.object({
  home: z.string().min(1).max(32768),
  agentId: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(32768),
});

function safeFile(filename: string) {
  for (const file of [filename, `${filename}-wal`, `${filename}-shm`]) {
    // existsSync follows links and treats a dangling link as missing; SQLite would follow it.
    let stat: Stats;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!stat.isFile() || isReparseOrSymlink(file, stat))
      throw new Error("Unsafe content search cache");
  }
}
export class HistorySearchStore {
  readonly db: DatabaseSync;
  #pageSize?: number;
  #pageCount?: StatementSync;
  #freePages?: StatementSync;
  /** The committed chunks of the session being rebuilt that the new snapshot has not matched. */
  #insert?: StatementSync;
  #build?: {
    session: SearchSession;
    generation: string;
    live: string | null;
    unmatched: Map<string, ExistingChunk>;
    /** Text taken from this snapshot so far, and whether its allowance ran out. */
    bytes: number;
    capped: boolean;
  };
  constructor(
    readonly filename: string,
    readonly writable: boolean,
    readonly limitBytes = CONTENT_SEARCH_BUDGET,
    /** How much text of one session is kept; the rest of a longer history is left out. */
    readonly sessionTextBytes = Math.max(limitBytes * SESSION_TEXT_SHARE, SESSION_TEXT_FLOOR),
  ) {
    if (writable) mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    safeFile(filename);
    this.db = new DatabaseSync(filename, { readOnly: !writable });
    try {
      this.db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;");
      if (writable) {
        chmodSync(filename, 0o600);
        // A rebuildable cache: syncing every commit and checkpointing every megabyte only
        // multiplies writes. WAL with synchronous=NORMAL still cannot corrupt the database.
        this.db
          .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=2048;
          CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(
            session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent TEXT NOT NULL,
            title TEXT, updated_at TEXT, archived INTEGER NOT NULL, owner_key TEXT NOT NULL,
            generation TEXT, source_revision TEXT, status TEXT NOT NULL,
            limitations TEXT NOT NULL DEFAULT '[]', indexed_at INTEGER);
          CREATE TABLE IF NOT EXISTS source_bindings(
            session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
            binding TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS chunks(
            id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
            generation TEXT NOT NULL, record_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            kind TEXT NOT NULL, tool_name TEXT, timestamp TEXT, chunk_id TEXT NOT NULL,
            start INTEGER NOT NULL, content TEXT NOT NULL, normalized TEXT NOT NULL, content_hash TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session_id,generation,ordinal,start);
          CREATE INDEX IF NOT EXISTS chunks_location ON chunks(session_id,generation,record_id,chunk_id);
          CREATE INDEX IF NOT EXISTS chunks_identity ON chunks(session_id,generation,ordinal,start,record_id,content_hash,kind,tool_name,timestamp);
          CREATE TABLE IF NOT EXISTS source_stamps(
            session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
            revision TEXT NOT NULL, stamp TEXT NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(normalized,content='chunks',content_rowid='id',tokenize='trigram');
          CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid,normalized) VALUES(new.id,new.normalized); END;
          CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts,rowid,normalized) VALUES('delete',old.id,old.normalized); END;`);
        const version = this.value("version");
        if (version !== undefined && version !== "1")
          throw new Error("Unsupported content search cache version; rebuild required");
        this.set("version", "1");
        // Older derived caches may contain text accepted after a redaction or ownership failure.
        // Rebuild before a query worker can observe them; native history is unaffected.
        if (
          this.value("sanitizer_version") !== HISTORY_SEARCH_SANITIZER_VERSION ||
          this.value("source_validation_version") !== SOURCE_VALIDATION_VERSION ||
          this.value("normalization_version") !== NORMALIZATION_VERSION
        )
          this.transaction(() => {
            this.db.exec("DELETE FROM sessions");
            this.set("budgetExceeded", "false");
            this.set("sanitizer_version", HISTORY_SEARCH_SANITIZER_VERSION);
            this.set("source_validation_version", SOURCE_VALIDATION_VERSION);
            this.set("normalization_version", NORMALIZATION_VERSION);
            this.bump();
          });
        if (!this.value("generation")) this.bump();
        this.db.exec(
          "DELETE FROM chunks WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id=chunks.session_id AND s.generation=chunks.generation); UPDATE sessions SET status=CASE WHEN generation IS NULL THEN 'unavailable' ELSE 'stale' END WHERE status='building';",
        );
      } else this.db.exec("PRAGMA query_only=ON;");
      if (this.value("version") !== "1")
        throw new Error("Unsupported content search cache version");
      if (this.value("sanitizer_version") !== HISTORY_SEARCH_SANITIZER_VERSION)
        throw new Error("Obsolete content search sanitizer; rebuild required");
      if (this.value("source_validation_version") !== SOURCE_VALIDATION_VERSION)
        throw new Error("Obsolete content search source validation; rebuild required");
      if (this.value("normalization_version") !== NORMALIZATION_VERSION)
        throw new Error("Obsolete content search normalization; rebuild required");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  budgetExceeded() {
    return this.value("budgetExceeded") === "true";
  }
  /** Bytes in live pages. Pages freed by a deleted generation are reused by later inserts. */
  private usedBytes(): number {
    this.#pageSize ??= Number(this.db.prepare("PRAGMA page_size").get()!.page_size);
    this.#pageCount ??= this.db.prepare("PRAGMA page_count");
    this.#freePages ??= this.db.prepare("PRAGMA freelist_count");
    return (
      (Number(this.#pageCount.get()!.page_count) - Number(this.#freePages.get()!.freelist_count)) *
      this.#pageSize
    );
  }
  /**
   * Indexing resumes once deletions leave clear room; just under the limit would flap. Call only
   * after something was deleted: a session too large for the room that is left would otherwise
   * be staged and discarded again on every pass.
   */
  private relieveBudget() {
    if (this.budgetExceeded() && this.usedBytes() < this.limitBytes * 0.9)
      this.set("budgetExceeded", "false");
  }
  /**
   * Records why a session has no current index, without opening a generation. Writes only when
   * the row changes: a full cache or an unreadable source used to rewrite every such session on
   * every refresh pass.
   */
  markUnindexed(session: SearchSession, limitation: string) {
    const limitations = JSON.stringify([limitation]);
    const budget = limitation === "cache-budget-exceeded";
    const row = this.db
      .prepare("SELECT *,CAST(title AS BLOB) AS title_bytes FROM sessions WHERE session_id=?")
      .get(session.sessionId);
    const kept = row?.generation && row.owner_key === session.ownerKey;
    const status = kept ? "stale" : "unavailable";
    const same =
      row &&
      row.workspace_id === session.workspaceId &&
      row.agent === session.agent &&
      nullableSqliteText(row.title_bytes) === session.title &&
      row.updated_at === session.updatedAt &&
      row.archived === Number(session.archived) &&
      row.owner_key === session.ownerKey &&
      row.status === status &&
      row.limitations === limitations;
    if (same && (!budget || this.budgetExceeded())) return;
    this.transaction(() => {
      if (!same) {
        if (row && row.owner_key !== session.ownerKey)
          this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(session.sessionId);
        this.db
          .prepare(`INSERT INTO sessions(session_id,workspace_id,agent,title,updated_at,archived,owner_key,status,limitations)
          VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
          workspace_id=excluded.workspace_id,agent=excluded.agent,title=excluded.title,updated_at=excluded.updated_at,
          archived=excluded.archived,owner_key=excluded.owner_key,status=excluded.status,limitations=excluded.limitations`)
          .run(
            session.sessionId,
            session.workspaceId,
            session.agent,
            session.title,
            session.updatedAt,
            Number(session.archived),
            session.ownerKey,
            status,
            limitations,
          );
        this.bump();
      }
      if (budget) this.set("budgetExceeded", "true");
    });
  }
  private value(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key);
    return row ? String(row.value) : undefined;
  }
  private set(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  private bump() {
    this.set("generation", randomUUID());
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  cachedSourceRevision(session: SearchSession): string | undefined {
    const row = this.db
      .prepare("SELECT *,CAST(title AS BLOB) AS title_bytes FROM sessions WHERE session_id=?")
      .get(session.sessionId);
    if (
      !row?.generation ||
      !["ready", "partial"].includes(String(row.status)) ||
      row.workspace_id !== session.workspaceId ||
      row.agent !== session.agent ||
      nullableSqliteText(row.title_bytes) !== session.title ||
      row.updated_at !== session.updatedAt ||
      row.archived !== Number(session.archived) ||
      row.owner_key !== session.ownerKey
    )
      return undefined;
    return typeof row.source_revision === "string" ? row.source_revision : undefined;
  }
  cachedOpenClawBinding(session: SearchSession): OpenClawHistorySourceBinding | undefined {
    if (session.agent !== "open-claw") return undefined;
    const row = this.db
      .prepare(`SELECT CAST(b.binding AS BLOB) AS binding FROM source_bindings b
      JOIN sessions s ON s.session_id=b.session_id
      WHERE s.session_id=? AND s.workspace_id=? AND s.agent=? AND s.owner_key=? AND s.generation IS NOT NULL`)
      .get(session.sessionId, session.workspaceId, session.agent, session.ownerKey);
    // Keep identity evidence through a temporary read failure; stale is not revoked.
    return row ? openClawBindingSchema.parse(JSON.parse(sqliteText(row.binding))) : undefined;
  }
  begin(session: SearchSession): string {
    const generation = randomUUID();
    this.transaction(() => {
      const old = this.db
        .prepare("SELECT owner_key FROM sessions WHERE session_id=?")
        .get(session.sessionId);
      if (old && old.owner_key !== session.ownerKey)
        this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(session.sessionId);
      this.db
        .prepare(`INSERT INTO sessions(session_id,workspace_id,agent,title,updated_at,archived,owner_key,status)
        VALUES(?,?,?,?,?,?,?,'building') ON CONFLICT(session_id) DO UPDATE SET
        workspace_id=excluded.workspace_id,agent=excluded.agent,title=excluded.title,updated_at=excluded.updated_at,
        archived=excluded.archived,owner_key=excluded.owner_key,status='building'`)
        .run(
          session.sessionId,
          session.workspaceId,
          session.agent,
          session.title,
          session.updatedAt,
          Number(session.archived),
          session.ownerKey,
        );
      this.bump();
    });
    // Only chunks that differ from the committed ones are written, so a session that grew by
    // one turn costs that turn, not its whole history again.
    const live = this.db
      .prepare("SELECT generation FROM sessions WHERE session_id=?")
      .get(session.sessionId)?.generation;
    const unmatched = new Map<string, ExistingChunk>();
    if (typeof live === "string")
      for (const row of this.db
        .prepare(`SELECT id,ordinal,start,CAST(record_id AS BLOB) AS record_id,content_hash,kind,
          CAST(tool_name AS BLOB) AS tool_name,CAST(timestamp AS BLOB) AS timestamp
          FROM chunks INDEXED BY chunks_identity WHERE session_id=? AND generation=?`)
        .all(session.sessionId, live))
        unmatched.set(
          chunkPlace(Number(row.ordinal), Number(row.start), sqliteText(row.record_id)),
          {
            id: Number(row.id),
            identity: chunkIdentity(
              String(row.content_hash),
              String(row.kind),
              nullableSqliteText(row.tool_name),
              nullableSqliteText(row.timestamp),
            ),
          },
        );
    this.#build = {
      session,
      generation,
      live: typeof live === "string" ? live : null,
      unmatched,
      bytes: 0,
      capped: false,
    };
    return generation;
  }
  append(sessionId: string, generation: string, record: SearchRecord, checkpoint: () => void) {
    const build = this.#build?.generation === generation ? this.#build : undefined;
    const insert = (this.#insert ??= this.db.prepare(
      `INSERT INTO chunks(session_id,generation,record_id,ordinal,kind,tool_name,timestamp,chunk_id,start,content,normalized,content_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    ));
    let began = false;
    try {
      for (const chunk of textChunks(record.content)) {
        checkpoint();
        if (build) {
          // Keeps the beginning of an over-long history: a stable prefix is not rewritten when
          // the history grows, which a window over its latest part would be.
          if (build.capped) return;
          build.bytes += Buffer.byteLength(chunk.content);
          if (build.bytes > this.sessionTextBytes) {
            build.capped = true;
            return;
          }
        }
        const hash = contentHash(chunk.content);
        const place = chunkPlace(record.ordinal, chunk.start, record.recordId);
        const existing = build?.unmatched.get(place);
        if (
          existing?.identity === chunkIdentity(hash, record.kind, record.toolName, record.timestamp)
        ) {
          build!.unmatched.delete(place);
          continue;
        }
        if (!began) {
          this.db.exec("BEGIN IMMEDIATE");
          began = true;
        }
        insert.run(
          sessionId,
          generation,
          record.recordId,
          record.ordinal,
          record.kind,
          record.toolName,
          record.timestamp,
          contentHash(`${record.recordId}:${chunk.start}`),
          chunk.start,
          chunk.content,
          normalizeHistorySearchText(chunk.content),
          hash,
        );
        // Account for SQLite and FTS overhead rather than only counting raw source bytes.
        if (this.usedBytes() > this.limitBytes && !(build && this.makeRoom(build.session)))
          throw new Error("history-search-budget-exceeded");
      }
      if (began) this.db.exec("COMMIT");
    } catch (error) {
      if (began) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /**
   * Drops the cached text of sessions last updated before this one until the cache has room
   * again, oldest first. Returns false when nothing older is left, so recent sessions stay
   * searchable and a session never displaces a newer one.
   */
  makeRoom(session: SearchSession): boolean {
    const target = this.limitBytes * 0.9;
    const older = this.db
      .prepare(
        `SELECT session_id FROM sessions WHERE session_id!=? AND generation IS NOT NULL
        AND COALESCE(updated_at,'')<COALESCE(?,'') ORDER BY COALESCE(updated_at,''),session_id`,
      )
      .all(session.sessionId, session.updatedAt);
    for (const row of older) {
      if (this.usedBytes() <= target) break;
      this.db.prepare("DELETE FROM chunks WHERE session_id=?").run(row.session_id!);
      this.db.prepare("DELETE FROM source_stamps WHERE session_id=?").run(row.session_id!);
      this.db
        .prepare(
          "UPDATE sessions SET generation=NULL,source_revision=NULL,indexed_at=NULL,status='unavailable',limitations=? WHERE session_id=?",
        )
        .run(JSON.stringify(["cache-budget-exceeded"]), row.session_id!);
      this.bump();
    }
    return this.usedBytes() <= this.limitBytes;
  }
  /** Whether a full cache could still take this session by dropping older ones. */
  canMakeRoom(session: SearchSession): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM sessions WHERE session_id!=? AND generation IS NOT NULL
          AND COALESCE(updated_at,'')<COALESCE(?,'') LIMIT 1`,
        )
        .get(session.sessionId, session.updatedAt) !== undefined
    );
  }
  finish(
    sessionId: string,
    generation: string,
    revision: string,
    state: "ready" | "partial",
    limitations: string[],
    openClawBinding?: OpenClawHistorySourceBinding,
    stamp?: string,
  ) {
    const build = this.#build?.generation === generation ? this.#build : undefined;
    this.#build = undefined;
    if (build?.capped) {
      state = "partial";
      limitations = [...new Set([...limitations, "cache-session-limit"])].sort();
    }
    this.transaction(() => {
      // Chunks carried over keep the committed generation; the new ones join it here.
      const live = build?.live ?? generation;
      let freed = false;
      if (build?.live) {
        const stale = [...build.unmatched.values()].map((chunk) => chunk.id);
        freed = stale.length > 0;
        for (let index = 0; index < stale.length; index += DELETE_BATCH) {
          const batch = stale.slice(index, index + DELETE_BATCH);
          this.db
            .prepare(`DELETE FROM chunks WHERE id IN (${batch.map(() => "?").join(",")})`)
            .run(...batch);
        }
        this.db
          .prepare("UPDATE chunks SET generation=? WHERE session_id=? AND generation=?")
          .run(live, sessionId, generation);
      }
      this.db
        .prepare(
          "UPDATE sessions SET generation=?,source_revision=?,status=?,limitations=?,indexed_at=? WHERE session_id=?",
        )
        .run(live, revision, state, JSON.stringify(limitations), Date.now(), sessionId);
      if (openClawBinding)
        this.db
          .prepare(
            "INSERT INTO source_bindings VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET binding=excluded.binding",
          )
          .run(sessionId, JSON.stringify(openClawBindingSchema.parse(openClawBinding)));
      else this.db.prepare("DELETE FROM source_bindings WHERE session_id=?").run(sessionId);
      const leftover = this.db
        .prepare("DELETE FROM chunks WHERE session_id=? AND generation!=?")
        .run(sessionId, live);
      this.saveStamp(sessionId, revision, stamp);
      if (freed || Number(leftover.changes) > 0) this.relieveBudget();
      this.bump();
    });
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }
  private saveStamp(sessionId: string, revision: string, stamp?: string) {
    if (stamp)
      this.db
        .prepare(
          "INSERT INTO source_stamps VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,stamp=excluded.stamp",
        )
        .run(sessionId, revision, stamp);
    else this.db.prepare("DELETE FROM source_stamps WHERE session_id=?").run(sessionId);
  }
  /**
   * What the source's files looked like when this revision was committed. An older AgentKib
   * leaves the stamp behind when it writes a revision, so it counts only for its own revision.
   */
  sourceStamp(sessionId: string, revision: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT CAST(stamp AS BLOB) AS stamp FROM source_stamps WHERE session_id=? AND revision=?",
      )
      .get(sessionId, revision);
    return row ? sqliteText(row.stamp) : undefined;
  }
  /** A source read in full and found unchanged is not read again while its files stay as they are. */
  rememberStamp(sessionId: string, revision: string, stamp: string) {
    if (this.sourceStamp(sessionId, revision) === stamp) return;
    this.transaction(() => this.saveStamp(sessionId, revision, stamp));
  }
  abort(
    sessionId: string,
    generation: string,
    budget: boolean,
    options: {
      unsafeContent?: boolean;
      ownerChanged?: boolean;
      sourceFailure?: "damaged-record" | "source-byte-limit";
    } = {},
  ) {
    if (this.#build?.generation === generation) this.#build = undefined;
    this.transaction(() => {
      if (options.unsafeContent || options.ownerChanged) {
        this.db.prepare("DELETE FROM chunks WHERE session_id=?").run(sessionId);
        this.db.prepare("DELETE FROM source_bindings WHERE session_id=?").run(sessionId);
        this.db.prepare("DELETE FROM source_stamps WHERE session_id=?").run(sessionId);
        this.db
          .prepare(
            "UPDATE sessions SET generation=NULL,source_revision=NULL,indexed_at=NULL WHERE session_id=?",
          )
          .run(sessionId);
      } else
        this.db
          .prepare("DELETE FROM chunks WHERE session_id=? AND generation=?")
          .run(sessionId, generation);
      this.db
        .prepare(
          "UPDATE sessions SET status=CASE WHEN generation IS NULL THEN 'unavailable' ELSE 'stale' END,limitations=? WHERE session_id=?",
        )
        .run(
          JSON.stringify([
            options.ownerChanged
              ? "source-owner-changed"
              : options.unsafeContent
                ? "source-redaction-failed"
                : budget
                  ? "cache-budget-exceeded"
                  : (options.sourceFailure ?? "source-unavailable"),
          ]),
          sessionId,
        );
      if (budget) this.set("budgetExceeded", "true");
      this.bump();
    });
    // Only an abandoned oversized generation leaves a log worth truncating.
    this.db.exec(`PRAGMA wal_checkpoint(${budget ? "TRUNCATE" : "PASSIVE"})`);
  }
  prune(owners: Array<{ sessionId: string; ownerKey: string }>) {
    const keep = new Map(owners.map((owner) => [owner.sessionId, owner.ownerKey]));
    this.transaction(() => {
      let removed = false;
      for (const row of this.db.prepare("SELECT session_id,owner_key FROM sessions").all())
        if (keep.get(String(row.session_id)) !== row.owner_key) {
          this.db.prepare("DELETE FROM sessions WHERE session_id=?").run(row.session_id!);
          this.bump();
          removed = true;
        }
      if (removed) this.relieveBudget();
    });
  }
  withdraw(sessionId: string, ownerKey: string) {
    this.transaction(() => {
      const removed = this.db
        .prepare("DELETE FROM sessions WHERE session_id=? AND owner_key=?")
        .run(sessionId, ownerKey);
      if (Number(removed.changes) > 0) this.relieveBudget();
      this.bump();
    });
  }
  status(
    allowedSessionIds: string[],
    knownSessions: readonly CoverageSession[] = [],
  ): HistorySearchStatus {
    const allowed = new Set(allowedSessionIds),
      unvisited = new Set(allowed),
      coverage = emptyCoverage();
    const limitations = new Set<string>();
    const agents = new Map<
      string,
      { coverage: HistoryCoverage; body: HistoryCoverage; tools: HistoryCoverage }
    >();
    const agentCoverage = (agent: string) => {
      let detail = agents.get(agent);
      if (!detail) {
        detail = { coverage: emptyCoverage(), body: emptyCoverage(), tools: emptyCoverage() };
        agents.set(agent, detail);
      }
      return detail;
    };
    const revisions: unknown[] = [];
    for (const row of this.db
      .prepare(
        "SELECT session_id,agent,status,limitations,generation,source_revision,indexed_at FROM sessions ORDER BY session_id",
      )
      .all()) {
      if (!allowed.has(String(row.session_id))) continue;
      unvisited.delete(String(row.session_id));
      revisions.push(row);
      const agent = String(row.agent),
        detail = agentCoverage(agent);
      const state = String(row.status);
      const sourceLimitations = JSON.parse(String(row.limitations)) as string[];
      addCoverage(coverage, state);
      addCoverage(detail.coverage, state);
      addCoverage(detail.body, recordCoverageState(state, sourceLimitations, agent, "body"));
      addCoverage(detail.tools, recordCoverageState(state, sourceLimitations, agent, "tools"));
      for (const limitation of sourceLimitations) {
        limitations.add(limitation);
        if (!detail.coverage.limitations.includes(limitation))
          detail.coverage.limitations.push(limitation);
      }
    }
    // Pending histories have no database row yet. Use the host's scoped catalog
    // metadata only after the same ownership/permission filter as indexed rows.
    coverage.total += unvisited.size;
    coverage.building += unvisited.size;
    for (const session of knownSessions) {
      if (!unvisited.delete(session.sessionId)) continue;
      const detail = agentCoverage(session.agent);
      addCoverage(detail.coverage, "building");
      addCoverage(detail.body, "building");
      addCoverage(detail.tools, "building");
    }
    coverage.limitations = [...limitations].sort();
    // Never expose bytes belonging to a workspace outside the caller's scope.
    let bytes = 0;
    for (const row of this.db
      .prepare(
        "SELECT session_id,SUM(length(CAST(content AS BLOB))) AS bytes FROM chunks GROUP BY session_id",
      )
      .all())
      if (allowed.has(String(row.session_id))) bytes += Number(row.bytes);
    return {
      enabled: true,
      generation: contentHash(JSON.stringify(revisions)),
      bytes,
      limitBytes: this.limitBytes,
      budgetExceeded: limitations.has("cache-budget-exceeded"),
      coverage,
      sources: [...agents].map(([agent, detail]) => ({
        agent,
        body: contentCoverage(detail.body),
        tools: agent === "cursor" ? "unsupported" : contentCoverage(detail.tools),
        coverage: detail.coverage,
      })),
    };
  }
  authorizedOwners(owners: Array<{ sessionId: string; ownerKey: string }>): string[] {
    const current = new Map(
      this.db
        .prepare("SELECT session_id,owner_key FROM sessions")
        .all()
        .map((row) => [String(row.session_id), String(row.owner_key)]),
    );
    return owners
      .filter(
        (owner) => !current.has(owner.sessionId) || current.get(owner.sessionId) === owner.ownerKey,
      )
      .map((owner) => owner.sessionId);
  }
  query(
    input: HistorySearchQuery,
    allowedSessionIds: string[],
    checkpoint: () => void,
    knownSessions: readonly CoverageSession[] = [],
  ): HistorySearchResult {
    const request = historyQuerySchema.parse(input),
      status = this.status(allowedSessionIds, knownSessions);
    const needle = normalizeHistorySearchText(request.query);
    if (!needle || !allowedSessionIds.length)
      return { hits: [], nextCursor: null, status, limited: false };
    const allowed = new Set(allowedSessionIds);
    const scope = contentHash(
      JSON.stringify([
        request.query,
        request.workspaceIds,
        request.agents,
        request.kinds,
        request.archived,
        [...allowed].sort(),
      ]),
    );
    let after: [string, string, number, string, number] | undefined;
    if (request.cursor) {
      let cursor: { generation: string; scope: string; after: typeof after };
      try {
        cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString());
      } catch {
        throw new Error("history-search-cursor-invalid");
      }
      if (cursor.generation !== status.generation || cursor.scope !== scope)
        throw new Error("history-search-cursor-stale");
      const parsed = z
        .tuple([
          z.string(),
          z.string(),
          z.number().int().safe(),
          z.string(),
          z.number().int().safe(),
        ])
        .safeParse(cursor.after);
      if (!parsed.success) throw new Error("history-search-cursor-invalid");
      after = parsed.data;
    }
    const clauses = ["c.generation=s.generation"],
      args: SQLInputValue[] = [];
    const inList = (name: string, values: string[] | undefined) => {
      if (values) {
        clauses.push(values.length ? `${name} IN (${values.map(() => "?").join(",")})` : "0");
        args.push(...values);
      }
    };
    // Scope goes into the SQL before the scan budget, ordering, snippets or counts.
    inList("s.session_id", [...allowed]);
    inList("s.workspace_id", request.workspaceIds);
    inList("s.agent", request.agents);
    inList("c.kind", request.kinds);
    if (request.archived !== undefined) {
      clauses.push("s.archived=?");
      args.push(Number(request.archived));
    }
    const trigram = Array.from(needle).length >= 3 && !needle.includes("\0");
    if (trigram) {
      clauses.push("c.id IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?)");
      args.push(`"${needle.replaceAll('"', '""')}"`);
    }
    if (after) {
      clauses.push(
        "(COALESCE(s.updated_at,'')<? OR (COALESCE(s.updated_at,'')=? AND (s.session_id,-c.ordinal,c.record_id,c.start)>(?,?,?,?)))",
      );
      args.push(after[0], after[0], ...after.slice(1));
    }
    const iterator = this.db
      .prepare(`SELECT c.*,CAST(c.content AS BLOB) AS content_bytes,CAST(c.tool_name AS BLOB) AS tool_name_bytes,
      CAST(s.title AS BLOB) AS title_bytes,s.workspace_id,s.agent,s.updated_at,s.source_revision,s.status,s.indexed_at
      FROM chunks c JOIN sessions s ON s.session_id=c.session_id WHERE ${clauses.join(" AND ")}
      ORDER BY COALESCE(s.updated_at,'') DESC,s.session_id,c.ordinal DESC,c.record_id,c.start`)
      .iterate(...args);
    const hits: HistorySearchHit[] = [],
      seen = new Set<string>();
    let scanned = 0,
      limited = false,
      last: Row | undefined;
    // A pagination cursor is based on the last inspected chunk, including nonmatching short terms.
    for (const row of iterator) {
      checkpoint();
      last = row;
      scanned++;
      const content = sqliteText(row.content_bytes);
      const ranges = matchRanges(content, needle);
      if (ranges.length) {
        const key = `${row.session_id}:${row.record_id}`;
        if (!seen.has(key)) {
          seen.add(key);
          const first = ranges[0]!;
          let start = Math.max(0, first[0] - 100),
            end = Math.min(content.length, Math.max(first[1] + 100, start + 320));
          if (!unicodeBoundary(content, start)) start--;
          if (!unicodeBoundary(content, end)) end++;
          hits.push({
            location: this.location(row),
            workspaceId: String(row.workspace_id),
            agent: String(row.agent),
            title: nullableSqliteText(row.title_bytes),
            timestamp: row.timestamp as string | null,
            kind: row.kind as HistoryRecordKind,
            toolName: nullableSqliteText(row.tool_name_bytes),
            snippet: content.slice(start, end),
            matchRanges: ranges
              .filter(([a, b]) => a >= start && b <= end)
              .map(([a, b]) => [a - start, b - start]),
            stale: row.status === "stale",
            indexedAt:
              typeof row.indexed_at === "number"
                ? new Date(row.indexed_at).toISOString()
                : undefined,
          });
        }
      }
      if (hits.length >= request.limit || scanned >= MAX_SCANNED_CHUNKS) {
        limited = scanned >= MAX_SCANNED_CHUNKS;
        break;
      }
    }
    const nextCursor =
      last && (hits.length >= request.limit || limited)
        ? Buffer.from(
            JSON.stringify({
              generation: status.generation,
              scope,
              after: [
                String(last.updated_at ?? ""),
                String(last.session_id),
                -Number(last.ordinal),
                String(last.record_id),
                seen.has(`${last.session_id}:${last.record_id}`)
                  ? Number.MAX_SAFE_INTEGER
                  : Number(last.start),
              ],
            }),
          ).toString("base64url")
        : null;
    return { hits, nextCursor, status, limited };
  }
  private location(row: Row): HistoryLocation {
    return {
      sessionId: String(row.session_id),
      recordId: String(row.record_id),
      chunkId: String(row.chunk_id),
      sourceRevision: String(row.source_revision),
    };
  }
  locate(input: HistoryLocation, allowedSessionIds: string[]): HistoryLocatedRecord {
    const location = historyLocationSchema.parse(input);
    if (!allowedSessionIds.includes(location.sessionId))
      throw new Error("history-source-unavailable");
    const row = this.db
      .prepare(`SELECT c.*,CAST(c.content AS BLOB) AS content_bytes,CAST(c.tool_name AS BLOB) AS tool_name_bytes,
      CAST(s.title AS BLOB) AS title_bytes,s.workspace_id,s.agent,s.source_revision FROM chunks c JOIN sessions s ON s.session_id=c.session_id
      WHERE c.session_id=? AND c.generation=s.generation AND c.record_id=? AND c.chunk_id=? AND s.source_revision=?`)
      .get(location.sessionId, location.recordId, location.chunkId, location.sourceRevision);
    if (!row) throw new Error("history-source-stale");
    const adjacent = (direction: "<" | ">", order: "ASC" | "DESC") =>
      this.db
        .prepare(`SELECT c.*,s.source_revision FROM chunks c JOIN sessions s ON s.session_id=c.session_id
      WHERE c.session_id=? AND c.generation=s.generation AND (c.ordinal,c.record_id,c.start) ${direction} (?,?,?)
      ORDER BY c.ordinal ${order},c.record_id ${order},c.start ${order} LIMIT 1`)
        .get(location.sessionId, row.ordinal!, row.record_id!, row.start!);
    const before = adjacent("<", "DESC"),
      after = adjacent(">", "ASC");
    return {
      location,
      workspaceId: String(row.workspace_id),
      agent: String(row.agent),
      title: nullableSqliteText(row.title_bytes),
      timestamp: row.timestamp as string | null,
      kind: row.kind as HistoryRecordKind,
      toolName: nullableSqliteText(row.tool_name_bytes),
      content: sqliteText(row.content_bytes),
      contentHash: String(row.content_hash),
      before: before ? this.location(before) : null,
      after: after ? this.location(after) : null,
    };
  }
}
