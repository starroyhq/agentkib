// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type {
  AgentInstallation,
  ConversationSessionSummary,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { GlobalHome } from "./GlobalHome";
import { resetOnboardingPreferenceForTest } from "./onboarding-preference";

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: "/tmp/workspace",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
} as WorkspaceSummary;

const sampleSession: ConversationSessionSummary = {
  id: "session-1",
  workspace_id: workspace.id,
  agent: "claude-code",
  title: "Resume auth queue refactor",
  availability: "readable",
  archived: false,
  sidechain: false,
  updated_at: "2026-11-28T09:00:00Z",
};

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
      sessions: [] as ConversationSessionSummary[],
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
  beforeEach(() => resetOnboardingPreferenceForTest());
  afterEach(cleanup);

  it("shows first-use actions and detected Agents without explanatory prose or doctor checklist", () => {
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
    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.queryByText(tr("onboarding.readScope"))).toBeNull();
    expect(screen.queryByText(tr("onboarding.workspaceStep"))).toBeNull();
    expect(screen.queryByRole("button", { name: tr("common.refresh") })).toBeNull();
    expect(screen.getByRole("button", { name: tr("onboarding.addWorkspace") })).toBeVisible();
  });

  it("shows the session groups once a workspace exists and onboarding is acknowledged", () => {
    render(<GlobalHome {...homeProps()} workspaces={[workspace]} />);
    expect(screen.queryByRole("heading", { name: tr("home.emptyTitle") })).toBeNull();
    expect(screen.queryByRole("button", { name: tr("home.addWorkspace") })).toBeNull();
    expect(screen.queryByRole("button", { name: tr("home.addScanRoot") })).toBeNull();
    expect(screen.queryByText(tr("workspace.status.undiagnosed"))).toBeNull();
  });

  it("shows First-Minute Resume view when onboarding is active with discovered sessions and exits to daily home on resume", () => {
    const props = homeProps();
    props.sessions.sessions = [sampleSession];
    const runtime = { onboarding } as RuntimeInfo;
    const view = render(
      <GlobalHome
        {...props}
        runtime={runtime}
        workspaces={[workspace]}
        newSession={<div>Daily Composer</div>}
      />,
    );
    expect(
      screen.getByRole("heading", { name: tr("onboarding.foundSessions", { count: 1 }) }),
    ).toBeVisible();
    expect(screen.queryByText("Daily Composer")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: `${tr("onboarding.resumeSession")}: Resume auth queue refactor`,
      }),
    );
    expect(props.sessions.onOpen).toHaveBeenCalledExactlyOnceWith(sampleSession);
    expect(
      screen.queryByRole("heading", { name: tr("onboarding.foundSessions", { count: 1 }) }),
    ).toBeNull();
    expect(screen.getByText("Daily Composer")).toBeVisible();

    // A bumped onboarding version brings onboarding back until acknowledged or dismissed.
    view.rerender(
      <GlobalHome
        {...props}
        workspaces={[workspace]}
        newSession={<div>Daily Composer</div>}
        runtime={
          { onboarding: { ...onboarding, version: 2, acknowledged_version: 1 } } as RuntimeInfo
        }
      />,
    );
    expect(
      screen.getByRole("heading", { name: tr("onboarding.foundSessions", { count: 1 }) }),
    ).toBeVisible();
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
    const user = userEvent.setup();
    render(<GlobalHome {...props} />);
    const label = tr("home.addWorkspace");
    const addWorkspace = screen.getByRole("button", { name: label });
    expect(addWorkspace).not.toHaveTextContent(label);
    await user.hover(addWorkspace);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(label);
    addWorkspace.focus();
    await user.keyboard("{Enter}");
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
