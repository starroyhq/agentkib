// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteCatalog, RemoteConnection, RemoteStatus } from "@/core/remote-types";
import type { ConversationEventPage, WorkspaceSummary } from "@/core/types";
import { useRemoteStore } from "./remote-store";
import { filterSessions, groupSessions } from "@agentkib/session-catalog";
import { sessionCatalogStats } from "@/features/sessions/session-catalog";
import {
  RemoteCatalogBridge,
  readRemoteHistory,
  refreshRemoteCatalog,
  useRemoteCatalogEntries,
  useRemoteCatalogStore,
  remoteRecordId,
  invalidateRemoteHost,
} from "./remote-catalog-store";

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/core/api", () => ({ api: { remoteRequest: request } }));
const host = (id = "host-a", status: RemoteConnection["status"] = "online"): RemoteConnection => ({
  id,
  name: "Laptop",
  address: "192.168.1.3:42987",
  status,
  last_seen: 1,
  error: null,
});
const snapshot = (connections: RemoteConnection[]): RemoteStatus => ({
  local: { id: "local-id", name: "Desktop", enabled: false, address: null },
  interfaces: [],
  discovered: [],
  pending: [],
  authorized: [],
  connections,
  pairing_code: null,
  pairing_expires_at: null,
});
const catalog: RemoteCatalog = {
  workspaces: [{ id: "workspace", name: "Design", path: "/projects/design" } as WorkspaceSummary],
  sessions: [
    {
      id: "session",
      workspace_id: "workspace",
      title: "Review",
      agent: "codex",
      availability: "readable",
      archived: false,
      sidechain: false,
    },
  ],
};
const page: ConversationEventPage = {
  events: [
    {
      id: "event",
      kind: "user-message",
      content: "Synthetic history",
      attachment_count: 0,
      truncated: false,
    },
  ],
  warnings: [],
};
const session = {
  ...catalog.sessions[0],
  id: remoteRecordId("host-a", "session"),
  remote: {
    host_id: "host-a",
    host_name: "Laptop",
    original_id: "session",
    online: true,
    last_synced_at: "2026-09-07T00:00:00Z",
  },
};

