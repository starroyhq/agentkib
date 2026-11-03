// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type { ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import { homeKeys } from "@/features/home/home-query";
import { queuedSessionRead } from "@/features/sessions/session-query";
import { useSearchSessions } from "./useSearchSessions";

vi.mock("@/core/api", () => ({
  api: {
    workspaceSessions: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
    workspaceSessionEvents: vi.fn(),
  },
}));

function session(id: string, title = id): ConversationSessionSummary {
  return {
    id: `session-${id}`,
    workspace_id: id,
    title,
    agent: "codex",
    archived: false,
    sidechain: false,
    availability: "readable",
  };
}
function workspace(id: string): WorkspaceSummary {
  return { id, name: "Same workspace" } as WorkspaceSummary;
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useSearchSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => [session(id)]);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not expose or read indexed data while closed or indexing is disabled", () => {
    const { client, wrapper } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one")]);
    const { result } = renderHook(() => useSearchSessions([workspace("one")], false), { wrapper });
    expect(result.current.sessions).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(api.workspaceSessions).not.toHaveBeenCalled();
  });

  it("aggregates all distinct workspace IDs, including archived and metadata records, without scanning", async () => {
    const { wrapper } = setup();
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => [
      {
        ...session(id),
        archived: id === "archived",
        availability: id === "metadata" ? "metadata-only" : "readable",
      },
    ]);
    const list = [workspace("one"), workspace("archived"), workspace("metadata"), workspace("one")];
    const { result } = renderHook(() => useSearchSessions(list, true), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toHaveLength(3);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(3);
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("reuses fresh cache on reopening and keeps results independent of workspace ordering", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one")]);
    const { result, rerender } = renderHook(
      ({ enabled, list }) => useSearchSessions(list, enabled),
      { wrapper, initialProps: { enabled: true, list: [workspace("one"), workspace("two")] } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    rerender({ enabled: false, list: [workspace("two"), workspace("one")] });
    expect(result.current.sessions).toEqual([]);
    rerender({ enabled: true, list: [workspace("two"), workspace("one")] });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toHaveLength(2);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
  });

  it("preserves stale cache on a partial error and retries only failed workspaces", async () => {
    const { client, wrapper } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one", "cached")], {
      updatedAt: 1,
    });
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => {
      if (id === "one") throw new Error("cache read failed");
      return [session(id)];
    });
    const { result } = renderHook(
      () => useSearchSessions([workspace("one"), workspace("two")], true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions.find(({ workspace_id }) => workspace_id === "one")?.title).toBe(
      "cached",
    );
    expect(result.current.errors.one).toContain("cache read failed");
    vi.mocked(api.workspaceSessions).mockResolvedValue([session("one", "recovered")]);
    await act(async () => result.current.retry());
    expect(result.current.errors).toEqual({});
    expect(api.workspaceSessions).toHaveBeenCalledTimes(3);
    expect(api.workspaceSessions).toHaveBeenLastCalledWith("one");
  });

  it("ignores obsolete results immediately on workspace changes or disabling indexing", async () => {
    const { client, wrapper } = setup();
    const old = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockImplementation((id) =>
      id === "one" ? old.promise : Promise.resolve([session(id)]),
    );
    const { result, rerender } = renderHook(
      ({ enabled, id }) => useSearchSessions([workspace(id)], enabled),
      { wrapper, initialProps: { enabled: true, id: "one" } },
    );
    rerender({ enabled: true, id: "two" });
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ enabled: false, id: "two" });
    expect(result.current.sessions).toEqual([]);
    await act(async () => old.resolve([session("one")]));
    expect(client.getQueryData(homeKeys.continuations("one"))).toBeUndefined();
    expect(result.current.sessions).toEqual([]);
  });

  it("limits reads to four across reopen and skips queued reads after closing", async () => {
    const { wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    let active = 0;
    let maximum = 0;
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await pending.promise;
      active -= 1;
      return [session(id)];
    });
    const list = Array.from({ length: 12 }, (_, index) => workspace(String(index)));
    const { result, rerender } = renderHook(({ enabled }) => useSearchSessions(list, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    await act(async () => pending.resolve([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(maximum).toBe(4);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(12);
    expect(result.current.sessions).toHaveLength(12);
    expect(result.current.errors).toEqual({});
  });

  it("reuses an in-flight read after reopening and retries busy with the current consumer", async () => {
    const { wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    let calls = 0;
    vi.mocked(api.workspaceSessions).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) await pending.promise;
      if (calls < 3) throw new Error("operation_busy");
      return [session("one")];
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useSearchSessions([workspace("one")], enabled),
      { wrapper, initialProps: { enabled: true } },
    );
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(3);
    expect(result.current.sessions).toEqual([session("one")]);
    expect(result.current.errors).toEqual({});
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("reuses an in-flight read across reopening without binding stale retries to the closed consumer", async () => {
    const { wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    let calls = 0;
    vi.mocked(api.workspaceSessions).mockImplementation(async () => {
      if (++calls === 1) {
        await pending.promise;
        throw new Error("catalog-stale");
      }
      return [session("one", "current")];
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useSearchSessions([workspace("one")], enabled),
      { wrapper, initialProps: { enabled: true } },
    );
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve([]));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(2);
    expect(result.current.sessions).toEqual([session("one", "current")]);
    expect(result.current.errors).toEqual({});
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("does not repeat a stale read after its last search consumer closes", async () => {
    vi.useFakeTimers();
    const { client, wrapper } = setup();
    vi.mocked(api.workspaceSessions).mockRejectedValue(new Error("catalog-stale"));
    const { result, rerender } = renderHook(
      ({ enabled }) => useSearchSessions([workspace("one")], enabled),
      { wrapper, initialProps: { enabled: true } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    rerender({ enabled: false });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(homeKeys.continuations("one"))).toBeUndefined();
    expect(result.current.sessions).toEqual([]);
  });

  it("bounds shared stale retries without starting an index scan", async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const read = vi.fn().mockRejectedValue(new Error("catalog-stale"));
    const outcome = queuedSessionRead(client, "stale", new AbortController().signal, read, {
      retryBusy: true,
      retryStale: true,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledTimes(3);
    expect(await outcome).toMatchObject({ message: "catalog-stale" });
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("keeps shared busy retries alive until the last consumer cancels", async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const first = new AbortController();
    const second = new AbortController();
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error("operation_busy"))
      .mockRejectedValueOnce(new Error("operation_busy"))
      .mockResolvedValue("ready");
    const outcomes = Promise.allSettled([
      queuedSessionRead(client, "shared", first.signal, read, { retryBusy: true }),
      queuedSessionRead(client, "shared", second.signal, read, { retryBusy: true }),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    first.abort();
    await vi.advanceTimersByTimeAsync(450);
    expect(read).toHaveBeenCalledTimes(3);
    expect(await outcomes).toEqual([
      { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) },
      { status: "fulfilled", value: "ready" },
    ]);
  });

  it("cancels unused busy waiting without letting old cleanup remove a reopened request", async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const previous = new AbortController();
    const oldRead = vi.fn().mockRejectedValue(new Error("operation_busy"));
    const oldOutcome = queuedSessionRead(client, "reopen", previous.signal, oldRead, {
      retryBusy: true,
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    previous.abort();
    const current = new AbortController();
    const pending = deferred<string>();
    const newRead = vi.fn(() => pending.promise);
    const newRequest = queuedSessionRead(client, "reopen", current.signal, newRead, {
      retryBusy: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    const previousError = await oldOutcome;
    const duplicateRead = vi.fn().mockResolvedValue("duplicate");
    const joinedRequest = queuedSessionRead(
      client,
      "reopen",
      new AbortController().signal,
      duplicateRead,
      { retryBusy: true },
    );
    pending.resolve("current");
    expect(await Promise.all([newRequest, joinedRequest])).toEqual(["current", "current"]);
    expect(previousError).toMatchObject({ name: "AbortError" });
    expect(oldRead).toHaveBeenCalledTimes(1);
    expect(newRead).toHaveBeenCalledTimes(1);
    expect(duplicateRead).not.toHaveBeenCalled();
  });

  it("bounds observation to three busy reads without retrying an index scan", async () => {
    vi.useFakeTimers();
    const { client } = setup();
    const observe = vi.fn().mockRejectedValue(new Error("operation_busy"));
    vi.mocked(api.refreshWorkspaceSessions).mockRejectedValue(new Error("operation_busy"));
    const outcomes = Promise.allSettled([
      queuedSessionRead(client, "observation", new AbortController().signal, observe, {
        retryBusy: true,
      }),
      queuedSessionRead(client, "scan", new AbortController().signal, () =>
        api.refreshWorkspaceSessions("one", false),
      ),
    ]);
    await vi.advanceTimersByTimeAsync(450);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(1);
    for (const outcome of await outcomes)
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({ message: "operation_busy" }),
      });
  });

  it("does not overwrite a newer shared snapshot with an older pending read", async () => {
    const { client, wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockReturnValue(pending.promise);
    const { result } = renderHook(() => useSearchSessions([workspace("one")], true), { wrapper });
    client.setQueryData(homeKeys.continuations("one"), [session("one", "new refresh")]);
    await act(async () => pending.resolve([session("one", "old read")]));
    expect(result.current.sessions[0].title).toBe("new refresh");
    expect(client.getQueryData(homeKeys.continuations("one"))).toEqual([
      session("one", "new refresh"),
    ]);
  });

  it("does not start queued reads or cache pending results once the dialog closes", async () => {
    const { client, wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockReturnValue(pending.promise);
    const list = Array.from({ length: 8 }, (_, index) => workspace(String(index)));
    const { result, rerender } = renderHook(({ enabled }) => useSearchSessions(list, enabled), {
      wrapper,
      initialProps: { enabled: true },
    });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    rerender({ enabled: false });
    await act(async () => pending.resolve([session("0")]));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    expect(result.current.sessions).toEqual([]);
    expect(client.getQueryData(homeKeys.continuations("0"))).toBeUndefined();
  });
});
