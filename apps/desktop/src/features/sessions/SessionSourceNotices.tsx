import type {
  AgentKind,
  ConversationIndexStatus,
  ConversationSessionSummary,
  WorkspaceSummary,
} from "@/core/types";
import type { ReactNode } from "react";
import { useHomeInstallations } from "@/features/home/home-query";
import { RemoteErrorDetails } from "@/features/remote/RemoteErrorDetails";
import { useSessionViewStore } from "./session-view-store";
import { useSessionHub } from "./SessionHubContext";
import { Button } from "@agentkib/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/core/useI18n";
import { AGENT_LABELS } from "@/core/agents";
import { sessionSourceNeedsAttention, sessionSourceWasUsed } from "./session-source-status";

const issueReasonKeys: Readonly<Record<string, string>> = {
  "antigravity-database-record": "sessions.sourceReason.databaseRecord",
  "antigravity-summary-record": "sessions.sourceReason.summaryRecord",
  "antigravity-trajectory-record": "sessions.sourceReason.trajectoryRecord",
  "antigravity-database-source": "sessions.sourceReason.database",
  "antigravity-summary-source": "sessions.sourceReason.summary",
  "antigravity-local-limit": "sessions.sourceReason.localLimit",
  "antigravity-acp-list": "sessions.sourceReason.acpList",
  "antigravity-acp-record": "sessions.sourceReason.acpRecord",
  "antigravity-native-list": "sessions.sourceReason.nativeList",
};

function sourceIssueKeys(detail: string | undefined): string[] {
  if (!detail?.startsWith("[") || detail.length > 2048) return [];
  try {
    const issues: unknown = JSON.parse(detail);
    if (Array.isArray(issues))
      return issues.flatMap((code) =>
        typeof code === "string" && Object.hasOwn(issueReasonKeys, code)
          ? [issueReasonKeys[code]]
          : [],
      );
  } catch {
    // Older hosts and unknown details use the generic localized fallback.
  }
  return [];
}

interface DirectoryNoticeDetail {
  key: string;
  label?: string;
  content: ReactNode;
}

