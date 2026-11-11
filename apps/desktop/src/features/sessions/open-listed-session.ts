import type { ConversationSessionSummary } from "@/core/types";
import { refreshConversationCatalog } from "./conversation-catalog";

/**
 * The session as the session list has it, read again until it appears: one the menu bar has just
 * created reaches the list a moment after its create returns. The sessions page drops a selection
 * its list cannot find, so a session is opened only once it is listed, or after `timeoutMs`.
 */
export async function findListedSession(
  sessionId: string,
  { timeoutMs = 15_000, intervalMs = 500 } = {},
): Promise<ConversationSessionSummary | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const sessions = await refreshConversationCatalog().catch(
      (): ConversationSessionSummary[] => [],
    );
    const found = sessions.find((session) => session.id === sessionId);
    if (found || Date.now() >= deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
