import { useI18n } from "@/core/useI18n";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { cn } from "cn";
import { Fragment, useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Folder, FolderOpen, GitBranch, MessageSquare, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import {
  isInteractiveFork,
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceLabel,
} from "./session-labels";
import { SessionDirectoryControls } from "./SessionDirectoryControls";
import { sessionOrder, useSessionDirectoryOrder } from "./useSessionDirectoryOrder";

export function SessionDirectory({
  onMenuOpenChange,
}: { onMenuOpenChange?: (open: boolean) => void } = {}) {
  const { formatDateTime, tr } = useI18n();
  const hub = useSessionHub();
  const view = useSessionViewStore(
    useShallow((state) => ({
      agent: state.agent,
      filter: state.filter,
      collapsed: state.collapsed,
      host: state.host,
      sessionOrder: state.sessionOrder,
      toggleWorkspace: state.toggleWorkspace,
      resetFilters: state.resetFilters,
      setScrollTop: state.setScrollTop,
    })),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = useSessionViewStore.getState().scrollTop;
  }, [hub.ready]);
  const {
    groups,
    orderedGroups,
    draggingId,
    dropTargetId,
    dropAfter,
    startDrag,
    finishDrag,
    allowDrop,
    dropBefore,
    moveByKeyboard,
  } = useSessionDirectoryOrder(hub);

  return (
    <div
      className="session-directory flex min-w-0 min-h-0 flex-1 flex-col text-sm [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-ring [&_button:focus-visible]:outline-offset-2"
      aria-label={tr("sessions.directory")}
    >
      <SessionDirectoryControls onMenuOpenChange={onMenuOpenChange} />
      <div
        className="session-directory-tree min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-width:thin]"
        ref={scrollRef}
        onScroll={(event) => view.setScrollTop(event.currentTarget.scrollTop)}
      >
        <p id="session-directory-reorder-hint" className="sr-only">
          {tr("sessions.reorderHint")}
        </p>
        {orderedGroups.map(({ workspace, sessions: workspaceSessions, label }, index) => {
          const sessions = sessionOrder(workspaceSessions, view.sessionOrder[workspace.id] ?? []);
          return (
            <Fragment key={workspace.id}>
              {!!hub.remoteHosts?.length &&
                view.host === "all" &&
                (index === 0 ||
                  orderedGroups[index - 1].workspace.remote?.host_id !==
                    workspace.remote?.host_id) && (
                  <div className="session-host-heading flex items-center gap-[7px] px-[7px] pt-3 pb-1.5 text-xs text-muted-foreground">
                    <Monitor size={14} aria-hidden="true" />
                    <strong className="min-w-0 flex-1 truncate">
                      {workspace.remote?.host_name ?? tr("sessions.local")}
                    </strong>
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
                className="session-workspace mb-2"
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
                        "session-workspace-heading session-directory-draggable flex min-h-9 w-full items-center gap-[7px] rounded-lg px-[7px] py-[5px] text-left hover:bg-sidebar-accent cursor-grab active:cursor-grabbing [&_svg]:shrink-0 [&_strong]:min-w-0 [&_strong]:flex-1 [&_strong]:truncate [&_strong]:font-semibold [&_span]:text-muted-foreground",
                        draggingId === `workspace:${workspace.id}` &&
                          "session-directory-dragging opacity-[0.45]",
                        dropTargetId === workspace.id &&
                          (dropAfter
                            ? "session-directory-drop-after bg-sidebar-accent shadow-[inset_0_-2px_0_var(--ring)]"
                            : "session-directory-drop-before bg-sidebar-accent shadow-[inset_0_2px_0_var(--ring)]"),
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
                      onKeyDown={(event) =>
                        moveByKeyboard(event, { kind: "workspace", workspaceId: workspace.id })
                      }
                      aria-describedby="session-directory-reorder-hint"
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
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
                  className="session-workspace-items h-[var(--collapsible-panel-height)] overflow-hidden opacity-100 transition-[height,opacity] duration-[180ms] ease-out motion-reduce:transition-none data-[starting-style]:h-0 data-[starting-style]:opacity-0 data-[ending-style]:h-0 data-[ending-style]:opacity-0"
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
                        "session-directory-item session-directory-draggable flex min-h-9 w-full items-center gap-[9px] rounded-lg px-[9px] py-[7px] text-left hover:bg-sidebar-accent cursor-grab active:cursor-grabbing [&>div]:shrink-0 [&>span]:grid [&>span]:min-w-0 [&>span]:flex-1 [&_strong]:truncate aria-[current=page]:bg-[color-mix(in_srgb,var(--sidebar-accent)_82%,transparent)] aria-[current=page]:shadow-[inset_2px_0_0_var(--ring)]",
                        draggingId === `session:${session.id}` &&
                          "session-directory-dragging opacity-[0.45]",
                        dropTargetId === session.id &&
                          (dropAfter
                            ? "session-directory-drop-after bg-sidebar-accent shadow-[inset_0_-2px_0_var(--ring)]"
                            : "session-directory-drop-before bg-sidebar-accent shadow-[inset_0_2px_0_var(--ring)]"),
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
                      onKeyDown={(event) =>
                        moveByKeyboard(event, {
                          kind: "session",
                          workspaceId: workspace.id,
                          sessionId: session.id,
                        })
                      }
                      aria-describedby="session-directory-reorder-hint"
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
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
                        <strong
                          className={cn(
                            "truncate font-[550]",
                            hub.selected?.id === session.id && "font-[650]",
                          )}
                        >
                          {displaySessionTitle(session.title, tr)}
                        </strong>
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
        {hub.enabled && !hub.loading && !hub.catalogError && !groups.length && (
          <div className="session-directory-empty p-[18px_10px] text-center text-muted-foreground">
            <p>{tr(hub.sessions.length ? "sessions.noMatches" : "sessions.noSessions")}</p>
            {hub.sessions.length > 0 && (
              <Button variant="ghost" onClick={view.resetFilters}>
                {tr("sessions.clearFilters")}
              </Button>
            )}
          </div>
        )}
        {hub.loading && (
          <p
            className="session-directory-empty p-[18px_10px] text-center text-muted-foreground"
            role="status"
          >
            {tr("conversations.scanning")}
          </p>
        )}
      </div>
    </div>
  );
}
