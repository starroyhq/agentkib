import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertClaudeConfigWritable,
  claudeConfigDirVariable,
  claudeConfigFiles,
  ClaudeConfigError,
  claudeGlobalConfigFile,
  claudeGlobalConfigGate,
  claudeManagedDir,
  isClaudeConfigDirSet,
  resolveClaudeConfig,
  type ClaudeConfigInvalidReason,
} from "../../../packages/backend/src/agents/claude/claude-config";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const posixHome = "/Users/alice";
const windowsHome = "C:\\Users\\alice";
const posix = (value: string | undefined) =>
  resolveClaudeConfig(value === undefined ? {} : { CLAUDE_CONFIG_DIR: value }, posixHome, "linux");
const windows = (value: string | undefined) =>
  resolveClaudeConfig(
    value === undefined ? {} : { CLAUDE_CONFIG_DIR: value },
    windowsHome,
    "win32",
  );

describe("resolveClaudeConfig", () => {
  describe("an unset variable", () => {
    it.each([undefined, "", " ", "   ", "\t", "\n"])(
      "uses <home>/.claude for %j, without a diagnostic",
      (value) => {
        expect(posix(value)).toEqual({ dir: "/Users/alice/.claude", overridden: false });
        expect(windows(value)).toEqual({ dir: "C:\\Users\\alice\\.claude", overridden: false });
      },
    );

    it("is byte-identical to what path.join(home, '.claude') produced before", () => {
      for (const home of ["/Users/alice", "/Users/alice/", "/", "relative/home", ""])
        expect(resolveClaudeConfig({}, home, "linux").dir).toBe(path.posix.join(home, ".claude"));
      for (const home of ["C:\\Users\\alice", "C:\\Users\\alice\\", "C:\\", "\\\\server\\share\\u"])
        expect(resolveClaudeConfig({}, home, "win32").dir).toBe(path.win32.join(home, ".claude"));
    });

    it("defaults to the running platform", () => {
      expect(resolveClaudeConfig({}, os.homedir()).dir).toBe(path.join(os.homedir(), ".claude"));
    });
  });

  describe("a usable POSIX value", () => {
    it.each([
      ["/a/b", "/a/b"],
      ["/a/b/", "/a/b"],
      ["/a//b", "/a/b"],
      ["/a/./b", "/a/b"],
      ["/a/b//", "/a/b"],
      ["/srv/claude work", "/srv/claude work"],
      ["/a/b..c", "/a/b..c"],
      ["/a/..b/c", "/a/..b/c"],
      ["//server/share/x", "/server/share/x"],
      ["/Users/alice/.claude", "/Users/alice/.claude"],
      ["/a/b\\c", "/a/b\\c"],
    ])("normalises %j to %j and marks it overridden", (value, dir) => {
      expect(posix(value)).toEqual({ dir, overridden: true });
    });
  });

  describe("a usable Windows value", () => {
    it.each([
      ["C:\\Users\\u\\x", "C:\\Users\\u\\x"],
      ["C:/Users/u/x", "C:\\Users\\u\\x"],
      ["C:\\Users\\u\\x\\", "C:\\Users\\u\\x"],
      ["C:\\Users\\u\\x\\\\", "C:\\Users\\u\\x"],
      ["C:\\a\\.\\b", "C:\\a\\b"],
      ["c:\\users\\u", "c:\\users\\u"],
      ["D:/Data/claude work", "D:\\Data\\claude work"],
      ["C:\\a\\b..c", "C:\\a\\b..c"],
    ])("normalises %j to %j and marks it overridden", (value, dir) => {
      expect(windows(value)).toEqual({ dir, overridden: true });
    });
  });

  describe("an unusable value", () => {
    const refused = (
      platform: "posix" | "windows",
      value: string,
      reason: ClaudeConfigInvalidReason,
    ) => {
      const result = platform === "posix" ? posix(value) : windows(value);
      expect(result).toEqual({
        dir: platform === "posix" ? "/Users/alice/.claude" : "C:\\Users\\alice\\.claude",
        overridden: true,
        invalid: reason,
      });
    };

    it.each([
      ["a relative path", "rel/dir", "not-absolute"],
      ["a dot-relative path", "./x", "not-absolute"],
      ["a home-relative path", "~/.claude-work", "not-absolute"],
      ["a variable reference", "$HOME/x", "not-absolute"],
      ["a braced variable reference", "${HOME}/x", "not-absolute"],
      ["a Windows drive path", "C:\\Users\\u\\x", "not-absolute"],
      ["a Windows path with slashes", "C:/Users/u/x", "not-absolute"],
      ["a backslash-led path", "\\Users\\u", "not-absolute"],
      ["a parent segment", "/a/../b", "traversal"],
      ["a trailing parent segment", "/a/b/..", "traversal"],
      ["a leading parent segment", "/../a", "traversal"],
      ["a parent segment between doubled separators", "/a//../b", "traversal"],
      ["the root", "/", "filesystem-root"],
      ["a doubled root", "//", "filesystem-root"],
      ["a tripled root", "///", "filesystem-root"],
      ["a dotted root", "/.", "filesystem-root"],
      ["a dotted root with a separator", "/./", "filesystem-root"],
      ["a NUL character", "/a\0b", "control-character"],
      ["a newline", "/a\nb", "control-character"],
      ["a trailing newline", "/a/b\n", "control-character"],
      ["a tab", "/a\tb", "control-character"],
      ["an escape character", "/a\u001bb", "control-character"],
      ["a DEL character", "/a\u007fb", "control-character"],
      ["a C1 control character", "/a\u0085b", "control-character"],
      ["leading whitespace", " /a/b", "surrounding-whitespace"],
      ["trailing whitespace", "/a/b ", "surrounding-whitespace"],
      ["a non-breaking space at the end", "/a/b\u00a0", "surrounding-whitespace"],
      ["more than 4096 characters", `/${"a".repeat(4096)}`, "too-long"],
    ] as const)("rejects %s on POSIX", (_name, value, reason) => {
      refused("posix", value, reason);
    });

    it("accepts exactly 4096 characters", () => {
      const value = `/${"a".repeat(4095)}`;
      expect(value).toHaveLength(4096);
      expect(posix(value)).toEqual({ dir: value, overridden: true });
    });

    it.each([
      ["a POSIX path", "/a/b", "drive-relative"],
      ["a doubled-slash path", "//server/share/x", "unsupported-prefix"],
      ["a UNC path", "\\\\server\\share\\x", "unsupported-prefix"],
      ["an extended-length path", "\\\\?\\C:\\x", "unsupported-prefix"],
      ["a device path", "\\\\.\\pipe\\x", "unsupported-prefix"],
      ["a mixed UNC prefix", "\\/server/share", "unsupported-prefix"],
      ["a bare drive", "C:", "drive-relative"],
      ["a drive-relative path", "C:foo", "drive-relative"],
      ["a backslash-led path", "\\foo", "drive-relative"],
      ["a relative path", "rel\\dir", "not-absolute"],
      ["a home-relative path", "~\\x", "not-absolute"],
      ["a digit pseudo-drive", "1:\\x", "not-absolute"],
      ["a parent segment", "C:\\a\\..\\b", "traversal"],
      ["a parent segment with slashes", "C:/a/../b", "traversal"],
      ["a parent segment with mixed separators", "C:\\a/..\\b", "traversal"],
      ["a drive root", "C:\\", "filesystem-root"],
      ["a drive root with a slash", "C:/", "filesystem-root"],
      ["a dotted drive root", "C:\\.", "filesystem-root"],
      ["a doubled drive root", "C:\\\\", "filesystem-root"],
      ["a dotted drive root with a slash", "C:/.", "filesystem-root"],
      ["another drive root", "D:\\", "filesystem-root"],
      ["trailing whitespace", "C:\\a\\b ", "surrounding-whitespace"],
      ["a control character", "C:\\a\u0000b", "control-character"],
    ] as const)("rejects %s on Windows", (_name, value, reason) => {
      refused("windows", value, reason);
    });

    it("rejects a Windows path with a more specific reason than relative-looking input", () => {
      // The prefix rules run before the generic absolute-path test, so UNC is not "not-absolute".
      expect(windows("\\\\server\\share").invalid).toBe("unsupported-prefix");
      expect(windows("/a/b").invalid).toBe("drive-relative");
    });

    it("applies the rules in a fixed order: the first match wins", () => {
      expect(posix(" /a/../b")).toMatchObject({ invalid: "surrounding-whitespace" });
      expect(posix("/a/../b\n")).toMatchObject({ invalid: "control-character" });
      expect(posix(`/${"a".repeat(5000)}/..`)).toMatchObject({ invalid: "too-long" });
      expect(windows("\\\\srv\\sh\\..\\x")).toMatchObject({ invalid: "unsupported-prefix" });
      expect(windows("..\\x")).toMatchObject({ invalid: "not-absolute" });
    });

    it("decides the filesystem root after normalising, not before", () => {
      for (const value of ["//", "/.", "/./", "/./."])
        expect(posix(value).invalid).toBe("filesystem-root");
      for (const value of ["C:\\.", "C:\\.\\.", "C:/./"])
        expect(windows(value).invalid).toBe("filesystem-root");
    });
  });

  describe("invariants of every usable result", () => {
    const usable: Array<[string, string, NodeJS.Platform]> = [
      ["/a/b", "/a/b/", "linux"],
      ["/a/./b//c", "/a//b/", "darwin"],
      ["/x", "//x///", "linux"],
      ["C:\\u\\x", "C:/u/x/", "win32"],
      ["C:\\u", "c:\\u\\\\", "win32"],
      ["D:\\data\\a b", "D:/data/./a b/", "win32"],
    ];
    it.each(usable)("holds for %j", (_expected, value, platform) => {
      const p = platform === "win32" ? path.win32 : path.posix;
      const config = resolveClaudeConfig({ CLAUDE_CONFIG_DIR: value }, "/h", platform);
      expect(config.invalid).toBeUndefined();
      expect(config.overridden).toBe(true);
      expect(p.isAbsolute(config.dir)).toBe(true);
      expect(config.dir).not.toBe(p.parse(config.dir).root);
      expect(config.dir).not.toBe("");
      expect(config.dir.endsWith(p.sep)).toBe(false);
      expect(config.dir.split(/[\\/]+/)).not.toContain("..");
      expect(p.isAbsolute(p.join(config.dir, ".claude.json"))).toBe(true);
    });
  });

  it("does not echo the unusable value anywhere in the result", () => {
    const result = posix("relative/secret-name");
    expect(JSON.stringify(result)).not.toContain("secret-name");
  });
});

