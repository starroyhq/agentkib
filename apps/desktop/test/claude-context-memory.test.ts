import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRepoRoot } from "../../../packages/backend/src/agents/claude/claude-memory";
import { claudeProjectKey } from "../../../packages/backend/src/agents/claude/claude-project-path";
import { defaultIo } from "../../../packages/backend/src/context-claude-sources";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";
import { virtualIo } from "./fixtures/claude-virtual-io";

// Auto memory (https://code.claude.com/docs/en/memory, "Auto memory"): at the start of a session
// Claude Code loads the first 200 lines or 25KB of MEMORY.md from the memory folder of the
// project. The project is the git repository, so every work tree and subdirectory of one
// repository shares it; outside git it is the working directory.
const O7 =
  "Note: MEMORY.md is longer than Claude Code reads at startup (200 lines or 25,000 bytes); only the first part is shown.";
const symlinks = process.platform === "win32" ? it.skip : it;

const fixtures: ContextFixture[] = [];
function fixture(...args: Parameters<typeof contextFixture>) {
  const created = contextFixture(...args);
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const memorySections = (preview: { sections: { scope: string; content: string }[] }) =>
  preview.sections.filter((section) => section.scope === "auto-memory");
const real = { io: defaultIo, platform: process.platform };

describe("auto memory", () => {
  it("is listed after the instruction files, with the file it comes from", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n");
    f.memory("remember this\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.scope)).toEqual(["", "auto-memory"]);
    expect(preview.sections[1]).toMatchObject({
      source: f.memoryFile(),
      content: "remember this\n",
    });
  });

  it("is absent when there is no MEMORY.md", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "project\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.scope)).toEqual([""]);
    expect(preview.warnings).toEqual([]);
  });

  it("belongs to the working directory outside git", async () => {
    const f = fixture();
    f.memory("memory of the root\n", f.project);
    f.write("packages/app/CLAUDE.md", "app\n");
    const nested = await f.resolve(f.at("packages", "app"));
    expect(memorySections(nested)).toEqual([]);
    expect((await f.resolve()).sections.map((section) => section.scope)).toEqual(["auto-memory"]);
  });

  it("belongs to the repository, so a subdirectory shares it", async () => {
    const f = fixture();
    f.mkdir(".git");
    f.memory("memory of the repository\n", f.project);
    f.mkdir("packages/app");
    for (const cwd of [f.project, f.at("packages", "app")])
      expect(memorySections(await f.resolve(cwd)).map((section) => section.content)).toEqual([
        "memory of the repository\n",
      ]);
  });

  describe("in a linked work tree", () => {
    const wt = (f: ContextFixture, options: { relative?: boolean; viaLink?: string } = {}) => {
      const main = f.outside("main");
      const admin = path.join(main, ".git", "worktrees", "wt");
      f.write(path.join(admin, "HEAD"), "ref: refs/heads/x\n");
      f.write(path.join(admin, "commondir"), "../..\n");
      f.write(
        path.join(admin, "gitdir"),
        options.relative ? "../../../../project/.git\n" : `${f.at(".git")}\n`,
      );
      const named = options.viaLink ?? admin;
      f.write(".git", `gitdir: ${options.relative ? path.relative(f.project, admin) : named}\n`);
      return main;
    };

    it("is the main work tree's, as git itself shares one repository", async () => {
      const f = fixture();
      const main = wt(f);
      f.memory("memory of the main work tree\n", main);
      expect(memorySections(await f.resolve()).map((section) => section.content)).toEqual([
        "memory of the main work tree\n",
      ]);
    });

    it("is found when the pointers are relative", async () => {
      const f = fixture();
      const main = wt(f, { relative: true });
      f.memory("relative layout\n", main);
      expect(memorySections(await f.resolve()).map((section) => section.content)).toEqual([
        "relative layout\n",
      ]);
    });

    symlinks("uses the real path of a main work tree that sits behind a link", async () => {
      const f = fixture();
      const main = wt(f);
      symlinkSync(main, f.outside("main-link"));
      f.write(".git", `gitdir: ${path.join(f.outside("main-link"), ".git", "worktrees", "wt")}\n`);
      f.memory("canonical key\n", main);
      expect(memorySections(await f.resolve()).map((section) => section.content)).toEqual([
        "canonical key\n",
      ]);
    });

    it("is the directory with the .git file for a submodule", async () => {
      const f = fixture();
      const modules = f.outside("super", ".git", "modules", "sub");
      f.write(path.join(modules, "HEAD"), "ref: refs/heads/x\n");
      f.write(".git", `gitdir: ${path.relative(f.project, modules)}\n`);
      f.memory("submodule memory\n", f.project);
      expect(resolveRepoRoot(f.project, real)).toEqual({ base: f.project });
      expect(memorySections(await f.resolve()).map((section) => section.content)).toEqual([
        "submodule memory\n",
      ]);
    });
  });

  describe("when a .git file cannot be trusted", () => {
    // The file comes from a checkout, so each way it can be wrong falls back to the working
    // directory, never to a guess.
    const give = (f: ContextFixture, content: string | Buffer) => {
      f.write(".git", content);
      return resolveRepoRoot(f.project, real);
    };

    it.each([
      ["longer than 4 KiB", () => `gitdir: ${"a".repeat(5000)}\n`, "format"],
      ["more than one line", () => "gitdir: /x\ngitdir: /y\n", "format"],
      ["with a NUL byte", () => Buffer.from("gitdir: /x\0/y\n"), "format"],
      ["not a gitdir line", () => "something else\n", "format"],
      ["pointing nowhere", () => "gitdir: /does/not/exist/.git/worktrees/w\n", "missing"],
    ] as const)("%s", (_name, content, why) => {
      const f = fixture();
      expect(give(f, content())).toEqual({ base: f.project, abandoned: why });
    });

    it("a gitdir that names an ordinary directory with no layout", () => {
      const f = fixture();
      f.mkdir("elsewhere/admin");
      f.write("elsewhere/admin/commondir", "somewhere\n");
      expect(give(f, `gitdir: ${f.at("elsewhere", "admin")}\n`)).toEqual({
        base: f.project,
        abandoned: "layout",
      });
    });

    it("a common directory whose last segment is not .git", () => {
      const f = fixture();
      f.write("bare.git/worktrees/w/commondir", "../..\n");
      f.write("bare.git/worktrees/w/gitdir", `${f.at(".git")}\n`);
      expect(give(f, `gitdir: ${f.at("bare.git", "worktrees", "w")}\n`)).toEqual({
        base: f.project,
        abandoned: "layout",
      });
    });

    it("a clone that names another repository's work tree entry", () => {
      // The other repository's entry points back at some other .git file, not at this one.
      const f = fixture();
      const victim = f.outside("victim");
      f.mkdir(path.join(victim, ".git"));
      f.write(path.join(victim, ".git", "worktrees", "w", "commondir"), "../..\n");
      f.write(
        path.join(victim, ".git", "worktrees", "w", "gitdir"),
        `${f.outside("else", ".git")}\n`,
      );
      f.write(f.outside("else", ".git"), "gitdir: x\n");
      expect(give(f, `gitdir: ${path.join(victim, ".git", "worktrees", "w")}\n`)).toEqual({
        base: f.project,
        abandoned: "layout",
      });
    });

    symlinks("a .git that is itself a link", () => {
      const f = fixture();
      f.write("real-git/HEAD", "x\n");
      symlinkSync(f.at("real-git"), f.at(".git"));
      expect(resolveRepoRoot(f.project, real)).toEqual({ base: f.project, abandoned: "symlink" });
    });

    it.each([
      ["a UNC share", "win32", "C:\\ws", "gitdir: \\\\server\\share\\.git\\worktrees\\w\n"],
      ["a device path", "win32", "C:\\ws", "gitdir: \\\\?\\C:\\repo\\.git\\worktrees\\w\n"],
      ["/net", "linux", "/ws", "gitdir: /net/host/repo/.git/worktrees/w\n"],
    ] as const)("is never looked up when it names %s", (_name, platform, root, content) => {
      const sep = platform === "win32" ? "\\" : "/";
      const marker = `${root}${sep}.git`;
      const fs = virtualIo({ [marker]: content }, platform === "win32" ? "win32" : "posix");
      const found = resolveRepoRoot(root, { io: fs.io, platform });
      expect(found).toEqual({ base: root, abandoned: "network" });
      // Only the .git file itself was touched, to read what it says.
      expect(new Set(fs.calls.map((entry) => entry.path))).toEqual(new Set([marker]));
    });

    it("a common directory on a network path is never looked up either", () => {
      const fs = virtualIo({
        "/ws/.git": "gitdir: /repo/.git/worktrees/w\n",
        "/repo/.git/worktrees/w/commondir": "/net/host/repo/.git\n",
        "/repo/.git/worktrees/w/gitdir": "/ws/.git\n",
      });
      expect(resolveRepoRoot("/ws", { io: fs.io, platform: "linux" })).toEqual({
        base: "/ws",
        abandoned: "network",
      });
      expect(fs.below("/net")).toEqual([]);
    });
  });
});

