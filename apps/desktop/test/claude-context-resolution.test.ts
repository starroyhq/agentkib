import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeSections } from "../../../packages/backend/src/context-claude";
import { CONTEXT_NOTE_PREFIX } from "../../../packages/backend/src/context-files";
import { Doctor } from "../../../packages/backend/src/doctor";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

// Claude Code reads AGENTS.md as a fallback only when no CLAUDE.md-style file exists in the
// working directory or any parent (v2.1.277 and later):
// https://code.claude.com/docs/en/memory
// The note that replaced "Directories above the workspace root were not checked": the preview
// now reads parent directories, and says instead what it still does not read.
const SETTINGS_NOT_READ =
  "Note: Settings given on the command line (--settings, --setting-sources), policy delivered by MDM, a configuration profile or the Windows registry, and server-managed settings are not visible to AgentKib, so this list can differ from what Claude Code loads.";
const VERSION_UNKNOWN =
  "AGENTS.md may not be loaded: the Claude Code version could not be detected, and Claude Code reads AGENTS.md only from v2.1.277.";
const tooOld = (version: string) =>
  `AGENTS.md may not be loaded: Claude Code ${version} is older than v2.1.277, the first version that reads AGENTS.md.`;
const NO_PROJECT = "No project instruction file was found for this Agent";
const posix = process.platform === "win32" ? describe.skip : describe;

const fixtures: ContextFixture[] = [];
function fixture() {
  const created = contextFixture();
  fixtures.push(created);
  return created;
}
afterEach(() => {
  for (const created of fixtures.splice(0)) created.dispose();
});
const summary = (preview: Awaited<ReturnType<ContextFixture["resolve"]>>) =>
  preview.sections.map((section) => [path.basename(section.source), section.scope]);

describe("workspace diagnostic summary requests", () => {
  it("omits failed checks and keeps the results before and after a failed workspace", async () => {
    const f = fixture();
    f.write("CLAUDE.md", "# Project\nUse tabs.\n");
    const doctor = new Doctor(f.context, (id) => {
      if (id === "unavailable") throw new Error("Workspace is unavailable");
      return f.project;
    });
    const summaries = await doctor.request(RUNTIME_METHODS.workspaceDoctorSummaries, {
      workspaceIds: ["first", "unavailable", "last"],
    });
    expect(summaries).toEqual([
      expect.objectContaining({ workspace_id: "first", error_count: 0, warning_count: 0 }),
      expect.objectContaining({ workspace_id: "last", error_count: 0, warning_count: 0 }),
    ]);
    await expect(
      doctor.request(RUNTIME_METHODS.workspaceDoctorReport, { id: "unavailable" }),
    ).rejects.toThrow("Workspace is unavailable");
  });
});

