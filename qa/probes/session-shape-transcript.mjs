import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSCRIPT_RECORD_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSCRIPT_RECORDS = 1024;
const MAX_CONTENT_BLOCKS = 64;
const MAX_TOTAL_CONTENT_BLOCKS = 2048;
const LF = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_ID = /^[a-z0-9_-]{1,128}$/i;
const TYPES = new Set([
  "user",
  "assistant",
  "system",
  "result",
  "summary",
  "progress",
  "attachment",
  "mode",
  "permission-mode",
  "queue-operation",
  "file-history-snapshot",
  "ai-title",
  "custom-title",
  "agent-name",
  "last-prompt",
  "api-request-blob",
]);
const SUBTYPES = new Set(["turn_duration", "compact_boundary", "local_command", "success"]);
const ENTRYPOINTS = new Set(["cli", "sdk-cli"]);
const ROLES = new Set(["user", "assistant"]);
const STOP_REASONS = new Set(["end_turn", "tool_use", "max_tokens", "stop_sequence", "refusal"]);
const BLOCK_TYPES = new Set([
  "text",
  "input_text",
  "output_text",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "image",
  "document",
]);
const FLAGS = ["isMeta", "isSidechain", "isCompactSummary", "isSynthetic"];
const RECORD_FIELDS = [
  "type",
  "subtype",
  "uuid",
  "parentUuid",
  "sessionId",
  "timestamp",
  "entrypoint",
  "message",
  "attachment",
  "error",
  "permissionMode",
  "toolUseResult",
  "customTitle",
  "aiTitle",
  "lastPrompt",
  "request",
  "response",
  "data",
  ...FLAGS,
];
const MESSAGE_FIELDS = ["role", "content", "model", "stop_reason", "usage"];
const BLOCK_FIELDS = ["type", "id", "tool_use_id", "text", "is_error", "input", "content"];
const ATTACHMENT_TYPES = new Set(["plugin_note", "queued_command"]);
const ATTACHMENT_FIELDS = ["type", "prompt", "isMeta", "source", "sourceUuid"];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shape(value, fields) {
  const known = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) continue;
    const entry = value[field];
    known[field] = entry === null ? "null" : Array.isArray(entry) ? "array" : typeof entry;
  }
  return { fields: known, otherFieldCount: Object.keys(value).length - Object.keys(known).length };
}

function category(value, allowed) {
  if (typeof value !== "string") return undefined;
  return allowed.has(value) ? value : "other";
}

function alias(value, pattern, ids) {
  if (typeof value !== "string" || !pattern.test(value)) return undefined;
  if (!ids.has(value)) ids.set(value, ids.size + 1);
  return ids.get(value);
}

function blockShape(block, tools) {
  if (!object(block)) return { type: "other" };
  const type = category(block.type, BLOCK_TYPES) ?? "other";
  return {
    type,
    ...shape(block, BLOCK_FIELDS),
    tool: type === "tool_use" ? alias(block.id, TOOL_ID, tools) : undefined,
    toolResultFor: type === "tool_result" ? alias(block.tool_use_id, TOOL_ID, tools) : undefined,
  };
}

function messageShape(message, ids) {
  if (!object(message)) return undefined;
  const content = Array.isArray(message.content) ? message.content : undefined;
  const count = Math.min(content?.length ?? 0, MAX_CONTENT_BLOCKS, ids.remainingBlocks);
  ids.remainingBlocks -= count;
  return {
    ...shape(message, MESSAGE_FIELDS),
    role: category(message.role, ROLES),
    stopReason: category(message.stop_reason, STOP_REASONS),
    syntheticModel: typeof message.model === "string" ? message.model === "<synthetic>" : undefined,
    ...(content && {
      blockCount: content.length,
      blocks: content.slice(0, count).map((block) => blockShape(block, ids.tools)),
    }),
  };
}

function recordShape(record, ids) {
  const flags = {};
  for (const flag of FLAGS) {
    if (typeof record[flag] === "boolean") flags[flag] = record[flag];
  }
  return {
    type: category(record.type, TYPES) ?? "other",
    ...shape(record, RECORD_FIELDS),
    subtype: category(record.subtype, SUBTYPES),
    entrypoint: category(record.entrypoint, ENTRYPOINTS),
    record: alias(record.uuid, UUID, ids.records),
    parent: alias(record.parentUuid, UUID, ids.records),
    session: alias(record.sessionId, UUID, ids.sessions),
    flags,
    message: messageShape(record.message, ids),
    ...(object(record.attachment) && {
      attachment: {
        ...shape(record.attachment, ATTACHMENT_FIELDS),
        type: category(record.attachment.type, ATTACHMENT_TYPES),
        source: alias(record.attachment.sourceUuid, UUID, ids.records),
      },
    }),
  };
}

function sameVersion(left, right) {
  return (
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function projectTail(tail, byteLength) {
  const startsInFile = tail.length < byteLength;
  const firstNewline = tail.indexOf(LF);
  const first = startsInFile ? (firstNewline < 0 ? tail.length : firstNewline + 1) : 0;
  const last = tail.lastIndexOf(LF);
  const lines = [];
  let end = last;
  while (end >= first && lines.length < MAX_TRANSCRIPT_RECORDS) {
    const previous = end === 0 ? -1 : tail.lastIndexOf(LF, end - 1);
    lines.push(tail.subarray(previous + 1, end));
    end = previous;
  }
  const coverage = {
    earlierBytesOmitted: startsInFile,
    earlierLinesOmitted: end >= first,
    trailingPartialLine: last !== tail.length - 1,
    oversizedLines: 0,
    malformedLines: 0,
  };
  const ids = {
    records: new Map(),
    sessions: new Map(),
    tools: new Map(),
    remainingBlocks: MAX_TOTAL_CONTENT_BLOCKS,
  };
  const records = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const line of lines) {
    if (line.length > MAX_TRANSCRIPT_RECORD_BYTES) {
      coverage.oversizedLines++;
      continue;
    }
    try {
      const input = decoder.decode(line).trim();
      if (!input) continue;
      const row = JSON.parse(input);
      if (object(row)) records.push(recordShape(row, ids));
      else coverage.malformedLines++;
    } catch {
      coverage.malformedLines++;
    }
  }
  return { status: "ok", byteLength, bytesRead: tail.length, coverage, records: records.reverse() };
}

/** Read one file version and return no input strings beyond the fixed categories. */
export function captureTranscriptShape(transcriptPath) {
  let descriptor;
  let opened = false;
  try {
    const entry = lstatSync(transcriptPath, { bigint: true });
    if (!entry.isFile()) return { status: "unavailable" };
    descriptor = openSync(
      transcriptPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    opened = true;
    const initial = fstatSync(descriptor, { bigint: true });
    if (!sameVersion(entry, initial) || initial.size > BigInt(Number.MAX_SAFE_INTEGER))
      return { status: "unavailable" };
    const byteLength = Number(initial.size);
    const tail = Buffer.alloc(Math.min(byteLength, MAX_TRANSCRIPT_BYTES));
    const start = byteLength - tail.length;
    let read = 0;
    while (read < tail.length) {
      const count = readSync(descriptor, tail, read, tail.length - read, start + read);
      if (!count) return { status: "unavailable" };
      read += count;
    }
    if (
      !sameVersion(initial, fstatSync(descriptor, { bigint: true })) ||
      !sameVersion(initial, lstatSync(transcriptPath, { bigint: true }))
    )
      return { status: "unavailable" };
    return projectTail(tail, byteLength);
  } catch (error) {
    return { status: !opened && error?.code === "ENOENT" ? "missing" : "unavailable" };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
