import { Button } from "@/components/ui/button";
import { Gauge } from "lucide-react";
import { tr } from "@/core/i18n";
import { quotaSeverity, type QuotaDisplayWindow } from "@/features/quota/quota";
import type { AgentKind, QuotaProvider } from "@/core/types";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { cn } from "@/lib/utils";

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
  target = false,
  onOpen,
}: {
  item: QuotaDisplayWindow;
  target?: boolean;
  onOpen?: (item: QuotaDisplayWindow) => void;
}) {
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
          {item.window.reset_at
            ? tr("quota.resets", { time: relativeReset(item.window.reset_at) })
            : tr("quota.noReset")}
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

function relativeReset(value: string) {
  const seconds = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 1000));
  if (seconds < 3600)
    return tr("quota.duration.minutes", { value: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 86400) return tr("quota.duration.hours", { value: Math.round(seconds / 3600) });
  return tr("quota.duration.days", { value: Math.round(seconds / 86400) });
}
