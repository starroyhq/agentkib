import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Commands, type CommandOutput } from "./commands";
import { BackendTaskError, runWithTask, type TaskContext, type TaskFailure } from "./task-executor";
import type { HandoffReadInput, HandoffReadOutput, HandoffReadKind } from "./handoff-read-tasks";

const active = new AsyncLocalStorage<{ owner: HandoffWork; task: TaskContext }>();

export const handoffActive = (): boolean => active.getStore() !== undefined;

/** Internal read operations only. No database writer or Cursor channel is shared with the worker. */
export async function readHandoff<K extends HandoffReadKind>(
  kind: K,
  input: HandoffReadInput<K>,
  fallback: () => HandoffReadOutput<K> | Promise<HandoffReadOutput<K>>,
): Promise<HandoffReadOutput<K>> {
  const scope = active.getStore();
  if (!scope) return fallback();
  scope.task.checkpoint();
  return scope.owner.read(kind, input, scope.task);
}

export function handoffCheckpoint(): void {
  active.getStore()?.task.checkpoint();
}

export function handoffRemaining(maximum: number): number {
  return active.getStore()?.task.remainingMs(maximum) ?? maximum;
}

export function handoffSignal(): AbortSignal | undefined {
  return active.getStore()?.task.signal;
}

export async function handoffCommit<T>(action: () => T | Promise<T>): Promise<T> {
  const task = active.getStore()?.task;
  return task ? task.commit(action) : action();
}

export async function serializeHandoff(value: unknown, pretty = true, newline = true) {
  return readHandoff("serialize", { value, pretty, newline }, () => {
    const content = JSON.stringify(value, null, pretty ? 2 : undefined) + (newline ? "\n" : "");
    return { content, hash: createHash("sha256").update(content).digest("hex") };
  });
}
export async function fingerprintHandoff(
  document: import("./session-model").SessionDocument,
): Promise<string> {
  return (await serializeHandoff(document, false, false)).hash;
}

export class HandoffWork {
  constructor(readonly options: { filename?: string } = {}) {}
  readonly commands = new Commands();
  #worker?: Worker;
  #closed = false;
  get closed(): boolean {
    return this.#closed;
  }
  #pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      task: TaskContext;
      cleanup: () => void;
    }
  >();

  run<T>(task: TaskContext, action: () => T | Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("Handoff executor is closed"));
    return Promise.resolve(runWithTask(task, () => active.run({ owner: this, task }, action)));
  }

  #start(): Worker {
    if (this.#closed) throw new Error("Handoff executor is closed");
    if (this.#worker) return this.#worker;
    const directory =
      typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    const worker = new Worker(
      this.options.filename ?? path.join(directory, "backend-handoff-read.cjs"),
    );
    this.#worker = worker;
    worker.on(
      "message",
      (message: {
        kind: string;
        id: string;
        commandId?: string;
        program?: string;
        args?: string[];
        options?: Parameters<Commands["run"]>[2];
        value?: unknown;
        error?: string;
        reason?: TaskFailure;
      }) => {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        if (message.kind === "command") {
          // Child processes stay owned by the Backend, even if the read worker crashes.
          const reply = (result: { value?: CommandOutput; error?: string }) => {
            if (this.#worker !== worker || !this.#pending.has(message.id)) return;
            worker.postMessage({ kind: "command-result", id: message.commandId, ...result });
          };
          void runWithTask(pending.task, () =>
            this.commands.run(message.program!, message.args!, message.options),
          ).then(
            (value: CommandOutput) => reply({ value }),
            (error: unknown) =>
              reply({ error: error instanceof Error ? error.message : String(error) }),
          );
          return;
        }
        if (message.kind !== "result") return;
        this.#pending.delete(message.id);
        pending.cleanup();
        if (pending.task.signal.aborted) {
          pending.reject(pending.task.signal.reason);
          return;
        }
        if (message.error !== undefined)
          pending.reject(
            message.reason
              ? new BackendTaskError(message.reason, message.error)
              : new Error(message.error),
          );
        else {
          try {
            pending.task.checkpoint();
            pending.resolve(message.value);
          } catch (error) {
            pending.reject(error as Error);
          }
        }
      },
    );
    const failed = (error: Error) => {
      if (this.#worker !== worker) return;
      this.#worker = undefined;
      // Do not replay requests or continue external reads after their owner has failed.
      this.#closed = true;
      this.commands.close();
      for (const pending of this.#pending.values()) {
        pending.cleanup();
        pending.reject(error);
      }
      this.#pending.clear();
    };
    worker.once("error", failed);
    worker.once("exit", (code) => failed(new Error(`Handoff read worker exited (${code})`)));
    return worker;
  }

  read<K extends HandoffReadKind>(
    kind: K,
    input: HandoffReadInput<K>,
    task: TaskContext,
  ): Promise<HandoffReadOutput<K>> {
    task.checkpoint();
    const worker = this.#start(),
      id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        if (task.committing) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        pending.cleanup();
        // Read workers own no writes. Stop CPU-bound parsing as well as async
        // reads, while the parent task signal supervises any exported CLI.
        if (this.#worker === worker) this.#worker = undefined;
        void worker.terminate().then(
          () => reject(task.signal.reason),
          () => reject(task.signal.reason),
        );
      };
      task.signal.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => resolve(value as HandoffReadOutput<K>),
        reject,
        task,
        cleanup: () => task.signal.removeEventListener("abort", abort),
      });
      try {
        worker.postMessage({
          kind: "read",
          id,
          task: { id: task.id, deadlineAt: task.deadlineAt },
          operation: kind,
          input,
        });
        if (task.signal.aborted) abort();
      } catch (error) {
        this.#pending.delete(id);
        task.signal.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.commands.close();
    const worker = this.#worker;
    this.#worker = undefined;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new Error("Handoff read worker closed"));
    }
    this.#pending.clear();
    if (worker) await worker.terminate();
  }
}
