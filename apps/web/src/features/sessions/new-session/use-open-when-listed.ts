import { useNavigate } from "@tanstack/react-router";
import { useOpenWhenListed as useOpenCreatedSession } from "@agentkib/session-ui";
import { useSession } from "@/features/conversation/web-session-context";

export function useOpenWhenListed() {
  const { sessions, refresh, choose } = useSession();
  const navigate = useNavigate();
  return useOpenCreatedSession(
    sessions,
    (session) => {
      void choose(session.id);
      void navigate({ to: "/sessions/$sessionId", params: { sessionId: session.id } });
    },
    async () => refresh(true),
  );
}
