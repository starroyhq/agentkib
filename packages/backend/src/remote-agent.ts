import { randomBytes, randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { constants } from "node:fs";
import Bonjour, { type Browser, type Service } from "bonjour-service";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  exchangeRemotePeer,
  listenRemoteAgent,
  loadRemoteTlsIdentity,
  restrictRemotePath,
  type RemoteTlsIdentity,
  type RemoteTlsListener,
} from "./remote-tls";
import type { BackendStore } from "./store";
import type { SessionReaders } from "./session-readers";
import type { SessionIndex } from "./session-index";

type Device = {
  id: string;
  name: string;
  approved_at: number;
  last_seen: number | null;
  grant_id: string;
};
type Connection = {
  id: string;
  name: string;
  address: string;
  status: string;
  last_seen: number | null;
  error: string | null;
};
type Pending = {
  id: string;
  device_id: string;
  name: string;
  verification: string;
  expires_at: number;
  status: "pending" | "approved" | "rejected";
};
type Config = {
  name: string;
  enabled: boolean;
  address: string | null;
  authorized: Record<string, Device>;
  connections: Record<string, Connection>;
};
type PairingCode = { value: string; expires_at: number; attempts: number };

const codeTtl = 300;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].length > 64 ||
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || code === 127;
    })
  )
    throw new Error("invalid device name");
  return value.trim();
}
function validText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024)
    throw new Error(`invalid ${field}`);
  return value;
}
function isPrivateHost(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}
function defaultConfig(): Config {
  return { name: "AgentKib", enabled: false, address: null, authorized: {}, connections: {} };
}
function readConfig(file: string): Config {
  if (!existsSync(file)) return defaultConfig();
  const info = lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size >= 1024 * 1024)
    throw new Error("invalid device configuration");
  restrictRemotePath(file);
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !record(raw) ||
    typeof raw.name !== "string" ||
    typeof raw.enabled !== "boolean" ||
    !(raw.address === null || typeof raw.address === "string") ||
    !record(raw.authorized) ||
    !record(raw.connections)
  )
    throw new Error("invalid device configuration");
  const result = defaultConfig();
  result.name = validName(raw.name);
  result.enabled = raw.enabled;
  result.address = typeof raw.address === "string" ? raw.address : null;
  for (const [id, value] of Object.entries(raw.authorized)) {
    if (
      !record(value) ||
      value.id !== id ||
      typeof value.name !== "string" ||
      typeof value.approved_at !== "number" ||
      !(value.last_seen === null || typeof value.last_seen === "number") ||
      typeof value.grant_id !== "string"
    )
      throw new Error("invalid device configuration");
    result.authorized[id] = value as unknown as Device;
  }
  for (const [id, value] of Object.entries(raw.connections)) {
    if (
      !record(value) ||
      value.id !== id ||
      typeof value.name !== "string" ||
      typeof value.address !== "string" ||
      typeof value.status !== "string" ||
      !(value.last_seen === null || typeof value.last_seen === "number")
    )
      throw new Error("invalid device configuration");
    result.connections[id] = {
      ...(value as unknown as Connection),
      status: "disconnected",
      error: null,
    };
  }
  return result;
}
function privateAddress(value: unknown): { host: string; port: number; address: string } {
  if (typeof value !== "string" || value.length > 64)
    throw new Error("use a private IPv4 address and port");
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(value);
  if (!match) throw new Error("use a private IPv4 address and port");
  const octets = match[1]!.split(".").map(Number);
  const port = Number(match[2]);
  const loopback = octets[0] === 127;
  if ((!isPrivateHost(match[1]!) && !loopback) || port > 65535)
    throw new Error("private IPv4 address required");
  return { host: match[1]!, port, address: `${match[1]}:${port}` };
}
function localInterfaces() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => entry.family === "IPv4" && !entry.internal && isPrivateHost(entry.address))
      .map((entry) => ({ name, address: entry.address })),
  );
}
/** TypeScript implementation of the AgentKib paired-device service. */
export class RemoteAgent {
  readonly #identity: RemoteTlsIdentity;
  readonly #file: string;
  #config: Config;
  #restoreEnabled: boolean;
  #code: PairingCode | null = null;
  #pending = new Map<string, Pending>();
  #discovered = new Map<string, { id: string; name: string; address: string }>();
  #mdns: { instance: Bonjour; browser: Browser; service: Service | null } | null = null;
  #listener: RemoteTlsListener | null = null;
  #closing?: Promise<void>;
  #generation = 0;
  #pairAttempts = new Map<string, symbol>();
  #stopped = false;
  #heartbeat = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    directory: string,
    readonly store: BackendStore,
    readonly readers: SessionReaders,
    readonly index: SessionIndex,
  ) {
    const remoteDirectory = path.join(directory, "remote");
    mkdirSync(remoteDirectory, { recursive: true, mode: 0o700 });
    this.#file = path.join(remoteDirectory, "devices.json");
    this.#identity = loadRemoteTlsIdentity(directory);
    this.#config = readConfig(this.#file);
    this.#restoreEnabled = this.#config.enabled;
    this.#config.enabled = false;
  }

  async start(): Promise<void> {
    this.#refreshMdns();
    if (this.#restoreEnabled && this.#config.address) {
      try {
        await this.#configure(true, this.#config.address, this.#config.name);
      } catch {
        this.#config.enabled = false;
        this.#persist(this.#config);
      }
    }
  }

  close(): Promise<void> {
    if (this.#stopped) return this.#closing ?? Promise.resolve();
    this.#stopped = true;
    this.#generation++;
    this.#pairAttempts.clear();
    for (const timer of this.#heartbeat.values()) clearInterval(timer);
    this.#heartbeat.clear();
    this.#mdns?.browser.stop();
    this.#mdns?.service?.stop();
    this.#mdns?.instance.destroy();
    this.#mdns = null;
    this.#discovered.clear();
    const listener = this.#listener;
    this.#listener = null;
    return (this.#closing = listener?.close() ?? Promise.resolve());
  }

  async request(value: unknown): Promise<unknown> {
    if (this.#stopped) throw new Error("remote service stopped");
    if (!record(value) || typeof value.operation !== "string")
      throw new Error("invalid remote request");
    switch (value.operation) {
      case "status":
      case "discover":
        this.#refreshMdns();
        this.#mdns?.browser.update();
        return this.#status();
      case "configure":
        if (typeof value.enabled !== "boolean") throw new Error("enabled required");
        return this.#configure(
          value.enabled,
          validText(value.address, "address"),
          validName(value.name),
        );
      case "generate-code": {
        if (!this.#config.enabled) throw new Error("enable sharing first");
        let n: number;
        do {
          n = randomBytes(4).readUInt32BE();
        } while (n >= 4_200_000_000);
        this.#pending.clear();
        this.#code = {
          value: String(n % 100_000_000).padStart(8, "0"),
          expires_at: this.#now() + codeTtl,
          attempts: 0,
        };
        return this.#status();
      }
      case "approve":
      case "reject":
        return this.#decide(validText(value.id, "id"), value.operation);
      case "revoke":
        return this.#revoke(validText(value.id, "id"));
      case "pair":
        return this.#pair(validText(value.address, "address"), validText(value.code, "code"));
      case "disconnect":
      case "remove":
        return this.#disconnect(validText(value.id, "id"), value.operation);
      case "connect":
      case "catalog":
      case "events":
        return this.#requestPeer(value);
      default:
        throw new Error("unsupported remote operation");
    }
  }

  #now(): number {
    return Math.floor(Date.now() / 1000);
  }
  #persist(config: Config): void {
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      restrictRemotePath(temporary);
      writeFileSync(descriptor, JSON.stringify(config));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.#file);
      restrictRemotePath(this.#file);
      const directory = openSync(path.dirname(this.#file), constants.O_RDONLY);
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }
  #status() {
    const now = this.#now();
    for (const [id, pending] of this.#pending)
      if (pending.expires_at <= now) this.#pending.delete(id);
    if (this.#code && this.#code.expires_at <= now) this.#code = null;
    return {
      local: {
        id: this.#identity.id,
        name: this.#config.name,
        enabled: this.#config.enabled,
        address: this.#config.address,
      },
      interfaces: localInterfaces(),
      discovered: [...this.#discovered.values()],
      pending: [...this.#pending.values()].filter((item) => item.status === "pending"),
      authorized: Object.values(this.#config.authorized),
      connections: Object.values(this.#config.connections),
      pairing_code: this.#code?.value ?? null,
      pairing_expires_at: this.#code?.expires_at ?? null,
    };
  }
  async #configure(enabled: boolean, address: string, name: string) {
    const target = enabled ? privateAddress(address) : null;
    if (target && !localInterfaces().some((item) => item.address === target.host))
      throw new Error("select a local network interface");
    const current = this.#config;
    const same =
      enabled && current.enabled && current.address === target!.address && this.#listener !== null;
    const nextListener =
      same || !target
        ? null
        : await listenRemoteAgent(this.#identity, target.address, (peer, verify, request, signal) =>
            this.#serveRequest(peer, verify, request, signal),
          );
    const next = {
      ...current,
      enabled,
      name,
      address: target
        ? (nextListener?.address ?? current.address ?? target.address)
        : current.address,
    };
    if (!enabled) next.address = current.address;
    try {
      this.#persist(next);
    } catch (error) {
      await nextListener?.close();
      throw error;
    }
    if (!same) {
      this.#generation++;
      this.#code = null;
      this.#pending.clear();
      const old = this.#listener;
      this.#listener = nextListener;
      await old?.close();
    }
    this.#config = next;
    this.#advertise();
    return this.#status();
  }

  #refreshMdns(): void {
    if (this.#mdns) return;
    if (localInterfaces().length === 0) return;
    const instance = new Bonjour({}, () => undefined);
    const browser = instance.find({ type: "agentkib", protocol: "tcp" });
    browser.on("up", (service) => this.#serviceUp(service));
    browser.on("down", (service) => this.#discovered.delete(service.fqdn));
    browser.on("txt-update", (service) => this.#serviceUp(service));
    this.#mdns = { instance, browser, service: null };
    browser.start();
    this.#advertise();
  }

  #serviceUp(service: Service): void {
    const properties = service.txt;
    const id = properties && typeof properties.id === "string" ? properties.id : "";
    if (!/^[a-fA-F0-9]{64}$/.test(id) || id === this.#identity.id) return;
    const address = service.addresses?.find(isPrivateHost);
    if (!address || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535)
      return;
    let name = "AgentKib";
    try {
      name = validName(properties.name);
    } catch {
      // Untrusted TXT names never affect whether a valid peer can be listed.
    }
    if (!this.#discovered.has(service.fqdn) && this.#discovered.size >= 128) return;
    this.#discovered.set(service.fqdn, { id, name, address: `${address}:${service.port}` });
  }

  #advertise(): void {
    if (!this.#mdns) return;
    this.#mdns.service?.stop();
    this.#mdns.service = null;
    if (!this.#config.enabled || !this.#config.address) return;
    const target = privateAddress(this.#config.address);
    const name = this.#identity.id.slice(0, 32);
    try {
      this.#mdns.service = this.#mdns.instance.publish({
        name,
        type: "agentkib",
        protocol: "tcp",
        host: `${name}.local.`,
        port: target.port,
        txt: { id: this.#identity.id, name: this.#config.name, version: "1" },
        disableIPv6: true,
      });
      this.#mdns.service.on("error", () => undefined);
    } catch {
      // mDNS is best effort; direct private IPv4 pairing remains available.
    }
  }
  #decide(id: string, operation: "approve" | "reject") {
    const pending = this.#pending.get(id);
    if (!pending || pending.status !== "pending" || pending.expires_at <= this.#now())
      throw new Error("pairing expired");
    if (operation === "approve") {
      if (Object.keys(this.#config.authorized).length >= 128)
        throw new Error("device limit reached");
      const next = structuredClone(this.#config);
      next.authorized[pending.device_id] = {
        id: pending.device_id,
        name: pending.name,
        approved_at: this.#now(),
        last_seen: null,
        grant_id: pending.id,
      };
      this.#persist(next);
      this.#config = next;
    }
    pending.status = operation === "approve" ? "approved" : "rejected";
    this.#code = null;
    for (const [key] of this.#pending) if (key !== id) this.#pending.delete(key);
    return this.#status();
  }
  #revoke(id: string) {
    const next = structuredClone(this.#config);
    delete next.authorized[id];
    this.#persist(next);
    this.#config = next;
    this.#listener?.disconnectPeer(id);
    this.#pending.forEach((item, key) => {
      if (item.device_id === id) this.#pending.delete(key);
    });
    this.#generation++;
    return this.#status();
  }
  async #pair(address: string, code: string) {
    privateAddress(address);
    if (!/^\d{8}$/.test(code)) throw new Error("8 digit pairing code required");
    const result = await exchangeRemotePeer(this.#identity, address, null, {
      op: "pair",
      code,
      name: this.#config.name,
    });
    if (result.peerId === this.#identity.id) throw new Error("cannot pair with this device");
    if (!record(result.result)) throw new Error("invalid pairing response");
    const pendingId = validText(result.result.id, "id");
    const expires =
      typeof result.result.expires_at === "number"
        ? Math.min(result.result.expires_at, this.#now() + codeTtl)
        : this.#now() + codeTtl;
    if (
      Object.keys(this.#config.connections).length >= 128 &&
      !this.#config.connections[result.peerId]
    )
      throw new Error("host limit reached");
    const next = structuredClone(this.#config);
    next.connections[result.peerId] = {
      id: result.peerId,
      name: validName(result.result.name),
      address,
      status: "pending",
      last_seen: null,
      error: null,
    };
    this.#persist(next);
    this.#config = next;
    const attempt = Symbol();
    this.#pairAttempts.set(result.peerId, attempt);
    void this.#pollPair(result.peerId, pendingId, expires, attempt)
      .finally(() => {
        if (this.#pairAttempts.get(result.peerId) === attempt)
          this.#pairAttempts.delete(result.peerId);
      })
      .catch(() => undefined);
    return {
      id: result.peerId,
      verification: result.verification,
      status: "pending",
      expires_at: expires,
    };
  }
  async #pollPair(peerId: string, pendingId: string, expires: number, attempt: symbol) {
    const current = () =>
      !this.#stopped &&
      this.#pairAttempts.get(peerId) === attempt &&
      this.#config.connections[peerId]?.status === "pending";
    while (current() && this.#now() < expires) {
      const connection = this.#config.connections[peerId];
      if (!connection || connection.status === "disconnected") return;
      try {
        const response = await exchangeRemotePeer(this.#identity, connection.address, peerId, {
          op: "pair-status",
          id: pendingId,
        });
        if (!current()) return;
        if (
          record(response.result) &&
          ["approved", "rejected"].includes(String(response.result.status))
        ) {
          const next = structuredClone(this.#config);
          next.connections[peerId]!.status =
            response.result.status === "approved" ? "online" : "rejected";
          next.connections[peerId]!.error = null;
          next.connections[peerId]!.last_seen = this.#now();
          this.#persist(next);
          this.#config = next;
          if (response.result.status === "approved") this.#startHeartbeat(peerId);
          return;
        }
      } catch (error) {
        if (!current()) return;
        if (error instanceof Error && error.message.includes("IDENTITY_CHANGED")) {
          const next = structuredClone(this.#config);
          if (next.connections[peerId]) {
            next.connections[peerId]!.status = "identity-changed";
            next.connections[peerId]!.error = "identity-changed";
            this.#persist(next);
            this.#config = next;
          }
          return;
        }
        if (error instanceof Error && error.message.includes("PAIRING_INVALID")) {
          const next = structuredClone(this.#config);
          if (next.connections[peerId]) next.connections[peerId]!.status = "expired";
          this.#persist(next);
          this.#config = next;
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    if (!current()) return;
    const next = structuredClone(this.#config);
    if (next.connections[peerId]?.status === "pending") {
      next.connections[peerId]!.status = "expired";
      this.#persist(next);
      this.#config = next;
    }
  }
  #startHeartbeat(peerId: string) {
    if (this.#stopped || this.#heartbeat.has(peerId)) return;
    const timer = setInterval(() => {
      void this.#heartbeatPeer(peerId, timer);
    }, 10_000);
    timer.unref();
    this.#heartbeat.set(peerId, timer);
    void this.#heartbeatPeer(peerId, timer);
  }
  async #heartbeatPeer(peerId: string, timer: ReturnType<typeof setInterval>) {
    const connection = this.#config.connections[peerId];
    const generation = this.#generation;
    const current = () =>
      !this.#stopped &&
      generation === this.#generation &&
      this.#heartbeat.get(peerId) === timer &&
      this.#config.connections[peerId]?.status !== "disconnected";
    if (!connection || !current()) return;
    try {
      await exchangeRemotePeer(this.#identity, connection.address, peerId, { op: "heartbeat" });
      if (!current()) return;
      this.#updateConnection(peerId, "online", null);
    } catch (error) {
      if (!current()) return;
      this.#updateConnection(
        peerId,
        "offline",
        error instanceof Error ? error.message : "REMOTE_OFFLINE",
      );
    }
  }
  #updateConnection(id: string, status: string, error: string | null) {
    const current = this.#config.connections[id];
    if (!current) return;
    const next = structuredClone(this.#config);
    next.connections[id]!.status = status;
    next.connections[id]!.error = error;
    if (status === "online") next.connections[id]!.last_seen = this.#now();
    try {
      this.#persist(next);
      this.#config = next;
    } catch {}
  }
  #disconnect(id: string, operation: "disconnect" | "remove") {
    const next = structuredClone(this.#config);
    if (operation === "remove") {
      delete next.connections[id];
    } else if (next.connections[id]) {
      next.connections[id]!.status = "disconnected";
      next.connections[id]!.error = null;
    }
    this.#persist(next);
    this.#config = next;
    const timer = this.#heartbeat.get(id);
    if (timer) clearInterval(timer);
    this.#heartbeat.delete(id);
    this.#pairAttempts.delete(id);
    this.#generation++;
    return this.#status();
  }
  async #requestPeer(value: Record<string, unknown>) {
    const id = validText(value.id, "id");
    const connection = this.#config.connections[id];
    if (!connection) throw new Error("unknown host");
    if (["pending", "rejected", "expired"].includes(connection.status))
      throw new Error("pairing not approved");
    if (value.operation !== "connect" && connection.status === "disconnected")
      throw new Error("REMOTE_DISCONNECTED");
    let body: Record<string, unknown> = { op: value.operation === "connect" ? "hello" : "catalog" };
    if (value.operation === "events") {
      const limit = value.limit ?? 50;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 100)
        throw new Error("invalid page limit");
      const sessionId = validText(value.sessionId, "sessionId");
      if (value.cursor != null && (typeof value.cursor !== "string" || value.cursor.length > 1024))
        throw new Error("invalid cursor");
      body = { op: "events", session_id: sessionId, cursor: value.cursor ?? null, limit };
    }
    const generation = this.#generation;
    let result;
    try {
      result = await exchangeRemotePeer(this.#identity, connection.address, id, body);
    } catch (error) {
      if (this.#stopped || generation !== this.#generation) throw new Error("REMOTE_DISCONNECTED");
      const code = error instanceof Error ? error.message : "REMOTE_OFFLINE";
      const status = code.includes("REMOTE_REVOKED")
        ? "revoked"
        : code.includes("REMOTE_SHARING_DISABLED")
          ? "sharing-disabled"
          : code.includes("REMOTE_INDEX_DISABLED")
            ? "index-disabled"
            : code.includes("IDENTITY_CHANGED")
              ? "identity-changed"
              : "offline";
      this.#updateConnection(id, status, status);
      throw error;
    }
    if (this.#stopped || generation !== this.#generation) throw new Error("REMOTE_DISCONNECTED");
    this.#updateConnection(id, "online", null);
    this.#startHeartbeat(id);
    return value.operation === "connect" ? this.#status() : result.result;
  }
  async #serveRequest(
    peerId: string,
    verification: string,
    request: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.#config.enabled) throw new Error("sharing-disabled");
    const op = validText(request.op, "op");
    if (op === "pair") {
      const name = validName(request.name);
      const code = this.#code;
      if (!code || code.expires_at <= this.#now() || code.attempts >= 5) {
        this.#code = null;
        throw new Error("pairing-invalid");
      }
      code.attempts++;
      if (request.code !== code.value) {
        if (code.attempts >= 5) this.#code = null;
        throw new Error("pairing-invalid");
      }
      this.#code = null;
      this.#pending.clear();
      const pending: Pending = {
        id: randomUUID(),
        device_id: peerId,
        name,
        verification,
        expires_at: code.expires_at,
        status: "pending",
      };
      this.#pending.set(pending.id, pending);
      return { id: pending.id, name: this.#config.name, expires_at: pending.expires_at };
    }
    if (op === "pair-status") {
      const pending = this.#pending.get(validText(request.id, "id"));
      if (!pending || pending.device_id !== peerId || pending.expires_at <= this.#now())
        throw new Error("pairing-invalid");
      return { status: pending.status };
    }
    const device = this.#config.authorized[peerId];
    if (!device) throw new Error("revoked");
    if (op === "hello")
      return { id: this.#identity.id, capabilities: ["catalog", "events"], version: 1 };
    if (op === "heartbeat") {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 5000);
        timer.unref();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("REMOTE_DISCONNECTED"));
          },
          { once: true },
        );
      });
      if (
        !this.#config.enabled ||
        !this.#config.authorized[peerId] ||
        this.#config.authorized[peerId]!.grant_id !== device.grant_id
      )
        throw new Error("revoked");
      this.#ensureIndex();
      this.#touchDevice(peerId);
      return { capabilities: ["catalog", "events"] };
    }
    if (op !== "catalog" && op !== "events") throw new Error("unsupported operation");
    this.#ensureIndex();
    const epoch = this.index.generation();
    const output = op === "catalog" ? this.#catalog() : await this.#events(request);
    if (signal.aborted) throw new Error("REMOTE_DISCONNECTED");
    this.#ensureIndex();
    if (this.index.generation() !== epoch) throw new Error("index-disabled");
    if (!this.#config.enabled || this.#config.authorized[peerId]?.grant_id !== device.grant_id)
      throw new Error("revoked");
    this.#touchDevice(peerId);
    return output;
  }
  #ensureIndex() {
    const enabled = this.indexEnabled();
    if (!enabled) throw new Error("index-disabled");
  }
  indexEnabled(): boolean {
    try {
      const preferences = JSON.parse(
        readFileSync(path.join(path.dirname(path.dirname(this.#file)), "preferences.json"), "utf8"),
      ) as unknown;
      return (
        !record(preferences) ||
        preferences.session_index_enabled === undefined ||
        preferences.session_index_enabled === true
      );
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  #catalog() {
    const workspaces = this.store.listWorkspaces() as Array<Record<string, unknown>>;
    const registered = new Set(workspaces.map((workspace) => workspace.id));
    const sessions = workspaces.flatMap((workspace) =>
      this.store.sessions.list(String(workspace.id)),
    );
    if (sessions.length > 20_000) throw new Error("response-too-large");
    return {
      workspaces: workspaces
        .filter((workspace) => registered.has(workspace.id))
        .map((workspace) => ({
          id: workspace.id,
          path: workspace.path,
          name: workspace.name,
          status: workspace.status,
          asset_count: workspace.asset_count,
          warning_count: workspace.warning_count,
          last_active_at: workspace.last_active_at,
          last_scanned_at: workspace.last_scanned_at,
        })),
      sessions: sessions.filter((session) => registered.has(session.workspace_id)),
    };
  }
  async #events(request: Record<string, unknown>) {
    const sessionId = validText(request.session_id, "session_id");
    if (
      !Number.isInteger(request.limit) ||
      Number(request.limit) < 1 ||
      Number(request.limit) > 100
    )
      throw new Error("limit");
    if (
      request.cursor != null &&
      (typeof request.cursor !== "string" || request.cursor.length > 1024)
    )
      throw new Error("limit");
    return this.readers.events({ sessionId, cursor: request.cursor ?? null, limit: request.limit });
  }
  #touchDevice(id: string) {
    const next = structuredClone(this.#config);
    const device = next.authorized[id];
    if (!device) return;
    device.last_seen = this.#now();
    try {
      this.#persist(next);
      this.#config = next;
    } catch {}
  }
}
