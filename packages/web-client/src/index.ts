export { mergeCatalogSessions, isStaleCatalogRead, retryStaleCatalogRead } from "./catalog";
export type { IncompleteSessionSource } from "./catalog";

import { managedAgentOf, type ManagedAgent } from "@agentkib/runtime-protocol";
import type {
  ConversationReadState,
  ConversationReadResult,
  ClaudeCommandEntry,
  ConversationToolDetail,
  ConversationTurnMeta,
  HistorySearchQuery,
  HistorySearchResult,
  HistoryLocation,
  HistoryLocatedRecord,
  HistoryReference,
  ResolvedHistoryReference,
  HistorySearchStatus,
} from "@agentkib/runtime-protocol";
export type {
  ClaudeCommandAccess,
  ClaudeCommandDecision,
  ConversationReadState,
  ConversationReadResult,
  ClaudeCommandEntry,
  ClaudeCommandRefusal,
  ClaudeMenuCommand,
  CodexCommandAction,
  CodexCommandDecision,
  CodexCommandPanel,
  CodexCommandPrompt,
  CodexCommandRefusal,
  CodexMenuCommand,
  DshCommandEntry,
  DshCommandRefusal,
  ConversationToolContent,
  ConversationToolDetail,
  ConversationToolKind,
  ConversationTurnMeta,
  ClaudeBridgeCompatibilityStatus,
  ClaudeBridgeConnectionFailure,
  HistorySearchQuery,
  HistorySearchResult,
  HistoryLocation,
  HistoryLocatedRecord,
  HistoryReference,
  ResolvedHistoryReference,
  HistorySearchStatus,
  HistorySearchHit,
  HistoryRecordKind,
} from "@agentkib/runtime-protocol";
export {
  isLiveSessionAgent,
  LIVE_SESSION_AGENTS,
  MANAGED_AGENTS,
  managedAgentOf,
  type ManagedAgent,
  CLAUDE_BRIDGE_CLI_VERSION,
  CLAUDE_COMMAND_REFUSALS,
  claudeCommandDecision,
  claudeCommandRefusal,
  claudeMenuCommands,
  isClaudeCommandRefusal,
  parseClaudeSlashCommand,
  CODEX_COMMAND_REFUSALS,
  CODEX_MENU_COMMANDS,
  codexCommandDecision,
  isCodexCommandRefusal,
  DSH_COMMAND_REFUSALS,
  dshMenuCommands,
  isDshCommandRefusal,
  claudeBridgeCompatibility,
  formatHistoryReferences,
  literalHistoryMatchRanges,
  HISTORY_REFERENCE_LIMIT,
  HISTORY_REFERENCE_BYTES,
} from "@agentkib/runtime-protocol";

/** These POSTs only read private history; aborting them never discards a command receipt. */
export function isHistoryReadPath(path: string): boolean {
  return ["history/search", "history/locate", "history/references"].includes(
    path.replace(/^\//, "").split("?")[0],
  );
}

export interface ConversationSessionSummary {
  /** Absent on hosts predating shared read state. */
  readState?: ConversationReadState;
  /** Read-only runtime observation; absent when the host has not observed an owner. */
  continuation?: {
    status: string;
    executionLocation?: "agentkib" | "terminal" | "external" | null;
    ownershipReason?: string | null;
    reason?: string | null;
  };
  /** A turn that the Codex app or CLI runs now; display only, never a control. */
  externalTurn?: { status: "running"; startedAt: string | null } | null;
  /** Verified index identities that route to this managed session. */
  indexedSessionIds?: string[];
  id: string;
  /** Exact history-index identity for an already managed native session. */
  indexedSessionId?: string;
  workspace_id: string;
  agent:
    | "codex"
    | "claude-code"
    | "antigravity"
    | "cursor"
    | "opencode"
    | "open-claw"
    | "hermes"
    | "grok-build"
    | "deepseek-harness"
    | "devin";
  title?: string;
  created_at?: string | null;
  updated_at?: string;
  origin?: "interactive" | "auxiliary" | "execution" | "unknown";
  forked_from_session_id?: string | null;
  spawned_by_session_id?: string | null;
  git_branch?: string | null;
  message_count?: number | null;
  availability: "readable" | "metadata-only";
  archived: boolean;
  sidechain: boolean;
  /** Present only when the host has a live observation for this session. */
  pendingInteraction?: boolean;
  /** The linked git worktree the session ran in; absent for a main checkout and older hosts. */
  worktree?: SessionWorktree | null;
}
export type CheckoutStatus = "present" | "deleted" | "unknown";
export interface SessionWorktree {
  repository_group_id: string | null;
  name: string;
  path: string;
  branch: string | null;
  status: CheckoutStatus;
}
/** Shared by every checkout of one repository; absent outside a repository and on older hosts. */
export interface WorkspaceCheckout {
  repository_group_id: string;
  kind: "primary" | "worktree";
  primary_path: string | null;
  name: string | null;
  branch: string | null;
  status: CheckoutStatus;
}
export interface ConversationWorkspaceSummary {
  id: string;
  name: string;
  path: string;
  checkout?: WorkspaceCheckout | null;
}
export interface ConversationCatalog {
  /** False while one or more source scopes still need verification. Absent on older hosts. */
  complete?: boolean;
  /** Retain cached rows only for these scopes during partial/background refreshes. */
  incompleteSources?: Array<{ workspaceId: string; agent: string }>;
  sessions: ConversationSessionSummary[];
  /** Global verified CLI floor; absent on older hosts, never a control grant. */
  codexRuntimeReason?: "codex-cli-version-too-old" | null;
  // Missing on older desktop hosts; never treat it as an empty known catalog.
  workspaces?: ConversationWorkspaceSummary[];
  indexEnabled: boolean;
}
export interface ConversationImage {
  id: string;
  mimeType?: string;
  name?: string;
}
export interface ConversationImageData {
  mimeType: string;
  base64: string;
}
export interface ConversationEvent {
  id: string;
  /** Native protocols without item identity may expose a temporary live overlay. */
  ephemeral?: boolean;
  kind: "user-message" | "agent-message" | "tool-summary";
  turn_id?: string | null;
  message_phase?: "commentary" | "final_answer" | null;
  timestamp?: string;
  content?: string;
  tool_name?: string;
  tool_status?: string;
  duration_ms?: number | null;
  attachment_count: number;
  /** Original message images are read separately, never embedded in event pages. */
  images?: ConversationImage[];
  truncated: boolean;
  /** Absent on older hosts; clients then show the tool name and status. */
  tool?: ConversationToolDetail;
  turn_meta?: ConversationTurnMeta;
  /**
   * Text the CLI wrote itself (a Claude Code local command's output, an API or failed-turn error
   * from Claude Code or Codex), shown with its line breaks and `<name>` placeholders as written.
   * Absent on older hosts.
   */
  cli_output?: boolean;
}
export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor?: string;
  warnings: string[];
}
export type Decision = string;
export type ArtifactPreviewKind =
  | "html"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "text"
  | "download";
