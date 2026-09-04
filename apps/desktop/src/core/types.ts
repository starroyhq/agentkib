export type AgentKind =
  | "codex"
  | "claude-code"
  | "cursor"
  | "opencode"
  | "open-claw"
  | "hermes"
  | "grok-build"
  | "deepseek-harness";
export type MemoryStatus = "pending" | "approved" | "rejected" | "invalidated";
export type MemoryType =
  | "user_preference"
  | "project_fact"
  | "decision"
  | "constraint"
  | "failed_attempt"
  | "open_loop"
  | "task_state"
  | "agent_observation";

export interface AgentDetection {
  agent: AgentKind;
  detected: boolean;
  asset_count: number;
  warnings: string[];
}
export interface AssetRecord {
  agent: AgentKind;
  kind: string;
  path: string;
  exists: boolean;
  size: number;
  summary: string;
  summary_key?: string;
  summary_params?: Record<string, string>;
}
export interface WorkspaceScan {
  root: string;
  manifest_exists: boolean;
  agents: AgentDetection[];
  assets: AssetRecord[];
  warnings: string[];
}
export interface SkillDefinition {
  name: string;
  path: string;
  targets: AgentKind[];
}
export type ConnectionDefinition =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
      allow_tools: string[];
      targets: AgentKind[];
    }
  | {
      name: string;
      transport: "http";
      url: string;
      env: Record<string, string>;
      allow_tools: string[];
      targets: AgentKind[];
    };
export interface Manifest {
  schema_version: number;
  workspace: { id: string; name: string };
  instructions: {
    shared: string;
    scoped: Array<{ path: string; content: string }>;
    platform_overrides: Partial<Record<AgentKind, string>>;
  };
  skills: SkillDefinition[];
  mcp: { config: string };
  connections: ConnectionDefinition[];
  memories: { require_approval: boolean };
  adapters: Partial<
    Record<AgentKind, { enabled: boolean; generated_hashes: Record<string, string> }>
  >;
}
export interface ContextPreview {
  agent: AgentKind;
  project: string;
  cwd: string;
  sections: Array<{ source: string; scope: string; content: string; precedence: number }>;
  visible_skills: string[];
  visible_connections: string[];
  approved_memories: string[];
  warnings: string[];
}
export type DoctorSeverity = "error" | "warning" | "info";
export type DoctorStatus = "healthy" | "attention" | "unavailable" | "not-applicable";
export interface DoctorAssetStatus {
  status: DoctorStatus;
  expected: number;
  actual: number;
}
export interface DoctorAgentRow {
  agent: AgentKind;
  detected: boolean;
  installed: boolean;
  enabled: boolean;
  writable: boolean;
  instructions: DoctorAssetStatus;
  skills: DoctorAssetStatus;
  mcp: DoctorAssetStatus;
}
export interface DoctorEvidence {
  path?: string;
  detail: string;
  expected?: string;
  actual?: string;
}
export interface DoctorIssue {
  id: string;
  code: string;
  severity: DoctorSeverity;
  agent?: AgentKind;
  asset_kind?: string;
  repairable: boolean;
  evidence: DoctorEvidence[];
}
export interface ContextDoctorSummary {
  workspace_id: string;
  error_count: number;
  warning_count: number;
  info_count: number;
  repairable_count: number;
  checked_at: string;
}
export interface ContextDoctorReport {
  summary: ContextDoctorSummary;
  matrix: DoctorAgentRow[];
  issues: DoctorIssue[];
}
export interface FileChange {
  target: string;
  scope: "project" | "agent-home" | "application-data";
  original_hash?: string;
  before: string;
  after: string;
  risk: "low" | "medium" | "high";
  validator: string;
}
export interface ChangeSet {
  id: string;
  project_root: string;
  created_at: string;
  changes: FileChange[];
  requires_home_approval: boolean;
}
export interface MemoryRecord {
  id: string;
  project_id: string;
  memory_type: MemoryType;
  content: string;
  status: MemoryStatus;
  source_agent?: string;
  source_thread?: string;
  source_reference?: string;
  created_at: string;
  approved_at?: string;
  invalidated_by?: string;
}
export type CloseBehavior = "minimize-to-tray" | "quit";
export type SupportedLocale = "zh-CN" | "zh-TW" | "ja-JP" | "en-US";
export type LocalePreference = "system" | SupportedLocale;
export type ThemePreference = "system" | "light" | "dark";
export type AccentThemeId = "minimal-neutral" | "vtron" | "claude" | "sakura" | "ocean-breeze";
export type EffectiveTheme = "light" | "dark";
export type AppIconPreference = "white" | "black";
export interface LocalizedMessage {
  key: string;
  params?: Record<string, string | number>;
  detail?: string;
}
export interface McpNetworkSettings {
  port: number;
  lan_enabled: boolean;
  lan_risk_accepted: boolean;
}
export interface McpHubStatus {
  running: boolean;
  bind_address: string;
  port: number;
  lan_enabled: boolean;
  accessible_addresses: string[];
  runtime_count: number;
  error_count: number;
  last_error?: string;
}
export type McpRuntimeState = "stopped" | "starting" | "running" | "error";
export interface McpRuntimeStatus {
  server_id: string;
  server_name: string;
  config_hash: string;
  state: McpRuntimeState;
  started_at?: string;
  last_used_at?: string;
  error?: string;
}
export type McpPackageKind = "npm" | "pypi" | "remote" | "local";
export type McpServerTransport =
  | { transport: "stdio"; command: string; args: string[]; cwd?: string }
  | { transport: "streamable-http"; url: string }
  | { transport: "sse"; url: string };
