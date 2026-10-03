import { useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";

export const workspaceKeys = {
  all: ["workspace"] as const,
  detail: (workspaceId: string) => [...workspaceKeys.all, workspaceId] as const,
  openers: (workspaceId: string) => [...workspaceKeys.detail(workspaceId), "openers"] as const,
  git: (workspaceId: string) => [...workspaceKeys.detail(workspaceId), "git"] as const,
  gitSummary: (workspaceId: string) => [...workspaceKeys.git(workspaceId), "summary"] as const,
  gitHistory: (workspaceId: string, filters: unknown) =>
    [...workspaceKeys.git(workspaceId), "history", filters] as const,
  gitCommitFiles: (workspaceId: string, oid: string) =>
    [...workspaceKeys.git(workspaceId), "commit-files", oid] as const,
  gitDiff: (workspaceId: string, request: unknown) =>
    [...workspaceKeys.git(workspaceId), "diff", request] as const,
};

export function useWorkspaceOpeners(workspaceId: string) {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: workspaceKeys.openers(workspaceId),
      queryFn: () => api.workspaceOpeners(workspaceId),
    },
    queryClient,
  );
}
