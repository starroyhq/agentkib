import { desktopReadScope, subscribeDesktopReadScope } from "./read-state-scope";
import { isBusyRead, retryBusyRead } from "./conversation/features/sessions/session-read-retry";
import { useEffect } from "react";
import { create } from "zustand";
import { ApiError, type ConversationCatalog } from "@agentkib/web-client";
import { createConversationStore, type SessionStreamEvent } from "@agentkib/conversation-state";
import {
  createDesktopConversationAdapter,
  desktopConversationRequest,
  hasDesktopConversation,
  type DesktopConversationBridge,
} from "@/core/conversation-bridge";
import type { ConversationSessionSummary } from "@/core/types";
import {
  isStaleCatalogRead,
  mergeCatalogSessions,
  retryStaleCatalogRead,
  SESSION_CATALOG_RUNTIME_CHANGED,
  type IncompleteSessionSource,
} from "./session-query";

interface ConversationCatalogState {
  sessions: ConversationSessionSummary[];
  ready: boolean;
  usable: boolean;
  refreshing: boolean;
  accessDenied: boolean;
  complete?: boolean;
  incompleteSources?: IncompleteSessionSource[];
  error?: unknown;
  codexRuntimeReason?: ConversationCatalog["codexRuntimeReason"];
}

const useConversationCatalogStore = create<ConversationCatalogState>(() => ({
  sessions: [],
  ready: false,
  usable: false,
  refreshing: false,
  accessDenied: false,
}));
let generation = 0;
let invalidation = 0;
let pending: Promise<ConversationSessionSummary[]> | undefined;
let waitingForSettlement = false;
let observationError: unknown;
let retryObservation: (() => void) | undefined;
let catalogObservers = 0;
let stopCatalogObservation: (() => void) | undefined;
let stopReadScope: (() => void) | undefined;
let cacheBridge: DesktopConversationBridge | undefined;
let scheduledRefresh: ReturnType<typeof setTimeout> | undefined;
let cacheBootId: string | undefined;
const emptySessions: ConversationSessionSummary[] = [];

function resetConversationCatalog() {
  generation += 1;
  pending = undefined;
  waitingForSettlement = false;
  observationError = undefined;
  cacheBootId = undefined;
  if (scheduledRefresh) clearTimeout(scheduledRefresh);
  scheduledRefresh = undefined;
  useConversationCatalogStore.setState({
    sessions: emptySessions,
    ready: false,
    usable: false,
    refreshing: false,
    accessDenied: false,
    complete: undefined,
    incompleteSources: undefined,
    error: undefined,
    codexRuntimeReason: undefined,
  });
}

function keepCatalogScope() {
  if (stopReadScope) return;
  stopReadScope = subscribeDesktopReadScope(() => {
    // Local history remains readable on this computer. Only account-owned
    // receipts and obsolete responses must disappear at the identity boundary.
    generation++;
    invalidation++;
    pending = undefined;
    waitingForSettlement = false;
    observationError = undefined;
    useConversationCatalogStore.setState((current) => ({
      sessions: mergeCatalogSessions(
        current.sessions,
        current.sessions.map((session) =>
          session.readState ? { ...session, readState: undefined } : session,
        ),
      ),
      ready: false,
      refreshing: false,
      error: undefined,
    }));
    if (catalogObservers && desktopReadScope().ready) scheduleCatalogRefresh();
  });
}

function scheduleCatalogRefresh() {
  invalidation++;
  useConversationCatalogStore.setState({ ready: false });
  if (pending || scheduledRefresh || !catalogObservers) return;
  scheduledRefresh = setTimeout(() => {
    scheduledRefresh = undefined;
    void refreshConversationCatalog().catch(() => {});
  }, 40);
}

