import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { InsightsStatus } from "@/core/types";
import { AGENT_LABELS as agentLabels } from "@/core/agents";

export function ProviderRow({
  provider,
}: {
  provider: NonNullable<InsightsStatus["providers"]>[number];
}) {
  const { localizeMessage, tr } = useI18n();
  const summary = provider.coverage_from
    ? `${provider.coverage_from} — ${provider.coverage_to}`
    : provider.error_key
      ? localizeMessage({ key: provider.error_key, params: provider.error_params })
      : provider.error
        ? tr("insights.providerUnavailable")
        : provider.available
          ? undefined
          : tr("insights.noData");
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <AgentIcon agent={provider.agent} />
      <span className="grid min-w-0 gap-1">
        <strong className="text-sm">{agentLabels[provider.agent]}</strong>
        {summary && <small className="text-xs text-muted-foreground">{summary}</small>}
        {provider.error && (
          <Collapsible>
            <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:underline">
              {tr("common.details")}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs">
                {provider.error}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </span>
    </div>
  );
}
