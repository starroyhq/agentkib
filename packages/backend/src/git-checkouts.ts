import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";
import { canonicalize, pathIdentity } from "./paths";
import type { SessionDirectory } from "./session-store";

/**
 * Git checkout facts for the session catalog, read from git's own files. Listing a catalog
 * never runs git: `.git`, `gitdir`, `commondir`, `HEAD`, `config` and `worktrees/*` suffice.
 */
export type CheckoutStatus = "present" | "deleted" | "unknown";

export interface WorkspaceCheckout {
  /** Hash of the shared git directory; every worktree of one repository has the same value. */
  repository_group_id: string;
  kind: "primary" | "worktree";
  /** The repository's main checkout; null for a bare repository or when it is unknown. */
  primary_path: string | null;
  /** Worktree name; null for the main checkout. */
  name: string | null;
  branch: string | null;
  status: CheckoutStatus;
}

/** A linked worktree a session ran in; sessions in a main checkout carry none. */
export interface SessionWorktree {
  /** Null only when the worktree could not be inspected. */
  repository_group_id: string | null;
  name: string;
  path: string;
  branch: string | null;
  status: CheckoutStatus;
}

export interface CheckoutWorkspace {
  id: string;
  path: string;
  repository_group_id?: unknown;
}

interface Checkout {
  root: string;
  gitDir: string;
  commonDir: string;
  linked: boolean;
}

const METADATA_LIMIT = 1024 * 1024;
const WORKTREE_LIMIT = 1000;

function absent(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function metadataText(file: string): string {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.size > METADATA_LIMIT)
    throw new Error("Git metadata must be a small regular file");
  return readFileSync(file, "utf8");
}

/** Matches the IDs workspace discovery stores, so stored and computed groups agree. */
export function repositoryGroupId(commonDir: string): string {
  return createHash("sha256").update(pathIdentity(commonDir)).digest("hex");
}

/** Reads `<root>/.git`. Null when root holds no checkout; throws when git metadata is unreadable. */
export function readCheckout(root: string): Checkout | null {
  const marker = path.join(root, ".git");
  let metadata;
  try {
    metadata = lstatSync(marker);
  } catch (error) {
    if (absent(error)) return null;
    throw error;
  }
  if (metadata.isDirectory()) {
    const gitDir = canonicalize(marker);
    return { root, gitDir, commonDir: gitDir, linked: false };
  }
  if (isReparseOrSymlink(marker, metadata) || !metadata.isFile()) return null;
  const pointer = metadataText(marker)
    .trim()
    .match(/^gitdir:\s*(.+)$/i);
  if (!pointer) return null;
  const gitDir = canonicalize(path.resolve(root, pointer[1]!.trim()));
  let common: string;
  try {
    common = metadataText(path.join(gitDir, "commondir")).trim();
  } catch (error) {
    // A submodule or a separate git directory: its own repository, not a linked worktree.
    if (absent(error)) return { root, gitDir, commonDir: gitDir, linked: false };
    throw error;
  }
  const commonDir = canonicalize(path.resolve(gitDir, common));
  // As in Codex: a shared git directory other than `<root>/.git` marks a linked worktree.
  return { root, gitDir, commonDir, linked: pathIdentity(commonDir) !== pathIdentity(marker) };
}

/** The branch HEAD names, or a short commit when detached. */
function readBranch(gitDir: string): string | null {
  try {
    const head = metadataText(path.join(gitDir, "HEAD")).trim();
    const reference = /^ref:\s*(\S+)$/.exec(head)?.[1];
    if (reference) return reference.replace(/^refs\/heads\//, "") || null;
    return /^[0-9a-f]{40,64}$/i.test(head) ? head.slice(0, 7) : null;
  } catch {
    return null;
  }
}

function primaryPath(commonDir: string): string | null {
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
}

/** `[remote "origin"] url`, which every worktree of the repository shares. */
function originUrl(commonDir: string): string | null {
  let section = "";
  try {
    for (const raw of metadataText(path.join(commonDir, "config")).split(/\r?\n/)) {
      const line = raw.trim();
      const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line)?.[1];
      if (header !== undefined) {
        section = header.replace(/\s+/g, " ").toLowerCase();
        continue;
      }
      const url = section === 'remote "origin"' ? /^url\s*=\s*(.+)$/i.exec(line)?.[1] : undefined;
      if (url) return normalizeOrigin(url);
    }
  } catch {}
  return null;
}

export function normalizeOrigin(url: string): string {
  return url
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
}

type Pattern = { root: string; name: string; kind: "codex" | "claude" };

