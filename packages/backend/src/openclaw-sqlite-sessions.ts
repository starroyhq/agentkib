import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";
import { belongsToWorkspace, jsonTimestamp, stableNativeRef } from "./session-history";
import { sessionTitle } from "./codex-sessions";
import { finishDocument, type DocumentSource } from "./session-document-providers";
import type { SessionDocument } from "./session-model";
import type { NativeSession } from "./session-store";
import type { ConversationEventPage } from "./session-events";
import { MAX_MESSAGE_BYTES, MAX_PAGE_BYTES, truncateUtf8 } from "./session-events";

const MAX_ROWS = 100_000;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export interface OpenClawSqliteSession {
  file: string;
  agentId: string;
  id: string;
  cwd: string;
  session: NativeSession;
}

function open(file: string, agentId: string): DatabaseSync {
  let entry = file;
  for (let depth = 0; depth < 5; depth++) {
    const stat = lstatSync(entry);
    if (isReparseOrSymlink(entry, stat)) throw new Error("Unsafe OpenClaw SQLite path");
    const parent = path.dirname(entry);
    if (parent === entry) break;
    entry = parent;
  }
  const stat = lstatSync(file);
  if (!stat.isFile() || isReparseOrSymlink(file, stat))
    throw new Error("OpenClaw SQLite is not a regular file");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = file + suffix;
    if (existsSync(sidecar)) {
      const metadata = lstatSync(sidecar);
      if (!metadata.isFile() || isReparseOrSymlink(sidecar, metadata))
        throw new Error("Unsafe OpenClaw SQLite sidecar");
    }
  }
  const db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
  try {
    db.exec(
      "PRAGMA busy_timeout=100; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED",
    );
    if (db.prepare("PRAGMA user_version").get()?.user_version !== 23)
      throw new Error("Unsupported OpenClaw SQLite schema (expected 23)");
    const meta = db
      .prepare(
        "SELECT role,schema_version,agent_id,app_version FROM schema_meta WHERE meta_key='primary'",
      )
      .get() as Record<string, unknown> | undefined;
    if (
      !meta ||
      meta.role !== "agent" ||
      meta.schema_version !== 23 ||
      meta.agent_id !== agentId ||
      meta.app_version !== "2026.9.6"
    )
      throw new Error("Unsupported OpenClaw database version or agent ownership");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function header(db: DatabaseSync, id: string): Record<string, any> {
  const row = db
    .prepare(
      "SELECT event_json,event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq LIMIT 1",
    )
    .get(id) as Record<string, unknown> | undefined;
  if (
    !row ||
    typeof row.event_json !== "string" ||
    Buffer.byteLength(row.event_json) > MAX_EVENT_BYTES
  )
    throw new Error("OpenClaw transcript header is unavailable or compressed");
  const value = JSON.parse(row.event_json) as Record<string, any>;
  if (
    value.type !== "session" ||
    value.version !== 4 ||
    value.id !== id ||
    value.parentSession != null
  )
    throw new Error("Unknown or mismatched OpenClaw transcript header");
  if (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd))
    throw new Error("OpenClaw workspace must be absolute");
  return value;
}

export function listOpenClawSqlite(
  file: string,
  home: string,
  agentId: string,
  workspace: string | null,
): { sessions: OpenClawSqliteSession[]; incomplete: boolean } {
  const db = open(file, agentId);
  try {
    const rows = db
      .prepare(
        "SELECT w.session_id,w.created_at,COALESCE(w.transcript_updated_at,w.updated_at) AS updated_at,substr(w.display_name,1,1024) AS display_name,n.entry_valid,(n.archived_at IS NOT NULL OR n.current_session_id!=w.session_id) AS archived FROM session_windows w JOIN session_nodes n ON n.session_key=w.session_key ORDER BY w.updated_at DESC,w.session_id DESC LIMIT 2001",
      )
      .all() as Array<Record<string, any>>;
    const sessions: OpenClawSqliteSession[] = [];
    let incomplete = false;
    for (const row of rows.slice(0, 2000)) {
      if (
        typeof row.session_id !== "string" ||
        row.session_id.length > 4096 ||
        row.entry_valid !== 1
      ) {
        incomplete = true;
        continue;
      }
      try {
        const value = header(db, row.session_id);
        const cwd = value.cwd as string;
        if (workspace && !belongsToWorkspace(cwd, workspace)) continue;
        const created = jsonTimestamp(value.timestamp) ?? jsonTimestamp(row.created_at);
        const updated = jsonTimestamp(row.updated_at) ?? created;
        sessions.push({
          file,
          agentId,
          id: row.session_id,
          cwd,
          session: {
            native_ref: stableNativeRef("openclaw-sqlite-v23", [
              home,
              agentId,
              row.session_id,
              cwd,
            ]),
            agent: "open-claw",
            title: sessionTitle(row.display_name) ?? sessionTitle(path.basename(cwd)),
            created_at: created,
            updated_at: updated,
            message_count: null,
            git_branch: null,
            archived: Boolean(row.archived),
            sidechain: false,
            availability: "readable",
            origin: "unknown",
          },
        });
      } catch {
        incomplete = true;
      }
    }
    return { sessions, incomplete: incomplete || rows.length > 2000 };
  } finally {
    db.close();
  }
}