describe("claudeConfigDirVariable and isClaudeConfigDirSet", () => {
  it("returns the raw value for Claude's own truthiness test", () => {
    expect(claudeConfigDirVariable({})).toBeUndefined();
    expect(claudeConfigDirVariable({ CLAUDE_CONFIG_DIR: "" })).toBe("");
    expect(claudeConfigDirVariable({ CLAUDE_CONFIG_DIR: "   " })).toBe("   ");
    expect(claudeConfigDirVariable({ CLAUDE_CONFIG_DIR: "/a" })).toBe("/a");
  });

  it("counts only a non-blank value as set", () => {
    expect(isClaudeConfigDirSet({})).toBe(false);
    expect(isClaudeConfigDirSet({ CLAUDE_CONFIG_DIR: "" })).toBe(false);
    expect(isClaudeConfigDirSet({ CLAUDE_CONFIG_DIR: " \t " })).toBe(false);
    expect(isClaudeConfigDirSet({ CLAUDE_CONFIG_DIR: "/a" })).toBe(true);
    expect(isClaudeConfigDirSet({ CLAUDE_CONFIG_DIR: "relative" })).toBe(true);
  });
});

describe("claudeConfigFiles", () => {
  it("joins every name onto the directory in one place", () => {
    expect(claudeConfigFiles(posix("/srv/claude"), "linux")).toEqual({
      projects: "/srv/claude/projects",
      history: "/srv/claude/history.jsonl",
      statsCache: "/srv/claude/stats-cache.json",
      userInstructions: "/srv/claude/CLAUDE.md",
      userRules: "/srv/claude/rules",
      skills: "/srv/claude/skills",
      settings: "/srv/claude/settings.json",
      plugins: "/srv/claude/plugins",
      commands: "/srv/claude/commands",
      agents: "/srv/claude/agents",
      outputStyles: "/srv/claude/output-styles",
      workflows: "/srv/claude/workflows",
    });
    expect(claudeConfigFiles(windows("C:/Data/claude"), "win32")).toEqual({
      projects: "C:\\Data\\claude\\projects",
      history: "C:\\Data\\claude\\history.jsonl",
      statsCache: "C:\\Data\\claude\\stats-cache.json",
      userInstructions: "C:\\Data\\claude\\CLAUDE.md",
      userRules: "C:\\Data\\claude\\rules",
      skills: "C:\\Data\\claude\\skills",
      settings: "C:\\Data\\claude\\settings.json",
      plugins: "C:\\Data\\claude\\plugins",
      commands: "C:\\Data\\claude\\commands",
      agents: "C:\\Data\\claude\\agents",
      outputStyles: "C:\\Data\\claude\\output-styles",
      workflows: "C:\\Data\\claude\\workflows",
    });
  });

  it("falls back to the default directory for an unusable value", () => {
    expect(claudeConfigFiles(posix("rel/dir"), "linux").projects).toBe(
      "/Users/alice/.claude/projects",
    );
  });

  it("matches the literals the modules used before while the variable is unset", () => {
    const files = claudeConfigFiles(posix(undefined), "linux");
    expect(files.projects).toBe(path.posix.join(posixHome, ".claude", "projects"));
    expect(files.statsCache).toBe(path.posix.join(posixHome, ".claude", "stats-cache.json"));
    expect(files.history).toBe(path.posix.join(posixHome, ".claude", "history.jsonl"));
  });
});

