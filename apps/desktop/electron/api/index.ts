import type { McpMigrationPreview, McpMigrationResult } from "@agentkib/runtime-protocol";
import type {
  McpBatchConnectionCheck,
  McpBatchConnectionPlan,
  McpBatchConnectionReport,
  McpBatchConnectionRequest,
  McpImportApplyRequest,
  McpImportPreview,
  McpImportReport,
  McpImportRequest,
  McpManagementState,
  McpSaveRequest,
  McpToolPolicyRule,
  McpToolPolicySnapshot,
} from "@agentkib/runtime-protocol";
import type { DesktopAccountRequest, DesktopAccountStatus } from "../main/account/state";
import type {
  RuntimeHandshakeResult,
  SessionStreamEvent,
  SessionSubscription,
} from "../generated/runtime-protocol";
import type { WebAdminRequest, WebAdminStatus } from "../main/web/service";
import type { RemoteRequest, RemoteResponse } from "../../src/core/remote-types";
import type {
  AgentKind,
  AccentThemeId,
  AppMenuCommandRequest,
  AppNavigationRequest,
  AppUpdateInfo,
  AppUpdateProgress,
  Achievement,
  AgentUsageBreakdown,
  ChangeSet,
  CatalogAsset,
  ContextDoctorSummary,
  ContextPreview,
  ExcludedWorkspace,
  EffectiveTheme,
  InsightsQuery,
  InsightsStatus,
  Manifest,
  MemoryRecord,
  OnboardingEvent,
  ObsidianIntegration,
  QuotaCollectorStatus,
  QuotaPopoverPreferences,
  QuotaSnapshot,
  RefreshJobStatus,
  RefreshReceipt,
  ScanRoot,
  StorageNode,
  StorageOverview,
  WorkspaceScan,
  WorkspaceSummary,
  AgentInstallation,
  AgentToolSnapshot,
  AgentToolExecutionResult,
  ActivityRecord,
  GitCommitPage,
  GitDiff,
  GitDiffRequest,
  GitFileChange,
  GitHistoryQuery,
  GitWorkspaceSummary,
  ConversationEventPage,
  ConversationIndexStatus,
  ConversationSessionSummary,
  SessionHandoffRequest,
  SessionHandoffPreparation,
  SessionContinuationMode,
  SessionHandoffLaunchRequest,
  HandoffContinuationResult,
  HandoffFormat,
  HandoffLaunchReceipt,
  PlannedSessionHandoff,
  RuntimeInfo,
  InsightsSummary,
  InsightsView,
  ContextDoctorReport,
  WorkspaceOpener,
  AppIconPreference,
  CloseBehavior,
  LocalePreference,
  McpHubStatus,
  McpConnectionInfo,
  McpConnectionVerification,
  McpInstallation,
  McpInstallResult,
  McpMigrationCandidate,
  McpOAuthStart,
  McpRegistryEntry,
  McpRuntimeStatus,
  McpServerConfig,
  McpToolDescriptor,
  RemoteGatewayInput,
  RemoteGatewaySummary,
  InstalledSkill,
  RemovedSkill,
  SkillCandidate,
  SkillCatalogSnapshot,
  SkillFilePreview,
  SkillOperationPreview,
  SkillSource,
  SkillVersionSelector,
  SkillVersionListRequest,
  SkillVersionList,
  SkillImportBatchPreview,
  SkillImportBatchReport,
  SkillInventory,
  SkillTargetCapability,
  SkillDetailRequest,
  SkillDetail,
  SkillPreviewFile,
  SkillDeployment,
  PrepareSkillDeploymentRequest,
  SkillDeploymentPreview,
  SkillDeploymentReport,
  SkillSyncState,
  SkillSyncPolicy,
  SaveSkillSyncPolicyRequest,
  PrepareSkillSyncRequest,
  SkillSyncPreview,
  SkillSyncReport,
  SkillSyncRuns,
  SkillSyncCoordinatorState,
  SkillSyncComparison,
  ObsidianWorkspaceLink,
  GitIdentitySummary,
} from "../../src/core/types";

export type DesktopEventUnsubscribe = () => void;

