import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendTaskError, BoundedTaskQueue, type TaskContext } from "./task-executor";
import {
  HistorySourceInvalidatedError,
  type ReadDshSearchPage,
} from "./history-search-source-types";

type Pending = {
  id: string;
  task: TaskContext;
  cancelFlag: Int32Array;
  verify?: () => boolean | Promise<boolean>;
  readDshPage?: ReadDshSearchPage;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
/** Search uses dedicated workers so ingestion and SQLite scans cannot occupy the runtime loop. */
export class HistorySearchWorker {
  readonly #worker: Worker;
  readonly #queue: BoundedTaskQueue;
  #pending?: Pending;
  #failure?: Error;
  #closed?: Promise<void>;
  readonly #exited: Promise<void>;
  constructor(
    filename: string,
    writable: boolean,
    limitBytes: number,
    options: { workerFilename?: string; timeoutMs?: number } = {},
  ) {
    const directory =
      typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    this.#worker = new Worker(
      options.workerFilename ?? path.join(directory, "backend-history-search.cjs"),
      {
        workerData: { filename, writable, limitBytes },
      },
    );
    this.#exited = new Promise((resolve) => this.#worker.once("exit", () => resolve()));
    this.#queue = new BoundedTaskQueue({
      name: writable ? "History indexing" : "History queries",
      timeoutMs: options.timeoutMs,
    });
    this.#worker.on("message", (message: unknown) => void this.#message(message));
    this.#worker.on("error", () => this.#failed());
    this.#worker.on("exit", () => {
      if (!this.#closed || this.#pending) this.#failed();
    });
  }
  request<T>(
    operation: string,
    input: unknown,
    options: {
      signal?: AbortSignal;
      verify?: () => boolean | Promise<boolean>;
      readDshPage?: ReadDshSearchPage;
    } = {},
  ): Promise<T> {
    if (this.#failure) return Promise.reject(this.#failure);
    return this.#queue.run(
      (task) =>
        new Promise<T>((resolve, reject) => {
          if (this.#failure) {
            reject(this.#failure);
            return;
          }
          const cancelFlag = new Int32Array(new SharedArrayBuffer(4));
          const cancel = () => {
            Atomics.store(cancelFlag, 0, 1);
            this.#worker.postMessage({ type: "cancel", id: task.id });
          };
          task.signal.addEventListener("abort", cancel, { once: true });
          const cleanup = () => task.signal.removeEventListener("abort", cancel);
          this.#pending = {
            id: task.id,
            task,
            cancelFlag,
            verify: options.verify,
            readDshPage: options.readDshPage,
            resolve: (value) => {
              cleanup();
              resolve(value as T);
            },
            reject: (error) => {
              cleanup();
              reject(error);
            },
          };
          try {
            task.checkpoint();
            this.#worker.postMessage({
              type: "run",
              id: task.id,
              deadlineAt: task.deadlineAt,
              operation,
              input,
              streamDsh: !!options.readDshPage,
              cancelFlag: cancelFlag.buffer,
            });
          } catch (error) {
            this.#pending = undefined;
            cleanup();
            reject(error);
          }
        }),
      options.signal,
    );
  }
  async #message(value: unknown) {
    if (!value || typeof value !== "object") return;
    const message = value as Record<string, unknown>,
      pending = this.#pending;
    if (!pending || message.id !== pending.id) return;
    if (message.type === "verify") {
      let valid = false;
      try {
        pending.task.checkpoint();
        valid = (await pending.verify?.()) ?? true;
        pending.task.checkpoint();
      } catch {
        valid = false;
      }
      if (this.#pending === pending)
        this.#worker.postMessage({ type: "verified", id: pending.id, valid });
    } else if (message.type === "read-dsh-page") {
      let page;
      try {
        pending.task.checkpoint();
        page = await pending.readDshPage?.();
        pending.task.checkpoint();
      } catch {
        page = undefined;
      }
      if (this.#pending === pending)
        this.#worker.postMessage({ type: "dsh-page", id: pending.id, page });
    } else if (message.type === "result" || message.type === "error") {
      this.#pending = undefined;
      if (message.type === "result") pending.resolve(message.value);
      else
        pending.reject(
          typeof message.sourceSessionId === "string" &&
            [
              REMOTE_ERROR_CODES.historySourceOwnerChanged,
              "history-source-redaction-failed",
            ].includes(String(message.message))
            ? new HistorySourceInvalidatedError(
                message.sourceSessionId,
                message.message as
                  | typeof REMOTE_ERROR_CODES.historySourceOwnerChanged
                  | "history-source-redaction-failed",
              )
            : new Error(
                typeof message.message === "string" ? message.message : "History search failed",
              ),
        );
    }
  }
  #failed() {
    this.#failure ??= new BackendTaskError(
      "worker-failed",
      "History search worker stopped; reopen or rebuild its cache",
    );
    this.#queue.stop();
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(this.#failure);
  }
  stop() {
    this.#queue.stop();
  }
  get failed() {
    return !!this.#failure;
  }
  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.stop();
    this.#closed = (async () => {
      await this.#queue.drain();
      if (!this.#failure) {
        this.#worker.postMessage({ type: "close" });
      }
      await this.#exited;
    })();
    return this.#closed;
  }
}
