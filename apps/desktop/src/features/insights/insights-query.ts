import { useEffect } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import type { InsightsQuery } from "@/core/types";

const queryDefaults = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};

export const insightsKeys = {
  all: ["insights"] as const,
  views: () => [...insightsKeys.all, "view"] as const,
  view: (query: InsightsQuery) => [...insightsKeys.views(), query] as const,
  refreshJob: () => [...insightsKeys.all, "refresh-job"] as const,
};

export function useInsightsView(query: InsightsQuery) {
  return useQuery({
    ...queryDefaults,
    queryKey: insightsKeys.view(query),
    queryFn: () => api.insightsView(query),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useInsightsRefreshJob() {
  return useQuery({
    ...queryDefaults,
    queryKey: insightsKeys.refreshJob(),
    queryFn: async () => {
      const jobs = await api.refreshStatus();
      return jobs.find((job) => job.kind === "insights");
    },
    staleTime: 0,
    refetchInterval: (current) => {
      const state = current.state.data?.state;
      return state === "queued" || state === "running" ? 1_000 : false;
    },
  });
}

export function useInsightsRefreshMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...queryDefaults,
    mutationFn: () => api.requestRefresh("insights", true),
    // 成功后的失效只由 useInsightsQueryEvents 做：主进程对每次成功都会发 refresh 事件。
    onSuccess: (receipt) => queryClient.setQueryData(insightsKeys.refreshJob(), receipt.status),
  });
}

/**
 * 刷新成功时让统计视图失效的唯一入口（挂在 AppRuntimeBridge 上，手动和自动刷新都会经过这里）。
 * 之前 mutation、事件和每个 useInsightsRefreshJob 实例都各自失效一次，而且挂载时看到
 * 上一次的 succeeded 也会失效，一次刷新会让 runtime 重算整份视图好几遍。
 */
export function useInsightsQueryEvents() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const unlisten = desktopApi().events.onRefreshState((status) => {
      if (status.kind !== "insights") return;
      queryClient.setQueryData(insightsKeys.refreshJob(), status);
      if (status.state === "succeeded") {
        void queryClient.invalidateQueries({ queryKey: insightsKeys.views() });
      }
    });
    return unlisten;
  }, [queryClient]);
}