export interface DesktopConversationApi {
  request(
    path: string,
    body?: unknown,
    requestId?: string,
  ): Promise<{ status: number; body: unknown }>;
  cancelRead(requestId: string): Promise<void>;
  upload(input: {
    sessionId: string;
    name: string;
    mime: string;
    data: ArrayBuffer;
  }): Promise<{ status: number; body: unknown }>;
  subscribe(sessionId: string, afterCursor?: string): Promise<SessionSubscription>;
  acknowledge(subscriptionId: string, cursor: string): Promise<void>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onEvent(listener: (event: SessionStreamEvent) => void): DesktopEventUnsubscribe;
  onUnavailable(listener: () => void): DesktopEventUnsubscribe;
  onControlChanged(listener: (sessionId: string) => void): DesktopEventUnsubscribe;
}

export interface DesktopRuntimeStatus {
  state: "starting" | "ready" | "restarting" | "failed" | "stopping";
  restartCount: number;
  error?: string;
}

export interface ClaudeBridgeStatus {
  bridgeCompatibility?: import("@agentkib/runtime-protocol").ClaudeBridgeCompatibilityStatus | null;
  connectionCliVersion?: string;
  connectionMissingCapabilities?: string[];
  connectionError?: string;
  supported: boolean;
  connected: boolean;
  /** A verified, unrevoked original binding; independent of the current terminal lease. */
  hasBinding?: boolean;
  sessionId: string;
  version: string;
  reason?: string;
  pluginDirectory: string;
  installInstructions: string;
}
export interface ClaudeBridgeChallenge {
  challenge: string;
  expiresAt: string;
  instructions: string;
}

