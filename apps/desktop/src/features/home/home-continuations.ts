import type { ConversationSessionSummary, RuntimeInfo, WorkspaceSummary } from "@/core/types";
import { isSessionVisible } from "@/features/sessions/session-catalog";

export interface RecentContinuation {
  workspace: WorkspaceSummary;
  session: ConversationSessionSummary;
}

export function continuationIndexingEnabled(runtime?: Pick<RuntimeInfo, "session_index_enabled">) {
  return runtime?.session_index_enabled === true;
}

/** The most recently active workspaces, whose session index the home reads again on entry. */
export function recentContinuationWorkspaces(workspaces: WorkspaceSummary[], limit = 5) {
  return [...workspaces]
    .sort((left, right) => (right.last_active_at ?? "").localeCompare(left.last_active_at ?? ""))
    .slice(0, limit);
}

export function selectRecentContinuations(
  workspaces: WorkspaceSummary[],
  sessionsByWorkspace: Array<ConversationSessionSummary[] | undefined>,
  limit = 3,
): RecentContinuation[] {
  return workspaces
    .flatMap((workspace, index) => {
      return (sessionsByWorkspace[index] ?? [])
        .filter((session) => session.availability === "readable" && isSessionVisible(session))
        .map((session) => ({ workspace, session }));
    })
    .sort(
      (left, right) =>
        sessionTimestamp(right.session, right.workspace) -
        sessionTimestamp(left.session, left.workspace),
    )
    .slice(0, limit);
}

function sessionTimestamp(session: ConversationSessionSummary, workspace: WorkspaceSummary) {
  const value = session.updated_at ?? session.created_at ?? workspace.last_active_at;
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
