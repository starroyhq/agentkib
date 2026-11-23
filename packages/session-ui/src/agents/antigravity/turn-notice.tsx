import { AlertTriangle } from "lucide-react";
import type { InteractionLocale } from "../../interaction-model";
import { useSessionPlatform } from "../../session-platform";
import type { SessionSurface } from "../../session-surface-copy";

/** Why an Antigravity turn did not run or finish, as the CLI's `agy acp` said. */
export const ANTIGRAVITY_TURN_REASONS: readonly string[] = [
  "antigravity-cli-unavailable",
  "antigravity-login-required",
  "antigravity-usage-limited",
  "antigravity-run-failed",
];

/** Explains it under the composer; installing and signing in happen in the CLI itself. */
export function AntigravityTurnNotice({
  reason,
  reasonCopy,
  locale,
}: {
  reason?: string | null;
  reasonCopy: (
    locale: InteractionLocale,
    reason: string,
    surface: SessionSurface,
  ) => { text: string };
  locale: InteractionLocale;
}) {
  const platform = useSessionPlatform();
  if (!reason || !ANTIGRAVITY_TURN_REASONS.includes(reason)) return null;
  return (
    <div
      role="status"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{reasonCopy(locale, reason, platform.kind).text}</span>
    </div>
  );
}

export const antigravityTurnNotice = {
  reasons: ANTIGRAVITY_TURN_REASONS,
  supports: (agent: string) => agent === "antigravity",
  Component: AntigravityTurnNotice,
};
