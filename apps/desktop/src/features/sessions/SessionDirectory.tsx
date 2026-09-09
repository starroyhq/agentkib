import { useI18n } from "@/core/useI18n";
import { Fragment, useLayoutEffect, useRef } from "react";
import { Ellipsis, Folder, FolderOpen, GitBranch, Monitor, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore, type SessionRecordFilter } from "./session-view-store";
import {
  isInteractiveFork,
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceLabel,
} from "./session-labels";
import type { AgentKind } from "@/core/types";
import { groupSessions } from "./session-catalog";

export function SessionDirectory({
  onMenuOpenChange,
}: { onMenuOpenChange?: (open: boolean) => void } = {}) {
  const { formatDateTime, tr } = useI18n();
  const hub = useSessionHub();
  const view = useSessionViewStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = useSessionViewStore.getState().scrollTop;
  }, [hub.ready]);
  const agents = [...new Set(hub.sessions.map((session) => session.agent))];
  const groups = groupSessions(hub.filtered, hub.workspaces);
  return (
    <div className="session-directory" aria-label={tr("sessions.directory")}>
      <div className="session-directory-controls">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">
            {tr("sessions.directory")}
          </span>
          <DropdownMenu onOpenChange={onMenuOpenChange}>
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="icon-sm" />}
              aria-label={tr("sessions.directoryOptions")}
              disabled={!hub.enabled}
            >
              <Ellipsis size={18} aria-hidden="true" />
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
                checked={view.showAuxiliary}
                onCheckedChange={(checked) => view.setShowAuxiliary(checked === true)}
              >
                {tr("conversations.showAuxiliary")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={
                  view.agent === "all" &&
                  view.filter === "current" &&
                  view.host === "all" &&
                  !view.showAuxiliary
                }
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
      <div
        className="session-directory-tree"
        ref={scrollRef}
        onScroll={(event) => view.setScrollTop(event.currentTarget.scrollTop)}
      >
        {groups.map(({ workspace, sessions, label }, index) => (
          <Fragment key={workspace.id}>
            {!!hub.remoteHosts?.length &&
              view.host === "all" &&
              (index === 0 ||
                groups[index - 1].workspace.remote?.host_id !== workspace.remote?.host_id) && (
                <div className="session-host-heading">
                  <Monitor size={14} aria-hidden="true" />
                  <strong>{workspace.remote?.host_name ?? tr("sessions.local")}</strong>
                  {workspace.remote && (
                    <small>
                      {tr(workspace.remote.online ? "remote.state.online" : "remote.state.offline")}
                    </small>
                  )}
                </div>
              )}
            <Collapsible
              className="session-workspace"
              key={workspace.id}
              open={!view.collapsed[workspace.id]}
              onOpenChange={() => view.toggleWorkspace(workspace.id)}
            >
              <CollapsibleTrigger
                render={
                  <Button variant="bare" size="content" className="session-workspace-heading" />
                }
                title={`${workspace.name}\n${workspace.path}`}
              >
                {view.collapsed[workspace.id] ? (
                  <Folder size={16} aria-hidden="true" />
                ) : (
                  <FolderOpen size={16} aria-hidden="true" />
                )}
                <strong>{label}</strong>
                <span>{sessions.length}</span>
              </CollapsibleTrigger>
              <CollapsibleContent
                className="session-workspace-items"
                inert={Boolean(view.collapsed[workspace.id])}
                aria-hidden={view.collapsed[workspace.id] || undefined}
              >
                {sessions.map((session) => (
                  <Button
                    variant="bare"
                    size="content"
                    key={session.id}
                    data-session-entry
                    className="session-directory-item"
                    aria-current={hub.selected?.id === session.id ? "page" : undefined}
                    onClick={() => hub.select(session.id)}
                    title={[
                      displaySessionTitle(session.title, tr),
                      `${sessionAgentNames[session.agent]} · ${sessionRecordLabel(session, tr)}`,
                      workspace.path,
                      sessionSourceLabel(session, hub.sessions, tr, formatDateTime),
                    ]
                      .filter(Boolean)
                      .join("\n")}
                  >
                    <AgentIcon agent={session.agent} compact />
                    <span>
                      <strong>{displaySessionTitle(session.title, tr)}</strong>
                    </span>
                    {isInteractiveFork(session) && (
                      <GitBranch
                        size={12}
                        aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, hub.sessions, tr, formatDateTime)}`}
                      />
                    )}
                  </Button>
                ))}
              </CollapsibleContent>
            </Collapsible>
          </Fragment>
        ))}
        {hub.enabled && !hub.loading && !groups.length && (
          <div className="session-directory-empty">
            <p>{tr(hub.sessions.length ? "sessions.noMatches" : "sessions.noSessions")}</p>
            {hub.sessions.length > 0 && (
              <Button variant="ghost" onClick={view.resetFilters}>
                {tr("sessions.clearFilters")}
              </Button>
            )}
          </div>
        )}
        {hub.loading && (
          <p className="session-directory-empty" role="status">
            {tr("conversations.scanning")}
          </p>
        )}
      </div>
    </div>
  );
}
