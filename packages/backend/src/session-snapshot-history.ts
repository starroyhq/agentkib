export interface SnapshotHistory {
  items: Record<string, unknown>[];
  completeItems: boolean;
}

const MAX_ENTRIES = 32;
const MAX_BYTES = 8 * 1024 * 1024;

/** Only the historical projection is reusable; live/control checks always run separately. */
export class SessionSnapshotHistory {
  #entries = new Map<string, { version: string; value: SnapshotHistory; bytes: number }>();
  #bytes = 0;
  #revision = 0;

  invalidate(sessionId?: string): void {
    this.#revision++;
    if (sessionId === undefined) {
      this.#entries.clear();
      this.#bytes = 0;
    } else this.#remove(sessionId);
  }

  async read(
    sessionId: string,
    version: () => Promise<string | null>,
    load: () => Promise<SnapshotHistory>,
  ): Promise<SnapshotHistory> {
    const revision = this.#revision;
    let before: string | null;
    try {
      before = await version();
    } catch (error) {
      this.#remove(sessionId);
      throw error;
    }
    // A managed/unsupported source must use the regular authorized read path;
    // never reuse an indexed projection after its ownership changes.
    if (before === null) {
      this.#remove(sessionId);
      return load();
    }
    const cached = this.#entries.get(sessionId);
    if (cached?.version === before && revision === this.#revision) {
      this.#entries.delete(sessionId);
      this.#entries.set(sessionId, cached);
      return structuredClone(cached.value);
    }
    this.#remove(sessionId);
    const value = await load();
    // An append, replacement, index change or invalidation during the read must
    // not seed a later poll with an older projection under a newer identity.
    if ((await version()) !== before || revision !== this.#revision) return value;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > MAX_BYTES) return value;
    this.#remove(sessionId);
    while (this.#entries.size >= MAX_ENTRIES || this.#bytes + bytes > MAX_BYTES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#remove(oldest);
    }
    this.#entries.set(sessionId, { version: before, value: structuredClone(value), bytes });
    this.#bytes += bytes;
    return value;
  }

  #remove(sessionId: string): void {
    const previous = this.#entries.get(sessionId);
    if (previous) this.#bytes -= previous.bytes;
    this.#entries.delete(sessionId);
  }
}
