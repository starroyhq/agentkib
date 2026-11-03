// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentCatalog, SubagentStatus } from "@agentkib/runtime-protocol";
import { SessionSubagentSnapshots } from "../../../packages/backend/src/session-subagent-snapshots";
import { SessionStreamHub } from "../../../packages/backend/src/session-stream";
import type { SessionStreamEvent } from "@agentkib/runtime-protocol";

const childId = "a".repeat(64);
const hubs: SessionStreamHub[] = [];
const live = (sourceSessionId = "native-parent", runtimeBootId = "boot") => ({
  sourceSessionId,
  runtimeBootId,
  workspaceId: "workspace",
  revision: 17,
});
const catalog = (status: SubagentStatus = "running", sessionId = "parent"): SubagentCatalog => ({
  version: 1,
  sessionId,
  agents: [
    { id: childId, name: "Synthetic reviewer", agent: "claude-code", status, readable: true },
  ],
  truncated: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flush = () => Promise.resolve();
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("parent stream subagent snapshot cache", () => {
  it("reuses a read for two seconds and refreshes quietly at the TTL boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const cache = new SessionSubagentSnapshots();
    const load = vi.fn().mockResolvedValueOnce(catalog()).mockResolvedValue(catalog("completed"));
    expect(await cache.read("parent", live(), load)).toEqual(catalog());
    vi.setSystemTime(11_999);
    expect(await cache.read("parent", live(), load)).toEqual(catalog());
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(12_000);
    expect(await cache.read("parent", live(), load)).toEqual(catalog("completed"));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("immediately replaces cached running children when a native publication completes them", async () => {
    const cache = new SessionSubagentSnapshots();
    const load = vi.fn().mockResolvedValue(catalog());
    await cache.read("parent", live(), load);
    // Child observation does not need to advance the parent's control revision.
    cache.publish("parent", { ...live(), subagents: catalog("completed") });
    expect(await cache.read("parent", live(), load)).toEqual(catalog("completed"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not stream a stale running snapshot after a same-revision child completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new SessionSubagentSnapshots(),
      notifications: SessionStreamEvent[] = [];
    const parent = { ...live(), sessionId: "parent", status: "running" };
    const load = vi.fn().mockResolvedValue(catalog());
    const hub = new SessionStreamHub(
      "boot",
      async (id) => ({
        live: { ...parent, subagents: await cache.read(id, parent, load) },
        items: [],
        completeItems: true,
      }),
      (event) => notifications.push(event),
      () => undefined,
    );
    hubs.push(hub);
    const subscription = await hub.subscribe("parent");
    expect(subscription.events[0].payload.live).toMatchObject({ subagents: catalog() });
    const published = { ...parent, subagents: catalog("completed") };
    cache.publish("parent", published);
    hub.publish("parent", "state", published, published);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].payload).toMatchObject({
      revision: parent.revision,
      subagents: catalog("completed"),
    });
  });

  it("keeps a delayed parent stream poll behind the child publication and the following poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new SessionSubagentSnapshots(),
      notifications: SessionStreamEvent[] = [];
    const parent = { ...live(), sessionId: "parent", status: "running" };
    const delayed = deferred<SubagentCatalog>();
    const load = vi
      .fn()
      .mockResolvedValueOnce(catalog())
      .mockImplementation(() => delayed.promise);
    const hub = new SessionStreamHub(
      "boot",
      async (id) => ({
        live: { ...parent, subagents: await cache.read(id, parent, load) },
        items: [],
        completeItems: true,
      }),
      (event) => notifications.push(event),
      () => undefined,
    );
    hubs.push(hub);
    await hub.subscribe("parent");
    vi.setSystemTime(2_000);
    await vi.advanceTimersByTimeAsync(250);
    expect(load).toHaveBeenCalledTimes(2);
    const published = { ...parent, subagents: catalog("completed") };
    cache.publish("parent", published);
    hub.publish("parent", "state", published, published);
    delayed.resolve(catalog());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].payload).toMatchObject({ subagents: catalog("completed") });
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a newer publication when the older in-flight read later %ss",
    async (outcome) => {
      const cache = new SessionSubagentSnapshots();
      const delayed = deferred<SubagentCatalog>();
      const load = vi.fn(() => delayed.promise);
      const pending = cache.read("parent", live(), load);
      await flush();
      expect(load).toHaveBeenCalledTimes(1);
      cache.publish("parent", { ...live(), subagents: catalog("completed") });
      if (outcome === "resolve") delayed.resolve(catalog());
      else delayed.reject(new Error("synthetic old read failed"));
      expect(await pending).toEqual(catalog("completed"));
      expect(await cache.read("parent", live(), load)).toEqual(catalog("completed"));
      expect(load).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the latest of multiple child publications ahead of the same delayed parent poll", async () => {
    const cache = new SessionSubagentSnapshots();
    const delayed = deferred<SubagentCatalog>();
    const pending = cache.read("parent", live(), () => delayed.promise);
    await flush();
    cache.publish("parent", { ...live(), subagents: catalog("waiting-input") });
    cache.publish("parent", { ...live(), subagents: catalog("completed") });
    delayed.resolve(catalog());
    expect(await pending).toEqual(catalog("completed"));
  });

  it("retains stored native children across empty and newly observed partial publications", async () => {
    const cache = new SessionSubagentSnapshots();
    const stored = {
      ...catalog("completed").agents[0],
      id: "c".repeat(64),
      name: "Stored native child",
    };
    const full = { ...catalog(), agents: [stored] };
    const load = vi.fn().mockResolvedValue(full);
    await cache.read("parent", live(), load);
    cache.publish("parent", { ...live(), subagents: { ...catalog(), agents: [], partial: true } });
    expect((await cache.read("parent", live(), load)).agents).toEqual([stored]);
    cache.publish("parent", { ...live(), subagents: { ...catalog(), partial: true } });
    const merged = await cache.read("parent", live(), load);
    expect(merged.agents).toHaveLength(2);
    expect(merged.agents).toEqual(expect.arrayContaining([stored, catalog().agents[0]]));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("merges a newer partial completion into a delayed full read while retaining its native history", async () => {
    const cache = new SessionSubagentSnapshots();
    const stored = {
      ...catalog("completed").agents[0],
      id: "c".repeat(64),
      name: "Stored native child",
    };
    const delayed = deferred<SubagentCatalog>();
    const pending = cache.read("parent", live(), () => delayed.promise);
    await flush();
    cache.publish("parent", { ...live(), subagents: { ...catalog("completed"), partial: true } });
    delayed.resolve({ ...catalog(), agents: [stored, catalog().agents[0]] });
    const merged = await pending;
    expect(merged.agents).toHaveLength(2);
    expect(merged.agents).toEqual(expect.arrayContaining([stored, catalog("completed").agents[0]]));
    const unused = vi.fn();
    expect((await cache.read("parent", live(), unused)).agents).toEqual(merged.agents);
    expect(unused).not.toHaveBeenCalled();
  });

  it("does not let frequent partial publications postpone a full directory refresh indefinitely", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new SessionSubagentSnapshots();
    const stored = {
      ...catalog("completed").agents[0],
      id: "c".repeat(64),
      name: "Stored native child",
    };
    const later = { ...stored, id: "d".repeat(64), name: "Later native child" };
    const load = vi
      .fn()
      .mockResolvedValueOnce({ ...catalog(), agents: [stored] })
      .mockResolvedValue({ ...catalog(), agents: [stored, later, catalog().agents[0]] });
    await cache.read("parent", live(), load);
    vi.setSystemTime(1_000);
    cache.publish("parent", { ...live(), subagents: { ...catalog(), partial: true } });
    vi.setSystemTime(1_999);
    cache.publish("parent", {
      ...live(),
      subagents: { ...catalog("waiting-input"), partial: true },
    });
    expect(load).toHaveBeenCalledTimes(1);
    vi.setSystemTime(2_000);
    const refreshed = await cache.read("parent", live(), load);
    expect(load).toHaveBeenCalledTimes(2);
    expect(refreshed.agents).toEqual(expect.arrayContaining([stored, later]));
  });

  it("does not revive deleted native history by carrying an old full publication into a later partial overlay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new SessionSubagentSnapshots();
    const stored = {
      ...catalog("completed").agents[0],
      id: "c".repeat(64),
      name: "Removed native child",
    };
    cache.publish("parent", { ...live(), subagents: { ...catalog(), agents: [stored] } });
    vi.setSystemTime(2_000);
    const delayed = deferred<SubagentCatalog>();
    const pending = cache.read("parent", live(), () => delayed.promise);
    await flush();
    cache.publish("parent", { ...live(), subagents: { ...catalog(), agents: [], partial: true } });
    delayed.resolve({ ...catalog(), agents: [] });
    expect((await pending).agents).toEqual([]);
    const unused = vi.fn();
    expect((await cache.read("parent", live(), unused)).agents).toEqual([]);
    expect(unused).not.toHaveBeenCalled();
  });

  it.each([
    { previous: live(), next: live("replacement-native") },
    { previous: live(), next: live("native-parent", "replacement-boot") },
    { previous: live(), next: { ...live(), workspaceId: "replacement-workspace" } },
  ])(
    "never places a publication from a replacement parent scope into the old poll ($next)",
    async ({ previous, next }) => {
      const cache = new SessionSubagentSnapshots();
      const delayed = deferred<SubagentCatalog>();
      const pending = cache.read("parent", previous, () => delayed.promise);
      await flush();
      cache.publish("parent", { ...next, subagents: catalog("completed") });
      delayed.resolve(catalog());
      expect(await pending).toEqual({
        version: 1,
        sessionId: "parent",
        agents: [],
        truncated: false,
        available: false,
      });
      const notNeeded = vi.fn().mockRejectedValue(new Error("new scope is already published"));
      expect(await cache.read("parent", next, notNeeded)).toEqual(catalog("completed"));
      expect(notNeeded).not.toHaveBeenCalled();
    },
  );

  it("does not repopulate an invalidated cache with its older outstanding read", async () => {
    const cache = new SessionSubagentSnapshots();
    const delayed = deferred<SubagentCatalog>();
    const pending = cache.read("parent", live(), () => delayed.promise);
    await flush();
    cache.invalidate("parent");
    delayed.resolve(catalog());
    expect(await pending).toMatchObject({ available: false, agents: [] });
    const retry = vi.fn().mockResolvedValue(catalog("stopped"));
    expect(await cache.read("parent", live(), retry)).toEqual(catalog("stopped"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("does not let an invalidated flight remove a newer flight's result", async () => {
    const cache = new SessionSubagentSnapshots();
    const before = deferred<SubagentCatalog>(),
      after = deferred<SubagentCatalog>();
    const oldPoll = cache.read("parent", live(), () => before.promise);
    await flush();
    cache.invalidate("parent");
    const newPoll = cache.read("parent", live(), () => after.promise);
    await flush();
    before.resolve(catalog());
    expect(await oldPoll).toMatchObject({ available: false });
    after.resolve(catalog("completed"));
    expect(await newPoll).toEqual(catalog("completed"));
    const unexpected = vi.fn().mockResolvedValue(catalog());
    expect(await cache.read("parent", live(), unexpected)).toEqual(catalog("completed"));
    expect(unexpected).not.toHaveBeenCalled();
  });

  it("isolates simultaneous reads and publications for different parent sessions", async () => {
    const cache = new SessionSubagentSnapshots();
    const delayed = deferred<SubagentCatalog>();
    const first = cache.read("parent-a", live(), () => delayed.promise);
    await flush();
    cache.publish("parent-b", { ...live(), subagents: catalog("completed", "parent-b") });
    delayed.resolve(catalog("running", "parent-a"));
    expect(await first).toEqual(catalog("running", "parent-a"));
    const unused = vi.fn();
    expect(await cache.read("parent-b", live(), unused)).toEqual(catalog("completed", "parent-b"));
    expect(unused).not.toHaveBeenCalled();
  });

  it("coalesces only the current generation's parallel reads and returns independent objects", async () => {
    const cache = new SessionSubagentSnapshots();
    const delayed = deferred<SubagentCatalog>();
    const load = vi.fn(() => delayed.promise);
    const first = cache.read("parent", live(), load),
      second = cache.read("parent", live(), load);
    await flush();
    expect(load).toHaveBeenCalledTimes(1);
    delayed.resolve(catalog());
    const [a, b] = await Promise.all([first, second]);
    a.agents[0].name = "Caller mutation";
    expect(b.agents[0].name).toBe("Synthetic reviewer");
    expect((await cache.read("parent", live(), load)).agents[0].name).toBe("Synthetic reviewer");
  });

  it("whitelists public fields before caching and does not retain mutable publisher input", async () => {
    const cache = new SessionSubagentSnapshots();
    const input = {
      ...catalog(),
      nativePath: "/synthetic/private",
      agents: [{ ...catalog().agents[0], nativeAgentId: "native-secret", taskId: "task-secret" }],
    };
    cache.publish("parent", { ...live(), subagents: input });
    input.agents[0].name = "Mutated native source";
    const result = await cache.read("parent", live(), vi.fn());
    expect(result).toEqual(catalog());
    expect(JSON.stringify(result)).not.toContain("native-secret");
    expect(JSON.stringify(result)).not.toContain("task-secret");
    expect(JSON.stringify(result)).not.toContain("/synthetic/private");
  });

  it("refuses an unprojected runner array instead of republishing private observations", async () => {
    const cache = new SessionSubagentSnapshots();
    cache.publish("parent", {
      ...live(),
      subagents: [{ id: "spawn-tool", nativeAgentId: "native-secret", status: "running" }],
    });
    const value = await cache.read("parent", live(), async () => [
      { id: "spawn-tool", nativeAgentId: "native-secret" },
    ]);
    expect(value).toEqual({
      version: 1,
      sessionId: "parent",
      agents: [],
      truncated: false,
      available: false,
    });
    expect(JSON.stringify(value)).not.toContain("native-secret");
  });

  it("recovers from a synchronous load error without retaining a permanently failed flight", async () => {
    const cache = new SessionSubagentSnapshots();
    const failure = vi.fn((): Promise<SubagentCatalog> => {
      throw new Error("synthetic immediate error");
    });
    expect(await cache.read("parent", live(), failure)).toMatchObject({
      available: false,
      agents: [],
    });
    const retry = vi.fn().mockResolvedValue(catalog("completed"));
    expect(await cache.read("parent", live(), retry)).toEqual(catalog("completed"));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("drops stale cached activity when a refreshed read fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cache = new SessionSubagentSnapshots();
    await cache.read("parent", live(), async () => catalog());
    vi.setSystemTime(2_000);
    expect(
      await cache.read("parent", live(), async () => {
        throw new Error("synthetic transport failure");
      }),
    ).toMatchObject({ available: false, agents: [] });
    expect(await cache.read("parent", live(), async () => catalog("completed"))).toEqual(
      catalog("completed"),
    );
  });
});
