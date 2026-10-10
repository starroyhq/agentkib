import { useI18n } from "@/core/useI18n";
import { FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type {
  ActivityRecord,
  AgentInstallation,
  ContextDoctorSummary,
  DiscoveryReport,
  InsightsSummary,
  MemoryRecord,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { GettingStartedCard } from "./GettingStartedCard";
import type { RecentContinuation } from "./home-continuations";
import { HomeSummaryBar } from "./HomeSummaryBar";
import { ContinueWorkCard, PendingTasksCard } from "./HomeTaskCards";
import { RecentActivitySection, RecentWorkspacesCard } from "./HomeRecentSections";

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
  activityPending = false,
  issuesPending = false,
  installationsPending = false,
  catalogPending = false,
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
  activityPending?: boolean;
  issuesPending?: boolean;
  installationsPending?: boolean;
  catalogPending?: boolean;
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
  const { tr } = useI18n();
  const resolvedContinuationState = resolveContinuationState(
    continuationState,
    recentContinuations,
  );
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
  const legacyAttentionCount = attention.filter((workspace) => {
    const summary = doctorSummaries[workspace.id];
    return !summary || summary.error_count + summary.warning_count === 0;
  }).length;
  const issueCount = doctorIssueCount + legacyAttentionCount + pending;
  const metrics = [
    {
      label: tr("home.workspaceMetric"),
      value: workspaces.length,
      onClick: onShowWorkspaces,
    },
    {
      label: tr("home.installedAgents"),
      value: installations.filter((item) => item.installed).length,
      pending: installationsPending,
      onClick: onShowAgents,
    },
    {
      label: tr("home.assetMetric"),
      value: uniqueAssetCount,
      pending: catalogPending,
      onClick: () => onOpenAssets("instructions"),
    },
  ];
  const openPendingTasks = () => {
    const section = document.getElementById("home-pending-tasks");
    if (section) section.scrollIntoView({ behavior: "smooth", block: "start" });
    else onShowWorkspaces();
  };
  const pendingTasksCard = (
    <PendingTasksCard
      pending={pending}
      issueCount={issueCount}
      issuesPending={issuesPending}
      workspaces={workspaces}
      attention={attention}
      doctorSummaries={doctorSummaries}
      onOpenDoctor={onOpenDoctor}
      onOpenAssets={onOpenAssets}
    />
  );
  const continueWorkCard = (
    <ContinueWorkCard
      state={resolvedContinuationState}
      recentContinuations={recentContinuations}
      slow={continuationSlow}
      error={continuationError}
      onContinue={onContinue}
      onEnable={onEnableContinuations}
      onRetry={onRetryContinuations}
      onOpenWorkspace={onOpenContinuationWorkspace}
      onOpen={onOpen}
    />
  );

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

      <HomeSummaryBar
        issueCount={issueCount}
        issuesPending={issuesPending}
        metrics={metrics}
        discovery={discovery}
        onShowPending={openPendingTasks}
        onRefresh={onRefresh}
      />

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
            {issuesPending || issueCount > 0 ? (
              <>
                {pendingTasksCard}
                {continueWorkCard}
              </>
            ) : (
              <>
                {continueWorkCard}
                {pendingTasksCard}
              </>
            )}
            <RecentActivitySection
              activity={activity}
              pending={activityPending}
              onShowInsights={onShowInsights}
            />
          </div>
          <RecentWorkspacesCard
            workspaces={workspaces}
            assetCounts={assetCounts}
            onOpen={onOpen}
            onShowWorkspaces={onShowWorkspaces}
            onAddRoot={onAddRoot}
          />
        </div>
      )}
    </div>
  );
}
