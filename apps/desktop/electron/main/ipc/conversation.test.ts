// @vitest-environment node
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WebContents, IpcMainInvokeEvent } from "electron";
import type { WebAccessService } from "../web/service";
import type { ConversationHub } from "../conversation-hub";
import type { SessionStreamEvent, SessionSubscription } from "../../generated/runtime-protocol";

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
  },
}));
import { registerConversationIpc } from "./conversation";

const EVENT_CHANNEL = "agentkib:conversation:event";
const CONTROL_CHANNEL = "agentkib:conversation:control-changed";
const MAX_EVENTS = 256;
const MAX_BYTES = 4 * 1024 * 1024;

function createSender(id = 1) {
  return Object.assign(new EventEmitter(), {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  });
}
type Sender = ReturnType<typeof createSender>;

function streamEvent(seq: number, subscriptionId = "sub", text = "x"): SessionStreamEvent {
  return {
    protocolVersion: 2,
    subscriptionId,
    sessionId: "session",
    runtimeBootId: "boot",
    epoch: "epoch",
    seq,
    cursor: `epoch:${seq}`,
    type: "text-delta",
    payload: { text, offset: seq - 1 },
  };
}

function setup() {
  const sender = createSender();
  const completions: ((result: SessionSubscription) => void)[] = [];
  const listeners: ((event: SessionStreamEvent) => void)[] = [];
  const controls = new EventEmitter();
  const localSubscribe = vi.fn(
    (
      _sessionId: string,
      _cursor: string | undefined,
      listener: (event: SessionStreamEvent) => void,
    ) => {
      listeners.push(listener);
      return new Promise<SessionSubscription>((resolve) => completions.push(resolve));
    },
  );
  const localRequest = vi.fn(
    async (_path: string, _body?: unknown, _upload?: Uint8Array, _signal?: AbortSignal) => ({
      status: 200,
      body: {},
    }),
  );
  const hub = Object.assign(new EventEmitter(), { unsubscribe: vi.fn(async () => {}) });
  const assertTrustedRenderer = vi.fn();
  registerConversationIpc({
    service: {
      localSubscribe,
      localRequest,
      onControlChanged: (listener: (sessionId: string) => void) => {
        controls.on("changed", listener);
        return () => controls.off("changed", listener);
      },
    } as unknown as WebAccessService,
    hub: hub as unknown as ConversationHub,
    assertTrustedRenderer,
  });
  const invoke = (method: string, source: Sender, ...args: unknown[]) =>
    handlers.get(`agentkib:conversation:${method}`)!(
      { sender: source as unknown as WebContents } as IpcMainInvokeEvent,
      ...args,
    );
  const subscribe = (source = sender) =>
    invoke("subscribe", source, "session", undefined) as Promise<SessionSubscription>;
  const finish = (index: number, subscriptionId = "sub", events: SessionStreamEvent[] = []) =>
    completions[index]({ subscriptionId, events, cursor: events.at(-1)?.cursor ?? "epoch:0" });
  const open = async (
    subscriptionId = "sub",
    source = sender,
    events: SessionStreamEvent[] = [],
  ) => {
    const pending = subscribe(source);
    const index = completions.length - 1;
    finish(index, subscriptionId, events);
    await pending;
    return listeners[index];
  };
  const acknowledge = (cursor: string, subscriptionId = "sub", source = sender) =>
    invoke("acknowledge", source, subscriptionId, cursor);
  const acknowledgeControl = (notificationId: unknown, source = sender) =>
    invoke("acknowledge-control", source, notificationId);
  const notifyControl = (sessionId = "session") => controls.emit("changed", sessionId);
  return {
    sender,
    completions,
    listeners,
    hub,
    subscribe,
    finish,
    open,
    invoke,
    localSubscribe,
    localRequest,
    assertTrustedRenderer,
    acknowledge,
    acknowledgeControl,
    notifyControl,
  };
}