describe("what is read of MEMORY.md", () => {
  const lines = (count: number, make = (index: number) => `line ${index}`) =>
    Array.from({ length: count }, (_, index) => make(index)).join("\n") + "\n";

  it("stops after 200 lines and says so", async () => {
    const f = fixture();
    f.memory(lines(250));
    const preview = await f.resolve();
    const [memory] = memorySections(preview);
    expect(memory!.content).toBe(lines(200));
    expect(preview.warnings).toContain(O7);
  });

  it("keeps all of 200 lines", async () => {
    const f = fixture();
    f.memory(lines(200));
    const preview = await f.resolve();
    expect(memorySections(preview)[0]!.content).toBe(lines(200));
    expect(preview.warnings).not.toContain(O7);
  });

  it("stops after 25,000 bytes, not in the middle of a character", async () => {
    const f = fixture();
    f.memory(`${"あ".repeat(9000)}\n`);
    const preview = await f.resolve();
    // 25,000 bytes hold 8,333 three-byte characters and two bytes of the next one.
    expect(memorySections(preview)[0]!.content).toBe("あ".repeat(8333));
    expect(preview.warnings).toContain(O7);
  });

  it("keeps all of exactly 25,000 bytes", async () => {
    const f = fixture();
    f.memory(`${"a".repeat(24_999)}\n`);
    const preview = await f.resolve();
    expect(memorySections(preview)[0]!.content.length).toBe(25_000);
    expect(preview.warnings).not.toContain(O7);
  });

  it("counts the limits after comments and front matter are removed", async () => {
    const f = fixture();
    const comment = ["<!--", ...Array.from({ length: 300 }, (_, index) => `note ${index}`), "-->"];
    f.memory(`---\ntopic: x\n---\n${comment.join("\n")}\n${lines(150)}`);
    const preview = await f.resolve();
    expect(memorySections(preview)[0]!.content).toBe(lines(150));
    // The file is over 200 lines as written, but Claude Code measures the text it loads.
    expect(preview.warnings).not.toContain(O7);
  });

  it("truncates after removal when the rest is still too long", async () => {
    const f = fixture();
    f.memory(`<!-- one note -->\n${lines(260)}`);
    const preview = await f.resolve();
    expect(memorySections(preview)[0]!.content).toBe(lines(200));
    expect(preview.warnings).toContain(O7);
  });

  it("is redacted like any outside file", async () => {
    const f = fixture();
    f.memory("deploy notes\npassword=hunter2\n");
    const preview = await f.resolve();
    expect(memorySections(preview)[0]!.content).toBe("deploy notes\npassword=[REDACTED]\n");
    expect(JSON.stringify(preview)).not.toContain("hunter2");
  });

  it("does not expand imports in it", async () => {
    const f = fixture();
    f.write("notes.md", "NOTES-BODY\n");
    f.memory("@../../../notes.md\n");
    const preview = await f.resolve();
    expect(memorySections(preview)[0]!.content).toBe("@../../../notes.md\n");
  });
});

