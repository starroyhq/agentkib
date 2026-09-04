// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n } from "@/core/i18n";
import type {
  ConversationSessionSummary,
  SessionHandoffDraft,
  WorkspaceSummary,
} from "@/core/types";
import { SessionHandoffDialog } from "./SessionHandoffDialog";

vi.mock("@/core/api", () => ({
  api: {
    prepareSessionHandoff: vi.fn(),
    planSessionMcpConnection: vi.fn(),
    planSessionHandoff: vi.fn(),
    sanitizeSessionHandoff: vi.fn(),
  },
}));

const workspace = { id: "workspace", name: "Workspace" } as WorkspaceSummary;
const session = {
  id: "session",
  workspace_id: workspace.id,
  agent: "codex",
  title: "Long session",
  archived: false,
  sidechain: false,
  availability: "readable",
} as ConversationSessionSummary;

const capabilities = {
  source_agent: "codex",
  target_agent: "claude-code",
  source_read: { status: "supported" },
  source_parse: { status: "supported" },
  native_resume: { status: "supported" },
  file_handoff: { status: "supported" },
  windowed_context: { status: "unavailable", reason: "mcp-not-connected" },
  mcp_setup: { status: "supported" },
  interactive_launch: { status: "supported" },
} as const;

const draft: SessionHandoffDraft = {
  filename: "continuation.md",
  format: "markdown",
  content: "windowed preview",
  redaction_count: 0,
  source_fingerprint: "fingerprint",
  mode: "native-session",
  native_capability: { supported: true, beta: true },
  capabilities,
  stats: {
    turn_count: 100,
    message_count: 60,
    tool_call_count: 20,
    tool_result_count: 20,
    attachment_count: 0,
  },
  history_budget_tokens: 120_000,
  window_strategy: "windowed",
  window_stats: {
    estimated_total_tokens: 1_000_000,
    estimated_active_tokens: 120_000,
    estimated_deferred_tokens: 880_000,
    active: {
      turn_count: 12,
      message_count: 8,
      tool_call_count: 2,
      tool_result_count: 2,
      attachment_count: 0,
    },
    deferred_turn_count: 88,
    deferred_block_count: 90,
    estimate_quality: "conservative",
  },
  archive_id: "00000000-0000-4000-8000-000000000000",
  mcp_available: false,
  losses: [],
};

describe("SessionHandoffDialog", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => {
    vi.mocked(api.prepareSessionHandoff).mockReset();
    vi.mocked(api.planSessionMcpConnection).mockReset();
  });
  afterEach(cleanup);

  it("uses the safe default budget and blocks a windowed import without MCP", async () => {
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({ status: "ready", draft });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["claude-code"]}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));
    await waitFor(() =>
      expect(api.prepareSessionHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ history_budget_tokens: 120_000 }),
      ),
    );
    expect(await screen.findByText(/Full history ≈1000k Token/)).toBeTruthy();
    expect(screen.getByText(/not connected to AgentKib MCP/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Claude Code MCP" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Review import changes" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("plans an exact MCP connection change and preserves the continuation request", async () => {
    const onMcpConnectionPlanned = vi.fn();
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({ status: "ready", draft });
    vi.mocked(api.planSessionMcpConnection).mockResolvedValue({
      id: "change-set",
      project_root: "/workspace",
      created_at: "2026-09-02T00:00:00Z",
      changes: [
        {
          target: "/workspace/.mcp.json",
          scope: "project",
          before: "{}",
          after: '{"mcpServers":{}}',
          risk: "medium",
          validator: "json",
        },
      ],
      requires_home_approval: false,
    });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["claude-code"]}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={onMcpConnectionPlanned}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Claude Code MCP" }));

    await waitFor(() =>
      expect(onMcpConnectionPlanned).toHaveBeenCalledWith(
        expect.objectContaining({ id: "change-set" }),
        {
          sessionId: "session",
          targetAgent: "claude-code",
          historyBudgetTokens: 120_000,
          format: "markdown",
        },
      ),
    );
  });

  it("offers MCP setup for Codex", async () => {
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({ status: "ready", draft });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={[]}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));

    expect(await screen.findByRole("button", { name: "Connect Codex MCP" })).toBeTruthy();
  });

  it.each([
    ["cursor", "Cursor"],
    ["open-claw", "OpenClaw"],
    ["hermes", "Hermes"],
    ["deepseek-harness", "DeepSeek Harness"],
  ] as const)(
    "explains that %s cannot read a private archive instead of offering MCP setup",
    async (targetAgent, agentLabel) => {
      vi.mocked(api.prepareSessionHandoff).mockResolvedValue({
        status: "ready",
        draft: {
          ...draft,
          capabilities: {
            ...capabilities,
            target_agent: targetAgent,
            native_resume: { status: "unsupported", reason: "target-not-supported" },
            windowed_context: { status: "unsupported", reason: "target-not-supported" },
            mcp_setup: { status: "unsupported", reason: "target-not-supported" },
            interactive_launch: { status: "unsupported", reason: "target-not-supported" },
          },
        },
      });
      render(
        <SessionHandoffDialog
          workspace={workspace}
          session={session}
          targetAgents={[targetAgent]}
          onClose={vi.fn()}
          onPlanned={vi.fn()}
          onMcpConnectionPlanned={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));

      expect(
        await screen.findByText(
          new RegExp(`${agentLabel} cannot retrieve AgentKib private archives yet`, "i"),
        ),
      ).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Connect .* MCP/ })).toBeNull();
      expect(
        (screen.getByRole("button", { name: "Review import changes" }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(api.planSessionMcpConnection).not.toHaveBeenCalled();
    },
  );

  it("treats excluded reasoning as privacy information without requiring acknowledgement", async () => {
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({
      status: "ready",
      draft: {
        ...draft,
        mcp_available: true,
        losses: [{ code: "reasoning-excluded", count: 12 }],
      },
    });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["claude-code"]}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));

    expect(await screen.findByText(/For privacy, 12 internal reasoning records/)).toBeTruthy();
    expect(screen.queryByText(/I understand that the items above/)).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Review import changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("does not present a short non-empty session as zero tokens", async () => {
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({
      status: "ready",
      draft: {
        ...draft,
        window_strategy: "full",
        window_stats: {
          ...draft.window_stats,
          estimated_total_tokens: 240,
          estimated_active_tokens: 240,
          estimated_deferred_tokens: 0,
          deferred_turn_count: 0,
          deferred_block_count: 0,
        },
        archive_id: undefined,
        mcp_available: false,
      },
    });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["cursor"]}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));

    expect(await screen.findByText(/Full history <1k Token/)).toBeTruthy();
    expect(screen.queryByText(/Full history ≈0k Token/)).toBeNull();
    expect(screen.queryByText(/cannot retrieve AgentKib private archives yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Connect .* MCP/ })).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Review import changes" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
