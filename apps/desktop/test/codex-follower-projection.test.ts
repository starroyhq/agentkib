// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConversationStore,
  mergeNativeCoverage,
  type ConversationEvent,
  type SessionStreamEvent,
} from "@agentkib/conversation-state";
import { CodexFollowerState } from "../../../packages/backend/src/codex-follower-state";
import {
  CodexFollowerStream,
  mergeCodexFollowerSnapshot,
} from "../../../packages/backend/src/codex-follower-stream";
import { SessionStreamHub } from "../../../packages/backend/src/session-stream";

type Item = Record<string, unknown>;
const hubs: SessionStreamHub[] = [];
const sessionId = "follower-session";
const nativeId = "01234567-89ab-cdef-0123-456789abcdef";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

function item(id: string, content: string, extra: Item = {}): Item {
  return {
    id,
    kind: "agent-message",
    turn_id: "turn-a",
    content,
    message_phase: "commentary",
    attachment_count: 0,
    truncated: false,
    ephemeral: true,
    ...extra,
  };
}

/** Exercises the producer, batching/replay hub and the desktop/web consumer together. */
function fixture(initialItems: Item[] = [], residentOverlay = false) {
  const client = createConversationStore(sessionId);
  const stream = new CodexFollowerStream();
  const delivered: SessionStreamEvent[] = [];
  const projected: Array<{ type: string; payload: Item }> = [];
  let fileItems = initialItems;
  const hub = new SessionStreamHub(
    "fixture-boot",
    async () => {
      const history = { items: fileItems, completeItems: false };
      return {
        live: { sessionId, turnId: "turn-a", status: "running", streamText: "" },
        ...(residentOverlay ? mergeCodexFollowerSnapshot(history, stream.snapshot()) : history),
      };
    },
    (event) => {
      const value = event as SessionStreamEvent;
      delivered.push(value);
      client.dispatch(value);
    },
  );
  hubs.push(hub);
  const publish = (items: Item[], authoritativeTurnIds = ["turn-a"], live: Item = {}) => {
    stream.publish(
      { items, authoritativeTurnIds },
      {
        sessionId,
        turnId: "turn-a",
        status: "running",
        streamText: "Whole turn must not leak",
        ...live,
      },
      (type, payload, state, textItem) => {
        projected.push({ type, payload });
        hub.publish(sessionId, type, payload, state, textItem);
      },
    );
  };
  return {
    client,
    delivered,
    projected,
    publish,
    hub,
    setHistory: (items: Item[]) => {
      fileItems = items;
    },
    async subscribe() {
      const result = await hub.subscribe(sessionId);
      for (const event of result.events) client.dispatch(event as SessionStreamEvent);
      return result;
    },
    flush: () => vi.advanceTimersByTimeAsync(20),
  };
}

