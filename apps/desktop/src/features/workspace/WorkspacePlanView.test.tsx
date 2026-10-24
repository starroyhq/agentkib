// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, changeLocale } from "@/core/i18n";
import type { ChangeSet } from "@/core/types";
import { WorkspacePlanView, type WorkspacePlanViewProps } from "./WorkspacePlanView";

const changeSet: ChangeSet = {
  id: "review-1",
  project_root: "/sandbox/project",
  created_at: "2026-10-23T00:00:00Z",
  requires_home_approval: false,
  changes: [
    {
      target: "/sandbox/project/.agentkib/manifest.yaml",
      scope: "project",
      before: "",
      after: "schema_version: 2",
      risk: "low",
      validator: "yaml",
    },
    {
      target: "/sandbox/project/AGENTS.md",
      scope: "project",
      before: "Keep tests\n",
      after: "Keep tests\nUpdate CHANGELOG\n",
      risk: "medium",
      validator: "markdown",
    },
    {
      target: "/sandbox/project/CLAUDE.md",
      scope: "project",
      before: "",
      after: "@AGENTS.md\n",
      risk: "medium",
      validator: "markdown",
    },
  ],
};
const props = (rest: Partial<WorkspacePlanViewProps> = {}): WorkspacePlanViewProps => ({
  changeSet,
  origin: "standard",
  status: "ready",
  plannedManifest: JSON.stringify({ instructions: { shared: "Keep tests\nUpdate CHANGELOG\n" } }),
  baselineManifest: JSON.stringify({ instructions: { shared: "Keep tests\n" } }),
  homeIncluded: false,
  homeApproved: false,
  onHomeApprovalChange: vi.fn(),
  disabled: false,
  busy: false,
  onApply: vi.fn(),
  onReject: vi.fn(),
  onIncludeHome: vi.fn(),
  onRegenerate: vi.fn(),
  onResolveConflict: vi.fn(),
  ...rest,
});

beforeAll(() => initializeI18n("en-US"));
beforeEach(async () => {
  await changeLocale("en-US");
});
afterEach(cleanup);

