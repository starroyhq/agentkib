// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { api } from "@/core/api";
import { useAppStore } from "@/stores/app-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import type {
  ChangeSet,
  Manifest,
  RuntimeInfo,
  SessionHandoffLaunchRequest,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";
import { useAppNavigation } from "./useAppNavigation";
import type { AppHistoryEntry } from "./useAppHistory";
import { SESSION_REFRESH_EVENT } from "@/features/sessions/session-refresh";

const testDoubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  notify: vi.fn().mockResolvedValue(undefined),
  confirm: vi.fn().mockResolvedValue(false),
  requestSecrets: vi.fn(),
  open: vi.fn(),
  agentTools: vi.fn(),
  requestRefresh: vi.fn(),
  workspaces: vi.fn(),
  location: { pathname: "/" },
  search: {} as Record<string, string>,
}));

const homeHistoryEntry: AppHistoryEntry = {
  key: "home",
  href: "/",
  pathname: "/",
  search: "",
  hash: "",
  browserIndex: 0,
};

vi.mock("@tanstack/react-router", () => ({
  useLocation: () => testDoubles.location,
  useNavigate: () => testDoubles.navigate,
  useSearch: () => testDoubles.search,
}));

vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({
    notify: testDoubles.notify,
    confirm: testDoubles.confirm,
    requestSecrets: testDoubles.requestSecrets,
  }),
}));

