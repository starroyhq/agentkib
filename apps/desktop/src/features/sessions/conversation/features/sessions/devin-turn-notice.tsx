import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { DEVIN_TURN_REASONS, devinTerminalAction, devinTerminalCopy } from "@agentkib/session-ui";
import type { WebClient } from "@agentkib/web-client";
import { Button } from "@/components/ui/button";
import type { SupportedLocale as Locale } from "@/core/types";
import { codexReason } from "./codex-copy";

/**
 * Why Devin did not run a turn, in Devin CLI's own terms. A missing login or an untrusted
 * workspace is resolved in Devin CLI itself, so this computer offers to open it in a terminal;
 * AgentKib only starts the command and never sees what is typed.
 */
export function DevinTurnNotice({
  reason,
  locale,
  client,
  sessionId,
  workspaceId,
}: {
  reason?: string | null;
  locale: Locale;
  /** Without one (another device), only the explanation is shown. */
  client?: Pick<WebClient, "devinTerminal">;
  sessionId?: string;
  workspaceId?: string;
}) {
  const [opened, setOpened] = useState<{ reason: string; text: string }>();
  if (!reason || !DEVIN_TURN_REASONS.includes(reason)) return null;
  const action = devinTerminalAction(reason);
  const copy = devinTerminalCopy(locale);
  const open = async () => {
    if (!action || !client) return;
    try {
      const result = await client.devinTerminal({
        action,
        ...(sessionId ? { sessionId } : workspaceId ? { workspaceId } : {}),
      });
      setOpened({ reason, text: copy.opened.replace("{terminal}", result.terminal) });
    } catch {
      setOpened({ reason, text: copy.failed });
    }
  };
  return (
    <div
      role="status"
      className="flex min-w-0 items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-900 dark:text-amber-200"
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0 space-y-1.5">
        <span className="block">{codexReason(locale, reason).text}</span>
        {action && client && (
          <span className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void open()}>
              {copy[action]}
            </Button>
            {opened?.reason === reason && <span>{opened.text}</span>}
          </span>
        )}
      </span>
    </div>
  );
}
