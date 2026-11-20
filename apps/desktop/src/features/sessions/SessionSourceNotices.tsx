import type {
  AgentKind,
  ConversationIndexStatus,
  ConversationSessionSummary,
  WorkspaceSummary,
} from "@/core/types";
import { useHomeInstallations } from "@/features/home/home-query";
import { useSessionViewStore } from "./session-view-store";
import { useSessionHub } from "./SessionHubContext";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/core/useI18n";
import { AGENT_LABELS } from "@/core/agents";
import { sessionSourceNeedsAttention, sessionSourceWasUsed } from "./session-source-status";

export function SessionSourceNotices({
  statuses,
  sessions,
  workspaces,
  installedAgents,
  refreshing,
  onRetry,
}: {
  statuses: ConversationIndexStatus[];
  sessions: ConversationSessionSummary[];
  workspaces?: Pick<WorkspaceSummary, "id" | "name">[];
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
  const workspaceNames = new Map(workspaces?.map((workspace) => [workspace.id, workspace.name]));
  const unavailable = tr("errors.conversations.sourceUnavailable");
  return (
    <Collapsible className="min-w-0 px-4 py-2 text-xs leading-relaxed">
      <div
        role={warning ? "alert" : "status"}
        className={warning ? "text-warning" : "text-muted-foreground"}
      >
        <span className="whitespace-normal break-words">
          {tr("sessions.sourceUnavailable", { agent: names })}
        </span>{" "}
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <Button
            variant="link"
            size="content"
            className="text-xs"
            disabled={refreshing}
            onClick={() => void onRetry()}
          >
            {tr("sessions.retry")}
          </Button>
          <CollapsibleTrigger render={<Button variant="link" size="content" className="text-xs" />}>
            {tr("common.details")}
          </CollapsibleTrigger>
        </span>
      </div>
      <CollapsibleContent>
        <ul className="mt-2 max-h-40 overflow-y-auto overscroll-contain divide-y divide-border rounded-md border border-border bg-muted/40 text-muted-foreground">
          {failures.map((status) => {
            const workspaceName = workspaceNames.get(status.workspace_id);
            // The index uses one error key for full and partial reads and stores a fixed partial-read detail.
            const reason =
              status.error_detail ===
              "Some conversation sources could not be read; previous records were retained"
                ? tr("sessions.sourcePartialRead")
                : tr(status.error_key ?? "errors.conversations.sourceUnavailable", {
                    defaultValue: unavailable,
                  });
            return (
              <li
                className="px-2.5 py-1.5 [overflow-wrap:anywhere]"
                key={`${status.workspace_id}:${status.agent}`}
              >
                <span className="font-medium text-foreground">
                  {workspaceName ? `${workspaceName} · ` : ""}
                  {AGENT_LABELS[status.agent]}
                </span>
                <p>{reason}</p>
              </li>
            );
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
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
        workspaces={hub.workspaces}
        installedAgents={installedAgents}
        refreshing={hub.refreshing}
        onRetry={hub.refresh}
      />
    </div>
  );
}