describe("useAppNavigation guards", () => {
  beforeAll(async () => initializeI18n("en-US"));

  beforeEach(() => {
    Object.defineProperty(window, "agentkibDesktop", {
      configurable: true,
      value: {
        shell: { openDirectory: testDoubles.open },
        home: {
          agentTools: testDoubles.agentTools,
          refreshDiscovery: testDoubles.requestRefresh,
          workspaces: testDoubles.workspaces,
        },
      },
    });
    useAppStore.getState().reset();
    useWorkspaceStore.getState().resetWorkspace();
    testDoubles.navigate.mockReset();
    testDoubles.notify.mockReset().mockResolvedValue(undefined);
    testDoubles.confirm.mockReset().mockResolvedValue(false);
    testDoubles.open.mockReset();
    testDoubles.agentTools.mockReset();
    testDoubles.requestRefresh.mockReset().mockResolvedValue(undefined);
    testDoubles.workspaces.mockReset().mockResolvedValue([]);
    testDoubles.location.pathname = "/";
    testDoubles.search = {};
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    await initializeI18n("en-US");
  });

  it("refreshes Agent discovery, capabilities, configurations and provider status in settings", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const refresh = vi.spyOn(api, "requestRefresh").mockResolvedValue({
      kind: "discovery",
      disposition: "queued",
      request_id: "refresh",
      status: { kind: "discovery", state: "queued" },
    });
    testDoubles.location.pathname = "/settings";
    testDoubles.search = {
      settingsSection: "integrations",
      settingsTarget: "integrations-agents",
      agent: "codex",
    };
    const { result } = renderHook(() => useAppNavigation(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    await act(async () => result.current.refreshCurrentView());
    expect(refresh.mock.calls.map(([kind]) => kind)).toEqual(["discovery", "insights", "gateways"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["home", "installations"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["home", "catalog"] });
    queryClient.clear();
  });

  it("routes session refresh to the mounted hub instead of starting discovery", async () => {
    testDoubles.location.pathname = "/sessions";
    const listener = vi.fn();
    window.addEventListener(SESSION_REFRESH_EVENT, listener);
    try {
      const { result } = renderHook(() => useAppNavigation());
      await act(async () => result.current.refreshCurrentView());
      expect(listener).toHaveBeenCalledOnce();
      expect(testDoubles.requestRefresh).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SESSION_REFRESH_EVENT, listener);
    }
  });

  it("retires an old global notice when entering settings without clearing its failure state", () => {
    const { rerender } = renderHook(() => useAppNavigation());
    act(() => useWorkspaceStore.getState().setMessage("previous page failed"));
    expect(useWorkspaceStore.getState().messageDismissed).toBe(false);
    testDoubles.location.pathname = "/settings";
    rerender();
    expect(useWorkspaceStore.getState()).toMatchObject({
      message: "previous page failed",
      messageDismissed: true,
    });
    testDoubles.location.pathname = "/catalog";
    rerender();
    expect(useWorkspaceStore.getState().messageDismissed).toBe(true);
  });

  it.each(["previous page failed", "destination failed"])(
    "keeps a new destination notice with text %s during navigation",
    (message) => {
      const { rerender } = renderHook(() => useAppNavigation());
      act(() => useWorkspaceStore.getState().setMessage("previous page failed"));
      testDoubles.location.pathname = "/settings";
      act(() => {
        useWorkspaceStore.getState().setMessage(message);
        rerender();
      });
      expect(useWorkspaceStore.getState()).toMatchObject({ message, messageDismissed: false });
    },
  );

  it("does not loop while resolving a direct workspace route after discovery fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    testDoubles.location.pathname = "/workspace/missing-workspace";
    testDoubles.workspaces.mockRejectedValueOnce(new Error("workspace discovery unavailable"));

    renderHook(() => useAppNavigation(), { wrapper });

    await waitFor(() => {
      expect(useWorkspaceStore.getState().message).toContain("workspace discovery unavailable");
    });
    expect(testDoubles.workspaces).toHaveBeenCalledOnce();
    queryClient.clear();
  });

  it("publishes a fresh missing-workspace notice for another destination and a completed retry", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    testDoubles.location.pathname = "/workspace/missing-a";
    const { result, rerender } = renderHook(() => useAppNavigation(), { wrapper });
    await waitFor(() => expect(useWorkspaceStore.getState().message).toBe("Not found"));
    const first = useWorkspaceStore.getState().messageRevision;
    act(() => useWorkspaceStore.getState().dismissMessage(first));
    rerender();
    expect(useWorkspaceStore.getState()).toMatchObject({
      messageRevision: first,
      messageDismissed: true,
    });
    testDoubles.location.pathname = "/workspace/missing-b";
    rerender();
    await waitFor(() =>
      expect(useWorkspaceStore.getState().messageRevision).toBeGreaterThan(first),
    );
    expect(useWorkspaceStore.getState()).toMatchObject({
      message: "Not found",
      messageDismissed: false,
    });
    const second = useWorkspaceStore.getState().messageRevision;
    act(() => useWorkspaceStore.getState().dismissMessage(second));
    await act(async () => result.current.retryWorkspaces());
    await waitFor(() =>
      expect(useWorkspaceStore.getState().messageRevision).toBeGreaterThan(second),
    );
    expect(useWorkspaceStore.getState().messageDismissed).toBe(false);
    testDoubles.location.pathname = "/settings";
    rerender();
    expect(useWorkspaceStore.getState().messageDismissed).toBe(true);
    testDoubles.location.pathname = "/workspace/missing-b";
    rerender();
    expect(useWorkspaceStore.getState().messageDismissed).toBe(false);
    queryClient.clear();
  });

  it("opens settings without discarding the current workspace draft", () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const draft = {} as Manifest;
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      workspaceDrafts: { [workspace.id]: draft },
    });

    const { result } = renderHook(() => useAppNavigation());

    act(() => result.current.openSettings());

    expect(testDoubles.navigate).toHaveBeenCalledOnce();
    expect(testDoubles.navigate.mock.calls[0][0].to).toBe("/settings");
    expect(testDoubles.navigate.mock.calls[0][0].search({})).toEqual({
      settingsSection: "general",
    });
    expect(useWorkspaceStore.getState().selectedWorkspace?.id).toBe(workspace.id);
    expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(draft);
    expect(testDoubles.notify).not.toHaveBeenCalled();
  });

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "clears applied feedback after visiting settings and returning without discarding the draft in %s",
    async (locale) => {
      await initializeI18n(locale);
      const workspace: WorkspaceSummary = {
        id: "workspace-1",
        path: "/workspace",
        name: "Workspace",
        status: "healthy",
        asset_count: 0,
        warning_count: 0,
        sources: [],
      };
      const draft = { instructions: { shared: "Unsaved draft" } } as Manifest;
      const plan: ChangeSet = {
        id: "reviewed-plan",
        project_root: workspace.path,
        created_at: "",
        changes: [],
        requires_home_approval: false,
      };
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        project: workspace.path,
        manifest: draft,
        baselineManifest: "saved-manifest",
        workspaceDrafts: { [workspace.id]: draft },
        changeSet: plan,
        appliedChanges: {
          workspaceId: workspace.id,
          project: workspace.path,
          changeSet: { ...plan, id: "previously-applied" },
          applied: ["AGENTS.md"],
          backupDir: "",
        },
      });
      testDoubles.location.pathname = "/workspace/workspace-1/assets";
      const { result, rerender } = renderHook(() => useAppNavigation());
      expect(useWorkspaceStore.getState().appliedChanges).toBeDefined();
      act(() => result.current.openSettings("diagnostics"));
      expect(testDoubles.navigate.mock.calls.at(-1)?.[0].to).toBe("/settings");
      testDoubles.location.pathname = "/settings";
      rerender();
      expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
      expect(useWorkspaceStore.getState().manifest).toBe(draft);
      expect(useWorkspaceStore.getState().workspaceDrafts[workspace.id]).toBe(draft);
      expect(useWorkspaceStore.getState().changeSet).toBe(plan);
      await act(async () => {
        expect(await result.current.openWorkspace(workspace, "assets")).toBe(true);
      });
      testDoubles.location.pathname = "/workspace/workspace-1/assets";
      rerender();
      expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
      expect(useWorkspaceStore.getState().manifest).toBe(draft);
      expect(testDoubles.confirm).not.toHaveBeenCalled();
    },
  );
  it.each(["/catalog", "/sessions"])(
    "clears applied feedback for a direct transition to %s while retaining workspace data",
    (target) => {
      const applied = {
        workspaceId: "workspace-1",
        project: "/workspace",
        changeSet: {
          id: "applied",
          project_root: "/workspace",
          created_at: "",
          changes: [],
          requires_home_approval: false,
        },
        applied: ["AGENTS.md"],
        backupDir: "",
      };
      useWorkspaceStore.setState({ project: "/workspace", appliedChanges: applied });
      testDoubles.location.pathname = "/workspace/workspace-1/changes";
      const { rerender } = renderHook(() => useAppNavigation());
      expect(useWorkspaceStore.getState().appliedChanges).toBe(applied);
      testDoubles.location.pathname = target;
      rerender();
      expect(useWorkspaceStore.getState().appliedChanges).toBeUndefined();
      expect(useWorkspaceStore.getState().project).toBe("/workspace");
    },
  );
  it("retains applied feedback while moving between pages within the same workspace", () => {
    const applied = {
      workspaceId: "workspace-1",
      project: "/workspace",
      changeSet: {
        id: "applied",
        project_root: "/workspace",
        created_at: "",
        changes: [],
        requires_home_approval: false,
      },
      applied: ["AGENTS.md"],
      backupDir: "",
    };
    useWorkspaceStore.setState({ appliedChanges: applied });
    testDoubles.location.pathname = "/workspace/workspace-1/changes";
    const { rerender } = renderHook(() => useAppNavigation());
    testDoubles.location.pathname = "/workspace/workspace-1/sessions";
    rerender();
    expect(useWorkspaceStore.getState().appliedChanges).toBe(applied);
  });
  it("uses the same guarded settings action for native navigation requests", () => {
    useAppStore.setState({
      navigationRequest: { page: "settings", settings_section: "privacy" },
    });

    renderHook(() => useAppNavigation());

    expect(testDoubles.navigate).toHaveBeenCalledOnce();
    expect(testDoubles.navigate.mock.calls[0][0].search({})).toEqual({
      settingsSection: "privacy",
    });
    expect(useAppStore.getState().navigationRequest).toBeUndefined();
  });

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "blocks settings navigation with an operation warning in %s",
    async (locale) => {
      await initializeI18n(locale);
      useWorkspaceStore.setState({ applyingChanges: true });
      const { result } = renderHook(() => useAppNavigation());
      act(() => expect(result.current.openSettings("diagnostics")).toBe(false));
      expect(testDoubles.navigate).not.toHaveBeenCalled();
      expect(testDoubles.notify).toHaveBeenCalledExactlyOnceWith(tr("workspace.changesApplying"));
      expect(testDoubles.notify).not.toHaveBeenCalledWith(tr("dialog.quit.changesApplying"));
    },
  );

  it("opens the MCP integration anchor through guarded settings navigation", () => {
    const { result } = renderHook(() => useAppNavigation());
    act(() => result.current.openSettings("integrations", "integrations-mcp"));
    expect(testDoubles.navigate).toHaveBeenCalledOnce();
    expect(
      testDoubles.navigate.mock.calls[0][0].search({ settingsTarget: "diagnostics-activity" }),
    ).toMatchObject({
      settingsSection: "integrations",
      settingsTarget: "integrations-mcp",
    });
  });

  it("keeps the integration shortcut blocked while a change plan is applying", () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    const { result } = renderHook(() => useAppNavigation());
    act(() => expect(result.current.openSettings("integrations", "integrations-mcp")).toBe(false));
    expect(testDoubles.navigate).not.toHaveBeenCalled();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it.each(["toolbar", "menu"] as const)(
    "blocks a workspace refresh from the %s while a handoff is applying",
    async (entry) => {
      const workspace: WorkspaceSummary = {
        id: "workspace-1",
        path: "/workspace",
        name: "Workspace",
        status: "healthy",
        asset_count: 0,
        warning_count: 0,
        sources: [],
      };
      const manifest = {} as Manifest;
      const changeSet: ChangeSet = {
        id: "native-import-plan",
        project_root: workspace.path,
        created_at: "2026-10-16T00:00:00Z",
        requires_home_approval: false,
        changes: [],
      };
      const launchRequest: SessionHandoffLaunchRequest = {
        mode: "native-import",
        operation_id: "native-import-operation",
        workspace_id: workspace.id,
        target_agent: "codex",
        plan_hash: "plan-hash",
      };
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        project: workspace.path,
        manifest,
        baselineManifest: JSON.stringify(manifest),
        changeSet,
        handoffLaunchRequest: launchRequest,
        applyingChanges: true,
      });
      testDoubles.location.pathname = "/workspace/workspace-1/changes";
      const scan = vi.spyOn(api, "scan");
      const loadManifest = vi.spyOn(api, "manifest");
      const runtime = vi.spyOn(api, "runtime");
      if (entry === "menu") useAppStore.getState().setMenuCommand({ command: "refresh-current" });
      const { result } = renderHook(() => useAppNavigation());

      if (entry === "toolbar") await act(async () => result.current.refreshCurrentView());
      else await waitFor(() => expect(testDoubles.notify).toHaveBeenCalledOnce());

      expect(scan).not.toHaveBeenCalled();
      expect(loadManifest).not.toHaveBeenCalled();
      expect(runtime).not.toHaveBeenCalled();
      expect(testDoubles.notify).toHaveBeenCalledOnce();
      const current = useWorkspaceStore.getState();
      expect(current.busy).toBe(false);
      expect(current.applyingChanges).toBe(true);
      expect(current.manifest).toBe(manifest);
      expect(current.changeSet).toBe(changeSet);
      expect(current.handoffLaunchRequest).toBe(launchRequest);
    },
  );

  it("rechecks the applying lock immediately before starting a workspace reload", async () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const manifest = {} as Manifest;
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest,
    });
    testDoubles.location.pathname = "/workspace/workspace-1/changes";
    const scan = vi.spyOn(api, "scan");
    const loadManifest = vi.spyOn(api, "manifest");
    const runtime = vi.spyOn(api, "runtime");
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => {
      const refreshing = result.current.refreshCurrentView();
      useWorkspaceStore.getState().setApplyingChanges(true);
      await refreshing;
    });

    expect(scan).not.toHaveBeenCalled();
    expect(loadManifest).not.toHaveBeenCalled();
    expect(runtime).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().busy).toBe(false);
    expect(useWorkspaceStore.getState().manifest).toBe(manifest);
  });

  it("blocks adding a workspace before opening the directory picker", async () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.addWorkspace());

    expect(testDoubles.open).not.toHaveBeenCalled();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it.each([
    ["during the disk read", "newer draft"],
    ["during the disk read", "baseline"],
    ["before the disk read starts", "newer draft"],
    ["before the disk read starts", "baseline"],
  ])("retains edits made %s, including %s, on a global workspace refresh", async (timing, text) => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const baseline: Manifest = {
      schema_version: 2,
      workspace: { id: workspace.id, name: workspace.name },
      instructions: { shared: "baseline", scoped: [], platform_overrides: {} },
      skills: [],
      connections: [],
      adapters: {},
      mcp: { config: "mcp.json" },
      memories: { require_approval: true },
    };
    const draft = {
      ...baseline,
      instructions: { ...baseline.instructions, shared: "original draft" },
    };
    const disk = {
      ...baseline,
      instructions: { ...baseline.instructions, shared: "new disk content" },
    };
    const scan: WorkspaceScan = {
      root: workspace.path,
      manifest_exists: true,
      agents: [],
      assets: [],
      warnings: [],
    };
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      scan,
      manifest: draft,
      baselineManifest: JSON.stringify(baseline),
    });
    testDoubles.location.pathname = "/workspace/workspace-1/assets";
    let finish!: (value: WorkspaceScan) => void;
    const pending = new Promise<WorkspaceScan>((resolve) => {
      finish = resolve;
    });
    const scanRequest = vi.spyOn(api, "scan").mockReturnValue(pending);
    vi.spyOn(api, "manifest").mockResolvedValue(disk);
    vi.spyOn(api, "runtime").mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
    const { result } = renderHook(() => useAppNavigation());
    const newer = { ...draft, instructions: { ...draft.instructions, shared: text } };
    let refreshing!: Promise<void>;
    await act(async () => {
      refreshing = result.current.refreshCurrentView();
      if (timing === "before the disk read starts") useWorkspaceStore.getState().setManifest(newer);
    });
    await waitFor(() => expect(scanRequest).toHaveBeenCalledOnce());
    if (timing === "during the disk read")
      act(() => useWorkspaceStore.getState().setManifest(newer));
    await act(async () => {
      finish({ ...scan });
      await refreshing;
    });
    expect(useWorkspaceStore.getState().manifest).toEqual(
      timing === "before the disk read starts" && text === "baseline" ? disk : newer,
    );
    expect(useWorkspaceStore.getState().baselineManifest).toBe(JSON.stringify(disk));
    expect(useWorkspaceStore.getState().busy).toBe(false);
  });

  it.each([true, false])(
    "resolves restored draft conflicts from the global refresh (load disk: %s)",
    async (loadDisk) => {
      const workspace: WorkspaceSummary = {
        id: "workspace-1",
        path: "/workspace",
        name: "Workspace",
        status: "healthy",
        asset_count: 0,
        warning_count: 0,
        sources: [],
      };
      const baseline: Manifest = {
        schema_version: 2,
        workspace: { id: workspace.id, name: workspace.name },
        instructions: { shared: "saved", scoped: [], platform_overrides: {} },
        skills: [],
        connections: [],
        adapters: {},
        mcp: { config: "mcp.json" },
        memories: { require_approval: true },
      };
      const draft = {
        ...baseline,
        instructions: { ...baseline.instructions, shared: "cached edit" },
      };
      const disk = {
        ...baseline,
        instructions: { ...baseline.instructions, shared: "external edit" },
      };
      useWorkspaceStore.setState({
        selectedWorkspace: workspace,
        project: workspace.path,
        manifest: draft,
      });
      useWorkspaceStore
        .getState()
        .cacheWorkspaceDraft(workspace.id, draft, JSON.stringify(baseline));
      testDoubles.location.pathname = "/workspace/workspace-1/assets";
      testDoubles.confirm.mockResolvedValue(loadDisk);
      vi.spyOn(api, "scan").mockResolvedValue({
        root: workspace.path,
        manifest_exists: true,
        agents: [],
        assets: [],
        warnings: [],
      });
      vi.spyOn(api, "manifest").mockResolvedValue(disk);
      vi.spyOn(api, "runtime").mockResolvedValue({ app_name: "AgentKib" } as RuntimeInfo);
      const { result } = renderHook(() => useAppNavigation());
      await act(async () => result.current.refreshCurrentView());
      expect(testDoubles.confirm).toHaveBeenCalledOnce();
      expect(useWorkspaceStore.getState().manifest).toEqual(loadDisk ? disk : draft);
      expect(useWorkspaceStore.getState().workspaceDraftBaselines[workspace.id]).toBe(
        loadDisk ? undefined : JSON.stringify(disk),
      );
    },
  );

  it("blocks direct workspace navigation while a ChangeSet is applying", async () => {
    const currentWorkspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace-1",
      name: "Current workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const nextWorkspace: WorkspaceSummary = {
      ...currentWorkspace,
      id: "workspace-2",
      path: "C:/workspace-2",
      name: "Next workspace",
    };
    useWorkspaceStore.setState({ applyingChanges: true, selectedWorkspace: currentWorkspace });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.openWorkspace(nextWorkspace));

    expect(testDoubles.navigate).not.toHaveBeenCalled();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().selectedWorkspace).toBe(currentWorkspace);
    expect(useWorkspaceStore.getState().applyingChanges).toBe(true);
  });

  it("rechecks the ChangeSet state after the directory picker", async () => {
    testDoubles.open.mockImplementation(async () => {
      useWorkspaceStore.setState({ applyingChanges: true });
      return "C:/new-workspace";
    });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.addWorkspace());

    expect(testDoubles.open).toHaveBeenCalledOnce();
    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it("blocks history navigation while a ChangeSet is applying", async () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => {
      expect(await result.current.prepareHistoryNavigation(homeHistoryEntry)).toBe(false);
    });

    expect(testDoubles.notify).toHaveBeenCalledOnce();
  });

  it("keeps history and workspace state when leaving a draft is cancelled", async () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: {} as Manifest,
      baselineManifest: '{"version":0}',
    });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => {
      expect(await result.current.prepareHistoryNavigation(homeHistoryEntry)).toBe(false);
    });

    expect(testDoubles.confirm).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().selectedWorkspace).toBe(workspace);
    expect(testDoubles.navigate).not.toHaveBeenCalled();
  });

  it("clears workspace state after confirming protected history navigation", async () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    testDoubles.confirm.mockResolvedValue(true);
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest: {} as Manifest,
      baselineManifest: '{"version":0}',
    });
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => {
      expect(await result.current.prepareHistoryNavigation(homeHistoryEntry)).toBe(true);
    });

    expect(useWorkspaceStore.getState().selectedWorkspace).toBeUndefined();
    expect(useWorkspaceStore.getState().project).toBe("");
    expect(testDoubles.navigate).not.toHaveBeenCalled();
  });

  it("reports tool refresh failures without rejecting the toolbar action", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    testDoubles.location.pathname = "/settings";
    testDoubles.search = { settingsSection: "tools" };
    testDoubles.agentTools.mockRejectedValueOnce(new Error("refresh unavailable"));
    const { result } = renderHook(() => useAppNavigation(), { wrapper });

    await act(async () => result.current.refreshCurrentView());

    expect(testDoubles.agentTools).toHaveBeenCalledWith(true);
    expect(useWorkspaceStore.getState().message).toContain("refresh unavailable");
    queryClient.clear();
  });

  it("prioritizes a tools settings refresh over retained workspace state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const snapshot = { tools: [], detected_at: "2026-09-03T00:00:00Z" };
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    testDoubles.location.pathname = "/settings";
    testDoubles.search = { settingsSection: "tools" };
    testDoubles.agentTools.mockResolvedValueOnce(snapshot);
    const manifest = {} as Manifest;
    useWorkspaceStore.setState({
      message: "previous error",
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest,
    });
    const { result } = renderHook(() => useAppNavigation(), { wrapper });

    await act(async () => result.current.refreshCurrentView());

    expect(useWorkspaceStore.getState().message).toBe("");
    expect(queryClient.getQueryData(["settings", "agent-tools"])).toBe(snapshot);
    expect(useWorkspaceStore.getState().selectedWorkspace).toBe(workspace);
    expect(useWorkspaceStore.getState().project).toBe(workspace.path);
    expect(useWorkspaceStore.getState().manifest).toBe(manifest);
    queryClient.clear();
  });

  it("clears stale workspace busy state when opening settings without discarding the draft", () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const manifest = {} as Manifest;
    const draft = {} as Manifest;
    useWorkspaceStore.setState({
      busy: true,
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest,
      baselineManifest: '{"version":0}',
      workspaceDrafts: { [workspace.id]: draft },
    });
    testDoubles.location.pathname = "/workspace/workspace-1";
    const { rerender } = renderHook(() => useAppNavigation());

    testDoubles.location.pathname = "/settings";
    testDoubles.search = { settingsSection: "tools" };
    rerender();

    const state = useWorkspaceStore.getState();
    expect(state.busy).toBe(false);
    expect(state.selectedWorkspace).toBe(workspace);
    expect(state.project).toBe(workspace.path);
    expect(state.manifest).toBe(manifest);
    expect(state.baselineManifest).toBe('{"version":0}');
    expect(state.workspaceDrafts[workspace.id]).toBe(draft);
  });

  it("goes to the workspace list when Workspaces is chosen from inside a workspace", async () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    useWorkspaceStore.setState({ selectedWorkspace: workspace, project: workspace.path });
    testDoubles.location.pathname = "/workspace/workspace-1";
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.navigateGlobal("workspaces"));

    // 导航记忆里存的正是当前工作区；这里不能再"恢复"到它，否则列表页永远到不了。
    expect(testDoubles.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/workspaces" }),
    );
    expect(useWorkspaceStore.getState().selectedWorkspace).toBeUndefined();
  });

  it("refreshes the home route instead of retained workspace state", async () => {
    const workspace: WorkspaceSummary = {
      id: "workspace-1",
      path: "C:/workspace",
      name: "Workspace",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const manifest = {} as Manifest;
    useWorkspaceStore.setState({
      selectedWorkspace: workspace,
      project: workspace.path,
      manifest,
    });
    testDoubles.location.pathname = "/";
    const { result } = renderHook(() => useAppNavigation());

    await act(async () => result.current.refreshCurrentView());

    expect(testDoubles.requestRefresh).toHaveBeenCalledWith(true);
    expect(useWorkspaceStore.getState().selectedWorkspace).toBe(workspace);
    expect(useWorkspaceStore.getState().manifest).toBe(manifest);
  });
});
