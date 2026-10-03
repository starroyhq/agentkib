import { isReparseOrSymlink } from "./native-files";
import {
  closeSync,
  copyFileSync,
  chmodSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { parseDocument } from "yaml";
import { parse as parseToml } from "smol-toml";
import JSON5 from "json5";
import { canonicalProject, readText, withinLexical } from "./files";
import { canonicalize, pathIdentity } from "./paths";
import { safeTarget, hash } from "./doctor-files";
import { moveNoReplace, replaceFile } from "./native-files";
import { archiveChunk, archiveManifest, dateTime, sessionDocument } from "./session-model";
import { lines } from "./context-files";
import type { ChangeSet, FileChange } from "./change-plan";
import { finiteJson } from "./config-merge";
export const fileChange = z.object({
  target: z.string(),
  scope: z.enum(["project", "agent-home", "application-data"]),
  original_hash: z.string().nullable().default(null),
  before: z.string(),
  after: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  validator: z.string(),
});
export const changeSet = z.object({
  id: z.string(),
  project_root: z.string(),
  created_at: dateTime,
  changes: z.array(fileChange),
  requires_home_approval: z.boolean(),
});
export interface ApplyOptions {
  approvedHome: string[];
  protectedHome: string[];
  approvedApplication: string[];
  approveHome: boolean;
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
function noParent(file: string): void {
  if (
    !path.isAbsolute(file) ||
    file.includes("\0") ||
    (process.platform === "win32" ? file.split(/[\\/]/) : file.split("/")).includes("..")
  )
    throw new Error("Path contains an unsafe component");
}
function canonicalMissing(file: string): string {
  noParent(file);
  let current = file;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Path has no existing ancestor");
    suffix.unshift(path.basename(current));
    current = parent;
  }
  return path.join(canonicalize(current), ...suffix);
}
function directoryChain(target: string, label: string): void {
  for (let current = path.dirname(target); ; current = path.dirname(current)) {
    try {
      const info = lstatSync(current);
      if (isReparseOrSymlink(current, info) || !info.isDirectory())
        throw new Error(`${label} parent is not a regular directory`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path.dirname(current) === current) break;
  }
}
function ensureSafe(plan: ChangeSet, change: FileChange, options: ApplyOptions): void {
  const root = canonicalProject(plan.project_root),
    candidate = canonicalMissing(change.target),
    allowed = [...options.approvedHome, ...options.approvedApplication].some((file) => {
      try {
        return pathIdentity(canonicalMissing(file)) === pathIdentity(candidate);
      } catch {
        return false;
      }
    });
  if (!withinLexical(candidate, root) && !allowed)
    throw new Error(`Refusing to write outside the project: ${candidate}`);
  if (change.scope === "project") {
    let lexical: string | null = null;
    for (let current = change.target; ; current = path.dirname(current)) {
      try {
        if (pathIdentity(canonicalize(current)) === pathIdentity(root)) {
          lexical = current;
          break;
        }
      } catch {}
      if (path.dirname(current) === current) break;
    }
    if (!lexical || !safeTarget(lexical, change.target))
      throw new Error(
        `Project ChangeSet targets cannot contain symbolic links or unsafe ancestors: ${change.target}`,
      );
  } else if (change.scope === "agent-home") {
    if (!options.approveHome) throw new Error("Agent Home write is not authorized");
    if (options.protectedHome.some((root) => withinLexical(change.target, root)))
      directoryChain(change.target, "Protected Agent Home");
  } else {
    if (!options.approvedApplication.includes(change.target))
      throw new Error("Application data write is not authorized");
    directoryChain(change.target, "Application data");
  }
}
function currentHash(target: string): string | null {
  try {
    return hash(readFileSync(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function verify(target: string, expected: string | null): void {
  if (currentHash(target) !== expected) throw new Error(`File was modified externally: ${target}`);
}
function stage(parent: string, bytes: Buffer, mode: number): string {
  const file = path.join(parent, `.agentkib-${randomUUID()}.tmp`),
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      chmodSync(file, mode);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  return file;
}
function validate(validator: string, content: string): void {
  switch (validator) {
    case "json":
      finiteJson(JSON.parse(content));
      break;
    case "jsonc":
      finiteJson(JSON5.parse(content));
      break;
    case "jsonl":
      for (const line of lines(content)) if (line.trim()) finiteJson(JSON.parse(line));
      break;
    case "yaml": {
      const document = parseDocument(content);
      if (document.errors.length) throw document.errors[0];
      document.toJSON();
      break;
    }
    case "toml":
      parseToml(content);
      break;
    case "markdown":
    case "text":
      break;
    default:
      throw new Error(`Unknown validator: ${validator}`);
  }
}
function installNoClobber(source: string, target: string): void {
  try {
    linkSync(source, target);
    return;
  } catch {}
  const mode = statSync(source).mode,
    temporary = stage(path.dirname(target), readFileSync(source), mode);
  try {
    moveNoReplace(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
interface Original {
  backup: string;
  hash: string;
}
interface Applied {
  change: FileChange;
  writtenHash: string;
  original: Original | null;
}
function restore(item: Applied): void {
  const { change, writtenHash, original } = item,
    target = change.target,
    quarantine = mkdtempSync(path.join(path.dirname(target), ".agentkib-rollback-")),
    written = path.join(quarantine, "written");
  let replacement: string | undefined,
    kept = false;
  try {
    if (original) {
      verify(original.backup, original.hash);
      replacement = stage(quarantine, readFileSync(original.backup), statSync(target).mode);
    }
    moveNoReplace(target, written);
    let reason: string;
    try {
      if (!lstatSync(written).isFile() || currentHash(written) !== writtenHash)
        reason = "file was modified externally";
      else {
        if (original) installNoClobber(replacement!, target);
        rmSync(written);
        return;
      }
    } catch (error) {
      reason = `could not safely restore backup: ${errorMessage(error)}`;
    }
    kept = true;
    let note: string;
    try {
      if (!lstatSync(written).isFile()) throw new Error("moved target is not a regular file");
      installNoClobber(written, target);
      note = "also restored to the original path";
    } catch (error) {
      note = `could not restore the original path: ${errorMessage(error)}`;
    }
    throw new Error(`${reason}: ${target}; inspect moved content at ${written} (${note})`);
  } finally {
    if (replacement) rmSync(replacement, { force: true });
    if (!kept) rmSync(quarantine, { recursive: true, force: true });
  }
}
export function applyChanges(
  plan: ChangeSet,
  backupRoot: string,
  options: ApplyOptions,
): { changeset_id: string; applied: string[]; backup_dir: string } {
  if (plan.requires_home_approval && !options.approveHome)
    throw new Error("This ChangeSet contains Agent Home files and requires separate authorization");
  if (!plan.id || [".", ".."].includes(plan.id) || /[\\/\0]/.test(plan.id))
    throw new Error("ChangeSet ID must be a path-safe name");
  for (const change of plan.changes) {
    ensureSafe(plan, change, options);
    verify(change.target, change.original_hash);
  }
  const backup = path.join(backupRoot, plan.id),
    prepared: { change: FileChange; temporary: string; original: Original | null }[] = [],
    applied: Applied[] = [];
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  try {
    for (const [index, change] of plan.changes.entries()) {
      const parent = path.dirname(change.target);
      ensureSafe(plan, change, options);
      mkdirSync(parent, { recursive: true });
      ensureSafe(plan, change, options);
      let original: Original | null = null;
      if (change.original_hash !== null) {
        const file = path.join(backup, `${index}.bak`);
        copyFileSync(change.target, file);
        verify(file, change.original_hash);
        original = { backup: file, hash: change.original_hash };
      }
      const mode = existsSync(change.target) ? statSync(change.target).mode : 0o600;
      ensureSafe(plan, change, options);
      prepared.push({
        change,
        original,
        temporary: stage(parent, Buffer.from(change.after), mode),
      });
    }
    for (const { change, original, temporary } of prepared) {
      ensureSafe(plan, change, options);
      if (original) verify(original.backup, original.hash);
      verify(change.target, change.original_hash);
      replaceFile(temporary, change.target);
      const writtenHash = hash(change.after);
      applied.push({ change, writtenHash, original });
      try {
        verify(change.target, writtenHash);
        validate(change.validator, readText(change.target, Infinity, false));
      } catch {
        throw new Error(`Post-write validation failed: ${change.target}`);
      }
    }
    return {
      changeset_id: plan.id,
      applied: applied.map((item) => item.change.target),
      backup_dir: backup,
    };
  } catch (error) {
    const failures: string[] = [];
    for (const item of [...applied].reverse())
      try {
        ensureSafe(plan, item.change, options);
        const current = currentHash(item.change.target);
        if (current === null && !item.original) continue;
        if (current !== item.writtenHash)
          throw new Error(
            "content changed after AgentKib wrote it; external content was preserved",
          );
        restore(item);
      } catch (rollback) {
        failures.push(
          `${item.change.target} (${item.original ? `backup: ${item.original.backup}` : "originally absent"}): ${errorMessage(rollback)}`,
        );
      }
    throw failures.length
      ? new Error(`${errorMessage(error)}; rollback incomplete: ${failures.join("; ")}`)
      : error;
  } finally {
    for (const item of prepared) rmSync(item.temporary, { force: true });
  }
}
export function validateApplicationArchive(
  plan: ChangeSet,
  workspaceId: string,
  dataDir: string,
): string[] {
  const changes = plan.changes.filter((change) => change.scope === "application-data");
  if (!changes.length) return [];
  if (changes.length !== 3)
    throw new Error("Application continuation archive must contain three files");
  const parent = path.dirname(changes[0]!.target),
    archiveId = path.basename(parent);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(archiveId))
    throw new Error("Archive ID must be a UUID");
  const expected = path.join(dataDir, "continuations", hash(workspaceId).slice(0, 32), archiveId);
  for (const change of changes) {
    if (
      path.dirname(change.target) !== expected ||
      !["manifest.json", "document.json", "chunks.jsonl"].includes(path.basename(change.target))
    )
      throw new Error("Application data target escapes its archive");
    noParent(change.target);
    directoryChain(change.target, "Application data");
    if (change.original_hash !== null || existsSync(change.target))
      throw new Error("Application continuation archive may only create new files");
  }
  if (changes.some((change) => path.dirname(change.target) !== parent))
    throw new Error("Application continuation archive files do not share a directory");
  const find = (name: string) => {
    const change = changes.find((change) => path.basename(change.target) === name);
    if (!change) throw new Error(`Application continuation ${name} is missing`);
    return change;
  };
  const manifest = archiveManifest.parse(JSON.parse(find("manifest.json").after)),
    documentChange = find("document.json"),
    chunks = find("chunks.jsonl");
  if (
    manifest.workspace_id !== workspaceId ||
    hash(documentChange.after) !== manifest.document_sha256
  )
    throw new Error("Application continuation archive manifest is invalid");
  if (sessionDocument.parse(JSON.parse(documentChange.after)).source.workspace_id !== workspaceId)
    throw new Error("Application continuation archive document belongs to another workspace");
  if (hash(chunks.after) !== manifest.chunks_sha256)
    throw new Error("Application continuation archive chunks hash does not match its manifest");
  const count = lines(chunks.after)
    .filter((line) => line.trim())
    .map((line) => archiveChunk.parse(JSON.parse(line))).length;
  if (count !== manifest.chunk_count)
    throw new Error("Application continuation archive chunks are invalid");
  return changes.map((change) => change.target);
}
