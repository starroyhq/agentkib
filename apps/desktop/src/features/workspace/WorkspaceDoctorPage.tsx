import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { WorkspaceDoctorSkeleton } from "./WorkspaceSkeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useEffect, useState } from "react";
import { Check, CircleAlert, Minus, RefreshCw, ShieldCheck, Wrench } from "lucide-react";

import type {
  AgentKind,
  ContextDoctorReport,
  ContextDoctorSummary,
  DoctorAssetStatus,
  WorkspaceSummary,
} from "@/core/types";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";
import { useHomeDoctorReport } from "@/features/home/home-query";
import { AGENT_LABELS } from "@/core/agents";

export function WorkspaceDoctorPage({
  workspace,
  onRepair,
  verification,
  onDiagnosed,
}: {
  workspace: WorkspaceSummary;
  onRepair: () => Promise<void>;
  verification?: "applied";
  onDiagnosed: (summary: ContextDoctorSummary) => void | Promise<void>;
}) {
  const { localizeMessage, tr } = useI18n();
  const {
    data: report,
    isPending: loading,
    isFetching,
    error,
    refetch,
  } = useHomeDoctorReport(workspace.id);
  const [repairing, setRepairing] = useState(false);

  useEffect(() => {
    if (report?.summary.workspace_id === workspace.id) void onDiagnosed(report.summary);
  }, [onDiagnosed, report, workspace.id]);

  const activeReport = report?.summary.workspace_id === workspace.id ? report : undefined;
  const issueCount = activeReport
    ? activeReport.summary.error_count + activeReport.summary.warning_count
    : 0;
  const repairableCount = activeReport?.summary.repairable_count ?? 0;
  const manualIssueCount =
    activeReport?.issues.filter((issue) => issue.severity !== "info" && !issue.repairable).length ??
    0;
  const conclusion = !activeReport
    ? ""
    : issueCount === 0
      ? tr("doctor.conclusionHealthy")
      : repairableCount > 0 && manualIssueCount > 0
        ? tr("doctor.conclusionMixed", {
            repairable: repairableCount,
            manual: manualIssueCount,
          })
        : repairableCount > 0
          ? tr("doctor.conclusionRepairable", { count: repairableCount })
          : tr("doctor.conclusionManual", { count: issueCount });

  const repair = async () => {
    setRepairing(true);
    await withAsyncCleanup(onRepair, () => setRepairing(false));
  };

  if (loading && !activeReport) {
    return <WorkspaceDoctorSkeleton />;
  }

  return (
    <div className="mx-auto grid max-w-[1120px] gap-4">
      {verification && activeReport && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            issueCount === 0
              ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-700"
              : "border-amber-500/25 bg-amber-500/5 text-amber-700",
          )}
        >
          {issueCount === 0 ? <Check size={16} /> : <CircleAlert size={16} />}
          {issueCount === 0
            ? tr("doctor.recheckHealthy")
            : tr("doctor.recheckResult", {
                issues: issueCount,
                repairable: repairableCount,
              })}
        </div>
      )}
      <Card className="grid items-center gap-5 p-5 md:grid-cols-[minmax(260px,1fr)_auto_auto]">
        <div>
          <span className="text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">
            {tr("doctor.label")}
          </span>
          <h2>{tr("doctor.title")}</h2>
          {conclusion && <strong className="mt-1 block text-sm">{conclusion}</strong>}
        </div>
        <div className="flex gap-2">
          <Badge
            variant="destructive"
            className="grid min-w-[68px] gap-0.5 px-2.5 py-2 text-center"
          >
            <strong className="text-lg">{activeReport?.summary.error_count ?? 0}</strong>
            {tr("doctor.errors")}
          </Badge>
          <Badge variant="outline" className="grid min-w-[68px] gap-0.5 px-2.5 py-2 text-center">
            <strong className="text-lg">{activeReport?.summary.warning_count ?? 0}</strong>
            {tr("doctor.warnings")}
          </Badge>
          <Badge variant="secondary" className="grid min-w-[68px] gap-0.5 px-2.5 py-2 text-center">
            <strong className="text-lg">{activeReport?.summary.repairable_count ?? 0}</strong>
            {tr("doctor.repairable")}
          </Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? "animate-spin" : ""} size={14} />
            {tr("common.refresh")}
          </Button>
          <Button
            onClick={() => void repair()}
            disabled={loading || repairing || !activeReport?.summary.repairable_count}
          >
            <Wrench size={14} />
            {repairing
              ? tr("doctor.planning")
              : tr("doctor.reviewRepairCount", { count: repairableCount })}
          </Button>
        </div>
      </Card>
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <CircleAlert size={16} />
          {localizeMessage(error)}
        </div>
      )}
      {activeReport && (
        <Card className="overflow-hidden">
          <div className="flex min-h-[52px] items-center border-b border-border px-4 py-3">
            <h2 className="m-0 text-base font-semibold">{tr("doctor.matrix")}</h2>
          </div>
          <div className="overflow-x-auto" role="table">
            <div
              className="grid min-w-[680px] grid-cols-[minmax(220px,1.4fr)_repeat(3,minmax(120px,1fr))] gap-3 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground"
              role="row"
            >
              <span>{tr("doctor.agent")}</span>
              <span>{tr("assets.instructions")}</span>
              <span>{tr("assets.skills")}</span>
              <span>MCP</span>
            </div>
            {activeReport.matrix.map((row) => (
              <div
                className="grid min-w-[680px] grid-cols-[minmax(220px,1.4fr)_repeat(3,minmax(120px,1fr))] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
                role="row"
                key={row.agent}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <AgentIcon agent={row.agent} />
                  <strong className="truncate">{agentLabel(row.agent)}</strong>
                  {!row.writable && (
                    <em className="text-xs not-italic text-muted-foreground">
                      {tr("doctor.readOnly")}
                    </em>
                  )}
                </span>
                <DoctorCell value={row.instructions} />
                <DoctorCell value={row.skills} />
                <DoctorCell value={row.mcp} />
              </div>
            ))}
          </div>
        </Card>
      )}
      {activeReport && (
        <Card className="overflow-hidden">
          <div className="flex min-h-[52px] items-center border-b border-border px-4 py-3">
            <div>
              <h2 className="m-0 text-base font-semibold">{tr("doctor.issues")}</h2>
              <p className="m-0 mt-1 text-xs text-muted-foreground">
                {tr("doctor.deterministicOnly")}
              </p>
            </div>
          </div>
          {!activeReport.issues.length && (
            <div className="grid min-h-[96px] place-content-center justify-items-center gap-2 text-sm text-muted-foreground">
              <ShieldCheck size={22} />
              <strong>{tr("doctor.allClear")}</strong>
            </div>
          )}
          {activeReport.issues.map((issue) => (
            <article
              className={cn(
                "flex items-start gap-3 border-b px-4 py-3 last:border-b-0",
                issue.severity === "error"
                  ? "border-red-200/70 bg-red-50/50 text-red-700"
                  : "border-amber-200/70 bg-amber-50/50 text-amber-800",
              )}
              key={issue.id}
            >
              <CircleAlert className="mt-0.5 shrink-0" size={16} />
              <div className="min-w-0 flex-1">
                <header className="flex flex-wrap items-center gap-2">
                  <strong>{tr(`doctor.issue.${issue.code}`)}</strong>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      issue.severity === "error"
                        ? "border-red-300/60 bg-red-100/70"
                        : "border-amber-300/60 bg-amber-100/70",
                    )}
                  >
                    {tr(`doctor.severity.${issue.severity}`)}
                  </span>
                  {issue.repairable && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-background/70 px-2 py-0.5 text-[11px] font-medium text-foreground">
                      <Wrench size={11} />
                      {tr("doctor.repairable")}
                    </span>
                  )}
                </header>
                <p className="m-0 mt-1 text-xs opacity-80">
                  {issue.agent ? `${agentLabel(issue.agent)} · ` : ""}
                  {issue.asset_kind
                    ? tr(`status.asset.${issue.asset_kind}`)
                    : tr("doctor.workspace")}
                </p>
                {issue.evidence.map((evidence, index) => (
                  <div
                    className="mt-2 grid gap-0.5 rounded-md border border-current/10 bg-background/60 px-2.5 py-2 text-xs"
                    key={`${issue.id}-${index}`}
                  >
                    {evidence.path && <code className="font-mono">{evidence.path}</code>}
                    <span>{evidence.detail}</span>
                    {evidence.expected && (
                      <small className="opacity-75">
                        {tr("doctor.expected")}: {shortHash(evidence.expected)} ·{" "}
                        {tr("doctor.actual")}: {shortHash(evidence.actual ?? tr("doctor.missing"))}
                      </small>
                    )}
                  </div>
                ))}
              </div>
            </article>
          ))}
        </Card>
      )}
    </div>
  );
}

