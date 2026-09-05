use std::cmp::Ordering as VersionOrdering;
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration as StdDuration;

use agentkib_core::{
    AgentKind, AgentToolAction, AgentToolActionKind, AgentToolActionMode, AgentToolCacheStatus,
    AgentToolChannel, AgentToolEnvironment, AgentToolExecutionResult, AgentToolExecutionStatus,
    AgentToolInstallation, AgentToolShell, AgentToolSnapshot, AgentToolState, AgentToolStatus,
};
use agentkib_platform::command;
use agentkib_platform::fs::atomic_write;
use agentkib_platform::path as platform_path;
use agentkib_platform::process::{ProcessTree, configure_process_group};
use anyhow::{Context, Result, bail, ensure};
use chrono::{DateTime, Duration, Utc};
use futures_util::{StreamExt, stream};
use reqwest::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::Mutex;

const CACHE_TTL_HOURS: i64 = 6;
const FETCH_CONCURRENCY: usize = 4;
const PROBE_TIMEOUT: StdDuration = StdDuration::from_secs(2);
const EXECUTION_TIMEOUT: StdDuration = StdDuration::from_secs(5 * 60);
const MAX_PROBE_OUTPUT: u64 = 64 * 1024;
const MAX_EXECUTION_OUTPUT: u64 = 256 * 1024;
const VERIFY_RETRIES: usize = 3;
const VERIFY_RETRY_DELAY: StdDuration = StdDuration::from_millis(750);

