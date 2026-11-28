import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { InsightRefresh } from "./insight-refresh";

type Receipt = Awaited<ReturnType<InsightRefresh["refresh"]>>;
type Reply = { receipt: Receipt } | { error: string };

/** Coalesce every desktop's request into one refresh. Only the receipt crosses the thread boundary. */
export class InsightRefreshWorker {
  #active?: { worker: Worker; cancelled: Int32Array; result: Promise<Receipt> };
  #stopping = false;

  constructor(
    readonly databasePath: string,
    readonly environment: NodeJS.ProcessEnv,
    readonly workerFilename?: string,
  ) {}

  async refresh(): Promise<Receipt> {
    if (this.#stopping) throw new Error("Insights refresh is closing");
    if (this.#active) return this.#active.result;
    const directory =
      typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    const cancelled = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const worker = new Worker(this.workerFilename ?? path.join(directory, "backend-insights.cjs"), {
      env: this.environment,
      workerData: { databasePath: this.databasePath, cancelled },
    });
    const result = new Promise<Receipt>((resolve, reject) => {
      let reply: Reply | undefined;
      let failure: Error | undefined;
      worker.once("message", (message: Reply) => {
        reply = message;
      });
      worker.once("error", (error) => {
        failure = error;
      });
      worker.once("exit", (code) => {
        this.#active = undefined;
        if (failure) reject(failure);
        else if (reply && "error" in reply) reject(new Error(reply.error));
        else if (code === 0 && reply) resolve(reply.receipt);
        else reject(new Error(`Insights worker stopped without a result (exit ${code})`));
      });
    });
    this.#active = { worker, cancelled, result };
    return result;
  }

  stop(): void {
    this.#stopping = true;
    const active = this.#active;
    if (!active || Atomics.exchange(active.cancelled, 0, 1) !== 0) return;
    active.worker.postMessage("cancel");
  }

  async close(): Promise<void> {
    this.stop();
    await this.#active?.result.catch(() => undefined);
  }
}
