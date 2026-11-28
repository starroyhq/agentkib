import { randomUUID } from "node:crypto";
import { BackendTaskError, TaskContext, runWithTask } from "./task-executor";

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
  readonly #onBudgetExceeded?: (method: string, lane: RuntimeMethodLane) => void;
  #stopped = false;

  constructor(
    options: {
      limits?: Partial<Record<RuntimeMethodLane, number>>;
      onBudgetExceeded?: (method: string, lane: RuntimeMethodLane) => void;
    } = {},
  ) {
    this.#limits = { ...defaultLimits, ...options.limits };
    this.#onBudgetExceeded = options.onBudgetExceeded;
  }

  run(
    method: string,
    registration: RuntimeMethodRegistration,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.#stopped) return Promise.reject(new BackendTaskError("backend-closing"));
    const { lane } = registration;
    const key = registration.coalesce?.key(params);
    const activity: MethodActivity = this.#methods.get(method) ?? { running: 0, shared: new Map() };
    const joined = key === undefined ? undefined : activity.shared.get(key);
    if (joined) return joined;
    if (this.#lanes[lane] >= this.#limits[lane] || activity.running >= registration.concurrency)
      return Promise.reject(new BackendTaskError("queue-full"));

    this.#lanes[lane]++;
    activity.running++;
    this.#methods.set(method, activity);
    const deadlineAt = Date.now() + registration.timeoutMs;
    const readTask =
      lane === "read" ? new TaskContext({ id: randomUUID(), deadlineAt }) : undefined;
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
    let budgetExceeded = false;
    const observeBudget = () => {
      if (budgetExceeded) return;
      budgetExceeded = true;
      try {
        this.#onBudgetExceeded?.(method, lane);
      } catch {
        // Diagnostics are independent of RPC outcomes and slot ownership.
      }
    };
    const abortRead = () => {
      const error = readTask?.signal.reason;
      removeShared();
      reject(error);
      if (error instanceof BackendTaskError && error.reason === "deadline-exceeded")
        observeBudget();
    };
    readTask?.signal.addEventListener("abort", abortRead, { once: true });
    const batchTimer =
      lane === "batch" && this.#onBudgetExceeded
        ? setTimeout(observeBudget, registration.timeoutMs).unref()
        : undefined;
    const release = () => {
      readTask?.signal.removeEventListener("abort", abortRead);
      readTask?.dispose();
      if (readTask) this.#readTasks.delete(readTask);
      clearTimeout(batchTimer);
      removeShared();
      this.#lanes[lane]--;
      if (--activity.running === 0) this.#methods.delete(method);
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
      try {
        readTask?.checkpoint();
        if (lane === "batch" && Date.now() >= deadlineAt) observeBudget();
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

  /** Timed-out reads retain their capacity and lifecycle until their handler settles. */
  drain(): Promise<void> {
    if (this.#methods.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#drainers.add(resolve));
  }
}
