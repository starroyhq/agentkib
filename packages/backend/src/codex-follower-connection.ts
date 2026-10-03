import { createConnection, type Socket } from "node:net";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { nativeBindings } from "./native-files";

const CLIENT_TYPE = "agentkib-codex-bridge";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 3_000;
const METHOD_VERSIONS: Readonly<Record<string, number>> = {
  initialize: 0,
  "thread-owner-discovery": 1,
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
  "client-status-changed": 1,
  "ipc-connection-reset": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-update-thread-settings": 2,
  "thread-follower-start-turn": 2,
  "thread-follower-interrupt-turn": 4,
  "thread-stream-state-changed": 11,
};
const SUPPORTED_DESKTOP_VERSIONS = new Set(["26.917.62051", "26.924.22138"]);
const SETTINGS_DESKTOP_VERSION = "26.924.22138";

type JsonRecord = Record<string, unknown>;
type Frame = { bytes: Buffer; value: unknown };
type Waiter = { resolve: (value: Frame | null) => void };

/** Single-consumer connection to a verified, already-running Codex Desktop IPC router. */
export class CodexFollowerConnection {
  #socket: Socket;
  #clientId = "uninitialized";
  #closed: Error | null = null;
  #buffer = Buffer.alloc(0);
  #queued: Frame[] = [];
  #queuedBytes = 0;
  #waiters: Waiter[] = [];
  #requestActive = false;
  readonly desktopVersion: string;

  private constructor(
    socket: Socket,
    desktopVersion: string,
    readonly endpoint: string,
  ) {
    this.#socket = socket;
    this.desktopVersion = desktopVersion;
    socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#fail(new Error("Codex IPC disconnected")));
  }

  static async connectInstalled(endpoint: string): Promise<CodexFollowerConnection> {
    if (process.platform !== "darwin" || typeof process.getuid !== "function")
      throw new Error("Codex follower bridge requires macOS");
    const before = await inspectEndpoint(endpoint);
    const socket = await connectUnix(endpoint);
    try {
      const after = await inspectEndpoint(endpoint);
      if (before.dev !== after.dev || before.ino !== after.ino)
        throw new Error("Codex IPC endpoint changed");
      const peerPath = await realpath(verifyPeer(socket, process.getuid()));
      const desktopVersion = await readDesktopVersion(peerPath);
      if (!SUPPORTED_DESKTOP_VERSIONS.has(desktopVersion))
        throw new Error("unverified Codex Desktop installation");
      const connection = new CodexFollowerConnection(socket, desktopVersion, endpoint);
      try {
        const response = await connection.request("initialize", { clientType: CLIENT_TYPE });
        if (!isRecord(response) || response.method !== "initialize")
          throw new Error("invalid Codex IPC initialization response");
        const result = isRecord(response.result) ? response.result : {};
        if (typeof result.clientId !== "string" || !result.clientId || result.clientId.length > 256)
          throw new Error("Codex IPC did not assign a valid client ID");
        connection.#clientId = result.clientId;
        return connection;
      } catch (error) {
        connection.disconnect();
        throw error;
      }
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  get connected(): boolean {
    return this.#closed === null && !this.#socket.destroyed;
  }

  get clientId(): string {
    return this.#clientId;
  }

  get supportsThreadSettings(): boolean {
    return this.desktopVersion === SETTINGS_DESKTOP_VERSION;
  }

  disconnect(): void {
    this.#fail(new Error("Codex IPC disconnected"));
    this.#socket.destroy();
  }

  async broadcast(method: string, params: unknown, ownerClientId: string): Promise<void> {
    const version = METHOD_VERSIONS[method];
    if (version === undefined) throw new Error("unsupported Codex IPC method");
    await this.#write({
      type: "broadcast",
      method,
      version,
      sourceClientId: this.#clientId,
      params,
      targetClientIds: [ownerClientId],
    });
  }

