import { useI18n } from "@/core/useI18n";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { cn } from "@/lib/utils";
import { Fragment, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { Ellipsis, Folder, FolderOpen, GitBranch, MessageSquare, Monitor, X } from "lucide-react";
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
import {
  normalizeDirectoryOrder,
  normalizeSessionDirectoryOrder,
  useSessionViewStore,
  type SessionRecordFilter,
} from "./session-view-store";
import {
  isInteractiveFork,
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceLabel,
} from "./session-labels";
import type { AgentKind, ConversationSessionSummary } from "@/core/types";
import { groupSessions } from "./session-catalog";

type DirectoryDragEntry =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "session"; workspaceId: string; sessionId: string };

function moveRelative<T>(
  items: T[],
  sourceId: string,
  targetId: string,
  after: boolean,
  getId: (item: T) => string,
) {
  const sourceIndex = items.findIndex((item) => getId(item) === sourceId);
  const targetIndex = items.findIndex((item) => getId(item) === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
  const next = [...items];
  const [source] = next.splice(sourceIndex, 1);
  const targetIndexAfterRemoval = next.findIndex((item) => getId(item) === targetId);
  next.splice(targetIndexAfterRemoval + Number(after), 0, source);
  return next;
}

function sessionOrder(sessions: ConversationSessionSummary[], ids: string[]) {
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...sessions].sort((left, right) => {
    const leftPosition = positions.get(left.id);
    const rightPosition = positions.get(right.id);
    if (leftPosition === undefined) return rightPosition === undefined ? 0 : -1;
    if (rightPosition === undefined) return 1;
    return leftPosition - rightPosition;
  });
}

