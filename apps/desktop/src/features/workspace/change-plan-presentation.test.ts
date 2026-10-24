import { describe, expect, it } from "vitest";
import type { ChangeSet, FileChange } from "@/core/types";
import {
  changeGroup,
  defaultPlanTarget,
  generatedChecksumLines,
  hasDeepSeekImportLimitation,
  planText,
  planFilePath,
  instructionPlanNotes,
  summarizePlanEdit,
} from "./change-plan-presentation";

const change = (target: string, rest: Partial<FileChange> = {}): FileChange => ({
  target,
  before: "before",
  after: "after",
  risk: "medium",
  scope: "project",
  validator: "markdown",
  ...rest,
});
const plan = (changes: FileChange[]): ChangeSet => ({
  id: "plan",
  project_root: "/sandbox/project",
  created_at: "2026-10-23T00:00:00Z",
  changes,
  requires_home_approval: false,
});
const snapshot = (shared: string, extra = {}) =>
  JSON.stringify({ instructions: { shared }, ...extra });

describe("change plan presentation", () => {
  it.each([0, 1, 2])("uses exact English noun agreement for count %s", (count) => {
    const suffix = count === 1 ? "" : "s";
    expect(planText("en-US", "added", count)).toBe(
      `added ${count} shared instruction line${suffix}`,
    );
    expect(planText("en-US", "removed", count)).toBe(
      `removed ${count} shared instruction line${suffix}`,
    );
    expect(planText("en-US", "other", count)).toBe(
      `updated ${count} configuration section${suffix}`,
    );
    expect(planText("en-US", "writes", count)).toBe(
      `${count} file${suffix} will be written when you apply`,
    );
    expect(planText("en-US", "apply", count)).toBe(`Apply ${count} change${suffix}`);
    expect(planText("en-US", "checksums", count)).toBe(
      `Automatically generated checksums: ${count} line${suffix} (collapsed)`,
    );
  });

  it("leaves other locales and templates without counts unchanged", () => {
    expect(planText("zh-CN", "writes", 1)).toBe("应用后会写入 1 个文件");
    expect(planText("zh-TW", "writes", 1)).toBe("套用後會寫入 1 個檔案");
    expect(planText("ja-JP", "writes", 1)).toBe("適用すると 1 個のファイルに書き込みます");
    expect(planText("en-US", "files", 1)).toBe("Files to write");
  });

  it.each([
    ["/sandbox/project", "/sandbox/project/.codex/config.toml", ".codex/config.toml"],
    ["/sandbox/project", "/sandbox/project/.grok/config.toml", ".grok/config.toml"],
    ["/sandbox/project", "/sandbox/home/.codex/config.toml", undefined],
    ["/sandbox/project", "/sandbox/project-other/config.toml", undefined],
    ["C:\\Projects\\Demo", "c:\\projects\\demo\\.codex\\config.toml", ".codex/config.toml"],
  ])("uses a project-relative file path with a real boundary (%s)", (root, target, expected) => {
    expect(planFilePath(root, target)).toBe(expected);
  });

  it("groups by actual file purpose and prefers a changed instruction over internal records", () => {
    const manifest = change("/sandbox/project/.agentkib/manifest.yaml", { risk: "low" });
    const shared = change("/sandbox/project/AGENTS.md");
    const sync = change("/sandbox/project/CLAUDE.md");
    expect(changeGroup(manifest)).toBe("records");
    expect(changeGroup(shared)).toBe("shared");
    expect(changeGroup(sync)).toBe("agents");
    expect(
      changeGroup(change("/sandbox/project/.codex/skills/review/SKILL.md", { risk: "low" })),
    ).toBe("agents");
    expect(changeGroup(change("/sandbox/project/.agentkib-notes.md"))).toBe("agents");
    expect(defaultPlanTarget(plan([manifest, shared, sync]))).toBe(shared.target);
    expect(
      defaultPlanTarget(
        plan([manifest, change(shared.target, { before: "same", after: "same" }), sync]),
      ),
    ).toBe(sync.target);
    expect(defaultPlanTarget(plan([manifest]))).toBe(manifest.target);
  });

  it("counts actual shared edits without counting a trailing newline or unrelated configuration as edited instructions", () => {
    expect(
      summarizePlanEdit(snapshot("Keep tests\nUpdate CHANGELOG\n"), snapshot("Keep tests\n")),
    ).toEqual({
      added: 1,
      removed: 0,
      addedPreview: "Update CHANGELOG",
      otherSections: [],
    });
    expect(summarizePlanEdit(snapshot("new"), snapshot("old"))).toMatchObject({
      added: 1,
      removed: 1,
    });
    expect(
      summarizePlanEdit(snapshot("same", { skills: ["new"] }), snapshot("same", { skills: [] })),
    ).toMatchObject({ added: 0, removed: 0, otherSections: ["skills"] });
    expect(summarizePlanEdit(snapshot("Keep tests\n\n"), snapshot("Keep tests\n"))).toMatchObject({
      added: 1,
      removed: 0,
    });
    expect(summarizePlanEdit(snapshot("new"), snapshot(""))).toMatchObject({
      added: 1,
      removed: 0,
    });
    expect(
      summarizePlanEdit(
        snapshot("same", {
          adapters: { codex: { enabled: true, generated_hashes: { "AGENTS.md": "new" } } },
        }),
        snapshot("same", { adapters: { codex: { enabled: true, generated_hashes: {} } } }),
      ),
    ).toMatchObject({ added: 0, removed: 0, otherSections: [] });
    expect(summarizePlanEdit("invalid", "invalid")).toBeUndefined();
    expect(summarizePlanEdit(undefined, snapshot("same"))).toBeUndefined();
  });

  it("warns only for project CLAUDE files with a standalone shared import", () => {
    const imported = change("/sandbox/project/CLAUDE.md", { after: "# Shared\n@AGENTS.md\n" });
    expect(hasDeepSeekImportLimitation(plan([imported]))).toBe(true);
    expect(
      hasDeepSeekImportLimitation(
        plan([imported, change("/sandbox/project/AGENTS.md", { after: "Keep tests" })]),
      ),
    ).toBe(false);
    expect(
      hasDeepSeekImportLimitation(
        plan([imported, change("/sandbox/project/AGENTS.md", { after: "" })]),
      ),
    ).toBe(true);
    expect(
      hasDeepSeekImportLimitation(
        plan([imported, change("/sandbox/project/AGENTS.md", { after: "A".repeat(65537) })]),
      ),
    ).toBe(true);
    expect(
      hasDeepSeekImportLimitation(
        plan([imported, change("/sandbox/other/AGENTS.md", { after: "Keep tests" })]),
      ),
    ).toBe(true);
    expect(
      hasDeepSeekImportLimitation(
        plan([change(imported.target, { after: "Read @AGENTS.md as an example" })]),
      ),
    ).toBe(false);
    expect(
      hasDeepSeekImportLimitation(
        plan([change(imported.target, { scope: "agent-home", after: "@AGENTS.md" })]),
      ),
    ).toBe(false);
  });

  it("describes first takeover only when the original instructions were actually moved into the reviewed managed block", () => {
    const block = (body: string) =>
      `<!-- agentkib:managed:start -->\n${body}\n<!-- agentkib:managed:end -->\n`;
    const shared = change("/sandbox/project/AGENTS.md", {
      before: "- Keep tests\n",
      after: block("- Keep tests\n- Update CHANGELOG"),
    });
    expect(instructionPlanNotes(plan([shared]))).toEqual({ adopted: true, duplicateTargets: [] });
    expect(
      instructionPlanNotes(plan([{ ...shared, after: "- Keep tests\n\n" + shared.after }])),
    ).toEqual({ adopted: false, duplicateTargets: [shared.target] });
    expect(instructionPlanNotes(plan([{ ...shared, before: block("- Keep tests") }]))).toEqual({
      adopted: false,
      duplicateTargets: [],
    });
    expect(instructionPlanNotes(plan([{ ...shared, before: "- Different rules" }]))).toEqual({
      adopted: false,
      duplicateTargets: [],
    });
  });

  it("preannounces retained partial duplicates without treating common headings or file imports as copied instructions", () => {
    const block = (body: string) =>
      `<!-- agentkib:managed:start -->\n${body}\n<!-- agentkib:managed:end -->\n`;
    const shared = change("/sandbox/project/AGENTS.md", {
      before: "- Keep tests",
      after: block("- Keep tests\n- Update CHANGELOG"),
    });
    const claude = change("/sandbox/project/CLAUDE.md", {
      before: "- Keep tests\n- Claude-only rule",
      after: "- Keep tests\n- Claude-only rule\n" + block("@AGENTS.md"),
    });
    expect(instructionPlanNotes(plan([shared, claude])).duplicateTargets).toEqual([claude.target]);
    expect(
      instructionPlanNotes(
        plan([
          shared,
          { ...claude, after: "# Shared instructions\n@AGENTS.md\n" + block("@AGENTS.md") },
        ]),
      ).duplicateTargets,
    ).toEqual([]);
  });

  it("folds only known generated hash fields in the actual manifest, keeping user instructions and adapter settings visible", () => {
    const text = [
      "instructions:",
      "  shared: |",
      "    generated_hashes:",
      `      AGENTS.md: ${"a".repeat(64)}`,
      "adapters:",
      "  claude-code:",
      "    enabled: true",
      "    generated_hashes:",
      `      CLAUDE.md: ${"b".repeat(64)}`,
      "  codex:",
      "    enabled: false",
      "    generated_hashes: {}",
      "skills: []",
    ].join("\n");
    expect([...generatedChecksumLines(text, "/sandbox/project/.agentkib/manifest.yaml")]).toEqual([
      7, 8, 11,
    ]);
    expect([...generatedChecksumLines(text, "/sandbox/project/CLAUDE.md")]).toEqual([]);
    expect([
      ...generatedChecksumLines(
        text.replace("b".repeat(64), "user content"),
        "/sandbox/project/.agentkib/manifest.yaml",
      ),
    ]).toEqual([11]);
    expect([
      ...generatedChecksumLines(
        text.replace("claude-code:", "unknown-custom-agent:"),
        "/sandbox/project/.agentkib/manifest.yaml",
      ),
    ]).toEqual([11]);
  });
});
