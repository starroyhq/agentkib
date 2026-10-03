import { useEffect } from "react";
import { useContext } from "react";
import { QueryClient, QueryClientContext, useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { desktopApi } from "@/core/desktop";
import type { RefreshJobStatus } from "@/core/types";

export const queryDefaults = {
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  staleTime: 30_000,
};

const fallbackQueryClient = new QueryClient({
  defaultOptions: { queries: { ...queryDefaults } },
});

export function useOptionalQueryClient() {
  return useContext(QueryClientContext) ?? fallbackQueryClient;
}

export const homeKeys = {
  all: ["home"] as const,
  workspaces: () => [...homeKeys.all, "workspaces"] as const,
  doctorSummaries: (workspaceIds: string[]) =>
    [...homeKeys.all, "doctor-summaries", workspaceIds] as const,
  installations: () => [...homeKeys.all, "installations"] as const,
  catalog: () => [...homeKeys.all, "catalog"] as const,
  memories: () => [...homeKeys.all, "memories"] as const,
  activity: () => [...homeKeys.all, "activity"] as const,
  continuationsRoot: () => [...homeKeys.all, "continuations"] as const,
  continuations: (workspaceId: string) => [...homeKeys.all, "continuations", workspaceId] as const,
  discovery: () => [...homeKeys.all, "discovery"] as const,
  insightsSummary: () => [...homeKeys.all, "insights-summary"] as const,
  refreshJobs: () => [...homeKeys.all, "refresh-jobs"] as const,
  remoteGateways: () => [...homeKeys.all, "remote-gateways"] as const,
  scanRoots: () => [...homeKeys.all, "scan-roots"] as const,
  excluded: () => [...homeKeys.all, "excluded"] as const,
  insightsStatus: () => [...homeKeys.all, "insights-status"] as const,
  doctorReport: (workspaceId: string) => [...homeKeys.all, "doctor-report", workspaceId] as const,
  storageOverview: () => [...homeKeys.all, "storage-overview"] as const,
};

/** 放在 homeKeys 下：存储扫描任务完成时 useHomeQueryEvents 会一并刷新它。 */
export function useHomeStorageOverview() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.storageOverview(),
      queryFn: () => api.storageOverview(),
    },
    queryClient,
  );
}

export function useHomeWorkspaces() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.workspaces(),
      queryFn: () => api.workspaces(),
    },
    queryClient,
  );
}

export function useHomeDoctorSummaries(workspaceIds: string[]) {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.doctorSummaries(workspaceIds),
      queryFn: async () => {
        if (!workspaceIds.length) return {};
        const summaries = await api.workspaceDoctorSummaries(workspaceIds);
        return Object.fromEntries(summaries.map((summary) => [summary.workspace_id, summary]));
      },
    },
    queryClient,
  );
}

export function useHomeInstallations() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.installations(),
      queryFn: () => api.agentInstallations(),
    },
    queryClient,
  );
}

export function useHomeCatalog() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.catalog(),
      queryFn: () => api.catalogAssets(),
    },
    queryClient,
  );
}

export function useHomeMemories() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.memories(),
      queryFn: () => api.globalMemories(),
    },
    queryClient,
  );
}

export function useHomeActivity() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.activity(),
      queryFn: () => api.activity(),
    },
    queryClient,
  );
}

export function useHomeDiscovery() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.discovery(),
      queryFn: () => api.discoveryReport(),
    },
    queryClient,
  );
}

export function useHomeInsightsSummary() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.insightsSummary(),
      queryFn: () => api.insightsSummary(),
    },
    queryClient,
  );
}

export function useHomeRefreshJobs() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.refreshJobs(),
      queryFn: () => api.refreshStatus(),
      staleTime: 0,
    },
    queryClient,
  );
}

export function useHomeRemoteGateways() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.remoteGateways(),
      queryFn: () => api.remoteGateways(),
    },
    queryClient,
  );
}

export function useHomeScanRoots() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.scanRoots(),
      queryFn: () => api.scanRoots(),
    },
    queryClient,
  );
}

export function useHomeExcluded() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.excluded(),
      queryFn: () => api.excludedWorkspaces(),
    },
    queryClient,
  );
}

export function useHomeInsightsStatus() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.insightsStatus(),
      queryFn: () => api.insightsStatus(),
    },
    queryClient,
  );
}

export function useHomeDoctorReport(workspaceId: string) {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: homeKeys.doctorReport(workspaceId),
      queryFn: () => api.workspaceDoctorReport(workspaceId),
      staleTime: 0,
    },
    queryClient,
  );
}

export function useHomeQueryEvents() {
  const queryClient = useOptionalQueryClient();
  useEffect(() => {
    const unlisten = desktopApi().events.onRefreshState((status) => {
      queryClient.setQueryData<RefreshJobStatus[]>(homeKeys.refreshJobs(), (current = []) => [
        ...current.filter((job) => job.kind !== status.kind),
        status,
      ]);
      if (status.state !== "succeeded") return;
      if (status.kind === "discovery" || status.kind === "insights") {
        void queryClient.invalidateQueries({ queryKey: homeKeys.all });
      }
      if (status.kind === "gateways") {
        void queryClient.invalidateQueries({ queryKey: homeKeys.remoteGateways() });
      }
      if (status.kind === "storage") {
        void queryClient.invalidateQueries({ queryKey: homeKeys.all });
      }
    });
    return unlisten;
  }, [queryClient]);
}
