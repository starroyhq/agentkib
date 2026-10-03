import { lstatSync, readdirSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { canonicalize, pathIdentity } from "./paths";
import { isReparseOrSymlink } from "./native-files";
import { fileTime } from "./asset-scanner";
import type { DiscoveryCandidate } from "./workspaces";
import { utcNow } from "./workspaces";

const markers = [
  ".agentkib",
  ".git",
  "AGENTS.md",
  "CLAUDE.md",
  ".codex",
  ".claude",
  ".cursor",
  ".opencode",
  "opencode.json",
  "opencode.jsonc",
  ".grok",
  ".dsh",
];
const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "vendor",
  "coverage",
  "Pods",
  "DerivedData",
  "Library",
]);

export interface ScanRootResult {
  root: string;
  candidates: DiscoveryCandidate[];
  errors: string[];
}

interface ConfiguredScanRoot {
  path: string;
  max_depth: number;
}

export function discoverScanRoots(value: unknown, environment: NodeJS.ProcessEnv = process.env) {
  if (!Array.isArray(value)) throw new Error("Scan roots must be an array");
  const candidates: DiscoveryCandidate[] = [],
    errors: string[] = [],
    source_diagnostics: Record<string, unknown>[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof (item as ConfiguredScanRoot).path !== "string" ||
      !Number.isInteger((item as ConfiguredScanRoot).max_depth)
    )
      throw new Error("Invalid scan root");
    const root = item as ConfiguredScanRoot,
      started_at = utcNow();
    try {
      const result = discoverScanRoot(root.path, root.max_depth),
        finished_at = utcNow();
      candidates.push(...result.candidates);
      source_diagnostics.push({
        agent: null,
        source: "scan-root",
        path: root.path,
        started_at,
        finished_at,
        candidate_count: result.candidates.length,
        included_count: null,
        skipped_count: null,
        status: result.errors.length ? "partial" : result.candidates.length ? "succeeded" : "empty",
        reasons: result.errors.length ? ["scan-entry-failed"] : [],
      });
      errors.push(
        ...result.errors.map((error) => `Scan root ${root.path} partially failed: ${error}`),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      source_diagnostics.push({
        agent: null,
        source: "scan-root",
        path: root.path,
        started_at,
        finished_at: utcNow(),
        candidate_count: null,
        included_count: null,
        skipped_count: null,
        status: detail.toLowerCase().includes("permission") ? "permission-denied" : "failed",
        reasons: [
          detail.toLowerCase().includes("permission") ? "permission-denied" : "source-read-failed",
        ],
      });
      errors.push(`Scan root ${root.path} failed: ${detail}`);
    }
  }
  return {
    candidates: normalizeDiscoveryCandidates(candidates, environment),
    errors,
    source_diagnostics,
  };
}

export function normalizeDiscoveryCandidates(
  candidates: DiscoveryCandidate[],
  environment: NodeJS.ProcessEnv = process.env,
): DiscoveryCandidate[] {
  let home: string | null = null;
  try {
    home = canonicalize(environment.HOME ?? environment.USERPROFILE ?? homedir());
  } catch {}
  const merged = new Map<string, DiscoveryCandidate>();
  for (const candidate of candidates) {
    const sessionRoot =
      candidate.evidence === "session-cwd" &&
      ["open-claw", "hermes", "grok-build"].includes(candidate.source_agent ?? "");
    let resolved: string | null;
    try {
      resolved = sessionRoot
        ? sessionWorkspaceRoot(candidate.path, home)
        : canonicalize(candidate.path);
    } catch {
      continue;
    }
    if (!resolved) continue;
    if (!sessionRoot) {
      let current: string | undefined = resolved;
      while (current) {
        if (current !== home && markers.some((name) => exists(path.join(current!, name)))) {
          resolved = current;
          break;
        }
        current = path.dirname(current) === current ? undefined : path.dirname(current);
      }
    }
    candidate.path = resolved;
    if (candidate.session_cwds) {
      const cwds = new Map<string, string>();
      for (const cwd of candidate.session_cwds) {
        try {
          const canonical = canonicalize(cwd);
          cwds.set(pathIdentity(canonical), canonical);
        } catch {}
      }
      candidate.session_cwds = [...cwds.entries()]
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
        .map(([, cwd]) => cwd);
    }
    candidate.repository_group_id = repositoryGroupId(resolved);
    const key = `${pathIdentity(resolved)}\0${candidate.source_agent ?? ""}\0${candidate.evidence}`;
    const existing = merged.get(key);
    if (!existing) merged.set(key, candidate);
    else {
      existing.session_count = Math.min(
        Number.MAX_SAFE_INTEGER,
        existing.session_count + candidate.session_count,
      );
      if (
        candidate.last_active_at &&
        (!existing.last_active_at || candidate.last_active_at > existing.last_active_at)
      )
        existing.last_active_at = candidate.last_active_at;
      existing.display_name ??= candidate.display_name;
      const cwds = new Map(
        (existing.session_cwds ?? []).map((cwd) => [pathIdentity(cwd), cwd] as const),
      );
      for (const cwd of candidate.session_cwds ?? []) cwds.set(pathIdentity(cwd), cwd);
      if (cwds.size)
        existing.session_cwds = [...cwds.entries()]
          .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
          .map(([, cwd]) => cwd);
    }
  }
  return [...merged.entries()]
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
    .map(([, candidate]) => candidate);
}

