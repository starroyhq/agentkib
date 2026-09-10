import { Navigate, Outlet, useLocation } from "@tanstack/react-router";
import { Settings2 } from "lucide-react";
import { useEnvironment } from "@/providers/environment";
import { SessionProvider, useSession } from "@/features/sessions/session-context";
import { SessionDialogs } from "@/features/sessions/session-dialogs";
import { PairingPage } from "@/features/connection/pairing-page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function SessionLayout() {
  const env = useEnvironment();
  if (env.hosted && !env.origin) return <Navigate to="/connect" replace />;
  return (
    <SessionProvider
      key={env.attempt}
      origin={env.origin ?? ""}
      initialLocale={env.locale}
      initialTheme={env.theme}
      disconnect={env.hosted || env.origin ? env.disconnect : undefined}
    >
      <SessionShell />
    </SessionProvider>
  );
}
function SessionShell() {
  const { t, access, origin, disconnect, error, incompatible, setIncompatible, refresh, setModal } =
    useSession();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center justify-between border-b px-5 md:px-7">
        <div className="flex items-center gap-3">
          <span className="grid size-8 place-items-center rounded-xl bg-foreground text-sm font-bold text-background">
            K
          </span>
          <strong className="text-sm tracking-tight">AgentKib</strong>
          <Badge variant="secondary" className="font-normal">
            Web
          </Badge>
          <span className="ml-3 hidden border-l pl-4 text-xs text-muted-foreground sm:block">
            {t.remote}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t.preferences}
          onClick={() => setModal("preferences")}
        >
          <Settings2 />
        </Button>
      </header>
      {origin && (
        <div className="flex shrink-0 items-center justify-between gap-3 border-b bg-muted/40 px-5 py-1 text-xs text-muted-foreground">
          <span className="truncate">
            {origin} · {t.lanPlaintextShort}
          </span>
          <Button variant="ghost" size="sm" className="shrink-0 text-xs" onClick={disconnect}>
            {t.changeBackend}
          </Button>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-5 py-2 text-sm text-destructive"
        >
          <span>{origin ? (incompatible ? t.lanIncompatible : t.lanFailure) : t.error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setIncompatible(false);
              void refresh(true);
            }}
          >
            {t.retry}
          </Button>
        </div>
      )}
      {access?.status === "approved" ? <Outlet /> : <PairingPage />}
      {access && access.status !== "approved" && pathname !== "/pair" && (
        <Navigate
          to="/pair"
          search={{
            session: pathname.startsWith("/sessions/")
              ? decodeURIComponent(pathname.slice(10))
              : undefined,
          }}
          replace
        />
      )}
      <SessionDialogs />
    </div>
  );
}