export function SessionDirectory({
  onMenuOpenChange,
}: { onMenuOpenChange?: (open: boolean) => void } = {}) {
  const { formatDateTime, tr } = useI18n();
  const hub = useSessionHub();
  const view = useSessionViewStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const draggedEntry = useRef<DirectoryDragEntry | null>(null);
  const [draggingId, setDraggingId] = useState<string>();
  const [dropTargetId, setDropTargetId] = useState<string>();
  const [dropAfter, setDropAfter] = useState(false);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = useSessionViewStore.getState().scrollTop;
  }, [hub.ready]);
  const agents = [...new Set(hub.sessions.map((session) => session.agent))];
  const groups = groupSessions(hub.filtered, hub.workspaces);
  const allGroups = groupSessions(hub.sessions, hub.workspaces);
  const completeWorkspaceOrder = normalizeDirectoryOrder(
    view.workspaceOrder,
    hub.workspaces.map((workspace) => workspace.id),
  );
  const workspacePositions = new Map(completeWorkspaceOrder.map((id, index) => [id, index]));
  const orderedGroups = [...groups].sort((left, right) => {
    const leftHost = left.workspace.remote?.host_id ?? "";
    const rightHost = right.workspace.remote?.host_id ?? "";
    const hostOrder = leftHost.localeCompare(rightHost);
    if (hostOrder !== 0) return hostOrder;
    const leftPosition = workspacePositions.get(left.workspace.id);
    const rightPosition = workspacePositions.get(right.workspace.id);
    if (leftPosition === undefined) return rightPosition === undefined ? 0 : 1;
    if (rightPosition === undefined) return -1;
    return leftPosition - rightPosition;
  });
  const startDrag = (event: DragEvent, entry: DirectoryDragEntry, draggingKey: string) => {
    draggedEntry.current = entry;
    setDraggingId(draggingKey);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", draggingKey);
  };
  const finishDrag = () => {
    draggedEntry.current = null;
    setDraggingId(undefined);
    setDropTargetId(undefined);
    setDropAfter(false);
  };
  const allowDrop = (event: DragEvent, target: DirectoryDragEntry) => {
    const source = draggedEntry.current;
    if (!source || source.kind !== target.kind) return;
    if (target.kind === "session" && source.workspaceId !== target.workspaceId) return;
    if (target.kind === "workspace") {
      const sourceWorkspace = hub.workspaces.find((item) => item.id === source.workspaceId);
      const targetWorkspace = hub.workspaces.find((item) => item.id === target.workspaceId);
      if (
        (sourceWorkspace?.remote?.host_id ?? "local") !==
        (targetWorkspace?.remote?.host_id ?? "local")
      )
        return;
    }
    const sourceId = source.kind === "workspace" ? source.workspaceId : source.sessionId;
    const targetId = target.kind === "workspace" ? target.workspaceId : target.sessionId;
    if (sourceId === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetId(targetId);
    setDropAfter(
      event.clientY >=
        event.currentTarget.getBoundingClientRect().top +
          event.currentTarget.getBoundingClientRect().height / 2,
    );
  };
  const dropBefore = (event: DragEvent, target: DirectoryDragEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const source = draggedEntry.current;
    if (!source || source.kind !== target.kind) return;
    if (source.kind === "workspace" && target.kind === "workspace") {
      const sourceWorkspace = hub.workspaces.find((item) => item.id === source.workspaceId);
      const targetWorkspace = hub.workspaces.find((item) => item.id === target.workspaceId);
      if (
        (sourceWorkspace?.remote?.host_id ?? "local") !==
        (targetWorkspace?.remote?.host_id ?? "local")
      ) {
        finishDrag();
        return;
      }
      const completeOrder = normalizeDirectoryOrder(
        view.workspaceOrder,
        hub.workspaces.map((workspace) => workspace.id),
      );
      view.setWorkspaceOrder(
        moveRelative(completeOrder, source.workspaceId, target.workspaceId, dropAfter, (id) => id),
      );
    } else if (
      source.kind === "session" &&
      target.kind === "session" &&
      source.workspaceId === target.workspaceId
    ) {
      const group = allGroups.find((item) => item.workspace.id === source.workspaceId);
      if (group) {
        const completeOrder = normalizeSessionDirectoryOrder(
          view.sessionOrder[source.workspaceId] ?? [],
          group.sessions.map((session) => session.id),
        );
        view.setSessionOrder(
          source.workspaceId,
          moveRelative(completeOrder, source.sessionId, target.sessionId, dropAfter, (id) => id),
        );
      }
    }
    finishDrag();
  };
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
        {orderedGroups.map(({ workspace, sessions: workspaceSessions, label }, index) => {
          const sessions = sessionOrder(workspaceSessions, view.sessionOrder[workspace.id] ?? []);
          return (
            <Fragment key={workspace.id}>
              {!!hub.remoteHosts?.length &&
                view.host === "all" &&
                (index === 0 ||
                  orderedGroups[index - 1].workspace.remote?.host_id !==
                    workspace.remote?.host_id) && (
                  <div className="session-host-heading">
                    <Monitor size={14} aria-hidden="true" />
                    <strong>{workspace.remote?.host_name ?? tr("sessions.local")}</strong>
                    {workspace.remote && (
                      <small>
                        {tr(
                          workspace.remote.online ? "remote.state.online" : "remote.state.offline",
                        )}
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
                    <Button
                      variant="bare"
                      size="content"
                      draggable
                      className={cn(
                        "session-workspace-heading session-directory-draggable",
                        draggingId === `workspace:${workspace.id}` && "session-directory-dragging",
                        dropTargetId === workspace.id &&
                          (dropAfter
                            ? "session-directory-drop-after"
                            : "session-directory-drop-before"),
                      )}
                      onDragStart={(event) =>
                        startDrag(
                          event,
                          { kind: "workspace", workspaceId: workspace.id },
                          `workspace:${workspace.id}`,
                        )
                      }
                      onDragEnd={finishDrag}
                      onDragOver={(event) =>
                        allowDrop(event, { kind: "workspace", workspaceId: workspace.id })
                      }
                      onDrop={(event) =>
                        dropBefore(event, { kind: "workspace", workspaceId: workspace.id })
                      }
                    />
                  }
                  title={workspace.path ? `${workspace.name}\n${workspace.path}` : workspace.name}
                >
                  {sessionCollection(workspace.id) ? (
                    <MessageSquare size={16} aria-hidden="true" />
                  ) : view.collapsed[workspace.id] ? (
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
                      draggable
                      className={cn(
                        "session-directory-item session-directory-draggable",
                        draggingId === `session:${session.id}` && "session-directory-dragging",
                        dropTargetId === session.id &&
                          (dropAfter
                            ? "session-directory-drop-after"
                            : "session-directory-drop-before"),
                      )}
                      onDragStart={(event) =>
                        startDrag(
                          event,
                          { kind: "session", workspaceId: workspace.id, sessionId: session.id },
                          `session:${session.id}`,
                        )
                      }
                      onDragEnd={finishDrag}
                      onDragOver={(event) =>
                        allowDrop(event, {
                          kind: "session",
                          workspaceId: workspace.id,
                          sessionId: session.id,
                        })
                      }
                      onDrop={(event) =>
                        dropBefore(event, {
                          kind: "session",
                          workspaceId: workspace.id,
                          sessionId: session.id,
                        })
                      }
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
          );
        })}
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
