import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";
import { ArtifactService, ArtifactError } from "./artifacts";
import { AttachmentStore, AttachmentError } from "./attachments";
import { dispatchClaude } from "./claude-dispatch";
import { CLAUDE_LOCAL_OWNER, localClaudeRequest } from "./local-claude";
import { replayClaudeAttachments, settleClaudeAttachments } from "./claude-attachment-receipts";
import { markdownLinkTargets } from "./markdown-links";
import {
  DEFAULT_RELAY_BROKER,
  RelayManager,
  validateRegistration,
  type Registration,
  type RelayStatus,
} from "./relay/manager";

export const HOSTED_ORIGIN = "https://remote.agentkib.com";
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
export function createWebControlState() {
  return {
    admission: false,
    active: new Set<string>(),
    unconfirmed: new Set<string>(),
    unconfirmedRequests: new Map<string, string>(),
    requests: new Set<string>(),
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
export type WebAdminDevice = WebDevice & { accessLevel?: WebAccessLevel };
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
type Credential = { hash: string; expiresAt: number; device: WebDevice; binding?: string };
type PairingCode = {
  value: string;
  expiresAt: number;
  access: WebAccessLevel;
  /** 本码累计失败次数；只作纵深防御，正常情况下先被全局 pair 限流拦住。 */
  failures: number;
  /** 按浏览器计数：单个客户端猜错只锁死自己，不再让配对码对所有人失效。 */
  failuresByBrowser: Map<string, number>;
};
type Browser = { csrf: string; expiresAt: number; pending?: WebPending; ended?: boolean };
type Availability = { available: boolean; reason?: string };
type ContextResourceReference = {
  kind: "file" | "directory" | "skill" | "plugin" | "app";
  id?: string;
  relativePath?: string;
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const token = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const PAIRING_CODE_TTL_MS = 300_000;
const PAIRING_FAILURES_PER_BROWSER = 5;
// 全局 pair 限流为每分钟 20 次、码有效期 5 分钟，一个码最多被试约 100 次；
// 这里取同一数量级作为上限，猜中 8 位码的概率不超过 1e-6。
const PAIRING_FAILURES_PER_CODE = 100;
const newPairingCode = (access: WebAccessLevel = "full"): PairingCode => ({
  value: randomInt(0, 100_000_000).toString().padStart(8, "0"),
  expiresAt: Date.now() + PAIRING_CODE_TTL_MS,
  access,
  failures: 0,
  failuresByBrowser: new Map(),
});
type DevicePermissions = Required<
  Pick<
    WebDevice,
    | "send"
    | "approve"
    | "manage"
    | "files"
    | "attachments"
    | "advancedControl"
    | "organize"
    | "settings"
    | "extendedApproval"
  >
>;
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
/**
 * API 路由的元数据，替代原先三份手工同步的路径列表。
 * - lan：允许托管网页在 LAN 模式下跨源预检（其余路径在 LAN 上本来就不开放）。
 * - control：会占用执行 worker、需要控制栅栏与回执的变更请求。
 * 实际分发仍在 handle() 中进行；新增路由时在这里登记它的属性。
 */
type RouteSpec = { lan?: true; control?: true };
const API_ROUTES: Record<"GET" | "POST", Record<string, RouteSpec>> = {
  GET: {
    "/access": { lan: true },
    "/info": { lan: true },
    "/catalog": { lan: true },
    "/events": { lan: true },
    "/live": { lan: true },
    "/stream": { lan: true },
    "/attachments": { lan: true },
    "/codex/capabilities": { lan: true },
    "/codex/queue": { lan: true },
    "/codex/session-settings": { lan: true },
    "/codex/goals": { lan: true },
    "/codex/context-options": { lan: true },
    "/managed/options": { lan: true },
    "/managed/capabilities": { lan: true },
    "/managed/inspect": { lan: true },
    "/managed/context": { lan: true },
    "/files/workspaces": { lan: true },
    "/files/list": { lan: true },
    "/files/text": { lan: true },
    "/artifacts": { lan: true },
    "/diff": { lan: true },
  },
  POST: {
    "/pair": { lan: true },
    "/pair/cancel": { lan: true },
    "/logout": { lan: true },
    "/send": { lan: true, control: true },
    "/stop": { lan: true, control: true },
    "/approve": { lan: true, control: true },
    "/answer": { lan: true, control: true },
    "/codex/goal-set": { lan: true, control: true },
    "/codex/goal-pause": { lan: true, control: true },
    "/codex/goal-resume": { lan: true, control: true },
    "/codex/goal-clear": { lan: true, control: true },
    "/managed/create": { lan: true, control: true },
    "/managed/adopt": { lan: true, control: true },
    "/managed/release": { lan: true, control: true },
    "/managed/reconcile": { lan: true, control: true },
    "/artifact-tickets": { lan: true },
    "/attachments": { lan: true },
    "/attachments/delete": { lan: true },
  },
};
// 回执查询带动态 ID；控制请求结果不确定时客户端靠它恢复，LAN 也需要能预检。
const RECEIPT_ROUTE = /^\/requests\/[^/]+$/;
function routeSpec(method: string | undefined, path: string): RouteSpec | undefined {
  if (method !== "GET" && method !== "POST") return undefined;
  return Object.hasOwn(API_ROUTES[method], path) ? API_ROUTES[method][path] : undefined;
}
function lanPreflightAllowed(method: string | undefined, path: string): boolean {
  return routeSpec(method, path)?.lan === true || (method === "GET" && RECEIPT_ROUTE.test(path));
}
function isControlRequest(method: string | undefined, path: string): boolean {
  if (routeSpec(method, path)?.control) return true;
  // 其余 /codex/* POST（重命名、归档、队列等）一律按控制请求处理；inspect 是只读探测。
  return method === "POST" && path.startsWith("/codex/") && path !== "/codex/inspect";
}
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
/** 读取 runtime 快照上的字段；快照不是对象或缺少该字段时返回 undefined。 */
function snapshotField(snapshot: unknown, key: string): unknown {
  return snapshot !== null && typeof snapshot === "object" && key in snapshot
    ? (snapshot as Record<string, unknown>)[key]
    : undefined;
}
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

/** Local-only transport. Authentication is independent of native certificate pairing. */
export class WebAccessService {
  private config = { ...DEFAULT };
  private server?: Server;
  private error?: string;
  private code?: PairingCode;
  private credentials: Credential[] = [];
  private browsers = new Map<string, Browser>();
  private streams = new Map<ServerResponse, string>();
  private liveReads = new Map<string, Promise<unknown>>();
  private active = new Set<string>();
  // One runtime worker serves all Web sessions. Reserve its admission across
  // preflight and mutation; new reads must not queue behind that preflight.
  private controlAdmission = false;
  // Survives runtime replacement and HTTP listener restarts within this host.
  // An underlying promise settling is not proof that the HTTP reply succeeded.
  private unconfirmed = new Set<string>();
  private unconfirmedRequests = new Map<string, string>();
  private requests = new Set<string>();
  private rates = new Map<string, { count: number; until: number }>();
  private adminQueue: Promise<unknown> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();
  private bootId = token();
  private addressTimer?: ReturnType<typeof setInterval>;
  private artifacts?: ArtifactService;
  private attachmentStore: AttachmentStore;
  private previewOrigin = "";
  private previewServer?: Server;
  private previewStarting?: Promise<void>;
  private relay?: RelayManager;
  private relayEpoch = 0;
  private disposed = false;
  private remotePairingInitialized = false;
  private contextArtifactRefs = new Map<
    string,
    {
      deviceId: string;
      sessionId: string;
      workspaceId: string;
      artifactId: string;
      revision: string;
    }
  >();
  constructor(
    private readonly options: {
      dataDir: string;
      staticDir: string;
      runtimeRequest: (params: unknown) => Promise<unknown>;
      managedRequest?: (params: unknown) => Promise<unknown>;
      claudeManagedRequest?: (params: unknown) => Promise<unknown>;
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
      workspaceRequest?: () => Promise<{ id: string; name: string; path: string }[]>;
      verifiedCodex?: boolean;
      verifiedExperimental?: boolean;
      verifiedClaudeManaged?: boolean;
      verifiedAntigravityManaged?: boolean;
      acceptanceSessionId?: string;
      mode?: "lan";
      sharedControl?: ReturnType<typeof createWebControlState>;
      addresses?: typeof lanAddresses;
      onPairingRequested?: () => void;
    },
  ) {
    this.attachmentStore = new AttachmentStore(join(options.dataDir, "attachments"));
    if (options.sharedControl) {
      this.active = options.sharedControl.active;
      this.unconfirmed = options.sharedControl.unconfirmed;
      this.unconfirmedRequests = options.sharedControl.unconfirmedRequests;
      this.requests = options.sharedControl.requests;
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
  }
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

  async localClaude(input: unknown): Promise<unknown> {
    if (!this.options.claudeManagedRequest || !this.options.receiptRequest)
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
      if (!this.previewServer) await this.startPreview();
      if (!this.artifacts) throw new Error("preview_unavailable");
      if (body.operation === "files")
        return this.artifacts.list(
          scope,
          body.directoryId === undefined ? undefined : this.field(body.directoryId),
        );
      if (body.operation === "file-text")
        return this.artifacts.readText(
          scope,
          this.field(body.artifactId),
          this.field(body.revision),
        );
      return this.artifacts.issueTicket(scope, {
        artifactId: this.field(body.artifactId),
        expectedRevision: this.field(body.revision),
        download: body.download === true,
      });
    }
    return localClaudeRequest(
      {
        managed: this.options.claudeManagedRequest,
        runtime: this.options.runtimeRequest,
        receipt: this.options.receiptRequest,
        attachments: this.attachmentStore,
      },
      input,
    );
  }
  private async localArtifactScope(sessionId: string) {
    const catalog = (await this.options.runtimeRequest({ operation: "catalog" })) as {
      sessions: { id: string; agent: string; workspace_id: string }[];
    };
    const session = catalog.sessions.find(
      (row) => row.id === sessionId && row.agent === "claude-code",
    );
    if (
      !session ||
      !(await this.registeredWorkspaces()).some((row) => row.id === session.workspace_id)
    )
      throw new Error("workspace_not_authorized");
    return { deviceId: CLAUDE_LOCAL_OWNER, sessionId, workspaceId: session.workspace_id };
  }
  private isFullAccess(device?: WebDevice) {
    return this.options.mode !== "lan" && device?.accessMode === "full";
  }
  private fullAccess(hash: string, permission?: "advancedControl") {
    const device = this.grant(hash, permission);
    if (!this.isFullAccess(device)) throw new HttpError(403, "permission_denied");
    return device;
  }
  private async workspaceAllowed(workspaceId: string, device?: WebDevice, reserved = false) {
    if (!this.isFullAccess(device))
      return this.config.allowedWorkspaceIds?.includes(workspaceId) === true;
    return (await this.registeredWorkspaces(reserved)).some(
      (workspace) => workspace.id === workspaceId,
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
          this.options.verifiedAntigravityManaged === true)
    );
  }
  private async controlsEnabledForSnapshot(
    sessionId: string | undefined,
    snapshot: unknown,
    device?: WebDevice,
    reserved = false,
  ) {
    const executionMode = snapshotField(snapshot, "executionMode");
    if (["codex-managed", "claude-managed"].includes(String(executionMode))) {
      const workspaceId = snapshotField(snapshot, "workspaceId");
      if (
        typeof workspaceId !== "string" ||
        !(await this.workspaceAllowed(workspaceId, device, reserved))
      )
        return false;
    }
    return (
      this.controlsEnabled(sessionId, device) &&
      (!!this.options.acceptanceSessionId ||
        this.options.verifiedExperimental === true ||
        (this.options.verifiedCodex === true &&
          (executionMode === "codex-managed" || executionMode === "codex-follower")) ||
        (this.options.verifiedClaudeManaged === true &&
          (executionMode === "managed-resume" || executionMode === "claude-managed")) ||
        (this.options.verifiedAntigravityManaged === true && executionMode === "acp-managed"))
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
      this.credentials = saved.credentials.filter(
        (c: Credential) =>
          /^[a-f0-9]{64}$/.test(c.hash) &&
          c.expiresAt > Date.now() &&
          (this.options.mode !== "lan" || c.binding === this.binding) &&
          c.device &&
          typeof c.device.id === "string" &&
          typeof c.device.name === "string" &&
          typeof c.device.send === "boolean" &&
          typeof c.device.approve === "boolean" &&
          (c.device.accessMode === undefined ||
            (this.options.mode !== "lan" && c.device.accessMode === "full")) &&
          (c.device.manage === undefined || typeof c.device.manage === "boolean") &&
          (c.device.files === undefined || typeof c.device.files === "boolean"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.config.enabled = false;
        this.credentials = [];
        this.error = "invalid_saved_configuration";
      }
    }
    if (this.config.enabled) await this.start();
  }

  request(input: WebAdminRequest): Promise<WebAdminStatus> {
    const result = this.adminQueue.then(() => this.admin(input));
    this.adminQueue = result.catch(() => undefined);
    return result;
  }
  /**
   * 应用退出时调用。排在正在执行的桌面操作之后：否则进行到一半的 remote-enable 会在
   * shutdown 之后重新监听端口、再建一个 RelayManager（连带一个 frpc）。之后的操作一律拒绝。
   */
  dispose(): Promise<void> {
    this.disposed = true;
    const result = this.adminQueue.then(() => this.shutdown());
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
    switch (input.operation) {
      case "relay-start":
      case "remote-enable": {
        if (input.operation === "relay-start" && !this.server) throw new Error("web_not_running");
        if (this.options.mode === "lan" || this.options.acceptanceSessionId)
          throw new Error("remote_enable_unavailable");
        if (input.reenroll && (typeof input.inviteCode !== "string" || !input.inviteCode.trim()))
          throw new Error("invitation_required_for_reenrollment");
        const brokerUrl = relayBrokerOrigin(input.brokerUrl);
        if (brokerUrl === DEFAULT_RELAY_BROKER) {
          const identity = await this.accountIdentity();
          if (identity?.accountClaimPending) throw new Error("account_claim_pending");
          if (identity?.accountId && !this.options.account)
            throw new Error("account_login_required");
          await this.options.account?.ensureDeviceOwner(identity?.accountId);
        }
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
          this.error = "web_state_save_failed";
          if (input.operation === "relay-start") throw error;
          // A disabled service is not polled continuously; return its failure
          // stage to the one-click caller without publishing the uncommitted config.
          break;
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
        await this.shutdown();
        if (this.options.mode === "lan") {
          this.browsers.clear();
          this.credentials = [];
        }
        this.config = config;
        this.code = undefined;
        for (const browser of this.browsers.values()) browser.pending = undefined;
        await this.save();
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
        try {
          await this.save();
        } catch (error) {
          credential.device = previous;
          throw error;
        }
        // 已连接的浏览器还拿着旧的 /access 快照（控件按旧权限显示）。断开它的流让它重连，
        // 重连时会重新同步权限；不发 access-ended，否则客户端会当成被注销。
        this.endStreams(credential.hash, null);
        break;
      }
      case "approve": {
        const entry = [...this.browsers].find(([, b]) => b.pending?.id === input.id);
        if (!entry?.[1].pending) throw new Error("pairing_expired");
        const [hash, browser] = entry;
        const pending = browser.pending!;
        if (this.credentials.length >= 128) throw new Error("device_limit");
        this.credentials.push({
          hash,
          ...(this.options.mode === "lan" ? { binding: this.binding } : {}),
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
        this.credentials = this.credentials.filter((c) => c.device.id !== input.id);
        for (const c of revoked) {
          const b = this.browsers.get(c.hash);
          if (b) b.ended = true;
          this.endStreams(c.hash);
          this.artifacts?.revokeDevice(c.device.id);
          for (const [id, reference] of this.contextArtifactRefs)
            if (reference.deviceId === c.device.id) this.contextArtifactRefs.delete(id);
        }
        await this.save();
        break;
      }
      default:
        throw new Error("invalid_admin_operation");
    }
    const result = this.status();
    try {
      if (this.options.mode === "lan" || !this.options.managedRequest) return result;
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
        throw new Error("invalid_lan_address");
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
      const url = new URL(input.externalOrigin);
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
        return { ...c.device, ...(accessLevel ? { accessLevel } : {}) };
      }),
      relay: this.relay?.status,
    };
  }
  private save(
    config = this.config,
    remotePairingInitialized = this.remotePairingInitialized,
    credentials = this.credentials,
  ) {
    const contents = JSON.stringify({ config, credentials, remotePairingInitialized });
    const result = this.persistence.then(async () => {
      const file = join(this.options.dataDir, "web-access.json");
      await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
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
      this.error = "lan_address_unavailable";
      return;
    }
    const server = createServer((req, res) => {
      const control = { request: false, dispatched: false, priorUncertain: false };
      void this.handle(req, res, control).catch((error) => {
        if (!res.headersSent)
          this.json(
            res,
            error instanceof HttpError ||
              error instanceof ArtifactError ||
              error instanceof AttachmentError
              ? error.status
              : 500,
            {
              error:
                error instanceof HttpError ||
                error instanceof ArtifactError ||
                error instanceof AttachmentError
                  ? error.message
                  : "request_failed",
              ...(control.request && {
                // Error codes alone cannot distinguish a preflight rejection from
                // a grant/boot recheck after dispatch, or a previous request.
                controlOutcome:
                  control.dispatched || control.priorUncertain ? "unknown" : "not-dispatched",
              }),
            },
          );
        else res.end();
      });
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
        this.addressTimer = setInterval(() => {
          void this.checkLanAddress();
        }, 30_000);
        this.addressTimer.unref();
      }
      server.on("error", () => {
        this.error = "web_server_error";
      });
    } catch (error) {
      // A preview/relay initialization failure must not leave a half-started listener.
      if (this.server === server) await this.shutdown();
      this.error =
        (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? "port_in_use" : "web_start_failed";
    }
  }
  /** Also called on OS resume and when settings request their current status. */
  async checkLanAddress(): Promise<void> {
    if (this.options.mode !== "lan" || !this.server) return;
    if (!this.addresses.some((entry) => entry.address === this.config.lanAddress)) {
      this.error = "lan_address_unavailable";
      await this.shutdown();
    }
  }
  async shutdown() {
    this.relayEpoch += 1;
    await this.relay?.stop();
    clearInterval(this.addressTimer);
    this.addressTimer = undefined;
    this.bootId = token();
    this.liveReads.clear();
    this.contextArtifactRefs.clear();
    this.artifacts?.clear();
    this.endStreams();
    await this.previewStarting;
    const preview = this.previewServer;
    this.previewServer = undefined;
    if (preview) {
      preview.closeAllConnections();
      await new Promise<void>((resolve) => preview.close(() => resolve()));
    }
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
  }
  runtimeUnavailable() {
    this.bootId = token();
    this.liveReads.clear();
    this.contextArtifactRefs.clear();
    this.endStreams(undefined, this.options.mode === "lan" ? "unavailable" : "access-ended");
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
      throw error;
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
    if (!config?.enabled) return;
    const targets = this.relayTargets();
    const epoch = ++this.relayEpoch;
    this.relay = new RelayManager({
      brokerUrl: config.brokerUrl,
      frpcPath: config.frpcPath || this.options.bundledFrpcPath || "",
      trustedFrpcPath: this.options.bundledFrpcPath || "",
      createCsr:
        this.options.createRelayCsr ?? (() => Promise.reject(new Error("runtime_unavailable"))),
      inviteCode,
      ...(config.brokerUrl === DEFAULT_RELAY_BROKER
        ? {
            authorizeAccount: (accountId?: string) =>
              this.options.account?.ensureDeviceOwner(accountId) ?? Promise.resolve(),
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
      onOrigins: ({ publicUrl, previewUrl }) => {
        const update = this.adminQueue.then(async () => {
          if (epoch !== this.relayEpoch || !this.config.relay?.enabled) return;
          await this.setRelayOrigins(publicUrl, previewUrl);
        });
        this.adminQueue = update.catch(() => undefined);
        return update;
      },
      onStatus: (status) => {
        if (status.phase !== "ready") return;
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
          if (this.error === "web_state_save_failed") this.error = undefined;
          if (!this.code || this.code.expiresAt <= Date.now()) this.code = newPairingCode();
        });
        this.adminQueue = update.catch(() => {
          this.error = "web_state_save_failed";
        });
      },
    });
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
    if (!this.previewStarting)
      this.previewStarting = this.startPreviewInner().finally(() => {
        this.previewStarting = undefined;
      });
    return this.previewStarting;
  }
  private async startPreviewInner() {
    const server = createServer((req, res) => {
      void this.artifacts!.handle(req, res).catch((error: unknown) => {
        if (!res.headersSent)
          this.json(res, error instanceof ArtifactError ? error.status : 500, {
            error: error instanceof ArtifactError ? error.message : "preview_failed",
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
    this.previewServer = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("preview_start_failed");
    this.previewOrigin = `http://127.0.0.1:${address.port}`;
    this.artifacts = new ArtifactService({
      bytesPerSecond: this.config.previewBytesPerSecond,
      allowHttpLoopback: true,
      appOrigin: this.config.externalOrigin || `http://127.0.0.1:${this.config.port}`,
      previewOrigin: this.previewOrigin,
      authorize: async (scope) => {
        try {
          if (scope.deviceId === CLAUDE_LOCAL_OWNER) {
            const verified = await this.localArtifactScope(this.field(scope.sessionId));
            if (verified.workspaceId !== scope.workspaceId)
              throw new HttpError(403, "workspace_not_authorized");
            const root = (await this.registeredWorkspaces()).find(
              (row) => row.id === verified.workspaceId,
            );
            if (!root) throw new HttpError(403, "workspace_not_authorized");
            return {
              root: root.path,
              epoch: digest(`${this.bootId}|${root.path}|${scope.sessionId}`),
            };
          }
          const credential = this.credentials.find((c) => c.device.id === scope.deviceId);
          if (!credential) throw new HttpError(401, "access_ended");
          this.grant(credential.hash, "files");
          const roots = await this.fileRoots(credential.device);
          const root = roots.find((item) => item.id === scope.workspaceId);
          if (!root) throw new HttpError(403, "workspace_not_authorized");
          this.grant(credential.hash, "files");
          return {
            root: root.path,
            epoch: digest(
              `${credential.hash}|${root.path}|${JSON.stringify(this.config.allowedWorkspaceIds)}|${JSON.stringify(this.config.extraRoots)}`,
            ),
          };
        } catch (error) {
          if (error instanceof HttpError) throw new ArtifactError(error.status, error.message);
          throw error;
        }
      },
    });
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
    const catalog = (await this.runtime({ operation: "catalog" }, undefined, reserved)) as {
      workspaces?: { id: string; name: string; path: string }[];
    };
    return catalog.workspaces ?? [];
  }
  private async fileScopeFor(device: WebDevice, workspaceId: string) {
    if (!(await this.fileRoots(device)).some((w) => w.id === workspaceId))
      throw new HttpError(403, "workspace_not_authorized");
    return { deviceId: device.id, workspaceId };
  }
  /** 供有副作用的调用方使用（如签发预览票据）：await 之后必须立刻确认授权仍然有效。 */
  private async fileScope(hash: string, workspaceId: string) {
    const scope = await this.fileScopeFor(this.grant(hash, "files"), workspaceId);
    this.grant(hash, "files");
    return scope;
  }
  private async files(res: ServerResponse, hash: string, path: string, url: URL) {
    // 这里全是只读操作：开始时授权一次，响应前再确认一次。期间被撤销的设备
    // 拿不到任何数据，中间步骤无需反复重查。
    const device = this.grant(hash, "files");
    const result = await this.readFiles(device, path, url);
    this.grant(hash, "files");
    return this.json(res, 200, result);
  }
  private async readFiles(device: WebDevice, path: string, url: URL): Promise<unknown> {
    if (path === "/files/workspaces") {
      const roots = await this.fileRoots(device);
      return { workspaces: roots.map(({ id, name }) => ({ id, name })) };
    }
    const workspaceId = this.field(url.searchParams.get("workspaceId"));
    const scope = await this.fileScopeFor(device, workspaceId);
    let result: unknown;
    if (path === "/diff") {
      if (!(await this.workspaceAllowed(workspaceId, device, this.admission)))
        throw new HttpError(403, "workspace_not_authorized");
      const kind = url.searchParams.get("kind") ?? "worktree";
      if (!["worktree", "staged", "commit"].includes(kind))
        throw new HttpError(400, "invalid_diff_kind");
      result = await this.runtime({
        operation: "diff",
        workspaceId,
        kind,
        path: url.searchParams.get("path") ?? undefined,
        oid: url.searchParams.get("oid") ?? undefined,
      });
    } else {
      if (!this.artifacts) throw new HttpError(503, "preview_unavailable");
      if (path === "/files/list")
        result = await this.artifacts.list(scope, url.searchParams.get("directoryId") ?? undefined);
      else if (path === "/files/text")
        result = await this.artifacts.readText(
          scope,
          this.field(url.searchParams.get("artifactId")),
          url.searchParams.get("revision") ?? undefined,
        );
      else if (path === "/artifacts") {
        const sessionId = this.field(url.searchParams.get("sessionId"));
        const catalog = (await this.runtime({ operation: "catalog" })) as {
          sessions: { id: string; workspace_id: string }[];
        };
        if (!catalog.sessions.some((s) => s.id === sessionId && s.workspace_id === workspaceId))
          throw new HttpError(403, "session_workspace_mismatch");
        const page = (await this.runtime({
          operation: "events",
          sessionId,
          limit: 50,
          cursor: url.searchParams.get("cursor") ?? undefined,
        })) as { events: { content?: string }[]; next_cursor?: string };
        const refs = page.events.flatMap((event) => markdownLinkTargets(event.content ?? ""));
        result = {
          artifacts: await this.artifacts.resolveReferences(scope, refs),
          next_cursor: page.next_cursor,
        };
      } else throw new HttpError(404, "not_found");
    }
    return result;
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
    if (!raw || typeof raw !== "object") return undefined;
    const data = raw as {
      available?: unknown;
      tokenUsage?: {
        total?: unknown;
        last?: unknown;
        modelContextWindow?: unknown;
      };
      revision?: unknown;
      updatedAt?: unknown;
      reason?: unknown;
    };
    const tokens = (value: unknown) => {
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
      if (!value || typeof value !== "object") return undefined;
      const item = value as Record<string, unknown>;
      for (const key of ["totalTokens", "total_tokens", "tokens"])
        if (typeof item[key] === "number" && Number.isSafeInteger(item[key]) && item[key] >= 0)
          return item[key] as number;
      return undefined;
    };
    const contextWindow =
      typeof data.tokenUsage?.modelContextWindow === "number" &&
      Number.isSafeInteger(data.tokenUsage.modelContextWindow) &&
      data.tokenUsage.modelContextWindow > 0
        ? data.tokenUsage.modelContextWindow
        : undefined;
    // Native `total` is the current context footprint; `last` only describes the
    // most recent turn and would under-report the context progress indicator.
    const usedTokens = tokens(data.tokenUsage?.total) ?? tokens(data.tokenUsage?.last);
    const totalTokens = tokens(data.tokenUsage?.total);
    const updatedAt = this.optionalString(data.updatedAt, 128);
    const reason = this.optionalString(data.reason);
    return {
      available: data.available === true,
      ...(reason ? { reason } : {}),
      ...(Number.isSafeInteger(data.revision) && Number(data.revision) >= 0
        ? { revision: data.revision }
        : {}),
      ...(usedTokens !== undefined ? { usedTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(usedTokens !== undefined && contextWindow !== undefined
        ? { percent: Math.min(100, Math.max(0, (usedTokens / contextWindow) * 100)) }
        : {}),
      ...(updatedAt ? { updatedAt } : {}),
    };
  }
  private projectSettings(raw: unknown, usage?: unknown) {
    const data =
      raw && typeof raw === "object"
        ? (raw as {
            available?: unknown;
            executionMode?: unknown;
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
            applicationStatus?: unknown;
            defaults?: Record<string, unknown>;
            writable?: Record<string, unknown>;
            collaborationModes?: unknown;
            models?: unknown;
            policies?: unknown;
            serviceTiers?: unknown;
            revision?: unknown;
            reason?: unknown;
          })
        : {};
    const current = data.current ?? data.settings?.current;
    const selected = data.selected ?? data.settings?.selected;
    const applicationStatus = data.applicationStatus ?? data.settings?.applicationStatus;
    const defaults = data.defaults ?? data.settings?.defaults;
    const writable = data.writable ?? data.settings?.writable;
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
      ? data.models.slice(0, 64).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const model = value as Record<string, unknown>;
          const id = this.optionalString(model.id, 128);
          if (!id) return [];
          const name = this.optionalString(model.name, 256);
          const defaultEffort = this.optionalString(
            model.defaultEffort ?? model.default_effort,
            128,
          );
          return [
            {
              id,
              ...(name ? { name } : {}),
              efforts: stringList(model.efforts),
              ...(defaultEffort ? { defaultEffort } : {}),
              serviceTierIds: tierIds(
                model.serviceTierIds ?? model.serviceTiers ?? model.service_tiers,
              ),
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
    const serviceTiers = [
      ...new Map(
        rawServiceTiers.slice(0, 256).flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const tier = value as Record<string, unknown>;
          const id = this.optionalString(tier.id, 128);
          if (!id) return [];
          const name = this.optionalString(tier.name, 256) ?? id;
          const description = this.optionalString(tier.description, 1024);
          return [[id, { id, name, ...(description ? { description } : {}) }] as const];
        }),
      ).values(),
    ].slice(0, 32);
    const value = (source: Record<string, unknown> | undefined, key: string, fallback?: string) =>
      this.optionalString(source?.[key] ?? (fallback ? source?.[fallback] : undefined), 128);
    const projectValues = (current: Record<string, unknown> | undefined) => ({
      ...(value(current, "model", "modelId")
        ? { modelId: value(current, "model", "modelId") }
        : {}),
      ...(value(current, "effort") ? { effort: value(current, "effort") } : {}),
      ...(value(current, "mode") ? { mode: value(current, "mode") } : {}),
      ...(value(current, "policyId") ? { policyId: value(current, "policyId") } : {}),
      ...(value(current, "serviceTier", "serviceTierId")
        ? { serviceTierId: value(current, "serviceTier", "serviceTierId") }
        : {}),
    });
    const reason = this.optionalString(data.reason);
    return {
      available: data.available === true,
      ...(reason ? { reason } : {}),
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
      ...(["pending", "confirmed", "unknown"].includes(String(applicationStatus))
        ? { applicationStatus }
        : {}),
      defaults: {
        ...(value(defaults, "model", "modelId")
          ? { modelId: value(defaults, "model", "modelId") }
          : {}),
        ...(value(defaults, "effort") ? { effort: value(defaults, "effort") } : {}),
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
        restoreDefaults: {
          available:
            this.availability(writable?.model).available && !!value(defaults, "model", "modelId"),
          ...(!value(defaults, "model", "modelId") ? { reason: "defaults_unavailable" } : {}),
        },
      },
      options: {
        models,
        policies,
        serviceTiers,
        collaborationModes: Array.isArray(data.collaborationModes)
          ? data.collaborationModes.slice(0, 8).flatMap((entry) => {
              if (!entry || typeof entry !== "object") return [];
              const item = entry as Record<string, unknown>;
              if (item.id !== "plan" && item.id !== "default") return [];
              return [{ id: item.id, name: this.optionalString(item.name, 128) ?? item.id }];
            })
          : [],
      },
      ...(this.projectUsage(usage) ? { usage: this.projectUsage(usage) } : {}),
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
    return {
      available: data.available === true,
      ...(reason ? { reason } : {}),
      revision:
        Number.isSafeInteger(data.revision) && Number(data.revision) >= 0 ? data.revision : 0,
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
      throw new HttpError(409, "state_unavailable");
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
        const id = digest(`${this.bootId}|${device.id}|${sessionId}|${JSON.stringify(reference)}`);
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
        if (availability.available) references.set(id, reference);
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
    add("contextReferences", "file");
    let directory:
      | {
          directoryId: string;
          parentId?: string;
          entries: { id: string; name: string; kind: "file" | "directory"; revision: string }[];
        }
      | undefined;
    if (this.artifacts) {
      try {
        directory = await this.artifacts.list(
          { deviceId: device.id, workspaceId, sessionId },
          directoryId,
        );
      } catch (error) {
        if (error instanceof ArtifactError) throw new HttpError(error.status, error.code);
        throw error;
      }
      for (const entry of directory.entries) {
        const id = digest(
          `${this.bootId}|${device.id}|${sessionId}|${workspaceId}|${entry.id}|${entry.revision}`,
        );
        if (this.contextArtifactRefs.size >= 20_000 && !this.contextArtifactRefs.has(id))
          throw new HttpError(429, "resource_capacity");
        this.contextArtifactRefs.set(id, {
          deviceId: device.id,
          sessionId,
          workspaceId,
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
  private async resolveContextResources(
    sessionId: string,
    hash: string,
    value: unknown,
    expectedRevision: unknown,
    reserved = false,
  ) {
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      value.length > 10 ||
      value.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) ||
      new Set(value).size !== value.length
    )
      throw new HttpError(400, "invalid_resource_ids");
    const device = this.fullAccess(hash);
    const workspaceId = await this.codexScope(sessionId, hash, reserved);
    const { response, references } = await this.contextResources(
      sessionId,
      device,
      workspaceId,
      undefined,
      reserved,
    );
    if (response.revision !== expectedRevision) throw new HttpError(409, "stale_state");
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
        artifact.sessionId !== sessionId ||
        artifact.workspaceId !== workspaceId ||
        !this.artifacts
      )
        throw new HttpError(409, "resource_unavailable");
      try {
        const reference = await this.artifacts.resolveContextReference(
          { deviceId: device.id, workspaceId, sessionId },
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
    const catalog = (await this.runtime({ operation: "catalog" }, undefined, reserved)) as {
      sessions: { id: string; agent: string; workspace_id: string }[];
    };
    const session = catalog.sessions.find(
      (item) => item.id === sessionId && (!codexOnly || item.agent === "codex"),
    );
    if (
      !session ||
      !(await this.workspaceAllowed(session.workspace_id, this.grant(hash), reserved))
    )
      throw new HttpError(403, "workspace_not_authorized");
    return session.workspace_id;
  }
  private codexPermission(
    operation: string,
  ): "send" | "approve" | "manage" | "attachments" | "advancedControl" | "organize" | "settings" {
    if (operation === "approve") return "approve";
    if (operation === "stop" || operation === "answer") return "send";
    if (operation === "attachments") return "attachments";
    if (["resume", "fork"].includes(operation)) return "manage";
    if (["rename", "archive", "unarchive"].includes(operation)) return "organize";
    if (operation === "settings") return "settings";
    return operation === "send" || operation === "inspect" ? "send" : "advancedControl";
  }
  private projectClaudeCapabilities(result: unknown, device: WebDevice, sessionId: string) {
    const data = result as { features?: Record<string, { available: boolean; reason?: string }> };
    const roles: Record<string, keyof WebDevice> = {
      send: "send",
      stop: "send",
      answer: "send",
      approve: "approve",
      adopt: "manage",
      release: "manage",
      reconcile: "manage",
      inspect: "manage",
      files: "files",
      attachments: "attachments",
    };
    return {
      ...data,
      features: Object.fromEntries(
        Object.entries(data.features ?? {}).map(([operation, feature]) => {
          const permission = roles[operation];
          const transport =
            this.options.mode !== "lan" || !["files", "attachments"].includes(operation);
          const execution =
            ["files", "inspect"].includes(operation) ||
            (this.options.verifiedClaudeManaged === true &&
              this.controlsEnabled(sessionId, device));
          const allowed =
            permission &&
            device[permission] === true &&
            transport &&
            execution &&
            (operation !== "attachments" || device.send === true);
          return [
            operation,
            allowed
              ? feature
              : {
                  available: false,
                  reason: transport ? "permission_denied" : "same_origin_required",
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
  ) {
    const data = result as {
      features?: Record<string, { available: boolean; reason?: string }>;
      [key: string]: unknown;
    };
    const projected = Object.fromEntries(
      Object.entries(data.features ?? {}).map(([operation, feature]) => {
        const fullOnly =
          ["context", "resources", "settings-state", "usage", "goal"].includes(operation) ||
          operation.startsWith("goal-");
        const allowed =
          this.controlsEnabled(sessionId, device) &&
          device[this.codexPermission(operation)] === true &&
          (!fullOnly || this.isFullAccess(device)) &&
          (operation !== "fork" || device.organize === true) &&
          this.options.mode !== "lan" &&
          (workspaceAllowed ||
            (["send", "inspect"].includes(operation) && data.executionMode === "codex-follower"));
        return [operation, allowed ? feature : { available: false, reason: "permission_denied" }];
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
  private async codexAction(
    res: ServerResponse,
    hash: string,
    operation: string,
    body: Record<string, unknown>,
    control: { request: boolean; dispatched: boolean; priorUncertain: boolean },
  ) {
    const actions = [
      "inspect",
      "resume",
      "steer",
      "queue-add",
      "queue-update",
      "queue-delete",
      "queue-reorder",
      "queue-start",
      "rename",
      "archive",
      "unarchive",
      "fork",
      "settings",
      "goal-set",
      "goal-pause",
      "goal-resume",
      "goal-clear",
    ];
    if (!actions.includes(operation)) throw new HttpError(404, "not_found");
    if (this.options.mode === "lan") throw new HttpError(403, "capability_unavailable");
    const permission = this.codexPermission(operation);
    const device = this.grant(hash, permission);
    if (operation.startsWith("goal-")) this.fullAccess(hash);
    if (operation === "fork") this.grant(hash, "organize");
    const sessionId = this.field(body.sessionId);
    if (this.isFullAccess(device)) await this.codexScope(sessionId, hash);
    if (!this.controlsEnabled(sessionId, device))
      throw new HttpError(403, "session_control_not_allowed");
    if (operation === "inspect") {
      const pendingRequest = this.unconfirmedRequests.get(sessionId);
      const result = (await this.runtime({
        operation,
        sessionId,
        deviceId: device.id,
        experimentalEnabled: true,
      })) as { reconciled?: boolean; context?: unknown };
      this.grant(hash, permission);
      if (
        result.reconciled === true &&
        !this.active.has(sessionId) &&
        this.unconfirmedRequests.get(sessionId) === pendingRequest
      ) {
        this.unconfirmed.delete(sessionId);
        this.unconfirmedRequests.delete(sessionId);
      }
      const catalog = (await this.runtime({ operation: "catalog" })) as {
        sessions: { id: string; workspace_id: string }[];
      };
      this.grant(hash, permission);
      const workspaceId = catalog.sessions.find((item) => item.id === sessionId)?.workspace_id;
      return this.json(res, 200, {
        ...result,
        ...(!workspaceId || !(await this.workspaceAllowed(workspaceId, device))
          ? { context: { available: false, reason: "workspace_not_authorized" } }
          : {}),
      });
    }
    if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
    const requestId = this.field(body.requestId, 128);
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new HttpError(400, "invalid_request_id");
    if (
      operation !== "resume" &&
      (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
    )
      throw new HttpError(400, "invalid_revision");
    if (this.requests.has(requestId) || this.unconfirmed.has(sessionId)) {
      control.priorUncertain = true;
      throw new HttpError(409, "outcome_unknown");
    }
    if (this.admission || this.active.has(sessionId)) throw new HttpError(409, "operation_busy");
    const workspaceId = await this.codexScope(sessionId, hash);
    if (this.admission) throw new HttpError(409, "operation_busy");
    if (this.requests.size >= 10_000) throw new HttpError(429, "request_capacity");
    this.admission = true;
    this.active.add(sessionId);
    let dispatched = false;
    try {
      const capabilities = (await this.runtime(
        { operation: "capabilities", sessionId, experimentalEnabled: true },
        undefined,
        true,
      )) as { features?: Record<string, { available: boolean }>; executionMode?: string };
      const sessionSettingsAction = operation === "settings" || operation.startsWith("goal-");
      if (
        (operation !== "resume" &&
          capabilities.executionMode !== "codex-managed" &&
          !(sessionSettingsAction && capabilities.executionMode === "codex-follower")) ||
        capabilities.features?.[operation]?.available !== true
      )
        throw new HttpError(409, "capability_unavailable");
      const snapshot = (await this.runtime(
        { operation: "live", sessionId, experimentalEnabled: true },
        undefined,
        true,
      )) as { revision: number; runtimeBootId: string; status?: string };
      if (
        (operation !== "resume" && snapshot.revision !== body.expectedRevision) ||
        !snapshot.runtimeBootId
      )
        throw new HttpError(409, "stale_state");
      if (operation === "queue-add" && snapshot.status !== "running")
        throw new HttpError(409, "queue_requires_running_turn");
      const params: Record<string, unknown> = {
        operation,
        sessionId,
        requestId,
        deviceId: device.id,
        expectedRevision: body.expectedRevision,
        runtimeBootId: snapshot.runtimeBootId,
        experimentalEnabled: true,
      };
      // Every operation has an explicit public-field projection. Paths and raw RPC input never pass through.
      if (["steer", "queue-add", "queue-update"].includes(operation)) {
        const text = body.text === undefined ? "" : body.text;
        if (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds))
          throw new HttpError(400, "invalid_attachments");
        const hasAttachments = Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0;
        if (
          typeof text !== "string" ||
          text.length > 16000 ||
          Buffer.byteLength(text) > 16384 ||
          (!text.trim() && !hasAttachments)
        )
          throw new HttpError(400, "invalid_text");
        params.text = text;
        if (hasAttachments) {
          this.grant(hash, "attachments");
          if (capabilities.features?.attachments?.available !== true)
            throw new HttpError(409, "attachments_unavailable");
          params.input = await this.attachmentStore.input(
            device.id,
            sessionId,
            body.attachmentIds,
            text,
          );
          delete params.text;
        }
      }
      if (operation === "queue-update") {
        const queued = (await this.runtime(
          { operation: "queue-list", sessionId, limit: 100 },
          undefined,
          true,
        )) as { data?: { id: string; input?: { type: string; text?: string }[] }[] };
        if (
          (queued as { reason?: string }).reason === "queue-too-large" ||
          (queued.data?.length ?? 0) > 100
        )
          throw new HttpError(409, "queue_too_large");
        const target = queued.data?.find((item) => item.id === body.queuedSubmissionId);
        if (!target) throw new HttpError(409, "queue_item_unavailable");
        if (
          target.input?.some(
            (input) => input.type !== "text" || input.text?.startsWith("User attached file "),
          )
        )
          throw new HttpError(409, "queue_attachments_edit_unsupported");
      }
      if (operation === "steer") params.turnId = this.field(body.turnId);
      if (["queue-update", "queue-delete"].includes(operation))
        params.queuedSubmissionId = this.field(body.queuedSubmissionId);
      if (operation === "queue-reorder") {
        if (
          !Array.isArray(body.queuedSubmissionIds) ||
          body.queuedSubmissionIds.length > 100 ||
          body.queuedSubmissionIds.some((id) => typeof id !== "string") ||
          new Set(body.queuedSubmissionIds).size !== body.queuedSubmissionIds.length
        )
          throw new HttpError(400, "invalid_queue_order");
        params.queuedSubmissionIds = body.queuedSubmissionIds.map((id) => this.field(id));
      }
      if (operation === "rename") params.name = this.field(body.name, 200);
      if (operation === "settings") {
        const usesFullAccessFields =
          body.serviceTierId !== undefined ||
          body.policyId !== undefined ||
          body.restoreDefaults !== undefined ||
          body.resourceIds !== undefined;
        if (usesFullAccessFields) this.fullAccess(hash);
        const state = (await this.runtime(
          { operation: "settings-state", sessionId },
          undefined,
          true,
        )) as {
          settings?: {
            current?: { model?: string };
            selected?: { model?: string };
            writable?: Record<string, unknown>;
            defaults?: Record<string, unknown>;
          };
          current?: { model?: string };
          selected?: { model?: string };
          writable?: Record<string, unknown>;
          models?: {
            id?: string;
            efforts?: string[];
            serviceTiers?: ({ id?: string } | string)[];
            serviceTierIds?: string[];
          }[];
          collaborationModes?: { id?: string }[];
          policies?: { id?: string }[];
          revision?: number;
        };
        if (state.revision !== body.expectedRevision) throw new HttpError(409, "stale_state");
        const current =
          state.selected ?? state.settings?.selected ?? state.current ?? state.settings?.current;
        const writable = state.writable ?? state.settings?.writable;
        const ensureWritable = (key: string) => {
          if (!this.availability(writable?.[key]).available)
            throw new HttpError(409, "setting_unavailable");
        };
        const model = body.model === undefined ? undefined : this.field(body.model, 128);
        const effort = body.effort === undefined ? undefined : this.field(body.effort, 128);
        const mode = body.mode === undefined ? undefined : this.field(body.mode, 128);
        const serviceTier =
          body.serviceTierId === undefined ? undefined : this.field(body.serviceTierId, 128);
        const policyId = body.policyId === undefined ? undefined : this.field(body.policyId, 128);
        if (body.restoreDefaults !== undefined && body.restoreDefaults !== true)
          throw new HttpError(400, "invalid_restore_defaults");
        if (model) {
          ensureWritable("model");
          if (!state.models?.some((item) => item.id === model))
            throw new HttpError(400, "unsupported_model");
          params.model = model;
        }
        const selectedModel = state.models?.find((item) => item.id === (model ?? current?.model));
        if (effort) {
          ensureWritable("effort");
          if (!selectedModel?.efforts?.includes(effort))
            throw new HttpError(400, "unsupported_effort");
          params.effort = effort;
        }
        if (mode) {
          ensureWritable("mode");
          if (
            !new Set(["default", "plan"]).has(mode) ||
            !state.collaborationModes?.some((item) => item.id === mode)
          )
            throw new HttpError(400, "unsupported_mode");
          params.mode = mode;
        }
        if (serviceTier) {
          ensureWritable("serviceTier");
          if (
            ![
              ...(selectedModel?.serviceTiers ?? []).flatMap((entry) =>
                typeof entry === "string" ? [entry] : entry.id ? [entry.id] : [],
              ),
              ...(selectedModel?.serviceTierIds ?? []),
            ].includes(serviceTier)
          )
            throw new HttpError(400, "unsupported_service_tier");
          params.serviceTier = serviceTier;
        }
        if (policyId) {
          ensureWritable("policy");
          if (!state.policies?.some((item) => item.id === policyId))
            throw new HttpError(400, "unsupported_policy");
          params.policyId = policyId;
        }
        if (body.restoreDefaults === true) {
          if (!this.projectSettings(state).writable.restoreDefaults.available)
            throw new HttpError(409, "defaults_unavailable");
          params.resetDefaults = true;
        }
        if (
          !model &&
          !effort &&
          !mode &&
          !serviceTier &&
          !policyId &&
          body.restoreDefaults !== true
        )
          throw new HttpError(400, "empty_settings");
      }
      if (operation === "goal-set") {
        const objective = this.field(body.objective, 16_000);
        if (Buffer.byteLength(objective, "utf8") > 16_384)
          throw new HttpError(400, "invalid_objective");
        if (body.intent !== undefined && body.intent !== "start" && body.intent !== "update")
          throw new HttpError(400, "invalid_goal_intent");
        const goal: Record<string, unknown> = { objective, intent: body.intent ?? "start" };
        if (body.tokenBudget !== undefined) {
          if (
            body.tokenBudget !== null &&
            (!Number.isSafeInteger(body.tokenBudget) || Number(body.tokenBudget) <= 0)
          )
            throw new HttpError(400, "invalid_token_budget");
          goal.tokenBudget = body.tokenBudget;
        }
        params.goal = goal;
      }
      if (operation === "resume") {
        if (body.handoffConfirmed !== true)
          throw new HttpError(400, "handoff_confirmation_required");
        params.handoffConfirmed = true;
      }
      if (body.resourceIds !== undefined) {
        if (!["steer", "queue-add", "queue-update"].includes(operation))
          throw new HttpError(400, "resources_not_supported");
        if (
          capabilities.features?.context?.available !== true &&
          capabilities.features?.resources?.available !== true
        )
          throw new HttpError(409, "context_unavailable");
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
          throw new HttpError(400, "too_many_input_items");
        params.resourceRefs = resourceRefs;
      }
      this.grant(hash, permission);
      if (!(await this.workspaceAllowed(workspaceId, this.grant(hash), this.admission)))
        throw new HttpError(403, "workspace_not_authorized");
      this.grant(hash, permission);
      if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
      this.rate(`control:${hash}`, 30);
      this.requests.add(requestId);
      this.unconfirmed.add(sessionId);
      this.unconfirmedRequests.set(sessionId, requestId);
      dispatched = true;
      control.dispatched = true;
      const pending = this.options.runtimeRequest(params).finally(() => {
        this.active.delete(sessionId);
        this.admission = false;
      });
      const result = (await this.runtime(params, pending)) as {
        accepted?: boolean;
        requestId?: string;
        controlOutcome?: string;
      };
      this.grant(hash, permission);
      if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
      if (result.accepted !== true) {
        if (result.requestId === requestId && result.controlOutcome === "not-dispatched") {
          this.unconfirmed.delete(sessionId);
          control.dispatched = false;
          throw new HttpError(409, "control_preflight_rejected");
        }
        throw new HttpError(502, "outcome_unknown");
      }
      res.once("finish", () => {
        if (!res.destroyed && res.statusCode === 200) this.unconfirmed.delete(sessionId);
      });
      return this.json(res, 200, result);
    } finally {
      if (!dispatched) {
        this.active.delete(sessionId);
        this.admission = false;
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
  private async manage(
    _req: IncomingMessage,
    res: ServerResponse,
    hash: string,
    operation: string,
    body: Record<string, unknown>,
    control: { request: boolean; dispatched: boolean; priorUncertain: boolean },
  ) {
    this.grant(hash, "manage");
    const agent = body.agent ?? "codex";
    if (agent !== "codex" && agent !== "claude-code") throw new HttpError(400, "invalid_agent");
    const requestId = this.field(body.requestId, 128);
    if (agent === "claude-code")
      await this.controlReceipt(requestId, this.grant(hash, "manage").id, control);
    const managedRequest =
      agent === "claude-code" ? this.options.claudeManagedRequest : this.options.managedRequest;
    if (agent === "claude-code" && !this.options.verifiedClaudeManaged)
      throw new HttpError(409, "unsupported_host");
    if (
      this.options.acceptanceSessionId &&
      (operation === "create" || body.sessionId !== this.options.acceptanceSessionId)
    )
      throw new HttpError(403, "session_control_not_allowed");
    if (!managedRequest || !["create", "adopt", "release", "reconcile"].includes(operation))
      throw new HttpError(404, "not_found");
    if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
    const params: Record<string, unknown> = {
      operation,
      requestId,
      deviceId: this.grant(hash, "manage").id,
    };
    if (operation === "create") {
      params.workspaceId = this.field(body.workspaceId);
      if (agent === "codex") params.policyId = "workspace-write-on-request";
      if (agent === "codex" && body.model !== undefined) params.model = this.field(body.model, 128);
      if (agent === "codex" && body.effort !== undefined)
        params.effort = this.field(body.effort, 32);
    } else {
      params.sessionId = this.field(body.sessionId);
      if (operation === "adopt") {
        if (body.handoffConfirmed !== true)
          throw new HttpError(400, "handoff_confirmation_required");
        params.handoffConfirmed = true;
        if (agent === "claude-code")
          params.handoffFingerprint = this.field(body.handoffFingerprint, 256);
      }
    }
    if (agent === "claude-code" && operation === "release") {
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
        throw new HttpError(400, "invalid_revision");
      const live = (await this.runtime({
        operation: "live",
        sessionId: params.sessionId,
        experimentalEnabled: true,
      })) as { runtimeBootId?: string };
      params.expectedRevision = body.expectedRevision;
      params.runtimeBootId = this.field(live.runtimeBootId);
    }
    if (this.admission) throw new HttpError(409, "operation_busy");
    if (agent !== "claude-code" && this.requests.has(requestId)) {
      control.priorUncertain = true;
      throw new HttpError(409, "duplicate_request");
    }
    if (this.requests.size >= 10_000) throw new HttpError(429, "request_capacity");
    const catalog = (await this.runtime({ operation: "catalog" })) as {
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
      throw new HttpError(403, "workspace_not_authorized");
    this.grant(hash, "manage");
    if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
    if (this.admission) throw new HttpError(409, "operation_busy");
    if (agent !== "claude-code" && this.requests.has(requestId)) {
      control.priorUncertain = true;
      throw new HttpError(409, "duplicate_request");
    }
    if (this.requests.size >= 10_000) throw new HttpError(429, "request_capacity");
    this.rate(`control:${hash}`, 30);
    this.admission = true;
    this.requests.add(requestId);
    control.dispatched = true;
    const pending = Promise.resolve()
      .then(() =>
        agent === "claude-code" && this.options.receiptRequest
          ? dispatchClaude(managedRequest!, this.options.receiptRequest, params)
          : managedRequest!(params),
      )
      .finally(() => {
        this.admission = false;
      });
    const result = (await this.runtime(params, pending)) as {
      reconciled?: boolean;
      accepted?: boolean;
      completed?: boolean;
      controlOutcome?: string;
      reason?: string;
      requestId?: string;
    };
    this.grant(hash, "manage");
    if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
    if (operation !== "reconcile" && result?.accepted !== true) {
      if (
        result?.accepted === false &&
        result.completed === false &&
        result.requestId === requestId &&
        result.controlOutcome === "not-dispatched"
      ) {
        control.dispatched = false;
        control.priorUncertain = false;
        const safeReasons = new Set([
          "web-busy",
          "unverified-installation",
          "handoff-fingerprint-changed",
          "Claude-history-changed-requires-handoff",
          "session-busy",
          "session-released",
          "stale-Claude-revision",
          "codex-owner-busy",
          "unsupported-codex-cli-version",
          "unsupported-model",
          "unsupported-effort",
          "session-managed-by-another-runtime",
          "pause-original-goal-before-handoff",
          "control-outcome-unconfirmed",
          "codex-policy-mismatch",
          "codex-workspace-mismatch",
          "codex-sandbox-mismatch",
          "codex-writable-roots-mismatch",
          "remote-environment-not-supported",
        ]);
        throw new HttpError(
          409,
          safeReasons.has(result.reason ?? "") ? result.reason! : "control_preflight_rejected",
        );
      }
      throw new HttpError(502, "outcome_unknown");
    }
    if (operation === "reconcile" && result.reconciled === true)
      this.unconfirmed.delete(String(params.sessionId));
    return this.json(res, 200, result);
  }
  private async projectLive(sessionId: string | undefined, snapshot: unknown, device?: WebDevice) {
    if (
      sessionId &&
      this.options.receiptRequest &&
      snapshot &&
      typeof snapshot === "object" &&
      "executionMode" in snapshot &&
      snapshot.executionMode === "claude-managed"
    ) {
      await settleClaudeAttachments(this.attachmentStore, this.options.receiptRequest, sessionId);
    }
    if (device && snapshot && typeof snapshot === "object") {
      const state = snapshot as {
        approvals?: {
          requiresExtendedApproval?: boolean;
          supported?: boolean;
          decisionOptions?: { scope: string }[];
        }[];
        [key: string]: unknown;
      };
      snapshot = {
        ...state,
        approvals: state.approvals?.map((approval) => ({
          ...approval,
          supported:
            approval.supported === true &&
            device.approve === true &&
            (!approval.requiresExtendedApproval || device.extendedApproval === true),
          decisionOptions: device.extendedApproval === true ? approval.decisionOptions : undefined,
        })),
      };
    }
    if (!sessionId || !this.unconfirmed.has(sessionId)) {
      if (
        snapshot &&
        typeof snapshot === "object" &&
        !(await this.controlsEnabledForSnapshot(sessionId, snapshot, device))
      ) {
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
                availableDecisions: [],
              }))
            : [],
        };
      }
      return snapshot;
    }
    return {
      sessionId,
      status: "outcome-unknown",
      revision: null,
      turnId: null,
      sendEnabled: false,
      approvals: [],
      questions: [],
      reason: "control-outcome-unconfirmed",
    };
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
    this.credentials = this.credentials.filter((c) => c.expiresAt > now);
    for (const [key, rate] of this.rates) if (rate.until <= now) this.rates.delete(key);
  }
  private rate(key: string, limit: number) {
    const previous = this.rates.get(key);
    // 表满时只拒绝新建 key；已有额度的客户端不能因为别人把表撑满而被 429。
    if (!previous && this.rates.size >= 4096) throw new HttpError(429, "rate_limited");
    const rate =
      previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60_000 };
    if (++rate.count > limit) throw new HttpError(429, "rate_limited");
    this.rates.set(key, rate);
  }
  /**
   * event 为 null 时只关闭连接、不发事件：客户端按普通断线处理，重连时重新读取 /access，
   * 从而拿到新的权限（与工作区授权撤销时关闭流的做法一致）。
   */
  private endStreams(hash?: string, event: "access-ended" | "unavailable" | null = "access-ended") {
    for (const [res, owner] of this.streams)
      if (!hash || hash === owner) {
        if (event) res.write(`event: ${event}\ndata: {}\n\n`);
        res.end();
        this.streams.delete(res);
      }
  }
  private json(res: ServerResponse, status: number, data: unknown) {
    const body = JSON.stringify(data);
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new HttpError(413, "response_too_large");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(body);
  }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      throw new HttpError(415, "json_required");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 64 * 1024) throw new HttpError(413, "body_too_large");
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || Array.isArray(value) || typeof value !== "object") throw 0;
      return value;
    } catch {
      throw new HttpError(400, "invalid_json");
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
    const credential = this.credentials.find((c) => c.hash === hash && c.expiresAt > Date.now());
    if (!this.server || !credential || this.browsers.get(hash)?.ended) {
      this.endStreams(hash);
      throw new HttpError(401, "access_ended");
    }
    if (
      permission &&
      ((permission !== "files" && !this.controlsEnabled(undefined, credential.device)) ||
        credential.device[permission] !== true)
    )
      throw new HttpError(403, "permission_denied");
    return credential.device;
  }
  private field(value: unknown, max = 256): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      [...value].some((character) => character.charCodeAt(0) <= 0x1f)
    )
      throw new HttpError(400, "invalid_input");
    return value;
  }
  private async runtime(params: unknown, existing?: Promise<unknown>, reserved = false) {
    if (!existing && !reserved && this.admission) throw new HttpError(409, "operation_busy");
    // Timeout does not cancel owner execution. Callers never automatically retry mutations.
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        existing ?? this.options.runtimeRequest(params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HttpError(504, "outcome_unknown")), 20_000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  private streamSnapshot(sessionId: string | undefined, device: WebDevice) {
    const experimentalEnabled = this.controlsEnabled(sessionId, device);
    // Never share reads across host generations, transport modes or permission scopes.
    const key = JSON.stringify([
      this.bootId,
      this.options.mode ?? "local",
      sessionId,
      experimentalEnabled,
      device.send,
      device.approve,
    ]);
    const existing = this.liveReads.get(key);
    if (existing) return existing;
    const read = this.runtime({ operation: "live", sessionId, experimentalEnabled });
    this.liveReads.set(key, read);
    void read
      .finally(() => {
        if (this.liveReads.get(key) === read) this.liveReads.delete(key);
      })
      .catch(() => undefined);
    return read;
  }
  private async handle(
    req: IncomingMessage,
    res: ServerResponse,
    control: { request: boolean; dispatched: boolean; priorUncertain: boolean },
  ) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: ${this.previewOrigin}; media-src ${this.previewOrigin || "'none'"}; frame-src ${this.previewOrigin || "'none'"}; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    this.expire();
    const lan = this.options.mode === "lan";
    if (lan && !this.addresses.some((entry) => entry.address === this.config.lanAddress)) {
      this.error = "lan_address_unavailable";
      void this.shutdown();
      throw new HttpError(503, "lan_address_unavailable");
    }
    const localOrigin = `http://${lan ? this.config.lanAddress : "127.0.0.1"}:${this.config.port}`;
    const host = req.headers.host;
    const external =
      !lan && !!this.config.externalOrigin && host === new URL(this.config.externalOrigin).host;
    if (host !== new URL(localOrigin).host && !external) throw new HttpError(403, "invalid_host");
    const origin = lan ? HOSTED_ORIGIN : external ? this.config.externalOrigin : localOrigin;
    if (lan && req.headers.origin !== origin) throw new HttpError(403, "invalid_origin");
    if (req.headers.origin && req.headers.origin !== origin)
      throw new HttpError(403, "invalid_origin");
    if (!lan && req.headers["sec-fetch-site"] === "cross-site")
      throw new HttpError(403, "cross_site_request");
    const cookieName = external ? "ak_web_secure" : "ak_web_local";
    let raw = lan
      ? req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
      : req.headers.cookie
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
    let hash = raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? digest(raw) : "";
    // 已配对设备各自一份额度；未认证流量（含静态资源、预检、配对）共享一个池。
    // 经 relay 进来的请求都来自本机 frpc，拿不到真实客户端地址，无法再按 IP 细分。
    const paired = !!hash && this.credentials.some((c) => c.hash === hash);
    this.rate(paired ? `paired:${hash}` : "anonymous", 600);
    if (lan) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    const url = new URL(req.url || "/", origin);
    if (!url.pathname.startsWith("/api/")) {
      if (lan) throw new HttpError(404, "not_found");
      return this.static(req, res);
    }
    res.setHeader("Cache-Control", "no-store");
    const path = url.pathname.replace(/^\/api\/web\/v1/, "");
    if (!url.pathname.startsWith("/api/web/v1/")) throw new HttpError(404, "not_found");
    if (lan && req.method === "OPTIONS") {
      const method = req.headers["access-control-request-method"];
      const headers = String(req.headers["access-control-request-headers"] ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        !lanPreflightAllowed(method, path) ||
        headers.some(
          (header) => !["authorization", "content-type", "x-csrf-token"].includes(header),
        )
      )
        throw new HttpError(403, "invalid_preflight");
      res.setHeader("Access-Control-Allow-Methods", method!);
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-CSRF-Token");
      if (req.headers["access-control-request-private-network"] === "true")
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && path === "/info")
      return this.json(res, 200, {
        protocolVersion: 1,
        transport: lan ? "lan" : "local",
        capabilities: { read: true, send: this.controlsEnabled(), approve: this.controlsEnabled() },
      });
    control.request = isControlRequest(req.method, path);
    let browser = this.browsers.get(hash);
    let bearerToken: string | undefined;
    if (
      lan &&
      req.headers.authorization &&
      !browser &&
      !this.credentials.some((c) => c.hash === hash)
    )
      throw new HttpError(401, "access_ended");
    if (!browser && hash && this.credentials.some((c) => c.hash === hash)) {
      browser = { csrf: token(), expiresAt: Date.now() + MAX_AGE };
      this.browsers.set(hash, browser);
    }
    if (req.method === "GET" && path === "/access") {
      if (!browser) {
        this.rate("bootstrap", 60);
        if (this.browsers.size >= 1024) throw new HttpError(429, "client_limit");
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
      const device = this.credentials.find((c) => c.hash === hash)?.device;
      return this.json(res, 200, {
        status: browser.ended
          ? "ended"
          : device
            ? "approved"
            : browser.pending
              ? "pending"
              : "unpaired",
        csrfToken: browser.csrf,
        bootId: this.bootId,
        device: browser.ended ? undefined : device,
        pending: browser.pending,
        pairingMode: lan ? "confirmation" : "code",
        experimentalEnabled: this.controlsEnabled(undefined, device),
        ...(bearerToken ? { bearerToken } : {}),
      });
    }
    if (!browser) throw new HttpError(401, "unpaired");
    this.rate(hash, 180);
    if (req.method === "POST") {
      if (req.headers.origin !== origin || req.headers["x-csrf-token"] !== browser.csrf)
        throw new HttpError(403, "csrf_rejected");
      if (path === "/attachments") {
        if (lan) throw new HttpError(403, "attachments_require_same_origin");
        const device = this.grant(hash, "attachments");
        const sessionId = this.field(url.searchParams.get("sessionId"));
        const workspaceId = await this.codexScope(sessionId, hash, false, false);
        const capabilities = (await this.runtime({
          operation: "capabilities",
          sessionId,
          experimentalEnabled: true,
        })) as { features?: Record<string, { available: boolean }> };
        if (capabilities.features?.attachments?.available !== true)
          throw new HttpError(409, "attachments_unavailable");
        const result = await this.attachmentStore.upload(
          req,
          { deviceId: device.id, sessionId },
          this.field(url.searchParams.get("name"), 255),
          this.field(url.searchParams.get("mime") || "application/octet-stream"),
          () => {
            this.grant(hash, "attachments");
            if (
              !this.isFullAccess(device) &&
              !this.config.allowedWorkspaceIds?.includes(workspaceId)
            )
              throw new HttpError(403, "workspace_not_authorized");
          },
        );
        this.grant(hash, "attachments");
        if (!(await this.workspaceAllowed(workspaceId, device)))
          throw new HttpError(403, "workspace_not_authorized");
        return this.json(res, 201, result);
      }
      const body = await this.body(req);
      if (path.startsWith("/codex/"))
        return this.codexAction(res, hash, path.slice(7), body, control);
      if (path === "/attachments/delete") {
        if (lan) throw new HttpError(403, "attachments_require_same_origin");
        const device = this.grant(hash, "attachments");
        await this.attachmentStore.remove(
          device.id,
          this.field(body.sessionId),
          this.field(body.attachmentId),
          this.field(body.version),
        );
        return this.json(res, 200, { ok: true });
      }
      if (path === "/pair") {
        this.rate(`pair:${hash}`, 5);
        this.rate("pair", 20);
        const pairingBrowser = browser;
        const pairing = this.adminQueue.then(async () => {
          this.expire();
          if (pairingBrowser.ended || this.credentials.some((c) => c.hash === hash))
            throw new HttpError(409, "already_paired");
          if (this.browsers.get(hash) !== pairingBrowser || !this.server)
            throw new HttpError(401, "access_ended");
          const name = this.field(body.name, 80);
          if (!this.code) throw new HttpError(403, "invalid_pairing_code");
          const browserFailures = this.code.failuresByBrowser.get(hash) ?? 0;
          if (
            browserFailures >= PAIRING_FAILURES_PER_BROWSER ||
            this.code.failures >= PAIRING_FAILURES_PER_CODE ||
            body.code !== this.code.value
          ) {
            this.code.failuresByBrowser.set(hash, browserFailures + 1);
            this.code.failures++;
            throw new HttpError(403, "invalid_pairing_code");
          }
          if (!lan) {
            if (this.credentials.length >= 128) throw new HttpError(429, "device_limit");
            const credential: Credential = {
              hash,
              expiresAt: Date.now() + MAX_AGE,
              device: {
                id: token(),
                name,
                accessMode: "full",
                createdAt: Date.now(),
                ...CODE_ACCESS_PERMISSIONS[this.code.access],
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
            throw new HttpError(429, "pending_limit");
          pairingBrowser.pending = {
            id: token(),
            name,
            verification: randomInt(0, 100_000_000).toString().padStart(8, "0"),
            expiresAt: this.code.expiresAt,
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
      if (path === "/pair/cancel") {
        browser.pending = undefined;
        return this.json(res, 200, { ok: true });
      }
      if (path === "/logout") {
        // Share the config transaction queue: a logout captured during a provider
        // switch must not overwrite the new config with an old persistence snapshot.
        const logout = this.adminQueue.then(async () => {
          const loggedOut = this.credentials.find((c) => c.hash === hash);
          if (loggedOut) this.artifacts?.revokeDevice(loggedOut.device.id);
          this.credentials = this.credentials.filter((c) => c.hash !== hash);
          browser.ended = true;
          this.endStreams(hash);
          await this.save();
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
      if (path.startsWith("/managed/"))
        return this.manage(req, res, hash, path.slice(9), body, control);
      if (path === "/artifact-tickets") {
        const scope = await this.fileScope(hash, this.field(body.workspaceId));
        if (!this.artifacts) throw new HttpError(503, "preview_unavailable");
        const result = await this.artifacts.issueTicket(scope, {
          artifactId: this.field(body.artifactId),
          download: body.download === true,
        });
        this.grant(hash, "files");
        return this.json(res, 200, result);
      }
      if (!["/send", "/stop", "/approve", "/answer"].includes(path))
        throw new HttpError(404, "not_found");
      const operation = path.slice(1);
      const permission = operation === "approve" ? "approve" : "send";
      this.grant(hash, permission);
      const requestId = this.field(body.requestId, 128);
      const prior = await this.controlReceipt(requestId, this.grant(hash, permission).id, control);
      if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
      const sessionId = this.field(body.sessionId);
      if (this.isFullAccess(this.grant(hash))) await this.codexScope(sessionId, hash, false, false);
      if (!this.controlsEnabled(sessionId, this.grant(hash)))
        throw new HttpError(403, "session_control_not_allowed");
      const claudeReplay =
        prior?.found === true &&
        prior.sessionId === sessionId &&
        prior.executionMode === "claude-managed";
      this.grant(hash, permission);
      if (!claudeReplay && this.requests.has(requestId)) {
        control.priorUncertain = true;
        throw new HttpError(409, "duplicate_request");
      }
      if (this.active.has(sessionId)) throw new HttpError(409, "operation_busy");
      if (!claudeReplay && this.unconfirmed.has(sessionId)) {
        control.priorUncertain = true;
        throw new HttpError(409, "outcome_unknown");
      }
      if (this.requests.size >= 10_000) throw new HttpError(429, "request_capacity");
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0)
        throw new HttpError(400, "invalid_revision");
      const params: Record<string, unknown> = {
        operation,
        sessionId,
        requestId,
        deviceId: this.grant(hash, permission).id,
        expectedRevision: body.expectedRevision,
        experimentalEnabled: true,
      };
      if (operation === "send") {
        if (
          typeof body.text !== "string" ||
          (!body.text.trim() &&
            !(Array.isArray(body.attachmentIds) && body.attachmentIds.length)) ||
          body.text.length > 16_000 ||
          Buffer.byteLength(body.text, "utf8") > 16_384
        )
          throw new HttpError(400, "invalid_text");
        params.text = body.text;
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
          throw new HttpError(400, "invalid_answers");
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
          throw new HttpError(400, "invalid_answers");
        params.answers = body.answers;
      } else {
        params.turnId = this.field(body.turnId);
        params.approvalId =
          typeof body.approvalId === "number" && Number.isSafeInteger(body.approvalId)
            ? body.approvalId
            : this.field(body.approvalId);
        if (body.nativeDecision !== undefined) {
          this.grant(hash, "extendedApproval");
          if (JSON.stringify(body.nativeDecision).length > 16384)
            throw new HttpError(400, "invalid_decision");
          params.nativeDecision = body.nativeDecision;
          params.decision = typeof body.decision === "string" ? body.decision : "native";
        } else params.decision = this.field(body.decision);
      }
      if (this.admission) throw new HttpError(409, "operation_busy");
      this.rate(`control:${hash}`, 30);
      this.requests.add(requestId);
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
        if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
        if (!(await this.controlsEnabledForSnapshot(sessionId, snapshot, this.grant(hash), true)))
          throw new HttpError(403, "provider_control_not_allowed");
        if (
          !snapshot?.runtimeBootId ||
          (!claudeReplay && snapshot.revision !== body.expectedRevision)
        )
          throw new HttpError(409, "stale_state");
        if (!claudeReplay && operation === "send" && snapshot.sendEnabled !== true)
          throw new HttpError(409, "control_unavailable");
        if (
          !claudeReplay &&
          operation === "stop" &&
          (snapshot.stopEnabled !== true || snapshot.turnId !== params.turnId)
        )
          throw new HttpError(409, "turn_unavailable");
        if (!claudeReplay && operation === "answer") {
          const question = snapshot.questions?.find(
            (item) =>
              item.requestId === params.questionId &&
              item.turnId === params.turnId &&
              item.supported === true,
          );
          if (!question || !Array.isArray(question.questions) || !question.questions.length)
            throw new HttpError(409, "question_unavailable");
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
            throw new HttpError(400, "invalid_answers");
        }
        if (
          permission === "approve" &&
          snapshot.approvals?.find((item) => item.requestId === params.approvalId)
            ?.requiresExtendedApproval === true
        )
          this.grant(hash, "extendedApproval");
        if (
          !claudeReplay &&
          permission === "approve" &&
          !snapshot.approvals?.some(
            (approval) =>
              approval.requestId === params.approvalId &&
              approval.turnId === params.turnId &&
              approval.supported === true &&
              (params.nativeDecision !== undefined
                ? approval.decisionOptions?.some(
                    (option) =>
                      JSON.stringify(option.decision) === JSON.stringify(params.nativeDecision),
                  )
                : Array.isArray(approval.availableDecisions) &&
                  approval.availableDecisions.includes(String(params.decision))),
          )
        ) {
          throw new HttpError(409, "approval_unavailable");
        }
        if (operation === "send" && body.attachmentIds !== undefined) {
          const device = this.grant(hash, "attachments");
          await this.codexScope(sessionId, hash, true, false);
          const capabilities = (await this.options.runtimeRequest({
            operation: "capabilities",
            sessionId,
            experimentalEnabled: true,
          })) as { features?: Record<string, { available: boolean }> };
          if (!claudeReplay && capabilities.features?.attachments?.available !== true)
            throw new HttpError(409, "attachments_unavailable");
          const mode = (snapshot as { executionMode?: string }).executionMode;
          if (claudeReplay && body.resourceIds === undefined) {
            const previous = await replayClaudeAttachments(this.attachmentStore, prior, {
              deviceId: device.id,
              sessionId,
              requestId,
              expectedRevision: body.expectedRevision,
              attachmentIds: body.attachmentIds,
              text: String(body.text ?? ""),
            });
            this.grant(hash, permission);
            this.grant(hash, "attachments");
            if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
            if (previous) {
              if (previous.controlOutcome === "not-dispatched") {
                control.priorUncertain = false;
                throw new HttpError(409, "control_preflight_rejected");
              }
              control.priorUncertain = previous.accepted !== true;
              if (previous.accepted !== true) throw new HttpError(502, "outcome_unknown");
              return this.json(res, 200, previous);
            }
          }
          const alreadyPinned =
            mode === "claude-managed" &&
            (await this.attachmentStore.pendingRequests(sessionId)).some(
              (item) => item.deviceId === device.id && item.requestId === requestId,
            );
          params.input =
            mode === "claude-managed"
              ? await this.attachmentStore.inputForAgent(
                  device.id,
                  sessionId,
                  body.attachmentIds,
                  String(body.text ?? ""),
                  "claude",
                  requestId,
                )
              : await this.attachmentStore.input(
                  device.id,
                  sessionId,
                  body.attachmentIds,
                  String(body.text ?? ""),
                );
          if (mode === "claude-managed" && !alreadyPinned) newlyPinnedDevice = device.id;
          delete params.text;
          this.grant(hash, "attachments");
        }
        if (operation === "send" && body.resourceIds !== undefined) {
          this.fullAccess(hash);
          const capabilities = (await this.options.runtimeRequest({
            operation: "capabilities",
            sessionId,
            experimentalEnabled: true,
          })) as { features?: Record<string, { available: boolean }> };
          if (
            capabilities.features?.context?.available !== true &&
            capabilities.features?.resources?.available !== true
          )
            throw new HttpError(409, "context_unavailable");
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
            throw new HttpError(400, "too_many_input_items");
          params.resourceRefs = resourceRefs;
        }
        this.grant(hash, permission);
        if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
        params.runtimeBootId = snapshot.runtimeBootId;
        dispatched = true;
        control.dispatched = true;
        this.unconfirmed.add(sessionId);
        this.unconfirmedRequests.set(sessionId, requestId);
        const pending = Promise.resolve()
          .then(() =>
            (snapshot as { executionMode?: string }).executionMode === "claude-managed" &&
            this.options.receiptRequest
              ? dispatchClaude(this.options.runtimeRequest, this.options.receiptRequest, params)
              : this.options.runtimeRequest(params),
          )
          .finally(() => {
            this.active.delete(sessionId);
            this.admission = false;
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
          result.controlOutcome === "not-dispatched" &&
          "requestId" in result &&
          result.requestId === requestId &&
          "runtimeBootId" in result &&
          result.runtimeBootId === snapshot.runtimeBootId
        ) {
          this.unconfirmed.delete(sessionId);
          control.dispatched = false;
          control.priorUncertain = false;
          if ((snapshot as { executionMode?: string }).executionMode === "claude-managed")
            await this.attachmentStore.settle(String(params.deviceId), sessionId, requestId);
          this.grant(hash, permission);
          if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
          throw new HttpError(409, "control_preflight_rejected");
        }
        this.grant(hash, permission);
        if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
        if (
          typeof result !== "object" ||
          result === null ||
          !("accepted" in result) ||
          result.accepted !== true
        )
          throw new HttpError(502, "outcome_unknown");
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
            this.unconfirmed.delete(sessionId);
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
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
    this.grant(hash);
    if (path === "/attachments") {
      if (lan) throw new HttpError(403, "attachments_require_same_origin");
      const device = this.grant(hash, "attachments");
      const attachments = await this.attachmentStore.list(
        device.id,
        this.field(url.searchParams.get("sessionId")),
      );
      this.grant(hash, "attachments");
      return this.json(res, 200, { attachments });
    }
    if (
      path === "/codex/session-settings" ||
      path === "/codex/goals" ||
      path === "/codex/context-options"
    ) {
      const sessionId = this.field(url.searchParams.get("sessionId"));
      // 与 projectCapabilities 一致：settings-state/usage/goal/context 都属于 advancedControl，
      // 只读设备即便是 full 模式也不能读取。
      const device = this.fullAccess(hash, "advancedControl");
      const workspaceId = await this.codexScope(sessionId, hash);
      let result: unknown;
      if (path === "/codex/session-settings") {
        const settings = await this.runtime({ operation: "settings-state", sessionId });
        this.fullAccess(hash, "advancedControl");
        const usage = await this.runtime({ operation: "usage", sessionId });
        result = { sessionId, ...this.projectSettings(settings, usage) };
      } else if (path === "/codex/goals") {
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
          throw new HttpError(400, "invalid_directory_id");
        result = (await this.contextResources(sessionId, device, workspaceId, directoryId))
          .response;
      }
      if (this.fullAccess(hash, "advancedControl").id !== device.id)
        throw new HttpError(401, "access_ended");
      await this.codexScope(sessionId, hash);
      return this.json(res, 200, result);
    }
    if (path === "/codex/capabilities" || path === "/codex/queue") {
      const sessionId = this.field(url.searchParams.get("sessionId"));
      const device = this.grant(hash, path.endsWith("queue") ? "advancedControl" : undefined);
      if (path.endsWith("queue") || this.isFullAccess(device))
        await this.codexScope(sessionId, hash);
      const result = await this.runtime({
        operation: path.endsWith("queue") ? "queue-list" : "capabilities",
        sessionId,
        experimentalEnabled: this.controlsEnabled(sessionId, this.grant(hash)),
      });
      this.grant(hash);
      if (path.endsWith("capabilities")) {
        const catalog = (await this.runtime({ operation: "catalog" })) as {
          sessions: { id: string; workspace_id: string }[];
        };
        this.grant(hash);
        const workspace = catalog.sessions.find((item) => item.id === sessionId)?.workspace_id;
        return this.json(
          res,
          200,
          this.projectCapabilities(
            result,
            device,
            !!workspace && (await this.workspaceAllowed(workspace, device)),
            sessionId,
          ),
        );
      }
      if ((result as { reason?: string }).reason === "queue-too-large")
        throw new HttpError(409, "queue_too_large");
      const entries =
        (result as { data?: { id: string; input?: { type: string; text?: string }[] }[] }).data ??
        [];
      return this.json(res, 200, {
        sessionId,
        data: entries.map((item) => ({
          id: item.id,
          hasAttachments: (item.input ?? []).some(
            (input) => input.type !== "text" || input.text?.startsWith("User attached file "),
          ),
          text: (item.input ?? [])
            .filter(
              (input) => input.type === "text" && !input.text?.startsWith("User attached file "),
            )
            .map((input) => input.text ?? "")
            .join("\n"),
        })),
      });
    }
    if (path.startsWith("/requests/")) {
      const device = this.grant(hash);
      const requestId = this.field(path.slice("/requests/".length), 128);
      if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new HttpError(400, "invalid_input");
      if (!this.options.receiptRequest) throw new HttpError(503, "receipt_unavailable");
      const result = (await this.runtime(
        {},
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
      };
      this.grant(hash);
      if (result.recovery !== undefined) {
        if (
          result.found !== true ||
          result.requestId !== requestId ||
          result.status !== "not-dispatched" ||
          result.recovery !== "legacy-prepared" ||
          result.completionObserved !== false
        )
          throw new HttpError(503, "receipt_unavailable");
        for (const [sessionId, pendingRequestId] of this.unconfirmedRequests) {
          if (pendingRequestId === requestId && !this.active.has(sessionId)) {
            this.unconfirmed.delete(sessionId);
            this.unconfirmedRequests.delete(sessionId);
          }
        }
        // Old prepared claims may lack ownership and operation metadata. Expose
        // only the durable non-dispatch proof, never runtime metadata or an ack.
        return this.json(res, 200, {
          found: true,
          requestId,
          status: "not-dispatched",
          recovery: "legacy-prepared",
          completionObserved: false,
        });
      }
      if (result.found) {
        if (result.operation?.startsWith("goal-")) this.fullAccess(hash);
        const permission =
          result.operation === "approve"
            ? "approve"
            : ["create", "adopt", "release", "reconcile"].includes(result.operation ?? "")
              ? "manage"
              : [
                    "steer",
                    "queue-add",
                    "queue-update",
                    "queue-delete",
                    "queue-reorder",
                    "queue-start",
                    "rename",
                    "archive",
                    "unarchive",
                    "fork",
                    "settings",
                    "goal-set",
                    "goal-pause",
                    "goal-resume",
                    "goal-clear",
                    "resume",
                  ].includes(result.operation ?? "")
                ? this.codexPermission(result.operation!)
                : "send";
        this.grant(hash, permission);
        // Follower controls use the existing device send/approve grant; only
        // managed execution adds a workspace allowlist. Receipt recovery must
        // enforce the same boundary as the command it reports.
        if (
          (this.isFullAccess(device) || result.executionMode !== "codex-follower") &&
          result.workspaceId &&
          !(await this.workspaceAllowed(result.workspaceId, device))
        )
          throw new HttpError(403, "workspace_not_authorized");
        if (
          result.sessionId &&
          ["accepted", "not-dispatched"].includes(result.status ?? "") &&
          this.unconfirmedRequests.get(result.sessionId) === requestId &&
          !this.active.has(result.sessionId)
        ) {
          this.unconfirmed.delete(result.sessionId);
          this.unconfirmedRequests.delete(result.sessionId);
        }
      }
      return this.json(res, 200, result);
    }
    if (path === "/managed/options") {
      const permission = this.grant(hash).manage === true ? "manage" : "settings";
      this.grant(hash, permission);
      const agent = url.searchParams.get("agent") ?? "codex";
      if (agent !== "codex" && agent !== "claude-code") throw new HttpError(400, "invalid_agent");
      const managedRequest =
        agent === "claude-code" ? this.options.claudeManagedRequest : this.options.managedRequest;
      const options = managedRequest
        ? await managedRequest({ operation: "options" })
        : { available: false, reason: "unsupported_host" };
      const device = this.grant(hash, permission);
      const workspaces = device.manage === true ? await this.registeredWorkspaces() : [];
      this.grant(hash, permission);
      return this.json(res, 200, {
        ...(options as object),
        workspaces: workspaces
          .filter(
            (w) => this.isFullAccess(device) || this.config.allowedWorkspaceIds?.includes(w.id),
          )
          .map(({ id, name }) => ({ id, name })),
      });
    }
    if (path === "/managed/capabilities" || path === "/managed/inspect") {
      const agent = url.searchParams.get("agent") ?? "codex";
      if (agent !== "claude-code") throw new HttpError(400, "invalid_agent");
      const sessionId = this.field(url.searchParams.get("sessionId"));
      const device = this.grant(hash);
      if (path.endsWith("inspect")) this.grant(hash, "manage");
      const workspaceId = await this.codexScope(sessionId, hash, false, false);
      const managedRequest = this.options.claudeManagedRequest;
      if (!managedRequest) throw new HttpError(409, "unsupported_host");
      const result = await managedRequest({
        operation: path.endsWith("inspect") ? "inspect" : "capabilities",
        sessionId,
        experimentalEnabled: this.controlsEnabled(sessionId, device),
      });
      this.grant(hash);
      if (!(await this.workspaceAllowed(workspaceId, this.grant(hash))))
        throw new HttpError(403, "workspace_not_authorized");
      return this.json(
        res,
        200,
        path.endsWith("capabilities")
          ? this.projectClaudeCapabilities(result, this.grant(hash), sessionId)
          : result,
      );
    }
    if (path === "/managed/context") {
      const id = this.field(url.searchParams.get("sessionId"));
      const device = this.grant(hash);
      const catalog = (await this.runtime({ operation: "catalog" })) as {
        sessions: { id: string; workspace_id: string; agent: string }[];
      };
      const session = catalog.sessions.find((entry) => entry.id === id && entry.agent === "codex");
      if (!session || !(await this.workspaceAllowed(session.workspace_id, device)))
        throw new HttpError(403, "workspace_not_authorized");
      const result = await this.runtime({ operation: "context", sessionId: id });
      if (this.grant(hash).id !== device.id) throw new HttpError(401, "access_ended");
      if (!(await this.workspaceAllowed(session.workspace_id, device)))
        throw new HttpError(403, "workspace_not_authorized");
      return this.json(res, 200, result);
    }
    if (path.startsWith("/files/") || path === "/artifacts" || path === "/diff")
      return this.files(res, hash, path, url);
    const sessionId =
      path === "/catalog" ? undefined : this.field(url.searchParams.get("sessionId"));
    const streamWorkspaceId =
      sessionId && this.isFullAccess(this.grant(hash))
        ? await this.codexScope(sessionId, hash, false, false)
        : undefined;
    if (path === "/stream") {
      if (
        this.streams.size >= 16 ||
        [...this.streams.values()].filter((h) => h === hash).length >= 2
      )
        throw new HttpError(429, "stream_limit");
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      this.streams.set(res, hash);
      let timer: ReturnType<typeof setTimeout>;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      let backpressured = false;
      let previousData: string | undefined;
      let lastWriteAt = Date.now();
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(drainTimer);
        res.off("drain", resume);
        this.streams.delete(res);
      };
      const resume = () => {
        clearTimeout(drainTimer);
        backpressured = false;
        if (this.streams.has(res) && !res.writableEnded && !res.destroyed)
          timer = setTimeout(() => void poll(), 2000);
      };
      const write = (message: string) => {
        if (res.writableEnded || res.destroyed || !this.streams.has(res)) return;
        // false means the frame was accepted into Node's buffer. Do not resend
        // it or poll for another snapshot until the slow reader catches up.
        if (!res.write(message)) {
          backpressured = true;
          res.once("drain", resume);
          drainTimer = setTimeout(() => {
            cleanup();
            res.destroy();
          }, 30_000);
        }
        lastWriteAt = Date.now();
      };
      const poll = async () => {
        try {
          const device = this.grant(hash);
          if (streamWorkspaceId && !(await this.workspaceAllowed(streamWorkspaceId, device))) {
            cleanup();
            res.end();
            return;
          }
          const snapshot = await this.streamSnapshot(sessionId, device);
          // Each browser remains independently authorized before and after the shared read.
          this.grant(hash);
          if (!this.streams.has(res)) return;
          const data = JSON.stringify(await this.projectLive(sessionId, snapshot, device));
          this.grant(hash);
          if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error("snapshot_too_large");
          const message =
            data !== previousData
              ? `event: snapshot\ndata: ${data}\n\n`
              : Date.now() - lastWriteAt >= 15_000
                ? ": heartbeat\n\n"
                : undefined;
          if (message) write(message);
          previousData = data;
        } catch (error) {
          // Admission reserves runtime capacity for control. A skipped read is
          // not a stream outage; keep polling and keep revocation checks active.
          if (
            !(error instanceof HttpError && error.message === "operation_busy") &&
            !res.writableEnded
          ) {
            previousData = undefined;
            write("event: unavailable\ndata: {}\n\n");
          } else if (
            this.streams.has(res) &&
            !res.writableEnded &&
            Date.now() - lastWriteAt >= 15_000
          ) {
            write(": heartbeat\n\n");
          }
        }
        if (this.streams.has(res) && !backpressured && !res.writableEnded && !res.destroyed)
          timer = setTimeout(() => void poll(), 2000);
      };
      res.once("close", cleanup);
      res.once("finish", cleanup);
      void poll();
      return;
    }
    let params: Record<string, unknown>;
    if (path === "/catalog") params = { operation: "catalog" };
    else if (path === "/events") {
      const limit = Number(url.searchParams.get("limit") || 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50)
        throw new HttpError(400, "invalid_limit");
      const cursor = url.searchParams.get("cursor");
      if (cursor && cursor.length > 1024) throw new HttpError(400, "invalid_cursor");
      params = { operation: "events", sessionId, cursor, limit };
    } else if (path === "/live")
      params = {
        operation: "live",
        sessionId,
        experimentalEnabled: this.controlsEnabled(sessionId, this.grant(hash)),
      };
    else throw new HttpError(404, "not_found");
    const boot = this.bootId;
    let result = await this.runtime(params);
    const device = this.grant(hash);
    if (path === "/catalog" && this.isFullAccess(device)) {
      const registered = new Set(
        (await this.registeredWorkspaces()).map((workspace) => workspace.id),
      );
      const catalog = result as {
        workspaces?: { id: string }[];
        sessions?: { workspace_id: string }[];
      };
      result = {
        ...catalog,
        workspaces: catalog.workspaces?.filter((workspace) => registered.has(workspace.id)),
        sessions: catalog.sessions?.filter((session) => registered.has(session.workspace_id)),
      };
      this.grant(hash);
    }
    if (path === "/live") result = await this.projectLive(sessionId, result, device);
    this.grant(hash);
    if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
    return this.json(res, 200, result);
  }
  private async static(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpError(405, "method_not_allowed");
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch {
      throw new HttpError(400, "invalid_path");
    }
    if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").includes(".."))
      throw new HttpError(403, "invalid_path");
    const root = await realpath(this.options.staticDir);
    const candidate = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    let file: string;
    try {
      file = await realpath(candidate);
    } catch {
      throw new HttpError(404, "not_found");
    }
    const rel = relative(root, file);
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== file)
      throw new HttpError(403, "invalid_path");
    // 先看元数据：目录直接 404，超大文件在读入内存之前就拒绝。
    const info = await stat(file);
    if (!info.isFile()) throw new HttpError(404, "not_found");
    if (info.size > 16 * 1024 * 1024) throw new HttpError(413, "asset_too_large");
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
