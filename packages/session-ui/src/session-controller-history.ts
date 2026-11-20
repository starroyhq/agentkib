import { useCallback, type RefObject, type SetStateAction } from "react";
import { ApiError, type ConversationEventPage, type WebClient } from "@agentkib/web-client";
import {
  applyHistoryPagination,
  beginHistoryPagination,
  beginHistoryRead,
  completeHistoryRead,
  failHistoryRead,
  hasAppliedNewerHistory,
  historyPaginationCursor,
  loadEarlierHistoryBatch,
  mergeConversationItems,
  mergeNativeCoverage,
  mergeOrderedPersistedHistory,
  oldestIncompleteHistoryTurn,
  rebaseHistoryPagination,
  removePersistedOverlays,
  type NativeCoverage,
} from "@agentkib/conversation-state";
import { captureHistoryScrollAnchor } from "./history-scroll-anchor";

export type EarlierHistoryFlight = {
  generation: number;
  pagination: NonNullable<NativeCoverage["historyPagination"]>;
  cacheEpoch: string | undefined;
};

type SessionHistoryBinding = {
  generation: RefObject<number>;
  selection: RefObject<string>;
  excludedIds: RefObject<ReadonlySet<string>>;
  nativeCoverage: RefObject<NativeCoverage>;
  fail: (error: unknown, generation?: number) => void;
  setError: (error: boolean) => void;
};

export function useSessionHistoryRead({
  client,
  excludedIds,
  generation,
  selection,
  nativeCoverage,
  setError,
  fail,
}: SessionHistoryBinding & { client: WebClient }) {
  return useCallback(
    async (id: string, g: number, historyCacheEpoch: string | undefined, cursor?: string) => {
      if (excludedIds.current.has(id)) return undefined;
      const attempt = beginHistoryRead(nativeCoverage.current);
      try {
        return { type: "page" as const, page: await client.events(id, cursor), attempt };
      } catch (error) {
        if (
          g === generation.current &&
          selection.current === id &&
          historyCacheEpoch === nativeCoverage.current.historyCacheEpoch
        ) {
          // Handle history separately from the concurrent live read, including
          // a late history failure after Promise.all has already rejected.
          if (error instanceof DOMException && error.name === "AbortError") return undefined;
          // Return contention separately so a concurrent real live-read failure
          // is still observed before the caller schedules read recovery.
          if (error instanceof ApiError && error.code === "operation_busy")
            return { type: "busy" as const, error };
          if (cursor && error instanceof ApiError && error.code === "stale_cursor")
            return { type: "stale-cursor" as const };
          if (failHistoryRead(nativeCoverage.current, attempt)) {
            setError(true);
            fail(error, g);
          } else if (hasAppliedNewerHistory(nativeCoverage.current, attempt)) {
            // A newer applied history read already satisfied this refresh. Keep
            // its completion distinct from an unresolved or out-of-scope failure.
            return { type: "superseded" as const, attempt };
          }
        }
        return undefined;
      }
    },
    [client, excludedIds, generation, selection, nativeCoverage, setError, fail],
  );
}

