import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import spawn from "cross-spawn";
import { windowsProcessTree, type NativeProcessTree } from "./native-process";

const FRAME_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const TERMINATION_TIMEOUT_MS = 1_000;

type Response = { id?: unknown; result?: unknown; error?: unknown };

/** A native rejection is distinct from losing the response after a write. */
export class CodexAppServerError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(value: unknown) {
    const error = isObject(value) ? value : {};
    super(
      typeof error.message === "string" ? error.message : "Codex app-server rejected the request",
    );
    this.name = "CodexAppServerError";
    this.code = typeof error.code === "number" ? error.code : undefined;
    this.data = error.data;
  }
}

export function codexWriterBusy(error: unknown): boolean {
  return (
    error instanceof CodexAppServerError &&
    error.code === -32600 &&
    /\balready has an active writer\b/i.test(error.message)
  );
}

/** CLI 0.163.0's thread/delete answer for a thread whose rollout is already gone. */
export function codexThreadMissing(error: unknown): boolean {
  return (
    error instanceof CodexAppServerError &&
    error.code === -32600 &&
    /^no rollout found for thread id\b/i.test(error.message)
  );
}

/** A bounded, persistent app-server connection for managed AgentKib sessions. */
export class CodexAppServerSession extends EventEmitter {
  #child: ChildProcess;
  #tree?: NativeProcessTree;
  #pending = new Map<number, (value: Response) => void>();
  #buffer = Buffer.alloc(0);
  #nextId = 0;
  #closed?: Error;
  #closing?: Promise<void>;
  #didClose = false;
  #exited: Promise<void>;

  private constructor(child: ChildProcess, tree?: NativeProcessTree) {
    super();
    this.#child = child;
    this.#tree = tree;
    child.stdout?.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.on("error", (error) => this.#fail(error));
    child.stdin?.on("error", (error) => this.#fail(error));
    this.#exited = new Promise((resolve) => {
      child.once("close", (code) => {
        this.#didClose = true;
        this.#fail(new Error(`Codex app-server exited (${code ?? "unknown"})`));
        this.emit("close");
        resolve();
      });
    });
  }

