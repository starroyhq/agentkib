import i18n, { type TOptions } from "i18next";
import { initReactI18next } from "react-i18next";
import enUS from "../locales/en-US.json";
import jaJP from "../locales/ja-JP.json";
import zhCN from "../locales/zh-CN.json";
import zhTW from "../locales/zh-TW.json";
import type { LocalizedMessage, SupportedLocale } from "./types";

export type LocalePreference = "system" | SupportedLocale;

export const supportedLocales: SupportedLocale[] = ["zh-CN", "zh-TW", "ja-JP", "en-US"];
export const localeResources = {
  "en-US": enUS,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  "ja-JP": jaJP,
} as const;
const conversationKeys = [
  "lanAddress",
  "lanPlaintextShort",
  "lanRisk",
  "lanAcknowledge",
  "lanPermission",
  "lanFailure",
  "lanInvalid",
  "lanIncompatible",
  "changeBackend",
  "connect",
  "cwd",
  "localExecution",
  "policyProposal",
  "remote",
  "pairTitle",
  "pairInfo",
  "code",
  "name",
  "pair",
  "scope",
  "pending",
  "verify",
  "expires",
  "cancel",
  "ended",
  "endedInfo",
  "again",
  "sessions",
  "search",
  "empty",
  "select",
  "selectInfo",
  "untitled",
  "history",
  "live",
  "refresh",
  "logout",
  "back",
  "details",
  "close",
  "earlier",
  "loading",
  "offline",
  "retry",
  "unknown",
  "controlUnconfirmed",
  "idle",
  "running",
  "unavailable",
  "openOriginalClient",
  "unverifiedInstallation",
  "unsupportedControl",
  "process",
  "tools",
  "failed",
  "incomplete",
  "attachments",
  "truncated",
  "unknownTool",
  "indexDisabled",
  "error",
  "send",
  "stop",
  "message",
  "experimental",
  "controlInfo",
  "accepted",
  "uncertain",
  "notDispatched",
  "approval",
  "accept",
  "allow",
  "claudeContextInfo",
  "deny",
  "claudeDecisionInfo",
  "streamingReply",
  "streamingReplyTruncated",
  "decline",
  "cancelTurn",
  "approvalFallback",
  "decisionInfo",
  "language",
  "theme",
  "system",
  "light",
  "dark",
  "accent",
  "blue",
  "violet",
  "green",
  "preferences",
  "sendWhileRunning",
  "sendWhileRunningQueue",
  "sendWhileRunningSteer",
  "metadata",
  "metadataOnly",
  "agent",
  "workspace",
  "workspaceId",
  "sessionId",
  "status",
  "warnings",
  "tool",
  "toolSummaryUnavailable",
  "readOnly",
  "noSendPermission",
  "device",
  "safety",
] as const;

export type ConversationWords = {
  [K in (typeof conversationKeys)[number]]: string;
};

/**
 * Some conversation helpers still consume a typed object. The values come
 * from Desktop's global locale resources rather than a feature-local dictionary.
 */
export function conversationWords(locale: SupportedLocale): ConversationWords {
  if (!i18n.isInitialized) {
    const resources = localeResources[locale] as Record<string, unknown>;
    return Object.fromEntries(
      conversationKeys.map((key) => [key, String(resources[`conversation.${key}`] ?? key)]),
    ) as ConversationWords;
  }
  const translate = i18n.getFixedT(locale);
  return Object.fromEntries(
    conversationKeys.map((key) => [key, String(translate(`conversation.${key}`))]),
  ) as ConversationWords;
}

const EFFECTIVE_LOCALE_STORAGE_KEY = "agentkib.effective-locale";
const LOCALE_PREFERENCE_STORAGE_KEY = "agentkib.cached-locale-preference";

export function normalizeLocale(locale?: string | null): SupportedLocale {
  if (!locale) return "en-US";
  const normalized = locale.replaceAll("_", "-").toLowerCase();
  if (/^zh-(hant|tw|hk|mo)(-|$)/.test(normalized)) return "zh-TW";
  if (/^zh-(hans|cn|sg)(-|$)/.test(normalized) || normalized === "zh") return "zh-CN";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja-JP";
  if (normalized === "en" || normalized.startsWith("en-")) return "en-US";
  return "en-US";
}

export function cachedEffectiveLocale(fallback?: string | null): SupportedLocale {
  try {
    if (window.localStorage.getItem(LOCALE_PREFERENCE_STORAGE_KEY) === "system") {
      return normalizeLocale(fallback);
    }
    const value = window.localStorage.getItem(EFFECTIVE_LOCALE_STORAGE_KEY);
    if (supportedLocales.includes(value as SupportedLocale)) return value as SupportedLocale;
  } catch {
    // The system locale remains a safe fallback in restricted webviews.
  }
  return normalizeLocale(fallback);
}

export function cacheEffectiveLocale(locale: SupportedLocale, preference?: LocalePreference) {
  try {
    window.localStorage.setItem(EFFECTIVE_LOCALE_STORAGE_KEY, locale);
    if (preference) window.localStorage.setItem(LOCALE_PREFERENCE_STORAGE_KEY, preference);
  } catch {
    // Startup locale caching is best-effort.
  }
}

export async function initializeI18n(locale: SupportedLocale) {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      lng: locale,
      fallbackLng: "en-US",
      supportedLngs: supportedLocales,
      resources: Object.fromEntries(
        Object.entries(localeResources).map(([key, value]) => [key, { translation: value }]),
      ),
      interpolation: { escapeValue: false },
      returnNull: false,
    });
  } else {
    await i18n.changeLanguage(locale);
  }
  document.documentElement.lang = locale;
}

export async function changeLocale(locale: SupportedLocale) {
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}

export function currentLocale(): SupportedLocale {
  return normalizeLocale(i18n.resolvedLanguage ?? i18n.language);
}

export function tr(key: string, options?: Record<string, unknown>): string {
  const translate = i18n.t as unknown as (
    translationKey: string,
    translationOptions?: TOptions,
  ) => unknown;
  return String(translate(key, options as TOptions | undefined));
}

export function formatCompactNumber(value: number, locale = currentLocale()) {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatNumber(value: number, locale = currentLocale()) {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatDateTime(value: string | Date, locale = currentLocale()) {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatRelativeTime(value: string | Date, locale = currentLocale()) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function localizeMessage(
  message: LocalizedMessage | string | unknown,
  translate = tr,
): string {
  if (typeof message === "object" && message !== null && "key" in message) {
    const value = message as LocalizedMessage;
    const translated = translate(value.key, value.params);
    return value.detail
      ? translate("errors.withDetail", { message: translated, detail: value.detail })
      : translated;
  }
  return String(message);
}

export default i18n;
