import { SessionStore } from "./session-store";
import { Insights } from "./insights";
import { Sql } from "./sql";
import { Catalog } from "./catalog";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { WorkspaceStore } from "./workspace-store";
import { timestamp } from "./timestamps";
import type { WorkspaceStorage } from "./storage";
export { timestamp } from "./timestamps";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { timestamp as parseTimestamp } from "./timestamps";
import { migrateSharedSchema } from "./store-migrations";

export const SHARED_SCHEMA_VERSION = 15;
type Row = Record<string, unknown>;
const AGENTS = [
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
const EVIDENCE = ["session-cwd", "configured-workspace", "scan-marker", "manual"];

/** Each migrated module owns its writes to shared schema 15. */
export class BackendStore {
  readonly #database: DatabaseSync;
  readonly workspaces: WorkspaceStore;
  readonly sql: Sql;
  readonly catalog: Catalog;
  readonly insights: Insights;
  readonly sessions: SessionStore;

  constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.#database = new DatabaseSync(databasePath);
    try {
      migrateSharedSchema(this.#database);
      this.#database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      const row = this.#database
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get();
      if (row?.value !== String(SHARED_SCHEMA_VERSION)) {
        throw new Error(
          `TypeScript backend requires shared database schema ${SHARED_SCHEMA_VERSION}; received ${String(row?.value)}`,
        );
      }
      this.workspaces = new WorkspaceStore(this.#database);
      this.sql = new Sql(this.#database);
      this.catalog = new Catalog(this.sql);
      this.insights = new Insights(this.sql);
      this.sessions = new SessionStore(this.sql, (id) => this.workspacePath(id));
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  listWorkspaces(): unknown[] {
    this.#database.exec("BEGIN;");
    try {
      const sources = new Map<string, Row[]>();
      for (const source of this.#rows(
        "SELECT workspace_id,agent,evidence,session_count,last_active_at,session_cwds FROM workspace_sources ORDER BY workspace_id,last_active_at DESC,agent,evidence",
      )) {
        const id = String(source.workspace_id);
        const group = sources.get(id);
        if (group) group.push(source);
        else sources.set(id, [source]);
      }
      const result = this.#rows(
        "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces ORDER BY COALESCE(last_active_at, last_scanned_at) DESC, name ASC",
      ).map((row) => this.#workspace(row, sources.get(String(row.id)) ?? []));
      this.#database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    }
  }

  workspacePath(id: string): string {
    const row = this.#rows(
      "SELECT canonical_path FROM workspaces WHERE id = ? OR manifest_workspace_id = ? LIMIT 1",
      id,
      id,
    )[0];
    if (!row) throw new Error("Workspace does not exist");
    return String(row.canonical_path);
  }

  getWorkspace(id: string): unknown {
    const row = this.#rows(
      "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces WHERE id = ?",
      id,
    )[0];
    if (!row) throw new Error("Workspace does not exist");
    return this.#workspace(row);
  }

  #workspace(row: Row, sources?: Row[]) {
    return {
      id: row.id,
      path: row.canonical_path,
      name: row.name,
      repository_group_id: row.repository_group_id,
      manifest_workspace_id: row.manifest_workspace_id,
      status: storedChoice(row.status, ["healthy", "attention"]),
      asset_count: Math.max(0, Number(row.asset_count)),
      warning_count: Math.max(0, Number(row.warning_count)),
      last_active_at: timestamp(row.last_active_at, true),
      last_scanned_at: timestamp(row.last_scanned_at, true),
      sources: (
        sources ??
        this.#rows(
          "SELECT agent, evidence, session_count, last_active_at, session_cwds FROM workspace_sources WHERE workspace_id = ? ORDER BY last_active_at DESC",
          String(row.id),
        )
      ).map((source) => {
        const cwds: unknown = JSON.parse(String(source.session_cwds));
        if (!Array.isArray(cwds) || cwds.some((cwd) => typeof cwd !== "string"))
          throw new Error("Invalid stored session working directories");
        return {
          agent: source.agent === "" ? null : storedChoice(source.agent, AGENTS),
          evidence: storedChoice(source.evidence, EVIDENCE),
          session_count: Math.max(0, Number(source.session_count)),
          last_active_at: timestamp(source.last_active_at, true),
          ...(cwds.length ? { session_cwds: cwds } : {}),
        };
      }),
    };
  }

  listActivity(limit: number): unknown[] {
    return this.#rows(
      "SELECT id, project_id, action, detail, created_at FROM audit_events ORDER BY created_at DESC LIMIT ?",
      Math.min(500, Math.max(1, limit)),
    ).map((row) => ({ ...row, created_at: timestamp(row.created_at) }));
  }

  workspaceStorageOverview(): unknown {
    const total = this.#rows("SELECT COUNT(*) AS count FROM workspaces")[0];
    const values = this.#rows(
      "SELECT w.id, w.name, w.canonical_path, s.snapshot_json, s.last_attempt_at, s.last_success_at, s.error_key, s.error_detail FROM workspace_storage s JOIN workspaces w ON w.id = s.workspace_id",
    )
      .map((row) => {
        const stored =
          typeof row.snapshot_json === "string" ? JSON.parse(row.snapshot_json) : undefined;
        const value = stored ?? {
          workspace_id: row.id,
          name: row.name,
          path: row.canonical_path,
          snapshot_version: 0,
          root: undefined,
          measurement: process.platform === "win32" ? "logical-estimate" : "allocated-exact",
          quality: "unavailable",
          allocated_bytes: 0,
          logical_bytes: 0,
          regenerable_bytes: 0,
          agent_asset_bytes: 0,
          file_count: 0,
          directory_count: 0,
          breakdown: [],
        };
        value.workspace_id = row.id;
        value.name = row.name;
        value.path = row.canonical_path;
        value.last_attempt_at = timestamp(row.last_attempt_at);
        if (row.last_success_at === null || row.last_success_at === undefined)
          delete value.last_success_at;
        else value.last_success_at = timestamp(row.last_success_at);
        if (row.error_key) {
          if (value.last_success_at) value.quality = "partial";
          value.error_key = row.error_key;
          value.error_detail = row.error_detail;
        }
        return value;
      })
      .sort(
        (a, b) =>
          Number(b.allocated_bytes) - Number(a.allocated_bytes) ||
          String(a.name).localeCompare(String(b.name)),
      );
    const successful = values.filter((value) => value.last_success_at);
    return {
      total_workspace_count: Number(total?.count ?? 0),
      scanned_workspace_count: successful.length,
      allocated_bytes: successful.reduce(
        (sum, value) => sum + Number(value.allocated_bytes || 0),
        0,
      ),
      logical_bytes: successful.reduce((sum, value) => sum + Number(value.logical_bytes || 0), 0),
      regenerable_bytes: successful.reduce(
        (sum, value) => sum + Number(value.regenerable_bytes || 0),
        0,
      ),
      agent_asset_bytes: successful.reduce(
        (sum, value) => sum + Number(value.agent_asset_bytes || 0),
        0,
      ),
      last_scanned_at: successful
        .map((value) => value.last_success_at as string)
        .sort()
        .at(-1),
      workspaces: values,
    };
  }

  saveWorkspaceStorage(storage: WorkspaceStorage): void {
    this.#database
      .prepare(
        "INSERT INTO workspace_storage(workspace_id, snapshot_json, last_attempt_at, last_success_at, error_key, error_detail) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,error_key=excluded.error_key,error_detail=excluded.error_detail",
      )
      .run(
        storage.workspace_id,
        JSON.stringify(storage),
        storage.last_attempt_at,
        storage.last_success_at ?? null,
        storage.error_key ?? null,
        storage.error_detail ?? null,
      );
  }

  quotaSnapshot(): unknown | undefined {
    const row = this.#rows("SELECT snapshot_json, error_key FROM quota_snapshot WHERE id = 1")[0];
    if (!row || typeof row.snapshot_json !== "string") return undefined;
    const snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    const generated =
      typeof snapshot.generated_at === "string" ? Date.parse(snapshot.generated_at) : NaN;
    const staleSeconds = Number(snapshot.stale_after_seconds ?? 0);
    snapshot.freshness =
      !Number.isFinite(generated) ||
      Date.now() > generated + Math.max(1, staleSeconds) * 1000 ||
      row.error_key
        ? "stale"
        : "fresh";
    return snapshot;
  }

  quotaCollectorStatus(input: {
    backend: string;
    platform_supported: boolean;
    sidecar_available: boolean;
    config_source: string;
    running: boolean;
  }): unknown {
    const row =
      this.#rows(
        "SELECT backend_version, last_attempt_at, last_success_at, error_key, error_detail FROM quota_snapshot WHERE id = 1",
      )[0] ?? {};
    const errorKey =
      row.error_key ??
      (!input.platform_supported
        ? "errors.quotaUnsupportedPlatform"
        : !input.sidecar_available
          ? "errors.quotaSidecarMissing"
          : undefined);
    return {
      backend: input.backend,
      ...(row.backend_version == null ? {} : { backend_version: row.backend_version }),
      platform_supported: input.platform_supported,
      sidecar_available: input.sidecar_available,
      config_source: input.config_source,
      ...(row.last_attempt_at == null
        ? {}
        : { last_attempt_at: parseTimestamp(row.last_attempt_at) }),
      ...(row.last_success_at == null
        ? {}
        : { last_success_at: parseTimestamp(row.last_success_at) }),
      running: input.running,
      ...(errorKey == null ? {} : { error_key: errorKey }),
      ...(row.error_detail == null ? {} : { error_detail: row.error_detail }),
    };
  }

  saveQuotaSnapshot(snapshot: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        "INSERT INTO quota_snapshot(id, snapshot_json, backend, backend_version, generated_at, fetched_at, stale_after_seconds, last_attempt_at, last_success_at, error_key, error_detail) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json,backend=excluded.backend,backend_version=excluded.backend_version,generated_at=excluded.generated_at,fetched_at=excluded.fetched_at,stale_after_seconds=excluded.stale_after_seconds,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,error_key=NULL,error_detail=NULL",
      )
      .run(
        JSON.stringify(snapshot),
        String(snapshot.backend),
        typeof snapshot.backend_version === "string" ? snapshot.backend_version : null,
        String(snapshot.generated_at),
        String(snapshot.fetched_at),
        Number(snapshot.stale_after_seconds),
        now,
        now,
      );
  }

  recordQuotaFailure(backend: string, errorKey: string, detail: string): void {
    const now = new Date().toISOString();
    this.#database
      .prepare(
        "INSERT INTO quota_snapshot(id, backend, last_attempt_at, error_key, error_detail) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET backend=excluded.backend,last_attempt_at=excluded.last_attempt_at,error_key=excluded.error_key,error_detail=excluded.error_detail",
      )
      .run(backend, now, errorKey, detail.slice(0, 1000));
  }

  recordWorkspaceStorageFailure(
    workspaceId: string,
    attemptedAt: string,
    errorKey: string,
    detail?: string,
  ): void {
    this.#database
      .prepare(
        "INSERT INTO workspace_storage(workspace_id, snapshot_json, last_attempt_at, error_key, error_detail) VALUES (?, NULL, ?, ?, ?) ON CONFLICT(workspace_id) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,error_key=excluded.error_key,error_detail=excluded.error_detail",
      )
      .run(workspaceId, attemptedAt, errorKey, detail ?? null);
  }

  listScanRoots(): unknown[] {
    return this.#rows(
      "SELECT id, canonical_path, enabled, max_depth, created_at FROM scan_roots ORDER BY created_at ASC",
    ).map((row) => ({
      id: row.id,
      path: row.canonical_path,
      enabled: Number(row.enabled) !== 0,
      max_depth: Number(row.max_depth),
      created_at: timestamp(row.created_at),
    }));
  }

  listExcludedWorkspaces(): unknown[] {
    return this.#rows(
      "SELECT canonical_path, created_at FROM excluded_workspaces ORDER BY created_at DESC",
    ).map((row) => ({ path: row.canonical_path, created_at: timestamp(row.created_at) }));
  }

  #rows(sql: string, ...params: SQLInputValue[]): Row[] {
    const statement = this.#database.prepare(sql);
    statement.setReadBigInts(true);
    return statement.all(...params);
  }
}

function storedChoice(value: unknown, choices: string[]): string {
  if (typeof value !== "string" || !choices.includes(value))
    throw new Error(`Invalid stored enum value: ${String(value)}`);
  return value;
}
