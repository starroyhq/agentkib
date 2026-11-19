import type { Live } from "@agentkib/web-client";
import { planModeCopy } from "./composer-add-menu";
import type { InteractionLocale } from "./interaction-model";
import { newSessionCopy } from "./new-session";
import { permissionModeCopy } from "./permission-mode-copy";
import { observedClaudePermissionLabel } from "./session-composer-capabilities";

export function claudeTerminalInteraction(live: Live | null | undefined, sessionId: string) {
  if (live?.sessionId !== sessionId || live.executionMode !== "claude-follower") return;
  if (live.reason === "claude-terminal-approval" && live.status === "awaiting-approval")
    return "approval";
  if (live.reason === "claude-terminal-question" && live.status === "waiting-input")
    return "question";
}

/** A terminal observation describes the running CLI and never grants a permission write. */
export function claudeTerminalPermission(
  live: Live | null | undefined,
  sessionId: string,
  settingsMode: string | undefined,
  locale: InteractionLocale,
): { name?: string; description?: string; risky?: boolean } | undefined {
  if (live?.sessionId !== sessionId || live.executionMode !== "claude-follower") return;
  const mode = live.permission?.mode ?? settingsMode;
  if (mode === "default" || mode === "acceptEdits")
    return newSessionCopy(locale).permissions["claude-code"].choices[mode];
  if (mode === "plan") return { name: planModeCopy(locale).title };
  if (mode === "auto" || mode === "dontAsk" || mode === "bypassPermissions")
    return {
      name: observedClaudePermissionLabel(mode, locale),
      description: permissionModeCopy[locale][mode],
      risky: true,
    };
}
