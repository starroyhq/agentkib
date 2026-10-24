import { describe, expect, it } from "vitest";
import type { DoctorIssue } from "@/core/types";
import {
  doctorCopy,
  doctorCheckedTime,
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

  it("uses both source filenames and identifies the affected Agent", () => {
    expect(doctorIssueFiles(duplicate)).toEqual(["/example/CLAUDE.md", "/example/AGENTS.md"]);
    expect(doctorIssueTitle(duplicate, "zh-CN")).toBe("CLAUDE.md 与 AGENTS.md 内容完全相同");
    expect(doctorImpact(duplicate, "zh-CN")).toBe("Grok Build 会读到两份相同的指令");
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
    ["zh-CN", "Grok Build 会读到两份相同的指令", "重新诊断"],
    ["zh-TW", "Grok Build 會讀到兩份相同的指令", "重新診斷"],
    ["en-US", "Grok Build will read the same instructions twice", "Run diagnostics again"],
    ["ja-JP", "Grok Build が同じ指示を 2 回読み込みます", "再診断"],
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

  it("lists every affected Agent for the same instruction files without including unrelated findings", () => {
    expect(
      doctorImpact(duplicate, "zh-CN", [
        duplicate,
        { ...duplicate, agent: "claude-code" },
        {
          ...duplicate,
          agent: "codex",
          evidence: [{ path: "/other/CLAUDE.md", detail: "Exact duplicate of /other/AGENTS.md" }],
        },
      ]),
    ).toBe("Grok Build、Claude Code 会读到两份相同的指令");
  });

  it.each([
    ["zh-CN", "刚刚"],
    ["zh-TW", "剛剛"],
    ["en-US", "just now"],
    ["ja-JP", "たった今"],
  ] as const)(
    "uses a natural recent check time in %s and preserves older relative times",
    (locale, expected) => {
      const now = Date.parse("2026-10-24T06:00:30Z");
      expect(doctorCheckedTime(locale, "2026-10-24T06:00:00Z", "old relative", now)).toBe(expected);
      expect(doctorCheckedTime(locale, "2026-10-24T05:58:00Z", "2 minutes ago", now)).toBe(
        "2 minutes ago",
      );
    },
  );

  it("distinguishes external managed-block duplication from an exact whole-file duplicate", () => {
    const issue = {
      ...duplicate,
      code: "instruction.unmanaged-duplicate",
      evidence: [
        {
          path: "/example/AGENTS.md",
          detail:
            "Instruction content outside the AgentKib-managed block overlaps shared project instructions",
        },
      ],
    };
    expect(doctorIssueTitle(issue, "zh-CN")).toBe("AGENTS.md 的区块外正文与共享指令重复");
    expect(doctorImpact(issue, "zh-CN")).toContain("Grok Build");
  });

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
