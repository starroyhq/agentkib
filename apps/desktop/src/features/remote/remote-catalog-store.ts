import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { api } from "@/core/api";
import { DEFAULT_SESSION_PAGE_SIZE } from "@/core/session-history";
import type { RemoteCatalog, RemoteConnection } from "@/core/remote-types";
import type { ConversationEventPage, ConversationSessionSummary } from "@/core/types";
import { subscribeRemoteStatus, useRemoteStore } from "./remote-store";
import { isRemoteViewActive } from "./visible-polling";
import { parseRemoteCatalog, parseRemoteEvents } from "./remote-payload";

interface CachedCatalog extends RemoteCatalog {
  syncedAt: string;
}
interface RemoteCatalogState {
  catalogs: Record<string, CachedCatalog>;
  errors: Record<string, string>;
  revision: number;
}
export const useRemoteCatalogStore = create<RemoteCatalogState>(() => ({
  catalogs: {},
  errors: {},
  revision: 0,
}));
const epochs = new Map<string, number>();
const pending = new Map<string, Promise<void>>();
const retryAt = new Map<string, number>();
const failures = new Map<string, number>();
const history = new Map<string, ConversationEventPage>();
const blocked = new Set([
  "revoked",
  "sharing-disabled",
  "index-disabled",
  "identity-changed",
  "expired",
  "rejected",
]);
const denied = /REMOTE_(REVOKED|SHARING_DISABLED|INDEX_DISABLED|IDENTITY_CHANGED)/;
const historyKey = (host: string, id: string, cursor?: string) =>
  JSON.stringify([host, id, cursor ?? null]);
export const remoteRecordId = (host: string, id: string) => `remote:${JSON.stringify([host, id])}`;

function connection(id: string) {
  return useRemoteStore.getState().snapshot?.connections.find((host) => host.id === id);
}
function retained(host?: RemoteConnection) {
  return host && !blocked.has(host.status) && host.status !== "pending";
}
export function invalidateRemoteHost(id: string) {
  epochs.set(id, (epochs.get(id) ?? 0) + 1);
  retryAt.delete(id);
  failures.delete(id);
  for (const key of history.keys())
    if ((JSON.parse(key) as string[])[0] === id) history.delete(key);
  useRemoteCatalogStore.setState((state) => {
    const catalogs = { ...state.catalogs };
    const errors = { ...state.errors };
    delete catalogs[id];
    delete errors[id];
    return { catalogs, errors, revision: state.revision + 1 };
  });
}

// Invalidate before React renders; late pages may not refill revoked/removed data.
useRemoteStore.subscribe((state, previous) => {
  if (state.snapshot === previous.snapshot || !state.snapshot) return;
  const old = previous.snapshot?.connections ?? [];
  for (const host of old) {
    const next = state.snapshot.connections.find((item) => item.id === host.id);
    if (retained(host) && !retained(next)) invalidateRemoteHost(host.id);
    else if (next?.status === "online" && host.status !== "online") retryAt.delete(host.id);
  }
});

export async function refreshRemoteCatalog(id: string, force = false): Promise<void> {
  const existing = pending.get(id);
  if (existing) return existing;
  if (connection(id)?.status !== "online" || (!force && Date.now() < (retryAt.get(id) ?? 0)))
    return;
  const epoch = epochs.get(id) ?? 0;
  const current = () => epoch === (epochs.get(id) ?? 0) && retained(connection(id));
  const task = (async () => {
    try {
      const result = parseRemoteCatalog(await api.remoteRequest({ operation: "catalog", id }));
      if (!current()) return;
      const readable = new Set(
        result.sessions
          .filter((session) => session.availability === "readable")
          .map((session) => session.id),
      );
      let removedHistory = false;
      for (const key of history.keys()) {
        const [hostId, sessionId] = JSON.parse(key) as string[];
        if (hostId === id && !readable.has(sessionId)) {
          history.delete(key);
          removedHistory = true;
        }
      }
      failures.delete(id);
      retryAt.set(id, Date.now() + 30_000);
      useRemoteCatalogStore.setState((state) => {
        const errors = { ...state.errors };
        delete errors[id];
        return {
          catalogs: { ...state.catalogs, [id]: { ...result, syncedAt: new Date().toISOString() } },
          errors,
          revision: state.revision + (removedHistory ? 1 : 0),
        };
      });
    } catch (error) {
      if (!current()) return;
      const message = String(error);
      if (denied.test(message)) invalidateRemoteHost(id);
      const count = (failures.get(id) ?? 0) + 1;
      failures.set(id, count);
      retryAt.set(id, Date.now() + Math.min(120_000, 5_000 * 2 ** Math.min(count - 1, 5)));
      useRemoteCatalogStore.setState((state) => ({ errors: { ...state.errors, [id]: message } }));
      void useRemoteStore.getState().refresh();
    }
  })();
  pending.set(id, task);
  try {
    await task;
  } finally {
    pending.delete(id);
  }
}

