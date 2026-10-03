import { spawn, execFile, type ChildProcess } from "node:child_process";
import {
  generateKeyPairSync,
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  createHash,
} from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer, request as httpsRequest, type Server } from "node:https";
import type { Duplex } from "node:stream";
import { join, resolve } from "node:path";
import { rootCertificates, type TLSSocket } from "node:tls";
import { promisify } from "node:util";

export const DEFAULT_RELAY_BROKER = "https://api.agentkib.com";
type Channel = "control" | "preview";
export type RelayFailure = {
  stage:
    | "broker"
    | "certificate"
    | "control-connector"
    | "preview-connector"
    | "control-probe"
    | "preview-probe";
  code:
    | "dns"
    | "timeout"
    | "tls"
    | "http"
    | "process"
    | "identity"
    | "unreachable"
    | "unknown"
    | "integrity"
    | "conflict";
};
type Reason =
  | "revoked"
  | "lease-expired"
  | "network"
  | "certificate"
  | "connector"
  | "suspended"
  | "setup";
export type RelayStatus = {
  phase: "disabled" | "registering" | "certifying" | "connecting" | "ready" | "offline" | "error";
  publicUrl?: string;
  previewUrl?: string;
  error?: string;
  reason?: Reason;
  channels?: Record<Channel, boolean>;
  retryAt?: number;
  certificateWarning?: boolean;
  failure?: RelayFailure;
  connectorExit?: { channel: Channel; code?: number; signal?: string };
};
type Target = { host: "127.0.0.1"; port: number };
export type RelayNode = { id: string; transport: "frp-wss"; host: string; port: number };
export type Registration = {
  accountId?: string;
  accountClaimPending?: boolean;
  accountClaimAccountId?: string;
  deviceId: string;
  credential: string;
  controlHost: string;
  previewHost: string;
  tunnelHost: string;
  tunnelPort: number;
  brokerUrl: string;
  protocolVersion?: number;
  node?: RelayNode;
};
export type RelayOptions = {
  brokerUrl?: string;
  inviteCode?: string;
  registrationAccountId?: string;
  registerAccount?: (input: {
    registrationId: string;
    credential: string;
  }) => Promise<Record<string, unknown>>;
  authorizeAccount?: (accountId?: string) => Promise<void>;
  reenroll?: boolean;
  stateDirectory: string;
  frpcPath: string;
  /** Desktop production supplies the checksum-verified bundled executable as the trust anchor. */
  trustedFrpcPath?: string;
  /** Local IPC only. Private key material must never be sent to the broker. */
  createCsr?: (
    input: { privateKeyDer: string; hosts: string[] },
    signal: AbortSignal,
  ) => Promise<{ csrPem: string }>;
  target: Target;
  preview: Target;
  onStatus?: (status: RelayStatus) => void;
  onOrigins?: (origins: { publicUrl: string; previewUrl: string }) => void | Promise<void>;
};
type PendingRegistration = {
  accountId?: string;
  reenroll?: boolean;
  brokerUrl: string;
  registrationId: string;
  credential: string;
};
const execute = promisify(execFile);
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CREDENTIAL = /^[A-Za-z0-9_-]{40,128}$/;
const RENEW_BEFORE = 21 * 86_400_000;
/** 本机 runtime 生成 CSR 的上限；runtime 卡住但没退出时，请求不能无限挂着。 */
const CSR_TIMEOUT_MS = 30_000;
const CHANNELS: Channel[] = ["control", "preview"];

class RelayHttpError extends Error {}
class RelayIdentityError extends Error {}
class RelayExecutableError extends Error {}

