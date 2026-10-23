import type { AgentKind, ConversationIndexStatus } from "@/core/types";

export function sessionSourceNeedsAttention(
  status: ConversationIndexStatus,
  installedAgents?: AgentKind[],
) {
  return !!status.error_key && (!installedAgents || installedAgents.includes(status.agent));
}
