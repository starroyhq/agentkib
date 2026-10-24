import { useI18n } from "@/core/useI18n";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { useAppDialogs } from "@/components/AppDialogProvider";
import { api } from "@/core/api";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import {
  preparedManifestBaseline,
  resolveRefreshedManifest,
} from "@/features/workspace/manifest-draft";
import type { Manifest, RefreshKind, WorkspaceSummary } from "@/core/types";
import type { SettingsSection, SettingsTarget } from "@/features/settings/SettingsSidebar";
import { refreshAgentTools } from "@/features/settings/agent-tools-query";
import { requestSessionRefresh } from "@/features/sessions/session-refresh";
import { withAsyncCleanup } from "@/lib/utils";
import { createGlobalNavigation } from "./global-navigation";
import { useWorkspaceTransitions } from "./useWorkspaceTransitions";
import { usePageMessageScope } from "./usePageMessageScope";
import {
  parseHistoryRoute,
  type AppSearch,
  type GlobalPage,
  type Page,
  type ParsedRoute,
} from "./app-route";
import type { AppHistoryEntry } from "./useAppHistory";
import {
  homeKeys,
  useOptionalQueryClient,
  useHomeMemories,
  useHomeRefreshJobs,
  useHomeWorkspaces,
} from "@/features/home/home-query";

const EMPTY_WORKSPACES: WorkspaceSummary[] = [];

export type { AppSearch, GlobalPage, Page, ParsedRoute } from "./app-route";

