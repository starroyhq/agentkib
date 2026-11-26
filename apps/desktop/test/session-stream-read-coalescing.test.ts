import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStreamHub } from "../../../packages/backend/src/session-stream";

type Snapshot = {
  live: Record<string, unknown>;
  items: Record<string, unknown>[];
  completeItems: boolean;
};

const hubs: SessionStreamHub[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function snapshot(sessionId = "session"): Snapshot {
  return {
    live: { sessionId, status: "idle" },
    items: [{ id: "history", content: "saved history" }],
    completeItems: true,
  };
}

function createHub(read: (sessionId: string) => Promise<Snapshot>) {
  const notify = vi.fn();
  const observed = vi.fn();
  const hub = new SessionStreamHub("boot", read, notify, observed);
  hubs.push(hub);
  return { hub, notify, observed };
}

afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
});

describe("session stream snapshot reads", () => {
  it("shares only the in-flight read while keeping concurrent subscriptions independent", async () => {
    const firstRead = deferred<Snapshot>();
    const read = vi.fn(() => firstRead.promise);
    const { hub, notify, observed } = createHub(read);
    const firstPromise = hub.subscribe("session");
    const secondPromise = hub.subscribe("session");
    expect(read).toHaveBeenCalledTimes(1);

    firstRead.resolve(snapshot());
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(first.subscriptionId).not.toBe(second.subscriptionId);
    expect(first.events[0]?.subscriptionId).toBe(first.subscriptionId);
    expect(second.events[0]?.subscriptionId).toBe(second.subscriptionId);
    expect(observed).toHaveBeenCalledTimes(2);

    hub.unsubscribe(first.subscriptionId);
    hub.publish("session", "state", { status: "running" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0].subscriptionId).toBe(second.subscriptionId);

    await hub.subscribe("session");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("does not share reads across different sessions", async () => {
    const a = deferred<Snapshot>();
    const b = deferred<Snapshot>();
    const read = vi.fn((sessionId: string) => (sessionId === "a" ? a.promise : b.promise));
    const { hub } = createHub(read);
    const first = hub.subscribe("a");
    const second = hub.subscribe("b");
    b.resolve(snapshot("b"));
    expect((await second).events[0]?.sessionId).toBe("b");
    a.resolve(snapshot("a"));
    expect((await first).events[0]?.sessionId).toBe("a");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("immediately retries a failed shared read without retaining a failed subscription", async () => {
    const failed = deferred<Snapshot>();
    const read = vi.fn().mockReturnValueOnce(failed.promise).mockResolvedValue(snapshot());
    const { hub, observed } = createHub(read);
    const first = hub.subscribe("session");
    const second = hub.subscribe("session");
    const failures = Promise.allSettled([first, second]);
    failed.reject(new Error("temporary-owner-check-failure"));
    expect((await failures).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(hub.hasSubscribers("session")).toBe(false);
    expect(observed).not.toHaveBeenCalled();

    await hub.subscribe("session");
    expect(read).toHaveBeenCalledTimes(2);
    expect(hub.hasSubscribers("session")).toBe(true);
  });

  it("shares a poll with a concurrent subscription and preserves a newer published item", async () => {
    vi.useFakeTimers();
    const delayed = deferred<Snapshot>();
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValue(delayed.promise);
    const { hub, notify } = createHub(read);
    const first = await hub.subscribe("session");
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(2);
    const secondPromise = hub.subscribe("session");
    hub.publish("session", "item-upsert", { id: "new", content: "newer event" });
    delayed.resolve(snapshot());
    const second = await secondPromise;
    expect(read).toHaveBeenCalledTimes(2);
    expect(second.events[0]?.payload.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "new", content: "newer event" })]),
    );
    expect(notify.mock.calls[0]?.[0].subscriptionId).toBe(first.subscriptionId);
  });

  it("keeps polling other sessions while a provider read stalls and then fails", async () => {
    vi.useFakeTimers();
    const stalled = deferred<Snapshot>();
    const blocked = vi
      .fn()
      .mockResolvedValueOnce(snapshot("blocked"))
      .mockReturnValue(stalled.promise);
    let healthyRevision = 0;
    const read = (id: string) =>
      id === "blocked"
        ? blocked()
        : Promise.resolve({ ...snapshot(id), live: { revision: ++healthyRevision } });
    const { hub, notify } = createHub(read);
    await hub.subscribe("blocked");
    const healthy = await hub.subscribe("healthy");

    await vi.advanceTimersByTimeAsync(500);
    expect(blocked).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map(([event]) => [event.subscriptionId, event.payload.live])).toEqual([
      [healthy.subscriptionId, { revision: 2 }],
      [healthy.subscriptionId, { revision: 3 }],
    ]);

    blocked.mockResolvedValue(snapshot("blocked"));
    stalled.reject(new Error("provider-read-failed"));
    await vi.advanceTimersByTimeAsync(250);
    expect(blocked).toHaveBeenCalledTimes(3);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        subscriptionId: healthy.subscriptionId,
        payload: expect.objectContaining({ live: { revision: 4 } }),
      }),
    );
  });

  it("backs off repeated failures for only the affected source", async () => {
    vi.useFakeTimers();
    const failing = vi.fn().mockResolvedValueOnce(snapshot("failing"));
    failing.mockRejectedValue(new Error("provider-read-failed"));
    const healthy = vi.fn().mockResolvedValue(snapshot("healthy"));
    const { hub } = createHub((id) => (id === "failing" ? failing() : healthy()));
    await hub.subscribe("failing");
    await hub.subscribe("healthy");

    await vi.advanceTimersByTimeAsync(750);
    expect(failing).toHaveBeenCalledTimes(3);
    expect(healthy).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(250);
    expect(failing).toHaveBeenCalledTimes(4);
    expect(healthy).toHaveBeenCalledTimes(5);
  });

  it("starts a fresh read after the last subscriber leaves instead of reviving its pending poll", async () => {
    vi.useFakeTimers();
    const oldPoll = deferred<Snapshot>();
    const read = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(oldPoll.promise)
      .mockResolvedValueOnce(snapshot("fresh"));
    const { hub } = createHub(read);
    const first = await hub.subscribe("session");
    await vi.advanceTimersByTimeAsync(250);
    hub.unsubscribe(first.subscriptionId);
    const next = await hub.subscribe("session");
    expect(read).toHaveBeenCalledTimes(3);
    expect(next.events[0]?.payload.live).toEqual(expect.objectContaining({ sessionId: "fresh" }));
    oldPoll.resolve(snapshot("stale"));
  });

  it("does not join an older read after a published live state changes its revision", async () => {
    vi.useFakeTimers();
    const oldPoll = deferred<Snapshot>();
    const freshRead = deferred<Snapshot>();
    const read = vi
      .fn()
      .mockResolvedValueOnce(snapshot())
      .mockReturnValueOnce(oldPoll.promise)
      .mockReturnValueOnce(freshRead.promise);
    const { hub, notify } = createHub(read);
    await hub.subscribe("session");
    await vi.advanceTimersByTimeAsync(250);
    hub.publish("session", "state", { status: "running" }, { status: "running" });
    const subscriptionPromise = hub.subscribe("session");
    expect(read).toHaveBeenCalledTimes(3);
    oldPoll.resolve(snapshot("old"));
    freshRead.resolve({ ...snapshot(), live: { status: "running", turnId: "active" } });
    const subscription = await subscriptionPromise;
    expect(subscription.events[0]?.payload.live).toEqual({ status: "running", turnId: "active" });
    expect(notify.mock.calls.map(([event]) => event.payload.live?.sessionId)).not.toContain("old");
  });

  it("replays the same cursor independently for concurrent subscribers", async () => {
    const secondRead = deferred<Snapshot>();
    const read = vi.fn().mockResolvedValueOnce(snapshot()).mockReturnValue(secondRead.promise);
    const { hub, notify } = createHub(read);
    const first = await hub.subscribe("session");
    hub.publish("session", "state", { status: "waiting" });
    const secondPromise = hub.subscribe("session", first.cursor);
    const thirdPromise = hub.subscribe("session", first.cursor);
    secondRead.resolve(snapshot());
    const [second, third] = await Promise.all([secondPromise, thirdPromise]);
    expect(read).toHaveBeenCalledTimes(2);
    for (const subscription of [second, third]) {
      expect(subscription.events).toEqual([
        expect.objectContaining({
          type: "state",
          subscriptionId: subscription.subscriptionId,
          payload: { status: "waiting" },
        }),
      ]);
    }
    hub.publish("session", "state", { status: "running" });
    expect(notify.mock.calls.map(([event]) => event.subscriptionId)).toEqual([
      first.subscriptionId,
      first.subscriptionId,
      second.subscriptionId,
      third.subscriptionId,
    ]);
  });

  it("continues fresh 250 ms polls when history is unchanged and recovers after read failure", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(snapshot());
    const { hub, notify } = createHub(read);
    await hub.subscribe("session");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(5);
    expect(notify).not.toHaveBeenCalled();
    read.mockRejectedValueOnce(new Error("temporary-owner-check-failure"));
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(6);
    expect(hub.hasSubscribers("session")).toBe(true);
    read.mockResolvedValue({ ...snapshot(), live: { status: "blocked" } });
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(7);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0].payload.live).toEqual({ status: "blocked" });
  });

  it("keeps older pages through appends, and invalidates them when unretained history changes", async () => {
    vi.useFakeTimers();
    const row = (index: number) => ({
      id: String(index),
      turn_id: String(index),
      content: "x".repeat(16 * 1024),
    });
    let items = Array.from({ length: 75 }, (_, index) => row(index));
    const { hub, notify } = createHub(async () => ({ ...snapshot(), items }));
    const first = (await hub.subscribe("session")).events[0];
    const epoch = first.payload.historyCacheEpoch;
    expect(epoch).toEqual(expect.any(String));
    expect(first.payload.items).not.toContainEqual(row(0));

    items = [...items, row(75)];
    await vi.advanceTimersByTimeAsync(250);
    const appended = notify.mock.calls.at(-1)?.[0];
    expect(appended.payload.historyCacheEpoch).toBe(epoch);
    expect(appended.payload.items.at(-1)).toEqual(row(75));

    const ending = { ...row(75), turn_meta: { duration_ms: 40 } };
    items = [...items.slice(0, -1), ending, row(76)];
    hub.publish("session", "item-upsert", ending);
    hub.publish("session", "item-upsert", row(76));
    await vi.advanceTimersByTimeAsync(250);
    const afterLiveAppend = (await hub.subscribe("session")).events[0];
    expect(afterLiveAppend.payload.historyCacheEpoch).toBe(epoch);

    // This rewrite is outside the retained window. The tail can be unchanged,
    // but subscribers still need the new history epoch to drop the older copy.
    items = items.map((item) => (item.id === "0" ? { ...item, content: "rewritten" } : item));
    notify.mockClear();
    await vi.advanceTimersByTimeAsync(250);
    expect(notify).toHaveBeenCalled();
    const replaced = notify.mock.calls.at(-1)?.[0];
    expect(replaced.type).toBe("snapshot");
    expect(replaced.payload.historyCacheEpoch).not.toBe(epoch);
    expect(replaced.payload.items.at(-1)).toEqual(row(76));
  });

  it("cannot recreate a subscription after the hub closes during a read", async () => {
    const delayed = deferred<Snapshot>();
    const { hub, observed } = createHub(() => delayed.promise);
    const subscription = hub.subscribe("session");
    const rejection = expect(subscription).rejects.toThrow("session-stream-unavailable");
    hub.close();
    delayed.resolve(snapshot());
    await rejection;
    expect(hub.hasSubscribers("session")).toBe(false);
    expect(observed).not.toHaveBeenCalled();
  });

  it("counts pending subscribers toward the bounded subscription limit", async () => {
    const delayed = deferred<Snapshot>();
    const read = vi.fn(() => delayed.promise);
    const { hub } = createHub(read);
    const subscriptions = Array.from({ length: 128 }, () => hub.subscribe("session"));
    const overflow = hub.subscribe("session");
    const rejection = expect(overflow).rejects.toThrow("session-subscription-limit");
    delayed.resolve(snapshot());
    await rejection;
    await Promise.all(subscriptions);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
