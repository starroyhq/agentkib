// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { AgentInstallation, RuntimeInfo, WorkspaceSummary } from "@/core/types";
import { GlobalHome } from "./GlobalHome";

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: "/tmp/workspace",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
} as WorkspaceSummary;

const onboarding = {
  version: 1,
  acknowledged_version: 0,
  doctor_completed: false,
  repairable_count: 0,
  repair_applied: false,
};

function homeProps() {
  return {
    workspaces: [] as WorkspaceSummary[],
    doctorSummaries: {},
    installations: [],
    memories: [],
    sessions: {
      state: "ready" as const,
      sessions: [],
      onOpen: vi.fn(),
      onShowAll: vi.fn(),
      onEnableIndex: vi.fn().mockResolvedValue(undefined),
      onRetry: vi.fn().mockResolvedValue(undefined),
      onRetrySources: vi.fn().mockResolvedValue(undefined),
    },
    onOpenDoctor: vi.fn().mockResolvedValue(undefined),
    onAddWorkspace: vi.fn().mockResolvedValue(undefined),
    onAddRoot: vi.fn().mockResolvedValue(undefined),
    onRuntimeChanged: vi.fn(),
  };
}

describe("GlobalHome", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("explains the daily home to a new user next to the getting-started steps", () => {
    render(
      <GlobalHome
        {...homeProps()}
        runtime={{ onboarding } as RuntimeInfo}
        installations={
          [
            { agent: "codex", installed: true },
            { agent: "claude-code", installed: false },
          ] as AgentInstallation[]
        }
      />,
    );
    expect(screen.getByText(tr("home.emptySummary"))).toBeVisible();
    expect(screen.getByText(tr("onboarding.readScope"))).toBeVisible();
    expect(screen.getByText(`${tr("onboarding.detectedAgents")} Codex`)).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("common.refresh") })).toBeNull();
    expect(screen.getByText(tr("onboarding.workspaceStep")).closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
  });

  it("shows the session groups once a workspace exists, without workspace health or add actions", () => {
    render(<GlobalHome {...homeProps()} workspaces={[workspace]} />);
    expect(screen.getByText(tr("home.firstSession"))).toBeVisible();
    expect(screen.queryByRole("button", { name: tr("home.addWorkspace") })).toBeNull();
    expect(screen.queryByRole("button", { name: tr("home.addScanRoot") })).toBeNull();
    expect(screen.queryByText(tr("workspace.status.undiagnosed"))).toBeNull();
  });

  it("keeps the onboarding steps visible after discovering a workspace and advances to Doctor", () => {
    const props = homeProps();
    const runtime = { onboarding } as RuntimeInfo;
    const view = render(<GlobalHome {...props} runtime={runtime} />);
    expect(screen.getByRole("heading", { name: tr("onboarding.title") })).toBeVisible();
    expect(screen.getAllByRole("button", { name: tr("onboarding.addWorkspace") })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: tr("home.addScanRoot") })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: tr("home.emptyTitle") })).toBeNull();

    view.rerender(<GlobalHome {...props} runtime={runtime} workspaces={[workspace]} />);
    expect(screen.getByRole("heading", { name: tr("onboarding.title") })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("onboarding.viewResults") }));
    expect(props.onOpenDoctor).toHaveBeenCalledWith(workspace);

    view.rerender(
      <GlobalHome
        {...props}
        workspaces={[workspace]}
        runtime={
          {
            onboarding: { ...onboarding, doctor_completed: true, repairable_count: 2 },
          } as RuntimeInfo
        }
      />,
    );
    expect(screen.getByRole("button", { name: tr("onboarding.reviewRepair") })).toBeVisible();
  });

  it("uses the acknowledged version to choose onboarding or the empty workspace actions", () => {
    const props = homeProps();
    const view = render(
      <GlobalHome
        {...props}
        runtime={{ onboarding: { ...onboarding, acknowledged_version: 1 } } as RuntimeInfo}
      />,
    );
    expect(screen.queryByRole("heading", { name: tr("onboarding.title") })).toBeNull();
    expect(screen.getByRole("heading", { name: tr("home.emptyTitle") })).toBeVisible();
    expect(screen.getAllByRole("button", { name: tr("home.addWorkspace") })).toHaveLength(1);

    view.rerender(
      <GlobalHome
        {...props}
        workspaces={[workspace]}
        runtime={
          { onboarding: { ...onboarding, version: 2, acknowledged_version: 1 } } as RuntimeInfo
        }
      />,
    );
    expect(screen.getByRole("heading", { name: tr("onboarding.title") })).toBeVisible();
  });

  it("separates the workspace and scan-folder callbacks", async () => {
    const props = homeProps();
    render(<GlobalHome {...props} />);
    fireEvent.click(screen.getByRole("button", { name: tr("home.addWorkspace") }));
    expect(props.onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onAddRoot).not.toHaveBeenCalled();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    expect(props.onAddRoot).toHaveBeenCalledTimes(1);
    expect(props.onAddWorkspace).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(screen.getByText(tr("home.addWorkspaceHint"))).toBeVisible();
    expect(screen.getByText(tr("home.addScanRootHint"))).toBeVisible();
  });

  it("locks all add actions until the request settles and exposes a recoverable error", async () => {
    const props = homeProps();
    let reject!: (reason: Error) => void;
    props.onAddWorkspace.mockReturnValueOnce(
      new Promise<void>((_resolve, no) => {
        reject = no;
      }),
    );
    render(<GlobalHome {...props} runtime={{ onboarding } as RuntimeInfo} />);
    const add = screen.getByRole("button", { name: tr("onboarding.addWorkspace") });
    fireEvent.click(add);
    fireEvent.click(add);
    fireEvent.click(screen.getByRole("button", { name: tr("home.addScanRoot") }));
    expect(add).toBeDisabled();
    expect(screen.getByRole("button", { name: tr("home.addScanRoot") })).toBeDisabled();
    expect(props.onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(props.onAddRoot).not.toHaveBeenCalled();
    await act(async () => reject(new Error("folder unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("folder unavailable");
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await act(async () => {});
    expect(props.onAddWorkspace).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
