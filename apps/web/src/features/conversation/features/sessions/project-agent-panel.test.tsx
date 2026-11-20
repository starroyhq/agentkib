// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectAgentPanel } from "./project-agent-panel";

const projectAgent = vi.fn();
const manageProjectAgent = vi.fn();
// The controller's client is one object for the session's life.
const client = { projectAgent, manageProjectAgent };
let device: Record<string, unknown> | undefined;
vi.mock("./session-context", () => ({
  useSession: () => ({
    locale: "en-US",
    selected: "lead-1",
    current: { workspace_id: "w1" },
    workspaces: [{ id: "w1", name: "app", path: "/fixture/app" }],
    choose: vi.fn(),
    formatCatalogTime: () => "3 min ago",
    client,
    access: { device },
  }),
}));
const lead = {
  sessionId: "lead-1",
  paused: false,
  reason: null,
  scope: { workspaceIds: ["w1"], policies: [], maxLanes: 4, maxAutoTurns: 25 },
  pendingReports: 0,
  workers: [],
};
const full = { accessMode: "full", send: true, approve: true, manage: true, advancedControl: true };

beforeEach(() => {
  projectAgent.mockReset();
  manageProjectAgent.mockReset();
  projectAgent.mockResolvedValue({ lead: null });
});
afterEach(cleanup);

describe("Project Agent panel on Web", () => {
  it("sets one up from a device with full access, in the host's own operation names", async () => {
    device = full;
    projectAgent.mockResolvedValueOnce({ lead: null });
    render(<ProjectAgentPanel />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Make Project Agent…" }));
    expect(screen.queryByRole("group", { name: "Workspaces workers may use" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Most workers" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Most automatic turns in a row" })).toHaveValue(
      25,
    );
    manageProjectAgent.mockResolvedValueOnce({ lead });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make Project Agent" }));
    });
    expect(manageProjectAgent).toHaveBeenLastCalledWith({
      operation: "designate",
      sessionId: "lead-1",
      scope: { approvals: [], answers: false, maxAutoTurns: 25 },
    });
    expect(screen.getByRole("button", { name: "Pause delegation" })).toBeInTheDocument();
  });

  it("shows a device without full access the state only", async () => {
    device = { send: true, approve: true, manage: true };
    projectAgent.mockResolvedValueOnce({ lead: null });
    const { unmount } = render(<ProjectAgentPanel />);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Make Project Agent…" })).toBeNull();
    unmount();
    projectAgent.mockResolvedValueOnce({ lead });
    render(<ProjectAgentPanel />);
    await act(async () => undefined);
    expect(screen.getByText("0 workers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause delegation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop being a Project Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change settings…" })).toBeNull();
  });

  it("stops a worker's turn, lets one go and changes the settings, as the device may", async () => {
    const worker = {
      name: "api",
      sessionId: "codex-1",
      status: "running",
      stopEnabled: true,
      title: null,
      lastReportAt: null,
    };
    // May stop a turn, but neither let a worker go nor take the Project Agent over.
    device = { accessMode: "full", send: true };
    projectAgent.mockResolvedValueOnce({ lead: { ...lead, workers: [worker] } });
    const { unmount } = render(<ProjectAgentPanel />);
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change settings…" })).toBeNull();
    unmount();
    device = full;
    projectAgent.mockResolvedValueOnce({ lead: { ...lead, workers: [worker] } });
    render(<ProjectAgentPanel />);
    await act(async () => undefined);
    manageProjectAgent.mockResolvedValueOnce({ lead: { ...lead, workers: [worker] } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(manageProjectAgent).toHaveBeenLastCalledWith({
      operation: "stop-worker",
      worker: "codex-1",
      sessionId: "lead-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    manageProjectAgent.mockResolvedValueOnce({ lead });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    });
    expect(manageProjectAgent).toHaveBeenLastCalledWith({
      operation: "remove-worker",
      worker: "codex-1",
      sessionId: "lead-1",
    });
    fireEvent.click(screen.getByRole("button", { name: "Change settings…" }));
    expect(
      screen.queryByRole("checkbox", { name: "Let workers use Codex auto-review" }),
    ).toBeNull();
    const automaticTurns = screen.getByRole("spinbutton", {
      name: "Most automatic turns in a row",
    });
    expect(automaticTurns).toHaveValue(25);
    fireEvent.change(automaticTurns, { target: { value: "5" } });
    manageProjectAgent.mockResolvedValueOnce({ lead });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(manageProjectAgent).toHaveBeenLastCalledWith({
      operation: "update",
      sessionId: "lead-1",
      scope: { approvals: [], answers: false, maxAutoTurns: 5 },
    });
  });
});
