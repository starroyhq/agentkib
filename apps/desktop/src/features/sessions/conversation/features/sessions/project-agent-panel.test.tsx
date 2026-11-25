// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  ProjectAgentPanel,
  SessionPlatformProvider,
  type SessionPlatform,
} from "@agentkib/session-ui";
import type { Access } from "@agentkib/web-client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { cn } from "cn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { desktopProjectAgentClient } from "./project-agent-adapter";

const request = vi.fn();
const choose = vi.fn();
vi.mock("@/core/desktop", () => ({ desktopApi: () => ({ claude: { request } }) }));

const projectAgent = vi.fn();
const manageProjectAgent = vi.fn();
const client = { projectAgent, manageProjectAgent };
const components = { Button, Input, NativeCheckbox, mergeClassNames: cn };
type DeviceGrants = Partial<NonNullable<Access["device"]>>;

function DesktopPanel() {
  return (
    <SessionPlatformProvider platform={{ kind: "desktop", components } as SessionPlatform}>
      <ProjectAgentPanel
        locale="en-US"
        selected="lead-1"
        choose={choose}
        formatCatalogTime={() => "3 min ago"}
        client={desktopProjectAgentClient}
      />
    </SessionPlatformProvider>
  );
}

function WebPanel({ device }: { device: DeviceGrants }) {
  return (
    <SessionPlatformProvider platform={{ kind: "web", components } as SessionPlatform}>
      <ProjectAgentPanel
        locale="en-US"
        selected="lead-1"
        choose={choose}
        formatCatalogTime={() => "3 min ago"}
        client={client}
        device={{ id: "test", name: "Test", send: false, approve: false, ...device }}
      />
    </SessionPlatformProvider>
  );
}

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

const lead = {
  sessionId: "lead-1",
  paused: false,
  reason: null,
  scope: { workspaceIds: ["w1"], policies: [], maxLanes: 4, maxAutoTurns: 25 },
  pendingReports: 0,
  workers: [],
};
const full = {
  accessMode: "full",
  send: true,
  approve: true,
  manage: true,
  advancedControl: true,
} as const;

beforeEach(() => {
  request.mockReset();
  choose.mockReset();
  projectAgent.mockReset();
  manageProjectAgent.mockReset();
  projectAgent.mockResolvedValue({ lead: null });
});
afterEach(cleanup);