function failureCode(error: unknown): RelayFailure["code"] {
  if (error instanceof RelayExecutableError) return "integrity";
  if (error instanceof RelayHttpError) return "http";
  if (error instanceof RelayIdentityError) return "identity";
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    return "timeout";
  const code =
    (error as { code?: unknown })?.code ?? (error as { cause?: { code?: unknown } })?.cause?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "timeout";
  if (
    typeof code === "string" &&
    (code.startsWith("ERR_TLS_") ||
      code.startsWith("ERR_SSL_") ||
      code.startsWith("ERR_OSSL_") ||
      code.startsWith("CERT_") ||
      code === "EPROTO" ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")
  )
    return "tls";
  if (["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(String(code)))
    return "unreachable";
  return "unknown";
}

export function validateRegistration(value: unknown, brokerUrl: string): Registration {
  if (!value || typeof value !== "object") throw new Error("Invalid relay registration");
  const data = value as Record<string, unknown>;
  if (
    typeof data.deviceId !== "string" ||
    !/^[a-f0-9]{32}$/.test(data.deviceId) ||
    typeof data.credential !== "string" ||
    !CREDENTIAL.test(data.credential) ||
    !["controlHost", "previewHost", "tunnelHost"].every(
      (k) => typeof data[k] === "string" && HOST.test(data[k] as string),
    ) ||
    data.controlHost === data.previewHost ||
    data.tunnelPort !== 443
  )
    throw new Error("Invalid relay registration");
  let node: RelayNode | undefined;
  if (data.protocolVersion !== undefined && data.protocolVersion !== 2)
    throw new Error("Unsupported relay protocol");
  if (data.node !== undefined) {
    const n = data.node as Record<string, unknown>;
    if (
      !n ||
      typeof n.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(n.id) ||
      n.transport !== "frp-wss" ||
      typeof n.host !== "string" ||
      !HOST.test(n.host) ||
      n.port !== 443
    )
      throw new Error("Invalid relay node");
    node = { id: n.id, transport: "frp-wss", host: n.host, port: 443 };
  }
  if (
    data.accountId !== undefined &&
    (typeof data.accountId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.accountId))
  )
    throw new Error("Invalid account owner");
  if (
    data.accountClaimAccountId !== undefined &&
    (typeof data.accountClaimAccountId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(data.accountClaimAccountId))
  )
    throw new Error("Invalid pending account owner");
  if (data.protocolVersion === 2 && !node) throw new Error("Missing relay node");
  return {
    deviceId: data.deviceId,
    ...(data.accountClaimPending === true
      ? {
          accountClaimPending: true,
          ...(typeof data.accountClaimAccountId === "string"
            ? { accountClaimAccountId: data.accountClaimAccountId }
            : {}),
        }
      : {}),
    ...(typeof data.accountId === "string" ? { accountId: data.accountId } : {}),
    credential: data.credential,
    controlHost: data.controlHost as string,
    previewHost: data.previewHost as string,
    tunnelHost: data.tunnelHost as string,
    tunnelPort: 443,
    brokerUrl,
    ...(node ? { node, protocolVersion: 2 } : {}),
  };
}
export function validateCertificate(
  certificate: string,
  key: string,
  hosts: string[],
  now = Date.now(),
): X509Certificate {
  const cert = new X509Certificate(certificate);
  if (
    Date.parse(cert.validFrom) > now ||
    Date.parse(cert.validTo) <= now ||
    hosts.some((host) => cert.checkHost(host, { wildcards: false }) !== host)
  )
    throw new Error("Relay certificate is not valid for this device");
  if (
    !cert.publicKey
      .export({ format: "der", type: "spki" })
      .equals(createPublicKey(key).export({ format: "der", type: "spki" }))
  )
    throw new Error("Relay certificate does not match the local private key");
  return cert;
}
export function buildFrpcConfig(
  device: Registration,
  localPort: number,
  trustedCaFile: string,
  channel: Channel = "control",
): string {
  const q = JSON.stringify;
  const host = device.node?.host ?? device.tunnelHost;
  return `serverAddr = ${q(host)}\nserverPort = 443\nuser = ${q(device.deviceId)}\nloginFailExit = false\nmetadatas.credential = ${q(device.credential)}\ntransport.protocol = "wss"\ntransport.tls.enable = true\ntransport.tls.serverName = ${q(host)}\ntransport.tls.trustedCaFile = ${q(trustedCaFile)}\ntransport.tcpMux = true\ntransport.heartbeatInterval = 15\ntransport.heartbeatTimeout = 45\nauth.additionalScopes = ["HeartBeats", "NewWorkConns"]\nlog.level = "warn"\nlog.to = "console"\n[[proxies]]\nname = ${q(channel)}\ntype = "https"\nlocalIP = "127.0.0.1"\nlocalPort = ${localPort}\ncustomDomains = [${q(channel === "control" ? device.controlHost : device.previewHost)}]\n`;
}
/**
 * 状态文件不存在或内容损坏（JSON 解析失败、字段校验失败）。带其他 errno 的 IO 错误
 * （权限、磁盘）不算，照常抛出。
 */
function unreadableState(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === undefined;
}
/** Do not rely on a callback/fetch implementation honoring AbortSignal: late results must never revive a session. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Relay stopped"));
    if (signal.aborted) {
      void work.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** TLS terminates on this computer. Neither tunnel process owns or stops Codex execution. */
export class RelayManager {
  private current: RelayStatus = { phase: "disabled" };
  private readonly brokerUrl: string;
  private registration?: Registration;
  private servers = new Map<Channel, Server>();
  private children = new Map<Channel, ChildProcess>();
  private connectorFailures = new Map<Channel, RelayFailure>();
  private sockets = new Set<Duplex>();
  private exiting = new Set<Promise<void>>();
  private ready: Record<Channel, boolean> = { control: false, preview: false };
  private abort?: AbortController;
  private running?: Promise<void>;
  private stopping?: Promise<void>;
  private maintaining?: Promise<void>;
  private authorizing?: Promise<void>;
  private renewing?: Promise<void>;
  private authTimer?: ReturnType<typeof setTimeout>;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private certificateTimer?: ReturnType<typeof setTimeout>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private leaseUntil = 0;
  private wallLeaseUntil = 0;
  private probeToken = randomBytes(32).toString("hex");
  private frpcPath: string;
  private certificate = "";
  private key = "";
  private generation = 0;
  private nextRenewal = 0;
  private failures = 0;
  private enabled = false;
  private reenrolling: boolean;
  private suspended = false;
  private certificateWarning = false;
  private failure?: RelayFailure;
  private connectorExit?: RelayStatus["connectorExit"];
  constructor(private options: RelayOptions) {
    this.frpcPath = options.frpcPath;
    this.reenrolling = options.reenroll === true;
    if (this.reenrolling && !options.inviteCode?.trim())
      throw new Error("A new invitation is required for reenrollment");
    this.brokerUrl = options.brokerUrl ?? DEFAULT_RELAY_BROKER;
    const url = new URL(this.brokerUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("Relay broker must be an HTTPS origin");
    for (const target of [options.target, options.preview])
      if (
        target.host !== "127.0.0.1" ||
        !Number.isInteger(target.port) ||
        target.port < 1 ||
        target.port > 65535
      )
        throw new Error("Invalid loopback target");
  }
  get status(): RelayStatus {
    return { ...this.current, channels: { ...this.ready } };
  }
  private report(phase: RelayStatus["phase"], reason?: Reason, retryAt?: number) {
    if (phase === "ready" || phase === "disabled") {
      this.failure = undefined;
      this.connectorExit = undefined;
      this.connectorFailures.clear();
    }
    this.current = {
      phase,
      ...(this.registration
        ? {
            publicUrl: `https://${this.registration.controlHost}`,
            previewUrl: `https://${this.registration.previewHost}`,
          }
        : {}),
      ...(reason
        ? {
            reason,
            error: {
              revoked: "Relay authorization was rejected. Reconnect with a new invitation.",
              "lease-expired": "Relay authorization expired; public connections are closed.",
              network: "Relay is unreachable. Retrying automatically.",
              certificate: "Relay certificate is unavailable or invalid.",
              connector: "Relay connector is unavailable. Retrying automatically.",
              suspended: "Relay is suspended; public connections are closed.",
              setup: "Relay setup is incomplete. Check configuration and registration.",
            }[reason],
          }
        : {}),
      ...(retryAt ? { retryAt } : {}),
      ...(this.connectorExit && reason === "connector"
        ? { connectorExit: this.connectorExit }
        : {}),
      ...(this.certificateWarning ? { certificateWarning: true } : {}),
      ...(reason && this.failure && !["revoked", "lease-expired", "suspended"].includes(reason)
        ? { failure: this.failure }
        : {}),
    };
    this.options.onStatus?.(this.status);
  }
  private recordFailure(stage: RelayFailure["stage"], error: unknown) {
    this.failure = { stage, code: failureCode(error) };
  }
  private async store(name: string, value: string | Buffer) {
    const file = join(this.options.stateDirectory, name);
    await writeFile(file + ".tmp", value, { mode: 0o600 });
    await chmod(file + ".tmp", 0o600);
    await rename(file + ".tmp", file);
  }
  private active(generation: number) {
    if (generation !== this.generation || !this.abort || this.abort.signal.aborted)
      throw new Error("Relay stopped");
  }
  private liveLease() {
    return this.leaseUntil > performance.now() && this.wallLeaseUntil > Date.now();
  }
  private async api(
    path: string,
    payload: object,
    generation: number,
  ): Promise<Record<string, unknown>> {
    this.active(generation);
    try {
      const signal = AbortSignal.any([
        this.abort!.signal,
        AbortSignal.timeout(path === "/v1/certificate" ? 180_000 : 15_000),
      ]);
      const response = await abortable(
        fetch(new URL(path, this.brokerUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.registration
              ? { authorization: `Bearer ${this.registration.credential}` }
              : {}),
          },
          body: JSON.stringify(payload),
          signal,
          redirect: "error",
        }),
        signal,
      );
      this.active(generation);
      if (!response.ok) {
        // 不读的错误响应体要取消，否则连接一直被占着，重试风暴时会攒下一堆。
        void response.body?.cancel().catch(() => {});
        if (response.status === 403) throw new RelayAuthorizationError();
        throw new RelayHttpError();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty relay response");
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const { done, value } = await abortable(reader.read(), signal);
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65_536) throw new Error("Oversized relay response");
          chunks.push(value);
        }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      this.active(generation);
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch (error) {
      if (!(error instanceof RelayAuthorizationError) && generation === this.generation)
        this.recordFailure(path === "/v1/certificate" ? "certificate" : "broker", error);
      throw error;
    }
  }
  start(): Promise<void> {
    if (this.stopping) return this.stopping.then(() => this.start());
    this.enabled = true;
    this.suspended = false;
    if (this.running) return this.running;
    if (this.abort) return Promise.resolve();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.abort = new AbortController();
    this.failure = undefined;
    this.connectorExit = undefined;
    const generation = ++this.generation;
    // Announce startup before the async executable check so repeated desktop
    // enable requests recognize the in-flight attempt rather than restart it.
    this.report("connecting");
    const work = this.initialize(generation).catch((error) => {
      if (generation !== this.generation) return;
      this.failClosed(
        error instanceof RelayAuthorizationError
          ? "revoked"
          : this.current.phase === "certifying"
            ? "certificate"
            : this.failure?.stage === "broker"
              ? "network"
              : "setup",
        !(error instanceof RelayAuthorizationError || error instanceof RelayExecutableError),
      );
    });
    this.running = work;
    void work.finally(() => {
      if (this.running === work) this.running = undefined;
    });
    return work;
  }
  private async register(generation: number) {
    let pending: PendingRegistration | undefined;
    try {
      pending = JSON.parse(
        await readFile(join(this.options.stateDirectory, "registration-pending.json"), "utf8"),
      ) as PendingRegistration;
      if (
        pending.brokerUrl !== this.brokerUrl ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(pending.registrationId) ||
        !CREDENTIAL.test(pending.credential) ||
        (pending.reenroll !== undefined && typeof pending.reenroll !== "boolean")
      )
        throw new Error("Invalid pending registration");
    } catch (error) {
      if (!unreadableState(error)) throw error;
      // 损坏的待注册记录没法再用（凭据对不上），留着只会让每次启动都失败，包括重新邀请。
      pending = undefined;
      await rm(join(this.options.stateDirectory, "registration-pending.json"), { force: true });
    }
    // A durable pending reenrollment takes precedence even after a crash. Never fall back to the revoked old identity.
    if (!pending && !this.reenrolling) {
      try {
        const stored = JSON.parse(
          await readFile(join(this.options.stateDirectory, "registration.json"), "utf8"),
        );
        if (stored.brokerUrl !== this.brokerUrl)
          throw new Error("Registration belongs to another broker");
        this.registration = validateRegistration(stored, this.brokerUrl);
        return;
      } catch (error) {
        // 损坏的注册记录按"没有注册"处理：有邀请码就重新注册，没有就提示需要邀请码。
        if (!unreadableState(error)) throw error;
      }
    }
    if (pending?.accountId && pending.accountId !== this.options.registrationAccountId)
      throw new Error("account_registration_pending");
    if (!pending) {
      if (!this.options.inviteCode && !this.options.registerAccount)
        throw new Error("Relay invitation required");
      pending = {
        ...(this.options.registerAccount && !this.options.inviteCode
          ? { accountId: this.options.registrationAccountId }
          : {}),
        brokerUrl: this.brokerUrl,
        registrationId: randomUUID(),
        credential: randomBytes(32).toString("base64url"),
        ...(this.reenrolling ? { reenroll: true } : {}),
      };
      await this.store("registration-pending.json", JSON.stringify(pending));
    }
    this.registration = undefined;
    this.active(generation);
    const result =
      this.options.registerAccount && !this.options.inviteCode
        ? await abortable(
            this.options.registerAccount({
              registrationId: pending.registrationId,
              credential: pending.credential,
            }),
            this.abort!.signal,
          )
        : await this.api(
            "/v1/register",
            {
              registrationId: pending.registrationId,
              credential: pending.credential,
              ...(this.options.inviteCode ? { invitation: this.options.inviteCode } : {}),
            },
            generation,
          );
    if (pending.accountId && result.accountId !== pending.accountId)
      throw new Error("account_registration_mismatch");
    this.active(generation);
    // A legacy server's supplied credential remains authoritative during migration.
    this.registration = validateRegistration(
      { ...result, credential: result.credential ?? pending.credential },
      this.brokerUrl,
    );
    await this.store("registration.json", JSON.stringify(this.registration));
    this.active(generation);
    await rm(join(this.options.stateDirectory, "registration-pending.json"), { force: true });
    this.reenrolling = false;
  }
  private async prepareFrpc(generation: number) {
    this.frpcPath = this.options.frpcPath;
    const trusted = this.options.trustedFrpcPath;
    if (trusted === undefined) return;
    if (!trusted || !this.options.frpcPath)
      throw new RelayExecutableError("Bundled frpc unavailable");
    // The packaged asset was verified against the upstream archive during staging.
    // Check bytes before any execution, including --version (a script could spoof its output).
    const signal = AbortSignal.any([this.abort!.signal, AbortSignal.timeout(10_000)]);
    const readExecutable = async (path: string) => {
      const file = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size === 0 || info.size > 64 * 1024 * 1024)
          throw new RelayExecutableError("Invalid frpc executable");
        return await readFile(file, { signal });
      } finally {
        await file.close();
      }
    };
    const [candidate, reference] = await abortable(
      Promise.all([readExecutable(this.options.frpcPath), readExecutable(trusted)]),
      signal,
    );
    this.active(generation);
    const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    if (hash(candidate) !== hash(reference))
      throw new RelayExecutableError("frpc checksum mismatch");
    if (resolve(this.options.frpcPath) === resolve(trusted)) return;
    // Execute this verified snapshot: replacing the user-supplied path after the check must
    // not switch the program launched during a later reconnect.
    const name = process.platform === "win32" ? "verified-frpc.exe" : "verified-frpc";
    await this.store(name, candidate);
    const staged = join(this.options.stateDirectory, name);
    await chmod(staged, 0o700);
    this.active(generation);
    this.frpcPath = staged;
  }
  private async initialize(generation: number) {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.options.stateDirectory, 0o700);
    try {
      await this.prepareFrpc(generation);
      this.active(generation);
      const version = await execute(this.frpcPath, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 4_096,
        signal: this.abort!.signal,
      });
      if (version.stdout.trim() !== "0.68.0")
        throw new RelayExecutableError("frpc v0.68.0 is required");
    } catch (error) {
      this.recordFailure("control-connector", error);
      throw error;
    }
    this.active(generation);
    this.report("registering");
    await this.register(generation);
    this.active(generation);
    if (this.registration?.accountClaimPending) throw new Error("account_claim_pending");
    await this.options.authorizeAccount?.(this.registration?.accountId);
    this.active(generation);
    await this.authorize(generation);
    await abortable(
      Promise.resolve(
        this.options.onOrigins?.({
          publicUrl: `https://${this.registration!.controlHost}`,
          previewUrl: `https://${this.registration!.previewHost}`,
        }),
      ),
      this.abort!.signal,
    );
    this.active(generation);
    this.report("certifying");
    await this.ensureCertificate(generation);
    this.active(generation);
    await this.store("roots.pem", rootCertificates.join("\n"));
    this.active(generation);
    this.report("connecting");
    await this.maintain(generation);
  }
  private authorize(generation: number): Promise<void> {
    if (this.authorizing) return this.authorizing;
    const startedAt = performance.now();
    const startedWall = Date.now();
    const work = (async () => {
      const result = await this.api(
        "/v1/device",
        { deviceId: this.registration!.deviceId },
        generation,
      );
      const assignment = validateRegistration(
        { ...result, credential: this.registration!.credential },
        this.brokerUrl,
      );
      const lease = result.leaseSeconds;
      if (
        assignment.protocolVersion !== 2 ||
        typeof lease !== "number" ||
        !Number.isFinite(lease) ||
        lease <= 0 ||
        lease > 60
      )
        throw new Error("Broker must support bounded authorization leases");
      if (
        assignment.deviceId !== this.registration!.deviceId ||
        assignment.controlHost !== this.registration!.controlHost ||
        assignment.previewHost !== this.registration!.previewHost
      )
        throw new Error("Device origin changed");
      const until = startedAt + lease * 1000;
      this.active(generation);
      if (until <= performance.now() || startedWall + lease * 1000 <= Date.now())
        throw new Error("Stale authorization lease");
      const changed =
        JSON.stringify(assignment.node) !== JSON.stringify(this.registration!.node) &&
        this.servers.size > 0;
      this.registration = assignment;
      if (changed) {
        this.failClosed("network", true);
        return;
      }
      this.leaseUntil = until;
      this.wallLeaseUntil = startedWall + lease * 1000;
      if (this.leaseTimer) clearTimeout(this.leaseTimer);
      this.leaseTimer = setTimeout(
        () => {
          if (generation === this.generation) this.failClosed("lease-expired", true);
        },
        Math.max(0, Math.min(until - performance.now(), this.wallLeaseUntil - Date.now())),
      );
      this.leaseTimer.unref();
    })();
    this.authorizing = work;
    void work
      .finally(() => {
        if (this.authorizing === work) this.authorizing = undefined;
        if (generation === this.generation) {
          if (this.authTimer) clearTimeout(this.authTimer);
          this.authTimer = setTimeout(
            () => {
              void this.authorize(generation).catch((error) => {
                if (generation !== this.generation) return;
                if (error instanceof RelayAuthorizationError) this.failClosed("revoked", false);
                else this.report("offline", "network");
              });
            },
            Math.max(0, startedAt + 20_000 - performance.now()),
          );
          this.authTimer.unref();
        }
      })
      .catch(() => {});
    return work;
  }
  private async ensureCertificate(generation: number) {
    const hosts = [this.registration!.controlHost, this.registration!.previewHost];
    if (!this.key) {
      try {
        this.key = await readFile(join(this.options.stateDirectory, "device-key.pem"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.key = generateKeyPairSync("ec", {
          namedCurve: "prime256v1",
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey;
        await this.store("device-key.pem", this.key);
      }
    }
    let valid: X509Certificate | undefined;
    try {
      const pem =
        this.certificate ||
        (await readFile(join(this.options.stateDirectory, "certificate.pem"), "utf8"));
      valid = validateCertificate(pem, this.key, hosts);
      this.certificate = pem;
      this.watchCertificate(valid, generation);
      // Short-lived certificates renew in their final third, rather than on every
      // hourly check simply because their entire lifetime is shorter than 21 days.
      const renewAt = this.certificateRenewalAt(valid);
      if (Date.now() < renewAt) {
        this.nextRenewal = renewAt;
        return;
      }
    } catch {
      /* A missing or invalid cached certificate requires issuance. */
    }
    try {
      if (!this.options.createCsr) throw new Error("Local CSR provider unavailable");
      this.active(generation);
      const privateKeyDer = createPrivateKey(this.key)
        .export({ type: "pkcs8", format: "der" })
        .toString("base64");
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new DOMException("Local CSR timed out", "TimeoutError")),
        CSR_TIMEOUT_MS,
      );
      timer.unref();
      const csrSignal = AbortSignal.any([this.abort!.signal, timeout.signal]);
      const { csrPem: csr } = await abortable(
        this.options.createCsr({ privateKeyDer, hosts }, csrSignal),
        csrSignal,
      ).finally(() => clearTimeout(timer));
      this.active(generation);
      if (
        typeof csr !== "string" ||
        csr.length > 16_384 ||
        !csr.includes("BEGIN CERTIFICATE REQUEST") ||
        csr.includes("PRIVATE KEY")
      )
        throw new Error("Invalid local CSR");
      const result = await this.api(
        "/v1/certificate",
        { deviceId: this.registration!.deviceId, csr },
        generation,
      );
      if (typeof result.certificate !== "string") throw new Error("Missing certificate");
      const renewed = validateCertificate(result.certificate, this.key, hosts);
      await this.store("certificate.pem", result.certificate);
      this.active(generation);
      this.certificate = result.certificate;
      this.certificateWarning = false;
      this.nextRenewal = Math.max(
        Date.now() + this.certificateRetryDelay(renewed),
        this.certificateRenewalAt(renewed),
      );
      this.watchCertificate(renewed, generation);
      for (const server of this.servers.values())
        server.setSecureContext({ key: this.key, cert: this.certificate, minVersion: "TLSv1.2" });
    } catch (error) {
      this.nextRenewal = Date.now() + (valid ? this.certificateRetryDelay(valid) : 3_600_000);
      this.active(generation);
      if (error instanceof RelayAuthorizationError) throw error;
      // Renewal outages must not discard a still-valid certificate. Never retain an expired one.
      if (!valid || Date.parse(valid.validTo) <= Date.now()) {
        if (!this.failure || this.failure.stage !== "certificate")
          this.recordFailure("certificate", error);
        throw error;
      }
      this.certificateWarning = true;
    }
  }
  private certificateRenewalAt(cert: X509Certificate) {
    const expiresAt = Date.parse(cert.validTo);
    const lifetime = expiresAt - Date.parse(cert.validFrom);
    return expiresAt - Math.min(RENEW_BEFORE, lifetime / 3);
  }
  private certificateRetryDelay(cert: X509Certificate) {
    // A fixed one-hour retry can outlive a short certificate. Retry before its expiry.
    return Math.max(1_000, Math.min(3_600_000, (Date.parse(cert.validTo) - Date.now()) / 2));
  }
  private watchCertificate(cert: X509Certificate, generation: number) {
    if (this.certificateTimer) clearTimeout(this.certificateTimer);
    // Node timers cap at signed 32-bit milliseconds. Recheck long-lived certificates in bounded intervals.
    const remaining = Date.parse(cert.validTo) - Date.now();
    this.certificateTimer = setTimeout(
      () => {
        if (generation !== this.generation) return;
        if (Date.parse(cert.validTo) <= Date.now()) this.failClosed("certificate", true);
        else this.watchCertificate(cert, generation);
      },
      Math.max(0, Math.min(remaining, 2_147_000_000)),
    );
    this.certificateTimer.unref();
  }
  private track(socket: Duplex) {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }
  private async startTls(channel: Channel, generation: number) {
    if (this.servers.has(channel)) return;
    const expectedHost =
      channel === "control" ? this.registration!.controlHost : this.registration!.previewHost;
    const target = channel === "control" ? this.options.target : this.options.preview;
    const server = createServer(
      { key: this.key, cert: this.certificate, minVersion: "TLSv1.2" },
      (request, response) => {
        if (generation !== this.generation || !this.liveLease()) {
          request.socket.destroy();
          return;
        }
        if (
          request.headers.host !== expectedHost ||
          (request.socket as TLSSocket).servername !== expectedHost
        ) {
          response.writeHead(421);
          response.end();
          return;
        }
        if (request.url === `/__agentkib_relay_probe/${this.probeToken}`) {
          response.writeHead(200, { "cache-control": "no-store", "content-type": "text/plain" });
          response.end(this.probeToken);
          return;
        }
        const headers: IncomingHttpHeaders = { ...request.headers, "x-forwarded-proto": "https" };
        delete headers.forwarded;
        delete headers["x-forwarded-host"];
        delete headers["x-forwarded-for"];
        const upstream = httpRequest(
          {
            hostname: target.host,
            port: target.port,
            method: request.method,
            path: request.url,
            headers,
            agent: false,
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
            incoming.on("error", () => response.destroy());
          },
        );
        upstream.on("socket", (socket) => this.track(socket));
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.on("aborted", () => upstream.destroy());
        response.on("close", () => {
          if (!response.writableEnded) upstream.destroy();
        });
        request.pipe(upstream);
      },
    );
    server.on("connection", (socket) => this.track(socket));
    server.on("secureConnection", (socket) => this.track(socket));
    server.on("upgrade", (_request, socket) => socket.destroy());
    server.on("tlsClientError", () => {});
    this.servers.set(channel, server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      // 不能把没监听成功的 server 留在表里：之后每轮 maintain 都会因为 servers.has() 跳过它，
      // 然后拿一个指向不存在端口的配置去拉 frpc。
      if (this.servers.get(channel) === server) this.servers.delete(channel);
      throw error;
    }
    if (generation !== this.generation) {
      server.closeAllConnections();
      server.close();
      this.active(generation);
    }
    const port = (server.address() as { port: number }).port;
    await this.store(
      `frpc-${channel}.toml`,
      buildFrpcConfig(
        this.registration!,
        port,
        join(this.options.stateDirectory, "roots.pem"),
        channel,
      ),
    );
    this.active(generation);
  }
  private spawnFrpc(channel: Channel, generation: number) {
    if (this.children.has(channel)) return;
    this.active(generation);
    if (!this.liveLease()) throw new Error("No authorization lease");
    const child = spawn(
      this.frpcPath,
      ["-c", join(this.options.stateDirectory, `frpc-${channel}.toml`)],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.children.set(channel, child);
    this.connectorFailures.delete(channel);
    // Keep only bounded classifications, never raw output (which can include credentials).
    let output = "";
    let outputCode: RelayFailure["code"] = "process";
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4_096);
      if (/proxy.*(?:already exists|already in use)|duplicate proxy/i.test(output))
        outputCode = "conflict";
      else if (
        /authentication failed|authorization failed|invalid token|login.*(?:failed|rejected)/i.test(
          output,
        )
      )
        outputCode = "identity";
      else if (/certificate|tls.*(?:fail|error)|x509/i.test(output)) outputCode = "tls";
      else if (
        /connection refused|no such host|network is unreachable|dial.*(?:fail|error)/i.test(output)
      )
        outputCode = "unreachable";
      if (
        outputCode !== "process" &&
        this.children.get(channel) === child &&
        generation === this.generation
      )
        this.connectorFailures.set(channel, { stage: `${channel}-connector`, code: outputCode });
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const disconnected = () => {
      if (this.children.get(channel) !== child) return;
      this.children.delete(channel);
      this.ready[channel] = false;
      if (generation === this.generation) {
        this.failure = { stage: `${channel}-connector`, code: outputCode };
        this.connectorExit = {
          channel,
          ...(typeof child.exitCode === "number" ? { code: child.exitCode } : {}),
          ...(typeof child.signalCode === "string" ? { signal: child.signalCode } : {}),
        };
        this.report("offline", "connector");
        this.scheduleMaintain(generation, true);
      }
    };
    // error 可能不止一次（例如 disconnect 里 kill 失败）；没有监听器的 error 会让主进程崩溃。
    child.on("error", disconnected);
    child.once("exit", disconnected);
  }
  private async probe(host: string, generation: number) {
    const fingerprint = new X509Certificate(this.certificate).fingerprint256;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: host,
          port: 443,
          path: `/__agentkib_relay_probe/${this.probeToken}`,
          timeout: 10_000,
          agent: false,
          signal: this.abort!.signal,
        },
        (response) => {
          if (
            response.statusCode !== 200 ||
            (response.socket as TLSSocket).getPeerCertificate().fingerprint256 !== fingerprint
          ) {
            response.destroy();
            reject(new RelayIdentityError());
            return;
          }
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
            if (text.length > 128) response.destroy(new RelayIdentityError());
          });
          response.on("error", reject);
          response.on("end", () =>
            text === this.probeToken ? resolve() : reject(new RelayIdentityError()),
          );
        },
      );
      request.on("socket", (socket) => this.track(socket));
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error("Relay probe timeout")));
      // timeout 选项只管空闲；对端每隔几秒挤一个字节就能一直拖住单飞的 maintain。
      deadline = setTimeout(() => request.destroy(new Error("Relay probe timeout")), 10_000);
      deadline.unref();
      request.end();
    }).finally(() => clearTimeout(deadline));
    this.active(generation);
  }
  private maintain(generation: number): Promise<void> {
    if (this.maintaining) return this.maintaining;
    const work = (async () => {
      this.active(generation);
      if (!this.liveLease()) throw new Error("No lease");
      validateCertificate(this.certificate, this.key, [
        this.registration!.controlHost,
        this.registration!.previewHost,
      ]);
      for (const channel of CHANNELS) {
        try {
          await this.startTls(channel, generation);
          this.spawnFrpc(channel, generation);
        } catch (error) {
          this.recordFailure(`${channel}-connector`, error);
          throw error;
        }
      }
      const outcomes = await Promise.allSettled(
        CHANNELS.map((channel) =>
          this.probe(
            channel === "control" ? this.registration!.controlHost : this.registration!.previewHost,
            generation,
          ),
        ),
      );
      this.active(generation);
      CHANNELS.forEach((channel, index) => {
        this.ready[channel] = outcomes[index].status === "fulfilled" && this.children.has(channel);
        if (this.ready[channel]) this.connectorFailures.delete(channel);
      });
      const exited = CHANNELS.find((channel) => !this.children.has(channel));
      const failedProbe = outcomes.findIndex((outcome) => outcome.status === "rejected");
      if (exited) {
        if (this.failure?.stage !== `${exited}-connector`)
          this.failure = { stage: `${exited}-connector`, code: "process" };
      } else if (failedProbe >= 0) {
        const outcome = outcomes[failedProbe];
        if (outcome.status === "rejected")
          this.failure = this.connectorFailures.get(CHANNELS[failedProbe]) ?? {
            stage: `${CHANNELS[failedProbe]}-probe`,
            code: failureCode(outcome.reason),
          };
      }
      if (!this.ready.control || !this.ready.preview) throw new Error("Channel unavailable");
      this.failures = 0;
      this.report("ready");
      // Authorization refresh and its deadline run separately while ACME is slow.
      // 续期在后台进行：maintain 是单飞的，续期卡住（CSR 或 ACME 慢）时，
      // frpc 退出后的重连也会被一起卡住。
      this.renewInBackground(generation);
      this.scheduleMaintain(generation, false);
    })().catch((error) => {
      if (generation !== this.generation) return;
      if (error instanceof RelayAuthorizationError) {
        this.failClosed("revoked", false);
        return;
      }
      try {
        validateCertificate(this.certificate, this.key, [
          this.registration!.controlHost,
          this.registration!.previewHost,
        ]);
      } catch {
        this.failClosed("certificate", true);
        return;
      }
      this.report("offline", this.failure?.stage.endsWith("-connector") ? "connector" : "network");
      this.scheduleMaintain(generation, true);
    });
    this.maintaining = work;
    void work.finally(() => {
      if (this.maintaining === work) this.maintaining = undefined;
    });
    return work;
  }
  private renewInBackground(generation: number) {
    if (this.renewing || Date.now() < this.nextRenewal) return;
    const work = this.ensureCertificate(generation).catch((error) => {
      if (generation !== this.generation) return;
      if (error instanceof RelayAuthorizationError) {
        this.failClosed("revoked", false);
        return;
      }
      // ensureCertificate 只在手上没有仍然有效的证书时才抛错。
      this.failClosed("certificate", true);
    });
    this.renewing = work;
    void work.finally(() => {
      if (this.renewing === work) this.renewing = undefined;
    });
  }
  private backoff() {
    return Math.round(
      Math.min(30_000, 1_000 * 2 ** Math.min(this.failures++, 5)) * (0.75 + Math.random() * 0.5),
    );
  }
  private scheduleMaintain(generation: number, failed: boolean) {
    if (generation !== this.generation) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delay = failed ? this.backoff() : 20_000;
    if (failed) this.report("offline", this.current.reason ?? "network", Date.now() + delay);
    this.retryTimer = setTimeout(() => {
      void this.maintain(generation);
    }, delay);
    this.retryTimer.unref();
  }
  /** Cut all inbound TLS, outbound HTTP/probe sockets and both processes synchronously. */
  private disconnect() {
    this.ready = { control: false, preview: false };
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const server of this.servers.values()) {
      server.closeAllConnections();
      server.close();
    }
    this.servers.clear();
    for (const child of this.children.values()) {
      const running = () => child.exitCode === null && child.signalCode === null;
      const exited = new Promise<void>((resolve) => {
        if (!running()) resolve();
        else child.once("exit", () => resolve());
      });
      child.kill("SIGTERM");
      const kill = setTimeout(() => {
        if (running()) child.kill("SIGKILL");
      }, 2_000);
      kill.unref();
      // SIGKILL 之后再给 1 秒；仍不退出就不再等，退出流程最多被拖住 3 秒。
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const bounded = Promise.race([
        exited,
        new Promise<void>((resolve) => {
          giveUp = setTimeout(resolve, 3_000);
          giveUp.unref();
        }),
      ]).finally(() => {
        clearTimeout(kill);
        clearTimeout(giveUp);
        this.exiting.delete(bounded);
      });
      this.exiting.add(bounded);
    }
    this.children.clear();
  }
  /** 等被 disconnect 的 frpc 真正退出。只发 SIGTERM 就返回的话，应用退出后 frpc 会成为孤儿进程。 */
  private async waitForExits() {
    await Promise.all([...this.exiting]);
  }
  private invalidate() {
    ++this.generation;
    this.abort?.abort();
    this.abort = undefined;
    this.leaseUntil = 0;
    this.wallLeaseUntil = 0;
    for (const timer of [this.authTimer, this.leaseTimer, this.retryTimer, this.certificateTimer])
      if (timer) clearTimeout(timer);
    this.authTimer = undefined;
    this.leaseTimer = undefined;
    this.certificateTimer = undefined;
    this.retryTimer = undefined;
    this.disconnect();
  }
  private failClosed(reason: Reason, retry: boolean) {
    // 被 broker 拒绝后只能靠新邀请码恢复；不关掉 enabled 的话，每次系统唤醒 resume()
    // 都会拿旧凭据再撞一次 403，并短暂把"需要新邀请"的错误盖成"连接中"。
    if (reason === "revoked") this.enabled = false;
    this.invalidate();
    this.report(reason === "revoked" ? "error" : "offline", reason);
    if (!retry || !this.enabled || this.suspended) return;
    const generation = this.generation;
    const delay = this.backoff();
    this.report("offline", reason, Date.now() + delay);
    this.retryTimer = setTimeout(() => {
      void (async () => {
        await Promise.allSettled(
          [this.running, this.maintaining, this.authorizing, this.renewing].filter(
            (p): p is Promise<void> => !!p,
          ),
        );
        if (generation !== this.generation || !this.enabled || this.suspended) return;
        this.disconnect();
        // 旧 frpc 还没退出时再拉起新的，会在 frps 上抢同名 proxy。
        await this.waitForExits();
        if (generation !== this.generation || !this.enabled || this.suspended) return;
        await this.start();
      })();
    }, delay);
    this.retryTimer.unref();
  }
  private quiesce(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.invalidate();
    const work = Promise.allSettled(
      [this.running, this.maintaining, this.authorizing, this.renewing].filter(
        (p): p is Promise<void> => !!p,
      ),
    ).then(() => {
      this.disconnect();
      return this.waitForExits();
    });
    this.stopping = work;
    void work.finally(() => {
      if (this.stopping === work) this.stopping = undefined;
    });
    return work;
  }
  async stop(): Promise<void> {
    this.enabled = false;
    this.suspended = false;
    await this.quiesce();
    // frpc 配置里有设备凭据，只在连接时需要；下次启动会重新生成，关闭后不留在磁盘上。
    await Promise.all(
      CHANNELS.map((channel) =>
        rm(join(this.options.stateDirectory, `frpc-${channel}.toml`), { force: true }).catch(
          () => {},
        ),
      ),
    );
    if (!this.enabled) this.report("disabled");
  }
  async suspend(): Promise<void> {
    this.suspended = true;
    await this.quiesce();
    if (this.enabled && this.suspended) this.report("offline", "suspended");
  }
  async resume(): Promise<void> {
    if (!this.enabled) return;
    this.suspended = false;
    await this.quiesce();
    if (this.enabled && !this.suspended) await this.start();
  }
}
class RelayAuthorizationError extends Error {}
