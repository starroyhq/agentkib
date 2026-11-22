import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import {
  createWarmSessionStreamPool,
  useSessionLive,
  warmSessionAuthority,
  type WarmSessionNavigation,
} from "@agentkib/session-ui";
import type {
  Access,
  ConversationEventPage,
  Live,
  SessionStreamHandlers,
  WebClient,
} from "@agentkib/web-client";
import { ApiError } from "@agentkib/web-client";
import {
  subscribeSessionInvalidation,
  createHistoryPagination,
  recordLatestHistoryPage,
  beginHistoryRead,
  completeHistoryRead,
  failHistoryRead,
  type NativeCoverage,
} from "@agentkib/conversation-state";

const access: Access = {
  protocolVersion: 2,
  status: "approved",
  csrfToken: "",
  bootId: "boot",
  experimentalEnabled: true,
};
const initial: Live = {
  sessionId: "s",
  revision: 10,
  status: "running",
  sendEnabled: false,
  approvals: [],
  turnId: "turn",
};
const envelope = (seq: number, type: string, payload: unknown) => ({
  protocolVersion: 2,
  subscriptionId: "sub",
  sessionId: "s",
  runtimeBootId: "runtime",
  epoch: "epoch",
  seq,
  cursor: `c${seq}`,
  type,
  payload,
});
function setup(
  hasDurablePending = () => false,
  isSettingsWriteActive?: () => boolean,
  surface: "desktop" | "web" = "web",
) {
  const handlers: SessionStreamHandlers[] = [];
  const close = vi.fn();
  const client = {
    connection: { type: "same-origin" },
    stream: vi.fn((_id: string, listener: SessionStreamHandlers) => {
      handlers.push(listener);
      return close;
    }),
    events: vi.fn(),
    live: vi.fn().mockResolvedValue(initial),
  } as unknown as WebClient;
  const warmStreams = createWarmSessionStreamPool(client);
  const fail = vi.fn(),
    readBusy = vi.fn(),
    clear = vi.fn(),
    setError = vi.fn(),
    setAccess = vi.fn();
  const view = renderHook(() => {
    const [selected, setSelected] = useState("s");
    const [live, setLive] = useState<Live>();
    const [page, setPage] = useState<ConversationEventPage>();
    const [online, setOnline] = useState(false);
    const [ready, setControlReady] = useState(false);
    const [usageEpoch, setUsageEpoch] = useState("");
    const warmNavigation = useRef<WarmSessionNavigation>({});
    const liveValue = useRef(live);
    liveValue.current = live;
    const selection = useRef("s"),
      generation = useRef(0),
      liveDelivery = useRef(0);
    const accessRef = useRef<Access | undefined>(access),
      readinessEpoch = useRef(0),
      refreshWake = useRef(0),
      refreshRequired = useRef(false);
    const settingsInFlight = useRef<
      { sessionId: string; generation: number; controlChanged?: boolean } | undefined
    >(undefined);
    const readSettingsControls = useRef<
      ((sessionId: string, accept?: (live: Live) => boolean) => Promise<void>) | undefined
    >(undefined);
    const streamReady = useRef(false);
    const controlReconciliationPending = useRef(false);
    const nativeCoverage = useRef<NativeCoverage>({
      items: [] as ConversationEventPage["events"],
      authoritativeTurnIds: [] as string[],
      removedTurnIds: [] as string[],
    });
    selection.current = selected;
    useSessionLive({
      warmStreams,
      warmScope: warmSessionAuthority(access, 0),
      warmNavigation,
      liveValue,
      streamReady,
      controlReconciliationPending,
      nativeCoverage,
      streamEpoch: 0,
      liveDelivery,
      access,
      selected,
      selection,
      generation,
      client,
      fail,
      readBusy,
      refreshWake,
      clear,
      accessRef,
      setLive,
      setUsageEpoch,
      setOnline,
      setError,
      hasDurablePending,
      readSettingsControls,
      surface,
      settingsInFlight,
      isSettingsWriteActive,
      readinessEpoch,
      refreshRequired,
      setControlReady,
      setAccess,
      setPage,
    });
    return {
      live,
      usageEpoch,
      page,
      setPage,
      online,
      ready,
      nativeCoverage,
      settingsInFlight,
      readSettingsControls,
      readinessEpoch,
      choose: (id: string) => {
        generation.current++;
        setSelected(id);
      },
    };
  });
  const emit = (seq: number, type: string, payload: unknown, stream = handlers.at(-1)!) =>
    act(() => stream.event("session-event", JSON.stringify(envelope(seq, type, payload))));
  return { ...view, client, handlers, close, emit, clear, fail, readBusy, setError };
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe("native conversation event delivery", () => {
  it.each([false, true])(
    "retrieves history after a local settings write settles without broad refresh (late busy: %s)",
    async (lateBusy) => {
      vi.useFakeTimers();
      let changingSettings = true;
      const view = setup(
        () => false,
        () => changingSettings,
      );
      const row = (id: string) => ({
        id,
        kind: "agent-message" as const,
        content: id,
        attachment_count: 0,
        truncated: false,
      });
      let reject!: (error: ApiError) => void;
      vi.mocked(view.client.events)
        .mockImplementationOnce(() => new Promise((_, fail) => (reject = fail)))
        .mockResolvedValueOnce({ events: [row("native plan result")], warnings: [] });
      view.emit(0, "snapshot", { live: initial });
      act(() => view.result.current.setPage({ events: [row("earlier message")], warnings: [] }));
      view.emit(1, "invalidate", { domains: ["history"] });
      const settled = async () => {
        changingSettings = false;
        await act(async () =>
          view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })),
        );
      };
      if (lateBusy) await settled();
      await act(async () => reject(new ApiError(409, "operation_busy")));
      expect(view.client.events).toHaveBeenCalledOnce();
      expect(view.result.current.page?.events.map(({ id }) => id)).toEqual(["earlier message"]);
      if (!lateBusy) {
        view.emit(2, "invalidate", { domains: ["history"] });
        await act(async () => vi.advanceTimersByTimeAsync(200));
        expect(view.client.events).toHaveBeenCalledOnce();
        await settled();
      }
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(view.client.events).toHaveBeenCalledTimes(2);
      expect(view.readBusy).not.toHaveBeenCalled();
      expect(view.fail).not.toHaveBeenCalled();
      expect(view.result.current.page?.events.map(({ id }) => id)).toEqual(
        expect.arrayContaining(["earlier message", "native plan result"]),
      );
    },
  );

  it("keeps broad contention recovery for unrelated history reads", async () => {
    const view = setup();
    vi.mocked(view.client.events).mockRejectedValueOnce(new ApiError(409, "operation_busy"));
    view.emit(0, "snapshot", { live: initial });
    await act(async () => view.emit(1, "invalidate", { domains: ["history"] }));
    expect(view.readBusy).toHaveBeenCalledOnce();
  });

  it("resumes ordinary contention recovery if the post-settings history read is still busy", async () => {
    vi.useFakeTimers();
    const view = setup(
      () => false,
      () => true,
    );
    vi.mocked(view.client.events).mockRejectedValue(new ApiError(409, "operation_busy"));
    view.emit(0, "snapshot", { live: initial });
    await act(async () => view.emit(1, "invalidate", { domains: ["history"] }));
    expect(view.readBusy).not.toHaveBeenCalled();
    await act(async () =>
      view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })),
    );
    await act(async () => vi.advanceTimersByTimeAsync(50));
    expect(view.client.events).toHaveBeenCalledTimes(2);
    expect(view.readBusy).toHaveBeenCalledOnce();
  });

  it("publishes the native observation epoch and ignores usage from a retired epoch", () => {
    const view = setup();
    view.emit(0, "snapshot", {
      live: {
        ...initial,
        usage: { available: true, reportId: 50, usedTokens: 80, contextWindow: 100 },
      },
    });
    expect(view.result.current.usageEpoch).toBe(JSON.stringify(["runtime", "epoch"]));
    act(() =>
      view.handlers[0].event(
        "session-event",
        JSON.stringify({
          ...envelope(0, "snapshot", {
            live: {
              ...initial,
              usage: { available: true, reportId: 1, usedTokens: 5, contextWindow: 100 },
            },
          }),
          epoch: "replacement",
        }),
      ),
    );
    expect(view.result.current.usageEpoch).toBe(JSON.stringify(["runtime", "replacement"]));
    view.emit(1, "state", {
      usage: { available: true, reportId: 51, usedTokens: 99, contextWindow: 100 },
    });
    expect(view.result.current.live?.usage?.usedTokens).toBe(5);
  });
  it("preserves compaction progress and its explicit clear over an older control reconciliation", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    let finish!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    view.emit(1, "state", {
      revision: 11,
      activity: "compacting",
      usage: { available: false, state: "pending", reportId: 1 },
    });
    view.emit(2, "state", {
      revision: 12,
      activity: null,
      usage: { available: true, state: "ready", reportId: 2, usedTokens: 0, contextWindow: 100 },
    });
    await act(async () => finish({ ...initial, activity: "compacting" }));
    expect(view.client.live).toHaveBeenCalledOnce();
    expect(view.result.current.live).toMatchObject({
      revision: 12,
      activity: null,
      usage: { reportId: 2, usedTokens: 0 },
    });
    expect(view.result.current.ready).toBe(true);
  });
  it("applies deltas and authoritative items without polling or reloading history", async () => {
    vi.useFakeTimers();
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "text-delta", { itemId: "reply", turnId: "turn", offset: 0, text: "你" });
    view.emit(2, "text-delta", { itemId: "reply", turnId: "turn", offset: 1, text: "好" });
    expect(view.result.current.page?.events).toHaveLength(1);
    expect(view.result.current.page?.events[0].content).toBe("你好");
    expect(view.result.current.live?.revision).toBe(10);
    view.emit(3, "item-upsert", {
      id: "reply",
      kind: "agent-message",
      turn_id: "turn",
      content: "你好！",
      message_phase: "final_answer",
      attachment_count: 0,
      truncated: false,
    });
    expect(view.result.current.page?.events).toHaveLength(1);
    expect(view.result.current.page?.events[0].content).toBe("你好！");
    await act(() => vi.advanceTimersByTimeAsync(20000));
    expect(view.client.events).not.toHaveBeenCalled();
    expect(view.client.stream).toHaveBeenCalledTimes(1);
  });
  it("reboots only the subscription on a sequence gap and ignores the closed stream", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    const stale = view.handlers[0];
    view.emit(2, "text-delta", { itemId: "reply", offset: 0, text: "gap" });
    await act(async () => {});
    expect(view.close).toHaveBeenCalledOnce();
    expect(view.client.stream).toHaveBeenCalledTimes(2);
    view.emit(0, "snapshot", { live: { ...initial, status: "idle" } });
    view.emit(10, "snapshot", { live: initial }, stale);
    expect(view.result.current.live?.status).toBe("idle");
    expect(view.client.events).not.toHaveBeenCalled();
  });
  it("allows later recovery failures after each matching readiness confirms recovery", async () => {
    const view = setup();
    for (let attempt = 0; attempt < 5; attempt++) {
      view.emit(0, "snapshot", { live: initial });
      act(() => view.handlers.at(-1)!.event("session-ready", JSON.stringify({ cursor: "c0" })));
      view.emit(2, "state", { revision: 11 });
      await act(async () => {});
      expect(view.client.stream).toHaveBeenCalledTimes(attempt + 2);
    }
    view.emit(0, "snapshot", { live: initial });
    act(() => view.handlers.at(-1)!.event("session-ready", JSON.stringify({ cursor: "c0" })));
    expect(view.result.current.online).toBe(true);
    expect(view.result.current.ready).toBe(true);
    expect(view.client.events).not.toHaveBeenCalled();
  });
  it("bounds consecutive failed recoveries even when each broken stream provides a baseline", async () => {
    const view = setup();
    for (let attempt = 0; attempt < 4; attempt++) {
      view.emit(0, "snapshot", { live: initial });
      act(() =>
        view.handlers.at(-1)!.event("session-ready", JSON.stringify({ cursor: "not-applied" })),
      );
      view.emit(2, "state", { revision: 11 });
      await act(async () => {});
    }
    expect(view.client.stream).toHaveBeenCalledTimes(4);
    expect(view.close).toHaveBeenCalledTimes(4);
    expect(view.result.current.online).toBe(false);
    expect(view.result.current.ready).toBe(false);
  });
  it("refreshes detail domains once after a replacement baseline catches up", async () => {
    const view = setup();
    const invalidated = vi.fn();
    const unsubscribe = subscribeSessionInvalidation(view.client, invalidated);
    const ready = (cursor: string) =>
      act(() => view.handlers.at(-1)!.event("session-ready", JSON.stringify({ cursor })));
    view.emit(0, "snapshot", { live: initial });
    ready("c0");
    expect(invalidated).not.toHaveBeenCalled();
    act(() => view.handlers.at(-1)!.error());
    view.emit(8, "snapshot", { live: { ...initial, revision: 12 } });
    ready("wrong-cursor");
    expect(invalidated).not.toHaveBeenCalled();
    ready("c8");
    expect(invalidated).toHaveBeenCalledExactlyOnceWith("s", [
      "queue",
      "settings",
      "goal",
      "usage",
      "capabilities",
    ]);
    ready("c8");
    view.emit(9, "state", { revision: 13 });
    view.emit(10, "text-delta", { itemId: "reply", offset: 0, text: "streaming" });
    ready("c10");
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(view.client.events).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("uses replayed invalidations without rereading unrelated domains on replay readiness", async () => {
    const view = setup();
    const invalidated = vi.fn();
    const unsubscribe = subscribeSessionInvalidation(view.client, invalidated);
    view.emit(0, "snapshot", { live: initial });
    act(() => view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c0" })));
    act(() => view.handlers[0].error());
    view.emit(1, "invalidate", { domains: ["queue"] });
    await act(async () => {
      view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c1" }));
    });
    expect(invalidated.mock.calls).toEqual([
      ["s", ["queue"]],
      ["s", ["receipts"]],
    ]);
    expect(view.client.events).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("closes private state immediately when access ends", () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    act(() => view.handlers[0].event("access-ended", "{}"));
    expect(view.clear).toHaveBeenCalledOnce();
  });
  it("restores controls after empty replay only when readiness matches applied state", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    act(() => view.handlers[0].error());
    expect(view.result.current.ready).toBe(false);
    act(() => view.handlers[0].event("session-ready", JSON.stringify({ cursor: "unknown" })));
    expect(view.result.current.ready).toBe(false);
    await act(async () => {
      view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c0" }));
    });
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.online).toBe(true);
  });
  it("keeps live overlays until an authoritative replacement and preserves older history", () => {
    const view = setup();
    const old = {
      id: "past",
      kind: "agent-message",
      content: "older page",
      attachment_count: 0,
      truncated: false,
    };
    view.emit(0, "snapshot", { live: initial, items: [old] });
    view.emit(1, "snapshot", {
      live: initial,
      items: [{ ...old, id: "overlay", content: "active", ephemeral: true }],
    });
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual(["past", "overlay"]);
    view.emit(2, "state", { status: "idle" });
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual(["past", "overlay"]);
    view.emit(3, "snapshot", {
      live: { ...initial, status: "idle" },
      items: [{ ...old, id: "persisted", content: "active" }],
      replaceItems: true,
    });
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual([
      "past",
      "persisted",
    ]);
    view.emit(4, "snapshot", { live: initial, items: [], replaceItems: true });
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual(["past"]);
  });
  it("ignores a historical read that predates a native delta or replacement", async () => {
    vi.useFakeTimers();
    const view = setup();
    const finishes: ((page: ConversationEventPage) => void)[] = [];
    vi.mocked(view.client.events).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishes.push(resolve);
        }),
    );
    const reply = {
      id: "reply",
      kind: "agent-message" as const,
      content: "a",
      attachment_count: 0,
      truncated: false,
    };
    view.emit(0, "snapshot", { live: initial, items: [reply] });
    view.emit(1, "invalidate", { domains: ["history"] });
    view.emit(2, "text-delta", { itemId: "reply", offset: 1, text: "b" });
    await act(async () => {
      finishes[0]({ events: [reply], warnings: [] });
    });
    expect(view.result.current.page?.events[0].content).toBe("ab");
    await act(() => vi.advanceTimersByTimeAsync(50));
    view.emit(3, "invalidate", { domains: ["history"] });
    view.emit(4, "snapshot", { live: initial, items: [], replaceItems: true });
    await act(async () => {
      finishes[1]({ events: [reply], warnings: [] });
    });
    expect(view.result.current.page?.events).toEqual([]);
    await act(() => vi.advanceTimersByTimeAsync(50));
    await act(async () => finishes[2]({ events: [], warnings: [] }));
    expect(view.client.events).toHaveBeenCalledTimes(3);
    expect(view.result.current.page?.events).toEqual([]);
  });
  it.each(["a", "文", "😀"])(
    "restores completed history after a coverage snapshot invalidates its read (%s)",
    async (character) => {
      vi.useFakeTimers();
      const view = setup();
      const prefix = character.repeat(
        Math.floor((128 * 1024) / new TextEncoder().encode(character).length),
      );
      const reply = {
        id: "reply",
        kind: "agent-message" as const,
        turn_id: "turn",
        content: prefix,
        attachment_count: 0,
        truncated: false,
        ephemeral: true,
      };
      const preview = { ...reply, truncated: true };
      const persisted = {
        ...reply,
        content: prefix + "final tail",
        ephemeral: false,
        message_phase: "final_answer" as const,
      };
      const history = { events: [persisted], warnings: [] };
      let finish!: (page: ConversationEventPage) => void;
      vi.mocked(view.client.events)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue(history);
      view.emit(0, "snapshot", {
        live: initial,
        items: [reply],
        authoritativeTurnIds: ["turn"],
        preserveItemsOutsideCoverage: true,
      });
      // Follower completion publishes items, idle state and its history
      // invalidation before the snapshot that withdraws complete coverage.
      view.emit(1, "item-upsert", preview);
      view.emit(2, "state", { status: "idle", turnId: null, streamText: "" });
      view.emit(3, "invalidate", { domains: ["history", "catalog", "queue", "usage"] });
      view.emit(4, "snapshot", {
        live: { ...initial, status: "idle", turnId: undefined },
        items: [preview],
        replaceItems: true,
        authoritativeTurnIds: [],
        preserveItemsOutsideCoverage: true,
      });
      await act(async () => finish(history));
      expect(view.result.current.page?.events).toEqual([preview]);
      expect(view.client.events).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(50));
      expect(view.client.events).toHaveBeenCalledTimes(2);
      expect(view.result.current.page?.events).toEqual([persisted]);
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(view.client.events).toHaveBeenCalledTimes(2);
    },
  );
  it("coalesces overlapping invalidations and waits for pending native updates to settle", async () => {
    vi.useFakeTimers();
    const view = setup();
    const reply = {
      id: "reply",
      kind: "agent-message" as const,
      content: "a",
      attachment_count: 0,
      truncated: false,
    };
    const history = { ...reply, id: "older", content: "older history" };
    let finish!: (page: ConversationEventPage) => void;
    vi.mocked(view.client.events)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ events: [history, reply], warnings: [], next_cursor: "earlier" });
    view.emit(0, "snapshot", { live: initial, items: [reply] });
    view.emit(1, "invalidate", { domains: ["history"] });
    view.emit(2, "invalidate", { domains: ["history"] });
    view.emit(3, "invalidate", { domains: ["history"] });
    expect(view.client.events).toHaveBeenCalledOnce();
    await act(async () => finish({ events: [reply], warnings: [] }));
    await act(() => vi.advanceTimersByTimeAsync(40));
    view.emit(4, "text-delta", { itemId: "reply", offset: 1, text: "b" });
    await act(() => vi.advanceTimersByTimeAsync(40));
    view.emit(5, "text-delta", { itemId: "reply", offset: 2, text: "c" });
    await act(() => vi.advanceTimersByTimeAsync(49));
    expect(view.client.events).toHaveBeenCalledOnce();
    expect(view.result.current.page?.events[0].content).toBe("abc");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(view.client.events).toHaveBeenCalledTimes(2);
    expect(view.result.current.page?.events).toEqual([history, { ...reply, content: "abc" }]);
    expect(view.result.current.page?.next_cursor).toBe("earlier");
    view.emit(6, "text-delta", { itemId: "reply", offset: 3, text: "d" });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(view.client.events).toHaveBeenCalledTimes(2);
    expect(view.result.current.page?.events).toEqual([history, { ...reply, content: "abcd" }]);
  });
  it.each(["in-flight", "scheduled"])(
    "does not continue an obsolete history recovery after cleanup (%s)",
    async (phase) => {
      vi.useFakeTimers();
      const view = setup();
      let finish!: (page: ConversationEventPage) => void;
      vi.mocked(view.client.events).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      view.emit(0, "snapshot", { live: initial });
      view.emit(1, "invalidate", { domains: ["history"] });
      view.emit(2, "text-delta", { itemId: "reply", offset: 0, text: "new" });
      if (phase === "scheduled") await act(async () => finish({ events: [], warnings: [] }));
      view.unmount();
      if (phase === "in-flight") await act(async () => finish({ events: [], warnings: [] }));
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      expect(view.client.events).toHaveBeenCalledOnce();
      expect(view.fail).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not restore a legacy overlay when persisted completion arrived first", async () => {
    const view = setup();
    const final = {
      id: "persisted",
      kind: "agent-message" as const,
      turn_id: "turn",
      message_phase: "final_answer" as const,
      content: "done",
      attachment_count: 0,
      truncated: false,
    };
    vi.mocked(view.client.events).mockResolvedValue({ events: [final], warnings: [] });
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "invalidate", { domains: ["history"] });
    await act(async () => {});
    view.emit(2, "snapshot", {
      live: initial,
      items: [{ ...final, id: "ephemeral", ephemeral: true }],
    });
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual(["persisted"]);
  });
  it("removes only explicitly retracted persisted turns during native rollback", async () => {
    const view = setup();
    const item = {
      id: "keep",
      kind: "agent-message" as const,
      turn_id: "keep-turn",
      message_phase: "final_answer" as const,
      content: "same",
      attachment_count: 0,
      truncated: false,
    };
    vi.mocked(view.client.events).mockResolvedValue({
      events: [item, { ...item, id: "remove", turn_id: "remove-turn" }],
      warnings: [],
    });
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "invalidate", { domains: ["history"] });
    await act(async () => {});
    view.emit(2, "snapshot", {
      live: initial,
      items: [],
      replaceItems: true,
      removedTurnIds: ["remove-turn"],
    });
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual(["keep"]);
  });
  it("refreshes a changed control fence once without history and retains delivery readiness", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: { ...initial, status: "outcome-unknown", revision: null } });
    vi.mocked(view.client.live).mockResolvedValue(initial);
    await act(async () => {
      view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
    });
    expect(view.client.live).toHaveBeenCalledOnce();
    expect(view.client.events).not.toHaveBeenCalled();
    view.emit(1, "text-delta", { itemId: "reply", text: "a", offset: 0 });
    expect(view.result.current.live?.status).toBe("running");
    act(() => view.handlers[0].error());
    await act(async () => {
      view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
    });
    expect(view.result.current.ready).toBe(false);
    view.emit(2, "state", { revision: 11 });
    expect(view.result.current.ready).toBe(false);
    await act(async () => {
      view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c2" }));
    });
    expect(view.result.current.ready).toBe(true);
  });
  it.each(["desktop", "web"] as const)(
    "rejects a mismatched live response during %s control reconciliation",
    async (surface) => {
      const view = setup(undefined, undefined, surface);
      view.emit(0, "snapshot", { live: initial });
      vi.mocked(view.client.live).mockResolvedValue({
        ...initial,
        sessionId: "other",
        status: "idle",
      });
      await act(async () => {
        view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
      });

      expect(view.fail).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ status: 409, code: "session-state-unavailable" }),
        0,
      );
      expect(view.result.current.live).toMatchObject({ sessionId: "s", status: "running" });
      expect(view.result.current.ready).toBe(false);
    },
  );

  it.each(["desktop", "web"] as const)(
    "keeps %s online when a quiet settings readback fails",
    async (surface) => {
      const view = setup(undefined, undefined, surface);
      view.emit(0, "snapshot", { live: initial });
      act(() => view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c0" })));
      expect(view.result.current.ready).toBe(true);
      const failure = new ApiError(503, "session-state-unavailable");
      vi.mocked(view.client.live).mockRejectedValue(failure);

      await act(async () => {
        await view.result.current.readSettingsControls.current?.("s", () => true);
      });

      expect(view.client.live).toHaveBeenCalledExactlyOnceWith("s");
      expect(view.fail).not.toHaveBeenCalled();
      expect(view.result.current.online).toBe(true);
      expect(view.result.current.ready).toBe(false);
      expect(view.result.current.live).toMatchObject(initial);
    },
  );

  it("ignores a quiet settings projection superseded by a full refresh", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    let deliver!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () => new Promise((resolve) => (deliver = resolve)),
    );
    const read = view.result.current.readSettingsControls.current?.("s");
    view.result.current.readinessEpoch.current++;
    await act(async () => {
      deliver({ ...initial, revision: 9, status: "idle" });
      await read;
    });

    expect(view.result.current.live).toMatchObject(initial);
    expect(view.fail).not.toHaveBeenCalled();
  });

  it.each([
    ["desktop", 401],
    ["desktop", 403],
    ["web", 401],
    ["web", 403],
  ] as const)(
    "escalates a %s settings read that fails authorization (%s)",
    async (surface, status) => {
      const view = setup(undefined, undefined, surface);
      view.emit(0, "snapshot", { live: initial });
      act(() => view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c0" })));
      const failure = new ApiError(status, "forbidden");
      vi.mocked(view.client.live).mockRejectedValue(failure);

      await act(async () => view.result.current.readSettingsControls.current?.("s"));

      expect(view.fail).toHaveBeenCalledExactlyOnceWith(failure, 0);
      expect(view.result.current.ready).toBe(false);
    },
  );

  it.each(["desktop", "web"] as const)(
    "defers %s control reconciliation while the settings response is still awaited",
    async (surface) => {
      const view = setup(undefined, () => true, surface);
      view.emit(0, "snapshot", { live: initial });
      const write = { sessionId: "s", generation: 0 };
      view.result.current.settingsInFlight.current = write;

      await act(async () => {
        view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
      });

      expect(write).toMatchObject({ controlChanged: true });
      expect(view.client.live).not.toHaveBeenCalled();
    },
  );

  it("reconciles a missed control-fence change exactly once after empty replay", async () => {
    const view = setup();
    view.emit(0, "snapshot", {
      live: { ...initial, status: "outcome-unknown", revision: null, sendEnabled: false },
    });
    expect(view.client.live).not.toHaveBeenCalled();
    act(() => view.handlers[0].error());
    let resolve!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    act(() => {
      view.handlers[0].open();
      view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c0" }));
    });
    expect(view.client.live).toHaveBeenCalledOnce();
    expect(view.result.current.ready).toBe(false);
    view.emit(1, "text-delta", { itemId: "late-reply", text: "confirmed", offset: 0 });
    expect(view.result.current.ready).toBe(false);
    act(() => view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c1" })));
    expect(view.client.live).toHaveBeenCalledOnce();
    expect(view.result.current.ready).toBe(false);
    await act(async () => {
      resolve({ ...initial, status: "idle", sendEnabled: true });
    });
    expect(view.result.current.live?.status).toBe("idle");
    expect(view.result.current.ready).toBe(true);
    view.emit(2, "text-delta", { itemId: "late-reply", text: "!", offset: 9 });
    expect(view.result.current.live?.status).toBe("idle");
    act(() => view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c2" })));
    expect(view.client.live).toHaveBeenCalledOnce();
    expect(view.client.events).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "replaces a settled control fence without losing streamed content (durable pending: %s)",
    async (durablePending) => {
      const view = setup(() => durablePending);
      view.emit(0, "snapshot", {
        live: {
          ...initial,
          status: "outcome-unknown",
          reason: "control-outcome-unconfirmed",
          revision: null,
        },
      });
      view.emit(1, "text-delta", { itemId: "reply", text: "stable reply", offset: 0 });
      view.emit(2, "text-delta", { text: "streaming reply", offset: 0 });
      const settled: Live = {
        sessionId: "s",
        revision: 11,
        status: "idle",
        sendEnabled: true,
        approvals: [],
        streamText: "older stream text",
      };
      vi.mocked(view.client.live).mockResolvedValue(settled);
      await act(async () => {
        view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
      });
      expect(view.result.current.live).toEqual({ ...settled, streamText: "streaming reply" });
      expect(view.result.current.ready).toBe(!durablePending);
      expect(view.result.current.page?.events).toMatchObject([
        { id: "reply", content: "stable reply" },
      ]);
      view.emit(3, "text-delta", { itemId: "reply", text: "!", offset: 12 });
      view.emit(4, "text-delta", { text: "!", offset: 15 });
      expect(view.result.current.page?.events[0].content).toBe("stable reply!");
      expect(view.result.current.live?.streamText).toBe("streaming reply!");
      expect(view.client.stream).toHaveBeenCalledOnce();
      expect(view.client.events).not.toHaveBeenCalled();
    },
  );
  it("retains a control fence that is still present in the complete live response", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    const fenced: Live = {
      ...initial,
      status: "outcome-unknown",
      reason: "control-outcome-unconfirmed",
      sendEnabled: false,
      stopEnabled: false,
    };
    vi.mocked(view.client.live).mockResolvedValue(fenced);
    await act(async () => {
      view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
    });
    expect(view.result.current.live).toMatchObject(fenced);
    expect(view.client.live).toHaveBeenCalledOnce();
  });
  it("clears a failed live-reconciliation error after a later settlement succeeds", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    const failure = new Error("operation_busy");
    vi.mocked(view.client.live)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ ...initial, status: "idle" });
    await act(async () => {
      view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
    });
    expect(view.fail).toHaveBeenCalledWith(failure, 0);
    view.setError.mockClear();
    await act(async () => {
      view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
    });
    expect(view.setError).toHaveBeenCalledWith(false);
    expect(view.result.current.online).toBe(true);
    expect(view.result.current.ready).toBe(true);
  });
  it.each([false, true])(
    "merges native progress into a complete control projection (durable pending: %s)",
    async (durablePending) => {
      const view = setup(() => durablePending);
      view.emit(0, "snapshot", {
        live: { ...initial, status: "outcome-unknown", revision: null, sendEnabled: false },
      });
      let finish!: (live: Live) => void;
      vi.mocked(view.client.live)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue({ ...initial, status: "idle", revision: 11, sendEnabled: true });
      act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
      view.emit(1, "state", { revision: 11 });
      expect(view.result.current.ready).toBe(false);
      await act(async () => {
        finish({ ...initial, status: "idle", revision: 10, sendEnabled: true });
      });
      expect(view.client.live).toHaveBeenCalledTimes(1);
      expect(view.result.current.live).toMatchObject({
        status: "idle",
        revision: 11,
        sendEnabled: true,
      });
      expect(view.result.current.ready).toBe(!durablePending);
      expect(view.client.events).not.toHaveBeenCalled();
    },
  );
  it.each([10, 30])(
    "settles controls during continuous native progress with response revision %s",
    async (responseRevision) => {
      const view = setup();
      const running = {
        ...initial,
        executionMode: "codex-managed" as const,
        stopEnabled: true,
        usage: { available: true, usedTokens: 1 },
      };
      view.emit(0, "snapshot", { live: running });
      let finish!: (live: Live) => void;
      vi.mocked(view.client.live).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
      for (let token = 1; token <= 20; token++)
        view.emit(token, "state", {
          revision: 10 + token,
          usage: { available: true, usedTokens: token + 1 },
          // Repeated control fields/arrays are not new control boundaries.
          status: "running",
          sendEnabled: false,
          stopEnabled: true,
          approvals: [],
        });
      view.emit(21, "text-delta", { itemId: "reply", turnId: "turn", offset: 0, text: "latest" });
      await act(async () => finish({ ...running, revision: responseRevision }));
      expect(view.client.live).toHaveBeenCalledOnce();
      expect(view.result.current.ready).toBe(true);
      expect(view.result.current.live).toMatchObject({
        revision: 30,
        status: "running",
        stopEnabled: true,
        usage: { usedTokens: 21 },
      });
      expect(view.result.current.page?.events[0].content).toBe("latest");
      for (let token = 22; token <= 40; token++)
        view.emit(token, "state", { revision: token + 10 });
      expect(view.result.current.ready).toBe(true);
      expect(view.client.live).toHaveBeenCalledOnce();
      expect(view.client.events).not.toHaveBeenCalled();
    },
  );
  it("does not replace newer HTTP progress with an older buffered native field", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    let finish!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    view.emit(1, "state", { revision: 11, usage: { available: true, usedTokens: 11 } });
    view.emit(2, "state", { revision: 13 });
    await act(async () =>
      finish({ ...initial, revision: 12, usage: { available: true, usedTokens: 12 } }),
    );
    expect(view.result.current.live).toMatchObject({ revision: 13, usage: { usedTokens: 12 } });
    expect(view.result.current.ready).toBe(true);
    expect(view.client.live).toHaveBeenCalledOnce();
  });
  it("keeps an HTTP projection newer than all buffered progress", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    let finish!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    view.emit(1, "state", { revision: 11, usage: { available: true, usedTokens: 11 } });
    const newer = { ...initial, revision: 12, usage: { available: true, usedTokens: 12 } };
    await act(async () => finish(newer));
    expect(view.result.current.live).toMatchObject(newer);
    expect(view.result.current.ready).toBe(true);
    expect(view.client.live).toHaveBeenCalledOnce();
  });
  it("converges after a delayed SSE revision follows an ahead HTTP projection", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    vi.mocked(view.client.live).mockResolvedValueOnce({ ...initial, revision: 30 });
    await act(async () =>
      view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })),
    );
    const finishes: ((live: Live) => void)[] = [];
    vi.mocked(view.client.live).mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    view.emit(1, "state", { revision: 11 });
    await act(async () => finishes[0]({ ...initial, revision: 30 }));
    expect(view.client.live).toHaveBeenCalledTimes(3);
    for (let revision = 12; revision <= 30; revision++)
      view.emit(revision - 10, "state", { revision });
    await act(async () => finishes[1]({ ...initial, revision: 31 }));
    expect(view.result.current.live?.revision).toBe(31);
    expect(view.result.current.ready).toBe(true);
    expect(view.client.live).toHaveBeenCalledTimes(3);
  });
  it("preserves explicit clearing of native progress fields after the HTTP revision", async () => {
    const view = setup();
    const withGoal = { ...initial, goal: { objective: "Goal", status: "active" } } as Live;
    view.emit(0, "snapshot", { live: withGoal });
    let finish!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    view.emit(1, "state", { revision: 11, goal: null, settings: null });
    await act(async () => finish(withGoal));
    expect(view.result.current.live).toMatchObject({ revision: 11, goal: null, settings: null });
    expect(view.client.live).toHaveBeenCalledOnce();
  });
  it.each([null, 10])(
    "keeps an unknown HTTP fence intact while native progress arrives (revision: %s)",
    async (revision) => {
      const view = setup();
      view.emit(0, "snapshot", { live: initial });
      let finish!: (live: Live) => void;
      vi.mocked(view.client.live).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
      view.emit(1, "state", { revision: 11 });
      const fenced = {
        ...initial,
        status: "outcome-unknown",
        reason: "control-outcome-unconfirmed",
        revision,
        sendEnabled: false,
        stopEnabled: false,
        approvals: [],
        questions: [],
      };
      await act(async () => finish(fenced as Live));
      expect(view.result.current.live).toMatchObject(fenced);
      expect(view.client.live).toHaveBeenCalledOnce();
    },
  );
  it("preserves host permission gates while merging later native revisions", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: { ...initial, stopEnabled: true } });
    let finish!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    view.emit(1, "state", { revision: 11, stopEnabled: true, approvals: [] });
    const restricted = {
      ...initial,
      stopEnabled: false,
      approvals: [{ requestId: "approval", supported: false }],
      questions: [{ requestId: "question", supported: false }],
    } as Live;
    await act(async () => finish(restricted));
    expect(view.result.current.live).toMatchObject({ ...restricted, revision: 11 });
    expect(view.client.live).toHaveBeenCalledOnce();
  });
  it.each(["native-state", "host-fence", "revision-reset"])(
    "rereads an actual %s boundary but not subsequent token revisions",
    async (boundary) => {
      const view = setup();
      view.emit(0, "snapshot", { live: { ...initial, stopEnabled: true } });
      const finishes: ((live: Live) => void)[] = [];
      vi.mocked(view.client.live).mockImplementation(
        () => new Promise((resolve) => finishes.push(resolve)),
      );
      act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
      const patch =
        boundary === "host-fence"
          ? {
              status: "outcome-unknown",
              reason: "control-outcome-unconfirmed",
              revision: null,
              sendEnabled: false,
              stopEnabled: false,
              approvals: [],
              questions: [],
            }
          : boundary === "native-state"
            ? { revision: 11, status: "idle", turnId: null, stopEnabled: false, sendEnabled: true }
            : { revision: 1 };
      view.emit(1, "state", patch);
      await act(async () => finishes[0]({ ...initial, stopEnabled: true }));
      expect(view.client.live).toHaveBeenCalledTimes(2);
      expect(view.result.current.ready).toBe(false);
      const current = { ...initial, stopEnabled: true, ...patch } as Live;
      for (let seq = 2; seq <= 10; seq++)
        view.emit(seq, "state", {
          ...patch,
          revision: boundary === "host-fence" ? null : 10 + seq,
        });
      await act(async () => finishes[1](current));
      expect(view.client.live).toHaveBeenCalledTimes(2);
      expect(view.result.current.ready).toBe(true);
      expect(view.result.current.live).toMatchObject({
        ...current,
        revision: boundary === "host-fence" ? null : 20,
      });
    },
  );
  it.each([
    ["a newly observed mode", { mode: "auto" }, undefined],
    ["a mode change", { mode: "bypassPermissions" }, { mode: "auto" }],
    ["an explicit clear", { mode: null }, { mode: "auto" }],
    ["the unknown-mode hint", { mode: null, possiblyAuto: true }, undefined],
  ] as const)(
    "treats a permission-only state patch as native progress, not a control boundary (%s)",
    async (_name, permission, previous) => {
      const view = setup();
      view.emit(0, "snapshot", {
        live: { ...initial, stopEnabled: true, ...(previous ? { permission: previous } : {}) },
      });
      let finish!: (live: Live) => void;
      vi.mocked(view.client.live).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
      view.emit(1, "state", { revision: 11, permission });
      // The older HTTP response predates the patch and must not erase the observation.
      await act(async () =>
        finish({ ...initial, stopEnabled: true, ...(previous ? { permission: previous } : {}) }),
      );
      expect(view.client.live).toHaveBeenCalledOnce();
      expect(view.result.current.ready).toBe(true);
      expect(view.result.current.live).toMatchObject({
        revision: 11,
        stopEnabled: true,
        permission,
      });
      // Later permission-only patches do not reread controls either.
      view.emit(2, "state", { revision: 12, permission: { mode: "plan" } });
      view.emit(3, "state", { revision: 13, permission: { mode: null } });
      expect(view.client.live).toHaveBeenCalledOnce();
      expect(view.result.current.ready).toBe(true);
      expect(view.result.current.live?.permission).toEqual({ mode: null });
    },
  );
  it("still rereads when an unclassified field changes beside a permission patch", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: { ...initial, stopEnabled: true } });
    const finishes: ((live: Live) => void)[] = [];
    vi.mocked(view.client.live).mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    // Same shape as the permission-only patch, but the extra field is an unknown boundary.
    view.emit(1, "state", { revision: 11, permission: { mode: "auto" }, unclassified: true });
    await act(async () => finishes[0]({ ...initial, stopEnabled: true }));
    expect(view.client.live).toHaveBeenCalledTimes(2);
    expect(view.result.current.ready).toBe(false);
    await act(async () => finishes[1]({ ...initial, stopEnabled: true, revision: 11 }));
    expect(view.result.current.ready).toBe(true);
  });
  it("ignores a superseded control read and a read invalidated by disconnect", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    const finishes: ((live: Live) => void)[] = [];
    vi.mocked(view.client.live).mockImplementation(
      () => new Promise((resolve) => finishes.push(resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    const latest = { ...initial, revision: 11, status: "idle", sendEnabled: true };
    await act(async () => finishes[1](latest));
    await act(async () => finishes[0]({ ...initial, status: "outcome-unknown" }));
    expect(view.result.current.live?.status).toBe("idle");
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    act(() => view.handlers[0].error());
    await act(async () => finishes[2]({ ...initial, revision: 12 }));
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.online).toBe(false);
    expect(view.result.current.live?.status).toBe("idle");
    view.unmount();
    expect(view.close).toHaveBeenCalledOnce();
  });
  it("does not apply the previous session's control read after selection changes", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    let finish!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    act(() => view.result.current.choose("next"));
    const next = { ...initial, sessionId: "next", revision: 1, status: "idle", sendEnabled: true };
    act(() =>
      view.handlers[1].event(
        "session-event",
        JSON.stringify({ ...envelope(0, "snapshot", { live: next }), sessionId: "next" }),
      ),
    );
    await act(async () => finish({ ...initial, status: "outcome-unknown", sendEnabled: false }));
    expect(view.result.current.live).toMatchObject(next);
    expect(view.result.current.ready).toBe(true);
    expect(view.client.stream).toHaveBeenCalledTimes(2);
    expect(view.close).toHaveBeenCalledOnce();
  });
  it("does not replace a newer full snapshot with a pending control read", async () => {
    const view = setup();
    view.emit(0, "snapshot", { live: initial });
    let finish!: (live: Live) => void;
    vi.mocked(view.client.live).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    act(() => view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" })));
    const fenced = { ...initial, status: "outcome-unknown", revision: null, sendEnabled: false };
    view.emit(1, "snapshot", { live: fenced });
    await act(async () => {
      finish({ ...initial, status: "idle", sendEnabled: true });
    });
    expect(view.result.current.live).toMatchObject(fenced);
    expect(view.client.live).toHaveBeenCalledOnce();
  });
  it("retains displayed history outside a bounded snapshot and still applies explicit rollback", async () => {
    const view = setup();
    const items = Array.from({ length: 102 }, (_, index) => ({
      id: `item-${index}`,
      kind:
        index === 0
          ? ("user-message" as const)
          : index === 100
            ? ("agent-message" as const)
            : ("tool-summary" as const),
      message_phase: index === 100 ? ("final_answer" as const) : undefined,
      turn_id: index === 101 ? "new-turn" : "old-turn",
      content: `tool ${index}`,
      ephemeral: true,
      attachment_count: 0,
      truncated: false,
    }));
    view.emit(0, "snapshot", {
      live: initial,
      items: items.slice(0, 100),
      replaceItems: true,
      preserveItemsOutsideCoverage: true,
      authoritativeTurnIds: ["old-turn"],
    });
    view.emit(1, "item-upsert", items[100]);
    view.emit(2, "item-upsert", items[101]);
    view.emit(3, "snapshot", {
      live: initial,
      items: items.slice(2),
      replaceItems: true,
      preserveItemsOutsideCoverage: true,
      authoritativeTurnIds: ["new-turn"],
    });
    expect(view.result.current.page?.events.map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(view.client.events).not.toHaveBeenCalled();
    const partialHistory = items.slice(51, 101).map((item) => ({ ...item, ephemeral: false }));
    vi.mocked(view.client.events).mockResolvedValue({
      events: partialHistory,
      next_cursor: "earlier-turn-items",
      warnings: [],
    });
    view.emit(4, "invalidate", { domains: ["history"] });
    await act(async () => {});
    expect(view.result.current.page?.events.map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(view.result.current.page?.events[100].ephemeral).toBe(false);
    expect(view.result.current.page?.next_cursor).toBe("earlier-turn-items");
    view.emit(5, "snapshot", {
      live: initial,
      items: [items[101]],
      replaceItems: true,
      preserveItemsOutsideCoverage: true,
      authoritativeTurnIds: ["new-turn"],
      removedTurnIds: ["old-turn"],
    });
    expect(view.result.current.page?.events).toEqual([items[101]]);
    vi.mocked(view.client.events).mockResolvedValue({ events: items, warnings: [] });
    view.emit(6, "invalidate", { domains: ["history"] });
    await act(async () => {});
    expect(view.result.current.page?.events).toEqual([items[101]]);
  });
  it("still replaces temporary identities when a full overlay snapshot supplies native IDs", () => {
    const view = setup();
    const user = {
      id: "live:user",
      kind: "user-message" as const,
      turn_id: "turn",
      content: "prompt",
      ephemeral: true,
      attachment_count: 0,
      truncated: false,
    };
    view.emit(0, "snapshot", { live: initial, items: [user] });
    const native = { ...user, id: "native-user", ephemeral: false };
    view.emit(1, "snapshot", { live: initial, items: [native], replaceItems: true });
    expect(view.result.current.page?.events).toEqual([native]);
  });
  it("removes only an aliased identity from a bounded snapshot after more than 100 items", async () => {
    const view = setup();
    const items = Array.from({ length: 101 }, (_, index) => ({
      id: `native-${index}`,
      kind: "tool-summary" as const,
      turn_id: "turn",
      attachment_count: 0,
      truncated: false,
    }));
    const temporary = {
      id: "live:turn:assistant",
      kind: "agent-message" as const,
      turn_id: "turn",
      content: "reply",
      ephemeral: true,
      attachment_count: 0,
      truncated: false,
    };
    const native = { ...temporary, id: "native-assistant", ephemeral: false };
    view.emit(0, "snapshot", { live: initial, items: items.slice(0, 100) });
    view.emit(1, "item-upsert", items[100]);
    view.emit(2, "item-upsert", temporary);
    view.emit(3, "snapshot", {
      live: initial,
      items: [...items.slice(2), native],
      replaceItems: true,
      preserveItemsOutsideCoverage: true,
      removedItemIds: [temporary.id],
    });
    expect(view.result.current.page?.events).toEqual([...items, native]);
    vi.mocked(view.client.events).mockResolvedValue({ events: [temporary], warnings: [] });
    view.emit(4, "invalidate", { domains: ["history"] });
    await act(async () => {});
    expect(view.result.current.page?.events).toEqual([...items, native]);
  });
  it("clears an expired history cache once per epoch without releasing pending controls", async () => {
    const view = setup(() => true);
    const item = {
      id: "stale",
      kind: "agent-message" as const,
      content: "old cache",
      attachment_count: 0,
      truncated: false,
    };
    view.emit(0, "snapshot", { live: initial, items: [item], removedItemIds: ["restored"] });
    let finish!: (page: ConversationEventPage) => void;
    vi.mocked(view.client.events).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const current = { ...item, id: "current", content: "current tail" };
    const payload = {
      live: { ...initial, status: "outcome-unknown", sendEnabled: false },
      items: [current],
      replaceItems: true,
      preserveItemsOutsideCoverage: true,
      historyCacheEpoch: "cache-1",
    };
    view.emit(1, "snapshot", payload);
    expect(view.result.current.page?.events).toEqual([current]);
    expect(view.client.events).toHaveBeenCalledOnce();
    view.emit(1, "snapshot", payload);
    expect(view.client.events).toHaveBeenCalledOnce();
    const restored = { ...item, id: "restored", content: "fresh historical item" };
    await act(async () => {
      finish({ events: [restored, current], warnings: [], next_cursor: "older" });
    });
    expect(view.result.current.page?.events).toEqual([restored, current]);
    view.emit(2, "snapshot", payload);
    expect(view.result.current.page?.events).toEqual([restored, current]);
    expect(view.result.current.page?.next_cursor).toBe("older");
    expect(view.client.events).toHaveBeenCalledOnce();
    expect(view.result.current.ready).toBe(false);
    expect(view.result.current.live?.sendEnabled).toBe(false);
    expect(view.client.live).not.toHaveBeenCalled();
    const nextHistory = { ...restored, id: "next-cache" };
    vi.mocked(view.client.events).mockResolvedValue({ events: [nextHistory], warnings: [] });
    view.emit(3, "snapshot", { ...payload, items: [], historyCacheEpoch: "cache-2" });
    await act(async () => {});
    expect(view.result.current.page?.events).toEqual([nextHistory]);
    expect(view.client.events).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])(
    "restores a history baseline before a bounded native tail without overwriting newer contents (overlap: %s)",
    async (overlap) => {
      const view = setup();
      const historical = {
        id: "persisted-old",
        kind: "agent-message" as const,
        turn_id: "old-turn",
        content: "older history",
        attachment_count: 0,
        truncated: false,
      };
      view.emit(0, "snapshot", {
        live: initial,
        items: [{ ...historical, id: "obsolete-cache" }],
      });
      const native = Array.from({ length: 100 }, (_, index) => ({
        id: `native-${index}`,
        kind: index === 99 ? ("agent-message" as const) : ("tool-summary" as const),
        turn_id: "turn",
        content: `current native content ${index}`,
        ephemeral: true,
        attachment_count: 0,
        truncated: index === 99,
      }));
      let finish!: (page: ConversationEventPage) => void;
      vi.mocked(view.client.events).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      view.emit(1, "snapshot", {
        live: initial,
        items: native,
        replaceItems: true,
        preserveItemsOutsideCoverage: true,
        authoritativeTurnIds: [],
        historyCacheEpoch: "cache-1",
      });
      expect(view.result.current.page?.events).toEqual(native);
      expect(view.client.events).toHaveBeenCalledOnce();
      await act(async () => {
        finish({
          events: [
            historical,
            ...(overlap
              ? [{ ...native[0], content: "stale persisted content", ephemeral: false }]
              : []),
          ],
          warnings: [],
          next_cursor: "older",
        });
      });
      expect(view.result.current.page?.events).toEqual([historical, ...native]);
      expect(view.result.current.page?.next_cursor).toBe("older");
    },
  );
  it("ignores reads from an expired cache and finishes recovery after newer native items", async () => {
    vi.useFakeTimers();
    const view = setup();
    const item = {
      id: "reply",
      kind: "agent-message" as const,
      content: "a",
      attachment_count: 0,
      truncated: false,
    };
    const finishes: ((page: ConversationEventPage) => void)[] = [];
    vi.mocked(view.client.events)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishes.push(resolve);
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishes.push(resolve);
          }),
      )
      .mockResolvedValue({ events: [item], warnings: [], next_cursor: "recovered" });
    view.emit(0, "snapshot", { live: initial, items: [item] });
    view.emit(1, "invalidate", { domains: ["history"] });
    view.emit(2, "snapshot", {
      live: initial,
      items: [item],
      preserveItemsOutsideCoverage: true,
      historyCacheEpoch: "cache-1",
    });
    await act(async () => {
      finishes[0]({ events: [{ ...item, id: "obsolete" }], warnings: [] });
    });
    expect(view.result.current.page?.events).toEqual([item]);
    expect(view.client.events).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(50));
    view.emit(3, "text-delta", { itemId: item.id, text: "b", offset: 1 });
    await act(async () => {
      finishes[1]({ events: [item], warnings: [] });
    });
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.client.events).toHaveBeenCalledTimes(3);
    expect(view.result.current.page?.events).toEqual([{ ...item, content: "ab" }]);
    expect(view.result.current.page?.next_cursor).toBe("recovered");
  });
  it("reports a history cache recovery failure instead of silently retaining an empty reader", async () => {
    vi.useFakeTimers();
    const view = setup();
    const error = new Error("history unavailable");
    vi.mocked(view.client.events).mockRejectedValue(error);
    view.emit(0, "snapshot", {
      live: initial,
      items: [],
      historyCacheEpoch: "cache-1",
    });
    await act(async () => {});
    expect(view.fail).toHaveBeenCalledWith(error, 0);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(view.client.events).toHaveBeenCalledOnce();
    view.setError.mockClear();
    view.emit(1, "state", { revision: 11 });
    expect(view.setError).not.toHaveBeenCalledWith(false);
    vi.mocked(view.client.events).mockResolvedValue({ events: [], warnings: [] });
    view.emit(2, "invalidate", { domains: ["history"] });
    await act(async () => {});
    expect(view.setError).toHaveBeenCalledWith(false);
    expect(view.client.events).toHaveBeenCalledTimes(2);
  });
  it.each(["invalidation", "cache-recovery"])(
    "retains a failed %s history read through live delivery until history succeeds",
    async (source) => {
      vi.useFakeTimers();
      const view = setup(() => true);
      const error = new Error("history unavailable");
      const history = {
        events: [
          {
            id: "persisted",
            kind: "agent-message" as const,
            content: "Recovered history",
            attachment_count: 0,
            truncated: false,
          },
        ],
        warnings: [],
      };
      vi.mocked(view.client.events).mockRejectedValueOnce(error).mockResolvedValue(history);
      const payload = {
        live: initial,
        items: [],
        ...(source === "cache-recovery" ? { historyCacheEpoch: "cache-1" } : {}),
      };
      view.emit(0, "snapshot", { live: initial });
      if (source === "cache-recovery") view.emit(1, "snapshot", payload);
      else view.emit(1, "invalidate", { domains: ["history"] });
      await act(async () => {});
      expect(view.fail).toHaveBeenCalledWith(error, 0);
      view.setError.mockClear();

      view.emit(2, "state", { revision: 11 });
      view.emit(3, "snapshot", payload);
      act(() => view.handlers[0].event("session-ready", JSON.stringify({ cursor: "c3" })));
      const fenced = {
        ...initial,
        status: "outcome-unknown",
        reason: "control-outcome-unconfirmed",
        sendEnabled: false,
        stopEnabled: false,
      };
      vi.mocked(view.client.live).mockResolvedValue(fenced);
      await act(async () => {
        view.handlers[0].event("control-changed", JSON.stringify({ sessionId: "s" }));
      });
      expect(view.setError).not.toHaveBeenCalledWith(false);
      expect(view.result.current.ready).toBe(false);
      expect(view.result.current.live).toMatchObject(fenced);
      await act(() => vi.advanceTimersByTimeAsync(30_000));
      expect(view.client.events).toHaveBeenCalledOnce();

      view.emit(4, "invalidate", { domains: ["history"] });
      await act(async () => {});
      expect(view.setError).toHaveBeenCalledExactlyOnceWith(false);
      expect(view.result.current.page?.events).toEqual(history.events);
      expect(view.client.events).toHaveBeenCalledTimes(2);
      expect(view.result.current.ready).toBe(false);
      expect(view.result.current.live).toMatchObject(fenced);
    },
  );
  it("applies updated persisted rows after an ordinary history read recovers", async () => {
    const view = setup();
    const item = {
      id: "persisted",
      kind: "agent-message" as const,
      content: "Previous history",
      attachment_count: 0,
      truncated: false,
    };
    const updated = { ...item, content: "Updated history" };
    vi.mocked(view.client.events)
      .mockResolvedValueOnce({ events: [item], warnings: [] })
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValue({ events: [updated], warnings: [] });
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "invalidate", { domains: ["history"] });
    await act(async () => {});
    expect(view.result.current.page?.events).toEqual([item]);
    view.emit(2, "invalidate", { domains: ["history"] });
    await act(async () => {});
    view.emit(3, "invalidate", { domains: ["history"] });
    await act(async () => {});
    expect(view.result.current.page?.events).toEqual([updated]);
    expect(view.client.events).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])(
    "keeps the previous history error state when a read is aborted (failed: %s)",
    async (failed) => {
      const view = setup();
      const abort = new DOMException("History read aborted", "AbortError");
      vi.mocked(view.client.events)
        .mockRejectedValueOnce(failed ? new Error("history unavailable") : abort)
        .mockRejectedValue(abort);
      view.emit(0, "snapshot", { live: initial });
      view.emit(1, "invalidate", { domains: ["history"] });
      await act(async () => {});
      view.emit(2, "invalidate", { domains: ["history"] });
      await act(async () => {});
      view.setError.mockClear();
      view.emit(3, "state", { revision: 11 });
      if (failed) expect(view.setError).not.toHaveBeenCalled();
      else expect(view.setError).toHaveBeenCalledExactlyOnceWith(false);
      expect(view.fail).toHaveBeenLastCalledWith(abort, 0);
      expect(view.client.events).toHaveBeenCalledTimes(2);
    },
  );
  it("does not carry a late history failure into the next session", async () => {
    const view = setup();
    let reject!: (error: Error) => void;
    vi.mocked(view.client.events).mockImplementationOnce(
      () => new Promise((_, fail) => (reject = fail)),
    );
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "invalidate", { domains: ["history"] });
    act(() => view.result.current.choose("next"));
    const next = { ...initial, sessionId: "next" };
    act(() =>
      view.handlers[1].event(
        "session-event",
        JSON.stringify({ ...envelope(0, "snapshot", { live: next }), sessionId: "next" }),
      ),
    );
    await act(async () => reject(new Error("obsolete history failure")));
    expect(view.fail).not.toHaveBeenCalled();
    view.setError.mockClear();
    act(() =>
      view.handlers[1].event(
        "session-event",
        JSON.stringify({ ...envelope(1, "state", { revision: 11 }), sessionId: "next" }),
      ),
    );
    expect(view.setError).toHaveBeenCalledExactlyOnceWith(false);
    expect(view.result.current.live?.sessionId).toBe("next");
    expect(view.client.events).toHaveBeenCalledOnce();
  });
  it("ignores a late history failure after another reader applied a newer result", async () => {
    const view = setup();
    let reject!: (error: Error) => void;
    vi.mocked(view.client.events).mockImplementationOnce(
      () => new Promise((_, fail) => (reject = fail)),
    );
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "invalidate", { domains: ["history"] });
    const coverage = view.result.current.nativeCoverage;
    const state = coverage.current.historyReads;
    view.emit(2, "item-upsert", {
      id: "native-item",
      kind: "agent-message",
      content: "Native progress",
      attachment_count: 0,
      truncated: false,
    });
    expect(coverage.current.historyReads).toBe(state);
    completeHistoryRead(coverage.current, beginHistoryRead(coverage.current));
    await act(async () => reject(new Error("obsolete history failure")));
    expect(view.fail).not.toHaveBeenCalled();
    expect(coverage.current.historyRecoveryFailed).toBe(false);
  });
  it.each([
    { recovery: false, overlap: false },
    { recovery: false, overlap: true },
    { recovery: true, overlap: false },
    { recovery: true, overlap: true },
  ])(
    "ignores late live history after a newer full refresh (recovery: $recovery, overlap: $overlap)",
    async ({ recovery, overlap }) => {
      const view = setup();
      const row = (id: string) => ({
        id,
        kind: "agent-message" as const,
        content: `current ${id}`,
        attachment_count: 0,
        truncated: false,
      });
      let finish!: (page: ConversationEventPage) => void;
      vi.mocked(view.client.events).mockImplementationOnce(
        () => new Promise((resolve) => (finish = resolve)),
      );
      view.emit(0, "snapshot", {
        live: initial,
        ...(recovery ? { historyCacheEpoch: "cache-1" } : {}),
      });
      if (!recovery) view.emit(1, "invalidate", { domains: ["history"] });
      expect(view.client.events).toHaveBeenCalledOnce();
      const latest = {
        events: [row("g"), row("h")],
        warnings: [],
        next_cursor: "newer-refresh",
      };
      // A full refresh shares the history state but does not emit a native event.
      act(() => {
        const coverage = view.result.current.nativeCoverage.current;
        const attempt = beginHistoryRead(coverage);
        const pagination = (coverage.historyPagination = createHistoryPagination());
        recordLatestHistoryPage(pagination, latest, attempt.id);
        completeHistoryRead(coverage, attempt);
        view.result.current.setPage(latest);
      });
      await act(async () => {
        finish({
          events: overlap ? [{ ...row("g"), content: "stale g" }] : [row("a"), row("b")],
          warnings: [],
          next_cursor: "obsolete-live-read",
        });
      });
      expect(view.result.current.page).toEqual(latest);
      // Once another reader recovered the baseline, later invalidations append
      // their newer window instead of treating it as another recovery baseline.
      const next = {
        events: [row("j"), row("k")],
        warnings: [],
        next_cursor: "next-window",
      };
      vi.mocked(view.client.events).mockResolvedValueOnce(next);
      view.emit(recovery ? 1 : 2, "invalidate", { domains: ["history"] });
      await act(async () => {});
      expect(view.result.current.page).toEqual({
        ...next,
        events: [...latest.events, ...next.events],
      });
    },
  );
  it.each(["invalidation", "native-progress"])(
    "appends a recovery retry after another reader established history (%s)",
    async (trigger) => {
      vi.useFakeTimers();
      const view = setup(() => true);
      const row = (id: string) => ({
        id,
        kind: "agent-message" as const,
        content: id,
        attachment_count: 0,
        truncated: false,
      });
      const baseline = {
        events: [row("a"), row("b")],
        warnings: [],
        next_cursor: "older-baseline",
      };
      const latest = {
        events: [row("j"), row("k")],
        warnings: [],
        next_cursor: "latest-gap",
      };
      const native = { ...row("b"), content: "newer native content", ephemeral: true };
      let finish!: (page: ConversationEventPage) => void;
      vi.mocked(view.client.events)
        .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
        .mockResolvedValueOnce(latest);
      view.emit(0, "snapshot", {
        live: { ...initial, status: "outcome-unknown", sendEnabled: false },
        historyCacheEpoch: "cache-1",
      });
      act(() => {
        const coverage = view.result.current.nativeCoverage.current;
        const attempt = beginHistoryRead(coverage);
        const pagination = (coverage.historyPagination = createHistoryPagination());
        recordLatestHistoryPage(pagination, baseline, attempt.id);
        completeHistoryRead(coverage, attempt);
        view.result.current.setPage(baseline);
      });
      // Invalidate before the pending recovery completes. Its early return
      // retains recovery state even though the other reader supplied history.
      if (trigger === "invalidation") view.emit(1, "invalidate", { domains: ["history"] });
      else view.emit(1, "item-upsert", native);
      await act(async () => finish({ events: [row("obsolete")], warnings: [] }));
      expect(view.client.events).toHaveBeenCalledOnce();
      await act(() => vi.advanceTimersByTimeAsync(50));
      expect(view.client.events).toHaveBeenCalledTimes(2);
      expect(view.result.current.page).toEqual({
        ...latest,
        events: [row("a"), trigger === "native-progress" ? native : row("b"), ...latest.events],
      });
      expect(
        view.result.current.nativeCoverage.current.historyPagination?.ranges.map(
          (range) => range.cursor,
        ),
      ).toEqual(["older-baseline", "latest-gap"]);
      expect(view.result.current.live?.status).toBe("outcome-unknown");
      expect(view.result.current.ready).toBe(false);
      expect(view.client.live).not.toHaveBeenCalled();
    },
  );
  it.each(
    [false, true].flatMap((recovery) =>
      ["items", "turn", "authoritative-coverage"].flatMap((deletion) =>
        [false, true].map((retainHistory) => ({ recovery, deletion, retainHistory })),
      ),
    ),
  )(
    "positions retry history before the native tail after rollback (recovery: $recovery, deletion: $deletion, retain history: $retainHistory)",
    async ({ recovery, deletion, retainHistory }) => {
      vi.useFakeTimers();
      const view = setup();
      const row = (id: string, turn_id: string) => ({
        id,
        turn_id,
        kind: "agent-message" as const,
        content: id,
        attachment_count: 0,
        truncated: false,
      });
      const retained = retainHistory ? [row("oldest", "oldest-turn")] : [];
      const visibleRetained = retained.map((item) => ({
        ...item,
        content: "newer native content for the same raw identity",
        ephemeral: true,
      }));
      const removed = [row("deleted-a", "deleted-turn"), row("deleted-b", "deleted-turn")];
      const baseline = {
        events: [...retained, ...removed],
        warnings: [],
        next_cursor: "older-baseline",
      };
      const latest = {
        events: [
          ...retained,
          row("surviving-a", "earlier-turn"),
          row("surviving-b", "earlier-turn"),
        ],
        warnings: [],
        next_cursor: "older-surviving",
      };
      const native = { ...row("native", "new-turn"), ephemeral: true };
      const live = { ...initial, status: "outcome-unknown", sendEnabled: false };
      let finish!: (page: ConversationEventPage) => void;
      vi.mocked(view.client.events)
        .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
        .mockResolvedValueOnce(latest);
      view.emit(0, "snapshot", {
        live,
        ...(recovery ? { historyCacheEpoch: "cache-1" } : {}),
      });
      if (!recovery) view.emit(1, "invalidate", { domains: ["history"] });
      act(() => {
        const coverage = view.result.current.nativeCoverage.current;
        const attempt = beginHistoryRead(coverage);
        const pagination = (coverage.historyPagination = createHistoryPagination());
        recordLatestHistoryPage(pagination, baseline, attempt.id);
        completeHistoryRead(coverage, attempt);
        view.result.current.setPage(baseline);
      });
      // The visible raw baseline is removed, but its IDs remain registered for
      // pagination. A new native reply must remain after the surviving history.
      view.emit(recovery ? 1 : 2, "snapshot", {
        live,
        items: [...visibleRetained, native],
        replaceItems: true,
        preserveItemsOutsideCoverage: true,
        ...(deletion === "items"
          ? { removedItemIds: removed.map((item) => item.id) }
          : deletion === "turn"
            ? { removedTurnIds: ["deleted-turn"] }
            : { authoritativeTurnIds: ["deleted-turn"] }),
      });
      expect(view.result.current.page?.events).toEqual([...visibleRetained, native]);
      await act(async () => finish(baseline));
      await act(() => vi.advanceTimersByTimeAsync(50));
      expect(view.client.events).toHaveBeenCalledTimes(2);
      expect(view.result.current.page).toEqual({
        ...latest,
        events: [...visibleRetained, ...latest.events.slice(retained.length), native],
        next_cursor: retainHistory ? baseline.next_cursor : latest.next_cursor,
      });
      expect(view.result.current.live?.status).toBe("outcome-unknown");
      expect(view.result.current.live?.sendEnabled).toBe(false);
      expect(view.client.live).not.toHaveBeenCalled();
    },
  );
  it("keeps normal appending when a surviving raw baseline precedes older native content", async () => {
    vi.useFakeTimers();
    const view = setup();
    const row = (id: string) => ({
      id,
      kind: "agent-message" as const,
      content: id,
      attachment_count: 0,
      truncated: false,
    });
    let finish!: (page: ConversationEventPage) => void;
    const latest = { events: [row("later-j"), row("later-k")], warnings: [] };
    vi.mocked(view.client.events)
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(latest);
    view.emit(0, "snapshot", { live: initial, historyCacheEpoch: "cache-1" });
    const baseline = { events: [row("earlier-a"), row("removed-b")], warnings: [] };
    act(() => {
      const coverage = view.result.current.nativeCoverage.current;
      const attempt = beginHistoryRead(coverage);
      const pagination = (coverage.historyPagination = createHistoryPagination());
      recordLatestHistoryPage(pagination, baseline, attempt.id);
      completeHistoryRead(coverage, attempt);
      view.result.current.setPage(baseline);
    });
    const native = { ...row("intermediate-native"), ephemeral: true };
    view.emit(1, "snapshot", {
      live: initial,
      items: [native],
      replaceItems: true,
      preserveItemsOutsideCoverage: true,
      removedItemIds: ["removed-b"],
    });
    await act(async () => finish(baseline));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.result.current.page?.events).toEqual([row("earlier-a"), native, ...latest.events]);
  });
  it("does not clear a newer reader's failure when an older history read succeeds", async () => {
    const view = setup();
    let finish!: (page: ConversationEventPage) => void;
    vi.mocked(view.client.events).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "invalidate", { domains: ["history"] });
    const coverage = view.result.current.nativeCoverage;
    expect(failHistoryRead(coverage.current, beginHistoryRead(coverage.current))).toBe(true);
    view.setError.mockClear();
    await act(async () => finish({ events: [], warnings: [] }));
    expect(coverage.current.historyRecoveryFailed).toBe(true);
    expect(view.setError).not.toHaveBeenCalledWith(false);
  });
  it("isolates history read outcomes across cache epochs", async () => {
    const view = setup();
    vi.mocked(view.client.events).mockResolvedValue({ events: [], warnings: [] });
    view.emit(0, "snapshot", { live: initial });
    const coverage = view.result.current.nativeCoverage;
    const previous = beginHistoryRead(coverage.current);
    view.emit(1, "snapshot", { live: initial, historyCacheEpoch: "cache-1" });
    await act(async () => {});
    expect(coverage.current.historyReads).not.toBe(previous.state);
    expect(failHistoryRead(coverage.current, previous)).toBe(false);
    expect(failHistoryRead(coverage.current, beginHistoryRead(coverage.current))).toBe(true);
    completeHistoryRead(coverage.current, previous);
    expect(coverage.current.historyRecoveryFailed).toBe(true);
  });
  it("replaces only explicitly covered native turns and does not reinsert offset-based history", async () => {
    const view = setup();
    const item = {
      id: "legacy-offset",
      kind: "agent-message" as const,
      turn_id: "active-turn",
      content: "same words",
      attachment_count: 0,
      truncated: false,
    };
    const older = { ...item, id: "older", turn_id: "older-turn" };
    vi.mocked(view.client.events).mockResolvedValue({ events: [older, item], warnings: [] });
    view.emit(0, "snapshot", { live: initial });
    view.emit(1, "invalidate", { domains: ["history"] });
    await act(async () => {});
    view.emit(2, "snapshot", {
      live: initial,
      items: [{ ...item, id: "native-item", ephemeral: true }],
      authoritativeTurnIds: ["active-turn"],
    });
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual([
      "older",
      "native-item",
    ]);
    view.emit(3, "invalidate", { domains: ["history"] });
    await act(async () => {});
    expect(view.result.current.page?.events.map((event) => event.id)).toEqual([
      "older",
      "native-item",
    ]);
  });
});
