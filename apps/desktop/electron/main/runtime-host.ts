import { EventEmitter } from "node:events";
import {
  createStdioTransport,
  type RuntimeProcessFactory,
  type RuntimeTransport,
  type RuntimeTransportFactory,
} from "./runtime-transport";
import {
  PROTOCOL_VERSION,
  RUNTIME_METHODS,
  type RuntimeHandshakeResult,
  type RuntimeRpcError,
} from "../generated/runtime-protocol";

const HEALTHY_RUNTIME_RESET_MS = 30_000;
const FORCE_KILL_GRACE_MS = 500;

export type RuntimeHostState = "starting" | "ready" | "restarting" | "failed" | "stopping";

export interface RuntimeHostStatus {
  state: RuntimeHostState;
  restartCount: number;
  error?: string;
}

export interface RuntimeHostOptions {
  args?: string[];
  createTransport?: RuntimeTransportFactory;
  executablePath: string;
  clientVersion: string;
  environment?: NodeJS.ProcessEnv;
  maxRestarts?: number;
  shutdownTimeoutMs?: number;
  handshakeTimeoutMs?: number;
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
    Pick<RuntimeHostOptions, "maxRestarts" | "shutdownTimeoutMs" | "handshakeTimeoutMs">
  > &
    Omit<RuntimeHostOptions, "maxRestarts" | "shutdownTimeoutMs" | "handshakeTimeoutMs">;
  readonly #pending = new Map<number, PendingRequest>();
  #child?: RuntimeTransport;
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
      // 冷启动时 runtime 要打开数据库，Windows 上还可能被杀毒扫描拖慢，留足余量。
      handshakeTimeoutMs: 20_000,
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
    if (!child || hasExited(child)) {
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
    if (!hasExited(child)) {
      child.terminate();
      await Promise.race([exited, delay(FORCE_KILL_GRACE_MS)]);
    }
    // 忽略 SIGTERM 的 runtime 不能在应用退出后变成孤儿进程。
    if (!hasExited(child)) {
      child.forceKill();
      await Promise.race([exited, delay(FORCE_KILL_GRACE_MS)]);
    }
  }

  #startAttempt(): void {
    void this.#spawnAndHandshake().catch((error: unknown) => {
      this.emit("restart-error", error);
    });
  }

  async #spawnAndHandshake(): Promise<void> {
    const options = {
      executablePath: this.#options.executablePath,
      args: this.#options.args ?? [],
      environment: { ...process.env, ...this.#options.environment },
    };
    let child: RuntimeTransport;
    try {
      child = this.#options.createTransport
        ? this.#options.createTransport(options)
        : createStdioTransport(options, this.#options.spawnProcess);
    } catch (error) {
      this.#scheduleRestart(toError(error));
      throw error;
    }
    this.#child = child;

    child.on("failure", (error: Error) => this.#handleProcessFailure(child, error));
    child.on("diagnostic", (chunk: string) => process.stderr.write(`[agentkib-backend] ${chunk}`));
    child.on("message", (message: unknown) => {
      if (this.#child === child) this.#handleMessage(message);
    });
    child.on("protocol-error", (error: Error) => this.emit("protocol-error", error));
    child.once("exit", (code, signal) => this.#handleExit(child, code, signal));

    try {
      await new Promise<void>((resolve, reject) => {
        const spawned = () => {
          child.off("failure", failed);
          resolve();
        };
        const failed = (error: Error) => {
          child.off("spawn", spawned);
          reject(error);
        };
        child.once("spawn", spawned);
        child.once("failure", failed);
      });

      // 进程已启动但一直不回握手时，所有排队请求都会永久挂起；超时后交给
      // 常规失败路径（杀进程、按退避重启，超过上限进入 failed）。
      const handshake = await withTimeout(
        this.#requestNow<RuntimeHandshakeResult>(RUNTIME_METHODS.handshake, {
          protocolVersion: PROTOCOL_VERSION,
          client: { name: "agentkib-electron", version: this.#options.clientVersion },
        }),
        this.#options.handshakeTimeoutMs,
        "AgentKib runtime did not complete the handshake in time",
      );
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

  #handleProcessFailure(child: RuntimeTransport, error: Error): void {
    if (this.#child !== child) return;
    const wasReady = this.#state === "ready";
    this.#child = undefined;
    this.#handshake = undefined;
    if (wasReady) this.#readiness = deferred<RuntimeHandshakeResult>();
    this.#rejectPending(error);
    // Consumers must invalidate runtime-backed services immediately, even when
    // the OS process has not delivered its exit event yet.
    this.emit("exit", { code: null, signal: null, expected: this.#state === "stopping" });
    // 失败的进程可能忽略 SIGTERM（例如卡在打开数据库）；句柄在这里就被替换掉了，
    // 之后 stop() 再也够不到它，所以当场升级到 SIGKILL，避免与重启后的新进程并存。
    terminate(child);
    this.#scheduleRestart(error);
  }

  #requestNow<TResult>(method: string, params: unknown): Promise<TResult> {
    const child = this.#child;
    if (!child || child.hasExited)
      throw new RuntimeUnavailableError(new Error("AgentKib runtime is not running"));

    const id = this.#nextRequestId++;
    const payload = { jsonrpc: "2.0", id, method, params };

    return new Promise<TResult>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void child.send(payload).catch((error: unknown) => {
        this.#pending.delete(id);
        const runtimeError = toError(error);
        reject(new RuntimeUnavailableError(runtimeError));
        this.#handleProcessFailure(child, runtimeError);
      });
    });
  }

  #handleMessage(value: unknown): void {
    if (
      typeof value !== "object" ||
      value === null ||
      !("jsonrpc" in value) ||
      value.jsonrpc !== "2.0"
    ) {
      this.emit("protocol-error", new Error("Invalid runtime RPC message"));
      return;
    }
    const message = value as RpcResponse & { method?: string; params?: unknown };

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

  #handleExit(child: RuntimeTransport, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#child !== child) return;
    this.#child = undefined;
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

function terminate(child: RuntimeTransport) {
  if (hasExited(child)) return;
  child.terminate();
  const timer = setTimeout(() => {
    if (!hasExited(child)) child.forceKill();
  }, FORCE_KILL_GRACE_MS);
  child.once("exit", () => clearTimeout(timer));
}

function hasExited(child: RuntimeTransport): boolean {
  // 被信号终止时 exitCode 为 null，必须同时检查 signalCode。
  return child.hasExited;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface RuntimeHost extends EventEmitter {
  readonly status: RuntimeHostStatus;
  start(): Promise<RuntimeHandshakeResult>;
  retry(): Promise<RuntimeHandshakeResult>;
  request<TResult>(method: string, params: unknown): Promise<TResult>;
  stop(): Promise<void>;
}
