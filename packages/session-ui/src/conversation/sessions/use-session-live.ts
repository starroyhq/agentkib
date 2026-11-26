import { useEffect, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import {
  ApiError,
  conversationReconnectDelay,
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
  publishSessionInvalidation,
  beginHistoryRead,
  completeHistoryRead,
  failHistoryRead,
  mergeOrderedPersistedHistory,
  removePersistedOverlays,
  mergeNativeCoverage,
  type NativeCoverage,
  createHistoryPagination,
  recordLatestHistoryPage,
} from "@agentkib/conversation-state";
import { checkLiveSession, retryBusyRead } from "../../session-read-retry";
import { warmSessionAuthority, type WarmSessionStreamPool } from "../../warm-session-stream";
type Setter<T> = Dispatch<SetStateAction<T>>;
// These fields cannot grant control or remove an execution/authorization fence.
// Unknown fields conservatively count as control boundaries.
// `permission` only describes the mode the CLI reports: it is shown to the user and neither
// grants nor revokes control, so a permission-only patch must not force a control re-read.
// `apiRetry` and `turnStartError` also report what the CLI observed without changing controls.
const nativeProgressFields = new Set([
  "revision",
  "streamText",
  "streamTextTruncated",
  "settings",
  "usage",
  "tokenUsage",
  "activity",
  "apiRetry",
  "turnStartError",
  "goal",
  "permission",
]);
type ProgressPatch = Map<string, { value: unknown; revision: number }>;
const nativeRevision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
export type WarmSessionNavigation = {
  park?: (nextId?: string) => void;
  resume?: { generation: number; onCold: () => void };
};
type SettingsWrite = { sessionId: string; generation: number; controlChanged?: boolean };
type ReadSettingsControls = RefObject<
  ((sessionId: string, accept?: (live: Live) => boolean) => Promise<void>) | undefined
>;
interface LiveSyncOptions {
  surface: "desktop" | "web";
  settingsInFlight?: RefObject<SettingsWrite | undefined>;
  readSettingsControls?: ReadSettingsControls;
  isSettingsWriteActive?: (sessionId: string) => boolean;
  warmStreams: WarmSessionStreamPool;
  warmScope?: string;
  warmNavigation: RefObject<WarmSessionNavigation>;
  selectionVisit?: number;
  liveValue: RefObject<Live | undefined>;
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
  surface,
  warmStreams,
  warmScope,
  warmNavigation,
  selectionVisit,
  liveValue,
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
  settingsInFlight,
  readSettingsControls,
  isSettingsWriteActive,
}: LiveSyncOptions) {
  const desktop = surface === "desktop";
  const [retryingSession, setRetryingSession] = useState<string>();
  useEffect(() => {
    if (!selected || access?.status !== "approved" || access.protocolVersion !== 2) return;
    streamReady.current = false;
    controlReconciliationPending.current = false;
    const id = selected;
    const g = generation.current;
    let store = createConversationStore<Live>(id);
    const resume =
      warmNavigation.current.resume?.generation === g ? warmNavigation.current.resume : undefined;
    if (resume) warmNavigation.current.resume = undefined;
    let closed = false;
    let closeStream: (() => void) | undefined;
    let resets = 0;
    let consecutiveRestarts = 0;
    let readyAt: number | undefined;
    let resetPending = false;
    let resetTimer: number | undefined;
    let connectionEpoch = 0;
    let itemGeneration = 0;
    let historyRequest = 0;
    let historyLoading = false;
    let historyDirty = false;
    let historyRetry: number | undefined;
    let historyRecoveryPending = false;
    let historyWaitingForSettings = false;
    let webSettingsHistory: "waiting" | "retry" | undefined;
    let settingsHistoryWake = 0;
    let controlRequest = 0;
    let controlGeneration = 0;
    let progressPatch: ProgressPatch | undefined;
    let needsDomainRecovery = false;
    // Keep identities across a gap reset so an authoritative replacement can
    // remove the previously rendered native tail without touching older pages.
    let sourceItems: ConversationEvent[] = nativeCoverage.current.items;
    const current = () => !closed && g === generation.current && selection.current === id;
    const selectedSettingsWrite = () => {
      const write = settingsInFlight?.current;
      return write?.sessionId === id && write.generation === g ? write : undefined;
    };
    let historyRetriedForWrite: SettingsWrite | undefined;
    const waitingForSettings = () => historyWaitingForSettings || webSettingsHistory === "waiting";
    const scheduleHistory = () => {
      if (historyWaitingForSettings) return;
      window.clearTimeout(historyRetry);
      // Only an invalidated read waits for native updates to settle. Token
      // delivery by itself never schedules a historical read.
      historyRetry = window.setTimeout(() => {
        historyRetry = undefined;
        if (current() && historyDirty) loadHistory();
      }, 50);
    };
    const wakeSettingsHistory = () => {
      settingsHistoryWake++;
      if (!waitingForSettings()) return;
      if (desktop) historyWaitingForSettings = false;
      else webSettingsHistory = "retry";
      if (!historyLoading && historyDirty) scheduleHistory();
    };
    const loadHistory = () => {
      historyLoading = true;
      historyDirty = false;
      const itemsAtRequest = itemGeneration;
      const request = historyRequest;
      const attempt = beginHistoryRead(nativeCoverage.current);
      const wake = refreshWake.current;
      const settingsWakeAtRead = settingsHistoryWake;
      const writeAtRead = selectedSettingsWrite();
      const retryAfterSettings = webSettingsHistory === "retry";
      webSettingsHistory = undefined;
      const duringSettings = isSettingsWriteActive?.(id);
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
              if (desktop) {
                const activeWrite = selectedSettingsWrite();
                const write = activeWrite ?? writeAtRead;
                if (write && historyRetriedForWrite !== write) {
                  // Keep the invalidation when the native write still holds admission.
                  historyRetriedForWrite = write;
                  historyDirty = true;
                  historyWaitingForSettings =
                    !!activeWrite &&
                    !activeWrite.controlChanged &&
                    settingsWakeAtRead === settingsHistoryWake;
                  return;
                }
              } else if (!retryAfterSettings && (duringSettings || isSettingsWriteActive?.(id))) {
                historyDirty = true;
                webSettingsHistory =
                  settingsWakeAtRead === settingsHistoryWake ? "waiting" : "retry";
                return;
              }
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
          if (current() && historyDirty && webSettingsHistory !== "waiting") scheduleHistory();
        });
    };
    const readHistory = () => {
      historyRequest++;
      historyDirty = true;
      if (historyLoading || waitingForSettings()) return;
      if (historyRetry !== undefined) scheduleHistory();
      else loadHistory();
    };
    const resync = () => {
      if (!current() || resetPending) return;
      setControlReady(false);
      streamReady.current = false;
      needsDomainRecovery = true;
      connectionEpoch++;
      if (++resets > 3) {
        closeStream?.();
        setRetryingSession(undefined);
        setOnline(false);
        setError(true);
        return;
      }
      if (readyAt !== undefined && Date.now() - readyAt >= 10_000) consecutiveRestarts = 0;
      readyAt = undefined;
      const retryDelay = conversationReconnectDelay(consecutiveRestarts++, 500, 10_000);
      setRetryingSession(id);
      setOnline(false);
      resetPending = true;
      itemGeneration++;
      queueMicrotask(() => {
        if (!current()) return;
        closeStream?.();
        // Release the failed lease before waiting. Other sessions retain their streams.
        resetTimer = window.setTimeout(() => {
          resetTimer = undefined;
          if (!current()) return;
          store.reset();
          resetPending = false;
          connect();
        }, retryDelay);
      });
    };
    const connect = (warmReturn?: typeof resume) => {
      const scope = warmScope ?? "";
      let lease = warmStreams.claim(scope, id);
      if (lease.checkpoint && !warmReturn) {
        lease.release();
        lease = warmStreams.claim(scope, id);
      }
      const checkpoint = lease.checkpoint;
      if (checkpoint) {
        store = createConversationStore(id, checkpoint.state);
        nativeCoverage.current = checkpoint.coverage;
        sourceItems = checkpoint.coverage.items;
        setUsageEpoch?.(JSON.stringify([checkpoint.state.runtimeBootId, checkpoint.state.epoch]));
        setPage((page) => page);
      } else warmReturn?.onCold();
      closeStream = () => lease.release();
      warmNavigation.current.park = (nextId) => {
        const projection = liveValue.current;
        const coverage = nativeCoverage.current;
        if (
          !active() ||
          !warmScope ||
          warmScope !== warmSessionAuthority(accessRef.current, streamEpoch) ||
          !streamReady.current ||
          controlReconciliationPending.current ||
          refreshRequired.current ||
          hasDurablePending(id) ||
          historyLoading ||
          historyDirty ||
          historyRecoveryPending ||
          !coverage.historyPagination ||
          coverage.historyRecoveryFailed ||
          projection?.sessionId !== id
        )
          return;
        const accepted = store.replaceLive(projection);
        if (accepted.live && accepted.cursor)
          lease.release({ state: accepted, coverage }, desktop ? nextId : undefined);
      };
      const connection = ++connectionEpoch;
      const active = () => current() && connection === connectionEpoch;
      let snapshotSeen = !!checkpoint;
      let readyReconciled = false;
      const reconcileControls = (
        quiet = false,
        accept?: (live: Live) => boolean,
      ): Promise<void> => {
        const settingsRead = quiet || (!desktop && isSettingsWriteActive?.(id));
        if (!settingsRead) {
          controlReconciliationPending.current = true;
          setControlReady(false);
        }
        if (!quiet) publishSessionInvalidation(client, id, ["receipts"]);
        const request = ++controlRequest;
        const wake = refreshWake.current;
        const boundary = controlGeneration;
        const readiness = readinessEpoch.current;
        const currentResponse = () => {
          if (!active() || request !== controlRequest) return false;
          if (!quiet || readiness === readinessEpoch.current) return true;
          // A newer refresh owns readiness. This quiet read may not replace its projection.
          progressPatch = undefined;
          controlReconciliationPending.current = false;
          return false;
        };
        const progress: ProgressPatch = new Map();
        progressPatch = progress;
        return (settingsRead ? retryBusyRead(() => client.live(id)) : client.live(id))
          .then((live) => {
            if (!currentResponse()) return;
            if (boundary !== controlGeneration) {
              // A changed owner, native control state or host fence requires a
              // fresh complete projection. Text/revision progress alone does not.
              return reconcileControls(quiet, accept);
            }
            progressPatch = undefined;
            controlReconciliationPending.current = false;
            checkLiveSession(live, id);
            if (accept && !accept(live)) {
              setControlReady(false);
              return;
            }
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
              streamReady.current &&
                !refreshRequired.current &&
                reconciled.live?.status !== "outcome-unknown",
            );
          })
          .catch((error) => {
            if (!currentResponse()) return;
            if (settingsRead) {
              progressPatch = undefined;
              controlReconciliationPending.current = false;
              setControlReady(false);
              // The write has settled. A failed read cannot make its receipt unknown.
              if (error instanceof ApiError && [401, 403].includes(error.status)) fail(error, g);
              return;
            }
            if (error instanceof ApiError && error.code === "operation_busy") {
              progressPatch = undefined;
              controlReconciliationPending.current = false;
              readBusy(wake, g);
            } else fail(error, g);
          });
      };
      if (readSettingsControls) {
        readSettingsControls.current = async (sessionId, accept) => {
          if (sessionId !== id || !active()) return;
          if (!desktop) wakeSettingsHistory();
          await reconcileControls(true, accept);
          if (desktop && active()) wakeSettingsHistory();
        };
      }
      const disconnected = () => {
        needsDomainRecovery = true;
        if (readyAt !== undefined && Date.now() - readyAt >= 10_000) consecutiveRestarts = 0;
        readyAt = undefined;
        snapshotSeen = false;
        readyReconciled = false;
        controlRequest++;
        progressPatch = undefined;
        streamReady.current = false;
        setOnline(false);
        setControlReady(false);
      };
      const started = lease.start({
        // Transport open alone gives no proof that the selected data is current.
        open: () => {},
        error: (error) => {
          if (!active()) return;
          disconnected();
          if (desktop && error instanceof ApiError && error.code === "stream_limit")
            warmStreams.discardParked();
          if (error instanceof ApiError && error.code === "incompatible_protocol") {
            setRetryingSession(undefined);
            fail(error, g);
          } else setRetryingSession(id);
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
            setRetryingSession(id);
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
                readyAt ??= Date.now();
                if (needsDomainRecovery && snapshotSeen)
                  // An expired cursor replaces missed invalidations with a
                  // baseline. Refresh mounted detail consumers once, not history.
                  publishSessionInvalidation(client, id, [
                    "queue",
                    "settings",
                    "goal",
                    "usage",
                    "capabilities",
                    "receipts",
                  ]);
                needsDomainRecovery = false;
                if (!desktop || !selectedSettingsWrite()) wakeSettingsHistory();
                setRetryingSession(undefined);
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
                      state.live.status !== "outcome-unknown",
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
              if (!desktop) wakeSettingsHistory();
              const write = selectedSettingsWrite();
              if (write) write.controlChanged = true;
              else void reconcileControls();
              if (desktop) wakeSettingsHistory();
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
                  next.live.status !== "outcome-unknown",
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
      if (!started && checkpoint && current()) {
        nativeCoverage.current = { items: [], authoritativeTurnIds: [], removedTurnIds: [] };
        sourceItems = [];
        store.reset();
        warmReturn?.onCold();
        connect();
      }
    };
    connect(resume);
    return () => {
      closed = true;
      setRetryingSession((retrying) => (retrying === id ? undefined : retrying));
      warmNavigation.current.park = undefined;
      if (readSettingsControls) readSettingsControls.current = undefined;
      window.clearTimeout(historyRetry);
      window.clearTimeout(resetTimer);
      streamReady.current = false;
      setControlReady(false);
      closeStream?.();
    };
  }, [
    selected,
    warmStreams,
    warmScope,
    warmNavigation,
    selectionVisit,
    liveValue,
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
    desktop,
    settingsInFlight,
    readSettingsControls,
    isSettingsWriteActive,
  ]);
  return retryingSession === selected;
}
