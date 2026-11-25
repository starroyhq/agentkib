import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Server } from "node:tls";
import {
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  type LocalCostProvider,
  type QuitWorkDecision,
} from "@agentkib/runtime-protocol";
import { TypeScriptBackend } from "./index";
import {
  assertPrivateRuntimePath,
  createLocalRuntimeServer,
  LOCAL_RUNTIME_IDENTITY,
  LOCAL_RUNTIME_PRESENCE,
  LOCAL_RUNTIME_PRESENCE_CHANGED,
  localRuntimePaths,
  type LocalRuntimeIdentity,
  type LocalRuntimePresence,
} from "./local-runtime-ipc";
import { acquirePortableFileLease, existingFileLeaseBusy } from "./managed-session-lock";
import { BACKEND_INITIALIZE } from "./migration";
import { readPreferences } from "./preferences";
import { quitWorkDecisionSchema } from "./sessions/quit-work";
import { restrictRemotePath } from "./remote-tls";

const MAX_CLIENTS = 32;
const MAX_PENDING_RPC = 128;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 15_000;

type RecordValue = Record<string, unknown>;
type Client = { socket: Socket; requests: number; observesMemory: boolean; ending?: boolean };

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function request(method: string, params: unknown, id: unknown = 0) {
  return { jsonrpc: "2.0", id, method, params };
}

function failure(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function unlinkPrivatePath(file: string, kind: "file" | "socket") {
  try {
    // The lease and parent-directory check already protect this pathname. A daemon may
    // have died between listen() creating its socket and tightening the mode.
    assertPrivateRuntimePath(file, kind, false);
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function privateRoot(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivateRuntimePath(root, "directory");
  if (process.platform === "win32") restrictRemotePath(root, true);
}

async function assertNoLegacyRuntime(dataDir: string, environment: NodeJS.ProcessEnv) {
  const legacyDirs = new Set([dataDir, environment.AGENTKIB_LEGACY_DEV_DATA_DIR]);
  for (const directory of legacyDirs) {
    if (!directory) continue;
    for (const bridge of ["claude-bridge", "dsh-bridge"]) {
      if (existingFileLeaseBusy(path.join(directory, bridge, "broker.lock")))
        throw new Error(
          "An older AgentKib runtime holds a local Agent bridge. Close it and retry.",
        );
    }
  }

  // The attached backend opens SQLite before binding its mandatory MCP listener.
  // Refuse an existing listener before attempting our own database initialization.
  const network = record(readPreferences(dataDir).mcp_network);
  const configuredPort = network?.port;
  const port =
    typeof configuredPort === "number" &&
    Number.isInteger(configuredPort) &&
    configuredPort >= 1 &&
    configuredPort <= 65535 &&
    typeof network?.lan_enabled === "boolean" &&
    typeof network.lan_risk_accepted === "boolean"
      ? configuredPort
      : environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev"
        ? 47654
        : 47653;
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      reject(
        new Error(
          "The local AgentKib MCP port is in use. Close any older AgentKib runtime and retry.",
        ),
      );
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(new Error("Could not verify the local AgentKib MCP port", { cause: error }));
    });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      reject(new Error("Timed out checking the local AgentKib MCP port"));
    });
  });
}

function writeFrame(client: Client, message: unknown) {
  if (client.socket.destroyed || client.socket.writableEnded) return;
  const frame = `${JSON.stringify(message)}\n`;
  if (client.socket.writableLength + Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
    client.socket.destroy();
    return;
  }
  client.socket.write(frame);
}

function readFrames(socket: Socket, onFrame: (value: string) => void) {
  const decoder = new StringDecoder("utf8");
  let partial = "";
  let bytes = 0;
  socket.on("data", (chunk: Buffer) => {
    if (socket.writableEnded) return;
    const text = decoder.write(chunk);
    let start = 0;
    for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n", start)) {
      const line = text.slice(start, end);
      if (bytes + Buffer.byteLength(line) > MAX_FRAME_BYTES) return socket.destroy();
      onFrame(partial + line);
      if (socket.destroyed || socket.writableEnded) return;
      partial = "";
      bytes = 0;
      start = end + 1;
    }
    const tail = text.slice(start);
    bytes += Buffer.byteLength(tail);
    if (bytes > MAX_FRAME_BYTES) return socket.destroy();
    partial += tail;
  });
}

