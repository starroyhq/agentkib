import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SessionHome } from "@/features/sessions/home/session-home";
import { useSession } from "@/features/conversation/features/sessions/session-context";
export const Route = createFileRoute("/_session/sessions/")({ component: Index });
function Index() {
  const { leaveSession } = useSession();
  useEffect(() => {
    leaveSession();
  }, [leaveSession]);
  return <SessionHome />;
}
