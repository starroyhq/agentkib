import { claudeConfigFiles, type ClaudeConfig } from "./claude-config";
import { claudeProjectKey } from "./claude-project-path";
import {
  flavor,
  isAutomountRoot,
  isNetworkOrDevicePath,
  pathKey,
  probe,
  type ProbeContext,
  type ProbeStat,
} from "../../context-claude-sources";

// Auto memory, https://code.claude.com/docs/en/memory ("Auto memory"): Claude Code keeps notes in
// `<config>/projects/<project>/memory/MEMORY.md` and loads the first 200 lines or 25KB of that
// file at the start of every session. `<project>` comes from the git repository, so all work
// trees and subdirectories of one repository share it; outside git it is the project root.
//
// The repository is found by looking for `.git` upwards, without running git. A `.git` file (a
// linked work tree or a submodule) comes from the checkout and may be hostile: each step below
// that does not hold makes the search give up and fall back to the working directory, never to
// a guess.

export const MEMORY_LINES = 200;
export const MEMORY_BYTES = 25_000;

const MAX_LEVELS = 64;
const MAX_POINTER_BYTES = 4096;

export type RepoRootAbandoned = "format" | "network" | "missing" | "layout" | "symlink";
export interface RepoRoot {
  /** The directory whose path names the project. */
  base: string;
  /** Why a `.git` file or a link was not followed, for tests; nothing is reported to the user. */
  abandoned?: RepoRootAbandoned;
}
type GitFileResult = { base: string } | { abandoned: RepoRootAbandoned };

/** The one non-blank line of a small pointer file (`.git`, `commondir`, `gitdir`), or null. */
function pointer(file: string, context: ProbeContext): string | null {
  let bytes: Buffer;
  try {
    bytes = context.io.readFile(file, MAX_POINTER_BYTES + 1);
  } catch {
    return null;
  }
  if (bytes.length > MAX_POINTER_BYTES || bytes.includes(0)) return null;
  const rows = bytes
    .toString("utf8")
    .split(/\r?\n/)
    .filter((row) => row.trim() !== "");
  return rows.length === 1 ? rows[0]! : null;
}

function fromGitFile(directory: string, marker: string, context: ProbeContext): GitFileResult {
  const { platform } = context;
  const p = flavor(platform);
  const resolveFrom = (base: string, value: string) =>
    p.isAbsolute(value) ? p.normalize(value) : p.resolve(base, value);
  const row = pointer(marker, context);
  const match = row === null ? null : /^gitdir: (.+)$/.exec(row);
  if (!match) return { abandoned: "format" };
  const gitdir = resolveFrom(directory, match[1]!);
  // Before anything is looked up: a UNC or /net path would make this machine contact a host.
  if (isNetworkOrDevicePath(gitdir, platform)) return { abandoned: "network" };
  const admin = probe(gitdir, null, context);
  if (admin.kind === "network") return { abandoned: "network" };
  if (admin.kind === "missing") return { abandoned: "missing" };
  if (admin.kind !== "dir") return { abandoned: "layout" };
  const commonFile = probe(p.join(admin.real, "commondir"), admin.real, context);
  // No commondir: a submodule, whose repository root is the directory that holds the `.git` file.
  if (commonFile.kind === "missing") return { base: directory };
  if (commonFile.kind === "network") return { abandoned: "network" };
  if (commonFile.kind !== "file") return { abandoned: "layout" };
  const common = pointer(commonFile.real, context);
  if (common === null) return { abandoned: "format" };
  const commonDir = resolveFrom(admin.real, common.trim());
  if (isNetworkOrDevicePath(commonDir, platform)) return { abandoned: "network" };
  if (p.basename(commonDir) !== ".git") return { abandoned: "layout" };
  const main = probe(p.dirname(commonDir), null, context);
  const mainGit = probe(commonDir, null, context);
  if (main.kind !== "dir" || mainGit.kind !== "dir") return { abandoned: "layout" };
  // The administrative folder must sit in the common directory's `worktrees` and point back at
  // this very `.git` file, as git checks itself; otherwise a checkout could name any repository.
  const worktrees = p.dirname(admin.real);
  if (
    p.basename(worktrees) !== "worktrees" ||
    pathKey(p.dirname(worktrees), platform) !== pathKey(mainGit.real, platform)
  )
    return { abandoned: "layout" };
  const back = pointer(p.join(admin.real, "gitdir"), context);
  if (back === null) return { abandoned: "layout" };
  const target = resolveFrom(admin.real, back.trim());
  if (isNetworkOrDevicePath(target, platform)) return { abandoned: "network" };
  const pointed = probe(target, null, context);
  if (pointed.kind !== "file" || pathKey(pointed.real, platform) !== pathKey(marker, platform))
    return { abandoned: "layout" };
  return { base: main.real };
}

/** The repository root for `cwd`, which must be canonical, or `cwd` itself. */
export function resolveRepoRoot(cwd: string, context: ProbeContext): RepoRoot {
  const p = flavor(context.platform);
  let directory = cwd;
  for (let level = 0; level < MAX_LEVELS; level++) {
    const marker = p.join(directory, ".git");
    let entry: ProbeStat | null = null;
    try {
      // Not inside /net or /Network: an automounter may take the name for a host to look up.
      if (!isAutomountRoot(directory, context.platform)) entry = context.io.lstat(marker);
    } catch {
      // Absent, or not readable: either way the search goes on upwards.
    }
    if (entry) {
      if (entry.isSymbolicLink()) return { base: cwd, abandoned: "symlink" };
      if (entry.isDirectory()) return { base: directory };
      if (!entry.isFile()) return { base: cwd, abandoned: "layout" };
      const found = fromGitFile(directory, marker, context);
      return "base" in found ? found : { base: cwd, abandoned: found.abandoned };
    }
    const above = p.dirname(directory);
    if (above === directory) break;
    directory = above;
  }
  return { base: cwd };
}

export type MemoryLocation =
  | { ok: true; file: string }
  | {
      ok: false;
      reason: "disabled" | "path-too-long" | "directory-name-overridden" | "empty-path";
    };

/**
 * Where Claude Code keeps the auto memory index for `cwd` (canonical); nothing is read from there.
 * `directory` is the absolute folder the `autoMemoryDirectory` setting names, which replaces the
 * per-project default (https://code.claude.com/docs/en/memory, "Storage location").
 */
export function autoMemoryLocation(
  cwd: string,
  config: ClaudeConfig,
  env: NodeJS.ProcessEnv,
  context: ProbeContext,
  directory?: string,
): MemoryLocation {
  if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1") return { ok: false, reason: "disabled" };
  if (directory !== undefined)
    return { ok: true, file: flavor(context.platform).join(directory, "MEMORY.md") };
  const key = claudeProjectKey(resolveRepoRoot(cwd, context).base, env);
  if (!key.ok) return { ok: false, reason: key.reason };
  const projects = claudeConfigFiles(config, context.platform).projects;
  return {
    ok: true,
    file: flavor(context.platform).join(projects, key.key, "memory", "MEMORY.md"),
  };
}
