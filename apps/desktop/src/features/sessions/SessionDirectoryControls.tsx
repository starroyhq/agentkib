import { DesktopHistorySearch } from "./DesktopHistorySearch";
import { readStateCopy } from "@agentkib/session-ui";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { Bell, ListFilter, SlidersHorizontal, X } from "lucide-react";
import { AGENT_KINDS } from "@/core/agents";
import type { AgentKind } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore, type SessionRecordFilter } from "./session-view-store";
import { SessionDirectoryAgentFilter } from "./SessionDirectoryAgentFilter";

export function SessionDirectoryControls({
  onAgentChange,
  onMenuOpenChange,
}: {
  onAgentChange: (agent: AgentKind | "all") => void;
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const { tr, locale } = useI18n();
  const hub = useSessionHub();
  const view = useSessionViewStore(
    useShallow((state) => ({
      agent: state.agent,
      filter: state.filter,
      unreadOnly: state.unreadOnly,
      host: state.host,
      execution: state.execution,
      collections: state.collections,
      setAgent: state.setAgent,
      setFilter: state.setFilter,
      setUnreadOnly: state.setUnreadOnly,
      setHost: state.setHost,
      setExecution: state.setExecution,
      setCollections: state.setCollections,
      resetFilters: state.resetFilters,
    })),
  );
  const { agents, unreadAgents } = useMemo(() => {
    const present = new Set<AgentKind>();
    const unreadAgents = new Set<AgentKind>();
    for (const session of hub.sessions) {
      present.add(session.agent);
      if (session.readState?.status === "unread") unreadAgents.add(session.agent);
    }
    return { agents: AGENT_KINDS.filter((agent) => present.has(agent)), unreadAgents };
  }, [hub.sessions]);
  const agent = view.agent;
  const setAgent = view.setAgent;
  const hasAgentFilter = agents.length > 1;
  const agentFilterAvailable = hasAgentFilter && (agent === "all" || agents.includes(agent));
  useEffect(() => {
    if (hub.ready && hub.enabled && agent !== "all" && !agentFilterAvailable) setAgent("all");
  }, [hub.ready, hub.enabled, agent, agentFilterAvailable, setAgent]);

  const activeFilterCount =
    Number(view.filter !== "current") +
    Number(view.host !== "all") +
    Number(view.execution) +
    Number(view.collections);
  const filtersActive = activeFilterCount > 0;
  return (
    <div
      className={`session-directory-controls grid pb-2 ${hasAgentFilter ? "gap-1 pt-0.5" : "gap-3 pt-3"}`}
    >
      <SessionDirectoryAgentFilter
        agents={agents}
        unreadAgents={unreadAgents}
        value={agentFilterAvailable ? agent : "all"}
        onChange={onAgentChange}
        disabled={!hub.enabled}
      />
      <div
        data-session-directory-toolbar
        className="flex min-h-9 items-center justify-between gap-2 pr-5.5 pl-3.5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ListFilter size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {tr("sessions.directory")}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className={`size-8 rounded-lg p-0 ${view.unreadOnly ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-label={readStateCopy(locale).pending}
            title={readStateCopy(locale).pending}
            aria-pressed={view.unreadOnly}
            disabled={!hub.enabled}
            onClick={() => view.setUnreadOnly(!view.unreadOnly)}
          >
            <Bell size={15} aria-hidden="true" fill={view.unreadOnly ? "currentColor" : "none"} />
          </Button>
          <DropdownMenu onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="relative size-8 rounded-lg p-0 text-muted-foreground hover:text-foreground"
                />
              }
              aria-label={tr("sessions.directoryOptions")}
              data-session-directory-options=""
              disabled={!hub.enabled}
            >
              <SlidersHorizontal size={15} aria-hidden="true" />
              {activeFilterCount > 0 && (
                <span className="absolute -top-1 -right-1 grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground">
                  {activeFilterCount}
                </span>
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48" positionerClassName="z-80">
              {!!hub.remoteHosts?.length && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>{tr("remote.hostFilter")}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-44" positionerClassName="z-80">
                    <DropdownMenuRadioGroup value={view.host} onValueChange={view.setHost}>
                      <DropdownMenuRadioItem value="all">
                        {tr("remote.allHosts")}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="local">
                        {tr("sessions.local")}
                      </DropdownMenuRadioItem>
                      {hub.remoteHosts.map((host) => (
                        <DropdownMenuRadioItem key={host.id} value={host.id}>
                          {host.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{tr("conversations.filterLabel")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44" positionerClassName="z-80">
                  <DropdownMenuRadioGroup
                    value={view.filter}
                    onValueChange={(value) => view.setFilter(value as SessionRecordFilter)}
                  >
                    {(["current", "archived", "metadata", "all"] as const).map((filter) => (
                      <DropdownMenuRadioItem key={filter} value={filter}>
                        {tr(`conversations.filter.${filter}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuCheckboxItem
                checked={view.execution}
                onCheckedChange={(checked) => view.setExecution(checked)}
              >
                {tr("sessions.showExecution")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={view.collections}
                onCheckedChange={(checked) => view.setCollections(checked)}
              >
                {tr("sessions.showCollections")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!filtersActive && !view.unreadOnly && agent === "all"}
                onClick={view.resetFilters}
              >
                {tr("sessions.clearFilters")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DesktopHistorySearch />
        </div>
      </div>
      {filtersActive && (
        <div className="flex flex-wrap gap-1.5 pr-5.5 pl-3.5">
          {view.host !== "all" && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-full px-2 text-xs"
              onClick={() => view.setHost("all")}
              aria-label={tr("remote.allHosts")}
            >
              {view.host === "local"
                ? tr("sessions.local")
                : (hub.remoteHosts?.find((host) => host.id === view.host)?.name ??
                  tr("remote.hostFilter"))}
              <X size={12} aria-hidden="true" />
            </Button>
          )}
          {view.filter !== "current" && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-full px-2 text-xs"
              aria-label={`${tr("sessions.clearRecordFilter")}: ${tr(`conversations.filter.${view.filter}`)}`}
              disabled={!hub.enabled}
              onClick={() => view.setFilter("current")}
            >
              {tr(`conversations.filter.${view.filter}`)}
              <X size={12} aria-hidden="true" />
            </Button>
          )}
          {view.execution && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-full px-2 text-xs"
              aria-label={`${tr("sessions.hideExecution")}: ${tr("sessions.executionSession")}`}
              disabled={!hub.enabled}
              onClick={() => view.setExecution(false)}
            >
              {tr("sessions.executionSession")}
              <X size={12} aria-hidden="true" />
            </Button>
          )}
          {view.collections && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-full px-2 text-xs"
              aria-label={`${tr("sessions.hideCollections")}: ${tr("sessions.collectionSession")}`}
              disabled={!hub.enabled}
              onClick={() => view.setCollections(false)}
            >
              {tr("sessions.collectionSession")}
              <X size={12} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
