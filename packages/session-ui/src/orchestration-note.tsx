import { CornerDownRight, Network } from "lucide-react";
import type { SessionOrchestration } from "@agentkib/web-client";
import type { ComposerModelLocale as Locale } from "./composer-model-copy";
import { catalogCopy } from "./catalog-copy";
import { projectAgentCopy } from "./project-agent-copy";

/**
 * "Project Agent · Delegation paused", or "Worker api · Delegated by <its Project Agent>";
 * `leadTitle` is null when that Project Agent is not in the list.
 */
export function orchestrationText(
  orchestration: SessionOrchestration,
  leadTitle: string | null,
  locale: Locale,
) {
  const copy = catalogCopy[locale];
  if (orchestration.role === "worker")
    return `${copy.worker} ${orchestration.name} · ${copy.delegatedBy} ${leadTitle ?? copy.projectAgent}`;
  if (!orchestration.paused) return copy.projectAgent;
  const status = orchestration.recovering
    ? projectAgentCopy(locale).recovering
    : copy.delegationPaused;
  return `${copy.projectAgent} · ${status}`;
}

export function OrchestrationIcon({ role }: { role: SessionOrchestration["role"] }) {
  const Icon = role === "lead" ? Network : CornerDownRight;
  return <Icon size={12} aria-hidden="true" className="shrink-0" />;
}

/** The session page's line on delegation; both roles are managed under "More actions". */
export function OrchestrationNote({
  orchestration,
  leadTitle,
  locale,
}: {
  orchestration: SessionOrchestration;
  leadTitle: string | null;
  locale: Locale;
}) {
  return (
    <p
      className="mx-auto mb-4 flex w-full max-w-3xl items-center gap-1.5 text-xs text-muted-foreground"
      data-orchestration={orchestration.role}
    >
      <OrchestrationIcon role={orchestration.role} />
      <span className="min-w-0 truncate">
        {orchestrationText(orchestration, leadTitle, locale)}
      </span>
    </p>
  );
}
