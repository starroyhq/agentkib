import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type { Manifest, RefreshKind, WorkspaceSummary } from "@/core/types";
import type { SettingsSection } from "@/features/settings/SettingsSidebar";
import { refreshAgentTools } from "@/features/settings/agent-tools-query";
import { requestSessionRefresh } from "@/features/sessions/session-refresh";
import { withAsyncCleanup } from "@/lib/utils";
import { createGlobalNavigation } from "./global-navigation";
import { parseRoute, type AppSearch, type GlobalPage, type Page } from "./app-route";
import type { AppHistoryEntry } from "./useAppHistory";
import {
  homeKeys,
  useOptionalQueryClient,
  useHomeMemories,
  useHomeRefreshJobs,
  useHomeWorkspaces,
} from "@/features/home/home-query";

export type { AppSearch, GlobalPage, Page, ParsedRoute } from "./app-route";

export function useAppNavigation() {
  const { localizeMessage, tr } = useI18n();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  const search = useSearch({ strict: false }) as AppSearch;
  const route = parseRoute(location.pathname);
  const workspaceRouteId = route.kind === "workspace" ? route.workspaceId : undefined;
  const workspaceRoutePage = route.kind === "workspace" ? route.page : undefined;
  const routeGlobalPage = route.kind === "global" ? route.page : "home";
  const globalPage = routeGlobalPage;
  const appMode = route.kind === "settings" ? "settings" : "main";
  const queryClient = useOptionalQueryClient();
  const { data: workspaces = [], isPending: workspacesPending } = useHomeWorkspaces();
  const { data: globalMemories = [] } = useHomeMemories();
  const { data: refreshJobs = [] } = useHomeRefreshJobs();
  const settingsSection = search.settingsSection ?? "general";
  const quotaProvider = search.quotaProvider;
  const quotaWindow = search.quotaWindow;
  const appStore = useAppStore();
  const workspaceStore = useWorkspaceStore();
  const {
    navigationRequest,
    setNavigationRequest,
    menuCommand,
    setMenuCommand,
    setQuotaConfigureRequest,
  } = appStore;
  const {
    project,
    setProject,
    selectedWorkspace,
    setSelectedWorkspace,
    setScan,
    manifest,
    setManifest,
    setChangeSet,
    setChangeSetOrigin,
    setHandoffLaunchRequest,
    baselineManifest,
    setBaselineManifest,
    workspaceDrafts,
    setWorkspaceDrafts,
    message,
    setMessage,
    setBusy,
  } = workspaceStore;
  const workspaceOpenRequest = useRef(0);

  const updateSearch = useCallback(
    (patch: Partial<AppSearch>) => {
      void navigate({
        to: location.pathname as never,
        search: (current) => ({ ...current, ...patch }) as never,
      });
    },
    [location.pathname, navigate],
  );
  const navigateWorkspacePageFor = useCallback(
    (workspaceId: string, nextPage: Page) => {
      const path =
        nextPage === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${nextPage}`;
      void navigate({ to: path as never, params: { workspaceId } as never });
    },
    [navigate],
  );
  const setGitSubview = useCallback(
    (nextSubview: import("@/features/workspace/WorkspaceGitPage").GitSubview | undefined) =>
      updateSearch({ gitSubview: nextSubview }),
    [updateSearch],
  );

  const load = async (path = project, draft?: Manifest) => {
    if (!path) return;
    const requestId = ++workspaceOpenRequest.current;
    const targetWorkspaceId = selectedWorkspace?.id;
    const isCurrentRequest = () =>
      requestId === workspaceOpenRequest.current &&
      useWorkspaceStore.getState().project === path &&
      useWorkspaceStore.getState().selectedWorkspace?.id === targetWorkspaceId;
    setBusy(true);
    setMessage("");
    await withAsyncCleanup(
      async () => {
        try {
          const [nextScan, nextManifest, nextRuntime] = await Promise.all([
            api.scan(path),
            api.manifest(path),
            api.runtime(),
          ]);
          if (!isCurrentRequest()) return;
          setProject(path);
          setScan(nextScan);
          setManifest(draft ?? nextManifest);
          setBaselineManifest(JSON.stringify(nextManifest));
          useAppStore.getState().setRuntime(nextRuntime);
        } catch (error) {
          if (isCurrentRequest()) setMessage(localizeMessage(error));
        }
      },
      () => {
        if (isCurrentRequest()) setBusy(false);
      },
    );
  };

  const loadGlobal = async () => {
    await queryClient.invalidateQueries({ queryKey: homeKeys.all });
  };

  const refreshDiscovery = async () => {
    setMessage("");
    try {
      await api.requestRefresh("discovery", true);
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const requestRefreshKinds = async (kinds: RefreshKind[]) => {
    setMessage("");
    try {
      await Promise.all(kinds.map((kind) => api.requestRefresh(kind, true)));
    } catch (error) {
      setMessage(localizeMessage(error));
    }
  };

  const hasUnsavedDraft = Boolean(
    manifest && baselineManifest && JSON.stringify(manifest) !== baselineManifest,
  );
  const persistWorkspaceDraft = useCallback(() => {
    if (selectedWorkspace && manifest && hasUnsavedDraft)
      setWorkspaceDrafts((drafts) => ({ ...drafts, [selectedWorkspace.id]: manifest }));
  }, [hasUnsavedDraft, manifest, selectedWorkspace, setWorkspaceDrafts]);

  const ensureWorkspaceChangeAllowed = useCallback(async () => {
    if (!useWorkspaceStore.getState().applyingChanges) return true;
    await dialogs.notify(tr("dialog.quit.changesApplying"));
    return false;
  }, [dialogs, tr]);

  const leaveWorkspace = async (next: () => void, clearRouteSearch = true): Promise<boolean> => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return false;
    }
    if (
      hasUnsavedDraft &&
      !(await dialogs.confirm({
        description: tr("workspace.leaveDraftConfirm"),
        tone: "destructive",
      }))
    )
      return false;
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return false;
    }
    workspaceOpenRequest.current += 1;
    if (selectedWorkspace)
      setWorkspaceDrafts((drafts) => {
        const nextDrafts = { ...drafts };
        delete nextDrafts[selectedWorkspace.id];
        return nextDrafts;
      });
    if (clearRouteSearch) setGitSubview(undefined);
    setSelectedWorkspace(undefined);
    setProject("");
    setScan(undefined);
    setManifest(undefined);
    setChangeSet(undefined);
    setChangeSetOrigin("standard");
    setHandoffLaunchRequest(undefined);
    setBaselineManifest("");
    next();
    return true;
  };

  const prepareHistoryNavigation = async (target: AppHistoryEntry): Promise<boolean> => {
    if (useWorkspaceStore.getState().applyingChanges) {
      await dialogs.notify(tr("dialog.quit.changesApplying"));
      return false;
    }

    const targetRoute = parseRoute(target.pathname);
    if (selectedWorkspace && targetRoute.kind === "global") {
      return leaveWorkspace(() => undefined, false);
    }
    return true;
  };

  const openWorkspace = useCallback(
    async (workspace: WorkspaceSummary, initialPage: Page = "overview") => {
      if (!(await ensureWorkspaceChangeAllowed())) return;
      if (
        route.kind === "workspace" &&
        workspaceRouteId === workspace.id &&
        selectedWorkspace?.id === workspace.id &&
        project === workspace.path
      ) {
        if (workspaceRoutePage !== initialPage) navigateWorkspacePageFor(workspace.id, initialPage);
        return;
      }
      const requestId = ++workspaceOpenRequest.current;
      persistWorkspaceDraft();
      setMessage("");
      if (requestId !== workspaceOpenRequest.current) return;
      setGitSubview(undefined);
      setChangeSet(undefined);
      setChangeSetOrigin("standard");
      setHandoffLaunchRequest(undefined);
      setProject(workspace.path);
      setScan(undefined);
      setManifest(undefined);
      setBaselineManifest("");
      setSelectedWorkspace(workspace);
      navigateWorkspacePageFor(workspace.id, initialPage);
    },
    [
      ensureWorkspaceChangeAllowed,
      navigateWorkspacePageFor,
      persistWorkspaceDraft,
      project,
      route.kind,
      selectedWorkspace?.id,
      setBaselineManifest,
      setBusy,
      setChangeSet,
      setChangeSetOrigin,
      setGitSubview,
      setHandoffLaunchRequest,
      setManifest,
      setMessage,
      setProject,
      setScan,
      setSelectedWorkspace,
      workspaceDrafts,
      workspaceRouteId,
      workspaceRoutePage,
    ],
  );

  useEffect(() => {
    if (route.kind !== "workspace") {
      workspaceOpenRequest.current += 1;
      setBusy(false);
    }
  }, [route.kind, setBusy]);
  useEffect(() => {
    if (
      route.kind !== "workspace" ||
      selectedWorkspace?.id === workspaceRouteId ||
      workspacesPending ||
      !workspaceRouteId
    )
      return;
    const workspace = workspaces.find((item) => item.id === workspaceRouteId);
    if (workspace) void openWorkspace(workspace, workspaceRoutePage ?? "overview");
    else setMessage(tr("common.notFound"));
  }, [
    route.kind,
    workspaceRouteId,
    workspaceRoutePage,
    selectedWorkspace?.id,
    workspaces,
    openWorkspace,
    setMessage,
  ]);

  const navigateGlobalWithSearch = (nextPage: GlobalPage, patch: Partial<AppSearch> = {}) => {
    const path = nextPage === "home" ? "/" : `/${nextPage}`;
    void navigate({ to: path as never, search: (current) => ({ ...current, ...patch }) as never });
  };
  const navigateGlobal = (
    nextPage: GlobalPage,
    preserveQuotaSelection = false,
    searchPatch: Partial<AppSearch> = {},
  ) => {
    const next = () =>
      navigateGlobalWithSearch(
        nextPage,
        preserveQuotaSelection
          ? { quotaProvider, quotaWindow, ...searchPatch }
          : { quotaProvider: undefined, quotaWindow: undefined, ...searchPatch },
      );
    if (selectedWorkspace) void leaveWorkspace(next);
    else {
      workspaceOpenRequest.current += 1;
      next();
    }
  };
  const openSettings = (section: SettingsSection = "general") => {
    if (useWorkspaceStore.getState().applyingChanges) {
      void dialogs.notify(tr("dialog.quit.changesApplying"));
      return;
    }
    void navigate({
      to: "/settings",
      search: (current) =>
        ({ ...current, settingsSection: section, settingsTarget: undefined }) as never,
    });
  };

  useEffect(() => {
    if (!navigationRequest) return;
    if (navigationRequest.page === "settings") {
      openSettings(navigationRequest.settings_section ?? "general");
      setNavigationRequest(undefined);
      return;
    }
    if (navigationRequest.page === "quota") {
      navigateGlobal("quota", false, {
        quotaProvider: navigationRequest.provider,
        quotaWindow: navigationRequest.window,
      });
      if (navigationRequest.configure_popover) setQuotaConfigureRequest((value) => value + 1);
    } else {
      navigateGlobal(navigationRequest.page);
    }
    setNavigationRequest(undefined);
  }, [
    navigationRequest,
    dialogs,
    navigateGlobal,
    navigateGlobalWithSearch,
    navigate,
    openSettings,
    setNavigationRequest,
    setQuotaConfigureRequest,
  ]);

  const selectProject = async () => {
    if (!(await ensureWorkspaceChangeAllowed())) return;
    const selected = await api.pickDirectory(tr("dialog.addWorkspace"));
    if (typeof selected === "string") {
      if (!(await ensureWorkspaceChangeAllowed())) return;
      const workspace = await api.addWorkspace(selected);
      await loadGlobal();
      if (!(await ensureWorkspaceChangeAllowed())) return;
      await openWorkspace(workspace);
    }
  };

  const refreshCurrentView = async () => {
    if (appMode === "settings") {
      if (settingsSection === "discovery") await requestRefreshKinds(["discovery"]);
      else if (settingsSection === "tools") {
        setMessage("");
        try {
          await refreshAgentTools(queryClient);
        } catch (error) {
          setMessage(localizeMessage(error));
        }
      } else if (settingsSection === "integrations") await requestRefreshKinds(["gateways"]);
      else if (settingsSection === "diagnostics")
        await requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      else await loadGlobal();
      return;
    }
    if (route.kind === "workspace" && selectedWorkspace && project && manifest) {
      await load(project, manifest);
      return;
    }
    if (globalPage === "sessions") requestSessionRefresh();
    else if (globalPage === "quota") await requestRefreshKinds(["quota"]);
    else if (globalPage === "insights") await requestRefreshKinds(["insights"]);
    else await requestRefreshKinds(["discovery"]);
  };

  async function addScanRootFromDialog() {
    const selected = await api.pickDirectory(tr("dialog.addScanRoot"));
    if (typeof selected === "string") {
      await api.addScanRoot(selected, 5);
      await loadGlobal();
      await refreshDiscovery();
    }
  }

  useEffect(() => {
    if (!menuCommand) return;
    setMenuCommand(undefined);
    if (menuCommand.command === "add-workspace") void selectProject();
    else if (menuCommand.command === "add-scan-root") void addScanRootFromDialog();
    else if (menuCommand.command === "refresh-current") void refreshCurrentView();
    else if (menuCommand.command === "refresh-all")
      void dialogs.confirm(tr("menu.refreshAllConfirm")).then((confirmed) => {
        if (confirmed) void requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      });
  }, [
    dialogs,
    menuCommand,
    addScanRootFromDialog,
    refreshCurrentView,
    requestRefreshKinds,
    selectProject,
    setMenuCommand,
  ]);

  return {
    route,
    appMode,
    globalPage,
    message,
    refreshJobs,
    navigation: createGlobalNavigation(
      globalMemories.filter((item) => item.status === "pending").length,
    ),
    workspaces,
    openWorkspace,
    navigateGlobal,
    openSettings,
    prepareHistoryNavigation,
    refreshCurrentView,
    addWorkspace: selectProject,
    addScanRoot: addScanRootFromDialog,
  };
}
