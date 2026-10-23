import type { AgentKind, ConversationIndexStatus, ConversationSessionSummary } from "@/core/types";
import { useHomeInstallations } from "@/features/home/home-query";
import { useSessionViewStore } from "./session-view-store";
import { useSessionHub } from "./SessionHubContext";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/core/useI18n";
import { AGENT_LABELS } from "@/core/agents";
import { sessionSourceNeedsAttention, sessionSourceWasUsed } from "./session-source-status";

export function SessionSourceNotices({
  statuses,
  sessions,
  installedAgents,
  refreshing,
  onRetry,
}: {
  statuses: ConversationIndexStatus[];
  sessions: ConversationSessionSummary[];
  installedAgents?: AgentKind[];
  refreshing: boolean;
  onRetry: () => unknown;
}) {
  const { tr } = useI18n();
  const failures = statuses.filter((status) =>
    sessionSourceNeedsAttention(status, installedAgents),
  );
  const agents = [...new Set(failures.map((status) => status.agent))];
  return agents.map((agent) => {
    const warning = failures.some(
      (status) => status.agent === agent && sessionSourceWasUsed(status, sessions),
    );
    return (
      <p
        key={agent}
        role={warning ? "alert" : "status"}
        className={`flex min-w-0 items-center gap-1 px-4 py-2 text-xs ${warning ? "text-warning" : "text-muted-foreground"}`}
      >
        <span
          className="min-w-0 truncate"
          title={tr("sessions.sourceUnavailable", { agent: AGENT_LABELS[agent] })}
        >
          {tr("sessions.sourceUnavailable", { agent: AGENT_LABELS[agent] })}
        </span>
        <span className="shrink-0">·</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto shrink-0 p-0 text-xs text-inherit"
          disabled={refreshing}
          onClick={() => void onRetry()}
        >
          {tr("sessions.retry")}
        </Button>
      </p>
    );
  });
}

export function SessionDirectorySourceNotices({
  workspaceId,
  showWorkspace = false,
}: {
  workspaceId: string;
  showWorkspace?: boolean;
}) {
  const hub = useSessionHub();
  const installations = useHomeInstallations();
  const agent = useSessionViewStore((state) => state.agent);
  const host = useSessionViewStore((state) => state.host);
  const workspace = hub.workspaces.find((item) => item.id === workspaceId);
  const installedAgents = (installations.data ?? [])
    .filter((item) => item.installed)
    .map((item) => item.agent);
  const statuses = hub.statuses.filter(
    (status) =>
      status.workspace_id === workspaceId &&
      (agent === "all" || agent === status.agent) &&
      sessionSourceNeedsAttention(status, installedAgents),
  );
  if (
    !workspace ||
    (host !== "all" && host !== (workspace.remote?.host_id ?? "local")) ||
    !statuses.length
  )
    return null;
  return (
    <div className="text-xs text-muted-foreground">
      {showWorkspace && <p className="px-4 pt-2">{workspace.name}</p>}
      <SessionSourceNotices
        statuses={statuses}
        sessions={hub.sessions}
        installedAgents={installedAgents}
        refreshing={hub.refreshing}
        onRetry={hub.refresh}
      />
    </div>
  );
}
