import type { DatabaseSync } from "node:sqlite";
import type { ConversationEvent, ConversationEventPage } from "../../session-events";
import { MAX_MESSAGE_BYTES, MAX_PAGE_BYTES, truncateUtf8 } from "../../session-events";
import type { AntigravityLocalSurface } from "./antigravity-local-store";

const MAX_CELL_BYTES = 2 * 1024 * 1024;
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const PAGE_READ_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 10_000;
const decoder = new TextDecoder("utf-8", { fatal: true });
type PageRequest = {
  id: string;
  surface: AntigravityLocalSurface;
  prefix: string;
  cursor: string | null;
  limit: number;
};
type Step = { number: number; event: ConversationEvent };
const FIELDS = [
  "conversation_id",
  "chunk_first_step",
  "chunk_last_step",
  "user_body",
  "agent_body",
  "user_step_byte_offsets",
  "agent_step_byte_offsets",
] as const;
type Field = (typeof FIELDS)[number];

function indexedContent(db: DatabaseSync) {
  // FTS5's xColumn can fetch all payload columns from its content row even when
  // the caller only needs coordinates. Read the verified shadow schema directly.
  const shadow = db
    .prepare(
      "SELECT 1 FROM pragma_table_list WHERE schema='main' AND name='conversations_fts_content' AND type='shadow'",
    )
    .get();
  if (shadow) {
    const columns = new Map(
      db
        .prepare("PRAGMA table_info(conversations_fts)")
        .all()
        .filter((row) => Number.isSafeInteger(row.cid) && Number(row.cid) >= 0)
        .map((row) => [row.name, `c${row.cid}`]),
    );
    const shadowColumns = new Set(
      db
        .prepare("PRAGMA table_info(conversations_fts_content)")
        .all()
        .map((row) => row.name),
    );
    if (
      shadowColumns.has("id") &&
      FIELDS.every((field) => columns.has(field) && shadowColumns.has(columns.get(field)!))
    )
      return {
        table: "conversations_fts_content",
        rowId: "id",
        column: (field: Field) => columns.get(field)!,
      };
  }
  return { table: "conversations_fts", rowId: "rowid", column: (field: Field) => field };
}

export function indexedAntigravityEntry(db: DatabaseSync) {
  const { table, column } = indexedContent(db);
  return db.prepare(`SELECT 1 FROM ${table} WHERE ${column("conversation_id")}=? LIMIT 1`);
}

function payload(value: unknown): Buffer {
  const bytes =
    typeof value === "string"
      ? Buffer.from(value)
      : value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : null;
  if (!bytes || bytes.length > MAX_CELL_BYTES) throw new Error("Invalid Antigravity local record");
  return bytes;
}
function number(value: unknown) {
  const result = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new Error("Invalid Antigravity search order");
  return result;
}

function projectRole(
  body: Buffer,
  offsetBytes: Buffer,
  before: number,
  bounds: { first: number; last: number },
  role: "user" | "agent",
  { surface, id }: PageRequest,
  seen: Set<number>,
): Step[] {
  const offsets: unknown = JSON.parse(decoder.decode(offsetBytes));
  if (!Array.isArray(offsets) || offsets.length > MAX_CHUNKS)
    throw new Error("Invalid Antigravity search offsets");
  const events: Step[] = [];
  let previousStep = -1,
    previousOffset = -1;
  for (const [index, pair] of offsets.entries()) {
    const next = offsets[index + 1];
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((value) => !Number.isSafeInteger(value) || value < 0) ||
      pair[0] <= previousStep ||
      pair[1] <= previousOffset ||
      pair[1] >= body.length ||
      pair[0] < bounds.first ||
      pair[0] > bounds.last
    )
      throw new Error("Invalid Antigravity search offsets");
    const end =
      next === undefined
        ? body.length
        : Array.isArray(next) && Number.isSafeInteger(next[1])
          ? next[1]
          : -1;
    if (end <= pair[1] || end > body.length || seen.has(pair[0]))
      throw new Error("Invalid Antigravity search order");
    previousStep = pair[0];
    previousOffset = pair[1];
    seen.add(pair[0]);
    if (pair[0] >= before) continue;
    const content = decoder.decode(body.subarray(pair[1], end));
    if (!content.trim()) continue;
    events.push({
      number: pair[0],
      event: {
        id: `antigravity-local-${surface}-${id}-${pair[0]}`,
        kind: role === "user" ? "user-message" : "agent-message",
        timestamp: null,
        ...truncateUtf8(content, MAX_MESSAGE_BYTES),
        tool_name: null,
        tool_status: null,
        duration_ms: null,
        attachment_count: 0,
      },
    });
  }
  return events;
}

