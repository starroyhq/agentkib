import { afterEach, describe, expect, it } from "vitest";
import { deepseekSections } from "../../../packages/backend/src/context-special";
import { CONTEXT_NOTE_PREFIX } from "../../../packages/backend/src/context-files";
import { contextFixture, type ContextFixture } from "./fixtures/claude-context";

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
