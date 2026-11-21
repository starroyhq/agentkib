import { describe, expect, it } from "vitest";
import { claudeProjectKey } from "../../../packages/backend/src/agents/claude/claude-project-path";

/** The key, or the refusal reason when the directory Claude Code would use cannot be known. */
function resolve(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = claudeProjectKey(cwd, env);
  return result.ok ? result.key : result.reason;
}

describe("claudeProjectKey", () => {
  it.each([
    ["a plain POSIX path", "/Users/alice/work/app", "-Users-alice-work-app"],
    ["dots", "/Users/alice/my.project/v1.2", "-Users-alice-my-project-v1-2"],
    ["underscores", "/home/alice/my_project", "-home-alice-my-project"],
    ["spaces", "/Users/alice/My Project", "-Users-alice-My-Project"],
    ["hyphens already in the path", "/Users/alice/my-project", "-Users-alice-my-project"],
    ["accented letters", "/Users/alice/café", "-Users-alice-caf-"],
    ["one dash per CJK character", "/Users/alice/项目/测试", "-Users-alice------"],
    ["two dashes for a character outside the BMP", "/tmp/a😀b", "-tmp-a--b"],
    ["a Windows drive path", "C:\\Users\\alice\\app", "C--Users-alice-app"],
    ["a Windows drive path with forward slashes", "C:/Users/alice/app", "C--Users-alice-app"],
    ["a UNC path", "\\\\server\\share\\app", "--server-share-app"],
    ["a result that starts with a dash", "/tmp", "-tmp"],
    ["a path that already starts with a dash", "-odd/dir", "-odd-dir"],
    [
      "repeated and trailing separators, which are not collapsed or trimmed",
      "/tmp//x/",
      "-tmp--x-",
    ],
    ["the filesystem root", "/", "-"],
  ])("encodes %s", (_name, cwd, key) => {
    expect(resolve(cwd)).toBe(key);
  });

  it("only ever produces a single safe path segment", () => {
    for (const cwd of ["/..", "/a/../b", "/a\0b", "/a\nb", "C:\\..\\x", "..", "~/x", "/a b/😀/项"])
      expect(resolve(cwd)).toMatch(/^[A-Za-z0-9-]+$/);
  });

  it("keeps a key of exactly 200 characters and refuses anything longer", () => {
    expect(resolve(`/${"a".repeat(199)}`)).toBe(`-${"a".repeat(199)}`);
    expect(resolve(`/${"a".repeat(200)}`)).toBe("path-too-long");
    expect(resolve(`/${"项".repeat(199)}`)).toBe(`-${"-".repeat(199)}`);
    expect(resolve(`/${"项".repeat(200)}`)).toBe("path-too-long");
  });

  it("counts UTF-16 code units toward the limit, like the encoding does", () => {
    expect(resolve("😀".repeat(100))).toBe("-".repeat(200));
    expect(resolve("😀".repeat(101))).toBe("path-too-long");
  });

  it("refuses an empty path", () => {
    expect(resolve("")).toBe("empty-path");
  });

  describe("directory name override", () => {
    const override = { CLAUDE_CONFIG_DIR: "/config", CLAUDE_CODE_PROJECT_DIR_NAME: "shared" };

    it("refuses to guess when the CLI is told which directory to use", () => {
      expect(resolve("/Users/alice/app", override)).toBe("directory-name-overridden");
    });

    it("ignores the name when CLAUDE_CONFIG_DIR is not set, as Claude Code does", () => {
      expect(resolve("/Users/alice/app", { CLAUDE_CODE_PROJECT_DIR_NAME: "shared" })).toBe(
        "-Users-alice-app",
      );
      expect(resolve("/Users/alice/app", { ...override, CLAUDE_CONFIG_DIR: "" })).toBe(
        "-Users-alice-app",
      );
    });

    it("treats any set CLAUDE_CONFIG_DIR as set, even a blank or unusable one", () => {
      // Claude Code validates the override itself, so AgentKib cannot know which directory it uses.
      for (const value of ["   ", "relative/dir", "~/.claude-work", "/a/../b", "/"])
        expect(resolve("/Users/alice/app", { ...override, CLAUDE_CONFIG_DIR: value })).toBe(
          "directory-name-overridden",
        );
    });

    it("derives the key when only the config directory or an empty name is set", () => {
      expect(resolve("/Users/alice/app", { CLAUDE_CONFIG_DIR: "/config" })).toBe(
        "-Users-alice-app",
      );
      expect(resolve("/Users/alice/app", { ...override, CLAUDE_CODE_PROJECT_DIR_NAME: "" })).toBe(
        "-Users-alice-app",
      );
    });
  });
});
