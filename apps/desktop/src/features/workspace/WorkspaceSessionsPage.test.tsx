// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { useSessionViewStore } from "@/features/sessions/session-view-store";
import { WorkspaceSessionsPage } from "./WorkspaceSessionsPage";

vi.mock("@/core/api", () => ({
  api: {
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    sessionEvents: vi.fn(),
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
    useSessionViewStore.getState().resetFilters();
    vi.mocked(api.workspaceSessions).mockResolvedValue([cachedSession]);
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue([cachedSession]);
    vi.mocked(api.sessionEvents).mockResolvedValue({ events: [], warnings: [] });
  });
  afterEach(cleanup);

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
    "keeps %s history read-only in the workspace session view",
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
      expect(screen.queryByRole("button", { name: "Continue in another Agent" })).toBeNull();
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