function sessionWorkspaceRoot(value: string, home: string | null): string | null {
  if (!path.isAbsolute(value)) return null;
  const cwd = canonicalize(value);
  if (!statSync(cwd).isDirectory() || path.dirname(cwd) === cwd || cwd === home) return null;
  let current: string | undefined = cwd;
  while (current) {
    if (current === home || path.dirname(current) === current) break;
    if (markers.some((name) => exists(path.join(current!, name)))) return canonicalize(current);
    current = path.dirname(current);
  }
  return cwd;
}

function repositoryGroupId(workspace: string): string | null {
  try {
    const marker = path.join(workspace, ".git"),
      metadata = lstatSync(marker);
    let gitDirectory: string;
    if (metadata.isDirectory()) gitDirectory = canonicalize(marker);
    else {
      if (isReparseOrSymlink(marker, metadata) || !metadata.isFile()) return null;
      const pointer = readFileSync(marker, "utf8")
        .trim()
        .match(/^gitdir:\s*(.+)$/i);
      if (!pointer) return null;
      gitDirectory = canonicalize(path.resolve(workspace, pointer[1]!));
    }
    try {
      const common = readFileSync(path.join(gitDirectory, "commondir"), "utf8").trim();
      gitDirectory = canonicalize(path.resolve(gitDirectory, common));
    } catch {}
    return createHash("sha256").update(pathIdentity(gitDirectory)).digest("hex");
  } catch {
    return null;
  }
}

/** Find project markers without following links, crossing filesystems, or escaping the depth limit. */
export function discoverScanRoot(value: string, maxDepth: number): ScanRootResult {
  let root: string;
  try {
    const metadata = lstatSync(value);
    if (isReparseOrSymlink(value, metadata))
      throw new Error("scan root must not be a symbolic link or reparse point");
    root = canonicalize(value);
    if (!statSync(root).isDirectory()) throw new Error("scan root is not a directory");
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  const device = statSync(root, { bigint: true }).dev,
    depth = Math.max(1, Math.min(Number.isFinite(maxDepth) ? Math.trunc(maxDepth) : 1, 8)),
    candidates: DiscoveryCandidate[] = [],
    errors: string[] = [];
  if (markers.some((name) => exists(path.join(root, name)))) candidates.push(scanMarker(root));
  const visit = (directory: string, level: number) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(String(error));
      return;
    }
    for (const entry of entries) {
      const current = path.join(directory, entry.name);
      try {
        const metadata = lstatSync(current, { bigint: true });
        if (isReparseOrSymlink(current, metadata) || metadata.dev !== device) continue;
        if (!metadata.isDirectory()) continue;
        if (ignoredDirectories.has(entry.name)) continue;
        if (markers.some((name) => exists(path.join(current, name)))) {
          candidates.push(scanMarker(current));
        }
        if (level + 1 < depth) visit(current, level + 1);
      } catch (error) {
        errors.push(String(error));
      }
    }
  };
  visit(root, 0);
  candidates.sort((left, right) =>
    Buffer.compare(Buffer.from(pathIdentity(left.path)), Buffer.from(pathIdentity(right.path))),
  );
  return { root, candidates, errors };
}

function scanMarker(directory: string): DiscoveryCandidate {
  return {
    path: canonicalize(directory),
    source_agent: null,
    evidence: "scan-marker",
    last_active_at: fileTime(directory),
    session_count: 0,
    repository_group_id: null,
    explicit_workspace: true,
  };
}

function exists(value: string): boolean {
  try {
    lstatSync(value);
    return true;
  } catch {
    return false;
  }
}