export type McpServerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  targets: AgentKind[];
  allow_tools: string[];
  lan_allow_tools: string[];
  supports_parallel_tool_calls: boolean;
  package?: { kind: McpPackageKind; identifier: string; version?: string };
} & McpServerTransport;
export interface McpToolDescriptor {
  server_id: string;
  name: string;
  description?: string;
  input_schema: unknown;
  read_only: boolean;
}
export interface McpRegistryEntry {
  name: string;
  description: string;
  version: string;
  package_kind: McpPackageKind;
  identifier: string;
  runtime_hint?: string;
  url?: string;
  required_env: string[];
  runtime_arguments: string[];
  package_arguments: string[];
}
export interface McpInstallation {
  id: string;
  name: string;
  package_kind: McpPackageKind;
  identifier: string;
  version?: string;
  install_path?: string;
  status: string;
  installed_at: string;
  updated_at: string;
}
export interface McpMigrationCandidate {
  id: string;
  agent: AgentKind;
  scope: string;
  name: string;
  source_path: string;
  transport: string;
  endpoint: string;
  has_secret_values: boolean;
  supported: boolean;
  warnings: string[];
}
export interface McpOAuthStart {
  authorization_url: string;
}
export interface McpInstallResult {
  installation: McpInstallation;
  server: McpServerConfig;
  tools: McpToolDescriptor[];
}
export interface RuntimeInfo {
  app_name: string;
  app_version: string;
  app_channel: "stable" | "development";
  updates_enabled: boolean;
  data_dir: string;
  database_path: string;
  mcp_package_root: string;
  mcp_hub: McpHubStatus;
  mcp_network: McpNetworkSettings;
  openclaw_config?: string;
  hermes_config?: string;
  close_behavior?: CloseBehavior;
  locale_preference: LocalePreference;
  effective_locale: SupportedLocale;
  theme_preference: ThemePreference;
  effective_theme: EffectiveTheme;
  accent_theme_preference: AccentThemeId | null;
  app_icon_preference: AppIconPreference;
  tray_available: boolean;
  session_index_enabled: boolean;
  quota_auto_refresh_enabled: boolean;
  quota_auto_refresh_prompt_seen: boolean;
  onboarding: OnboardingState;
}
export interface OnboardingState {
  version: number;
  acknowledged_version: number;
  workspace_id?: string;
  doctor_completed: boolean;
  repairable_count: number;
  repair_applied: boolean;
}
export type OnboardingEvent =
  | { event: "doctor-completed"; workspace_id: string; repairable_count: number }
  | { event: "repair-applied"; workspace_id: string }
  | { event: "dismissed" }
  | { event: "restarted" };
