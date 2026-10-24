import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyChanges } from "../../../packages/backend/src/change-apply";
import { planWorkspace } from "../../../packages/backend/src/change-plan";
import { defaultManifest } from "../../../packages/backend/src/default-manifest";
import { Doctor } from "../../../packages/backend/src/doctor";
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

describe("workspace instruction plan compatibility", () => {
  it("adopts exactly duplicated project instructions only once", () => {
    const f = fixture();
    const shared = "# Project instructions\nUse pnpm.\n";
    f.write("AGENTS.md", shared);
    f.write("CLAUDE.md", shared);

    const manifest = defaultManifest(f.project);
    expect(manifest.instructions.shared).toBe(shared);
    expect(manifest.instructions.platform_overrides["claude-code"]).toBeUndefined();
  });

  it("does not treat whitespace around the identical body as a platform override", () => {
    const f = fixture();
    f.write("AGENTS.md", "# Project\nUse pnpm.\n");
    f.write("CLAUDE.md", "\n# Project\nUse pnpm.\n\n");
    expect(
      defaultManifest(f.project).instructions.platform_overrides["claude-code"],
    ).toBeUndefined();
  });

  it.each([
    "# Project\nUse pnpm.\nUse the local fixture service.\n",
    "# Claude-specific\nKeep the independent instructions.\n",
  ])("preserves a distinct Claude body as its own override", (claude) => {
    const f = fixture();
    f.write("AGENTS.md", "# Project\nUse pnpm.\n");
    f.write("CLAUDE.md", claude);
    expect(defaultManifest(f.project).instructions.platform_overrides["claude-code"]).toBe(
      claude.trim(),
    );
  });

  it("keeps literal imports as notes when shared instructions are independently loaded, and warns when they are missing", async () => {
    const f = fixture();
    f.write("AGENTS.md", "# Project\nUse pnpm.\n");
    f.write(".grok/config.toml", "");
    const manifest = defaultManifest(f.project);
    manifest.instructions.shared += "Update the fixture changelog before release.\n";

    const plan = planWorkspace(f.project, manifest);
    const claude = plan.changes.find((change) => change.target === f.at("CLAUDE.md"));
    // Literal syntax is retained: the complete independently read AGENTS.md
    // determines whether this is a neutral note or an actual missing-import warning.
    expect(claude?.after.split(/\r?\n/)).toContain("@AGENTS.md");
    const result = applyChanges(plan, f.outside("backups"), {
      approvedHome: [],
      protectedHome: [],
      approvedApplication: [],
      approveHome: false,
    });
    expect(result.applied).toContain(f.at("CLAUDE.md"));

    const report = await new Doctor(f.context, () => f.project).report("fixture");
    const incompatible = report.issues.filter(
      (issue) => issue.agent === "deepseek-harness" && issue.code === "context.warning",
    );
    expect(incompatible).toEqual([]);
    const preview = await f.context.resolve(f.project, f.project, "deepseek-harness", null, []);
    expect(preview.warnings).toContain(
      "Note: DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
    );
    expect(report.issues.filter((issue) => issue.code === "managed.drift")).toEqual([]);

    rmSync(f.at("AGENTS.md"));
    const missing = await new Doctor(f.context, () => f.project).report("fixture");
    expect(missing.issues).toContainEqual(
      expect.objectContaining({
        code: "context.warning",
        agent: "deepseek-harness",
        evidence: [
          expect.objectContaining({
            detail:
              "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
          }),
        ],
      }),
    );

    f.write("CLAUDE.md", "external modification\n");
    const changed = await new Doctor(f.context, () => f.project).report("fixture");
    expect(changed.issues).toContainEqual(
      expect.objectContaining({ code: "managed.drift", agent: "claude-code" }),
    );
  });

  it("continues reporting unmanaged exact duplicates and keeps original backups", async () => {
    const f = fixture();
    const shared = "# Project\nUse pnpm.\n";
    f.write("AGENTS.md", shared);
    f.write("CLAUDE.md", shared);
    f.write(".grok/config.toml", "");
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "instruction.exact-duplicate", agent: "grok-build" }),
    );

    const plan = planWorkspace(f.project, defaultManifest(f.project));
    const result = applyChanges(plan, f.outside("backups"), {
      approvedHome: [],
      protectedHome: [],
      approvedApplication: [],
      approveHome: false,
    });
    const index = plan.changes.findIndex((change) => change.target === f.at("CLAUDE.md"));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(readFileSync(path.join(result.backup_dir, `${index}.bak`), "utf8")).toBe(shared);
  });
});
