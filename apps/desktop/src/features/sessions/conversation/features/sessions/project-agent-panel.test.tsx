// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAgentPanel } from "./project-agent-panel";

const request = vi.fn();
const choose = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request } }) }));
vi.mock("./session-context", () => ({
  useSession: () => ({
    locale: "en-US",
    selected: "lead-1",
    current: { workspace_id: "w1" },
    workspaces: [
      { id: "w1", name: "app", path: "/fixture/app" },
      { id: "w2", name: "worktrees", path: "/fixture/worktrees" },
    ],
    choose,
    formatCatalogTime: () => "3 min ago",
  }),
}));

const agent = (overrides: Record<string, unknown> = {}) => ({
  lead: {
    sessionId: "lead-1",
    paused: false,
    reason: null,
    scope: {
      workspaceIds: ["w1"],
      policies: ["workspace-write-on-request"],
      maxLanes: 4,
      maxAutoTurns: 25,
    },
    pendingReports: 0,
    workers: [],
    ...overrides,
  },
});

beforeEach(() => {
  request.mockReset();
  choose.mockReset();
});
afterEach(cleanup);

describe("Project Agent panel", () => {
  it("makes the session a Project Agent with the workspaces and limits chosen", async () => {
    request.mockResolvedValueOnce({ lead: null });
    render(<ProjectAgentPanel />);
    await act(async () => undefined);
    expect(request).toHaveBeenLastCalledWith({ operation: "lead-status", sessionId: "lead-1" });
    fireEvent.click(screen.getByRole("button", { name: "Make Project Agent…" }));
    expect(screen.getByRole("checkbox", { name: "app" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "worktrees" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Let workers use Codex auto-review" }));
    // Nothing is decided for the user unless they tick it.
    for (const name of [
      "Workers' file change approvals",
      "Workers' approvals to run commands outside the sandbox",
      "Workers' questions",
    ])
      expect(screen.getByRole("checkbox", { name })).not.toBeChecked();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Workers' approvals to run commands outside the sandbox",
      }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Workers' questions" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Most workers" }), {
      target: { value: "2" },
    });
    request.mockResolvedValueOnce(
      agent({
        scope: {
          workspaceIds: ["w1", "w2"],
          policies: ["workspace-write-on-request"],
          maxLanes: 2,
          maxAutoTurns: 25,
          approvals: ["command"],
          answers: true,
        },
      }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make Project Agent" }));
    });
    expect(request).toHaveBeenLastCalledWith({
      operation: "lead-designate",
      sessionId: "lead-1",
      scope: {
        workspaceIds: ["w1", "w2"],
        policies: ["workspace-write-on-request", "workspace-write-auto-review"],
        maxLanes: 2,
        maxAutoTurns: 25,
        approvals: ["command"],
        answers: true,
      },
    });
    expect(screen.getByText("0 workers")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Decides for you: Workers' approvals to run commands outside the sandbox, Workers' questions",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No workers yet. Ask this session to open one.")).toBeInTheDocument();
  });

  it("lists workers, opens one, and pauses, resumes or releases delegation", async () => {
    request.mockResolvedValueOnce(
      agent({
        pendingReports: 1,
        workers: [
          {
            name: "api",
            sessionId: "codex-1",
            status: "awaiting-approval",
            title: "Fix login",
            lastReportAt: "2026-11-13T08:00:00.000Z",
          },
        ],
      }),
    );
    render(<ProjectAgentPanel />);
    await act(async () => undefined);
    expect(screen.getByText("1 worker · 1 report waiting")).toBeInTheDocument();
    expect(screen.getByText("api · Waiting for your approval")).toBeInTheDocument();
    expect(screen.getByText("Fix login · reported 3 min ago")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(choose).toHaveBeenCalledWith("codex-1");
    request.mockResolvedValueOnce(agent({ paused: true, reason: "auto-turn-limit" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause delegation" }));
    });
    expect(request).toHaveBeenLastCalledWith({ operation: "lead-pause", sessionId: "lead-1" });
    expect(
      screen.getByText(
        "Delegation paused at the limit of automatic turns. Send this session a message to go on.",
      ),
    ).toBeInTheDocument();
    request.mockResolvedValueOnce(agent());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Resume delegation" }));
    });
    expect(request).toHaveBeenLastCalledWith({ operation: "lead-resume", sessionId: "lead-1" });
    fireEvent.click(screen.getByRole("button", { name: "Stop being a Project Agent" }));
    expect(
      screen.getByText("Stop being a Project Agent? The workers stay as ordinary sessions."),
    ).toBeInTheDocument();
    request.mockResolvedValueOnce({ lead: null });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop being a Project Agent" }));
    });
    expect(request).toHaveBeenLastCalledWith({ operation: "lead-release", sessionId: "lead-1" });
    expect(screen.getByRole("button", { name: "Make Project Agent…" })).toBeInTheDocument();
  });

  it("stops a worker's turn, lets a worker go, and changes what it may do", async () => {
    const working = {
      name: "api",
      sessionId: "codex-1",
      status: "running",
      stopEnabled: true,
      title: "Fix login",
      lastReportAt: null,
    };
    request.mockResolvedValueOnce(
      agent({
        workers: [
          working,
          { ...working, name: "docs", sessionId: "codex-2", status: "idle", stopEnabled: false },
        ],
      }),
    );
    render(<ProjectAgentPanel />);
    await act(async () => undefined);
    // Only a worker whose turn runs offers to stop it.
    expect(screen.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
    request.mockResolvedValueOnce(agent({ workers: [{ ...working, stopEnabled: false }] }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(request).toHaveBeenLastCalledWith({
      operation: "lead-worker-stop",
      worker: "codex-1",
      sessionId: "lead-1",
    });
    // Letting one go asks first, and says what stays.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(
      screen.getByText(
        "Remove api from this Project Agent? Its session stays as an ordinary session, it no longer reports here, and its place is free.",
      ),
    ).toBeInTheDocument();
    const scope = {
      workspaceIds: ["w1"],
      policies: ["workspace-write-on-request", "workspace-write-auto-review"],
      maxLanes: 4,
      maxAutoTurns: 25,
      approvals: ["file-change"],
      answers: false,
    };
    request.mockResolvedValueOnce(agent({ scope }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(request).toHaveBeenLastCalledWith({
      operation: "lead-worker-remove",
      worker: "codex-1",
      sessionId: "lead-1",
    });
    expect(screen.getByText("No workers yet. Ask this session to open one.")).toBeInTheDocument();
    // Its settings: the setup form again, with what it may do now.
    fireEvent.click(screen.getByRole("button", { name: "Change settings…" }));
    expect(screen.getByRole("checkbox", { name: "app" })).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "Let workers use Codex auto-review" }),
    ).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Workers' file change approvals" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Workers' questions" })).not.toBeChecked();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Most workers" }), {
      target: { value: "6" },
    });
    request.mockResolvedValueOnce(agent({ scope: { ...scope, maxLanes: 6 } }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(request).toHaveBeenLastCalledWith({
      operation: "lead-update",
      sessionId: "lead-1",
      scope: { ...scope, maxLanes: 6 },
    });
    expect(screen.getByRole("button", { name: "Change settings…" })).toBeInTheDocument();
  });

  it("explains a refusal and shows nothing when the host does not answer", async () => {
    request.mockResolvedValueOnce({ lead: null });
    render(<ProjectAgentPanel />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Make Project Agent…" }));
    request.mockRejectedValueOnce(new Error("AgentKib command failed: session-is-a-worker"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make Project Agent" }));
    });
    expect(screen.getByText("This session is another Project Agent's worker.")).toBeInTheDocument();
    cleanup();
    request.mockReset();
    request.mockRejectedValueOnce(new Error("claude-managed-unavailable"));
    const { container } = render(<ProjectAgentPanel />);
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });
});
