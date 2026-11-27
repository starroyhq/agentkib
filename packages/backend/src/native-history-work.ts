import { HandoffWork } from "./handoff-work";
import type { HandoffReadInput, HandoffReadKind, HandoffReadOutput } from "./handoff-read-tasks";
import { BackendTaskError, BoundedTaskQueue } from "./task-executor";

type NativeRead = Extract<HandoffReadKind, `devin-${string}` | "dsh-history">;

/** Native reads share one bounded lane, separate from handoffs and search. */
export class NativeHistoryWork {
  readonly #queue = new BoundedTaskQueue({ name: "Native history", timeoutMs: 15_000 });
  #worker: HandoffWork;

  constructor(readonly filename: string) {
    this.#worker = new HandoffWork({ filename });
  }

  read<K extends NativeRead>(kind: K, input: HandoffReadInput<K>): Promise<HandoffReadOutput<K>> {
    return this.#queue.run(async (task) => {
      if (this.#worker.closed) this.#worker = new HandoffWork({ filename: this.filename });
      const worker = this.#worker;
      try {
        return await worker.read(kind, input, task);
      } catch (error) {
        // An exited worker closes its owner. Keep ordinary native read errors intact.
        if (error instanceof BackendTaskError || !worker.closed) throw error;
        throw new BackendTaskError(
          "worker-failed",
          error instanceof Error ? error.message : undefined,
        );
      }
    });
  }

  async close() {
    this.#queue.stop();
    await this.#queue.drain();
    await this.#worker.close();
  }
}
