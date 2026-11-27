import { useId, useImperativeHandle, useState, type Ref } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import type { contextUsageCopyForSurface } from "./context-usage-copy";
import { ContextUsageRing } from "./context-usage-ring";
import type { SessionContextUsageView } from "./session-context-usage";

export type ContextUsageHandle = { open(): void };
export type ContextUsageView = Pick<
  SessionContextUsageView,
  "usage" | "state" | "percent" | "compacting" | "source" | "capacity" | "awaitingCliReport"
>;

type UsageProps = {
  locale: string;
  view: ContextUsageView;
  copy: ReturnType<typeof contextUsageCopyForSurface>;
};
type IndicatorProps = UsageProps & {
  scope: string;
  title: string;
  usageRef?: Ref<ContextUsageHandle>;
};

function usageLabels({ locale, view, copy }: UsageProps) {
  const { usage, state, percent, compacting } = view;
  const displayedPercent =
    percent !== undefined && !compacting && (state === "ready" || state === "stale")
      ? Math.round(percent)
      : undefined;
  const count =
    !compacting &&
    state !== "pending" &&
    usage?.available &&
    Number.isSafeInteger(usage.usedTokens) &&
    Number(usage.usedTokens) >= 0
      ? usage.usedTokens
      : undefined;
  const window = usage?.contextWindow ?? view.capacity;
  const capacity =
    percent === undefined &&
    !compacting &&
    window !== undefined &&
    Number.isSafeInteger(window) &&
    window > 0
      ? copy.capacity.replace("{total}", window.toLocaleString(locale))
      : undefined;
  const proportions =
    displayedPercent !== undefined
      ? copy.usedRemaining
          .replace("{used}", String(displayedPercent))
          .replace("{remaining}", String(100 - displayedPercent))
      : undefined;
  const tokens =
    count === undefined
      ? undefined
      : displayedPercent !== undefined
        ? copy.tokenUsage
            .replace("{used}", count.toLocaleString(locale))
            .replace("{total}", window!.toLocaleString(locale))
        : copy.tokenUsageOnly.replace("{used}", count.toLocaleString(locale));
  const hasValue = capacity !== undefined || proportions !== undefined || tokens !== undefined;
  const status = compacting ? copy.compacting : hasValue ? undefined : "—";
  return {
    status,
    capacity,
    proportions,
    tokens,
    displayedPercent,
    description: [status, capacity, proportions, tokens].filter(Boolean).join(" "),
  };
}

function ScopedIndicator({ locale, view, copy, title, usageRef }: IndicatorProps) {
  const { status, capacity, proportions, tokens, displayedPercent, description } = usageLabels({
    locale,
    view,
    copy,
  });
  const triggerId = useId();
  const [tooltip] = useState(() => Tooltip.createHandle());
  useImperativeHandle(usageRef, () => ({ open: () => tooltip.open(triggerId) }), [
    tooltip,
    triggerId,
  ]);
  return (
    <Tooltip.Root handle={tooltip}>
      <Tooltip.Trigger
        handle={tooltip}
        id={triggerId}
        onPointerUp={(event) => {
          if (event.pointerType === "touch") tooltip.open(triggerId);
        }}
        closeOnClick={false}
        render={
          <span
            role="img"
            tabIndex={0}
            className="inline-flex size-8 shrink-0 cursor-default items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={title}
            aria-description={description}
          >
            <ContextUsageRing percent={displayedPercent === undefined ? undefined : view.percent} />
          </span>
        }
      />
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={8} className="isolate z-[100]">
          <Tooltip.Popup
            role="tooltip"
            className="z-[100] w-fit max-w-64 rounded-2xl border border-border bg-popover px-4 py-3 text-center text-sm leading-5 font-normal text-popover-foreground shadow-lg dark:border-white/10 dark:bg-[#2b2b2b] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
          >
            <p className="text-muted-foreground">{copy.windowTitle}</p>
            {status && <p className="mt-1">{status}</p>}
            {capacity && <p className="mt-1">{capacity}</p>}
            {proportions && <p className="mt-1">{proportions}</p>}
            {tokens && <p className="mt-1">{tokens}</p>}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function ContextUsageIndicator(props: IndicatorProps) {
  return props.view.source === "unsupported" ? null : (
    <ScopedIndicator key={props.scope} {...props} />
  );
}
