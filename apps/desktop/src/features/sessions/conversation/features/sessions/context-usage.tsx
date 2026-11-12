import { useRef } from "react";
import type { ContextUsage, Live } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSession } from "./session-context";
import { codexCopy } from "./codex-copy";
import { contextUsageCopy, contextUsageReason } from "./context-usage-copy";

export function contextUsagePercent(usage?: ContextUsage) {
  if (
    !usage ||
    (!usage.available && usage.state !== "stale" && usage.state !== "pending") ||
    !Number.isFinite(usage.usedTokens) ||
    Number(usage.usedTokens) < 0 ||
    !Number.isFinite(usage.contextWindow) ||
    Number(usage.contextWindow) <= 0
  )
    return undefined;
  return Math.min(100, Math.max(0, (Number(usage.usedTokens) / Number(usage.contextWindow)) * 100));
}

type Observation = {
  scope: string;
  identity: unknown;
  blockedLive?: Live;
  lastLive?: Live;
  lastNative?: ContextUsage;
  lastFallback?: ContextUsage;
  blockedFallback?: ContextUsage;
  usage?: ContextUsage;
  nativeSeen: boolean;
  nativeReported?: boolean;
  compacting?: boolean;
  afterCompaction?: { reportId?: number; updatedAt?: string; native?: ContextUsage };
};

function acceptsReport(native: ContextUsage, current?: ContextUsage) {
  if (current?.reportGeneration !== undefined) {
    if (native.reportGeneration === undefined || native.reportGeneration < current.reportGeneration)
      return false;
    if (native.reportGeneration > current.reportGeneration) return true;
  } else if (native.reportGeneration !== undefined) return true;
  return (
    native.reportId === undefined ||
    current?.reportId === undefined ||
    native.reportId >= current.reportId
  );
}

/** Settings are a compatibility fallback; a native report always has priority. */
export function useContextUsage(fallback?: ContextUsage) {
  const { selected, current, client, access, live, online, usageEpoch } = useSession();
  const authorized =
    access?.device?.accessMode === "full" && access.device.advancedControl === true;
  const scope = `${selected}\0${access?.bootId ?? ""}\0${access?.device?.id ?? ""}\0${authorized}\0${usageEpoch ?? ""}\0${live?.connectionGeneration ?? ""}`;
  const view = useObservedContextUsage({
    selected,
    scope,
    identity: client,
    live,
    online,
    authorized,
    fallback,
  });
  return {
    ...view,
    awaitingCliReport:
      current?.id === selected &&
      current.agent === "claude-code" &&
      live?.sessionId === selected &&
      live.executionMode === "claude-managed" &&
      !live.executionLocation &&
      ["idle", "released"].includes(live.status) &&
      !live.reason &&
      authorized &&
      online &&
      view.state === "unavailable" &&
      !view.usage?.available &&
      !view.usage?.reason &&
      view.percent === undefined,
  };
}

