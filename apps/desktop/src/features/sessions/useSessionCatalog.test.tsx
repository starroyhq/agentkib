// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type {
  ConversationIndexStatus,
  ConversationSessionSummary,
  WorkspaceSummary,
} from "@/core/types";
import { homeKeys } from "@/features/home/home-query";
import { useSessionCatalog } from "./useSessionCatalog";
import { SESSION_CATALOG_RUNTIME_CHANGED } from "./session-query";

vi.mock("@/core/api", () => ({
  api: {
    workspaceSessions: vi.fn(),
    workspaceSessionStatus: vi.fn(),
    refreshWorkspaceSessions: vi.fn(),
  },
}));

function session(workspaceId: string, title = workspaceId): ConversationSessionSummary {
  return {
    id: `session-${workspaceId}`,
    workspace_id: workspaceId,
    title,
    agent: "codex",
    archived: false,
    sidechain: false,
    availability: "readable",
  };
}
function workspace(id: string) {
  return { id, name: `Workspace ${id}` } as WorkspaceSummary;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("useSessionCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => [session(id)]);
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([]);
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation(async (id) => [session(id)]);
  });
  afterEach(cleanup);

  it("never retries an indexing mutation and localizes its admission contention", async () => {
    const { wrapper } = setup();
    vi.mocked(api.refreshWorkspaceSessions).mockRejectedValue(new Error("operation_busy"));
    const { result } = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledOnce();
    expect(result.current.errors.one).toBeTruthy();
    expect(result.current.errors.one).not.toContain("operation_busy");
  });

  it("does not read or refresh sessions while indexing is disabled, even with cached records", () => {
    const { wrapper, client } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one")]);
    const { result } = renderHook(() => useSessionCatalog([workspace("one")], false), { wrapper });
    expect(result.current.sessions).toEqual([]);
    expect(result.current.ready).toBe(true);
    expect(api.workspaceSessions).not.toHaveBeenCalled();
    expect(api.workspaceSessionStatus).not.toHaveBeenCalled();
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("never exposes the disabled ready state on the first render after enabling indexing", async () => {
    const { wrapper } = setup();
    const frames: Array<{ loading: boolean; ready: boolean }> = [];
    const { result, rerender } = renderHook(
      ({ enabled }) => {
        const catalog = useSessionCatalog([workspace("one")], enabled);
        frames.push({ loading: catalog.loading, ready: catalog.ready });
        return catalog;
      },
      { wrapper, initialProps: { enabled: false } },
    );
    expect(result.current.ready).toBe(true);
    expect(api.workspaceSessions).not.toHaveBeenCalled();
    frames.length = 0;
    rerender({ enabled: true });
    expect(frames[0]).toEqual({ loading: true, ready: false });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sessions).toEqual([session("one")]);
  });

  it("shows query cache immediately, then stored records before a non-forced refresh", async () => {
    const { wrapper, client } = setup();
    const stored = deferred<ConversationSessionSummary[]>();
    const refreshed = deferred<ConversationSessionSummary[]>();
    client.setQueryData(homeKeys.continuations("one"), [session("one", "query cache")]);
    vi.mocked(api.workspaceSessions).mockReturnValueOnce(stored.promise);
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(refreshed.promise);
    const { result } = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    expect(result.current.sessions[0].title).toBe("query cache");
    await act(async () => stored.resolve([session("one", "stored cache")]));
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    expect(result.current.sessions[0].title).toBe("stored cache");
    expect(result.current.loading).toBe(false);
    expect(result.current.ready).toBe(false);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith("one", false);
    await act(async () => refreshed.resolve([session("one", "refreshed")]));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(client.getQueryData(homeKeys.continuations("one"))).toEqual([
      session("one", "refreshed"),
    ]);
  });

  it("publishes completed workspace progress before the slowest scan and waits for final authority", async () => {
    const { wrapper } = setup();
    const finalScan = deferred<ConversationSessionSummary[]>();
    const synced = deferred<void>();
    const afterRefresh = vi.fn(() => synced.promise);
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation(async (id) =>
      id === "six" ? finalScan.promise : [session(id)],
    );
    const workspaces = ["one", "two", "three", "four", "five", "six"].map(workspace);
    const { result } = renderHook(() => useSessionCatalog(workspaces, true, afterRefresh), {
      wrapper,
    });
    await waitFor(() => expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(6));
    await waitFor(() => expect(afterRefresh).toHaveBeenCalledOnce());
    expect(result.current.usable).toBe(true);
    await act(async () => finalScan.resolve([session("six", "newly discovered")]));
    await waitFor(() => expect(afterRefresh).toHaveBeenCalledOnce());
    expect(result.current.ready).toBe(false);
    expect(result.current.refreshing).toBe(true);
    await act(async () => synced.resolve());
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.refreshing).toBe(false);
    expect(afterRefresh).toHaveBeenCalledTimes(2);
    expect(result.current.sessions.find(({ workspace_id }) => workspace_id === "six")?.title).toBe(
      "newly discovered",
    );
  });

  it("aggregates all workspaces, de-duplicates IDs, and limits all API work to four in flight", async () => {
    const { wrapper } = setup();
    let active = 0;
    let maximum = 0;
    const measure = async <T,>(value: T) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    };
    vi.mocked(api.workspaceSessions).mockImplementation((id) => measure([session(id)]));
    vi.mocked(api.workspaceSessionStatus).mockImplementation(() => measure([]));
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation((id) => measure([session(id)]));
    const workspaces = Array.from({ length: 15 }, (_, index) => workspace(String(index)));
    const { result } = renderHook(() => useSessionCatalog([...workspaces, workspaces[0]], true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sessions).toHaveLength(15);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(15);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(15);
    expect(maximum).toBe(4);
  });

  it("preserves per-workspace cache on partial failure and clears the error on manual retry", async () => {
    const { wrapper } = setup();
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation(async (id) => {
      if (id === "one") throw new Error("refresh unavailable");
      return [session(id, "fresh")];
    });
    const { result } = renderHook(
      () => useSessionCatalog([workspace("one"), workspace("two")], true),
      { wrapper },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sessions.map(({ title }) => title)).toEqual(["one", "fresh"]);
    expect(result.current.errors.one).toContain("refresh unavailable");
    expect(result.current.errors.two).toBeUndefined();
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation(async (id) => [
      session(id, "recovered"),
    ]);
    await act(async () => result.current.refresh());
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledWith("one", true);
    expect(result.current.errors).toEqual({});
    expect(result.current.sessions.every(({ title }) => title === "recovered")).toBe(true);
  });

  it("keeps session data if only status loading fails", async () => {
    const { wrapper } = setup();
    vi.mocked(api.workspaceSessionStatus).mockRejectedValue(new Error("status unavailable"));
    const { result } = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.errors.one).toContain("status unavailable");
  });

  it("preserves the query cache when both stored reads and refresh fail", async () => {
    const { wrapper, client } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one", "last known")]);
    vi.mocked(api.workspaceSessions).mockRejectedValue(new Error("read unavailable"));
    vi.mocked(api.refreshWorkspaceSessions).mockRejectedValue(new Error("refresh unavailable"));
    const { result } = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.sessions).toEqual([session("one", "last known")]);
    expect(result.current.errors.one).toContain("refresh unavailable");
  });

  it("does not repeat automatic scans when workspace names or list order change", async () => {
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ workspaces }) => useSessionCatalog(workspaces, true),
      { wrapper, initialProps: { workspaces: [workspace("one"), workspace("two")] } },
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    rerender({ workspaces: [workspace("two"), { ...workspace("one"), name: "Renamed" }] });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(2);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight refresh rather than starting duplicate scans", async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(result.current.ready).toBe(true));
    const scan = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(scan.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.refresh();
      second = result.current.refresh();
    });
    expect(first).toBe(second);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(2);
    await act(async () => {
      scan.resolve([session("one")]);
      await Promise.all([first, second]);
    });
  });

  it("ignores obsolete reads after a workspace set change and never writes them to shared cache", async () => {
    const { wrapper, client } = setup();
    const obsolete = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockImplementation((id) =>
      id === "one" ? obsolete.promise : Promise.resolve([session(id)]),
    );
    const { result, rerender } = renderHook(({ id }) => useSessionCatalog([workspace(id)], true), {
      wrapper,
      initialProps: { id: "one" },
    });
    rerender({ id: "two" });
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => obsolete.resolve([session("one")]));
    expect(result.current.sessions).toEqual([session("two")]);
    expect(client.getQueryData(homeKeys.continuations("one"))).toBeUndefined();
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalledWith("one", false);
  });

  it("retains the concurrency bound when all old workspace reads are still pending", async () => {
    const { wrapper } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockReturnValue(pending.promise);
    const { rerender, unmount } = renderHook(
      ({ prefix }) =>
        useSessionCatalog(
          Array.from({ length: 8 }, (_, i) => workspace(`${prefix}-${i}`)),
          true,
        ),
      { wrapper, initialProps: { prefix: "old" } },
    );
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    rerender({ prefix: "new" });
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    unmount();
    await act(async () => pending.resolve([]));
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("retains the concurrency bound when the page unmounts and immediately re-enters", async () => {
    const { wrapper } = setup();
    const obsolete = deferred<void>();
    let active = 0;
    let maximum = 0;
    vi.mocked(api.workspaceSessions).mockImplementation(async (id) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (id.startsWith("old")) await obsolete.promise;
      else await Promise.resolve();
      active -= 1;
      return [session(id)];
    });
    const old = renderHook(
      () =>
        useSessionCatalog(
          Array.from({ length: 8 }, (_, i) => workspace(`old-${i}`)),
          true,
        ),
      { wrapper },
    );
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    old.unmount();
    const next = renderHook(
      () =>
        useSessionCatalog(
          Array.from({ length: 8 }, (_, i) => workspace(`new-${i}`)),
          true,
        ),
      { wrapper },
    );
    expect(api.workspaceSessions).toHaveBeenCalledTimes(4);
    await act(async () => obsolete.resolve());
    await waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(maximum).toBe(4);
    expect(next.result.current.sessions).toHaveLength(8);
    expect(api.workspaceSessions).toHaveBeenCalledTimes(12);
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledTimes(8);
  });

  it("ignores pending refresh results after indexing is disabled", async () => {
    const { wrapper, client } = setup();
    const pending = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useSessionCatalog([workspace("one")], enabled),
      { wrapper, initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    rerender({ enabled: false });
    await act(async () => pending.resolve([session("one", "obsolete")]));
    expect(result.current.sessions).toEqual([]);
    expect(client.getQueryData(homeKeys.continuations("one"))).toBeUndefined();
    expect(api.workspaceSessionStatus).toHaveBeenCalledTimes(1);
  });

  it("does not persist late status results or start a scan after unmount", async () => {
    const { wrapper, client } = setup();
    const pending = deferred<ConversationIndexStatus[]>();
    vi.mocked(api.workspaceSessionStatus).mockReturnValueOnce(pending.promise);
    const { unmount } = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(api.workspaceSessionStatus).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => {
      pending.resolve([
        { workspace_id: "one", agent: "codex", freshness: "fresh", session_count: 1 },
      ]);
    });
    expect(client.getQueryData([...homeKeys.continuations("one"), "status"])).toBeUndefined();
    expect(api.refreshWorkspaceSessions).not.toHaveBeenCalled();
  });

  it("returns ready for an empty workspace list and stores real index statuses", async () => {
    const { wrapper } = setup();
    const status: ConversationIndexStatus = {
      workspace_id: "one",
      agent: "codex",
      freshness: "fresh",
      session_count: 1,
    };
    vi.mocked(api.workspaceSessionStatus).mockResolvedValue([status]);
    const { result, rerender } = renderHook(
      ({ workspaces }) => useSessionCatalog(workspaces, true),
      { wrapper, initialProps: { workspaces: [] as WorkspaceSummary[] } },
    );
    expect(result.current.ready).toBe(true);
    expect(api.workspaceSessions).not.toHaveBeenCalled();
    rerender({ workspaces: [workspace("one")] });
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.statuses).toEqual([status]);
  });

  it("uses cached rows on re-entry while a stored read is slow and does not repeat a recent scan", async () => {
    const { wrapper } = setup();
    const first = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(first.result.current.ready).toBe(true));
    const row = first.result.current.sessions[0];
    first.unmount();
    const stored = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockReturnValueOnce(stored.promise);
    const next = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    expect(next.result.current.sessions[0]).toBe(row);
    expect(next.result.current.usable).toBe(true);
    expect(next.result.current.ready).toBe(false);
    await act(async () => stored.resolve([session("one")]));
    await waitFor(() => expect(next.result.current.ready).toBe(true));
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledOnce();
    expect(next.result.current.sessions[0]).toBe(row);
  });

  it("retains unknown cached directory rows while stripping unverified account read receipts", async () => {
    const { wrapper, client } = setup();
    client.setQueryData(homeKeys.continuations("one"), [
      {
        ...session("one"),
        readState: {
          source: "agentkib",
          status: "unread",
          freshness: "current",
          version: "old-account",
          firstUnread: { type: "threadStart" },
          latestResult: null,
        },
      },
    ]);
    const stored = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.workspaceSessions).mockReturnValueOnce(stored.promise);
    const view = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    expect(view.result.current.sessions[0]?.id).toBe("session-one");
    expect(view.result.current.sessions[0]?.readState).toBeUndefined();
    expect(view.result.current.usable).toBe(true);
    await act(async () => stored.resolve([session("one")]));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.sessions[0]?.readState).toBeUndefined();
  });

  it("retains a cached row through an interim empty stored read until its scan confirms deletion", async () => {
    const { wrapper, client } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one", "cached")]);
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    const scan = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.refreshWorkspaceSessions).mockReturnValueOnce(scan.promise);
    const frames: string[][] = [];
    const view = renderHook(
      () => {
        const catalog = useSessionCatalog([workspace("one")], true);
        frames.push(catalog.sessions.map(({ id }) => id));
        return catalog;
      },
      { wrapper },
    );
    await waitFor(() => expect(api.refreshWorkspaceSessions).toHaveBeenCalledOnce());
    expect(frames.every((rows) => rows.includes("session-one"))).toBe(true);
    expect(view.result.current.sessions[0]?.title).toBe("cached");
    await act(async () => scan.resolve([]));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.sessions).toEqual([]);
    expect(view.result.current.usable).toBe(true);
  });

  it("lets a completed workspace remove rows while retaining a slower workspace cache", async () => {
    const { wrapper, client } = setup();
    client.setQueryData(homeKeys.continuations("one"), [session("one")]);
    client.setQueryData(homeKeys.continuations("two"), [session("two")]);
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    const slow = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.refreshWorkspaceSessions).mockImplementation((id) =>
      id === "two" ? slow.promise : Promise.resolve([]),
    );
    const view = renderHook(() => useSessionCatalog([workspace("one"), workspace("two")], true), {
      wrapper,
    });
    await waitFor(() =>
      expect(view.result.current.sessions.map(({ id }) => id)).toEqual(["session-two"]),
    );
    expect(view.result.current.ready).toBe(false);
    await act(async () => slow.resolve([]));
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.sessions).toEqual([]);
  });

  it("reads the current snapshot after a stale scan without repeating the mutation", async () => {
    const { wrapper } = setup();
    vi.mocked(api.workspaceSessions)
      .mockResolvedValueOnce([session("one", "before")])
      .mockResolvedValue([session("one", "after")]);
    vi.mocked(api.refreshWorkspaceSessions).mockRejectedValue(new Error("session-index-stale"));
    const view = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.sessions[0]?.title).toBe("after");
    expect(view.result.current.errors).toEqual({});
    expect(api.refreshWorkspaceSessions).toHaveBeenCalledOnce();
    expect(api.workspaceSessions).toHaveBeenCalledTimes(2);
  });

  it("clears old runtime rows and never accepts its late scan after a boot change", async () => {
    const { wrapper } = setup();
    const view = renderHook(() => useSessionCatalog([workspace("one")], true), { wrapper });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    const oldScan = deferred<ConversationSessionSummary[]>();
    vi.mocked(api.refreshWorkspaceSessions)
      .mockReturnValueOnce(oldScan.promise)
      .mockResolvedValue([]);
    let prior!: Promise<void>;
    act(() => {
      prior = view.result.current.refresh();
    });
    vi.mocked(api.workspaceSessions).mockResolvedValue([]);
    act(() => window.dispatchEvent(new Event(SESSION_CATALOG_RUNTIME_CHANGED)));
    expect(view.result.current.sessions).toEqual([]);
    await act(async () => {
      oldScan.resolve([session("one", "old boot")]);
      await prior;
    });
    await waitFor(() => expect(view.result.current.ready).toBe(true));
    expect(view.result.current.sessions).toEqual([]);
  });
});
