import type { ConversationEventPage } from "./session-model";
import type { ConversationItem } from "./index";

type HistoryBatchEvent = ConversationItem & { turn_meta?: { outcome?: string } };

function isReadableHistoryEvent(event: HistoryBatchEvent): boolean {
  return (
    event.kind === "user-message" ||
    !!event.turn_meta?.outcome ||
    (event.kind === "agent-message" &&
      event.message_phase !== "commentary" &&
      (!!event.content?.trim() || event.attachment_count > 0 || !!event.images?.length))
  );
}

/** Pull a few readable turns using existing bounded event pages and their continuations. */
export async function loadEarlierHistoryBatch(
  cursor: string,
  visible: readonly HistoryBatchEvent[],
  readAndApply: (
    cursor: string,
  ) => Promise<{ events: readonly HistoryBatchEvent[]; next_cursor?: string | null } | undefined>,
  turnId?: string,
): Promise<void> {
  const deadline = performance.now() + 1200;
  const requestedCursors = new Set<string>();
  const seenEvents = new Set(visible.map((event) => event.id));
  const visibleTurns = new Set(
    visible.filter(isReadableHistoryEvent).map((event) => event.turn_id),
  );
  const addedTurns = new Set<string>();
  let next: string | null | undefined = cursor;
  while (next && !requestedCursors.has(next) && requestedCursors.size < 4) {
    requestedCursors.add(next);
    const page = await readAndApply(next);
    if (!page) return;
    const added = page.events.filter((event) => !seenEvents.has(event.id));
    for (const event of added) seenEvents.add(event.id);
    if (turnId) {
      if (
        added.some(
          (event) => event.kind === "user-message" || (event.turn_id && event.turn_id !== turnId),
        )
      )
        return;
    } else {
      for (const event of added.filter(isReadableHistoryEvent)) {
        // Older sources without turn IDs only provide an event window. Stop on
        // the first readable window instead of guessing where their turns start.
        if (!event.turn_id) return;
        if (!visibleTurns.has(event.turn_id)) addedTurns.add(event.turn_id);
      }
      if (addedTurns.size >= 3) return;
    }
    if (performance.now() >= deadline) return;
    next = page.next_cursor;
  }
}

interface HistoryRange {
  id: number;
  cursor: string;
  version: number;
  /** IDs registered before this range was created belong to an older window. */
  stopAt?: number;
  emptyHead: boolean;
  beforeItemIds: string[];
  afterItemIds: string[];
  headVersion: number;
}

export interface HistoryPagination {
  readonly scope: object;
  readonly persisted: Map<string, number>;
  readonly ranges: HistoryRange[];
  initialized: boolean;
  ordinal: number;
  nextRangeId: number;
  latestReadOrder?: number;
  latestVersion: number;
  tailItemIds: string[];
}

export interface HistoryPaginationTicket {
  readonly scope: object;
  readonly rangeId: number;
  readonly cursor: string;
  readonly version: number;
  readonly kind: "gap" | "older";
  /** Raw IDs immediately newer than this continuation, in provider order. */
  readonly beforeItemIds: readonly string[];
  /** Older raw window, used when an empty/removed head has no visible anchor. */
  readonly afterItemIds: readonly string[];
}

export function createHistoryPagination(): HistoryPagination {
  return {
    scope: {},
    persisted: new Map(),
    ranges: [],
    initialized: false,
    ordinal: 0,
    nextRangeId: 0,
    latestVersion: 0,
    tailItemIds: [],
  };
}

export function historyPaginationCursor(state: HistoryPagination): string | undefined {
  return state.ranges.at(-1)?.cursor;
}

/** The oldest persisted window is cut inside this turn, or at its unknown start. */
export function oldestIncompleteHistoryTurn(
  page: ConversationEventPage | undefined,
  pagination?: HistoryPagination,
): string | undefined {
  const oldest = page?.events[0];
  if (!page?.next_cursor || !oldest?.turn_id || oldest.kind === "user-message") return;
  if (pagination) {
    const range = pagination.ranges.at(-1);
    if (
      range?.cursor !== page.next_cursor ||
      range.stopAt !== undefined ||
      range.beforeItemIds[0] !== oldest.id
    )
      return;
  }
  return oldest.turn_id;
}