function sentEvents(sender: Sender): SessionStreamEvent[] {
  return sender.send.mock.calls
    .filter(([channel]) => channel === EVENT_CHANNEL)
    .map(([, event]) => event as SessionStreamEvent);
}

function sentControls(sender: Sender): { sessionId: string; notificationId: unknown }[] {
  return sender.send.mock.calls
    .filter(([channel]) => channel === CONTROL_CHANNEL)
    .map(([, event]) => event as { sessionId: string; notificationId: unknown });
}

function expectOverflow(event: SessionStreamEvent | undefined) {
  expect(event).toMatchObject({
    subscriptionId: "sub",
    type: "resync-required",
    payload: { reason: "desktop-subscriber-overflow" },
  });
  expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(1024);
}

beforeEach(() => handlers.clear());

describe("conversation IPC history read cancellation", () => {
  function hold(fixture: ReturnType<typeof setup>) {
    fixture.localRequest.mockImplementation(
      (_path, _body, _upload, signal) =>
        new Promise((resolve) => {
          signal!.addEventListener("abort", () => resolve({ status: 408, body: {} }), {
            once: true,
          });
        }),
    );
  }

  it.each([
    "history/search",
    "/history/locate",
    "/api/web/v1/history/references",
    "history/status",
  ])("cancels only the owning window's %s read even with the same nonce", async (path) => {
    const fixture = setup();
    hold(fixture);
    const other = createSender(2);
    const nonce = randomUUID();
    const first = fixture.invoke("request", fixture.sender, path, {}, nonce);
    const second = fixture.invoke("request", other, path, {}, nonce);
    const signals = fixture.localRequest.mock.calls.map((call) => call[3]!);
    await fixture.invoke("cancel-read", fixture.sender, randomUUID());
    expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
    await fixture.invoke("cancel-read", fixture.sender, nonce);
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(await first).toMatchObject({ status: 408 });
    await fixture.invoke("cancel-read", other, nonce);
    expect(await second).toMatchObject({ status: 408 });
    await fixture.invoke("cancel-read", fixture.sender, nonce);
    expect(fixture.localRequest).toHaveBeenCalledTimes(2);
  });

  it.each(["/send", "/codex/action", "/history/clear", "/history/search?requestId=foreign"])(
    "rejects cancellation handles for %s before dispatch",
    async (path) => {
      const fixture = setup();
      await expect(
        fixture.invoke("request", fixture.sender, path, {}, randomUUID()),
      ).rejects.toThrow("history_read_route_required");
      expect(fixture.localRequest).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy and mutation requests outside the cancellation map", async () => {
    const fixture = setup();
    await fixture.invoke("request", fixture.sender, "/send", { requestId: "receipt" });
    expect(fixture.localRequest).toHaveBeenCalledExactlyOnceWith("/send", { requestId: "receipt" });
    await fixture.invoke("cancel-read", fixture.sender, randomUUID());
    expect(fixture.localRequest).toHaveBeenCalledOnce();
  });

  it("validates the trusted sender before reading or cancelling a nonce", async () => {
    const fixture = setup();
    fixture.assertTrustedRenderer.mockImplementation(() => {
      throw new Error("untrusted");
    });
    await expect(
      fixture.invoke("request", fixture.sender, "/history/status", undefined, randomUUID()),
    ).rejects.toThrow("untrusted");
    expect(() => fixture.invoke("cancel-read", fixture.sender, randomUUID())).toThrow("untrusted");
    expect(fixture.localRequest).not.toHaveBeenCalled();
  });

  it("bounds pending reads, rejects duplicate active nonces, and frees cancelled slots", async () => {
    const fixture = setup();
    hold(fixture);
    const nonces = Array.from({ length: 8 }, () => randomUUID());
    const pending = nonces.map((nonce) =>
      fixture.invoke("request", fixture.sender, "/history/status", undefined, nonce),
    );
    await expect(
      fixture.invoke("request", fixture.sender, "/history/status", undefined, nonces[0]),
    ).rejects.toThrow("history_read_request_conflict");
    await expect(
      fixture.invoke("request", fixture.sender, "/history/status", undefined, randomUUID()),
    ).rejects.toThrow("history_read_limit");
    for (const nonce of nonces) await fixture.invoke("cancel-read", fixture.sender, nonce);
    await Promise.all(pending);
    fixture.localRequest.mockResolvedValueOnce({ status: 200, body: {} });
    await expect(
      fixture.invoke("request", fixture.sender, "/history/status", undefined, nonces[0]),
    ).resolves.toMatchObject({ status: 200 });
  });

  it.each(["navigation", "destroyed", "render-process-gone", "unavailable"])(
    "cancels active reads on %s",
    async (event) => {
      const fixture = setup();
      hold(fixture);
      const pending = fixture.invoke(
        "request",
        fixture.sender,
        "/history/status",
        undefined,
        randomUUID(),
      );
      if (event === "navigation")
        fixture.sender.emit("did-start-navigation", {}, "http://local", false, true);
      else if (event === "unavailable") fixture.hub.emit("unavailable");
      else fixture.sender.emit(event);
      expect(await pending).toMatchObject({ status: 408 });
    },
  );
});

