import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";

/** Aggregate trusted renderer observations; a hidden or crashed window cannot leave a poller. */
export class NativeMemoryObservation {
  readonly #owners = new Set<number>();
  #active = true;
  #available = true;
  #revision = 0;
  #lane: Promise<unknown> = Promise.resolve();
  constructor(
    readonly runtime: () => { request(method: string, params: unknown): Promise<unknown> },
  ) {}
  observe(owner: number, active: boolean): Promise<void> {
    if (active) this.#owners.add(owner);
    else this.#owners.delete(owner);
    return this.#publish();
  }
  forget(owner: number): void {
    if (this.#owners.delete(owner)) void this.#publish().catch(() => undefined);
  }
  setActive(active: boolean): void {
    if (this.#active === active) return;
    this.#active = active;
    void this.#publish().catch(() => undefined);
  }
  setRuntimeAvailable(available: boolean): void {
    this.#available = available;
    ++this.#revision;
    if (available) void this.#publish().catch(() => undefined);
  }
  #publish(): Promise<void> {
    const revision = ++this.#revision;
    const next = this.#lane
      .catch(() => undefined)
      .then(async () => {
        if (!this.#available || revision !== this.#revision) return;
        await this.runtime().request(RUNTIME_METHODS.nativeMemoryObserve, {
          active: this.#active && this.#owners.size > 0,
        });
      });
    this.#lane = next;
    return next;
  }
}
