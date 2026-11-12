import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexReadStateObserver,
  type CodexReadTarget,
} from "../../../packages/backend/src/codex-read-state";
import {
  CodexAppServerError,
  type CodexAppServerSession,
} from "../../../packages/backend/src/codex-app-server";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
function fixture(options: { metadata?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-native-state-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, "codex");
  writeFileSync(executable, "offline", { mode: 0o700 });
  const target: CodexReadTarget = {
    key: "canonical",
    home: root,
    workspace: root,
    executable,
    nativeId: "thread-one",
  };
  const rollout = path.join(root, "rollout.jsonl");
  writeFileSync(rollout, "synthetic fixture\n");
  let listMode: "supported" | "no-receipts" | "unsupported" | "second-page" = "supported";
  let revision = "one",
    firstUnread: unknown = { type: "turn", turnId: "turn-one" },
    failure = false,
    unsupported: "none" | "null" | "method" = "none",
    loseWrite = false;
  let race = false,
    empty = false,
    active = false,
    turnsUnsupported = false,
    page = 0;
  const thread = (id: unknown, updatedAt: number) => ({
    id,
    cwd: root,
    ...(options.metadata
      ? { path: rollout, status: { type: active ? "active" : "notLoaded" }, updatedAt }
      : {}),
  });
  const emitter = new EventEmitter();
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const session = Object.assign(emitter, {
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (failure) throw new Error("temporary transport failure");
      if (unsupported === "method") throw new CodexAppServerError({ code: -32601 });
      if (method === "thread/read")
        return {
          thread: thread(params.threadId, 10),
          readState: unsupported === "null" ? null : { revision, firstUnread },
        };
      if (method === "thread/turns/list") {
        if (turnsUnsupported) throw new CodexAppServerError({ code: -32601 });
        if (race) {
          revision = "raced";
          firstUnread = { type: "turn", turnId: "new-turn" };
        }
        return {
          data: empty
            ? []
            : [
                ...(active ? [{ id: "running", status: "inProgress" }] : []),
                { id: race ? "new-turn" : "turn-one", status: "completed", completedAt: 1 },
              ],
          nextCursor: null,
        };
      }
      if (method === "thread/list") {
        if (listMode === "unsupported") throw new CodexAppServerError({ code: -32602 });
        const included = listMode !== "second-page" || params.cursor === "page-two";
        return {
          data: included ? [thread(target.nativeId, 20)] : [],
          ...(listMode === "no-receipts"
            ? {}
            : {
                readStates: included ? { [target.nativeId]: { revision, firstUnread } } : {},
              }),
          nextCursor: page++ % 2 === 0 ? "page-two" : null,
        };
      }
      if (method === "thread/readState/update") {
        if (params.expectedRevision !== revision) throw new CodexAppServerError({ code: -32600 });
        firstUnread = null;
        revision = "read";
        if (loseWrite) throw new Error("lost ACK");
        return { readState: { revision, firstUnread } };
      }
      throw new Error("unexpected native method");
    }),
    close: vi.fn(async () => undefined),
  });
  let notify: ((event: Record<string, unknown>) => void) | undefined;
  const start = vi.fn(
    async (
      _executable: string,
      _workspace: string,
      _home: string,
      _environment: NodeJS.ProcessEnv,
      callback?: (event: Record<string, unknown>) => void,
    ) => {
      notify = callback;
      return session as unknown as CodexAppServerSession;
    },
  );
  const changed = vi.fn(),
    owner = new CodexReadStateObserver({}, changed, start);
  cleanups.push(() => owner.close());
  return {
    owner,
    target,
    session,
    listMode: (value: typeof listMode) => {
      listMode = value;
    },
    append: () => {
      appendFileSync(rollout, "new result\n");
    },
    nativeRead: () => {
      revision = "read-elsewhere";
      firstUnread = null;
    },
    silentUnread: () => {
      revision = "unread-elsewhere";
      firstUnread = { type: "threadStart" };
    },
    start,
    calls,
    changed,
    fail: () => {
      failure = true;
    },
    unsupportedTurns: () => {
      turnsUnsupported = true;
    },
    recover: () => {
      failure = false;
      unsupported = "none";
    },
    unsupported: (value: typeof unsupported) => {
      unsupported = value;
    },
    lose: () => {
      loseWrite = true;
    },
    race: () => {
      race = true;
      firstUnread = null;
    },
    empty: () => {
      empty = true;
    },
    active: () => {
      active = true;
    },
    manualUnread: () => {
      revision = "manual";
      firstUnread = { type: "threadStart" };
      notify?.({
        method: "thread/readState/changed",
        params: { threadId: target.nativeId, readState: { revision, firstUnread } },
      });
    },
  };
}

