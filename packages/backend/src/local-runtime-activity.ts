import { createHmac, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import {
  isTraceMethod,
  isTraceSessionOperation,
  LOCAL_RUNTIME_TRACE_MAX_ACTIVE,
  LocalRuntimeTrace,
  type LocalRuntimeTraceContext,
} from "./local-runtime-trace";
import { BACKEND_INITIALIZE } from "./migration";
import { isSessionMethod } from "./sessions/routing";
import { observeSqliteLockAcquisition } from "./sqlite-lock-timing";

const HEARTBEAT_MS = 100;
const STALL_THRESHOLD_MS = 2_000;
const STALL_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_REQUESTS = 128;

interface StallSummary {
  count: number;
  longestMs: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value))
    return value as Record<string, unknown>;
}

/** Changed on each runtime launch, so trace exports cannot link a session across runs. */
export class LocalRuntimeActivity {
  #sessionKey = randomBytes(32);
  #active = new Set<LocalRuntimeTraceContext>();
  #stalls: { at: number; durationMs: number }[] = [];
  #activeCount = 0;
  #nextHeartbeat = performance.now() + HEARTBEAT_MS;
  #timer: NodeJS.Timeout;
  #closed = false;

  constructor(private readonly trace: Pick<LocalRuntimeTrace, "record">) {
    this.#timer = setInterval(() => {
      const now = performance.now();
      this.#checkStall(now);
      this.#nextHeartbeat = now + HEARTBEAT_MS;
    }, HEARTBEAT_MS).unref();
  }

  beginRequest(value: unknown): (() => void) | undefined {
    const request = record(value);
    if (request?.jsonrpc === "2.0") return this.begin(request.method, request.params);
  }

  begin(method: unknown, input?: unknown): (() => void) | undefined {
    if (this.#closed || typeof method !== "string") return;
    const started = performance.now();
    this.#checkStall(started);
    const params = record(input);
    const request =
      method === RUNTIME_METHODS.sessionRequest && params && Object.hasOwn(params, "host")
        ? record(record(params.host)?.request)
        : params;
    const name = method.length <= 64 && isTraceMethod(method) ? method : "other";
    const context: LocalRuntimeTraceContext = { method: name };
    const operation = request?.operation;
    if (
      isSessionMethod(name) &&
      typeof operation === "string" &&
      operation.length <= 64 &&
      isTraceSessionOperation(operation)
    )
      context.operation = operation;
    const sessionId = request?.sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256)
      context.session = createHmac("sha256", this.#sessionKey)
        .update(sessionId)
        .digest("hex")
        .slice(0, 16);
    if (this.#active.size < MAX_TRACKED_REQUESTS) this.#active.add(context);
    this.#activeCount++;
    return () => {
      if (this.#closed) return;
      const now = performance.now();
      // A blocking request can complete before Node runs the overdue timer.
      this.#checkStall(now, context);
      this.#active.delete(context);
      this.#activeCount--;
      this.trace.record({ kind: "request", ...context, durationMs: now - started });
    };
  }

  #checkStall(now: number, finishing?: LocalRuntimeTraceContext) {
    const durationMs = now - this.#nextHeartbeat;
    if (durationMs <= STALL_THRESHOLD_MS) return;
    this.#nextHeartbeat = now + HEARTBEAT_MS;
    this.#expireStalls(now);
    this.#stalls.push({ at: now, durationMs });
    const active = finishing ? [finishing] : [];
    for (const context of this.#active) {
      if (active.length >= LOCAL_RUNTIME_TRACE_MAX_ACTIVE) break;
      if (context !== finishing) active.push(context);
    }
    this.trace.record({ kind: "stall", durationMs, active, activeCount: this.#activeCount });
  }

  #expireStalls(now: number) {
    // Each stall restarts the heartbeat, bounding this window without retaining request data.
    while (this.#stalls[0] && now - this.#stalls[0].at > STALL_WINDOW_MS) this.#stalls.shift();
  }

  recentStalls(): StallSummary {
    this.#expireStalls(performance.now());
    return {
      count: this.#stalls.length,
      longestMs: this.#stalls.reduce((longest, stall) => Math.max(longest, stall.durationMs), 0),
    };
  }

  close() {
    if (this.#closed) return;
    this.#checkStall(performance.now());
    this.#closed = true;
    clearInterval(this.#timer);
    this.#active.clear();
  }
}

let runtimeActivity: LocalRuntimeActivity | undefined;

export function recentLocalRuntimeStalls(): StallSummary {
  return runtimeActivity?.recentStalls() ?? { count: 0, longestMs: 0 };
}

export function startLocalRuntimeDiagnostics(dataDir: string) {
  const trace = new LocalRuntimeTrace(dataDir);
  const activity = new LocalRuntimeActivity(trace);
  runtimeActivity = activity;
  const stopSqliteTrace = observeSqliteLockAcquisition((event) => trace.record(event));
  trace.record({ kind: "runtime", state: "started" });
  return {
    activity,
    close() {
      activity.close();
      if (runtimeActivity === activity) runtimeActivity = undefined;
      stopSqliteTrace();
      return trace.close().catch(() => undefined);
    },
  };
}

/** The attached backend learns its profile directory in the first initialize request. */
export function initializeLocalRuntimeDiagnostics(value: unknown) {
  const request = record(value);
  if (request?.jsonrpc !== "2.0" || request.method !== BACKEND_INITIALIZE) return;
  const dataDir = record(request.params)?.dataDir;
  if (typeof dataDir === "string" && isAbsolute(dataDir))
    return startLocalRuntimeDiagnostics(dataDir);
}
