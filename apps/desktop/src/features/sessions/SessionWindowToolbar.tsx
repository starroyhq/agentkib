import { cn } from "cn";
import { navigationStyles } from "@/components/navigationStyles";
import {
  ArrowUpRight,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuSeparator,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useHistoryContinuation } from "./useHistoryContinuation";
import { useSessionHub } from "./SessionHubContext";
import { hasDesktopConversation } from "@/core/conversation-bridge";
import { useSessionViewStore } from "./session-view-store";
import { claudeConnectionCopy } from "./conversation/features/sessions/claude-connection-copy";

export function SessionWindowToolbar() {
  const { tr, locale } = useI18n();
  const hub = useSessionHub();
  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  const creating = useSessionViewStore((state) => state.creatingConversation);
  const terminalEntry = useSessionViewStore((state) => state.terminalEntry);
  const createConversation = () => {
    useSessionViewStore.getState().setCreatingConversation(true);
    hub.select();
  };
  const { canContinue, continueSession } = useHistoryContinuation(
    selected,
    workspace,
    hub.historyRevision,
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
  const interactive =
    hasDesktopConversation() &&
    !selected.remote &&
    selected.availability === "readable" &&
    ["codex", "claude-code", "antigravity"].includes(selected.agent);
  const canConnectTerminal =
    interactive &&
    hub.ready &&
    selected.agent === "claude-code" &&
    document.documentElement.dataset.platform === "macos" &&
    terminalEntry?.sessionId === selected.id;
  return (
    <div
      data-session-window-session={interactive ? selected.id : undefined}
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
      {interactive && (
        <div
          data-session-window-status-slot
          className="hidden min-w-0 shrink items-center sm:flex empty:hidden"
        />
      )}
      <div className="session-window-actions flex shrink-0 items-center gap-2">
        {hasDesktopConversation() && hub.localEnabled && (
          <Button
            variant="outline"
            size="icon"
            className="max-[1050px]:hidden"
            aria-label={tr("sessions.newConversation")}
            title={tr("sessions.newConversation")}
            onClick={createConversation}
          >
            <Plus size={17} />
          </Button>
        )}
        {interactive && (
          <div data-session-window-files-slot className="flex shrink-0 items-center empty:hidden" />
        )}
        {canContinue && (
          <Button
            variant="outline"
            size="icon"
            className="max-[1050px]:hidden"
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
          className="max-[1050px]:hidden"
          disabled={hub.refreshing}
          aria-label={tr("sessions.refresh")}
          title={tr("sessions.refresh")}
          onClick={() => void hub.refresh()}
        >
          <RefreshCw size={15} className={hub.refreshing ? "animate-spin" : ""} />
        </Button>
      </div>
      {interactive && (
        <div data-session-window-pending-slot className="flex shrink-0 items-center empty:hidden" />
      )}
      <div className="session-window-menu block shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger
            className={navigationStyles.appToolbarMore}
            aria-label={tr("common.moreActions")}
            data-dialog-return-focus="true"
          >
            <MoreHorizontal size={18} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              {hasDesktopConversation() && hub.localEnabled && (
                <DropdownMenuItem onClick={createConversation}>
                  <Plus size={15} />
                  {tr("sessions.newConversation")}
                </DropdownMenuItem>
              )}
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
            </DropdownMenuGroup>
            {interactive && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  {canConnectTerminal && (
                    <DropdownMenuItem
                      onClick={() => {
                        const entry = useSessionViewStore.getState().terminalEntry;
                        if (entry === terminalEntry && entry?.sessionId === selected.id)
                          entry.open();
                      }}
                    >
                      <Terminal size={15} />
                      {claudeConnectionCopy[locale].title}…
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() =>
                      useSessionViewStore.getState().requestPanel(selected.id, "actions")
                    }
                  >
                    <SlidersHorizontal size={15} />
                    {tr("sessions.conversationActions")}…
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem
                onClick={() => {
                  useSessionViewStore.getState().setCreatingConversation(false);
                  hub.select();
                }}
              >
                <LayoutDashboard size={15} />
                {tr("sessions.backOverview")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
