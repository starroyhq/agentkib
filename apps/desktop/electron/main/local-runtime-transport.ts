import { connectLocalRuntime } from "@agentkib/backend/local-runtime-ipc";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeTransport, RuntimeTransportOptions } from "./runtime-transport";

const ATTACH_TIMEOUT_MS = 18_000;
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
    const expiresAt = Date.now() + ATTACH_TIMEOUT_MS;
    let launched = false;
    let lastError: unknown;
    while (!this.#abort.signal.aborted && Date.now() < expiresAt) {
      let socket: Socket;
      try {
        socket = await connectLocalRuntime(config.root);
      } catch (error) {
        if (!canStartAfter(error)) throw error;
        lastError = error;
        if (!launched && !this.#abort.signal.aborted) {
          launched = true;
          await this.#launch(options, config);
        }
        await delay(RETRY_MS, undefined, { signal: this.#abort.signal });
        continue;
      }
      if (this.#exited) {
        socket.destroy();
        return;
      }
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
      return;
    }
    if (!this.#exited)
      throw new Error("AgentKib local runtime did not become available", { cause: lastError });
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
