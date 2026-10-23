import type { AgentKind, ConversationIndexStatus, ConversationSessionSummary } from "@/core/types";

export function sessionSourceNeedsAttention(
  status: ConversationIndexStatus,
  installedAgents?: AgentKind[],
) {
  return !!status.error_key && (!installedAgents || installedAgents.includes(status.agent));
}

export function sessionSourceWasUsed(
  status: ConversationIndexStatus,
  sessions: ConversationSessionSummary[],
) {
  // A failed scan retains the previous successful count in the persistent index.
  return (
    status.session_count > 0 ||
    sessions.some(
      (session) => session.workspace_id === status.workspace_id && session.agent === status.agent,
    )
  );
}
