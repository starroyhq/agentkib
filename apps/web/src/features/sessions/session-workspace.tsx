import {
  homeSessionCopy,
  newSessionCopy,
  requestReadStateRefresh,
  SessionContinuationStatus,
} from "@agentkib/session-ui";
import { HistorySearchTrigger } from "@/features/conversation/features/history/history-search-controls";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  FolderOpen,
  House,
  MoreHorizontal,
  Plus,
  Settings2,
  RefreshCw,
  LogOut,
  Monitor,
} from "lucide-react";
import { SessionCatalog } from "@/features/conversation/features/catalog/session-catalog";
import { SessionRowMenu } from "@/features/conversation/features/catalog/session-row-menu";
import { Button } from "@/features/conversation/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/features/conversation/components/ui/dialog";
import { useSession } from "@/features/conversation/features/sessions/session-context";
import { PendingCenter } from "@/features/conversation/features/sessions/pending-center";
import { SessionPanelsContext } from "@/features/conversation/features/sessions/session-panels";
import { sessionDisplayState } from "@/features/conversation/features/sessions/session-display-state";
import { codexCopyForSurface } from "@/features/conversation/features/sessions/codex-copy";
import { webLayoutCopy } from "@/features/conversation/features/sessions/web-layout-copy";
import { cn } from "@/features/conversation/lib/utils";
import { sessionAccessCopy } from "./session-access-copy";
import { HomeAttentionProvider, useHomeAttention } from "./home/home-attention";
import { canStartSessions, HomeViewContext } from "./home/session-home";
import { NewSessionComposer } from "./new-session/new-session-composer";
import { useOpenWhenListed } from "./new-session/use-open-when-listed";

export function SessionWorkspace() {
  return (
    <HomeAttentionProvider>
      <WorkspaceShell />
    </HomeAttentionProvider>
  );
}

