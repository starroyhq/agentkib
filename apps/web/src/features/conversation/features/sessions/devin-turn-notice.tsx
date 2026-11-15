import { AlertTriangle } from "lucide-react";
import { DEVIN_TURN_REASONS } from "@agentkib/session-ui";
import type { Locale } from "../../i18n";
import { codexReason } from "./codex-copy";

/**
 * Why Devin did not run a turn, in Devin CLI's own terms. A missing login or an untrusted
 * workspace is resolved on the computer itself; this device only explains it.
 */
export function DevinTurnNotice({ reason, locale }: { reason?: string | null; locale: Locale }) {
  if (!reason || !DEVIN_TURN_REASONS.includes(reason)) return null;
  return (
    <div
      role="status"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{codexReason(locale, reason ?? undefined, "web").text}</span>
    </div>
  );
}
