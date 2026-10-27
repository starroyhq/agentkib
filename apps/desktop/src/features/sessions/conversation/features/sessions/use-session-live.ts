import { useEffect, type Dispatch, type SetStateAction, type RefObject } from "react";
import {
  ApiError,
  type Access,
  type ConversationEventPage,
  type ConversationEvent,
  type Live,
  type WebClient,
} from "@agentkib/web-client";
import {
  createConversationStore,
  mergeConversationItems,
  type SessionStreamEvent,
} from "@agentkib/conversation-state";
import { publishSessionInvalidation } from "./session-events";
import {
  beginHistoryRead,
  completeHistoryRead,
  failHistoryRead,
  mergeOrderedPersistedHistory,
  removePersistedOverlays,
  mergeNativeCoverage,
  type NativeCoverage,
} from "./session-model";
import { createHistoryPagination, recordLatestHistoryPage } from "./history-pagination";
type Setter<T> = Dispatch<SetStateAction<T>>;
// These fields cannot grant control or remove an execution/authorization fence.
// Unknown fields conservatively count as control boundaries.
// `permission` only describes the mode the CLI reports: it is shown to the user and neither
// grants nor revokes control, so a permission-only patch must not force a control re-read.
// `apiRetry` is the same kind of report: which request the CLI is retrying.
const nativeProgressFields = new Set([
  "revision",
  "streamText",
  "streamTextTruncated",
  "settings",
  "usage",
  "tokenUsage",
  "activity",
  "apiRetry",
  "goal",
  "permission",
]);
type ProgressPatch = Map<string, { value: unknown; revision: number }>;
const nativeRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
interface LiveSyncOptions {
  streamReady: RefObject<boolean>;
  controlReconciliationPending: RefObject<boolean>;
  nativeCoverage: RefObject<NativeCoverage>;
  streamEpoch: number;
  liveDelivery: RefObject<number>;
  access: Access | undefined;
  selected: string;
  selection: RefObject<string>;
  generation: RefObject<number>;
  client: WebClient;
  fail: (error: unknown, generation?: number) => void;
  readBusy: (wake: number, generation?: number) => void;
  refreshWake: RefObject<number>;
  clear: () => void;
  accessRef: RefObject<Access | undefined>;
  setLive: Setter<Live | undefined>;
  setOnline: Setter<boolean>;
  setError: Setter<boolean>;
  hasDurablePending: (sessionId: string) => boolean;
  readinessEpoch: RefObject<number>;
  refreshRequired: RefObject<boolean>;
  setControlReady: Setter<boolean>;
  setAccess: Setter<Access | undefined>;
  setPage: Setter<ConversationEventPage | undefined>;
  setLiveContentVersion?: Setter<number>;
  setUsageEpoch?: Setter<string>;
}
export function useSessionLive({
  streamReady,
  controlReconciliationPending,
  nativeCoverage,
  access,
  selected,
  selection,
  generation,
  client,
  fail,
  readBusy,
  refreshWake,
  clear,
  accessRef,
  setLive,
  setOnline,
  setError,
  hasDurablePending,
  readinessEpoch,
  refreshRequired,
  setControlReady,
  setAccess,
  setPage,
  streamEpoch,
  liveDelivery,
  setLiveContentVersion,
  setUsageEpoch,
}: LiveSyncOptions) {
  useEffect(() => {
    if (!selected || access?.status !== "approved" || access.protocolVersion !== 2) return;
    streamReady.current = false;
    controlReconciliationPending.current = false;
    const id = selected;
    const g = generation.current;
    const store = createConversationStore<Live>(id);
    let closed = false;
    let closeStream: (() => void) | undefined;
    let resets = 0;
    let resetPending = false;
    let connectionEpoch = 0;
    let itemGeneration = 0;
    let historyRequest = 0;
    let historyLoading = false;
    let historyDirty = false;
    let historyRetry: number | undefined;
    let historyRecoveryPending = false;
    let controlRequest = 0;
    let controlGeneration = 0;
    let progressPatch: ProgressPatch | undefined;
    let needsDomainRecovery = false;
    // Keep identities across a gap reset so an authoritative replacement can
    // remove the previously rendered native tail without touching older pages.
    let sourceItems: ConversationEvent[] = nativeCoverage.current.items;
    const current = () => !closed && g === generation.current && selection.current === id;
    const scheduleHistory = () => {
      window.clearTimeout(historyRetry);
      // Only an invalidated read waits for native updates to settle. Token
      // delivery by itself never schedules a historical read.
      historyRetry = window.setTimeout(() => {
        historyRetry = undefined;
        if (current() && historyDirty) loadHistory();
      }, 50);
    };
    const loadHistory = () => {
      historyLoading = true;
      historyDirty = false;
      const itemsAtRequest = itemGeneration;
      const request = historyRequest;
      const attempt = beginHistoryRead(nativeCoverage.current);
      const wake = refreshWake.current;
      void client
        .events(id)
        .then((page) => {
          if (!current()) return;
          // Completion can publish coverage after its history invalidation.
          // Preserve the newer native state and finish that read after it.
          if (request !== historyRequest || itemsAtRequest !== itemGeneration) {
            historyDirty = true;
            return;
          }
          const recovered = historyRecoveryPending;
          historyRecoveryPending = false;
          // A full refresh can apply a newer latest page while this read is
          // pending. Its history, cursor and warnings must remain one projection.
          if ((nativeCoverage.current.historyPagination?.latestReadOrder ?? 0) > attempt.id) return;
          const historyFailed = nativeCoverage.current.historyRecoveryFailed;
          const pagination = (nativeCoverage.current.historyPagination ??=
            createHistoryPagination());
          // Snapshot raw identities before registering this response. Rollback
          // can remove every displayed raw row without clearing the pager.
          const previousPersistedIds = new Set(pagination.persisted.keys());
          const nextCursor = recordLatestHistoryPage(pagination, page, attempt.id);
          completeHistoryRead(nativeCoverage.current, attempt);
          if (historyFailed && !nativeCoverage.current.historyRecoveryFailed) setError(false);
          setPage((old) => {
            const retained = removePersistedOverlays(
              old?.events ?? [],
              page.events,
              nativeCoverage.current.preserveItemsOutsideCoverage,
            );
            // Deleted rows and retired overlays cannot establish a baseline.
            // Surviving raw history keeps the existing latest-page ordering.
            const baseline = !retained.some((item) => previousPersistedIds.has(item.id));
            const ordered = mergeOrderedPersistedHistory(
              old?.events ?? [],
              page.events,
              baseline ? "older" : "latest",
              nativeCoverage.current.preserveItemsOutsideCoverage,
            );
            return {
              ...page,
              events: mergeNativeCoverage(
                recovered ? mergeConversationItems(ordered, retained) : ordered,
                nativeCoverage.current,
              ),
              next_cursor: nextCursor,
              warnings: [...new Set([...(old?.warnings ?? []), ...page.warnings])],
            };
          });
        })
        .catch((error) => {
          if (current() && request === historyRequest) {
            if (error instanceof ApiError && error.code === "operation_busy") {
              readBusy(wake, g);
              return;
            }
            // Live delivery proves connectivity, not that a failed history read
            // recovered. Keep its error until a history response is applied.
            if (
              (error instanceof DOMException && error.name === "AbortError") ||
              failHistoryRead(nativeCoverage.current, attempt)
            )
              fail(error, g);
          }
        })
        .finally(() => {
          historyLoading = false;
          if (current() && historyDirty) scheduleHistory();
        });
    };
    const readHistory = () => {
      historyRequest++;
      historyDirty = true;
      if (historyLoading) return;
      if (historyRetry !== undefined) scheduleHistory();
      else loadHistory();
    };
    const resync = () => {
      if (!current() || resetPending) return;
      setControlReady(false);
      streamReady.current = false;
      needsDomainRecovery = true;
      if (++resets > 3) {
        closeStream?.();
        setOnline(false);
        setError(true);
        return;
      }
      resetPending = true;
      itemGeneration++;
      queueMicrotask(() => {
        if (!current()) return;
        closeStream?.();
        store.reset();
        resetPending = false;
        connect();
      });
    };
    const connect = () => {
      const connection = ++connectionEpoch;
      const active = () => current() && connection === connectionEpoch;
      let snapshotSeen = false;
      let readyReconciled = false;
      const reconcileControls = () => {
        controlReconciliationPending.current = true;
        setControlReady(false);
        publishSessionInvalidation(client, id, ["receipts"]);
        const request = ++controlRequest;
        const wake = refreshWake.current;
        const boundary = controlGeneration;
        const progress: ProgressPatch = new Map();
        progressPatch = progress;
        void client
          .live(id)
          .then((live) => {
            if (!active() || request !== controlRequest) return;
            if (boundary !== controlGeneration) {
              // A changed owner, native control state or host fence requires a
              // fresh complete projection. Text/revision progress alone does not.
              reconcileControls();
              return;
            }
            progressPatch = undefined;
            controlReconciliationPending.current = false;
            const projected: Live & Record<string, unknown> = { ...live };
            // Preserve only native progress observed at/after this response's
            // revision. Never turn a null/unknown host projection into a usable
            // CAS version or overwrite its send/stop/approval permission gates.
            if (nativeRevision(live.revision) && live.status !== "outcome-unknown")
              for (const [field, patch] of progress)
                if (patch.revision >= live.revision) projected[field] = patch.value;
            const reconciled = store.replaceLive({
              ...projected,
              streamText: store.getSnapshot().streamText,
            });
            // Host control fences also supersede older full-refresh responses,
            // even when no native event advances the transport cursor.
            liveDelivery.current++;
            setLive(reconciled.live);
            if (streamReady.current) {
              setOnline(true);
              if (!nativeCoverage.current.historyRecoveryFailed) setError(false);
            }
            setControlReady(
              streamReady.current && !refreshRequired.current && !hasDurablePending(id),
            );
          })
          .catch((error) => {
            if (!active() || request !== controlRequest) return;
            if (error instanceof ApiError && error.code === "operation_busy") {
              progressPatch = undefined;
              controlReconciliationPending.current = false;
              readBusy(wake, g);
            } else fail(error, g);
          });
      };
      const disconnected = () => {
        needsDomainRecovery = true;
        snapshotSeen = false;
        readyReconciled = false;
        controlRequest++;
        progressPatch = undefined;
        streamReady.current = false;
        setOnline(false);
        setControlReady(false);
      };
      closeStream = client.stream(id, {
        open: () => {
          // Delivery readiness comes from a valid baseline/replay, never merely
          // from an open TCP connection.
          if (!active()) return;
          setOnline(true);
        },
        error: (error) => {
          if (!active()) return;
          disconnected();
          if (error instanceof ApiError && error.code === "incompatible_protocol") fail(error, g);
        },
        event: (type, data) => {
          if (!active() || resetPending) return false;
          if (type === "access-ended") {
            if (client.connection.type === "lan-http") client.reset();
            clear();
            accessRef.current = {
              status: "ended",
              csrfToken: "",
              bootId: "",
              experimentalEnabled: false,
            };
            setAccess(accessRef.current);
            return;
          }
          if (type === "unavailable") {
            disconnected();
            return;
          }
          if (type === "session-ready") {
            try {
              const ready = JSON.parse(data) as { cursor?: string };
              const state = store.getSnapshot();
              if (
                state.live &&
                state.cursor &&
                state.cursor === ready.cursor &&
                !state.resyncRequired
              ) {
                // A baseline alone is not proof that the stream caught up. Only
                // matching readiness ends a consecutive recovery failure streak.
                resets = 0;
                if (needsDomainRecovery && snapshotSeen)
                  // An expired cursor replaces missed invalidations with a
                  // baseline. Refresh mounted detail consumers once, not history.
                  publishSessionInvalidation(client, id, [
                    "queue",
                    "settings",
                    "goal",
                    "usage",
                    "capabilities",
                  ]);
                needsDomainRecovery = false;
                setOnline(true);
                if (!nativeCoverage.current.historyRecoveryFailed) setError(false);
                streamReady.current = true;
                if (!snapshotSeen && !readyReconciled) {
                  readyReconciled = true;
                  setControlReady(false);
                  // Out-of-band control fences are not part of replay. Reconcile
                  // once after a replay-only reconnect, without reloading history.
                  reconcileControls();
                } else if (snapshotSeen)
                  setControlReady(
                    !controlReconciliationPending.current &&
                      !refreshRequired.current &&
                      !hasDurablePending(id),
                  );
                return state.cursor;
              }
            } catch {
              /* A malformed readiness marker cannot enable controls. */
            }
            return false;
          }
          if (type === "control-changed") {
            try {
              const changed = JSON.parse(data) as { sessionId?: string };
              if (changed.sessionId !== id) return false;
              reconcileControls();
            } catch {
              return false;
            }
            return false;
          }
          if (type !== "session-event") return false;
          try {
            const event = JSON.parse(data) as SessionStreamEvent<Live>;
            if (event.sessionId !== id) return false;
            const previous = store.getSnapshot();
            const next = store.dispatch(event);
            if (next.resyncRequired) {
              resync();
              return false;
            }
            if (next === previous) return next.cursor ?? false;
            const historyCacheEpoch =
              event.type === "snapshot" ? event.payload.historyCacheEpoch : undefined;
            const resetHistory =
              historyCacheEpoch !== undefined &&
              historyCacheEpoch !== nativeCoverage.current.historyCacheEpoch;
            if (resetHistory) {
              // Deletion records are bounded. A new cache epoch makes the old
              // pages unsafe, including after missing the overflow notification.
              nativeCoverage.current = {
                items: [],
                authoritativeTurnIds: [],
                removedTurnIds: [],
                historyCacheEpoch,
                historyRecoveryFailed: nativeCoverage.current.historyRecoveryFailed,
              };
              sourceItems = [];
              historyRequest++;
              itemGeneration++;
              historyRecoveryPending = true;
              setPage(undefined);
            }
            liveDelivery.current++;
            if (
              event.type !== "snapshot" &&
              (next.items !== previous.items || next.streamText !== previous.streamText)
            )
              setLiveContentVersion?.((version) => version + 1);
            if (event.type === "snapshot") {
              controlGeneration++;
              controlRequest++;
              progressPatch = undefined;
              controlReconciliationPending.current = false;
            } else if (event.type === "state") {
              const before = previous.live as (Live & Record<string, unknown>) | undefined;
              const revision = next.live?.revision;
              for (const [field, value] of Object.entries(event.payload)) {
                if (JSON.stringify(before?.[field]) === JSON.stringify(value)) continue;
                if (!nativeProgressFields.has(field)) controlGeneration++;
                else if (nativeRevision(revision)) progressPatch?.set(field, { value, revision });
              }
              // A revision reset can represent a replacement native owner even
              // before the rest of its control fields have changed.
              if (
                nativeRevision(before?.revision) &&
                (!nativeRevision(revision) || revision < before.revision)
              )
                controlGeneration++;
            }
            if (next.live) {
              if (event.type === "snapshot") {
                setUsageEpoch?.(JSON.stringify([next.runtimeBootId, next.epoch]));
                streamReady.current = true;
                snapshotSeen = true;
              }
              setLive({ ...next.live, streamText: next.streamText });
              setOnline(true);
              if (!nativeCoverage.current.historyRecoveryFailed) setError(false);
              setControlReady(
                streamReady.current &&
                  !controlReconciliationPending.current &&
                  !refreshRequired.current &&
                  !hasDurablePending(id),
              );
            }
            if (next.items !== previous.items) {
              if (event.type !== "snapshot" || next.cursor !== previous.cursor) itemGeneration++;
              if (historyRetry !== undefined) scheduleHistory();
              const replace = event.type === "snapshot" && event.payload.replaceItems === true;
              const preserveOutsideCoverage =
                event.type === "snapshot" && event.payload.preserveItemsOutsideCoverage === true;
              const removedTurns = new Set(
                event.type === "snapshot" ? (event.payload.removedTurnIds ?? []) : [],
              );
              const replacedIds = new Set(replace ? sourceItems.map((item) => item.id) : []);
              sourceItems = next.items;
              nativeCoverage.current = {
                items: next.items,
                authoritativeTurnIds:
                  event.type === "snapshot"
                    ? (event.payload.authoritativeTurnIds ?? [])
                    : nativeCoverage.current.authoritativeTurnIds,
                removedTurnIds: [
                  ...new Set([...nativeCoverage.current.removedTurnIds, ...removedTurns]),
                ],
                removedItemIds: [
                  ...new Set([
                    ...(nativeCoverage.current.removedItemIds ?? []),
                    ...(event.type === "snapshot" ? (event.payload.removedItemIds ?? []) : []),
                  ]),
                ],
                preserveItemsOutsideCoverage:
                  event.type === "snapshot"
                    ? preserveOutsideCoverage
                    : nativeCoverage.current.preserveItemsOutsideCoverage,
                historyCacheEpoch: nativeCoverage.current.historyCacheEpoch,
                historyRecoveryFailed: nativeCoverage.current.historyRecoveryFailed,
                historyReads: nativeCoverage.current.historyReads,
                historyPagination: nativeCoverage.current.historyPagination,
              };
              if (next.items.length || replace)
                setPage((page) => ({
                  events: mergeNativeCoverage(
                    (page?.events ?? []).filter(
                      (item) =>
                        (!item.turn_id || !removedTurns.has(item.turn_id)) &&
                        (!replace ||
                          preserveOutsideCoverage ||
                          (!item.ephemeral && !replacedIds.has(item.id))),
                    ),
                    nativeCoverage.current,
                  ),
                  next_cursor: page?.next_cursor,
                  warnings: page?.warnings ?? [],
                }));
            }
            if (resetHistory) readHistory();
            if (event.type === "invalidate") {
              publishSessionInvalidation(client, id, event.payload.domains);
              // History is fetched only when its authoritative index reports a
              // change; token delivery never causes a historical page reload.
              if (event.payload.domains.includes("history")) readHistory();
              store.clearInvalidations();
            }
            return next.cursor ?? false;
          } catch {
            resync();
            return false;
          }
        },
      });
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(historyRetry);
      streamReady.current = false;
      setControlReady(false);
      closeStream?.();
    };
  }, [
    selected,
    access?.status,
    access?.protocolVersion,
    client,
    clear,
    fail,
    accessRef,
    setAccess,
    setLive,
    setOnline,
    setError,
    hasDurablePending,
    readinessEpoch,
    refreshRequired,
    setControlReady,
    setPage,
    setLiveContentVersion,
    selection,
    generation,
    streamEpoch,
    liveDelivery,
    readBusy,
    refreshWake,
    streamReady,
    controlReconciliationPending,
    nativeCoverage,
  ]);
}