export type AppUpdateInstallMode = "in-app" | "manual";
export interface AppUpdateInfo {
  current_version: string;
  version: string;
  published_at?: string;
  notes?: string;
  release_url: string;
  install_mode: AppUpdateInstallMode;
}
export type AppUpdateProgress =
  | { event: "started"; data: { content_length?: number } }
  | { event: "progress"; data: { downloaded: number; content_length?: number } }
  | { event: "finished" };
export type WorkspaceStatus = "healthy" | "attention";
export type DiscoveryEvidence = "session-cwd" | "configured-workspace" | "scan-marker" | "manual";
export interface WorkspaceSource {
  agent?: AgentKind;
  evidence: DiscoveryEvidence;
  session_count: number;
  last_active_at?: string;
}
export interface WorkspaceSummary {
  id: string;
  path: string;
  name: string;
  repository_group_id?: string;
  manifest_workspace_id?: string;
  status: WorkspaceStatus;
  asset_count: number;
  warning_count: number;
  last_active_at?: string;
  last_scanned_at?: string;
  sources: WorkspaceSource[];
}
export interface AgentInstallation {
  agent: AgentKind;
  installed: boolean;
  configured: boolean;
  version?: string;
  home?: string;
  warnings: string[];
}
export type AgentToolState =
  | "current"
  | "update-available"
  | "uninstalled"
  | "conflict"
  | "unknown";
export type AgentToolChannel =
  | "official-installer"
  | "npm"
  | "pnpm"
  | "bun"
  | "yarn"
  | "homebrew"
  | "volta"
  | "desktop-app"
  | "nix"
  | "local"
  | "unknown";
export type AgentToolEnvironment =
  | "system"
  | "standalone"
  | "nvm"
  | "fnm"
  | "mise"
  | "volta"
  | "unknown";
export interface AgentToolInstallation {
  id: string;
  path: string;
  resolved_path: string;
  version?: string;
  runnable: boolean;
  error?: string;
  channel: AgentToolChannel;
  environment: AgentToolEnvironment;
  manager_path?: string;
  is_path_default: boolean;
}
export type AgentToolActionKind = "install" | "update" | "open-documentation";
export type AgentToolActionMode = "execute" | "copy-command" | "open-documentation";
export type AgentToolShell = "posix" | "powershell";
export interface AgentToolAction {
  id: string;
  kind: AgentToolActionKind;
  mode: AgentToolActionMode;
  channel: AgentToolChannel;
  shell?: AgentToolShell;
  command?: string;
  url?: string;
  target_version?: string;
  installation_id?: string;
  manager_path?: string;
}
export interface AgentToolStatus {
  agent: AgentKind;
  installed: boolean;
  current_version?: string;
  latest_version?: string;
  recommended_version?: string;
  upstream_version?: string;
  state: AgentToolState;
  channel: AgentToolChannel;
  installations: AgentToolInstallation[];
  warnings: string[];
  official_url: string;
  release_url?: string;
  actions: AgentToolAction[];
}
export type AgentToolExecutionStatus =
  | "succeeded"
  | "failed"
  | "timed-out"
  | "busy"
  | "unchanged"
  | "verification-failed";
