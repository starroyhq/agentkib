import type { ConversationItem } from "./index";

export type ConversationMessagePhase = "commentary" | "final_answer";
export type ConversationTurnOutcome = "completed" | "aborted" | "failed";

export type ConversationEventWithTurn = ConversationItem & {
  turn_meta?: { outcome?: ConversationTurnOutcome; duration_ms?: number };
};

export interface ConversationTranscriptSegment<T = ConversationEventWithTurn> {
  key: string;
  kind: "event" | "process";
  events: T[];
  collapsible: boolean;
  defaultOpen: boolean;
  toolCount: number;
  failedToolCount: number;
  outcome?: ConversationTurnOutcome;
}

export interface ConversationTurnGroup<T = ConversationEventWithTurn> {
  key: string;
  turnId?: string;
  events: T[];
  segments: ConversationTranscriptSegment<T>[];
  /** Whether the loaded history shows both boundaries; use outcome for terminal state. */
  complete: boolean;
  truncated: boolean;
  timestamp?: string;
  outcome?: ConversationTurnOutcome;
  durationMs?: number;
  terminalMarkerId?: string;
  ambiguousTurn?: boolean;
}

export interface ConversationGroupingOptions<T = ConversationEventWithTurn> {
  /** A warning may indicate missing rows, even when the terminal outcome is known. */
  incomplete?: boolean;
  /** Keep turn metadata from hidden events, without displaying their content. */
  isHidden?: (event: T) => boolean;
}

export function reliableTurnId(event: Pick<ConversationItem, "turn_id">): string | undefined {
  if (typeof event.turn_id !== "string") return undefined;
  return event.turn_id.trim() || undefined;
}

export function isFailedToolEvent(event: Pick<ConversationItem, "kind" | "tool_status">): boolean {
  if (event.kind !== "tool-summary") return false;
  const status = event.tool_status?.trim().toLowerCase();
  return status === "failed" || status === "failure" || status === "error" || status === "errored";
}

/** Project only the records attributable to this ended turn. */
export function turnFileActivity<T extends ConversationEventWithTurn>(
  group: ConversationTurnGroup<T>,
) {
  if (!group.turnId || !group.outcome || group.ambiguousTurn) return;
  const events = group.events.filter((event) => event.kind === "tool-summary");
  if (events.length) return { events, partial: !group.complete };
}

function terminalOutcome(event: ConversationEventWithTurn): ConversationTurnOutcome | undefined {
  const outcome = event.turn_meta?.outcome;
  return outcome === "completed" || outcome === "aborted" || outcome === "failed"
    ? outcome
    : undefined;
}

function isTerminalMarker(event: ConversationEventWithTurn, turnId?: string): boolean {
  return (
    !!turnId &&
    event.id === `codex-turn-end:${turnId}` &&
    event.kind === "agent-message" &&
    !event.content &&
    !event.attachment_count &&
    !event.images?.length &&
    !!terminalOutcome(event)
  );
}

function isCommentary(event: ConversationEventWithTurn): boolean {
  return event.kind === "agent-message" && event.message_phase === "commentary";
}

function isFinalAnswer(event: ConversationEventWithTurn): boolean {
  return (
    event.kind === "agent-message" &&
    event.message_phase === "final_answer" &&
    (!!event.content?.trim() || !!event.attachment_count || !!event.images?.length) &&
    (!event.ephemeral || terminalOutcome(event) === "completed")
  );
}

function visibleResult<T extends ConversationEventWithTurn>(
  events: T[],
  outcome: ConversationTurnOutcome | undefined,
  turnId?: string,
): Set<T> {
  if (outcome === "failed") {
    const failure = [...events]
      .reverse()
      .find(
        (event) =>
          event.kind === "agent-message" &&
          event.cli_output &&
          (terminalOutcome(event) === "failed" || event.id === `codex-turn-error:${turnId}`),
      );
    return new Set(failure ? [failure] : []);
  }
  if (outcome !== "completed") return new Set();
  let last = events.length - 1;
  while (last >= 0 && !isFinalAnswer(events[last])) last--;
  if (last < 0) return new Set();
  let first = last;
  // A final response can arrive as several consecutive native message items.
  while (first > 0 && isFinalAnswer(events[first - 1])) first--;
  return new Set(events.slice(first, last + 1));
}

