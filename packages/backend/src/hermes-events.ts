import { DatabaseSync } from "node:sqlite";
import { nativeFileIdentity } from "./native-files";
import { Sql } from "./sql";
import { stableNativeRef } from "./session-history";
import { textTimestamp } from "./hermes-sessions";
import { sessionTitle } from "./codex-sessions";
import { compareUtf8 } from "./workspaces";
import {
  hasText,
  toolStatus,
  truncateUtf8,
  MAX_MESSAGE_BYTES,
  MAX_PAGE_BYTES,
  type ConversationEvent,
  type ConversationEventPage,
} from "./session-events";
const MAX_I64 = 9223372036854775807n,
  MAX_U64 = 18446744073709551615n;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const bounded = (expression: string, chars = 1024) =>
  `substr(CAST((${expression}) AS TEXT),1,${chars})`;
const blob = (expression: string) => `CAST((${expression}) AS BLOB)`;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Uint8Array) return decoder.decode(value);
  if (typeof value === "string") return value;
  throw new Error("Invalid Hermes text field");
}
function digest(kind: string, parts: string[]): string {
  return stableNativeRef(kind, parts).slice(`${kind}-v1-`.length);
}
function integer(value: string, maximum: bigint): bigint {
  if (!/^[+]?\d+$/.test(value)) throw new Error("TRANSCRIPT_CURSOR_INVALID");
  const number = BigInt(value);
  if (number > maximum) throw new Error("TRANSCRIPT_CURSOR_INVALID");
  return number;
}
/** Stateless rowid pages bind the high-water row to the source file and a bounded content anchor. */
export function readHermesEvents(
  file: string,
  sessionId: string,
  cursor: string | null,
  limit: number,
): ConversationEventPage {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid event limit");
  const identity = nativeFileIdentity(file),
    db = new DatabaseSync(file, { readOnly: true });
  try {
    try {
      db.prepare("SELECT rowid FROM messages LIMIT 1");
    } catch {
      throw new Error("Hermes messages table does not support stable rowid paging");
    }
    const sql = new Sql(db),
      names = sql
        .rows("PRAGMA table_info(messages)")
        .map((row) => String(row.name))
        .sort(compareUtf8),
      column = (candidates: string[]) => names.find((name) => candidates.includes(name)),
      required = (candidates: string[], label: string) => {
        const name = column(candidates);
        if (!name) throw new Error(`Hermes messages table has no ${label} column`);
        return name;
      },
      session = required(
        ["session_id", "sessionId", "session", "conversation_id", "conversationId"],
        "session",
      ),
      role = bounded(quote(required(["role", "speaker"], "role"))),
      content = quote(required(["content", "text", "message"], "content")),
      timeColumn = column(["created_at", "timestamp", "ts"]),
      timestamp = bounded(timeColumn ? `CAST(${quote(timeColumn)} AS TEXT)` : "NULL"),
      coalesce = (candidates: string[]) => {
        const expressions = candidates
          .filter((name) => names.includes(name))
          .map((name) => `CAST(${quote(name)} AS TEXT)`);
        return expressions.length > 1
          ? `COALESCE(${expressions.join(",")})`
          : (expressions[0] ?? "NULL");
      };
    let statusExpression = coalesce(["status", "tool_status", "toolStatus"]);
    if (statusExpression === "NULL") {
      const error = column(["is_error", "isError"]);
      if (error)
        statusExpression = `CASE WHEN CAST(${quote(error)} AS TEXT) IN ('1','true','TRUE') THEN 'failed' ELSE 'completed' END`;
    }
    const status = bounded(statusExpression),
      tool = bounded(coalesce(["tool_name", "toolName", "name", "tool"])),
      source = digest("hermes-db-source", [file, sessionId]);
    const anchor = (rowid: bigint): string | null => {
      const row = sql.one(
        `SELECT ${blob(role)} AS role,length(CAST(${content} AS TEXT)) AS length,${blob(`substr(CAST(${content} AS TEXT),1,4096)`)} AS head,${blob(`substr(CAST(${content} AS TEXT),-4096)`)} AS tail,${blob(timestamp)} AS timestamp,${blob(status)} AS status,${blob(tool)} AS tool FROM messages WHERE CAST(${quote(session)} AS TEXT)=? AND rowid=?`,
        sessionId,
        rowid,
      );
      return row
        ? digest("hermes-anchor", [
            sessionId,
            String(rowid),
            text(row.role),
            String(row.length ?? 0),
            text(row.head),
            text(row.tail),
            text(row.timestamp),
            text(row.status),
            text(row.tool),
          ])
        : null;
    };
    const currentHigh = BigInt(
        sql.one(
          `SELECT COALESCE(MAX(rowid),0) AS value FROM messages WHERE CAST(${quote(session)} AS TEXT)=?`,
          sessionId,
        )!.value as bigint,
      ),
      currentAnchor = currentHigh > 0n ? anchor(currentHigh) : null;
    let high = currentHigh,
      before = high < MAX_I64 ? high + 1n : MAX_I64,
      highAnchor = currentAnchor ?? "";
    if (cursor !== null) {
      const parts = cursor.startsWith("hermes-db-v2-")
        ? cursor.slice("hermes-db-v2-".length).split("-")
        : [];
      if (parts.length !== 6 || parts[0] !== source || !/^[a-fA-F0-9]{64}$/.test(parts[0]!))
        throw new Error("TRANSCRIPT_CURSOR_INVALID");
      high = integer(parts[1]!, MAX_I64);
      before = integer(parts[2]!, MAX_I64);
      const dev = integer(parts[3]!, MAX_U64),
        ino = integer(parts[4]!, MAX_U64);
      highAnchor = parts[5]!;
      if (
        before > (high < MAX_I64 ? high + 1n : MAX_I64) ||
        !((high === 0n && highAnchor === "") || /^[a-fA-F0-9]{64}$/.test(highAnchor))
      )
        throw new Error("TRANSCRIPT_CURSOR_INVALID");
      if (
        dev !== identity[0] ||
        ino !== identity[1] ||
        currentHigh < high ||
        (high > 0n && anchor(high) !== highAnchor)
      )
        throw new Error("TRANSCRIPT_CURSOR_STALE");
    }
    const statement = db.prepare(
      `SELECT rowid AS rowid,${blob(role)} AS role,${blob(bounded(content, MAX_MESSAGE_BYTES + 1))} AS content,${blob(timestamp)} AS timestamp,${blob(status)} AS status,${blob(tool)} AS tool FROM messages WHERE CAST(${quote(session)} AS TEXT)=? AND rowid<=? AND rowid<? ORDER BY rowid DESC LIMIT 501`,
    );
    statement.setReadBigInts(true);
    const rows = statement.iterate(sessionId, high, before),
      events: ConversationEvent[] = [];
    let scanned = 0,
      last: bigint | null = null,
      pageBytes = 0,
      more = false;
    try {
      for (let next = rows.next(); !next.done; next = rows.next()) {
        if (scanned >= 500) {
          more = true;
          break;
        }
        scanned++;
        const row = next.value,
          rowid = BigInt(row.rowid as bigint),
          previous = last;
        last = rowid;
        const role = text(row.role),
          body = text(row.content),
          timestamp = textTimestamp(text(row.timestamp)),
          status = text(row.status),
          tool = text(row.tool),
          kind =
            role === "user"
              ? "user-message"
              : ["assistant", "agent"].includes(role)
                ? "agent-message"
                : ["tool", "toolResult", "tool_result"].includes(role)
                  ? "tool-summary"
                  : null;
        if (kind === null || (!hasText(body) && kind !== "tool-summary")) continue;
        const remaining = Math.max(0, MAX_PAGE_BYTES - pageBytes);
        if (!remaining) {
          last = previous;
          more = true;
          break;
        }
        const clipped = truncateUtf8(body, Math.min(remaining, MAX_MESSAGE_BYTES));
        if (!clipped.content && clipped.truncated) {
          last = previous;
          more = true;
          break;
        }
        const content = clipped.content || null;
        if (content === null && kind !== "tool-summary") continue;
        pageBytes += content ? Buffer.byteLength(content) : 0;
        events.push({
          id: `hermes-db-${rowid}`,
          kind,
          timestamp,
          content,
          tool_name:
            kind === "tool-summary"
              ? hasText(tool)
                ? (sessionTitle(tool) ?? "tool")
                : "tool"
              : null,
          tool_status: kind === "tool-summary" && hasText(status) ? toolStatus(status) : null,
          duration_ms: null,
          attachment_count: 0,
          truncated: clipped.truncated,
        });
        if (events.length >= Math.min(100, Math.max(1, limit)) || pageBytes >= MAX_PAGE_BYTES) {
          more = !rows.next().done;
          break;
        }
      }
    } finally {
      rows.return?.();
    }
    const finalIdentity = nativeFileIdentity(file);
    if (finalIdentity[0] !== identity[0] || finalIdentity[1] !== identity[1])
      throw new Error("TRANSCRIPT_CURSOR_STALE");
    return {
      events: events.reverse(),
      next_cursor: more
        ? `hermes-db-v2-${source}-${high}-${last ?? before}-${identity[0]}-${identity[1]}-${highAnchor}`
        : null,
      warnings: [],
    };
  } finally {
    db.close();
  }
}
