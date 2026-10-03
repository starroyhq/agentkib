import os from "node:os";
import { lstat, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";

type Totals = {
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
  file_count: number;
  directory_count: number;
};
type Entry = { path: string; name: string; directory: boolean; totals: Totals; children: Entry[] };
export type StorageNode = Totals & {
  id: string;
  name: string;
  relative_path: string;
  kind: "workspace" | "directory" | "root-files" | "aggregate";
  child_count: number;
  children: StorageNode[];
  expandable: boolean;
  partial: boolean;
};
export type WorkspaceStorage = Totals & {
  workspace_id: string;
  name: string;
  path: string;
  snapshot_version: number;
  root?: StorageNode;
  measurement: "allocated-exact" | "logical-estimate";
  quality: "complete" | "partial" | "unavailable";
  breakdown: Array<{
    name: string;
    relative_path: string;
    kind: "directory" | "root-files";
    allocated_bytes: number;
    logical_bytes: number;
    regenerable_bytes: number;
    agent_asset_bytes: number;
  }>;
  last_attempt_at: string;
  last_success_at?: string;
  error_key?: string;
  error_detail?: string;
};

const ZERO: Totals = {
  allocated_bytes: 0,
  logical_bytes: 0,
  regenerable_bytes: 0,
  agent_asset_bytes: 0,
  file_count: 0,
  directory_count: 0,
};
const REGENERABLE = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".gradle",
  ".dart_tool",
  ".venv",
  "__pycache__",
]);
const AGENT_ASSETS = new Set([
  ".agentkib",
  ".agents",
  ".codex",
  ".claude",
  ".cursor",
  "AGENTS.md",
  "CLAUDE.md",
  ".mcp.json",
]);
const MAX_INTERACTIVE_ENTRIES = 100_000;
const MAX_SNAPSHOT_NODES = 10_000;
const MAX_VISIBLE_CHILDREN = 200;
const SNAPSHOT_DEPTH = 4;
const add = (target: Totals, value: Totals) => {
  for (const key of Object.keys(ZERO) as (keyof Totals)[])
    target[key] = Math.min(Number.MAX_SAFE_INTEGER, target[key] + value[key]);
};
const freshTotals = (): Totals => ({ ...ZERO });
const nodeId = (kind: StorageNode["kind"], relative: string) => `${kind}:${relative}`;
const equalPath = (left: string, right: string) =>
  process.platform === "win32"
    ? left.toLocaleLowerCase() === right.toLocaleLowerCase()
    : left === right;
const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};
const compareNames = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

async function scanTree(
  root: string,
  target: string,
  excluded: string[],
  hardLinks: Set<string>,
  entryLimit: number,
  cancelled: () => boolean,
): Promise<{ entry: Entry; errors: string[]; cancelled: boolean; limited: boolean }> {
  const relative = path.relative(root, target);
  const base: Entry = {
    path: relative,
    name: path.basename(target) || path.basename(root),
    directory: true,
    totals: freshTotals(),
    children: [],
  };
  const errors: string[] = [];
  let count = 0;
  let wasCancelled = false;
  let limited = false;
  async function visit(directory: string, parent: Entry): Promise<void> {
    if (cancelled()) {
      wasCancelled = true;
      return;
    }
    let names: string[];
    try {
      names = (await readdir(directory)).sort(compareNames);
    } catch (error) {
      errors.push(`${directory}: ${message(error)}`);
      return;
    }
    for (const name of names) {
      if (cancelled()) {
        wasCancelled = true;
        return;
      }
      const candidate = path.join(directory, name);
      if (excluded.some((item) => equalPath(candidate, item))) continue;
      let meta;
      try {
        meta = await lstat(candidate, { bigint: true });
        if (
          !meta.isSymbolicLink() &&
          isReparseOrSymlink(candidate, { isSymbolicLink: () => false })
        )
          continue;
      } catch (error) {
        errors.push(`${candidate}: ${message(error)}`);
        continue;
      }
      if (count >= entryLimit) {
        limited = true;
        return;
      }
      count++;
      const isDirectory = meta.isDirectory();
      const isFile = meta.isFile();
      const rel = path.relative(root, candidate);
      const totals = freshTotals();
      const size = Number(meta.size);
      totals.allocated_bytes =
        process.platform === "win32"
          ? size
          : Number((meta as typeof meta & { blocks?: bigint }).blocks ?? 0n) * 512;
      if (rel.split(path.sep).some((part) => REGENERABLE.has(part)))
        totals.regenerable_bytes = totals.allocated_bytes;
      if (rel.split(path.sep).some((part) => AGENT_ASSETS.has(part)))
        totals.agent_asset_bytes = totals.allocated_bytes;
      if (isFile) {
        const identity = `${meta.dev}:${meta.ino}`;
        if (meta.nlink > 1n && hardLinks.has(identity)) continue;
        if (meta.nlink > 1n) hardLinks.add(identity);
        totals.logical_bytes = size;
        totals.file_count = 1;
      } else if (meta.isSymbolicLink()) {
        totals.logical_bytes = Number(meta.size);
      }
      const child: Entry = { path: rel, name, directory: isDirectory, totals, children: [] };
      parent.children.push(child);
      if (isDirectory) {
        if (inside(root, candidate)) await visit(candidate, child);
      }
      add(parent.totals, child.totals);
      if (isDirectory) parent.totals.directory_count++;
      if (wasCancelled || limited) return;
    }
  }
  await visit(target, base);
  return { entry: base, errors, cancelled: wasCancelled, limited };
}

