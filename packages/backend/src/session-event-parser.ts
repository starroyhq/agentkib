import { createHash } from "node:crypto";
import type { ConversationTurnMeta } from "@agentkib/runtime-protocol";
import { sessionTitle } from "./codex-sessions";
import {
  claudeToolDetail,
  claudeToolResult,
  claudeToolResultBytes,
  codexItemTool,
  jsonBytes,
  type ClaudeToolResult,
  type NormalizedToolCall,
  type ToolContext,
} from "./conversation-tools";
import { jsonTimestamp } from "./session-history";
import {
  claudeCommandInvocation,
  claudeCommandOutput,
  claudeLocalCommandText,
} from "./claude-command-records";
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
  /** A Codex item with the same identity as the call (MCP, sub-agents, waits). */
  detail?: NormalizedToolCall;
  /** Claude Code's structured result, bounded and redacted. */
  claude?: ClaudeToolResult;
  /** Codex items recorded inside this call, such as code-mode `exec`. */
  children?: number;
  bytes?: number;
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
  /** How tool paths are shown; fixed for one transcript read. */
  context: ToolContext;
  /**
   * Codex call outputs whose call is not read yet (reading is newest-first),
   * by turn. Bounded on its own: losing an entry only loses nesting, so it
   * never raises the association warning.
   */
  openCalls: Map<string, string | null>;
  /** Codex item rows already emitted, bounded the same way. */
  itemRows: Set<string>;
  /** A turn end read before the turn's last item; attached to that item. */
  turnMeta: { turn: string | null; meta: ConversationTurnMeta } | null;
}
const MAX_OPEN_CALLS = 256;
const MAX_ITEM_ROWS = 2048;
export function initialEventState(format: HistoryFormat, context: ToolContext = {}): EventState {
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
    context,
    openCalls: new Map(),
    itemRows: new Set(),
    turnMeta: null,
  };
}
export function associationCount(state: EventState): number {
  return (
    [...state.mirrors.values()].reduce((sum, values) => sum + values.length, 0) +
    state.tools.size +
    state.finishedTools.size +
    state.visibleTurns.size +
    state.openCalls.size +
    state.itemRows.size +
    state.pending.length
  );
}
export function associationBytes(state: EventState): number {
  return (
    [...state.mirrors.values()].reduce((sum, values) => sum + 256 + values.length * 448, 0) +
    (state.tools.size + state.finishedTools.size + state.visibleTurns.size) * 256 +
    [...state.tools.values()].reduce(
      (sum, value) => sum + (value.turn ? Buffer.byteLength(value.turn) : 0) + (value.bytes ?? 0),
      0,
    ) +
    state.openCalls.size * 320 +
    state.itemRows.size * 128 +
    (state.turnMeta ? 256 : 0) +
    (state.candidateTurn ? Buffer.byteLength(state.candidateTurn) : 0) +
    state.associationOrder.length * 128
  );
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const claudeMessageIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  id = `event-${offset}`,
): void {
  const event: ConversationEvent = {
    id,
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
  eventId?: string,
  input?: unknown,
): void {
  const key = hash(id);
  if (id) {
    if (state.finishedTools.has(key)) return;
    state.finishedTools.add(key);
  }
  remember(state, 2, key);
  const result = state.tools.get(key);
  state.tools.delete(key);
  state.openCalls.delete(key);
  const merged = mergeTurns(state, turn, result?.turn ?? null),
    event: ConversationEvent = {
      id: eventId ?? `tool-${offset}-${index}`,
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
  if (result?.detail) {
    event.tool = result.detail.detail;
    // `js` names a transport for MCP calls; the MCP tool name says what ran.
    if (result.detail.detail.mcp) event.tool_name = result.detail.name;
  } else if (state.format === "claude-code") {
    const detail = claudeToolDetail(name, input, result?.claude, state.context);
    if (detail) event.tool = detail;
  }
  if (result?.children)
    event.tool = { ...(event.tool ?? { kind: "other" }), children: result.children };
  state.pending.push(event);
}
function result(
  state: EventState,
  id: string,
  status: string | null,
  duration: number | null,
  turn: string | null,
  claude?: ClaudeToolResult,
): ToolResult | undefined {
  if (!id) return;
  const key = hash(id),
    previous = state.tools.get(key),
    merged = mergeTurns(state, previous?.turn ?? null, turn),
    entry = previous ?? { status: null, duration: null, turn: null };
  entry.status ??= toolStatus(status);
  entry.duration ??= duration;
  entry.turn = merged;
  if (claude && !entry.claude) {
    entry.claude = claude;
    entry.bytes = (entry.bytes ?? 0) + claudeToolResultBytes(claude);
  }
  state.tools.set(key, entry);
  remember(state, 1, key);
  return entry;
}
function openCall(state: EventState, key: string, turn: string | null): void {
  state.openCalls.delete(key);
  state.openCalls.set(key, turn);
  while (state.openCalls.size > MAX_OPEN_CALLS)
    state.openCalls.delete(state.openCalls.keys().next().value!);
}
function itemMilliseconds(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
/**
 * One completed Codex thread item. An item with its call's identity
 * describes that call. Otherwise it is its own row; when exactly one call of
 * the same turn is still open (its output read, its start not yet), it ran
 * inside that call and is counted as its child. Ambiguity never guesses.
 */
function codexItem(
  state: EventState,
  offset: number,
  payload: any,
  timestamp: string | null,
  turn: string | null,
): void {
  const item = payload?.item;
  const normalized = codexItemTool(item, state.context);
  if (!normalized) return;
  const itemId = stringValue(item?.id) ?? "";
  const key = itemId ? hash(itemId) : "";
  const parent = key && state.openCalls.has(key) ? state.tools.get(key) : undefined;
  if (parent) {
    if (!parent.detail) {
      parent.detail = normalized;
      parent.status = normalized.status ?? parent.status;
      parent.duration ??= normalized.durationMs;
      parent.bytes = (parent.bytes ?? 0) + jsonBytes(normalized.detail);
    }
    return;
  }
  const rowId =
    itemId && Buffer.byteLength(itemId) <= 200 ? `codex-item:${itemId}` : `tool-${offset}-0`;
  const rowKey = hash(rowId);
  if (state.itemRows.has(rowKey)) return;
  state.itemRows.add(rowKey);
  while (state.itemRows.size > MAX_ITEM_ROWS)
    state.itemRows.delete(state.itemRows.values().next().value!);
  if (turn !== null) {
    let wrapper: string | undefined;
    let count = 0;
    for (const [callKey, callTurn] of state.openCalls)
      if (callTurn === turn && ++count === 1) wrapper = callKey;
    const entry = count === 1 && wrapper ? state.tools.get(wrapper) : undefined;
    if (entry) entry.children = (entry.children ?? 0) + 1;
  }
  const started = itemMilliseconds(payload?.started_at_ms),
    completed = itemMilliseconds(payload?.completed_at_ms);
  const event: ConversationEvent = {
    id: rowId,
    kind: "tool-summary",
    timestamp: timestamp ?? (completed !== null ? new Date(completed).toISOString() : null),
    content: null,
    tool_name: normalized.name,
    tool_status: normalized.status,
    duration_ms:
      normalized.durationMs ??
      (started !== null && completed !== null && completed >= started ? completed - started : null),
    attachment_count: 0,
    truncated: false,
    tool: normalized.detail,
  };
  if (turn !== null) event.turn_id = turn;
  state.pending.push(event);
}
function turnEnd(payload: any, outcome: ConversationTurnMeta["outcome"]): ConversationTurnMeta {
  const meta: ConversationTurnMeta = {
    outcome:
      outcome === "completed" && payload?.error !== undefined && payload?.error !== null
        ? "failed"
        : outcome,
  };
  const duration = payload?.duration_ms ?? payload?.durationMs;
  if (typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0)
    meta.duration_ms = duration;
  return meta;
}
/** Attach a pending turn end to the turn's last item, the first one read after it. */
function attachTurnMeta(state: EventState, from: number): void {
  const pending = state.turnMeta;
  if (!pending) return;
  for (let index = from; index < state.pending.length; index++) {
    const event = state.pending[index]!;
    if (state.format === "claude-code") {
      // Claude records the duration after the turn's final reply.
      if (event.kind === "user-message") {
        state.turnMeta = null;
        return;
      }
      if (event.kind !== "agent-message") continue;
    } else if (pending.turn && event.turn_id && event.turn_id !== pending.turn) {
      state.turnMeta = null;
      return;
    }
    event.turn_meta = pending.meta;
    state.turnMeta = null;
    return;
  }
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
  const from = state.pending.length;
  parseRecord(state, offset, row, page);
  attachTurnMeta(state, from);
}
function parseRecord(state: EventState, offset: number, row: any, page: ConversationEvent[]): void {
  if (state.format !== "codex" && state.format !== "claude-code") {
    for (const event of compatibleEvents(state.format, offset, row)) state.pending.push(event);
    return;
  }
  const timestamp = jsonTimestamp(row?.timestamp);
  if (state.format === "claude-code") {
    if (row?.type === "system" && row?.subtype === "turn_duration") {
      state.turnMeta = { turn: null, meta: turnEnd(row, "completed") };
      return;
    }
    // The CLI's own context: a skill's expanded prompt, the caveat before a local command.
    if (row?.isMeta === true) return;
    if (row?.type === "system" && row?.subtype === "local_command") {
      // A local command's output, with the uuid of its live frame, or a command the CLI does
      // not offer in print mode, recorded as typed (`/help`).
      const text = claudeLocalCommandText(row);
      const output = claudeCommandOutput(text);
      const typed = output === null ? (claudeCommandInvocation(text) ?? text.trim()) : null;
      const id =
        typeof row.uuid === "string" && claudeMessageIdPattern.test(row.uuid)
          ? row.uuid
          : `event-${offset}`;
      if (output)
        message(
          state,
          offset,
          "agent-message",
          timestamp,
          output,
          0,
          true,
          null,
          undefined,
          page,
          id,
        );
      else if (typed?.startsWith("/"))
        message(
          state,
          offset,
          "user-message",
          timestamp,
          typed,
          0,
          true,
          null,
          undefined,
          page,
          id,
        );
      return;
    }
    if (!["user", "assistant"].includes(row?.type) || row?.isCompactSummary === true) return;
    const content = row?.message?.content;
    const rowEvents: Array<{ index: number; event: ConversationEvent }> = [];
    // The structured result describes the row's only tool result.
    const results = Array.isArray(content)
      ? content.filter((block) => block?.type === "tool_result").length
      : 0;
    if (Array.isArray(content))
      // History is parsed newest-first and reversed before delivery, so queue
      // this message's blocks in reverse to preserve their native order.
      for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index];
        if (block?.type === "tool_result")
          result(
            state,
            stringValue(block.tool_use_id) ?? "",
            block.is_error === true ? "failed" : "completed",
            null,
            null,
            claudeToolResult(results === 1 ? row?.toolUseResult : undefined, block.content),
          );
        else if (block?.type === "tool_use") {
          const pendingCount = state.pending.length;
          const id = stringValue(block.id) ?? "";
          tool(
            state,
            offset,
            index,
            id,
            stringValue(block.name) ?? "tool",
            timestamp,
            "started",
            null,
            id && id.length <= 256 ? id : undefined,
            block.input,
          );
          if (state.pending.length > pendingCount)
            rowEvents.push({ index, event: state.pending.pop()! });
        }
      }
    const kind =
      (stringValue(row?.message?.role) ?? row.type) === "assistant"
        ? "agent-message"
        : "user-message";
    const nativeId = [row?.uuid, row?.message?.id].find(
      (value) => typeof value === "string" && claudeMessageIdPattern.test(value),
    );
    const attachments = Array.isArray(content)
      ? content.filter((block) => ["image", "document"].includes(block?.type)).length
      : 0;
    const hiddenCommand = (text: string) =>
      ["<local-command-", "<command-name>", "<command-message>"].some((prefix) =>
        text.replace(/^\p{White_Space}+/u, "").startsWith(prefix),
      );
    const text = messageText(content);
    if (
      kind === "agent-message" &&
      nativeId &&
      Array.isArray(content) &&
      !hiddenCommand(text ?? "")
    ) {
      for (let index = content.length - 1; index >= 0; index--) {
        const block = content[index];
        if (block?.type !== "text" || typeof block.text !== "string") continue;
        if (!hasText(block.text) || hiddenCommand(block.text)) continue;
        const pendingCount = state.pending.length;
        message(
          state,
          offset,
          kind,
          timestamp,
          block.text,
          0,
          true,
          null,
          undefined,
          page,
          index === 0 ? nativeId : `${nativeId}:text:${index}`,
        );
        if (state.pending.length > pendingCount)
          rowEvents.push({ index, event: state.pending.pop()! });
      }
    } else {
      // A slash command reads as typed; `/compact` records its output as a user row.
      const invocation = kind === "user-message" && text ? claudeCommandInvocation(text) : null;
      const output =
        kind === "user-message" && text && !invocation ? claudeCommandOutput(text) : null;
      if (invocation || output)
        message(
          state,
          offset,
          invocation ? "user-message" : "agent-message",
          timestamp,
          (invocation ?? output)!,
          0,
          true,
          null,
          undefined,
          page,
          nativeId ?? `event-${offset}`,
        );
      else if (output === null && hasText(text) && !hiddenCommand(text))
        message(
          state,
          offset,
          kind,
          timestamp,
          text,
          attachments,
          true,
          null,
          undefined,
          page,
          nativeId ?? `event-${offset}`,
        );
    }
    // The file is read newest-first and the page is reversed before return.
    // Queue this row in reverse block order so text and tool items retain the
    // exact order of the native content array after that final reversal.
    rowEvents.sort((left, right) => right.index - left.index);
    state.pending.push(...rowEvents.map(({ event }) => event));
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
    if (payload.type === "task_complete")
      state.turnMeta = { turn, meta: turnEnd(payload, "completed") };
    // A turn with no item left to carry its end keeps none.
    else if (state.turnMeta && (state.turnMeta.turn === null || state.turnMeta.turn === turn))
      state.turnMeta = null;
    boundary(state, payload.type === "task_complete" ? "complete" : "start", turn, page);
    return;
  }
  if (row?.type === "event_msg" && payload?.type === "turn_aborted") {
    state.turnMeta = { turn, meta: turnEnd(payload, "aborted") };
    return;
  }
  if (row?.type === "event_msg" && payload?.type === "item_completed") {
    codexItem(state, offset, payload, timestamp, normalizedTurn(payload.turn_id) ?? turn);
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
  ) {
    result(state, id, "completed", null, turn);
    if (id) openCall(state, hash(id), turn);
  } else if (
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
