import type { ConversationTurnMeta } from "@agentkib/runtime-protocol";
import { openManagedLedger } from "./managed-ledger";

/**
 * Turn ends of managed Claude sessions. A print-mode transcript records no `system/turn_duration`
 * (checked against 2.1.311), so the `result` frame's `duration_ms` would be lost once history
 * replaces the live rows. It is kept here, keyed by the native session and the turn's last agent
 * message, and history reads add it back. Display only: nothing here gates control.
 */
const MAX_PER_SESSION = 1000;
const nativeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Agent-message IDs: the assistant record UUID, `:text:<index>` for later text blocks.
const itemIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?::text:\d{1,4})?$/i;
const outcomes = new Set(["completed", "aborted", "failed"]);
const TABLE =
  "CREATE TABLE IF NOT EXISTS claude_turn_meta(sequence INTEGER PRIMARY KEY AUTOINCREMENT, native_id TEXT NOT NULL, item_id TEXT NOT NULL, meta TEXT NOT NULL, UNIQUE(native_id,item_id))";

/** The known fields of a turn end, or null when none is usable. */
export function cleanTurnMeta(value: unknown): ConversationTurnMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const meta: ConversationTurnMeta = {};
  if (typeof source.outcome === "string" && outcomes.has(source.outcome))
    meta.outcome = source.outcome as ConversationTurnMeta["outcome"];
  if (
    typeof source.duration_ms === "number" &&
    Number.isSafeInteger(source.duration_ms) &&
    source.duration_ms >= 0
  )
    meta.duration_ms = source.duration_ms;
  return meta.outcome !== undefined || meta.duration_ms !== undefined ? meta : null;
}

export class ClaudeTurnMetaStore {
  constructor(
    readonly dataDir: string,
    readonly maxPerSession = MAX_PER_SESSION,
  ) {}

  /** Keeps the newest entries of each session; a repeated item replaces its value. */
  record(nativeId: string, itemId: string, value: unknown): boolean {
    const meta = cleanTurnMeta(value);
    if (!meta || !nativeIdPattern.test(nativeId) || !itemIdPattern.test(itemId)) return false;
    const database = openManagedLedger(this.dataDir, true)!;
    try {
      database.exec(TABLE);
      database.exec("BEGIN IMMEDIATE");
      database
        .prepare(
          "INSERT INTO claude_turn_meta(native_id,item_id,meta) VALUES(?,?,?) ON CONFLICT(native_id,item_id) DO UPDATE SET meta=excluded.meta",
        )
        .run(nativeId, itemId, JSON.stringify(meta));
      database
        .prepare(
          "DELETE FROM claude_turn_meta WHERE native_id=? AND sequence NOT IN (SELECT sequence FROM claude_turn_meta WHERE native_id=? ORDER BY sequence DESC LIMIT ?)",
        )
        .run(nativeId, nativeId, this.maxPerSession);
      database.exec("COMMIT");
      return true;
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        /* Preserve the write failure. */
      }
      throw error;
    } finally {
      database.close();
    }
  }

  /** A deleted session's turn ends go with it. */
  forget(nativeId: string): void {
    const database = openManagedLedger(this.dataDir);
    if (!database) return;
    try {
      database.exec(TABLE);
      database.prepare("DELETE FROM claude_turn_meta WHERE native_id=?").run(nativeId);
    } finally {
      database.close();
    }
  }

  /** The stored turn ends for these items; rows that no longer validate are skipped. */
  read(nativeId: string, itemIds: readonly string[]): Map<string, ConversationTurnMeta> {
    const found = new Map<string, ConversationTurnMeta>();
    const wanted = [...new Set(itemIds.filter((id) => itemIdPattern.test(id)))];
    if (!wanted.length || !nativeIdPattern.test(nativeId)) return found;
    const database = openManagedLedger(this.dataDir);
    if (!database) return found;
    try {
      if (
        !database
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='claude_turn_meta'")
          .get()
      )
        return found;
      const rows = database
        .prepare(
          `SELECT item_id, meta FROM claude_turn_meta WHERE native_id=? AND item_id IN (${wanted.map(() => "?").join(",")})`,
        )
        .all(nativeId, ...wanted) as Array<{ item_id: string; meta: string }>;
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.meta);
        } catch {
          continue;
        }
        const meta = cleanTurnMeta(parsed);
        if (meta) found.set(row.item_id, meta);
      }
      return found;
    } finally {
      database.close();
    }
  }
}
