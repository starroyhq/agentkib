// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { readStateCopy, requestReadReview, sessionContinuationCopy } from "@agentkib/session-ui";
import { SessionOverview } from "./SessionOverview";
import { SessionDirectory } from "./SessionDirectory";
import { SessionDirectoryAgentFilter } from "./SessionDirectoryAgentFilter";
import { useSessionHub } from "./SessionHubContext";
import { SessionRowMenu } from "./SessionRowMenu";
import { filterSessions } from "./session-catalog";
import { normalizeDirectoryOrder, useSessionViewStore } from "./session-view-store";

vi.mock("@/features/home/home-query", async (original) => ({
  ...(await original<typeof import("@/features/home/home-query")>()),
  useHomeInstallations: () => ({ data: [{ agent: "antigravity", installed: true }] }),
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("@agentkib/session-ui", async (original) => {
  const actual = await original<typeof import("@agentkib/session-ui")>();
  return { ...actual, requestReadReview: vi.fn(actual.requestReadReview) };
});
// Row menus have their own tests (SessionRowMenu.test.tsx); they read the host on open only.
vi.mock("./SessionRowMenu", () => ({ SessionRowMenu: vi.fn(() => null) }));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span aria-hidden="true">{agent} icon</span>,
}));

const workspaces = [
  { id: "workspace-a", name: "Design kit", path: "/projects/first/design-kit" },
  { id: "workspace-b", name: "Design kit", path: "/projects/second/design-kit" },
] as WorkspaceSummary[];
type NamedSession = ConversationSessionSummary & { title: string };
const first: NamedSession = {
  id: "first",
  workspace_id: "workspace-a",
  agent: "codex",
  title: "Check sidebar selection",
  availability: "readable",
  archived: false,
  sidechain: false,
};
const second: NamedSession = {
  ...first,
  id: "second",
  workspace_id: "workspace-b",
  agent: "claude-code",
  title: "Inspect token layout",
};
const archived = { ...first, id: "archived", title: "Previous icon review", archived: true };
const metadata = {
  ...second,
  id: "metadata",
  title: "Missing transcript",
  availability: "metadata-only" as const,
};
const unreadState: NonNullable<ConversationSessionSummary["readState"]> = {
  source: "codex-native",
  status: "unread",
  freshness: "current",
  version: "native:unread",
  firstUnread: { type: "result", resultId: "latest-result", turnId: "turn" },
  latestResult: {
    id: "latest-result",
    turnId: "turn",
    itemId: "answer",
    outcome: "completed",
    completedAt: null,
  },
};
let hub: ReturnType<typeof useSessionHub>;

function workspaceHeading(workspace: WorkspaceSummary) {
  const heading = screen
    .getAllByRole("button")
    .find(
      (button) =>
        button.getAttribute("aria-description") === `${workspace.name}\n${workspace.path}`,
    );
  expect(heading).toBeDefined();
  return heading!;
}

function dragEntry(source: Element, target: Element, after = false) {
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn() };
  Object.defineProperty(target, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      top: after ? 0 : 100,
      height: after ? 0 : 100,
      bottom: after ? 0 : 200,
      left: 0,
      right: 20,
      width: 20,
      x: 0,
      y: 0,
    }),
  });
  fireEvent.dragStart(source, { dataTransfer });
  fireEvent.dragOver(target, { dataTransfer, clientY: after ? 19 : 1 });
  fireEvent.drop(target, { dataTransfer });
}

function orderedWorkspacePaths(container: HTMLElement) {
  return Array.from(
    container.querySelectorAll<HTMLElement>(".session-workspace-heading strong"),
  ).map((heading) => heading.closest("button")?.getAttribute("aria-description")?.split("\n")[1]);
}

async function focusByKeyboard(user: ReturnType<typeof userEvent.setup>, element: Element) {
  for (let step = 0; step < 10 && document.activeElement !== element; step++) await user.tab();
  expect(element).toHaveFocus();
}

