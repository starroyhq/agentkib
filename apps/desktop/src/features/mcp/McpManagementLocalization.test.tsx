// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import { McpBatchConnectionPanel } from "./McpBatchConnectionPanel";
import { McpImportPanel } from "./McpImportPanel";
import type { WorkspaceSummary } from "@/core/types";

vi.mock("@/core/api", () => ({
  api: {
    planMcpConnections: vi.fn(),
    applyMcpConnections: vi.fn(),
    verifyMcpConnection: vi.fn(),
    nativeMcpCandidates: vi.fn(),
    previewMcpImport: vi.fn(),
    applyMcpImport: vi.fn(),
  },
}));
const message = (code: string) => ({ key: `mcp.manage.diagnostic.${code}` });
const workspaces = [{ id: "project", path: "/fixture", name: "Fixture" }] as WorkspaceSummary[];
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

describe("MCP structured diagnostic localization", () => {
  it("shows traditional Chinese connection blockers and recovery receipts", async () => {
    await initializeI18n("zh-Hant");
    vi.mocked(api.planMcpConnections).mockResolvedValue({
      token: "preview",
      workspace_id: "project",
      requires_home_approval: false,
      targets: [
        {
          agent: "codex",
          status: "blocked",
          selected: false,
          reason: "Legacy blocker",
          reason_message: message("connection_blocked"),
        },
        {
          agent: "claude-code",
          status: "missing",
          selected: true,
          reason: "Legacy missing",
          reason_message: message("connection_missing"),
        },
      ],
      changes: [{ target: "/fixture/.mcp.json", scope: "project", before: "", after: "{}" }],
    });
    vi.mocked(api.applyMcpConnections).mockResolvedValue({
      success: false,
      message: "Legacy recovery summary",
      diagnostics: [
        { ...message("write_filesystem"), params: { code: "EACCES" } },
        message("recovery_incomplete"),
      ],
      targets: [
        {
          agent: "claude-code",
          status: "recovery-incomplete",
          reason: "Legacy recovery reason",
          reason_message: message("connection_recovery_incomplete"),
        },
      ],
    });
    render(
      <McpBatchConnectionPanel project="/fixture" workspaces={workspaces} servicesRevision="r1" />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.checkPreview") }));
    expect(
      await screen.findByText(
        "設定不安全、已損壞、含未知 agentkib 項目或工作區歸屬不明確；請檢查後重試",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Legacy blocker")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.applyConnection") }));
    expect(await screen.findByText(/設定檔案系統操作失敗（EACCES）/)).toBeVisible();
    expect(screen.getByText(/復原不完整，請檢查列出的檔案/)).toBeVisible();
    expect(screen.getByText(/批次操作失敗且無法確認復原/)).toBeVisible();
    expect(screen.queryByText("Legacy recovery summary")).not.toBeInTheDocument();
    expect(api.verifyMcpConnection).not.toHaveBeenCalled();
  });

  it("shows Japanese native warnings, import blockers and returned failures", async () => {
    await initializeI18n("ja-JP");
    vi.mocked(api.nativeMcpCandidates).mockResolvedValue([
      {
        id: "native",
        agent: "codex",
        scope: "project",
        name: "Native",
        source_path: "/fixture/.mcp.json",
        transport: "http",
        endpoint: "https://example.invalid",
        supported: true,
        has_secret_values: true,
        warnings: ["Legacy native warning"],
        warning_messages: [message("native_secret_required")],
      },
    ]);
    vi.mocked(api.previewMcpImport).mockResolvedValue({
      token: "preview",
      revision: "r1",
      items: [
        {
          key: "blocked",
          status: "blocked",
          warnings: ["Legacy transport warning"],
          warning_messages: [message("transport_unsupported")],
          required_env: [],
          required_headers: [],
        },
        {
          key: "native",
          status: "new",
          warnings: ["Legacy collection warning"],
          warning_messages: [message("native_values_not_copied")],
          required_env: ["API_KEY"],
          required_headers: [],
        },
      ],
    });
    vi.mocked(api.applyMcpImport).mockResolvedValue({
      revision: "r2",
      results: [
        {
          key: "native",
          status: "failed",
          error: "Legacy error",
          error_message: message("invalid_native_entry"),
        },
      ],
    });
    render(<McpImportPanel project="/fixture" onSaved={vi.fn().mockResolvedValue(undefined)} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.scanNative") }));
    expect(
      await screen.findByText("秘密値は mcp.local.json に再入力する必要があります"),
    ).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: /Native/ }));
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.previewNative") }));
    expect(await screen.findByText("SSE または不明な通信方式は取り込めません")).toBeVisible();
    expect(
      screen.getByText(
        "元の秘密値はコピーしません。有効化する前に必要な認証情報を入力してください",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: tr("mcp.manage.collect") }));
    expect(await screen.findByText(/ネイティブ MCP 項目が無効です/)).toBeVisible();
    expect(screen.queryByText("Legacy error")).not.toBeInTheDocument();
  });

  it("preserves legacy English diagnostics when optional metadata is absent", async () => {
    await initializeI18n("en-US");
    vi.mocked(api.planMcpConnections).mockResolvedValue({
      token: "preview",
      workspace_id: "project",
      requires_home_approval: false,
      changes: [],
      targets: [
        { agent: "codex", status: "blocked", selected: false, reason: "Legacy English diagnostic" },
      ],
    });
    render(
      <McpBatchConnectionPanel project="/fixture" workspaces={workspaces} servicesRevision="r1" />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: tr("mcp.manage.checkPreview") }));
    expect(await screen.findByText("Legacy English diagnostic")).toBeVisible();
  });
});
