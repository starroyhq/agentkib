use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use agentkib_platform::fs::atomic_write;
use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const DASHBOARD_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaBackend {
    CodexBarCli,
    WinCodexBar,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuotaFreshness {
    Fresh,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectorCapabilities {
    pub platform_supported: bool,
    pub sidecar_available: bool,
    pub multi_account: bool,
    pub credits: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaIdentity {
    pub account_email: Option<String>,
    pub plan: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaWindow {
    pub kind: String,
    pub label: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    pub reset_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaCredits {
    pub remaining: f64,
    pub unit: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaAccount {
    pub id: String,
    pub label: String,
    pub active: bool,
    pub identity: Option<QuotaIdentity>,
    pub windows: Vec<QuotaWindow>,
    pub error: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaProviderStatus {
    pub level: String,
    pub label: String,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaProvider {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub source: Option<String>,
    pub status: Option<QuotaProviderStatus>,
    pub identity: Option<QuotaIdentity>,
    pub windows: Vec<QuotaWindow>,
    pub credits: Option<QuotaCredits>,
    pub error: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
    pub accounts: Vec<QuotaAccount>,
}

impl QuotaProvider {
    pub fn lowest_remaining_percent(&self) -> Option<f64> {
        self.windows
            .iter()
            .map(|window| window.remaining_percent)
            .chain(
                self.accounts
                    .iter()
                    .flat_map(|account| account.windows.iter())
                    .map(|window| window.remaining_percent),
            )
            .reduce(f64::min)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaSnapshot {
    pub schema_version: u32,
    pub backend: QuotaBackend,
    pub backend_version: Option<String>,
    pub generated_at: DateTime<Utc>,
    pub fetched_at: DateTime<Utc>,
    pub stale_after_seconds: u64,
    pub freshness: QuotaFreshness,
    pub providers: Vec<QuotaProvider>,
}

impl QuotaSnapshot {
    /// A successful process exit is not evidence that any provider returned quota.
    pub fn has_usable_quota(&self) -> bool {
        self.providers.iter().any(|provider| {
            provider.enabled
                && ((provider.error.is_none()
                    && (!provider.windows.is_empty() || provider.credits.is_some()))
                    || provider
                        .accounts
                        .iter()
                        .any(|account| account.error.is_none() && !account.windows.is_empty()))
        })
    }

    pub fn refresh_freshness(&mut self, now: DateTime<Utc>) {
        let stale_at =
            self.generated_at + chrono::Duration::seconds(self.stale_after_seconds.max(1) as i64);
        self.freshness = if now > stale_at {
            QuotaFreshness::Stale
        } else {
            QuotaFreshness::Fresh
        };
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaCollectorStatus {
    pub backend: QuotaBackend,
    pub backend_version: Option<String>,
    pub platform_supported: bool,
    pub sidecar_available: bool,
    pub config_source: String,
    pub last_attempt_at: Option<DateTime<Utc>>,
    pub last_success_at: Option<DateTime<Utc>>,
    pub running: bool,
    pub error_key: Option<String>,
    pub error_detail: Option<String>,
}

pub trait QuotaCollector {
    fn backend(&self) -> QuotaBackend;
    fn capabilities(&self) -> CollectorCapabilities;
    fn collect(&self, timeout: Duration) -> Result<QuotaSnapshot>;
}

#[derive(Debug, Clone)]
pub struct QuotaCommandOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub success: bool,
}

pub trait QuotaCommandRunner: Send + Sync {
    fn run(
        &self,
        args: &[String],
        env: &BTreeMap<String, String>,
        timeout: Duration,
    ) -> Result<QuotaCommandOutput>;
}

pub struct DashboardCliCollector<R> {
    backend: QuotaBackend,
    runner: R,
    environment: BTreeMap<String, String>,
    capabilities: CollectorCapabilities,
}

impl<R> DashboardCliCollector<R> {
    pub fn new(
        backend: QuotaBackend,
        runner: R,
        environment: BTreeMap<String, String>,
        capabilities: CollectorCapabilities,
    ) -> Self {
        Self {
            backend,
            runner,
            environment,
            capabilities,
        }
    }
}

impl<R: QuotaCommandRunner> QuotaCollector for DashboardCliCollector<R> {
    fn backend(&self) -> QuotaBackend {
        self.backend
    }

    fn capabilities(&self) -> CollectorCapabilities {
        self.capabilities.clone()
    }

    fn collect(&self, timeout: Duration) -> Result<QuotaSnapshot> {
        if !self.capabilities.platform_supported {
            bail!("quota collector is not supported on this platform");
        }
        if !self.capabilities.sidecar_available {
            bail!("quota collector sidecar is unavailable");
        }
        let provider_timeout_seconds = match self.backend {
            // Win-CodexBar enables Codex and Claude by default. Keep a missing
            // provider from consuming nearly the complete outer collection timeout,
            // while still returning successful providers as partial dashboard data.
            QuotaBackend::WinCodexBar => 12,
            QuotaBackend::CodexBarCli => 25,
        };
        let args = vec![
            "dashboard".to_string(),
            "--identity".to_string(),
            "full".to_string(),
            "--timeout".to_string(),
            provider_timeout_seconds.to_string(),
        ];
        let output = self.runner.run(&args, &self.environment, timeout)?;
        if !output.success {
            let diagnostic = sanitize_diagnostic(&String::from_utf8_lossy(&output.stderr));
            if diagnostic.is_empty() {
                bail!("quota collector command failed");
            }
            bail!("quota collector command failed: {diagnostic}");
        }
        let snapshot = parse_dashboard_snapshot(&output.stdout, self.backend, Utc::now())?;
        if !snapshot.has_usable_quota() {
            bail!("quota collector returned no usable quota for enabled providers");
        }
        Ok(snapshot)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardSnapshot {
    schema_version: u32,
    generated_at: DateTime<Utc>,
    stale_after_seconds: u64,
    host: DashboardHost,
    #[serde(default)]
    providers: Vec<DashboardProvider>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardHost {
    codex_bar_version: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardProvider {
    id: String,
    name: String,
    enabled: bool,
    source: Option<String>,
    status: Option<DashboardStatus>,
    identity: Option<DashboardIdentity>,
    #[serde(default)]
    windows: Vec<DashboardWindow>,
    credits: Option<DashboardCredits>,
    error: Option<serde_json::Value>,
    updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    accounts: Vec<DashboardAccount>,
    accounts_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardStatus {
    level: String,
    label: String,
    updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardIdentity {
    account_email: Option<String>,
    plan: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardWindow {
    kind: String,
    label: String,
    used_percent: f64,
    remaining_percent: f64,
    reset_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct DashboardCredits {
    remaining: f64,
    unit: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DashboardAccount {
    id: String,
    label: String,
    active: bool,
    identity: Option<DashboardIdentity>,
    #[serde(default)]
    windows: Vec<DashboardWindow>,
    error: Option<String>,
    updated_at: Option<DateTime<Utc>>,
}

pub fn parse_dashboard_snapshot(
    input: &[u8],
    backend: QuotaBackend,
    fetched_at: DateTime<Utc>,
) -> Result<QuotaSnapshot> {
    let payload: DashboardSnapshot =
        serde_json::from_slice(input).context("invalid dashboard-v1 JSON")?;
    if payload.schema_version != DASHBOARD_SCHEMA_VERSION {
        bail!(
            "unsupported dashboard schema version {}",
            payload.schema_version
        );
    }
    let providers = payload
        .providers
        .into_iter()
        .map(normalize_provider)
        .collect::<Result<Vec<_>>>()?;
    let mut snapshot = QuotaSnapshot {
        schema_version: payload.schema_version,
        backend,
        backend_version: payload.host.codex_bar_version,
        generated_at: payload.generated_at,
        fetched_at,
        stale_after_seconds: payload.stale_after_seconds,
        freshness: QuotaFreshness::Fresh,
        providers,
    };
    snapshot.refresh_freshness(fetched_at);
    Ok(snapshot)
}

fn normalize_provider(provider: DashboardProvider) -> Result<QuotaProvider> {
    let windows = provider
        .windows
        .into_iter()
        .map(normalize_window)
        .collect::<Result<Vec<_>>>()?;
    let accounts = provider
        .accounts
        .into_iter()
        .map(|account| {
            Ok(QuotaAccount {
                id: account.id,
                label: account.label,
                active: account.active,
                identity: account.identity.map(normalize_identity),
                windows: account
                    .windows
                    .into_iter()
                    .map(normalize_window)
                    .collect::<Result<Vec<_>>>()?,
                error: account.error.map(|error| sanitize_diagnostic(&error)),
                updated_at: account.updated_at,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(QuotaProvider {
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        source: provider.source,
        status: provider.status.map(|status| QuotaProviderStatus {
            level: status.level,
            label: status.label,
            updated_at: status.updated_at,
        }),
        identity: provider.identity.map(normalize_identity),
        windows,
        credits: provider.credits.map(|credits| QuotaCredits {
            remaining: credits.remaining,
            unit: credits.unit,
        }),
        error: provider.error.as_ref().map(error_text).or_else(|| {
            provider
                .accounts_error
                .map(|error| sanitize_diagnostic(&error))
        }),
        updated_at: provider.updated_at,
        accounts,
    })
}

fn normalize_identity(identity: DashboardIdentity) -> QuotaIdentity {
    QuotaIdentity {
        account_email: identity.account_email,
        plan: identity.plan,
    }
}

fn normalize_window(window: DashboardWindow) -> Result<QuotaWindow> {
    if !window.used_percent.is_finite() || !window.remaining_percent.is_finite() {
        bail!("quota window percentage is not finite");
    }
    Ok(QuotaWindow {
        kind: window.kind,
        label: window.label,
        used_percent: window.used_percent.clamp(0.0, 100.0),
        remaining_percent: window.remaining_percent.clamp(0.0, 100.0),
        reset_at: window.reset_at,
    })
}

fn error_text(error: &serde_json::Value) -> String {
    let message = error
        .as_str()
        .map(str::to_owned)
        .or_else(|| {
            error
                .get("message")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "Provider unavailable".to_string());
    sanitize_diagnostic(&message)
}

pub fn sanitize_diagnostic(value: &str) -> String {
    const SECRET_MARKERS: [&str; 11] = [
        "authorization",
        "api_key",
        "api-key",
        "apikey",
        "access_token",
        "refresh_token",
        "token=",
        "\"token\"",
        "cookie",
        "bearer ",
        "secret",
    ];
    let mut output = String::new();
    for line in value.lines().take(12) {
        let lower = line.to_ascii_lowercase();
        let rendered = if SECRET_MARKERS.iter().any(|marker| lower.contains(marker)) {
            "[credential diagnostic redacted]"
        } else {
            line.trim()
        };
        if rendered.is_empty() {
            continue;
        }
        if !output.is_empty() {
            output.push('\n');
        }
        let remaining = 1_000usize.saturating_sub(output.len());
        if remaining == 0 {
            break;
        }
        output.extend(rendered.chars().take(remaining));
    }
    output
}

pub fn resolve_codexbar_config(
    home: &Path,
    environment: &BTreeMap<String, String>,
) -> Option<PathBuf> {
    if let Some(path) = environment
        .get("CODEXBAR_CONFIG")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        return Some(expand_home(path, home));
    }
    if let Some(root) = environment
        .get("XDG_CONFIG_HOME")
        .map(|value| value.trim())
        .filter(|value| Path::new(value).is_absolute())
    {
        let path = Path::new(root).join("codexbar/config.json");
        if path.is_file() {
            return Some(path);
        }
    }
    let xdg = home.join(".config/codexbar/config.json");
    if xdg.is_file() {
        return Some(xdg);
    }
    let legacy = home.join(".codexbar/config.json");
    legacy.is_file().then_some(legacy)
}

pub fn resolve_win_codexbar_config(environment: &BTreeMap<String, String>) -> Option<PathBuf> {
    environment
        .get("APPDATA")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .map(|root| root.join("CodexBar/settings.json"))
        .filter(|path| path.is_file())
}

pub fn write_managed_config(path: &Path, providers: &[&str]) -> Result<()> {
    let value = serde_json::json!({
        "version": 1,
        "providers": providers.iter().map(|id| serde_json::json!({
            "id": id,
            "enabled": true
        })).collect::<Vec<_>>()
    });
    atomic_write(path, &serde_json::to_vec_pretty(&value)?)?;
    Ok(())
}

fn expand_home(value: &str, home: &Path) -> PathBuf {
    if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::fs;
    use std::sync::Mutex;
    use tempfile::tempdir;

    const FIXTURE: &str = r##"{
      "schemaVersion": 1,
      "generatedAt": "2026-08-14T02:00:00Z",
      "staleAfterSeconds": 180,
      "host": { "codexBarVersion": "0.49.5", "refreshIntervalSeconds": 0 },
      "providers": [{
        "id": "codex", "name": "Codex", "enabled": true, "source": "oauth",
        "identity": { "accountEmail": "user@example.com", "plan": "Pro" },
        "windows": [{ "kind": "session", "label": "5 hour", "usedPercent": 28, "remainingPercent": 72, "resetAt": "2026-08-14T05:00:00Z" }],
        "credits": { "remaining": 12.5, "unit": "credits" },
        "display": { "accentColor": "#fff", "sortKey": 0, "priority": "normal" },
        "error": null, "updatedAt": "2026-08-14T02:00:00Z",
        "futureField": true
      }]
    }"##;

    #[test]
    fn parses_dashboard_v1_and_ignores_additive_fields() {
        let fetched = Utc.with_ymd_and_hms(2026, 8, 14, 2, 1, 0).unwrap();
        let snapshot =
            parse_dashboard_snapshot(FIXTURE.as_bytes(), QuotaBackend::CodexBarCli, fetched)
                .unwrap();
        assert_eq!(snapshot.backend_version.as_deref(), Some("0.49.5"));
        assert_eq!(
            snapshot.providers[0]
                .identity
                .as_ref()
                .unwrap()
                .account_email
                .as_deref(),
            Some("user@example.com")
        );
        assert_eq!(snapshot.providers[0].lowest_remaining_percent(), Some(72.0));
        assert_eq!(snapshot.freshness, QuotaFreshness::Fresh);
    }

    #[test]
    fn rejects_unknown_schema_without_fabricating_data() {
        let payload = FIXTURE.replace("\"schemaVersion\": 1", "\"schemaVersion\": 2");
        assert!(
            parse_dashboard_snapshot(&payload.into_bytes(), QuotaBackend::WinCodexBar, Utc::now())
                .is_err()
        );
    }

    #[test]
    fn resolves_existing_config_before_managed_fallback() {
        let dir = tempdir().unwrap();
        let config = dir.path().join(".config/codexbar/config.json");
        fs::create_dir_all(config.parent().unwrap()).unwrap();
        fs::write(&config, "{}").unwrap();
        assert_eq!(
            resolve_codexbar_config(dir.path(), &BTreeMap::new()),
            Some(config)
        );
    }

    #[test]
    fn resolves_existing_windows_settings_from_appdata() {
        let dir = tempdir().unwrap();
        let settings = dir.path().join("CodexBar/settings.json");
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(&settings, "{}").unwrap();
        let environment = BTreeMap::from([(
            "APPDATA".to_string(),
            dir.path().to_string_lossy().into_owned(),
        )]);
        assert_eq!(resolve_win_codexbar_config(&environment), Some(settings));
    }

    #[test]
    fn managed_config_contains_no_secret_fields() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.json");
        write_managed_config(&path, &["codex", "claude"]).unwrap();
        let content = fs::read_to_string(path).unwrap();
        assert!(content.contains("claude"));
        assert!(!content.contains("apiKey"));
        assert!(!content.contains("cookie"));
    }

    #[test]
    fn collector_uses_dashboard_v1_full_identity_arguments() {
        let runner = FixtureRunner {
            output: QuotaCommandOutput {
                stdout: FIXTURE.as_bytes().to_vec(),
                stderr: Vec::new(),
                success: true,
            },
            args: Mutex::new(Vec::new()),
        };
        let collector = DashboardCliCollector::new(
            QuotaBackend::CodexBarCli,
            runner,
            BTreeMap::new(),
            CollectorCapabilities {
                platform_supported: true,
                sidecar_available: true,
                multi_account: true,
                credits: true,
            },
        );

        collector.collect(Duration::from_secs(35)).unwrap();

        assert_eq!(
            *collector.runner.args.lock().unwrap(),
            ["dashboard", "--identity", "full", "--timeout", "25"]
        );
    }

    #[test]
    fn windows_collector_limits_each_provider_timeout() {
        let runner = FixtureRunner {
            output: QuotaCommandOutput {
                stdout: FIXTURE.as_bytes().to_vec(),
                stderr: Vec::new(),
                success: true,
            },
            args: Mutex::new(Vec::new()),
        };
        let collector = DashboardCliCollector::new(
            QuotaBackend::WinCodexBar,
            runner,
            BTreeMap::new(),
            CollectorCapabilities {
                platform_supported: true,
                sidecar_available: true,
                multi_account: true,
                credits: true,
            },
        );

        collector.collect(Duration::from_secs(35)).unwrap();

        assert_eq!(
            *collector.runner.args.lock().unwrap(),
            ["dashboard", "--identity", "full", "--timeout", "12"]
        );
    }

    #[test]
    fn collector_rejects_empty_disabled_and_failed_providers_but_keeps_partial_success() {
        let original: serde_json::Value = serde_json::from_str(FIXTURE).unwrap();
        for scenario in ["empty", "disabled", "failed", "no-windows", "partial"] {
            let mut payload = original.clone();
            let providers = payload["providers"].as_array_mut().unwrap();
            match scenario {
                "empty" => providers.clear(),
                "disabled" => providers
                    .iter_mut()
                    .for_each(|p| p["enabled"] = false.into()),
                "failed" => providers.iter_mut().for_each(|p| {
                    p["error"] = "unauthorized".into();
                    p["accounts"] = serde_json::json!([]);
                }),
                "no-windows" => providers.iter_mut().for_each(|p| {
                    p["windows"] = serde_json::json!([]);
                    p["accounts"] = serde_json::json!([]);
                    p["credits"] = serde_json::Value::Null;
                }),
                "partial" => providers.push(serde_json::json!({
                    "id":"failed", "name":"Failed", "enabled":true, "error":"unauthorized"
                })),
                _ => unreachable!(),
            }
            let collector = DashboardCliCollector::new(
                QuotaBackend::CodexBarCli,
                FixtureRunner {
                    output: QuotaCommandOutput {
                        stdout: serde_json::to_vec(&payload).unwrap(),
                        stderr: Vec::new(),
                        success: true,
                    },
                    args: Mutex::new(Vec::new()),
                },
                BTreeMap::new(),
                CollectorCapabilities {
                    platform_supported: true,
                    sidecar_available: true,
                    multi_account: true,
                    credits: true,
                },
            );
            assert_eq!(
                collector.collect(Duration::from_secs(35)).is_ok(),
                scenario == "partial",
                "{scenario}"
            );
        }
    }

    #[test]
    fn parses_multi_account_rows_and_sanitizes_partial_errors() {
        let payload = FIXTURE.replace(
            "\"futureField\": true",
            "\"accounts\": [{\"id\":\"slot-1\",\"label\":\"one@example.com\",\"active\":true,\"identity\":{\"accountEmail\":\"one@example.com\",\"plan\":\"Max\"},\"windows\":[],\"error\":null}],\"accountsError\":\"Authorization: Bearer private\",\"futureField\": true",
        );
        let snapshot = parse_dashboard_snapshot(
            payload.as_bytes(),
            QuotaBackend::WinCodexBar,
            Utc.with_ymd_and_hms(2026, 8, 14, 2, 1, 0).unwrap(),
        )
        .unwrap();

        assert_eq!(snapshot.providers[0].accounts.len(), 1);
        assert_eq!(
            snapshot.providers[0].accounts[0]
                .identity
                .as_ref()
                .and_then(|identity| identity.account_email.as_deref()),
            Some("one@example.com")
        );
        assert!(
            !snapshot.providers[0]
                .error
                .as_deref()
                .unwrap()
                .contains("private")
        );
    }

    #[derive(Debug)]
    struct FixtureRunner {
        output: QuotaCommandOutput,
        args: Mutex<Vec<String>>,
    }

    impl QuotaCommandRunner for FixtureRunner {
        fn run(
            &self,
            args: &[String],
            _env: &BTreeMap<String, String>,
            _timeout: Duration,
        ) -> Result<QuotaCommandOutput> {
            *self.args.lock().unwrap() = args.to_vec();
            Ok(self.output.clone())
        }
    }
}