describe("Claude Code instruction sources", () => {
  it("uses AGENTS.md when the project has no CLAUDE.md-style file", async () => {
    const f = fixture();
    f.claude("2.1.296 (Claude Code)");
    f.write("AGENTS.md", "# Shared rules\nUse tabs.\n");
    const preview = await f.resolve();
    expect(preview.sections).toEqual([
      {
        source: f.at("AGENTS.md"),
        scope: "",
        content: "# Shared rules\nUse tabs.\n",
        precedence: 0,
      },
    ]);
    // No "No project instruction file" warning, and the unchecked parent directories are said so.
    expect(preview.warnings).toEqual([SETTINGS_NOT_READ]);
  });

  it.each(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"])(
    "reads only the CLAUDE files when %s exists",
    async (name) => {
      const f = fixture();
      f.write("AGENTS.md", "agents");
      f.write(".claude/AGENTS.md", "agents in .claude");
      f.write(name, "claude");
      const preview = await f.resolve();
      expect(preview.sections.map((section) => section.content)).toEqual(["claude\n"]);
      // The fallback does not apply, so it needs neither a version nor the parent-directory note.
      expect(preview.warnings).toEqual([]);
    },
  );

  it("loads CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md in that order", async () => {
    // Claude Code puts CLAUDE.local.md last in a directory, so it wins over the shared files.
    const f = fixture();
    f.write(".claude/CLAUDE.md", "dot claude");
    f.write("CLAUDE.local.md", "local");
    f.write("CLAUDE.md", "main");
    const preview = await f.resolve();
    expect(summary(preview)).toEqual([
      ["CLAUDE.md", ""],
      ["CLAUDE.md", ".claude"],
      ["CLAUDE.local.md", ""],
    ]);
  });

  it("reads AGENTS.md before .claude/AGENTS.md", async () => {
    const f = fixture();
    f.claude("2.1.296 (Claude Code)");
    f.write(".claude/AGENTS.md", "inner");
    f.write("AGENTS.md", "outer");
    const preview = await f.resolve();
    expect(summary(preview)).toEqual([
      ["AGENTS.md", ""],
      ["AGENTS.md", ".claude"],
    ]);
    expect(preview.warnings).toEqual([SETTINGS_NOT_READ]);
  });

  it("does not read AGENTS.local.md, AGENTS.override.md or anything under .agents", async () => {
    const f = fixture();
    f.write("AGENTS.local.md", "local");
    f.write("AGENTS.override.md", "override");
    f.write(".agents/AGENTS.md", "agents dir");
    f.write(".agents/rules.md", "rules");
    const preview = await f.resolve();
    expect(preview.sections).toEqual([]);
    expect(preview.warnings).toContain(NO_PROJECT);
  });

  it("reports only the missing file when nothing at all was found", async () => {
    const f = fixture();
    const preview = await f.resolve();
    expect(preview.sections).toEqual([]);
    // Parent directories are read now, so there is nothing left to say about them.
    expect(preview.warnings).toEqual([NO_PROJECT]);
  });

  it("applies the fallback from the workspace root down to the working directory", async () => {
    const f = fixture();
    f.claude("2.1.296 (Claude Code)");
    f.write("AGENTS.md", "root");
    f.write("packages/app/AGENTS.md", "app");
    f.write("packages/app/.claude/AGENTS.md", "app dot claude");
    f.write("packages/other/CLAUDE.md", "a sibling that is not on the path");
    const preview = await f.resolve(f.at("packages", "app"));
    expect(summary(preview)).toEqual([
      ["AGENTS.md", ""],
      ["AGENTS.md", "packages/app"],
      ["AGENTS.md", path.join("packages", "app", ".claude")],
    ]);
    expect(preview.warnings).toEqual([SETTINGS_NOT_READ]);
  });

  it("lets a CLAUDE.md between the root and the working directory suppress every AGENTS.md", async () => {
    const f = fixture();
    f.write("AGENTS.md", "root agents");
    f.write("packages/CLAUDE.md", "middle");
    f.write("packages/app/AGENTS.md", "app agents");
    const preview = await f.resolve(f.at("packages", "app"));
    expect(preview.sections.map((section) => section.content)).toEqual(["middle\n"]);
    expect(preview.warnings).toEqual([]);
  });

  it("does not count rules or the user-level CLAUDE.md when deciding on the fallback", async () => {
    const f = fixture();
    f.claude("2.1.296 (Claude Code)");
    f.write("AGENTS.md", "agents");
    f.write(".claude/rules/style.md", "rule");
    f.user("CLAUDE.md", "user level");
    const preview = await f.resolve();
    // The user-level file is listed first (it is the broadest), and the fallback still applies.
    expect(summary(preview)).toEqual([
      ["CLAUDE.md", "user"],
      ["AGENTS.md", ""],
      ["style.md", ".claude/rules"],
    ]);
    expect(preview.sections.map((section) => section.content)).toEqual([
      "user level\n",
      "agents\n",
      "rule\n",
    ]);
    expect(preview.warnings).toEqual([SETTINGS_NOT_READ]);
  });

  it("treats a project with only rules as having instructions", async () => {
    const f = fixture();
    f.write(".claude/rules/style.md", "rule");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.content)).toEqual(["rule\n"]);
    // No AGENTS.md was read, so there is neither a missing file nor a note about the fallback.
    expect(preview.warnings).toEqual([]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "still lets an unreadable CLAUDE.md stop the fallback, because Claude Code reads it",
    async () => {
      const f = fixture();
      f.write("AGENTS.md", "agents");
      chmodSync(f.write("CLAUDE.md", "claude"), 0o000);
      const preview = await f.resolve();
      expect(preview.sections).toEqual([]);
      expect(preview.warnings).toContain(`Could not read ${f.at("CLAUDE.md")}`);
      expect(preview.warnings.some((warning) => warning.includes("AGENTS.md may not"))).toBe(false);
    },
  );

  it("keeps the note prefix the Context page and the Doctor rely on", () => {
    expect(CONTEXT_NOTE_PREFIX).toBe("Note: ");
  });

  it("treats a version lookup that throws as an unknown version instead of failing", async () => {
    const f = fixture();
    f.write("AGENTS.md", "agents");
    const warnings: string[] = [];
    const sections = await claudeSections({
      root: f.project,
      cwd: f.project,
      dirs: [f.project],
      environment: f.environment,
      budget: { remaining: 10_000 },
      warnings,
      externalBodies: true,
      managedDir: null,
      version: async () => {
        throw new Error("lookup failed");
      },
    });
    expect(sections.map((section) => section.content)).toEqual(["agents\n"]);
    expect(warnings).toEqual([VERSION_UNKNOWN, SETTINGS_NOT_READ]);
  });
});

