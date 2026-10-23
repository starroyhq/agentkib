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
  const { locale, tr } = useI18n();
  const failures = statuses.filter((status) =>
    sessionSourceNeedsAttention(status, installedAgents),
  );
  const agents = [...new Set(failures.map((status) => status.agent))];
  if (!agents.length) return null;
  const warning = failures.some((status) => sessionSourceWasUsed(status, sessions));
  const names = agents.map((agent) => AGENT_LABELS[agent]).join(locale === "en-US" ? ", " : "、");
  return (
    <p
      role={warning ? "alert" : "status"}
      className={`min-w-0 px-4 py-2 text-xs leading-relaxed ${warning ? "text-warning" : "text-muted-foreground"}`}
    >
      <span className="whitespace-normal break-words">
        {tr("sessions.sourceUnavailable", { agent: names })}
      </span>{" "}
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        <span aria-hidden="true">·</span>
        <Button
          variant="link"
          size="sm"
          className="h-auto shrink-0 p-0 text-xs text-primary-text"
          disabled={refreshing}
          onClick={() => void onRetry()}
        >
          {tr("sessions.retry")}
        </Button>
      </span>
    </p>
  );
}

export function SessionDirectorySourceNotices() {
  const hub = useSessionHub();
  const installations = useHomeInstallations();
  const agent = useSessionViewStore((state) => state.agent);
  const host = useSessionViewStore((state) => state.host);
  const installedAgents = (installations.data ?? [])
    .filter((item) => item.installed)
    .map((item) => item.agent);
  const statuses = (hub.statuses ?? []).filter((status) => {
    const workspace = hub.workspaces.find((item) => item.id === status.workspace_id);
    return (
      workspace &&
      (host === "all" || host === (workspace.remote?.host_id ?? "local")) &&
      (agent === "all" || agent === status.agent) &&
      sessionSourceNeedsAttention(status, installedAgents)
    );
  });
  if (!statuses.length) return null;
  return (
    <div className="text-xs text-muted-foreground">
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
