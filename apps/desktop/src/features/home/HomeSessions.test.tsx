// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { interactionCardCopy, readStateCopy, sessionContinuationCopy } from "@agentkib/session-ui";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { HomeSessions, type HomeSessionsState } from "./HomeSessions";

const workspace = {
  id: "workspace",
  name: "northstar-api",
  path: "/work/northstar-api",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
} as WorkspaceSummary;

function session(
  id: string,
  title: string,
  extra: Partial<ConversationSessionSummary> = {},
): ConversationSessionSummary {
  return {
    id,
    workspace_id: workspace.id,
    agent: "codex",
    title,
    updated_at: "2026-11-09T00:00:00.000Z",
    archived: false,
    sidechain: false,
    availability: "readable",
    ...extra,
  };
}

function renderSessions(
  sessions: ConversationSessionSummary[],
  state: HomeSessionsState = "ready",
  extra: Partial<Parameters<typeof HomeSessions>[0]> = {},
) {
  const props = {
    onOpen: vi.fn(),
    onShowAll: vi.fn(),
    onEnableIndex: vi.fn().mockResolvedValue(undefined),
    onRetry: vi.fn().mockResolvedValue(undefined),
    onRetrySources: vi.fn().mockResolvedValue(undefined),
    onNewSession: vi.fn(),
  };
  render(
    <HomeSessions
      state={state}
      sessions={sessions}
      workspaces={[workspace]}
      {...props}
      {...extra}
    />,
  );
  return props;
}

const groupNamed = (name: string) => screen.getByRole("region", { name });

