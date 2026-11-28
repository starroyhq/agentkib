import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  HISTORY_SEARCH_METHODS,
  REMOTE_ERROR_CODES,
  REMOTE_MANAGED_ACTION_OPERATIONS,
  REMOTE_ROUTE,
  RUNTIME_METHODS,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";
import { LOCAL_RUNTIME_IDENTITY, LOCAL_RUNTIME_PRESENCE } from "./local-runtime-ipc";
import { acquirePortableFileLease } from "./managed-session-lock";
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
export const LOCAL_RUNTIME_TRACE_HOST_METHOD = "host.request";
export const LOCAL_RUNTIME_TRACE_REPORT_METHOD = "orchestration.report";
const FILE_COUNT = 4;
const QUEUE_LIMIT = 256;
const BATCH_LIMIT = 64;
const FLUSH_INTERVAL_MS = 250;
const RETRY_INTERVAL_MS = 5_000;
const LEASE_RETRY_MS = 15;
const LEASE_RETRY_LIMIT = 10;
const CLOSE_BUDGET_MS = 500;
const MAX_TIME_MS = 8.64e15;

export interface LocalRuntimeTraceContext {
  method: string;
  operation?: string;
  session?: string;
}

const traceStages = [
  "runtime-dispatch",
  "host-admission",
  "host-dispatch",
  "host-response",
  "report-delivery",
  "report-availability",
  "report-route",
  "report-enqueue",
  "report-confirmation",
] as const;

export type LocalRuntimeTraceStage = (typeof traceStages)[number];
export type LocalRuntimeTraceResult = { stage: LocalRuntimeTraceStage } & (
  | { outcome: "completed" | "accepted"; reason?: never }
  | {
      outcome: "refused" | "failed" | "unknown" | "cancelled" | "partial";
      reason: RemoteErrorCode;
    }
);

const pushOperations = ["alert", "start", "update", "end"] as const;
const pushRefusalReasons = [
  "account_login_required",
  "activity_unknown",
  "http_400",
  "http_403",
  "http_413",
  "http_429",
  "http_5xx",
  "invalid_collapse_id",
  "invalid_content_state",
  "invalid_date",
  "invalid_envelope",
  "invalid_event",
  "invalid_kind",
  "invalid_session",
  "payload_too_large",
  "push_rejected",
  "push_target_gone",
  "push_target_unavailable",
  "push_throttled",
  "push_unavailable",
  "relay_unavailable",
  "relay_unreachable",
  "request_failed",
] as const;
const pushSkipReasons = [
  "activity_cooldown",
  "activity_delay",
  "activity_not_subscribed",
  "activity_token_lost",
  "activity_token_unconfirmed",
  "device_unavailable",
  "no_active_sessions",
  "no_push_targets",
  "notification_disabled",
  "quiet_hours",
  "snapshot_stale",
  "snapshot_unavailable",
] as const;
type PushTraceOperation = (typeof pushOperations)[number];
type PushRefusalReason = (typeof pushRefusalReasons)[number];
export type PushSkipReason = (typeof pushSkipReasons)[number];
export type LocalPushTraceEvent = { kind: "push"; count: number } & (
  | { operation: PushTraceOperation; outcome: "delivered" }
  | {
      operation: PushTraceOperation;
      outcome: "refused" | "unconfirmed";
      reason: PushRefusalReason;
      retryAt?: number;
    }
  | { operation: "start"; outcome: "skipped"; reason: PushSkipReason; retryAt?: number }
);

export function localPushRefusalReason(value: unknown): PushRefusalReason {
  if (typeof value === "string" && /^http_5\d\d$/.test(value)) return "http_5xx";
  return pushRefusalReasons.find((reason) => reason === value) ?? "request_failed";
}

export type LocalRuntimeTraceEvent =
  | ({ kind: "request"; durationMs: number } & LocalRuntimeTraceContext &
      (LocalRuntimeTraceResult | { stage?: never; outcome?: never; reason?: never }))
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
  | { kind: "runtime"; state: "started" }
  | LocalPushTraceEvent;

export type LocalRuntimeTraceRow = { v: 1; at: number } & (
  | LocalRuntimeTraceEvent
  | { kind: "dropped"; count: number }
);

