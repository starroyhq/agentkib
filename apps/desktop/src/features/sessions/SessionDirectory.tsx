import { useI18n } from "@/core/useI18n";
import { sessionCollection } from "@agentkib/runtime-protocol";
import { cn } from "cn";
import { Fragment, useEffect, useLayoutEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Folder, FolderOpen, MessageSquare, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import {
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceLabel,
  worktreeLabel,
} from "./session-labels";
import { SessionDirectoryControls } from "./SessionDirectoryControls";
import { sessionOrder, useSessionDirectoryOrder } from "./useSessionDirectoryOrder";
import { SessionDirectoryEntry } from "./SessionDirectoryEntry";
import { SessionRowMenu } from "./SessionRowMenu";
import { SessionDirectorySourceNotices } from "./SessionSourceNotices";
import { WorktreeMark } from "./WorktreeMark";

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
  // A revealed session can sit in its repository's group rather than its own workspace's.
  const revealed = useSessionViewStore((state) => state.revealedSessionId);
  const revealedGroup = revealed
    ? groups.find((group) => group.sessions.some((session) => session.id === revealed))?.id
    : undefined;
  useEffect(() => {
    if (revealedGroup) useSessionViewStore.getState().expandRevealed(revealedGroup);
  }, [revealedGroup]);

  return (
    <div
      className="session-directory flex min-w-0 min-h-0 flex-1 flex-col text-sm [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-ring [&_button:focus-visible]:outline-offset-2"
      aria-label={tr("sessions.directory")}
    >
      <SessionDirectoryControls onMenuOpenChange={onMenuOpenChange} />
      <div
        className="session-directory-tree min-h-0 flex-1 overflow-auto overscroll-contain px-1 pb-3 [scrollbar-width:thin]"
        ref={scrollRef}
        onScroll={(event) => view.setScrollTop(event.currentTarget.scrollTop)}
      >
        <p id="session-directory-reorder-hint" className="sr-only">
          {tr("sessions.reorderHint")}
        </p>
        {hub.statuses?.some((status) => status.error_key) && <SessionDirectorySourceNotices />}
        {orderedGroups.map((group, index) => {
          const { workspace, sessions: workspaceSessions, label } = group;
          const sessions = sessionOrder(workspaceSessions, view.sessionOrder[group.id] ?? []);
          const worktreeNames = group.worktrees.join("\n");
          return (
            <Fragment key={group.id}>
              {!!hub.remoteHosts?.length &&
                view.host === "all" &&
                (index === 0 ||
                  orderedGroups[index - 1].workspace.remote?.host_id !==
                    workspace.remote?.host_id) && (
                  <div className="session-host-heading flex items-center gap-2 px-3 pt-3 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
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
                className="session-workspace mb-1.5"
                key={group.id}
                open={!view.collapsed[group.id]}
                onOpenChange={() => view.toggleWorkspace(group.id)}
              >
                <CollapsibleTrigger
                  render={
                    <Button
                      variant="bare"
                      size="content"
                      draggable
                      className={cn(
                        "session-workspace-heading session-directory-draggable flex min-h-10 w-full items-center gap-2 rounded-xl border border-transparent px-3 py-2 text-left transition-colors hover:border-sidebar-border hover:bg-sidebar-accent/70 cursor-grab active:cursor-grabbing [&_svg]:shrink-0 [&_strong]:min-w-0 [&_strong]:truncate [&_strong]:font-semibold [&_span]:text-muted-foreground",
                        draggingId === `workspace:${group.id}` &&
                          "session-directory-dragging opacity-[0.45]",
                        dropTargetId === group.id &&
                          (dropAfter
                            ? "session-directory-drop-after bg-sidebar-accent shadow-[inset_0_-2px_0_var(--ring)]"
                            : "session-directory-drop-before bg-sidebar-accent shadow-[inset_0_2px_0_var(--ring)]"),
                      )}
                      onDragStart={(event) =>
                        startDrag(
                          event,
                          { kind: "workspace", workspaceId: group.id },
                          `workspace:${group.id}`,
                        )
                      }
                      onDragEnd={finishDrag}
                      onDragOver={(event) =>
                        allowDrop(event, { kind: "workspace", workspaceId: group.id })
                      }
                      onDrop={(event) =>
                        dropBefore(event, { kind: "workspace", workspaceId: group.id })
                      }
                      onKeyDown={(event) =>
                        moveByKeyboard(event, { kind: "workspace", workspaceId: group.id })
                      }
                      aria-describedby="session-directory-reorder-hint"
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    />
                  }
                  title={[
                    group.path ? `${group.name}\n${group.path}` : group.name,
                    group.worktree ? tr("sessions.worktree.group") : "",
                    group.worktrees.length
                      ? `${tr("workspace.worktrees", { count: group.worktrees.length })}\n${worktreeNames}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join("\n")}
                >
                  {sessionCollection(workspace.id) ? (
                    <MessageSquare size={16} aria-hidden="true" />
                  ) : view.collapsed[group.id] ? (
                    <Folder size={16} aria-hidden="true" />
                  ) : (
                    <FolderOpen size={16} aria-hidden="true" />
                  )}
                  <strong>{label}</strong>
                  {group.worktree && <WorktreeMark label={tr("sessions.worktree.group")} />}
                  {group.worktrees.length > 0 && (
                    <small
                      className="shrink-0 truncate text-xs text-muted-foreground"
                      title={worktreeNames}
                    >
                      · {tr("workspace.worktrees", { count: group.worktrees.length })}
                    </small>
                  )}
                  <span className="ml-auto">{sessions.length}</span>
                </CollapsibleTrigger>
                <CollapsibleContent
                  className="session-workspace-items h-[var(--collapsible-panel-height)] overflow-hidden border-l border-sidebar-border/70 pl-3 opacity-100 transition-[height,opacity] duration-[180ms] ease-out motion-reduce:transition-none data-[starting-style]:h-0 data-[starting-style]:opacity-0 data-[ending-style]:h-0 data-[ending-style]:opacity-0"
                  inert={Boolean(view.collapsed[group.id])}
                  aria-hidden={view.collapsed[group.id] || undefined}
                >
                  {sessions.map((session) => {
                    const owner =
                      hub.workspaces.find((item) => item.id === session.workspace_id) ?? workspace;
                    return (
                      <div key={session.id} className="group/session flex items-center gap-1">
                        <Button
                          variant="bare"
                          size="content"
                          data-session-entry
                          draggable
                          className={cn(
                            "session-directory-item session-directory-draggable flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-sidebar-accent/70 cursor-grab active:cursor-grabbing [&>div]:shrink-0 [&>span]:grid [&>span]:min-w-0 [&>span]:flex-1 [&_strong]:truncate aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium",
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
                              { kind: "session", workspaceId: group.id, sessionId: session.id },
                              `session:${session.id}`,
                            )
                          }
                          onDragEnd={finishDrag}
                          onDragOver={(event) =>
                            allowDrop(event, {
                              kind: "session",
                              workspaceId: group.id,
                              sessionId: session.id,
                            })
                          }
                          onDrop={(event) =>
                            dropBefore(event, {
                              kind: "session",
                              workspaceId: group.id,
                              sessionId: session.id,
                            })
                          }
                          onKeyDown={(event) =>
                            moveByKeyboard(event, {
                              kind: "session",
                              workspaceId: group.id,
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
                            session.worktree ? worktreeLabel(session.worktree, tr) : owner.path,
                            session.origin === "execution" ? tr("sessions.executionSession") : "",
                            sessionSourceLabel(session, hub.sessions, tr, formatDateTime),
                          ]
                            .filter(Boolean)
                            .join("\n")}
                        >
                          <SessionDirectoryEntry
                            session={session}
                            sessions={hub.sessions}
                            selected={hub.selected?.id === session.id}
                          />
                        </Button>
                        {/* A paired host's sessions are managed on that host. */}
                        {!owner.remote && (
                          <SessionRowMenu
                            session={session}
                            onChanged={() => void hub.refresh()}
                            onDeleted={() => {
                              if (hub.selected?.id === session.id) hub.select(undefined, true);
                              void hub.refresh();
                            }}
                          />
                        )}
                      </div>
                    );
                  })}
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
