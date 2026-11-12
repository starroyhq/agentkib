import { describe, expect, it } from "vitest";
import type { ConversationEvent, ConversationEventPage } from "@agentkib/web-client";
import { loadEarlierHistoryBatch } from "@agentkib/conversation-state";
import {
  applyHistoryPagination,
  beginHistoryPagination,
  createHistoryPagination,
  historyPaginationCursor,
  recordLatestHistoryPage,
} from "@/features/conversation/features/sessions/history-pagination";

const page = (ids: string[], next_cursor?: string): ConversationEventPage => ({
  events: ids.map((id) => ({
    id,
    kind: "agent-message",
    content: id,
    attachment_count: 0,
    truncated: false,
  })),
  next_cursor,
  warnings: [],
});

describe("loading an earlier history batch", () => {
  const item = (
    id: string,
    turn_id: string,
    kind: ConversationEvent["kind"] = "agent-message",
  ) => ({
    ...page([id]).events[0]!,
    turn_id,
    kind,
  });

  it("passes over tool windows and stops after three newly readable native turns", async () => {
    const visible = [item("final-4", "4")];
    const responses = new Map([
      ["p1", { events: [item("tool-4", "4", "tool-summary")], next_cursor: "p2" }],
      [
        "p2",
        {
          events: [item("final-3", "3"), item("user-4", "4", "user-message")],
          next_cursor: "p3",
        },
      ],
      [
        "p3",
        {
          events: [item("final-1", "1"), item("final-2", "2"), item("user-3", "3", "user-message")],
          next_cursor: "p4",
        },
      ],
    ]);
    const read: string[] = [];
    await loadEarlierHistoryBatch("p1", visible, async (cursor) => {
      read.push(cursor);
      return responses.get(cursor);
    });
    expect(read).toEqual(["p1", "p2", "p3"]);
  });

  it("does not fetch beyond the beginning of the requested long turn", async () => {
    const read: string[] = [];
    await loadEarlierHistoryBatch(
      "p1",
      [item("final", "turn")],
      async (cursor) => {
        read.push(cursor);
        return cursor === "p1"
          ? { events: [item("tool", "turn", "tool-summary")], next_cursor: "p2" }
          : { events: [item("user", "turn", "user-message")], next_cursor: "p3" };
      },
      "turn",
    );
    expect(read).toEqual(["p1", "p2"]);
  });

  it("bounds empty-window scans and does not reissue a cursor", async () => {
    const read: string[] = [];
    await loadEarlierHistoryBatch("0", [], async (cursor) => {
      read.push(cursor);
      return { events: [], next_cursor: String(Number(cursor) + 1) };
    });
    expect(read).toEqual(["0", "1", "2", "3"]);
    read.length = 0;
    await loadEarlierHistoryBatch("0", [], async (cursor) => {
      read.push(cursor);
      return { events: [], next_cursor: "0" };
    });
    expect(read).toEqual(["0"]);
  });
});

