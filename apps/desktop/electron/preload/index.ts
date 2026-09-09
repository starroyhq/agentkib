import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, DesktopRuntimeStatus } from "../api";
import type {
  AppMenuCommandRequest,
  AppNavigationRequest,
  AppUpdateProgress,
  QuotaSnapshot,
  RefreshJobStatus,
} from "../../src/core/types";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const ipcListener = (_event: Electron.IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, ipcListener);
  return () => ipcRenderer.removeListener(channel, ipcListener);
}

const desktopApi = Object.freeze({
  platform: process.platform,
  events: Object.freeze({
    onWindowActivity: (listener: (active: boolean) => void) =>
      subscribe("agentkib:window-activity", listener),
    onQuitRequested: (listener: () => void) =>
      subscribe("agentkib:quit-requested", () => listener()),
    onThemeChanged: (listener: (theme: "light" | "dark") => void) =>
      subscribe("agentkib:theme-changed", listener),
    onRefreshState: (listener: (status: RefreshJobStatus) => void) =>
      subscribe("agentkib:electron-refresh-state", listener),
    onQuotaUpdated: (listener: (snapshot: QuotaSnapshot) => void) =>
      subscribe("agentkib:quota-updated", listener),
    onNavigate: (listener: (request: AppNavigationRequest) => void) =>
      subscribe("agentkib:navigate", listener),
    onMenuCommand: (listener: (request: AppMenuCommandRequest) => void) =>
      subscribe("agentkib:app-command", listener),
    onRuntimeStatus: (listener: (status: DesktopRuntimeStatus) => void) =>
      subscribe("agentkib:runtime:status", listener),
  }),
  runtime: Object.freeze({
    handshake: () => ipcRenderer.invoke("agentkib:runtime:handshake"),
    status: () => ipcRenderer.invoke("agentkib:runtime:status"),
    retry: () => ipcRenderer.invoke("agentkib:runtime:retry"),
  }),
  benchmark: Object.freeze({
    mark: (name: "renderer-first-commit" | "home-data-ready" | "home-data-failed") =>
      ipcRenderer.invoke("agentkib:benchmark:mark", name),
  }),
  updates: Object.freeze({
    check: () => ipcRenderer.invoke("agentkib:updates:check"),
    install: (version: string, onEvent: (event: AppUpdateProgress) => void) => {
      const channel = "agentkib:updates:progress";
      const listener = (_event: Electron.IpcRendererEvent, value: AppUpdateProgress) =>
        onEvent(value);
      ipcRenderer.on(channel, listener);
      return ipcRenderer.invoke("agentkib:updates:install", version).finally(() => {
        ipcRenderer.removeListener(channel, listener);
      });
    },
  }),
  changes: Object.freeze({
    plan: (project: string, manifest: unknown, includeHome: boolean) =>
      ipcRenderer.invoke("agentkib:changes:plan", project, manifest, includeHome),
    apply: (changeSet: unknown, approveHome: boolean) =>
      ipcRenderer.invoke("agentkib:changes:apply", changeSet, approveHome),
  }),
  memories: Object.freeze({
    list: (project: string, status?: string) =>
      ipcRenderer.invoke("agentkib:memories:list", project, status),
    search: (project: string, query: string, limit?: number) =>
      ipcRenderer.invoke("agentkib:memories:search", project, query, limit),
    propose: (project: string, proposal: unknown) =>
      ipcRenderer.invoke("agentkib:memories:propose", project, proposal),
    review: (id: string, status: string, editedContent?: string) =>
      ipcRenderer.invoke("agentkib:memories:review", id, status, editedContent),
  }),
  sessions: Object.freeze({
    clearIndex: (workspaceId?: string) =>
      ipcRenderer.invoke("agentkib:sessions:clear-index", workspaceId),
    setIndexEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("agentkib:sessions:set-index-enabled", enabled),
  }),
  skills: Object.freeze({
    catalog: (force = false) => ipcRenderer.invoke("agentkib:skills:catalog", force),
    discover: (url: string) => ipcRenderer.invoke("agentkib:skills:discover", url),
    installed: () => ipcRenderer.invoke("agentkib:skills:installed"),
    prepareInstall: (source: unknown) =>
      ipcRenderer.invoke("agentkib:skills:prepare-install", source),
    applyOperation: (token: string, allowModified = false) =>
      ipcRenderer.invoke("agentkib:skills:apply-operation", token, allowModified),
    checkUpdates: () => ipcRenderer.invoke("agentkib:skills:check-updates"),
    prepareUpdate: (name: string) => ipcRenderer.invoke("agentkib:skills:prepare-update", name),
    rollback: (name: string) => ipcRenderer.invoke("agentkib:skills:rollback", name),
    uninstall: (name: string) => ipcRenderer.invoke("agentkib:skills:uninstall", name),
    removed: () => ipcRenderer.invoke("agentkib:skills:removed"),
    restore: (id: string) => ipcRenderer.invoke("agentkib:skills:restore", id),
    readFile: (name: string, path: string) =>
      ipcRenderer.invoke("agentkib:skills:read-file", name, path),
  }),
  mcp: Object.freeze({
    hubStatus: () => ipcRenderer.invoke("agentkib:mcp:hub-status"),
    updateNetwork: (settings: unknown) =>
      ipcRenderer.invoke("agentkib:mcp:update-network", settings),
    listServers: (project?: string) => ipcRenderer.invoke("agentkib:mcp:list-servers", project),
    getServer: (serverId: string, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:get-server", serverId, project),
    saveServer: (server: unknown, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:save-server", server, project),
    saveLocalValues: (
      serverId: string,
      env: Record<string, string>,
      headers: Record<string, string>,
      project?: string,
    ) => ipcRenderer.invoke("agentkib:mcp:save-local-values", serverId, env, headers, project),
    removeServer: (serverId: string, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:remove-server", serverId, project),
    probeRuntime: (serverId: string, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:probe-runtime", serverId, project),
    startOAuth: (serverId: string, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:start-oauth", serverId, project),
    runtimes: () => ipcRenderer.invoke("agentkib:mcp:list-runtimes"),
    restartRuntime: (serverId: string, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:restart-runtime", serverId, project),
    stopRuntime: (serverId?: string) => ipcRenderer.invoke("agentkib:mcp:stop-runtime", serverId),
    searchRegistry: (query: string) => ipcRenderer.invoke("agentkib:mcp:search-registry", query),
    refreshRegistry: (query: string) => ipcRenderer.invoke("agentkib:mcp:refresh-registry", query),
    install: (entry: unknown, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:install", entry, project),
    update: (installationId: string, entry: unknown, project?: string) =>
      ipcRenderer.invoke("agentkib:mcp:update", installationId, entry, project),
    installations: () => ipcRenderer.invoke("agentkib:mcp:list-installations"),
    uninstall: (installationId: string) =>
      ipcRenderer.invoke("agentkib:mcp:uninstall", installationId),
    scanNative: (project?: string) => ipcRenderer.invoke("agentkib:mcp:scan-native", project),
    planMigration: (project: string, candidateIds: string[]) =>
      ipcRenderer.invoke("agentkib:mcp:plan-migration", project, candidateIds),
  }),
  insights: Object.freeze({
    heatmap: (query: unknown) => ipcRenderer.invoke("agentkib:insights:heatmap", query),
    agentUsage: (query: unknown) => ipcRenderer.invoke("agentkib:insights:agent-usage", query),
    modelUsage: (query: unknown) => ipcRenderer.invoke("agentkib:insights:model-usage", query),
    workspaceUsage: (query: unknown) =>
      ipcRenderer.invoke("agentkib:insights:workspace-usage", query),
    repositoryCommits: (query: unknown) =>
      ipcRenderer.invoke("agentkib:insights:repository-commits", query),
    achievements: () => ipcRenderer.invoke("agentkib:insights:achievements"),
    gitIdentities: () => ipcRenderer.invoke("agentkib:insights:git-identities"),
    addGitIdentityAlias: (email: string) =>
      ipcRenderer.invoke("agentkib:insights:add-git-identity-alias", email),
    setGitIdentityEnabled: (id: string, enabled: boolean) =>
      ipcRenderer.invoke("agentkib:insights:set-git-identity-enabled", id, enabled),
  }),
  workspace: Object.freeze({
    scan: (project: string) => ipcRenderer.invoke("agentkib:workspace:scan", project),
    prepareManifest: (project: string) =>
      ipcRenderer.invoke("agentkib:workspace:prepare-manifest", project),
    resolveContext: (project: string, cwd: string, agent: string) =>
      ipcRenderer.invoke("agentkib:workspace:resolve-context", project, cwd, agent),
    add: (path: string) => ipcRenderer.invoke("agentkib:workspace:add", path),
    refresh: (id: string) => ipcRenderer.invoke("agentkib:workspace:refresh", id),
    exclude: (id: string) => ipcRenderer.invoke("agentkib:workspace:exclude", id),
    restoreExcluded: (path: string) =>
      ipcRenderer.invoke("agentkib:workspace:restore-excluded", path),
    doctorReport: (id: string) => ipcRenderer.invoke("agentkib:workspace:doctor-report", id),
    gitSummary: (id: string) => ipcRenderer.invoke("agentkib:workspace:git-summary", id),
    gitHistory: (id: string, query: unknown) =>
      ipcRenderer.invoke("agentkib:workspace:git-history", id, query),
    gitCommitFiles: (id: string, oid: string) =>
      ipcRenderer.invoke("agentkib:workspace:git-commit-files", id, oid),
    gitDiff: (id: string, request: unknown) =>
      ipcRenderer.invoke("agentkib:workspace:git-diff", id, request),
    sessions: (id: string) => ipcRenderer.invoke("agentkib:workspace:sessions", id),
    sessionStatus: (id: string) => ipcRenderer.invoke("agentkib:workspace:session-status", id),
    refreshSessions: (id: string, force?: boolean) =>
      ipcRenderer.invoke("agentkib:workspace:refresh-sessions", id, force),
    sessionEvents: (id: string, cursor?: string, limit?: number) =>
      ipcRenderer.invoke("agentkib:session:events", id, cursor, limit),
    prepareHandoff: (request: unknown) =>
      ipcRenderer.invoke("agentkib:session:prepare-handoff", request),
    planMcpConnection: (workspaceId: string, targetAgent: string) =>
      ipcRenderer.invoke("agentkib:session:plan-mcp-connection", workspaceId, targetAgent),
    sanitizeHandoff: (format: string, editedContent: string) =>
      ipcRenderer.invoke("agentkib:session:sanitize-handoff", format, editedContent),
    planHandoff: (
      sessionId: string,
      workspaceId: string,
      filename: string,
      format: string,
      editedContent: string | undefined,
      targetAgent: string,
      mode: string,
      sourceFingerprint: string,
      acceptLosses: boolean,
      historyBudgetTokens: number,
      archiveId: string | undefined,
    ) =>
      ipcRenderer.invoke(
        "agentkib:session:plan-handoff",
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
      ),
    continueHandoff: (changeSet: unknown, launchRequest: unknown, approveHome: boolean) =>
      ipcRenderer.invoke(
        "agentkib:session:continue-handoff",
        changeSet,
        launchRequest,
        approveHome,
      ),
    launchHandoff: (launchRequest: unknown) =>
      ipcRenderer.invoke("agentkib:session:launch-handoff", launchRequest),
    openers: (id: string) => ipcRenderer.invoke("agentkib:workspace:openers", id),
    open: (id: string, openerId?: string) =>
      ipcRenderer.invoke("agentkib:workspace:open", id, openerId),
    doctorSummaries: (workspaceIds: string[]) =>
      ipcRenderer.invoke("agentkib:workspace:doctor-summaries", workspaceIds),
  }),
  shell: Object.freeze({
    openDirectory: (title?: string) => ipcRenderer.invoke("agentkib:shell:open-directory", title),
    openExternal: (url: string) => ipcRenderer.invoke("agentkib:shell:open-external", url),
    openFilesAndFoldersSettings: () =>
      ipcRenderer.invoke("agentkib:shell:open-files-and-folders-settings"),
    openQuotaDashboard: (request: unknown) =>
      ipcRenderer.invoke("agentkib:shell:open-quota-dashboard", request),
    hideWindow: () => ipcRenderer.invoke("agentkib:shell:hide-window"),
    quit: () => ipcRenderer.invoke("agentkib:shell:quit"),
  }),
  remote: Object.freeze({
    request: (request: unknown) => ipcRenderer.invoke("agentkib:remote:request", request),
  }),
  web: Object.freeze({
    request: (request: unknown) => ipcRenderer.invoke("agentkib:web:request", request),
  }),
  settings: Object.freeze({
    setCloseBehavior: (value: unknown) =>
      ipcRenderer.invoke("agentkib:settings:set-close-behavior", value),
    setLocale: (preference: string) =>
      ipcRenderer.invoke("agentkib:settings:set-locale", preference),
    setThemePreference: (preference: string) =>
      ipcRenderer.invoke("agentkib:settings:set-theme", preference),
    setAccentThemePreference: (preference: string) =>
      ipcRenderer.invoke("agentkib:settings:set-accent-theme", preference),
    setSidebarWidthPreference: (preference: number) =>
      ipcRenderer.invoke("agentkib:settings:set-sidebar-width", preference),
    setAppIconPreference: (preference: string) =>
      ipcRenderer.invoke("agentkib:settings:set-app-icon", preference),
  }),
  home: Object.freeze({
    runtime: () => ipcRenderer.invoke("agentkib:home:runtime"),
    workspaces: () => ipcRenderer.invoke("agentkib:home:workspaces"),
    agentInstallations: () => ipcRenderer.invoke("agentkib:home:agent-installations"),
    agentTools: (force?: boolean) => ipcRenderer.invoke("agentkib:home:agent-tools", force),
    executeAgentTool: (agent: string, actionId: string) =>
      ipcRenderer.invoke("agentkib:home:execute-agent-tool", agent, actionId),
    catalogAssets: (input: unknown) => ipcRenderer.invoke("agentkib:home:catalog-assets", input),
    globalMemories: (status?: string) =>
      ipcRenderer.invoke("agentkib:home:global-memories", status),
    activity: (limit?: number) => ipcRenderer.invoke("agentkib:home:activity", limit),
    scanRoots: () => ipcRenderer.invoke("agentkib:home:scan-roots"),
    addScanRoot: (path: string, maxDepth: number) =>
      ipcRenderer.invoke("agentkib:home:add-scan-root", path, maxDepth),
    removeScanRoot: (id: string) => ipcRenderer.invoke("agentkib:home:remove-scan-root", id),
    refreshDiscovery: (force?: boolean) =>
      ipcRenderer.invoke("agentkib:home:refresh-discovery", force),
    discoveryReport: () => ipcRenderer.invoke("agentkib:home:discovery-report"),
    excludedWorkspaces: () => ipcRenderer.invoke("agentkib:home:excluded-workspaces"),
    remoteGateways: () => ipcRenderer.invoke("agentkib:home:remote-gateways"),
    refreshGateways: (force?: boolean) =>
      ipcRenderer.invoke("agentkib:home:refresh-gateways", force),
    saveRemoteGateway: (input: unknown) =>
      ipcRenderer.invoke("agentkib:home:save-remote-gateway", input),
    refreshRemoteGateway: (id: string) =>
      ipcRenderer.invoke("agentkib:home:refresh-remote-gateway", id),
    removeRemoteGateway: (id: string) =>
      ipcRenderer.invoke("agentkib:home:remove-remote-gateway", id),
    insightsView: (query: unknown) => ipcRenderer.invoke("agentkib:home:insights-view", query),
    refreshInsights: (force?: boolean) =>
      ipcRenderer.invoke("agentkib:home:refresh-insights", force),
    insightsSummary: (query: unknown) =>
      ipcRenderer.invoke("agentkib:home:insights-summary", query),
    insightsStatus: () => ipcRenderer.invoke("agentkib:home:insights-status"),
    quotaCollectorStatus: () => ipcRenderer.invoke("agentkib:home:quota-collector-status"),
    quotaSnapshot: () => ipcRenderer.invoke("agentkib:home:quota-snapshot"),
    quotaPreferences: () => ipcRenderer.invoke("agentkib:home:quota-preferences"),
    setQuotaPreferences: (preferences: unknown) =>
      ipcRenderer.invoke("agentkib:home:set-quota-preferences", preferences),
    refreshQuota: (force?: boolean) => ipcRenderer.invoke("agentkib:home:refresh-quota", force),
    setLocalAutoRefresh: (enabled: boolean) =>
      ipcRenderer.invoke("agentkib:home:set-local-auto-refresh", enabled),
    setQuotaAutoRefresh: (enabled: boolean) =>
      ipcRenderer.invoke("agentkib:home:set-quota-auto-refresh", enabled),
    setQuotaPromptSeen: (seen: boolean) =>
      ipcRenderer.invoke("agentkib:home:set-quota-prompt-seen", seen),
    refreshStatus: () => ipcRenderer.invoke("agentkib:home:refresh-status"),
    storageOverview: () => ipcRenderer.invoke("agentkib:home:storage-overview"),
    storageChildren: (workspaceId: string, relativePath: string) =>
      ipcRenderer.invoke("agentkib:home:storage-children", workspaceId, relativePath),
    refreshStorage: (force?: boolean) => ipcRenderer.invoke("agentkib:home:refresh-storage", force),
    openStoragePath: (workspaceId: string, relativePath: string) =>
      ipcRenderer.invoke("agentkib:home:open-storage-path", workspaceId, relativePath),
    cancelStorage: () => ipcRenderer.invoke("agentkib:home:cancel-storage"),
    updateOnboarding: (event: unknown) =>
      ipcRenderer.invoke("agentkib:home:update-onboarding", event),
    obsidianIntegration: () => ipcRenderer.invoke("agentkib:home:obsidian-integration"),
    addObsidianVault: (path: string) =>
      ipcRenderer.invoke("agentkib:home:add-obsidian-vault", path),
    linkWorkspaceToObsidian: (workspaceId: string, vaultPath: string, relativeTarget?: string) =>
      ipcRenderer.invoke(
        "agentkib:home:link-obsidian-workspace",
        workspaceId,
        vaultPath,
        relativeTarget,
      ),
    unlinkWorkspaceFromObsidian: (workspaceId: string) =>
      ipcRenderer.invoke("agentkib:home:unlink-obsidian-workspace", workspaceId),
    openObsidian: () => ipcRenderer.invoke("agentkib:home:open-obsidian"),
    openWorkspaceInObsidian: (workspaceId: string) =>
      ipcRenderer.invoke("agentkib:home:open-obsidian-workspace", workspaceId),
  }),
}) satisfies DesktopApi;

contextBridge.exposeInMainWorld("agentkibDesktop", desktopApi);
