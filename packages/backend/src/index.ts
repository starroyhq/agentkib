import { Context } from "./context";
import { SessionReaders } from "./session-readers";
import { SessionSubagentSnapshots, type SubagentSnapshot } from "./session-subagent-snapshots";
import { withSessionActivities } from "./session-activities";
import {
  continueCursorNativeImport,
  CursorImportOutcomeUnknownError,
  reconcileCursorNativeImport,
} from "./cursor-native-import";
import { CursorBridge } from "./cursor-bridge";
import { ClaudeBridge, type ClaudeBridgeTarget } from "./agents/claude/claude-bridge";
import { ClaudeBridgePluginUpdater } from "./agents/claude/claude-bridge-plugin-update";
import { readClaudeTranscriptObservation } from "./agents/claude/claude-context-usage";
import { ClaudeSessionProvider } from "./agents/claude/session-provider";
import type { CodexSessionProvider } from "./agents/codex/session-provider";
import { DSH_EXECUTION_MODE, DSH_NATIVE_TURN_OBSERVED, DshBridge } from "./agents/dsh/dsh-bridge";
import { DshHistoryImport, validateDshImportApplicationData } from "./agents/dsh/history-import";
import { readLocalDshHistory, readLocalDshTurn } from "./agents/dsh/dsh-local-history";
import { DshManagedRuntime, dshHome } from "./agents/dsh/dsh-managed-runtime";
import { dshSessionDirectory, probeDshWriter } from "./agents/dsh/dsh-writer";
import { DshLaneWatch, DshLeadWatch } from "./agents/dsh/dsh-lanes";
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
import {
  launchDshHandoff,
  launchDevinTerminal,
  launchPreparedHandoff,
  prepareHandoffLaunch,
} from "./session-handoff-launch";
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
import { markPossiblyOverwritten } from "./agents/claude/claude-global-writes";
import { scanNativeMcp } from "./mcp-native-scan";
import { planNativeMcpMigration } from "./mcp-migration-plan";
import { webDiff } from "./web-diff";
import type { WebReadRequests } from "./web-read";
import { DshSessionProvider } from "./agents/dsh/session-provider";
import {
  isSessionMethod,
  legacySessionFields,
  readHostSessionRequest,
  readSessionRequest,
  restrictSessionCommands,
  type HostSessionRequest,
  type SessionMethod,
} from "./sessions/routing";
import { QUIT_WORK_MANUAL_REASON, QuitWork, quitWorkDecisionSchema } from "./sessions/quit-work";
import { SessionApprovalAuditStore } from "./sessions/approval-audit";
import {
  approvalAuditDecision,
  approvalAuditEvidence,
  approvalAuditIdentitySchema,
  approvalAuditListSchema,
  approvalAuditReceipt,
  classifyAuditDecision,
  expiredApprovalAuditSchema,
  isApprovalDecision,
  recordApprovalDecision,
  recordExpiredApproval,
  type ApprovalAuditTarget,
} from "./sessions/approval-audit-decisions";
import { hostControlValidationSchema, runProviderValidation } from "./sessions/validate/control";
import { RemoteGateways } from "./remote-gateways";
import { RemoteAgent } from "./remote-agent";
import { WorkspaceStorageOwner } from "./storage";
import { QuotaOwner } from "./quota";
import {
  ClaudeHostControlPreflightError,
  ClaudeManagedReadOwner,
} from "./agents/claude/claude-managed-read";
import { ClaudeHostStateStore } from "./agents/claude/claude-host-state";
import {
  OrchestrationService,
  type LaneHost,
  type SessionRole,
  type WorkerObserver,
} from "./orchestration-service";
import { createRelayCsr } from "./relay-csr";
import { readControlReceipt } from "./control-receipt";
import { ConversationReadStates } from "./conversation-read-state";
import { isSessionPinRow, SessionPins } from "./session-pins";
import { resolveClaudeConfig } from "./agents/claude/claude-config";
import { WorkspaceApplications } from "./workspace-applications";
import { nativeContext } from "./native-context";
import { discoverScanRoots } from "./discovery-scan-roots";
import { discoverConfiguredWorkspaces } from "./native-discovery-configured";
import { Doctor, StoredDoctorSummaries } from "./doctor";
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
import os from "node:os";
import { devinExecutable } from "./agents/devin/devin-executable";
import type { DevinSessionProvider } from "./agents/devin/session-provider";
import { antigravityAcpEnabled } from "./agents/antigravity/acp-enabled";
import type { AntigravitySessionProvider } from "./agents/antigravity/session-provider";
import { DEVIN_EXECUTION_MODE, devinChildEnvironment } from "./agents/devin/devin-managed-runner";
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
  PROJECT_AGENT_MAX_WORKERS,
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  sessionCollection,
  managedAgentOf,
  type SessionApprovalAuditContext,
  sessionProviderDeclaration,
  type QuitWorkDecision,
  type RuntimeRpcError,
  type SessionStreamEvent,
  type SubagentCatalog,
} from "@agentkib/runtime-protocol";
import { SessionStreamHub } from "./session-stream";
import { mergeCodexFollowerSnapshot } from "./agents/codex/codex-follower-stream";
import { SessionSnapshotHistory } from "./session-snapshot-history";
import { readManagedUsageLimit, retainManagedLedgerReaders } from "./managed-ledger";
import { LeadReportNotDispatched, MessageLeadReports } from "./message-lead-reports";
import { parseUsageLimit, usageLimitAutoContinue, usageLimitView } from "./usage-limit";
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
import { haltOwnTurns } from "./lead-turn-origin";

const HANDOFF_TASK_METHODS = new Set<string>([
  RUNTIME_METHODS.prepareSessionHandoff,
  RUNTIME_METHODS.planSessionHandoff,
  RUNTIME_METHODS.continueSessionHandoff,
  RUNTIME_METHODS.launchSessionHandoff,
]);

import { NativeMemoryOwner } from "./native-memory";
import { NATIVE_MEMORY_CHANGED } from "@agentkib/runtime-protocol";

const nativeMemoryQuerySchema = z
  .object({
    workspaceId: z.string().min(1).max(256).optional(),
    sourceId: z.string().min(1).max(256).optional(),
    query: z.string().max(512).optional(),
    offset: z.number().int().min(0).max(1000000).optional(),
  })
  .strict();

export { quitWorkDecisionSchema };

export class TypeScriptBackend {
  #instructionImports = new InstructionImports();
  #store?: BackendStore;
  #nativeMemory?: NativeMemoryOwner;
  #quitWork?: QuitWork;
  #dataDir?: string;
  #approvalAudit?: SessionApprovalAuditStore;
  #releaseManagedLedgerReaders?: () => void;
  #commands = new Commands();
  #git?: Git;
  #context?: Context;
  #doctor?: Doctor;
  #sessions?: SessionReaders;
  #sessionStream?: SessionStreamHub;
  #snapshotHistory?: SessionSnapshotHistory;
  #childSnapshots = new SessionSubagentSnapshots();
  #activitySnapshots = new SessionSubagentSnapshots(2_000, new Set(["deepseek-harness", "devin"]));
  #cursorBridge?: CursorBridge;
  #claudeBridge?: ClaudeBridge;
  #claudeSessionProvider?: ClaudeSessionProvider;
  #dshBridge?: DshBridge;
  #dshSessionProvider = new DshSessionProvider();
  /** Reports DeepSeek Harness workers' turns from the states the DSH bridge publishes. */
  #dshLanes?: DshLaneWatch;
  /** A DSH Project Agent's turns, counted when nobody sent them (`DshLeadWatch`). */
  #dshLeads?: DshLeadWatch;
  #catalogContinuation = new Map<string, string>();
  #webRead?: WebReadRequests;
  #readStates?: ConversationReadStates;
  #sessionPins?: SessionPins;
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
  /** Leads and their lanes (`orchestration-service.ts`). */
  #orchestration?: OrchestrationService;
  #workspaceApplications?: WorkspaceApplications;
  #closing?: Promise<void>;

  constructor(
    readonly environment: NodeJS.ProcessEnv = process.env,
    readonly notify: (method: string, params: unknown) => void = () => {},
  ) {}

  /** Cancel producers before draining RPC requests; keep their stores open until they settle. */
  cancelPendingOperations(): void {
    this.#stopping = true;
    this.#nativeMemory?.close();
    this.#skills?.stop();
    this.#historySearch?.stop();
    this.#handoffQueue.stop();
    this.#storage?.cancel();
    this.#quota?.stop();
    this.#sessionIndex?.close();
    this.#commands.close();
    this.#mcp?.close();
  }

  /** A desktop has opened this runtime. Recover at most once in its lifetime. */
  activateQuitWork(): void {
    if (!this.#stopping) this.#quitWork?.start();
  }

  async prepareUpgradeQuitWork(): Promise<QuitWorkDecision | undefined> {
    try {
      const preview = await this.#quitWork?.prepare();
      return preview?.work.length ? { ticket: preview.ticket, resume: true } : undefined;
    } catch {
      console.error("AgentKib could not prepare interrupted work before an upgrade");
      return undefined;
    }
  }

  close(): Promise<void> {
    return this.closeAsync();
  }

  #reset(): void {
    this.#quitWork = undefined;
    this.#instructionImports.clear();
    this.#nativeMemory?.close();
    this.#nativeMemory = undefined;
    this.#sessionStream?.close();
    this.#sessionStream = undefined;
    this.#snapshotHistory?.invalidate();
    this.#snapshotHistory = undefined;
    this.#childSnapshots.invalidate();
    this.#activitySnapshots.invalidate();
    this.#storage?.cancel();
    this.#storage = undefined;
    this.#quota = undefined;
    this.#claudeManaged?.close();
    void this.#orchestration?.close();
    this.#orchestration = undefined;
    this.#dshLanes?.close();
    this.#dshLanes = undefined;
    this.#dshLeads?.close();
    this.#dshLeads = undefined;
    void this.#claudeBridge?.close();
    this.#claudeBridge = undefined;
    this.#claudeSessionProvider = undefined;
    void this.#dshBridge?.close();
    this.#dshBridge = undefined;
    this.#dshSessionProvider = new DshSessionProvider();
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
    void this.#readStates?.close();
    this.#readStates = undefined;
    this.#sessionPins = undefined;
    this.#commands.close();
    this.#git = undefined;
    this.#context = undefined;
    this.#doctor = undefined;
    this.#releaseManagedLedgerReaders?.();
    this.#releaseManagedLedgerReaders = undefined;
    this.#store?.close();
    this.#store = undefined;
    this.#dataDir = undefined;
    this.#approvalAudit = undefined;
  }

