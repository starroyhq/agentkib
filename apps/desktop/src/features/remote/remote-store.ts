import { create } from "zustand";
import { api } from "@/core/api";
import type { RemoteRequest, RemoteStatus, RemotePairingResult } from "@/core/remote-types";
import {
  isRemoteViewActive,
  subscribeVisiblePolling,
  updateVisiblePolling,
} from "./visible-polling";

type Operation = Exclude<RemoteRequest, { operation: "catalog" | "events" | "status" }>;
type RemoteState = {
  snapshot: RemoteStatus | null;
  pairing: RemotePairingResult | null;
  loading: boolean;
  busy: boolean;
  error: unknown;
  operationError: boolean;
  clearError: () => void;
  refresh: () => Promise<void>;
  run: (request: Operation) => Promise<RemoteStatus | RemotePairingResult | null>;
};

// A mutation invalidates status reads already in flight, including reads from another panel.
let revision = 0;
export const useRemoteStore = create<RemoteState>((set, get) => ({
  snapshot: null,
  pairing: null,
  loading: false,
  busy: false,
  error: "",
  operationError: false,
  clearError: () => set({ error: "", operationError: false }),
  refresh: async () => {
    if (get().loading || get().busy) return;
    const ticket = revision;
    set({ loading: true });
    try {
      const snapshot = await api.remoteRequest({ operation: "status" });
      if (ticket === revision)
        set({
          snapshot: sameStatus(get().snapshot, snapshot) ? get().snapshot : snapshot,
          error: get().operationError ? get().error : "",
        });
    } catch (error) {
      if (ticket === revision && !get().operationError) set({ error });
    } finally {
      if (ticket === revision) set({ loading: false });
      updateRemotePolling();
    }
  },
  run: async (request) => {
    if (get().busy) return null;
    const ticket = ++revision;
    set({ busy: true, loading: false, error: "", operationError: false });
    try {
      const result = await api.remoteRequest(request);
      if (ticket !== revision) return null;
      if ("local" in result)
        set({ snapshot: sameStatus(get().snapshot, result) ? get().snapshot : result });
      else set({ pairing: result });
      return result;
    } catch (error) {
      if (ticket === revision) set({ error, operationError: true });
      return null;
    } finally {
      if (ticket === revision) {
        set({ busy: false });
        void get().refresh();
      }
    }
  },
}));

function sameStatus(previous: RemoteStatus | null, next: RemoteStatus) {
  return previous !== null && statusSignature(previous) === statusSignature(next);
}

function statusSignature(snapshot: RemoteStatus) {
  // The panel displays last-seen times to the minute. Heartbeats within that
  // minute should not invalidate the catalog; keep accepted snapshots unmodified.
  const lastSeenMinute = <T extends { last_seen: number | null }>(record: T) => ({
    ...record,
    last_seen: record.last_seen === null ? null : Math.floor(record.last_seen / 60),
  });
  return JSON.stringify({
    ...snapshot,
    connections: snapshot.connections.map(lastSeenMinute),
    authorized: snapshot.authorized.map(lastSeenMinute),
  });
}

const subscribers = new Map<() => void | Promise<void>, number>();
let releasePolling: (() => void) | undefined;
let refreshPending = false;
function needsPolling() {
  const { snapshot, pairing } = useRemoteStore.getState();
  return Boolean(
    !snapshot ||
    snapshot.local.enabled ||
    snapshot.connections.length ||
    snapshot.pending.length ||
    (snapshot.pairing_expires_at && snapshot.pairing_expires_at * 1000 > Date.now()) ||
    (pairing && pairing.expires_at * 1000 > Date.now()),
  );
}
function updateRemotePolling() {
  if (typeof document !== "undefined") updateVisiblePolling();
}

/** Panels and the catalog share one status request and one activity-aware schedule. */
export function subscribeRemoteStatus(listener: () => void | Promise<void>, interval = 5_000) {
  subscribers.set(listener, interval);
  if (!releasePolling)
    releasePolling = subscribeVisiblePolling({
      interval: () => Math.min(...subscribers.values()),
      enabled: needsPolling,
      run: async () => {
        if (refreshPending) return;
        refreshPending = true;
        try {
          await useRemoteStore.getState().refresh();
          await Promise.all([...subscribers.keys()].map((notify) => notify()));
        } finally {
          refreshPending = false;
        }
      },
    });
  else if (isRemoteViewActive()) void useRemoteStore.getState().refresh().then(listener);
  updateRemotePolling();
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) {
      releasePolling?.();
      releasePolling = undefined;
    }
    updateRemotePolling();
  };
}