posix("AGENTS.md and the detected Claude Code version", () => {
  it.each([
    ["2.1.277 (Claude Code)", "exactly the first version that reads AGENTS.md"],
    ["2.1.281 (Claude Code)", "a later patch version"],
    ["2.2.0 (Claude Code)", "a later minor version"],
  ])("loads AGENTS.md without a version warning on %s (%s)", async (output) => {
    const f = fixture();
    f.claude(output);
    f.write("AGENTS.md", "agents");
    const preview = await f.resolve();
    expect(preview.sections).toHaveLength(1);
    expect(preview.warnings).toEqual([SETTINGS_NOT_READ]);
  });

  it("shows AGENTS.md but warns that it may not load on a version before 2.1.277", async () => {
    const f = fixture();
    f.claude("2.1.276 (Claude Code)");
    f.write("AGENTS.md", "agents");
    const preview = await f.resolve();
    expect(preview.sections.map((section) => section.content)).toEqual(["agents\n"]);
    expect(preview.warnings).toEqual([tooOld("2.1.276"), SETTINGS_NOT_READ]);
    expect(preview.warnings).not.toContain(NO_PROJECT);
  });

  it("warns that AGENTS.md may not load when no claude executable is found", async () => {
    const f = fixture();
    f.write("AGENTS.md", "agents");
    const preview = await f.resolve();
    expect(preview.sections).toHaveLength(1);
    expect(preview.warnings).toEqual([VERSION_UNKNOWN, SETTINGS_NOT_READ]);
  });

  it.each([
    ["output that is not a Claude Code version", "hello", 0],
    ["a version without the Claude Code suffix", "2.1.296", 0],
    ["a failing command", "2.1.296 (Claude Code)", 3],
  ])("treats %s as an unknown version", async (_name, output, exitCode) => {
    const f = fixture();
    f.claude(output, { exitCode });
    f.write("AGENTS.md", "agents");
    const preview = await f.resolve();
    expect(preview.warnings).toEqual([VERSION_UNKNOWN, SETTINGS_NOT_READ]);
  });

  it("runs claude only when the AGENTS.md fallback is in play", async () => {
    const f = fixture();
    const log = f.outside("claude.log");
    f.claude("2.1.296 (Claude Code)", { log });
    // A CLAUDE.md wins: no version is needed.
    f.write("CLAUDE.md", "claude");
    f.write("AGENTS.md", "agents");
    await f.resolve();
    expect(existsSync(log)).toBe(false);
  });

  it("does not run claude when nothing at all was found", async () => {
    const f = fixture();
    const log = f.outside("claude.log");
    f.claude("2.1.296 (Claude Code)", { log });
    await f.resolve();
    expect(existsSync(log)).toBe(false);
  });

  it("probes the version once for repeated and concurrent requests", async () => {
    const f = fixture();
    const log = f.outside("claude.log");
    f.claude("2.1.296 (Claude Code)", { log });
    f.write("AGENTS.md", "agents");
    await Promise.all([f.resolve(), f.resolve(), f.resolve()]);
    await f.resolve();
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("Claude Code context in the Doctor", () => {
  const manifest = `schema_version: 2
workspace:
  id: fixture
  name: Fixture
instructions:
  shared: |
    Use tabs for indentation.
`;
  function doctor(f: ContextFixture) {
    f.write(".agentkib/manifest.yaml", manifest);
    return new Doctor(f.context, () => f.project);
  }
  const claudeIssues = async (f: ContextFixture) => {
    const report = await doctor(f).report("fixture");
    return report.issues.filter((issue) => issue.agent === "claude-code");
  };
  const codes = (issues: Awaited<ReturnType<typeof claudeIssues>>) =>
    issues.map((issue) => issue.code);

  posix("with the claude executable", () => {
    it("reports nothing for a repository whose only instructions are in AGENTS.md", async () => {
      const f = fixture();
      f.claude("2.1.296 (Claude Code)");
      f.write("AGENTS.md", "Use tabs for indentation.\n");
      const issues = await claudeIssues(f);
      // The shared instructions are satisfied by AGENTS.md, and the note is not an issue.
      expect(issues.filter((issue) => issue.asset_kind === "instruction")).toEqual([]);
    });

    it("reports a context warning, but not a missing file, on a version that may not read AGENTS.md", async () => {
      const f = fixture();
      f.claude("2.1.276 (Claude Code)");
      f.write("AGENTS.md", "Use tabs for indentation.\n");
      const issues = await claudeIssues(f);
      expect(codes(issues)).not.toContain("instruction.missing");
      const warnings = issues.filter((issue) => issue.code === "context.warning");
      expect(warnings.map((issue) => issue.evidence[0]!.detail)).toEqual([tooOld("2.1.276")]);
    });
  });

  it("reports a context warning, but not a missing file, when the version is unknown", async () => {
    const f = fixture();
    f.write("AGENTS.md", "Use tabs for indentation.\n");
    const issues = await claudeIssues(f);
    expect(codes(issues)).not.toContain("instruction.missing");
    const warnings = issues.filter((issue) => issue.code === "context.warning");
    expect(warnings.map((issue) => issue.evidence[0]!.detail)).toEqual([VERSION_UNKNOWN]);
  });

  it("still reports missing project instructions when there is nothing to read, without the note", async () => {
    const f = fixture();
    const issues = await claudeIssues(f);
    expect(codes(issues)).toContain("instruction.missing");
    expect(issues.some((issue) => issue.evidence[0]!.detail.startsWith(CONTEXT_NOTE_PREFIX))).toBe(
      false,
    );
  });
});

describe("agents other than Claude Code", () => {
  it.each([
    ["CLAUDE.md", "AGENTS.md"],
    ["Claude.md", "Agents.md"],
  ])("keeps the on-disk names %s and %s in duplicate evidence", async (claudeName, agentsName) => {
    const f = fixture();
    const claude = f.write(claudeName, "# Shared rules\nUse tabs.\n");
    const agents = f.write(agentsName, "# Shared rules\nUse tabs.\n");
    f.write(".grok/config.toml", "");

    const preview = await f.context.resolve(f.project, f.project, "grok-build", null, []);
    expect(new Set(preview.sections.map((section) => section.source))).toEqual(
      new Set([claude, agents]),
    );

    const report = await new Doctor(f.context, () => f.project).report("fixture");
    const duplicates = report.issues.filter(
      (issue) => issue.agent === "grok-build" && issue.code === "instruction.exact-duplicate",
    );
    expect(duplicates).toHaveLength(1);
    const evidence = duplicates[0]!.evidence[0]!;
    expect(evidence.detail).toMatch(/^Exact duplicate of /);
    expect(new Set([evidence.path, evidence.detail.slice("Exact duplicate of ".length)])).toEqual(
      new Set([claude, agents]),
    );
  });

  // The same fixture, with a standalone import, an inline mention and a missing import.
  const content = "# Shared\n@notes.md\nUse @inline.md here.\n@missing.md\n";
  const expanded = "# Shared\nnote body\n\nUse @inline.md here.\n@missing.md\n";

  it.each(["codex", "cursor", "opencode"] as const)(
    "resolves %s imports exactly as before",
    async (agent) => {
      const f = fixture();
      f.write("AGENTS.md", content);
      f.write("notes.md", "note body\n");
      f.write("inline.md", "must not be imported\n");
      const preview = await f.context.resolve(f.project, f.project, agent, null, []);
      expect(preview.sections.map((section) => section.content)).toEqual([expanded]);
      expect(preview.warnings).toEqual([
        `Imported file is missing: ${f.at("missing.md")} (source: ${f.at("AGENTS.md")})`,
      ]);
    },
  );

  it("does not reinterpret instructions for the other agents with the Claude Code rules", async () => {
    const f = fixture();
    f.write("AGENTS.md", "see @~/notes.md\n@~/notes.md\n");
    f.write(f.inHome("notes.md"), "home notes\n");
    const preview = await f.context.resolve(f.project, f.project, "codex", null, []);
    expect(preview.sections.map((section) => section.content)).toEqual([
      "see @~/notes.md\n@~/notes.md\n",
    ]);
    expect(preview.warnings).toEqual([
      `Imported file is missing: ${f.at("~/notes.md")} (source: ${f.at("AGENTS.md")})`,
    ]);
  });
});

describe("the managed CLAUDE.md written by AgentKib", () => {
  it("expands the standalone @AGENTS.md import the way it always did", async () => {
    const f = fixture();
    f.write("AGENTS.md", "# Rules\nBe kind.\n");
    f.write(
      "CLAUDE.md",
      [
        "<!-- agentkib:managed:start -->",
        "@AGENTS.md",
        "",
        "Claude Code uses AGENTS.md as the shared project instructions.",
        "<!-- agentkib:managed:end -->",
        "",
      ].join("\n"),
    );
    const preview = await f.resolve();
    expect(preview.sections).toHaveLength(1);
    // The block markers are HTML comments on their own lines: Claude Code removes them from
    // CLAUDE.md, so the preview does too. The imported AGENTS.md is expanded as before.
    expect(preview.sections[0]!.content).toBe(
      [
        "# Rules",
        "Be kind.",
        "",
        "",
        "Claude Code uses AGENTS.md as the shared project instructions.",
        "",
      ].join("\n"),
    );
    expect(preview.warnings).toEqual([]);
  });
});
