use super::*;
use agentkib_insights::{
    CodexIncrementalDiagnostics, CodexIncrementalResult, CodexIncrementalState,
    collect_codex_incremental,
};

impl Store {
    /// Checkpoints contain salted source IDs and normalized usage, never transcript text.
    /// Parsing runs outside a write transaction. The checkpoint and its contributions
    /// are committed together, after checking no other refresher replaced the checkpoint.
    pub fn refresh_codex_insights(&self, home: &Path) -> Result<CodexIncrementalDiagnostics> {
        // A read transaction keeps the manifest and per-source rows from different
        // refreshers from being combined. Parsing itself runs after releasing it.
        let (saved, previous) = self.load_codex_checkpoint()?;
        let salt = self.insight_salt()?;
        let workspaces = self.workspace_path_index()?;
        let workspace_ids = workspaces
            .iter()
            .map(|(path, id)| {
                (
                    keyed_hash(
                        &salt,
                        platform_path::identity_path(path)
                            .as_os_str()
                            .as_encoded_bytes(),
                    ),
                    id.clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let result = collect_codex_incremental(
            home,
            &previous.clone().unwrap_or_default(),
            &|path| keyed_hash(&salt, path.as_os_str().as_encoded_bytes()),
            &|identity| workspace_ids.get(identity).cloned(),
        )?;
        self.commit_codex_incremental(saved.as_deref(), previous.is_none(), &result)?;
        Ok(result.diagnostics)
    }

    fn load_codex_checkpoint(&self) -> Result<(Option<String>, Option<CodexIncrementalState>)> {
        let tx = self.connection.unchecked_transaction()?;
        let saved: Option<String> = tx
            .query_row(
                "SELECT state_json FROM codex_incremental_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let previous = if let Some(manifest) = saved.as_deref().and_then(checkpoint_manifest) {
            let rows = checkpoint_rows(&tx)?;
            if manifest.get("sources").and_then(serde_json::Value::as_u64)
                == Some(rows.len() as u64)
            {
                restore_checkpoint(&rows).ok()
            } else {
                None
            }
        } else {
            // Version 14 stored the complete state in one JSON value. Keep reading
            // it until a successful refresh atomically installs the split format.
            saved
                .as_deref()
                .and_then(|json| serde_json::from_str(json).ok())
        };
        tx.commit()?;
        Ok((saved, previous))
    }

    fn commit_codex_incremental(
        &self,
        expected: Option<&str>,
        initialize: bool,
        result: &CodexIncrementalResult,
    ) -> Result<()> {
        if initialize && !result.initial_complete {
            bail!("Codex initial usage scan was incomplete; existing statistics were retained");
        }
        let tx = self.connection.unchecked_transaction()?;
        let current: Option<String> = tx
            .query_row(
                "SELECT state_json FROM codex_incremental_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        if current.as_deref() != expected {
            bail!("Codex usage checkpoint changed during collection; retry required");
        }
        let mut days = BTreeSet::<String>::new();
        let changed: BTreeSet<&str> = result.changed_sources.iter().map(String::as_str).collect();
        let removed: BTreeSet<&str> = result.removed_sources.iter().map(String::as_str).collect();
        if initialize {
            let mut query = tx.prepare("SELECT DISTINCT day FROM usage_events WHERE surface_agent = 'codex' AND day IS NOT NULL")?;
            for day in query.query_map([], |row| row.get::<_, String>(0))? {
                days.insert(day?);
            }
            tx.execute("DELETE FROM usage_events WHERE surface_agent = 'codex'", [])?;
        } else {
            for id in changed.union(&removed) {
                let mut query = tx.prepare("SELECT DISTINCT u.day FROM usage_events u JOIN insight_source_events s ON s.source_key = u.source_key WHERE s.source_id = ?1 AND u.day IS NOT NULL")?;
                for day in query.query_map([id], |row| row.get::<_, String>(0))? {
                    days.insert(day?);
                }
                tx.execute("DELETE FROM usage_events WHERE source_key IN (SELECT source_key FROM insight_source_events WHERE source_id = ?1)", [id])?;
            }
        }
        for event in result
            .events
            .iter()
            .filter(|event| initialize || changed.contains(event.source_id.as_str()))
        {
            if let Some(day) = event.day {
                days.insert(day.to_string());
            }
            tx.execute(
                "INSERT INTO usage_events(source_key, surface_agent, workspace_id, occurred_at, day, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, session_hash, session_count, date_precision, quality)
                 VALUES (?1, 'codex', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![event.source_key, event.workspace_id, event.occurred_at.map(|v| v.to_rfc3339()), event.day.map(|v| v.to_string()), event.model,
                    to_i64(event.input_tokens), to_i64(event.output_tokens), to_i64(event.cache_read_tokens), to_i64(event.cache_write_tokens), to_i64(event.reasoning_tokens),
                    to_i64(event.total_tokens), event.session_key, to_i64(event.session_count), enum_string(event.date_precision)?, enum_string(event.quality)?],
            )?;
            tx.execute(
                "INSERT INTO insight_source_events(source_id, source_key) VALUES (?1, ?2)",
                params![event.source_id, event.source_key],
            )?;
        }
        for day in &days {
            rebuild_codex_day(&tx, day)?;
        }
        if initialize || !result.unchanged || expected.and_then(checkpoint_manifest).is_none() {
            let next_rows = split_checkpoint(&result.state)?;
            let prior_rows = checkpoint_rows(&tx)?;
            for ((kind, id), json) in &next_rows {
                if prior_rows.get(&(kind.clone(), id.clone())) == Some(json) {
                    continue;
                }
                tx.execute(
                    "INSERT INTO codex_source_checkpoints(source_kind, source_id, state_json) VALUES (?1, ?2, ?3)
                     ON CONFLICT(source_kind, source_id) DO UPDATE SET state_json = excluded.state_json",
                    params![kind, id, json],
                )?;
            }
            for (kind, id) in prior_rows
                .keys()
                .filter(|key| !next_rows.contains_key(*key))
            {
                tx.execute("DELETE FROM codex_source_checkpoints WHERE source_kind = ?1 AND source_id = ?2", params![kind, id])?;
            }
            let manifest = serde_json::json!({
                "storage_version": 1,
                "generation": Uuid::new_v4().to_string(),
                "sources": next_rows.len(),
            });
            tx.execute("INSERT INTO codex_incremental_state(id, state_json) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json",
                [manifest.to_string()])?;
        }
        let status = &result.status;
        tx.execute(
            "INSERT INTO insight_cursors(provider, cursor_json, available, quality, coverage_from, coverage_to, imported_events, error, error_key, error_params, updated_at)
             VALUES ('codex', NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(provider) DO UPDATE SET cursor_json = NULL, available = excluded.available, quality = excluded.quality, coverage_from = excluded.coverage_from,
                coverage_to = excluded.coverage_to, imported_events = excluded.imported_events, error = excluded.error, error_key = excluded.error_key, error_params = excluded.error_params, updated_at = excluded.updated_at",
            params![status.available, enum_string(status.quality)?, status.coverage_from.map(|v| v.to_string()), status.coverage_to.map(|v| v.to_string()),
                to_i64(status.imported_events as u64), status.error, status.error_key, serde_json::to_string(&status.error_params)?, Utc::now().to_rfc3339()],
        )?;
        if !days.is_empty() {
            rebuild_commit_attributions(&tx)?;
        }
        tx.commit()?;
        if initialize || !changed.is_empty() || !removed.is_empty() {
            self.refresh_achievement_unlocks()?;
        }
        Ok(())
    }
}

type CheckpointRows = BTreeMap<(String, String), String>;

fn checkpoint_manifest(json: &str) -> Option<serde_json::Value> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    (value.get("storage_version")?.as_u64()? == 1 && value.get("generation")?.is_string())
        .then_some(value)
}

fn checkpoint_rows(connection: &Connection) -> Result<CheckpointRows> {
    let mut query = connection
        .prepare("SELECT source_kind, source_id, state_json FROM codex_source_checkpoints")?;
    let rows = query.query_map([], |row| Ok(((row.get(0)?, row.get(1)?), row.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<CheckpointRows>>()?)
}

fn split_checkpoint(state: &CodexIncrementalState) -> Result<CheckpointRows> {
    // Keep the parser's private state private: its serde format is the persisted
    // interface, and only the two source maps are partitioned by the Store.
    let value = serde_json::to_value(state)?;
    let mut rows = BTreeMap::new();
    for kind in ["files", "databases"] {
        for (id, state) in value
            .get(kind)
            .and_then(serde_json::Value::as_object)
            .context("Invalid Codex checkpoint source map")?
        {
            rows.insert((kind.to_string(), id.clone()), state.to_string());
        }
    }
    Ok(rows)
}

fn restore_checkpoint(rows: &CheckpointRows) -> Result<CodexIncrementalState> {
    let mut value = serde_json::json!({ "files": {}, "databases": {} });
    for ((kind, id), json) in rows {
        let sources = value
            .get_mut(kind)
            .and_then(serde_json::Value::as_object_mut)
            .context("Invalid Codex checkpoint source kind")?;
        sources.insert(id.clone(), serde_json::from_str(json)?);
    }
    Ok(serde_json::from_value(value)?)
}

fn rebuild_codex_day(connection: &Connection, day: &str) -> Result<()> {
    connection.execute(
        "DELETE FROM usage_daily WHERE surface_agent = 'codex' AND day = ?1",
        [day],
    )?;
    connection.execute(
        "INSERT INTO usage_daily(day, surface_agent, workspace_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens, session_count, quality)
         SELECT day, surface_agent, COALESCE(workspace_id, ''), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_write_tokens), SUM(reasoning_tokens), SUM(total_tokens), SUM(session_count),
            CASE MAX(CASE quality WHEN 'incomplete' THEN 2 WHEN 'estimated' THEN 1 ELSE 0 END) WHEN 2 THEN 'incomplete' WHEN 1 THEN 'estimated' ELSE 'exact' END
         FROM usage_events WHERE surface_agent = 'codex' AND day = ?1 AND date_precision != 'aggregate'
         GROUP BY day, surface_agent, COALESCE(workspace_id, '')", [day],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    fn event(tokens: u64) -> String {
        format!(
            "{{\"timestamp\":\"2026-09-09T00:00:00Z\",\"payload\":{{\"type\":\"token_count\",\"info\":{{\"model\":\"test-model\",\"last_token_usage\":{{\"total_tokens\":{tokens},\"input_tokens\":{tokens}}}}}}}}}\n"
        )
    }
    fn append(path: &Path, text: &str) {
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
        let modified =
            file.metadata().unwrap().modified().unwrap() + std::time::Duration::from_secs(1);
        file.set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    fn total(store: &Store) -> i64 {
        store.connection.query_row("SELECT COALESCE(SUM(total_tokens), 0) FROM usage_events WHERE surface_agent = 'codex'", [], |r| r.get(0)).unwrap()
    }
    fn saved(store: &Store) -> String {
        let (manifest, state) = store.load_codex_checkpoint().unwrap();
        serde_json::to_string(&(manifest, state)).unwrap()
    }
    fn fixture(root: &Path) -> (Store, PathBuf, PathBuf, PathBuf) {
        let home = root.join("codex");
        fs::create_dir_all(home.join("sessions")).unwrap();
        let a = home.join("sessions/a.jsonl");
        let b = home.join("sessions/b.jsonl");
        fs::write(&a, event(10)).unwrap();
        fs::write(&b, event(20)).unwrap();
        (Store::open(&root.join("store.sqlite")).unwrap(), home, a, b)
    }

    #[test]
    fn legacy_database_schema_does_not_block_initial_jsonl_or_append() {
        let dir = tempdir().unwrap();
        let (store, home, a, _) = fixture(dir.path());
        let legacy = Connection::open(home.join("state_0.sqlite")).unwrap();
        legacy
            .execute_batch("CREATE TABLE threads(id TEXT);")
            .unwrap();
        let initial = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(initial.read_errors, 0);
        assert_eq!(total(&store), 30);
        append(&a, &event(7));
        let next = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(next.read_errors, 0);
        assert_eq!(next.files_read, 1);
        assert_eq!(total(&store), 37);
    }

    #[cfg(windows)]
    #[test]
    fn missing_windows_cwd_preserves_project_mapping_across_path_spellings() {
        let dir = tempdir().unwrap();
        let (store, home, a, b) = fixture(dir.path());
        fs::remove_file(b).unwrap();
        let project = dir.path().join("MixedCaseProject");
        fs::create_dir(&project).unwrap();
        let workspace = store.add_workspace(&project).unwrap();
        let missing = project.join("removed-child");
        assert!(!missing.exists());
        assert!(
            platform_path::starts_with(&missing, &project),
            "missing={missing:?}, project={project:?}"
        );
        // Build valid spelling variants without doubling a verbatim prefix
        // that may already be present in the runner's temporary directory.
        let lexical = platform_path::canonicalize(&project)
            .unwrap()
            .join("removed-child")
            .to_string_lossy()
            .to_lowercase();
        for cwd in [
            lexical.clone(),
            lexical.replace('\\', "/"),
            format!(r"\\?\{}", lexical),
        ] {
            assert!(
                platform_path::starts_with(Path::new(&cwd), &project),
                "cwd={cwd:?}, project={project:?}, cwd_identity={:?}, project_identity={:?}",
                platform_path::identity(Path::new(&cwd)),
                platform_path::identity(&project),
            );
            fs::write(
                &a,
                format!(
                    "{}\n{}",
                    serde_json::json!({"type":"session_meta", "payload":{"cwd":cwd}}),
                    event(10)
                ),
            )
            .unwrap();
            let db = Connection::open(home.join("state_5.sqlite")).unwrap();
            db.execute_batch("CREATE TABLE IF NOT EXISTS threads(rollout_path TEXT, cwd TEXT, updated_at INTEGER, tokens_used INTEGER, model TEXT); DELETE FROM threads;").unwrap();
            db.execute(
                "INSERT INTO threads VALUES('missing.jsonl', ?1, 1788912000, 25, 'test')",
                [&cwd],
            )
            .unwrap();
            drop(db);
            store.refresh_codex_insights(&home).unwrap();
            let mapped: i64 = store.connection.query_row(
                "SELECT COUNT(*) FROM usage_events WHERE workspace_id = ?1 AND surface_agent = 'codex'",
                [&workspace.id], |row| row.get(0),
            ).unwrap();
            assert_eq!(mapped, 2, "{cwd}");
            assert_eq!(total(&store), 35);
        }
    }

    #[test]
    fn unreadable_database_still_blocks_initial_migration() {
        let dir = tempdir().unwrap();
        let (store, home, _, _) = fixture(dir.path());
        fs::write(home.join("state_0.sqlite"), "not sqlite").unwrap();
        store.connection.execute("INSERT INTO usage_events(source_key, surface_agent, total_tokens, session_count, date_precision, quality) VALUES ('legacy','codex',99,1,'aggregate','estimated')", []).unwrap();
        assert!(store.refresh_codex_insights(&home).is_err());
        assert_eq!(total(&store), 99);
        assert!(store.load_codex_checkpoint().unwrap().0.is_none());
    }

    #[test]
    fn checkpoint_write_failure_rolls_back_contributions_and_manifest() {
        let dir = tempdir().unwrap();
        let (store, home, a, _) = fixture(dir.path());
        store.refresh_codex_insights(&home).unwrap();
        let original = saved(&store);
        append(&a, &event(7));
        store.connection.execute_batch("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON codex_source_checkpoints BEGIN SELECT RAISE(ABORT, 'injected checkpoint failure'); END;").unwrap();
        assert!(store.refresh_codex_insights(&home).is_err());
        assert_eq!(total(&store), 30);
        assert_eq!(saved(&store), original);
        store
            .connection
            .execute_batch("DROP TRIGGER fail_checkpoint")
            .unwrap();
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(total(&store), 37);
    }

    #[test]
    fn ten_thousand_sources_only_write_one_checkpoint_for_one_append() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("codex");
        fs::create_dir_all(home.join("sessions")).unwrap();
        for index in 0..10_000 {
            fs::write(home.join(format!("sessions/{index}.jsonl")), event(1)).unwrap();
        }
        let store = Store::open(&dir.path().join("store.sqlite")).unwrap();
        store.refresh_codex_insights(&home).unwrap();
        store.connection.execute_batch("CREATE TABLE checkpoint_mutations(kind TEXT);
            CREATE TRIGGER checkpoint_insert AFTER INSERT ON codex_source_checkpoints BEGIN INSERT INTO checkpoint_mutations VALUES ('insert'); END;
            CREATE TRIGGER checkpoint_update AFTER UPDATE ON codex_source_checkpoints BEGIN INSERT INTO checkpoint_mutations VALUES ('update'); END;
            CREATE TRIGGER checkpoint_delete AFTER DELETE ON codex_source_checkpoints BEGIN INSERT INTO checkpoint_mutations VALUES ('delete'); END;").unwrap();
        let idle = store.refresh_codex_insights(&home).unwrap();
        let count = || {
            store
                .connection
                .query_row("SELECT COUNT(*) FROM checkpoint_mutations", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(idle.files_read, 0);
        assert_eq!(count(), 0);
        append(&home.join("sessions/1.jsonl"), &event(5));
        let next = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(next.files_read, 1);
        assert_eq!(count(), 1);
        let updates: i64 = store
            .connection
            .query_row(
                "SELECT COUNT(*) FROM checkpoint_mutations WHERE kind = 'update'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(updates, 1);
        assert_eq!(total(&store), 10_005);
        let manifest: String = store
            .connection
            .query_row(
                "SELECT state_json FROM codex_incremental_state WHERE id = 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(manifest.len() < 128);
        println!(
            "10,000-source checkpoint writes: idle=0; append updates=1, inserts=0, deletes=0; files read=1; bytes read={}; manifest bytes={}",
            next.bytes_read,
            manifest.len()
        );
    }

    #[test]
    fn version_fourteen_checkpoint_is_split_without_rereading_unchanged_sources() {
        let dir = tempdir().unwrap();
        let (store, home, _, _) = fixture(dir.path());
        store.refresh_codex_insights(&home).unwrap();
        let (_, state) = store.load_codex_checkpoint().unwrap();
        store
            .connection
            .execute(
                "UPDATE codex_incremental_state SET state_json = ?1",
                [serde_json::to_string(&state.unwrap()).unwrap()],
            )
            .unwrap();
        store.connection.execute_batch("DROP TABLE codex_source_checkpoints; UPDATE schema_meta SET value = '14' WHERE key = 'schema_version';").unwrap();
        drop(store);
        let store = Store::open(&dir.path().join("store.sqlite")).unwrap();
        let diagnostics = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(diagnostics.files_read, 0);
        assert_eq!(total(&store), 30);
        assert_eq!(checkpoint_rows(&store.connection).unwrap().len(), 2);
        let (manifest, restored) = store.load_codex_checkpoint().unwrap();
        assert!(checkpoint_manifest(manifest.as_deref().unwrap()).is_some());
        assert!(restored.is_some());
    }

    #[test]
    fn concurrent_checkpoint_replacement_rejects_stale_collection() {
        let dir = tempdir().unwrap();
        let (store, home, a, _) = fixture(dir.path());
        store.refresh_codex_insights(&home).unwrap();
        let (expected, previous) = store.load_codex_checkpoint().unwrap();
        let salt = store.insight_salt().unwrap();
        let stale = collect_codex_incremental(
            &home,
            &previous.unwrap(),
            &|p| keyed_hash(&salt, p.as_os_str().as_encoded_bytes()),
            &|_| None,
        )
        .unwrap();
        append(&a, &event(7));
        store.refresh_codex_insights(&home).unwrap();
        let current = saved(&store);
        assert!(
            store
                .commit_codex_incremental(expected.as_deref(), false, &stale)
                .is_err()
        );
        assert_eq!(saved(&store), current);
        assert_eq!(total(&store), 37);
    }

    #[test]
    fn ten_thousand_sources_only_write_the_appended_contribution() {
        let dir = tempdir().unwrap();
        let home = dir.path().join("codex");
        let sessions = home.join("sessions");
        fs::create_dir_all(&sessions).unwrap();
        for index in 0..10_000 {
            fs::write(sessions.join(format!("{index}.jsonl")), event(10)).unwrap();
        }
        let store = Store::open(&dir.path().join("store.sqlite")).unwrap();
        store.connection.execute_batch("CREATE TABLE mutations(kind TEXT);
            CREATE TRIGGER usage_insert AFTER INSERT ON usage_events BEGIN INSERT INTO mutations VALUES ('usage'); END;
            CREATE TRIGGER usage_delete AFTER DELETE ON usage_events BEGIN INSERT INTO mutations VALUES ('usage'); END;
            CREATE TRIGGER daily_insert AFTER INSERT ON usage_daily BEGIN INSERT INTO mutations VALUES ('daily'); END;
            CREATE TRIGGER daily_delete AFTER DELETE ON usage_daily BEGIN INSERT INTO mutations VALUES ('daily'); END;").unwrap();
        let counts = || {
            ["usage", "daily"].map(|kind| {
                store
                    .connection
                    .query_row(
                        "SELECT COUNT(*) FROM mutations WHERE kind = ?1",
                        [kind],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap()
            })
        };
        let cold = store.refresh_codex_insights(&home).unwrap();
        let cold_writes = counts();
        store
            .connection
            .execute("DELETE FROM mutations", [])
            .unwrap();
        let idle = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(counts(), [0, 0]);
        assert_eq!(idle.files_read, 0);
        append(&sessions.join("3141.jsonl"), &event(5));
        let appended = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(appended.files_read, 1);
        assert_eq!(counts(), [2, 2]);
        assert_eq!(total(&store), 100_005);
        eprintln!(
            "Codex Store 10k: cold files={} bytes={} usage/daily mutations={cold_writes:?}; idle files=0 bytes=0 mutations=[0, 0]; append files={} bytes={} mutations={:?}",
            cold.files_read,
            cold.bytes_read,
            appended.files_read,
            appended.bytes_read,
            counts()
        );
    }

    #[test]
    fn only_changed_source_is_written_and_restart_reuses_checkpoints() {
        let dir = tempdir().unwrap();
        let (store, home, a, _) = fixture(dir.path());
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(total(&store), 30);
        store.connection.execute_batch("CREATE TABLE mutations(source_key TEXT);
            CREATE TRIGGER usage_insert AFTER INSERT ON usage_events BEGIN INSERT INTO mutations VALUES (NEW.source_key); END;
            CREATE TRIGGER usage_delete AFTER DELETE ON usage_events BEGIN INSERT INTO mutations VALUES (OLD.source_key); END;").unwrap();
        let original = saved(&store);
        let idle = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(idle.files_read, 0);
        assert_eq!(saved(&store), original);
        assert_eq!(
            store
                .connection
                .query_row("SELECT COUNT(*) FROM mutations", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        append(&a, &event(5));
        let next = store.refresh_codex_insights(&home).unwrap();
        assert_eq!(next.files_read, 1);
        assert_eq!(total(&store), 35);
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(DISTINCT source_key) FROM mutations",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        drop(store);
        let reopened = Store::open(&dir.path().join("store.sqlite")).unwrap();
        assert_eq!(
            reopened.refresh_codex_insights(&home).unwrap().files_read,
            0
        );
        assert_eq!(total(&reopened), 35);
        let cache = saved(&reopened);
        assert!(!cache.contains(home.to_str().unwrap()));
        assert!(!cache.contains("token_count"));
    }

    #[test]
    fn failed_transaction_retains_checkpoint_and_totals_for_retry() {
        let dir = tempdir().unwrap();
        let (store, home, a, _) = fixture(dir.path());
        store.refresh_codex_insights(&home).unwrap();
        let original = saved(&store);
        append(&a, &event(7));
        store.connection.execute_batch("CREATE TRIGGER fail_insert BEFORE INSERT ON usage_events BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;").unwrap();
        assert!(store.refresh_codex_insights(&home).is_err());
        assert_eq!(saved(&store), original);
        assert_eq!(total(&store), 30);
        store
            .connection
            .execute_batch("DROP TRIGGER fail_insert")
            .unwrap();
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(total(&store), 37);
    }

    #[test]
    fn deleted_and_replaced_sources_update_contributions_without_duplicates() {
        let dir = tempdir().unwrap();
        let (store, home, a, b) = fixture(dir.path());
        store.refresh_codex_insights(&home).unwrap();
        fs::remove_file(&b).unwrap();
        fs::write(&a, event(3)).unwrap();
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(total(&store), 3);
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(total(&store), 3);
    }

    #[test]
    fn incomplete_initialization_keeps_legacy_data_and_corrupt_cache_rebuilds_atomically() {
        let dir = tempdir().unwrap();
        let (store, home, _, _) = fixture(dir.path());
        store.connection.execute("INSERT INTO usage_events(source_key, surface_agent, total_tokens, session_count, date_precision, quality) VALUES ('legacy','codex',99,1,'aggregate','estimated')", []).unwrap();
        let mut result = collect_codex_incremental(
            &home,
            &CodexIncrementalState::default(),
            &|p| keyed_hash("test", p.as_os_str().as_encoded_bytes()),
            &|_| None,
        )
        .unwrap();
        result.initial_complete = false;
        assert!(store.commit_codex_incremental(None, true, &result).is_err());
        assert_eq!(total(&store), 99);
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(total(&store), 30);
        store
            .connection
            .execute(
                "UPDATE codex_incremental_state SET state_json = 'damaged'",
                [],
            )
            .unwrap();
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(total(&store), 30);
    }

    #[test]
    fn fallback_only_updates_record_achievements_without_daily_rows() {
        let dir = tempdir().unwrap();
        let (store, home, _, _) = fixture(dir.path());
        let db = Connection::open(home.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads(rollout_path TEXT, cwd TEXT, updated_at INTEGER, tokens_used INTEGER, model TEXT);
            INSERT INTO threads VALUES('missing.jsonl', NULL, 1788912000, 1, 'test');").unwrap();
        store.refresh_codex_insights(&home).unwrap();
        db.execute("UPDATE threads SET tokens_used = 100000", [])
            .unwrap();
        store.refresh_codex_insights(&home).unwrap();
        assert_eq!(
            store
                .connection
                .query_row(
                    "SELECT COUNT(*) FROM achievement_unlocks WHERE code = 'token-100000'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn identity_discovery_reclassifies_commits_without_repository_changes() {
        let dir = tempdir().unwrap();
        let (store, home, _, _) = fixture(dir.path());
        let mut repo = GitRepositorySnapshot {
            repository_group_id: "test-repo".into(),
            path: home,
            fingerprint: "unchanged".into(),
            changed: true,
            commits: vec![agentkib_insights::GitCommitRecord {
                hash: "commit".into(),
                authored_at: Utc::now(),
                author_email: "test@example.invalid".into(),
            }],
            identities: vec![],
            error: None,
        };
        store.sync_insights(&[], &[repo.clone()]).unwrap();
        assert_eq!(
            store
                .insights_summary(&InsightsQuery::default())
                .unwrap()
                .my_commits,
            0
        );
        repo.changed = false;
        repo.commits.clear();
        repo.identities
            .push(agentkib_insights::GitIdentityCandidate {
                email: "test@example.invalid".into(),
                label: "test".into(),
                source: "git-config".into(),
            });
        store.sync_insights(&[], &[repo]).unwrap();
        assert_eq!(
            store
                .insights_summary(&InsightsQuery::default())
                .unwrap()
                .my_commits,
            1
        );
    }
}
