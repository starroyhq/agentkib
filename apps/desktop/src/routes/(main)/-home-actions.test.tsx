// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { Suspense } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, RuntimeInfo, WorkspaceSummary } from "@/core/types";
import {
  AppNavigationProvider,
  type AppNavigationContextValue,
} from "@/features/app/AppNavigationContext";
import { useAppNavigation } from "@/features/app/useAppNavigation";
import { homeKeys } from "@/features/home/home-query";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { useAppStore } from "@/stores/app-store";
import { Route } from "./index";

const doubles = vi.hoisted(() => ({
  navigate: vi.fn(),
  notify: vi.fn(),
  location: { pathname: "/", href: "/" },
  search: {},
  emptyListQuery: { data: [], isPending: false, isSuccess: true, isError: false },
  workspaces: [] as WorkspaceSummary[],
  managed: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  useNavigate: () => doubles.navigate,
  useLocation: () => doubles.location,
  useSearch: () => doubles.search,
}));
vi.mock("@/components/AppDialogProvider", () => ({
  useAppDialogs: () => ({ notify: doubles.notify, confirm: vi.fn().mockResolvedValue(true) }),
}));
vi.mock("@/core/api", () => ({
  api: {
    pickDirectory: vi.fn(),
    addWorkspace: vi.fn(),
    addScanRoot: vi.fn(),
    requestRefresh: vi.fn(),
    workspaceSessions: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    setSessionIndexEnabled: vi.fn(),
  },
}));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({ benchmark: { mark: vi.fn().mockResolvedValue(undefined) } }),
}));
vi.mock("@/features/sessions/conversation-catalog", () => ({
  useConversationCatalog: () => doubles.managed(),
  refreshConversationCatalog: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/features/home/home-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/home/home-query")>()),
  useHomeWorkspaces: () => ({ ...doubles.emptyListQuery, data: doubles.workspaces }),
  useHomeMemories: () => doubles.emptyListQuery,
  useHomeRefreshJobs: () => doubles.emptyListQuery,
  useHomeInstallations: () => doubles.emptyListQuery,
  useHomeActivity: () => doubles.emptyListQuery,
  useHomeCatalog: () => doubles.emptyListQuery,
  useHomeDoctorSummaries: () => ({ ...doubles.emptyListQuery, data: {} }),
  useHomeDiscovery: () => ({ ...doubles.emptyListQuery, data: undefined }),
}));

const workspace: WorkspaceSummary = {
  id: "workspace",
  name: "Workspace",
  path: "/project",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
};

function Harness() {
  const app = useAppNavigation({ kind: "global", page: "home" });
  const Component = Route.options.component!;
  return (
    <AppNavigationProvider value={{ app } as AppNavigationContextValue}>
      <Component />
    </AppNavigationProvider>
  );
}

