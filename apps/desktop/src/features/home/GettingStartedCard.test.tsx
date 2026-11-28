// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, localizeMessage, tr } from "@/core/i18n";
import type {
  AgentInstallation,
  ConversationSessionSummary,
  OnboardingState,
  RuntimeInfo,
  WorkspaceSummary,
} from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { GettingStartedCard } from "./GettingStartedCard";
import {
  clearOnboardingDismissal,
  resetOnboardingPreferenceForTest,
} from "./onboarding-preference";

vi.mock("@/core/api", () => ({ api: { updateOnboarding: vi.fn() } }));

const baseOnboarding: OnboardingState = {
  version: 1,
  acknowledged_version: 0,
  doctor_completed: false,
  repairable_count: 0,
  repair_applied: false,
};
const workspace = { id: "workspace-1", name: "northstar-api" } as WorkspaceSummary;
const otherWorkspace = { id: "workspace-2", name: "design-system" } as WorkspaceSummary;

function makeSession(
  id: string,
  title: string,
  updatedAt: string,
  agent: ConversationSessionSummary["agent"] = "claude-code",
  workspaceId = workspace.id,
): ConversationSessionSummary {
  return {
    id,
    workspace_id: workspaceId,
    agent,
    title,
    availability: "readable",
    archived: false,
    sidechain: false,
    updated_at: updatedAt,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof GettingStartedCard>> = {}) {
  return render(
    <GettingStartedCard
      onboarding={baseOnboarding}
      workspaces={[]}
      onRuntimeChanged={vi.fn()}
      onAddWorkspace={vi.fn().mockResolvedValue(undefined)}
      onAddRoot={vi.fn().mockResolvedValue(undefined)}
      {...props}
    />,
  );
}

describe("GettingStartedCard", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    resetOnboardingPreferenceForTest();
    useAppStore.setState(useAppStore.getInitialState(), true);
    vi.mocked(api.updateOnboarding).mockReset();
  });
  afterEach(cleanup);

  it("translates an existing dismissal error when the locale changes", async () => {
    const failure = { key: "errors.providerUnavailable", detail: "offline" };
    vi.mocked(api.updateOnboarding).mockRejectedValue(failure);
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "Dismiss getting started guide" }));
    const englishError = localizeMessage(failure);
    const message = await screen.findByText(englishError);

    try {
      await act(() => changeLocale("zh-CN"));
      expect(screen.getByText(localizeMessage(failure))).toBe(message);
      expect(screen.queryByText(englishError)).toBeNull();
      expect(api.updateOnboarding).toHaveBeenCalledTimes(1);
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("shows top 3 recent discovered sessions without doctor checklist and exits on resume", async () => {
    const dismissedRuntime = {
      onboarding: { ...baseOnboarding, acknowledged_version: 1 },
    } as RuntimeInfo;
    vi.mocked(api.updateOnboarding).mockResolvedValue(dismissedRuntime);
    useAppStore.setState({ runtime: { onboarding: baseOnboarding } as RuntimeInfo });

    const sessions: ConversationSessionSummary[] = [
      makeSession("s-old", "Oldest task", "2026-11-25T08:00:00Z", "codex"),
      makeSession("s-2", "Fix sidebar borders", "2026-11-28T07:00:00Z", "codex", otherWorkspace.id),
      makeSession("s-1", "Refactor auth queue", "2026-11-28T09:00:00Z", "claude-code"),
      makeSession("s-3", "Inspect batch import", "2026-11-27T09:00:00Z", "deepseek-harness"),
      {
        ...makeSession("s-archived", "Archived task", "2026-11-28T10:00:00Z"),
        archived: true,
      },
    ];
    const onResumeSession = vi.fn();
    const onRuntimeChanged = vi.fn();
    const user = userEvent.setup();

    renderCard({
      workspaces: [workspace, otherWorkspace],
      sessions,
      installations: [
        { agent: "claude-code", installed: true },
        { agent: "codex", installed: true },
      ] as AgentInstallation[],
      onResumeSession,
      onRuntimeChanged,
      onNewSession: vi.fn(),
      onOpenRemote: vi.fn(),
      onOpenProjectAgent: vi.fn(),
    });

    expect(
      screen.getByRole("heading", { name: tr("onboarding.foundSessions", { count: 4 }) }),
    ).toBeVisible();
    expect(screen.getByText(tr("onboarding.workspaceCount", { count: 2 }))).toBeVisible();
    expect(screen.getByText("Refactor auth queue")).toBeVisible();
    expect(screen.getByText("Fix sidebar borders")).toBeVisible();
    expect(screen.getByText("Inspect batch import")).toBeVisible();
    expect(screen.queryByText("Oldest task")).not.toBeInTheDocument();
    expect(screen.queryByText("Archived task")).not.toBeInTheDocument();
    expect(screen.queryByText(tr("onboarding.checkResultsStep"))).not.toBeInTheDocument();
    expect(screen.queryByText(tr("onboarding.readScope"))).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: `${tr("onboarding.resumeSession")}: Refactor auth queue`,
      }),
    );
    expect(onResumeSession).toHaveBeenCalledExactlyOnceWith(sessions[2]);
    expect(api.updateOnboarding).toHaveBeenCalledWith({ event: "dismissed" });
    expect(screen.queryByText("Refactor auth queue")).not.toBeInTheDocument();
  });

  it("shows workspace creation CTA when zero sessions and zero workspaces exist", () => {
    renderCard({ workspaces: [], sessions: [] });
    expect(screen.getByRole("button", { name: tr("onboarding.addWorkspace") })).toBeVisible();
    expect(screen.getByRole("button", { name: tr("home.addScanRoot") })).toBeVisible();
    expect(screen.queryByText(tr("onboarding.readScope"))).not.toBeInTheDocument();
  });

  it("wires connect phone and project agent entry cards", async () => {
    const onOpenRemote = vi.fn();
    const onOpenProjectAgent = vi.fn();
    const user = userEvent.setup();
    renderCard({
      workspaces: [workspace],
      sessions: [makeSession("s-1", "Refactor auth queue", "2026-11-28T09:00:00Z")],
      remoteConnected: false,
      onOpenRemote,
      onOpenProjectAgent,
    });
    expect(screen.getByText(tr("onboarding.remoteDisconnected"))).toBeVisible();
    expect(screen.getByText(tr("onboarding.assignableSessions", { count: 1 }))).toBeVisible();
    await user.click(screen.getByRole("button", { name: tr("onboarding.scanToConnect") }));
    await user.click(screen.getByRole("button", { name: tr("onboarding.buildTeam") }));
    expect(onOpenRemote).toHaveBeenCalledOnce();
    expect(onOpenProjectAgent).toHaveBeenCalledOnce();
  });

  it("persists dismissal, hides acknowledged guides, and reopens after restart", async () => {
    const runtime = { onboarding: { ...baseOnboarding, acknowledged_version: 1 } } as RuntimeInfo;
    vi.mocked(api.updateOnboarding).mockResolvedValue(runtime);
    const onRuntimeChanged = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderCard({ onRuntimeChanged });

    await user.click(screen.getByRole("button", { name: "Dismiss getting started guide" }));
    expect(api.updateOnboarding).toHaveBeenCalledWith({ event: "dismissed" });
    expect(onRuntimeChanged).toHaveBeenCalledWith(runtime);

    rerender(
      <GettingStartedCard
        onboarding={runtime.onboarding}
        workspaces={[]}
        onRuntimeChanged={onRuntimeChanged}
        onAddWorkspace={vi.fn().mockResolvedValue(undefined)}
        onAddRoot={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.queryByText(tr("onboarding.title"))).toBeNull();

    act(() => clearOnboardingDismissal());
    rerender(
      <GettingStartedCard
        onboarding={baseOnboarding}
        workspaces={[]}
        onRuntimeChanged={onRuntimeChanged}
        onAddWorkspace={vi.fn().mockResolvedValue(undefined)}
        onAddRoot={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    expect(screen.getByRole("heading", { name: tr("onboarding.title") })).toBeVisible();
  });
});
