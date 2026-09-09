import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface, type Interface } from "node:readline";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type RuntimeHandshakeResult,
  type RuntimeRpcError,
} from "../generated/runtime-protocol";

const HEALTHY_RUNTIME_RESET_MS = 30_000;

export type RuntimeHostState = "starting" | "ready" | "restarting" | "failed" | "stopping";

export interface RuntimeHostStatus {
  state: RuntimeHostState;
  restartCount: number;
  error?: string;
}

type RuntimeProcessFactory = (
  executablePath: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcessWithoutNullStreams;

interface RuntimeHostOptions {
  executablePath: string;
  clientVersion: string;
  environment?: NodeJS.ProcessEnv;
  maxRestarts?: number;
  shutdownTimeoutMs?: number;
  spawnProcess?: RuntimeProcessFactory;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: RuntimeRpcError;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export class RuntimeUnavailableError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
    this.name = "RuntimeUnavailableError";
  }
}

export class RuntimeRequestError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(error: RuntimeRpcError) {
    const detail =
      typeof error.data === "object" &&
      error.data !== null &&
      "detail" in error.data &&
      typeof error.data.detail === "string"
        ? error.data.detail
        : undefined;
    super(detail ? `${error.message}: ${detail}` : error.message);
    this.name = "RuntimeRequestError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class DesktopRuntimeHost extends EventEmitter {
  readonly #options: Required<
    Pick<RuntimeHostOptions, "maxRestarts" | "shutdownTimeoutMs" | "spawnProcess">
  > &
    Omit<RuntimeHostOptions, "maxRestarts" | "shutdownTimeoutMs" | "spawnProcess">;
  readonly #pending = new Map<number, PendingRequest>();
  #child?: ChildProcessWithoutNullStreams;
  #lines?: Interface;
  #nextRequestId = 1;
  #restartCount = 0;
  #lastReadyAt = 0;
  #restartTimer?: NodeJS.Timeout;
  #state: RuntimeHostState = "stopping";
  #lastError?: Error;
  #readiness = deferred<RuntimeHandshakeResult>();
  #handshake?: RuntimeHandshakeResult;