static EXECUTION_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SNAPSHOT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone)]
struct DetectedInstallation {
    public: AgentToolInstallation,
    executable_path: PathBuf,
    manager_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedVersion {
    version: String,
    checked_at: DateTime<Utc>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct VersionCache {
    #[serde(default)]
    versions: BTreeMap<String, CachedVersion>,
}

#[derive(Debug, Clone, Copy)]
enum LatestSource {
    Github {
        repository: &'static str,
        prefix: &'static str,
    },
    Npm {
        package: &'static str,
    },
    CursorInstaller,
    HomebrewCask {
        token: &'static str,
    },
    HomebrewFormula {
        token: &'static str,
    },
}

impl LatestSource {
    fn key(self) -> String {
        match self {
            Self::Github { repository, .. } => format!("github:{repository}"),
            Self::Npm { package } => format!("npm:{package}"),
            Self::CursorInstaller => "cursor:installer".to_owned(),
            Self::HomebrewCask { token } => format!("homebrew-cask:{token}"),
            Self::HomebrewFormula { token } => format!("homebrew-formula:{token}"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ToolSpec {
    agent: AgentKind,
    commands: &'static [&'static str],
    version_args: &'static [&'static str],
    upstream: LatestSource,
    official_url: &'static str,
    release_url: Option<&'static str>,
}

const TOOL_SPECS: [ToolSpec; 7] = [
    ToolSpec {
        agent: AgentKind::Codex,
        commands: &["codex"],
        version_args: &["--version"],
        upstream: LatestSource::Github {
            repository: "openai/codex",
            prefix: "rust-v",
        },
        official_url: "https://learn.chatgpt.com/docs/codex/cli",
        release_url: Some("https://github.com/openai/codex/releases"),
    },
    ToolSpec {
        agent: AgentKind::ClaudeCode,
        commands: &["claude"],
        version_args: &["--version"],
        upstream: LatestSource::Npm {
            package: "@anthropic-ai/claude-code",
        },
        official_url: "https://code.claude.com/docs/en/setup",
        release_url: None,
    },
    ToolSpec {
        agent: AgentKind::Cursor,
        commands: &["cursor-agent", "agent"],
        version_args: &["--version"],
        upstream: LatestSource::CursorInstaller,
        official_url: "https://cursor.com/docs/cli/installation",
        release_url: Some("https://cursor.com/download"),
    },
    ToolSpec {
        agent: AgentKind::OpenCode,
        commands: &["opencode"],
        version_args: &["--version"],
        upstream: LatestSource::Github {
            repository: "anomalyco/opencode",
            prefix: "v",
        },
        official_url: "https://opencode.ai/docs/",
        release_url: Some("https://github.com/anomalyco/opencode/releases"),
    },
    ToolSpec {
        agent: AgentKind::OpenClaw,
        commands: &["openclaw"],
        version_args: &["--version"],
        upstream: LatestSource::Npm {
            package: "openclaw",
        },
        official_url: "https://docs.openclaw.ai/install",
        release_url: Some("https://github.com/openclaw/openclaw/releases"),
    },
    ToolSpec {
        agent: AgentKind::Hermes,
        commands: &["hermes"],
        version_args: &["--version"],
        upstream: LatestSource::Github {
            repository: "NousResearch/hermes-agent",
            prefix: "v",
        },
        official_url: "https://hermes-agent.nousresearch.com/docs/",
        release_url: Some("https://github.com/NousResearch/hermes-agent/releases"),
    },
    ToolSpec {
        agent: AgentKind::GrokBuild,
        commands: &["grok"],
        version_args: &["--version"],
        upstream: LatestSource::Github {
            repository: "xai-org/grok-build",
            prefix: "v",
        },
        official_url: "https://docs.x.ai/build/overview",
        release_url: Some("https://github.com/xai-org/grok-build/releases"),
    },
];

pub struct ToolInspector {
    cache_path: PathBuf,
    client: Client,
}

impl ToolInspector {
    pub fn new(cache_dir: PathBuf) -> Result<Self> {
        let client = Client::builder()
            .user_agent("AgentKib tool inspector")
            .connect_timeout(StdDuration::from_secs(5))
            .timeout(StdDuration::from_secs(12))
            .redirect(reqwest::redirect::Policy::limited(4))
            .build()?;
        Ok(Self {
            cache_path: cache_dir.join("agent-tools.json"),
            client,
        })
    }

    pub async fn snapshot(&self, force: bool) -> Result<AgentToolSnapshot> {
        let _snapshot_guard = SNAPSHOT_LOCK.get_or_init(|| Mutex::new(())).lock().await;
        let checked_at = Utc::now();
        let sources = release_sources();
        let (versions, latest_checked_at, cache_status, errors) =
            self.latest_versions(force, checked_at, &sources).await;
        let tools = stream::iter(TOOL_SPECS.into_iter().map(|spec| {
            let versions = &versions;
            async move { inspect_local(spec, versions).await }
        }))
        .buffered(FETCH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
        Ok(AgentToolSnapshot {
            tools,
            checked_at,
            latest_checked_at,
            cache_status,
            errors,
        })
    }

    pub async fn snapshot_cancellable(
        &self,
        force: bool,
        cancelled: &AtomicBool,
    ) -> Result<AgentToolSnapshot> {
        ensure!(
            !cancelled.load(Ordering::SeqCst),
            "Agent tool inspection was cancelled"
        );
        tokio::select! {
            result = self.snapshot(force) => result,
            _ = wait_for_cancellation(cancelled) => bail!("Agent tool inspection was cancelled"),
        }
    }

    pub async fn execute(
        &self,
        agent: AgentKind,
        action_id: &str,
        confirmed: bool,
    ) -> Result<AgentToolExecutionResult> {
        let cancelled = AtomicBool::new(false);
        self.execute_cancellable(agent, action_id, confirmed, &cancelled)
            .await
    }

    pub async fn execute_cancellable(
        &self,
        agent: AgentKind,
        action_id: &str,
        confirmed: bool,
        cancelled: &AtomicBool,
    ) -> Result<AgentToolExecutionResult> {
        ensure!(
            confirmed,
            "Agent tool execution requires explicit confirmation"
        );
        let Some(_execution_guard) = EXECUTION_LOCK
            .get_or_init(|| Mutex::new(()))
            .try_lock()
            .ok()
        else {
            return Ok(AgentToolExecutionResult {
                agent,
                action_id: action_id.to_owned(),
                status: AgentToolExecutionStatus::Busy,
                exit_code: None,
                output: String::new(),
                installation_id: None,
                before_version: None,
                after_version: None,
                completed_at: Utc::now(),
            });
        };
        let snapshot = self.snapshot_cancellable(false, cancelled).await?;
        let tool = snapshot
            .tools
            .iter()
            .find(|tool| tool.agent == agent)
            .context("Agent is not managed by the tool updater")?;
        let action = tool
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .context("Agent tool action is no longer available; detect again")?;
        ensure!(
            action.mode == AgentToolActionMode::Execute,
            "This action cannot be executed inside AgentKib"
        );
        let spec = tool_spec(agent).context("Unsupported Agent tool")?;
        let detected = cancellable_detect_installations(spec, cancelled).await?;
        ensure_installation_set_stable(action.kind, &detected)?;
        let selected = action.installation_id.as_deref().and_then(|id| {
            detected
                .iter()
                .find(|installation| installation.public.id == id)
        });
        ensure_update_target_still_applicable(agent, tool, action, selected)?;
        let regenerated = if action.kind == AgentToolActionKind::Install {
            install_action(spec, action.channel, action.target_version.as_deref())
        } else {
            selected.and_then(|installation| {
                update_action(spec, installation, action.target_version.as_deref())
            })
        }
        .context("Agent tool action is no longer valid; detect again")?;
        ensure!(
            regenerated.id == action.id,
            "The bound installation or package manager changed; detect again"
        );
        let before_version = selected.and_then(|value| value.public.version.clone());
        let (program, args) = executable_action(spec, tool, action, selected)?;
        let outcome = run_action(&program, &args, cancelled).await?;
        let mut status = outcome.status;
        let mut after_version = None;
        if status == AgentToolExecutionStatus::Succeeded {
            for attempt in 0..VERIFY_RETRIES {
                let after = cancellable_detect_installations(spec, cancelled).await?;
                let verified = verify_execution(agent, action, before_version.as_deref(), &after);
                status = verified.0;
                after_version = verified.1;
                if status == AgentToolExecutionStatus::Succeeded || attempt + 1 == VERIFY_RETRIES {
                    break;
                }
                tokio::select! {
                    _ = tokio::time::sleep(VERIFY_RETRY_DELAY) => {}
                    _ = wait_for_cancellation(cancelled) => {
                        bail!("Agent tool execution was cancelled");
                    }
                }
            }
        }
        Ok(AgentToolExecutionResult {
            agent,
            action_id: action.id.clone(),
            status,
            exit_code: outcome.exit_code,
            output: redact_output(&outcome.output),
            installation_id: action.installation_id.clone(),
            before_version,
            after_version,
            completed_at: Utc::now(),
        })
    }

    async fn latest_versions(
        &self,
        force: bool,
        now: DateTime<Utc>,
        sources: &BTreeMap<String, LatestSource>,
    ) -> (
        BTreeMap<String, String>,
        Option<DateTime<Utc>>,
        AgentToolCacheStatus,
        Vec<String>,
    ) {
        let mut cache = read_cache(&self.cache_path).unwrap_or_default();
        let previous_len = cache.versions.len();
        cache.versions.retain(|key, _| sources.contains_key(key));
        if cache.versions.len() != previous_len {
            let _ = write_cache(&self.cache_path, &cache);
        }
        let stale = sources
            .iter()
            .filter(|(key, _)| should_refresh(&cache, key, force, now))
            .map(|(key, source)| (key.clone(), *source))
            .collect::<Vec<_>>();
        if stale.is_empty() {
            let latest = cache.versions.values().map(|entry| entry.checked_at).max();
            return (
                cached_values(&cache),
                latest,
                AgentToolCacheStatus::Fresh,
                Vec::new(),
            );
        }
        let results = stream::iter(
            stale
                .into_iter()
                .map(|(key, source)| async move { (key, self.fetch_latest(source).await) }),
        )
        .buffer_unordered(FETCH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
        let (refreshed, errors) = apply_fetch_results(&mut cache, results, now);
        if refreshed {
            let _ = write_cache(&self.cache_path, &cache);
        }
        let latest = cache.versions.values().map(|entry| entry.checked_at).max();
        let status = if refreshed {
            AgentToolCacheStatus::Fresh
        } else if cache.versions.is_empty() {
            AgentToolCacheStatus::Unavailable
        } else {
            AgentToolCacheStatus::Cached
        };
        (cached_values(&cache), latest, status, errors)
    }

    async fn fetch_latest(&self, source: LatestSource) -> Result<String> {
        match source {
            LatestSource::Github { repository, prefix } => {
                let response = self
                    .client
                    .get(format!(
                        "https://api.github.com/repos/{repository}/releases/latest"
                    ))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<GithubRelease>()
                    .await?;
                nonempty_version(
                    response
                        .tag_name
                        .strip_prefix(prefix)
                        .unwrap_or(&response.tag_name),
                )
            }
            LatestSource::Npm { package } => {
                let encoded = package.replace('@', "%40").replace('/', "%2F");
                let response = self
                    .client
                    .get(format!("https://registry.npmjs.org/{encoded}/latest"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<NpmRelease>()
                    .await?;
                nonempty_version(&response.version)
            }
            LatestSource::CursorInstaller => {
                let script = self
                    .client
                    .get("https://cursor.com/install")
                    .send()
                    .await?
                    .error_for_status()?
                    .text()
                    .await?;
                parse_cursor_installer_version(&script)
                    .context("Cursor installer did not expose a version identifier")
            }
            LatestSource::HomebrewCask { token } => {
                let response = self
                    .client
                    .get(format!("https://formulae.brew.sh/api/cask/{token}.json"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<HomebrewRelease>()
                    .await?;
                nonempty_version(&response.version)
            }
            LatestSource::HomebrewFormula { token } => {
                let response = self
                    .client
                    .get(format!("https://formulae.brew.sh/api/formula/{token}.json"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<HomebrewFormulaRelease>()
                    .await?;
                nonempty_version(&response.versions.stable)
            }
        }
    }
}

async fn wait_for_cancellation(cancelled: &AtomicBool) {
    while !cancelled.load(Ordering::SeqCst) {
        tokio::time::sleep(StdDuration::from_millis(25)).await;
    }
}

async fn cancellable_detect_installations(
    spec: ToolSpec,
    cancelled: &AtomicBool,
) -> Result<Vec<DetectedInstallation>> {
    ensure!(
        !cancelled.load(Ordering::SeqCst),
        "Agent tool execution was cancelled"
    );
    tokio::select! {
        installations = detect_installations(spec) => Ok(installations),
        _ = wait_for_cancellation(cancelled) => bail!("Agent tool execution was cancelled"),
    }
}

fn ensure_installation_set_stable(
    kind: AgentToolActionKind,
    installations: &[DetectedInstallation],
) -> Result<()> {
    match kind {
        AgentToolActionKind::Install => ensure!(
            installations.is_empty(),
            "An Agent installation appeared after confirmation; detect again"
        ),
        AgentToolActionKind::Update => ensure!(
            installations.len() == 1,
            "Agent installations changed after confirmation; detect again"
        ),
        AgentToolActionKind::OpenDocumentation => {
            bail!("Documentation actions cannot execute inside AgentKib")
        }
    }
    Ok(())
}

fn ensure_update_target_still_applicable(
    agent: AgentKind,
    tool: &AgentToolStatus,
    action: &AgentToolAction,
    installation: Option<&DetectedInstallation>,
) -> Result<()> {
    if action.kind != AgentToolActionKind::Update {
        return Ok(());
    }
    let installation = installation.context("The bound Agent installation is missing")?;
    ensure!(
        installation.public.runnable,
        "The bound Agent installation is no longer runnable; detect again"
    );
    let expected = tool
        .current_version
        .as_deref()
        .context("The confirmed Agent version is unavailable")?;
    let current = installation
        .public
        .version
        .as_deref()
        .context("The bound Agent version is unavailable; detect again")?;
    ensure!(
        versions_equal(expected, current),
        "The Agent version changed after confirmation; detect again"
    );
    let target = action
        .target_version
        .as_deref()
        .context("The confirmed target version is unavailable")?;
    ensure!(
        compare_versions(agent, current, target) == Some(VersionOrdering::Less),
        "The confirmed target is no longer newer than the installed version; detect again"
    );
    Ok(())
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
}

#[derive(Deserialize)]
struct NpmRelease {
    version: String,
}

#[derive(Deserialize)]
struct HomebrewRelease {
    version: String,
}

#[derive(Deserialize)]
struct HomebrewFormulaRelease {
    versions: HomebrewFormulaVersions,
}

#[derive(Deserialize)]
struct HomebrewFormulaVersions {
    stable: String,
}

fn tool_spec(agent: AgentKind) -> Option<ToolSpec> {
    TOOL_SPECS.iter().copied().find(|spec| spec.agent == agent)
}

fn available_channels(agent: AgentKind) -> &'static [AgentToolChannel] {
    use AgentToolChannel::*;
    match agent {
        AgentKind::Codex => &[OfficialInstaller, Npm, Pnpm, Bun, Homebrew],
        AgentKind::ClaudeCode => &[OfficialInstaller, Npm, Homebrew],
        AgentKind::Cursor => &[OfficialInstaller, DesktopApp],
        AgentKind::OpenCode => &[OfficialInstaller, Npm, Pnpm, Bun, Yarn, Homebrew],
        AgentKind::OpenClaw => &[OfficialInstaller, Npm, Pnpm, Bun, DesktopApp],
        AgentKind::Hermes => &[OfficialInstaller, DesktopApp, Nix],
        AgentKind::GrokBuild => &[OfficialInstaller, Npm],
        AgentKind::DeepSeekHarness => &[],
    }
}

fn package_name(agent: AgentKind) -> Option<&'static str> {
    match agent {
        AgentKind::Codex => Some("@openai/codex"),
        AgentKind::ClaudeCode => Some("@anthropic-ai/claude-code"),
        AgentKind::OpenCode => Some("opencode-ai"),
        AgentKind::OpenClaw => Some("openclaw"),
        AgentKind::GrokBuild => Some("@xai-official/grok"),
        _ => None,
    }
}

fn channel_source(spec: ToolSpec, channel: AgentToolChannel) -> LatestSource {
    match channel {
        AgentToolChannel::Npm
        | AgentToolChannel::Pnpm
        | AgentToolChannel::Bun
        | AgentToolChannel::Yarn
        | AgentToolChannel::Volta => package_name(spec.agent)
            .map(|package| LatestSource::Npm { package })
            .unwrap_or(spec.upstream),
        AgentToolChannel::Homebrew if spec.agent == AgentKind::Codex => {
            LatestSource::HomebrewCask { token: "codex" }
        }
        AgentToolChannel::Homebrew if spec.agent == AgentKind::ClaudeCode => {
            LatestSource::HomebrewCask {
                token: "claude-code",
            }
        }
        AgentToolChannel::Homebrew if spec.agent == AgentKind::OpenCode => {
            LatestSource::HomebrewFormula { token: "opencode" }
        }
        _ => spec.upstream,
    }
}

fn release_sources() -> BTreeMap<String, LatestSource> {
    let mut sources = BTreeMap::new();
    for spec in TOOL_SPECS {
        sources.insert(spec.upstream.key(), spec.upstream);
        for channel in available_channels(spec.agent) {
            let source = channel_source(spec, *channel);
            sources.insert(source.key(), source);
        }
    }
    sources
}

fn version_for(
    versions: &BTreeMap<String, String>,
    spec: ToolSpec,
    channel: AgentToolChannel,
) -> Option<String> {
    versions.get(&channel_source(spec, channel).key()).cloned()
}

async fn inspect_local(spec: ToolSpec, versions: &BTreeMap<String, String>) -> AgentToolStatus {
    let detected = detect_installations(spec).await;
    let installations = detected
        .iter()
        .map(|installation| installation.public.clone())
        .collect::<Vec<_>>();
    let installed = !installations.is_empty();
    let primary_detected = detected
        .iter()
        .find(|installation| installation.public.is_path_default)
        .or_else(|| (detected.len() == 1).then(|| &detected[0]));
    let primary = primary_detected.map(|installation| &installation.public);
    let channel = primary
        .map(|installation| installation.channel)
        .unwrap_or(AgentToolChannel::Unknown);
    let current_version = primary.and_then(|installation| installation.version.clone());
    let latest_version = version_for(versions, spec, channel);
    let upstream_version = versions.get(&spec.upstream.key()).cloned();
    let mut warnings = Vec::new();
    if installations.len() > 1 {
        warnings.push("multiple-executables".to_owned());
    }
    if installed
        && installations
            .iter()
            .any(|installation| !installation.runnable)
    {
        warnings.push("installation-not-runnable".to_owned());
    }
    if installed && current_version.is_none() {
        warnings.push("version-unavailable".to_owned());
    }
    if latest_version.is_none() && installed {
        warnings.push("latest-unavailable".to_owned());
    }
    if let (Some(current), Some(latest)) = (&current_version, &latest_version)
        && !versions_equal(current, latest)
        && compare_versions(spec.agent, current, latest).is_none()
    {
        warnings.push("version-uncomparable".to_owned());
    }
    if installed && matches!(channel, AgentToolChannel::Unknown | AgentToolChannel::Local) {
        warnings.push("channel-unverified".to_owned());
    }
    let has_conflict = installations_conflict(&installations);
    let state = if has_conflict {
        AgentToolState::Conflict
    } else if installed && matches!(channel, AgentToolChannel::Unknown | AgentToolChannel::Local) {
        AgentToolState::Unknown
    } else {
        determine_state(
            spec.agent,
            installed,
            false,
            current_version.as_deref(),
            latest_version.as_deref(),
        )
    };
    let actions = actions_for(
        spec,
        state,
        primary_detected,
        latest_version.as_deref(),
        versions,
    );
    AgentToolStatus {
        agent: spec.agent,
        installed,
        current_version,
        latest_version: latest_version.clone(),
        recommended_version: latest_version,
        upstream_version,
        state,
        channel,
        installations,
        warnings,
        official_url: spec.official_url.to_owned(),
        release_url: spec.release_url.map(ToOwned::to_owned),
        actions,
    }
}

async fn detect_installations(spec: ToolSpec) -> Vec<DetectedInstallation> {
    let mut candidates = resolved_tool_paths(spec);
    collapse_active_mise_alias(spec, &mut candidates).await;
    if spec.agent == AgentKind::Cursor && candidates.is_empty() {
        let mut seen = BTreeSet::new();
        for candidate in cursor_desktop_candidates() {
            if command::is_executable(&candidate)
                && !command::is_windows_app_execution_alias_path(&candidate)
            {
                let target =
                    std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
                if seen.insert(platform_path::identity(&target)) {
                    candidates.push((candidate, false));
                }
            }
        }
    }

    let mut installations = Vec::with_capacity(candidates.len());
    for (path, is_path_default) in candidates {
        let resolved_path = std::fs::canonicalize(&path).unwrap_or_else(|_| path.to_path_buf());
        let inferred = infer_channel(spec.agent, &path);
        let manager_path = anchored_manager_path(spec.agent, inferred, &path);
        let channel = verified_channel(spec.agent, inferred, &path, manager_path.as_deref()).await;
        let environment = infer_environment(channel, &path);
        let probe = if channel == AgentToolChannel::DesktopApp {
            Ok(None)
        } else {
            probe_version(&path, spec.version_args).await.map(Some)
        };
        let (version, runnable, error) = match probe {
            Ok(version) => (version, true, None),
            Err(error) => (
                None,
                false,
                Some(truncate_output(&redact_output(&error.to_string()), 512)),
            ),
        };
        let id = installation_id(spec.agent, &path);
        installations.push(DetectedInstallation {
            public: AgentToolInstallation {
                id,
                path: redact_home_path(&path),
                resolved_path: redact_home_path(&resolved_path),
                version,
                runnable,
                error,
                channel,
                environment,
                manager_path: manager_path.as_deref().map(redact_home_path),
                is_path_default,
            },
            executable_path: path,
            manager_path,
        });
    }
    installations
}

async fn collapse_active_mise_alias(spec: ToolSpec, candidates: &mut Vec<(PathBuf, bool)>) {
    if !candidates.iter().any(|(path, _)| is_mise_shim(path)) {
        return;
    }
    let Some(mise) = command::resolve("mise") else {
        return;
    };
    for command_name in spec.commands {
        let Ok(output) = run_readonly_command(&mise, &["which", command_name]).await else {
            continue;
        };
        let Some(active_path) = output
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(PathBuf::from)
            .find(|path| path.is_absolute())
        else {
            continue;
        };
        if collapse_mise_aliases(candidates, &active_path) {
            return;
        }
    }
}

fn collapse_mise_aliases(candidates: &mut Vec<(PathBuf, bool)>, active_path: &Path) -> bool {
    let active_identity = platform_path::identity(active_path);
    let Some(active_index) = candidates.iter().position(|(path, _)| {
        is_mise_backing(path) && platform_path::identity(path) == active_identity
    }) else {
        return false;
    };
    let Some(shim_index) = candidates.iter().position(|(path, _)| is_mise_shim(path)) else {
        return false;
    };
    let keep_identity = if candidates[shim_index].1 {
        platform_path::identity(&candidates[shim_index].0)
    } else if candidates[active_index].1 {
        active_identity.clone()
    } else {
        platform_path::identity(&candidates[shim_index].0)
    };
    candidates.retain(|(path, _)| {
        if is_mise_shim(path) || platform_path::identity(path) == active_identity {
            platform_path::identity(path) == keep_identity
        } else {
            true
        }
    });
    true
}

fn is_mise_shim(path: &Path) -> bool {
    normalized_path(path).contains("/mise/shims/")
}

fn is_mise_backing(path: &Path) -> bool {
    normalized_path(path).contains("/mise/installs/node/")
}

fn actions_for(
    spec: ToolSpec,
    state: AgentToolState,
    installation: Option<&DetectedInstallation>,
    latest: Option<&str>,
    versions: &BTreeMap<String, String>,
) -> Vec<AgentToolAction> {
    if state == AgentToolState::Uninstalled {
        return available_channels(spec.agent)
            .iter()
            .filter_map(|channel| {
                let target = version_for(versions, spec, *channel);
                install_action(spec, *channel, target.as_deref())
            })
            .collect();
    }
    if state == AgentToolState::UpdateAvailable
        && let Some(installation) = installation
        && let Some(action) = update_action(spec, installation, latest)
    {
        return vec![action];
    }
    vec![documentation_action(
        spec,
        installation
            .map(|value| value.public.channel)
            .unwrap_or(AgentToolChannel::Unknown),
    )]
}

fn action_id(
    agent: AgentKind,
    kind: AgentToolActionKind,
    channel: AgentToolChannel,
    target: Option<&str>,
    installation_id: Option<&str>,
    manager_path: Option<&Path>,
) -> String {
    let binding = manager_path
        .map(platform_path::identity)
        .map(|value| short_hash(value.as_bytes()))
        .unwrap_or_else(|| "manual".to_owned());
    format!(
        "{}:{}:{}:{}:{}:{}",
        agent.as_str(),
        action_kind_name(kind),
        channel_name(channel),
        target.unwrap_or("unversioned"),
        installation_id.unwrap_or("new"),
        binding,
    )
}

fn documentation_action(spec: ToolSpec, channel: AgentToolChannel) -> AgentToolAction {
    AgentToolAction {
        id: action_id(
            spec.agent,
            AgentToolActionKind::OpenDocumentation,
            channel,
            None,
            None,
            None,
        ),
        kind: AgentToolActionKind::OpenDocumentation,
        mode: AgentToolActionMode::OpenDocumentation,
        channel,
        shell: None,
        command: None,
        url: Some(spec.official_url.to_owned()),
        target_version: None,
        installation_id: None,
        manager_path: None,
    }
}

fn install_action(
    spec: ToolSpec,
    channel: AgentToolChannel,
    target: Option<&str>,
) -> Option<AgentToolAction> {
    let shell = current_shell();
    let manager = executable_channel(channel)
        .then(|| manager_program(channel))
        .flatten();
    let command = install_command(spec.agent, channel, shell, target, manager.as_deref());
    let mode = if command.is_none() {
        AgentToolActionMode::OpenDocumentation
    } else {
        match channel {
            AgentToolChannel::Npm
            | AgentToolChannel::Pnpm
            | AgentToolChannel::Bun
            | AgentToolChannel::Volta => {
                if target.is_some_and(is_safe_target_version) && manager.is_some() {
                    AgentToolActionMode::Execute
                } else {
                    AgentToolActionMode::CopyCommand
                }
            }
            AgentToolChannel::OfficialInstaller
            | AgentToolChannel::Yarn
            | AgentToolChannel::Homebrew
            | AgentToolChannel::Nix => AgentToolActionMode::CopyCommand,
            AgentToolChannel::DesktopApp => AgentToolActionMode::OpenDocumentation,
            AgentToolChannel::Local | AgentToolChannel::Unknown => return None,
        }
    };
    Some(AgentToolAction {
        id: action_id(
            spec.agent,
            AgentToolActionKind::Install,
            channel,
            target,
            None,
            manager.as_deref(),
        ),
        kind: AgentToolActionKind::Install,
        mode,
        channel,
        shell: command.as_ref().map(|_| shell),
        command,
        url: Some(spec.official_url.to_owned()),
        target_version: target.map(ToOwned::to_owned),
        installation_id: None,
        manager_path: manager.as_deref().map(redact_home_path),
    })
}

fn update_action(
    spec: ToolSpec,
    installation: &DetectedInstallation,
    target: Option<&str>,
) -> Option<AgentToolAction> {
    let channel = installation.public.channel;
    let program = if channel == AgentToolChannel::OfficialInstaller {
        Some(installation.executable_path.as_path())
    } else {
        installation.manager_path.as_deref()
    };
    let shell = current_shell();
    let command = update_command(spec.agent, channel, target, program, shell)?;
    let mode = match channel {
        AgentToolChannel::OfficialInstaller => AgentToolActionMode::CopyCommand,
        AgentToolChannel::Npm
        | AgentToolChannel::Pnpm
        | AgentToolChannel::Bun
        | AgentToolChannel::Volta => {
            if target.is_some_and(is_safe_target_version) && program.is_some() {
                AgentToolActionMode::Execute
            } else {
                AgentToolActionMode::CopyCommand
            }
        }
        AgentToolChannel::Yarn | AgentToolChannel::Homebrew | AgentToolChannel::Nix => {
            AgentToolActionMode::CopyCommand
        }
        AgentToolChannel::DesktopApp | AgentToolChannel::Local | AgentToolChannel::Unknown => {
            AgentToolActionMode::OpenDocumentation
        }
    };
    Some(AgentToolAction {
        id: action_id(
            spec.agent,
            AgentToolActionKind::Update,
            channel,
            target,
            Some(&installation.public.id),
            program,
        ),
        kind: AgentToolActionKind::Update,
        mode,
        channel,
        shell: Some(shell),
        command: Some(command),
        url: Some(spec.official_url.to_owned()),
        target_version: target.map(ToOwned::to_owned),
        installation_id: Some(installation.public.id.clone()),
        manager_path: program.map(redact_home_path),
    })
}

fn current_shell() -> AgentToolShell {
    if cfg!(windows) {
        AgentToolShell::Powershell
    } else {
        AgentToolShell::Posix
    }
}

fn install_command(
    agent: AgentKind,
    channel: AgentToolChannel,
    shell: AgentToolShell,
    target: Option<&str>,
    manager: Option<&Path>,
) -> Option<String> {
    match channel {
        AgentToolChannel::OfficialInstaller => official_install_command(agent, shell),
        AgentToolChannel::Npm
        | AgentToolChannel::Pnpm
        | AgentToolChannel::Bun
        | AgentToolChannel::Volta => manager
            .and_then(|program| {
                package_manager_args(agent, channel, AgentToolActionKind::Install, target)
                    .ok()
                    .map(|args| display_command(program, &args, shell))
            })
            .or_else(|| package_command(agent, channel, target)),
        AgentToolChannel::Yarn => package_command(agent, channel, target),
        AgentToolChannel::Homebrew => manager.and_then(|program| {
            package_manager_args(agent, channel, AgentToolActionKind::Install, target)
                .ok()
                .map(|args| display_command(program, &args, shell))
        }),
        AgentToolChannel::Nix if agent == AgentKind::Hermes => {
            Some("nix profile install github:NousResearch/hermes-agent".to_owned())
        }
        _ => None,
    }
}

fn update_command(
    agent: AgentKind,
    channel: AgentToolChannel,
    target: Option<&str>,
    program: Option<&Path>,
    shell: AgentToolShell,
) -> Option<String> {
    match channel {
        AgentToolChannel::Npm
        | AgentToolChannel::Pnpm
        | AgentToolChannel::Bun
        | AgentToolChannel::Volta
        | AgentToolChannel::Homebrew => program.and_then(|program| {
            package_manager_args(agent, channel, AgentToolActionKind::Update, target)
                .ok()
                .map(|args| display_command(program, &args, shell))
        }),
        AgentToolChannel::Yarn => package_command(agent, channel, target),
        AgentToolChannel::OfficialInstaller => program.map(|program| {
            let argument = if agent == AgentKind::OpenCode {
                "upgrade"
            } else {
                "update"
            };
            display_command(program, &[argument.to_owned()], shell)
        }),
        AgentToolChannel::Nix if agent == AgentKind::Hermes => {
            Some("nix profile upgrade hermes-agent".to_owned())
        }
        _ => None,
    }
}

fn official_install_command(agent: AgentKind, shell: AgentToolShell) -> Option<String> {
    let command = match (agent, shell) {
        (AgentKind::Codex, AgentToolShell::Posix) => {
            "curl -fsSL https://chatgpt.com/codex/install.sh | sh"
        }
        (AgentKind::Codex, AgentToolShell::Powershell) => {
            "irm https://chatgpt.com/codex/install.ps1 | iex"
        }
        (AgentKind::ClaudeCode, AgentToolShell::Posix) => {
            "curl -fsSL https://claude.ai/install.sh | bash"
        }
        (AgentKind::ClaudeCode, AgentToolShell::Powershell) => {
            "irm https://claude.ai/install.ps1 | iex"
        }
        (AgentKind::Cursor, AgentToolShell::Posix) => "curl https://cursor.com/install -fsS | bash",
        (AgentKind::Cursor, AgentToolShell::Powershell) => {
            "irm 'https://cursor.com/install?win32=true' | iex"
        }
        (AgentKind::OpenCode, AgentToolShell::Posix) => {
            "curl -fsSL https://opencode.ai/install | bash"
        }
        (AgentKind::OpenCode, AgentToolShell::Powershell) => return None,
        (AgentKind::OpenClaw, AgentToolShell::Posix) => {
            "curl -fsSL https://openclaw.ai/install.sh | bash"
        }
        (AgentKind::OpenClaw, AgentToolShell::Powershell) => {
            "iwr -useb https://openclaw.ai/install.ps1 | iex"
        }
        (AgentKind::Hermes, AgentToolShell::Posix) => {
            "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
        }
        (AgentKind::Hermes, AgentToolShell::Powershell) => {
            "iex (irm https://hermes-agent.nousresearch.com/install.ps1)"
        }
        (AgentKind::GrokBuild, AgentToolShell::Posix) => {
            "curl -fsSL https://x.ai/cli/install.sh | bash"
        }
        (AgentKind::GrokBuild, AgentToolShell::Powershell) => {
            "irm https://x.ai/cli/install.ps1 | iex"
        }
        (AgentKind::DeepSeekHarness, _) => return None,
    };
    Some(command.to_owned())
}

fn package_command(
    agent: AgentKind,
    channel: AgentToolChannel,
    target: Option<&str>,
) -> Option<String> {
    let package = format!("{}@{}", package_name(agent)?, target.unwrap_or("latest"));
    Some(match (agent, channel) {
        (AgentKind::OpenClaw, AgentToolChannel::Npm) => {
            format!("npm install -g {package} --allow-scripts=openclaw")
        }
        (AgentKind::OpenClaw, AgentToolChannel::Pnpm) => {
            format!("pnpm add -g --allow-build=openclaw {package}")
        }
        (AgentKind::OpenClaw, AgentToolChannel::Bun) => {
            format!("bun add -g --trust {package}")
        }
        (_, AgentToolChannel::Npm) => format!("npm install -g {package}"),
        (_, AgentToolChannel::Pnpm) => format!("pnpm add -g {package}"),
        (_, AgentToolChannel::Bun) => format!("bun add -g {package}"),
        (AgentKind::OpenCode, AgentToolChannel::Yarn) => format!("yarn global add {package}"),
        _ => return None,
    })
}

fn manager_program(channel: AgentToolChannel) -> Option<PathBuf> {
    let directories = command::agent_tool_default_directories();
    manager_program_in(channel, &directories)
}

fn manager_program_in(channel: AgentToolChannel, directories: &[PathBuf]) -> Option<PathBuf> {
    let name = match channel {
        AgentToolChannel::Npm => "npm",
        AgentToolChannel::Pnpm => "pnpm",
        AgentToolChannel::Bun => "bun",
        AgentToolChannel::Yarn => "yarn",
        AgentToolChannel::Homebrew => "brew",
        AgentToolChannel::Volta => "volta",
        AgentToolChannel::Nix => "nix",
        _ => return None,
    };
    command::resolve_in(name, directories.iter().map(PathBuf::as_path))
}

fn executable_channel(channel: AgentToolChannel) -> bool {
    matches!(
        channel,
        AgentToolChannel::Npm
            | AgentToolChannel::Pnpm
            | AgentToolChannel::Bun
            | AgentToolChannel::Homebrew
            | AgentToolChannel::Volta
    )
}

fn display_command(program: &Path, args: &[String], shell: AgentToolShell) -> String {
    let program = redact_home_path(program);
    let program = program.to_string_lossy();
    let arguments = args
        .iter()
        .map(|argument| display_argument(argument, shell))
        .collect::<Vec<_>>()
        .join(" ");
    let command = match shell {
        AgentToolShell::Posix => display_posix_program(&program),
        AgentToolShell::Powershell => {
            format!("& {}", display_powershell_program(&program))
        }
    };
    if arguments.is_empty() {
        command
    } else {
        format!("{command} {arguments}")
    }
}

fn display_posix_program(value: &str) -> String {
    if value == "~" {
        return "$HOME".to_owned();
    }
    if let Some(suffix) = value.strip_prefix("~/") {
        return format!(
            "\"$HOME\"/{}",
            display_argument(suffix, AgentToolShell::Posix)
        );
    }
    display_argument(value, AgentToolShell::Posix)
}

fn display_argument(value: &str, shell: AgentToolShell) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"@%_+=:,./~-".contains(&byte))
    {
        value.to_owned()
    } else {
        match shell {
            AgentToolShell::Posix => format!("'{}'", value.replace('\'', "'\"'\"'")),
            AgentToolShell::Powershell => format!("'{}'", value.replace('\'', "''")),
        }
    }
}

fn display_powershell_program(value: &str) -> String {
    if value == "~" {
        return "$HOME".to_owned();
    }
    if let Some(suffix) = value
        .strip_prefix("~\\")
        .or_else(|| value.strip_prefix("~/"))
    {
        let suffix = suffix
            .replace('`', "``")
            .replace('$', "`$")
            .replace('"', "`\"");
        return format!("\"$HOME\\{suffix}\"");
    }
    format!("'{}'", value.replace('\'', "''"))
}

fn executable_action(
    spec: ToolSpec,
    tool: &AgentToolStatus,
    action: &AgentToolAction,
    installation: Option<&DetectedInstallation>,
) -> Result<(PathBuf, Vec<String>)> {
    ensure!(
        !matches!(
            tool.state,
            AgentToolState::Conflict | AgentToolState::Unknown
        ),
        "Conflicting or unverified installations cannot be changed"
    );
    if action.kind == AgentToolActionKind::Update {
        ensure!(
            tool.channel == action.channel,
            "The installation channel changed"
        );
    }
    match action.channel {
        AgentToolChannel::Npm
        | AgentToolChannel::Pnpm
        | AgentToolChannel::Bun
        | AgentToolChannel::Homebrew
        | AgentToolChannel::Volta => {
            let program = if action.kind == AgentToolActionKind::Update {
                installation
                    .and_then(|value| value.manager_path.clone())
                    .context("The bound package manager is unavailable")?
            } else {
                manager_program(action.channel).context("Package manager is unavailable")?
            };
            let args = package_manager_args(
                spec.agent,
                action.channel,
                action.kind,
                action.target_version.as_deref(),
            )?;
            Ok((program, args))
        }
        AgentToolChannel::OfficialInstaller if action.kind == AgentToolActionKind::Update => {
            let installation = installation.context("The bound Agent installation is missing")?;
            let argument = if spec.agent == AgentKind::OpenCode {
                "upgrade"
            } else {
                "update"
            };
            Ok((
                installation.executable_path.clone(),
                vec![argument.to_owned()],
            ))
        }
        _ => bail!("This installation channel requires a manual action"),
    }
}

fn package_manager_args(
    agent: AgentKind,
    channel: AgentToolChannel,
    kind: AgentToolActionKind,
    target: Option<&str>,
) -> Result<Vec<String>> {
    if channel == AgentToolChannel::Homebrew {
        let verb = if kind == AgentToolActionKind::Update {
            "upgrade"
        } else {
            "install"
        };
        return Ok(match agent {
            AgentKind::Codex => vec![verb.to_owned(), "--cask".to_owned(), "codex".to_owned()],
            AgentKind::ClaudeCode => {
                vec![
                    verb.to_owned(),
                    "--cask".to_owned(),
                    "claude-code".to_owned(),
                ]
            }
            AgentKind::OpenCode => vec![verb.to_owned(), "opencode".to_owned()],
            _ => bail!("Homebrew is not supported for this Agent"),
        });
    }
    let target = target.context("A pinned package version is required")?;
    ensure!(
        is_safe_target_version(target),
        "The package version is not safe to execute"
    );
    let package = format!(
        "{}@{target}",
        package_name(agent).context("Package manager is not supported for this Agent")?
    );
    Ok(match (agent, channel) {
        (_, AgentToolChannel::Volta) => vec!["install".to_owned(), package],
        (AgentKind::OpenClaw, AgentToolChannel::Npm) => vec![
            "install".to_owned(),
            "-g".to_owned(),
            package,
            "--allow-scripts=openclaw".to_owned(),
        ],
        (AgentKind::OpenClaw, AgentToolChannel::Pnpm) => vec![
            "add".to_owned(),
            "-g".to_owned(),
            "--allow-build=openclaw".to_owned(),
            package,
        ],
        (AgentKind::OpenClaw, AgentToolChannel::Bun) => vec![
            "add".to_owned(),
            "-g".to_owned(),
            "--trust".to_owned(),
            package,
        ],
        (_, AgentToolChannel::Npm) => vec!["install".to_owned(), "-g".to_owned(), package],
        (_, AgentToolChannel::Pnpm | AgentToolChannel::Bun) => {
            vec!["add".to_owned(), "-g".to_owned(), package]
        }
        _ => bail!("Package manager is not executable for this Agent"),
    })
}

fn is_safe_target_version(target: &str) -> bool {
    !target.is_empty()
        && target.len() <= 128
        && target
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+' | b'_'))
}

struct CommandOutcome {
    status: AgentToolExecutionStatus,
    exit_code: Option<i32>,
    output: String,
}

async fn run_action(
    program: &Path,
    args: &[String],
    cancelled: &AtomicBool,
) -> Result<CommandOutcome> {
    run_action_with_timeout(program, args, EXECUTION_TIMEOUT, cancelled).await
}

async fn run_action_with_timeout(
    program: &Path,
    args: &[String],
    timeout: StdDuration,
    cancelled: &AtomicBool,
) -> Result<CommandOutcome> {
    ensure!(
        !cancelled.load(Ordering::SeqCst),
        "Agent tool execution was cancelled"
    );
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    anchor_program_path(&mut command, program);
    configure_process_group(command.as_std_mut());
    let mut child = command
        .spawn()
        .with_context(|| format!("Could not run {}", program.display()))?;
    let process_tree = match child.id().map(ProcessTree::attach_pid) {
        Some(Ok(tree)) => tree,
        Some(Err(error)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error).context("Could not supervise Agent tool process tree");
        }
        None => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!("Agent tool process did not expose a process id");
        }
    };
    let stdout = child
        .stdout
        .take()
        .context("Command stdout was unavailable")?;
    let stderr = child
        .stderr
        .take()
        .context("Command stderr was unavailable")?;
    let stdout_task = tokio::spawn(read_capped(stdout, MAX_EXECUTION_OUTPUT));
    let stderr_task = tokio::spawn(read_capped(stderr, MAX_EXECUTION_OUTPUT));
    let stdout_abort = stdout_task.abort_handle();
    let stderr_abort = stderr_task.abort_handle();
    let deadline = tokio::time::Instant::now() + timeout;
    enum WaitResult {
        Finished(std::io::Result<std::process::ExitStatus>),
        TimedOut,
        Cancelled,
    }
    let result = tokio::select! {
        status = child.wait() => WaitResult::Finished(status),
        _ = tokio::time::sleep_until(deadline) => WaitResult::TimedOut,
        _ = wait_for_cancellation(cancelled) => WaitResult::Cancelled,
    };
    let (mut status, mut exit_code) = match result {
        WaitResult::Finished(status) => {
            let status = status?;
            (
                if status.success() {
                    AgentToolExecutionStatus::Succeeded
                } else {
                    AgentToolExecutionStatus::Failed
                },
                status.code(),
            )
        }
        WaitResult::TimedOut => {
            let _ = process_tree.terminate();
            let _ = child.kill().await;
            let _ = child.wait().await;
            (AgentToolExecutionStatus::TimedOut, None)
        }
        WaitResult::Cancelled => {
            let _ = process_tree.terminate();
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_abort.abort();
            stderr_abort.abort();
            bail!("Agent tool execution was cancelled");
        }
    };
    let output = if status == AgentToolExecutionStatus::TimedOut {
        stdout_abort.abort();
        stderr_abort.abort();
        String::new()
    } else {
        let drain_result = tokio::select! {
            output = tokio::time::timeout_at(deadline, async move {
                Ok::<_, anyhow::Error>((stdout_task.await??, stderr_task.await??))
            }) => Some(output),
            _ = wait_for_cancellation(cancelled) => None,
        };
        match drain_result {
            Some(Ok(output)) => {
                let (stdout, stderr) = output?;
                [stdout, stderr]
                    .into_iter()
                    .filter(|value| !value.is_empty())
                    .map(|value| String::from_utf8_lossy(&value).trim().to_owned())
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            Some(Err(_)) => {
                let _ = process_tree.terminate();
                stdout_abort.abort();
                stderr_abort.abort();
                status = AgentToolExecutionStatus::TimedOut;
                exit_code = None;
                String::new()
            }
            None => {
                let _ = process_tree.terminate();
                stdout_abort.abort();
                stderr_abort.abort();
                bail!("Agent tool execution was cancelled");
            }
        }
    };
    let output = truncate_output(&output, MAX_EXECUTION_OUTPUT as usize);
    Ok(CommandOutcome {
        status,
        exit_code,
        output,
    })
}

async fn probe_version(path: &Path, args: &[&str]) -> Result<String> {
    let mut command = tokio::process::Command::new(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    anchor_program_path(&mut command, path);
    configure_process_group(command.as_std_mut());
    let mut child = command
        .spawn()
        .with_context(|| format!("Could not run {}", path.display()))?;
    let process_tree = match child.id().map(ProcessTree::attach_pid) {
        Some(Ok(tree)) => tree,
        Some(Err(error)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error).context("Could not supervise version probe process tree");
        }
        None => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!("Version probe process did not expose a process id");
        }
    };
    let stdout = child
        .stdout
        .take()
        .context("Version probe did not expose stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("Version probe did not expose stderr")?;
    let stdout_task = tokio::spawn(read_capped(stdout, MAX_PROBE_OUTPUT));
    let stderr_task = tokio::spawn(read_capped(stderr, MAX_PROBE_OUTPUT));
    let stdout_abort = stdout_task.abort_handle();
    let stderr_abort = stderr_task.abort_handle();
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(result) => result?,
        Err(_) => {
            let _ = process_tree.terminate();
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_abort.abort();
            stderr_abort.abort();
            bail!("Version probe timed out");
        }
    };
    let (stdout, stderr) = match tokio::time::timeout_at(deadline, async move {
        Ok::<_, anyhow::Error>((stdout_task.await??, stderr_task.await??))
    })
    .await
    {
        Ok(output) => output?,
        Err(_) => {
            let _ = process_tree.terminate();
            stdout_abort.abort();
            stderr_abort.abort();
            bail!("Version probe timed out");
        }
    };
    ensure!(status.success(), "Version probe exited with {status}");
    let output = if stdout.is_empty() { stderr } else { stdout };
    let output = String::from_utf8_lossy(&output);
    let value = nonempty_version(output.lines().next().unwrap_or_default().trim())?;
    Ok(parse_semver(&value)
        .map(|version| version.to_string())
        .unwrap_or(value))
}

async fn read_capped<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    limit: u64,
) -> std::io::Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let remaining = limit.saturating_sub(output.len() as u64) as usize;
        output.extend_from_slice(&buffer[..read.min(remaining)]);
    }
    Ok(output)
}

fn resolved_tool_paths(spec: ToolSpec) -> Vec<(PathBuf, bool)> {
    let default_directories = command::agent_tool_default_directories();
    let default_identities = spec
        .commands
        .iter()
        .filter_map(|name| {
            command::resolve_in(name, default_directories.iter().map(PathBuf::as_path))
        })
        .map(|path| platform_path::identity(&path))
        .collect::<BTreeSet<_>>();
    let search_directories = command::agent_tool_search_directories();
    let candidates = spec
        .commands
        .iter()
        .flat_map(|name| {
            command::resolve_all_in(name, search_directories.iter().map(PathBuf::as_path))
        })
        .chain(known_cli_candidates(spec.agent));
    let mut paths: Vec<(PathBuf, bool)> = Vec::new();
    let mut seen = BTreeMap::<String, usize>::new();
    for candidate in candidates {
        if is_ambiguous_cursor_agent_alias(spec, &candidate)
            || is_bundled_desktop_executable(spec.agent, &candidate)
            || !command::is_executable(&candidate)
            || command::is_windows_app_execution_alias_path(&candidate)
        {
            continue;
        }
        let target = std::fs::canonicalize(&candidate).unwrap_or_else(|_| candidate.clone());
        let physical_identity = platform_path::identity(&target);
        let is_default = default_identities.contains(&platform_path::identity(&candidate))
            || default_identities.contains(&physical_identity);
        if let Some(index) = seen.get(&physical_identity).copied() {
            if is_default {
                paths[index] = (candidate, true);
            }
        } else {
            seen.insert(physical_identity, paths.len());
            paths.push((candidate, is_default));
        }
    }
    paths
}

fn is_ambiguous_cursor_agent_alias(spec: ToolSpec, path: &Path) -> bool {
    if spec.agent != AgentKind::Cursor
        || !path
            .file_stem()
            .is_some_and(|name| name.eq_ignore_ascii_case("agent"))
    {
        return false;
    }
    infer_channel(AgentKind::Cursor, path) != AgentToolChannel::OfficialInstaller
}

fn known_cli_candidates(agent: AgentKind) -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        known_unix_cli_candidates(agent, &dirs_home())
    }
    #[cfg(windows)]
    {
        let Some(home) = dirs::home_dir() else {
            return Vec::new();
        };
        match agent {
            AgentKind::GrokBuild => manager_candidates(&home.join(".grok/bin"), "grok"),
            _ => Vec::new(),
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = agent;
        Vec::new()
    }
}

#[cfg(unix)]
fn known_unix_cli_candidates(agent: AgentKind, home: &Path) -> Vec<PathBuf> {
    match agent {
        AgentKind::OpenCode => vec![home.join(".opencode/bin/opencode")],
        AgentKind::GrokBuild => vec![home.join(".grok/bin/grok")],
        _ => Vec::new(),
    }
}

fn is_bundled_desktop_executable(agent: AgentKind, path: &Path) -> bool {
    agent == AgentKind::Codex
        && cfg!(target_os = "macos")
        && normalized_path(path).ends_with("/chatgpt.app/contents/resources/codex")
}

fn anchored_manager_path(
    agent: AgentKind,
    channel: AgentToolChannel,
    executable: &Path,
) -> Option<PathBuf> {
    let manager = match channel {
        AgentToolChannel::Npm => "npm",
        AgentToolChannel::Pnpm => "pnpm",
        AgentToolChannel::Bun => "bun",
        AgentToolChannel::Homebrew => "brew",
        AgentToolChannel::Volta => "volta",
        _ => return None,
    };
    if package_name(agent).is_none() && channel != AgentToolChannel::Homebrew {
        return None;
    }
    let target = std::fs::canonicalize(executable).unwrap_or_else(|_| executable.to_path_buf());
    let mut directories = Vec::new();
    if let Some(parent) = executable.parent() {
        directories.push(parent.to_path_buf());
    }
    if let Some(parent) = target.parent() {
        directories.push(parent.to_path_buf());
    }
    for ancestor in target.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name == "node_modules")
            && ancestor
                .parent()
                .is_some_and(|parent| parent.file_name().is_some_and(|name| name == "lib"))
            && let Some(prefix) = ancestor.parent().and_then(Path::parent)
        {
            directories.push(prefix.join("bin"));
        }
    }
    if channel == AgentToolChannel::Homebrew {
        let normalized = normalized_path(&target);
        if normalized.starts_with("/opt/homebrew/") {
            directories.push(PathBuf::from("/opt/homebrew/bin"));
        } else if normalized.starts_with("/usr/local/") {
            directories.push(PathBuf::from("/usr/local/bin"));
        }
    }
    let mut seen = BTreeSet::new();
    directories
        .into_iter()
        .filter(|directory| seen.insert(platform_path::identity(directory)))
        .flat_map(|directory| manager_candidates(&directory, manager))
        .find(|candidate| command::is_executable(candidate))
}

