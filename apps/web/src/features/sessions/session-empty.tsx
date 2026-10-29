import { MessagesSquare } from "lucide-react";
import { AgentMark } from "@agentkib/agent-identity";
import {
  displaySessionTitle,
  isSessionVisible,
  sessionGroupLabels,
  sortSessions,
} from "@agentkib/session-catalog";
import { sessionContinuationListState, SessionContinuationStatus } from "@agentkib/session-ui";
import { Link } from "@tanstack/react-router";
import { useSession } from "@/features/conversation/features/sessions/session-context";

const recentTitles = {
  "zh-CN": "最近会话",
  "zh-TW": "最近對話",
  "en-US": "Recent sessions",
  "ja-JP": "最近の会話",
};

export function SessionEmpty() {
  const { t, locale, sessions, workspaces, choose } = useSession();
  const recent = sortSessions(
    sessions.filter(
      (session) =>
        isSessionVisible(session) && !session.archived && session.availability === "readable",
    ),
  ).slice(0, 12);
  // A worktree session is named after its repository's directory group, not a wider workspace.
  const groupLabels = sessionGroupLabels(recent, workspaces ?? []);
  return (
    <div className="flex flex-1 flex-col items-center gap-4 overflow-y-auto px-4 py-8 text-center sm:px-8">
      <div className="mb-2 grid size-16 place-items-center rounded-2xl border bg-muted/40">
        <MessagesSquare className="size-7 text-muted-foreground" strokeWidth={1.4} />
      </div>
      <h2 className="text-xl font-medium tracking-tight">{t.select}</h2>
      <p className="max-w-sm text-sm leading-7 text-muted-foreground">{t.selectInfo}</p>
      {recent.length > 0 && (
        <section
          className="mt-4 w-full max-w-2xl rounded-xl border text-left"
          aria-label={recentTitles[locale]}
        >
          <h3 className="px-4 py-3 text-sm font-medium">{recentTitles[locale]}</h3>
          {recent.map((session) => {
            const status = sessionContinuationListState(session, locale);
            return (
              <Link
                key={session.id}
                to="/sessions/$sessionId"
                params={{ sessionId: session.id }}
                className="flex min-h-14 w-full flex-wrap items-center justify-start gap-3 border-t px-4 py-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                onClick={() => {
                  void choose(session.id);
                }}
              >
                <AgentMark agent={session.agent} />
                <span className="min-w-0 flex-1 whitespace-normal break-words">
                  <strong className="block text-sm font-medium">
                    {displaySessionTitle(session.title, t.untitled)}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {groupLabels.get(session.id) ??
                      workspaces?.find((workspace) => workspace.id === session.workspace_id)?.name}
                  </small>
                </span>
                {status && (
                  <SessionContinuationStatus label={status.label} active={status.active} />
                )}
              </Link>
            );
          })}
        </section>
      )}
    </div>
  );
}
