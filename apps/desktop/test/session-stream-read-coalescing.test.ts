import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeNativeCoverage, type ConversationEvent } from "@agentkib/conversation-state";
import { SessionStreamHub } from "../../../packages/backend/src/session-stream";
import {
  afterCatalogMutation,
  SessionCatalogRead,
} from "../../../packages/backend/src/session-catalog-stream";

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
  it("shares one catalog baseline and coalesces known sessions without reading the catalog again", async () => {
    vi.useFakeTimers();
    const workers = Array.from({ length: 5 }, (_, index) => ({
      id: `worker-${index}`,
      workspace_id: "approved-workspace",
      origin: index === 0 ? "auxiliary" : "interactive",
      continuation: { status: "idle" },
    }));
    const read = vi.fn().mockResolvedValue({
      live: { sessions: workers },
      items: [],
      completeItems: true,
    });
    const { hub, notify } = createHub(read);
    const first = await hub.subscribe("");
    const second = await hub.subscribe("");
    expect(read).toHaveBeenCalledTimes(1);

    for (const worker of workers) {
      hub.catalogContinuation(worker.id, { status: "starting", content: "never forwarded" });
      hub.catalogContinuation(worker.id, {
        status: "running",
        executionLocation: "agentkib",
        workspaceId: "unverified-workspace",
      });
    }
    hub.catalogContinuation("undiscovered-worker", { status: "running" });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(notify).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.map(([event]) => event.subscriptionId)).toEqual([
      first.subscriptionId,
      second.subscriptionId,
    ]);
    expect(notify.mock.calls[0]?.[0].payload).toEqual({
      domains: ["catalog"],
      catalogPatch: {
        updates: workers.map(({ id, workspace_id, origin }) => ({
          sessionId: id,
          workspaceId: workspace_id,
          auxiliary: origin === "auxiliary",
          continuation: { status: "running", executionLocation: "agentkib" },
        })),
      },
    });
    const reopened = await hub.subscribe("");
    expect(reopened.events[0]?.payload.live).toMatchObject({
      sessions: workers.map((worker) => ({
        ...worker,
        continuation: { status: "running", executionLocation: "agentkib" },
      })),
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("coalesces structural invalidations and retains a slow audit for external catalog changes", async () => {
    vi.useFakeTimers();
    const catalog = (sessions: unknown[]) => ({
      live: { sessions },
      items: [],
      completeItems: true,
    });
    const read = vi.fn().mockResolvedValue(catalog([]));
    const { hub, notify } = createHub(read);
    await hub.subscribe("");
    for (let index = 0; index < 30; index++) hub.invalidateCatalog();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(read).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0]?.[0].payload).toEqual({ domains: ["catalog"] });

    await vi.advanceTimersByTimeAsync(14_750);
    expect(read).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledTimes(1);
    read.mockResolvedValue(catalog([{ id: "new", workspace_id: "workspace" }]));
    await vi.advanceTimersByTimeAsync(250);
    expect(read).toHaveBeenCalledTimes(3);
    expect(notify.mock.calls[1]?.[0].payload).toEqual({
      domains: ["catalog"],
      catalogPatch: {
        updates: [
          {
            sessionId: "new",
            workspaceId: "workspace",
            auxiliary: false,
            row: { id: "new", workspace_id: "workspace" },
          },
        ],
      },
    });
  });

  it("coalesces title, archive and removal into scoped row changes", async () => {
    vi.useFakeTimers();
    const row = { id: "changed", workspace_id: "workspace", agent: "claude-code", archived: false };
    const removed = { ...row, id: "removed" };
    const catalog = (sessions: unknown[], complete = true) => ({
      live: { sessions, complete },
      items: [],
      completeItems: true,
    });
    const read = vi.fn().mockResolvedValue(catalog([row, removed]));
    const { hub, notify } = createHub(read);
    await hub.subscribe("");
    read.mockResolvedValue(catalog([{ ...row, title: "New title", archived: true }]));
    hub.invalidateCatalog(false);
    await vi.advanceTimersByTimeAsync(2500);
    expect(notify.mock.calls[0]?.[0].payload).toEqual({
      domains: ["catalog"],
      catalogPatch: {
        updates: [
          {
            sessionId: "changed",
            workspaceId: "workspace",
            auxiliary: false,
            title: "New title",
            archived: true,
          },
          { sessionId: "removed", workspaceId: "workspace", auxiliary: false, removed: true },
        ],
      },
    });
  });

  it("audits indexed activity by identity so a newer timestamp and native turn update only one row", async () => {
    vi.useFakeTimers();
    const previousTime = "2026-11-26T01:00:00.000Z";
    const updatedAt = "2026-11-26T02:00:00.000Z";
    const idle = { id: "idle", workspace_id: "workspace", updated_at: previousTime };
    const worker = {
      id: "worker",
      workspace_id: "workspace",
      updated_at: previousTime,
      continuation: { status: "idle" },
    };
    const externalTurn = { status: "running", startedAt: updatedAt, turnId: "native-turn" };
    const catalog = (sessions: unknown[]) => ({
      live: { sessions },
      items: [],
      completeItems: true,
    });
    const read = vi.fn().mockResolvedValue(catalog([idle, worker]));
    const { hub, notify } = createHub(read);
    await hub.subscribe("");
    read.mockResolvedValue(
      catalog([{ ...worker, updated_at: updatedAt, continuation: null, externalTurn }, idle]),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(notify.mock.calls[0]?.[0].payload).toEqual({
      domains: ["catalog"],
      catalogPatch: {
        updates: [
          {
            sessionId: "worker",
            workspaceId: "workspace",
            auxiliary: false,
            continuation: null,
            updatedAt,
            externalTurn,
          },
        ],
      },
    });
    read.mockResolvedValue(catalog([{ ...worker, updated_at: updatedAt }, idle]));
    hub.catalogContinuation(worker.id, { status: "idle" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(notify.mock.calls[1]?.[0].payload.catalogPatch.updates).toEqual([
      {
        sessionId: "worker",
        workspaceId: "workspace",
        auxiliary: false,
        continuation: worker.continuation,
        externalTurn: null,
      },
    ]);
  });

  it("shares a catalog read until a mutation, then waits for a fresh serialized projection", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const reader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const catalog = new SessionCatalogRead();
    const before = catalog.read(reader);
    expect(catalog.read(reader)).toBe(before);
    const fenced = vi.fn(() => catalog.invalidate());
    await afterCatalogMutation("rename", { accepted: false }, true, fenced);
    await afterCatalogMutation("send", { accepted: true }, true, fenced);
    expect(fenced).not.toHaveBeenCalled();
    const accepted = { accepted: true };
    await expect(afterCatalogMutation("rename", accepted, true, fenced)).resolves.toBe(accepted);
    expect(fenced).toHaveBeenCalledOnce();
    const after = catalog.read(reader);
    const other = catalog.read(reader);
    await Promise.resolve();
    expect(reader).toHaveBeenCalledTimes(1);
    first.resolve("old");
    expect(await before).toBe("old");
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
    second.resolve("new");
    expect(await Promise.all([after, other])).toEqual(["new", "new"]);
    expect(reader).toHaveBeenCalledTimes(2);
  });

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

  it.each(["native history", "live preview"])(
    "keeps one persisted tool row when %s arrives first",
    async (first) => {
      vi.useFakeTimers();
      const live = { status: "running", turnId: "bridge-turn", transcriptTurnId: "turn" };
      const native = {
        id: "toolu_shared",
        kind: "tool-summary",
        turn_id: "turn",
        tool_status: "completed",
      };
      const preview = {
        ...native,
        id: "claude-follower-tool:toolu_shared",
        tool_status: "running",
        ephemeral: true,
      };
      let items = first === "native history" ? [native] : [];
      const { hub, notify } = createHub(async () => ({ live, items, completeItems: false }));
      await hub.subscribe("session");
      hub.publish("session", "item-upsert", preview, live);
      if (first === "live preview") {
        expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({
          type: "item-upsert",
          payload: preview,
        });
        items = [native];
        await vi.advanceTimersByTimeAsync(250);
        expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({
          type: "snapshot",
          payload: { items: [native], removedItemIds: [preview.id], removedTurnIds: [] },
        });
      } else expect(notify).not.toHaveBeenCalled();

      hub.publish("session", "snapshot", {
        items: [],
        completeItems: false,
        replaceItemIds: [preview.id],
      });
      const event = notify.mock.calls.at(-1)?.[0];
      expect(event?.type).toBe("snapshot");
      expect(event?.payload.items).toEqual([native]);
      expect(event?.payload.removedItemIds).toEqual([preview.id]);
      expect(event?.payload.removedTurnIds).toEqual([]);
    },
  );

  it.each(["preview retirement", "native snapshot"])(
    "clears unpersisted tool previews without tombstoning their native IDs during %s",
    async (removal) => {
      vi.useFakeTimers();
      let status = "running";
      const { hub, notify } = createHub(async () => ({
        live: { status, turnId: "bridge-turn", transcriptTurnId: "turn" },
        items: [],
        completeItems: true,
      }));
      const subscription = await hub.subscribe("session");
      const preview = {
        id: "claude-follower-tool:toolu_unpersisted",
        kind: "tool-summary",
        turn_id: "turn",
        ephemeral: true,
      };
      hub.publish("session", "item-upsert", preview);
      await vi.advanceTimersByTimeAsync(250);
      expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({
        type: "snapshot",
        payload: { items: [preview], authoritativeTurnIds: [] },
      });

      if (removal === "preview retirement")
        hub.publish("session", "snapshot", { items: [], replaceItemIds: [preview.id] });
      else {
        status = "idle";
        await vi.advanceTimersByTimeAsync(250);
      }

      const retired = notify.mock.calls.at(-1)?.[0];
      expect(retired).toMatchObject({
        type: "snapshot",
        payload: {
          items: [],
          removedItemIds: [preview.id],
          removedTurnIds: [],
        },
      });
      const replay = await hub.subscribe("session", subscription.cursor);
      expect(replay.events.find((event) => event.cursor === retired.cursor)?.payload).toEqual(
        retired.payload,
      );
      const reset = await hub.subscribe("session", "outside-the-replay-window");
      expect(reset.events[0]?.payload.removedItemIds).toEqual([preview.id]);
    },
  );

  it("lets old Web retire an evicted preview without overwriting HTTP-only native history", async () => {
    const live = { status: "running", turnId: "bridge-turn", transcriptTurnId: "native-turn" };
    const native = {
      id: "toolu_http",
      kind: "tool-summary",
      turn_id: "native-turn",
      tool_status: "completed",
      attachment_count: 0,
      truncated: false,
    } satisfies ConversationEvent;
    const preview = {
      ...native,
      id: "claude-follower-tool:toolu_http",
      tool_status: "running",
      ephemeral: true,
    };
    const { hub, notify } = createHub(async () => ({ live, items: [], completeItems: false }));
    await hub.subscribe("session");
    hub.publish("session", "item-upsert", preview);
    const upsert = notify.mock.calls.at(-1)?.[0];
    // The released Web merge reads the wire IDs as-is and knows only
    // removedItemIds / removedTurnIds. Native history may be HTTP-only.
    const seen = mergeNativeCoverage([native], {
      items: [upsert?.payload],
      authoritativeTurnIds: [],
      removedTurnIds: [],
    });
    expect(seen).toEqual([native, preview]);

    hub.publish("session", "item-upsert", { id: "large-first", content: "x".repeat(600_000) });
    hub.publish("session", "item-upsert", { id: "large-second", content: "x".repeat(600_000) });
    hub.publish("session", "snapshot", { items: [] });
    expect(notify.mock.calls.at(-1)?.[0].payload.items).not.toContainEqual(preview);
    hub.publish("session", "snapshot", { items: [], replaceItemIds: [preview.id] });
    const retirement = notify.mock.calls.at(-1)?.[0].payload;
    expect(retirement).toMatchObject({
      preserveItemsOutsideCoverage: true,
      removedItemIds: [preview.id],
      removedTurnIds: [],
    });
    expect(
      mergeNativeCoverage(seen, {
        items: [],
        authoritativeTurnIds: retirement.authoritativeTurnIds,
        removedItemIds: retirement.removedItemIds,
        removedTurnIds: retirement.removedTurnIds,
        preserveItemsOutsideCoverage: retirement.preserveItemsOutsideCoverage,
      }),
    ).toEqual([native]);
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
