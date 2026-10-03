import { Context } from "./context";
import { SessionReaders } from "./session-readers";
import {
  continueCursorNativeImport,
  CursorImportOutcomeUnknownError,
  reconcileCursorNativeImport,
} from "./cursor-native-import";
import { CursorBridge } from "./cursor-bridge";
import { listNativeImports } from "./session-native-imports";
import {
  continueNativeImport,
  validateNativeImportApplicationData,
} from "./session-native-import-owner";
import { handoffFormat, sanitizeHandoffExport } from "./session-handoff";
import { prepareSessionHandoff } from "./session-continuation";
import { planSessionHandoff } from "./session-handoff-plan";
import { applySessionHandoff } from "./session-handoff-apply";
import { launchPreparedHandoff, prepareHandoffLaunch } from "./session-handoff-launch";
import { SessionIndex } from "./session-index";
import { InsightRefresh } from "./insight-refresh";
import { ObsidianIntegration } from "./obsidian";
import { Skills } from "./skills";
import { AgentTools } from "./agent-tools";
import { McpManager } from "./mcp";
import { McpBuiltins } from "./mcp-builtin";
import { McpHub, type McpNetworkSettings } from "./mcp-hub";
import { McpOAuth } from "./mcp-oauth";
import { planSessionMcpConnection } from "./mcp-continuation";
import { scanNativeMcp } from "./mcp-native-scan";
import { planNativeMcpMigration } from "./mcp-migration-plan";
import { webDiff } from "./web-diff";
import type { WebReadRequests } from "./web-read";
import { RemoteGateways } from "./remote-gateways";
import { RemoteAgent } from "./remote-agent";
import { WorkspaceStorageOwner } from "./storage";
import { QuotaOwner } from "./quota";
import { ClaudeManagedReadOwner } from "./claude-managed-read";
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
import { parameters } from "./rpc";
import { z } from "zod";
import { BACKEND_INSPECT } from "./migration";
import { RpcFault } from "./rpc";
import { Commands } from "./commands";
import { Git } from "./git";
import { TYPESCRIPT_GIT_METHODS, TYPESCRIPT_CATALOG_METHODS } from "./migration";
import path from "node:path";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type RuntimeRpcError,
} from "@agentkib/runtime-protocol";
import { BackendStore } from "./store";
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

export class TypeScriptBackend {
  #store?: BackendStore;
  #dataDir?: string;
  #commands = new Commands();
  #git?: Git;
  #context?: Context;
  #doctor?: Doctor;
  #sessions?: SessionReaders;
  #cursorBridge?: CursorBridge;
  #webRead?: WebReadRequests;
  #sessionIndex?: SessionIndex;
  #insightRefresh?: InsightRefresh;
  #obsidian?: ObsidianIntegration;
  #skills?: Skills;
  #agentTools?: AgentTools;
  #mcp?: McpManager;
  #mcpHub?: McpHub;
  #mcpOAuth?: McpOAuth;
  #remoteGateways?: RemoteGateways;
  #remoteAgent?: RemoteAgent;
  #storage?: WorkspaceStorageOwner;
  #quota?: QuotaOwner;
  #claudeManaged?: ClaudeManagedReadOwner;
  #workspaceApplications?: WorkspaceApplications;
  #closing?: Promise<void>;

  constructor(readonly environment: NodeJS.ProcessEnv = process.env) {}

  /** Cancel producers before draining RPC requests; keep their stores open until they settle. */
  cancelPendingOperations(): void {
    this.#storage?.cancel();
    this.#sessionIndex?.close();
    this.#commands.close();
    this.#mcp?.close();
  }

  close(): Promise<void> {
    return this.closeAsync();
  }

