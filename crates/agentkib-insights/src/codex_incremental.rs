//! Durable Codex parsing checkpoints. Paths and JSONL text never enter the cache.
use super::*;
use std::io::{Seek, SeekFrom};

const PARSER_VERSION: u32 = 2;
const BOUNDARY_BYTES: u64 = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CodexUsageEvent {
    /// Salted JSONL/SQLite source identity used for per-source replacement.
    pub source_id: String,
    /// Already salted by the caller; do not hash these identities a second time.
    pub source_key: String,
    pub session_key: Option<String>,
    pub workspace_id: Option<String>,
    pub occurred_at: Option<DateTime<Utc>>,
    pub day: Option<NaiveDate>,
    pub model: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub reasoning_tokens: u64,
    pub total_tokens: u64,
    pub session_count: u64,
    pub date_precision: DatePrecision,
    pub quality: UsageQuality,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodexIncrementalState {
    files: BTreeMap<String, FileState>,
    databases: BTreeMap<String, DatabaseState>,
}

impl CodexIncrementalState {
    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.databases.is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CodexIncrementalDiagnostics {
    pub files_seen: usize,
    pub files_read: usize,
    pub files_rebuilt: usize,
    pub bytes_read: u64,
    pub databases_read: usize,
    pub files_removed: usize,
    pub read_errors: usize,
}

#[derive(Debug, Clone)]
pub struct CodexIncrementalResult {
    pub state: CodexIncrementalState,
    /// A complete normalized snapshot, suitable for an atomic replacement with state.
    pub events: Vec<CodexUsageEvent>,
    pub status: ProviderStatus,
    pub unchanged: bool,
    pub diagnostics: CodexIncrementalDiagnostics,
    pub changed_sources: Vec<String>,
    pub removed_sources: Vec<String>,
    /// Safe to replace a legacy full snapshot on the first collection.
    pub initial_complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileStamp {
    size: u64,
    modified_ns: u128,
    identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileState {
    parser_version: u32,
    stamp: FileStamp,
    complete_offset: u64,
    boundary_fingerprint: String,
    workspace_ancestors: Vec<String>,
    session_counted: bool,
    /// A None model means inferred from SQLite; retain that distinction for reclassification.
    aggregates: Vec<CachedEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedEvent {
    event: CodexUsageEvent,
    workspace_ancestors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DatabaseState {
    parser_version: u32,
    fingerprint: String,
    models: BTreeMap<String, String>,
    fallbacks: Vec<CachedEvent>,
}

/// `identify_path` must use the installation's durable salted hash. The workspace
/// resolver maps hashed roots to stored IDs; only hashed ancestors enter the cache.
/// Enumeration failures preserve missing entries; a file read failure preserves its
/// last complete checkpoint and totals so the next run retries from the same offset.
pub fn collect_codex_incremental(
    home: &Path,
    previous: &CodexIncrementalState,
    identify_path: &dyn Fn(&Path) -> String,
    resolve_workspace_identity: &dyn Fn(&str) -> Option<String>,
) -> Result<CodexIncrementalResult> {
    if !home.is_dir() {
        bail!("Codex Home is unavailable");
    }
    let mut state = previous.clone();
    let mut diagnostics = CodexIncrementalDiagnostics::default();
    let mut changed = false;
    let mut seen = BTreeSet::new();
    let mut enumeration_complete = true;
    let sessions = home.join("sessions");
    match fs::metadata(&sessions) {
        Ok(metadata) if metadata.is_dir() => {
            for entry in WalkDir::new(&sessions).follow_links(false) {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        enumeration_complete = false;
                        diagnostics.read_errors += 1;
                        continue;
                    }
                };
                if !entry.file_type().is_file()
                    || entry.path().extension().is_none_or(|ext| ext != "jsonl")
                {
                    continue;
                }
                diagnostics.files_seen += 1;
                let id = identify_source(entry.path(), identify_path);
                seen.insert(id.clone());
                let stamp = match file_stamp(entry.path()) {
                    Ok(stamp) => stamp,
                    Err(_) => {
                        diagnostics.read_errors += 1;
                        continue;
                    }
                };
                let old = state.files.get(&id);
                if old.is_some_and(|old| old.parser_version == PARSER_VERSION && old.stamp == stamp)
                {
                    continue;
                }
                match read_session(
                    entry.path(),
                    &id,
                    stamp,
                    old,
                    identify_path,
                    &mut diagnostics,
                ) {
                    Ok(next) => {
                        state.files.insert(id, next);
                        changed = true;
                    }
                    Err(_) => diagnostics.read_errors += 1,
                }
            }
        }
        Ok(_) => {
            enumeration_complete = false;
            diagnostics.read_errors += 1;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            enumeration_complete = false;
            diagnostics.read_errors += 1;
        }
    }
    if enumeration_complete {
        let before = state.files.len();
        state.files.retain(|id, _| seen.contains(id));
        diagnostics.files_removed = before - state.files.len();
        changed |= diagnostics.files_removed > 0;
    }

    let mut seen_databases = BTreeSet::new();
    let mut databases_complete = true;
    match fs::read_dir(home) {
        Ok(entries) => {
            for entry in entries {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(_) => {
                        databases_complete = false;
                        diagnostics.read_errors += 1;
                        continue;
                    }
                };
                let path = entry.path();
                if !entry.file_name().to_string_lossy().starts_with("state_")
                    || path.extension().is_none_or(|ext| ext != "sqlite")
                {
                    continue;
                }
                let id = identify_source(&path, identify_path);
                seen_databases.insert(id.clone());
                let fingerprint = match database_fingerprint(&path) {
                    Ok(value) => value,
                    Err(_) => {
                        diagnostics.read_errors += 1;
                        continue;
                    }
                };
                if state.databases.get(&id).is_some_and(|old| {
                    old.parser_version == PARSER_VERSION && old.fingerprint == fingerprint
                }) {
                    continue;
                }
                diagnostics.databases_read += 1;
                match read_database(home, &path, &id, fingerprint, identify_path) {
                    Ok(Some(next)) => {
                        state.databases.insert(id, next);
                        changed = true;
                    }
                    Ok(None) if !state.databases.contains_key(&id) => {
                        // Legacy schemas that never supplied a checkpoint cannot
                        // contribute usage. They must not block importing JSONL.
                    }
                    Ok(None) => diagnostics.read_errors += 1,
                    Err(_) => diagnostics.read_errors += 1,
                }
            }
        }
        Err(_) => {
            databases_complete = false;
            diagnostics.read_errors += 1;
        }
    }
    if databases_complete {
        let before = state.databases.len();
        state.databases.retain(|id, _| seen_databases.contains(id));
        changed |= before != state.databases.len();
    }

    for cached in state
        .files
        .values_mut()
        .flat_map(|file| file.aggregates.iter_mut())
        .chain(
            state
                .databases
                .values_mut()
                .flat_map(|database| database.fallbacks.iter_mut()),
        )
    {
        let workspace_id = cached
            .workspace_ancestors
            .iter()
            .find_map(|id| resolve_workspace_identity(id));
        changed |= cached.event.workspace_id != workspace_id;
        cached.event.workspace_id = workspace_id;
    }
    let events = materialize_events(&state);
    let (changed_sources, removed_sources) = if changed {
        let before = event_fingerprints(&materialize_events(previous));
        let after = event_fingerprints(&events);
        (
            after
                .iter()
                .filter(|(id, hash)| before.get(*id) != Some(*hash))
                .map(|(id, _)| id.clone())
                .collect(),
            before
                .keys()
                .filter(|id| !after.contains_key(*id))
                .cloned()
                .collect(),
        )
    } else {
        (Vec::new(), Vec::new())
    };
    let quality = if diagnostics.read_errors > 0 {
        UsageQuality::Incomplete
    } else {
        events
            .iter()
            .map(|event| event.quality)
            .max_by_key(|quality| quality_rank(*quality))
            .unwrap_or(UsageQuality::Exact)
    };
    let status = ProviderStatus {
        agent: AgentKind::Codex,
        available: true,
        quality,
        coverage_from: events.iter().filter_map(|event| event.day).min(),
        coverage_to: events.iter().filter_map(|event| event.day).max(),
        imported_events: events.len(),
        error_key: (diagnostics.read_errors > 0).then(|| "errors.providerUnavailable".into()),
        error_params: BTreeMap::new(),
        // Do not copy filesystem errors: they can contain private paths.
        error: (diagnostics.read_errors > 0)
            .then(|| "Some Codex sources could not be read; prior data retained".into()),
    };
    let initial_complete = diagnostics.read_errors == 0;
    Ok(CodexIncrementalResult {
        state,
        events,
        status,
        unchanged: !changed,
        diagnostics,
        changed_sources,
        removed_sources,
        initial_complete,
    })
}

fn materialize_events(state: &CodexIncrementalState) -> Vec<CodexUsageEvent> {
    let mut models = BTreeMap::new();
    for database in state.databases.values() {
        models.extend(database.models.clone());
    }
    let mut aggregates = BTreeMap::new();
    let mut detailed_sessions = BTreeSet::new();
    for (id, file) in &state.files {
        for raw in &file.aggregates {
            let mut event = raw.event.clone();
            if event.model.is_none() {
                event.model = models.get(id).cloned();
            }
            merge_event(&mut aggregates, event);
            detailed_sessions.insert(id.clone());
        }
    }
    let mut events: Vec<_> = aggregates.into_values().collect();
    let mut fallbacks = BTreeMap::new();
    for database in state.databases.values() {
        for event in database.fallbacks.iter().map(|cached| &cached.event) {
            if event
                .session_key
                .as_ref()
                .is_none_or(|id| !detailed_sessions.contains(id))
            {
                // Multiple database versions can describe the same rollout. Match the
                // previous Store upsert semantics, using the same order as model lookup.
                fallbacks.insert(event.source_key.clone(), event.clone());
            }
        }
    }
    events.extend(fallbacks.into_values());
    events
}

fn event_fingerprints(events: &[CodexUsageEvent]) -> BTreeMap<String, String> {
    let mut hashes = BTreeMap::<String, Sha256>::new();
    for event in events {
        hashes
            .entry(event.source_id.clone())
            .or_default()
            .update(serde_json::to_vec(event).expect("normalized event serialization"));
    }
    hashes
        .into_iter()
        .map(|(id, hash)| (id, format!("{:x}", hash.finalize())))
        .collect()
}

fn file_stamp(path: &Path) -> Result<FileStamp> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() {
        bail!("Source is not a regular file");
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(not(unix))]
    let identity = format!("{:?}", metadata.created().ok());
    Ok(FileStamp {
        size: metadata.len(),
        modified_ns: metadata
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos(),
        identity,
    })
}

fn boundary_fingerprint(
    file: &mut File,
    offset: u64,
    diagnostics: &mut CodexIncrementalDiagnostics,
) -> Result<String> {
    let start = offset.saturating_sub(BOUNDARY_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = vec![0; (offset - start) as usize];
    file.read_exact(&mut bytes)?;
    diagnostics.bytes_read += bytes.len() as u64;
    Ok(format!("{:x}", Sha256::digest(&bytes)))
}

fn read_session(
    path: &Path,
    id: &str,
    stamp: FileStamp,
    old: Option<&FileState>,
    identify_path: &dyn Fn(&Path) -> String,
    diagnostics: &mut CodexIncrementalDiagnostics,
) -> Result<FileState> {
    let mut file = File::open(path)?;
    diagnostics.files_read += 1;
    let mut append = old.is_some_and(|old| {
        old.parser_version == PARSER_VERSION
            && old.stamp.identity == stamp.identity
            && stamp.size > old.stamp.size
            && old.complete_offset <= stamp.size
    });
    if let Some(old) = old.filter(|_| append) {
        append = boundary_fingerprint(&mut file, old.complete_offset, diagnostics)?
            == old.boundary_fingerprint;
    }
    let mut next = if append {
        old.expect("append requires a prior state").clone()
    } else {
        diagnostics.files_rebuilt += 1;
        FileState {
            parser_version: PARSER_VERSION,
            stamp: stamp.clone(),
            complete_offset: 0,
            boundary_fingerprint: String::new(),
            workspace_ancestors: Vec::new(),
            session_counted: false,
            aggregates: Vec::new(),
        }
    };
    let mut aggregates = BTreeMap::new();
    for event in std::mem::take(&mut next.aggregates) {
        merge_cached_event(&mut aggregates, event);
    }
    file.seek(SeekFrom::Start(next.complete_offset))?;
    // Limit to the metadata snapshot: concurrent appends are collected next time.
    let mut reader = BufReader::new(file.take(stamp.size - next.complete_offset));
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader.read_until(b'\n', &mut line)?;
        diagnostics.bytes_read += read as u64;
        if read == 0 || line.last() != Some(&b'\n') {
            break;
        }
        next.complete_offset += read as u64;
        parse_line(&line, id, &mut next, &mut aggregates, identify_path);
    }
    let mut file = reader.into_inner().into_inner();
    next.boundary_fingerprint = boundary_fingerprint(&mut file, next.complete_offset, diagnostics)?;
    // Replacement/truncation during a read must never commit a mixed checkpoint.
    let after = file_stamp(path)?;
    if after.identity != stamp.identity
        || after.size < stamp.size
        || (after.size == stamp.size && after.modified_ns != stamp.modified_ns)
    {
        bail!("Codex source changed during parsing");
    }
    next.stamp = stamp;
    next.aggregates = aggregates.into_values().collect();
    Ok(next)
}

type AggregateKey = (
    Option<String>,
    Option<NaiveDate>,
    Option<String>,
    Option<String>,
);

fn merge_event(aggregates: &mut BTreeMap<AggregateKey, CodexUsageEvent>, event: CodexUsageEvent) {
    let key = (
        event.session_key.clone(),
        event.day,
        event.model.clone(),
        event.workspace_id.clone(),
    );
    let aggregate = aggregates.entry(key).or_insert_with(|| {
        let mut aggregate = event.clone();
        // All identity inputs are normalized; raw paths never enter source keys.
        aggregate.source_key = format!(
            "{:x}",
            Sha256::digest(
                format!(
                    "codex-session:{}:{}:{}:{}",
                    event.session_key.as_deref().unwrap_or_default(),
                    event.day.map(|day| day.to_string()).unwrap_or_default(),
                    event.model.as_deref().unwrap_or_default(),
                    event.workspace_id.as_deref().unwrap_or_default()
                )
                .as_bytes()
            )
        );
        aggregate.input_tokens = 0;
        aggregate.output_tokens = 0;
        aggregate.cache_read_tokens = 0;
        aggregate.cache_write_tokens = 0;
        aggregate.reasoning_tokens = 0;
        aggregate.total_tokens = 0;
        aggregate.session_count = 0;
        aggregate
    });
    aggregate.occurred_at = aggregate.occurred_at.max(event.occurred_at);
    aggregate.input_tokens = aggregate.input_tokens.saturating_add(event.input_tokens);
    aggregate.output_tokens = aggregate.output_tokens.saturating_add(event.output_tokens);
    aggregate.cache_read_tokens = aggregate
        .cache_read_tokens
        .saturating_add(event.cache_read_tokens);
    aggregate.cache_write_tokens = aggregate
        .cache_write_tokens
        .saturating_add(event.cache_write_tokens);
    aggregate.reasoning_tokens = aggregate
        .reasoning_tokens
        .saturating_add(event.reasoning_tokens);
    aggregate.total_tokens = aggregate.total_tokens.saturating_add(event.total_tokens);
    aggregate.session_count = aggregate.session_count.saturating_add(event.session_count);
}

fn parse_line(
    line: &[u8],
    id: &str,
    state: &mut FileState,
    aggregates: &mut BTreeMap<AggregateKey, CachedEvent>,
    identify_path: &dyn Fn(&Path) -> String,
) {
    let Ok(text) = std::str::from_utf8(line) else {
        return;
    };
    if !text.contains("token_count") && !text.contains("session_meta") {
        return;
    }
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return;
    };
    if value.pointer("/payload/type").and_then(Value::as_str) == Some("session_meta")
        || value.get("type").and_then(Value::as_str) == Some("session_meta")
    {
        state.workspace_ancestors = value
            .pointer("/payload/cwd")
            .or_else(|| value.pointer("/cwd"))
            .and_then(Value::as_str)
            .map(|path| workspace_ancestors(Path::new(path), identify_path))
            .unwrap_or_default();
        return;
    }
    if value.pointer("/payload/type").and_then(Value::as_str) != Some("token_count") {
        return;
    }
    let Some(usage) = value
        .pointer("/payload/info/last_token_usage")
        .or_else(|| value.pointer("/payload/last_token_usage"))
    else {
        return;
    };
    let total_tokens = json_u64(usage, "total_tokens");
    if total_tokens == 0 {
        return;
    }
    let occurred_at = value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_datetime);
    let model = value
        .pointer("/payload/info/model")
        .or_else(|| value.pointer("/payload/model"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_owned);
    merge_cached_event(
        aggregates,
        CachedEvent {
            event: CodexUsageEvent {
                source_id: id.into(),
                source_key: String::new(),
                session_key: Some(id.into()),
                workspace_id: None,
                occurred_at,
                day: occurred_at.map(local_day),
                model,
                input_tokens: json_u64(usage, "input_tokens"),
                output_tokens: json_u64(usage, "output_tokens"),
                cache_read_tokens: json_u64(usage, "cached_input_tokens"),
                cache_write_tokens: 0,
                reasoning_tokens: json_u64(usage, "reasoning_output_tokens"),
                total_tokens,
                session_count: u64::from(!state.session_counted),
                date_precision: DatePrecision::Exact,
                quality: UsageQuality::Exact,
            },
            workspace_ancestors: state.workspace_ancestors.clone(),
        },
    );
    state.session_counted = true;
}

fn database_fingerprint(path: &Path) -> Result<String> {
    let mut hasher = Sha256::new();
    for path in [
        path.to_path_buf(),
        PathBuf::from(format!("{}-wal", path.display())),
    ] {
        match file_stamp(&path) {
            Ok(stamp) => hasher.update(serde_json::to_vec(&stamp)?),
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
            {
                hasher.update(b"missing")
            }
            Err(error) => return Err(error),
        }
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn read_database(
    home: &Path,
    path: &Path,
    id: &str,
    fingerprint: String,
    identify_path: &dyn Fn(&Path) -> String,
) -> Result<Option<DatabaseState>> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let columns = connection
        .prepare("PRAGMA table_info(threads)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<BTreeSet<_>>>()?;
    if !["rollout_path", "cwd", "updated_at", "tokens_used", "model"]
        .iter()
        .all(|column| columns.contains(*column))
    {
        // This is an unsupported legacy schema, not an unreadable SQLite file.
        // The caller retains any previously imported contribution on schema loss.
        return Ok(None);
    }
    let mut statement = connection
        .prepare("SELECT rollout_path, cwd, updated_at, tokens_used, model FROM threads")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut state = DatabaseState {
        parser_version: PARSER_VERSION,
        fingerprint,
        models: BTreeMap::new(),
        fallbacks: Vec::new(),
    };
    for row in rows {
        let (rollout, cwd, updated, total, model) = row?;
        let session = rollout.as_deref().map(Path::new).map(|path| {
            identify_source(
                &if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    home.join(path)
                },
                identify_path,
            )
        });
        if let (Some(session), Some(model)) = (
            &session,
            model
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty()),
        ) {
            state.models.insert(session.clone(), model.into());
        }
        if total <= 0 {
            continue;
        }
        state.fallbacks.push(CachedEvent {
            event: CodexUsageEvent {
                source_id: id.into(),
                source_key: format!(
                    "{:x}",
                    Sha256::digest(
                        format!("codex-fallback:{}", session.as_deref().unwrap_or(id)).as_bytes()
                    )
                ),
                session_key: session,
                workspace_id: None,
                occurred_at: Utc.timestamp_opt(updated, 0).single(),
                day: None,
                model,
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                reasoning_tokens: 0,
                total_tokens: total as u64,
                session_count: 1,
                date_precision: DatePrecision::Aggregate,
                quality: UsageQuality::Incomplete,
            },
            workspace_ancestors: cwd
                .as_deref()
                .map(|cwd| workspace_ancestors(Path::new(cwd), identify_path))
                .unwrap_or_default(),
        });
    }
    // Keep the pre-query fingerprint. SQLite supplies a consistent read snapshot;
    // concurrent writes (or a newly created WAL) therefore trigger another read next time.
    Ok(Some(state))
}

fn identify_source(path: &Path, identify_path: &dyn Fn(&Path) -> String) -> String {
    // Path equality treats Windows slash variants equally, but hashing raw OS bytes
    // does not. SQLite paths and WalkDir must feed the same spelling to the hasher.
    // Do not canonicalize: missing rollouts still need a stable fallback identity.
    identify_path(&path.components().collect::<PathBuf>())
}

fn workspace_ancestors(path: &Path, identify_path: &dyn Fn(&Path) -> String) -> Vec<String> {
    // Workspace roots use canonical paths in Store. Resolve aliases before hashing,
    // with the same lexical fallback as legacy matching for a removed cwd.
    let normalized =
        agentkib_platform::path::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    normalized.ancestors().map(identify_path).collect()
}

fn merge_cached_event(aggregates: &mut BTreeMap<AggregateKey, CachedEvent>, cached: CachedEvent) {
    let key = (
        cached.event.session_key.clone(),
        cached.event.day,
        cached.event.model.clone(),
        cached.workspace_ancestors.first().cloned(),
    );
    if let Some(existing) = aggregates.get_mut(&key) {
        // Same raw cwd identity and explicit model, even if it currently maps to no workspace.
        let mut merged = BTreeMap::new();
        let mut next = cached.event;
        next.workspace_id = existing.event.workspace_id.clone();
        merge_event(&mut merged, existing.event.clone());
        merge_event(&mut merged, next);
        existing.event = merged.into_values().next().expect("one aggregate");
    } else {
        aggregates.insert(key, cached);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::{TempDir, tempdir};

    fn identify(path: &Path) -> String {
        let mut hash = Sha256::new();
        hash.update(b"test-installation-salt");
        hash.update(
            path.components()
                .collect::<PathBuf>()
                .as_os_str()
                .as_encoded_bytes(),
        );
        format!("{:x}", hash.finalize())
    }

    fn workspace(_: &str) -> Option<String> {
        Some("workspace-id".into())
    }

    #[cfg(windows)]
    #[test]
    fn windows_source_identity_normalizes_separators_before_raw_hashing() {
        let raw_hash =
            |path: &Path| format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()));
        // Neither path needs to exist: SQLite fallback rows can reference removed logs.
        let native = Path::new(r"C:\codex\sessions\missing.jsonl");
        let mixed = Path::new(r"C:\codex\sessions/missing.jsonl");
        assert_ne!(raw_hash(native), raw_hash(mixed));
        assert_eq!(
            identify_source(native, &raw_hash),
            identify_source(mixed, &raw_hash)
        );
    }

    fn collect(home: &Path, state: &CodexIncrementalState) -> CodexIncrementalResult {
        collect_codex_incremental(home, state, &identify, &workspace).unwrap()
    }

    fn token(total: u64, model: Option<&str>) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": "2026-08-13T10:00:00Z", "type": "event_msg",
                "payload": { "type": "token_count", "info": {
                    "model": model,
                    "last_token_usage": { "input_tokens": total / 2, "output_tokens": total - total / 2,
                        "total_tokens": total, "cached_input_tokens": 2, "reasoning_output_tokens": 3 },
                    "total_token_usage": { "total_tokens": 99999999 }
                }}
            })
        )
    }

    fn fixture() -> (TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        let path = dir.path().join("sessions/session.jsonl");
        let meta =
            serde_json::json!({"type": "session_meta", "payload": {"cwd": "/private/workspace"}});
        fs::write(&path, format!("{meta}\n{}", token(100, None))).unwrap();
        (dir, path)
    }

    fn append(path: &Path, text: &str) {
        let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    fn total(result: &CodexIncrementalResult) -> u64 {
        result.events.iter().map(|event| event.total_tokens).sum()
    }

    fn database(home: &Path, rollout: &Path) -> Connection {
        let conn = Connection::open(home.join("state_5.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE threads (rollout_path TEXT, cwd TEXT, updated_at INTEGER NOT NULL, tokens_used INTEGER NOT NULL, model TEXT);").unwrap();
        conn.execute(
            "INSERT INTO threads VALUES (?1, '/private/workspace', 1786615200, 4000, 'model-a')",
            [rollout.to_string_lossy().as_ref()],
        )
        .unwrap();
        conn
    }

    #[test]
    fn cold_append_and_restart_match_full_import_without_private_cache_content() {
        let (dir, path) = fixture();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        assert_eq!(total(&first), 100);
        assert_eq!(first.diagnostics.files_read, 1);
        assert_eq!(first.changed_sources, vec![identify(&path)]);
        let serialized = serde_json::to_string(&first.state).unwrap();
        for forbidden in [
            "/private/workspace",
            "session.jsonl",
            "session_meta",
            "token_count",
            "last_token_usage",
        ] {
            assert!(!serialized.contains(forbidden), "cache leaked {forbidden}");
        }
        let reloaded = serde_json::from_str(&serialized).unwrap();
        let unchanged = collect(dir.path(), &reloaded);
        assert!(unchanged.unchanged);
        assert_eq!(unchanged.diagnostics.files_read, 0);
        assert_eq!(unchanged.diagnostics.bytes_read, 0);
        append(&path, &token(50, None));
        let next = collect(dir.path(), &reloaded);
        assert_eq!(next.diagnostics.files_rebuilt, 0);
        assert_eq!(total(&next), 150);
        assert_eq!(
            next.events
                .iter()
                .map(|event| event.session_count)
                .sum::<u64>(),
            1
        );
        let full = CodexProvider {
            home: Some(dir.path().to_path_buf()),
        }
        .import(None)
        .unwrap();
        assert_eq!(full.events.len(), next.events.len());
        for (full, incremental) in full.events.iter().zip(&next.events) {
            assert_eq!(full.total_tokens, incremental.total_tokens);
            assert_eq!(full.input_tokens, incremental.input_tokens);
            assert_eq!(full.cache_read_tokens, incremental.cache_read_tokens);
            assert_eq!(full.reasoning_tokens, incremental.reasoning_tokens);
            assert_eq!(full.session_count, incremental.session_count);
            assert_eq!(full.day, incremental.day);
        }
    }

    #[test]
    fn lexical_rollout_variants_merge_with_raw_identity_callback() {
        let (dir, _) = fixture();
        drop(database(
            dir.path(),
            &dir.path().join("sessions/./session.jsonl"),
        ));
        let raw_hash =
            |path: &Path| format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()));
        let result = collect_codex_incremental(
            dir.path(),
            &CodexIncrementalState::default(),
            &raw_hash,
            &workspace,
        )
        .unwrap();
        assert_eq!(total(&result), 100);
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].model.as_deref(), Some("model-a"));
    }

    #[test]
    fn trailing_partial_line_is_only_counted_after_completion() {
        let (dir, path) = fixture();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        let line = token(70, None);
        let split = line.len() / 2;
        append(&path, &line[..split]);
        let partial = collect(dir.path(), &first.state);
        assert_eq!(total(&partial), 100);
        assert_eq!(
            partial.state.files[&identify(&path)].complete_offset,
            first.state.files[&identify(&path)].complete_offset
        );
        let idle = collect(dir.path(), &partial.state);
        assert_eq!(idle.diagnostics.bytes_read, 0);
        append(&path, &line[split..]);
        let complete = collect(dir.path(), &idle.state);
        assert_eq!(total(&complete), 170);
        assert_eq!(complete.diagnostics.files_rebuilt, 0);
        append(&path, "not json\n{broken}\n");
        append(&path, &token(30, Some("explicit-model")));
        let malformed = collect(dir.path(), &complete.state);
        assert_eq!(total(&malformed), 200);
        assert_eq!(malformed.events.len(), 2);
    }

    #[test]
    fn truncation_replacement_and_boundary_change_rebuild_only_the_file() {
        let (dir, path) = fixture();
        let other = dir.path().join("sessions/other.jsonl");
        fs::write(&other, token(11, None)).unwrap();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        fs::write(&path, token(20, None)).unwrap();
        let truncated = collect(dir.path(), &first.state);
        assert_eq!(total(&truncated), 31);
        assert_eq!(truncated.diagnostics.files_read, 1);
        assert_eq!(truncated.diagnostics.files_rebuilt, 1);
        let replacement = dir.path().join("replacement");
        fs::write(
            &replacement,
            format!("{}{}", token(31, None), token(29, None)),
        )
        .unwrap();
        fs::rename(replacement, &path).unwrap();
        let replaced = collect(dir.path(), &truncated.state);
        assert_eq!(total(&replaced), 71);
        assert_eq!(replaced.diagnostics.files_rebuilt, 1);
        // Rewrite in place and grow, keeping inode: the old offset boundary detects this.
        fs::write(
            &path,
            format!("{}{}{}", token(42, None), token(12, None), token(8, None)),
        )
        .unwrap();
        let rewritten = collect(dir.path(), &replaced.state);
        assert_eq!(total(&rewritten), 73);
        assert_eq!(rewritten.diagnostics.files_rebuilt, 1);
    }

    #[test]
    fn parser_version_invalidates_only_affected_source() {
        let (dir, path) = fixture();
        let mut first = collect(dir.path(), &CodexIncrementalState::default());
        first
            .state
            .files
            .get_mut(&identify(&path))
            .unwrap()
            .parser_version = 0;
        let next = collect(dir.path(), &first.state);
        assert_eq!(next.diagnostics.files_rebuilt, 1);
        assert_eq!(total(&next), 100);
    }

    #[test]
    fn v1_database_checkpoint_rebuilds_raw_rollout_identity_without_double_counting() {
        let (dir, path) = fixture();
        let rollout = dir.path().join("sessions/./session.jsonl");
        drop(database(dir.path(), &rollout));
        let raw_hash =
            |path: &Path| format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()));
        let collect_raw = |state: &CodexIncrementalState| {
            collect_codex_incremental(dir.path(), state, &raw_hash, &workspace).unwrap()
        };
        let mut prior = collect_raw(&CodexIncrementalState::default()).state;
        let old_session = raw_hash(&rollout);
        assert_ne!(old_session, identify_source(&path, &raw_hash));
        for file in prior.files.values_mut() {
            file.parser_version = 1;
        }
        for database in prior.databases.values_mut() {
            database.parser_version = 1;
            database.models.clear();
            database
                .models
                .insert(old_session.clone(), "model-a".into());
            for fallback in &mut database.fallbacks {
                fallback.event.session_key = Some(old_session.clone());
                fallback.event.source_key = format!(
                    "{:x}",
                    Sha256::digest(format!("codex-fallback:{old_session}").as_bytes())
                );
            }
        }
        // Simulate a persisted v1 checkpoint without changing the source fingerprints.
        let prior = serde_json::from_str(&serde_json::to_string(&prior).unwrap()).unwrap();
        let next = collect_raw(&prior);
        assert_eq!(next.diagnostics.databases_read, 1);
        assert_eq!(next.diagnostics.files_rebuilt, 1);
        assert_eq!(next.events.len(), 1);
        assert_eq!(total(&next), 100);
        assert_eq!(next.events[0].model.as_deref(), Some("model-a"));
        assert_eq!(
            next.events[0].session_key,
            Some(identify_source(&path, &raw_hash))
        );
        let idle = collect_raw(&next.state);
        assert!(idle.unchanged);
        assert_eq!(idle.diagnostics.databases_read, 0);
        assert_eq!(idle.diagnostics.files_read, 0);
        assert_eq!(total(&idle), 100);
    }

    #[test]
    fn deletion_requires_successful_enumeration_and_errors_keep_previous_data() {
        let (dir, path) = fixture();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        fs::rename(dir.path().join("sessions"), dir.path().join("parked")).unwrap();
        fs::write(
            dir.path().join("sessions"),
            "temporarily inaccessible directory",
        )
        .unwrap();
        let failed = collect(dir.path(), &first.state);
        assert_eq!(total(&failed), 100);
        assert!(!failed.initial_complete);
        assert_eq!(failed.diagnostics.files_removed, 0);
        fs::remove_file(dir.path().join("sessions")).unwrap();
        fs::rename(dir.path().join("parked"), dir.path().join("sessions")).unwrap();
        fs::remove_file(&path).unwrap();
        let removed = collect(dir.path(), &failed.state);
        assert_eq!(total(&removed), 0);
        assert_eq!(removed.removed_sources, vec![identify(&path)]);
        assert_eq!(removed.diagnostics.files_removed, 1);
    }

    #[test]
    fn model_and_wal_updates_reclassify_without_reading_logs_and_fallbacks_do_not_double_count() {
        let (dir, path) = fixture();
        let connection = database(dir.path(), &path);
        connection
            .execute_batch("PRAGMA journal_mode=WAL;")
            .unwrap();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        assert_eq!(total(&first), 100);
        assert_eq!(first.events[0].model.as_deref(), Some("model-a"));
        connection
            .execute("UPDATE threads SET model='model-b'", [])
            .unwrap();
        let changed = collect(dir.path(), &first.state);
        assert_eq!(changed.diagnostics.files_read, 0);
        assert_eq!(changed.diagnostics.databases_read, 1);
        assert_eq!(changed.events[0].model.as_deref(), Some("model-b"));
        assert_eq!(changed.changed_sources, vec![identify(&path)]);
        append(&path, &token(20, Some("explicit-model")));
        let explicit = collect(dir.path(), &changed.state);
        connection
            .execute("UPDATE threads SET model='model-c'", [])
            .unwrap();
        let reclassified = collect(dir.path(), &explicit.state);
        assert_eq!(reclassified.diagnostics.files_read, 0);
        assert!(
            reclassified
                .events
                .iter()
                .any(|event| event.model.as_deref() == Some("explicit-model"))
        );
        assert!(
            reclassified
                .events
                .iter()
                .any(|event| event.model.as_deref() == Some("model-c"))
        );
        fs::remove_file(path).unwrap();
        let fallback = collect(dir.path(), &reclassified.state);
        assert_eq!(total(&fallback), 4000);
        assert_eq!(fallback.events[0].date_precision, DatePrecision::Aggregate);
        let serialized = serde_json::to_string(&fallback.state).unwrap();
        assert!(!serialized.contains("/private/workspace"));
    }

    #[test]
    fn schema_loss_retains_prior_database_contribution_and_retries() {
        let (dir, path) = fixture();
        let connection = database(dir.path(), &path);
        let first = collect(dir.path(), &CodexIncrementalState::default());
        connection
            .execute_batch(
                "ALTER TABLE threads RENAME TO saved_threads; CREATE TABLE threads(id TEXT);",
            )
            .unwrap();
        let failed = collect(dir.path(), &first.state);
        assert_eq!(failed.diagnostics.read_errors, 1);
        assert!(!failed.initial_complete);
        assert_eq!(failed.events[0].model.as_deref(), Some("model-a"));
        connection
            .execute_batch("DROP TABLE threads; ALTER TABLE saved_threads RENAME TO threads;")
            .unwrap();
        let recovered = collect(dir.path(), &failed.state);
        assert_eq!(recovered.diagnostics.read_errors, 0);
        assert_eq!(recovered.diagnostics.databases_read, 1);
        assert_eq!(total(&recovered), 100);
    }

    #[test]
    fn failed_database_read_preserves_prior_models_and_is_retried() {
        let (dir, path) = fixture();
        drop(database(dir.path(), &path));
        let first = collect(dir.path(), &CodexIncrementalState::default());
        fs::write(dir.path().join("state_5.sqlite"), b"temporarily corrupt").unwrap();
        let failed = collect(dir.path(), &first.state);
        assert_eq!(failed.events[0].model.as_deref(), Some("model-a"));
        assert_eq!(failed.diagnostics.read_errors, 1);
        let retry = collect(dir.path(), &failed.state);
        assert_eq!(retry.diagnostics.databases_read, 1);
        fs::remove_file(dir.path().join("state_5.sqlite")).unwrap();
        let removed = collect(dir.path(), &retry.state);
        assert_eq!(removed.diagnostics.files_read, 0);
        assert_eq!(removed.events[0].model, None);
    }

    #[test]
    fn workspace_changes_remap_deepest_ancestor_without_reading_sources() {
        let (dir, path) = fixture();
        // Preserve separate cwd identities even when both currently map to one root.
        append(
            &path,
            "{\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/private/other\"}}\n",
        );
        append(&path, &token(20, None));
        let connection = database(dir.path(), &dir.path().join("sessions/missing.jsonl"));
        drop(connection);
        let root = identify(Path::new("/private"));
        let child = identify(Path::new("/private/workspace"));
        let initial = collect_codex_incremental(
            dir.path(),
            &CodexIncrementalState::default(),
            &identify,
            &|hash| (hash == root).then(|| "root-workspace".into()),
        )
        .unwrap();
        assert_eq!(
            initial
                .events
                .iter()
                .filter(|event| event.date_precision == DatePrecision::Exact)
                .count(),
            1
        );
        let mapped = collect_codex_incremental(dir.path(), &initial.state, &identify, &|hash| {
            if hash == child {
                Some("child-workspace".into())
            } else if hash == root {
                Some("root-workspace".into())
            } else {
                None
            }
        })
        .unwrap();
        assert_eq!(mapped.diagnostics.files_read, 0);
        assert_eq!(mapped.diagnostics.databases_read, 0);
        assert!(!mapped.unchanged);
        assert_eq!(mapped.changed_sources.len(), 2);
        assert_eq!(
            mapped
                .events
                .iter()
                .filter(|event| event.date_precision == DatePrecision::Exact)
                .count(),
            2
        );
        assert!(
            mapped
                .events
                .iter()
                .any(
                    |event| event.workspace_id.as_deref() == Some("child-workspace")
                        && event.total_tokens == 100
                )
        );
        let removed =
            collect_codex_incremental(dir.path(), &mapped.state, &identify, &|_| None).unwrap();
        assert_eq!(removed.diagnostics.bytes_read, 0);
        assert!(
            removed
                .events
                .iter()
                .all(|event| event.workspace_id.is_none())
        );
        assert!(!removed.unchanged);
        let serialized = serde_json::to_string(&removed.state).unwrap();
        assert!(!serialized.contains("/private"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_cwd_maps_to_canonical_workspace_for_logs_and_fallbacks() {
        let (dir, path) = fixture();
        let root = dir.path().join("real-workspace");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let alias = dir.path().join("workspace-alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        let cwd = alias.join("nested");
        fs::write(
            &path,
            format!(
                "{}\n{}",
                serde_json::json!({
                    "type": "session_meta", "payload": {"cwd": cwd}
                }),
                token(100, None)
            ),
        )
        .unwrap();
        let connection = database(dir.path(), &dir.path().join("sessions/missing.jsonl"));
        connection
            .execute(
                "UPDATE threads SET cwd=?1",
                [cwd.to_string_lossy().as_ref()],
            )
            .unwrap();
        drop(connection);
        let canonical_root = agentkib_platform::path::canonicalize(&root).unwrap();
        let expected_identity = identify(&canonical_root);
        let first = collect_codex_incremental(
            dir.path(),
            &CodexIncrementalState::default(),
            &identify,
            &|hash| (hash == expected_identity).then(|| "canonical-workspace".into()),
        )
        .unwrap();
        assert_eq!(first.events.len(), 2);
        assert!(
            first
                .events
                .iter()
                .all(|event| event.workspace_id.as_deref() == Some("canonical-workspace"))
        );
        let serialized = serde_json::to_string(&first.state).unwrap();
        assert!(!serialized.contains("workspace-alias"));
        assert!(!serialized.contains("real-workspace"));
        let idle = collect_codex_incremental(dir.path(), &first.state, &identify, &|hash| {
            (hash == expected_identity).then(|| "canonical-workspace".into())
        })
        .unwrap();
        assert!(idle.unchanged);
        assert_eq!(idle.diagnostics.bytes_read, 0);
        // Missing paths retain the lexical fallback used by Store's old matcher.
        let missing = alias.join("does-not-exist");
        assert_eq!(
            workspace_ancestors(&missing, &identify).first(),
            Some(&identify(&missing))
        );
    }

    #[test]
    fn full_and_incremental_agree_across_models_days_and_database_fallback() {
        let (dir, path) = fixture();
        let conn = database(dir.path(), &path);
        conn.execute("INSERT INTO threads VALUES (?1, '/private/workspace', 1786615200, 250, 'fallback-model')", [dir.path().join("sessions/missing.jsonl").to_string_lossy().as_ref()]).unwrap();
        drop(conn);
        let first = collect(dir.path(), &CodexIncrementalState::default());
        // Explicit and inferred model-a must merge, but retain enough information for later reclassification.
        append(&path, &token(20, Some("model-a")));
        append(
            &path,
            &token(30, Some("model-b")).replace("2026-08-13", "2026-08-14"),
        );
        let next = collect(dir.path(), &first.state);
        let full = CodexProvider {
            home: Some(dir.path().to_path_buf()),
        }
        .import(None)
        .unwrap();
        let summarize = |session: Option<String>,
                         day: Option<NaiveDate>,
                         model: Option<String>,
                         occurred: Option<DateTime<Utc>>,
                         input: u64,
                         output: u64,
                         cache: u64,
                         reasoning: u64,
                         total: u64,
                         count: u64,
                         precision: DatePrecision,
                         quality: UsageQuality| {
            (
                format!("{session:?}:{day:?}:{model:?}"),
                serde_json::json!({
                    "occurred": occurred, "input":input, "output":output,"cache":cache,"reasoning":reasoning,
                    "total":total,"count":count,"precision":precision,"quality":quality
                }),
            )
        };
        let full: BTreeMap<_, _> = full
            .events
            .into_iter()
            .map(|event| {
                summarize(
                    event.session_key.map(|path| identify(Path::new(&path))),
                    event.day,
                    event.model,
                    event.occurred_at,
                    event.input_tokens,
                    event.output_tokens,
                    event.cache_read_tokens,
                    event.reasoning_tokens,
                    event.total_tokens,
                    event.session_count,
                    event.date_precision,
                    event.quality,
                )
            })
            .collect();
        let incremental: BTreeMap<_, _> = next
            .events
            .into_iter()
            .map(|event| {
                summarize(
                    event.session_key,
                    event.day,
                    event.model,
                    event.occurred_at,
                    event.input_tokens,
                    event.output_tokens,
                    event.cache_read_tokens,
                    event.reasoning_tokens,
                    event.total_tokens,
                    event.session_count,
                    event.date_precision,
                    event.quality,
                )
            })
            .collect();
        assert_eq!(full, incremental);
    }

    #[test]
    fn replacement_with_same_length_and_timestamp_uses_file_identity() {
        let (dir, path) = fixture();
        fs::write(&path, token(20, None)).unwrap();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let replacement = dir.path().join("replacement");
        fs::write(&replacement, token(40, None)).unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&replacement)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        assert_eq!(
            fs::metadata(&replacement).unwrap().len(),
            fs::metadata(&path).unwrap().len()
        );
        fs::rename(replacement, &path).unwrap();
        let next = collect(dir.path(), &first.state);
        assert_eq!(total(&next), 40);
        assert_eq!(next.diagnostics.files_rebuilt, 1);
    }

    #[test]
    fn multiple_database_versions_have_one_fallback_per_session() {
        let (dir, path) = fixture();
        drop(database(dir.path(), &path));
        let first_db = dir.path().join("state_5.sqlite");
        let second_db = dir.path().join("state_6.sqlite");
        fs::copy(&first_db, &second_db).unwrap();
        let conn = Connection::open(&second_db).unwrap();
        conn.execute("UPDATE threads SET tokens_used=123, model='model-b'", [])
            .unwrap();
        drop(conn);
        fs::remove_file(&path).unwrap();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        assert_eq!(first.events.len(), 1);
        let winner_is_second = identify(&second_db) > identify(&first_db);
        assert_eq!(total(&first), if winner_is_second { 123 } else { 4000 });
        let winner = if winner_is_second {
            &second_db
        } else {
            &first_db
        };
        let loser = if winner_is_second {
            &first_db
        } else {
            &second_db
        };
        fs::remove_file(winner).unwrap();
        let next = collect(dir.path(), &first.state);
        assert_eq!(next.events.len(), 1);
        assert_eq!(next.changed_sources, vec![identify(loser)]);
        assert_eq!(next.removed_sources, vec![identify(winner)]);
    }

    #[cfg(unix)]
    #[test]
    fn file_read_error_does_not_advance_checkpoint() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, path) = fixture();
        let first = collect(dir.path(), &CodexIncrementalState::default());
        append(&path, &token(10, None));
        fs::set_permissions(&path, fs::Permissions::from_mode(0o000)).unwrap();
        if File::open(&path).is_ok() {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            return; // Elevated test users bypass permissions.
        }
        let failed = collect(dir.path(), &first.state);
        assert_eq!(total(&failed), 100);
        assert_eq!(
            failed.state.files[&identify(&path)].complete_offset,
            first.state.files[&identify(&path)].complete_offset
        );
        assert!(!failed.initial_complete);
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let recovered = collect(dir.path(), &failed.state);
        assert_eq!(total(&recovered), 110);
    }

    #[test]
    fn ten_thousand_files_read_zero_bodies_when_idle_and_only_one_when_appending() {
        let dir = tempdir().unwrap();
        let sessions = dir.path().join("sessions");
        fs::create_dir(&sessions).unwrap();
        let line = token(10, None);
        for index in 0..10_000 {
            fs::write(sessions.join(format!("{index}.jsonl")), &line).unwrap();
        }
        let first = collect(dir.path(), &CodexIncrementalState::default());
        assert_eq!(first.diagnostics.files_read, 10_000);
        assert_eq!(total(&first), 100_000);
        let idle = collect(dir.path(), &first.state);
        assert_eq!(idle.diagnostics.files_seen, 10_000);
        assert_eq!(idle.diagnostics.files_read, 0);
        assert_eq!(idle.diagnostics.bytes_read, 0);
        assert!(idle.changed_sources.is_empty());
        let active = sessions.join("3141.jsonl");
        append(&active, &line);
        let next = collect(dir.path(), &idle.state);
        assert_eq!(next.diagnostics.files_read, 1);
        assert_eq!(next.diagnostics.files_rebuilt, 0);
        assert!(next.diagnostics.bytes_read <= line.len() as u64 + 2 * BOUNDARY_BYTES);
        assert_eq!(next.changed_sources, vec![identify(&active)]);
        assert_eq!(total(&next), 100_010);
        eprintln!(
            "Codex 10k fixture: cold files_read={} bytes_read={}; idle files_read={} bytes_read={}; append files_read={} bytes_read={}",
            first.diagnostics.files_read,
            first.diagnostics.bytes_read,
            idle.diagnostics.files_read,
            idle.diagnostics.bytes_read,
            next.diagnostics.files_read,
            next.diagnostics.bytes_read,
        );
    }
}