export function useObservedContextUsage({
  selected,
  scope,
  identity,
  live,
  online,
  authorized,
  fallback,
}: {
  selected: string;
  scope: string;
  identity?: unknown;
  live?: Live;
  online: boolean;
  authorized: boolean;
  fallback?: ContextUsage;
}) {
  const observation = useRef<Observation | undefined>(undefined);
  if (observation.current?.scope !== scope || observation.current?.identity !== identity) {
    const previous = observation.current;
    observation.current = {
      scope,
      identity,
      blockedLive:
        previous && previous.lastLive === live && previous.scope.split("\0")[0] === selected
          ? live
          : undefined,
      blockedFallback: previous && previous.lastFallback === fallback ? fallback : undefined,
      nativeSeen: false,
    };
  }
  const value = observation.current;
  value.lastLive = live;
  value.lastFallback = fallback;
  const native =
    authorized && live?.sessionId === selected && live !== value.blockedLive
      ? (live.usage ?? live.settings?.usage)
      : undefined;
  const acceptsNative = native !== undefined && acceptsReport(native, value.usage);
  if (native && native !== value.lastNative) {
    value.lastNative = native;
    if (acceptsNative) {
      // Native observers can rebuild while the shared transport epoch remains alive.
      if (
        native.reportGeneration !== undefined &&
        native.reportGeneration !== value.usage?.reportGeneration
      )
        value.afterCompaction = undefined;
      value.usage = native;
      if (contextUsagePercent(native) !== undefined) value.nativeReported = true;
    }
    value.nativeSeen = true;
  }
  const settingsReport = fallback !== value.blockedFallback ? fallback : undefined;
  const history = settingsReport?.historical === true ? settingsReport : undefined;
  const observed = value.nativeSeen ? value.usage : history ? undefined : settingsReport;
  if (
    authorized &&
    live?.sessionId === selected &&
    live !== value.blockedLive &&
    (acceptsNative || (!native && value.usage?.reportGeneration === undefined))
  )
    value.compacting = live.activity === "compacting";
  // A late report must not activate or release the accepted observer's barrier.
  const compacting = authorized && value.compacting === true;
  const acceptedNative = acceptsNative ? native : undefined;
  if (compacting)
    value.afterCompaction ??= {
      reportId: observed?.reportId,
      updatedAt: observed?.updatedAt,
      native: acceptedNative,
    };
  else if (
    value.afterCompaction &&
    observed?.state !== "pending" &&
    observed?.state !== "stale" &&
    ((observed?.reportId !== undefined &&
      (value.afterCompaction.reportId === undefined ||
        observed.reportId > value.afterCompaction.reportId)) ||
      (observed?.reportId === undefined &&
        acceptedNative !== undefined &&
        acceptedNative !== value.afterCompaction.native &&
        acceptedNative.updatedAt !== value.afterCompaction.updatedAt))
  )
    value.afterCompaction = undefined;
  // The idle live snapshot may contain an empty usage placeholder. Saved usage
  // can fill that gap but cannot settle a compaction or replace a native count.
  const useHistory =
    history !== undefined &&
    contextUsagePercent(history) !== undefined &&
    contextUsagePercent(observed) === undefined &&
    !value.nativeReported &&
    !compacting &&
    !value.afterCompaction &&
    (!live ||
      (live.sessionId === selected &&
        (live.status === "idle" || live.status === "unsupported") &&
        !live.executionLocation));
  const usage: ContextUsage | undefined = !authorized
    ? { available: false, state: "unavailable", reason: "permission_denied" }
    : useHistory
      ? history
      : observed;
  const percent = contextUsagePercent(usage);
  const state = compacting
    ? "pending"
    : usage?.historical ||
        (!online && authorized) ||
        (percent !== undefined && value.afterCompaction !== undefined)
      ? "stale"
      : usage?.state === "ready" && percent === undefined
        ? "unavailable"
        : (usage?.state ?? (percent === undefined ? "unavailable" : "ready"));
  return { usage, percent, state, compacting };
}

type ContextUsageView = ReturnType<typeof useObservedContextUsage> & {
  awaitingCliReport?: boolean;
};

function historicalUsageLabel(locale: Locale, usage?: ContextUsage) {
  if (usage?.historical !== true) return undefined;
  const label = contextUsageCopy[locale].historicalReport;
  const timestamp = Date.parse(usage.updatedAt ?? "");
  if (!Number.isFinite(timestamp)) return label;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    timestamp,
  );
  return `${label} · ${date}`;
}

function contextUsageMessage({
  usage,
  state,
  compacting,
  awaitingCliReport,
  locale,
  online,
}: ContextUsageView & { locale: Locale; online: boolean }) {
  const copy = contextUsageCopy[locale];
  return compacting
    ? copy.compactingDetail
    : usage?.historical
      ? copy.historicalDetail
      : !online && usage?.reason !== "permission_denied" && usage?.reason !== "permission-denied"
        ? copy.offline
        : awaitingCliReport
          ? copy.awaitingCliReportDetail
          : (contextUsageReason(locale, usage?.reason) ??
            (state === "pending"
              ? copy.pendingDetail
              : state === "stale"
                ? copy.staleDetail
                : codexCopy[locale].contextUnknown));
}

