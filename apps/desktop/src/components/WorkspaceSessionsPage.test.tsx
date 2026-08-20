// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../i18n";
import { api } from "../api";
import type { ConversationSessionSummary, PlannedSessionHandoff, SessionHandoffPreparation, WorkspaceSummary } from "../types";
import { WorkspaceSessionsPage } from "./WorkspaceSessionsPage";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock("../api", () => ({
  api: {
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    sessionEvents: vi.fn(),
    prepareSessionHandoff: vi.fn(),
    summarizeSessionHandoff: vi.fn(),
    sanitizeSessionHandoff: vi.fn(),
    planSessionHandoff: vi.fn(),
  },
}));

const workspace: WorkspaceSummary = {
  id: "workspace",
  path: "/tmp/workspace",
  name: "Workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};

const plannedHandoff: PlannedSessionHandoff = {
  change_set: {
    id: "changes", project_root: workspace.path, created_at: "2026-08-18T00:00:00Z",
    changes: [], requires_home_approval: false,
  },
  launch_request: { workspace_id: workspace.id, filename: "handoff.md", target_agent: "claude-code" },
};

const sessions: ConversationSessionSummary[] = [
  {
    id: "current",
    workspace_id: "workspace",
    agent: "codex",
    title: "Current task",
    updated_at: "2026-08-13T10:00:00Z",
    message_count: 3,
    archived: false,
    sidechain: false,
    availability: "readable",
  },
  {
    id: "archive",
    workspace_id: "workspace",
    agent: "claude-code",
    title: "Old task",
    updated_at: "2026-08-12T10:00:00Z",
    archived: true,
    sidechain: true,
    availability: "metadata-only",
  },
];

beforeEach(async () => {
  await initializeI18n("en-US");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  vi.mocked(api.workspaceSessions).mockResolvedValue(sessions);
  vi.mocked(api.workspaceSessionStatus).mockResolvedValue([
    { workspace_id: "workspace", agent: "codex", freshness: "fresh", session_count: 1 },
    { workspace_id: "workspace", agent: "claude-code", freshness: "fresh", session_count: 1 },
  ]);
  vi.mocked(api.refreshWorkspaceSessions).mockResolvedValue(sessions);
  vi.mocked(api.sessionEvents).mockResolvedValue({
    events: [
      { id: "message", kind: "user-message", content: "Visible message", attachment_count: 0, truncated: false },
      { id: "tool", kind: "tool-summary", tool_name: "Read", tool_status: "completed", attachment_count: 0, truncated: false },
    ],
    warnings: [],
  });
  vi.mocked(api.prepareSessionHandoff).mockResolvedValue({
    status: "ready",
    draft: {
      filename: "handoff.md",
      format: "markdown",
      content: "# Agent handoff",
      redaction_count: 1,
      included_message_count: 1,
      omitted_tool_count: 1,
      context_source: "full-transcript",
      warnings: [],
    },
  });
  vi.mocked(api.summarizeSessionHandoff).mockResolvedValue({
    filename: "handoff.md", format: "markdown", content: "# Summary", redaction_count: 1,
    included_message_count: 201, omitted_tool_count: 3, context_source: "model-summary", warnings: [],
  });
  vi.mocked(api.sanitizeSessionHandoff).mockImplementation(async (_format, content) => (
    content.replace("TOKEN=private", "TOKEN= [REDACTED]")
  ));
  vi.mocked(api.planSessionHandoff).mockResolvedValue(plannedHandoff);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkspaceSessionsPage", () => {
  it("forces a native refresh on entry without showing cached ghost sessions", async () => {
    vi.mocked(api.workspaceSessions).mockResolvedValueOnce([{ ...sessions[0], id: "ghost", title: "Deleted ghost" }]);
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);

    await waitFor(() => expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith("workspace", true));
    expect(api.workspaceSessions).not.toHaveBeenCalled();
    expect(screen.queryByText("Deleted ghost")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Current task/ })).toBeInTheDocument();
  });

  it("uses the same forced refresh for the manual refresh action", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);
    expect(await screen.findByRole("button", { name: /Current task/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh sessions" }));

    await waitFor(() => expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(2));
    expect(api.refreshWorkspaceSessions).toHaveBeenLastCalledWith("workspace", true);
  });

  it("defaults to readable current sessions and reads the selected transcript on demand", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);

    await waitFor(() => expect(screen.getByRole("button", { name: /Current task/ })).toBeInTheDocument());
    expect(screen.queryByText("Old task")).not.toBeInTheDocument();
    await waitFor(() => expect(api.sessionEvents).toHaveBeenCalledWith("current"));
    expect(await screen.findByText("Visible message")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
  });

  it("shows archived metadata-only sessions without trying to read a missing transcript", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Current task/ })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /All/ }));
    fireEvent.click(await screen.findByText("Old task"));

    expect(await screen.findByText("The original transcript is no longer available.")).toBeInTheDocument();
    expect(api.sessionEvents).toHaveBeenCalledTimes(1);
  });

  it("separates indexed records from readable transcripts and links to metadata", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Current task/ })).toBeInTheDocument());

    expect(screen.getByText("1 indexed · 1 readable")).toBeInTheDocument();
    expect(screen.getByText("1 indexed · 0 readable")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Agent filter" }));
    await user.click(await screen.findByRole("option", { name: "Claude Code" }));

    expect(screen.getByRole("button", { name: /Current 0/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Metadata only 1/ })).toBeInTheDocument();
    expect(screen.getByText("Historical records found: 1. Original transcripts are unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View metadata" }));
    expect(await screen.findByRole("button", { name: /Old task/ })).toBeInTheDocument();
  });

  it("does not access native history while indexing is disabled", async () => {
    render(<WorkspaceSessionsPage workspace={workspace} enabled={false} targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);

    expect(screen.getByText("Session indexing is disabled")).toBeInTheDocument();
    expect(api.workspaceSessions).not.toHaveBeenCalled();
  });

  it("creates a redacted handoff from automatically selected context", async () => {
    const onHandoffPlanned = vi.fn();
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={onHandoffPlanned} />);
    expect(await screen.findByText("Visible message")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create handoff" }));
    expect(screen.getByRole("dialog", { name: "Create session handoff" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Cursor" })).not.toBeInTheDocument();
    expect(screen.getByText("Effective context is selected automatically")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));

    await waitFor(() => expect(api.prepareSessionHandoff).toHaveBeenCalledWith({
      session_id: "current",
      target_agent: "claude-code",
      format: "markdown",
    }));
    expect(await screen.findByDisplayValue("# Agent handoff")).toBeInTheDocument();
    expect(screen.getByText(/1 sensitive values redacted/)).toBeInTheDocument();
    expect(screen.getByText(/This session has not been compacted/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Preview handoff"), { target: { value: "# Edited handoff\nTOKEN=private" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(api.sanitizeSessionHandoff).toHaveBeenCalledWith(
      "markdown", "# Edited handoff\nTOKEN=private",
    ));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("# Edited handoff\nTOKEN= [REDACTED]");
    fireEvent.click(screen.getByRole("button", { name: "Review save changes" }));
    await waitFor(() => expect(api.planSessionHandoff).toHaveBeenCalledWith(
      "workspace", "handoff.md", "markdown", "# Edited handoff\nTOKEN=private", "claude-code",
    ));
    expect(onHandoffPlanned).toHaveBeenCalledWith(expect.objectContaining({
      change_set: expect.objectContaining({ id: "changes" }),
      launch_request: expect.objectContaining({ target_agent: "claude-code" }),
    }));
  });

  it("ignores a handoff plan that finishes after the dialog closes", async () => {
    let resolvePlan: ((value: PlannedSessionHandoff) => void) | undefined;
    vi.mocked(api.planSessionHandoff).mockImplementationOnce(() => (
      new Promise<PlannedSessionHandoff>((resolve) => { resolvePlan = resolve; })
    ));
    const onHandoffPlanned = vi.fn();
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={onHandoffPlanned} />);
    expect(await screen.findByText("Visible message")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create handoff" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));
    expect(await screen.findByDisplayValue("# Agent handoff")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review save changes" }));
    await waitFor(() => expect(api.planSessionHandoff).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Create session handoff" })).not.toBeInTheDocument();

    resolvePlan?.(plannedHandoff);
    await Promise.resolve();
    expect(onHandoffPlanned).not.toHaveBeenCalled();
  });

  it("freezes the target Agent while preparing a handoff", async () => {
    let resolvePreparation: ((value: SessionHandoffPreparation) => void) | undefined;
    vi.mocked(api.prepareSessionHandoff).mockImplementationOnce(() => (
      new Promise<SessionHandoffPreparation>((resolve) => {
        resolvePreparation = resolve;
      })
    ));
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);
    expect(await screen.findByText("Visible message")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create handoff" }));
    const target = screen.getByLabelText("Target Agent");
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));

    expect(target).toBeDisabled();
    resolvePreparation?.({
      status: "ready",
      draft: {
        filename: "handoff.md", format: "markdown", content: "# Agent handoff",
        redaction_count: 0, included_message_count: 1, omitted_tool_count: 0,
        context_source: "full-transcript", warnings: [],
      },
    });
    expect(await screen.findByDisplayValue("# Agent handoff")).toBeInTheDocument();
  });

  it("requires explicit consent before using the source Agent to summarize oversized context", async () => {
    vi.mocked(api.prepareSessionHandoff).mockResolvedValueOnce({
      status: "summary-required",
      source_agent: "codex",
      message_count: 201,
      estimated_bytes: 600_000,
      reason: "message-limit",
    });
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);
    expect(await screen.findByText("Visible message")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create handoff" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));
    expect(await screen.findByText("The handoff exceeds the safety limit")).toBeInTheDocument();
    expect(api.summarizeSessionHandoff).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Summarize with Codex" }));
    await waitFor(() => expect(api.summarizeSessionHandoff).toHaveBeenCalledWith({
      session_id: "current",
      target_agent: "claude-code",
      format: "markdown",
    }));
    expect(await screen.findByDisplayValue("# Summary")).toBeInTheDocument();
  });

  it("cancels oversized summarization without invoking the source Agent", async () => {
    vi.mocked(api.prepareSessionHandoff).mockResolvedValueOnce({
      status: "summary-required",
      source_agent: "codex",
      message_count: 201,
      estimated_bytes: 600_000,
      reason: "message-limit",
    });
    render(<WorkspaceSessionsPage workspace={workspace} enabled targetAgents={["codex", "claude-code"]} onRuntimeChanged={vi.fn()} onHandoffPlanned={vi.fn()} />);
    expect(await screen.findByText("Visible message")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create handoff" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare handoff" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.getByText("Effective context is selected automatically")).toBeInTheDocument();
    expect(api.summarizeSessionHandoff).not.toHaveBeenCalled();
  });
});
