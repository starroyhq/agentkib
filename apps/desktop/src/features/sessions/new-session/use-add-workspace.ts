import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/core/api";
import { useI18n } from "@/core/useI18n";
import { homeKeys } from "@/features/home/home-query";

/**
 * Adds a workspace from a folder the user picks, without opening it: the new-session composer
 * chooses it and stays where it is. Resolves to its id, or nothing when the picker is cancelled.
 */
export function useAddWorkspace() {
  const { tr } = useI18n();
  const queryClient = useQueryClient();
  return async () => {
    const selected = await api.pickDirectory(tr("dialog.addWorkspace"));
    if (typeof selected !== "string") return undefined;
    const workspace = await api.addWorkspace(selected);
    await queryClient.invalidateQueries({ queryKey: homeKeys.all });
    return workspace.id;
  };
}