/** Codex keeps worktrees in `<CODEX_HOME>/worktrees/<name>/<repo>`; Claude Code in `<repo>/.claude/worktrees/<name>`. */
function worktreePattern(value: string, codexHome: string): Pattern | null {
  const parts = value.split(path.sep);
  const relative = path.relative(path.join(codexHome, "worktrees"), value);
  if (relative && !path.isAbsolute(relative) && !relative.startsWith("..")) {
    const [name, repository] = relative.split(path.sep);
    if (name && repository)
      return { root: path.join(codexHome, "worktrees", name, repository), name, kind: "codex" };
  }
  for (let index = parts.length - 3; index >= 0; index--) {
    if (parts[index + 1] !== "worktrees" || !parts[index + 2]) continue;
    if (parts[index] === ".claude")
      return {
        root: parts.slice(0, index + 3).join(path.sep),
        name: parts[index + 2]!,
        kind: "claude",
      };
    if (parts[index] === ".codex" && parts[index + 3])
      return {
        root: parts.slice(0, index + 4).join(path.sep),
        name: parts[index + 2]!,
        kind: "codex",
      };
  }
  return null;
}

export function worktreeName(root: string, codexHome: string): string {
  const pattern = worktreePattern(root, codexHome);
  return pattern && pathIdentity(pattern.root) === pathIdentity(root)
    ? pattern.name
    : path.basename(root) || root;
}

function missingPath(value: string): boolean {
  try {
    lstatSync(value);
    return false;
  } catch (error) {
    return absent(error);
  }
}

function strictlyWithin(value: string, root: string): boolean {
  const relative = path.relative(root, value);
  return !!relative && !path.isAbsolute(relative) && !relative.startsWith("..");
}

/** One consistent view of the registered repositories; reused briefly across catalog reads. */
export class CheckoutSnapshot {
  readonly #workspaces = new Map<string, WorkspaceCheckout>();
  readonly #origins = new Map<string, string | null>();
  readonly #worktrees = new Map<string, { group: string; adminDir: string }>();
  readonly #sessions = new Map<string, SessionWorktree | null>();

