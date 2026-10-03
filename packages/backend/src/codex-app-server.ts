import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import spawn from "cross-spawn";
import { windowsProcessTree, type NativeProcessTree } from "./native-process";

const FRAME_LIMIT = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;

type Response = { id?: unknown; result?: unknown; error?: unknown };

/** A bounded, persistent app-server connection for managed AgentKib sessions. */
export class CodexAppServerSession extends EventEmitter {
  #child: ChildProcess;
  #tree?: NativeProcessTree;
  #pending = new Map<number, (value: Response) => void>();
  #buffer = Buffer.alloc(0);
  #nextId = 0;
  #closed?: Error;
  #closing = false;

  private constructor(child: ChildProcess, tree?: NativeProcessTree) {
    super();
    this.#child = child;
    this.#tree = tree;
    child.stdout?.on("data", (chunk: Buffer) => this.#onData(chunk));
    child.on("error", (error) => this.#fail(error));
    child.stdin?.on("error", (error) => this.#fail(error));
    child.on("close", (code) => {
      this.#fail(new Error(`Codex app-server exited (${code ?? "unknown"})`));
      this.emit("close");
    });
  }

  static async start(
    executable: string,
    workspace: string,
    home: string,
    environment: NodeJS.ProcessEnv,
    onNotification?: (notification: Record<string, unknown>) => void,
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

  async request(method: string, params: unknown, onDispatch?: () => void): Promise<unknown> {
    if (!this.connected) throw this.#closed ?? new Error("Codex app-server is unavailable");
    if (this.#pending.size >= 128) throw new Error("Codex app-server is busy");
    const id = ++this.#nextId;
    if (!Number.isSafeInteger(id)) throw new Error("Codex app-server request limit reached");
    const frame = Buffer.from(JSON.stringify({ id, method, params }) + "\n");
    if (frame.length > FRAME_LIMIT) throw new Error("Codex request exceeds the frame limit");
    const response = new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
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
      if (value.error !== undefined) throw new Error("Codex app-server rejected the request");
      if (!("result" in value)) throw new Error("Codex app-server returned an invalid response");
      return value.result;
    } catch (error) {
      this.#pending.delete(id);
      throw error;
    }
  }

  respond(id: unknown, result: unknown): void {
    this.#write(Buffer.from(JSON.stringify({ id, result }) + "\n"));
  }

  respondError(id: unknown, code: number, message: string): void {
    this.#write(Buffer.from(JSON.stringify({ id, error: { code, message } }) + "\n"));
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.stdin?.end();
      const exited = new Promise<void>((resolve) => this.#child.once("close", () => resolve()));
      await Promise.race([exited, delay(SHUTDOWN_TIMEOUT_MS)]);
      if (this.#child.exitCode === null && this.#child.signalCode === null) {
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
      }
    }
    this.#tree?.close();
    this.#fail(new Error("Codex app-server session closed"));
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short-lived, bounded Codex app-server reader for metadata-only thread requests. */
export class CodexAppServerReader {
  #sessions = new Set<CodexAppServerSession>();
  #closed = false;

  constructor(readonly environment: NodeJS.ProcessEnv) {}

  close(): void {
    this.#closed = true;
    for (const session of this.#sessions) void session.close();
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
    const session = await CodexAppServerSession.start(
      executable,
      workspace,
      home,
      this.environment,
    );
    if (this.#closed) {
      await session.close();
      throw new Error("Codex app-server reader is closed");
    }
    this.#sessions.add(session);
    session.once("close", () => this.#sessions.delete(session));
    try {
      const results: unknown[] = [];
      for (const [index, [method, params]] of calls.entries()) {
        const result = await session.request(method, params);
        validateResult?.(index, result);
        results.push(result);
      }
      return results;
    } finally {
      this.#sessions.delete(session);
      await session.close();
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
