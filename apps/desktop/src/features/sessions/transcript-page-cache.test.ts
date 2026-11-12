import { describe, expect, it } from "vitest";
import { createTranscriptPageCache } from "@agentkib/conversation-state";

function page(content: string) {
  return {
    events: [{ id: content.slice(0, 8), content }],
    next_cursor: "earlier-turn",
    warnings: ["incomplete-history"],
  };
}

describe("recent transcript retention", () => {
  it("evicts the least recently used session and preserves complete pages and cursors", () => {
    const cache = createTranscriptPageCache<ReturnType<typeof page>>({ maxEntries: 2 });
    const first = page("first");
    cache.set("first", first);
    cache.set("second", page("second"));
    expect(cache.get("first")).toBe(first);
    cache.set("third", page("third"));
    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toBe(first);
    expect(cache.get("first")?.next_cursor).toBe("earlier-turn");
    expect(cache.get("first")?.warnings).toEqual(["incomplete-history"]);
    expect(cache.size).toBe(2);
  });

  it("budgets text and nested tool details rather than only the number of sessions", () => {
    const cache = createTranscriptPageCache({ maxBytes: 2_500 });
    for (let index = 0; index < 10; index += 1) {
      cache.set(String(index), {
        events: [{ tool: { output: "x".repeat(500), files: ["long/path.ts"] } }],
      });
      expect(cache.estimatedBytes).toBeLessThanOrEqual(2_500);
    }
    expect(cache.size).toBe(1);
    expect(cache.get("8")).toBeUndefined();
    expect(cache.get("9")).toBeDefined();
  });

  it("removes the old snapshot when an active conversation grows beyond the budget", () => {
    const cache = createTranscriptPageCache({ maxBytes: 2_500 });
    cache.set("active", page("small"));
    const active = page("x".repeat(2_000));
    cache.set("active", active);
    expect(cache.get("active")).toBeUndefined();
    expect(cache.estimatedBytes).toBe(0);
    // Retention never mutates or truncates the page owned by the active reader.
    expect(active.events[0].content).toHaveLength(2_000);
    expect(active.next_cursor).toBe("earlier-turn");
  });

  it("reuses measurements of immutable historical events during live updates", () => {
    const cache = createTranscriptPageCache();
    let reads = 0;
    const historicalEvent = {
      get content() {
        reads += 1;
        return "large historical tool output";
      },
    };
    for (let index = 0; index < 50; index += 1) {
      cache.set("active", {
        events: [historicalEvent, { content: "streaming ".repeat(index) }],
      });
    }
    expect(reads).toBe(1);
    expect(cache.size).toBe(1);
  });

  it("clears retained pages and size memoization when the identity is cleared", () => {
    const cache = createTranscriptPageCache();
    cache.set("first", page("first"));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.estimatedBytes).toBe(0);
    expect(cache.get("first")).toBeUndefined();
    cache.set("second", page("second"));
    expect(cache.size).toBe(1);
    expect(cache.estimatedBytes).toBeGreaterThan(0);
  });
});
