import { lstatSync, statSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepseekSections } from "../../../packages/backend/src/context-special";
import { CONTEXT_NOTE_PREFIX } from "../../../packages/backend/src/context-files";
import { applyChanges } from "../../../packages/backend/src/change-apply";
import { planWorkspace } from "../../../packages/backend/src/change-plan";
import { defaultManifest } from "../../../packages/backend/src/default-manifest";
import { instructionImportProof } from "../../../packages/backend/src/instruction-adoption";
import { planLiteralImportWarning } from "../src/features/workspace/plan-import-context";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statSync: vi.fn(actual.statSync), lstatSync: vi.fn(actual.lstatSync) };
});

const fixtures: ContextFixture[] = [];
function fixture() {
  const value = contextFixture();
  fixtures.push(value);
  return value;
}
afterEach(() => {
  for (const value of fixtures.splice(0)) value.dispose();
});
function read(f: ContextFixture, dirs = [f.project], skipSource?: (file: string) => boolean) {
  const warnings: string[] = [];
  const sections = deepseekSections(f.project, dirs, warnings, f.environment, skipSource);
  return { warnings, sections };
}
const literal =
  "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import";

describe("DeepSeek independently loaded shared imports", () => {
  it("keeps an absent optional global file neutral", () => {
    const f = fixture();
    f.write("AGENTS.md", "Shared guideline.\n");
    f.write("CLAUDE.md", "@AGENTS.md\n");
    expect(read(f).warnings).toEqual([`${CONTEXT_NOTE_PREFIX}${literal}`]);
  });

  it.each(["stat denied", "entry unavailable"])(
    "preserves a global read warning when absence cannot be established: %s",
    (failure) => {
      const f = fixture();
      f.write("AGENTS.md", "Shared guideline.\n");
      f.write("CLAUDE.md", "@AGENTS.md\n");
      vi.mocked(statSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("synthetic read failure"), {
          code: failure === "stat denied" ? "EACCES" : "ENOENT",
        });
      });
      if (failure === "entry unavailable")
        vi.mocked(lstatSync).mockImplementationOnce(() => {
          throw Object.assign(new Error("synthetic entry failure"), { code: "EACCES" });
        });
      expect(read(f).warnings).toContain(`Could not read ${f.inHome(".dsh/AGENTS.md")}`);
    },
  );

  it("does not inspect or expose a filtered dangling global alias", () => {
    const f = fixture();
    f.write("AGENTS.md", "Shared guideline.\n");
    f.write("CLAUDE.md", "@AGENTS.md\n");
    const global = f.inHome(".dsh/AGENTS.md");
    f.link(f.at("future-global.md"), global);
    expect(read(f, [f.project], (source) => source === global).warnings).toEqual([
      `${CONTEXT_NOTE_PREFIX}${literal}`,
    ]);
  });

  it("warns before a reviewed new manifest activates a dangling global alias and exhausts the budget", async () => {
    const f = fixture();
    const original = "Follow these rules.\n".repeat(2000);
    f.write("AGENTS.md", original);
    f.write("CLAUDE.md", original);
    f.link(f.at(".agentkib/manifest.yaml"), f.inHome(".dsh/AGENTS.md"));
    const manifest = defaultManifest(f.project),
      instructionImport = instructionImportProof(f.project, manifest);
    manifest.instructions.shared += "Reviewed addition.\n";
    const plan = planWorkspace(f.project, manifest, {
      instructionImport,
      reconcileImportedInstructions: true,
    });
    const before = read(f);
    expect(before.sections.map((section) => section.source)).toEqual([f.at("AGENTS.md")]);
    expect(before.warnings).toContain(`Could not read ${f.inHome(".dsh/AGENTS.md")}`);
    expect(
      await planLiteralImportWarning(plan, async () => ({
        agent: "deepseek-harness",
        project: f.project,
        cwd: f.project,
        ...before,
        visible_skills: [],
        visible_connections: [],
        approved_memories: [],
      })),
    ).toBe(true);
    applyChanges(plan, f.outside("backups"), {
      approvedHome: [],
      protectedHome: [],
      approvedApplication: [],
      approveHome: false,
    });
    const after = read(f);
    expect(after.sections[0]?.scope).toBe("agent-home");
    const shared = after.sections.find((section) => section.source === f.at("AGENTS.md"));
    const writtenShared = plan.changes.find((change) => change.target === f.at("AGENTS.md"))!;
    expect(Buffer.byteLength(shared!.content)).toBeLessThan(Buffer.byteLength(writtenShared.after));
    expect(after.warnings).toContain(
      `DeepSeek Harness instruction budget of 64 KiB truncated ${f.at("AGENTS.md")}`,
    );
    expect(after.warnings).toContain(literal);
  });

  it("keeps literal syntax as a neutral note when the same directory AGENTS body is fully present", () => {
    const f = fixture();
    f.write("AGENTS.md", "Shared guideline.\n");
    f.write("CLAUDE.md", "@AGENTS.md\n");
    const result = read(f);
    expect(result.sections.map((section) => section.source)).toEqual([
      f.at("AGENTS.md"),
      f.at("CLAUDE.md"),
    ]);
    expect(result.warnings).not.toContain(literal);
    expect(result.warnings).toContain(`${CONTEXT_NOTE_PREFIX}${literal}`);
    expect(result.sections[1]?.content).toBe("@AGENTS.md\n");
  });

  it.each(["missing", "filtered", "empty", "oversize"])(
    "retains a warning for an import without usable independently read shared text: %s",
    (kind) => {
      const f = fixture();
      if (kind !== "missing")
        f.write(
          "AGENTS.md",
          kind === "empty"
            ? ""
            : kind === "oversize"
              ? "x".repeat(1024 * 1024 + 1)
              : "Shared guideline.\n",
        );
      f.write("CLAUDE.md", "@AGENTS.md\n");
      const result = read(
        f,
        [f.project],
        kind === "filtered" ? (file) => file === f.at("AGENTS.md") : undefined,
      );
      expect(result.warnings).toContain(literal);
    },
  );

  it("does not use a different directory AGENTS file to dismiss a missing relative import", () => {
    const f = fixture();
    f.write("AGENTS.md", "Root shared guideline.\n");
    f.write("nested/CLAUDE.md", "@AGENTS.md\n");
    expect(read(f, [f.project, f.at("nested")]).warnings).toContain(literal);
  });

  it("does not dismiss the import warning when AGENTS was truncated by the original byte budget", () => {
    const f = fixture();
    f.write("AGENTS.md", "x".repeat(65537));
    f.write("CLAUDE.md", "@AGENTS.md\n");
    const result = read(f);
    expect(result.sections[0]?.content.length).toBe(65536);
    expect(result.warnings).toContain(literal);
    expect(result.warnings.join("\n")).toContain("truncated");
  });

  it("accounts for a personal section consuming the existing byte budget before project instructions", () => {
    const f = fixture();
    f.write(f.inHome(".dsh/AGENTS.md"), "x".repeat(65530));
    f.write("AGENTS.md", "Shared guideline that no longer fits.\n");
    f.write("CLAUDE.md", "@AGENTS.md\n");
    const result = read(f);
    expect(result.sections[0]?.scope).toBe("agent-home");
    expect(result.sections[1]?.content).toHaveLength(6);
    expect(result.warnings).toContain(literal);
    expect(result.warnings.join("\n")).toContain("truncated");
  });
});
