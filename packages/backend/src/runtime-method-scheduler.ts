import { randomUUID } from "node:crypto";
import { recordLocalRuntimeTrace } from "./local-runtime-activity";
import type { RuntimeReadDeadlineTrace } from "./local-runtime-trace";
import { BackendTaskError, TaskAdmissionError, TaskContext, runWithTask } from "./task-executor";

export type RuntimeMethodLane = "read" | "batch";

export interface RuntimeMethodRegistration {
  readonly lane: RuntimeMethodLane;
  readonly timeoutMs: number;
  readonly concurrency: number;
  readonly trace: "method" | "session-operation";
  readonly coalesce?: {
    readonly key: (params: Record<string, unknown>) => string | undefined;
    /** A read that captures mutable state can share only before its handler starts. */
    readonly until: "start" | "settled";
  };
  readonly handler: (params: Record<string, unknown>, signal: AbortSignal) => unknown;
}

interface MethodActivity {
  running: number;
  pending: number;
  shared: Map<string, Promise<unknown>>;
}

const defaultLimits: Readonly<Record<RuntimeMethodLane, number>> = { read: 12, batch: 2 };
const batchSignal = new AbortController().signal;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export class RuntimeMethodScheduler {
  readonly #lanes = { read: 0, batch: 0 };
  readonly #methods = new Map<string, MethodActivity>();
  readonly #readTasks = new Set<TaskContext>();
  readonly #drainers = new Set<() => void>();
  readonly #limits: Readonly<Record<RuntimeMethodLane, number>>;
  readonly #traceDeadline: (event: RuntimeReadDeadlineTrace) => void;
  #stopped = false;

  constructor(
    options: {
      limits?: Partial<Record<RuntimeMethodLane, number>>;
      traceDeadline?: (event: RuntimeReadDeadlineTrace) => void;
    } = {},
  ) {
    this.#limits = { ...defaultLimits, ...options.limits };
    this.#traceDeadline = options.traceDeadline ?? recordLocalRuntimeTrace;
  }

  run(
    method: string,
    registration: RuntimeMethodRegistration,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.#stopped) return Promise.reject(new BackendTaskError("backend-closing"));
    const { lane } = registration;
    const key = registration.coalesce?.key(params);
    const activity: MethodActivity = this.#methods.get(method) ?? {
      running: 0,
      pending: 0,
      shared: new Map(),
    };
    const joined = key === undefined ? undefined : activity.shared.get(key);
    if (joined) return joined;
    // Bound unfinished work separately so a stalled method cannot pile up detached reads.
    if (
      this.#lanes[lane] >= this.#limits[lane] ||
      activity.running >= registration.concurrency ||
      activity.pending >= 2 * registration.concurrency
    )
      return Promise.reject(new TaskAdmissionError());

    this.#lanes[lane]++;
    activity.running++;
    activity.pending++;
    this.#methods.set(method, activity);
    const readTask =
      lane === "read"
        ? new TaskContext({ id: randomUUID(), deadlineAt: Date.now() + registration.timeoutMs })
        : undefined;
    if (readTask) this.#readTasks.add(readTask);

    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const reply = new Promise<unknown>((accept, refuse) => {
      resolve = accept;
      reject = refuse;
    });
    if (key !== undefined) activity.shared.set(key, reply);
    const removeShared = () => {
      if (key !== undefined && activity.shared.get(key) === reply) activity.shared.delete(key);
    };
    let slotHeld = true;
    let startedAt: number | undefined;
    let detached = false;
    const releaseSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      this.#lanes[lane]--;
      activity.running--;
    };
    const traceDeadline = (phase: RuntimeReadDeadlineTrace["phase"]) => {
      if (startedAt !== undefined)
        this.#traceDeadline({
          kind: "read-deadline",
          method,
          phase,
          durationMs: performance.now() - startedAt,
        });
    };
    const abortRead = () => {
      const error = readTask?.signal.reason;
      removeShared();
      if (error instanceof BackendTaskError && error.reason === "deadline-exceeded") {
        releaseSlot();
        detached = startedAt !== undefined;
        if (detached) traceDeadline("released");
      }
      reject(error);
    };
    readTask?.signal.addEventListener("abort", abortRead, { once: true });
    const release = () => {
      readTask?.signal.removeEventListener("abort", abortRead);
      readTask?.dispose();
      if (readTask) this.#readTasks.delete(readTask);
      removeShared();
      releaseSlot();
      if (detached) traceDeadline("settled");
      if (--activity.pending === 0) this.#methods.delete(method);
      if (this.#methods.size === 0) {
        for (const drained of this.#drainers) drained();
        this.#drainers.clear();
      }
    };
    const fail = (error: unknown) => {
      release();
      reject(error);
    };
    const complete = (result: unknown) => {
      // The handler is already finished if its final checkpoint discovers a deadline.
      readTask?.signal.removeEventListener("abort", abortRead);
      try {
        readTask?.checkpoint();
      } catch (error) {
        fail(error);
        return;
      }
      release();
      resolve(result);
    };
    const execute = () => {
      try {
        if (this.#stopped) throw new BackendTaskError("backend-closing");
        readTask?.checkpoint();
        if (registration.coalesce?.until === "start") removeShared();
        startedAt = performance.now();
        const result = readTask
          ? runWithTask(readTask, () => registration.handler(params, readTask.signal))
          : registration.handler(params, batchSignal);
        if (isThenable(result)) void Promise.resolve(result).then(complete, fail);
        else complete(result);
      } catch (error) {
        fail(error);
      }
    };
    // Shareable requests read from the socket in the same turn can join before execution.
    if (key === undefined) execute();
    else queueMicrotask(execute);
    return reply;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const task of this.#readTasks) task.cancel();
  }

  /** Keep dependencies alive while expired reads finish unwinding. */
  drain(): Promise<void> {
    if (this.#methods.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#drainers.add(resolve));
  }
}