describe("native Codex message stream projection", () => {
  it("includes an already-generated resident reply in the first baseline without needing another token", async () => {
    const f = fixture([], true);
    f.publish([
      item("native-user", "Question", { kind: "user-message" }),
      item("reply-a", "Waiting for a tool"),
      item("native-tool", "", { kind: "tool-summary", tool_name: "commandExecution" }),
    ]);
    const first = await f.subscribe();
    expect(f.client.getSnapshot().items.map(({ id }) => id)).toEqual([
      "native-user",
      "reply-a",
      "native-tool",
    ]);
    f.hub.unsubscribe(first.subscriptionId);
    await f.subscribe();
    expect(f.client.getSnapshot().items.find(({ id }) => id === "reply-a")?.content).toBe(
      "Waiting for a tool",
    );
    expect(f.client.getSnapshot().resyncRequired).toBeUndefined();
  });

  it("restores a single-message baseline when early notifications preceded subscription", async () => {
    const f = fixture();
    // The native follower can connect while the initial hub snapshot is still loading.
    f.publish([item("reply-a", "Already generated")]);
    await f.subscribe();
    f.publish([item("reply-a", "Already generated and still growing")]);
    await f.flush();

    expect(f.client.getSnapshot()).toMatchObject({
      streamText: "",
      items: [{ id: "reply-a", content: "Already generated and still growing" }],
    });
    expect(f.client.getSnapshot().resyncRequired).toBeUndefined();
    expect(f.delivered.at(-1)?.type).toBe("item-upsert");
    expect(JSON.stringify(f.client.getSnapshot().items)).not.toContain("Whole turn");
  });

  it("keeps commentary, tools and the final answer in separate messages", async () => {
    const tool = item("tool-a", "", { kind: "tool-summary", tool_name: "commandExecution" });
    const f = fixture([tool]);
    await f.subscribe();
    f.publish([item("reply-a", "Checking"), tool]);
    f.publish([item("reply-a", "Checking the files"), tool]);
    f.publish([
      item("reply-a", "Checking the files"),
      tool,
      item("reply-b", "Result", { message_phase: "final_answer" }),
    ]);
    f.publish([
      item("reply-a", "Checking the files"),
      tool,
      item("reply-b", "Result is ready", { message_phase: "final_answer" }),
    ]);
    await f.flush();

    const state = f.client.getSnapshot();
    expect(state.resyncRequired).toBeUndefined();
    expect(state.streamText).toBe("");
    expect(state.items.map(({ id, content }) => [id, content])).toEqual([
      ["tool-a", ""],
      ["reply-a", "Checking the files"],
      ["reply-b", "Result is ready"],
    ]);
    expect(state.items.find(({ id }) => id === "reply-b")?.message_phase).toBe("final_answer");
    const reconnected = createConversationStore(sessionId);
    const baseline = await f.hub.subscribe(sessionId);
    for (const event of baseline.events) reconnected.dispatch(event as SessionStreamEvent);
    expect(reconnected.getSnapshot().items.find(({ id }) => id === "reply-b")).toMatchObject({
      content: "Result is ready",
      message_phase: "final_answer",
    });
    expect(
      f.projected.filter(({ type }) => type === "text-delta").map(({ payload }) => payload),
    ).toEqual([
      expect.objectContaining({ itemId: "reply-a", offset: 8, text: " the files" }),
      expect.objectContaining({ itemId: "reply-b", offset: 6, text: " is ready" }),
    ]);
  });

  it("does not duplicate repeated snapshots or replayed text", async () => {
    const f = fixture();
    await f.subscribe();
    f.publish([item("reply-a", "A")]);
    f.publish([item("reply-a", "ABC")]);
    f.publish([item("reply-a", "ABC")]);
    await f.flush();
    const applied = f.delivered.at(-1)!;
    f.client.dispatch(applied);

    expect(f.client.getSnapshot().items).toMatchObject([{ id: "reply-a", content: "ABC" }]);
    expect(f.client.getSnapshot().resyncRequired).toBeUndefined();
    expect(f.projected.filter(({ type }) => type === "text-delta")).toHaveLength(1);
  });

  it("replaces rewritten or shortened text and metadata without appending obsolete content", async () => {
    const f = fixture();
    await f.subscribe();
    f.publish([item("reply-a", "Original text")]);
    f.publish([item("reply-a", "Short")]);
    f.publish([item("reply-a", "Short final", { message_phase: "final_answer", truncated: true })]);
    await f.flush();

    expect(f.client.getSnapshot().items).toMatchObject([
      { id: "reply-a", content: "Short final", message_phase: "final_answer", truncated: true },
    ]);
    expect(f.projected.filter(({ type }) => type === "text-delta")).toHaveLength(0);
    expect(f.projected.filter(({ type }) => type === "item-upsert")).toHaveLength(3);
  });

  it("removes a native-deleted message only within authoritative turn coverage", async () => {
    const f = fixture();
    await f.subscribe();
    f.publish([item("reply-a", "Remove me"), item("reply-b", "Keep me")]);
    f.publish([item("reply-b", "Keep me")]);
    await f.flush();

    expect(f.client.getSnapshot().items).toMatchObject([{ id: "reply-b", content: "Keep me" }]);
    expect(f.projected.find(({ type }) => type === "snapshot")?.payload).toMatchObject({
      replaceItemIds: ["reply-a"],
    });
  });

  it("retains prior messages when the bounded native window no longer covers them", async () => {
    const f = fixture();
    await f.subscribe();
    f.publish([item("reply-a", "Earlier text")]);
    f.publish([item("reply-b", "Current text")], []);
    await f.flush();

    expect(f.client.getSnapshot().items.map(({ id }) => id)).toEqual(["reply-a", "reply-b"]);
    expect(f.projected.filter(({ type }) => type === "snapshot")).toHaveLength(0);
  });

  it("retires a windowed-out overlay once its turn is authoritatively covered again", async () => {
    const f = fixture();
    await f.subscribe();
    f.publish([item("reply-a", "Earlier text")]);
    f.publish([item("reply-b", "Current text")], []);
    f.publish([item("reply-b", "Current text")]);
    await f.flush();
    expect(f.client.getSnapshot().items.map(({ id }) => id)).toEqual(["reply-b"]);
    expect(f.delivered.at(-1)).toMatchObject({
      type: "snapshot",
      payload: { removedItemIds: ["reply-a"] },
    });
  });

  it("does not roll live text back when the next quiet snapshot poll reads an older file prefix", async () => {
    const f = fixture();
    await f.subscribe();
    f.publish([item("reply-a", "The full live answer")]);
    f.setHistory([item("reply-a", "The full", { ephemeral: false })]);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.client.getSnapshot().items).toMatchObject([
      { id: "reply-a", content: "The full live answer" },
    ]);
  });

  it("replaces file message identities while keeping user images, tool details and repeated replies in native order", async () => {
    const user = item("event-10", "Question", {
      kind: "user-message",
      images: [{ id: "user-image" }],
      ephemeral: false,
    });
    const tool = item("event-30", "Detailed command result", {
      kind: "tool-summary",
      tool_name: "exec_command",
      ephemeral: false,
    });
    const history = [
      user,
      item("event-20", "Same reply", { ephemeral: false, images: [{ id: "result-image" }] }),
      tool,
      item("event-40", "Same reply", { ephemeral: false }),
    ];
    const f = fixture(history, true);
    f.publish([
      item("native-user", "Question", { kind: "user-message" }),
      item("native-a", "Same reply"),
      item("native-tool", "", { kind: "tool-summary", tool_name: "commandExecution" }),
      item("native-b", "Same reply"),
    ]);
    await f.subscribe();
    const state = f.client.getSnapshot();
    expect(state.items.map(({ id }) => id)).toEqual([
      "event-10",
      "native-a",
      "event-30",
      "native-b",
    ]);
    expect(state.items[0].images).toEqual([{ id: "user-image" }]);
    expect(state.items[1].images).toEqual([{ id: "result-image" }]);
    expect(state.items[2].content).toBe("Detailed command result");
    expect(state.items.filter(({ content }) => content === "Same reply")).toHaveLength(2);
    const baseline = (await f.hub.subscribe(sessionId)).events[0];
    expect(baseline).toMatchObject({
      type: "snapshot",
      payload: { authoritativeTurnIds: ["turn-a"] },
    });
    if (baseline.type !== "snapshot") throw new Error("Expected native baseline");
    const visible = mergeNativeCoverage(history as unknown as ConversationEvent[], {
      items: state.items,
      authoritativeTurnIds: baseline.payload.authoritativeTurnIds ?? [],
      removedTurnIds: [],
      preserveItemsOutsideCoverage: true,
    });
    expect(visible.map(({ id }) => id)).toEqual(["event-10", "native-a", "event-30", "native-b"]);
  });

  it("does not append duplicate native message identities when a bounded file page lacks turn coverage", () => {
    const history = [item("event-20", "File reply", { ephemeral: false })];
    const merged = mergeCodexFollowerSnapshot(
      { items: history, completeItems: false },
      {
        items: [item("native-a", "Live reply")],
        authoritativeTurnIds: ["turn-a"],
      },
    );
    expect(merged.authoritativeTurnIds).toEqual([]);
    expect(merged.items.map(({ id }) => id)).toEqual(["event-20"]);
    expect(merged.items[0].content).toBe("File reply");
  });

  it("can update a verified matching identity without duplicating a partially covered file turn", () => {
    const merged = mergeCodexFollowerSnapshot(
      {
        items: [item("native-a", "Old prefix", { ephemeral: false })],
        completeItems: false,
      },
      { items: [item("native-a", "Old prefix and live tail")], authoritativeTurnIds: [] },
    );
    expect(merged.items).toMatchObject([{ id: "native-a", content: "Old prefix and live tail" }]);
    expect(merged.authoritativeTurnIds).toEqual([]);
  });

  it("retains a verified empty turn boundary after its last live message was removed", () => {
    const stream = new CodexFollowerStream();
    stream.publish(
      { items: [item("reply-a", "Removed")], authoritativeTurnIds: ["turn-a"] },
      { turnId: "turn-a", status: "running" },
      () => {},
    );
    stream.publish(
      { items: [], authoritativeTurnIds: ["turn-a"] },
      { turnId: null, status: "idle" },
      () => {},
    );
    expect(stream.snapshot()).toEqual({ items: [], authoritativeTurnIds: ["turn-a"] });
  });

  it("does not replace unobserved older native turns from the resident snapshot window", () => {
    const stream = new CodexFollowerStream();
    stream.publish(
      {
        items: [
          item("old-native", "Earlier native body", { turn_id: "older" }),
          item("current-native", "Current"),
        ],
        authoritativeTurnIds: ["older", "turn-a"],
      },
      { turnId: "turn-a", status: "running" },
      () => {},
    );
    expect(stream.snapshot().items.map(({ id }) => id)).toEqual(["current-native"]);
    expect(stream.snapshot().authoritativeTurnIds).toEqual(["turn-a"]);
  });

  it("does not regress a longer live overlay when initial history has an older prefix", async () => {
    const f = fixture([item("reply-a", "Old")]);
    f.publish([item("reply-a", "Old and newer")]);
    await f.subscribe();
    f.publish([item("reply-a", "Old and newer text")]);
    await f.flush();

    expect(f.client.getSnapshot().items).toMatchObject([
      { id: "reply-a", content: "Old and newer text" },
    ]);
    expect(f.client.getSnapshot().resyncRequired).toBeUndefined();
  });
});

