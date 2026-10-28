import { lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What Claude Desktop 2.37337's delete removes for a CLI session besides its transcript and
 * `<id>/` folder (subagents, tool results): per-session folders and files in the config
 * directory, and files next to the transcript.
 */
const SESSION_DIRECTORIES = ["file-history", "session-env", "uploads", "tasks", "image-cache"];
const SESSION_FILES: ReadonlyArray<readonly [string, string]> = [
  ["debug", ".txt"],
  ["debug", ".1.txt"],
  ["usage-data/facets", ".json"],
  ["usage-data/session-meta", ".json"],
  ["startup-perf", ".txt"],
  ["startup-perf", ".json"],
];
const PROJECT_SUFFIXES = [".ccr-tip.json", ".precompact.json", ".desktop-released.json"];

type Identity = { dev: number; ino: number };

function lstat(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function plainDirectory(file: string): Identity | null {
  const info = lstat(file);
  return info?.isDirectory() && !info.isSymbolicLink() ? { dev: info.dev, ino: info.ino } : null;
}

/** Every folder from the config directory down must be a real folder, never a link. */
function storeDirectory(home: string, store: string): { path: string; identity: Identity } | null {
  let current = home;
  let identity: Identity | null = plainDirectory(home);
  for (const part of store.split("/")) {
    if (!identity) return null;
    current = path.join(current, part);
    identity = plainDirectory(current);
  }
  return identity ? { path: current, identity } : null;
}

function unchanged(directory: string, identity: Identity): boolean {
  const current = plainDirectory(directory);
  return current !== null && current.dev === identity.dev && current.ino === identity.ino;
}

/**
 * Removes the transcript first, then its folder and the per-session files. The transcript must be
 * `<home>/projects/<project>/<nativeId>.jsonl` in real folders. Each removal re-checks that its
 * folder is the one inspected, so a swapped link never redirects it.
 *
 * Returns whether the transcript is gone (now or before) and the files left behind.
 */
export function removeClaudeSessionFiles(
  home: string,
  transcript: string | null,
  nativeId: string,
): { transcriptGone: boolean; leftBehind: string[] } {
  if (!uuid.test(nativeId)) throw new Error("unverified-session-identity");
  const leftBehind: string[] = [];
  const remove = (
    file: string,
    directory: boolean,
    parent: { path: string; identity: Identity },
  ) => {
    const info = lstat(file);
    if (!info) return true;
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
      leftBehind.push(file);
      return false;
    }
    try {
      if (!unchanged(parent.path, parent.identity)) throw new Error("folder-changed");
      if (directory) rmSync(file, { recursive: true, force: true });
      else unlinkSync(file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      leftBehind.push(file);
      return false;
    }
  };
  let transcriptGone = transcript === null;
  if (transcript !== null) {
    const projects = storeDirectory(home, "projects");
    const project = path.dirname(transcript);
    const identity = plainDirectory(project);
    if (
      !projects ||
      !identity ||
      path.dirname(project) !== projects.path ||
      path.basename(transcript).toLowerCase() !== `${nativeId.toLowerCase()}.jsonl`
    )
      throw new Error("invalid-Claude-transcript");
    const parent = { path: project, identity };
    transcriptGone = remove(transcript, false, parent);
    if (!transcriptGone) return { transcriptGone, leftBehind };
    remove(path.join(project, path.basename(transcript, ".jsonl")), true, parent);
    for (const suffix of PROJECT_SUFFIXES)
      remove(path.join(project, `${path.basename(transcript, ".jsonl")}${suffix}`), false, parent);
  }
  for (const store of SESSION_DIRECTORIES) {
    const parent = storeDirectory(home, store);
    if (parent) remove(path.join(parent.path, nativeId), true, parent);
  }
  for (const [store, suffix] of SESSION_FILES) {
    const parent = storeDirectory(home, store);
    if (parent) remove(path.join(parent.path, `${nativeId}${suffix}`), false, parent);
  }
  return { transcriptGone, leftBehind };
}

/** Claude Desktop keeps its Claude Code sessions here (macOS); other systems have none. */
export function claudeDesktopSessionRecords(environment: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "darwin") return null;
  return path.join(
    environment.HOME ?? homedir(),
    "Library",
    "Application Support",
    "Claude",
    "claude-code-sessions",
  );
}

/**
 * Every Claude Code session a Claude Desktop record names (`cliSessionId`), archived ones included.
 * Read-only. An unreadable folder or record throws: deleting then could break Desktop's session.
 */
export function claudeDesktopClaims(root: string | null): Set<string> {
  const claims = new Set<string>();
  if (root === null || !plainDirectory(root)) {
    if (root !== null && lstat(root)) throw new Error("claude-desktop-check-unavailable");
    return claims;
  }
  let records = 0;
  const visit = (directory: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new Error("claude-desktop-check-unavailable");
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (depth < 3) visit(file, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/^local_.+\.json$/.test(entry.name)) continue;
      if (++records > 20_000) throw new Error("claude-desktop-check-unavailable");
      let value: unknown;
      try {
        const info = lstatSync(file);
        if (info.size > 4 * 1024 * 1024) throw new Error("record-too-large");
        value = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        throw new Error("claude-desktop-check-unavailable");
      }
      const id =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).cliSessionId
          : undefined;
      if (typeof id === "string" && uuid.test(id)) claims.add(id.toLowerCase());
    }
  };
  visit(root, 1);
  return claims;
}
