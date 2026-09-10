import { useI18n } from "@/core/useI18n";
import { createRootRoute, Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { CircleAlert } from "lucide-react";
import { z } from "zod";
import { AppSidebar, type AgentFilter, type SidebarEntry } from "@/components/AppSidebar";
import { RemoteCatalogBridge } from "@/features/remote/remote-catalog-store";
import type { SettingsSection } from "@/features/settings/SettingsSidebar";
import {
  SettingsSidebar,
  settingsTargets,
  type SettingsTarget,
} from "@/features/settings/SettingsSidebar";
import type { InsightsSection } from "@/features/insights/InsightsPage";
import type { AgentKind, RefreshJobStatus } from "../core/types";
import { AppRuntimeBridge } from "../features/app/AppRuntimeBridge";
import { AppShell } from "../features/app/AppShell";
import {
  workspaceSearchForPage,
  type AppSearch,
  type GlobalPage,
  type ParsedRoute,
} from "../features/app/app-route";
import { cn } from "@/lib/utils";
import { useAppNavigation } from "../features/app/useAppNavigation";
import { ShortcutHelpDialog } from "../features/app/ShortcutHelpDialog";
import { ShortcutHelpProvider } from "../features/app/ShortcutHelpContext";
import { useAppShortcuts } from "../features/app/useAppShortcuts";
import { useAppHistory } from "../features/app/useAppHistory";
import { useAppStore } from "../stores/app-store";
import { useState } from "react";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { AppToolbar } from "@/features/app/AppToolbar";
import { GlobalSearchDialog } from "@/features/app/GlobalSearchDialog";
import type { WorkspaceSummary } from "@/core/types";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { SessionHubProvider } from "@/features/sessions/SessionHubContext";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { SessionWindowToolbar } from "@/features/sessions/SessionWindowToolbar";

function RootLayout() {
  const {
    route,
    globalPage,
    message,
    refreshJobs,
    navigation,
    workspaces,
    openWorkspace,
    navigateGlobal,
    openSettings,
    prepareHistoryNavigation,
    refreshCurrentView,
    addWorkspace,
    addScanRoot,
  } = useAppNavigation();
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const setSidebarCollapsed = useAppStore((state) => state.setSidebarCollapsed);
  const appHistory = useAppHistory(prepareHistoryNavigation);

  useAppShortcuts({
    onNavigate: navigateGlobal,
    onOpenSettings: openSettings,
    onRefreshCurrent: refreshCurrentView,
    onAddWorkspace: addWorkspace,
    onAddScanRoot: addScanRoot,
    onToggleSidebar: () => setSidebarCollapsed((value) => !value),
    onGoBack: appHistory.goBack,
    onGoForward: appHistory.goForward,
    onOpenSearch: () => setSearchOpen(true),
    onOpenHelp: () => setShortcutHelpOpen(true),
    helpOpen: shortcutHelpOpen,
  });

  return (
    <ShortcutHelpProvider openShortcutHelp={() => setShortcutHelpOpen(true)}>
      <AppRuntimeBridge />
      <RemoteCatalogBridge />
      <AppShellRouter
        searchOpen={searchOpen}
        route={route}
        active={globalPage}
        entries={navigation}
        workspaces={workspaces}
        message={message}
        refreshJobs={refreshJobs}
        onNavigate={navigateGlobal}
        onOpenWorkspace={(workspace) => void openWorkspace(workspace)}
        onSettings={openSettings}
        onRefresh={() => void refreshCurrentView()}
        onOpenSearch={() => setSearchOpen(true)}
        onOpenHelp={() => setShortcutHelpOpen(true)}
        canGoBack={appHistory.canGoBack}
        canGoForward={appHistory.canGoForward}
        onBack={appHistory.goBack}
        onForward={appHistory.goForward}
      />
      <GlobalSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        entries={navigation}
        workspaces={workspaces}
        onNavigate={navigateGlobal}
        onOpenWorkspace={(workspace) => void openWorkspace(workspace)}
        onOpenSession={(session) => {
          useSessionViewStore.getState().revealSession(session);
          navigateGlobal("sessions", false, { sessionId: session.id });
        }}
        onSessionSettings={() => openSettings("privacy")}
      />
      <ShortcutHelpDialog open={shortcutHelpOpen} onOpenChange={setShortcutHelpOpen} />
    </ShortcutHelpProvider>
  );
}

function AppShellRouter({
  searchOpen,
  route,
  active,
  entries,
  workspaces,
  message,
  refreshJobs,
  onNavigate,
  onOpenWorkspace,
  onSettings,
  onRefresh,
  onOpenSearch,
  onOpenHelp,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: {
  searchOpen: boolean;
  route: ParsedRoute;
  active: GlobalPage;
  entries: SidebarEntry<GlobalPage>[];
  workspaces: WorkspaceSummary[];
  message: string;
  refreshJobs: RefreshJobStatus[];
  onNavigate: (page: GlobalPage) => void;
  onOpenWorkspace: (workspace: WorkspaceSummary) => void;
  onSettings: () => void;
  onRefresh: () => void;
  onOpenSearch: () => void;
  onOpenHelp: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  const { tr } = useI18n();
  const navigate = useNavigate();
  const dialogs = useAppDialogs();
  const search = useSearch({ strict: false }) as AppSearch;
  const sidebarCollapsed = useAppStore((state) => state.sidebarCollapsed);
  const workspaceState = useWorkspaceStore();
  const settingsSection = search.settingsSection ?? "general";
  const isSettings = route.kind === "settings";
  const isWorkspace = route.kind === "workspace";
  const isSessions = route.kind === "global" && route.page === "sessions";
  const discoveryFailure = refreshJobs.find(
    (job) => job.kind === "discovery" && job.state === "failed",
  );
  const agentFilter = search.agentFilter ?? "all";

  const setSettingsSection = (section: SettingsSection, target?: SettingsTarget) => {
    void navigate({
      to: "/settings",
      search: (current) =>
        ({ ...current, settingsSection: section, settingsTarget: target }) as never,
    });
  };

  const setAgentFilter = (filter: AgentFilter) => {
    void navigate({
      to: "/agents",
      search: (current) => ({ ...current, agentFilter: filter }) as never,
    });
  };

  const navigateWorkspace = (page: import("@/features/app/app-route").Page) => {
    if (!isWorkspace) return;
    if (useWorkspaceStore.getState().applyingChanges) {
      void dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    const path =
      page === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${page}`;
    void navigate({
      to: path as never,
      params: { workspaceId: route.workspaceId } as never,
      search: (current) => workspaceSearchForPage(current as AppSearch, page) as never,
    });
  };

  const sidebar = isSettings ? (
    <SettingsSidebar
      searchOpen={searchOpen}
      onOpenSearch={onOpenSearch}
      active={settingsSection}
      activeTarget={search.settingsTarget}
      collapsed={sidebarCollapsed}
      onSelect={setSettingsSection}
      onBack={() => void navigate({ to: "/" })}
    />
  ) : (
    <AppSidebar
      searchOpen={searchOpen}
      onOpenSearch={onOpenSearch}
      active={isWorkspace ? "workspaces" : active}
      collapsed={sidebarCollapsed}
      entries={entries}
      onNavigate={onNavigate}
      onSettings={onSettings}
      onRemoteSettings={() =>
        void navigate({ to: "/settings", search: { settingsSection: "remote" } })
      }
      context={
        isWorkspace
          ? {
              kind: "workspace",
              workspace:
                workspaceState.selectedWorkspace ??
                workspaces.find((workspace) => workspace.id === route.workspaceId),
              page: route.page,
              changeCount:
                workspaceState.changeSet?.changes.length ??
                (workspaceState.handoffLaunchRequest ? 1 : 0),
              onWorkspaceNavigate: navigateWorkspace,
            }
          : isSessions
            ? { kind: "sessions" }
            : active === "agents"
              ? { kind: "agents", filter: agentFilter, onFilterChange: setAgentFilter }
              : {
                  kind: "global",
                  recentWorkspaces: [...workspaces]
                    .sort((left, right) =>
                      (right.last_active_at ?? "").localeCompare(left.last_active_at ?? ""),
                    )
                    .slice(0, 2),
                  onOpenWorkspace,
                }
      }
    />
  );

  const breadcrumb = isWorkspace
    ? [workspaceState.selectedWorkspace?.name ?? tr("nav.workspaces"), tr(`nav.${route.page}`)]
    : active === "home"
      ? [tr("nav.workspaces"), tr("nav.home")]
      : [tr(entries.find((entry) => entry.id === active)?.label ?? "nav.home")];

  const shell = (
    <AppShell
      sidebar={sidebar}
      sidebarMode={isSettings ? "settings" : "primary"}
      headerless={isSettings}
      toolbar={
        isSettings ? undefined : isSessions ? (
          <SessionWindowToolbar />
        ) : (
          <AppToolbar breadcrumb={breadcrumb} onRefresh={onRefresh} onOpenHelp={onOpenHelp} />
        )
      }
      mainClassName={
        isSettings
          ? `settings-section-${settingsSection}`
          : isSessions
            ? "app-sessions-main"
            : undefined
      }
      canGoBack={canGoBack}
      canGoForward={canGoForward}
      onBack={onBack}
      onForward={onForward}
    >
      {message && (
        <div
          className={cn(
            "mx-7 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive",
            isSettings ? "mt-10" : "mt-3",
          )}
        >
          <CircleAlert size={17} />
          {message}
        </div>
      )}
      {!isSettings && active === "workspaces" && discoveryFailure?.error && (
        <div className="mx-7 mt-3 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {discoveryFailure.error}
        </div>
      )}
      <section
        className={cn(
          isSettings
            ? "settings-content mx-auto grid w-full gap-5 px-6 pb-10 pt-10 max-[640px]:px-4"
            : isSessions
              ? "app-sessions-content h-full min-h-0"
              : isWorkspace
                ? "content mx-auto w-full max-w-[1500px] px-6 pb-10 pt-6 max-[640px]:px-4"
                : "content mx-auto w-full max-w-[1500px] px-6 pb-10 pt-5 max-[640px]:px-4",
        )}
      >
        <Outlet />
      </section>
    </AppShell>
  );
  // Router location and the retained Outlet can update in different commits.
  // Keep context mounted while old session content exits; pause indexing elsewhere.
  return <SessionHubProvider active={isSessions}>{shell}</SessionHubProvider>;
}

const quotaWindowSchema = z.object({
  provider_id: z.string(),
  account_id: z.string().optional(),
  kind: z.string(),
  label: z.string(),
});

const gitSubviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("commit"), oid: z.string() }),
  z.object({
    kind: z.literal("worktree"),
    path: z.string(),
    diffKind: z.enum(["commit", "worktree", "staged"]),
  }),
]);

const searchSchema = z.object({
  assetSection: z
    .enum(["instructions", "skills", "mcp", "memory", "other"])
    .optional()
    .catch(undefined),
  workspaceAssetSection: z
    .enum(["instructions", "skills", "mcp", "native"])
    .optional()
    .catch(undefined),
  workspaceView: z.enum(["list", "storage"]).optional().catch(undefined),
  settingsSection: z
    .enum([
      "general",
      "appearance",
      "discovery",
      "tools",
      "remote",
      "integrations",
      "privacy",
      "diagnostics",
    ] satisfies SettingsSection[])
    .optional()
    .catch(undefined),
  settingsTarget: z.enum(settingsTargets).optional().catch(undefined),
  insightsSection: z
    .enum(["overview", "tokens", "commits", "milestones", "sources"] satisfies InsightsSection[])
    .optional()
    .catch(undefined),
  quotaProvider: z.string().optional().catch(undefined),
  quotaWindow: quotaWindowSchema.optional().catch(undefined),
  gitSubview: gitSubviewSchema.optional().catch(undefined),
  agent: z.custom<AgentKind>().optional().catch(undefined),
  agentFilter: z.enum(["all", "enabled", "available"]).optional().catch(undefined),
  configure: z.boolean().optional().catch(undefined),
  doctorVerification: z.enum(["applied"]).optional().catch(undefined),
  sessionId: z.string().optional().catch(undefined),
  handoffSession: z.string().optional().catch(undefined),
  handoffTarget: z.custom<AgentKind>().optional().catch(undefined),
  handoffBudget: z
    .union([z.literal(64_000), z.literal(120_000), z.literal(180_000)])
    .optional()
    .catch(undefined),
  handoffFormat: z.enum(["markdown", "json"]).optional().catch(undefined),
  handoffResume: z.enum(["return", "recheck"]).optional().catch(undefined),
});

export const Route = createRootRoute({
  validateSearch: searchSchema,
  component: RootLayout,
  notFoundComponent: NotFound,
});

function NotFound() {
  const { tr } = useI18n();
  return <div>{tr("common.notFound")}</div>;
}