async function renderHome(
  ready = () => screen.findByRole("button", { name: tr("home.addWorkspace") }),
) {
  // Wait for route splitting before checking the rendered UI's readiness.
  await Route.options.component!.preload?.();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue(undefined);
  await act(async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <Suspense fallback={null}>
          <Harness />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  await ready();
  return { invalidate };
}

describe("home add actions", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    doubles.workspaces = [];
    doubles.managed.mockReturnValue({ sessions: [], ready: true });
    useAppStore.setState(useAppStore.getInitialState(), true);
    useAppStore.setState({ runtime: { session_index_enabled: false } as RuntimeInfo });
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
    useSessionViewStore.setState(useSessionViewStore.getInitialState(), true);
    doubles.notify.mockResolvedValue(undefined);
    doubles.navigate.mockResolvedValue(undefined);
    vi.mocked(api.pickDirectory).mockResolvedValue("/project");
    vi.mocked(api.addWorkspace).mockResolvedValue(workspace);
    vi.mocked(api.addScanRoot).mockResolvedValue({} as Awaited<ReturnType<typeof api.addScanRoot>>);
    vi.mocked(api.requestRefresh).mockResolvedValue(
      {} as Awaited<ReturnType<typeof api.requestRefresh>>,
    );
  });
  afterEach(cleanup);

  it("opens a recent session from the catalog in the session page", async () => {
    doubles.workspaces = [workspace];
    useAppStore.setState({ runtime: { session_index_enabled: true } as RuntimeInfo });
    const session = {
      id: "session-1",
      workspace_id: workspace.id,
      agent: "claude-code",
      title: "Continue the test project",
      availability: "readable",
      archived: false,
      sidechain: false,
    } as ConversationSessionSummary;
    doubles.managed.mockReturnValue({ sessions: [session], ready: true, usable: true });
    useSessionViewStore.setState({
      agent: "codex",
      host: "unrelated-host",
      filter: "archived",
      creatingConversation: true,
      collapsed: { [workspace.id]: true },
    });
    await renderHome(() => screen.findByRole("button", { name: /Continue the test project/ }));
    fireEvent.click(screen.getByRole("button", { name: /Continue the test project/ }));
    await waitFor(() =>
      expect(doubles.navigate).toHaveBeenCalledWith({
        to: "/sessions",
        search: { sessionId: session.id },
      }),
    );
    expect(useSessionViewStore.getState()).toMatchObject({
      agent: "all",
      host: "all",
      filter: "all",
      creatingConversation: false,
      collapsed: { [workspace.id]: false },
    });
    // Sessions come from the catalog; the recent workspaces are only read again in the background,
    // without forcing a rescan.
    expect(api.workspaceSessions).not.toHaveBeenCalled();
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledExactlyOnceWith(workspace.id, false);
  });

  it("builds the index for every workspace after turning it on from the home", async () => {
    const other = { ...workspace, id: "other", name: "Other" };
    doubles.workspaces = [workspace, other];
    vi.mocked(api.setSessionIndexEnabled).mockResolvedValue({
      session_index_enabled: true,
    } as RuntimeInfo);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([]);
    await renderHome(() => screen.findByRole("button", { name: tr("home.enableIndex") }));
    fireEvent.click(screen.getByRole("button", { name: tr("home.enableIndex") }));
    await waitFor(() => expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(2));
    expect(api.setSessionIndexEnabled).toHaveBeenCalledWith(true);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith(workspace.id, false);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith(other.id, false);
    expect(useAppStore.getState().runtime?.session_index_enabled).toBe(true);
  });

  it("starts the first session in the session page's creation flow", async () => {
    doubles.workspaces = [workspace];
    useAppStore.setState({ runtime: { session_index_enabled: true } as RuntimeInfo });
    doubles.managed.mockReturnValue({ sessions: [], ready: true, usable: true });
    await renderHome(() => screen.findByRole("button", { name: tr("sessions.newConversation") }));
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.newConversation") }));
    await waitFor(() => expect(doubles.navigate).toHaveBeenCalledWith({ to: "/sessions" }));
    expect(useSessionViewStore.getState().creatingConversation).toBe(true);
  });

  it("adds a single workspace through the shared safe navigation flow", async () => {
    const { invalidate } = await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
    await waitFor(() =>
      expect(doubles.navigate).toHaveBeenCalledWith({
        to: "/workspace/$workspaceId",
        params: { workspaceId: workspace.id },
        search: {},
      }),
    );
    expect(api.pickDirectory).toHaveBeenCalledWith(tr("dialog.addWorkspace"));
    expect(api.addWorkspace).toHaveBeenCalledWith("/project");
    expect(api.addScanRoot).not.toHaveBeenCalled();
    expect(api.requestRefresh).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: homeKeys.all });
    expect(useWorkspaceStore.getState().selectedWorkspace).toEqual(workspace);
  });

  it("adds a scan folder and refreshes discovery without opening a workspace", async () => {
    const { invalidate } = await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledWith("discovery", true));
    expect(api.pickDirectory).toHaveBeenCalledWith(tr("dialog.addScanRoot"));
    expect(api.addScanRoot).toHaveBeenCalledWith("/project", 5);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: homeKeys.scanRoots() });
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("keeps the existing apply guard before selecting a workspace", async () => {
    useWorkspaceStore.setState({ applyingChanges: true });
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
    await waitFor(() =>
      expect(doubles.notify).toHaveBeenCalledWith(tr("workspace.changesApplying")),
    );
    expect(api.pickDirectory).not.toHaveBeenCalled();
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
  });

  it("shows add failures inline and re-enables the actions for retry", async () => {
    vi.mocked(api.addScanRoot).mockRejectedValueOnce(new Error("scan folder denied"));
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    expect(await screen.findByRole("alert")).toHaveTextContent("scan folder denied");
    expect(screen.getByRole("button", { name: tr("home.addScanRoot") })).toBeEnabled();
    expect(api.requestRefresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    await waitFor(() => expect(api.requestRefresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does nothing after cancelling the directory picker", async () => {
    vi.mocked(api.pickDirectory).mockResolvedValue(undefined);
    await renderHome();
    fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    await act(async () => {});
    expect(api.pickDirectory).toHaveBeenCalledTimes(2);
    expect(api.addWorkspace).not.toHaveBeenCalled();
    expect(api.addScanRoot).not.toHaveBeenCalled();
    expect(doubles.navigate).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
