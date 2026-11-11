import { useCallback, useEffect, useRef } from "react";
import type { ConversationSessionSummary } from "@/core/types";
import { refreshConversationCatalog } from "../conversation-catalog";

/**
 * Opens a session just created once the session directory lists it. The sessions page drops a
 * selection its directory cannot find, so a new session is never opened before then. The returned
 * promise settles when the session opens, keeping the composer busy meanwhile.
 */
export function useOpenWhenListed(
  sessions: ConversationSessionSummary[],
  open: (session: ConversationSessionSummary) => void,
) {
  const waiting = useRef<{ id: string; done: () => void }>(undefined);
  const latest = useRef({ sessions, open });
  useEffect(() => {
    latest.current = { sessions, open };
  });
  const settle = useCallback(() => {
    const entry = waiting.current;
    const session = entry && latest.current.sessions.find((item) => item.id === entry.id);
    if (!entry || !session) return;
    waiting.current = undefined;
    latest.current.open(session);
    entry.done();
  }, []);
  useEffect(settle, [sessions, settle]);
  return useCallback(
    (sessionId: string) =>
      new Promise<void>((done) => {
        waiting.current = { id: sessionId, done };
        settle();
        // The directory follows its subscription too; this read only makes it sooner.
        void refreshConversationCatalog().catch(() => undefined);
      }),
    [settle],
  );
}
