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
  if (!orchestration.paused || orchestration.recovering) return copy.projectAgent;
  return `${copy.projectAgent} · ${projectAgentCopy(locale).pausedBadge}`;
}

export function OrchestrationIcon({
  role,
  paused = false,
}: {
  role: SessionOrchestration["role"];
  paused?: boolean;
}) {
  const Icon = role === "lead" ? Network : CornerDownRight;
  const pausedTone = role === "lead" && paused;
  return (
    <Icon
      size={12}
      aria-hidden="true"
      data-paused={pausedTone ? "true" : undefined}
      className={`shrink-0 ${pausedTone ? "text-amber-600 dark:text-amber-400" : ""}`}
    />
  );
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
  const leadPaused =
    orchestration.role === "lead" && orchestration.paused && !orchestration.recovering;
  return (
    <p
      className="mx-auto mb-4 flex w-full max-w-3xl items-center gap-1.5 text-xs text-muted-foreground"
      data-orchestration={orchestration.role}
    >
      <OrchestrationIcon role={orchestration.role} paused={leadPaused} />
      <span className="min-w-0 truncate">
        {orchestrationText(orchestration, leadTitle, locale)}
      </span>
    </p>
  );
}