describe("HomeSessions", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("lists what needs the person, unread results and running turns, and opens a session", () => {
    const approval = session("approval", "Fix the login timeout", {
      continuation: { status: "awaiting-approval" },
    });
    const props = renderSessions([
      approval,
      session("question", "Write the API docs", {
        agent: "claude-code",
        continuation: { status: "waiting-input" },
      }),
      session("done", "Check the nightly retries", {
        readState: {
          source: "agentkib",
          status: "unread",
          freshness: "current",
          version: "1",
          firstUnread: { type: "result", resultId: "r", turnId: "t" },
          latestResult: {
            id: "r",
            turnId: "t",
            itemId: null,
            outcome: "failed",
            completedAt: null,
          },
        },
      }),
      session("dsh", "Refactor the canvas drag", {
        agent: "deepseek-harness",
        continuation: { status: "running", executionLocation: "external" },
      }),
    ]);
    const needs = groupNamed(tr("home.needsYou"));
    expect(within(needs).getByRole("heading")).toHaveTextContent(`${tr("home.needsYou")}2`);
    const approvalRow = within(needs).getByRole("button", { name: /Fix the login timeout/ });
    expect(approvalRow).toHaveTextContent("Codex · northstar-api ·");
    expect(approvalRow).toHaveTextContent(interactionCardCopy("en-US").waitingApproval);
    expect(within(needs).getByRole("button", { name: /Write the API docs/ })).toHaveTextContent(
      interactionCardCopy("en-US").waitingAnswer,
    );
    expect(
      within(groupNamed(readStateCopy("en-US").pending)).getByRole("button", {
        name: /Check the nightly retries/,
      }),
    ).toHaveTextContent(readStateCopy("en-US").failed);
    expect(
      within(groupNamed(tr("home.inProgress"))).getByRole("button", {
        name: /Refactor the canvas drag/,
      }),
    ).toHaveTextContent(sessionContinuationCopy("en-US").runningIn("DeepSeek Harness"));
    expect(screen.queryByText(tr("home.allClear"))).toBeNull();
    expect(screen.queryByRole("region", { name: tr("home.recentSessions") })).toBeNull();

    fireEvent.click(approvalRow);
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(approval);
  });

  it("says how long a turn in another client has run", () => {
    const startedAt = new Date(Date.now() - 4 * 60_000).toISOString();
    renderSessions([
      session("app", "Upgrade dependencies", { externalTurn: { status: "running", startedAt } }),
    ]);
    const row = screen.getByRole("button", { name: /Upgrade dependencies/ });
    expect(row).toHaveTextContent(
      `Codex · northstar-api · ${tr("home.runningFor", { duration: "4 minutes" })}`,
    );
    expect(row).toHaveTextContent(sessionContinuationCopy("en-US").runningIn("Codex"));
  });

  it("is all caught up when nothing waits, and keeps the recent sessions", () => {
    const recent = session("recent", "Tidy the routes", { agent: "claude-code" });
    const props = renderSessions([recent]);
    expect(screen.getByRole("heading", { name: tr("home.allClear") })).toBeVisible();
    expect(screen.getByText(tr("home.allClearHint"))).toBeVisible();
    expect(screen.queryByRole("region", { name: tr("home.needsYou") })).toBeNull();
    const list = screen.getByRole("region", { name: tr("home.recentSessions") });
    fireEvent.click(within(list).getByRole("button", { name: /Tidy the routes/ }));
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(recent);
    fireEvent.click(within(list).getByRole("button", { name: tr("home.viewAll") }));
    expect(props.onShowAll).toHaveBeenCalledOnce();
  });

  it("names a worktree session after its repository, as the directory does", () => {
    const checkout = {
      repository_group_id: "repo",
      kind: "primary" as const,
      primary_path: "/work/atlas",
      name: null,
      branch: "main",
      status: "present" as const,
    };
    render(
      <HomeSessions
        state="ready"
        sessions={[
          session("gone", "Old experiment", {
            workspace_id: "work",
            agent: "claude-code",
            worktree: {
              repository_group_id: "repo",
              name: "gone",
              path: "/work/atlas-worktrees/gone",
              branch: null,
              status: "deleted",
            },
          }),
          session("notes", "Tidy notes", { workspace_id: "work", agent: "claude-code" }),
        ]}
        workspaces={[
          { ...workspace, id: "atlas", name: "atlas", path: "/work/atlas", checkout },
          { ...workspace, id: "work", name: "work", path: "/work" },
        ]}
        onOpen={vi.fn()}
        onShowAll={vi.fn()}
        onEnableIndex={vi.fn()}
        onRetry={vi.fn()}
        onRetrySources={vi.fn()}
        onNewSession={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Old experiment/ })).toHaveTextContent(
      "Claude Code · atlas ·",
    );
    expect(screen.getByRole("button", { name: /Tidy notes/ })).toHaveTextContent(
      "Claude Code · work ·",
    );
  });

  it("offers to turn the session index on without revealing cached sessions", () => {
    const props = renderSessions([session("cached", "Cached private session")], "disabled");
    expect(screen.getByText(tr("conversations.indexDisabled"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("home.enableIndex") }));
    expect(props.onEnableIndex).toHaveBeenCalledOnce();
    expect(screen.queryByText("Cached private session")).toBeNull();
  });

  it("shows placeholder rows, never a loading card, before the first read", () => {
    renderSessions([session("cached", "Cached private session")], "loading");
    expect(screen.getByRole("status")).toHaveTextContent(tr("home.continuationsScanning"));
    expect(screen.queryByText("Cached private session")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("explains a failed read and retries it", () => {
    const props = renderSessions([], "error", { error: "Source unavailable" });
    expect(screen.getByText("Source unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetry).toHaveBeenCalledOnce();
  });

  it("starts the first session when there is none yet", () => {
    const props = renderSessions([]);
    expect(screen.getByText(tr("home.firstSession"))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.newConversation") }));
    expect(props.onNewSession).toHaveBeenCalledOnce();
  });

  it("notes an installed Agent whose sessions could not be read, with a retry", () => {
    const props = renderSessions([session("recent", "Tidy the routes")], "ready", {
      unavailableAgents: ["antigravity"],
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      tr("sessions.sourceUnavailable", { agent: "Antigravity" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(props.onRetrySources).toHaveBeenCalledOnce();
  });
});