describe("authoritative native Codex receipt observation", () => {
  it("rechecks authoritative receipts without decoding unchanged rollouts or notifying again", async () => {
    vi.useFakeTimers();
    const f = fixture({ metadata: true });
    const first = await f.owner.refresh(f.target, "a");
    f.changed.mockClear();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await f.owner.refresh(f.target, "a")).toEqual(first);
    }
    expect(f.calls.filter((call) => call.method === "thread/read")).toHaveLength(2);
    expect(f.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === "thread/list")).toHaveLength(4);
    expect(
      f.calls
        .filter((call) => call.method === "thread/list")
        .every((call) => call.params.useStateDbOnly === true),
    ).toBe(true);
    expect(f.changed).not.toHaveBeenCalled();
    f.nativeRead();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await f.owner.refresh(f.target, "a")).toMatchObject({
      status: "read",
      freshness: "current",
    });
    f.silentUnread();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await f.owner.refresh(f.target, "a")).toMatchObject({
      firstUnread: { type: "threadStart" },
      freshness: "current",
    });
    expect(f.calls.filter((call) => call.method === "thread/read")).toHaveLength(2);
  });

  it("invalidates the result cache on rollout or activity changes and keeps acknowledgement coherent", async () => {
    vi.useFakeTimers();
    const f = fixture({ metadata: true });
    const initial = await f.owner.refresh(f.target, "a");
    f.append();
    await vi.advanceTimersByTimeAsync(5_000);
    await f.owner.refresh(f.target, "a");
    expect(f.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(2);
    f.active();
    await vi.advanceTimersByTimeAsync(5_000);
    const active = await f.owner.refresh(f.target, "a");
    expect(active?.version).not.toBe(initial?.version);
    expect(f.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(3);
    await expect(f.owner.update(f.target, "a", initial!.version!, "turn:turn-one")).rejects.toThrow(
      "read-state-conflict",
    );
    expect(f.calls.some((call) => call.method === "thread/readState/update")).toBe(false);
  });

  it.each(["no-receipts", "unsupported"] as const)(
    "falls back to native reads for old directory support: %s",
    async (mode) => {
      vi.useFakeTimers();
      const f = fixture({ metadata: true });
      await f.owner.refresh(f.target, "a");
      f.listMode(mode);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await f.owner.refresh(f.target, "a")).toMatchObject({
        source: "codex-native",
        status: "unread",
        freshness: "current",
      });
      expect(f.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(2);
      f.fail();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await f.owner.refresh(f.target, "a")).toMatchObject({
        source: "codex-native",
        status: "unread",
        freshness: "stale",
      });
    },
  );

  it("advances bounded workspace pages even when an older target is absent from the first page", async () => {
    vi.useFakeTimers();
    const f = fixture({ metadata: true });
    await f.owner.refresh(f.target, "a");
    f.listMode("second-page");
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await f.owner.refresh(f.target, "a")).toMatchObject({ freshness: "current" });
    }
    expect(
      f.calls.filter((call) => call.method === "thread/list").map((call) => call.params.cursor),
    ).toEqual([null, "page-two", null]);
    expect(f.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(3);
  });

  it("does not trust a directory response invalidated by a simultaneous native notification", async () => {
    vi.useFakeTimers();
    const f = fixture({ metadata: true });
    await f.owner.refresh(f.target, "a");
    f.session.request.mockImplementationOnce(async () => {
      f.manualUnread();
      return {
        data: [{ id: f.target.nativeId, cwd: f.target.workspace }],
        readStates: { [f.target.nativeId]: { revision: "old-read", firstUnread: null } },
      };
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await f.owner.refresh(f.target, "a")).toMatchObject({
      status: "unread",
      firstUnread: { type: "threadStart" },
      freshness: "current",
    });
  });

  it("keeps native authority when a turn-list method is unavailable but receipts still work", async () => {
    const f = fixture();
    await f.owner.refresh(f.target, "a");
    f.unsupportedTurns();
    expect(await f.owner.refresh(f.target, "a")).toMatchObject({
      source: "codex-native",
      status: "unread",
      freshness: "stale",
    });
    expect(f.owner.cached(f.target, "a")?.source).toBe("codex-native");
  });
  it("reuses a per-home read-only connection, preserves manual unread and rejects stale revisions", async () => {
    const f = fixture(),
      first = await f.owner.refresh(f.target, "account");
    expect(first).toMatchObject({
      source: "codex-native",
      status: "unread",
      latestResult: { id: "turn:turn-one", itemId: null },
    });
    await f.owner.refresh({ ...f.target, key: "alias", nativeId: "another-thread" }, "account");
    expect(f.start).toHaveBeenCalledTimes(1);
    f.manualUnread();
    expect(f.owner.cached(f.target, "account")?.freshness).toBe("stale");
    await expect(
      f.owner.update(f.target, "account", first!.version!, "turn:turn-one"),
    ).rejects.toThrow("read-state-conflict");
    expect(f.calls.filter((call) => call.method === "thread/readState/update")).toHaveLength(0);
    expect((await f.owner.refresh(f.target, "account"))?.firstUnread).toEqual({
      type: "threadStart",
    });
    expect(f.calls.some((call) => /resume|turn\/start|thread\/start/.test(call.method))).toBe(
      false,
    );
  });

  it("keeps verified unread stale through transient errors, rather than enabling fallback", async () => {
    const f = fixture();
    await f.owner.refresh(f.target, "a");
    f.fail();
    expect(await f.owner.refresh(f.target, "a")).toMatchObject({
      source: "codex-native",
      status: "unread",
      freshness: "stale",
    });
  });

  it("treats null as per-thread unsupported and retries capability after its bounded expiry", async () => {
    const f = fixture();
    vi.useFakeTimers();
    f.unsupported("null");
    expect(await f.owner.refresh(f.target, "a")).toBeNull();
    f.recover();
    expect(
      await f.owner.refresh({ ...f.target, key: "other", nativeId: "other" }, "a"),
    ).toMatchObject({ source: "codex-native" });
    expect(await f.owner.refresh(f.target, "a")).toBeNull();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await f.owner.refresh(f.target, "a")).toMatchObject({
      source: "codex-native",
      freshness: "current",
    });
  });

  it("never repeats an unknown native write; an explicit GET observes its committed receipt", async () => {
    const f = fixture(),
      before = await f.owner.refresh(f.target, "a");
    f.lose();
    await expect(f.owner.update(f.target, "a", before!.version!, "turn:turn-one")).rejects.toThrow(
      "read-state-unavailable",
    );
    expect((await f.owner.refresh(f.target, "a"))?.status).toBe("read");
    expect(f.calls.filter((call) => call.method === "thread/readState/update")).toHaveLength(1);
  });

  it("does not pair an earlier read receipt with a result that completed between the two native reads", async () => {
    const f = fixture();
    f.race();
    expect(await f.owner.refresh(f.target, "a")).toMatchObject({
      status: "unknown",
      freshness: "stale",
      version: null,
    });
    expect(f.calls.filter((call) => call.method === "thread/readState/update")).toHaveLength(0);
  });

  it("allows manual unread on an empty thread but refuses to acknowledge an active newer turn", async () => {
    const empty = fixture();
    empty.empty();
    empty.manualUnread();
    const state = await empty.owner.refresh(empty.target, "a");
    expect(state).toMatchObject({ latestResult: null, firstUnread: { type: "threadStart" } });
    expect(await empty.owner.update(empty.target, "a", state!.version!, null)).toMatchObject({
      status: "read",
    });
    const active = fixture(),
      old = await active.owner.refresh(active.target, "a");
    active.active();
    await expect(
      active.owner.update(active.target, "a", old!.version!, "turn:turn-one"),
    ).rejects.toThrow("read-state-conflict");
    expect(active.calls.some((call) => call.method === "thread/readState/update")).toBe(false);
    const freshActive = await active.owner.refresh(active.target, "a");
    expect(
      await active.owner.update(active.target, "a", freshActive!.version!, "turn:turn-one"),
    ).toMatchObject({ status: "read" });
  });

  it("pages the native directory on the same read-only connection and fences source re-entry", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const old = await f.owner.refresh(f.target, "a");
    f.manualUnread();
    await f.owner.pollPage(f.target);
    await f.owner.pollPage(f.target);
    expect(
      f.calls.filter((call) => call.method === "thread/list").map((call) => call.params.cursor),
    ).toEqual([null, "page-two"]);
    f.unsupported("null");
    await f.owner.refresh(f.target, "a");
    f.recover();
    await vi.advanceTimersByTimeAsync(31_000);
    const fresh = await f.owner.refresh(f.target, "a");
    expect(fresh?.version).not.toBe(old?.version);
    expect(f.start).toHaveBeenCalledTimes(1);
  });
});
