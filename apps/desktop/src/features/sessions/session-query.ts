import { retryBusyRead } from "./conversation/features/sessions/session-read-retry";
import { queryOptions, replaceEqualDeep, type QueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import type { ConversationSessionSummary } from "@/core/types";
import { homeKeys, queryDefaults } from "@/features/home/home-query";
import {
  mergeCatalogSessions as sharedMergeCatalogSessions,
  retryStaleCatalogRead,
  type IncompleteSessionSource,
} from "@agentkib/web-client";
export {
  isStaleCatalogRead,
  retryStaleCatalogRead,
  type IncompleteSessionSource,
} from "@agentkib/web-client";

export const sessionKeys = {
  status: (id: string) => [...homeKeys.continuations(id), "status"] as const,
  history: (workspaceId: string, id: string, remote: unknown, revision: number) =>
    ["session-history", workspaceId, id, remote, revision] as const,
  capability: (id: string, revision: number) => ["session-capability", id, revision] as const,
};
export const SESSION_CATALOG_RUNTIME_CHANGED = "agentkib:session-catalog-runtime-changed";
const readGenerations = new WeakMap<QueryClient, number>();
export function sessionQueryGeneration(client: QueryClient) {
  return readGenerations.get(client) ?? 0;
}
export function advanceSessionQueryGeneration(client: QueryClient) {
  readGenerations.set(client, sessionQueryGeneration(client) + 1);
}

/** Reordered records keep their identity; only unfinished sources retain missing rows. */
export function mergeCatalogSessions(
  previous: ConversationSessionSummary[],
  records: ConversationSessionSummary[],
  incompleteSources: readonly IncompleteSessionSource[] = [],
  retainMissing = false,
): ConversationSessionSummary[] {
  return sharedMergeCatalogSessions(
    previous,
    records,
    incompleteSources,
    retainMissing,
    replaceEqualDeep,
  );
}

// Electron RPC cannot be aborted once sent. Keep its slot until it settles and
// reuse the physical read if a cancelled Query is observed again before then.
let active = 0;
const queue: Array<() => void> = [];
const pending = new WeakMap<
  QueryClient,
  Map<string, { promise: Promise<unknown>; addSignal: (signal: AbortSignal) => void }>
>();
function drain() {
  while (active < 4 && queue.length) queue.shift()!();
}
export function queuedSessionRead<T>(
  client: QueryClient,
  key: string,
  signal: AbortSignal,
  read: () => Promise<T>,
  { retryBusy = false, retryStale = false }: { retryBusy?: boolean; retryStale?: boolean } = {},
): Promise<T> {
  let requests = pending.get(client);
  if (!requests) {
    requests = new Map();
    pending.set(client, requests);
  }
  let entry = requests.get(key);
  if (!entry) {
    const signals = new Set<AbortSignal>();
    const retry = new AbortController();
    let phase: "queued" | "physical" | "waiting" | "settled" = "queued";
    const unused = () => [...signals].every((item) => item.aborted);
    const cancelUnusedWait = () => {
      // A sent Electron RPC still owns its slot. A reopened observer can reuse
      // it; only retire an unused entry once the physical call has settled.
      if (phase !== "waiting" || !unused()) return;
      if (requests!.get(key) === entry) requests!.delete(key);
      retry.abort();
    };
    const addSignal = (consumer: AbortSignal) => {
      if (!signals.has(consumer)) {
        signals.add(consumer);
        consumer.addEventListener("abort", cancelUnusedWait, { once: true });
      }
      cancelUnusedWait();
    };
    const promise = new Promise<T>((resolve, reject) => {
      queue.push(() => {
        if (unused()) {
          reject(new DOMException("Cancelled", "AbortError"));
          return;
        }
        active += 1;
        const finish = () => {
          active -= 1;
          drain();
        };
        const call = () => {
          phase = "physical";
          const settled = () => {
            phase = "waiting";
            cancelUnusedWait();
          };
          try {
            return Promise.resolve(read()).finally(settled);
          } catch (error) {
            settled();
            return Promise.reject(error);
          }
        };
        try {
          // Scans also use this queue and must never replay a mutation.
          // Both read retries belong to the shared attempt, not the first
          // Query's signal. Reopened consumers can join a sent call; once its
          // last consumer leaves, the settled attempt cancels every later retry.
          const observe = retryStale ? () => retryStaleCatalogRead(call, retry.signal) : call;
          const operation = retryBusy ? retryBusyRead(observe, retry.signal) : observe();
          void operation.then(resolve, reject).finally(finish);
        } catch (error) {
          reject(error);
          finish();
        }
      });
    });
    entry = { promise, addSignal };
    addSignal(signal);
    requests.set(key, entry);
    const cleanup = () => {
      phase = "settled";
      for (const consumer of signals) consumer.removeEventListener("abort", cancelUnusedWait);
      if (requests!.get(key) === entry) requests!.delete(key);
    };
    void promise.then(cleanup, cleanup);
    drain();
  } else entry.addSignal(signal);
  return (entry.promise as Promise<T>).then((value) => {
    signal.throwIfAborted();
    return value;
  });
}

export function sessionListOptions(client: QueryClient, id: string) {
  const queryKey = homeKeys.continuations(id);
  return queryOptions({
    ...queryDefaults,
    queryKey,
    structuralSharing: (previous, records) =>
      mergeCatalogSessions(
        (previous as ConversationSessionSummary[] | undefined) ?? [],
        records as ConversationSessionSummary[],
      ),
    queryFn: async ({ signal }) => {
      const generation = sessionQueryGeneration(client);
      const before = client.getQueryState(queryKey)?.dataUpdateCount;
      const records = await queuedSessionRead(
        client,
        `sessions:${generation}:${id}`,
        signal,
        () => api.workspaceSessions(id),
        { retryBusy: true, retryStale: true },
      );
      if (generation !== sessionQueryGeneration(client))
        throw new DOMException("Cancelled", "AbortError");
      const latest = client.getQueryData<typeof records>(queryKey);
      return client.getQueryState(queryKey)?.dataUpdateCount !== before && latest !== undefined
        ? latest
        : mergeCatalogSessions(latest ?? [], records);
    },
  });
}
export function sessionStatusOptions(client: QueryClient, id: string) {
  return queryOptions({
    ...queryDefaults,
    queryKey: sessionKeys.status(id),
    queryFn: ({ signal }) =>
      queuedSessionRead(
        client,
        `status:${sessionQueryGeneration(client)}:${id}`,
        signal,
        () => api.workspaceSessionStatus(id),
        {
          retryBusy: true,
        },
      ),
  });
}
