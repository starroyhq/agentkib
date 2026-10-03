import { timestamp } from "./timestamps";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { canonicalize, isDirectory, isProbeWorkspace, pathIdentity } from "./paths";
import {
  compareTimes,
  compareUtf8,
  storedTime,
  utcNow,
  type CatalogAsset,
  type DiscoveryCandidate,
  type DiscoveryPlan,
  type DiscoverySnapshot,
  type InspectedWorkspace,
  type NativeContext,
  type WorkspaceInspection,
  type WorkspacePlan,
} from "./workspaces";

type Row = Record<string, unknown>;

/** Own workspace/discovery writes while the remaining modules continue to share schema 15. */
export class WorkspaceStore {
  constructor(readonly database: DatabaseSync) {}

  prepareWorkspace(
    operation: "add" | "refresh",
    value: string,
    context: NativeContext,
  ): WorkspacePlan {
    if (operation === "refresh") {
      const workspace = this.#rows(
        "SELECT canonical_path FROM workspaces WHERE id = ? OR manifest_workspace_id = ? LIMIT 1",
        value,
        value,
      )[0];
      if (!workspace) throw new Error("Workspace does not exist");
      return {
        id: value,
        path: String(workspace.canonical_path),
        stored_path: String(workspace.canonical_path),
        sources: [],
      };
    }
    let resolved: string;
    try {
      resolved = canonicalize(value);
    } catch {
      throw new Error("Workspace does not exist");
    }
    const identity = pathIdentity(resolved);
    if (context.agent_homes.some((home) => pathIdentity(home) === identity))
      throw new Error(
        "Agent Home cannot be added as a workspace; manage its files in the global asset catalog",
      );
    if (!isDirectory(resolved)) throw new Error("Workspace must be a directory");
    if (context.agentkib_home && pathIdentity(context.agentkib_home) === identity)
      throw new Error(
        "AgentKib Home cannot be added as a workspace; manage its files in the global asset catalog",
      );
    if (
      this.#rows("SELECT home FROM agent_installations WHERE home IS NOT NULL").some(
        (row) => pathIdentity(String(row.home)) === identity,
      )
    )
      throw new Error(
        "Agent Home cannot be added as a workspace; manage its files in the global asset catalog",
      );
    return this.#plan(resolved, [
      {
        path: resolved,
        source_agent: null,
        evidence: "manual",
        last_active_at: utcNow(),
        session_count: 0,
        repository_group_id: null,
      },
    ]);
  }

  addWorkspace(plan: WorkspacePlan, inspection: WorkspaceInspection): string {
    return this.#transaction(() => {
      const excluded = this.#matchingPath("excluded_workspaces", plan.path);
      if (excluded) this.#run("DELETE FROM excluded_workspaces WHERE canonical_path = ?", excluded);
      const id = this.#upsert(plan);
      this.#applyInspection(id, inspection);
      return id;
    });
  }

  refreshWorkspace(plan: WorkspacePlan, inspection: WorkspaceInspection): string {
    const error = this.#transaction(() => {
      // A failure records attention while preserving the last usable partial scan.
      return this.#applyInspection(plan.id, inspection);
    });
    if (error) throw new Error(error);
    return plan.id;
  }

  excludeWorkspace(id: string): void {
    const workspace = this.#rows(
      "SELECT canonical_path FROM workspaces WHERE id = ? OR manifest_workspace_id = ? LIMIT 1",
      id,
      id,
    )[0];
    if (!workspace) throw new Error("Workspace does not exist");
    this.#transaction(() => {
      this.#run(
        "INSERT OR REPLACE INTO excluded_workspaces(canonical_path, created_at) VALUES (?, ?)",
        String(workspace.canonical_path),
        storedTime(utcNow()),
      );
      this.#run("DELETE FROM workspaces WHERE id = ?", id);
    });
  }

  restoreExcludedWorkspace(value: string): void {
    const stored = this.#matchingPath("excluded_workspaces", value);
    if (stored) this.#run("DELETE FROM excluded_workspaces WHERE canonical_path = ?", stored);
  }

  addScanRoot(value: string, maxDepth: number) {
    let resolved: string;
    try {
      resolved = canonicalize(value);
    } catch {
      throw new Error("Scan root does not exist");
    }
    if (!isDirectory(resolved)) throw new Error("Scan root must be a directory");
    const stored = this.#matchingPath("scan_roots", resolved) ?? resolved;
    this.#run(
      "INSERT INTO scan_roots(id, canonical_path, enabled, max_depth, created_at) VALUES (?, ?, 1, ?, ?) ON CONFLICT(canonical_path) DO UPDATE SET enabled = 1, max_depth = excluded.max_depth",
      randomUUID(),
      stored,
      Math.min(8, Math.max(1, maxDepth)),
      storedTime(utcNow()),
    );
    const row = this.#rows(
      "SELECT id, canonical_path, enabled, max_depth, created_at FROM scan_roots WHERE canonical_path = ?",
      stored,
    )[0]!;
    return {
      id: row.id,
      path: row.canonical_path,
      enabled: Number(row.enabled) !== 0,
      max_depth: Number(row.max_depth),
      created_at: timestamp(row.created_at),
    };
  }

  removeScanRoot(id: string): void {
    this.#run("DELETE FROM scan_roots WHERE id = ?", id);
  }

  prepareDiscovery(snapshot: DiscoverySnapshot, context: NativeContext): DiscoveryPlan {
    const managed = snapshot.installations.flatMap((installation) =>
      installation.home ? [pathIdentity(installation.home)] : [],
    );
    if (context.agentkib_home) managed.push(pathIdentity(context.agentkib_home));
    const homes = new Set(managed);
    const excluded = new Set(
      this.#rows("SELECT canonical_path FROM excluded_workspaces").map((row) =>
        pathIdentity(String(row.canonical_path)),
      ),
    );
    const grouped = new Map<string, { path: string; sources: DiscoveryCandidate[] }>();
    for (const candidate of snapshot.candidates) {
      const identity = pathIdentity(candidate.path);
      if (
        !isDirectory(candidate.path) ||
        isProbeWorkspace(candidate.path) ||
        homes.has(identity) ||
        excluded.has(identity)
      )
        continue;
      let group = grouped.get(identity);
      if (!group) {
        group = { path: candidate.path, sources: [] };
        grouped.set(identity, group);
      }
      group.sources.push(candidate);
    }
    return {
      managed_homes: [...homes],
      workspaces: [...grouped.entries()]
        .sort(([left], [right]) => compareUtf8(left, right))
        .map(([, group]) => this.#plan(group.path, group.sources)),
    };
  }

  syncDiscovery(
    plan: DiscoveryPlan,
    snapshot: DiscoverySnapshot,
    inspected: InspectedWorkspace[],
    startedAt: string,
  ) {
    const inspections = new Map(inspected.map((value) => [value.id, value.inspection]));
    // Validate before taking the write transaction: missing scans must never erase existing data.
    if (plan.workspaces.some((workspace) => !inspections.has(workspace.id)))
      throw new Error("Incomplete native workspace inspection");
    return this.#transaction(() => {
      const errors = [...snapshot.errors];
      for (const workspace of plan.workspaces) {
        const id = this.#upsert(workspace);
        const error = this.#applyInspection(id, inspections.get(workspace.id)!);
        if (error) errors.push(`Workspace ${workspace.path} scan failed: ${error}`);
      }
      const homes = new Set(plan.managed_homes);
      const nonWorkspaces = new Set((snapshot.non_workspace_paths ?? []).map(pathIdentity));
      const planned = new Set(plan.workspaces.map((workspace) => pathIdentity(workspace.path)));
      const stale = this.#rows("SELECT id, canonical_path FROM workspaces").filter((row) => {
        const value = String(row.canonical_path);
        if (nonWorkspaces.has(pathIdentity(value)) && !planned.has(pathIdentity(value))) {
          const sources = this.#rows(
            "SELECT agent,evidence FROM workspace_sources WHERE workspace_id=?",
            String(row.id),
          );
          if (
            sources.length > 0 &&
            sources.every((source) => source.agent === "codex" && source.evidence === "session-cwd")
          )
            return true;
        }
        return !isDirectory(value) || isProbeWorkspace(value) || homes.has(pathIdentity(value));
      });
      for (const row of stale) this.#run("DELETE FROM workspaces WHERE id = ?", String(row.id));
      this.#run("DELETE FROM catalog_assets WHERE scope IN ('agent-home', 'agentkib-home')");
      for (const asset of snapshot.home_assets) this.#insertAsset(asset);
      this.#run("DELETE FROM agent_installations");
      for (const installation of snapshot.installations)
        this.#run(
          "INSERT INTO agent_installations(agent, installed, configured, version, home, warnings) VALUES (?, ?, ?, ?, ?, ?)",
          installation.agent,
          Number(installation.installed),
          Number(installation.configured),
          installation.version,
          installation.home,
          JSON.stringify(installation.warnings),
        );
      const finishedAt = utcNow();
      this.#run(
        "INSERT INTO discovery_runs(id, started_at, finished_at, discovered_count, removed_count, errors, source_diagnostics) VALUES (?, ?, ?, ?, ?, ?, ?)",
        randomUUID(),
        storedTime(startedAt),
        storedTime(finishedAt),
        plan.workspaces.length,
        stale.length,
        JSON.stringify(errors),
        JSON.stringify(snapshot.source_diagnostics),
      );
      this.#run(
        "INSERT INTO audit_events(id, project_id, action, detail, created_at) VALUES (?, NULL, 'discovery.complete', ?, ?)",
        randomUUID(),
        `${plan.workspaces.length} workspaces, ${errors.length} errors`,
        storedTime(finishedAt),
      );
      return {
        started_at: startedAt,
        finished_at: finishedAt,
        discovered_count: plan.workspaces.length,
        removed_count: stale.length,
        errors,
        ...(snapshot.source_diagnostics.length
          ? { source_diagnostics: snapshot.source_diagnostics }
          : {}),
      };
    });
  }

  discoveryReport() {
    const row = this.#rows(
      "SELECT started_at, finished_at, discovered_count, removed_count, errors, COALESCE(source_diagnostics, '[]') AS source_diagnostics FROM discovery_runs ORDER BY finished_at DESC LIMIT 1",
    )[0];
    if (!row) return null;
    const diagnostics = storedDiagnostics(JSON.parse(String(row.source_diagnostics)));
    return {
      started_at: timestamp(row.started_at),
      finished_at: timestamp(row.finished_at),
      discovered_count: storedCount(row.discovered_count),
      removed_count: storedCount(row.removed_count),
      errors: stringArray(JSON.parse(String(row.errors))),
      ...(diagnostics.length ? { source_diagnostics: diagnostics } : {}),
    };
  }

  #plan(value: string, sources: DiscoveryCandidate[]): WorkspacePlan {
    const existing = this.#matchingWorkspace(value);
    return {
      id: existing ? String(existing.id) : randomUUID(),
      path: value,
      stored_path: existing ? String(existing.canonical_path) : value,
      sources,
    };
  }

  #upsert(plan: WorkspacePlan): string {
    const existing = this.#matchingWorkspace(plan.path);
    if (existing && String(existing.id) !== plan.id)
      throw new Error("Workspace changed during native inspection");
    const latest =
      plan.sources
        .flatMap((source) => (source.last_active_at ? [source.last_active_at] : []))
        .sort(compareTimes)
        .at(-1) ?? null;
    const group =
      plan.sources.find((source) => source.repository_group_id != null)?.repository_group_id ??
      null;
    const providedName = plan.sources.find((source) => source.display_name != null)?.display_name;
    const name = providedName?.trim() ? providedName : path.basename(plan.path) || "workspace";
    this.#run(
      "INSERT INTO workspaces(id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_discovered_at, last_scanned_at) VALUES (?, ?, ?, ?, NULL, 'healthy', 0, 0, ?, ?, NULL) ON CONFLICT(canonical_path) DO UPDATE SET name = excluded.name, repository_group_id = COALESCE(excluded.repository_group_id, workspaces.repository_group_id), last_active_at = CASE WHEN excluded.last_active_at IS NULL THEN workspaces.last_active_at WHEN workspaces.last_active_at IS NULL OR excluded.last_active_at > workspaces.last_active_at THEN excluded.last_active_at ELSE workspaces.last_active_at END, last_discovered_at = excluded.last_discovered_at",
      plan.id,
      plan.stored_path,
      name,
      group,
      storedTime(latest),
      storedTime(utcNow()),
    );
    this.#run(
      "DELETE FROM workspace_sources WHERE workspace_id = ? AND evidence != 'manual'",
      plan.id,
    );
    for (const source of plan.sources)
      this.#run(
        "INSERT INTO workspace_sources(workspace_id, agent, evidence, session_count, last_active_at, session_cwds) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, agent, evidence) DO UPDATE SET session_count = excluded.session_count, last_active_at = excluded.last_active_at, session_cwds = excluded.session_cwds",
        plan.id,
        source.source_agent ?? "",
        source.evidence,
        source.session_count,
        storedTime(source.last_active_at),
        JSON.stringify(source.session_cwds ?? []),
      );
    return plan.id;
  }

  #applyInspection(id: string, inspection: WorkspaceInspection): string | null {
    let error = inspection.error;
    try {
      if (inspection.summary) {
        const summary = inspection.summary;
        this.#run(
          "UPDATE workspaces SET manifest_workspace_id = ?, status = ?, asset_count = ?, warning_count = ?, last_scanned_at = ? WHERE id = ?",
          summary.manifest_workspace_id,
          summary.status,
          summary.asset_count,
          summary.warning_count,
          storedTime(summary.scanned_at),
          id,
        );
        this.#run("DELETE FROM catalog_assets WHERE workspace_id = ?", id);
        for (const asset of inspection.assets) this.#insertAsset(asset);
      }
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    if (error)
      this.#run(
        "UPDATE workspaces SET status = 'attention', warning_count = MAX(warning_count, 1), last_scanned_at = ? WHERE id = ?",
        storedTime(utcNow()),
        id,
      );
    return error;
  }

  #insertAsset(asset: CatalogAsset): void {
    this.#run(
      "INSERT OR REPLACE INTO catalog_assets(id, scope, workspace_id, agent, kind, name, path, summary, size, modified_at, summary_key, summary_params) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      asset.id || catalogId(asset),
      asset.scope,
      asset.workspace_id,
      asset.agent,
      asset.kind,
      asset.name,
      asset.path,
      asset.summary,
      asset.size,
      storedTime(asset.modified_at),
      asset.summary_key ?? null,
      JSON.stringify(asset.summary_params ?? {}),
    );
  }

  #matchingWorkspace(value: string): Row | undefined {
    const identity = pathIdentity(value);
    return this.#rows("SELECT id, canonical_path FROM workspaces").find(
      (row) => pathIdentity(String(row.canonical_path)) === identity,
    );
  }

  #matchingPath(table: "scan_roots" | "excluded_workspaces", value: string): string | undefined {
    const identity = pathIdentity(value);
    const row = this.#rows(`SELECT canonical_path FROM ${table}`).find(
      (row) => pathIdentity(String(row.canonical_path)) === identity,
    );
    return row ? String(row.canonical_path) : undefined;
  }

  #rows(sql: string, ...params: SQLInputValue[]): Row[] {
    const statement = this.database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params);
  }
  #run(sql: string, ...params: SQLInputValue[]): void {
    this.database.prepare(sql).run(...params);
  }
  #transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function catalogId(asset: CatalogAsset): string {
  const variant = (value: string) =>
    ({
      opencode: "OpenCode",
      "deepseek-harness": "DeepSeekHarness",
      "agentkib-home": "AgentkibHome",
    })[value] ??
    value
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("");
  return createHash("sha256")
    .update(
      `${variant(asset.scope)}|${asset.workspace_id ?? ""}|${asset.agent ? `Some(${variant(asset.agent)})` : "None"}|${variant(asset.kind)}|${asset.path}`,
    )
    .digest("hex");
}

