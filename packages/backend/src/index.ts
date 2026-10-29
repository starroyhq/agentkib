import { Context } from "./context";
import { SessionReaders } from "./session-readers";
import {
  continueCursorNativeImport,
  CursorImportOutcomeUnknownError,
  reconcileCursorNativeImport,
} from "./cursor-native-import";
import { CursorBridge } from "./cursor-bridge";
import { ClaudeBridge } from "./claude-bridge";
import { listNativeImports } from "./session-native-imports";
import {
  continueNativeImport,
  reconcileNativeImport,
  NativeImportOutcomeUnknownError,
  validateNativeImportApplicationData,
} from "./session-native-import-owner";
import { handoffFormat, sanitizeHandoffExport } from "./session-handoff";
import { prepareSessionHandoff } from "./session-continuation";
import { planSessionHandoff } from "./session-handoff-plan";
import { applySessionHandoff } from "./session-handoff-apply";
import { launchPreparedHandoff, prepareHandoffLaunch } from "./session-handoff-launch";
import { SessionIndex } from "./session-index";
import { catalogCheckouts } from "./git-checkouts";
import { HistorySearch } from "./history-search";
import { InsightRefresh } from "./insight-refresh";
import { ObsidianIntegration } from "./obsidian";
import { SkillsWorker } from "./skills-worker";
import { BoundedTaskQueue, BackendTaskError, commitTask } from "./task-executor";
import { HandoffWork } from "./handoff-work";
import { AgentTools } from "./agent-tools";
import { McpManagement } from "./mcp-management";
import { McpConnectionBatch } from "./mcp-connection-batch";
import { McpManager } from "./mcp";
import { McpBuiltins } from "./mcp-builtin";
import { McpHub, type McpNetworkSettings } from "./mcp-hub";
import { McpOAuth } from "./mcp-oauth";
import { planSessionMcpConnection } from "./mcp-continuation";
import { mcpConnectionInfo, planMcpConnection, verifyMcpConnection } from "./mcp-connection";
import { markPossiblyOverwritten } from "./claude-global-writes";
import { scanNativeMcp } from "./mcp-native-scan";
import { planNativeMcpMigration } from "./mcp-migration-plan";
import { webDiff } from "./web-diff";
import type { WebReadRequests } from "./web-read";
import { RemoteGateways } from "./remote-gateways";
import { RemoteAgent } from "./remote-agent";
import { WorkspaceStorageOwner } from "./storage";
import { QuotaOwner } from "./quota";
import { ClaudeHostControlPreflightError, ClaudeManagedReadOwner } from "./claude-managed-read";
import { createRelayCsr } from "./relay-csr";
import { readControlReceipt } from "./control-receipt";
import { WorkspaceApplications } from "./workspace-applications";
import { nativeContext } from "./native-context";
import { discoverScanRoots } from "./discovery-scan-roots";
import { discoverConfiguredWorkspaces } from "./native-discovery-configured";
import { Doctor } from "./doctor";
import { planWorkspace, ensureGateway } from "./change-plan";
import { manifestSchema } from "./manifest";
import { userHome } from "./mcp-config-read";
import { applyRequest } from "./changes";
import { TYPESCRIPT_SESSION_READ_METHODS } from "./migration";
import { TYPESCRIPT_INSIGHT_METHODS, TYPESCRIPT_MCP_METHODS } from "./migration";
import { scanWorkspace, inspectWorkspace } from "./asset-scanner";
import { defaultManifest, prepareManifest } from "./default-manifest";
import { InstructionImports } from "./instruction-adoption";
import { parameters } from "./rpc";
import { z } from "zod";
import { BACKEND_INSPECT } from "./migration";
import { RpcFault } from "./rpc";
import { Commands } from "./commands";
import { Git } from "./git";
import { TYPESCRIPT_GIT_METHODS, TYPESCRIPT_CATALOG_METHODS } from "./migration";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  HISTORY_SEARCH_METHODS,
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  type RuntimeRpcError,
  type SessionStreamEvent,
} from "@agentkib/runtime-protocol";
import { SessionStreamHub } from "./session-stream";
import { SessionSnapshotHistory } from "./session-snapshot-history";
import { BackendStore } from "./store";
import { canonicalize } from "./paths";
import {
  preferenceSnapshot,
  writePreference,
  writePreferences,
  readPreferences,
  readOnboarding,
  parseQuotaPreferences,
  normalizeQuotaPreferences,
} from "./preferences";
import {
  refreshReceipt,
  type NativeContext,
  type WorkspacePlan,
  type WorkspaceInspection,
  type DiscoverySnapshot,
  type DiscoveryPlan,
  type InspectedWorkspace,
} from "./workspaces";

import {
  BACKEND_INITIALIZE,
  BACKEND_PREFERENCES,
  NATIVE_CONTEXT,
  NATIVE_SCAN_ROOT_DISCOVERY,
  NATIVE_CONFIGURED_DISCOVERY,
  BACKEND_PLAN_WORKSPACE,
  BACKEND_PLAN_DISCOVERY,
  BACKEND_DEFAULT_MANIFEST,
  BACKEND_PLAN_PROJECT_ASSETS,
} from "./migration";

const HANDOFF_TASK_METHODS = new Set<string>([
  RUNTIME_METHODS.prepareSessionHandoff,
  RUNTIME_METHODS.planSessionHandoff,
  RUNTIME_METHODS.continueSessionHandoff,
  RUNTIME_METHODS.launchSessionHandoff,
]);

export class TypeScriptBackend {
  #instructionImports = new InstructionImports();
  #store?: BackendStore;
  #dataDir?: string;
  #commands = new Commands();
  #git?: Git;
  #context?: Context;
  #doctor?: Doctor;
  #sessions?: SessionReaders;
  #sessionStream?: SessionStreamHub;
  #snapshotHistory?: SessionSnapshotHistory;
  #cursorBridge?: CursorBridge;
  #claudeBridge?: ClaudeBridge;
  #catalogContinuation = new Map<string, string>();
  #webRead?: WebReadRequests;
  #sessionIndex?: SessionIndex;
  #historySearch?: HistorySearch;
  #insightRefresh?: InsightRefresh;
  #obsidian?: ObsidianIntegration;
  #skills?: SkillsWorker;
  #handoffQueue = new BoundedTaskQueue({ name: "Session handoff" });
  #handoffWork = new HandoffWork();
  #stopping = false;
  #agentTools?: AgentTools;
  #mcp?: McpManager;
  #mcpManagement?: McpManagement;
  #mcpConnections?: McpConnectionBatch;
  #mcpHub?: McpHub;
  #mcpOAuth?: McpOAuth;
  #remoteGateways?: RemoteGateways;
  #remoteAgent?: RemoteAgent;
  #storage?: WorkspaceStorageOwner;
  #quota?: QuotaOwner;
  #claudeManaged?: ClaudeManagedReadOwner;
  #workspaceApplications?: WorkspaceApplications;
  #closing?: Promise<void>;

  constructor(
    readonly environment: NodeJS.ProcessEnv = process.env,
    readonly notify: (method: string, params: unknown) => void = () => {},
  ) {}

  /** Cancel producers before draining RPC requests; keep their stores open until they settle. */
  cancelPendingOperations(): void {
    this.#stopping = true;
    this.#skills?.stop();
    this.#historySearch?.stop();
    this.#handoffQueue.stop();
    this.#storage?.cancel();
    this.#sessionIndex?.close();
    this.#commands.close();
    this.#mcp?.close();
  }

  close(): Promise<void> {
    return this.closeAsync();
  }