export function createEarlierSessionHistory({
  selected,
  busy,
  generation,
  selection,
  nativeCoverage,
  pageValue,
  earlierFlight,
  earlierAnchor,
  excludedIds,
  refreshWake,
  liveDelivery,
  scroll,
  readHistory,
  readBusy,
  setPage,
  setError,
  setLoadingEarlier,
  fail,
}: SessionHistoryBinding & {
  selected: string;
  busy: boolean;
  pageValue: RefObject<ConversationEventPage | undefined>;
  earlierFlight: RefObject<EarlierHistoryFlight | undefined>;
  earlierAnchor: RefObject<{ scope: EarlierHistoryFlight; restore: () => void } | undefined>;
  refreshWake: RefObject<number>;
  liveDelivery: RefObject<number>;
  scroll: RefObject<HTMLElement | null>;
  readHistory: ReturnType<typeof useSessionHistoryRead>;
  readBusy: (wake: number, generation?: number) => void;
  setPage: (page: SetStateAction<ConversationEventPage | undefined>) => void;
  setLoadingEarlier: (loading: boolean) => void;
}) {
  return async function earlier(turnId?: string) {
    const id = selected;
    const g = generation.current;
    const current = pageValue.current;
    const pagination = nativeCoverage.current.historyPagination;
    const historyCacheEpoch = nativeCoverage.current.historyCacheEpoch;
    const pending = earlierFlight.current;
    if (
      !current?.next_cursor ||
      !pagination ||
      busy ||
      selection.current !== id ||
      excludedIds.current.has(id) ||
      (turnId && turnId !== oldestIncompleteHistoryTurn(current, pagination)) ||
      (pending?.generation === g &&
        pending.pagination === pagination &&
        pending.cacheEpoch === historyCacheEpoch)
    )
      return;
    let rangeId = beginHistoryPagination(pagination, current.next_cursor)?.rangeId;
    if (rangeId === undefined) return;
    const scope = { generation: g, pagination, cacheEpoch: historyCacheEpoch };
    earlierFlight.current = scope;
    setLoadingEarlier(true);
    const wake = refreshWake.current;
    const stillCurrent = () =>
      g === generation.current &&
      selection.current === id &&
      !excludedIds.current.has(id) &&
      pagination === nativeCoverage.current.historyPagination &&
      historyCacheEpoch === nativeCoverage.current.historyCacheEpoch;
    const preserveScroll = () => {
      const viewport = scroll.current;
      if (!viewport || earlierAnchor.current?.scope === scope) return;
      const restore = captureHistoryScrollAnchor(viewport);
      earlierAnchor.current = {
        scope,
        restore: () => {
          if (stillCurrent() && scroll.current === viewport) restore();
        },
      };
    };
    let rebased = false;
    try {
      await loadEarlierHistoryBatch(
        current.next_cursor,
        current.events,
        async (cursor) => {
          if (!stillCurrent() || historyPaginationCursor(pagination) !== cursor) return;
          const ticket = beginHistoryPagination(pagination, cursor);
          if (!ticket || ticket.rangeId !== rangeId) return;
          const historyRead = await readHistory(id, g, historyCacheEpoch, cursor);
          if (!stillCurrent()) return;
          if (historyRead?.type === "stale-cursor") {
            if (rebased || historyPaginationCursor(pagination) !== cursor) return;
            rebased = true;
            const delivered = liveDelivery.current;
            const latest = await readHistory(id, g, historyCacheEpoch);
            if (
              !stillCurrent() ||
              latest?.type !== "page" ||
              !rebaseHistoryPagination(pagination, ticket, latest.page, latest.attempt.id)
            )
              return;
            const coverage = nativeCoverage.current;
            const hadHistoryError = coverage.historyRecoveryFailed;
            completeHistoryRead(coverage, latest.attempt);
            if (hadHistoryError) setError(!!coverage.historyRecoveryFailed);
            const nextCursor = historyPaginationCursor(pagination);
            rangeId = beginHistoryPagination(pagination, nextCursor)?.rangeId;
            preserveScroll();
            setPage((previous) => ({
              events: mergeNativeCoverage(
                mergeConversationItems(
                  mergeOrderedPersistedHistory(
                    previous?.events ?? [],
                    latest.page.events,
                    "latest",
                    coverage.preserveItemsOutsideCoverage,
                  ),
                  removePersistedOverlays(
                    previous?.events.filter(
                      (item) => delivered !== liveDelivery.current || item.ephemeral,
                    ) ?? [],
                    latest.page.events,
                    coverage.preserveItemsOutsideCoverage,
                  ),
                ),
                coverage,
              ),
              next_cursor: nextCursor,
              warnings: [
                ...new Set([
                  ...(previous?.warnings ?? []).filter(
                    (warning) => warning !== "TRANSCRIPT_SCAN_BUDGET",
                  ),
                  ...latest.page.warnings,
                ]),
              ],
            }));
            // The latest page sets a new cursor; the batch only counts earlier rows.
            return { events: [], next_cursor: nextCursor };
          }
          if (historyRead?.type === "busy") {
            if (!rebased) readBusy(wake, g);
            return;
          }
          if (historyRead?.type !== "page") return;
          const { page: older, attempt } = historyRead;
          const wasActiveCursor = historyPaginationCursor(pagination) === cursor;
          if (!applyHistoryPagination(pagination, ticket, older)) return;
          const nextCursor = historyPaginationCursor(pagination);
          const hadHistoryError = nativeCoverage.current.historyRecoveryFailed;
          completeHistoryRead(nativeCoverage.current, attempt);
          if (hadHistoryError) setError(!!nativeCoverage.current.historyRecoveryFailed);

          preserveScroll();
          setPage((latest) =>
            latest
              ? {
                  events: mergeNativeCoverage(
                    mergeConversationItems(
                      mergeOrderedPersistedHistory(
                        latest.events,
                        older.events,
                        "older",
                        nativeCoverage.current.preserveItemsOutsideCoverage,
                        ticket.beforeItemIds,
                        ticket.afterItemIds,
                      ),
                      removePersistedOverlays(
                        latest.events,
                        older.events,
                        nativeCoverage.current.preserveItemsOutsideCoverage,
                      ),
                    ),
                    nativeCoverage.current,
                  ),
                  next_cursor: nextCursor,
                  warnings: [
                    ...new Set([
                      ...older.warnings,
                      ...latest.warnings.filter(
                        (warning) => warning !== "TRANSCRIPT_SCAN_BUDGET" || !wasActiveCursor,
                      ),
                    ]),
                  ],
                }
              : {
                  ...older,
                  next_cursor: nextCursor,
                  events: mergeNativeCoverage(older.events, nativeCoverage.current),
                },
          );
          return {
            events: older.events,
            next_cursor: older.next_cursor === nextCursor ? nextCursor : undefined,
          };
        },
        turnId,
      );
    } catch (e) {
      if (stillCurrent()) fail(e, g);
    } finally {
      if (earlierFlight.current === scope) {
        earlierFlight.current = undefined;
        setLoadingEarlier(false);
      }
    }
  };
}
