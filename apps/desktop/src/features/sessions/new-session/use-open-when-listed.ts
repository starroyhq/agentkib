import { useOpenWhenListed as useOpenCreatedSession } from "@agentkib/session-ui";
import type { ConversationSessionSummary } from "@/core/types";
import { refreshConversationCatalog } from "../conversation-catalog";

export function useOpenWhenListed(
  sessions: ConversationSessionSummary[],
  open: (session: ConversationSessionSummary) => void,
) {
  return useOpenCreatedSession(sessions, open, refreshConversationCatalog);
}