export interface AgentToolExecutionResult {
  agent: AgentKind;
  action_id: string;
  status: AgentToolExecutionStatus;
  exit_code?: number;
  output: string;
  installation_id?: string;
  before_version?: string;
  after_version?: string;
  completed_at: string;
}
export type AgentToolCacheStatus = "fresh" | "cached" | "unavailable";
export interface AgentToolSnapshot {
  tools: AgentToolStatus[];
  checked_at: string;
  latest_checked_at?: string;
  cache_status: AgentToolCacheStatus;
  errors: string[];
}
export interface CatalogAsset {
  id: string;
  scope: "workspace" | "agent-home" | "agentkib-home";
  workspace_id?: string;
  agent?: AgentKind;
  kind: string;
  name: string;
  path: string;
  summary: string;
  summary_key?: string;
  summary_params?: Record<string, string>;
  size: number;
  modified_at?: string;
}
export type SkillSourceKind = "openai-curated" | "github";
export interface SkillSource {
  kind: SkillSourceKind;
  repository: string;
  ref: string;
  path: string;
  resolved_commit: string;
  tree_sha: string;
}
export interface SkillCandidate {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  source: SkillSource;
}
export interface SkillCatalogEntry extends SkillCandidate {
  installed: boolean;
}
export interface SkillCatalogSnapshot {
  entries: SkillCatalogEntry[];
  cached_at: string;
  stale: boolean;
}
export type InstalledSkillStatus = "current" | "update-available" | "modified" | "unmanaged";
export interface InstalledSkill {
  name: string;
  display_name: string;
  description: string;
  path: string;
  size: number;
  modified_at?: string;
  status: InstalledSkillStatus;
  source?: SkillSource;
  installed_at?: string;
  updated_at?: string;
  can_rollback: boolean;
}
export interface SkillFileEntry {
  path: string;
  size: number;
  executable: boolean;
}
export interface SkillOperationPreview {
  token: string;
  operation: "install" | "update";
  skill: SkillCandidate;
  files: SkillFileEntry[];
  added: string[];
  modified: string[];
  removed: string[];
  total_size: number;
  local_modified: boolean;
  expires_at: string;
}
export interface RemovedSkill {
  id: string;
  name: string;
  display_name: string;
  removed_at: string;
  path: string;
}
export interface SkillFilePreview {
  path: string;
  content: string;
}
export interface DiscoveryReport {
  started_at: string;
  finished_at: string;
  discovered_count: number;
  removed_count: number;
  errors: string[];
}
export interface ScanRoot {
  id: string;
  path: string;
  enabled: boolean;
  max_depth: number;
  created_at: string;
}
export interface ExcludedWorkspace {
  path: string;
  created_at: string;
}
export interface ObsidianInstallation {
  installed: boolean;
  app_path?: string;
  version?: string;
  cli_available: boolean;
}
export interface ObsidianVault {
  path: string;
  name: string;
  source: "discovered" | "manual";
  last_opened_at?: number;
}
export interface ObsidianWorkspaceLink {
  workspace_id: string;
  vault_path: string;
  target_path: string;
}
export interface ObsidianIntegration {
  installation: ObsidianInstallation;
  vaults: ObsidianVault[];
  workspace_links: ObsidianWorkspaceLink[];
}
export type RemoteGatewayKind = "open-claw" | "hermes";
export type RemoteGatewayAuthKind = "none" | "token" | "password" | "session-token" | "basic";
export type RemoteGatewayState = "pending" | "connected" | "pairing-required" | "error";
export interface RemoteGatewayInput {
  id?: string;
  kind: RemoteGatewayKind;
  name: string;
  url: string;
  auth_kind: RemoteGatewayAuthKind;
  username?: string;
  secret?: string;
}
export interface RemoteGatewayWorkspace {
  id: string;
  agent_id?: string;
  name: string;
  path?: string;
  session_count: number;
  last_active_at?: string;
}
export interface RemoteGatewayAsset {
  id: string;
  agent_id?: string;
  kind: string;
  name: string;
  path: string;
  size: number;
}
export interface RemoteGatewaySummary {
  id: string;
  kind: RemoteGatewayKind;
  name: string;
  url: string;
  auth_kind: RemoteGatewayAuthKind;
  username?: string;
  has_credentials: boolean;
  state: RemoteGatewayState;
  version?: string;
  capabilities: string[];
  session_count: number;
  workspaces: RemoteGatewayWorkspace[];
  assets: RemoteGatewayAsset[];
  pairing_request_id?: string;
  last_connected_at?: string;
  last_error?: string;
}
export interface ActivityRecord {
  id: string;
  project_id?: string;
  action: string;
  detail: string;
  created_at: string;
}
export type UsageQuality = "exact" | "estimated" | "incomplete";
export interface InsightsQuery {
  from?: string;
  to?: string;
  agent?: AgentKind;
  workspace_id?: string;
  repository_group_id?: string;
}
export interface InsightsSummary {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  reasoning_tokens: number;
  session_count: number;
  my_commits: number;
  all_commits: number;
  attributed_commits: number;
  active_days: number;
  current_streak: number;
  longest_streak: number;
  quality: UsageQuality;
  coverage_from?: string;
  coverage_to?: string;
  refreshed_at?: string;
}
export interface HeatmapPoint {
  date: string;
  tokens: number;
  my_commits: number;
  all_commits: number;
  attributed_commits: number;
  sessions: number;
  quality: UsageQuality;
}
export interface AgentUsageBreakdown {
  agent: AgentKind;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  reasoning_tokens: number;
  session_count: number;
  quality: UsageQuality;
}
export interface ModelUsageBreakdown {
  model: string;
  total_tokens: number;
  session_count: number;
}
export interface WorkspaceUsageBreakdown {
  workspace_id?: string;
  name: string;
  total_tokens: number;
  session_count: number;
}
export interface RepositoryCommitBreakdown {
  repository_group_id: string;
  name: string;
  my_commits: number;
  all_commits: number;
  attributed_commits: number;
}
export interface Achievement {
  code: string;
  category: string;
  threshold: number;
  progress: number;
  unlocked_at?: string;
}
export interface ProviderStatus {
  agent: AgentKind;
  available: boolean;
  quality: UsageQuality;
  coverage_from?: string;
  coverage_to?: string;
  imported_events: number;
  error_key?: string;
  error_params?: Record<string, string>;
  error?: string;
}
export interface InsightsStatus {
  providers: ProviderStatus[];
  refreshed_at?: string;
  running: boolean;
}
export type RefreshKind = "discovery" | "insights" | "gateways" | "quota" | "storage";
export type RefreshState = "idle" | "queued" | "running" | "succeeded" | "failed" | "backoff";
export interface RefreshReceipt {
  kind: RefreshKind;
  disposition: "queued" | "already-running" | "backoff";
  request_id: string;
  status: RefreshJobStatus;
}
export interface RefreshJobStatus {
  kind: RefreshKind;
  state: RefreshState;
  request_id?: string;
  queued_at?: string;
  started_at?: string;
  finished_at?: string;
  progress_current?: number;
  progress_total?: number;
  error?: string;
  next_allowed_at?: string;
}
export type StorageMeasurement = "allocated-exact" | "logical-estimate";
export type StorageQuality = "complete" | "partial" | "unavailable";
export type StorageBreakdownKind = "directory" | "root-files";
export type StorageNodeKind = "workspace" | "directory" | "root-files" | "aggregate";
export interface StorageNode {
  id: string;
  name: string;
  relative_path: string;
  kind: StorageNodeKind;
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
  file_count: number;
  directory_count: number;
  child_count: number;
  children: StorageNode[];
  expandable: boolean;
  partial: boolean;
}
export interface StorageBreakdown {
  name: string;
  relative_path: string;
  kind: StorageBreakdownKind;
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
}
export interface WorkspaceStorage {
  workspace_id: string;
  name: string;
  path: string;
  snapshot_version: number;
  root?: StorageNode;
  measurement: StorageMeasurement;
  quality: StorageQuality;
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
  file_count: number;
  directory_count: number;
  breakdown: StorageBreakdown[];
  last_attempt_at: string;
  last_success_at?: string;
  error_key?: string;
  error_detail?: string;
}
export interface StorageOverview {
  total_workspace_count: number;
  scanned_workspace_count: number;
  allocated_bytes: number;
  logical_bytes: number;
  regenerable_bytes: number;
  agent_asset_bytes: number;
  last_scanned_at?: string;
  workspaces: WorkspaceStorage[];
}
export interface InsightsView {
  summary: InsightsSummary;
  heatmap: HeatmapPoint[];
  agents: AgentUsageBreakdown[];
  models: ModelUsageBreakdown[];
  workspaces: WorkspaceUsageBreakdown[];
  repositories: RepositoryCommitBreakdown[];
  achievements: Achievement[];
  status: InsightsStatus;
}
export interface GitIdentitySummary {
  id: string;
  label: string;
  source: string;
  enabled: boolean;
}
export type GitRefKind = "head" | "local-branch" | "remote-branch" | "tag" | "other";
export interface GitRefLabel {
  name: string;
  full_name: string;
  kind: GitRefKind;
  current: boolean;
}
export type GitChangeKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflict"
  | "type-changed"
  | "unknown";
