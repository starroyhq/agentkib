import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { WorkspaceOverviewSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { useWorkspaceStore, type ChangeSetOrigin } from "@/features/workspace/workspace-store";
import { WorkspaceContextHealthCard } from "@/features/workspace/WorkspaceContextHealthCard";
import { WorkspaceRecentSessions } from "@/features/workspace/WorkspaceRecentSessions";
import { useHomeDoctorReport } from "@/features/home/home-query";
import { useAppStore } from "@/stores/app-store";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { WorkspaceObsidianCard } from "@/features/obsidian/ObsidianIntegration";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronRight, CircleAlert } from "lucide-react";
import { formatRelativeTime } from "@/core/i18n";
import type { DoctorIssue, Manifest, WorkspaceScan, WorkspaceSummary } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";
function relativeTime(value: string) {
  return formatRelativeTime(value);
}
function Overview({
  workspace,
  scan,
  manifest,
  onOpenDoctor,
  onOpenChanges,
  onOpenAssets,
  pendingChanges,
  pendingHandoffRecovery,
  busy,
  doctorSummary,
  doctorIssues,
  sessionsEnabled,
}: {
  workspace: WorkspaceSummary;
  scan: WorkspaceScan;
  manifest: Manifest;
  onOpenDoctor: () => void;
  onOpenChanges: () => void;
  onOpenAssets: () => void;
  pendingChanges?: { origin: ChangeSetOrigin; count: number };
  pendingHandoffRecovery: boolean;
  busy: boolean;
  doctorSummary?: import("@/core/types").ContextDoctorSummary;
  doctorIssues?: DoctorIssue[];
  sessionsEnabled: boolean;
}) {
  const { tr } = useI18n();
  const pendingDoctorReview = pendingChanges?.origin === "doctor";
  const configuredAgents = scan.agents.filter(
    (agent) => agent.detected || agent.warnings.length > 0,
  );
  const unconfiguredAgents = scan.agents.filter(
    (agent) => !agent.detected && agent.warnings.length === 0,
  );
  const sources =
    workspace.sources
      .flatMap((source) => (source.agent ? [agentLabels[source.agent]] : []))
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" · ") || tr("workspace.source.manual");
  const sourceRows = [
    [tr("assets.sharedInstructions"), manifest.instructions.shared.trim() ? 1 : 0],
    [tr("overview.sharedSkills"), manifest.skills.length],
    ["MCP", manifest.connections.length],
    [tr("overview.scopedRules"), manifest.instructions.scoped.length],
  ] as const;
  return (
    <div className="grid gap-5">
      <WorkspaceContextHealthCard
        summary={doctorSummary}
        issues={doctorIssues}
        pendingReview={pendingDoctorReview}
        onOpenDoctor={onOpenDoctor}
        onOpenChanges={onOpenChanges}
      />
      {pendingHandoffRecovery && (
        <Card
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 border-amber-500/30 bg-amber-500/5 p-4"
        >
          <div>
            <h2 className="text-sm font-semibold">{tr("overview.pendingHandoffRecoveryTitle")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("overview.pendingHandoffRecoveryText")}
            </p>
          </div>
          <Button variant="outline" onClick={onOpenChanges} disabled={busy}>
            {tr("overview.openHandoffRecovery")}
          </Button>
        </Card>
      )}
      {pendingChanges && !pendingDoctorReview && (
        <Card
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 border-amber-500/30 bg-amber-500/5 p-4"
        >
          <div>
            <h2 className="text-sm font-semibold">
              {tr("overview.pendingChangesTitle", { count: pendingChanges.count })}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("overview.pendingChangesText")}
            </p>
          </div>
          <Button variant="outline" onClick={onOpenChanges} disabled={busy}>
            {tr("overview.contextHealthReviewChanges")}
          </Button>
        </Card>
      )}
      {scan.warnings.map((warning) => (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700"
          key={warning}
        >
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ))}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden rounded-xl border-border/70 shadow-none">
          <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
            <CardTitle className="text-base">{tr("overview.publicSource")}</CardTitle>
            <Button variant="link" className="h-auto p-0 text-xs" onClick={onOpenAssets}>
              {tr("overview.openAssets")}
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <div className="flex flex-wrap gap-x-2 gap-y-1 px-5 py-4 text-sm">
              {sourceRows.map(([label, value], index) => (
                <span key={label} className={value ? "text-foreground" : "text-muted-foreground"}>
                  {index > 0 && <span className="mr-2 text-muted-foreground">·</span>}
                  {label} <span className="tabular-nums">{value}</span>
                </span>
              ))}
            </div>
            <Collapsible className="border-t border-border/70">
              <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-4 text-left text-sm">
                <ChevronRight
                  size={14}
                  className="shrink-0 transition-transform group-data-[panel-open]:rotate-90"
                />
                {tr("overview.agentAssetsSummary", {
                  count: configuredAgents.reduce((total, agent) => total + agent.asset_count, 0),
                  agents: configuredAgents.length,
                })}
              </CollapsibleTrigger>
              <CollapsibleContent className="px-5 pb-4">
                {configuredAgents.map((agent) => (
                  <div key={agent.agent} className="flex items-center gap-2 py-2 text-xs">
                    <AgentIcon agent={agent.agent} />
                    <span>{agentLabels[agent.agent]}</span>
                    <span className="ml-auto text-muted-foreground">
                      {tr("overview.nativeAssets", { count: agent.asset_count })}
                    </span>
                  </div>
                ))}
                {!configuredAgents.length && (
                  <p className="text-xs text-muted-foreground">
                    {tr("overview.noProjectAgentConfigs")}
                  </p>
                )}
                {unconfiguredAgents.length > 0 && (
                  <Collapsible className="pt-3 text-xs text-muted-foreground">
                    <CollapsibleTrigger>
                      {tr("overview.otherAgents", { count: unconfiguredAgents.length })}
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-3 grid gap-2">
                      {unconfiguredAgents.map((agent) => (
                        <div className="flex items-center gap-2" key={agent.agent}>
                          <AgentIcon agent={agent.agent} />
                          <span>{agentLabels[agent.agent]}</span>
                          <span className="ml-auto">{tr("overview.noProjectConfig")}</span>
                        </div>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </Card>
        <WorkspaceRecentSessions workspace={workspace} enabled={sessionsEnabled} />
      </div>
      <WorkspaceObsidianCard workspaceId={workspace.id} />
      <p className="px-1 text-xs text-muted-foreground">
        {tr("workspace.discoverySources")} {sources} · {tr("workspace.lastScanLabel")}{" "}
        {workspace.last_scanned_at ? relativeTime(workspace.last_scanned_at) : tr("common.never")}
      </p>
    </div>
  );
}

function WorkspaceOverviewRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/(main)/workspace/$workspaceId/" });
  const {
    selectedWorkspace,
    project,
    scan,
    manifest,
    changeSet,
    changeSetManifest,
    changeSetOrigin,
    handoffLaunchRequest,
    busy,
    applyingChanges,
  } = useWorkspaceStore();
  const doctorReport = useHomeDoctorReport(workspaceId);
  const sessionsEnabled = useAppStore((state) => state.runtime?.session_index_enabled === true);
  if (!selectedWorkspace || !scan || !manifest) return <WorkspaceOverviewSkeleton />;
  const pendingChanges =
    selectedWorkspace.id === workspaceId &&
    selectedWorkspace.path === project &&
    changeSet?.project_root === project &&
    changeSet.changes.length > 0 &&
    (changeSetOrigin !== "standard" ||
      changeSetManifest === undefined ||
      changeSetManifest === JSON.stringify(manifest))
      ? { origin: changeSetOrigin, count: changeSet.changes.length }
      : undefined;
  const open = (page: "doctor" | "changes" | "assets") =>
    void navigate({
      to: `/workspace/$workspaceId/${page}` as never,
      params: { workspaceId } as never,
    });
  return (
    <Overview
      workspace={selectedWorkspace}
      scan={scan}
      manifest={manifest}
      pendingChanges={pendingChanges}
      pendingHandoffRecovery={Boolean(
        !changeSet &&
        handoffLaunchRequest?.workspace_id === workspaceId &&
        selectedWorkspace.id === workspaceId &&
        selectedWorkspace.path === project,
      )}
      busy={busy || applyingChanges}
      doctorSummary={doctorReport.isError ? undefined : doctorReport.data?.summary}
      doctorIssues={doctorReport.isError ? undefined : doctorReport.data?.issues}
      sessionsEnabled={sessionsEnabled}
      onOpenDoctor={() => open("doctor")}
      onOpenChanges={() => open("changes")}
      onOpenAssets={() => open("assets")}
    />
  );
}

export const Route = createFileRoute("/(main)/workspace/$workspaceId/")({
  staticData: { appRoute: { kind: "workspace", page: "overview" } },
  component: WorkspaceOverviewRoute,
});
