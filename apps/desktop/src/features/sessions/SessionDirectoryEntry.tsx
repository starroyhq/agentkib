import {
  readStateCopy,
  sessionContinuationListState,
  SessionContinuationDot,
} from "@agentkib/session-ui";
import { Bot, GitBranch } from "lucide-react";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { AgentIcon } from "@/features/agents/AgentIcon";
import { displaySessionTitle } from "@/features/workspace/session-title";
import { isInteractiveFork, sessionSourceLabel, worktreeLabel } from "./session-labels";
import { WorktreeMark } from "./WorktreeMark";

/** Shared row contents for the global directory and the workspace's session list. */
export function SessionDirectoryEntry({
  session,
  sessions,
  selected = false,
  hideIndicators = false,
}: {
  session: ConversationSessionSummary;
  sessions: ConversationSessionSummary[];
  selected?: boolean;
  hideIndicators?: boolean;
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
      <span className={hideIndicators ? "sr-only" : "contents"}>
        {hideIndicators && session.readState?.status === "unread" && !status?.unread && (
          <span>
            {session.readState.latestResult
              ? readStateCopy(locale).unread
              : readStateCopy(locale).manualUnread}
          </span>
        )}
        {status?.dot && (
          <SessionContinuationDot
            label={status.label}
            active={status.active}
            waiting={status.waiting}
            unread={status.unread}
          />
        )}
        {status && !status.dot && session.continuation?.reason === "codex-cli-version-too-old" && (
          <span className="shrink-0 text-xs text-muted-foreground">{status.label}</span>
        )}
        {session.origin === "execution" && (
          <span
            role="img"
            aria-label={tr("sessions.executionSession")}
            title={tr("sessions.executionSession")}
            className="inline-flex shrink-0 text-muted-foreground"
          >
            <Bot size={12} aria-hidden="true" />
          </span>
        )}
        {session.worktree && (
          <WorktreeMark
            label={worktreeLabel(session.worktree, tr)}
            deleted={session.worktree.status === "deleted"}
          />
        )}
        {isInteractiveFork(session) && (
          <GitBranch
            size={12}
            aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, sessions, tr, formatDateTime)}`}
          />
        )}
      </span>
    </>
  );
}
