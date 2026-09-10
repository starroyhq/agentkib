import { useEffect, useRef } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { SessionReader } from "@/features/sessions/session-reader";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSession } from "@/features/sessions/session-context";
export const Route = createFileRoute("/_session/sessions/$sessionId")({ component: Session });
function Session() {
  const { sessionId } = Route.useParams();
  const { choose, sessions, selected, workspaces, t, indexEnabled } = useSession();
  const readable = sessions.some(
    (session) => session.id === sessionId && session.availability === "readable",
  );
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (readable && opened.current !== sessionId) {
      opened.current = sessionId;
      void choose(sessionId);
    }
  }, [sessionId, readable, choose]);
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
