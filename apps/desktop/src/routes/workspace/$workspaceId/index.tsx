import { useI18n } from "@/core/useI18n";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { WorkspaceOverviewSkeleton } from "@/features/workspace/WorkspaceSkeleton";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { WorkspaceContextHealthCard } from "@/features/workspace/WorkspaceContextHealthCard";
import { useHomeDoctorReport } from "@/features/home/home-query";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { WorkspaceObsidianCard } from "@/features/obsidian/ObsidianIntegration";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CircleAlert, Copy } from "lucide-react";
import { formatRelativeTime } from "../../../core/i18n";
import type { Manifest, WorkspaceScan, WorkspaceSummary } from "../../../core/types";
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
  pendingDoctorReview,
  doctorSummary,
}: {
  workspace: WorkspaceSummary;
  scan: WorkspaceScan;
  manifest: Manifest;
  onOpenDoctor: () => void;
  onOpenChanges: () => void;
  pendingDoctorReview: boolean;
  doctorSummary?: import("@/core/types").ContextDoctorSummary;
}) {
  const { tr } = useI18n();
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
        pendingReview={pendingDoctorReview}
        onOpenDoctor={onOpenDoctor}
        onOpenChanges={onOpenChanges}
      />
      {scan.warnings.map((warning) => (
        <div
          className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-700"
          key={warning}
        >
          <CircleAlert size={16} className="mt-0.5 shrink-0" />
          <span>{warning}</span>
        </div>
      ))}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 rounded-xl border border-border/70 bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        <Button
          variant="bare"
          size="content"
          type="button"
          className="flex min-w-0 max-w-full items-center gap-2 text-left transition-colors hover:text-foreground"
          title={tr("workspace.copyPath")}
          onClick={() => void navigator.clipboard?.writeText(workspace.path)}
        >
          <code className="truncate">{workspace.path}</code>
          <Copy size={13} className="shrink-0" />
        </Button>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
          <span>
            <strong className="mr-1.5 font-medium text-foreground">
              {tr("workspace.discoverySources")}
            </strong>
            {sources}
          </span>
          <span>
            <strong className="mr-1.5 font-medium text-foreground">
              {tr("workspace.lastScanLabel")}
            </strong>
            {workspace.last_scanned_at
              ? relativeTime(workspace.last_scanned_at)
              : tr("common.never")}
          </span>
        </div>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,.8fr)_minmax(420px,1.2fr)]">
        <Card className="overflow-hidden rounded-2xl border-border/70 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
            <div>
              <CardTitle className="text-base">{tr("overview.publicSource")}</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">
                {tr("workspace.discoverySources")}: {sources}
              </p>
            </div>
            {scan.manifest_exists && (
              <Badge variant="outline">Schema v{manifest.schema_version}</Badge>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/70">
              {sourceRows.map(([label, value]) => (
                <div className="flex items-center justify-between gap-4 px-5 py-3.5" key={label}>
                  <span className="text-sm text-muted-foreground">{label}</span>
                  <strong className="text-sm tabular-nums text-foreground">{value}</strong>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
        <Card className="overflow-hidden rounded-2xl border-border/70 shadow-sm">
          <CardHeader className="border-b border-border/70 px-5 py-4">
            <CardTitle className="text-base">{tr("overview.projectAgentConfigs")}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {tr("overview.nativeAssets", {
                count: configuredAgents.reduce((total, agent) => total + agent.asset_count, 0),
              })}
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/70">
              {configuredAgents.map((agent) => (
                <div className="flex items-center gap-3 px-5 py-3.5" key={agent.agent}>
                  <AgentIcon agent={agent.agent} />
                  <span className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">{agentLabels[agent.agent]}</strong>
                    <small className="mt-0.5 block text-xs text-muted-foreground">
                      {tr("overview.nativeAssets", { count: agent.asset_count })}
                    </small>
                  </span>
                  <Badge variant={agent.warnings.length ? "destructive" : "secondary"}>
                    {tr(agent.warnings.length ? "status.workspace.attention" : "overview.detected")}
                  </Badge>
                </div>
              ))}
              {!configuredAgents.length && (
                <p className="px-5 py-5 text-xs text-muted-foreground">
                  {tr("overview.noProjectAgentConfigs")}
                </p>
              )}
              {unconfiguredAgents.length > 0 && (
                <Collapsible className="px-5 py-3.5 text-xs text-muted-foreground">
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
            </div>
          </CardContent>
        </Card>
      </div>
      <WorkspaceObsidianCard workspaceId={workspace.id} />
    </div>
  );
}

function WorkspaceOverviewRoute() {
  const navigate = useNavigate();
  const { workspaceId } = useParams({ from: "/workspace/$workspaceId/" });
  const { selectedWorkspace, scan, manifest, changeSet, changeSetOrigin } = useWorkspaceStore();
  const doctorReport = useHomeDoctorReport(workspaceId);
  if (!selectedWorkspace || !scan || !manifest) return <WorkspaceOverviewSkeleton />;
  const open = (page: "doctor" | "changes") =>
    void navigate({
      to: `/workspace/$workspaceId/${page}` as never,
      params: { workspaceId } as never,
    });
  return (
    <Overview
      workspace={selectedWorkspace}
      scan={scan}
      manifest={manifest}
      pendingDoctorReview={Boolean(changeSet && changeSetOrigin === "doctor")}
      doctorSummary={doctorReport.data?.summary}
      onOpenDoctor={() => open("doctor")}
      onOpenChanges={() => open("changes")}
    />
  );
}

export const Route = createFileRoute("/workspace/$workspaceId/")({
  component: WorkspaceOverviewRoute,
});