  async request(
    method: string,
    params: unknown,
    ownerClientId?: string,
    onNotification: (value: unknown) => void = () => {},
    onDispatch: () => void = () => {},
  ): Promise<unknown> {
    if (this.#requestActive) throw new Error("Codex IPC connection is busy");
    const version = METHOD_VERSIONS[method];
    if (version === undefined) throw new Error("unsupported Codex IPC method");
    this.#requestActive = true;
    try {
      const requestId = randomUUID();
      const request: JsonRecord = {
        type: "request",
        requestId,
        sourceClientId: this.#clientId,
        version,
        method,
        params,
        timeoutMs: 2500,
      };
      if (ownerClientId !== undefined) request.targetClientId = ownerClientId;
      await this.#write(request, onDispatch);
      const deadline =
        Date.now() + (method === "thread-owner-discovery" ? 12_000 : READ_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const frame = await this.#receive(deadline);
        if (!frame) {
          this.disconnect();
          throw new Error("Codex IPC request timed out; outcome is unknown");
        }
        const message = frame.value;
        if (!isRecord(message)) continue;
        if (message.type === "client-discovery-request") {
          await this.#write({
            type: "client-discovery-response",
            requestId: message.requestId,
            response: { canHandle: false },
          });
          continue;
        }
        if (message.type === "response" && message.requestId === requestId) {
          if (message.resultType !== "success")
            throw new Error(
              message.error === "no-client-found"
                ? "Codex session owner was not found"
                : "Codex IPC request was rejected or its outcome is unknown",
            );
          if (ownerClientId !== undefined && message.handledByClientId !== ownerClientId)
            throw new Error("Codex session owner changed");
          return message;
        }
        onNotification(message);
      }
      this.disconnect();
      throw new Error("Codex IPC request timed out; outcome is unknown");
    } finally {
      this.#requestActive = false;
    }
  }

  async receive(timeoutMs = READ_TIMEOUT_MS): Promise<unknown | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const frame = await this.#receive(deadline);
      if (!frame) return null;
      if (isRecord(frame.value) && frame.value.type === "client-discovery-request") {
        await this.#write({
          type: "client-discovery-response",
          requestId: frame.value.requestId,
          response: { canHandle: false },
        });
        continue;
      }
      return frame.value;
    }
    return null;
  }

  async #write(value: JsonRecord, onDispatch: () => void = () => {}): Promise<void> {
    if (!this.connected) throw this.#closed ?? new Error("Codex IPC disconnected");
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_REQUEST_BYTES)
      throw new Error("Codex IPC request exceeds size limit");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32LE(bytes.byteLength);
    const frame = Buffer.concat([header, bytes]);
    onDispatch();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.disconnect();
        reject(new Error("Codex IPC write timed out; do not retry a mutation"));
      }, READ_TIMEOUT_MS);
      this.#socket.write(frame, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  #receive(deadline: number): Promise<Frame | null> {
    if (!this.connected) return Promise.reject(this.#closed ?? new Error("Codex IPC disconnected"));
    const next = this.#queued.shift();
    if (next) {
      this.#queuedBytes -= next.bytes.byteLength;
      return Promise.resolve(next);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter: Waiter = { resolve };
      this.#waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        resolve(null);
      }, remaining);
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
    });
  }

  #onData(chunk: Buffer): void {
    if (!this.connected) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.byteLength > MAX_FRAME_BYTES + 4 && this.#buffer.length < 4) {
      this.disconnect();
      return;
    }
    try {
      while (this.#buffer.byteLength >= 4) {
        const size = this.#buffer.readUInt32LE(0);
        if (size === 0 || size > MAX_FRAME_BYTES) throw new Error("Codex IPC frame exceeds limit");
        if (this.#buffer.byteLength < size + 4) break;
        const bytes = this.#buffer.subarray(4, size + 4);
        const value: unknown = JSON.parse(bytes.toString("utf8"));
        const frame = { bytes, value };
        this.#buffer = this.#buffer.subarray(size + 4);
        const waiter = this.#waiters.shift();
        if (waiter) waiter.resolve(frame);
        else {
          this.#queued.push(frame);
          this.#queuedBytes += size;
          if (this.#queuedBytes > MAX_FRAME_BYTES)
            throw new Error("Codex IPC receive queue exceeded limit");
        }
      }
      if (this.#buffer.byteLength > MAX_FRAME_BYTES + 4)
        throw new Error("Codex IPC frame exceeds limit");
    } catch {
      this.disconnect();
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    this.#buffer = Buffer.alloc(0);
    this.#queued = [];
    this.#queuedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve(null);
  }
}

async function inspectEndpoint(endpoint: string): Promise<{ dev: number; ino: number }> {
  if (!path.isAbsolute(endpoint) || (await realpath(endpoint)) !== endpoint)
    throw new Error("Codex IPC endpoint must be canonical and absolute");
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("current user identity is unavailable");
  const parent = await stat(path.dirname(endpoint));
  const socket = await stat(endpoint);
  if (
    !parent.isDirectory() ||
    parent.uid !== uid ||
    (parent.mode & 0o077) !== 0 ||
    !socket.isSocket() ||
    socket.uid !== uid ||
    (socket.mode & 0o077) !== 0
  )
    throw new Error("Codex IPC endpoint permissions are unsafe");
  return { dev: socket.dev, ino: socket.ino };
}

function connectUnix(endpoint: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    const timer = setTimeout(() => finish(new Error("Codex IPC unavailable")), READ_TIMEOUT_MS);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeListener("connect", connected);
      socket.removeListener("error", failed);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(socket);
    };
    const connected = () => finish();
    const failed = (error: Error) => finish(error);
    socket.once("connect", connected);
    socket.once("error", failed);
  });
}

