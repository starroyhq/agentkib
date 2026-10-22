// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { WorkspaceSummary } from "@/core/types";
import { McpManagementPanel } from "./McpManagementPanel";

vi.mock("@/core/api", () => ({
  api: {
    mcpManagementState: vi.fn(),
    planMcpConnections: vi.fn(),
    applyMcpConnections: vi.fn(),
    verifyMcpConnection: vi.fn(),
  },
}));
vi.mock("@/components/AppDialogProvider", () => ({ useAppDialogs: () => ({ confirm: vi.fn() }) }));
const workspace: WorkspaceSummary = {
  id: "review",
  name: "Review workspace",
  path: "/workspace",
  status: "healthy",
  asset_count: 0,
  warning_count: 0,
  sources: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.mcpManagementState).mockResolvedValue({ revision: "r1", servers: [] });
  vi.mocked(api.planMcpConnections).mockResolvedValue({
    token: "reviewed-token",
    workspace_id: workspace.id,
    requires_home_approval: true,
    targets: [
      {
        agent: "codex",
        status: "missing",
        selected: true,
        target: "/home/.codex/config.toml",
        scope: "agent-home",
      },
    ],
    changes: [
      {
        target: "/home/.codex/config.toml",
        scope: "agent-home",
        before: "",
        after: "reviewed configuration",
      },
    ],
  });
  vi.mocked(api.applyMcpConnections).mockResolvedValue({
    targets: [{ agent: "codex", status: "applied" }],
  });
  vi.mocked(api.verifyMcpConnection).mockResolvedValue({
    url: "http://127.0.0.1:47653/mcp/review/codex",
    checked_at: "2026-10-16T00:00:00Z",
    builtin_tools: 1,
    builtin_tool_names: ["builtin.fixture"],
    external_tools: ["external.fixture"],
  });
});
afterEach(cleanup);

describe("production MCP management connection entry", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "opens the actual batch review and keeps explicit workspace/Home approval in %s",
    async (locale) => {
      await initializeI18n(locale);
      const user = userEvent.setup();
      render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <McpManagementPanel workspaces={[workspace]} onChanged={vi.fn()} drafts={new Map()} />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(api.mcpManagementState).toHaveBeenCalledExactlyOnceWith({ project: undefined }),
      );
      await user.click(screen.getByRole("button", { name: tr("mcp.manage.more") }));
      await user.click(await screen.findByRole("menuitem", { name: tr("mcp.manage.connect") }));
      expect(screen.getByText(tr("mcp.manage.connectHint"))).toBeVisible();
      const prepare = screen.getByRole("button", { name: tr("mcp.manage.checkPreview") });
      expect(prepare).toBeDisabled();
      expect(api.planMcpConnections).not.toHaveBeenCalled();
      expect(api.applyMcpConnections).not.toHaveBeenCalled();
      await user.click(screen.getByRole("combobox", { name: tr("mcp.manage.workspace") }));
      await user.click(await screen.findByRole("option", { name: workspace.name }));
      fireEvent.click(prepare);
      const apply = await screen.findByRole("button", { name: tr("mcp.manage.applyConnection") });
      expect(api.planMcpConnections).toHaveBeenCalledExactlyOnceWith({
        workspaceId: workspace.id,
        targetAgents: ["codex", "claude-code"],
        rebindAgents: [],
      });
      expect(screen.getByText("+ reviewed configuration")).toBeVisible();
      expect(apply).toBeDisabled();
      expect(api.applyMcpConnections).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("checkbox", { name: tr("mcp.manage.homeApproval") }));
      fireEvent.click(apply);
      fireEvent.click(apply);
      await waitFor(() =>
        expect(api.applyMcpConnections).toHaveBeenCalledExactlyOnceWith({
          token: "reviewed-token",
          approveHome: true,
        }),
      );
      await waitFor(() =>
        expect(api.verifyMcpConnection).toHaveBeenCalledExactlyOnceWith(workspace.id, "codex"),
      );
      expect(await screen.findByText(tr("mcp.manage.reloadHint"))).toBeVisible();
      expect(await screen.findByText("builtin.fixture, external.fixture")).toBeVisible();
    },
  );
});