describe("conversation IPC subscription lifetime", () => {
  it("counts pending subscriptions against the renderer limit", async () => {
    const fixture = setup();
    const pending = Array.from({ length: 4 }, () => fixture.subscribe());
    await expect(fixture.subscribe()).rejects.toThrow("stream_limit");
    expect(fixture.localSubscribe).toHaveBeenCalledTimes(4);
    fixture.completions.forEach((_finish, index) => fixture.finish(index, `sub-${index}`));
    await Promise.all(pending);
  });

  it.each(["navigation", "render-process-gone", "unavailable"] as const)(
    "does not count old pending subscriptions against the next renderer generation after %s",
    async (reason) => {
      const fixture = setup();
      const stale = Promise.allSettled(Array.from({ length: 4 }, () => fixture.subscribe()));
      if (reason === "navigation")
        fixture.sender.emit("did-start-navigation", {}, "app://bundle/index.html", false, true);
      else if (reason === "unavailable") fixture.hub.emit("unavailable");
      else fixture.sender.emit(reason);

      const fresh = Promise.allSettled(Array.from({ length: 4 }, () => fixture.subscribe()));
      expect(fixture.localSubscribe).toHaveBeenCalledTimes(8);
      for (let index = 0; index < 4; index++) fixture.finish(index, `old-${index}`);
      expect(await stale).toEqual(
        Array.from({ length: 4 }, () => ({
          status: "rejected",
          reason: new Error("renderer_closed"),
        })),
      );
      expect(fixture.hub.unsubscribe.mock.calls).toEqual(
        Array.from({ length: 4 }, (_, index) => [`old-${index}`]),
      );

      const excess = Promise.allSettled([fixture.subscribe()]);
      expect(fixture.localSubscribe).toHaveBeenCalledTimes(8);
      expect(await excess).toEqual([{ status: "rejected", reason: new Error("stream_limit") }]);
      for (let index = 0; index < 4; index++) fixture.finish(index + 4, `new-${index}`);
      expect((await fresh).map(({ status }) => status)).toEqual(Array(4).fill("fulfilled"));
    },
  );

  it("notifies a renderer with only pending subscriptions that the Runtime is unavailable", async () => {
    const fixture = setup();
    const pending = fixture.subscribe();
    fixture.hub.emit("unavailable");
    fixture.finish(0);
    await expect(pending).rejects.toThrow("renderer_closed");
    expect(fixture.sender.send).toHaveBeenCalledExactlyOnceWith(
      "agentkib:conversation:unavailable",
    );
  });

  it("releases subscriptions on destruction without reading destroyed WebContents properties", async () => {
    const fixture = setup();
    await fixture.open("active");
    const pending = Promise.allSettled([fixture.subscribe()]);
    fixture.sender.isDestroyed.mockReturnValue(true);
    Object.defineProperty(fixture.sender, "id", {
      get() {
        throw new Error("WebContents was destroyed");
      },
    });
    expect(() => fixture.sender.emit("destroyed")).not.toThrow();
    fixture.finish(1, "pending");
    expect(await pending).toEqual([{ status: "rejected", reason: new Error("renderer_closed") }]);
    expect(fixture.hub.unsubscribe.mock.calls).toEqual([["active"], ["pending"]]);
    await expect(fixture.subscribe()).rejects.toThrow("renderer_closed");
    expect(fixture.localSubscribe).toHaveBeenCalledTimes(2);
  });

  it("releases a subscription whose renderer navigated before bootstrap returned", async () => {
    const fixture = setup();
    const pending = fixture.subscribe();
    fixture.sender.emit("did-start-navigation", {}, "app://bundle/index.html", false, true);
    fixture.finish(0, "old-page");
    await expect(pending).rejects.toThrow("renderer_closed");
    expect(fixture.hub.unsubscribe).toHaveBeenCalledWith("old-page");
  });

  it.each(["navigation", "destroyed", "render-process-gone", "unavailable"])(
    "stops old listeners and releases owner slots after %s",
    async (reason) => {
      const fixture = setup();
      const listener = await fixture.open();
      if (reason === "navigation")
        fixture.sender.emit("did-start-navigation", {}, "app://bundle/index.html", false, true);
      else if (reason === "unavailable") fixture.hub.emit("unavailable");
      else {
        if (reason === "destroyed") fixture.sender.isDestroyed.mockReturnValue(true);
        fixture.sender.emit(reason);
      }
      listener(streamEvent(1));
      fixture.notifyControl();
      expect(sentEvents(fixture.sender)).toEqual([]);
      expect(sentControls(fixture.sender)).toEqual([]);
      if (reason === "unavailable")
        expect(fixture.sender.send).toHaveBeenCalledWith("agentkib:conversation:unavailable");
      else expect(fixture.hub.unsubscribe).toHaveBeenCalledWith("sub");
      if (reason !== "destroyed") {
        const pending = Array.from({ length: 4 }, () => fixture.subscribe());
        fixture.completions
          .slice(1)
          .forEach((_finish, index) => fixture.finish(index + 1, `new-${index}`));
        await Promise.all(pending);
      }
    },
  );

  it("keeps subscriptions across subframe and in-place navigation", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    fixture.sender.emit("did-start-navigation", {}, "app://bundle/frame.html", false, false);
    fixture.sender.emit("did-start-navigation", {}, "app://bundle/index.html#tab", true, true);
    listener(streamEvent(1));
    expect(sentEvents(fixture.sender)).toEqual([streamEvent(1)]);
    expect(fixture.hub.unsubscribe).not.toHaveBeenCalled();
  });

  it("discards an in-flight bootstrap after Runtime becomes unavailable", async () => {
    const fixture = setup();
    const pending = fixture.subscribe();
    fixture.hub.emit("unavailable");
    fixture.listeners[0](streamEvent(1));
    fixture.finish(0);
    await expect(pending).rejects.toThrow();
    expect(sentEvents(fixture.sender)).toEqual([]);
    fixture.notifyControl();
    expect(sentControls(fixture.sender)).toEqual([]);
  });
});