const traceMethods = new Set<string>([
  ...Object.values(RUNTIME_METHODS),
  ...Object.values(HISTORY_SEARCH_METHODS),
  LOCAL_RUNTIME_IDENTITY,
  LOCAL_RUNTIME_PRESENCE,
  LOCAL_RUNTIME_TRACE_HOST_METHOD,
  LOCAL_RUNTIME_TRACE_REPORT_METHOD,
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

const traceSessionOperations = new Set<string>([
  ...REMOTE_MANAGED_ACTION_OPERATIONS,
  "approval-audit-expired",
  "approval-audit-list",
  "catalog",
  "catalog-scope",
  "context",
  "desktop-events",
  "devin-create",
  "devin-options",
  "devin-terminal",
  "diff",
  "dsh-create",
  "dsh-options",
  "events",
  "goal",
  "provider-create",
  "provider-options",
  "provider-validate-control",
  "provider-workspace-resources",
  "read-state",
  "read-state-update",
  "resources",
  "resume-command",
  "session-directory",
  "session-image",
  "session-pin",
  "session-pin-set",
  "subagent-events",
  "subagents",
]);
const traceHostRoutes = new Set([...Object.keys(REMOTE_ROUTE), "other"]);
const traceReasons = new Map<string, RemoteErrorCode>(
  Object.values(REMOTE_ERROR_CODES).map((code) => [code, code]),
);

export function isTraceMethod(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && traceMethods.has(value);
}

/** Runtime dispatch includes fixed host operations as well as provider operations. */
export function isTraceSessionOperation(value: unknown): value is string {
  return (
    typeof value === "string" && (traceSessionOperations.has(value) || isSessionOperation(value))
  );
}

export function isTraceHostOperation(value: unknown): value is string {
  return (
    typeof value === "string" && (traceHostRoutes.has(value) || isTraceSessionOperation(value))
  );
}

export function localRuntimeTraceReason(value: unknown): RemoteErrorCode | undefined {
  return typeof value === "string" ? traceReasons.get(value) : undefined;
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
  const isOperation =
    method === LOCAL_RUNTIME_TRACE_HOST_METHOD ? isTraceHostOperation : isTraceSessionOperation;
  return {
    method,
    ...(isOperation(operation) ? { operation } : {}),
    ...(typeof session === "string" && /^[0-9a-f]{16}$/.test(session) ? { session } : {}),
  };
}

function projectResult(value: Record<string, unknown>): LocalRuntimeTraceResult | undefined {
  const stage = traceStages.find((candidate) => candidate === value.stage);
  if (!stage) return;
  const { outcome } = value;
  switch (outcome) {
    case "completed":
    case "accepted":
      return { stage, outcome };
    case "refused":
    case "failed":
    case "unknown":
    case "cancelled":
    case "partial":
      return {
        stage,
        outcome,
        reason: localRuntimeTraceReason(value.reason) ?? REMOTE_ERROR_CODES.requestFailed,
      };
  }
}

function projectEvent(input: unknown): LocalRuntimeTraceEvent | undefined {
  const value = object(input);
  if (!value) return;
  switch (value.kind) {
    case "request": {
      const projected = context(value);
      if (!projected || !duration(value.durationMs)) break;
      const base = { kind: "request" as const, durationMs: value.durationMs, ...projected };
      const result = projectResult(value);
      if (result) {
        delete base.session;
        return { ...base, ...result };
      }
      if (value.stage !== undefined || value.outcome !== undefined || value.reason !== undefined)
        break;
      // Read legacy timing-only request rows.
      return base;
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
      break;
    case "push": {
      const operation = pushOperations.find((entry) => entry === value.operation);
      if (!operation || !counter(value.count) || !value.count) break;
      const base = { kind: "push" as const, count: value.count };
      const retry =
        counter(value.retryAt) && value.retryAt <= MAX_TIME_MS ? { retryAt: value.retryAt } : {};
      if (value.outcome === "delivered") return { ...base, operation, outcome: value.outcome };
      if (value.outcome === "refused" || value.outcome === "unconfirmed")
        return {
          ...base,
          operation,
          outcome: value.outcome,
          reason: localPushRefusalReason(value.reason),
          ...retry,
        };
      if (value.outcome === "skipped" && operation === "start") {
        const reason = pushSkipReasons.find((entry) => entry === value.reason);
        if (reason) return { ...base, operation, outcome: value.outcome, reason, ...retry };
      }
      break;
    }
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

async function traceDirectoryStat(directory: string): Promise<Stats> {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    !privateOwner(stat) ||
    (await isReparseOrSymlinkAsync(directory, stat))
  ) {
    throw new Error("Invalid runtime trace directory");
  }
  return stat;
}

async function acquireTraceLease(file: string, signal: AbortSignal): Promise<() => void> {
  for (let attempt = 0; ; attempt++) {
    // Refuse unexpected owners, permissions, links and special files before the lease opens it.
    await traceFileStat(file);
    signal.throwIfAborted();
    try {
      return acquirePortableFileLease(file);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "session-managed-by-another-runtime" ||
        attempt >= LEASE_RETRY_LIMIT
      ) {
        throw error;
      }
      await delay(LEASE_RETRY_MS, undefined, { signal, ref: false });
    }
  }
}

/** The host and runtime share one rotation. Request handlers only enqueue compact metadata. */
export class LocalRuntimeTrace {
  readonly #paths: string[];
  readonly #queue: LocalRuntimeTraceRow[] = [];
  readonly #shutdown = new AbortController();
  #timer?: ReturnType<typeof setTimeout>;
  #write?: Promise<boolean>;
  #closing?: Promise<void>;
  #closed = false;
  #prepared = false;
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
        (row) => row.kind === "request" || row.kind === "sqlite" || row.kind === "push",
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
      return false;
    }
  }

  async #append(contents: string): Promise<void> {
    const { signal } = this.#shutdown;
    signal.throwIfAborted();
    const file = this.#paths[0]!;
    const directory = path.dirname(file);
    if (!this.#prepared) await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await traceDirectoryStat(directory);
    const lease = path.join(directory, "runtime-trace.lock");
    const release = await acquireTraceLease(lease, signal);
    try {
      const lockedDir = await traceDirectoryStat(directory);
      if (dir.dev !== lockedDir.dev || dir.ino !== lockedDir.ino || !(await traceFileStat(lease)))
        throw new Error("Invalid runtime trace lease");
      await this.#appendWithLease(file, contents);
    } finally {
      release();
    }
  }

  async #appendWithLease(file: string, contents: string): Promise<void> {
    const { signal } = this.#shutdown;
    signal.throwIfAborted();
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
      // The other writer could have stopped in the middle of its last record.
      if (stat.size) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, stat.size - 1);
        if (tail[0] !== 10) contents = `\n${contents}`;
      }
      signal.throwIfAborted();
      await handle.writeFile(contents, "utf8");
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
