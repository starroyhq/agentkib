import { cn } from "cn";
import { SessionActivityButton, useDelayedBusy } from "@agentkib/session-ui";
import { isLiveSessionAgent } from "@agentkib/web-client";
import { navigationStyles } from "@/components/navigationStyles";
import {
  ArrowUpRight,
  LayoutDashboard,
  LoaderCircle,
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

export function SessionWindowToolbar() {
  const { locale, tr } = useI18n();
  const hub = useSessionHub();
  const selected = hub.selected;
  const workspace = hub.selectedWorkspace;
  const creating = useSessionViewStore((state) => state.creatingConversation);
  const terminalEntry = useSessionViewStore((state) => state.terminalEntry);
  const createConversation = () => {
    // Started from a session, the new one defaults to that session's workspace and Agent.
    useSessionViewStore
      .getState()
      .setCreatingConversation(
        true,
        selected && !selected.remote
          ? { workspaceId: selected.workspace_id, agent: selected.agent }
          : undefined,
      );
    hub.select();
  };
  const { canContinue, continueSession, checking } = useHistoryContinuation(
    selected,
    workspace,
    hub.historyRevision,
  );
  const showContinuationSpinner = useDelayedBusy(checking);
  if (!selected)
    return (
      <div className={navigationStyles.appToolbarContent}>
        <div className={navigationStyles.appToolbarBreadcrumb} aria-label={tr("common.breadcrumb")}>
          {tr(creating ? "sessions.newConversation" : "sessions.nav")}
        </div>
        <div data-session-window-pending-slot className="flex shrink-0 items-center empty:hidden" />
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
    isLiveSessionAgent(selected.agent);
  const terminal =
    interactive && terminalEntry?.sessionId === selected.id ? terminalEntry : undefined;
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
        <div data-session-window-status-slot className="flex shrink-0 items-center empty:hidden" />
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
              {(canContinue || checking) && (
                <DropdownMenuItem disabled={checking} onClick={continueSession}>
                  {showContinuationSpinner ? (
                    <LoaderCircle
                      className="size-[15px] animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  ) : (
                    <ArrowUpRight size={15} aria-hidden />
                  )}
                  {tr("handoff.create")}
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
                  {terminal && (
                    <DropdownMenuItem
                      className="data-disabled:pointer-events-auto"
                      disabled={!!terminal.disabledReason}
                      title={terminal.disabledReason}
                      onClick={() => {
                        const entry = useSessionViewStore.getState().terminalEntry;
                        if (
                          entry === terminal &&
                          entry.sessionId === selected.id &&
                          !entry.disabledReason
                        )
                          entry.open();
                      }}
                    >
                      <Terminal size={15} />
                      {terminal.title}…
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
      {interactive ? (
        <div
          data-session-window-activity-slot
          className="flex shrink-0 items-center empty:hidden"
        />
      ) : (
        <SessionActivityButton sessionId={selected.id} locale={locale} Button={Button} />
      )}
    </div>
  );
}
