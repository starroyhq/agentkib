import { useI18n } from "@/core/useI18n";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { AGENT_LABELS } from "@/core/agents";
import type { AgentKind, ProviderStatus } from "@/core/types";
import { cn } from "cn";
import { AgentSectionFeedback } from "./AgentSectionFeedback";

export function AgentUsagePanel({
  agent,
  provider,
  loading,
  error,
  onRetry,
  embedded = false,
}: {
  agent: AgentKind;
  provider?: ProviderStatus;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  embedded?: boolean;
}) {
  const { tr } = useI18n();
  if (loading) return <AgentSectionFeedback error={false} onRetry={onRetry} />;
  if (error || (provider && (!provider.available || provider.error || provider.error_key))) {
    // The generic backend key repeats the failure state, rather than explaining its cause.
    const localizedReason =
      provider?.error_key &&
      !["errors.providerUnavailable", "insights.providerUnavailable"].includes(provider.error_key)
        ? tr(provider.error_key, { ...provider.error_params, defaultValue: "" })
        : "";
    // Match only the stats-cache read failure, including a configured Claude directory.
    const missingClaudeStats =
      agent === "claude-code" &&
      provider?.agent === "claude-code" &&
      /^ENOENT: no such file or directory, open '[^\r\n]*[\\/]stats-cache\.json'$/.test(
        provider.error ?? "",
      );
    const reason =
      localizedReason || (missingClaudeStats ? tr("agents.usageClaudeStatsCacheMissing") : "");
    return (
      <div role="alert" className="grid justify-items-start gap-4 p-5">
        <p className="text-sm text-foreground">
          {tr("agents.usageUnavailable", { agent: AGENT_LABELS[agent] })}
        </p>
        {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
        {provider?.error && (
          <Collapsible className="w-full rounded-xl border border-border p-4">
            <CollapsibleTrigger className="text-sm font-medium">
              {tr("common.details")}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <pre className="overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                {provider.error}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
        <Button variant="outline" size="sm" onClick={onRetry}>
          {tr("runtime.retry")}
        </Button>
      </div>
    );
  }
  if (!(provider?.available && provider.imported_events > 0))
    return <p className="p-5 text-sm text-muted-foreground">{tr("insights.noData")}</p>;
  return (
    <div className={cn("grid gap-4", !embedded && "p-5")}>
      <section className="grid gap-2 rounded-xl border border-border bg-muted/20 p-4">
        <span className="text-xs text-muted-foreground">{tr("agents.section.usage")}</span>
        <strong className="text-base">{tr("quota.available")}</strong>
        {provider.coverage_from && (
          <small className="text-xs text-muted-foreground">
            {provider.coverage_from} — {provider.coverage_to}
          </small>
        )}
      </section>
    </div>
  );
}
