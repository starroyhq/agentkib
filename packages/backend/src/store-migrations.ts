import type { DatabaseSync } from "node:sqlite";
import { timestamp } from "./timestamps";

/** Keep the shared on-disk schema readable by both prior and current AgentKib releases. */
export function migrateSharedSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  database.exec("BEGIN IMMEDIATE");
  try {
    let version: number | undefined;
    try {
      const value = database
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get()?.value;
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) version = parsed;
    } catch {
      version = undefined;
    }

    if (version === undefined || version < 2) database.exec(schema2);
    if (version === undefined || version < 3) database.exec(schema3);
    if (version === undefined || version < 4) database.exec(schema4);
    if (version === undefined || version < 5) database.exec(schema5);
    if (version === undefined || version < 6) database.exec(schema6);
    if (version === undefined || version < 7) database.exec(schema7);
    if (version === undefined || version < 8) database.exec(schema8);
    if (version === undefined || version < 9) database.exec(schema9);
    if (version === undefined || version < 10) {
      normalizeLegacyWorkspaceTimestamps(database);
      setVersion(database, 10);
    }
    if (version === undefined || version < 11) database.exec(schema11);
    if (version === undefined || version < 12) {
      if (!tableExists(database, "discovery_runs")) database.exec(schema12Create);
      else if (!columnExists(database, "discovery_runs", "source_diagnostics"))
        database.exec(
          "ALTER TABLE discovery_runs ADD COLUMN source_diagnostics TEXT NOT NULL DEFAULT '[]'",
        );
      setVersion(database, 12);
    }
    if (version === undefined || version < 13) {
      database.exec(schema13Create);
      if (!columnExists(database, "workspace_sources", "session_cwds"))
        database.exec(
          "ALTER TABLE workspace_sources ADD COLUMN session_cwds TEXT NOT NULL DEFAULT '[]'",
        );
      setVersion(database, 13);
    }
    if (version === undefined || version < 14) database.exec(schema14);
    if (version === undefined || version < 15) database.exec(schema15);
    // Additive caches keep schema 15 compatible with previous releases. Collection IDs
    // are not workspaces and must not be inserted into the filesystem catalog.
    database.exec(sessionCollections);
    if (tableExists(database, "usage_events"))
      database.exec(
        "CREATE INDEX IF NOT EXISTS idx_usage_events_session_precision ON usage_events(session_hash, date_precision)",
      );
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

function setVersion(database: DatabaseSync, version: number): void {
  database
    .prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)")
    .run(String(version));
}

function tableExists(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function columnExists(database: DatabaseSync, table: string, column: string): boolean {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (value) => value.name === column,
  );
}

function normalizeLegacyWorkspaceTimestamps(database: DatabaseSync): void {
  if (columnExists(database, "workspaces", "last_active_at")) {
    const rows = database
      .prepare("SELECT id, last_active_at FROM workspaces WHERE last_active_at IS NOT NULL")
      .all() as { id: string; last_active_at: string | number | bigint }[];
    const update = database.prepare("UPDATE workspaces SET last_active_at = ? WHERE id = ?");
    for (const row of rows) update.run(decodeOptionalTime(row.last_active_at), row.id);
  }
  if (columnExists(database, "workspace_sources", "last_active_at")) {
    const rows = database
      .prepare(
        "SELECT workspace_id, agent, evidence, last_active_at FROM workspace_sources WHERE last_active_at IS NOT NULL",
      )
      .all() as {
      workspace_id: string;
      agent: string;
      evidence: string;
      last_active_at: string | number | bigint;
    }[];
    const update = database.prepare(
      "UPDATE workspace_sources SET last_active_at = ? WHERE workspace_id = ? AND agent = ? AND evidence = ?",
    );
    for (const row of rows)
      update.run(decodeOptionalTime(row.last_active_at), row.workspace_id, row.agent, row.evidence);
  }
}

function decodeOptionalTime(value: string | number | bigint): string | null {
  if (typeof value === "string") {
    try {
      return timestamp(value);
    } catch {
      return timestamp(value, true);
    }
  }
  return timestamp(value, true);
}

