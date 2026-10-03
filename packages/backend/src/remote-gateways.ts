import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import WebSocket from "ws";

const workspaceSchema = z.object({
  id: z.string(),
  agent_id: z.string().nullable().optional(),
  name: z.string(),
  path: z.string().nullable().optional(),
  session_count: z.number().int().nonnegative(),
  last_active_at: z.string().nullable().optional(),
});
const assetSchema = z.object({
  id: z.string(),
  agent_id: z.string().nullable().optional(),
  kind: z.string(),
  name: z.string(),
  path: z.string(),
  size: z.number().int().nonnegative(),
});
const gatewaySchema = z.object({
  id: z.string(),
  kind: z.enum(["open-claw", "hermes"]),
  name: z.string(),
  url: z.string(),
  auth_kind: z.enum(["none", "token", "password", "session-token", "basic"]),
  username: z.string().nullable().optional(),
  secret: z.string().nullable().optional(),
  device_token: z.string().nullable().optional(),
  device_identity: z
    .object({
      device_id: z.string(),
      public_key: z.string(),
      private_key: z.string(),
    })
    .nullable()
    .optional(),
  state: z.enum(["pending", "connected", "pairing-required", "error"]),
  version: z.string().nullable().optional(),
  capabilities: z.array(z.string()).default([]),
  session_count: z.number().int().nonnegative().default(0),
  workspaces: z.array(workspaceSchema).default([]),
  assets: z.array(assetSchema).default([]),
  pairing_request_id: z.string().nullable().optional(),
  last_connected_at: z.string().nullable().optional(),
  last_error: z.string().nullable().optional(),
});
const documentSchema = z.object({
  version: z.number().int().default(1),
  gateways: z.array(gatewaySchema).default([]),
});
const inputSchema = z.object({
  id: z.string().nullable().optional(),
  kind: z.enum(["open-claw", "hermes"]),
  name: z.string(),
  url: z.string(),
  auth_kind: z.enum(["none", "token", "password", "session-token", "basic"]),
  username: z.string().nullable().optional(),
  secret: z.string().nullable().optional(),
});
type GatewayDocument = z.infer<typeof documentSchema>;
type StoredGateway = z.infer<typeof gatewaySchema>;
type GatewayMessage = Record<string, unknown>;

