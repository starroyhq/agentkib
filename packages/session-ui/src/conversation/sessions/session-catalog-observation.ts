import { createConversationStore, type SessionStreamEvent } from "@agentkib/conversation-state";
import {
  applyConversationCatalogPatch,
  conversationCatalogPatch,
  type ConversationCatalogPatch,
  type ConversationSessionSummary,
  type Live,
  type WebClient,
} from "@agentkib/web-client";

export const CATALOG_BACKGROUND_READ_MS = 3_000;

type CatalogReader = {
  read(): Promise<void>;
  waiting(): boolean;
  needsImmediateReload(): boolean;
};
type Observation = {
  client: WebClient;
  current(): boolean;
  createReader(active: () => boolean): CatalogReader;
  bindRefresh(read?: () => void): void;
  applyPatch(patch: ConversationCatalogPatch): boolean;
  onOpen(): void;
  onError(error: unknown): boolean;
  checkAccessWhenStopped(active: () => boolean): void;
  onAccessEnded(): void;
  onAccessChanged(): void;
  onControlChanged(sessionId: string | undefined): void;
  onAdvanced(runtimeBootId?: string): void;
  onInvalidated(domains: string[]): void;
  setFailed(failed: boolean): void;
};

export function applyScopedCatalogPatch(
  records: ConversationSessionSummary[],
  patch: ConversationCatalogPatch,
  workspaceIds: ReadonlySet<string>,
) {
  return applyConversationCatalogPatch(records, patch, (row, previous) =>
    workspaceIds.has(row.workspace_id) ? { ...row, readState: previous?.readState } : undefined,
  );
}

export function changesCatalogMembership(patch: ConversationCatalogPatch) {
  return patch.updates.some(
    ({ row, removed, archived }) => row || removed || archived !== undefined,
  );
}

export function readableCatalogEvidence(
  records: ConversationSessionSummary[],
  snapshot: boolean,
  patch?: ConversationCatalogPatch,
) {
  if (!snapshot && !patch) return [];
  const upserts = new Set(patch?.updates.flatMap(({ row }) => (row ? [row.id] : [])));
  return records.filter(
    ({ id, availability }) => availability === "readable" && (snapshot || upserts.has(id)),
  );
}

export function observeSessionCatalog(options: Observation) {
  const store = createConversationStore<Live>("");
  let closed = false;
  let resetPending = false;
  let exhausted = false;
  let resets = 0;
  let connectionEpoch = 0;
  let close: (() => void) | undefined;
  const current = () => !closed && options.current();
  const exhaust = () => {
    const connection = connectionEpoch;
    exhausted = true;
    close?.();
    close = undefined;
    options.setFailed(true);
    // This last access read outlives the stopped reader, but never the observation's scope.
    options.checkAccessWhenStopped(() => current() && connection === connectionEpoch);
  };
  const resync = () => {
    if (!current() || resetPending || exhausted) return;
    resetPending = true;
    // Discard callbacks from a rejected stream even before it closes.
    connectionEpoch++;
    queueMicrotask(() => {
      if (!current()) return;
      close?.();
      close = undefined;
      if (++resets > 3) {
        exhaust();
        return;
      }
      store.reset();
      resetPending = false;
      connect();
    });
  };
  function connect() {
    const connection = ++connectionEpoch;
    const active = () => current() && connection === connectionEpoch && !resetPending && !exhausted;
    const reader = options.createReader(active);
    let ready = false;
    let lastRead = -Infinity;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reloadNow = () => {
      clearTimeout(timer);
      timer = undefined;
      lastRead = -Infinity;
      void reader.read();
    };
    const scheduleReload = () => {
      if (!active()) return;
      if (reader.needsImmediateReload()) {
        reloadNow();
        return;
      }
      if (timer !== undefined) return;
      const read = () => {
        timer = undefined;
        if (!active()) return;
        lastRead = Date.now();
        void reader.read();
      };
      const delay = lastRead + CATALOG_BACKGROUND_READ_MS - Date.now();
      if (delay > 0) timer = setTimeout(read, delay);
      else read();
    };
    const invalidate = (payload?: unknown) => {
      const patch = conversationCatalogPatch(payload);
      if (!patch || !options.applyPatch(patch)) scheduleReload();
    };
    options.bindRefresh(() => {
      // A ready directory stream owns refreshes. Detail events still cover a
      // directory connection that has not caught up or has lost its transport.
      if (!ready) scheduleReload();
    });
    const stop = options.client.stream(
      "",
      {
        open: () => {
          if (!active()) return;
          ready = false;
          options.onOpen();
          reloadNow();
        },
        error: (error, recovery) => {
          if (!active()) return;
          ready = false;
          const reload = options.onError(error);
          if (recovery === "stopped") exhaust();
          else if (reload) scheduleReload();
        },
        event: (type, data) => {
          if (!active()) return false;
          if (type === "access-ended") {
            options.onAccessEnded();
            return false;
          }
          if (type === "access-changed") {
            ready = false;
            options.onAccessChanged();
            reloadNow();
            return false;
          }
          if (type === "control-changed") {
            try {
              const changed = JSON.parse(data) as { sessionId?: string };
              options.onControlChanged(changed.sessionId);
              // Settlement can precede the rejected read.
              if (reader.waiting()) {
                reader.needsImmediateReload();
                reloadNow();
              }
            } catch {
              options.onError(new Error("invalid-control-change"));
            }
            return false;
          }
          if (type === "session-ready") {
            try {
              const marker = JSON.parse(data) as { cursor?: string };
              const state = store.getSnapshot();
              if (
                typeof marker?.cursor === "string" &&
                marker.cursor.length > 0 &&
                !state.resyncRequired &&
                (!state.cursor || state.cursor === marker.cursor)
              ) {
                // Web directory streams have a ready marker but no session-event baseline.
                resets = 0;
                ready = true;
                options.setFailed(false);
              }
            } catch {
              // Malformed readiness never proves observation has recovered.
            }
            return false;
          }
          if (type === "catalog-invalidated") {
            options.onOpen();
            try {
              invalidate(JSON.parse(data));
            } catch {
              scheduleReload();
            }
            return false;
          }
          if (type !== "session-event") return false;
          try {
            const event = JSON.parse(data) as SessionStreamEvent<Live>;
            if (event.sessionId !== "") return false;
            const previous = store.getSnapshot();
            const state = store.dispatch(event);
            if (state.resyncRequired) {
              resync();
              return false;
            }
            const advanced =
              state.cursor !== previous.cursor ||
              state.seq !== previous.seq ||
              state.epoch !== previous.epoch ||
              state.runtimeBootId !== previous.runtimeBootId;
            if (advanced) {
              options.onAdvanced(state.runtimeBootId);
              if (event.type === "snapshot") void reader.read();
              if (event.type === "invalidate") {
                if (event.payload.domains.includes("catalog")) invalidate(event.payload);
                options.onInvalidated(event.payload.domains);
              }
            }
            return state.cursor ?? false;
          } catch {
            resync();
            return false;
          }
        },
      },
      { catalogPatch: 2 },
    );
    close = () => {
      clearTimeout(timer);
      stop();
    };
  }
  connect();
  return {
    retry() {
      if (!current() || !exhausted) return;
      exhausted = false;
      resetPending = false;
      resets = 0;
      store.reset();
      connect();
    },
    stop() {
      closed = true;
      options.bindRefresh();
      close?.();
    },
  };
}
