import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type TaskFailure = "queue-full" | "deadline-exceeded" | "backend-closing" | "worker-failed";
export class BackendTaskError extends Error {
  constructor(
    readonly reason: TaskFailure,
    message: string = reason,
  ) {
    super(message);
    this.name = "BackendTaskError";
  }
}

export class TaskAdmissionError extends BackendTaskError {
  constructor() {
    super("queue-full");
  }
}

export function isTaskCancellation(error: unknown): boolean {
  return (
    error instanceof BackendTaskError &&
    (error.reason === "deadline-exceeded" || error.reason === "backend-closing")
  );
}
export interface TaskIdentity {
  id: string;
  deadlineAt: number;
}
export interface TaskWorkspace {
  workspaceId: string;
  workspacePath: string;
}

/** A deadline cancels producers, never races an unfinished writer's result. */
export class TaskContext {
  readonly id: string;
  readonly deadlineAt: number;
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout>;
  #committing = 0;
  #committed = false;
  constructor(
    identity: TaskIdentity,
    readonly verifyWorkspace?: (scope: TaskWorkspace) => Promise<void>,
  ) {
    this.id = identity.id;
    this.deadlineAt = identity.deadlineAt;
    this.#timer = setTimeout(
      () => this.cancel(new BackendTaskError("deadline-exceeded")),
      Math.max(0, identity.deadlineAt - Date.now()),
    );
    this.#timer.unref();
  }
  get signal(): AbortSignal {
    return this.#controller.signal;
  }
  get committed(): boolean {
    return this.#committed;
  }
  get committing(): boolean {
    return this.#committing > 0;
  }
  cancel(reason = new BackendTaskError("backend-closing")): void {
    this.#controller.abort(reason);
  }
  checkpoint(): void {
    if (this.committing) return;
    if (Date.now() >= this.deadlineAt && !this.signal.aborted)
      this.cancel(new BackendTaskError("deadline-exceeded"));
    if (this.signal.aborted) throw this.signal.reason;
  }
  remainingMs(maximum = 180_000): number {
    this.checkpoint();
    return Math.max(1, Math.min(maximum, this.deadlineAt - Date.now()));
  }
  async commit<T>(operation: () => Promise<T> | T, scope?: TaskWorkspace): Promise<T> {
    this.checkpoint();
    if (scope) await this.verifyWorkspace?.(scope);
    this.checkpoint();
    this.#committing++;
    try {
      const result = await operation();
      this.#committed = true;
      return result;
    } finally {
      this.#committing--;
    }
  }
  dispose(): void {
    clearTimeout(this.#timer);
  }
}

const tasks = new AsyncLocalStorage<TaskContext>();
export function currentTask(): TaskContext | undefined {
  return tasks.getStore();
}
export function runWithTask<T>(task: TaskContext, operation: () => T): T {
  return tasks.run(task, operation);
}
export async function commitTask<T>(
  operation: () => Promise<T> | T,
  scope?: TaskWorkspace,
): Promise<T> {
  const task = currentTask();
  return task ? task.commit(operation, scope) : operation();
}

interface QueuedTask {
  context: TaskContext;
  execute: () => Promise<void>;
  reject(error: Error): void;
  onAbort(): void;
}
/** One running task and a bounded FIFO. A cancelled task retains its slot until it settles. */
export class BoundedTaskQueue {
  readonly #waiting: QueuedTask[] = [];
  #active?: QueuedTask;
  #stopped = false;
  #drainers: Array<() => void> = [];
  constructor(readonly options: { name: string; capacity?: number; timeoutMs?: number }) {}
  run<T>(operation: (task: TaskContext) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#stopped)
      return Promise.reject(
        new BackendTaskError("backend-closing", `${this.options.name} is closing`),
      );
    if (this.#active && this.#waiting.length >= (this.options.capacity ?? 8))
      return Promise.reject(
        new BackendTaskError("queue-full", `${this.options.name} queue is full`),
      );
    const context = new TaskContext({
      id: randomUUID(),
      deadlineAt: Date.now() + (this.options.timeoutMs ?? 180_000),
    });
    const cancelExternal = () =>
      context.cancel(new BackendTaskError("backend-closing", "Read request cancelled"));
    signal?.addEventListener("abort", cancelExternal, { once: true });
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedTask = {
        context,
        reject,
        onAbort: () => {
          const index = this.#waiting.indexOf(entry);
          if (index < 0) return;
          this.#waiting.splice(index, 1);
          context.dispose();
          signal?.removeEventListener("abort", cancelExternal);
          context.signal.removeEventListener("abort", entry.onAbort);
          reject(context.signal.reason);
          this.#drained();
        },
        execute: async () => {
          try {
            context.checkpoint();
            resolve(await runWithTask(context, () => operation(context)));
          } catch (error) {
            reject(error);
          } finally {
            context.dispose();
            signal?.removeEventListener("abort", cancelExternal);
            context.signal.removeEventListener("abort", entry.onAbort);
            this.#active = undefined;
            this.#next();
          }
        },
      };
      context.signal.addEventListener("abort", entry.onAbort, { once: true });
      this.#waiting.push(entry);
      this.#next();
    });
  }
  #next(): void {
    if (this.#active) return;
    const next = this.#waiting.shift();
    if (!next) {
      this.#drained();
      return;
    }
    this.#active = next;
    void next.execute();
  }
  #drained(): void {
    if (!this.#active && !this.#waiting.length)
      for (const resolve of this.#drainers.splice(0)) resolve();
  }
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const entry of [...this.#waiting]) entry.context.cancel();
    this.#active?.context.cancel();
  }
  drain(): Promise<void> {
    return this.#active || this.#waiting.length
      ? new Promise((resolve) => this.#drainers.push(resolve))
      : Promise.resolve();
  }
  async close(): Promise<void> {
    this.stop();
    await this.drain();
  }
}