fn manager_candidates(directory: &Path, manager: &str) -> Vec<PathBuf> {
    let mut candidates = vec![directory.join(manager)];
    if cfg!(windows) {
        candidates.insert(0, directory.join(format!("{manager}.cmd")));
        candidates.insert(1, directory.join(format!("{manager}.exe")));
    }
    candidates
}

fn infer_environment(channel: AgentToolChannel, path: &Path) -> AgentToolEnvironment {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = format!("{}|{}", normalized_path(path), normalized_path(&target));
    if value.contains("/.volta/") || value.contains("/volta/") {
        AgentToolEnvironment::Volta
    } else if value.contains("/.nvm/") || value.contains("/appdata/roaming/nvm/") {
        AgentToolEnvironment::Nvm
    } else if value.contains("/fnm/") || value.contains("/fnm_") {
        AgentToolEnvironment::Fnm
    } else if value.contains("/mise/") {
        AgentToolEnvironment::Mise
    } else if channel == AgentToolChannel::OfficialInstaller {
        AgentToolEnvironment::Standalone
    } else if matches!(channel, AgentToolChannel::Unknown | AgentToolChannel::Local) {
        AgentToolEnvironment::Unknown
    } else {
        AgentToolEnvironment::System
    }
}

fn installation_id(agent: AgentKind, path: &Path) -> String {
    // The entry path remains stable when a package manager atomically replaces
    // a shim or symlink target during an update. Canonicalizing here would make
    // a successful update appear to be a different installation.
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let identity = if cfg!(windows) {
        absolute
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase()
    } else {
        absolute.to_string_lossy().into_owned()
    };
    format!("{}:{}", agent.as_str(), short_hash(identity.as_bytes()))
}