  constructor(options: RuntimeHostOptions) {
    super();
    this.#options = {
      maxRestarts: 3,
      shutdownTimeoutMs: 2_000,
      spawnProcess: spawn as RuntimeProcessFactory,
      ...options,
    };
  }

  get status(): RuntimeHostStatus {
    return {
      state: this.#state,
      restartCount: this.#restartCount,
      ...(this.#lastError ? { error: this.#lastError.message } : {}),
    };
  }

  async start(): Promise<RuntimeHandshakeResult> {
    if (this.#state !== "stopping" || this.#child) {
      throw new Error("AgentKib runtime has already been started");
    }
    this.#restartCount = 0;
    this.#lastReadyAt = 0;
    this.#lastError = undefined;
    this.#handshake = undefined;
    this.#readiness = deferred<RuntimeHandshakeResult>();
    this.#setState("starting");
    this.#startAttempt();
    return this.#readiness.promise;
  }

  async retry(): Promise<RuntimeHandshakeResult> {
    if (this.#state !== "failed") {
      if (this.#state === "ready" && this.#handshake) return this.#handshake;
      return this.#readiness.promise;
    }
    this.#restartCount = 0;
    this.#lastReadyAt = 0;
    this.#lastError = undefined;
    this.#handshake = undefined;
    this.#readiness = deferred<RuntimeHandshakeResult>();
    this.#setState("starting");
    this.#startAttempt();
    return this.#readiness.promise;
  }

  async request<TResult>(method: string, params: unknown): Promise<TResult> {
    while (this.#state === "starting" || this.#state === "restarting") {
      await this.#readiness.promise;
    }
    if (this.#state === "failed") {
      throw new RuntimeUnavailableError(
        this.#lastError ?? new Error("AgentKib runtime failed to start"),
      );
    }
    if (this.#state !== "ready")
      throw new RuntimeUnavailableError(new Error("AgentKib runtime is stopping"));
    return this.#requestNow<TResult>(method, params);
  }

  async stop(): Promise<void> {
    if (this.#state === "stopping") return;
    this.#setState("stopping");
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = undefined;
    }
    const stoppingError = new Error("AgentKib runtime is stopping");
    this.#rejectReadiness(stoppingError);

    const child = this.#child;
    if (!child || child.exitCode !== null) {
      this.#rejectPending(stoppingError);
      return;
    }

    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const gracefulShutdown = (async () => {
      try {
        await this.#requestNow(RUNTIME_METHODS.shutdown, {});
      } catch {
        // An already-failed runtime still needs the bounded termination path below.
      }
      await exited;
    })();
    await Promise.race([gracefulShutdown, delay(this.#options.shutdownTimeoutMs)]);
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([exited, delay(500)]);
    }
  }

  #startAttempt(): void {
    void this.#spawnAndHandshake().catch((error: unknown) => {
      this.emit("restart-error", error);
    });
  }

  async #spawnAndHandshake(): Promise<void> {
    const child = this.#options.spawnProcess(this.#options.executablePath, [], {
      env: { ...process.env, ...this.#options.environment },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    // Writable write callbacks do not consume the stream's subsequent error event.
    // Keep this listener on the old stream too: a late EPIPE after exit is expected.
    child.stdin.on("error", (error: Error) => this.#handleProcessFailure(child, error));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => process.stderr.write(`[agentkib-runtime] ${chunk}`));

    const lines = createInterface({ input: child.stdout });
    this.#lines = lines;
    lines.on("line", (line) => this.#handleLine(line));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      const handshake = await this.#requestNow<RuntimeHandshakeResult>(RUNTIME_METHODS.handshake, {
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "agentkib-electron", version: this.#options.clientVersion },
      });
      if (handshake.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `Runtime returned protocol ${handshake.protocolVersion}; expected ${PROTOCOL_VERSION}`,
        );
      }
      if (this.#child !== child || this.#state === "stopping") return;

      this.#lastReadyAt = Date.now();
      this.#lastError = undefined;
      this.#handshake = handshake;
      this.#setState("ready");
      this.#resolveReadiness(handshake);
      this.emit("ready", handshake);
    } catch (error) {
      const runtimeError = toError(error);
      this.#handleProcessFailure(child, runtimeError);
      throw runtimeError;
    }
  }

  #handleProcessFailure(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.#child !== child) return;
    const wasReady = this.#state === "ready";
    this.#child = undefined;
    this.#lines?.close();
    this.#lines = undefined;
    this.#handshake = undefined;
    if (wasReady) this.#readiness = deferred<RuntimeHandshakeResult>();
    this.#rejectPending(error);
    // Consumers must invalidate runtime-backed services immediately, even when
    // the OS process has not delivered its exit event yet.
    this.emit("exit", { code: child.exitCode, signal: null, expected: this.#state === "stopping" });
    if (child.exitCode === null) child.kill();
    this.#scheduleRestart(error);
  }

  #requestNow<TResult>(method: string, params: unknown): Promise<TResult> {
    const child = this.#child;
    if (!child || child.exitCode !== null)
      throw new RuntimeUnavailableError(new Error("AgentKib runtime is not running"));

    const id = this.#nextRequestId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });

    return new Promise<TResult>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        child.stdin.write(`${payload}\n`, (error) => {
          if (!error) return;
          this.#pending.delete(id);
          reject(new RuntimeUnavailableError(error));
          this.#handleProcessFailure(child, error);
        });
      } catch (error) {
        this.#pending.delete(id);
        const runtimeError = toError(error);
        reject(new RuntimeUnavailableError(runtimeError));
        this.#handleProcessFailure(child, runtimeError);
      }
    });
  }

  #handleLine(line: string): void {
    let message: RpcResponse & { method?: string; params?: unknown };
    try {
      message = JSON.parse(line) as RpcResponse & { method?: string; params?: unknown };
    } catch (error) {
      this.emit("protocol-error", new Error(`Invalid runtime JSON: ${String(error)}`));
      return;
    }

    if (typeof message.id !== "number") {
      if (message.method) this.emit("notification", message.method, message.params);
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new RuntimeRequestError(message.error));
    else pending.resolve(message.result);
  }

  #handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.#child !== child) return;
    this.#child = undefined;
    this.#lines?.close();
    this.#lines = undefined;
    const error = new Error(
      `AgentKib runtime exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
    );
    this.#rejectPending(error);
    const expected = this.#state === "stopping";
    const wasReady = this.#state === "ready";
    this.emit("exit", { code, signal, expected });
    if (expected) return;

    this.#handshake = undefined;
    if (wasReady) this.#readiness = deferred<RuntimeHandshakeResult>();
    this.#setState("restarting", error);
    this.#scheduleRestart(error);
  }

  #scheduleRestart(error: Error): void {
    if (this.#lastReadyAt > 0 && Date.now() - this.#lastReadyAt >= HEALTHY_RUNTIME_RESET_MS) {
      this.#restartCount = 0;
    }
    this.#lastReadyAt = 0;
    this.#lastError = error;

    if (this.#state === "stopping" || this.#restartTimer) return;
    if (this.#restartCount >= this.#options.maxRestarts) {
      this.#setState("failed", error);
      this.#rejectReadiness(error);
      this.emit("crash-loop", error);
      return;
    }

    this.#setState("restarting", error);
    const backoffMs = 250 * 2 ** this.#restartCount;
    this.#restartCount += 1;
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      this.#startAttempt();
    }, backoffMs);
  }

  #setState(state: RuntimeHostState, error?: Error): void {
    this.#state = state;
    if (error) this.#lastError = error;
    this.emit("state", this.status);
  }

  #resolveReadiness(handshake: RuntimeHandshakeResult): void {
    if (this.#readiness.settled) return;
    this.#readiness.settled = true;
    this.#readiness.resolve(handshake);
  }

  #rejectReadiness(error: Error): void {
    if (this.#readiness.settled) return;
    this.#readiness.settled = true;
    this.#readiness.reject(new RuntimeUnavailableError(error));
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values())
      pending.reject(new RuntimeUnavailableError(error));
    this.#pending.clear();
  }
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const value: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (result) => resolvePromise(result),
    reject: (error) => rejectPromise(error),
    settled: false,
  };
  void value.promise.catch(() => undefined);
  return value;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