export interface DesktopApi {
  claude: { request(input: Record<string, unknown>): Promise<unknown> };
  account: {
    request(input: DesktopAccountRequest): Promise<DesktopAccountStatus>;
    onStatus(listener: (status: DesktopAccountStatus) => void): DesktopEventUnsubscribe;
  };
  web: { request(input: WebAdminRequest): Promise<WebAdminStatus> };
  platform: NodeJS.Platform;
  events: {
    onWindowActivity(listener: (active: boolean) => void): DesktopEventUnsubscribe;
    onQuitRequested(listener: () => void): DesktopEventUnsubscribe;
    onThemeChanged(listener: (theme: EffectiveTheme) => void): DesktopEventUnsubscribe;
    onRefreshState(listener: (status: RefreshJobStatus) => void): DesktopEventUnsubscribe;
    onSkillSyncState(
      listener: (status: SkillSyncCoordinatorState) => void,
    ): DesktopEventUnsubscribe;
    onQuotaUpdated(listener: (snapshot: QuotaSnapshot) => void): DesktopEventUnsubscribe;
    onNavigate(listener: (request: AppNavigationRequest) => void): DesktopEventUnsubscribe;
    onMenuCommand(listener: (request: AppMenuCommandRequest) => void): DesktopEventUnsubscribe;
    onRuntimeStatus(listener: (status: DesktopRuntimeStatus) => void): DesktopEventUnsubscribe;
  };
  runtime: {
    handshake(): Promise<RuntimeHandshakeResult>;
    status(): Promise<DesktopRuntimeStatus>;
    retry(): Promise<void>;
  };
  benchmark: {
    mark(name: "renderer-first-commit" | "home-data-ready" | "home-data-failed"): Promise<void>;
  };
  updates: {
    check(): Promise<AppUpdateInfo | undefined>;
    install(version: string, onEvent: (event: AppUpdateProgress) => void): Promise<void>;
  };
  changes: {
    plan(project: string, manifest: Manifest, includeHome: boolean): Promise<ChangeSet>;
    apply(
      changeSet: ChangeSet,
      approveHome: boolean,
      launchRequest?: SessionHandoffLaunchRequest,
    ): Promise<unknown>;
  };
  memories: {
    list(project: string, status?: string): Promise<MemoryRecord[]>;
    search(project: string, query: string, limit?: number): Promise<MemoryRecord[]>;
    propose(project: string, proposal: unknown): Promise<MemoryRecord>;
    review(id: string, status: string, editedContent?: string): Promise<MemoryRecord>;
  };
  sessions: {
    clearIndex(workspaceId?: string): Promise<void>;
    setIndexEnabled(enabled: boolean): Promise<RuntimeInfo>;
  };
  skills: {
    catalog(force?: boolean): Promise<SkillCatalogSnapshot>;
    discover(url: string): Promise<SkillCandidate[]>;
    installed(): Promise<InstalledSkill[]>;
    prepareInstall(source: SkillSource): Promise<SkillOperationPreview>;
    applyOperation(token: string, allowModified?: boolean): Promise<InstalledSkill>;
    checkUpdates(): Promise<InstalledSkill[]>;
    prepareUpdate(name: string): Promise<SkillOperationPreview>;
    listVersions(request: SkillVersionListRequest): Promise<SkillVersionList>;
    prepareVersionChange(
      libraryId: string,
      selector: SkillVersionSelector,
    ): Promise<SkillOperationPreview>;
    discardPreview(token: string): Promise<void>;
    rollback(name: string): Promise<InstalledSkill>;
    uninstall(name: string): Promise<RemovedSkill>;
    removed(): Promise<RemovedSkill[]>;
    restore(id: string): Promise<InstalledSkill>;
    readFile(name: string, path: string): Promise<SkillFilePreview>;
    inventory(): Promise<SkillInventory>;
    targets(): Promise<SkillTargetCapability[]>;
    getDetail(request: SkillDetailRequest): Promise<SkillDetail>;
    readDetailFile(request: SkillDetailRequest & { path: string }): Promise<SkillPreviewFile>;
    prepareImport(observationId: string): Promise<SkillOperationPreview>;
    prepareImports(observationIds: string[]): Promise<SkillImportBatchPreview>;
    applyImports(token: string): Promise<SkillImportBatchReport>;
    readPreviewFile(
      token: string,
      path: string,
      targetId?: string,
      itemId?: string,
      comparison?: SkillSyncComparison,
    ): Promise<SkillPreviewFile>;
    listDeployments(): Promise<SkillDeployment[]>;
    prepareDeployment(request: PrepareSkillDeploymentRequest): Promise<SkillDeploymentPreview>;
    applyDeployment(token: string, approveHome: boolean): Promise<SkillDeploymentReport>;
    syncState(): Promise<SkillSyncState>;
    syncPolicy(): Promise<SkillSyncPolicy>;
    prepareSync(request: PrepareSkillSyncRequest): Promise<SkillSyncPreview>;
    applySync(token: string, approveHome: boolean): Promise<SkillSyncReport>;
    saveSyncPolicy(request: SaveSkillSyncPolicyRequest): Promise<SkillSyncPolicy>;
    syncRuns(limit?: number): Promise<SkillSyncRuns>;
    recoverSync(operationId: string, approveHome: boolean): Promise<SkillSyncReport>;
  };
  mcp: {
    previewMigration(request: {
      project: string;
      revision: string;
      candidateIds: string[];
    }): Promise<McpMigrationPreview>;
    applyMigration(request: { token: string; approveHome: boolean }): Promise<McpMigrationResult>;

    managementState(request: { project?: string }): Promise<McpManagementState>;
    saveConfiguration(request: McpSaveRequest): Promise<McpManagementState>;
    removeConfiguration(request: {
      project?: string;
      revision: string;
      id: string;
    }): Promise<McpManagementState>;
    previewImport(request: McpImportRequest): Promise<McpImportPreview>;
    applyImport(request: McpImportApplyRequest): Promise<McpImportReport>;
    checkConnections(request: McpBatchConnectionRequest): Promise<McpBatchConnectionCheck>;
    planConnections(request: McpBatchConnectionRequest): Promise<McpBatchConnectionPlan>;
    applyConnections(request: {
      token: string;
      approveHome: boolean;
    }): Promise<McpBatchConnectionReport>;
    getPolicy(request: { project?: string }): Promise<McpToolPolicySnapshot>;
    savePolicy(request: {
      project?: string;
      revision: string;
      rules: McpToolPolicyRule[];
    }): Promise<McpToolPolicySnapshot>;

    hubStatus(): Promise<McpHubStatus>;
    connectionInfo(workspaceId: string, targetAgent: AgentKind): Promise<McpConnectionInfo>;
    planConnection(workspaceId: string, targetAgent: AgentKind): Promise<ChangeSet>;
    verifyConnection(
      workspaceId: string,
      targetAgent: AgentKind,
    ): Promise<McpConnectionVerification>;
    updateNetwork(settings: unknown): Promise<McpHubStatus>;
    listServers(project?: string): Promise<McpServerConfig[]>;
    getServer(serverId: string, project?: string): Promise<McpServerConfig | undefined>;
    saveServer(server: McpServerConfig, project?: string): Promise<McpServerConfig>;
    saveLocalValues(
      serverId: string,
      env: Record<string, string>,
      headers: Record<string, string>,
      project?: string,
    ): Promise<void>;
    removeServer(serverId: string, project?: string): Promise<void>;
    probeRuntime(serverId: string, project?: string): Promise<McpToolDescriptor[]>;
    startOAuth(serverId: string, project?: string): Promise<McpOAuthStart>;
    runtimes(): Promise<McpRuntimeStatus[]>;
    restartRuntime(serverId: string, project?: string): Promise<McpToolDescriptor[]>;
    stopRuntime(serverId?: string): Promise<void>;
    searchRegistry(query: string): Promise<McpRegistryEntry[]>;
    refreshRegistry(query: string): Promise<McpRegistryEntry[]>;
    install(entry: McpRegistryEntry, project?: string): Promise<McpInstallResult>;
    update(
      installationId: string,
      entry: McpRegistryEntry,
      project?: string,
    ): Promise<McpInstallResult>;
    installations(): Promise<McpInstallation[]>;
    uninstall(installationId: string): Promise<void>;
    scanNative(project?: string): Promise<McpMigrationCandidate[]>;
    planMigration(project: string, candidateIds: string[]): Promise<ChangeSet>;
  };
  insights: {
    heatmap(query: InsightsQuery): Promise<import("../../src/core/types").HeatmapPoint[]>;
    agentUsage(query: InsightsQuery): Promise<AgentUsageBreakdown[]>;
    modelUsage(query: InsightsQuery): Promise<import("../../src/core/types").ModelUsageBreakdown[]>;
    workspaceUsage(
      query: InsightsQuery,
    ): Promise<import("../../src/core/types").WorkspaceUsageBreakdown[]>;
    repositoryCommits(
      query: InsightsQuery,
    ): Promise<import("../../src/core/types").RepositoryCommitBreakdown[]>;
    achievements(): Promise<Achievement[]>;
    gitIdentities(): Promise<GitIdentitySummary[]>;
    addGitIdentityAlias(email: string): Promise<GitIdentitySummary>;
    setGitIdentityEnabled(id: string, enabled: boolean): Promise<void>;
  };
  workspace: {
    cursorBridge(
      request: import("../../src/core/types").CursorBridgeRequest,
    ): Promise<import("../../src/core/types").CursorBridgeResponse>;
    bridgeBundle(): Promise<import("../../src/core/types").CursorBridgeBundle>;
    revealBridgeBundle(): Promise<void>;
    scan(project: string): Promise<WorkspaceScan>;
    prepareManifest(project: string): Promise<Manifest>;
    resolveContext(project: string, cwd: string, agent: AgentKind): Promise<ContextPreview>;
    add(path: string): Promise<WorkspaceSummary>;
    refresh(id: string): Promise<WorkspaceSummary>;
    exclude(id: string): Promise<void>;
    restoreExcluded(path: string): Promise<void>;
    doctorReport(id: string): Promise<ContextDoctorReport>;
    gitSummary(id: string): Promise<GitWorkspaceSummary | undefined>;
    gitHistory(id: string, query: GitHistoryQuery): Promise<GitCommitPage | undefined>;
    gitCommitFiles(id: string, oid: string): Promise<GitFileChange[] | undefined>;
    gitDiff(id: string, request: GitDiffRequest): Promise<GitDiff | undefined>;
    sessions(id: string): Promise<ConversationSessionSummary[]>;
    sessionStatus(id: string): Promise<ConversationIndexStatus[]>;
    refreshSessions(id: string, force?: boolean): Promise<ConversationSessionSummary[]>;
    sessionEvents(id: string, cursor?: string, limit?: number): Promise<ConversationEventPage>;
    sourceCapability(
      sessionId: string,
    ): Promise<import("../../src/core/types").ContinuationCapability>;
    nativeImports(
      workspaceId: string,
    ): Promise<import("../../src/core/types").NativeImportOperation[]>;
    prepareHandoff(request: SessionHandoffRequest): Promise<SessionHandoffPreparation>;
    planMcpConnection(workspaceId: string, targetAgent: AgentKind): Promise<ChangeSet>;
    sanitizeHandoff(format: HandoffFormat, editedContent: string): Promise<string>;
    planHandoff(
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
    ): Promise<PlannedSessionHandoff>;
    continueHandoff(
      changeSet: ChangeSet,
      launchRequest: SessionHandoffLaunchRequest,
      approveHome: boolean,
    ): Promise<HandoffContinuationResult>;
    launchHandoff(launchRequest: SessionHandoffLaunchRequest): Promise<HandoffLaunchReceipt>;
    openers(id: string): Promise<WorkspaceOpener[]>;
    open(id: string, openerId?: string): Promise<void>;
    doctorSummaries(workspaceIds: string[]): Promise<ContextDoctorSummary[]>;
  };
  shell: {
    openDirectory(title?: string): Promise<string | undefined>;
    openExternal(url: string): Promise<void>;
    openFilesAndFoldersSettings(): Promise<void>;
    openQuotaDashboard(request: AppNavigationRequest): Promise<void>;
    hideWindow(): Promise<void>;
    quit(): Promise<void>;
  };
  remote: {
    request<T extends RemoteRequest>(request: T): Promise<RemoteResponse<T>>;
  };
  settings: {
    setCloseBehavior(value?: CloseBehavior): Promise<void>;
    setLocale(preference: LocalePreference): Promise<RuntimeInfo>;
    setThemePreference(preference: "system" | "light" | "dark"): Promise<RuntimeInfo>;
    setAccentThemePreference(preference: AccentThemeId): Promise<RuntimeInfo>;
    setSidebarWidthPreference(preference: number): Promise<RuntimeInfo>;
    setAppIconPreference(preference: AppIconPreference): Promise<RuntimeInfo>;
  };
  home: {
    runtime(): Promise<RuntimeInfo>;
    workspaces(): Promise<WorkspaceSummary[]>;
    agentInstallations(): Promise<AgentInstallation[]>;
    agentTools(force?: boolean): Promise<AgentToolSnapshot>;
    executeAgentTool(agent: AgentKind, actionId: string): Promise<AgentToolExecutionResult>;
    catalogAssets(input: {
      query?: string;
      agent?: AgentKind;
      workspaceId?: string;
      limit?: number;
    }): Promise<CatalogAsset[]>;
    globalMemories(status?: string): Promise<MemoryRecord[]>;
    activity(limit?: number): Promise<ActivityRecord[]>;
    scanRoots(): Promise<ScanRoot[]>;
    addScanRoot(path: string, maxDepth: number): Promise<ScanRoot>;
    removeScanRoot(id: string): Promise<void>;
    refreshDiscovery(force?: boolean): Promise<RefreshReceipt>;
    discoveryReport(): Promise<import("../../src/core/types").DiscoveryReport | undefined>;
    excludedWorkspaces(): Promise<ExcludedWorkspace[]>;
    remoteGateways(): Promise<RemoteGatewaySummary[]>;
    refreshGateways(force?: boolean): Promise<RefreshReceipt>;
    saveRemoteGateway(input: RemoteGatewayInput): Promise<RemoteGatewaySummary>;
    refreshRemoteGateway(id: string): Promise<RemoteGatewaySummary>;
    removeRemoteGateway(id: string): Promise<void>;
    insightsView(query: InsightsQuery): Promise<InsightsView>;
    refreshInsights(force?: boolean): Promise<RefreshReceipt>;
    insightsSummary(query: InsightsQuery): Promise<InsightsSummary>;
    insightsStatus(): Promise<InsightsStatus>;
    quotaCollectorStatus(): Promise<QuotaCollectorStatus>;
    quotaSnapshot(): Promise<QuotaSnapshot | undefined>;
    quotaPreferences(): Promise<QuotaPopoverPreferences>;
    setQuotaPreferences(preferences: QuotaPopoverPreferences): Promise<QuotaPopoverPreferences>;
    refreshQuota(force?: boolean): Promise<RefreshReceipt>;
    setLocalAutoRefresh(enabled: boolean): Promise<RuntimeInfo>;
    setQuotaAutoRefresh(enabled: boolean): Promise<RuntimeInfo>;
    setQuotaPromptSeen(seen: boolean): Promise<RuntimeInfo>;
    refreshStatus(): Promise<RefreshJobStatus[]>;
    storageOverview(): Promise<StorageOverview>;
    storageChildren(workspaceId: string, relativePath: string): Promise<StorageNode>;
    refreshStorage(force?: boolean): Promise<RefreshReceipt>;
    openStoragePath(workspaceId: string, relativePath: string): Promise<void>;
    cancelStorage(): Promise<boolean>;
    updateOnboarding(event: OnboardingEvent): Promise<RuntimeInfo>;
    obsidianIntegration(): Promise<ObsidianIntegration>;
    addObsidianVault(path: string): Promise<ObsidianIntegration>;
    linkWorkspaceToObsidian(
      workspaceId: string,
      vaultPath: string,
      relativeTarget?: string,
    ): Promise<ObsidianWorkspaceLink>;
    unlinkWorkspaceFromObsidian(workspaceId: string): Promise<void>;
    openObsidian(): Promise<void>;
    openWorkspaceInObsidian(workspaceId: string): Promise<void>;
  };
}