function storedCount(value: unknown): number {
  const count = Number(value);
  if (
    !(typeof value === "number" || typeof value === "bigint") ||
    !Number.isInteger(count) ||
    count < 0
  )
    throw new Error("Invalid stored discovery count");
  return count;
}
function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error("Invalid stored discovery strings");
  return value;
}
function storedDiagnostics(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid stored discovery diagnostics");
  return value.map((diagnostic: unknown) => {
    if (typeof diagnostic !== "object" || diagnostic === null || Array.isArray(diagnostic))
      throw new Error("Invalid stored discovery diagnostic");
    const row = diagnostic as Record<string, unknown>;
    const agents = [
      "codex",
      "claude-code",
      "cursor",
      "opencode",
      "open-claw",
      "hermes",
      "grok-build",
      "antigravity",
      "deepseek-harness",
    ];
    const statuses = [
      "not-configured",
      "missing",
      "empty",
      "succeeded",
      "partial",
      "permission-denied",
      "unsupported",
      "failed",
    ];
    if (
      !(row.agent == null || (typeof row.agent === "string" && agents.includes(row.agent))) ||
      typeof row.source !== "string" ||
      typeof row.status !== "string" ||
      !statuses.includes(row.status) ||
      !(row.path == null || typeof row.path === "string")
    )
      throw new Error("Invalid stored discovery diagnostic");
    const startedAt = timestamp(row.started_at);
    const finishedAt = timestamp(row.finished_at);
    if (!startedAt || !finishedAt)
      throw new Error("Missing stored discovery diagnostic timestamps");
    const result: Record<string, unknown> = {
      agent: row.agent ?? null,
      source: row.source,
      started_at: startedAt,
      finished_at: finishedAt,
      status: row.status,
    };
    if (row.path != null) result.path = row.path;
    for (const key of ["candidate_count", "included_count", "skipped_count"]) {
      if (row[key] != null) {
        if (typeof row[key] !== "number")
          throw new Error("Invalid stored discovery diagnostic count");
        result[key] = storedCount(row[key]);
      }
    }
    const reasons = stringArray(row.reasons === undefined ? [] : row.reasons);
    if (reasons.length) result.reasons = reasons;
    return result;
  });
}
