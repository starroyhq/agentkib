import { useRef } from "react";
import type { Access, ContextUsage, Live, SessionProviderCapabilities } from "@agentkib/web-client";

export function canReadContextUsage(access?: Access) {
  return (
    access?.status === "approved" &&
    access.device?.accessMode === "full" &&
    access.device.advancedControl === true
  );
}

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
  epoch?: string;
  retained?: ContextUsage;
  model?: string;
  blockedModelReport?: ContextUsage;
  blockedLive?: Live;
  lastLive?: Live;
  lastNative?: ContextUsage;
  lastFallback?: ContextUsage;
  blockedFallback?: ContextUsage;
  usage?: ContextUsage;
  nativeSeen: boolean;
  nativeReported?: boolean;
  compacting?: boolean;
  /** Native host time, so a remote device never orders two reports using its own clock. */
  compactStartedAt?: number;
  afterCompaction?: { reportId?: number; updatedAt?: string; native?: ContextUsage };
};

function hasTokens(usage?: ContextUsage): usage is ContextUsage & { usedTokens: number } {
  return (
    usage?.available === true &&
    Number.isSafeInteger(usage.usedTokens) &&
    Number(usage.usedTokens) >= 0
  );
}

function isTransientUsage(usage?: ContextUsage) {
  return (
    !usage ||
    (!hasTokens(usage) &&
      usage.reportId === undefined &&
      usage.reportGeneration === undefined &&
      (!usage.reason ||
        [
          "usage-unavailable",
          "usage-not-reported",
          "not-reported",
          "offline",
          "disconnected",
        ].includes(usage.reason)))
  );
}

function replaysCachedCount(usage: ContextUsage | undefined, retained: ContextUsage | undefined) {
  return (
    hasTokens(usage) &&
    usage.historical === true &&
    usage.state !== "pending" &&
    usage.contextWindow === undefined &&
    Number.isFinite(Date.parse(usage.updatedAt ?? "")) &&
    hasTokens(retained) &&
    usage.usedTokens === retained.usedTokens &&
    usage.updatedAt === retained.updatedAt &&
    contextUsagePercent(retained) !== undefined
  );
}

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

type ContextUsageSource = SessionProviderCapabilities["contextUsage"];

