import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applyChanges } from "../../../packages/backend/src/change-apply";
import { planWorkspace } from "../../../packages/backend/src/change-plan";
import {
  MANAGED_END,
  MANAGED_START,
  defaultManifest,
} from "../../../packages/backend/src/default-manifest";
import { Doctor } from "../../../packages/backend/src/doctor";
import { loadManifest } from "../../../packages/backend/src/manifest";
import { instructionImportProof } from "../../../packages/backend/src/instruction-adoption";
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
const original = "# Project\nUse pnpm.\n";
function apply(f: ContextFixture, plan: ReturnType<typeof planWorkspace>) {
  return applyChanges(plan, f.outside("backups"), {
    approvedHome: [],
    protectedHome: [],
    approvedApplication: [],
    approveHome: false,
  });
}
const occurrences = (content: string, text: string) => content.split(text).length - 1;

describe("first workspace instruction takeover", () => {
  it("moves the imported originals into ownership when shared instructions were extended", async () => {
    const f = fixture();
    f.write("AGENTS.md", original);
    f.write("CLAUDE.md", original);
    f.write(".grok/config.toml", "");
    const before = await new Doctor(f.context, () => f.project).report("fixture");
    expect(before.summary.warning_count).toBe(1);
    const manifest = defaultManifest(f.project);
    const instructionImport = instructionImportProof(f.project, manifest);
    manifest.instructions.shared += "Update CHANGELOG before release.\n";
    const plan = planWorkspace(f.project, manifest, {
      instructionImport,
      reconcileImportedInstructions: true,
    });
    const agents = plan.changes.find((change) => change.target === f.at("AGENTS.md"))!;
    const claude = plan.changes.find((change) => change.target === f.at("CLAUDE.md"))!;
    expect(agents.before).toBe(original);
    expect(agents.after).toBe(
      `${MANAGED_START}\n${manifest.instructions.shared.trim()}\n${MANAGED_END}\n`,
    );
    expect(claude.after.startsWith(MANAGED_START)).toBe(true);
    expect(claude.after).not.toContain("Use pnpm.");
    const applied = apply(f, plan);
    const index = plan.changes.indexOf(agents);
    expect(readFileSync(`${applied.backup_dir}/${index}.bak`, "utf8")).toBe(original);
    expect(occurrences(readFileSync(f.at("AGENTS.md"), "utf8"), "Use pnpm.")).toBe(1);
    const after = await new Doctor(f.context, () => f.project).report("fixture");
    expect(after.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
    expect(after.summary.warning_count).toBe(0);
  });

  it.each([
    "Use pnpm.\nKeep the Claude-only guideline.\n",
    "Keep only the independent Claude guideline.\n",
  ])("preserves distinct Claude instructions once outside the managed block: %s", (claude) => {
    const f = fixture();
    f.write("AGENTS.md", original);
    f.write("CLAUDE.md", claude);
    const manifest = defaultManifest(f.project);
    const instructionImport = instructionImportProof(f.project, manifest);
    manifest.instructions.shared += "Update CHANGELOG before release.\n";
    const plan = planWorkspace(f.project, manifest, {
      instructionImport,
      reconcileImportedInstructions: true,
    });
    const change = plan.changes.find((item) => item.target === f.at("CLAUDE.md"))!;
    expect(change.after.startsWith(`${claude.trimEnd()}\n\n${MANAGED_START}`)).toBe(true);
    expect(occurrences(change.after, "guideline.")).toBe(1);
    apply(f, plan);
    const again = planWorkspace(f.project, loadManifest(f.project), {
      reconcileImportedInstructions: true,
    });
    expect(again.changes.find((item) => item.target === f.at("CLAUDE.md"))).toBeUndefined();
  });

  it("reports retained partial overlap after apply instead of claiming it is resolved", async () => {
    const f = fixture();
    f.write("AGENTS.md", original);
    f.write("CLAUDE.md", "Use pnpm.\nKeep the independent Claude guideline.\n");
    const plan = planWorkspace(f.project, defaultManifest(f.project));
    apply(f, plan);
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "instruction.unmanaged-duplicate",
        severity: "warning",
        agent: "claude-code",
        repairable: false,
        evidence: [expect.objectContaining({ path: f.at("CLAUDE.md") })],
      }),
    );
  });

  it("diagnoses an older managed workspace with duplicate content outside the block without rewriting it", async () => {
    const f = fixture();
    f.write("AGENTS.md", original);
    const manifest = defaultManifest(f.project);
    manifest.instructions.shared += "Update CHANGELOG before release.\n";
    apply(f, planWorkspace(f.project, manifest));
    const managed = readFileSync(f.at("AGENTS.md"), "utf8");
    f.write("AGENTS.md", `${original}\n${managed}`);
    const report = await new Doctor(f.context, () => f.project).report("fixture");
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "instruction.unmanaged-duplicate",
        agent: "codex",
        repairable: false,
        evidence: [expect.objectContaining({ path: f.at("AGENTS.md") })],
      }),
    );
    expect(readFileSync(f.at("AGENTS.md"), "utf8")).toBe(`${original}\n${managed}`);
  });
});
