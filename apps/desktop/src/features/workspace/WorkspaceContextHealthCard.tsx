import { useI18n } from "@/core/useI18n";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  GitCompareArrows,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

import type { ContextDoctorSummary } from "@/core/types";
import { cn } from "cn";

export function WorkspaceContextHealthCard({
  summary,
  pendingReview,
  onOpenDoctor,
  onOpenChanges,
}: {
  summary?: ContextDoctorSummary;
  pendingReview: boolean;
  onOpenDoctor: () => void;
  onOpenChanges: () => void;
}) {
  const { formatRelativeTime, tr } = useI18n();
  const issueCount = (summary?.error_count ?? 0) + (summary?.warning_count ?? 0);
  const healthy = Boolean(summary) && issueCount === 0;
  const repairable = summary?.repairable_count ?? 0;
  const Icon = pendingReview
    ? GitCompareArrows
    : healthy
      ? Check
      : issueCount > 0
        ? CircleAlert
        : ShieldCheck;
  const title = pendingReview
    ? tr("overview.contextHealthPending")
    : !summary
      ? tr("overview.contextHealthUnchecked")
      : healthy
        ? tr("overview.contextHealthHealthy")
        : repairable > 0
          ? tr("overview.contextHealthRepairable", { issues: issueCount, repairable })
          : tr("overview.contextHealthManual", { count: issueCount });
  const description = pendingReview
    ? tr("overview.contextHealthPendingText")
    : !summary
      ? tr("overview.contextHealthUncheckedText")
      : healthy
        ? tr("overview.contextHealthHealthyText")
        : repairable > 0
          ? tr("overview.contextHealthRepairableText")
          : tr("overview.contextHealthManualText");

  return (
    <Card
      className={cn(
        "flex flex-col gap-4 rounded-2xl border-border/70 p-5 shadow-sm md:flex-row md:items-center md:justify-between",
        healthy && "border-emerald-500/25 bg-emerald-500/[0.035]",
        !healthy && (pendingReview || issueCount > 0) && "border-amber-500/25 bg-amber-500/[0.035]",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground",
            healthy && "bg-emerald-500/10 text-emerald-700",
            !healthy && (pendingReview || issueCount > 0) && "bg-amber-500/10 text-amber-700",
          )}
        >
          <Icon size={19} />
        </span>
        <div className="min-w-0">
          <span className="text-xs font-semibold uppercase tracking-[.12em] text-muted-foreground">
            {tr("overview.contextHealth")}
          </span>
          <h2 className="mt-1 text-base font-semibold tracking-[-.02em]">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
          {summary && (
            <span className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clock3 size={12} />
              {tr("overview.contextHealthChecked", {
                time: formatRelativeTime(summary.checked_at),
              })}
            </span>
          )}
        </div>
      </div>
      <Button
        variant={pendingReview || repairable > 0 ? "default" : "outline"}
        className="shrink-0"
        onClick={pendingReview ? onOpenChanges : onOpenDoctor}
      >
        {pendingReview
          ? tr("overview.contextHealthReviewChanges")
          : !summary
            ? tr("overview.contextHealthRun")
            : repairable > 0
              ? tr("overview.contextHealthReviewRepair")
              : tr("overview.contextHealthDetails")}
        <ChevronRight size={15} />
      </Button>
    </Card>
  );
}