export interface ArtifactEntry {
  id: string;
  name: string;
  kind: "file" | "directory";
  mime: string;
  size: number;
  modifiedAt: string;
  revision: string;
  previewKind: ArtifactPreviewKind;
}
export interface ArtifactListing {
  directoryId: string;
  parentId?: string;
  entries: ArtifactEntry[];
}
export interface ArtifactTicket {
  url: string;
  expiresAt: number;
  revision: string;
  kind: ArtifactPreviewKind;
}
/** A web preview of a local port, on the host's preview origin; it lapses when left idle. */
export interface LivePreviewTicket {
  url: string;
  expiresAt: number;
}
export interface Access {
  readStateVersion?: 1;
  accountLogin?: {
    required: true;
    proofVersion: 1;
    deviceId: string;
    challenge: string;
    bound: boolean;
    accountId?: string;
  };
  /** Additive capability; absent on older hosts. */
  historySearch?: true;
  historySearchScope?: string;
  /**
   * Notifications from this computer (`/push/subscribe`): present when this pairing can get
   * them, which needs an account-bound phone on the relay. Additive; absent on older hosts.
   */
  push?: { version: 1; subscribed: boolean; alerts?: boolean; liveActivity?: boolean };
  /** Missing on legacy hosts: history and receipts remain readable. */
  protocolVersion?: number;
  bearerToken?: string;
  pairingMode?: "code" | "confirmation";
  status: "unpaired" | "pending" | "approved" | "ended";
  csrfToken: string;
  bootId: string;
  device?: {
    accessMode?: "full";
    id: string;
    name: string;
    send: boolean;
    approve: boolean;
    manage?: boolean;
    files?: boolean;
    attachments?: boolean;
    advancedControl?: boolean;
    organize?: boolean;
    settings?: boolean;
    extendedApproval?: boolean;
  };
  pending?: { id: string; verification: string; expiresAt: string | number };
  experimentalEnabled: boolean;
}
export interface Approval {
  requestId: string | number;
  turnId: string;
  method: string;
  toolName?: string;
  input?: unknown;
  context?: {
    blockedPath?: unknown;
    decisionReason?: unknown;
    description?: unknown;
    permissionSuggestions?: unknown;
  };
  toolCall?: unknown;
  options?: { optionId: string; name: string; kind: string }[];
  command?: unknown;
  cwd?: string;
  changes?: unknown;
  availableDecisions: Decision[];
  supported: boolean;
  unsupportedReason?: string | null;
  unsupportedMetadata?: { field: string; type: string }[];
  decisionOptions?: {
    id: string;
    label: string;
    decision: unknown;
    scope: "once" | "session" | "persistent";
  }[];
  requestContext?: Record<string, unknown>;
  proposedExecpolicyAmendment?: string[] | null;
  environmentId?: "local" | null;
}
export interface UserQuestionRequest {
  requestId: string | number;
  turnId: string;
  method?: string;
  supported: boolean;
  unsupportedReason?: string | null;
  questions: {
    id: string;
    header?: string;
    question: string;
    options: { label: string; description?: string }[];
    isSecret?: boolean;
    secret?: boolean;
    multiSelect: boolean;
    allowCustom: boolean;
  }[];
}
export interface Live {
  sessionId: string;
  /** Backend incarnation captured by this state, distinct from the access boot id. */
  runtimeBootId?: string;
  status: string;
  revision: number;
  turnId?: string;
  sendEnabled: boolean;
  stopEnabled?: boolean;
  cancelling?: boolean;
  lastOutcome?: "cancelled" | null;
  approvals: Approval[];
  questions?: UserQuestionRequest[];
  reason?: string;
  executionLocation?: "agentkib" | "terminal" | "external" | null;
  ownershipReason?: string | null;
  continuationNotice?: "background-ended" | "owner-opened-elsewhere" | null;
  /** Ephemeral retirement event identity; a newly opened client must not replay an old notice. */
  continuationNoticeId?: string | null;
  /** Whether a connected terminal can take messages sent from AgentKib at all. */
  terminalSend?: boolean;
  /** Observed native terminal version; does not grant sending or stopping. */
  bridgeCompatibility?: import("@agentkib/runtime-protocol").ClaudeBridgeCompatibilityStatus | null;
  /** Authenticated offline reconnect failure; never a control grant. Null clears prior feedback. */
  bridgeConnectionFailure?:
    | import("@agentkib/runtime-protocol").ClaudeBridgeConnectionFailure
    | null;
  executionMode?:
    | "managed-resume"
    | "claude-managed"
    | "claude-follower"
    | "dsh-follower"
    | "acp-managed"
    | "codex-managed"
    | "codex-follower";
  cliVersion?: string;
  /** Changes when the original Claude terminal binding is replaced or revoked. */
  connectionGeneration?: string;
  model?: string;
  activity?: "compacting" | null;
  /**
   * Managed Claude and Codex: the CLI's latest retry of a failed request in the running turn.
   * `error` is the CLI's error kind (Claude `authentication_failed`, Codex `unauthorized`, …);
   * `detail` is Codex's own text about what failed.
   */
  apiRetry?: {
    attempt: number;
    maxRetries: number | null;
    status: number | null;
    error: string | null;
    detail?: string | null;
  } | null;
  tokenUsage?: unknown;
  streamText?: string;
  streamTextTruncated?: boolean;
  settings?: CodexSessionSettings;
  usage?: ContextUsage;
  goal?: CodexGoal;
  /**
   * Claude only. A `state` patch merges shallowly, so omitting this field leaves the previous
   * value in place; clearing it takes an explicit `{ mode: null }`.
   */
  permission?: LivePermission;
}
export type LegacyPreparedReceipt = {
  found: true;
  requestId: string;
  status: "not-dispatched";
  recovery: "legacy-prepared";
  completionObserved: false;
  sessionId?: never;
  operation?: never;
  turnId?: never;
};
export type ControlReceipt =
  | { found: false; requestId: string }
  | LegacyPreparedReceipt
  | {
      found: true;
      requestId: string;
      recovery?: never;
      sessionId: string;
      workspaceId?: string | null;
      operation?: string | null;
      executionMode?: string | null;
      runtimeBootId?: string | null;
      expectedRevision?: number | null;
      turnId?: string | null;
      status: "not-dispatched" | "accepted" | "unknown";
      ack?: {
        accepted?: boolean;
        completed?: boolean;
        requestId?: string;
        sessionId?: string;
        reconciled?: boolean;
        reason?: string;
        error?: string;
      } | null;
      completionObserved: boolean;
    };
// A legacy prepared claim was durably terminated before dispatch. Its metadata
// can be absent; it proves only that this exact request can leave the pending UI.
export function isLegacyPreparedReceipt(
  receipt: ControlReceipt,
  requestId: string,
): receipt is LegacyPreparedReceipt {
  return (
    receipt.found === true &&
    receipt.requestId === requestId &&
    receipt.status === "not-dispatched" &&
    receipt.recovery === "legacy-prepared" &&
    receipt.completionObserved === false
  );
}
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public controlOutcome?: "not-dispatched" | "unknown",
  ) {
    super(code);
  }
}
export type CodexAction =
  | "resume"
  | "inspect"
  | "steer"
  | "queue-add"
  | "queue-update"
  | "queue-delete"
  /** Moves a queued message into the running turn; only a connected DeepSeek Harness offers it. */
  | "queue-steer"
  | "queue-reorder"
  | "queue-start"
  | "rename"
  | "archive"
  | "unarchive"
  | "delete"
  | "fork"
  | "settings"
  | "goal-set"
  | "goal-pause"
  | "goal-resume"
  | "goal-clear"
  | "compact"
  | "terminals-clean";
