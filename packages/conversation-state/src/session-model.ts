import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import type { ConversationItem } from "./index";
import type { HistoryPagination } from "./history-pagination";

export interface ConversationEvent extends ConversationItem {}

export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor?: string;
  warnings: string[];
}

function mergeConversationEvents(
  previous: readonly ConversationEvent[],
  incoming: readonly ConversationEvent[],
): ConversationEvent[] {
  const items = [...previous];
  const positions = new Map(items.map((item, index) => [item.id, index]));
  for (const item of incoming) {
    const index = positions.get(item.id);
    if (index === undefined) {
      positions.set(item.id, items.length);
      items.push(item);
    } else items[index] = item;
  }
  return items;
}
export interface NativeCoverage {
  items: ConversationEvent[];
  authoritativeTurnIds: string[];
  removedTurnIds: string[];
  removedItemIds?: string[];
  preserveItemsOutsideCoverage?: boolean;
  historyCacheEpoch?: string;
  /** Any current history read failed; only a successful history read clears it. */
  historyRecoveryFailed?: boolean;
  historyReads?: { issued: number; applied: number; failed: number };
  historyPagination?: HistoryPagination;
}
export interface HistoryReadAttempt {
  state: NonNullable<NativeCoverage["historyReads"]>;
  id: number;
}
export function beginHistoryRead(coverage: NativeCoverage): HistoryReadAttempt {
  const state = (coverage.historyReads ??= { issued: 0, applied: 0, failed: 0 });
  return { state, id: ++state.issued };
}
export function failHistoryRead(coverage: NativeCoverage, attempt: HistoryReadAttempt): boolean {
  const { state, id } = attempt;
  if (coverage.historyReads !== state || id < state.applied || id < state.failed) return false;
  state.failed = id;
  coverage.historyRecoveryFailed = true;
  return true;
}
export function completeHistoryRead(coverage: NativeCoverage, attempt: HistoryReadAttempt): void {
  const { state, id } = attempt;
  if (coverage.historyReads !== state) return;
  state.applied = Math.max(state.applied, id);
  if (id >= state.failed) coverage.historyRecoveryFailed = false;
}
export function hasAppliedNewerHistory(
  coverage: NativeCoverage,
  attempt: HistoryReadAttempt,
): boolean {
  return (
    coverage.historyReads === attempt.state &&
    attempt.id < attempt.state.applied &&
    !coverage.historyRecoveryFailed
  );
}
export function mergeNativeCoverage(history: ConversationEvent[], coverage: NativeCoverage) {
  const excluded = new Set([...coverage.authoritativeTurnIds, ...coverage.removedTurnIds]);
  const removed = new Set(coverage.removedTurnIds);
  const removedItems = new Set(coverage.removedItemIds);
  const visible = history.filter(
    (item) => !removedItems.has(item.id) && (!item.turn_id || !excluded.has(item.turn_id)),
  );
  const loaded = new Map(history.map((item) => [item.id, item]));
  const native = removePersistedOverlays(
    coverage.items,
    visible,
    coverage.preserveItemsOutsideCoverage,
  )
    .filter((item) => {
      if (removedItems.has(item.id) || (item.turn_id && removed.has(item.turn_id))) return false;
      const existing = loaded.get(item.id);
      // Leaving the history row in place also keeps its native ordering.
      return !(
        item.ephemeral &&
        item.kind === "tool-summary" &&
        existing?.kind === "tool-summary" &&
        !existing.ephemeral
      );
    })
    .map((item) => {
      const existing = loaded.get(item.id);
      // A bounded baseline can verify identity and order without carrying all
      // the text already loaded from history. Keep the fuller agreeing copy.
      if (
        item.truncated &&
        typeof item.content === "string" &&
        typeof existing?.content === "string" &&
        existing.content.length > item.content.length &&
        existing.content.startsWith(item.content)
      )
        return { ...item, content: existing.content, truncated: existing.truncated };
      return item;
    });
  // The native projection is ordered even when its bounded window does not
  // cover an entire turn. Identity-only appends would move older recovered
  // rows behind the tail and move new live rows ahead of covered history.
  return mergeOrderedPersistedHistory(
    visible,
    native,
    "latest",
    coverage.preserveItemsOutsideCoverage,
  );
}