function registerIds(state: HistoryPagination, page: ConversationEventPage): void {
  for (const item of page.events)
    if (!state.persisted.has(item.id)) state.persisted.set(item.id, ++state.ordinal);
}

/** Register only the raw persisted response, never a page merged with native items. */
export function recordLatestHistoryPage(
  state: HistoryPagination,
  page: ConversationEventPage,
  readOrder?: number,
): string | undefined {
  if (readOrder !== undefined) {
    if (state.latestReadOrder !== undefined && readOrder <= state.latestReadOrder)
      return historyPaginationCursor(state);
    state.latestReadOrder = readOrder;
  }
  state.latestVersion++;
  const overlap = page.events.some((item) => state.persisted.has(item.id));
  const stopAt = state.ordinal;
  if (!page.next_cursor) {
    // A latest read reaching the beginning covers every older continuation.
    state.ranges.length = 0;
  } else if (!state.initialized || !overlap) {
    const head = state.ranges.at(-1);
    if (head?.emptyHead) {
      // Repeated scan-budget pages have no raw anchor. Start from the newest
      // such snapshot without accumulating empty windows or trusting native IDs.
      head.cursor = page.next_cursor;
      head.version++;
      head.emptyHead = page.events.length === 0;
      head.beforeItemIds = page.events.map((item) => item.id);
      head.headVersion = state.latestVersion;
    } else {
      state.ranges.push({
        id: ++state.nextRangeId,
        cursor: page.next_cursor,
        version: 0,
        stopAt: state.initialized ? stopAt : undefined,
        emptyHead: page.events.length === 0,
        beforeItemIds: page.events.map((item) => item.id),
        afterItemIds: state.initialized ? [...state.tailItemIds] : [],
        headVersion: state.latestVersion,
      });
    }
  }
  state.initialized = true;
  if (page.events.length > 0 || !page.next_cursor)
    state.tailItemIds = page.events.map((item) => item.id);
  registerIds(state, page);
  return historyPaginationCursor(state);
}

export function beginHistoryPagination(
  state: HistoryPagination,
  cursor: string | undefined,
): HistoryPaginationTicket | undefined {
  if (!cursor) return undefined;
  const range = [...state.ranges].reverse().find((candidate) => candidate.cursor === cursor);
  if (!range) return undefined;
  return {
    scope: state.scope,
    rangeId: range.id,
    cursor,
    version: range.version,
    kind: range.stopAt === undefined ? "older" : "gap",
    beforeItemIds: [...range.beforeItemIds],
    afterItemIds: [...range.afterItemIds],
  };
}

/** A later latest page may add a gap without invalidating this range's read. */
export function applyHistoryPagination(
  state: HistoryPagination,
  ticket: HistoryPaginationTicket,
  page: ConversationEventPage,
): boolean {
  if (ticket.scope !== state.scope) return false;
  const index = state.ranges.findIndex((range) => range.id === ticket.rangeId);
  const range = state.ranges[index];
  if (!range || range.cursor !== ticket.cursor || range.version !== ticket.version) return false;
  const stopAt = range.stopAt;
  const connected =
    stopAt !== undefined &&
    page.events.some((item) => {
      const ordinal = state.persisted.get(item.id);
      return ordinal !== undefined && ordinal <= stopAt;
    });
  registerIds(state, page);
  if (range.emptyHead && range.headVersion === state.latestVersion && page.events.length > 0)
    state.tailItemIds = page.events.map((item) => item.id);
  if (!page.next_cursor) {
    // This snapshot reached the beginning. Newer gaps can still be unresolved.
    state.ranges.splice(0, index + 1);
  } else if (connected) {
    state.ranges.splice(index, 1);
  } else {
    range.cursor = page.next_cursor;
    range.version++;
    if (page.events.length > 0) {
      range.emptyHead = false;
      range.beforeItemIds = page.events.map((item) => item.id);
    }
  }
  return true;
}