export type SessionAction = CodexAction | "queue-pause" | "queue-resume";
export type ClaudePermissionMode = "default" | "plan" | "acceptEdits";
/**
 * Modes the Claude CLI can report about a running session. Only the first three can be
 * selected from AgentKib; the others are observed and displayed, never offered as choices.
 */
export type ClaudeObservedPermissionMode =
  | ClaudePermissionMode
  | "auto"
  | "dontAsk"
  | "bypassPermissions";
/** Display-only view of the permission mode a Claude session actually runs in. */
export interface LivePermission {
  /** The mode the CLI reported; null when no report has been observed. */
  mode: ClaudeObservedPermissionMode | null;
  /** `mode` comes from an earlier run in this backend process; the next run may start differently. */
  previous?: true;
  /** Only with `mode: null`, no selection and Claude Code 2.1.285+, where the CLI may start in auto. */
  possiblyAuto?: true;
}
export interface CodexCapabilities {
  sessionId: string;
  executionMode: string;
  status: string;
  reason?: string;
  features: Partial<
    Record<
      | SessionAction
      | "adopt"
      | "settings-state"
      | "goal"
      | "queue-list"
      | "attachments"
      | "context"
      | "resources"
      | "send"
      | "files"
      | "usage",
      { available: boolean; reason?: string }
    >
  >;
  /**
   * The agent's slash-command catalog: Claude Code's as its last worker reported it (empty before
   * any worker has run in the session), or the one a running DeepSeek Harness reports. Absent
   * for devices that cannot send.
   */
  commands?: ClaudeCommandEntry[];
}
export type SessionCapabilities = CodexCapabilities;
export interface ManagedOptions {
  available: boolean;
  reason?: string;
  cliVersion?: string;
  models?: {
    id: string;
    name?: string;
    efforts?: string[];
    isDefault?: boolean;
    defaultEffort?: string;
  }[];
  /** Codex: the model and effort a session starts with when none is chosen. */
  defaults?: { model?: string | null; effort?: string | null };
  /** Codex: the execution policies a session can start with. */
  policies?: { id: string; name: string; description?: string }[];
  permissionModes?: { id: ClaudePermissionMode; name: string; description?: string }[];
  /**
   * DeepSeek Harness's Agent presets, chosen only when a session starts. A preset DSH ships has
   * a null `name`; `dshAgentPresetText` in `@agentkib/session-ui` names it.
   */
  agentPresets?: {
    id: string;
    name: string | null;
    description: string | null;
    isDefault: boolean;
    broken: string | null;
  }[];
  workspaces: { id: string; name: string }[];
}
export interface ManagedInspection {
  sessionId: string;
  handoffFingerprint?: string;
  available?: boolean;
  reason?: string;
  executionLocation?: "agentkib" | "terminal" | "external" | null;
  ownershipReason?: string | null;
}
export interface CodexResumeCommand {
  available: true;
  command: string;
  shell: "posix" | "powershell";
  runOn: "host";
}
export interface ManagedActionBody {
  expectedRevision?: number;
  agent?: ManagedAgent;
  bootId: string;
  requestId: string;
  sessionId?: string;
  workspaceId?: string;
  name?: string;
  model?: string;
  effort?: string;
  permissionMode?: ClaudePermissionMode;
  /** Codex: the execution policy a new session starts with. */
  policyId?: string;
  /** DeepSeek Harness: the Agent preset a new session starts with. */
  agentPreset?: string;
  handoffConfirmed?: boolean;
  handoffFingerprint?: string;
}
export interface ManagedActionResult {
  accepted?: boolean;
  sessionId?: string;
  sourceSessionId?: string;
  reconciled?: boolean;
  live?: Live;
}
export interface UploadedAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  version: string;
}
export interface CodexQueueItem {
  id: string;
  status?: "pending" | "claimed" | "dispatched" | "unknown";
  hasAttachments?: boolean;
  clientUserMessageId?: string;
  text?: string;
  attachmentIds?: string[];
}
export interface CodexQueue {
  sessionId?: string;
  data: CodexQueueItem[];
  paused?: boolean;
  requiresResume?: boolean;
}
export type SessionQueue = CodexQueue;
export interface CodexOptions {
  available: boolean;
  reason?: string;
  models?: { id: string; name?: string; efforts?: string[] }[];
  workspaces: { id: string; name: string }[];
}
export interface CodexAvailability {
  available: boolean;
  reason?: string;
}
export interface ContextUsage {
  available: boolean;
  state?: "ready" | "pending" | "stale" | "unavailable";
  /** Native observer instance, ordered within a runtime boot independently of stream epochs. */
  reportGeneration?: number;
  /** Report sequence within its native observer, independent of the control revision. */
  reportId?: number;
  reason?: string;
  revision?: number;
  usedTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  percent?: number;
  updatedAt?: string;
}
export type CodexTokenUsage = ContextUsage;
export interface CodexSettingValues {
  modelId?: string;
  effort?: string;
  mode?: string;
  policyId?: string;
  serviceTierId?: string;
  permissionMode?: ClaudePermissionMode;
}
export interface CodexSessionSettings {
  sessionId: string;
  available: boolean;
  reason?: string;
  revision: number;
  executionMode?: string;
  status?: string;
  current: CodexSettingValues;
  selected?: CodexSettingValues;
  applicationStatus?: "pending" | "confirmed" | "unknown";
  defaults: {
    modelId?: string;
    effort?: string;
    serviceTierId?: string;
    permissionMode?: ClaudePermissionMode;
  };
  writable: {
    model: CodexAvailability;
    effort: CodexAvailability;
    mode: CodexAvailability;
    policy: CodexAvailability;
    serviceTier: CodexAvailability;
    restoreDefaults: CodexAvailability;
    permissionMode?: CodexAvailability;
  };
  options: {
    collaborationModes?: { id: "plan" | "default"; name: string }[];
    models: {
      id: string;
      resolvedModel?: string;
      name?: string;
      /** The provider the agent lists this model under, when it groups them (DeepSeek Harness). */
      group?: string;
      efforts: string[];
      defaultEffort?: string;
      serviceTierIds: string[];
    }[];
    policies: { id: string; name: string; description?: string }[];
    serviceTiers: { id: string; name: string; description?: string }[];
    permissionModes?: { id: ClaudePermissionMode; name: string; description?: string }[];
  };
  usage?: CodexTokenUsage;
}
export type SessionSettings = CodexSessionSettings;
export interface CodexGoal {
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed?: number;
  elapsedMs?: number;
  /** Rounds started and allowed, for an agent that bounds a goal by rounds (DeepSeek Harness). */
  rounds?: { used: number; limit: number };
  /** Why a blocked goal stopped, in the agent's own words. */
  detail?: string;
}
export interface CodexGoalState {
  sessionId: string;
  available: boolean;
  reason?: string;
  revision: number;
  /** What bounds a goal; tokens when absent. A round-bounded goal takes no token budget. */
  budget?: "rounds";
  goal?: CodexGoal;
  actions: {
    set: CodexAvailability;
    pause: CodexAvailability;
    resume: CodexAvailability;
    clear: CodexAvailability;
  };
}
export type SessionGoalState = CodexGoalState;
export type CodexContextResourceKind = "file" | "directory" | "skill" | "plugin" | "app";
export interface CodexContextResource {
  id: string;
  kind: CodexContextResourceKind;
  name: string;
  description?: string;
  /** Opaque host directory cursor; only present on browsable directories. */
  navigationId?: string;
  available: boolean;
  reason?: string;
}
export interface CodexContextOptions {
  sessionId: string;
  revision: number;
  directoryId?: string;
  parentId?: string;
  resources: CodexContextResource[];
}
export type SessionResource = CodexContextResource;
export type SessionResources = CodexContextOptions;
export interface CodexActionBody {
  historyReferences?: HistoryReference[];
  bootId: string;
  requestId: string;
  sessionId: string;
  expectedRevision: number;
  handoffConfirmed?: boolean;
  turnId?: string;
  name?: string;
  text?: string;
  attachmentIds?: string[];
  resourceIds?: string[];
  queuedSubmissionId?: string;
  queuedSubmissionIds?: string[];
  model?: string;
  effort?: string | null;
  mode?: "plan" | "default";
  policyId?: string;
  serviceTierId?: string | null;
  restoreDefaults?: true;
  objective?: string;
  intent?: "start" | "update";
  tokenBudget?: number | null;
}
export interface SessionActionBody extends Omit<CodexActionBody, "effort"> {
  effort?: string | null;
  permissionMode?: ClaudePermissionMode;
}
export interface SessionActionResult {
  accepted?: boolean;
  sessionId?: string;
  reconciled?: boolean;
  context?: unknown;
}

