import type { Live, LivePermission } from "@agentkib/web-client";
import { planModeCopy } from "../../composer-add-menu";
import type { InteractionLocale } from "../../interaction-model";
import { sessionPermissionDescriptor } from "../session-permissions";
import { permissionModeSummaryCopy } from "./permission-mode-copy";

/** Observed native modes are labels, not additional writable permission choices. */
export function observedClaudePermissionLabel(mode: string | undefined, locale: InteractionLocale) {
  const labels = {
    auto: {
      "zh-CN": "自动批准",
      "zh-Hant": "自動核准",
      "en-US": "Auto approval",
      "ja-JP": "自動承認",
    },
    dontAsk: {
      "zh-CN": "不询问",
      "zh-Hant": "不詢問",
      "en-US": "Don't ask",
      "ja-JP": "確認しない",
    },
    bypassPermissions: {
      "zh-CN": "跳过权限检查",
      "zh-Hant": "略過權限檢查",
      "en-US": "Bypass permissions",
      "ja-JP": "権限確認をスキップ",
    },
  };
  return mode && Object.hasOwn(labels, mode)
    ? labels[mode as keyof typeof labels][locale]
    : undefined;
}

function isTerminalPermission(live: Live | null | undefined, sessionId: string): boolean {
  if (live?.sessionId !== sessionId) return false;
  return live.execution?.owner === "terminal" || live.executionMode === "claude-follower";
}

/** A terminal observation describes the running CLI and never grants a permission write. */
export function claudeTerminalPermission(
  live: Live | null | undefined,
  sessionId: string,
  settingsMode: string | undefined,
  locale: InteractionLocale,
): { mode?: string; name?: string; risky?: boolean } | undefined {
  if (!live || !isTerminalPermission(live, sessionId)) return;
  const mode = live.permission?.mode ?? settingsMode;
  if (mode === "default" || mode === "acceptEdits") {
    const label = sessionPermissionDescriptor("claude-code")?.settings.label(mode, locale);
    return label ? { mode, name: label.name } : undefined;
  }
  if (mode === "plan") return { mode, name: planModeCopy(locale).title };
  if (mode === "auto" || mode === "dontAsk" || mode === "bypassPermissions")
    return {
      mode,
      name: observedClaudePermissionLabel(mode, locale),
      risky: true,
    };
}

export const claudePermissionObservation = {
  isTerminal: isTerminalPermission,
  terminal: claudeTerminalPermission,
  label: observedClaudePermissionLabel,
  notice(permission: LivePermission | null | undefined, locale: InteractionLocale) {
    if (!permission) return;
    const { mode } = permission;
    const key =
      mode === "auto" || mode === "dontAsk" || mode === "bypassPermissions"
        ? mode
        : mode === null && permission.possiblyAuto
          ? "possiblyAuto"
          : undefined;
    if (!key) return;
    const short = permissionModeSummaryCopy[locale];
    return {
      label: short[key],
      danger: mode === "bypassPermissions",
    };
  },
};