export function refreshConversationCatalog(): Promise<ConversationSessionSummary[]> {
  if (!hasDesktopConversation()) return Promise.resolve([]);
  const bridge = window.desktopConversation;
  if (bridge !== cacheBridge) {
    resetConversationCatalog();
    stopReadScope?.();
    stopReadScope = undefined;
    cacheBridge = bridge;
  }
  retryObservation?.();
  invalidation++;
  if (pending) return pending;
  if (scheduledRefresh) clearTimeout(scheduledRefresh);
  scheduledRefresh = undefined;
  useConversationCatalogStore.setState({ ready: false, refreshing: true });
  const request = generation;
  let blockedVersion: number | undefined;
  const task = (async () => {
    while (true) {
      const version = invalidation;
      let catalog: ConversationCatalog;
      try {
        catalog = await retryStaleCatalogRead(() =>
          retryBusyRead(() => desktopConversationRequest<ConversationCatalog>("catalog")),
        );
      } catch (error) {
        if (generation === request && (isBusyRead(error) || isStaleCatalogRead(error))) {
          waitingForSettlement = true;
          blockedVersion = version;
          // Settlement can arrive before the rejected read returns. Consume that
          // notification once; otherwise wait without turning contention into an error.
          if (version !== invalidation) continue;
        }
        throw error;
      }
      const sessions: ConversationSessionSummary[] = catalog.sessions.map((session) => ({
        ...session,
        readState: desktopReadScope().ready ? session.readState : undefined,
        indexedSessionIds:
          session.indexedSessionIds ??
          (session.indexedSessionId ? [session.indexedSessionId] : undefined),
        created_at: session.created_at ?? undefined,
        git_branch: session.git_branch ?? undefined,
        forked_from_session_id: session.forked_from_session_id ?? undefined,
        spawned_by_session_id: session.spawned_by_session_id ?? undefined,
        worktree: session.worktree ?? undefined,
      }));
      if (generation !== request) return useConversationCatalogStore.getState().sessions;
      if (version !== invalidation) continue;
      const current = useConversationCatalogStore.getState();
      const incompleteSources = catalog.incompleteSources ?? [];
      const next = mergeCatalogSessions(
        current.sessions,
        sessions,
        incompleteSources,
        catalog.complete === false && !catalog.incompleteSources?.length,
      );
      const usable = catalog.complete !== false || current.usable || next.length > 0;
      useConversationCatalogStore.setState({
        sessions: next,
        usable,
        ready: version === invalidation && usable,
        accessDenied: false,
        complete: catalog.complete !== false,
        incompleteSources,
        error: observationError,
        codexRuntimeReason: catalog.codexRuntimeReason,
      });
      if (version === invalidation) {
        waitingForSettlement = false;
        // A successful one-off read does not prove the live subscription recovered.
        return next;
      }
      // A create/fork or invalidation arrived during this fetch. Its caller must
      // receive the fresh catalog, not the response captured before the mutation.
    }
  })()
    .catch((error: unknown) => {
      if (
        generation === request &&
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      ) {
        resetConversationCatalog();
        useConversationCatalogStore.setState({ accessDenied: true, error });
        throw error;
      }
      if (generation === request && !isBusyRead(error) && !isStaleCatalogRead(error)) {
        waitingForSettlement = false;
        useConversationCatalogStore.setState({ ready: false, error });
      }
      throw error;
    })
    .finally(() => {
      if (pending !== task) return;
      pending = undefined;
      useConversationCatalogStore.setState({ refreshing: false });
      // Also cover a notification delivered between the rejection and cleanup.
      if (generation === request && waitingForSettlement && blockedVersion !== invalidation)
        void refreshConversationCatalog().catch(() => {});
    });
  pending = task;
  return task;
}

function releaseCatalogObserver() {
  catalogObservers -= 1;
  if (catalogObservers > 0) return;
  stopCatalogObservation?.();
  stopCatalogObservation = undefined;
  if (scheduledRefresh) clearTimeout(scheduledRefresh);
  scheduledRefresh = undefined;
}

