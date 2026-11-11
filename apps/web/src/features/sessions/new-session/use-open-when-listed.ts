import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSession } from "@/features/conversation/features/sessions/session-context";

/**
 * Opens a session just created once the session directory lists it; the session page shows a
 * session it cannot find as unavailable. The returned promise settles when the session opens,
 * keeping the composer busy meanwhile.
 */
export function useOpenWhenListed() {
  const { sessions, refresh, choose } = useSession();
  const navigate = useNavigate();
  const waiting = useRef<{ id: string; done: () => void }>(undefined);
  const latest = useRef({ sessions, choose, navigate });
  useEffect(() => {
    latest.current = { sessions, choose, navigate };
  });
  const settle = useCallback(() => {
    const entry = waiting.current;
    const { sessions, choose, navigate } = latest.current;
    if (!entry || !sessions.some((item) => item.id === entry.id)) return;
    waiting.current = undefined;
    void choose(entry.id);
    void navigate({ to: "/sessions/$sessionId", params: { sessionId: entry.id } });
    entry.done();
  }, []);
  useEffect(settle, [sessions, settle]);
  return useCallback(
    (sessionId: string) =>
      new Promise<void>((done) => {
        waiting.current = { id: sessionId, done };
        settle();
        // The directory follows the host's events too; this read only makes it sooner.
        void Promise.resolve(refresh(true)).catch(() => undefined);
      }),
    [settle, refresh],
  );
}