  static async start(
    executable: string,
    workspace: string,
    home: string,
    environment: NodeJS.ProcessEnv,
    onNotification?: (notification: Record<string, unknown>) => void,
    onSessionStarted?: (session: CodexAppServerSession) => void,
  ): Promise<CodexAppServerSession> {
    const child = spawn(executable, ["app-server", "--stdio"], {
      cwd: workspace,
      env: { ...environment, CODEX_HOME: home },
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let tree: NativeProcessTree | undefined;
    let session: CodexAppServerSession | undefined;
    try {
      if (process.platform === "win32" && child.pid) tree = windowsProcessTree(child.pid);
      session = new CodexAppServerSession(child, tree);
      if (onNotification) session.on("notification", onNotification);
      onSessionStarted?.(session);
      await session.request("initialize", {
        clientInfo: { name: "agentkib", title: "AgentKib", version: "0.13.0" },
        capabilities: { experimentalApi: true },
      });
      session.#write(Buffer.from('{"method":"initialized","params":{}}\n'));
      return session;
    } catch (error) {
      if (session) {
        await session.close();
      } else {
        tree?.close();
        if (process.platform === "win32") child.kill("SIGKILL");
        else if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
      throw error;
    }
  }

  get connected(): boolean {
    return !this.#closed && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /** A failed shutdown request does not prove that the process and stdio exited. */
  get closed(): boolean {
    return this.#didClose;
  }

  async request(method: string, params: unknown, onDispatch?: () => void): Promise<unknown> {
    if (!this.connected) throw this.#closed ?? new Error("Codex app-server is unavailable");
    if (this.#pending.size >= 128) throw new Error("Codex app-server is busy");
    const id = ++this.#nextId;
    if (!Number.isSafeInteger(id)) throw new Error("Codex app-server request limit reached");
    const frame = Buffer.from(JSON.stringify({ id, method, params }) + "\n");
    if (frame.length > FRAME_LIMIT) throw new Error("Codex request exceeds the frame limit");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<Response>((resolve, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("Codex app-server request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    try {
      onDispatch?.();
      this.#write(frame);
      const value = await response;
      if (value.error !== undefined) {
        if (value.error instanceof Error) throw value.error;
        throw new CodexAppServerError(value.error);
      }
      if (!("result" in value)) throw new Error("Codex app-server returned an invalid response");
      return value.result;
    } finally {
      clearTimeout(timer);
      this.#pending.delete(id);
    }
  }

  respond(id: unknown, result: unknown): void {
    this.#write(Buffer.from(JSON.stringify({ id, result }) + "\n"));
  }

  respondError(id: unknown, code: number, message: string): void {
    this.#write(Buffer.from(JSON.stringify({ id, error: { code, message } }) + "\n"));
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#fail(new Error("Codex app-server session closed"));
    try {
      if (this.#didClose) return;
      this.#child.stdin?.end();
      if (await settledWithin(this.#exited, SHUTDOWN_TIMEOUT_MS)) return;
      if (process.platform === "win32") {
        this.#tree?.terminate();
        if (!this.#tree) this.#child.kill("SIGKILL");
      } else if (this.#child.pid) {
        try {
          process.kill(-this.#child.pid, "SIGKILL");
        } catch {
          this.#child.kill("SIGKILL");
        }
      }
      // Killing a process (or its Windows job) only requests termination. Keep
      // its lease and workspace alive until the child and stdio actually close.
      if (!(await settledWithin(this.#exited, TERMINATION_TIMEOUT_MS)))
        throw new Error("Codex app-server process did not close after termination");
    } finally {
      this.#tree?.close();
    }
  }

  #write(frame: Buffer): void {
    if (!this.connected) throw this.#closed ?? new Error("Codex app-server is unavailable");
    if (frame.length > FRAME_LIMIT) throw new Error("Codex request exceeds the frame limit");
    const stdin = this.#child.stdin;
    if (!stdin?.writable) throw new Error("Codex app-server stdin is unavailable");
    stdin.write(frame);
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > FRAME_LIMIT && this.#buffer.indexOf(10) < 0) {
      this.#fail(new Error("Codex response exceeds the frame limit"));
      return;
    }
    for (;;) {
      const newline = this.#buffer.indexOf(10);
      if (newline < 0) return;
      if (newline > FRAME_LIMIT) {
        this.#fail(new Error("Codex response exceeds the frame limit"));
        return;
      }
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        this.#fail(new Error("Codex returned malformed app-server data"));
        return;
      }
      if (!isObject(value)) continue;
      if (typeof value.id === "number" && typeof value.method !== "string") {
        const pending = this.#pending.get(value.id);
        if (pending) {
          pending(value as Response);
          this.#pending.delete(value.id);
        }
      } else if ("id" in value && typeof value.method === "string") {
        this.emit("serverRequest", value);
      } else if (typeof value.method === "string") {
        this.emit("notification", value);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const resolve of this.#pending.values()) resolve({ error });
    this.#pending.clear();
  }
}

async function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Short-lived, bounded Codex app-server reader for metadata-only thread requests. */
export class CodexAppServerReader {
  #sessions = new Set<CodexAppServerSession>();
  #closed = false;
  #closing?: Promise<void>;

  constructor(readonly environment: NodeJS.ProcessEnv) {}

  close(): void {
    void this.closeAsync().catch(() => undefined);
  }

  closeAsync(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const closing = Promise.allSettled([...this.#sessions].map((session) => session.close())).then(
      (results) => {
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      },
    );
    this.#closing = closing;
    return closing;
  }

  async readThread(
    executable: string,
    workspace: string,
    home: string,
    threadId: string,
  ): Promise<unknown> {
    return this.request(executable, workspace, home, "thread/read", {
      threadId,
      includeTurns: false,
    });
  }

  async readThreadGoal(
    executable: string,
    workspace: string,
    home: string,
    threadId: string,
    validateThread?: (thread: Record<string, unknown>) => void,
  ): Promise<{ thread: unknown; goal: unknown }> {
    const [thread, goal] = await this.requestMany(
      executable,
      workspace,
      home,
      [
        ["thread/read", { threadId, includeTurns: false }],
        ["thread/goal/get", { threadId }],
      ],
      (index, result) => {
        if (index === 0) {
          const nativeThread = isObject(result) ? result.thread : null;
          if (!isObject(nativeThread) || nativeThread.id !== threadId)
            throw new Error("thread-identity-mismatch");
          validateThread?.(nativeThread);
        }
      },
    );
    return { thread, goal };
  }

  async request(
    executable: string,
    workspace: string,
    home: string,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const [result] = await this.requestMany(executable, workspace, home, [[method, params]]);
    return result;
  }

  async requestMany(
    executable: string,
    workspace: string,
    home: string,
    calls: Array<[method: string, params: unknown]>,
    validateResult?: (index: number, result: unknown) => void,
  ): Promise<unknown[]> {
    if (this.#closed) throw new Error("Codex app-server reader is closed");
    if (calls.length === 0 || calls.length > 16) throw new Error("invalid-app-server-call-count");
    let session: CodexAppServerSession | undefined;
    try {
      const opened = await CodexAppServerSession.start(
        executable,
        workspace,
        home,
        this.environment,
        undefined,
        (started) => {
          session = started;
          this.#sessions.add(started);
        },
      );
      if (this.#closed) throw new Error("Codex app-server reader is closed");
      const results: unknown[] = [];
      for (const [index, [method, params]] of calls.entries()) {
        const result = await opened.request(method, params);
        validateResult?.(index, result);
        results.push(result);
      }
      return results;
    } finally {
      if (session) {
        try {
          await session.close();
        } finally {
          this.#sessions.delete(session);
        }
      }
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
