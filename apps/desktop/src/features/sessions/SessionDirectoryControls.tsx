import { DesktopHistorySearch } from "./DesktopHistorySearch";
import { useShallow } from "zustand/react/shallow";
import { ListFilter, SlidersHorizontal, X } from "lucide-react";
import { useI18n } from "@/core/useI18n";
import type { AgentKind } from "@/core/types";
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
import { sessionAgentNames } from "./session-labels";

export function SessionDirectoryControls({
  onMenuOpenChange,
}: {
  onMenuOpenChange?: (open: boolean) => void;
}) {
  const { tr } = useI18n();
  const hub = useSessionHub();
  const view = useSessionViewStore(
    useShallow((state) => ({
      agent: state.agent,
      filter: state.filter,
      host: state.host,
      execution: state.execution,
      setAgent: state.setAgent,
      setFilter: state.setFilter,
      setHost: state.setHost,
      setExecution: state.setExecution,
      resetFilters: state.resetFilters,
    })),
  );
  const agents = [...new Set(hub.sessions.map((session) => session.agent))];
  const activeFilterCount =
    Number(view.agent !== "all") +
    Number(view.filter !== "current") +
    Number(view.host !== "all") +
    Number(view.execution);
  const filtersActive = activeFilterCount > 0;
  return (
    <div className="session-directory-controls grid gap-3 px-1 pt-3 pb-2">
      <DesktopHistorySearch />
      <div
        data-session-directory-toolbar
        className="flex min-h-9 items-center justify-between gap-2 px-1.5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <ListFilter size={15} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {tr("sessions.directory")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            data-session-directory-pending-slot
            className="flex size-9 shrink-0 items-center justify-center"
          />
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
                <DropdownMenuSubTrigger>{tr("conversations.agentFilter")}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-44" positionerClassName="z-80">
                  <DropdownMenuRadioGroup
                    value={view.agent}
                    onValueChange={(value) => view.setAgent(value as AgentKind | "all")}
                  >
                    <DropdownMenuRadioItem value="all">
                      {tr("sessions.allAgents")}
                    </DropdownMenuRadioItem>
                    {[...new Set([...agents, ...(view.agent === "all" ? [] : [view.agent])])].map(
                      (agent) => (
                        <DropdownMenuRadioItem key={agent} value={agent}>
                          {sessionAgentNames[agent]}
                        </DropdownMenuRadioItem>
                      ),
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!filtersActive} onClick={view.resetFilters}>
                {tr("sessions.clearFilters")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {filtersActive && (
        <div className="flex flex-wrap gap-1.5 px-1.5">
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
          {view.agent !== "all" && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 rounded-full px-2 text-xs"
              aria-label={`${tr("sessions.clearAgentFilter")}: ${sessionAgentNames[view.agent]}`}
              disabled={!hub.enabled}
              onClick={() => view.setAgent("all")}
            >
              {sessionAgentNames[view.agent]}
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
        </div>
      )}
    </div>
  );
}