describe("native follower window coverage", () => {
  it("publishes a verified interruption after an observed turn loses its active ID", async () => {
    const native = new CodexFollowerState(nativeId, "owner");
    const f = fixture();
    const publish = (revision: number, status: string) => {
      native.notification({
        type: "broadcast",
        method: "thread-stream-state-changed",
        version: 11,
        sourceClientId: "owner",
        params: {
          conversationId: nativeId,
          hostId: "local",
          change: {
            type: "snapshot",
            revision,
            conversationState: {
              id: nativeId,
              hostId: "local",
              threadRuntimeStatus: { type: status === "inProgress" ? "active" : "idle" },
              requests: [],
              turns: [{ turnId: "turn-a", status, items: [], durationMs: 15 }],
            },
          },
        },
      });
      const snapshot = native.streamSnapshot();
      f.publish(snapshot.items, snapshot.authoritativeTurnIds, snapshot.live);
    };

    await f.subscribe();
    publish(1, "inProgress");
    publish(2, "unknown");
    await f.flush();
    expect(f.client.getSnapshot().items).toHaveLength(0);
    publish(3, "interrupted");
    await f.flush();
    expect(native.activeTurn()).toBeNull();
    expect(f.client.getSnapshot().items).toMatchObject([
      {
        id: "codex-turn-end:turn-a",
        content: null,
        turn_meta: { outcome: "aborted", duration_ms: 15 },
      },
    ]);
  });

  it("keeps earlier persisted content when a sparse native snapshot reports a turn ending", () => {
    const reply = item("persisted", "Progress from the rollout");
    const newer = item("newer", "Next turn", { turn_id: "turn-b" });
    const marker = item("codex-turn-end:turn-a", "", {
      content: null,
      turn_meta: { outcome: "aborted" },
    });
    const failure = item("codex-turn-error:turn-a", "Codex error", {
      cli_output: true,
      turn_meta: { outcome: "failed" },
    });
    for (const terminal of [marker, failure]) {
      for (const completeItems of [false, true]) {
        expect(
          mergeCodexFollowerSnapshot(
            { items: [reply, newer], completeItems },
            { items: [terminal], authoritativeTurnIds: ["turn-a"] },
          ).items,
        ).toEqual([reply, terminal, newer]);
      }
    }
  });

  it("does not call a turn authoritative when its message projection exceeds the retained window", () => {
    const native = new CodexFollowerState(nativeId, "owner");
    native.notification({
      type: "broadcast",
      method: "thread-stream-state-changed",
      version: 11,
      sourceClientId: "owner",
      params: {
        conversationId: nativeId,
        hostId: "local",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            id: nativeId,
            hostId: "local",
            threadRuntimeStatus: { type: "active" },
            requests: [],
            turns: [
              {
                turnId: "large-turn",
                status: "inProgress",
                items: Array.from({ length: 101 }, (_, index) => ({
                  id: `reply-${index}`,
                  type: "agentMessage",
                  phase: "commentary",
                  text: String(index),
                })),
              },
            ],
          },
        },
      },
    });

    const snapshot = native.streamSnapshot();
    expect(snapshot.items).toHaveLength(100);
    expect(snapshot.items[0]).toMatchObject({ id: "reply-1", message_phase: "commentary" });
    expect(snapshot.authoritativeTurnIds).not.toContain("large-turn");
  });
});
