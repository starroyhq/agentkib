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
    manageProjectAgent.mockResolvedValueOnce({ lead });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make Project Agent" }));
    });
    expect(manageProjectAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "designate", sessionId: "lead-1" }),
    );
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
  });
});