function verifyPeer(socket: Socket, expectedUid: number): string {
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd;
  if (!Number.isInteger(fd) || fd! < 0) throw new Error("Codex IPC peer identity is unavailable");
  const ffi = nativeBindings();
  const lib = ffi.load("/usr/lib/libSystem.B.dylib");
  const getPeerId = lib.func("int getpeereid(int socket, void *effectiveUid, void *effectiveGid)");
  const getSocketOption = lib.func(
    "int getsockopt(int socket, int level, int option, void *value, void *length)",
  );
  const processPath = lib.func("int proc_pidpath(int pid, void *buffer, unsigned int bufferSize)");
  const uid = Buffer.alloc(4);
  const gid = Buffer.alloc(4);
  if (getPeerId(fd, uid, gid) !== 0 || uid.readUInt32LE() !== expectedUid)
    throw new Error("Codex IPC peer is not owned by the current user");
  const pid = Buffer.alloc(4);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(4);
  if (getSocketOption(fd, 0, 2, pid, length) !== 0 || length.readUInt32LE() < 4)
    throw new Error("Codex IPC peer process is unavailable");
  const executable = Buffer.alloc(4096);
  const size = processPath(pid.readInt32LE(), executable, executable.byteLength);
  if (size <= 0) throw new Error("Codex IPC peer executable is unavailable");
  const value = executable.subarray(0, executable.indexOf(0));
  if (value.byteLength === 0) throw new Error("Codex IPC peer executable is invalid");
  return path.resolve(value.toString("utf8"));
}

async function readDesktopVersion(executable: string): Promise<string> {
  const contentsIndex = executable.split(path.sep).lastIndexOf("Contents");
  if (contentsIndex < 1) throw new Error("Codex IPC peer is not inside a Desktop app bundle");
  const root = path.resolve(path.sep, ...executable.split(path.sep).slice(1, contentsIndex + 1));
  const appDirectory = path.dirname(root);
  if (!appDirectory.endsWith(".app") || path.basename(root) !== "Contents")
    throw new Error("Codex IPC peer is not inside a Desktop app bundle");
  const asarPath = path.join(root, "Resources/app.asar");
  if ((await realpath(asarPath)) !== asarPath)
    throw new Error("Codex Desktop ASAR is not canonical");
  const packageData = await readAsarPackage(asarPath);
  if (packageData.name !== "openai-codex-electron" || typeof packageData.version !== "string")
    throw new Error("Codex Desktop package identity is invalid");
  return packageData.version;
}

async function readAsarPackage(filePath: string): Promise<JsonRecord> {
  const file = await open(filePath, "r");
  try {
    const { size: fileSize } = await file.stat();
    const prefix = Buffer.alloc(16);
    if ((await file.read(prefix, 0, prefix.byteLength, 0)).bytesRead !== prefix.byteLength)
      throw new Error("invalid Codex Desktop ASAR header");
    const headerSize = prefix.readUInt32LE(4);
    const jsonSize = prefix.readUInt32LE(12);
    if (jsonSize === 0 || jsonSize > 8 * 1024 * 1024 || headerSize < jsonSize + 8)
      throw new Error("invalid Codex Desktop ASAR index");
    const index = Buffer.alloc(jsonSize);
    if ((await file.read(index, 0, index.byteLength, 16)).bytesRead !== index.byteLength)
      throw new Error("truncated Codex Desktop ASAR index");
    const header: unknown = JSON.parse(index.toString("utf8"));
    if (!isRecord(header) || !isRecord(header.files) || !isRecord(header.files["package.json"]))
      throw new Error("Codex Desktop ASAR package metadata is missing");
    const packageEntry = header.files["package.json"];
    if ("link" in packageEntry || "unpacked" in packageEntry)
      throw new Error("unsupported Codex Desktop ASAR package entry");
    const offset = packageEntry.offset;
    const packageSize = packageEntry.size;
    if (
      typeof offset !== "string" ||
      !/^\d+$/.test(offset) ||
      !Number.isSafeInteger(packageSize) ||
      Number(packageSize) === 0 ||
      Number(packageSize) > 1024 * 1024
    )
      throw new Error("invalid Codex Desktop package extent");
    const start = BigInt(headerSize) + 8n + BigInt(offset);
    const end = start + BigInt(Number(packageSize));
    if (end > BigInt(fileSize) || end > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("Codex Desktop package metadata is outside its ASAR");
    const contents = Buffer.alloc(Number(packageSize));
    if (
      (await file.read(contents, 0, contents.byteLength, Number(start))).bytesRead !==
      contents.byteLength
    )
      throw new Error("truncated Codex Desktop package metadata");
    const value: unknown = JSON.parse(contents.toString("utf8"));
    if (!isRecord(value)) throw new Error("invalid Codex Desktop package metadata");
    return value;
  } finally {
    await file.close();
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
