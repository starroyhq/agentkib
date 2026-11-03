import { useI18n } from "@/core/useI18n";
import { sessionCollection } from "@agentkib/runtime-protocol";
import {
  sessionGroupActivity,
  sessionContinuationListState,
  SessionContinuationDot,
  PendingReviewLane,
} from "@agentkib/session-ui";
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
import { SessionDirectoryTrailing } from "./SessionDirectoryTrailing";
import { SessionDirectoryHoverCard } from "./SessionDirectoryHoverCard";
import { SessionDirectorySourceNotices } from "./SessionSourceNotices";

function directoryPosition(element: HTMLElement, scope: string) {
  const viewport = element.getBoundingClientRect();
  return {
    scope,
    scroll: element.scrollTop,
    anchors: Array.from(element.querySelectorAll<HTMLElement>("[data-directory-anchor]"))
      .map((node) => ({ node, box: node.getBoundingClientRect() }))
      .filter(({ box }) => box.height > 0 && box.bottom > viewport.top && box.top < viewport.bottom)
      .slice(0, 3)
      .map(({ node, box }) => ({ id: node.dataset.directoryAnchor!, top: box.top - viewport.top })),
  };
}

export function SessionDirectory({
  onMenuOpenChange,
}: { onMenuOpenChange?: (open: boolean) => void } = {}) {
  const { formatDateTime, locale, tr } = useI18n();
  const hub = useSessionHub();
  const view = useSessionViewStore(
    useShallow((state) => ({
      agent: state.agent,
      filter: state.filter,
      collapsed: state.collapsed,
      host: state.host,
      sessionOrder: state.sessionOrder,
      scrolled: state.scrollTop > 0,
      toggleWorkspace: state.toggleWorkspace,
      resetFilters: state.resetFilters,
      setScrollTop: state.setScrollTop,
    })),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const position = useRef<ReturnType<typeof directoryPosition> | undefined>(undefined);
  const positionScope = JSON.stringify([view.agent, view.filter, view.host]);
  const setScrollTop = view.setScrollTop;
  const directoryReady = hub.usable ?? hub.ready;
  useLayoutEffect(() => {
    if (!directoryReady) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = useSessionViewStore.getState().scrollTop;
    useSessionViewStore.getState().setScrollTop(element.scrollTop);
  }, [directoryReady]);
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
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !directoryReady) return;
    const previous = position.current;
    if (previous?.scope === positionScope && previous.scroll > 0) {
      const top = element.getBoundingClientRect().top;
      const nodes = Array.from(element.querySelectorAll<HTMLElement>("[data-directory-anchor]"));
      for (const anchor of previous.anchors) {
        const node = nodes.find((item) => item.dataset.directoryAnchor === anchor.id);
        const box = node?.getBoundingClientRect();
        if (!box || box.height <= 0) continue;
        element.scrollTop += box.top - top - anchor.top;
        break;
      }
    }
    position.current = directoryPosition(element, positionScope);
    setScrollTop(element.scrollTop);
  }, [hub.filtered, hub.workspaces, directoryReady, positionScope, setScrollTop]);
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
      <div
        className="session-directory-header relative shrink-0 pl-1 pr-3 after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-sidebar-border after:opacity-0 after:transition-opacity data-[scrolled=true]:after:opacity-100 motion-reduce:after:transition-none"
        data-scrolled={directoryReady && view.scrolled}
      >
        <SessionDirectoryControls onMenuOpenChange={onMenuOpenChange} />
        <PendingReviewLane
          sessions={hub.filtered}
          locale={locale}
          onSelect={hub.select}
          context={(row) => (row.remote ? `remote:${row.remote.host_id}` : "desktop-local")}
        />
      </div>
      <div
        className="session-directory-tree min-h-0 flex-1 overflow-auto overscroll-contain pl-2 pr-2 pb-3"
        ref={scrollRef}
        onScroll={(event) => {
          if (directoryReady && event.target === event.currentTarget) {
            position.current = directoryPosition(event.currentTarget, positionScope);
            view.setScrollTop(event.currentTarget.scrollTop);
          }
        }}
      >
        <p id="session-directory-reorder-hint" className="sr-only">
          {tr("sessions.reorderHint")}
        </p>
        {hub.statuses?.some((status) => status.error_key) && <SessionDirectorySourceNotices />}
        {orderedGroups.map((group, index) => {
          const { workspace, sessions: workspaceSessions, label } = group;
          const sessions = sessionOrder(workspaceSessions, view.sessionOrder[group.id] ?? []);
          const worktreeNames = group.worktrees.join("\n");
          const activity = sessionGroupActivity(sessions, locale);
          const groupDescription = [
            group.path ? `${group.name}\n${group.path}` : group.name,
            group.worktree ? tr("sessions.worktree.group") : "",
            group.worktrees.length
              ? `${tr("workspace.worktrees", { count: group.worktrees.length })}\n${worktreeNames}`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
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
                className="session-workspace mb-1"
                key={group.id}
                open={!view.collapsed[group.id]}
                onOpenChange={() => view.toggleWorkspace(group.id)}
              >
                <SessionDirectoryHoverCard
                  title={label}
                  details={[groupDescription.split("\n").slice(1).join("\n"), activity.label]
                    .filter(Boolean)
                    .join("\n")}
                  disabled={!!draggingId}
                >
                  <CollapsibleTrigger
                    data-directory-anchor={`workspace:${group.id}`}
                    render={
                      <Button
                        variant="bare"
                        size="content"
                        draggable
                        className={cn(
                          "session-workspace-heading session-directory-draggable flex min-h-8 w-full items-center justify-start gap-2 rounded-xl border border-transparent px-3 py-1 text-left transition-colors hover:bg-sidebar-accent/70 cursor-grab active:cursor-grabbing [&_svg]:shrink-0 [&_strong]:min-w-0 [&_strong]:truncate [&_strong]:font-semibold [&_span]:text-muted-foreground",
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
                    aria-description={groupDescription}
                  >
                    {sessionCollection(workspace.id) ? (
                      <MessageSquare size={16} aria-hidden="true" />
                    ) : view.collapsed[group.id] ? (
                      <Folder size={16} aria-hidden="true" />
                    ) : (
                      <FolderOpen size={16} aria-hidden="true" />
                    )}
                    <strong>{label}</strong>
                    {view.collapsed[group.id] && activity.label && (
                      <span className="ml-auto -mr-3 flex h-5 w-8 shrink-0 items-center justify-center">
                        <SessionContinuationDot
                          label={activity.label}
                          active={activity.running > 0 && activity.waiting === 0}
                          waiting={activity.waiting > 0}
                        />
                      </span>
                    )}
                  </CollapsibleTrigger>
                </SessionDirectoryHoverCard>
                <CollapsibleContent
                  className="session-workspace-items h-[var(--collapsible-panel-height)] overflow-hidden opacity-100 transition-[height,opacity] duration-[180ms] ease-out motion-reduce:transition-none data-[starting-style]:h-0 data-[starting-style]:opacity-0 data-[ending-style]:h-0 data-[ending-style]:opacity-0"
                  inert={Boolean(view.collapsed[group.id])}
                  aria-hidden={view.collapsed[group.id] || undefined}
                >
                  {sessions.map((session) => {
                    const owner =
                      hub.workspaces.find((item) => item.id === session.workspace_id) ?? workspace;
                    const title = displaySessionTitle(session.title, tr);
                    const description = [
                      title,
                      `${sessionAgentNames[session.agent]} · ${sessionRecordLabel(session, tr)}`,
                      session.worktree ? worktreeLabel(session.worktree, tr) : owner.path,
                      session.origin === "execution" ? tr("sessions.executionSession") : "",
                      sessionSourceLabel(session, hub.sessions, tr, formatDateTime),
                    ]
                      .filter(Boolean)
                      .join("\n");
                    const status = sessionContinuationListState(session, locale);
                    return (
                      <div
                        key={session.id}
                        data-directory-anchor={`session:${session.id}`}
                        className={cn(
                          "session-directory-row group/session flex min-h-8 items-center gap-1 rounded-xl transition-colors hover:bg-sidebar-accent/70",
                          hub.selected?.id === session.id && "bg-sidebar-accent",
                        )}
                      >
                        <SessionDirectoryHoverCard
                          title={title}
                          details={[description.split("\n").slice(1).join("\n"), status?.label]
                            .filter(Boolean)
                            .join("\n")}
                          disabled={!!draggingId}
                        >
                          <Button
                            variant="bare"
                            size="content"
                            data-session-entry
                            draggable
                            className={cn(
                              "session-directory-item session-directory-draggable flex min-h-8 min-w-0 flex-1 items-center gap-2 rounded-xl border border-transparent pl-5 pr-3 py-1 text-left transition-colors cursor-grab active:cursor-grabbing [&>div]:shrink-0 [&_strong]:truncate aria-[current=page]:font-medium",
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
                            aria-description={description}
                          >
                            <SessionDirectoryEntry
                              session={session}
                              sessions={hub.sessions}
                              selected={hub.selected?.id === session.id}
                              hideIndicators
                            />
                          </Button>
                        </SessionDirectoryHoverCard>
                        {/* A paired host's sessions are managed on that host. */}
                        <SessionDirectoryTrailing
                          session={session}
                          sessions={hub.sessions}
                          local={!owner.remote}
                          onChanged={() => void hub.refresh()}
                          onDeleted={() => {
                            if (hub.selected?.id === session.id) hub.select(undefined, true);
                            void hub.refresh();
                          }}
                        />
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
