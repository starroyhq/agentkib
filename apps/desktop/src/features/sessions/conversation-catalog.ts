import { desktopReadScope, subscribeDesktopReadScope } from "./read-state-scope";
import { isBusyRead, retryBusyRead } from "@agentkib/session-ui";
import { useEffect } from "react";
import { create } from "zustand";
import {
  ApiError,
  applyConversationCatalogPatch,
  conversationCatalogPatch,
  rememberConversationCatalogPatch,
  type ConversationCatalog,
  type ConversationCatalogPatch,
  type ConversationReadState,
} from "@agentkib/web-client";
import { createConversationStore, type SessionStreamEvent } from "@agentkib/conversation-state";
import {
  createDesktopConversationAdapter,
  desktopConversationRequest,
  hasDesktopConversation,
  type DesktopConversationBridge,
} from "@/core/conversation-bridge";
import type { ConversationSessionSummary } from "@/core/types";
import { isCatalogReadTimeout } from "./catalog-read-error";
import {
  isStaleCatalogRead,
  mergeCatalogSessions,
  retryStaleCatalogRead,
  SESSION_CATALOG_RUNTIME_CHANGED,
  type IncompleteSessionSource,
} from "./session-query";

interface ConversationCatalogState {
  sessions: ConversationSessionSummary[];
  workspaces?: ConversationCatalog["workspaces"];
  indexEnabled?: boolean;
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
let settlement = 0;
let backgroundDirty = false;
let lastBackgroundRead = 0;
let pendingPatches: Map<string, ConversationCatalogPatch["updates"][number]> | undefined;
const BACKGROUND_READ_INTERVAL_MS = 3_000;
let observationError: unknown;
let retryObservation: (() => void) | undefined;
let catalogObservers = 0;
let stopCatalogObservation: (() => void) | undefined;
let stopReadScope: (() => void) | undefined;
let cacheBridge: DesktopConversationBridge | undefined;
let scheduledRefresh: ReturnType<typeof setTimeout> | undefined;
let cacheBootId: string | undefined;
const emptySessions: ConversationSessionSummary[] = [];

function resetBackgroundRefresh() {
  if (scheduledRefresh) clearTimeout(scheduledRefresh);
  scheduledRefresh = undefined;
  backgroundDirty = false;
  lastBackgroundRead = 0;
}

function resetConversationCatalog() {
  generation += 1;
  pending = undefined;
  waitingForSettlement = false;
  pendingPatches = undefined;
  resetBackgroundRefresh();
  observationError = undefined;
  cacheBootId = undefined;
  useConversationCatalogStore.setState({
    sessions: emptySessions,
    workspaces: undefined,
    indexEnabled: undefined,
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
    pendingPatches = undefined;
    waitingForSettlement = false;
    resetBackgroundRefresh();
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

function armBackgroundRefresh() {
  if (!backgroundDirty || pending || scheduledRefresh || !catalogObservers) return;
  scheduledRefresh = setTimeout(
    () => {
      scheduledRefresh = undefined;
      if (pending) return;
      lastBackgroundRead = Date.now();
      void refreshConversationCatalog({ background: true }).catch(() => {});
    },
    Math.max(40, lastBackgroundRead + BACKGROUND_READ_INTERVAL_MS - Date.now()),
  );
}

function scheduleCatalogRefresh() {
  settlement++;
  backgroundDirty = true;
  useConversationCatalogStore.setState({ ready: false });
  armBackgroundRefresh();
}

function applyCatalogPatch(patch: ConversationCatalogPatch) {
  if (pendingPatches) rememberConversationCatalogPatch(pendingPatches, patch);
  useConversationCatalogStore.setState((current) => {
    const sessions = applyConversationCatalogPatch(current.sessions, patch);
    return sessions === current.sessions ? current : { sessions };
  });
}

export function applyDesktopReadState(
  scopeKey: string,
  sessionId: string,
  readState: ConversationReadState,
) {
  const scope = desktopReadScope();
  if (!scope.ready || scope.key !== scopeKey) return;
  const current = useConversationCatalogStore.getState();
  const index = current.sessions.findIndex((session) => session.id === sessionId);
  if (index < 0) return;
  // Reconcile any catalog response that began before this confirmed update.
  invalidation++;
  const sessions = [...current.sessions];
  sessions[index] = { ...sessions[index]!, readState };
  useConversationCatalogStore.setState({ sessions });
}

export function refreshConversationCatalog({
  joinPending = false,
  background = false,
}: { joinPending?: boolean; background?: boolean } = {}): Promise<ConversationSessionSummary[]> {
  if (!hasDesktopConversation()) return Promise.resolve([]);
  const bridge = window.desktopConversation;
  if (bridge !== cacheBridge) {
    resetConversationCatalog();
    stopReadScope?.();
    stopReadScope = undefined;
    cacheBridge = bridge;
  }
  if (joinPending && pending) return pending;
  if (!background) {
    retryObservation?.();
    invalidation++;
  }
  if (pending) return pending;
  if (scheduledRefresh) clearTimeout(scheduledRefresh);
  scheduledRefresh = undefined;
  backgroundDirty = false;
  useConversationCatalogStore.setState({ ready: false, refreshing: true });
  const request = generation;
  let blockedVersion: number | undefined;
  const task = (async () => {
    let retriedTimeout = false;
    let retriedNotification = false;
    while (true) {
      const version = invalidation;
      const settlementVersion = settlement;
      const patches = new Map<string, ConversationCatalogPatch["updates"][number]>();
      pendingPatches = patches;
      let catalog: ConversationCatalog;
      try {
        catalog = await retryStaleCatalogRead(() =>
          retryBusyRead(() => desktopConversationRequest<ConversationCatalog>("catalog")),
        );
      } catch (error) {
        // A timed-out catalog read can be repeated without reissuing any command.
        if (generation === request && !retriedTimeout && isCatalogReadTimeout(error)) {
          retriedTimeout = true;
          await new Promise<void>((resolve) => setTimeout(resolve, 250));
          if (generation === request) continue;
        }
        if (generation === request && (isBusyRead(error) || isStaleCatalogRead(error))) {
          waitingForSettlement = true;
          blockedVersion = settlementVersion;
          // Settlement can arrive before the rejected read returns. Consume that
          // notification once; otherwise wait without turning contention into an error.
          if (version !== invalidation) continue;
          if (!background && !retriedNotification && settlementVersion !== settlement) {
            retriedNotification = true;
            backgroundDirty = false;
            continue;
          }
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
      if (
        backgroundDirty &&
        catalog.complete !== false &&
        !sessions.length &&
        current.sessions.length
      ) {
        // An invalidated empty result cannot prove deletion. An explicit caller
        // may catch up once; sustained notifications wait for the trailing read.
        waitingForSettlement = false;
        if (background || retriedNotification) return current.sessions;
        retriedNotification = true;
        backgroundDirty = false;
        continue;
      }
      const incompleteSources = catalog.incompleteSources ?? [];
      const next = mergeCatalogSessions(
        current.sessions,
        applyConversationCatalogPatch(sessions, { updates: [...patches.values()] }),
        incompleteSources,
        catalog.complete === false && !catalog.incompleteSources?.length,
      );
      const usable = catalog.complete !== false || current.usable || next.length > 0;
      useConversationCatalogStore.setState({
        sessions: next,
        workspaces: catalog.workspaces,
        indexEnabled: catalog.indexEnabled,
        usable,
        ready: !backgroundDirty && usable,
        accessDenied: false,
        complete: catalog.complete !== false,
        incompleteSources,
        error: observationError,
        codexRuntimeReason: catalog.codexRuntimeReason,
      });
      waitingForSettlement = false;
      // Stream invalidations have their own trailing read. Only an explicit
      // request after a mutation invalidates a successful result in this loop.
      return next;
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
      pendingPatches = undefined;
      useConversationCatalogStore.setState({ refreshing: false });
      if (generation === request && waitingForSettlement && blockedVersion !== settlement)
        backgroundDirty = true;
      armBackgroundRefresh();
    });
  pending = task;
  return task;
}

function catalogSnapshot(state: ConversationCatalogState): ConversationCatalog | undefined {
  const bridge = globalThis.window?.desktopConversation;
  const { sessions, workspaces, indexEnabled, usable, accessDenied, complete, incompleteSources } =
    state;
  if (!bridge || bridge !== cacheBridge || !usable || accessDenied || indexEnabled === undefined)
    return undefined;
  return { sessions, workspaces, indexEnabled, complete, incompleteSources };
}

/** Reuse the local directory already displayed when opening a known readable session. */
export function cachedConversationCatalog(sessionId: string): ConversationCatalog | undefined {
  const catalog = catalogSnapshot(useConversationCatalogStore.getState());
  if (
    catalog?.indexEnabled &&
    catalog.sessions.some(
      (session) => session.id === sessionId && session.availability === "readable",
    )
  )
    return catalog;
}

/** An embedded conversation in the same window already shares the scoped directory. */
export function observeConversationCatalog(receive: (catalog: ConversationCatalog) => void) {
  const notify = (current: ConversationCatalogState, previous?: ConversationCatalogState) => {
    if (
      previous &&
      current.sessions === previous.sessions &&
      current.workspaces === previous.workspaces &&
      current.indexEnabled === previous.indexEnabled &&
      current.complete === previous.complete &&
      current.incompleteSources === previous.incompleteSources &&
      current.usable === previous.usable
    )
      return;
    const catalog = catalogSnapshot(current);
    if (catalog) receive(catalog);
  };
  const stop = useConversationCatalogStore.subscribe(notify);
  notify(useConversationCatalogStore.getState());
  return stop;
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
            if (pending || waitingForSettlement) settlement++;
            if (waitingForSettlement && !pending) {
              backgroundDirty = true;
              armBackgroundRefresh();
            }
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
          ) {
            const patch = event.type === "invalidate" && conversationCatalogPatch(event.payload);
            if (patch) applyCatalogPatch(patch);
            else if (event.type !== "snapshot" || !pending) scheduleCatalogRefresh();
          }
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