  closeAsync(quitWorkDecision?: QuitWorkDecision, upgrade = false): Promise<void> {
    if (this.#closing) return this.#closing;
    this.cancelPendingOperations();
    const claudeManaged = this.#claudeManaged;
    const claudeBridge = this.#claudeBridge;
    const dshBridge = this.#dshBridge;
    const mcp = this.#mcp;
    const mcpHub = this.#mcpHub;
    const remoteAgent = this.#remoteAgent;
    const webRead = this.#webRead;
    const readStates = this.#readStates;
    const orchestration = this.#orchestration;
    this.#readStates = undefined;
    this.#sessionPins = undefined;
    this.#orchestration = undefined;
    this.#dshLanes?.close();
    this.#dshLanes = undefined;
    this.#dshLeads?.close();
    this.#dshLeads = undefined;
    this.#claudeManaged = undefined;
    this.#claudeSessionProvider = undefined;
    this.#dshBridge = undefined;
    this.#dshSessionProvider = new DshSessionProvider();
    this.#mcpHub = undefined;
    this.#remoteAgent = undefined;
    const closing = (async () => {
      const stopWork = upgrade
        ? this.#quitWork?.stop(quitWorkDecision, true)
        : this.#quitWork?.stop(quitWorkDecision);
      await stopWork?.catch(() => {
        console.error("AgentKib could not save the interrupted work journal");
      });
      this.#claudeBridge = undefined;
      const results = await Promise.allSettled([
        this.#skills?.close(),
        orchestration?.close(),
        this.#historySearch?.close(),
        this.#handoffQueue.drain().then(() => this.#handoffWork.close()),
        Promise.resolve().then(() => mcp?.closeAsync()),
        Promise.resolve().then(() => claudeManaged?.shutdown()),
        Promise.resolve().then(() => claudeBridge?.close()),
        Promise.resolve().then(() => dshBridge?.close()),
        Promise.resolve().then(() => mcpHub?.close()),
        Promise.resolve().then(() => remoteAgent?.close()),
        // Native CLI processes must release their workspace before shutdown is
        // acknowledged and the backing stores (or temporary workspace) close.
        Promise.resolve().then(() => webRead?.closeAsync()),
        Promise.resolve().then(() => readStates?.close()),
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
          "quit-work",
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
          "native-memory",
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
      const decision = quitWorkDecisionSchema.safeParse(params.quitWork).data;
      if (!decision && params.reason === "application-update")
        return this.prepareUpgradeQuitWork()
          .then((prepared) => this.closeAsync(prepared, true))
          .then(() => null);
      return this.closeAsync(decision).then(() => null);
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
        this.#approvalAudit = new SessionApprovalAuditStore(dataDir);
        this.#releaseManagedLedgerReaders = retainManagedLedgerReaders(dataDir);
        this.#nativeMemory = new NativeMemoryOwner({
          store,
          environment: { ...process.env, ...this.environment },
          notify: () => this.notify(NATIVE_MEMORY_CHANGED, {}),
        });
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
        this.#quota = new QuotaOwner(
          store,
          this.#commands,
          dataDir,
          { ...process.env, ...this.environment },
          this.notify,
        );
        this.#quota.setCostAutoRefresh(
          readPreferences(dataDir).quota_auto_refresh_enabled === true,
        );
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
        this.#doctor = new Doctor(
          this.#context,
          (id) => store.workspacePath(id),
          new StoredDoctorSummaries(store.sql),
        );
        this.#workspaceApplications = new WorkspaceApplications(
          dataDir,
          this.#commands,
          { ...process.env, ...this.environment },
          (id) => store.workspacePath(id),
        );
        const agentkibHome =
          this.environment.AGENTKIB_HOME ??
          path.join(
            userHome({ ...process.env, ...this.environment }),
            this.environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev"
              ? ".agentkib-dev"
              : ".agentkib",
          );
        // The innermost registered workspace containing a native working directory.
        const registeredWorkspace = (cwd: string) => {
          let directory: string;
          try {
            directory = canonicalize(cwd);
          } catch {
            return null;
          }
          return (
            (store.listWorkspaces() as { id: string; path: string }[])
              .filter(
                (row) => directory === row.path || directory.startsWith(`${row.path}${path.sep}`),
              )
              .sort((a, b) => b.path.length - a.path.length)[0] ?? null
          );
        };
        const dshPluginDirectory = this.environment.AGENTKIB_DSH_PLUGIN_DIR ?? "";
        const dshEnvironment = { ...process.env, ...this.environment };
        const dshStorage = dshHome(dshEnvironment);
        // DSH started in the background when none of the user's runs; the bridge decides when
        // and stops it on close.
        const dshManaged = dshPluginDirectory
          ? new DshManagedRuntime({
              dataDir,
              agentkibHome,
              pluginDirectory: dshPluginDirectory,
              env: dshEnvironment,
              onExit: (pid) => dshBridge.managedExited(pid),
            })
          : undefined;
        const dshBridge = new DshBridge({
          dataDir,
          bootId: randomUUID(),
          pluginDirectory: dshPluginDirectory,
          discoveryFile: path.join(agentkibHome, "dsh-bridge", "discovery-v1.json"),
          ...(dshManaged ? { managed: { runtime: dshManaged } } : {}),
          sessionId: (nativeId) => store.sessions.id("deepseek-harness", nativeId),
          writerStatus: (nativeId, cwd) => probeDshWriter(nativeId, cwd, dshStorage),
          localHistory: async (nativeId, cwd, before, limit) => {
            const directory = dshSessionDirectory(nativeId, cwd, dshStorage);
            return directory ? readLocalDshHistory(directory, nativeId, before, limit) : null;
          },
          localTurn: async (nativeId, cwd, previous) => {
            const directory = dshSessionDirectory(nativeId, cwd, dshStorage);
            return directory ? readLocalDshTurn(directory, nativeId, previous) : null;
          },
          workspaceFor: registeredWorkspace,
          workspacePath: (workspaceId) => {
            try {
              return store.workspacePath(workspaceId);
            } catch {
              return null;
            }
          },
          sessionsChanged: (workspaceIds) => {
            // Write only the DSH listing; a full refresh would rescan every other source too.
            if (this.#store !== store || readPreferences(dataDir).session_index_enabled === false)
              return;
            let changed = false;
            for (const workspaceId of workspaceIds)
              try {
                store.sessions.sync(
                  workspaceId,
                  "deepseek-harness",
                  dshBridge.list(store.workspacePath(workspaceId)).sessions,
                  true,
                );
                changed = true;
              } catch {
                // A removed workspace or closed store; the next index pass lists it again.
              }
            if (changed) this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] });
          },
          publish: (id, type, payload, live) => {
            this.#publishSession(id, type, payload, live);
            if (type === "state" && live.reason !== DSH_NATIVE_TURN_OBSERVED) {
              this.#dshLanes?.observe(id, live);
              this.#dshLeads?.observe(id, live);
            }
          },
          // DSH sessions that are Project Agents get their worker tools from the plugin.
          lead: {
            sessions: () =>
              (this.#orchestration?.registry.list() ?? [])
                .map((lead) => lead.sessionId)
                .filter((sessionId) => dshBridge.handles(sessionId)),
            tools: (sessionId) => this.#orchestration?.leadToolSpecs(sessionId) ?? null,
            call: async (sessionId, name, input) =>
              this.#orchestration
                ? this.#orchestration.call(sessionId, name, input)
                : {
                    text: JSON.stringify({ accepted: false, reason: "orchestration-unavailable" }),
                    isError: true,
                  },
          },
        });
        this.#dshBridge = dshBridge;
        const dshProvider = new DshSessionProvider(dshBridge, (id, operation) =>
          this.#noteDshControl(id, operation),
        );
        this.#dshSessionProvider = dshProvider;
        this.#sessions = new SessionReaders(
          store.sessions,
          this.#commands,
          {
            ...process.env,
            ...this.environment,
          },
          this.#cursorBridge,
          dshBridge,
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
              this.#sessionStream?.aliasItem(
                sessionId,
                previousId,
                itemId,
                withSessionActivities(live, this.#childSnapshots.current(sessionId, live)),
              ),
            catalogChanged: () =>
              this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] }),
            forgetIndexed: (ids) =>
              this.#sessionIndex ? this.#sessionIndex.forget(ids) : store.sessions.forget(ids),
          },
          {
            isSessionObserved: (sessionId) =>
              this.#sessionStream?.hasSubscribers(sessionId) ?? false,
            isCatalogObserved: () => this.#sessionStream?.hasSubscribers("") ?? false,
            isSessionBridged: (sessionId) => {
              this.#claudeBridge?.assertRegistryValid();
              return this.#claudeBridge?.blocksManagedResume(sessionId) ?? false;
            },
            terminalHandover: {
              source: (sessionId) => this.#claudeBridge?.terminalHandoverSource(sessionId),
              finish: (source) => this.#claudeBridge?.finishTerminalHandover(source),
              reportOwner: (sessionId) => this.#orchestration?.status(sessionId)?.deviceId,
            },
            retainedTerminalUsage: (sessionId, source, observation, readEarlier) =>
              this.#claudeBridge?.retainedUsage(sessionId, source, observation, readEarlier),
            // On unless the person turned it off; a worker reads it when it starts.
            backgroundTasks: () => readPreferences(dataDir).claude_background_tasks !== false,
            leadTools: (sessionId) =>
              this.#orchestration?.leadTools(sessionId) ?? Promise.resolve(null),
            userSent: (sessionId) => {
              if (this.#orchestration?.status(sessionId)) this.#orchestration.userSpoke(sessionId);
            },
            selfTurn: (sessionId) => this.#orchestration?.leadSelfTurn(sessionId) ?? true,
          },
        );
        const leadOwner = this.#claudeManaged;
        // A lead is a Claude Code session AgentKib runs, or one connected from a terminal whose
        // plugin can take the worker tools; a connected terminal gets its reports there.
        const terminal = (sessionId: string) => this.#claudeBridge?.leadCapable(sessionId) === true;
        // A Codex session AgentKib runs, once its web services are loaded (#requestLead loads them).
        const codex = (sessionId: string) => this.#webRead?.codexLeadCapable(sessionId) === true;
        // A DSH session whose DSH gives a lead its tools (plugin 0.8.0), or one AgentKib can start.
        const dsh = (sessionId: string) => dshBridge.leadCapable(sessionId);
        // A Devin session AgentKib runs over ACP; each turn is offered the worker tools.
        const devin = (sessionId: string) => this.#webRead?.devinLeadCapable(sessionId) === true;
        // An Antigravity session AgentKib controls over ACP; its connection offers the tools.
        const antigravity = (sessionId: string) =>
          this.#webRead?.antigravityLeadCapable(sessionId) === true;
        this.#orchestration = new OrchestrationService(
          dataDir,
          leadOwner.bootId,
          this.#laneHost(store, dataDir, leadOwner.bootId),
          (sessionId) =>
            leadOwner.hasManagedSession(sessionId) ||
            terminal(sessionId) ||
            codex(sessionId) ||
            dsh(sessionId) ||
            devin(sessionId) ||
            antigravity(sessionId),
          async (sessionId, deviceId, text, ...admission) => {
            const checkAdmission = () => {
              const [canSend] = admission;
              if (canSend && !canSend())
                throw new LeadReportNotDispatched("report-authorization-changed");
            };
            if (
              !leadOwner.managedWorkspace(sessionId) &&
              this.#claudeBridge?.canQueueLeadReport(sessionId) === true
            ) {
              checkAdmission();
              return this.#claudeBridge.queueReport(sessionId, text, admission[1]);
            }
            // A quit report can arrive before the session catalog initializes the providers.
            if (
              !this.#webRead &&
              !leadOwner.hasManagedSession(sessionId) &&
              !dshBridge.handles(sessionId)
            )
              await this.#withWebRead(() => undefined).catch((error: unknown) => {
                throw new LeadReportNotDispatched("session-unavailable", { cause: error });
              });
            if (codex(sessionId) || devin(sessionId) || antigravity(sessionId))
              return this.#codexLeadReport(sessionId, deviceId, text, ...admission);
            // A DSH lead hears through the bridge, whether or not its DSH runs right now.
            if (dshBridge.handles(sessionId))
              return this.#dshLeadReports.send(sessionId, deviceId, text, ...admission);
            if (!leadOwner.hasManagedSession(sessionId))
              throw new LeadReportNotDispatched("session-unavailable");
            checkAdmission();
            return leadOwner.queueReport(sessionId, deviceId, text, admission[1]);
          },
          (sessionId) =>
            leadOwner.queuedReports(sessionId) +
            (this.#claudeBridge?.queuedReports(sessionId) ?? 0),
          (sessionId) => {
            if (this.#claudeBridge?.leadReportsPaused(sessionId)) return true;
            if (dshBridge.handles(sessionId))
              return dshBridge.live(sessionId, false).usageLimit != null ? "manual-resume" : false;
            return this.#webRead?.usageLimited(sessionId) === true;
          },
          () => this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] }),
          (sessionId, turnId) => this.#quitWork?.isUpgradeInterruption(sessionId, turnId) === true,
        );
        leadOwner.observeWorkers(this.#workerObserver);
        this.#dshLeads?.close();
        this.#dshLeads = new DshLeadWatch({
          isLead: (sessionId) => !!this.#orchestration?.status(sessionId),
          turnOrigin: (sessionId, turnId) => dshBridge.turnOrigin(sessionId, turnId),
          userSpoke: (sessionId) => this.#orchestration?.userSpoke(sessionId),
          ownTurn: (sessionId, turnId) => this.#leadOwnTurn(sessionId, turnId),
        });
        this.#dshLanes?.close();
        this.#dshLanes = new DshLaneWatch({
          isLane: (sessionId) => !!this.#orchestration?.registry.leadOfLane(sessionId),
          endedTurns: (sessionId) => dshBridge.endedTurns(sessionId),
          turnEnded: async (sessionId, turnId, outcome, durationMs) =>
            this.#orchestration?.laneTurnEnded(sessionId, turnId, outcome, durationMs),
          waiting: async (sessionId, turnId, status) =>
            this.#orchestration?.laneWaiting(sessionId, turnId, status),
        });
        const claudeOwner = this.#claudeManaged;
        const codexPinProvider = () =>
          this.#webRead?.codexSessionProvider() as CodexSessionProvider | undefined;
        this.#sessionPins = new SessionPins(store.sql, {
          codex: {
            states: (sessionIds) => codexPinProvider()?.pinStates(sessionIds) ?? new Map(),
            set: async (sessionId, pinned) => {
              const provider = codexPinProvider();
              if (!provider) throw new Error("session-pin-unavailable");
              return provider.setPinned(sessionId, pinned);
            },
          },
          "deepseek-harness": {
            states: (sessionIds) =>
              new Map(
                sessionIds.flatMap((id) => {
                  const state = dshBridge.pinState(id);
                  return state ? [[id, state] as const] : [];
                }),
              ),
            set: (sessionId, pinned) => dshBridge.setPinned(sessionId, pinned),
          },
        });
        this.#readStates = new ConversationReadStates(
          store,
          this.#sessions,
          dataDir,
          { ...process.env, ...this.environment },
          (id) => claudeOwner.readStateTarget(id),
          () => this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] }),
          () => this.#sessionStream?.hasSubscribers("") ?? false,
          (target) => this.#webRead?.codexActiveTurn(target) ?? null,
        );
        const readTerminalObservation = (target: ClaudeBridgeTarget, searchEarlier: boolean) => {
          const readers = this.#sessions!;
          const source = readers.claudeControlWorkspace(
            target.nativeId,
            target.registeredWorkspace,
          );
          const transcript = readers.verifiedClaudeControlTarget(target.nativeId, source);
          if (target.workspace !== source)
            readers.verifyClaudeBridgeWorktree(target.nativeId, source, target.workspace);
          const observation = readClaudeTranscriptObservation(
            transcript,
            target.nativeId,
            searchEarlier ? "terminal-usage" : false,
          );
          // Recheck the source after the bounded optional read, without touching a native worker.
          readers.verifiedClaudeControlTarget(target.nativeId, source);
          if (target.workspace !== source)
            readers.verifyClaudeBridgeWorktree(target.nativeId, source, target.workspace);
          return observation;
        };
        const claudePluginDirectory = this.environment.AGENTKIB_CLAUDE_PLUGIN_DIR ?? "";
        this.#claudeBridge = new ClaudeBridge({
          dataDir,
          legacyDataDir: this.environment.AGENTKIB_LEGACY_DEV_DATA_DIR,
          sessionIdForNative: (nativeId) => store.sessions.id("claude-code", nativeId),
          bootId: claudeOwner.bootId,
          pluginDirectory: claudePluginDirectory,
          ...(claudePluginDirectory && {
            pluginUpdate: new ClaudeBridgePluginUpdater({
              dataDir,
              environment: { ...process.env, ...this.environment },
              pluginDirectory: claudePluginDirectory,
            }),
          }),
          // A connected terminal session may be a Project Agent (docs/agents/project-agent.md).
          lead: {
            tools: (sessionId) => this.#orchestration?.leadToolSpecs(sessionId) ?? null,
            call: async (sessionId, name, input) => {
              if (!this.#orchestration) return { text: "orchestration-unavailable", isError: true };
              return this.#orchestration.call(sessionId, name, input);
            },
            userSpoke: (sessionId) => {
              if (this.#orchestration?.status(sessionId)) this.#orchestration.userSpoke(sessionId);
            },
            // Its CLI's own turns count as a managed one's do; past the limit the turn stops, in
            // the name of the device that set the Project Agent up.
            selfTurn: (sessionId) => {
              const lead = this.#orchestration?.status(sessionId);
              if (!lead) return null;
              return this.#orchestration!.leadSelfTurn(sessionId)
                ? null
                : { stopAs: lead.deviceId };
            },
            paused: (sessionId) => {
              const lead = this.#orchestration?.status(sessionId);
              return lead?.paused ? (lead.reason ?? "paused") : null;
            },
            reportPauseChanged: (sessionId, paused) => {
              const orchestration = this.#orchestration;
              const lead = orchestration?.status(sessionId);
              if (!orchestration || !lead) return;
              if (paused && !lead.paused) orchestration.pause(sessionId, "usage-limit");
              else if (!paused && lead.reason === "usage-limit")
                orchestration.limitEnded(sessionId);
            },
          },
          target: (id, nativeId, activeWorkspace) =>
            claudeOwner.nativeBridgeTarget(id, nativeId, activeWorkspace),
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
            const target = await claudeOwner
              .nativeBridgeTarget(id, nativeId, cwd)
              .catch((error) => {
                // A managed record can resolve without an index row. Diagnose absence only
                // after resolution fails, and keep other identity failures generic.
                if (
                  error instanceof Error &&
                  error.message === "session-not-controllable" &&
                  !store.sessions.get(id)
                )
                  throw new Error("session-not-indexed");
                throw error;
              });
            if (target.workspaceId !== workspace.id) throw new Error("session-workspace-mismatch");
            return target;
          },
          validate: (target, forControl, bindingId) => {
            if (readPreferences(dataDir).session_index_enabled === false)
              throw new Error("session-index-disabled");
            claudeOwner.validateNativeBridgeTarget(target, forControl, bindingId);
            if (!forControl) {
              const readers = this.#sessions!;
              const source = readers.claudeControlWorkspace(
                target.nativeId,
                target.registeredWorkspace,
              );
              readers.verifiedClaudeControlTarget(target.nativeId, source);
              if (target.workspace !== source)
                readers.verifyClaudeBridgeWorktree(target.nativeId, source, target.workspace);
            }
          },
          observation: (target) => readTerminalObservation(target, true),
          permission: (target) => {
            const recent = readTerminalObservation(target, false).permissionMode;
            // A long tool result can push the last mode marker beyond the small usage tail.
            return recent === undefined
              ? (readTerminalObservation(target, true).permissionMode ?? null)
              : recent;
          },
          publish: (id, type, payload, live) => this.#publishSession(id, type, payload, live),
          completed: (target, turnId, aborted, timing) =>
            this.#readStates?.recordTerminal(
              {
                provider: "claude-code",
                home: resolveClaudeConfig(
                  { ...process.env, ...this.environment },
                  userHome({ ...process.env, ...this.environment }),
                ).dir,
                nativeId: target.nativeId,
                workspace: target.workspace,
              },
              {
                id: `turn:${turnId}`,
                turnId,
                itemId: null,
                outcome: aborted ? "cancelled" : "ended",
                completedAt: timing.occurredAt ? new Date(timing.occurredAt).toISOString() : null,
              },
              { turnStartedAt: timing.startedAt ? new Date(timing.startedAt).toISOString() : null },
            ),
        });
        const claudeProvider = new ClaudeSessionProvider(
          claudeOwner,
          this.#claudeBridge,
          (params, result) => this.#deleted(params, result),
          this.#workerObserver.controlled,
          (sessionId) => this.#orchestration?.status(sessionId)?.deviceId,
        );
        this.#claudeSessionProvider = claudeProvider;
        const orchestration = this.#orchestration;
        const withQuitProvider = async <T>(
          agent: string,
          run: (provider: ClaudeSessionProvider | CodexSessionProvider | DshSessionProvider) => T,
        ): Promise<Awaited<T> | undefined> => {
          if (!sessionProviderDeclaration(agent)?.resumeAfterQuit) return;
          if (agent === "claude-code") return await run(claudeProvider);
          if (agent === "deepseek-harness") return await run(dshProvider);
          if (agent === "codex")
            return this.#withWebRead((owner) => run(owner.codexSessionProvider()));
        };
        this.#quitWork = new QuitWork(dataDir, {
          sessions: () => this.#quitWorkSessions(),
          resumeByDefault: () => readPreferences(dataDir).resume_after_quit !== false,
          candidate: ({ sessionId, agent }) =>
            withQuitProvider(agent, (provider) => provider.quitCandidate(sessionId)),
          assignment: (sessionId) => {
            const owner = orchestration.registry.leadOfLane(sessionId);
            return owner ? { leadId: owner.lead.sessionId, laneId: owner.lane.id } : undefined;
          },
          interrupt: ({ sessionId, agent }, turnId) =>
            withQuitProvider(agent, (provider) => provider.interruptForQuit(sessionId, turnId)),
          check: async ({ sessionId, agent, evidence }) =>
            (await withQuitProvider(agent, (provider) =>
              provider.checkAfterQuit(sessionId, evidence),
            )) ?? false,
          dispatch: async ({ sessionId, agent, evidence, id }, text) =>
            (await withQuitProvider(agent, (provider) =>
              provider.resumeAfterQuit(sessionId, evidence, id, text),
            )) ?? "skipped",
          receipt: ({ id, sessionId, agent, evidence }) => {
            const mode =
              agent === "codex"
                ? "codex-managed"
                : agent === "deepseek-harness"
                  ? "dsh-follower"
                  : "claude-managed";
            const receipt = readControlReceipt(dataDir, {
              requestId: id,
              deviceId: "desktop-local",
            });
            if (
              !receipt.found ||
              !("sessionId" in receipt) ||
              receipt.sessionId !== sessionId ||
              receipt.operation !== "send" ||
              receipt.executionMode !== mode
            )
              return "unknown";
            if (receipt.status === "accepted") {
              if (agent === "claude-code") claudeProvider.restoreQuitQueue(sessionId, evidence);
              return "continued";
            }
            if (
              receipt.status === "not-dispatched" &&
              typeof receipt.ack === "object" &&
              receipt.ack !== null &&
              "reason" in receipt.ack &&
              receipt.ack.reason === QUIT_WORK_MANUAL_REASON
            )
              return "manual-required";
            return receipt.status === "not-dispatched" ? "skipped" : "unknown";
          },
          report: ({ sessionId, turnId, upgrade }, assignment, outcome) =>
            orchestration.workerInterruptedByQuit(sessionId, turnId, outcome, assignment, upgrade),
        });
        this.#claudeBridge.observeWorkers(this.#workerObserver);
        this.#claudeBridge.initialize();
        dshBridge.initialize();
        this.#historySearch = new HistorySearch(
          store,
          dataDir,
          { ...process.env, ...this.environment },
          this.#cursorBridge,
          { dsh: () => this.#dshBridge },
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
          () => this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] }),
        );
        this.#stopping = false;
        const runtimeBootId = randomUUID();
        const snapshotHistory = new SessionSnapshotHistory(
          (ids) => this.#sessions?.hasImageReferences(ids) === true,
        );
        this.#snapshotHistory = snapshotHistory;
        this.#sessionStream = new SessionStreamHub(
          runtimeBootId,
          async (sessionId) => {
            if (sessionId === "") {
              const catalog = await this.#request(RUNTIME_METHODS.sessionRequest, {
                host: { request: { operation: "catalog" } },
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
            const liveValue = await this.#request(RUNTIME_METHODS.sessionRequest, {
              host: { request: { operation: "live", sessionId, experimentalEnabled: true } },
            });
            const live =
              liveValue && typeof liveValue === "object" && !Array.isArray(liveValue)
                ? (liveValue as Record<string, unknown>)
                : { sessionId, status: "unsupported" };
            // Keep optional child summaries on the existing parent stream. A failure must not
            // break the parent conversation or preserve an unverified running count.
            delete live.subagents;
            const subagents = await this.#readStreamSubagents(sessionId, live);
            live.subagents = subagents;
            const readHistory = async () => {
              // Polled every 250 ms. A kept cursor per poll would push the cursors that
              // clients hold for older pages out of the shared cache within seconds.
              const pageValue = await this.#request(RUNTIME_METHODS.sessionRequest, {
                host: {
                  request: {
                    operation: "events",
                    sessionId,
                    cursor: null,
                    limit: 100,
                    retainCursor: false,
                  },
                },
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
            const web = this.#webRead;
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
                      return version === null
                        ? null
                        : JSON.stringify([String(generation), version]);
                    },
                    readHistory,
                  )
                : web
                  ? await snapshotHistory.read(
                      sessionId,
                      async () => {
                        if (this.#webRead !== web) throw new Error("session-unavailable");
                        const version = await web.indexedCodexHistoryVersion(sessionId);
                        if (this.#webRead !== web) throw new Error("session-unavailable");
                        return version;
                      },
                      readHistory,
                    )
                  : await readHistory();
            const follower = this.#webRead?.readFollowerSnapshot(sessionId);
            return {
              live: withSessionActivities(
                live,
                this.#usesStreamSubagents(live)
                  ? subagents
                  : this.#currentActivitySubagents(sessionId, live),
              ),
              ...(follower ? mergeCodexFollowerSnapshot(history, follower) : history),
            };
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
        this.#remoteAgent = new RemoteAgent(
          dataDir,
          store,
          this.#sessions,
          this.#sessionIndex,
          this.#readStates,
        );
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
    if (method === RUNTIME_METHODS.quitWorkPrepare) {
      parameters(z.object({}).strict(), params);
      return this.#quitWork!.prepare();
    }
    if (method === RUNTIME_METHODS.quitWorkList) {
      parameters(z.object({}).strict(), params);
      return this.#quitWork!.list();
    }
    if (method === RUNTIME_METHODS.quitWorkResume) {
      const { id } = parameters(z.object({ id: z.uuid() }).strict(), params);
      return this.#quitWork!.resume(id);
    }
    if (method === RUNTIME_METHODS.nativeMemoryList)
      return this.#nativeMemory!.snapshot(parameters(nativeMemoryQuerySchema, params));
    if (method === RUNTIME_METHODS.nativeMemorySearch)
      return this.#nativeMemory!.search(parameters(nativeMemoryQuerySchema, params));
    if (method === RUNTIME_METHODS.nativeMemoryRead) {
      const value = parameters(z.object({ fileId: z.string().min(1).max(256) }).strict(), params);
      return this.#nativeMemory!.read(value.fileId);
    }
    if (method === RUNTIME_METHODS.nativeMemoryRefresh) {
      parameters(z.object({}).strict(), params);
      return this.#nativeMemory!.refresh();
    }
    if (method === RUNTIME_METHODS.nativeMemoryObserve) {
      const value = parameters(z.object({ active: z.boolean() }).strict(), params);
      this.#nativeMemory!.observe("desktop", value.active);
      return null;
    }
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
      const dshReceipt = this.#dshBridge?.receipt(receipt) ?? receipt;
      const nativeReceipt = this.#claudeBridge?.receipt(dshReceipt) ?? dshReceipt;
      const result = this.#claudeManaged
        ? this.#claudeManaged.receipt(nativeReceipt)
        : nativeReceipt;
      this.#settleApprovalAuditReceipt(result, params.deviceId);
      return result;
    }
    if (isSessionMethod(method)) return this.#routeSession(method, params);
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
          // A DSH session is read whole through the running DSH; asking whether it can be read
          // must not read it every time a session is shown.
          native.agent === "deepseek-harness"
            ? (this.#dshBridge?.documentStatus(native.native_ref) ?? {
                status: "unavailable",
                reason: "dsh-runtime-offline",
              })
            : this.#sessions!.document(sessionId).then(() => ({
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
      const { workspaceId, readerScope } = parameters(
        z.object({ workspaceId: z.string(), readerScope: z.string().min(1).max(512).optional() }),
        params,
      );
      return this.#sessionIndex!.read(workspaceId).then(async (rows) => {
        const projected = await this.#withIndexedPins(rows);
        return readerScope ? this.#readStates!.project(projected, readerScope) : projected;
      });
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
        return this.#sessionIndex!.refresh(params).then((rows) => this.#withIndexedPins(rows));
      case RUNTIME_METHODS.clearSessionIndex:
        this.#snapshotHistory?.invalidate();
        this.#sessionIndex!.clear(params);
        return this.#historySearch!.clear().then(() => null);
      case RUNTIME_METHODS.applyChanges: {
        const request = params as { launchRequest?: { mode?: unknown; target_agent?: unknown } };
        const environment = { ...process.env, ...this.environment };
        return applyRequest(
          params,
          this.#store,
          this.#dataDir,
          environment,
          request.launchRequest?.mode === "native-import"
            ? (plan, applicationId, dataDir) => {
                if (request.launchRequest?.target_agent === "deepseek-harness")
                  return [
                    validateDshImportApplicationData(
                      plan,
                      request.launchRequest,
                      applicationId,
                      dataDir,
                    ),
                  ];
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
      case RUNTIME_METHODS.refreshDoctorSummaries: {
        const { maxAgeMs } = parameters(
          z.object({ maxAgeMs: z.number().int().nonnegative().optional() }),
          params,
        );
        return this.#doctor!.refresh(this.#store.workspaceIds(), maxAgeMs);
      }
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
        if (method === RUNTIME_METHODS.addWorkspace) return this.#store.getWorkspace(id);
        // Workspace lists read kept summaries, so a workspace the user refreshes is diagnosed now
        // rather than keeping its old result until the next background refresh. An added one is
        // opened next, and its page runs the full report, which keeps its summary.
        return this.#doctor!.update(id).then(() => this.#store!.getWorkspace(id));
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
        return this.#quota!.refresh(
          params.provider === undefined ? undefined : string(params, "provider"),
        );
      case RUNTIME_METHODS.localCostSnapshot:
        return this.#quota!.costSnapshot(localCostProvider(params.provider));
      case RUNTIME_METHODS.localCostStatus:
        return this.#quota!.costStatus(localCostProvider(params.provider));
      case RUNTIME_METHODS.refreshLocalCost:
        if (params.force !== undefined && typeof params.force !== "boolean")
          invalid("Expected boolean force");
        return this.#quota!.refreshCost(localCostProvider(params.provider), params.force === true);
      case RUNTIME_METHODS.observeLocalCosts:
        return this.#quota!.observeCosts(
          params.provider === null ? null : localCostProvider(params.provider),
          readPreferences(this.#dataDir).quota_auto_refresh_enabled === true,
        );
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
        if (method === RUNTIME_METHODS.setQuotaAutoRefresh)
          this.#quota!.setCostAutoRefresh(params[aliases[0]!] === true);
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
      case RUNTIME_METHODS.setQuitResumePreference: {
        const { value } = parameters(z.object({ value: z.boolean() }).strict(), params);
        writePreference(this.#dataDir, "resume_after_quit", value);
        return this.#preferences();
      }
      case RUNTIME_METHODS.setLocale: {
        if (typeof params.preference !== "string") invalid("Locale preference must be a string");
        // An older client still names Traditional Chinese "zh-TW"; it is saved as "zh-Hant".
        if (params.preference === "zh-TW") params = { ...params, preference: "zh-Hant" };
        if (!["system", "en-US", "zh-CN", "zh-Hant", "ja-JP"].includes(params.preference as string))
          throw new Error(`Unsupported locale preference: ${String(params.preference)}`);
        return this.#setChoice(params, "locale_preference", [
          "system",
          "en-US",
          "zh-CN",
          "zh-Hant",
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
        this.#dshBridge,
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
        this.#dshBridge,
      );
    // DSH continues a handoff file as a new session in the running DSH, not in a terminal.
    if (
      method === RUNTIME_METHODS.launchSessionHandoff &&
      params.mode === "handoff-file" &&
      params.target_agent === "deepseek-harness"
    )
      return launchDshHandoff(params, this.#store!, this.#dshBridge);
    if (method === RUNTIME_METHODS.continueSessionHandoff)
      return this.#continueSessionHandoff(params);
    if (
      method === RUNTIME_METHODS.launchSessionHandoff &&
      params.mode === "native-import" &&
      params.target_agent === "deepseek-harness"
    )
      return this.#dshHistoryImport().launch(params);
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

  #dshHistoryImport(): DshHistoryImport {
    return new DshHistoryImport(this.#dataDir!, this.#store!, this.#sessions!, this.#dshBridge, {
      ...process.env,
      ...this.environment,
    });
  }

  async #continueSessionHandoff(value: unknown): Promise<unknown> {
    const environment = { ...process.env, ...this.environment };
    const request = z.object({ launchRequest: z.unknown() }).passthrough().parse(value);
    const launchRequest = request.launchRequest as { mode?: unknown; target_agent?: unknown };
    if (launchRequest?.mode === "native-import") {
      if (launchRequest.target_agent === "cursor") {
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
        if (launchRequest.target_agent === "deepseek-harness") {
          const receipt = await this.#dshHistoryImport().continue(value);
          return { status: "launched", receipt };
        }
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
    const dsh =
      launchRequest?.mode === "handoff-file" &&
      (launchRequest as { target_agent?: unknown }).target_agent === "deepseek-harness";
    const prepared = dsh
      ? null
      : await prepareHandoffLaunch(
          request.launchRequest,
          this.#store!,
          this.#handoffWork.commands,
          environment,
          this.#dataDir,
        );
    await commitTask(() => applySessionHandoff(value, this.#store!, this.#dataDir!, environment));
    try {
      const receipt = prepared
        ? await launchPreparedHandoff(prepared, this.#dataDir!, environment)
        : await launchDshHandoff(request.launchRequest, this.#store!, this.#dshBridge);
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

  #withIndexedPins<T>(rows: T[]): Promise<T[]> {
    const projected = this.#withWorktrees(rows);
    return this.#withWebRead(() => this.#sessionPins?.project(projected) ?? projected);
  }

  /** Marks catalog rows that are Project Agents or their Workers; the rest pass unchanged. */
  #withOrchestration(): (session: unknown) => unknown {
    let roles: Map<string, SessionRole>;
    try {
      roles = this.#orchestration?.roles() ?? new Map();
    } catch {
      // The session list never fails over delegation records.
      roles = new Map();
    }
    return (session) => {
      if (!roles.size || !session || typeof session !== "object" || Array.isArray(session))
        return session;
      const row = session as Record<string, unknown>;
      const ids = [
        row.id,
        ...(Array.isArray(row.indexedSessionIds) ? row.indexedSessionIds : []),
      ].filter((id): id is string => typeof id === "string");
      const role = ids.map((id) => roles.get(id)).find(Boolean);
      return role ? { ...row, orchestration: role } : row;
    };
  }

  /** Making a managed Claude session a lead, and the lead's state, for the desktop. */
  async #requestLead(params: Record<string, unknown>) {
    const orchestration = this.#orchestration;
    if (!orchestration) throw new Error("orchestration-unavailable");
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
    const deviceId = typeof params.deviceId === "string" ? params.deviceId : "";
    if (!sessionId || !deviceId) throw new Error("invalid-lead-request");
    // Whether a Codex session could lead is known once its web services are loaded; one AgentKib
    // just created may not be in the catalog yet.
    const agent = this.#store?.sessions.get(sessionId)?.agent;
    if (agent === undefined || agent === "codex" || agent === "devin" || agent === "antigravity")
      await this.#withWebRead(() => undefined);
    // App and IDE history read from disk cannot lead; only a session controlled over ACP can.
    if (agent === "antigravity" && antigravityAcpEnabled(this.environment))
      await this.#webRead?.prepareAntigravityLead(sessionId);
    const codex = this.#webRead?.codexLeadCapable(sessionId) === true;
    const dsh = this.#dshBridge?.leadCapable(sessionId) === true;
    const devin = this.#webRead?.devinLeadCapable(sessionId) === true;
    const antigravity = this.#webRead?.antigravityLeadCapable(sessionId) === true;
    const leadWorkspace = () =>
      this.#claudeManaged?.managedWorkspace(sessionId) ??
      this.#claudeBridge?.workspaceOf(sessionId) ??
      (codex ? this.#webRead?.managedWorkspace(sessionId) : undefined) ??
      (dsh || devin || antigravity
        ? this.#store?.sessions.get(sessionId)?.workspace_id
        : undefined);
    const authorizedWorkspaces = (): string[] | undefined => {
      const ids = params.authorizedWorkspaceIds;
      if (ids === undefined) return;
      if (
        !Array.isArray(ids) ||
        ids.length > PROJECT_AGENT_MAX_WORKERS + 1 ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 256)
      )
        throw new Error("invalid-lead-request");
      return ids;
    };
    const worker = () => {
      const value = typeof params.worker === "string" ? params.worker : "";
      if (!value || value.length > 256) throw new Error("invalid-lead-request");
      return value;
    };
    const localSessionIds = (value: unknown, limit: number): string[] => {
      if (deviceId !== "agentkib-local-owner" || !Array.isArray(value) || value.length > limit)
        throw new Error("invalid-lead-request");
      return value.map((id) => {
        if (typeof id !== "string" || !id || id.length > 256)
          throw new Error("invalid-lead-request");
        return id;
      });
    };
    let toolsChanged = false;
    switch (params.operation) {
      case "lead-status":
        break;
      case "lead-assignment-options": {
        const bridge = this.#claudeBridge;
        return orchestration.assignmentOptions(
          sessionId,
          leadWorkspace() ?? "",
          localSessionIds(params.candidateIds, 20_000),
          agent === "claude-code" && bridge?.supported
            ? async () => {
                if (!(await this.#claudeManaged?.hasRunningNativeTerminal(sessionId))) return;
                try {
                  // A live lease or an outstanding bridge command has its own control state.
                  if (!bridge.blocksManagedResume(sessionId))
                    return "lead-claude-terminal-disconnected";
                } catch {
                  // An invalid bridge registry cannot prove that the terminal is disconnected.
                }
              }
            : undefined,
        );
      }
      case "lead-assign-workers": {
        const workers = localSessionIds(params.workers, PROJECT_AGENT_MAX_WORKERS);
        const workspaceId = leadWorkspace();
        if (!workspaceId) throw new Error("lead-requires-managed-claude");
        const result = await orchestration.assignWorkers({
          sessionId,
          deviceId,
          workspaceId,
          workers,
        });
        toolsChanged = result.designated;
        break;
      }
      case "lead-designate": {
        const workspaceId = leadWorkspace();
        if (!workspaceId) throw new Error("lead-requires-managed-claude");
        const scope = params.scope && typeof params.scope === "object" ? params.scope : undefined;
        orchestration.designate({
          sessionId,
          deviceId,
          workspaceId,
          scope: scope as Parameters<OrchestrationService["designate"]>[0]["scope"],
        });
        break;
      }
      case "lead-release":
        await orchestration.release(sessionId);
        break;
      case "lead-pause":
        orchestration.pause(sessionId);
        break;
      case "lead-resume":
        orchestration.resume(sessionId, deviceId, authorizedWorkspaces(), leadWorkspace());
        break;
      // The person changes what it may do, as setting it up again would.
      case "lead-update": {
        const scope = params.scope;
        if (!scope || typeof scope !== "object" || Array.isArray(scope))
          throw new Error("invalid-lead-request");
        toolsChanged = await orchestration.update({
          sessionId,
          deviceId,
          scope: scope as Parameters<OrchestrationService["update"]>[0]["scope"],
          authorizedWorkspaceIds: authorizedWorkspaces(),
          workspaceId: leadWorkspace(),
        });
        break;
      }
      // The person lets one worker go, or stops its turn, from the Project Agent's panel.
      case "lead-worker-remove":
        orchestration.removeWorker(sessionId, worker());
        break;
      case "lead-worker-stop": {
        const result = await orchestration.stopWorker(sessionId, worker(), deviceId);
        if (!result.accepted) throw new Error(result.reason ?? "worker-stop-failed");
        break;
      }
      default:
        throw new Error("unsupported-lead-operation");
    }
    // A terminal or a DSH that leads, stops leading, pauses or resumes hears of it at once.
    this.#claudeBridge?.leadChanged(sessionId);
    this.#dshBridge?.leadChanged();
    // A Codex thread takes its worker tools, or drops them, when it starts again.
    if (
      codex &&
      (params.operation === "lead-designate" || params.operation === "lead-release" || toolsChanged)
    )
      await this.#withWebRead((owner) => owner.restartManagedRunner(sessionId)).catch(
        () => undefined,
      );
    // Which sessions lead or work, and whether delegation is paused, show in every list.
    if (params.operation !== "lead-status")
      this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] });
    return {
      lead: await orchestration.overview(sessionId, leadWorkspace()),
      // Whether it could be one: a Claude Code or Codex session AgentKib runs, a connected
      // terminal, or a DSH session whose DSH can take the tools.
      capable: orchestration.isLeadCapable(sessionId),
    };
  }

  /**
   * A Codex or DeepSeek Harness Project Agent started a turn by itself, as a goal goes on: it
   * counts as an automatic turn (`OrchestrationService.leadSelfTurn`). Past the limit delegation
   * pauses, and in the name of the device that set the lead up a Codex goal pauses (the round under
   * way ends by itself) or a DSH round stops (`haltOwnTurns`). Never a step the person's own
   * controls go through.
   */
  async #leadOwnTurn(sessionId: string, turnId: string): Promise<void> {
    const orchestration = this.#orchestration;
    const lead = orchestration?.status(sessionId);
    if (!orchestration || !lead || orchestration.leadSelfTurn(sessionId)) return;
    try {
      const dsh = this.#dshBridge;
      if (dsh?.handles(sessionId))
        await haltOwnTurns(
          { live: async (id) => dsh.live(id, true), control: (value) => dsh.request(value) },
          sessionId,
          turnId,
          lead.deviceId,
          "deepseek-harness",
        );
      else
        await this.#withWebRead((owner) =>
          haltOwnTurns(
            {
              live: async (id) =>
                (await owner.request({
                  operation: "live",
                  sessionId: id,
                  experimentalEnabled: true,
                })) as Record<string, unknown>,
              control: (value) => owner.managedControl(value),
            },
            sessionId,
            turnId,
            lead.deviceId,
            "codex",
          ),
        );
    } catch {
      /* Delegation stays paused, and the panel says why; the turn is the person's to stop. */
    }
  }

  /**
   * A session AgentKib deleted is let go by delegation: as a worker its place is free, as a lead
   * it ends (`OrchestrationService.sessionGone`).
   */
  #deleted<T>(params: Record<string, unknown>, result: Promise<T>): Promise<T> {
    return result.then(async (value) => {
      if (
        typeof params.sessionId === "string" &&
        value &&
        typeof value === "object" &&
        (value as { deleted?: unknown }).deleted === true
      )
        await this.#orchestration?.sessionGone(params.sessionId).catch(() => undefined);
      return value;
    });
  }

  /** Reports for Codex Project Agents, sent through AgentKib's own Codex controls. */
  #codexLeadReports = new MessageLeadReports({
    receipt: (requestId, deviceId) => {
      if (!this.#dataDir) throw new LeadReportNotDispatched("report-receipt-unavailable");
      return readControlReceipt(this.#dataDir, { requestId, deviceId });
    },
    live: (sessionId) =>
      this.#withWebRead((owner) =>
        owner.request({ operation: "live", sessionId, experimentalEnabled: true }),
      ) as Promise<Record<string, unknown>>,
    control: (value) =>
      this.#withWebRead((owner) => owner.managedControl(value)) as Promise<Record<string, unknown>>,
    queue: (sessionId) =>
      this.#withWebRead((owner) =>
        owner.managedQueueList({ operation: "queue-list", sessionId, limit: 100 }),
      ) as Promise<{
        data?: Array<Record<string, unknown>>;
      }>,
  });

  #codexLeadReport(
    sessionId: string,
    deviceId: string,
    text: string,
    ...admission: [canSend?: () => boolean, reportId?: string]
  ): Promise<boolean> {
    return this.#codexLeadReports.send(sessionId, deviceId, text, ...admission);
  }

  /** Reports for DeepSeek Harness Project Agents, sent through the DSH bridge's own controls. */
  #dshLeadReports = new MessageLeadReports({
    receipt: (requestId, deviceId) => {
      if (!this.#dataDir) throw new LeadReportNotDispatched("report-receipt-unavailable");
      return readControlReceipt(this.#dataDir, { requestId, deviceId });
    },
    live: async (sessionId) => {
      if (!this.#dshBridge) throw new Error("dsh-bridge-unavailable");
      return this.#dshBridge.live(sessionId, true);
    },
    control: async (value) => {
      if (!this.#dshBridge) throw new Error("dsh-bridge-unavailable");
      return (await this.#dshBridge.request(value)) as Record<string, unknown>;
    },
    queue: async (sessionId) =>
      ((await this.#dshBridge?.request({ operation: "queue-list", sessionId })) ?? null) as {
        data?: Array<Record<string, unknown>>;
      } | null,
  });

  /**
   * A control from a person's device. When the session is a lead's lane,
   * the lead hears that the person stepped in; the service's own controls do not come here.
   */
  #codexControl(params: Record<string, unknown>, restrictCodexNativePolicy = false) {
    const sessionId = params.sessionId;
    const operation = String(params.operation);
    if (typeof sessionId === "string") {
      const agent = this.#store?.sessions.get(sessionId)?.agent;
      if (agent === "devin" || agent === "antigravity")
        return this.#withWebRead((owner) => owner.managedControl(params)).then((result) => {
          if (
            result &&
            typeof result === "object" &&
            "accepted" in result &&
            result.accepted === true
          )
            this.#workerObserver.controlled(sessionId, operation);
          return result;
        });
    }
    const noteControl = () => {
      try {
        if (typeof params.sessionId === "string") {
          this.#orchestration?.laneControlled(params.sessionId, String(params.operation));
          // The person wrote to a Codex Project Agent: its turns without them start over.
          if (
            ["send", "steer", "queue-add"].includes(String(params.operation)) &&
            this.#orchestration?.status(params.sessionId)
          )
            this.#orchestration.userSpoke(params.sessionId);
        }
      } catch {
        /* A lead's bookkeeping never blocks the person's control. */
      }
    };
    if (!restrictCodexNativePolicy) {
      noteControl();
      return this.#withWebRead((owner) => owner.managedControl(params));
    }
    // A restricted device reaches lane bookkeeping only once its new control is admitted.
    return this.#withWebRead((owner) => owner.managedControl(params, true)).then((result) => {
      if (result && typeof result === "object" && "accepted" in result && result.accepted === true)
        noteControl();
      return result;
    });
  }

  /** Worker observations never block the native session protocol. */
  readonly #workerObserver: WorkerObserver = {
    turnEnded: (sessionId, turnId, outcome, durationMs, historyTurnId, replyText) => {
      void this.#orchestration
        ?.laneTurnEnded(sessionId, turnId, outcome, durationMs, historyTurnId, replyText)
        .catch(() => undefined);
    },
    waiting: (sessionId, turnId, status) => {
      void this.#orchestration?.laneWaiting(sessionId, turnId, status).catch(() => undefined);
    },
    controlled: (sessionId, operation) => {
      try {
        this.#orchestration?.laneControlled(sessionId, operation);
      } catch {
        // The person's control has its own result, independent of delegation.
      }
    },
    isWorker: (sessionId) => !!this.#orchestration?.registry.leadOfLane(sessionId),
  };

  #laneHost(store: BackendStore, dataDir: string, claudeBootId: string): LaneHost {
    const startedAt = Date.now();
    const claudeHostState = new ClaudeHostStateStore(dataDir, claudeBootId);
    const dsh = (sessionId: string) =>
      this.#dshBridge?.handles(sessionId) ? this.#dshBridge : null;
    const session = (sessionId: string) => {
      const summary = store.sessions.get(sessionId);
      if (summary)
        return {
          agent: summary.agent,
          workspaceId: summary.workspace_id,
          title: summary.title ?? null,
        };
      const claude =
        this.#claudeManaged?.managedWorkspace(sessionId) ??
        this.#claudeBridge?.workspaceOf(sessionId);
      if (claude) return { agent: "claude-code", workspaceId: claude, title: null };
      const codex = this.#webRead?.codexLeadCapable(sessionId)
        ? this.#webRead.managedWorkspace(sessionId)
        : null;
      return codex ? { agent: "codex", workspaceId: codex, title: null } : null;
    };
    const live: LaneHost["live"] = async (sessionId, intent) => {
      const bridge = dsh(sessionId);
      if (bridge) return bridge.live(sessionId, true);
      const agent = session(sessionId)?.agent;
      if (agent === "codex")
        return this.#withWebRead((owner) =>
          (owner.codexSessionProvider() as CodexSessionProvider).workerLive(
            sessionId,
            true,
            intent,
          ),
        );
      const request = { operation: "live", sessionId, experimentalEnabled: true };
      return (await (agent === "claude-code"
        ? this.#claudeSessionProvider!.native(request)
        : this.#withWebRead((owner) => owner.request(request)))) as Record<string, unknown>;
    };
    const claudeLimit = (sessionId: string) =>
      usageLimitView(claudeHostState.peek(sessionId)?.usageLimit, claudeBootId);
    return {
      antigravityAcpEnabled: antigravityAcpEnabled(this.environment),
      session,
      live,
      deferCodexSend: (value, binding, handoff) =>
        this.#withWebRead((owner) =>
          (owner.codexSessionProvider() as CodexSessionProvider).deferCodexSend(
            value,
            binding,
            handoff,
          ),
        ),
      cancelDeferredCodexSend: (binding, requestId) =>
        this.#withWebRead(async (owner) =>
          (owner.codexSessionProvider() as CodexSessionProvider).cancelDeferredCodexSend(
            binding,
            requestId,
          ),
        ),
      observe: async (sessionId) => {
        const bridge = dsh(sessionId);
        if (bridge) return bridge.live(sessionId, false);
        const indexed = store.sessions.get(sessionId);
        const agent = indexed?.agent ?? session(sessionId)?.agent;
        if (agent === "codex")
          return this.#withWebRead((owner) =>
            (owner.codexSessionProvider() as CodexSessionProvider).workerLive(sessionId, false),
          );
        if (agent === "devin") {
          if (indexed?.availability !== "readable")
            return { status: "unavailable", reason: "session-unavailable" };
          // Devin's live read can allocate a runner. Its quota is already in the command ledger.
          const kept = readManagedUsageLimit(dataDir, sessionId);
          const limit =
            kept && Date.now() - kept.savedAt < 7 * 24 * 60 * 60_000
              ? parseUsageLimit(kept.limit, "devin")
              : null;
          return {
            status: "idle",
            usageLimit:
              limit && usageLimitView(limit, kept!.savedAt >= startedAt ? limit.bootId : ""),
            // /usage can spend one check interval looking up the reset after a fresh hit.
            usageLimitPending:
              !!limit && limit.manual === "reset-unknown" && Date.now() - kept!.savedAt < 20_000,
          };
        }
        if (agent === "antigravity")
          return this.#withWebRead((owner) =>
            (owner.antigravitySessionProvider() as AntigravitySessionProvider).workerLive(
              sessionId,
            ),
          );
        if (agent !== "claude-code")
          return (await this.#withWebRead((owner) =>
            owner.request({ operation: "live", sessionId }),
          )) as Record<string, unknown>;
        const terminal = this.#claudeBridge;
        const claude = this.#claudeManaged;
        if (
          terminal?.handles(sessionId) &&
          (terminal.blocksManagedResume(sessionId) || !claude?.managedWorkspace(sessionId))
        )
          return terminal.workerObservation(sessionId);
        // An idle managed session needs no transcript or ownership probe. Use the existing
        // host queue ledger for its quota and the in-memory runner status for active turns.
        if (claude?.managedWorkspace(sessionId)) {
          const state = claude.catalogContinuation(sessionId);
          if (state?.status === "running") {
            const live = await claude.live(sessionId, false);
            return { ...live, ...claude.workerObservation(sessionId, live.turnId) };
          }
          return { status: "idle", ...state, usageLimit: claudeLimit(sessionId) };
        }
        return live(sessionId);
      },
      managedLeadNeedsUser: (sessionId) => {
        if (!this.#claudeManaged?.managedWorkspace(sessionId)) return false;
        const limit = claudeLimit(sessionId);
        return limit !== null && limit.continueAt === null && limit.manual !== null;
      },
      control: (value, intent, interaction) => {
        if (typeof value.sessionId !== "string") throw new Error("session-unavailable");
        if (intent === "desktop-owner-handoff") {
          if (value.operation !== "send" || session(value.sessionId)?.agent !== "codex")
            throw new Error("session-unavailable");
          return this.#withWebRead((owner) =>
            (owner.codexSessionProvider() as CodexSessionProvider).workerDesktopSend(value),
          );
        }
        if (intent === "codex-worker-turn") {
          if (session(value.sessionId)?.agent !== "codex") throw new Error("session-unavailable");
          return this.#withWebRead((owner) =>
            (owner.codexSessionProvider() as CodexSessionProvider).workerTurnSend(value),
          );
        }
        const sessionId = value.sessionId;
        return this.#auditApprovalDecision(
          value,
          { source: { kind: "project-agent" } },
          () => {
            const bridge = dsh(sessionId);
            if (bridge) return bridge.request(value);
            if (session(sessionId)?.agent === "claude-code")
              return this.#claudeSessionProvider!.native(value);
            return this.#withWebRead((owner) => owner.managedControl(value));
          },
          interaction,
        );
      },
      restart: async (request, beforeDispatch) => {
        const target = session(request.sessionId);
        if (!target || target.workspaceId !== request.workspaceId)
          return {
            accepted: false,
            controlOutcome: "not-dispatched",
            reason: "workspace-not-allowed",
          };
        switch (target.agent) {
          case "claude-code":
            if (this.#claudeSessionProvider)
              return this.#claudeSessionProvider.restartWorker(request, beforeDispatch);
            break;
          case "codex":
            return this.#withWebRead((owner) =>
              (owner.codexSessionProvider() as CodexSessionProvider).restartWorker(
                request,
                beforeDispatch,
              ),
            );
          case "devin":
            return this.#withWebRead((owner) =>
              (owner.devinSessionProvider() as DevinSessionProvider).restartWorker(
                request,
                beforeDispatch,
              ),
            );
        }
        return {
          accepted: false,
          controlOutcome: "not-dispatched",
          reason: "worker-restart-unsupported",
        };
      },
      events: async (sessionId, limit) => {
        const bridge = dsh(sessionId);
        if (bridge) {
          const nativeId = bridge.nativeId(sessionId);
          return nativeId
            ? ((await bridge.events(nativeId, null, limit)).events as unknown as Array<
                Record<string, unknown>
              >)
            : [];
        }
        if (session(sessionId)?.agent === "antigravity") {
          const events = await this.#withWebRead((owner) =>
            owner.antigravityWorkerEvents(sessionId, limit),
          );
          if (events) return events;
        }
        const request = { operation: "events", sessionId, limit };
        const page = (await (session(sessionId)?.agent === "claude-code"
          ? this.#claudeManaged?.hasManagedSession(sessionId)
            ? this.#claudeManaged.request(request)
            : this.#readIndexedClaudeEvents(request, sessionId)
          : this.#withWebRead((owner) => owner.request({ ...request, retainCursor: false })))) as {
          events?: unknown;
        };
        return Array.isArray(page?.events) ? (page.events as Array<Record<string, unknown>>) : [];
      },
      managed: async (sessionId) => {
        switch (session(sessionId)?.agent) {
          case "deepseek-harness":
            return !!dsh(sessionId);
          case "claude-code": {
            const state = await live(sessionId);
            return (
              (state.executionMode === "claude-follower" &&
                state.terminalSend === true &&
                state.status !== "unsupported" &&
                state.status !== "disconnected") ||
              (state.executionMode === "claude-managed" &&
                !!this.#claudeManaged?.managedWorkspace(sessionId) &&
                state.status !== "unsupported")
            );
          }
          case "devin":
            return (await live(sessionId)).status !== "unsupported";
          case "antigravity":
            return this.#withWebRead((owner) => owner.antigravityWorkerAvailable(sessionId));
          default:
            return this.#withWebRead((owner) => owner.isManagedSession(sessionId));
        }
      },
      endedTurns: async (sessionId) => {
        const bridge = dsh(sessionId);
        if (bridge) return bridge.endedTurns(sessionId);
        switch (session(sessionId)?.agent) {
          case "claude-code":
            return (await this.#claudeManaged?.endedTurns(sessionId)) ?? [];
          case "devin":
            return this.#withWebRead((owner) => owner.devinEndedTurns(sessionId));
          case "antigravity":
            // ACP replay has messages and tool calls, without a persisted turn outcome.
            return [];
          default:
            return this.#withWebRead((owner) => owner.endedTurns(sessionId));
        }
      },
      workspaces: () =>
        (store.listWorkspaces() as Array<{ id: string; name?: string; path: string }>).map(
          (workspace) => ({ id: workspace.id, name: workspace.name ?? workspace.path }),
        ),
    };
  }

  #routeSession(method: SessionMethod, params: Record<string, unknown>) {
    const host = readHostSessionRequest(method, params);
    const hostOperation = host?.request.operation;
    if (
      method !== RUNTIME_METHODS.sessionRequest &&
      (hostOperation === "approval-audit-list" || hostOperation === "approval-audit-expired")
    )
      throw new RpcFault(-32601, "Method not found");
    return this.#auditApprovalDecision(host?.request ?? params, host?.approvalAudit, () =>
      host ? this.#requestHostSession(host) : this.#requestTypedSession(params),
    );
  }

  /** These reads are limited to the host's authorized workspace snapshot. */
  #requestHostSession({
    target,
    request: params,
    restrictCodexNativePolicy,
    approvalAudit,
  }: HostSessionRequest) {
    if (!target && params.operation === "approval-audit-list") {
      const input = parameters(approvalAuditListSchema, params);
      return this.#approvalAudit!.list({
        before: input.before,
        limit: input.limit,
        workspaceScopes: input.workspaces,
      });
    }
    if (!target && params.operation === "approval-audit-expired") {
      const input = parameters(expiredApprovalAuditSchema, params);
      if (!approvalAudit) throw new Error("invalid-approval-audit-source");
      return this.#recordExpiredApproval(input, approvalAudit);
    }
    if (target === "claude-code") return this.#requestClaudeManaged(params);
    if (target === "codex") return this.#requestCodexSession(params, restrictCodexNativePolicy);
    if (params.operation === "provider-validate-control") {
      const call = hostControlValidationSchema.parse(params.call);
      const agent =
        this.#store!.sessions.get(call.sessionId)?.agent ??
        (this.#claudeManaged?.hasManagedSession(call.sessionId) ? "claude-code" : "codex");
      return this.#withWebRead((owner) =>
        runProviderValidation(call, agent, owner.sessionProviders.typed(agent)?.validateControl),
      );
    }
    if (
      typeof params.sessionId === "string" &&
      typeof params.operation === "string" &&
      this.#store!.sessions.get(params.sessionId)?.agent === "deepseek-harness"
    ) {
      const handled = this.#dshSessionProvider.legacy(params.operation, params);
      if (handled !== undefined) return handled;
    }
    return this.#requestWebSession(params, restrictCodexNativePolicy);
  }

  #approvalAuditTarget(sessionId: string): ApprovalAuditTarget | undefined {
    const store = this.#store;
    if (!store) return;
    const indexed = store.sessions.get(sessionId);
    let agent = managedAgentOf(indexed?.agent);
    let workspaceId = indexed?.workspace_id ?? null;
    if (!indexed) {
      workspaceId =
        this.#claudeManaged?.managedWorkspace(sessionId) ??
        this.#claudeBridge?.workspaceOf(sessionId) ??
        null;
      if (workspaceId) agent = "claude-code";
      if (!agent && this.#dshBridge?.handles(sessionId)) {
        const live = this.#dshBridge.live(sessionId, false);
        agent = "deepseek-harness";
        workspaceId = typeof live.workspaceId === "string" ? live.workspaceId : null;
      }
      if (!agent && this.#webRead) {
        workspaceId = this.#webRead.managedWorkspace(sessionId);
        if (workspaceId || this.#webRead.codexLeadCapable(sessionId)) agent = "codex";
      }
    }
    if (!agent) return;
    let workspacePath: string | undefined;
    if (workspaceId)
      try {
        workspacePath = store.workspacePath(workspaceId);
      } catch {
        // Projectless sessions and removed workspaces have no registered path.
      }
    return { agent, workspaceId: workspaceId ?? undefined, workspacePath };
  }

  #auditApprovalDecision<T>(
    params: Record<string, unknown>,
    metadata: SessionApprovalAuditContext | undefined,
    run: () => T,
    interaction?: Record<string, unknown>,
  ): T | Promise<Awaited<T>> {
    const audit = this.#approvalAudit;
    const { operation } = params;
    if (!audit || !isApprovalDecision(operation)) return run();
    const request = approvalAuditIdentitySchema.safeParse(params);
    if (!request.success) return run();
    let target: ApprovalAuditTarget | undefined;
    try {
      target = this.#approvalAuditTarget(request.data.sessionId);
    } catch {
      // An unavailable audit target must not break the provider's existing admission path.
      return run();
    }
    if (!target) return run();
    const source = metadata?.source ?? { kind: "desktop" };
    const fallback = {
      source,
      risk: metadata?.risk,
      decision: metadata?.decision ?? approvalAuditDecision(operation, params, interaction),
    };
    const matched = target;
    let evidence = interaction
      ? classifyAuditDecision(matched.agent, operation, params, interaction, matched.workspacePath)
      : undefined;
    const bridge = this.#dshBridge;
    if (
      !evidence &&
      !metadata?.decision &&
      operation === "answer" &&
      matched.agent === "deepseek-harness" &&
      bridge?.handles(request.data.sessionId)
    ) {
      try {
        evidence = approvalAuditEvidence(
          bridge.live(request.data.sessionId, false),
          params,
          matched.workspacePath,
        );
      } catch {
        // The native control still owns admission if the audit cannot project the card.
      }
    }
    if (!evidence)
      return recordApprovalDecision(audit, operation, request.data, matched, fallback, run);
    return evidence
      .catch(() => ({}))
      .then((evidence) =>
        recordApprovalDecision(
          audit,
          operation,
          request.data,
          matched,
          { ...fallback, ...evidence },
          run,
        ),
      );
  }

  async #recordExpiredApproval(
    input: z.infer<typeof expiredApprovalAuditSchema>,
    metadata: NonNullable<HostSessionRequest["approvalAudit"]>,
  ) {
    const target = this.#approvalAuditTarget(input.sessionId);
    if (target)
      await recordExpiredApproval(
        this.#approvalAudit!,
        input.interactionKind === "approval" ? "approve" : "answer",
        input,
        target,
        {
          ...metadata,
          decision:
            metadata.decision ??
            approvalAuditDecision(
              input.interactionKind === "approval" ? "approve" : "answer",
              input,
            ),
        },
      );
    return null;
  }

  #settleApprovalAuditReceipt(receipt: unknown, deviceId: unknown): void {
    const update = approvalAuditReceipt(receipt);
    const audit = this.#approvalAudit;
    if (!update || !audit || typeof deviceId !== "string") return;
    try {
      const target = this.#approvalAuditTarget(update.sessionId);
      if (target)
        void audit
          .finishReceipt({ ...update, agent: target.agent, deviceId })
          .catch(() => undefined);
    } catch {
      // Receipt delivery does not depend on being able to update the audit history.
    }
  }

  async #requestTypedSession(params: Record<string, unknown>) {
    const { agent: requestedAgent, request } = readSessionRequest(params);
    const agent =
      request.operation === "create"
        ? requestedAgent === undefined
          ? "codex"
          : requestedAgent
        : (this.#store!.sessions.get(request.sessionId)?.agent ??
          (this.#claudeManaged?.hasManagedSession(request.sessionId) ? "claude-code" : "codex"));
    const response =
      agent === "deepseek-harness"
        ? await this.#dshSessionProvider.request(request)
        : agent === "claude-code"
          ? await this.#claudeSessionProvider!.request(request)
          : await this.#withWebRead((owner) => {
              const provider = owner.sessionProviders.typed(
                agent,
                request.operation === "create" || request.operation === "settings-prepare"
                  ? undefined
                  : async (value) => this.#requestWebSession(legacySessionFields(value)),
              );
              if (!provider) throw new Error("unsupported-session-provider");
              return provider.request(request);
            });
    return restrictSessionCommands(request, response);
  }

  #requestCodexSession(params: Record<string, unknown>, restrictCodexNativePolicy = false) {
    if (typeof params.sessionId === "string") {
      const agent = this.#store!.sessions.get(params.sessionId)?.agent;
      if (agent && agent !== "codex") throw new Error("unsupported-session-provider");
    }
    if (params.operation === "options") return this.#withWebRead((owner) => owner.managedOptions());
    if (params.operation === "reconcile")
      return this.#withWebRead((owner) =>
        owner.managedReconcile(params, restrictCodexNativePolicy),
      );
    if (params.operation === "resume")
      return this.#withWebRead((owner) => owner.managedResume(params, restrictCodexNativePolicy));
    if (params.operation === "queue-list")
      return this.#withWebRead((owner) => owner.managedQueueList(params));
    if (params.operation === "unarchive")
      return this.#withWebRead((owner) => owner.managedUnarchive(params));
    if (params.operation === "delete")
      return this.#deleted(
        params,
        this.#withWebRead((owner) => owner.managedDelete(params)),
      );
    if (params.operation === "settings-state")
      return this.#withWebRead((owner) => owner.managedSettingsState(params));
    if (["capabilities", "inspect"].includes(String(params.operation)))
      return this.#withWebRead((owner) => owner.managedQuery(params));
    if (params.operation === "create")
      return this.#withWebRead((owner) => owner.sessionProviderCreate("codex", params));
    if (params.operation === "release")
      return this.#withWebRead((owner) => owner.managedLifecycle(params));
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
      return this.#codexControl(params, restrictCodexNativePolicy);
    throw new RpcFault(-32601, "Method not found");
  }

  #requestWebSession(params: Record<string, unknown>, restrictCodexNativePolicy = false) {
    if (params.operation === "session-pin") {
      const input = parameters(
        z.strictObject({
          operation: z.literal("session-pin"),
          sessionId: z.string().min(1).max(256),
          workspaceId: z.string().min(1).max(256).optional(),
          pinned: z.boolean(),
        }),
        params,
      );
      return this.#setSessionPin(input.sessionId, input.workspaceId, input.pinned);
    }
    if (params.operation === "desktop-events")
      return this.#withWebRead((owner) =>
        owner.indexedCodexEvents({ ...params, operation: "events" }),
      );
    if (params.operation === "read-state" || params.operation === "read-state-update") {
      const input = parameters(
        z
          .object({
            operation: z.enum(["read-state", "read-state-update"]),
            sessionId: z.string().min(1).max(256),
            readerScope: z.string().min(1).max(512),
            expectedVersion: z.string().min(1).max(8192).optional(),
            seenResultId: z.string().min(1).max(1024).nullable().optional(),
          })
          .strict(),
        params,
      );
      if (!this.#readStates) throw new Error("read-state-unavailable");
      if (input.operation === "read-state")
        return this.#readStates
          .get(input.sessionId, input.readerScope)
          .then((readState) => ({ readState }));
      if (!input.expectedVersion || input.seenResultId === undefined)
        throw new Error("read-state-conflict");
      return this.#readStates
        .update(input.sessionId, input.readerScope, input.expectedVersion, input.seenResultId)
        .then((readState) => ({ readState }));
    }
    let readerScope: string | undefined;
    if (params.operation === "catalog" && params.readerScope !== undefined) {
      readerScope = parameters(
        z.object({ readerScope: z.string().min(1).max(512) }),
        params,
      ).readerScope;
      const { readerScope: _scope, ...unscoped } = params;
      params = unscoped;
    }
    if (params.operation === "diff") return webDiff(params, this.#store!, this.#git!);
    if (params.operation === "session-image")
      return typeof params.sessionId === "string" &&
        this.#claudeManaged!.hasManagedSession(params.sessionId)
        ? this.#claudeManaged!.request(params)
        : this.#withWebRead((owner) => owner.request(params));
    // Claude managed sessions run in their registered workspace root, so they have no
    // narrower directory; every other session reads it from the index or Codex ledger.
    if (params.operation === "session-directory")
      return typeof params.sessionId === "string" &&
        this.#claudeManaged!.hasManagedSession(params.sessionId)
        ? { cwd: null }
        : this.#withWebRead((owner) => owner.request(params));
    if (params.operation === "provider-options") {
      const { agent, operation: _operation, ...scope } = params;
      return this.#withWebRead((owner) => owner.sessionProviderOptions(agent, scope));
    }
    if (params.operation === "provider-workspace-resources") {
      const { agent, operation: _operation, ...scope } = params;
      return this.#withWebRead((owner) => owner.sessionProviderWorkspaceResources(agent, scope));
    }
    if (params.operation === "provider-create") {
      const { agent, operation: _operation, ...fields } = params;
      return this.#withWebRead((owner) => owner.sessionProviderCreate(agent, fields));
    }
    if (params.operation === "dsh-create" || params.operation === "dsh-options")
      return this.#dshSessionProvider.legacy(params.operation, params);
    // A Devin session has no ID until its first turn has run; the web reader starts it.
    if (params.operation === "devin-create")
      return this.#withWebRead((owner) => owner.devinCreate(params));
    // Devin CLI's own login or workspace trust, run in a terminal for the person to finish.
    if (params.operation === "devin-terminal") {
      const action = params.action === "login" || params.action === "trust" ? params.action : null;
      if (!action) throw new Error("invalid-request");
      const environment = devinChildEnvironment({ ...process.env, ...this.environment });
      const executable = devinExecutable(environment);
      if (!executable) throw new Error("devin-cli-unavailable");
      const cwd =
        action === "trust"
          ? this.#store!.workspacePath(z.string().min(1).max(256).parse(params.workspaceId))
          : (environment.HOME ?? environment.USERPROFILE ?? os.homedir());
      return launchDevinTerminal(action, executable, cwd, this.#handoffWork.commands, environment);
    }
    if (params.operation === "devin-options")
      return this.#withWebRead((owner) => owner.devinOptions());
    // Resolve the provider from persisted identity, never from a browser-supplied agent.
    // Fresh Claude sessions are not indexed until their first native transcript exists.
    if (typeof params.sessionId === "string" && params.operation !== "catalog") {
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const claudeSession =
        this.#store!.sessions.get(sessionId)?.agent === "claude-code" ||
        this.#claudeManaged!.hasManagedSession(sessionId);
      if (claudeSession) {
        if (params.operation === "subagents" || params.operation === "subagent-events")
          return this.#claudeManaged!.request(params);
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
      params.operation === "subagents" ||
      params.operation === "subagent-events" ||
      params.operation === "usage"
    ) {
      return this.#withWebRead((owner) => owner.request(params));
    }
    if (params.operation === "settings-state")
      return this.#withWebRead((owner) => owner.sessionProviderSettingsState(params));
    if (params.operation === "queue-list")
      return this.#withWebRead((owner) => owner.managedQueueList(params));
    if (["capabilities", "inspect"].includes(String(params.operation)))
      return this.#withWebRead((owner) => owner.managedQuery(params));
    if (params.operation === "resume")
      return this.#withWebRead((owner) => owner.managedResume(params, restrictCodexNativePolicy));
    if (params.operation === "unarchive")
      return this.#withWebRead((owner) => owner.managedUnarchive(params));
    if (params.operation === "delete")
      return this.#deleted(
        params,
        this.#withWebRead((owner) => owner.managedDelete(params)),
      );
    if (
      [
        "send",
        "stop",
        "approve",
        "answer",
        "steer",
        "queue-add",
        "queue-update",
        "queue-pause",
        "queue-resume",
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
      return this.#codexControl(params, restrictCodexNativePolicy);
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
      const claude = this.#claudeManaged!;
      void claude.refreshExternalTurns().catch(() => undefined);
      const records = claude.catalog();
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
        if (
          row.agent === "deepseek-harness" &&
          typeof row.id === "string" &&
          this.#dshBridge?.handles(row.id)
        ) {
          try {
            const live = this.#dshBridge.live(row.id, false);
            return {
              ...row,
              continuation: {
                status: live.status,
                executionLocation: live.executionLocation,
                ownershipReason: live.ownershipReason,
                reason: live.reason,
              },
            };
          } catch {
            return row;
          }
        }
        if (row.agent !== "claude-code" || typeof row.id !== "string") return row;
        const projection = row.continuation;
        let live = managedIds.has(row.id)
          ? projection && typeof projection === "object" && !Array.isArray(projection)
            ? (projection as Record<string, unknown>)
            : undefined
          : claude.catalogContinuation(row.id);
        try {
          if (this.#claudeBridge?.handles(row.id) && this.#claudeBridge.blocksManagedResume(row.id))
            live = this.#claudeBridge.live(row.id, false);
        } catch {
          // A broken connection registry must not prevent read-only catalog access.
          live = {
            status: "unsupported",
            executionLocation: null,
            reason: "claude-bridge-registry-invalid",
          };
        }
        const externalTurn = !["terminal", "agentkib"].includes(String(live?.executionLocation))
          ? claude.externalTurn(row.id)
          : undefined;
        const observedRow = externalTurn ? { ...row, externalTurn } : row;
        return live
          ? {
              ...observedRow,
              continuation: {
                status: live.status,
                executionLocation: live.executionLocation,
                ownershipReason: live.ownershipReason,
                reason: live.reason,
                ...(typeof live.backgroundTasks === "number" && {
                  backgroundTasks: live.backgroundTasks,
                }),
              },
            }
          : observedRow;
      };
      const merged = [
        ...sessions.filter(
          (session) =>
            !!session &&
            typeof session === "object" &&
            !Array.isArray(session) &&
            !("id" in session && aliases.has(String(session.id))),
        ),
        ...this.#withWorktrees(records),
      ]
        .map(continuation)
        .map(this.#withOrchestration());
      const organized = this.#sessionPins?.project(merged) ?? merged;
      return {
        ...catalog,
        sessions: readerScope ? this.#readStates!.project(organized, readerScope) : organized,
      };
    });
  }

  async #quitWorkSessions(): Promise<{ sessionId: string; title: string; agent: string }[]> {
    const catalog = await this.#request(RUNTIME_METHODS.sessionRequest, {
      host: { request: { operation: "catalog" } },
    });
    if (
      !catalog ||
      typeof catalog !== "object" ||
      !("sessions" in catalog) ||
      !Array.isArray(catalog.sessions)
    )
      return [];
    const locallyActive = z.object({
      id: z.string().min(1).max(256),
      agent: z.string().min(1).max(64),
      title: z.string().nullish(),
      archived: z.boolean().optional(),
      availability: z.literal("readable"),
      origin: z.string().optional(),
      remote: z.unknown().optional(),
      continuation: z.object({
        executionLocation: z.literal("agentkib"),
        status: z.string(),
        backgroundTasks: z.number().optional(),
      }),
    });
    const active = new Set(["starting", "running", "awaiting-approval", "waiting-input"]);
    return catalog.sessions.flatMap((row) => {
      const { data: session } = locallyActive.safeParse(row);
      if (
        !session ||
        session.remote ||
        session.archived ||
        session.origin === "auxiliary" ||
        session.origin === "execution" ||
        !(
          active.has(session.continuation.status) || (session.continuation.backgroundTasks ?? 0) > 0
        )
      )
        return [];
      return [
        { sessionId: session.id, title: session.title?.slice(0, 512) ?? "", agent: session.agent },
      ];
    });
  }

  async #setSessionPin(sessionId: string, workspaceId: string | undefined, pinned: boolean) {
    const pins = this.#sessionPins;
    if (!pins) throw new Error("session-pin-unavailable");
    const row = workspaceId
      ? await this.#catalogPinRow(sessionId, workspaceId)
      : await this.#withWebRead(() => {
          // Only trusted desktop requests can omit the workspace scope. These virtual
          // collections aren't visible or addressable by a paired caller.
          const indexed = this.#store?.sessions.get(sessionId);
          const enabled = this.#dataDir
            ? readPreferences(this.#dataDir).session_index_enabled
            : false;
          if (
            !indexed ||
            indexed.agent !== "codex" ||
            !sessionCollection(indexed.workspace_id) ||
            (enabled !== undefined && enabled !== true)
          )
            return undefined;
          return indexed;
        });
    if (this.#sessionPins !== pins) throw new Error("session-pin-unavailable");
    if (!row) throw new Error("session-not-found");
    const confirmed = await pins.set(row, pinned);
    if (this.#sessionPins !== pins) throw new Error("session-pin-unavailable");
    this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] });
    return { pinned: confirmed };
  }

  async #catalogPinRow(sessionId: string, workspaceId: string) {
    const catalog = (await this.#requestWebSession({ operation: "catalog" })) as {
      sessions?: unknown[];
    };
    return catalog.sessions
      ?.filter(isSessionPinRow)
      .find((session) => session.id === sessionId && session.workspace_id === workspaceId);
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
        (sessionId, type, payload, live, item) =>
          this.#publishSession(sessionId, type, payload, live, item),
        (sessionId) => this.#sessionStream?.hasSubscribers(sessionId) ?? false,
        this.#sessionIndex,
        () => this.#sessionStream?.publish("", "invalidate", { domains: ["catalog"] }),
        this.#claudeSessionProvider,
        this.#dshSessionProvider,
        (sessionId, operation) => this.#workerObserver.controlled(sessionId, operation),
        async (request) => this.#requestWebSession(request),
        {
          checkDeferredCodexSend: (owner) =>
            this.#orchestration?.checkDeferredCodexSend(owner) ?? "revoked",
          deferredCodexSendResult: (owner, requestId, result) =>
            this.#orchestration?.deferredCodexSendResult(owner, requestId, result),
        },
      );
      this.#webRead.observeLanes({
        turnEnded: this.#workerObserver.turnEnded,
        waiting: this.#workerObserver.waiting,
        ownTurn: (sessionId, turnId) => void this.#leadOwnTurn(sessionId, turnId),
        limitEnded: (sessionId) => this.#orchestration?.limitEnded(sessionId),
      });
      // Devin's history marks no turn's end: the turns AgentKib ran record their own results.
      this.#webRead.observeResults((target, result, timing) =>
        this.#readStates?.recordTerminal(target, result, timing),
      );
      this.#webRead.leadEndpoints(
        (sessionId) => this.#orchestration?.leadEndpoint(sessionId) ?? Promise.resolve(null),
      );
    }
    return await operation(this.#webRead);
  }

  /** The person's control keeps the existing lead and worker bookkeeping. */
  #noteDshControl(sessionId: string, operation: string) {
    try {
      this.#orchestration?.laneControlled(sessionId, operation);
      if (
        ["send", "steer", "queue-add"].includes(operation) &&
        this.#orchestration?.status(sessionId)
      )
        this.#orchestration.userSpoke(sessionId);
    } catch {
      /* A lead's bookkeeping never blocks the person's control. */
    }
  }

  #requestClaudeManaged(params: Record<string, unknown>) {
    return this.#claudeSessionProvider!.legacy(params) ?? this.#requestClaudeHost(params);
  }

  /** Compatibility operations the desktop historically carries on claude.managed. */
  async #requestClaudeHost(params: Record<string, unknown>) {
    try {
      const operation = String(params.operation);
      if (operation === "schedule-list") {
        const serial = this.#withWebRead(async (owner) => [
          ...(await owner.serialScheduleList()),
          ...(owner.codexSessionProvider() as CodexSessionProvider).ownerWaitScheduleList(),
        ]);
        if (params.serialOnly === true) return { sessions: await serial };
        const [claude, queued] = await Promise.all([
          this.#claudeManaged!.request(params) as Promise<{ sessions?: unknown[] }>,
          serial.catch(() => null),
        ]);
        return {
          ...claude,
          sessions: [...(claude.sessions ?? []), ...(queued ?? [])],
          ...(queued === null ? { serialQueueUnavailable: true } : {}),
        };
      }
      if (operation.startsWith("schedule-") && typeof params.sessionId === "string") {
        if (params.agent === "codex")
          return this.#withWebRead((owner) =>
            (owner.codexSessionProvider() as CodexSessionProvider).ownerWaitSchedule(params),
          );
        const agent = this.#store?.sessions.get(params.sessionId)?.agent;
        if (agent === "devin" || agent === "antigravity")
          return this.#withWebRead((owner) => owner.serialSchedule(params));
      }
      if (params.operation === "schedule-invalidate") {
        const deviceId = typeof params.deviceId === "string" ? params.deviceId : undefined;
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
        this.#claudeBridge?.invalidate(deviceId, sessionId);
        this.#dshBridge?.invalidate(deviceId, sessionId);
        // A remote host that stops because AgentKib quits changes no device's access. Leads
        // stay as they are: the next start pauses each, and says that it restarted.
        if (deviceId && params.quitting !== true) {
          this.#orchestration?.invalidateDevice(deviceId);
          // Nor does AgentKib continue a Codex session in its name after a usage limit.
          await this.#withWebRead(async (owner) =>
            owner.invalidateUsageLimitDevice(deviceId),
          ).catch(() => undefined);
        }
        if (deviceId)
          await this.#withWebRead((owner) => {
            if (params.quitting === true)
              (owner.codexSessionProvider() as CodexSessionProvider).suspendOwnerWaitDevice(
                deviceId,
              );
            return owner.invalidateSerialSchedule(deviceId, params.quitting === true);
          }).catch(() => undefined);
      }
      if (String(params.operation).startsWith("lead-")) return await this.#requestLead(params);
      // The desktop's local management channel also reports the DeepSeek Harness connection.
      if (params.operation === "dsh-bridge-status") {
        if (!this.#dshBridge) throw new Error("dsh-bridge-unavailable");
        return this.#dshBridge.management(params);
      }
      // Whether sessions continue after a usage limit resets, for this computer (on by default).
      if (params.operation === "usage-limit-auto-continue") {
        if (!this.#dataDir) throw new Error("claude-managed-unavailable");
        if (typeof params.enabled === "boolean")
          writePreference(this.#dataDir, "usage_limit_auto_continue", params.enabled);
        return { autoContinue: usageLimitAutoContinue(this.#dataDir) };
      }
      // Whether managed Claude sessions keep background tasks, for this computer.
      if (params.operation === "background-tasks") {
        if (!this.#claudeManaged || !this.#dataDir) throw new Error("claude-managed-unavailable");
        if (typeof params.enabled === "boolean")
          writePreference(this.#dataDir, "claude_background_tasks", params.enabled);
        return { backgroundTasks: await this.#claudeManaged.backgroundTasksStatus() };
      }
      if (
        [
          "bridge-status",
          "bridge-challenge",
          "bridge-disconnect",
          "bridge-auto-connect",
          "bridge-plugin-retry",
          "bridge-plugin-status",
          "bridge-plugin-auto-update",
        ].includes(operation)
      )
        return this.#claudeBridge!.management(params);
      return this.#claudeSessionProvider!.native(params);
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

  #usesStreamSubagents(live: Record<string, unknown>): boolean {
    return (
      live.executionMode === "claude-managed" ||
      live.executionMode === "codex-managed" ||
      live.executionMode === "codex-follower"
    );
  }

  #activityScope(
    sessionId: string,
    live: Record<string, unknown>,
  ): (Record<string, unknown> & { activityBinding?: string }) | undefined {
    if (live.executionMode === DEVIN_EXECUTION_MODE) return { ...live, activityBinding: undefined };
    if (live.executionMode !== DSH_EXECUTION_MODE) return undefined;
    const activityBinding = this.#dshBridge?.activitySubagentScope(sessionId);
    return activityBinding ? { ...live, activityBinding } : undefined;
  }

  async #readStreamSubagents(sessionId: string, live: Record<string, unknown>) {
    const scope = this.#activityScope(sessionId, live);
    const readLegacy = async () =>
      this.#request(RUNTIME_METHODS.sessionRequest, {
        host: { request: { operation: "subagents", sessionId } },
      });
    let devinRead: Promise<SubagentCatalog | undefined> | undefined;
    const readDevin = async () =>
      (devinRead ??= this.#sessions?.activitySubagentsForDevin(sessionId));
    // Share the Devin chain read. The legacy stream cache still applies its original agent filter.
    const legacy = this.#childSnapshots.read(
      sessionId,
      live,
      live.executionMode === DEVIN_EXECUTION_MODE ? readDevin : readLegacy,
    );
    const activities = scope
      ? this.#activitySnapshots.read(sessionId, scope, async () =>
          scope.activityBinding
            ? this.#dshBridge?.activitySubagents(sessionId, scope.activityBinding)
            : readDevin(),
        )
      : undefined;
    const [subagents] = await Promise.all([legacy, activities]);
    return subagents;
  }

  #currentActivitySubagents(
    sessionId: string,
    live: Record<string, unknown>,
  ): SubagentSnapshot | undefined {
    if (this.#usesStreamSubagents(live)) return this.#childSnapshots.current(sessionId, live);
    const scope = this.#activityScope(sessionId, live);
    return scope ? this.#activitySnapshots.current(sessionId, scope) : undefined;
  }

  #publishSession(
    sessionId: string,
    type: SessionStreamEvent["type"],
    payload: Record<string, unknown>,
    live?: Record<string, unknown>,
    textItem?: Record<string, unknown>,
  ) {
    if (type === "invalidate") {
      this.#childSnapshots.invalidate(sessionId || undefined);
      this.#activitySnapshots.invalidate(sessionId || undefined);
    } else {
      const state = live ?? payload;
      this.#childSnapshots.publish(sessionId, state);
      // CLI notifications can have partial child lists. Keep the children
      // already known in this binding when projecting a replacement activities array.
      const withActivities = withSessionActivities(
        state,
        this.#currentActivitySubagents(sessionId, state),
        type === "state" &&
          (this.#usesStreamSubagents(state) ||
            state.executionMode === DSH_EXECUTION_MODE ||
            state.executionMode === DEVIN_EXECUTION_MODE),
      );
      if (payload === state) payload = withActivities;
      if (live) live = withActivities;
    }
    if (type === "invalidate") this.#snapshotHistory?.invalidate(sessionId || undefined);
    this.#sessionStream?.publish(sessionId, type, payload, live, textItem);
    if (sessionId && type === "state") {
      const state = live ?? payload;
      const status = JSON.stringify([
        state.status,
        state.executionLocation,
        state.ownershipReason,
        state.reason,
        // The catalog counts background tasks, which start and end while the session is idle.
        Array.isArray(state.backgroundTasks) ? state.backgroundTasks.length : 0,
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

function localCostProvider(value: unknown): "codex" | "claude" {
  if (value !== "codex" && value !== "claude") invalid("Unsupported local cost provider");
  return value;
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
