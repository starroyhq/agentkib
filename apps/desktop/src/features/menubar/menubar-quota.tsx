import { RefreshCw } from "lucide-react";
import { AgentMark } from "@agentkib/agent-identity";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import type {
  AgentKind,
  QuotaPopoverPreferences,
  QuotaProvider,
  QuotaSnapshot,
} from "@/core/types";
import { useI18n } from "@/core/useI18n";
import {
  compareQuotaProviders,
  isQuotaProviderSupported,
  lowestRemaining,
  quotaSeverity,
  visibleQuotaWindows,
} from "@/features/quota/quota";
import { relativeReset, useQuotaClock } from "@/features/quota/QuotaDisplay";
import type { QuotaDisplayWindow } from "@/features/quota/quota";

/** The header has room for this many rings next to the title and the settings button. */
const MAX_RINGS = 3;

/** Providers with a window the person shows, the one closest to its limit first. */
export function quotaRingProviders(
  snapshot: QuotaSnapshot | null | undefined,
  preferences: QuotaPopoverPreferences,
): QuotaProvider[] {
  return (snapshot?.providers ?? [])
    .filter((provider) => provider.enabled && isQuotaProviderSupported(provider))
    .filter((provider) => visibleQuotaWindows(provider, preferences).length > 0)
    .sort(compareQuotaProviders)
    .slice(0, MAX_RINGS);
}

function providerAgent(provider: QuotaProvider): AgentKind | undefined {
  const value = `${provider.id} ${provider.name}`.toLowerCase();
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude-code";
  if (value.includes("cursor")) return "cursor";
  return undefined;
}

const ringTone = {
  healthy: "text-primary",
  warning: "text-[var(--amber)]",
  danger: "text-[var(--red)]",
};

/** One Agent's quota as a small ring: what is left of its tightest window, amber when low. */
export function QuotaRing({
  provider,
  selected,
  onClick,
}: {
  provider: QuotaProvider;
  selected: boolean;
  onClick: () => void;
}) {
  const { tr } = useI18n();
  const remaining = lowestRemaining(provider);
  const known = remaining !== undefined;
  const value = known ? Math.min(100, Math.max(0, remaining)) : 0;
  const agent = providerAgent(provider);
  const radius = 12;
  const length = 2 * Math.PI * radius;
  return (
    <Button
      variant="bare"
      size="content"
      aria-pressed={selected}
      aria-label={
        known
          ? tr("menubar.quotaRing", { name: provider.name, value: Math.round(value) })
          : tr("menubar.quotaRingUnknown", { name: provider.name })
      }
      className={cn(
        "relative grid size-9 place-items-center rounded-full outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
        selected && "bg-muted",
      )}
      onClick={onClick}
    >
      <svg aria-hidden="true" viewBox="0 0 30 30" className="absolute size-[30px] -rotate-90">
        <circle
          cx="15"
          cy="15"
          r={radius}
          fill="none"
          strokeWidth="2.5"
          className="stroke-border"
        />
        {known && (
          <circle
            cx="15"
            cy="15"
            r={radius}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            stroke="currentColor"
            strokeDasharray={`${(value / 100) * length} ${length}`}
            className={ringTone[quotaSeverity(value)]}
          />
        )}
      </svg>
      {agent ? (
        <AgentMark agent={agent} size={14} />
      ) : (
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
          {provider.name.slice(0, 1)}
        </span>
      )}
    </Button>
  );
}

/** The chosen Agent's windows, opened in place under the header. */
export function QuotaPanel({
  provider,
  snapshot,
  preferences,
  refreshing,
  error,
  onRefresh,
  onOpen,
}: {
  provider: QuotaProvider;
  snapshot: QuotaSnapshot;
  preferences: QuotaPopoverPreferences;
  refreshing: boolean;
  error?: string;
  onRefresh: () => void;
  onOpen: () => void;
}) {
  const { tr, formatRelativeTime } = useI18n();
  const agent = providerAgent(provider);
  const windows = visibleQuotaWindows(provider, preferences);
  return (
    <section
      aria-label={provider.name}
      className="mx-3 grid grid-cols-[minmax(0,1fr)] gap-3 rounded-xl border border-border bg-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        {agent && <AgentMark agent={agent} size={16} />}
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{provider.name}</h2>
        <span
          className={cn(
            "text-xs text-muted-foreground",
            snapshot.freshness === "stale" && "text-[var(--amber)]",
          )}
        >
          {snapshot.freshness === "stale"
            ? tr("quota.freshness.stale")
            : formatRelativeTime(snapshot.fetched_at)}
        </span>
        <Button
          variant="bare"
          size="content"
          aria-label={tr("quota.refresh")}
          disabled={refreshing}
          className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          onClick={onRefresh}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>
      {windows.map((item) => (
        <QuotaBar key={item.key} item={item} snapshot={snapshot} />
      ))}
      {error && <p className="text-xs text-[var(--amber)]">{error}</p>}
      <Button
        variant="bare"
        size="content"
        className="justify-self-start rounded-md font-medium text-primary-text underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={onOpen}
      >
        <span className="text-xs">{tr("menubar.openQuota")}</span>
      </Button>
    </section>
  );
}

function QuotaBar({ item, snapshot }: { item: QuotaDisplayWindow; snapshot: QuotaSnapshot }) {
  const { tr } = useI18n();
  const resetAt = item.window.reset_at ? Date.parse(item.window.reset_at) : NaN;
  const staleAt = Date.parse(snapshot.generated_at) + snapshot.stale_after_seconds * 1000;
  const now = useQuotaClock(resetAt, staleAt);
  const known =
    item.window.usage_known !== false && typeof item.window.remaining_percent === "number";
  const remaining = known ? Math.min(100, Math.max(0, item.window.remaining_percent!)) : 0;
  const reset =
    !Number.isFinite(resetAt) || resetAt <= now
      ? undefined
      : tr("quota.resets", { time: relativeReset(resetAt - now, tr) });
  const detail = known
    ? [tr("quota.remaining", { value: Math.round(remaining) }), reset].filter(Boolean).join(" · ")
    : tr("quota.unavailable");
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="truncate">
          {item.accountLabel ? `${item.accountLabel} · ` : ""}
          {item.window.label || tr(`quota.window.${item.window.kind}`)}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{detail}</span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role={known ? "progressbar" : undefined}
        aria-valuemin={known ? 0 : undefined}
        aria-valuemax={known ? 100 : undefined}
        aria-valuenow={known ? Math.round(remaining) : undefined}
        aria-valuetext={known ? detail : undefined}
      >
        <i
          className={cn(
            "block h-full rounded-[inherit]",
            known && quotaSeverity(remaining) === "healthy" && "bg-primary",
            known && quotaSeverity(remaining) === "warning" && "bg-[var(--amber)]",
            known && quotaSeverity(remaining) === "danger" && "bg-[var(--red)]",
          )}
          style={{ width: `${remaining}%` }}
        />
      </div>
    </div>
  );
}
