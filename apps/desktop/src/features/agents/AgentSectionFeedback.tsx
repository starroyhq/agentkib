import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";

export function AgentSectionFeedback({ error, onRetry }: { error: boolean; onRetry: () => void }) {
  const { tr } = useI18n();
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
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-32 items-center justify-center gap-2 p-5 text-sm text-muted-foreground"
    >
      <RefreshCw size={15} className="animate-spin" />
      {tr("common.loading")}
    </div>
  );
}
