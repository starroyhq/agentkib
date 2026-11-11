// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  homeSessionCopy,
  interactionCardCopy,
  readStateCopy,
  sessionContinuationCopy,
} from "@agentkib/session-ui";
import { initializeI18n, tr } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import type { Approval, Live } from "@agentkib/web-client";
import { HomeSessions, type HomeSessionsState } from "./HomeSessions";
import type { HomeReplies } from "./home-replies";

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

const home = homeSessionCopy("en-US");
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
    const needs = groupNamed(home.needsYou);
    expect(within(needs).getByRole("heading")).toHaveTextContent(`${home.needsYou}2`);
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
      within(groupNamed(home.inProgress)).getByRole("button", {
        name: /Refactor the canvas drag/,
      }),
    ).toHaveTextContent(sessionContinuationCopy("en-US").runningIn("DeepSeek Harness"));
    expect(screen.queryByText(home.allClear)).toBeNull();
    expect(screen.queryByRole("region", { name: home.recentSessions })).toBeNull();

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
      `Codex · northstar-api · ${home.runningFor.replace("{duration}", "4 minutes")}`,
    );
    expect(row).toHaveTextContent(sessionContinuationCopy("en-US").runningIn("Codex"));
  });

  it("is all caught up when nothing waits, and keeps the recent sessions", () => {
    const recent = session("recent", "Tidy the routes", { agent: "claude-code" });
    const props = renderSessions([recent]);
    expect(screen.getByRole("heading", { name: home.allClear })).toBeVisible();
    expect(screen.getByText(home.allClearHint)).toBeVisible();
    expect(screen.queryByRole("region", { name: home.needsYou })).toBeNull();
    const list = screen.getByRole("region", { name: home.recentSessions });
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

  it("points to the composer above when there is no session yet", () => {
    renderSessions([]);
    expect(screen.getByText(tr("home.firstSession"))).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
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

describe("HomeSessions answering in place", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  const approval: Approval = {
    requestId: 7,
    turnId: "turn",
    method: "item/commandExecution/requestApproval",
    command: "pnpm test",
    cwd: workspace.path,
    availableDecisions: ["accept", "decline"],
    supported: true,
  };
  const waiting: Live = {
    sessionId: "approval",
    status: "waiting-approval",
    revision: 3,
    sendEnabled: false,
    approvals: [approval],
    questions: [],
  };
  function replies(extra: Partial<HomeReplies> = {}) {
    const live = vi.fn(async () => waiting);
    const value: HomeReplies = {
      client: { live } as unknown as HomeReplies["client"],
      access: {
        status: "approved",
        csrfToken: "csrf",
        bootId: "boot",
        experimentalEnabled: true,
        device: { id: "desktop", name: "Desktop", send: true, approve: true },
      },
      unconfirmed: new Set(),
      answered: new Set(),
      reply: vi.fn(async () => ({ status: "accepted" as const, requestId: "r" })),
      markAnswered: vi.fn(),
      ...extra,
    };
    return { value, live };
  }
  const approvalSession = session("approval", "Fix the login timeout", {
    continuation: { status: "awaiting-approval" },
  });

  it("opens the approval card in its row and answers it there", async () => {
    const { value, live } = replies();
    live.mockResolvedValueOnce(waiting).mockResolvedValueOnce({ ...waiting, approvals: [] });
    const props = renderSessions([approvalSession], "ready", { replies: value });
    const row = screen.getByRole("button", { name: /Fix the login timeout/ });
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(props.onOpen).not.toHaveBeenCalled();
    const card = await screen.findByRole("region", {
      name: interactionCardCopy("en-US").waitingApproval,
    });
    expect(card).toHaveTextContent("pnpm test");
    fireEvent.click(within(card).getByRole("button", { name: /Allow once/ }));
    await waitFor(() =>
      expect(value.reply).toHaveBeenCalledExactlyOnceWith(
        { ...approvalSession },
        { kind: "approve", approval, decision: "accept" },
      ),
    );
    await waitFor(() => expect(value.markAnswered).toHaveBeenCalledWith("approval"));
    expect(row).toHaveAttribute("aria-expanded", "false");
  });

  it("folds the row when the outcome is unknown and never sends again", async () => {
    const { value } = replies({
      reply: vi.fn(async () => ({ status: "unknown" as const, requestId: "r", durable: true })),
    });
    renderSessions([approvalSession], "ready", { replies: value });
    const row = screen.getByRole("button", { name: /Fix the login timeout/ });
    fireEvent.click(row);
    const card = await screen.findByRole("region", {
      name: interactionCardCopy("en-US").waitingApproval,
    });
    fireEvent.click(within(card).getByRole("button", { name: /Allow once/ }));
    await waitFor(() => expect(row).toHaveAttribute("aria-expanded", "false"));
    expect(value.reply).toHaveBeenCalledOnce();
    expect(value.markAnswered).not.toHaveBeenCalled();
  });

  it("lists a session whose decision may not have arrived as to verify, opening the session", () => {
    const { value } = replies({ unconfirmed: new Set(["approval"]) });
    const props = renderSessions([approvalSession], "ready", { replies: value });
    const row = screen.getByRole("button", { name: /Fix the login timeout/ });
    expect(row).toHaveTextContent(home.verifyResult);
    expect(row).not.toHaveAttribute("aria-expanded");
    fireEvent.click(row);
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(approvalSession);
  });

  it("keeps an answered request off the list and still opens the session from the card", async () => {
    const { value } = replies({ answered: new Set(["approval"]) });
    const other = session("question", "Write the API docs", {
      agent: "claude-code",
      continuation: { status: "waiting-input" },
    });
    const props = renderSessions([approvalSession, other], "ready", { replies: value });
    expect(screen.queryByRole("button", { name: /Fix the login timeout/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Write the API docs/ }));
    fireEvent.click(await screen.findByRole("button", { name: home.openSession }));
    expect(props.onOpen).toHaveBeenCalledExactlyOnceWith(other);
  });

  it("says when the request no longer waits", async () => {
    const { value, live } = replies();
    live.mockResolvedValue({ ...waiting, approvals: [] });
    renderSessions([approvalSession], "ready", { replies: value });
    fireEvent.click(screen.getByRole("button", { name: /Fix the login timeout/ }));
    expect(await screen.findByText(home.requestGone)).toBeVisible();
  });
});
