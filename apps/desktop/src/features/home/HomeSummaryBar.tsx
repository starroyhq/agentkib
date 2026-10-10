import { useI18n } from "@/core/useI18n";
import { Check, CircleAlert, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DiscoveryReport } from "@/core/types";

type HomeMetric = { label: string; value: number; pending?: boolean; onClick: () => void };

export function HomeSummaryBar({
  issueCount,
  issuesPending,
  metrics,
  discovery,
  onShowPending,
  onRefresh,
}: {
  issueCount: number;
  issuesPending: boolean;
  metrics: HomeMetric[];
  discovery?: DiscoveryReport;
  onShowPending: () => void;
  onRefresh: () => void;
}) {
  const { tr, formatRelativeTime } = useI18n();

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-muted/55 px-5 py-3 text-sm">
        <Button
          variant="bare"
          className="h-auto gap-2 rounded-md px-2 py-1 font-semibold text-primary hover:bg-primary/10 hover:text-primary"
          onClick={onShowPending}
          disabled={issuesPending}
          aria-label={issuesPending ? tr("common.loading") : undefined}
        >
          {issuesPending ? (
            <RefreshCw size={16} className="animate-spin" />
          ) : issueCount > 0 ? (
            <CircleAlert size={16} />
          ) : (
            <Check size={16} />
          )}
          {issuesPending ? tr("common.loading") : tr("home.issueSummary", { count: issueCount })}
        </Button>
        {metrics.map(({ label, value, pending, onClick }) => (
          <Button
            key={label}
            variant="bare"
            size="content"
            className="h-auto gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-primary/10 hover:text-primary"
            onClick={onClick}
          >
            <strong className="tabular-nums">{pending ? "…" : value}</strong>
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
  );
}
