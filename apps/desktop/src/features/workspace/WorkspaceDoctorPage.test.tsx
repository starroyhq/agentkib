// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderUi,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { ContextDoctorReport, WorkspaceSummary } from "@/core/types";
import { WorkspaceDoctorPage } from "./WorkspaceDoctorPage";
import { useWorkspaceStore } from "./workspace-store";

vi.mock("@/core/api", () => ({ api: { workspaceDoctorReport: vi.fn() } }));

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderUi(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

const workspace = { id: "workspace-1", name: "Workspace", path: "/workspace" } as WorkspaceSummary;
const report: ContextDoctorReport = {
  summary: {
    workspace_id: workspace.id,
    error_count: 0,
    warning_count: 0,
    info_count: 0,
    repairable_count: 0,
    checked_at: "2026-08-27T00:00:00Z",
  },
  matrix: [],
  issues: [],
};

describe("WorkspaceDoctorPage", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(async () => {
    await changeLocale("en-US");
    vi.mocked(api.workspaceDoctorReport).mockReset();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  });
  afterEach(cleanup);

  it("records a successful diagnosis", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    const onDiagnosed = vi.fn().mockResolvedValue(undefined);

    render(
      <WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={onDiagnosed} />,
    );

    await waitFor(() => expect(onDiagnosed).toHaveBeenCalledWith(report.summary));
    expect(await screen.findByText("No deterministic configuration issues found")).toBeTruthy();
  });

  it("renders duplicate evidence with both source file names unchanged", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, warning_count: 1 },
      issues: [
        {
          id: "duplicate",
          code: "instruction.exact-duplicate",
          severity: "warning",
          repairable: false,
          evidence: [
            {
              path: "/workspace/CLAUDE.md",
              detail: "Exact duplicate of /workspace/AGENTS.md",
            },
          ],
        },
      ],
    });

    render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={vi.fn()} />);

    expect(await screen.findByText("/workspace/CLAUDE.md")).toBeTruthy();
    expect(screen.queryByText("Exact duplicate of /workspace/AGENTS.md")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("Exact duplicate of /workspace/AGENTS.md")).toBeTruthy();
    expect(screen.queryByText(/Claude\.md|Agents\.md/)).toBeNull();
  });

  it("combines applied files and diagnostic verification into one dismissible notice", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    useWorkspaceStore.getState().setAppliedChanges({
      workspaceId: workspace.id,
      project: workspace.path,
      applied: ["AGENTS.md"],
      backupDir: "",
      origin: "doctor",
      changeSet: {
        id: "doctor-applied",
        project_root: workspace.path,
        created_at: "",
        changes: [],
        requires_home_approval: false,
      },
    });
    render(
      <WorkspaceDoctorPage
        workspace={workspace}
        verification="applied"
        onRepair={vi.fn()}
        onDiagnosed={vi.fn()}
      />,
    );
    await screen.findByText(tr("doctor.recheckHealthy"));
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain(
      tr("changes.appliedSummary", { count: 1 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText(tr("doctor.recheckHealthy"))).toBeNull();
  });

  it("shows repair plan failures beside the repair action and allows retry", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, repairable_count: 1 },
    });
    const onRepair = vi
      .fn()
      .mockRejectedValueOnce(new Error("planning unavailable"))
      .mockResolvedValueOnce(undefined);
    render(<WorkspaceDoctorPage workspace={workspace} onRepair={onRepair} onDiagnosed={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Review changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain("planning unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    await waitFor(() => expect(onRepair).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("updates a mounted diagnosis and matrix headings without fetching again", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    const onDiagnosed = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={onDiagnosed} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Checks by Agent/ }));
    const heading = screen.getByText(tr("assets.instructions"));
    expect(screen.getByText(tr("assets.skills"))).toBeTruthy();

    await act(() => changeLocale("zh-CN"));

    expect(screen.getByText(tr("assets.instructions"))).toBe(heading);
    expect(screen.getByText(tr("assets.skills"))).toBeTruthy();
    expect(api.workspaceDoctorReport).toHaveBeenCalledOnce();
    expect(onDiagnosed).toHaveBeenCalledOnce();
  });

  it("renders OpenCode in the diagnostics matrix", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      matrix: [
        {
          agent: "opencode",
          detected: true,
          installed: true,
          enabled: true,
          writable: true,
          instructions: { status: "healthy", expected: 1, actual: 1 },
          skills: { status: "healthy", expected: 1, actual: 1 },
          mcp: { status: "healthy", expected: 1, actual: 1 },
        },
      ],
    });

    render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /Checks by Agent/ }));
    expect(screen.getByText("OpenCode")).toBeTruthy();
  });

  it("keeps unsupported cells neutral and full issue evidence available on demand", async () => {
    const detail = "Synthetic configuration content mismatch";
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, error_count: 1 },
      matrix: [
        {
          agent: "claude-code",
          detected: true,
          installed: true,
          enabled: true,
          writable: true,
          instructions: { status: "not-applicable", expected: 2, actual: 0 },
          skills: { status: "healthy", expected: 1, actual: 1 },
          mcp: { status: "healthy", expected: 1, actual: 1 },
        },
      ],
      issues: [
        {
          id: "synthetic-drift",
          code: "managed.drift",
          severity: "error",
          repairable: false,
          agent: "claude-code",
          asset_kind: "instructions",
          evidence: [
            {
              path: "/example/project/AGENTS.md",
              detail,
              expected: "a".repeat(64),
              actual: "b".repeat(64),
            },
          ],
        },
      ],
    });
    const onRepair = vi.fn();
    render(<WorkspaceDoctorPage workspace={workspace} onRepair={onRepair} onDiagnosed={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: /Checks by Agent/ }));
    expect(screen.queryByText("0 / 2")).toBeNull();
    const cell = screen.getByRole("table").querySelector('[data-status="not-applicable"]')!;
    expect(cell.className).toContain("text-muted-foreground");
    expect(cell.getAttribute("title")).toBe("Not applicable");
    expect(screen.queryByText(detail)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const article = screen.getByText(detail).closest("article")!;
    expect(screen.getByText(detail).className).not.toMatch(/\bopacity-\d+/);
    const hashes = article.querySelector("small")!;
    expect(hashes.textContent).toContain("aaaaaaaaaaaa…");
    expect(hashes.textContent).toContain("bbbbbbbbbbbb…");
    expect(hashes.className).not.toMatch(/\bopacity-\d+/);
    expect(onRepair).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Review changes/ })).toBeNull();
  });

  it("shows the one-time repair verification result", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, error_count: 2, repairable_count: 2 },
    });

    render(
      <WorkspaceDoctorPage
        workspace={workspace}
        onRepair={vi.fn()}
        onDiagnosed={vi.fn()}
        verification="applied"
      />,
    );

    expect(
      await screen.findByText(
        "Repairs were applied and rechecked. Issues remaining: 2 · repairable: 2.",
      ),
    ).toBeTruthy();
  });

  it("does not describe manual issues as healthy", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, warning_count: 1 },
      issues: [
        {
          id: "manual-issue",
          code: "agent.read-only",
          severity: "warning",
          repairable: false,
          evidence: [],
        },
      ],
    });

    render(
      <WorkspaceDoctorPage
        workspace={workspace}
        onRepair={vi.fn()}
        onDiagnosed={vi.fn()}
        verification="applied"
      />,
    );

    expect(await screen.findByText(tr("doctor.manual.readOnly"))).toBeTruthy();
    expect(screen.queryByText(tr("doctor.allClear"))).toBeNull();
    expect(
      screen.getByText("Repairs were applied and rechecked. Issues remaining: 1 · repairable: 0."),
    ).toBeTruthy();
  });

  it("separates automatic review from manual instructions in the issue cards", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, error_count: 1, warning_count: 1, repairable_count: 1 },
      issues: [
        {
          id: "repairable-issue",
          code: "managed.missing",
          severity: "error",
          repairable: true,
          evidence: [],
        },
        {
          id: "manual-issue",
          code: "agent.read-only",
          severity: "warning",
          repairable: false,
          evidence: [],
        },
      ],
    });

    render(<WorkspaceDoctorPage workspace={workspace} onRepair={vi.fn()} onDiagnosed={vi.fn()} />);

    expect(await screen.findByText("1 auto-fixable")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Review changes" })).toHaveLength(1);
    expect(screen.getByText(tr("doctor.manual.readOnly"))).toBeTruthy();
  });

  it("hides repair review when no automatic repairs are available", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue(report);
    const onRepair = vi.fn();
    render(<WorkspaceDoctorPage workspace={workspace} onRepair={onRepair} onDiagnosed={vi.fn()} />);
    await screen.findByText("No deterministic configuration issues found");

    expect(screen.queryByRole("button", { name: /Review changes/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Run diagnostics again" })).toBeTruthy();
    expect(onRepair).not.toHaveBeenCalled();
  });

  it.each([
    ["skill.source-unavailable", "doctor.manual.skillSource", "doctor.openSkills", "skills"],
    ["instruction.missing", "doctor.manual.instruction", "doctor.openContext", "context"],
    [
      "instruction.expected-content-missing",
      "doctor.manual.instruction",
      "doctor.openContext",
      "context",
    ],
    ["instruction.exact-duplicate", "doctor.manual.duplicate", "doctor.openContext", "context"],
    ["context.warning", "doctor.manual.context", "doctor.openContext", "context"],
    ["context.unavailable", "doctor.manual.context", "doctor.openContext", "context"],
  ])(
    "offers the appropriate inspection action for %s",
    async (code, guidance, label, destination) => {
      vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
        ...report,
        summary: { ...report.summary, warning_count: 1 },
        issues: [{ id: code, code, severity: "warning", repairable: false, evidence: [] }],
      });
      const onOpenIssue = vi.fn();
      render(
        <WorkspaceDoctorPage
          workspace={workspace}
          onRepair={vi.fn()}
          onDiagnosed={vi.fn()}
          onOpenIssue={onOpenIssue}
        />,
      );

      expect(await screen.findByText(tr(guidance))).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: tr(label) }));
      expect(onOpenIssue).toHaveBeenCalledExactlyOnceWith(destination);
      expect(screen.queryByRole("button", { name: /Review changes/ })).toBeNull();
    },
  );

  it.each([
    ["manifest.invalid", "doctor.manual.manifest"],
    ["native.invalid", "doctor.manual.native"],
    ["managed.missing", "doctor.manual.managed"],
    ["managed.drift", "doctor.manual.managed"],
    ["mcp.config-unavailable", "doctor.manual.mcpConfig"],
    ["agent.read-only", "doctor.manual.readOnly"],
    ["future.issue", "doctor.manual.other"],
    ["skill.target-missing", "doctor.manual.skillTarget"],
    ["mcp.target-missing", "doctor.manual.mcpTarget"],
  ])(
    "provides external repair instructions for %s without an unrelated navigation",
    async (code, guidance) => {
      vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
        ...report,
        summary: { ...report.summary, warning_count: 1 },
        issues: [{ id: code, code, severity: "warning", repairable: false, evidence: [] }],
      });
      render(
        <WorkspaceDoctorPage
          workspace={workspace}
          onRepair={vi.fn()}
          onDiagnosed={vi.fn()}
          onOpenIssue={vi.fn()}
        />,
      );

      expect(await screen.findByText(tr(guidance))).toBeTruthy();
      for (const label of ["doctor.openContext", "doctor.openSkills", "doctor.openMcp"])
        expect(screen.queryByRole("button", { name: tr(label) })).toBeNull();
      expect(screen.getByRole("button", { name: "Run diagnostics again" })).toBeTruthy();
    },
  );

  it("keeps repairable issues on the review path instead of suggesting manual changes", async () => {
    vi.mocked(api.workspaceDoctorReport).mockResolvedValue({
      ...report,
      summary: { ...report.summary, warning_count: 1, repairable_count: 1 },
      issues: [
        {
          id: "repairable",
          code: "instruction.missing",
          severity: "warning",
          repairable: true,
          evidence: [],
        },
      ],
    });
    const onRepair = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceDoctorPage workspace={workspace} onRepair={onRepair} onDiagnosed={vi.fn()} />);

    const review = await screen.findByRole("button", {
      name: "Review changes",
    });
    expect(screen.queryByText(tr("doctor.manual.instruction"))).toBeNull();
    fireEvent.click(review);
    expect(onRepair).toHaveBeenCalledOnce();
  });
});