/** Scan chunk coordinates only; fetch text cells newest first within the requested step window. */
export function readIndexedAntigravityPage(
  db: DatabaseSync,
  request: PageRequest,
  observeBytes?: (bytes: number) => void,
): ConversationEventPage {
  const { id, prefix, cursor, limit } = request;
  let before = Infinity;
  if (cursor !== null) {
    const step = cursor.slice(prefix.length);
    if (!cursor.startsWith(prefix) || !/^\d+$/.test(step) || !Number.isSafeInteger(Number(step)))
      throw new Error("Invalid Antigravity local cursor");
    before = Number(step);
  }
  const { table, rowId, column } = indexedContent(db);
  const chunks = db
    .prepare(
      `SELECT ${rowId} AS rowid,${column("chunk_first_step")} AS chunk_first_step,
       ${column("chunk_last_step")} AS chunk_last_step FROM ${table} WHERE ${column("conversation_id")}=?
       ORDER BY CAST(chunk_last_step AS INTEGER) DESC LIMIT ${MAX_CHUNKS + 1}`,
    )
    .all(id);
  if (chunks.length > MAX_CHUNKS) throw new Error("Antigravity search index exceeds chunk limit");
  const cell = (field: Field) =>
    `CASE WHEN length(${column(field)})=0 THEN '' ELSE substr(CAST(${column(field)} AS BLOB),1,${MAX_CELL_BYTES + 1}) END`;
  const readChunk = db.prepare(
    `SELECT ${cell("user_body")} AS user_body,${cell("agent_body")} AS agent_body,
      ${cell("user_step_byte_offsets")} AS user_offsets,${cell("agent_step_byte_offsets")} AS agent_offsets
      FROM ${table} WHERE ${rowId}=?`,
  );
  let selected: Step[] = [];
  const seen = new Set<number>();
  let bytes = 0;
  let more = false;
  for (const chunk of chunks) {
    const first = number(chunk.chunk_first_step);
    const last = number(chunk.chunk_last_step);
    if (first > last) throw new Error("Invalid Antigravity search order");
    if (first >= before) continue;
    const oldest = selected.at(-1)?.number;
    // Ranges can overlap. Stop only after later chunks cannot have steps in this page.
    if (oldest !== undefined && last < oldest && (more || bytes >= PAGE_READ_BYTES)) {
      more = true;
      break;
    }
    const row = readChunk.get(number(chunk.rowid));
    if (!row) throw new Error("Antigravity search chunk changed during read");
    for (const role of ["user", "agent"] as const) {
      const body = payload(row[`${role}_body`]);
      if (!body.length) continue;
      const offsets = payload(row[`${role}_offsets`]);
      bytes += body.length + offsets.length;
      observeBytes?.(body.length + offsets.length);
      if (bytes > MAX_SCAN_BYTES) throw new Error("Antigravity search projection exceeds limit");
      selected.push(...projectRole(body, offsets, before, { first, last }, role, request, seen));
    }
    if (seen.size > MAX_CHUNKS)
      throw new Error("Antigravity search projection exceeds event limit");
    selected.sort((a, b) => b.number - a.number);
    let size = 0,
      count = 0;
    for (const { event } of selected) {
      size += Buffer.byteLength(event.content ?? "") + 256;
      if (count >= limit || size > MAX_PAGE_BYTES) break;
      count++;
    }
    more ||= count < selected.length;
    selected = selected.slice(0, count);
  }
  return {
    next_cursor: more ? `${prefix}${selected.at(-1)!.number}` : null,
    events: selected.reverse().map(({ event }) => event),
    warnings: ["history.warning.partial"],
  };
}