function snapshot(source: OpenClawSqliteSession): {
  events: Array<{ seq: number; event: Record<string, any>; eligible: boolean }>;
  fingerprint: string;
} {
  const db = open(source.file, source.agentId);
  try {
    const first = header(db, source.id);
    if (first.cwd !== source.cwd)
      throw new Error("OpenClaw workspace changed while reading history");
    const owner = db
      .prepare(
        "SELECT n.entry_json,w.acp_owned,w.plugin_owner_id,w.agent_harness_id,w.session_scope FROM session_windows w JOIN session_nodes n ON n.session_key=w.session_key WHERE w.session_id=? AND n.entry_valid=1 AND length(CAST(n.entry_json AS BLOB))<=4194304",
      )
      .get(source.id) as Record<string, any> | undefined;
    if (
      !owner ||
      owner.acp_owned !== 0 ||
      owner.plugin_owner_id != null ||
      (owner.agent_harness_id != null && owner.agent_harness_id !== "pi") ||
      owner.session_scope !== "conversation"
    )
      throw new Error("OpenClaw externally owned/shared transcript is not a complete local source");
    const entry = JSON.parse(String(owner.entry_json)) as Record<string, unknown>;
    if (
      ["acp", "cliSessionIds", "claudeCliSessionId", "codexCliSessionId"].some(
        (key) => entry[key] != null,
      )
    )
      throw new Error("OpenClaw external CLI history is not a complete local source");
    if (
      (
        db
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM session_transcript_cold_archives WHERE session_id=?) AS value",
          )
          .get(source.id) as { value: number }
      ).value
    )
      throw new Error("OpenClaw transcript is in cold storage; restore it in OpenClaw first");
    const state = db
      .prepare(
        "SELECT s.indexed_seq,s.needs_rebuild,s.active_event_count,s.active_message_count,r.generation FROM session_transcript_index_state s JOIN transcript_rewrite_watermarks r ON r.session_id=s.session_id WHERE s.session_id=?",
      )
      .get(source.id) as Record<string, any> | undefined;
    const latest = (
      db
        .prepare("SELECT max(seq) AS value FROM transcript_events WHERE session_id=?")
        .get(source.id) as { value: number | null }
    ).value;
    if (
      !state ||
      state.needs_rebuild !== 0 ||
      state.indexed_seq !== latest ||
      !Number.isInteger(state.active_event_count) ||
      state.active_event_count < 0 ||
      state.active_event_count > MAX_ROWS
    )
      throw new Error("OpenClaw active projection is stale or exceeds read limit");
    const rows = db
      .prepare(
        "SELECT a.active_position,a.message_position,a.context_eligible,e.seq,e.event_json,e.event_utf8_bytes FROM session_transcript_active_events a JOIN transcript_events e ON e.session_id=a.session_id AND e.seq=a.event_seq WHERE a.session_id=? ORDER BY a.active_position LIMIT 100001",
      )
      .all(source.id) as Array<Record<string, any>>;
    const events: Array<{ seq: number; event: Record<string, any>; eligible: boolean }> = [];
    const ids = new Set<string>();
    let bytes = 0,
      messages = 0;
    const hash = createHash("sha256")
      .update(source.id)
      .update(String(state.generation))
      .update(JSON.stringify(first));
    for (const row of rows) {
      if (events.length >= MAX_ROWS || row.active_position !== events.length)
        throw new Error("OpenClaw active projection has gaps or exceeds limit");
      if (typeof row.event_json !== "string")
        throw new Error("OpenClaw compressed event requires an unavailable decoder");
      const size = Buffer.byteLength(row.event_json);
      if (!size || size > MAX_EVENT_BYTES || (bytes += size) > MAX_TOTAL_BYTES)
        throw new Error("OpenClaw history exceeds bounded source read limit");
      const event = JSON.parse(row.event_json) as Record<string, any>;
      const expected = event.message?.excludeFromContext === true ? 0 : 1;
      if (row.context_eligible !== expected)
        throw new Error("OpenClaw projection context eligibility differs from original event");
      if (
        ![
          "message",
          "model_change",
          "thinking_level_change",
          "compaction",
          "reset",
          "custom",
          "session_info",
          "label",
        ].includes(event.type)
      )
        throw new Error(`Unsupported OpenClaw event: ${String(event.type)}`);
      if (typeof event.id !== "string" || ids.has(event.id))
        throw new Error("Duplicate or missing OpenClaw active event identity");
      ids.add(event.id);
      if (event.type === "message") {
        if (row.message_position !== messages++)
          throw new Error("OpenClaw message projection has gaps");
      } else if (row.message_position != null)
        throw new Error("OpenClaw non-message has a message position");
      hash.update(String(row.seq)).update(row.event_json);
      events.push({ seq: row.seq, event, eligible: expected === 1 });
    }
    if (rows.length !== state.active_event_count || messages !== state.active_message_count)
      throw new Error("OpenClaw active projection is incomplete");
    for (let index = 0; index < events.length; index++) {
      const { event } = events[index]!;
      if (event.type === "compaction") {
        if (
          typeof event.firstKeptEntryId !== "string" ||
          !events.slice(0, index).some(({ event: prior }) => prior.id === event.firstKeptEntryId) ||
          typeof event.parentId !== "string"
        )
          throw new Error("OpenClaw compaction originals are not completely available");
      }
      if (typeof event.parentId === "string" && !ids.has(event.parentId)) {
        const raw = db
          .prepare(
            "SELECT event_json FROM transcript_events WHERE session_id=? AND json_extract(event_json,'$.id')=? AND json_extract(event_json,'$.type')='leaf' LIMIT 1",
          )
          .get(source.id, event.parentId) as { event_json?: unknown } | undefined;
        if (typeof raw?.event_json !== "string")
          throw new Error("OpenClaw active history has a missing ancestor");
        const control = JSON.parse(raw.event_json) as Record<string, any>;
        if (
          control.targetId != null &&
          (typeof control.targetId !== "string" || !ids.has(control.targetId))
        )
          throw new Error("OpenClaw leaf target is outside available history");
      }
    }
    return { events, fingerprint: hash.digest("hex") };
  } finally {
    db.close();
  }
}