  #reset(): void {
    this.#instructionImports.clear();
    this.#sessionStream?.close();
    this.#sessionStream = undefined;
    this.#snapshotHistory?.invalidate();
    this.#snapshotHistory = undefined;
    this.#storage?.cancel();
    this.#storage = undefined;
    this.#quota = undefined;
    this.#claudeManaged?.close();
    void this.#claudeBridge?.close();
    this.#claudeBridge = undefined;
    this.#claudeManaged = undefined;
    this.#sessionIndex?.close();
    this.#sessionIndex = undefined;
    this.#historySearch = undefined;
    this.#insightRefresh = undefined;
    this.#obsidian = undefined;
    this.#skills = undefined;
    this.#agentTools = undefined;
    this.#mcp?.close();
    this.#mcp = undefined;
    this.#mcpManagement = undefined;
    this.#mcpConnections = undefined;
    this.#mcpHub = undefined;
    this.#mcpOAuth = undefined;
    this.#remoteGateways = undefined;
    this.#remoteAgent = undefined;
    this.#sessions?.close();
    this.#sessions = undefined;
    this.#cursorBridge?.close();
    this.#cursorBridge = undefined;
    this.#webRead = undefined;
    this.#commands.close();
    this.#git = undefined;
    this.#context = undefined;
    this.#doctor = undefined;
    this.#store?.close();
    this.#store = undefined;
    this.#dataDir = undefined;
  }

  closeAsync(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.cancelPendingOperations();
    const claudeManaged = this.#claudeManaged;
    const claudeBridge = this.#claudeBridge;
    const mcp = this.#mcp;
    const mcpHub = this.#mcpHub;
    const remoteAgent = this.#remoteAgent;
    const webRead = this.#webRead;
    this.#claudeManaged = undefined;
    this.#claudeBridge = undefined;
    this.#mcpHub = undefined;
    this.#remoteAgent = undefined;
    const closing = (async () => {
      const results = await Promise.allSettled([
        this.#skills?.close(),
        this.#historySearch?.close(),
        this.#handoffQueue.drain().then(() => this.#handoffWork.close()),
        Promise.resolve().then(() => mcp?.closeAsync()),
        Promise.resolve().then(() => claudeManaged?.shutdown()),
        Promise.resolve().then(() => claudeBridge?.close()),
        Promise.resolve().then(() => mcpHub?.close()),
        Promise.resolve().then(() => remoteAgent?.close()),
        // Native CLI processes must release their workspace before shutdown is
        // acknowledged and the backing stores (or temporary workspace) close.
        Promise.resolve().then(() => webRead?.closeAsync()),
      ]);
      this.#reset();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    this.#closing = closing;
    void closing
      .finally(() => {
        if (this.#closing === closing) this.#closing = undefined;
      })
      .catch(() => undefined);
    return closing;
  }

  handle(value: unknown): {
    jsonrpc: "2.0";
    id: unknown;
    result?: unknown;
    error?: RuntimeRpcError;
  } {
    const id = typeof value === "object" && value !== null && "id" in value ? value.id : null;
    try {
      if (
        typeof value !== "object" ||
        value === null ||
        !("jsonrpc" in value) ||
        value.jsonrpc !== "2.0" ||
        !("method" in value) ||
        typeof value.method !== "string"
      ) {
        throw new RpcFault(-32600, "Invalid JSON-RPC request");
      }
      const params = object("params" in value ? value.params : {});
      return { jsonrpc: "2.0", id, result: this.#request(value.method, params) };
    } catch (error) {
      return this.#failure(id, error);
    }
  }

  async handleAsync(value: unknown): Promise<ReturnType<TypeScriptBackend["handle"]>> {
    const response = this.handle(value);
    if (response.error) return response;
    try {
      return { ...response, result: await response.result };
    } catch (error) {
      return this.#failure(response.id, error);
    }
  }

  #failure(id: unknown, error: unknown) {
    const fault =
      error instanceof RpcFault
        ? error
        : new RpcFault(-32000, "AgentKib command failed", {
            detail: error instanceof Error ? error.message : "Backend operation failed",
          });
    return {
      jsonrpc: "2.0" as const,
      id,
      error: {
        code: fault.code,
        message: fault.message,
        ...(fault.data === undefined ? {} : { data: fault.data }),
      },
    };
  }

  #request(method: string, params: Record<string, unknown>): unknown {
    if (method === RUNTIME_METHODS.handshake) {
      const client = object(params.client);
      if (
        !Number.isInteger(params.protocolVersion) ||
        typeof client.name !== "string" ||
        typeof client.version !== "string"
      )
        throw new RpcFault(-32602, "Invalid handshake parameters");
      if (params.protocolVersion !== PROTOCOL_VERSION)
        throw new RpcFault(-32001, "Incompatible protocol version", {
          expected: PROTOCOL_VERSION,
          received: params.protocolVersion,
          client,
        });
      return {
        protocolVersion: PROTOCOL_VERSION,
        runtime: {
          name: "agentkib-typescript",
          version: this.environment.AGENTKIB_APP_VERSION ?? "0.13.0",
        },
        pid: process.pid,
        capabilities: [
          "shared-schema-15",
          "preferences",
          "cached-workspace-reads",
          "workspace-writes",
          "discovery-persistence",
          "native-assets",
          "manifest-import",
          "context-preview",
          "context-doctor",
          "changesets",
          "catalog",
          "memory",
          "git",
          "insight-reads",
          "session-cache",
          "session-events",
          "session-index",
          "skills",
          "agent-tools",
          "obsidian",
          "mcp",
          "remote-gateways",
          "workspace-storage",
          "quota-collection",
        ],
      };
    }
    if (method === RUNTIME_METHODS.shutdown) {
      return this.closeAsync().then(() => null);
    }
    if (method === NATIVE_SCAN_ROOT_DISCOVERY)
      return discoverScanRoots(params.roots, this.environment);
    if (method === NATIVE_CONFIGURED_DISCOVERY)
      return discoverConfiguredWorkspaces(this.environment);
    if (method === BACKEND_INITIALIZE) {
      if (typeof params.dataDir !== "string" || !path.isAbsolute(params.dataDir))
        invalid("Backend data directory must be absolute");
      const dataDir = params.dataDir as string;
      return this.closeAsync().then(() => {
        const store = new BackendStore(path.join(dataDir, "agentkib.db"));
        this.#commands = new Commands();
        this.#handoffQueue = new BoundedTaskQueue({ name: "Session handoff" });
        this.#handoffWork = new HandoffWork();
        this.#store = store;
        this.#dataDir = dataDir;
        this.#cursorBridge = new CursorBridge(dataDir, store);
        this.#cursorBridge.initialize();
        this.#storage = new WorkspaceStorageOwner({
          listWorkspaces: () => store.listWorkspaces(),
          workspaceStorageOverview: () => store.workspaceStorageOverview(),
          saveWorkspaceStorage: (value) => store.saveWorkspaceStorage(value),
          recordWorkspaceStorageFailure: (id, at, key, detail) =>
            store.recordWorkspaceStorageFailure(id, at, key, detail),
          getWorkspace: (id) => store.getWorkspace(id),
        });
        this.#quota = new QuotaOwner(store, this.#commands, dataDir, {
          ...process.env,
          ...this.environment,
        });
        this.#git = new Git(this.#commands, (id) => store.workspacePath(id), {
          ...process.env,
          ...this.environment,
        });
        this.#insightRefresh = new InsightRefresh(
          store.sql,
          this.#commands,
          this.#git,
          { ...process.env, ...this.environment },
          () => store.insights.achievements(),
        );
        this.#obsidian = new ObsidianIntegration(dataDir);
        this.#skills = new SkillsWorker({ ...process.env, ...this.environment }, dataDir, () =>
          store.listWorkspaces(),
        );
        this.#agentTools = new AgentTools(dataDir);
        this.#mcp = new McpManager(
          store.sql,
          { ...process.env, ...this.environment },
          dataDir,
          this.#commands,
        );
        this.#context = new Context(store.catalog, this.#commands, {
          ...process.env,
          ...this.environment,
        });
        const storedNetwork = readPreferences(dataDir).mcp_network;
        const validNetwork = z
          .object({
            port: z.number().int().min(1).max(65535),
            lan_enabled: z.boolean(),
            lan_risk_accepted: z.boolean(),
          })
          .safeParse(storedNetwork);
        const network: McpNetworkSettings = validNetwork.success
          ? validNetwork.data
          : {
              port: this.environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? 47654 : 47653,
              lan_enabled: false,
              lan_risk_accepted: false,
            };
        this.#mcp.setNetwork(network);
        this.#mcpOAuth = new McpOAuth(this.#mcp, () => this.#mcpHub?.status().port ?? network.port);
        this.#mcpHub = new McpHub(
          this.#mcp,
          store,
          new McpBuiltins(store, this.#context, dataDir),
          this.#mcpOAuth,
          network,
        );
        this.#mcpManagement = new McpManagement(
          store,
          { ...process.env, ...this.environment },
          dataDir,
          this.#mcp,
        );
        this.#mcpConnections = new McpConnectionBatch(
          store,
          dataDir,
          { ...process.env, ...this.environment },
          () => this.#mcpHub!.status(),
        );
        this.#remoteGateways = new RemoteGateways(dataDir);
        this.#doctor = new Doctor(this.#context, (id) => store.workspacePath(id));
        this.#workspaceApplications = new WorkspaceApplications(
          dataDir,
          this.#commands,
          { ...process.env, ...this.environment },
          (id) => store.workspacePath(id),
        );
        this.#sessions = new SessionReaders(
          store.sessions,
          this.#commands,
          {
            ...process.env,
            ...this.environment,
          },
          this.#cursorBridge,
        );
        this.#claudeManaged = new ClaudeManagedReadOwner(
          store,
          this.#sessions,
          this.#commands,
          dataDir,
          { ...process.env, ...this.environment },
          undefined,
          {
            publish: (sessionId, type, payload, live) =>
              this.#publishSession(sessionId, type, payload, live),
            alias: (sessionId, previousId, itemId, live) =>
              this.#sessionStream?.aliasItem(sessionId, previousId, itemId, live),
            catalogChanged: () =>
              this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] }),
            forgetIndexed: (ids) =>
              this.#sessionIndex ? this.#sessionIndex.forget(ids) : store.sessions.forget(ids),
          },
          {
            isSessionObserved: (sessionId) =>
              this.#sessionStream?.hasSubscribers(sessionId) ?? false,
            isSessionBridged: (sessionId) => {
              this.#claudeBridge?.assertCanAdopt();
              return this.#claudeBridge?.blocksManagedResume(sessionId) ?? false;
            },
          },
        );
        const claudeOwner = this.#claudeManaged;
        this.#claudeBridge = new ClaudeBridge({
          dataDir,
          bootId: claudeOwner.bootId,
          pluginDirectory: this.environment.AGENTKIB_CLAUDE_PLUGIN_DIR ?? "",
          target: (id, nativeId) => claudeOwner.nativeBridgeTarget(id, nativeId),
          discoveryFile: path.join(
            this.environment.AGENTKIB_HOME ??
              path.join(
                userHome({ ...process.env, ...this.environment }),
                this.environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev"
                  ? ".agentkib-dev"
                  : ".agentkib",
              ),
            "claude-bridge",
            "auto-v1.json",
          ),
          autoTarget: async (nativeId, cwd) => {
            // The terminal's directory selects the innermost registered workspace.
            const directory = canonicalize(cwd);
            const workspace = (store.listWorkspaces() as { id: string; path: string }[])
              .filter(
                (row) => directory === row.path || directory.startsWith(`${row.path}${path.sep}`),
              )
              .sort((a, b) => b.path.length - a.path.length)[0];
            if (!workspace) throw new Error("workspace-not-registered");
            const id = store.sessions.id("claude-code", nativeId);
            if (!store.sessions.get(id))
              await this.#sessionIndex?.refresh({ workspaceId: workspace.id, force: true });
            return claudeOwner.nativeBridgeTarget(id, nativeId);
          },
          validate: (target, forControl, bindingId) => {
            if (readPreferences(dataDir).session_index_enabled === false)
              throw new Error("session-index-disabled");
            claudeOwner.validateNativeBridgeTarget(target, forControl, bindingId);
          },
          publish: (id, type, payload, live) => this.#publishSession(id, type, payload, live),
        });
        this.#claudeBridge.initialize();
        this.#historySearch = new HistorySearch(
          store,
          dataDir,
          { ...process.env, ...this.environment },
          this.#cursorBridge,
        );
        this.#sessionIndex = new SessionIndex(
          store.sessions,
          this.#sessions,
          () => {
            const value = readPreferences(dataDir).session_index_enabled;
            return typeof value === "boolean" ? value : true;
          },
          () => this.#historySearch?.refresh(),
          () => this.#claudeManaged?.managedNativeIds() ?? new Set(),
        );
        this.#stopping = false;
        const runtimeBootId = randomUUID();
        const snapshotHistory = new SessionSnapshotHistory();
        this.#snapshotHistory = snapshotHistory;
        this.#sessionStream = new SessionStreamHub(
          runtimeBootId,
          async (sessionId) => {
            if (sessionId === "") {
              const catalog = await this.#request(RUNTIME_METHODS.webRequest, {
                operation: "catalog",
              });
              return {
                live:
                  catalog && typeof catalog === "object" && !Array.isArray(catalog)
                    ? (catalog as Record<string, unknown>)
                    : {},
                items: [],
                completeItems: true,
              };
            }
            // Claude's live and history reads share an ownership lock. Keep them
            // sequential so this runtime does not contend with itself on restart.
            const liveValue = await this.#request(RUNTIME_METHODS.webRequest, {
              operation: "live",
              sessionId,
              experimentalEnabled: true,
            });
            const live =
              liveValue && typeof liveValue === "object" && !Array.isArray(liveValue)
                ? (liveValue as Record<string, unknown>)
                : { sessionId, status: "unsupported" };
            const readHistory = async () => {
              const pageValue = await this.#request(RUNTIME_METHODS.webRequest, {
                operation: "events",
                sessionId,
                cursor: null,
                limit: 100,
              });
              const page =
                pageValue && typeof pageValue === "object" && !Array.isArray(pageValue)
                  ? (pageValue as Record<string, unknown>)
                  : {};
              const items = Array.isArray(page.events)
                ? page.events.filter(
                    (item): item is Record<string, unknown> =>
                      !!item && typeof item === "object" && !Array.isArray(item),
                  )
                : [];
              // Stream snapshots carry history coverage, never a cached pagination cursor.
              return { items, completeItems: page.next_cursor === null };
            };
            const claude = this.#claudeManaged;
            const index = this.#sessionIndex;
            const isClaude =
              this.#store?.sessions.get(sessionId)?.agent === "claude-code" ||
              claude?.hasManagedSession(sessionId);
            const history =
              isClaude && claude && index
                ? await snapshotHistory.read(
                    sessionId,
                    async () => {
                      const generation = index.generation();
                      if (
                        this.#claudeManaged !== claude ||
                        this.#sessionIndex !== index ||
                        (!index.enabled() && !claude.hasManagedSession(sessionId))
                      )
                        throw new Error("session-unavailable");
                      const version = await claude.historyVersion(sessionId);
                      if (
                        this.#claudeManaged !== claude ||
                        this.#sessionIndex !== index ||
                        (!index.enabled() && !claude.hasManagedSession(sessionId)) ||
                        index.generation() !== generation
                      )
                        throw new Error("session-unavailable");
                      return JSON.stringify([String(generation), version]);
                    },
                    readHistory,
                  )
                : await readHistory();
            return { live, ...history };
          },
          (event) => {
            this.notify(SESSION_EVENT_NOTIFICATION, event);
            if (event.type === "invalidate") this.#historySearch?.refresh(event.sessionId);
          },
          (sessionId) => {
            this.#webRead?.observeSession(sessionId);
            this.#claudeManaged?.observeSession(sessionId);
          },
        );
        this.#remoteAgent = new RemoteAgent(dataDir, store, this.#sessions, this.#sessionIndex);
        this.#historySearch.refresh();
        return Promise.all([
          this.#mcpHub.start(),
          this.#remoteAgent.start(),
          this.#historySearch.enabled() ? undefined : this.#historySearch.clear(),
        ]);
      });
    }
    if (this.#stopping) throw new BackendTaskError("backend-closing");
    if (!this.#store || !this.#dataDir)
      throw new RpcFault(-32000, "AgentKib command failed", {
        detail: "TypeScript backend has not been initialized",
      });
    if (method === RUNTIME_METHODS.sessionsSubscribe) {
      const request = parameters(
        z.object({ sessionId: z.string().max(256), afterCursor: z.string().max(1024).optional() }),
        params,
      );
      return this.#sessionStream!.subscribe(request.sessionId, request.afterCursor);
    }
    if (method === RUNTIME_METHODS.sessionsUnsubscribe) {
      const request = parameters(z.object({ subscriptionId: z.string().uuid() }), params);
      return this.#sessionStream!.unsubscribe(request.subscriptionId);
    }
    if (method === RUNTIME_METHODS.controlReceipt) {
      const receipt = readControlReceipt(this.#dataDir, params);
      const nativeReceipt = this.#claudeBridge?.receipt(receipt) ?? receipt;
      return this.#claudeManaged ? this.#claudeManaged.receipt(nativeReceipt) : nativeReceipt;
    }
    if (method === RUNTIME_METHODS.claudeManaged) return this.#requestClaudeManaged(params);
    if (method === RUNTIME_METHODS.codexManaged && params.operation === "options")
      return this.#withWebRead((owner) => owner.managedOptions());
    if (method === RUNTIME_METHODS.codexManaged && params.operation === "reconcile")
      return this.#withWebRead((owner) => owner.managedReconcile(params));
    if (method === RUNTIME_METHODS.codexManaged && params.operation === "resume")
      return this.#withWebRead((owner) => owner.managedResume(params));
    if (method === RUNTIME_METHODS.codexManaged && params.operation === "queue-list")
      return this.#withWebRead((owner) => owner.managedQueueList(params));
    if (method === RUNTIME_METHODS.codexManaged && params.operation === "unarchive")
      return this.#withWebRead((owner) => owner.managedUnarchive(params));
    if (method === RUNTIME_METHODS.codexManaged && params.operation === "delete")
      return this.#withWebRead((owner) => owner.managedDelete(params));
    if (method === RUNTIME_METHODS.codexManaged && params.operation === "settings-state")
      return this.#withWebRead((owner) => owner.managedSettingsState(params));
    if (
      method === RUNTIME_METHODS.codexManaged &&
      ["capabilities", "inspect"].includes(String(params.operation))
    )
      return this.#withWebRead((owner) => owner.managedQuery(params));
    if (
      method === RUNTIME_METHODS.codexManaged &&
      ["create", "adopt", "release"].includes(String(params.operation))
    )
      return this.#withWebRead((owner) => owner.managedLifecycle(params));
    if (
      method === RUNTIME_METHODS.codexManaged &&
      [
        "send",
        "stop",
        "approve",
        "answer",
        "steer",
        "queue-add",
        "queue-update",
        "queue-delete",
        "queue-reorder",
        "rename",
        "archive",
        "settings",
        "goal-set",
        "goal-pause",
        "goal-resume",
        "goal-clear",
        "fork",
        "compact",
        "terminals-clean",
      ].includes(String(params.operation))
    )
      return this.#withWebRead((owner) => owner.managedControl(params));
    if (method === RUNTIME_METHODS.refreshInsights) return this.#insightRefresh!.refresh();
    if (method === RUNTIME_METHODS.listWorkspaceOpeners)
      return this.#workspaceApplications!.list(string(params, "workspaceId"));
    if (method === RUNTIME_METHODS.openWorkspaceWithApp) {
      const request = parameters(
        z.object({ workspaceId: z.string(), openerId: z.string().optional() }),
        params,
      );
      return this.#workspaceApplications!.open(request.workspaceId, request.openerId);
    }
    if (method === RUNTIME_METHODS.webRequest) {
      if (params.operation === "diff") return webDiff(params, this.#store, this.#git!);
      // Resolve the provider from persisted identity, never from a browser-supplied agent.
      // Fresh Claude sessions are not indexed until their first native transcript exists.
      if (typeof params.sessionId === "string" && params.operation !== "catalog") {
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
        const claudeSession =
          this.#store!.sessions.get(sessionId)?.agent === "claude-code" ||
          this.#claudeManaged!.hasManagedSession(sessionId);
        if (claudeSession) {
          if (
            params.operation === "events" &&
            this.#store!.sessions.get(sessionId)?.agent === "claude-code" &&
            !this.#claudeManaged!.hasManagedSession(sessionId)
          )
            return this.#readIndexedClaudeEvents(params, sessionId);
          return this.#requestClaudeManaged(params);
        }
      }
      if (
        params.operation === "live" ||
        params.operation === "events" ||
        params.operation === "usage"
      ) {
        return this.#withWebRead((owner) => owner.request(params));
      }
      if (params.operation === "settings-state")
        return this.#withWebRead((owner) => owner.managedSettingsState(params));
      if (params.operation === "queue-list")
        return this.#withWebRead((owner) => owner.managedQueueList(params));
      if (["capabilities", "inspect"].includes(String(params.operation)))
        return this.#withWebRead((owner) => owner.managedQuery(params));
      if (params.operation === "resume")
        return this.#withWebRead((owner) => owner.managedResume(params));
      if (params.operation === "unarchive")
        return this.#withWebRead((owner) => owner.managedUnarchive(params));
      if (params.operation === "delete")
        return this.#withWebRead((owner) => owner.managedDelete(params));
      if (
        [
          "send",
          "stop",
          "approve",
          "answer",
          "steer",
          "queue-add",
          "queue-update",
          "queue-delete",
          "queue-reorder",
          "rename",
          "archive",
          "settings",
          "goal-set",
          "goal-pause",
          "goal-resume",
          "goal-clear",
          "fork",
          "compact",
          "terminals-clean",
        ].includes(String(params.operation))
      )
        return this.#withWebRead((owner) => owner.managedControl(params));
      if (
        params.operation === "catalog" ||
        params.operation === "events" ||
        params.operation === "context" ||
        params.operation === "resume-command" ||
        params.operation === "usage" ||
        params.operation === "goal" ||
        params.operation === "resources"
      )
        if (params.operation !== "catalog")
          return this.#withWebRead((owner) => owner.request(params));
      return this.#withWebRead((owner) => owner.request(params)).then((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const catalog = value as Record<string, unknown>;
        const records = this.#claudeManaged!.catalog();
        const managedIds = new Set(records.map((record) => record.id));
        const aliases = new Set(
          records.flatMap((record) =>
            typeof record.indexedSessionId === "string" ? [record.indexedSessionId] : [],
          ),
        );
        const sessions = Array.isArray(catalog.sessions) ? catalog.sessions : [];
        const continuation = (session: unknown) => {
          if (!session || typeof session !== "object" || Array.isArray(session)) return session;
          const row = session as Record<string, unknown>;
          if (row.agent !== "claude-code" || typeof row.id !== "string") return row;
          const projection = row.continuation;
          let live = managedIds.has(row.id)
            ? projection && typeof projection === "object" && !Array.isArray(projection)
              ? (projection as Record<string, unknown>)
              : undefined
            : this.#claudeManaged!.catalogContinuation(row.id);
          try {
            if (
              this.#claudeBridge?.handles(row.id) &&
              this.#claudeBridge.blocksManagedResume(row.id)
            )
              live = this.#claudeBridge.live(row.id, false);
          } catch {
            // A broken connection registry must not prevent read-only catalog access.
            live = {
              status: "unsupported",
              executionLocation: null,
              reason: "claude-bridge-registry-invalid",
            };
          }
          return live
            ? {
                ...row,
                continuation: {
                  status: live.status,
                  executionLocation: live.executionLocation,
                  ownershipReason: live.ownershipReason,
                  reason: live.reason,
                },
              }
            : row;
        };
        return {
          ...catalog,
          sessions: [
            ...sessions.filter(
              (session) =>
                !!session &&
                typeof session === "object" &&
                !Array.isArray(session) &&
                !("id" in session && aliases.has(String(session.id))),
            ),
            ...this.#withWorktrees(records),
          ].map(continuation),
        };
      });
    }
    if (method.startsWith("skills.")) return this.#skills!.request(method, params);
    if (method === RUNTIME_METHODS.agentToolsStatus)
      return this.#agentTools!.snapshot(params.force === true);
    if (method === RUNTIME_METHODS.agentToolExecute) return this.#agentTools!.execute(params);
    if (method === RUNTIME_METHODS.listRemoteGateways) return this.#remoteGateways!.list();
    if (method === RUNTIME_METHODS.remoteRequest) return this.#remoteAgent!.request(params);
    if (method === RUNTIME_METHODS.saveRemoteGateway) {
      const request = parameters(z.object({ input: z.unknown() }), params);
      return this.#remoteGateways!.save(request.input);
    }
    if (method === RUNTIME_METHODS.refreshRemoteGateway)
      return this.#remoteGateways!.refresh(params);
    if (method === RUNTIME_METHODS.removeRemoteGateway) return this.#remoteGateways!.remove(params);
    if (method === RUNTIME_METHODS.relayCreateCsr) return createRelayCsr(params);
    if (TYPESCRIPT_MCP_METHODS.has(method)) return this.#mcpRequest(method, params);
    if (method === RUNTIME_METHODS.obsidianIntegration) return this.#obsidian!.integration();
    if (method === RUNTIME_METHODS.addObsidianVault) {
      const request = parameters(z.object({ path: z.string() }), params);
      return this.#obsidian!.addVault(request.path);
    }
    if (method === RUNTIME_METHODS.linkObsidianWorkspace) {
      const request = parameters(
        z.object({
          workspaceId: z.string(),
          vaultPath: z.string(),
          relativeTarget: z.string().nullable().optional(),
        }),
        params,
      );
      return this.#obsidian!.linkWorkspace(
        request.workspaceId,
        request.vaultPath,
        request.relativeTarget,
      );
    }
    if (method === RUNTIME_METHODS.unlinkObsidianWorkspace) {
      const request = parameters(z.object({ id: z.string() }), params);
      return this.#obsidian!.unlinkWorkspace(request.id);
    }
    if (method === RUNTIME_METHODS.openObsidian) return this.#obsidian!.openApp();
    if (method === RUNTIME_METHODS.openObsidianWorkspace) {
      const request = parameters(z.object({ id: z.string() }), params);
      return this.#obsidian!.openWorkspace(request.id);
    }
    if (method === RUNTIME_METHODS.sessionEvents) return this.#sessions!.events(params);
    if (
      Object.values(HISTORY_SEARCH_METHODS).includes(
        method as (typeof HISTORY_SEARCH_METHODS)[keyof typeof HISTORY_SEARCH_METHODS],
      )
    )
      return this.#historySearch!.request(method, params);
    if (method === RUNTIME_METHODS.cursorBridge)
      return this.#cursorBridge!.request(params).then((result) => {
        if (params.action === "disconnect") this.#historySearch?.invalidate();
        return result;
      });
    if (method === RUNTIME_METHODS.sessionDocument) {
      const { sessionId } = parameters(z.object({ sessionId: z.string() }), params);
      return this.#sessions!.document(sessionId);
    }
    if (method === RUNTIME_METHODS.sessionSourceCapability) {
      const { sessionId } = parameters(z.object({ sessionId: z.string() }), params);
      return this.#sessions!
        .resolve(sessionId)
        .then(({ native }) =>
          this.#sessions!.document(sessionId).then(() => ({
            status: "supported",
            ...(native.agent === "cursor"
              ? {
                  source_surface: native.native_ref.startsWith("cursor-ide-v1-")
                    ? "cursor-ide"
                    : "cursor-cli",
                }
              : {}),
          })),
        )
        .then(
          (result) => result,
          (error: unknown) => ({
            status: "unavailable",
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
    }
    if (method === RUNTIME_METHODS.listNativeImports) {
      const { workspaceId } = parameters(z.object({ workspaceId: z.string() }), params);
      return listNativeImports(this.#dataDir!, this.#store!, workspaceId);
    }
    if (method === RUNTIME_METHODS.planSessionMcpConnection)
      return planSessionMcpConnection(params, this.#store, { ...process.env, ...this.environment });
    if (HANDOFF_TASK_METHODS.has(method))
      return this.#handoffQueue.run((task) =>
        this.#handoffWork.run(task, () => this.#requestHandoff(method, params)),
      );
    if (method === RUNTIME_METHODS.sanitizeSessionHandoff) {
      const request = parameters(
        z.object({ format: handoffFormat, editedContent: z.string() }),
        params,
      );
      return sanitizeHandoffExport(request.editedContent, request.format);
    }
    if (method === RUNTIME_METHODS.workspaceSessions) {
      const { workspaceId } = parameters(z.object({ workspaceId: z.string() }), params);
      return this.#sessionIndex!.read(workspaceId).then((rows) => this.#withWorktrees(rows));
    }
    if (TYPESCRIPT_SESSION_READ_METHODS.has(method))
      return this.#store.sessions.request(method, params);
    if (TYPESCRIPT_INSIGHT_METHODS.has(method)) return this.#store.insights.request(method, params);
    if (TYPESCRIPT_CATALOG_METHODS.has(method)) return this.#store.catalog.request(method, params);
    if (TYPESCRIPT_GIT_METHODS.has(method)) return this.#git!.request(method, params);
    switch (method) {
      case NATIVE_CONTEXT:
        return nativeContext({ ...process.env, ...this.environment });
      case RUNTIME_METHODS.refreshWorkspaceSessions:
        return this.#sessionIndex!.refresh(params).then((rows) => this.#withWorktrees(rows));
      case RUNTIME_METHODS.clearSessionIndex:
        this.#snapshotHistory?.invalidate();
        this.#sessionIndex!.clear(params);
        return this.#historySearch!.clear().then(() => null);
      case RUNTIME_METHODS.applyChanges: {
        const request = params as { launchRequest?: { mode?: unknown } };
        const environment = { ...process.env, ...this.environment };
        return applyRequest(
          params,
          this.#store,
          this.#dataDir,
          environment,
          request.launchRequest?.mode === "native-import"
            ? (plan, applicationId, dataDir) => {
                const validated = validateNativeImportApplicationData(
                  plan,
                  request.launchRequest,
                  applicationId,
                  dataDir,
                );
                return [path.join(validated.directory, "plan.json")];
              }
            : undefined,
        );
      }
      case RUNTIME_METHODS.planChanges: {
        const { project, manifest, includeHome } = parameters(
          z.object({ project: z.string(), manifest: manifestSchema, includeHome: z.boolean() }),
          params,
        );
        const network = readPreferences(this.#dataDir).mcp_network;
        const parsed = z.object({ port: z.number().int().min(1).max(65535) }).safeParse(network);
        ensureGateway(manifest, parsed.success ? parsed.data.port : 47653);
        const home = userHome({ ...process.env, ...this.environment });
        return planWorkspace(project, manifest, {
          instructionImport: this.#instructionImports.get(project, manifest.workspace.id),
          reconcileImportedInstructions: true,
          skillHomes: [nativeContext({ ...process.env, ...this.environment }).agentkib_home].filter(
            (root): root is string => typeof root === "string",
          ),
          ...(includeHome
            ? {
                openclaw_config: path.join(home, ".openclaw/openclaw.json"),
                hermes_config: path.join(home, ".hermes/config.yaml"),
              }
            : {}),
        });
      }
      case RUNTIME_METHODS.workspaceDoctorReport:
      case RUNTIME_METHODS.workspaceDoctorSummaries:
        return this.#doctor!.request(method, params);
      case RUNTIME_METHODS.resolveContext:
        return this.#context!.request(params);
      case BACKEND_INSPECT:
        return parameters(
          z.object({ workspaces: z.array(z.object({ id: z.string(), path: z.string() })) }),
          params,
        ).workspaces.map(({ id, path }) => ({ id, inspection: inspectWorkspace(id, path) }));
      case RUNTIME_METHODS.scanWorkspace:
        return scanWorkspace(string(params, "project"));
      case RUNTIME_METHODS.prepareManifest: {
        const project = string(params, "project"),
          manifest = prepareManifest(project);
        this.#instructionImports.record(project, manifest);
        return manifest;
      }
      case BACKEND_DEFAULT_MANIFEST:
        return defaultManifest(string(params, "project"));
      case BACKEND_PLAN_PROJECT_ASSETS: {
        const { project, manifest } = parameters(
          z.object({ project: z.string(), manifest: manifestSchema }),
          params,
        );
        return planWorkspace(project, manifest, {
          skillHomes: [nativeContext({ ...process.env, ...this.environment }).agentkib_home].filter(
            (root): root is string => typeof root === "string",
          ),
        });
      }
      case BACKEND_PLAN_WORKSPACE: {
        if (params.operation !== "add" && params.operation !== "refresh")
          invalid("Invalid workspace operation");
        const value = string(params, params.operation === "add" ? "path" : "id");
        const context = object(params.context) as unknown as NativeContext;
        return this.#store.workspaces.prepareWorkspace(params.operation, value, context);
      }
      case BACKEND_PLAN_DISCOVERY:
        return this.#store.workspaces.prepareDiscovery(
          object(params.snapshot) as unknown as DiscoverySnapshot,
          object(params.context) as unknown as NativeContext,
        );
      case RUNTIME_METHODS.addWorkspace:
      case RUNTIME_METHODS.refreshWorkspace: {
        string(params, method === RUNTIME_METHODS.addWorkspace ? "path" : "id");
        const plan = object(params._plan) as unknown as WorkspacePlan;
        const inspection = object(params._inspection) as unknown as WorkspaceInspection;
        const id =
          method === RUNTIME_METHODS.addWorkspace
            ? this.#store.workspaces.addWorkspace(plan, inspection)
            : this.#store.workspaces.refreshWorkspace(plan, inspection);
        return this.#store.getWorkspace(id);
      }
      case RUNTIME_METHODS.excludeWorkspace:
        this.#store.workspaces.excludeWorkspace(string(params, "id"));
        this.#historySearch?.invalidate();
        return null;
      case RUNTIME_METHODS.restoreExcludedWorkspace:
        this.#store.workspaces.restoreExcludedWorkspace(string(params, "path"));
        return null;
      case RUNTIME_METHODS.addScanRoot: {
        const value = string(params, "path");
        const depth = unsigned(params.maxDepth, "maxDepth");
        return this.#store.workspaces.addScanRoot(value, depth);
      }
      case RUNTIME_METHODS.removeScanRoot:
        this.#store.workspaces.removeScanRoot(string(params, "id"));
        return null;
      case RUNTIME_METHODS.refreshDiscovery: {
        const plan = object(params._plan) as unknown as DiscoveryPlan;
        const snapshot = object(params._snapshot) as unknown as DiscoverySnapshot;
        if (!Array.isArray(params._inspections)) invalid("Missing workspace inspections");
        const queued = string(params, "_queuedAt");
        const started = string(params, "_startedAt");
        this.#store.workspaces.syncDiscovery(
          plan,
          snapshot,
          params._inspections as InspectedWorkspace[],
          started,
        );
        return refreshReceipt(queued, started);
      }
      case RUNTIME_METHODS.discoveryReport:
        return this.#store.workspaces.discoveryReport();
      case RUNTIME_METHODS.storageOverview:
        return this.#storage!.overview();
      case RUNTIME_METHODS.storageChildren:
        return this.#storage!.children(
          string(params, "workspaceId"),
          string(params, "relativePath"),
        );
      case RUNTIME_METHODS.resolveStoragePath:
        return this.#storage!.resolve(
          string(params, "workspaceId"),
          string(params, "relativePath"),
        );
      case RUNTIME_METHODS.refreshStorage:
        return this.#storage!.refresh();
      case RUNTIME_METHODS.cancelStorage:
        return this.#storage!.cancel();
      case RUNTIME_METHODS.quotaSnapshot:
        return this.#quota!.snapshot();
      case RUNTIME_METHODS.quotaCollectorStatus:
        return this.#quota!.status();
      case RUNTIME_METHODS.refreshQuota:
        return this.#quota!.refresh();
      case RUNTIME_METHODS.quotaPreferences:
        return (
          parseQuotaPreferences(readPreferences(this.#dataDir).quota_popover) ?? {
            hidden_providers: [],
            hidden_windows: [],
          }
        );
      case RUNTIME_METHODS.setQuotaPreferences: {
        const preferences = parseQuotaPreferences(params.preferences);
        if (!preferences) invalid("Invalid quota preferences");
        const normalized = normalizeQuotaPreferences(preferences);
        writePreference(this.#dataDir, "quota_popover", normalized);
        return normalized;
      }
      case RUNTIME_METHODS.setSessionIndexEnabled:
      case RUNTIME_METHODS.setLocalAutoRefresh:
      case RUNTIME_METHODS.setQuotaPromptSeen:
      case RUNTIME_METHODS.setQuotaAutoRefresh: {
        const keys: Record<string, string> = {
          [RUNTIME_METHODS.setSessionIndexEnabled]: "session_index_enabled",
          [RUNTIME_METHODS.setLocalAutoRefresh]: "local_auto_refresh_enabled",
          [RUNTIME_METHODS.setQuotaPromptSeen]: "quota_auto_refresh_prompt_seen",
          [RUNTIME_METHODS.setQuotaAutoRefresh]: "quota_auto_refresh_enabled",
        };
        const aliases = ["value", "enabled", "seen"].filter((key) => key in params);
        if (aliases.length !== 1 || typeof params[aliases[0]!] !== "boolean")
          invalid("Expected exactly one boolean value");
        if (method === RUNTIME_METHODS.setSessionIndexEnabled) {
          this.#snapshotHistory?.invalidate();
          this.#sessionIndex!.invalidate();
        }
        writePreferences(this.#dataDir, {
          [keys[method]!]: params[aliases[0]!],
          ...(method === RUNTIME_METHODS.setQuotaAutoRefresh
            ? { quota_auto_refresh_prompt_seen: true }
            : {}),
        });
        if (method === RUNTIME_METHODS.setSessionIndexEnabled && !params[aliases[0]!]) {
          this.#store.sessions.clear(null);
          return this.#historySearch!.clear().then(() => this.#preferences());
        }
        if (method === RUNTIME_METHODS.setSessionIndexEnabled) this.#historySearch?.refresh();
        return this.#preferences();
      }
      case RUNTIME_METHODS.updateOnboarding: {
        const event = object(params.event);
        const preferences = readOnboarding(readPreferences(this.#dataDir).onboarding);
        switch (event.event) {
          case "doctor-completed": {
            const id = string(event, "workspace_id");
            const count = unsigned(event.repairable_count, "repairable_count");
            if (preferences.workspace_id !== id) preferences.repair_applied = false;
            preferences.workspace_id = id;
            preferences.doctor_completed = true;
            preferences.repairable_count = count;
            if (count === 0) preferences.acknowledged_version = 1;
            break;
          }
          case "repair-applied":
            preferences.workspace_id = string(event, "workspace_id");
            preferences.repair_applied = true;
            break;
          case "dismissed":
            preferences.acknowledged_version = 1;
            break;
          case "restarted":
            Object.assign(preferences, readOnboarding(null));
            break;
          default:
            invalid("Invalid onboarding event");
        }
        const { workspace_id, ...rest } = preferences;
        writePreference(this.#dataDir, "onboarding", {
          ...rest,
          ...(workspace_id === null ? {} : { workspace_id }),
        });
        return this.#preferences();
      }
      case RUNTIME_METHODS.listWorkspaces:
        return catalogCheckouts(this.#store, { ...process.env, ...this.environment }).workspaces(
          this.#store.listWorkspaces() as Array<{ id: unknown }>,
        );
      case RUNTIME_METHODS.listScanRoots:
        return this.#store.listScanRoots();
      case RUNTIME_METHODS.listExcludedWorkspaces:
        return this.#store.listExcludedWorkspaces();
      case RUNTIME_METHODS.listActivity: {
        const limit = params.limit === undefined ? 200 : params.limit;
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 0)
          invalid("Activity limit must be a nonnegative integer");
        return this.#store.listActivity(limit as number);
      }
      case BACKEND_PREFERENCES:
        return this.#preferences();
      case RUNTIME_METHODS.runtimeInfo: {
        const preferences = this.#preferences();
        const home = userHome({ ...process.env, ...this.environment });
        const development = this.environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev";
        return {
          app_name: development ? "AgentKib Dev" : "AgentKib",
          app_version: this.environment.AGENTKIB_APP_VERSION ?? "0.13.0",
          app_channel: development ? "development" : "stable",
          updates_enabled: !development,
          data_dir: this.#dataDir,
          database_path: path.join(this.#dataDir!, "agentkib.db"),
          mcp_package_root: path.join(this.#dataDir!, "mcp", "packages"),
          mcp_hub: this.#mcpHub!.status(),
          openclaw_config: path.join(home, ".openclaw", "openclaw.json"),
          hermes_config: path.join(home, ".hermes", "config.yaml"),
          tray_available: false,
          ...preferences,
        };
      }
      case RUNTIME_METHODS.setCloseBehavior: {
        const value = params.value ?? null;
        if (value !== null && value !== "minimize-to-tray" && value !== "quit")
          invalid("Invalid close behavior");
        writePreference(this.#dataDir, "close_behavior", value);
        return this.#preferences();
      }
      case RUNTIME_METHODS.setLocale: {
        if (typeof params.preference !== "string") invalid("Locale preference must be a string");
        if (!["system", "en-US", "zh-CN", "zh-TW", "ja-JP"].includes(params.preference))
          throw new Error(`Unsupported locale preference: ${params.preference}`);
        return this.#setChoice(params, "locale_preference", [
          "system",
          "en-US",
          "zh-CN",
          "zh-TW",
          "ja-JP",
        ]);
      }
      case RUNTIME_METHODS.setThemePreference:
        return this.#setChoice(params, "theme_preference", ["system", "light", "dark"]);
      case RUNTIME_METHODS.setAccentThemePreference:
        return this.#setChoice(params, "accent_theme_preference", [
          "minimal-neutral",
          "vtron",
          "claude",
          "sakura",
          "ocean-breeze",
        ]);
      case RUNTIME_METHODS.setAppIconPreference:
        return this.#setChoice(params, "app_icon_preference", ["white", "black"]);
      case RUNTIME_METHODS.setSidebarWidthPreference: {
        const value = params.preference;
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535)
          invalid("Sidebar width preference must be an unsigned 16-bit integer");
        if (value < 250 || value > 400)
          throw new Error("Sidebar width preference must be an integer between 250 and 400");
        writePreference(this.#dataDir, "sidebar_width_preference", value);
        return this.#preferences();
      }
      default:
        throw new RpcFault(-32601, "Method not found");
    }
  }

  async #mcpRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const manager = this.#mcp!;
    switch (method) {
      case RUNTIME_METHODS.previewMcpMigration:
        return this.#mcpManagement!.previewMigration(params, this.#mcpHub!.status());
      case RUNTIME_METHODS.applyMcpMigration:
        return this.#mcpManagement!.applyMigration(params, this.#mcpHub!.status());
      case RUNTIME_METHODS.mcpManagementState:
        return this.#mcpManagement!.state(params);
      case RUNTIME_METHODS.saveMcpConfiguration:
        return this.#mcpManagement!.save(params);
      case RUNTIME_METHODS.removeMcpConfiguration:
        return this.#mcpManagement!.remove(params);
      case RUNTIME_METHODS.previewMcpImport:
        return this.#mcpManagement!.previewImport(params);
      case RUNTIME_METHODS.applyMcpImport:
        return this.#mcpManagement!.applyImport(params);
      case RUNTIME_METHODS.checkMcpConnections:
        return this.#mcpConnections!.check(params);
      case RUNTIME_METHODS.planMcpConnections:
        return this.#mcpConnections!.plan(params);
      case RUNTIME_METHODS.applyMcpConnections:
        return this.#mcpConnections!.apply(params);
      case RUNTIME_METHODS.getMcpPolicy: {
        const request = parameters(z.object({ project: z.string().optional() }).strict(), params);
        return manager.getPolicy(request.project);
      }
      case RUNTIME_METHODS.saveMcpPolicy: {
        const request = parameters(
          z
            .object({
              project: z.string().optional(),
              revision: z.string(),
              rules: z.array(z.unknown()),
            })
            .strict(),
          params,
        );
        return manager.savePolicy(
          { revision: request.revision, rules: request.rules },
          request.project,
        );
      }
      case RUNTIME_METHODS.listMcpServers: {
        const request = parameters(z.object({ project: z.string().nullable().optional() }), params);
        return manager.list(request.project ?? undefined);
      }
      case RUNTIME_METHODS.mcpHubStatus:
        return this.#mcpHub!.status();
      case RUNTIME_METHODS.updateMcpNetwork: {
        const request = parameters(z.object({ settings: z.unknown() }), params);
        const settings = parameters(
          z.object({
            port: z.number().int().min(1).max(65535),
            lan_enabled: z.boolean(),
            lan_risk_accepted: z.boolean(),
          }),
          request.settings,
        );
        const previous = this.#mcpHub!.status();
        const previousSettings: McpNetworkSettings = {
          port: previous.port,
          lan_enabled: previous.lan_enabled,
          lan_risk_accepted:
            z
              .object({ lan_risk_accepted: z.boolean() })
              .safeParse(readPreferences(this.#dataDir!).mcp_network).data?.lan_risk_accepted ??
            false,
        };
        const status = await this.#mcpHub!.update(settings);
        try {
          writePreference(this.#dataDir!, "mcp_network", settings);
          manager.setNetwork(settings);
          return status;
        } catch (error) {
          await this.#mcpHub!.update(previousSettings).catch(() => undefined);
          manager.setNetwork(previousSettings);
          throw error;
        }
      }
      case RUNTIME_METHODS.startMcpOAuth: {
        const request = parameters(
          z.object({ serverId: z.string(), project: z.string().nullable().optional() }),
          params,
        );
        return this.#mcpOAuth!.start(request.serverId, request.project ?? undefined);
      }
      case RUNTIME_METHODS.mcpConnectionInfo:
        return mcpConnectionInfo(params, this.#store!, this.#mcpHub!.status(), {
          ...process.env,
          ...this.environment,
        });
      case RUNTIME_METHODS.planMcpConnection:
        return planMcpConnection(params, this.#store!, this.#mcpHub!.status(), {
          ...process.env,
          ...this.environment,
        });
      case RUNTIME_METHODS.verifyMcpConnection:
        return verifyMcpConnection(params, this.#store!, () => this.#mcpHub!.status(), {
          ...process.env,
          ...this.environment,
        });
      case RUNTIME_METHODS.getMcpServer: {
        const request = parameters(
          z.object({ serverId: z.string(), project: z.string().nullable().optional() }),
          params,
        );
        return manager.get(request.serverId, request.project ?? undefined);
      }
      case RUNTIME_METHODS.saveMcpServer: {
        const request = parameters(
          z.object({ server: z.unknown(), project: z.string().nullable().optional() }),
          params,
        );
        return manager.save(
          request.server as Parameters<McpManager["save"]>[0],
          request.project ?? undefined,
        );
      }
      case RUNTIME_METHODS.saveMcpLocalValues: {
        const request = parameters(
          z.object({
            serverId: z.string(),
            env: z.record(z.string(), z.string()),
            headers: z.record(z.string(), z.string()),
            project: z.string().nullable().optional(),
          }),
          params,
        );
        return manager.saveLocal(
          request.serverId,
          request.env,
          request.headers,
          request.project ?? undefined,
        );
      }
      case RUNTIME_METHODS.removeMcpServer: {
        const request = parameters(
          z.object({ serverId: z.string(), project: z.string().nullable().optional() }),
          params,
        );
        return manager.remove(request.serverId, request.project ?? undefined);
      }
      case RUNTIME_METHODS.probeMcpRuntime: {
        const request = parameters(
          z.object({ serverId: z.string(), project: z.string().nullable().optional() }),
          params,
        );
        return manager.probe(request.serverId, request.project ?? undefined);
      }
      case RUNTIME_METHODS.listMcpRuntimes:
        return manager.runtimes();
      case RUNTIME_METHODS.restartMcpRuntime: {
        const request = parameters(
          z.object({ serverId: z.string(), project: z.string().nullable().optional() }),
          params,
        );
        return manager.restart(request.serverId, request.project ?? undefined);
      }
      case RUNTIME_METHODS.stopMcpRuntime: {
        const request = parameters(
          z.object({ serverId: z.string().nullable().optional() }),
          params,
        );
        return manager.stop(request.serverId ?? undefined);
      }
      case RUNTIME_METHODS.scanNativeMcp: {
        const request = parameters(z.object({ project: z.string().nullable().optional() }), params);
        return markPossiblyOverwritten(
          scanNativeMcp({ project: request.project ?? undefined }, this.#store!, {
            ...process.env,
            ...this.environment,
          }),
          this.#dataDir!,
        );
      }
      case RUNTIME_METHODS.planMcpMigration:
        return planNativeMcpMigration(params, this.#store!, manager, {
          ...process.env,
          ...this.environment,
        });
      case RUNTIME_METHODS.searchMcpRegistry:
      case RUNTIME_METHODS.refreshMcpRegistry: {
        const request = parameters(z.object({ query: z.string() }), params);
        return manager.searchRegistry(request.query, method === RUNTIME_METHODS.refreshMcpRegistry);
      }
      case RUNTIME_METHODS.listMcpInstallations:
        return manager.installations();
      case RUNTIME_METHODS.installMcp: {
        const request = parameters(
          z.object({
            entry: z.unknown(),
            project: z.string().nullable().optional(),
            confirmed: z.boolean(),
          }),
          params,
        );
        return manager.install(
          request.entry as import("./mcp").RegistryEntry,
          request.project ?? undefined,
          request.confirmed,
        );
      }
      case RUNTIME_METHODS.updateMcp: {
        const request = parameters(
          z.object({
            installationId: z.string(),
            entry: z.unknown(),
            project: z.string().nullable().optional(),
            confirmed: z.boolean(),
          }),
          params,
        );
        return manager.update(
          request.installationId,
          request.entry as import("./mcp").RegistryEntry,
          request.project ?? undefined,
          request.confirmed,
        );
      }
      case RUNTIME_METHODS.uninstallMcp: {
        const request = parameters(
          z.object({ installationId: z.string(), confirmed: z.boolean() }),
          params,
        );
        return manager.uninstall(request.installationId, request.confirmed);
      }
      default:
        return undefined;
    }
  }

  async #requestHandoff(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === RUNTIME_METHODS.prepareSessionHandoff)
      return prepareSessionHandoff(
        params,
        this.#sessions!,
        this.#store!.sessions,
        this.#store!,
        this.#handoffWork.commands,
        { ...process.env, ...this.environment },
        this.#cursorBridge,
      );
    if (method === RUNTIME_METHODS.planSessionHandoff)
      return planSessionHandoff(
        params,
        this.#sessions!,
        this.#store!.sessions,
        this.#store!,
        this.#dataDir!,
        { ...process.env, ...this.environment },
        this.#handoffWork.commands,
        this.#cursorBridge,
      );
    if (method === RUNTIME_METHODS.continueSessionHandoff)
      return this.#continueSessionHandoff(params);
    if (
      method === RUNTIME_METHODS.launchSessionHandoff &&
      params.mode === "native-import" &&
      params.target_agent === "cursor"
    )
      return reconcileCursorNativeImport(
        params,
        this.#sessions!,
        this.#store!.sessions,
        this.#store!,
        this.#dataDir!,
        this.#cursorBridge!,
        { ...process.env, ...this.environment },
      );
    if (method === RUNTIME_METHODS.launchSessionHandoff && params.mode === "native-import")
      await reconcileNativeImport(
        this.#dataDir!,
        params,
        this.#handoffWork.commands,
        { ...process.env, ...this.environment },
        this.#store!,
      );
    if (method === RUNTIME_METHODS.launchSessionHandoff)
      return prepareHandoffLaunch(
        params,
        this.#store!,
        this.#handoffWork.commands,
        {
          ...process.env,
          ...this.environment,
        },
        this.#dataDir,
      ).then((prepared) =>
        launchPreparedHandoff(prepared, this.#dataDir!, { ...process.env, ...this.environment }),
      );
    throw new Error("Unknown session handoff method");
  }

  async #continueSessionHandoff(value: unknown): Promise<unknown> {
    const environment = { ...process.env, ...this.environment };
    const request = z.object({ launchRequest: z.unknown() }).passthrough().parse(value);
    const launchRequest = request.launchRequest as { mode?: unknown };
    if (launchRequest?.mode === "native-import") {
      if ((launchRequest as { target_agent?: unknown }).target_agent === "cursor") {
        try {
          return await continueCursorNativeImport(
            value,
            this.#sessions!,
            this.#store!.sessions,
            this.#store!,
            this.#dataDir!,
            this.#cursorBridge!,
            environment,
          );
        } catch (error) {
          if (!(error instanceof CursorImportOutcomeUnknownError)) throw error;
          return {
            status: "import-outcome-unknown",
            error: {
              key: "errors.handoff.importOutcomeUnknown",
              params: {},
              detail: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }
      try {
        await continueNativeImport(
          value,
          this.#sessions!,
          this.#store!.sessions,
          this.#store!,
          this.#dataDir!,
          environment,
          this.#handoffWork.commands,
        );
      } catch (error) {
        if (!(error instanceof NativeImportOutcomeUnknownError)) throw error;
        return {
          status: "import-outcome-unknown",
          error: {
            key: "errors.handoff.importOutcomeUnknown",
            params: {},
            detail: error instanceof Error ? error.message : String(error),
          },
        };
      }
      try {
        const prepared = await prepareHandoffLaunch(
          request.launchRequest,
          this.#store!,
          this.#handoffWork.commands,
          environment,
          this.#dataDir,
        );
        const receipt = await launchPreparedHandoff(prepared, this.#dataDir!, environment);
        return { status: "launched", receipt };
      } catch (error) {
        return {
          status: "applied-launch-failed",
          error: {
            key: "errors.handoff.launchAfterApplyFailed",
            params: {},
            detail: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    const prepared = await prepareHandoffLaunch(
      request.launchRequest,
      this.#store!,
      this.#handoffWork.commands,
      environment,
      this.#dataDir,
    );
    await commitTask(() => applySessionHandoff(value, this.#store!, this.#dataDir!, environment));
    try {
      const receipt = await launchPreparedHandoff(prepared, this.#dataDir!, environment);
      return { status: "launched", receipt };
    } catch (error) {
      return {
        status: "applied-launch-failed",
        error: {
          key: "errors.handoff.launchAfterApplyFailed",
          params: {},
          detail: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  /** Marks indexed sessions that ran in a git worktree; the index itself stores only directories. */
  #withWorktrees<T>(rows: T[]): T[] {
    if (!this.#store) return rows;
    return catalogCheckouts(this.#store, { ...process.env, ...this.environment }).sessions(rows);
  }

  async #withWebRead<T>(operation: (owner: WebReadRequests) => T): Promise<Awaited<T>> {
    if (!this.#webRead) {
      const store = this.#store,
        sessions = this.#sessions,
        dataDir = this.#dataDir;
      if (!store || !sessions || !dataDir)
        throw new RpcFault(-32000, "TypeScript backend has not been initialized");
      const { WebReadRequests } = await import("./web-read");
      // Initialization or shutdown can run while the module loads. Never attach
      // an owner to a store that has already been closed or replaced.
      if (this.#store !== store)
        throw new RpcFault(-32000, "Backend initialization changed while loading web services");
      this.#webRead ??= new WebReadRequests(
        store,
        sessions,
        dataDir,
        () => this.#sessionIndex?.generation() ?? -1n,
        { ...process.env, ...this.environment },
        (sessionId, type, payload, live) => this.#publishSession(sessionId, type, payload, live),
        (sessionId) => this.#sessionStream?.hasSubscribers(sessionId) ?? false,
        this.#sessionIndex,
        () => this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] }),
      );
    }
    return await operation(this.#webRead);
  }

  async #requestClaudeManaged(params: Record<string, unknown>) {
    try {
      if (params.operation === "schedule-invalidate")
        this.#claudeBridge?.invalidate(
          typeof params.deviceId === "string" ? params.deviceId : undefined,
          typeof params.sessionId === "string" ? params.sessionId : undefined,
        );
      if (params.operation === "adopt") this.#claudeBridge?.assertCanAdopt();
      if (
        ["bridge-status", "bridge-challenge", "bridge-disconnect", "bridge-auto-connect"].includes(
          String(params.operation),
        )
      )
        return this.#claudeBridge!.management(params);
      if (
        typeof params.sessionId === "string" &&
        params.operation !== "events" &&
        params.operation !== "resume-command" &&
        this.#claudeBridge?.handles(params.sessionId) &&
        this.#claudeBridge?.blocksManagedResume(params.sessionId)
      )
        return this.#claudeBridge.request(params);
      return await this.#claudeManaged!.request(params);
    } catch (error) {
      if (error instanceof ClaudeHostControlPreflightError) return error.result;
      throw error;
    }
  }

  async #readIndexedClaudeEvents(params: Record<string, unknown>, sessionId: string) {
    const store = this.#store;
    const index = this.#sessionIndex;
    const claude = this.#claudeManaged;
    const before = store?.sessions.get(sessionId);
    if (!store || !index || !claude || before?.agent !== "claude-code" || !index.enabled())
      throw new Error("session-unavailable");
    const generation = index.generation();
    const result = await claude.request(params);
    const after = store.sessions.get(sessionId);
    if (
      this.#store !== store ||
      this.#sessionIndex !== index ||
      index.generation() !== generation ||
      !index.enabled() ||
      after?.agent !== "claude-code" ||
      after.workspace_id !== before.workspace_id ||
      after.created_at !== before.created_at ||
      after.updated_at !== before.updated_at
    )
      throw new Error("session-unavailable");
    return result;
  }

  #setChoice(params: Record<string, unknown>, key: string, values: string[]): unknown {
    if (typeof params.preference !== "string" || !values.includes(params.preference))
      invalid(`Invalid ${key}`);
    writePreference(this.#dataDir!, key, params.preference);
    return this.#preferences();
  }

  #publishSession(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live?: Record<string, unknown>,
  ) {
    if (type === "invalidate") this.#snapshotHistory?.invalidate(sessionId || undefined);
    this.#sessionStream?.publish(sessionId, type, payload, live);
    if (sessionId && type === "state") {
      const state = live ?? payload;
      const status = JSON.stringify([
        state.status,
        state.executionLocation,
        state.ownershipReason,
        state.reason,
      ]);
      if (this.#catalogContinuation.get(sessionId) !== status) {
        this.#catalogContinuation.set(sessionId, status);
        this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] });
      }
    }
    if (
      type === "invalidate" ||
      (type === "state" &&
        ["idle", "completed", "failed", "cancelled"].includes(String((live ?? payload).status)))
    )
      this.#historySearch?.refresh(sessionId);
  }

  #preferences() {
    return {
      ...preferenceSnapshot(this.#dataDir!, this.environment),
      mcp_network: readPreferences(this.#dataDir!).mcp_network ?? {
        port: this.environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? 47654 : 47653,
        lan_enabled: false,
        lan_risk_accepted: false,
      },
    };
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("Parameters must be an object");
  return value as Record<string, unknown>;
}

function invalid(detail: string): never {
  throw new RpcFault(-32602, "Invalid method parameters", { detail });
}

function string(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string") invalid(`${key} must be a string`);
  return value;
}
function unsigned(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(`${key} must be a nonnegative integer`);
  return value;
}
