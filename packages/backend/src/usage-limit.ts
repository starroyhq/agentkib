/**
 * A usage limit an agent's account hit, as the agent reported it, and the automatic continue
 * AgentKib arms for it (docs/agents/usage-limits.md).
 *
 * The continue follows Claude Code's own "Continue automatically at usage limit" (2.1.323, on by
 * default for claude.ai subscriptions, interactive sessions only, so a host driving `claude -p`
 * has to do it): it arms only when the reset is at most 24 hours away, fires 30–90 s after the
 * reset, backs off 60 s and then 300 s when the limit is still in force, stops after three
 * continues the person did not ask for, and does not fire when the computer slept or AgentKib
 * was closed long past the time. A message the person sends meanwhile takes over.
 *
 * Codex sessions get the same continue. DeepSeek Harness reports no reset time, so its sessions
 * only say what happened.
 */

import { readPreferences } from "./preferences";

export type UsageLimitAgent = "claude-code" | "codex" | "deepseek-harness";

/** `model`: a model's own limit (`scope` names it); `credits`: usage credits; `quota`: an API balance. */
export type UsageLimitKind = "five-hour" | "weekly" | "model" | "credits" | "quota";

/**
 * Why AgentKib will not continue by itself: the person turned it off for this computer, no reset time, a reset more than a day away, three
 * continues in a row that met the limit again, the person turned it off, the time passed while
 * the computer slept or AgentKib was closed, or a later run of AgentKib.
 */
export type UsageLimitManual =
  | "off"
  | "reset-unknown"
  | "reset-too-far"
  | "repeated"
  | "cancelled"
  | "stale"
  | "restarted";

/** What the agent reported. */
export type UsageLimitHit = {
  /** When the limit resets, ms since the epoch; null when the agent did not say. */
  resetsAt: number | null;
  kind: UsageLimitKind | null;
  /** The model a model's own limit is for, as the agent names it (e.g. "Opus"). */
  scope: string | null;
  /** The agent's own message, untranslated. */
  message: string;
};

export type UsageLimit = UsageLimitHit & {
  agent: UsageLimitAgent;
  /** When AgentKib continues the session by itself; null when it won't (see `manual`). */
  continueAt: number | null;
  manual: UsageLimitManual | null;
  /** Automatic continues sent since the person last sent something. */
  autoContinues: number;
  /** The device whose turn met the limit: the continue is sent in its name. */
  deviceId: string;
  /** The AgentKib run that armed the continue; a later run does not fire it. */
  bootId: string;
};

const DAY_MS = 24 * 60 * 60_000;
/** Claude Code's grace: past the continue time by more than this, the person continues. */
export const USAGE_LIMIT_GRACE_MS = 30 * 60_000;
const STILL_LIMITED_BACKOFF_MS = [60_000, 300_000] as const;
const MAX_AUTO_CONTINUES = 3;
const JITTER_MIN_MS = 30_000;
const JITTER_SPAN_MS = 60_000;

/**
 * What AgentKib sends when it continues: Claude Code's own text (2.1.323), and the same words for
 * Codex, whose clients have none. The person reads it as a notice, not as their message.
 */
export const AUTO_CONTINUE_TEXT = {
  "claude-code":
    "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.",
  codex:
    "Your usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.",
} as const;

/** Whether `text` is a continue AgentKib sent, so readers can show it as a notice. */
export const isAutoContinueText = (text: unknown): boolean =>
  typeof text === "string" && Object.values(AUTO_CONTINUE_TEXT).includes(text.trim() as never);

/**
 * The hold for a limit a turn just met. `previous` is the hold an automatic continue was sent
 * for, when the turn that met the limit was that continue; a turn the person started counts
 * from zero.
 */
export function holdUsageLimit(
  agent: UsageLimitAgent,
  hit: UsageLimitHit,
  context: {
    deviceId: string;
    bootId: string;
    previous?: UsageLimit | null;
    /** The person's choice for this computer (`usageLimitAutoContinue`); on unless false. */
    autoContinue?: boolean;
    now?: number;
    random?: () => number;
  },
): UsageLimit {
  const now = context.now ?? Date.now();
  const autoContinues = context.previous?.autoContinues ?? 0;
  const base = { ...hit, agent, autoContinues, deviceId: context.deviceId, bootId: context.bootId };
  const manual = (reason: UsageLimitManual): UsageLimit => ({
    ...base,
    continueAt: null,
    manual: reason,
  });
  if (agent === "deepseek-harness" || hit.resetsAt === null) return manual("reset-unknown");
  if (context.autoContinue === false) return manual("off");
  if (autoContinues >= MAX_AUTO_CONTINUES) return manual("repeated");
  if (hit.resetsAt - now > DAY_MS) return manual("reset-too-far");
  if (hit.resetsAt <= now) {
    // Still limited at or after the time the agent gave: try again a little later.
    const backoff = STILL_LIMITED_BACKOFF_MS[Math.min(Math.max(autoContinues - 1, 0), 1)];
    return { ...base, continueAt: now + backoff, manual: null };
  }
  const jitter = JITTER_MIN_MS + Math.floor((context.random ?? Math.random)() * JITTER_SPAN_MS);
  return { ...base, continueAt: hit.resetsAt + jitter, manual: null };
}

/**
 * Whether the continue `limit` armed should be sent now: `due`, `wait`, `stale` (the time passed
 * long ago, so the person continues), or `never` (nothing armed, or armed by an earlier run).
 */
