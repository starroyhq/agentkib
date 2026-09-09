use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u32 = 15;
pub const WEB_REQUEST_METHOD: &str = "web.request";
pub const REMOTE_REQUEST_METHOD: &str = "remote.request";
pub const HANDSHAKE_METHOD: &str = "agentkib.handshake";
pub const SHUTDOWN_METHOD: &str = "agentkib.shutdown";
pub const SCAN_WORKSPACE_METHOD: &str = "workspace.scan";
pub const PREPARE_MANIFEST_METHOD: &str = "workspace.prepareManifest";
pub const RESOLVE_CONTEXT_METHOD: &str = "workspace.resolveContext";
pub const ADD_WORKSPACE_METHOD: &str = "workspace.add";
pub const REFRESH_WORKSPACE_METHOD: &str = "workspace.refresh";
pub const EXCLUDE_WORKSPACE_METHOD: &str = "workspace.exclude";
pub const RESTORE_EXCLUDED_WORKSPACE_METHOD: &str = "workspace.restoreExcluded";
pub const WORKSPACE_DOCTOR_REPORT_METHOD: &str = "workspace.doctorReport";
pub const WORKSPACE_GIT_SUMMARY_METHOD: &str = "workspace.gitSummary";
pub const WORKSPACE_GIT_HISTORY_METHOD: &str = "workspace.gitHistory";
pub const GIT_COMMIT_FILES_METHOD: &str = "workspace.gitCommitFiles";
pub const GIT_DIFF_METHOD: &str = "workspace.gitDiff";
pub const WORKSPACE_SESSIONS_METHOD: &str = "workspace.sessions";
pub const WORKSPACE_SESSION_STATUS_METHOD: &str = "workspace.sessionStatus";
pub const REFRESH_WORKSPACE_SESSIONS_METHOD: &str = "workspace.refreshSessions";
pub const LIST_WORKSPACE_OPENERS_METHOD: &str = "workspace.openers";
pub const OPEN_WORKSPACE_WITH_APP_METHOD: &str = "workspace.openWith";
pub const SESSION_EVENTS_METHOD: &str = "session.events";
pub const RUNTIME_INFO_METHOD: &str = "runtime.info";
pub const LIST_WORKSPACES_METHOD: &str = "workspaces.list";
pub const LIST_AGENT_INSTALLATIONS_METHOD: &str = "agents.listInstallations";
pub const AGENT_TOOLS_STATUS_METHOD: &str = "agents.toolsStatus";
pub const AGENT_TOOL_EXECUTE_METHOD: &str = "agents.toolExecute";
pub const SEARCH_CATALOG_ASSETS_METHOD: &str = "catalog.searchAssets";
pub const LIST_SKILL_CATALOG_METHOD: &str = "skills.listCatalog";
pub const DISCOVER_SKILLS_METHOD: &str = "skills.discover";
pub const LIST_INSTALLED_SKILLS_METHOD: &str = "skills.listInstalled";
pub const PREPARE_SKILL_INSTALL_METHOD: &str = "skills.prepareInstall";
pub const APPLY_SKILL_OPERATION_METHOD: &str = "skills.applyOperation";
pub const CHECK_SKILL_UPDATES_METHOD: &str = "skills.checkUpdates";
pub const PREPARE_SKILL_UPDATE_METHOD: &str = "skills.prepareUpdate";
pub const ROLLBACK_SKILL_METHOD: &str = "skills.rollback";
pub const UNINSTALL_SKILL_METHOD: &str = "skills.uninstall";
pub const LIST_REMOVED_SKILLS_METHOD: &str = "skills.listRemoved";
pub const RESTORE_SKILL_METHOD: &str = "skills.restore";
pub const READ_SKILL_FILE_METHOD: &str = "skills.readFile";
pub const LIST_GLOBAL_MEMORIES_METHOD: &str = "memories.listGlobal";
pub const LIST_ACTIVITY_METHOD: &str = "activity.list";
pub const LIST_SCAN_ROOTS_METHOD: &str = "discovery.listScanRoots";
pub const ADD_SCAN_ROOT_METHOD: &str = "discovery.addScanRoot";
pub const REMOVE_SCAN_ROOT_METHOD: &str = "discovery.removeScanRoot";
pub const REFRESH_DISCOVERY_METHOD: &str = "discovery.refresh";
pub const DISCOVERY_REPORT_METHOD: &str = "discovery.report";
pub const LIST_EXCLUDED_WORKSPACES_METHOD: &str = "discovery.listExcludedWorkspaces";
pub const LIST_REMOTE_GATEWAYS_METHOD: &str = "gateways.list";
pub const SAVE_REMOTE_GATEWAY_METHOD: &str = "gateways.save";
pub const REFRESH_REMOTE_GATEWAY_METHOD: &str = "gateways.refresh";
pub const REMOVE_REMOTE_GATEWAY_METHOD: &str = "gateways.remove";
pub const OBSIDIAN_INTEGRATION_METHOD: &str = "obsidian.integration";
pub const ADD_OBSIDIAN_VAULT_METHOD: &str = "obsidian.addVault";
pub const LINK_OBSIDIAN_WORKSPACE_METHOD: &str = "obsidian.linkWorkspace";
pub const UNLINK_OBSIDIAN_WORKSPACE_METHOD: &str = "obsidian.unlinkWorkspace";
pub const OPEN_OBSIDIAN_METHOD: &str = "obsidian.open";
pub const OPEN_OBSIDIAN_WORKSPACE_METHOD: &str = "obsidian.openWorkspace";
pub const SET_CLOSE_BEHAVIOR_METHOD: &str = "settings.setCloseBehavior";
pub const SET_LOCALE_METHOD: &str = "settings.setLocale";
pub const SET_THEME_PREFERENCE_METHOD: &str = "settings.setThemePreference";
pub const SET_ACCENT_THEME_PREFERENCE_METHOD: &str = "settings.setAccentThemePreference";
pub const SET_SIDEBAR_WIDTH_PREFERENCE_METHOD: &str = "settings.setSidebarWidthPreference";
pub const SET_APP_ICON_PREFERENCE_METHOD: &str = "settings.setAppIconPreference";
pub const PLAN_CHANGES_METHOD: &str = "changes.plan";
pub const APPLY_CHANGES_METHOD: &str = "changes.apply";
pub const LIST_MEMORIES_METHOD: &str = "memories.list";
pub const SEARCH_MEMORIES_METHOD: &str = "memories.search";
pub const PROPOSE_MEMORY_METHOD: &str = "memories.propose";
pub const REVIEW_MEMORY_METHOD: &str = "memories.review";
pub const PREPARE_SESSION_HANDOFF_METHOD: &str = "sessions.prepareHandoff";
pub const SANITIZE_SESSION_HANDOFF_METHOD: &str = "sessions.sanitizeHandoff";
pub const PLAN_SESSION_HANDOFF_METHOD: &str = "sessions.planHandoff";
pub const PLAN_SESSION_MCP_CONNECTION_METHOD: &str = "sessions.planMcpConnection";
pub const CONTINUE_SESSION_HANDOFF_METHOD: &str = "sessions.continueHandoff";
pub const LAUNCH_SESSION_HANDOFF_METHOD: &str = "sessions.launchHandoff";
pub const CLEAR_SESSION_INDEX_METHOD: &str = "sessions.clearIndex";
pub const SET_SESSION_INDEX_ENABLED_METHOD: &str = "sessions.setIndexEnabled";
pub const MCP_HUB_STATUS_METHOD: &str = "mcp.hubStatus";
pub const UPDATE_MCP_NETWORK_METHOD: &str = "mcp.updateNetwork";
pub const LIST_MCP_SERVERS_METHOD: &str = "mcp.listServers";
pub const GET_MCP_SERVER_METHOD: &str = "mcp.getServer";
pub const SAVE_MCP_SERVER_METHOD: &str = "mcp.saveServer";
pub const SAVE_MCP_LOCAL_VALUES_METHOD: &str = "mcp.saveLocalValues";
pub const REMOVE_MCP_SERVER_METHOD: &str = "mcp.removeServer";
pub const PROBE_MCP_RUNTIME_METHOD: &str = "mcp.probeRuntime";
pub const START_MCP_OAUTH_METHOD: &str = "mcp.startOAuth";
pub const LIST_MCP_RUNTIMES_METHOD: &str = "mcp.listRuntimes";
pub const RESTART_MCP_RUNTIME_METHOD: &str = "mcp.restartRuntime";
pub const STOP_MCP_RUNTIME_METHOD: &str = "mcp.stopRuntime";
pub const SEARCH_MCP_REGISTRY_METHOD: &str = "mcp.searchRegistry";
pub const REFRESH_MCP_REGISTRY_METHOD: &str = "mcp.refreshRegistry";
pub const INSTALL_MCP_METHOD: &str = "mcp.install";
pub const UPDATE_MCP_METHOD: &str = "mcp.update";
pub const LIST_MCP_INSTALLATIONS_METHOD: &str = "mcp.listInstallations";
pub const UNINSTALL_MCP_METHOD: &str = "mcp.uninstall";
pub const SCAN_NATIVE_MCP_METHOD: &str = "mcp.scanNative";
pub const PLAN_MCP_MIGRATION_METHOD: &str = "mcp.planMigration";
pub const INSIGHTS_HEATMAP_METHOD: &str = "insights.heatmap";
pub const AGENT_USAGE_BREAKDOWN_METHOD: &str = "insights.agentUsage";
pub const MODEL_USAGE_BREAKDOWN_METHOD: &str = "insights.modelUsage";
pub const WORKSPACE_USAGE_BREAKDOWN_METHOD: &str = "insights.workspaceUsage";
pub const REPOSITORY_COMMIT_BREAKDOWN_METHOD: &str = "insights.repositoryCommits";
pub const ACHIEVEMENTS_METHOD: &str = "insights.achievements";
pub const GIT_IDENTITIES_METHOD: &str = "insights.gitIdentities";
pub const ADD_GIT_IDENTITY_ALIAS_METHOD: &str = "insights.addGitIdentityAlias";
pub const SET_GIT_IDENTITY_ENABLED_METHOD: &str = "insights.setGitIdentityEnabled";
pub const WORKSPACE_DOCTOR_SUMMARIES_METHOD: &str = "workspace.doctorSummaries";
pub const INSIGHTS_VIEW_METHOD: &str = "insights.view";
pub const REFRESH_INSIGHTS_METHOD: &str = "insights.refresh";
pub const INSIGHTS_SUMMARY_METHOD: &str = "insights.summary";
pub const INSIGHTS_STATUS_METHOD: &str = "insights.status";
pub const QUOTA_COLLECTOR_STATUS_METHOD: &str = "quota.collectorStatus";
pub const QUOTA_SNAPSHOT_METHOD: &str = "quota.snapshot";
pub const QUOTA_PREFERENCES_METHOD: &str = "quota.preferences";
pub const SET_QUOTA_PREFERENCES_METHOD: &str = "quota.setPreferences";
pub const REFRESH_QUOTA_METHOD: &str = "quota.refresh";
pub const SET_QUOTA_AUTO_REFRESH_METHOD: &str = "quota.setAutoRefresh";
pub const SET_LOCAL_AUTO_REFRESH_METHOD: &str = "set_local_auto_refresh";
pub const SET_QUOTA_PROMPT_SEEN_METHOD: &str = "quota.setPromptSeen";
pub const STORAGE_OVERVIEW_METHOD: &str = "storage.overview";
pub const STORAGE_CHILDREN_METHOD: &str = "storage.children";
pub const REFRESH_STORAGE_METHOD: &str = "storage.refresh";
pub const RESOLVE_STORAGE_PATH_METHOD: &str = "storage.resolvePath";
pub const CANCEL_STORAGE_METHOD: &str = "storage.cancel";
pub const UPDATE_ONBOARDING_METHOD: &str = "onboarding.update";

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
    pub jsonrpc: &'static str,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i32, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError {
                code,
                message: message.into(),
                data,
            }),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeRequest {
    pub protocol_version: u32,
    pub client: RuntimePeer,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandshakeResult {
    pub protocol_version: u32,
    pub runtime: RuntimePeer,
    pub pid: u32,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RuntimePeer {
    pub name: String,
    pub version: String,
}

pub fn typescript_bindings() -> String {
    format!(
        r#"// This file is generated by `pnpm protocol:generate`. Do not edit it by hand.

export const PROTOCOL_VERSION = {PROTOCOL_VERSION} as const;
export const RUNTIME_METHODS = {{
  handshake: "{HANDSHAKE_METHOD}",
  shutdown: "{SHUTDOWN_METHOD}",
  scanWorkspace: "{SCAN_WORKSPACE_METHOD}",
  prepareManifest: "{PREPARE_MANIFEST_METHOD}",
  resolveContext: "{RESOLVE_CONTEXT_METHOD}",
  addWorkspace: "{ADD_WORKSPACE_METHOD}",
  refreshWorkspace: "{REFRESH_WORKSPACE_METHOD}",
  excludeWorkspace: "{EXCLUDE_WORKSPACE_METHOD}",
  restoreExcludedWorkspace: "{RESTORE_EXCLUDED_WORKSPACE_METHOD}",
  workspaceDoctorReport: "{WORKSPACE_DOCTOR_REPORT_METHOD}",
  workspaceGitSummary: "{WORKSPACE_GIT_SUMMARY_METHOD}",
  workspaceGitHistory: "{WORKSPACE_GIT_HISTORY_METHOD}",
  gitCommitFiles: "{GIT_COMMIT_FILES_METHOD}",
  gitDiff: "{GIT_DIFF_METHOD}",
  workspaceSessions: "{WORKSPACE_SESSIONS_METHOD}",
  workspaceSessionStatus: "{WORKSPACE_SESSION_STATUS_METHOD}",
  refreshWorkspaceSessions: "{REFRESH_WORKSPACE_SESSIONS_METHOD}",
  listWorkspaceOpeners: "{LIST_WORKSPACE_OPENERS_METHOD}",
  openWorkspaceWithApp: "{OPEN_WORKSPACE_WITH_APP_METHOD}",
  sessionEvents: "{SESSION_EVENTS_METHOD}",
  runtimeInfo: "{RUNTIME_INFO_METHOD}",
  listWorkspaces: "{LIST_WORKSPACES_METHOD}",
  listAgentInstallations: "{LIST_AGENT_INSTALLATIONS_METHOD}",
  agentToolsStatus: "{AGENT_TOOLS_STATUS_METHOD}",
  agentToolExecute: "{AGENT_TOOL_EXECUTE_METHOD}",
  searchCatalogAssets: "{SEARCH_CATALOG_ASSETS_METHOD}",
  listSkillCatalog: "{LIST_SKILL_CATALOG_METHOD}",
  discoverSkills: "{DISCOVER_SKILLS_METHOD}",
  listInstalledSkills: "{LIST_INSTALLED_SKILLS_METHOD}",
  prepareSkillInstall: "{PREPARE_SKILL_INSTALL_METHOD}",
  applySkillOperation: "{APPLY_SKILL_OPERATION_METHOD}",
  checkSkillUpdates: "{CHECK_SKILL_UPDATES_METHOD}",
  prepareSkillUpdate: "{PREPARE_SKILL_UPDATE_METHOD}",
  rollbackSkill: "{ROLLBACK_SKILL_METHOD}",
  uninstallSkill: "{UNINSTALL_SKILL_METHOD}",
  listRemovedSkills: "{LIST_REMOVED_SKILLS_METHOD}",
  restoreSkill: "{RESTORE_SKILL_METHOD}",
  readSkillFile: "{READ_SKILL_FILE_METHOD}",
  listGlobalMemories: "{LIST_GLOBAL_MEMORIES_METHOD}",
  listActivity: "{LIST_ACTIVITY_METHOD}",
  listScanRoots: "{LIST_SCAN_ROOTS_METHOD}",
  addScanRoot: "{ADD_SCAN_ROOT_METHOD}",
  removeScanRoot: "{REMOVE_SCAN_ROOT_METHOD}",
  refreshDiscovery: "{REFRESH_DISCOVERY_METHOD}",
  discoveryReport: "{DISCOVERY_REPORT_METHOD}",
  listExcludedWorkspaces: "{LIST_EXCLUDED_WORKSPACES_METHOD}",
  listRemoteGateways: "{LIST_REMOTE_GATEWAYS_METHOD}",
  saveRemoteGateway: "{SAVE_REMOTE_GATEWAY_METHOD}",
  refreshRemoteGateway: "{REFRESH_REMOTE_GATEWAY_METHOD}",
  removeRemoteGateway: "{REMOVE_REMOTE_GATEWAY_METHOD}",
  obsidianIntegration: "{OBSIDIAN_INTEGRATION_METHOD}",
  addObsidianVault: "{ADD_OBSIDIAN_VAULT_METHOD}",
  linkObsidianWorkspace: "{LINK_OBSIDIAN_WORKSPACE_METHOD}",
  unlinkObsidianWorkspace: "{UNLINK_OBSIDIAN_WORKSPACE_METHOD}",
  openObsidian: "{OPEN_OBSIDIAN_METHOD}",
  openObsidianWorkspace: "{OPEN_OBSIDIAN_WORKSPACE_METHOD}",
  setCloseBehavior: "{SET_CLOSE_BEHAVIOR_METHOD}",
  setLocale: "{SET_LOCALE_METHOD}",
  setThemePreference: "{SET_THEME_PREFERENCE_METHOD}",
  setAccentThemePreference: "{SET_ACCENT_THEME_PREFERENCE_METHOD}",
  setSidebarWidthPreference: "{SET_SIDEBAR_WIDTH_PREFERENCE_METHOD}",
  remoteRequest: "{REMOTE_REQUEST_METHOD}",
  webRequest: "{WEB_REQUEST_METHOD}",
  setAppIconPreference: "{SET_APP_ICON_PREFERENCE_METHOD}",
  planChanges: "{PLAN_CHANGES_METHOD}",
  applyChanges: "{APPLY_CHANGES_METHOD}",
  listMemories: "{LIST_MEMORIES_METHOD}",
  searchMemories: "{SEARCH_MEMORIES_METHOD}",
  proposeMemory: "{PROPOSE_MEMORY_METHOD}",
  reviewMemory: "{REVIEW_MEMORY_METHOD}",
  prepareSessionHandoff: "{PREPARE_SESSION_HANDOFF_METHOD}",
  sanitizeSessionHandoff: "{SANITIZE_SESSION_HANDOFF_METHOD}",
  planSessionHandoff: "{PLAN_SESSION_HANDOFF_METHOD}",
  planSessionMcpConnection: "{PLAN_SESSION_MCP_CONNECTION_METHOD}",
  continueSessionHandoff: "{CONTINUE_SESSION_HANDOFF_METHOD}",
  launchSessionHandoff: "{LAUNCH_SESSION_HANDOFF_METHOD}",
  clearSessionIndex: "{CLEAR_SESSION_INDEX_METHOD}",
  setSessionIndexEnabled: "{SET_SESSION_INDEX_ENABLED_METHOD}",
  mcpHubStatus: "{MCP_HUB_STATUS_METHOD}",
  updateMcpNetwork: "{UPDATE_MCP_NETWORK_METHOD}",
  listMcpServers: "{LIST_MCP_SERVERS_METHOD}",
  getMcpServer: "{GET_MCP_SERVER_METHOD}",
  saveMcpServer: "{SAVE_MCP_SERVER_METHOD}",
  saveMcpLocalValues: "{SAVE_MCP_LOCAL_VALUES_METHOD}",
  removeMcpServer: "{REMOVE_MCP_SERVER_METHOD}",
  probeMcpRuntime: "{PROBE_MCP_RUNTIME_METHOD}",
  startMcpOAuth: "{START_MCP_OAUTH_METHOD}",
  listMcpRuntimes: "{LIST_MCP_RUNTIMES_METHOD}",
  restartMcpRuntime: "{RESTART_MCP_RUNTIME_METHOD}",
  stopMcpRuntime: "{STOP_MCP_RUNTIME_METHOD}",
  searchMcpRegistry: "{SEARCH_MCP_REGISTRY_METHOD}",
  refreshMcpRegistry: "{REFRESH_MCP_REGISTRY_METHOD}",
  installMcp: "{INSTALL_MCP_METHOD}",
  updateMcp: "{UPDATE_MCP_METHOD}",
  listMcpInstallations: "{LIST_MCP_INSTALLATIONS_METHOD}",
  uninstallMcp: "{UNINSTALL_MCP_METHOD}",
  scanNativeMcp: "{SCAN_NATIVE_MCP_METHOD}",
  planMcpMigration: "{PLAN_MCP_MIGRATION_METHOD}",
  insightsHeatmap: "{INSIGHTS_HEATMAP_METHOD}",
  agentUsageBreakdown: "{AGENT_USAGE_BREAKDOWN_METHOD}",
  modelUsageBreakdown: "{MODEL_USAGE_BREAKDOWN_METHOD}",
  workspaceUsageBreakdown: "{WORKSPACE_USAGE_BREAKDOWN_METHOD}",
  repositoryCommitBreakdown: "{REPOSITORY_COMMIT_BREAKDOWN_METHOD}",
  achievements: "{ACHIEVEMENTS_METHOD}",
  gitIdentities: "{GIT_IDENTITIES_METHOD}",
  addGitIdentityAlias: "{ADD_GIT_IDENTITY_ALIAS_METHOD}",
  setGitIdentityEnabled: "{SET_GIT_IDENTITY_ENABLED_METHOD}",
  workspaceDoctorSummaries: "{WORKSPACE_DOCTOR_SUMMARIES_METHOD}",
  insightsView: "{INSIGHTS_VIEW_METHOD}",
  refreshInsights: "{REFRESH_INSIGHTS_METHOD}",
  insightsSummary: "{INSIGHTS_SUMMARY_METHOD}",
  insightsStatus: "{INSIGHTS_STATUS_METHOD}",
  quotaCollectorStatus: "{QUOTA_COLLECTOR_STATUS_METHOD}",
  quotaSnapshot: "{QUOTA_SNAPSHOT_METHOD}",
  quotaPreferences: "{QUOTA_PREFERENCES_METHOD}",
  setQuotaPreferences: "{SET_QUOTA_PREFERENCES_METHOD}",
  refreshQuota: "{REFRESH_QUOTA_METHOD}",
  setQuotaAutoRefresh: "{SET_QUOTA_AUTO_REFRESH_METHOD}",
  setLocalAutoRefresh: "{SET_LOCAL_AUTO_REFRESH_METHOD}",
  setQuotaPromptSeen: "{SET_QUOTA_PROMPT_SEEN_METHOD}",
  storageOverview: "{STORAGE_OVERVIEW_METHOD}",
  storageChildren: "{STORAGE_CHILDREN_METHOD}",
  refreshStorage: "{REFRESH_STORAGE_METHOD}",
  resolveStoragePath: "{RESOLVE_STORAGE_PATH_METHOD}",
  cancelStorage: "{CANCEL_STORAGE_METHOD}",
  updateOnboarding: "{UPDATE_ONBOARDING_METHOD}",
}} as const;

export interface RuntimePeer {{
  name: string;
  version: string;
}}

export interface RuntimeHandshakeRequest {{
  protocolVersion: typeof PROTOCOL_VERSION;
  client: RuntimePeer;
}}

export interface RuntimeHandshakeResult {{
  protocolVersion: typeof PROTOCOL_VERSION;
  runtime: RuntimePeer;
  pid: number;
  capabilities: string[];
}}

export interface RuntimeRpcError {{
  code: number;
  message: string;
  data?: unknown;
}}
"#
    )
}
