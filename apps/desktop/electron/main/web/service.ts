import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  CONVERSATION_PROTOCOL_VERSION,
  CLAUDE_PERMISSION_MODES,
  HISTORY_SEARCH_METHODS,
  SESSION_OUTCOME_GRACE_MS,
  REMOTE_CAPABILITIES,
  REMOTE_CONTROL_OUTCOMES,
  parseRemoteErrorCode,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  REMOTE_FEATURE_VERSIONS,
  REMOTE_HEADERS,
  REMOTE_VERSIONS,
  REMOTE_LEGACY_CODEX,
  REMOTE_MANAGED_ACTION_OPERATIONS,
  REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT,
  REMOTE_ROUTE,
  REMOTE_ROUTE_BASE,
  REMOTE_ROUTE_PREFIXES,
  SESSION_RESOURCE_LIMIT,
  managedAgentOf,
  sessionProviderCapabilities,
  sessionProviderDeclaration,
  type ConversationReadStateUpdate,
  type HistoryReference,
  type ManagedAgent,
  type RemoteErrorCode,
  type SessionApprovalAuditContext,
  type ResolvedHistoryReference,
  type SessionPendingInteraction,
  type SessionProviderCapabilities,
  type SessionAttachmentKinds,
  type SessionQueueItemActions,
} from "@agentkib/runtime-protocol";
import {
  historyInputHash,
  historyLocation,
  historyReferences,
  historyText,
} from "./history-references";
import * as readRequestErrors from "./read-request-errors";
import { EventEmitter } from "node:events";
import { approvalAuditEvidence } from "@agentkib/backend/approval-audit-decisions";
import type { nativeApprovalRules } from "@agentkib/backend/approval-rule-providers";
import { projectContextUsage } from "@agentkib/backend/context-usage";
import {
  isSerialQueueMode,
  serialQueueRequiresSend,
  validateEmbeddedControl,
  type HostControlValidationCall,
  type HostControlValidationResult,
  type ProviderValidation,
} from "@agentkib/backend/session-control-validation";
import { createServer, ServerResponse, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { ArtifactService, ArtifactError } from "./artifacts";
import { AttachmentStore, AttachmentError, type AttachmentFormat } from "./attachments";
import { LivePreviewError, LivePreviewService } from "./live-preview";
import {
  isStoredCredential,
  SESSION_ID,
  writeWebAccessSnapshot,
  type AccountBinding,
  type Credential,
  type PushSubscription,
} from "./access-state";
import { isReadStateUpdateBody } from "./read-state-request";
import {
  dispatchClaude,
  requestSessionWithTerminalDisplay,
  terminalHandoverRefusal,
} from "./claude-dispatch";
import {
  expiredInteractionRefusal,
  hasPendingRows,
  interactionFor,
  nativeApprovalOffered,
  pendingInteractionRefusal,
  projectQueueActionAck,
  refusedReceiptReason,
  serialQueueTransactionReason,
  stopRefusal,
} from "./session-control-reasons";
import { ControlOutcomeFences } from "./control-outcome-fences";
import {
  ClaudeHostScheduler,
  invalidateHostSchedule,
  type ClaudeScheduledSession,
  type ScheduleInvalidationSource,
} from "./claude-scheduler";
import { attachManagedWebSocket, type ConversationDispatchControl } from "./managed-websocket";
import {
  RemoteRateDiagnostics,
  remoteRateCategory,
  type RemoteRateCategory,
} from "./rate-diagnostics";
import { CLAUDE_LOCAL_OWNER, localClaudeRequest } from "./local-claude";
import { requestProjectAgent } from "./project-agent-request";
import { HttpError } from "./http-error";
import { newPairingCode, tryPairingCode, type PairingCode } from "./pairing-code";
import { continuationPreflightReason } from "./continuation-reason";
import { replayClaudeAttachments, settleClaudeAttachments } from "./claude-attachment-receipts";
import { fileReferencePath, fileReferenceTargets } from "./markdown-links";
import {
  describePendingInteractions,
  resolvePendingInteractionDecision,
} from "./pending-interactions";
import {
  LocalConversationResponse,
  correlatedControlOutcome,
  dispatchProjectAgentControl,
  unavailableLive,
  isControlRequest,
  isProjectAgentAssignmentControl,
  lanPreflightAllowed,
  responseControlOutcome,
  isConversationPath,
  isHistoryReadConversationPath,
  type ConversationRequest,
  type ConversationResponse,
} from "./conversation-transport";
import type { ConversationHub } from "../conversation-hub";
import { RuntimeRequestError } from "../runtime-host";
import {
  closeStreamResponse,
  makeRoomForStream,
  streamFailureReason,
  streamTerminationReason,
  writeStreamHeaders,
  type RegisteredStream,
  type StreamTermination,
} from "./stream-termination";
import { WebRequestTraces } from "./request-trace";
import type { LocalRuntimeTraceEvent } from "@agentkib/backend/local-runtime-trace";
import type { ConversationTaskSummary } from "@agentkib/web-client";
import { projectTaskSummary } from "./task-summary";
import {
  acceptsGzip,
  CatalogChanges,
  projectCatalogReadScope,
  projectRemoteCatalog,
  scopeCatalogPatch,
  snapshotField,
} from "./catalog-stream";
import type { SessionStreamEvent, SessionSubscription } from "../../generated/runtime-protocol";
import {
  DEFAULT_RELAY_BROKER,
  RelayManager,
  validateRegistration,
  type Registration,
  type RelayStatus,
  type RemoteAccountBinding,
  type AccountLoginProof,
  type PushSendInput,
  type PushSendResult,
} from "./relay/manager";
import { pushPublicKey } from "../push/envelope";
import type { PushAlertContext, PushAlertKind, PushTarget } from "../push/notifier";
import { PushApprovalActions } from "../push/actions";
import { projectNotificationActivity, type NotificationActivitySession } from "../push/activity";
import { notificationPolicyVersion, type NotificationPolicyStore } from "../push/policy";

export const HOSTED_ORIGIN = "https://remote.agentkib.com";
/** Native modes, including the read-only observations. */
const CLAUDE_OBSERVED_PERMISSION_MODES = new Set<string>([
  ...CLAUDE_PERMISSION_MODES,
  "dontAsk",
  "bypassPermissions",
]);
/**
 * The form each executor takes attachments in, by execution mode. Whether a session takes them
 * now is its `attachments` capability; a mode missing here takes none.
 */
const ATTACHMENT_FORMATS: Readonly<Record<string, AttachmentFormat>> = {
  "codex-managed": "codex",
  "codex-follower": "codex",
  "claude-managed": "claude",
  "claude-follower": "claude-terminal",
  "dsh-follower": "dsh",
  "devin-print": "acp",
  "acp-managed": "acp",
};
type AttachmentAvailability = {
  available: boolean;
  reason?: string;
  attachmentKinds?: SessionAttachmentKinds;
};

function attachmentInputFormat(
  format: AttachmentFormat | undefined,
  feature: AttachmentAvailability | undefined,
): AttachmentFormat | undefined {
  return format === "dsh" && feature?.attachmentKinds?.image === false ? "link" : format;
}

/** Freeze browser-visible inputs so durable replay never needs to reopen resources. */
function managedActionInputHash(operation: string, body: Record<string, unknown>): string {
  const fields = [
    "sessionId",
    "expectedRevision",
    "text",
    "attachmentIds",
    "resourceIds",
    "historyReferences",
    "turnId",
    "queuedSubmissionId",
    "queuedSubmissionIds",
    "name",
    "model",
    "effort",
    "permissionMode",
    "agentPreset",
    "mode",
    "serviceTierId",
    "policyId",
    "restoreDefaults",
    "objective",
    "intent",
    "tokenBudget",
    "handoffConfirmed",
  ];
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          operation,
          ...Object.fromEntries(
            fields.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]),
          ),
        }),
      ),
    )
    .digest("hex");
}

export function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || Number(p) > 255))
    return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
export function lanAddresses(): Array<{ name: string; address: string }> {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && isPrivateIPv4(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  );
}
/**
 * Request IDs this host dispatched. They stop a retry from being dispatched again before its
 * receipt is settled; the receipt ledger is what lasts, and this set starts empty after every
 * restart. The oldest IDs therefore make way for new ones instead of refusing new requests,
 * which used to stop all sending and approvals after the ten-thousandth control.
 */
const REMEMBERED_REQUESTS = 10_000;
/** Context picker entries that keep an ID; the least recently listed ones go first. */
const CONTEXT_ARTIFACT_LIMIT = 20_000;
export function rememberRequest(requests: Set<string>, requestId: string): void {
  requests.delete(requestId);
  requests.add(requestId);
  while (requests.size > REMEMBERED_REQUESTS) {
    const oldest = requests.values().next();
    if (oldest.done) break;
    requests.delete(oldest.value);
  }
}
export function createWebControlState() {
  return {
    admission: false,
    active: new Set<string>(),
    outcomeFences: new ControlOutcomeFences(),
    requests: new Set<string>(),
    events: new EventEmitter().setMaxListeners(64),
    claudeScheduler: undefined as ClaudeHostScheduler | undefined,
  };
}

export interface WebConfig {
  enabled: boolean;
  port: number;
  externalOrigin: string;
  experimentalEnabled: boolean;
  lanAddress?: string;
  allowPlaintext?: boolean;
  allowedWorkspaceIds?: string[];
  extraRoots?: { id: string; name: string; path: string }[];
  previewBytesPerSecond?: number;
  relay?: { enabled: boolean; brokerUrl: string; frpcPath?: string };
}
export interface WebDevice {
  /** Code-authorized browsers follow the registered workspace catalog dynamically. */
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
  createdAt: number;
}
export interface WebPending {
  id: string;
  name: string;
  verification: string;
  expiresAt: number;
}
export interface WebAdminStatus {
  pairingMode?: "code" | "confirmation";
  config: WebConfig;
  running: boolean;
  error?: string;
  localUrl: string;
  experimentalAvailable: boolean;
  acceptanceSessionId?: string;
  code?: { value: string; expiresAt: number; access: WebAccessLevel };
  pending: WebPending[];
  devices: WebAdminDevice[];
  mode?: "lan" | "local";
  addresses?: Array<{ name: string; address: string }>;
  connectionUrl?: string;
  workspaces?: { id: string; name: string; path: string }[];
  relay?: RelayStatus;
}
/** 授权码配对的权限档位；LAN 确认配对仍按单项权限逐个授予。 */
export type WebAccessLevel = "read" | "full";
/**
 * `accountBound`: the pairing ends when the phone's account login ends (and renews meanwhile).
 * `online`: the device follows a stream from this computer now, or made a request in the last
 * minute. Kept in memory only.
 */
export type WebAdminDevice = WebDevice & {
  accessLevel?: WebAccessLevel;
  accountBound?: boolean;
  online?: boolean;
};
export type WebAdminRequest = { target?: "lan" } & (
  | { operation: "status" }
  | { operation: "generate-code"; access?: WebAccessLevel }
  | { operation: "set-access"; id: string; access: WebAccessLevel }
  | {
      operation: "configure";
      enabled: boolean;
      port: number;
      externalOrigin: string;
      experimentalEnabled: boolean;
      lanAddress?: string;
      allowPlaintext?: boolean;
      allowedWorkspaceIds?: string[];
      extraRoots?: { id: string; name: string; path: string }[];
      previewBytesPerSecond?: number;
      relay?: WebConfig["relay"];
    }
  | {
      operation: "relay-start" | "remote-enable";
      brokerUrl: string;
      frpcPath?: string;
      inviteCode?: string;
      reenroll?: boolean;
    }
  | { operation: "relay-stop" }
  | {
      operation: "approve";
      id: string;
      send: boolean;
      approve: boolean;
      manage?: boolean;
      files?: boolean;
      attachments?: boolean;
      advancedControl?: boolean;
      organize?: boolean;
      settings?: boolean;
      extendedApproval?: boolean;
    }
  | { operation: "reject" | "revoke"; id: string }
);
const PUSH_REF = /^[A-Za-z0-9_-]{8,64}$/;
const validPushSubscription = (value: unknown): value is PushSubscription => {
  const push = value as PushSubscription;
  return (
    !!push &&
    !!pushPublicKey(push.publicKey) &&
    typeof push.ref === "string" &&
    PUSH_REF.test(push.ref) &&
    typeof push.alerts === "boolean" &&
    typeof push.liveActivity === "boolean" &&
    (push.approvalActions === undefined || push.approvalActions === 1) &&
    (push.activityDetails === undefined || push.activityDetails === 1) &&
    Number.isSafeInteger(push.updatedAt) &&
    push.updatedAt > 0
  );
};
export type AccountSessions = { accountId: string; sessions: { id: string; kind: string }[] };
/** How often bound pairings are checked against the account's live logins. */
const ACCOUNT_CHECK_MS = 5 * 60_000;
/** Bound pairings are renewed to the full lifetime at most this often. */
const RENEW_AFTER_MS = 24 * 60 * 60_000;
type Browser = {
  csrf: string;
  expiresAt: number;
  pending?: WebPending;
  ended?: boolean;
  accountChallenge?: string;
  account?: AccountBinding;
};
type Availability = { available: boolean; reason?: string };
type ContextResourceReference = {
  kind: "file" | "directory" | "skill" | "plugin" | "app";
  id?: string;
  relativePath?: string;
};
type ContextResourceScope = { deviceId: string; sessionId: string; workspaceId: string };
type RememberedContextResource = ContextResourceScope &
  (
    | { draftAgent?: ManagedAgent; artifactId: string; revision: string }
    | { draftAgent: ManagedAgent; reference: ContextResourceReference }
  );
type ActionOutcome = ConversationDispatchControl & {
  rateDiagnostic?: { deviceId?: string; category: RemoteRateCategory; at: number };
};
function requireConversationProtocol(req: ConversationRequest) {
  if (req.headers[REMOTE_HEADERS.protocol.toLowerCase()] !== String(CONVERSATION_PROTOCOL_VERSION))
    throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.incompatibleProtocol);
}

type PairedRateClass = "api" | "stream" | "probe" | "other";
type RequestRateWindow = {
  count: number;
  until: number;
  paired?: Record<Exclude<PairedRateClass, "other">, number>;
};
const REQUEST_RATE_WINDOW_MS = 60_000;
const MAX_REQUEST_RATE_KEYS = 4096;
const PAIRED_REQUEST_LIMIT = 600;
const PAIRED_STREAM_LIMIT = 30;
const PAIRED_PROBE_LIMIT = 30;
const API_REQUEST_LIMIT = 180;
const PAIRED_REST_LIMIT = PAIRED_REQUEST_LIMIT - PAIRED_STREAM_LIMIT - PAIRED_PROBE_LIMIT;

function pairedRateClass(
  method: string | undefined,
  pathname: string,
  lan: boolean,
): PairedRateClass {
  if (!pathname.startsWith(`${REMOTE_ROUTE_BASE}/`) || (lan && method === "OPTIONS"))
    return "other";
  if (method === "GET") {
    if (pathname === `${REMOTE_ROUTE_BASE}${REMOTE_ROUTE.stream}`) return "stream";
    if (
      pathname === `${REMOTE_ROUTE_BASE}${REMOTE_ROUTE.info}` ||
      pathname === `${REMOTE_ROUTE_BASE}${REMOTE_ROUTE.access}`
    )
      return "probe";
  }
  return "api";
}

function requestRateError(until: number, now: number): HttpError {
  return new HttpError(
    REMOTE_ERROR_CONTRACT.rateLimited.http.status,
    REMOTE_ERROR_CODES.rateLimited,
    Math.max(1, Math.ceil((until - now) / 1000)),
  );
}
type ActionAdmission = {
  hash: string;
  operation: string;
  body: Record<string, unknown>;
  control: ActionOutcome;
  permission: ReturnType<WebAccessService["codexPermission"]>;
  device: WebDevice;
  sessionId: string;
  requestId: string;
  workspaceId: string;
  legacyCodex: boolean;
  opensPicker: boolean;
  settingsControl: boolean;
  prior: Record<string, unknown> | undefined;
  publicInputHash: string | undefined;
};
type QueueEntry = {
  id: string;
  status?: string;
  reason?: string;
  input?: { type: string; text?: string }[];
  ownerWait?: boolean;
  ownerWaitDeviceId?: string;
  ownerWaitWorkspaceId?: string;
  actions?: SessionQueueItemActions;
  hasAttachments?: boolean;
  queueSteerDeviceId?: string;
};

function queueEntryHasAttachments(item: QueueEntry): boolean {
  return (
    item.hasAttachments === true ||
    (item.input ?? []).some(
      (input) =>
        input.type !== "text" ||
        input.text?.split("\n").some((line) => line.startsWith("User attached file ")),
    )
  );
}

function isOwnerWaitQueueEntry(item: QueueEntry, workspaceId: string) {
  return (
    item?.ownerWait === true &&
    typeof item.id === "string" &&
    typeof item.ownerWaitDeviceId === "string" &&
    item.ownerWaitWorkspaceId === workspaceId &&
    ((item.status === "pending" &&
      (item.reason === "codex-waiting-for-owner" || item.reason === "codex-owner-wait-paused")) ||
      (item.status === "unknown" && item.reason === REMOTE_ERROR_CODES.controlOutcomeUnconfirmed))
  );
}

function canDeleteOwnerWait(item: QueueEntry, deviceId: string) {
  return (
    item.actions?.delete?.available === true &&
    (item.ownerWaitDeviceId === deviceId ||
      (deviceId === "desktop-local" && item.status === "unknown"))
  );
}

type ActionDispatch = {
  dispatched: boolean;
  executionMode?: string;
  terminalAttachments?: true;
  newlyPinnedDevice?: string;
  historyScopeKey?: string;
};
const token = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
/** Devin CLI's permission modes, which apply to a whole `devin -p` turn. */
const DEVIN_PERMISSION_MODES = ["auto", "accept-edits", "smart", "dangerous"];
/** Antigravity's own session modes (`agy acp`); `auto` also runs commands it judges safe. */
const ANTIGRAVITY_PERMISSION_MODES = ["default", "accept-edits", "auto", "plan"];

/** A paired device counts as online this long after its last request, or while it holds a stream. */
const ONLINE_WINDOW_MS = 60_000;
type DevicePermissions = Required<Pick<WebDevice, keyof typeof REMOTE_CAPABILITIES.device>>;
// 只读仍保留 accessMode: "full" 的工作区范围（跟随已登记工作区），
// 但所有写操作权限关闭；服务端每次请求都按这些标志重新授权。
const CODE_ACCESS_PERMISSIONS: Record<WebAccessLevel, DevicePermissions> = {
  read: {
    send: false,
    approve: false,
    manage: false,
    files: true,
    attachments: false,
    advancedControl: false,
    organize: false,
    settings: false,
    extendedApproval: false,
  },
  full: {
    send: true,
    approve: true,
    manage: true,
    files: true,
    attachments: true,
    advancedControl: true,
    organize: true,
    settings: true,
    extendedApproval: true,
  },
};
const CODEX_READ_ALIASES = new Map(Object.entries(REMOTE_LEGACY_CODEX.getAliases));

/**
 * relay broker 只能是 HTTPS origin（可带结尾的 "/"），返回规范化后的 origin。
 * 类型不对或无法解析时抛 invalid_relay_configuration，而不是把 URL 的 TypeError 原样抛给设置页。
 */
function relayBrokerOrigin(value: unknown): string {
  let url: URL | undefined;
  try {
    if (typeof value === "string") url = new URL(value.trim());
  } catch {
    url = undefined;
  }
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("invalid_relay_configuration");
  return url.origin;
}
const isCodexMode = (mode: unknown) => mode === "codex-managed" || mode === "codex-follower";
/**
 * Besides Codex, these execution modes scope controls to the workspace the provider reports.
 */
const WORKSPACE_SCOPED_MODES: readonly string[] = [
  "claude-managed",
  "claude-follower",
  "acp-managed",
  "devin-print",
  "dsh-follower",
];
/** 小于这个大小的回复不压缩，省下的字节抵不过压缩本身。 */
const COMPRESSED_REPLY_MIN_BYTES = 16 * 1024;
const TASK_CATALOG_MAX_BYTES = 32 * 1024 * 1024;
const isAccessLevel = (value: unknown): value is WebAccessLevel =>
  value === "read" || value === "full";
function accessLevelOf(device: WebDevice): WebAccessLevel | undefined {
  if (device.accessMode !== "full") return undefined;
  return (Object.keys(CODE_ACCESS_PERMISSIONS) as WebAccessLevel[]).find((level) =>
    Object.entries(CODE_ACCESS_PERMISSIONS[level]).every(
      ([permission, allowed]) =>
        (device[permission as keyof DevicePermissions] === true) === allowed,
    ),
  );
}
const DEFAULT: WebConfig = {
  enabled: false,
  port: 1421,
  externalOrigin: "",
  experimentalEnabled: false,
};

type SessionTarget = "codex" | "claude-code";
export type HostSessionRequest = {
  host: {
    target?: SessionTarget;
    request: Record<string, unknown>;
    terminalDisplay?: true;
    restrictCodexNativePolicy?: true;
    approvalAudit?: SessionApprovalAuditContext;
  };
};
type SessionDispatch = (params: unknown) => Promise<unknown>;

/** Local-only transport. Authentication is independent of native certificate pairing. */
export class WebAccessService {
  private readonly localDevice: WebDevice = {
    id: "desktop-local",
    name: "Desktop",
    accessMode: "full",
    createdAt: 0,
    send: true,
    approve: true,
    manage: true,
    files: true,
    attachments: true,
    advancedControl: true,
    organize: true,
    settings: true,
    extendedApproval: true,
  };
  private previewStarting?: Promise<void>;
  private desktopPreviewStarting?: Promise<void>;
  private config = { ...DEFAULT };
  private server?: Server;
  private error?: string;
  private code?: PairingCode;
  private credentials: Credential[] = [];
  private browsers = new Map<string, Browser>();
  // 按建立顺序登记；evict 走该流自己的 unavailable 清理路径。
  private streams = new Map<ConversationResponse, RegisteredStream>();
  /** When each paired credential last made an API request, for the device's online state. */
  private seen = new Map<string, number>();
  private active = new Set<string>();
  // Some controls still reserve the shared worker across preflight and dispatch.
  // Settings use only the session reservation in active.
  private controlAdmission = false;
  // Survives runtime replacement and HTTP listener restarts within this host.
  // An underlying promise settling is not proof that the HTTP reply succeeded.
  private outcomeFences = new ControlOutcomeFences();
  private requests = new Set<string>();
  private controlEvents = new EventEmitter().setMaxListeners(64);
  private pushEvents = new EventEmitter();
  private pushSubscriptionAt = 0;
  private readonly pushApprovalActions = new PushApprovalActions();
  // 正在进行的目录读取（按 runtime 启动区分）；同时到达的权限检查共用它。
  private catalogFlight?: { boot: string; readerScope: string; read: Promise<unknown> };
  private pendingControlNotifications = new Set<string>();
  private rates = new Map<string, RequestRateWindow>();
  private readonly rateDiagnostics = new RemoteRateDiagnostics();
  private adminQueue: Promise<unknown> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();
  private revocationPending = false;
  private expiringDeviceIds = new Set<string>();
  private bootId = token();
  private addressTimer?: ReturnType<typeof setInterval>;
  private accountTimer?: ReturnType<typeof setInterval>;
  private lanAddressMisses = 0;
  private artifacts?: ArtifactService;
  private desktopArtifacts?: ArtifactService;
  private attachmentStore: AttachmentStore;
  private previewOrigin = "";
  private previewServer?: Server;
  private desktopPreviewServer?: Server;
  /** Remote browsers' web preview, on the same isolated origin as artifact previews. */
  private livePreview?: LivePreviewService;
  private relay?: RelayManager;
  private relayAccountPaused = false;
  private relayAccountChange = 0;
  private relayOwnerAccountId?: string;
  private relayEpoch = 0;
  private disposed = false;
  private remotePairingInitialized = false;
  private scheduler?: ClaudeHostScheduler;
  private sharedRuntimePrimary?: boolean;
  private unregisterScheduler?: () => void;
  private managedSocket?: { close(): void };
  private contextArtifactRefs = new Map<string, RememberedContextResource>();
  private readonly codexSessionRequest?: SessionDispatch;
  private readonly claudeSessionRequest?: SessionDispatch;
  private readonly requestTraces: WebRequestTraces;
  constructor(
    private readonly options: {
      conversationHub?: ConversationHub;
      desktopOrigin?: string;
      dataDir: string;
      staticDir: string;
      traceRequest?: (event: LocalRuntimeTraceEvent) => void;
      sessionRequest?: (input: HostSessionRequest) => Promise<unknown>;
      historyRequest?: (method: string, params: unknown) => Promise<unknown>;
      /** In-process request fakes can supply only the session targets they implement. */
      runtimeRequest?: SessionDispatch;
      managedRequest?: SessionDispatch;
      claudeManagedRequest?: SessionDispatch;
      sessionProviderRequest?: SessionDispatch;
      receiptRequest?: (params: { requestId: string; deviceId: string }) => Promise<unknown>;
      createRelayCsr?: (params: {
        privateKeyDer: string;
        hosts: string[];
      }) => Promise<{ csrPem: string }>;
      bundledFrpcPath?: string;
      account?: {
        signedIn(): boolean;
        accountId(): string | undefined;
        ensureDeviceOwner(accountId?: string): Promise<void>;
        registerDevice(input: {
          registrationId: string;
          credential: string;
        }): Promise<Record<string, unknown>>;
      };
      /**
       * The live logins of the account this computer is signed in to; throws when signed out.
       * Phones paired during one of those logins lose their pairing when it ends.
       */
      accountSessions?: () => Promise<AccountSessions>;
      /**
       * The computer's name as its system settings show it. Approved devices get it with their
       * access, so a phone names the computer without an account.
       */
      computerName?: () => Promise<string | undefined>;
      workspaceRequest?: () => Promise<{ id: string; name: string; path: string }[]>;
      supportsCatalogScope?: boolean;
      notificationPolicy?: NotificationPolicyStore;
      approvalRules?: typeof nativeApprovalRules;
      verifiedCodex?: boolean;
      verifiedExperimental?: boolean;
      verifiedClaudeManaged?: boolean;
      enableClaudeScheduler?: boolean;
      enableSerialSessionScheduler?: boolean;
      verifiedAntigravityManaged?: boolean;
      disabledSessionProviders?: Partial<Record<ManagedAgent, string>>;
      /** DeepSeek Harness sessions connected through the AgentKib plugin (macOS only for now). */
      verifiedDshFollower?: boolean;
      /** Devin sessions run by AgentKib, one `devin -p` turn at a time. */
      verifiedDevinManaged?: boolean;
      acceptanceSessionId?: string;
      mode?: "lan";
      sharedControl?: ReturnType<typeof createWebControlState>;
      addresses?: typeof lanAddresses;
      onPairingRequested?: () => void;
    },
  ) {
    this.requestTraces = new WebRequestTraces(options.traceRequest);
    if (options.sessionRequest || options.managedRequest)
      this.codexSessionRequest = (params) => this.requestSession(params, "codex");
    if (options.sessionRequest || options.claudeManagedRequest)
      this.claudeSessionRequest = (params) => this.requestSession(params, "claude-code");
    this.attachmentStore = new AttachmentStore(join(options.dataDir, "attachments"));
    if (options.sharedControl) {
      this.active = options.sharedControl.active;
      this.outcomeFences = options.sharedControl.outcomeFences;
      this.requests = options.sharedControl.requests;
      this.controlEvents = options.sharedControl.events;
    }
    if (options.mode === "lan") {
      if (options.acceptanceSessionId) throw new Error("acceptance_is_local_only");
      this.config = {
        ...DEFAULT,
        port: 1422,
        externalOrigin: HOSTED_ORIGIN,
        lanAddress: "",
        allowPlaintext: false,
      };
    }
    if (
      options.acceptanceSessionId !== undefined &&
      !/^[a-f0-9]{64}$/.test(options.acceptanceSessionId)
    )
      throw new Error("invalid_acceptance_session");
    if (
      (options.enableClaudeScheduler || options.enableSerialSessionScheduler) &&
      this.claudeSessionRequest
    ) {
      this.scheduler =
        options.sharedControl?.claudeScheduler ??
        new ClaudeHostScheduler(this.claudeSessionRequest, !options.enableClaudeScheduler);
      if (options.sharedControl) options.sharedControl.claudeScheduler = this.scheduler;
    }
  }
  private readonly requestSession = (
    params: unknown,
    target?: SessionTarget,
    restrictCodexNativePolicy = false,
    approvalAudit?: SessionApprovalAuditContext,
  ): Promise<unknown> => {
    const { terminalDisplay, ...request } = params as Record<string, unknown>;
    if (this.options.sessionRequest)
      return requestSessionWithTerminalDisplay(this.options.sessionRequest, terminalDisplay, {
        host: {
          request,
          ...(target ? { target } : {}),
          ...(restrictCodexNativePolicy ? { restrictCodexNativePolicy: true } : {}),
          ...(approvalAudit ? { approvalAudit } : {}),
        },
      });
    const dispatch =
      target === "codex"
        ? this.options.managedRequest
        : target === "claude-code"
          ? this.options.claudeManagedRequest
          : request.operation === "provider-options" || request.operation === "provider-create"
            ? (this.options.sessionProviderRequest ?? this.options.runtimeRequest)
            : this.options.runtimeRequest;
    return dispatch?.(request) ?? Promise.reject(new Error(REMOTE_ERROR_CODES.runtimeUnavailable));
  };
  private get admission() {
    return this.options.sharedControl?.admission ?? this.controlAdmission;
  }
  private set admission(value: boolean) {
    if (this.options.sharedControl) this.options.sharedControl.admission = value;
    else this.controlAdmission = value;
  }
  private get binding() {
    return `${HOSTED_ORIGIN}|http://${this.config.lanAddress}:${this.config.port}`;
  }
  private get addresses() {
    return (this.options.addresses ?? lanAddresses)();
  }

  /** Each desktop still owns its browser grants. Only one may schedule local desktop work. */
  setSharedRuntimePrimary(primary: boolean): void {
    this.sharedRuntimePrimary = primary;
    this.scheduler?.setSharedRuntimePrimary(primary);
  }

  async localClaude(input: unknown): Promise<unknown> {
    if (!this.claudeSessionRequest || !this.options.receiptRequest)
      throw new Error("runtime_unavailable");
    if (
      input &&
      typeof input === "object" &&
      "operation" in input &&
      ["files", "file-text", "file-preview"].includes(String(input.operation))
    ) {
      const body = input as Record<string, unknown>;
      const sessionId = this.field(body.sessionId);
      const scope = await this.localArtifactScope(sessionId);
      await this.startDesktopPreview();
      const artifacts = this.desktopArtifacts;
      if (!artifacts) throw new Error(REMOTE_ERROR_CODES.previewUnavailable);
      if (body.operation === "files")
        return artifacts.list(
          scope,
          body.directoryId === undefined ? undefined : this.field(body.directoryId),
        );
      if (body.operation === "file-text")
        return artifacts.readText(scope, this.field(body.artifactId), this.field(body.revision));
      return artifacts.issueTicket(scope, {
        artifactId: this.field(body.artifactId),
        expectedRevision: this.field(body.revision),
        download: body.download === true,
      });
    }
    const body = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const operation = String(body.operation);
    const mutation = [
      "create",
      "release",
      "reconcile",
      "send",
      "stop",
      "approve",
      "answer",
    ].includes(operation);
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
    if (operation === "send" && requestId) {
      const control = { priorUncertain: false };
      try {
        const prior = await this.controlReceipt(requestId, CLAUDE_LOCAL_OWNER, control);
        if (
          prior?.found === true &&
          (body.historyReferences !== undefined || prior.historyInputHash)
        ) {
          await this.codexScope(this.field(body.sessionId), "desktop-local", true, false);
          const replay = this.historyReplay(prior, body, operation, control);
          if (replay !== undefined) return replay;
        }
      } catch (error) {
        return {
          accepted: false,
          completed: false,
          requestId,
          controlOutcome: control.priorUncertain
            ? REMOTE_CONTROL_OUTCOMES.unknown
            : REMOTE_CONTROL_OUTCOMES.notDispatched,
          error: error instanceof Error ? error.message : REMOTE_ERROR_CODES.invalidRequest,
        };
      }
    }
    if (
      mutation &&
      (this.admission ||
        (sessionId && this.active.has(sessionId)) ||
        (sessionId && this.outcomeFences.blocks(sessionId, operation, requestId)))
    ) {
      // A rejected duplicate may already have run through either local surface.
      // Only its authoritative receipt can establish that it was never dispatched.
      const control = { priorUncertain: true };
      if (requestId) {
        control.priorUncertain = this.requests.has(requestId);
        try {
          await this.controlReceipt(requestId, CLAUDE_LOCAL_OWNER, control);
        } catch {
          control.priorUncertain = true;
        }
      }
      return {
        accepted: false,
        completed: false,
        requestId,
        controlOutcome: control.priorUncertain
          ? REMOTE_CONTROL_OUTCOMES.unknown
          : REMOTE_CONTROL_OUTCOMES.notDispatched,
        error: this.admission
          ? REMOTE_ERROR_CODES.operationBusy
          : REMOTE_ERROR_CODES.outcomeUnknown,
      };
    }
    if (mutation) {
      this.admission = true;
      if (sessionId) this.active.add(sessionId);
    }
    let dispatched = false;
    let approvalAudit: SessionApprovalAuditContext | undefined =
      this.options.sessionRequest && (operation === "approve" || operation === "answer")
        ? { source: { kind: "desktop", deviceId: CLAUDE_LOCAL_OWNER } }
        : undefined;
    const invoke = (target: SessionTarget | undefined, params: unknown) => {
      const value = params as Record<string, unknown>;
      const dispatching = mutation && value.operation === operation;
      if (dispatching) {
        dispatched = true;
        if (requestId) rememberRequest(this.requests, requestId);
        if (sessionId && requestId && operation !== "reconcile") {
          this.outcomeFences.record({
            sessionId,
            requestId,
            operation,
            deviceId: CLAUDE_LOCAL_OWNER,
          });
        }
      } else if (!mutation && this.admission)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
      return this.requestSession(params, target, false, dispatching ? approvalAudit : undefined);
    };
    try {
      const result = await localClaudeRequest(
        {
          managed: (params) => invoke("claude-code", params),
          runtime: (params) => invoke(undefined, params),
          approvalEvidence: async (snapshot, params) => {
            if (approvalAudit)
              approvalAudit = {
                ...approvalAudit,
                ...(await this.readApprovalEvidence(snapshot, params)),
              };
          },
          expiredApproval: (snapshot, params) => {
            if (approvalAudit) void this.recordExpiredApproval(approvalAudit, snapshot, params);
          },
          receipt: this.options.receiptRequest,
          attachments: this.attachmentStore,
          history: async (body) => {
            const history = await this.resolveHistoryInput(body, "desktop-local", "send", true);
            return {
              ...history,
              validate: () => this.assertHistoryScope("desktop-local", history.scopeKey, true),
            };
          },
        },
        input,
      );
      if (result && typeof result === "object") {
        const value = result as Record<string, unknown>;
        if (
          !dispatched &&
          mutation &&
          value.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched &&
          sessionId &&
          !!requestId &&
          this.outcomeFences.get(requestId)?.sessionId === sessionId
        )
          return { ...value, controlOutcome: REMOTE_CONTROL_OUTCOMES.unknown };
        const settledSession =
          sessionId ?? (typeof value.sessionId === "string" ? value.sessionId : undefined);
        const acknowledged =
          value.requestId === requestId &&
          (value.accepted === true ||
            value.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched ||
            (operation === "receipt" &&
              value.found === true &&
              ["accepted", REMOTE_CONTROL_OUTCOMES.notDispatched].includes(String(value.status))));
        if (operation === "reconcile" && settledSession && value.reconciled === true) {
          this.settleSessionOutcomes(settledSession);
        } else if (
          settledSession &&
          acknowledged &&
          requestId &&
          (mutation || !this.active.has(settledSession))
        ) {
          this.settleOutcome(settledSession, requestId);
        }
        if (operation === "live" && sessionId)
          return { ...value, ...this.scopedOutcomeFlags(sessionId) };
      }
      return result;
    } finally {
      if (mutation) {
        if (sessionId) this.active.delete(sessionId);
        this.admission = false;
        this.notifyControlChanged(sessionId ?? "");
      }
    }
  }
  private async localArtifactScope(sessionId: string) {
    const session = await this.catalogSession(sessionId);
    if (
      session?.agent !== "claude-code" ||
      !(await this.registeredWorkspaces()).some((row) => row.id === session.workspace_id)
    )
      throw new Error(REMOTE_ERROR_CODES.workspaceNotAuthorized);
    return { deviceId: CLAUDE_LOCAL_OWNER, sessionId, workspaceId: session.workspace_id };
  }
  private isFullAccess(device?: WebDevice) {
    return this.options.mode !== "lan" && device?.accessMode === "full";
  }
  /**
   * A message naming one of DeepSeek Harness's slash commands runs as that command, decided in
   * DSH with the session's own registry. Those that change the session's permission preset or
   * goal, or that other DSH plugins add, need what AgentKib's own settings and goal controls
   * need: a device with full access. DSH applies this answer (`dsh-bridge-plugin/commands.js`).
   */
  private dshCommandAccess(device: WebDevice): "all" | "session" {
    return this.isFullAccess(device) ? "all" : "session";
  }
  private fullAccess(hash: string, permission?: "advancedControl" | "settings") {
    const device = this.grant(hash, permission);
    if (!this.isFullAccess(device))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.permissionDenied);
    return device;
  }
  private workspaceAllowed(
    workspaceId: string,
    device?: WebDevice,
    reserved = false,
  ): boolean | Promise<boolean> {
    if (!this.isFullAccess(device))
      return this.config.allowedWorkspaceIds?.includes(workspaceId) === true;
    return this.registeredWorkspaces(reserved).then((workspaces) =>
      workspaces.some((workspace) => workspace.id === workspaceId),
    );
  }
  private controlsEnabled(sessionId?: string, device?: WebDevice) {
    const scope = this.options.acceptanceSessionId;
    return (
      (this.config.experimentalEnabled || this.isFullAccess(device)) &&
      (scope
        ? !this.config.externalOrigin && (sessionId === undefined || sessionId === scope)
        : this.options.verifiedExperimental === true ||
          this.options.verifiedCodex === true ||
          this.options.verifiedClaudeManaged === true ||
          this.options.verifiedAntigravityManaged === true ||
          this.options.verifiedDshFollower === true)
    );
  }
  private controlWorkspaceAllowed(
    sessionId: string | undefined,
    snapshot: unknown,
    device?: WebDevice,
    reserved = false,
    streamWorkspaceId?: string | null,
  ): boolean | Promise<boolean> {
    const executionMode = snapshotField(snapshot, "executionMode");
    // A session belongs to the workspace its live state names; a device controls it only when
    // allowed that workspace, also when it knows the ID of a session elsewhere.
    const codex = isCodexMode(executionMode);
    if (!codex && !WORKSPACE_SCOPED_MODES.includes(String(executionMode))) return true;
    const workspaceId = snapshotField(snapshot, "workspaceId");
    if (typeof workspaceId !== "string") return false;
    if (this.options.mode === "lan" && codex && sessionId)
      return this.lanCodexScopeAllowed(sessionId, workspaceId, reserved);
    // Full-access streams validated their registered workspace on admission.
    // Registration changes cancel them through ConversationHub.scopesChanged.
    if (streamWorkspaceId !== undefined && this.isFullAccess(device))
      return workspaceId === streamWorkspaceId;
    return this.workspaceAllowed(workspaceId, device, reserved);
  }
  private async controlsEnabledForSnapshot(
    sessionId: string | undefined,
    snapshot: unknown,
    device?: WebDevice,
    reserved = false,
  ) {
    return (
      (await this.controlWorkspaceAllowed(sessionId, snapshot, device, reserved)) &&
      this.controlsEnabledForProvider(sessionId, snapshot, device)
    );
  }
  private controlsEnabledForProvider(
    sessionId: string | undefined,
    snapshot: unknown,
    device?: WebDevice,
  ) {
    const executionMode = snapshotField(snapshot, "executionMode");
    return (
      this.controlsEnabled(sessionId, device) &&
      (!!this.options.acceptanceSessionId ||
        this.options.verifiedExperimental === true ||
        (this.options.verifiedCodex === true && isCodexMode(executionMode)) ||
        (this.options.verifiedClaudeManaged === true &&
          (executionMode === "managed-resume" ||
            executionMode === "claude-managed" ||
            executionMode === "claude-follower")) ||
        (this.options.verifiedAntigravityManaged === true && executionMode === "acp-managed") ||
        (this.options.verifiedDshFollower === true && executionMode === "dsh-follower") ||
        (this.options.verifiedDevinManaged === true && executionMode === "devin-print"))
    );
  }

  async initialize() {
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(
        await readFile(join(this.options.dataDir, "web-access.json"), "utf8"),
      );
      this.config = this.validateConfig(saved.config);
      this.remotePairingInitialized = saved.remotePairingInitialized === true;
      if (!Array.isArray(saved.credentials)) throw new Error("invalid credentials");
      this.credentials = saved.credentials.filter((c: Credential) =>
        isStoredCredential(c, this.options.mode === "lan" ? this.binding : undefined),
      );
      // An unreadable subscription only stops notifications; the phone subscribes again.
      for (const credential of this.credentials)
        if (credential.push !== undefined && !validPushSubscription(credential.push))
          delete credential.push;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.config.enabled = false;
        this.credentials = [];
        this.error = REMOTE_ERROR_CODES.invalidSavedConfiguration;
      }
    }
    this.checkCredentialExpiry();
    if (this.config.enabled) await this.start();
    if (this.options.accountSessions && !this.accountTimer) {
      this.accountTimer = setInterval(
        () => void this.checkAccountBindings().catch(() => undefined),
        ACCOUNT_CHECK_MS,
      );
      this.accountTimer.unref?.();
    }
    if (this.scheduler && !this.unregisterScheduler) {
      this.unregisterScheduler = this.scheduler.register({
        owns: (deviceId, agent) => this.ownsScheduledDevice(deviceId, agent),
        authorize: (session) => this.authorizeScheduledWork(session),
        reserve: (sessionId) => {
          if (
            this.disposed ||
            this.admission ||
            this.active.has(sessionId) ||
            this.outcomeFences.sessions.has(sessionId)
          )
            return false;
          this.admission = true;
          this.active.add(sessionId);
          return true;
        },
        release: (sessionId) => {
          this.active.delete(sessionId);
          this.admission = false;
          this.notifyControlChanged(sessionId);
        },
        settled: async (sessionId) => {
          if (this.options.receiptRequest)
            await settleClaudeAttachments(
              this.attachmentStore,
              this.options.receiptRequest,
              sessionId,
            );
        },
      });
    }
  }

  private ownsScheduledDevice(deviceId: string, agent?: ClaudeScheduledSession["agent"]) {
    if (this.disposed || (this.options.mode === "lan" && agent !== "codex")) return false;
    if ([this.localDevice.id, CLAUDE_LOCAL_OWNER].includes(deviceId))
      return this.sharedRuntimePrimary !== false;
    if (!this.server) return false;
    return (
      !this.expiringDeviceIds.has(deviceId) &&
      this.credentials.some((credential) => credential.device.id === deviceId)
    );
  }

  private async authorizeScheduledWork(session: ClaudeScheduledSession) {
    this.checkCredentialExpiry();
    const work = session.next;
    if (session.agent === "codex") {
      if (!work || !this.options.verifiedCodex || !this.ownsScheduledDevice(work.deviceId, "codex"))
        throw new Error("scheduled-control-unavailable");
      const credential = this.credentials.find((item) => item.device.id === work.deviceId);
      if (!credential) throw new Error("scheduled-device-unavailable");
      this.grant(credential.hash, REMOTE_CAPABILITIES.device.send);
      if (this.options.mode !== "lan")
        this.grant(credential.hash, REMOTE_CAPABILITIES.device.advancedControl);
      if (work.requiresAttachments)
        this.grant(credential.hash, REMOTE_CAPABILITIES.device.attachments);
      if (
        (await this.queueScope(session.sessionId, credential.hash, true, true)) !==
        session.workspaceId
      )
        throw new Error(REMOTE_ERROR_CODES.workspaceNotAuthorized);
      this.checkCredentialExpiry();
      if (!this.ownsScheduledDevice(work.deviceId, "codex"))
        throw new Error("scheduled-control-unavailable");
      const current = this.grant(credential.hash, REMOTE_CAPABILITIES.device.send);
      if (this.options.mode !== "lan")
        this.grant(credential.hash, REMOTE_CAPABILITIES.device.advancedControl);
      if (work.requiresAttachments)
        this.grant(credential.hash, REMOTE_CAPABILITIES.device.attachments);
      if (!this.controlsEnabled(session.sessionId, current))
        throw new Error(REMOTE_ERROR_CODES.controlUnavailable);
      return { restrictNativePolicy: !this.isFullAccess(current) };
    }
    const verified =
      session.agent === "devin"
        ? this.options.verifiedDevinManaged
        : session.agent === "antigravity"
          ? this.options.verifiedAntigravityManaged &&
            !this.options.disabledSessionProviders?.antigravity
          : this.options.verifiedClaudeManaged;
    if (!work || !verified || !this.ownsScheduledDevice(work.deviceId))
      throw new Error("scheduled-control-unavailable");
    const local = [this.localDevice.id, CLAUDE_LOCAL_OWNER].includes(work.deviceId);
    const hash = local
      ? "desktop-local"
      : this.credentials.find((c) => c.device.id === work.deviceId)?.hash;
    if (!hash) throw new Error("scheduled-device-unavailable");
    const device = this.grant(hash, REMOTE_CAPABILITIES.device.send);
    this.grant(hash, REMOTE_CAPABILITIES.device.advancedControl);
    if (work.kind === "goal") this.fullAccess(hash);
    if (work.requiresAttachments) {
      this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
      if (work.originDeviceId && work.originDeviceId !== work.deviceId)
        throw new Error("attachment-owner-changed");
    }
    if (!(await this.workspaceAllowed(session.workspaceId, device, true)))
      throw new Error(REMOTE_ERROR_CODES.workspaceNotAuthorized);
    this.checkCredentialExpiry();
    if (!this.ownsScheduledDevice(work.deviceId)) throw new Error("scheduled-control-unavailable");
    const current = this.grant(hash, REMOTE_CAPABILITIES.device.send);
    this.grant(hash, REMOTE_CAPABILITIES.device.advancedControl);
    if (work.kind === "goal") this.fullAccess(hash);
    if (work.requiresAttachments) this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
    if (!this.controlsEnabled(session.sessionId, current))
      throw new Error(REMOTE_ERROR_CODES.controlUnavailable);
  }

  private invalidateScheduledDevice(deviceId: string, source: ScheduleInvalidationSource) {
    return invalidateHostSchedule(this.scheduler, this.claudeSessionRequest, deviceId, source);
  }

  /** Called only after the Electron sender check; shares all command admission and receipts. */
  async localRequest(path: string, body?: unknown, upload?: Uint8Array, readSignal?: AbortSignal) {
    if (!path.startsWith("/")) path = `/${path}`;
    if (this.options.mode === "lan" || !isConversationPath(path, body !== undefined || !!upload))
      return {
        status: REMOTE_ERROR_CONTRACT.notFound.http.status,
        body: {
          error: REMOTE_ERROR_CODES.notFound,
          controlOutcome: REMOTE_CONTROL_OUTCOMES.notDispatched,
        },
      };
    const control = { request: false, dispatched: false, priorUncertain: false };
    const res = new LocalConversationResponse();
    const method = body === undefined && !upload ? "GET" : "POST";
    const url = path.startsWith(`${REMOTE_ROUTE_BASE}/`) ? path : `${REMOTE_ROUTE_BASE}${path}`;
    const trace = this.requestTraces.observe(method, url, res, control);
    const cancelRead = () => {
      if (trace) trace.cancelled = true;
      res.destroy();
    };
    try {
      if (readSignal && (upload || !isHistoryReadConversationPath(path)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.historyReadRouteRequired);
      if (readSignal?.aborted)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.historyRequestCancelled);
      readSignal?.addEventListener("abort", cancelRead, { once: true });
      if (
        path.includes(REMOTE_ROUTE_PREFIXES.files) ||
        path.includes(REMOTE_ROUTE.artifacts) ||
        path.includes(REMOTE_ROUTE.artifactTickets) ||
        path.includes(REMOTE_ROUTE.diff) ||
        path.includes(REMOTE_ROUTE.codexContextOptions) ||
        path.includes(REMOTE_ROUTE.managedResources)
      )
        await this.startDesktopPreview();
      const bytes = upload ?? Buffer.from(body === undefined ? "" : JSON.stringify(body));
      if (upload && upload.byteLength > 25 * 1024 * 1024)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentTooLarge);
      const req: ConversationRequest = {
        method,
        url,
        headers: {
          host: `127.0.0.1:${this.config.port}`,
          origin: `http://127.0.0.1:${this.config.port}`,
          "content-type": "application/json",
          "x-csrf-token": "desktop-local",
          [REMOTE_HEADERS.protocol.toLowerCase()]: String(CONVERSATION_PROTOCOL_VERSION),
        },
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      };
      await this.handle(req, res, control, true);
      if (readSignal?.aborted)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.historyRequestCancelled);
      return { status: res.statusCode, body: res.body };
    } catch (error) {
      const known =
        error instanceof HttpError ||
        error instanceof ArtifactError ||
        error instanceof AttachmentError;
      const runtimeUnavailable =
        error instanceof Error &&
        error.message === REMOTE_ERROR_CODES.runtimeUnavailable &&
        !isHistoryReadConversationPath(path);
      const response = {
        status: known ? error.status : 500,
        body: {
          error:
            ((known || runtimeUnavailable) && parseRemoteErrorCode(error.message)) ||
            REMOTE_ERROR_CODES.requestFailed,
          ...((error instanceof HttpError || error instanceof AttachmentError) && error.reason
            ? { reason: error.reason }
            : {}),
          ...responseControlOutcome(control),
        },
      };
      this.requestTraces.error(res, error, response.status, response.body);
      return response;
    } finally {
      readSignal?.removeEventListener("abort", cancelRead);
    }
  }

  async localSubscribe(
    sessionId: string,
    afterCursor: string | undefined,
    listener: (event: SessionStreamEvent) => void,
  ): Promise<SessionSubscription> {
    if (sessionId) this.field(sessionId);
    if (!this.options.conversationHub) throw new Error(REMOTE_ERROR_CODES.incompatibleProtocol);
    const result = await this.options.conversationHub.subscribe(sessionId, afterCursor, (event) =>
      listener(this.projectControlEvent(event)),
    );
    return { ...result, events: result.events.map((event) => this.projectControlEvent(event)) };
  }

  canDownloadDesktopArtifact(url: string) {
    return (
      this.desktopArtifacts?.ownsTicketUrl(this.localDevice.id, url) === true ||
      this.desktopArtifacts?.ownsTicketUrl(CLAUDE_LOCAL_OWNER, url) === true
    );
  }

  private artifactsFor(deviceId: string) {
    return deviceId === this.localDevice.id ? this.desktopArtifacts : this.artifacts;
  }

  onControlChanged(listener: (sessionId: string) => void): () => void {
    this.controlEvents.on("changed", listener);
    return () => this.controlEvents.off("changed", listener);
  }

  /**
   * The phones that asked for notifications and can get them now: paired over the relay, bound
   * to an account login of the account this computer is signed in to. One entry per login; the
   * latest subscription wins when a phone paired more than once.
   */
  pushTargets(): PushTarget[] {
    const context = this.cloudLoginContext();
    return context && this.accountLoginRequired()
      ? this.subscribedPushTargets(context.accountId)
      : [];
  }

  /** Subscriptions to retain during automatic recovery, never targets to send to. */
  pushRecoveringTargets(): PushTarget[] {
    if (!this.officialRelayConfigured() || this.cloudLoginContext()) return [];
    return this.subscribedPushTargets();
  }

  private subscribedPushTargets(accountId?: string): PushTarget[] {
    if (this.disposed || !this.server) return [];
    const now = Date.now();
    const targets = new Map<string, PushTarget>();
    for (const credential of this.credentials) {
      const { account, push } = credential;
      if (
        !push ||
        !account?.id ||
        this.credentialExpired(credential, now) ||
        typeof account.expiresAt !== "number" ||
        account.expiresAt <= now ||
        (accountId !== undefined && account.accountId !== accountId)
      )
        continue;
      const session = account.sessionId;
      const earlier = targets.get(session);
      if (!earlier || earlier.updatedAt < push.updatedAt)
        targets.set(session, {
          session,
          publicKey: push.publicKey,
          ref: push.ref,
          alerts: push.alerts,
          liveActivity: push.liveActivity,
          ...(push.approvalActions === 1 ? { approvalActions: 1 } : {}),
          ...(push.activityDetails === 1 ? { activityDetails: 1 } : {}),
          updatedAt: push.updatedAt,
        });
    }
    return [...targets.values()];
  }

  /** This computer's relay device id while it can send notifications. */
  pushDeviceId(): string | undefined {
    return this.options.mode === "lan" ? undefined : this.cloudLoginContext()?.deviceId;
  }

  pushSend(input: PushSendInput): Promise<PushSendResult> {
    if (
      this.options.mode === "lan" ||
      !this.relay ||
      (this.officialRelayConfigured() && !this.cloudLoginContext())
    )
      return Promise.resolve({ delivered: false, error: REMOTE_ERROR_CODES.relayUnavailable });
    return this.relay.pushSend(input);
  }

  private notificationTarget(target: PushTarget): Credential | undefined {
    const matches = (row: { session: string; publicKey: string; updatedAt: number }) =>
      row.session === target.session &&
      row.publicKey === target.publicKey &&
      row.updatedAt === target.updatedAt;
    if (!this.pushTargets().some(matches)) return;
    return this.credentials.find(
      (entry) =>
        entry.account?.sessionId === target.session &&
        entry.push?.publicKey === target.publicKey &&
        entry.push.updatedAt === target.updatedAt &&
        !this.credentialExpired(entry) &&
        this.pushReady(entry),
    );
  }

  private pushActionSubscription(hash: string) {
    const credential = this.credentials.find((entry) => entry.hash === hash);
    const push = credential?.push;
    if (!credential?.account || !push?.alerts || push.approvalActions !== 1) return;
    const target = { ...push, session: credential.account.sessionId };
    if (this.notificationTarget(target) !== credential) return;
    return push;
  }

  /** Authorize the catalog entry before a preview or a signed decision leaves this host. */
  async notificationAlertContext(
    target: PushTarget,
    session: NotificationActivitySession,
    kind: PushAlertKind,
  ): Promise<PushAlertContext | undefined> {
    const credential = this.notificationTarget(target);
    if (!credential?.push?.alerts || !session.workspace_id) return;
    const workspaceId = session.workspace_id;
    const { hash, device } = credential;
    const boot = this.bootId;
    const readerScope = this.readerScope();
    const scopeGeneration = this.options.conversationHub?.scopeGeneration;
    if (!(await this.workspaceAllowed(workspaceId, this.grant(hash), true))) return;
    const isCurrent = () =>
      this.bootId === boot &&
      this.readerScope() === readerScope &&
      this.options.conversationHub?.scopeGeneration === scopeGeneration &&
      this.notificationTarget(target) === credential &&
      this.grant(hash) === device &&
      (this.isFullAccess(device) ||
        this.config.allowedWorkspaceIds?.includes(workspaceId) === true);
    if (!isCurrent()) return;
    const context = { isCurrent };
    if (
      credential.push.approvalActions !== 1 ||
      (kind !== "approval" && kind !== "question") ||
      (session.agent === "claude-code" && session.continuation?.executionLocation === "terminal")
    )
      return context;
    const live = await this.runtime(
      {
        operation: "live",
        sessionId: session.id,
        experimentalEnabled: this.controlsEnabled(session.id, device),
      },
      undefined,
      true,
    ).catch(() => undefined);
    if (!isCurrent()) return;
    if (
      snapshotField(live, "sessionId") !== session.id ||
      snapshotField(live, "workspaceId") !== workspaceId ||
      this.interactionOutcomeBlocked(session.id, kind)
    )
      return context;
    const enabled = await this.controlsEnabledForSnapshot(session.id, live, device, true);
    const matching = (
      await this.pendingInteractionDescriptions(session.id, live, device, enabled, true)
    )?.filter((interaction) => interaction.kind === kind);
    if (!(await this.workspaceAllowed(workspaceId, this.grant(hash), true)) || !isCurrent()) return;
    if (this.interactionOutcomeBlocked(session.id, kind) || matching?.length !== 1) return context;
    return {
      ...this.pushApprovalActions.project(
        matching[0]!,
        device.id,
        boot,
        undefined,
        target.updatedAt,
      ),
      ...context,
    };
  }

  async notificationActivityForTarget(
    target: PushTarget,
    sessions: readonly NotificationActivitySession[],
  ) {
    const credential = this.notificationTarget(target);
    if (!credential?.push?.liveActivity) return;
    const result = await this.notificationActivity(credential.hash, sessions);
    if (this.notificationTarget(target) === credential) return result;
  }

  /** Native preview data follows the receiving phone's read scope. */
  async terminalInteractionPushSummary(
    target: PushTarget,
    sessionId: string,
    kind: "approval" | "question",
  ): Promise<string | undefined> {
    const credential = this.credentials.find(
      (entry) =>
        entry.account?.sessionId === target.session &&
        entry.push?.updatedAt === target.updatedAt &&
        entry.push.publicKey === target.publicKey &&
        entry.push.alerts &&
        this.pushReady(entry),
    );
    if (!credential) return;
    const device = this.grant(credential.hash);
    const scope = this.readerScope();
    const session = await this.sessionScope(sessionId, credential.hash, true, false);
    if (session.agent !== "claude-code") return;
    const live = await this.runtime({ operation: "live", sessionId }, undefined, true);
    if (!(await this.workspaceAllowed(session.workspace_id, device, true))) return;
    if (
      this.grant(credential.hash) !== device ||
      this.readerScope() !== scope ||
      this.notificationTarget(target) !== credential ||
      credential.push?.updatedAt !== target.updatedAt ||
      this.interactionOutcomeBlocked(sessionId, kind) ||
      snapshotField(live, "sessionId") !== sessionId ||
      snapshotField(live, "workspaceId") !== session.workspace_id ||
      snapshotField(live, "executionMode") !== "claude-follower"
    )
      return;
    if (kind === "question" && snapshotField(live, "status") === "waiting-input") {
      const summary = snapshotField(live, "terminalQuestionSummary");
      return typeof summary === "string" ? summary : undefined;
    }
    if (kind !== "approval" || snapshotField(live, "status") !== "awaiting-approval") return;
    const approvals = snapshotField(live, "approvals");
    if (!Array.isArray(approvals) || approvals.length !== 1) return;
    const [approval] = approvals;
    const description = snapshotField(snapshotField(approval, "input"), "description");
    const tool = snapshotField(approval, "toolName");
    return typeof description === "string" && description.trim()
      ? description
      : typeof tool === "string"
        ? tool
        : undefined;
  }

  /** A subscription or its transport availability changed. */
  onPushChanged(listener: () => void): () => void {
    this.pushEvents.on("changed", listener);
    return () => this.pushEvents.off("changed", listener);
  }

  /** Only a phone bound to this computer's account login over the relay can be notified. */
  private pushReady(credential: Credential) {
    return (
      this.options.mode !== "lan" &&
      this.accountLoginRequired() &&
      !!this.cloudLoginContext() &&
      this.validCloudBinding(credential.account)
    );
  }

  /**
   * A phone asks for notifications: alerts encrypted to its key, and a Live Activity while
   * sessions work. They go through the relay to the phone's account login only, and end with
   * the pairing. Subscribing again with the same choices changes nothing.
   */
  private async subscribePush(hash: string, body: Record<string, unknown>) {
    const fields = [
      "publicKey",
      "ref",
      "alerts",
      "liveActivity",
      "approvalActions",
      "activityDetails",
    ];
    if (
      Object.keys(body).some((key) => !fields.includes(key)) ||
      !pushPublicKey(body.publicKey) ||
      typeof body.ref !== "string" ||
      !PUSH_REF.test(body.ref) ||
      typeof body.alerts !== "boolean" ||
      typeof body.liveActivity !== "boolean" ||
      (body.approvalActions !== undefined && body.approvalActions !== 1) ||
      (body.activityDetails !== undefined && body.activityDetails !== 1)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidPushSubscription);
    this.grant(hash);
    this.rate(`push:${hash}`, 12);
    const push: PushSubscription = {
      publicKey: body.publicKey as string,
      ref: body.ref,
      alerts: body.alerts,
      liveActivity: body.liveActivity,
      ...(body.approvalActions === 1 ? { approvalActions: 1 } : {}),
      ...(body.activityDetails === 1 ? { activityDetails: 1 } : {}),
      updatedAt: Date.now(),
    };
    const work = this.adminQueue.then(async () => {
      const credential = this.credentials.find((row) => row.hash === hash);
      if (!credential || this.browsers.get(hash)?.ended)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if (!this.pushReady(credential))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.pushUnavailable);
      const earlier = credential.push;
      if (
        earlier?.publicKey === push.publicKey &&
        earlier.ref === push.ref &&
        earlier.alerts === push.alerts &&
        earlier.liveActivity === push.liveActivity &&
        earlier.approvalActions === push.approvalActions &&
        earlier.activityDetails === push.activityDetails
      )
        return false;
      // An unsubscribe followed by a same-clock resubscribe must not restore old action tokens.
      this.pushSubscriptionAt = Math.max(
        this.pushSubscriptionAt + 1,
        push.updatedAt,
        (earlier?.updatedAt ?? 0) + 1,
      );
      const nextPush = { ...push, updatedAt: this.pushSubscriptionAt };
      const next = this.credentials.map((row) =>
        row === credential ? { ...row, push: nextPush } : row,
      );
      await this.save(this.config, this.remotePairingInitialized, next);
      this.credentials = next;
      return true;
    });
    this.adminQueue = work.catch(() => undefined);
    if (await work) this.pushEvents.emit("changed");
    return { subscribed: true };
  }

  private async unsubscribePush(hash: string, body: Record<string, unknown>) {
    if (Object.keys(body).length)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidPushSubscription);
    this.grant(hash);
    this.rate(`push:${hash}`, 12);
    const work = this.adminQueue.then(async () => {
      const credential = this.credentials.find((row) => row.hash === hash);
      if (!credential?.push) return false;
      this.pushSubscriptionAt = Math.max(this.pushSubscriptionAt, credential.push.updatedAt);
      const next = this.credentials.map((row) =>
        row === credential ? { ...row, push: undefined } : row,
      );
      await this.save(this.config, this.remotePairingInitialized, next);
      this.credentials = next;
      return true;
    });
    this.adminQueue = work.catch(() => undefined);
    if (await work) this.pushEvents.emit("changed");
    return { subscribed: false };
  }

  private notifyControlChanged(sessionId: string) {
    if (this.pendingControlNotifications.has(sessionId)) return;
    this.pendingControlNotifications.add(sessionId);
    // Coalesce promise settlement with response finish. Never mark an active
    // command unknown just because its native state arrived before its reply.
    setImmediate(() => {
      this.pendingControlNotifications.delete(sessionId);
      this.controlEvents.emit("changed", sessionId);
    });
  }

  private settleOutcome(sessionId: string, requestId: string) {
    if (this.outcomeFences.settle(sessionId, requestId)) this.notifyControlChanged(sessionId);
  }

  private settleSessionOutcomes(sessionId: string) {
    for (const entry of this.outcomeFences.forSession(sessionId) ?? [])
      this.settleOutcome(sessionId, entry.requestId);
  }

  private async abandonOutcome(hash: string, body: Record<string, unknown>) {
    const device = this.grant(hash);
    const boot = this.bootId;
    const readerScope = this.readerScope();
    const requestId = this.field(body.requestId, 128);
    const sessionId = this.field(body.sessionId);
    if (
      !/^[a-f0-9-]{36}$/i.test(requestId) ||
      Object.keys(body).some((key) => key !== "requestId" && key !== "sessionId")
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
    await this.sessionScope(sessionId, hash, true, false);
    const sameAuthority = () =>
      this.bootId === boot && this.readerScope() === readerScope && this.grant(hash) === device;
    if (!sameAuthority())
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    const fence = this.outcomeFences.get(requestId);
    if (
      fence &&
      (fence.sessionId !== sessionId ||
        (fence.deviceId !== device.id &&
          !(device.id === this.localDevice.id && fence.deviceId === CLAUDE_LOCAL_OWNER)))
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.requestNotAuthorized);
    if (this.active.has(sessionId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    if (fence && Date.now() - fence.createdAt < SESSION_OUTCOME_GRACE_MS)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.outcomeGracePeriod);
    if (this.options.receiptRequest) {
      const proof = await this.runtime(
        { operation: "receipt" },
        this.options.receiptRequest({
          requestId,
          deviceId: fence?.deviceId ?? device.id,
        }),
        true,
      ).catch(() => undefined);
      if (!sameAuthority())
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
          REMOTE_ERROR_CODES.accessChanged,
        );
      if (this.active.has(sessionId))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
      if (
        snapshotField(proof, "found") === true &&
        snapshotField(proof, "requestId") === requestId &&
        snapshotField(proof, "sessionId") === sessionId &&
        (!fence || snapshotField(proof, "operation") === fence.operation) &&
        ["accepted", REMOTE_CONTROL_OUTCOMES.notDispatched].includes(
          String(snapshotField(proof, "status")),
        )
      ) {
        this.settleOutcome(sessionId, requestId);
        return { abandoned: false };
      }
    }
    // An abandoned command ID remains consumed. Dropping the display fence never
    // converts it into a new command or changes the Provider's native authority.
    rememberRequest(this.requests, requestId);
    this.settleOutcome(sessionId, requestId);
    return { abandoned: true };
  }

  private scopedOutcomeFlags(sessionId: string) {
    return {
      ...(this.outcomeFences.blocks(sessionId, "send") ? { sendEnabled: false } : {}),
      ...(this.outcomeFences.blocks(sessionId, "stop") ? { stopEnabled: false } : {}),
    };
  }

  private interactionOutcomeBlocked(sessionId: string, kind: "approval" | "question") {
    return this.outcomeFences.blocks(sessionId, kind === "approval" ? "approve" : "answer");
  }

  private projectControlEvent(event: SessionStreamEvent): SessionStreamEvent {
    const guard = this.scopedOutcomeFlags(event.sessionId);
    if (!Object.keys(guard).length) return event;
    if (event.type === "state") return { ...event, payload: { ...event.payload, ...guard } };
    if (event.type !== "snapshot") return event;
    const live = event.payload.live;
    return {
      ...event,
      payload: {
        ...event.payload,
        live: { ...(live && typeof live === "object" ? live : {}), ...guard },
      },
    };
  }

  request(input: WebAdminRequest): Promise<WebAdminStatus> {
    return this.queueAdmin(() => this.admin(input));
  }
  private queueAdmin<T>(run: () => Promise<T>): Promise<T> {
    const result = this.adminQueue.then(run);
    this.adminQueue = result.catch(() => undefined);
    return result;
  }
  /** Account recovery suspends the official transport without clearing Web configuration or grants. */
  updateOfficialRelayAccount(available: boolean): Promise<void> {
    const change = ++this.relayAccountChange;
    if (!available || this.officialRelayOwnerChanged()) {
      this.relayAccountPaused = true;
      if (this.officialRelayConfigured()) this.pushEvents.emit("changed");
    }
    const work = this.adminQueue.then(async () => {
      if (this.disposed || !this.officialRelayConfigured()) return;
      if (!available) {
        await this.pauseOfficialRelay();
        return;
      }
      const account = this.options.account;
      const accountId = account?.accountId();
      if (change !== this.relayAccountChange || !account?.signedIn() || !accountId) return;
      if (
        this.relay &&
        this.relay.status.phase !== "disabled" &&
        !this.relayAccountPaused &&
        !this.officialRelayOwnerChanged()
      )
        return;
      if (this.relay) await this.pauseOfficialRelay();
      const identity = await this.accountIdentity();
      if (
        change !== this.relayAccountChange ||
        !account.signedIn() ||
        accountId !== account.accountId()
      )
        return;
      if (
        identity?.accountClaimPending ||
        (identity?.accountId && identity.accountId !== accountId)
      ) {
        this.relayAccountPaused = true;
        return;
      }
      this.relayAccountPaused = false;
      if (this.server?.listening) this.startRelay();
    });
    this.adminQueue = work.catch(() => undefined);
    return work;
  }
  private async pauseOfficialRelay() {
    this.relayAccountPaused = true;
    this.relayEpoch += 1;
    const relay = this.relay;
    this.relay = undefined;
    this.relayOwnerAccountId = undefined;
    await relay?.stop();
  }
  /**
   * 应用退出时调用。排在正在执行的桌面操作之后：否则进行到一半的 remote-enable 会在
   * shutdown 之后重新监听端口、再建一个 RelayManager（连带一个 frpc）。之后的操作一律拒绝。
   */
  dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.accountTimer);
    this.accountTimer = undefined;
    this.unregisterScheduler?.();
    this.unregisterScheduler = undefined;
    const result = this.adminQueue.then(() => this.shutdown("application-quit"));
    this.adminQueue = result.catch(() => undefined);
    return result;
  }
  private async admin(input: WebAdminRequest): Promise<WebAdminStatus> {
    if (this.disposed) throw new Error("web_unavailable");
    if (!input || typeof input !== "object") throw new Error("invalid_admin_request");
    if (["approve", "reject", "revoke", "set-access"].includes(input.operation))
      this.field((input as { id: string }).id);
    if (
      (input.operation === "set-access" && !isAccessLevel(input.access)) ||
      (input.operation === "generate-code" &&
        input.access !== undefined &&
        !isAccessLevel(input.access))
    )
      throw new Error("invalid_admin_request");
    if (
      input.operation === "approve" &&
      (typeof input.send !== "boolean" || typeof input.approve !== "boolean")
    )
      throw new Error("invalid_admin_request");
    this.expire();
    await this.expireCredentials();
    switch (input.operation) {
      case "relay-start":
      case "remote-enable": {
        if (input.operation === "relay-start" && !this.server) throw new Error("web_not_running");
        if (this.options.mode === "lan" || this.options.acceptanceSessionId)
          throw new Error(REMOTE_ERROR_CODES.remoteEnableUnavailable);
        const brokerUrl = relayBrokerOrigin(input.brokerUrl);
        if (brokerUrl === DEFAULT_RELAY_BROKER) {
          const identity = await this.accountIdentity();
          if (identity?.accountClaimPending) throw new Error("account_claim_pending");
          if (!this.options.account?.signedIn())
            throw new Error(REMOTE_ERROR_CODES.accountLoginRequired);
          await this.options.account.ensureDeviceOwner(identity?.accountId);
          if (!this.options.account.signedIn())
            throw new Error(REMOTE_ERROR_CODES.accountLoginRequired);
          this.relayAccountPaused = false;
        } else if (
          input.reenroll &&
          (typeof input.inviteCode !== "string" || !input.inviteCode.trim())
        )
          throw new Error("invitation_required_for_reenrollment");
        const changedBroker = !!this.config.relay && this.config.relay.brokerUrl !== brokerUrl;
        const next = this.validateConfig({
          ...this.config,
          enabled: true,
          externalOrigin: changedBroker ? "" : this.config.externalOrigin,
          relay: {
            enabled: true,
            brokerUrl,
            ...(input.frpcPath ? { frpcPath: input.frpcPath } : {}),
          },
        });
        if (
          !input.reenroll &&
          this.server?.listening &&
          this.config.relay?.enabled &&
          this.config.relay.brokerUrl === next.relay!.brokerUrl &&
          this.config.relay.frpcPath === next.relay!.frpcPath &&
          ["registering", "certifying", "connecting", "ready"].includes(
            this.relay?.status.phase ?? "",
          )
        )
          break;
        // Persist intent before opening a listener or contacting another provider.
        // Browser grants and pending approvals must not cross a provider change.
        const credentials = changedBroker ? [] : this.credentials;
        const initialized = changedBroker ? false : this.remotePairingInitialized;
        try {
          await this.save(next, initialized, credentials);
        } catch (error) {
          this.error = REMOTE_ERROR_CODES.webStateSaveFailed;
          if (input.operation === "relay-start") throw error;
          // A disabled service is not polled continuously; return its failure
          // stage to the one-click caller without publishing the uncommitted config.
          break;
        }
        if (changedBroker) {
          const revoked = this.credentials;
          this.credentials = credentials;
          await Promise.all(
            revoked.map(({ device }) =>
              this.invalidateScheduledDevice(device.id, "relay-provider-changed"),
            ),
          );
        }
        this.relayEpoch += 1;
        await this.relay?.stop();
        this.config = next;
        this.credentials = credentials;
        this.remotePairingInitialized = initialized;
        if (changedBroker) {
          this.browsers.clear();
          this.code = undefined;
          this.endStreams();
          this.artifacts?.clear();
          this.livePreview?.clear();
        }
        this.error = undefined;
        if (!this.server?.listening) await this.start(false);
        if (this.server?.listening) this.startRelay(input.inviteCode, input.reenroll);
        break;
      }
      case "relay-stop":
        await this.save({
          ...this.config,
          ...(this.config.relay ? { relay: { ...this.config.relay, enabled: false } } : {}),
        });
        this.relayEpoch += 1;
        await this.relay?.stop();
        if (this.config.relay) this.config.relay.enabled = false;
        this.config.externalOrigin = "";
        if (this.previewServer) {
          const address = this.previewServer.address();
          if (address && typeof address !== "string") {
            this.previewOrigin = `http://127.0.0.1:${address.port}`;
            this.artifacts?.setOrigins(`http://127.0.0.1:${this.config.port}`, this.previewOrigin);
          }
        }
        await this.save();
        break;
      case "status":
        await this.checkLanAddress();
        break;
      case "configure": {
        const config = this.validateConfig(input);
        await this.shutdown(this.options.mode === "lan" ? "lan-pairing-reset" : undefined);
        if (this.options.mode === "lan") {
          this.browsers.clear();
          this.credentials = [];
        }
        this.config = config;
        this.code = undefined;
        for (const browser of this.browsers.values()) browser.pending = undefined;
        await this.save();
        this.error = undefined;
        if (config.enabled) await this.start();
        break;
      }
      case "generate-code":
        if (!this.server) throw new Error("web_not_running");
        // LAN 配对码只用于发起确认请求，权限在桌面确认时逐项授予，档位不适用。
        this.code = newPairingCode(this.options.mode === "lan" ? "full" : input.access);
        break;
      case "set-access": {
        if (this.options.mode === "lan") throw new Error("invalid_admin_operation");
        const credential = this.credentials.find(
          (c) => c.device.id === input.id && c.device.accessMode === "full",
        );
        if (!credential) throw new Error("device_not_found");
        const previous = credential.device;
        credential.device = { ...previous, ...CODE_ACCESS_PERMISSIONS[input.access] };
        if (input.access === "read" && previous.send)
          await this.invalidateScheduledDevice(input.id, "access-downgraded");
        try {
          await this.save();
        } catch (error) {
          credential.device = previous;
          throw error;
        }
        // 已连接的浏览器还拿着旧的 /access 快照（控件按旧权限显示）。断开它的流让它重连，
        // 重连时会重新同步权限；不发 access-ended，否则客户端会当成被注销。
        this.endStreams(credential.hash, null);
        this.livePreview?.revokeDevice(input.id);
        break;
      }
      case "approve": {
        const entry = [...this.browsers].find(([, b]) => b.pending?.id === input.id);
        if (!entry?.[1].pending) throw new Error("pairing_expired");
        const [hash, browser] = entry;
        const pending = browser.pending!;
        if (this.accountLoginRequired() && !this.validCloudBinding(browser.account))
          throw new Error(REMOTE_ERROR_CODES.accountLoginRequired);
        if (this.credentials.length >= 128) throw new Error(REMOTE_ERROR_CODES.deviceLimit);
        this.credentials.push({
          hash,
          ...(this.options.mode === "lan" ? { binding: this.binding } : {}),
          ...(this.accountLoginRequired() ? { account: { ...browser.account! } } : {}),
          expiresAt: Date.now() + MAX_AGE,
          device: {
            id: pending.id,
            name: pending.name,
            send: input.send === true,
            approve: input.approve === true,
            manage: input.manage === true,
            files: input.files === true,
            attachments: input.attachments === true,
            advancedControl: input.advancedControl === true,
            organize: input.organize === true,
            settings: input.settings === true,
            extendedApproval: input.extendedApproval === true,
            createdAt: Date.now(),
          },
        });
        browser.pending = undefined;
        try {
          await this.save();
        } catch (error) {
          this.credentials = this.credentials.filter((c) => c.hash !== hash);
          throw error;
        }
        break;
      }
      case "reject":
        for (const browser of this.browsers.values())
          if (browser.pending?.id === input.id) {
            browser.pending = undefined;
            browser.ended = true;
          }
        break;
      case "revoke": {
        const revoked = this.credentials.filter((c) => c.device.id === input.id);
        if (!revoked.length) await this.invalidateScheduledDevice(input.id, "device-revoked");
        await this.revokeCredentials(revoked, "device-revoked");
        break;
      }
      default:
        throw new Error("invalid_admin_operation");
    }
    const result = this.status();
    try {
      if (this.options.mode === "lan" || !this.codexSessionRequest) return result;
      result.workspaces = await this.registeredWorkspaces();
    } catch {
      /* Settings remain available when the runtime is offline. */
    }
    return result;
  }
  private validateConfig(input: WebConfig): WebConfig {
    if (
      !input ||
      typeof input.enabled !== "boolean" ||
      typeof input.experimentalEnabled !== "boolean" ||
      !Number.isInteger(input.port) ||
      input.port < 1024 ||
      input.port > 65535 ||
      typeof input.externalOrigin !== "string"
    )
      throw new Error("invalid_configuration");
    if (this.options.mode === "lan") {
      if (input.externalOrigin !== HOSTED_ORIGIN) throw new Error("invalid_external_origin");
      if (
        typeof input.lanAddress !== "string" ||
        (input.lanAddress !== "" && !isPrivateIPv4(input.lanAddress))
      )
        throw new Error(REMOTE_ERROR_CODES.invalidLanAddress);
      if (typeof input.allowPlaintext !== "boolean") throw new Error("invalid_configuration");
      if (input.enabled && (!input.allowPlaintext || !input.lanAddress))
        throw new Error("plaintext_confirmation_required");
      return {
        enabled: input.enabled,
        port: input.port,
        externalOrigin: HOSTED_ORIGIN,
        experimentalEnabled: input.experimentalEnabled,
        lanAddress: input.lanAddress,
        allowPlaintext: input.allowPlaintext,
      };
    }
    const allowedWorkspaceIds = input.allowedWorkspaceIds ?? [];
    const extraRoots = input.extraRoots ?? [];
    if (
      !Array.isArray(allowedWorkspaceIds) ||
      allowedWorkspaceIds.length > 128 ||
      allowedWorkspaceIds.some((id) => typeof id !== "string" || !id || id.length > 256) ||
      !Array.isArray(extraRoots) ||
      extraRoots.length > 32 ||
      extraRoots.some(
        (root) =>
          !root ||
          !/^extra-[a-zA-Z0-9_-]{1,80}$/.test(root.id) ||
          typeof root.name !== "string" ||
          !root.name.trim() ||
          root.name.length > 128 ||
          typeof root.path !== "string" ||
          !root.path.startsWith("/") ||
          root.path.includes("\0"),
      )
    )
      throw new Error("invalid_workspace_grants");
    if (input.relay) {
      const relay = input.relay;
      relayBrokerOrigin(relay.brokerUrl);
      if (
        typeof relay.enabled !== "boolean" ||
        (relay.frpcPath !== undefined &&
          (typeof relay.frpcPath !== "string" ||
            !isAbsolute(relay.frpcPath) ||
            relay.frpcPath.includes("\0")))
      )
        throw new Error("invalid_relay_configuration");
    }
    if (
      input.previewBytesPerSecond !== undefined &&
      (!Number.isSafeInteger(input.previewBytesPerSecond) ||
        input.previewBytesPerSecond < 16 * 1024 ||
        input.previewBytesPerSecond > 1024 * 1024 * 1024)
    )
      throw new Error("invalid_preview_bandwidth");
    let externalOrigin = "";
    if (this.options.acceptanceSessionId && input.externalOrigin)
      throw new Error("acceptance_is_local_only");
    if (input.externalOrigin) {
      let url: URL;
      try {
        url = new URL(input.externalOrigin);
      } catch {
        throw new Error("invalid_external_origin");
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("invalid_external_origin");
      externalOrigin = url.origin;
    }
    return {
      enabled: input.enabled,
      port: input.port,
      externalOrigin,
      experimentalEnabled: input.experimentalEnabled,
      allowedWorkspaceIds: [...new Set(allowedWorkspaceIds)],
      extraRoots: extraRoots.map((root) => ({ ...root })),
      previewBytesPerSecond: input.previewBytesPerSecond ?? 2 * 1024 * 1024,
      ...(input.relay
        ? {
            relay: {
              enabled: input.relay.enabled,
              brokerUrl: relayBrokerOrigin(input.relay.brokerUrl),
              ...(input.relay.frpcPath ? { frpcPath: input.relay.frpcPath } : {}),
            },
          }
        : {}),
    };
  }
  private status(): WebAdminStatus {
    return {
      pairingMode: this.options.mode === "lan" ? "confirmation" : "code",
      config: { ...this.config },
      running: !!this.server?.listening,
      error: this.error,
      experimentalAvailable:
        this.options.verifiedExperimental === true ||
        this.options.verifiedCodex === true ||
        this.options.verifiedClaudeManaged === true ||
        this.options.verifiedAntigravityManaged === true ||
        this.options.verifiedDevinManaged === true ||
        !!this.options.acceptanceSessionId,
      acceptanceSessionId: this.options.acceptanceSessionId,
      localUrl: `http://${this.options.mode === "lan" ? this.config.lanAddress : "127.0.0.1"}:${this.config.port}`,
      mode: this.options.mode ?? "local",
      ...(this.options.mode === "lan"
        ? {
            addresses: this.addresses,
            connectionUrl: this.server?.listening
              ? `${HOSTED_ORIGIN}/#connect=${encodeURIComponent(`http://${this.config.lanAddress}:${this.config.port}`)}`
              : undefined,
          }
        : {}),
      code: this.code && {
        value: this.code.value,
        expiresAt: this.code.expiresAt,
        access: this.code.access,
      },
      pending: [...this.browsers.values()].flatMap((b) => (b.pending ? [{ ...b.pending }] : [])),
      devices: this.credentials.map((c) => {
        const accessLevel = accessLevelOf(c.device);
        return {
          ...c.device,
          ...(accessLevel ? { accessLevel } : {}),
          ...(c.account ? { accountBound: true } : {}),
          online: this.isOnline(c.hash),
        };
      }),
      relay: this.officialRelayNeedsAccount()
        ? { phase: "offline", reason: "account-required" }
        : this.relay?.status,
    };
  }
  /** Online: the device follows a stream from this computer now, or made a request lately. */
  private isOnline(hash: string) {
    return (
      [...this.streams.values()].some((stream) => stream.hash === hash) ||
      Date.now() - (this.seen.get(hash) ?? -Infinity) < ONLINE_WINDOW_MS
    );
  }
  /**
   * A paired phone reports the account login it is in. When that login belongs to the account
   * this computer is signed in to, the pairing is bound to it: it ends with the login and is
   * renewed while the login lasts. A verified replacement login for the same account may
   * renew an existing pairing; a different account cannot inherit its authority. The account
   * cannot create pairing authority here.
   */
  private async bindAccount(hash: string, body: Record<string, unknown>) {
    if (this.accountLoginRequired()) return this.bindCloudAccount(hash, body);
    if (Object.keys(body).some((key) => key !== "sessionId"))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
    const sessionId = this.field(body.sessionId, 64);
    if (!SESSION_ID.test(sessionId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
    this.grant(hash);
    this.rate(`account-binding:${hash}`, 6);
    if (!this.options.accountSessions)
      return { bound: false, reason: REMOTE_ERROR_CODES.accountUnavailable };
    let live: AccountSessions;
    try {
      live = await this.options.accountSessions();
    } catch {
      return { bound: false, reason: REMOTE_ERROR_CODES.computerSignedOut };
    }
    const binding = this.queueAdmin(async () => {
      await this.expireCredentials();
      const credential = this.credentials.find((c) => c.hash === hash);
      if (!credential || this.browsers.get(hash)?.ended)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      const session = live.sessions.find((s) => s.id === sessionId && s.kind === "mobile");
      if (credential.account) {
        if (credential.account.accountId !== live.accountId || !session) {
          await this.revokeCredentials([credential], "pairing-ended");
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
        }
      } else {
        if (!session) return { bound: false, reason: REMOTE_ERROR_CODES.sessionUnknown };
      }
      credential.account = { accountId: live.accountId, sessionId };
      credential.expiresAt = Math.max(credential.expiresAt, Date.now() + MAX_AGE);
      await this.save();
      return { bound: true };
    });
    const result = await binding;
    this.grant(hash);
    return result;
  }
  private accountLoginRequired() {
    return (
      this.options.mode !== "lan" &&
      this.config.relay?.enabled === true &&
      (!!this.relay?.accountLoginContext || this.config.relay.brokerUrl === DEFAULT_RELAY_BROKER)
    );
  }
  private officialRelayConfigured() {
    return (
      this.options.mode !== "lan" &&
      this.config.relay?.enabled === true &&
      this.config.relay.brokerUrl === DEFAULT_RELAY_BROKER
    );
  }
  private officialRelayNeedsAccount() {
    return (
      this.officialRelayConfigured() &&
      (this.relayAccountPaused ||
        !this.options.account?.accountId() ||
        this.officialRelayOwnerChanged())
    );
  }
  private officialRelayOwnerChanged() {
    return (
      this.officialRelayConfigured() &&
      !!this.relay &&
      this.relay.status.phase !== "disabled" &&
      this.relayOwnerAccountId !== undefined &&
      this.relayOwnerAccountId !== this.options.account?.accountId()
    );
  }
  private cloudLoginContext() {
    const context = this.relay?.accountLoginContext;
    if (
      !context ||
      this.officialRelayNeedsAccount() ||
      (this.officialRelayConfigured() && context.accountId !== this.options.account?.accountId())
    )
      return;
    return context;
  }
  private requireCloudLoginContext() {
    const context = this.cloudLoginContext();
    if (!context) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accountLoginUnavailable);
    return context;
  }
  /** Supplemental receipts belong to the computer's owner, never the paired browser. */
  private readerScope(): string {
    const accountId =
      this.relay?.accountLoginContext?.accountId ??
      (this.options.account?.signedIn() ? this.options.account.accountId() : undefined);
    return accountId ? `account:${accountId}` : "local";
  }
  private validCloudBinding(binding?: AccountBinding) {
    const context = this.relay?.accountLoginContext;
    return (
      !!context &&
      !!binding?.id &&
      binding.accountId === context.accountId &&
      typeof binding.expiresAt === "number" &&
      binding.expiresAt > Date.now()
    );
  }
  private async bindCloudAccount(hash: string, body: Record<string, unknown>) {
    const browser = this.browsers.get(hash);
    if (!browser || browser.ended) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    const fields = ["code", "codeVerifier", "hostChallenge", "redemptionId"] as const;
    if (
      Object.keys(body).some((key) => !fields.includes(key as (typeof fields)[number])) ||
      fields.some(
        (key) =>
          typeof body[key] !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(body[key] as string),
      ) ||
      body.hostChallenge !== browser.accountChallenge
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAccountProof);
    this.requireCloudLoginContext();
    this.rate(`account-binding:${hash}`, 6);
    let proof: RemoteAccountBinding;
    try {
      proof = await this.relay!.redeemAccountLogin(body as AccountLoginProof);
    } catch {
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accountLoginUnavailable);
    }
    const bound: AccountBinding = { ...proof, hostChallenge: browser.accountChallenge };
    return this.queueAdmin(async () => {
      await this.expireCredentials();
      this.requireCloudLoginContext();
      if (
        this.browsers.get(hash) !== browser ||
        browser.ended ||
        !this.server ||
        !this.validCloudBinding(bound)
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      const credential = this.credentials.find((row) => row.hash === hash);
      if (credential?.account?.id && credential.account.accountId !== bound.accountId) {
        await this.revokeCredentials([credential], "pairing-ended");
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      }
      if (credential) {
        const next = this.credentials.map((row) =>
          row === credential ? { ...row, account: bound } : row,
        );
        await this.save(this.config, this.remotePairingInitialized, next);
        this.credentials = next;
      }
      browser.account = bound;
      return { bound: true };
    });
  }
  /**
   * Ends bound pairings whose login ended (signed out, revoked, expired) or belongs to another
   * account than the one this computer is now signed in to, and renews the others. Signed out
   * or offline, nothing changes: no pairing ends, none is renewed.
   */
  async checkAccountBindings() {
    if (this.disposed) return;
    this.checkCredentialExpiry();
    const relay = this.relay;
    const official = this.officialRelayConfigured();
    const isCurrent = () =>
      official === this.officialRelayConfigured() &&
      (!official || (!!relay && relay === this.relay && !this.officialRelayNeedsAccount()));
    if (this.disposed || !isCurrent()) return;
    const proofCredentials = this.credentials.filter(
      (c) => c.account?.id && !this.credentialExpired(c),
    );
    if (proofCredentials.length && this.relay?.accountLoginContext) {
      let results: { id: string; active: boolean; expiresAt?: number }[];
      try {
        results = await this.relay.verifyAccountLogins(proofCredentials.map((c) => c.account!.id!));
      } catch {
        return;
      }
      await this.queueAdmin(async () => {
        if (this.disposed || !isCurrent()) return;
        await this.expireCredentials();
        const ended = this.credentials.filter(
          (c) =>
            proofCredentials.includes(c) &&
            results.some((row) => row.id === c.account?.id && !row.active),
        );
        if (ended.length) await this.revokeCredentials(ended, "pairing-ended");
        let renewed = false;
        for (const credential of this.credentials) {
          if (!proofCredentials.includes(credential)) continue;
          const result = results.find((row) => row.id === credential.account?.id && row.active);
          if (
            result?.expiresAt !== undefined &&
            result.expiresAt > Date.now() &&
            credential.account!.expiresAt !== result.expiresAt
          ) {
            credential.account!.expiresAt = result.expiresAt;
            renewed = true;
          }
          if (result && credential.expiresAt < Date.now() + MAX_AGE - RENEW_AFTER_MS) {
            credential.expiresAt = Date.now() + MAX_AGE;
            renewed = true;
          }
        }
        if (renewed) await this.save();
      });
    }
    if (!this.options.accountSessions) return;
    if (!this.credentials.some((c) => c.account && !this.credentialExpired(c))) return;
    let live: AccountSessions;
    try {
      live = await this.options.accountSessions();
    } catch {
      return;
    }
    const ids = new Set(
      live.sessions.flatMap((session) => (session.kind === "mobile" ? [session.id] : [])),
    );
    await this.queueAdmin(async () => {
      if (this.disposed || !isCurrent()) return;
      await this.expireCredentials();
      const ended = this.credentials.filter(
        (c) =>
          c.account &&
          !c.account.id &&
          (c.account.accountId !== live.accountId || !ids.has(c.account.sessionId)),
      );
      const now = Date.now();
      let renewed = false;
      for (const c of this.credentials)
        if (
          c.account &&
          !c.account.id &&
          !ended.includes(c) &&
          c.expiresAt < now + MAX_AGE - RENEW_AFTER_MS
        ) {
          c.expiresAt = now + MAX_AGE;
          renewed = true;
        }
      if (ended.length) await this.revokeCredentials(ended, "pairing-ended");
      else if (renewed) await this.save();
    });
  }
  /** Ends these pairings as if revoked here: streams close and the browsers must pair again. */
  private async revokeCredentials(revoked: Credential[], source: ScheduleInvalidationSource) {
    this.revocationPending ||= revoked.length > 0;
    this.credentials = this.credentials.filter((c) => !revoked.includes(c));
    const invalidations = revoked.map((c) => {
      if (this.expiringDeviceIds.delete(c.device.id)) return;
      this.endCredential(c);
      return this.invalidateScheduledDevice(c.device.id, source);
    });
    await Promise.all([
      this.save(
        this.config,
        this.remotePairingInitialized,
        this.credentials,
        this.revocationPending,
      ),
      ...invalidations,
    ]);
    this.revocationPending = false;
  }
  private endCredential(credential: Credential) {
    const { hash, device } = credential;
    const browser = this.browsers.get(hash);
    if (browser) browser.ended = true;
    this.endStreams(hash);
    this.artifacts?.revokeDevice(device.id);
    this.livePreview?.revokeDevice(device.id);
    for (const [id, reference] of this.contextArtifactRefs)
      if (reference.deviceId === device.id) this.contextArtifactRefs.delete(id);
  }
  private save(
    config = this.config,
    remotePairingInitialized = this.remotePairingInitialized,
    credentials = this.credentials,
    revoking = false,
  ) {
    const contents = JSON.stringify({ config, credentials, remotePairingInitialized });
    const result = this.persistence
      .then(() => writeWebAccessSnapshot(this.options.dataDir, contents, revoking))
      .catch((cause) => {
        throw new Error(REMOTE_ERROR_CODES.webStateSaveFailed, { cause });
      });
    this.persistence = result.catch(() => undefined);
    return result;
  }
  private async start(connectRelay = true) {
    if (this.disposed) return;
    this.error = undefined;
    if (
      this.options.mode === "lan" &&
      !this.addresses.some((entry) => entry.address === this.config.lanAddress)
    ) {
      this.error = REMOTE_ERROR_CODES.lanAddressUnavailable;
      return;
    }
    const server = createServer((req, res) => {
      const control = { request: false, dispatched: false, priorUncertain: false };
      this.requestTraces.observe(req.method, req.url, res, control);
      void this.handle(req, res, control).catch((error) => {
        this.respondControlError(res, control, error);
      });
    });
    this.managedSocket = attachManagedWebSocket(server, {
      authorize: async (request) => {
        if (this.options.mode === "lan" || this.disposed) return false;
        const response = new LocalConversationResponse();
        const control: ActionOutcome = { request: false, dispatched: false, priorUncertain: false };
        this.requestTraces.observe(request.method, request.url, response, control);
        try {
          await this.handle(
            {
              headers: request.headers,
              method: "GET",
              url: `${REMOTE_ROUTE_BASE}${REMOTE_ROUTE.catalog}`,
              async *[Symbol.asyncIterator]() {},
            },
            response,
            control,
          );
        } catch (error) {
          if (error instanceof HttpError && error.status === 429) this.recordRateRejection(control);
          this.requestTraces.error(
            response,
            error,
            error instanceof HttpError ? error.status : 500,
            error instanceof HttpError ? { error: error.code } : undefined,
          );
          throw error;
        }
        return response.statusCode === 200;
      },
      dispatch: async (request, response, control) => {
        this.requestTraces.observe(request.method, request.url, response, control);
        try {
          await this.handle(request, response, control);
        } catch (error) {
          this.respondControlError(response, control, error);
        }
      },
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;
    server.maxHeadersCount = 40;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(
          this.config.port,
          this.options.mode === "lan" ? this.config.lanAddress : "127.0.0.1",
          () => {
            server.removeListener("error", reject);
            resolve();
          },
        );
      });
      this.server = server;
      if (this.options.mode !== "lan") await this.startPreview();
      if (connectRelay && this.config.relay?.enabled) this.startRelay();
      if (this.options.mode === "lan") {
        this.lanAddressMisses = 0;
        this.addressTimer = setInterval(() => {
          void this.checkLanAddress();
        }, 30_000);
        this.addressTimer.unref();
      }
      server.on("error", () => {
        this.error = REMOTE_ERROR_CODES.webServerError;
      });
    } catch (error) {
      // A preview/relay initialization failure must not leave a half-started listener.
      if (this.server === server) await this.shutdown();
      this.error =
        (error as NodeJS.ErrnoException).code === "EADDRINUSE"
          ? REMOTE_ERROR_CODES.portInUse
          : REMOTE_ERROR_CODES.webStartFailed;
    }
  }
  private respondControlError(res: ConversationResponse, control: ActionOutcome, error: unknown) {
    const known =
      error instanceof HttpError ||
      error instanceof ArtifactError ||
      error instanceof AttachmentError;
    const status = known ? error.status : 500;
    const body = {
      error: known ? error.code : REMOTE_ERROR_CODES.requestFailed,
      ...((error instanceof HttpError || error instanceof AttachmentError) &&
        error.reason && { reason: error.reason }),
      ...responseControlOutcome(control),
    };
    this.requestTraces.error(res, error, status, body);
    if (res.headersSent) {
      res.end();
      return;
    }
    if (known && error.status === 429) this.recordRateRejection(control);
    if (error instanceof HttpError && error.retryAfter !== undefined)
      res.setHeader("Retry-After", String(error.retryAfter));
    this.json(res, status, body);
  }
  private recordRateRejection(control: ActionOutcome) {
    const diagnostic = control.rateDiagnostic;
    if (diagnostic)
      this.rateDiagnostics.reject(diagnostic.deviceId, diagnostic.category, diagnostic.at);
  }
  /** Also called on OS resume and when settings request their current status. */
  async checkLanAddress(): Promise<void> {
    if (this.options.mode !== "lan" || !this.server) return;
    if (this.addresses.some((entry) => entry.address === this.config.lanAddress)) {
      this.lanAddressMisses = 0;
      return;
    }
    // VPN/TUN 代理切换时网卡列表可能短暂缺少该地址；连续 3 次检查都缺失才停止监听。
    if (++this.lanAddressMisses < 3) return;
    this.error = REMOTE_ERROR_CODES.lanAddressUnavailable;
    await this.shutdown();
  }
  async shutdown(invalidation?: "application-quit" | "lan-pairing-reset") {
    const server = this.server;
    this.server = undefined;
    this.managedSocket?.close();
    this.managedSocket = undefined;
    this.relayEpoch += 1;
    clearInterval(this.addressTimer);
    this.addressTimer = undefined;
    this.bootId = token();
    this.contextArtifactRefs.clear();
    this.endStreams(
      undefined,
      invalidation === "lan-pairing-reset" ? "access-ended" : "unavailable",
    );
    if (invalidation)
      await Promise.all(
        this.credentials
          .filter(({ device }) => !this.expiringDeviceIds.has(device.id))
          .map(({ device }) => this.invalidateScheduledDevice(device.id, invalidation)),
      );
    await this.relay?.stop();
    await Promise.all([this.previewStarting, this.desktopPreviewStarting]).catch(() => undefined);
    this.artifacts?.clear();
    this.desktopArtifacts?.clear();
    this.livePreview?.close();
    const previews = [this.previewServer, this.desktopPreviewServer];
    this.previewServer = undefined;
    this.desktopPreviewServer = undefined;
    this.artifacts = undefined;
    this.desktopArtifacts = undefined;
    this.livePreview = undefined;
    for (const preview of previews)
      if (preview) {
        preview.closeAllConnections();
        await new Promise<void>((resolve) => preview.close(() => resolve()));
      }
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }
  runtimeUnavailable() {
    this.bootId = token();
    this.contextArtifactRefs.clear();
    this.endStreams(undefined, REMOTE_ERROR_CODES.runtimeUnavailable);
  }
  async suspendRelay() {
    await this.relay?.suspend();
  }
  async resumeRelay() {
    await this.relay?.resume();
  }
  /** Loopback destinations used only by the managed TLS tunnel. */
  relayTargets() {
    const address = this.previewServer?.address();
    if (!this.server?.listening || !address || typeof address === "string")
      throw new Error("web_not_running");
    return {
      control: { host: "127.0.0.1" as const, port: this.config.port },
      preview: { host: "127.0.0.1" as const, port: address.port },
    };
  }
  /** Main-process account bridge only. Never included in WebAdminStatus or HTTP routes. */
  async accountIdentity(): Promise<Registration | undefined> {
    const directory = join(
      this.options.dataDir,
      "relay",
      digest(DEFAULT_RELAY_BROKER).slice(0, 24),
    );
    try {
      const value = JSON.parse(await readFile(join(directory, "registration.json"), "utf8"));
      if (value.brokerUrl !== DEFAULT_RELAY_BROKER) throw new Error("invalid_account_registration");
      return validateRegistration(value, DEFAULT_RELAY_BROKER);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("invalid_account_registration", { cause: error });
    }
  }
  async prepareAccountClaim(accountId: string): Promise<void> {
    const identity = await this.accountIdentity();
    if (!identity) throw new Error("account_device_missing");
    if (identity.accountClaimPending && identity.accountClaimAccountId !== accountId)
      throw new Error("account_claim_pending");
    await this.request({ operation: "relay-stop" });
    await this.writeAccountIdentity({
      ...identity,
      accountClaimPending: true,
      accountClaimAccountId: accountId,
    });
  }
  async bindAccountIdentity(accountId: string): Promise<void> {
    const identity = await this.accountIdentity();
    if (!identity || (identity.accountId && identity.accountId !== accountId))
      throw new Error("account_device_conflict");
    if (identity.accountClaimPending && identity.accountClaimAccountId !== accountId)
      throw new Error("account_claim_pending");
    const {
      accountClaimPending: _pending,
      accountClaimAccountId: _pendingOwner,
      ...confirmed
    } = identity;
    await this.writeAccountIdentity({ ...confirmed, accountId });
  }
  private async writeAccountIdentity(identity: Registration): Promise<void> {
    const value = validateRegistration(identity, DEFAULT_RELAY_BROKER);
    const file = join(
      this.options.dataDir,
      "relay",
      digest(DEFAULT_RELAY_BROKER).slice(0, 24),
      "registration.json",
    );
    await writeFile(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
    await rename(file + ".tmp", file);
  }
  private startRelay(inviteCode?: string, reenroll?: boolean) {
    if (this.disposed) return;
    const config = this.config.relay;
    if (
      !config?.enabled ||
      this.officialRelayNeedsAccount() ||
      (this.officialRelayConfigured() && !this.options.account?.signedIn())
    )
      return;
    const targets = this.relayTargets();
    const epoch = ++this.relayEpoch;
    this.relay = new RelayManager({
      brokerUrl: config.brokerUrl,
      frpcPath: config.frpcPath || this.options.bundledFrpcPath || "",
      trustedFrpcPath: this.options.bundledFrpcPath || "",
      createCsr:
        this.options.createRelayCsr ?? (() => Promise.reject(new Error("runtime_unavailable"))),
      ...(config.brokerUrl === DEFAULT_RELAY_BROKER ? {} : { inviteCode }),
      ...(config.brokerUrl === DEFAULT_RELAY_BROKER
        ? {
            authorizeAccount: async (accountId?: string) => {
              if (!this.options.account?.signedIn())
                throw new Error(REMOTE_ERROR_CODES.accountLoginRequired);
              await this.options.account.ensureDeviceOwner(accountId);
            },
            ...(this.options.account?.signedIn()
              ? {
                  registrationAccountId: this.options.account.accountId(),
                  registerAccount: (input: { registrationId: string; credential: string }) =>
                    this.options.account!.registerDevice(input),
                }
              : {}),
          }
        : {}),
      reenroll,
      stateDirectory: join(this.options.dataDir, "relay", digest(config.brokerUrl).slice(0, 24)),
      target: targets.control,
      preview: targets.preview,
      directAddresses: () => this.addresses.map(({ address }) => address),
      onOrigins: ({ publicUrl, previewUrl }) => {
        const update = this.adminQueue.then(async () => {
          if (epoch !== this.relayEpoch || !this.config.relay?.enabled) return;
          await this.setRelayOrigins(publicUrl, previewUrl);
        });
        this.adminQueue = update.catch(() => undefined);
        return update;
      },
      onStatus: (status) => {
        if (status.phase !== "ready" || epoch !== this.relayEpoch) return;
        this.pushEvents.emit("changed");
        const update = this.adminQueue.then(async () => {
          if (
            epoch !== this.relayEpoch ||
            !this.config.relay?.enabled ||
            this.relay?.status.phase !== "ready" ||
            this.remotePairingInitialized
          )
            return;
          // Persist the one-time onboarding marker before issuing a code. Reconnects
          // and restarts never rotate it; an expired/missing code is refreshed manually.
          await this.save(this.config, true);
          if (
            epoch !== this.relayEpoch ||
            !this.config.relay?.enabled ||
            this.relay?.status.phase !== "ready"
          ) {
            await this.save(this.config, false);
            return;
          }
          this.remotePairingInitialized = true;
          if (this.error === REMOTE_ERROR_CODES.webStateSaveFailed) this.error = undefined;
          if (!this.code || this.code.expiresAt <= Date.now()) this.code = newPairingCode();
        });
        this.adminQueue = update.catch(() => {
          this.error = REMOTE_ERROR_CODES.webStateSaveFailed;
        });
      },
    });
    this.relayOwnerAccountId =
      config.brokerUrl === DEFAULT_RELAY_BROKER ? this.options.account?.accountId() : undefined;
    // Status polling reports certificate/connection progress; it must not block desktop settings.
    void this.relay.start().catch(() => undefined);
  }
  async setRelayOrigins(appOrigin: string, previewOrigin: string) {
    if (this.options.mode === "lan") throw new Error("relay_requires_local_service");
    const normalized = this.validateConfig({ ...this.config, externalOrigin: appOrigin });
    const preview = new URL(previewOrigin);
    if (
      preview.protocol !== "https:" ||
      preview.origin !== previewOrigin ||
      previewOrigin === appOrigin
    )
      throw new Error("invalid_preview_origin");
    this.config = normalized;
    this.previewOrigin = previewOrigin;
    this.artifacts?.setOrigins(appOrigin, previewOrigin, [`http://127.0.0.1:${this.config.port}`]);
    await this.save();
  }
  private async startPreview() {
    if (this.previewServer) return;
    if (this.previewStarting) return this.previewStarting;
    this.previewStarting = this.createPreview();
    try {
      await this.previewStarting;
    } finally {
      this.previewStarting = undefined;
    }
  }
  private async startDesktopPreview() {
    if (this.desktopPreviewServer) return;
    if (this.desktopPreviewStarting) return this.desktopPreviewStarting;
    this.desktopPreviewStarting = this.createPreview(true);
    try {
      await this.desktopPreviewStarting;
    } finally {
      this.desktopPreviewStarting = undefined;
    }
  }
  private async createPreview(desktop = false) {
    let artifacts: ArtifactService;
    // The desktop app frames local pages directly; only remote browsers need the proxy.
    const live = desktop
      ? undefined
      : new LivePreviewService({
          origins: () => ({
            preview: artifacts.previewOrigin,
            ancestors: artifacts.frameAncestors(),
          }),
          authorize: (deviceId) => this.livePreviewAllowed(deviceId),
          reservedPorts: () => this.ownPorts(),
        });
    const server = createServer((req, res) => {
      const handled =
        live && LivePreviewService.owns(req.url)
          ? live.handle(req, res)
          : artifacts.handle(req, res);
      void handled.catch((error: unknown) => {
        const known =
          error instanceof ArtifactError || error instanceof LivePreviewError ? error : undefined;
        if (!res.headersSent)
          this.json(res, known?.status ?? 500, {
            error: known?.message ?? REMOTE_ERROR_CODES.previewFailed,
          });
        else res.destroy();
      });
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 120_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("preview_start_failed");
    const previewOrigin = `http://127.0.0.1:${address.port}`;
    artifacts = new ArtifactService({
      bytesPerSecond: this.config.previewBytesPerSecond,
      allowHttpLoopback: true,
      appOrigin: (!desktop && this.config.externalOrigin) || `http://127.0.0.1:${this.config.port}`,
      previewOrigin,
      desktopAppOrigin: desktop ? this.options.desktopOrigin : undefined,
      authorize: async (scope) => {
        try {
          if (scope.deviceId === CLAUDE_LOCAL_OWNER) {
            const verified = await this.localArtifactScope(this.field(scope.sessionId));
            if (verified.workspaceId !== scope.workspaceId)
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
            const root = (await this.registeredWorkspaces()).find(
              (row) => row.id === verified.workspaceId,
            );
            if (!root) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
            return {
              root: root.path,
              epoch: digest(`${this.bootId}|${root.path}|${scope.sessionId}`),
            };
          }
          const credential =
            scope.deviceId === this.localDevice.id
              ? { hash: "desktop-local", device: this.localDevice }
              : this.credentials.find((c) => c.device.id === scope.deviceId);
          if (!credential) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
          this.grant(credential.hash, REMOTE_CAPABILITIES.device.files);
          const roots = await this.fileRoots(credential.device);
          const root = roots.find((item) => item.id === scope.workspaceId);
          if (!root) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
          this.grant(credential.hash, REMOTE_CAPABILITIES.device.files);
          return {
            root: root.path,
            epoch: digest(
              `${credential.hash}|${root.path}|${JSON.stringify(this.config.allowedWorkspaceIds)}|${JSON.stringify(this.config.extraRoots)}`,
            ),
          };
        } catch (error) {
          if (error instanceof HttpError)
            throw new ArtifactError(
              error.status,
              parseRemoteErrorCode(error.message) ?? REMOTE_ERROR_CODES.requestFailed,
            );
          throw error;
        }
      },
    });
    if (desktop) {
      // This listener and its tickets are never handed to the public relay.
      this.desktopPreviewServer = server;
      this.desktopArtifacts = artifacts;
    } else {
      this.previewServer = server;
      this.previewOrigin = previewOrigin;
      this.artifacts = artifacts;
      this.livePreview = live;
    }
  }
  /** Loopback ports of AgentKib's own listeners, which the web preview never opens. */
  private ownPorts(): number[] {
    const ports = [this.config.port];
    for (const server of [this.previewServer, this.desktopPreviewServer]) {
      const address = server?.address();
      if (address && typeof address !== "string") ports.push(address.port);
    }
    return ports;
  }
  /** Checked again on every proxied request: full access with advanced control. */
  private livePreviewAllowed(deviceId: string) {
    const credential = this.credentials.find(
      (c) => c.device.id === deviceId && !this.credentialExpired(c),
    );
    if (!this.server || !credential || this.browsers.get(credential.hash)?.ended) return false;
    const device = credential.device;
    return (
      this.isFullAccess(device) &&
      device.advancedControl === true &&
      this.controlsEnabled(undefined, device)
    );
  }
  private async fileRoots(device?: WebDevice) {
    const workspaces = await this.registeredWorkspaces();
    return [
      ...workspaces.filter(
        (w) => this.isFullAccess(device) || this.config.allowedWorkspaceIds?.includes(w.id),
      ),
      ...(this.config.extraRoots ?? []),
    ];
  }
  private async registeredWorkspaces(
    reserved = false,
  ): Promise<{ id: string; name: string; path: string }[]> {
    // Workspace registration is read by the main runtime worker, independently
    // of the dedicated execution worker's control admission and long requests.
    if (this.options.workspaceRequest) return this.options.workspaceRequest();
    const catalog = (await this.scopeCatalog(reserved)) as {
      workspaces?: { id: string; name: string; path: string }[];
    };
    return catalog.workspaces ?? [];
  }
  private async fileScopeFor(device: WebDevice, workspaceId: string) {
    if (!(await this.fileRoots(device)).some((w) => w.id === workspaceId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    return { deviceId: device.id, workspaceId };
  }
  /** 供有副作用的调用方使用（如签发预览票据）：await 之后必须立刻确认授权仍然有效。 */
  private async fileScope(hash: string, workspaceId: string) {
    const scope = await this.fileScopeFor(
      this.grant(hash, REMOTE_CAPABILITIES.device.files),
      workspaceId,
    );
    this.grant(hash, REMOTE_CAPABILITIES.device.files);
    return scope;
  }
  private async files(res: ConversationResponse, hash: string, path: string, url: URL) {
    // 这里全是只读操作：开始时授权一次，响应前再确认一次。期间被撤销的设备
    // 拿不到任何数据，中间步骤无需反复重查。
    const device = this.grant(hash, REMOTE_CAPABILITIES.device.files);
    const result = await this.readFiles(device, path, url);
    const current = this.grant(hash, REMOTE_CAPABILITIES.device.files);
    if (path === REMOTE_ROUTE.diff && url.searchParams.get("context") === "1") {
      const workspaceId = this.field(url.searchParams.get("workspaceId"));
      if (!(await this.workspaceAllowed(workspaceId, current, this.admission)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      if (this.grant(hash, REMOTE_CAPABILITIES.device.files) !== current)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    }
    return this.json(res, 200, result);
  }
  private async readFiles(device: WebDevice, path: string, url: URL): Promise<unknown> {
    if (path === REMOTE_ROUTE.filesWorkspaces) {
      const roots = await this.fileRoots(device);
      return { workspaces: roots.map(({ id, name }) => ({ id, name })) };
    }
    const workspaceId = this.field(url.searchParams.get("workspaceId"));
    const scope = await this.fileScopeFor(device, workspaceId);
    let result: unknown;
    if (path === REMOTE_ROUTE.diff) {
      if (!(await this.workspaceAllowed(workspaceId, device, this.admission)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      const kind = url.searchParams.get("kind") ?? "worktree";
      if (!["worktree", "staged", "commit"].includes(kind))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidDiffKind);
      result = await this.runtime({
        operation: "diff",
        workspaceId,
        kind,
        path: url.searchParams.get("path") ?? undefined,
        oid: url.searchParams.get("oid") ?? undefined,
        ...(url.searchParams.get("context") === "1" ? { context: true } : {}),
      });
    } else {
      const artifacts = this.artifactsFor(scope.deviceId);
      if (!artifacts) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.previewUnavailable);
      if (path === REMOTE_ROUTE.filesList)
        result = await artifacts.list(scope, url.searchParams.get("directoryId") ?? undefined);
      else if (path === REMOTE_ROUTE.filesText)
        result = await artifacts.readText(
          scope,
          this.field(url.searchParams.get("artifactId")),
          url.searchParams.get("revision") ?? undefined,
        );
      else if (path === REMOTE_ROUTE.artifacts || path === REMOTE_ROUTE.artifactsResolve) {
        const sessionId = this.field(url.searchParams.get("sessionId"));
        const catalog = (await this.scopeCatalog()) as {
          sessions: { id: string; workspace_id: string }[];
        };
        if (!catalog.sessions.some((s) => s.id === sessionId && s.workspace_id === workspaceId))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionWorkspaceMismatch);
        const directory = await this.sessionDirectory(sessionId);
        if (path === REMOTE_ROUTE.artifactsResolve) {
          // 手机点开回复里的一个文件引用。找不到或不允许读取都返回 null，不区分原因。
          const reference = fileReferencePath(this.field(url.searchParams.get("reference"), 4096));
          const [artifact] = reference
            ? await artifacts.resolveReferences(scope, [reference], directory)
            : [];
          result = { artifact: artifact ?? null };
        } else {
          // 只要这一页的文件引用，不为下一页保留游标，免得挤掉客户端翻页用的游标。
          const page = (await this.runtime({
            operation: "events",
            sessionId,
            limit: 50,
            cursor: url.searchParams.get("cursor") ?? undefined,
            retainCursor: false,
          })) as { events: { content?: string }[]; next_cursor?: string };
          // 同一个文件常被反复提到。去重后再截到上限，引用多的一页也不会整页失败。
          const refs = [
            ...new Set(page.events.flatMap((event) => fileReferenceTargets(event.content ?? ""))),
          ].slice(0, 100);
          const found = await artifacts.resolveReferences(scope, refs, directory);
          result = {
            artifacts: found.filter(
              (item, index) => found.findIndex((other) => other.id === item.id) === index,
            ),
            next_cursor: page.next_cursor,
          };
        }
      } else throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    }
    return result;
  }
  /**
   * 会话的工作目录，只用来摆放回复里的相对路径，不扩大文件授权。
   * 读不到时返回 undefined，相对路径按工作区根目录解析，与以前一致。
   */
  private async sessionDirectory(sessionId: string): Promise<string | undefined> {
    try {
      const cwd = snapshotField(
        await this.runtime({ operation: "session-directory", sessionId }),
        "cwd",
      );
      return typeof cwd === "string" && cwd ? cwd : undefined;
    } catch {
      return undefined;
    }
  }
  private optionalString(value: unknown, max = 256) {
    return typeof value === "string" && value.trim() && value.length <= max ? value : undefined;
  }
  private availability(value: unknown): Availability {
    if (value && typeof value === "object") {
      const item = value as { available?: unknown; reason?: unknown };
      return {
        available: item.available === true,
        ...(this.optionalString(item.reason) ? { reason: this.optionalString(item.reason) } : {}),
      };
    }
    return { available: value === true };
  }
  private projectUsage(raw: unknown) {
    return projectContextUsage(raw);
  }
  private projectUsageFields(snapshot: Record<string, unknown>, device?: WebDevice) {
    const projected = { ...snapshot };
    // The enclosing GET/SSE admission already checks the session's workspace.
    // Usage is an observation: it does not depend on send readiness or unknown outcomes.
    const permitted = this.isFullAccess(device) && device?.advancedControl === true;
    const raw = Object.hasOwn(snapshot, "usage")
      ? snapshot.usage
      : "tokenUsage" in snapshot
        ? { available: true, tokenUsage: snapshot.tokenUsage, revision: snapshot.revision }
        : undefined;
    delete projected.tokenUsage;
    delete projected.usage;
    if (permitted && raw !== undefined) {
      const usage =
        projectContextUsage(raw) ??
        (raw === null ? { available: false, state: "unavailable" as const } : undefined);
      if (usage)
        projected.usage =
          snapshot.activity === "compacting"
            ? projectContextUsage({ ...usage, state: "pending" })
            : usage;
    }
    return projected;
  }
  /**
   * `permission` is display-only data about the mode a Claude session runs in. This is the edge
   * to browsers, so only the documented closed shape passes: anything else is dropped, never
   * repaired, and unknown keys are not copied.
   */
  private projectPermission(raw: unknown) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const { mode, previous, possiblyAuto } = raw as Record<string, unknown>;
    if (mode !== null && !CLAUDE_OBSERVED_PERMISSION_MODES.has(mode as string)) return undefined;
    if (previous !== undefined && previous !== true) return undefined;
    if (possiblyAuto !== undefined && possiblyAuto !== true) return undefined;
    // `previous` is an earlier report, so it needs a mode; the hint marks an unknown mode only.
    if (previous === true && mode === null) return undefined;
    if (possiblyAuto === true && mode !== null) return undefined;
    return {
      mode: mode as string | null,
      ...(previous === true ? { previous: true as const } : {}),
      ...(possiblyAuto === true ? { possiblyAuto: true as const } : {}),
    };
  }
  private projectPermissionField(snapshot: Record<string, unknown>) {
    if (!Object.hasOwn(snapshot, "permission")) return snapshot;
    const { permission: raw, ...rest } = snapshot;
    const permission = this.projectPermission(raw);
    return permission ? { ...rest, permission } : rest;
  }
  private projectSessionProvider(value: unknown): SessionProviderCapabilities | undefined {
    if (!value || typeof value !== "object") return;
    const { create, models, contextUsage, composer, history, operations, pendingInteractions } =
      value as Partial<SessionProviderCapabilities>;
    if (
      (create?.mode !== "empty" && create?.mode !== "with-first-message") ||
      (create.catalogScope !== "host" && create.catalogScope !== "workspace") ||
      (models?.selection !== "independent" && models?.selection !== "variants") ||
      (contextUsage !== "live" && contextUsage !== "last-request" && contextUsage !== "unsupported")
    )
      return;
    return {
      history: { readState: history?.readState === true },
      operations: { execution: operations?.execution === true },
      create: {
        mode: create.mode,
        catalogScope: create.catalogScope,
        attachments: create.attachments === true,
        serviceTiers: create.serviceTiers === true,
        ...(typeof create.modelPicker === "boolean" ? { modelPicker: create.modelPicker } : {}),
        ...(typeof create.permissionPicker === "boolean"
          ? { permissionPicker: create.permissionPicker }
          : {}),
        ...(create.agentPresets === true ? { agentPresets: true } : {}),
        ...(create.verifyStartupModel === true ? { verifyStartupModel: true } : {}),
        ...(create.planMode === "mode" || create.planMode === "permissionMode"
          ? { planMode: create.planMode }
          : {}),
        ...(create.workspaceResources === true ? { workspaceResources: true } : {}),
        ...(create.goal === true ? { goal: true } : {}),
        ...(create.goal === true && create.goalBudget === "rounds" ? { goalBudget: "rounds" } : {}),
      },
      models: {
        selection: models.selection,
        modelDefault: models.modelDefault === true,
        effortDefault: models.effortDefault === true,
        clearEffort: models.clearEffort === true,
        fastTierIds: Array.isArray(models.fastTierIds)
          ? models.fastTierIds
              .slice(0, 32)
              .filter((tier) => this.optionalString(tier, 128) !== undefined)
          : [],
        ...(models.prepare === true ? { prepare: true } : {}),
        ...(models.nativePicker === true ? { nativePicker: true } : {}),
      },
      contextUsage,
      ...(composer &&
      [
        "modelPicker",
        "permissionPicker",
        "attachments",
        "workspaceResources",
        "plan",
        "goal",
      ].every((key) => typeof composer[key as keyof typeof composer] === "boolean")
        ? {
            composer: {
              modelPicker: composer.modelPicker,
              permissionPicker: composer.permissionPicker,
              attachments: composer.attachments,
              workspaceResources: composer.workspaceResources,
              plan: composer.plan,
              goal: composer.goal,
            },
          }
        : {}),
      ...(pendingInteractions?.approval === true || pendingInteractions?.question === true
        ? {
            pendingInteractions: {
              ...(pendingInteractions.approval === true ? { approval: true as const } : {}),
              ...(pendingInteractions.question === true ? { question: true as const } : {}),
            },
          }
        : {}),
    };
  }
  private projectNewSessionOptions(options: unknown, device: WebDevice) {
    const provider = this.projectSessionProvider(snapshotField(options, "provider"));
    if (!provider) return {};
    const { planMode, workspaceResources, goal, goalBudget, ...create } = provider.create;
    const advanced =
      device.manage === true && device.advancedControl === true && this.isFullAccess(device);
    return {
      provider: {
        ...provider,
        create: {
          ...create,
          ...(planMode && (planMode !== "mode" || device.settings === true) ? { planMode } : {}),
          ...(workspaceResources && advanced && device.files === true
            ? { workspaceResources }
            : {}),
          ...(goal && advanced ? { goal, ...(goalBudget ? { goalBudget } : {}) } : {}),
        },
      },
    };
  }
  private projectSettings(raw: unknown, usage?: unknown) {
    const data =
      raw && typeof raw === "object"
        ? (raw as {
            available?: unknown;
            executionMode?: unknown;
            provider?: unknown;
            status?: unknown;
            settings?: {
              current?: Record<string, unknown>;
              selected?: Record<string, unknown>;
              applicationStatus?: unknown;
              defaults?: Record<string, unknown>;
              writable?: Record<string, unknown>;
            };
            current?: Record<string, unknown>;
            selected?: Record<string, unknown>;
            historicalSettings?: Record<string, unknown>;
            historicalUsage?: unknown;
            applicationStatus?: unknown;
            defaults?: Record<string, unknown>;
            writable?: Record<string, unknown>;
            collaborationModes?: unknown;
            models?: unknown;
            policies?: unknown;
            serviceTiers?: unknown;
            permissionModes?: unknown;
            revision?: unknown;
            writeScope?: unknown;
            reason?: unknown;
          })
        : {};
    const current = data.current ?? data.settings?.current;
    const selected = data.selected ?? data.settings?.selected;
    const applicationStatus = data.applicationStatus ?? data.settings?.applicationStatus;
    const defaults = data.defaults ?? data.settings?.defaults;
    const writable = data.writable ?? data.settings?.writable;
    const provider = this.projectSessionProvider(data.provider);
    const devin = data.executionMode === "devin-print";
    const contextLimit = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    const stringList = (value: unknown, max = 32) =>
      Array.isArray(value)
        ? [
            ...new Set(
              value
                .map((entry) => this.optionalString(entry, 128))
                .filter((entry): entry is string => !!entry),
            ),
          ].slice(0, max)
        : [];
    const tierIds = (value: unknown) =>
      Array.isArray(value)
        ? [
            ...new Set(
              value
                .map((entry) =>
                  entry && typeof entry === "object"
                    ? this.optionalString((entry as Record<string, unknown>).id, 128)
                    : this.optionalString(entry, 128),
                )
                .filter((entry): entry is string => !!entry),
            ),
          ].slice(0, 32)
        : [];
    const models = Array.isArray(data.models)
      ? data.models.slice(0, devin ? 256 : 64).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const model = value as Record<string, unknown>;
          const id = this.optionalString(model.id, 128);
          if (!id) return [];
          const name = this.optionalString(model.name, 256);
          const resolvedModel =
            data.executionMode === "claude-managed"
              ? this.optionalString(model.resolvedModel, 128)
              : undefined;
          const defaultEffort = this.optionalString(
            model.defaultEffort ?? model.default_effort,
            128,
          );
          // The provider an agent lists the model under (DeepSeek Harness).
          const group = this.optionalString(model.group, 256);
          const maxContextTokens =
            provider || devin ? contextLimit(model.maxContextTokens) : undefined;
          const variants =
            (provider?.models.selection === "variants" || (!provider && devin)) &&
            Array.isArray(model.variants)
              ? model.variants.slice(0, 128).flatMap((entry) => {
                  if (!entry || typeof entry !== "object") return [];
                  const variant = entry as Record<string, unknown>;
                  const id = this.optionalString(variant.id, 128);
                  if (!id) return [];
                  return [
                    {
                      id,
                      name: this.optionalString(variant.name, 256),
                      effort: this.optionalString(variant.effort, 128),
                      serviceTierId: this.optionalString(variant.serviceTierId, 128),
                      maxContextTokens: contextLimit(variant.maxContextTokens),
                    },
                  ];
                })
              : undefined;
          return [
            {
              id,
              ...(name ? { name } : {}),
              ...(group ? { group } : {}),
              ...(resolvedModel ? { resolvedModel } : {}),
              efforts: stringList(model.efforts),
              ...(defaultEffort ? { defaultEffort } : {}),
              serviceTierIds: tierIds(
                model.serviceTierIds ?? model.serviceTiers ?? model.service_tiers,
              ),
              ...(maxContextTokens ? { maxContextTokens } : {}),
              ...(variants?.length ? { variants } : {}),
            },
          ];
        })
      : [];
    const policies = Array.isArray(data.policies)
      ? data.policies.slice(0, 32).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const policy = value as Record<string, unknown>;
          const id = this.optionalString(policy.id, 128);
          if (!id) return [];
          const name = this.optionalString(policy.name, 256) ?? id;
          const description = this.optionalString(policy.description, 1024);
          return [{ id, name, ...(description ? { description } : {}) }];
        })
      : [];
    const rawServiceTiers = [
      ...(Array.isArray(data.serviceTiers) ? data.serviceTiers : []),
      ...(Array.isArray(data.models)
        ? data.models.flatMap((model) => {
            if (!model || typeof model !== "object") return [];
            const values = (model as Record<string, unknown>).serviceTiers;
            return Array.isArray(values) ? values : [];
          })
        : []),
    ];
    const serviceTiers = new Map(
      rawServiceTiers.slice(0, 256).flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const tier = value as Record<string, unknown>;
        const id = this.optionalString(tier.id, 128);
        if (!id) return [];
        const name = this.optionalString(tier.name, 256) ?? id;
        const description = this.optionalString(tier.description, 1024);
        return [[id, { id, name, ...(description ? { description } : {}) }] as const];
      }),
    );
    const codex = isCodexMode(data.executionMode);
    if (codex) {
      // The native settings catalog can list only IDs for a model's service tiers.
      const fastTierIds =
        provider?.models.fastTierIds ?? sessionProviderCapabilities("codex")?.models.fastTierIds;
      for (const id of new Set(models.flatMap((model) => model.serviceTierIds))) {
        if (serviceTiers.size >= 32) break;
        if (!serviceTiers.has(id))
          serviceTiers.set(id, { id, name: fastTierIds?.includes(id) ? "Fast" : id });
      }
    }
    const value = (source: Record<string, unknown> | undefined, key: string, fallback?: string) =>
      this.optionalString(source?.[key] ?? (fallback ? source?.[fallback] : undefined), 128);
    const projectValues = (current: Record<string, unknown> | undefined) => ({
      ...(value(current, "model", "modelId")
        ? { modelId: value(current, "model", "modelId") }
        : {}),
      ...(value(current, "effort") ? { effort: value(current, "effort") } : {}),
      ...(value(current, "mode") ? { mode: value(current, "mode") } : {}),
      ...(value(current, "policyId") ? { policyId: value(current, "policyId") } : {}),
      ...((data.executionMode === "devin-print"
        ? DEVIN_PERMISSION_MODES
        : data.executionMode === "acp-managed"
          ? ANTIGRAVITY_PERMISSION_MODES
          : data.executionMode === "claude-follower"
            ? [...CLAUDE_OBSERVED_PERMISSION_MODES]
            : [...CLAUDE_PERMISSION_MODES]
      ).includes(value(current, "permissionMode") ?? "")
        ? { permissionMode: value(current, "permissionMode") }
        : {}),
      ...(value(current, "serviceTier", "serviceTierId")
        ? { serviceTierId: value(current, "serviceTier", "serviceTierId") }
        : {}),
      ...((provider || devin || data.executionMode === "claude-follower") &&
      contextLimit(current?.maxContextTokens)
        ? { maxContextTokens: contextLimit(current?.maxContextTokens) }
        : {}),
    });
    const reason = this.optionalString(data.reason);
    const writeScope =
      data.executionMode === "codex-follower"
        ? this.optionalString(data.writeScope, 128)
        : undefined;
    const historicalModel =
      codex || data.executionMode === "claude-managed" || data.executionMode === "claude-follower"
        ? value(data.historicalSettings, "modelId", "model")
        : undefined;
    const historicalEffort = codex ? value(data.historicalSettings, "effort") : undefined;
    const liveUsage = this.projectUsage(usage);
    const historicalUsage =
      provider || codex || devin || data.executionMode === "claude-follower"
        ? this.projectUsage(data.historicalUsage)
        : undefined;
    const projectedUsage =
      historicalUsage?.historical && (!liveUsage?.available || liveUsage.usedTokens === undefined)
        ? historicalUsage
        : liveUsage;
    return {
      available: data.available === true,
      ...(provider ? { provider } : {}),
      ...(reason ? { reason } : {}),
      ...(writeScope ? { writeScope } : {}),
      ...(this.optionalString(data.executionMode, 64)
        ? { executionMode: this.optionalString(data.executionMode, 64) }
        : {}),
      ...(this.optionalString(data.status, 64)
        ? { status: this.optionalString(data.status, 64) }
        : {}),
      revision:
        Number.isSafeInteger(data.revision) && Number(data.revision) >= 0 ? data.revision : 0,
      current: projectValues(current),
      ...(selected ? { selected: projectValues(selected) } : {}),
      ...(historicalModel || historicalEffort
        ? {
            historicalSettings: {
              ...(historicalModel ? { modelId: historicalModel } : {}),
              ...(historicalEffort ? { effort: historicalEffort } : {}),
            },
          }
        : {}),
      ...(["pending", "confirmed", "unknown"].includes(String(applicationStatus))
        ? { applicationStatus }
        : {}),
      defaults: {
        ...(value(defaults, "model", "modelId")
          ? { modelId: value(defaults, "model", "modelId") }
          : {}),
        ...(value(defaults, "effort") ? { effort: value(defaults, "effort") } : {}),
        ...(value(defaults, "permissionMode")
          ? { permissionMode: value(defaults, "permissionMode") }
          : {}),
        ...(value(defaults, "serviceTier", "serviceTierId")
          ? { serviceTierId: value(defaults, "serviceTier", "serviceTierId") }
          : {}),
      },
      writable: {
        model: this.availability(writable?.model),
        effort: this.availability(writable?.effort),
        mode: this.availability(writable?.mode),
        policy: this.availability(writable?.policy),
        serviceTier: this.availability(writable?.serviceTier),
        ...(data.executionMode === "claude-managed" ||
        data.executionMode === "claude-follower" ||
        data.executionMode === "devin-print" ||
        data.executionMode === "acp-managed"
          ? { permissionMode: this.availability(writable?.permissionMode) }
          : {}),
        restoreDefaults:
          data.executionMode === "claude-managed" ||
          data.executionMode === "claude-follower" ||
          data.executionMode === "devin-print" ||
          data.executionMode === "acp-managed"
            ? this.availability(writable?.restoreDefaults)
            : {
                available:
                  this.availability(writable?.model).available &&
                  !!value(defaults, "model", "modelId"),
                ...(!value(defaults, "model", "modelId")
                  ? { reason: REMOTE_ERROR_CODES.defaultsUnavailable }
                  : {}),
              },
      },
      options: {
        models,
        policies,
        serviceTiers: [...serviceTiers.values()].slice(0, 32),
        ...(data.executionMode === "claude-managed" ||
        data.executionMode === "claude-follower" ||
        data.executionMode === "devin-print" ||
        data.executionMode === "acp-managed"
          ? {
              permissionModes: Array.isArray(data.permissionModes)
                ? data.permissionModes.slice(0, 4).flatMap((value) => {
                    if (!value || typeof value !== "object") return [];
                    const mode = value as Record<string, unknown>;
                    const ids =
                      data.executionMode === "devin-print"
                        ? DEVIN_PERMISSION_MODES
                        : data.executionMode === "acp-managed"
                          ? ANTIGRAVITY_PERMISSION_MODES
                          : [...CLAUDE_PERMISSION_MODES];
                    if (!ids.includes(String(mode.id))) return [];
                    return [
                      {
                        id: mode.id,
                        name: this.optionalString(mode.name, 128) ?? mode.id,
                        ...(typeof mode.available === "boolean"
                          ? { available: mode.available }
                          : {}),
                      },
                    ];
                  })
                : [],
            }
          : {}),
        collaborationModes: Array.isArray(data.collaborationModes)
          ? data.collaborationModes.slice(0, 8).flatMap((entry) => {
              if (!entry || typeof entry !== "object") return [];
              const item = entry as Record<string, unknown>;
              if (item.id !== "plan" && item.id !== "default") return [];
              return [{ id: item.id, name: this.optionalString(item.name, 128) ?? item.id }];
            })
          : [],
      },
      ...(projectedUsage ? { usage: projectedUsage } : {}),
    };
  }
  private projectGoal(raw: unknown, capabilities?: unknown) {
    const data = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const rawGoal =
      data.goal && typeof data.goal === "object"
        ? (data.goal as Record<string, unknown>)
        : undefined;
    const objective = this.optionalString(rawGoal?.objective, 16_000);
    const status = this.optionalString(rawGoal?.status, 64);
    const integer = (value: unknown) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    const actionSource =
      data.actions && typeof data.actions === "object"
        ? (data.actions as Record<string, unknown>)
        : {};
    const features =
      capabilities &&
      typeof capabilities === "object" &&
      (capabilities as Record<string, unknown>).features &&
      typeof (capabilities as Record<string, unknown>).features === "object"
        ? ((capabilities as Record<string, unknown>).features as Record<string, unknown>)
        : {};
    const reason = this.optionalString(data.reason);
    const rounds =
      rawGoal?.rounds && typeof rawGoal.rounds === "object"
        ? (rawGoal.rounds as Record<string, unknown>)
        : undefined;
    const detail = this.optionalString(rawGoal?.detail, 4096);
    return {
      available: data.available === true,
      ...(reason ? { reason } : {}),
      revision:
        Number.isSafeInteger(data.revision) && Number(data.revision) >= 0 ? data.revision : 0,
      // DeepSeek Harness bounds a goal by rounds rather than tokens.
      ...(data.budget === "rounds" ? { budget: "rounds" } : {}),
      ...(objective && status
        ? {
            goal: {
              objective,
              status,
              ...(integer(rawGoal?.tokenBudget) !== undefined
                ? { tokenBudget: integer(rawGoal?.tokenBudget) }
                : {}),
              ...(integer(rawGoal?.tokensUsed) !== undefined
                ? { tokensUsed: integer(rawGoal?.tokensUsed) }
                : {}),
              ...(integer(rawGoal?.elapsedMs) !== undefined
                ? { elapsedMs: integer(rawGoal?.elapsedMs) }
                : integer(rawGoal?.timeUsedSeconds) !== undefined
                  ? { elapsedMs: integer(rawGoal?.timeUsedSeconds)! * 1000 }
                  : {}),
              ...(integer(rounds?.used) !== undefined && integer(rounds?.limit) !== undefined
                ? { rounds: { used: integer(rounds?.used)!, limit: integer(rounds?.limit)! } }
                : {}),
              // Why a blocked goal stopped, in the agent's own words.
              ...(detail ? { detail } : {}),
            },
          }
        : {}),
      actions: {
        set: this.availability(actionSource.set ?? features["goal-set"]),
        pause: this.availability(actionSource.pause ?? features["goal-pause"]),
        resume: this.availability(actionSource.resume ?? features["goal-resume"]),
        clear: this.availability(actionSource.clear ?? features["goal-clear"]),
      },
    };
  }
  private safeRelativePath(value: unknown) {
    if (typeof value !== "string" || !value || value.length > 2048 || isAbsolute(value)) return;
    if (value.includes("\\") || value.includes("\0")) return;
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return;
    return value;
  }
  private async contextResources(
    sessionId: string,
    device: WebDevice,
    workspaceId: string,
    directoryId?: string,
    reserved = false,
  ) {
    const raw = (await this.runtime(
      { operation: "resources", sessionId },
      undefined,
      reserved,
    )) as Record<string, unknown>;
    const rawRevision =
      Number.isSafeInteger(raw?.revision) && Number(raw.revision) >= 0
        ? Number(raw.revision)
        : undefined;
    const revision =
      rawRevision ??
      Number(
        (
          (await this.runtime(
            { operation: "live", sessionId, experimentalEnabled: true },
            undefined,
            reserved,
          )) as { revision?: unknown }
        ).revision,
      );
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.stateUnavailable);
    return this.projectContextResources(
      { deviceId: device.id, sessionId, workspaceId },
      raw,
      revision,
      directoryId,
    );
  }
  private rememberContextResource(id: string, resource: RememberedContextResource) {
    // Kept in order of listing; the oldest make way instead of refusing new listings.
    this.contextArtifactRefs.delete(id);
    this.contextArtifactRefs.set(id, resource);
    for (const oldest of this.contextArtifactRefs.keys()) {
      if (this.contextArtifactRefs.size <= CONTEXT_ARTIFACT_LIMIT) break;
      this.contextArtifactRefs.delete(oldest);
    }
  }
  private async projectContextResources(
    scope: ContextResourceScope,
    raw: Record<string, unknown>,
    revision: number,
    directoryId?: string,
    draftAgent?: ManagedAgent,
  ) {
    const { deviceId, sessionId, workspaceId } = scope;
    const resources: {
      id: string;
      kind: ContextResourceReference["kind"];
      name: string;
      description?: string;
      navigationId?: string;
      available: boolean;
      reason?: string;
    }[] = [];
    const references = new Map<string, ContextResourceReference>();
    const seenIds = new Set<string>();
    const add = (bucket: string, defaultKind: ContextResourceReference["kind"]) => {
      const values =
        raw && Array.isArray(raw[bucket]) ? (raw[bucket] as unknown[]).slice(0, 512) : [];
      for (const value of values) {
        if (!value || typeof value !== "object") continue;
        const item = value as Record<string, unknown>;
        const kind =
          bucket === "contextReferences" && (item.kind === "file" || item.kind === "directory")
            ? item.kind
            : defaultKind;
        const nativeId = this.optionalString(item.id, 512);
        const relativePath = this.safeRelativePath(item.relativePath ?? item.relative_path);
        if ((kind === "file" || kind === "directory") && !nativeId && !relativePath) continue;
        if (kind !== "file" && kind !== "directory" && !nativeId) continue;
        const reference: ContextResourceReference = {
          kind,
          ...(nativeId ? { id: nativeId } : {}),
          ...(relativePath ? { relativePath } : {}),
        };
        const id = digest(`${this.bootId}|${deviceId}|${sessionId}|${JSON.stringify(reference)}`);
        if (seenIds.has(id)) continue;
        const name =
          this.optionalString(item.name, 256) ?? relativePath?.split("/").at(-1) ?? nativeId;
        if (!name) continue;
        const description = this.optionalString(item.description, 1024);
        const availability = this.availability(
          item.available === undefined && item.enabled === undefined
            ? true
            : {
                available: item.available ?? item.enabled,
                reason: item.reason ?? (item.enabled === false ? "resource_disabled" : undefined),
              },
        );
        seenIds.add(id);
        if (availability.available) {
          references.set(id, reference);
          if (draftAgent) this.rememberContextResource(id, { ...scope, draftAgent, reference });
        }
        resources.push({
          id,
          kind,
          name,
          ...(description ? { description } : {}),
          ...availability,
        });
      }
    };
    add("skills", "skill");
    add("plugins", "plugin");
    add("apps", "app");
    if (raw.executionMode !== "claude-managed") add("contextReferences", "file");
    let directory:
      | {
          directoryId: string;
          parentId?: string;
          entries: { id: string; name: string; kind: "file" | "directory"; revision: string }[];
        }
      | undefined;
    const artifacts = this.artifactsFor(deviceId);
    if (artifacts) {
      try {
        directory = await artifacts.list(scope, directoryId);
      } catch (error) {
        if (error instanceof ArtifactError) throw new HttpError(error.status, error.code);
        throw error;
      }
      for (const entry of directory.entries) {
        const id = digest(
          `${this.bootId}|${deviceId}|${sessionId}|${workspaceId}|${entry.id}|${entry.revision}`,
        );
        this.rememberContextResource(id, {
          ...scope,
          ...(draftAgent ? { draftAgent } : {}),
          artifactId: entry.id,
          revision: entry.revision,
        });
        resources.push({
          id,
          kind: entry.kind,
          name: entry.name,
          ...(entry.kind === "directory" ? { navigationId: entry.id } : {}),
          available: true,
        });
      }
    }
    return {
      response: {
        sessionId,
        revision,
        resources,
        ...(directory
          ? {
              directoryId: directory.directoryId,
              ...(directory.parentId ? { parentId: directory.parentId } : {}),
            }
          : {}),
      },
      references,
    };
  }
  private async newSessionResources(hash: string, url: URL) {
    if (this.options.acceptanceSessionId)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionControlNotAllowed);
    if (url.searchParams.has("sessionId"))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
    const device = this.fullAccess(hash, "advancedControl");
    this.grant(hash, REMOTE_CAPABILITIES.device.manage);
    this.grant(hash, REMOTE_CAPABILITIES.device.files);
    const workspaceId = this.field(url.searchParams.get("workspaceId"));
    const agent = managedAgentOf(url.searchParams.get("agent"));
    if (!agent || !sessionProviderCapabilities(agent)?.create.workspaceResources)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedProviderResources);
    if (!(await this.workspaceAllowed(workspaceId, device)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const bootId = this.bootId;
    const directoryId = url.searchParams.get("directoryId") ?? undefined;
    if (directoryId && directoryId.length > 128)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidDirectoryId);
    const raw = (await this.runtime({
      operation: "provider-workspace-resources",
      agent,
      workspaceId,
    }).catch(() => ({}))) as Record<string, unknown>;
    const { response } = await this.projectContextResources(
      { deviceId: device.id, workspaceId, sessionId: `draft:${agent}:${workspaceId}` },
      raw ?? {},
      0,
      directoryId,
      agent,
    );
    if (!(await this.workspaceAllowed(workspaceId, device)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    if (this.bootId !== bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (this.fullAccess(hash, "advancedControl").id !== device.id)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    this.grant(hash, REMOTE_CAPABILITIES.device.manage);
    this.grant(hash, REMOTE_CAPABILITIES.device.files);
    const { sessionId: _scope, ...resources } = response;
    return { ...resources, workspaceId };
  }
  private async resolveContextResources(
    sessionId: string,
    hash: string,
    value: unknown,
    expectedRevision: unknown,
    reserved = false,
    draftAgent?: ManagedAgent,
  ) {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.length > SESSION_RESOURCE_LIMIT ||
      value.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(value).size !== value.length
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidResourceIds);
    const device = this.fullAccess(hash);
    const artifacts = this.artifactsFor(device.id);
    const workspaceId = await this.codexScope(sessionId, hash, reserved, false);
    const { response, references } = await this.contextResources(
      sessionId,
      device,
      workspaceId,
      undefined,
      reserved,
    );
    if (response.revision !== expectedRevision)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleState);
    const resolved: ContextResourceReference[] = [];
    for (const id of value) {
      const native = references.get(id);
      if (native) {
        resolved.push(native);
        continue;
      }
      const artifact = this.contextArtifactRefs.get(id);
      if (
        !artifact ||
        artifact.deviceId !== device.id ||
        artifact.workspaceId !== workspaceId ||
        (artifact.draftAgent
          ? artifact.draftAgent !== draftAgent
          : artifact.sessionId !== sessionId)
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.resourceUnavailable);
      if (artifact.draftAgent) {
        this.fullAccess(hash, "advancedControl");
        this.grant(hash, REMOTE_CAPABILITIES.device.files);
      }
      if ("reference" in artifact) {
        const { reference } = artifact;
        if (
          ![...references.values()].some(
            (current) =>
              current.kind === reference.kind &&
              current.id === reference.id &&
              current.relativePath === reference.relativePath,
          )
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.resourceUnavailable);
        resolved.push(reference);
        continue;
      }
      if (!artifacts) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.resourceUnavailable);
      try {
        const reference = await artifacts.resolveContextReference(
          { deviceId: device.id, workspaceId, sessionId: artifact.sessionId },
          artifact.artifactId,
          artifact.revision,
        );
        resolved.push({ kind: reference.kind, relativePath: reference.relativePath });
      } catch (error) {
        if (error instanceof ArtifactError) throw new HttpError(error.status, error.code);
        throw error;
      }
    }
    return resolved;
  }
  private async codexScope(sessionId: string, hash: string, reserved = false, codexOnly = true) {
    return (await this.sessionScope(sessionId, hash, reserved, codexOnly)).workspace_id;
  }
  private async sessionScope(
    sessionId: string,
    hash: string,
    reserved: boolean,
    codexOnly: boolean,
  ) {
    const session = await this.catalogSession(sessionId, reserved);
    const device = this.grant(hash);
    if (
      !session ||
      (codexOnly && session.agent !== "codex") ||
      (!(session.workspaceRegistered === true && this.isFullAccess(device)) &&
        !(await this.workspaceAllowed(session.workspace_id, device, reserved)))
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    return session;
  }
  private async lanCodexScopeAllowed(sessionId: string, workspaceId: string, reserved = false) {
    // LAN has no workspace allowlist; retain its existing registered-session
    // boundary without granting file access or managed lifecycle permissions.
    const session = await this.catalogSession(sessionId, reserved);
    if (session?.agent !== "codex" || session.workspace_id !== workspaceId) return false;
    return (await this.registeredWorkspaces(reserved)).some((row) => row.id === workspaceId);
  }
  private async queueScope(sessionId: string, hash: string, reserved = false, codexOnly = true) {
    if (this.options.mode !== "lan") return this.codexScope(sessionId, hash, reserved, codexOnly);
    // Use the same registered Codex scope as LAN send. LAN has no workspace allowlist.
    const session = await this.catalogSession(sessionId, reserved);
    const workspaceId = session?.workspace_id;
    if (
      session?.agent !== "codex" ||
      !workspaceId ||
      !(await this.registeredWorkspaces(reserved)).some(({ id }) => id === workspaceId)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    this.grant(hash, REMOTE_CAPABILITIES.device.send);
    return workspaceId;
  }

  private async ownerWaitQueue(sessionId: string, workspaceId: string, reserved = false) {
    const result = (await this.runtime(
      { operation: "queue-list", sessionId, ownerWaitOnly: true },
      undefined,
      reserved,
    )) as { data?: QueueEntry[] };
    return (result.data ?? []).filter((row) => isOwnerWaitQueueEntry(row, workspaceId));
  }

  private async readSessionCapabilities(
    res: ConversationResponse,
    hash: string,
    url: URL,
    codexOnly: boolean,
    operation: "capabilities" | "inspect" = "capabilities",
  ) {
    const sessionId = this.field(url.searchParams.get("sessionId"));
    const permission = operation === "inspect" ? "manage" : undefined;
    const device = this.grant(hash, permission);
    const session = await this.catalogSession(sessionId);
    if (!session || (codexOnly && session.agent !== "codex"))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const currentDevice = this.grant(hash, permission);
    const workspaceAllowed =
      this.options.mode === "lan" && session.agent === "codex"
        ? await this.lanCodexScopeAllowed(sessionId, session.workspace_id)
        : await this.workspaceAllowed(session.workspace_id, currentDevice);
    if (!workspaceAllowed && (session.agent !== "codex" || this.isFullAccess(currentDevice)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const request = {
      operation,
      sessionId,
      experimentalEnabled: this.controlsEnabled(sessionId, this.grant(hash, permission)),
    };
    const claude = session.agent === "claude-code";
    const claudeRequest = this.claudeSessionRequest;
    if (claude && !claudeRequest)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedHost);
    const result = await this.runtime(request, claude ? claudeRequest!(request) : undefined);
    const latest = this.grant(hash, permission);
    if (latest.id !== device.id) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    const stillAllowed =
      this.options.mode === "lan" && session.agent === "codex"
        ? await this.lanCodexScopeAllowed(sessionId, session.workspace_id)
        : await this.workspaceAllowed(session.workspace_id, latest);
    if (
      !stillAllowed &&
      (session.agent !== "codex" || operation === "inspect" || this.isFullAccess(latest))
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    if (operation === "inspect") return this.json(res, 200, result);
    const verified =
      session.agent === "deepseek-harness"
        ? this.options.verifiedDshFollower === true
        : session.agent === "devin"
          ? this.options.verifiedDevinManaged === true
          : session.agent === "antigravity" || this.options.verifiedClaudeManaged === true;
    let lanOwnerWait: QueueEntry | undefined;
    if (
      this.options.mode === "lan" &&
      session.agent === "codex" &&
      stillAllowed &&
      latest.send &&
      this.controlsEnabled(sessionId, latest) &&
      snapshotField(result, "ownerWaitQueue") === true
    ) {
      lanOwnerWait = (await this.ownerWaitQueue(sessionId, session.workspace_id)).find(
        (item) => item.ownerWaitDeviceId === latest.id,
      );
      if ((await this.queueScope(sessionId, hash)) !== session.workspace_id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      if (latest.id !== this.grant(hash, REMOTE_CAPABILITIES.device.send).id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    }
    const projected =
      session.agent === "codex"
        ? this.projectCapabilities(result, latest, stillAllowed, sessionId, lanOwnerWait)
        : this.projectClaudeCapabilities(result, latest, sessionId, verified);
    const planModes = sessionProviderDeclaration(session.agent)?.planProgress?.executionModes;
    const mode = snapshotField(result, "executionMode");
    return this.json(res, 200, {
      ...projected,
      ...(stillAllowed && typeof mode === "string" && planModes?.includes(mode)
        ? {
            planProgress: {
              live:
                session.agent !== "antigravity" ||
                !this.options.disabledSessionProviders?.antigravity,
            },
          }
        : {}),
    });
  }

  private codexPermission(
    operation: string,
  ): "send" | "approve" | "manage" | "attachments" | "advancedControl" | "organize" | "settings" {
    if (operation === "approve") return "approve";
    if (
      operation === "stop" ||
      operation === "answer" ||
      operation === "terminals-clean" ||
      // Stops AgentKib sending in the device's name after a usage limit; no more than sending.
      operation === "usage-limit-cancel" ||
      operation === "usage-limit-continue"
    )
      return "send";
    if (operation === "attachments") return "attachments";
    if (["resume", "fork"].includes(operation)) return "manage";
    if (["rename", "archive", "unarchive", "delete"].includes(operation)) return "organize";
    if (operation === "settings" || operation === "open-model-picker") return "settings";
    // Compaction is a turn the user starts, as a message is.
    return operation === "send" || operation === "inspect" || operation === "compact"
      ? "send"
      : "advancedControl";
  }
  /** Also projects a connected DeepSeek Harness, whose features follow the same device roles. */
  private projectClaudeCapabilities(
    result: unknown,
    device: WebDevice,
    sessionId: string,
    verified = this.options.verifiedClaudeManaged === true,
  ) {
    const data = result as {
      executionMode?: unknown;
      features?: Record<string, { available: boolean; reason?: string }>;
      commands?: unknown;
    };
    const roles: Record<string, keyof WebDevice> = {
      send: "send",
      stop: "send",
      answer: "send",
      // Stops AgentKib sending in the device's name after a usage limit; no more than sending.
      "usage-limit-cancel": "send",
      "usage-limit-continue": "send",
      approve: "approve",
      release: "manage",
      reconcile: "manage",
      inspect: "manage",
      files: "files",
      attachments: "attachments",
      usage: "advancedControl",
      "settings-state": "advancedControl",
      settings: "settings",
      "open-model-picker": "settings",
      "adopt-terminal": "advancedControl",
      "handover-terminal": "advancedControl",
      context: "advancedControl",
      resources: "advancedControl",
      goal: "advancedControl",
      "goal-draft": "advancedControl",
      "goal-set": "advancedControl",
      "goal-pause": "advancedControl",
      "goal-resume": "advancedControl",
      "goal-clear": "advancedControl",
      "queue-list": "advancedControl",
      "queue-add": "advancedControl",
      "queue-update": "advancedControl",
      "queue-delete": "advancedControl",
      "queue-steer": "advancedControl",
      "queue-reorder": "advancedControl",
      "queue-pause": "advancedControl",
      "queue-resume": "advancedControl",
      steer: "advancedControl",
      fork: "manage",
      rename: "organize",
      archive: "organize",
      unarchive: "organize",
      delete: "organize",
      // As for Codex: a compaction is a turn the user starts, as a message is.
      compact: "send",
    };
    // The command catalog serves composing messages; clients filter it per device.
    const { commands, ...rest } = data;
    return {
      ...rest,
      ...(device.send === true && Array.isArray(commands) ? { commands } : {}),
      features: Object.fromEntries(
        Object.entries(data.features ?? {}).map(([operation, feature]) => {
          const permission = roles[operation];
          const advanced = ![
            "send",
            "stop",
            "answer",
            "approve",
            "release",
            "reconcile",
            "inspect",
          ].includes(operation);
          const transport = this.options.mode !== "lan" || !advanced;
          const execution =
            [
              "files",
              "inspect",
              "usage",
              "settings-state",
              "goal",
              "queue-list",
              "context",
              "resources",
            ].includes(operation) ||
            (verified && this.controlsEnabled(sessionId, device));
          const allowed =
            permission &&
            device[permission] === true &&
            (!isSerialQueueMode(data.executionMode) ||
              !serialQueueRequiresSend(operation) ||
              device.send === true) &&
            ((!["usage", "settings-state", "goal", "context", "resources"].includes(operation) &&
              !operation.startsWith("goal-")) ||
              this.isFullAccess(device)) &&
            (operation !== "fork" || device.organize === true) &&
            transport &&
            execution &&
            (operation !== "open-model-picker" || data.executionMode === "claude-follower") &&
            (operation !== "adopt-terminal" || device.id === "desktop-local") &&
            (operation !== "handover-terminal" || device.send === true) &&
            (!["attachments", "queue-steer"].includes(operation) || device.send === true) &&
            (operation !== "goal-draft" ||
              (data.executionMode === "claude-managed" && device.send === true));
          return [
            operation,
            allowed
              ? feature
              : {
                  available: false,
                  reason: transport ? REMOTE_ERROR_CODES.permissionDenied : "same_origin_required",
                },
          ];
        }),
      ),
    };
  }
  private projectCapabilities(
    result: unknown,
    device: WebDevice,
    workspaceAllowed = true,
    sessionId?: string,
    lanOwnerWait?: QueueEntry,
  ) {
    const { ownerWaitQueue: _ownerWaitQueue, ...data } = result as {
      features?: Record<string, { available: boolean; reason?: string }>;
      [key: string]: unknown;
    };
    const projected = Object.fromEntries(
      Object.entries(data.features ?? {}).map(([operation, feature]) => {
        const fullOnly =
          ["context", "resources", "settings-state", "usage", "goal"].includes(operation) ||
          operation.startsWith("goal-");
        const lanWaitFeature =
          this.options.mode === "lan" &&
          lanOwnerWait !== undefined &&
          (operation === "queue-list" ||
            (operation === "queue-delete" && canDeleteOwnerWait(lanOwnerWait, device.id)));
        const permission = lanWaitFeature ? "send" : this.codexPermission(operation);
        const allowed =
          isCodexMode(data.executionMode) &&
          (operation === "usage" || this.controlsEnabled(sessionId, device)) &&
          device[permission] === true &&
          (!fullOnly || this.isFullAccess(device)) &&
          (operation !== "fork" || device.organize === true) &&
          (this.options.mode !== "lan" || operation === "send" || lanWaitFeature) &&
          workspaceAllowed;
        return [
          operation,
          allowed ? feature : { available: false, reason: REMOTE_ERROR_CODES.permissionDenied },
        ];
      }),
    );
    return {
      ...data,
      features: {
        ...projected,
        ...(projected.resources && !projected.context ? { context: projected.resources } : {}),
      },
    };
  }
  private async admitSessionAction(
    res: ConversationResponse,
    hash: string,
    operation: string,
    body: Record<string, unknown>,
    control: ActionOutcome,
    generic = false,
  ) {
    const actions = generic ? REMOTE_MANAGED_ACTION_OPERATIONS : REMOTE_LEGACY_CODEX.postOperations;
    if (!actions.includes(operation)) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    const opensPicker = operation === "open-model-picker";
    const settingsControl = operation === "settings" || opensPicker;
    if (
      opensPicker &&
      Object.keys(body).some(
        (field) =>
          !["operation", "agent", "bootId", "expectedRevision", "sessionId", "requestId"].includes(
            field,
          ),
      )
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
    const lanQueueDelete = this.options.mode === "lan" && !generic && operation === "queue-delete";
    if (this.options.mode === "lan" && !lanQueueDelete)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.routeDenied,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    if (operation === "adopt-terminal" && hash !== "desktop-local")
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.ownerRequired);
    if (operation === "handover-terminal") {
      if (
        body.handoffConfirmed !== true ||
        Object.keys(body).some(
          (key) =>
            ![
              "operation",
              "agent",
              "sessionId",
              "requestId",
              "expectedRevision",
              "bootId",
              "turnId",
              "handoffConfirmed",
            ].includes(key),
        )
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
      this.grant(hash, REMOTE_CAPABILITIES.device.send);
    }
    const permission = lanQueueDelete ? "send" : this.codexPermission(operation);
    const device = this.grant(hash, permission);
    if (operation.startsWith("goal-")) this.fullAccess(hash);
    if (operation === "fork") this.grant(hash, REMOTE_CAPABILITIES.device.organize);
    const sessionId = this.field(body.sessionId);
    if (lanQueueDelete) await this.queueScope(sessionId, hash);
    else if (!generic || this.isFullAccess(device))
      await this.codexScope(sessionId, hash, false, !generic);
    if (!this.controlsEnabled(sessionId, device))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionControlNotAllowed);

    if (operation === "inspect") return this.inspectSessionAction(res, hash, sessionId, device);

    const requestId = this.field(body.requestId, 128);
    if (!/^[a-f0-9-]{36}$/i.test(requestId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidRequestId);
    if (body.historyReferences !== undefined && !["steer", "queue-add"].includes(operation))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.historyReferencesNotSupported);
    const replay = await this.readSessionActionReceipt({
      hash,
      operation,
      body,
      control,
      permission,
      sessionId,
      requestId,
      opensPicker,
      generic,
    });
    if ("ack" in replay) return this.json(res, 200, projectQueueActionAck(replay.ack));
    if (body.bootId !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (
      operation !== "resume" &&
      (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidRevision);
    if (this.requests.has(requestId) || this.outcomeFences.blocks(sessionId, operation)) {
      control.priorUncertain = this.requests.has(requestId);
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.outcomeUnknown);
    }
    if (this.admission || this.active.has(sessionId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    const workspaceId = lanQueueDelete
      ? await this.queueScope(sessionId, hash)
      : await this.codexScope(sessionId, hash, false, !generic);
    if (this.requests.has(requestId) || this.outcomeFences.blocks(sessionId, operation)) {
      control.priorUncertain = this.requests.has(requestId);
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.outcomeUnknown);
    }
    if (this.admission || this.active.has(sessionId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    const admission: ActionAdmission = {
      hash,
      operation,
      body,
      control,
      permission,
      device,
      sessionId,
      requestId,
      workspaceId,
      legacyCodex: !generic,
      opensPicker,
      settingsControl,
      ...replay,
    };
    if (!settingsControl) this.admission = true;
    this.active.add(sessionId);
    const dispatch: ActionDispatch = { dispatched: false };
    try {
      const prepared = await this.prepareSessionAction(admission, dispatch);
      return await this.dispatchSessionAction(
        res,
        admission,
        dispatch,
        prepared.params,
        prepared.requiresSend,
      );
    } finally {
      if (!dispatch.dispatched) {
        this.active.delete(sessionId);
        if (!settingsControl) this.admission = false;
        if (dispatch.newlyPinnedDevice)
          await this.attachmentStore.settle(dispatch.newlyPinnedDevice, sessionId, requestId);
      }
    }
  }

  private async inspectSessionAction(
    res: ConversationResponse,
    hash: string,
    sessionId: string,
    device: WebDevice,
  ) {
    const operation = "inspect";
    const permission = this.codexPermission(operation);
    const pendingRequests = [...(this.outcomeFences.forSession(sessionId) ?? [])];
    const result = (await this.runtime({
      operation,
      sessionId,
      deviceId: device.id,
      experimentalEnabled: true,
    })) as { reconciled?: boolean; context?: unknown };
    this.grant(hash, permission);
    if (result.reconciled === true && !this.active.has(sessionId))
      for (const entry of pendingRequests) this.settleOutcome(sessionId, entry.requestId);
    const catalog = (await this.scopeCatalog()) as {
      sessions: { id: string; workspace_id: string }[];
    };
    this.grant(hash, permission);
    const workspaceId = catalog.sessions.find((item) => item.id === sessionId)?.workspace_id;
    return this.json(res, 200, {
      ...result,
      ...(!workspaceId || !(await this.workspaceAllowed(workspaceId, device))
        ? { context: { available: false, reason: REMOTE_ERROR_CODES.workspaceNotAuthorized } }
        : {}),
    });
  }

  private async readSessionActionReceipt(
    input: Pick<
      ActionAdmission,
      | "hash"
      | "operation"
      | "body"
      | "control"
      | "permission"
      | "sessionId"
      | "requestId"
      | "opensPicker"
    > & { generic: boolean },
  ): Promise<{ ack: unknown } | Pick<ActionAdmission, "prior" | "publicInputHash">> {
    const {
      hash,
      operation,
      body,
      control,
      permission,
      sessionId,
      requestId,
      opensPicker,
      generic,
    } = input;
    const prior = await this.controlReceipt(requestId, this.grant(hash, permission).id, control);
    this.grant(hash, permission);
    const publicInputHash = generic ? managedActionInputHash(operation, body) : undefined;
    if (generic && prior?.found === true && typeof prior.publicInputHash === "string") {
      await this.codexScope(sessionId, hash, false, false);
      if (body.attachmentIds !== undefined)
        this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
      this.grant(hash, permission);
      const serialQueue = isSerialQueueMode(prior.executionMode) && operation.startsWith("queue-");
      if (serialQueue && serialQueueRequiresSend(operation))
        this.grant(hash, REMOTE_CAPABILITIES.device.send);
      if (
        prior.sessionId !== sessionId ||
        prior.operation !== operation ||
        prior.publicInputHash !== publicInputHash
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.requestIdConflict);
      if (
        opensPicker &&
        (prior.requestId !== requestId ||
          (prior.status === "accepted" &&
            correlatedControlOutcome(prior.ack, requestId, sessionId, prior.runtimeBootId) !==
              "accepted"))
      ) {
        control.priorUncertain = true;
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseUnconfirmed,
          REMOTE_ERROR_CODES.outcomeUnknown,
        );
      }
      if (prior.status === "accepted" && prior.ack && typeof prior.ack === "object") {
        control.priorUncertain = false;
        if (serialQueue) this.settleOutcome(sessionId, requestId);
        return { ack: prior.ack };
      }
      control.priorUncertain = prior.status !== REMOTE_CONTROL_OUTCOMES.notDispatched;
      throw new HttpError(
        409,
        control.priorUncertain
          ? REMOTE_ERROR_CODES.outcomeUnknown
          : REMOTE_ERROR_CODES.controlPreflightRejected,
        undefined,
        refusedReceiptReason(prior, requestId, sessionId),
      );
    }
    if (body.historyReferences !== undefined || prior?.historyInputHash)
      await this.codexScope(sessionId, hash, false, !generic);
    const replay = this.historyReplay(prior, body, operation, control);
    if (replay !== undefined) return { ack: replay };
    return { prior, publicInputHash };
  }

  private async validateSessionAction(
    admission: ActionAdmission,
    executionMode?: string,
    settings?: NonNullable<HostControlValidationCall["request"]["settings"]>,
  ): Promise<ProviderValidation> {
    const { hash, permission, sessionId, operation, legacyCodex } = admission;
    const call: HostControlValidationCall = {
      sessionId,
      executionMode,
      request: { operation, legacyCodex, ...(settings ? { settings } : {}) },
      verified: {
        "claude-code": this.options.verifiedClaudeManaged === true,
        devin: this.options.verifiedDevinManaged === true,
        antigravity: this.options.verifiedAntigravityManaged === true,
      },
      fullAccess: this.isFullAccess(settings ? this.grant(hash, permission) : admission.device),
    };
    const result = this.options.sessionRequest
      ? ((await this.runtime(
          { operation: "provider-validate-control", call },
          undefined,
          true,
        )) as HostControlValidationResult)
      : validateEmbeddedControl(call);
    if ("error" in result) throw new HttpError(result.status, result.error);
    // A device can lose full access while the Provider is checking its settings.
    if (result.result.requiresFullAccess) this.fullAccess(hash);
    return result.result;
  }

  private async terminalAttachmentInput(
    hash: string,
    workspaceId: string,
    input: {
      deviceId: string;
      sessionId: string;
      ids: unknown;
      text: string;
      requestId: string;
    },
  ) {
    // Resolve the bound session's own root, which can be below the registered workspace.
    const context = (await this.runtime(
      { operation: "context", sessionId: input.sessionId, experimentalEnabled: true },
      undefined,
      true,
    )) as { available?: boolean; cwd?: string; executionMode?: string };
    if (
      context?.available !== true ||
      context.executionMode !== "claude-follower" ||
      typeof context.cwd !== "string" ||
      !isAbsolute(context.cwd)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsUnavailable);
    const workspace = (await this.registeredWorkspaces(true)).find(({ id }) => id === workspaceId);
    if (!workspace) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const [root, cwd] = await Promise.all([
      realpath(workspace.path).catch(() => undefined),
      realpath(context.cwd).catch(() => undefined),
    ]);
    if (!root || !cwd || cwd !== context.cwd)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsUnavailable);
    const within = relative(root, cwd);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const device = this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
    if (
      device.id !== input.deviceId ||
      !(await this.workspaceAllowed(workspaceId, device, true)) ||
      device !== this.grant(hash, REMOTE_CAPABILITIES.device.attachments)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    return [
      await this.attachmentStore.inputForTerminal(
        input.deviceId,
        input.sessionId,
        input.ids,
        input.text,
        cwd,
        input.requestId,
      ),
    ];
  }

  private async prepareSessionAction(admission: ActionAdmission, dispatch: ActionDispatch) {
    const {
      hash,
      operation,
      body,
      permission,
      device,
      sessionId,
      requestId,
      legacyCodex,
      prior,
      publicInputHash,
    } = admission;
    const capabilities = (await this.runtime(
      { operation: "capabilities", sessionId, experimentalEnabled: true },
      undefined,
      true,
    )) as {
      features?: Record<string, AttachmentAvailability>;
      executionMode?: string;
      ownerWaitQueue?: boolean;
    };
    // Wait entries belong to AgentKib, independent of the native session's current owner.
    // Never fall through to a native deletion when a LAN client or a follower cancels one.
    const onlyWaitCanBeDeleted =
      this.options.mode === "lan" ||
      (capabilities.executionMode === "codex-follower" && capabilities.ownerWaitQueue === true);
    const queuedWait =
      operation === "queue-delete" &&
      isCodexMode(capabilities.executionMode) &&
      (onlyWaitCanBeDeleted || capabilities.ownerWaitQueue === true)
        ? (await this.ownerWaitQueue(sessionId, admission.workspaceId, true)).find(
            (item) => item.id === body.queuedSubmissionId,
          )
        : undefined;
    const ownerWaitOnly = operation === "queue-delete" && (onlyWaitCanBeDeleted || !!queuedWait);
    if (ownerWaitOnly && (!queuedWait || !canDeleteOwnerWait(queuedWait, device.id)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueItemUnavailable);
    const policy: ProviderValidation = ownerWaitOnly
      ? { available: true }
      : await this.validateSessionAction(admission, capabilities.executionMode);
    if (policy.requiresSend) this.grant(hash, REMOTE_CAPABILITIES.device.send);
    if (
      policy.textOnlyQueue &&
      (body.attachmentIds !== undefined || body.historyReferences !== undefined)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.capabilityUnavailable);
    if (!policy.available || capabilities.features?.[operation]?.available !== true)
      throw new HttpError(
        409,
        capabilities.features?.[operation]?.reason === REMOTE_ERROR_CODES.sessionCompacting
          ? REMOTE_ERROR_CODES.sessionCompacting
          : continuationPreflightReason(
              capabilities.features?.[operation]?.reason,
              REMOTE_ERROR_CODES.capabilityUnavailable,
            ),
      );
    const snapshot = (await this.runtime(
      { operation: "live", sessionId, experimentalEnabled: true },
      undefined,
      true,
    )) as { revision: number; runtimeBootId: string; status?: string; executionMode?: string };
    dispatch.executionMode = snapshot.executionMode;
    if (
      (operation !== "resume" && snapshot.revision !== body.expectedRevision) ||
      !snapshot.runtimeBootId
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleState);
    if (
      policy.idleExecutionMode &&
      (snapshot.status !== "idle" || snapshot.executionMode !== policy.idleExecutionMode)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleState);
    if (operation === "queue-add" && legacyCodex && snapshot.status !== "running")
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueRequiresRunningTurn);
    const params: Record<string, unknown> & { runtimeBootId: string } = {
      operation,
      sessionId,
      requestId,
      deviceId: device.id,
      expectedRevision: body.expectedRevision,
      runtimeBootId: snapshot.runtimeBootId,
      experimentalEnabled: true,
      ...(policy.publicReceipt ? { publicInputHash } : {}),
      ...(ownerWaitOnly ? { ownerWaitOnly: true } : {}),
    };
    if (operation === "handover-terminal") {
      params.confirmed = true;
      if (body.turnId !== undefined) params.turnId = this.field(body.turnId);
    }
    // Every operation has an explicit public-field projection. Paths and raw RPC input never pass through.
    if (["steer", "queue-add", "queue-update"].includes(operation)) {
      const rawText = body.text === undefined ? "" : body.text;
      if (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAttachments);
      const hasAttachments = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
      if (operation === "queue-update" && hasAttachments)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueAttachmentsEditUnsupported);
      if (
        typeof rawText !== "string" ||
        rawText.length > 16000 ||
        Buffer.byteLength(rawText) > 16384 ||
        (!rawText.trim() && !hasAttachments && body.historyReferences === undefined)
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidText);
      let text: string = rawText;
      if (body.historyReferences !== undefined) {
        const history = await this.resolveHistoryInput(body, hash, operation, true);
        text = history.text;
        dispatch.historyScopeKey = history.scopeKey;
        params.historyReferences = history.references;
        params.historyInputHash = history.inputHash;
        if (!text.trim() && !hasAttachments)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidText);
      }
      params.text = text;
      // A queued edit stays a message; DSH runs only a newly sent line as a command.
      if (policy.useCommandAccess)
        params.commandAccess = this.dshCommandAccess(this.grant(hash, permission));
      if (hasAttachments) {
        this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
        const format = attachmentInputFormat(
          policy.inputFormat,
          capabilities.features?.attachments,
        );
        if (capabilities.features?.attachments?.available !== true || !format)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsUnavailable);
        if (format === "claude-terminal") {
          if (snapshot.executionMode !== "claude-follower")
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleState);
          const alreadyPinned = (await this.attachmentStore.pendingRequests(sessionId)).some(
            (item) => item.deviceId === device.id && item.requestId === requestId,
          );
          params.input = await this.terminalAttachmentInput(hash, admission.workspaceId, {
            deviceId: device.id,
            sessionId,
            ids: body.attachmentIds,
            text,
            requestId,
          });
          dispatch.terminalAttachments = true;
          if (!alreadyPinned) dispatch.newlyPinnedDevice = device.id;
        } else if (format === "claude") {
          params.input = await this.attachmentStore.inputForAgent(
            device.id,
            sessionId,
            body.attachmentIds,
            text,
            format,
            requestId,
          );
          if (prior?.found !== true) dispatch.newlyPinnedDevice = device.id;
        } else {
          params.input = await this.attachmentStore.input(
            device.id,
            sessionId,
            body.attachmentIds,
            text,
            format,
          );
        }
        delete params.text;
      }
    }
    if (policy.queueItem) {
      const queued = (await this.runtime(
        { operation: "queue-list", sessionId, limit: 100 },
        undefined,
        true,
      )) as {
        data?: QueueEntry[];
      };
      if (
        (queued as { reason?: string }).reason === "queue-too-large" ||
        (queued.data?.length ?? 0) > 100
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueTooLarge);
      const target = queued.data?.find((item) => item.id === body.queuedSubmissionId);
      // A terminal message of unknown outcome is never resent; deleting it is how it ends.
      const removable =
        policy.queueItem === "pending-or-unknown" ? ["pending", "unknown"] : ["pending"];
      if (!target || (target.status !== undefined && !removable.includes(target.status)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueItemUnavailable);
      if (operation === "queue-update") {
        if (queueEntryHasAttachments(target))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueAttachmentsEditUnsupported);
        if (target.actions?.update?.available === false)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueItemUnavailable);
      }
      if (
        operation === "queue-steer" &&
        (target.actions?.steer?.available === false ||
          (target.queueSteerDeviceId !== undefined && target.queueSteerDeviceId !== device.id))
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueItemUnavailable);
    }
    if (operation === "steer") params.turnId = this.field(body.turnId);
    if (["queue-update", "queue-delete", "queue-steer"].includes(operation))
      params.queuedSubmissionId = this.field(body.queuedSubmissionId);
    if (operation === "queue-reorder") {
      if (
        !Array.isArray(body.queuedSubmissionIds) ||
        body.queuedSubmissionIds.length > 100 ||
        body.queuedSubmissionIds.some((id) => typeof id !== "string") ||
        new Set(body.queuedSubmissionIds).size !== body.queuedSubmissionIds.length
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidQueueOrder);
      params.queuedSubmissionIds = body.queuedSubmissionIds.map((id) => this.field(id));
    }
    if (operation === "rename") params.name = this.field(body.name, 200);
    if (operation === "settings") {
      const usesFullAccessFields =
        body.serviceTierId !== undefined ||
        body.policyId !== undefined ||
        body.mode === null ||
        body.restoreDefaults !== undefined ||
        body.resourceIds !== undefined;
      if (usesFullAccessFields) this.fullAccess(hash);
      const state = await this.runtime({ operation: "settings-state", sessionId }, undefined, true);
      // Only the setting fields reach the Provider's parameter validator.
      const settingFields = [
        "expectedRevision",
        "expectedSettingsScope",
        "model",
        "effort",
        "mode",
        "serviceTierId",
        "policyId",
        "permissionMode",
        "restoreDefaults",
      ];
      const settings = await this.validateSessionAction(admission, capabilities.executionMode, {
        state,
        body: Object.fromEntries(settingFields.map((key) => [key, body[key]])),
      });
      if (!settings.available || !settings.settings)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.capabilityUnavailable);
      Object.assign(params, settings.settings);
    }
    if (operation === "goal-set") {
      const objective = this.field(body.objective, 16_000);
      if (Buffer.byteLength(objective, "utf8") > 16_384)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidObjective);
      if (body.intent !== undefined && body.intent !== "start" && body.intent !== "update")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidGoalIntent);
      const goal: Record<string, unknown> = { objective, intent: body.intent ?? "start" };
      if (body.tokenBudget !== undefined) {
        if (
          body.tokenBudget !== null &&
          (!Number.isSafeInteger(body.tokenBudget) || Number(body.tokenBudget) <= 0)
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidTokenBudget);
        goal.tokenBudget = body.tokenBudget;
      }
      params.goal = goal;
    }
    if (body.resourceIds !== undefined) {
      if (!["steer", "queue-add", "queue-update"].includes(operation))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.resourcesNotSupported);
      if (
        capabilities.features?.context?.available !== true &&
        (capabilities.features?.context !== undefined ||
          capabilities.features?.resources?.available !== true)
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.contextUnavailable);
      const resourceRefs =
        (await this.resolveContextResources(
          sessionId,
          hash,
          body.resourceIds,
          body.expectedRevision,
          true,
        )) ?? [];
      const inputRows = Array.isArray(params.input) ? params.input.length : 1;
      if (inputRows > 11 || resourceRefs.length > 32)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.tooManyInputItems);
      params.resourceRefs = resourceRefs;
    }
    return { params, requiresSend: policy.requiresSend === true };
  }

  private async dispatchSessionAction(
    res: ConversationResponse,
    admission: ActionAdmission,
    dispatch: ActionDispatch,
    params: Record<string, unknown> & { runtimeBootId: string },
    requiresSend: boolean,
  ) {
    const {
      hash,
      operation,
      body,
      control,
      permission,
      sessionId,
      requestId,
      workspaceId,
      opensPicker,
      settingsControl,
    } = admission;
    const current = this.grant(hash, permission);
    const scopeAllowed =
      params.ownerWaitOnly === true
        ? (await this.queueScope(sessionId, hash, true)) === workspaceId
        : await this.workspaceAllowed(workspaceId, current, true);
    if (!scopeAllowed) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    if (this.grant(hash, permission).id !== admission.device.id)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    if (body.bootId !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (dispatch.historyScopeKey)
      await this.assertHistoryScope(hash, dispatch.historyScopeKey, true);
    const restrictCodexNativePolicy = !this.isFullAccess(this.grant(hash, permission));
    if (requiresSend) this.grant(hash, REMOTE_CAPABILITIES.device.send);
    if (dispatch.terminalAttachments) this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
    if (this.requests.has(requestId)) {
      control.priorUncertain = true;
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.outcomeUnknown);
    }
    this.rate(`control:${hash}`, 30);
    rememberRequest(this.requests, requestId);
    this.outcomeFences.record({ sessionId, requestId, operation, deviceId: current.id });
    dispatch.dispatched = true;
    control.dispatched = true;
    this.requestTraces.get(res)?.markDispatched();
    let settingsConfirmed = false;
    const invoke = () => this.requestSession(params, undefined, restrictCodexNativePolicy);
    const pending = Promise.resolve()
      .then(() =>
        (dispatch.terminalAttachments || operation === "handover-terminal") &&
        this.options.receiptRequest
          ? dispatchClaude(invoke, this.options.receiptRequest, params)
          : invoke(),
      )
      .then((result) => {
        if (!settingsControl) return result;
        settingsConfirmed =
          correlatedControlOutcome(result, requestId, sessionId, params.runtimeBootId) !==
          undefined;
        // The HTTP request may time out while the backend still owns the control. A matching
        // settings result can settle its fence even if that response has already ended.
        if (settingsConfirmed && this.bootId === body.bootId) {
          this.settleOutcome(sessionId, requestId);
        }
        return result;
      })
      .finally(() => {
        this.active.delete(sessionId);
        if (!settingsControl) this.admission = false;
        this.notifyControlChanged(sessionId);
      });
    const result = (await this.runtime(params, pending)) as {
      accepted?: boolean;
      completed?: boolean;
      requestId?: string;
      controlOutcome?: string;
      reason?: string;
      error?: string;
    };
    this.grant(hash, permission);
    if (requiresSend) this.grant(hash, REMOTE_CAPABILITIES.device.send);
    if (body.bootId !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (result.accepted !== true) {
      const reason = result.reason ?? result.error;
      const queueRefusal = serialQueueTransactionReason(operation, dispatch.executionMode, reason);
      const refusal =
        operation === "handover-terminal" ? terminalHandoverRefusal(reason) : undefined;
      if (
        result.requestId === requestId &&
        result.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched &&
        (!settingsControl || settingsConfirmed) &&
        (!(refusal || queueRefusal) ||
          (result.completed === false &&
            correlatedControlOutcome(result, requestId, sessionId, params.runtimeBootId) ===
              REMOTE_CONTROL_OUTCOMES.notDispatched))
      ) {
        if (!settingsControl) this.settleOutcome(sessionId, requestId);
        control.dispatched = false;
        if (refusal || queueRefusal) control.priorUncertain = false;
        if (dispatch.newlyPinnedDevice)
          await this.attachmentStore.settle(dispatch.newlyPinnedDevice, sessionId, requestId);
        if (queueRefusal)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.requestFailed, queueRefusal);
        throw new HttpError(409, refusal ?? continuationPreflightReason(reason));
      }
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseUnconfirmed,
        REMOTE_ERROR_CODES.outcomeUnknown,
      );
    }
    if (operation === "delete") await this.forgetDeletedSession(sessionId);
    if (opensPicker && !settingsConfirmed)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseUnconfirmed,
        REMOTE_ERROR_CODES.outcomeUnknown,
      );
    if (!settingsControl)
      res.once("finish", () => {
        if (!res.destroyed && res.statusCode === 200) this.settleOutcome(sessionId, requestId);
      });
    return this.json(res, 200, projectQueueActionAck(result));
  }
  /** A deleted conversation takes its uploads with it, sent or not. */
  private async forgetDeletedSession(sessionId: string) {
    try {
      await this.attachmentStore.removeSession(sessionId);
    } catch {
      // The conversation is already gone. Files left behind name no conversation anyone can open.
    }
  }
  private async projectAgent(
    res: ConversationResponse,
    hash: string,
    method: "GET" | "POST",
    body: Record<string, unknown>,
    assignmentControl?: ActionOutcome,
  ) {
    if (this.options.mode === "lan")
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.routeDenied,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    const request = this.claudeSessionRequest;
    if (!request)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.serviceUnavailable,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    const result = await requestProjectAgent(method, body, {
      request: assignmentControl
        ? (params) => dispatchProjectAgentControl(request, params, assignmentControl)
        : request,
      accessIdentity: () =>
        JSON.stringify([
          this.bootId,
          this.grant(hash),
          this.readerScope(),
          this.config.allowedWorkspaceIds,
        ]),
      freshCatalog: () => this.runtime({ operation: "catalog", assignmentScopeCheck: true }),
      replyScope: (sessionIds) => this.runtime({ operation: "assignment-reply-scope", sessionIds }),
      scopeAllows: (id, device) => this.historyWorkspaceAllowed(id, device),
      local: hash === "desktop-local",
      grant: (permission) => this.grant(hash, permission),
      fullAccess: () => this.fullAccess(hash),
      workspaceAllowed: (id, device) => this.workspaceAllowed(id, device),
      scope: () => this.historyAccessScope(hash),
      catalog: () => this.scopeCatalog(),
      session: async (id) => {
        const session = await this.sessionScope(id, hash, false, false);
        // Other lead providers supply their own Worker tools.
        const leadsWithoutClaude =
          session.agent !== "claude-code" &&
          sessionProviderDeclaration(session.agent)?.projectAgent?.lead;
        if (!this.options.verifiedClaudeManaged && !leadsWithoutClaude)
          throw new HttpError(
            REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.serviceUnavailable,
            REMOTE_ERROR_CODES.capabilityUnavailable,
          );
        return session;
      },
      worker: (id) => this.sessionScope(id, hash, false, false),
      field: (value, max) => this.field(value, max),
    });
    return this.json(
      res,
      200,
      assignmentControl
        ? {
            ...result,
            controlOutcome: REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT.assignSuccessOutcome,
          }
        : result,
    );
  }

  private async prepareClaudeSettings(
    res: ConversationResponse,
    hash: string,
    body: Record<string, unknown>,
  ) {
    if (this.options.mode === "lan")
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.routeDenied,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    if (Object.keys(body).some((key) => !["sessionId", "bootId", "expectedRevision"].includes(key)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
    const device = this.fullAccess(hash, "advancedControl");
    this.grant(hash, REMOTE_CAPABILITIES.device.settings);
    const sessionId = this.field(body.sessionId);
    if (body.bootId !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidRevision);
    if (
      !this.options.verifiedClaudeManaged ||
      !this.claudeSessionRequest ||
      !this.controlsEnabled(sessionId, device)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionControlNotAllowed);
    const workspaceId = await this.codexScope(sessionId, hash, false, false);
    if (
      this.outcomeFences.blocks(sessionId, "settings") ||
      this.outcomeFences.blocks(sessionId, "open-model-picker")
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.outcomeUnknown);
    if (this.admission || this.active.has(sessionId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    this.active.add(sessionId);
    let started = false;
    try {
      const capabilities = (await this.runtime(
        { operation: "capabilities", sessionId, experimentalEnabled: true },
        undefined,
        true,
      )) as {
        executionMode?: string;
        features?: Record<string, { available?: boolean; reason?: string }>;
      };
      if (
        capabilities.executionMode !== "claude-managed" ||
        capabilities.features?.settings?.available !== true
      )
        throw new HttpError(
          409,
          continuationPreflightReason(
            capabilities.features?.settings?.reason,
            REMOTE_ERROR_CODES.capabilityUnavailable,
          ),
        );
      const live = (await this.runtime(
        { operation: "live", sessionId, experimentalEnabled: true },
        undefined,
        true,
      )) as {
        runtimeBootId?: string;
        revision?: number;
      };
      if (!live.runtimeBootId || live.revision !== body.expectedRevision)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleState);
      if (this.fullAccess(hash, "advancedControl").id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      this.grant(hash, REMOTE_CAPABILITIES.device.settings);
      if (!(await this.workspaceAllowed(workspaceId, device, true)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      if (this.fullAccess(hash, "advancedControl").id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      this.grant(hash, REMOTE_CAPABILITIES.device.settings);
      if (body.bootId !== this.bootId)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      const params = {
        operation: "settings-prepare",
        sessionId,
        deviceId: device.id,
        runtimeBootId: live.runtimeBootId,
        expectedRevision: body.expectedRevision,
        experimentalEnabled: true,
      };
      // Initialization has no command receipt. Keep only this session reserved
      // until the real preparation settles, even if the HTTP request times out.
      const pending = this.claudeSessionRequest(params).finally(() => {
        this.active.delete(sessionId);
        this.notifyControlChanged(sessionId);
      });
      started = true;
      const settings = await this.runtime(params, pending, true);
      if (body.bootId !== this.bootId)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      if (this.fullAccess(hash, "advancedControl").id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      this.grant(hash, REMOTE_CAPABILITIES.device.settings);
      await this.codexScope(sessionId, hash, true, false);
      if (body.bootId !== this.bootId)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      if (this.fullAccess(hash, "advancedControl").id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      this.grant(hash, REMOTE_CAPABILITIES.device.settings);
      return this.json(res, 200, { sessionId, ...this.projectSettings(settings) });
    } finally {
      if (!started) {
        this.active.delete(sessionId);
      }
    }
  }
  private async controlReceipt(
    requestId: string,
    deviceId: string,
    control: { priorUncertain: boolean },
  ): Promise<Record<string, unknown> | undefined> {
    if (this.requests.has(requestId)) control.priorUncertain = true;
    if (!this.options.receiptRequest) return;
    const alreadyUncertain = control.priorUncertain;
    control.priorUncertain = true;
    const prior = (await this.options.receiptRequest({ requestId, deviceId })) as Record<
      string,
      unknown
    >;
    if (prior?.found === false && prior.requestId === requestId)
      control.priorUncertain = alreadyUncertain;
    return prior;
  }
  private historyFields<T>(read: () => T): T {
    try {
      return read();
    } catch (error) {
      throw new HttpError(
        400,
        error instanceof Error
          ? (parseRemoteErrorCode(error.message) ?? REMOTE_ERROR_CODES.requestFailed)
          : REMOTE_ERROR_CODES.invalidHistoryReference,
      );
    }
  }
  private historyWorkspaceAllowed(id: string, device: WebDevice) {
    return (
      this.isFullAccess(device) ||
      this.options.mode === "lan" ||
      this.config.allowedWorkspaceIds?.includes(id) === true
    );
  }
  private async historyAccessScope(hash: string, reserved = false) {
    const device = this.grant(hash);
    const identity = JSON.stringify(device);
    const boot = this.bootId;
    // Registration can change while a catalog snapshot awaits aliases, without changing device grants.
    // LAN already grants reads over registered workspaces; its config has no workspace list.
    const workspaces = (await this.registeredWorkspaces(reserved))
      .filter(({ id }) => this.historyWorkspaceAllowed(id, device))
      .map(({ id }) => id)
      .sort();
    const current = this.grant(hash);
    if (boot !== this.bootId || JSON.stringify(current) !== identity)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    return { workspaces, token: digest(JSON.stringify([boot, current, workspaces])) };
  }
  private async historyScope(hash: string, reserved = false) {
    const access = await this.historyAccessScope(hash, reserved);
    const catalog = (await this.scopeCatalog(reserved)) as {
      sessions?: { id: string; workspace_id: string; indexedSessionIds?: string[] }[];
    };
    if ((await this.historyAccessScope(hash, reserved)).token !== access.token)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    const allowedSessionIds = [
      ...new Set(
        (catalog.sessions ?? [])
          .filter((item) => access.workspaces.includes(item.workspace_id))
          .flatMap((item) => item.indexedSessionIds ?? [item.id]),
      ),
    ].sort();
    const targetSessionIds = (catalog.sessions ?? [])
      .filter((item) => access.workspaces.includes(item.workspace_id))
      .map((item) => item.id)
      .sort();
    return {
      ...access,
      allowedSessionIds,
      targetSessionIds,
      key: digest(JSON.stringify([access.token, allowedSessionIds, targetSessionIds])),
    };
  }
  private checkPairedHostScope(hash: string) {
    this.grant(hash);
    if (this.options.acceptanceSessionId && hash !== "desktop-local")
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionControlNotAllowed);
  }
  private approvalAuditSource(
    hash: string,
    device: WebDevice,
    client: unknown,
  ): SessionApprovalAuditContext {
    const credential = this.credentials.find((row) => row.hash === hash);
    // Client kind is presentation metadata. Identity and control grants still come from pairing.
    const phone = client === "mobile" || !!credential?.account?.sessionId;
    return {
      source: {
        kind: hash === "desktop-local" ? "desktop" : phone ? "phone" : "web",
        deviceId: device.id,
      },
    };
  }
  private async recordExpiredApproval(
    context: SessionApprovalAuditContext,
    snapshot: unknown,
    params: Record<string, unknown>,
    pairedChoice?: { id: string; device: WebDevice },
  ) {
    const { operation, sessionId, requestId } = params;
    if (!this.options.sessionRequest || (operation !== "approve" && operation !== "answer")) return;
    if (pairedChoice && typeof sessionId === "string") {
      const descriptions = await this.pendingInteractionDescriptions(
        sessionId,
        snapshot,
        pairedChoice.device,
        true,
        true,
      ).catch(() => undefined);
      const nativeId = operation === "approve" ? params.approvalId : params.questionId;
      const interaction = interactionFor(
        descriptions,
        operation === "approve" ? "approval" : "question",
        nativeId,
        params.turnId,
      );
      if (!interaction) return;
      const approvals = snapshotField(snapshot, "approvals");
      const nativeApproval = Array.isArray(approvals)
        ? approvals.find(
            (item) =>
              snapshotField(item, "requestId") === nativeId &&
              snapshotField(item, "turnId") === params.turnId,
          )
        : undefined;
      const selected = resolvePendingInteractionDecision(
        interaction,
        nativeApproval,
        pairedChoice.id,
      );
      if (!selected?.decision.available) return;
      params = {
        ...params,
        decision: selected.nativeChoice,
        nativeDecision: selected.nativeDecision,
      };
    }
    // A stale request alone is not proof an approval existed. Bind the record to native evidence.
    const evidence = await this.readApprovalEvidence(snapshot, params);
    if (!evidence.risk || !evidence.decision) return;
    await this.requestSession(
      {
        operation: "approval-audit-expired",
        sessionId,
        requestId,
        deviceId: context.source.deviceId,
        interactionKind: operation === "approve" ? "approval" : "question",
      },
      undefined,
      false,
      { ...context, ...evidence },
    ).catch(() => undefined);
  }
  private async readApprovalEvidence(snapshot: unknown, params: Record<string, unknown>) {
    try {
      const workspaceId = snapshotField(snapshot, "workspaceId");
      const workspace =
        typeof workspaceId === "string"
          ? (await this.registeredWorkspaces(true)).find((item) => item.id === workspaceId)
          : undefined;
      return await approvalAuditEvidence(snapshot, params, workspace?.path);
    } catch {
      // Audit evidence is optional and must not alter dispatch authorization or the decision.
      return {};
    }
  }
  private async recordStaleClientApproval(
    hash: string,
    context: SessionApprovalAuditContext,
    params: Record<string, unknown> & { sessionId: string },
    permission: "approve" | "send",
    decisionId?: string,
  ) {
    const boot = this.bootId;
    const { sessionId } = params;
    const snapshot = await this.runtime({
      operation: "live",
      sessionId,
      experimentalEnabled: true,
    });
    const device = this.grant(hash, permission);
    if (
      boot !== this.bootId ||
      device.id !== context.source.deviceId ||
      !snapshotField(snapshot, "runtimeBootId") ||
      !(await this.controlsEnabledForSnapshot(sessionId, snapshot, device))
    )
      return;
    if (boot === this.bootId && this.grant(hash, permission) === device)
      await this.recordExpiredApproval(
        context,
        snapshot,
        params,
        decisionId ? { id: decisionId, device } : undefined,
      );
  }
  private async approvalAuditPage(res: ConversationResponse, hash: string, url: URL) {
    if (!this.options.sessionRequest)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.handlerUnavailable,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    if (
      [...url.searchParams.keys()].some((key) => key !== "before" && key !== "limit") ||
      url.searchParams.getAll("before").length > 1 ||
      url.searchParams.getAll("limit").length > 1
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidApprovalAuditQuery);
    const before = url.searchParams.get("before");
    if (before !== null && !/^[A-Za-z0-9_-]{1,160}$/.test(before))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidApprovalAuditQuery);
    const limit = Number(url.searchParams.get("limit") ?? "30");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidApprovalAuditQuery);
    const scope = async () => {
      this.checkPairedHostScope(hash);
      const boot = this.bootId;
      const device = this.grant(hash);
      const readerScope = this.readerScope();
      const workspaces =
        hash === "desktop-local"
          ? undefined
          : (await this.registeredWorkspaces(true))
              .filter(
                (item) =>
                  this.isFullAccess(device) ||
                  this.options.mode === "lan" ||
                  this.config.allowedWorkspaceIds?.includes(item.id),
              )
              .map(({ id, path }) => ({ id, path }))
              .sort((a, b) => a.id.localeCompare(b.id));
      if (this.bootId !== boot || this.grant(hash) !== device || this.readerScope() !== readerScope)
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
          REMOTE_ERROR_CODES.accessChanged,
        );
      return { boot, readerScope, device, workspaces };
    };
    const initial = await scope();
    const result = await this.requestSession({
      operation: "approval-audit-list",
      ...(before !== null ? { before } : {}),
      limit,
      ...(initial.workspaces ? { workspaces: initial.workspaces } : {}),
    }).catch((error: unknown) => {
      const detail =
        error instanceof RuntimeRequestError ? snapshotField(error.data, "detail") : undefined;
      if (detail === REMOTE_ERROR_CODES.invalidApprovalAuditCursor)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidApprovalAuditQuery);
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.approvalAuditUnavailable);
    });
    if (JSON.stringify(initial) !== JSON.stringify(await scope()))
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    return this.json(res, 200, result);
  }
  private async approvalRuleScope(hash: string, workspaceId: string | undefined, write = false) {
    this.checkPairedHostScope(hash);
    const device =
      write || workspaceId === undefined ? this.fullAccess(hash, "settings") : this.grant(hash);
    const boot = this.bootId;
    const allowsWorkspace = (caller: WebDevice) =>
      !workspaceId ||
      this.isFullAccess(caller) ||
      this.options.mode === "lan" ||
      this.config.allowedWorkspaceIds?.includes(workspaceId);
    if (!allowsWorkspace(device))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const workspace = workspaceId
      ? (await this.registeredWorkspaces()).find((item) => item.id === workspaceId)
      : undefined;
    if (workspaceId && !workspace)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const canonical = workspace ? await realpath(workspace.path).catch(() => undefined) : undefined;
    const pathKey = (path: string) =>
      process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
    const current =
      write || workspaceId === undefined ? this.fullAccess(hash, "settings") : this.grant(hash);
    if (current !== device || boot !== this.bootId)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    const full = this.isFullAccess(current);
    if (
      !allowsWorkspace(current) ||
      (workspace && (!canonical || pathKey(canonical) !== pathKey(workspace.path)))
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    return {
      canonical,
      canRevoke: full && current.settings === true && this.controlsEnabled(undefined, current),
      device,
      boot,
    };
  }
  private async approvalRuleRequest(
    res: ConversationResponse,
    hash: string,
    workspaceId?: string,
    revoke?: { agent: ManagedAgent; ruleId: string },
  ) {
    const service = this.options.approvalRules;
    if (!service)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.handlerUnavailable,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    const scope = await this.approvalRuleScope(hash, workspaceId, revoke !== undefined);
    const recheck = async () => {
      const next = await this.approvalRuleScope(hash, workspaceId, revoke !== undefined);
      if (
        next.device !== scope.device ||
        next.boot !== scope.boot ||
        next.canonical !== scope.canonical
      )
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
          REMOTE_ERROR_CODES.accessChanged,
        );
    };
    const context = {
      ...(scope.canonical ? { workspace: scope.canonical } : {}),
      includeGlobal: workspaceId === undefined,
      dataDir: this.options.dataDir,
      authorizeWrite: recheck,
    };
    if (revoke) {
      try {
        await service.revoke(context, revoke.agent, revoke.ruleId);
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const reason = error instanceof Error ? error.message : "";
        if (reason === "approval-rule-read-only")
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.approvalRuleReadOnly);
        if (reason === "approval-rule-stale")
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.approvalRuleStale);
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.approvalRuleRevokeFailed);
      }
      return this.json(res, 200, { revoked: true });
    }
    const result = await service.list(context).catch(() => {
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.approvalRulesUnavailable);
    });
    await recheck();
    return this.json(res, 200, {
      providers: result.providers,
      rules: result.rules
        .filter((rule) => (rule.scope === "global") === (workspaceId === undefined))
        .map((rule) => ({ ...rule, revocable: rule.revocable && scope.canRevoke })),
    });
  }
  private async historyTargetScope(sessionId: string, hash: string, reserved = false) {
    if (this.options.mode !== "lan") return this.codexScope(sessionId, hash, reserved, false);
    const scope = await this.historyScope(hash, reserved);
    if (!scope.targetSessionIds.includes(sessionId))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
  }
  private async codexResumeCommandScope(sessionId: string, hash: string) {
    const access = await this.historyAccessScope(hash);
    const catalog = (await this.scopeCatalog()) as {
      sessions?: { id: string; workspace_id: string; agent: string; availability: string }[];
    };
    const session = catalog.sessions?.find(
      (item) =>
        item.id === sessionId &&
        ["codex", "claude-code"].includes(item.agent) &&
        item.availability === "readable",
    );
    const workspace = (await this.registeredWorkspaces()).find(
      (item) => item.id === session?.workspace_id && access.workspaces.includes(item.id),
    );
    if (!workspace) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    let directory: string;
    let identity: string;
    try {
      directory = await realpath(workspace.path);
      const info = await stat(directory);
      if (!info.isDirectory()) throw new Error("not_directory");
      identity = JSON.stringify([workspace.id, directory, info.dev, info.ino]);
    } catch {
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    }
    if ((await this.historyAccessScope(hash)).token !== access.token)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    return digest(JSON.stringify([access.token, identity]));
  }
  private async historyCall(
    method: string,
    params: Record<string, unknown>,
    res?: ConversationResponse,
  ): Promise<unknown> {
    if (!this.options.historyRequest)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.handlerUnavailable,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    if (res?.destroyed) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.historyRequestCancelled);
    const requestId = randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let dispatched = false;
    let rejectCancelled: ((error: Error) => void) | undefined;
    const cancellation = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    const cancel = (timedOut = false) => {
      if (cancelled) return;
      cancelled = true;
      const deadline = REMOTE_ERROR_CONTRACT.historyReadTimeout;
      rejectCancelled?.(
        timedOut
          ? new HttpError(deadline.http.status, deadline.http.reasonFor, undefined, deadline.code)
          : HttpError.fromContract(REMOTE_ERROR_CONTRACT.historyRequestCancelled),
      );
      if (dispatched)
        void this.options.historyRequest!(HISTORY_SEARCH_METHODS.cancel, { requestId }).catch(
          () => {},
        );
    };
    const disconnect = () => cancel();
    res?.once("close", disconnect);
    try {
      timer = setTimeout(() => cancel(true), 20_000);
      dispatched = true;
      return await Promise.race([
        this.options.historyRequest(method, { ...params, requestId }),
        cancellation,
      ]);
    } catch (error) {
      const mapped = readRequestErrors.historyReadFailure(error);
      if (mapped) throw new HttpError(mapped.status, mapped.code);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      res?.removeListener("close", disconnect);
    }
  }
  private async assertHistoryScope(hash: string, key: string, reserved = false) {
    if ((await this.historyScope(hash, reserved)).key !== key)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
  }
  private async resolveHistoryInput(
    body: Record<string, unknown>,
    hash: string,
    operation: string,
    reserved = false,
  ) {
    const references = this.historyFields(() => historyReferences(body.historyReferences));
    const inputHash = this.historyFields(() => historyInputHash(body, operation));
    const scope = await this.historyScope(hash, reserved);
    if (references.some((item) => !scope.allowedSessionIds.includes(item.sessionId)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    const resolved = (await this.historyCall(HISTORY_SEARCH_METHODS.references, {
      references,
      allowedSessionIds: scope.allowedSessionIds,
    })) as { references: ResolvedHistoryReference[] };
    await this.assertHistoryScope(hash, scope.key, reserved);
    const text = this.historyFields(() =>
      historyText(String(body.text ?? ""), references, resolved.references),
    );
    return { text, references, inputHash, scopeKey: scope.key };
  }
  /** A receipt freezes the accepted text. Replays compare reviewed input without re-reading sources. */
  private historyReplay(
    prior: Record<string, unknown> | undefined,
    body: Record<string, unknown>,
    operation: string,
    control: { priorUncertain: boolean },
  ): unknown | undefined {
    if (prior?.found !== true || (body.historyReferences === undefined && !prior.historyInputHash))
      return undefined;
    if (
      prior.sessionId !== body.sessionId ||
      prior.operation !== operation ||
      prior.historyInputHash !== this.historyFields(() => historyInputHash(body, operation))
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.requestIdConflict);
    if (prior.status === "accepted" && prior.ack && typeof prior.ack === "object") {
      control.priorUncertain = false;
      return prior.ack;
    }
    control.priorUncertain = prior.status !== REMOTE_CONTROL_OUTCOMES.notDispatched;
    throw new HttpError(
      409,
      control.priorUncertain
        ? REMOTE_ERROR_CODES.outcomeUnknown
        : REMOTE_ERROR_CODES.controlPreflightRejected,
      undefined,
      refusedReceiptReason(prior, body.requestId, body.sessionId),
    );
  }
  private async historyRead(
    res: ConversationResponse,
    hash: string,
    kind: string,
    body: Record<string, unknown>,
  ) {
    const scope = await this.historyScope(hash, true);
    let params: Record<string, unknown>;
    let method: string;
    if (kind === "search") {
      const fields = ["query", "workspaceIds", "agents", "kinds", "archived", "cursor", "limit"];
      if (Object.keys(body).some((key) => !fields.includes(key)) || typeof body.query !== "string")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidHistoryQuery);
      if (
        body.workspaceIds !== undefined &&
        (!Array.isArray(body.workspaceIds) ||
          body.workspaceIds.some((id) => typeof id !== "string" || !scope.workspaces.includes(id)))
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      params = { ...body };
      method = HISTORY_SEARCH_METHODS.query;
    } else if (kind === "locate") {
      params = this.historyFields(() => historyLocation(body)) as unknown as Record<
        string,
        unknown
      >;
      if (!scope.allowedSessionIds.includes(String(params.sessionId)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      method = HISTORY_SEARCH_METHODS.locate;
    } else {
      if (Object.keys(body).some((key) => key !== "references"))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidHistoryReferences);
      const references = this.historyFields(() => historyReferences(body.references));
      if (references.some((item) => !scope.allowedSessionIds.includes(item.sessionId)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      params = { references };
      method = HISTORY_SEARCH_METHODS.references;
    }
    const result = await this.historyCall(
      method,
      { ...params, allowedSessionIds: scope.allowedSessionIds },
      res,
    );
    await this.assertHistoryScope(hash, scope.key, true);
    if (kind === "references") {
      const resolved = result as { references: ResolvedHistoryReference[] };
      const text = this.historyFields(() =>
        historyText("", params.references as HistoryReference[], resolved.references),
      );
      return this.json(res, 200, { references: resolved.references, text });
    }
    return this.json(res, 200, result);
  }
  private sessionProviderOperation(agent: ManagedAgent, operation: "options" | "create") {
    if (
      !(this.options.sessionRequest || this.options.sessionProviderRequest) ||
      !sessionProviderCapabilities(agent)
    )
      return;
    return (params: unknown) =>
      this.requestSession({
        ...(params as Record<string, unknown>),
        agent,
        operation: `provider-${operation}`,
      });
  }
  private async sessionCreationOptions(agent: ManagedAgent, workspaceId: string | undefined) {
    const unsupported = { available: false, reason: REMOTE_ERROR_CODES.unsupportedHost };
    if (agent === "devin" || agent === "deepseek-harness") {
      const verified =
        agent === "devin" ? this.options.verifiedDevinManaged : this.options.verifiedDshFollower;
      if (verified !== true) return unsupported;
      if (this.admission) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    }
    const registered = this.sessionProviderOperation(agent, "options");
    if (registered) {
      const workspaceScoped =
        sessionProviderCapabilities(agent)?.create.catalogScope === "workspace" &&
        (agent !== "claude-code" || this.options.verifiedClaudeManaged === true);
      return this.runtime(
        { operation: "provider-options" },
        registered(workspaceScoped && workspaceId ? { workspaceId } : {}),
      );
    }

    switch (agent) {
      case "codex":
        return this.codexSessionRequest?.({ operation: "options" }) ?? unsupported;
      case "claude-code":
        return (
          this.claudeSessionRequest?.({
            operation: "options",
            ...(workspaceId && this.options.verifiedClaudeManaged ? { workspaceId } : {}),
          }) ?? unsupported
        );
      case "deepseek-harness":
        return this.runtime({
          operation: "dsh-options",
          ...(workspaceId ? { includeModels: true } : {}),
        });
      case "devin":
        return this.runtime({ operation: "devin-options" });
      default:
        return unsupported;
    }
  }
  private async manage(
    _req: ConversationRequest,
    res: ConversationResponse,
    hash: string,
    operation: string,
    body: Record<string, unknown>,
    control: { request: boolean; dispatched: boolean; priorUncertain: boolean },
  ) {
    this.grant(hash, REMOTE_CAPABILITIES.device.manage);
    const agent = managedAgentOf(body.agent ?? "codex");
    if (!agent) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAgent);
    const provider = sessionProviderCapabilities(agent);
    const permissionField = sessionProviderDeclaration(agent)?.permissionField;
    // DeepSeek Harness only starts sessions here; its sessions are controlled through actions.
    if (agent === "deepseek-harness" && operation !== "create")
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    // Devin also only starts sessions here, with their first message.
    if (agent === "devin" && operation !== "create")
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    const requestId = this.field(body.requestId, 128);
    if (agent === "claude-code")
      await this.controlReceipt(
        requestId,
        this.grant(hash, REMOTE_CAPABILITIES.device.manage).id,
        control,
      );
    const providerCreate =
      operation === "create" ? this.sessionProviderOperation(agent, "create") : undefined;
    const managedRequest =
      providerCreate ??
      (() => {
        switch (agent) {
          case "codex":
            return this.codexSessionRequest;
          case "claude-code":
            return this.claudeSessionRequest;
          case "deepseek-harness":
            return (value: unknown) =>
              this.requestSession({
                ...(value as Record<string, unknown>),
                operation: "dsh-create",
              });
          case "devin":
            return (value: unknown) =>
              this.requestSession({
                ...(value as Record<string, unknown>),
                operation: "devin-create",
              });
          default:
            return undefined;
        }
      })();
    if (agent === "claude-code" && !this.options.verifiedClaudeManaged)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedHost);
    if (agent === "deepseek-harness" && this.options.verifiedDshFollower !== true)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedHost);
    if (agent === "devin" && this.options.verifiedDevinManaged !== true)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedHost);
    if (
      this.options.acceptanceSessionId &&
      (operation === "create" || body.sessionId !== this.options.acceptanceSessionId)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionControlNotAllowed);
    if (!managedRequest || !["create", "release", "reconcile"].includes(operation))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    if (body.bootId !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    const params: Record<string, unknown> = {
      operation,
      requestId,
      deviceId: this.grant(hash, REMOTE_CAPABILITIES.device.manage).id,
    };
    let creationNeedsFullAccess = false;
    let verifyPolicyReply = false;
    if (operation === "create") {
      params.workspaceId = this.field(body.workspaceId);
      if (body.permissionMode !== undefined && permissionField !== "permissionMode")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedPermissionMode);
      if (agent === "codex") {
        const policyId =
          body.policyId === undefined
            ? "workspace-write-on-request"
            : this.field(body.policyId, 128);
        if (
          ![
            "workspace-write-on-request",
            "workspace-write-auto-review",
            "full-access-on-request",
          ].includes(policyId)
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedPolicy);
        // Starting with another policy is changing it, which a session's settings allow only
        // to a device with full access.
        creationNeedsFullAccess = policyId !== "workspace-write-on-request";
        params.policyId = policyId;
      } else if (body.policyId !== undefined) {
        if (provider?.create.permissionPicker !== true || permissionField !== "policyId")
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedPolicy);
        params.policyId = this.field(body.policyId, 128);
        creationNeedsFullAccess = true;
        verifyPolicyReply = true;
      }
      if (body.mode !== undefined) {
        if (provider?.create.planMode !== "mode" || body.mode !== "plan")
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedMode);
        this.grant(hash, REMOTE_CAPABILITIES.device.settings);
        params.mode = body.mode;
      }
      if (body.model !== undefined) params.model = this.field(body.model, 128);
      if (body.effort !== undefined) params.effort = this.field(body.effort, 32);
      if (provider?.create.verifyStartupModel && body.verifyStartupModel !== undefined) {
        if (body.verifyStartupModel !== true)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
        params.verifyStartupModel = true;
      }
      if (agent === "claude-code") {
        if (body.permissionMode !== undefined) {
          if (!["default", "plan", "acceptEdits"].includes(String(body.permissionMode)))
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedPermissionMode);
          params.permissionMode = body.permissionMode;
        }
      }
      if (provider?.create.agentPresets && body.agentPreset !== undefined)
        params.agentPreset = this.field(body.agentPreset, 128);
      if (provider?.create.serviceTiers && body.serviceTierId !== undefined)
        params.serviceTier = this.field(body.serviceTierId, 128);
      if (agent === "devin" && body.permissionMode !== undefined) {
        const mode = String(body.permissionMode);
        if (!DEVIN_PERMISSION_MODES.includes(mode))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedPermissionMode);
        // Approving more without asking is changing what the session may do: full access only.
        creationNeedsFullAccess = mode === "smart" || mode === "dangerous";
        params.permissionMode = mode;
      }
      if (agent === "antigravity" && body.permissionMode !== undefined) {
        const mode = String(body.permissionMode);
        if (!ANTIGRAVITY_PERMISSION_MODES.includes(mode))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unsupportedPermissionMode);
        // Auto also runs commands Antigravity judges safe: full access only.
        creationNeedsFullAccess = mode === "auto";
        params.permissionMode = mode;
      }
      if (creationNeedsFullAccess) this.fullAccess(hash);
      if (provider?.create.mode === "with-first-message") {
        if (typeof body.prompt !== "string" || !body.prompt.trim())
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.missingPrompt);
        if (Buffer.byteLength(body.prompt, "utf8") > 64 * 1024)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.promptTooLarge);
        params.prompt = body.prompt;
      }
    } else {
      params.sessionId = this.field(body.sessionId);
    }
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    if (agent === "claude-code" && operation === "release") {
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidRevision);
      const live = (await this.runtime({
        operation: "live",
        sessionId: params.sessionId,
        experimentalEnabled: true,
      })) as { runtimeBootId?: string };
      params.expectedRevision = body.expectedRevision;
      params.runtimeBootId = this.field(live.runtimeBootId);
    }
    if (this.admission || (sessionId && this.active.has(sessionId)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    if (agent !== "claude-code" && this.requests.has(requestId)) {
      control.priorUncertain = true;
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.duplicateRequest);
    }
    const catalog = (await this.scopeCatalog()) as {
      sessions: { id: string; workspace_id: string; agent: string }[];
    };
    const workspaceId =
      operation === "create"
        ? params.workspaceId
        : catalog.sessions.find(
            (s) => s.id === params.sessionId && (agent !== "claude-code" || s.agent === agent),
          )?.workspace_id;
    if (
      typeof workspaceId !== "string" ||
      !(await this.workspaceAllowed(workspaceId, this.grant(hash)))
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    this.grant(hash, REMOTE_CAPABILITIES.device.manage);
    if (creationNeedsFullAccess) this.fullAccess(hash);
    if (params.mode === "plan") this.grant(hash, REMOTE_CAPABILITIES.device.settings);
    if (body.bootId !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (this.admission || (sessionId && this.active.has(sessionId)))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    if (agent !== "claude-code" && this.requests.has(requestId)) {
      control.priorUncertain = true;
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.duplicateRequest);
    }
    this.rate(`control:${hash}`, 30);
    this.admission = true;
    rememberRequest(this.requests, requestId);
    control.dispatched = true;
    this.requestTraces.get(res)?.markDispatched();
    const pending = Promise.resolve()
      .then(() =>
        agent === "claude-code" && this.options.receiptRequest
          ? dispatchClaude(managedRequest!, this.options.receiptRequest, params)
          : agent === "codex" && operation === "reconcile"
            ? this.requestSession(
                params,
                "codex",
                !this.isFullAccess(this.grant(hash, REMOTE_CAPABILITIES.device.manage)),
              )
            : managedRequest!(params),
      )
      .finally(() => {
        this.admission = false;
        // A managed request may settle after the HTTP timeout, including create
        // before a session id is known. Wake receipt reconciliation in either case.
        this.notifyControlChanged(sessionId ?? "");
      });
    const result = (await this.runtime(params, pending)) as {
      reconciled?: boolean;
      accepted?: boolean;
      completed?: boolean;
      controlOutcome?: string;
      reason?: string;
      requestId?: string;
      policyId?: string;
    };
    this.grant(hash, REMOTE_CAPABILITIES.device.manage);
    if (body.bootId !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (verifyPolicyReply && result?.accepted === true && result.policyId !== params.policyId) {
      // Creation is empty: without permission proof the client must retain the first message.
      control.dispatched = false;
      control.priorUncertain = false;
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.createPermissionUnconfirmed);
    }
    if (operation !== "reconcile" && result?.accepted !== true) {
      if (
        result?.accepted === false &&
        result.completed === false &&
        result.requestId === requestId &&
        result.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched
      ) {
        control.dispatched = false;
        control.priorUncertain = false;
        const safeReasons: readonly RemoteErrorCode[] = [
          REMOTE_ERROR_CODES.webBusy,
          REMOTE_ERROR_CODES.unverifiedInstallation,
          REMOTE_ERROR_CODES.claudeSessionFingerprintChanged,
          REMOTE_ERROR_CODES.sessionBusy,
          REMOTE_ERROR_CODES.sessionCompacting,
          REMOTE_ERROR_CODES.sessionReleased,
          REMOTE_ERROR_CODES.staleClaudeRevision,
          REMOTE_ERROR_CODES.codexOwnerBusy,
          REMOTE_ERROR_CODES.codexCliVersionTooOld,
          REMOTE_ERROR_CODES.codexCliUnavailable,
          REMOTE_ERROR_CODES.codexCliVersionUnavailable,
          REMOTE_ERROR_CODES.codexOwnerCheckUnavailable,
          REMOTE_ERROR_CODES.platformUnsupported,
          REMOTE_ERROR_CODES.unsupportedCodexCliVersion,
          REMOTE_ERROR_CODES.unsupportedModelDetail,
          REMOTE_ERROR_CODES.unsupportedEffortDetail,
          REMOTE_ERROR_CODES.unsupportedServiceTierDetail,
          REMOTE_ERROR_CODES.claudeStartupModelsUnavailable,
          REMOTE_ERROR_CODES.sessionManagedByAnotherRuntime,
          REMOTE_ERROR_CODES.pauseOriginalGoalBeforeHandoff,
          REMOTE_ERROR_CODES.controlOutcomeUnconfirmed,
          REMOTE_ERROR_CODES.codexPolicyMismatch,
          REMOTE_ERROR_CODES.codexWorkspaceMismatch,
          REMOTE_ERROR_CODES.codexSandboxMismatch,
          REMOTE_ERROR_CODES.codexWritableRootsMismatch,
          REMOTE_ERROR_CODES.remoteEnvironmentNotSupported,
          REMOTE_ERROR_CODES.dshRuntimeOffline,
          REMOTE_ERROR_CODES.dshCreateAmbiguous,
          REMOTE_ERROR_CODES.dshModelsUnavailable,
          REMOTE_ERROR_CODES.dshCreateModelSelectionUnsupported,
          REMOTE_ERROR_CODES.dshCreateModelNotApplied,
          REMOTE_ERROR_CODES.dshCreatePermissionSelectionUnsupported,
          REMOTE_ERROR_CODES.dshCreatePermissionNotApplied,
          REMOTE_ERROR_CODES.invalidPolicy,
          // Starting DeepSeek Harness in the background, and a session another DSH holds.
          REMOTE_ERROR_CODES.dshStartFailed,
          REMOTE_ERROR_CODES.dshVersionUnsupported,
          REMOTE_ERROR_CODES.dshLauncherUnavailable,
          REMOTE_ERROR_CODES.dshExited,
          REMOTE_ERROR_CODES.dshSessionInUse,
          REMOTE_ERROR_CODES.workspaceUnavailable,
        ];
        throw new HttpError(
          409,
          safeReasons.find((reason) => reason === result.reason) ??
            continuationPreflightReason(result.reason),
        );
      }
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseUnconfirmed,
        REMOTE_ERROR_CODES.outcomeUnknown,
      );
    }
    if (operation === "reconcile" && result.reconciled === true)
      this.settleSessionOutcomes(String(params.sessionId));
    return this.json(res, 200, result);
  }
  private async pendingInteractionDescriptions(
    sessionId: string | undefined,
    snapshot: unknown,
    device: WebDevice,
    enabled: boolean,
    reserved: boolean,
  ) {
    const workspaceId = snapshotField(snapshot, "workspaceId");
    const workspaceRoot =
      hasPendingRows(snapshot, "approvals") && typeof workspaceId === "string"
        ? (await this.registeredWorkspaces(reserved)).find((item) => item.id === workspaceId)?.path
        : undefined;
    return describePendingInteractions(snapshot, {
      sessionId,
      workspaceRoot,
      approve: device.approve,
      send: device.send,
      extendedApproval: device.extendedApproval === true,
      enabled,
    });
  }
  private async projectLive(
    sessionId: string | undefined,
    snapshot: unknown,
    device?: WebDevice,
    reserved = false,
  ) {
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot))
      snapshot = this.projectPermissionField(
        this.projectUsageFields(snapshot as Record<string, unknown>, device),
      );
    if (
      sessionId &&
      this.options.receiptRequest &&
      snapshot &&
      typeof snapshot === "object" &&
      "executionMode" in snapshot &&
      (snapshot.executionMode === "claude-managed" || snapshot.executionMode === "claude-follower")
    ) {
      await settleClaudeAttachments(this.attachmentStore, this.options.receiptRequest, sessionId);
    }
    const enabled = await this.controlsEnabledForSnapshot(sessionId, snapshot, device, reserved);
    // Terminal approval cards also use the host's risk assessment on the local desktop.
    const pendingInteractions =
      device &&
      (device.id !== "desktop-local" ||
        snapshotField(snapshot, "executionMode") === "claude-follower") &&
      (hasPendingRows(snapshot, "approvals") || hasPendingRows(snapshot, "questions"))
        ? await this.pendingInteractionDescriptions(sessionId, snapshot, device, enabled, reserved)
        : undefined;
    if (device && snapshot && typeof snapshot === "object") {
      const state = snapshot as {
        approvals?: {
          requiresExtendedApproval?: boolean;
          supported?: boolean;
          decisionOptions?: { scope: string }[];
        }[];
        questions?: { supported?: boolean }[];
        [key: string]: unknown;
      };
      const handover = state.terminalHandover;
      snapshot = {
        ...state,
        ...(handover && device.id !== "desktop-local"
          ? {
              terminalHandover:
                enabled &&
                device.send &&
                device.advancedControl &&
                snapshotField(handover, "remoteAvailable") === true
                  ? { available: false, remoteAvailable: true }
                  : null,
            }
          : {}),
        ...(this.options.mode === "lan" && isCodexMode(state.executionMode) && !device.send
          ? { sendEnabled: false, stopEnabled: false }
          : {}),
        approvals: state.approvals?.map((approval) => ({
          ...approval,
          supported:
            approval.supported === true &&
            device.approve === true &&
            (!sessionId || !this.interactionOutcomeBlocked(sessionId, "approval")) &&
            (!approval.requiresExtendedApproval || device.extendedApproval === true),
          decisionOptions: device.extendedApproval === true ? approval.decisionOptions : undefined,
        })),
        ...(state.questions &&
        (!device.send || (!!sessionId && this.interactionOutcomeBlocked(sessionId, "question")))
          ? {
              questions: state.questions.map((question) => ({ ...question, supported: false })),
            }
          : {}),
        ...(pendingInteractions?.length ? { pendingInteractions } : {}),
      };
    }
    if (snapshot && typeof snapshot === "object") {
      if (!enabled) {
        const state = snapshot as Record<string, unknown>;
        return {
          ...state,
          sendEnabled: false,
          stopEnabled: false,
          questions: Array.isArray(state.questions)
            ? state.questions.map((question) => ({ ...question, supported: false }))
            : [],
          approvals: Array.isArray(state.approvals)
            ? state.approvals.map((approval) => ({
                ...approval,
                supported: false,
                ...(state.executionMode === "claude-follower" ? {} : { availableDecisions: [] }),
              }))
            : [],
        };
      }
      if (sessionId) return { ...snapshot, ...this.scopedOutcomeFlags(sessionId) };
    }
    return snapshot;
  }
  private expire() {
    const now = Date.now();
    if (this.code && this.code.expiresAt <= now) this.code = undefined;
    for (const [hash, browser] of this.browsers) {
      if (browser.expiresAt <= now) {
        this.browsers.delete(hash);
        this.endStreams(hash);
      } else if (browser.pending && browser.pending.expiresAt <= now) browser.pending = undefined;
    }
    for (const [key, rate] of this.rates) if (rate.until <= now) this.rates.delete(key);
  }
  private credentialExpired(credential: Credential, now = Date.now()): boolean {
    return credential.expiresAt <= now || this.expiringDeviceIds.has(credential.device.id);
  }

  private fenceExpiredCredentials(): boolean {
    const now = Date.now();
    let discovered = false;
    for (const credential of this.credentials) {
      const { id } = credential.device;
      if (credential.expiresAt > now || this.expiringDeviceIds.has(id)) continue;
      this.expiringDeviceIds.add(id);
      discovered = true;
      this.endCredential(credential);
      void this.invalidateScheduledDevice(id, "pairing-ended").catch(() => undefined);
    }
    return discovered;
  }

  private async expireCredentials() {
    this.fenceExpiredCredentials();
    if (!this.expiringDeviceIds.size) return;
    // Only the serialized writer removes records, since a pairing update can have a save in flight.
    const expired = this.credentials.filter(({ device }) => this.expiringDeviceIds.has(device.id));
    this.expiringDeviceIds = new Set(expired.map(({ device }) => device.id));
    if (expired.length)
      await this.revokeCredentials(expired, "pairing-ended").catch(() => {
        // The in-memory fence and original expiry still apply if the snapshot cannot be replaced.
      });
  }

  private checkCredentialExpiry(): void {
    // Fence the expired device now. Disk writes and backend cleanup never gate another request.
    if (this.fenceExpiredCredentials()) void this.queueAdmin(() => this.expireCredentials());
  }
  private rate(key: string, limit: number, traffic?: PairedRateClass) {
    const now = Date.now();
    const previous = this.rates.get(key);
    // 表满时只拒绝新建 key；已有额度的客户端不能因为别人把表撑满而被 429。
    if (!previous && this.rates.size >= MAX_REQUEST_RATE_KEYS) {
      let earliest = now + REQUEST_RATE_WINDOW_MS;
      for (const entry of this.rates.values()) earliest = Math.min(earliest, entry.until);
      throw requestRateError(earliest, now);
    }
    const rate =
      previous && previous.until > now
        ? previous
        : { count: 0, until: now + REQUEST_RATE_WINDOW_MS };
    if (rate.count >= limit) throw requestRateError(rate.until, now);
    if (traffic) {
      const classified = (rate.paired ??= { api: 0, stream: 0, probe: 0 });
      const exhausted =
        traffic === "stream"
          ? classified.stream >= PAIRED_STREAM_LIMIT
          : traffic === "probe"
            ? classified.probe >= PAIRED_PROBE_LIMIT
            : rate.count - classified.stream - classified.probe >= PAIRED_REST_LIMIT ||
              (traffic === "api" && classified.api >= API_REQUEST_LIMIT);
      if (exhausted) throw requestRateError(rate.until, now);
      if (traffic !== "other") classified[traffic]++;
    }
    rate.count++;
    this.rates.set(key, rate);
  }
  private endStreams(hash?: string, event: StreamTermination | null = "access-ended") {
    for (const [res, stream] of this.streams)
      if (!hash || hash === stream.hash) {
        if (event) this.requestTraces.streamTerminated(res, streamTerminationReason(event));
        closeStreamResponse(res, event);
        this.streams.delete(res);
      }
  }
  /**
   * `compress` 只由确认回复里没有凭据的调用方传入（目录）：同一回复里混有秘密和
   * 可控内容时，压缩后的长度会泄露秘密（BREACH），所以不对所有回复开压缩。
   * 只压缩真正的 HTTP 回复；桌面桥和 WebSocket 授权用的内存回复按 JSON 文本读取。
   */
  private json(
    res: ConversationResponse,
    status: number,
    data: unknown,
    compress = false,
    maxBytes = 4 * 1024 * 1024,
  ) {
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > maxBytes)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.responseTooLarge);
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    };
    if (compress && res instanceof ServerResponse && body.length >= COMPRESSED_REPLY_MIN_BYTES) {
      res.writeHead(status, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      res.end(gzipSync(body));
      this.requestTraces.get(res)?.respond(status, data);
      return;
    }
    res.writeHead(status, headers);
    res.end(body);
    this.requestTraces.get(res)?.respond(status, data);
  }
  private async body(req: ConversationRequest): Promise<Record<string, unknown>> {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.jsonRequired);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.bodyTooLarge);
      chunks.push(Buffer.from(chunk));
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || Array.isArray(value) || typeof value !== "object") throw 0;
      return value;
    } catch {
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidJson);
    }
  }
  private grant(
    hash: string,
    permission?:
      | "send"
      | "approve"
      | "manage"
      | "files"
      | "attachments"
      | "advancedControl"
      | "organize"
      | "settings"
      | "extendedApproval",
  ) {
    if (hash === "desktop-local" && this.options.mode !== "lan") return this.localDevice;
    const credential = this.credentials.find((c) => c.hash === hash);
    const expired = credential && this.credentialExpired(credential);
    if (expired) this.checkCredentialExpiry();
    if (!this.server || !credential || expired || this.browsers.get(hash)?.ended) {
      this.endStreams(hash);
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    }
    if (this.accountLoginRequired()) {
      this.requireCloudLoginContext();
      if (!this.validCloudBinding(credential.account)) {
        this.endStreams(hash);
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accountLoginRequired);
      }
    }
    if (
      permission &&
      ((permission !== "files" && !this.controlsEnabled(undefined, credential.device)) ||
        credential.device[permission] !== true)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.permissionDenied);
    return credential.device;
  }
  private field(value: unknown, max = 256): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      [...value].some((character) => character.charCodeAt(0) <= 0x1f)
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
    return value;
  }
  private async runtime(
    params: unknown,
    existing?: Promise<unknown>,
    reserved = false,
    timeoutError:
      | typeof REMOTE_ERROR_CODES.outcomeUnknown
      | typeof REMOTE_ERROR_CODES.catalogReadTimeout = REMOTE_ERROR_CODES.outcomeUnknown,
  ) {
    if (!existing && !reserved && this.admission)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    const deadline = readRequestErrors.runtimeRequestDeadline(
      snapshotField(params, "operation"),
      timeoutError,
    );
    // Timeout does not cancel owner execution. Callers never automatically retry mutations.
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        existing ?? this.runtimeCall(params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new HttpError(deadline.status, deadline.error, undefined, deadline.reason)),
            20_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  /** 发出 runtime 请求；整份目录的读取登记为进行中，供权限检查共用。 */
  private runtimeCall(params: unknown): Promise<unknown> {
    const catalog = snapshotField(params, "operation") === "catalog";
    const readerScope = this.readerScope();
    const read = this.requestSession(
      catalog ? { ...(params as Record<string, unknown>), readerScope } : params,
    );
    if (
      snapshotField(params, "operation") === "catalog" &&
      Object.keys(params as object).length === 1
    ) {
      const flight = { boot: this.bootId, readerScope, read };
      this.catalogFlight = flight;
      const release = () => {
        if (this.catalogFlight === flight) this.catalogFlight = undefined;
      };
      read.then(release, release);
    }
    return read;
  }
  private async catalogSession(sessionId: string, reserved = false) {
    type Scope = { id: string; agent: string; workspace_id: string; workspaceRegistered?: true };
    if (this.options.supportsCatalogScope) {
      const result = (await this.runtime(
        { operation: "catalog-scope", sessionId },
        undefined,
        reserved,
      )) as { handled: false } | { handled: true; session: Scope | null };
      if (result.handled) return result.session;
    }
    const catalog = (await this.scopeCatalog(reserved)) as { sessions?: Scope[] };
    const row = catalog.sessions?.find((row) => row.id === sessionId);
    return row && { ...row, workspaceRegistered: undefined };
  }
  /** 权限查找可共用在途目录读取，/catalog 自己始终发起新读取。 */
  private async scopeCatalog(reserved = false): Promise<unknown> {
    const flight = this.catalogFlight;
    if (!flight || flight.boot !== this.bootId || flight.readerScope !== this.readerScope())
      return this.runtime({ operation: "catalog" }, undefined, reserved);
    if (!reserved && this.admission)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
    return this.runtime({ operation: "catalog" }, flight.read, reserved);
  }
  private async taskSummary(
    hash: string,
    catalog?: unknown,
  ): Promise<ConversationTaskSummary | undefined> {
    const boot = this.bootId;
    const readerScope = this.readerScope();
    const device = this.grant(hash);
    // A stream invalidation must observe a read started after that notification.
    const source = catalog ?? (await this.runtime({ operation: "catalog" }));
    const access = await this.historyAccessScope(hash);
    const current = this.grant(hash);
    if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if (readerScope !== this.readerScope() || current !== device)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
    return projectTaskSummary(
      source,
      access.workspaces,
      this.isFullAccess(current) || this.options.mode === "lan",
      JSON.stringify([access.token, readerScope]),
    );
  }
  private async notificationActivity(
    hash: string,
    sessions?: readonly NotificationActivitySession[],
  ) {
    this.checkPairedHostScope(hash);
    const device = this.grant(hash);
    const readerScope = this.readerScope();
    const boot = this.bootId;
    const catalog = sessions ? undefined : await this.runtime({ operation: "catalog" });
    const catalogRows = snapshotField(catalog, "sessions") as
      | NotificationActivitySession[]
      | undefined;
    const access = await this.historyAccessScope(hash);
    if (boot !== this.bootId || readerScope !== this.readerScope() || this.grant(hash) !== device)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    if (snapshotField(catalog, "orchestrationUnavailable") === true)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.orchestrationUnavailable);
    return projectNotificationActivity(sessions ?? catalogRows ?? [], {
      workspaceIds: access.workspaces,
      versionScope: JSON.stringify([access.token, readerScope]),
      unconfirmed: this.outcomeFences.sessions,
    });
  }
  private async notificationPolicy(hash: string, patch?: Record<string, unknown>) {
    const store = this.options.notificationPolicy;
    if (!store)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.handlerUnavailable,
        REMOTE_ERROR_CODES.capabilityUnavailable,
      );
    this.checkPairedHostScope(hash);
    if (patch === undefined) return { policy: store.read() };
    const device = this.fullAccess(hash, "settings");
    const boot = this.bootId;
    const policy = await store
      .update(patch, () => {
        if (this.fullAccess(hash, "settings") !== device || this.bootId !== boot)
          throw new HttpError(
            REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
            REMOTE_ERROR_CODES.accessChanged,
          );
      })
      .catch((error: unknown) => {
        if (error instanceof HttpError) throw error;
        if (
          error instanceof Error &&
          error.message === REMOTE_ERROR_CODES.invalidNotificationPolicy
        )
          throw new HttpError(400, REMOTE_ERROR_CODES.invalidNotificationPolicy);
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notificationPolicyUnavailable);
      });
    this.pushEvents.emit("changed");
    return { policy };
  }
  private async conversationReadState(
    res: ConversationResponse,
    hash: string,
    sessionId: string,
    update?: Omit<ConversationReadStateUpdate, "operation" | "sessionId" | "readerScope">,
  ) {
    const device = this.grant(hash);
    const boot = this.bootId;
    const readerScope = this.readerScope();
    const check = () => {
      const current = this.grant(hash);
      if (current.id !== device.id) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if (this.bootId !== boot) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      if (this.readerScope() !== readerScope)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
      return current;
    };
    const workspaceId = await this.codexScope(sessionId, hash, true, false);
    const recheck = async () => {
      check();
      const currentWorkspaceId = await this.codexScope(sessionId, hash, true, false);
      const current = check();
      if (
        (!update && currentWorkspaceId !== workspaceId) ||
        (!this.isFullAccess(current) &&
          !this.config.allowedWorkspaceIds?.includes(currentWorkspaceId))
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    };
    check();
    let result: unknown;
    try {
      result = await this.runtime(
        {
          operation: update ? "read-state-update" : "read-state",
          sessionId,
          readerScope,
          ...update,
        },
        undefined,
        true,
      );
    } catch (error) {
      if (!update) await recheck();
      const mapped = readRequestErrors.readStateFailure(error);
      if (mapped) throw new HttpError(mapped[0], mapped[1]);
      throw error;
    }
    await recheck();
    return this.json(res, 200, result);
  }
  private async sessionPin(
    res: ConversationResponse,
    hash: string,
    sessionId: string,
    pinned: boolean,
    trustedLocal: boolean,
  ) {
    const device = this.grant(hash, REMOTE_CAPABILITIES.device.organize);
    const boot = this.bootId;
    const check = () => {
      if (this.grant(hash, REMOTE_CAPABILITIES.device.organize).id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if (this.bootId !== boot) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    };
    const workspaceId = await this.codexScope(sessionId, hash, true, false).catch((error) => {
      if (
        trustedLocal &&
        error instanceof HttpError &&
        error.message === REMOTE_ERROR_CODES.workspaceNotAuthorized
      )
        return undefined;
      throw error;
    });
    check();
    let result: unknown;
    try {
      result = await this.runtime(
        { operation: "session-pin", sessionId, ...(workspaceId ? { workspaceId } : {}), pinned },
        undefined,
        true,
      );
    } catch (error) {
      const detail =
        error instanceof RuntimeRequestError ? snapshotField(error.data, "detail") : undefined;
      const code = detail ?? (error instanceof Error ? error.message : undefined);
      if (code === "session-not-found")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionNotFound);
      if (code === "session-pin-busy")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionPinBusy);
      if (code === "session-pin-unavailable")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionPinUnavailable);
      throw error;
    }
    check();
    if (workspaceId && (await this.codexScope(sessionId, hash, true, false)) !== workspaceId)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
    check();
    if (snapshotField(result, "pinned") !== pinned)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseTimedOut,
        REMOTE_ERROR_CODES.outcomeUnknown,
      );
    return this.json(res, 200, { pinned });
  }
  private async conversationSessionImage(
    res: ConversationResponse,
    hash: string,
    sessionId: string,
    imageId: string,
  ) {
    const device = this.grant(hash);
    const boot = this.bootId;
    const readerScope = this.readerScope();
    const check = () => {
      if (this.grant(hash).id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if (this.bootId !== boot) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      if (this.readerScope() !== readerScope)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
    };
    const workspace = await this.codexScope(sessionId, hash, true, false);
    check();
    let result: unknown;
    try {
      result = await this.runtime(
        { operation: "session-image", sessionId, imageId },
        undefined,
        true,
      );
    } catch (error) {
      check();
      const detail =
        error instanceof RuntimeRequestError &&
        error.data !== null &&
        typeof error.data === "object" &&
        "detail" in error.data &&
        typeof error.data.detail === "string"
          ? error.data.detail
          : error instanceof Error
            ? error.message
            : undefined;
      const errors = new Map<string, { code: RemoteErrorCode; http: { status: number } }>([
        [REMOTE_ERROR_CODES.sessionImageInvalid, REMOTE_ERROR_CONTRACT.invalidImageId],
        [REMOTE_ERROR_CODES.sessionImageUnavailable, REMOTE_ERROR_CONTRACT.imageUnavailable],
        [REMOTE_ERROR_CODES.sessionImageChanged, REMOTE_ERROR_CONTRACT.imageChanged],
        [REMOTE_ERROR_CODES.sessionImageTooLarge, REMOTE_ERROR_CONTRACT.imageTooLarge],
        [REMOTE_ERROR_CODES.sessionImageUnsupported, REMOTE_ERROR_CONTRACT.imageUnsupported],
      ]);
      const mapped = detail ? errors.get(detail) : undefined;
      if (mapped) throw HttpError.fromContract(mapped);
      if (error instanceof HttpError) throw error;
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.requestFailed);
    }
    check();
    if (workspace !== (await this.codexScope(sessionId, hash, true, false)))
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
        REMOTE_ERROR_CODES.accessChanged,
      );
    check();
    const image = result as { mimeType?: unknown; base64?: unknown } | null;
    if (
      !image ||
      typeof image.mimeType !== "string" ||
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) ||
      typeof image.base64 !== "string" ||
      !image.base64.length ||
      image.base64.length > Math.ceil((8 * 1024 * 1024) / 3) * 4 ||
      image.base64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.base64) ||
      Buffer.byteLength(image.base64, "base64") > 8 * 1024 * 1024
    )
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidImageResponse);
    // Only this separately bounded media route may exceed the usual 4 MiB JSON reply.
    return this.json(
      res,
      200,
      { mimeType: image.mimeType, base64: image.base64 },
      false,
      12 * 1024 * 1024,
    );
  }
  private async handle(
    req: ConversationRequest,
    res: ConversationResponse,
    control: ActionOutcome,
    trustedLocal = false,
  ) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: blob: ${this.previewOrigin}; media-src ${this.previewOrigin || "'none'"}; frame-src ${this.previewOrigin || "'none'"}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    this.expire();
    this.checkCredentialExpiry();
    const lan = this.options.mode === "lan";
    // 地址暂时不在网卡列表里时只拒绝本次请求；是否停止监听由 checkLanAddress 的连续缺失计数决定。
    if (lan && !this.addresses.some((entry) => entry.address === this.config.lanAddress))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.lanAddressUnavailable);
    const localOrigin = `http://${lan ? this.config.lanAddress : "127.0.0.1"}:${this.config.port}`;
    const host = req.headers.host;
    const external =
      !lan && !!this.config.externalOrigin && host === new URL(this.config.externalOrigin).host;
    if (host !== new URL(localOrigin).host && !external)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidHost);
    const origin = lan ? HOSTED_ORIGIN : external ? this.config.externalOrigin : localOrigin;
    if (lan && req.headers.origin !== origin)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidOrigin);
    if (req.headers.origin && req.headers.origin !== origin)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidOrigin);
    // External apps may open the public shell. This exception never covers API or embedded reads.
    const navigationPath = (req.url || "/").split("?")[0];
    const pageNavigation =
      (req.method === "GET" || req.method === "HEAD") &&
      (navigationPath === "/" || navigationPath === "/index.html") &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    if (!lan && req.headers["sec-fetch-site"] === "cross-site" && !pageNavigation)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.crossSiteRequest);
    const cookieName = external ? "ak_web_secure" : "ak_web_local";
    let raw = lan
      ? req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
      : req.headers.cookie
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
    let hash = trustedLocal
      ? "desktop-local"
      : raw && /^[A-Za-z0-9_-]{43}$/.test(raw)
        ? digest(raw)
        : "";
    // 已配对设备各自一份额度；未认证流量（含静态资源、预检、配对）共享一个池。
    // 经 relay 进来的请求都来自本机 frpc，拿不到真实客户端地址，无法再按 IP 细分。
    const pairedCredential =
      !trustedLocal && hash
        ? this.credentials.find((c) => c.hash === hash && !this.credentialExpired(c))
        : undefined;
    const paired = pairedCredential !== undefined;
    const url = new URL(req.url || "/", origin);
    // Classified before the first limit, so a control it turns away still says it was never
    // dispatched; without an outcome the client has to treat the request as unknown.
    control.request =
      url.pathname.startsWith(`${REMOTE_ROUTE_BASE}/`) &&
      isControlRequest(
        req.method,
        url.pathname.slice(REMOTE_ROUTE_BASE.length),
        url.searchParams.get("operation"),
      );
    if (lan) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", "Retry-After");
      res.setHeader("Vary", "Origin");
    }
    if (!trustedLocal) {
      const category = remoteRateCategory(req.method, url.pathname);
      const at = Date.now();
      const deviceId = pairedCredential?.device.id;
      control.rateDiagnostic = { deviceId, category, at };
      this.rateDiagnostics.observe(deviceId, category, false, at);
      if (paired)
        this.rate(
          `paired:${hash}`,
          PAIRED_REQUEST_LIMIT,
          pairedRateClass(req.method, url.pathname, lan),
        );
      else this.rate("anonymous", 600);
    }
    if (paired && url.pathname.startsWith("/api/")) this.seen.set(hash, Date.now());
    if (!url.pathname.startsWith("/api/")) {
      if (lan) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
      return this.static(req, res);
    }
    res.setHeader("Cache-Control", "no-store");
    if (!url.pathname.startsWith(`${REMOTE_ROUTE_BASE}/`))
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    const requestedPath = url.pathname.slice(REMOTE_ROUTE_BASE.length);
    if (lan && req.method === "OPTIONS") {
      const method = req.headers["access-control-request-method"];
      const headers = String(req.headers["access-control-request-headers"] ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        !lanPreflightAllowed(method, requestedPath) ||
        headers.some(
          (header) =>
            ![
              "authorization",
              "content-type",
              "x-csrf-token",
              REMOTE_HEADERS.protocol.toLowerCase(),
              "x-agentkib-client",
              "last-event-id",
            ].includes(header),
        )
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidPreflight);
      res.setHeader("Access-Control-Allow-Methods", method!);
      res.setHeader(
        "Access-Control-Allow-Headers",
        `Authorization, Content-Type, X-CSRF-Token, ${REMOTE_HEADERS.protocol}, Last-Event-ID`,
      );
      if (req.headers["access-control-request-private-network"] === "true")
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && requestedPath === REMOTE_ROUTE.info)
      return this.json(res, 200, {
        // Legacy hosted clients check this before authentication or any reads.
        // Negotiate realtime separately so their history and receipt access survives.
        protocolVersion: REMOTE_VERSIONS.hostDiscovery.advertised,
        conversationProtocolVersion: CONVERSATION_PROTOCOL_VERSION,
        transport: lan ? "lan" : "local",
        capabilities: {
          [REMOTE_CAPABILITIES.info.read]: true,
          [REMOTE_CAPABILITIES.info.send]: this.controlsEnabled(),
          [REMOTE_CAPABILITIES.info.approve]: this.controlsEnabled(),
        },
      });
    control.request = isControlRequest(
      req.method,
      requestedPath,
      url.searchParams.get("operation"),
    );
    if (control.request) requireConversationProtocol(req);
    // Protocol and LAN rules use the public route. The shared handlers keep its Codex scope.
    const legacyOperation =
      req.method === "POST" && requestedPath.startsWith(REMOTE_LEGACY_CODEX.prefix)
        ? requestedPath.slice(REMOTE_LEGACY_CODEX.prefix.length)
        : undefined;
    const path =
      legacyOperation !== undefined
        ? REMOTE_LEGACY_CODEX.postTarget
        : req.method === "GET"
          ? (CODEX_READ_ALIASES.get(requestedPath) ?? requestedPath)
          : requestedPath;
    const legacyCodex = path !== requestedPath;
    let browser = trustedLocal
      ? ({ csrf: "desktop-local", expiresAt: Number.MAX_SAFE_INTEGER } as Browser)
      : this.browsers.get(hash);
    let bearerToken: string | undefined;
    if (lan && req.headers.authorization && !browser && !pairedCredential)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
    if (!browser && hash && pairedCredential) {
      browser = { csrf: token(), expiresAt: Date.now() + MAX_AGE };
      this.browsers.set(hash, browser);
    }
    if (req.method === "GET" && path === REMOTE_ROUTE.access) {
      if (!browser) {
        this.rate("bootstrap", 60);
        if (this.browsers.size >= 1024)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.clientLimit);
        raw = token();
        hash = digest(raw);
        browser = { csrf: token(), expiresAt: Date.now() + 300_000 };
        this.browsers.set(hash, browser);
        if (lan) bearerToken = raw;
        else
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${MAX_AGE / 1000}${external ? "; Secure" : ""}`,
          );
      }
      const credential = pairedCredential;
      const loginRequired = !trustedLocal && this.accountLoginRequired();
      const loginContext = loginRequired ? this.requireCloudLoginContext() : undefined;
      const binding = credential ? credential.account : browser.account;
      const bound = this.validCloudBinding(binding);
      browser.accountChallenge ??= binding?.hostChallenge ?? token();
      const device = trustedLocal
        ? this.localDevice
        : !loginRequired || bound
          ? credential?.device
          : undefined;
      // A pairing bound to an account login is renewed here; its cookie follows the new lifetime.
      if (!lan && raw && credential?.account && !browser.ended)
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${raw}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((credential.expiresAt - Date.now()) / 1000))}${external ? "; Secure" : ""}`,
        );
      const historyAccess =
        device && !browser.ended && this.options.historyRequest
          ? await this.historyAccessScope(hash)
          : undefined;
      const directConnection =
        external && device && !browser.ended ? this.relay?.directConnection : undefined;
      // Only an approved device learns the name: it can say who owns the computer.
      const computerName =
        device && !browser.ended
          ? await (this.options.computerName?.() ?? Promise.resolve(undefined)).catch(
              () => undefined,
            )
          : undefined;
      return this.json(res, 200, {
        status: browser.ended
          ? "ended"
          : device
            ? "approved"
            : browser.pending
              ? "pending"
              : REMOTE_ERROR_CODES.unpaired,
        protocolVersion: CONVERSATION_PROTOCOL_VERSION,
        [REMOTE_CAPABILITIES.access.readStateVersion]: REMOTE_FEATURE_VERSIONS.readStateVersion,
        ...(device && !browser.ended && !this.options.acceptanceSessionId
          ? {
              [REMOTE_CAPABILITIES.access.readStateMarkVersion]:
                REMOTE_FEATURE_VERSIONS.readStateMarkVersion,
            }
          : {}),
        ...(device && !lan && !browser.ended && this.claudeSessionRequest
          ? {
              [REMOTE_CAPABILITIES.access.projectAgentAssignmentVersion]:
                REMOTE_FEATURE_VERSIONS.projectAgentAssignmentVersion,
            }
          : {}),
        ...(device && !trustedLocal && !browser.ended
          ? {
              [REMOTE_CAPABILITIES.access.pendingInteractions]: {
                version: REMOTE_FEATURE_VERSIONS.pendingInteractions,
              },
            }
          : {}),
        ...(device &&
        !browser.ended &&
        this.options.verifiedClaudeManaged &&
        this.options.sessionRequest &&
        !this.options.acceptanceSessionId
          ? {
              [REMOTE_CAPABILITIES.access.answerNotesVersion]:
                REMOTE_FEATURE_VERSIONS.answerNotesVersion,
            }
          : {}),
        ...(device && !browser.ended && this.options.conversationHub
          ? {
              [REMOTE_CAPABILITIES.access.taskSummaryVersion]:
                REMOTE_FEATURE_VERSIONS.taskSummaryVersion,
            }
          : {}),
        ...(device &&
        !browser.ended &&
        this.options.approvalRules &&
        !this.options.acceptanceSessionId
          ? {
              [REMOTE_CAPABILITIES.access.approvalRulesVersion]:
                REMOTE_FEATURE_VERSIONS.approvalRulesVersion,
            }
          : {}),
        ...(device &&
        !browser.ended &&
        this.options.sessionRequest &&
        !this.options.acceptanceSessionId
          ? {
              [REMOTE_CAPABILITIES.access.approvalAuditVersion]:
                REMOTE_FEATURE_VERSIONS.approvalAuditVersion,
            }
          : {}),
        ...(device &&
        !browser.ended &&
        this.options.notificationPolicy &&
        !this.options.acceptanceSessionId
          ? {
              [REMOTE_CAPABILITIES.access.pushPolicyVersion]: notificationPolicyVersion(url),
              [REMOTE_CAPABILITIES.access.pushActivityVersion]:
                REMOTE_FEATURE_VERSIONS.pushActivityVersion,
            }
          : {}),
        csrfToken: browser.csrf,
        bootId: this.bootId,
        device: browser.ended ? undefined : device,
        pending: browser.pending,
        pairingMode: lan ? "confirmation" : "code",
        experimentalEnabled: this.controlsEnabled(undefined, device),
        ...(device && !browser.ended && this.options.disabledSessionProviders
          ? {
              [REMOTE_CAPABILITIES.access.disabledSessionProviders]:
                this.options.disabledSessionProviders,
            }
          : {}),
        ...(computerName ? { computerName } : {}),
        ...(historyAccess
          ? {
              [REMOTE_CAPABILITIES.access.historySearch]: true,
              historySearchScope: historyAccess.token,
            }
          : {}),
        ...(directConnection &&
        directConnection.controlOrigin === this.config.externalOrigin &&
        directConnection.previewOrigin === this.previewOrigin
          ? { [REMOTE_CAPABILITIES.access.directConnection]: directConnection }
          : {}),
        ...(bearerToken ? { bearerToken } : {}),
        ...(url.searchParams.get("rateDiagnostics") === "1" &&
        device &&
        credential &&
        !browser.ended
          ? { rateDiagnostics: this.rateDiagnostics.snapshot(this.grant(hash).id) }
          : {}),
        // Additive: only a pairing that can be notified learns that it can subscribe.
        ...(device && credential && !browser.ended && this.pushReady(credential)
          ? {
              [REMOTE_CAPABILITIES.access.push]: {
                version: REMOTE_FEATURE_VERSIONS.push,
                subscribed: !!credential.push,
                ...(this.options.notificationPolicy && !this.options.acceptanceSessionId
                  ? { approvalActionsVersion: REMOTE_FEATURE_VERSIONS.approvalActionsVersion }
                  : {}),
                ...(credential.push
                  ? { alerts: credential.push.alerts, liveActivity: credential.push.liveActivity }
                  : {}),
              },
            }
          : {}),
        ...(loginRequired && loginContext
          ? {
              [REMOTE_CAPABILITIES.access.accountLogin]: {
                required: true,
                proofVersion: REMOTE_FEATURE_VERSIONS.accountLoginProofVersion,
                deviceId: loginContext.deviceId,
                challenge: browser.accountChallenge,
                bound,
                ...(bound ? { accountId: loginContext.accountId } : {}),
              },
            }
          : {}),
      });
    }
    if (!browser) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.unpaired);
    // Trusted IPC GETs still use the underlying read admission and route-specific limits.
    // Catalog and transcript refreshes must not exhaust the desktop's write budget.
    if (!paired && (!trustedLocal || req.method !== "GET")) this.rate(hash, API_REQUEST_LIMIT);
    if (req.method === "POST") {
      if (req.headers.origin !== origin || req.headers["x-csrf-token"] !== browser.csrf)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.csrfRejected);
      if (path === REMOTE_ROUTE.attachments) {
        if (lan) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsRequireSameOrigin);
        const device = this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
        const sessionId = this.field(url.searchParams.get("sessionId"));
        const workspaceId = await this.codexScope(sessionId, hash, false, false);
        const capabilities = (await this.runtime({
          operation: "capabilities",
          sessionId,
          experimentalEnabled: true,
        })) as { features?: Record<string, { available: boolean }> };
        if (capabilities.features?.attachments?.available !== true)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsUnavailable);
        const result = await this.attachmentStore.upload(
          req,
          { deviceId: device.id, sessionId },
          this.field(url.searchParams.get("name"), 255),
          this.field(url.searchParams.get("mime") || "application/octet-stream"),
          () => {
            this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
            if (
              !this.isFullAccess(device) &&
              !this.config.allowedWorkspaceIds?.includes(workspaceId)
            )
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
          },
        );
        this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
        if (!(await this.workspaceAllowed(workspaceId, device)))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
        return this.json(res, 201, result);
      }
      const body = await this.body(req);
      if (path === REMOTE_ROUTE.abandonRequest)
        return this.json(res, 200, await this.abandonOutcome(hash, body));
      if (path === REMOTE_ROUTE.approvalRulesRevoke) {
        if (
          url.search ||
          Object.keys(body).some((key) => !["workspaceId", "agent", "ruleId"].includes(key))
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidApprovalRuleRequest);
        const agent = managedAgentOf(body.agent);
        if (!agent) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAgent);
        return this.approvalRuleRequest(
          res,
          hash,
          body.workspaceId === undefined ? undefined : this.field(body.workspaceId),
          { agent, ruleId: this.field(body.ruleId, 128) },
        );
      }
      if (path === REMOTE_ROUTE.sessionPin) {
        if (
          url.search ||
          Object.keys(body).some((key) => !["sessionId", "pinned"].includes(key)) ||
          typeof body.pinned !== "boolean"
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidSessionPinRequest);
        return this.sessionPin(
          res,
          hash,
          this.field(body.sessionId, 256),
          body.pinned,
          trustedLocal,
        );
      }
      if (path === REMOTE_ROUTE.readState) {
        if (url.search || !isReadStateUpdateBody(body))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidReadStateRequest);
        return this.conversationReadState(res, hash, this.field(body.sessionId), {
          expectedVersion: this.field(body.expectedVersion, 4096),
          seenResultId: body.seenResultId === null ? null : this.field(body.seenResultId, 4096),
          ...(body.mark === undefined ? {} : { mark: body.mark }),
        });
      }
      if (path.startsWith(REMOTE_ROUTE_PREFIXES.history)) {
        if (url.search) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidHistoryRequest);
        const kind = path.slice(REMOTE_ROUTE_PREFIXES.history.length);
        if (["search", "locate", "references"].includes(kind))
          return this.historyRead(res, hash, kind, body);
        if (!trustedLocal || lan) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.ownerRequired);
        if (!this.options.historyRequest)
          throw new HttpError(
            REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.handlerUnavailable,
            REMOTE_ERROR_CODES.capabilityUnavailable,
          );
        let method: string;
        if (kind === "configure") {
          if (
            Object.keys(body).some((key) => key !== "enabled") ||
            typeof body.enabled !== "boolean"
          )
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidHistoryConfiguration);
          method = HISTORY_SEARCH_METHODS.configure;
        } else {
          if (Object.keys(body).length)
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidHistoryRequest);
          if (kind !== "clear" && kind !== "rebuild")
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
          method = kind === "clear" ? HISTORY_SEARCH_METHODS.clear : HISTORY_SEARCH_METHODS.refresh;
        }
        return this.json(res, 200, await this.options.historyRequest(method, body));
      }
      if (path === REMOTE_ROUTE.managedAction) {
        const operation = legacyOperation ?? this.field(body.operation, 64);
        this.requestTraces.get(res)?.setOperation(operation);
        return this.admitSessionAction(res, hash, operation, body, control, !legacyCodex);
      }
      if (path === REMOTE_ROUTE.attachmentsDelete) {
        if (lan) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsRequireSameOrigin);
        const device = this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
        await this.attachmentStore.remove(
          device.id,
          this.field(body.sessionId),
          this.field(body.attachmentId),
          this.field(body.version),
        );
        return this.json(res, 200, { ok: true });
      }
      if (path === REMOTE_ROUTE.pair) {
        this.rate(`pair:${hash}`, 5);
        this.rate("pair", 20);
        const pairingBrowser = browser;
        const pairing = this.adminQueue.then(async () => {
          const checkBrowser = async () => {
            this.expire();
            await this.expireCredentials();
            if (pairingBrowser.ended || this.credentials.some((c) => c.hash === hash))
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.alreadyPaired);
            if (this.browsers.get(hash) !== pairingBrowser || !this.server)
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
          };
          await checkBrowser();
          const binding = pairingBrowser.account;
          if (this.accountLoginRequired()) {
            const { deviceId } = this.requireCloudLoginContext();
            const relay = this.relay!;
            if (!binding?.id || !this.validCloudBinding(binding))
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accountLoginRequired);
            let verified;
            try {
              verified = await relay.verifyAccountLogins([binding.id]);
            } catch {
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accountLoginUnavailable);
            }
            await checkBrowser();
            if (
              this.requireCloudLoginContext().deviceId !== deviceId ||
              this.relay !== relay ||
              pairingBrowser.account !== binding ||
              !this.validCloudBinding(binding) ||
              !verified[0]?.active
            )
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accountLoginRequired);
          }
          const name = this.field(body.name, 80);
          const code = this.code;
          if (!tryPairingCode(code, hash, body.code))
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidPairingCode);
          if (!lan) {
            if (this.credentials.length >= 128)
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.deviceLimit);
            const credential: Credential = {
              hash,
              expiresAt: Date.now() + MAX_AGE,
              ...(this.accountLoginRequired() ? { account: { ...pairingBrowser.account! } } : {}),
              device: {
                id: token(),
                name,
                accessMode: "full",
                createdAt: Date.now(),
                ...CODE_ACCESS_PERMISSIONS[code.access],
              },
            };
            const next = [...this.credentials, credential];
            // Publish neither the grant nor consumption until the atomic file replacement succeeds.
            // A failed save leaves the one-time code available for an explicit retry.
            await this.save(this.config, this.remotePairingInitialized, next);
            this.credentials = next;
            pairingBrowser.pending = undefined;
            pairingBrowser.expiresAt = credential.expiresAt;
            this.code = undefined;
            return { status: "approved", device: credential.device };
          }
          if ([...this.browsers.values()].filter((b) => b.pending).length >= 8)
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.pendingLimit);
          pairingBrowser.pending = {
            id: token(),
            name,
            verification: randomInt(0, 100_000_000).toString().padStart(8, "0"),
            expiresAt: code.expiresAt,
          };
          pairingBrowser.expiresAt = Date.now() + MAX_AGE;
          this.code = undefined;
          try {
            this.options.onPairingRequested?.();
          } catch {
            // A desktop attention failure must not turn a valid pairing into an unknown result.
          }
          return { pending: pairingBrowser.pending };
        });
        this.adminQueue = pairing.catch(() => undefined);
        return this.json(res, 200, await pairing);
      }
      if (path === REMOTE_ROUTE.pairCancel) {
        browser.pending = undefined;
        return this.json(res, 200, { ok: true });
      }
      if (path === REMOTE_ROUTE.accountBinding)
        return this.json(res, 200, await this.bindAccount(hash, body));
      if (path === REMOTE_ROUTE.pushSubscribe)
        return this.json(res, 200, await this.subscribePush(hash, body));
      if (path === REMOTE_ROUTE.pushUnsubscribe)
        return this.json(res, 200, await this.unsubscribePush(hash, body));
      if (path === REMOTE_ROUTE.pushPolicy) {
        if (url.search)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidNotificationPolicy);
        return this.json(res, 200, await this.notificationPolicy(hash, body));
      }
      if (path === REMOTE_ROUTE.logout) {
        // Share the config transaction queue: a logout captured during a provider
        // switch must not overwrite the new config with an old persistence snapshot.
        const logout = this.adminQueue.then(async () => {
          browser.ended = true;
          this.endStreams(hash);
          const revoked = this.credentials.filter((c) => c.hash === hash);
          await this.revokeCredentials(revoked, "pairing-ended");
        });
        this.adminQueue = logout.catch(() => undefined);
        await logout;
        if (!lan)
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${external ? "; Secure" : ""}`,
          );
        return this.json(res, 200, { ok: true });
      }
      if (path === REMOTE_ROUTE.managedSettingsPrepare) {
        requireConversationProtocol(req);
        return this.prepareClaudeSettings(res, hash, body);
      }
      if (path === REMOTE_ROUTE.managedProjectAgent) {
        const assigning = isProjectAgentAssignmentControl(req.method, path, body.operation);
        if (control.request && !assigning)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
        if (assigning) {
          control.request = true;
          if (url.searchParams.getAll("operation").some((hint) => hint !== body.operation))
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
          requireConversationProtocol(req);
        }
        return this.projectAgent(res, hash, "POST", body, assigning ? control : undefined);
      }
      // Opens a terminal on this computer for Devin CLI's own login or workspace trust, so only
      // the desktop app itself may ask; remote devices only see the explanation.
      if (path === REMOTE_ROUTE.devinTerminal) {
        if (!trustedLocal || lan) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.ownerRequired);
        const action = body.action === "login" || body.action === "trust" ? body.action : null;
        if (!action) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
        const params: Record<string, unknown> = { operation: "devin-terminal", action };
        if (action === "trust")
          params.workspaceId =
            body.sessionId !== undefined
              ? await this.codexScope(this.field(body.sessionId), hash, false, false)
              : this.field(body.workspaceId);
        return this.json(res, 200, await this.requestSession(params));
      }
      if (path.startsWith(REMOTE_ROUTE_PREFIXES.managed))
        return this.manage(
          req,
          res,
          hash,
          path.slice(REMOTE_ROUTE_PREFIXES.managed.length),
          body,
          control,
        );
      if (path === REMOTE_ROUTE.artifactTickets) {
        const scope = await this.fileScope(hash, this.field(body.workspaceId));
        const artifacts = this.artifactsFor(scope.deviceId);
        if (!artifacts) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.previewUnavailable);
        const result = await artifacts.issueTicket(scope, {
          artifactId: this.field(body.artifactId),
          ...(body.expectedRevision !== undefined
            ? { expectedRevision: this.field(body.expectedRevision) }
            : {}),
          download: body.download === true,
        });
        this.grant(hash, REMOTE_CAPABILITIES.device.files);
        return this.json(res, 200, result);
      }
      if (path === REMOTE_ROUTE.livePreviewTickets) {
        const device = this.fullAccess(hash, "advancedControl");
        const live = this.livePreview;
        if (!live) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.previewUnavailable);
        const ticket = await live
          .issue(device.id, { port: body.port, path: body.path, secure: body.secure })
          .catch((error: unknown) => {
            if (error instanceof LivePreviewError)
              throw new HttpError(
                error.status,
                parseRemoteErrorCode(error.code) ?? REMOTE_ERROR_CODES.requestFailed,
              );
            throw error;
          });
        // Access can end while the port is probed; the ticket then dies on first use.
        this.fullAccess(hash, "advancedControl");
        return this.json(res, 200, ticket);
      }
      if (
        ![REMOTE_ROUTE.send, REMOTE_ROUTE.stop, REMOTE_ROUTE.approve, REMOTE_ROUTE.answer].some(
          (route) => route === path,
        )
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
      const operation = path.slice(1);
      const permission = operation === "approve" ? "approve" : "send";
      this.grant(hash, permission);
      const interactionDecisionId =
        body.interactionDecisionId === undefined
          ? undefined
          : this.field(body.interactionDecisionId, 512);
      if (
        interactionDecisionId &&
        ((operation !== "approve" && operation !== "answer") ||
          body.decision !== undefined ||
          body.nativeDecision !== undefined)
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidDecision);
      const interactionRuntimeBootId = interactionDecisionId
        ? this.field(body.interactionRuntimeBootId)
        : undefined;
      const requestId = this.field(body.requestId, 128);
      if (
        interactionDecisionId &&
        !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(requestId)
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
      const pushSubscription =
        body.pushActionToken === undefined ? undefined : this.pushActionSubscription(hash);
      const pushAction =
        pushSubscription && operation === "approve" && interactionDecisionId
          ? this.pushApprovalActions.verify(
              this.grant(hash, permission).id,
              body,
              pushSubscription.updatedAt,
            )
          : undefined;
      if (body.pushActionToken !== undefined && !pushAction)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.pushActionUnavailable);
      const checkPushAction = () => {
        if (!pushAction) return;
        if (pushAction.expiresAt <= Date.now())
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.interactionExpired);
        if (this.pushActionSubscription(hash) !== pushSubscription)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.pushActionUnavailable);
      };
      const prior = await this.controlReceipt(requestId, this.grant(hash, permission).id, control);
      const sessionId = this.field(body.sessionId);
      if (this.isFullAccess(this.grant(hash)))
        await this.codexScope(sessionId, hash, path === REMOTE_ROUTE.stream, false);
      if (body.historyReferences !== undefined || prior?.historyInputHash)
        await this.historyTargetScope(sessionId, hash);
      if (!this.controlsEnabled(sessionId, this.grant(hash)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionControlNotAllowed);
      if (body.historyReferences !== undefined && operation !== "send")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.historyReferencesNotSupported);
      this.grant(hash, permission);
      if (interactionDecisionId && prior?.found === true) {
        // The acknowledged payload stays on the device-bound receipt endpoint.
        // Never dispatch a second native decision to verify an already used ID.
        const conflict = prior.sessionId !== sessionId || prior.operation !== operation;
        control.priorUncertain = !["accepted", REMOTE_CONTROL_OUTCOMES.notDispatched].includes(
          String(prior.status),
        );
        if (conflict) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.requestIdConflict);
        if (control.priorUncertain)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.outcomeUnknown);
        if (
          prior.status === REMOTE_CONTROL_OUTCOMES.notDispatched &&
          expiredInteractionRefusal(prior.ack)
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.interactionExpired);
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.duplicateRequest);
      }
      checkPushAction();
      const historyReplay = this.historyReplay(prior, body, operation, control);
      if (historyReplay !== undefined) return this.json(res, 200, historyReplay);
      if (body.bootId !== this.bootId) {
        if (
          this.options.sessionRequest &&
          typeof body.bootId === "string" &&
          body.bootId.length > 0 &&
          (operation === "approve" || operation === "answer")
        ) {
          const source = this.approvalAuditSource(
            hash,
            this.grant(hash, permission),
            req.headers["x-agentkib-client"],
          );
          void this.recordStaleClientApproval(
            hash,
            source,
            { ...body, operation, sessionId, requestId },
            permission,
            interactionDecisionId,
          ).catch(() => undefined);
        }
        throw new HttpError(
          409,
          interactionDecisionId
            ? REMOTE_ERROR_CODES.interactionExpired
            : REMOTE_ERROR_CODES.staleBoot,
          undefined,
          interactionDecisionId ? REMOTE_ERROR_CODES.interactionStateChanged : undefined,
        );
      }
      // Bridged and managed providers replay a receipted request from their own ledger.
      const claudeReplay =
        prior?.found === true &&
        prior.sessionId === sessionId &&
        ["claude-managed", "claude-follower", "dsh-follower"].includes(String(prior.executionMode));
      this.grant(hash, permission);
      if (!claudeReplay && this.requests.has(requestId)) {
        control.priorUncertain = true;
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.duplicateRequest);
      }
      if (this.active.has(sessionId))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
      if (!claudeReplay && this.outcomeFences.blocks(sessionId, operation)) {
        control.priorUncertain = this.requests.has(requestId);
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.outcomeUnknown);
      }
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidRevision);
      const params: Record<string, unknown> = {
        operation,
        sessionId,
        requestId,
        deviceId: this.grant(hash, permission).id,
        expectedRevision: body.expectedRevision,
        experimentalEnabled: true,
      };
      let frozenText =
        body.text === undefined && body.historyReferences !== undefined ? "" : body.text;
      let historyScopeKey: string | undefined;
      if (operation === "send") {
        if (
          typeof frozenText !== "string" ||
          (!frozenText.trim() &&
            body.historyReferences === undefined &&
            !(Array.isArray(body.attachmentIds) && body.attachmentIds.length)) ||
          frozenText.length > 16_000 ||
          Buffer.byteLength(frozenText, "utf8") > 16_384
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidText);
        params.text = frozenText;
      } else if (operation === "stop") {
        params.turnId = this.field(body.turnId);
      } else if (operation === "answer") {
        params.turnId = this.field(body.turnId);
        params.questionId =
          typeof body.questionId === "number" &&
          Number.isSafeInteger(body.questionId) &&
          body.questionId >= 0
            ? body.questionId
            : this.field(body.questionId);
        if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAnswers);
        const entries = Object.entries(body.answers);
        if (
          !entries.length ||
          entries.length > 32 ||
          entries.some(
            ([key, values]) =>
              !key ||
              key.length > 4096 ||
              !Array.isArray(values) ||
              !values.length ||
              values.length > 64 ||
              values.some(
                (value) =>
                  typeof value !== "string" ||
                  !value.trim() ||
                  value.length > 4096 ||
                  Buffer.byteLength(value, "utf8") > 8192,
              ) ||
              new Set(values).size !== values.length,
          )
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAnswers);
        params.answers = body.answers;
        if (body.answerNotes !== undefined) params.answerNotes = body.answerNotes;
      } else {
        params.turnId = this.field(body.turnId);
        params.approvalId =
          typeof body.approvalId === "number" && Number.isSafeInteger(body.approvalId)
            ? body.approvalId
            : this.field(body.approvalId);
        if (body.nativeDecision !== undefined) {
          this.grant(hash, REMOTE_CAPABILITIES.device.extendedApproval);
          if (JSON.stringify(body.nativeDecision).length > 16384)
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidDecision);
          params.nativeDecision = body.nativeDecision;
          params.decision = typeof body.decision === "string" ? body.decision : "native";
        } else if (!interactionDecisionId) params.decision = this.field(body.decision);
      }
      if (this.admission) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.operationBusy);
      this.rate(`control:${hash}`, 30);
      if (!interactionDecisionId) rememberRequest(this.requests, requestId);
      this.active.add(sessionId);
      this.admission = true;
      const boot = this.bootId;
      let dispatched = false;
      let newlyPinnedDevice: string | undefined;
      try {
        const snapshot = (await this.runtime(
          {
            operation: "live",
            sessionId,
            experimentalEnabled: true,
          },
          undefined,
          true,
        )) as {
          runtimeBootId?: string;
          revision?: number;
          status?: string;
          executionMode?: string;
          turnId?: string;
          sendEnabled?: boolean;
          stopEnabled?: boolean;
          questions?: {
            requestId: unknown;
            turnId: string;
            supported: boolean;
            questions: {
              id: string;
              multiSelect: boolean;
              allowCustom: boolean;
              options: { label: string }[];
            }[];
          }[];
          approvals?: {
            requestId: unknown;
            turnId: string;
            supported: boolean;
            availableDecisions: string[];
            decisionOptions?: { decision: unknown }[];
            requiresExtendedApproval?: boolean;
          }[];
        };
        this.grant(hash, permission);
        if (boot !== this.bootId)
          throw new HttpError(
            409,
            interactionDecisionId
              ? REMOTE_ERROR_CODES.interactionExpired
              : REMOTE_ERROR_CODES.staleBoot,
            undefined,
            interactionDecisionId ? REMOTE_ERROR_CODES.interactionStateChanged : undefined,
          );
        if (!(await this.controlsEnabledForSnapshot(sessionId, snapshot, this.grant(hash), true)))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.providerControlNotAllowed);
        let approvalAudit =
          this.options.sessionRequest && (operation === "approve" || operation === "answer")
            ? this.approvalAuditSource(
                hash,
                this.grant(hash, permission),
                req.headers["x-agentkib-client"],
              )
            : undefined;
        if (
          !snapshot?.runtimeBootId ||
          (interactionRuntimeBootId && snapshot.runtimeBootId !== interactionRuntimeBootId) ||
          (!claudeReplay && snapshot.revision !== body.expectedRevision)
        ) {
          if (approvalAudit && snapshot?.runtimeBootId)
            void this.recordExpiredApproval(
              approvalAudit,
              snapshot,
              params,
              interactionDecisionId
                ? { id: interactionDecisionId, device: this.grant(hash, permission) }
                : undefined,
            );
          throw new HttpError(
            409,
            interactionDecisionId
              ? REMOTE_ERROR_CODES.interactionExpired
              : REMOTE_ERROR_CODES.staleState,
            undefined,
            interactionDecisionId ? REMOTE_ERROR_CODES.interactionStateChanged : undefined,
          );
        }
        if (
          !claudeReplay &&
          operation === "send" &&
          (snapshot as { activity?: string }).activity === "compacting"
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionCompacting);
        if (!claudeReplay && operation === "send" && snapshot.sendEnabled !== true)
          throw new HttpError(
            409,
            continuationPreflightReason(
              snapshotField(snapshot, "ownershipReason") ?? snapshotField(snapshot, "reason"),
              REMOTE_ERROR_CODES.controlUnavailable,
            ),
          );
        if (
          !claudeReplay &&
          operation === "stop" &&
          (snapshot.stopEnabled !== true || snapshot.turnId !== params.turnId)
        )
          throw HttpError.fromContract(
            REMOTE_ERROR_CONTRACT.turnUnavailable,
            stopRefusal(snapshot, params.turnId),
          );
        if (!claudeReplay && operation === "answer") {
          const question = snapshot.questions?.find(
            (item) =>
              item.requestId === params.questionId &&
              item.turnId === params.turnId &&
              item.supported === true,
          );
          if (!question || !Array.isArray(question.questions) || !question.questions.length)
            throw new HttpError(
              409,
              interactionDecisionId
                ? REMOTE_ERROR_CODES.interactionExpired
                : REMOTE_ERROR_CODES.questionUnavailable,
              undefined,
              pendingInteractionRefusal(snapshot, "questions", params.questionId, params.turnId),
            );
          const answers = body.answers as Record<string, string[]>;
          if (
            Object.keys(answers).length !== question.questions.length ||
            new Set(question.questions.map((item) => item.id)).size !== question.questions.length ||
            question.questions.some((item) => {
              const values = Object.hasOwn(answers, item.id) ? answers[item.id] : undefined;
              return (
                !values ||
                (item.multiSelect !== true && values.length !== 1) ||
                !Array.isArray(item.options) ||
                (item.allowCustom !== true &&
                  values.some((value) => !item.options.some((option) => option.label === value)))
              );
            })
          )
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAnswers);
        }
        if (
          permission === "approve" &&
          snapshot.approvals?.find((item) => item.requestId === params.approvalId)
            ?.requiresExtendedApproval === true
        )
          this.grant(hash, REMOTE_CAPABILITIES.device.extendedApproval);
        const approval =
          operation === "approve"
            ? snapshot.approvals?.find(
                (item) =>
                  item.requestId === params.approvalId &&
                  item.turnId === params.turnId &&
                  item.supported === true,
              )
            : undefined;
        if (!claudeReplay && interactionDecisionId) {
          const device = this.grant(hash, permission);
          const descriptions = await this.pendingInteractionDescriptions(
            sessionId,
            snapshot,
            device,
            true,
            true,
          );
          if (
            !(await this.controlsEnabledForSnapshot(sessionId, snapshot, device, true)) ||
            device !== this.grant(hash, permission)
          )
            throw new HttpError(
              REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
              REMOTE_ERROR_CODES.accessChanged,
            );
          if (boot !== this.bootId)
            throw HttpError.fromContract(
              REMOTE_ERROR_CONTRACT.interactionExpired,
              REMOTE_ERROR_CODES.interactionStateChanged,
            );
          const interaction = interactionFor(
            descriptions,
            operation === "approve" ? "approval" : "question",
            operation === "approve" ? params.approvalId : params.questionId,
            params.turnId,
          );
          if (!interaction)
            throw HttpError.fromContract(
              REMOTE_ERROR_CONTRACT.interactionExpired,
              operation === "approve"
                ? pendingInteractionRefusal(snapshot, "approvals", params.approvalId, params.turnId)
                : pendingInteractionRefusal(
                    snapshot,
                    "questions",
                    params.questionId,
                    params.turnId,
                  ),
            );
          const selected = resolvePendingInteractionDecision(
            interaction,
            approval,
            interactionDecisionId,
          );
          if (!selected?.decision.available)
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.interactionDecisionUnavailable);
          if (selected.nativeDecision !== undefined) {
            this.grant(hash, REMOTE_CAPABILITIES.device.extendedApproval);
            params.nativeDecision = selected.nativeDecision;
            params.decision = "native";
          } else if (selected.nativeChoice !== undefined) {
            params.decision = selected.nativeChoice;
          }
        }
        if (!claudeReplay && operation === "approve" && !nativeApprovalOffered(approval, params)) {
          throw HttpError.fromContract(
            REMOTE_ERROR_CONTRACT.approvalUnavailable,
            approval
              ? REMOTE_ERROR_CODES.interactionDecisionUnavailable
              : pendingInteractionRefusal(snapshot, "approvals", params.approvalId, params.turnId),
          );
        }
        if (operation === "send" && body.historyReferences !== undefined) {
          const history = await this.resolveHistoryInput(body, hash, operation, true);
          frozenText = history.text;
          historyScopeKey = history.scopeKey;
          params.text = frozenText;
          params.historyReferences = history.references;
          params.historyInputHash = history.inputHash;
          if (
            !history.text.trim() &&
            !(Array.isArray(body.attachmentIds) && body.attachmentIds.length)
          )
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidText);
        }
        if (operation === "send" && snapshotField(snapshot, "executionMode") === "dsh-follower")
          params.commandAccess = this.dshCommandAccess(this.grant(hash, permission));
        if (operation === "send" && body.attachmentIds !== undefined) {
          const device = this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
          const workspaceId = await this.codexScope(sessionId, hash, true, false);
          const capabilities = (await this.requestSession({
            operation: "capabilities",
            sessionId,
            experimentalEnabled: true,
          })) as { features?: Record<string, AttachmentAvailability> };
          if (!claudeReplay && capabilities.features?.attachments?.available !== true)
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsUnavailable);
          const mode = (snapshot as { executionMode?: string }).executionMode;
          if (claudeReplay && body.resourceIds === undefined) {
            const previous = await replayClaudeAttachments(this.attachmentStore, prior, {
              deviceId: device.id,
              sessionId,
              requestId,
              expectedRevision: body.expectedRevision,
              attachmentIds: body.attachmentIds,
              text: String(frozenText ?? ""),
            });
            this.grant(hash, permission);
            this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
            if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
            if (previous) {
              if (previous.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched) {
                control.priorUncertain = false;
                throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.controlPreflightRejected);
              }
              control.priorUncertain = previous.accepted !== true;
              if (previous.accepted !== true)
                throw new HttpError(
                  REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseUnconfirmed,
                  REMOTE_ERROR_CODES.outcomeUnknown,
                );
              return this.json(res, 200, previous);
            }
            if (prior?.executionMode === "claude-follower")
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.requestConflict);
          }
          const format = attachmentInputFormat(
            ATTACHMENT_FORMATS[mode ?? ""],
            capabilities.features?.attachments,
          );
          if (!format) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsUnavailable);
          const pinnedFormat = format === "claude" || format === "claude-terminal";
          const alreadyPinned =
            pinnedFormat &&
            (await this.attachmentStore.pendingRequests(sessionId)).some(
              (item) => item.deviceId === device.id && item.requestId === requestId,
            );
          const text = String(frozenText ?? "");
          if (format === "claude-terminal") {
            if (snapshotField(snapshot, "workspaceId") !== workspaceId)
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
            params.input = await this.terminalAttachmentInput(hash, workspaceId, {
              deviceId: device.id,
              sessionId,
              ids: body.attachmentIds,
              text,
              requestId,
            });
          } else {
            params.input =
              format === "claude"
                ? await this.attachmentStore.inputForAgent(
                    device.id,
                    sessionId,
                    body.attachmentIds,
                    text,
                    format,
                    requestId,
                  )
                : await this.attachmentStore.input(
                    device.id,
                    sessionId,
                    body.attachmentIds,
                    text,
                    format,
                  );
          }
          if (pinnedFormat && !alreadyPinned) newlyPinnedDevice = device.id;
          delete params.text;
          this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
        }
        if (operation === "send" && body.resourceIds !== undefined) {
          this.fullAccess(hash);
          const capabilities = (await this.requestSession({
            operation: "capabilities",
            sessionId,
            experimentalEnabled: true,
          })) as { features?: Record<string, { available: boolean }> };
          if (
            capabilities.features?.context?.available !== true &&
            (capabilities.features?.context !== undefined ||
              capabilities.features?.resources?.available !== true)
          )
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.contextUnavailable);
          const resourceRefs =
            (await this.resolveContextResources(
              sessionId,
              hash,
              body.resourceIds,
              body.expectedRevision,
              true,
              snapshot.executionMode === "codex-managed"
                ? "codex"
                : snapshot.executionMode === "claude-managed"
                  ? "claude-code"
                  : undefined,
            )) ?? [];
          const inputRows = Array.isArray(params.input) ? params.input.length : 1;
          if (inputRows > 11 || resourceRefs.length > 32)
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.tooManyInputItems);
          params.resourceRefs = resourceRefs;
        }
        this.grant(hash, permission);
        if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
        if (historyScopeKey) await this.assertHistoryScope(hash, historyScopeKey, true);
        if (approvalAudit && !claudeReplay) {
          approvalAudit = {
            ...approvalAudit,
            ...(await this.readApprovalEvidence(snapshot, params)),
          };
          const current = this.grant(hash, permission);
          if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
          if (!(await this.controlsEnabledForSnapshot(sessionId, snapshot, current, true)))
            throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.providerControlNotAllowed);
        }
        if (
          lan &&
          isCodexMode(snapshotField(snapshot, "executionMode")) &&
          !(await this.lanCodexScopeAllowed(
            sessionId,
            String(snapshotField(snapshot, "workspaceId")),
            true,
          ))
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
        const device = this.grant(hash, permission);
        if (
          operation === "send" &&
          this.scheduler &&
          isCodexMode(snapshotField(snapshot, "executionMode")) &&
          (lan || device.advancedControl === true)
        )
          params.allowOwnerWait = true;
        const restrictCodexNativePolicy = operation === "send" && !this.isFullAccess(device);
        checkPushAction();
        if (
          pushAction &&
          (params.nativeDecision !== undefined || approval?.requiresExtendedApproval)
        )
          this.grant(hash, REMOTE_CAPABILITIES.device.extendedApproval);
        params.runtimeBootId = snapshot.runtimeBootId;
        rememberRequest(this.requests, requestId);
        dispatched = true;
        control.dispatched = true;
        this.requestTraces.get(res)?.markDispatched();
        this.outcomeFences.record({
          sessionId,
          requestId,
          operation,
          deviceId: String(params.deviceId),
        });
        const pending = (
          ["claude-managed", "claude-follower"].includes(
            String((snapshot as { executionMode?: string }).executionMode),
          ) && this.options.receiptRequest
            ? dispatchClaude(
                (value) => this.requestSession(value, undefined, false, approvalAudit),
                this.options.receiptRequest,
                params,
              )
            : this.requestSession(params, undefined, restrictCodexNativePolicy, approvalAudit)
        ).finally(() => {
          this.active.delete(sessionId);
          this.admission = false;
          this.notifyControlChanged(sessionId);
        });
        const result = await this.runtime(params, pending);
        // Runtime admission is not owner dispatch: the bridge rechecks state
        // under its operation lock. Only a correlated definitive rejection can
        // release this fence; timeouts and unrecognized responses stay uncertain.
        if (
          typeof result === "object" &&
          result !== null &&
          "accepted" in result &&
          result.accepted === false &&
          "completed" in result &&
          result.completed === false &&
          "controlOutcome" in result &&
          result.controlOutcome === REMOTE_CONTROL_OUTCOMES.notDispatched &&
          "requestId" in result &&
          result.requestId === requestId &&
          "runtimeBootId" in result &&
          result.runtimeBootId === snapshot.runtimeBootId
        ) {
          this.settleOutcome(sessionId, requestId);
          control.dispatched = false;
          control.priorUncertain = false;
          if (newlyPinnedDevice || snapshot.executionMode === "claude-managed")
            await this.attachmentStore.settle(String(params.deviceId), sessionId, requestId);
          this.grant(hash, permission);
          if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
          if (interactionDecisionId && expiredInteractionRefusal(result)) {
            this.requests.delete(requestId);
            throw HttpError.fromContract(
              REMOTE_ERROR_CONTRACT.interactionExpired,
              REMOTE_ERROR_CODES.interactionStateChanged,
            );
          }
          throw new HttpError(
            409,
            continuationPreflightReason(
              (result as { reason?: string; error?: string }).reason ??
                (result as { error?: string }).error,
            ),
          );
        }
        this.grant(hash, permission);
        if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
        if (
          lan &&
          isCodexMode(snapshotField(snapshot, "executionMode")) &&
          !(await this.lanCodexScopeAllowed(
            sessionId,
            String(snapshotField(snapshot, "workspaceId")),
            true,
          ))
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
        this.grant(hash, permission);
        if (
          typeof result !== "object" ||
          result === null ||
          !("accepted" in result) ||
          result.accepted !== true
        )
          throw new HttpError(
            REMOTE_ERROR_CONTRACT.outcomeUnknown.http.overrides.runtimeResponseUnconfirmed,
            REMOTE_ERROR_CODES.outcomeUnknown,
          );
        res.once("finish", () => {
          // Node finish confirms the server wrote the response, not that a
          // browser received it. No automatic resend is safe even after this.
          if (
            boot === this.bootId &&
            !res.destroyed &&
            res.statusCode === 200 &&
            typeof result === "object" &&
            result !== null &&
            "accepted" in result &&
            result.accepted === true
          )
            this.settleOutcome(sessionId, requestId);
        });
        return this.json(res, 200, result);
      } finally {
        if (!dispatched) {
          if (newlyPinnedDevice)
            await this.attachmentStore.settle(newlyPinnedDevice, sessionId, requestId);
          this.active.delete(sessionId);
          this.admission = false;
        }
      }
    }
    if (req.method !== "GET") throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.methodNotAllowed);
    this.grant(hash);
    if (path === REMOTE_ROUTE.pushPolicy || path === REMOTE_ROUTE.pushActivity) {
      if (url.search) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidNotificationQuery);
      if (!this.options.notificationPolicy)
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.handlerUnavailable,
          REMOTE_ERROR_CODES.capabilityUnavailable,
        );
      const payload =
        path === REMOTE_ROUTE.pushPolicy
          ? await this.notificationPolicy(hash)
          : { activity: (await this.notificationActivity(hash)).snapshot };
      return this.json(res, 200, payload);
    }
    if (path === REMOTE_ROUTE.approvalAudit) return this.approvalAuditPage(res, hash, url);
    if (path === REMOTE_ROUTE.approvalRules) {
      if (
        [...url.searchParams.keys()].some((key) => key !== "workspaceId") ||
        url.searchParams.getAll("workspaceId").length > 1
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidApprovalRuleRequest);
      const workspaceId = url.searchParams.get("workspaceId");
      return this.approvalRuleRequest(
        res,
        hash,
        workspaceId === null ? undefined : this.field(workspaceId),
      );
    }
    if (path === REMOTE_ROUTE.readState) {
      if (
        [...url.searchParams.keys()].some((key) => key !== "sessionId") ||
        url.searchParams.getAll("sessionId").length !== 1
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidReadStateRequest);
      return this.conversationReadState(res, hash, this.field(url.searchParams.get("sessionId")));
    }
    if (path === REMOTE_ROUTE.sessionImages) {
      if (
        [...url.searchParams.keys()].some((key) => !["sessionId", "imageId"].includes(key)) ||
        url.searchParams.getAll("sessionId").length !== 1 ||
        url.searchParams.getAll("imageId").length !== 1
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidImageRequest);
      return this.conversationSessionImage(
        res,
        hash,
        this.field(url.searchParams.get("sessionId")),
        this.field(url.searchParams.get("imageId"), 512),
      );
    }
    if (path === REMOTE_ROUTE.historyStatus) {
      if (url.search) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidHistoryRequest);
      const scope = await this.historyScope(hash, true);
      const result = await this.historyCall(
        HISTORY_SEARCH_METHODS.status,
        {
          allowedSessionIds: scope.allowedSessionIds,
        },
        res,
      );
      await this.assertHistoryScope(hash, scope.key, true);
      return this.json(res, 200, result);
    }
    if (path === REMOTE_ROUTE.attachments) {
      if (lan) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.attachmentsRequireSameOrigin);
      const device = this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
      const attachments = await this.attachmentStore.list(
        device.id,
        this.field(url.searchParams.get("sessionId")),
      );
      this.grant(hash, REMOTE_CAPABILITIES.device.attachments);
      return this.json(res, 200, { attachments });
    }
    if (
      !legacyCodex &&
      path === REMOTE_ROUTE.managedResources &&
      url.searchParams.has("workspaceId")
    )
      return this.json(res, 200, await this.newSessionResources(hash, url));
    if (
      path === REMOTE_ROUTE.managedSettings ||
      path === REMOTE_ROUTE.managedGoals ||
      path === REMOTE_ROUTE.managedResources
    ) {
      const sessionId = this.field(url.searchParams.get("sessionId"));
      // 与 projectCapabilities 一致：settings-state/usage/goal/context 都属于 advancedControl，
      // 只读设备即便是 full 模式也不能读取。
      const device = this.fullAccess(hash, "advancedControl");
      const scope = await this.sessionScope(sessionId, hash, false, legacyCodex);
      const workspaceId = scope.workspace_id;
      let result: unknown;
      if (path === REMOTE_ROUTE.managedSettings) {
        const settings = await this.runtime({
          operation: "settings-state",
          sessionId,
          ...(scope.agent === "codex" ? { includeHistorical: true } : {}),
        });
        this.fullAccess(hash, "advancedControl");
        const provider = this.projectSessionProvider(snapshotField(settings, "provider"));
        const usage =
          provider?.contextUsage === "last-request"
            ? undefined
            : await this.runtime({ operation: "usage", sessionId }).catch((error) => {
                // Keep any history already returned with the settings.
                if (
                  !settings ||
                  typeof settings !== "object" ||
                  (!("historicalSettings" in settings) && !("historicalUsage" in settings))
                )
                  throw error;
                return undefined;
              });
        result = { sessionId, ...this.projectSettings(settings, usage) };
      } else if (path === REMOTE_ROUTE.managedGoals) {
        const goal = await this.runtime({ operation: "goal", sessionId });
        this.fullAccess(hash, "advancedControl");
        const capabilities = await this.runtime({
          operation: "capabilities",
          sessionId,
          experimentalEnabled: true,
        });
        result = {
          sessionId,
          ...this.projectGoal(goal, capabilities),
        };
      } else {
        const directoryId = url.searchParams.get("directoryId") ?? undefined;
        if (directoryId && directoryId.length > 128)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidDirectoryId);
        result = (await this.contextResources(sessionId, device, workspaceId, directoryId))
          .response;
      }
      if (this.fullAccess(hash, "advancedControl").id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      await this.codexScope(sessionId, hash, false, legacyCodex);
      return this.json(res, 200, result);
    }
    if (path === REMOTE_ROUTE.managedProjectAgent)
      return this.projectAgent(res, hash, "GET", {
        operation: url.searchParams.get("operation") ?? "status",
        sessionId: url.searchParams.get("sessionId"),
      });
    if (path === REMOTE_ROUTE.managedCapabilities)
      return this.readSessionCapabilities(res, hash, url, legacyCodex);
    if (path === REMOTE_ROUTE.managedQueue) {
      if (!legacyCodex && this.options.mode === "lan")
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.capabilityUnavailable.http.overrides.routeDenied,
          REMOTE_ERROR_CODES.capabilityUnavailable,
        );
      const sessionId = this.field(url.searchParams.get("sessionId"));
      const permission = lan ? "send" : "advancedControl";
      const device = this.grant(hash, permission);
      const workspaceId = await this.queueScope(sessionId, hash, false, legacyCodex);
      if (this.grant(hash, permission).id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      const result = lan
        ? {
            data: (await this.ownerWaitQueue(sessionId, workspaceId)).filter(
              (item) => item.ownerWaitDeviceId === device.id,
            ),
          }
        : ((await this.runtime({ operation: "queue-list", sessionId })) as {
            data?: QueueEntry[];
            reason?: string;
          });
      if ((await this.queueScope(sessionId, hash, false, legacyCodex)) !== workspaceId)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      const current = this.grant(hash, permission);
      if (current.id !== device.id) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if ("reason" in result && result.reason === "queue-too-large")
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.queueTooLarge);
      const entries = result.data ?? [];
      return this.json(res, 200, {
        sessionId,
        ...(!legacyCodex
          ? {
              paused: snapshotField(result, "paused") === true,
              requiresResume: snapshotField(result, "requiresResume") === true,
            }
          : {}),
        data: entries.map((item) => ({
          id: item.id,
          ...(item.status && ["pending", "claimed", "dispatched", "unknown"].includes(item.status)
            ? { status: item.status }
            : {}),
          ...(isOwnerWaitQueueEntry(item, workspaceId)
            ? {
                reason: item.reason,
                actions: {
                  update: { available: false, reason: item.reason },
                  delete: { available: canDeleteOwnerWait(item, current.id) },
                  ...(!lan ? { reorder: { available: false }, steer: { available: false } } : {}),
                },
              }
            : !legacyCodex && item.actions
              ? {
                  actions: {
                    ...item.actions,
                    ...(item.actions.steer
                      ? {
                          steer: {
                            available:
                              item.actions.steer.available &&
                              current.send === true &&
                              (item.queueSteerDeviceId === undefined ||
                                item.queueSteerDeviceId === current.id),
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          hasAttachments: queueEntryHasAttachments(item),
          text: (item.input ?? [])
            .filter(
              (input) => input.type === "text" && !input.text?.startsWith("User attached file "),
            )
            .map((input) => input.text ?? "")
            .join("\n"),
        })),
      });
    }
    if (path.startsWith(REMOTE_ROUTE_PREFIXES.requests)) {
      const device = this.grant(hash);
      const requestId = this.field(path.slice(REMOTE_ROUTE_PREFIXES.requests.length), 128);
      if (!/^[a-f0-9-]{36}$/i.test(requestId))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidInput);
      if (!this.options.receiptRequest)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.receiptUnavailable);
      const result = (await this.runtime(
        { operation: "receipt" },
        this.options.receiptRequest({ requestId, deviceId: device.id }),
      )) as {
        found: boolean;
        requestId: string;
        sessionId?: string;
        workspaceId?: string;
        operation?: string;
        executionMode?: string;
        status?: string;
        recovery?: unknown;
        completionObserved?: unknown;
        ack?: unknown;
      };
      this.grant(hash);
      if (result.recovery !== undefined) {
        if (
          result.found !== true ||
          result.requestId !== requestId ||
          result.status !== REMOTE_CONTROL_OUTCOMES.notDispatched ||
          result.recovery !== "legacy-prepared" ||
          result.completionObserved !== false
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.receiptUnavailable);
        const fence = this.outcomeFences.get(requestId);
        if (fence?.deviceId === device.id && !this.active.has(fence.sessionId))
          this.settleOutcome(fence.sessionId, requestId);
        // Old prepared claims may lack ownership and operation metadata. Expose
        // only the durable non-dispatch proof, never runtime metadata or an ack.
        return this.json(res, 200, {
          found: true,
          requestId,
          status: REMOTE_CONTROL_OUTCOMES.notDispatched,
          recovery: "legacy-prepared",
          completionObserved: false,
        });
      }
      if (result.found) {
        if (result.operation?.startsWith("goal-")) this.fullAccess(hash);
        const ownWaitDelete =
          lan &&
          result.operation === "queue-delete" &&
          isCodexMode(result.executionMode) &&
          snapshotField(result.ack, "ownerWaitOnly") === true;
        const permission = ownWaitDelete
          ? "send"
          : result.operation === "approve"
            ? "approve"
            : ["create", "adopt", "release", "reconcile"].includes(result.operation ?? "")
              ? "manage"
              : [
                    "steer",
                    "queue-add",
                    "queue-update",
                    "queue-delete",
                    "queue-steer",
                    "queue-reorder",
                    "queue-start",
                    "queue-pause",
                    "queue-resume",
                    "rename",
                    "archive",
                    "unarchive",
                    "delete",
                    "fork",
                    "settings",
                    "open-model-picker",
                    "goal-set",
                    "goal-pause",
                    "goal-resume",
                    "goal-clear",
                    "resume",
                  ].includes(result.operation ?? "")
                ? this.codexPermission(result.operation!)
                : "send";
        this.grant(hash, permission);
        // Receipt recovery enforces the same workspace boundary as managed controls.
        if (
          result.workspaceId &&
          !(this.options.mode === "lan" && isCodexMode(result.executionMode) && result.sessionId
            ? await this.lanCodexScopeAllowed(result.sessionId, result.workspaceId)
            : await this.workspaceAllowed(result.workspaceId, device))
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
        this.grant(hash, permission);
        if (
          result.operation === "open-model-picker" &&
          result.status === "accepted" &&
          (result.requestId !== requestId ||
            !result.sessionId ||
            correlatedControlOutcome(
              snapshotField(result, "ack"),
              requestId,
              result.sessionId,
              snapshotField(result, "runtimeBootId"),
            ) !== "accepted")
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.receiptUnavailable);
        const fence = this.outcomeFences.get(requestId);
        if (
          result.sessionId &&
          ["accepted", REMOTE_CONTROL_OUTCOMES.notDispatched].includes(result.status ?? "") &&
          result.requestId === requestId &&
          fence?.operation === result.operation &&
          fence?.deviceId === device.id &&
          !this.active.has(result.sessionId)
        ) {
          this.settleOutcome(result.sessionId, requestId);
        }
        if (
          result.operation === "create" &&
          result.status === "accepted" &&
          result.requestId === requestId &&
          ((result.executionMode === "devin-print" &&
            result.sessionId === `devin-create:${requestId}`) ||
            (result.executionMode === "antigravity-acp-managed" &&
              result.sessionId === `antigravity-create:${requestId}`))
        ) {
          // Devin and Antigravity claim the request before a native session exists.
          // Reconciliation uses the outer session ID, so expose the confirmed ID from the
          // stored acknowledgement.
          const ack = snapshotField(result, "ack");
          const sessionId = snapshotField(ack, "sessionId");
          if (
            snapshotField(ack, "requestId") === requestId &&
            snapshotField(ack, "accepted") === true &&
            snapshotField(ack, "completed") === true &&
            typeof sessionId === "string" &&
            /^[a-f0-9]{64}$/.test(sessionId)
          )
            return this.json(res, 200, { ...result, sessionId });
        }
      }
      return this.json(
        res,
        200,
        result.ack === undefined ? result : { ...result, ack: projectQueueActionAck(result.ack) },
      );
    }
    if (path === REMOTE_ROUTE.managedOptions) {
      const requestedWorkspace = url.searchParams.get("workspaceId");
      const workspaceId = requestedWorkspace === null ? undefined : this.field(requestedWorkspace);
      const permission =
        workspaceId !== undefined || this.grant(hash).manage === true ? "manage" : "settings";
      const caller = this.grant(hash, permission);
      const bootId = this.bootId;
      const agent = managedAgentOf(url.searchParams.get("agent") ?? "codex");
      if (!agent) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidAgent);
      if (workspaceId) {
        if (this.options.acceptanceSessionId)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.sessionControlNotAllowed);
        if (!(await this.workspaceAllowed(workspaceId, caller)))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
        this.grant(hash, permission);
        if (this.bootId !== bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      }
      const options = await this.sessionCreationOptions(agent, workspaceId);
      const device = this.grant(hash, permission);
      const workspaces = device.manage === true ? await this.registeredWorkspaces() : [];
      const current = this.grant(hash, permission);
      const allowed = workspaces.filter(
        (w) => this.isFullAccess(current) || this.config.allowedWorkspaceIds?.includes(w.id),
      );
      if (workspaceId) {
        if (this.bootId !== bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
        if (!allowed.some((workspace) => workspace.id === workspaceId))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      }
      return this.json(res, 200, {
        ...(options as object),
        ...this.projectNewSessionOptions(options, current),
        workspaces: allowed.map(({ id, name }) => ({ id, name })),
      });
    }
    if (path === REMOTE_ROUTE.managedInspect)
      return this.readSessionCapabilities(res, hash, url, false, "inspect");
    if (path === REMOTE_ROUTE.managedResumeCommand) {
      const sessionId = this.field(url.searchParams.get("sessionId"));
      const scope = await this.codexResumeCommandScope(sessionId, hash);
      const result = (await this.runtime({ operation: "resume-command", sessionId })) as {
        available?: unknown;
        command?: unknown;
        shell?: unknown;
        runOn?: unknown;
      } | null;
      if ((await this.codexResumeCommandScope(sessionId, hash)) !== scope)
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
          REMOTE_ERROR_CODES.accessChanged,
        );
      if (
        result?.available !== true ||
        typeof result.command !== "string" ||
        !result.command ||
        result.command.length > 32768 ||
        !["posix", "powershell"].includes(String(result.shell)) ||
        result.runOn !== "host"
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.codexContextUnavailable);
      return this.json(res, 200, {
        available: true,
        command: result.command,
        shell: result.shell,
        runOn: "host",
      });
    }
    if (path === REMOTE_ROUTE.managedContext) {
      const id = this.field(url.searchParams.get("sessionId"));
      const device = this.grant(hash);
      const catalog = (await this.scopeCatalog()) as {
        sessions: { id: string; workspace_id: string; agent: string }[];
      };
      const session = catalog.sessions.find(
        (entry) => entry.id === id && ["codex", "claude-code"].includes(entry.agent),
      );
      if (!session || !(await this.workspaceAllowed(session.workspace_id, device)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      const result = await this.runtime({ operation: "context", sessionId: id });
      if (this.grant(hash).id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if (!(await this.workspaceAllowed(session.workspace_id, device)))
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
      return this.json(res, 200, result);
    }
    if (
      path.startsWith(REMOTE_ROUTE_PREFIXES.files) ||
      path === REMOTE_ROUTE.artifacts ||
      path === REMOTE_ROUTE.artifactsResolve ||
      path === REMOTE_ROUTE.diff
    )
      return this.files(res, hash, path, url);
    if (path === REMOTE_ROUTE.subagents || path === REMOTE_ROUTE.subagentEvents) {
      const parentId = this.field(url.searchParams.get("sessionId"));
      const boot = this.bootId;
      const device = this.grant(hash);
      // Children are accessible only through a visible, authorized parent.
      // This does not make auxiliary records normal, controllable sessions.
      const parentScope = async () => {
        const catalog = (await this.scopeCatalog()) as {
          sessions?: {
            id: string;
            agent: string;
            workspace_id: string;
            origin?: string;
            sidechain?: boolean;
          }[];
        };
        const parent = catalog.sessions?.find(
          (entry) =>
            entry.id === parentId &&
            managedAgentOf(entry.agent) &&
            !["auxiliary", "execution"].includes(entry.origin ?? "") &&
            entry.sidechain !== true,
        );
        if (!parent || !(await this.workspaceAllowed(parent.workspace_id, this.grant(hash))))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
        return `${parent.agent}:${parent.workspace_id}`;
      };
      const scope = await parentScope();
      const params: Record<string, unknown> = {
        operation: path === REMOTE_ROUTE.subagents ? "subagents" : "subagent-events",
        sessionId: parentId,
      };
      if (path === REMOTE_ROUTE.subagentEvents) {
        const childId = this.field(url.searchParams.get("subagentId"));
        if (!/^[a-f0-9]{64}$/.test(childId))
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidSubagentId);
        params.subagentId = childId;
        const limit = Number(url.searchParams.get("limit") || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > 50)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidLimit);
        const cursor = url.searchParams.get("cursor");
        if (cursor && cursor.length > 1024)
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidCursor);
        params.limit = limit;
        params.cursor = cursor;
      }
      if (this.grant(hash).id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      let result: unknown;
      try {
        result = await this.runtime(params);
      } catch (error) {
        // Only these read errors are public; never expose native paths or arbitrary
        // runtime exception messages. A missing child does not disable the catalog.
        const errors: Record<string, [number, RemoteErrorCode]> = {
          [REMOTE_ERROR_CODES.invalidRequestDetail]: [400, REMOTE_ERROR_CODES.invalidInput],
          TRANSCRIPT_CURSOR_INVALID: [400, REMOTE_ERROR_CODES.invalidCursor],
          TRANSCRIPT_CURSOR_STALE: [409, REMOTE_ERROR_CODES.staleCursor],
          [REMOTE_ERROR_CODES.subagentUnavailableDetail]: [
            404,
            REMOTE_ERROR_CODES.subagentUnavailable,
          ],
        };
        const mapped =
          error instanceof Error && Object.hasOwn(errors, error.message)
            ? errors[error.message]
            : undefined;
        if (mapped && (path === REMOTE_ROUTE.subagentEvents || mapped[0] !== 404))
          throw new HttpError(...mapped);
        throw error;
      }
      if (this.grant(hash).id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if (scope !== (await parentScope()))
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
          REMOTE_ERROR_CODES.accessChanged,
        );
      // parentScope may await both catalog and workspace registration. Revocation
      // during either wait must still close this final response window.
      if (this.grant(hash).id !== device.id)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessEnded);
      if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      return this.json(res, 200, result);
    }
    const sessionId =
      path === REMOTE_ROUTE.catalog ||
      (path === REMOTE_ROUTE.stream && !url.searchParams.has("sessionId"))
        ? undefined
        : this.field(url.searchParams.get("sessionId"));
    const eventsRead = path === REMOTE_ROUTE.events;
    const localEvents = trustedLocal && eventsRead;
    const liveRead = path === REMOTE_ROUTE.live;
    const detailRead = liveRead || path === REMOTE_ROUTE.stream;
    const scopedDenial = (error: unknown) => {
      if (
        error instanceof HttpError &&
        error.code === REMOTE_ERROR_CODES.workspaceNotAuthorized &&
        detailRead &&
        !this.isFullAccess(this.grant(hash))
      )
        return null;
      throw error;
    };
    const streamWorkspaceId =
      sessionId && !localEvents && !lan
        ? await this.codexScope(sessionId, hash, detailRead, false).catch(scopedDenial)
        : undefined;
    if (liveRead && streamWorkspaceId === null)
      return this.json(res, 200, unavailableLive(sessionId!));
    const recheckReadScope =
      sessionId && streamWorkspaceId
        ? async (verifyFull = false) => {
            if (!verifyFull && this.isFullAccess(this.grant(hash))) return;
            const workspaceId = await this.codexScope(sessionId, hash, true, false);
            if (workspaceId !== streamWorkspaceId)
              throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
          }
        : undefined;
    if (path === REMOTE_ROUTE.stream) {
      if (
        url.searchParams.get("protocolVersion") !== String(CONVERSATION_PROTOCOL_VERSION) ||
        !this.options.conversationHub
      )
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.incompatibleProtocol);
      if (streamWorkspaceId === null) {
        // Older mobile clients treat a detail handshake 403 as device revocation.
        writeStreamHeaders(res);
        return closeStreamResponse(res, "unavailable");
      }
      const watchTaskSummary =
        sessionId === undefined && url.searchParams.get("taskSummary") === "1";
      const patchVersion = url.searchParams.get("catalogPatch");
      const watchCatalogPatch =
        sessionId === undefined &&
        !watchTaskSummary &&
        (patchVersion === "1" || patchVersion === "2");
      const afterCursor =
        url.searchParams.get("afterCursor") ||
        String(req.headers["last-event-id"] ?? "") ||
        undefined;
      if (afterCursor && afterCursor.length > 1024)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidCursor);
      if (!makeRoomForStream(this.streams, hash, sessionId)) {
        res.setHeader("Retry-After", "3");
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.streamLimit);
      }
      writeStreamHeaders(res);
      const hub = this.options.conversationHub;
      let subscriptionId: string | undefined;
      let closed = false;
      let ready = false;
      let processing = false;
      let readyCursor: string | undefined;
      let controlChangedPending = false;
      const catalogChanges = new CatalogChanges();
      let taskSummaryVersion: string | undefined;
      let taskSummaryRetry: ReturnType<typeof setTimeout> | undefined;
      let queuedBytes = 0;
      let cancelDrain: (() => void) | undefined;
      let controlContext: { executionMode?: unknown; workspaceId?: unknown } = {};
      const pendingContext: Record<string, unknown> = {};
      const pendingFields = [
        "approvals",
        "questions",
        "revision",
        "turnId",
        "runtimeBootId",
      ] as const;
      let hasPendingProjection = false;
      const controlMetadata = (live: unknown) => {
        if (!live || typeof live !== "object") return {};
        return {
          executionMode: "executionMode" in live ? live.executionMode : undefined,
          workspaceId: "workspaceId" in live ? live.workspaceId : undefined,
        };
      };
      const queue: SessionStreamEvent[] = [];
      const cleanup = () => {
        if (closed) return;
        closed = true;
        queue.length = 0;
        queuedBytes = 0;
        controlChangedPending = false;
        catalogChanges.clear();
        const blocked = cancelDrain !== undefined;
        cancelDrain?.();
        cancelDrain = undefined;
        if (blocked && !res.destroyed) res.destroy();
        clearInterval(heartbeat);
        clearTimeout(expiration);
        clearTimeout(taskSummaryRetry);
        hub.off("catalog-invalidated", catalogChanged);
        hub.off("unavailable", unavailable);
        this.controlEvents.off("changed", controlChanged);
        this.streams.delete(res);
        if (subscriptionId) void hub.unsubscribe(subscriptionId).catch(() => undefined);
      };
      const authorized = () => {
        const device = this.grant(hash);
        if (
          streamWorkspaceId &&
          !this.isFullAccess(device) &&
          !this.config.allowedWorkspaceIds?.includes(streamWorkspaceId)
        )
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
        return device;
      };
      const unavailable = (
        reason: StreamTermination = REMOTE_ERROR_CODES.streamUnavailable,
        force = false,
      ) => {
        if (closed) return;
        this.requestTraces.streamTerminated(res, streamTerminationReason(reason));
        const blocked = force || cancelDrain !== undefined;
        cleanup();
        closeStreamResponse(res, reason, blocked);
      };
      const failed = (error: unknown) => {
        const hostError = error instanceof HttpError ? error : undefined;
        const code = hostError?.code;
        if (
          sessionId &&
          (code === REMOTE_ERROR_CODES.workspaceNotAuthorized ||
            code === REMOTE_ERROR_CODES.accessChanged)
        )
          return unavailable("unavailable");
        unavailable(streamFailureReason(error, hostError));
      };
      const stopBackpressure = () => unavailable(REMOTE_ERROR_CODES.streamBackpressure, true);
      this.streams.set(res, { hash, sessionId, evict: unavailable });
      const write = async (frame: string) => {
        authorized();
        if (closed || res.destroyed || res.writableEnded) return;
        if (res.write(frame)) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(stopBackpressure, 30_000);
          const drained = () => {
            clearTimeout(timer);
            res.off("drain", drained);
            res.off("close", drained);
            if (cancelDrain === drained) cancelDrain = undefined;
            resolve();
          };
          cancelDrain = drained;
          res.once("drain", drained);
          res.once("close", drained);
        });
      };
      const writeCatalogEvent = async (
        type: "session-ready" | "catalog-invalidated",
        payload: { cursor?: string; catalogPatch?: unknown },
      ): Promise<boolean> => {
        let data = JSON.stringify(payload);
        if (watchTaskSummary) {
          const device = authorized();
          const boot = this.bootId;
          const readerScope = this.readerScope();
          let summary: ConversationTaskSummary | undefined;
          try {
            summary = await this.taskSummary(hash);
          } catch (error) {
            if (!(error instanceof HttpError) || error.code !== REMOTE_ERROR_CODES.operationBusy)
              throw error;
            if (!closed) {
              // Reads wait for write admission to release without tearing down
              // the subscription or losing the last queued invalidation.
              taskSummaryRetry = setTimeout(() => {
                taskSummaryRetry = undefined;
                void flush();
              }, 250);
              taskSummaryRetry.unref();
            }
            return false;
          }
          if (closed || res.destroyed || res.writableEnded) {
            cleanup();
            return false;
          }
          if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
          if (authorized() !== device || readerScope !== this.readerScope())
            throw new HttpError(
              REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
              REMOTE_ERROR_CODES.accessChanged,
            );
          if (summary && summary.version !== taskSummaryVersion) {
            taskSummaryVersion = summary.version;
            const snapshot = JSON.stringify({ ...payload, taskSummary: summary });
            // LAN's SSE parser caps JSON data at 4 MiB. The version lets the
            // subscriber recover larger snapshots from the catalog endpoint.
            data =
              Buffer.byteLength(snapshot) <= 4 * 1024 * 1024
                ? snapshot
                : JSON.stringify({ ...payload, taskSummaryVersion });
          }
        }
        await write(`event: ${type}\ndata: ${data}\n\n`);
        return true;
      };
      const project = async (event: SessionStreamEvent): Promise<SessionStreamEvent> => {
        let device = authorized();
        if (event.type === "snapshot") {
          controlContext = controlMetadata(event.payload.live);
          for (const key of pendingFields)
            pendingContext[key] = snapshotField(event.payload.live, key);
          const live = await this.projectLive(sessionId, event.payload.live, device, true);
          if (device !== authorized())
            throw new HttpError(
              REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
              REMOTE_ERROR_CODES.accessChanged,
            );
          hasPendingProjection = snapshotField(live, "pendingInteractions") !== undefined;
          return {
            ...event,
            payload: {
              ...event.payload,
              live,
            },
          };
        }
        if (event.type !== "state") return event;
        // Keep only authorization metadata, never manufacture absent patch fields
        // or refresh chat state while projecting a native notification.
        const patch = this.projectPermissionField(this.projectUsageFields(event.payload, device));
        const changedSource =
          (pendingContext.runtimeBootId !== undefined &&
            pendingContext.runtimeBootId !== event.runtimeBootId) ||
          ("executionMode" in patch && controlContext.executionMode !== patch.executionMode) ||
          ("workspaceId" in patch && controlContext.workspaceId !== patch.workspaceId);
        if (changedSource) {
          for (const key of pendingFields) delete pendingContext[key];
        }
        if ("executionMode" in patch) controlContext.executionMode = patch.executionMode;
        if ("workspaceId" in patch) controlContext.workspaceId = patch.workspaceId;
        const permitted =
          this.controlsEnabledForProvider(sessionId, controlContext, device) &&
          this.controlWorkspaceAllowed(
            sessionId,
            controlContext,
            device,
            true,
            streamWorkspaceId ?? null,
          );
        let enabled = typeof permitted === "boolean" ? permitted : await permitted;
        device = authorized();
        enabled = enabled && this.controlsEnabledForProvider(sessionId, controlContext, device);
        let pendingInteractions: SessionPendingInteraction[] | undefined;
        if (changedSource || pendingFields.some((key) => key in patch)) {
          for (const key of pendingFields) if (key in patch) pendingContext[key] = patch[key];
          pendingContext.runtimeBootId = event.runtimeBootId;
          const projectedDevice = device;
          if (
            hasPendingRows(pendingContext, "approvals") ||
            hasPendingRows(pendingContext, "questions")
          )
            pendingInteractions = await this.pendingInteractionDescriptions(
              sessionId,
              { ...controlContext, ...pendingContext },
              device,
              enabled,
              true,
            );
          device = authorized();
          if (device !== projectedDevice)
            throw new HttpError(
              REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
              REMOTE_ERROR_CODES.accessChanged,
            );
          if (pendingInteractions?.length || hasPendingProjection)
            patch.pendingInteractions = pendingInteractions ?? [];
          hasPendingProjection = !!pendingInteractions?.length;
        }
        if (Array.isArray(patch.approvals))
          patch.approvals = patch.approvals.map((value) => {
            const approval = value as Record<string, unknown>;
            return {
              ...approval,
              supported:
                approval.supported === true &&
                enabled &&
                device.approve &&
                (!sessionId || !this.interactionOutcomeBlocked(sessionId, "approval")) &&
                (!approval.requiresExtendedApproval || device.extendedApproval === true),
              decisionOptions: device.extendedApproval ? approval.decisionOptions : undefined,
              ...(!enabled && controlContext.executionMode !== "claude-follower"
                ? { availableDecisions: [] }
                : {}),
            };
          });
        if (!device.send || !enabled) {
          if ("sendEnabled" in patch) patch.sendEnabled = false;
          if ("stopEnabled" in patch) patch.stopEnabled = false;
          if (Array.isArray(patch.questions))
            patch.questions = patch.questions.map((question) => ({
              ...question,
              supported: false,
            }));
        }
        if (sessionId) {
          Object.assign(patch, this.scopedOutcomeFlags(sessionId));
          if (
            Array.isArray(patch.questions) &&
            this.interactionOutcomeBlocked(sessionId, "question")
          )
            patch.questions = patch.questions.map((question) => ({
              ...question,
              supported: false,
            }));
        }
        return { ...event, payload: patch };
      };
      const flush = async () => {
        if (processing || !ready || closed) return;
        processing = true;
        try {
          while (queue.length && !closed) {
            const event = queue.shift()!;
            queuedBytes -= Buffer.byteLength(JSON.stringify(event));
            const value = await project(event);
            await write(
              `id: ${value.cursor}\nevent: session-event\ndata: ${JSON.stringify(value)}\n\n`,
            );
            // Backpressure can append newer notifications while replay drains.
            // Readiness must name the last frame preceding the marker.
            if (readyCursor) readyCursor = value.cursor;
          }
          if (controlChangedPending && !closed) {
            controlChangedPending = false;
            // A global receipt wakeup must not disclose another session's id.
            await write(
              `event: control-changed\ndata: ${JSON.stringify(sessionId ? { sessionId } : {})}\n\n`,
            );
          }
          if (
            (watchTaskSummary || watchCatalogPatch) &&
            readyCursor &&
            !closed &&
            !taskSummaryRetry
          ) {
            // Install the new connection's baseline before any invalidation that
            // arrived while subscribing. Changes during this read stay pending.
            if (await writeCatalogEvent("session-ready", { cursor: readyCursor }))
              readyCursor = undefined;
          }
          if (catalogChanges.pending && !closed && !taskSummaryRetry) {
            const patch = catalogChanges.take();
            const scoped =
              patch &&
              scopeCatalogPatch(
                patch,
                (await this.historyAccessScope(hash)).workspaces,
                trustedLocal,
                patchVersion === "2" ? 2 : 1,
              );
            if (
              (!scoped || scoped.updates.length) &&
              !(await writeCatalogEvent(
                "catalog-invalidated",
                scoped ? { catalogPatch: scoped } : {},
              )) &&
              !closed
            )
              catalogChanges.add();
          }
          if (!watchTaskSummary && !watchCatalogPatch && readyCursor && !closed) {
            const cursor = readyCursor;
            readyCursor = undefined;
            await writeCatalogEvent("session-ready", { cursor });
          }
        } catch (error) {
          failed(error);
        } finally {
          processing = false;
          if (
            !closed &&
            (queue.length ||
              controlChangedPending ||
              (!taskSummaryRetry && (catalogChanges.pending || readyCursor)))
          )
            void flush();
        }
      };
      const enqueue = (event: SessionStreamEvent) => {
        if (closed) return;
        queuedBytes += Buffer.byteLength(JSON.stringify(event));
        if (queue.length >= 512 || queuedBytes > 4 * 1024 * 1024) {
          unavailable(REMOTE_ERROR_CODES.streamBackpressure);
          return;
        }
        queue.push(event);
        void flush();
      };
      const controlChanged = (changedSessionId: string) => {
        if (closed || (sessionId && changedSessionId !== sessionId)) return;
        controlChangedPending = true;
        void flush();
      };
      const catalogChanged = (event?: SessionStreamEvent) => {
        if (closed || sessionId) return;
        catalogChanges.add(
          watchCatalogPatch && event?.type === "invalidate" ? event.payload : undefined,
        );
        void flush();
      };
      const heartbeat = setInterval(() => {
        try {
          authorized();
          if (!closed && !processing && !res.write(": heartbeat\n\n")) stopBackpressure();
        } catch (error) {
          failed(error);
        }
      }, 15_000);
      let expiration: ReturnType<typeof setTimeout>;
      const checkExpiry = () => {
        const credential = this.credentials.find((c) => c.hash === hash);
        const remaining = (credential?.expiresAt ?? Date.now()) - Date.now();
        if (remaining <= 0 || (credential && this.credentialExpired(credential))) {
          this.checkCredentialExpiry();
          this.endStreams(hash);
          cleanup();
        } else expiration = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      };
      checkExpiry();
      res.once("close", cleanup);
      res.once("finish", cleanup);
      hub.on("unavailable", unavailable);
      this.controlEvents.on("changed", controlChanged);

      try {
        const subscription = await hub.subscribe(
          sessionId ?? "",
          afterCursor,
          sessionId ? enqueue : catalogChanged,
        );
        subscriptionId = subscription.subscriptionId;
        if (closed) {
          void hub.unsubscribe(subscriptionId).catch(() => undefined);
          return;
        }
        if (sessionId && subscription.events[0]?.type !== "snapshot") {
          // A replay (including an empty one) may omit provider/workspace fields.
          // Resolve them once for this connection without replacing its replay or
          // exposing a newer live state under an older transport cursor.
          controlContext = controlMetadata(
            await this.runtime(
              { operation: "live", sessionId, experimentalEnabled: true },
              undefined,
              true,
            ),
          );
          if (closed) return;
        }
        if (recheckReadScope) await recheckReadScope();
        if (closed) return;
        authorized();
        // Baseline/replay precedes notifications that arrived while subscribe was resolving.
        const pending = queue.splice(0);
        queuedBytes = 0;
        if (sessionId) for (const event of [...subscription.events, ...pending]) enqueue(event);
        readyCursor = subscription.cursor;
        ready = true;
        this.requestTraces.get(res)?.finish({ stage: "host-response", outcome: "accepted" });
        if (!sessionId) res.write(": connected\n\n");
        void flush();
      } catch (error) {
        failed(error);
      }
      return;
    }
    let params: Record<string, unknown>;
    if (path === REMOTE_ROUTE.catalog) params = { operation: "catalog" };
    else if (path === REMOTE_ROUTE.events) {
      const limit = Number(url.searchParams.get("limit") || 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidLimit);
      const cursor = url.searchParams.get("cursor");
      if (cursor && cursor.length > 1024)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidCursor);
      params = { operation: "events", sessionId, cursor, limit };
    } else if (liveRead)
      params = {
        operation: "live",
        sessionId,
        experimentalEnabled: this.controlsEnabled(sessionId, this.grant(hash)),
        terminalDisplay: true,
      };
    else throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    const boot = this.bootId;
    const readerScope = this.readerScope();
    let result: unknown;
    let historyFailure: { error: unknown } | undefined;
    try {
      if (localEvents) {
        this.grant(hash);
        // The same runtime that owns workspace registration verifies the selected
        // indexed record before and after reading it.
        const direct = (await this.runtime({ ...params, operation: "desktop-events" })) as
          | { handled: true; page: unknown }
          | { handled: false };
        this.requestTraces.get(res)?.markDispatched();
        this.grant(hash);
        if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
        if (readerScope !== this.readerScope())
          throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
        if (direct?.handled === true) result = direct.page;
        else {
          await this.codexScope(sessionId!, hash, false, false);
          result = await this.runtime(params);
        }
      } else {
        const readTimeout =
          path === REMOTE_ROUTE.catalog ? REMOTE_ERROR_CODES.catalogReadTimeout : undefined;
        result = await this.runtime(params, undefined, liveRead, readTimeout);
      }
    } catch (error) {
      if (path !== REMOTE_ROUTE.catalog && !eventsRead) throw error;
      if (error instanceof RuntimeRequestError) this.requestTraces.get(res)?.markDispatched();
      this.grant(hash);
      if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
      if (readerScope !== this.readerScope())
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
      if (eventsRead) historyFailure = { error };
      else if (readRequestErrors.runtimeReadDetail(error) === REMOTE_ERROR_CODES.catalogStaleDetail)
        throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.catalogStale);
      else throw error;
    }
    const wantsTaskSummary =
      path === REMOTE_ROUTE.catalog && url.searchParams.get("taskSummary") === "1";
    if (!historyFailure) this.requestTraces.get(res)?.markDispatched();
    const device = this.grant(hash);
    if (path === REMOTE_ROUTE.catalog && !wantsTaskSummary) {
      const incomplete = snapshotField(result, "incompleteSources");
      if (
        !lan ||
        snapshotField(result, "sourceIssues") !== undefined ||
        (Array.isArray(incomplete) && incomplete.length)
      ) {
        const { workspaces } = await this.historyAccessScope(
          hash,
          !lan && !this.isFullAccess(device),
        );
        result = projectCatalogReadScope(result, workspaces, !lan);
      }
    }
    if (liveRead) {
      result = await this.projectLive(sessionId, result, device, true);
      if (device !== this.grant(hash) || readerScope !== this.readerScope())
        throw new HttpError(
          REMOTE_ERROR_CONTRACT.accessChanged.http.overrides.accessRevokedDuringRequest,
          REMOTE_ERROR_CODES.accessChanged,
        );
    }
    const taskSummary = wantsTaskSummary ? await this.taskSummary(hash, result) : undefined;
    if (recheckReadScope && (await recheckReadScope(!!historyFailure).catch(scopedDenial)) === null)
      return this.json(res, 200, unavailableLive(sessionId!));
    const current = this.grant(hash);
    if (
      streamWorkspaceId &&
      !this.isFullAccess(current) &&
      !this.config.allowedWorkspaceIds?.includes(streamWorkspaceId)
    ) {
      if (liveRead) return this.json(res, 200, unavailableLive(sessionId!));
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.workspaceNotAuthorized);
    }
    if (boot !== this.bootId) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.staleBoot);
    if ((path === REMOTE_ROUTE.catalog || eventsRead) && readerScope !== this.readerScope())
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.accessChanged);
    if (historyFailure) {
      const { error } = historyFailure;
      if (error instanceof HttpError) throw error;
      const failure = readRequestErrors.sessionEventsFailure(error, !!params.cursor);
      throw new HttpError(failure.status, failure.code, undefined, failure.reason);
    }
    // 桌面内嵌会话页走可信本地桥，仍拿完整目录；远程（中继、局域网）客户端从不列出
    // 子代理会话，去掉它们并压缩，目录回复从约 800 KiB 降到几十 KiB。
    const remoteCatalog = path === REMOTE_ROUTE.catalog && !trustedLocal;
    const gzip = remoteCatalog && acceptsGzip(req.headers["accept-encoding"]);
    // Large task snapshots remain readable independently of the legacy directory size.
    if (wantsTaskSummary) return this.json(res, 200, { taskSummary }, gzip, TASK_CATALOG_MAX_BYTES);
    if (remoteCatalog) result = projectRemoteCatalog(result);
    if (
      path === REMOTE_ROUTE.catalog &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result)
    ) {
      const catalog = { ...result } as Record<string, unknown>;
      // Runtime completeness spans every registered workspace. Only the authorized projection is public.
      delete catalog.taskSummarySourceCoverage;
      if (remoteCatalog) delete catalog.orchestrationUnavailable;
      result = catalog;
    }
    return this.json(res, 200, result, gzip);
  }
  private async static(req: ConversationRequest, res: ConversationResponse) {
    if (req.method !== "GET" && req.method !== "HEAD")
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.methodNotAllowed);
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.invalidPath);
    }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").includes(".."))
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.invalidPath.http.overrides.invalidRemoteRequestTarget,
        REMOTE_ERROR_CODES.invalidPath,
      );
    const root = await realpath(this.options.staticDir);
    const candidate = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    let file: string;
    try {
      file = await realpath(candidate);
    } catch {
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    }
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== file)
      throw new HttpError(
        REMOTE_ERROR_CONTRACT.invalidPath.http.overrides.invalidRemoteRequestTarget,
        REMOTE_ERROR_CODES.invalidPath,
      );
    // 先看元数据：目录直接 404，超大文件在读入内存之前就拒绝。
    const info = await stat(file);
    if (!info.isFile()) throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.notFound);
    if (info.size > 16 * 1024 * 1024)
      throw HttpError.fromContract(REMOTE_ERROR_CONTRACT.assetTooLarge);
    const data = await readFile(file);
    const mime: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".woff2": "font/woff2",
      ".ico": "image/x-icon",
    };
    res.writeHead(200, {
      "Content-Type": mime[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  }
}