  #reset(): void {
    this.#storage?.cancel();
    this.#storage = undefined;
    this.#quota = undefined;
    this.#claudeManaged?.close();
    this.#claudeManaged = undefined;
    this.#sessionIndex?.close();
    this.#sessionIndex = undefined;
    this.#insightRefresh = undefined;
    this.#obsidian = undefined;
    this.#skills = undefined;
    this.#agentTools = undefined;
    this.#mcp?.close();
    this.#mcp = undefined;
    this.#mcpHub = undefined;
    this.#mcpOAuth = undefined;
    this.#remoteGateways = undefined;
    this.#remoteAgent = undefined;
    this.#webRead?.close();
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
    const mcp = this.#mcp;
    const mcpHub = this.#mcpHub;
    const remoteAgent = this.#remoteAgent;
    this.#claudeManaged = undefined;
    this.#mcpHub = undefined;
    this.#remoteAgent = undefined;
    const closing = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => mcp?.closeAsync()),
        Promise.resolve().then(() => claudeManaged?.shutdown()),
        Promise.resolve().then(() => mcpHub?.close()),
        Promise.resolve().then(() => remoteAgent?.close()),
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
        this.#skills = new Skills({ ...process.env, ...this.environment }, dataDir);
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
        );
        this.#sessionIndex = new SessionIndex(store.sessions, this.#sessions, () => {
          const value = readPreferences(dataDir).session_index_enabled;
          return typeof value === "boolean" ? value : true;
        });
        this.#remoteAgent = new RemoteAgent(dataDir, store, this.#sessions, this.#sessionIndex);
        return Promise.all([this.#mcpHub.start(), this.#remoteAgent.start()]);
      });
    }
    if (!this.#store || !this.#dataDir)
      throw new RpcFault(-32000, "AgentKib command failed", {
        detail: "TypeScript backend has not been initialized",
      });
    if (method === RUNTIME_METHODS.controlReceipt) {
      const receipt = readControlReceipt(this.#dataDir, params);
      return this.#claudeManaged ? this.#claudeManaged.receipt(receipt) : receipt;
    }
    if (method === RUNTIME_METHODS.claudeManaged) return this.#claudeManaged!.request(params);
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
      if (params.operation === "live") return this.#withWebRead((owner) => owner.request(params));
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
        ].includes(String(params.operation))
      )
        return this.#withWebRead((owner) => owner.managedControl(params));
      if (
        params.operation === "catalog" ||
        params.operation === "events" ||
        params.operation === "context" ||
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
        const aliases = this.#claudeManaged!.indexedAliases();
        const sessions = Array.isArray(catalog.sessions) ? catalog.sessions : [];
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
            ...records,
          ],
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
    if (method === RUNTIME_METHODS.cursorBridge) return this.#cursorBridge!.request(params);
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
    if (method === RUNTIME_METHODS.prepareSessionHandoff)
      return prepareSessionHandoff(
        params,
        this.#sessions!,
        this.#store.sessions,
        this.#store,
        this.#commands!,
        { ...process.env, ...this.environment },
        this.#cursorBridge,
      );
    if (method === RUNTIME_METHODS.planSessionHandoff)
      return planSessionHandoff(
        params,
        this.#sessions!,
        this.#store.sessions,
        this.#store,
        this.#dataDir,
        { ...process.env, ...this.environment },
        this.#commands,
        this.#cursorBridge,
      );
    if (method === RUNTIME_METHODS.planSessionMcpConnection)
      return planSessionMcpConnection(params, this.#store);
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
    if (method === RUNTIME_METHODS.launchSessionHandoff)
      return prepareHandoffLaunch(
        params,
        this.#store,
        this.#commands,
        {
          ...process.env,
          ...this.environment,
        },
        this.#dataDir,
      ).then((prepared) =>
        launchPreparedHandoff(prepared, this.#dataDir!, { ...process.env, ...this.environment }),
      );
    if (method === RUNTIME_METHODS.sanitizeSessionHandoff) {
      const request = parameters(
        z.object({ format: handoffFormat, editedContent: z.string() }),
        params,
      );
      return sanitizeHandoffExport(request.editedContent, request.format);
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
        return this.#sessionIndex!.refresh(params);
      case RUNTIME_METHODS.clearSessionIndex:
        return this.#sessionIndex!.clear(params);
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
        return planWorkspace(
          project,
          manifest,
          includeHome
            ? {
                openclaw_config: path.join(home, ".openclaw/openclaw.json"),
                hermes_config: path.join(home, ".hermes/config.yaml"),
              }
            : {},
        );
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
      case RUNTIME_METHODS.prepareManifest:
        return prepareManifest(string(params, "project"));
      case BACKEND_DEFAULT_MANIFEST:
        return defaultManifest(string(params, "project"));
      case BACKEND_PLAN_PROJECT_ASSETS: {
        const { project, manifest } = parameters(
          z.object({ project: z.string(), manifest: manifestSchema }),
          params,
        );
        return planWorkspace(project, manifest, {});
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
        if (method === RUNTIME_METHODS.setSessionIndexEnabled) this.#sessionIndex!.invalidate();
        writePreferences(this.#dataDir, {
          [keys[method]!]: params[aliases[0]!],
          ...(method === RUNTIME_METHODS.setQuotaAutoRefresh
            ? { quota_auto_refresh_prompt_seen: true }
            : {}),
        });
        if (method === RUNTIME_METHODS.setSessionIndexEnabled && !params[aliases[0]!])
          this.#store.sessions.clear(null);
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
        return this.#store.listWorkspaces();
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
        return scanNativeMcp({ project: request.project ?? undefined }, this.#store!, {
          ...process.env,
          ...this.environment,
        });
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
          this.#commands,
        );
      } catch (error) {
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
          this.#commands,
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
      this.#commands,
      environment,
      this.#dataDir,
    );
    applySessionHandoff(value, this.#store!, this.#dataDir!, environment);
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
      );
    }
    return await operation(this.#webRead);
  }

  #setChoice(params: Record<string, unknown>, key: string, values: string[]): unknown {
    if (typeof params.preference !== "string" || !values.includes(params.preference))
      invalid(`Invalid ${key}`);
    writePreference(this.#dataDir!, key, params.preference);
    return this.#preferences();
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
