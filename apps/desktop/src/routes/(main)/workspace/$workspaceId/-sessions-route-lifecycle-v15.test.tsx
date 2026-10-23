// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useMatches,
} from "@tanstack/react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  ConversationSessionSummary,
  Manifest,
  RuntimeInfo,
  WorkspaceScan,
  WorkspaceSummary,
} from "@/core/types";
import { appSearchSchema } from "@/features/app/app-search-schema";
import { useAppNavigation } from "@/features/app/useAppNavigation";
import { routeFromMatches } from "@/features/app/app-route";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useAppStore } from "@/stores/app-store";
import { Route as WorkspaceRoute } from "./route";
import { Route as SessionsRoute } from "./sessions";
import { Route as ChangesRoute } from "./changes";
import {
  AppNavigationProvider,
  type AppNavigationContextValue,
} from "@/features/app/AppNavigationContext";
import { SessionHubPage } from "@/features/sessions/SessionHubPage";
import { SessionWindowToolbar } from "@/features/sessions/SessionWindowToolbar";
import { useSessionHub } from "@/features/sessions/SessionHubContext";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import userEvent from "@testing-library/user-event";

const doubles = vi.hoisted(() => ({
  sessionHub: false,
  workspaces: [] as WorkspaceSummary[],
  notify: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/features/sessions/SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("@/features/sessions/DesktopConversationPane", () => ({
  DesktopConversationPane: () => <input aria-label="Conversation draft" />,
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ notify: doubles.notify, confirm: doubles.confirm }),
}));
vi.mock("@/features/workspace/WorkspaceOpenWith", () => ({ WorkspaceOpenWith: () => null }));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeWorkspaces: () => ({
    data: doubles.workspaces,
    isPending: false,
    dataUpdatedAt: 1,
    errorUpdatedAt: 0,
  }),
  useHomeMemories: () => ({ data: [] }),
  useHomeRefreshJobs: () => ({ data: [] }),
  useHomeDoctorReport: () => ({
    data: undefined,
    isError: false,
    refetch: vi.fn().mockResolvedValue(undefined),
  }),
  useHomeInstallations: () => ({
    data: [
      { agent: "claude-code", installed: true },
      { agent: "codex", installed: true },
    ],
  }),
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  useConversationCatalog: () => ({ sessions: [], ready: true, error: undefined }),
}));
vi.mock("@/core/api", () => ({
  api: {
    scan: vi.fn(),
    manifest: vi.fn(),
    runtime: vi.fn(),
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    sessionEvents: vi.fn(),
    sessionSourceCapability: vi.fn(),
    nativeImportOperations: vi.fn(),
    prepareSessionHandoff: vi.fn(),
    planSessionHandoff: vi.fn(),
  },
}));

