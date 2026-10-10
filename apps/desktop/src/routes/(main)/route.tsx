import { type CSSProperties } from "react";
import {
  createFileRoute,
  Outlet,
  useLocation,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { useI18n } from "@/core/useI18n";
import { AppSidebar, type AgentFilter } from "@/components/AppSidebar";
import { Button } from "@/components/ui/button";
import { AppToolbar } from "@/features/app/AppToolbar";
import { useAppNavigationContext } from "@/features/app/AppNavigationContext";
import { SidebarResizeHandle } from "@/features/app/SidebarResizeHandle";
import { useRetainedScroll } from "@/features/app/useRetainedScroll";
import { useSidebarLayout } from "@/features/app/useSidebarLayout";
import { retainedScrollOffsets } from "@/features/app/retained-scroll-offsets";
import { WindowNavigationControls } from "@/features/app/WindowNavigationControls";
import { useSidebarWidthStore } from "@/features/app/sidebar-width-store";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { SessionHubProvider } from "@/features/sessions/SessionHubContext";
import { SessionWindowToolbar } from "@/features/sessions/SessionWindowToolbar";
import { WindowToolbar } from "@/components/WindowToolbar";
import { workspaceSearchForPage, type AppSearch, type Page } from "@/features/app/app-route";
import { cn } from "cn";
import { useAppDialogs } from "@/components/AppDialogProvider";

function MainLayout() {
  const { app, history, searchOpen, onOpenSearch } = useAppNavigationContext();
  const { tr } = useI18n();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const locationKey = useLocation({ select: (location) => location.href });
  const search = useSearch({ strict: false }) as AppSearch;
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const favoriteWorkspaceIds = useAppStore((state) => state.favoriteWorkspaceIds);
  const workspaceState = useWorkspaceStore();
  const sidebarWidth = useSidebarWidthStore();
  const route = app.route;
  const active = app.globalPage;
  const isWorkspace = route.kind === "workspace";
  const isSessions = route.kind === "global" && route.page === "sessions";
  const discoveryFailure = app.refreshJobs.find(
    (job) => job.kind === "discovery" && job.state === "failed",
  );
  const agentFilter = search.agentFilter ?? "all";
  const { maxWidth, visibleWidth, canResize } = useSidebarLayout();
  const scrollRef = useRetainedScroll(locationKey, retainedScrollOffsets);
  const hasSidebarPanel =
    isWorkspace || ["workspaces", "agents", "sessions", "catalog"].includes(active);

  const setAgentFilter = (filter: AgentFilter) => {
    void navigate({
      to: "/agents",
      search: (current) => ({ ...current, agentFilter: filter }) as never,
    });
  };
  const navigateWorkspace = (page: Page) => {
    if (route.kind !== "workspace") return;
    if (useWorkspaceStore.getState().applyingChanges) {
      void dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    void navigate({
      to: (page === "overview"
        ? "/workspace/$workspaceId"
        : `/workspace/$workspaceId/${page}`) as never,
      params: { workspaceId: route.workspaceId } as never,
      search: (current) => workspaceSearchForPage(current as AppSearch, page) as never,
    });
  };

  const entries = app.navigation;
  const sidebar = (
    <AppSidebar
      searchOpen={searchOpen}
      onRefresh={() => void app.refreshCurrentView()}
      active={isWorkspace ? "workspaces" : active}
      collapsed={sidebarCollapsed}
      entries={entries}
      favoriteWorkspaceIds={favoriteWorkspaceIds}
      workspaces={[...app.workspaces].sort((left, right) => {
        const leftFavorite = favoriteWorkspaceIds.indexOf(left.id);
        const rightFavorite = favoriteWorkspaceIds.indexOf(right.id);
        if (leftFavorite >= 0 || rightFavorite >= 0) {
          if (leftFavorite < 0) return 1;
          if (rightFavorite < 0) return -1;
          return leftFavorite - rightFavorite;
        }
        return left.name.localeCompare(right.name);
      })}
      workspacesPending={app.workspacesPending}
      workspacesError={app.workspacesError}
      onRetryWorkspaces={() => void app.retryWorkspaces()}
      activeWorkspaceId={route.kind === "workspace" ? route.workspaceId : undefined}
      workspacePage={route.kind === "workspace" ? route.page : undefined}
      changeCount={
        workspaceState.changeSet?.changes.length ?? (workspaceState.handoffLaunchRequest ? 1 : 0)
      }
      onWorkspaceNavigate={navigateWorkspace}
      onOpenWorkspace={(workspace, page) => void app.openWorkspace(workspace, page)}
      onNavigate={app.navigateGlobal}
      onSettings={app.openSettings}
      onRemoteSettings={() => void app.openSettings("remote")}
      context={
        isSessions
          ? { kind: "sessions" }
          : active === "agents"
            ? { kind: "agents", filter: agentFilter, onFilterChange: setAgentFilter }
            : { kind: "global" }
      }
    />
  );
  const breadcrumb = isWorkspace
    ? [workspaceState.selectedWorkspace?.name ?? tr("nav.workspaces"), tr(`nav.${route.page}`)]
    : active === "home"
      ? [tr("nav.workspaces"), tr("nav.home")]
      : [tr(entries.find((entry) => entry.id === active)?.label ?? "nav.home")];
  const toolbar = isSessions ? <SessionWindowToolbar /> : <AppToolbar breadcrumb={breadcrumb} />;
  const shellClassName = cn(
    "group app-shell !grid !h-full !w-full !min-h-0 !overflow-hidden",
    sidebarCollapsed && "app-shell-sidebar-collapsed",
    !hasSidebarPanel && "app-shell-no-context",
    sidebarWidth.dragging && "app-shell-sidebar-resizing",
  );

  return (
    <SessionHubProvider active={isSessions}>
      <div
        style={{ "--sidebar-expanded-width": `${visibleWidth}px` } as CSSProperties}
        className={shellClassName}
      >
        <WindowToolbar />
        <div className={cn("app-shell-header", isSessions && "!border-b-border")}>{toolbar}</div>
        <WindowNavigationControls
          hasSidebarPanel={hasSidebarPanel}
          canGoBack={history.canGoBack}
          canGoForward={history.canGoForward}
          onBack={history.goBack}
          onForward={history.goForward}
          onOpenSearch={onOpenSearch}
        />
        {sidebar}
        {hasSidebarPanel && !sidebarCollapsed && canResize && (
          <SidebarResizeHandle width={visibleWidth} maxWidth={maxWidth} />
        )}
        {sidebarWidth.error && (
          <div className="sidebar-resize-error" role="alert">
            <span>{tr("sidebar.resizeSaveFailed")}</span>
            <Button variant="ghost" size="sm" onClick={sidebarWidth.clearError}>
              {tr("common.close")}
            </Button>
          </div>
        )}
        <main className="app-shell-main !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm">
          <div ref={scrollRef} className="page-scroll-container min-h-0 flex-1">
            {app.message && (
              <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                <CircleAlert size={17} />
                {app.message}
              </div>
            )}
            {active === "workspaces" && discoveryFailure?.error && (
              <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {discoveryFailure.error}
              </div>
            )}
            <section
              className={cn(
                "content mx-auto w-full max-w-[1500px] px-6 pb-10 pt-5 max-[640px]:px-4",
                isSessions && "app-sessions-content !pt-0",
              )}
            >
              <Outlet />
            </section>
          </div>
        </main>
      </div>
    </SessionHubProvider>
  );
}

export const Route = createFileRoute("/(main)")({ component: MainLayout });
