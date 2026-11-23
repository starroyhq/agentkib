import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { acpObject, parseAcpJson, stringifyAcpJson } from "../../acp-json";
import { windowsProcessTree, type NativeProcessTree } from "../../native-process";
import { hasText } from "../../session-events";
import { versionAtLeast } from "../../native-version";

export const MAX_ACP_FRAME_BYTES = 1024 * 1024;
export type AcpId = bigint | string;
/** An MCP server the client offers to one ACP session, for example a host's own tools. */
export interface AcpMcpServer {
  type: "http";
  name: string;
  url: string;
  headers: { name: string; value: string }[];
}
export class AcpUndispatchedError extends Error {
  constructor(reason = "session-compacting") {
    super(reason);
  }
}
export interface AcpCompatibility {
  loadSession: boolean;
  listSessions: boolean;
  resumeSession: boolean;
}
export interface AcpPermission {
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: { optionId: string; name: string; kind: string }[];
}
export type AcpEvent =
  | {
      type: "response";
      id: AcpId;
      method: string;
      result?: unknown;
      error?: { code: bigint; message: string; data?: unknown };
    }
  | { type: "session-update"; sessionId: string; update: Record<string, unknown> }
  | { type: "permission"; id: AcpId; request: AcpPermission }
  | { type: "permission-cancelled"; id: AcpId; sessionId: string }
  | { type: "unsupported-request"; id: AcpId; method: string }
  | { type: "notification"; method: string; params: unknown };
const closedError = () => new Error("ACP connection is closed or unusable");
const timeoutError = () =>
  new Error("ACP operation timed out; completion is unknown and the client must be closed");
function id(value: unknown): AcpId {
  if (typeof value === "string") return value;
  if (typeof value === "bigint" && value >= -9223372036854775808n && value <= 9223372036854775807n)
    return value;
  throw new Error("ACP protocol error: invalid RPC id");
}
function sessionId(value: string): void {
  if (!value || Buffer.byteLength(value) > 4096) throw new Error("Invalid ACP session id");
}
function absolute(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("ACP cwd must be absolute");
  return value;
}
export function acpCompatibility(value: unknown): AcpCompatibility {
  const result = acpObject(value);
  if (result.protocolVersion !== 1n)
    throw new Error("Unsupported ACP protocol version (requires ACP v1)");
  const caps = acpObject(result.agentCapabilities),
    sessions = caps.sessionCapabilities;
  const object = (value: unknown) =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  return {
    loadSession: caps.loadSession === true,
    listSessions: object(sessions) && object((sessions as Record<string, unknown>).list),
    resumeSession: object(sessions) && object((sessions as Record<string, unknown>).resume),
  };
}
export function verifyAcpControlIdentity(value: unknown): void {
  const agent = acpObject(acpObject(value).agentInfo);
  const version =
    typeof agent.version === "string"
      ? /^agy_acp_server_(\d+\.\d+\.\d+)$/.exec(agent.version)?.[1]
      : undefined;
  if (agent.name !== "antigravity-acp" || !version || !versionAtLeast(version, "1.1.1"))
    throw new Error("Unverified Antigravity ACP server identity or version");
}

type CompactionRecord = {
  compactionId: string;
  position: number;
  status: string;
  terminal: boolean;
  summary?: Record<string, unknown>[] | null;
  chunks: Record<string, unknown>[];
  error?: string | null;
  _meta?: Record<string, unknown> | null;
};
const compactionTerminal = new Set(["completed", "failed", "cancelled"]);