/** Includes managed tasks before they have appeared in the native history index. */
export function useConversationCatalog(enabled: boolean, indexEnabled = enabled) {
  const state = useConversationCatalogStore();
  const bridge = globalThis.window?.desktopConversation;
  useEffect(() => {
    if (bridge !== cacheBridge) {
      resetConversationCatalog();
      stopReadScope?.();
      stopReadScope = undefined;
      cacheBridge = bridge;
    }
    if (!indexEnabled || !bridge) {
      if (catalogObservers === 0) {
        resetConversationCatalog();
        stopReadScope?.();
        stopReadScope = undefined;
      }
      return;
    }
    keepCatalogScope();
    if (!enabled || !hasDesktopConversation()) {
      return;
    }
    catalogObservers += 1;
    if (catalogObservers > 1) return releaseCatalogObserver;
    observationError = undefined;
    useConversationCatalogStore.setState({ ready: false, error: undefined });
    void refreshConversationCatalog().catch(() => {});
    const store = createConversationStore("");
    let closed = false;
    let resyncing = false;
    let exhausted = false;
    let resets = 0;
    let stop: (() => void) | undefined;
    const resync = (error: unknown) => {
      resyncing = true;
      queueMicrotask(() => {
        if (closed) return;
        stop?.();
        resets += 1;
        if (resets > 3) {
          exhausted = true;
          observationError = error;
          useConversationCatalogStore.setState({ error });
          return;
        }
        store.reset();
        resyncing = false;
        connect();
      });
    };
    const connect = () => {
      stop = createDesktopConversationAdapter().stream("", {
        open: () => {},
        error: (error) => {
          if (closed) return;
          observationError = error;
          useConversationCatalogStore.setState({ error });
        },
        event: (type, data) => {
          if (closed || resyncing) return false;
          if (type === "control-changed") {
            if (pending || waitingForSettlement) scheduleCatalogRefresh();
            return false;
          }
          if (type === "session-ready") {
            try {
              const ready = JSON.parse(data) as { cursor?: string };
              const state = store.getSnapshot();
              if (state.cursor && state.cursor === ready.cursor && !state.resyncRequired) {
                resets = 0;
                if (useConversationCatalogStore.getState().error === observationError)
                  useConversationCatalogStore.setState({ error: undefined });
                observationError = undefined;
              }
            } catch {
              // Invalid readiness never resets the consecutive failure limit.
            }
            return false;
          }
          if (type !== "session-event") return false;
          let event: SessionStreamEvent;
          let previous = store.getSnapshot();
          let state = previous;
          try {
            event = JSON.parse(data) as SessionStreamEvent;
            if (event.type === "snapshot" && typeof event.runtimeBootId === "string") {
              if (cacheBootId && cacheBootId !== event.runtimeBootId) {
                resetConversationCatalog();
                window.dispatchEvent(new Event(SESSION_CATALOG_RUNTIME_CHANGED));
              }
              cacheBootId = event.runtimeBootId;
            }
            previous = store.getSnapshot();
            state = store.dispatch(event);
          } catch (error) {
            resync(error);
            return false;
          }
          if (state.resyncRequired) {
            resync(new Error("catalog-resync-required"));
            return false;
          }
          if (
            state !== previous &&
            (event.type === "snapshot" ||
              (event.type === "invalidate" && event.payload.domains.includes("catalog")))
          )
            if (event.type !== "snapshot" || !pending) scheduleCatalogRefresh();
          return state.cursor ?? false;
        },
      });
    };
    const retry = () => {
      if (closed || !exhausted) return;
      exhausted = false;
      resyncing = false;
      resets = 0;
      store.reset();
      connect();
    };
    retryObservation = retry;
    connect();
    stopCatalogObservation = () => {
      closed = true;
      if (retryObservation === retry) retryObservation = undefined;
      stop?.();
    };
    return releaseCatalogObserver;
  }, [enabled, indexEnabled, bridge]);
  const currentHost = bridge === cacheBridge;
  return {
    ...state,
    sessions: enabled && indexEnabled && currentHost ? state.sessions : emptySessions,
    error: enabled && indexEnabled && currentHost ? state.error : undefined,
    codexRuntimeReason:
      enabled && indexEnabled && currentHost ? state.codexRuntimeReason : undefined,
    usable: !enabled || !indexEnabled || !bridge || (currentHost && state.usable),
    refreshing: enabled && indexEnabled && currentHost && state.refreshing,
    accessDenied: enabled && indexEnabled && currentHost && state.accessDenied,
    ready:
      !enabled || !indexEnabled || !bridge || (currentHost && catalogObservers > 0 && state.ready),
    complete: !enabled || !indexEnabled || !bridge || (currentHost && state.complete),
  };
}
