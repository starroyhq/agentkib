import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import type { RemoteGatewaySummary, WorkspaceSummary } from "@/core/types";
import { ChevronRight, FolderGit2 } from "lucide-react";
import { AgentSectionFeedback } from "./AgentSectionFeedback";
import { RemoteAgentGatewayDetails } from "./RemoteAgentGatewayDetails";

export function AgentWorkspacesPanel({
  workspaces,
  remoteGateways,
  loading,
  error,
  onOpen,
  onRetry,
}: {
  workspaces: WorkspaceSummary[];
  remoteGateways: RemoteGatewaySummary[];
  loading: boolean;
  error: boolean;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onRetry: () => void;
}) {
  const { tr } = useI18n();
  if (loading || error) return <AgentSectionFeedback error={error} onRetry={onRetry} />;

  return (
    <div className="grid gap-4 p-5">
      {workspaces.map((workspace) => (
        <Button
          variant="bare"
          size="content"
          className="grid min-h-[64px] w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-border bg-background px-3 py-2 text-left text-sm hover:bg-muted/30"
          key={workspace.id}
          onClick={() => void onOpen(workspace)}
        >
          <span className="grid size-8 place-items-center rounded-lg bg-muted/40">
            <FolderGit2 size={15} className="text-muted-foreground" />
          </span>
          <span className="min-w-0 truncate">
            <strong className="block truncate">{workspace.name}</strong>
            <small
              className="mt-1 block truncate text-xs text-muted-foreground"
              title={workspace.path}
            >
              {workspace.path}
            </small>
          </span>
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {tr("workspace.assetCount", { count: workspace.asset_count })}
            <ChevronRight size={15} />
          </span>
        </Button>
      ))}
      {remoteGateways.length > 0 && <RemoteAgentGatewayDetails gateways={remoteGateways} />}
      {!workspaces.length && !remoteGateways.length && (
        <div className="grid min-h-32 place-content-center justify-items-center gap-2 text-center text-muted-foreground">
          <FolderGit2 size={28} />
          <p className="text-sm">{tr("workspace.noMatch")}</p>
        </div>
      )}
    </div>
  );
}
