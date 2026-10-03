import { useI18n } from "@/core/useI18n";
import {
  Brain,
  Check,
  CircleAlert,
  FileText,
  FolderGit2,
  History,
  MessageSquareText,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type {
  ActivityRecord,
  AgentInstallation,
  AgentKind,
  ContextDoctorSummary,
  DiscoveryReport,
  InsightsSummary,
  MemoryRecord,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { GettingStartedCard } from "./GettingStartedCard";
import type { RecentContinuation } from "./home-continuations";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { activityPresentation } from "@/features/activity/activity-presentation";
import { AGENT_LABELS as agentLabels } from "@/core/agents";

export type AssetSection = "instructions" | "skills" | "mcp" | "memory" | "other";
export type ContinuationHomeState =
  | "ready"
  | "disabled"
  | "loading"
  | "metadata-only"
  | "empty"
  | "error";

function resolveContinuationState(
  continuationState: ContinuationHomeState | undefined,
  recentContinuations: RecentContinuation[],
): ContinuationHomeState {
  if (continuationState !== undefined) return continuationState;
  if (recentContinuations.length) return "ready";
  return "empty";
}

export function GlobalHome({
  workspaces,
  doctorSummaries,
  installations,
  memories,
  discovery,
  activity,
  uniqueAssetCount,
  assetCounts,
  onShowInsights,
  onShowWorkspaces,
  onShowAgents,
  recentContinuations = [],
  continuationState,
  continuationSlow = false,
  continuationError,
  onContinue,
  onEnableContinuations,
  onRetryContinuations,
  onOpenContinuationWorkspace,
  onOpen,
  onOpenDoctor,
  onOpenAssets,
  onAddRoot,
  onRefresh,
  runtime,
  onRuntimeChanged,
}: {
  workspaces: WorkspaceSummary[];
  doctorSummaries: Record<string, ContextDoctorSummary>;
  installations: AgentInstallation[];
  memories: MemoryRecord[];
  discovery?: DiscoveryReport;
  activity: ActivityRecord[];
  insights?: InsightsSummary;
  uniqueAssetCount: number;
  assetCounts: Map<string, number>;
  onShowInsights: () => void;
  onShowWorkspaces: () => void;
  onShowAgents: () => void;
  recentContinuations?: RecentContinuation[];
  continuationState?: ContinuationHomeState;
  continuationSlow?: boolean;
  continuationError?: string;
  onContinue?: (continuation: RecentContinuation) => Promise<void>;
  onEnableContinuations?: () => Promise<void>;
  onRetryContinuations?: () => Promise<void>;
  onOpenContinuationWorkspace?: () => Promise<void>;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
  onOpenDoctor: (workspace: WorkspaceSummary) => Promise<void>;
  onOpenAssets: (section: AssetSection) => void;
  onAddRoot: () => Promise<void>;
  onRefresh: () => void;
  runtime?: RuntimeInfo;
  onRuntimeChanged: (runtime: RuntimeInfo) => void;
}) {
  const resolvedContinuationState = resolveContinuationState(
    continuationState,
    recentContinuations,
  );
  const { tr, formatRelativeTime } = useI18n();
  const attention = workspaces.filter(
    (item) =>
      item.status === "attention" ||
      (doctorSummaries[item.id]?.error_count ?? 0) +
        (doctorSummaries[item.id]?.warning_count ?? 0) >
        0,
  );
  const pending = memories.filter((item) => item.status === "pending").length;
  const doctorIssueCount = Object.values(doctorSummaries).reduce(
    (total, summary) => total + summary.error_count + summary.warning_count,
    0,
  );
  const legacyAttentionCount = attention.filter(
    (workspace) => !doctorSummaries[workspace.id],
  ).length;
  const issueCount = doctorIssueCount + legacyAttentionCount + pending;
  const installedAgentCount = installations.filter((item) => item.installed).length;
  const metrics = [
    { label: tr("home.workspaceMetric"), value: workspaces.length, onClick: onShowWorkspaces },
    { label: tr("home.installedAgents"), value: installedAgentCount, onClick: onShowAgents },
    {
      label: tr("home.assetMetric"),
      value: uniqueAssetCount,
      onClick: () => onOpenAssets("instructions"),
    },
  ];

  return (
    <div className="grid gap-6">
      {!workspaces.length && (
        <GettingStartedCard
          onboarding={runtime?.onboarding}
          workspaces={workspaces}
          doctorSummaries={doctorSummaries}
          onRuntimeChanged={onRuntimeChanged}
          onAddRoot={onAddRoot}
          onOpenDoctor={onOpenDoctor}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-muted/55 px-5 py-3 text-sm">
          <Button
            variant="bare"
            className="h-auto gap-2 rounded-md px-2 py-1 font-semibold text-primary hover:bg-primary/10 hover:text-primary"
            onClick={onShowWorkspaces}
          >
            <CircleAlert size={16} />
            {tr("home.issueSummary", { count: issueCount })}
          </Button>
          {metrics.map(({ label, value, onClick }) => (
            <Button
              key={label}
              variant="bare"
              size="content"
              className="h-auto gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-primary/10 hover:text-primary"
              onClick={onClick}
            >
              <strong className="tabular-nums">{value}</strong>
              <span className="text-muted-foreground">{label}</span>
            </Button>
          ))}
          <span className="ml-auto text-xs text-muted-foreground">
            {discovery
              ? tr("home.updated", { time: formatRelativeTime(discovery.finished_at) })
              : tr("home.discovering")}
          </span>
        </div>
        <Button className="shrink-0 gap-2" onClick={onRefresh}>
          <RefreshCw size={15} />
          {tr("common.refresh")}
        </Button>
      </div>

      {!workspaces.length ? (
        <Card className="grid min-h-[260px] place-content-center justify-items-center gap-3 rounded-xl border-dashed bg-card p-8 text-center shadow-none">
          <span className="grid size-12 place-items-center rounded-xl bg-primary/8 text-primary">
            <FolderGit2 size={24} />
          </span>
          <h2 className="text-lg font-semibold tracking-[-.02em]">{tr("home.emptyTitle")}</h2>
          <p className="max-w-md text-sm leading-6 text-muted-foreground">{tr("home.emptyText")}</p>
          <Button onClick={() => void onAddRoot()}>{tr("home.addScanRoot")}</Button>
        </Card>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="grid gap-6">
            <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
              <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
                <div>
                  <h2 className="text-base font-semibold">{tr("home.continueWork")}</h2>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {resolvedContinuationState === "ready" && recentContinuations.length ? (
                  recentContinuations.map((item) => (
                    <Button
                      key={item.session.id}
                      variant="bare"
                      size="content"
                      className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-5 py-4 text-left last:border-b-0 hover:bg-muted/40"
                      onClick={() => void (onContinue ? onContinue(item) : onOpen(item.workspace))}
                    >
                      <span className="min-w-0">
                        <strong className="block truncate text-sm">
                          {displaySessionTitle(item.session.title, tr)}
                        </strong>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {tr("home.continueSessionMeta", {
                            agent: agentLabels[item.session.agent],
                            workspace: item.workspace.name,
                            time: item.session.updated_at
                              ? formatRelativeTime(item.session.updated_at)
                              : tr("conversations.unknownTime"),
                          })}
                        </span>
                      </span>
                      <span className="text-xs font-medium text-blue-600">
                        {tr("home.openSession")}
                      </span>
                    </Button>
                  ))
                ) : (
                  <ContinuationEmptyState
                    state={resolvedContinuationState}
                    slow={continuationSlow}
                    error={continuationError}
                    onEnable={onEnableContinuations}
                    onRetry={onRetryContinuations}
                    onOpenWorkspace={onOpenContinuationWorkspace}
                  />
                )}
              </CardContent>
            </Card>
            <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
              <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border px-5 py-4">
                <h2 className="text-base font-semibold">{tr("home.pendingTasks")}</h2>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {tr("home.itemCount", { count: issueCount })}
                </span>
              </CardHeader>
              <CardContent className="p-0">
                {issueCount > 0 ? (
                  <div className="grid divide-y divide-border">
                    {attention.slice(0, 4).map((workspace) => {
                      const doctorCount =
                        (doctorSummaries[workspace.id]?.error_count ?? 0) +
                        (doctorSummaries[workspace.id]?.warning_count ?? 0);
                      return (
                        <Button
                          variant="bare"
                          size="content"
                          className="flex min-h-[74px] items-center gap-3 px-5 py-3.5 text-left hover:bg-muted/45"
                          key={workspace.id}
                          onClick={() => void onOpenDoctor(workspace)}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                            <CircleAlert size={16} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <strong className="block truncate text-sm">{workspace.name}</strong>
                            <small className="mt-0.5 block text-xs text-muted-foreground">
                              {tr("home.workspaceWarnings", {
                                count: doctorCount || workspace.warning_count,
                              })}
                            </small>
                          </span>
                          <span className="rounded-lg border border-border px-3 py-2 text-xs font-semibold">
                            {tr("home.fixNow")}
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
                        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/10 text-amber-700">
                          <Brain size={15} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-sm">
                            {tr("home.pendingMemory")}
                          </strong>
                          <small className="mt-0.5 block text-xs text-muted-foreground">
                            {tr("home.pendingMemoryDetail", { count: pending })}
                          </small>
                        </span>
                        <span className="rounded-lg border border-border px-3 py-2 text-xs font-semibold">
                          {tr("home.reviewNow")}
                        </span>
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="flex min-h-28 items-center gap-3 px-5 py-5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-500/10 text-emerald-700">
                      <Check size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <strong className="block text-sm">{tr("home.allClear")}</strong>
                    </span>
                    <Button variant="outline" onClick={() => void onOpenDoctor(workspaces[0])}>
                      <ShieldCheck size={14} />
                      {tr("home.openDoctor")}
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>

            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-base font-semibold">{tr("home.recentActivity")}</h2>
                <Button
                  variant="link"
                  className="h-auto p-0 text-xs text-primary"
                  onClick={onShowInsights}
                >
                  {tr("home.viewAll")}
                </Button>
              </div>
              {activity.length > 0 ? (
                <div className="grid divide-y divide-border">
                  {activity.slice(0, 3).map((item) => (
                    <ActivityRow key={item.id} record={item} />
                  ))}
                </div>
              ) : (
                <div className="flex items-start gap-3 py-4">
                  <History size={16} className="mt-0.5 text-muted-foreground" />
                  <span>
                    <strong className="block text-sm">{tr("home.noImportantActivity")}</strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {tr("home.noImportantActivityText")}
                    </p>
                  </span>
                </div>
              )}
            </section>
          </div>

          <Card className="overflow-hidden rounded-xl border-border bg-card shadow-none">
            <CardHeader className="flex flex-row items-center justify-between border-b border-border px-5 py-4">
              <h2 className="text-base font-semibold">{tr("home.recentWorkspaces")}</h2>
              <Button
                variant="link"
                className="h-auto p-0 text-xs text-primary"
                onClick={onShowWorkspaces}
              >
                {tr("home.viewAll")}
              </Button>
            </CardHeader>
            <CardContent className="divide-y divide-border p-0">
              {workspaces.slice(0, 3).map((workspace) => (
                <WorkspaceRow
                  key={workspace.id}
                  workspace={workspace}
                  assetCount={assetCounts.get(workspace.id)}
                  onOpen={onOpen}
                />
              ))}
              <div className="px-5 py-4">
                <Button className="gap-1.5" onClick={() => void onAddRoot()}>
                  <Plus size={14} />
                  {tr("home.createWorkspace")}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
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
      <div className="flex items-start gap-3 px-5 py-5 text-sm text-muted-foreground">
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

function WorkspaceRow({
  workspace,
  assetCount,
  onOpen,
}: {
  workspace: WorkspaceSummary;
  assetCount?: number;
  onOpen: (workspace: WorkspaceSummary) => Promise<void>;
}) {
  const { tr } = useI18n();
  const sourceAgents = workspace.sources
    .map((source) => source.agent)
    .filter((value): value is AgentKind => Boolean(value))
    .filter((value, index, values) => values.indexOf(value) === index);
  const agents =
    sourceAgents.map((value) => agentLabels[value]).join(" · ") ||
    (workspace.sources.length ? tr("workspace.source.scan") : tr("workspace.source.manual"));
  const count = assetCount ?? workspace.asset_count;
  return (
    <Button
      variant="bare"
      size="content"
      className="group grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-5 py-4 text-left hover:bg-muted/40"
      onClick={() => void onOpen(workspace)}
    >
      <div className="grid size-9 place-items-center rounded-lg text-emerald-700">
        <FolderGit2 size={19} />
      </div>
      <div className="min-w-0">
        <strong className="block truncate text-sm font-semibold">{workspace.name}</strong>
        <small className="mt-1 block truncate text-xs text-muted-foreground" title={workspace.path}>
          {workspace.path}
        </small>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {agents} · {tr("workspace.assetCount", { count })}
        </span>
      </div>
      {workspace.status === "attention" ? (
        <Badge variant="secondary" className="gap-1 bg-primary/10 text-primary">
          <CircleAlert size={13} />
          {tr("status.workspace.attention")}
        </Badge>
      ) : (
        <Badge variant="secondary" className="gap-1 bg-emerald-500/10 text-emerald-700">
          <Check size={13} />
          {tr("status.workspace.healthy")}
        </Badge>
      )}
    </Button>
  );
}

function ActivityRow({ record }: { record: ActivityRecord }) {
  const { tr, formatDateTime } = useI18n();
  const presentation = activityPresentation(record, tr);
  return (
    <div className="grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2 text-sm">
      <FileText size={16} className="text-muted-foreground" />
      <div className="min-w-0">
        <strong className="block truncate text-sm font-medium">{presentation.title}</strong>
        <small
          className="mt-0.5 block truncate text-xs text-muted-foreground"
          title={presentation.detail}
        >
          {presentation.detail}
        </small>
      </div>
      <time className="whitespace-nowrap text-xs text-muted-foreground">
        {formatDateTime(record.created_at)}
      </time>
    </div>
  );
}