export function useAppNavigation(activeRoute?: ParsedRoute) {
  const { localizeMessage, tr } = useI18n();
  const dialogs = useAppDialogs();
  const navigate = useNavigate();
  const location = useLocation();
  usePageMessageScope(location.href ?? location.pathname);
  const search = useSearch({ strict: false }) as AppSearch;
  // Route layouts pass the active identity from TanStack matches. The fallback
  // keeps the hook usable in isolated tests and non-route utility surfaces.
  const route = activeRoute ?? parseHistoryRoute(location.pathname);
  const workspaceRouteId = route.kind === "workspace" ? route.workspaceId : undefined;
  const workspaceRoutePage = route.kind === "workspace" ? route.page : undefined;
  const routeGlobalPage = route.kind === "global" ? route.page : "home";
  const globalPage = routeGlobalPage;
  const appMode = route.kind === "settings" ? "settings" : "main";
  const queryClient = useOptionalQueryClient();
  const {
    data: workspaces = EMPTY_WORKSPACES,
    isPending: workspacesPending,
    error: workspaceLoadError,
    dataUpdatedAt: workspacesDataAt,
    errorUpdatedAt: workspacesErrorAt,
  } = useHomeWorkspaces();
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
    setScan,
    manifest,
    setManifest,
    setBaselineManifest,
    message,
    setMessage,
    setBusy,
    setAppliedChanges,
  } = workspaceStore;
  const workspaceOpenRequest = useRef(0);
  const pendingWorkspaceNavigation = useRef<
    { workspaceId: string; messageRevision: number; notice?: string } | undefined
  >(undefined);
  const completedWorkspaceNavigation = useRef<{ message?: string; revision: number } | undefined>(
    undefined,
  );
  const restoringWorkspaceNotice = useRef<string | undefined>(undefined);
  const [workspaceNavigationRevision, setWorkspaceNavigationRevision] = useState(0);
  useEffect(
    () => () => {
      pendingWorkspaceNavigation.current = undefined;
      completedWorkspaceNavigation.current = undefined;
      restoringWorkspaceNotice.current = undefined;
    },
    [],
  );
  const missingWorkspaceNotice = useRef<
    | {
        path: string;
        message: string;
        dataAt: number;
        errorAt: number;
      }
    | undefined
  >(undefined);
  const navigationLocations = useRef(
    new Map<GlobalPage | "settings", { route: ParsedRoute; search: AppSearch }>(),
  );
  useLayoutEffect(() => {
    const currentRoute = route;
    const key =
      currentRoute.kind === "workspace"
        ? "workspaces"
        : currentRoute.kind === "settings"
          ? "settings"
          : currentRoute.page;
    navigationLocations.current.set(key, { route: currentRoute, search: { ...search } });
  }, [location.href, location.pathname, search, route]);

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
    (workspaceId: string, nextPage: Page, routeSearch?: AppSearch) => {
      const path =
        nextPage === "overview" ? "/workspace/$workspaceId" : `/workspace/$workspaceId/${nextPage}`;
      // Workspace selection changes before the router finishes. Keep that
      // explicit intent from being restored to the still-rendered old route.
      const intent = {
        workspaceId,
        messageRevision: useWorkspaceStore.getState().messageRevision,
        notice: restoringWorkspaceNotice.current,
      };
      restoringWorkspaceNotice.current = undefined;
      pendingWorkspaceNavigation.current = intent;
      completedWorkspaceNavigation.current = undefined;
      const finish = (failure?: { error: unknown }) => {
        if (pendingWorkspaceNavigation.current !== intent) return;
        pendingWorkspaceNavigation.current = undefined;
        const current = useWorkspaceStore.getState();
        completedWorkspaceNavigation.current = {
          revision: current.messageRevision,
          message:
            current.messageRevision !== intent.messageRevision && current.message
              ? current.messageDismissed
                ? undefined
                : current.message
              : failure
                ? localizeMessage(failure.error)
                : intent.notice,
        };
        // Cancelled/failed navigation may leave the URL unchanged. Reconcile it
        // again even when no router update will trigger the restoration effect.
        setWorkspaceNavigationRevision((revision) => revision + 1);
      };
      try {
        void Promise.resolve(
          navigate({
            to: path as never,
            params: { workspaceId } as never,
            search: (routeSearch ?? {}) as never,
          }),
        ).then(
          () => finish(),
          (error) => finish({ error }),
        );
      } catch (error) {
        finish({ error });
        throw error;
      }
    },
    [navigate, localizeMessage],
  );
  const setGitSubview = useCallback(
    (nextSubview: import("@/features/workspace/WorkspaceGitPage").GitSubview | undefined) =>
      updateSearch({ gitSubview: nextSubview }),
    [updateSearch],
  );
  const clearGitSubview = useCallback(() => setGitSubview(undefined), [setGitSubview]);
  const invalidatePendingLoad = useCallback(() => {
    workspaceOpenRequest.current += 1;
  }, []);
  const { ensureWorkspaceChangeAllowed, leaveWorkspace, openWorkspace } = useWorkspaceTransitions({
    route,
    navigateWorkspacePageFor,
    clearGitSubview,
    invalidatePendingLoad,
  });

  const load = async (path = project, draft?: Manifest) => {
    if (!path || useWorkspaceStore.getState().applyingChanges || useWorkspaceStore.getState().busy)
      return;
    const requestId = ++workspaceOpenRequest.current;
    const targetWorkspaceId = selectedWorkspace?.id;
    const initialState = useWorkspaceStore.getState();
    const initialBaseline =
      initialState.baselineManifest ||
      (targetWorkspaceId && initialState.workspaceDraftBaselines[targetWorkspaceId]) ||
      "";
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
          let conflictRetained = false;
          const resolvedManifest = await resolveRefreshedManifest({
            initialManifest: initialState.manifest,
            initialBaseline,
            acknowledgedDisk: targetWorkspaceId
              ? initialState.workspaceDraftDisks[targetWorkspaceId]
              : undefined,
            cachedDraft:
              draft ??
              (targetWorkspaceId ? initialState.workspaceDrafts[targetWorkspaceId] : undefined),
            diskManifest: nextManifest,
            diskIsDefault: !nextScan.manifest_exists,
            onConflictRetained: () => {
              conflictRetained = true;
            },
            getCurrentManifest: () => useWorkspaceStore.getState().manifest,
            confirmDiskVersion: () =>
              dialogs.confirm({
                title: tr("workspace.refreshConflictTitle"),
                description: tr("workspace.refreshConflict"),
                confirmLabel: tr("workspace.refreshLoadDisk"),
                cancelLabel: tr("workspace.refreshKeepDraft"),
                tone: "warning",
              }),
          });
          if (!isCurrentRequest()) return;
          setProject(path);
          setScan(nextScan);
          setManifest(resolvedManifest);
          const nextBaseline = nextManifest
            ? conflictRetained
              ? preparedManifestBaseline(initialBaseline, nextManifest, !nextScan.manifest_exists)
              : JSON.stringify(nextManifest)
            : initialBaseline;
          setBaselineManifest(nextBaseline);
          if (targetWorkspaceId)
            useWorkspaceStore
              .getState()
              .cacheWorkspaceDraft(
                targetWorkspaceId,
                resolvedManifest,
                nextBaseline,
                JSON.stringify(nextManifest),
              );
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
  const retryWorkspaces = async () => {
    await queryClient.invalidateQueries({ queryKey: homeKeys.workspaces() });
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

  const prepareHistoryNavigation = async (target: AppHistoryEntry): Promise<boolean> => {
    if (!(await ensureWorkspaceChangeAllowed())) return false;

    const targetRoute = parseHistoryRoute(target.pathname);
    if (selectedWorkspace && targetRoute.kind === "global") {
      return leaveWorkspace(() => undefined, false);
    }
    return true;
  };

  useEffect(() => {
    if (route.kind !== "workspace") {
      missingWorkspaceNotice.current = undefined;
      workspaceOpenRequest.current += 1;
      setBusy(false);
      setAppliedChanges(undefined);
    }
  }, [route.kind, setBusy, setAppliedChanges]);
  useEffect(() => {
    // The URL updates before the committed route matches during navigation.
    // Do not restore the previous workspace while its matches are still rendered.
    const locationRoute = parseHistoryRoute(location.pathname);
    const pendingIntent = pendingWorkspaceNavigation.current;
    const current = useWorkspaceStore.getState();
    if (pendingIntent && current.selectedWorkspace?.id === pendingIntent.workspaceId) return;
    let completion = completedWorkspaceNavigation.current;
    if (completion && completion.revision !== current.messageRevision) {
      completion = {
        revision: current.messageRevision,
        message: current.message
          ? current.messageDismissed
            ? undefined
            : current.message
          : completion.message,
      };
      completedWorkspaceNavigation.current = completion;
    }
    const publishCompletion = () => {
      if (!completion || completedWorkspaceNavigation.current !== completion || current.busy)
        return;
      completedWorkspaceNavigation.current = undefined;
      const latest = useWorkspaceStore.getState();
      if (
        completion.message &&
        latest.messageRevision === completion.revision &&
        latest.message !== completion.message
      )
        latest.setMessage(completion.message);
    };
    const carryCompletion = () => {
      if (!completion || completedWorkspaceNavigation.current !== completion) return;
      completedWorkspaceNavigation.current = undefined;
      const latest = useWorkspaceStore.getState();
      // openWorkspace clears the previous notice once before beforeNavigate.
      // Do not overwrite any message published after this recovery started.
      if (latest.messageRevision === completion.revision + 1 && !latest.message)
        restoringWorkspaceNotice.current = completion.message;
    };
    if (route.kind !== "workspace") {
      publishCompletion();
      return;
    }
    if (locationRoute.kind !== "workspace" || locationRoute.workspaceId !== workspaceRouteId)
      return;
    if (selectedWorkspace?.id === workspaceRouteId) {
      publishCompletion();
      return;
    }
    if (workspacesPending || !workspaceRouteId) return;
    const workspace = workspaces.find((item) => item.id === workspaceRouteId);
    if (workspace) {
      missingWorkspaceNotice.current = undefined;
      // Route-loader failures already use AppErrorFallback. Pre-commit navigate
      // rejections may bypass it, so report them through the existing notice only
      // after selection is aligned; cancellation and old intents publish nothing.
      void openWorkspace(workspace, workspaceRoutePage ?? "overview", search, carryCompletion);
    } else {
      completedWorkspaceNavigation.current = undefined;
      const nextMessage = workspaceLoadError
        ? localizeMessage(workspaceLoadError)
        : tr("common.notFound");
      const previous = missingWorkspaceNotice.current;
      // Closing a notice must not immediately reopen it, but another workspace
      // or a completed retry is a new result, including when its text is identical.
      if (
        previous?.path !== (location.href ?? location.pathname) ||
        previous.message !== nextMessage ||
        previous.dataAt !== workspacesDataAt ||
        previous.errorAt !== workspacesErrorAt
      ) {
        missingWorkspaceNotice.current = {
          path: location.href ?? location.pathname,
          message: nextMessage,
          dataAt: workspacesDataAt,
          errorAt: workspacesErrorAt,
        };
        setMessage(nextMessage);
      }
    }
  }, [
    route.kind,
    location.href,
    location.pathname,
    workspaceNavigationRevision,
    workspaceStore.busy,
    workspaceRouteId,
    workspaceRoutePage,
    search,
    selectedWorkspace?.id,
    workspaces,
    workspacesPending,
    workspaceLoadError,
    workspacesDataAt,
    workspacesErrorAt,
    openWorkspace,
    localizeMessage,
    tr,
    setMessage,
  ]);

  const navigateGlobalWithSearch = (nextPage: GlobalPage, patch: Partial<AppSearch> = {}) => {
    const path = nextPage === "home" ? "/" : `/${nextPage}`;
    void navigate({
      to: path as never,
      search: { ...navigationLocations.current.get(nextPage)?.search, ...patch } as never,
    });
  };
  const navigateGlobal = (
    nextPage: GlobalPage,
    preserveQuotaSelection = false,
    searchPatch: Partial<AppSearch> = {},
  ) => {
    const saved = navigationLocations.current.get(nextPage);
    // 从别处点"工作区"时回到上次打开的工作区；已经在工作区里再点一次则回到列表，
    // 否则列表页永远到不了。
    if (
      nextPage === "workspaces" &&
      route.kind !== "workspace" &&
      saved?.route.kind === "workspace" &&
      Object.keys(searchPatch).length === 0
    ) {
      const workspaceId = saved.route.workspaceId;
      const workspace = workspaces.find((item) => item.id === workspaceId);
      if (workspace) {
        // Execution continuations belong to their original workflow, not navigation memory.
        const {
          handoffSession: _session,
          handoffTarget: _target,
          handoffBudget: _budget,
          handoffFormat: _format,
          handoffPreCompaction: _preCompaction,
          handoffResume: _resume,
          ...restoredSearch
        } = saved.search;
        void openWorkspace(
          workspace,
          saved.route.page === "changes" && !useWorkspaceStore.getState().changeSet
            ? "overview"
            : saved.route.page,
          restoredSearch,
        );
        return;
      }
    }
    const next = () =>
      navigateGlobalWithSearch(
        nextPage,
        preserveQuotaSelection ? { quotaProvider, quotaWindow, ...searchPatch } : searchPatch,
      );
    if (selectedWorkspace) void leaveWorkspace(next, false);
    else {
      workspaceOpenRequest.current += 1;
      next();
    }
  };
  const openSettings = (section?: SettingsSection, target?: SettingsTarget) => {
    if (useWorkspaceStore.getState().applyingChanges) {
      void dialogs.notify(tr("workspace.changesApplying"));
      return false;
    }
    void navigate({
      to: "/settings",
      search: (current) =>
        ({
          ...current,
          ...navigationLocations.current.get("settings")?.search,
          settingsSection:
            section ??
            navigationLocations.current.get("settings")?.search.settingsSection ??
            "general",
          settingsTarget: target,
        }) as never,
    });
    return true;
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
      } else if (settingsSection === "integrations") {
        if (search.settingsTarget === "integrations-agents") {
          await requestRefreshKinds(["discovery", "insights", "gateways"]);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: homeKeys.installations() }),
            queryClient.invalidateQueries({ queryKey: homeKeys.catalog() }),
          ]);
        } else await requestRefreshKinds(["gateways"]);
      } else if (settingsSection === "diagnostics")
        await requestRefreshKinds(["discovery", "insights", "gateways", "quota"]);
      else await loadGlobal();
      return;
    }
    if (route.kind === "workspace" && selectedWorkspace && project && manifest) {
      if (!(await ensureWorkspaceChangeAllowed())) return;
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
    workspacesPending,
    workspacesError: workspaceLoadError ? localizeMessage(workspaceLoadError) : undefined,
    retryWorkspaces,
    openWorkspace,
    navigateGlobal,
    openSettings,
    prepareHistoryNavigation,
    refreshCurrentView,
    addWorkspace: selectProject,
    addScanRoot: addScanRootFromDialog,
  };
}