function pack(
  entry: Entry,
  kind: StorageNode["kind"],
  depth: number,
  maxDepth: number,
  budget: { value: number },
  partial: boolean,
): StorageNode {
  const candidates = [...entry.children].sort(
    (a, b) => b.totals.allocated_bytes - a.totals.allocated_bytes || compareNames(a.name, b.name),
  );
  const output: StorageNode[] = [];
  const omitted: Entry[] = [];
  const directFiles = freshTotals();
  const directories: Entry[] = [];
  for (const child of candidates) {
    if (child.directory) directories.push(child);
    else add(directFiles, child.totals);
  }
  if (directFiles.allocated_bytes || directFiles.file_count)
    directories.push({
      path: entry.path,
      name: "__root_files__",
      directory: false,
      totals: directFiles,
      children: [],
    });
  directories.sort(
    (a, b) => b.totals.allocated_bytes - a.totals.allocated_bytes || compareNames(a.name, b.name),
  );
  const childLimit = maxDepth === 1 ? maxDepth + MAX_INTERACTIVE_ENTRIES : MAX_VISIBLE_CHILDREN - 1;
  if (depth < maxDepth) {
    for (const child of directories) {
      if (
        output.length >= childLimit ||
        budget.value >= MAX_SNAPSHOT_NODES - Number(omitted.length > 0)
      ) {
        omitted.push(child);
        continue;
      }
      budget.value++;
      if (child.name === "__root_files__") {
        output.push(makeLeaf(child, partial, "root-files"));
      } else {
        output.push(pack(child, "directory", depth + 1, maxDepth, budget, partial));
      }
    }
  }
  if (omitted.length) {
    const combined = freshTotals();
    for (const child of omitted) add(combined, child.totals);
    budget.value++;
    output.push({
      id: nodeId("aggregate", entry.path),
      name: "__other__",
      relative_path: entry.path,
      kind: "aggregate",
      ...combined,
      child_count: omitted.length,
      children: [],
      expandable: true,
      partial,
    });
  }
  return {
    id: nodeId(kind, entry.path),
    name: entry.name,
    relative_path: entry.path,
    kind,
    ...entry.totals,
    child_count: directories.length,
    children: output,
    expandable: directories.length > 0,
    partial,
  };
}
function makeLeaf(entry: Entry, partial: boolean, kind: StorageNode["kind"]): StorageNode {
  return {
    id: nodeId(kind, entry.path),
    name: entry.name,
    relative_path: entry.path,
    kind,
    ...entry.totals,
    child_count: 0,
    children: [],
    expandable: false,
    partial,
  };
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class WorkspaceStorageOwner {
  #cancel?: { cancelled: boolean };
  constructor(
    private readonly store: {
      listWorkspaces(): unknown[];
      workspaceStorageOverview(): unknown;
      saveWorkspaceStorage(value: WorkspaceStorage): void;
      recordWorkspaceStorageFailure(id: string, at: string, key: string, detail?: string): void;
      getWorkspace(id: string): unknown;
    },
  ) {}

  overview() {
    return this.store.workspaceStorageOverview();
  }
  cancel(): boolean {
    if (!this.#cancel) return false;
    this.#cancel.cancelled = true;
    return true;
  }

  async refresh() {
    if (this.#cancel) throw new Error("storage scan is already running");
    const control = { cancelled: false };
    this.#cancel = control;
    const queued = new Date().toISOString();
    const started = new Date().toISOString();
    try {
      const workspaces = this.store.listWorkspaces() as Array<{
        id: string;
        name: string;
        path: string;
      }>;
      const canonical: typeof workspaces = [];
      for (const workspace of workspaces) {
        if (control.cancelled) break;
        try {
          canonical.push({ ...workspace, path: await realpath(workspace.path) });
        } catch (error) {
          this.store.recordWorkspaceStorageFailure(
            workspace.id,
            new Date().toISOString(),
            "storage.scanUnavailable",
            message(error),
          );
        }
      }
      canonical.sort((a, b) => compareNames(a.path, b.path));
      const roots = canonical.map((w) => w.path);
      const hardLinks = new Set<string>();
      const home = await realpath(os.homedir()).catch(() => os.homedir());
      for (const workspace of canonical) {
        if (control.cancelled) break;
        if (
          path.dirname(workspace.path) === workspace.path ||
          (home && equalPath(workspace.path, home))
        ) {
          this.store.recordWorkspaceStorageFailure(
            workspace.id,
            new Date().toISOString(),
            "storage.scanTooBroad",
          );
          continue;
        }
        const excluded = roots.filter(
          (root) => !equalPath(root, workspace.path) && inside(workspace.path, root),
        );
        const scanned = await scanTree(
          workspace.path,
          workspace.path,
          excluded,
          hardLinks,
          Number.MAX_SAFE_INTEGER,
          () => control.cancelled,
        );
        if (scanned.cancelled) break;
        const totals = scanned.entry.totals;
        const unavailable =
          scanned.errors.length > 0 && totals.file_count === 0 && totals.directory_count === 0;
        const quality = unavailable
          ? "unavailable"
          : scanned.limited || scanned.errors.length
            ? "partial"
            : "complete";
        const detail = scanned.errors.length
          ? `${scanned.errors.slice(0, 3).join("\n")}${scanned.errors.length > 3 ? `\n+${scanned.errors.length - 3} more` : ""}`
          : undefined;
        const attempted = new Date().toISOString();
        const breakdown: WorkspaceStorage["breakdown"] = scanned.entry.children
          .filter((item) => item.directory)
          .map((item) => ({
            name: item.name,
            relative_path: item.path,
            kind: "directory",
            allocated_bytes: item.totals.allocated_bytes,
            logical_bytes: item.totals.logical_bytes,
            regenerable_bytes: item.totals.regenerable_bytes,
            agent_asset_bytes: item.totals.agent_asset_bytes,
          }));
        const directFiles = freshTotals();
        for (const item of scanned.entry.children)
          if (!item.directory) add(directFiles, item.totals);
        if (directFiles.file_count || directFiles.allocated_bytes) {
          breakdown.push({
            name: "__root_files__",
            relative_path: "",
            kind: "root-files",
            allocated_bytes: directFiles.allocated_bytes,
            logical_bytes: directFiles.logical_bytes,
            regenerable_bytes: directFiles.regenerable_bytes,
            agent_asset_bytes: directFiles.agent_asset_bytes,
          });
        }
        const result: WorkspaceStorage = {
          workspace_id: workspace.id,
          name: workspace.name,
          path: workspace.path,
          snapshot_version: 2,
          root: unavailable
            ? undefined
            : pack(
                scanned.entry,
                "workspace",
                0,
                SNAPSHOT_DEPTH,
                { value: 1 },
                quality === "partial",
              ),
          measurement: process.platform === "win32" ? "logical-estimate" : "allocated-exact",
          quality,
          ...totals,
          breakdown,
          last_attempt_at: attempted,
          ...(!unavailable ? { last_success_at: attempted } : {}),
          ...(quality === "complete"
            ? {}
            : {
                error_key: unavailable ? "storage.scanUnavailable" : "storage.scanPartial",
                ...(detail ? { error_detail: detail } : {}),
              }),
        };
        if (unavailable)
          this.store.recordWorkspaceStorageFailure(
            workspace.id,
            attempted,
            result.error_key!,
            detail,
          );
        else this.store.saveWorkspaceStorage(result);
      }
      if (control.cancelled) throw new Error("storage.scanStopped");
      const requestId = `${Date.parse(queued)}-typescript`;
      return {
        kind: "storage",
        disposition: "queued",
        request_id: requestId,
        status: {
          kind: "storage",
          state: "succeeded",
          request_id: requestId,
          queued_at: queued,
          started_at: started,
          finished_at: new Date().toISOString(),
          progress_current: workspaces.length,
          progress_total: workspaces.length,
          error: null,
          next_allowed_at: null,
        },
      };
    } finally {
      if (this.#cancel === control) this.#cancel = undefined;
    }
  }

  async children(workspaceId: string, relativePath: string): Promise<StorageNode> {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).some((part) => part === ".." || part === ".")
    )
      throw new Error("storage path must be relative to its workspace");
    const workspace = this.store.getWorkspace(workspaceId) as {
      id: string;
      name: string;
      path: string;
    };
    const root = await realpath(workspace.path);
    const target = await realpath(path.join(root, relativePath));
    if (!inside(root, target) || !(await lstat(target)).isDirectory())
      throw new Error("storage path is outside the workspace or is not a directory");
    const all = this.store.listWorkspaces() as Array<{ id: string; path: string }>;
    const excluded = await Promise.all(
      all
        .filter((other) => other.id !== workspace.id)
        .map(async (other) => realpath(other.path).catch(() => "")),
    );
    const scan = await scanTree(
      root,
      target,
      excluded.filter(Boolean),
      new Set(),
      MAX_INTERACTIVE_ENTRIES,
      () => false,
    );
    const partial = scan.cancelled || scan.limited || scan.errors.length > 0;
    return pack(scan.entry, relativePath ? "directory" : "workspace", 0, 1, { value: 1 }, partial);
  }

  async resolve(workspaceId: string, relativePath: string): Promise<string> {
    if (
      path.isAbsolute(relativePath) ||
      relativePath.split(/[\\/]/).some((part) => part === ".." || part === ".")
    )
      throw new Error("storage path must be relative to its workspace");
    const workspace = this.store.getWorkspace(workspaceId) as { path: string };
    const root = await realpath(workspace.path);
    const target = await realpath(path.join(root, relativePath));
    if (!inside(root, target) || !(await lstat(target)).isDirectory())
      throw new Error("storage path is outside the workspace or is not a directory");
    return target;
  }
}
