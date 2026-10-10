import { useI18n } from "@/core/useI18n";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { ProviderStatus } from "@/core/types";
import { AgentSectionFeedback } from "./AgentSectionFeedback";

export function AgentUsagePanel({
  provider,
  loading,
  error,
  onRetry,
}: {
  provider?: ProviderStatus;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const { tr } = useI18n();
  if (loading || error) return <AgentSectionFeedback error={error} onRetry={onRetry} />;
  return (
    <div className="grid gap-4 p-5">
      <section className="grid gap-2 rounded-xl border border-border bg-muted/20 p-4">
        <span className="text-xs text-muted-foreground">{tr("agents.provider")}</span>
        <strong className="text-base">
          {provider?.available
            ? tr("quota.available")
            : provider?.error || provider?.error_key
              ? tr("insights.providerUnavailable")
              : tr("insights.noData")}
        </strong>
        {provider?.coverage_from && (
          <small className="text-xs text-muted-foreground">
            {provider.coverage_from} — {provider.coverage_to}
          </small>
        )}
      </section>
      {(provider?.error_key || provider?.error) && (
        <Collapsible className="rounded-xl border border-border p-4">
          <CollapsibleTrigger className="text-sm font-medium">
            {provider.error_key
              ? tr(provider.error_key, { defaultValue: tr("insights.providerUnavailable") })
              : tr("insights.providerUnavailable")}
          </CollapsibleTrigger>
          {provider.error && (
            <CollapsibleContent className="pt-3">
              <pre className="rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                {provider.error}
              </pre>
            </CollapsibleContent>
          )}
        </Collapsible>
      )}
    </div>
  );
}
