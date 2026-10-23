import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { WorkspaceDoctorSkeleton } from "./WorkspaceSkeleton";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CircleAlert,
  FileText,
  FolderOpen,
  Info,
  RefreshCw,
  ShieldCheck,
  Table2,
  Wrench,
} from "lucide-react";
import type {
  AgentKind,
  ContextDoctorSummary,
  DoctorAssetStatus,
  DoctorIssue,
  WorkspaceSummary,
} from "@/core/types";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { cn } from "cn";
import { withAsyncCleanup } from "@/lib/utils";
import { usePathDisplay } from "@/lib/usePathDisplay";
import { useHomeDoctorReport } from "@/features/home/home-query";
import { AGENT_LABELS } from "@/core/agents";
import { doctorManualAction, type DoctorIssueDestination } from "./doctor-manual-actions";
import { useWorkspaceStore } from "./workspace-store";
import { AppliedChangesNotice } from "./AppliedChangesNotice";
import {
  doctorCopy,
  doctorImpact,
  doctorIssueFiles,
  doctorIssueTitle,
  doctorMatrixCounts,
  doctorWorkspaceRelativePath,
} from "./doctor-presentation";

export function WorkspaceDoctorPage({
  workspace,
  onRepair,
  verification,
  onDiagnosed,
  onOpenIssue,
  onRevealPath,
}: {
  workspace: WorkspaceSummary;
  onRepair: () => Promise<void>;
  verification?: "applied";
  onDiagnosed: (summary: ContextDoctorSummary) => void | Promise<void>;
  onOpenIssue?: (destination: DoctorIssueDestination) => void;
  onRevealPath?: (path: string) => void;
}) {
  const { locale, formatRelativeTime, localizeMessage, tr } = useI18n();
  const {
    data: report,
    isPending: loading,
    isFetching,
    isError,
    error,
    refetch,
  } = useHomeDoctorReport(workspace.id);
  const [repairing, setRepairing] = useState(false);
  const [repairError, setRepairError] = useState("");
  const [expandedMatrixWorkspace, setExpandedMatrixWorkspace] = useState<string>();
  const matrixExpanded = expandedMatrixWorkspace === workspace.id;
  const applied = useWorkspaceStore((state) => state.appliedChanges);
  const appliedRepair =
    applied?.workspaceId === workspace.id &&
    applied.project === workspace.path &&
    applied.origin === "doctor"
      ? applied
      : undefined;
  const [enteredWithAppliedRepair] = useState(Boolean(appliedRepair));

  useEffect(() => {
    if (!isError && report?.summary.workspace_id === workspace.id) void onDiagnosed(report.summary);
  }, [isError, onDiagnosed, report, workspace.id]);

  const activeReport =
    !isError && report?.summary.workspace_id === workspace.id ? report : undefined;
  const issueCount = activeReport
    ? activeReport.summary.error_count + activeReport.summary.warning_count
    : 0;
  const repairableCount = activeReport?.summary.repairable_count ?? 0;
  const verificationText =
    verification && activeReport
      ? issueCount === 0
        ? tr("doctor.recheckHealthy")
        : tr("doctor.recheckResult", { issues: issueCount, repairable: repairableCount })
      : undefined;
  const matrixCounts = doctorMatrixCounts(activeReport?.matrix ?? []);
  const repair = async () => {
    setRepairing(true);
    setRepairError("");
    await withAsyncCleanup(
      async () => {
        try {
          await onRepair();
        } catch (error) {
          setRepairError(localizeMessage(error));
        }
      },
      () => setRepairing(false),
    );
  };

  if (loading && !activeReport) return <WorkspaceDoctorSkeleton />;

  return (
    <div className="mx-auto grid max-w-[1120px] gap-4">
      {appliedRepair && (
        <AppliedChangesNotice
          result={appliedRepair}
          verificationText={verificationText}
          onDismiss={() => useWorkspaceStore.getState().setAppliedChanges(undefined)}
        />
      )}
      {verification && activeReport && !appliedRepair && !enteredWithAppliedRepair && (
        <div
          role="status"
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            issueCount === 0
              ? "border-success/25 bg-success/5 text-success"
              : "border-warning/25 bg-warning/5 text-warning",
          )}
        >
          {issueCount === 0 ? <Check size={16} /> : <CircleAlert size={16} />}
          {verificationText}
        </div>
      )}
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <h2 className="sr-only">{tr("doctor.title")}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {!activeReport && (
            <span className="text-muted-foreground">{tr("workspace.status.undiagnosed")}</span>
          )}
          {activeReport &&
            (
              [
                ["warnings", activeReport?.summary.warning_count ?? 0],
                ["errors", activeReport?.summary.error_count ?? 0],
                ["repairable", repairableCount],
              ] as const
            ).map(([kind, count]) => (
              <span
                key={kind}
                className={cn(
                  "inline-flex items-center gap-1.5 whitespace-nowrap",
                  count === 0
                    ? "text-muted-foreground"
                    : kind === "warnings"
                      ? "font-medium text-warning"
                      : kind === "errors"
                        ? "font-medium text-destructive-text"
                        : "text-primary-text",
                )}
              >
                {kind === "warnings" && count > 0 && <AlertTriangle size={15} />}
                {doctorCopy(locale, kind, { count })}
                <span aria-hidden="true" className="ml-1 text-muted-foreground">
                  ·
                </span>
              </span>
            ))}
          {activeReport && (
            <span className="text-muted-foreground">
              {doctorCopy(locale, "checked", {
                time: formatRelativeTime(activeReport.summary.checked_at),
              })}
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={isFetching ? "animate-spin" : ""} size={14} />
          {doctorCopy(locale, "refresh")}
        </Button>
      </Card>
      {(repairError || error) && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-text"
        >
          <CircleAlert size={16} />
          {repairError || localizeMessage(error)}
        </div>
      )}
      {activeReport && (
        <section className="grid gap-3" aria-label={doctorCopy(locale, "issues")}>
          <h2 className="text-sm font-semibold">
            {doctorCopy(locale, "issues")}{" "}
            <span className="ml-1 font-normal text-muted-foreground">{issueCount}</span>
          </h2>
          {repairableCount > 0 && !activeReport.issues.some((issue) => issue.repairable) && (
            <Button
              className="justify-self-start"
              onClick={() => void repair()}
              disabled={repairing}
            >
              {repairing ? tr("doctor.planning") : doctorCopy(locale, "review")}
            </Button>
          )}
          {issueCount === 0 && !activeReport.issues.some((issue) => issue.severity !== "info") && (
            <Card className="flex min-h-[72px] items-center gap-3 p-4 text-sm text-muted-foreground">
              <ShieldCheck size={20} />
              <strong>{tr("doctor.allClear")}</strong>
            </Card>
          )}
          {activeReport.issues
            .filter((issue) => issue.severity !== "info")
            .map((issue) => (
              <IssueCard
                key={`${workspace.id}:${issue.id}`}
                issue={issue}
                workspacePath={workspace.path}
                onRepair={repair}
                repairing={repairing}
                onOpenIssue={onOpenIssue}
                onRevealPath={onRevealPath}
              />
            ))}
          {activeReport.issues
            .filter((issue) => issue.severity === "info")
            .map((issue) => (
              <InfoIssue
                key={`${workspace.id}:${issue.id}`}
                issue={issue}
                workspacePath={workspace.path}
                onOpenIssue={onOpenIssue}
                onRevealPath={onRevealPath}
              />
            ))}
        </section>
      )}
      {activeReport && (
        <Card className="overflow-hidden">
          <Button
            variant="bare"
            size="content"
            className="flex w-full flex-wrap items-center justify-start gap-x-3 gap-y-2 px-4 py-3 text-left text-sm"
            onClick={() => setExpandedMatrixWorkspace(matrixExpanded ? undefined : workspace.id)}
            aria-expanded={matrixExpanded}
          >
            <Table2 size={16} className="text-muted-foreground" />
            <strong>{tr("doctor.matrix")}</strong>
            <span className="text-muted-foreground">
              {doctorCopy(locale, "matrix", matrixCounts)}
            </span>
            <span className="ml-auto inline-flex items-center gap-2 text-xs">
              {doctorCopy(locale, matrixExpanded ? "collapse" : "expand")}
              <ChevronDown size={14} className={matrixExpanded ? "rotate-180" : ""} />
            </span>
          </Button>
          {matrixExpanded && (
            <div
              className="overflow-x-auto border-t border-border"
              role="table"
              aria-label={tr("doctor.matrix")}
            >
              <div
                role="row"
                className="grid min-w-[680px] grid-cols-[minmax(220px,1.4fr)_repeat(3,minmax(120px,1fr))] gap-3 border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-semibold text-muted-foreground"
              >
                <span role="columnheader">{tr("doctor.agent")}</span>
                <span role="columnheader">{tr("assets.instructions")}</span>
                <span role="columnheader">{tr("assets.skills")}</span>
                <span role="columnheader">MCP</span>
              </div>
              {activeReport.matrix.map((row) => (
                <div
                  role="row"
                  key={row.agent}
                  className="grid min-w-[680px] grid-cols-[minmax(220px,1.4fr)_repeat(3,minmax(120px,1fr))] items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0"
                >
                  <span role="cell" className="flex min-w-0 items-center gap-2">
                    <AgentIcon agent={row.agent} />
                    <strong className="truncate">{agentLabel(row.agent)}</strong>
                    {!row.writable && (
                      <Badge variant="outline" className="text-muted-foreground">
                        {tr("doctor.readOnly")}
                      </Badge>
                    )}
                  </span>
                  <DoctorCell value={row.instructions} />
                  <DoctorCell value={row.skills} />
                  <DoctorCell value={row.mcp} />
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

type IssueActions = {
  issue: DoctorIssue;
  workspacePath: string;
  onOpenIssue?: (destination: DoctorIssueDestination) => void;
  onRevealPath?: (path: string) => void;
};
function IssueCard({
  issue,
  workspacePath,
  onRepair,
  repairing,
  onOpenIssue,
  onRevealPath,
}: IssueActions & { onRepair: () => Promise<void>; repairing: boolean }) {
  const { locale, tr } = useI18n();
  const displayPath = usePathDisplay();
  const files = doctorIssueFiles(issue);
  const Icon = issue.severity === "error" ? CircleAlert : AlertTriangle;
  return (
    <Card className="flex items-start gap-3 p-4">
      <span
        className={cn(
          "mt-0.5 rounded-full p-1.5",
          issue.severity === "error"
            ? "bg-destructive/10 text-destructive-text"
            : "bg-warning/10 text-warning",
        )}
      >
        <Icon size={17} />
      </span>
      <article className="min-w-0 flex-1">
        <header className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              issue.severity === "error"
                ? "border-destructive/20 bg-destructive/5 text-destructive-text"
                : "border-warning/20 bg-warning/5 text-warning"
            }
          >
            {tr(`doctor.severity.${issue.severity}`)}
          </Badge>
          <h3 className="text-sm font-semibold">{doctorIssueTitle(issue, locale, tr)}</h3>
          {issue.repairable && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Wrench size={12} />
              {tr("doctor.repairable")}
            </span>
          )}
        </header>
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {files.map((file) => (
              <span
                key={file}
                title={file}
                className="inline-flex max-w-full items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                <FileText size={12} className="shrink-0" />
                <code className="truncate">{displayPath(file)}</code>
              </span>
            ))}
          </div>
        )}
        <p className="mt-2 text-sm">{doctorImpact(issue, locale)}</p>
        {issue.repairable ? (
          <div className="mt-2 grid justify-items-start gap-2 text-xs">
            <p className="text-muted-foreground">{doctorCopy(locale, "reviewAdvice")}</p>
            <Button className="mt-3" size="sm" onClick={() => void onRepair()} disabled={repairing}>
              {repairing ? tr("doctor.planning") : doctorCopy(locale, "review")}
            </Button>
          </div>
        ) : (
          <ManualIssueAction
            issue={issue}
            workspacePath={workspacePath}
            onOpenIssue={onOpenIssue}
            onRevealPath={onRevealPath}
          />
        )}
        <IssueDetails issue={issue} />
      </article>
    </Card>
  );
}

function InfoIssue({ issue, workspacePath, onOpenIssue, onRevealPath }: IssueActions) {
  const { locale, tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const title =
    issue.code === "agent.read-only"
      ? doctorCopy(locale, "readOnlyTitle", {
          agent: issue.agent ? agentLabel(issue.agent) : tr("doctor.agent"),
        })
      : doctorIssueTitle(issue, locale, tr);
  return (
    <Card className="overflow-hidden">
      <Button
        variant="bare"
        size="content"
        className="flex w-full items-center justify-start gap-2 px-4 py-3 text-left text-sm"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Info size={15} className="shrink-0 text-muted-foreground" />
        <Badge variant="outline" className="text-muted-foreground">
          {tr("doctor.severity.info")}
        </Badge>
        <span>{title}</span>
        <ChevronDown
          size={14}
          className={cn("ml-auto shrink-0 text-muted-foreground", expanded && "rotate-180")}
        />
      </Button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <p className="text-sm">{doctorImpact(issue, locale)}</p>
          <ManualIssueAction
            issue={issue}
            workspacePath={workspacePath}
            onOpenIssue={onOpenIssue}
            onRevealPath={onRevealPath}
          />
          <IssueDetails issue={issue} />
        </div>
      )}
    </Card>
  );
}

function ManualIssueAction({ issue, workspacePath, onOpenIssue, onRevealPath }: IssueActions) {
  const { locale, tr } = useI18n();
  const { guidanceKey, destination } = doctorManualAction(issue.code);
  const path = doctorIssueFiles(issue)[0];
  return (
    <div className="mt-2 grid justify-items-start gap-2 text-xs">
      <p className="text-muted-foreground">{tr(guidanceKey)}</p>
      <div className="flex flex-wrap gap-2">
        {destination && onOpenIssue && (
          <Button variant="outline" size="sm" onClick={() => onOpenIssue(destination)}>
            {tr(
              destination === "context"
                ? "doctor.openContext"
                : destination === "skills"
                  ? "doctor.openSkills"
                  : "doctor.openMcp",
            )}
          </Button>
        )}
        {path && onRevealPath && doctorWorkspaceRelativePath(workspacePath, path) !== undefined && (
          <Button variant="outline" size="sm" onClick={() => onRevealPath(path)}>
            <FolderOpen size={13} />
            {doctorCopy(locale, "revealFolder")}
          </Button>
        )}
      </div>
    </div>
  );
}

function IssueDetails({ issue }: { issue: DoctorIssue }) {
  const { locale, tr } = useI18n();
  const [expanded, setExpanded] = useState(false);
  if (!issue.evidence.length && !issue.agent && !issue.asset_kind) return null;
  return (
    <div className="mt-2">
      <Button
        variant="bare"
        size="content"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronDown size={12} className={expanded ? "rotate-180" : ""} />
        {doctorCopy(locale, "details")}
      </Button>
      {expanded && (
        <div className="mt-2 grid gap-2">
          {(issue.agent || issue.asset_kind) && (
            <p className="text-xs text-muted-foreground">
              {issue.agent ? `${tr("doctor.agent")}: ${agentLabel(issue.agent)}` : ""}
              {issue.agent && issue.asset_kind ? " · " : ""}
              {issue.asset_kind ? tr(`status.asset.${issue.asset_kind}`) : ""}
            </p>
          )}
          {issue.evidence.map((evidence, index) => (
            <div
              key={`${issue.id}-${index}`}
              className="grid gap-1 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs text-muted-foreground"
            >
              {evidence.path && <code className="break-all">{evidence.path}</code>}
              <span className="break-words">{evidence.detail}</span>
              {(evidence.expected || evidence.actual) && (
                <small>
                  <span title={evidence.expected}>
                    {tr("doctor.expected")}: {shortHash(evidence.expected ?? tr("doctor.missing"))}
                  </span>{" "}
                  ·{" "}
                  <span title={evidence.actual}>
                    {tr("doctor.actual")}: {shortHash(evidence.actual ?? tr("doctor.missing"))}
                  </span>
                </small>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DoctorCell({ value }: { value: DoctorAssetStatus }) {
  const { tr } = useI18n();
  const needsAttention = value.status === "attention" || value.status === "unavailable";
  const Icon = needsAttention ? AlertTriangle : Check;
  return (
    <span
      role="cell"
      data-status={value.status}
      title={tr(`doctor.status.${value.status}`)}
      className={cn(
        "inline-flex min-h-[30px] items-center gap-1.5 justify-self-start rounded-md px-2 py-1",
        needsAttention ? "bg-warning/10 font-medium text-warning" : "text-muted-foreground",
      )}
    >
      <Icon size={13} />
      {tr(needsAttention ? `doctor.status.${value.status}` : "doctor.status.healthy")}
    </span>
  );
}
function agentLabel(agent: string) {
  return Object.hasOwn(AGENT_LABELS, agent) ? AGENT_LABELS[agent as AgentKind] : agent;
}
function shortHash(value: string) {
  return /^[a-f\d]{32,}$/i.test(value) ? `${value.slice(0, 12)}…` : value;
}
