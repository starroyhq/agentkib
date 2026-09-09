use std::fs;
use std::path::{Path, PathBuf};

use std::collections::{BTreeMap, BTreeSet};

use agentkib_conversations::{
    ConversationIndexStatus, ConversationSessionSummary, NativeSessionSummary,
    SessionIndexFreshness, SessionOrigin,
};
use agentkib_core::{
    ActivityRecord, AgentInstallation, AgentKind, AssetKind, AssetRecord, CatalogAsset,
    CatalogScope, DiscoveryCandidate, DiscoveryEvidence, DiscoveryReport,
    DiscoverySourceDiagnostic, ExcludedWorkspace, McpInstallation, McpRegistryEntry,
    McpRuntimeStatus, McpToolDescriptor, MemoryProposal, MemoryRecord, MemoryStatus, ScanRoot,
    WorkspaceSource, WorkspaceStatus, WorkspaceSummary, hash_content, inspect_skill_entrypoint,
    load_manifest, scan_workspace,
};
use agentkib_insights::{
    Achievement, AgentUsageBreakdown, GitIdentitySummary, GitRepositorySnapshot, HeatmapPoint,
    InsightsQuery, InsightsStatus, InsightsSummary, ModelUsageBreakdown, ProviderStatus,
    RepositoryCommitBreakdown, UsageBatch, UsageQuality, WorkspaceUsageBreakdown,
};
use agentkib_platform::path as platform_path;
use agentkib_quota::{QuotaBackend, QuotaCollectorStatus, QuotaSnapshot, sanitize_diagnostic};
use agentkib_storage::{StorageMeasurement, StorageOverview, StorageQuality, WorkspaceStorage};
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Days, Local, NaiveDate, TimeZone, Timelike, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params, types::ValueRef};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub struct Store {
    connection: Connection,
}

mod incremental_insights;

fn enable_wal(connection: &Connection, budget: std::time::Duration) -> Result<()> {
    let deadline = std::time::Instant::now() + budget;
    // Journal-mode conversion can return BUSY immediately instead of invoking SQLite's
    // busy handler when two fresh connections race. Retry only this pre-migration step.
    connection.busy_timeout(std::time::Duration::ZERO)?;
    let result = loop {
        match connection.execute_batch("PRAGMA journal_mode = WAL;") {
            Ok(()) => break Ok(()),
            Err(error)
                if matches!(
                    error.sqlite_error_code(),
                    Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
                ) && std::time::Instant::now() < deadline =>
            {
                std::thread::sleep(
                    std::time::Duration::from_millis(10)
                        .min(deadline.saturating_duration_since(std::time::Instant::now())),
                );
            }
            Err(error) => break Err(error),
        }
    };
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    result.context("enable store WAL journal")
}

