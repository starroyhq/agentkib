import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import type { QuotaPopoverPreferences, QuotaSnapshot } from "@/core/types";

export const DEFAULT_QUOTA_PREFERENCES: QuotaPopoverPreferences = {
  hidden_providers: [],
  hidden_windows: [],
};

export const quotaKeys = {
  all: ["quota"] as const,
  snapshot: () => [...quotaKeys.all, "snapshot"] as const,
  status: () => [...quotaKeys.all, "status"] as const,
  preferences: () => [...quotaKeys.all, "preferences"] as const,
  refreshJob: () => [...quotaKeys.all, "refresh-job"] as const,
};

const queryDefaults = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};

export function useQuotaSnapshot() {
  const query = useQuery({
    ...queryDefaults,
    queryKey: quotaKeys.snapshot(),
    queryFn: async () => (await api.quotaSnapshot()) ?? null,
    staleTime: 30_000,
  });
  return { ...query, data: query.data ?? undefined };
}

export function useQuotaStatus() {
  return useQuery({
    ...queryDefaults,
    queryKey: quotaKeys.status(),
    queryFn: () => api.quotaCollectorStatus(),
    staleTime: 30_000,
  });
}

export function useQuotaPreferences() {
  return useQuery({
    ...queryDefaults,
    queryKey: quotaKeys.preferences(),
    queryFn: () => api.quotaPopoverPreferences(),
    placeholderData: DEFAULT_QUOTA_PREFERENCES,
    staleTime: 60_000,
  });
}

export function useQuotaRefreshJob() {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...queryDefaults,
    queryKey: quotaKeys.refreshJob(),
    queryFn: async () => {
      const jobs = await api.refreshStatus();
      return jobs.find((job) => job.kind === "quota") ?? null;
    },
    staleTime: 0,
    refetchInterval: (current) => {
      const state = current.state.data?.state;
      return state === "queued" || state === "running" ? 1_000 : false;
    },
  });
  const invalidatedRequest = useRef<string | undefined>(undefined);

  useEffect(() => {
    const job = query.data;
    if (!job || !["succeeded", "failed"].includes(job.state) || !job.request_id) return;
    if (invalidatedRequest.current === job.request_id) return;
    invalidatedRequest.current = job.request_id;
    void invalidateQuotaData(queryClient);
  }, [query.data, queryClient]);

  return query;
}

export function useQuotaRefreshMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...queryDefaults,
    mutationFn: () => api.refreshQuota(),
    onSuccess: (receipt) => {
      queryClient.setQueryData(quotaKeys.refreshJob(), receipt.status);
      if (["succeeded", "failed"].includes(receipt.status.state))
        void invalidateQuotaData(queryClient);
    },
  });
}

export function useSetQuotaPreferencesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...queryDefaults,
    mutationFn: (preferences: QuotaPopoverPreferences) =>
      api.setQuotaPopoverPreferences(preferences),
    onMutate: async (preferences) => {
      await queryClient.cancelQueries({ queryKey: quotaKeys.preferences() });
      const previous = queryClient.getQueryData<QuotaPopoverPreferences>(quotaKeys.preferences());
      queryClient.setQueryData(quotaKeys.preferences(), preferences);
      return { previous };
    },
    onError: (_error, _preferences, context) => {
      if (context?.previous) queryClient.setQueryData(quotaKeys.preferences(), context.previous);
    },
    onSuccess: (preferences) => {
      queryClient.setQueryData(quotaKeys.preferences(), preferences);
    },
  });
}

export function useQuotaQueryEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const desktop = desktopApi();
    const unlistenQuota = desktop.events.onQuotaUpdated((snapshot) => {
      queryClient.setQueryData<QuotaSnapshot | undefined>(quotaKeys.snapshot(), snapshot);
      void queryClient.invalidateQueries({ queryKey: quotaKeys.status() });
    });
    const unlistenRefresh = desktop.events.onRefreshState((status) => {
      if (status.kind !== "quota") return;
      queryClient.setQueryData(quotaKeys.refreshJob(), status);
      if (["succeeded", "failed"].includes(status.state)) void invalidateQuotaData(queryClient);
    });
    return () => {
      unlistenQuota();
      unlistenRefresh();
    };
  }, [queryClient]);
}

async function invalidateQuotaData(queryClient: QueryClient) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: quotaKeys.snapshot() }),
    queryClient.invalidateQueries({ queryKey: quotaKeys.status() }),
  ]);
}
