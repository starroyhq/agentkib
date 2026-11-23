import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { keepNewSessionDraftUnsent } from "./new-session-draft";

const SESSION_LIST_WAIT_MS = 10_000;
export type NewSessionOpenResult = "opened" | "timed-out" | "cancelled";

/** The session page needs a catalog entry before it can open a newly created session. */
export function useOpenWhenListed<Session extends { id: string }>(
  sessions: readonly Session[],
  open: (session: Session) => void,
  refresh: () => Promise<unknown>,
) {
  const mounted = useRef(false);
  const waiting = useRef<{ id: string; finish: (result: NewSessionOpenResult) => void }>(undefined);
  const latest = useRef({ sessions, open, refresh });
  const openIfListed = useCallback(() => {
    const entry = waiting.current;
    const session = entry && latest.current.sessions.find((item) => item.id === entry.id);
    if (!entry || !session) return;
    entry.finish("opened");
    latest.current.open(session);
  }, []);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      waiting.current?.finish("cancelled");
    };
  }, []);
  useEffect(() => {
    latest.current = { sessions, open, refresh };
    openIfListed();
  }, [sessions, open, refresh, openIfListed]);

  return useCallback(
    (sessionId: string) =>
      new Promise<NewSessionOpenResult>((resolve) => {
        if (!mounted.current) {
          keepNewSessionDraftUnsent(sessionId);
          resolve("cancelled");
          return;
        }
        waiting.current?.finish("cancelled");
        const finish = (result: NewSessionOpenResult) => {
          clearTimeout(timer);
          waiting.current = undefined;
          // A detail page mounted as the creator leaves may take this draft in the same commit.
          if (result === "cancelled") keepNewSessionDraftUnsent(sessionId);
          resolve(result);
        };
        const timer = setTimeout(() => finish("timed-out"), SESSION_LIST_WAIT_MS);
        waiting.current = { id: sessionId, finish };
        openIfListed();
        // Catalog events can also settle the wait, even when this refresh fails.
        if (waiting.current) void latest.current.refresh().catch(() => undefined);
      }),
    [openIfListed],
  );
}
