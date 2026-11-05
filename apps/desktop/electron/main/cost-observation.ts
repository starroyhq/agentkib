import type { LocalCostProvider } from "@agentkib/runtime-protocol";
import { RUNTIME_METHODS } from "../generated/runtime-protocol";

/** A renderer may observe estimates, but cannot choose filesystem roots or identities. */
export class CostObservation {
  readonly #owners = new Map<number, LocalCostProvider>();
  #active = true;
  #available = true;
  #revision = 0;
  #lane: Promise<unknown> = Promise.resolve();

  constructor(
    readonly runtime: () => {
      request(method: string, params: unknown): Promise<unknown>;
    },
  ) {}

  observe(owner: number, provider: LocalCostProvider | null): Promise<void> {
    this.#owners.delete(owner);
    if (provider) this.#owners.set(owner, provider);
    return this.#publish();
  }

  forget(owner: number): void {
    if (!this.#owners.delete(owner)) return;
    void this.#publish().catch(() => undefined);
  }

  setActive(active: boolean): void {
    if (active === this.#active) return;
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
    // Serialize state changes, and coalesce ones that have not left this process.
    const next = this.#lane
      .catch(() => undefined)
      .then(async () => {
        if (!this.#available || revision !== this.#revision) return;
        const provider = this.#active ? ([...this.#owners.values()].at(-1) ?? null) : null;
        await this.runtime().request(RUNTIME_METHODS.observeLocalCosts, { provider });
      });
    this.#lane = next;
    return next;
  }
}

export function requireLocalCostProvider(value: unknown): LocalCostProvider {
  if (value !== "codex" && value !== "claude") throw new Error("Unsupported local cost provider");
  return value;
}