class GatewaySocket {
  readonly socket: WebSocket;
  #messages: GatewayMessage[] = [];
  #waiters: Array<{ resolve: (value: GatewayMessage) => void; reject: (error: Error) => void }> =
    [];
  #closed?: Error;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data) => {
      try {
        const value: unknown = JSON.parse(data.toString());
        if (!isObject(value)) return;
        const waiter = this.#waiters.shift();
        if (waiter) waiter.resolve(value);
        else this.#messages.push(value);
      } catch {
        this.#close(new Error("Gateway returned malformed JSON"));
      }
    });
    socket.on("error", (error) => this.#close(error));
    socket.on("close", () => this.#close(new Error("Gateway closed the connection")));
  }

  static connect(url: string): Promise<GatewaySocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { handshakeTimeout: 15_000 });
      const gateway = new GatewaySocket(socket);
      socket.once("open", () => resolve(gateway));
      socket.once("error", reject);
    });
  }

  send(value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(value), (error) => (error ? reject(error) : resolve()));
    });
  }

  next(timeoutMs = 15_000): Promise<GatewayMessage> {
    const message = this.#messages.shift();
    if (message) return Promise.resolve(message);
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        reject(new Error("Gateway response timed out"));
      }, timeoutMs);
      const waiter = {
        resolve: (value: GatewayMessage) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#waiters.push(waiter);
    });
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close();
    });
  }

  #close(error: Error) {
    if (this.#closed) return;
    this.#closed = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}

export class RemoteGateways {
  readonly file: string;
  #writes: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "remote-gateways.local.json");
  }

  list() {
    return this.#read().gateways.map((gateway) => this.#summary(gateway));
  }

  async save(value: unknown) {
    const input = inputSchema.parse(value);
    const operation = this.#writes.then(() => this.#save(input));
    this.#writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async remove(value: unknown): Promise<void> {
    const { id } = z.object({ id: z.string() }).parse(value);
    const operation = this.#writes.then(() => {
      const { document, hash } = this.#readWithHash();
      document.gateways = document.gateways.filter((gateway) => gateway.id !== id);
      this.#write(document, hash);
    });
    this.#writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async refresh(value: unknown) {
    const { id } = z.object({ id: z.string() }).parse(value);
    const operation = this.#writes.then(async () => {
      const { document, hash } = this.#readWithHash();
      const gateway = document.gateways.find((item) => item.id === id);
      if (!gateway) throw new Error("Remote gateway does not exist");
      try {
        if (gateway.kind === "open-claw") await refreshOpenClaw(gateway);
        else await refreshHermes(gateway);
      } catch (error) {
        gateway.state = "error";
        gateway.last_error = redactGatewayError(error, gateway);
      }
      this.#write(document, hash);
      return this.#summary(gateway);
    });
    this.#writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  #read() {
    return this.#readWithHash().document;
  }

  #readWithHash(): { document: GatewayDocument; hash: string | null } {
    let contents: string;
    try {
      contents = readFileSync(this.file, "utf8");
    } catch (error) {
      if (isMissing(error)) return { document: { version: 1, gateways: [] }, hash: null };
      throw error;
    }
    const document = documentSchema.parse(JSON.parse(contents) as unknown);
    if (document.version !== 1) throw new Error("Unsupported remote gateway document version");
    return { document, hash: createHash("sha256").update(contents).digest("hex") };
  }

  #summary(gateway: z.infer<typeof gatewaySchema>) {
    return {
      id: gateway.id,
      kind: gateway.kind,
      name: gateway.name,
      url: gateway.url,
      auth_kind: gateway.auth_kind,
      ...(gateway.username == null ? {} : { username: gateway.username }),
      has_credentials: Boolean(gateway.secret || gateway.device_token),
      state: gateway.state,
      ...(gateway.version == null ? {} : { version: gateway.version }),
      capabilities: gateway.capabilities,
      session_count: gateway.session_count,
      workspaces: gateway.workspaces,
      assets: gateway.assets,
      ...(gateway.pairing_request_id == null
        ? {}
        : { pairing_request_id: gateway.pairing_request_id }),
      ...(gateway.last_connected_at == null
        ? {}
        : { last_connected_at: gateway.last_connected_at }),
      ...(gateway.last_error == null ? {} : { last_error: gateway.last_error }),
    };
  }

  #save(input: z.infer<typeof inputSchema>) {
    if (!input.name.trim()) throw new Error("Remote gateway name cannot be empty");
    if (!input.url.trim()) throw new Error("Remote gateway URL cannot be empty");
    const supported =
      input.kind === "open-claw"
        ? ["none", "token", "password"]
        : ["none", "session-token", "basic"];
    if (!supported.includes(input.auth_kind))
      throw new Error("Authentication mode is not supported by this gateway");
    if (input.auth_kind === "basic" && !input.username?.trim())
      throw new Error("Hermes basic authentication requires a username");

    const url = new URL(input.url.trim());
    if (url.username || url.password || url.search)
      throw new Error("Gateway credentials must use the dedicated authentication fields");
    url.hash = "";
    if (input.kind === "open-claw") {
      if (url.protocol === "http:") url.protocol = "ws:";
      else if (url.protocol === "https:") url.protocol = "wss:";
      else if (url.protocol !== "ws:" && url.protocol !== "wss:")
        throw new Error("OpenClaw Gateway URL must use ws, wss, http, or https");
    } else if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Hermes Backend URL must use http or https");
    }
    const normalizedUrl = url.toString().replace(/\/+$/, "");
    const { document, hash } = this.#readWithHash();
    const id = input.id?.trim() || randomUUID();
    let gateway = document.gateways.find((item) => item.id === id);
    const secret = input.secret?.trim() || undefined;
    if (gateway) {
      const kindChanged = gateway.kind !== input.kind;
      const authChanged = kindChanged || gateway.auth_kind !== input.auth_kind;
      const endpointChanged = gateway.url !== normalizedUrl;
      gateway.kind = input.kind;
      gateway.name = input.name.trim();
      gateway.url = normalizedUrl;
      gateway.auth_kind = input.auth_kind;
      gateway.username = input.username?.trim() || undefined;
      if (input.auth_kind === "none") gateway.secret = undefined;
      else if (authChanged || secret) gateway.secret = secret;
      if (authChanged || endpointChanged || secret || !gateway.secret)
        gateway.device_token = undefined;
      if (kindChanged || endpointChanged) {
        gateway.version = undefined;
        gateway.capabilities = [];
        gateway.session_count = 0;
        gateway.workspaces = [];
        gateway.assets = [];
        gateway.pairing_request_id = undefined;
        gateway.last_connected_at = undefined;
      }
      gateway.state = "pending";
      gateway.last_error = undefined;
    } else {
      gateway = {
        id,
        kind: input.kind,
        name: input.name.trim(),
        url: normalizedUrl,
        auth_kind: input.auth_kind,
        ...(input.username?.trim() ? { username: input.username.trim() } : {}),
        ...(secret ? { secret } : {}),
        state: "pending",
        capabilities: [],
        session_count: 0,
        workspaces: [],
        assets: [],
      };
      document.gateways.push(gateway);
    }
    this.#write(document, hash);
    return this.#summary(gateway);
  }

  #write(document: GatewayDocument, expectedHash: string | null) {
    if (this.#readWithHash().hash !== expectedHash)
      throw new Error("Remote gateway configuration changed during update");
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function refreshOpenClaw(gateway: StoredGateway) {
  const identity = gateway.device_identity ?? generateDeviceIdentity();
  gateway.device_identity = identity;
  const socket = await GatewaySocket.connect(gateway.url);
  try {
    const challenge = await socket.next();
    if (challenge.event !== "connect.challenge")
      throw new Error("OpenClaw Gateway did not send a connect challenge");
    const payload = isObject(challenge.payload) ? challenge.payload : {};
    if (typeof payload.nonce !== "string")
      throw new Error("OpenClaw challenge did not contain a nonce");
    const signedAt = typeof payload.ts === "number" ? payload.ts : Date.now();
    const scopes = ["operator.read"];
    const sharedSecret = gateway.secret ?? "";
    const authToken =
      gateway.auth_kind === "token" && sharedSecret ? sharedSecret : (gateway.device_token ?? "");
    const signedPayload = [
      "v2",
      identity.device_id,
      "cli",
      "cli",
      "operator",
      scopes.join(","),
      String(signedAt),
      authToken,
      payload.nonce,
    ].join("|");
    const privateKey = createPrivateKeyFromSeed(identity.private_key);
    const signature = sign(null, Buffer.from(signedPayload), privateKey).toString("base64url");
    const auth: Record<string, string> = {};
    if (gateway.auth_kind === "password") auth.password = sharedSecret;
    if (authToken) auth.token = authToken;
    const requestId = randomUUID();
    await socket.send({
      type: "req",
      id: requestId,
      method: "connect",
      params: {
        minProtocol: 4,
        maxProtocol: 4,
        client: {
          id: "cli",
          version: "0.13.0",
          platform:
            process.platform === "darwin"
              ? "macos"
              : process.platform === "win32"
                ? "windows"
                : process.platform,
          deviceFamily: "desktop",
          mode: "cli",
          displayName: "AgentKib",
        },
        role: "operator",
        scopes,
        caps: ["agent-kind"],
        commands: [],
        permissions: {},
        auth,
        locale: "en-US",
        userAgent: "agentkib/0.13.0",
        device: {
          id: identity.device_id,
          publicKey: identity.public_key,
          signature,
          signedAt,
          nonce: payload.nonce,
        },
      },
    });
    const response = await receiveGatewayResponse(socket, requestId);
    if (response.ok !== true) {
      const error = isObject(response.error) ? response.error : {};
      const details = isObject(error.details) ? error.details : {};
      const pairingRequest = typeof details.requestId === "string" ? details.requestId : undefined;
      if (pairingRequest || details.code === "PAIRING_REQUIRED") {
        gateway.state = "pairing-required";
        gateway.pairing_request_id = pairingRequest;
        gateway.last_error = undefined;
        return;
      }
      throw new Error(
        `OpenClaw connection failed: ${typeof error.message === "string" ? error.message : "unknown gateway error"}`,
      );
    }
    const hello = isObject(response.payload) ? response.payload : {};
    const server = isObject(hello.server) ? hello.server : {};
    gateway.version = typeof server.version === "string" ? server.version : undefined;
    const authResponse = isObject(hello.auth) ? hello.auth : {};
    if (typeof authResponse.deviceToken === "string")
      gateway.device_token = authResponse.deviceToken;
    const features = isObject(hello.features) ? hello.features : {};
    const methods = new Set(arrayOfStrings(features.methods));
    const agents = await openClawRpc(socket, "agents.list", {});
    const workspaces = parseOpenClawAgents(agents);
    const assets: z.infer<typeof assetSchema>[] = [];
    for (const workspace of workspaces) {
      if (!workspace.agent_id) continue;
      if (methods.has("agents.files.list")) {
        try {
          assets.push(
            ...parseOpenClawFiles(
              gateway.id,
              workspace.agent_id,
              await openClawRpc(socket, "agents.files.list", { agentId: workspace.agent_id }),
            ),
          );
        } catch {}
      }
      if (methods.has("skills.status")) {
        try {
          assets.push(
            ...parseOpenClawSkills(
              gateway.id,
              workspace.agent_id,
              await openClawRpc(socket, "skills.status", { agentId: workspace.agent_id }),
            ),
          );
        } catch {}
      }
    }
    if (methods.has("sessions.list")) {
      try {
        mergeOpenClawSessions(
          workspaces,
          await openClawRpc(socket, "sessions.list", { limit: 500 }),
        );
      } catch {}
    }
    gateway.session_count = workspaces.reduce((sum, workspace) => sum + workspace.session_count, 0);
    gateway.capabilities = [
      "agents.list",
      "sessions.list",
      "agents.files.list",
      "skills.status",
      "usage.cost",
    ].filter((method) => methods.has(method));
    gateway.workspaces = workspaces;
    gateway.assets = assets;
    gateway.state = "connected";
    gateway.pairing_request_id = undefined;
    gateway.last_error = undefined;
    gateway.last_connected_at = new Date().toISOString();
  } finally {
    await socket.close();
  }
}

async function refreshHermes(gateway: StoredGateway) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const base = gateway.url.replace(/\/+$/, "");
  const cookies = new Map<string, string>();
  const headers = new Headers();
  try {
    if (gateway.auth_kind === "basic") {
      if (!gateway.username || !gateway.secret)
        throw new Error("Hermes username or password is missing");
      const login = await fetch(`${base}/auth/password-login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "basic",
          username: gateway.username,
          password: gateway.secret,
        }),
        signal: controller.signal,
      });
      if (!login.ok) throw new Error(`Hermes authentication failed (${login.status})`);
      readCookies(login.headers, cookies);
    } else if (gateway.auth_kind === "session-token") {
      if (!gateway.secret) throw new Error("Hermes session token is missing");
      headers.set("X-Hermes-Session-Token", gateway.secret);
    }
    applyCookies(headers, cookies);
    const statusResponse = await fetch(`${base}/api/status`, {
      headers,
      signal: controller.signal,
    });
    if (!statusResponse.ok) throw new Error(`Hermes Backend returned ${statusResponse.status}`);
    const status = (await statusResponse.json()) as unknown;
    gateway.version = stringField(status, ["version", "hermes_version"]);
    const sessionsResponse = await fetch(`${base}/api/sessions`, {
      headers,
      signal: controller.signal,
    });
    const sessions = sessionsResponse.ok ? ((await sessionsResponse.json()) as unknown) : null;
    const rows = hermesSessionRows(sessions);
    gateway.session_count = rows.length;
    gateway.workspaces = parseHermesSessions(sessions);
    gateway.assets = await hermesWebSocketAssets(
      gateway,
      headers,
      cookies,
      controller.signal,
    ).catch(() => []);
    gateway.capabilities = [
      "status",
      ...(sessionsResponse.ok ? ["sessions"] : []),
      ...(gateway.assets.length ? ["commands.catalog"] : []),
    ];
    gateway.state = "connected";
    gateway.pairing_request_id = undefined;
    gateway.last_error = undefined;
    gateway.last_connected_at = new Date().toISOString();
  } finally {
    clearTimeout(timeout);
  }
}

async function hermesWebSocketAssets(
  gateway: StoredGateway,
  headers: Headers,
  cookies: Map<string, string>,
  signal: AbortSignal,
) {
  if (gateway.auth_kind === "none") return [];
  let authName: string;
  let authValue: string;
  if (gateway.auth_kind === "basic") {
    applyCookies(headers, cookies);
    const response = await fetch(`${gateway.url.replace(/\/+$/, "")}/api/auth/ws-ticket`, {
      method: "POST",
      headers,
      signal,
    });
    if (!response.ok)
      throw new Error(`Hermes WebSocket ticket request returned ${response.status}`);
    const payload = (await response.json()) as unknown;
    const ticket = stringField(payload, ["ticket"]);
    if (!ticket) throw new Error("Hermes ticket response was invalid");
    authName = "ticket";
    authValue = ticket;
  } else if (gateway.auth_kind === "session-token" && gateway.secret) {
    authName = "token";
    authValue = gateway.secret;
  } else {
    throw new Error("Unsupported Hermes authentication mode");
  }
  const url = new URL(gateway.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/ws`;
  url.searchParams.set(authName, authValue);
  const socket = await GatewaySocket.connect(url.toString());
  try {
    const response = await hermesRpc(socket, "commands.catalog", {});
    return parseHermesSkills(gateway.id, response);
  } finally {
    await socket.close();
  }
}

function generateDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicBytes = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const privateBytes = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  return {
    device_id: createHash("sha256").update(publicBytes).digest("hex"),
    public_key: publicBytes.toString("base64url"),
    private_key: privateBytes.toString("base64url"),
  };
}

function createPrivateKeyFromSeed(seed: string) {
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const bytes = Buffer.from(seed, "base64url");
  if (bytes.length !== 32) throw new Error("Invalid stored OpenClaw device key");
  return createPrivateKey({ key: Buffer.concat([prefix, bytes]), format: "der", type: "pkcs8" });
}

async function receiveGatewayResponse(socket: GatewaySocket, id: string) {
  for (;;) {
    const message = await socket.next();
    if (message.type === "res" && message.id === id) return message;
  }
}

async function openClawRpc(socket: GatewaySocket, method: string, params: unknown) {
  const id = randomUUID();
  await socket.send({ type: "req", id, method, params });
  const response = await receiveGatewayResponse(socket, id);
  if (response.ok !== true) {
    const error = isObject(response.error) ? response.error : {};
    throw new Error(
      `Gateway method ${method} failed: ${typeof error.message === "string" ? error.message : "unknown error"}`,
    );
  }
  return response.payload ?? null;
}

async function hermesRpc(socket: GatewaySocket, method: string, params: unknown) {
  const id = randomUUID();
  await socket.send({ jsonrpc: "2.0", id, method, params });
  for (;;) {
    const message = await socket.next();
    if (message.id !== id) continue;
    if (message.error) {
      const error = isObject(message.error) ? message.error : {};
      throw new Error(
        `Hermes Gateway method ${method} failed: ${typeof error.message === "string" ? error.message : "unknown error"}`,
      );
    }
    return message.result ?? null;
  }
}

function parseOpenClawAgents(value: unknown): z.infer<typeof workspaceSchema>[] {
  return objectArray(value, "agents").flatMap((agent) => {
    if (agent.kind === "system") return [];
    const id = stringField(agent, ["id", "agentId"]);
    if (!id) return [];
    return [
      {
        id: `openclaw:${id}`,
        agent_id: id,
        name: stringField(agent, ["name", "displayName"]) ?? id,
        ...(stringField(agent, ["workspace", "workspacePath", "cwd"])
          ? { path: stringField(agent, ["workspace", "workspacePath", "cwd"]) }
          : {}),
        session_count: 0,
      },
    ];
  });
}

function parseOpenClawFiles(
  gatewayId: string,
  agentId: string,
  value: unknown,
): z.infer<typeof assetSchema>[] {
  return objectArray(value, "files").flatMap((file) => {
    if (file.exists === false) return [];
    const filePath = stringField(file, ["path", "relativePath", "name"]);
    const name = stringField(file, ["name"]) ?? filePath?.split("/").at(-1);
    if (!filePath || !name) return [];
    return [
      {
        id: stableId([gatewayId, agentId, "file", filePath]),
        agent_id: agentId,
        kind: classifyAsset(name),
        name,
        path: filePath,
        size: nonNegativeInteger(file.size),
      },
    ];
  });
}

function parseOpenClawSkills(
  gatewayId: string,
  agentId: string,
  value: unknown,
): z.infer<typeof assetSchema>[] {
  return objectArray(value, "skills").flatMap((skill) => {
    const name = stringField(skill, ["name", "id", "key"]);
    if (!name) return [];
    return [
      {
        id: stableId([gatewayId, agentId, "skill", name]),
        agent_id: agentId,
        kind: "skill",
        name,
        path: stringField(skill, ["filePath", "path", "baseDir", "source"]) ?? `skills/${name}`,
        size: 0,
      },
    ];
  });
}

function mergeOpenClawSessions(workspaces: z.infer<typeof workspaceSchema>[], value: unknown) {
  for (const session of objectArray(value, "sessions")) {
    const agentId = stringField(session, ["agentId", "agent_id"]);
    const pathValue = stringField(session, ["workspace", "cwd", "repoRoot"]);
    const timestamp = timeField(session, ["updatedAt", "lastActiveAt", "createdAt"]);
    const existing = workspaces.find(
      (workspace) => workspace.agent_id === agentId && (!pathValue || workspace.path === pathValue),
    );
    if (existing) {
      existing.session_count += 1;
      existing.last_active_at = latest(existing.last_active_at, timestamp);
    } else if (pathValue) {
      workspaces.push({
        id: stableId(["openclaw-session", agentId ?? "default", pathValue]),
        agent_id: agentId,
        name: pathValue.replace(/\/+$/, "").split("/").at(-1) || "Workspace",
        path: pathValue,
        session_count: 1,
        ...(timestamp ? { last_active_at: timestamp } : {}),
      });
    }
  }
}

function parseHermesSessions(value: unknown): z.infer<typeof workspaceSchema>[] {
  const grouped = new Map<string, z.infer<typeof workspaceSchema>>();
  for (const session of hermesSessionRows(value)) {
    const pathValue = stringField(session, ["git_repo_root", "gitRepoRoot", "cwd", "workspace"]);
    if (!pathValue) continue;
    const timestamp = timeField(session, ["updated_at", "updatedAt", "created_at", "createdAt"]);
    let workspace = grouped.get(pathValue);
    if (!workspace) {
      workspace = {
        id: stableId(["hermes", pathValue]),
        name: pathValue.replace(/\/+$/, "").split("/").at(-1) || "Workspace",
        path: pathValue,
        session_count: 0,
      };
      grouped.set(pathValue, workspace);
    }
    workspace.session_count += 1;
    workspace.last_active_at = latest(workspace.last_active_at, timestamp);
  }
  return [...grouped.values()];
}

function hermesSessionRows(value: unknown) {
  const sessions = objectArray(value, "sessions");
  return sessions.length ? sessions : objectArray(value, "data");
}

function parseHermesSkills(gatewayId: string, value: unknown): z.infer<typeof assetSchema>[] {
  const skills = isObject(value) && isObject(value.skills) ? value.skills : {};
  return Object.entries(skills).map(([command, info]) => {
    const name = command.replace(/^\/+/, "");
    const origin = isObject(info) ? info.origin : undefined;
    const pathValue =
      typeof origin === "string"
        ? origin
        : (stringField(origin, ["path", "source", "root", "directory"]) ??
          `remote://hermes/skills/${name}`);
    return {
      id: stableId([gatewayId, "skill", name]),
      kind: "skill",
      name,
      path: pathValue,
      size: 0,
    };
  });
}

function objectArray(value: unknown, key: string): GatewayMessage[] {
  if (isObject(value) && Array.isArray(value[key]))
    return (value[key] as unknown[]).filter(isObject);
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function stringField(value: unknown, keys: string[]): string | undefined {
  if (!isObject(value)) return undefined;
  for (const key of keys) if (typeof value[key] === "string") return value[key];
  return undefined;
}

function timeField(value: unknown, keys: string[]) {
  if (!isObject(value)) return undefined;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && Number.isFinite(Date.parse(raw)))
      return new Date(raw).toISOString();
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const date = new Date(raw < 10_000_000_000 ? raw * 1000 : raw);
      if (Number.isFinite(date.getTime())) return date.toISOString();
    }
  }
  return undefined;
}

function latest(left?: string | null, right?: string) {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function stableId(parts: string[]) {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function classifyAsset(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes("skill")) return "skill";
  if (lower.includes("mcp")) return "connection";
  if (lower.includes("memory")) return "memory";
  if (lower.includes("hook")) return "hook";
  return "instruction";
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function nonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCookies(headers: Headers, cookies: Map<string, string>) {
  for (const value of headers.getSetCookie()) {
    const [pair] = value.split(";", 1);
    const separator = pair?.indexOf("=") ?? -1;
    if (separator > 0) cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
  }
}

function applyCookies(headers: Headers, cookies: Map<string, string>) {
  if (cookies.size)
    headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
}

function redactGatewayError(error: unknown, gateway: StoredGateway) {
  let message = error instanceof Error ? error.message : "Gateway connection failed";
  for (const secret of [gateway.secret, gateway.device_token])
    if (secret) message = message.replaceAll(secret, "[redacted]");
  return message.length > 1_024 ? `${message.slice(0, 1_024)}…` : message;
}