export type WebConnection = { type: "same-origin" } | { type: "lan-http"; origin: string };

export interface SessionStreamHandlers {
  /** Return the last cursor actually applied by the consumer; rejected frames never advance it. */
  event: (type: string, data: string, cursor?: string) => void | false | string;
  open: () => void;
  error: (error?: unknown) => void;
}

/** Trusted desktop transport. It implements the same public request projections. */
export interface ConversationClientBridge {
  request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  stream(sessionId: string, handlers: SessionStreamHandlers): () => void;
  uploadAttachment(
    sessionId: string,
    file: File,
    progress: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadedAttachment>;
}

/** Legacy origin strings remain supported; they only ever select private LAN HTTP. */
export function resolveWebConnection(connection: WebConnection | string = ""): WebConnection {
  const value =
    typeof connection === "string"
      ? connection
        ? { type: "lan-http" as const, origin: connection }
        : { type: "same-origin" as const }
      : connection;
  if (value.type === "lan-http") {
    if (parseLanOrigin(value.origin) !== value.origin) throw new Error("invalid_lan_address");
    return { type: "lan-http", origin: value.origin };
  }
  return { type: "same-origin" };
}

export class WebClient {
  readonly connection: WebConnection;
  readonly origin: string;
  csrfToken = "";
  private bearerToken = "";
  private compatible = false;
  private realtimeVersion = 0;
  private accessFlight?: Promise<Access>;
  constructor(
    private readonly transport?: typeof fetch,
    connection: WebConnection | string = { type: "same-origin" },
    private readonly bridge?: ConversationClientBridge,
  ) {
    this.connection = resolveWebConnection(connection);
    this.origin = this.connection.type === "lan-http" ? this.connection.origin : "";
  }
  reset() {
    this.bearerToken = "";
    this.csrfToken = "";
    this.compatible = false;
    this.realtimeVersion = 0;
  }
  async info(signal?: AbortSignal) {
    const info = await this.request<{
      protocolVersion: number;
      conversationProtocolVersion?: number;
      transport: string;
      capabilities: { read: boolean; send: boolean; approve: boolean };
    }>("info", undefined, signal);
    this.compatible =
      (info.protocolVersion === 1 || info.protocolVersion === 2) &&
      info.transport === "lan" &&
      info.capabilities?.read === true &&
      typeof info.capabilities.send === "boolean" &&
      typeof info.capabilities.approve === "boolean";
    if (!this.compatible) throw new ApiError(409, "incompatible_protocol");
    this.realtimeVersion = info.conversationProtocolVersion ?? info.protocolVersion;
    return info;
  }
  private headers(body?: unknown) {
    const headers: Record<string, string> = {};
    if (this.connection.type === "lan-http" && this.bearerToken)
      headers.Authorization = `Bearer ${this.bearerToken}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["X-CSRF-Token"] = this.csrfToken;
      // Old LAN hosts reject unknown headers during pairing preflight. Mutations
      // still require realtime v2 before reaching this transport boundary.
      if (this.realtimeVersion === 2) headers["X-AgentKib-Protocol"] = "2";
    }
    return headers;
  }
  async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const operation = path.split("?")[0];
    if (
      body !== undefined &&
      !isHistoryReadPath(path) &&
      !["pair", "pair/cancel", "logout"].includes(operation) &&
      this.realtimeVersion !== 2
    )
      throw new ApiError(409, "incompatible_protocol", "not-dispatched");
    if (this.bridge) return this.bridge.request<T>(path, body, signal);
    if (
      this.connection.type === "lan-http" &&
      path !== "info" &&
      (!this.compatible || (path !== "access" && !this.bearerToken))
    )
      throw new ApiError(401, "access_ended");
    const response = await (this.transport ?? fetch)(`${this.origin}/api/web/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      credentials: this.connection.type === "lan-http" ? "omit" : "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: signal ?? AbortSignal.timeout(this.connection.type === "lan-http" ? 15000 : 25000),
      headers: this.headers(body),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let code = "request_failed";
      let controlOutcome: ApiError["controlOutcome"];
      try {
        const value = await response.json();
        code = value.code ?? value.error ?? code;
        if (value.controlOutcome === "not-dispatched" || value.controlOutcome === "unknown")
          controlOutcome = value.controlOutcome;
      } catch {
        /* Never expose raw HTML/proxy bodies. */
      }
      throw new ApiError(
        response.status,
        typeof code === "string" ? code : "request_failed",
        controlOutcome,
      );
    }
    return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
  }
  async access(signal?: AbortSignal) {
    if (this.connection.type === "lan-http" && this.accessFlight) return this.accessFlight;
    const pending = this.loadAccess(signal);
    if (this.connection.type === "same-origin") return pending;
    this.accessFlight = pending;
    try {
      return await pending;
    } finally {
      if (this.accessFlight === pending) this.accessFlight = undefined;
    }
  }
  private async loadAccess(signal?: AbortSignal) {
    if (this.connection.type === "lan-http" && !this.compatible) await this.info(signal);
    const result = await this.request<Access>("access", undefined, signal);
    if (result.accountLogin !== undefined) {
      const login = result.accountLogin;
      if (
        !login ||
        login.required !== true ||
        login.proofVersion !== 1 ||
        !/^[a-f0-9]{32}$/.test(login.deviceId) ||
        !/^[A-Za-z0-9_-]{43}$/.test(login.challenge) ||
        typeof login.bound !== "boolean" ||
        (login.required && !login.bound && result.status === "approved")
      )
        throw new ApiError(502, "invalid_account_login");
    }
    if (this.connection.type === "lan-http" && !this.bearerToken) {
      if (!result.bearerToken) throw new ApiError(401, "access_ended");
      this.bearerToken = result.bearerToken;
    }
    this.csrfToken = result.csrfToken;
    this.realtimeVersion = result.protocolVersion ?? 0;
    const { bearerToken: _credential, ...publicAccess } = result;
    return publicAccess;
  }
  stream(sessionId: string, handlers: SessionStreamHandlers) {
    if (this.realtimeVersion !== 2) {
      queueMicrotask(() => handlers.error(new ApiError(409, "incompatible_protocol")));
      return () => {};
    }
    if (this.bridge) return this.bridge.stream(sessionId, handlers);
    const query = new URLSearchParams({ protocolVersion: "2" });
    if (sessionId) query.set("sessionId", sessionId);
    const path = `/api/web/v1/stream?${query}`;
    if (this.connection.type === "same-origin") {
      let closed = false;
      let source: EventSource | undefined;
      let cursor: string | undefined;
      let retry: ReturnType<typeof setTimeout> | undefined;
      const connect = () => {
        if (closed) return;
        const current = new EventSource(
          cursor ? `${path}&afterCursor=${encodeURIComponent(cursor)}` : path,
        );
        source = current;
        for (const type of [
          "session-event",
          "session-ready",
          "control-changed",
          "catalog-invalidated",
          "access-changed",
          "unavailable",
          "access-ended",
        ])
          current.addEventListener(type, (e) => {
            if (closed || source !== current) return;
            const event = e as MessageEvent;
            const applied = handlers.event(type, event.data, event.lastEventId || undefined);
            if (typeof applied === "string") cursor = applied;
            if (type === "access-ended") {
              closed = true;
              current.close();
              clearTimeout(retry);
            }
          });
        current.onopen = () => {
          if (!closed && source === current) handlers.open();
        };
        current.onerror = () => {
          if (closed || source !== current) return;
          // EventSource's implicit Last-Event-ID includes unaccepted frames. Recreate
          // the connection ourselves using only the reducer's applied cursor.
          current.close();
          source = undefined;
          handlers.error();
          if (!closed) retry = setTimeout(connect, 2000);
        };
      };
      connect();
      return () => {
        closed = true;
        source?.close();
        clearTimeout(retry);
      };
    }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: string | undefined;
    const run = async () => {
      try {
        if (!this.bearerToken || !this.compatible) throw new ApiError(401, "access_ended");
        const streamPath = cursor ? `${path}&afterCursor=${encodeURIComponent(cursor)}` : path;
        const response = await (this.transport ?? fetch)(`${this.origin}${streamPath}`, {
          headers: this.headers(),
          credentials: "omit",
          cache: "no-store",
          redirect: "error",
          signal: abort.signal,
        });
        if (response.status === 401 || response.status === 403) {
          handlers.event("access-ended", "");
          return;
        }
        if (
          !response.ok ||
          !response.body ||
          !response.headers.get("content-type")?.includes("text/event-stream")
        )
          throw new Error("stream_unavailable");
        handlers.open();
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        const parser = new SseParser((type, data, id) => {
          const applied = handlers.event(type, data, id);
          if (typeof applied === "string") cursor = applied;
          if (type === "access-ended") abort.abort();
        });
        try {
          while (!abort.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            parser.push(decoder.decode(value, { stream: true }));
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!abort.signal.aborted) handlers.error();
      } catch (error) {
        if (!abort.signal.aborted) handlers.error(error);
      }
      if (!abort.signal.aborted) timer = setTimeout(() => void run(), 2000);
    };
    void run();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }
  managedOptions(agent: ManagedAgent = "codex", signal?: AbortSignal) {
    return this.request<ManagedOptions>(
      agent === "codex" ? "managed/options" : `managed/options?${new URLSearchParams({ agent })}`,
      undefined,
      signal,
    );
  }
  managedInspect(sessionId: string, agent: ManagedAgent, signal?: AbortSignal) {
    return this.request<ManagedInspection>(
      `managed/inspect?${new URLSearchParams({ sessionId, agent })}`,
      undefined,
      signal,
    );
  }
  codexResumeCommand(sessionId: string, signal?: AbortSignal) {
    return this.request<CodexResumeCommand>(
      `managed/resume-command?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  claudeResumeCommand(sessionId: string, signal?: AbortSignal) {
    return this.request<CodexResumeCommand>(
      `managed/resume-command?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  managedAction(operation: "create" | "adopt" | "release" | "reconcile", body: ManagedActionBody) {
    return this.request<ManagedActionResult>(`managed/${operation}`, body);
  }
  sessionCapabilities(sessionId: string, agent: ManagedAgent, signal?: AbortSignal) {
    return agent === "codex"
      ? this.codexCapabilities(sessionId, signal)
      : this.request<SessionCapabilities>(
          `managed/capabilities?${new URLSearchParams({ sessionId, agent })}`,
          undefined,
          signal,
        );
  }
  sessionAction(
    action: SessionAction,
    body: SessionActionBody,
    agent: ManagedAgent,
  ): Promise<SessionActionResult> {
    if (agent === "codex") {
      if (action === "queue-pause" || action === "queue-resume")
        return Promise.reject(new ApiError(409, "operation_unavailable", "not-dispatched"));
      return this.codexAction(action, body);
    }
    if (action === "inspect")
      return this.managedInspect(body.sessionId, agent).then((context) => ({ context }));
    return this.request<{
      accepted?: boolean;
      sessionId?: string;
      reconciled?: boolean;
      context?: unknown;
    }>("managed/action", { ...body, operation: action, agent });
  }
  sessionSettings(sessionId: string, agent: ManagedAgent, signal?: AbortSignal) {
    return agent === "codex"
      ? this.codexSessionSettings(sessionId, signal)
      : this.request<SessionSettings>(
          `managed/settings?${new URLSearchParams({ sessionId, agent })}`,
          undefined,
          signal,
        );
  }
  prepareSessionSettings(
    body: { sessionId: string; bootId: string; expectedRevision: number },
    signal?: AbortSignal,
  ) {
    return this.request<SessionSettings>("managed/settings-prepare", body, signal);
  }
  sessionQueue(sessionId: string, agent: ManagedAgent, signal?: AbortSignal) {
    return agent === "codex"
      ? this.codexQueue(sessionId, signal)
      : this.request<SessionQueue>(
          `managed/queue?${new URLSearchParams({ sessionId, agent })}`,
          undefined,
          signal,
        );
  }
  sessionGoals(sessionId: string, agent: ManagedAgent, signal?: AbortSignal) {
    return agent === "codex"
      ? this.codexGoals(sessionId, signal)
      : this.request<SessionGoalState>(
          `managed/goals?${new URLSearchParams({ sessionId, agent })}`,
          undefined,
          signal,
        );
  }
  sessionResources(
    sessionId: string,
    agent: ManagedAgent,
    directoryId?: string,
    signal?: AbortSignal,
  ) {
    if (agent === "codex") return this.codexContextOptions(sessionId, directoryId, signal);
    const query = new URLSearchParams({ sessionId, agent });
    if (directoryId) query.set("directoryId", directoryId);
    return this.request<SessionResources>(`managed/resources?${query}`, undefined, signal);
  }
  codexCapabilities(sessionId: string, signal?: AbortSignal) {
    return this.request<CodexCapabilities>(
      `codex/capabilities?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  codexQueue(sessionId: string, signal?: AbortSignal) {
    return this.request<CodexQueue>(
      `codex/queue?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  codexSessionSettings(sessionId: string, signal?: AbortSignal) {
    return this.request<CodexSessionSettings>(
      `codex/session-settings?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  codexGoals(sessionId: string, signal?: AbortSignal) {
    return this.request<CodexGoalState>(
      `codex/goals?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  codexContextOptions(sessionId: string, directoryId?: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ sessionId });
    if (directoryId) query.set("directoryId", directoryId);
    return this.request<CodexContextOptions>(`codex/context-options?${query}`, undefined, signal);
  }
  codexAction(action: CodexAction, body: SessionActionBody) {
    if (body.effort === null)
      return Promise.reject(new ApiError(400, "invalid_effort", "not-dispatched"));
    return this.request<{
      accepted?: boolean;
      sessionId?: string;
      reconciled?: boolean;
      context?: unknown;
    }>(`codex/${action}`, body);
  }
  attachments(sessionId: string, signal?: AbortSignal) {
    return this.request<{ attachments: UploadedAttachment[] }>(
      `attachments?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  uploadAttachment(
    sessionId: string,
    file: File,
    progress: (percent: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadedAttachment> {
    if (this.connection.type === "lan-http" && (!this.compatible || !this.bearerToken))
      return Promise.reject(new ApiError(401, "access_ended"));
    if (this.realtimeVersion !== 2)
      return Promise.reject(new ApiError(409, "incompatible_protocol", "not-dispatched"));
    if (this.bridge) return this.bridge.uploadAttachment(sessionId, file, progress, signal);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = () => signal?.removeEventListener("abort", abort);
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      xhr.open(
        "POST",
        `${this.origin}/api/web/v1/attachments?${new URLSearchParams({ sessionId, name: file.name, mime: file.type || "application/octet-stream" })}`,
      );
      xhr.timeout = 120000;
      xhr.withCredentials = this.connection.type === "same-origin";
      for (const [key, value] of Object.entries(this.headers({})))
        if (key !== "Content-Type") xhr.setRequestHeader(key, value);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        finish();
        try {
          const value = JSON.parse(xhr.responseText);
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(
              new ApiError(
                xhr.status,
                typeof value.code === "string" ? value.code : "upload_failed",
              ),
            );
            return;
          }
          if (
            !value ||
            typeof value.id !== "string" ||
            typeof value.name !== "string" ||
            typeof value.mime !== "string" ||
            typeof value.size !== "number" ||
            typeof value.version !== "string"
          )
            throw new Error("invalid_attachment_response");
          resolve(value as UploadedAttachment);
        } catch {
          reject(new ApiError(xhr.status, "upload_failed"));
        }
      };
      xhr.onerror = xhr.ontimeout = () => {
        finish();
        reject(new ApiError(0, "upload_failed"));
      };
      xhr.onabort = () => {
        finish();
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      xhr.send(file);
    });
  }
  receipt(requestId: string, signal?: AbortSignal) {
    return this.request<ControlReceipt>(
      `requests/${encodeURIComponent(requestId)}`,
      undefined,
      signal,
    );
  }
  historySearch(query: HistorySearchQuery, signal?: AbortSignal) {
    return this.request<HistorySearchResult>("history/search", query, signal);
  }
  historyLocate(location: HistoryLocation, signal?: AbortSignal) {
    return this.request<HistoryLocatedRecord>("history/locate", location, signal);
  }
  historyReferences(references: HistoryReference[], signal?: AbortSignal) {
    return this.request<{ references: ResolvedHistoryReference[]; text: string }>(
      "history/references",
      { references },
      signal,
    );
  }
  historyStatus(signal?: AbortSignal) {
    return this.request<HistorySearchStatus>("history/status", undefined, signal);
  }
  historyConfigure(enabled: boolean) {
    return this.request<HistorySearchStatus>("history/configure", { enabled });
  }
  historyClear() {
    return this.request<HistorySearchStatus>("history/clear", {});
  }
  historyRebuild() {
    return this.request<HistorySearchStatus>("history/rebuild", {});
  }
  catalog(signal?: AbortSignal) {
    return this.request<ConversationCatalog>("catalog", undefined, signal);
  }
  readState(sessionId: string, signal?: AbortSignal) {
    return this.request<{ readState: ConversationReadState }>(
      `read-state?${new URLSearchParams({ sessionId })}`,
      undefined,
      signal,
    );
  }
  /** A lost ACK is resolved by a GET, never by replaying the write. */
  async acknowledgeReadState(
    sessionId: string,
    expectedVersion: string,
    seenResultId: string | null,
    signal?: AbortSignal,
  ) {
    try {
      const result = await this.request<{ readState: ConversationReadState }>(
        "read-state",
        { sessionId, expectedVersion, seenResultId },
        signal,
      );
      return { ...result, acknowledged: true };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (
        error instanceof ApiError &&
        error.status !== 409 &&
        error.status > 0 &&
        error.status < 500
      )
        throw error;
      const result = await this.readState(sessionId, signal);
      return { ...result, acknowledged: false };
    }
  }
  events(sessionId: string, cursor?: string, signal?: AbortSignal) {
    const q = new URLSearchParams({ sessionId, limit: "50" });
    if (cursor) q.set("cursor", cursor);
    return this.request<ConversationEventPage>(`events?${q}`, undefined, signal);
  }
  sessionImage(sessionId: string, imageId: string, signal?: AbortSignal) {
    return this.request<ConversationImageData>(
      `session-images?${new URLSearchParams({ sessionId, imageId })}`,
      undefined,
      signal,
    );
  }
  live(sessionId: string, signal?: AbortSignal) {
    return this.request<Live>(`live?${new URLSearchParams({ sessionId })}`, undefined, signal);
  }
}

/** Reject alternate numeric spellings before URL normalization can hide them. */
export function parseLanOrigin(value: string): string {
  const match = /^http:\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})$/.exec(value.trim());
  if (!match) throw new Error("invalid_lan_address");
  const octets = match[1].split(".").map(Number);
  if (octets.some((n, i) => n > 255 || String(n) !== match[1].split(".")[i]))
    throw new Error("invalid_lan_address");
  const [a, b] = octets,
    port = Number(match[2]);
  if (
    !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) ||
    port < 1 ||
    port > 65535 ||
    String(port) !== match[2]
  )
    throw new Error("invalid_lan_address");
  return `http://${match[1]}:${port}`;
}

export class SseParser {
  private lineParts: string[] = [];
  private lineBytes = 0;
  private lastCodeUnit = 0;
  private event = "message";
  private id: string | undefined;
  private data: string[] = [];
  private dataBytes = 0;
  private encoder = new TextEncoder();
  constructor(private readonly emit: (event: string, data: string, cursor?: string) => void) {}
  push(chunk: string) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf("\n", start);
      const part = chunk.slice(start, end < 0 ? chunk.length : end);
      if (part) {
        this.lineBytes += this.encoder.encode(part).byteLength;
        // A surrogate pair split between push calls encodes as four bytes, not
        // two replacement characters (six bytes). TextDecoder normally avoids this.
        const first = part.charCodeAt(0);
        if (
          this.lastCodeUnit >= 0xd800 &&
          this.lastCodeUnit <= 0xdbff &&
          first >= 0xdc00 &&
          first <= 0xdfff
        )
          this.lineBytes -= 2;
        this.lastCodeUnit = part.charCodeAt(part.length - 1);
        if (this.lineBytes + this.dataBytes > 4 * 1024 * 1024 + 1024)
          throw new Error("stream_too_large");
        this.lineParts.push(part);
      }
      if (end < 0) return;
      // Join only completed lines: neither scanning nor byte accounting revisits
      // an accumulated near-4 MiB prefix on every network chunk.
      const line = this.lineParts.join("").replace(/\r$/, "");
      this.lineParts = [];
      this.lineBytes = 0;
      this.lastCodeUnit = 0;
      start = end + 1;
      if (!line) {
        if (this.data.length) {
          if (this.id) this.emit(this.event, this.data.join("\n"), this.id);
          else this.emit(this.event, this.data.join("\n"));
        }
        this.event = "message";
        this.data = [];
        this.dataBytes = 0;
      } else if (line.startsWith("id:")) {
        const id = line.slice(3).replace(/^ /, "");
        if (id.length > 4096) throw new Error("stream_cursor_too_large");
        if (!id.includes("\0")) this.id = id;
      } else if (line.startsWith("event:")) {
        if (line.length > 128) throw new Error("stream_too_large");
        this.event = line.slice(6).replace(/^ /, "");
      } else if (line.startsWith("data:")) {
        const value = line.slice(5).replace(/^ /, "");
        this.dataBytes += this.encoder.encode(value).byteLength + (this.data.length ? 1 : 0);
        if (this.dataBytes > 4 * 1024 * 1024) throw new Error("stream_too_large");
        this.data.push(value);
      }
    }
  }
}

/** What the session list offers for a session without opening it. */
export type SessionManagementAction = "rename" | "archive" | "unarchive" | "delete";
export type SessionManagementFeatures = Partial<
  Record<SessionManagementAction, { available: boolean; reason?: string }>
>;
const SESSION_MANAGEMENT_ACTIONS: readonly SessionManagementAction[] = [
  "rename",
  "archive",
  "unarchive",
  "delete",
];

/**
 * The management actions the host reports for a session, read as its own view would. Only the
 * actions the host names are returned: an agent that cannot archive reports none.
 */
export async function sessionManagementFeatures(
  client: WebClient,
  session: { id: string; agent: string },
  signal?: AbortSignal,
): Promise<SessionManagementFeatures> {
  const agent = managedAgentOf(session.agent);
  if (!agent) return {};
  const capabilities = await client.sessionCapabilities(session.id, agent, signal);
  const features: SessionManagementFeatures = {};
  for (const action of SESSION_MANAGEMENT_ACTIONS) {
    const feature = capabilities.features[action];
    if (feature) features[action] = feature;
  }
  return features;
}

/**
 * Runs one management action against the session's current revision, as its own view does, with
 * a fresh request ID. A refusal arrives as an ApiError with the host's reason.
 */
export async function runSessionManagement(
  client: WebClient,
  session: { id: string; agent: string },
  action: SessionManagementAction,
  fields: { name?: string } = {},
): Promise<SessionActionResult> {
  const agent = managedAgentOf(session.agent);
  if (!agent) throw new ApiError(409, "capability_unavailable", "not-dispatched");
  const access = await client.access();
  if (access.status !== "approved") throw new ApiError(401, "access_ended", "not-dispatched");
  const live = await client.live(session.id);
  return client.sessionAction(
    action,
    {
      ...fields,
      sessionId: session.id,
      bootId: access.bootId,
      expectedRevision: live.revision ?? 0,
      requestId: crypto.randomUUID(),
    },
    agent,
  );
}

/**
 * Whether a control sent to this session leaves a receipt on the host. Its identity is then kept
 * in this browser before it is sent, so an outcome that turns out unknown can be checked later
 * instead of being sent again.
 */
export function needsDurableReceipt(
  agent: string | undefined,
  executionMode?: string | null,
): boolean {
  return (
    managedAgentOf(agent ?? "") !== null ||
    executionMode === "claude-managed" ||
    executionMode === "dsh-follower" ||
    !!executionMode?.startsWith("codex-")
  );
}

/** The fields every decision sends with it; `answerRequestBody` in session-ui takes the same. */
export type InteractionReplyContext = {
  sessionId: string;
  bootId: string;
  expectedRevision: number;
};

/** A decision on one approval, or the answers to one question request, as its card showed it. */
export type InteractionReply =
  | { kind: "approve"; approval: Approval; decision: Decision }
  | { kind: "approve"; approval: Approval; nativeDecision: unknown }
  | {
      kind: "answer";
      question: UserQuestionRequest;
      /** The request body for the chosen answers: `answerRequestBody` from session-ui. */
      body: (context: InteractionReplyContext, requestId: string) => Record<string, unknown>;
    };

/** Where a control's identity stays until its outcome is known (the pending-control store). */
export interface InteractionReplyPending {
  /** Throws when the identity cannot be kept, or another control of the session is unsettled. */
  remember(entry: {
    requestId: string;
    sessionId: string;
    kind: "approve" | "answer" | "stop";
  }): void;
  forget(requestId: string): void;
}

export type InteractionReplyResult =
  | { status: "accepted"; requestId: string }
  /** The request no longer waits as the card showed it, or the turn no longer runs; nothing was sent. */
  | { status: "gone" }
  /** This device may not decide it, or the Agent cannot take it from here; nothing was sent. */
  | { status: "refused"; reason: string }
  /** Nothing ran: the host refused it, or it could not be sent. `reason` is the code. */
  | { status: "not-dispatched"; reason: string }
  /** It may have run. It is never sent again; a kept identity lets the host's receipt settle it. */
  | { status: "unknown"; requestId: string; durable: boolean }
  | { status: "access-ended" };

type ControlCheck =
  | { status: "ready"; kind: "approve" | "answer" | "stop"; body: (requestId: string) => object }
  | Exclude<InteractionReplyResult, { status: "accepted" | "unknown" }>;

/**
 * Sends one control for a session from outside its own view. Access and the session's state are
 * read again first, so `check` decides against the current revision; a control that leaves a
 * receipt keeps its identity before it is sent, and one whose outcome is unknown is never resent.
 */
async function controlFromOutside(
  client: WebClient,
  session: { id: string; agent: string },
  check: (access: Access, live: Live) => ControlCheck,
  pending?: InteractionReplyPending,
): Promise<InteractionReplyResult> {
  let access: Access;
  let live: Live;
  try {
    access = await client.access();
    if (access.status !== "approved") return { status: "access-ended" };
    live = await client.live(session.id);
  } catch (error) {
    if (error instanceof ApiError && error.code === "access_ended")
      return { status: "access-ended" };
    return {
      status: "not-dispatched",
      reason: error instanceof ApiError ? error.code : "connection_failed",
    };
  }
  const checked = check(access, live);
  if (checked.status !== "ready") return checked;
  const durable = needsDurableReceipt(session.agent, live.executionMode);
  const requestId = crypto.randomUUID();
  if (durable)
    try {
      if (!pending) throw new Error("pending_storage_unavailable");
      pending.remember({ requestId, sessionId: session.id, kind: checked.kind });
    } catch {
      return { status: "not-dispatched", reason: "pending_storage_unavailable" };
    }
  try {
    await client.request(checked.kind, checked.body(requestId));
  } catch (error) {
    if (error instanceof ApiError && error.controlOutcome === "not-dispatched") {
      try {
        if (durable) pending?.forget(requestId);
      } catch {
        // Storage that cannot be written keeps the identity; its receipt settles it later.
      }
      return { status: "not-dispatched", reason: error.code };
    }
    if (error instanceof ApiError && error.code === "access_ended")
      return { status: "access-ended" };
    return { status: "unknown", requestId, durable };
  }
  if (durable)
    try {
      pending?.forget(requestId);
    } catch {
      // Kept identities are settled by their receipt.
    }
  return { status: "accepted", requestId };
}

/**
 * Sends one decision for a session from outside its own view, such as the home or the menu bar,
 * with the checks the session view makes: the request must still wait exactly as its card showed
 * it, this device must be allowed to decide it, and controls that leave a receipt keep their
 * identity before they are sent. Access and the session's state are read again first, so the
 * decision goes against the current revision.
 */
export function replyToInteraction(
  client: WebClient,
  session: { id: string; agent: string },
  reply: InteractionReply,
  pending?: InteractionReplyPending,
): Promise<InteractionReplyResult> {
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  return controlFromOutside(
    client,
    session,
    (access, live) => {
      const device = access.device;
      const context = {
        sessionId: session.id,
        bootId: access.bootId,
        expectedRevision: live.revision,
      };
      if (reply.kind === "approve") {
        const { approval } = reply;
        if (!live.approvals.some((current) => same(current, approval))) return { status: "gone" };
        if (!access.experimentalEnabled || !device?.approve)
          return { status: "refused", reason: "approve_not_permitted" };
        if (!approval.supported) return { status: "refused", reason: "approval_unsupported" };
        if (
          "nativeDecision" in reply &&
          (!device.extendedApproval ||
            !approval.decisionOptions?.some((option) =>
              same(option.decision, reply.nativeDecision),
            ))
        )
          return { status: "refused", reason: "decision_unavailable" };
        return {
          status: "ready",
          kind: "approve",
          body: (requestId) => ({
            ...context,
            requestId,
            turnId: approval.turnId,
            approvalId: approval.requestId,
            ...("nativeDecision" in reply
              ? { nativeDecision: reply.nativeDecision }
              : { decision: reply.decision }),
          }),
        };
      }
      const { question } = reply;
      if (!live.questions?.some((current) => same(current, question))) return { status: "gone" };
      if (!access.experimentalEnabled || !device?.send)
        return { status: "refused", reason: "send_not_permitted" };
      if (!question.supported) return { status: "refused", reason: "question_unsupported" };
      return {
        status: "ready",
        kind: "answer",
        body: (requestId) => reply.body(context, requestId),
      };
    },
    pending,
  );
}

/**
 * Stops a session's running turn from outside its own view, such as the menu bar, with the
 * session view's checks: the turn must still be one this computer can stop, and this device must
 * be allowed to send. The session's state is read again first, so the stop names the turn that
 * runs now and goes against the current revision.
 */
export function stopSessionTurn(
  client: WebClient,
  session: { id: string; agent: string },
  pending?: InteractionReplyPending,
): Promise<InteractionReplyResult> {
  return controlFromOutside(
    client,
    session,
    (access, live) => {
      if (live.stopEnabled !== true || !live.turnId) return { status: "gone" };
      if (!access.experimentalEnabled || !access.device?.send)
        return { status: "refused", reason: "send_not_permitted" };
      const turnId = live.turnId;
      return {
        status: "ready",
        kind: "stop",
        body: (requestId) => ({
          sessionId: session.id,
          requestId,
          bootId: access.bootId,
          expectedRevision: live.revision,
          turnId,
        }),
      };
    },
    pending,
  );
}

/**
 * What a host receipt says about a kept control identity: it ran, it never ran, or nothing is
 * known yet. Only a receipt for exactly this request, session and operation settles it.
 */
export function settledReceipt(
  receipt: ControlReceipt,
  entry: { requestId: string; sessionId?: string; kind: string },
): "accepted" | "not-dispatched" | undefined {
  if (!receipt.found || receipt.requestId !== entry.requestId) return undefined;
  if (isLegacyPreparedReceipt(receipt, entry.requestId)) return "not-dispatched";
  if (
    receipt.recovery !== undefined ||
    (entry.sessionId && receipt.sessionId !== entry.sessionId) ||
    receipt.operation !== entry.kind ||
    receipt.status === "unknown"
  )
    return undefined;
  return receipt.status;
}

/** A page on this computer to preview: a dev server a session printed, or one the user typed. */
export interface LocalPreviewTarget {
  /** Dev servers started with HTTPS keep it. */
  secure: boolean;
  port: number;
  /** Path, query and fragment, starting with "/". */
  path: string;
  /** How this computer itself reaches the page; the host is always localhost. */
  url: string;
}

// http(s)://<loopback>:<port>[/path]; a port is required.
const LOOPBACK_URL =
  /\b(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})(?!\d)(\/[^\s"'<>`\\)\]}]*)?/gi;
const TYPED_LOOPBACK =
  /^(?:(https?):\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{1,5})([/?#]\S*)?$/i;
// Terminal colors can split a printed URL ("localhost:" ESC[1m "5173").
// oxlint-disable-next-line no-control-regex
const TERMINAL_STYLE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

function previewTarget(secure: boolean, port: number, rest = ""): LocalPreviewTarget | null {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
  let path = (rest.startsWith("/") ? rest : `/${rest}`).slice(0, 2048);
  // Tool output has secret query values redacted; such a query cannot be reused.
  if (path.includes("[REDACTED")) path = path.split("?")[0]!;
  // Dev servers print punctuation after their URL ("ready at http://…/.").
  path = path.replace(/[.,;:!?]+$/, "") || "/";
  const url = `${secure ? "https" : "http"}://localhost:${port}${path}`;
  return { secure, port, path, url };
}

/**
 * Where a page address can appear in these events, oldest first: the message text, and a tool's
 * command and output (a dev server prints its URL there; tool rows often have no text of their
 * own). Diff previews are left out: an address in changed source is not a running page.
 */
export function localPreviewTexts(events: readonly ConversationEvent[]): string[] {
  const texts: string[] = [];
  for (const event of events) {
    if (event.content) texts.push(event.content);
    if (event.tool?.title) texts.push(event.tool.title);
    for (const part of event.tool?.content ?? [])
      if (part.type === "terminal") texts.push(part.command ?? "", part.output ?? "");
      else if (part.type === "text") texts.push(part.text);
  }
  return texts;
}

/** Loopback URLs in these texts, newest first (later texts and later matches win), one per port. */
export function localPreviewTargets(texts: readonly string[], limit = 8): LocalPreviewTarget[] {
  const found: LocalPreviewTarget[] = [];
  const seen = new Set<number>();
  for (let index = texts.length - 1; index >= 0 && found.length < limit; index--) {
    const text = texts[index]!.replace(TERMINAL_STYLE, "");
    for (const match of [...text.matchAll(LOOPBACK_URL)].reverse()) {
      const target = previewTarget(match[1]!.toLowerCase() === "https", Number(match[2]), match[3]);
      if (!target || seen.has(target.port)) continue;
      seen.add(target.port);
      found.push(target);
      if (found.length >= limit) break;
    }
  }
  return found;
}

/** "5173", "localhost:5173/app" or "http://127.0.0.1:5173/app"; any other host is refused. */
export function parseLocalPreviewTarget(input: string): LocalPreviewTarget | null {
  const value = input.trim();
  if (/^\d{1,5}$/.test(value)) return previewTarget(false, Number(value));
  const match = TYPED_LOOPBACK.exec(value);
  return match
    ? previewTarget(match[1]?.toLowerCase() === "https", Number(match[2]), match[3])
    : null;
}

/** "localhost:5173/app", with the scheme only when it is HTTPS. */
export function localPreviewLabel(target: LocalPreviewTarget): string {
  return target.secure ? target.url : target.url.slice("http://".length);
}