function activeMessages(events: ReturnType<typeof snapshot>["events"]): typeof events {
  let reset = -1;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index]!.event.type === "reset") {
      reset = index;
      break;
    }
  }
  if (reset < 0) return events;
  const resetEvent = events[reset]!.event;
  const firstKept = resetEvent.firstKeptEntryId;
  if (typeof firstKept !== "string") return events.slice(reset + 1);
  const start = events.slice(0, reset).findIndex(({ event }) => event.id === firstKept);
  if (start < 0) throw new Error("OpenClaw reset retained history is missing");
  const prefix = events.slice(start, reset).filter(({ event }) => event.type === "message");
  if (
    prefix.some(
      ({ event }) =>
        !["user", "assistant"].includes(String(event.message?.role)) ||
        event.message?.content?.some?.((part: any) => part.type === "toolCall"),
    )
  )
    throw new Error("OpenClaw reset retained tool history needs pairing verification");
  return [...prefix, ...events.slice(reset + 1)];
}

function contentBlocks(
  value: unknown,
  calls: Set<string>,
  losses: Map<SessionDocument["losses"][number]["code"], number>,
): SessionDocument["turns"][number]["blocks"] {
  const output: SessionDocument["turns"][number]["blocks"] = [];
  const addLoss = (code: SessionDocument["losses"][number]["code"]) =>
    losses.set(code, (losses.get(code) ?? 0) + 1);
  const parts = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [{ type: "text", text: value }]
      : value == null
        ? []
        : null;
  if (!parts) throw new Error("Unsupported original OpenClaw message content");
  for (const part of parts as Array<Record<string, any>>) {
    if (!part || typeof part !== "object" || typeof part.type !== "string")
      throw new Error("OpenClaw message contains an untyped content block");
    if (part.type === "text" && typeof part.text === "string")
      output.push({ type: "text", text: part.text });
    else if (["thinking", "reasoning", "redacted_thinking"].includes(part.type))
      addLoss("reasoning-excluded");
    else if (part.type === "toolCall" || part.type === "tool_use") {
      if (typeof part.id !== "string" || !part.id || calls.has(part.id))
        throw new Error("Invalid OpenClaw tool call identity");
      const fn = part.function ?? part;
      if (typeof fn.name !== "string") throw new Error("OpenClaw tool call has no name");
      const input = fn.arguments ?? fn.input;
      if (input === undefined) throw new Error("OpenClaw tool call has no arguments");
      calls.add(part.id);
      output.push({
        type: "tool-call",
        call_id: part.id,
        name: fn.name,
        input: typeof input === "string" ? input : JSON.stringify(input),
      });
    } else if (["image", "image_url", "document"].includes(part.type)) {
      const source = part.source ?? part;
      const url = part.url ?? part.image_url?.url;
      const embedded =
        typeof url === "string" ? /^data:([^;,]+);base64,([a-zA-Z0-9+/]+={0,2})$/.exec(url) : null;
      const mime = embedded?.[1] ?? source.media_type ?? source.mimeType;
      const data = embedded?.[2] ?? source.data;
      if (typeof mime !== "string" || typeof data !== "string") {
        addLoss("external-attachment");
        continue;
      }
      const decoded = Buffer.from(data, "base64");
      if (decoded.toString("base64") !== data)
        throw new Error("Invalid OpenClaw base64 attachment");
      output.push({
        type: "attachment",
        kind: mime.startsWith("image/") ? "image" : "document",
        media_type: mime,
        filename: typeof part.filename === "string" ? part.filename : undefined,
        inline_base64: data,
      });
    } else if (["input_audio", "audio", "video"].includes(part.type))
      addLoss("unsupported-attachment");
    else throw new Error(`Unsupported original OpenClaw content block: ${part.type}`);
  }
  return output;
}

