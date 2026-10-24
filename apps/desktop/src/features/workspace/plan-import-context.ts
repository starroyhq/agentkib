import type { ChangeSet, ContextPreview } from "@/core/types";

const budget = 64 * 1024;
const literalWarning =
  "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import";
const noProjectInstructions = "No project instruction file was found for this Agent";
const encoder = new TextEncoder();

/** Textual identity only: the backend remains responsible for realpath and access checks. */
function pathKey(value: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(value);
  const normalized = windows ? value.replaceAll("\\", "/").toLowerCase() : value;
  return normalized.replace(/\/+$/, "");
}
function parentKey(value: string): string {
  const key = pathKey(value);
  return key.slice(0, key.lastIndexOf("/"));
}
function bytes(content: string): number {
  return encoder.encode(content).byteLength;
}

/**
 * Show a warning only when the proposed literal import cannot be proved harmless.
 * This uses the real preview for discovery and existing byte consumption, then
 * substitutes only reviewed AGENTS bytes in a local budget calculation. It never
 * changes a preview response or grants permission to write or read a source.
 */
export async function planLiteralImportWarning(
  plan: ChangeSet,
  readPreview: () => Promise<ContextPreview>,
): Promise<boolean> {
  const imports = plan.changes
    .filter(
      (change) =>
        change.scope === "project" &&
        /(?:^|[\\/])CLAUDE\.md$/.test(change.target) &&
        /^\s*@AGENTS\.md\s*$/m.test(change.after),
    )
    .map((change) => change.target);
  const changesShared = plan.changes.some(
    (change) => change.scope === "project" && /(?:^|[\\/])AGENTS\.md$/.test(change.target),
  );
  if (!imports.length && !changesShared) return false;
  try {
    const actual = await readPreview();
    const root = pathKey(plan.project_root);
    if (
      actual.agent !== "deepseek-harness" ||
      pathKey(actual.project) !== root ||
      pathKey(actual.cwd) !== root
    )
      return true;
    const native = actual.sections
      .filter((section) => section.scope !== "platform-override")
      .sort((left, right) => left.precedence - right.precedence);
    // Subsequent shared edits usually leave CLAUDE.md byte-for-byte unchanged,
    // so its existing native import is absent from ChangeSet.changes.
    for (const section of native) {
      if (
        section.scope !== "agent-home" &&
        /(?:^|[\\/])CLAUDE\.md$/.test(section.source) &&
        /^\s*@AGENTS\.md\s*$/m.test(section.content) &&
        !plan.changes.some((change) => pathKey(change.target) === pathKey(section.source))
      )
        imports.push(section.source);
    }
    if (!imports.length) return false;
    // Unknown rules, read errors and truncation cannot establish a safe default.
    // Notes are expressly informational in Context. A planned new source alone
    // does not prove actual discovery, filtering or the absence of global aliases.
    if (
      actual.warnings.some(
        (warning) =>
          !warning.startsWith("Note: ") &&
          warning !== literalWarning &&
          warning !== noProjectInstructions,
      )
    )
      return true;
    return imports.some((imported) => {
      // One root preview cannot establish what a nested working directory reads.
      const directory = parentKey(imported);
      if (directory !== root) return true;
      const source = pathKey(`${imported.slice(0, -"CLAUDE.md".length)}AGENTS.md`);
      const matches = (value: string) => pathKey(value) === source;
      const sharedChange = plan.changes.find(
        (change) => change.scope === "project" && matches(change.target),
      );
      const sharedSections = native.filter(
        (section) => section.scope !== "agent-home" && matches(section.source),
      );
      if (sharedSections.length > 1) return true;
      const shared = sharedSections[0];
      if (sharedChange && shared && sharedChange.before !== shared.content) return true;
      // An omitted source can be filtered, blocked or unreadable. Even a new file
      // may activate a previously dangling global alias and consume the budget
      // twice. FileChange.before cannot establish how the Agent discovers it.
      if (!shared) return true;
      const content = sharedChange ? sharedChange.after : shared?.content;
      if (!content?.trim()) return true;
      if (!sharedChange && actual.warnings.includes(literalWarning)) return true;
      const preceding = native.slice(0, native.indexOf(shared));
      // For this root-only preview, project AGENTS is the first native project
      // source. An unexpected earlier project source means discovery is unknown.
      if (preceding.some((section) => section.scope !== "agent-home")) return true;
      const used = preceding.reduce((total, section) => {
        const exact = plan.changes.find(
          (change) => pathKey(change.target) === pathKey(section.source),
        );
        if (exact) return total + bytes(exact.after);
        // The preview does not expose realpaths. Identical complete source text
        // can be a symlink to any rewritten file, so account for the larger result
        // instead of assuming a different displayed path means a different file.
        const possible = plan.changes.filter((change) => change.before === section.content);
        return (
          total + Math.max(bytes(section.content), ...possible.map((change) => bytes(change.after)))
        );
      }, 0);
      return used >= budget || bytes(content) > budget - used;
    });
  } catch {
    return true;
  }
}