export interface GitWorkingTreeChange {
  path: string;
  old_path?: string;
  kind: GitChangeKind;
  index_status?: string;
  worktree_status?: string;
  conflicted: boolean;
}
export interface GitWorkspaceSummary {
  repository_root: string;
  worktree_root: string;
  head?: string;
  head_oid?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  stash_count: number;
  detached: boolean;
  refs: GitRefLabel[];
  changes: GitWorkingTreeChange[];
}
export interface GitHistoryQuery {
  cursor?: string;
  limit?: number;
  reference?: string;
  author?: string;
  since?: string;
  until?: string;
  path?: string;
  merges_only?: boolean;
}
export interface GitCommitSummary {
  oid: string;
  parents: string[];
  subject: string;
  author_name: string;
  authored_at: string;
  refs: GitRefLabel[];
}
export interface GitCommitPage {
  commits: GitCommitSummary[];
  next_cursor?: string;
  repository_fingerprint: string;
}
export interface GitFileChange {
  status: string;
  path: string;
  old_path?: string;
}
export type GitDiffKind = "commit" | "worktree" | "staged";
export interface GitDiffRequest {
  kind: GitDiffKind;
  path?: string;
  oid?: string;
}
export interface GitDiff {
  patch: string;
  binary: boolean;
  submodule: boolean;
  encoding_lossy: boolean;
  truncated: boolean;
}
export type WorkspaceOpenerCategory = "editor" | "terminal" | "file-manager";
export interface WorkspaceOpener {
  id: string;
  name: string;
  category: WorkspaceOpenerCategory;
  preferred: boolean;
}
export type QuotaBackend = "codex-bar-cli" | "win-codex-bar";
export type QuotaFreshness = "fresh" | "stale" | "unavailable";
export interface QuotaIdentity {
  account_email?: string;
  plan?: string;
}
export interface QuotaWindow {
  kind: string;
  label: string;
  used_percent: number;
  remaining_percent: number;
  reset_at?: string;
}
export interface QuotaCredits {
  remaining: number;
  unit: string;
}
export interface QuotaAccount {
  id: string;
  label: string;
  active: boolean;
  identity?: QuotaIdentity;
  windows: QuotaWindow[];
  error?: string;
  updated_at?: string;
}
export interface QuotaProviderStatus {
  level: string;
  label: string;
  updated_at?: string;
}
export interface QuotaProvider {
  id: string;
  name: string;
  enabled: boolean;
  source?: string;
  status?: QuotaProviderStatus;
  identity?: QuotaIdentity;
  windows: QuotaWindow[];
  credits?: QuotaCredits;
  error?: string;
  updated_at?: string;
  accounts: QuotaAccount[];
}
export interface QuotaSnapshot {
  schema_version: number;
  backend: QuotaBackend;
  backend_version?: string;
  generated_at: string;
  fetched_at: string;
  stale_after_seconds: number;
  freshness: QuotaFreshness;
  providers: QuotaProvider[];
}
export interface QuotaCollectorStatus {
  backend: QuotaBackend;
  backend_version?: string;
  platform_supported: boolean;
  sidecar_available: boolean;
  config_source: string;
  last_attempt_at?: string;
  last_success_at?: string;
  running: boolean;
  error_key?: string;
  error_detail?: string;
}
export interface QuotaWindowSelector {
  provider_id: string;
  account_id?: string;
  kind: string;
  label: string;
}
export interface QuotaPopoverPreferences {
  hidden_providers: string[];
  hidden_windows: QuotaWindowSelector[];
}
export type AppMenuCommand = "add-workspace" | "add-scan-root" | "refresh-current" | "refresh-all";
export interface AppMenuCommandRequest {
  command: AppMenuCommand;
}
export interface AppNavigationRequest {
  page: "home" | "workspaces" | "catalog" | "agents" | "quota" | "insights" | "settings";
  settings_section?: "general" | "discovery" | "integrations" | "privacy" | "diagnostics";
  provider?: string;
  window?: QuotaWindowSelector;
  configure_popover?: boolean;
}

