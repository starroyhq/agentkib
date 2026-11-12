/** A retention budget, not a measurement of the JavaScript engine's heap layout. */
export const TRANSCRIPT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const TRANSCRIPT_CACHE_MAX_ENTRIES = 10;

/**
 * Recently viewed, immutable transcript pages. The active reader owns its full page independently:
 * eviction only gives up the instant-reopen optimization, never history or pagination cursors.
 */
export function createTranscriptPageCache<Page extends object>(
  options: { maxBytes?: number; maxEntries?: number } = {},
) {
  const maxBytes = options.maxBytes ?? TRANSCRIPT_CACHE_MAX_BYTES;
  const maxEntries = options.maxEntries ?? TRANSCRIPT_CACHE_MAX_ENTRIES;
  const entries = new Map<string, { page: Page; bytes: number }>();
  let estimatedBytes = 0;
  let sizes = new WeakMap<object, number>();

  // Streaming replaces changed events and shares the others. Weak size memoization avoids
  // serializing all historical tool output on every update and cannot keep evicted events alive.
  function estimate(value: unknown, ancestors = new Set<object>()): number {
    if (typeof value === "string") return 24 + value.length * 2;
    if (value === null || typeof value !== "object") return 8;
    const cached = sizes.get(value);
    if (cached !== undefined) return cached;
    if (ancestors.has(value)) return 0;
    ancestors.add(value);
    let bytes = Array.isArray(value) ? 32 : 64;
    if (Array.isArray(value)) {
      for (const child of value) {
        bytes += 8 + estimate(child, ancestors);
        if (bytes > maxBytes) break;
      }
    } else {
      for (const key of Object.keys(value)) {
        bytes += 8 + key.length * 2 + estimate((value as Record<string, unknown>)[key], ancestors);
        if (bytes > maxBytes) break;
      }
    }
    bytes = Math.min(bytes, maxBytes + 1);
    ancestors.delete(value);
    sizes.set(value, bytes);
    return bytes;
  }

  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    estimatedBytes -= entry.bytes;
    entries.delete(key);
  }

  return {
    get size() {
      return entries.size;
    },
    get estimatedBytes() {
      return estimatedBytes;
    },
    get(key: string): Page | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.page;
    },
    set(key: string, page: Page) {
      if (entries.get(key)?.page === page) return;
      remove(key);
      const bytes = estimate(page);
      // Do not leave an older, misleading cached page when a conversation outgrows the budget.
      if (bytes > maxBytes || maxEntries <= 0) return;
      entries.set(key, { page, bytes });
      estimatedBytes += bytes;
      while (entries.size > maxEntries || estimatedBytes > maxBytes) {
        remove(entries.keys().next().value!);
      }
    },
    clear() {
      entries.clear();
      estimatedBytes = 0;
      sizes = new WeakMap();
    },
  };
}