describe("history pagination", () => {
  it("keeps an older raw boundary for an empty latest gap and advances its newest raw window", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a", "b"], "oldest"));
    expect(beginHistoryPagination(state, "oldest")!.afterItemIds).toEqual([]);
    recordLatestHistoryPage(state, page([], "empty-gap"));
    const empty = beginHistoryPagination(state, "empty-gap")!;
    expect(empty.beforeItemIds).toEqual([]);
    expect(empty.afterItemIds).toEqual(["a", "b"]);
    applyHistoryPagination(state, empty, page(["e", "f"], "gap-older"));
    const continuing = beginHistoryPagination(state, "gap-older")!;
    expect(continuing.beforeItemIds).toEqual(["e", "f"]);
    expect(continuing.afterItemIds).toEqual(["a", "b"]);
    recordLatestHistoryPage(state, page(["i", "j"], "new-gap"));
    expect(beginHistoryPagination(state, "new-gap")!.afterItemIds).toEqual(["e", "f"]);
    expect(applyHistoryPagination(state, continuing, page(["c", "d"], "continued"))).toBe(true);
    recordLatestHistoryPage(state, page(["m", "n"], "newest-gap"));
    expect(beginHistoryPagination(state, "newest-gap")!.afterItemIds).toEqual(["i", "j"]);
  });

  it("rejects a replaced empty-head ticket without overwriting a newer raw boundary", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a", "b"], "oldest"));
    recordLatestHistoryPage(state, page([], "empty-gap"));
    const empty = beginHistoryPagination(state, "empty-gap")!;
    recordLatestHistoryPage(state, page(["e", "f"], "new-head"));
    expect(beginHistoryPagination(state, "new-head")!.afterItemIds).toEqual(["a", "b"]);
    expect(applyHistoryPagination(state, empty, page(["c", "d"], "stale"))).toBe(false);
    recordLatestHistoryPage(state, page(["i", "j"], "new-gap"));
    expect(beginHistoryPagination(state, "new-gap")!.afterItemIds).toEqual(["e", "f"]);
  });

  it("does not promote a late empty-head continuation over a newer overlapping latest page", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a", "b"], "oldest"));
    recordLatestHistoryPage(state, page([], "empty-gap"));
    const empty = beginHistoryPagination(state, "empty-gap")!;
    recordLatestHistoryPage(state, page(["b", "e"], "connected-latest"));
    expect(applyHistoryPagination(state, empty, page(["c", "d"], "continued"))).toBe(true);
    recordLatestHistoryPage(state, page(["h", "i"], "new-gap"));
    expect(beginHistoryPagination(state, "new-gap")!.afterItemIds).toEqual(["b", "e"]);
  });

  it("tracks each continuation's raw insertion boundary without mutating an older ticket", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a", "b"], "oldest"));
    recordLatestHistoryPage(state, page(["g", "h"], "gap-1"));
    const first = beginHistoryPagination(state, "gap-1")!;
    expect(first.beforeItemIds).toEqual(["g", "h"]);
    applyHistoryPagination(state, first, page(["e", "f"], "gap-2"));
    const next = beginHistoryPagination(state, "gap-2")!;
    expect(next.beforeItemIds).toEqual(["e", "f"]);
    expect(first.beforeItemIds).toEqual(["g", "h"]);
    applyHistoryPagination(state, next, page([], "gap-3"));
    expect(beginHistoryPagination(state, "gap-3")!.beforeItemIds).toEqual(["e", "f"]);
    expect(beginHistoryPagination(state, "oldest")!.beforeItemIds).toEqual(["a", "b"]);
  });

  it("fills a disjoint middle gap before returning to the original oldest cursor", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a", "b"], "oldest"));
    recordLatestHistoryPage(state, page(["g", "h"], "gap-1"));
    expect(historyPaginationCursor(state)).toBe("gap-1");
    expect(
      applyHistoryPagination(
        state,
        beginHistoryPagination(state, "gap-1")!,
        page(["e", "f"], "gap-2"),
      ),
    ).toBe(true);
    expect(historyPaginationCursor(state)).toBe("gap-2");
    applyHistoryPagination(
      state,
      beginHistoryPagination(state, "gap-2")!,
      page(["b", "c", "d"], "covered"),
    );
    expect(historyPaginationCursor(state)).toBe("oldest");
  });

  it("does not infer a persisted anchor from native-only items", () => {
    const state = createHistoryPagination();
    // The caller may display native b/c/d, but only a was read from history.
    recordLatestHistoryPage(state, page(["a"], "oldest"));
    recordLatestHistoryPage(state, page(["c", "d"], "gap"));
    const ticket = beginHistoryPagination(state, "gap")!;
    applyHistoryPagination(state, ticket, page(["b", "c"], "gap-older"));
    expect(historyPaginationCursor(state)).toBe("gap-older");
  });

  it("retains several gaps and permits an older range to finish after a new gap appears", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "oldest"));
    recordLatestHistoryPage(state, page(["d"], "first-gap"));
    const first = beginHistoryPagination(state, "first-gap")!;
    recordLatestHistoryPage(state, page(["g"], "second-gap"));
    expect(applyHistoryPagination(state, first, page(["a", "b", "c"], "unused"))).toBe(true);
    expect(historyPaginationCursor(state)).toBe("second-gap");
    applyHistoryPagination(
      state,
      beginHistoryPagination(state, "second-gap")!,
      page(["d", "e", "f"], "unused"),
    );
    expect(historyPaginationCursor(state)).toBe("oldest");
  });

  it("does not add duplicate gaps for connected latest windows", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "oldest"));
    recordLatestHistoryPage(state, page(["d", "e"], "gap"));
    const ticket = beginHistoryPagination(state, "gap")!;
    recordLatestHistoryPage(state, page(["e", "f"], "overlapping"));
    expect(historyPaginationCursor(state)).toBe("gap");
    expect(applyHistoryPagination(state, ticket, page(["a", "b", "c"], "covered"))).toBe(true);
    expect(historyPaginationCursor(state)).toBe("oldest");
  });

  it("keeps empty scan-budget continuations until an anchor or the beginning is read", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "oldest"));
    recordLatestHistoryPage(state, page([], "scan-1"));
    applyHistoryPagination(state, beginHistoryPagination(state, "scan-1")!, page([], "scan-2"));
    expect(historyPaginationCursor(state)).toBe("scan-2");
    applyHistoryPagination(state, beginHistoryPagination(state, "scan-2")!, page(["a"], "covered"));
    expect(historyPaginationCursor(state)).toBe("oldest");
  });

  it("coalesces unanchored empty latest reads without accumulating unreachable cursors", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "oldest"));
    recordLatestHistoryPage(state, page([], "empty-1"));
    const stale = beginHistoryPagination(state, "empty-1")!;
    recordLatestHistoryPage(state, page([], "empty-2"));
    recordLatestHistoryPage(state, page(["d"], "gap"));
    expect(applyHistoryPagination(state, stale, page(["a"], "stale"))).toBe(false);
    applyHistoryPagination(
      state,
      beginHistoryPagination(state, "gap")!,
      page(["a", "b", "c"], "covered"),
    );
    expect(historyPaginationCursor(state)).toBe("oldest");
  });

  it("rejects consumed tickets and tickets from a replaced cache", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["c"], "opaque"));
    const ticket = beginHistoryPagination(state, "opaque")!;
    expect(applyHistoryPagination(state, ticket, page(["b"], "next"))).toBe(true);
    expect(applyHistoryPagination(state, ticket, page(["a"], "stale"))).toBe(false);
    const replacement = createHistoryPagination();
    recordLatestHistoryPage(replacement, page(["x"], "opaque"));
    expect(applyHistoryPagination(replacement, ticket, page(["a"], "stale"))).toBe(false);
    expect(historyPaginationCursor(replacement)).toBe("opaque");
  });

  it("does not let a late latest read replace a newer cursor or register false anchors", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "oldest"), 1);
    recordLatestHistoryPage(state, page(["f"], "gap"), 3);
    recordLatestHistoryPage(state, page(["c"], "stale"), 2);
    recordLatestHistoryPage(state, page([], "duplicate-order"), 3);
    expect(historyPaginationCursor(state)).toBe("gap");
    applyHistoryPagination(
      state,
      beginHistoryPagination(state, "gap")!,
      page(["c", "d", "e"], "next"),
    );
    expect(historyPaginationCursor(state)).toBe("next");
  });

  it("reading a gap to the beginning clears older cursors but leaves a newer gap", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "oldest"));
    recordLatestHistoryPage(state, page(["d"], "first-gap"));
    const ticket = beginHistoryPagination(state, "first-gap")!;
    recordLatestHistoryPage(state, page(["g"], "second-gap"));
    applyHistoryPagination(state, ticket, page(["a", "b", "c"]));
    expect(historyPaginationCursor(state)).toBe("second-gap");
    applyHistoryPagination(
      state,
      beginHistoryPagination(state, "second-gap")!,
      page(["d", "e", "f"], "covered"),
    );
    expect(historyPaginationCursor(state)).toBeUndefined();
  });

  it("a complete latest response supersedes every previous continuation", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "oldest"));
    recordLatestHistoryPage(state, page(["c"], "gap"));
    const ticket = beginHistoryPagination(state, "gap")!;
    recordLatestHistoryPage(state, page(["a", "b", "c"]));
    expect(historyPaginationCursor(state)).toBeUndefined();
    expect(applyHistoryPagination(state, ticket, page(["a", "b"], "oldest"))).toBe(false);
  });

  it("treats cursors as opaque and distinguishes equal cursors by range identity", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"], "7"));
    const oldest = beginHistoryPagination(state, "7")!;
    recordLatestHistoryPage(state, page(["d"], "7"));
    const gap = beginHistoryPagination(state, "7")!;
    expect(gap.rangeId).not.toBe(oldest.rangeId);
    expect(gap.kind).toBe("gap");
    expect(oldest.kind).toBe("older");
    applyHistoryPagination(state, gap, page(["a", "b", "c"], "not-a-number"));
    expect(historyPaginationCursor(state)).toBe("7");
    expect(applyHistoryPagination(state, oldest, page([]))).toBe(true);
    expect(historyPaginationCursor(state)).toBeUndefined();
  });

  it("preserves a reached beginning when a later disjoint window reconnects", () => {
    const state = createHistoryPagination();
    recordLatestHistoryPage(state, page(["a"]));
    recordLatestHistoryPage(state, page(["d"], "gap"));
    applyHistoryPagination(
      state,
      beginHistoryPagination(state, "gap")!,
      page(["a", "b", "c"], "covered"),
    );
    expect(historyPaginationCursor(state)).toBeUndefined();
  });
});