describe("remote catalog and history isolation", () => {
  beforeEach(() => {
    for (const id of ["host-a", "host-b"]) invalidateRemoteHost(id);
    useRemoteCatalogStore.setState({ catalogs: {}, errors: {}, revision: 0 });
    useRemoteStore.setState({
      snapshot: snapshot([host()]),
      refresh: vi.fn().mockResolvedValue(undefined),
    });
    request.mockReset();
    request.mockResolvedValue(catalog);
  });
  afterEach(cleanup);

  it("namespaces identical workspace/session IDs by host without mutating source records", async () => {
    useRemoteStore.setState({ snapshot: snapshot([host(), host("host-b")]) });
    await Promise.all([refreshRemoteCatalog("host-a", true), refreshRemoteCatalog("host-b", true)]);
    const { result } = renderHook(useRemoteCatalogEntries);
    expect(new Set(result.current.sessions.map((item) => item.id)).size).toBe(2);
    expect(new Set(result.current.workspaces.map((item) => item.id)).size).toBe(2);
    expect(result.current.sessions[0].workspace_id).toBe(result.current.workspaces[0].id);
    expect(catalog.sessions[0].id).toBe("session");
    expect(catalog.workspaces[0].id).toBe("workspace");
  });

  it("keeps a server-projected managed native alias across parsing, namespace and directory filtering", async () => {
    const nativeId = "managed-native-index";
    // The host has already verified ownership and folded aliases into this native index record.
    // Renderer parsing must retain the display classification without changing history identity.
    const ordinary = [
      {
        ...catalog.sessions[0],
        id: nativeId,
        title: "Managed continuation",
        origin: "interactive",
      },
      { ...catalog.sessions[0], id: "conversation-a", origin: "interactive" },
      { ...catalog.sessions[0], id: "conversation-b", origin: "interactive" },
      {
        ...catalog.sessions[0],
        id: "user-fork",
        origin: "interactive",
        forked_from_session_id: nativeId,
      },
      { ...catalog.sessions[0], id: "unknown", origin: "unknown" },
    ];
    request.mockResolvedValue({
      ...catalog,
      sessions: [
        ...ordinary,
        ...Array.from({ length: 36 }, (_, index) => ({
          ...catalog.sessions[0],
          id: `unowned-exec-${index}`,
          origin: "execution",
        })),
        { ...catalog.sessions[0], id: "auxiliary", origin: "auxiliary" },
      ],
    });
    await refreshRemoteCatalog("host-a", true);
    const { result } = renderHook(useRemoteCatalogEntries);
    const { sessions: remoteSessions, workspaces } = result.current;
    const visible = filterSessions(
      remoteSessions,
      workspaces,
      { query: "", agent: "all", filter: "all" },
      "Untitled session",
    );
    expect(visible.map(({ remote }) => remote.original_id)).toEqual(ordinary.map(({ id }) => id));
    expect(sessionCatalogStats(remoteSessions)).toEqual({
      total: 5,
      readable: 5,
      archived: 0,
      metadata: 0,
    });
    expect(groupSessions(remoteSessions, workspaces)[0].sessions).toEqual(visible);
    const native = visible.find(({ id }) => id === remoteRecordId("host-a", nativeId))!;
    expect(native).toMatchObject({
      id: remoteRecordId("host-a", nativeId),
      origin: "interactive",
      remote: { host_id: "host-a", original_id: nativeId },
    });
    expect(
      filterSessions(
        remoteSessions,
        workspaces,
        { query: "Managed continuation", agent: "codex", filter: "current" },
        "Untitled session",
      ),
    ).toEqual([native]);
    request.mockResolvedValue(page);
    expect(await readRemoteHistory(native)).toEqual(page);
    expect(request).toHaveBeenLastCalledWith({
      operation: "events",
      id: "host-a",
      sessionId: nativeId,
      cursor: undefined,
      limit: 50,
    });
  });

  it("refreshes read-state hosts every five visible seconds, retains old-host cadence, and pauses in background", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");
    const readState = {
      source: "codex-native",
      status: "unread",
      freshness: "current",
      version: "native:v1",
      firstUnread: { type: "threadStart" },
      latestResult: null,
    };
    useRemoteStore.setState({ snapshot: snapshot([host(), host("host-b")]) });
    request.mockImplementation(async ({ id }: { id: string }) =>
      id === "host-a"
        ? { ...catalog, sessions: catalog.sessions.map((session) => ({ ...session, readState })) }
        : catalog,
    );
    const view = render(<RemoteCatalogBridge />);
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-a")).toHaveLength(1);
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-b")).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-a")).toHaveLength(2);
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-b")).toHaveLength(1);
      visibility.mockReturnValue("hidden");
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-a")).toHaveLength(2);
      visibility.mockReturnValue("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-a")).toHaveLength(3);
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-b")).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(request.mock.calls.filter(([arg]) => arg.id === "host-b")).toHaveLength(2);
    } finally {
      view.unmount();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("deduplicates reads and observes the 30 second snapshot interval", async () => {
    await Promise.all([refreshRemoteCatalog("host-a", true), refreshRemoteCatalog("host-a", true)]);
    await refreshRemoteCatalog("host-a");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps both provenance relationships on their own host, including absent parents", async () => {
    request.mockResolvedValue({
      ...catalog,
      sessions: [
        {
          ...catalog.sessions[0],
          origin: "auxiliary",
          spawned_by_session_id: "parent",
          forked_from_session_id: "fork",
        },
      ],
    });
    useRemoteStore.setState({ snapshot: snapshot([host(), host("host-b")]) });
    await Promise.all([refreshRemoteCatalog("host-a", true), refreshRemoteCatalog("host-b", true)]);
    const { result } = renderHook(useRemoteCatalogEntries);
    for (const entry of result.current.sessions) {
      expect(entry.origin).toBe("auxiliary");
      expect(entry.spawned_by_session_id).toBe(remoteRecordId(entry.remote.host_id, "parent"));
      expect(entry.forked_from_session_id).toBe(remoteRecordId(entry.remote.host_id, "fork"));
    }
    expect(result.current.sessions[0].spawned_by_session_id).not.toBe(
      result.current.sessions[1].spawned_by_session_id,
    );
  });

  it("retains the last valid cache when a host returns a malformed directory", async () => {
    await refreshRemoteCatalog("host-a", true);
    const cached = useRemoteCatalogStore.getState().catalogs["host-a"];
    request.mockResolvedValue({ workspaces: null, sessions: [] });
    await refreshRemoteCatalog("host-a", true);
    expect(useRemoteCatalogStore.getState().catalogs["host-a"]).toBe(cached);
    expect(useRemoteCatalogStore.getState().errors["host-a"]).toContain("REMOTE_INVALID_RESPONSE");
  });

  it("retains loaded history while offline and makes no offline network request", async () => {
    await refreshRemoteCatalog("host-a", true);
    request.mockResolvedValue(page);
    expect(await readRemoteHistory(session)).toEqual(page);
    expect(request).toHaveBeenLastCalledWith({
      operation: "events",
      id: "host-a",
      sessionId: "session",
      cursor: undefined,
      limit: 50,
    });
    useRemoteStore.setState({ snapshot: snapshot([host("host-a", "offline")]) });
    request.mockClear();
    expect(await readRemoteHistory(session)).toEqual(page);
    expect(request).not.toHaveBeenCalled();
    const { result } = renderHook(useRemoteCatalogEntries);
    expect(result.current.sessions[0].remote?.online).toBe(false);
    await expect(readRemoteHistory(session, "uncached-page")).rejects.toThrow("REMOTE_OFFLINE");
  });

  it.each(["removed", "metadata"])(
    "prunes %s history after a successful catalog and rejects late pages",
    async (state) => {
      await refreshRemoteCatalog("host-a", true);
      request.mockResolvedValue(page);
      await readRemoteHistory(session);
      let resolve!: (value: ConversationEventPage) => void;
      request.mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const reading = readRemoteHistory(session, "older");
      request.mockResolvedValue({
        ...catalog,
        sessions:
          state === "removed" ? [] : [{ ...catalog.sessions[0], availability: "metadata-only" }],
      });
      await refreshRemoteCatalog("host-a", true);
      resolve(page);
      await expect(reading).rejects.toThrow("REMOTE_SESSION_NOT_FOUND");
      useRemoteStore.setState({ snapshot: snapshot([host("host-a", "offline")]) });
      request.mockClear();
      await expect(readRemoteHistory(session)).rejects.toThrow("REMOTE_SESSION_NOT_FOUND");
      expect(request).not.toHaveBeenCalled();
    },
  );

  it.each(["revoked", "sharing-disabled", "index-disabled", "identity-changed"] as const)(
    "clears history and catalog on %s and rejects delayed pages",
    async (state) => {
      await refreshRemoteCatalog("host-a", true);
      let resolve!: (value: ConversationEventPage) => void;
      request.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      const reading = readRemoteHistory(session);
      useRemoteStore.setState({ snapshot: snapshot([host("host-a", state)]) });
      resolve(page);
      await expect(reading).rejects.toThrow("REMOTE_REVOKED");
      expect(useRemoteCatalogStore.getState().catalogs).toEqual({});
      await expect(readRemoteHistory(session)).rejects.toThrow("REMOTE_REVOKED");
      const revision = useRemoteCatalogStore.getState().revision;
      useRemoteStore.setState({ snapshot: snapshot([host("host-a", state)]) });
      expect(useRemoteCatalogStore.getState().revision).toBe(revision);
    },
  );

  it("does not restore a removed host from a late catalog response", async () => {
    let resolve!: (value: RemoteCatalog) => void;
    request.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const reading = refreshRemoteCatalog("host-a", true);
    useRemoteStore.setState({ snapshot: snapshot([]) });
    resolve(catalog);
    await reading;
    expect(useRemoteCatalogStore.getState().catalogs).toEqual({});
  });

  it("clears catalog upon an explicit permission error, not a transient network error", async () => {
    await refreshRemoteCatalog("host-a", true);
    request.mockRejectedValue(new Error("REMOTE_OFFLINE"));
    await refreshRemoteCatalog("host-a", true);
    expect(useRemoteCatalogStore.getState().catalogs["host-a"]).toBeDefined();
    request.mockRejectedValue(new Error("REMOTE_INDEX_DISABLED"));
    await refreshRemoteCatalog("host-a", true);
    expect(useRemoteCatalogStore.getState().catalogs["host-a"]).toBeUndefined();
  });

  it("loaded-only selectors do not trigger scans, reads or history requests", async () => {
    const { result } = renderHook(useRemoteCatalogEntries);
    expect(result.current.sessions).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    await act(() => refreshRemoteCatalog("host-a", true));
    expect(result.current.sessions).toHaveLength(1);
    expect(request).toHaveBeenCalledExactlyOnceWith({ operation: "catalog", id: "host-a" });
  });
});
