import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { QuotaProvider, QuotaSnapshot } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { cn } from "cn";
import { flattenQuotaWindows } from "./quota";
import { useQuotaClock } from "./QuotaDisplay";

const agents = [
  {
    id: "codex",
    name: "Codex",
    stroke: "stroke-neutral-700 dark:stroke-white",
    dot: "bg-neutral-700 dark:bg-white",
  },
  {
    id: "claude",
    name: "Claude Code",
    stroke: "stroke-[#d97757]",
    dot: "bg-[#d97757]",
  },
] as const;

function minimumWindow(providers: QuotaProvider[], agent: "codex" | "claude") {
  return providers
    .filter((provider) => {
      const id = provider.id.trim().toLowerCase();
      return provider.enabled && (id === agent || (agent === "claude" && id === "claude-code"));
    })
    .flatMap(flattenQuotaWindows)
    .filter(
      ({ window }) =>
        window.usage_known !== false &&
        typeof window.remaining_percent === "number" &&
        Number.isFinite(window.remaining_percent) &&
        window.remaining_percent >= 0 &&
        window.remaining_percent <= 100,
    )
    .reduce<ReturnType<typeof flattenQuotaWindows>[number] | undefined>(
      (minimum, item) =>
        !minimum || Number(item.window.remaining_percent) < Number(minimum.window.remaining_percent)
          ? item
          : minimum,
      undefined,
    );
}

export function QuotaNavigationButton({
  snapshot,
  label,
  active,
  shortcut,
  onClick,
}: {
  snapshot?: QuotaSnapshot;
  label: string;
  active: boolean;
  shortcut?: string;
  onClick: () => void;
}) {
  const { tr } = useI18n();
  const staleAt = snapshot
    ? Date.parse(snapshot.generated_at) + snapshot.stale_after_seconds * 1000
    : NaN;
  const now = useQuotaClock(NaN, staleAt);
  const stale = !!snapshot && (snapshot.freshness !== "fresh" || !(staleAt > now));
  const segments = agents.map((agent) => {
    const item = minimumWindow(snapshot?.providers ?? [], agent.id);
    return {
      ...agent,
      item,
      remaining: item?.window.remaining_percent,
      description:
        item && typeof item.window.remaining_percent === "number"
          ? `${tr("quota.remaining", { value: Math.round(item.window.remaining_percent) })} · ${tr("quota.lowestRemaining")}`
          : tr("quota.unavailable"),
    };
  });
  const description = [
    ...segments.map((segment) => `${segment.name}: ${segment.description}`),
    ...(stale ? [tr("quota.freshness.stale")] : []),
  ].join("; ");
  const codexLength = (segments[0].remaining ?? 0) / 2;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="bare"
            size="content"
            className={cn("activity-bar-item", active && "activity-bar-item-active")}
            aria-label={label}
            aria-description={description}
            aria-current={active ? "page" : undefined}
            aria-keyshortcuts={shortcut}
            onClick={onClick}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth="2.4"
              aria-hidden="true"
            >
              <circle
                cx="12"
                cy="12"
                r="9"
                stroke="var(--sidebar-foreground)"
                opacity="0.22"
                strokeDasharray={
                  segments.every((segment) => segment.remaining === undefined) ? "2 3" : undefined
                }
              />
              <g transform="rotate(-90 12 12)">
                {segments.map((segment) => {
                  const length = (segment.remaining ?? 0) / 2;
                  return length > 0 ? (
                    <circle
                      key={segment.id}
                      cx="12"
                      cy="12"
                      r="9"
                      pathLength="100"
                      className={segment.stroke}
                      opacity={stale ? 0.55 : 1}
                      strokeDasharray={`${length} ${100 - length}`}
                      strokeDashoffset={segment.id === "codex" ? 0 : -codexLength}
                    />
                  ) : null;
                })}
              </g>
            </svg>
            <span className="sr-only">{label}</span>
          </Button>
        }
      />
      <TooltipContent side="right" className="max-w-72">
        <div className="font-medium">{label}</div>
        {segments.map((segment) => (
          <div key={segment.id} className="mt-2">
            <div className="flex items-center gap-2">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", segment.dot)}
                aria-hidden="true"
              />
              <span>
                {segment.name} · {segment.description}
              </span>
            </div>
            {segment.item && (
              <div className="mt-0.5 pl-3.5 text-muted-foreground">
                {segment.item.accountLabel && `${segment.item.accountLabel} · `}
                {segment.item.window.label || tr(`quota.window.${segment.item.window.kind}`)}
              </div>
            )}
          </div>
        ))}
        {stale && <div className="mt-2 text-muted-foreground">{tr("quota.staleReset")}</div>}
      </TooltipContent>
    </Tooltip>
  );
}
