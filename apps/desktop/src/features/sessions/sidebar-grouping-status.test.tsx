// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupWorkersUnderLeads } from "@agentkib/session-catalog";
import { SessionContinuationDot, sessionContinuationListState } from "@agentkib/session-ui";
import { initializeI18n } from "@/core/i18n";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { SessionDirectory } from "./SessionDirectory";
import { useSessionHub } from "./SessionHubContext";
import { filterSessions } from "./session-catalog";
import { useSessionViewStore } from "./session-view-store";

vi.mock("@/features/home/home-query", async (original) => ({
  ...(await original<typeof import("@/features/home/home-query")>()),
  useHomeInstallations: () => ({ data: [{ agent: "antigravity", installed: true }] }),
}));
vi.mock("./SessionHubContext", () => ({ useSessionHub: vi.fn() }));
vi.mock("./SessionRowMenu", () => ({ SessionRowMenu: vi.fn(() => null) }));
vi.mock("@/features/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: string }) => <span aria-hidden="true">{agent}</span>,
}));

const workspace: WorkspaceSummary = {
  id: "ws-1",
  name: "AgentKib",
  path: "/projects/agentkib",
} as WorkspaceSummary;

function makeSession(overrides: Partial<ConversationSessionSummary>): ConversationSessionSummary {
  return {
    id: "s-1",
    workspace_id: "ws-1",
    agent: "codex",
    title: "Session",
    availability: "readable",
    archived: false,
    sidechain: false,
    ...overrides,
  } as ConversationSessionSummary;
}

describe("P1-1 unified status dots and P1-2 Lead-Worker sidebar grouping", () => {
  beforeEach(() => {
    initializeI18n("zh-CN");
    useSessionViewStore.setState({
      agent: "all",
      host: "all",
      filter: "current",
      unreadOnly: false,
      execution: false,
      collapsed: {},
      workspaceOrder: [],
      sessionOrder: {},
      scrollTop: 0,
      requestedPanel: undefined,
    });
  });
  afterEach(cleanup);

  it("renders a clean single-ring spinner without a bullseye outer ring and distinguishes terminal connected", () => {
    const { container, rerender } = render(
      <SessionContinuationDot label="运行中 · 未读" active unread />,
    );
    const dot = container.querySelector("i")!;
    expect(dot).toHaveClass("animate-spin");
    expect(dot).toHaveAttribute("data-unread", "true");
    expect(dot.className).not.toContain("ring-offset-2");

    const terminalState = sessionContinuationListState(
      {
        agent: "claude-code",
        continuation: { status: "idle", executionLocation: "terminal" },
      },
      "zh-CN",
    );
    expect(terminalState?.terminal).toBe(true);
    rerender(<SessionContinuationDot label={terminalState!.label} terminal />);
    expect(container.querySelector('[data-terminal="true"]')).not.toBeNull();
  });

  it("groups same-workspace workers directly beneath their Lead, supports collapse/expand, and keeps paused lead amber", () => {
    const workerA = makeSession({
      id: "worker-a",
      title: "Worker A",
      updated_at: "2026-11-27T10:05:00Z",
      orchestration: { role: "worker", leadId: "lead-1", name: "api" },
    });
    const standalone = makeSession({
      id: "standalone",
      title: "Standalone",
      updated_at: "2026-11-27T10:04:00Z",
    });
    const lead = makeSession({
      id: "lead-1",
      agent: "claude-code",
      title: "Release Lead",
      updated_at: "2026-11-27T10:02:00Z",
      orchestration: { role: "lead", workers: 1, paused: true },
    });
    const orphanWorker = makeSession({
      id: "worker-orphan",
      title: "Orphan Worker",
      updated_at: "2026-11-27T10:01:00Z",
      orchestration: { role: "worker", leadId: "other-lead", name: "docs" },
    });

    const grouped = groupWorkersUnderLeads([workerA, standalone, lead, orphanWorker]);
    expect(grouped.map((entry) => entry.session.id)).toEqual([
      "standalone",
      "lead-1",
      "worker-orphan",
    ]);
    expect(grouped[1].workers.map((w) => w.id)).toEqual(["worker-a"]);

    const sessions = [workerA, standalone, lead, orphanWorker];
    vi.mocked(useSessionHub).mockReturnValue({
      remoteHosts: [],
      remoteErrors: {},
      localEnabled: true,
      workspaces: [workspace],
      sessions,
      filtered: filterSessions(sessions, [workspace], {
        query: "",
        agent: "all",
        filter: "current",
      }),
      selected: standalone,
      selectedWorkspace: workspace,
      statuses: [],
      errors: {},
      loading: false,
      refreshing: false,
      ready: true,
      usable: true,
      historyRevision: 0,
      conversationRefreshRevision: 0,
      runtimeReady: true,
      enabled: true,
      workspacesLoading: false,
      workspacesError: "",
      catalogError: "",
      hiddenSessionNotice: false,
      visibility: { execution: false },
      select: vi.fn(),
      selectionVersion: () => 0,
      refresh: vi.fn().mockResolvedValue(undefined),
      retryWorkspaces: vi.fn(),
    } as unknown as ReturnType<typeof useSessionHub>);

    const { container } = render(<SessionDirectory />);
    const workerGroup = container.querySelector<HTMLElement>('[data-lead-workers-group="lead-1"]')!;
    expect(workerGroup).not.toBeNull();
    expect(within(workerGroup).getByText("Worker A")).toBeVisible();
    expect(
      container.querySelector('[data-orchestration="lead"][data-paused="true"]'),
    ).not.toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>(
      '[data-lead-workers-toggle="lead-1"]',
    )!;
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector('[data-lead-workers-group="lead-1"]')).toBeNull();
  });
});