#[cfg(not(feature = "dev-app"))]
const APP_DATA_DIRECTORY: &str = "ai.agentkib";
#[cfg(feature = "dev-app")]
const APP_DATA_DIRECTORY: &str = "ai.agentkib.dev";
// Remove after every supported preview build has migrated to `APP_DATA_DIRECTORY`.
#[cfg(not(feature = "dev-app"))]
const LEGACY_APP_DATA_DIRECTORY: &str = "com.agentkib.desktop";

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(path)?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let store = Self { connection };
        store.migrate()?;
        Ok(store)
    }

    pub fn open_default() -> Result<Self> {
        Self::open(&default_database_path()?)
    }

    fn migrate(&self) -> Result<()> {
        self.connection.execute_batch("PRAGMA foreign_keys = ON;")?;
        enable_wal(&self.connection, std::time::Duration::from_secs(5))?;
        // Hold the write lock before reading the version. Multiple Runtime requests can
        // open the store during startup; each migration must observe the version left by
        // the previous opener instead of replaying a stale migration plan.
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )?;
        let current_version = transaction
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .ok()
            .flatten()
            .and_then(|value| value.parse::<u32>().ok());
        if current_version.is_none_or(|version| version < 2) {
            transaction.execute_batch(
            "
             CREATE TABLE IF NOT EXISTS memories (
               id TEXT PRIMARY KEY,
               project_id TEXT NOT NULL,
               memory_type TEXT NOT NULL,
               content TEXT NOT NULL,
               status TEXT NOT NULL,
               source_agent TEXT,
               source_thread TEXT,
               source_reference TEXT,
               created_at TEXT NOT NULL,
               approved_at TEXT,
               invalidated_by TEXT
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
             CREATE TABLE IF NOT EXISTS audit_events (
               id TEXT PRIMARY KEY,
               project_id TEXT,
               action TEXT NOT NULL,
               detail TEXT NOT NULL,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS schema_meta (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS workspaces (
               id TEXT PRIMARY KEY,
               canonical_path TEXT NOT NULL UNIQUE,
               name TEXT NOT NULL,
               repository_group_id TEXT,
               manifest_workspace_id TEXT,
               status TEXT NOT NULL,
               asset_count INTEGER NOT NULL DEFAULT 0,
               warning_count INTEGER NOT NULL DEFAULT 0,
               last_active_at TEXT,
               last_discovered_at TEXT NOT NULL,
               last_scanned_at TEXT
             );
             CREATE TABLE IF NOT EXISTS workspace_sources (
               workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
               agent TEXT NOT NULL,
               evidence TEXT NOT NULL,
               session_count INTEGER NOT NULL DEFAULT 0,
               last_active_at TEXT,
               PRIMARY KEY(workspace_id, agent, evidence)
             );
             CREATE TABLE IF NOT EXISTS catalog_assets (
               id TEXT PRIMARY KEY,
               scope TEXT NOT NULL,
               workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
               agent TEXT,
               kind TEXT NOT NULL,
               name TEXT NOT NULL,
               path TEXT NOT NULL,
               summary TEXT NOT NULL,
               size INTEGER NOT NULL DEFAULT 0,
               modified_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_catalog_assets_workspace ON catalog_assets(workspace_id);
             CREATE INDEX IF NOT EXISTS idx_catalog_assets_search ON catalog_assets(name, path, summary);
             CREATE TABLE IF NOT EXISTS agent_installations (
               agent TEXT PRIMARY KEY,
               installed INTEGER NOT NULL,
               configured INTEGER NOT NULL,
               version TEXT,
               home TEXT,
               warnings TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS scan_roots (
               id TEXT PRIMARY KEY,
               canonical_path TEXT NOT NULL UNIQUE,
               enabled INTEGER NOT NULL DEFAULT 1,
               max_depth INTEGER NOT NULL DEFAULT 5,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS excluded_workspaces (
               canonical_path TEXT PRIMARY KEY,
               created_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS discovery_runs (
               id TEXT PRIMARY KEY,
               started_at TEXT NOT NULL,
               finished_at TEXT NOT NULL,
               discovered_count INTEGER NOT NULL,
               removed_count INTEGER NOT NULL,
               errors TEXT NOT NULL
             );
             INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '2');
             "
            )?;
        }
        if current_version.is_none_or(|version| version < 3) {
            transaction.execute_batch(
                "
                 CREATE TABLE IF NOT EXISTS usage_events (
                   source_key TEXT PRIMARY KEY,
                   surface_agent TEXT NOT NULL,
                   workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
                   occurred_at TEXT,
                   day TEXT,
                   model TEXT,
                   input_tokens INTEGER NOT NULL DEFAULT 0,
                   output_tokens INTEGER NOT NULL DEFAULT 0,
                   cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                   cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                   reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                   total_tokens INTEGER NOT NULL DEFAULT 0,
                   session_hash TEXT,
                   session_count INTEGER NOT NULL DEFAULT 0,
                   date_precision TEXT NOT NULL,
                   quality TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_usage_events_day_agent ON usage_events(day, surface_agent);
                 CREATE INDEX IF NOT EXISTS idx_usage_events_workspace ON usage_events(workspace_id);
                 CREATE TABLE IF NOT EXISTS usage_daily (
                   day TEXT NOT NULL,
                   surface_agent TEXT NOT NULL,
                   workspace_id TEXT NOT NULL DEFAULT '',
                   input_tokens INTEGER NOT NULL DEFAULT 0,
                   output_tokens INTEGER NOT NULL DEFAULT 0,
                   cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                   cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                   reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                   total_tokens INTEGER NOT NULL DEFAULT 0,
                   session_count INTEGER NOT NULL DEFAULT 0,
                   quality TEXT NOT NULL,
                   PRIMARY KEY(day, surface_agent, workspace_id)
                 );
                 CREATE TABLE IF NOT EXISTS git_commits (
                   repository_group_id TEXT NOT NULL,
                   commit_hash TEXT NOT NULL,
                   authored_at TEXT NOT NULL,
                   day TEXT NOT NULL,
                   author_identity_hash TEXT NOT NULL,
                   is_mine INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(repository_group_id, commit_hash)
                 );
                 CREATE INDEX IF NOT EXISTS idx_git_commits_day ON git_commits(day);
                 CREATE TABLE IF NOT EXISTS commit_attributions (
                   repository_group_id TEXT NOT NULL,
                   commit_hash TEXT NOT NULL,
                   agent TEXT NOT NULL,
                   confidence TEXT NOT NULL,
                   method TEXT NOT NULL,
                   PRIMARY KEY(repository_group_id, commit_hash, agent)
                 );
                 CREATE TABLE IF NOT EXISTS git_identities (
                   id TEXT PRIMARY KEY,
                   identity_hash TEXT NOT NULL UNIQUE,
                   source TEXT NOT NULL,
                   label TEXT NOT NULL,
                   enabled INTEGER NOT NULL DEFAULT 1,
                   created_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS insight_cursors (
                   provider TEXT PRIMARY KEY,
                   cursor_json TEXT,
                   available INTEGER NOT NULL DEFAULT 0,
                   quality TEXT NOT NULL,
                   coverage_from TEXT,
                   coverage_to TEXT,
                   imported_events INTEGER NOT NULL DEFAULT 0,
                   error TEXT,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS achievement_unlocks (
                   code TEXT PRIMARY KEY,
                   unlocked_at TEXT NOT NULL,
                   rule_version INTEGER NOT NULL
                 );
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '3');
                 ",
            )?;
        }
        if current_version.is_none_or(|version| version < 4) {
            transaction.execute_batch(
                "
                 ALTER TABLE catalog_assets ADD COLUMN summary_key TEXT;
                 ALTER TABLE catalog_assets ADD COLUMN summary_params TEXT NOT NULL DEFAULT '{}';
                 ALTER TABLE insight_cursors ADD COLUMN error_key TEXT;
                 ALTER TABLE insight_cursors ADD COLUMN error_params TEXT NOT NULL DEFAULT '{}';
                 UPDATE catalog_assets SET summary_key = CASE summary
                   WHEN 'AgentKib 公共指令' THEN 'assets.summary.sharedInstructions'
                   WHEN '公共 Skill' THEN 'assets.summary.sharedSkill'
                   WHEN '公共 MCP Connection' THEN 'assets.summary.sharedConnection'
                   ELSE summary_key END;
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '4');
                 ",
            )?;
        }
        if current_version.is_none_or(|version| version < 5) {
            transaction.execute_batch(
                "
                 CREATE TABLE IF NOT EXISTS mcp_installations (
                   id TEXT PRIMARY KEY,
                   name TEXT NOT NULL,
                   package_kind TEXT NOT NULL,
                   identifier TEXT NOT NULL,
                   version TEXT,
                   install_path TEXT,
                   status TEXT NOT NULL,
                   installed_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS mcp_registry_cache (
                   name TEXT PRIMARY KEY,
                   entry_json TEXT NOT NULL,
                   schema_version TEXT NOT NULL,
                   etag TEXT,
                   cached_at TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS mcp_tool_cache (
                   server_id TEXT NOT NULL,
                   tool_name TEXT NOT NULL,
                   descriptor_json TEXT NOT NULL,
                   probed_at TEXT NOT NULL,
                   PRIMARY KEY(server_id, tool_name)
                 );
                 CREATE TABLE IF NOT EXISTS mcp_runtime_snapshots (
                   config_hash TEXT PRIMARY KEY,
                   server_id TEXT NOT NULL,
                   snapshot_json TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '5');
                 ",
            )?;
        }
        if current_version.is_none_or(|version| version < 6) {
            transaction.execute_batch(
                "
                 CREATE TABLE IF NOT EXISTS workspaces (
                   id TEXT PRIMARY KEY,
                   canonical_path TEXT NOT NULL UNIQUE,
                   name TEXT NOT NULL,
                   repository_group_id TEXT,
                   manifest_workspace_id TEXT,
                   status TEXT NOT NULL,
                   asset_count INTEGER NOT NULL DEFAULT 0,
                   warning_count INTEGER NOT NULL DEFAULT 0,
                   last_active_at TEXT,
                   last_discovered_at TEXT NOT NULL,
                   last_scanned_at TEXT
                 );
                 UPDATE workspaces SET status = 'healthy' WHERE status = 'needs-import';
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '6');
                 ",
            )?;
        }
        if current_version.is_none_or(|version| version < 7) {
            transaction.execute_batch(
                "
                 CREATE TABLE IF NOT EXISTS quota_snapshot (
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   snapshot_json TEXT,
                   backend TEXT NOT NULL,
                   backend_version TEXT,
                   generated_at TEXT,
                   fetched_at TEXT,
                   stale_after_seconds INTEGER,
                   last_attempt_at TEXT NOT NULL,
                   last_success_at TEXT,
                   error_key TEXT,
                   error_detail TEXT
                 );
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '7');
                 ",
            )?;
        }
        if current_version.is_none_or(|version| version < 8) {
            transaction.execute_batch(
                "
                 CREATE TABLE IF NOT EXISTS workspace_storage (
                   workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
                   snapshot_json TEXT,
                   last_attempt_at TEXT NOT NULL,
                   last_success_at TEXT,
                   error_key TEXT,
                   error_detail TEXT
                 );
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '8');
                 ",
            )?;
        }
        if current_version.is_none_or(|version| version < 9) {
            transaction.execute_batch(
                "
                 CREATE TABLE IF NOT EXISTS conversation_sessions (
                   id TEXT PRIMARY KEY,
                   workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                   agent TEXT NOT NULL,
                   title TEXT,
                   created_at TEXT,
                   updated_at TEXT,
                   message_count INTEGER,
                   git_branch TEXT,
                   archived INTEGER NOT NULL DEFAULT 0,
                   sidechain INTEGER NOT NULL DEFAULT 0,
                   availability TEXT NOT NULL,
                   last_indexed_at TEXT NOT NULL,
                   UNIQUE(workspace_id, agent, id)
                 );
                 CREATE INDEX IF NOT EXISTS idx_conversation_sessions_workspace_updated
                   ON conversation_sessions(workspace_id, updated_at DESC, created_at DESC);
                 CREATE TABLE IF NOT EXISTS conversation_index_status (
                   workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                   agent TEXT NOT NULL,
                   session_count INTEGER NOT NULL DEFAULT 0,
                   last_attempt_at TEXT NOT NULL,
                   last_success_at TEXT,
                   error_key TEXT,
                   error_detail TEXT,
                   PRIMARY KEY(workspace_id, agent)
                 );
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '9');
                 ",
            )?;
        }
        if current_version.is_none_or(|version| version < 10) {
            normalize_legacy_workspace_timestamps(&transaction)?;
            transaction.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '10')",
                [],
            )?;
        }
        if current_version.is_none_or(|version| version < 11) {
            transaction.execute_batch(
                "ALTER TABLE conversation_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown';
                     ALTER TABLE conversation_sessions ADD COLUMN spawned_by_session_id TEXT;
                     ALTER TABLE conversation_sessions ADD COLUMN forked_from_session_id TEXT;
                     UPDATE conversation_index_status SET last_success_at = NULL;
                     INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '11');",
            )?;
        }
        if current_version.is_none_or(|version| version < 12) {
            let has_discovery_runs: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'discovery_runs')",
                [],
                |row| row.get(0),
            )?;
            if !has_discovery_runs {
                transaction.execute_batch(
                    "CREATE TABLE discovery_runs (
                       id TEXT PRIMARY KEY,
                       started_at TEXT NOT NULL,
                       finished_at TEXT NOT NULL,
                       discovered_count INTEGER NOT NULL,
                       removed_count INTEGER NOT NULL,
                       errors TEXT NOT NULL,
                       source_diagnostics TEXT NOT NULL DEFAULT '[]'
                     );",
                )?;
            } else {
                let has_source_diagnostics: bool = transaction.query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info('discovery_runs') WHERE name = 'source_diagnostics')",
                    [],
                    |row| row.get(0),
                )?;
                if !has_source_diagnostics {
                    transaction.execute(
                        "ALTER TABLE discovery_runs ADD COLUMN source_diagnostics TEXT NOT NULL DEFAULT '[]'",
                        [],
                    )?;
                }
            }
            transaction.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '12')",
                [],
            )?;
        }
        if current_version.is_none_or(|version| version < 13) {
            // Some older databases contain only the subsystems initialized by
            // that release. Create the source table before adding evidence.
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS workspace_sources (
                   workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                   agent TEXT NOT NULL,
                   evidence TEXT NOT NULL,
                   session_count INTEGER NOT NULL DEFAULT 0,
                   last_active_at TEXT,
                   PRIMARY KEY(workspace_id, agent, evidence)
                 );",
            )?;
            let has_session_cwds: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workspace_sources') WHERE name = 'session_cwds')",
                [],
                |row| row.get(0),
            )?;
            if !has_session_cwds {
                transaction.execute(
                    "ALTER TABLE workspace_sources ADD COLUMN session_cwds TEXT NOT NULL DEFAULT '[]'",
                    [],
                )?;
            }
            transaction.execute(
                "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '13')",
                [],
            )?;
        }
        if current_version.is_none_or(|version| version < 14) {
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS codex_incremental_state (
                   id INTEGER PRIMARY KEY CHECK(id = 1),
                   state_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS insight_source_events (
                   source_id TEXT NOT NULL,
                   source_key TEXT NOT NULL REFERENCES usage_events(source_key) ON DELETE CASCADE,
                   PRIMARY KEY(source_id, source_key)
                 );
                 CREATE INDEX IF NOT EXISTS idx_insight_source_events_key ON insight_source_events(source_key);
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '14');",
            )?;
        }
        if current_version.is_none_or(|version| version < 15) {
            transaction.execute_batch(
                "CREATE TABLE IF NOT EXISTS codex_source_checkpoints (
                   source_kind TEXT NOT NULL CHECK(source_kind IN ('files', 'databases')),
                   source_id TEXT NOT NULL,
                   state_json TEXT NOT NULL,
                   PRIMARY KEY(source_kind, source_id)
                 );
                 INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', '15');",
            )?;
        }
        let has_usage_events: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_events')",
            [],
            |row| row.get(0),
        )?;
        if has_usage_events {
            // Detailed Token events replace session-level aggregate fallbacks by session hash.
            // Without this index a first import performs a full table scan for every event.
            transaction.execute_batch(
                "CREATE INDEX IF NOT EXISTS idx_usage_events_session_precision
                 ON usage_events(session_hash, date_precision);",
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn replace_mcp_tool_cache(
        &self,
        server_id: &str,
        tools: &[McpToolDescriptor],
    ) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM mcp_tool_cache WHERE server_id = ?1",
            [server_id],
        )?;
        let probed_at = Utc::now().to_rfc3339();
        for tool in tools {
            transaction.execute(
                "INSERT INTO mcp_tool_cache(server_id, tool_name, descriptor_json, probed_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    server_id,
                    tool.name,
                    serde_json::to_string(tool)?,
                    probed_at
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn cached_mcp_tools(&self, server_id: &str) -> Result<Vec<McpToolDescriptor>> {
        let mut statement = self.connection.prepare(
            "SELECT descriptor_json FROM mcp_tool_cache
             WHERE server_id = ?1 ORDER BY tool_name",
        )?;
        let rows = statement.query_map([server_id], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let json = row?;
            Ok(serde_json::from_str(&json)?)
        })
        .collect()
    }

    pub fn save_mcp_installation(&self, installation: &McpInstallation) -> Result<()> {
        self.connection.execute(
            "INSERT INTO mcp_installations(
               id, name, package_kind, identifier, version, install_path, status,
               installed_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               package_kind = excluded.package_kind,
               identifier = excluded.identifier,
               version = excluded.version,
               install_path = excluded.install_path,
               status = excluded.status,
               updated_at = excluded.updated_at",
            params![
                installation.id,
                installation.name,
                enum_string(installation.package_kind)?,
                installation.identifier,
                installation.version,
                installation
                    .install_path
                    .as_ref()
                    .map(|path| path.display().to_string()),
                installation.status,
                installation.installed_at.to_rfc3339(),
                installation.updated_at.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    pub fn list_mcp_installations(&self) -> Result<Vec<McpInstallation>> {
        let mut statement = self.connection.prepare(
            "SELECT id, name, package_kind, identifier, version, install_path, status,
                    installed_at, updated_at
             FROM mcp_installations ORDER BY name",
        )?;
        statement
            .query_map([], |row| {
                Ok(McpInstallation {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    package_kind: parse_enum(&row.get::<_, String>(2)?).map_err(sql_error)?,
                    identifier: row.get(3)?,
                    version: row.get(4)?,
                    install_path: row.get::<_, Option<String>>(5)?.map(PathBuf::from),
                    status: row.get(6)?,
                    installed_at: parse_time(&row.get::<_, String>(7)?).map_err(sql_error)?,
                    updated_at: parse_time(&row.get::<_, String>(8)?).map_err(sql_error)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn remove_mcp_installation(&self, id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM mcp_installations WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn replace_mcp_registry_cache(&self, entries: &[McpRegistryEntry]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute("DELETE FROM mcp_registry_cache", [])?;
        let cached_at = Utc::now().to_rfc3339();
        for entry in entries {
            transaction.execute(
                "INSERT INTO mcp_registry_cache(name, entry_json, schema_version, cached_at)
                 VALUES (?1, ?2, 'v0.1', ?3)",
                params![entry.name, serde_json::to_string(entry)?, cached_at],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn search_mcp_registry_cache(&self, query: &str) -> Result<Vec<McpRegistryEntry>> {
        let pattern = format!("%{}%", query.replace('%', "\\%").replace('_', "\\_"));
        let mut statement = self.connection.prepare(
            "SELECT entry_json FROM mcp_registry_cache
             WHERE name LIKE ?1 ESCAPE '\\' OR entry_json LIKE ?1 ESCAPE '\\'
             ORDER BY name LIMIT 100",
        )?;
        let rows = statement.query_map([pattern], |row| row.get::<_, String>(0))?;
        rows.map(|row| {
            let json = row?;
            Ok(serde_json::from_str(&json)?)
        })
        .collect()
    }

    pub fn save_mcp_runtime_snapshots(&self, statuses: &[McpRuntimeStatus]) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for status in statuses {
            transaction.execute(
                "INSERT INTO mcp_runtime_snapshots(config_hash, server_id, snapshot_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(config_hash) DO UPDATE SET
                   snapshot_json = excluded.snapshot_json,
                   updated_at = excluded.updated_at",
                params![
                    status.config_hash,
                    status.server_id,
                    serde_json::to_string(status)?,
                    Utc::now().to_rfc3339(),
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn sync_discovery(
        &self,
        candidates: &[DiscoveryCandidate],
        installations: &[AgentInstallation],
        home_assets: &[CatalogAsset],
        started_at: DateTime<Utc>,
        errors: &[String],
    ) -> Result<DiscoveryReport> {
        self.sync_discovery_with_diagnostics(
            candidates,
            installations,
            home_assets,
            started_at,
            errors,
            &[],
        )
    }

    pub fn sync_discovery_with_diagnostics(
        &self,
        candidates: &[DiscoveryCandidate],
        installations: &[AgentInstallation],
        home_assets: &[CatalogAsset],
        started_at: DateTime<Utc>,
        errors: &[String],
        source_diagnostics: &[DiscoverySourceDiagnostic],
    ) -> Result<DiscoveryReport> {
        let transaction = self.connection.unchecked_transaction()?;
        let excluded = excluded_paths(&transaction)?;
        let agent_homes: BTreeSet<_> = installations
            .iter()
            .filter_map(|installation| installation.home.as_deref())
            .map(platform_path::identity)
            .collect();
        let mut managed_homes = agent_homes;
        if let Ok(home) = agentkib_skills::default_home_dir() {
            managed_homes.insert(platform_path::identity(&home));
        }
        let mut grouped: BTreeMap<String, (PathBuf, Vec<&DiscoveryCandidate>)> = BTreeMap::new();
        for candidate in candidates {
            let identity = platform_path::identity(&candidate.path);
            if candidate.path.is_dir()
                && !platform_path::is_known_agent_probe_workspace(&candidate.path)
                && !managed_homes.contains(&identity)
                && !excluded.contains(&identity)
            {
                grouped
                    .entry(identity)
                    .or_insert_with(|| (candidate.path.clone(), Vec::new()))
                    .1
                    .push(candidate);
            }
        }
        let discovered_paths: BTreeSet<_> = grouped.keys().cloned().collect();
        let mut discovery_errors = errors.to_vec();
        for (_, (path, sources)) in grouped {
            let workspace_id = upsert_workspace(&transaction, &path, &sources)?;
            if let Err(error) = refresh_workspace_record(&transaction, &workspace_id, &path) {
                record_scan_failure(&transaction, &workspace_id)?;
                discovery_errors.push(format!("Workspace {} scan failed: {error}", path.display()));
            }
        }

        let mut stale = Vec::new();
        {
            let mut statement = transaction.prepare("SELECT id, canonical_path FROM workspaces")?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PathBuf::from(row.get::<_, String>(1)?),
                ))
            })?;
            for row in rows {
                let (id, path) = row?;
                // Provider 读取失败或用户撤销扫描目录时，不能误删仍然存在的工作区。
                // 仅清理失效路径、稳定探针目录和只应出现在全局资产目录的 Agent Home。
                if !path.is_dir()
                    || platform_path::is_known_agent_probe_workspace(&path)
                    || managed_homes.contains(&platform_path::identity(&path))
                {
                    stale.push(id);
                }
            }
        }
        for id in &stale {
            transaction.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        }

        transaction.execute(
            "DELETE FROM catalog_assets WHERE scope IN ('agent-home', 'agentkib-home')",
            [],
        )?;
        for asset in home_assets {
            insert_catalog_asset(&transaction, asset)?;
        }
        transaction.execute("DELETE FROM agent_installations", [])?;
        for installation in installations {
            transaction.execute(
                "INSERT INTO agent_installations(agent, installed, configured, version, home, warnings) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    enum_string(installation.agent)?,
                    installation.installed,
                    installation.configured,
                    installation.version,
                    installation.home.as_ref().map(|value| value.display().to_string()),
                    serde_json::to_string(&installation.warnings)?,
                ],
            )?;
        }
        let finished_at = Utc::now();
        let report = DiscoveryReport {
            started_at,
            finished_at,
            discovered_count: discovered_paths.len(),
            removed_count: stale.len(),
            errors: discovery_errors.clone(),
            source_diagnostics: source_diagnostics.to_vec(),
        };
        transaction.execute(
            "INSERT INTO discovery_runs(id, started_at, finished_at, discovered_count, removed_count, errors, source_diagnostics) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![Uuid::new_v4().to_string(), report.started_at.to_rfc3339(), report.finished_at.to_rfc3339(), report.discovered_count as i64, report.removed_count as i64, serde_json::to_string(&discovery_errors)?, serde_json::to_string(source_diagnostics)?],
        )?;
        transaction.execute(
            "INSERT INTO audit_events(id, project_id, action, detail, created_at) VALUES (?1, NULL, 'discovery.complete', ?2, ?3)",
            params![Uuid::new_v4().to_string(), format!("{} workspaces, {} errors", report.discovered_count, discovery_errors.len()), finished_at.to_rfc3339()],
        )?;
        transaction.commit()?;
        Ok(report)
    }

    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceSummary>> {
        let mut statement = self.connection.prepare(
            "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces ORDER BY COALESCE(last_active_at, last_scanned_at) DESC, name ASC",
        )?;
        let rows = statement.query_map([], row_to_workspace)?;
        let mut values = Vec::new();
        for row in rows {
            let mut workspace = row?;
            workspace.sources = self.workspace_sources(&workspace.id)?;
            values.push(workspace);
        }
        Ok(values)
    }

    pub fn get_workspace(&self, id: &str) -> Result<Option<WorkspaceSummary>> {
        let mut value = self.connection.query_row(
            "SELECT id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_scanned_at FROM workspaces WHERE id = ?1",
            params![id],
            row_to_workspace,
        ).optional()?;
        if let Some(workspace) = value.as_mut() {
            workspace.sources = self.workspace_sources(id)?;
        }
        Ok(value)
    }

    pub fn sync_conversation_sessions(
        &self,
        workspace_id: &str,
        agent: AgentKind,
        sessions: &[NativeSessionSummary],
    ) -> Result<Vec<ConversationSessionSummary>> {
        self.sync_conversation_sessions_inner(workspace_id, agent, sessions, true)
    }

    /// Merge sessions from a source that completed only partially. Existing
    /// rows are retained so a transient source error cannot erase history.
    /// Callers should record the source failure afterwards to mark freshness
    /// stale while keeping this last known-good content readable.
    pub fn sync_conversation_sessions_partial(
        &self,
        workspace_id: &str,
        agent: AgentKind,
        sessions: &[NativeSessionSummary],
    ) -> Result<Vec<ConversationSessionSummary>> {
        self.sync_conversation_sessions_inner(workspace_id, agent, sessions, false)
    }

    fn sync_conversation_sessions_inner(
        &self,
        workspace_id: &str,
        agent: AgentKind,
        sessions: &[NativeSessionSummary],
        replace_existing: bool,
    ) -> Result<Vec<ConversationSessionSummary>> {
        if agentkib_conversations::provider(agent).is_none() {
            bail!("Conversation indexing is not supported for this Agent");
        }
        self.get_workspace(workspace_id)?
            .context("Workspace does not exist")?;
        let salt = self.conversation_salt()?;
        let agent_value = enum_string(agent)?;
        let indexed_at = Utc::now();
        let transaction = self.connection.unchecked_transaction()?;
        let (owner_id, aliases) = if matches!(
            agent,
            AgentKind::OpenClaw | AgentKind::Hermes | AgentKind::GrokBuild
        ) {
            self.normalized_session_owner(workspace_id)?
        } else {
            (workspace_id.to_owned(), Vec::new())
        };
        // Preserve cached history when a newly registered root supersedes an
        // alias, including partial scans before that root has ever refreshed.
        for alias in aliases.iter().filter(|id| **id != owner_id) {
            transaction.execute(
                "UPDATE conversation_sessions SET workspace_id = ?1 WHERE workspace_id = ?2 AND agent = ?3",
                params![owner_id, alias, agent_value],
            )?;
            transaction.execute(
                "UPDATE conversation_index_status SET session_count = 0 WHERE workspace_id = ?1 AND agent = ?2",
                params![alias, agent_value],
            )?;
        }
        // Only the owner's complete scan may remove absent sessions. Alias
        // scans can contribute records but cannot erase the owner's cache.
        if replace_existing && owner_id == workspace_id {
            transaction.execute(
                "DELETE FROM conversation_sessions WHERE workspace_id = ?1 AND agent = ?2",
                params![workspace_id, agent_value],
            )?;
        }
        for session in sessions {
            if session.agent != agent {
                bail!("Conversation batch contains a different Agent");
            }
            let id = conversation_identifier(&salt, agent, &session.native_ref);
            transaction.execute(
                "INSERT INTO conversation_sessions(
                   id, workspace_id, agent, title, created_at, updated_at, message_count,
                   git_branch, archived, sidechain, availability, last_indexed_at,
                   origin, spawned_by_session_id, forked_from_session_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(id) DO UPDATE SET
                   workspace_id = excluded.workspace_id,
                   agent = excluded.agent,
                   title = excluded.title,
                   created_at = excluded.created_at,
                   updated_at = excluded.updated_at,
                   message_count = excluded.message_count,
                   git_branch = excluded.git_branch,
                   archived = excluded.archived,
                   sidechain = excluded.sidechain,
                   availability = excluded.availability,
                   last_indexed_at = excluded.last_indexed_at,
                   origin = excluded.origin,
                   spawned_by_session_id = excluded.spawned_by_session_id,
                   forked_from_session_id = excluded.forked_from_session_id",
                params![
                    id,
                    owner_id,
                    &agent_value,
                    session.title.as_deref(),
                    session.created_at.map(|value| value.to_rfc3339()),
                    session.updated_at.map(|value| value.to_rfc3339()),
                    session.message_count.map(to_i64),
                    session.git_branch.as_deref(),
                    session.archived,
                    session.sidechain,
                    enum_string(session.availability)?,
                    indexed_at.to_rfc3339(),
                    enum_string(session.origin)?,
                    session
                        .spawned_by_session_id
                        .as_deref()
                        .filter(|parent| !parent.is_empty() && *parent != session.native_ref)
                        .map(|parent| conversation_identifier(&salt, agent, parent)),
                    session
                        .forked_from_session_id
                        .as_deref()
                        .filter(|parent| !parent.is_empty() && *parent != session.native_ref)
                        .map(|parent| conversation_identifier(&salt, agent, parent)),
                ],
            )?;
        }
        if owner_id != workspace_id {
            // Moving cache is not a successful owner refresh. Keep its existing
            // freshness/error metadata rather than claiming a fresh snapshot.
            transaction.execute(
                "UPDATE conversation_index_status SET session_count = (
                   SELECT COUNT(*) FROM conversation_sessions WHERE workspace_id = ?1 AND agent = ?2
                 ) WHERE workspace_id = ?1 AND agent = ?2",
                params![owner_id, agent_value],
            )?;
        }
        let session_count = transaction.query_row(
            "SELECT COUNT(*) FROM conversation_sessions WHERE workspace_id = ?1 AND agent = ?2",
            params![workspace_id, &agent_value],
            |row| row.get::<_, i64>(0),
        )? as u64;
        transaction.execute(
            "INSERT INTO conversation_index_status(
               workspace_id, agent, session_count, last_attempt_at, last_success_at, error_key, error_detail
             ) VALUES (?1, ?2, ?3, ?4, ?4, NULL, NULL)
             ON CONFLICT(workspace_id, agent) DO UPDATE SET
               session_count = excluded.session_count,
               last_attempt_at = excluded.last_attempt_at,
               last_success_at = excluded.last_success_at,
               error_key = NULL,
               error_detail = NULL",
            params![workspace_id, agent_value, to_i64(session_count), indexed_at.to_rfc3339()],
        )?;
        transaction.commit()?;
        self.list_conversation_sessions(workspace_id)
    }

    /// These providers normalize both cwd and registered workspace paths. Pick
    /// one registered representative before writing their globally stable IDs;
    /// otherwise aliases can steal each other's sessions on every refresh.
    fn normalized_session_owner(&self, workspace_id: &str) -> Result<(String, Vec<String>)> {
        let home = dirs::home_dir();
        let workspace = self.workspace_path(workspace_id)?;
        let Some(root) = platform_path::session_workspace_root(&workspace, home.as_deref()) else {
            return Ok((workspace_id.to_owned(), Vec::new()));
        };
        let mut candidates = self
            .workspace_path_index()?
            .into_iter()
            .filter(|(path, _)| {
                platform_path::session_workspace_root(path, home.as_deref())
                    .is_some_and(|candidate| platform_path::equivalent(&candidate, &root))
            })
            .collect::<Vec<_>>();
        // Prefer the project root itself, then a stable shallow alias when only
        // subdirectories were registered. Activity/refresh order is irrelevant.
        candidates.sort_by_key(|(path, id)| {
            (
                !platform_path::equivalent(path, &root),
                path.components().count(),
                platform_path::identity(path),
                id.clone(),
            )
        });
        let owner = candidates
            .first()
            .map(|(_, id)| id.clone())
            .unwrap_or_else(|| workspace_id.to_owned());
        Ok((owner, candidates.into_iter().map(|(_, id)| id).collect()))
    }

    pub fn record_conversation_index_failure(
        &self,
        workspace_id: &str,
        agent: AgentKind,
        error_key: &str,
        error_detail: &str,
    ) -> Result<()> {
        let agent_value = enum_string(agent)?;
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO conversation_index_status(
               workspace_id, agent, session_count, last_attempt_at, last_success_at, error_key, error_detail
             ) VALUES (?1, ?2, 0, ?3, NULL, ?4, ?5)
             ON CONFLICT(workspace_id, agent) DO UPDATE SET
               last_attempt_at = excluded.last_attempt_at,
               error_key = excluded.error_key,
               error_detail = excluded.error_detail",
            params![workspace_id, agent_value, now, error_key, error_detail],
        )?;
        Ok(())
    }

    pub fn list_conversation_sessions(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ConversationSessionSummary>> {
        let mut statement = self.connection.prepare(
            "SELECT id, workspace_id, agent, title, created_at, updated_at, message_count,
                    git_branch, archived, sidechain, availability, origin,
                    spawned_by_session_id, forked_from_session_id
             FROM conversation_sessions WHERE workspace_id = ?1
             ORDER BY COALESCE(updated_at, created_at) DESC, id DESC",
        )?;
        statement
            .query_map([workspace_id], row_to_conversation_session)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn get_conversation_session(&self, id: &str) -> Result<Option<ConversationSessionSummary>> {
        self.connection
            .query_row(
                "SELECT id, workspace_id, agent, title, created_at, updated_at, message_count,
                        git_branch, archived, sidechain, availability, origin,
                        spawned_by_session_id, forked_from_session_id
                 FROM conversation_sessions WHERE id = ?1",
                [id],
                row_to_conversation_session,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn conversation_index_status(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ConversationIndexStatus>> {
        let mut statement = self.connection.prepare(
            "SELECT workspace_id, agent, session_count, last_attempt_at, last_success_at,
                    error_key, error_detail
             FROM conversation_index_status WHERE workspace_id = ?1 ORDER BY agent",
        )?;
        let now = Utc::now();
        let rows = statement.query_map([workspace_id], |row| {
            let last_attempt_at = parse_time(&row.get::<_, String>(3)?).map_err(sql_error)?;
            let last_success_at = row
                .get::<_, Option<String>>(4)?
                .map(|value| parse_time(&value).map_err(sql_error))
                .transpose()?;
            let error_key = row.get::<_, Option<String>>(5)?;
            let freshness = match last_success_at.as_ref() {
                Some(success)
                    if now.signed_duration_since(*success).num_minutes() < 5
                        && error_key.is_none() =>
                {
                    SessionIndexFreshness::Fresh
                }
                Some(_) => SessionIndexFreshness::Stale,
                None => SessionIndexFreshness::Unavailable,
            };
            Ok(ConversationIndexStatus {
                workspace_id: row.get(0)?,
                agent: parse_enum(&row.get::<_, String>(1)?).map_err(sql_error)?,
                freshness,
                session_count: as_u64(row, 2)?,
                last_attempt_at: Some(last_attempt_at),
                last_success_at,
                error_key,
                error_detail: row.get(6)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn clear_conversation_index(&self, workspace_id: Option<&str>) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        if let Some(workspace_id) = workspace_id {
            transaction.execute(
                "DELETE FROM conversation_sessions WHERE workspace_id = ?1",
                [workspace_id],
            )?;
            transaction.execute(
                "DELETE FROM conversation_index_status WHERE workspace_id = ?1",
                [workspace_id],
            )?;
        } else {
            transaction.execute("DELETE FROM conversation_sessions", [])?;
            transaction.execute("DELETE FROM conversation_index_status", [])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn conversation_id(&self, agent: AgentKind, native_ref: &str) -> Result<String> {
        Ok(conversation_identifier(
            &self.conversation_salt()?,
            agent,
            native_ref,
        ))
    }

    pub fn workspace_path(&self, id: &str) -> Result<PathBuf> {
        self.connection
            .query_row(
                "SELECT canonical_path FROM workspaces WHERE id = ?1 OR manifest_workspace_id = ?1 LIMIT 1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(PathBuf::from)
            .context("Workspace does not exist")
    }

    pub fn add_workspace(&self, path: &Path) -> Result<WorkspaceSummary> {
        let path = platform_path::canonicalize(path).context("Workspace does not exist")?;
        if !path.is_dir() {
            bail!("Workspace must be a directory");
        }
        let path_identity = platform_path::identity(&path);
        if agentkib_skills::default_home_dir()
            .is_ok_and(|home| platform_path::identity(&home) == path_identity)
        {
            bail!(
                "AgentKib Home cannot be added as a workspace; manage its files in the global asset catalog"
            );
        }
        if known_agent_home_identities(&self.connection)?.contains(&path_identity) {
            bail!(
                "Agent Home cannot be added as a workspace; manage its files in the global asset catalog"
            );
        }
        let candidate = DiscoveryCandidate {
            path: path.clone(),
            display_name: None,
            source_agent: None,
            evidence: DiscoveryEvidence::Manual,
            last_active_at: Some(Utc::now()),
            session_count: 0,
            explicit_workspace: true,
            repository_group_id: None,
            session_cwds: None,
        };
        let transaction = self.connection.unchecked_transaction()?;
        if let Some(stored) = matching_stored_path(&transaction, "excluded_workspaces", &path)? {
            transaction.execute(
                "DELETE FROM excluded_workspaces WHERE canonical_path = ?1",
                params![stored],
            )?;
        }
        let workspace_id = upsert_workspace(&transaction, &path, &[&candidate])?;
        if refresh_workspace_record(&transaction, &workspace_id, &path).is_err() {
            record_scan_failure(&transaction, &workspace_id)?;
        }
        transaction.commit()?;
        self.get_workspace_by_path(&path)?
            .context("Workspace registration failed")
    }

    pub fn refresh_workspace(&self, id: &str) -> Result<WorkspaceSummary> {
        let path = self.workspace_path(id)?;
        let transaction = self.connection.unchecked_transaction()?;
        let result = refresh_workspace_record(&transaction, id, &path);
        if result.is_err() {
            record_scan_failure(&transaction, id)?;
        }
        transaction.commit()?;
        result?;
        self.get_workspace(id)?.context("Workspace does not exist")
    }

    pub fn exclude_workspace(&self, id: &str) -> Result<()> {
        let path = self.workspace_path(id)?;
        self.connection.execute(
            "INSERT OR REPLACE INTO excluded_workspaces(canonical_path, created_at) VALUES (?1, ?2)",
            params![path.display().to_string(), Utc::now().to_rfc3339()],
        )?;
        self.connection
            .execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_excluded_workspaces(&self) -> Result<Vec<ExcludedWorkspace>> {
        let mut statement = self.connection.prepare(
            "SELECT canonical_path, created_at FROM excluded_workspaces ORDER BY created_at DESC",
        )?;
        let rows = statement.query_map([], |row| {
            let created: String = row.get(1)?;
            Ok(ExcludedWorkspace {
                path: PathBuf::from(row.get::<_, String>(0)?),
                created_at: parse_time(&created).map_err(sql_error)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn restore_excluded_workspace(&self, path: &Path) -> Result<()> {
        if let Some(stored) = matching_stored_path(&self.connection, "excluded_workspaces", path)? {
            self.connection.execute(
                "DELETE FROM excluded_workspaces WHERE canonical_path = ?1",
                params![stored],
            )?;
        }
        Ok(())
    }

    pub fn list_scan_roots(&self) -> Result<Vec<ScanRoot>> {
        let mut statement = self.connection.prepare("SELECT id, canonical_path, enabled, max_depth, created_at FROM scan_roots ORDER BY created_at ASC")?;
        let rows = statement.query_map([], |row| {
            let created: String = row.get(4)?;
            Ok(ScanRoot {
                id: row.get(0)?,
                path: PathBuf::from(row.get::<_, String>(1)?),
                enabled: row.get(2)?,
                max_depth: row.get::<_, i64>(3)? as usize,
                created_at: parse_time(&created).map_err(sql_error)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn add_scan_root(&self, path: &Path, max_depth: usize) -> Result<ScanRoot> {
        let path = platform_path::canonicalize(path).context("Scan root does not exist")?;
        if !path.is_dir() {
            bail!("Scan root must be a directory");
        }
        let id = Uuid::new_v4().to_string();
        let created_at = Utc::now();
        let path_text = matching_stored_path(&self.connection, "scan_roots", &path)?
            .unwrap_or_else(|| path.display().to_string());
        self.connection.execute(
            "INSERT INTO scan_roots(id, canonical_path, enabled, max_depth, created_at) VALUES (?1, ?2, 1, ?3, ?4) ON CONFLICT(canonical_path) DO UPDATE SET enabled = 1, max_depth = excluded.max_depth",
            params![id, path_text, max_depth.clamp(1, 8) as i64, created_at.to_rfc3339()],
        )?;
        self.connection.query_row(
            "SELECT id, canonical_path, enabled, max_depth, created_at FROM scan_roots WHERE canonical_path = ?1",
            params![path_text],
            |row| { let created: String = row.get(4)?; Ok(ScanRoot { id: row.get(0)?, path: PathBuf::from(row.get::<_, String>(1)?), enabled: row.get(2)?, max_depth: row.get::<_, i64>(3)? as usize, created_at: parse_time(&created).map_err(sql_error)? }) },
        ).map_err(Into::into)
    }

    pub fn remove_scan_root(&self, id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM scan_roots WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list_agent_installations(&self) -> Result<Vec<AgentInstallation>> {
        let mut statement = self.connection.prepare("SELECT agent, installed, configured, version, home, warnings FROM agent_installations ORDER BY agent")?;
        let rows = statement.query_map([], |row| {
            let agent: String = row.get(0)?;
            let agent = parse_enum(&agent).map_err(sql_error)?;
            let warnings: String = row.get(5)?;
            Ok(AgentInstallation {
                agent,
                installed: row.get(1)?,
                configured: row.get(2)?,
                version: row.get(3)?,
                home: row.get::<_, Option<String>>(4)?.map(PathBuf::from),
                warnings: serde_json::from_str(&warnings)
                    .map_err(|error| sql_error(error.into()))?,
                support: Some(agentkib_core::AgentSupportCapabilities::for_agent(agent)),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn search_catalog_assets(
        &self,
        query: &str,
        agent: Option<AgentKind>,
        workspace_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<CatalogAsset>> {
        let pattern = format!("%{}%", query.trim().replace('%', "\\%").replace('_', "\\_"));
        let agent = agent.map(enum_string).transpose()?;
        let mut statement = self.connection.prepare(
            "SELECT id, scope, workspace_id, agent, kind, name, path, summary, size, modified_at, summary_key, summary_params FROM catalog_assets WHERE (name LIKE ?1 ESCAPE '\\' OR path LIKE ?1 ESCAPE '\\' OR summary LIKE ?1 ESCAPE '\\' OR COALESCE(summary_key, '') LIKE ?1 ESCAPE '\\') AND (?2 IS NULL OR agent = ?2) AND (?3 IS NULL OR workspace_id = ?3) ORDER BY modified_at DESC, name ASC LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![pattern, agent, workspace_id, limit.clamp(1, 500) as i64],
            row_to_catalog_asset,
        )?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_global_memories(&self, status: Option<MemoryStatus>) -> Result<Vec<MemoryRecord>> {
        let mut records = Vec::new();
        let (sql, status_value) = if let Some(status) = status {
            (
                "SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE status = ?1 ORDER BY created_at DESC",
                Some(enum_string(status)?),
            )
        } else {
            (
                "SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories ORDER BY created_at DESC",
                None,
            )
        };
        let mut statement = self.connection.prepare(sql)?;
        if let Some(status) = status_value {
            let rows = statement.query_map(params![status], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        } else {
            let rows = statement.query_map([], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        }
        Ok(records)
    }

    pub fn list_activity(&self, limit: usize) -> Result<Vec<ActivityRecord>> {
        let mut statement = self.connection.prepare("SELECT id, project_id, action, detail, created_at FROM audit_events ORDER BY created_at DESC LIMIT ?1")?;
        let rows = statement.query_map(params![limit.clamp(1, 500) as i64], |row| {
            let created: String = row.get(4)?;
            Ok(ActivityRecord {
                id: row.get(0)?,
                project_id: row.get(1)?,
                action: row.get(2)?,
                detail: row.get(3)?,
                created_at: parse_time(&created).map_err(sql_error)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn latest_discovery_finished_at(&self) -> Result<Option<DateTime<Utc>>> {
        let value: Option<String> = self.connection.query_row(
            "SELECT MAX(finished_at) FROM discovery_runs",
            [],
            |row| row.get(0),
        )?;
        value.map(|value| parse_time(&value)).transpose()
    }

    pub fn latest_discovery_report(&self) -> Result<Option<DiscoveryReport>> {
        let row: Option<(String, String, i64, i64, String, String)> = self
            .connection
            .query_row(
                "SELECT started_at, finished_at, discovered_count, removed_count, errors, COALESCE(source_diagnostics, '[]') FROM discovery_runs ORDER BY finished_at DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .optional()?;

        row.map(
            |(
                started_at,
                finished_at,
                discovered_count,
                removed_count,
                errors,
                source_diagnostics,
            )| {
                Ok(DiscoveryReport {
                    started_at: parse_time(&started_at)?,
                    finished_at: parse_time(&finished_at)?,
                    discovered_count: usize::try_from(discovered_count)?,
                    removed_count: usize::try_from(removed_count)?,
                    errors: serde_json::from_str(&errors)?,
                    source_diagnostics: serde_json::from_str(&source_diagnostics)?,
                })
            },
        )
        .transpose()
    }

    pub fn latest_activity_at(&self, action: &str) -> Result<Option<DateTime<Utc>>> {
        let value: Option<String> = self.connection.query_row(
            "SELECT MAX(created_at) FROM audit_events WHERE action = ?1",
            params![action],
            |row| row.get(0),
        )?;
        value.map(|value| parse_time(&value)).transpose()
    }

    pub fn quota_last_success_at(&self) -> Result<Option<DateTime<Utc>>> {
        let value: Option<String> = self
            .connection
            .query_row(
                "SELECT last_success_at FROM quota_snapshot WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        value.map(|value| parse_time(&value)).transpose()
    }

    pub fn storage_overview(&self) -> Result<StorageOverview> {
        let total_workspace_count: usize =
            self.connection
                .query_row("SELECT COUNT(*) FROM workspaces", [], |row| row.get(0))?;
        let mut statement = self.connection.prepare(
            "SELECT w.id, w.name, w.canonical_path, s.snapshot_json, s.last_attempt_at, s.last_success_at, s.error_key, s.error_detail
             FROM workspace_storage s JOIN workspaces w ON w.id = s.workspace_id",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })?;
        let mut workspaces = Vec::new();
        for row in rows {
            let (
                workspace_id,
                name,
                path,
                snapshot,
                attempted_at,
                success_at,
                error_key,
                error_detail,
            ) = row?;
            let mut value = if let Some(snapshot) = snapshot {
                serde_json::from_str::<WorkspaceStorage>(&snapshot)?
            } else {
                WorkspaceStorage {
                    workspace_id,
                    name,
                    path: PathBuf::from(path),
                    snapshot_version: 0,
                    root: None,
                    measurement: default_storage_measurement(),
                    quality: StorageQuality::Unavailable,
                    allocated_bytes: 0,
                    logical_bytes: 0,
                    regenerable_bytes: 0,
                    agent_asset_bytes: 0,
                    file_count: 0,
                    directory_count: 0,
                    breakdown: Vec::new(),
                    last_attempt_at: parse_time(&attempted_at)?,
                    last_success_at: None,
                    error_key: error_key.clone(),
                    error_detail: error_detail.clone(),
                }
            };
            value.last_attempt_at = parse_time(&attempted_at)?;
            value.last_success_at = success_at.as_deref().map(parse_time).transpose()?;
            if error_key.is_some() {
                if value.last_success_at.is_some() {
                    value.quality = StorageQuality::Partial;
                }
                value.error_key = error_key;
                value.error_detail = error_detail;
            }
            workspaces.push(value);
        }
        workspaces.sort_by(|left, right| {
            right
                .allocated_bytes
                .cmp(&left.allocated_bytes)
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(StorageOverview::from_workspaces(
            total_workspace_count,
            workspaces,
        ))
    }

    pub fn save_workspace_storage(&self, storage: &WorkspaceStorage) -> Result<()> {
        self.connection.execute(
            "INSERT INTO workspace_storage(workspace_id, snapshot_json, last_attempt_at, last_success_at, error_key, error_detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(workspace_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, error_key = excluded.error_key, error_detail = excluded.error_detail",
            params![
                storage.workspace_id,
                serde_json::to_string(storage)?,
                storage.last_attempt_at.to_rfc3339(),
                storage.last_success_at.map(|value| value.to_rfc3339()),
                storage.error_key,
                storage.error_detail,
            ],
        )?;
        Ok(())
    }

    pub fn record_workspace_storage_failure(
        &self,
        workspace_id: &str,
        attempted_at: DateTime<Utc>,
        error_key: &str,
        error_detail: Option<&str>,
    ) -> Result<()> {
        self.connection.execute(
            "INSERT INTO workspace_storage(workspace_id, snapshot_json, last_attempt_at, error_key, error_detail)
             VALUES (?1, NULL, ?2, ?3, ?4)
             ON CONFLICT(workspace_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, error_key = excluded.error_key, error_detail = excluded.error_detail",
            params![workspace_id, attempted_at.to_rfc3339(), error_key, error_detail],
        )?;
        Ok(())
    }

    pub fn save_quota_snapshot(&self, snapshot: &QuotaSnapshot) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        self.connection.execute(
            "INSERT INTO quota_snapshot(id, snapshot_json, backend, backend_version, generated_at, fetched_at, stale_after_seconds, last_attempt_at, last_success_at, error_key, error_detail)
             VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL, NULL)
             ON CONFLICT(id) DO UPDATE SET snapshot_json = excluded.snapshot_json, backend = excluded.backend, backend_version = excluded.backend_version, generated_at = excluded.generated_at, fetched_at = excluded.fetched_at, stale_after_seconds = excluded.stale_after_seconds, last_attempt_at = excluded.last_attempt_at, last_success_at = excluded.last_success_at, error_key = NULL, error_detail = NULL",
            params![
                serde_json::to_string(snapshot)?,
                enum_string(snapshot.backend)?,
                snapshot.backend_version,
                snapshot.generated_at.to_rfc3339(),
                snapshot.fetched_at.to_rfc3339(),
                to_i64(snapshot.stale_after_seconds),
                now,
            ],
        )?;
        Ok(())
    }

    pub fn record_quota_failure(
        &self,
        backend: QuotaBackend,
        error_key: &str,
        error_detail: Option<&str>,
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        let error_detail = error_detail.map(sanitize_diagnostic);
        self.connection.execute(
            "INSERT INTO quota_snapshot(id, backend, last_attempt_at, error_key, error_detail)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET backend = excluded.backend, last_attempt_at = excluded.last_attempt_at, error_key = excluded.error_key, error_detail = excluded.error_detail",
            params![enum_string(backend)?, now, error_key, error_detail],
        )?;
        Ok(())
    }

    pub fn quota_snapshot(&self) -> Result<Option<QuotaSnapshot>> {
        let value: Option<(Option<String>, Option<String>)> = self
            .connection
            .query_row(
                "SELECT snapshot_json, error_key FROM quota_snapshot WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        value
            .and_then(|(snapshot, error_key)| snapshot.map(|snapshot| (snapshot, error_key)))
            .map(|(value, error_key)| {
                let mut snapshot: QuotaSnapshot = serde_json::from_str(&value)?;
                snapshot.refresh_freshness(Utc::now());
                if error_key.is_some() {
                    snapshot.freshness = agentkib_quota::QuotaFreshness::Stale;
                }
                Ok(snapshot)
            })
            .transpose()
    }

    pub fn quota_collector_status(
        &self,
        backend: QuotaBackend,
        platform_supported: bool,
        sidecar_available: bool,
        config_source: String,
        running: bool,
    ) -> Result<QuotaCollectorStatus> {
        type StatusRow = (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let row: Option<StatusRow> = self
            .connection
            .query_row(
                "SELECT backend_version, last_attempt_at, last_success_at, error_key, error_detail FROM quota_snapshot WHERE id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .optional()?;
        let (backend_version, last_attempt_at, last_success_at, mut error_key, error_detail) =
            row.unwrap_or_default();
        if error_key.is_none() {
            error_key = if !platform_supported {
                Some("errors.quotaUnsupportedPlatform".to_string())
            } else if !sidecar_available {
                Some("errors.quotaSidecarMissing".to_string())
            } else {
                None
            };
        }
        Ok(QuotaCollectorStatus {
            backend,
            backend_version,
            platform_supported,
            sidecar_available,
            config_source,
            last_attempt_at: last_attempt_at
                .map(|value| parse_time(&value))
                .transpose()?,
            last_success_at: last_success_at
                .map(|value| parse_time(&value))
                .transpose()?,
            running,
            error_key,
            error_detail,
        })
    }

    pub fn insight_git_fingerprints(&self) -> Result<BTreeMap<String, String>> {
        let mut statement = self.connection.prepare(
            "SELECT substr(provider, 5), cursor_json FROM insight_cursors WHERE provider LIKE 'git:%' AND cursor_json IS NOT NULL",
        )?;
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<BTreeMap<_, _>>>()
            .map_err(Into::into)
    }

    pub fn insight_usage_cursors(&self) -> Result<BTreeMap<AgentKind, String>> {
        let mut statement = self.connection.prepare(
            "SELECT provider, cursor_json FROM insight_cursors WHERE provider NOT LIKE 'git:%' AND cursor_json IS NOT NULL",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut output = BTreeMap::new();
        for row in rows {
            let (agent, cursor) = row?;
            if let Some(agent) = parse_agent_kind(&agent) {
                output.insert(agent, cursor);
            }
        }
        Ok(output)
    }

    pub fn sync_insights(
        &self,
        usage_batches: &[UsageBatch],
        repositories: &[GitRepositorySnapshot],
    ) -> Result<()> {
        let salt = self.insight_salt()?;
        let workspace_paths = self.workspace_path_index()?;
        let transaction = self.connection.unchecked_transaction()?;
        let now = Utc::now().to_rfc3339();
        for batch in usage_batches {
            if batch.unchanged {
                continue;
            }
            let provider = enum_string(batch.status.agent)?;
            transaction.execute(
                "INSERT INTO insight_cursors(provider, cursor_json, available, quality, coverage_from, coverage_to, imported_events, error, error_key, error_params, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(provider) DO UPDATE SET cursor_json = excluded.cursor_json, available = excluded.available, quality = excluded.quality, coverage_from = excluded.coverage_from, coverage_to = excluded.coverage_to, imported_events = excluded.imported_events, error = excluded.error, error_key = excluded.error_key, error_params = excluded.error_params, updated_at = excluded.updated_at",
                params![
                    provider,
                    batch.cursor.as_ref().map(|value| value.value.as_str()),
                    batch.status.available,
                    enum_string(batch.status.quality)?,
                    batch.status.coverage_from.map(|value| value.to_string()),
                    batch.status.coverage_to.map(|value| value.to_string()),
                    to_i64(batch.status.imported_events as u64),
                    batch.status.error,
                    batch.status.error_key,
                    serde_json::to_string(&batch.status.error_params)?,
                    now,
                ],
            )?;
            if batch.status.available {
                transaction.execute(
                    "DELETE FROM usage_events WHERE surface_agent = ?1",
                    params![provider],
                )?;
            }
            for event in &batch.events {
                let source_key = keyed_hash(&salt, event.source_key.as_bytes());
                let session_hash = event
                    .session_key
                    .as_ref()
                    .map(|value| keyed_hash(&salt, value.as_bytes()));
                let workspace_id = event
                    .workspace_path
                    .as_ref()
                    .and_then(|path| match_workspace(path, &workspace_paths));
                if !matches!(
                    event.date_precision,
                    agentkib_insights::DatePrecision::Aggregate
                ) && let Some(session_hash) = session_hash.as_deref()
                {
                    transaction.execute(
                        "DELETE FROM usage_events WHERE session_hash = ?1 AND date_precision = 'aggregate'",
                        params![session_hash],
                    )?;
                }
                transaction.execute(
                    "INSERT INTO usage_events(source_key, surface_agent, workspace_id, occurred_at, day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, session_hash, session_count, date_precision, quality)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                     ON CONFLICT(source_key) DO UPDATE SET workspace_id = excluded.workspace_id, occurred_at = excluded.occurred_at, day = excluded.day, model = excluded.model, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens, reasoning_tokens = excluded.reasoning_tokens, total_tokens = excluded.total_tokens, session_hash = excluded.session_hash, session_count = excluded.session_count, date_precision = excluded.date_precision, quality = excluded.quality",
                    params![
                        source_key,
                        enum_string(event.surface_agent)?,
                        workspace_id,
                        event.occurred_at.map(|value| value.to_rfc3339()),
                        event.day.map(|value| value.to_string()),
                        event.model,
                        to_i64(event.input_tokens),
                        to_i64(event.output_tokens),
                        to_i64(event.cache_read_tokens),
                        to_i64(event.cache_write_tokens),
                        to_i64(event.reasoning_tokens),
                        to_i64(event.total_tokens),
                        session_hash,
                        to_i64(event.session_count),
                        enum_string(event.date_precision)?,
                        enum_string(event.quality)?,
                    ],
                )?;
            }
        }

        for repository in repositories {
            let provider = format!("git:{}", repository.repository_group_id);
            if let Some(error) = &repository.error {
                transaction.execute(
                    "INSERT INTO insight_cursors(provider, available, quality, imported_events, error, error_key, error_params, updated_at) VALUES (?1, 0, 'incomplete', 0, ?2, 'errors.providerUnavailable', '{}', ?3)
                     ON CONFLICT(provider) DO UPDATE SET available = 0, quality = 'incomplete', error = excluded.error, error_key = excluded.error_key, error_params = excluded.error_params, updated_at = excluded.updated_at",
                    params![provider, error, now],
                )?;
                continue;
            }
            for identity in &repository.identities {
                let identity_hash =
                    keyed_hash(&salt, identity.email.trim().to_ascii_lowercase().as_bytes());
                transaction.execute(
                    "INSERT INTO git_identities(id, identity_hash, source, label, enabled, created_at) VALUES (?1, ?1, ?2, ?3, 1, ?4)
                     ON CONFLICT(identity_hash) DO UPDATE SET source = excluded.source, label = excluded.label",
                    params![identity_hash, identity.source, identity.label, now],
                )?;
            }
            if repository.changed {
                transaction.execute(
                    "DELETE FROM commit_attributions WHERE repository_group_id = ?1",
                    params![repository.repository_group_id],
                )?;
                transaction.execute(
                    "DELETE FROM git_commits WHERE repository_group_id = ?1",
                    params![repository.repository_group_id],
                )?;
                for commit in &repository.commits {
                    let identity_hash = keyed_hash(
                        &salt,
                        commit.author_email.trim().to_ascii_lowercase().as_bytes(),
                    );
                    transaction.execute(
                        "INSERT INTO git_commits(repository_group_id, commit_hash, authored_at, day, author_identity_hash, is_mine)
                         VALUES (?1, ?2, ?3, ?4, ?5, EXISTS(SELECT 1 FROM git_identities WHERE identity_hash = ?5 AND enabled = 1))",
                        params![
                            repository.repository_group_id,
                            commit.hash,
                            commit.authored_at.to_rfc3339(),
                            commit.authored_at.with_timezone(&Local).date_naive().to_string(),
                            identity_hash,
                        ],
                    )?;
                }
            }
            transaction.execute(
                "INSERT INTO insight_cursors(provider, cursor_json, available, quality, imported_events, error, updated_at)
                 VALUES (?1, ?2, 1, 'exact', ?3, NULL, ?4)
                 ON CONFLICT(provider) DO UPDATE SET cursor_json = excluded.cursor_json, available = 1, quality = 'exact', imported_events = excluded.imported_events, error = NULL, updated_at = excluded.updated_at",
                params![provider, repository.fingerprint, to_i64(repository.commits.len() as u64), now],
            )?;
        }
        let changed_providers = usage_batches
            .iter()
            .filter(|batch| {
                !batch.unchanged && (batch.status.available || !batch.events.is_empty())
            })
            .map(|batch| enum_string(batch.status.agent))
            .collect::<Result<BTreeSet<_>>>()?;
        for provider in &changed_providers {
            rebuild_provider_usage_daily(&transaction, provider)?;
        }
        let git_changed = repositories
            .iter()
            .any(|repository| repository.changed && repository.error.is_none());
        // Identity discovery can change without a new commit (e.g. git user.email).
        // Reclassify only affected rows so an unchanged refresh performs no writes here.
        let identities_changed = transaction.execute(
            "UPDATE git_commits SET is_mine = EXISTS(SELECT 1 FROM git_identities WHERE identity_hash = git_commits.author_identity_hash AND enabled = 1)
             WHERE is_mine != EXISTS(SELECT 1 FROM git_identities WHERE identity_hash = git_commits.author_identity_hash AND enabled = 1)",
            [],
        )? > 0;
        if git_changed || identities_changed || !changed_providers.is_empty() {
            rebuild_commit_attributions(&transaction)?;
        }
        transaction.execute(
            "INSERT INTO audit_events(id, project_id, action, detail, created_at) VALUES (?1, NULL, 'insights.refresh', ?2, ?3)",
            params![
                Uuid::new_v4().to_string(),
                format!("{} providers, {} repositories", usage_batches.len(), repositories.len()),
                now,
            ],
        )?;
        transaction.commit()?;
        if git_changed || identities_changed || !changed_providers.is_empty() {
            self.refresh_achievement_unlocks()?;
        }
        Ok(())
    }

    pub fn insights_summary(&self, query: &InsightsQuery) -> Result<InsightsSummary> {
        let (from, to, agent, workspace, repository) = query_values(&self.connection, query)?;
        let usage = self.connection.query_row(
            "SELECT COALESCE(SUM(u.total_tokens), 0), COALESCE(SUM(u.input_tokens), 0), COALESCE(SUM(u.output_tokens), 0), COALESCE(SUM(u.cache_read_tokens + u.cache_write_tokens), 0), COALESCE(SUM(u.reasoning_tokens), 0), COALESCE(SUM(u.session_count), 0)
             FROM usage_events u LEFT JOIN workspaces w ON w.id = u.workspace_id
             WHERE (?1 IS NULL OR u.day >= ?1) AND (?2 IS NULL OR u.day <= ?2) AND (?3 IS NULL OR u.surface_agent = ?3) AND (?4 IS NULL OR u.workspace_id = ?4) AND (?5 IS NULL OR w.repository_group_id = ?5)",
            params![from, to, agent, workspace, repository],
            |row| Ok((as_u64(row, 0)?, as_u64(row, 1)?, as_u64(row, 2)?, as_u64(row, 3)?, as_u64(row, 4)?, as_u64(row, 5)?)),
        )?;
        let commits = self.connection.query_row(
            "SELECT COALESCE(SUM(is_mine), 0), COUNT(*), COALESCE(SUM(EXISTS(SELECT 1 FROM commit_attributions a WHERE a.repository_group_id = c.repository_group_id AND a.commit_hash = c.commit_hash AND a.confidence = 'exact' AND (?4 IS NULL OR a.agent = ?4))), 0)
             FROM git_commits c WHERE (?1 IS NULL OR c.day >= ?1) AND (?2 IS NULL OR c.day <= ?2) AND (?3 IS NULL OR c.repository_group_id = ?3)",
            params![from, to, repository, agent],
            |row| Ok((as_u64(row, 0)?, as_u64(row, 1)?, as_u64(row, 2)?)),
        )?;
        let active = self.insight_active_dates(query)?;
        let (current_streak, longest_streak) =
            calculate_streaks(&active, Local::now().date_naive());
        let coverage_from = active.first().copied();
        let coverage_to = active.last().copied();
        let statuses = self.insights_status(false)?;
        let installed = self.installed_agents()?;
        let relevant: Vec<_> = statuses
            .providers
            .iter()
            .filter(|status| {
                query.agent.is_none_or(|agent| agent == status.agent)
                    && (status.available || installed.contains(&status.agent))
            })
            .collect();
        let quality = if relevant.is_empty()
            || relevant
                .iter()
                .any(|status| !status.available || status.quality == UsageQuality::Incomplete)
        {
            UsageQuality::Incomplete
        } else if relevant
            .iter()
            .any(|status| status.quality == UsageQuality::Estimated)
        {
            UsageQuality::Estimated
        } else {
            UsageQuality::Exact
        };
        Ok(InsightsSummary {
            total_tokens: usage.0,
            input_tokens: usage.1,
            output_tokens: usage.2,
            cache_tokens: usage.3,
            reasoning_tokens: usage.4,
            session_count: usage.5,
            my_commits: commits.0,
            all_commits: commits.1,
            attributed_commits: commits.2,
            active_days: active.len() as u64,
            current_streak,
            longest_streak,
            quality,
            coverage_from,
            coverage_to,
            refreshed_at: statuses.refreshed_at,
        })
    }

    pub fn insights_heatmap(&self, query: &InsightsQuery) -> Result<Vec<HeatmapPoint>> {
        let today = Local::now().date_naive();
        let from_day = query
            .from
            .unwrap_or_else(|| today.checked_sub_days(Days::new(363)).unwrap_or(today));
        let to_day = query.to.unwrap_or(today);
        let (_, _, agent, workspace, repository) = query_values(&self.connection, query)?;
        let mut output = BTreeMap::new();
        let mut day = from_day;
        while day <= to_day {
            output.insert(
                day,
                HeatmapPoint {
                    date: day,
                    tokens: 0,
                    my_commits: 0,
                    all_commits: 0,
                    attributed_commits: 0,
                    sessions: 0,
                    quality: UsageQuality::Exact,
                },
            );
            let Some(next) = day.succ_opt() else { break };
            day = next;
        }
        let mut usage_statement = self.connection.prepare(
            "SELECT d.day, SUM(d.total_tokens), SUM(d.session_count), MAX(CASE d.quality WHEN 'incomplete' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END)
             FROM usage_daily d LEFT JOIN workspaces w ON w.id = NULLIF(d.workspace_id, '')
             WHERE d.day >= ?1 AND d.day <= ?2 AND (?3 IS NULL OR d.surface_agent = ?3) AND (?4 IS NULL OR d.workspace_id = ?4) AND (?5 IS NULL OR w.repository_group_id = ?5)
             GROUP BY d.day",
        )?;
        let usage_rows = usage_statement.query_map(
            params![
                from_day.to_string(),
                to_day.to_string(),
                agent,
                workspace,
                repository
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    as_u64(row, 1)?,
                    as_u64(row, 2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )?;
        for row in usage_rows {
            let (date, tokens, sessions, quality) = row?;
            if let Ok(date) = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                && let Some(point) = output.get_mut(&date)
            {
                point.tokens = tokens;
                point.sessions = sessions;
                point.quality = match quality {
                    2 => UsageQuality::Incomplete,
                    1 => UsageQuality::Estimated,
                    _ => UsageQuality::Exact,
                };
            }
        }
        let mut commit_statement = self.connection.prepare(
            "SELECT c.day, SUM(c.is_mine), COUNT(*), SUM(EXISTS(SELECT 1 FROM commit_attributions a WHERE a.repository_group_id = c.repository_group_id AND a.commit_hash = c.commit_hash AND a.confidence = 'exact' AND (?4 IS NULL OR a.agent = ?4)))
             FROM git_commits c WHERE c.day >= ?1 AND c.day <= ?2 AND (?3 IS NULL OR c.repository_group_id = ?3) GROUP BY c.day",
        )?;
        let commit_rows = commit_statement.query_map(
            params![from_day.to_string(), to_day.to_string(), repository, agent],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    as_u64(row, 1)?,
                    as_u64(row, 2)?,
                    as_u64(row, 3)?,
                ))
            },
        )?;
        for row in commit_rows {
            let (date, mine, all, attributed) = row?;
            if let Ok(date) = NaiveDate::parse_from_str(&date, "%Y-%m-%d")
                && let Some(point) = output.get_mut(&date)
            {
                point.my_commits = mine;
                point.all_commits = all;
                point.attributed_commits = attributed;
            }
        }
        Ok(output.into_values().collect())
    }

    pub fn agent_usage_breakdown(&self, query: &InsightsQuery) -> Result<Vec<AgentUsageBreakdown>> {
        let (from, to, _, workspace, repository) = query_values(&self.connection, query)?;
        let mut statement = self.connection.prepare(
            "SELECT u.surface_agent, SUM(u.total_tokens), SUM(u.input_tokens), SUM(u.output_tokens), SUM(u.cache_read_tokens + u.cache_write_tokens), SUM(u.reasoning_tokens), SUM(u.session_count), MAX(CASE u.quality WHEN 'incomplete' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END)
             FROM usage_events u LEFT JOIN workspaces w ON w.id = u.workspace_id
             WHERE (?1 IS NULL OR u.day >= ?1) AND (?2 IS NULL OR u.day <= ?2) AND (?3 IS NULL OR u.workspace_id = ?3) AND (?4 IS NULL OR w.repository_group_id = ?4)
             GROUP BY u.surface_agent ORDER BY SUM(u.total_tokens) DESC",
        )?;
        let rows = statement.query_map(params![from, to, workspace, repository], |row| {
            let quality: i64 = row.get(7)?;
            Ok(AgentUsageBreakdown {
                agent: parse_enum(&row.get::<_, String>(0)?).map_err(sql_error)?,
                total_tokens: as_u64(row, 1)?,
                input_tokens: as_u64(row, 2)?,
                output_tokens: as_u64(row, 3)?,
                cache_tokens: as_u64(row, 4)?,
                reasoning_tokens: as_u64(row, 5)?,
                session_count: as_u64(row, 6)?,
                quality: match quality {
                    2 => UsageQuality::Incomplete,
                    1 => UsageQuality::Estimated,
                    _ => UsageQuality::Exact,
                },
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn model_usage_breakdown(&self, query: &InsightsQuery) -> Result<Vec<ModelUsageBreakdown>> {
        let (from, to, agent, workspace, repository) = query_values(&self.connection, query)?;
        let mut statement = self.connection.prepare(
            "SELECT COALESCE(NULLIF(u.model, ''), '__unknown_model__'), SUM(u.total_tokens), SUM(u.session_count)
             FROM usage_events u LEFT JOIN workspaces w ON w.id = u.workspace_id
             WHERE (?1 IS NULL OR u.day >= ?1) AND (?2 IS NULL OR u.day <= ?2) AND (?3 IS NULL OR u.surface_agent = ?3) AND (?4 IS NULL OR u.workspace_id = ?4) AND (?5 IS NULL OR w.repository_group_id = ?5)
             GROUP BY COALESCE(NULLIF(u.model, ''), '__unknown_model__') HAVING SUM(u.total_tokens) > 0 ORDER BY SUM(u.total_tokens) DESC LIMIT 20",
        )?;
        let rows = statement.query_map(params![from, to, agent, workspace, repository], |row| {
            Ok(ModelUsageBreakdown {
                model: row.get(0)?,
                total_tokens: as_u64(row, 1)?,
                session_count: as_u64(row, 2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn workspace_usage_breakdown(
        &self,
        query: &InsightsQuery,
    ) -> Result<Vec<WorkspaceUsageBreakdown>> {
        let (from, to, agent, workspace, repository) = query_values(&self.connection, query)?;
        let mut statement = self.connection.prepare(
            "SELECT u.workspace_id, COALESCE(w.name, '__unlinked_workspace__'), SUM(u.total_tokens), SUM(u.session_count)
             FROM usage_events u LEFT JOIN workspaces w ON w.id = u.workspace_id
             WHERE (?1 IS NULL OR u.day >= ?1) AND (?2 IS NULL OR u.day <= ?2) AND (?3 IS NULL OR u.surface_agent = ?3) AND (?4 IS NULL OR u.workspace_id = ?4) AND (?5 IS NULL OR w.repository_group_id = ?5)
             GROUP BY u.workspace_id, COALESCE(w.name, '__unlinked_workspace__') HAVING SUM(u.total_tokens) > 0 OR SUM(u.session_count) > 0 ORDER BY SUM(u.total_tokens) DESC LIMIT 20",
        )?;
        let rows = statement.query_map(params![from, to, agent, workspace, repository], |row| {
            Ok(WorkspaceUsageBreakdown {
                workspace_id: row.get(0)?,
                name: row.get(1)?,
                total_tokens: as_u64(row, 2)?,
                session_count: as_u64(row, 3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn insight_active_dates(&self, query: &InsightsQuery) -> Result<BTreeSet<NaiveDate>> {
        let (from, to, agent, workspace, repository) = query_values(&self.connection, query)?;
        let mut active = BTreeSet::new();
        let mut usage_statement = self.connection.prepare(
            "SELECT DISTINCT d.day FROM usage_daily d LEFT JOIN workspaces w ON w.id = NULLIF(d.workspace_id, '')
             WHERE (d.total_tokens > 0 OR d.session_count > 0) AND (?1 IS NULL OR d.day >= ?1) AND (?2 IS NULL OR d.day <= ?2) AND (?3 IS NULL OR d.surface_agent = ?3) AND (?4 IS NULL OR d.workspace_id = ?4) AND (?5 IS NULL OR w.repository_group_id = ?5)",
        )?;
        let rows = usage_statement
            .query_map(params![from, to, agent, workspace, repository], |row| {
                row.get::<_, String>(0)
            })?;
        for row in rows {
            active.insert(NaiveDate::parse_from_str(&row?, "%Y-%m-%d")?);
        }
        let mut commit_statement = self.connection.prepare(
            "SELECT DISTINCT c.day FROM git_commits c WHERE c.is_mine = 1 AND (?1 IS NULL OR c.day >= ?1) AND (?2 IS NULL OR c.day <= ?2) AND (?3 IS NULL OR c.repository_group_id = ?3) AND (?4 IS NULL OR EXISTS(SELECT 1 FROM commit_attributions a WHERE a.repository_group_id = c.repository_group_id AND a.commit_hash = c.commit_hash AND a.agent = ?4 AND a.confidence = 'exact'))",
        )?;
        let rows = commit_statement.query_map(params![from, to, repository, agent], |row| {
            row.get::<_, String>(0)
        })?;
        for row in rows {
            active.insert(NaiveDate::parse_from_str(&row?, "%Y-%m-%d")?);
        }
        Ok(active)
    }

    pub fn repository_commit_breakdown(
        &self,
        query: &InsightsQuery,
    ) -> Result<Vec<RepositoryCommitBreakdown>> {
        let (from, to, _, _, repository) = query_values(&self.connection, query)?;
        let mut statement = self.connection.prepare(
            "SELECT c.repository_group_id, COALESCE((SELECT MIN(w.name) FROM workspaces w WHERE w.repository_group_id = c.repository_group_id), 'Repository'), SUM(c.is_mine), COUNT(*), SUM(EXISTS(SELECT 1 FROM commit_attributions a WHERE a.repository_group_id = c.repository_group_id AND a.commit_hash = c.commit_hash AND a.confidence = 'exact'))
             FROM git_commits c
             WHERE (?1 IS NULL OR c.day >= ?1) AND (?2 IS NULL OR c.day <= ?2) AND (?3 IS NULL OR c.repository_group_id = ?3)
             GROUP BY c.repository_group_id ORDER BY SUM(c.is_mine) DESC",
        )?;
        let rows = statement.query_map(params![from, to, repository], |row| {
            Ok(RepositoryCommitBreakdown {
                repository_group_id: row.get(0)?,
                name: row.get(1)?,
                my_commits: as_u64(row, 2)?,
                all_commits: as_u64(row, 3)?,
                attributed_commits: as_u64(row, 4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn list_achievements(&self) -> Result<Vec<Achievement>> {
        let summary = self.insights_summary(&InsightsQuery::default())?;
        let agent_count = self
            .agent_usage_breakdown(&InsightsQuery::default())?
            .into_iter()
            .filter(|value| value.total_tokens > 0 || value.session_count > 0)
            .count() as u64;
        let mut definitions =
            achievement_definitions(&summary, agent_count, self.active_workspace_count()?);
        definitions.extend(special_achievement_definitions());
        let mut statement = self
            .connection
            .prepare("SELECT unlocked_at, rule_version FROM achievement_unlocks WHERE code = ?1")?;
        definitions
            .into_iter()
            .map(|mut value| {
                let unlocked: Option<(String, i64)> = statement
                    .query_row(params![value.code], |row| Ok((row.get(0)?, row.get(1)?)))
                    .optional()?;
                if let Some((unlocked_at, rule_version)) = unlocked {
                    value.progress = value.progress.max(value.threshold);
                    if rule_version > 0 {
                        value.unlocked_at = Some(parse_time(&unlocked_at)?);
                    }
                }
                Ok(value)
            })
            .collect()
    }

    pub fn insights_status(&self, running: bool) -> Result<InsightsStatus> {
        let mut statement = self.connection.prepare(
            "SELECT provider, available, quality, coverage_from, coverage_to, imported_events, error, error_key, error_params, updated_at FROM insight_cursors WHERE provider NOT LIKE 'git:%' ORDER BY provider",
        )?;
        let rows = statement.query_map([], |row| {
            let provider: String = row.get(0)?;
            let Some(agent) = parse_agent_kind(&provider) else {
                return Ok(None);
            };
            Ok(Some((
                ProviderStatus {
                    agent,
                    available: row.get(1)?,
                    quality: parse_enum(&row.get::<_, String>(2)?).map_err(sql_error)?,
                    coverage_from: row
                        .get::<_, Option<String>>(3)?
                        .map(|value| NaiveDate::parse_from_str(&value, "%Y-%m-%d"))
                        .transpose()
                        .map_err(|error| sql_error(error.into()))?,
                    coverage_to: row
                        .get::<_, Option<String>>(4)?
                        .map(|value| NaiveDate::parse_from_str(&value, "%Y-%m-%d"))
                        .transpose()
                        .map_err(|error| sql_error(error.into()))?,
                    imported_events: row.get::<_, i64>(5)?.max(0) as usize,
                    error: row.get(6)?,
                    error_key: row.get(7)?,
                    error_params: serde_json::from_str(&row.get::<_, String>(8)?)
                        .map_err(|error| sql_error(error.into()))?,
                },
                row.get::<_, String>(9)?,
            )))
        })?;
        let mut providers = Vec::new();
        let mut refreshed_at = None;
        for row in rows {
            let Some((status, updated)) = row? else {
                continue;
            };
            let updated = parse_time(&updated)?;
            refreshed_at =
                Some(refreshed_at.map_or(updated, |current: DateTime<Utc>| current.max(updated)));
            providers.push(status);
        }
        for agent in AgentKind::ALL {
            if !providers.iter().any(|status| status.agent == agent) {
                providers.push(ProviderStatus {
                    agent,
                    available: false,
                    quality: UsageQuality::Incomplete,
                    coverage_from: None,
                    coverage_to: None,
                    imported_events: 0,
                    error_key: None,
                    error_params: BTreeMap::new(),
                    error: None,
                });
            }
        }
        providers.sort_by_key(|status| status.agent);
        Ok(InsightsStatus {
            providers,
            refreshed_at,
            running,
        })
    }

    pub fn list_git_identities(&self) -> Result<Vec<GitIdentitySummary>> {
        let mut statement = self.connection.prepare(
            "SELECT id, label, source, enabled FROM git_identities ORDER BY source, label",
        )?;
        let rows = statement.query_map([], |row| {
            Ok(GitIdentitySummary {
                id: row.get(0)?,
                label: row.get(1)?,
                source: row.get(2)?,
                enabled: row.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn add_git_identity_alias(&self, email: &str) -> Result<GitIdentitySummary> {
        let email = email.trim().to_ascii_lowercase();
        if !email.contains('@') || email.len() > 320 {
            bail!("Enter a valid Git email address");
        }
        let id = keyed_hash(&self.insight_salt()?, email.as_bytes());
        self.connection.execute(
            "INSERT INTO git_identities(id, identity_hash, source, label, enabled, created_at) VALUES (?1, ?1, 'manual', 'settings.gitIdentityAlias', 1, ?2) ON CONFLICT(identity_hash) DO UPDATE SET enabled = 1",
            params![id, Utc::now().to_rfc3339()],
        )?;
        self.recompute_mine_flags()?;
        self.list_git_identities()?
            .into_iter()
            .find(|value| value.id == id)
            .context("Git identity could not be saved")
    }

    pub fn set_git_identity_enabled(&self, id: &str, enabled: bool) -> Result<()> {
        if self.connection.execute(
            "UPDATE git_identities SET enabled = ?1 WHERE id = ?2",
            params![enabled, id],
        )? == 0
        {
            bail!("Git identity does not exist");
        }
        self.recompute_mine_flags()?;
        Ok(())
    }

    fn recompute_mine_flags(&self) -> Result<()> {
        self.connection.execute("UPDATE git_commits SET is_mine = EXISTS(SELECT 1 FROM git_identities WHERE identity_hash = git_commits.author_identity_hash AND enabled = 1)", [])?;
        Ok(())
    }

    fn insight_salt(&self) -> Result<String> {
        if let Some(value) = self
            .connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'insights_salt'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(value);
        }
        let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('insights_salt', ?1)",
            params![value],
        )?;
        self.connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'insights_salt'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    fn conversation_salt(&self) -> Result<String> {
        if let Some(value) = self
            .connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'conversation_salt'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(value);
        }
        let value = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        self.connection.execute(
            "INSERT OR IGNORE INTO schema_meta(key, value) VALUES ('conversation_salt', ?1)",
            params![value],
        )?;
        self.connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'conversation_salt'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
    }

    fn workspace_path_index(&self) -> Result<Vec<(PathBuf, String)>> {
        let mut statement = self.connection.prepare(
            "SELECT canonical_path, id FROM workspaces ORDER BY length(canonical_path) DESC",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((PathBuf::from(row.get::<_, String>(0)?), row.get(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn installed_agents(&self) -> Result<BTreeSet<AgentKind>> {
        let mut statement = self
            .connection
            .prepare("SELECT agent FROM agent_installations WHERE installed = 1")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut output = BTreeSet::new();
        for row in rows {
            output.insert(parse_enum(&row?)?);
        }
        Ok(output)
    }

    fn active_workspace_count(&self) -> Result<u64> {
        self.connection
            .query_row(
                "SELECT COUNT(DISTINCT workspace_id) FROM usage_events WHERE workspace_id IS NOT NULL AND workspace_id != '' AND (total_tokens > 0 OR session_count > 0)",
                [],
                |row| as_u64(row, 0),
            )
            .map_err(Into::into)
    }

    fn refresh_achievement_unlocks(&self) -> Result<()> {
        let summary = self.insights_summary(&InsightsQuery::default())?;
        let agent_count = self
            .agent_usage_breakdown(&InsightsQuery::default())?
            .into_iter()
            .filter(|value| value.total_tokens > 0 || value.session_count > 0)
            .count() as u64;
        for achievement in
            achievement_definitions(&summary, agent_count, self.active_workspace_count()?)
        {
            if achievement.progress >= achievement.threshold {
                let unlocked_at = self
                    .achievement_unlock_day(&achievement.category, achievement.threshold)?
                    .and_then(|day| day.and_hms_opt(0, 0, 0))
                    .map(|value| Utc.from_utc_datetime(&value));
                self.record_achievement_unlock(&achievement.code, unlocked_at)?;
            }
        }
        for (code, unlocked_at) in self.special_achievement_unlocks()? {
            self.record_achievement_unlock(code, Some(unlocked_at))?;
        }
        Ok(())
    }

    pub fn unlock_special_achievement(&self, code: &str, unlocked_at: DateTime<Utc>) -> Result<()> {
        if !SPECIAL_ACHIEVEMENT_CODES.contains(&code) {
            bail!("Unknown special achievement code");
        }
        self.record_achievement_unlock(code, Some(unlocked_at))
    }

    fn record_achievement_unlock(
        &self,
        code: &str,
        unlocked_at: Option<DateTime<Utc>>,
    ) -> Result<()> {
        let (stored_at, rule_version) = unlocked_at
            .map(|value| (value, 1_i64))
            .unwrap_or_else(|| (Utc::now(), 0));
        self.connection.execute(
            "INSERT INTO achievement_unlocks(code, unlocked_at, rule_version) VALUES (?1, ?2, ?3)
             ON CONFLICT(code) DO UPDATE SET unlocked_at = excluded.unlocked_at, rule_version = excluded.rule_version
             WHERE achievement_unlocks.rule_version = 0 AND excluded.rule_version > 0",
            params![code, stored_at.to_rfc3339(), rule_version],
        )?;
        Ok(())
    }

    fn achievement_unlock_day(&self, category: &str, threshold: u64) -> Result<Option<NaiveDate>> {
        let mut daily = Vec::<(NaiveDate, u64)>::new();
        match category {
            "token" => {
                let mut statement = self.connection.prepare(
                    "SELECT day, SUM(total_tokens) FROM usage_daily GROUP BY day ORDER BY day",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, as_u64(row, 1)?)))?;
                for row in rows {
                    let (day, value) = row?;
                    daily.push((NaiveDate::parse_from_str(&day, "%Y-%m-%d")?, value));
                }
            }
            "session" => {
                let mut statement = self.connection.prepare(
                    "SELECT day, SUM(session_count) FROM usage_daily GROUP BY day ORDER BY day",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, as_u64(row, 1)?)))?;
                for row in rows {
                    let (day, value) = row?;
                    daily.push((NaiveDate::parse_from_str(&day, "%Y-%m-%d")?, value));
                }
            }
            "commit" => {
                let mut statement = self.connection.prepare(
                    "SELECT day, SUM(is_mine) FROM git_commits GROUP BY day ORDER BY day",
                )?;
                let rows = statement
                    .query_map([], |row| Ok((row.get::<_, String>(0)?, as_u64(row, 1)?)))?;
                for row in rows {
                    let (day, value) = row?;
                    daily.push((NaiveDate::parse_from_str(&day, "%Y-%m-%d")?, value));
                }
            }
            "streak" => {
                let active = self.insight_active_dates(&InsightsQuery::default())?;
                let mut run = 0;
                let mut previous = None;
                for day in active {
                    run = if previous.is_some_and(|value: NaiveDate| value.succ_opt() == Some(day))
                    {
                        run + 1
                    } else {
                        1
                    };
                    if run >= threshold {
                        return Ok(Some(day));
                    }
                    previous = Some(day);
                }
                return Ok(None);
            }
            "active-days" => {
                let active = self.insight_active_dates(&InsightsQuery::default())?;
                return Ok(active
                    .iter()
                    .nth(threshold.saturating_sub(1) as usize)
                    .copied());
            }
            "workspaces" => {
                let mut statement = self.connection.prepare(
                    "SELECT day, workspace_id FROM usage_daily WHERE workspace_id != '' AND (total_tokens > 0 OR session_count > 0) ORDER BY day, workspace_id",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                let mut seen = BTreeSet::new();
                for row in rows {
                    let (day, workspace_id) = row?;
                    seen.insert(workspace_id);
                    if seen.len() as u64 >= threshold {
                        return Ok(Some(NaiveDate::parse_from_str(&day, "%Y-%m-%d")?));
                    }
                }
                return Ok(None);
            }
            "agents" => {
                let mut statement = self.connection.prepare("SELECT MIN(day) FROM usage_daily WHERE total_tokens > 0 OR session_count > 0 GROUP BY surface_agent ORDER BY MIN(day)")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                let days = rows.collect::<rusqlite::Result<Vec<_>>>()?;
                return days
                    .get(threshold.saturating_sub(1) as usize)
                    .map(|day| NaiveDate::parse_from_str(day, "%Y-%m-%d"))
                    .transpose()
                    .map_err(Into::into);
            }
            _ => return Ok(None),
        }
        let mut cumulative = 0_u64;
        for (day, value) in daily {
            cumulative = cumulative.saturating_add(value);
            if cumulative >= threshold {
                return Ok(Some(day));
            }
        }
        Ok(None)
    }

    fn special_achievement_unlocks(&self) -> Result<Vec<(&'static str, DateTime<Utc>)>> {
        let mut output = Vec::new();
        if let Some(value) = self.minimum_time(
            "SELECT MIN(created_at) FROM audit_events WHERE action = 'changeset.apply'",
        )? {
            output.push(("special-first-changeset", value));
        }
        if let Some(value) = self.minimum_time(
            "SELECT MIN(approved_at) FROM memories WHERE status = 'approved' AND approved_at IS NOT NULL",
        )? {
            output.push(("special-first-memory", value));
        }
        if let Some(day) = self.first_shared_workspace_day()? {
            output.push(("special-shared-workspace", utc_start_of_day(day)));
        }
        if let Some(value) = self.minimum_time(
            "SELECT MIN(c.authored_at) FROM commit_attributions a JOIN git_commits c ON c.repository_group_id = a.repository_group_id AND c.commit_hash = a.commit_hash WHERE a.confidence = 'exact'",
        )? {
            output.push(("special-exact-attribution", value));
        }
        if let Some(value) = self.first_night_owl_activity()? {
            output.push(("special-night-owl", value));
        }
        if let Some(day) = self.first_comeback_day()? {
            output.push(("special-comeback", utc_start_of_day(day)));
        }
        if let Some(day) = self.first_same_day_delivery()? {
            output.push(("special-same-day-delivery", utc_start_of_day(day)));
        }
        Ok(output)
    }

    fn minimum_time(&self, sql: &str) -> Result<Option<DateTime<Utc>>> {
        let value: Option<String> = self.connection.query_row(sql, [], |row| row.get(0))?;
        value.map(|value| parse_time(&value)).transpose()
    }

    fn first_shared_workspace_day(&self) -> Result<Option<NaiveDate>> {
        let mut statement = self.connection.prepare(
            "SELECT day, workspace_id, surface_agent FROM usage_daily WHERE workspace_id != '' AND (total_tokens > 0 OR session_count > 0) ORDER BY day, workspace_id, surface_agent",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut agents = BTreeMap::<String, BTreeSet<String>>::new();
        for row in rows {
            let (day, workspace_id, agent) = row?;
            let workspace_agents = agents.entry(workspace_id).or_default();
            workspace_agents.insert(agent);
            if workspace_agents.len() >= 2 {
                return Ok(Some(NaiveDate::parse_from_str(&day, "%Y-%m-%d")?));
            }
        }
        Ok(None)
    }

    fn first_night_owl_activity(&self) -> Result<Option<DateTime<Utc>>> {
        let mut statement = self.connection.prepare(
            "SELECT occurred_at FROM usage_events WHERE occurred_at IS NOT NULL AND date_precision = 'exact' AND (total_tokens > 0 OR session_count > 0) ORDER BY occurred_at",
        )?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        for row in rows {
            let occurred_at = parse_time(&row?)?;
            if occurred_at.with_timezone(&Local).hour() < 5 {
                return Ok(Some(occurred_at));
            }
        }
        Ok(None)
    }

    fn first_comeback_day(&self) -> Result<Option<NaiveDate>> {
        let active = self.insight_active_dates(&InsightsQuery::default())?;
        let mut previous = None;
        for day in active {
            if previous
                .is_some_and(|value: NaiveDate| day.signed_duration_since(value).num_days() >= 31)
            {
                return Ok(Some(day));
            }
            previous = Some(day);
        }
        Ok(None)
    }

    fn first_same_day_delivery(&self) -> Result<Option<NaiveDate>> {
        let value: Option<String> = self.connection.query_row(
            "SELECT MIN(d.day) FROM usage_daily d WHERE (d.total_tokens > 0 OR d.session_count > 0) AND EXISTS(SELECT 1 FROM git_commits c WHERE c.day = d.day AND c.is_mine = 1)",
            [],
            |row| row.get(0),
        )?;
        value
            .map(|value| NaiveDate::parse_from_str(&value, "%Y-%m-%d").map_err(Into::into))
            .transpose()
    }

    pub fn propose_memory(&self, proposal: &MemoryProposal) -> Result<MemoryRecord> {
        if proposal.content.trim().is_empty() {
            bail!("Memory content cannot be empty");
        }
        let record = MemoryRecord {
            id: Uuid::new_v4().to_string(),
            project_id: proposal.project_id.clone(),
            memory_type: proposal.memory_type,
            content: proposal.content.trim().to_string(),
            status: MemoryStatus::Pending,
            source_agent: proposal.source_agent.clone(),
            source_thread: proposal.source_thread.clone(),
            source_reference: proposal.source_reference.clone(),
            created_at: Utc::now(),
            approved_at: None,
            invalidated_by: None,
        };
        self.insert_memory(&record)?;
        self.audit(Some(&record.project_id), "memory.propose", &record.id)?;
        Ok(record)
    }

    pub fn propose(&self, proposal: &MemoryProposal) -> Result<MemoryRecord> {
        self.propose_memory(proposal)
    }

    pub fn list_memories(
        &self,
        project_id: &str,
        status: Option<MemoryStatus>,
    ) -> Result<Vec<MemoryRecord>> {
        let mut records = Vec::new();
        if let Some(status) = status {
            let mut statement = self.connection.prepare("SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE project_id = ?1 AND status = ?2 ORDER BY created_at DESC")?;
            let rows =
                statement.query_map(params![project_id, enum_string(status)?], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        } else {
            let mut statement = self.connection.prepare("SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE project_id = ?1 ORDER BY created_at DESC")?;
            let rows = statement.query_map(params![project_id], row_to_memory)?;
            for row in rows {
                records.push(row?);
            }
        }
        Ok(records)
    }

    pub fn list(
        &self,
        project_id: &str,
        status: Option<MemoryStatus>,
    ) -> Result<Vec<MemoryRecord>> {
        self.list_memories(project_id, status)
    }

    pub fn search_approved(
        &self,
        project_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryRecord>> {
        if query.trim().is_empty() {
            return Ok(self
                .list_memories(project_id, Some(MemoryStatus::Approved))?
                .into_iter()
                .take(limit)
                .collect());
        }
        let mut statement = self.connection.prepare(
            "SELECT m.id, m.project_id, m.memory_type, m.content, m.status, m.source_agent, m.source_thread, m.source_reference, m.created_at, m.approved_at, m.invalidated_by
             FROM memories_fts f JOIN memories m ON m.id = f.id
             WHERE f.project_id = ?1 AND memories_fts MATCH ?2 AND m.status = 'approved'
             ORDER BY rank LIMIT ?3"
        )?;
        let rows = statement.query_map(
            params![project_id, fts_query(query), limit as i64],
            row_to_memory,
        )?;
        let mut records = Vec::new();
        for row in rows {
            records.push(row?);
        }
        Ok(records)
    }

    pub fn search(&self, project_id: &str, query: &str, limit: usize) -> Result<Vec<MemoryRecord>> {
        self.search_approved(project_id, query, limit)
    }

    pub fn review_memory(
        &self,
        id: &str,
        status: MemoryStatus,
        edited_content: Option<&str>,
    ) -> Result<MemoryRecord> {
        if !matches!(
            status,
            MemoryStatus::Approved | MemoryStatus::Rejected | MemoryStatus::Invalidated
        ) {
            bail!("Review status must be approved, rejected, or invalidated");
        }
        let approved_at = matches!(status, MemoryStatus::Approved).then(|| Utc::now().to_rfc3339());
        if let Some(content) = edited_content {
            if content.trim().is_empty() {
                bail!("Memory content cannot be empty");
            }
            self.connection.execute(
                "UPDATE memories SET content = ?1, status = ?2, approved_at = ?3 WHERE id = ?4",
                params![content.trim(), enum_string(status)?, approved_at, id],
            )?;
        } else {
            self.connection.execute(
                "UPDATE memories SET status = ?1, approved_at = ?2 WHERE id = ?3",
                params![enum_string(status)?, approved_at, id],
            )?;
        }
        let record = self.get_memory(id)?.context("Memory does not exist")?;
        self.audit(
            Some(&record.project_id),
            "memory.review",
            &format!("{}:{}", id, enum_string(status)?),
        )?;
        Ok(record)
    }

    pub fn approve_memory(&self, id: &str, edited_content: Option<&str>) -> Result<MemoryRecord> {
        self.review_memory(id, MemoryStatus::Approved, edited_content)
    }

    pub fn audit(&self, project_id: Option<&str>, action: &str, detail: &str) -> Result<()> {
        let created_at = Utc::now();
        self.connection.execute("INSERT INTO audit_events(id, project_id, action, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![Uuid::new_v4().to_string(), project_id, action, detail, created_at.to_rfc3339()])?;
        if action == "changeset.apply" {
            self.unlock_special_achievement("special-first-changeset", created_at)?;
        } else if action == "memory.review" && detail.ends_with(":approved") {
            self.unlock_special_achievement("special-first-memory", created_at)?;
        }
        Ok(())
    }

    fn get_workspace_by_path(&self, path: &Path) -> Result<Option<WorkspaceSummary>> {
        let id = matching_workspace(&self.connection, path)?.map(|(id, _)| id);
        id.map(|id| self.get_workspace(&id))
            .transpose()
            .map(Option::flatten)
    }

    fn workspace_sources(&self, id: &str) -> Result<Vec<WorkspaceSource>> {
        let mut statement = self.connection.prepare(
            "SELECT agent, evidence, session_count, last_active_at, session_cwds FROM workspace_sources WHERE workspace_id = ?1 ORDER BY last_active_at DESC",
        )?;
        let rows = statement.query_map(params![id], |row| {
            let agent: String = row.get(0)?;
            let evidence: String = row.get(1)?;
            let session_cwds: String = row.get(4)?;
            let session_cwds: Vec<PathBuf> =
                serde_json::from_str(&session_cwds).map_err(|error| sql_error(error.into()))?;
            Ok(WorkspaceSource {
                agent: if agent.is_empty() {
                    None
                } else {
                    Some(parse_enum(&agent).map_err(sql_error)?)
                },
                evidence: parse_enum(&evidence).map_err(sql_error)?,
                session_count: row.get::<_, i64>(2)?.max(0) as u64,
                last_active_at: row_optional_time(row, 3)?,
                session_cwds: (!session_cwds.is_empty()).then_some(session_cwds),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn insert_memory(&self, record: &MemoryRecord) -> Result<()> {
        self.connection.execute(
            "INSERT INTO memories(id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![record.id, record.project_id, enum_string(record.memory_type)?, record.content, enum_string(record.status)?, record.source_agent, record.source_thread, record.source_reference, record.created_at.to_rfc3339(), record.approved_at.map(|v| v.to_rfc3339()), record.invalidated_by]
        )?;
        Ok(())
    }

    fn get_memory(&self, id: &str) -> Result<Option<MemoryRecord>> {
        self.connection.query_row(
            "SELECT id, project_id, memory_type, content, status, source_agent, source_thread, source_reference, created_at, approved_at, invalidated_by FROM memories WHERE id = ?1",
            params![id], row_to_memory,
        ).optional().map_err(Into::into)
    }
}

fn rebuild_provider_usage_daily(connection: &Connection, provider: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM usage_daily WHERE surface_agent = ?1",
        [provider],
    )?;
    connection.execute(
        "INSERT INTO usage_daily(day, surface_agent, workspace_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, session_count, quality)
         SELECT day, surface_agent, COALESCE(workspace_id, ''), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens), SUM(total_tokens), SUM(session_count),
                CASE MAX(CASE quality WHEN 'incomplete' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END) WHEN 2 THEN 'incomplete' WHEN 1 THEN 'estimated' ELSE 'exact' END
         FROM usage_events WHERE day IS NOT NULL AND date_precision != 'aggregate' AND surface_agent = ?1
         GROUP BY day, surface_agent, COALESCE(workspace_id, '')",
        [provider],
    )?;
    Ok(())
}

fn rebuild_commit_attributions(connection: &Connection) -> Result<()> {
    connection.execute(
        "DELETE FROM commit_attributions WHERE method = 'time-correlation'",
        [],
    )?;
    Ok(())
}

type InsightQueryValues = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

fn query_values(connection: &Connection, query: &InsightsQuery) -> Result<InsightQueryValues> {
    let repository = if query.repository_group_id.is_some() {
        query.repository_group_id.clone()
    } else if let Some(workspace_id) = &query.workspace_id {
        connection
            .query_row(
                "SELECT repository_group_id FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
    } else {
        None
    };
    Ok((
        query.from.map(|value| value.to_string()),
        query.to.map(|value| value.to_string()),
        query.agent.map(enum_string).transpose()?,
        query.workspace_id.clone(),
        repository,
    ))
}

fn match_workspace(path: &Path, workspaces: &[(PathBuf, String)]) -> Option<String> {
    let normalized = platform_path::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    workspaces
        .iter()
        .find(|(workspace, _)| platform_path::starts_with(&normalized, workspace))
        .map(|(_, id)| id.clone())
}

fn as_u64(row: &Row<'_>, index: usize) -> rusqlite::Result<u64> {
    Ok(row.get::<_, i64>(index)?.max(0) as u64)
}

fn to_i64(value: u64) -> i64 {
    value.min(i64::MAX as u64) as i64
}

// HMAC-SHA256 is kept local so identity and session matching never requires storing plaintext.
fn keyed_hash(key: &str, value: &[u8]) -> String {
    const BLOCK_SIZE: usize = 64;
    let mut key_block = [0_u8; BLOCK_SIZE];
    let key_bytes = key.as_bytes();
    if key_bytes.len() > BLOCK_SIZE {
        key_block[..32].copy_from_slice(&Sha256::digest(key_bytes));
    } else {
        key_block[..key_bytes.len()].copy_from_slice(key_bytes);
    }
    let mut inner_pad = [0x36_u8; BLOCK_SIZE];
    let mut outer_pad = [0x5c_u8; BLOCK_SIZE];
    for index in 0..BLOCK_SIZE {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(value);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_hash);
    hex::encode(outer.finalize())
}

fn conversation_identifier(key: &str, agent: AgentKind, native_ref: &str) -> String {
    keyed_hash(
        key,
        format!("conversation:{}:{native_ref}", agent.as_str()).as_bytes(),
    )
}

fn calculate_streaks(active: &BTreeSet<NaiveDate>, today: NaiveDate) -> (u64, u64) {
    let mut longest = 0_u64;
    let mut run = 0_u64;
    let mut previous = None;
    for day in active {
        if previous.is_some_and(|value: NaiveDate| value.succ_opt() == Some(*day)) {
            run += 1;
        } else {
            run = 1;
        }
        longest = longest.max(run);
        previous = Some(*day);
    }
    let yesterday = today.pred_opt();
    let mut cursor = if active.contains(&today) {
        Some(today)
    } else if yesterday.is_some_and(|value| active.contains(&value)) {
        yesterday
    } else {
        None
    };
    let mut current = 0;
    while let Some(day) = cursor {
        if !active.contains(&day) {
            break;
        }
        current += 1;
        cursor = day.pred_opt();
    }
    (current, longest)
}

const SPECIAL_ACHIEVEMENT_CODES: [&str; 8] = [
    "special-first-changeset",
    "special-first-memory",
    "special-shared-workspace",
    "special-exact-attribution",
    "special-remote-handshake",
    "special-night-owl",
    "special-comeback",
    "special-same-day-delivery",
];

fn achievement_definitions(
    summary: &InsightsSummary,
    agent_count: u64,
    active_workspace_count: u64,
) -> Vec<Achievement> {
    let mut output = Vec::new();
    for threshold in [
        100_000,
        1_000_000,
        10_000_000,
        100_000_000,
        1_000_000_000,
        10_000_000_000,
        100_000_000_000,
        1_000_000_000_000,
    ] {
        output.push(achievement("token", threshold, summary.total_tokens));
    }
    for threshold in [10, 50, 100, 500, 1_000, 5_000, 10_000] {
        output.push(achievement("session", threshold, summary.session_count));
    }
    for threshold in [1, 10, 100, 1_000, 5_000, 10_000] {
        output.push(achievement("commit", threshold, summary.my_commits));
    }
    for threshold in [7, 30, 100, 365, 1_000] {
        output.push(achievement("active-days", threshold, summary.active_days));
    }
    for threshold in [3, 7, 14, 30, 60, 100, 180, 365] {
        output.push(achievement("streak", threshold, summary.longest_streak));
    }
    for threshold in [1, 5, 10, 25, 50, 100] {
        output.push(achievement("workspaces", threshold, active_workspace_count));
    }
    for threshold in [1, 2, 3, 4, 5] {
        output.push(achievement("agents", threshold, agent_count));
    }
    output
}

fn special_achievement_definitions() -> Vec<Achievement> {
    SPECIAL_ACHIEVEMENT_CODES
        .into_iter()
        .map(|code| Achievement {
            code: code.into(),
            category: "special".into(),
            threshold: 1,
            progress: 0,
            unlocked_at: None,
        })
        .collect()
}

fn achievement(category: &str, threshold: u64, progress: u64) -> Achievement {
    Achievement {
        code: format!("{category}-{threshold}"),
        category: category.into(),
        threshold,
        progress,
        unlocked_at: None,
    }
}

fn utc_start_of_day(day: NaiveDate) -> DateTime<Utc> {
    Utc.from_utc_datetime(&day.and_hms_opt(0, 0, 0).expect("valid start of day"))
}

fn excluded_paths(connection: &Connection) -> Result<BTreeSet<String>> {
    let mut statement = connection.prepare("SELECT canonical_path FROM excluded_workspaces")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut output = BTreeSet::new();
    for row in rows {
        output.insert(platform_path::identity(Path::new(&row?)));
    }
    Ok(output)
}

fn known_agent_home_identities(connection: &Connection) -> Result<BTreeSet<String>> {
    let mut statement =
        connection.prepare("SELECT home FROM agent_installations WHERE home IS NOT NULL")?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    let mut output = BTreeSet::new();
    for row in rows {
        output.insert(platform_path::identity(Path::new(&row?)));
    }
    Ok(output)
}

fn matching_stored_path(
    connection: &Connection,
    table: &str,
    path: &Path,
) -> Result<Option<String>> {
    let sql = match table {
        "excluded_workspaces" => "SELECT canonical_path FROM excluded_workspaces",
        "scan_roots" => "SELECT canonical_path FROM scan_roots",
        _ => bail!("Unsupported path table: {table}"),
    };
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        let stored = row?;
        if platform_path::equivalent(Path::new(&stored), path) {
            return Ok(Some(stored));
        }
    }
    Ok(None)
}

fn matching_workspace(connection: &Connection, path: &Path) -> Result<Option<(String, String)>> {
    let mut statement = connection.prepare("SELECT id, canonical_path FROM workspaces")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, stored) = row?;
        if platform_path::equivalent(Path::new(&stored), path) {
            return Ok(Some((id, stored)));
        }
    }
    Ok(None)
}

fn upsert_workspace(
    connection: &Connection,
    path: &Path,
    sources: &[&DiscoveryCandidate],
) -> Result<String> {
    let existing = matching_workspace(connection, path)?;
    let path_text = existing
        .as_ref()
        .map(|(_, stored)| stored.clone())
        .unwrap_or_else(|| path.display().to_string());
    let id = existing
        .map(|(id, _)| id)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let last_active_at = sources
        .iter()
        .filter_map(|value| value.last_active_at)
        .max();
    let repository_group_id = sources
        .iter()
        .find_map(|value| value.repository_group_id.clone());
    let display_name = sources
        .iter()
        .find_map(|value| value.display_name.as_deref())
        .filter(|value| !value.trim().is_empty())
        .or_else(|| path.file_name().and_then(|value| value.to_str()))
        .unwrap_or("workspace");
    connection.execute(
        "INSERT INTO workspaces(id, canonical_path, name, repository_group_id, manifest_workspace_id, status, asset_count, warning_count, last_active_at, last_discovered_at, last_scanned_at) VALUES (?1, ?2, ?3, ?4, NULL, 'healthy', 0, 0, ?5, ?6, NULL) ON CONFLICT(canonical_path) DO UPDATE SET name = excluded.name, repository_group_id = COALESCE(excluded.repository_group_id, workspaces.repository_group_id), last_active_at = CASE WHEN excluded.last_active_at IS NULL THEN workspaces.last_active_at WHEN workspaces.last_active_at IS NULL OR excluded.last_active_at > workspaces.last_active_at THEN excluded.last_active_at ELSE workspaces.last_active_at END, last_discovered_at = excluded.last_discovered_at",
        params![id, path_text, display_name, repository_group_id, last_active_at.map(|value| value.to_rfc3339()), Utc::now().to_rfc3339()],
    )?;
    let workspace_id: String = connection.query_row(
        "SELECT id FROM workspaces WHERE canonical_path = ?1",
        params![path_text],
        |row| row.get(0),
    )?;
    connection.execute(
        "DELETE FROM workspace_sources WHERE workspace_id = ?1 AND evidence != 'manual'",
        params![workspace_id],
    )?;
    for source in sources {
        let agent = source
            .source_agent
            .map(enum_string)
            .transpose()?
            .unwrap_or_default();
        let evidence = enum_string(source.evidence)?;
        let session_cwds = serde_json::to_string(&source.session_cwds.clone().unwrap_or_default())?;
        connection.execute(
            "INSERT INTO workspace_sources(workspace_id, agent, evidence, session_count, last_active_at, session_cwds) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(workspace_id, agent, evidence) DO UPDATE SET session_count = excluded.session_count, last_active_at = excluded.last_active_at, session_cwds = excluded.session_cwds",
            params![workspace_id, agent, evidence, source.session_count as i64, source.last_active_at.map(|value| value.to_rfc3339()), session_cwds],
        )?;
    }
    Ok(workspace_id)
}

fn record_scan_failure(connection: &Connection, id: &str) -> Result<()> {
    connection.execute(
        "UPDATE workspaces SET status = 'attention', warning_count = MAX(warning_count, 1), last_scanned_at = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

fn logical_asset_count(assets: &[AssetRecord]) -> usize {
    let mut logical = BTreeSet::new();
    for asset in assets {
        let path = if asset.kind == AssetKind::Skill {
            asset.path.parent().unwrap_or(&asset.path)
        } else {
            &asset.path
        };
        let agent = (asset.kind != AssetKind::Skill).then_some(asset.agent);
        logical.insert(format!(
            "{:?}|{:?}|{}",
            asset.kind,
            agent,
            platform_path::identity(path)
        ));
    }
    logical.len()
}

fn refresh_workspace_record(connection: &Connection, id: &str, path: &Path) -> Result<()> {
    if !path.is_dir() {
        bail!("Workspace does not exist: {}", path.display());
    }
    let scan = scan_workspace(path)?;
    let mut warning_count = scan.warnings.len() as u64;
    let manifest = load_manifest(path).ok();
    let manifest_skill_names: BTreeMap<_, _> = manifest
        .as_ref()
        .into_iter()
        .flat_map(|manifest| &manifest.skills)
        .map(|skill| {
            let source = path.join(&skill.path);
            let entrypoint = if source.is_dir() {
                source.join("SKILL.md")
            } else {
                source.clone()
            };
            let root = inspect_skill_entrypoint(&entrypoint)
                .map(|package| package.root)
                .unwrap_or(source);
            (platform_path::identity(&root), skill.name.clone())
        })
        .collect();
    if let Some(manifest) = manifest.as_ref() {
        for adapter in manifest.adapters.values() {
            for (target, expected) in &adapter.generated_hashes {
                let target = PathBuf::from(target);
                let target = if target.is_absolute() {
                    target
                } else {
                    path.join(target)
                };
                match fs::read(&target) {
                    Ok(content) if hash_content(&content) == *expected => {}
                    _ => warning_count += 1,
                }
            }
        }
    }
    let status = if warning_count == 0 && (!scan.manifest_exists || manifest.is_some()) {
        WorkspaceStatus::Healthy
    } else {
        WorkspaceStatus::Attention
    };
    connection.execute(
        "UPDATE workspaces SET manifest_workspace_id = ?1, status = ?2, asset_count = ?3, warning_count = ?4, last_scanned_at = ?5 WHERE id = ?6",
        params![manifest.as_ref().map(|value| value.workspace.id.clone()), enum_string(status)?, logical_asset_count(&scan.assets) as i64, warning_count as i64, Utc::now().to_rfc3339(), id],
    )?;
    connection.execute(
        "DELETE FROM catalog_assets WHERE workspace_id = ?1",
        params![id],
    )?;
    for asset in scan.assets {
        let skill = (asset.kind == AssetKind::Skill)
            .then(|| inspect_skill_entrypoint(&asset.path))
            .transpose()?;
        let catalog_path = skill
            .as_ref()
            .map(|skill| skill.root.clone())
            .unwrap_or_else(|| asset.path.clone());
        let name = manifest_skill_names
            .get(&platform_path::identity(&catalog_path))
            .cloned()
            .or_else(|| skill.as_ref().map(|skill| skill.name.clone()))
            .unwrap_or_else(|| {
                asset
                    .path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("asset")
                    .to_string()
            });
        let modified_at = skill
            .as_ref()
            .and_then(|skill| skill.modified_at)
            .or_else(|| {
                fs::metadata(&asset.path)
                    .ok()
                    .and_then(|value| value.modified().ok())
                    .map(DateTime::<Utc>::from)
            });
        insert_catalog_asset(
            connection,
            &CatalogAsset {
                id: catalog_id(
                    CatalogScope::Workspace,
                    Some(id),
                    Some(asset.agent),
                    asset.kind,
                    &catalog_path,
                ),
                scope: CatalogScope::Workspace,
                workspace_id: Some(id.to_string()),
                agent: Some(asset.agent),
                kind: asset.kind,
                name,
                path: catalog_path,
                summary: asset.summary,
                summary_key: asset.summary_key,
                summary_params: asset.summary_params,
                size: skill.as_ref().map_or(asset.size, |skill| skill.size),
                modified_at,
            },
        )?;
    }
    if let Some(manifest) = manifest {
        let manifest_path = path.join(".agentkib/manifest.yaml");
        insert_catalog_asset(
            connection,
            &CatalogAsset {
                id: catalog_id(
                    CatalogScope::Workspace,
                    Some(id),
                    None,
                    AssetKind::Instruction,
                    &manifest_path,
                ),
                scope: CatalogScope::Workspace,
                workspace_id: Some(id.to_string()),
                agent: None,
                kind: AssetKind::Instruction,
                name: "Shared project instructions".into(),
                path: manifest_path.clone(),
                summary: "AgentKib shared instructions".into(),
                summary_key: Some("assets.summary.sharedInstructions".into()),
                summary_params: Default::default(),
                size: manifest.instructions.shared.len() as u64,
                modified_at: None,
            },
        )?;
        for skill in manifest.skills {
            let asset_path = path.join(&skill.path);
            let entrypoint = if asset_path.is_dir() {
                asset_path.join("SKILL.md")
            } else {
                asset_path.clone()
            };
            let package = inspect_skill_entrypoint(&entrypoint).ok();
            let catalog_path = package
                .as_ref()
                .map(|package| package.root.clone())
                .unwrap_or(asset_path);
            insert_catalog_asset(
                connection,
                &CatalogAsset {
                    id: catalog_id(
                        CatalogScope::Workspace,
                        Some(id),
                        None,
                        AssetKind::Skill,
                        &catalog_path,
                    ),
                    scope: CatalogScope::Workspace,
                    workspace_id: Some(id.to_string()),
                    agent: None,
                    kind: AssetKind::Skill,
                    name: skill.name,
                    path: catalog_path,
                    summary: "Shared Skill".into(),
                    summary_key: Some("assets.summary.sharedSkill".into()),
                    summary_params: Default::default(),
                    size: package.as_ref().map_or(0, |package| package.size),
                    modified_at: package.and_then(|package| package.modified_at),
                },
            )?;
        }
        for connection_definition in manifest.connections {
            let asset_path = manifest_path.clone();
            let key_path = asset_path.join(format!("connection-{}", connection_definition.name));
            insert_catalog_asset(
                connection,
                &CatalogAsset {
                    id: catalog_id(
                        CatalogScope::Workspace,
                        Some(id),
                        None,
                        AssetKind::Connection,
                        &key_path,
                    ),
                    scope: CatalogScope::Workspace,
                    workspace_id: Some(id.to_string()),
                    agent: None,
                    kind: AssetKind::Connection,
                    name: connection_definition.name,
                    path: asset_path.clone(),
                    summary: "Shared MCP Connection".into(),
                    summary_key: Some("assets.summary.sharedConnection".into()),
                    summary_params: Default::default(),
                    size: 0,
                    modified_at: None,
                },
            )?;
        }
    }
    Ok(())
}

fn insert_catalog_asset(connection: &Connection, asset: &CatalogAsset) -> Result<()> {
    let id = if asset.id.is_empty() {
        catalog_id(
            asset.scope,
            asset.workspace_id.as_deref(),
            asset.agent,
            asset.kind,
            &asset.path,
        )
    } else {
        asset.id.clone()
    };
    connection.execute(
        "INSERT OR REPLACE INTO catalog_assets(id, scope, workspace_id, agent, kind, name, path, summary, size, modified_at, summary_key, summary_params) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![id, enum_string(asset.scope)?, asset.workspace_id, asset.agent.map(enum_string).transpose()?, enum_string(asset.kind)?, asset.name, asset.path.display().to_string(), asset.summary, asset.size as i64, asset.modified_at.map(|value| value.to_rfc3339()), asset.summary_key, serde_json::to_string(&asset.summary_params)?],
    )?;
    Ok(())
}

fn catalog_id(
    scope: CatalogScope,
    workspace_id: Option<&str>,
    agent: Option<AgentKind>,
    kind: AssetKind,
    path: &Path,
) -> String {
    hash_content(
        format!(
            "{:?}|{}|{:?}|{:?}|{}",
            scope,
            workspace_id.unwrap_or_default(),
            agent,
            kind,
            path.display()
        )
        .as_bytes(),
    )
}

fn row_to_workspace(row: &Row<'_>) -> rusqlite::Result<WorkspaceSummary> {
    let status: String = row.get(5)?;
    let last_active = row_optional_time(row, 8)?;
    let last_scanned = row_optional_time(row, 9)?;
    Ok(WorkspaceSummary {
        id: row.get(0)?,
        path: PathBuf::from(row.get::<_, String>(1)?),
        name: row.get(2)?,
        repository_group_id: row.get(3)?,
        manifest_workspace_id: row.get(4)?,
        status: parse_enum(&status).map_err(sql_error)?,
        asset_count: row.get::<_, i64>(6)?.max(0) as u64,
        warning_count: row.get::<_, i64>(7)?.max(0) as u64,
        last_active_at: last_active,
        last_scanned_at: last_scanned,
        sources: Vec::new(),
    })
}

fn row_to_conversation_session(row: &Row<'_>) -> rusqlite::Result<ConversationSessionSummary> {
    let created_at = row.get::<_, Option<String>>(4)?;
    let updated_at = row.get::<_, Option<String>>(5)?;
    Ok(ConversationSessionSummary {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        agent: parse_enum(&row.get::<_, String>(2)?).map_err(sql_error)?,
        title: row.get(3)?,
        created_at: created_at
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
        updated_at: updated_at
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
        message_count: row
            .get::<_, Option<i64>>(6)?
            .map(|value| value.max(0) as u64),
        git_branch: row.get(7)?,
        archived: row.get(8)?,
        sidechain: row.get(9)?,
        availability: parse_enum(&row.get::<_, String>(10)?).map_err(sql_error)?,
        origin: parse_enum(&row.get::<_, String>(11)?).unwrap_or(SessionOrigin::Unknown),
        spawned_by_session_id: row.get(12)?,
        forked_from_session_id: row.get(13)?,
    })
}

fn row_to_catalog_asset(row: &Row<'_>) -> rusqlite::Result<CatalogAsset> {
    let scope: String = row.get(1)?;
    let agent: Option<String> = row.get(3)?;
    let kind: String = row.get(4)?;
    let modified_at: Option<String> = row.get(9)?;
    let summary_params: String = row.get(11)?;
    Ok(CatalogAsset {
        id: row.get(0)?,
        scope: parse_enum(&scope).map_err(sql_error)?,
        workspace_id: row.get(2)?,
        agent: agent
            .map(|value| parse_enum(&value))
            .transpose()
            .map_err(sql_error)?,
        kind: parse_enum(&kind).map_err(sql_error)?,
        name: row.get(5)?,
        path: PathBuf::from(row.get::<_, String>(6)?),
        summary: row.get(7)?,
        summary_key: row.get(10)?,
        summary_params: serde_json::from_str(&summary_params)
            .map_err(|error| sql_error(error.into()))?,
        size: row.get::<_, i64>(8)?.max(0) as u64,
        modified_at: modified_at
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
    })
}

pub fn default_data_dir() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("AGENTKIB_BENCHMARK_DATA_DIR") {
        return Ok(PathBuf::from(path));
    }
    let base =
        dirs::data_local_dir().context("Could not determine the local app data directory")?;
    resolve_data_dir(&base)
}

fn resolve_data_dir(base: &Path) -> Result<PathBuf> {
    #[cfg(feature = "dev-app")]
    {
        Ok(base.join(APP_DATA_DIRECTORY))
    }
    #[cfg(not(feature = "dev-app"))]
    {
        migrate_legacy_data_dir(base)
    }
}

#[cfg(not(feature = "dev-app"))]
fn migrate_legacy_data_dir(base: &Path) -> Result<PathBuf> {
    let current = base.join(APP_DATA_DIRECTORY);
    if current.exists() {
        return Ok(current);
    }

    let legacy = base.join(LEGACY_APP_DATA_DIRECTORY);
    if !legacy.exists() {
        return Ok(current);
    }

    if let Err(error) = fs::rename(&legacy, &current) {
        // Another startup path may have won the same one-time migration race.
        if current.exists() && !legacy.exists() {
            return Ok(current);
        }
        return Err(error).with_context(|| {
            format!(
                "Could not migrate AgentKib data from {} to {}",
                legacy.display(),
                current.display()
            )
        });
    }
    Ok(current)
}

pub fn default_database_path() -> Result<PathBuf> {
    Ok(default_data_dir()?.join("agentkib.db"))
}

pub fn default_backup_dir() -> Result<PathBuf> {
    Ok(default_data_dir()?.join("backups"))
}

fn row_to_memory(row: &Row<'_>) -> rusqlite::Result<MemoryRecord> {
    let memory_type: String = row.get(2)?;
    let status: String = row.get(4)?;
    let created_at: String = row.get(8)?;
    let approved_at: Option<String> = row.get(9)?;
    Ok(MemoryRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        memory_type: parse_enum(&memory_type).map_err(sql_error)?,
        content: row.get(3)?,
        status: parse_enum(&status).map_err(sql_error)?,
        source_agent: row.get(5)?,
        source_thread: row.get(6)?,
        source_reference: row.get(7)?,
        created_at: parse_time(&created_at).map_err(sql_error)?,
        approved_at: approved_at
            .map(|value| parse_time(&value))
            .transpose()
            .map_err(sql_error)?,
        invalidated_by: row.get(10)?,
    })
}

fn parse_time(value: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

fn parse_unix_timestamp(value: i64) -> Result<DateTime<Utc>> {
    if value.unsigned_abs() >= 100_000_000_000 {
        let seconds = value.div_euclid(1_000);
        let milliseconds = value.rem_euclid(1_000) as u32;
        Utc.timestamp_opt(seconds, milliseconds * 1_000_000)
            .single()
            .context("Invalid Unix millisecond timestamp")
    } else {
        Utc.timestamp_opt(value, 0)
            .single()
            .context("Invalid Unix timestamp")
    }
}

fn decode_optional_time(value: ValueRef<'_>) -> Option<DateTime<Utc>> {
    match value {
        ValueRef::Null => None,
        ValueRef::Text(value) => std::str::from_utf8(value).ok().and_then(|value| {
            parse_time(value)
                .or_else(|_| {
                    value
                        .parse::<i64>()
                        .map_err(Into::into)
                        .and_then(parse_unix_timestamp)
                })
                .ok()
        }),
        ValueRef::Integer(value) => parse_unix_timestamp(value).ok(),
        ValueRef::Real(_) | ValueRef::Blob(_) => None,
    }
}

fn row_optional_time(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<DateTime<Utc>>> {
    Ok(decode_optional_time(row.get_ref(index)?))
}

fn table_has_column(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
    column: &str,
) -> Result<bool> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    for row in rows {
        if row? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn normalize_legacy_workspace_timestamps(transaction: &rusqlite::Transaction<'_>) -> Result<()> {
    if table_has_column(transaction, "workspaces", "last_active_at")? {
        let workspaces = {
            let mut statement = transaction.prepare(
                "SELECT id, last_active_at FROM workspaces WHERE last_active_at IS NOT NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    decode_optional_time(row.get_ref(1)?).map(|value| value.to_rfc3339()),
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (id, last_active_at) in workspaces {
            transaction.execute(
                "UPDATE workspaces SET last_active_at = ?1 WHERE id = ?2",
                params![last_active_at, id],
            )?;
        }
    }

    if table_has_column(transaction, "workspace_sources", "last_active_at")? {
        let workspace_sources = {
            let mut statement = transaction.prepare(
                "SELECT workspace_id, agent, evidence, last_active_at FROM workspace_sources WHERE last_active_at IS NOT NULL",
            )?;
            let rows = statement.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    decode_optional_time(row.get_ref(3)?).map(|value| value.to_rfc3339()),
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        for (workspace_id, agent, evidence, last_active_at) in workspace_sources {
            transaction.execute(
                "UPDATE workspace_sources SET last_active_at = ?1 WHERE workspace_id = ?2 AND agent = ?3 AND evidence = ?4",
                params![last_active_at, workspace_id, agent, evidence],
            )?;
        }
    }
    Ok(())
}
#[cfg(unix)]
fn default_storage_measurement() -> StorageMeasurement {
    StorageMeasurement::AllocatedExact
}
#[cfg(not(unix))]
fn default_storage_measurement() -> StorageMeasurement {
    StorageMeasurement::LogicalEstimate
}
fn enum_string<T: serde::Serialize>(value: T) -> Result<String> {
    Ok(serde_json::to_value(value)?
        .as_str()
        .context("Enum serialization failed")?
        .to_string())
}
fn parse_enum<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    Ok(serde_json::from_value(serde_json::Value::String(
        value.into(),
    ))?)
}

fn parse_agent_kind(value: &str) -> Option<AgentKind> {
    serde_json::from_value(serde_json::Value::String(value.into())).ok()
}
fn sql_error(error: anyhow::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error.into())
}
fn fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" AND ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use agentkib_core::MemoryType;
    use agentkib_insights::{
        DatePrecision, GitCommitRecord, GitIdentityCandidate, ProviderStatus, UsageEvent,
    };
    use tempfile::tempdir;

    fn candidate(path: &Path) -> DiscoveryCandidate {
        DiscoveryCandidate {
            path: path.canonicalize().unwrap(),
            display_name: None,
            source_agent: Some(AgentKind::Codex),
            evidence: DiscoveryEvidence::SessionCwd,
            last_active_at: Some(Utc::now()),
            session_count: 2,
            explicit_workspace: false,
            repository_group_id: Some("repository".into()),
            session_cwds: None,
        }
    }

    fn insert_usage_day(store: &Store, day: &str, agent: &str, workspace_id: &str, sessions: u64) {
        store
            .connection
            .execute(
                "INSERT INTO usage_daily(day, surface_agent, workspace_id, total_tokens, session_count, quality) VALUES (?1, ?2, ?3, 1, ?4, 'exact')",
                params![day, agent, workspace_id, sessions],
            )
            .unwrap();
    }

    #[cfg(not(feature = "dev-app"))]
    #[test]
    fn legacy_app_data_is_moved_to_the_current_identifier() {
        let base = tempdir().unwrap();
        let legacy = base.path().join(LEGACY_APP_DATA_DIRECTORY);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("agentkib.db"), b"preview data").unwrap();

        let current = migrate_legacy_data_dir(base.path()).unwrap();

        assert_eq!(current, base.path().join(APP_DATA_DIRECTORY));
        assert_eq!(
            fs::read(current.join("agentkib.db")).unwrap(),
            b"preview data"
        );
        assert!(!legacy.exists());
    }

    #[cfg(not(feature = "dev-app"))]
    #[test]
    fn legacy_app_data_never_overwrites_the_current_identifier() {
        let base = tempdir().unwrap();
        let current = base.path().join(APP_DATA_DIRECTORY);
        let legacy = base.path().join(LEGACY_APP_DATA_DIRECTORY);
        fs::create_dir_all(&current).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(current.join("preferences.json"), b"current").unwrap();
        fs::write(legacy.join("preferences.json"), b"legacy").unwrap();

        assert_eq!(migrate_legacy_data_dir(base.path()).unwrap(), current);
        assert_eq!(
            fs::read(current.join("preferences.json")).unwrap(),
            b"current"
        );
        assert!(legacy.exists());
    }

    #[cfg(feature = "dev-app")]
    #[test]
    fn development_data_never_migrates_the_legacy_directory() {
        let base = tempdir().unwrap();
        let legacy = base.path().join("com.agentkib.desktop");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("agentkib.db"), b"production preview data").unwrap();

        let development = resolve_data_dir(base.path()).unwrap();

        assert_eq!(development, base.path().join("ai.agentkib.dev"));
        assert!(!development.exists());
        assert_eq!(
            fs::read(legacy.join("agentkib.db")).unwrap(),
            b"production preview data"
        );
    }

    #[test]
    fn only_approved_memories_are_searchable() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let record = store
            .propose_memory(&MemoryProposal {
                project_id: "p1".into(),
                memory_type: MemoryType::Decision,
                content: "统一使用 SQLite FTS5".into(),
                source_agent: None,
                source_thread: None,
                source_reference: None,
            })
            .unwrap();
        assert!(
            store
                .search_approved("p1", "SQLite", 10)
                .unwrap()
                .is_empty()
        );
        store
            .review_memory(&record.id, MemoryStatus::Approved, None)
            .unwrap();
        assert_eq!(store.search_approved("p1", "SQLite", 10).unwrap().len(), 1);
    }

    #[test]
    fn discovery_is_idempotent_and_preserves_existing_workspace_on_provider_error() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let candidate = candidate(&workspace);
        for _ in 0..2 {
            store
                .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
                .unwrap();
        }
        let workspaces = store.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].sources.len(), 1);
        assert_eq!(workspaces[0].sources[0].session_count, 2);

        store
            .sync_discovery(&[], &[], &[], Utc::now(), &["codex provider failed".into()])
            .unwrap();
        assert_eq!(store.list_workspaces().unwrap().len(), 1);
    }

    #[test]
    fn discovery_source_diagnostics_are_additive_and_round_trip() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let started_at = Utc::now();
        let diagnostics = vec![DiscoverySourceDiagnostic {
            agent: Some(AgentKind::OpenCode),
            source: "sqlite".into(),
            path: Some(dir.path().join("opencode.db")),
            started_at,
            finished_at: started_at,
            candidate_count: Some(2),
            included_count: Some(1),
            skipped_count: None,
            status: agentkib_core::DiscoveryDiagnosticStatus::Partial,
            reasons: vec!["source-read-failed".into()],
        }];
        store
            .sync_discovery_with_diagnostics(
                &[candidate(&workspace)],
                &[],
                &[],
                started_at,
                &[],
                &diagnostics,
            )
            .unwrap();

        let report = store.latest_discovery_report().unwrap().unwrap();
        assert_eq!(report.source_diagnostics.len(), 1);
        assert_eq!(report.source_diagnostics[0].source, "sqlite");
        assert_eq!(report.source_diagnostics[0].candidate_count, Some(2));
        assert_eq!(report.source_diagnostics[0].skipped_count, None);
        assert_eq!(report.source_diagnostics[0].reasons, ["source-read-failed"]);
    }

    #[test]
    fn workspace_source_round_trips_original_session_cwds_and_legacy_none() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let first = workspace.join("packages/api");
        let second = workspace.join("packages/web");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::create_dir(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let mut session_candidate = candidate(&workspace);
        session_candidate.source_agent = Some(AgentKind::OpenClaw);
        session_candidate.session_cwds = Some(vec![first.clone(), second.clone()]);
        store
            .sync_discovery(&[session_candidate], &[], &[], Utc::now(), &[])
            .unwrap();

        let sources = store.list_workspaces().unwrap()[0].sources.clone();
        assert_eq!(sources.len(), 1);
        let mut session_cwds = sources[0].session_cwds.clone().unwrap();
        session_cwds.sort();
        assert_eq!(session_cwds, vec![first, second]);

        let mut legacy_candidate = candidate(&workspace);
        legacy_candidate.source_agent = Some(AgentKind::Codex);
        store
            .sync_discovery(&[legacy_candidate], &[], &[], Utc::now(), &[])
            .unwrap();
        assert_eq!(
            store.list_workspaces().unwrap()[0].sources[0].session_cwds,
            None
        );
    }

    #[test]
    fn old_workspace_sources_without_session_cwds_migrate_to_empty_json() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let store = Store::open(&database).unwrap();
        store
            .connection
            .execute("ALTER TABLE workspace_sources DROP COLUMN session_cwds", [])
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE schema_meta SET value = '12' WHERE key = 'schema_version'",
                [],
            )
            .unwrap();
        drop(store);

        let migrated = Store::open(&database).unwrap();
        let has_column: bool = migrated
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info('workspace_sources') WHERE name = 'session_cwds')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_column);
    }

    #[test]
    fn discovered_workspace_without_manifest_is_healthy() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();

        store
            .sync_discovery(&[candidate(&workspace)], &[], &[], Utc::now(), &[])
            .unwrap();

        let workspaces = store.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].status, WorkspaceStatus::Healthy);
        assert!(workspaces[0].manifest_workspace_id.is_none());
        assert!(!workspace.join(".agentkib/manifest.yaml").exists());
    }

    #[test]
    fn excluded_workspace_stays_hidden_until_restored() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let candidate = candidate(&workspace);
        store
            .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
            .unwrap();
        let id = store.list_workspaces().unwrap()[0].id.clone();
        store.exclude_workspace(&id).unwrap();
        store
            .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
            .unwrap();
        assert!(store.list_workspaces().unwrap().is_empty());

        store
            .restore_excluded_workspace(&workspace.canonicalize().unwrap())
            .unwrap();
        store
            .sync_discovery(&[candidate], &[], &[], Utc::now(), &[])
            .unwrap();
        assert_eq!(store.list_workspaces().unwrap().len(), 1);
    }

    #[test]
    fn nonexistent_history_paths_are_removed() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        store
            .sync_discovery(&[candidate(&workspace)], &[], &[], Utc::now(), &[])
            .unwrap();
        fs::remove_dir_all(&workspace).unwrap();
        let report = store
            .sync_discovery(&[], &[], &[], Utc::now(), &[])
            .unwrap();
        assert_eq!(report.removed_count, 1);
        assert!(store.list_workspaces().unwrap().is_empty());
    }

    #[test]
    fn discovery_removes_known_agent_probe_workspaces() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("ClaudeProbe");
        fs::create_dir_all(&workspace).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let candidate = candidate(&workspace);
        store
            .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
            .unwrap();
        let workspace_id = store.list_workspaces().unwrap()[0].id.clone();
        store
            .sync_conversation_sessions(
                &workspace_id,
                AgentKind::ClaudeCode,
                &[NativeSessionSummary {
                    native_ref: "old-probe-session".into(),
                    agent: AgentKind::ClaudeCode,
                    title: None,
                    created_at: None,
                    updated_at: None,
                    message_count: None,
                    git_branch: None,
                    archived: false,
                    sidechain: false,
                    origin: SessionOrigin::Unknown,
                    spawned_by_session_id: None,
                    forked_from_session_id: None,
                    availability: agentkib_conversations::SessionAvailability::MetadataOnly,
                }],
            )
            .unwrap();
        assert_eq!(
            store
                .list_conversation_sessions(&workspace_id)
                .unwrap()
                .len(),
            1
        );

        fs::write(workspace.join(".codexbar-session-id"), "probe-session").unwrap();
        let report = store
            .sync_discovery(std::slice::from_ref(&candidate), &[], &[], Utc::now(), &[])
            .unwrap();
        assert_eq!(report.discovered_count, 0);
        assert_eq!(report.removed_count, 1);
        assert!(store.list_workspaces().unwrap().is_empty());
        assert!(
            store
                .list_conversation_sessions(&workspace_id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn discovery_excludes_and_removes_exact_agent_homes_but_keeps_descendants() {
        let dir = tempdir().unwrap();
        let agent_home = dir.path().join(".codex");
        let project = agent_home.join("projects/app");
        fs::create_dir_all(agent_home.join("skills/reviewer")).unwrap();
        fs::write(agent_home.join("skills/reviewer/SKILL.md"), "# Reviewer").unwrap();
        fs::create_dir_all(project.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();

        store
            .sync_discovery(&[candidate(&agent_home)], &[], &[], Utc::now(), &[])
            .unwrap();
        let stale_id = store.list_workspaces().unwrap()[0].id.clone();
        assert!(
            !store
                .search_catalog_assets("", None, Some(&stale_id), 100)
                .unwrap()
                .is_empty()
        );

        let installation = AgentInstallation {
            agent: AgentKind::Codex,
            installed: true,
            configured: true,
            version: None,
            home: Some(agent_home.clone()),
            warnings: Vec::new(),
            support: Some(agentkib_core::AgentSupportCapabilities::for_agent(
                AgentKind::Codex,
            )),
        };
        let report = store
            .sync_discovery(
                &[candidate(&agent_home), candidate(&project)],
                &[installation],
                &[],
                Utc::now(),
                &[],
            )
            .unwrap();

        assert_eq!(report.discovered_count, 1);
        assert_eq!(report.removed_count, 1);
        let workspaces = store.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].path, project.canonicalize().unwrap());
        assert!(
            store
                .search_catalog_assets("", None, Some(&stale_id), 100)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn manually_adding_a_known_agent_home_is_rejected() {
        let dir = tempdir().unwrap();
        let agent_home = dir.path().join(".codex");
        fs::create_dir(&agent_home).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        store
            .sync_discovery(
                &[],
                &[AgentInstallation {
                    agent: AgentKind::Codex,
                    installed: true,
                    configured: true,
                    version: None,
                    home: Some(agent_home.clone()),
                    warnings: Vec::new(),
                    support: Some(agentkib_core::AgentSupportCapabilities::for_agent(
                        AgentKind::Codex,
                    )),
                }],
                &[],
                Utc::now(),
                &[],
            )
            .unwrap();

        let error = store.add_workspace(&agent_home).unwrap_err().to_string();

        assert!(error.contains("Agent Home cannot be added as a workspace"));
    }

    #[test]
    fn workspace_catalog_uses_one_logical_skill_package() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let skill = workspace.join(".agents/skills/folder-name");
        fs::create_dir_all(skill.join("references")).unwrap();
        let entrypoint = "---\nname: logical-name\n---\nBody";
        let guide = "Guide";
        fs::write(skill.join("SKILL.md"), entrypoint).unwrap();
        fs::write(skill.join("references/guide.md"), guide).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();

        let registered = store.add_workspace(&workspace).unwrap();
        let assets = store
            .search_catalog_assets("logical-name", None, Some(&registered.id), 100)
            .unwrap();

        assert_eq!(registered.asset_count, 1);
        assert_eq!(assets.len(), 5);
        assert!(assets.iter().all(|asset| asset.name == "logical-name"));
        let skill = platform_path::canonicalize(&skill).unwrap();
        assert!(assets.iter().all(|asset| asset.path == skill));
        assert!(
            assets
                .iter()
                .all(|asset| asset.size == (entrypoint.len() + guide.len()) as u64)
        );
        assert!(assets.iter().all(|asset| asset.modified_at.is_some()));
        assert_eq!(
            assets
                .iter()
                .filter_map(|asset| asset.agent)
                .collect::<BTreeSet<_>>()
                .len(),
            5
        );
    }

    #[test]
    fn manifest_skill_name_remains_authoritative() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        let skill = workspace.join("custom/skill-folder");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: frontmatter-name\n---\nBody",
        )
        .unwrap();
        fs::create_dir_all(workspace.join(".agentkib")).unwrap();
        fs::write(
            workspace.join(".agentkib/manifest.yaml"),
            "schema_version: 2\nworkspace:\n  id: workspace-id\n  name: Workspace\nskills:\n  - name: manifest-name\n    path: custom/skill-folder\n",
        )
        .unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();

        let registered = store.add_workspace(&workspace).unwrap();
        let assets = store
            .search_catalog_assets("manifest-name", None, Some(&registered.id), 100)
            .unwrap();

        assert_eq!(assets.len(), 1);
        assert_eq!(assets[0].name, "manifest-name");
        assert_eq!(assets[0].path, platform_path::canonicalize(&skill).unwrap());
        assert!(assets[0].size > 0);
    }

    #[test]
    fn schema_upgrade_keeps_existing_memories() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        {
            let store = Store::open(&database).unwrap();
            store
                .propose_memory(&MemoryProposal {
                    project_id: "p1".into(),
                    memory_type: MemoryType::ProjectFact,
                    content: "保留的记忆".into(),
                    source_agent: None,
                    source_thread: None,
                    source_reference: None,
                })
                .unwrap();
        }
        let reopened = Store::open(&database).unwrap();
        assert_eq!(reopened.list_global_memories(None).unwrap().len(), 1);
    }

    #[test]
    fn current_schema_indexes_session_fallback_replacement() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let exists: bool = store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_usage_events_session_precision')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(exists);
    }

    #[test]
    fn conversation_index_accepts_every_registered_provider() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let registered = store.add_workspace(&workspace).unwrap();
        let providers = agentkib_conversations::providers();

        for provider in &providers {
            assert!(
                store
                    .sync_conversation_sessions(&registered.id, provider.agent(), &[])
                    .unwrap()
                    .is_empty()
            );
        }

        let statuses = store.conversation_index_status(&registered.id).unwrap();
        assert_eq!(statuses.len(), providers.len());
        for provider in providers {
            assert!(statuses.iter().any(|status| {
                status.agent == provider.agent() && status.freshness == SessionIndexFreshness::Fresh
            }));
        }
    }

    #[test]
    fn conversation_index_round_trips_opencode_and_rejects_unsupported_agents() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let registered = store.add_workspace(&workspace).unwrap();
        let timestamp = Utc::now();
        let native_ref = "opencode-native-session";
        let session = NativeSessionSummary {
            native_ref: native_ref.into(),
            agent: AgentKind::OpenCode,
            title: Some("OpenCode cached session".into()),
            created_at: Some(timestamp),
            updated_at: Some(timestamp),
            message_count: Some(3),
            git_branch: Some("main".into()),
            archived: false,
            sidechain: false,
            origin: SessionOrigin::Unknown,
            spawned_by_session_id: None,
            forked_from_session_id: None,
            availability: agentkib_conversations::SessionAvailability::Readable,
        };
        let indexed = store
            .sync_conversation_sessions(&registered.id, AgentKind::OpenCode, &[session])
            .unwrap();
        assert_eq!(indexed.len(), 1);
        let stored = store
            .get_conversation_session(&indexed[0].id)
            .unwrap()
            .unwrap();
        assert_eq!(stored.agent, AgentKind::OpenCode);
        assert_eq!(stored.workspace_id, registered.id);
        assert_eq!(stored.title.as_deref(), Some("OpenCode cached session"));
        assert_eq!(stored.message_count, Some(3));
        assert_eq!(stored.updated_at, Some(timestamp));
        assert_ne!(stored.id, native_ref);
        assert_eq!(
            stored.id,
            store
                .conversation_id(AgentKind::OpenCode, native_ref)
                .unwrap()
        );

        let error = store
            .sync_conversation_sessions(&registered.id, AgentKind::Cursor, &[])
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "Conversation indexing is not supported for this Agent"
        );
        assert_eq!(
            store
                .list_conversation_sessions(&registered.id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn conversation_index_hashes_native_ids_and_preserves_last_good_on_failure() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let registered = store.add_workspace(&workspace).unwrap();
        let native_ref = "native-session-secret";
        let session = NativeSessionSummary {
            native_ref: native_ref.into(),
            agent: AgentKind::Codex,
            title: Some("A cached title".into()),
            created_at: Some(Utc::now()),
            updated_at: Some(Utc::now()),
            message_count: Some(4),
            git_branch: Some("main".into()),
            archived: false,
            sidechain: false,
            origin: SessionOrigin::Unknown,
            spawned_by_session_id: None,
            forked_from_session_id: None,
            availability: agentkib_conversations::SessionAvailability::Readable,
        };

        let indexed = store
            .sync_conversation_sessions(&registered.id, AgentKind::Codex, &[session])
            .unwrap();
        assert_eq!(indexed.len(), 1);
        assert_ne!(indexed[0].id, native_ref);
        assert_eq!(
            indexed[0].id,
            store.conversation_id(AgentKind::Codex, native_ref).unwrap()
        );

        store
            .record_conversation_index_failure(
                &registered.id,
                AgentKind::Codex,
                "errors.conversations.sourceUnavailable",
                "source unavailable",
            )
            .unwrap();
        assert_eq!(
            store
                .list_conversation_sessions(&registered.id)
                .unwrap()
                .len(),
            1
        );
        let status = store.conversation_index_status(&registered.id).unwrap();
        assert_eq!(status.len(), 1);
        assert_eq!(status[0].freshness, SessionIndexFreshness::Stale);

        let raw_id_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM conversation_sessions WHERE id = ?1",
                [native_ref],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw_id_rows, 0);

        store
            .sync_conversation_sessions(&registered.id, AgentKind::Codex, &[])
            .unwrap();
        assert!(
            store
                .list_conversation_sessions(&registered.id)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn conversation_provenance_is_independent_hashed_and_not_title_deduplicated() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let registered = store.add_workspace(&workspace).unwrap();
        let base = NativeSessionSummary {
            native_ref: "private-parent".into(),
            agent: AgentKind::Codex,
            title: Some("Same title".into()),
            created_at: None,
            updated_at: None,
            message_count: None,
            git_branch: Some("main".into()),
            archived: false,
            sidechain: false,
            origin: SessionOrigin::Interactive,
            spawned_by_session_id: None,
            forked_from_session_id: None,
            availability: agentkib_conversations::SessionAvailability::Readable,
        };
        let fork = NativeSessionSummary {
            native_ref: "private-fork".into(),
            forked_from_session_id: Some(base.native_ref.clone()),
            ..base.clone()
        };
        let child = NativeSessionSummary {
            native_ref: "private-child".into(),
            origin: SessionOrigin::Auxiliary,
            spawned_by_session_id: Some(base.native_ref.clone()),
            forked_from_session_id: Some("private-absent-source".into()),
            ..base.clone()
        };
        let records = store
            .sync_conversation_sessions(
                &registered.id,
                AgentKind::Codex,
                &[base.clone(), fork.clone(), child.clone()],
            )
            .unwrap();
        assert_eq!(records.len(), 3);
        let parent_id = store
            .conversation_id(AgentKind::Codex, &base.native_ref)
            .unwrap();
        let child_id = store
            .conversation_id(AgentKind::Codex, &child.native_ref)
            .unwrap();
        let saved = store.get_conversation_session(&child_id).unwrap().unwrap();
        assert_eq!(saved.origin, SessionOrigin::Auxiliary);
        assert!(!saved.sidechain);
        assert_eq!(
            saved.spawned_by_session_id.as_deref(),
            Some(parent_id.as_str())
        );
        assert_eq!(
            saved.forked_from_session_id,
            Some(
                store
                    .conversation_id(AgentKind::Codex, "private-absent-source")
                    .unwrap()
            )
        );
        assert!(
            !serde_json::to_string(&records)
                .unwrap()
                .contains("private-")
        );
        let fork_id = store
            .conversation_id(AgentKind::Codex, &fork.native_ref)
            .unwrap();
        let saved_fork = store.get_conversation_session(&fork_id).unwrap().unwrap();
        assert_eq!(saved_fork.origin, SessionOrigin::Interactive);
        assert_eq!(
            saved_fork.forked_from_session_id.as_deref(),
            Some(parent_id.as_str())
        );
        assert!(saved_fork.spawned_by_session_id.is_none());
        let remaining = store
            .sync_conversation_sessions(&registered.id, AgentKind::Codex, &[child])
            .unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].spawned_by_session_id.as_deref(),
            Some(parent_id.as_str())
        );
    }

    #[test]
    fn normalized_session_ownership_is_independent_of_refresh_order() {
        for agent in [AgentKind::OpenClaw, AgentKind::Hermes, AgentKind::GrokBuild] {
            let dir = tempdir().unwrap();
            let root = dir.path().join("project");
            let child = root.join("child");
            let sibling = root.join("sibling");
            fs::create_dir_all(&child).unwrap();
            fs::create_dir_all(&sibling).unwrap();
            fs::create_dir(root.join(".git")).unwrap();
            let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
            let child = store.add_workspace(&child).unwrap();
            let sibling = store.add_workspace(&sibling).unwrap();
            let native = NativeSessionSummary {
                native_ref: "stable-native-session".into(),
                agent,
                title: Some("History".into()),
                created_at: None,
                updated_at: None,
                message_count: None,
                git_branch: None,
                archived: false,
                sidechain: false,
                origin: SessionOrigin::Unknown,
                spawned_by_session_id: None,
                forked_from_session_id: None,
                availability: agentkib_conversations::SessionAvailability::Readable,
            };
            let id = store.conversation_id(agent, &native.native_ref).unwrap();
            // With no root registered, one stable alias owns the session.
            for workspace in [&sibling, &child, &sibling] {
                store
                    .sync_conversation_sessions(&workspace.id, agent, std::slice::from_ref(&native))
                    .unwrap();
            }
            assert_eq!(
                store
                    .get_conversation_session(&id)
                    .unwrap()
                    .unwrap()
                    .workspace_id,
                child.id
            );
            let root = store.add_workspace(&root).unwrap();
            // A partial alias refresh must migrate, not delete, the sole cache
            // even when the new preferred root has not been scanned yet.
            store
                .sync_conversation_sessions_partial(&child.id, agent, &[])
                .unwrap();
            assert_eq!(
                store
                    .get_conversation_session(&id)
                    .unwrap()
                    .unwrap()
                    .workspace_id,
                root.id
            );
            assert!(
                store
                    .conversation_index_status(&root.id)
                    .unwrap()
                    .is_empty()
            );
            store
                .record_conversation_index_failure(&root.id, agent, "source_failed", "offline")
                .unwrap();
            store
                .sync_conversation_sessions_partial(&child.id, agent, std::slice::from_ref(&native))
                .unwrap();
            let status = store.conversation_index_status(&root.id).unwrap();
            assert_eq!(status[0].session_count, 1);
            assert_eq!(status[0].error_key.as_deref(), Some("source_failed"));
            assert!(status[0].last_success_at.is_none());

            let nested_path = store.workspace_path(&root.id).unwrap().join("nested");
            fs::create_dir_all(nested_path.join(".git")).unwrap();
            let nested = store.add_workspace(&nested_path).unwrap();
            let mut nested_native = native.clone();
            nested_native.native_ref = "independent-nested-session".into();
            let nested_id = store
                .conversation_id(agent, &nested_native.native_ref)
                .unwrap();
            store
                .sync_conversation_sessions(&nested.id, agent, &[nested_native])
                .unwrap();
            for order in [[&root, &child, &sibling], [&sibling, &child, &root]] {
                for workspace in order {
                    store
                        .sync_conversation_sessions(
                            &workspace.id,
                            agent,
                            std::slice::from_ref(&native),
                        )
                        .unwrap();
                    store
                        .sync_conversation_sessions_partial(
                            &workspace.id,
                            agent,
                            std::slice::from_ref(&native),
                        )
                        .unwrap();
                }
                assert_eq!(
                    store
                        .get_conversation_session(&id)
                        .unwrap()
                        .unwrap()
                        .workspace_id,
                    root.id
                );
                assert!(
                    store
                        .list_conversation_sessions(&child.id)
                        .unwrap()
                        .is_empty()
                );
                assert!(
                    store
                        .list_conversation_sessions(&sibling.id)
                        .unwrap()
                        .is_empty()
                );
                assert_eq!(
                    store.conversation_index_status(&child.id).unwrap()[0].session_count,
                    0
                );
                assert_eq!(
                    store
                        .get_conversation_session(&nested_id)
                        .unwrap()
                        .unwrap()
                        .workspace_id,
                    nested.id
                );
            }
            // Removing the preferred root restores the same deterministic alias.
            store.exclude_workspace(&root.id).unwrap();
            store
                .sync_conversation_sessions(&sibling.id, agent, std::slice::from_ref(&native))
                .unwrap();
            store
                .sync_conversation_sessions(&child.id, agent, &[native])
                .unwrap();
            assert_eq!(
                store
                    .get_conversation_session(&id)
                    .unwrap()
                    .unwrap()
                    .workspace_id,
                child.id
            );
        }
    }

    #[test]
    fn version_eleven_retains_cached_sessions_and_reclassifies_after_refresh() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let store = Store::open(&database).unwrap();
        let registered = store.add_workspace(&workspace).unwrap();
        store.connection.execute(
            "INSERT INTO conversation_sessions(id,workspace_id,agent,title,archived,sidechain,availability,last_indexed_at)
             VALUES ('old',?1,'codex','Kept',0,0,'readable','2026-09-07T00:00:00Z')",
            [&registered.id],
        ).unwrap();
        store.connection.execute(
            "INSERT INTO conversation_index_status(workspace_id,agent,session_count,last_attempt_at,last_success_at)
             VALUES (?1,'codex',1,'2026-09-07T00:00:00Z','2026-09-07T00:00:00Z')",
            [&registered.id],
        ).unwrap();
        store
            .connection
            .execute_batch(
                "ALTER TABLE conversation_sessions DROP COLUMN origin;
             ALTER TABLE conversation_sessions DROP COLUMN spawned_by_session_id;
             ALTER TABLE conversation_sessions DROP COLUMN forked_from_session_id;
             UPDATE schema_meta SET value='10' WHERE key='schema_version';",
            )
            .unwrap();
        drop(store);
        let migrated = Store::open(&database).unwrap();
        let records = migrated.list_conversation_sessions(&registered.id).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, "old");
        assert_eq!(records[0].origin, SessionOrigin::Unknown);
        assert!(records[0].spawned_by_session_id.is_none());
        assert!(
            migrated.conversation_index_status(&registered.id).unwrap()[0]
                .last_success_at
                .is_none()
        );
        migrated
            .connection
            .execute(
                "UPDATE conversation_index_status SET last_success_at=?1",
                [Utc::now().to_rfc3339()],
            )
            .unwrap();
        drop(migrated);
        let reopened = Store::open(&database).unwrap();
        assert!(
            reopened.conversation_index_status(&registered.id).unwrap()[0]
                .last_success_at
                .is_some()
        );
        assert_eq!(
            reopened
                .list_conversation_sessions(&registered.id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn version_nine_adds_conversation_index_and_version_ten_preserves_existing_data() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta(key, value) VALUES ('schema_version', '8');
                 CREATE TABLE workspaces(id TEXT PRIMARY KEY);
                 CREATE TABLE workspace_storage(workspace_id TEXT PRIMARY KEY);
                 INSERT INTO workspaces(id) VALUES ('kept');",
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        let version: String = store
            .connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let tables: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('conversation_sessions', 'conversation_index_status')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let kept: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM workspaces WHERE id = 'kept'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "15");
        assert_eq!(tables, 2);
        assert_eq!(kept, 1);
    }

    #[test]
    fn version_nine_migration_is_safe_for_concurrent_open() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let seeded = Store::open(&database).unwrap();
        seeded
            .connection
            .execute_batch(
                "ALTER TABLE conversation_sessions DROP COLUMN origin;
                 ALTER TABLE conversation_sessions DROP COLUMN spawned_by_session_id;
                 ALTER TABLE conversation_sessions DROP COLUMN forked_from_session_id;
                 UPDATE schema_meta SET value='9' WHERE key='schema_version';",
            )
            .unwrap();
        drop(seeded);

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let database = database.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let store = Store::open(&database)?;
                    let version = store.connection.query_row(
                        "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?;
                    Ok::<String, anyhow::Error>(version)
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap().unwrap(), "15");
        }
    }

    #[test]
    fn wal_conversion_retries_reader_contention_and_has_a_deadline() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let reader = Connection::open(&database).unwrap();
        reader
            .execute_batch("CREATE TABLE sample(value); BEGIN; SELECT * FROM sample;")
            .unwrap();
        let writer = Connection::open(&database).unwrap();
        let started = std::time::Instant::now();
        let error = enable_wal(&writer, std::time::Duration::from_millis(30)).unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<rusqlite::Error>()
                .unwrap()
                .sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy)
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        let handle =
            std::thread::spawn(move || enable_wal(&writer, std::time::Duration::from_secs(2)));
        std::thread::sleep(std::time::Duration::from_millis(50));
        reader.execute_batch("ROLLBACK;").unwrap();
        handle.join().unwrap().unwrap();
        // An already-open connection can cache its previous journal mode.
        let reopened = Connection::open(&database).unwrap();
        assert_eq!(
            reopened
                .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "wal"
        );
    }

    #[test]
    fn new_database_is_safe_for_concurrent_open() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let database = database.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let store = Store::open(&database)?;
                    let version = store.connection.query_row(
                        "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                        [],
                        |row| row.get::<_, String>(0),
                    )?;
                    Ok::<String, anyhow::Error>(version)
                })
            })
            .collect();
        for handle in handles {
            assert_eq!(handle.join().unwrap().unwrap(), "15");
        }
    }

    #[test]
    fn version_ten_normalizes_legacy_workspace_timestamps_and_skips_unknown_providers() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta(key, value) VALUES ('schema_version', '9');
                 CREATE TABLE workspaces(
                   id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                   repository_group_id TEXT, manifest_workspace_id TEXT, status TEXT NOT NULL,
                   asset_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
                   last_active_at, last_discovered_at TEXT NOT NULL, last_scanned_at
                 );
                 CREATE TABLE workspace_sources(
                   workspace_id TEXT NOT NULL, agent TEXT NOT NULL, evidence TEXT NOT NULL,
                   session_count INTEGER NOT NULL DEFAULT 0, last_active_at,
                   PRIMARY KEY(workspace_id, agent, evidence)
                 );
                 CREATE TABLE insight_cursors(
                   provider TEXT PRIMARY KEY, cursor_json TEXT, available INTEGER NOT NULL DEFAULT 0,
                   quality TEXT NOT NULL, coverage_from TEXT, coverage_to TEXT,
                   imported_events INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL,
                   error_key TEXT, error_params TEXT NOT NULL DEFAULT '{}'
                 );",
            )
            .unwrap();
        let workspace_seconds = 1_700_000_000_i64;
        // Version 9 also includes the session tables, even though this fixture only
        // exercises workspace timestamps. Later additive migrations require them.
        connection
            .execute_batch(
                "CREATE TABLE conversation_sessions(
               id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, agent TEXT NOT NULL,
               title TEXT, created_at TEXT, updated_at TEXT, message_count INTEGER,
               git_branch TEXT, archived INTEGER NOT NULL DEFAULT 0,
               sidechain INTEGER NOT NULL DEFAULT 0, availability TEXT NOT NULL,
               last_indexed_at TEXT NOT NULL
             );
             CREATE TABLE conversation_index_status(
               workspace_id TEXT NOT NULL, agent TEXT NOT NULL, session_count INTEGER NOT NULL,
               last_attempt_at TEXT NOT NULL, last_success_at TEXT, error_key TEXT,
               error_detail TEXT, PRIMARY KEY(workspace_id,agent)
             );",
            )
            .unwrap();
        let source_milliseconds = 1_700_000_123_456_i64;
        let updated_at = Utc::now().to_rfc3339();

        connection
            .execute(
                "INSERT INTO workspaces(id, canonical_path, name, status, last_discovered_at, last_active_at, last_scanned_at)
                 VALUES (?1, ?2, ?3, 'healthy', ?4, ?5, ?6)",
                params![
                    "legacy",
                    "/tmp/legacy",
                    "Legacy",
                    updated_at,
                    workspace_seconds,
                    "not-a-time"
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspaces(id, canonical_path, name, status, last_discovered_at, last_active_at)
                 VALUES ('invalid', '/tmp/invalid', 'Invalid', 'healthy', ?1, 'not-a-time')",
                [updated_at.as_str()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspaces(id, canonical_path, name, status, last_discovered_at, last_active_at)
                 VALUES ('text-unix', '/tmp/text-unix', 'Text Unix', 'healthy', ?1, '1700000001')",
                [updated_at.as_str()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspaces(id, canonical_path, name, status, last_discovered_at, last_active_at)
                 VALUES ('empty', '/tmp/empty', 'Empty', 'healthy', ?1, NULL)",
                [updated_at.as_str()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspace_sources(workspace_id, agent, evidence, session_count, last_active_at)
                 VALUES ('legacy', 'codex', 'session-cwd', 3, ?1)",
                [source_milliseconds],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO insight_cursors(provider, cursor_json, available, quality, imported_events, updated_at)
                 VALUES ('codex', '{\"offset\":1}', 1, 'exact', 4, ?1)",
                [updated_at.as_str()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO insight_cursors(provider, cursor_json, available, quality, imported_events, updated_at)
                 VALUES ('gemini-cli', '{\"offset\":2}', 1, 'exact', 7, ?1)",
                [updated_at.as_str()],
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        let version: String = store
            .connection
            .query_row(
                "SELECT value FROM schema_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, "15");

        let workspace_type: String = store
            .connection
            .query_row(
                "SELECT typeof(last_active_at) FROM workspaces WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let source_type: String = store
            .connection
            .query_row(
                "SELECT typeof(last_active_at) FROM workspace_sources WHERE workspace_id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(workspace_type, "text");
        assert_eq!(source_type, "text");

        let expected_workspace = Utc.timestamp_opt(workspace_seconds, 0).single().unwrap();
        let expected_source = Utc
            .timestamp_opt(1_700_000_123, 456_000_000)
            .single()
            .unwrap();
        let workspaces = store.list_workspaces().unwrap();
        let legacy = workspaces
            .iter()
            .find(|value| value.id == "legacy")
            .unwrap();
        assert_eq!(legacy.last_active_at, Some(expected_workspace));
        assert!(legacy.last_scanned_at.is_none());
        assert_eq!(legacy.sources[0].last_active_at, Some(expected_source));
        assert!(
            workspaces
                .iter()
                .find(|value| value.id == "invalid")
                .unwrap()
                .last_active_at
                .is_none()
        );
        assert_eq!(
            workspaces
                .iter()
                .find(|value| value.id == "text-unix")
                .unwrap()
                .last_active_at,
            Some(Utc.timestamp_opt(1_700_000_001, 0).single().unwrap())
        );
        assert!(
            workspaces
                .iter()
                .find(|value| value.id == "empty")
                .unwrap()
                .last_active_at
                .is_none()
        );

        let statuses = store.insights_status(false).unwrap();
        assert_eq!(statuses.providers.len(), AgentKind::ALL.len());
        assert!(
            statuses
                .providers
                .iter()
                .any(|value| value.agent == AgentKind::Codex && value.available)
        );
        let cursors = store.insight_usage_cursors().unwrap();
        assert_eq!(
            cursors.get(&AgentKind::Codex),
            Some(&"{\"offset\":1}".to_string())
        );
        let unknown_rows: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM insight_cursors WHERE provider = 'gemini-cli'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unknown_rows, 1);
    }

    #[test]
    fn version_five_workspace_status_migrates_to_healthy() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta(key, value) VALUES ('schema_version', '5');
                 CREATE TABLE workspaces(
                   id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                   repository_group_id TEXT, manifest_workspace_id TEXT, status TEXT NOT NULL,
                   asset_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0,
                   last_active_at TEXT, last_discovered_at TEXT NOT NULL, last_scanned_at TEXT
                 );
                 INSERT INTO workspaces(id, canonical_path, name, status, last_discovered_at)
                   VALUES ('workspace', '/tmp/workspace', 'workspace', 'needs-import', '2026-08-13T00:00:00Z');",
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        let status: String = store
            .connection
            .query_row("SELECT status FROM workspaces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(status, "healthy");
    }

    #[test]
    fn version_six_migrates_quota_snapshot_without_touching_insights() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta(key, value) VALUES ('schema_version', '6');
                 CREATE TABLE usage_daily(date TEXT PRIMARY KEY, total_tokens INTEGER NOT NULL);
                 INSERT INTO usage_daily(date, total_tokens) VALUES ('2026-08-14', 42);",
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        let quota_table: bool = store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'quota_snapshot')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let token_total: i64 = store
            .connection
            .query_row("SELECT total_tokens FROM usage_daily", [], |row| row.get(0))
            .unwrap();
        assert!(quota_table);
        assert_eq!(token_total, 42);
    }

    #[test]
    fn version_eight_adds_workspace_storage_cache() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta(key, value) VALUES ('schema_version', '7');
                 CREATE TABLE workspaces(id TEXT PRIMARY KEY);",
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        let exists: bool = store
            .connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_storage')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(exists);
    }

    #[test]
    fn storage_failure_preserves_last_good_and_workspace_removal_cascades() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let registered = store.add_workspace(&workspace).unwrap();
        let now = Utc::now();
        let snapshot = WorkspaceStorage {
            workspace_id: registered.id.clone(),
            name: registered.name,
            path: registered.path,
            snapshot_version: 2,
            root: Some(agentkib_storage::StorageNode {
                id: "workspace:".into(),
                name: "workspace".into(),
                relative_path: PathBuf::new(),
                kind: agentkib_storage::StorageNodeKind::Workspace,
                allocated_bytes: 4096,
                logical_bytes: 1024,
                regenerable_bytes: 2048,
                agent_asset_bytes: 128,
                file_count: 2,
                directory_count: 1,
                child_count: 0,
                children: Vec::new(),
                expandable: false,
                partial: false,
            }),
            measurement: agentkib_storage::StorageMeasurement::AllocatedExact,
            quality: StorageQuality::Complete,
            allocated_bytes: 4096,
            logical_bytes: 1024,
            regenerable_bytes: 2048,
            agent_asset_bytes: 128,
            file_count: 2,
            directory_count: 1,
            breakdown: Vec::new(),
            last_attempt_at: now,
            last_success_at: Some(now),
            error_key: None,
            error_detail: None,
        };
        store.save_workspace_storage(&snapshot).unwrap();
        store
            .record_workspace_storage_failure(
                &registered.id,
                Utc::now(),
                "storage.scanUnavailable",
                Some("permission denied"),
            )
            .unwrap();

        let overview = store.storage_overview().unwrap();
        assert_eq!(overview.allocated_bytes, 4096);
        assert_eq!(overview.workspaces[0].quality, StorageQuality::Partial);
        assert_eq!(overview.workspaces[0].snapshot_version, 2);
        assert_eq!(overview.workspaces[0].root.as_ref().unwrap().file_count, 2);

        store.exclude_workspace(&registered.id).unwrap();
        let rows: i64 = store
            .connection
            .query_row("SELECT COUNT(*) FROM workspace_storage", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn legacy_storage_snapshot_remains_readable_without_recursive_root() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let registered = store.add_workspace(&workspace).unwrap();
        let now = Utc::now().to_rfc3339();
        let snapshot = serde_json::json!({
            "workspace_id": registered.id.clone(),
            "name": registered.name.clone(),
            "path": registered.path.clone(),
            "measurement": "logical-estimate",
            "quality": "complete",
            "allocated_bytes": 64,
            "logical_bytes": 64,
            "regenerable_bytes": 0,
            "agent_asset_bytes": 0,
            "file_count": 1,
            "directory_count": 0,
            "breakdown": [],
            "last_attempt_at": now,
            "last_success_at": now
        });
        store.connection.execute(
            "INSERT INTO workspace_storage(workspace_id, snapshot_json, last_attempt_at, last_success_at) VALUES (?1, ?2, ?3, ?3)",
            params![registered.id, snapshot.to_string(), now],
        ).unwrap();

        let overview = store.storage_overview().unwrap();

        assert_eq!(overview.workspaces[0].snapshot_version, 0);
        assert!(overview.workspaces[0].root.is_none());
        assert_eq!(overview.allocated_bytes, 64);
    }

    #[test]
    fn version_three_catalog_summaries_gain_translation_keys() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO schema_meta(key, value) VALUES ('schema_version', '3');
                 CREATE TABLE catalog_assets(
                   id TEXT PRIMARY KEY, scope TEXT NOT NULL, workspace_id TEXT, agent TEXT,
                   kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
                   summary TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, modified_at TEXT
                 );
                 INSERT INTO catalog_assets(id, scope, kind, name, path, summary)
                   VALUES ('asset', 'workspace', 'instruction', 'shared', '/project', 'AgentKib 公共指令');
                 CREATE TABLE insight_cursors(
                   provider TEXT PRIMARY KEY, cursor_json TEXT, available INTEGER NOT NULL DEFAULT 0,
                   quality TEXT NOT NULL, coverage_from TEXT, coverage_to TEXT,
                   imported_events INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT NOT NULL
                 );",
            )
            .unwrap();
        drop(connection);

        let store = Store::open(&database).unwrap();
        let assets = store.search_catalog_assets("", None, None, 10).unwrap();
        assert_eq!(
            assets[0].summary_key.as_deref(),
            Some("assets.summary.sharedInstructions")
        );
        assert!(assets[0].summary_params.is_empty());
    }

    #[test]
    fn current_schema_allows_concurrent_read_connections() {
        let dir = tempdir().unwrap();
        let database = dir.path().join("db.sqlite");
        Store::open(&database).unwrap();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let database = database.clone();
                std::thread::spawn(move || {
                    Store::open(&database).unwrap().list_workspaces().unwrap()
                })
            })
            .collect();
        for handle in handles {
            assert!(handle.join().unwrap().is_empty());
        }
    }

    #[test]
    fn quota_failure_preserves_last_good_snapshot_and_redacts_diagnostics() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let payload = br#"{
          "schemaVersion": 1,
          "generatedAt": "2026-08-14T02:00:00Z",
          "staleAfterSeconds": 180,
          "host": { "codexBarVersion": "0.49.5" },
          "providers": [{
            "id": "codex", "name": "Codex", "enabled": true,
            "source": "oauth", "windows": [{
              "kind": "session", "label": "5 hour", "usedPercent": 25,
              "remainingPercent": 75, "resetAt": "2026-08-14T05:00:00Z"
            }]
          }]
        }"#;
        let snapshot = agentkib_quota::parse_dashboard_snapshot(
            payload,
            QuotaBackend::CodexBarCli,
            Utc::now(),
        )
        .unwrap();
        store.save_quota_snapshot(&snapshot).unwrap();
        let last_success: String = store
            .connection
            .query_row(
                "SELECT last_success_at FROM quota_snapshot WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        store
            .record_quota_failure(
                QuotaBackend::CodexBarCli,
                "errors.quotaUnavailable",
                Some("Authorization: Bearer private-token"),
            )
            .unwrap();

        let retained = store.quota_snapshot().unwrap().unwrap();
        assert_eq!(retained.providers[0].id, "codex");
        assert_eq!(retained.freshness, agentkib_quota::QuotaFreshness::Stale);
        let retained_success: String = store
            .connection
            .query_row(
                "SELECT last_success_at FROM quota_snapshot WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_success, retained_success);
        let diagnostic: String = store
            .connection
            .query_row(
                "SELECT error_detail FROM quota_snapshot WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!diagnostic.contains("private-token"));
        assert!(diagnostic.contains("redacted"));
    }

    #[test]
    fn insights_are_idempotent_and_sensitive_identifiers_are_hashed() {
        let dir = tempdir().unwrap();
        let workspace = dir.path().join("workspace");
        fs::create_dir_all(workspace.join(".git")).unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        store
            .sync_discovery(&[candidate(&workspace)], &[], &[], Utc::now(), &[])
            .unwrap();
        let day = Local::now().date_naive();
        let batch = UsageBatch {
            events: vec![UsageEvent {
                source_key: "private-source-key".into(),
                surface_agent: AgentKind::Codex,
                workspace_path: Some(workspace.clone()),
                occurred_at: Some(Utc::now()),
                day: Some(day),
                model: Some("test-model".into()),
                input_tokens: 70,
                output_tokens: 30,
                cache_read_tokens: 10,
                cache_write_tokens: 0,
                reasoning_tokens: 5,
                total_tokens: 100,
                session_key: Some("private-session-id".into()),
                session_count: 1,
                date_precision: DatePrecision::Exact,
                quality: UsageQuality::Exact,
            }],
            status: ProviderStatus {
                agent: AgentKind::Codex,
                available: true,
                quality: UsageQuality::Exact,
                coverage_from: Some(day),
                coverage_to: Some(day),
                imported_events: 1,
                error_key: None,
                error_params: BTreeMap::new(),
                error: None,
            },
            cursor: None,
            unchanged: false,
        };
        let repository = GitRepositorySnapshot {
            repository_group_id: "repository".into(),
            path: workspace,
            fingerprint: "refs-v1".into(),
            changed: true,
            commits: vec![GitCommitRecord {
                hash: "commit-hash".into(),
                authored_at: Utc::now(),
                author_email: "private@example.com".into(),
            }],
            identities: vec![GitIdentityCandidate {
                email: "private@example.com".into(),
                label: "测试身份".into(),
                source: "test".into(),
            }],
            error: None,
        };
        for _ in 0..2 {
            store
                .sync_insights(
                    std::slice::from_ref(&batch),
                    std::slice::from_ref(&repository),
                )
                .unwrap();
        }
        let summary = store.insights_summary(&InsightsQuery::default()).unwrap();
        assert_eq!(summary.total_tokens, 100);
        assert_eq!(summary.my_commits, 1);
        assert_eq!(summary.attributed_commits, 0);
        let inferred_attributions: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM commit_attributions WHERE confidence = 'estimated'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(inferred_attributions, 0);
        let stored_source: String = store
            .connection
            .query_row("SELECT source_key FROM usage_events", [], |row| row.get(0))
            .unwrap();
        let stored_session: String = store
            .connection
            .query_row("SELECT session_hash FROM usage_events", [], |row| {
                row.get(0)
            })
            .unwrap();
        let stored_identity: String = store
            .connection
            .query_row("SELECT identity_hash FROM git_identities", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_ne!(stored_source, "private-source-key");
        assert_ne!(stored_session, "private-session-id");
        assert_ne!(stored_identity, "private@example.com");
    }

    #[test]
    fn streak_allows_yesterday_to_continue_current_run() {
        let today = NaiveDate::from_ymd_opt(2026, 8, 13).unwrap();
        let active = [
            NaiveDate::from_ymd_opt(2026, 8, 10).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 11).unwrap(),
            NaiveDate::from_ymd_opt(2026, 8, 12).unwrap(),
        ]
        .into_iter()
        .collect();
        assert_eq!(calculate_streaks(&active, today), (3, 3));
    }

    #[test]
    fn achievement_definitions_are_ordered_milestone_tracks() {
        let summary = InsightsSummary {
            total_tokens: 150_000_000_000,
            input_tokens: 0,
            output_tokens: 0,
            cache_tokens: 0,
            reasoning_tokens: 0,
            session_count: 2_181,
            my_commits: 1_763,
            all_commits: 0,
            attributed_commits: 0,
            active_days: 324,
            current_streak: 0,
            longest_streak: 19,
            quality: UsageQuality::Exact,
            coverage_from: None,
            coverage_to: None,
            refreshed_at: None,
        };
        let definitions = achievement_definitions(&summary, 4, 36);
        let thresholds = |category: &str| {
            definitions
                .iter()
                .filter(|value| value.category == category)
                .map(|value| (value.threshold, value.progress))
                .collect::<Vec<_>>()
        };

        assert_eq!(
            thresholds("token"),
            vec![
                (100_000, summary.total_tokens),
                (1_000_000, summary.total_tokens),
                (10_000_000, summary.total_tokens),
                (100_000_000, summary.total_tokens),
                (1_000_000_000, summary.total_tokens),
                (10_000_000_000, summary.total_tokens),
                (100_000_000_000, summary.total_tokens),
                (1_000_000_000_000, summary.total_tokens),
            ]
        );
        assert_eq!(thresholds("session").last(), Some(&(10_000, 2_181)));
        assert_eq!(thresholds("commit").last(), Some(&(10_000, 1_763)));
        assert_eq!(thresholds("active-days").last(), Some(&(1_000, 324)));
        assert_eq!(thresholds("streak").last(), Some(&(365, 19)));
        assert_eq!(thresholds("workspaces").last(), Some(&(100, 36)));
        assert_eq!(
            thresholds("agents"),
            vec![(1, 4), (2, 4), (3, 4), (4, 4), (5, 4)]
        );
        assert_eq!(definitions.len(), 45);
        assert_eq!(special_achievement_definitions().len(), 8);
    }

    #[test]
    fn achievement_refresh_does_not_overwrite_existing_unlocks() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        let original = "2025-01-02T00:00:00+00:00";
        store
            .connection
            .execute(
                "INSERT INTO achievement_unlocks(code, unlocked_at, rule_version) VALUES ('commit-1', ?1, 1)",
                params![original],
            )
            .unwrap();

        store.refresh_achievement_unlocks().unwrap();

        let unlocked_at: String = store
            .connection
            .query_row(
                "SELECT unlocked_at FROM achievement_unlocks WHERE code = 'commit-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unlocked_at, original);
    }

    #[test]
    fn milestone_unlock_days_follow_recorded_daily_usage() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        insert_usage_day(&store, "2026-01-01", "codex", "workspace-a", 6);
        insert_usage_day(&store, "2026-01-02", "codex", "workspace-b", 4);
        insert_usage_day(&store, "2026-01-03", "claude_code", "workspace-a", 1);

        assert_eq!(
            store.achievement_unlock_day("session", 10).unwrap(),
            NaiveDate::from_ymd_opt(2026, 1, 2)
        );
        assert_eq!(
            store.achievement_unlock_day("active-days", 3).unwrap(),
            NaiveDate::from_ymd_opt(2026, 1, 3)
        );
        assert_eq!(
            store.achievement_unlock_day("workspaces", 2).unwrap(),
            NaiveDate::from_ymd_opt(2026, 1, 2)
        );
        assert_eq!(
            store.achievement_unlock_day("agents", 2).unwrap(),
            NaiveDate::from_ymd_opt(2026, 1, 3)
        );
        assert_eq!(
            store.first_shared_workspace_day().unwrap(),
            NaiveDate::from_ymd_opt(2026, 1, 3)
        );
    }

    #[test]
    fn aggregate_milestones_remain_unlocked_without_a_fabricated_date() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        store
            .connection
            .execute(
                "INSERT INTO usage_events(source_key, surface_agent, total_tokens, session_count, date_precision, quality) VALUES ('aggregate', 'codex', 100000, 10, 'aggregate', 'estimated')",
                [],
            )
            .unwrap();

        store.refresh_achievement_unlocks().unwrap();

        let token = store
            .list_achievements()
            .unwrap()
            .into_iter()
            .find(|value| value.code == "token-100000")
            .unwrap();
        assert_eq!(token.progress, token.threshold);
        assert_eq!(token.unlocked_at, None);
        let rule_version: i64 = store
            .connection
            .query_row(
                "SELECT rule_version FROM achievement_unlocks WHERE code = 'token-100000'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rule_version, 0);
    }

    #[test]
    fn special_achievements_use_exact_local_evidence_and_stay_permanent() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("db.sqlite")).unwrap();
        store.audit(None, "changeset.apply", "changeset-1").unwrap();
        let memory = store
            .propose_memory(&MemoryProposal {
                project_id: "workspace-a".into(),
                memory_type: MemoryType::Decision,
                content: "Use the shared rule".into(),
                source_agent: Some("codex".into()),
                source_thread: None,
                source_reference: None,
            })
            .unwrap();
        store.approve_memory(&memory.id, None).unwrap();

        insert_usage_day(&store, "2026-01-01", "codex", "workspace-a", 1);
        insert_usage_day(&store, "2026-02-01", "claude_code", "workspace-a", 1);
        let night = Local
            .with_ymd_and_hms(2026, 2, 1, 2, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc);
        store
            .connection
            .execute(
                "INSERT INTO usage_events(source_key, surface_agent, workspace_id, occurred_at, day, total_tokens, session_count, date_precision, quality) VALUES ('night', 'codex', NULL, ?1, '2026-02-01', 1, 1, 'exact', 'exact')",
                params![night.to_rfc3339()],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO git_commits(repository_group_id, commit_hash, authored_at, day, author_identity_hash, is_mine) VALUES ('repo', 'commit', ?1, '2026-02-01', 'identity', 1)",
                params![night.to_rfc3339()],
            )
            .unwrap();
        store
            .connection
            .execute(
                "INSERT INTO commit_attributions(repository_group_id, commit_hash, agent, confidence, method) VALUES ('repo', 'commit', 'codex', 'estimated', 'time-correlation')",
                [],
            )
            .unwrap();

        store.refresh_achievement_unlocks().unwrap();
        let unlocked = |code: &str| {
            store
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM achievement_unlocks WHERE code = ?1)",
                    params![code],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap()
        };
        assert!(unlocked("special-first-changeset"));
        assert!(unlocked("special-first-memory"));
        assert!(unlocked("special-shared-workspace"));
        assert!(unlocked("special-night-owl"));
        assert!(unlocked("special-comeback"));
        assert!(unlocked("special-same-day-delivery"));
        assert!(!unlocked("special-exact-attribution"));

        store
            .connection
            .execute(
                "UPDATE commit_attributions SET confidence = 'exact' WHERE repository_group_id = 'repo' AND commit_hash = 'commit'",
                [],
            )
            .unwrap();
        store.refresh_achievement_unlocks().unwrap();
        assert!(unlocked("special-exact-attribution"));

        store
            .unlock_special_achievement("special-remote-handshake", night)
            .unwrap();
        assert!(unlocked("special-remote-handshake"));
        assert!(
            store
                .unlock_special_achievement("special-unknown", night)
                .is_err()
        );
    }
}
