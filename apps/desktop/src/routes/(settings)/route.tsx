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
import { AppSidebar } from "@/components/AppSidebar";
import { Button } from "@/components/ui/button";
import {
  SettingsSidebar,
  type SettingsSection,
  type SettingsTarget,
} from "@/features/settings/SettingsSidebar";
import { useAppNavigationContext } from "@/features/app/AppNavigationContext";
import { SidebarResizeHandle } from "@/features/app/SidebarResizeHandle";
import { useRetainedScroll } from "@/features/app/useRetainedScroll";
import { useSidebarLayout } from "@/features/app/useSidebarLayout";
import { retainedScrollOffsets } from "@/features/app/retained-scroll-offsets";
import { WindowNavigationControls } from "@/features/app/WindowNavigationControls";
import { useSidebarWidthStore } from "@/features/app/sidebar-width-store";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { WindowToolbar } from "@/components/WindowToolbar";
import { cn } from "cn";

function SettingsLayout() {
  const { app, history, searchOpen, onOpenSearch } = useAppNavigationContext();
  const { tr } = useI18n();
  const navigate = useNavigate();
  const locationKey = useLocation({ select: (location) => location.href });
  const search = useSearch({ strict: false }) as {
    settingsSection?: SettingsSection;
    settingsTarget?: SettingsTarget;
  };
  const favoriteWorkspaceIds = useAppStore((state) => state.favoriteWorkspaceIds);
  const workspaceState = useWorkspaceStore();
  const sidebarWidth = useSidebarWidthStore();
  const { maxWidth, visibleWidth, canResize } = useSidebarLayout();
  const scrollRef = useRetainedScroll(locationKey, retainedScrollOffsets);
  const section = search.settingsSection ?? "general";
  const setSettingsSection = (nextSection: SettingsSection, target?: SettingsTarget) => {
    void navigate({
      to: "/settings",
      search: (current) =>
        ({ ...current, settingsSection: nextSection, settingsTarget: target }) as never,
    });
  };
  const sidebar = (
    <AppSidebar
      searchOpen={searchOpen}
      onRefresh={() => void app.refreshCurrentView()}
      active="settings"
      collapsed={false}
      entries={app.navigation}
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
      changeCount={
        workspaceState.changeSet?.changes.length ?? (workspaceState.handoffLaunchRequest ? 1 : 0)
      }
      onWorkspaceNavigate={() => undefined}
      onOpenWorkspace={(workspace, page) => void app.openWorkspace(workspace, page)}
      onNavigate={app.navigateGlobal}
      onSettings={app.openSettings}
      onRemoteSettings={() => void app.openSettings("remote")}
      context={{ kind: "global" }}
      secondary={
        <SettingsSidebar
          active={section}
          activeTarget={search.settingsTarget}
          onSelect={setSettingsSection}
        />
      }
    />
  );

  return (
    <div
      style={{ "--sidebar-expanded-width": `${visibleWidth}px` } as CSSProperties}
      className={cn(
        "group app-shell app-shell-settings app-shell-headerless !grid !h-full !w-full !min-h-0 !overflow-hidden",
        sidebarWidth.dragging && "app-shell-sidebar-resizing",
      )}
    >
      <WindowToolbar />
      <WindowNavigationControls
        hasSidebarPanel
        sidebarFixed
        canGoBack={history.canGoBack}
        canGoForward={history.canGoForward}
        onBack={history.goBack}
        onForward={history.goForward}
        onOpenSearch={onOpenSearch}
      />
      {sidebar}
      {canResize && <SidebarResizeHandle width={visibleWidth} maxWidth={maxWidth} />}
      {sidebarWidth.error && (
        <div className="sidebar-resize-error" role="alert">
          <span>{tr("sidebar.resizeSaveFailed")}</span>
          <Button variant="ghost" size="sm" onClick={sidebarWidth.clearError}>
            {tr("common.close")}
          </Button>
        </div>
      )}
      <main
        className={cn(
          "app-shell-main !flex !min-h-0 !min-w-0 !h-full !flex-col !overflow-hidden !text-sm",
          `settings-section-${section}`,
        )}
      >
        <div ref={scrollRef} className="page-scroll-container min-h-0 flex-1">
          {app.message && (
            <div className="mx-7 mt-10 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <CircleAlert size={17} />
              {app.message}
            </div>
          )}
          <section className="settings-content mx-auto grid w-full gap-5 px-6 pb-10 pt-10 max-[640px]:px-4">
            <Outlet />
          </section>
        </div>
      </main>
    </div>
  );
}

export const Route = createFileRoute("/(settings)")({
  staticData: { appRoute: { kind: "settings" } },
  component: SettingsLayout,
});