fn short_hash(value: &[u8]) -> String {
    let digest = Sha256::digest(value);
    hex::encode(&digest[..8])
}

fn verify_execution(
    agent: AgentKind,
    action: &AgentToolAction,
    before_version: Option<&str>,
    installations: &[DetectedInstallation],
) -> (AgentToolExecutionStatus, Option<String>) {
    if installations.len() != 1 {
        return (AgentToolExecutionStatus::VerificationFailed, None);
    }
    let installation = if let Some(id) = action.installation_id.as_deref() {
        installations.iter().find(|value| value.public.id == id)
    } else if action.kind == AgentToolActionKind::Install {
        installations.iter().find(|value| {
            value.public.channel == action.channel
                && value.public.runnable
                && value.public.is_path_default
        })
    } else {
        None
    };
    let Some(installation) = installation else {
        return (AgentToolExecutionStatus::VerificationFailed, None);
    };
    let after_version = installation.public.version.clone();
    if !installation.public.runnable
        || after_version.is_none()
        || (action.kind == AgentToolActionKind::Install && !installation.public.is_path_default)
    {
        return (AgentToolExecutionStatus::VerificationFailed, after_version);
    }
    let after = after_version.as_deref().unwrap_or_default();
    if action.kind == AgentToolActionKind::Update
        && before_version.is_some_and(|before| versions_equal(before, after))
    {
        return (AgentToolExecutionStatus::Unchanged, after_version);
    }
    if action
        .target_version
        .as_deref()
        .is_some_and(|target| version_reaches_target(agent, after, target))
    {
        (AgentToolExecutionStatus::Succeeded, after_version)
    } else {
        (AgentToolExecutionStatus::VerificationFailed, after_version)
    }
}

