import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "@agentkib/web-client";

import {
  isValidMessage,
  mergeLatestPage,
  mergePersistedHistory,
  mergeOrderedPersistedHistory,
  mergeNativeCoverage,
} from "@agentkib/conversation-state";

describe("ordered persisted history", () => {
  const row = (id: string): ConversationEvent => ({
    id,
    kind: "agent-message",
    content: id,
    attachment_count: 0,
    truncated: false,
  });
  const ids = (items: ConversationEvent[]) => items.map((item) => item.id);

  it("inserts ACP results between already displayed tools and before the final answer", () => {
    const tools = Array.from({ length: 25 }, (_, index): ConversationEvent => ({
      ...row(`call-${index}`),
      kind: "tool-summary",
      tool_name: "read",
      tool_status: "completed",
    }));
    const final = row("final-answer");
    // ACP live delivery has toolCallId, while its bounded history page also
    // contains separate toolCallId-result records and may start at a result.
    const latest = [
      ...tools.flatMap((tool) => [tool, { ...tool, id: `${tool.id}-result` }]),
      final,
    ].slice(1);
    const previous = [row("older-page"), ...tools, final];
    expect(mergeOrderedPersistedHistory(previous, latest, "latest")).toEqual([
      previous[0],
      tools[0],
      ...latest,
    ]);
    expect(previous).toEqual([row("older-page"), ...tools, final]);
  });

  it("inserts before, between and after anchors while preserving uncovered rows and the tail", () => {
    const previous = ["old", "a", "uncovered", "b", "newer-tail"].map(row);
    const page = ["before-a", "a", "between", "b", "after-b"].map(row);
    expect(ids(mergeOrderedPersistedHistory(previous, page, "latest"))).toEqual([
      "old",
      "before-a",
      "a",
      "uncovered",
      "between",
      "b",
      "after-b",
      "newer-tail",
    ]);
  });

  it.each(["latest", "older"] as const)(
    "uses the explicit %s direction when there are no shared identities",
    (direction) => {
      const previous = [row("loaded-a"), row("loaded-b")];
      const page = [row("page-a"), row("page-b")];
      expect(mergeOrderedPersistedHistory(previous, page, direction)).toEqual(
        direction === "latest" ? [...previous, ...page] : [...page, ...previous],
      );
      expect(mergeOrderedPersistedHistory(previous, [], direction)).toEqual(previous);
      expect(mergeOrderedPersistedHistory([], page, direction)).toEqual(page);
    },
  );

  it("uses incoming contents once per ID and preserves the incoming anchor order", () => {
    const updated = { ...row("a"), content: "updated" };
    const previous = [row("old"), row("a"), row("b"), row("a"), row("tail")];
    const page = [row("b"), row("result-b"), row("a"), updated];
    expect(mergeOrderedPersistedHistory(previous, page, "older")).toEqual([
      previous[0],
      page[0],
      page[1],
      updated,
      previous[4],
    ]);
  });

  it("fills consecutive history-only gaps immediately before their newer loaded range", () => {
    const previous = ["old-page", "latest-a", "latest-b", "native-tail"].map(row);
    const newerGap = ["gap-3", "gap-4"].map(row);
    const olderGap = ["gap-1", "gap-2"].map(row);
    const partial = mergeOrderedPersistedHistory(previous, newerGap, "older", false, [
      "latest-a",
      "latest-b",
    ]);
    const merged = mergeOrderedPersistedHistory(partial, olderGap, "older", false, [
      "gap-3",
      "gap-4",
    ]);
    expect(ids(merged)).toEqual([
      "old-page",
      "gap-1",
      "gap-2",
      "gap-3",
      "gap-4",
      "latest-a",
      "latest-b",
      "native-tail",
    ]);
  });

  it.each([false, true])(
    "places a nonempty continuation after its older window when the latest page was empty (newer gap: %s)",
    (newerGap) => {
      const previous = ["old-a", "old-b", ...(newerGap ? ["newer-a", "newer-b"] : [])].map(row);
      const middle = ["middle-a", "middle-b"].map(row);
      expect(
        ids(mergeOrderedPersistedHistory(previous, middle, "older", false, [], ["old-a", "old-b"])),
      ).toEqual([
        "old-a",
        "old-b",
        "middle-a",
        "middle-b",
        ...(newerGap ? ["newer-a", "newer-b"] : []),
      ]);
    },
  );

  it("prefers a visible before boundary over an after boundary", () => {
    const previous = ["old", "newer", "tail"].map(row);
    expect(
      ids(
        mergeOrderedPersistedHistory(
          previous,
          [row("middle")],
          "older",
          false,
          ["newer"],
          ["tail"],
        ),
      ),
    ).toEqual(["old", "middle", "newer", "tail"]);
  });

  it("skips retired insertion boundaries and falls back to direction when none survive", () => {
    const retired = { ...row("retired"), turn_id: "turn", ephemeral: true };
    const final = {
      ...row("persisted-final"),
      turn_id: "turn",
      message_phase: "final_answer" as const,
    };
    const old = row("old");
    const tail = row("tail");
    expect(
      mergeOrderedPersistedHistory([old, retired, tail], [final], "older", false, [
        "retired",
        "tail",
      ]),
    ).toEqual([old, final, tail]);
    expect(
      mergeOrderedPersistedHistory([old, retired, tail], [final], "older", false, ["retired"]),
    ).toEqual([final, old, tail]);
    expect(
      mergeOrderedPersistedHistory([old, retired, tail], [final], "latest", false, ["retired"]),
    ).toEqual([old, tail, final]);
    expect(
      mergeOrderedPersistedHistory(
        [old, retired, tail],
        [final],
        "older",
        false,
        [],
        ["old", "retired"],
      ),
    ).toEqual([old, final, tail]);
    expect(
      mergeOrderedPersistedHistory([old, retired, tail], [final], "older", false, [], ["retired"]),
    ).toEqual([final, old, tail]);
  });

  it("prefers actual shared anchors over a fallback insertion boundary", () => {
    const previous = [row("old"), row("shared"), row("tail")];
    const page = [row("before-shared"), row("shared")];
    expect(mergeOrderedPersistedHistory(previous, page, "older", false, ["old"])).toEqual([
      previous[0],
      ...page,
      previous[2],
    ]);
  });

  it("retires completed-turn overlays while preserving unrelated history", () => {
    const overlay = { ...row("native-reply"), turn_id: "turn", ephemeral: true };
    const final = {
      ...row("persisted-final"),
      turn_id: "turn",
      message_phase: "final_answer" as const,
    };
    const old = row("old");
    expect(mergeOrderedPersistedHistory([old, overlay], [final], "latest")).toEqual([old, final]);
    expect(mergeOrderedPersistedHistory([old, overlay], [final], "latest", true)).toEqual([
      old,
      overlay,
      final,
    ]);
    const user = { ...row("persisted-user"), kind: "user-message" as const, turn_id: "turn" };
    expect(mergeOrderedPersistedHistory([old, overlay], [user, final], "latest", true)).toEqual([
      old,
      user,
      final,
    ]);
  });

  it("uses the position of a retired same-ID preview without moving it after newer history", () => {
    const preview = { ...row("reply"), content: "prefix", ephemeral: true, truncated: true };
    const full = { ...row("reply"), content: "prefix and persisted tail" };
    const previous = [row("old"), preview, row("newer")];
    expect(mergeOrderedPersistedHistory(previous, [full], "latest", true)).toEqual([
      previous[0],
      full,
      previous[2],
    ]);
  });
});

