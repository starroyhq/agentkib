// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { McpMigrationCandidate, SupportedLocale } from "@/core/types";
import { McpImportPanel } from "./McpImportPanel";

vi.mock("@/core/api", () => ({
  api: { nativeMcpCandidates: vi.fn(), previewMcpImport: vi.fn(), applyMcpImport: vi.fn() },
}));

const message = (code: string, params?: Record<string, string>) => ({
  key: `mcp.manage.diagnostic.${code}`,
  ...(params ? { params } : {}),
});
const candidate = (patch: Partial<McpMigrationCandidate>): McpMigrationCandidate => ({
  id: "id",
  agent: "claude-code",
  scope: "local",
  name: "Demo",
  source_path: "/fixture/.claude.json",
  transport: "http",
  endpoint: "https://example.invalid/mcp",
  has_secret_values: false,
  supported: false,
  warnings: ["Legacy english"],
  warning_messages: [message("native_readonly_scope", { scope: "local" })],
  ...patch,
});

afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());

async function scan() {
  render(<McpImportPanel project="/fixture" onSaved={vi.fn().mockResolvedValue(undefined)} />);
  await userEvent.setup().click(screen.getByRole("button", { name: tr("mcp.manage.scanNative") }));
}

describe("Claude Code scopes in the MCP import panel", () => {
  it("explains what is read-only and what is invisible, and disables the read-only entries", async () => {
    await initializeI18n("en-US");
    vi.mocked(api.nativeMcpCandidates).mockResolvedValue([
      candidate({}),
      candidate({
        id: "managed",
        scope: "managed",
        name: "Org",
        warning_messages: [
          message("native_readonly_scope", { scope: "managed" }),
          message("native_inactive_exclusive"),
        ],
        warnings: ["a", "b"],
      }),
    ]);
    await scan();
    expect(
      await screen.findByText(
        "Claude Code: local, managed and plugin servers are shown read-only. claude.ai connectors, and policy delivered by MDM, the Windows registry or the claude.ai console, are not visible here.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Read-only: this local-scope server is shown for reference/),
    ).toBeVisible();
    expect(screen.getByText(/Read-only: this managed-scope server/)).toBeVisible();
    expect(screen.getByText(/Not loaded: a managed-mcp.json on this machine/)).toBeVisible();
    expect(screen.queryByText("Legacy english")).not.toBeInTheDocument();
    for (const checkbox of screen.getAllByRole("checkbox"))
      expect(checkbox).toHaveAttribute("aria-disabled", "true");
  });

  it.each([
    [
      "zh-CN",
      "只读：此 local 作用域的服务仅供参考，AgentKib 不收录也不迁移。",
      /Claude Code：local、managed/,
    ],
    [
      "zh-Hant",
      "唯讀：此 local 範圍的服務僅供參考，AgentKib 不會收錄也不會遷移。",
      /Claude Code：local、managed/,
    ],
    [
      "ja-JP",
      "読み取り専用：この local スコープのサーバーは参考表示です。AgentKib は取り込みも移行も行いません。",
      /Claude Code：local、managed/,
    ],
  ])("shows the notices in %s", async (locale, line, hint) => {
    await initializeI18n(locale as SupportedLocale);
    vi.mocked(api.nativeMcpCandidates).mockResolvedValue([candidate({})]);
    await scan();
    expect(await screen.findByText(line)).toBeVisible();
    expect(screen.getByText(hint)).toBeVisible();
  });

  it("shows no Claude notice when no Claude candidate was found", async () => {
    await initializeI18n("en-US");
    vi.mocked(api.nativeMcpCandidates).mockResolvedValue([
      candidate({
        agent: "codex",
        scope: "project",
        supported: true,
        warnings: [],
        warning_messages: [],
      }),
    ]);
    await scan();
    expect(await screen.findByText("Demo")).toBeVisible();
    expect(screen.queryByText(/Claude Code: local, managed and plugin/)).not.toBeInTheDocument();
  });
});
