// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
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
    sessionSourceCapability: vi.fn(),
    planSessionMcpConnection: vi.fn(),
    planSessionHandoff: vi.fn(),
    sanitizeSessionHandoff: vi.fn(),
    cursorBridge: vi.fn(),
    cursorBridgeBundle: vi.fn(),
    revealCursorBridgeBundle: vi.fn(),
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
    vi.mocked(api.sessionSourceCapability).mockReset().mockResolvedValue({ status: "supported" });
    vi.mocked(api.prepareSessionHandoff).mockReset();
    vi.mocked(api.planSessionMcpConnection).mockReset();
    vi.mocked(api.cursorBridge)
      .mockReset()
      .mockResolvedValue({
        supported: true,
        supportedVersions: ["3.22.12", "3.23.12"],
        bindings: [
          {
            id: "selected-binding",
            profile: "explicit-profile",
            version: "3.22.12",
            connected: true,
          },
        ],
      });
  });
  afterEach(cleanup);

  it("requires an explicitly selected IDE window even when one is connected", async () => {
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["cursor"]}
        initialRequest={{
          sessionId: session.id,
          targetAgent: "cursor",
          historyBudgetTokens: 120000,
          format: "markdown",
          targetSurface: "cursor-ide",
          autoPrepare: false,
        }}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connect a Cursor window" })).toBeEnabled(),
    );
    await waitFor(() =>
      expect(api.cursorBridge).toHaveBeenCalledWith({
        action: "status",
        workspaceId: workspace.id,
      }),
    );
    expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeDisabled();
    expect(api.prepareSessionHandoff).not.toHaveBeenCalled();
  });

  it("passes IDE surface and binding through both preview and approved planning", async () => {
    const nextDraft = {
      ...draft,
      window_strategy: "full" as const,
      archive_id: undefined,
      mcp_available: false,
      target_fingerprint: "cursor-frozen",
    };
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({ status: "ready", draft: nextDraft });
    vi.mocked(api.planSessionHandoff).mockResolvedValue({
      change_set: {} as import("@/core/types").ChangeSet,
      launch_request: {
        mode: "native-import",
        workspace_id: workspace.id,
        target_agent: "cursor",
        operation_id: "op",
        plan_hash: "hash",
      },
    });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["cursor"]}
        initialRequest={{
          sessionId: session.id,
          targetAgent: "cursor",
          historyBudgetTokens: 120000,
          format: "markdown",
          targetSurface: "cursor-ide",
          bindingId: "selected-binding",
          autoPrepare: false,
        }}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));
    await waitFor(() =>
      expect(api.prepareSessionHandoff).toHaveBeenCalledWith(
        expect.objectContaining({ target_surface: "cursor-ide", binding_id: "selected-binding" }),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Review import changes" }));
    await waitFor(() =>
      expect(api.planSessionHandoff).toHaveBeenCalledWith(
        "session",
        "workspace",
        draft.filename,
        draft.format,
        undefined,
        "cursor",
        draft.mode,
        draft.source_fingerprint,
        true,
        120000,
        undefined,
        "cursor-frozen",
        "cursor-ide",
        "selected-binding",
      ),
    );
  });

  it("shows the observed Cursor source surface without inferring it from agent kind", async () => {
    vi.mocked(api.sessionSourceCapability).mockResolvedValue({
      status: "supported",
      source_surface: "cursor-ide",
    });
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={{ ...session, agent: "cursor" }}
        targetAgents={["claude-code"]}
        onClose={vi.fn()}
        onPlanned={vi.fn()}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    expect(await screen.findByText("Source: Cursor IDE · normal window")).toBeVisible();
  });

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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));

    expect(await screen.findByRole("button", { name: "Connect Codex MCP" })).toBeTruthy();
  });

  it.each(["open-claw", "hermes", "grok-build"] as const)(
    "blocks %s only when its concrete source format is unsupported",
    async (agent) => {
      vi.mocked(api.sessionSourceCapability).mockResolvedValue({
        status: "unsupported",
        reason: "Unverified source format",
      });
      render(
        <SessionHandoffDialog
          workspace={workspace}
          session={{ ...session, agent }}
          targetAgents={["grok-build"]}
          onClose={vi.fn()}
          onPlanned={vi.fn()}
          onMcpConnectionPlanned={vi.fn()}
        />,
      );

      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("Unverified source format"),
      );
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeDisabled();
      expect(api.prepareSessionHandoff).not.toHaveBeenCalled();
    },
  );

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

      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
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

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
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
  it("keeps target conversion losses behind acknowledgement and passes the frozen target fingerprint", async () => {
    const planned = {
      change_set: {
        id: "changes",
        project_root: "/tmp/project",
        created_at: "2026-09-27",
        requires_home_approval: false,
        changes: [],
      },
      launch_request: {
        mode: "native-import" as const,
        workspace_id: "workspace",
        target_agent: "opencode" as const,
        operation_id: "operation",
        plan_hash: "hash",
      },
    };
    vi.mocked(api.planSessionHandoff).mockReset().mockResolvedValue(planned);
    vi.mocked(api.prepareSessionHandoff).mockResolvedValue({
      status: "ready",
      draft: {
        ...draft,
        target_fingerprint: "frozen-target",
        window_strategy: "full",
        mcp_available: false,
        archive_id: undefined,
        losses: [
          { code: "target-tool-summary", count: 2 },
          { code: "target-attachment-omitted", count: 1 },
        ],
      },
    });
    const onPlanned = vi.fn();
    render(
      <SessionHandoffDialog
        workspace={workspace}
        session={session}
        targetAgents={["opencode"]}
        onClose={vi.fn()}
        onPlanned={onPlanned}
        onMcpConnectionPlanned={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Inspect transferable content" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect transferable content" }));
    const review = await screen.findByRole("button", { name: "Review import changes" });
    expect(review).toBeDisabled();
    expect(screen.getByText(/retain 2 tool record/)).toBeVisible();
    expect(screen.getByText(/cannot retain 1 attachment/)).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(review);
    await waitFor(() => expect(onPlanned).toHaveBeenCalledWith(planned));
    expect(api.planSessionHandoff).toHaveBeenCalledWith(
      "session",
      "workspace",
      draft.filename,
      draft.format,
      undefined,
      "opencode",
      draft.mode,
      draft.source_fingerprint,
      true,
      draft.history_budget_tokens,
      undefined,
      "frozen-target",
    );
  });
});
