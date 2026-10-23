// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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
import { initializeI18n } from "@/core/i18n";
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

const doubles = vi.hoisted(() => ({
  workspaces: [] as WorkspaceSummary[],
  notify: vi.fn(),
  confirm: vi.fn(),
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
  useAppNavigation(routeFromMatches(matches));
  return <Outlet />;
}

async function mountRouter(url: string) {
  await WorkspaceRoute.options.component!.preload?.();
  await SessionsRoute.options.component!.preload?.();
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
    component: () => <p>Shared session destination</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([main.addChildren([layout.addChildren([sessions]), shared])]),
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
});
