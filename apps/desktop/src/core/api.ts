import type { NativeMemoryQuery } from "@agentkib/runtime-protocol";
import type {
  McpBatchConnectionRequest,
  McpImportApplyRequest,
  McpImportRequest,
  McpSaveRequest,
  McpToolPolicyRule,
} from "@agentkib/runtime-protocol";
import { desktopApi } from "./desktop";
import { DEFAULT_SESSION_PAGE_SIZE } from "./session-history";
import type { RemoteRequest } from "./remote-types";
import type {
  AgentKind,
  AgentToolExecutionResult,
  AccentThemeId,
  AppIconPreference,
  AppUpdateProgress,
  ChangeSet,
  CloseBehavior,
  ContextDoctorSummary,
  GitDiffRequest,
  GitHistoryQuery,
  HandoffFormat,
  InsightsQuery,
  LocalePreference,
  Manifest,
  McpNetworkSettings,
  McpRegistryEntry,
  McpServerConfig,
  SkillSource,
  SkillVersionListRequest,
  SkillVersionSelector,
  SkillDetailRequest,
  PrepareSkillDeploymentRequest,
  PrepareSkillSyncRequest,
  SaveSkillSyncPolicyRequest,
  SkillSyncComparison,
  MemoryStatus,
  MemoryType,
  OnboardingEvent,
  QuotaPopoverPreferences,
  LocalCostProvider,
  RefreshKind,
  RemoteGatewayInput,
  SessionHandoffLaunchRequest,
  SessionHandoffRequest,
  SessionContinuationMode,
  ThemePreference,
} from "./types";
const DOCTOR_SUMMARY_BATCH_LIMIT = 100;