function appendToolCall(
  call: Record<string, any>,
  calls: Set<string>,
  blocks: SessionDocument["turns"][number]["blocks"],
): void {
  if (typeof call.id !== "string" || !call.id || calls.has(call.id))
    throw new Error("Invalid OpenClaw tool call identity");
  const fn = call.function ?? call;
  if (typeof fn.name !== "string") throw new Error("OpenClaw tool call has no name");
  const input = fn.arguments ?? fn.input;
  if (input === undefined) throw new Error("OpenClaw tool call has no arguments");
  calls.add(call.id);
  blocks.push({
    type: "tool-call",
    call_id: call.id,
    name: fn.name,
    input: typeof input === "string" ? input : JSON.stringify(input),
  });
}

export function readOpenClawSqliteDocument(
  source: OpenClawSqliteSession,
  workspaceId: string,
): SessionDocument {
  const state = snapshot(source),
    selected = activeMessages(state.events),
    turns: SessionDocument["turns"] = [],
    losses = new Map<SessionDocument["losses"][number]["code"], number>(),
    calls = new Set<string>();
  for (const item of selected) {
    const { event, seq, eligible } = item;
    if (event.type !== "message") continue;
    if (!eligible)
      throw new Error(
        "OpenClaw display-only message cannot be promoted into imported model context",
      );
    const message = event.message as Record<string, any>;
    const role = message.role;
    if (!["user", "assistant", "tool"].includes(role))
      throw new Error("Unsupported OpenClaw message role");
    const hasReasoning = [
      "reasoning",
      "reasoning_content",
      "reasoning_details",
      "codex_reasoning_items",
    ].some((key) => message[key] != null);
    if (hasReasoning) losses.set("reasoning-excluded", (losses.get("reasoning-excluded") ?? 0) + 1);
    const rawCalls = message.tool_calls;
    const hasToolCalls = Array.isArray(rawCalls) && rawCalls.length > 0;
    const rawImages = message.images;
    const hasImages = Array.isArray(rawImages) && rawImages.length > 0;
    if (
      message.content == null &&
      !(role === "assistant" && (hasToolCalls || hasReasoning || hasImages))
    )
      throw new Error("Original OpenClaw message has missing or null content");
    const blocks = contentBlocks(message.content, calls, losses);
    if (rawCalls != null) {
      if (role !== "assistant" || !Array.isArray(rawCalls))
        throw new Error("OpenClaw tool calls must be an assistant array");
      for (const call of rawCalls) appendToolCall(call, calls, blocks);
    }
    if (rawImages != null) {
      if (!Array.isArray(rawImages)) throw new Error("OpenClaw images must be an array");
      blocks.push(...contentBlocks(rawImages, calls, losses));
    }
    if (role === "tool") {
      const id = message.toolCallId ?? message.tool_call_id;
      if (typeof id !== "string") throw new Error("OpenClaw tool result has no call identity");
      if (!calls.has(id))
        losses.set("orphan-tool-result", (losses.get("orphan-tool-result") ?? 0) + 1);
      const output = blocks
        .filter((block) => block.type === "text")
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("\n");
      turns.push({
        id: `openclaw-${seq}`,
        role: "tool",
        timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
        blocks: [
          {
            type: "tool-result",
            call_id: id,
            output,
            is_error: message.isError === true || message.is_error === true,
          },
          ...blocks.filter((block) => block.type === "attachment"),
        ],
      });
    } else if (blocks.length)
      turns.push({
        id: `openclaw-${seq}`,
        role,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : null,
        blocks,
      });
  }
  const sourceInfo: DocumentSource = {
    agent: "open-claw",
    workspace_id: workspaceId,
    title: source.session.title,
    created_at: source.session.created_at,
    updated_at: source.session.updated_at,
    git_branch: null,
  };
  return finishDocument(sourceInfo, turns, losses);
}

