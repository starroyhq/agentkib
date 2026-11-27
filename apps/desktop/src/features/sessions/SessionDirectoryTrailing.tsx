import type { ReactNode } from "react";
import { Bot, CircleAlert, GitBranch } from "lucide-react";
import {
  readStateCopy,
  sessionContinuationListState,
  SessionContinuationDot,
} from "@agentkib/session-ui";
import type { ConversationSessionSummary } from "@/core/types";
import { useI18n } from "@/core/useI18n";
import { isInteractiveFork, sessionSourceLabel, worktreeLabel } from "./session-labels";
import { SessionRowMenu } from "./SessionRowMenu";
import { WorktreeMark } from "./WorktreeMark";

export function SessionDirectoryTrailing({
  session,
  sessions,
  workerSessions,
  local,
  onChanged,
  onDeleted,
  onConnectTerminal,
  onOpenWorkspace,
  onOpenFork,
}: {
  session: ConversationSessionSummary;
  sessions: ConversationSessionSummary[];
  workerSessions: ConversationSessionSummary[];
  local: boolean;
  onChanged: () => void;
  onDeleted: () => void;
  onConnectTerminal: () => void;
  onOpenWorkspace?: () => Promise<void>;
  onOpenFork?: () => void;
}) {
  const { locale, tr, formatDateTime } = useI18n();
  const status = sessionContinuationListState(session, locale);
  let indicator: ReactNode = null;
  if (session.readState?.status === "unread") {
    const copy = readStateCopy(locale);
    indicator = (
      <SessionContinuationDot
        label={
          status?.unread
            ? status.label
            : session.readState.latestResult
              ? copy.unread
              : copy.manualUnread
        }
        active={status?.active}
        waiting={status?.waiting}
        error={status?.error}
        terminal={status?.terminal}
        unread
      />
    );
  } else if (status?.dot) {
    indicator = (
      <SessionContinuationDot
        label={status.label}
        active={status.active}
        waiting={status.waiting}
        error={status.error}
        terminal={status.terminal}
      />
    );
  } else if (session.worktree) {
    indicator = (
      <WorktreeMark
        label={worktreeLabel(session.worktree, tr)}
        deleted={session.worktree.status === "deleted"}
      />
    );
  } else if (isInteractiveFork(session)) {
    indicator = (
      <GitBranch
        size={12}
        aria-label={`${tr("conversations.forked")}: ${sessionSourceLabel(session, sessions, tr, formatDateTime)}`}
      />
    );
  } else if (session.origin === "execution") {
    indicator = <Bot size={12} aria-label={tr("sessions.executionSession")} />;
  } else if (status && session.continuation?.reason === "codex-cli-version-too-old") {
    indicator = (
      <span title={status.label}>
        <CircleAlert size={12} aria-hidden="true" />
      </span>
    );
  }
  return (
    <div
      className="session-directory-trailing relative grid size-8 shrink-0 place-items-center"
      data-has-menu="true"
      data-has-indicator={!!indicator || undefined}
    >
      {/* The selection button retains the full accessible status description. */}
      <span
        aria-hidden="true"
        className="session-directory-indicator pointer-events-none absolute inset-0 grid place-items-center text-muted-foreground transition-opacity duration-150 motion-reduce:transition-none"
      >
        {indicator}
      </span>
      <SessionRowMenu
        session={session}
        sessions={workerSessions}
        canPin={local && !session.remote}
        pinOnly={!local}
        sidebar={{
          local,
          isMacOS: document.documentElement.dataset.platform === "macos",
          onOpenWorkspace,
          onOpenFork,
        }}
        onChanged={onChanged}
        onDeleted={onDeleted}
        onConnectTerminal={onConnectTerminal}
      />
    </div>
  );
}
