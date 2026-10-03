import { useQuery } from "@tanstack/react-query";
import { api } from "@/core/api";
import { queryDefaults, useOptionalQueryClient } from "@/features/home/home-query";

export const obsidianKeys = {
  integration: () => ["obsidian", "integration"] as const,
};

/**
 * 设置页和工作区页共用同一份 Obsidian 集成状态。staleTime 为 0：
 * 每次挂载仍会重新检查安装与 vault（用户可能在应用外改动），但先显示缓存。
 */
export function useObsidianIntegration() {
  const queryClient = useOptionalQueryClient();
  return useQuery(
    {
      ...queryDefaults,
      queryKey: obsidianKeys.integration(),
      queryFn: () => api.obsidianIntegration(),
      staleTime: 0,
    },
    queryClient,
  );
}
