// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  ConversationEventPage,
  ConversationSessionSummary,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { useSessionHub } from "./SessionHubContext";
import { SessionHubPage as SessionPage } from "./SessionHubPage";
import { SessionWindowToolbar } from "./SessionWindowToolbar";
import { useSessionViewStore } from "./session-view-store";
import { readRemoteHistory } from "@/features/remote/remote-catalog-store";

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/core/api", () => ({
  api: {
    sessionEvents: vi.fn(),
    setSessionIndexEnabled: vi.fn(),
    sessionSourceCapability: vi.fn(),
  },
}));
vi.mock("./SessionHistoryContinuationDialog", () => ({
  SessionHistoryContinuationDialog: ({
    request,
  }: {
    request: { session: ConversationSessionSummary };
  }) => (
    <div role="dialog" data-testid="history-continuation" data-session-id={request.session.id} />
  ),
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("./DesktopConversationPane", () => ({
  DesktopConversationPane: ({ sessionId, create }: { sessionId?: string; create?: boolean }) => (
    <div
      data-testid="desktop-conversation"
      data-session-id={sessionId}
      data-create={String(create)}
    >
      Interactive conversation
    </div>
  ),
}));
vi.mock("@/features/remote/remote-catalog-store", () => ({ readRemoteHistory: vi.fn() }));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span aria-hidden="true">{agent} icon</span>,
}));

const workspace = {
  id: "workspace-a",
  name: "Design kit",
  path: "/projects/design-kit",
} as WorkspaceSummary;
const readable: ConversationSessionSummary = {
  id: "readable-session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Review theme switching",
  updated_at: "2026-09-06T08:30:00Z",
  archived: false,
  sidechain: false,
  availability: "readable",
};
const archived = { ...readable, id: "archived-session", title: "Archived review", archived: true };
const metadata = {
  ...readable,
  id: "metadata-session",
  title: "Metadata record",
  availability: "metadata-only" as const,
};

function defaultHub(): ReturnType<typeof useSessionHub> {
  return {
    remoteHosts: [],
    remoteErrors: {},
    localEnabled: true,
    workspaces: [workspace],
    sessions: [readable, archived, metadata],
    filtered: [readable, archived, metadata],
    selected: undefined,
    selectedWorkspace: undefined,
    statuses: [
      { workspace_id: workspace.id, agent: "codex", freshness: "fresh", session_count: 3 },
    ],
    errors: {},
    loading: false,
    refreshing: false,
    ready: true,
    historyRevision: 0,
    conversationRefreshRevision: 0,
    runtimeReady: true,
    enabled: true,
    workspacesLoading: false,
    workspacesError: "",
    catalogError: "",
    hiddenSessionNotice: false,
    visibility: { execution: false },
    select: vi.fn(),
    selectionVersion: () => 0,
    refresh: vi.fn().mockResolvedValue(undefined),
    retryWorkspaces: vi.fn(),
  };
}

let hub: ReturnType<typeof useSessionHub>;

function sessionSurface() {
  return (
    <>
      <SessionWindowToolbar />
      <SessionPage />
    </>
  );
}

async function openActionsMenu() {
  await userEvent.setup().click(screen.getByRole("button", { name: tr("common.moreActions") }));
  return screen.findByRole("menu");
}

