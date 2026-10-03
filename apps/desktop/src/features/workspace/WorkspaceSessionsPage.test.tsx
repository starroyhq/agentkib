// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type {
  ConversationSessionSummary,
  CursorBridgeStatus,
  WorkspaceSummary,
} from "@/core/types";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { WorkspaceSessionsPage } from "./WorkspaceSessionsPage";

vi.mock("@/core/api", () => ({
  api: {
    claudeRequest: vi.fn(),
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    sessionEvents: vi.fn(),
    sessionSourceCapability: vi.fn(),
    nativeImportOperations: vi.fn(),
    cursorBridge: vi.fn(),
    cursorBridgeBundle: vi.fn(),
    revealCursorBridgeBundle: vi.fn(),
  },
}));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

const workspace = { id: "workspace", name: "Workspace" } as WorkspaceSummary;
const cachedSession = {
  id: "cached-session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Cached continuation",
  archived: false,
  sidechain: false,
  availability: "readable",
  message_count: null,
} as ConversationSessionSummary;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("WorkspaceSessionsPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.sessionSourceCapability).mockResolvedValue({ status: "supported" });
    vi.mocked(api.nativeImportOperations).mockResolvedValue([]);
    useSessionViewStore.getState().resetFilters();
    vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession]);
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession]);
    vi.mocked(api.sessionEvents).mockResolvedValue({ events: [], warnings: [] });
    vi.mocked(api.cursorBridge).mockResolvedValue({
      supported: true,
      supportedVersions: ["3.22.12", "3.23.12"],
      bindings: [],
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("connects the first Cursor profile in an empty workspace and scans its history only once", async () => {
    const ideSession = {
      ...cachedSession,
      id: "cursor-ide-session",
      agent: "cursor",
      title: "First Cursor IDE history",
    } satisfies ConversationSessionSummary;
    let status: CursorBridgeStatus = {
      supported: true,
      supportedVersions: ["3.22.12", "3.23.12"],
      bindings: [],
    };
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation(async (_, force) =>
      force ? [ideSession] : [],
    );
    vi.mocked(api.cursorBridge).mockImplementation(async (request) =>
      request.action === "connect"
        ? { challenge: "synthetic-first-connection", expires_in_seconds: 120 }
        : status,
    );
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={[]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a Cursor window" }));
    const dialog = await screen.findByRole("dialog", { name: "Cursor IDE · normal window" });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Connect a Cursor window" })).toBeEnabled(),
    );
    expect(api.nativeImportOperations).toHaveBeenCalledWith(workspace.id);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect a Cursor window" }));
    });
    expect(api.cursorBridge).toHaveBeenCalledWith({
      action: "connect",
      workspaceId: workspace.id,
    });
    expect(
      within(dialog).getByRole("textbox", { name: "One-time local connection code" }),
    ).toHaveValue("synthetic-first-connection");
    status = {
      ...status,
      bindings: [
        { id: "first-binding", profile: "explicit-profile", version: "3.22.12", connected: true },
      ],
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(2);
    expect(api.refreshWorkspaceSessions).toHaveBeenLastCalledWith(workspace.id, true);
    expect(api.sessionEvents).toHaveBeenCalledWith(ideSession.id);
    expect(
      within(dialog).queryByRole("textbox", { name: "One-time local connection code" }),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Refresh connections" }));
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(await screen.findByRole("heading", { name: ideSession.title! })).toBeVisible();
  });

  it("does not scan again just by opening an already connected Cursor profile", async () => {
    vi.mocked(api.cursorBridge).mockResolvedValue({
      supported: true,
      supportedVersions: ["3.22.12", "3.23.12"],
      bindings: [
        {
          id: "existing-binding",
          profile: "explicit-profile",
          version: "3.22.12",
          connected: true,
        },
      ],
    });
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={[]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a Cursor window" }));
    await waitFor(() => expect(api.cursorBridge).toHaveBeenCalledTimes(1));
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(1);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith(workspace.id, false);
  });

  it("keeps the first connection gated by the Runtime's actual platform capability", async () => {
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([]);
    vi.mocked(api.cursorBridge).mockResolvedValue({
      supported: false,
      supportedVersions: ["3.22.12", "3.23.12"],
      bindings: [],
    });
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={[]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Connect a Cursor window" }));
    const dialog = await screen.findByRole("dialog", { name: "Cursor IDE · normal window" });
    expect(
      await within(dialog).findByText(
        "Cursor IDE native import currently supports macOS with Cursor 3.22.12 or 3.23.12.",
      ),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Connect a Cursor window" })).toBeDisabled();
    expect(
      vi.mocked(api.cursorBridge).mock.calls.every(([request]) => request.action === "status"),
    ).toBe(true);
  });

  it("does not offer a local Cursor bridge for an empty remote workspace", async () => {
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([]);
    render(
      <WorkspaceSessionsPage
        workspace={{ ...workspace, remote: {} as NonNullable<WorkspaceSummary["remote"]> }}
        enabled
        targetAgents={[]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    await screen.findByLabelText("Refresh sessions");
    expect(screen.queryByRole("button", { name: "Connect a Cursor window" })).toBeNull();
    expect(api.cursorBridge).not.toHaveBeenCalled();
  });

  it("clears the connection dialog and ignores a late pairing status after switching workspaces", async () => {
    const lateStatus = deferred<CursorBridgeStatus>();
    const remote = {
      ...workspace,
      id: "remote-workspace",
      remote: {} as NonNullable<WorkspaceSummary["remote"]>,
    };
    let statusRequests = 0;
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([]);
    vi.mocked(api.cursorBridge).mockImplementation(async (request) => {
      if (request.action === "connect") {
        return { challenge: "synthetic-first-connection", expires_in_seconds: 120 };
      }
      return ++statusRequests === 1
        ? { supported: true, supportedVersions: ["3.22.12", "3.23.12"], bindings: [] }
        : lateStatus.promise;
    });
    const props = {
      enabled: true,
      targetAgents: [],
      onRuntimeChanged: vi.fn(),
      onHandoffPlanned: vi.fn(),
      onMcpConnectionPlanned: vi.fn(),
    };
    const view = render(<WorkspaceSessionsPage workspace={workspace} {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect a Cursor window" }));
    const dialog = await screen.findByRole("dialog", { name: "Cursor IDE · normal window" });
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "Connect a Cursor window" })).toBeEnabled(),
    );
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Connect a Cursor window" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusRequests).toBe(2);
    await act(async () => {
      view.rerender(<WorkspaceSessionsPage workspace={remote} {...props} />);
    });
    await act(async () => {
      lateStatus.resolve({
        supported: true,
        supportedVersions: ["3.22.12", "3.23.12"],
        bindings: [
          { id: "late-binding", profile: "explicit-profile", version: "3.22.12", connected: true },
        ],
      });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "One-time local connection code" })).toBeNull();
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(2);
    expect(api.refreshWorkspaceSessions).toHaveBeenLastCalledWith(remote.id, false);
    expect(vi.mocked(api.refreshWorkspaceSessions).mock.calls.every(([, force]) => !force)).toBe(
      true,
    );
    expect(
      vi
        .mocked(api.cursorBridge)
        .mock.calls.every(([request]) => request.workspaceId === workspace.id),
    ).toBe(true);
    await act(async () => {
      view.rerender(<WorkspaceSessionsPage workspace={workspace} {...props} />);
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(statusRequests).toBe(2);
  });

  it("opens the Claude panel from the workspace without creating a model request", async () => {
    vi.mocked(api.claudeRequest).mockImplementation(async (input) => {
      if (input.operation === "options") return { available: true, workspaces: [workspace] };
      if (input.operation === "catalog") return { sessions: [], workspaces: [workspace] };
      throw new Error(`unexpected_claude_operation:${input.operation}`);
    });
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Claude Code" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "New Claude task" })).toBeEnabled(),
    );
    expect(api.claudeRequest).toHaveBeenCalledWith({ operation: "options" });
    expect(api.claudeRequest).toHaveBeenCalledWith({ operation: "catalog" });
    expect(
      vi
        .mocked(api.claudeRequest)
        .mock.calls.every(
          ([input]) => input.operation === "options" || input.operation === "catalog",
        ),
    ).toBe(true);
  });

  it("shows cached sessions before a non-forced background refresh", async () => {
    const background = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(background.promise);

    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    expect((await screen.findAllByText("Cached continuation")).length).toBeGreaterThan(0);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith(workspace.id, false);

    background.resolve([cachedSession]);
    await waitFor(() =>
      expect((screen.getByLabelText("Refresh sessions") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it.each(["open-claw", "hermes", "grok-build"] as const)(
    "allows %s history when its concrete format is supported",
    async (agent) => {
      const source = {
        ...cachedSession,
        id: `${agent}-session`,
        agent,
        title: `${agent} history`,
      } satisfies ConversationSessionSummary;
      vi.mocked(api.workspaceSessions).mockResolvedValue([source]);
      vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([source]);
      vi.mocked(api.sessionEvents).mockResolvedValue({
        events: [
          {
            id: `${agent}-event`,
            kind: "agent-message",
            content: `${agent} history content`,
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      });

      render(
        <WorkspaceSessionsPage
          workspace={workspace}
          enabled
          targetAgents={["grok-build"]}
          onRuntimeChanged={vi.fn()}
          onHandoffPlanned={vi.fn()}
          onMcpConnectionPlanned={vi.fn()}
        />,
      );

      expect(await screen.findByText(`${agent} history content`)).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Continue in another Agent" })).toBeEnabled(),
      );
    },
  );

  it("uses the shared auxiliary toggle consistently with the visible workspace count", async () => {
    const user = userEvent.setup();
    const auxiliary = {
      ...cachedSession,
      id: "auxiliary-session",
      title: "Auxiliary continuation",
      origin: "auxiliary" as const,
      spawned_by_session_id: cachedSession.id,
    };
    vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession, auxiliary]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession, auxiliary]);
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    expect(await screen.findAllByText("Cached continuation")).not.toHaveLength(0);
    expect(screen.queryByText("Auxiliary continuation")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Session history" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Show auxiliary sessions" }),
    );
    expect(useSessionViewStore.getState().showAuxiliary).toBe(true);
    expect(await screen.findByText("Auxiliary continuation")).toBeTruthy();
  });

  it.each([
    ["antigravity", "Antigravity"],
    ["opencode", "OpenCode"],
    ["open-claw", "OpenClaw"],
    ["hermes", "Hermes"],
    ["grok-build", "Grok Build"],
  ] as const)(
    "filters mixed history by %s and can return to all providers",
    async (agent, label) => {
      const source = { ...cachedSession, id: agent, agent, title: `${label} conversation` };
      vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession, source]);
      vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession, source]);
      render(
        <WorkspaceSessionsPage
          workspace={workspace}
          enabled
          targetAgents={["claude-code"]}
          onRuntimeChanged={vi.fn()}
          onHandoffPlanned={vi.fn()}
          onMcpConnectionPlanned={vi.fn()}
        />,
      );
      await screen.findByText(`${label} conversation`);
      await waitFor(() => expect(screen.getByLabelText("Refresh sessions")).not.toBeDisabled());
      fireEvent.click(screen.getByRole("button", { name: "Agent filter" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: label }));
      await waitFor(() => expect(screen.queryByText("Cached continuation")).toBeNull());
      expect(screen.getAllByText(`${label} conversation`).length).toBeGreaterThan(0);
      fireEvent.click(screen.getByRole("button", { name: "Agent filter" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "All Agents" }));
      expect((await screen.findAllByText("Cached continuation")).length).toBeGreaterThan(0);
    },
  );

  it("only uses a forced scan for manual refresh", async () => {
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession]);
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    const refresh = await screen.findByLabelText("Refresh sessions");
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(refresh);

    await waitFor(() =>
      expect(api.refreshWorkspaceSessions).toHaveBeenLastCalledWith(workspace.id, true),
    );
  });

  it("preserves interactive fork identity and exposes its source in hover/detail", async () => {
    const creator = {
      ...cachedSession,
      id: "creator-session",
      title: "Creator session",
    };
    const fork = {
      ...cachedSession,
      id: "forked-session",
      title: "Forked continuation",
      origin: "interactive" as const,
      spawned_by_session_id: creator.id,
      forked_from_session_id: cachedSession.id,
      created_at: "2026-09-07T00:00:00Z",
    };
    vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession, creator, fork]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession, creator, fork]);
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    const forkTitle = await screen.findByText("Forked continuation");
    fireEvent.click(screen.getByRole("button", { name: "Search session titles" }));
    fireEvent.change(screen.getByPlaceholderText("Search session titles"), {
      target: { value: "Forked" },
    });
    const forkButton = forkTitle.closest("button")!;
    expect(forkButton).toHaveAttribute("title", expect.stringContaining("Created by:"));
    expect(forkButton).toHaveAttribute("title", expect.stringContaining("Forked from:"));
    fireEvent.click(forkButton);
    expect(
      await screen.findByRole("button", { name: /Created by: Creator session/ }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /Forked from: Cached continuation/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Forked from: Cached continuation/ }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Cached continuation" })).toBeVisible();
      expect(screen.getByPlaceholderText("Search session titles")).toHaveValue("");
    });
  });

  it("does not expose internal context wrappers as titles", async () => {
    vi.mocked(api.workspaceSessions).mockResolvedValue([
      { ...cachedSession, title: "<path>SKILL.md</path><content>internal" },
    ]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([
      { ...cachedSession, title: "<path>SKILL.md</path><content>internal" },
    ]);

    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    expect((await screen.findAllByText("Untitled session")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/SKILL\.md/)).toBeNull();
  });

  it("continues through an empty scan window and reloads latest records after a stale cursor", async () => {
    vi.mocked(api.sessionEvents)
      .mockResolvedValueOnce({
        events: [],
        warnings: ["TRANSCRIPT_SCAN_BUDGET"],
        next_cursor: "older",
      })
      .mockRejectedValueOnce(new Error("TRANSCRIPT_CURSOR_STALE"))
      .mockResolvedValueOnce({
        events: [
          {
            id: "latest",
            kind: "agent-message",
            content: "Latest after retry",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      });
    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        initialSessionId={cachedSession.id}
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    expect(
      await screen.findByText(
        "No displayable records in this window. Continue loading earlier records.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("No readable messages")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
    expect(
      await screen.findByText(
        "This history page has expired or the file has changed. Retry to reload the latest records.",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Latest after retry")).toBeTruthy();
    expect(api.sessionEvents).toHaveBeenLastCalledWith(cachedSession.id);
  });

  it("opens the session selected from the home page and consumes the route target", async () => {
    const selected = { ...cachedSession, id: "selected-session", title: "Selected from home" };
    vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession, selected]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession, selected]);
    const onInitialSessionConsumed = vi.fn();

    render(
      <WorkspaceSessionsPage
        workspace={workspace}
        enabled
        initialSessionId={selected.id}
        onInitialSessionConsumed={onInitialSessionConsumed}
        targetAgents={["claude-code"]}
        onRuntimeChanged={vi.fn()}
        onHandoffPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.sessionEvents).toHaveBeenCalledWith(selected.id));
    expect(onInitialSessionConsumed).toHaveBeenCalledTimes(1);
  });
});
