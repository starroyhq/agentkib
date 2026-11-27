import type { ComposerModelLocale as Locale } from "./composer-model-copy";
import { surfaceCopy, type SessionSurface } from "./session-surface-copy";

export const contextUsageCopy = {
  "zh-CN": {
    title: "上下文用量",
    windowTitle: "上下文窗口",
    capacity: "模型上下文上限 {total} Token",
    usedRemaining: "已使用 {used}%（剩余 {remaining}%）",
    tokenUsage: "已使用 {used} / {total} Token",
    tokenUsageOnly: "已使用 {used} Token",
    compacting: "正在压缩上下文",
  },
  "zh-Hant": {
    title: "上下文用量",
    windowTitle: "上下文視窗",
    capacity: "模型上下文上限 {total} Token",
    usedRemaining: "已使用 {used}%（剩餘 {remaining}%）",
    tokenUsage: "已使用 {used} / {total} Token",
    tokenUsageOnly: "已使用 {used} Token",
    compacting: "正在壓縮上下文",
  },
  "en-US": {
    title: "Context usage",
    windowTitle: "Context window",
    capacity: "Model context limit of {total} tokens",
    usedRemaining: "{used}% used ({remaining}% remaining)",
    tokenUsage: "{used} / {total} tokens used",
    tokenUsageOnly: "{used} tokens used",
    compacting: "Compacting context",
  },
  "ja-JP": {
    title: "コンテキスト使用量",
    windowTitle: "コンテキストウィンドウ",
    capacity: "モデルのコンテキスト上限 {total} トークン",
    usedRemaining: "{used}% 使用（残り {remaining}%）",
    tokenUsage: "{used} / {total} トークン使用",
    tokenUsageOnly: "{used} トークン使用",
    compacting: "コンテキストを圧縮中",
  },
} satisfies Record<Locale, Record<string, string>>;

export function contextUsageCopyForSurface(locale: Locale, surface: SessionSurface = "desktop") {
  return surfaceCopy(contextUsageCopy[locale], surface, locale);
}