describe("SessionHubPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().reset();
    useSessionViewStore.setState({ historyContinuation: undefined });
    useSessionViewStore.getState().resetFilters();
    useSessionViewStore.getState().setCreatingConversation(false);
    hub = defaultHub();
    vi.mocked(useSessionHub).mockImplementation(() => hub);
    vi.mocked(api.sessionEvents)
      .mockReset()
      .mockResolvedValue({
        events: [
          {
            id: "message",
            kind: "agent-message",
            content: "Saved theme review",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      });
    vi.mocked(api.setSessionIndexEnabled).mockReset();
    vi.mocked(api.sessionSourceCapability).mockReset().mockResolvedValue({ status: "supported" });
  });
  afterEach(() => {
    cleanup();
    delete window.desktopConversation;
  });

  it("explains rejected records in the directory without reading a transcript", () => {
    hub = { ...hub, hiddenSessionNotice: true };
    render(sessionSurface());
    expect(
      screen.getByText(/This record belongs to a subagent or execution process/),
    ).toBeVisible();
    expect(api.sessionEvents).not.toHaveBeenCalled();
    expect(screen.queryByTestId("desktop-conversation")).toBeNull();
  });

  it("opens a local supported session in place without duplicate history reads", async () => {
    Object.defineProperty(window, "desktopConversation", { configurable: true, value: {} });
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    render(sessionSurface());
    expect(screen.getByTestId("desktop-conversation")).toHaveAttribute(
      "data-session-id",
      readable.id,
    );
    expect(api.sessionEvents).not.toHaveBeenCalled();
    expect(screen.queryByText(tr("sessions.historyReadonly"))).toBeNull();
    const menu = await openActionsMenu();
    await userEvent
      .setup()
      .click(await within(menu).findByRole("menuitem", { name: tr("handoff.create") }));
    expect(navigate).not.toHaveBeenCalled();
    expect(useSessionViewStore.getState().historyContinuation).toMatchObject({
      workspace,
      session: { id: readable.id },
    });
  });

  it("opens task creation from the existing desktop toolbar", () => {
    Object.defineProperty(window, "desktopConversation", { configurable: true, value: {} });
    render(sessionSurface());
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(screen.getByTestId("desktop-conversation")).toHaveAttribute("data-create", "true");
    expect(hub.select).toHaveBeenCalledWith();
  });

  it("continues a managed session through its verified history identity", async () => {
    hub = {
      ...hub,
      selected: { ...readable, id: "managed-session", indexedSessionIds: ["indexed-session"] },
      selectedWorkspace: workspace,
    };
    render(<SessionWindowToolbar />);
    const menu = await openActionsMenu();
    await userEvent
      .setup()
      .click(await within(menu).findByRole("menuitem", { name: tr("handoff.create") }));
    expect(api.sessionSourceCapability).toHaveBeenCalledExactlyOnceWith("indexed-session");
    expect(navigate).not.toHaveBeenCalled();
    expect(useSessionViewStore.getState().historyContinuation).toMatchObject({
      workspace,
      session: { id: "indexed-session" },
    });
  });

  it("does not route an unindexed managed session into the history-only workspace", async () => {
    hub = {
      ...hub,
      selected: { ...readable, id: "managed-session", indexedSessionIds: [] },
      selectedWorkspace: workspace,
    };
    render(<SessionWindowToolbar />);
    const menu = await openActionsMenu();
    expect(within(menu).queryByRole("menuitem", { name: tr("handoff.create") })).toBeNull();
    expect(api.sessionSourceCapability).not.toHaveBeenCalled();
  });

  it("localizes remote catalog failures without exposing RPC text by default", () => {
    hub.remoteHosts = [
      {
        id: "remote-host",
        name: "QA Host",
        address: "192.168.1.20:42987",
        status: "offline",
        last_seen: null,
        error: null,
      },
    ];
    hub.remoteErrors = { "remote-host": "RuntimeRequestError: REMOTE_OFFLINE" };
    render(sessionSurface());
    expect(screen.getByRole("alert")).toHaveTextContent(tr("remote.error.offline"));
    expect(screen.getByRole("alert")).not.toHaveTextContent("RuntimeRequestError");
    fireEvent.click(screen.getByRole("button", { name: tr("errors.details") }));
    expect(screen.getByRole("alert")).toHaveTextContent("RuntimeRequestError: REMOTE_OFFLINE");
  });

  it("shows the four filtered-history metrics and no live-control affordances", () => {
    render(sessionSurface());
    // The shared window toolbar already identifies this page. Do not add a
    // second overview heading or a duplicate of the directory refresh action.
    expect(screen.queryByRole("heading", { name: "Local session overview" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh history" })).toBeNull();
    for (const [label, count] of [
      ["All sessions", "3"],
      ["History available", "2"],
      ["Archived", "1"],
      ["No history content", "1"],
    ]) {
      const metric = screen.getByText(label).parentElement;
      expect(metric).not.toBeNull();
      expect(within(metric!).getByText(count)).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Recently updated" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Index status" })).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(send|approve|stop|pair|connect)/i })).toBeNull();
    expect(api.sessionEvents).not.toHaveBeenCalled();
  });

  it("selects a recent record, displays history in place, and opens continuation without navigating away", async () => {
    const { rerender } = render(sessionSurface());
    fireEvent.click(screen.getByRole("button", { name: /Review theme switching/ }));
    expect(hub.select).toHaveBeenCalledWith(readable.id);
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    rerender(sessionSurface());

    expect(await screen.findByText("Saved theme review")).toBeTruthy();
    expect(screen.getByRole("heading", { name: readable.title })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Local session overview" })).toBeNull();
    expect(screen.getByText(/Saved history, not live agent status/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^(send|approve|stop)/i })).toBeNull();
    const readingContext = screen.getByText("Read-only history").parentElement!;
    fireEvent.click(
      await within(readingContext).findByRole("button", { name: tr("handoff.create") }),
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(useSessionViewStore.getState().historyContinuation).toMatchObject({
      workspace,
      session: { id: readable.id },
    });
    await userEvent.setup().click(screen.getByRole("button", { name: tr("common.moreActions") }));
    await userEvent
      .setup()
      .click(await screen.findByRole("menuitem", { name: "Back to overview" }));
    expect(hub.select).toHaveBeenLastCalledWith();
  });

  it.each(["open-claw", "hermes", "grok-build"] as const)(
    "uses runtime capability for %s historical sources",
    async (agent) => {
      hub = {
        ...hub,
        selected: { ...readable, id: `${agent}-history`, agent },
        selectedWorkspace: workspace,
      };
      render(<SessionWindowToolbar />);

      expect(screen.queryByRole("button", { name: tr("handoff.create") })).toBeNull();
      const menu = await openActionsMenu();
      const action = await within(menu).findByRole("menuitem", { name: tr("handoff.create") });
      expect(action).toBeEnabled();
      await userEvent.setup().click(action);
      expect(navigate).not.toHaveBeenCalled();
      expect(useSessionViewStore.getState().historyContinuation).toMatchObject({
        workspace,
        session: { id: `${agent}-history` },
      });
      expect(api.sessionSourceCapability).toHaveBeenCalledWith(`${agent}-history`);
    },
  );

  it("does not offer continuation when the original format is unsupported", async () => {
    vi.mocked(api.sessionSourceCapability).mockResolvedValue({
      status: "unsupported",
      reason: "Unknown format",
    });
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    render(<SessionWindowToolbar />);
    await act(async () => {});
    expect(api.sessionSourceCapability).toHaveBeenCalledWith(readable.id);
    const menu = await openActionsMenu();
    expect(within(menu).queryByRole("menuitem", { name: tr("handoff.create") })).toBeNull();
  });

  it("keeps a text continuation action in the visible read-only notice", async () => {
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    render(sessionSurface());
    const notice = screen.getByText("Read-only history").parentElement!;
    const continuation = await within(notice).findByRole("button", {
      name: tr("handoff.create"),
    });
    expect(continuation).toBeVisible();
    expect(continuation.textContent).toContain(tr("handoff.create"));
    expect(notice.className).not.toMatch(/hidden/);
    expect(continuation.className).not.toMatch(/hidden/);
    fireEvent.click(continuation);
    expect(navigate).not.toHaveBeenCalled();
    expect(useSessionViewStore.getState().historyContinuation).toMatchObject({
      workspace,
      session: { id: readable.id },
    });
  });

  it.each([
    ["unsupported", "sessions.continuation.unsupported"],
    ["unverified", "sessions.continuation.unavailable"],
    ["unavailable", "sessions.continuation.unavailable"],
  ] as const)(
    "explains %s source capability without offering continuation",
    async (status, key) => {
      vi.mocked(api.sessionSourceCapability).mockResolvedValue({ status, reason: "Source check" });
      hub = { ...hub, selected: readable, selectedWorkspace: workspace };
      render(sessionSurface());
      expect(await screen.findByText(tr(key))).toBeVisible();
      expect(screen.queryByRole("button", { name: tr("handoff.create") })).toBeNull();
      const menu = await openActionsMenu();
      expect(within(menu).queryByRole("menuitem", { name: tr("handoff.create") })).toBeNull();
    },
  );

  it("shows pending source verification and never enables continuation early", async () => {
    vi.mocked(api.sessionSourceCapability).mockReturnValue(new Promise(() => {}));
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    render(sessionSurface());
    expect(screen.getByText(tr("sessions.continuation.checking"))).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("handoff.create") })).toBeNull();
    const menu = await openActionsMenu();
    expect(within(menu).queryByRole("menuitem", { name: tr("handoff.create") })).toBeNull();
  });

  it.each<[string, ConversationSessionSummary, WorkspaceSummary | undefined]>([
    ["unindexed", { ...readable, indexedSessionIds: [] }, workspace],
    ["noWorkspace", readable, undefined],
    [
      "collection",
      { ...readable, workspace_id: SESSION_COLLECTIONS.projectless },
      { ...workspace, id: SESSION_COLLECTIONS.projectless },
    ],
  ])(
    "explains the %s gate without checking a source",
    async (reason, selected, selectedWorkspace) => {
      hub = { ...hub, selected, selectedWorkspace };
      render(sessionSurface());
      expect(screen.getByText(tr(`sessions.continuation.${reason}`))).toBeVisible();
      expect(screen.queryByRole("button", { name: tr("handoff.create") })).toBeNull();
      const menu = await openActionsMenu();
      expect(within(menu).queryByRole("menuitem", { name: tr("handoff.create") })).toBeNull();
      expect(api.sessionSourceCapability).not.toHaveBeenCalled();
    },
  );

  it("explains metadata-only records without reading history or offering continuation", async () => {
    hub = { ...hub, selected: metadata, selectedWorkspace: workspace };
    render(sessionSurface());
    expect(
      screen.getByText(
        "This record contains session information only. Session content is not available yet.",
      ),
    ).toBeTruthy();
    expect(api.sessionEvents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: tr("handoff.create") })).toBeNull();
    const menu = await openActionsMenu();
    expect(within(menu).queryByRole("menuitem", { name: tr("handoff.create") })).toBeNull();
    expect(screen.getByText(tr("sessions.continuation.metadata"))).toBeVisible();
    expect(api.sessionSourceCapability).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("reads remote history without local indexing or local continuation", async () => {
    const remote = {
      host_id: "host",
      host_name: "Studio Mac",
      original_id: readable.id,
      online: false,
      last_synced_at: "2026-09-07T00:00:00Z",
    };
    const selected = { ...readable, id: "remote-session", remote };
    hub = { ...hub, localEnabled: false, selected, selectedWorkspace: { ...workspace, remote } };
    vi.mocked(readRemoteHistory).mockResolvedValue({
      events: [
        {
          id: "remote-message",
          kind: "agent-message",
          content: "Cached remote history",
          attachment_count: 0,
          truncated: false,
        },
      ],
      warnings: [],
    });
    render(sessionSurface());
    expect(await screen.findByText("Cached remote history")).toBeTruthy();
    expect(readRemoteHistory).toHaveBeenCalledWith(selected);
    expect(api.sessionEvents).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: tr("handoff.create") })).toBeNull();
    const menu = await openActionsMenu();
    expect(within(menu).queryByRole("menuitem", { name: tr("handoff.create") })).toBeNull();
    expect(screen.getByText(tr("sessions.continuation.remote"))).toBeVisible();
    expect(api.sessionSourceCapability).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/Studio Mac/)).toBeTruthy();
  });

  it("explains an empty bounded window and keeps earlier paging available", async () => {
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    vi.mocked(api.sessionEvents).mockResolvedValueOnce({
      events: [],
      warnings: ["TRANSCRIPT_SCAN_BUDGET"],
      next_cursor: "older",
    });
    render(sessionSurface());
    expect(
      await screen.findByText(
        "No displayable records in this window. Continue loading earlier records.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/Initially loads up to 50 latest records/)).not.toBeVisible();
    fireEvent.click(screen.getByText("Session details"));
    expect(screen.getByText(/Initially loads up to 50 latest records/)).toBeVisible();
    expect(screen.queryByText("No readable messages")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier records" }));
    expect(await screen.findByText("Saved theme review")).toBeVisible();
    expect(api.sessionEvents).toHaveBeenLastCalledWith(readable.id, "older");
  });

  it("retries failed history reads and displays recovered content", async () => {
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    vi.mocked(api.sessionEvents).mockRejectedValueOnce(new Error("History could not be read"));
    render(sessionSurface());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unable to read this session's history",
    );
    expect(screen.queryByText("History could not be read")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Saved theme review")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.sessionEvents).toHaveBeenCalledTimes(2);
  });

  it("keeps cached records usable and surfaces workspace errors separately", () => {
    hub = { ...hub, errors: { [workspace.id]: "Index source unavailable" } };
    render(sessionSurface());
    expect(screen.getByRole("alert")).toHaveTextContent("Cached history is preserved");
    expect(screen.getByText("Index source unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review theme switching/ }));
    expect(hub.select).toHaveBeenCalledWith(readable.id);
  });

  it("offers a workspace retry when the workspace list cannot load", () => {
    hub = { ...hub, workspaces: [], workspacesError: "Workspaces unavailable" };
    render(sessionSurface());
    expect(screen.getByRole("alert")).toHaveTextContent("Workspaces unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hub.retryWorkspaces).toHaveBeenCalledOnce();
  });

  it("shows a catalog failure with retry instead of claiming there are no sessions", () => {
    hub = { ...hub, sessions: [], filtered: [], catalogError: "Conversation catalog unavailable" };
    render(sessionSurface());
    expect(screen.getByRole("alert")).toHaveTextContent("Conversation catalog unavailable");
    expect(screen.queryByText(tr("sessions.noSessions"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hub.refresh).toHaveBeenCalledOnce();
  });

  it("does not claim indexing is enabled when saving fails and blocks repeated clicks", async () => {
    hub = { ...hub, enabled: false };
    const runtime = { session_index_enabled: false } as RuntimeInfo;
    useAppStore.getState().setRuntime(runtime);
    let reject!: (error: Error) => void;
    vi.mocked(api.setSessionIndexEnabled).mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    render(sessionSurface());
    const enable = screen.getByRole("button", { name: "Enable" });
    fireEvent.click(enable);
    fireEvent.click(enable);
    expect(api.setSessionIndexEnabled).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.getByRole("button", { name: "Enabling…" })).toBeDisabled();
    await act(async () => reject(new Error("Preferences are not writable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Preferences are not writable");
    expect(screen.getByRole("heading", { name: "Session indexing is disabled" })).toBeTruthy();
    expect(useAppStore.getState().runtime).toBe(runtime);
    expect(screen.getByRole("button", { name: "Enable" })).toBeEnabled();
    expect(api.sessionEvents).not.toHaveBeenCalled();
  });

  it("keeps refresh disabled while a refresh is pending", async () => {
    hub = { ...hub, selected: readable, selectedWorkspace: workspace, refreshing: true };
    render(sessionSurface());
    const refresh = screen.getByRole("button", { name: "Refresh history" });
    expect(refresh).toBeDisabled();
    fireEvent.click(refresh);
    await waitFor(() => expect(hub.refresh).not.toHaveBeenCalled());
  });

  it("keeps one title in the window toolbar and details collapsed until requested", async () => {
    hub = {
      ...hub,
      selected: { ...readable, git_branch: "qa/reader" },
      selectedWorkspace: workspace,
    };
    const { container } = render(sessionSurface());
    await screen.findByText("Saved theme review");
    expect(screen.getAllByRole("heading", { name: readable.title })).toHaveLength(1);
    expect(container.querySelector(".session-hub-page h1")).toBeNull();
    expect(screen.getByText("Read-only history")).toBeVisible();
    expect(screen.getByText(workspace.path)).not.toBeVisible();
    fireEvent.click(screen.getByText("Session details"));
    expect(screen.getByText(workspace.path)).toBeVisible();
    expect(screen.getByText("qa/reader")).toBeVisible();
    fireEvent.click(screen.getByText("Session details"));
    expect(screen.getByText(workspace.path)).not.toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Refresh history" }));
    expect(hub.refresh).toHaveBeenCalledOnce();
  });

  it("names a worktree session after its repository in the overview", () => {
    const repository = {
      ...workspace,
      id: "atlas",
      name: "atlas",
      path: "/projects/atlas",
      checkout: {
        repository_group_id: "repo",
        kind: "primary" as const,
        primary_path: "/projects/atlas",
        name: null,
        branch: "main",
        status: "present" as const,
      },
    };
    const home = { ...workspace, id: "home", name: "home", path: "/Users/qa" };
    const worktree = {
      repository_group_id: "repo",
      name: "h1a",
      path: "/Users/qa/.codex/worktrees/h1a/atlas",
      branch: "codex/h1a",
      status: "present" as const,
    };
    const inWorktree = { ...readable, workspace_id: "home", worktree };
    const atHome = { ...readable, id: "home-session", title: "Tidy notes", workspace_id: "home" };
    hub = {
      ...hub,
      workspaces: [repository, home],
      sessions: [inWorktree, atHome],
      filtered: [inWorktree, atHome],
    };
    render(sessionSurface());
    expect(screen.getByRole("button", { name: /Review theme switching/ })).toHaveTextContent(
      "atlas · Codex",
    );
    expect(screen.getByRole("button", { name: /Tidy notes/ })).toHaveTextContent("home · Codex");
  });

  it("shows a deleted worktree's status in the session details without a second notice", async () => {
    const worktree = {
      repository_group_id: "repo",
      name: "h2",
      path: "/projects/.codex/worktrees/h2/design-kit",
      branch: "codex/h2",
      status: "deleted" as const,
    };
    hub = { ...hub, selected: { ...readable, worktree }, selectedWorkspace: workspace };
    render(sessionSurface());
    await screen.findByText("Saved theme review");
    fireEvent.click(screen.getByText("Session details"));
    expect(screen.getByText(tr("sessions.worktree.chipDeleted", { name: "h2" }))).toBeVisible();
    expect(screen.queryByText("codex/h2")).toBeNull();
    expect(
      screen.getByRole("img", {
        name: tr("sessions.worktree.deleted", { name: "h2", path: worktree.path }),
      }),
    ).toHaveClass("opacity-45");
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("anchors a visible record when earlier records prepend and resets on selection change", async () => {
    hub = { ...hub, selected: readable, selectedWorkspace: workspace };
    let finish!: (page: ConversationEventPage) => void;
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce({
        events: [
          {
            id: "recent",
            kind: "agent-message",
            content: "Recent anchor",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
        next_cursor: "older",
      })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
    const { container, rerender } = render(sessionSurface());
    await screen.findByText("Recent anchor");
    const scroller = container.querySelector<HTMLDivElement>(".session-hub-body")!;
    scroller.scrollTop = 80;
    let anchorTop = 100;
    vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(() => ({ top: 50 }) as DOMRect);
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockImplementation(() => [{}] as unknown as DOMRectList);
    const boundsSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return {
          top: this.dataset.eventId === "recent" ? anchorTop : 0,
          bottom: anchorTop + 50,
        } as DOMRect;
      });
    try {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier records" }));
      anchorTop = 260;
      await act(async () =>
        finish({
          events: [
            {
              id: "older",
              kind: "user-message",
              content: "Older record",
              attachment_count: 0,
              truncated: false,
            },
          ],
          warnings: [],
        }),
      );
      expect(scroller.scrollTop).toBe(240);
      hub = { ...hub, selected: archived };
      rerender(sessionSurface());
      expect(scroller.scrollTop).toBe(0);
    } finally {
      rectSpy.mockRestore();
      boundsSpy.mockRestore();
    }
  });
});
