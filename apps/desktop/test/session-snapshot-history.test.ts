import { describe, expect, it, vi } from "vitest";
import { SessionSnapshotHistory } from "../../../packages/backend/src/session-snapshot-history";

const history = (text: string) => ({
  items: [{ id: "message", content: text }],
  completeItems: true,
});

describe("unchanged stream history", () => {
  it("drops indexed history when ownership changes to an uncached source", async () => {
    const cache = new SessionSnapshotHistory();
    const load = vi.fn(async () => history("indexed"));
    await cache.read("session", async () => "indexed-version", load);
    load.mockImplementation(async () => history("managed"));
    expect(await cache.read("session", async () => null, load)).toEqual(history("managed"));
    await cache.read("session", async () => null, load);
    load.mockImplementation(async () => history("indexed again"));
    expect(await cache.read("session", async () => "indexed-version", load)).toEqual(
      history("indexed again"),
    );
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("checks the current source each poll while avoiding repeated history parsing", async () => {
    const cache = new SessionSnapshotHistory();
    const version = vi.fn(async () => "verified-source-1");
    const load = vi.fn(async () => history("first"));
    for (let poll = 0; poll < 20; poll++)
      expect(await cache.read("session", version, load)).toEqual(history("first"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(version).toHaveBeenCalledTimes(21);
  });

  it("reloads an appended or replaced source immediately", async () => {
    const cache = new SessionSnapshotHistory();
    let source = "first";
    const version = async () => source;
    const load = vi.fn(async () => history(source));
    await cache.read("session", version, load);
    source = "appended";
    expect(await cache.read("session", version, load)).toEqual(history("appended"));
    source = "replaced";
    expect(await cache.read("session", version, load)).toEqual(history("replaced"));
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("fails closed when current identity verification fails instead of returning cached history", async () => {
    const cache = new SessionSnapshotHistory();
    const load = vi.fn(async () => history("old"));
    await cache.read("session", async () => "same", load);
    await expect(
      cache.read(
        "session",
        async () => {
          throw new Error("session-unavailable");
        },
        load,
      ),
    ).rejects.toThrow("session-unavailable");
    await cache.read("session", async () => "same", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a source that changes while reading", async () => {
    const cache = new SessionSnapshotHistory();
    let source = "before";
    const load = vi.fn(async () => {
      source = "after";
      return history("snapshot before append");
    });
    await cache.read("session", async () => source, load);
    await cache.read("session", async () => source, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not let invalidated in-flight history repopulate the cache", async () => {
    const cache = new SessionSnapshotHistory();
    const load = vi.fn(async () => {
      cache.invalidate("session");
      return history("old");
    });
    await cache.read("session", async () => "same", load);
    await cache.read("session", async () => "same", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps sessions and returned mutations isolated", async () => {
    const cache = new SessionSnapshotHistory();
    const version = async () => "same";
    const first = await cache.read("one", version, async () => history("one"));
    first.items[0]!.content = "mutated";
    const second = await cache.read("two", version, async () => history("two"));
    second.items.length = 0;
    const hit = await cache.read("one", version, async () => history("unexpected"));
    hit.items.length = 0;
    expect(await cache.read("one", version, async () => history("unexpected"))).toEqual(
      history("one"),
    );
    expect(await cache.read("two", version, async () => history("unexpected"))).toEqual(
      history("two"),
    );
  });

  it("retries failed reads and clears all entries on runtime invalidation", async () => {
    const cache = new SessionSnapshotHistory();
    const version = async () => "same";
    const failed = vi.fn(async () => {
      throw new Error("TRANSCRIPT_UNREADABLE");
    });
    await expect(cache.read("one", version, failed)).rejects.toThrow("TRANSCRIPT_UNREADABLE");
    const load = vi.fn(async () => history("recovered"));
    await cache.read("one", version, load);
    await cache.read("two", version, load);
    cache.invalidate();
    await cache.read("one", version, load);
    await cache.read("two", version, load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("bounds cached sessions and skips oversized history", async () => {
    const cache = new SessionSnapshotHistory();
    const version = async () => "same";
    const load = vi.fn(async () => history("small"));
    for (let n = 0; n < 33; n++) await cache.read(String(n), version, load);
    await cache.read("0", version, load);
    expect(load).toHaveBeenCalledTimes(34);
    const oversized = vi.fn(async () => history("x".repeat(8 * 1024 * 1024)));
    await cache.read("large", version, oversized);
    await cache.read("large", version, oversized);
    expect(oversized).toHaveBeenCalledTimes(2);
  });
});
