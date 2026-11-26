import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { isReparseOrSymlink, nativeFileIdentity } from "./native-files";
import {
  OpenClawSourceOwnershipError,
  readOpenClawSearchSnapshot,
  type OpenClawSqliteSession,
} from "./openclaw-sqlite-sessions";
import { emitMessage, object, readSourceSnapshot } from "./history-search-source-records";
import { textTimestamp } from "./hermes-sessions";
import { belongsToWorkspace } from "./session-history";
import type { HistorySourceSink } from "./history-search-source-types";

const MAX_RECORD = 4 * 1024 * 1024;
const MAX_TOTAL = 256 * 1024 * 1024;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export async function readHermesSearchSource(
  source: { path: string; sessionId: string },
  sink: HistorySourceSink,
  workspace: string,
  home: string | null,
): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const file = source.path + suffix;
    if (suffix && !existsSync(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || isReparseOrSymlink(file, stat)) throw new Error("history-source-unsafe");
  }
  const identity = nativeFileIdentity(source.path);
  const db = new DatabaseSync(source.path, { readOnly: true, timeout: 100 });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED");
    const metadataNames = new Set(
      db
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .map((row) => String(row.name)),
    );
    if (!metadataNames.has("id")) throw new Error(REMOTE_ERROR_CODES.historySourceOwnerChanged);
    // Match Hermes discovery's alias precedence and bounds, but read metadata in
    // the very same SQLite snapshot as messages (including WAL-only commits).
    const metadataField = (aliases: string[]) => {
      const fields = aliases
        .filter((name) => metadataNames.has(name))
        .map((name) => `CAST(${quote(name)} AS TEXT)`);
      const value = fields.length > 1 ? `COALESCE(${fields.join(",")})` : (fields[0] ?? "NULL");
      return `CAST(substr(${value},1,1024) AS BLOB)`;
    };
    const owners = db
      .prepare(
        `SELECT ${metadataField(["id"])} AS id,${metadataField(["cwd", "directory", "project_dir"])} AS cwd,${metadataField(["title", "name", "summary"])} AS title FROM sessions WHERE CAST(id AS TEXT)=? LIMIT 2`,
      )
      .all(source.sessionId);
    if (owners.length !== 1) throw new Error(REMOTE_ERROR_CODES.historySourceOwnerChanged);
    const decodeMetadata = (value: unknown): string | null => {
      if (value === null) return null;
      if (!(value instanceof Uint8Array))
        throw new Error(REMOTE_ERROR_CODES.historySourceOwnerChanged);
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(value);
      } catch (error) {
        throw new Error(REMOTE_ERROR_CODES.historySourceOwnerChanged, { cause: error });
      }
    };
    const owner = {
      id: decodeMetadata(owners[0]!.id),
      cwd: decodeMetadata(owners[0]!.cwd),
      title: decodeMetadata(owners[0]!.title),
    };
    if (
      owner.id !== source.sessionId ||
      (owner.cwd?.trim() && !belongsToWorkspace(owner.cwd, workspace, home))
    )
      throw new Error(REMOTE_ERROR_CODES.historySourceOwnerChanged);
    if (!owner.cwd?.trim()) sink.limit("hermes-workspace-from-linked-history");
    sink.fingerprint(JSON.stringify(owner));
    const names = new Set(
      db
        .prepare("PRAGMA table_info(messages)")
        .all()
        .map((row) => String(row.name)),
    );
    const select = (aliases: string[]) => aliases.find((name) => names.has(name));
    const session = select([
      "session_id",
      "sessionId",
      "session",
      "conversation_id",
      "conversationId",
    ]);
    const role = select(["role", "speaker"]),
      content = select(["content", "text", "message"]);
    if (!session || !role || !content) throw new Error("history-source-schema-unsupported");
    const optional = [
      "tool_calls",
      "tool_call_id",
      "toolCallId",
      "tool_name",
      "toolName",
      "name",
      "timestamp",
      "created_at",
      "ts",
      "active",
      "compacted",
      "_compressed_summary",
    ];
    const fields = [...new Set([role, content, ...optional.filter((name) => names.has(name))])];
    const sizeExpression = fields
      .map((name) => `COALESCE(length(CAST(${quote(name)} AS BLOB)),0)`)
      .join("+");
    const projection = fields
      .map(
        (name) =>
          // Node's SQLite TEXT reader stops at NUL; preserve bytes without turning
          // numeric active/compacted flags into strings.
          `CASE WHEN (${sizeExpression})<=${MAX_RECORD} THEN CASE WHEN typeof(${quote(name)})='text' THEN CAST(${quote(name)} AS BLOB) ELSE ${quote(name)} END ELSE NULL END AS ${quote(name)}`,
      )
      .join(",");
    const statement = db.prepare(
      `SELECT rowid AS _rowid,(${sizeExpression}) AS _bytes,${projection} FROM messages WHERE CAST(${quote(session)} AS TEXT)=? ORDER BY rowid LIMIT 100001`,
    );
    statement.setReadBigInts(true);
    let count = 0,
      total = 0;
    sink.fingerprint(`${source.sessionId}:${identity.join(":")}`);
    for (const row of statement.iterate(source.sessionId)) {
      sink.checkpoint();
      if (++count > 100_000) {
        sink.limit("source-record-count-limit");
        break;
      }
      const size = Number(row._bytes);
      sink.fingerprint(`${row._rowid}:${size}`);
      if (size > MAX_RECORD) {
        sink.limit("source-record-limit");
        continue;
      }
      if ((total += size) > MAX_TOTAL) {
        sink.limit("source-byte-limit");
        break;
      }
      const value: Record<string, unknown> = {};
      for (const name of fields) {
        const cell = row[name];
        if (cell instanceof Uint8Array) {
          try {
            value[name] = new TextDecoder("utf-8", { fatal: true }).decode(cell);
          } catch {
            value[name] = cell;
          }
        } else value[name] = typeof cell === "bigint" ? Number(cell) : cell;
      }
      if (Object.values(value).some((cell) => cell instanceof Uint8Array)) {
        sink.limit("unsupported-message-blob");
        continue;
      }
      sink.fingerprint(JSON.stringify(value));
      value.role = value[role];
      value.content = value[content];
      value.timestamp = textTimestamp(
        String(value.timestamp ?? value.created_at ?? value.ts ?? ""),
      );
      if (typeof value.tool_calls === "string") {
        try {
          value.tool_calls = JSON.parse(value.tool_calls);
        } catch {
          value.tool_calls = undefined;
          sink.limit("damaged-tool-input");
        }
      }
      if (typeof value.content === "string" && value.content.trimStart().startsWith("[")) {
        try {
          const parsed: unknown = JSON.parse(value.content);
          if (
            Array.isArray(parsed) &&
            parsed.every((item) => typeof object(item).type === "string")
          )
            value.content = parsed;
        } catch {
          /* A literal message beginning with [ remains ordinary text. */
        }
      }
      await emitMessage(value, `hermes-row:${row._rowid}`, sink);
    }
    if (nativeFileIdentity(source.path).some((part, index) => part !== identity[index]))
      throw new Error(REMOTE_ERROR_CODES.historySourceChanged);
  } finally {
    db.close();
  }
}

export async function readOpenClawSearchSource(
  source: OpenClawSqliteSession,
  sink: HistorySourceSink,
): Promise<void> {
  const state = await readSourceSnapshot(sink, () => {
    try {
      return readOpenClawSearchSnapshot(source);
    } catch (error) {
      if (error instanceof OpenClawSourceOwnershipError)
        throw new Error(REMOTE_ERROR_CODES.historySourceOwnerChanged, { cause: error });
      throw error;
    }
  });
  if (!state) return;
  sink.fingerprint(state.fingerprint);
  for (const { event, seq } of state.events) {
    sink.checkpoint();
    if (event.type !== "message") continue;
    await emitMessage(event, `openclaw:${seq}`, sink);
  }
}
