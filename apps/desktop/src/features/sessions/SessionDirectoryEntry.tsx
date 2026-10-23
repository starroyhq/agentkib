import { sessionContinuationListState, SessionContinuationDot } from "@agentkib/session-ui";
import { GitBranch } from "lucide-react";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { isInteractiveFork, sessionSourceLabel } from "./session-labels";

/** Shared row contents for the global directory and the workspace's session list. */
export function SessionDirectoryEntry({
  session,
  sessions,
  selected = false,
}: {
  session: ConversationSessionSummary;
  sessions: ConversationSessionSummary[];
  selected?: boolean;
}) {
  const { locale, tr, formatDateTime } = useI18n();
  const status = sessionContinuationListState(session, locale);
  return (
    <>
      <AgentIcon agent={session.agent} compact />
      <span className="grid min-w-0 flex-1">
        <strong className={`truncate ${selected ? "font-[650]" : "font-[550]"}`}>
          {displaySessionTitle(session.title, tr)}
        </strong>
      </span>
      {status?.dot && <SessionContinuationDot label={status.label} active={status.active} />}
      {status && !status.dot && session.continuation?.reason === "codex-cli-version-too-old" && (
        <span className="shrink-0 text-xs text-muted-foreground">{status.label}</span>
      )}
      {isInteractiveFork(session) && (
        <GitBranch
          size={12}
          aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, sessions, tr, formatDateTime)}`}
        />
      )}
    </>
  );
}
