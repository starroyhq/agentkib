import { describe, expect, it } from "vitest";
import { compactPath, fileName, shortPath } from "./path-display";

describe("compact local path display", () => {
  it.each([
    ["/Users/demo/.claude", "/Users/demo", "~/.claude"],
    ["/Users/demo", "/Users/demo/", "~"],
    ["/Users/demo/work/app", "/Users/demo/", "~/work/app"],
    ["/Users/demo-other/work", "/Users/demo", "/Users/demo-other/work"],
    ["/Users/other/work", "/Users/demo", "/Users/other/work"],
    ["/home/demo/work", "/home/demo", "~/work"],
    ["/home/demo/../other/work", "/home/demo", "/home/demo/../other/work"],
    ["/repo/team\\policy/file.md", "/repo", "~/team\\policy/file.md"],
    ["/repo/file.md", undefined, "/repo/file.md"],
    ["/repo/file.md", "repo", "/repo/file.md"],
    [String.raw`C:\Users\Demo\project\file.md`, String.raw`C:\Users\demo`, "~/project/file.md"],
    [
      String.raw`C:\Users\DemoOther\file.md`,
      String.raw`C:\Users\Demo`,
      String.raw`C:\Users\DemoOther\file.md`,
    ],
    [String.raw`\\server\share\demo\file.md`, String.raw`\\server\share\demo`, "~/file.md"],
    ["", "/Users/demo", ""],
  ] as const)("formats %s using only a verified home prefix", (input, home, expected) => {
    expect(compactPath(input, home)).toBe(expected);
  });

  it("elides the middle while keeping both ends and leaving the actual path unchanged", () => {
    const input = "/Users/demo/one/two/three/four/five/six/seven/AGENTS.md";
    expect(compactPath(input, "/Users/demo", 26)).toBe("~/one/two/thr…en/AGENTS.md");
    expect(input).toBe("/Users/demo/one/two/three/four/five/six/seven/AGENTS.md");
  });

  it("does not split a Unicode code point at either truncation edge", () => {
    const result = compactPath("/fixture/" + "📁".repeat(40) + "/file.md", undefined, 24);
    expect(Array.from(result)).toHaveLength(24);
    expect(result).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
    );
  });
});

describe("path display", () => {
  it.each([
    ["long Windows", String.raw`C:\Users\Example\project\AGENTS.md`, "…/Example/project/AGENTS.md"],
    ["short Windows", String.raw`C:\repo\AGENTS.md`, String.raw`C:\repo\AGENTS.md`],
    ["UNC", String.raw`\\server\share\team\AGENTS.md`, "…/share/team/AGENTS.md"],
    ["Unix", "/home/example/project/AGENTS.md", "…/example/project/AGENTS.md"],
    ["short Unix", "/project/AGENTS.md", "/project/AGENTS.md"],
    ["mixed", String.raw`C:/Users\Example/project/AGENTS.md`, "…/Example/project/AGENTS.md"],
    [
      "POSIX literal backslash in filename",
      String.raw`/repo/.cursor/rules/team\policy.mdc`,
      String.raw`…/.cursor/rules/team\policy.mdc`,
    ],
    [
      "POSIX literal backslash in directory",
      String.raw`/repo/team\policy/rules/CLAUDE.md`,
      String.raw`…/team\policy/rules/CLAUDE.md`,
    ],
    [
      "POSIX relative filename with backslash",
      String.raw`rules/team\policy.mdc`,
      String.raw`rules/team\policy.mdc`,
    ],
    ["filename only", "AGENTS.md", "AGENTS.md"],
    ["empty", "", ""],
  ] as const)("shortens %s paths without losing the final segments", (_kind, input, expected) => {
    expect(shortPath(input)).toBe(expected);
  });

  it.each([
    [String.raw`C:\Users\Example\project\AGENTS.md`, "AGENTS.md"],
    [String.raw`\\server\share\project\config.toml`, "config.toml"],
    ["/home/example/project/CLAUDE.md", "CLAUDE.md"],
    [String.raw`/repo/.cursor/rules/team\policy.mdc`, String.raw`team\policy.mdc`],
    [String.raw`/repo/team\policy/rules/CLAUDE.md`, "CLAUDE.md"],
    [String.raw`rules/team\policy.mdc`, String.raw`team\policy.mdc`],
    ["AGENTS.md", "AGENTS.md"],
    ["", ""],
  ] as const)("extracts a filename from %s", (input, expected) => {
    expect(fileName(input)).toBe(expected);
  });
});
