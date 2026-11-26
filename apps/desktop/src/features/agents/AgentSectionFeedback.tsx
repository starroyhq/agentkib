import { useDelayedBusy } from "@agentkib/session-ui";
import { SkeletonListRows } from "@/components/ui/skeleton-layouts";
import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";

export function AgentSectionFeedback({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  const { tr } = useI18n();
  const showLoading = useDelayedBusy(!error);
  return error ? (
    <div
      role="alert"
      className="grid min-h-32 place-content-center justify-items-center gap-3 p-5 text-center"
    >
      <p className="text-sm text-muted-foreground">{tr("errors.generic")}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {tr("runtime.retry")}
      </Button>
    </div>
  ) : (
    <div className="min-h-32" role="status" aria-label={tr("common.loading")}>
      {showLoading && <SkeletonListRows count={2} compact />}
    </div>
  );
}
