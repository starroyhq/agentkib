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
 * Codex sessions get the same continue, and Devin sessions once Devin's `/usage` named the reset
 * (`devin-usage.ts`). DeepSeek Harness reports no reset time, so its sessions only say what
 * happened.
 */

import { plainTerminalText } from "./conversation-tools";
import { readPreferences } from "./preferences";

export type UsageLimitAgent = "claude-code" | "codex" | "deepseek-harness" | "devin";

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
 * Codex and Devin, whose clients have none; Devin's names its quota, as Devin's errors do. The
 * person reads it as a notice, not as their message.
 */
export const AUTO_CONTINUE_TEXT = {
  "claude-code":
    "Your claude.ai usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.",
  codex:
    "Your usage limit has reset. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.",
  devin:
    "Your Devin usage quota has reset. Continue the task you were working on when the quota ran out; do not repeat work that is already complete.",
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
  // DeepSeek Harness never says when a limit resets.
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

const KINDS: readonly unknown[] = ["five-hour", "weekly", "model", "credits", "quota"];
const MANUAL: readonly unknown[] = [
  "off",
  "reset-unknown",
  "reset-too-far",
  "repeated",
  "cancelled",
  "stale",
  "restarted",
];
const time = (value: unknown) =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
const text = (value: unknown, limit: number) => typeof value === "string" && value.length <= limit;

/** A hold read back from where AgentKib kept it (`saveManagedUsageLimit`); null when it is not one. */
export function parseUsageLimit(value: unknown, agent: UsageLimitAgent): UsageLimit | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const limit = value as Record<string, unknown>;
  return limit.agent === agent &&
    time(limit.resetsAt) &&
    (limit.kind === null || KINDS.includes(limit.kind)) &&
    (limit.scope === null || text(limit.scope, 200)) &&
    text(limit.message, 500) &&
    time(limit.continueAt) &&
    (limit.manual === null || MANUAL.includes(limit.manual)) &&
    typeof limit.autoContinues === "number" &&
    Number.isSafeInteger(limit.autoContinues) &&
    limit.autoContinues >= 0 &&
    text(limit.deviceId, 256) &&
    text(limit.bootId, 256)
    ? {
        agent,
        resetsAt: limit.resetsAt as number | null,
        kind: limit.kind as UsageLimitKind | null,
        scope: limit.scope as string | null,
        message: limit.message as string,
        continueAt: limit.continueAt as number | null,
        manual: limit.manual as UsageLimitManual | null,
        autoContinues: limit.autoContinues,
        deviceId: limit.deviceId as string,
        bootId: limit.bootId as string,
      }
    : null;
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

/**
 * Devin's words for a limit (3000.12.59): its service ends the turn with JSON-RPC error -32011
 * ("Your daily usage quota has been exhausted. Visit … to purchase on-demand usage or turn on
 * auto-reload.", also weekly), and the CLI's own errors say "Quota exhausted", "Usage limit
 * reached", "Organization usage limit reached", "You've reached your monthly usage limit", "You've
 * reached your ChatGPT subscription usage limit" or "Rate limited".
 */
const DEVIN_LIMIT =
  /\b(?:usage quota has been exhausted|quota exhausted|wait for your quota to reset|usage limit reached|reached (?:your|its) (?:monthly |ChatGPT subscription )?usage limit|rate limited:)/i;
// The error's message when the line prints the whole error: JSON, or Rust's `message: "…"`.
const QUOTED_MESSAGE = /"?message"?\s*:\s*"((?:[^"\\]|\\.)*)"/;

/**
 * A Devin limit from what `devin -p` printed; null when the text names none. `devin -p` gives no
 * reset time: only the interactive CLI's `/usage` shows it, which `devin-usage.ts` reads. `message`
 * keeps Devin's words, without the "Error:" prefix and the trace ID.
 */
export function devinUsageLimitHit(text: string): UsageLimitHit | null {
  // Colors and other terminal controls are not Devin's words.
  for (const raw of plainTerminalText(text).split("\n")) {
    if (!DEVIN_LIMIT.test(raw)) continue;
    let line = raw.trim();
    const quoted = QUOTED_MESSAGE.exec(line)?.[1];
    if (quoted !== undefined)
      try {
        const message = JSON.parse(`"${quoted}"`) as string;
        if (DEVIN_LIMIT.test(message)) line = message;
      } catch {
        // Keep the whole line.
      }
    const message = line
      .replace(/^error:\s*/i, "")
      .replace(/\s*\(trace ID:[^)]*\)\s*$/i, "")
      .trim()
      .slice(0, 500);
    return {
      resetsAt: null,
      kind: /\bweekly\b/i.test(message) ? "weekly" : null,
      scope: null,
      message,
    };
  }
  return null;
}
