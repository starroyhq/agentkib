import { createHash } from "node:crypto";
import { sessionTitle } from "./codex-sessions";
import { jsonTimestamp } from "./session-history";
import {
  compatibleEvents,
  hasText,
  messageText,
  property,
  stringValue,
  toolStatus,
  trimWhitespace,
  truncateUtf8,
  type ConversationEvent,
  type HistoryFormat,
} from "./session-events";
interface Mirror {
  primary: boolean;
  eventId: string;
  timestamp: string | null;
  turn: string | null;
  sequence: number;
}
interface ToolResult {
  status: string | null;
  duration: number | null;
  turn: string | null;
}
export interface EventState {
  format: HistoryFormat;
  pending: ConversationEvent[];
  sequence: number;
  mirrors: Map<string, Mirror[]>;
  tools: Map<string, ToolResult>;
  finishedTools: Set<string>;
  visibleTurns: Set<string>;
  associationOrder: [number, string][];
  associationWarning: boolean;
  candidateTurn: string | null;
  turnRangeStart: number;
}
export function initialEventState(format: HistoryFormat): EventState {
  return {
    format,
    pending: [],
    sequence: 0,
    mirrors: new Map(),
    tools: new Map(),
    finishedTools: new Set(),
    visibleTurns: new Set(),
    associationOrder: [],
    associationWarning: false,
    candidateTurn: null,
    turnRangeStart: 0,
  };
}
export function associationCount(state: EventState): number {
  return (
    [...state.mirrors.values()].reduce((sum, values) => sum + values.length, 0) +
    state.tools.size +
    state.finishedTools.size +
    state.visibleTurns.size +
    state.pending.length
  );
}
export function associationBytes(state: EventState): number {
  return (
    [...state.mirrors.values()].reduce((sum, values) => sum + 256 + values.length * 448, 0) +
    (state.tools.size + state.finishedTools.size + state.visibleTurns.size) * 256 +
    [...state.tools.values()].reduce(
      (sum, value) => sum + (value.turn ? Buffer.byteLength(value.turn) : 0),
      0,
    ) +
    (state.candidateTurn ? Buffer.byteLength(state.candidateTurn) : 0) +
    state.associationOrder.length * 128
  );
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function remember(state: EventState, kind: number, key: string): void {
  state.associationOrder.push([kind, key]);
  while (state.associationOrder.length > 4096) {
    const [kind, key] = state.associationOrder.shift()!;
    const removed =
      kind === 0
        ? state.mirrors.delete(key)
        : kind === 1
          ? state.tools.delete(key)
          : kind === 2
            ? state.finishedTools.delete(key)
            : state.visibleTurns.delete(key);
    state.associationWarning ||= removed;
  }
}
function normalizedTurn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const turn = trimWhitespace(value);
  return turn && Buffer.byteLength(turn) <= 256 ? turn : null;
}
function recordTurn(row: any, payload: any): string | null {
  const value = property(payload, ["turn_id"]);
  return (
    normalizedTurn(
      value === undefined ? payload?.internal_chat_message_metadata_passthrough?.turn_id : value,
    ) ?? normalizedTurn(row?.turn_id)
  );
}
function phase(payload: any): ConversationEvent["message_phase"] {
  const value = property(payload, ["phase", "message_phase"]);
  return value === "commentary" || value === "final_answer" ? value : undefined;
}
function mergeTurns(state: EventState, a: string | null, b: string | null): string | null {
  if (a !== null && b !== null && a !== b) {
    state.associationWarning = true;
    return null;
  }
  return a ?? b;
}
function mergeMetadata(
  event: ConversationEvent,
  turn: string | null,
  phase: ConversationEvent["message_phase"],
  attachments: number,
): boolean {
  let conflict = false;
  if (event.turn_id && turn && event.turn_id !== turn) {
    delete event.turn_id;
    conflict = true;
  } else if (!event.turn_id && turn) event.turn_id = turn;
  if (event.message_phase && phase && event.message_phase !== phase) {
    delete event.message_phase;
    conflict = true;
  } else if (!event.message_phase && phase) event.message_phase = phase;
  event.attachment_count = Math.max(event.attachment_count, attachments);
  return conflict;
}
function message(
  state: EventState,
  offset: number,
  kind: ConversationEvent["kind"],
  timestamp: string | null,
  content: string,
  attachments: number,
  primary: boolean,
  turn: string | null,
  classification: ConversationEvent["message_phase"],
  page: ConversationEvent[],
): void {
  const event: ConversationEvent = {
    id: `event-${offset}`,
    kind,
    timestamp,
    ...truncateUtf8(content),
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: attachments,
  };
  if (turn !== null) event.turn_id = turn;
  if (kind === "agent-message" && classification) event.message_phase = classification;
  if (state.format === "codex") {
    const key = hash(
        `${kind === "user-message" ? "UserMessage" : "AgentMessage"}:${trimWhitespace(content)}`,
      ),
      mirrors = state.mirrors.get(key) ?? [],
      candidates = mirrors
        .map((mirror, index) => ({ mirror, index }))
        .filter(
          ({ mirror }) =>
            mirror.primary !== primary &&
            state.sequence - mirror.sequence <= 64 &&
            !(turn && mirror.turn && turn !== mirror.turn) &&
            ((turn && mirror.turn) ||
              !timestamp ||
              !mirror.timestamp ||
              Math.abs(Date.parse(timestamp) - Date.parse(mirror.timestamp)) <= 1000),
        );
    candidates.sort((a, b) => {
      const rank = (mirror: Mirror): number[] => [
        turn && mirror.turn && turn === mirror.turn ? 0 : 1,
        timestamp && mirror.timestamp
          ? Math.abs(Date.parse(timestamp) - Date.parse(mirror.timestamp))
          : Infinity,
        state.sequence - mirror.sequence,
      ];
      const left = rank(a.mirror),
        right = rank(b.mirror);
      for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
      return 0;
    });
    const ambiguous = candidates.length > 1;
    state.associationWarning ||= ambiguous;
    const candidate = candidates[0];
    if (candidate) {
      const counterpart = mirrors.splice(candidate.index, 1)[0]!,
        existing =
          page.find((value) => value.id === counterpart.eventId) ??
          state.pending.find((value) => value.id === counterpart.eventId);
      let conflict: boolean;
      if (ambiguous) {
        if (existing) {
          delete existing.turn_id;
          delete existing.message_phase;
          conflict = false;
        } else conflict = true;
      } else if (existing)
        conflict = mergeMetadata(existing, event.turn_id ?? null, event.message_phase, attachments);
      else
        conflict =
          event.turn_id !== undefined ||
          event.message_phase !== undefined ||
          (primary && attachments > 0);
      state.associationWarning ||= conflict;
      if (!mirrors.length) state.mirrors.delete(key);
      return;
    }
    mirrors.push({ primary, eventId: event.id, timestamp, turn, sequence: state.sequence });
    state.mirrors.set(key, mirrors);
    remember(state, 0, key);
  }
  state.pending.push(event);
}
function tool(
  state: EventState,
  offset: number,
  index: number,
  id: string,
  name: string,
  timestamp: string | null,
  status: string | null,
  turn: string | null,
): void {
  const key = hash(id);
  if (id) {
    if (state.finishedTools.has(key)) return;
    state.finishedTools.add(key);
  }
  remember(state, 2, key);
  const result = state.tools.get(key);
  state.tools.delete(key);
  const merged = mergeTurns(state, turn, result?.turn ?? null),
    event: ConversationEvent = {
      id: `tool-${offset}-${index}`,
      kind: "tool-summary",
      timestamp,
      content: null,
      tool_name: sessionTitle(name) ?? "tool",
      tool_status: result?.status ?? toolStatus(status),
      duration_ms: result?.duration ?? null,
      attachment_count: 0,
      truncated: false,
    };
  if (merged !== null) event.turn_id = merged;
  state.pending.push(event);
}
function result(
  state: EventState,
  id: string,
  status: string | null,
  duration: number | null,
  turn: string | null,
): void {
  if (!id) return;
  const key = hash(id),
    previous = state.tools.get(key),
    merged = mergeTurns(state, previous?.turn ?? null, turn),
    entry = previous ?? { status: null, duration: null, turn: null };
  entry.status ??= toolStatus(status);
  entry.duration ??= duration;
  entry.turn = merged;
  state.tools.set(key, entry);
  remember(state, 1, key);
}
function applyTurn(state: EventState, page: ConversationEvent[], turn: string): void {
  if (state.associationWarning) return;
  const events = [...page.slice(Math.min(state.turnRangeStart, page.length)), ...state.pending];
  if (events.some((event) => event.turn_id && event.turn_id !== turn)) {
    state.associationWarning = true;
    return;
  }
  for (const event of events) event.turn_id ??= turn;
}
function boundary(
  state: EventState,
  kind: "complete" | "context" | "start",
  turn: string | null,
  page: ConversationEvent[],
): void {
  if (turn === null) {
    state.candidateTurn = null;
    state.turnRangeStart = page.length;
    return;
  }
  if (kind === "complete") {
    state.candidateTurn = turn;
    state.turnRangeStart = page.length;
    return;
  }
  if (state.candidateTurn && state.candidateTurn !== turn) {
    state.associationWarning = true;
    state.candidateTurn = null;
  } else {
    applyTurn(state, page, turn);
    if (kind === "context") state.candidateTurn = turn;
  }
  if (kind === "start") state.candidateTurn = null;
  state.turnRangeStart = page.length;
}
const internalPrefixes = [
  "<path>",
  "<content>",
  "<recommended_plugins>",
  "<available_skills>",
  "<app-context>",
  "<skills_instructions>",
  "<environment_context>",
  "# AGENTS.md instructions",
];
function injected(content: any): boolean {
  return (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every(
      (block) =>
        ["text", "input_text"].includes(block?.type) &&
        typeof block?.text === "string" &&
        internalPrefixes.some((prefix) =>
          block.text.replace(/^\p{White_Space}+/u, "").startsWith(prefix),
        ),
    )
  );
}
export function parseEventRecord(
  state: EventState,
  offset: number,
  row: any,
  page: ConversationEvent[],
): void {
  if (state.format !== "codex" && state.format !== "claude-code") {
    for (const event of compatibleEvents(state.format, offset, row)) state.pending.push(event);
    return;
  }
  const timestamp = jsonTimestamp(row?.timestamp);
  if (state.format === "claude-code") {
    if (!["user", "assistant"].includes(row?.type) || row?.isCompactSummary === true) return;
    const content = row?.message?.content;
    if (Array.isArray(content))
      for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index];
        if (block?.type === "tool_result")
          result(
            state,
            stringValue(block.tool_use_id) ?? "",
            block.is_error === true ? "failed" : "completed",
            null,
            null,
          );
        else if (block?.type === "tool_use")
          tool(
            state,
            offset,
            index,
            stringValue(block.id) ?? "",
            stringValue(block.name) ?? "tool",
            timestamp,
            "started",
            null,
          );
      }
    const text = messageText(content);
    if (
      hasText(text) &&
      !["<local-command-", "<command-name>", "<command-message>"].some((prefix) =>
        text.replace(/^\p{White_Space}+/u, "").startsWith(prefix),
      )
    )
      message(
        state,
        offset,
        (stringValue(row?.message?.role) ?? row.type) === "assistant"
          ? "agent-message"
          : "user-message",
        timestamp,
        text,
        Array.isArray(content)
          ? content.filter((block) => ["image", "document"].includes(block?.type)).length
          : 0,
        true,
        null,
        undefined,
        page,
      );
    return;
  }
  const payload = row?.payload,
    id = stringValue(payload?.call_id) ?? "",
    turn = recordTurn(row, payload);
  if (row?.type === "turn_context") {
    boundary(state, "context", turn, page);
    return;
  }
  if (row?.type === "event_msg" && ["task_complete", "task_started"].includes(payload?.type)) {
    boundary(state, payload.type === "task_complete" ? "complete" : "start", turn, page);
    return;
  }
  if (row?.type === "event_msg" && ["user_message", "agent_message"].includes(payload?.type)) {
    if (typeof payload.message === "string")
      message(
        state,
        offset,
        payload.type === "user_message" ? "user-message" : "agent-message",
        timestamp,
        payload.message,
        (Array.isArray(payload.images) ? payload.images.length : 0) +
          (Array.isArray(payload.local_images) ? payload.local_images.length : 0),
        true,
        turn,
        phase(payload),
        page,
      );
  } else if (row?.type === "response_item" && payload?.type === "message") {
    if (!["user", "assistant"].includes(payload.role)) return;
    const content = payload.content,
      text = messageText(content);
    if (text === null) return;
    const injectedTurn = payload.internal_chat_message_metadata_passthrough?.turn_id;
    if (payload.role === "user" && typeof injectedTurn === "string") {
      const key = hash(injectedTurn);
      if (injected(content)) {
        if (state.visibleTurns.has(key)) return;
        state.associationWarning = true;
      } else {
        state.visibleTurns.add(key);
        remember(state, 3, key);
      }
    }
    message(
      state,
      offset,
      payload.role === "user" ? "user-message" : "agent-message",
      timestamp,
      text,
      Array.isArray(content)
        ? content.filter((block) => ["input_image", "image", "document"].includes(block?.type))
            .length
        : 0,
      false,
      turn,
      payload.role === "assistant" ? phase(payload) : undefined,
      page,
    );
  } else if (
    row?.type === "response_item" &&
    ["function_call", "custom_tool_call"].includes(payload?.type)
  ) {
    tool(
      state,
      offset,
      0,
      id,
      stringValue(payload.name) ?? "tool",
      timestamp,
      stringValue(payload.status),
      turn,
    );
  } else if (
    row?.type === "response_item" &&
    ["function_call_output", "custom_tool_call_output"].includes(payload?.type)
  )
    result(state, id, "completed", null, turn);
  else if (
    row?.type === "event_msg" &&
    ["exec_command_end", "patch_apply_end"].includes(payload?.type)
  ) {
    const status =
        stringValue(payload.status) ??
        (typeof payload.success === "boolean" ? (payload.success ? "completed" : "failed") : null),
      duration =
        typeof payload.duration === "number"
          ? Math.min(
              Number(18446744073709551615n),
              Math.max(0, Math.trunc(payload.duration * 1000)),
            )
          : null;
    result(state, id, status, duration, turn);
    tool(
      state,
      offset,
      0,
      id,
      payload.type === "exec_command_end" ? "shell" : "apply_patch",
      timestamp,
      status,
      turn,
    );
  } else if (row?.type === "response_item" && payload?.type === "web_search_call")
    tool(state, offset, 0, "", "web_search", timestamp, stringValue(payload.status), turn);
}