export function SessionSourceNotices({
  statuses,
  sessions,
  workspaces,
  installedAgents,
  refreshing,
  onRetry,
  directorySummary,
  directoryDetails = [],
}: {
  statuses: ConversationIndexStatus[];
  sessions: ConversationSessionSummary[];
  workspaces?: Pick<WorkspaceSummary, "id" | "name">[];
  installedAgents?: AgentKind[];
  refreshing: boolean;
  onRetry: () => unknown;
  directorySummary?: string;
  directoryDetails?: DirectoryNoticeDetail[];
}) {
  const { locale, tr } = useI18n();
  const failures = statuses.filter((status) =>
    sessionSourceNeedsAttention(status, installedAgents),
  );
  const agents = [...new Set(failures.map((status) => status.agent))];
  if (!agents.length && !directoryDetails.length) return null;
  const warning = failures.some((status) => sessionSourceWasUsed(status, sessions));
  const separator = locale === "en-US" ? ", " : "、";
  const names = agents.map((agent) => AGENT_LABELS[agent]).join(separator);
  const workspaceNames = new Map(workspaces?.map((workspace) => [workspace.id, workspace.name]));
  const unavailable = tr("errors.conversations.sourceUnavailable");
  const details = new Map<string, { agent: AgentKind; reason: string; workspaces: Set<string> }>();
  for (const status of failures) {
    const issues = sourceIssueKeys(status.error_detail);
    const fallback =
      status.error_detail ===
      "Some conversation sources could not be read; previous records were retained"
        ? "sessions.sourcePartialRead"
        : (status.error_key ?? "errors.conversations.sourceUnavailable");
    for (const reason of issues.length ? issues : [fallback]) {
      const key = JSON.stringify([
        status.agent,
        reason,
        issues.length ? null : status.workspace_id,
      ]);
      const detail = details.get(key) ?? { agent: status.agent, reason, workspaces: new Set() };
      const workspaceName = workspaceNames.get(status.workspace_id);
      if (workspaceName) detail.workspaces.add(workspaceName);
      details.set(key, detail);
    }
  }
  return (
    <Collapsible className="min-w-0 px-4 py-2 text-xs leading-relaxed">
      <div
        role={warning ? "alert" : "status"}
        className={warning ? "text-warning" : "text-muted-foreground"}
      >
        <span className="whitespace-normal break-words">
          {directorySummary ?? tr("sessions.sourceUnavailable", { agent: names })}
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
          {[...details].map(([key, detail]) => {
            const workspaceNames = [...detail.workspaces].join(separator);
            return (
              <li className="px-2.5 py-1.5 [overflow-wrap:anywhere]" key={key}>
                <span className="font-medium text-foreground">
                  {workspaceNames ? `${workspaceNames} · ` : ""}
                  {AGENT_LABELS[detail.agent]}
                </span>
                <p>{tr(detail.reason, { defaultValue: unavailable })}</p>
              </li>
            );
          })}
          {directoryDetails.map(({ key, label, content }) => (
            <li className="px-2.5 py-1.5 [overflow-wrap:anywhere]" key={key}>
              {label && <span className="font-medium text-foreground">{label}</span>}
              {content}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SessionDirectoryNotices() {
  const hub = useSessionHub();
  const { locale, tr } = useI18n();
  const installations = useHomeInstallations();
  const agent = useSessionViewStore((state) => state.agent);
  const host = useSessionViewStore((state) => state.host);
  const installedAgents = (installations.data ?? [])
    .filter((item) => item.installed)
    .map((item) => item.agent);
  const workspaces = new Map(hub.workspaces.map((workspace) => [workspace.id, workspace]));
  const statuses = (hub.statuses ?? []).filter((status) => {
    const workspace = workspaces.get(status.workspace_id);
    return (
      workspace &&
      (host === "all" || host === (workspace.remote?.host_id ?? "local")) &&
      (agent === "all" || agent === status.agent) &&
      sessionSourceNeedsAttention(status, installedAgents)
    );
  });
  const showLocal = host === "all" || host === "local";
  const catalogError = showLocal ? hub.catalogError : "";
  const workspaceError = showLocal ? hub.workspacesError : "";
  const scanErrors = showLocal ? Object.entries(hub.errors).filter(([, error]) => !!error) : [];
  const errors = new Map<string, Set<string>>();
  for (const error of [catalogError, workspaceError]) {
    if (error) errors.set(error, new Set());
  }
  for (const [id, error] of scanErrors) {
    const names = errors.get(error) ?? new Set<string>();
    const name = workspaces.get(id)?.name;
    if (name) names.add(name);
    errors.set(error, names);
  }
  const separator = locale === "en-US" ? ", " : "、";
  const directoryDetails: DirectoryNoticeDetail[] = [...errors].map(([error, names]) => ({
    key: `local:${error}`,
    label: [...names].join(separator),
    content: <p>{error}</p>,
  }));
  const remoteNotices = (hub.remoteHosts ?? []).filter(
    (remote) =>
      (host === "all" || host === remote.id) &&
      (remote.status !== "online" || hub.remoteErrors?.[remote.id]),
  );
  for (const remote of remoteNotices) {
    const error = hub.remoteErrors?.[remote.id];
    directoryDetails.push({
      key: `remote:${remote.id}`,
      label: `${remote.name} · ${tr(`remote.state.${remote.status}`)}`,
      content: error && <RemoteErrorDetails error={error} showDiagnostics={false} />,
    });
  }
  const directorySummary = scanErrors.length
    ? tr("sessions.partialFailure", { count: scanErrors.length })
    : directoryDetails.length
      ? tr("sessions.catalogReadIncomplete")
      : undefined;
  return (
    <SessionSourceNotices
      statuses={statuses}
      sessions={hub.sessions}
      workspaces={hub.workspaces}
      installedAgents={installedAgents}
      refreshing={hub.refreshing || hub.workspacesLoading}
      directorySummary={directorySummary}
      directoryDetails={directoryDetails}
      onRetry={() => {
        if (workspaceError) hub.retryWorkspaces();
        if (
          !workspaceError ||
          statuses.length ||
          catalogError ||
          scanErrors.length ||
          remoteNotices.length
        )
          return hub.refresh();
      }}
    />
  );
}
