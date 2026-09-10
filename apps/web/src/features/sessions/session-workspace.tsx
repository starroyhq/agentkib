import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { RefreshCw, LogOut, Monitor } from "lucide-react";
import { SessionCatalog } from "@/features/catalog/session-catalog";
import { Button } from "@/components/ui/button";
import { useSession } from "./session-context";
import { cn } from "@/lib/utils";

export function SessionWorkspace() {
  const {
    t,
    access,
    refresh,
    post,
    pendingSessions,
    sessions,
    workspaces,
    selected,
    choose,
    locale,
    indexEnabled,
  } = useSession();
  const navigate = useNavigate();
  const reading = useLocation({
    select: (location) =>
      location.pathname.startsWith("/sessions/") && location.pathname !== "/sessions/",
  });
  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={cn(
          "flex min-h-0 w-full shrink-0 flex-col border-r bg-sidebar md:w-72 lg:w-80",
          reading && "hidden md:flex",
        )}
      >
        <header className="flex items-center justify-between px-5 pb-4 pt-6">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold">{t.sessions}</h1>
            <span className="rounded-md bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
              {sessions.length}
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t.refresh}
            onClick={() => void refresh(true)}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </header>
        <SessionCatalog
          pendingSessions={pendingSessions}
          sessions={sessions}
          workspaces={workspaces}
          selected={selected}
          onSelect={(id) => {
            void choose(id);
            void navigate({
              to: "/sessions/$sessionId",
              params: { sessionId: id },
              resetScroll: false,
            });
          }}
          locale={locale}
          indexEnabled={indexEnabled}
        />
        <footer className="flex items-center gap-3 border-t p-4">
          <span className="grid size-9 place-items-center rounded-lg border bg-background">
            <Monitor className="size-4 text-muted-foreground" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">{t.device}</div>
            <div className="truncate text-xs font-medium">{access?.device?.name}</div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.logout}
            onClick={() => void post("logout", {})}
          >
            <LogOut className="size-4" />
          </Button>
        </footer>
      </aside>
      <main
        className={cn("min-w-0 flex-1 flex-col bg-background", reading ? "flex" : "hidden md:flex")}
      >
        <Outlet />
      </main>
    </div>
  );
}
