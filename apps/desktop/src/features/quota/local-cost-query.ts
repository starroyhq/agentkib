import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import type { LocalCostProvider, LocalCostSnapshot, LocalCostStatus } from "@/core/types";

export const localCostKeys = {
  snapshot: (provider: LocalCostProvider | undefined) =>
    ["local-cost", provider, "snapshot"] as const,
  status: (provider: LocalCostProvider | undefined) => ["local-cost", provider, "status"] as const,
};

const defaults = { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false };

export function useLocalCosts(provider: LocalCostProvider | undefined) {
  const client = useQueryClient();
  const snapshotQuery = useQuery({
    ...defaults,
    queryKey: localCostKeys.snapshot(provider),
    queryFn: async () => (provider ? ((await api.localCostSnapshot(provider)) ?? null) : null),
    enabled: Boolean(provider),
    staleTime: 0,
  });
  const statusQuery = useQuery({
    ...defaults,
    queryKey: localCostKeys.status(provider),
    queryFn: async () => (provider ? await api.localCostStatus(provider) : null),
    enabled: Boolean(provider),
    staleTime: 0,
    refetchInterval: (query) =>
      ["queued", "running"].includes(query.state.data?.state ?? "") ? 1_000 : false,
  });
  const refreshed = useRef<string | undefined>(undefined);
  const mutation = useMutation({
    ...defaults,
    mutationFn: async () => (provider ? await api.refreshLocalCost(provider, true) : null),
    onSuccess: () => {
      // The queued receipt can arrive after a completion event. Read status
      // rather than letting that older receipt replace the completed state.
      void client.invalidateQueries({ queryKey: localCostKeys.status(provider) });
    },
  });
  const resetMutation = mutation.reset;
  useEffect(() => resetMutation(), [provider, resetMutation]);

  useEffect(() => {
    if (!provider) return;
    const observe = () => {
      void api
        .observeLocalCosts(document.visibilityState === "hidden" ? null : provider)
        .catch(() => {
          void client.invalidateQueries({ queryKey: localCostKeys.status(provider) });
        });
    };
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => {
      document.removeEventListener("visibilitychange", observe);
      void api.observeLocalCosts(null).catch(() => undefined);
    };
  }, [client, provider]);

  useEffect(() => {
    let revision = 0;
    let active = true;
    const unlisten = desktopApi().events.onLocalCostUpdated((update) => {
      if (update.provider !== provider) return;
      const current = ++revision;
      void Promise.all([
        client.cancelQueries({ queryKey: localCostKeys.snapshot(provider) }),
        client.cancelQueries({ queryKey: localCostKeys.status(provider) }),
      ]).then(() => {
        if (!active || current !== revision) return;
        const cached = client.getQueryData<LocalCostSnapshot | null>(
          localCostKeys.snapshot(provider),
        );
        const cachedStatus = client.getQueryData<LocalCostStatus | null>(
          localCostKeys.status(provider),
        );
        const currentScope = cachedStatus?.scope_key ?? cached?.scope_key;
        if (currentScope && update.status.scope_key !== currentScope) {
          // A scope is authoritative only after a current RPC read. An old
          // scope's cancellation can arrive after a new configuration was read.
          void client.invalidateQueries({ queryKey: localCostKeys.status(provider) });
          void client.invalidateQueries({ queryKey: localCostKeys.snapshot(provider) });
          return;
        }
        client.setQueryData(localCostKeys.status(provider), update.status);
        if (update.snapshot) client.setQueryData(localCostKeys.snapshot(provider), update.snapshot);
        else if (cached && cached.scope_key !== update.status.scope_key)
          client.setQueryData(localCostKeys.snapshot(provider), null);
      });
    });
    return () => {
      active = false;
      unlisten();
    };
  }, [client, provider]);

  useEffect(() => {
    const status = statusQuery.data;
    if (!status || !["succeeded", "failed", "cancelled"].includes(status.state)) return;
    const version = `${provider}:${status.scope_key}:${status.data_version}:${status.last_attempt_at}:${status.state}`;
    if (refreshed.current === version) return;
    refreshed.current = version;
    const cached = client.getQueryData<LocalCostSnapshot | null>(localCostKeys.snapshot(provider));
    if (
      cached &&
      cached.scope_key === status.scope_key &&
      cached.data_version === status.data_version
    )
      return;
    void client.invalidateQueries({ queryKey: localCostKeys.snapshot(provider) });
  }, [client, provider, statusQuery.data]);

  const snapshot = snapshotQuery.data;
  const status = statusQuery.data;
  return {
    snapshot:
      snapshot && (!status || snapshot.scope_key === status.scope_key) ? snapshot : undefined,
    status: status ?? undefined,
    loading: snapshotQuery.isPending || statusQuery.isPending,
    busy: mutation.isPending || status?.state === "queued" || status?.state === "running",
    error: mutation.error ?? snapshotQuery.error ?? statusQuery.error,
    refresh: mutation.mutateAsync,
  };
}

export type LocalCostsQuery = ReturnType<typeof useLocalCosts>;