describe("claudeGlobalConfigFile", () => {
  it("stays at <home>/.claude.json while the variable is unset", () => {
    expect(claudeGlobalConfigFile(posix(undefined), posixHome, "linux")).toBe(
      "/Users/alice/.claude.json",
    );
    expect(claudeGlobalConfigFile(posix("  "), posixHome, "linux")).toBe(
      "/Users/alice/.claude.json",
    );
    expect(claudeGlobalConfigFile(windows(undefined), windowsHome, "win32")).toBe(
      "C:\\Users\\alice\\.claude.json",
    );
  });

  it("moves inside the directory once the variable is usable", () => {
    expect(claudeGlobalConfigFile(posix("/srv/claude/"), posixHome, "linux")).toBe(
      "/srv/claude/.claude.json",
    );
    expect(claudeGlobalConfigFile(windows("D:/claude"), windowsHome, "win32")).toBe(
      "D:\\claude\\.claude.json",
    );
    // Pointing at the default directory still puts the file inside it, as Claude Code does.
    expect(claudeGlobalConfigFile(posix("/Users/alice/.claude"), posixHome, "linux")).toBe(
      "/Users/alice/.claude/.claude.json",
    );
  });

  it("reads the default file for an unusable value", () => {
    expect(claudeGlobalConfigFile(posix("rel/dir"), posixHome, "linux")).toBe(
      "/Users/alice/.claude.json",
    );
  });
});

