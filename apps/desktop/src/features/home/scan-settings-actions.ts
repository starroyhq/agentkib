import { toast } from "sonner";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { isBusyRead } from "@agentkib/session-ui";
import { api } from "@/core/api";
import { tr } from "@/core/i18n";
import type { ExcludedWorkspace, ScanRoot } from "@/core/types";
import { homeKeys } from "./home-query";

export function scanSettingsActions(queryClient: QueryClient) {
  const refreshDiscovery = async (): Promise<void> => {
    try {
      // The host retries read-lane admission before doing any scanning.
      await api.requestRefresh("discovery", true);
    } catch (error) {
      if (isBusyRead(error)) {
        toast.warning(tr("workspace.discoveryBusy"), {
          id: "scan-settings-discovery",
          action: { label: tr("runtime.retry"), onClick: () => void refreshDiscovery() },
        });
      } else {
        toast.error(tr("workspace.discoveryFailed"), { id: "scan-settings-discovery" });
      }
      return;
    }
    toast.dismiss("scan-settings-discovery");
  };

  function committed<Row>(message: string, queryKey: QueryKey, update: (rows: Row[]) => Row[]) {
    toast.success(tr(message));
    void queryClient.cancelQueries({ queryKey }).then(() => {
      queryClient.setQueryData<Row[]>(queryKey, (rows) => (rows ? update(rows) : rows));
      return queryClient.invalidateQueries({ queryKey });
    });
    void refreshDiscovery();
  }

  return {
    async addRoot() {
      const selected = await api.pickDirectory(tr("dialog.addScanRoot"));
      if (typeof selected !== "string") return;
      const root = await api.addScanRoot(selected, 5);
      committed<ScanRoot>("settings.scanRootAdded", homeKeys.scanRoots(), (rows) => [
        ...rows.filter((row) => row.id !== root.id),
        root,
      ]);
    },
    async removeRoot(id: string) {
      await api.removeScanRoot(id);
      committed<ScanRoot>("settings.scanRootRemoved", homeKeys.scanRoots(), (rows) =>
        rows.filter((row) => row.id !== id),
      );
    },
    async restoreExcluded(path: string) {
      await api.restoreExcludedWorkspace(path);
      committed<ExcludedWorkspace>(
        "settings.excludedWorkspaceRestored",
        homeKeys.excluded(),
        (rows) => rows.filter((row) => row.path !== path),
      );
    },
  };
}
