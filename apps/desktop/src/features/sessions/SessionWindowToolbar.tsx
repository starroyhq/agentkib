import { cn } from "@/lib/utils";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { navigationStyles } from "@/components/navigationStyles";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUpRight, LayoutDashboard, MoreHorizontal, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { canContinueFromHistory } from "@/features/agents/agent-capabilities";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useSessionSourceCapability } from "./useSessionSourceCapability";
import { useSessionHub } from "./SessionHubContext";

export function SessionWindowToolbar() {
  const { tr } = useI18n();
  const hub = useSessionHub();
  const navigate = useNavigate();
  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  const sourceCapability = useSessionSourceCapability(
    selected &&
      !sessionCollection(selected.workspace_id) &&
      !selected.remote &&
      selected.availability === "readable"
      ? selected.id
      : undefined,
  );
  if (!selected)
    return (
      <div className={navigationStyles.appToolbarContent}>
        <div className={navigationStyles.appToolbarBreadcrumb} aria-label={tr("common.breadcrumb")}>
          {tr("sessions.nav")}
        </div>
      </div>
    );
  const canContinue =
    workspace &&
    !sessionCollection(workspace.id) &&
    !selected.remote &&
    selected.availability === "readable" &&
    canContinueFromHistory(sourceCapability);
  const continueSession = () => {
    if (!canContinue) return;
    void navigate({
      to: "/workspace/$workspaceId/sessions",
      params: { workspaceId: workspace.id },
      search: { sessionId: selected.id },
    });
  };
  return (
    <div className={cn(navigationStyles.appToolbarContent, "session-window-toolbar")}>
      <AgentIcon agent={selected.agent} compact />
      <h1 className="session-window-title" title={displaySessionTitle(selected.title, tr)}>
        {displaySessionTitle(selected.title, tr)}
      </h1>
      <div className="session-window-actions">
        {canContinue && (
          <Button
            variant="outline"
            size="icon"
            aria-label={tr("sessions.continueWorkspace")}
            title={tr("sessions.continueWorkspace")}
            onClick={continueSession}
          >
            <ArrowUpRight size={15} />
          </Button>
        )}
        <Button
          variant="outline"
          size="icon"
          disabled={hub.refreshing}
          aria-label={tr("sessions.refresh")}
          title={tr("sessions.refresh")}
          onClick={() => void hub.refresh()}
        >
          <RefreshCw size={15} className={hub.refreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      <div className="session-window-menu">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={navigationStyles.appToolbarMore}
            aria-label={tr("common.moreActions")}
          >
            <MoreHorizontal size={18} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuItem onClick={() => hub.select()}>
              <LayoutDashboard size={15} />
              {tr("sessions.backOverview")}
            </DropdownMenuItem>
            {canContinue && (
              <DropdownMenuItem onClick={continueSession}>
                <ArrowUpRight size={15} />
                {tr("sessions.continueWorkspace")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={hub.refreshing} onClick={() => void hub.refresh()}>
              <RefreshCw size={15} />
              {tr("sessions.refresh")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
