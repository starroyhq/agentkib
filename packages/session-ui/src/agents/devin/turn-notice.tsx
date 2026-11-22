import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { InteractionLocale } from "../../interaction-model";
import { DEVIN_TURN_REASONS, devinTerminalAction, devinTerminalCopy } from "../../devin-terminal";
import { useSessionPlatform } from "../../session-platform";
import type { SessionSurface } from "../../session-surface-copy";

/** Explains refusals from Devin CLI. The desktop can open CLI login or workspace trust. */
export function DevinTurnNotice({
  reason,
  reasonCopy,
  locale,
  sessionId,
  workspaceId,
}: {
  reason?: string | null;
  reasonCopy: (
    locale: InteractionLocale,
    reason: string,
    surface: SessionSurface,
  ) => { text: string };
  locale: InteractionLocale;
  sessionId?: string;
  workspaceId?: string;
}) {
  const platform = useSessionPlatform();
  const [opened, setOpened] = useState<{ reason: string; text: string }>();
  if (!reason || !DEVIN_TURN_REASONS.includes(reason)) return null;
  const explanation = reasonCopy(locale, reason, platform.kind).text;
  const action = devinTerminalAction(reason);
  const copy = devinTerminalCopy(locale);
  const { Button } = platform.components;
  const openTerminal = platform.kind === "desktop" ? platform.openTerminal : undefined;
  const open = async () => {
    if (!action || !openTerminal) return;
    try {
      const result = await openTerminal({
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
      {platform.kind === "desktop" ? (
        <span className="min-w-0 space-y-1.5">
          <span className="block">{explanation}</span>
          {action && openTerminal && (
            <span className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void open()}>
                {copy[action]}
              </Button>
              {opened?.reason === reason && <span>{opened.text}</span>}
            </span>
          )}
        </span>
      ) : (
        <span className="min-w-0">{explanation}</span>
      )}
    </div>
  );
}

export const devinTurnNotice = {
  // Older hosts do not declare a notice kind. Keep this registration scoped to Devin
  // where a generic refusal code, such as attachments-unsupported, is also recognized.
  reasons: DEVIN_TURN_REASONS,
  supports: (agent: string) => agent === "devin",
  Component: DevinTurnNotice,
};
