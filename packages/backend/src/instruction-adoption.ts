import { lstatSync } from "node:fs";
import path from "node:path";
import { MANAGED_END, MANAGED_START } from "./default-manifest";
import { boundedText, hash, safeTarget } from "./doctor-files";
import { canonicalProject } from "./files";
import { manifestPath, type Manifest } from "./manifest";
import { pathIdentity } from "./paths";

export interface InstructionImportProof {
  shared_hash: string;
  source_hashes: Partial<Record<"AGENTS.md" | "CLAUDE.md", string>>;
}
export function hasNoManifest(project: string): boolean {
  try {
    lstatSync(manifestPath(project));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
/** A transient ownership proof; only hashes leave the prepare step, never source text. */
export function instructionImportProof(
  project: string,
  manifest: Pick<Manifest, "instructions">,
): InstructionImportProof | undefined {
  if (!hasNoManifest(project) || !manifest.instructions.shared.trim()) return;
  const shared_hash = hash(manifest.instructions.shared.trim());
  const source_hashes: InstructionImportProof["source_hashes"] = {};
  for (const name of ["AGENTS.md", "CLAUDE.md"] as const) {
    const file = path.join(project, name);
    if (!safeTarget(project, file)) continue;
    const content = boundedText(file);
    if (content === null || content.includes(MANAGED_START) || content.includes(MANAGED_END))
      continue;
    if (hash(content.trim()) === shared_hash) source_hashes[name] = hash(content);
  }
  return { shared_hash, source_hashes };
}

/** Bound import evidence to a single server-issued draft identity and canonical workspace. */
export class InstructionImports {
  #proofs = new Map<string, InstructionImportProof>();
  #key(project: string, id: string) {
    return `${pathIdentity(canonicalProject(project))}\0${id}`;
  }
  record(project: string, manifest: Pick<Manifest, "instructions" | "workspace">): void {
    const key = this.#key(project, manifest.workspace.id);
    this.#proofs.delete(key);
    const proof = instructionImportProof(project, manifest);
    if (!proof) return;
    this.#proofs.set(key, proof);
    if (this.#proofs.size > 64) this.#proofs.delete(this.#proofs.keys().next().value!);
  }
  get(project: string, id: string): InstructionImportProof | undefined {
    return this.#proofs.get(this.#key(project, id));
  }
  clear(): void {
    this.#proofs.clear();
  }
}

/** Return only text whose ownership remains with the user, without interpreting Markdown. */
export function unmanagedInstructions(content: string): string | null {
  const start = content.indexOf(MANAGED_START),
    end = content.indexOf(MANAGED_END);
  if (start < 0 && end < 0) return content;
  if (
    start < 0 ||
    end < start ||
    content.indexOf(MANAGED_START, start + MANAGED_START.length) >= 0 ||
    content.indexOf(MANAGED_END, end + MANAGED_END.length) >= 0
  )
    return null;
  return `${content.slice(0, start)}\n${content.slice(end + MANAGED_END.length)}`;
}

/** Evidence of a repeated instruction, rather than an incidental common heading or blank line. */
export function sharedInstructionOverlap(shared: string, unmanaged: string): boolean {
  const instructions = (content: string) =>
    content
      .replace(/<!--[\s\S]*?-->/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/^(?:#{1,6}\s|```|~~~|@\S+$)/.test(line))
      .map((line) => line.replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "").replace(/\s+/g, " "))
      .filter((line) => /[\p{L}\p{N}]/u.test(line));
  const expected = new Set(instructions(shared));
  const actual = instructions(unmanaged);
  return (
    actual.some((line) => expected.has(line)) ||
    (actual.length > 0 && actual.join(" ") === [...expected].join(" "))
  );
}
