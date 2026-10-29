import { useI18n } from "@/core/useI18n";
import { Brain, Check, CircleAlert, MessageSquareText, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { ContextDoctorSummary, MemoryRecord, WorkspaceSummary } from "@/core/types";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
import type { RecentContinuation } from "./home-continuations";
import type { ContinuationHomeState } from "./GlobalHome";
import { getWorkspaceStatus } from "@/features/workspace/workspace-status";
import { sessionGroupLabels } from "@/features/sessions/session-catalog";

export function ContinueWorkCard({
  state,
  workspaces = [],
  recentContinuations,
  slow,
  error,
  onContinue,
  onOpen,
  onEnable,
  onRetry,
  onOpenWorkspace,
}: {
  state: ContinuationHomeState;
  /** Every registered workspace, so a worktree session is named after its repository's group. */
  workspaces?: WorkspaceSummary[];
  recentContinuations: RecentContinuation[];
  slow: boolean;
  error?: string;
  onContinue?: (continuation: RecentContinuation) => Promise<void>;
  onOpen?: (workspace: WorkspaceSummary) => Promise<void>;
  onEnable?: () => Promise<void>;
  onRetry?: () => Promise<void>;
  onOpenWorkspace?: () => Promise<void>;
}) {
  const { tr, formatRelativeTime } = useI18n();
  const groupLabels = sessionGroupLabels(
    recentContinuations.map((item) => item.session),
    workspaces,
  );

  return (
    <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">{tr("home.continueWork")}</h2>
      </CardHeader>
      <CardContent className="p-0">
        {state === "ready" && recentContinuations.length ? (
          recentContinuations.map((item) => (
            <Button
              key={item.session.id}
              variant="bare"
              size="content"
              className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-5 py-4 text-left last:border-b-0 hover:bg-muted/40"
              onClick={() => void (onContinue ? onContinue(item) : onOpen?.(item.workspace))}
            >
              <span className="min-w-0">
                <strong className="block truncate text-sm">
                  {displaySessionTitle(item.session.title, tr)}
                </strong>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {tr("home.continueSessionMeta", {
                    agent: agentLabels[item.session.agent],
                    workspace: groupLabels.get(item.session.id) ?? item.workspace.name,
                    time: item.session.updated_at
                      ? formatRelativeTime(item.session.updated_at)
                      : tr("conversations.unknownTime"),
                  })}
                </span>
              </span>
              <span className="text-xs font-medium text-primary-text">
                {tr("home.openSession")}
              </span>
            </Button>
          ))
        ) : (
          <ContinuationEmptyState
            state={state}
            slow={slow}
            error={error}
            onEnable={onEnable}
            onRetry={onRetry}
            onOpenWorkspace={onOpenWorkspace}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function PendingTasksCard({
  pending,
  pendingMemories = [],
  issueCount,
  issuesPending,
  workspaces,
  attention,
  doctorSummaries,
  onOpenDoctor,
  onOpenAssets,
}: {
  pending: number;
  pendingMemories?: MemoryRecord[];
  issueCount: number;
  issuesPending: boolean;
  workspaces: WorkspaceSummary[];
  attention: WorkspaceSummary[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>;
  onOpenAssets: (section: "memory") => void;
}) {
  const { tr } = useI18n();
  const doctorWorkspace = attention[0] ?? workspaces[0];
  const memoryWorkspaceIds = [
    ...new Set(
      pendingMemories
        .filter((memory) => memory.status === "pending")
        .map((memory) => memory.project_id),
    ),
  ];
  const memoryWorkspaceContext =
    memoryWorkspaceIds.length === 1
      ? workspaces.find((workspace) => workspace.id === memoryWorkspaceIds[0])?.name
      : memoryWorkspaceIds.length > 1
        ? tr("home.fromWorkspaces", { count: memoryWorkspaceIds.length })
        : undefined;
  const hasUncheckedWorkspace = workspaces.some(
    (workspace) =>
      getWorkspaceStatus(workspace.id, doctorSummaries[workspace.id]).state === "undiagnosed",
  );

  return (
    <Card
      id="home-pending-tasks"
      className="scroll-mt-6 overflow-hidden rounded-xl border-border bg-card shadow-none"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-base font-semibold">{tr("home.pendingTasks")}</h2>
        <span
          className={
            issueCount > 0
              ? "text-sm tabular-nums text-warning"
              : "text-sm tabular-nums text-muted-foreground"
          }
        >
          {issuesPending ? tr("common.loading") : tr("home.itemCount", { count: issueCount })}
        </span>
      </CardHeader>
      <CardContent className="p-0">
        {issuesPending ? (
          <div
            role="status"
            aria-live="polite"
            className="flex min-h-28 items-center gap-3 px-5 py-5"
          >
            <RefreshCw size={16} className="animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">{tr("common.loading")}</span>
          </div>
        ) : issueCount > 0 ? (
          <div className="grid max-h-80 divide-y divide-border overflow-y-auto">
            {attention.map((workspace) => {
              const doctorCount = getWorkspaceStatus(
                workspace.id,
                doctorSummaries[workspace.id],
              ).diagnosticIssueCount;
              return (
                <Button
                  variant="bare"
                  size="content"
                  className="flex min-h-[74px] items-center gap-3 px-5 py-3.5 text-left hover:bg-muted/45"
                  key={workspace.id}
                  onClick={() => void onOpenDoctor(workspace)}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning">
                    <CircleAlert size={16} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">{workspace.name}</strong>
                    <small className="mt-0.5 block text-xs text-muted-foreground">
                      {tr("home.workspaceWarnings", {
                        count: doctorCount,
                      })}
                    </small>
                  </span>
                  <span className="rounded-lg border border-border px-3 py-2 text-xs font-semibold">
                    {tr("home.goToDoctor")}
                  </span>
                </Button>
              );
            })}
            {pending > 0 && (
              <Button
                variant="bare"
                size="content"
                className="flex min-h-[74px] items-center gap-3 px-5 py-3.5 text-left hover:bg-muted/45"
                onClick={() => onOpenAssets("memory")}
              >
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-warning/10 text-warning">
                  <Brain size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm">{tr("home.pendingMemory")}</strong>
                  <small className="mt-0.5 block text-xs text-muted-foreground">
                    {tr("home.pendingMemoryDetail", { count: pending })}
                    {memoryWorkspaceContext && ` · ${memoryWorkspaceContext}`}
                  </small>
                </span>
                <span className="rounded-lg border border-border px-3 py-2 text-xs font-semibold">
                  {tr("home.goToReview")}
                </span>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex min-h-28 items-center gap-3 px-5 py-5">
            <span
              className={
                hasUncheckedWorkspace
                  ? "grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
                  : "grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-700"
              }
            >
              {hasUncheckedWorkspace ? <CircleAlert size={18} /> : <Check size={18} />}
            </span>
            <span className="min-w-0 flex-1">
              <strong className="block text-sm">
                {tr(hasUncheckedWorkspace ? "home.uncheckedWorkspaces" : "home.allClear")}
              </strong>
            </span>
            {doctorWorkspace && (
              <Button variant="outline" onClick={() => void onOpenDoctor(doctorWorkspace)}>
                {workspaces.length > 1
                  ? tr("home.openDoctorForWorkspace", { workspace: doctorWorkspace.name })
                  : tr("home.openDoctor")}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ContinuationEmptyState({
  state,
  slow,
  error,
  onEnable,
  onRetry,
  onOpenWorkspace,
}: {
  state: ContinuationHomeState;
  slow: boolean;
  error?: string;
  onEnable?: () => Promise<void>;
  onRetry?: () => Promise<void>;
  onOpenWorkspace?: () => Promise<void>;
}) {
  const { tr } = useI18n();
  if (state === "loading") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-3 px-5 py-5 text-sm text-muted-foreground"
      >
        <RefreshCw className="mt-0.5 shrink-0 animate-spin" size={16} />
        <span>
          <strong className="block text-foreground">{tr("home.continuationsScanning")}</strong>
          {slow && <small className="mt-1 block">{tr("home.continuationsScanningSlow")}</small>}
        </span>
      </div>
    );
  }
  let title = tr("home.noContinuations");
  let detail = tr("home.noContinuationsDetail");
  let actionLabel = tr("home.openWorkspaceSessions");
  let actionHandler = onOpenWorkspace;
  if (state === "disabled") {
    title = tr("home.continuationsDisabled");
    detail = tr("home.continuationsDisabledDetail");
    actionLabel = tr("home.enableContinuations");
    actionHandler = onEnable;
  } else if (state === "metadata-only") {
    title = tr("home.continuationsMetadataOnly");
    detail = tr("home.continuationsMetadataOnlyDetail");
  } else if (state === "error") {
    title = tr("home.continuationsError");
    detail = error || tr("errors.generic");
    actionLabel = tr("runtime.retry");
    actionHandler = onRetry;
  }
  return (
    <div className="flex min-h-24 items-center gap-4 px-5 py-5">
      <MessageSquareText size={18} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <strong className="block text-sm text-foreground">{title}</strong>
        <small className="mt-1 block text-xs text-muted-foreground">{detail}</small>
      </span>
      {actionHandler && (
        <Button variant="outline" onClick={() => void actionHandler()}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