export function useObservedContextUsage({
  selected,
  scope,
  identity,
  epoch,
  live,
  online,
  authorized,
  fallback,
  source,
}: {
  selected: string;
  scope: string;
  identity?: unknown;
  epoch?: string;
  live?: Live;
  online: boolean;
  authorized: boolean;
  fallback?: ContextUsage;
  source?: ContextUsageSource;
}) {
  const observation = useRef<Observation | undefined>(undefined);
  const previous = observation.current;
  const sameAuthority = previous?.scope === scope && previous.identity === identity;
  const model =
    live?.sessionId === selected
      ? (live.model ??
        (live.settings?.sessionId === selected ? live.settings.current.modelId : undefined))
      : undefined;
  const modelChanged = sameAuthority && model !== undefined && model !== previous.model;
  if (!sameAuthority || previous.epoch !== epoch) {
    observation.current = {
      scope,
      identity,
      epoch,
      model: model ?? (sameAuthority ? previous.model : undefined),
      retained:
        sameAuthority && authorized && source !== "last-request" && !modelChanged
          ? previous.retained
          : undefined,
      afterCompaction: sameAuthority && previous.afterCompaction ? {} : undefined,
      compactStartedAt: sameAuthority ? previous.compactStartedAt : undefined,
      blockedLive: previous && previous.lastLive === live ? live : undefined,
      blockedFallback:
        !sameAuthority && previous && previous.lastFallback === fallback ? fallback : undefined,
      nativeSeen: false,
    };
  }
  const value = observation.current!;
  if (modelChanged) {
    value.model = model;
    value.retained = undefined;
    if (contextUsagePercent(previous.usage) !== undefined)
      value.blockedModelReport = previous.usage;
    if (fallback && fallback === previous.lastFallback) value.blockedFallback = fallback;
  }
  value.lastLive = live;
  value.lastFallback = fallback;
  const report = live?.usage ?? live?.settings?.usage;
  const eligibleReport = source !== "last-request" || report?.historical === true;
  const native =
    eligibleReport && authorized && live?.sessionId === selected && live !== value.blockedLive
      ? report
      : undefined;
  const started =
    live?.executionMode === "claude-follower" &&
    live.activity === "compacting" &&
    native?.reason === "session-compacting"
      ? Date.parse(native.updatedAt ?? "")
      : NaN;
  if (Number.isFinite(started) && started > (value.compactStartedAt ?? -Infinity)) {
    value.compactStartedAt = started;
    value.nativeReported = false;
  }
  const followsCompaction = (usage: ContextUsage) =>
    value.compactStartedAt === undefined ||
    Date.parse(usage.updatedAt ?? "") >= value.compactStartedAt;
  const acceptsNative =
    native !== undefined &&
    (!native.historical || followsCompaction(native)) &&
    acceptsReport(native, value.usage);
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
      if (hasTokens(native)) value.nativeReported = true;
    }
    value.nativeSeen = true;
  }
  const settingsReport = fallback !== value.blockedFallback ? fallback : undefined;
  const history =
    settingsReport?.historical && followsCompaction(settingsReport) ? settingsReport : undefined;
  const latest = value.nativeSeen
    ? value.usage
    : settingsReport?.historical
      ? undefined
      : settingsReport;
  const observed = latest !== value.blockedModelReport ? latest : undefined;
  if (
    authorized &&
    live?.sessionId === selected &&
    live !== value.blockedLive &&
    (acceptsNative ||
      ((!native || (native.historical && value.compactStartedAt !== undefined)) &&
        value.usage?.reportGeneration === undefined))
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
    value.compactStartedAt !== undefined &&
    (hasTokens(history) || (hasTokens(acceptedNative) && followsCompaction(acceptedNative)))
  )
    value.afterCompaction = undefined;
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
        (acceptedNative.updatedAt !== value.afterCompaction.updatedAt ||
          (value.afterCompaction.native === undefined &&
            hasTokens(acceptedNative) &&
            !acceptedNative.historical))))
  )
    value.afterCompaction = undefined;
  const denied =
    observed?.reason === "permission_denied" ||
    observed?.reason === "permission-denied" ||
    observed?.reason === "same_origin_required";
  const placeholder = isTransientUsage(observed);
  const canUseCache =
    authorized &&
    !denied &&
    !compacting &&
    !value.afterCompaction &&
    (!live || live.sessionId === selected);
  // Keep the entire verified observation. A different count must not inherit its window.
  const retained = value.retained;
  const saved =
    canUseCache && retained && (placeholder || replaysCachedCount(observed, retained))
      ? { ...retained, historical: true as const, state: "stale" as const }
      : undefined;
  const historical =
    canUseCache && placeholder && !value.nativeReported && hasTokens(history) ? history : undefined;
  const usage: ContextUsage | undefined =
    !authorized || denied
      ? { available: false, state: "unavailable", reason: "permission_denied" }
      : (saved ?? historical ?? observed);
  if (canUseCache && hasTokens(usage) && usage.state !== "pending") value.retained = usage;
  else if (!canUseCache || !placeholder) value.retained = undefined;
  const percent = contextUsagePercent(usage);
  const state = compacting
    ? "pending"
    : usage?.historical ||
        (!online && authorized) ||
        (percent !== undefined && value.afterCompaction !== undefined)
      ? "stale"
      : usage?.state === "ready" && !hasTokens(usage)
        ? "unavailable"
        : (usage?.state ?? (percent === undefined ? "unavailable" : "ready"));
  return { usage, percent, state, compacting };
}
