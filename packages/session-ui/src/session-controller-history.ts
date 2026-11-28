import { useCallback, useState, type RefObject, type SetStateAction } from "react";
import {
  ApiError,
  conversationHistoryFailure,
  REMOTE_ERROR_CODES,
  type ConversationEventPage,
  type ConversationHistoryFailure,
  type WebClient,
} from "@agentkib/web-client";
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
  mergeLatestHistoryWarnings,
  mergeNativeCoverage,
  mergeOrderedPersistedHistory,
  oldestIncompleteHistoryTurn,
  rebaseHistoryPagination,
  removePersistedOverlays,
  type NativeCoverage,
  type HistoryReadAttempt,
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

function invalidatesAccess(error: ApiError) {
  return (
    error.status === 401 ||
    error.status === 403 ||
    error.code === REMOTE_ERROR_CODES.accessEnded ||
    error.code === REMOTE_ERROR_CODES.accessChanged ||
    error.code === REMOTE_ERROR_CODES.staleBoot ||
    error.code === "incompatible_protocol"
  );
}

export function useSessionHistoryRead({
  client,
  excludedIds,
  generation,
  selection,
  nativeCoverage,
  setError,
  fail,
}: SessionHistoryBinding & { client: WebClient }) {
  const [notice, setNotice] = useState<{
    generation: number;
    cacheEpoch: string | undefined;
    failure: ConversationHistoryFailure;
  }>();
  const failed = useCallback(
    (error: unknown, attempt: HistoryReadAttempt, g: number) => {
      const coverage = nativeCoverage.current;
      if (
        g !== generation.current ||
        (error instanceof DOMException && error.name === "AbortError") ||
        !failHistoryRead(coverage, attempt)
      )
        return false;
      const failure = conversationHistoryFailure(error);
      setNotice({ generation: g, cacheEpoch: coverage.historyCacheEpoch, failure });
      setError(true);
      // A transcript error cannot invalidate a healthy live stream or its controls.
      if (error instanceof ApiError && invalidatesAccess(error)) {
        fail(error, g);
        return "access";
      }
      return "history";
    },
    [fail, generation, nativeCoverage, setError],
  );
  const complete = useCallback((coverage: NativeCoverage, attempt: HistoryReadAttempt) => {
    if (coverage.historyReads !== attempt.state) return;
    completeHistoryRead(coverage, attempt);
    if (!coverage.historyRecoveryFailed) setNotice(undefined);
  }, []);
  const read = useCallback(
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
          if (error instanceof ApiError && error.code === REMOTE_ERROR_CODES.operationBusy)
            return { type: "busy" as const, error, attempt };
          const { reason } = conversationHistoryFailure(error);
          if (
            cursor &&
            !(error instanceof ApiError && invalidatesAccess(error)) &&
            (reason === REMOTE_ERROR_CODES.staleCursor ||
              reason === REMOTE_ERROR_CODES.transcriptCursorStale)
          )
            return { type: "stale-cursor" as const, error, attempt };
          const failure = failed(error, attempt, g);
          if (failure === "history") return { type: "failed" as const };
          if (!failure && hasAppliedNewerHistory(nativeCoverage.current, attempt)) {
            // A newer applied history read already satisfied this refresh. Keep
            // its completion distinct from an unresolved or out-of-scope failure.
            return { type: "superseded" as const, attempt };
          }
        }
        return undefined;
      }
    },
    [client, excludedIds, generation, selection, nativeCoverage, failed],
  );
  const failure =
    notice?.generation === generation.current &&
    notice?.cacheEpoch === nativeCoverage.current.historyCacheEpoch
      ? notice.failure
      : undefined;
  return { read, failed, complete, failure };
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
  history,
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
  history: ReturnType<typeof useSessionHistoryRead>;
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
          const historyRead = await history.read(id, g, historyCacheEpoch, cursor);
          if (!stillCurrent()) return;
          if (historyRead?.type === "stale-cursor") {
            if (historyPaginationCursor(pagination) !== cursor) return;
            if (rebased) {
              history.failed(historyRead.error, historyRead.attempt, g);
              return;
            }
            rebased = true;
            const delivered = liveDelivery.current;
            const latest = await history.read(id, g, historyCacheEpoch);
            if (stillCurrent() && latest?.type === "busy")
              history.failed(latest.error, latest.attempt, g);
            if (
              !stillCurrent() ||
              latest?.type !== "page" ||
              !rebaseHistoryPagination(pagination, ticket, latest.page, latest.attempt.id)
            )
              return;
            const coverage = nativeCoverage.current;
            const hadHistoryError = coverage.historyRecoveryFailed;
            history.complete(coverage, latest.attempt);
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
              warnings: mergeLatestHistoryWarnings(
                previous?.warnings.filter((warning) => warning !== "TRANSCRIPT_SCAN_BUDGET"),
                latest.page.warnings,
              ),
            }));
            // The latest page sets a new cursor; the batch only counts earlier rows.
            return { events: [], next_cursor: nextCursor };
          }
          if (historyRead?.type === "busy") {
            if (!rebased) readBusy(wake, g);
            else history.failed(historyRead.error, historyRead.attempt, g);
            return;
          }
          if (historyRead?.type !== "page") return;
          const { page: older, attempt } = historyRead;
          const wasActiveCursor = historyPaginationCursor(pagination) === cursor;
          if (!applyHistoryPagination(pagination, ticket, older)) return;
          const nextCursor = historyPaginationCursor(pagination);
          const hadHistoryError = nativeCoverage.current.historyRecoveryFailed;
          history.complete(nativeCoverage.current, attempt);
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
