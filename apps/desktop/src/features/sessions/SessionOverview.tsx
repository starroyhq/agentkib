import { Clock, Database, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
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
} from "./session-labels";
import { SessionNotice as Notice } from "./SessionNotice";

export function SessionOverview() {
  const { tr, formatDateTime, localizeMessage } = useI18n();
  const hub = useSessionHub();
  const resetFilters = useSessionViewStore((state) => state.resetFilters);
  const stats = [
    ["all", hub.filtered.length],
    ["readable", hub.filtered.filter((session) => session.availability === "readable").length],
    ["archived", hub.filtered.filter((session) => session.archived).length],
    ["metadata", hub.filtered.filter((session) => session.availability === "metadata-only").length],
  ] as const;
  const visibleWorkspaceIds = new Set(hub.filtered.map((session) => session.workspace_id));
  const statusWorkspaces = hub.workspaces
    .filter((item) => !item.remote)
    .filter(
      (item) =>
        visibleWorkspaceIds.has(item.id) ||
        Boolean(hub.errors[item.id]) ||
        !hub.sessions.some((session) => session.workspace_id === item.id),
    );

  return (
    <>
      <div className="session-stats mb-6 grid grid-cols-4 gap-3 max-[600px]:grid-cols-2">
        {stats.map(([key, count]) => (
          <div className="grid gap-2 rounded-xl bg-muted p-[18px] max-[600px]:p-3.5" key={key}>
            <strong className="text-[28px] leading-[1.2] font-[550] tabular-nums">{count}</strong>
            <span className="text-muted-foreground">{tr(`sessions.stat.${key}`)}</span>
          </div>
        ))}
      </div>
      {hub.loading && <Notice>{tr("conversations.scanning")}</Notice>}
      <div className="session-overview-panels grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-stretch gap-[18px] max-[1199px]:grid-cols-1">
        <section className="session-overview-panel min-w-0 rounded-[14px] border border-border">
          <header className="flex items-center gap-[9px] p-5">
            <Clock size={18} />
            <h2 className="flex-1 text-base font-semibold">{tr("sessions.recent")}</h2>
            <span className="text-muted-foreground">{hub.filtered.length}</span>
          </header>
          <div className="session-overview-panel-content [scrollbar-width:thin]">
            {hub.filtered.slice(0, 12).map((session) => {
              const source = hub.workspaces.find((item) => item.id === session.workspace_id);
              return (
                <Button
                  variant="bare"
                  size="content"
                  className="session-recent-item mx-4 flex w-[calc(100%-2rem)] flex-wrap items-start gap-2 border-t border-border px-1 py-3.5 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                  key={session.id}
                  onClick={() => hub.select(session.id)}
                  title={[
                    source?.path,
                    sessionSourceLabel(session, hub.sessions, tr, formatDateTime),
                  ]
                    .filter(Boolean)
                    .join("\n")}
                >
                  <AgentIcon agent={session.agent} compact />
                  <span className="grid min-w-0 flex-1 gap-[5px]">
                    <strong className="inline-flex items-center gap-1 font-[550] [overflow-wrap:anywhere]">
                      {displaySessionTitle(session.title, tr)}
                      {isInteractiveFork(session) && (
                        <GitBranch
                          size={12}
                          aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, hub.sessions, tr, formatDateTime)}`}
                        />
                      )}
                    </strong>
                    <small className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                      {session.remote && `${session.remote.host_name} · `}
                      {source?.name} · {sessionAgentNames[session.agent]} ·{" "}
                      {sessionRecordLabel(session, tr)}
                    </small>
                  </span>
                  <time className="w-full pl-7 text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {session.updated_at
                      ? formatDateTime(session.updated_at)
                      : tr("conversations.unknownTime")}
                  </time>
                </Button>
              );
            })}
            {!hub.filtered.length && !hub.loading && !hub.catalogError && (
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
        <section className="session-overview-panel min-w-0 rounded-[14px] border border-border">
          <header className="flex items-center gap-[9px] p-5">
            <Database size={18} />
            <h2 className="flex-1 text-base font-semibold">{tr("sessions.indexStatus")}</h2>
          </header>
          <div className="session-overview-panel-content [scrollbar-width:thin]">
            {statusWorkspaces.map((item) => (
              <div
                className="session-index-item mx-5 border-t border-border py-3.5 [overflow-wrap:anywhere] [&>p]:mt-2 [&>p]:text-muted-foreground"
                key={item.id}
              >
                <strong className="font-semibold" title={item.path}>
                  {item.name}
                </strong>
                {hub.errors[item.id] && <p className="text-destructive">{hub.errors[item.id]}</p>}
                {hub.statuses
                  .filter((status) => status.workspace_id === item.id)
                  .map((status) => (
                    <div
                      className="session-index-status flex flex-wrap gap-x-3 gap-y-1 pt-2 [&>span:nth-child(2)]:ml-auto [&_small]:w-full [&_small]:text-sm [&_small]:text-muted-foreground [&_p]:w-full [&_p]:text-sm"
                      key={`${item.id}:${status.agent}`}
                    >
                      <span>{sessionAgentNames[status.agent]}</span>
                      <span>{tr(`sessions.index.${status.freshness}`)}</span>
                      <small>
                        {status.last_success_at
                          ? formatDateTime(status.last_success_at)
                          : tr("sessions.neverIndexed")}
                      </small>
                      {(status.error_key || status.error_detail) && (
                        <p className="text-destructive">
                          {status.error_key
                            ? tr(status.error_key)
                            : localizeMessage(status.error_detail ?? "")}
                        </p>
                      )}
                    </div>
                  ))}
                {!hub.statuses.some((status) => status.workspace_id === item.id) && (
                  <p>{tr(hub.refreshing ? "conversations.scanning" : "sessions.neverIndexed")}</p>
                )}
              </div>
            ))}
            {!statusWorkspaces.length && (
              <p className="session-state-inline p-7 px-5 text-center text-muted-foreground">
                {tr(hub.workspaces.length ? "sessions.noMatches" : "sessions.noWorkspaces")}
              </p>
            )}
          </div>
        </section>
      </div>
    </>
  );
}