describe("Project Agent panel on desktop", () => {
  it("leaves first-time assignment to the session row", async () => {
    request.mockResolvedValueOnce({ lead: null, capable: true });
    const { container } = render(<DesktopPanel />);
    await act(async () => undefined);
    expect(request).toHaveBeenLastCalledWith({ operation: "lead-status", sessionId: "lead-1" });
    expect(container).toBeEmptyDOMElement();
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
    render(<DesktopPanel />);
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
    expect(screen.queryByText("Project Agent")).not.toBeInTheDocument();
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
    render(<DesktopPanel />);
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
    expect(
      screen.getByText("Assign workers from the desktop session directory."),
    ).toBeInTheDocument();
    // A legacy host response can carry old settings. Only delegation settings are editable.
    fireEvent.click(screen.getByRole("button", { name: "Change settings…" }));
    expect(screen.queryByRole("group", { name: "Workspaces workers may use" })).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "Let workers use Codex auto-review" }),
    ).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Most workers" })).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Workers' file change approvals" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Workers' questions" })).not.toBeChecked();
    const automaticTurns = screen.getByRole("spinbutton", {
      name: "Most automatic turns in a row",
    });
    expect(automaticTurns).toHaveValue(25);
    fireEvent.change(automaticTurns, { target: { value: "101" } });
    expect(automaticTurns).toHaveValue(100);
    const stallThreshold = screen.getByRole("spinbutton", {
      name: "Model inactivity threshold (minutes)",
    });
    expect(stallThreshold).toHaveValue(10);
    expect(stallThreshold).toHaveAttribute("min", "3");
    expect(stallThreshold).toHaveAttribute("max", "120");
    fireEvent.change(stallThreshold, { target: { value: "1" } });
    expect(stallThreshold).toHaveValue(1);
    fireEvent.change(stallThreshold, { target: { value: "12" } });
    fireEvent.blur(stallThreshold);
    expect(stallThreshold).toHaveValue(12);
    fireEvent.change(stallThreshold, { target: { value: "2" } });
    fireEvent.blur(stallThreshold);
    expect(stallThreshold).toHaveValue(3);
    fireEvent.change(stallThreshold, { target: { value: "121" } });
    fireEvent.blur(stallThreshold);
    expect(stallThreshold).toHaveValue(120);
    fireEvent.change(stallThreshold, { target: { value: "42.9" } });
    fireEvent.blur(stallThreshold);
    expect(stallThreshold).toHaveValue(42);
    fireEvent.click(screen.getByRole("checkbox", { name: "Workers' questions" }));
    const update = {
      approvals: ["file-change"],
      answers: true,
      maxAutoTurns: 100,
      stallMinutes: 42,
    };
    request.mockResolvedValueOnce(agent({ scope: { ...scope, ...update } }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(request).toHaveBeenLastCalledWith({
      operation: "lead-update",
      sessionId: "lead-1",
      scope: update,
    });
    expect(screen.getByRole("button", { name: "Change settings…" })).toBeInTheDocument();
  });

  it("explains a refusal and shows nothing when the host does not answer", async () => {
    request.mockResolvedValueOnce(agent());
    render(<DesktopPanel />);
    await act(async () => undefined);
    request.mockRejectedValueOnce(new Error("AgentKib command failed: session-is-a-worker"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Pause delegation" }));
    });
    expect(screen.getByText("This session is another Project Agent's worker.")).toBeInTheDocument();
    cleanup();
    request.mockReset();
    request.mockRejectedValueOnce(new Error("claude-managed-unavailable"));
    const { container } = render(<DesktopPanel />);
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("Project Agent panel on Web", () => {
  it.each(["usage-limit", "report-undelivered"])(
    "shows automatic %s recovery without asking for a manual resume",
    async (reason) => {
      projectAgent.mockResolvedValueOnce(agent({ paused: true, recovering: true, reason }));
      render(<WebPanel device={full} />);
      expect(await screen.findByText("Resuming delegation…")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Resume delegation" })).not.toBeInTheDocument();
      expect(screen.queryByText(/desktop session directory/)).not.toBeInTheDocument();
    },
  );

  it("sets one up from a device with full access, in the host's own operation names", async () => {
    projectAgent.mockResolvedValueOnce({ lead: null });
    render(<WebPanel device={full} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Make Project Agent…" }));
    expect(screen.queryByRole("group", { name: "Workspaces workers may use" })).toBeNull();
    expect(screen.queryByRole("spinbutton", { name: "Most workers" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Most automatic turns in a row" })).toHaveValue(
      25,
    );
    expect(
      screen.getByRole("spinbutton", { name: "Model inactivity threshold (minutes)" }),
    ).toHaveValue(10);
    manageProjectAgent.mockResolvedValueOnce({ lead });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make Project Agent" }));
    });
    expect(manageProjectAgent).toHaveBeenLastCalledWith({
      operation: "designate",
      sessionId: "lead-1",
      scope: { approvals: [], answers: false, maxAutoTurns: 25, stallMinutes: 10 },
    });
    expect(screen.getByRole("button", { name: "Pause delegation" })).toBeInTheDocument();
  });

  it("shows a device without full access the state only", async () => {
    const device = { send: true, approve: true, manage: true };
    projectAgent.mockResolvedValueOnce({ lead: null });
    const { unmount } = render(<WebPanel device={device} />);
    await act(async () => undefined);
    const designate = screen.getByRole("button", { name: "Make Project Agent…" });
    expect(designate).toBeDisabled();
    expect(designate).toHaveAttribute("title", expect.stringContaining("requires full access"));
    fireEvent.click(designate);
    expect(manageProjectAgent).not.toHaveBeenCalled();
    unmount();
    projectAgent.mockResolvedValueOnce({ lead });
    render(<WebPanel device={device} />);
    await act(async () => undefined);
    expect(screen.getByText("0 workers")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause delegation" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop being a Project Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change settings…" })).toBeNull();
    const stallThreshold = screen.getByRole("spinbutton", {
      name: "Model inactivity threshold (minutes)",
    });
    expect(stallThreshold).toBeDisabled();
    expect(stallThreshold).toHaveValue(10);
    expect(manageProjectAgent).not.toHaveBeenCalled();
  });

  it("disables the threshold and saving if permission is revoked while editing", async () => {
    projectAgent.mockResolvedValueOnce({ lead });
    const { rerender } = render(<WebPanel device={full} />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Change settings…" }));
    const stallThreshold = screen.getByRole("spinbutton", {
      name: "Model inactivity threshold (minutes)",
    });
    fireEvent.change(stallThreshold, { target: { value: "25" } });
    rerender(<WebPanel device={{ ...full, manage: false }} />);
    expect(
      screen.getByRole("spinbutton", { name: "Model inactivity threshold (minutes)" }),
    ).toBeDisabled();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(manageProjectAgent).not.toHaveBeenCalled();
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
    const scope = { ...lead.scope, stallMinutes: 42 };
    projectAgent.mockResolvedValueOnce({ lead: { ...lead, workers: [worker] } });
    const { unmount } = render(<WebPanel device={{ accessMode: "full", send: true }} />);
    await act(async () => undefined);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change settings…" })).toBeNull();
    unmount();
    projectAgent.mockResolvedValueOnce({ lead: { ...lead, scope, workers: [worker] } });
    render(<WebPanel device={full} />);
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
    manageProjectAgent.mockResolvedValueOnce({ lead: { ...lead, scope } });
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
    const stallThreshold = screen.getByRole("spinbutton", {
      name: "Model inactivity threshold (minutes)",
    });
    expect(stallThreshold).toBeEnabled();
    expect(stallThreshold).toHaveValue(42);
    fireEvent.change(stallThreshold, { target: { value: "26.9" } });
    manageProjectAgent.mockResolvedValueOnce({
      lead: { ...lead, scope: { ...scope, maxAutoTurns: 5, stallMinutes: 26 } },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(manageProjectAgent).toHaveBeenLastCalledWith({
      operation: "update",
      sessionId: "lead-1",
      scope: { approvals: [], answers: false, maxAutoTurns: 5, stallMinutes: 26 },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change settings…" }));
    expect(
      screen.getByRole("spinbutton", { name: "Model inactivity threshold (minutes)" }),
    ).toHaveValue(26);
  });
});