const schema2 = `
CREATE TABLE IF NOT EXISTS memories (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, memory_type TEXT NOT NULL, content TEXT NOT NULL,
 status TEXT NOT NULL, source_agent TEXT, source_thread TEXT, source_reference TEXT,
 created_at TEXT NOT NULL, approved_at TEXT, invalidated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, status);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(id UNINDEXED, project_id UNINDEXED, content);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
 INSERT INTO memories_fts(id, project_id, content) VALUES (new.id, new.project_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content ON memories BEGIN
 DELETE FROM memories_fts WHERE id = old.id;
 INSERT INTO memories_fts(id, project_id, content) VALUES (new.id, new.project_id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
 DELETE FROM memories_fts WHERE id = old.id;
END;
CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY, project_id TEXT, action TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, repository_group_id TEXT,
 manifest_workspace_id TEXT, status TEXT NOT NULL, asset_count INTEGER NOT NULL DEFAULT 0,
 warning_count INTEGER NOT NULL DEFAULT 0, last_active_at TEXT, last_discovered_at TEXT NOT NULL, last_scanned_at TEXT
);
CREATE TABLE IF NOT EXISTS workspace_sources (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, agent TEXT NOT NULL,
 evidence TEXT NOT NULL, session_count INTEGER NOT NULL DEFAULT 0, last_active_at TEXT,
 PRIMARY KEY(workspace_id, agent, evidence)
);
CREATE TABLE IF NOT EXISTS catalog_assets (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
 agent TEXT, kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL, summary TEXT NOT NULL,
 size INTEGER NOT NULL DEFAULT 0, modified_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_catalog_assets_workspace ON catalog_assets(workspace_id);
CREATE INDEX IF NOT EXISTS idx_catalog_assets_search ON catalog_assets(name, path, summary);
CREATE TABLE IF NOT EXISTS agent_installations (agent TEXT PRIMARY KEY, installed INTEGER NOT NULL, configured INTEGER NOT NULL, version TEXT, home TEXT, warnings TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scan_roots (id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, max_depth INTEGER NOT NULL DEFAULT 5, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS excluded_workspaces (canonical_path TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS discovery_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, discovered_count INTEGER NOT NULL, removed_count INTEGER NOT NULL, errors TEXT NOT NULL);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '2');`;

const schema3 = `
CREATE TABLE IF NOT EXISTS usage_events (
 source_key TEXT PRIMARY KEY, surface_agent TEXT NOT NULL, workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
 occurred_at TEXT, day TEXT, model TEXT, input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
 cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
 total_tokens INTEGER NOT NULL DEFAULT 0, session_hash TEXT, session_count INTEGER NOT NULL DEFAULT 0,
 date_precision TEXT NOT NULL, quality TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_events_day_agent ON usage_events(day, surface_agent);
CREATE INDEX IF NOT EXISTS idx_usage_events_workspace ON usage_events(workspace_id);
CREATE TABLE IF NOT EXISTS usage_daily (
 day TEXT NOT NULL, surface_agent TEXT NOT NULL, workspace_id TEXT NOT NULL DEFAULT '',
 input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
 cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
 reasoning_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
 session_count INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL,
 PRIMARY KEY(day, surface_agent, workspace_id)
);
CREATE TABLE IF NOT EXISTS git_commits (
 repository_group_id TEXT NOT NULL, commit_hash TEXT NOT NULL, authored_at TEXT NOT NULL, day TEXT NOT NULL,
 author_identity_hash TEXT NOT NULL, is_mine INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repository_group_id, commit_hash)
);
CREATE INDEX IF NOT EXISTS idx_git_commits_day ON git_commits(day);
CREATE TABLE IF NOT EXISTS commit_attributions (
 repository_group_id TEXT NOT NULL, commit_hash TEXT NOT NULL, agent TEXT NOT NULL, confidence TEXT NOT NULL,
 method TEXT NOT NULL, PRIMARY KEY(repository_group_id, commit_hash, agent)
);
CREATE TABLE IF NOT EXISTS git_identities (
 id TEXT PRIMARY KEY, identity_hash TEXT NOT NULL UNIQUE, source TEXT NOT NULL, label TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insight_cursors (
 provider TEXT PRIMARY KEY, cursor_json TEXT, available INTEGER NOT NULL DEFAULT 0, quality TEXT NOT NULL,
 coverage_from TEXT, coverage_to TEXT, imported_events INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS achievement_unlocks (code TEXT PRIMARY KEY, unlocked_at TEXT NOT NULL, rule_version INTEGER NOT NULL);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '3');`;

const schema4 = `
ALTER TABLE catalog_assets ADD COLUMN summary_key TEXT;
ALTER TABLE catalog_assets ADD COLUMN summary_params TEXT NOT NULL DEFAULT '{}';
ALTER TABLE insight_cursors ADD COLUMN error_key TEXT;
ALTER TABLE insight_cursors ADD COLUMN error_params TEXT NOT NULL DEFAULT '{}';
UPDATE catalog_assets SET summary_key = CASE summary
 WHEN 'AgentKib 公共指令' THEN 'assets.summary.sharedInstructions'
 WHEN '公共 Skill' THEN 'assets.summary.sharedSkill'
 WHEN '公共 MCP Connection' THEN 'assets.summary.sharedConnection' ELSE summary_key END;
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '4');`;

const schema5 = `
CREATE TABLE IF NOT EXISTS mcp_installations (id TEXT PRIMARY KEY, name TEXT NOT NULL, package_kind TEXT NOT NULL, identifier TEXT NOT NULL, version TEXT, install_path TEXT, status TEXT NOT NULL, installed_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_registry_cache (name TEXT PRIMARY KEY, entry_json TEXT NOT NULL, schema_version TEXT NOT NULL, etag TEXT, cached_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mcp_tool_cache (server_id TEXT NOT NULL, tool_name TEXT NOT NULL, descriptor_json TEXT NOT NULL, probed_at TEXT NOT NULL, PRIMARY KEY(server_id, tool_name));
CREATE TABLE IF NOT EXISTS mcp_runtime_snapshots (config_hash TEXT PRIMARY KEY, server_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, updated_at TEXT NOT NULL);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '5');`;

