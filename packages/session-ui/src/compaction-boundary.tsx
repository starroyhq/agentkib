import type { ConversationEvent } from "@agentkib/web-client";
import { ArrowLeftRight } from "lucide-react";

type BoundaryLocale = "zh-CN" | "zh-Hant" | "en-US" | "ja-JP";

function normalizeLocale(locale: string): BoundaryLocale {
  if (locale === "zh-Hant") return "zh-Hant";
  if (locale.startsWith("zh")) return "zh-CN";
  if (locale.startsWith("ja")) return "ja-JP";
  return "en-US";
}

const copy: Record<
  BoundaryLocale,
  {
    label: string;
    auto: string;
    manual: string;
    wrapTrigger: (base: string, trigger: string) => string;
  }
> = {
  "zh-CN": {
    label: "已压缩上下文",
    auto: "自动",
    manual: "手动",
    wrapTrigger: (base, trigger) => `${base}（${trigger}）`,
  },
  "zh-Hant": {
    label: "已壓縮上下文",
    auto: "自動",
    manual: "手動",
    wrapTrigger: (base, trigger) => `${base}（${trigger}）`,
  },
  "en-US": {
    label: "Context compacted",
    auto: "Auto",
    manual: "Manual",
    wrapTrigger: (base, trigger) => `${base} (${trigger})`,
  },
  "ja-JP": {
    label: "コンテキストを圧縮しました",
    auto: "自動",
    manual: "手動",
    wrapTrigger: (base, trigger) => `${base}（${trigger}）`,
  },
};

function formatClock(timestamp: string | undefined, locale: BoundaryLocale): string | undefined {
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return undefined;
  }
}

export function compactionBoundaryLabel(
  locale: string,
  timestamp?: string,
  trigger?: ConversationEvent["compaction_trigger"],
): string {
  const loc = normalizeLocale(locale);
  const words = copy[loc];
  const clock = formatClock(timestamp, loc);
  const base = clock ? `${words.label} · ${clock}` : words.label;
  if (trigger === "auto") return words.wrapTrigger(base, words.auto);
  if (trigger === "manual") return words.wrapTrigger(base, words.manual);
  return base;
}

export function CompactionBoundaryRow({
  event,
  locale,
}: {
  event: Pick<ConversationEvent, "id" | "timestamp" | "compaction_trigger">;
  locale: string;
}) {
  const trigger = event.compaction_trigger ?? "unknown";
  const label = compactionBoundaryLabel(locale, event.timestamp, trigger);
  return (
    <div
      role="separator"
      aria-label={label}
      data-event-id={event.id}
      data-compaction-boundary={trigger}
      className="my-1 flex w-full max-w-3xl items-center gap-3"
    >
      <span aria-hidden="true" className="h-px flex-1 border-t border-dashed border-border/80" />
      <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border/75 bg-foreground/[0.03] px-2.5 text-[11.5px] font-medium text-muted-foreground">
        <ArrowLeftRight aria-hidden="true" className="size-3 shrink-0 opacity-75" />
        <span className="tabular-nums">{label}</span>
      </span>
      <span aria-hidden="true" className="h-px flex-1 border-t border-dashed border-border/80" />
    </div>
  );
}
