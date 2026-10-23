// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n } from "@/core/i18n";
import type { ContextDoctorReport, WorkspaceSummary } from "@/core/types";
import { WorkspaceDoctorPage } from "./WorkspaceDoctorPage";
import { useWorkspaceStore } from "./workspace-store";
import { PathDisplayProvider } from "@/lib/usePathDisplay";
import { homeKeys } from "@/features/home/home-query";

vi.mock("@/core/api", () => ({ api: { workspaceDoctorReport: vi.fn() } }));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({ paths: { displayContext: async () => ({ homeDirectory: "/example" }) } }),
}));
const workspace = {
  id: "e2-workspace",
  name: "Northstar",
  path: "/example/northstar",
} as WorkspaceSummary;
const report: ContextDoctorReport = {
  summary: {
    workspace_id: workspace.id,
    warning_count: 1,
    error_count: 0,
    info_count: 1,
    repairable_count: 0,
    checked_at: new Date().toISOString(),
  },
  issues: [
    {
      id: "duplicate",
      code: "instruction.exact-duplicate",
      severity: "warning",
      repairable: false,
      agent: "grok-build",
      evidence: [
        {
          path: "/example/northstar/CLAUDE.md",
          detail: "Exact duplicate of /example/northstar/AGENTS.md",
        },
      ],
    },
    {
      id: "info",
      code: "agent.read-only",
      severity: "info",
      repairable: false,
      agent: "deepseek-harness",
      evidence: [{ detail: "DeepSeek Harness is available for diagnostics only" }],
    },
  ],
  matrix: [
    {
      agent: "grok-build",
      detected: true,
      installed: true,
      enabled: true,
      writable: true,
      instructions: { status: "attention", actual: 2, expected: 1 },
      skills: { status: "healthy", actual: 0, expected: 0 },
      mcp: { status: "healthy", actual: 0, expected: 0 },
    },
  ],
};
function view(props: Partial<Parameters<typeof WorkspaceDoctorPage>[0]> = {}, withPaths = false) {
  const page = (
    <WorkspaceDoctorPage
      workspace={workspace}
      onRepair={vi.fn()}
      onDiagnosed={vi.fn()}
      {...props}
    />
  );
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {withPaths ? <PathDisplayProvider>{page}</PathDisplayProvider> : page}
    </QueryClientProvider>,
  );
}
describe("E2 diagnosis UI", () => {
  it("keeps diagnostic checks and evidence operable from the keyboard", async () => {
    view();
    await screen.findByText("CLAUDE.md and AGENTS.md contain identical instructions");
    const user = userEvent.setup();
    const checks = screen.getByRole("button", { name: /Checks by Agent/ });
    checks.focus();
    await user.keyboard("{Enter}");
    expect(checks).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
    await user.keyboard(" ");
    expect(checks).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("table")).toBeNull();
    const details = screen.getByRole("button", { name: "Details" });
    details.focus();
    await user.keyboard("{Enter}");
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Exact duplicate of /example/northstar/AGENTS.md")).toBeVisible();
    await user.keyboard(" ");
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Exact duplicate of /example/northstar/AGENTS.md")).toBeNull();
  });

  beforeAll(() => initializeI18n("en-US"));
  beforeEach(async () => {
    await changeLocale("en-US");
    document.documentElement.dataset.platform = "macos";
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  });
  afterEach(cleanup);

  it("keeps informational entries out of the problem count used by the header and summary", async () => {
    view();
    expect(await screen.findByRole("heading", { name: "Issues 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: /DeepSeek Harness/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("heading", { name: "Issues 2" })).toBeNull();
  });

  it.each([
    [
      "zh-CN",
      "CLAUDE.md 与 AGENTS.md 内容完全相同",
      "同一段指令可能被重复读取",
      "重新诊断",
      "详情",
      "各 Agent 的检查结果",
      "打开所在文件夹",
    ],
    [
      "zh-TW",
      "CLAUDE.md 與 AGENTS.md 內容完全相同",
      "同一段指令可能被重複讀取",
      "重新診斷",
      "詳細資料",
      "各 Agent 的檢查結果",
      "開啟所在資料夾",
    ],
    [
      "en-US",
      "CLAUDE.md and AGENTS.md contain identical instructions",
      "The same instructions may be read more than once",
      "Run diagnostics again",
      "Details",
      "Checks by Agent",
      "Open containing folder",
    ],
    [
      "ja-JP",
      "CLAUDE.md と AGENTS.md の内容が完全に同じです",
      "同じ指示が重複して読み込まれる可能性があります",
      "再診断",
      "詳細",
      "Agent ごとの検査結果",
      "ファイルのあるフォルダーを開く",
    ],
  ] as const)(
    "shows localized file-first issues before collapsed checks in %s",
    async (locale, title, impact, refresh, details, matrix, folder) => {
      await changeLocale(locale);
      view({ onRevealPath: vi.fn() });
      const issue = await screen.findByText(title);
      expect(screen.getByText(impact)).toBeVisible();
      expect(screen.getByRole("button", { name: refresh })).toBeVisible();
      expect(screen.getByRole("button", { name: folder })).toBeVisible();
      expect(screen.queryByText("Exact duplicate of /example/northstar/AGENTS.md")).toBeNull();
      expect(screen.queryByText("DeepSeek Harness is available for diagnostics only")).toBeNull();
      const checks = screen.getByRole("button", { name: new RegExp(matrix) });
      expect(checks.getAttribute("aria-expanded")).toBe("false");
      expect(issue.compareDocumentPosition(checks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.queryByRole("table")).toBeNull();
      fireEvent.click(checks);
      expect(screen.getByRole("table")).toBeVisible();
      expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull();
      const healthy = screen.getByRole("table").querySelector('[data-status="healthy"]');
      expect(healthy?.className).toContain("text-muted-foreground");
      fireEvent.click(screen.getAllByRole("button", { name: details })[0]!);
      expect(screen.getByText("Exact duplicate of /example/northstar/AGENTS.md")).toBeVisible();
    },
  );

  it("reveals the actual source path instead of its display abbreviation", async () => {
    const onRevealPath = vi.fn();
    const onOpenIssue = vi.fn();
    view({ onRevealPath, onOpenIssue }, true);
    expect(await screen.findByText("~/northstar/CLAUDE.md")).toBeVisible();
    expect(screen.getByText("~/northstar/AGENTS.md")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open containing folder" }));
    expect(onRevealPath).toHaveBeenCalledWith("/example/northstar/CLAUDE.md");
    fireEvent.click(screen.getByRole("button", { name: "Inspect context sources" }));
    expect(onOpenIssue).toHaveBeenCalledWith("context");
  });

  it.each([
    ["zh-CN", "先审查将写入的文件，确认后再应用修复", "审查变更"],
    ["zh-TW", "先審查將寫入的檔案，確認後再套用修復", "審查變更"],
    ["en-US", "Review the files that will be written before applying the repair", "Review changes"],
    ["ja-JP", "修復を適用する前に、書き込まれるファイルを確認してください", "変更を確認"],
  ] as const)(
    "explains and opens automatic repair review in %s",
    async (locale, advice, review) => {
      await changeLocale(locale);
      vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
        ...report,
        summary: { ...report.summary, repairable_count: 1 },
        issues: [{ ...report.issues[0]!, repairable: true }],
      });
      const onRepair = vi.fn().mockResolvedValue(undefined);
      view({ onRepair });
      expect(await screen.findByText(advice)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: review }));
      await waitFor(() => expect(onRepair).toHaveBeenCalledOnce());
      expect(screen.queryByRole("button", { name: "Open containing folder" })).toBeNull();
    },
  );

  it("keeps info findings closed and refreshes the diagnosis without enabling repairs", async () => {
    view();
    await screen.findByText("CLAUDE.md and AGENTS.md contain identical instructions");
    const info = screen.getByRole("button", { name: /DeepSeek Harness.*diagnostics only/i });
    expect(info.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("DeepSeek Harness is available for diagnostics only")).toBeNull();
    fireEvent.click(info);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Run diagnostics again" }));
    await waitFor(() => expect(api.workspaceDoctorReport).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /Review changes/ })).toBeNull();
  });

  it("keeps global and sibling paths inspectable without offering an unsupported reveal action", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      issues: [
        {
          ...report.issues[0]!,
          evidence: [
            {
              path: "/example/northstar-other/CLAUDE.md",
              detail: "Exact duplicate of /example/.claude/AGENTS.md",
            },
          ],
        },
      ],
    });
    const onOpenIssue = vi.fn();
    view({ onRevealPath: vi.fn(), onOpenIssue });
    expect(await screen.findByText("/example/northstar-other/CLAUDE.md")).toBeVisible();
    expect(screen.getByText("/example/.claude/AGENTS.md")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open containing folder" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inspect context sources" }));
    expect(onOpenIssue).toHaveBeenCalledWith("context");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Exact duplicate of /example/.claude/AGENTS.md")).toBeVisible();
  });

  it("does not report zero findings as a successful diagnosis when the report failed", async () => {
    vi.mocked(api.workspaceDoctorReport).mockRejectedValue(
      new Error("Temporary diagnostic failure"),
    );
    const onDiagnosed = vi.fn();
    view({ onDiagnosed });
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary diagnostic failure");
    expect(screen.getByText("Not diagnosed")).toBeVisible();
    expect(screen.queryByText("Warnings: 0")).toBeNull();
    expect(screen.queryByText("No deterministic configuration issues found")).toBeNull();
    expect(onDiagnosed).not.toHaveBeenCalled();
  });

  it("invalidates a cached healthy report after refresh failure and resumes only with a new successful report", async () => {
    const healthy: ContextDoctorReport = {
      ...report,
      summary: { ...report.summary, warning_count: 0, info_count: 0 },
      issues: [],
      matrix: [
        { ...report.matrix[0]!, instructions: { status: "healthy", actual: 1, expected: 1 } },
      ],
    };
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(healthy);
    const onDiagnosed = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = (record: typeof onDiagnosed) => (
      <QueryClientProvider client={client}>
        <WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={record} />
      </QueryClientProvider>
    );
    const { rerender } = render(page(onDiagnosed));
    expect(await screen.findByText("No deterministic configuration issues found")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Checks by Agent/ }));
    expect(screen.getByRole("table")).toBeVisible();
    expect(onDiagnosed).toHaveBeenCalledOnce();

    vi.mocked(api.workspaceDoctorReport).mockRejectedValue(new Error("Refresh diagnosis failed"));
    fireEvent.click(screen.getByRole("button", { name: "Run diagnostics again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh diagnosis failed");
    expect(client.getQueryData(homeKeys.doctorReport(workspace.id))).toEqual(healthy);
    expect(screen.getByText("Not diagnosed")).toBeVisible();
    expect(screen.queryByText("Warnings: 0")).toBeNull();
    expect(screen.queryByText("Errors: 0")).toBeNull();
    expect(screen.queryByText("0 automatically repairable")).toBeNull();
    expect(screen.queryByText("No deterministic configuration issues found")).toBeNull();
    expect(screen.queryByRole("button", { name: /Checks by Agent/ })).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Run diagnostics again" })).toBeEnabled();

    const onRecoveredDiagnosis = vi.fn();
    rerender(page(onRecoveredDiagnosis));
    expect(onRecoveredDiagnosis).not.toHaveBeenCalled();
    expect(onDiagnosed).toHaveBeenCalledOnce();

    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    fireEvent.click(screen.getByRole("button", { name: "Run diagnostics again" }));
    expect(
      await screen.findByText("CLAUDE.md and AGENTS.md contain identical instructions"),
    ).toBeVisible();
    expect(screen.getByText("Warnings: 1")).toBeVisible();
    expect(screen.queryByText("Not diagnosed")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /Checks by Agent/ })).toBeVisible();
    await waitFor(() =>
      expect(onRecoveredDiagnosis).toHaveBeenCalledExactlyOnceWith(report.summary),
    );
    expect(onDiagnosed).toHaveBeenCalledOnce();
  });
});
