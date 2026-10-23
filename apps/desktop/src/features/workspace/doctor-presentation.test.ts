import { describe, expect, it } from "vitest";
import type { DoctorIssue } from "@/core/types";
import {
  doctorCopy,
  doctorImpact,
  doctorIssueFiles,
  doctorIssueTitle,
  doctorMatrixCounts,
  doctorWorkspaceRelativePath,
} from "./doctor-presentation";

const duplicate: DoctorIssue = {
  id: "duplicate",
  code: "instruction.exact-duplicate",
  severity: "warning",
  repairable: false,
  agent: "grok-build",
  evidence: [{ path: "/example/CLAUDE.md", detail: "Exact duplicate of /example/AGENTS.md" }],
};

describe("E2 diagnostic presentation", () => {
  it.each([
    ["/example/northstar", "/example/northstar/CLAUDE.md", "CLAUDE.md"],
    [
      "/example/northstar/",
      "/example/northstar/.agentkib/manifest.json",
      ".agentkib/manifest.json",
    ],
    ["/example/northstar", "/example/northstar", ""],
    ["/", "/example/AGENTS.md", "example/AGENTS.md"],
    ["/", "", undefined],
    ["C:\\Projects\\Northstar", "c:\\projects\\northstar\\CLAUDE.md", "CLAUDE.md"],
    [
      "C:\\Projects\\Northstar",
      "C:/Projects/Northstar/.agentkib/manifest.json",
      ".agentkib/manifest.json",
    ],
    ["\\\\server\\share\\Northstar", "\\\\server\\share\\Northstar\\AGENTS.md", "AGENTS.md"],
    ["/example/northstar", "/example/northstar-other/CLAUDE.md", undefined],
    ["/example/northstar", "/example/.claude/settings.json", undefined],
    ["/example/northstar", "/example/northstar/../private/CLAUDE.md", undefined],
    ["/example/northstar", "/example/northstar/./CLAUDE.md", undefined],
    ["/example/northstar", "/example/northstar/CLAUDE.md\0", undefined],
    ["relative/path", "relative/path/CLAUDE.md", undefined],
    ["C:\\Projects\\Northstar", "C:\\Projects\\Northstar-other\\CLAUDE.md", undefined],
    ["C:\\Projects\\Northstar", "D:\\Projects\\Northstar\\CLAUDE.md", undefined],
  ])("limits reveal paths to their workspace (%s, %s)", (workspace, path, expected) => {
    expect(doctorWorkspaceRelativePath(workspace!, path!)).toBe(expected);
  });

  it("uses both source filenames without assigning a shared duplicate to one Agent", () => {
    expect(doctorIssueFiles(duplicate)).toEqual(["/example/CLAUDE.md", "/example/AGENTS.md"]);
    expect(doctorIssueTitle(duplicate, "zh-CN")).toBe("CLAUDE.md 与 AGENTS.md 内容完全相同");
    expect(doctorImpact(duplicate, "zh-CN")).not.toContain("Grok Build");
    expect(duplicate.evidence[0]?.detail).toBe("Exact duplicate of /example/AGENTS.md");
  });

  it.each([
    ["zh-CN", "CLAUDE.md：配置文件无效"],
    ["zh-TW", "CLAUDE.md：配置文件无效"],
    ["en-US", "CLAUDE.md: 配置文件无效"],
    ["ja-JP", "CLAUDE.md：配置文件无效"],
  ] as const)("keeps the actual filename first for other known issues in %s", (locale, title) => {
    expect(
      doctorIssueTitle({ ...duplicate, code: "native.invalid" }, locale, () => "配置文件无效"),
    ).toBe(title);
  });

  it.each([
    ["zh-CN", "同一段指令可能被重复读取", "重新诊断"],
    ["zh-TW", "同一段指令可能被重複讀取", "重新診斷"],
    ["en-US", "The same instructions may be read more than once", "Run diagnostics again"],
    ["ja-JP", "同じ指示が重複して読み込まれる可能性があります", "再診断"],
  ] as const)(
    "localizes known evidence in %s without presenting the raw backend sentence",
    (locale, impact, refresh) => {
      expect(doctorImpact(duplicate, locale)).toBe(impact);
      expect(doctorCopy(locale, "refresh")).toBe(refresh);
      expect(doctorIssueTitle(duplicate, locale)).toContain("CLAUDE.md");
      expect(doctorIssueTitle(duplicate, locale)).toContain("AGENTS.md");
      expect(doctorImpact(duplicate, locale)).not.toContain("Exact duplicate of");
    },
  );

  it("does not infer a path from an unrelated backend error", () => {
    expect(
      doctorIssueFiles({
        ...duplicate,
        code: "native.invalid",
        evidence: [{ detail: "Could not read /private/example" }],
      }),
    ).toEqual([]);
    expect(
      doctorIssueFiles({
        ...duplicate,
        evidence: [{ path: "/example/CLAUDE.md", detail: "Exact duplicate of /example/CLAUDE.md" }],
      }),
    ).toEqual(["/example/CLAUDE.md"]);
  });

  it.each([
    ["zh-CN", "DeepSeek Harness 会把 CLAUDE.md 中的 @AGENTS.md 当作普通文字，不会导入其中的指令"],
    ["zh-TW", "DeepSeek Harness 會把 CLAUDE.md 中的 @AGENTS.md 當作一般文字，不會匯入其中的指令"],
    [
      "en-US",
      "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as text and does not import its instructions",
    ],
    [
      "ja-JP",
      "DeepSeek Harness は CLAUDE.md の @AGENTS.md を文字列として読み取り、参照先の指示を読み込みません",
    ],
  ] as const)("preserves and localizes the real literal-import warning in %s", (locale, impact) => {
    const issue: DoctorIssue = {
      ...duplicate,
      code: "context.warning",
      agent: "deepseek-harness",
      evidence: [
        {
          path: "/example",
          detail:
            "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
        },
      ],
    };
    expect(doctorImpact(issue, locale)).toBe(impact);
    expect(doctorIssueTitle(issue, locale)).toContain("DeepSeek Harness");
    expect(issue.code).toBe("context.warning");
    expect(issue.evidence[0]?.detail).toContain("as literal text");
  });

  it("counts attention cells independently from Agent rows and keeps unsupported cells neutral", () => {
    expect(
      doctorMatrixCounts([
        {
          agent: "deepseek-harness",
          detected: true,
          installed: true,
          enabled: true,
          writable: false,
          instructions: { status: "attention", actual: 1, expected: 2 },
          skills: { status: "not-applicable", actual: 0, expected: 0 },
          mcp: { status: "healthy", actual: 1, expected: 1 },
        },
      ]),
    ).toEqual({ agents: 1, normal: 2, attention: 1 });
  });
});