export async function readRemoteHistory(session: ConversationSessionSummary, cursor?: string) {
  const source = session.remote!;
  const host = connection(source.host_id);
  if (!retained(host)) throw new Error("REMOTE_REVOKED");
  const stillReadable = () =>
    useRemoteCatalogStore
      .getState()
      .catalogs[source.host_id]?.sessions.some(
        (item) => item.id === source.original_id && item.availability === "readable",
      );
  if (!stillReadable()) throw new Error("REMOTE_SESSION_NOT_FOUND");
  const key = historyKey(source.host_id, source.original_id, cursor);
  if (host?.status !== "online") {
    const cached = history.get(key);
    if (cached) return cached;
    throw new Error("REMOTE_OFFLINE");
  }
  const epoch = epochs.get(source.host_id) ?? 0;
  try {
    const result = parseRemoteEvents(
      await api.remoteRequest({
        operation: "events",
        id: source.host_id,
        sessionId: source.original_id,
        cursor,
        limit: DEFAULT_SESSION_PAGE_SIZE,
      }),
    );
    if (epoch !== (epochs.get(source.host_id) ?? 0) || !retained(connection(source.host_id)))
      throw new Error("REMOTE_REVOKED");
    if (!stillReadable()) throw new Error("REMOTE_SESSION_NOT_FOUND");
    // Bound controller-only memory; no transcript or remote path is persisted.
    if (history.size >= 200) history.delete(history.keys().next().value!);
    history.set(key, result);
    return result;
  } catch (error) {
    if (denied.test(String(error)) && epoch === (epochs.get(source.host_id) ?? 0))
      invalidateRemoteHost(source.host_id);
    throw error;
  }
}

export function useRemoteCatalogEntries() {
  const state = useRemoteCatalogStore();
  const snapshot = useRemoteStore((store) => store.snapshot);
  return useMemo(() => {
    const hosts = (snapshot?.connections ?? []).filter(retained);
    const workspaces = hosts.flatMap((host) => {
      const cached = state.catalogs[host.id];
      return (cached?.workspaces ?? []).map((workspace) => ({
        ...workspace,
        id: remoteRecordId(host.id, workspace.id),
        remote: {
          host_id: host.id,
          host_name: host.name,
          original_id: workspace.id,
          online: host.status === "online",
          last_synced_at: cached.syncedAt,
        },
      }));
    });
    const sessions = hosts.flatMap((host) => {
      const cached = state.catalogs[host.id];
      return (cached?.sessions ?? []).map((session) => ({
        ...session,
        id: remoteRecordId(host.id, session.id),
        workspace_id: remoteRecordId(host.id, session.workspace_id),
        spawned_by_session_id: session.spawned_by_session_id
          ? remoteRecordId(host.id, session.spawned_by_session_id)
          : undefined,
        forked_from_session_id: session.forked_from_session_id
          ? remoteRecordId(host.id, session.forked_from_session_id)
          : undefined,
        remote: {
          host_id: host.id,
          host_name: host.name,
          original_id: session.id,
          online: host.status === "online",
          last_synced_at: cached.syncedAt,
        },
      }));
    });
    return { workspaces, sessions, hosts, errors: state.errors, revision: state.revision };
  }, [state, snapshot]);
}

export function RemoteCatalogBridge() {
  useEffect(() => {
    let disposed = false;
    let running = false;
    const tick = async () => {
      if (disposed || running || !isRemoteViewActive()) return;
      running = true;
      try {
        const hosts = useRemoteStore.getState().snapshot?.connections ?? [];
        // Keep controller reads bounded even with many paired hosts.
        for (let offset = 0; offset < hosts.length && !disposed; offset += 4) {
          await Promise.all(
            hosts.slice(offset, offset + 4).map((host) => refreshRemoteCatalog(host.id)),
          );
        }
      } finally {
        running = false;
      }
    };
    const unsubscribe = subscribeRemoteStatus(tick);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);
  return null;
}