describe("claudeGlobalConfigGate", () => {
  function directory() {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-config-gate-"));
    roots.push(root);
    return root;
  }
  const config = (dir: string, variable = true) =>
    resolveClaudeConfig(
      variable ? { CLAUDE_CONFIG_DIR: dir } : {},
      path.dirname(dir),
      process.platform,
    );

  it("is open for an existing directory without a legacy file", () => {
    const dir = directory();
    expect(claudeGlobalConfigGate(config(dir))).toEqual({ usable: true });
  });

  it("is open when the directory does not exist yet", () => {
    const dir = path.join(directory(), "missing");
    expect(claudeGlobalConfigGate(config(dir))).toEqual({ usable: true });
  });

  it("is open when a path component is a file (ENOTDIR)", () => {
    const base = directory();
    writeFileSync(path.join(base, "file"), "");
    expect(claudeGlobalConfigGate(config(path.join(base, "file")))).toEqual({ usable: true });
  });

  it("is closed by a legacy .config.json, whether or not the variable is set", () => {
    const base = directory();
    const dir = path.join(base, ".claude");
    mkdirSync(dir);
    writeFileSync(path.join(dir, ".config.json"), "{}");
    expect(claudeGlobalConfigGate(config(dir, true))).toEqual({
      usable: false,
      why: "legacy-file",
    });
    expect(claudeGlobalConfigGate(config(dir, false))).toEqual({
      usable: false,
      why: "legacy-file",
    });
  });

  it.skipIf(process.platform === "win32")(
    "counts a symbolic link or a directory named .config.json as existing",
    () => {
      const dir = directory();
      symlinkSync("/nonexistent-target", path.join(dir, ".config.json"));
      expect(claudeGlobalConfigGate(config(dir))).toEqual({ usable: false, why: "legacy-file" });
      const other = directory();
      mkdirSync(path.join(other, ".config.json"));
      expect(claudeGlobalConfigGate(config(other))).toEqual({ usable: false, why: "legacy-file" });
    },
  );

  it("is closed for an unusable variable without touching the filesystem", () => {
    const calls: string[] = [];
    expect(
      claudeGlobalConfigGate(posix("rel/dir"), (file) => {
        calls.push(file);
      }),
    ).toEqual({ usable: false, why: "invalid" });
    expect(calls).toEqual([]);
  });

  it.each(["EACCES", "EPERM", "EIO", "ELOOP", undefined])(
    "fails closed on any answer other than 'not there' (%s)",
    (code) => {
      const failure = Object.assign(new Error("lstat failed"), code ? { code } : {});
      const gate = claudeGlobalConfigGate(posix("/srv/claude"), () => {
        throw failure;
      });
      expect(gate).toEqual({ usable: false, why: "legacy-file" });
    },
  );

  it.each(["ENOENT", "ENOTDIR"])("treats %s as not there", (code) => {
    const gate = claudeGlobalConfigGate(posix("/srv/claude"), () => {
      throw Object.assign(new Error("lstat failed"), { code });
    });
    expect(gate).toEqual({ usable: true });
  });

  it("looks at <dir>/.config.json and nothing else", () => {
    const calls: string[] = [];
    claudeGlobalConfigGate(posix("/srv/claude"), (file) => {
      calls.push(file);
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(calls).toEqual([path.join("/srv/claude", ".config.json")]);
  });
});

describe("assertClaudeConfigWritable", () => {
  it("passes for an unset or usable variable", () => {
    expect(() => assertClaudeConfigWritable(posix(undefined))).not.toThrow();
    expect(() => assertClaudeConfigWritable(posix("/srv/claude"))).not.toThrow();
  });

  it.each([
    ["rel/dir", "not-absolute"],
    ["/a/../b", "traversal"],
    ["/", "filesystem-root"],
    [" /a", "surrounding-whitespace"],
  ] as const)("refuses %j with the reason %s", (value, reason) => {
    let failure: unknown;
    try {
      assertClaudeConfigWritable(posix(value));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ClaudeConfigError);
    expect((failure as ClaudeConfigError).reason).toBe(reason);
    expect((failure as ClaudeConfigError).name).toBe("ClaudeConfigError");
    expect((failure as Error).message).toContain(`(${reason})`);
    expect((failure as Error).message).toContain("unset it");
    // The value is never echoed: it may be a secret-bearing path or a log-injection attempt.
    expect((failure as Error).message).not.toContain(value.trim());
  });
});

describe("claudeManagedDir", () => {
  it("names the organization policy directory per platform", () => {
    expect(claudeManagedDir("darwin")).toBe("/Library/Application Support/ClaudeCode");
    expect(claudeManagedDir("linux")).toBe("/etc/claude-code");
    expect(claudeManagedDir("win32")).toBe("C:\\Program Files\\ClaudeCode");
  });

  it("has no answer for other platforms", () => {
    for (const platform of ["freebsd", "openbsd", "sunos", "aix", "android"] as const)
      expect(claudeManagedDir(platform)).toBeNull();
  });

  it("defaults to the running platform", () => {
    expect(claudeManagedDir()).toBe(claudeManagedDir(process.platform));
  });
});