export type SessionAvailability = "readable" | "metadata-only";
export type SessionIndexFreshness = "fresh" | "stale" | "unavailable";
export type ConversationEventKind = "user-message" | "agent-message" | "tool-summary";
export interface ConversationSessionSummary {
  id: string;
  workspace_id: string;
  agent: "codex" | "claude-code";
  title?: string;
  created_at?: string;
  updated_at?: string;
  message_count?: number | null;
  git_branch?: string;
  archived: boolean;
  sidechain: boolean;
  availability: SessionAvailability;
}
export interface ConversationIndexStatus {
  workspace_id: string;
  agent: "codex" | "claude-code";
  freshness: SessionIndexFreshness;
  session_count: number;
  last_attempt_at?: string;
  last_success_at?: string;
  error_key?: string;
  error_detail?: string;
}
export interface ConversationEvent {
  id: string;
  kind: ConversationEventKind;
  timestamp?: string;
  content?: string;
  tool_name?: string;
  tool_status?: string;
  duration_ms?: number | null;
  attachment_count: number;
  truncated: boolean;
}
export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor?: string;
  warnings: string[];
}
export type HandoffFormat = "markdown" | "json";
export type SessionContinuationMode = "native-session" | "handoff-file";
export type SessionWindowStrategy = "full" | "windowed";
export type SessionLossCode =
  | "damaged-record"
  | "orphan-tool-result"
  | "unsupported-attachment"
  | "external-attachment"
  | "reasoning-excluded"
  | "source-content-truncated";