describe("conversation IPC subscriber backpressure", () => {
  it("detaches a stalled subscriber once and sends only one small overflow event", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    for (let seq = 1; seq <= MAX_EVENTS; seq++) listener(streamEvent(seq));
    expect(sentEvents(fixture.sender)).toHaveLength(MAX_EVENTS);
    expect(fixture.hub.unsubscribe).not.toHaveBeenCalled();
    listener(streamEvent(MAX_EVENTS + 1));
    for (let seq = MAX_EVENTS + 2; seq <= 2 * MAX_EVENTS; seq++) listener(streamEvent(seq));
    const events = sentEvents(fixture.sender);
    expect(events).toHaveLength(MAX_EVENTS + 1);
    expectOverflow(events.at(-1));
    expect(fixture.hub.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
    expect(fixture.localRequest).not.toHaveBeenCalled();
    await fixture.acknowledge(events.at(-1)!.cursor);
    listener(streamEvent(2 * MAX_EVENTS + 1));
    expect(sentEvents(fixture.sender)).toHaveLength(MAX_EVENTS + 1);
  });

  it("retains an overflowed owner until an authorized unsubscribe releases its slot", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    for (let seq = 1; seq <= MAX_EVENTS + 1; seq++) listener(streamEvent(seq));
    for (let index = 1; index < 4; index++) await fixture.open(`sub-${index}`);
    await expect(fixture.subscribe()).rejects.toThrow("stream_limit");
    await fixture.invoke("unsubscribe", createSender(2), "sub");
    await expect(fixture.subscribe()).rejects.toThrow("stream_limit");
    await fixture.invoke("unsubscribe", fixture.sender, "sub");
    await fixture.open("replacement");
    expect(fixture.localSubscribe).toHaveBeenCalledTimes(5);
  });

  it("cumulatively releases acknowledged events and ignores a repeated old ACK", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    for (let seq = 1; seq <= MAX_EVENTS; seq++) listener(streamEvent(seq));
    await fixture.acknowledge("epoch:128");
    for (let seq = MAX_EVENTS + 1; seq <= MAX_EVENTS + 128; seq++) listener(streamEvent(seq));
    expect(fixture.hub.unsubscribe).not.toHaveBeenCalled();
    await fixture.acknowledge("epoch:128");
    await fixture.acknowledge("epoch:64");
    listener(streamEvent(MAX_EVENTS + 129));
    expectOverflow(sentEvents(fixture.sender).at(-1));
    expect(fixture.hub.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
  });

  it("rejects budget credit from another renderer, unknown subscriptions and unsent cursors", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    for (let seq = 1; seq <= MAX_EVENTS; seq++) listener(streamEvent(seq));
    await fixture.acknowledge("epoch:256", "sub", createSender(2));
    await fixture.acknowledge("epoch:256", "unknown-sub");
    await fixture.acknowledge("unknown-cursor");
    await fixture.acknowledge("epoch:257");
    listener(streamEvent(MAX_EVENTS + 1));
    expectOverflow(sentEvents(fixture.sender).at(-1));
    expect(fixture.assertTrustedRenderer).toHaveBeenCalledTimes(5);
  });

  it("counts UTF-8 bytes and releases byte credit on ACK", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    const text = "汉".repeat(700_000);
    const first = streamEvent(1, "sub", text);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(MAX_BYTES);
    expect(Buffer.byteLength(JSON.stringify(first)) * 2).toBeGreaterThan(MAX_BYTES);
    listener(first);
    await fixture.acknowledge(first.cursor);
    listener(streamEvent(2, "sub", text));
    expect(fixture.hub.unsubscribe).not.toHaveBeenCalled();
    listener(streamEvent(3, "sub", text));
    expect(sentEvents(fixture.sender)).toHaveLength(3);
    expectOverflow(sentEvents(fixture.sender).at(-1));
    expect(fixture.hub.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
  });

  it("replaces an individually oversized event without forwarding its payload", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    listener(streamEvent(1, "sub", "x".repeat(MAX_BYTES)));
    expect(sentEvents(fixture.sender)).toHaveLength(1);
    expectOverflow(sentEvents(fixture.sender)[0]);
    expect(fixture.hub.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
  });

  it("keeps a fast subscription on the same renderer alive when another overflows", async () => {
    const fixture = setup();
    const slow = await fixture.open();
    const fast = await fixture.open("fast");
    for (let seq = 1; seq <= MAX_EVENTS * 2; seq++) {
      slow(streamEvent(seq));
      fast(streamEvent(seq, "fast"));
      await fixture.acknowledge(`epoch:${seq}`, "fast");
    }
    const events = sentEvents(fixture.sender);
    expect(events.filter((event) => event.subscriptionId === "fast")).toHaveLength(MAX_EVENTS * 2);
    expect(events.filter((event) => event.type === "resync-required")).toHaveLength(1);
    expect(fixture.hub.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
    expect(fixture.localRequest).not.toHaveBeenCalled();
  });
});