const workspace: WorkspaceSummary = {
  id: "workspace",
  name: "Current workspace",
  path: "/synthetic/current-project",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
const previous: WorkspaceSummary = {
  ...workspace,
  id: "previous",
  name: "Previous workspace",
  path: "/synthetic/previous-project",
};
const source: ConversationSessionSummary = {
  id: "native-history",
  workspace_id: workspace.id,
  agent: "claude-code",
  title: "Native history source",
  availability: "readable",
  origin: "unknown",
  archived: false,
  sidechain: false,
};
const manifest: Manifest = {
  schema_version: 2,
  workspace: { id: workspace.id, name: workspace.name },
  instructions: { shared: "Synthetic project instructions", scoped: [], platform_overrides: {} },
  skills: [],
  connections: [],
  adapters: {},
  mcp: { config: "mcp.json" },
  memories: { require_approval: true },
};
const scan: WorkspaceScan = {
  root: workspace.path,
  manifest_exists: true,
  agents: [],
  assets: [],
  warnings: [],
};
const runtime = { app_name: "AgentKib", session_index_enabled: true } as RuntimeInfo;

function NavigationRoot() {
  const matches = useMatches();
  const app = useAppNavigation(routeFromMatches(matches));
  return (
    <AppNavigationProvider value={{ app } as AppNavigationContextValue}>
      <Outlet />
    </AppNavigationProvider>
  );
}

async function mountRouter(url: string) {
  await WorkspaceRoute.options.component!.preload?.();
  await SessionsRoute.options.component!.preload?.();
  await ChangesRoute.options.component!.preload?.();
  const root = createRootRoute({ validateSearch: appSearchSchema, component: NavigationRoot });
  const main = createRoute({ getParentRoute: () => root, id: "(main)", component: Outlet });
  const layout = createRoute({
    getParentRoute: () => main,
    path: "workspace/$workspaceId",
    component: WorkspaceRoute.options.component!,
  });
  const sessions = createRoute({
    getParentRoute: () => layout,
    path: "sessions",
    component: SessionsRoute.options.component!,
    staticData: { appRoute: { kind: "workspace", page: "sessions" } },
  });
  const shared = createRoute({
    getParentRoute: () => main,
    path: "sessions",
    staticData: { appRoute: { kind: "global", page: "sessions" } },
    component: () =>
      doubles.sessionHub ? (
        <>
          <SessionWindowToolbar />
          <SessionHubPage />
        </>
      ) : (
        <p>Shared session destination</p>
      ),
  });
  const changes = createRoute({
    getParentRoute: () => layout,
    path: "changes",
    component: ChangesRoute.options.component!,
    staticData: { appRoute: { kind: "workspace", page: "changes" } },
  });
  const overview = createRoute({
    getParentRoute: () => layout,
    path: "/",
    component: () => <p>Unexpected overview redirect</p>,
    staticData: { appRoute: { kind: "workspace", page: "overview" } },
  });
  const router = createRouter({
    routeTree: root.addChildren([
      main.addChildren([layout.addChildren([sessions, changes, overview]), shared]),
    ]),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <RouterProvider router={router} />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  return router;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("workspace session route restoration", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.resetAllMocks();
    doubles.sessionHub = false;
    Object.defineProperty(window, "desktopConversation", { configurable: true, value: {} });
    useSessionViewStore.setState({ historyContinuation: undefined, creatingConversation: false });
    vi.mocked(useSessionHub).mockReturnValue({
      selected: source,
      selectedWorkspace: workspace,
      runtimeReady: true,
      enabled: true,
      localEnabled: true,
      workspacesLoading: false,
      workspaces: [workspace],
      sessions: [source],
      statuses: [],
      errors: {},
      remoteHosts: [],
      ready: true,
      historyRevision: 0,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useSessionHub>);
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    doubles.workspaces = [workspace, previous];
    doubles.notify.mockResolvedValue(undefined);
    doubles.confirm.mockResolvedValue(true);
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ runtime });
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    vi.mocked(api.scan).mockResolvedValue(scan);
    vi.mocked(api.manifest).mockResolvedValue(manifest);
    vi.mocked(api.runtime).mockResolvedValue(runtime);
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) =>
      id === workspace.id ? [source] : [],
    );
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation(async (id) =>
      id === workspace.id ? [source] : [],
    );
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([]);
    vi.mocked(api.sessionEvents).mockResolvedValue({ events: [], warnings: [] });
    vi.mocked(api.sessionSourceCapability).mockResolvedValue({ status: "supported" });
    vi.mocked(api.nativeImportOperations).mockResolvedValue([]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    useSessionViewStore.setState({ historyContinuation: undefined });
    delete window.desktopConversation;
  });

  it("retains a cold workspace's handoff request until the layout and session dialog are ready", async () => {
    const loading = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(loading.promise);
    const router = await mountRouter(
      `/workspace/${workspace.id}/sessions?handoffSession=${source.id}`,
    );
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith(workspace.path));
    expect(router.state.location.search).toMatchObject({ handoffSession: source.id });
    expect(useWorkspaceStore.getState().selectedWorkspace?.id).toBe(workspace.id);
    await act(async () => loading.resolve(scan));
    expect(await screen.findByRole("dialog", { name: "Continue this work" })).toBeVisible();
    await waitFor(() => expect(router.state.location.search.handoffSession).toBeUndefined());
    expect(screen.getByRole("dialog", { name: "Continue this work" })).toBeVisible();
    expect(router.state.location.pathname).toBe(`/workspace/${workspace.id}/sessions`);
  });

  it("retains a cold workspace's old session link and reaches the shared session page", async () => {
    const loading = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(loading.promise);
    const router = await mountRouter(`/workspace/${workspace.id}/sessions?sessionId=${source.id}`);
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith(workspace.path));
    expect(router.state.location.search).toMatchObject({ sessionId: source.id });
    await act(async () => loading.resolve(scan));
    expect(await screen.findByText("Shared session destination")).toBeVisible();
    expect(router.state.location.pathname).toBe("/sessions");
    expect(router.state.location.search).toEqual({ sessionId: source.id });
  });

  it("restores another workspace using only that navigation's query rather than the previous continuation", async () => {
    useWorkspaceStore.setState({
      selectedWorkspace: previous,
      project: previous.path,
      scan: { ...scan, root: previous.path },
      manifest,
      baselineManifest: JSON.stringify(manifest),
    });
    const router = await mountRouter(
      `/workspace/${previous.id}/sessions?handoffSession=previous-source&handoffTarget=codex&handoffBudget=64000&handoffFormat=json&handoffResume=return`,
    );
    const loading = deferred<WorkspaceScan>();
    vi.mocked(api.scan).mockReturnValueOnce(loading.promise);
    await act(async () => {
      await router.navigate({
        to: "/workspace/$workspaceId/sessions",
        params: { workspaceId: workspace.id },
        search: { handoffSession: source.id },
      });
    });
    await waitFor(() => expect(api.scan).toHaveBeenCalledWith(workspace.path));
    expect(router.state.location.search).toEqual({ handoffSession: source.id });
    expect(useWorkspaceStore.getState().selectedWorkspace?.id).toBe(workspace.id);
    await act(async () => loading.resolve(scan));
    expect(await screen.findByRole("dialog", { name: "Continue this work" })).toBeVisible();
  });
  it.each(["cold", "warm"] as const)(
    "installs the handoff plan before the real changes route mounts for a %s workspace",
    async (state) => {
      doubles.sessionHub = true;
      if (state === "warm")
        useWorkspaceStore.setState({
          selectedWorkspace: workspace,
          project: workspace.path,
          scan,
          manifest,
          baselineManifest: JSON.stringify(manifest),
        });
      const planned = {
        change_set: {
          id: "continuation-plan",
          project_root: workspace.path,
          created_at: "2026-10-23T00:00:00Z",
          requires_home_approval: false,
          changes: [
            {
              target: workspace.path + "/CONTINUE.md",
              scope: "project" as const,
              before: "",
              after: "Synthetic continuation",
              risk: "low" as const,
              validator: "markdown",
            },
          ],
        },
        launch_request: {
          mode: "native-import" as const,
          workspace_id: workspace.id,
          target_agent: "codex" as const,
          operation_id: "synthetic-operation",
          plan_hash: "synthetic-hash",
        },
      };
      vi.mocked(api.prepareSessionHandoff).mockResolvedValue({
        status: "ready",
        draft: {
          filename: "CONTINUE.md",
          format: "markdown",
          content: "Synthetic continuation",
          mode: "native-session",
          source_fingerprint: "synthetic-fingerprint",
          redaction_count: 0,
          stats: {
            turn_count: 1,
            message_count: 2,
            tool_call_count: 0,
            tool_result_count: 0,
            attachment_count: 0,
          },
          history_budget_tokens: 120000,
          window_strategy: "full",
          window_stats: {
            estimated_total_tokens: 100,
            estimated_active_tokens: 100,
            estimated_deferred_tokens: 0,
            active: {
              turn_count: 1,
              message_count: 2,
              tool_call_count: 0,
              tool_result_count: 0,
              attachment_count: 0,
            },
            deferred_turn_count: 0,
            deferred_block_count: 0,
            estimate_quality: "conservative",
          },
          losses: [],
          include_pre_compaction_history: false,
          native_capability: { supported: true, beta: false },
          capabilities: {
            source_agent: "claude-code",
            target_agent: "codex",
            source_read: { status: "supported" },
            source_parse: { status: "supported" },
            native_resume: { status: "supported" },
            file_handoff: { status: "supported" },
            windowed_context: { status: "unavailable", reason: "mcp-not-connected" },
            mcp_setup: { status: "supported" },
            interactive_launch: { status: "supported" },
          },
          mcp_available: false,
        },
      });
      vi.mocked(api.planSessionHandoff).mockResolvedValue(planned);
      const router = await mountRouter(`/sessions?sessionId=${source.id}`);
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: tr("common.moreActions") }));
      await user.click(await screen.findByRole("menuitem", { name: tr("handoff.create") }));
      const inspect = await screen.findByRole("button", { name: tr("handoff.prepare") });
      await waitFor(() => expect(inspect).toBeEnabled());
      fireEvent.click(inspect);
      fireEvent.click(await screen.findByRole("button", { name: tr("handoff.reviewSave") }));
      await waitFor(() =>
        expect(router.state.location.pathname).toBe(`/workspace/${workspace.id}/changes`),
      );
      expect(await screen.findByRole("heading", { name: "Change plan" })).toBeVisible();
      expect(useWorkspaceStore.getState().changeSet).toBe(planned.change_set);
      expect(useWorkspaceStore.getState().handoffLaunchRequest).toBe(planned.launch_request);
      expect(useWorkspaceStore.getState().changeSetOrigin).toBe("handoff");
      expect(screen.queryByText("Unexpected overview redirect")).toBeNull();
    },
  );
});