/** Own the one backend for this local user while any authenticated desktop is attached. */
export async function serveLocalRuntime(
  root: string,
  dataDir: string,
  environment: NodeJS.ProcessEnv,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
) {
  if (!path.isAbsolute(dataDir)) throw new Error("Local runtime data directory must be absolute");
  const paths = localRuntimePaths(root);
  const identity: LocalRuntimeIdentity = { version: environment.AGENTKIB_APP_VERSION ?? "0.13.0" };
  privateRoot(paths.root);
  const release = acquirePortableFileLease(paths.lock);
  const key = randomBytes(32);
  const clients = new Set<Client>();
  // Handshake completion orders the desktop duties, independent of socket accept order.
  const compatibleClients = new Set<Client>();
  const subscriptions = new Map<string, Client>();
  const costObservers = new Map<Client, LocalCostProvider>();
  const pending = new Set<Promise<void>>();
  let finishClose!: () => void;
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve;
  });
  let listener: Server | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let lastQuitDecision: QuitWorkDecision | undefined;
  let closing = false;
  let endpointOwned = false;
  let keyOwned = false;

  const backend = new TypeScriptBackend(environment, (method, params) => {
    const frame = { jsonrpc: "2.0", method, params };
    if (method === SESSION_EVENT_NOTIFICATION) {
      const id = record(params)?.subscriptionId;
      const client = typeof id === "string" ? subscriptions.get(id) : undefined;
      if (client) writeFrame(client, frame);
      return;
    }
    for (const client of compatibleClients) writeFrame(client, frame);
  });

  function presence(client: Client): LocalRuntimePresence {
    return {
      peers: compatibleClients.size - 1,
      primary: compatibleClients.values().next().value === client,
    };
  }

  function publishPresence() {
    for (const client of compatibleClients) {
      writeFrame(client, {
        jsonrpc: "2.0",
        method: LOCAL_RUNTIME_PRESENCE_CHANGED,
        params: presence(client),
      });
    }
  }

  function removeSubscription(id: string) {
    subscriptions.delete(id);
    return backend.handleAsync(
      request(RUNTIME_METHODS.sessionsUnsubscribe, { subscriptionId: id }),
    );
  }

  function observedCostProvider() {
    return [...costObservers.values()].at(-1) ?? null;
  }

  function onClientClose(client: Client) {
    clients.delete(client);
    const changed = compatibleClients.delete(client);
    if (closing) return;
    if (client.observesMemory && ![...clients].some((peer) => peer.observesMemory))
      void backend.handleAsync(request(RUNTIME_METHODS.nativeMemoryObserve, { active: false }));
    const previous = observedCostProvider();
    if (costObservers.delete(client) && observedCostProvider() !== previous)
      void backend.handleAsync(
        request(RUNTIME_METHODS.observeLocalCosts, { provider: observedCostProvider() }),
      );
    for (const [id, subscriber] of subscriptions)
      if (subscriber === client) void removeSubscription(id);
    if (changed) {
      publishPresence();
      scheduleIdleCheck();
    }
  }

  async function dispatch(client: Client, value: unknown) {
    const incoming = record(value);
    const id = incoming?.id ?? null;
    const method = incoming?.method;
    const params = record(incoming?.params);
    if (!incoming || incoming.jsonrpc !== "2.0" || typeof method !== "string") {
      writeFrame(client, failure(id, -32600, "Invalid JSON-RPC request"));
      return;
    }
    if (method === LOCAL_RUNTIME_IDENTITY) {
      // An authenticated version probe is not a desktop joining the runtime.
      writeFrame(client, { jsonrpc: "2.0", id, result: identity });
      return;
    }
    if (method === RUNTIME_METHODS.handshake) {
      const reply = await backend.handleAsync(value);
      if (!reply.error && record(params?.client)?.version !== identity.version) {
        writeFrame(client, failure(id, -32001, "Local runtime version does not match"));
        return;
      }
      const joined =
        !reply.error &&
        !closing &&
        clients.has(client) &&
        !client.ending &&
        !compatibleClients.has(client);
      if (joined) {
        compatibleClients.add(client);
        lastQuitDecision = undefined;
        clearTimeout(idleTimer);
      }
      writeFrame(client, reply);
      if (joined) publishPresence();
      return;
    }
    if (!compatibleClients.has(client) || closing) {
      writeFrame(client, failure(id, -32001, "Local runtime is unavailable for this client"));
      return;
    }
    if (method === LOCAL_RUNTIME_PRESENCE) {
      writeFrame(client, { jsonrpc: "2.0", id, result: presence(client) });
      return;
    }
    if (method === BACKEND_INITIALIZE) {
      // RuntimeRouter sends this on every window connection and transport reconnect.
      const exactDirectory =
        typeof params?.dataDir === "string" &&
        path.resolve(params.dataDir) === path.resolve(dataDir);
      writeFrame(
        client,
        exactDirectory
          ? { jsonrpc: "2.0", id, result: null }
          : failure(id, -32602, "Local runtime data directory does not match"),
      );
      if (exactDirectory) backend.activateQuitWork();
      return;
    }
    if (method === RUNTIME_METHODS.shutdown) {
      // A quit decision can only accompany the last desktop leaving. The actual stop
      // still waits for idle; a desktop joining the same runtime cancels the decision.
      if (compatibleClients.size === 1)
        lastQuitDecision = quitWorkDecisionSchema.safeParse(params?.quitWork).data;
      // A peer can quit as soon as it receives this reply, before this socket closes.
      client.ending = true;
      compatibleClients.delete(client);
      // DesktopRuntimeHost expects a reply and then an exit. This is just its transport.
      client.socket.end(`${JSON.stringify({ jsonrpc: "2.0", id, result: null })}\n`);
      publishPresence();
      scheduleIdleCheck();
      return;
    }
    if (
      method === RUNTIME_METHODS.sessionsUnsubscribe &&
      typeof params?.subscriptionId === "string"
    ) {
      if (subscriptions.get(params.subscriptionId) !== client) {
        writeFrame(client, { jsonrpc: "2.0", id, result: { removed: false } });
        return;
      }
      subscriptions.delete(params.subscriptionId);
    }
    if (
      method === RUNTIME_METHODS.nativeMemoryObserve &&
      typeof params?.active === "boolean" &&
      Object.keys(params).length === 1
    ) {
      client.observesMemory = params.active;
      value = request(method, { active: [...clients].some((peer) => peer.observesMemory) }, id);
    }
    if (method === RUNTIME_METHODS.observeLocalCosts) {
      const provider = params?.provider;
      if (provider === "codex" || provider === "claude" || provider === null) {
        costObservers.delete(client);
        if (provider) costObservers.set(client, provider);
        value = request(method, { provider: observedCostProvider() }, id);
      }
    }
    const reply = await backend.handleAsync(value);
    if (method === RUNTIME_METHODS.sessionsSubscribe && !reply.error) {
      const subscriptionId = record(reply.result)?.subscriptionId;
      if (typeof subscriptionId === "string") {
        if (client.socket.destroyed || !clients.has(client)) {
          await removeSubscription(subscriptionId);
          return;
        }
        subscriptions.set(subscriptionId, client);
      }
    }
    writeFrame(client, reply);
  }

  function onClient(socket: Socket) {
    const client: Client = { socket, requests: 0, observesMemory: false };
    if (closing) return socket.destroy();
    clients.add(client);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => onClientClose(client));
    readFrames(socket, (line) => {
      if (client.requests >= MAX_PENDING_RPC) return socket.destroy();
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        writeFrame(client, failure(null, -32700, "Parse error"));
        return;
      }
      client.requests++;
      const task = dispatch(client, value)
        .catch(() => {
          socket.destroy();
        })
        .finally(() => {
          client.requests--;
          pending.delete(task);
        });
      pending.add(task);
    });
    return socket;
  }

  async function close(quitWork?: QuitWorkDecision) {
    if (closing) return closed;
    closing = true;
    clearTimeout(idleTimer);
    try {
      const stopped = new Promise<void>((resolve) => {
        if (!listener?.listening) resolve();
        else listener.close(() => resolve());
      });
      for (const client of clients) client.socket.destroy();
      backend.cancelPendingOperations();
      await Promise.allSettled([...pending]);
      await backend.closeAsync(quitWork);
      await stopped;
    } finally {
      try {
        if (keyOwned) unlinkPrivatePath(paths.key, "file");
        if (endpointOwned && process.platform !== "win32")
          unlinkPrivatePath(paths.endpoint, "socket");
      } finally {
        release();
        finishClose();
      }
    }
  }

  function scheduleIdleCheck() {
    if (closing || compatibleClients.size) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (compatibleClients.size) return;
      void close(lastQuitDecision).catch(() => {
        process.exitCode = 1;
      });
    }, idleTimeoutMs);
  }

  try {
    await assertNoLegacyRuntime(dataDir, environment);
    unlinkPrivatePath(paths.key, "file");
    if (process.platform !== "win32") unlinkPrivatePath(paths.endpoint, "socket");
    const init = await backend.handleAsync(request(BACKEND_INITIALIZE, { dataDir }));
    if (init.error) throw new Error("Local runtime initialization failed", { cause: init.error });
    const server = createLocalRuntimeServer(key, onClient);
    server.maxConnections = MAX_CLIENTS;
    listener = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths.endpoint, () => {
        server.off("error", reject);
        endpointOwned = true;
        resolve();
      });
    });
    server.on(
      "error",
      () =>
        void close().catch(() => {
          process.exitCode = 1;
        }),
    );
    if (process.platform !== "win32") restrictRemotePath(paths.endpoint);
    // Publish only after the full key and the accepting socket have private permissions.
    const temporaryKey = path.join(paths.root, `key-${randomBytes(12).toString("hex")}.tmp`);
    try {
      writeFileSync(temporaryKey, key, { mode: 0o600, flag: "wx" });
      if (process.platform === "win32") restrictRemotePath(temporaryKey);
      renameSync(temporaryKey, paths.key);
      keyOwned = true;
    } finally {
      unlinkPrivatePath(temporaryKey, "file");
    }
    scheduleIdleCheck();
    return { close, closed };
  } catch (error) {
    await close();
    throw error;
  }
}
