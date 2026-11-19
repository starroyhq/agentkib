import { useMemo, useState, type CSSProperties } from "react";
import { createRootRoute, Outlet, useMatches, useSearch } from "@tanstack/react-router";
import { Toaster } from "sonner";
import { useI18n } from "@/core/useI18n";
import { GlobalSearchDialog } from "@/features/app/GlobalSearchDialog";
import { AppNavigationProvider } from "@/features/app/AppNavigationContext";
import { appSearchSchema } from "@/features/app/app-search-schema";
import { routeFromMatches, type AppSearch } from "@/features/app/app-route";
import { AppRuntimeBridge } from "@/features/app/AppRuntimeBridge";
import { SidebarPanelProvider } from "@/features/app/SidebarPanel";
import { ShortcutHelpDialog } from "@/features/app/ShortcutHelpDialog";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppHistory } from "@/features/app/useAppHistory";
import { useAppNavigation } from "@/features/app/useAppNavigation";
import { useAppShortcuts } from "@/features/app/useAppShortcuts";
import { RemoteCatalogBridge } from "@/features/remote/remote-catalog-store";
import { DesktopConversationWindowProvider } from "@/features/sessions/DesktopConversationWindow";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { useAppStore } from "@/stores/app-store";

function RootLayout() {
  const { tr } = useI18n();
  const matches = useMatches();
  const route = useMemo(() => routeFromMatches(matches), [matches]);
  const app = useAppNavigation(route);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const history = useAppHistory(app.prepareHistoryNavigation);
  const search = useSearch({ strict: false }) as AppSearch;

  useAppShortcuts({
    onNavigate: app.navigateGlobal,
    onOpenSettings: app.openSettings,
    onRefreshCurrent: app.refreshCurrentView,
    onAddWorkspace: app.addWorkspace,
    onAddScanRoot: app.addScanRoot,
    onToggleSidebar: () => {
      if (route.kind === "settings") return;
      if (
        route.kind !== "global" ||
        ["workspaces", "agents", "sessions", "catalog"].includes(route.page)
      ) {
        setSidebarCollapsed((value) => !value);
      }
    },
    onGoBack: history.goBack,
    onGoForward: history.goForward,
    onOpenSearch: () => setSearchOpen(true),
    onOpenHelp: () => setShortcutHelpOpen(true),
    helpOpen: shortcutHelpOpen,
  });

  return (
    <TooltipProvider>
      <AppNavigationProvider
        value={{ app, history, searchOpen, onOpenSearch: () => setSearchOpen(true) }}
      >
        <ShortcutHelpProvider openShortcutHelp={() => setShortcutHelpOpen(true)}>
          <AppRuntimeBridge />
          <RemoteCatalogBridge />
          <SidebarPanelProvider>
            <DesktopConversationWindowProvider>
              <Outlet />
            </DesktopConversationWindowProvider>
          </SidebarPanelProvider>
          <GlobalSearchDialog
            open={searchOpen}
            onOpenChange={setSearchOpen}
            entries={app.navigation}
            workspaces={app.workspaces}
            onNavigate={app.navigateGlobal}
            onOpenWorkspace={(workspace) => void app.openWorkspace(workspace)}
            onOpenSession={(session) => {
              useSessionViewStore.getState().revealSession(session);
              app.navigateGlobal("sessions", false, { sessionId: session.id });
            }}
            onSessionSettings={() => app.openSettings("privacy")}
          />
          <ShortcutHelpDialog open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen} />
          <Toaster
            position="top-right"
            offset={{ top: "calc(var(--window-toolbar-height, 0px) + 16px)" }}
            closeButton
            duration={5000}
            style={
              {
                "--normal-bg": "var(--card)",
                "--normal-text": "var(--card-foreground)",
                "--normal-border": "var(--border)",
              } as CSSProperties
            }
            toastOptions={{ closeButtonAriaLabel: tr("common.close") }}
          />
        </ShortcutHelpProvider>
      </AppNavigationProvider>
    </TooltipProvider>
  );
}

export const Route = createRootRoute({
  validateSearch: appSearchSchema,
  component: RootLayout,
  notFoundComponent: NotFound,
});

function NotFound() {
  const { tr } = useI18n();
  return <div>{tr("common.notFound")}</div>;
}
