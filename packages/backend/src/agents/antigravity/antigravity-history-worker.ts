import { homedir } from "node:os";
import path from "node:path";
import { isMainThread, Worker } from "node:worker_threads";
import { BoundedTaskQueue, currentTask } from "../../task-executor";
import { AntigravityLocalHistory } from "./antigravity-local-history";

type Method = "records" | "readEvents" | "readDocument";
type HistoryResult<K extends Method> = Awaited<ReturnType<AntigravityLocalHistory[K]>>;
export type AntigravityHistoryRequest = {
  [K in Method]: { method: K; args: Parameters<AntigravityLocalHistory[K]> };
}[Method];
export type AntigravityHistoryReply = { value: unknown } | { error: string };

const IDLE_MS = 30_000;

/** Keep synchronous native SQLite and whole daemon snapshot parsing off the runtime loop. */
export class AntigravityHistoryWorker {
  readonly #queue = new BoundedTaskQueue({
    name: "Antigravity history",
    capacity: 8,
    timeoutMs: 30_000,
  });
  readonly #filename: string | undefined;
  readonly #home: string;
  #direct?: AntigravityLocalHistory;
  #worker?: Worker;
  #terminating?: Promise<number | undefined>;
  #idle?: ReturnType<typeof setTimeout>;

  constructor(env: NodeJS.ProcessEnv, filename?: string) {
    this.#home = env.HOME ?? env.USERPROFILE ?? homedir();
    this.#filename =
      filename ??
      (isMainThread &&
      typeof __filename === "string" &&
      /^backend(?:-.*)?\.cjs$/.test(path.basename(__filename))
        ? path.join(__dirname, "backend-antigravity-history.cjs")
        : undefined);
    // Unbundled tests and code already executing in a read worker need no nested worker.
    if (!this.#filename) this.#direct = new AntigravityLocalHistory({ HOME: this.#home });
  }

  async read<K extends Method>(
    method: K,
    args: Parameters<AntigravityLocalHistory[K]>,
  ): Promise<HistoryResult<K>> {
    const input = { method, args } as AntigravityHistoryRequest;
    const local = this.#direct;
    if (local)
      return (await (input.method === "records"
        ? local.records(...input.args)
        : input.method === "readEvents"
          ? local.readEvents(...input.args)
          : local.readDocument(...input.args))) as HistoryResult<K>;
    return this.#queue.run<HistoryResult<K>>(async (task): Promise<HistoryResult<K>> => {
      clearTimeout(this.#idle);
      await this.#terminating;
      task.checkpoint();
      const worker =
        this.#worker ?? (this.#worker = new Worker(this.#filename!, { workerData: this.#home }));
      worker.ref();
      try {
        return await new Promise<HistoryResult<K>>((resolve, reject) => {
          const cleanup = () => {
            worker.off("message", message);
            worker.off("error", failure);
            worker.off("exit", exit);
            task.signal.removeEventListener("abort", abort);
          };
          const message = (reply: AntigravityHistoryReply) => {
            cleanup();
            if ("error" in reply) reject(new Error(reply.error));
            else resolve(reply.value as HistoryResult<K>);
          };
          const failure = () => {
            cleanup();
            void this.#stop(worker).then(() =>
              reject(new Error("Antigravity history worker stopped")),
            );
          };
          const exit = () => {
            cleanup();
            if (this.#worker === worker) this.#worker = undefined;
            reject(new Error("Antigravity history worker stopped"));
          };
          const abort = () => {
            cleanup();
            void this.#stop(worker).then(() => reject(task.signal.reason));
          };
          task.signal.addEventListener("abort", abort, { once: true });
          worker.once("message", message);
          worker.once("error", failure);
          worker.once("exit", exit);
          try {
            worker.postMessage(input);
          } catch {
            failure();
          }
        });
      } finally {
        if (this.#worker === worker) {
          worker.unref();
          this.#idle = setTimeout(() => void this.#stop(worker), IDLE_MS);
          this.#idle.unref();
        }
      }
    }, currentTask()?.signal);
  }

  #stop(worker: Worker) {
    if (this.#worker !== worker) return this.#terminating ?? Promise.resolve();
    clearTimeout(this.#idle);
    this.#worker = undefined;
    this.#terminating = worker.terminate().catch(() => undefined);
    return this.#terminating;
  }

  async close() {
    this.#queue.stop();
    if (this.#worker) void this.#stop(this.#worker);
    await this.#terminating;
    await this.#queue.drain();
  }
}