const schema6 = `
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL, repository_group_id TEXT,
 manifest_workspace_id TEXT, status TEXT NOT NULL, asset_count INTEGER NOT NULL DEFAULT 0,
 warning_count INTEGER NOT NULL DEFAULT 0, last_active_at TEXT, last_discovered_at TEXT NOT NULL, last_scanned_at TEXT
);
UPDATE workspaces SET status = 'healthy' WHERE status = 'needs-import';
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '6');`;

const schema7 = `
CREATE TABLE IF NOT EXISTS quota_snapshot (
 id INTEGER PRIMARY KEY CHECK (id = 1), snapshot_json TEXT, backend TEXT NOT NULL, backend_version TEXT,
 generated_at TEXT, fetched_at TEXT, stale_after_seconds INTEGER, last_attempt_at TEXT NOT NULL,
 last_success_at TEXT, error_key TEXT, error_detail TEXT
);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '7');`;

const schema8 = `
CREATE TABLE IF NOT EXISTS workspace_storage (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
 snapshot_json TEXT, last_attempt_at TEXT NOT NULL, last_success_at TEXT, error_key TEXT, error_detail TEXT
);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '8');`;

const schema9 = `
CREATE TABLE IF NOT EXISTS conversation_sessions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent TEXT NOT NULL, title TEXT, created_at TEXT, updated_at TEXT, message_count INTEGER,
 git_branch TEXT, archived INTEGER NOT NULL DEFAULT 0, sidechain INTEGER NOT NULL DEFAULT 0,
 availability TEXT NOT NULL, last_indexed_at TEXT NOT NULL, UNIQUE(workspace_id, agent, id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_sessions_workspace_updated ON conversation_sessions(workspace_id, updated_at DESC, created_at DESC);
CREATE TABLE IF NOT EXISTS conversation_index_status (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, agent TEXT NOT NULL,
 session_count INTEGER NOT NULL DEFAULT 0, last_attempt_at TEXT NOT NULL, last_success_at TEXT,
 error_key TEXT, error_detail TEXT, PRIMARY KEY(workspace_id, agent)
);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '9');`;

const schema11 = `
ALTER TABLE conversation_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE conversation_sessions ADD COLUMN spawned_by_session_id TEXT;
ALTER TABLE conversation_sessions ADD COLUMN forked_from_session_id TEXT;
UPDATE conversation_index_status SET last_success_at = NULL;
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '11');`;

const schema12Create = `CREATE TABLE discovery_runs (
 id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, discovered_count INTEGER NOT NULL,
 removed_count INTEGER NOT NULL, errors TEXT NOT NULL, source_diagnostics TEXT NOT NULL DEFAULT '[]'
);`;

const schema13Create = `CREATE TABLE IF NOT EXISTS workspace_sources (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, agent TEXT NOT NULL,
 evidence TEXT NOT NULL, session_count INTEGER NOT NULL DEFAULT 0, last_active_at TEXT,
 PRIMARY KEY(workspace_id, agent, evidence)
);`;

const schema14 = `
CREATE TABLE IF NOT EXISTS codex_incremental_state (id INTEGER PRIMARY KEY CHECK(id = 1), state_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS insight_source_events (
 source_id TEXT NOT NULL, source_key TEXT NOT NULL REFERENCES usage_events(source_key) ON DELETE CASCADE,
 PRIMARY KEY(source_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_insight_source_events_key ON insight_source_events(source_key);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '14');`;

const schema15 = `
CREATE TABLE IF NOT EXISTS codex_source_checkpoints (
 source_kind TEXT NOT NULL CHECK(source_kind IN ('files', 'databases')),
 source_id TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(source_kind, source_id)
);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '15');`;

const sessionCollections = `
CREATE TABLE IF NOT EXISTS conversation_collection_sessions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
 agent TEXT NOT NULL, title TEXT, created_at TEXT, updated_at TEXT, message_count INTEGER,
 git_branch TEXT, archived INTEGER NOT NULL DEFAULT 0, sidechain INTEGER NOT NULL DEFAULT 0,
 availability TEXT NOT NULL, origin TEXT NOT NULL, spawned_by_session_id TEXT,
 forked_from_session_id TEXT, last_indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_collection ON conversation_collection_sessions(workspace_id);
CREATE TABLE IF NOT EXISTS conversation_collection_status (
 workspace_id TEXT NOT NULL, agent TEXT NOT NULL, session_count INTEGER NOT NULL DEFAULT 0,
 last_attempt_at TEXT NOT NULL, last_success_at TEXT, error_key TEXT, error_detail TEXT,
 PRIMARY KEY(workspace_id,agent)
);`;
