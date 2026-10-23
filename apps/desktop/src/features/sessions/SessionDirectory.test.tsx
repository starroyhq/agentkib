// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { sessionContinuationCopy } from "@agentkib/session-ui";
import { SessionOverview } from "./SessionOverview";
import { SessionDirectory } from "./SessionDirectory";
import { useSessionHub } from "./SessionHubContext";
import { filterSessions } from "./session-catalog";
import { normalizeDirectoryOrder, useSessionViewStore } from "./session-view-store";

vi.mock("@/features/home/home-query", async (original) => ({
  ...(await original<typeof import("@/features/home/home-query")>()),
  useHomeInstallations: () => ({ data: [{ agent: "antigravity", installed: true }] }),
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span aria-hidden="true">{agent} icon</span>,
}));

const workspaces = [
  { id: "workspace-a", name: "Design kit", path: "/projects/first/design-kit" },
  { id: "workspace-b", name: "Design kit", path: "/projects/second/design-kit" },
] as WorkspaceSummary[];
const first: ConversationSessionSummary = {
  id: "first",
  workspace_id: "workspace-a",
  agent: "codex",
  title: "Check sidebar selection",
  availability: "readable",
  archived: false,
  sidechain: false,
};
const second: ConversationSessionSummary = {
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
let hub: ReturnType<typeof useSessionHub>;

function workspaceHeading(workspace: WorkspaceSummary) {
  return screen.getByTitle(`${workspace.name}\n${workspace.path}`, {
    normalizer: (value) => value,
  });
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
  ).map((heading) => heading.closest("button")?.getAttribute("title")?.split("\n")[1]);
}

describe("SessionDirectory", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.removeItem("agentkib.session-directory-order");
    useSessionViewStore.setState({
      agent: "all",
      host: "all",
      filter: "current",
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
      historyRevision: 0,
      conversationRefreshRevision: 0,
      runtimeReady: true,
      enabled: true,
      workspacesLoading: false,
      workspacesError: "",
      catalogError: "",
      hiddenSessionNotice: false,
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
      }),
    }));
  });
  afterEach(cleanup);

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
    const { container } = render(<SessionDirectory />);
    const text = tr("sessions.sourceUnavailable", { agent: "Antigravity" });
    expect(screen.getByText(text).closest(".session-directory-tree")).toBe(
      container.querySelector(".session-directory-tree"),
    );
    expect(screen.queryByText("Visible source")).toBeNull();
    expect(screen.queryByText("Uninstalled source")).toBeNull();
    act(() => useSessionViewStore.getState().setAgent("claude-code"));
    expect(screen.queryByText(text)).toBeNull();
    act(() => {
      useSessionViewStore.getState().setAgent("all");
      useSessionViewStore.getState().setHost("remote-fixture");
    });
    expect(screen.queryByText(text)).toBeNull();
  });

  it("does not carry another computer's source warning into the selected computer", () => {
    hub.sessions = [];
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
    act(() => useSessionViewStore.getState().setAgent("codex"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["zh-CN", "有历史内容", "无历史内容"],
    ["zh-TW", "有歷史內容", "無歷史內容"],
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
    expect(current.getAttribute("title")).toContain("Codex ·");
    expect(current.getAttribute("title")).toContain(workspaces[0].path);
    const other = screen.getByRole("button", { name: /Inspect token layout/ });
    expect(other).not.toHaveAttribute("aria-current");
    fireEvent.click(other);
    expect(hub.select).toHaveBeenCalledWith(second.id);
  });

  it("keeps search and filter fields out of the directory and exposes filters in its menu", async () => {
    const user = userEvent.setup();
    const onMenuOpenChange = vi.fn();
    render(<SessionDirectory onMenuOpenChange={onMenuOpenChange} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Local history")).toBeNull();
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    screen.getByRole("button", { name: tr("sessions.directoryOptions") }).focus();
    await user.keyboard("{ArrowDown}");
    expect(onMenuOpenChange).toHaveBeenLastCalledWith(true, expect.anything());
    expect(screen.getByRole("menu").parentElement).toHaveClass("z-80");
    (await screen.findByRole("menuitem", { name: "Agent filter" })).focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("menuitemradio", { name: "All agents" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getAllByRole("menu").every((menu) => menu.parentElement?.classList.contains("z-80")),
    ).toBe(true);
    screen.getByRole("menuitemradio", { name: "Claude Code" }).focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: /Check sidebar selection/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Inspect token layout/ })).toBeTruthy();
    screen.getByRole("button", { name: tr("sessions.directoryOptions") }).focus();
    await user.keyboard("{ArrowDown}");
    (await screen.findByRole("menuitem", { name: "Session history" })).focus();
    await user.keyboard("{ArrowRight}");
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
    expect(useSessionViewStore.getState().filter).toBe("current");
    expect(screen.getByRole("button", { name: /Check sidebar selection/ })).toBeTruthy();
  });

  it("shows non-default filter chips and clears them independently", async () => {
    useSessionViewStore.setState({ agent: "claude-code", filter: "metadata" });
    const user = userEvent.setup();
    render(<SessionDirectory />);
    await user.click(
      screen.getByRole("button", { name: `${tr("sessions.clearAgentFilter")}: Claude Code` }),
    );
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
    expect(tree.scrollTop).toBe(180);
    fireEvent.scroll(tree, { target: { scrollTop: 240 } });
    expect(useSessionViewStore.getState().scrollTop).toBe(240);
    unmount();
    const remount = render(<SessionDirectory />);
    expect(
      remount.container.querySelector<HTMLDivElement>(".session-directory-tree")?.scrollTop,
    ).toBe(240);
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
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
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
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
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
      expect(within(runningSession).getByTitle(copy.running)).toHaveClass("bg-primary");
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
