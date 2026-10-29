import { SessionContinuationStatus } from "@agentkib/session-ui";
import { HistorySearchTrigger } from "@/features/conversation/features/history/history-search-controls";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  FolderOpen,
  MoreHorizontal,
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
import { ManagedTasks } from "@/features/conversation/features/sessions/managed-tasks";
import { PendingCenter } from "@/features/conversation/features/sessions/pending-center";
import { SessionPanelsContext } from "@/features/conversation/features/sessions/session-panels";
import { sessionDisplayState } from "@/features/conversation/features/sessions/session-display-state";
import { webLayoutCopy } from "@/features/conversation/features/sessions/web-layout-copy";
import { cn } from "@/features/conversation/lib/utils";
import { sessionAccessCopy } from "./session-access-copy";

export function SessionWorkspace() {
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
            <span
              aria-hidden="true"
              className="grid size-8 place-items-center rounded-xl bg-foreground font-bold text-background"
            >
              K
            </span>
            <strong className="flex-1 text-sm">AgentKib</strong>
            <Button
              variant="ghost"
              className="hidden size-11 p-0 md:inline-flex"
              aria-label={t.preferences}
              onClick={() => setModal("preferences")}
            >
              <Settings2 />
            </Button>
          </div>
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
                  {["codex", "claude-code"].includes(session.current?.agent ?? "") ? (
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
            <PendingCenter compact />
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
        {session.catalogNotice && (
          <p role="status" className="border-b px-4 py-3 text-sm text-muted-foreground">
            {session.c.excludedSession}
          </p>
        )}
        <div className="flex min-h-0 flex-1">
          <aside
            className={cn(
              "flex min-h-0 w-full shrink-0 flex-col border-r bg-sidebar md:w-[280px]",
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
                className="size-11 p-0"
                aria-label={t.refresh}
                onClick={() => void refresh(true)}
              >
                <RefreshCw className="size-3.5" />
              </Button>
            </header>
            <ManagedTasks create />
            <HistorySearchTrigger />
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
              reading ? "flex" : "hidden md:flex",
            )}
          >
            <Outlet />
          </main>
        </div>
      </div>
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