fn version_reaches_target(agent: AgentKind, current: &str, target: &str) -> bool {
    versions_equal(current, target)
        || compare_versions(agent, current, target).is_some_and(VersionOrdering::is_gt)
}

fn infer_channel(agent: AgentKind, path: &Path) -> AgentToolChannel {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = format!("{}|{}", normalized_path(path), normalized_path(&target));
    if value.contains("/.volta/") || value.contains("/volta/") {
        AgentToolChannel::Volta
    } else if value.contains("/caskroom/") || value.contains("/cellar/") {
        AgentToolChannel::Homebrew
    } else if value.contains("/node_modules/.pnpm/")
        || value.contains("/pnpm/global/")
        || value.contains("/.local/share/pnpm/")
        || value.contains("/library/pnpm/")
        || value.contains("/appdata/local/pnpm/")
    {
        AgentToolChannel::Pnpm
    } else if value.contains("/.bun/install/global/") || value.contains("/.bun/bin/") {
        AgentToolChannel::Bun
    } else if value.contains("/.config/yarn/global/") {
        AgentToolChannel::Yarn
    } else if value.contains("/node_modules/")
        || value.contains("/appdata/roaming/npm/")
        || value.contains("/.nvm/")
        || value.contains("/fnm/")
        || value.contains("/mise/shims/")
        || value.contains("/mise/installs/node/")
    {
        AgentToolChannel::Npm
    } else if value.contains("/nix/store/") {
        AgentToolChannel::Nix
    } else if value.contains("/applications/") || value.contains("/program files/") {
        AgentToolChannel::DesktopApp
    } else if is_official_path(agent, &value) {
        AgentToolChannel::OfficialInstaller
    } else if value.contains("/.local/bin/") || value.contains("/.cargo/bin/") {
        AgentToolChannel::Local
    } else {
        AgentToolChannel::Unknown
    }
}

async fn verified_channel(
    agent: AgentKind,
    channel: AgentToolChannel,
    path: &Path,
    manager_path: Option<&Path>,
) -> AgentToolChannel {
    match channel {
        AgentToolChannel::Npm
        | AgentToolChannel::Pnpm
        | AgentToolChannel::Bun
        | AgentToolChannel::Volta => {
            let verified = if let Some(manager) = manager_path {
                manager_path_matches_package(agent, channel, path)
                    && manager_reports_package(agent, channel, manager).await
            } else {
                false
            };
            if verified {
                channel
            } else {
                AgentToolChannel::Unknown
            }
        }
        AgentToolChannel::Homebrew => {
            let verified = if let Some(manager) = manager_path {
                manager_path_matches_package(agent, channel, path)
                    && manager_reports_package(agent, channel, manager).await
            } else {
                false
            };
            if verified {
                channel
            } else {
                AgentToolChannel::Unknown
            }
        }
        // Yarn and Nix are deliberately manual-only, so path ownership is
        // sufficient for display and never authorizes in-app execution.
        _ => channel,
    }
}

fn manager_path_matches_package(agent: AgentKind, channel: AgentToolChannel, path: &Path) -> bool {
    let target = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let value = format!("{}|{}", normalized_path(path), normalized_path(&target));
    match channel {
        AgentToolChannel::Npm
        | AgentToolChannel::Pnpm
        | AgentToolChannel::Bun
        | AgentToolChannel::Volta => {
            let Some(package) = package_name(agent) else {
                return false;
            };
            let package = package.to_ascii_lowercase();
            let pnpm_package = package.replace('/', "+");
            let package_layout = value.contains("/node_modules/") || value.contains("/.pnpm/");
            value.contains(&format!("/node_modules/{package}/"))
                || value.contains(&format!("/{pnpm_package}@"))
                || (channel == AgentToolChannel::Npm && value.contains("/appdata/roaming/npm/"))
                || (channel == AgentToolChannel::Npm
                    && !package_layout
                    && ["/.nvm/", "/fnm/", "/mise/shims/", "/mise/installs/node/"]
                        .iter()
                        .any(|marker| value.contains(marker)))
                || (channel == AgentToolChannel::Pnpm && value.contains("/appdata/local/pnpm/"))
                || (channel == AgentToolChannel::Pnpm
                    && !package_layout
                    && ["/.local/share/pnpm/", "/library/pnpm/"]
                        .iter()
                        .any(|marker| value.contains(marker)))
                || (channel == AgentToolChannel::Volta && value.contains("/volta/"))
        }
        AgentToolChannel::Homebrew => match agent {
            AgentKind::Codex => value.contains("/caskroom/codex/"),
            AgentKind::ClaudeCode => value.contains("/caskroom/claude-code/"),
            AgentKind::OpenCode => value.contains("/cellar/opencode/"),
            _ => false,
        },
        _ => false,
    }
}

async fn manager_reports_package(
    agent: AgentKind,
    channel: AgentToolChannel,
    program: &Path,
) -> bool {
    let (arguments, package) = match channel {
        AgentToolChannel::Npm => {
            let Some(package) = package_name(agent) else {
                return false;
            };
            (vec!["ls", "-g", "--depth=0", "--json"], package)
        }
        AgentToolChannel::Pnpm => {
            let Some(package) = package_name(agent) else {
                return false;
            };
            (vec!["list", "-g", "--depth=0", "--json"], package)
        }
        AgentToolChannel::Bun => {
            let Some(package) = package_name(agent) else {
                return false;
            };
            (vec!["pm", "-g", "ls"], package)
        }
        AgentToolChannel::Volta => {
            let Some(package) = package_name(agent) else {
                return false;
            };
            (vec!["list", "--format", "plain"], package)
        }
        AgentToolChannel::Homebrew => match agent {
            AgentKind::Codex => (vec!["list", "--cask", "--versions", "codex"], "codex"),
            AgentKind::ClaudeCode => (
                vec!["list", "--cask", "--versions", "claude-code"],
                "claude-code",
            ),
            AgentKind::OpenCode => (
                vec!["list", "--formula", "--versions", "opencode"],
                "opencode",
            ),
            _ => return false,
        },
        _ => return false,
    };
    let Ok(output) = run_readonly_command(program, &arguments).await else {
        return false;
    };
    match channel {
        AgentToolChannel::Npm | AgentToolChannel::Pnpm => {
            serde_json::from_str::<serde_json::Value>(&output)
                .is_ok_and(|value| package_listing_json_contains(&value, package))
        }
        AgentToolChannel::Bun | AgentToolChannel::Volta => {
            text_package_listing_contains(&output, package)
        }
        AgentToolChannel::Homebrew => output
            .split_whitespace()
            .next()
            .is_some_and(|value| value.eq_ignore_ascii_case(package)),
        _ => false,
    }
}

fn package_listing_json_contains(value: &serde_json::Value, package: &str) -> bool {
    match value {
        serde_json::Value::Array(values) => values
            .iter()
            .any(|value| package_listing_json_contains(value, package)),
        serde_json::Value::Object(object) => {
            ["dependencies", "devDependencies", "optionalDependencies"]
                .iter()
                .filter_map(|key| object.get(*key).and_then(serde_json::Value::as_object))
                .any(|dependencies| dependencies.contains_key(package))
        }
        _ => false,
    }
}

fn text_package_listing_contains(output: &str, package: &str) -> bool {
    let version_prefix = format!("{package}@");
    output.split_whitespace().any(|value| {
        let value = value.trim_start_matches(|character: char| {
            !character.is_ascii_alphanumeric() && character != '@'
        });
        value == package || value.starts_with(&version_prefix)
    })
}

async fn run_readonly_command(program: &Path, args: &[&str]) -> Result<String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    anchor_program_path(&mut command, program);
    configure_process_group(command.as_std_mut());
    let mut child = command
        .spawn()
        .with_context(|| format!("Could not inspect {}", program.display()))?;
    let process_tree = match child.id().map(ProcessTree::attach_pid) {
        Some(Ok(tree)) => tree,
        Some(Err(error)) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(error).context("Could not supervise inspection process tree");
        }
        None => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            bail!("Inspection process did not expose a process id");
        }
    };
    let stdout = child
        .stdout
        .take()
        .context("Inspection stdout was unavailable")?;
    let stdout_task = tokio::spawn(read_capped(stdout, MAX_PROBE_OUTPUT));
    let stdout_abort = stdout_task.abort_handle();
    let deadline = tokio::time::Instant::now() + PROBE_TIMEOUT;
    let status = match tokio::time::timeout_at(deadline, child.wait()).await {
        Ok(result) => result?,
        Err(_) => {
            let _ = process_tree.terminate();
            let _ = child.kill().await;
            let _ = child.wait().await;
            stdout_abort.abort();
            bail!("Package manager inspection timed out");
        }
    };
    let stdout = match tokio::time::timeout_at(deadline, stdout_task).await {
        Ok(output) => output??,
        Err(_) => {
            let _ = process_tree.terminate();
            stdout_abort.abort();
            bail!("Package manager inspection timed out");
        }
    };
    ensure!(status.success(), "Package manager inspection failed");
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

fn anchor_program_path(command: &mut tokio::process::Command, program: &Path) {
    if let Some(path) = anchored_search_path(program, std::env::var_os("PATH").as_deref()) {
        command.env("PATH", path);
    }
}

fn anchored_search_path(program: &Path, current: Option<&OsStr>) -> Option<OsString> {
    let parent = program.parent()?.to_path_buf();
    let mut directories = vec![parent];
    if let Some(current) = current {
        directories.extend(std::env::split_paths(current));
    }
    std::env::join_paths(directories).ok()
}

fn normalized_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn is_official_path(agent: AgentKind, value: &str) -> bool {
    let markers: &[&str] = match agent {
        AgentKind::Codex => &["/.local/share/codex/"],
        AgentKind::ClaudeCode => &["/.local/share/claude/", "/.claude/"],
        AgentKind::Cursor => &[
            "/.local/share/cursor-agent/",
            "/appdata/local/cursor-agent/",
        ],
        AgentKind::OpenCode => &["/.opencode/"],
        AgentKind::OpenClaw => &["/.openclaw/"],
        AgentKind::Hermes => &["/.hermes/"],
        AgentKind::GrokBuild => &["/.grok/"],
        AgentKind::DeepSeekHarness => &[],
    };
    markers.iter().any(|marker| value.contains(marker))
}

fn cursor_desktop_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/Applications/Cursor.app/Contents/MacOS/Cursor"),
            dirs_home().join("Applications/Cursor.app/Contents/MacOS/Cursor"),
        ]
    }
    #[cfg(not(target_os = "macos"))]
    {
        command::cursor_app_candidates()
    }
}

#[cfg(unix)]
fn dirs_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn redact_home_path(path: &Path) -> PathBuf {
    let Some(home) = dirs::home_dir() else {
        return path.to_path_buf();
    };
    path.strip_prefix(&home)
        .map(|relative| PathBuf::from("~").join(relative))
        .unwrap_or_else(|_| path.to_path_buf())
}