describe("conversation IPC bootstrap buffering", () => {
  it("returns the baseline before listener events that arrive while subscribe is pending", async () => {
    const fixture = setup();
    const pending = fixture.subscribe();
    fixture.listeners[0](streamEvent(3));
    fixture.listeners[0](streamEvent(4));
    expect(sentEvents(fixture.sender)).toEqual([]);
    fixture.finish(0, "sub", [streamEvent(1), streamEvent(2)]);
    const result = await pending;
    expect(result.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(result.cursor).toBe("epoch:4");
    expect(sentEvents(fixture.sender)).toEqual([]);
    fixture.listeners[0](streamEvent(5));
    expect(sentEvents(fixture.sender)).toEqual([streamEvent(5)]);
  });

  it("does not charge listener events already included in the returned baseline twice", async () => {
    const fixture = setup();
    const pending = fixture.subscribe();
    fixture.listeners[0](streamEvent(MAX_EVENTS));
    fixture.finish(
      0,
      "sub",
      Array.from({ length: MAX_EVENTS }, (_, index) => streamEvent(index + 1)),
    );
    const result = await pending;
    expect(result.events).toHaveLength(MAX_EVENTS);
    expect(result.events.at(-1)).toEqual(streamEvent(MAX_EVENTS));
    expect(fixture.hub.unsubscribe).not.toHaveBeenCalled();
    await fixture.acknowledge(result.cursor);
    fixture.listeners[0](streamEvent(MAX_EVENTS + 1));
    expect(sentEvents(fixture.sender)).toEqual([streamEvent(MAX_EVENTS + 1)]);
  });

  it("ignores an ACK for a pending event that has not been delivered to the renderer", async () => {
    const fixture = setup();
    const pending = fixture.subscribe();
    for (let seq = 1; seq <= MAX_EVENTS; seq++) fixture.listeners[0](streamEvent(seq));
    await fixture.acknowledge(`epoch:${MAX_EVENTS}`);
    fixture.finish(0);
    expect((await pending).events).toHaveLength(MAX_EVENTS);
    fixture.listeners[0](streamEvent(MAX_EVENTS + 1));
    expect(sentEvents(fixture.sender)).toHaveLength(1);
    expectOverflow(sentEvents(fixture.sender)[0]);
  });

  it.each([
    { baseline: 257, early: 0 },
    { baseline: 0, early: 257 },
    { baseline: 128, early: 129 },
  ])(
    "bounds bootstrap events with $baseline baseline and $early pending events",
    async ({ baseline, early }) => {
      const fixture = setup();
      const pending = fixture.subscribe();
      for (let seq = baseline + 1; seq <= baseline + early; seq++)
        fixture.listeners[0](streamEvent(seq));
      expect(sentEvents(fixture.sender)).toEqual([]);
      fixture.finish(
        0,
        "sub",
        Array.from({ length: baseline }, (_, index) => streamEvent(index + 1)),
      );
      const result = await pending;
      expect(result.events).toHaveLength(1);
      expectOverflow(result.events[0]);
      expect(result.cursor).toBe(result.events[0].cursor);
      fixture.listeners[0](streamEvent(1000));
      expect(sentEvents(fixture.sender)).toEqual([]);
      expect(fixture.hub.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
    },
  );

  it("applies the byte limit across baseline and early listener events", async () => {
    const fixture = setup();
    const pending = fixture.subscribe();
    const text = "汉".repeat(700_000);
    fixture.listeners[0](streamEvent(2, "sub", text));
    fixture.finish(0, "sub", [streamEvent(1, "sub", text)]);
    const result = await pending;
    expect(result.events).toHaveLength(1);
    expectOverflow(result.events[0]);
    expect(sentEvents(fixture.sender)).toEqual([]);
    expect(fixture.hub.unsubscribe).toHaveBeenCalledExactlyOnceWith("sub");
  });

  it("charges bootstrap events to the live budget until their cursor is acknowledged", async () => {
    const fixture = setup();
    const events = Array.from({ length: MAX_EVENTS }, (_, index) => streamEvent(index + 1));
    const listener = await fixture.open("sub", fixture.sender, events);
    await fixture.acknowledge(events.at(-1)!.cursor);
    for (let seq = MAX_EVENTS + 1; seq <= MAX_EVENTS * 2; seq++) listener(streamEvent(seq));
    expect(fixture.hub.unsubscribe).not.toHaveBeenCalled();
    listener(streamEvent(MAX_EVENTS * 2 + 1));
    expectOverflow(sentEvents(fixture.sender).at(-1));
  });

  it("does not grant a separate live budget after a full bootstrap", async () => {
    const fixture = setup();
    const listener = await fixture.open(
      "sub",
      fixture.sender,
      Array.from({ length: MAX_EVENTS }, (_, index) => streamEvent(index + 1)),
    );
    listener(streamEvent(MAX_EVENTS + 1));
    expect(sentEvents(fixture.sender)).toHaveLength(1);
    expectOverflow(sentEvents(fixture.sender)[0]);
  });
});

describe("conversation IPC control notification backpressure", () => {
  it("coalesces repeated changes for one session behind one in-flight notification per renderer", async () => {
    const fixture = setup();
    await fixture.open();
    await fixture.open("second-sub");
    fixture.notifyControl();
    const first = sentControls(fixture.sender)[0];
    expect(first).toMatchObject({ sessionId: "session" });
    expect(first.notificationId).toBeDefined();
    for (let index = 0; index < 1000; index++) fixture.notifyControl();
    expect(sentControls(fixture.sender)).toHaveLength(1);
    await fixture.acknowledgeControl(first.notificationId);
    const second = sentControls(fixture.sender)[1];
    expect(second).toMatchObject({ sessionId: "session" });
    expect(second.notificationId).not.toEqual(first.notificationId);
    await fixture.acknowledgeControl(second.notificationId);
    expect(sentControls(fixture.sender)).toHaveLength(2);
  });

  it("merges changes for multiple sessions into one wildcard refresh", async () => {
    const fixture = setup();
    await fixture.open();
    fixture.notifyControl("first");
    fixture.notifyControl("second");
    fixture.notifyControl("third");
    fixture.notifyControl("second");
    await fixture.acknowledgeControl(sentControls(fixture.sender)[0].notificationId);
    expect(sentControls(fixture.sender).map((notification) => notification.sessionId)).toEqual([
      "first",
      "",
    ]);
    fixture.notifyControl("fourth");
    expect(sentControls(fixture.sender)).toHaveLength(2);
    await fixture.acknowledgeControl(sentControls(fixture.sender)[1].notificationId);
    expect(sentControls(fixture.sender)[2].sessionId).toBe("fourth");
  });

  it("ignores control ACKs from another sender and unknown or already released IDs", async () => {
    const fixture = setup();
    await fixture.open();
    fixture.notifyControl("first");
    fixture.notifyControl("second");
    const first = sentControls(fixture.sender)[0];
    await fixture.acknowledgeControl(first.notificationId, createSender(2));
    await fixture.acknowledgeControl("unknown-notification");
    expect(sentControls(fixture.sender)).toHaveLength(1);
    await fixture.acknowledgeControl(first.notificationId);
    fixture.notifyControl("third");
    await fixture.acknowledgeControl(first.notificationId);
    expect(sentControls(fixture.sender)).toHaveLength(2);
    await fixture.acknowledgeControl(sentControls(fixture.sender)[1].notificationId);
    expect(sentControls(fixture.sender)[2].sessionId).toBe("third");
  });

  it("lets another renderer acknowledge notifications while one remains stalled", async () => {
    const fixture = setup();
    const fast = createSender(2);
    await fixture.open();
    await fixture.open("fast", fast);
    fixture.notifyControl();
    for (let index = 0; index < 10; index++) {
      await fixture.acknowledgeControl(sentControls(fast).at(-1)!.notificationId, fast);
      fixture.notifyControl();
    }
    expect(sentControls(fixture.sender)).toHaveLength(1);
    expect(sentControls(fast)).toHaveLength(11);
  });

  it("keeps control credit shared with the remaining active subscription after another unsubscribes", async () => {
    const fixture = setup();
    await fixture.open();
    await fixture.open("second-sub");
    fixture.notifyControl("first");
    fixture.notifyControl("dirty");
    await fixture.invoke("unsubscribe", fixture.sender, "second-sub");
    expect(sentControls(fixture.sender)).toHaveLength(1);
    await fixture.acknowledgeControl(sentControls(fixture.sender)[0].notificationId);
    expect(sentControls(fixture.sender).map((notification) => notification.sessionId)).toEqual([
      "first",
      "dirty",
    ]);
  });

  it("drops control credit when the last active subscription overflows", async () => {
    const fixture = setup();
    const listener = await fixture.open();
    fixture.notifyControl("old");
    fixture.notifyControl("old-dirty");
    const oldId = sentControls(fixture.sender)[0].notificationId;
    for (let seq = 1; seq <= MAX_EVENTS + 1; seq++) listener(streamEvent(seq));
    fixture.notifyControl("stopped-owner");
    expect(sentControls(fixture.sender)).toHaveLength(1);
    await fixture.open("new-sub");
    fixture.notifyControl("new");
    expect(sentControls(fixture.sender)[1]).toMatchObject({ sessionId: "new" });
    fixture.notifyControl("new-dirty");
    await fixture.acknowledgeControl(oldId);
    expect(sentControls(fixture.sender)).toHaveLength(2);
    await fixture.acknowledgeControl(sentControls(fixture.sender)[1].notificationId);
    expect(sentControls(fixture.sender)[2].sessionId).toBe("new-dirty");
  });

  it.each(["navigation", "unsubscribe", "render-process-gone", "unavailable"])(
    "clears in-flight and dirty control state after %s",
    async (reason) => {
      const fixture = setup();
      await fixture.open();
      fixture.notifyControl("old");
      fixture.notifyControl("stale-dirty");
      const previousId = sentControls(fixture.sender)[0].notificationId;
      if (reason === "navigation")
        fixture.sender.emit("did-start-navigation", {}, "app://bundle/index.html", false, true);
      else if (reason === "unavailable") fixture.hub.emit("unavailable");
      else if (reason === "render-process-gone") fixture.sender.emit("render-process-gone");
      else await fixture.invoke("unsubscribe", fixture.sender, "sub");
      fixture.notifyControl("no-owner");
      expect(sentControls(fixture.sender)).toHaveLength(1);
      await fixture.open("new-sub");
      fixture.notifyControl("new");
      const next = sentControls(fixture.sender)[1];
      expect(next).toMatchObject({ sessionId: "new" });
      expect(next.notificationId).not.toEqual(previousId);
      fixture.notifyControl("new-dirty");
      await fixture.acknowledgeControl(previousId);
      expect(sentControls(fixture.sender)).toHaveLength(2);
      await fixture.acknowledgeControl(next.notificationId);
      expect(sentControls(fixture.sender)[2].sessionId).toBe("new-dirty");
    },
  );
});