/** A final answer alone does not prove that a bounded history page covers its whole turn. */
export function removePersistedOverlays(
  previous: ConversationEvent[],
  incoming: ConversationEvent[],
  preserveOutsideCoverage = false,
) {
  const finished = new Set(
    incoming
      .filter(
        (item) =>
          item.kind === "agent-message" && item.message_phase === "final_answer" && item.turn_id,
      )
      .map((item) => item.turn_id),
  );
  const firstItems = new Map<string, ConversationEvent>();
  for (const item of incoming)
    if (item.turn_id && !firstItems.has(item.turn_id)) firstItems.set(item.turn_id, item);
  const completed = preserveOutsideCoverage
    ? new Set([...finished].filter((turn) => turn && firstItems.get(turn)?.kind === "user-message"))
    : finished;
  const persistedIds = new Set(
    preserveOutsideCoverage
      ? incoming
          .filter((item) => !item.ephemeral && item.turn_id && finished.has(item.turn_id))
          .map((item) => item.id)
      : [],
  );
  const persistedItems = new Map(
    incoming.filter((item) => !item.ephemeral).map((item) => [item.id, item]),
  );
  return previous.filter((item) => {
    if (!item.ephemeral) return true;
    const persisted = persistedItems.get(item.id);
    // A bounded native preview must not hide a fuller persisted copy of the
    // same item. Require the prefix to agree so stale history cannot undo edits.
    if (
      item.truncated &&
      typeof item.content === "string" &&
      typeof persisted?.content === "string" &&
      persisted.content.startsWith(item.content) &&
      (!persisted.truncated || persisted.content.length > item.content.length)
    )
      return false;
    return !persistedIds.has(item.id) && (!item.turn_id || !completed.has(item.turn_id));
  });
}
export function mergePersistedHistory(
  previous: ConversationEvent[],
  incoming: ConversationEvent[],
  preserveOutsideCoverage = false,
) {
  return mergeConversationEvents(
    removePersistedOverlays(previous, incoming, preserveOutsideCoverage),
    incoming,
  );
}

/** Merge one contiguous history page without losing loaded pages or its native order. */
export function mergeOrderedPersistedHistory(
  previous: ConversationEvent[],
  incoming: ConversationEvent[],
  direction: "latest" | "older",
  preserveOutsideCoverage = false,
  beforeItemIds: readonly string[] = [],
  afterItemIds: readonly string[] = [],
): ConversationEvent[] {
  const page = [...new Map(incoming.map((item) => [item.id, item])).values()];
  const pageIds = new Set(page.map((item) => item.id));
  const loaded = [...new Map(previous.map((item) => [item.id, item])).values()];
  const retainedIds = new Set(
    removePersistedOverlays(loaded, page, preserveOutsideCoverage).map((item) => item.id),
  );
  // A persisted replacement can retire an ephemeral row without retiring its
  // position. Keep that ID as an anchor, but always use the incoming contents.
  const retained = loaded.filter((item) => retainedIds.has(item.id) || pageIds.has(item.id));
  const prefix: ConversationEvent[] = [];
  const gaps = new Map<string, ConversationEvent[]>();
  let anchor: string | undefined;
  for (const item of retained) {
    if (pageIds.has(item.id)) {
      anchor = item.id;
      gaps.set(anchor, []);
    } else if (anchor === undefined) prefix.push(item);
    else gaps.get(anchor)!.push(item);
  }
  if (anchor === undefined) {
    // A page filling a history-only gap has no shared IDs. Its caller can
    // still identify the loaded range immediately after that gap.
    const beforeIds = new Set(beforeItemIds);
    const boundary = retained.findIndex((item) => beforeIds.has(item.id));
    if (boundary >= 0)
      return [...retained.slice(0, boundary), ...page, ...retained.slice(boundary)];
    // An empty latest page has no newer boundary. Its continuation still
    // follows the older window even if a later gap has since added newer rows.
    const afterIds = new Set(afterItemIds);
    let after = -1;
    for (let index = 0; index < retained.length; index++)
      if (afterIds.has(retained[index].id)) after = index;
    if (after >= 0) return [...retained.slice(0, after + 1), ...page, ...retained.slice(after + 1)];
    return direction === "older" ? [...page, ...retained] : [...retained, ...page];
  }

  // Uncovered rows between anchors stay with the preceding anchor. The loaded
  // suffix stays after the entire incoming page, including its new final rows.
  const suffix = gaps.get(anchor)!;
  gaps.delete(anchor);
  const merged = prefix;
  for (const item of page) {
    merged.push(item);
    for (const retainedItem of gaps.get(item.id) ?? []) merged.push(retainedItem);
  }
  for (const item of suffix) merged.push(item);
  return merged;
}
export const MAX_MESSAGE_LENGTH = 16_000;
const MAX_MESSAGE_BYTES = 16_384;
const messageEncoder = new TextEncoder();
export function isValidMessage(message: string, hasAttachments = false) {
  const text = message.trim();
  return (
    (!!text || hasAttachments) &&
    message.length <= MAX_MESSAGE_LENGTH &&
    messageEncoder.encode(message).byteLength <= MAX_MESSAGE_BYTES
  );
}
/** A fresh latest page replaces transient availability warnings, but not diagnostics for retained rows. */
export function mergeLatestHistoryWarnings(
  previous: readonly string[] | undefined,
  latest: readonly string[],
): string[] {
  const retained = previous?.filter(
    (warning) =>
      warning !== REMOTE_ERROR_CODES.dshHistoryTimeout &&
      warning !== REMOTE_ERROR_CODES.dshHistoryUnavailable,
  );
  return [...new Set([...(retained ?? []), ...latest])];
}

export function mergeLatestPage(
  previous: ConversationEventPage | undefined,
  latest: ConversationEventPage,
): ConversationEventPage {
  if (!previous || latest.events.length === 0) return latest;
  const first = previous.events.findIndex((event) => event.id === latest.events[0].id);
  return first < 0
    ? latest
    : {
        events: [...previous.events.slice(0, first), ...latest.events],
        next_cursor: previous.next_cursor,
        warnings: mergeLatestHistoryWarnings(previous.warnings, latest.warnings),
      };
}