fn redact_output(output: &str) -> String {
    let output = dirs::home_dir().map_or_else(
        || output.to_owned(),
        |home| output.replace(home.to_string_lossy().as_ref(), "~"),
    );
    output
        .lines()
        .map(|line| {
            if contains_sensitive_output(line) {
                "[REDACTED SENSITIVE OUTPUT]"
            } else {
                line
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn contains_sensitive_output(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    let compact = lower
        .chars()
        .filter(|character| !character.is_whitespace() && !matches!(character, '\'' | '"'))
        .collect::<String>();
    let sensitive_markers = [
        "authorization:",
        "authorization=",
        "token=",
        "token:",
        "password=",
        "password:",
        "secret=",
        "secret:",
        "api_key=",
        "api-key=",
        "apikey=",
        "access_key=",
        "access-key=",
        "private_key=",
        "private-key=",
        "credential=",
    ];
    sensitive_markers
        .iter()
        .any(|marker| compact.contains(marker))
        || lower.contains("bearer ")
        || ["sk-", "ghp_", "github_pat_", "xoxb-", "xoxp-"]
            .iter()
            .any(|prefix| lower.contains(prefix))
        || contains_url_userinfo(&lower)
}

fn contains_url_userinfo(line: &str) -> bool {
    let mut remaining = line;
    while let Some((_, after_scheme)) = remaining.split_once("://") {
        let authority = after_scheme
            .split(['/', '?', '#', ' '])
            .next()
            .unwrap_or_default();
        if authority
            .split_once('@')
            .is_some_and(|(userinfo, _)| userinfo.contains(':'))
        {
            return true;
        }
        remaining = after_scheme;
    }
    false
}

fn truncate_output(output: &str, limit: usize) -> String {
    if output.len() <= limit {
        return output.to_owned();
    }
    let mut end = limit.saturating_sub(3);
    while end > 0 && !output.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &output[..end])
}

fn determine_state(
    agent: AgentKind,
    installed: bool,
    has_conflict: bool,
    current: Option<&str>,
    latest: Option<&str>,
) -> AgentToolState {
    if !installed {
        return AgentToolState::Uninstalled;
    }
    if has_conflict {
        return AgentToolState::Conflict;
    }
    let (Some(current), Some(latest)) = (current, latest) else {
        return AgentToolState::Unknown;
    };
    if versions_equal(current, latest) {
        return AgentToolState::Current;
    }
    match compare_versions(agent, current, latest) {
        Some(VersionOrdering::Less) => AgentToolState::UpdateAvailable,
        Some(_) => AgentToolState::Current,
        _ => AgentToolState::Unknown,
    }
}

fn compare_versions(agent: AgentKind, current: &str, latest: &str) -> Option<VersionOrdering> {
    if agent == AgentKind::Cursor {
        let current_build = parse_cursor_build(current)?;
        let latest_build = parse_cursor_build(latest)?;
        let date_ordering = current_build.cmp(&latest_build);
        return Some(
            if date_ordering == VersionOrdering::Equal && !versions_equal(current, latest) {
                // Cursor's suffix is a commit identifier rather than an ordered build number.
                // For two different builds published on the same date, the fetched channel build
                // remains authoritative and should be offered as an update.
                VersionOrdering::Less
            } else {
                date_ordering
            },
        );
    }
    Some(parse_semver(current)?.cmp(&parse_semver(latest)?))
}

fn parse_cursor_build(value: &str) -> Option<(u16, u8, u8)> {
    value
        .split_whitespace()
        .filter(|part| part.contains('-'))
        .find_map(parse_cursor_build_part)
}

fn parse_cursor_build_part(value: &str) -> Option<(u16, u8, u8)> {
    let value = value.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric() && character != '.' && character != '-'
    });
    let (date, build) = value.split_once('-')?;
    if build.is_empty() || !build.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let mut parts = date.split('.');
    let year = parts.next()?.parse().ok()?;
    let month = parts.next()?.parse().ok()?;
    let day = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn installations_conflict(installations: &[AgentToolInstallation]) -> bool {
    // Discovery has already collapsed aliases that resolve to the same
    // physical executable. More than one remaining entry therefore means
    // updating only the PATH default could leave another real installation
    // active, so automatic changes must stay disabled.
    installations.len() > 1
}

fn parse_cursor_installer_version(script: &str) -> Option<String> {
    for marker in ["cursor-agent/versions/", "downloads.cursor.com/lab/"] {
        let Some(start) = script.find(marker).map(|index| index + marker.len()) else {
            continue;
        };
        let value = script[start..]
            .split(['/', '"', '\''])
            .next()
            .unwrap_or_default()
            .trim();
        if !value.is_empty() && !value.contains('$') {
            return Some(value.to_owned());
        }
    }
    None
}

fn versions_equal(current: &str, latest: &str) -> bool {
    current.trim().trim_start_matches('v') == latest.trim().trim_start_matches('v')
        || matches!((parse_semver(current), parse_semver(latest)), (Some(a), Some(b)) if a == b)
}

fn parse_semver(value: &str) -> Option<Version> {
    value
        .split(|character: char| character.is_whitespace() || matches!(character, '(' | ')' | ','))
        .map(|part| {
            part.trim_matches(|character: char| {
                !character.is_ascii_alphanumeric()
                    && character != '.'
                    && character != '-'
                    && character != '+'
            })
        })
        .find_map(|part| Version::parse(part.trim_start_matches('v')).ok())
}

fn nonempty_version(value: &str) -> Result<String> {
    let value = value.trim();
    ensure!(!value.is_empty(), "Version response was empty");
    Ok(value.to_owned())
}

fn read_cache(path: &Path) -> Result<VersionCache> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

fn write_cache(path: &Path, cache: &VersionCache) -> Result<()> {
    atomic_write(path, &serde_json::to_vec_pretty(cache)?)?;
    Ok(())
}

fn cached_values(cache: &VersionCache) -> BTreeMap<String, String> {
    cache
        .versions
        .iter()
        .map(|(key, entry)| (key.clone(), entry.version.clone()))
        .collect()
}

fn should_refresh(cache: &VersionCache, key: &str, force: bool, now: DateTime<Utc>) -> bool {
    force
        || cache
            .versions
            .get(key)
            .is_none_or(|entry| now - entry.checked_at >= Duration::hours(CACHE_TTL_HOURS))
}

fn apply_fetch_results(
    cache: &mut VersionCache,
    results: Vec<(String, Result<String>)>,
    now: DateTime<Utc>,
) -> (bool, Vec<String>) {
    let mut errors = Vec::new();
    let mut refreshed = false;
    for (key, result) in results {
        match result {
            Ok(version) => {
                cache.versions.insert(
                    key,
                    CachedVersion {
                        version,
                        checked_at: now,
                    },
                );
                refreshed = true;
            }
            Err(error) => errors.push(format!("{key}: {error}")),
        }
    }
    (refreshed, errors)
}

fn action_kind_name(kind: AgentToolActionKind) -> &'static str {
    match kind {
        AgentToolActionKind::Install => "install",
        AgentToolActionKind::Update => "update",
        AgentToolActionKind::OpenDocumentation => "docs",
    }
}

fn channel_name(channel: AgentToolChannel) -> &'static str {
    match channel {
        AgentToolChannel::OfficialInstaller => "official-installer",
        AgentToolChannel::Npm => "npm",
        AgentToolChannel::Pnpm => "pnpm",
        AgentToolChannel::Bun => "bun",
        AgentToolChannel::Yarn => "yarn",
        AgentToolChannel::Homebrew => "homebrew",
        AgentToolChannel::Volta => "volta",
        AgentToolChannel::DesktopApp => "desktop-app",
        AgentToolChannel::Nix => "nix",
        AgentToolChannel::Local => "local",
        AgentToolChannel::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_installation(
        id: &str,
        version: Option<&str>,
        runnable: bool,
        is_path_default: bool,
    ) -> AgentToolInstallation {
        AgentToolInstallation {
            id: id.to_owned(),
            path: PathBuf::from(format!("/tmp/{id}")),
            resolved_path: PathBuf::from(format!("/tmp/{id}")),
            version: version.map(ToOwned::to_owned),
            runnable,
            error: None,
            channel: AgentToolChannel::Homebrew,
            environment: AgentToolEnvironment::System,
            manager_path: Some(PathBuf::from("/opt/homebrew/bin/brew")),
            is_path_default,
        }
    }

    #[test]
    fn tool_catalog_excludes_deepseek_harness() {
        assert_eq!(TOOL_SPECS.len(), 7);
        assert!(
            TOOL_SPECS
                .iter()
                .all(|spec| spec.agent != AgentKind::DeepSeekHarness)
        );
        assert!(available_channels(AgentKind::DeepSeekHarness).is_empty());
    }

    #[test]
    fn official_channels_are_agent_specific() {
        assert!(available_channels(AgentKind::Codex).contains(&AgentToolChannel::Pnpm));
        assert!(!available_channels(AgentKind::ClaudeCode).contains(&AgentToolChannel::Pnpm));
        assert!(available_channels(AgentKind::OpenCode).contains(&AgentToolChannel::Yarn));
        assert_eq!(
            available_channels(AgentKind::Cursor),
            &[
                AgentToolChannel::OfficialInstaller,
                AgentToolChannel::DesktopApp
            ]
        );
    }

    #[test]
    fn package_commands_never_fall_back_to_an_unrelated_agent() {
        assert_eq!(
            package_command(AgentKind::Codex, AgentToolChannel::Pnpm, Some("1.2.3")).as_deref(),
            Some("pnpm add -g @openai/codex@1.2.3")
        );
        assert!(package_command(AgentKind::Cursor, AgentToolChannel::Npm, Some("1.2.3")).is_none());
        assert!(
            package_command(
                AgentKind::DeepSeekHarness,
                AgentToolChannel::Npm,
                Some("0.1.1")
            )
            .is_none()
        );
    }

    #[test]
    fn remote_installers_are_copy_only() {
        let spec = tool_spec(AgentKind::Cursor).unwrap();
        let action =
            install_action(spec, AgentToolChannel::OfficialInstaller, Some("1.2.3")).unwrap();
        assert_eq!(action.mode, AgentToolActionMode::CopyCommand);
        assert!(action.command.unwrap().contains("cursor.com/install"));
    }

    #[test]
    fn package_manager_install_requires_a_pinned_version_to_execute() {
        let spec = tool_spec(AgentKind::Codex).unwrap();
        let action = install_action(spec, AgentToolChannel::Npm, None).unwrap();
        assert_eq!(action.mode, AgentToolActionMode::CopyCommand);
        assert_eq!(action.target_version, None);
        assert!(action.command.unwrap().ends_with("@latest"));
    }

    #[test]
    fn package_manager_arguments_reject_untrusted_version_text() {
        assert!(
            package_manager_args(
                AgentKind::Codex,
                AgentToolChannel::Npm,
                AgentToolActionKind::Update,
                Some("1.2.3 --ignore-scripts")
            )
            .is_err()
        );
        assert_eq!(
            package_manager_args(
                AgentKind::Codex,
                AgentToolChannel::Pnpm,
                AgentToolActionKind::Update,
                Some("1.2.3")
            )
            .unwrap(),
            ["add", "-g", "@openai/codex@1.2.3"]
        );
    }

    #[test]
    fn parses_cursor_installer_version() {
        let script = r#"FINAL_DIR="$HOME/.local/share/cursor-agent/versions/2026.08.31-4057e58""#;
        assert_eq!(
            parse_cursor_installer_version(script).as_deref(),
            Some("2026.08.31-4057e58")
        );
    }

    #[test]
    fn compares_versions_without_treating_unknown_values_as_outdated() {
        assert_eq!(
            determine_state(
                AgentKind::Codex,
                true,
                false,
                Some("codex-cli 0.49.1"),
                Some("0.50.0")
            ),
            AgentToolState::UpdateAvailable
        );
        assert_eq!(
            determine_state(
                AgentKind::Codex,
                true,
                false,
                Some("build-a"),
                Some("build-b")
            ),
            AgentToolState::Unknown
        );
    }

    #[test]
    fn compares_cursor_build_identifiers_without_semver() {
        assert_eq!(
            determine_state(
                AgentKind::Cursor,
                true,
                false,
                Some("2025.09.18-7ae6800"),
                Some("2026.08.31-4057e58")
            ),
            AgentToolState::UpdateAvailable
        );
        assert!(version_reaches_target(
            AgentKind::Cursor,
            "2026.09.01-abcdef0",
            "2026.08.31-4057e58"
        ));
        assert!(!version_reaches_target(
            AgentKind::Cursor,
            "2026.08.31-deadbee",
            "2026.08.31-4057e58"
        ));
        assert_eq!(
            parse_cursor_build("cursor-agent 2025.09.18-7ae6800"),
            Some((2025, 9, 18))
        );
    }

    #[test]
    fn distinct_physical_installations_always_conflict() {
        let matching = [
            test_installation("path-default", Some("codex-cli 1.0.0"), true, true),
            test_installation("secondary", Some("1.0.0"), true, false),
        ];
        assert!(installations_conflict(&matching));
        assert!(!installations_conflict(&matching[..1]));
        assert!(!installations_conflict(&[]));

        assert_eq!(
            determine_state(AgentKind::Codex, true, true, Some("1.0.0"), Some("1.0.0")),
            AgentToolState::Conflict
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn chatgpt_bundled_codex_is_not_a_managed_cli() {
        assert!(is_bundled_desktop_executable(
            AgentKind::Codex,
            Path::new("/Applications/ChatGPT.app/Contents/Resources/codex")
        ));
        assert!(!is_bundled_desktop_executable(
            AgentKind::Codex,
            Path::new("/opt/homebrew/bin/codex")
        ));
        assert!(known_cli_candidates(AgentKind::Codex).is_empty());
    }

    #[test]
    fn infers_candidate_installation_channels_from_paths() {
        assert_eq!(
            infer_channel(
                AgentKind::OpenCode,
                Path::new("/opt/homebrew/Cellar/opencode/1/bin/opencode")
            ),
            AgentToolChannel::Homebrew
        );
        assert_eq!(
            infer_channel(
                AgentKind::Cursor,
                Path::new("/home/user/.local/share/cursor-agent/versions/1/agent")
            ),
            AgentToolChannel::OfficialInstaller
        );
        assert_eq!(
            infer_channel(
                AgentKind::Cursor,
                Path::new("C:\\Users\\tester\\AppData\\Local\\cursor-agent\\cursor-agent.cmd")
            ),
            AgentToolChannel::OfficialInstaller
        );
        assert_eq!(
            infer_channel(AgentKind::Codex, Path::new("/home/user/.local/bin/codex")),
            AgentToolChannel::Local
        );
        assert_eq!(
            infer_channel(
                AgentKind::Codex,
                Path::new("C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd")
            ),
            AgentToolChannel::Npm
        );
        assert_eq!(
            infer_channel(
                AgentKind::OpenCode,
                Path::new("C:\\Users\\tester\\AppData\\Local\\pnpm\\opencode.cmd")
            ),
            AgentToolChannel::Pnpm
        );
    }

    #[test]
    fn rejects_unrelated_cursor_agent_aliases() {
        let spec = tool_spec(AgentKind::Cursor).unwrap();

        assert!(is_ambiguous_cursor_agent_alias(
            spec,
            Path::new("/usr/local/bin/agent")
        ));
        assert!(!is_ambiguous_cursor_agent_alias(
            spec,
            Path::new("/home/user/.local/share/cursor-agent/versions/1/agent")
        ));
        assert!(!is_ambiguous_cursor_agent_alias(
            spec,
            Path::new("/usr/local/bin/cursor-agent")
        ));
    }

    #[test]
    fn package_manager_ownership_requires_the_expected_package_path() {
        assert!(manager_path_matches_package(
            AgentKind::Codex,
            AgentToolChannel::Pnpm,
            Path::new(
                "/home/user/.local/share/pnpm/global/5/.pnpm/@openai+codex@1.2.3/node_modules/@openai/codex/bin/codex"
            )
        ));
        assert!(!manager_path_matches_package(
            AgentKind::Codex,
            AgentToolChannel::Pnpm,
            Path::new(
                "/home/user/.local/share/pnpm/global/5/.pnpm/example@1.2.3/node_modules/example/bin/codex"
            )
        ));
        assert!(manager_path_matches_package(
            AgentKind::Codex,
            AgentToolChannel::Npm,
            Path::new("C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd")
        ));
        assert!(manager_path_matches_package(
            AgentKind::Codex,
            AgentToolChannel::Npm,
            Path::new("/Users/tester/.local/share/mise/shims/codex")
        ));
        assert!(manager_path_matches_package(
            AgentKind::Codex,
            AgentToolChannel::Pnpm,
            Path::new("/Users/tester/Library/pnpm/codex")
        ));
    }

    #[test]
    fn package_manager_list_parsers_match_exact_packages() {
        let npm = serde_json::json!({
            "dependencies": {
                "@openai/codex": { "version": "1.2.3" },
                "example": { "version": "2.0.0" }
            }
        });
        let pnpm = serde_json::json!([{
            "dependencies": {
                "opencode-ai": { "version": "1.0.0" }
            }
        }]);
        assert!(package_listing_json_contains(&npm, "@openai/codex"));
        assert!(!package_listing_json_contains(&npm, "codex"));
        assert!(package_listing_json_contains(&pnpm, "opencode-ai"));
        assert!(text_package_listing_contains(
            "└── @xai-official/grok@0.3.1",
            "@xai-official/grok"
        ));
        assert!(!text_package_listing_contains(
            "└── @xai-official/grok-extra@0.3.1",
            "@xai-official/grok"
        ));
    }

    #[test]
    fn cache_is_keyed_by_release_source() {
        let sources = release_sources();
        assert!(sources.contains_key("npm:@openai/codex"));
        assert!(sources.contains_key("homebrew-cask:codex"));
        assert!(sources.contains_key("homebrew-formula:opencode"));
        assert!(!sources.keys().any(|key| key.contains("deepseek")));
    }

    #[tokio::test]
    async fn valid_ttl_cache_does_not_report_an_offline_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let inspector = ToolInspector::new(directory.path().to_path_buf()).unwrap();
        let now = Utc::now();
        let sources = release_sources();
        let cache = VersionCache {
            versions: sources
                .keys()
                .map(|key| {
                    (
                        key.clone(),
                        CachedVersion {
                            version: "1.0.0".to_owned(),
                            checked_at: now,
                        },
                    )
                })
                .collect(),
        };
        write_cache(&inspector.cache_path, &cache).unwrap();

        let (_, _, status, errors) = inspector.latest_versions(false, now, &sources).await;

        assert_eq!(status, AgentToolCacheStatus::Fresh);
        assert!(errors.is_empty());
    }

    #[test]
    fn execution_output_is_limited_on_utf8_boundaries() {
        let output = "测".repeat(100);
        let truncated = truncate_output(&output, 64);
        assert!(truncated.len() <= 64);
        assert!(truncated.ends_with("..."));
    }

    #[test]
    fn execution_output_redacts_credentials_and_home_paths() {
        let home = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("/home/tester"))
            .to_string_lossy()
            .into_owned();
        let output = format!(
            "cache: {home}/.npm\nAuthorization: Bearer private-token\nBearer standalone-token\nregistry=https://user:password@example.test/npm\nGITHUB_TOKEN=private\nplain diagnostic"
        );

        let redacted = redact_output(&output);

        assert!(!redacted.contains(&home));
        assert!(!redacted.contains("private-token"));
        assert!(!redacted.contains("standalone-token"));
        assert!(!redacted.contains("user:password"));
        assert!(!redacted.contains("GITHUB_TOKEN"));
        assert!(redacted.contains("plain diagnostic"));
    }

    #[cfg(unix)]
    #[test]
    fn known_cli_candidates_include_native_grok_outside_path() {
        let home = Path::new("/home/tester");

        assert_eq!(
            known_unix_cli_candidates(AgentKind::GrokBuild, home),
            [home.join(".grok/bin/grok")]
        );
        assert_eq!(
            known_unix_cli_candidates(AgentKind::OpenCode, home),
            [home.join(".opencode/bin/opencode")]
        );
    }

    #[cfg(unix)]
    #[test]
    fn anchored_manager_is_resolved_beside_the_detected_installation() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let codex = directory.path().join("codex");
        let npm = directory.path().join("npm");
        for path in [&codex, &npm] {
            std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        assert_eq!(
            anchored_manager_path(AgentKind::Codex, AgentToolChannel::Npm, &codex),
            Some(npm)
        );
    }

    #[test]
    fn update_action_is_bound_to_the_detected_manager_and_installation() {
        let spec = TOOL_SPECS
            .into_iter()
            .find(|value| value.agent == AgentKind::Codex)
            .unwrap();
        let installation = DetectedInstallation {
            public: AgentToolInstallation {
                id: "codex:nvm-installation".to_owned(),
                path: PathBuf::from("/opt/nvm/versions/node/v22/bin/codex"),
                resolved_path: PathBuf::from("/opt/nvm/versions/node/v22/bin/codex"),
                version: Some("1.0.0".to_owned()),
                runnable: true,
                error: None,
                channel: AgentToolChannel::Npm,
                environment: AgentToolEnvironment::Nvm,
                manager_path: Some(PathBuf::from("/opt/nvm/versions/node/v22/bin/npm")),
                is_path_default: true,
            },
            executable_path: PathBuf::from("/opt/nvm/versions/node/v22/bin/codex"),
            manager_path: Some(PathBuf::from("/opt/nvm/versions/node/v22/bin/npm")),
        };

        let action = update_action(spec, &installation, Some("1.1.0")).unwrap();

        assert_eq!(action.mode, AgentToolActionMode::Execute);
        assert_eq!(
            action.installation_id.as_deref(),
            Some("codex:nvm-installation")
        );
        assert_eq!(
            action.manager_path.as_deref(),
            Some(Path::new("/opt/nvm/versions/node/v22/bin/npm"))
        );
        let expected_command = display_command(
            Path::new("/opt/nvm/versions/node/v22/bin/npm"),
            &[
                "install".to_owned(),
                "-g".to_owned(),
                "@openai/codex@1.1.0".to_owned(),
            ],
            current_shell(),
        );
        assert_eq!(action.command.as_deref(), Some(expected_command.as_str()));
        assert_eq!(action.shell, Some(current_shell()));
        assert!(action.id.contains("codex:nvm-installation"));

        let mut moved = installation;
        moved.manager_path = Some(PathBuf::from("/usr/local/bin/npm"));
        moved.public.manager_path = moved.manager_path.clone();
        assert_ne!(
            action.id,
            update_action(spec, &moved, Some("1.1.0")).unwrap().id
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_manager_is_resolved_only_from_default_directories() {
        use std::os::unix::fs::PermissionsExt;

        let default_directory = tempfile::tempdir().unwrap();
        let inactive_directory = tempfile::tempdir().unwrap();
        let default_manager = default_directory.path().join("npm");
        let inactive_manager = inactive_directory.path().join("npm");
        for path in [&default_manager, &inactive_manager] {
            std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        assert_eq!(
            manager_program_in(
                AgentToolChannel::Npm,
                &[default_directory.path().to_path_buf()]
            ),
            Some(default_manager)
        );
        assert_eq!(
            manager_program_in(AgentToolChannel::Npm, &[]),
            None,
            "an inactive manager must not be used as an install target"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn executable_update_invokes_the_bound_manager_path() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let manager = directory.path().join("npm");
        std::fs::write(&manager, "#!/bin/sh\nprintf 'bound:%s' \"$*\"\n").unwrap();
        std::fs::set_permissions(&manager, std::fs::Permissions::from_mode(0o755)).unwrap();
        let spec = TOOL_SPECS
            .into_iter()
            .find(|value| value.agent == AgentKind::Codex)
            .unwrap();
        let installation = DetectedInstallation {
            public: AgentToolInstallation {
                id: "codex:bound".to_owned(),
                path: directory.path().join("codex"),
                resolved_path: directory.path().join("codex"),
                version: Some("1.0.0".to_owned()),
                runnable: true,
                error: None,
                channel: AgentToolChannel::Npm,
                environment: AgentToolEnvironment::Nvm,
                manager_path: Some(manager.clone()),
                is_path_default: true,
            },
            executable_path: directory.path().join("codex"),
            manager_path: Some(manager.clone()),
        };
        let action = update_action(spec, &installation, Some("1.1.0")).unwrap();
        let tool = AgentToolStatus {
            agent: AgentKind::Codex,
            installed: true,
            current_version: Some("1.0.0".to_owned()),
            latest_version: Some("1.1.0".to_owned()),
            recommended_version: Some("1.1.0".to_owned()),
            upstream_version: Some("1.1.0".to_owned()),
            state: AgentToolState::UpdateAvailable,
            channel: AgentToolChannel::Npm,
            installations: vec![installation.public.clone()],
            warnings: Vec::new(),
            official_url: spec.official_url.to_owned(),
            release_url: spec.release_url.map(ToOwned::to_owned),
            actions: vec![action.clone()],
        };

        let (program, args) = executable_action(spec, &tool, &action, Some(&installation)).unwrap();
        assert_eq!(program, manager);
        let cancelled = AtomicBool::new(false);
        let outcome = run_action(&program, &args, &cancelled).await.unwrap();

        assert_eq!(outcome.status, AgentToolExecutionStatus::Succeeded);
        assert_eq!(outcome.output, "bound:install -g @openai/codex@1.1.0");
    }

    #[test]
    fn bound_program_directory_leads_the_child_path() {
        let current =
            std::env::join_paths([Path::new("/system/bin"), Path::new("/other/bin")]).unwrap();
        let anchored =
            anchored_search_path(Path::new("/managed/node/bin/npm"), Some(&current)).unwrap();
        let directories = std::env::split_paths(&anchored).collect::<Vec<_>>();

        assert_eq!(directories[0], PathBuf::from("/managed/node/bin"));
        assert_eq!(directories[1], PathBuf::from("/system/bin"));
        assert_eq!(directories[2], PathBuf::from("/other/bin"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn execution_timeout_covers_descendants_holding_output_open() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let wrapper = directory.path().join("wrapper");
        std::fs::write(&wrapper, "#!/bin/sh\n(sleep 5) &\nexit 0\n").unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();

        let started = std::time::Instant::now();
        let cancelled = AtomicBool::new(false);
        let outcome =
            run_action_with_timeout(&wrapper, &[], StdDuration::from_millis(100), &cancelled)
                .await
                .unwrap();

        assert_eq!(outcome.status, AgentToolExecutionStatus::TimedOut);
        assert!(started.elapsed() < StdDuration::from_secs(2));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_interrupts_descendant_output_drain() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let wrapper = directory.path().join("wrapper");
        std::fs::write(&wrapper, "#!/bin/sh\nsleep 0.05\n(sleep 5) &\nexit 0\n").unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancelled = std::sync::Arc::new(AtomicBool::new(false));
        let worker_cancelled = std::sync::Arc::clone(&cancelled);
        std::thread::spawn(move || {
            std::thread::sleep(StdDuration::from_millis(200));
            worker_cancelled.store(true, Ordering::SeqCst);
        });

        let started = std::time::Instant::now();
        let result =
            run_action_with_timeout(&wrapper, &[], StdDuration::from_secs(5), &cancelled).await;

        let error = result.err().expect("cancellation should stop the command");
        assert!(error.to_string().contains("cancelled"));
        assert!(started.elapsed() < StdDuration::from_secs(2));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_version_probe_terminates_descendants() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let probe = directory.path().join("probe");
        let descendant_ready = directory.path().join("descendant-ready");
        let trigger = directory.path().join("trigger");
        let survived = directory.path().join("survived");
        std::fs::write(
            &probe,
            "#!/bin/sh\n(printf ready > \"$1\"; while [ ! -e \"$2\" ]; do sleep 0.05; done; printf survived > \"$3\") &\nwait\n",
        )
        .unwrap();
        std::fs::set_permissions(&probe, std::fs::Permissions::from_mode(0o755)).unwrap();

        let task_probe = probe.clone();
        let task_ready = descendant_ready.clone();
        let task_trigger = trigger.clone();
        let task_survived = survived.clone();
        let task = tokio::spawn(async move {
            let ready = task_ready.to_string_lossy().into_owned();
            let trigger = task_trigger.to_string_lossy().into_owned();
            let survived = task_survived.to_string_lossy().into_owned();
            probe_version(&task_probe, &[&ready, &trigger, &survived]).await
        });
        tokio::time::timeout(StdDuration::from_secs(15), async {
            while !descendant_ready.exists() {
                tokio::time::sleep(StdDuration::from_millis(10)).await;
            }
        })
        .await
        .expect("probe descendant did not start");
        assert!(
            !survived.exists(),
            "probe descendant ran before cancellation"
        );

        task.abort();
        let _ = task.await;
        std::fs::write(&trigger, "continue").unwrap();
        tokio::time::sleep(StdDuration::from_millis(500)).await;

        assert!(!survived.exists(), "probe descendant survived cancellation");
    }

    #[test]
    fn execution_rejects_installation_set_changes_after_confirmation() {
        let installation = DetectedInstallation {
            public: test_installation("one", Some("1.0.0"), true, true),
            executable_path: PathBuf::from("/tmp/one"),
            manager_path: Some(PathBuf::from("/opt/homebrew/bin/brew")),
        };

        assert!(ensure_installation_set_stable(AgentToolActionKind::Install, &[]).is_ok());
        assert!(
            ensure_installation_set_stable(
                AgentToolActionKind::Install,
                std::slice::from_ref(&installation)
            )
            .is_err()
        );
        assert!(
            ensure_installation_set_stable(
                AgentToolActionKind::Update,
                std::slice::from_ref(&installation)
            )
            .is_ok()
        );
        assert!(
            ensure_installation_set_stable(
                AgentToolActionKind::Update,
                &[installation.clone(), installation]
            )
            .is_err()
        );
    }

    #[test]
    fn execution_rejects_version_changes_after_confirmation() {
        let spec = tool_spec(AgentKind::Codex).unwrap();
        let installation = |version: &str, runnable: bool| DetectedInstallation {
            public: test_installation("codex", Some(version), runnable, true),
            executable_path: PathBuf::from("/opt/homebrew/bin/codex"),
            manager_path: Some(PathBuf::from("/opt/homebrew/bin/brew")),
        };
        let confirmed = installation("1.0.0", true);
        let action = update_action(spec, &confirmed, Some("2.0.0")).unwrap();
        let tool = AgentToolStatus {
            agent: AgentKind::Codex,
            installed: true,
            current_version: Some("1.0.0".to_owned()),
            latest_version: Some("2.0.0".to_owned()),
            recommended_version: Some("2.0.0".to_owned()),
            upstream_version: Some("2.0.0".to_owned()),
            state: AgentToolState::UpdateAvailable,
            channel: AgentToolChannel::Homebrew,
            installations: vec![confirmed.public.clone()],
            warnings: Vec::new(),
            official_url: spec.official_url.to_owned(),
            release_url: spec.release_url.map(ToOwned::to_owned),
            actions: vec![action.clone()],
        };

        assert!(
            ensure_update_target_still_applicable(
                AgentKind::Codex,
                &tool,
                &action,
                Some(&confirmed)
            )
            .is_ok()
        );
        assert!(
            ensure_update_target_still_applicable(
                AgentKind::Codex,
                &tool,
                &action,
                Some(&installation("3.0.0", true))
            )
            .is_err()
        );
        assert!(
            ensure_update_target_still_applicable(
                AgentKind::Codex,
                &tool,
                &action,
                Some(&installation("1.0.0", false))
            )
            .is_err()
        );
    }

    #[test]
    fn homebrew_actions_are_manual_because_versions_cannot_be_pinned() {
        let spec = tool_spec(AgentKind::Codex).unwrap();
        let install = install_action(spec, AgentToolChannel::Homebrew, Some("1.2.3")).unwrap();
        assert_ne!(install.mode, AgentToolActionMode::Execute);

        let installation = DetectedInstallation {
            public: test_installation("brew", Some("1.0.0"), true, true),
            executable_path: PathBuf::from("/opt/homebrew/bin/codex"),
            manager_path: Some(PathBuf::from("/opt/homebrew/bin/brew")),
        };
        let update = update_action(spec, &installation, Some("1.2.3")).unwrap();
        assert_eq!(update.mode, AgentToolActionMode::CopyCommand);
    }

    #[test]
    fn official_updater_actions_are_manual_because_versions_cannot_be_pinned() {
        let spec = tool_spec(AgentKind::Cursor).unwrap();
        let mut public = test_installation("cursor", Some("2025.09.18-7ae6800"), true, true);
        public.channel = AgentToolChannel::OfficialInstaller;
        public.manager_path = None;
        let installation = DetectedInstallation {
            executable_path: PathBuf::from("/home/tester/.local/bin/cursor-agent"),
            manager_path: None,
            public,
        };

        let action = update_action(spec, &installation, Some("2026.08.31-4057e58")).unwrap();

        assert_eq!(action.mode, AgentToolActionMode::CopyCommand);
        let expected_command = display_command(
            Path::new("/home/tester/.local/bin/cursor-agent"),
            &["update".to_owned()],
            current_shell(),
        );
        assert_eq!(action.command.as_deref(), Some(expected_command.as_str()));
        assert_eq!(action.shell, Some(current_shell()));
    }

    #[test]
    fn posix_display_command_expands_home_with_spaces() {
        assert_eq!(
            display_command(
                Path::new("~/My Tools/cursor-agent"),
                &["update".to_owned()],
                AgentToolShell::Posix,
            ),
            r#""$HOME"/'My Tools/cursor-agent' update"#
        );
    }

    #[test]
    fn posix_display_command_quotes_home_path_special_characters() {
        assert_eq!(
            display_command(
                Path::new("~/Node! $`\"'\\ Tools/npm"),
                &["install".to_owned()],
                AgentToolShell::Posix,
            ),
            r#""$HOME"/'Node! $`"'"'"'\ Tools/npm' install"#
        );
    }

    #[test]
    fn powershell_display_command_invokes_home_relative_program() {
        assert_eq!(
            display_command(
                Path::new(r"~\AppData\Local\cursor-agent\cursor-agent.cmd"),
                &["update".to_owned()],
                AgentToolShell::Powershell,
            ),
            r#"& "$HOME\AppData\Local\cursor-agent\cursor-agent.cmd" update"#
        );
    }

    #[test]
    fn powershell_display_command_quotes_absolute_program() {
        assert_eq!(
            display_command(
                Path::new(r"C:\Program Files\Claude\claude.exe"),
                &["update".to_owned()],
                AgentToolShell::Powershell,
            ),
            r#"& 'C:\Program Files\Claude\claude.exe' update"#
        );
    }

    #[test]
    fn recognizes_node_version_manager_environments() {
        assert_eq!(
            infer_environment(
                AgentToolChannel::Npm,
                Path::new("/Users/me/.nvm/versions/node/v22/bin/codex")
            ),
            AgentToolEnvironment::Nvm
        );
        assert_eq!(
            infer_environment(
                AgentToolChannel::Npm,
                Path::new("/Users/me/.local/share/fnm/node-versions/v22/installation/bin/codex")
            ),
            AgentToolEnvironment::Fnm
        );
        assert_eq!(
            infer_environment(
                AgentToolChannel::Npm,
                Path::new("/Users/me/.local/share/mise/installs/node/22/bin/codex")
            ),
            AgentToolEnvironment::Mise
        );
        assert_eq!(
            infer_channel(AgentKind::Codex, Path::new("/Users/me/.volta/bin/codex")),
            AgentToolChannel::Volta
        );
        assert_eq!(
            infer_channel(
                AgentKind::Codex,
                Path::new("/Users/me/.local/share/mise/shims/codex")
            ),
            AgentToolChannel::Npm
        );
        assert_eq!(
            infer_channel(AgentKind::Codex, Path::new("/Users/me/Library/pnpm/codex")),
            AgentToolChannel::Pnpm
        );
    }

    #[test]
    fn mise_alias_collapse_keeps_other_physical_installations() {
        let shim = PathBuf::from("/Users/me/.local/share/mise/shims/codex");
        let active = PathBuf::from("/Users/me/.local/share/mise/installs/node/22/bin/codex");
        let inactive = PathBuf::from("/Users/me/.local/share/mise/installs/node/20/bin/codex");
        let mut candidates = vec![
            (shim.clone(), true),
            (active.clone(), false),
            (inactive.clone(), false),
        ];

        assert!(collapse_mise_aliases(&mut candidates, &active));
        assert_eq!(candidates, [(shim, true), (inactive, false)]);

        let unrelated = Path::new("/Users/me/.local/share/mise/installs/node/18/bin/codex");
        assert!(!collapse_mise_aliases(&mut candidates, unrelated));
        assert_eq!(candidates.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn installation_id_survives_a_replaced_symlink_target() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("codex-v1");
        let second = directory.path().join("codex-v2");
        let entry = directory.path().join("codex");
        std::fs::write(&first, "v1").unwrap();
        std::fs::write(&second, "v2").unwrap();
        symlink(&first, &entry).unwrap();
        let before = installation_id(AgentKind::Codex, &entry);
        std::fs::remove_file(&entry).unwrap();
        symlink(&second, &entry).unwrap();

        assert_eq!(before, installation_id(AgentKind::Codex, &entry));
    }

    #[test]
    fn verification_rejects_unchanged_and_unrunnable_updates() {
        let action = AgentToolAction {
            id: "action".to_owned(),
            kind: AgentToolActionKind::Update,
            mode: AgentToolActionMode::Execute,
            channel: AgentToolChannel::Npm,
            shell: Some(AgentToolShell::Posix),
            command: Some("npm".to_owned()),
            url: None,
            target_version: Some("2.0.0".to_owned()),
            installation_id: Some("codex:one".to_owned()),
            manager_path: Some(PathBuf::from("/bin/npm")),
        };
        let installation = |version: Option<&str>, runnable: bool| DetectedInstallation {
            public: AgentToolInstallation {
                id: "codex:one".to_owned(),
                path: PathBuf::from("/bin/codex"),
                resolved_path: PathBuf::from("/bin/codex"),
                version: version.map(ToOwned::to_owned),
                runnable,
                error: None,
                channel: AgentToolChannel::Npm,
                environment: AgentToolEnvironment::System,
                manager_path: Some(PathBuf::from("/bin/npm")),
                is_path_default: true,
            },
            executable_path: PathBuf::from("/bin/codex"),
            manager_path: Some(PathBuf::from("/bin/npm")),
        };

        assert_eq!(
            verify_execution(
                AgentKind::Codex,
                &action,
                Some("1.0.0"),
                &[installation(Some("1.0.0"), true)]
            )
            .0,
            AgentToolExecutionStatus::Unchanged
        );
        assert_eq!(
            verify_execution(
                AgentKind::Codex,
                &action,
                Some("1.0.0"),
                &[installation(None, false)]
            )
            .0,
            AgentToolExecutionStatus::VerificationFailed
        );
        assert_eq!(
            verify_execution(
                AgentKind::Codex,
                &action,
                Some("1.0.0"),
                &[installation(Some("2.0.0"), true)]
            )
            .0,
            AgentToolExecutionStatus::Succeeded
        );

        let install = AgentToolAction {
            kind: AgentToolActionKind::Install,
            installation_id: None,
            ..action
        };
        let mut non_default = installation(Some("2.0.0"), true);
        non_default.public.is_path_default = false;
        assert_eq!(
            verify_execution(AgentKind::Codex, &install, None, &[non_default]).0,
            AgentToolExecutionStatus::VerificationFailed
        );
        assert_eq!(
            verify_execution(
                AgentKind::Codex,
                &install,
                None,
                &[installation(Some("2.0.0"), true)]
            )
            .0,
            AgentToolExecutionStatus::Succeeded
        );

        let mut conflicting = installation(Some("2.0.0"), true);
        conflicting.public.id = "codex:two".to_owned();
        conflicting.public.path = PathBuf::from("/opt/codex");
        conflicting.public.resolved_path = PathBuf::from("/opt/codex");
        conflicting.public.is_path_default = false;
        assert_eq!(
            verify_execution(
                AgentKind::Codex,
                &install,
                None,
                &[installation(Some("2.0.0"), true), conflicting]
            )
            .0,
            AgentToolExecutionStatus::VerificationFailed
        );
    }

    #[test]
    fn execution_lock_rejects_concurrent_operations() {
        let lock = EXECUTION_LOCK.get_or_init(|| Mutex::new(()));
        let guard = lock
            .try_lock()
            .expect("first operation should acquire the lock");
        assert!(lock.try_lock().is_err());
        drop(guard);
        assert!(lock.try_lock().is_ok());
    }
}