function WorkspaceShell() {
  const session = useSession();
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
    currentTitle,
    currentWorkspace,
    leaveSession,
    setModal,
  } = session;
  const navigate = useNavigate();
  const reading = useLocation({
    select: (location) =>
      location.pathname.startsWith("/sessions/") && location.pathname !== "/sessions/",
  });
  const [filesOpen, setFilesOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutFailed, setLogoutFailed] = useState(false);
  const logoutLocked = useRef(false);
  const mounted = useRef(false);
  const logoutTrigger = useRef<HTMLButtonElement | null>(null);
  const cancelLogout = useRef<HTMLButtonElement | null>(null);
  const logoutDescriptionId = useId();
  const accessCopy = sessionAccessCopy[locale];
  const home = homeSessionCopy(locale);
  const attention = useHomeAttention();
  const needsYou = attention?.groups.needsYou.length ?? 0;
  // At phone width the home and the directory take turns; wider screens show both.
  const [phoneView, setPhoneView] = useState<"home" | "all">("home");
  const [newOpen, setNewOpen] = useState(false);
  const openWhenListed = useOpenWhenListed();
  const canCreate = canStartSessions(access);
  const homeView = useMemo(() => ({ showAll: () => setPhoneView("all") }), []);
  // A decision whose outcome is unknown marks its session in the directory as well.
  const pendingMarks = useMemo(
    () => ({
      ...pendingSessions,
      ...Object.fromEntries([...(attention?.replies.unconfirmed ?? [])].map((id) => [id, true])),
    }),
    [pendingSessions, attention?.replies.unconfirmed],
  );
  function goHome() {
    leaveSession();
    setPhoneView("home");
    void navigate({ to: "/sessions" });
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setFilesOpen(false);
    setActionsOpen(false);
  }, [selected]);
  useEffect(() => {
    if (!session.modal) return;
    // An incoming approval must not compete with the fullscreen file panel's
    // focus trap. Keep the existing global dialog as the sole modal surface.
    setFilesOpen(false);
    setActionsOpen(false);
    setLogoutOpen(false);
  }, [session.modal]);
  function closeLogout() {
    if (logoutLocked.current) return;
    setLogoutOpen(false);
    setLogoutFailed(false);
  }
  async function endAccess() {
    if (logoutLocked.current || session.busy) return;
    logoutLocked.current = true;
    setLogoutPending(true);
    setLogoutFailed(false);
    try {
      await post("logout", {});
    } catch {
      // A thrown request failure is shown as an unconfirmed logout below.
    } finally {
      logoutLocked.current = false;
      if (mounted.current) {
        setLogoutPending(false);
        // post handles transport errors internally. A confirmed access change
        // leaves this workspace through SessionShell; staying here is not success.
        setLogoutFailed(true);
      }
    }
  }
  const copy = webLayoutCopy[locale];
  const status = sessionDisplayState(session, "web");
  return (
    <SessionPanelsContext
      value={{
        filesOpen: filesOpen && !session.modal,
        setFilesOpen,
        actionsOpen: actionsOpen && !session.modal,
        setActionsOpen,
      }}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex min-h-16 shrink-0 items-center border-b">
          <div
            className={cn(
              "items-center gap-3 px-4 md:flex md:w-[280px] md:shrink-0 md:border-r",
              reading ? "hidden" : "flex flex-1 md:flex-none",
            )}
          >
            <Button
              variant="bare"
              size="content"
              className="min-h-11 flex-1 justify-start gap-3 rounded-lg"
              aria-label={`AgentKib · ${home.home}`}
              title={home.home}
              onClick={goHome}
            >
              <span
                aria-hidden="true"
                className="grid size-8 place-items-center rounded-xl bg-foreground font-bold text-background"
              >
                K
              </span>
              <strong className="text-sm">AgentKib</strong>
            </Button>
            <Button
              variant="ghost"
              className="hidden size-11 p-0 md:inline-flex"
              aria-label={t.preferences}
              onClick={() => setModal("preferences")}
            >
              <Settings2 />
            </Button>
          </div>
          {!reading && <h1 className="hidden px-5 text-sm font-medium md:block">{home.home}</h1>}
          {reading && (
            <div className="flex min-w-0 flex-1 items-center gap-1 px-2 md:px-5">
              <Button
                variant="ghost"
                className="size-11 p-0 md:hidden"
                aria-label={t.back}
                onClick={() => {
                  leaveSession();
                  void navigate({ to: "/sessions" });
                }}
              >
                <ArrowLeft />
              </Button>
              <div className="min-w-0 flex-1 py-2">
                <h1 className="truncate text-sm font-semibold" title={currentTitle}>
                  {currentTitle}
                </h1>
                <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="max-w-[45%] truncate md:max-w-40" title={currentWorkspace?.path}>
                    {currentWorkspace?.name}
                  </span>
                  {status.label && <span aria-hidden="true">·</span>}
                  {["codex", "claude-code", "deepseek-harness"].includes(
                    session.current?.agent ?? "",
                  ) ? (
                    <SessionContinuationStatus
                      label={status.label}
                      active={status.tone === "active"}
                      loading={status.loading}
                      // The workspace name truncates first; the state stays on one line.
                      className="shrink-0 whitespace-nowrap"
                    />
                  ) : (
                    <span
                      role="status"
                      className={cn(
                        "truncate",
                        status.tone === "warning" && "text-amber-700 dark:text-amber-300",
                      )}
                    >
                      {status.label}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}
          <div
            className={cn(
              "flex shrink-0 items-center gap-0.5 pr-2 md:gap-2 md:pr-5",
              !reading && "md:ml-auto",
            )}
          >
            <PendingCenter compact needsYou={attention?.groups.needsYou} />
            {reading ? (
              <>
                {access?.device?.files && (
                  <Button
                    variant={filesOpen ? "secondary" : "ghost"}
                    className="size-11 rounded-lg p-0 text-muted-foreground aria-expanded:text-foreground sm:h-9 md:w-auto md:gap-1.5 md:px-2.5"
                    aria-label={copy.files}
                    aria-expanded={filesOpen}
                    onClick={() => setFilesOpen(!filesOpen)}
                  >
                    <FolderOpen />
                    <span className="hidden lg:inline">{copy.files}</span>
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="size-11 rounded-lg p-0 text-muted-foreground aria-expanded:text-foreground sm:h-9 md:w-auto md:gap-1.5 md:px-2.5"
                  data-dialog-return-focus="true"
                  aria-label={copy.actions}
                  aria-expanded={actionsOpen}
                  onClick={() => setActionsOpen(true)}
                >
                  <MoreHorizontal />
                  <span className="hidden lg:inline">{copy.actions}</span>
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                className="size-11 p-0 md:hidden"
                aria-label={t.preferences}
                onClick={() => setModal("preferences")}
              >
                <Settings2 />
              </Button>
            )}
          </div>
        </header>
        {!reading && (
          <div className="flex items-center gap-3 border-b px-4 py-2 md:hidden">
            <div role="group" className="inline-flex rounded-xl bg-muted p-0.5">
              {(["home", "all"] as const).map((view) => (
                <Button
                  key={view}
                  variant="bare"
                  size="content"
                  aria-pressed={phoneView === view}
                  className={cn(
                    "min-h-10 rounded-[10px] px-4 text-sm",
                    phoneView === view
                      ? "bg-background font-medium text-foreground shadow-xs"
                      : "text-muted-foreground",
                  )}
                  onClick={() => setPhoneView(view)}
                >
                  {view === "home" ? home.home : home.allSessions}
                </Button>
              ))}
            </div>
            {canCreate && (
              <Button
                className="ml-auto size-11 rounded-full p-0"
                aria-label={newSessionCopy(locale).newSession}
                title={newSessionCopy(locale).newSession}
                disabled={!!session.error}
                onClick={() => setNewOpen(true)}
              >
                <Plus className="size-5" />
              </Button>
            )}
          </div>
        )}
        {session.catalogNotice && (
          <p role="status" className="border-b px-4 py-3 text-sm text-muted-foreground">
            {session.c.excludedSession}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "flex min-h-0 w-full shrink-0 flex-col border-r bg-sidebar md:w-[280px]",
              (reading || phoneView === "home") && "hidden md:flex",
            )}
          >
            <div className="hidden px-3 pt-4 md:block">
              <Button
                variant="ghost"
                aria-current={!reading ? "page" : undefined}
                aria-label={needsYou ? `${home.home} · ${home.needsYou} ${needsYou}` : home.home}
                className={cn(
                  "h-10 w-full justify-start gap-2 rounded-lg px-3 text-sm font-normal",
                  !reading && "bg-background text-foreground shadow-xs ring-1 ring-border",
                )}
                onClick={goHome}
              >
                <House className="size-4" />
                <span className="flex-1 text-left">{home.home}</span>
                {needsYou > 0 && (
                  <span
                    aria-hidden="true"
                    className="grid h-5 min-w-5 place-items-center rounded-full bg-amber-600 px-1 text-[11px] font-semibold tabular-nums text-white"
                  >
                    {needsYou}
                  </span>
                )}
              </Button>
            </div>
            <header className="flex items-center justify-between px-5 pb-4 pt-6 md:pt-4">
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-semibold">{t.sessions}</h1>
                <span className="rounded-md bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                  {sessions.length}
                </span>
              </div>
              <Button
                variant="ghost"
                className="size-11 p-0"
                aria-label={t.refresh}
                onClick={() => {
                  requestReadStateRefresh(session.client, selected);
                  void refresh(true);
                }}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </header>
            <HistorySearchTrigger />
            <SessionCatalog
              readContext={session.client}
              pendingSessions={pendingMarks}
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
              status={session.catalogStatus}
              // Rename, archive and delete need this browser's organize permission.
              rowMenu={
                access?.device?.organize ? (row) => <SessionRowMenu session={row} /> : undefined
              }
              execution={session.showExecution}
              onExecutionChange={session.setShowExecution}
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
                ref={logoutTrigger}
                className="size-11"
                variant="ghost"
                size="icon"
                aria-label={t.logout}
                aria-haspopup="dialog"
                disabled={logoutPending || session.busy}
                onClick={() => {
                  if (logoutLocked.current || session.busy) return;
                  setFilesOpen(false);
                  setActionsOpen(false);
                  setLogoutFailed(false);
                  setLogoutOpen(true);
                }}
              >
                <LogOut className="size-4" />
              </Button>
            </footer>
          </aside>
          <main
            className={cn(
              "min-w-0 flex-1 flex-col bg-background",
              reading || phoneView === "home" ? "flex" : "hidden md:flex",
            )}
          >
            <HomeViewContext value={homeView}>
              <Outlet />
            </HomeViewContext>
          </main>
        </div>
      </div>
      <Dialog
        open={newOpen && !session.modal}
        onOpenChange={(open) => {
          if (!open) setNewOpen(false);
        }}
      >
        <DialogContent
          closeLabel={codexCopyForSurface(locale, "web").close}
          // At phone width the panel stays at the top, so the keyboard does not cover it.
          className="top-4 translate-y-0 sm:top-1/2 sm:-translate-y-1/2"
        >
          <DialogHeader>
            <DialogTitle>{newSessionCopy(locale).newSession}</DialogTitle>
          </DialogHeader>
          <NewSessionComposer
            autoFocus
            disabled={!!session.error}
            onCreated={async (sessionId) => {
              await openWhenListed(sessionId);
              setNewOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={logoutOpen && !session.modal} onOpenChange={(open) => !open && closeLogout()}>
        <DialogContent
          showCloseButton={false}
          initialFocus={cancelLogout}
          finalFocus={logoutTrigger}
          aria-describedby={logoutDescriptionId}
          aria-busy={logoutPending || undefined}
        >
          <DialogHeader>
            <DialogTitle>{accessCopy.title}</DialogTitle>
          </DialogHeader>
          <p id={logoutDescriptionId} className="text-sm text-muted-foreground">
            {accessCopy.description}
          </p>
          {logoutFailed && (
            <p role="alert" className="text-sm text-destructive-text">
              {accessCopy.failed}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              ref={cancelLogout}
              variant="outline"
              disabled={logoutPending}
              onClick={closeLogout}
            >
              {accessCopy.cancel}
            </Button>
            <Button
              variant="destructive"
              disabled={logoutPending || session.busy}
              onClick={() => void endAccess()}
            >
              {logoutPending ? accessCopy.pending : accessCopy.confirm}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </SessionPanelsContext>
  );
}
