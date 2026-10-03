import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isReparseOrSymlink } from "./native-files";
import { compactJson, finishDocument, type DocumentSource } from "./session-document-providers";
import { jsonTimestamp } from "./session-history";
import type { SessionDocument } from "./session-model";
import { Sql } from "./sql";

const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024,
  MAX_LINE_BYTES = 4 * 1024 * 1024;
type Loss = SessionDocument["losses"][number]["code"];
type Block = SessionDocument["turns"][number]["blocks"][number];
type RecordLine = { line: number; value: Record<string, any> };

function increment(losses: Map<Loss, number>, code: Loss): void {
  losses.set(code, (losses.get(code) ?? 0) + 1);
}

function readRecords(file: string): RecordLine[] {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
    throw new Error("Unsafe history source");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_TRANSCRIPT_BYTES)
      throw new Error("Transcript exceeds the 256 MiB read limit");
    const bytes = readFileSync(fd);
    if (bytes.length > MAX_TRANSCRIPT_BYTES)
      throw new Error("Transcript exceeds the 256 MiB read limit");
    const decoder = new TextDecoder("utf-8", { fatal: true }),
      output: RecordLine[] = [];
    let start = 0,
      line = 0;
    const parse = (end: number, newline: boolean) => {
      line++;
      const record = bytes.subarray(start, end);
      if (record.every((byte) => [9, 10, 13, 32].includes(byte))) return;
      if (record.length + Number(newline) > MAX_LINE_BYTES)
        throw new Error("Original transcript record exceeds the 4 MiB read limit");
      const value: unknown = JSON.parse(decoder.decode(record));
      if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Malformed original transcript record ${line}`);
      output.push({ line, value: value as Record<string, any> });
    };
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== 10) continue;
      parse(index, true);
      start = index + 1;
    }
    if (start < bytes.length) parse(bytes.length, false);
    return output;
  } finally {
    closeSync(fd);
  }
}

function sqliteRecords(file: string, sessionId: string): RecordLine[] {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
    throw new Error("Unsafe history source");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const sql = new Sql(db),
      columns = new Set(sql.rows("PRAGMA table_info(messages)").map((row) => String(row.name))),
      required = ["session_id", "role", "content"];
    if (!required.every((name) => columns.has(name)))
      throw new Error("Hermes messages schema is unsupported for original-history import");
    const sessionColumns = new Set(
      sql.rows("PRAGMA table_info(sessions)").map((row) => String(row.name)),
    );
    if (sessionColumns.has("parent_session_id")) {
      const parent = sql.one("SELECT parent_session_id FROM sessions WHERE id=?", sessionId);
      if (parent?.parent_session_id !== null && parent?.parent_session_id !== undefined)
        throw new Error("Hermes lineage sessions require a verified ancestor reader before import");
    }
    for (const flag of ["compacted", "_compressed_summary"])
      if (columns.has(flag)) {
        const found = sql.one(
          `SELECT EXISTS(SELECT 1 FROM messages WHERE session_id=? AND "${flag}"=1) AS found`,
          sessionId,
        );
        if (Number(found?.found) === 1)
          throw new Error(
            "Hermes compacted history requires a verified generation reader before import",
          );
      }
    const fields = [
      "role",
      "content",
      "tool_calls",
      "tool_call_id",
      "timestamp",
      "reasoning",
      "reasoning_content",
      "reasoning_details",
      "display_kind",
    ].filter((name) => columns.has(name));
    const active = columns.has("active") ? ' AND "active"=1' : "",
      order = columns.has("id") ? '"id"' : "rowid",
      bytes = sql.one(
        `SELECT COALESCE(SUM(${fields.map((name) => `COALESCE(length(CAST("${name}" AS BLOB)),0)`).join("+")}),0) AS value FROM messages WHERE session_id=?${active}`,
        sessionId,
      )?.value;
    if (Number(bytes) < 0 || Number(bytes) > MAX_TRANSCRIPT_BYTES)
      throw new Error("Hermes transcript exceeds the 256 MiB read limit");
    const select = fields.map((name) => `"${name}"`).join(","),
      statement = db.prepare(
        `SELECT ${select} FROM messages WHERE session_id=?${active} ORDER BY ${order}`,
      );
    const rows = statement.all(sessionId) as Record<string, unknown>[];
    return rows.map((row, index) => {
      const value: Record<string, any> = {};
      for (const name of fields) {
        const item = row[name];
        if (item instanceof Uint8Array) throw new Error("Unsupported Hermes message blob");
        if (item === null || item === undefined) {
          value[name] = null;
        } else if (typeof item === "string") {
          if (name === "tool_calls") value[name] = JSON.parse(item);
          else if (name === "content" && item.trimStart().startsWith("[")) {
            try {
              const parsed: unknown = JSON.parse(item);
              value[name] =
                Array.isArray(parsed) &&
                parsed.length > 0 &&
                parsed.every(
                  (part) => part && typeof part === "object" && typeof part.type === "string",
                )
                  ? parsed
                  : item;
            } catch {
              value[name] = item;
            }
          } else value[name] = item;
        } else if (typeof item === "number" || typeof item === "bigint") value[name] = Number(item);
        else value[name] = item;
      }
      return { line: index + 1, value };
    });
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {}
    db.close();
  }
}

function strictBase64(value: string): boolean {
  return (
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value) &&
    Buffer.from(value, "base64").toString("base64") === value
  );
}

function originalDocument(
  source: DocumentSource,
  records: RecordLine[],
  format: "hermes" | "grok-build",
): SessionDocument {
  const turns: SessionDocument["turns"] = [],
    losses = new Map<Loss, number>(),
    calls = new Set<string>();
  const addToolCall = (call: Record<string, any>, blocks: Block[]) => {
    if (typeof call.id !== "string" || !call.id || calls.has(call.id))
      throw new Error("Tool call has invalid or duplicate identity");
    const fn = Object.hasOwn(call, "function") ? call.function : call,
      name = fn.name,
      input = Object.hasOwn(fn, "arguments") ? fn.arguments : fn.input;
    if (typeof name !== "string") throw new Error("Tool call has no name");
    if (input === undefined) throw new Error("Tool call has no arguments");
    calls.add(call.id);
    blocks.push({ type: "tool-call", call_id: call.id, name, input: compactJson(input) });
  };
  const contentBlocks = (content: unknown, blocks: Block[]) => {
    if (content === null || content === undefined) return;
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
    if (!Array.isArray(parts)) throw new Error("Unsupported original message content");
    for (const part of parts as Array<Record<string, any>>) {
      if (!part || typeof part !== "object" || typeof part.type !== "string")
        throw new Error("Original message contains an untyped content block");
      if (part.type === "text") {
        if (typeof part.text !== "string") throw new Error("Text block has no text");
        blocks.push({ type: "text", text: part.text });
      } else if (["thinking", "reasoning", "redacted_thinking"].includes(part.type))
        increment(losses, "reasoning-excluded");
      else if (part.type === "toolCall" || part.type === "tool_use") addToolCall(part, blocks);
      else if (["image", "image_url", "document"].includes(part.type)) {
        const rawNested = Object.hasOwn(part, "source") ? part.source : part,
          nested = rawNested !== null && typeof rawNested === "object" ? rawNested : {},
          url = Object.hasOwn(part, "url") ? part.url : part.image_url?.url,
          embedded = typeof url === "string" ? /^data:([^;,]+);base64,(.*)$/.exec(url) : null,
          mime = embedded?.[1] ?? nested.media_type ?? nested.mimeType,
          data = embedded?.[2] ?? nested.data;
        if (typeof mime !== "string" || typeof data !== "string") {
          increment(losses, "external-attachment");
          continue;
        }
        if (!strictBase64(data)) throw new Error("Invalid base64 attachment in original history");
        blocks.push({
          type: "attachment",
          kind: mime.startsWith("image/") ? "image" : "document",
          media_type: mime,
          filename: typeof part.filename === "string" ? part.filename : undefined,
          inline_base64: data,
        });
      } else if (["input_audio", "audio", "video"].includes(part.type))
        increment(losses, "unsupported-attachment");
      else throw new Error(`Unsupported original content block: ${part.type}`);
    }
  };
  for (const { line, value: record } of records) {
    let role: unknown,
      message: Record<string, any> = record,
      timestamp: unknown = record.timestamp;
    if (format === "grok-build") {
      const kind = record.type;
      if (["user", "assistant", "tool_result"].includes(kind)) role = kind;
      else if (kind === "reasoning") {
        increment(losses, "reasoning-excluded");
        continue;
      } else if (kind === "system") continue;
      else if (kind === "backend_tool_call") {
        increment(losses, "damaged-record");
        continue;
      } else throw new Error("Unsupported Grok Build original-history record type");
    } else {
      const kind = record.type;
      if (["session", "init", "system", "internal"].includes(kind)) continue;
      if (["reasoning", "thinking", "redacted_thinking"].includes(kind)) {
        increment(losses, "reasoning-excluded");
        continue;
      }
      if (kind !== undefined && kind !== "message")
        throw new Error("Hermes transcript contains an unsupported record type");
      if (kind === "message" && Object.hasOwn(record, "message")) {
        const nested = record.message;
        message =
          nested !== null && typeof nested === "object" && !Array.isArray(nested) ? nested : {};
      }
      for (const field of ["compacted", "_compressed_summary"])
        for (const value of [record[field], message[field]])
          if (value === true || value === 1)
            throw new Error(
              "Hermes compacted history requires a verified generation reader before import",
            );
      if ([record, message].some((item) => item.active === false || item.active === 0)) continue;
      role = message.role;
    }
    if (role === "reasoning" || role === "thinking") {
      increment(losses, "reasoning-excluded");
      continue;
    }
    if (role === "system" || role === "session_meta") continue;
    const normalizedRole = role === "toolResult" ? "tool_result" : role;
    if (
      typeof normalizedRole !== "string" ||
      !["user", "assistant", "tool", "tool_result"].includes(normalizedRole)
    )
      throw new Error("Unsupported original message role");
    const tool = normalizedRole === "tool" || normalizedRole === "tool_result",
      assistant = normalizedRole === "assistant",
      reasoningFields = [
        "reasoning",
        "reasoning_content",
        "reasoning_details",
        "codex_reasoning_items",
      ],
      hasReasoning = reasoningFields.some(
        (field) => message[field] !== undefined && message[field] !== null,
      ),
      rawCalls = message.tool_calls,
      hasCalls = Array.isArray(rawCalls) && rawCalls.length > 0,
      rawImages = message.images,
      hasImages = Array.isArray(rawImages) && rawImages.length > 0;
    for (const field of reasoningFields)
      if (message[field] !== undefined && message[field] !== null)
        increment(losses, "reasoning-excluded");
    if (
      (message.content === undefined || message.content === null) &&
      !(assistant && (hasCalls || hasReasoning || hasImages))
    )
      throw new Error("Original message has missing or null content");
    const blocks: Block[] = [];
    if (tool) {
      const callId = Object.hasOwn(message, "tool_call_id")
        ? message.tool_call_id
        : message.toolCallId;
      if (typeof callId !== "string") throw new Error("Tool result has no call identity");
      if (!calls.has(callId)) increment(losses, "orphan-tool-result");
      if (!Object.hasOwn(message, "content")) throw new Error("Tool result has no content");
      const result: Block[] = [];
      contentBlocks(message.content, result);
      blocks.push({
        type: "tool-result",
        call_id: callId,
        output: result
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n"),
        is_error: message.isError === true || message.is_error === true,
      });
      blocks.push(...result.filter((block) => block.type === "attachment"));
    } else contentBlocks(message.content, blocks);
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (!assistant || !Array.isArray(message.tool_calls))
        throw new Error("Tool calls must be an assistant array");
      for (const call of message.tool_calls) addToolCall(call, blocks);
    }
    if (message.images !== undefined && message.images !== null) {
      if (!Array.isArray(message.images)) throw new Error("Message images must be an array");
      contentBlocks(message.images, blocks);
    }
    if (blocks.length)
      turns.push({
        id: `turn-${line}`,
        role: tool ? "tool" : (normalizedRole as "user" | "assistant"),
        timestamp: jsonTimestamp(
          Object.hasOwn(record, "timestamp") ? timestamp : message.timestamp,
        ),
        blocks,
      });
  }
  return finishDocument(source, turns, losses);
}

export function readHermesDocument(
  source: DocumentSource,
  history: { type: "jsonl"; path: string } | { type: "sqlite"; path: string; sessionId: string },
): SessionDocument {
  const records =
    history.type === "sqlite"
      ? sqliteRecords(history.path, history.sessionId)
      : readRecords(history.path);
  return originalDocument(source, records, "hermes");
}

export function readGrokDocument(source: DocumentSource, file: string): SessionDocument {
  return originalDocument(source, readRecords(file), "grok-build");
}
