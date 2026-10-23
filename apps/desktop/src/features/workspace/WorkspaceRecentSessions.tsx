import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { useI18n } from "@/core/useI18n";
import type { WorkspaceSummary } from "@/core/types";
import { AGENT_LABELS } from "@/core/agents";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { useSessionCatalog } from "@/features/sessions/useSessionCatalog";
import {
  refreshConversationCatalog,
  useConversationCatalog,
} from "@/features/sessions/conversation-catalog";
import { workspaceSessionEntries } from "@/features/sessions/session-catalog";
import { useHomeInstallations } from "@/features/home/home-query";
import { sessionSourceNeedsAttention } from "@/features/sessions/session-source-status";
import { prepareSessionNavigation } from "@/features/sessions/session-view-store";
import { selectRecentContinuations } from "@/features/home/home-continuations";
import { displaySessionTitle } from "./session-title";

export function WorkspaceRecentSessions({
  workspace,
  enabled,
}: {
  workspace: WorkspaceSummary;
  enabled: boolean;
}) {
  const { tr, formatRelativeTime } = useI18n();
  const navigate = useNavigate();
  const catalog = useSessionCatalog([workspace], enabled);
  const managed = useConversationCatalog(enabled && !workspace.remote);
  const installations = useHomeInstallations();
  const sessions = workspaceSessionEntries(workspace.id, catalog.sessions, managed.sessions);
  const recent = selectRecentContinuations(
    [workspace],
    [sessions.filter((session) => !session.archived)],
    3,
  );
  const managedError = managed.error ? tr("home.continuationsError") : undefined;
  const sourceError = catalog.statuses.some((status) =>
    sessionSourceNeedsAttention(
      status,
      (installations.data ?? []).filter((agent) => agent.installed).map((agent) => agent.agent),
    ),
  )
    ? tr("conversations.partialIndex")
    : undefined;
  const error = catalog.errors[workspace.id] ?? managedError ?? sourceError;
  return (
    <Card className="overflow-hidden rounded-xl shadow-none">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">{tr("overview.recentSessions")}</h2>
        <Button
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() =>
            void navigate({
              to: "/workspace/$workspaceId/sessions",
              params: { workspaceId: workspace.id },
            })
          }
        >
          {tr("home.viewAll")}
        </Button>
      </CardHeader>
      <CardContent className="divide-y divide-border p-0">
        {recent.map(({ session }) => (
          <Button
            key={session.id}
            variant="bare"
            size="content"
            className="flex w-full items-center gap-3 px-5 py-4 text-left hover:bg-muted/40"
            onClick={() => {
              prepareSessionNavigation(session);
              void navigate({ to: "/sessions", search: { sessionId: session.id } });
            }}
          >
            <AgentIcon agent={session.agent} />
            <span className="min-w-0 flex-1">
              <strong className="block truncate text-sm">
                {displaySessionTitle(session.title, tr)}
              </strong>
              <span className="mt-1 block text-xs text-muted-foreground">
                {AGENT_LABELS[session.agent]} ·{" "}
                {session.updated_at
                  ? formatRelativeTime(session.updated_at)
                  : tr("conversations.unknownTime")}
              </span>
            </span>
            <span className="shrink-0 text-xs text-primary-text">{tr("home.openSession")}</span>
          </Button>
        ))}
        {!recent.length && (
          <p role="status" className="px-5 py-5 text-sm text-muted-foreground">
            {!enabled
              ? tr("home.continuationsDisabled")
              : catalog.loading || !catalog.ready || !managed.ready
                ? tr("common.loading")
                : error
                  ? tr("home.continuationsError")
                  : tr("home.noContinuations")}
            {error && enabled && catalog.ready && managed.ready && (
              <>
                {" · "}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs text-muted-foreground"
                  disabled={catalog.refreshing}
                  onClick={() =>
                    void Promise.allSettled([
                      catalog.refresh(),
                      !workspace.remote ? refreshConversationCatalog() : Promise.resolve(),
                    ])
                  }
                >
                  {tr("runtime.retry")}
                </Button>
              </>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