export const api = {
  claudeRequest: (request: Record<string, unknown>) => desktopApi().claude.request(request),
  remoteRequest: <T extends RemoteRequest>(request: T) => desktopApi().remote.request(request),
  scan: (project: string) => desktopApi().workspace.scan(project),
  manifest: async (project: string) => {
    const manifest = await desktopApi().workspace.prepareManifest(project);
    // Empty legacy connections are omitted from manifest serialization.
    // Keep the React model total at the IPC boundary without writing the field back to disk.
    return { ...manifest, connections: manifest.connections ?? [] };
  },
  plan: (project: string, manifest: Manifest, includeHome: boolean) =>
    desktopApi().changes.plan(project, manifest, includeHome),
  apply: (
    changeSet: ChangeSet,
    approveHome: boolean,
    launchRequest?: SessionHandoffLaunchRequest,
  ) => desktopApi().changes.apply(changeSet, approveHome, launchRequest),
  context: (project: string, cwd: string, agent: AgentKind) =>
    desktopApi().workspace.resolveContext(project, cwd, agent),
  pickDirectory: async (title?: string) => {
    const selected = await desktopApi().shell.openDirectory(title);
    return typeof selected === "string" ? selected : undefined;
  },
  memories: (project: string, status?: MemoryStatus) => desktopApi().memories.list(project, status),
  searchMemories: (project: string, query: string, limit = 50) =>
    desktopApi().memories.search(project, query, limit),
  proposeMemory: (project: string, content: string, memoryType: MemoryType) =>
    desktopApi().memories.propose(project, {
      project_id: "",
      memory_type: memoryType,
      content,
      source_agent: "agentkib-desktop",
    }),
  reviewMemory: (id: string, status: MemoryStatus, editedContent?: string) =>
    desktopApi().memories.review(id, status, editedContent),
  runtime: () => desktopApi().home.runtime(),
  agentTools: (force = false) => desktopApi().home.agentTools(force),
  executeAgentTool: (agent: AgentKind, actionId: string): Promise<AgentToolExecutionResult> =>
    desktopApi().home.executeAgentTool(agent, actionId),
  updateOnboarding: (event: OnboardingEvent) => desktopApi().home.updateOnboarding(event),
  openFilesAndFoldersSettings: () => desktopApi().shell.openFilesAndFoldersSettings(),
  openExternal: (url: string) => desktopApi().shell.openExternal(url),
  quitApp: () => desktopApi().shell.quit(),
  setCloseBehavior: (behavior?: CloseBehavior) => desktopApi().settings.setCloseBehavior(behavior),
  setLocale: (preference: LocalePreference) => desktopApi().settings.setLocale(preference),
  setThemePreference: (preference: ThemePreference) =>
    desktopApi().settings.setThemePreference(preference),
  setAccentThemePreference: (preference: AccentThemeId) =>
    desktopApi().settings.setAccentThemePreference(preference),
  setSidebarWidthPreference: (preference: number) =>
    desktopApi().settings.setSidebarWidthPreference(preference),
  setAppIconPreference: (preference: AppIconPreference) =>
    desktopApi().settings.setAppIconPreference(preference),
  checkAppUpdate: () => desktopApi().updates.check(),
  installAppUpdate: (version: string, onEvent: (event: AppUpdateProgress) => void) =>
    desktopApi().updates.install(version, onEvent),
  mcpManagementState: (request: { project?: string }) => desktopApi().mcp.managementState(request),
  saveMcpConfiguration: (request: McpSaveRequest) => desktopApi().mcp.saveConfiguration(request),
  removeMcpConfiguration: (request: { project?: string; revision: string; id: string }) =>
    desktopApi().mcp.removeConfiguration(request),
  previewMcpImport: (request: McpImportRequest) => desktopApi().mcp.previewImport(request),
  applyMcpImport: (request: McpImportApplyRequest) => desktopApi().mcp.applyImport(request),
  checkMcpConnections: (request: McpBatchConnectionRequest) =>
    desktopApi().mcp.checkConnections(request),
  planMcpConnections: (request: McpBatchConnectionRequest) =>
    desktopApi().mcp.planConnections(request),
  applyMcpConnections: (request: { token: string; approveHome: boolean }) =>
    desktopApi().mcp.applyConnections(request),
  getMcpPolicy: (request: { project?: string }) => desktopApi().mcp.getPolicy(request),
  saveMcpPolicy: (request: { project?: string; revision: string; rules: McpToolPolicyRule[] }) =>
    desktopApi().mcp.savePolicy(request),
  previewMcpMigration: (request: { project: string; revision: string; candidateIds: string[] }) =>
    desktopApi().mcp.previewMigration(request),
  applyMcpMigration: (request: { token: string; approveHome: boolean }) =>
    desktopApi().mcp.applyMigration(request),
  mcpHubStatus: () => desktopApi().mcp.hubStatus(),
  mcpConnectionInfo: (workspaceId: string, targetAgent: AgentKind) =>
    desktopApi().mcp.connectionInfo(workspaceId, targetAgent),
  planMcpConnection: (workspaceId: string, targetAgent: AgentKind) =>
    desktopApi().mcp.planConnection(workspaceId, targetAgent),
  verifyMcpConnection: (workspaceId: string, targetAgent: AgentKind) =>
    desktopApi().mcp.verifyConnection(workspaceId, targetAgent),
  updateMcpNetwork: (settings: McpNetworkSettings) => desktopApi().mcp.updateNetwork(settings),
  mcpServers: (project?: string) => desktopApi().mcp.listServers(project),
  mcpServer: (serverId: string, project?: string) => desktopApi().mcp.getServer(serverId, project),
  saveMcpServer: (server: McpServerConfig, project?: string) =>
    desktopApi().mcp.saveServer(server, project),
  saveMcpLocalValues: (
    serverId: string,
    env: Record<string, string>,
    headers: Record<string, string>,
    project?: string,
  ) => desktopApi().mcp.saveLocalValues(serverId, env, headers, project),
  removeMcpServer: (serverId: string, project?: string) =>
    desktopApi().mcp.removeServer(serverId, project),
  probeMcpRuntime: (serverId: string, project?: string) =>
    desktopApi().mcp.probeRuntime(serverId, project),
  startMcpOAuth: (serverId: string, project?: string) =>
    desktopApi().mcp.startOAuth(serverId, project),
  mcpRuntimes: () => desktopApi().mcp.runtimes(),
  restartMcpRuntime: (serverId: string, project?: string) =>
    desktopApi().mcp.restartRuntime(serverId, project),
  stopMcpRuntime: (serverId?: string) => desktopApi().mcp.stopRuntime(serverId),
  searchMcpRegistry: (query: string) => desktopApi().mcp.searchRegistry(query),
  refreshMcpRegistry: (query: string) => desktopApi().mcp.refreshRegistry(query),
  installMcp: (entry: McpRegistryEntry, project?: string) =>
    desktopApi().mcp.install(entry, project),
  updateMcp: (installationId: string, entry: McpRegistryEntry, project?: string) =>
    desktopApi().mcp.update(installationId, entry, project),
  mcpInstallations: () => desktopApi().mcp.installations(),
  uninstallMcp: (installationId: string) => desktopApi().mcp.uninstall(installationId),
  skillCatalog: (force = false) => desktopApi().skills.catalog(force),
  discoverSkills: (url: string) => desktopApi().skills.discover(url),
  installedSkills: () => desktopApi().skills.installed(),
  prepareSkillInstall: (source: SkillSource) => desktopApi().skills.prepareInstall(source),
  applySkillOperation: (token: string, allowModified = false) =>
    desktopApi().skills.applyOperation(token, allowModified),
  checkSkillUpdates: () => desktopApi().skills.checkUpdates(),
  prepareSkillUpdate: (name: string) => desktopApi().skills.prepareUpdate(name),
  listSkillVersions: (request: SkillVersionListRequest) =>
    desktopApi().skills.listVersions(request),
  prepareSkillVersionChange: (libraryId: string, selector: SkillVersionSelector) =>
    desktopApi().skills.prepareVersionChange(libraryId, selector),
  discardSkillPreview: (token: string) => desktopApi().skills.discardPreview(token),
  rollbackSkill: (name: string) => desktopApi().skills.rollback(name),
  uninstallSkill: (name: string) => desktopApi().skills.uninstall(name),
  removedSkills: () => desktopApi().skills.removed(),
  restoreSkill: (id: string) => desktopApi().skills.restore(id),
  readSkillFile: (name: string, path: string) => desktopApi().skills.readFile(name, path),
  skillInventory: () => desktopApi().skills.inventory(),
  skillTargets: () => desktopApi().skills.targets(),
  skillDetail: (request: SkillDetailRequest) => desktopApi().skills.getDetail(request),
  readSkillDetailFile: (request: SkillDetailRequest & { path: string }) =>
    desktopApi().skills.readDetailFile(request),
  prepareSkillImport: (observationId: string) => desktopApi().skills.prepareImport(observationId),
  prepareSkillImports: (observationIds: string[]) =>
    desktopApi().skills.prepareImports(observationIds),
  applySkillImports: (token: string) => desktopApi().skills.applyImports(token),
  readSkillPreviewFile: (
    token: string,
    path: string,
    targetId?: string,
    itemId?: string,
    comparison?: SkillSyncComparison,
  ) => desktopApi().skills.readPreviewFile(token, path, targetId, itemId, comparison),
  skillDeployments: () => desktopApi().skills.listDeployments(),
  prepareSkillDeployment: (request: PrepareSkillDeploymentRequest) =>
    desktopApi().skills.prepareDeployment(request),
  applySkillDeployment: (token: string, approveHome: boolean) =>
    desktopApi().skills.applyDeployment(token, approveHome),
  skillSyncState: () => desktopApi().skills.syncState(),
  skillSyncPolicy: () => desktopApi().skills.syncPolicy(),
  prepareSkillSync: (request: PrepareSkillSyncRequest) => desktopApi().skills.prepareSync(request),
  applySkillSync: (token: string, approveHome: boolean) =>
    desktopApi().skills.applySync(token, approveHome),
  saveSkillSyncPolicy: (request: SaveSkillSyncPolicyRequest) =>
    desktopApi().skills.saveSyncPolicy(request),
  skillSyncRuns: (limit?: number) => desktopApi().skills.syncRuns(limit),
  recoverSkillSync: (operationId: string, approveHome: boolean) =>
    desktopApi().skills.recoverSync(operationId, approveHome),
  nativeMcpCandidates: (project?: string) => desktopApi().mcp.scanNative(project),
  planMcpMigration: (project: string, candidateIds: string[]) =>
    desktopApi().mcp.planMigration(project, candidateIds),
  requestRefresh: (kind: RefreshKind, force = false) => {
    const desktop = desktopApi();
    if (kind === "discovery") return desktop.home.refreshDiscovery(force);
    if (kind === "insights") return desktop.home.refreshInsights(force);
    if (kind === "gateways") return desktop.home.refreshGateways(force);
    if (kind === "quota") return desktop.home.refreshQuota(force);
    if (kind === "storage") return desktop.home.refreshStorage(force);
    if (kind === "doctor") return desktop.home.refreshDoctor(force);
    return Promise.reject(new Error(`Unsupported Electron refresh kind: ${kind}`));
  },
  refreshStatus: () => desktopApi().home.refreshStatus(),
  storageOverview: () => desktopApi().home.storageOverview(),
  workspaceStorageChildren: (workspaceId: string, relativePath: string) =>
    desktopApi().home.storageChildren(workspaceId, relativePath),
  openWorkspaceStoragePath: (workspaceId: string, relativePath: string) =>
    desktopApi().home.openStoragePath(workspaceId, relativePath),
  cancelStorageScan: () => desktopApi().home.cancelStorage(),
  discoverWorkspaces: () => desktopApi().home.refreshDiscovery(),
  discoveryReport: () => desktopApi().home.discoveryReport(),
  workspaces: () => desktopApi().home.workspaces(),
  workspace: async (id: string) => {
    const workspaces = await desktopApi().home.workspaces();
    return workspaces.find((workspace) => workspace.id === id);
  },
  workspaceGitSummary: (workspaceId: string) => desktopApi().workspace.gitSummary(workspaceId),
  workspaceGitHistory: (workspaceId: string, query: GitHistoryQuery = {}) =>
    desktopApi().workspace.gitHistory(workspaceId, query),
  gitCommitFiles: (workspaceId: string, oid: string) =>
    desktopApi().workspace.gitCommitFiles(workspaceId, oid),
  gitDiff: (workspaceId: string, request: GitDiffRequest) =>
    desktopApi().workspace.gitDiff(workspaceId, request),
  workspaceOpeners: (workspaceId: string) => desktopApi().workspace.openers(workspaceId),
  openWorkspaceWithApp: (workspaceId: string, openerId?: string) =>
    desktopApi().workspace.open(workspaceId, openerId),
  workspaceSessions: (workspaceId: string) => desktopApi().workspace.sessions(workspaceId),
  refreshWorkspaceSessions: (workspaceId: string, force = false) =>
    desktopApi().workspace.refreshSessions(workspaceId, force),
  sessionEvents: (sessionId: string, cursor?: string, limit = DEFAULT_SESSION_PAGE_SIZE) =>
    desktopApi().workspace.sessionEvents(sessionId, cursor, limit),
  sessionSourceCapability: (sessionId: string) =>
    desktopApi().workspace.sourceCapability(sessionId),
  nativeImportOperations: (workspaceId: string) =>
    desktopApi().workspace.nativeImports(workspaceId),
  cursorBridge: (request: import("./types").CursorBridgeRequest) =>
    desktopApi().workspace.cursorBridge(request),
  cursorBridgeBundle: () => desktopApi().workspace.bridgeBundle(),
  revealCursorBridgeBundle: () => desktopApi().workspace.revealBridgeBundle(),
  prepareSessionHandoff: (request: SessionHandoffRequest) =>
    desktopApi().workspace.prepareHandoff(request),
  planSessionMcpConnection: (workspaceId: string, targetAgent: AgentKind) =>
    desktopApi().workspace.planMcpConnection(workspaceId, targetAgent),
  sanitizeSessionHandoff: (format: HandoffFormat, editedContent: string) =>
    desktopApi().workspace.sanitizeHandoff(format, editedContent),
  planSessionHandoff: (
    sessionId: string,
    workspaceId: string,
    filename: string,
    format: HandoffFormat,
    editedContent: string | undefined,
    targetAgent: AgentKind,
    mode: SessionContinuationMode,
    sourceFingerprint: string,
    acceptLosses: boolean,
    historyBudgetTokens: number,
    archiveId: string | undefined,
    targetFingerprint?: string,
    targetSurface?: "cursor-ide",
    bindingId?: string,
    includePreCompactionHistory?: boolean,
  ) =>
    desktopApi().workspace.planHandoff(
      sessionId,
      workspaceId,
      filename,
      format,
      editedContent,
      targetAgent,
      mode,
      sourceFingerprint,
      acceptLosses,
      historyBudgetTokens,
      archiveId,
      targetFingerprint,
      targetSurface,
      bindingId,
      includePreCompactionHistory,
    ),
  continueSessionHandoff: (
    changeSet: ChangeSet,
    launchRequest: SessionHandoffLaunchRequest,
    approveHome: boolean,
  ) => desktopApi().workspace.continueHandoff(changeSet, launchRequest, approveHome),
  launchSessionHandoff: (launchRequest: SessionHandoffLaunchRequest) =>
    desktopApi().workspace.launchHandoff(launchRequest),
  workspaceSessionStatus: (workspaceId: string) =>
    desktopApi().workspace.sessionStatus(workspaceId),
  clearSessionIndex: (workspaceId?: string) => desktopApi().sessions.clearIndex(workspaceId),
  setSessionIndexEnabled: (enabled: boolean) => desktopApi().sessions.setIndexEnabled(enabled),
  setLocalAutoRefreshEnabled: (enabled: boolean) => desktopApi().home.setLocalAutoRefresh(enabled),
  setQuotaAutoRefreshEnabled: (enabled: boolean) => desktopApi().home.setQuotaAutoRefresh(enabled),
  setQuotaAutoRefreshPromptSeen: (seen: boolean) => desktopApi().home.setQuotaPromptSeen(seen),
  addWorkspace: (path: string) => desktopApi().workspace.add(path),
  refreshWorkspace: (id: string) => desktopApi().workspace.refresh(id),
  excludeWorkspace: (id: string) => desktopApi().workspace.exclude(id),
  excludedWorkspaces: () => desktopApi().home.excludedWorkspaces(),
  restoreExcludedWorkspace: (path: string) => desktopApi().workspace.restoreExcluded(path),
  obsidianIntegration: () => desktopApi().home.obsidianIntegration(),
  addObsidianVault: (path: string) => desktopApi().home.addObsidianVault(path),
  linkWorkspaceToObsidian: (workspaceId: string, vaultPath: string, relativeTarget?: string) =>
    desktopApi().home.linkWorkspaceToObsidian(workspaceId, vaultPath, relativeTarget),
  unlinkWorkspaceFromObsidian: (workspaceId: string) =>
    desktopApi().home.unlinkWorkspaceFromObsidian(workspaceId),
  openObsidian: () => desktopApi().home.openObsidian(),
  openWorkspaceInObsidian: (workspaceId: string) =>
    desktopApi().home.openWorkspaceInObsidian(workspaceId),
  remoteGateways: () => desktopApi().home.remoteGateways(),
  saveRemoteGateway: (input: RemoteGatewayInput) => desktopApi().home.saveRemoteGateway(input),
  refreshRemoteGateway: (id: string) => desktopApi().home.refreshRemoteGateway(id),
  removeRemoteGateway: (id: string) => desktopApi().home.removeRemoteGateway(id),
  scanRoots: () => desktopApi().home.scanRoots(),
  addScanRoot: (path: string, maxDepth = 5) => desktopApi().home.addScanRoot(path, maxDepth),
  removeScanRoot: (id: string) => desktopApi().home.removeScanRoot(id),
  agentInstallations: () => desktopApi().home.agentInstallations(),
  workspaceDoctorReport: (workspaceId: string) => desktopApi().workspace.doctorReport(workspaceId),
  workspaceDoctorSummaries: async (workspaceIds: string[]) => {
    const summaries: ContextDoctorSummary[] = [];
    for (let offset = 0; offset < workspaceIds.length; offset += DOCTOR_SUMMARY_BATCH_LIMIT) {
      const batch = workspaceIds.slice(offset, offset + DOCTOR_SUMMARY_BATCH_LIMIT);
      summaries.push(...(await desktopApi().workspace.doctorSummaries(batch)));
    }
    return summaries;
  },
  catalogAssets: (query = "", agent?: AgentKind, workspaceId?: string, limit = 500) =>
    desktopApi().home.catalogAssets({ query, agent, workspaceId, limit }),
  nativeMemoryList: (query: NativeMemoryQuery = {}) => desktopApi().home.nativeMemoryList(query),
  nativeMemorySearch: (query: NativeMemoryQuery) => desktopApi().home.nativeMemorySearch(query),
  nativeMemoryRead: (fileId: string) => desktopApi().home.nativeMemoryRead(fileId),
  nativeMemoryRefresh: () => desktopApi().home.nativeMemoryRefresh(),
  nativeMemoryObserve: (active: boolean) => desktopApi().home.nativeMemoryObserve(active),
  globalMemories: (status?: MemoryStatus) => desktopApi().home.globalMemories(status),
  activity: (limit = 200) => desktopApi().home.activity(limit),
  refreshInsights: () => desktopApi().home.refreshInsights(),
  insightsView: (query: InsightsQuery = {}) => desktopApi().home.insightsView(query),
  insightsHeatmap: (query: InsightsQuery = {}) => desktopApi().insights.heatmap(query),
  agentUsageBreakdown: (query: InsightsQuery = {}) => desktopApi().insights.agentUsage(query),
  modelUsageBreakdown: (query: InsightsQuery = {}) => desktopApi().insights.modelUsage(query),
  workspaceUsageBreakdown: (query: InsightsQuery = {}) =>
    desktopApi().insights.workspaceUsage(query),
  repositoryCommitBreakdown: (query: InsightsQuery = {}) =>
    desktopApi().insights.repositoryCommits(query),
  achievements: () => desktopApi().insights.achievements(),
  insightsStatus: () => desktopApi().home.insightsStatus(),
  gitIdentities: () => desktopApi().insights.gitIdentities(),
  addGitIdentityAlias: (email: string) => desktopApi().insights.addGitIdentityAlias(email),
  setGitIdentityEnabled: (id: string, enabled: boolean) =>
    desktopApi().insights.setGitIdentityEnabled(id, enabled),
  quotaSnapshot: () => desktopApi().home.quotaSnapshot(),
  refreshQuota: (provider?: string) => desktopApi().home.refreshQuota(true, provider),
  localCostSnapshot: (provider: LocalCostProvider) => desktopApi().home.localCostSnapshot(provider),
  localCostStatus: (provider: LocalCostProvider) => desktopApi().home.localCostStatus(provider),
  refreshLocalCost: (provider: LocalCostProvider, force = true) =>
    desktopApi().home.refreshLocalCost(provider, force),
  observeLocalCosts: (provider: LocalCostProvider | null) =>
    desktopApi().home.observeLocalCosts(provider),
  quotaCollectorStatus: () => desktopApi().home.quotaCollectorStatus(),
  quotaPopoverPreferences: () => desktopApi().home.quotaPreferences(),
  setQuotaPopoverPreferences: (preferences: QuotaPopoverPreferences) =>
    desktopApi().home.setQuotaPreferences(preferences),
};
