/**
 * The last model catalog Codex returned, per CLI build, CODEX_HOME and directory.
 *
 * Reading a catalog without a running session starts a whole app-server, and
 * that process may first refresh the shared `models_cache.json` from the
 * network. A read therefore answers at once with the catalog it holds and, once
 * that is older than `freshMs`, refreshes it in the background. Only the first
 * read for a key waits for Codex. A failed refresh keeps the last catalog.
 *
 * Callers still check a selection against the live catalog before a turn or a
 * settings change, so an older list is only ever a display.
 */
export class CodexCatalogCache<T> {
  readonly #entries = new Map<string, { value: T; at: number }>();
  readonly #loading = new Map<string, Promise<T>>();

  constructor(
    readonly freshMs = 5 * 60_000,
    readonly maxEntries = 32,
    readonly now: () => number = Date.now,
  ) {}

  read(key: string, load: () => Promise<T>): Promise<T> {
    const entry = this.#entries.get(key);
    if (!entry) return this.#load(key, load);
    // Keep the most recently used key last, so eviction drops the oldest one.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    if (this.now() - entry.at >= this.freshMs)
      this.#load(key, load).catch(() => {
        // The last catalog stays in place until a refresh succeeds.
      });
    return Promise.resolve(entry.value);
  }

  clear(): void {
    this.#entries.clear();
  }

  #load(key: string, load: () => Promise<T>): Promise<T> {
    const running = this.#loading.get(key);
    if (running) return running;
    const pending = Promise.resolve()
      .then(load)
      .then((value) => {
        this.#entries.delete(key);
        this.#entries.set(key, { value, at: this.now() });
        while (this.#entries.size > this.maxEntries) {
          const oldest = this.#entries.keys().next().value;
          if (oldest === undefined) break;
          this.#entries.delete(oldest);
        }
        return value;
      })
      .finally(() => this.#loading.delete(key));
    this.#loading.set(key, pending);
    return pending;
  }
}
