import { useI18n } from "@/core/useI18n";
import { Check, CircleAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import type { ContextDoctorSummary, DoctorIssue } from "@/core/types";
import { doctorCheckedTime, doctorIssueTitle } from "./doctor-presentation";
import { cn } from "cn";

export function WorkspaceContextHealthCard({
  summary,
  issues = [],
  pendingReview,
  onOpenDoctor,
  onOpenChanges,
}: {
  summary?: ContextDoctorSummary;
  issues?: DoctorIssue[];
  pendingReview: boolean;
  onOpenDoctor: () => void;
  onOpenChanges: () => void;
}) {
  const { formatRelativeTime, tr, locale } = useI18n();
  const issueCount = (summary?.error_count ?? 0) + (summary?.warning_count ?? 0);
  const healthy = Boolean(summary) && issueCount === 0;
  const checkedTime = summary
    ? doctorCheckedTime(locale, summary.checked_at, formatRelativeTime(summary.checked_at))
    : "";
  const Icon = healthy ? Check : issueCount > 0 ? CircleAlert : ShieldCheck;
  const firstIssue = issues.find((issue) => issue.severity !== "info");
  const problem = firstIssue ? doctorIssueTitle(firstIssue, locale, tr) : undefined;
  const title = !summary
    ? tr("overview.contextHealthUnchecked")
    : healthy
      ? tr("overview.diagnosisHealthy", { time: checkedTime })
      : problem
        ? tr("overview.diagnosisProblem", { count: issueCount, problem })
        : tr("overview.diagnosisIssues", { count: issueCount });

  return (
    <Card
      className={cn(
        "flex flex-col gap-4 rounded-2xl border-border/70 p-5 shadow-sm md:flex-row md:items-center md:justify-between",
        healthy && "border-emerald-500/25 bg-emerald-500/[0.035]",
        issueCount > 0 && "border-warning/25 bg-warning/[0.035]",
      )}
    >
      <div className={cn("flex min-w-0 gap-3", healthy ? "items-center" : "items-start")}>
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground",
            healthy && "bg-emerald-500/10 text-emerald-700",
            issueCount > 0 && "bg-warning/10 text-warning",
          )}
        >
          <Icon size={19} />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {summary && !healthy && (
            <p className="mt-1 text-xs text-muted-foreground">
              {[
                summary.warning_count > 0
                  ? tr("overview.diagnosisWarnings", { count: summary.warning_count })
                  : undefined,
                summary.error_count > 0
                  ? tr("overview.diagnosisErrors", { count: summary.error_count })
                  : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
              {" · "}
              {tr("overview.contextHealthChecked", {
                time: checkedTime,
              })}
            </p>
          )}
          {pendingReview && (
            <p className="mt-2 text-xs text-warning">{tr("overview.contextHealthPending")}</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {pendingReview && (
          <Button variant="outline" onClick={onOpenChanges}>
            {tr("overview.contextHealthReviewChanges")}
          </Button>
        )}
        <Button variant="outline" onClick={onOpenDoctor}>
          {tr("overview.goDiagnostics")}
        </Button>
      </div>
    </Card>
  );
}