describe("session model", () => {
  it("retires only explicit overlays for a turn with a persisted final answer", () => {
    const item = {
      id: "overlay",
      kind: "agent-message" as const,
      turn_id: "completed",
      content: "same words",
      ephemeral: true,
      attachment_count: 0,
      truncated: false,
    };
    const active = { ...item, id: "active", turn_id: "running" };
    const historical = { ...item, id: "past", turn_id: "past", ephemeral: false };
    const final = {
      ...item,
      id: "native-final",
      message_phase: "final_answer" as const,
      ephemeral: false,
    };
    expect(mergePersistedHistory([item, active, historical], [])).toEqual([
      item,
      active,
      historical,
    ]);
    expect(
      mergePersistedHistory([item, active, historical], [final]).map((event) => event.id),
    ).toEqual(["active", "past", "native-final"]);
  });
  it("validates both text and UTF-8 byte limits", () => {
    expect(isValidMessage("hello")).toBe(true);
    expect(isValidMessage("", true)).toBe(true);
    expect(isValidMessage(" ", true)).toBe(true);
    expect(isValidMessage("文".repeat(6000), true)).toBe(false);
    expect(isValidMessage("a".repeat(16001), true)).toBe(false);
    expect(isValidMessage(" ")).toBe(false);
    expect(isValidMessage("文".repeat(6000))).toBe(false);
  });

  it("replaces a whole native turn only when history includes both its start and final answer", () => {
    const base = { turn_id: "turn", ephemeral: true, attachment_count: 0, truncated: false };
    const user = { ...base, id: "native-user", kind: "user-message" as const, content: "prompt" };
    const tool = { ...base, id: "native-tool", kind: "tool-summary" as const };
    const reply = { ...base, id: "native-reply", kind: "agent-message" as const, content: "done" };
    const persistedFinal = { ...reply, ephemeral: false, message_phase: "final_answer" as const };
    expect(mergePersistedHistory([user, tool, reply], [persistedFinal], true)).toEqual([
      user,
      tool,
      persistedFinal,
    ]);
    const fullHistory = [
      { ...user, id: "indexed-user", ephemeral: false },
      { ...persistedFinal, id: "indexed-final" },
    ];
    expect(mergePersistedHistory([user, tool, reply], fullHistory, true)).toEqual(fullHistory);
  });

  it("does not overwrite a newer live item with an unfinished persisted fragment", () => {
    const live = {
      id: "native-reply",
      kind: "agent-message" as const,
      turn_id: "turn",
      content: "new text",
      ephemeral: true,
      attachment_count: 0,
      truncated: false,
    };
    expect(
      mergeNativeCoverage([{ ...live, content: "new", ephemeral: false }], {
        items: [live],
        authoritativeTurnIds: [],
        removedTurnIds: [],
        preserveItemsOutsideCoverage: true,
      }),
    ).toEqual([live]);
  });

  it.each(["a", "文", "😀"])(
    "restores persisted text beyond the native preview budget (%s)",
    (character) => {
      const prefix = character.repeat(
        Math.floor((128 * 1024) / new TextEncoder().encode(character).length),
      );
      const live = {
        id: "native-reply",
        kind: "agent-message" as const,
        turn_id: "turn",
        content: prefix,
        ephemeral: true,
        attachment_count: 0,
        truncated: true,
      };
      // A history page need not contain the start/final markers of this turn.
      const persisted = {
        ...live,
        content: prefix + "full tail",
        ephemeral: false,
        truncated: false,
      };
      const coverage = {
        items: [live],
        authoritativeTurnIds: [],
        removedTurnIds: [],
        preserveItemsOutsideCoverage: true,
      };
      expect(mergeNativeCoverage([persisted], coverage)).toEqual([persisted]);
      // Replayed snapshots must not shorten the text after it has been restored.
      expect(mergeNativeCoverage(mergeNativeCoverage([persisted], coverage), coverage)).toEqual([
        persisted,
      ]);
      const longerPreview = { ...persisted, truncated: true };
      expect(mergeNativeCoverage([longerPreview], coverage)).toEqual([longerPreview]);
    },
  );

  it.each(["prefix", "different full contents"])(
    "keeps a truncated native update over stale persisted text (%s)",
    (content) => {
      const live = {
        id: "native-reply",
        kind: "agent-message" as const,
        turn_id: "turn",
        content: "prefix and new contents",
        ephemeral: true,
        attachment_count: 0,
        truncated: true,
      };
      expect(
        mergeNativeCoverage([{ ...live, content, ephemeral: false, truncated: false }], {
          items: [live],
          authoritativeTurnIds: [],
          removedTurnIds: [],
          preserveItemsOutsideCoverage: true,
        }),
      ).toEqual([live]);
    },
  );

  it("merges refreshed events without losing paged history", () => {
    const merged = mergeLatestPage(
      {
        events: [
          {
            id: "old",
            kind: "agent-message",
            content: "old",
            attachment_count: 0,
            truncated: false,
          },
          {
            id: "current",
            kind: "agent-message",
            content: "current",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: ["older warning"],
        next_cursor: "cursor",
      },
      {
        events: [
          {
            id: "current",
            kind: "agent-message",
            content: "updated",
            attachment_count: 0,
            truncated: false,
          },
          {
            id: "new",
            kind: "agent-message",
            content: "new",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: ["latest warning"],
      },
    );

    expect(merged.events.map((event) => event.id)).toEqual(["old", "current", "new"]);
    expect(merged.events[1].content).toBe("updated");
    expect(merged.warnings).toEqual(["older warning", "latest warning"]);
    expect(merged.next_cursor).toBe("cursor");
  });
});
