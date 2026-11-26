import { SessionContinuationReadOnly } from "../../session-continuation";
import type { Access, ConversationSessionSummary, WebClient } from "@agentkib/web-client";
import type { InteractionLocale } from "../../interaction-model";
import { useCallback } from "react";
import { sessionContinuationRegistration } from "../../agents/session-continuation";

export function SessionReadOnly({
  session: { selected, current, client, access, locale },
  reason,
  local,
}: {
  session: {
    selected: string;
    current?: ConversationSessionSummary;
    client: WebClient;
    access?: Access;
    locale: InteractionLocale;
  };
  reason?: string | null;
  local?: boolean;
}) {
  const currentId = current?.id;
  const resume = sessionContinuationRegistration(current?.agent)?.loadResumeCommand;
  const accessStatus = access?.status;
  const deviceId = access?.device?.id;
  const loadCommand = useCallback(
    async (signal: AbortSignal) => {
      if (
        !selected ||
        currentId !== selected ||
        !resume ||
        accessStatus !== "approved" ||
        !deviceId
      )
        throw new Error("session-unavailable");
      const result = await resume(client, selected, signal);
      if (!result.available || !result.command.trim()) throw new Error("command-unavailable");
      return result.command;
    },
    [selected, currentId, resume, client, accessStatus, deviceId],
  );
  if (!resume) return null;
  if (!local && current?.agent === "claude-code")
    return reason ? (
      <p role="status" className="text-sm text-muted-foreground">
        {reason}
      </p>
    ) : null;

  return (
    <div className="w-full max-w-3xl self-center">
      <SessionContinuationReadOnly
        locale={locale}
        reason={reason}
        loadCommand={loadCommand}
        local={local}
      />
    </div>
  );
}