  constructor(
    workspaces: readonly CheckoutWorkspace[],
    readonly codexHome: string,
  ) {
    const commons = new Map<string, string>();
    const pending: CheckoutWorkspace[] = [];
    for (const workspace of workspaces) {
      const stored =
        typeof workspace.repository_group_id === "string" && workspace.repository_group_id
          ? workspace.repository_group_id
          : null;
      try {
        const checkout = readCheckout(workspace.path);
        if (checkout) {
          const group = repositoryGroupId(checkout.commonDir);
          commons.set(group, checkout.commonDir);
          this.#workspaces.set(workspace.id, {
            repository_group_id: group,
            kind: checkout.linked ? "worktree" : "primary",
            primary_path: checkout.linked ? primaryPath(checkout.commonDir) : checkout.root,
            name: checkout.linked ? worktreeName(checkout.root, codexHome) : null,
            branch: readBranch(checkout.gitDir),
            status: "present",
          });
        } else if (stored && missingPath(workspace.path)) pending.push(workspace);
      } catch {
        if (stored) pending.push(workspace);
      }
    }
    // A folder that is gone keeps the group discovery recorded for it.
    for (const workspace of pending) {
      const group = String(workspace.repository_group_id);
      const primary = [...this.#workspaces.values()].find(
        (value) => value.repository_group_id === group && value.kind === "primary",
      );
      const pattern = worktreePattern(workspace.path, codexHome);
      const worktree =
        (primary !== undefined &&
          primary.primary_path !== null &&
          pathIdentity(primary.primary_path) !== pathIdentity(workspace.path)) ||
        (pattern !== null && pathIdentity(pattern.root) === pathIdentity(workspace.path));
      this.#workspaces.set(workspace.id, {
        repository_group_id: group,
        kind: worktree ? "worktree" : "primary",
        primary_path: worktree ? (primary?.primary_path ?? null) : workspace.path,
        name: worktree ? worktreeName(workspace.path, codexHome) : null,
        branch: null,
        status: missingPath(workspace.path) ? "deleted" : "unknown",
      });
    }
    for (const [group, commonDir] of commons) {
      const origin = originUrl(commonDir);
      // Two clones of one remote leave a deleted worktree's repository ambiguous.
      if (origin) this.#origins.set(origin, this.#origins.has(origin) ? null : group);
      let entries;
      try {
        entries = readdirSync(path.join(commonDir, "worktrees"), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.slice(0, WORKTREE_LIMIT)) {
        if (!entry.isDirectory()) continue;
        const adminDir = path.join(commonDir, "worktrees", entry.name);
        try {
          const marker = metadataText(path.join(adminDir, "gitdir")).trim();
          if (path.isAbsolute(marker))
            this.#worktrees.set(pathIdentity(path.dirname(marker)), { group, adminDir });
        } catch {}
      }
    }
  }

  workspace(id: string): WorkspaceCheckout | null {
    return this.#workspaces.get(id) ?? null;
  }

  /** The linked worktree a session ran in, or null for a main checkout or no repository. */
  session(cwd: string | null | undefined, origin?: string | null): SessionWorktree | null {
    if (!cwd || !path.isAbsolute(cwd)) return null;
    const key = `${cwd}\0${origin ?? ""}`;
    if (this.#sessions.has(key)) return this.#sessions.get(key)!;
    const value = this.#session(cwd, origin ?? null);
    this.#sessions.set(key, value);
    return value;
  }

  #session(cwd: string, origin: string | null): SessionWorktree | null {
    const pattern = worktreePattern(cwd, this.codexHome);
    const unknown = (): SessionWorktree | null =>
      pattern
        ? {
            repository_group_id: null,
            name: pattern.name,
            path: pattern.root,
            branch: null,
            status: "unknown",
          }
        : null;
    let found: string | null = null;
    for (let directory = cwd; ;) {
      try {
        lstatSync(path.join(directory, ".git"));
        found = directory;
        break;
      } catch (error) {
        if (!absent(error)) return unknown();
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    const gone = this.#deleted(cwd, found, pattern, origin);
    if (gone !== undefined) return gone;
    if (found === null) return null;
    let checkout: Checkout | null;
    try {
      checkout = readCheckout(found);
    } catch {
      return pattern && pathIdentity(pattern.root) === pathIdentity(found) ? unknown() : null;
    }
    if (!checkout?.linked) return null;
    return {
      repository_group_id: repositoryGroupId(checkout.commonDir),
      name: worktreeName(found, this.codexHome),
      path: found,
      branch: readBranch(checkout.gitDir),
      status: "present",
    };
  }

  /** A worktree whose folder is gone; the walk for `.git` then ends above its root. */
  #deleted(
    cwd: string,
    found: string | null,
    pattern: Pattern | null,
    origin: string | null,
  ): SessionWorktree | undefined {
    const below = (value: string) => found === null || strictlyWithin(value, found);
    for (let directory = cwd; below(directory);) {
      const known = this.#worktrees.get(pathIdentity(directory));
      if (known && missingPath(directory))
        return {
          repository_group_id: known.group,
          name: worktreeName(directory, this.codexHome),
          path: directory,
          branch: readBranch(known.adminDir),
          status: "deleted",
        };
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    if (!pattern || !below(pattern.root) || !missingPath(pattern.root)) return undefined;
    let group: string | null | undefined;
    if (pattern.kind === "claude" && found !== null) {
      try {
        const repository = readCheckout(found);
        group = repository ? repositoryGroupId(repository.commonDir) : undefined;
      } catch {
        group = undefined;
      }
    } else if (pattern.kind === "codex" && origin)
      group = this.#origins.get(normalizeOrigin(origin));
    if (!group) return undefined;
    return {
      repository_group_id: group,
      name: pattern.name,
      path: pattern.root,
      branch: null,
      status: "deleted",
    };
  }
}

/** Snapshots are cheap to rebuild, but catalog reads arrive in bursts. */
export class GitCheckouts {
  #cached?: { key: string; at: number; snapshot: CheckoutSnapshot };
  constructor(
    readonly ttl = 3000,
    readonly now: () => number = Date.now,
  ) {}
  snapshot(workspaces: readonly CheckoutWorkspace[], codexHome: string): CheckoutSnapshot {
    const key = JSON.stringify([
      codexHome,
      ...workspaces.map((value) => [value.id, value.path, value.repository_group_id ?? null]),
    ]);
    const cached = this.#cached;
    if (cached && cached.key === key && this.now() - cached.at < this.ttl) return cached.snapshot;
    const snapshot = new CheckoutSnapshot(workspaces, codexHome);
    this.#cached = { key, at: this.now(), snapshot };
    return snapshot;
  }
}

const shared = new GitCheckouts();

export interface CatalogCheckoutStore {
  listWorkspaces(): unknown[];
  sessions: { directories(ids: Iterable<string>): Map<string, SessionDirectory> };
}

/**
 * Adds checkout facts at the catalog boundary: `checkout` on workspaces and `worktree` on
 * sessions that ran in a linked worktree. Managed records use their native session's directory.
 */
export function catalogCheckouts(store: CatalogCheckoutStore, environment: NodeJS.ProcessEnv) {
  const registered = store.listWorkspaces() as CheckoutWorkspace[];
  const snapshot = shared.snapshot(
    registered,
    environment.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  return {
    snapshot,
    workspaces<T extends { id: unknown }>(
      rows: readonly T[],
    ): Array<T & { checkout?: WorkspaceCheckout }> {
      return rows.map((row) => {
        const checkout = snapshot.workspace(String(row.id));
        return checkout ? { ...row, checkout } : row;
      });
    },
    sessions<T>(rows: readonly T[]): T[] {
      const sources = (row: Record<string, unknown>) =>
        [
          row.id,
          row.indexedSessionId,
          ...(Array.isArray(row.indexedSessionIds) ? row.indexedSessionIds : []),
        ].filter((id): id is string => typeof id === "string");
      const objects = rows.filter(
        (row): row is T & Record<string, unknown> =>
          !!row && typeof row === "object" && !Array.isArray(row),
      );
      const directories = store.sessions.directories(objects.flatMap(sources));
      return rows.map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return row;
        const directory = sources(row as Record<string, unknown>)
          .map((id) => directories.get(id))
          .find((value) => value !== undefined);
        const worktree = directory && snapshot.session(directory.cwd, directory.git_origin_url);
        return worktree ? { ...row, worktree } : row;
      });
    },
  };
}
