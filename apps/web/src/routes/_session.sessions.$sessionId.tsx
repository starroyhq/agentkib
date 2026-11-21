import { useEffect, useRef } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { SessionReader } from "@/features/conversation/features/sessions/web-session-reader";
import { buttonVariants } from "@/features/conversation/components/ui/button";
import { cn } from "@/features/conversation/lib/utils";
import { useSession } from "@/features/conversation/features/sessions/session-context";
export const Route = createFileRoute("/_session/sessions/$sessionId")({ component: Session });
function Session() {
  const { sessionId } = Route.useParams();
  const { choose, sessions, selected, workspaces, t, indexEnabled, excludedSessionIds } =
    useSession();
  const navigate = useNavigate();
  const excluded = excludedSessionIds.has(sessionId);
  const readable = sessions.some(
    (session) => session.id === sessionId && session.availability === "readable",
  );
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (excluded) {
      void choose(sessionId);
      void navigate({ to: "/sessions", replace: true });
      return;
    }
    if (readable && opened.current !== sessionId) {
      opened.current = sessionId;
      void choose(sessionId);
    }
  }, [sessionId, readable, choose, excluded, navigate]);
  if (excluded) return null;
  if (!workspaces && indexEnabled)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        {t.loading}
      </p>
    );
  if (!indexEnabled || !readable)
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="text-sm text-muted-foreground">{t.unavailable}</p>
        <Link className={cn(buttonVariants({ variant: "outline" }))} to="/sessions">
          {t.back}
        </Link>
      </div>
    );
  return selected === sessionId ? (
    <SessionReader />
  ) : (
    <p role="status" className="p-8 text-sm text-muted-foreground">
      {t.loading}
    </p>
  );
}