/** Preview v1 extension: omitted fields are patches; first receipt fixes timeline position. */
export class AcpCompactionState {
  #records = new Map<string, CompactionRecord>();
  #nextPosition = 0;
  get active(): boolean {
    return [...this.#records.values()].some((record) => !record.terminal);
  }
  snapshot(): CompactionRecord[] {
    return structuredClone([...this.#records.values()]);
  }
  isTerminal(id: string): boolean {
    return this.#records.get(id)?.terminal === true;
  }
  apply(update: Record<string, unknown>): boolean {
    const position = this.#nextPosition++;
    const kind = update.sessionUpdate;
    if (kind !== "compaction_update" && kind !== "compaction_summary_chunk") return false;
    const id = update.compactionId;
    if (typeof id !== "string" || !id.trim() || Buffer.byteLength(id) > 256)
      throw new Error("Invalid ACP compaction ID");
    const previous = this.#records.get(id);
    if (kind === "compaction_summary_chunk") {
      if (!previous || previous.terminal || previous.status !== "in_progress")
        throw new Error("ACP compaction summary chunk outside active compaction");
      const chunk = {
        content: this.#content(update.content),
        ...(Object.hasOwn(update, "_meta") ? { _meta: this.#meta(update._meta) } : {}),
      };
      const next = { ...previous, chunks: [...previous.chunks, chunk] };
      this.#save(id, next);
      return true;
    }
    if (typeof update.status !== "string" || !update.status || update.status.length > 128)
      throw new Error("Invalid ACP compaction status");
    if (previous?.terminal && update.status === "in_progress")
      throw new Error("ACP compaction ID reused after completion");
    const next: CompactionRecord = previous
      ? structuredClone(previous)
      : { compactionId: id, position, status: update.status, terminal: false, chunks: [] };
    next.status = update.status;
    // Unknown future statuses cannot terminate an active compaction.
    next.terminal = next.terminal || compactionTerminal.has(update.status);
    if (Object.hasOwn(update, "summary")) {
      if (update.summary !== null && !Array.isArray(update.summary))
        throw new Error("Invalid ACP compaction summary");
      if (Array.isArray(update.summary) && update.summary.length && update.status !== "completed")
        throw new Error("ACP compaction summary is only valid on completion");
      next.summary =
        update.summary === null ? null : update.summary.map((block) => this.#content(block));
      next.chunks = [];
    }
    if (Object.hasOwn(update, "error")) {
      if (update.error !== null && typeof update.error !== "string")
        throw new Error("Invalid ACP compaction error");
      if (typeof update.error === "string" && update.status !== "failed")
        throw new Error("ACP compaction error is only valid on failure");
      next.error = update.error;
    }
    if (Object.hasOwn(update, "_meta")) {
      next._meta = this.#meta(update._meta);
    }
    this.#save(id, next);
    return true;
  }
  #meta(value: unknown): Record<string, unknown> | null {
    if (value !== null && (typeof value !== "object" || Array.isArray(value)))
      throw new Error("Invalid ACP compaction metadata");
    return value === null ? null : (structuredClone(value) as Record<string, unknown>);
  }
  #content(value: unknown): Record<string, unknown> {
    const block = acpObject(value);
    if (
      typeof block.type !== "string" ||
      !block.type ||
      (block.type === "text" && typeof block.text !== "string")
    )
      throw new Error("Invalid ACP compaction content block");
    return structuredClone(block);
  }
  #save(id: string, record: CompactionRecord): void {
    if (!this.#records.has(id) && this.#records.size >= 1024)
      throw new Error("ACP compaction history limit exceeded");
    const records = [...this.#records.values()].filter((entry) => entry.compactionId !== id);
    records.push(record);
    if (record.chunks.length > 4096 || Buffer.byteLength(stringifyAcpJson(records)) > 1024 * 1024)
      throw new Error("ACP compaction content limit exceeded");
    this.#records.set(id, record);
  }
}
/** Pull-based framed I/O applies stream backpressure while commands remain independently writable. */
export class AntigravityAcp {
  #closed = false;
  #fatal: Error | null = null;
  #initialized = false;
  #compatibility: AcpCompatibility | null = null;
  #nextId = 1n;
  #pending = new Map<AcpId, { method: string; sessionId: string | null }>();
  #permissions = new Map<AcpId, AcpPermission>();
  #sessions = new Set<string>();
  #active = new Set<string>();
  #cancelled = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #operationDeadline = Infinity;
  #reading = false;
  #frame: Buffer[] = [];
  #frameBytes = 0;
  #buffer: Buffer = Buffer.alloc(0);
  #child?: ChildProcess;
  #tree?: NativeProcessTree;
  constructor(
    readonly reader: Readable,
    readonly writer: Writable,
    readonly options: { timeout?: number; deadline?: number; version?: string } = {},
  ) {
    if (
      !(options.timeout === undefined || (Number.isFinite(options.timeout) && options.timeout > 0))
    )
      throw new Error("ACP timeout must be positive");
    if (options.deadline !== undefined && !Number.isFinite(options.deadline))
      throw new Error("Invalid ACP deadline");
    reader.on("error", (error) => this.#poison(error));
    writer.on("error", (error) => this.#poison(error));
  }
  static spawn(
    executable: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    options: { timeout?: number; deadline?: number; version?: string } = {},
  ): AntigravityAcp {
    if (!path.isAbsolute(executable) || !path.isAbsolute(cwd))
      throw new Error("ACP executable and cwd must be absolute");
    if (
      options.timeout !== undefined &&
      (!Number.isFinite(options.timeout) || options.timeout <= 0)
    )
      throw new Error("ACP timeout must be positive");
    if (options.deadline !== undefined && !Number.isFinite(options.deadline))
      throw new Error("Invalid ACP deadline");
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const client = new AntigravityAcp(child.stdout!, child.stdin!, options);
    client.#child = child;
    child.on("error", (error) => client.#poison(error));
    if (process.platform === "win32" && child.pid) {
      try {
        client.#tree = windowsProcessTree(child.pid);
      } catch (error) {
        client.#poison(error as Error);
      }
    }
    return client;
  }
  get compatibility(): AcpCompatibility | null {
    return this.#compatibility;
  }
  initialize(): Promise<AcpId> {
    return this.#serialize(async () => {
      if (this.#initialized) throw new Error("ACP initialize already sent");
      this.#initialized = true;
      return this.#request(
        "initialize",
        {
          protocolVersion: 1n,
          clientCapabilities: { session: { compaction: {} } },
          clientInfo: { name: "agentkib", version: this.options.version ?? "0.13.0" },
        },
        null,
      );
    });
  }
  listSessions(cwd: string | null, cursor: string | null): Promise<AcpId> {
    return this.#serialize(() => {
      if (!this.#ready().listSessions)
        throw new Error("ACP capability is not supported: session/list");
      return this.#request(
        "session/list",
        { ...(cwd === null ? {} : { cwd: absolute(cwd) }), ...(cursor === null ? {} : { cursor }) },
        null,
      );
    });
  }
  newSession(cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpId> {
    return this.#serialize(() => {
      this.#ready();
      return this.#request("session/new", { cwd: absolute(cwd), mcpServers }, null);
    });
  }
  loadSession(value: string, cwd: string, mcpServers: AcpMcpServer[] = []): Promise<AcpId> {
    return this.#attach("session/load", value, cwd, mcpServers);
  }
  resumeSession(value: string, cwd: string): Promise<AcpId> {
    return this.#attach("session/resume", value, cwd);
  }
  #attach(
    method: "session/load" | "session/resume",
    value: string,
    cwd: string,
    mcpServers: AcpMcpServer[] = [],
  ): Promise<AcpId> {
    return this.#serialize(() => {
      const compatibility = this.#ready();
      if (!(method === "session/load" ? compatibility.loadSession : compatibility.resumeSession))
        throw new Error(`ACP capability is not supported: ${method}`);
      sessionId(value);
      if (this.#active.has(value)) throw new Error("ACP session has an active turn");
      return this.#request(method, { sessionId: value, cwd: absolute(cwd), mcpServers }, value);
    });
  }
  /** Sets one of the session's own options (`configOptions`), such as its mode or model. */
  setConfigOption(value: string, configId: string, option: string): Promise<AcpId> {
    return this.#serialize(() => {
      this.#ready();
      if (!this.#sessions.has(value)) throw new Error("ACP session is not attached");
      if (this.#active.has(value)) throw new Error("ACP session has an active turn");
      return this.#request(
        "session/set_config_option",
        { sessionId: value, configId, value: option },
        value,
      );
    });
  }
  prompt(value: string, text: string, beforeDispatch?: () => void): Promise<AcpId> {
    return this.#serialize(async () => {
      this.#ready();
      if (!this.#sessions.has(value)) throw new Error("ACP session is not attached");
      if (this.#active.has(value)) throw new Error("ACP session has an active turn");
      if (!hasText(text) || Buffer.byteLength(text) > 65536)
        throw new Error("ACP prompt must be 1–65536 bytes");
      beforeDispatch?.();
      const request = await this.#request(
        "session/prompt",
        { sessionId: value, prompt: [{ type: "text", text }] },
        value,
      );
      this.#cancelled.delete(value);
      this.#active.add(value);
      return request;
    });
  }
  cancel(value: string): Promise<void> {
    return this.#serialize(async () => {
      this.#ready();
      if (!this.#active.has(value)) throw new Error("ACP session has no active turn");
      await this.#write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: value } });
      this.#cancelled.add(value);
      for (const [id, permission] of this.#permissions)
        if (permission.sessionId === value) await this.#respondPermission(id, null);
    });
  }
  respondPermission(value: AcpId, option: string | null): Promise<void> {
    return this.#serialize(() => this.#respondPermission(value, option));
  }
  async #respondPermission(value: AcpId, option: string | null): Promise<void> {
    this.#ready();
    const permission = this.#permissions.get(value);
    if (!permission) throw new Error("ACP permission request is no longer pending");
    if (
      option !== null &&
      (this.#cancelled.has(permission.sessionId) ||
        !permission.options.some((item) => item.optionId === option))
    )
      throw new Error("ACP permission option is not available");
    await this.#write({
      jsonrpc: "2.0",
      id: value,
      result: {
        outcome:
          option === null ? { outcome: "cancelled" } : { outcome: "selected", optionId: option },
      },
    });
    this.#permissions.delete(value);
  }
  async nextEvent(timeout = this.options.timeout ?? 10_000): Promise<AcpEvent | null> {
    if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid ACP event timeout");
    if (this.#reading) throw new Error("ACP event stream already has a consumer");
    this.#check();
    this.#reading = true;
    try {
      const frame = await this.#readFrame(
        Math.min(performance.now() + timeout, this.options.deadline ?? Infinity),
      );
      if (frame === null) return null;
      return await this.#serialize(() => this.#event(acpObject(parseAcpJson(frame))), true);
    } catch (error) {
      this.#poison(error as Error);
      throw error;
    } finally {
      this.#reading = false;
    }
  }
  async #event(value: Record<string, unknown>): Promise<AcpEvent> {
    if (value.jsonrpc !== "2.0")
      throw new Error("ACP protocol error: expected JSON-RPC 2.0 object");
    if (Object.hasOwn(value, "method")) {
      if (
        typeof value.method !== "string" ||
        Object.hasOwn(value, "result") ||
        Object.hasOwn(value, "error")
      )
        throw new Error("ACP protocol error: invalid request");
      const method = value.method,
        params = Object.hasOwn(value, "params") ? value.params : {};
      if (Object.hasOwn(value, "id")) {
        const request = id(value.id);
        if (method === "session/request_permission")
          return this.#permission(request, acpObject(params));
        await this.#write({
          jsonrpc: "2.0",
          id: request,
          error: { code: -32601n, message: "Unsupported client method" },
        });
        return { type: "unsupported-request", id: request, method };
      }
      if (method === "session/update") {
        const fields = acpObject(params),
          update = acpObject(fields.update);
        if (typeof fields.sessionId !== "string" || typeof update.sessionUpdate !== "string")
          throw new Error("ACP protocol error: invalid session update");
        if (
          !this.#sessions.has(fields.sessionId) &&
          ![...this.#pending.values()].some(
            (pending) =>
              // Devin announces a new session's commands before it answers session/new.
              pending.method === "session/new" ||
              (["session/load", "session/resume"].includes(pending.method) &&
                pending.sessionId === fields.sessionId),
          )
        )
          throw new Error("ACP protocol error: update for unattached session");
        return { type: "session-update", sessionId: fields.sessionId, update };
      }
      return { type: "notification", method, params };
    }
    const responseId = id(value.id),
      pending = this.#pending.get(responseId);
    if (!pending) throw new Error("ACP protocol error: response id is not pending");
    this.#pending.delete(responseId);
    const hasResult = Object.hasOwn(value, "result"),
      hasError = Object.hasOwn(value, "error");
    if (hasResult === hasError)
      throw new Error("ACP protocol error: response must contain result or error");
    let error: Extract<AcpEvent, { type: "response" }>["error"];
    if (hasError) {
      const fields = acpObject(value.error),
        code = id(fields.code);
      if (typeof code !== "bigint" || typeof fields.message !== "string")
        throw new Error("ACP protocol error: invalid RPC error");
      error = {
        code,
        message: fields.message,
        ...(fields.data === null || fields.data === undefined ? {} : { data: fields.data }),
      };
    }
    if (pending.method === "session/prompt" && pending.sessionId !== null) {
      this.#active.delete(pending.sessionId);
      for (const [id, permission] of this.#permissions)
        if (permission.sessionId === pending.sessionId) await this.#respondPermission(id, null);
    }
    if (hasResult) {
      if (pending.method === "initialize") this.#compatibility = acpCompatibility(value.result);
      else if (pending.method === "session/new") {
        const fields = acpObject(value.result);
        if (typeof fields.sessionId !== "string")
          throw new Error("ACP protocol error: new session missing id");
        sessionId(fields.sessionId);
        this.#sessions.add(fields.sessionId);
      } else if (
        ["session/load", "session/resume"].includes(pending.method) &&
        pending.sessionId !== null
      )
        this.#sessions.add(pending.sessionId);
    }
    return {
      type: "response",
      id: responseId,
      method: pending.method,
      ...(hasResult ? { result: value.result } : { error }),
    };
  }
  async #permission(requestId: AcpId, fields: Record<string, unknown>): Promise<AcpEvent> {
    this.#ready();
    const toolCall = acpObject(fields.toolCall);
    if (
      typeof fields.sessionId !== "string" ||
      typeof toolCall.toolCallId !== "string" ||
      !Array.isArray(fields.options) ||
      !fields.options.length
    )
      throw new Error("ACP protocol error: invalid permission request");
    const seen = new Set<string>();
    const options = fields.options.map((value) => {
      const fields = acpObject(value);
      if (
        typeof fields.optionId !== "string" ||
        !fields.optionId ||
        typeof fields.name !== "string" ||
        typeof fields.kind !== "string" ||
        seen.has(fields.optionId)
      )
        throw new Error("ACP protocol error: invalid permission options");
      seen.add(fields.optionId);
      return { optionId: fields.optionId, name: fields.name, kind: fields.kind };
    });
    if (this.#permissions.has(requestId) || this.#permissions.size >= 128)
      throw new Error("ACP protocol error: duplicate or too many permission requests");
    if (!this.#active.has(fields.sessionId) || this.#cancelled.has(fields.sessionId)) {
      await this.#write({
        jsonrpc: "2.0",
        id: requestId,
        result: { outcome: { outcome: "cancelled" } },
      });
      return { type: "permission-cancelled", id: requestId, sessionId: fields.sessionId };
    }
    const request = { sessionId: fields.sessionId, toolCall, options };
    this.#permissions.set(requestId, request);
    return { type: "permission", id: requestId, request };
  }
  #check(): void {
    if (this.#closed) throw this.#fatal ?? closedError();
  }
  #ready(): AcpCompatibility {
    this.#check();
    if (!this.#compatibility) throw new Error("ACP initialize has not succeeded");
    return this.#compatibility;
  }
  async #request(method: string, params: unknown, session: string | null): Promise<AcpId> {
    if (this.#pending.size >= 128) throw new Error("Too many outstanding ACP requests");
    const request = this.#nextId;
    if (request === 9223372036854775807n) throw new Error("ACP request id exhausted");
    this.#nextId++;
    await this.#write({ jsonrpc: "2.0", id: request, method, params });
    this.#pending.set(request, { method, sessionId: session });
    return request;
  }
  #serialize<T>(operation: () => T | Promise<T>, event = false): Promise<T> {
    if (!event && this.#queued >= 32) return Promise.reject(new Error("ACP command queue is full"));
    if (!event) this.#queued++;
    const deadline = Math.min(
      performance.now() + (this.options.timeout ?? 10_000),
      this.options.deadline ?? Infinity,
    );
    const task = this.#tail.then(async () => {
      this.#check();
      if (performance.now() >= deadline) {
        const error = timeoutError();
        this.#poison(error);
        throw error;
      }
      this.#operationDeadline = deadline;
      try {
        return await operation();
      } finally {
        this.#operationDeadline = Infinity;
      }
    });
    this.#tail = task
      .finally(() => {
        if (!event) this.#queued--;
      })
      .catch(() => {});
    return task;
  }
  async #write(value: unknown): Promise<void> {
    this.#check();
    const bytes = Buffer.from(stringifyAcpJson(value) + "\n");
    if (bytes.length > MAX_ACP_FRAME_BYTES) throw new Error("Outgoing ACP frame exceeds limit");
    const remaining = Math.min(
      this.options.timeout ?? 10_000,
      (this.options.deadline ?? Infinity) - performance.now(),
      this.#operationDeadline - performance.now(),
    );
    if (remaining <= 0) {
      const error = timeoutError();
      this.#poison(error);
      throw error;
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            const error = timeoutError();
            this.#poison(error);
            reject(error);
          },
          Math.max(0, remaining),
        );
        this.writer.write(bytes, (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      });
      this.#check();
    } catch (error) {
      this.#poison(error as Error);
      throw error;
    }
  }
  async #readFrame(deadline: number): Promise<Buffer | null> {
    while (true) {
      this.#check();
      if (performance.now() >= deadline) {
        if (this.options.deadline !== undefined && performance.now() >= this.options.deadline)
          throw timeoutError();
        return null;
      }
      if (!this.#buffer.length) {
        const data = this.reader.read() as Buffer | null;
        if (data === null) {
          if (this.reader.readableEnded || this.reader.destroyed) throw closedError();
          const arrived = await new Promise<boolean>((resolve, reject) => {
            const finish = (result: boolean, error?: Error) => {
              clearTimeout(timer);
              this.reader.off("readable", readable);
              this.reader.off("end", end);
              this.reader.off("close", end);
              this.reader.off("error", failed);
              if (error) reject(error);
              else resolve(result);
            };
            const readable = () => finish(true),
              end = () => finish(true),
              failed = (error: Error) => finish(false, error);
            const timer = setTimeout(
              () => finish(false),
              Math.max(0, deadline - performance.now()),
            );
            this.reader.once("readable", readable);
            this.reader.once("end", end);
            this.reader.once("close", end);
            this.reader.once("error", failed);
          });
          if (!arrived) continue;
          continue;
        }
        this.#buffer = data;
      }
      const newline = this.#buffer.indexOf(10),
        count = newline < 0 ? this.#buffer.length : newline + 1;
      if (this.#frameBytes + count > MAX_ACP_FRAME_BYTES)
        throw new Error("ACP frame exceeds limit");
      this.#frame.push(this.#buffer.subarray(0, count));
      this.#frameBytes += count;
      this.#buffer = this.#buffer.subarray(count);
      if (newline >= 0) {
        const frame = Buffer.concat(this.#frame, this.#frameBytes);
        this.#frame = [];
        this.#frameBytes = 0;
        return frame;
      }
    }
  }
  #poison(error: Error): void {
    if (this.#closed) return;
    this.#fatal = error;
    this.shutdown();
  }
  shutdown(): void {
    this.#closed = true;
    this.#permissions.clear();
    this.#pending.clear();
    this.writer.destroy();
    this.reader.destroy();
    if (this.#tree) {
      this.#tree.terminate();
      this.#tree.close();
      this.#tree = undefined;
    } else if (this.#child?.pid) {
      try {
        if (process.platform !== "win32") process.kill(-this.#child.pid, "SIGKILL");
        else this.#child.kill("SIGKILL");
      } catch {
        this.#child.kill("SIGKILL");
      }
    }
  }
}
