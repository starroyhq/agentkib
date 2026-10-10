import { useI18n } from "@/core/useI18n";
import { Button } from "@/components/ui/button";
import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";

import { quotaSeverity, type QuotaDisplayWindow } from "@/features/quota/quota";
import type { AgentKind, QuotaProvider, QuotaSnapshot } from "@/core/types";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { cn } from "cn";

export function ProviderIcon({ provider }: { provider: QuotaProvider }) {
  const agent = providerAgent(provider.id, provider.name);
  return agent ? (
    <AgentIcon agent={agent} />
  ) : (
    <span className="grid size-8 place-items-center rounded-lg bg-[var(--surface-hover)] text-muted-foreground">
      <Gauge size={18} />
    </span>
  );
}

export function QuotaWindowRow({
  item,
  snapshot,
  target = false,
  onOpen,
}: {
  item: QuotaDisplayWindow;
  snapshot?: QuotaSnapshot;
  target?: boolean;
  onOpen?: (item: QuotaDisplayWindow) => void;
}) {
  const { tr } = useI18n();
  const resetAt = item.window.reset_at ? Date.parse(item.window.reset_at) : NaN;
  const staleAt = snapshot
    ? Date.parse(snapshot.generated_at) + snapshot.stale_after_seconds * 1000
    : NaN;
  const now = useQuotaClock(resetAt, staleAt);
  const stale = snapshot && (snapshot.freshness !== "fresh" || !(staleAt > now));
  const remaining = item.window.remaining_percent;
  const severity = quotaSeverity(remaining);
  const content = (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <strong className="text-[15px]">
          {item.window.label || tr(`quota.window.${item.window.kind}`)}
        </strong>
        <span
          className={cn(
            "text-[19px] font-bold tabular-nums",
            severity === "healthy" && "text-primary",
            severity === "warning" && "text-[var(--amber)]",
            severity === "danger" && "text-[var(--red)]",
          )}
        >
          {Math.round(remaining)}%
        </span>
      </div>
      <div
        className="h-[7px] overflow-hidden rounded-full bg-[var(--surface-hover)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(remaining)}
        aria-valuetext={tr("quota.remaining", { value: Math.round(remaining) })}
      >
        <i
          className={cn(
            "block h-full rounded-[inherit] bg-primary",
            severity === "warning" && "bg-[var(--amber)]",
            severity === "danger" && "bg-[var(--red)]",
          )}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground">
        <span>{tr("quota.remaining", { value: Math.round(remaining) })}</span>
        <span>
          {stale
            ? tr("quota.staleReset")
            : !Number.isFinite(resetAt)
              ? tr("quota.noReset")
              : resetAt <= now
                ? tr("quota.resetElapsed")
                : tr("quota.resets", { time: relativeReset(resetAt - now, tr) })}
        </span>
      </div>
    </>
  );
  return onOpen ? (
    <Button
      variant="bare"
      size="content"
      type="button"
      className={cn(
        "grid w-full gap-2.5 rounded-xl border border-border bg-background px-4 py-4 text-left text-foreground transition-colors hover:border-primary/35 hover:bg-muted/45",
        target && "border-primary/55 bg-primary/[0.08]",
      )}
      data-quota-target={target || undefined}
      onClick={() => onOpen(item)}
    >
      {content}
    </Button>
  ) : (
    <article
      className={cn(
        "grid w-full gap-2.5 rounded-xl border border-border bg-background px-4 py-4 text-left text-foreground",
        target && "border-primary/55 bg-primary/[0.08]",
      )}
      data-quota-target={target || undefined}
    >
      {content}
    </article>
  );
}

function providerAgent(id: string, name: string): AgentKind | undefined {
  const value = `${id} ${name}`.toLowerCase();
  if (value.includes("codex")) return "codex";
  if (value.includes("claude")) return "claude-code";
  if (value.includes("cursor")) return "cursor";
  if (value.includes("openclaw") || value.includes("open-claw")) return "open-claw";
  if (value.includes("hermes")) return "hermes";
  return undefined;
}

function useQuotaClock(resetAt: number, staleAt: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const current = Date.now();
      setNow(current);
      const upcoming = [resetAt, staleAt].filter((time) => time > current);
      if (upcoming.length)
        timer = setTimeout(tick, Math.min(60_000, ...upcoming.map((time) => time - current)));
    };
    tick();
    return () => clearTimeout(timer);
  }, [resetAt, staleAt]);
  return now;
}

function relativeReset(milliseconds: number, tr: ReturnType<typeof useI18n>["tr"]) {
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 3600)
    return tr("quota.duration.minutes", { value: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 86400) return tr("quota.duration.hours", { value: Math.round(seconds / 3600) });
  return tr("quota.duration.days", { value: Math.round(seconds / 86400) });
}