export function ContextUsageDetails({
  usage,
  percent,
  state,
  compacting,
  awaitingCliReport,
  locale,
  online,
}: ContextUsageView & { locale: Locale; online: boolean }) {
  const copy = contextUsageCopy[locale];
  const historyLabel = historicalUsageLabel(locale, usage);
  const message = contextUsageMessage({
    usage,
    percent,
    state,
    compacting,
    awaitingCliReport,
    locale,
    online,
  });
  return (
    <div className="space-y-2 text-sm">
      {state !== "ready" && <p role="status">{message}</p>}
      {percent !== undefined && (
        <div className="space-y-2">
          <p>
            {`${historyLabel ?? (state === "ready" ? copy.recentNativeReport : copy.reported)}: `}
            {usage!.usedTokens!.toLocaleString()} / {usage!.contextWindow!.toLocaleString()} (
            {Math.round(percent)}%)
          </p>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}

export function ContextUsageGauge({ fallback }: { fallback?: ContextUsage } = {}) {
  const { selected, locale, access, live, online, usageEpoch } = useSession();
  const scope = `${selected}\0${access?.bootId ?? ""}\0${access?.device?.id ?? ""}\0${usageEpoch ?? ""}\0${live?.connectionGeneration ?? ""}`;
  const view = useContextUsage(fallback);
  return <ContextUsageIndicator scope={scope} locale={locale} online={online} view={view} />;
}

export function ContextUsageIndicator({
  scope,
  locale,
  online,
  view,
}: {
  scope: string;
  locale: Locale;
  online: boolean;
  view: ContextUsageView;
}) {
  const copy = contextUsageCopy[locale];
  const title = codexCopy[locale].contextUsage;
  const historyLabel = historicalUsageLabel(locale, view.usage);
  const reported = view.percent !== undefined;
  const used = Math.round(view.percent ?? 0);
  const proportions = copy.usedRemaining
    .replace("{used}", String(used))
    .replace("{remaining}", String(100 - used));
  const tokens = reported
    ? copy.tokenUsage
        .replace(
          "{used}",
          new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
            view.usage!.usedTokens!,
          ),
        )
        .replace(
          "{total}",
          new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
            view.usage!.contextWindow!,
          ),
        )
    : undefined;
  const fresh =
    view.state === "ready" && !historyLabel && !view.compacting && !view.awaitingCliReport;
  const description = [
    !fresh && contextUsageMessage({ ...view, locale, online }),
    !view.compacting && historyLabel,
    reported && !view.compacting && proportions,
    reported && !view.compacting && tokens,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tooltip key={scope}>
      <TooltipTrigger
        closeOnClick={false}
        render={
          <span
            role="img"
            tabIndex={0}
            className="inline-flex size-8 shrink-0 cursor-default items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:outline-2 focus-visible:outline-ring"
            aria-label={title}
            aria-description={description}
          >
            <svg
              className="size-4"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              aria-hidden="true"
            >
              <circle
                cx="10"
                cy="10"
                r="7.5"
                opacity="0.25"
                strokeDasharray={!reported || view.compacting ? "2 2" : undefined}
              />
              {reported && !view.compacting && view.percent! > 0 && (
                <circle
                  cx="10"
                  cy="10"
                  r="7.5"
                  pathLength="100"
                  strokeDasharray={`${view.percent} 100`}
                  transform="rotate(-90 10 10)"
                  opacity={fresh ? 1 : 0.5}
                />
              )}
            </svg>
          </span>
        }
      />
      <TooltipContent
        role="tooltip"
        className="max-w-64 rounded-2xl bg-popover px-4 py-3 text-center text-sm leading-5 font-normal text-popover-foreground dark:border-white/10 dark:bg-[#2b2b2b]"
        sideOffset={8}
      >
        <p className="text-muted-foreground">{copy.windowTitle}</p>
        {!fresh && <p className="mt-1">{contextUsageMessage({ ...view, locale, online })}</p>}
        {reported && !view.compacting && (
          <>
            {!fresh && (
              <p className="mt-1 text-muted-foreground">{historyLabel ?? copy.reported}</p>
            )}
            <p className="mt-1">{proportions}</p>
            <p className="mt-1">{tokens}</p>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
