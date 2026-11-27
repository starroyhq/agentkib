import { ShieldAlert } from "lucide-react";
import type { LivePermission } from "@agentkib/web-client";
import type { InteractionLocale as Locale } from "../../interaction-model";
import { terminalPermissionObservation } from "../../agents/session-permission-observations";

/**
 * Tells the user when a Claude session runs where actions are no longer approved one by one
 * (auto, dontAsk, bypassPermissions), or when the mode is unknown on a CLI that may start in
 * auto. It carries text and an icon, never color alone, and only informs: it never blocks sending.
 * `default`, `plan`, `acceptEdits` and an unknown mode without a hint render nothing.
 */
export function PermissionModeNotice({
  permission,
  locale,
}: {
  permission?: LivePermission | null;
  locale: Locale;
  compact?: boolean;
}) {
  const notice = terminalPermissionObservation.notice(permission, locale);
  if (!notice) return null;
  const color = notice.danger
    ? "border-destructive/40 bg-destructive/10 text-destructive-text"
    : "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300";
  return (
    <p
      role="status"
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs leading-5 ${color}`}
    >
      <ShieldAlert aria-hidden="true" className="size-4 shrink-0" />
      <span>{notice.label}</span>
    </p>
  );
}
