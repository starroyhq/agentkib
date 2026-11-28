import {
  sessionContinuationListState,
  SessionContinuationStatus,
  useDelayedBusy,
} from "@agentkib/session-ui";
import { Clock, GitBranch } from "lucide-react";
import { Button } from "@agentkib/ui/button";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { useI18n } from "@/core/useI18n";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import {
  isInteractiveFork,
  sessionAgentNames,
  sessionRecordLabel,
  sessionSourceLabel,
  worktreeLabel,
} from "./session-labels";
import { sessionGroupLabels } from "./session-catalog";
import { WorktreeMark } from "./WorktreeMark";

export function SessionOverview() {
  const { locale, tr, formatDateTime } = useI18n();
  const hub = useSessionHub();
  const statsAvailable = hub.usable ?? (hub.ready || hub.filtered.length > 0);
  const slowScan = useDelayedBusy(hub.loading && !statsAvailable, 3000);
  const resetFilters = useSessionViewStore((state) => state.resetFilters);
  const stats = [
    ["all", hub.filtered.length],
    ["readable", hub.filtered.filter((session) => session.availability === "readable").length],
    ["archived", hub.filtered.filter((session) => session.archived).length],
    ["metadata", hub.filtered.filter((session) => session.availability === "metadata-only").length],
  ] as const;
  // Name each session after the directory group it is listed in (its repository's, for a worktree).
  const groupLabels = sessionGroupLabels(hub.filtered, hub.workspaces, hub.visibility);

  return (
    <>
      <div
        className="session-stats mb-6 grid grid-cols-4 gap-3 max-[600px]:grid-cols-2"
        aria-busy={!statsAvailable}
      >
        {stats.map(([key, count]) => (
          <div className="grid gap-2 rounded-xl bg-muted p-[18px] max-[600px]:p-3.5" key={key}>
            <strong className="text-[28px] leading-[1.2] font-[550] tabular-nums">
              {statsAvailable ? count : "—"}
            </strong>
            <span className="text-muted-foreground">{tr(`sessions.stat.${key}`)}</span>
          </div>
        ))}
      </div>
      {slowScan && (
        <p className="mb-4 text-xs text-muted-foreground" role="status">
          {tr("conversations.scanning")}
        </p>
      )}
      <section className="session-overview-panel min-w-0 rounded-[14px] border border-border">
        <header className="flex items-center gap-[9px] p-5">
          <Clock size={18} />
          <h2 className="flex-1 text-base font-semibold">{tr("sessions.recent")}</h2>
          <span className="text-muted-foreground">
            {statsAvailable ? hub.filtered.length : "—"}
          </span>
        </header>
        <div className="session-overview-panel-content">
          {hub.filtered.slice(0, 12).map((session) => {
            const status = sessionContinuationListState(session, locale);
            const source = hub.workspaces.find((item) => item.id === session.workspace_id);
            return (
              <Button
                variant="bare"
                size="content"
                className="session-recent-item mx-4 flex w-[calc(100%-2rem)] flex-wrap items-start gap-2 border-t border-border px-1 py-3.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                key={session.id}
                onClick={() => hub.select(session.id)}
                title={[
                  session.worktree ? worktreeLabel(session.worktree, tr) : source?.path,
                  sessionSourceLabel(session, hub.sessions, tr, formatDateTime),
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                <AgentIcon agent={session.agent} compact />
                <span className="grid min-w-0 flex-1 gap-[5px]">
                  <strong className="inline-flex items-center gap-1 font-[550] [overflow-wrap:anywhere]">
                    {displaySessionTitle(session.title, tr)}
                    {session.worktree && (
                      <WorktreeMark
                        label={worktreeLabel(session.worktree, tr)}
                        deleted={session.worktree.status === "deleted"}
                      />
                    )}
                    {isInteractiveFork(session) && (
                      <GitBranch
                        size={12}
                        aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, hub.sessions, tr, formatDateTime)}`}
                      />
                    )}
                  </strong>
                  <small className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {session.remote && `${session.remote.host_name} · `}
                    {groupLabels.get(session.id) ?? source?.name} ·{" "}
                    {sessionAgentNames[session.agent]} · {sessionRecordLabel(session, tr)}
                  </small>
                </span>
                {status && (
                  <SessionContinuationStatus
                    label={status.label}
                    running={status.active}
                    waiting={status.waiting}
                  />
                )}
                <time className="w-full pl-7 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {session.updated_at
                    ? formatDateTime(session.updated_at)
                    : tr("conversations.unknownTime")}
                </time>
              </Button>
            );
          })}
          {!hub.filtered.length &&
            !hub.loading &&
            !hub.catalogError &&
            !hub.workspacesError &&
            !Object.values(hub.errors).some(Boolean) && (
              <div className="session-state-inline p-7 px-5 text-center">
                <p className="text-muted-foreground">
                  {tr(hub.sessions.length ? "sessions.noMatches" : "sessions.noSessions")}
                </p>
                {hub.sessions.length > 0 && (
                  <Button variant="ghost" onClick={resetFilters}>
                    {tr("sessions.clearFilters")}
                  </Button>
                )}
              </div>
            )}
        </div>
      </section>
    </>
  );
}