export interface SessionLoss {
  code: SessionLossCode;
  count: number;
}
export interface NativeImportCapability {
  supported: boolean;
  beta: boolean;
  reason?: string;
}
export type ContinuationCapabilityStatus =
  | "supported"
  | "unavailable"
  | "unsupported"
  | "unverified";
export interface ContinuationCapability {
  status: ContinuationCapabilityStatus;
  reason?: string | null;
}
export interface ContinuationCapabilities {
  source_agent: AgentKind;
  target_agent: AgentKind;
  source_read: ContinuationCapability;
  source_parse: ContinuationCapability;
  native_resume: ContinuationCapability;
  file_handoff: ContinuationCapability;
  windowed_context: ContinuationCapability;
  mcp_setup: ContinuationCapability;
  interactive_launch: ContinuationCapability;
}
export interface SessionImportStats {
  turn_count: number;
  message_count: number;
  tool_call_count: number;
  tool_result_count: number;
  attachment_count: number;
}
export interface SessionWindowStats {
  estimated_total_tokens: number;
  estimated_active_tokens: number;
  estimated_deferred_tokens: number;
  active: SessionImportStats;
  deferred_turn_count: number;
  deferred_block_count: number;
  estimate_quality: "conservative";
}
export interface SessionHandoffRequest {
  session_id: string;
  target_agent: AgentKind;
  format: HandoffFormat;
  history_budget_tokens: number;
}
export interface SessionHandoffDraft {
  filename: string;
  format: HandoffFormat;
  content: string;
  redaction_count: number;
  source_fingerprint: string;
  mode: SessionContinuationMode;
  native_capability: NativeImportCapability;
  capabilities: ContinuationCapabilities;
  stats: SessionImportStats;
  history_budget_tokens: number;
  window_strategy: SessionWindowStrategy;
  window_stats: SessionWindowStats;
  archive_id?: string;
  mcp_available: boolean;
  losses: SessionLoss[];
}
export type SessionHandoffPreparation = { status: "ready"; draft: SessionHandoffDraft };
export type SessionHandoffLaunchRequest =
  | {
      mode: "native-session";
      workspace_id: string;
      target_agent: AgentKind;
      target_session_id: string;
      target_path: string;
      archive_id?: string;
      archive_hash?: string;
      capabilities?: ContinuationCapabilities;
    }
  | {
      mode: "handoff-file";
      workspace_id: string;
      filename: string;
      target_agent: AgentKind;
      archive_id?: string;
      archive_hash?: string;
      capabilities?: ContinuationCapabilities;
    };
export interface PlannedSessionHandoff {
  change_set: ChangeSet;
  launch_request: SessionHandoffLaunchRequest;
}
export interface HandoffLaunchReceipt {
  target_agent: AgentKind;
  terminal: string;
}
export type HandoffContinuationResult =
  | { status: "launched"; receipt: HandoffLaunchReceipt }
  | { status: "applied-launch-failed"; error: LocalizedMessage };
