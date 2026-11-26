import {
  LOCAL_RUNTIME_IDENTITY,
  localRuntimeKeyGeneration,
  localRuntimeLeaseBusy,
  openLocalRuntime,
  tryAcquireLocalRuntimeLaunchLease,
  type LocalRuntimeIdentity,
} from "@agentkib/backend/local-runtime-ipc";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeTransport, RuntimeTransportOptions } from "./runtime-transport";

const ATTACH_TIMEOUT_MS = 18_000;
const HANDOFF_TIMEOUT_MS = 60_000;
const IDENTITY_TIMEOUT_MS = 3_000;
const RETRY_MS = 120;

interface LocalRuntimeTransportConfig {
  root: string;
  dataDir: string;
  electronPath: string;
  spawnProcess?: typeof spawn;
}

export function createLocalRuntimeTransport(
  options: RuntimeTransportOptions,
  config: LocalRuntimeTransportConfig,
): RuntimeTransport {
  return new LocalRuntimeTransport(options, config);
}

function canStartAfter(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}

async function identifyRuntime(
  socket: Socket,
  signal: AbortSignal,
  requesterVersion: string,
): Promise<string | undefined> {
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  const disconnected = new AbortController();
  const onClose = () => disconnected.abort();
  socket.once("close", onClose);
  try {
    const id = "local-runtime-identity";
    const replyLine = once(lines, "line", {
      signal: AbortSignal.any([
        signal,
        disconnected.signal,
        AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
      ]),
    });
    socket.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: LOCAL_RUNTIME_IDENTITY,
        params: { requesterVersion },
      })}\n`,
    );
    const [line] = await replyLine;
    const reply = JSON.parse(line) as {
      jsonrpc?: unknown;
      id?: unknown;
      result?: LocalRuntimeIdentity;
      error?: { code?: unknown; message?: unknown };
    } | null;
    if (reply?.jsonrpc !== "2.0" || reply.id !== id)
      throw new Error("Invalid local runtime identity response");
    if (typeof reply.result?.version === "string" && reply.result.version && !reply.error)
      return reply.result.version;
    // Published services reject unadmitted requests. A legacy handshake would join the
    // service and discard the previous desktop's pending quit decision.
    if (
      reply.error?.code === -32001 &&
      reply.error.message === "Local runtime is unavailable for this client"
    )
      return undefined;
    throw new Error("Invalid local runtime identity response");
  } finally {
    socket.off("close", onClose);
    lines.close();
  }
}

/** The desktop owns this connection. The shared service is responsible for its own lifetime. */
class LocalRuntimeTransport extends EventEmitter implements RuntimeTransport {
  readonly #abort = new AbortController();
  #socket?: Socket;
  #exited = false;

  constructor(options: RuntimeTransportOptions, config: LocalRuntimeTransportConfig) {
    super();
    void this.#attach(options, config).catch((error: unknown) => {
      if (!this.#exited) this.emit("failure", error);
    });
  }

  get hasExited(): boolean {
    return this.#exited;
  }

  async #attach(options: RuntimeTransportOptions, config: LocalRuntimeTransportConfig) {
    const version = options.environment.AGENTKIB_APP_VERSION;
    if (!version) throw new Error("AgentKib local runtime version is missing");
    const signal = this.#abort.signal;
    let expiresAt = Date.now() + ATTACH_TIMEOUT_MS;
    let waitingForHandoff = false;
    let releaseLaunch: (() => void) | undefined;
    let launched = false;
    let lastError: unknown;
    try {
      while (!signal.aborted && Date.now() < expiresAt) {
        let connection: Awaited<ReturnType<typeof openLocalRuntime>>;
        try {
          connection = await openLocalRuntime(config.root);
        } catch (error) {
          if (!canStartAfter(error)) throw error;
          lastError = error;
          if (!launched && !signal.aborted && !localRuntimeLeaseBusy(config.root)) {
            releaseLaunch ??= tryAcquireLocalRuntimeLaunchLease(config.root);
            // Another owner may have started between checking the endpoint and taking the lease.
            if (releaseLaunch && !localRuntimeLeaseBusy(config.root)) {
              await this.#launch(options, config);
              launched = true;
            }
          }
          await delay(RETRY_MS, undefined, { signal });
          continue;
        }
        const { socket, generation } = connection;
        try {
          if ((await identifyRuntime(socket, signal, version)) === version && !signal.aborted) {
            this.#connect(socket);
            return;
          }
        } finally {
          if (this.#socket !== socket) socket.destroy();
        }
        if (!waitingForHandoff) expiresAt = Date.now() + HANDOFF_TIMEOUT_MS;
        waitingForHandoff = true;
        // Do not reconnect to the old endpoint while it drains. Even an unadmitted socket
        // would reset the idle timer on published services.
        while (localRuntimeLeaseBusy(config.root)) {
          // Another desktop can claim the lease before we see it free. A newly published
          // key belongs to that successor, so the next probe does not touch the old owner.
          const current = localRuntimeKeyGeneration(config.root);
          if (current && current !== generation) break;
          if (Date.now() >= expiresAt)
            throw new Error(
              "AgentKib is waiting for the previous local runtime to finish quitting",
            );
          await delay(RETRY_MS, undefined, { signal });
        }
        launched = false;
      }
      if (!signal.aborted)
        throw new Error("AgentKib local runtime did not become available", { cause: lastError });
    } finally {
      releaseLaunch?.();
    }
  }

  #connect(socket: Socket): void {
    this.#socket = socket;
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        this.emit("message", JSON.parse(line));
      } catch {
        this.emit("protocol-error", new Error("Invalid local runtime JSON"));
        socket.destroy();
      }
    });
    socket.on("error", (error: Error) => this.emit("failure", error));
    socket.once("close", () => {
      lines.close();
      this.#exit();
    });
    this.emit("spawn");
  }

  async #launch(options: RuntimeTransportOptions, config: LocalRuntimeTransportConfig) {
    const child = (config.spawnProcess ?? spawn)(
      config.electronPath,
      [options.executablePath, "--local-runtime", config.root, config.dataDir],
      {
        detached: true,
        env: { ...options.environment, ELECTRON_RUN_AS_NODE: "1" },
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  send(message: unknown): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.destroyed)
      return Promise.reject(new Error("Local runtime is disconnected"));
    return new Promise((resolve, reject) => {
      socket.write(`${JSON.stringify(message)}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  terminate(): void {
    this.#socket?.destroy();
    this.#exit();
  }

  forceKill(): void {
    this.terminate();
  }

  #exit() {
    if (this.#exited) return;
    this.#exited = true;
    this.#abort.abort();
    this.emit("exit", null, null);
  }
}
