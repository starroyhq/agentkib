import type { InteractionLocale } from "./interaction-model";

/**
 * What a session says when its agent's account met a usage limit (`Live.usageLimit`). Wording
 * follows the agents' own clients where they have it: Codex's "你已达到使用上限" and
 * "请稍后再试", DeepSeek Harness's "当前请求的额度已用尽", Claude Code's limit names and its
 * "Don't continue automatically".
 */
export type UsageLimitNoticeInput = {
  resetsAt: number | null;
  kind: "five-hour" | "weekly" | "model" | "credits" | "quota" | null;
  scope: string | null;
  continueAt: number | null;
  manual:
    | "off"
    | "reset-unknown"
    | "reset-too-far"
    | "repeated"
    | "cancelled"
    | "stale"
    | "restarted"
    | null;
};

type Words = {
  limit: (kind: UsageLimitNoticeInput["kind"], scope: string | null) => string;
  resets: (time: string) => string;
  continues: string;
  later: string;
  afterReset: string;
  repeated: string;
  reset: string;
  cancel: string;
  arm: string;
};

const WORDS: Record<InteractionLocale, Words> = {
  "zh-CN": {
    limit: (kind, scope) =>
      kind === "five-hour"
        ? "已达到 5 小时使用上限"
        : kind === "weekly"
          ? "已达到每周使用上限"
          : kind === "model" && scope
            ? `已达到 ${scope} 使用上限`
            : kind === "credits"
              ? "使用额度已用完"
              : kind === "quota"
                ? "当前请求的额度已用尽"
                : "你已达到使用上限",
    resets: (time) => `，${time} 重置`,
    continues: "，重置后自动继续。",
    later: "。请稍后再试。",
    afterReset: "。重置后发送消息即可继续。",
    repeated: "。连续多次达到上限，已停止自动继续。",
    reset: "使用上限已重置，发送消息即可继续。",
    cancel: "不自动继续",
    arm: "重置后自动继续",
  },
  "zh-Hant": {
    limit: (kind, scope) =>
      kind === "five-hour"
        ? "已達到 5 小時使用上限"
        : kind === "weekly"
          ? "已達到每週使用上限"
          : kind === "model" && scope
            ? `已達到 ${scope} 使用上限`
            : kind === "credits"
              ? "使用額度已用完"
              : kind === "quota"
                ? "目前請求的額度已用盡"
                : "你已達到使用上限",
    resets: (time) => `，${time} 重置`,
    continues: "，重置後自動繼續。",
    later: "。請稍後再試。",
    afterReset: "。重置後傳送訊息即可繼續。",
    repeated: "。連續多次達到上限，已停止自動繼續。",
    reset: "使用上限已重置，傳送訊息即可繼續。",
    cancel: "不自動繼續",
    arm: "重置後自動繼續",
  },
  "ja-JP": {
    limit: (kind, scope) =>
      kind === "five-hour"
        ? "5 時間の利用制限に達しました"
        : kind === "weekly"
          ? "週間の利用制限に達しました"
          : kind === "model" && scope
            ? `${scope} の利用制限に達しました`
            : kind === "credits"
              ? "利用クレジットを使い切りました"
              : kind === "quota"
                ? "リクエストのクォータを使い切りました"
                : "利用制限に達しました",
    resets: (time) => `。${time}にリセットされます`,
    continues: "。リセット後に自動で続行します。",
    later: "。後でもう一度お試しください。",
    afterReset: "。リセット後にメッセージを送ると続行できます。",
    repeated: "。続けて制限に達したため、自動での続行を停止しました。",
    reset: "利用制限がリセットされました。メッセージを送ると続行できます。",
    cancel: "自動で続行しない",
    arm: "リセット後に自動で続行",
  },
  "en-US": {
    limit: (kind, scope) =>
      kind === "five-hour"
        ? "You've hit your 5-hour limit"
        : kind === "weekly"
          ? "You've hit your weekly limit"
          : kind === "model" && scope
            ? `You've hit your ${scope} limit`
            : kind === "credits"
              ? "You're out of usage credits"
              : kind === "quota"
                ? "Request quota exhausted"
                : "You've hit your usage limit",
    resets: (time) => ` · resets ${time}`,
    continues: " · continues automatically after the reset.",
    later: ". Try again later.",
    afterReset: ". Send a message after the reset to continue.",
    repeated: ". Stopped continuing automatically after repeated limit hits.",
    reset: "Your usage limit has reset. Send a message to continue.",
    cancel: "Don't continue automatically",
    arm: "Continue automatically after the reset",
  },
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** The reset time in the reader's time zone: the time alone today, with the date otherwise. */
export function usageLimitTime(locale: InteractionLocale, at: number, now = Date.now()): string {
  const date = new Date(at);
  const english = locale === "en-US";
  // 15:30 and 11月19日 in Chinese and Japanese; 3:30 PM and Nov 19 in English.
  const time: Intl.DateTimeFormatOptions = english
    ? { hour: "numeric", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
  return new Intl.DateTimeFormat(
    locale,
    sameDay(date, new Date(now))
      ? time
      : {
          ...time,
          month: english ? "short" : "long",
          day: "numeric",
          ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
        },
  ).format(date);
}

/**
 * The notice for a usage limit, and the label of the button that turns the automatic continue
 * off (null when nothing is armed). Null while AgentKib's continue is on its way.
 */
export function usageLimitNotice(
  locale: InteractionLocale,
  limit: UsageLimitNoticeInput,
  now = Date.now(),
): { text: string; cancel: string | null; arm: string | null } | null {
  const words = WORDS[locale] ?? WORDS["zh-CN"];
  if (limit.continueAt === null && limit.manual === null) return null;
  const passed = limit.resetsAt !== null && limit.resetsAt <= now;
  if (limit.manual === "stale" || (passed && limit.manual !== null && limit.manual !== "repeated"))
    return { text: words.reset, cancel: null, arm: null };
  const head =
    words.limit(limit.kind, limit.scope) +
    (limit.resetsAt !== null && !passed
      ? words.resets(usageLimitTime(locale, limit.resetsAt, now))
      : "");
  if (limit.continueAt !== null)
    return { text: head + words.continues, cancel: words.cancel, arm: null };
  // A balance does not reset by itself: the agent's own words are the whole notice.
  if (limit.kind === "quota")
    return { text: `${head}${locale === "en-US" ? "." : "。"}`, cancel: null, arm: null };
  return {
    text:
      head +
      (limit.manual === "repeated"
        ? words.repeated
        : limit.manual === "reset-unknown"
          ? words.later
          : words.afterReset),
    cancel: null,
    // The host offers the continue only for a known, future reset and a hold it can re-arm.
    arm:
      limit.resetsAt !== null &&
      !passed &&
      (limit.manual === "off" ||
        limit.manual === "cancelled" ||
        limit.manual === "reset-too-far" ||
        limit.manual === "repeated" ||
        limit.manual === "restarted")
        ? words.arm
        : null,
  };
}
