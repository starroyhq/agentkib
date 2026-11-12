// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationHub } from "./conversation-hub";
import { RUNTIME_METHODS, type SessionStreamEvent } from "../generated/runtime-protocol";

const event = (
  seq: number,
  type: SessionStreamEvent["type"] = "text-delta",
): SessionStreamEvent => ({
  protocolVersion: 2,
  subscriptionId: "sub",
  sessionId: "session",
  runtimeBootId: "boot",
  epoch: "epoch",
  seq,
  cursor: `epoch:${seq}`,
  type,
  payload: { text: "x", offset: seq - 1 },
});

describe("shared conversation dispatcher", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("orders baseline before notifications that precede the RPC response", async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hub = new ConversationHub(request);
    const received: SessionStreamEvent[] = [];
    const subscription = hub.subscribe("session", undefined, (event) => received.push(event));
    hub.notification("sessions.event", event(1));
    finish({ subscriptionId: "sub", events: [event(0, "snapshot")], cursor: "epoch:0" });
    expect((await subscription).events.map((event) => event.seq)).toEqual([0, 1]);
    hub.notification("sessions.event", event(2));
    expect(received.map((event) => event.seq)).toEqual([2]);
  });

  it("cancels only observation and forwards a reconnect cursor unchanged", async () => {
    const request = vi.fn(async () => ({ subscriptionId: "sub", events: [], cursor: "epoch:4" }));
    const hub = new ConversationHub(request);
    const received = vi.fn();
    await hub.subscribe("session", "epoch:4", received);
    expect(request).toHaveBeenCalledWith(RUNTIME_METHODS.sessionsSubscribe, {
      sessionId: "session",
      afterCursor: "epoch:4",
    });
    await hub.unsubscribe("sub");
    hub.notification("sessions.event", event(5));
    expect(received).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith(RUNTIME_METHODS.sessionsUnsubscribe, {
      subscriptionId: "sub",
    });
  });

  it("forwards session invalidations without refreshing the catalog for unrelated domains", async () => {
    const request = vi.fn(async () => ({ subscriptionId: "sub", events: [], cursor: "epoch:0" }));
    const hub = new ConversationHub(request);
    const received = vi.fn();
    const catalogChanged = vi.fn();
    hub.on("catalog-invalidated", catalogChanged);
    await hub.subscribe("session", undefined, received);

    const history = { ...event(1, "invalidate"), payload: { domains: ["history", "queue"] } };
    const catalog = { ...event(2, "invalidate"), payload: { domains: ["history", "catalog"] } };
    hub.notification("sessions.event", history);
    expect(received).toHaveBeenCalledWith(history);
    expect(catalogChanged).not.toHaveBeenCalled();
    hub.notification("sessions.event", catalog);
    expect(received).toHaveBeenLastCalledWith(catalog);
    expect(catalogChanged).toHaveBeenCalledOnce();
  });

  it("rejects a baseline from the Runtime generation that just exited", async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hub = new ConversationHub(request);
    const pending = hub.subscribe("session", undefined, vi.fn());
    hub.unavailable();
    finish({ subscriptionId: "sub", events: [], cursor: "epoch:0" });
    await expect(pending).rejects.toThrow("runtime_restarted");
    expect(request).toHaveBeenCalledOnce();
  });

  it("retries busy cleanup after bounded backoff without restoring observation", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    let attempts = 0;
    const request = vi.fn(async (method: string) => {
      if (method === RUNTIME_METHODS.sessionsSubscribe)
        return { subscriptionId: "sub", events: [], cursor: "epoch:0" };
      if (++attempts < 3) throw new Error("web-busy");
      return { removed: true };
    });
    const hub = new ConversationHub(request);
    const listener = vi.fn();
    await hub.subscribe("session", undefined, listener);
    await hub.unsubscribe("sub");
    hub.notification("sessions.event", event(1));
    expect(listener).not.toHaveBeenCalled();
    expect(attempts).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(timeout.mock.results.at(-1)?.value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(99);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
    await hub.unsubscribe("sub");
    expect(attempts).toBe(3);
    expect(
      request.mock.calls.filter(([method]) => method === RUNTIME_METHODS.sessionsSubscribe),
    ).toHaveLength(1);
  });

  it("deduplicates cancellation and serializes cleanup across subscriptions", async () => {
    vi.useFakeTimers();
    let subscriptions = 0;
    const finishes: (() => void)[] = [];
    const request = vi.fn(async (method: string) => {
      if (method === RUNTIME_METHODS.sessionsSubscribe)
        return { subscriptionId: `sub-${++subscriptions}`, events: [], cursor: "epoch:0" };
      return new Promise<void>((resolve) => finishes.push(resolve));
    });
    const hub = new ConversationHub(request);
    await hub.subscribe("session", undefined, vi.fn());
    await hub.subscribe("session", undefined, vi.fn());
    const first = hub.unsubscribe("sub-1");
    await hub.unsubscribe("sub-1");
    await hub.unsubscribe("sub-2");
    expect(finishes).toHaveLength(1);
    finishes[0]();
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(finishes).toHaveLength(2);
    await hub.unsubscribe("sub-2");
    expect(finishes).toHaveLength(2);
    finishes[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      RUNTIME_METHODS.sessionsSubscribe,
      RUNTIME_METHODS.sessionsSubscribe,
      RUNTIME_METHODS.sessionsUnsubscribe,
      RUNTIME_METHODS.sessionsUnsubscribe,
    ]);
  });

  it("caps cleanup retry delay and cancels its unreferenced timer when Runtime exits", async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const request = vi.fn(async (method: string) => {
      if (method === RUNTIME_METHODS.sessionsSubscribe)
        return { subscriptionId: "sub", events: [], cursor: "epoch:0" };
      throw new Error("web-busy");
    });
    const hub = new ConversationHub(request);
    await hub.subscribe("session", undefined, vi.fn());
    await hub.unsubscribe("sub");
    for (const delay of [100, 200, 400, 800, 1600, 3200, 5000, 5000]) {
      expect(timeout.mock.calls.at(-1)?.[1]).toBe(delay);
      expect(timeout.mock.results.at(-1)?.value.hasRef()).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(delay);
    }
    const calls = request.mock.calls.length;
    hub.unavailable();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await hub.unsubscribe("sub");
    expect(request).toHaveBeenCalledTimes(calls);
  });

  it("ignores late cleanup failure from an exited Runtime after a new subscription", async () => {
    vi.useFakeTimers();
    let rejectCleanup!: (error: Error) => void;
    const request = vi.fn(async (method: string) => {
      if (method === RUNTIME_METHODS.sessionsSubscribe)
        return { subscriptionId: "sub", events: [], cursor: "epoch:0" };
      return new Promise((_resolve, reject) => {
        rejectCleanup = reject;
      });
    });
    const hub = new ConversationHub(request);
    await hub.subscribe("session", undefined, vi.fn());
    const cleanup = hub.unsubscribe("sub");
    hub.unavailable();
    const listener = vi.fn();
    await hub.subscribe("session", undefined, listener);
    rejectCleanup(new Error("web-busy"));
    await cleanup;
    await vi.advanceTimersByTimeAsync(10_000);
    hub.notification("sessions.event", event(1));
    expect(listener).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains cleanup retries across scope changes, including a pending baseline", async () => {
    vi.useFakeTimers();
    let finishSubscribe!: (value: unknown) => void;
    let subscriptions = 0;
    const failures = new Set<string>();
    const request = vi.fn(async (method: string, params: unknown) => {
      if (method === RUNTIME_METHODS.sessionsSubscribe) {
        if (++subscriptions === 1) return { subscriptionId: "sub", events: [], cursor: "epoch:0" };
        return new Promise((resolve) => {
          finishSubscribe = resolve;
        });
      }
      const id = (params as { subscriptionId: string }).subscriptionId;
      if (!failures.has(id)) {
        failures.add(id);
        throw new Error("web-busy");
      }
      return { removed: true };
    });
    const hub = new ConversationHub(request);
    const listener = vi.fn();
    await hub.subscribe("session", undefined, listener);
    const pending = hub.subscribe("session", undefined, listener);
    const rejected = expect(pending).rejects.toThrow("runtime_restarted");
    hub.scopesChanged();
    await vi.advanceTimersByTimeAsync(0);
    hub.scopesChanged();
    finishSubscribe({ subscriptionId: "late-sub", events: [], cursor: "epoch:0" });
    await rejected;
    hub.notification("sessions.event", event(1));
    expect(listener).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(101);
    expect(
      request.mock.calls
        .filter(([method]) => method === RUNTIME_METHODS.sessionsUnsubscribe)
        .map(([, params]) => (params as { subscriptionId: string }).subscriptionId),
    ).toEqual(["sub", "late-sub", "sub", "late-sub"]);
    expect(vi.getTimerCount()).toBe(0);
    expect(subscriptions).toBe(2);
  });

  it("bounds the pre-baseline race buffer and asks for resynchronization", async () => {
    let finish!: (value: unknown) => void;
    const hub = new ConversationHub(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = hub.subscribe("session", undefined, vi.fn());
    for (let seq = 1; seq <= 257; seq++) hub.notification("sessions.event", event(seq));
    finish({ subscriptionId: "sub", events: [event(0, "snapshot")], cursor: "epoch:0" });
    expect((await pending).events.at(-1)?.type).toBe("resync-required");
  });

  it("bounds early payload bytes even when only a few events arrive", async () => {
    let finish!: (value: unknown) => void;
    const hub = new ConversationHub(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = hub.subscribe("session", undefined, vi.fn());
    hub.notification("sessions.event", {
      ...event(1),
      payload: { text: "x".repeat(4 * 1024 * 1024) },
    });
    hub.notification("sessions.event", event(2));
    finish({ subscriptionId: "sub", events: [event(0, "snapshot")], cursor: "epoch:0" });
    const result = await pending;
    expect(result.events).toHaveLength(2);
    expect(result.events[1].type).toBe("resync-required");
    expect(JSON.stringify(result).length).toBeLessThan(2048);
  });

  it("revokes observations after workspace scope changes without controlling the task", async () => {
    const request = vi.fn(async () => ({ subscriptionId: "sub", events: [], cursor: "epoch:4" }));
    const hub = new ConversationHub(request);
    const received = vi.fn();
    const unavailable = vi.fn();
    hub.on("unavailable", unavailable);
    await hub.subscribe("session", undefined, received);
    hub.scopesChanged();
    hub.notification("sessions.event", event(5));
    expect(unavailable).toHaveBeenCalledOnce();
    expect(received).not.toHaveBeenCalled();
    expect(request).toHaveBeenLastCalledWith(RUNTIME_METHODS.sessionsUnsubscribe, {
      subscriptionId: "sub",
    });
  });
});
