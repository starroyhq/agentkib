import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type { RemoteStatus } from "@/core/remote-types";
import { useRemoteStore } from "./remote-store";

vi.mock("@/core/api", () => ({ api: { remoteRequest: vi.fn() } }));
const status: RemoteStatus = {
  local: { id: "local", name: "Desk", enabled: false, address: null },
  interfaces: [],
  discovered: [],
  pending: [],
  authorized: [],
  connections: [],
  pairing_code: null,
  pairing_expires_at: null,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.mocked(api.remoteRequest).mockReset();
  useRemoteStore.setState({
    snapshot: null,
    pairing: null,
    loading: false,
    busy: false,
    error: "",
    operationError: false,
  });
});

describe("remote connection state", () => {
  it("ignores same-minute heartbeats but accepts minute and connection state changes", async () => {
    const connected: RemoteStatus = {
      ...status,
      connections: [
        {
          id: "host",
          name: "Host",
          address: "192.168.1.2:42987",
          status: "online",
          last_seen: 120,
          error: null,
        },
      ],
      authorized: [{ id: "peer", name: "Peer", approved_at: 100, last_seen: 120 }],
    };
    const heartbeat: RemoteStatus = {
      ...connected,
      connections: connected.connections.map((record) => ({ ...record, last_seen: 179 })),
      authorized: connected.authorized.map((record) => ({ ...record, last_seen: 179 })),
    };
    const nextMinute: RemoteStatus = {
      ...heartbeat,
      connections: heartbeat.connections.map((record) => ({ ...record, last_seen: 181 })),
      authorized: heartbeat.authorized.map((record) => ({ ...record, last_seen: 183 })),
    };
    const offline: RemoteStatus = {
      ...nextMinute,
      connections: nextMinute.connections.map((record) => ({
        ...record,
        status: "offline",
        last_seen: 185,
      })),
    };
    vi.mocked(api.remoteRequest)
      .mockResolvedValueOnce(connected)
      .mockResolvedValueOnce(heartbeat)
      .mockResolvedValueOnce(nextMinute)
      .mockResolvedValueOnce(offline);
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().snapshot).toBe(connected);
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().snapshot).toBe(connected);
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().snapshot).toBe(nextMinute);
    expect(useRemoteStore.getState().snapshot?.connections[0].last_seen).toBe(181);
    expect(useRemoteStore.getState().snapshot?.authorized[0].last_seen).toBe(183);
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().snapshot).toBe(offline);
  });

  it("applies authorization removal immediately within a heartbeat minute", async () => {
    const approved: RemoteStatus = {
      ...status,
      authorized: [{ id: "peer", name: "Peer", approved_at: 100, last_seen: 120 }],
    };
    vi.mocked(api.remoteRequest).mockResolvedValueOnce(approved).mockResolvedValueOnce(status);
    await useRemoteStore.getState().refresh();
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().snapshot).toBe(status);
  });

  it("does not let background status polling erase a failed user operation", async () => {
    const failure = new Error("pairing denied");
    vi.mocked(api.remoteRequest).mockRejectedValueOnce(failure).mockResolvedValue(status);
    await useRemoteStore
      .getState()
      .run({ operation: "pair", address: "192.168.1.2:42987", code: "12345678" });
    await Promise.resolve();
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().error).toBe(failure);
    expect(useRemoteStore.getState().error).toMatchObject({ message: "pairing denied" });
    useRemoteStore.getState().clearError();
    expect(useRemoteStore.getState().error).toBe("");
  });
  it("loads real status and preserves cached status on network failure", async () => {
    const failure = new Error("offline");
    vi.mocked(api.remoteRequest).mockResolvedValueOnce(status).mockRejectedValueOnce(failure);
    await useRemoteStore.getState().refresh();
    await useRemoteStore.getState().refresh();
    expect(useRemoteStore.getState().snapshot).toEqual(status);
    expect(useRemoteStore.getState().error).toBe(failure);
    expect(useRemoteStore.getState().error).toMatchObject({ message: "offline" });
  });
  it("keeps the original structured operation error through a failed status refresh", async () => {
    const failure = { key: "errors.generic", detail: "REMOTE_PAIRING_DENIED" };
    vi.mocked(api.remoteRequest)
      .mockRejectedValueOnce(failure)
      .mockRejectedValue(new Error("offline"));
    await useRemoteStore
      .getState()
      .run({ operation: "pair", address: "192.168.1.2:42987", code: "12345678" });
    await Promise.resolve();
    await useRemoteStore.getState().refresh();

    expect(useRemoteStore.getState().error).toBe(failure);
    expect(useRemoteStore.getState().operationError).toBe(true);
    expect(useRemoteStore.getState().busy).toBe(false);
    expect(useRemoteStore.getState().loading).toBe(false);
    useRemoteStore.getState().clearError();
    expect(useRemoteStore.getState().error).toBe("");
    expect(useRemoteStore.getState().operationError).toBe(false);
  });
  it("serializes mutations and invalidates an older status response", async () => {
    const old = deferred<RemoteStatus>();
    const mutation = deferred<RemoteStatus>();
    vi.mocked(api.remoteRequest)
      .mockImplementationOnce(() => old.promise)
      .mockImplementationOnce(() => mutation.promise)
      .mockResolvedValue(status);
    const read = useRemoteStore.getState().refresh();
    const update = useRemoteStore.getState().run({ operation: "revoke", id: "peer" });
    expect(await useRemoteStore.getState().run({ operation: "revoke", id: "peer" })).toBeNull();
    old.resolve({ ...status, local: { ...status.local, name: "stale" } });
    await read;
    expect(useRemoteStore.getState().snapshot).toBeNull();
    mutation.resolve(status);
    await update;
    expect(useRemoteStore.getState().snapshot).toEqual(status);
    expect(
      vi.mocked(api.remoteRequest).mock.calls.filter(([request]) => request.operation === "revoke"),
    ).toHaveLength(1);
  });
  it("keeps verification details only in memory and refreshes after pairing", async () => {
    const pairing = {
      id: "host",
      verification: "123 456",
      status: "pending" as const,
      expires_at: 2_000_000_000,
    };
    vi.mocked(api.remoteRequest).mockResolvedValueOnce(pairing).mockResolvedValue(status);
    await useRemoteStore
      .getState()
      .run({ operation: "pair", address: "192.168.1.2:42987", code: "12345678" });
    expect(useRemoteStore.getState().pairing).toEqual(pairing);
    expect(api.remoteRequest).toHaveBeenLastCalledWith({ operation: "status" });
  });
});
