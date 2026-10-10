import { DesktopHistorySearch } from "./DesktopHistorySearch";
import { useShallow } from "zustand/react/shallow";
import { SlidersHorizontal, X } from "lucide-react";
import { useI18n } from "@/core/useI18n";
import type { AgentKind } from "@/core/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
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
      setAgent: state.setAgent,
      setFilter: state.setFilter,
      setHost: state.setHost,
      resetFilters: state.resetFilters,
    })),
  );
  const agents = [...new Set(hub.sessions.map((session) => session.agent))];
  const activeFilterCount =
    Number(view.agent !== "all") + Number(view.filter !== "current") + Number(view.host !== "all");
  return (
    <div className="session-directory-controls grid gap-2.5 py-3 pb-2.5">
      <DesktopHistorySearch />
      <div className="flex min-h-8 items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">
          {tr("sessions.directory")}
        </span>
        <DropdownMenu onOpenChange={onMenuOpenChange}>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="sm" className="h-8 gap-2 px-2.5" />}
            aria-label={tr("sessions.directoryOptions")}
            data-session-directory-options=""
            disabled={!hub.enabled}
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span>{tr("sessions.filters")}</span>
            {activeFilterCount > 0 && (
              <span className="grid size-5 place-items-center rounded-full bg-primary text-[11px] text-primary-foreground">
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
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={view.agent === "all" && view.filter === "current" && view.host === "all"}
              onClick={view.resetFilters}
            >
              {tr("sessions.clearFilters")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {(view.agent !== "all" || view.filter !== "current" || view.host !== "all") && (
        <div className="flex flex-wrap gap-1.5">
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
        </div>
      )}
    </div>
  );
}