describe("SessionDirectory", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    initializeI18n("en-US");
    vi.clearAllMocks();
    localStorage.removeItem("agentkib.session-directory-order");
    useSessionViewStore.setState({
      agent: "all",
      host: "all",
      filter: "current",
      unreadOnly: false,
      execution: false,
      collapsed: {},
      workspaceOrder: [],
      sessionOrder: {},
      scrollTop: 0,
    });
    hub = {
      remoteHosts: [],
      remoteErrors: {},
      localEnabled: true,
      workspaces,
      sessions: [first, second, archived, metadata],
      filtered: [],
      selected: first,
      selectedWorkspace: workspaces[0],
      statuses: [],
      errors: {},
      loading: false,
      refreshing: false,
      ready: true,
      usable: true,
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
    vi.mocked(useSessionHub).mockImplementation(() => ({
      ...hub,
      filtered: filterSessions(hub.sessions, hub.workspaces, {
        ...useSessionViewStore.getState(),
        query: "",
      }).filter((row) => {
        const host = useSessionViewStore.getState().host;
        return host === "all" || host === (row.remote?.host_id ?? "local");
      }),
    }));
  });
  afterEach(cleanup);

  it("passes the lead's directory group to Worker assignment even under an Agent filter", () => {
    const sameProject = { ...second, id: "same-project", workspace_id: first.workspace_id };
    const execution = { ...sameProject, id: "execution", origin: "execution" as const };
    hub.sessions = [first, second, sameProject, execution];
    useSessionViewStore.setState({ agent: "codex" });

    render(<SessionDirectory />);

    const leadMenu = vi
      .mocked(SessionRowMenu)
      .mock.calls.find(([props]) => props.session === first);
    expect(leadMenu?.[0].sessions?.map((item) => item.id)).toEqual([first.id, sameProject.id]);
  });

  it("keeps unread dots on ordinary rows without a duplicate review card", () => {
    hub.sessions = [{ ...first, readState: unreadState }, second];
    const { container } = render(<SessionDirectory />);
    expect(screen.queryByRole("region", { name: readStateCopy("en-US").pending })).toBeNull();
    expect(screen.getAllByText(first.title)).toHaveLength(1);
    expect(screen.getByRole("button", { name: readStateCopy("en-US").pending })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(
      container.querySelector('.session-directory-trailing [data-unread="true"]'),
    ).not.toBeNull();
  });

  it("shows unread dots per Agent and clears them after the last unread session is read", () => {
    const unreadFirst = { ...first, readState: unreadState };
    const unreadOther = { ...first, id: "other-codex", readState: unreadState };
    const readState = { ...unreadState, status: "read" as const, firstUnread: null };
    hub.sessions = [unreadFirst, unreadOther, second];
    useSessionViewStore.setState({ agent: "claude-code" });
    const { rerender } = render(<SessionDirectory />);
    const agents = within(screen.getByRole("group", { name: tr("conversations.agentFilter") }));
    const all = agents.getByRole("button", { name: tr("sessions.allAgents") });
    const codex = agents.getByRole("button", { name: "Codex" });
    const claude = agents.getByRole("button", { name: "Claude Code" });

    expect(codex).toHaveAccessibleDescription(readStateCopy("en-US").unread);
    expect(codex.querySelector("[data-unread]")).toHaveClass("bg-primary");
    expect(claude.querySelector("[data-unread]")).toBeNull();
    expect(all.querySelector("[data-unread]")).toBeNull();

    hub.sessions = [{ ...unreadFirst, readState }, unreadOther, second];
    rerender(<SessionDirectory />);
    expect(codex.querySelector("[data-unread]")).toBeInTheDocument();

    hub.sessions = [
      { ...unreadFirst, readState },
      { ...unreadOther, readState },
      { ...second, readState: unreadState },
    ];
    rerender(<SessionDirectory />);
    expect(codex.querySelector("[data-unread]")).toBeNull();
    expect(codex).not.toHaveAttribute("aria-description");
    expect(claude.querySelector("[data-unread]")).toBeInTheDocument();
  });

  it("toggles all unread rows including running, manually unread and stale states", () => {
    const rows: NamedSession[] = [
      { ...first, title: "Completed unread", readState: unreadState },
      {
        ...first,
        id: "running-unread",
        title: "Running unread",
        continuation: { status: "running", executionLocation: "agentkib" },
        readState: unreadState,
      },
      {
        ...first,
        id: "manual-unread",
        title: "Manual unread",
        readState: { ...unreadState, latestResult: null, firstUnread: { type: "threadStart" } },
      },
      {
        ...first,
        id: "stale-unread",
        title: "Stale unread",
        readState: { ...unreadState, freshness: "stale" },
      },
      {
        ...second,
        title: "Already read",
        readState: { ...unreadState, status: "read", firstUnread: null },
      },
      {
        ...second,
        id: "unknown-read-state",
        title: "Unknown reading state",
        readState: { ...unreadState, status: "unknown", version: null, firstUnread: null },
      },
    ];
    hub.sessions = rows;
    render(<SessionDirectory />);
    const bell = screen.getByRole("button", { name: readStateCopy("en-US").pending });
    fireEvent.click(bell);
    expect(bell).toHaveAttribute("aria-pressed", "true");
    for (const row of rows.slice(0, 4)) expect(screen.getByText(row.title)).toBeVisible();
    expect(screen.queryByText("Already read")).toBeNull();
    expect(screen.queryByText("Unknown reading state")).toBeNull();
    expect(hub.select).not.toHaveBeenCalled();
    fireEvent.click(bell);
    expect(bell).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Already read")).toBeVisible();
    expect(screen.getByText("Unknown reading state")).toBeVisible();
  });

  it("combines unread filtering with the existing agent and record filters", () => {
    hub.sessions = [
      { ...first, readState: unreadState },
      { ...second, readState: unreadState },
      { ...second, id: "read-second", title: "Read Claude" },
      {
        ...second,
        id: "archived-second",
        title: "Archived unread Claude",
        archived: true,
        readState: unreadState,
      },
    ];
    useSessionViewStore.setState({ agent: "claude-code" });
    render(<SessionDirectory />);
    fireEvent.click(screen.getByRole("button", { name: readStateCopy("en-US").pending }));
    expect(screen.getByText(second.title)).toBeVisible();
    expect(screen.queryByText(first.title)).toBeNull();
    expect(screen.queryByText("Read Claude")).toBeNull();
    expect(screen.queryByText("Archived unread Claude")).toBeNull();
    act(() => useSessionViewStore.getState().setFilter("archived"));
    expect(screen.getByText("Archived unread Claude")).toBeVisible();
    expect(screen.queryByText(second.title)).toBeNull();
    expect(useSessionViewStore.getState()).toMatchObject({
      agent: "claude-code",
      unreadOnly: true,
    });
  });

  it("temporarily opens unread results without changing saved project collapse state", () => {
    hub.sessions = [{ ...first, readState: unreadState }, second];
    const collapsed = { "workspace-a": true, "workspace-b": true };
    useSessionViewStore.setState({ collapsed });
    render(<SessionDirectory />);
    expect(screen.queryByText(first.title)).toBeNull();
    const bell = screen.getByRole("button", { name: readStateCopy("en-US").pending });
    fireEvent.click(bell);
    expect(screen.getByText(first.title)).toBeVisible();
    expect(workspaceHeading(workspaces[0])).toHaveAttribute("aria-expanded", "true");
    expect(useSessionViewStore.getState().collapsed).toEqual(collapsed);
    fireEvent.click(bell);
    expect(workspaceHeading(workspaces[0])).toHaveAttribute("aria-expanded", "false");
    expect(useSessionViewStore.getState().collapsed).toEqual(collapsed);
  });

  it("keeps unread results within the selected computer", () => {
    const remoteWorkspace: WorkspaceSummary = {
      ...workspaces[0],
      id: "remote-workspace",
      name: "Remote project",
      remote: {
        host_id: "other-computer",
        host_name: "Other computer",
        original_id: "native-workspace",
        online: true,
        last_synced_at: "",
      },
    };
    hub.workspaces = [...workspaces, remoteWorkspace];
    hub.sessions = [
      { ...first, readState: unreadState },
      {
        ...first,
        id: "remote-unread",
        title: "Remote unread",
        workspace_id: remoteWorkspace.id,
        remote: { ...remoteWorkspace.remote!, original_id: "native-thread" },
        readState: unreadState,
      },
    ];
    useSessionViewStore.setState({ host: "other-computer" });
    render(<SessionDirectory />);
    fireEvent.click(screen.getByRole("button", { name: readStateCopy("en-US").pending }));
    expect(screen.getByText("Remote unread")).toBeVisible();
    expect(screen.queryByText(first.title)).toBeNull();
    expect(useSessionViewStore.getState()).toMatchObject({
      host: "other-computer",
      unreadOnly: true,
    });
  });

  it("removes a newly read row from unread results without requesting a selection change", () => {
    const row = { ...first, readState: unreadState };
    hub.sessions = [row, second];
    hub.selected = row;
    useSessionViewStore.setState({ unreadOnly: true });
    const view = render(<SessionDirectory />);
    expect(screen.getByText(first.title)).toBeVisible();
    hub.sessions = [{ ...row, readState: { ...unreadState, status: "read" } }, second];
    hub.selected = hub.sessions[0];
    view.rerender(<SessionDirectory />);
    expect(screen.queryByText(first.title)).toBeNull();
    expect(hub.select).not.toHaveBeenCalled();
    expect(hub.selected?.id).toBe(row.id);
  });

  it.each([false, true])(
    "requests the displayed unread result only when entered from the filter (remote=%s)",
    (remote) => {
      const row: ConversationSessionSummary = {
        ...first,
        readState: unreadState,
        ...(remote
          ? {
              remote: {
                host_id: "other-computer",
                host_name: "Other computer",
                original_id: "native-thread",
                online: true,
                last_synced_at: "",
              },
            }
          : {}),
      };
      hub.sessions = [row];
      render(<SessionDirectory />);
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${first.title}`) }));
      expect(requestReadReview).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: readStateCopy("en-US").pending }));
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${first.title}`) }));
      expect(requestReadReview).toHaveBeenCalledExactlyOnceWith(
        row.id,
        row.readState,
        remote ? "remote:other-computer" : "desktop-local",
      );
      expect(hub.select).toHaveBeenLastCalledWith(row.id);
    },
  );

  it("shows one source notice above all workspace groups and retains any real warning", () => {
    hub.statuses = workspaces.map((workspace, index) => ({
      workspace_id: workspace.id,
      agent: "antigravity",
      freshness: "unavailable",
      session_count: index,
      error_key: "errors.conversations.sourceUnavailable",
    }));
    const { container } = render(<SessionDirectory />);
    const warning = screen.getByRole("alert");
    expect(
      screen.getAllByText(tr("sessions.sourceUnavailable", { agent: "Antigravity" })),
    ).toHaveLength(1);
    expect(warning.closest(".session-workspace")).toBeNull();
    expect(warning.closest(".session-directory-tree")).toBe(
      container.querySelector(".session-directory-tree"),
    );
    expect(warning).toHaveClass("text-warning");
    expect(
      warning.compareDocumentPosition(workspaceHeading(workspaces[0])) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(hub.refresh).toHaveBeenCalledOnce();
    act(() => {
      useSessionViewStore.setState({ collapsed: { "workspace-a": true, "workspace-b": true } });
    });
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("combines source, workspace scan, and catalog failures in one directory disclosure", () => {
    hub.workspaces = [workspaces[0], { ...workspaces[1], name: "Design docs" }];
    hub.errors = Object.fromEntries(
      hub.workspaces.map((workspace) => [workspace.id, "Workspace scan unavailable"]),
    );
    hub.catalogError = "Reading the session directory timed out.";
    hub.statuses = [
      {
        workspace_id: workspaces[0].id,
        agent: "antigravity",
        freshness: "unavailable",
        session_count: 1,
        error_key: "errors.conversations.sourceUnavailable",
        error_detail: JSON.stringify(["antigravity-acp-list"]),
      },
    ];
    const { container } = render(<SessionDirectory />);
    const tree = within(container.querySelector<HTMLElement>(".session-directory-tree")!);
    expect(tree.getByText(tr("sessions.partialFailure", { count: 2 }))).toBeVisible();
    expect(tree.queryByText("Workspace scan unavailable")).toBeNull();
    const details = tree.getAllByRole("button", { name: tr("common.details") });
    expect(details).toHaveLength(1);
    fireEvent.click(details[0]);
    expect(tree.getAllByText("Workspace scan unavailable")).toHaveLength(1);
    expect(tree.getByText("Design kit, Design docs")).toBeVisible();
    expect(tree.getByText("Reading the session directory timed out.")).toBeVisible();
    expect(tree.getByText("The ACP session list could not be read.")).toBeVisible();
    const retry = tree.getAllByRole("button", { name: tr("sessions.retry") });
    expect(retry).toHaveLength(1);
    fireEvent.click(retry[0]);
    expect(hub.refresh).toHaveBeenCalledOnce();
  });

  it("keeps empty source notices in the scroll tree and honors installation, host and Agent filters", () => {
    hub.sessions = [];
    hub.workspaces = [
      { ...workspaces[0], name: "Visible source" },
      { ...workspaces[1], name: "Uninstalled source" },
    ];
    hub.statuses = [
      {
        workspace_id: workspaces[0].id,
        agent: "antigravity",
        freshness: "unavailable",
        session_count: 0,
        error_key: "errors.conversations.sourceUnavailable",
      },
      {
        workspace_id: workspaces[1].id,
        agent: "codex",
        freshness: "unavailable",
        session_count: 0,
        error_key: "errors.conversations.sourceUnavailable",
      },
    ];
    const { container, rerender } = render(<SessionDirectory />);
    const text = tr("sessions.sourceUnavailable", { agent: "Antigravity" });
    expect(screen.getByText(text).closest(".session-directory-tree")).toBe(
      container.querySelector(".session-directory-tree"),
    );
    expect(screen.queryByText("Visible source")).toBeNull();
    expect(screen.queryByText("Uninstalled source")).toBeNull();
    hub.sessions = [first, second];
    rerender(<SessionDirectory onMenuOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    expect(screen.queryByText(text)).toBeNull();
    act(() => {
      useSessionViewStore.getState().setAgent("all");
      useSessionViewStore.getState().setHost("remote-fixture");
    });
    expect(screen.queryByText(text)).toBeNull();
  });

  it("does not carry another computer's source warning into the selected computer", () => {
    hub.sessions = [first, second];
    hub.workspaces = [
      workspaces[0],
      {
        ...workspaces[1],
        remote: {
          host_id: "remote-fixture",
          host_name: "Test computer",
          original_id: "remote-workspace",
          online: false,
          last_synced_at: "",
        },
      },
    ];
    hub.statuses = workspaces.map((workspace, index) => ({
      workspace_id: workspace.id,
      agent: "antigravity",
      freshness: "unavailable",
      session_count: index,
      error_key: "errors.conversations.sourceUnavailable",
    }));
    render(<SessionDirectory />);
    expect(screen.getByRole("alert")).toHaveTextContent("Antigravity");
    act(() => useSessionViewStore.getState().setHost("local"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Antigravity");
    act(() => useSessionViewStore.getState().setHost("remote-fixture"));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Antigravity");
    fireEvent.click(screen.getByRole("button", { name: "Codex" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["zh-CN", "有历史内容", "无历史内容"],
    ["zh-Hant", "有歷史內容", "無歷史內容"],
    ["en-US", "History available", "No history content"],
    ["ja-JP", "履歴あり", "履歴なし"],
  ] as const)(
    "describes history availability without changing record counts in %s",
    async (locale, available, unavailable) => {
      await initializeI18n(locale);
      useSessionViewStore.setState({ filter: "all" });
      try {
        render(<SessionOverview />);
        expect(within(screen.getByText(available).parentElement!).getByText("3")).toBeVisible();
        expect(within(screen.getByText(unavailable).parentElement!).getByText("1")).toBeVisible();
        expect(hub.select).not.toHaveBeenCalled();
      } finally {
        await initializeI18n("en-US");
      }
    },
  );

  it("keeps index diagnostics out of the recent conversation overview", () => {
    hub.statuses = [
      {
        workspace_id: workspaces[0].id,
        agent: "codex",
        freshness: "stale",
        session_count: 1,
        last_success_at: "2026-10-23T00:00:00Z",
      },
      {
        workspace_id: workspaces[1].id,
        agent: "claude-code",
        freshness: "unavailable",
        session_count: 1,
        error_key: "errors.conversations.sourceUnavailable",
      },
    ];

    render(<SessionOverview />);

    expect(screen.getByRole("heading", { name: tr("sessions.recent") })).toBeVisible();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeVisible();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.queryByText("Needs refresh")).toBeNull();
    expect(screen.queryByText(tr("errors.conversations.sourceUnavailable"))).toBeNull();
  });

  it("keeps same-named workspace groups separate and exposes paths and the current session", () => {
    render(<SessionDirectory />);
    expect(screen.getAllByRole("button", { name: /Design kit/ })).toHaveLength(2);
    for (const workspace of workspaces) {
      expect(workspaceHeading(workspace)).toHaveAttribute("aria-expanded", "true");
    }
    const current = screen.getByRole("button", { name: /Check sidebar selection/ });
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current).toHaveTextContent("codex icon");
    expect(current).not.toHaveTextContent("Codex ·");
    expect(current.querySelector("small")).toBeNull();
    expect(current.getAttribute("aria-description")).toContain("Codex ·");
    expect(current.getAttribute("aria-description")).toContain(workspaces[0].path);
    const other = screen.getByRole("button", { name: /Inspect token layout/ });
    expect(other).not.toHaveAttribute("aria-current");
    fireEvent.click(other);
    expect(hub.select).toHaveBeenCalledWith(second.id);
  });

  it("keeps worktree details in the project hover card and an icon-only session mark", async () => {
    const user = userEvent.setup();
    const checkout = {
      repository_group_id: "repo",
      kind: "primary" as const,
      primary_path: "/projects/atlas",
      name: null,
      branch: "main",
      status: "present" as const,
    };
    hub.workspaces = [
      { ...workspaces[0], id: "main", name: "atlas", path: "/projects/atlas", checkout },
      {
        ...workspaces[1],
        id: "h1a",
        name: "atlas",
        path: "/codex/worktrees/h1a/atlas",
        checkout: { ...checkout, kind: "worktree", name: "h1a", branch: "codex/h1a" },
      },
    ];
    const worktree = {
      repository_group_id: "repo",
      name: "h1a",
      path: "/codex/worktrees/h1a/atlas",
      branch: "codex/h1a",
      status: "present" as const,
    };
    hub.sessions = [
      { ...first, workspace_id: "main" },
      { ...second, workspace_id: "h1a", worktree },
      {
        ...second,
        id: "gone",
        title: "Old harness run",
        workspace_id: "h1a",
        worktree: { ...worktree, name: "h2", path: "/codex/worktrees/h2/atlas", status: "deleted" },
      },
    ];
    hub.selected = undefined;
    const { container } = render(<SessionDirectory />);
    const headings = container.querySelectorAll(".session-workspace-heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(/^atlas$/);
    expect(headings[0].getAttribute("aria-description")).toContain("h1a\nh2");
    const present = tr("sessions.worktree.present", {
      name: "h1a",
      branch: "codex/h1a",
      path: worktree.path,
    });
    const mark = screen.getByRole("img", { name: present });
    expect(mark).toHaveAttribute("title", present);
    expect(mark).not.toHaveTextContent("h1a");
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toHaveAttribute(
      "aria-description",
      expect.stringContaining(present),
    );
    const deleted = screen.getByRole("img", {
      name: tr("sessions.worktree.deleted", { name: "h2", path: "/codex/worktrees/h2/atlas" }),
    });
    expect(deleted).toHaveClass("opacity-45");
    expect(
      screen
        .getByRole("button", { name: /Check sidebar selection/ })
        .querySelector("[data-worktree-mark]"),
    ).toBeNull();
    // Revealing a worktree session opens its repository's group, not its own workspace's.
    act(() => useSessionViewStore.setState({ collapsed: { main: true } }));
    expect(headings[0]).toHaveAttribute("aria-expanded", "false");
    act(() => useSessionViewStore.getState().revealSession(hub.sessions[2]));
    expect(container.querySelector(".session-workspace-heading")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(useSessionViewStore.getState().revealedSessionId).toBeUndefined();
    await user.hover(container.querySelector(".session-workspace-heading")!);
    const card = await screen.findByRole("tooltip");
    expect(card).toHaveTextContent("/projects/atlas");
    expect(card).toHaveTextContent(tr("workspace.worktrees", { count: 2 }));
    expect(card).toHaveTextContent("h1a");
    expect(card).toHaveTextContent("h2");
  });

  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows only one aggregate status on a folded project, without inline counts, in %s",
    (locale) => {
      initializeI18n(locale);
      const copy = sessionContinuationCopy(locale);
      hub.sessions = [
        {
          ...first,
          continuation: { status: "running", executionLocation: "agentkib" },
        },
        {
          ...first,
          id: "approval",
          title: "Approval needed",
          continuation: { status: "awaiting-approval", executionLocation: "agentkib" },
        },
        second,
      ];
      hub.selected = undefined;
      render(<SessionDirectory />);
      const heading = workspaceHeading(workspaces[0]);
      const projectName = heading.querySelector("strong")!.textContent!;
      const label = `${copy.groupWaiting(1)}, ${copy.groupRunning(1)}`;
      expect(heading.textContent).toBe(projectName);
      expect(within(heading).queryByTitle(label)).toBeNull();

      fireEvent.click(heading);
      expect(heading).toHaveAttribute("aria-expanded", "false");
      expect(within(heading).getByTitle(label)).toHaveAttribute("aria-hidden", "true");
      expect(heading).toHaveAccessibleName(expect.stringContaining(label));
      expect(heading.querySelectorAll("i[title]")).toHaveLength(1);

      fireEvent.click(heading);
      expect(heading).toHaveAttribute("aria-expanded", "true");
      expect(within(heading).queryByTitle(label)).toBeNull();
      expect(heading.textContent).toBe(projectName);
      const idleHeading = workspaceHeading(workspaces[1]);
      const idleName = idleHeading.querySelector("strong")!.textContent!;
      fireEvent.click(idleHeading);
      expect(idleHeading).toHaveAttribute("aria-expanded", "false");
      expect(idleHeading.textContent).toBe(idleName);
      expect(idleHeading.querySelector("i[title]")).toBeNull();
      initializeI18n("en-US");
    },
  );

  it("opens a session details card from keyboard focus without selecting the session", async () => {
    const user = userEvent.setup();
    render(<SessionDirectory />);
    const entry = screen.getByRole("button", { name: /Check sidebar selection/ });
    await focusByKeyboard(user, entry);
    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveTextContent("Check sidebar selection"),
    );
    const card = screen.getByRole("tooltip");
    expect(card).toHaveTextContent("Check sidebar selection");
    expect(card).toHaveTextContent("Codex");
    expect(card).toHaveTextContent(workspaces[0].path);
    expect(hub.select).not.toHaveBeenCalled();
  });

  it("marks a Project Agent and names it on each of its Workers", async () => {
    const user = userEvent.setup();
    hub.sessions = [
      {
        ...first,
        agent: "claude-code",
        title: "Release plan",
        orchestration: { role: "lead", workers: 1, paused: false },
      },
      { ...second, orchestration: { role: "worker", leadId: first.id, name: "api" } },
    ];
    render(<SessionDirectory />);
    const workerOf = tr("sessions.workerOf", { name: "api", lead: "Release plan" });
    // Marks to be seen, not only read out: outside the row's screen-reader-only details.
    expect(
      screen.getByRole("img", { name: tr("sessions.projectAgent") }).closest(".sr-only"),
    ).toBeNull();
    expect(screen.getByRole("img", { name: workerOf }).closest(".sr-only")).toBeNull();
    // The Worker's details card says whom it works for.
    await focusByKeyboard(user, screen.getByRole("button", { name: /Inspect token layout/ }));
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent(workerOf));
    cleanup();
    hub.sessions = [
      { ...first, orchestration: { role: "lead", workers: 1, paused: true } },
      // Its Project Agent is not in this list.
      { ...second, orchestration: { role: "worker", leadId: "elsewhere", name: "api" } },
    ];
    render(<SessionDirectory />);
    expect(
      screen.getByRole("img", { name: tr("sessions.projectAgentPaused") }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: tr("sessions.workerOf", { name: "api", lead: tr("sessions.projectAgent") }),
      }),
    ).toBeInTheDocument();
  });

  it("shows program-started sessions only after the directory option is turned on", async () => {
    const user = userEvent.setup();
    const pen = { ...second, id: "pen", title: "Pen design run", origin: "execution" as const };
    hub.sessions = [first, pen];
    vi.mocked(useSessionHub).mockImplementation(() => {
      const visibility = { execution: useSessionViewStore.getState().execution };
      const sessions = hub.sessions.filter(
        (session) => session.origin !== "execution" || visibility.execution,
      );
      return {
        ...hub,
        visibility,
        sessions,
        filtered: filterSessions(sessions, hub.workspaces, {
          ...useSessionViewStore.getState(),
          query: "",
        }),
      };
    });
    const { rerender } = render(<SessionDirectory />);
    expect(screen.queryByText("Pen design run")).toBeNull();
    await user.click(screen.getByRole("button", { name: tr("sessions.directoryOptions") }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: tr("sessions.showExecution") }),
    );
    rerender(<SessionDirectory />);
    expect(useSessionViewStore.getState().execution).toBe(true);
    expect(screen.getByRole("button", { name: /Pen design run/ })).toBeInTheDocument();
    expect(
      screen.getAllByRole("img", { name: tr("sessions.executionSession") }).length,
    ).toBeGreaterThan(0);
    await user.click(
      screen.getByRole("button", {
        name: `${tr("sessions.hideExecution")}: ${tr("sessions.executionSession")}`,
      }),
    );
    rerender(<SessionDirectory />);
    expect(useSessionViewStore.getState().execution).toBe(false);
    expect(screen.queryByText("Pen design run")).toBeNull();
  });

  it("moves the single-select Agent filter above the directory and keeps other filters in its menu", async () => {
    const user = userEvent.setup();
    const onMenuOpenChange = vi.fn();
    const { container } = render(<SessionDirectory onMenuOpenChange={onMenuOpenChange} />);
    const agents = within(screen.getByRole("group", { name: tr("conversations.agentFilter") }));
    const all = agents.getByRole("button", { name: tr("sessions.allAgents") });
    const codex = agents.getByRole("button", { name: "Codex" });
    const claude = agents.getByRole("button", { name: "Claude Code" });
    const toolbar = container.querySelector("[data-session-directory-toolbar]")!;
    expect(all.compareDocumentPosition(toolbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Local history")).toBeNull();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    expect(all).toHaveAttribute("aria-pressed", "true");
    claude.focus();
    await user.keyboard("{Enter}");
    expect(claude).toHaveAttribute("aria-pressed", "true");
    expect(codex).toHaveAttribute("aria-pressed", "false");
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    screen.getByRole("button", { name: tr("sessions.directoryOptions") }).focus();
    await user.keyboard("{ArrowDown}");
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true, expect.anything());
    expect(screen.getByRole("menu").parentElement).toHaveClass("z-80");
    expect(
      screen.queryByRole("menuitem", { name: tr("conversations.agentFilter") }),
    ).not.toBeInTheDocument();
    (await screen.findByRole("menuitem", { name: "Session history" })).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getAllByRole("menu").every((menu) => menu.parentElement?.classList.contains("z-80")),
    ).toBe(true);
    (await screen.findByRole("menuitemradio", { name: "No history content" })).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: /Inspect token layout/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Missing transcript/ })).toBeTruthy();
    screen.getByRole("button", { name: tr("sessions.directoryOptions") }).focus();
    await user.keyboard("{ArrowDown}");
    (await screen.findByRole("menuitem", { name: "Reset filters" })).focus();
    await user.keyboard("{Enter}");
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(false, expect.anything());
    expect(useSessionViewStore.getState().agent).toBe("all");
    expect(all).toHaveAttribute("aria-pressed", "true");
    expect(useSessionViewStore.getState().filter).toBe("current");
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
  });

  it.each([
    { kind: "no Agent", sessions: [] },
    { kind: "one Agent", sessions: [first, archived] },
  ])("hides the Agent strip with $kind in the directory", ({ sessions }) => {
    hub.sessions = sessions;
    render(<SessionDirectory />);
    expect(screen.getByRole("button", { name: tr("sessions.directoryOptions") })).toBeVisible();
    expect(
      screen.queryByRole("group", { name: tr("conversations.agentFilter") }),
    ).not.toBeInTheDocument();
  });

  it("resets the hidden Agent filter when its last conversation disappears", () => {
    useSessionViewStore.setState({ agent: "claude-code" });
    const { rerender } = render(<SessionDirectory />);
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    hub.sessions = [first];
    rerender(<SessionDirectory onMenuOpenChange={vi.fn()} />);
    expect(useSessionViewStore.getState().agent).toBe("all");
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeVisible();
  });

  it("clears the Agent independently using the strip and keeps the history filter chip", async () => {
    useSessionViewStore.setState({ agent: "claude-code", filter: "metadata" });
    const user = userEvent.setup();
    render(<SessionDirectory />);
    expect(
      screen.queryByRole("button", { name: `${tr("sessions.clearAgentFilter")}: Claude Code` }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tr("sessions.allAgents") }));
    expect(useSessionViewStore.getState().agent).toBe("all");
    expect(useSessionViewStore.getState().filter).toBe("metadata");
    expect(screen.getByRole("button", { name: /Missing transcript/ })).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: `${tr("sessions.clearRecordFilter")}: No history content`,
      }),
    );
    expect(useSessionViewStore.getState().filter).toBe("current");
    expect(screen.queryByRole("button", { name: /Missing transcript/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
  });

  it("compacts a folder in order and reverses an interrupted Agent filter from its current progress", async () => {
    hub.sessions = [first, first, second, first].map((session, index) => ({
      ...session,
      workspace_id: first.workspace_id,
      id: `entry-${index + 1}`,
      title: `Entry ${index + 1}`,
    }));
    vi.stubGlobal("CSS", { supports: () => true });
    const originalBounds = HTMLElement.prototype.getBoundingClientRect;
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.matches(".session-workspace-heading, .session-directory-row")) {
          const slot = this.parentElement;
          const start =
            Number.parseFloat(slot?.style.getPropertyValue("--directory-agent-fold-from") ?? "") ||
            0;
          const delta =
            Number.parseFloat(slot?.style.getPropertyValue("--directory-agent-fold-delta") ?? "") ||
            0;
          const tree = this.closest<HTMLElement>(".session-directory-tree");
          const progress = Number(
            tree?.style.getPropertyValue("--directory-agent-filter-progress"),
          );
          return new DOMRect(0, start + delta * progress, 200, 32);
        }
        return originalBounds.call(this);
      });
    try {
      const { container } = render(<SessionDirectory />);
      const tree = container.querySelector<HTMLElement>(".session-directory-tree")!;
      const animate = vi.fn(() => {
        let resolve!: () => void;
        const finished = new Promise<void>((done) => {
          resolve = done;
        });
        return { finished, cancel: vi.fn(), resolve };
      });
      Object.defineProperty(tree, "animate", { value: animate });
      const rows = () => Array.from(tree.querySelectorAll<HTMLElement>(".session-directory-row"));

      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
      expect(animate).toHaveBeenCalledTimes(1);
      expect(rows().map((row) => row.dataset.directoryAnchor)).toEqual([
        "session:entry-1",
        "session:entry-2",
        "session:entry-3",
        "session:entry-4",
      ]);
      expect(rows()[2].parentElement).not.toHaveAttribute("data-directory-agent-slot");
      expect(rows()[3].parentElement).toHaveAttribute("inert");
      expect(rows()[3].parentElement).toHaveStyle("--directory-agent-slot-delta: -1");
      expect(rows()[0].parentElement).toHaveStyle("--directory-agent-fold-delta: -16px");
      expect(rows()[3].parentElement).toHaveStyle("--directory-agent-fold-delta: -48px");
      expect(screen.queryByRole("button", { name: /^Entry 4/ })).not.toBeInTheDocument();

      tree.style.setProperty("--directory-agent-filter-progress", "0.5");
      fireEvent.click(screen.getByRole("button", { name: tr("sessions.allAgents") }));
      expect(animate).toHaveBeenCalledTimes(2);
      expect(animate.mock.results[0].value.cancel).toHaveBeenCalledOnce();
      expect(rows()[3].parentElement).toHaveStyle("--directory-agent-slot-start: 0.5");
      expect(rows()[3].parentElement).toHaveStyle("--directory-agent-slot-delta: 0.5");
      expect(rows()[3].parentElement).toHaveStyle("--directory-agent-fold-from: -24px");
      await act(async () => animate.mock.results[0].value.resolve());
      expect(tree).toHaveAttribute("data-directory-agent-motion");
      await act(async () => animate.mock.results[1].value.resolve());
      expect(tree).not.toHaveAttribute("data-directory-agent-motion");
      expect(rows()).toHaveLength(4);
    } finally {
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("applies Agent filtering directly when reduced motion is enabled", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      const { container } = render(<SessionDirectory />);
      const tree = container.querySelector(".session-directory-tree")!;
      const animate = vi.fn();
      Object.defineProperty(tree, "animate", { value: animate });

      fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));

      expect(animate).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
      expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeVisible();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("crossfades direct Agent switches in the same folder and applies the latest choice", () => {
    hub.sessions = [
      first,
      { ...second, workspace_id: first.workspace_id },
      { ...first, id: "devin-only", agent: "devin", title: "Devin conversation" },
    ];
    useSessionViewStore.setState({ agent: "codex" });
    const { container } = render(<SessionDirectory />);
    const tree = container.querySelector(".session-directory-tree")!;
    const heading = workspaceHeading(workspaces[0]);
    const startViewTransition = vi.fn((_options: StartViewTransitionOptions) => ({
      ready: Promise.resolve(),
    }));
    Object.defineProperty(tree, "startViewTransition", { value: startViewTransition });

    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    fireEvent.click(screen.getByRole("button", { name: "Devin" }));
    expect(startViewTransition).toHaveBeenCalledTimes(2);
    const firstUpdate = startViewTransition.mock.calls[0][0];
    const lastUpdate = startViewTransition.mock.calls[1][0];
    expect(lastUpdate.types).toEqual(["directory-agent-switch"]);
    act(() => {
      void lastUpdate.update?.();
      void firstUpdate.update?.();
    });

    expect(workspaceHeading(workspaces[0])).toBe(heading);
    expect(useSessionViewStore.getState().agent).toBe("devin");
    expect(tree).not.toHaveAttribute("data-directory-agent-motion");
    expect(tree.querySelectorAll(".session-directory-row")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Devin conversation/ })).toBeVisible();
  });

  it("shows the arrows for hidden Agents and scrolls without changing the selected Agent", () => {
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get");
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get");
    let contentWidth = 120;
    clientWidth.mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-agent-filter-viewport") ? 120 : 0;
    });
    scrollWidth.mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-agent-filter-viewport") ? contentWidth : 0;
    });
    try {
      const onChange = vi.fn();
      const { container } = render(
        <SessionDirectoryAgentFilter
          agents={["codex", "claude-code", "antigravity", "devin"]}
          unreadAgents={new Set()}
          value="all"
          onChange={onChange}
        />,
      );
      const group = within(screen.getByRole("group", { name: tr("conversations.agentFilter") }));
      const viewport = container.querySelector<HTMLElement>("[data-agent-filter-viewport]")!;
      const scrollBy = vi.fn<(options: ScrollToOptions) => void>();
      Object.defineProperty(viewport, "scrollBy", { value: scrollBy });
      const all = group.getByRole("button", { name: tr("sessions.allAgents") });
      expect(within(viewport).getAllByRole("button")[0]).toBe(all);
      expect(group.queryByRole("button", { name: "Scroll agents left" })).not.toBeInTheDocument();
      expect(group.queryByRole("button", { name: "Scroll agents right" })).not.toBeInTheDocument();

      contentWidth = 240;
      fireEvent.scroll(viewport);
      expect(group.queryByRole("button", { name: "Scroll agents left" })).not.toBeInTheDocument();
      fireEvent.click(group.getByRole("button", { name: "Scroll agents right" }));
      expect(scrollBy.mock.calls[0]?.[0].left).toBeGreaterThan(0);

      fireEvent.scroll(viewport, { target: { scrollLeft: 64 } });
      fireEvent.click(group.getByRole("button", { name: "Scroll agents left" }));
      expect(scrollBy.mock.calls[1]?.[0].left).toBeLessThan(0);
      expect(group.getByRole("button", { name: "Scroll agents right" })).toBeVisible();

      fireEvent.scroll(viewport, { target: { scrollLeft: 120 } });
      expect(group.queryByRole("button", { name: "Scroll agents right" })).not.toBeInTheDocument();
      expect(group.getByRole("button", { name: "Scroll agents left" })).toBeVisible();
      expect(all).toHaveAttribute("aria-pressed", "true");
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      clientWidth.mockRestore();
      scrollWidth.mockRestore();
    }
  });

  it("collapses one workspace independently and preserves expansion across remounts", () => {
    const { unmount } = render(<SessionDirectory />);
    const heading = workspaceHeading(workspaces[0]);
    expect(heading.querySelector(".lucide-folder-open")).not.toBeNull();
    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(heading.querySelector(".lucide-folder")).not.toBeNull();
    expect(heading.querySelector(".lucide-folder-open")).toBeNull();
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    expect(useSessionViewStore.getState().collapsed).toEqual({ "workspace-a": true });
    unmount();
    render(<SessionDirectory />);
    expect(workspaceHeading(workspaces[0])).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(workspaceHeading(workspaces[0]));
    expect(workspaceHeading(workspaces[0]).querySelector(".lucide-folder-open")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
  });

  it("supports keyboard collapse and rapid reversal without losing the selected session", async () => {
    const user = userEvent.setup();
    render(<SessionDirectory />);
    const heading = workspaceHeading(workspaces[0]);
    const panelId = heading.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    heading.focus();
    await user.keyboard("{Enter}");
    expect(heading).toHaveAttribute("aria-expanded", "false");
    expect(heading).toHaveFocus();
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    const closingPanel = document.getElementById(panelId!);
    if (closingPanel) {
      expect(closingPanel).toHaveAttribute("inert");
      expect(closingPanel).toHaveAttribute("aria-hidden", "true");
    }
    fireEvent.click(heading);
    fireEvent.click(heading);
    fireEvent.click(heading);
    expect(heading).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(panelId!)).not.toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(hub.select).not.toHaveBeenCalled();
  });

  it("restores the directory scroll position and records subsequent scrolling", () => {
    useSessionViewStore.setState({ scrollTop: 180 });
    const { container, unmount } = render(<SessionDirectory />);
    const tree = container.querySelector<HTMLDivElement>(".session-directory-tree")!;
    const header = container.querySelector(".session-directory-header")!;
    expect(tree.scrollTop).toBe(180);
    expect(header).toHaveAttribute("data-scrolled", "true");
    fireEvent.scroll(tree, { target: { scrollTop: 240 } });
    expect(useSessionViewStore.getState().scrollTop).toBe(240);
    unmount();
    const remount = render(<SessionDirectory />);
    expect(
      remount.container.querySelector<HTMLDivElement>(".session-directory-tree")?.scrollTop,
    ).toBe(240);
    expect(remount.container.querySelector(".session-directory-header")).toHaveAttribute(
      "data-scrolled",
      "true",
    );
  });

  it("shows the header divider only while the directory is away from the top", () => {
    const { container } = render(<SessionDirectory />);
    const tree = container.querySelector<HTMLDivElement>(".session-directory-tree")!;
    const header = container.querySelector(".session-directory-header")!;
    expect(header).toHaveAttribute("data-scrolled", "false");
    fireEvent.scroll(tree, { target: { scrollTop: 1 } });
    expect(header).toHaveAttribute("data-scrolled", "true");
    fireEvent.scroll(tree, { target: { scrollTop: 0 } });
    expect(header).toHaveAttribute("data-scrolled", "false");
    fireEvent.scroll(tree, { target: { scrollTop: -1 } });
    expect(header).toHaveAttribute("data-scrolled", "false");
  });

  it("preserves the saved scroll position until the directory is ready", () => {
    hub = { ...hub, ready: false, usable: false };
    useSessionViewStore.setState({ scrollTop: 180 });
    const { container, rerender } = render(<SessionDirectory />);
    const tree = container.querySelector<HTMLDivElement>(".session-directory-tree")!;
    const header = container.querySelector(".session-directory-header")!;
    expect(tree.scrollTop).toBe(0);
    expect(header).toHaveAttribute("data-scrolled", "false");
    fireEvent.scroll(tree);
    expect(useSessionViewStore.getState().scrollTop).toBe(180);
    hub = { ...hub, ready: true, usable: true };
    rerender(<SessionDirectory />);
    expect(tree.scrollTop).toBe(180);
    expect(header).toHaveAttribute("data-scrolled", "true");
  });

  it("restores cached scroll and expansion before the background scan completes", () => {
    hub = { ...hub, ready: false, usable: true, refreshing: true, loading: false };
    useSessionViewStore.setState({ scrollTop: 180, collapsed: { [workspaces[1].id]: true } });
    const { container, rerender } = render(<SessionDirectory />);
    const tree = container.querySelector<HTMLDivElement>(".session-directory-tree")!;
    const firstRow = screen.getByRole("button", { name: first.title });
    expect(tree.scrollTop).toBe(180);
    expect(workspaceHeading(workspaces[1])).toHaveAttribute("aria-expanded", "false");
    hub = { ...hub, ready: true, refreshing: false };
    rerender(<SessionDirectory />);
    expect(screen.getByRole("button", { name: first.title })).toBe(firstRow);
    expect(tree.scrollTop).toBe(180);
    expect(workspaceHeading(workspaces[1])).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a visible conversation anchored when new records arrive above it", () => {
    let insertedHeight = 0;
    let tree: HTMLDivElement;
    const original = HTMLElement.prototype.getBoundingClientRect;
    const geometry = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("session-directory-tree"))
          return {
            top: 0,
            bottom: 400,
            left: 0,
            right: 300,
            width: 300,
            height: 400,
            x: 0,
            y: 0,
            toJSON() {},
          };
        if (this.dataset.directoryAnchor === `session:${first.id}`) {
          const top = 20 + insertedHeight - ((tree?.scrollTop ?? 180) - 180);
          return {
            top,
            bottom: top + 32,
            left: 0,
            right: 300,
            width: 300,
            height: 32,
            x: 0,
            y: top,
            toJSON() {},
          };
        }
        return original.call(this);
      });
    useSessionViewStore.setState({ scrollTop: 180 });
    const { container, rerender } = render(<SessionDirectory />);
    tree = container.querySelector<HTMLDivElement>(".session-directory-tree")!;
    fireEvent.scroll(tree);
    const row = screen.getByRole("button", { name: first.title });
    insertedHeight = 32;
    const newer = {
      ...first,
      id: "newer",
      title: "A newly arrived conversation",
      updated_at: "2026-11-03T18:00:00Z",
    };
    hub = { ...hub, sessions: [newer, ...hub.sessions], filtered: [newer, ...hub.filtered] };
    rerender(<SessionDirectory />);
    expect(screen.getByRole("button", { name: first.title })).toBe(row);
    expect(tree.scrollTop).toBe(212);
    expect(row.closest("[data-directory-anchor]")!.getBoundingClientRect().top).toBe(20);
    geometry.mockRestore();
  });

  it("disables filtering when indexing is disabled", () => {
    hub = { ...hub, enabled: false, sessions: [], selected: undefined };
    render(<SessionDirectory />);
    expect(screen.getByRole("button", { name: tr("sessions.directoryOptions") })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Refresh history" })).toBeNull();
    expect(hub.refresh).not.toHaveBeenCalled();
    expect(screen.queryByText("No session history found")).toBeNull();
  });

  it("does not show a directory refresh action", () => {
    const { rerender } = render(<SessionDirectory />);
    expect(screen.queryByRole("button", { name: "Refresh history" })).toBeNull();
    hub = { ...hub, refreshing: true };
    rerender(<SessionDirectory />);
    expect(screen.queryByRole("button", { name: /Refresh history|Scanning/ })).toBeNull();
    expect(hub.refresh).not.toHaveBeenCalled();
  });

  it("keeps host groups contiguous when an unrecorded workspace appears", () => {
    const orderedWorkspaces = [
      { id: "local-a", name: "Local A", path: "/local/a" },
      {
        id: "remote-x",
        name: "Remote X",
        path: "/remote/x",
        remote: {
          host_id: "host-x",
          host_name: "Remote host",
          online: true,
          original_id: "x",
          last_synced_at: "",
        },
      },
      { id: "local-b", name: "Local B", path: "/local/b" },
    ] as WorkspaceSummary[];
    const sessions = orderedWorkspaces.map((workspace) => ({
      ...first,
      id: `session-${workspace.id}`,
      workspace_id: workspace.id,
      title: workspace.name,
    }));
    useSessionViewStore.setState({ workspaceOrder: ["local-a", "remote-x"] });
    hub = {
      ...hub,
      remoteHosts: [
        {
          id: "host-x",
          name: "Remote host",
          address: "http://remote.test",
          status: "online",
          last_seen: null,
          error: null,
        },
      ],
      workspaces: orderedWorkspaces,
      sessions,
      selected: sessions[0],
      selectedWorkspace: orderedWorkspaces[0],
    };

    const { container } = render(<SessionDirectory />);

    expect(orderedWorkspacePaths(container)).toEqual(["/local/a", "/local/b", "/remote/x"]);
    expect(
      Array.from(container.querySelectorAll(".session-host-heading strong")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["This device", "Remote host"]);
  });

  it("keeps hidden workspace order entries when reordering a filtered view", () => {
    const thirdWorkspace = {
      id: "workspace-c",
      name: "API kit",
      path: "/projects/api",
    } as WorkspaceSummary;
    const thirdSession = {
      ...first,
      id: "third",
      workspace_id: thirdWorkspace.id,
      title: "API work",
    };
    useSessionViewStore.setState({
      agent: "codex",
      workspaceOrder: ["workspace-a", "workspace-b", thirdWorkspace.id],
    });
    hub = {
      ...hub,
      workspaces: [...workspaces, thirdWorkspace],
      sessions: [...hub.sessions, thirdSession],
    };
    const { container } = render(<SessionDirectory />);
    dragEntry(workspaceHeading(thirdWorkspace), workspaceHeading(workspaces[0]));

    expect(useSessionViewStore.getState().workspaceOrder).toEqual([
      thirdWorkspace.id,
      "workspace-a",
      "workspace-b",
    ]);
    act(() => useSessionViewStore.getState().setAgent("all"));
    expect(orderedWorkspacePaths(container)).toEqual([
      "/projects/api",
      workspaces[0].path,
      workspaces[1].path,
    ]);
  });

  it("preserves an ordered workspace while its sessions have not loaded yet", () => {
    const pendingWorkspace = {
      id: "workspace-pending",
      name: "Pending workspace",
      path: "/projects/pending",
    } as WorkspaceSummary;
    const loadedWorkspace = {
      id: "workspace-loaded",
      name: "Loaded workspace",
      path: "/projects/loaded",
    } as WorkspaceSummary;
    const thirdWorkspace = {
      id: "workspace-third",
      name: "Third workspace",
      path: "/projects/third",
    } as WorkspaceSummary;
    const loadedSession = {
      ...first,
      id: "loaded-session",
      workspace_id: loadedWorkspace.id,
    };
    const thirdSession = {
      ...first,
      id: "third-session",
      workspace_id: thirdWorkspace.id,
    };
    useSessionViewStore.setState({
      workspaceOrder: [pendingWorkspace.id, loadedWorkspace.id, thirdWorkspace.id],
    });
    hub = {
      ...hub,
      workspaces: [pendingWorkspace, loadedWorkspace, thirdWorkspace],
      sessions: [loadedSession, thirdSession],
      selected: loadedSession,
      selectedWorkspace: loadedWorkspace,
    };

    const { container, rerender } = render(<SessionDirectory />);
    dragEntry(workspaceHeading(thirdWorkspace), workspaceHeading(loadedWorkspace));

    expect(useSessionViewStore.getState().workspaceOrder).toEqual([
      pendingWorkspace.id,
      thirdWorkspace.id,
      loadedWorkspace.id,
    ]);

    hub = {
      ...hub,
      sessions: [
        { ...first, id: "pending-session", workspace_id: pendingWorkspace.id },
        ...hub.sessions,
      ],
    };
    rerender(<SessionDirectory />);
    expect(orderedWorkspacePaths(container)).toEqual([
      pendingWorkspace.path,
      thirdWorkspace.path,
      loadedWorkspace.path,
    ]);
  });

  it("does not reorder workspaces across remote hosts", () => {
    const remoteWorkspace = {
      id: "remote-workspace",
      name: "Remote workspace",
      path: "/remote/workspace",
      remote: {
        host_id: "host-x",
        host_name: "Remote host",
        online: true,
        original_id: "remote-workspace",
        last_synced_at: "",
      },
    } as WorkspaceSummary;
    const remoteSession = { ...first, id: "remote-session", workspace_id: remoteWorkspace.id };
    hub = {
      ...hub,
      remoteHosts: [
        {
          id: "host-x",
          name: "Remote host",
          address: "http://remote.test",
          status: "online",
          last_seen: null,
          error: null,
        },
      ],
      workspaces: [...workspaces, remoteWorkspace],
      sessions: [...hub.sessions, remoteSession],
    };
    useSessionViewStore.setState({ workspaceOrder: ["workspace-a", "workspace-b"] });
    const { container } = render(<SessionDirectory />);
    const beforeOrder = [...useSessionViewStore.getState().workspaceOrder];
    dragEntry(workspaceHeading(workspaces[0]), workspaceHeading(remoteWorkspace), true);

    expect(useSessionViewStore.getState().workspaceOrder).toEqual(beforeOrder);
    expect(orderedWorkspacePaths(container)).toEqual([
      workspaces[0].path,
      workspaces[1].path,
      "/remote/workspace",
    ]);
  });

  it("keeps newly discovered sessions ahead of manually ordered sessions", () => {
    const recent = { ...first, id: "recent", title: "New session" };
    hub = { ...hub, sessions: [recent, first, second, archived, metadata] };
    useSessionViewStore.setState({ sessionOrder: { "workspace-a": [first.id] } });
    render(<SessionDirectory />);

    const entries = screen.getAllByRole("button", { name: /New session|Check sidebar selection/ });
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual([
      expect.stringContaining("New session"),
      expect.stringContaining("Check sidebar selection"),
    ]);
  });

  it("keeps pinned sessions ahead of manual order and rejects crossing that boundary", () => {
    const pin = { ...first, id: "pin", title: "Pinned session", pinned: true };
    const normal = { ...first, id: "normal", title: "Unpinned session" };
    hub = { ...hub, sessions: [normal, pin, first] };
    const prior = [normal.id, first.id, pin.id];
    useSessionViewStore.setState({ sessionOrder: { "workspace-a": prior } });
    render(<SessionDirectory />);
    const buttons = screen.getAllByRole("button", {
      name: /Pinned session|Unpinned session|Check sidebar selection/,
    });
    expect(buttons[0]).toHaveTextContent("Pinned session");
    expect(buttons[1]).toHaveTextContent("Unpinned session");
    dragEntry(buttons[0]!, buttons[1]!, true);
    fireEvent.keyDown(buttons[0]!, { altKey: true, key: "ArrowDown" });
    expect(useSessionViewStore.getState().sessionOrder["workspace-a"]).toEqual(prior);
  });

  it("normalizes saved workspace and session IDs before persisting a drag order", () => {
    expect(
      normalizeDirectoryOrder(
        ["deleted", "workspace-a", "workspace-a"],
        ["workspace-a", "workspace-b"],
      ),
    ).toEqual(["workspace-a", "workspace-b"]);
    useSessionViewStore.setState({
      filter: "all",
      workspaceOrder: ["deleted", "workspace-a", "workspace-a"],
      sessionOrder: { "workspace-a": ["deleted", first.id, first.id] },
    });
    const { getByRole } = render(<SessionDirectory />);
    dragEntry(workspaceHeading(workspaces[1]), workspaceHeading(workspaces[0]), true);
    dragEntry(
      getByRole("button", { name: /Previous icon review/ }),
      getByRole("button", { name: /Check sidebar selection/ }),
    );

    expect(useSessionViewStore.getState().workspaceOrder).toEqual(["workspace-b", "workspace-a"]);
    expect(useSessionViewStore.getState().sessionOrder["workspace-a"]).toEqual([
      "archived",
      "first",
    ]);
    expect(JSON.parse(localStorage.getItem("agentkib.session-directory-order") ?? "{}")).toEqual({
      workspaceOrder: ["workspace-b", "workspace-a"],
      sessionOrder: { "workspace-a": ["archived", "first"] },
    });
  });
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "labels a verified old Codex runtime in the actual sidebar in %s",
    (locale) => {
      initializeI18n(locale);
      hub.sessions = [
        { ...first, continuation: { status: "unsupported", reason: "codex-cli-version-too-old" } },
      ];
      render(<SessionDirectory />);
      expect(screen.getByText(sessionContinuationCopy(locale).viewOnly)).toBeVisible();
      initializeI18n("en-US");
    },
  );
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows runtime status in recent sessions and distinct sidebar dots in %s",
    (locale) => {
      initializeI18n(locale);
      const copy = sessionContinuationCopy(locale);
      hub.sessions = [
        { ...first, id: "idle", title: "Idle" },
        {
          ...first,
          id: "running",
          title: "Running",
          continuation: { status: "starting", executionLocation: "agentkib" },
        },
        {
          ...second,
          id: "terminal",
          title: "Connected",
          continuation: { status: "idle", executionLocation: "terminal" },
        },
        {
          ...second,
          id: "busy",
          title: "External",
          continuation: {
            status: "idle",
            executionLocation: "external",
            ownershipReason: "claude-owner-busy",
          },
        },
        {
          ...second,
          id: "unsupported",
          title: "Unsupported",
          continuation: { status: "unsupported", reason: "platform-unsupported" },
        },
      ];
      const overview = render(<SessionOverview />);
      expect(screen.getByText(copy.running)).toBeVisible();
      expect(screen.getByText(copy.terminalBadge)).toBeVisible();
      // Use elsewhere is confirmed after opening a session, never guessed in the list.
      expect(screen.queryByText(copy.busy("Claude Code"))).toBeNull();
      expect(screen.getByText(copy.viewOnly)).toBeVisible();
      expect(overview.container.querySelectorAll('[role="status"]')).toHaveLength(3);
      overview.unmount();
      render(<SessionDirectory />);
      const runningSession = screen.getByRole("button", { name: /^Running/ });
      // A running turn turns, as on the phone.
      expect(within(runningSession).getByTitle(copy.running)).toHaveClass("animate-spin");
      const terminalSession = screen.getByRole("button", { name: /^Connected/ });
      expect(within(terminalSession).getByTitle(copy.terminalBadge)).toHaveClass(
        "bg-muted-foreground",
      );
      expect(screen.queryByRole("status", { name: copy.busy("Claude Code") })).toBeNull();
      expect(screen.queryByRole("status", { name: copy.viewOnly })).toBeNull();
      initializeI18n("en-US");
    },
  );
});