export function readOpenClawSqliteEvents(
  source: OpenClawSqliteSession,
  cursor: string | null,
  limit: number,
): ConversationEventPage {
  const state = snapshot(source);
  let end = Number.MAX_SAFE_INTEGER;
  if (cursor !== null) {
    const [fingerprint, raw, extra] = cursor.split(":");
    if (fingerprint !== state.fingerprint || !raw || extra !== undefined || !/^\d+$/.test(raw))
      throw new Error("OpenClaw history changed or cursor is invalid; reload the first page");
    end = Number(raw);
  }
  const events: ConversationEventPage["events"] = [];
  for (const { event, seq } of activeMessages(state.events)) {
    if (event.type !== "message") continue;
    const message = event.message as Record<string, any>;
    const role = message.role;
    if (!["user", "assistant", "tool"].includes(role))
      throw new Error("Unsupported OpenClaw message role");
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    let partIndex = 0;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : null;
    if (role === "tool") {
      const output = blocks
        .filter((part: any) => part.type === "text")
        .map((part: any) => part.text)
        .filter((text: unknown): text is string => typeof text === "string")
        .join("\n");
      const clipped = truncateUtf8(output, MAX_MESSAGE_BYTES);
      events.push({
        id: `openclaw-${seq}:0`,
        kind: "tool-summary",
        timestamp,
        content: clipped.content || null,
        tool_name: null,
        tool_status: message.isError === true || message.is_error === true ? "error" : "completed",
        duration_ms: null,
        attachment_count: 0,
        truncated: clipped.truncated,
      });
      continue;
    }
    for (const part of blocks) {
      let kind: "user-message" | "agent-message" | "tool-summary" | null = null;
      let content: string | null = null;
      let toolName: string | null = null;
      let toolStatus: string | null = null;
      let attachmentCount = 0;
      if (part.type === "text" && typeof part.text === "string") {
        kind = role === "user" ? "user-message" : "agent-message";
        content = part.text;
      } else if (part.type === "toolCall" || part.type === "tool_use") {
        const call = part.function ?? part;
        kind = "tool-summary";
        toolName = typeof call.name === "string" ? call.name : "tool";
        const input = call.arguments ?? call.input;
        content =
          typeof input === "string" ? input : input === undefined ? "" : JSON.stringify(input);
        toolStatus = "called";
      } else if (["image", "image_url", "document"].includes(part.type)) {
        kind = role === "user" ? "user-message" : "agent-message";
        attachmentCount = 1;
      }
      if (kind === null) continue;
      const clipped =
        content === null
          ? { content: null, truncated: false }
          : truncateUtf8(content, MAX_MESSAGE_BYTES);
      events.push({
        id: `openclaw-${seq}:${partIndex++}`,
        kind,
        timestamp,
        content: clipped.content,
        tool_name: toolName,
        tool_status: toolStatus,
        duration_ms: null,
        attachment_count: attachmentCount,
        truncated: clipped.truncated,
      });
    }
  }
  if (end === Number.MAX_SAFE_INTEGER) end = events.length;
  if (end > events.length) throw new Error("OpenClaw cursor is out of range");
  const page: NonNullable<ConversationEventPage["events"]> = [];
  let start = end;
  let bytes = 0;
  for (
    let index = end - 1;
    index >= 0 && page.length < Math.min(100, Math.max(1, limit));
    index--
  ) {
    const event = events[index]!;
    const size = event.content ? Buffer.byteLength(event.content) : 0;
    if (page.length > 0 && bytes + size > MAX_PAGE_BYTES) break;
    page.push(event);
    bytes += size;
    start = index;
  }
  page.reverse();
  return {
    events: page,
    next_cursor: start > 0 ? `${state.fingerprint}:${start}` : null,
    warnings: [],
  };
}

export function safeOpenClawSqliteAuthority(file: string): boolean {
  return ["", "-wal", "-shm", "-journal"].some((suffix) => existsSync(file + suffix));
}