export function usageLimitContinue(
  limit: UsageLimit | null | undefined,
  bootId: string,
  now = Date.now(),
): "due" | "wait" | "stale" | "never" {
  if (!limit || limit.continueAt === null || limit.manual !== null) return "never";
  if (limit.bootId !== bootId) return "never";
  if (now < limit.continueAt) return "wait";
  return now - limit.continueAt > USAGE_LIMIT_GRACE_MS ? "stale" : "due";
}

/** The hold as clients see it: no device or run identity. */
export type UsageLimitView = Omit<UsageLimit, "deviceId" | "bootId">;

/**
 * What clients see. A hold armed by an earlier run of AgentKib reads as one the person
 * continues, as Claude Code's own wait ends when it exits.
 */
export function usageLimitView(
  limit: UsageLimit | null | undefined,
  bootId: string,
): UsageLimitView | null {
  if (!limit) return null;
  const { deviceId: _device, bootId: armedBy, ...view } = limit;
  return armedBy !== bootId && view.continueAt !== null
    ? { ...view, continueAt: null, manual: "restarted" }
    : view;
}

const ARMABLE = new Set<UsageLimitManual>([
  "off",
  "cancelled",
  "reset-too-far",
  "repeated",
  "restarted",
]);

/**
 * Whether the person can ask for the continue this time after all: nothing armed, a reset time
 * still ahead, and the continue off, turned off, a day or more away, stopped after three, or
 * armed by an earlier run of AgentKib.
 */
export function usageLimitArmable(
  limit: UsageLimit | null | undefined,
  bootId: string,
  now = Date.now(),
): boolean {
  const view = usageLimitView(limit, bootId);
  return (
    !!view &&
    view.continueAt === null &&
    view.resetsAt !== null &&
    view.resetsAt > now &&
    view.manual !== null &&
    ARMABLE.has(view.manual)
  );
}

/** The continue the person asked for: 30–90 s after the reset, counted afresh. Null when not armable. */
export function armUsageLimit(
  limit: UsageLimit | null | undefined,
  context: { bootId: string; now?: number; random?: () => number },
): UsageLimit | null {
  const now = context.now ?? Date.now();
  if (!limit || !usageLimitArmable(limit, context.bootId, now)) return null;
  const jitter = JITTER_MIN_MS + Math.floor((context.random ?? Math.random)() * JITTER_SPAN_MS);
  return {
    ...limit,
    continueAt: limit.resetsAt! + jitter,
    manual: null,
    autoContinues: 0,
    bootId: context.bootId,
  };
}

/** The person's choice for this computer: continue after a usage limit resets, on by default. */
export const usageLimitAutoContinue = (dataDir: string): boolean =>
  readPreferences(dataDir).usage_limit_auto_continue !== false;

const CLAUDE_LIMIT_MODELS: Record<string, string> = {
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
  seven_day_overage_included: "Fable",
};

/**
 * A Claude Code limit from its `rate_limit_info` (2.1.299+: on the rejected assistant message as
 * `api_error_params.rate_limit_info`, and on every `rate_limit_event`). `resetsAt` is in seconds.
 */
export function claudeUsageLimitHit(info: unknown, message: string): UsageLimitHit {
  const value =
    info && typeof info === "object" && !Array.isArray(info)
      ? (info as Record<string, unknown>)
      : {};
  const type = typeof value.rateLimitType === "string" ? value.rateLimitType : null;
  const seconds = type === "overage" ? (value.overageResetsAt ?? value.resetsAt) : value.resetsAt;
  return {
    resetsAt:
      typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
        ? Math.round(seconds * 1000)
        : null,
    kind:
      type === "five_hour"
        ? "five-hour"
        : type === "seven_day"
          ? "weekly"
          : type === "overage"
            ? "credits"
            : type?.startsWith("seven_day_")
              ? "model"
              : null,
    scope: (type && CLAUDE_LIMIT_MODELS[type]) ?? null,
    message,
  };
}

/**
 * A Codex limit from `account/rateLimits/read` (0.167.0): Codex's `usageLimitExceeded` error
 * carries no reset time, so it comes from the account's windows, as the Codex app reads it. The
 * exhausted window that resets last decides; `resetsAt` is in seconds. Null windows, or none
 * used up, leave the time unknown.
 */
export function codexUsageLimitHit(read: unknown, message: string): UsageLimitHit {
  const object = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const response = object(read);
  const snapshots = [
    object(response?.rateLimits),
    ...Object.values(object(response?.rateLimitsByLimitId) ?? {}).map(object),
  ].filter((snapshot): snapshot is Record<string, unknown> => snapshot !== null);
  let found: { resetsAt: number; minutes: number | null; scope: string | null } | null = null;
  for (const snapshot of snapshots)
    for (const window of [object(snapshot.primary), object(snapshot.secondary)]) {
      const used = window?.usedPercent;
      const seconds = window?.resetsAt;
      if (typeof used !== "number" || used < 100) continue;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) continue;
      if (found && found.resetsAt >= seconds * 1000) continue;
      const minutes = window?.windowDurationMins;
      found = {
        resetsAt: Math.round(seconds * 1000),
        minutes: typeof minutes === "number" ? minutes : null,
        scope: snapshot === object(response?.rateLimits) ? null : stringOrNull(snapshot.limitName),
      };
    }
  const reached = stringOrNull(object(response?.rateLimits)?.rateLimitReachedType);
  return {
    resetsAt: found?.resetsAt ?? null,
    kind: found?.scope
      ? "model"
      : found?.minutes != null && found.minutes <= 5 * 60
        ? "five-hour"
        : found?.minutes != null && found.minutes >= 7 * 24 * 60
          ? "weekly"
          : reached?.includes("credits")
            ? "credits"
            : null,
    scope: found?.scope ?? null,
    message,
  };
}

const stringOrNull = (value: unknown) => (typeof value === "string" && value ? value : null);
