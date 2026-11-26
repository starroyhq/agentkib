import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { HISTORY_SEARCH_METHODS, RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { LOCAL_RUNTIME_IDENTITY, LOCAL_RUNTIME_PRESENCE } from "./local-runtime-ipc";
import {
  BACKEND_DEFAULT_MANIFEST,
  BACKEND_INITIALIZE,
  BACKEND_INSPECT,
  BACKEND_PLAN_DISCOVERY,
  BACKEND_PLAN_PROJECT_ASSETS,
  BACKEND_PLAN_WORKSPACE,
  BACKEND_PREFERENCES,
  NATIVE_CONFIGURED_DISCOVERY,
  NATIVE_CONTEXT,
  NATIVE_SCAN_ROOT_DISCOVERY,
} from "./migration";
import { isReparseOrSymlinkAsync } from "./native-files";
import { isSessionOperation } from "./sessions/routing";

export const LOCAL_RUNTIME_TRACE_FILE_BYTES = 256 * 1024;
export const LOCAL_RUNTIME_TRACE_MAX_ACTIVE = 8;
const FILE_COUNT = 4;
const QUEUE_LIMIT = 256;
const BATCH_LIMIT = 64;
const FLUSH_INTERVAL_MS = 250;
const RETRY_INTERVAL_MS = 5_000;
const CLOSE_BUDGET_MS = 500;
const MAX_TIME_MS = 8.64e15;

export interface LocalRuntimeTraceContext {
  method: string;
  operation?: string;
  session?: string;
}

export type LocalRuntimeTraceEvent =
  | ({ kind: "request"; durationMs: number } & LocalRuntimeTraceContext)
  | {
      kind: "stall";
      durationMs: number;
      active: LocalRuntimeTraceContext[];
      activeCount?: number;
    }
  | {
      kind: "sqlite";
      operation: "begin-immediate";
      database: "shared-store" | "managed-ledger";
      waitMs: number;
      outcome: "acquired" | "busy" | "locked";
    }
  | { kind: "runtime"; state: "started" };

export type LocalRuntimeTraceRow = { v: 1; at: number } & (
  | LocalRuntimeTraceEvent
  | { kind: "dropped"; count: number }
);

const traceMethods = new Set<string>([
  ...Object.values(RUNTIME_METHODS),
  ...Object.values(HISTORY_SEARCH_METHODS),
  LOCAL_RUNTIME_IDENTITY,
  LOCAL_RUNTIME_PRESENCE,
  BACKEND_DEFAULT_MANIFEST,
  BACKEND_INITIALIZE,
  BACKEND_INSPECT,
  BACKEND_PLAN_DISCOVERY,
  BACKEND_PLAN_PROJECT_ASSETS,
  BACKEND_PLAN_WORKSPACE,
  BACKEND_PREFERENCES,
  NATIVE_CONFIGURED_DISCOVERY,
  NATIVE_CONTEXT,
  NATIVE_SCAN_ROOT_DISCOVERY,
  "other",
]);

export function isTraceMethod(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && traceMethods.has(value);
}

/** Host catalog reads have no session identity or typed provider operation. */
export function isTraceSessionOperation(value: unknown): value is string {
  return value === "catalog" || isSessionOperation(value);
}

export function localRuntimeTracePaths(dataDir: string): string[] {
  const file = path.join(dataDir, "diagnostics", "runtime-trace.ndjson");
  return Array.from({ length: FILE_COUNT }, (_, index) => (index ? `${file}.${index}` : file));
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function duration(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= MAX_TIME_MS;
}

function context(value: Record<string, unknown> | undefined): LocalRuntimeTraceContext | undefined {
  if (!value || !isTraceMethod(value.method)) return;
  const { method, operation, session } = value;
  return {
    method,
    ...(typeof operation === "string" &&
    operation.length <= 64 &&
    isTraceSessionOperation(operation)
      ? { operation }
      : {}),
    ...(typeof session === "string" && /^[0-9a-f]{16}$/.test(session) ? { session } : {}),
  };
}

function projectEvent(input: unknown): LocalRuntimeTraceEvent | undefined {
  const value = object(input);
  if (!value) return;
  switch (value.kind) {
    case "request": {
      const projected = context(value);
      if (projected && duration(value.durationMs))
        return { kind: "request", durationMs: value.durationMs, ...projected };
      break;
    }
    case "stall": {
      if (!duration(value.durationMs) || !Array.isArray(value.active)) break;
      const active = value.active.slice(0, LOCAL_RUNTIME_TRACE_MAX_ACTIVE).flatMap((item) => {
        const projected = context(object(item));
        return projected ? [projected] : [];
      });
      return {
        kind: "stall",
        durationMs: value.durationMs,
        active,
        ...(counter(value.activeCount) && value.activeCount >= active.length
          ? { activeCount: value.activeCount }
          : {}),
      };
    }
    case "sqlite":
      if (
        value.operation === "begin-immediate" &&
        (value.database === "shared-store" || value.database === "managed-ledger") &&
        (value.outcome === "acquired" || value.outcome === "busy" || value.outcome === "locked") &&
        duration(value.waitMs)
      )
        return {
          kind: "sqlite",
          operation: value.operation,
          database: value.database,
          outcome: value.outcome,
          waitMs: value.waitMs,
        };
      break;
    case "runtime":
      if (value.state === "started") return { kind: "runtime", state: "started" };
  }
}

/** Use the same closed schema when reading rotated files for a diagnostic export. */
export function parseLocalRuntimeTraceRow(input: unknown): LocalRuntimeTraceRow | undefined {
  const value = object(input);
  if (!value || value.v !== 1 || !counter(value.at) || value.at > MAX_TIME_MS) return;
  const row = { v: 1 as const, at: value.at };
  if (value.kind === "dropped" && counter(value.count))
    return { ...row, kind: "dropped", count: value.count };
  const event = projectEvent(value);
  if (event) return { ...row, ...event };
}

function privateTraceFile(stat: Stats) {
  return stat.isFile() && stat.nlink === 1 && privateOwner(stat);
}

function privateOwner(stat: Stats) {
  return !process.getuid || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
}

async function traceFileStat(file: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(file);
    if (!privateTraceFile(stat) || (await isReparseOrSymlinkAsync(file, stat)))
      throw new Error("Invalid runtime trace file");
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** One writer per local runtime. Request handlers enqueue only compact numeric metrics and labels. */
export class LocalRuntimeTrace {
  readonly #paths: string[];
  readonly #queue: LocalRuntimeTraceRow[] = [];
  readonly #shutdown = new AbortController();
  #timer?: ReturnType<typeof setTimeout>;
  #write?: Promise<boolean>;
  #closing?: Promise<void>;
  #closed = false;
  #prepared = false;
  #checkTail = true;
  #dropped = 0;

  constructor(dataDir: string) {
    this.#paths = localRuntimeTracePaths(dataDir);
  }

  record(event: LocalRuntimeTraceEvent): void {
    if (this.#closed) return;
    if (this.#queue.length >= QUEUE_LIMIT && event.kind !== "stall") {
      this.#addDropped(1);
      return;
    }
    const safe = projectEvent(event);
    if (!safe) return;
    if (this.#queue.length >= QUEUE_LIMIT) {
      const nonStall = this.#queue.findIndex(
        (row) => row.kind === "request" || row.kind === "sqlite",
      );
      this.#queue.splice(Math.max(0, nonStall), 1);
      this.#addDropped(1);
    }
    this.#queue.push({ v: 1, at: Date.now(), ...safe });
    this.#schedule(FLUSH_INTERVAL_MS);
  }

  #addDropped(count: number): void {
    this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + count);
  }

  #schedule(delay: number): void {
    if (this.#closed || this.#timer || this.#write || !this.#queue.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#write = this.#flush();
      void this.#write.then((written) => {
        this.#write = undefined;
        this.#schedule(written ? FLUSH_INTERVAL_MS : RETRY_INTERVAL_MS);
      });
    }, delay).unref();
  }

  async #flush(): Promise<boolean> {
    const batch = this.#queue.splice(0, BATCH_LIMIT);
    const dropped = this.#dropped;
    this.#dropped = 0;
    if (dropped) batch.push({ v: 1, at: Date.now(), kind: "dropped", count: dropped });
    try {
      await this.#append(batch.map((row) => `${JSON.stringify(row)}\n`).join(""));
      return true;
    } catch {
      // An inaccessible or full filesystem must not interrupt a live runtime.
      if (!this.#shutdown.signal.aborted)
        this.#addDropped(dropped + batch.length - (dropped ? 1 : 0));
      this.#checkTail = true;
      return false;
    }
  }

  async #append(contents: string): Promise<void> {
    const { signal } = this.#shutdown;
    signal.throwIfAborted();
    const file = this.#paths[0]!;
    const directory = path.dirname(file);
    if (!this.#prepared) await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (!dir.isDirectory() || !privateOwner(dir) || (await isReparseOrSymlinkAsync(directory, dir)))
      throw new Error("Invalid runtime trace directory");
    if (!this.#prepared) {
      for (const item of this.#paths) {
        const stat = await traceFileStat(item);
        signal.throwIfAborted();
        if (stat && stat.size > LOCAL_RUNTIME_TRACE_FILE_BYTES) await unlink(item);
      }
      this.#prepared = true;
    }
    let previous = await traceFileStat(file);
    const bytes = Buffer.byteLength(contents);
    if (previous && previous.size + bytes + 1 > LOCAL_RUNTIME_TRACE_FILE_BYTES) {
      await this.#rotate();
      previous = undefined;
    }
    signal.throwIfAborted();
    const handle = await open(
      file,
      constants.O_APPEND |
        constants.O_RDWR |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0) |
        (previous ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (
        !privateTraceFile(stat) ||
        (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino)) ||
        stat.size + bytes + 1 > LOCAL_RUNTIME_TRACE_FILE_BYTES
      )
        throw new Error("Invalid runtime trace destination");
      if (this.#checkTail && stat.size) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, stat.size - 1);
        if (tail[0] !== 10) contents = `\n${contents}`;
      }
      signal.throwIfAborted();
      await handle.writeFile(contents, "utf8");
      this.#checkTail = false;
    } finally {
      await handle.close();
    }
  }

  async #rotate(): Promise<void> {
    for (let index = this.#paths.length - 1; index >= 0; index--) {
      this.#shutdown.signal.throwIfAborted();
      const file = this.#paths[index]!;
      if (!(await traceFileStat(file))) continue;
      this.#shutdown.signal.throwIfAborted();
      const next = this.#paths[index + 1];
      if (next) await rename(file, next);
      else await unlink(file);
    }
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#finish());
  }

  async #finish(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.#finishWrites(),
        new Promise<void>((resolve) => {
          deadline = setTimeout(() => {
            this.#shutdown.abort();
            resolve();
          }, CLOSE_BUDGET_MS);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      this.#queue.length = 0;
      this.#dropped = 0;
    }
  }

  async #finishWrites(): Promise<void> {
    await this.#write;
    while (!this.#shutdown.signal.aborted && (this.#queue.length || this.#dropped))
      if (!(await this.#flush())) break;
  }
}