describe("E2 change plan view", () => {
  it.each([0, 1, 2])("renders exact English agreement for a %s-file plan", (count) => {
    const suffix = count === 1 ? "" : "s";
    const before = { instructions: { shared: "" }, skills: [], connections: [] };
    const after = {
      ...before,
      instructions: {
        shared: Array.from(
          { length: count },
          (_, index) => `Keep files, sections and changes exactly ${index + 1}`,
        ).join("\n"),
      },
      skills: count > 0 ? ["new skill"] : [],
      connections: count > 1 ? ["new connection"] : [],
    };
    render(
      <WorkspacePlanView
        {...props({
          changeSet: {
            ...changeSet,
            changes: Array.from({ length: count }, (_, index) => ({
              ...changeSet.changes[1]!,
              target: `/sandbox/project/AGENTS-${index}.md`,
            })),
          },
          status: count === 0 ? "generating" : "ready",
          baselineManifest: JSON.stringify(before),
          plannedManifest: JSON.stringify(after),
        })}
      />,
    );
    const apply = screen.getByRole("button", { name: `Apply ${count} change${suffix}` });
    if (count === 0) {
      expect(apply).toBeDisabled();
      expect(screen.getByText("Generating change plan…")).toBeVisible();
    } else {
      expect(apply).toBeEnabled();
      const summary = screen.getByText((content) => content.startsWith("You changed:"));
      expect(summary).toHaveTextContent(`added ${count} shared instruction line${suffix}`);
      expect(summary).toHaveTextContent(
        `updated ${count} configuration section${suffix}; ${count} file${suffix} will be written when you apply`,
      );
      if (count === 1)
        expect(summary).toHaveTextContent("Keep files, sections and changes exactly 1");
      expect(summary.textContent).not.toContain("; Write");
    }
  });

  it.each([
    ["zh-CN", "本次变更的文件", "你改了：", "应用后会写入", "返回"],
    ["zh-TW", "本次變更的檔案", "你修改了：", "套用後會寫入", "返回"],
    [
      "en-US",
      "Files in this change",
      "You changed:",
      "3 files will be written when you apply",
      "Back",
    ],
    ["ja-JP", "今回変更したファイル", "変更内容：", "適用すると", "戻る"],
  ] as const)(
    "preserves the reviewed edit summary while showing a completed read-only operation in %s",
    async (locale, files, edit, future, back) => {
      await changeLocale(locale);
      const values = props({
        status: "applied",
        appliedNotice: <div>Applied notice</div>,
        homeIncluded: true,
        changeSet: { ...changeSet, requires_home_approval: true },
      });
      render(<WorkspacePlanView {...values} />);
      expect(screen.getByRole("heading", { name: files })).toBeVisible();
      expect(
        screen.getByText(
          (content) => content.startsWith(edit) && content.includes("Update CHANGELOG"),
        ),
      ).toBeVisible();
      expect(screen.queryByText(new RegExp(future))).toBeNull();
      expect(screen.getByRole("button", { name: back })).toBeEnabled();
      const actions = screen.getByTestId("plan-actions");
      expect(actions.querySelectorAll("button")).toHaveLength(1);
      expect(screen.getByRole("checkbox")).toHaveAttribute("aria-disabled", "true");
      fireEvent.click(screen.getByRole("checkbox"));
      expect(values.onHomeApprovalChange).not.toHaveBeenCalled();
      expect(values.onApply).not.toHaveBeenCalled();
      expect(screen.getByText("Applied notice")).toBeVisible();
    },
  );

  it("does not offer an apply, rejection, or a future backup promise after applying", () => {
    const values = props({ status: "applied", appliedNotice: <div>Applied notice</div> });
    render(<WorkspacePlanView {...values} />);
    expect(screen.queryByRole("button", { name: /Apply|Reject/ })).toBeNull();
    expect(
      screen.queryByText("Original files are backed up automatically before applying"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Include global configuration" })).toBeDisabled();
    expect(
      screen.queryByText(/complete independent reading of AGENTS.md could not be confirmed/),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(values.onReject).toHaveBeenCalledTimes(1);
    expect(values.onApply).not.toHaveBeenCalled();
  });

  it("distinguishes a refresh or Home plan from an application while keeping all mutations blocked", () => {
    const values = props({ busy: true, applying: false });
    const { rerender } = render(<WorkspacePlanView {...values} />);
    expect(screen.getByRole("button", { name: "Apply 3 changes" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Applying…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Include global configuration" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    rerender(<WorkspacePlanView {...values} applying />);
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
  });

  it("keeps ready-empty review distinct from an in-progress plan and offers Back without an apply or approval", () => {
    const values = props({
      changeSet: { ...changeSet, changes: [], requires_home_approval: true },
    });
    render(<WorkspacePlanView {...values} />);
    expect(screen.getByRole("heading", { name: "No file changes in this plan" })).toBeVisible();
    expect(
      screen.getByText("There are no file changes to apply. You can go back to continue."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /Apply/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(
      screen.queryByText("Original files are backed up automatically before applying"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(values.onReject).toHaveBeenCalledTimes(1);
    expect(values.onApply).not.toHaveBeenCalled();
  });

  it("blocks empty, externally disabled and busy plans without submitting, and sends a ready plan exactly once", () => {
    const values = props();
    const { rerender } = render(<WorkspacePlanView {...values} />);
    fireEvent.click(screen.getByRole("button", { name: "Apply 3 changes" }));
    expect(values.onApply).toHaveBeenCalledTimes(1);
    rerender(<WorkspacePlanView {...values} disabled />);
    expect(screen.getByRole("button", { name: "Apply 3 changes" })).toBeDisabled();
    rerender(<WorkspacePlanView {...values} busy />);
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    rerender(
      <WorkspacePlanView
        {...values}
        status="generating"
        changeSet={{ ...changeSet, id: "generating", changes: [] }}
      />,
    );
    expect(screen.getByText("Generating change plan…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply 0 changes" })).toBeDisabled();
    expect(screen.queryByText("No file changes in this plan")).toBeNull();
    expect(screen.queryByText(/will write 0 files/i)).toBeNull();
    expect(values.onApply).toHaveBeenCalledTimes(1);
  });

  it("chooses the first changed file again for a new plan and displays errors", () => {
    const { rerender } = render(<WorkspacePlanView {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /manifest.yaml.*Low/ }));
    expect(screen.getByRole("region", { name: ".agentkib/manifest.yaml" })).toBeVisible();
    rerender(
      <WorkspacePlanView
        {...props({
          changeSet: { ...changeSet, id: "regenerated" },
          error: "Unable to validate file fingerprint",
        })}
      />,
    );
    expect(screen.getByRole("region", { name: "AGENTS.md" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to validate file fingerprint");
  });

  it.each([
    [
      "zh-CN",
      "将写入的文件",
      "共享项目指令",
      "应用 3 个变更",
      "DeepSeek Harness 不解析 CLAUDE.md 中的 @AGENTS.md 引用，尚未确认它会独立读完 AGENTS.md，应用后可能仍有警告",
    ],
    [
      "zh-TW",
      "將寫入的檔案",
      "共用專案指令",
      "套用 3 項變更",
      "DeepSeek Harness 不解析 CLAUDE.md 中的 @AGENTS.md 引用，尚未確認它會獨立讀完整份 AGENTS.md，套用後可能仍有警告",
    ],
    [
      "en-US",
      "Files to write",
      "Shared project instructions",
      "Apply 3 changes",
      "DeepSeek Harness does not resolve @AGENTS.md imports in CLAUDE.md; complete independent reading of AGENTS.md could not be confirmed, so a warning may remain after applying",
    ],
    [
      "ja-JP",
      "書き込み対象のファイル",
      "共通のプロジェクト指示",
      "3 件の変更を適用",
      "DeepSeek Harness は CLAUDE.md 内の @AGENTS.md 参照を展開しません。AGENTS.md を単独で最後まで読めることを確認できないため、適用後も警告が残る可能性があります",
    ],
  ] as const)(
    "renders the plan and compatibility limit in %s",
    async (locale, files, shared, apply, compatibility) => {
      await changeLocale(locale);
      render(<WorkspacePlanView {...props()} />);
      expect(screen.getByRole("heading", { name: files })).toBeVisible();
      expect(screen.getByRole("heading", { name: shared })).toBeVisible();
      expect(screen.getByRole("button", { name: apply })).toBeEnabled();
      expect(screen.queryByText(compatibility)).toBeNull();
      const diff = screen.getByRole("region", { name: "AGENTS.md" });
      expect(diff.textContent).toContain("Update CHANGELOG");
      expect(diff.textContent).not.toContain("schema_version");
      expect(screen.getByTestId("plan-actions").className).toContain("shrink-0");
      expect(screen.getByTestId("plan-files").className).toContain("overflow-y-auto");
    },
  );

  it("keeps same-named project files distinguishable by their workspace-relative paths", () => {
    render(
      <WorkspacePlanView
        {...props({
          changeSet: {
            ...changeSet,
            changes: [
              { ...changeSet.changes[1]!, target: "/sandbox/project/.codex/config.toml" },
              { ...changeSet.changes[1]!, target: "/sandbox/project/.grok/config.toml" },
              { ...changeSet.changes[1]!, target: "/sandbox/project/.cursor/mcp.json" },
            ],
          },
        })}
      />,
    );
    const codex = screen.getByRole("button", { name: /^\.codex\/config\.toml.*Medium$/ });
    const grok = screen.getByRole("button", { name: /^\.grok\/config\.toml.*Medium$/ });
    expect(codex).toHaveAttribute("title", "/sandbox/project/.codex/config.toml");
    expect(grok).toHaveAttribute("title", "/sandbox/project/.grok/config.toml");
    expect(codex.textContent).not.toContain("/sandbox/project/");
    fireEvent.click(grok);
    expect(screen.getByRole("region", { name: ".grok/config.toml" })).toBeVisible();
  });

  it.each([
    ["zh-CN", "你改了：共享项目指令新增 1 行（发布前更新 CHANGELOG）"],
    ["zh-TW", "你修改了：共用專案指令新增 1 行（发布前更新 CHANGELOG）"],
  ] as const)(
    "removes only a Markdown list marker from the preview and uses full-width parentheses in %s",
    async (locale, summary) => {
      await changeLocale(locale);
      render(
        <WorkspacePlanView
          {...props({
            baselineManifest: JSON.stringify({ instructions: { shared: "Keep tests\n" } }),
            plannedManifest: JSON.stringify({
              instructions: { shared: "Keep tests\n- 发布前更新 CHANGELOG\n" },
            }),
          })}
        />,
      );
      expect(screen.getByText((text) => text.startsWith(summary))).toBeVisible();
    },
  );

  it.each([
    ["zh-CN", "原有内容会移进 AgentKib 托管的区块", "这段会和共享指令重复"],
    ["zh-TW", "原有內容會移進 AgentKib 託管的區塊", "這段會和共用指令重複"],
    [
      "en-US",
      "Existing content will move into the AgentKib-managed block",
      "This retained text will duplicate shared instructions",
    ],
    [
      "ja-JP",
      "既存の内容を AgentKib の管理ブロック内へ移動します",
      "保持するこの本文は共通指示と重複します",
    ],
  ] as const)(
    "explains the reviewed migration and retained duplicates in %s",
    async (locale, adopted, duplicate) => {
      await changeLocale(locale);
      const block = (body: string) =>
        `<!-- agentkib:managed:start -->\n${body}\n<!-- agentkib:managed:end -->\n`;
      const shared = {
        ...changeSet.changes[1]!,
        before: "- Keep tests",
        after: block("- Keep tests\n- Update CHANGELOG"),
      };
      const claude = {
        ...changeSet.changes[2]!,
        after: "- Keep tests\n- Claude-only rule\n" + block("@AGENTS.md"),
      };
      render(
        <WorkspacePlanView
          {...props({ changeSet: { ...changeSet, changes: [shared, claude] } })}
        />,
      );
      expect(screen.getByText(adopted)).toBeVisible();
      expect(
        screen.getByText((text) => text.startsWith(duplicate) && text.includes("CLAUDE.md")),
      ).toBeVisible();
    },
  );

  it("preserves a real CLAUDE-only compatibility warning and honors a verified context result", () => {
    const values = props({ changeSet: { ...changeSet, changes: [changeSet.changes[2]!] } });
    const { rerender } = render(<WorkspacePlanView {...values} />);
    expect(screen.getByRole("note")).toHaveTextContent("DeepSeek Harness");
    rerender(<WorkspacePlanView {...values} literalImportWarning={false} />);
    expect(screen.queryByRole("note")).toBeNull();
    rerender(<WorkspacePlanView {...props()} literalImportWarning />);
    expect(screen.getByRole("note")).toHaveTextContent("DeepSeek Harness");
  });

  it("describes a real edit, groups records last, and preserves high risk and home approval", () => {
    const high = {
      ...changeSet.changes[2]!,
      target: "/sandbox/home/.claude.json",
      scope: "agent-home" as const,
      risk: "high" as const,
      after: "{}",
    };
    const values = props({
      changeSet: {
        ...changeSet,
        requires_home_approval: true,
        changes: [...changeSet.changes, high],
      },
      homeIncluded: true,
    });
    render(<WorkspacePlanView {...values} />);
    expect(screen.getByText(/You changed:.*1.*Update CHANGELOG/)).toBeVisible();
    expect(screen.getByText(/Close any running Claude Code session/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply 4 changes" })).toBeDisabled();
    expect(screen.getByText("High")).toHaveAttribute("title", expect.stringContaining("global"));
    fireEvent.click(screen.getByRole("checkbox"));
    expect(values.onHomeApprovalChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: /CLAUDE.md.*Medium/ }));
    expect(screen.getByRole("region", { name: "CLAUDE.md" }).textContent).toContain("@AGENTS.md");
  });

  it.each(["generating", "stale", "conflict", "applied"] as const)(
    "never applies a %s plan",
    (status) => {
      const values = props({ status, appliedNotice: <div>Applied notice</div> });
      render(<WorkspacePlanView {...values} />);
      if (status === "applied") {
        expect(screen.queryByRole("button", { name: "Apply 3 changes" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Back" }));
        expect(values.onReject).toHaveBeenCalledTimes(1);
      } else {
        expect(screen.getByRole("button", { name: "Apply 3 changes" })).toBeDisabled();
        fireEvent.click(screen.getByRole("button", { name: "Apply 3 changes" }));
      }
      expect(values.onApply).not.toHaveBeenCalled();
      if (status === "stale") {
        fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
        expect(values.onRegenerate).toHaveBeenCalledTimes(1);
      } else if (status === "conflict") {
        fireEvent.click(screen.getByRole("button", { name: "Use disk version" }));
        fireEvent.click(screen.getByRole("button", { name: "Keep my draft" }));
        expect(vi.mocked(values.onResolveConflict).mock.calls).toEqual([["disk"], ["draft"]]);
      } else if (status === "applied") expect(screen.getByText("Applied notice")).toBeVisible();
    },
  );

  it("does not attribute diagnostic repairs to an edit and keeps include-home and reject callbacks", () => {
    const values = props({ origin: "doctor" });
    render(<WorkspacePlanView {...values} />);
    expect(screen.queryByText(/You changed/)).toBeNull();
    expect(screen.getByText(/Repair.*3 files/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Include global configuration" }));
    expect(values.onIncludeHome).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(values.onReject).toHaveBeenCalledTimes(1);
  });
});