describe("when auto memory is not shown", () => {
  const OFF =
    "Note: CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 is set in AgentKib's environment, so auto memory is not shown. Claude Code started in another environment may still load it.";

  it("is switched off by CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, and says so", async () => {
    const f = fixture();
    f.memory("remembered\n");
    f.environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
    const preview = await f.resolve();
    expect(memorySections(preview)).toEqual([]);
    expect(preview.warnings).toContain(OFF);
    expect((await f.mcp()).warnings).toContain(OFF);
  });

  it.each(["0", "true", "", undefined])(
    "stays on for CLAUDE_CODE_DISABLE_AUTO_MEMORY=%s",
    async (value) => {
      const f = fixture();
      f.memory("remembered\n");
      if (value !== undefined) f.environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY = value;
      const preview = await f.resolve();
      expect(memorySections(preview)).toHaveLength(1);
      expect(preview.warnings).not.toContain(OFF);
    },
  );

  it("is not located when the project directory name is overridden", async () => {
    const f = fixture();
    f.environment.CLAUDE_CONFIG_DIR = f.outside("cfg");
    f.environment.CLAUDE_CODE_PROJECT_DIR_NAME = "custom";
    const preview = await f.resolve();
    expect(preview.warnings).toContain(
      "Note: Auto memory was not located (project directory name overridden).",
    );
  });

  it("is not located when the path is too long to name the folder", async () => {
    const f = fixture();
    const deep = Array.from({ length: 6 }, () => "d".repeat(40)).join("/");
    f.write(`${deep}/CLAUDE.md`, "deep\n");
    const preview = await f.resolve(f.at(...deep.split("/")));
    expect(preview.warnings).toContain("Note: Auto memory was not located (path too long).");
    expect(memorySections(preview)).toEqual([]);
  });

  it("is read from the folder CLAUDE_CONFIG_DIR names", async () => {
    const f = fixture();
    f.environment.CLAUDE_CONFIG_DIR = f.outside("cfg");
    const key = claudeProjectKey(f.project, f.environment);
    if (!key.ok) throw new Error("key");
    writeFileSync(
      f.write(f.outside("cfg", "projects", key.key, "memory", "MEMORY.md"), "configured\n"),
      "configured\n",
    );
    f.write(f.outside("cfg", "CLAUDE.md"), "configured user level\n");
    f.memory("default location\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => [section.scope, section.content])).toEqual([
      ["user", "configured user level\n"],
      ["auto-memory", "configured\n"],
    ]);
  });

  it("falls back to the default folder when CLAUDE_CONFIG_DIR cannot be used, and says so", async () => {
    const f = fixture();
    f.environment.CLAUDE_CONFIG_DIR = "relative/path";
    f.user("CLAUDE.md", "default user level\n");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.content)).toEqual(["default user level\n"]);
    expect(preview.warnings).toContain(
      "Note: CLAUDE_CONFIG_DIR is set but is not a usable absolute path, so AgentKib reads Claude Code's default configuration folder. User-level instructions shown here may belong to a different setup than the one Claude Code uses.",
    );
    // The Doctor never looks at the user's folder, so it has nothing to say about it.
    const doctor = await f.resolve(f.project, { includeOutsideSources: false });
    expect(doctor.warnings.some((warning) => warning.includes("CLAUDE_CONFIG_DIR"))).toBe(false);
  });
});

describe("environment variables that turn CLAUDE.md loading off", () => {
  it.each(["CLAUDE_CODE_DISABLE_CLAUDE_MDS", "CLAUDE_CODE_SAFE_MODE", "CLAUDE_CODE_SIMPLE"])(
    "%s=1 changes nothing in the list, but is noted",
    async (name) => {
      const f = fixture();
      f.write("CLAUDE.md", "project\n");
      const before = (await f.resolve()).sections;
      f.environment[name] = "1";
      const preview = await f.resolve();
      expect(preview.sections).toEqual(before);
      expect(preview.warnings).toEqual([
        "Note: An environment variable that turns off CLAUDE.md loading (CLAUDE_CODE_DISABLE_CLAUDE_MDS, CLAUDE_CODE_SAFE_MODE or CLAUDE_CODE_SIMPLE) is set in AgentKib's environment. Claude Code started with it loads fewer instruction files than listed here; AgentKib does not model this.",
      ]);
    },
  );
});
