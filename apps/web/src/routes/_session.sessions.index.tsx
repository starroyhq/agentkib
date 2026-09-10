import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { SessionEmpty } from "@/features/sessions/session-empty";
import { useSession } from "@/features/sessions/session-context";
export const Route = createFileRoute("/_session/sessions/")({ component: Index });
function Index() {
  const { leaveSession } = useSession();
  useEffect(() => {
    leaveSession();
  }, [leaveSession]);
  return <SessionEmpty />;
}
