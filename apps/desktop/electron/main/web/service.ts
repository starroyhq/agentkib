import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { networkInterfaces } from "node:os";

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
}
export interface WebDevice {
  id: string;
  name: string;
  send: boolean;
  approve: boolean;
  createdAt: number;
}
export interface WebPending {
  id: string;
  name: string;
  verification: string;
  expiresAt: number;
}
export interface WebAdminStatus {
  config: WebConfig;
  running: boolean;
  error?: string;
  localUrl: string;
  experimentalAvailable: boolean;
  acceptanceSessionId?: string;
  code?: { value: string; expiresAt: number };
  pending: WebPending[];
  devices: WebDevice[];
  mode?: "lan" | "local";
  addresses?: Array<{ name: string; address: string }>;
  connectionUrl?: string;
}
export type WebAdminRequest = { target?: "lan" } & (
  | { operation: "status" | "generate-code" }
  | {
      operation: "configure";
      enabled: boolean;
      port: number;
      externalOrigin: string;
      experimentalEnabled: boolean;
      lanAddress?: string;
      allowPlaintext?: boolean;
    }
  | { operation: "approve"; id: string; send: boolean; approve: boolean }
  | { operation: "reject" | "revoke"; id: string }
);
type Credential = { hash: string; expiresAt: number; device: WebDevice; binding?: string };
type Browser = { csrf: string; expiresAt: number; pending?: WebPending; ended?: boolean };
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
  private code?: { value: string; expiresAt: number };
  private failures = 0;
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
  private requests = new Set<string>();
  private rates = new Map<string, { count: number; until: number }>();
  private adminQueue: Promise<unknown> = Promise.resolve();
  private persistence: Promise<void> = Promise.resolve();
  private bootId = token();
  private addressTimer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      dataDir: string;
      staticDir: string;
      runtimeRequest: (params: unknown) => Promise<unknown>;
      verifiedExperimental?: boolean;
      verifiedClaudeManaged?: boolean;
      acceptanceSessionId?: string;
      mode?: "lan";
      sharedControl?: ReturnType<typeof createWebControlState>;
      addresses?: typeof lanAddresses;
    },
  ) {
    if (options.sharedControl) {
      this.active = options.sharedControl.active;
      this.unconfirmed = options.sharedControl.unconfirmed;
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

  private controlsEnabled(sessionId?: string) {
    const scope = this.options.acceptanceSessionId;
    return (
      this.config.experimentalEnabled &&
      (scope
        ? !this.config.externalOrigin && (sessionId === undefined || sessionId === scope)
        : this.options.verifiedExperimental === true || this.options.verifiedClaudeManaged === true)
    );
  }
  private controlsEnabledForSnapshot(sessionId: string | undefined, snapshot: unknown) {
    return (
      this.controlsEnabled(sessionId) &&
      (!!this.options.acceptanceSessionId ||
        this.options.verifiedExperimental === true ||
        (this.options.verifiedClaudeManaged === true &&
          snapshot !== null &&
          typeof snapshot === "object" &&
          "executionMode" in snapshot &&
          snapshot.executionMode === "managed-resume"))
    );
  }

  async initialize() {
    await mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(
        await readFile(join(this.options.dataDir, "web-access.json"), "utf8"),
      );
      this.config = this.validateConfig(saved.config);
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
          typeof c.device.approve === "boolean",
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
  private async admin(input: WebAdminRequest): Promise<WebAdminStatus> {
    if (!input || typeof input !== "object") throw new Error("invalid_admin_request");
    if (["approve", "reject", "revoke"].includes(input.operation))
      this.field((input as { id: string }).id);
    if (
      input.operation === "approve" &&
      (typeof input.send !== "boolean" || typeof input.approve !== "boolean")
    )
      throw new Error("invalid_admin_request");
    this.expire();
    switch (input.operation) {
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
        this.failures = 0;
        for (const browser of this.browsers.values()) browser.pending = undefined;
        await this.save();
        if (config.enabled) await this.start();
        break;
      }
      case "generate-code":
        if (!this.server) throw new Error("web_not_running");
        this.code = {
          value: randomInt(0, 100_000_000).toString().padStart(8, "0"),
          expiresAt: Date.now() + 300_000,
        };
        this.failures = 0;
        break;
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
        }
        await this.save();
        break;
      }
      default:
        throw new Error("invalid_admin_operation");
    }
    return this.status();
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
    };
  }
  private status(): WebAdminStatus {
    return {
      config: { ...this.config },
      running: !!this.server?.listening,
      error: this.error,
      experimentalAvailable:
        this.options.verifiedExperimental === true ||
        this.options.verifiedClaudeManaged === true ||
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
      code: this.code && { ...this.code },
      pending: [...this.browsers.values()].flatMap((b) => (b.pending ? [{ ...b.pending }] : [])),
      devices: this.credentials.map((c) => ({ ...c.device })),
    };
  }
  private save() {
    const contents = JSON.stringify({ config: this.config, credentials: this.credentials });
    const result = this.persistence.then(async () => {
      const file = join(this.options.dataDir, "web-access.json");
      await writeFile(`${file}.tmp`, contents, { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    });
    this.persistence = result.catch(() => undefined);
    return result;
  }
  private async start() {
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
          this.json(res, error instanceof HttpError ? error.status : 500, {
            error: error instanceof HttpError ? error.message : "request_failed",
            ...(control.request && {
              // Error codes alone cannot distinguish a preflight rejection from
              // a grant/boot recheck after dispatch, or a previous request.
              controlOutcome:
                control.dispatched || control.priorUncertain ? "unknown" : "not-dispatched",
            }),
          });
        else res.end();
      });
    });
    server.requestTimeout = 15_000;
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
    clearInterval(this.addressTimer);
    this.addressTimer = undefined;
    this.bootId = token();
    this.liveReads.clear();
    this.endStreams();
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
    this.endStreams(undefined, this.options.mode === "lan" ? "unavailable" : "access-ended");
  }
  private projectLive(sessionId: string | undefined, snapshot: unknown) {
    if (!sessionId || !this.unconfirmed.has(sessionId)) {
      if (
        snapshot &&
        typeof snapshot === "object" &&
        !this.controlsEnabledForSnapshot(sessionId, snapshot)
      ) {
        const state = snapshot as Record<string, unknown>;
        return {
          ...state,
          sendEnabled: false,
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
    const rate =
      previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60_000 };
    if (++rate.count > limit || this.rates.size > 4096) throw new HttpError(429, "rate_limited");
    this.rates.set(key, rate);
  }
  private endStreams(hash?: string, event: "access-ended" | "unavailable" = "access-ended") {
    for (const [res, owner] of this.streams)
      if (!hash || hash === owner) {
        res.write(`event: ${event}\ndata: {}\n\n`);
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
  private grant(hash: string, permission?: "send" | "approve") {
    const credential = this.credentials.find((c) => c.hash === hash && c.expiresAt > Date.now());
    if (!this.server || !credential || this.browsers.get(hash)?.ended) {
      this.endStreams(hash);
      throw new HttpError(401, "access_ended");
    }
    if (permission && (!this.controlsEnabled() || !credential.device[permission]))
      throw new HttpError(403, "permission_denied");
    return credential.device;
  }
  private field(value: unknown, max = 256): string {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > max ||
      /[\x00-\x1f]/.test(value)
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
    const experimentalEnabled = this.controlsEnabled(sessionId);
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
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
    this.rate("global", 600);
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
    const getPaths = ["/access", "/info", "/catalog", "/events", "/live", "/stream"];
    const postPaths = ["/pair", "/pair/cancel", "/logout", "/send", "/approve", "/answer"];
    if (lan && req.method === "OPTIONS") {
      const method = req.headers["access-control-request-method"];
      const allowed = method === "GET" ? getPaths : method === "POST" ? postPaths : [];
      const headers = String(req.headers["access-control-request-headers"] ?? "")
        .split(",")
        .map((header) => header.trim().toLowerCase())
        .filter(Boolean);
      if (
        !allowed.includes(path) ||
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
    control.request = req.method === "POST" && ["/send", "/approve", "/answer"].includes(path);
    const cookieName = external ? "ak_web_secure" : "ak_web_local";
    let raw = lan
      ? req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1]
      : req.headers.cookie
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1);
    let hash = raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? digest(raw) : "";
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
        experimentalEnabled: this.controlsEnabled(),
        ...(bearerToken ? { bearerToken } : {}),
      });
    }
    if (!browser) throw new HttpError(401, "unpaired");
    this.rate(hash, 180);
    if (req.method === "POST") {
      if (req.headers.origin !== origin || req.headers["x-csrf-token"] !== browser.csrf)
        throw new HttpError(403, "csrf_rejected");
      const body = await this.body(req);
      if (path === "/pair") {
        this.rate(`pair:${hash}`, 5);
        this.rate("pair", 20);
        if (browser.ended || this.credentials.some((c) => c.hash === hash))
          throw new HttpError(409, "already_paired");
        const name = this.field(body.name, 80);
        if (!this.code || this.failures >= 5 || body.code !== this.code.value) {
          this.failures++;
          throw new HttpError(403, "invalid_pairing_code");
        }
        if ([...this.browsers.values()].filter((b) => b.pending).length >= 8)
          throw new HttpError(429, "pending_limit");
        browser.pending = {
          id: token(),
          name,
          verification: randomInt(0, 100_000_000).toString().padStart(8, "0"),
          expiresAt: this.code.expiresAt,
        };
        browser.expiresAt = Date.now() + MAX_AGE;
        this.code = undefined;
        return this.json(res, 200, { pending: browser.pending });
      }
      if (path === "/pair/cancel") {
        browser.pending = undefined;
        return this.json(res, 200, { ok: true });
      }
      if (path === "/logout") {
        this.credentials = this.credentials.filter((c) => c.hash !== hash);
        browser.ended = true;
        this.endStreams(hash);
        await this.save();
        if (!lan)
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${external ? "; Secure" : ""}`,
          );
        return this.json(res, 200, { ok: true });
      }
      if (!["/send", "/approve", "/answer"].includes(path)) throw new HttpError(404, "not_found");
      const operation = path.slice(1);
      const permission = operation === "approve" ? "approve" : "send";
      this.grant(hash, permission);
      if (body.bootId !== this.bootId) throw new HttpError(409, "stale_boot");
      const sessionId = this.field(body.sessionId);
      if (!this.controlsEnabled(sessionId)) throw new HttpError(403, "session_control_not_allowed");
      const requestId = this.field(body.requestId, 128);
      if (this.requests.has(requestId)) {
        control.priorUncertain = true;
        throw new HttpError(409, "duplicate_request");
      }
      if (this.active.has(sessionId)) throw new HttpError(409, "operation_busy");
      if (this.unconfirmed.has(sessionId)) {
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
        expectedRevision: body.expectedRevision,
        experimentalEnabled: true,
      };
      if (operation === "send") {
        if (
          typeof body.text !== "string" ||
          !body.text.trim() ||
          body.text.length > 16_000 ||
          Buffer.byteLength(body.text, "utf8") > 16_384
        )
          throw new HttpError(400, "invalid_text");
        params.text = body.text;
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
          typeof body.approvalId === "number" &&
          Number.isSafeInteger(body.approvalId) &&
          body.approvalId >= 0
            ? body.approvalId
            : this.field(body.approvalId);
        if (!["accept", "decline", "cancel", "allow", "deny"].includes(String(body.decision)))
          throw new HttpError(400, "invalid_decision");
        params.decision = body.decision;
      }
      if (this.admission) throw new HttpError(409, "operation_busy");
      this.rate(`control:${hash}`, 30);
      this.requests.add(requestId);
      this.active.add(sessionId);
      this.admission = true;
      const boot = this.bootId;
      let dispatched = false;
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
          sendEnabled?: boolean;
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
          }[];
        };
        this.grant(hash, permission);
        if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
        if (!this.controlsEnabledForSnapshot(sessionId, snapshot))
          throw new HttpError(403, "provider_control_not_allowed");
        if (!snapshot?.runtimeBootId || snapshot.revision !== body.expectedRevision)
          throw new HttpError(409, "stale_state");
        if (operation === "send" && snapshot.sendEnabled !== true)
          throw new HttpError(409, "control_unavailable");
        if (operation === "answer") {
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
          !snapshot.approvals?.some(
            (approval) =>
              approval.requestId === params.approvalId &&
              approval.turnId === params.turnId &&
              approval.supported === true &&
              Array.isArray(approval.availableDecisions) &&
              approval.availableDecisions.includes(String(params.decision)),
          )
        ) {
          throw new HttpError(409, "approval_unavailable");
        }
        params.runtimeBootId = snapshot.runtimeBootId;
        dispatched = true;
        control.dispatched = true;
        this.unconfirmed.add(sessionId);
        const pending = Promise.resolve()
          .then(() => this.options.runtimeRequest(params))
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
          this.active.delete(sessionId);
          this.admission = false;
        }
      }
    }
    if (req.method !== "GET") throw new HttpError(405, "method_not_allowed");
    this.grant(hash);
    const sessionId =
      path === "/catalog" ? undefined : this.field(url.searchParams.get("sessionId"));
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
          const snapshot = await this.streamSnapshot(sessionId, device);
          // Each browser remains independently authorized before and after the shared read.
          this.grant(hash);
          if (!this.streams.has(res)) return;
          const data = JSON.stringify(this.projectLive(sessionId, snapshot));
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
        experimentalEnabled: this.controlsEnabled(sessionId),
      };
    else throw new HttpError(404, "not_found");
    const boot = this.bootId;
    const result = await this.runtime(params);
    this.grant(hash);
    if (boot !== this.bootId) throw new HttpError(409, "stale_boot");
    return this.json(res, 200, path === "/live" ? this.projectLive(sessionId, result) : result);
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
    const data = await readFile(file);
    if (data.length > 16 * 1024 * 1024) throw new HttpError(413, "asset_too_large");
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
