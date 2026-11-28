import { useQuery } from "@tanstack/react-query";
import { retryBusyRead } from "@agentkib/session-ui";
import { api } from "@/core/api";
import { busyReadQueryOptions } from "@/core/read-query";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";

export const settingsKeys = {
  all: ["settings"] as const,
  gitIdentities: () => [...settingsKeys.all, "git-identities"] as const,
  indexedWorkspaceCount: (workspaceIds: string[]) =>
    [...settingsKeys.all, "indexed-workspace-count", workspaceIds] as const,
};

export function useGitIdentities() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      ...busyReadQueryOptions,
      queryKey: settingsKeys.gitIdentities(),
      queryFn: () => api.gitIdentities(),
    },
    queryClient,
  );
}

/** 已成功建立会话索引的工作区数量；key 含工作区 ID，工作区集合变化时重新统计。 */
export function useIndexedWorkspaceCount(workspaceIds: string[]) {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: settingsKeys.indexedWorkspaceCount(workspaceIds),
      queryFn: async ({ signal }) => {
        const statuses = await Promise.all(
          workspaceIds.map((workspaceId) =>
            retryBusyRead(() => api.workspaceSessionStatus(workspaceId), signal),
          ),
        );
        return statuses.filter((items) => items.some((item) => item.last_success_at)).length;
      },
    },
    queryClient,
  );
}
