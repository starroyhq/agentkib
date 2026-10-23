// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { api } from "@/core/api";
import type {
  ChangeSet,
  ConversationSessionSummary,
  SessionHandoffDraft,
  WorkspaceSummary,
} from "@/core/types";
import { SessionWindowToolbar } from "./SessionWindowToolbar";
import { SessionHubPage } from "./SessionHubPage";
import { useSessionHub } from "./SessionHubContext";
import { useSessionViewStore } from "./session-view-store";
import { useWorkspaceStore } from "@/features/workspace/workspace-store";

const doubles = vi.hoisted(() => ({ openWorkspace: vi.fn() }));
vi.mock("@/features/app/AppNavigationContext", () => ({
  useAppNavigationContext: () => ({ app: { openWorkspace: doubles.openWorkspace } }),
}));
vi.mock("@/features/home/home-query", async (original) => ({
  ...(await original<typeof import("@/features/home/home-query")>()),
  useHomeInstallations: () => ({ data: [{ agent: "codex", installed: true }] }),
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("./DesktopConversationPane", () => ({
  DesktopConversationPane: () => <input aria-label="Conversation draft" />,
}));
vi.mock("@/core/api", () => ({
  api: {
    sessionSourceCapability: vi.fn(),
    prepareSessionHandoff: vi.fn(),
    planSessionHandoff: vi.fn(),
    planSessionMcpConnection: vi.fn(),
  },
}));
const workspace: WorkspaceSummary = {
  id: "project",
  name: "Project",
  path: "/projects/project",
  status: "healthy",
  asset_count: 1,
  warning_count: 0,
  sources: [],
};
const session: ConversationSessionSummary = {
  id: "active",
  indexedSessionIds: ["native-history"],
  workspace_id: workspace.id,
  agent: "claude-code",
  title: "Keep this session",
  availability: "readable",
  archived: false,
  sidechain: false,
};
const draft: SessionHandoffDraft = {
  filename: "continuation.md",
  format: "markdown",
  content: "Reviewed transfer",
  mode: "native-session",
  source_fingerprint: "fixture-fingerprint",
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
    estimated_total_tokens: 200,
    estimated_active_tokens: 200,
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
};
const planned = {
  change_set: { id: "handoff-plan" } as unknown as ChangeSet,
  launch_request: {
    mode: "native-import" as const,
    workspace_id: workspace.id,
    target_agent: "codex" as const,
    operation_id: "fixture-operation",
    plan_hash: "fixture-hash",
  },
};
let hub: ReturnType<typeof useSessionHub>;
async function mount() {
  const root = createRootRoute();
  const route = createRoute({
    getParentRoute: () => root,
    path: "/sessions",
    component: () => (
      <>
        <SessionWindowToolbar />
        <SessionHubPage />
      </>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ["/sessions?sessionId=active"] }),
  });
  const view = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  await screen.findByRole("textbox", { name: "Conversation draft" });
  await waitFor(() => expect(api.sessionSourceCapability).toHaveBeenCalled());
  return { router, ...view };
}
async function openDialog() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: tr("common.moreActions") }));
  await user.click(await screen.findByRole("menuitem", { name: tr("handoff.create") }));
  return user;
}
describe("cross-Agent continuation inside the session page", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "desktopConversation", { configurable: true, value: {} });
    useSessionViewStore.setState({ historyContinuation: undefined, creatingConversation: false });
    useWorkspaceStore.getState().resetWorkspace();
    hub = {
      selected: session,
      selectedWorkspace: workspace,
      runtimeReady: true,
      enabled: true,
      localEnabled: true,
      workspacesLoading: false,
      workspaces: [workspace],
      sessions: [session],
      statuses: [],
      errors: {},
      remoteHosts: [],
      ready: true,
      historyRevision: 0,
      refresh: vi.fn(),
    } as unknown as ReturnType<typeof useSessionHub>;
    vi.mocked(useSessionHub).mockImplementation(() => hub);
    vi.mocked(api.sessionSourceCapability).mockResolvedValue({ status: "supported" });
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({ status: "ready", draft });
    vi.mocked(api.planSessionHandoff).mockResolvedValue(planned);
    doubles.openWorkspace.mockImplementation(async (target, _page, _search, beforeNavigate) => {
      useWorkspaceStore.getState().resetWorkspace();
      useWorkspaceStore.getState().setSelectedWorkspace(target);
      useWorkspaceStore.getState().setProject(target.path);
      beforeNavigate?.();
      expect(useWorkspaceStore.getState().changeSet).toBe(planned.change_set);
      return true;
    });
  });
  afterEach(async () => {
    cleanup();
    await act(async () => {});
    useSessionViewStore.setState({ historyContinuation: undefined });
    delete window.desktopConversation;
  });
  it.each(["close", "escape"])(
    "%s leaves the original session, composer and draft in place",
    async (action) => {
      const { router } = await mount();
      const composer = screen.getByRole("textbox", { name: "Conversation draft" });
      fireEvent.change(composer, { target: { value: "Keep my unsent draft" } });
      const user = await openDialog();
      expect(await screen.findByRole("dialog")).toBeVisible();
      expect(router.state.location.href).toBe("/sessions?sessionId=active");
      expect(doubles.openWorkspace).not.toHaveBeenCalled();
      if (action === "escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: tr("common.close") }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(router.state.location.href).toBe("/sessions?sessionId=active");
      expect(screen.getByRole("textbox", { name: "Conversation draft" })).toBe(composer);
      expect(composer).toHaveValue("Keep my unsent draft");
      expect(composer).toBeEnabled();
      expect(api.prepareSessionHandoff).not.toHaveBeenCalled();
    },
  );
  it("retains the existing prepare, review and workspace-plan destination after success", async () => {
    await mount();
    await openDialog();
    const inspect = await screen.findByRole("button", { name: "Inspect transferable content" });
    await waitFor(() => expect(inspect).toBeEnabled());
    fireEvent.click(inspect);
    const review = await screen.findByRole("button", { name: "Review import changes" });
    fireEvent.click(review);
    await waitFor(() =>
      expect(doubles.openWorkspace).toHaveBeenCalledWith(
        workspace,
        "changes",
        undefined,
        expect.any(Function),
      ),
    );
    await waitFor(() => expect(useWorkspaceStore.getState().changeSet).toBe(planned.change_set));
    expect(api.prepareSessionHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: "native-history", target_agent: "codex" }),
    );
    expect(useWorkspaceStore.getState()).toMatchObject({
      changeSetOrigin: "handoff",
      handoffLaunchRequest: planned.launch_request,
      selectedWorkspace: workspace,
    });
    expect(useSessionViewStore.getState().historyContinuation).toBeUndefined();
  });
});
