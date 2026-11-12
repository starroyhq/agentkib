import { describe, expect, it } from "vitest";
import type { ConversationEvent } from "@/core/types";
import { turnFileActivity } from "@agentkib/conversation-state";
import { groupConversationEvents } from "./conversation-groups";

function event(
  id: string,
  kind: ConversationEvent["kind"],
  metadata: Partial<{ turn_id: string | null; message_phase: "commentary" | "final_answer" }> = {},
  extra: Partial<ConversationEvent> = {},
): ConversationEvent {
  return {
    id,
    kind,
    content: id,
    attachment_count: 0,
    truncated: false,
    ...metadata,
    ...extra,
  } as ConversationEvent;
}

describe("groupConversationEvents", () => {
  it("does not mistake a later user message for the missing start of a turn", () => {
    const groups = groupConversationEvents([
      event("earlier-commentary", "agent-message", {
        turn_id: "partial",
        message_phase: "commentary",
      }),
      event("later-user", "user-message", { turn_id: "partial" }),
      event("final", "agent-message", { turn_id: "partial", message_phase: "final_answer" }),
    ]);
    expect(groups[0].complete).toBe(false);
    expect(groups[0].segments[0].collapsible).toBe(false);
  });
  it("keeps legacy records as ordered fallback groups without inventing turns", () => {
    const groups = groupConversationEvents([
      event("old-user", "user-message"),
      event("old-agent", "agent-message"),
      event("old-tool", "tool-summary"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].events.map(({ id }) => id)).toEqual(["old-user", "old-agent", "old-tool"]);
    expect(groups.every((group) => group.turnId === undefined)).toBe(true);
    expect(groups[0].segments.map((segment) => segment.collapsible)).toEqual([false, false, true]);
  });

  it("does not cross missing metadata or merge a repeated non-contiguous id", () => {
    const groups = groupConversationEvents([
      event("a-user", "user-message", { turn_id: "turn-a" }),
      event("legacy-gap", "agent-message"),
      event("a-final", "agent-message", { turn_id: "turn-a", message_phase: "final_answer" }),
      event(
        "a-again",
        "tool-summary",
        { turn_id: "turn-a" },
        {
          turn_meta: { outcome: "completed" },
        },
      ),
    ]);

    expect(groups.map((group) => group.turnId)).toEqual(["turn-a", undefined, "turn-a"]);
    expect(groups.map((group) => group.events[0].id)).toEqual(["a-user", "legacy-gap", "a-final"]);
    expect(groups[2].events.map(({ id }) => id)).toEqual(["a-final", "a-again"]);
    expect(groups[2].outcome).toBe("completed");
    expect(turnFileActivity(groups[2])).toBeUndefined();
  });

  it("folds contiguous commentary and tools only in a complete turn", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "turn-1" }),
      event("thought", "agent-message", { turn_id: "turn-1", message_phase: "commentary" }),
      event("tool", "tool-summary", { turn_id: "turn-1" }, { tool_status: "completed" }),
      event("more-thought", "agent-message", {
        turn_id: "turn-1",
        message_phase: "commentary",
      }),
      event(
        "final",
        "agent-message",
        { turn_id: "turn-1", message_phase: "final_answer" },
        { turn_meta: { outcome: "completed" } },
      ),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].complete).toBe(true);
    expect(groups[0].segments.map((segment) => [segment.kind, segment.collapsible])).toEqual([
      ["event", false],
      ["process", true],
      ["event", false],
    ]);
    expect(groups[0].segments[1].events.map(({ id }) => id)).toEqual([
      "thought",
      "tool",
      "more-thought",
    ]);
    expect(groups[0].segments[1].toolCount).toBe(1);
    expect(groups[0].segments[2].events[0].message_phase).toBe("final_answer");
  });

  it("keeps incomplete commentary open and only folds a contiguous tool run", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "partial" }),
      event("commentary", "agent-message", { turn_id: "partial", message_phase: "commentary" }),
      event("tool-1", "tool-summary", { turn_id: "partial" }),
      event("tool-2", "tool-summary", { turn_id: "partial" }),
      event("commentary-2", "agent-message", {
        turn_id: "partial",
        message_phase: "commentary",
      }),
    ]);

    expect(groups[0].complete).toBe(false);
    expect(groups[0].segments.map((segment) => segment.kind)).toEqual([
      "event",
      "event",
      "process",
      "event",
    ]);
    expect(groups[0].segments[1].collapsible).toBe(false);
    expect(groups[0].segments[2].events.map(({ id }) => id)).toEqual(["tool-1", "tool-2"]);
  });

  it("keeps a process containing failed tools collapsed and reports the failed count", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "failed" }),
      event("failed-tool", "tool-summary", { turn_id: "failed" }, { tool_status: "failed" }),
      event("final", "agent-message", { turn_id: "failed", message_phase: "final_answer" }),
    ]);

    const process = groups[0].segments[1];
    expect(groups[0].outcome).toBeUndefined();
    expect(process.toolCount).toBe(1);
    expect(process.failedToolCount).toBe(1);
    expect(process.defaultOpen).toBe(false);
  });

  it("leaves unclassified body events expanded and keeps the final in order", () => {
    const groups = groupConversationEvents([
      event("user", "user-message", { turn_id: "mixed" }),
      event("body", "agent-message", { turn_id: "mixed" }),
      event("commentary", "agent-message", { turn_id: "mixed", message_phase: "commentary" }),
      event("final", "agent-message", { turn_id: "mixed", message_phase: "final_answer" }),
    ]);

    expect(groups[0].segments.flatMap((segment) => segment.events.map(({ id }) => id))).toEqual([
      "user",
      "body",
      "commentary",
      "final",
    ]);
    expect(groups[0].segments[1].collapsible).toBe(false);
    expect(groups[0].segments[2].collapsible).toBe(false);
    expect(groups[0].segments[3].events[0].id).toBe("final");
  });

  it("keeps a group key stable when older events are prepended", () => {
    const current = groupConversationEvents([
      event("user", "user-message", { turn_id: "turn-1" }),
      event("final", "agent-message", { turn_id: "turn-1", message_phase: "final_answer" }),
    ])[0];
    const afterEarlier = groupConversationEvents([
      event("older-commentary", "agent-message", {
        turn_id: "turn-1",
        message_phase: "commentary",
      }),
      event("user", "user-message", { turn_id: "turn-1" }),
      event("final", "agent-message", { turn_id: "turn-1", message_phase: "final_answer" }),
    ])[0];

    expect(afterEarlier.key).toBe(current.key);
  });

  it("folds contiguous legacy tools without crossing an annotated turn", () => {
    const groups = groupConversationEvents([
      event("legacy-tool-1", "tool-summary"),
      event("legacy-tool-2", "tool-summary"),
      event("annotated-user", "user-message", { turn_id: "turn-2" }),
      event("legacy-tool-3", "tool-summary"),
    ]);

    expect(groups.map((group) => group.events.map(({ id }) => id))).toEqual([
      ["legacy-tool-1", "legacy-tool-2"],
      ["annotated-user"],
      ["legacy-tool-3"],
    ]);
    expect(groups[0].segments[0].collapsible).toBe(true);
    expect(groups[2].segments[0].collapsible).toBe(true);
  });

  it("can conservatively keep a turn incomplete when the page has warnings", () => {
    const events = [
      event("user", "user-message", { turn_id: "turn-3" }),
      event("commentary", "agent-message", { turn_id: "turn-3", message_phase: "commentary" }),
      event(
        "final",
        "agent-message",
        { turn_id: "turn-3", message_phase: "final_answer" },
        { turn_meta: { outcome: "completed" } },
      ),
    ];

    expect(groupConversationEvents(events)[0].complete).toBe(true);
    expect(groupConversationEvents(events, { incomplete: true })[0].complete).toBe(false);
    expect(groupConversationEvents(events, { incomplete: true })[0].outcome).toBe("completed");
  });

  it("keeps only the latest final response outside one process for a terminal turn fragment", () => {
    const metadata = { turn_id: "partial" };
    const [group] = groupConversationEvents(
      [
        event("old-answer", "agent-message", { ...metadata, message_phase: "final_answer" }),
        event("tool-1", "tool-summary", metadata),
        event("interim", "agent-message", metadata),
        event("tool-2", "tool-summary", metadata),
        event("new-answer-1", "agent-message", { ...metadata, message_phase: "final_answer" }),
        event("new-answer-2", "agent-message", { ...metadata, message_phase: "final_answer" }),
        event("tool-after-answer", "tool-summary", metadata, {
          turn_meta: { outcome: "completed", duration_ms: 23 },
        }),
      ],
      { incomplete: true },
    );
    expect(group).toMatchObject({ complete: false, durationMs: 23, outcome: "completed" });
    expect(group.segments.map((segment) => segment.events.map(({ id }) => id))).toEqual([
      ["old-answer", "tool-1", "interim", "tool-2", "tool-after-answer"],
      ["new-answer-1"],
      ["new-answer-2"],
    ]);
    expect(group.segments[0]).toMatchObject({
      kind: "process",
      outcome: "completed",
      defaultOpen: false,
      toolCount: 3,
    });
  });

  it("folds all assistant output of an aborted turn without hiding either user message", () => {
    const metadata = { turn_id: "stopped" };
    const [group] = groupConversationEvents([
      event("user", "user-message", metadata),
      event("working", "agent-message", metadata),
      event("follow-up", "user-message", metadata),
      event("tool", "tool-summary", metadata),
      event("partial-answer", "agent-message", metadata, { turn_meta: { outcome: "aborted" } }),
    ]);
    expect(group.outcome).toBe("aborted");
    expect(group.segments.map(({ kind, events }) => [kind, events.map(({ id }) => id)])).toEqual([
      ["event", ["user"]],
      ["process", ["working"]],
      ["event", ["follow-up"]],
      ["process", ["tool", "partial-answer"]],
    ]);
  });

  it("keeps a failed turn's terminal error outside the disclosure", () => {
    const metadata = { turn_id: "error" };
    const [group] = groupConversationEvents([
      event("user", "user-message", metadata),
      event("old-answer", "agent-message", { ...metadata, message_phase: "final_answer" }),
      event("tool", "tool-summary", metadata, { tool_status: "failed" }),
      event("error", "agent-message", metadata, {
        cli_output: true,
        turn_meta: { outcome: "failed" },
      }),
    ]);
    expect(group.segments.map(({ events }) => events.map(({ id }) => id))).toEqual([
      ["user"],
      ["old-answer", "tool"],
      ["error"],
    ]);
    expect(group.segments[1]).toMatchObject({
      kind: "process",
      outcome: "failed",
      defaultOpen: false,
      failedToolCount: 1,
    });
  });

  it("uses terminal metadata from hidden wrappers and omits empty turn markers from the body", () => {
    const [wrapped, empty] = groupConversationEvents(
      [
        event("reply", "agent-message", { turn_id: "wrap" }),
        event(
          "wrapper",
          "tool-summary",
          { turn_id: "wrap" },
          {
            turn_meta: { outcome: "aborted", duration_ms: 100 },
          },
        ),
        event(
          "codex-turn-end:empty",
          "agent-message",
          { turn_id: "empty" },
          {
            content: undefined,
            turn_meta: { outcome: "failed" },
          },
        ),
      ],
      { isHidden: ({ id }) => id === "wrapper" },
    );
    expect(wrapped).toMatchObject({
      outcome: "aborted",
      durationMs: 100,
      events: [{ id: "reply" }],
    });
    expect(empty).toMatchObject({
      outcome: "failed",
      events: [],
      segments: [{ kind: "process", outcome: "failed", events: [], collapsible: false }],
    });
  });

  it("keeps unknown replies visible when a completed legacy turn has no explicit final answer", () => {
    const metadata = { turn_id: "legacy" };
    const [group] = groupConversationEvents([
      event("user", "user-message", metadata),
      event("commentary", "agent-message", { ...metadata, message_phase: "commentary" }),
      event("tool", "tool-summary", metadata),
      event("unclassified", "agent-message", metadata, { turn_meta: { outcome: "completed" } }),
    ]);
    expect(group.segments.map(({ kind, events }) => [kind, events.map(({ id }) => id)])).toEqual([
      ["event", ["user"]],
      ["process", ["commentary", "tool"]],
      ["event", ["unclassified"]],
    ]);
  });
});