function DoctorCell({ value }: { value: DoctorAssetStatus }) {
  const { tr } = useI18n();
  const Icon =
    value.status === "healthy" ? Check : value.status === "not-applicable" ? Minus : CircleAlert;
  return (
    <span
      className={cn(
        "grid min-h-[34px] place-items-center justify-items-start gap-0.5 rounded-md border px-2 py-1.5 text-xs",
        value.status === "healthy" && "border-green-200 bg-green-50 text-green-700",
        value.status === "not-applicable" && "border-border bg-muted text-muted-foreground",
        value.status !== "healthy" &&
          value.status !== "not-applicable" &&
          "border-amber-200 bg-amber-50 text-amber-700",
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icon size={14} />
        <strong>{tr(`doctor.status.${value.status}`)}</strong>
      </span>
      <small className="text-[11px] opacity-75">
        {value.actual} / {value.expected}
      </small>
    </span>
  );
}

function agentLabel(agent: string) {
  // 诊断结果可能带有未登记的 agent 标识，此时原样显示。
  return Object.hasOwn(AGENT_LABELS, agent) ? AGENT_LABELS[agent as AgentKind] : agent;
}

function shortHash(value: string) {
  return /^[a-f\d]{32,}$/i.test(value) ? `${value.slice(0, 12)}…` : value;
}