function createSegments<T extends ConversationEventWithTurn>(
  groupKey: string,
  events: T[],
  outcome: ConversationTurnOutcome | undefined,
  turnId?: string,
): ConversationTranscriptSegment<T>[] {
  const segments: ConversationTranscriptSegment<T>[] = [];
  const results = visibleResult(events, outcome, turnId);
  const add = (kind: "event" | "process", items: T[]) => {
    const process = kind === "process";
    const toolCount = items.filter((event) => event.kind === "tool-summary").length;
    const anchor = items.find((event) => event.kind === "tool-summary") ?? items[0];
    segments.push({
      key: `${groupKey}:segment:${anchor?.id ?? "terminal"}`,
      kind,
      events: items,
      collapsible: process && items.length > 0,
      defaultOpen: !process,
      toolCount,
      failedToolCount: items.filter(isFailedToolEvent).length,
      ...(process && outcome ? { outcome } : {}),
    });
  };

  let position = 0;
  while (position < events.length) {
    const first = events[position++];
    if (first.kind === "user-message") {
      add("event", [first]);
      continue;
    }
    const start = position - 1;
    while (position < events.length && events[position].kind !== "user-message") position++;
    const run = events.slice(start, position);
    if (outcome === "aborted" || outcome === "failed" || results.size > 0) {
      // Fold assistant output within its user-message boundary. Tools recorded
      // after the result still belong to the same disclosure.
      const process = run.filter((event) => !results.has(event));
      if (process.length) add("process", process);
      for (const event of run) if (results.has(event)) add("event", [event]);
      continue;
    }
    // Legacy completed replies may lack a final phase. Keep unclassified
    // messages readable; a contiguous run of known process rows can still fold.
    let process: T[] = [];
    for (const event of run) {
      if (event.kind === "tool-summary" || (outcome === "completed" && isCommentary(event))) {
        process.push(event);
        continue;
      }
      if (process.length) add("process", process);
      process = [];
      add("event", [event]);
    }
    if (process.length) add("process", process);
  }
  if (outcome && events.every((event) => event.kind === "user-message")) add("process", []);
  return segments;
}

/** Keep contiguous native turns and conservative, ordered legacy fallbacks. */
export function groupConversationEvents<T extends ConversationEventWithTurn>(
  events: readonly T[],
  options: ConversationGroupingOptions<T> = {},
): ConversationTurnGroup<T>[] {
  const groups: ConversationTurnGroup<T>[] = [];
  const groupsByTurn = new Map<string, ConversationTurnGroup<T>>();
  let turnId: string | undefined;
  let entries: Array<{ event: T; visible: boolean }> = [];
  const flush = () => {
    if (!entries.length) return;
    const visible = entries.filter((entry) => entry.visible).map((entry) => entry.event);
    const terminals = turnId
      ? entries.map(({ event }) => event).filter((event) => terminalOutcome(event))
      : [];
    const terminal = terminals.at(-1);
    const lastOutcome = terminal && terminalOutcome(terminal);
    const outcome = terminals.every((event) => terminalOutcome(event) === lastOutcome)
      ? lastOutcome
      : undefined;
    if (!visible.length && !outcome) {
      entries = [];
      return;
    }
    const anchor =
      visible.find((event) => event.kind === "user-message") ?? visible[0] ?? entries[0].event;
    const key = turnId ? `turn:${turnId}:start:${anchor.id}` : `event:${anchor.id}`;
    const truncated = visible.some((event) => event.truncated);
    const group: ConversationTurnGroup<T> = {
      key,
      turnId,
      events: visible,
      segments: createSegments(key, visible, outcome, turnId),
      complete:
        !options.incomplete &&
        !truncated &&
        !!turnId &&
        visible[0]?.kind === "user-message" &&
        (!!outcome || visible.some(isFinalAnswer)),
      truncated,
      timestamp: entries.find(({ event }) => event.timestamp)?.event.timestamp,
      outcome,
      durationMs: outcome ? terminal?.turn_meta?.duration_ms : undefined,
      terminalMarkerId:
        outcome && terminal && isTerminalMarker(terminal, turnId) ? terminal.id : undefined,
    };
    if (turnId) {
      const earlierGroup = groupsByTurn.get(turnId);
      // A repeated ID in disconnected ranges does not establish a unique
      // association for a turn-wide summary. Keep its tool records in place.
      if (earlierGroup) {
        earlierGroup.ambiguousTurn = true;
        group.ambiguousTurn = true;
      } else groupsByTurn.set(turnId, group);
    }
    groups.push(group);
    entries = [];
  };
  for (const event of events) {
    const nextTurnId = reliableTurnId(event);
    const visible = !isTerminalMarker(event, nextTurnId) && !options.isHidden?.(event);
    if (!visible && (!nextTurnId || !terminalOutcome(event))) continue;
    if (entries.length && turnId !== nextTurnId) flush();
    turnId = nextTurnId;
    entries.push({ event, visible });
  }
  flush();
  return groups;
}

export const groupConversationTurns = groupConversationEvents;
