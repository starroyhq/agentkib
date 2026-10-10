import { cn } from "cn";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { navigationStyles } from "@/components/navigationStyles";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRight,
  FolderOpen,
  LayoutDashboard,
  ListChecks,
  MoreHorizontal,
  Plus,
  RefreshCw,
} from "lucide-react";
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
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { useSessionViewStore } from "./session-view-store";
import { requestConversationPanel } from "./conversation-panel-commands";

export function SessionWindowToolbar() {
  const { tr } = useI18n();
  const hub = useSessionHub();
  const navigate = useNavigate();
  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  const creating = useSessionViewStore((state) => state.creatingConversation);
  const supportsEmbeddedConversation =
    hasDesktopConversation() &&
    !selected?.remote &&
    selected?.availability === "readable" &&
    ["codex", "claude-code", "antigravity"].includes(selected.agent);
  const createConversation = () => {
    useSessionViewStore.getState().setCreatingConversation(true);
    hub.select();
  };
  const historyId = selected?.indexedSessionIds ? selected.indexedSessionIds[0] : selected?.id;
  const sourceCapability = useSessionSourceCapability(
    selected && !selected.remote && selected.availability === "readable" ? historyId : undefined,
  );
  if (!selected)
    return (
      <div className={navigationStyles.appToolbarContent}>
        <div className={navigationStyles.appToolbarBreadcrumb} aria-label={tr("common.breadcrumb")}>
          {tr(creating ? "sessions.newConversation" : "sessions.nav")}
        </div>
        {hasDesktopConversation() && hub.localEnabled && (
          <Button
            variant="outline"
            size="icon"
            aria-label={tr("sessions.newConversation")}
            title={tr("sessions.newConversation")}
            onClick={createConversation}
          >
            <Plus size={17} />
          </Button>
        )}
      </div>
    );
  const canContinue =
    historyId &&
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
      search: { sessionId: historyId },
    });
  };
  return (
    <div
      className={cn(
        navigationStyles.appToolbarContent,
        "session-window-toolbar gap-2 [&>button]:shrink-0 [&>div]:shrink-0",
      )}
    >
      <AgentIcon agent={selected.agent} compact />
      <h1
        className="session-window-title min-w-0 flex-1 truncate text-sm font-semibold [-webkit-app-region:drag]"
        title={displaySessionTitle(selected.title, tr)}
      >
        {displaySessionTitle(selected.title, tr)}
      </h1>
      <div className="session-window-actions flex shrink-0 items-center gap-2 max-[1050px]:hidden">
        {hasDesktopConversation() && hub.localEnabled && (
          <Button
            variant="outline"
            size="icon"
            aria-label={tr("sessions.newConversation")}
            title={tr("sessions.newConversation")}
            onClick={createConversation}
          >
            <Plus size={17} />
          </Button>
        )}
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
      <div className="session-window-menu block shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={navigationStyles.appToolbarMore}
            aria-label={tr("common.moreActions")}
          >
            <MoreHorizontal size={18} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            {supportsEmbeddedConversation && (
              <>
                <DropdownMenuItem onClick={() => requestConversationPanel("files")}>
                  <FolderOpen size={15} />
                  {tr("sessions.filesAndArtifacts")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => requestConversationPanel("actions")}>
                  <ListChecks size={15} />
                  {tr("sessions.conversationActions")}
                </DropdownMenuItem>
              </>
            )}
            {hasDesktopConversation() && hub.localEnabled && (
              <DropdownMenuItem onClick={createConversation}>
                <Plus size={15} />
                {tr("sessions.newConversation")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => {
                useSessionViewStore.getState().setCreatingConversation(false);
                hub.select();
              }}
            >
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
