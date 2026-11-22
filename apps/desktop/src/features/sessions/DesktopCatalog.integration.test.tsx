// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebClient, type Access, type Live } from "@agentkib/web-client";
import type { ConversationSubscription, SessionStreamEvent } from "@agentkib/conversation-state";
import {
  createDesktopConversationAdapter,
  type DesktopConversationBridge,
} from "@/core/conversation-bridge";
import { useSessionController } from "./conversation/desktop-session-controller";

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(invalidBootstrap = false) {
  let title = "Initial catalog";
  let status: Access["status"] = "approved";
  let sequence = 0;
  let subscriptions = 0;
  let bootstrapInvalid = invalidBootstrap;
  const pending = new Map<string, number[]>();
  const listeners = new Set<(event: SessionStreamEvent<Live>) => void>();
  const retiredListeners: ((event: SessionStreamEvent<Live>) => void)[] = [];
  const unavailableListeners = new Set<() => void>();
  const controlListeners = new Set<(id: string) => void>();
  const live: Live = {
    sessionId: "",
    status: "idle",
    revision: 0,
    sendEnabled: false,
    approvals: [],
  };
  const event = (
    seq: number,
    type: "snapshot" | "invalidate" | "resync-required" = "invalidate",
    subscriptionId = `catalog-${subscriptions}`,
    epoch = "epoch",
  ): SessionStreamEvent<Live> => ({
    protocolVersion: 2,
    subscriptionId,
    sessionId: "",
    runtimeBootId: "runtime",
    epoch,
    seq,
    cursor: `${subscriptionId}:${epoch}:${seq}`,
    ...(type === "snapshot"
      ? { type, payload: { live } }
      : type === "invalidate"
        ? { type, payload: { domains: ["catalog"] } }
        : { type, payload: { reason: "desktop-subscriber-overflow" } }),
  });
  const catalog = () => ({
    indexEnabled: true,
    sessions: [
      {
        id: "session",
        workspace_id: "workspace",
        agent: "claude-code",
        title,
        availability: "readable" as const,
        archived: false,
        sidechain: false,
      },
    ],
  });
  const bridge: DesktopConversationBridge = {
    request: vi.fn(async (path) => {
      if (path === "access")
        return {
          status: 200,
          body: {
            protocolVersion: 2,
            status,
            csrfToken: "local",
            bootId: "boot",
            experimentalEnabled: true,
            device: { id: "desktop-local", send: true, approve: true, manage: true },
          },
        };
      if (path === "catalog") return { status: 200, body: catalog() };
      return { status: 200, body: {} };
    }),
    upload: vi.fn(),
    subscribe: vi.fn(async (id): Promise<ConversationSubscription<Live>> => {
      expect(id).toBe("");
      subscriptions++;
      sequence = 0;
      const subscriptionId = `catalog-${subscriptions}`;
      const baseline = event(0, "snapshot");
      pending.set(subscriptionId, [0]);
      return {
        subscriptionId,
        events: bootstrapInvalid ? [baseline, event(1, "resync-required")] : [baseline],
        cursor: bootstrapInvalid ? event(1).cursor : baseline.cursor,
      };
    }),
    acknowledge: vi.fn(async (id, cursor) => {
      const seq = Number(cursor.split(":").at(-1));
      pending.set(
        id,
        (pending.get(id) ?? []).filter((value) => value > seq),
      );
    }),
    unsubscribe: vi.fn(async (id) => {
      pending.delete(id);
    }),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        retiredListeners.push(listener);
      };
    },
    onUnavailable: (listener) => {
      unavailableListeners.add(listener);
      return () => unavailableListeners.delete(listener);
    },
    onControlChanged: (listener) => {
      controlListeners.add(listener);
      return () => controlListeners.delete(listener);
    },
  };
  const client = new WebClient(
    undefined,
    { type: "same-origin" },
    createDesktopConversationAdapter(() => bridge),
  );
  const view = renderHook(() => useSessionController({ client, embedded: true }));
  const emit = (value: SessionStreamEvent<Live>) => {
    for (const listener of [...listeners]) listener(value);
  };
  return {
    view,
    bridge,
    client,
    event,
    emit,
    pending,
    retiredListeners,
    setTitle: (value: string) => (title = value),
    revoke: () => (status = "ended"),
    validBootstrap: () => (bootstrapInvalid = false),
    invalidate() {
      const value = event(++sequence);
      const queue = pending.get(value.subscriptionId)!;
      queue.push(sequence);
      // Model the host's outstanding-event budget. Missing ACKs eventually
      // produce the same resync marker instead of an unbounded mock stream.
      emit(queue.length > 256 ? event(sequence, "resync-required") : value);
      return value;
    },
    controlChanged: () => {
      for (const listener of controlListeners) listener("");
    },
    unavailable: () => {
      for (const listener of unavailableListeners) listener();
    },
  };
}

async function ready(host: ReturnType<typeof fixture>) {
  await waitFor(() => expect(host.view.result.current.sessions[0]?.title).toBe("Initial catalog"));
  await act(async () => {});
  expect(host.bridge.acknowledge).toHaveBeenCalledWith("catalog-1", "catalog-1:epoch:0");
}

describe("desktop embedded catalog observation", () => {
  it("acknowledges applied cursors and updates the catalog beyond the 256-event budget", async () => {
    const host = fixture();
    await ready(host);
    for (let batch = 0; batch < 12; batch++) {
      await act(async () => {
        host.setTitle(`Catalog batch ${batch}`);
        for (let index = 0; index < 32; index++) host.invalidate();
      });
      expect(host.view.result.current.sessions[0].title).toBe(`Catalog batch ${batch}`);
      expect(host.pending.get("catalog-1")).toEqual([]);
      expect(host.bridge.acknowledge).toHaveBeenLastCalledWith(
        "catalog-1",
        `catalog-1:epoch:${(batch + 1) * 32}`,
      );
    }
    expect(host.bridge.subscribe).toHaveBeenCalledOnce();
    expect(host.bridge.unsubscribe).not.toHaveBeenCalled();
  });

  it("does not reread or republish a duplicate invalidation or baseline", async () => {
    const host = fixture();
    await ready(host);
    const reads = vi.spyOn(host.client, "catalog");
    await act(async () => host.emit(host.event(0, "snapshot")));
    expect(reads).not.toHaveBeenCalled();
    let duplicate!: SessionStreamEvent<Live>;
    await act(async () => {
      host.setTitle("Accepted update");
      duplicate = host.invalidate();
    });
    expect(reads).toHaveBeenCalledOnce();
    reads.mockClear();
    await act(async () => {
      host.setTitle("Must not be reread");
      host.emit(duplicate);
    });
    expect(reads).not.toHaveBeenCalled();
    expect(host.view.result.current.sessions[0].title).toBe("Accepted update");
    expect(host.bridge.acknowledge).toHaveBeenLastCalledWith("catalog-1", duplicate.cursor);
  });

  it.each(["gap", "epoch", "resync"])(
    "replaces the subscription after %s without acknowledging the rejected event",
    async (failure) => {
      const host = fixture();
      await ready(host);
      const rejected = host.event(
        failure === "gap" ? 3 : 1,
        failure === "resync" ? "resync-required" : "invalidate",
        "catalog-1",
        failure === "epoch" ? "new-epoch" : "epoch",
      );
      await act(async () => {
        host.setTitle("Recovered baseline");
        host.emit(rejected);
      });
      expect(host.bridge.unsubscribe).toHaveBeenCalledWith("catalog-1");
      expect(host.bridge.subscribe).toHaveBeenCalledTimes(2);
      expect(host.bridge.subscribe).toHaveBeenLastCalledWith("", undefined);
      expect(host.bridge.acknowledge).not.toHaveBeenCalledWith("catalog-1", rejected.cursor);
      expect(host.view.result.current.sessions[0].title).toBe("Recovered baseline");
      await act(async () => {
        host.setTitle("New stream update");
        host.invalidate();
      });
      expect(host.view.result.current.sessions[0].title).toBe("New stream update");
      expect(host.bridge.acknowledge).toHaveBeenLastCalledWith("catalog-2", "catalog-2:epoch:1");
    },
  );

  it("does not let an old in-flight catalog read delay or overwrite the replacement stream", async () => {
    const host = fixture();
    await ready(host);
    const obsolete = deferred<Awaited<ReturnType<WebClient["catalog"]>>>();
    const reads = vi.spyOn(host.client, "catalog").mockReturnValueOnce(obsolete.promise);
    await act(async () => host.invalidate());
    expect(reads).toHaveBeenCalledOnce();
    await act(async () => {
      host.setTitle("New baseline");
      host.emit(host.event(2, "resync-required"));
    });
    expect(host.view.result.current.sessions[0].title).toBe("New baseline");
    const currentReads = reads.mock.calls.length;
    await act(async () => {
      obsolete.resolve({ indexEnabled: true, sessions: [] });
      for (const listener of host.retiredListeners)
        listener(host.event(99, "invalidate", "catalog-1"));
      host.emit(host.event(100, "invalidate", "catalog-1"));
    });
    expect(reads).toHaveBeenCalledTimes(currentReads);
    expect(host.view.result.current.sessions[0].title).toBe("New baseline");
    expect(host.bridge.subscribe).toHaveBeenCalledTimes(2);
  });

  it("ignores an old stream's access response while its replacement subscription is pending", async () => {
    const host = fixture();
    await ready(host);
    const obsolete = deferred<Access>();
    const subscription = deferred<void>();
    const accepted = host.view.result.current.access!;
    vi.spyOn(host.client, "access").mockReturnValueOnce(obsolete.promise);
    const subscribe = vi.mocked(host.bridge.subscribe).getMockImplementation()!;
    vi.mocked(host.bridge.subscribe).mockImplementationOnce(async (...args) => {
      await subscription.promise;
      return subscribe(...args);
    });
    await act(async () => host.invalidate());
    await act(async () => host.emit(host.event(2, "resync-required")));
    expect(host.bridge.subscribe).toHaveBeenCalledTimes(2);
    await act(async () => obsolete.resolve({ ...accepted, status: "ended" }));
    expect(host.view.result.current.access?.status).toBe("approved");
    expect(host.view.result.current.sessions[0].title).toBe("Initial catalog");
    await act(async () => {
      host.setTitle("Replacement accepted");
      subscription.resolve();
    });
    expect(host.view.result.current.sessions[0].title).toBe("Replacement accepted");
    expect(host.bridge.acknowledge).toHaveBeenLastCalledWith("catalog-2", "catalog-2:epoch:0");
  });

  it("resets the consecutive failure limit after each applied baseline and matching readiness", async () => {
    const host = fixture();
    await ready(host);
    for (let count = 1; count <= 5; count++) {
      await act(async () => {
        host.setTitle(`Recovery ${count}`);
        host.emit(host.event(1, "resync-required"));
      });
      expect(host.view.result.current.sessions[0].title).toBe(`Recovery ${count}`);
      expect(host.view.result.current.error).toBe(false);
      expect(host.bridge.subscribe).toHaveBeenCalledTimes(count + 1);
      expect(host.bridge.unsubscribe).toHaveBeenCalledTimes(count);
    }
  });

  it("finishes a full refresh whose newer access read belonged to a discarded stream", async () => {
    const host = fixture();
    await ready(host);
    const refreshingAccess = deferred<Access>();
    const obsolete = deferred<Access>();
    const subscription = deferred<void>();
    const accepted = host.view.result.current.access!;
    vi.spyOn(host.client, "access")
      .mockReturnValueOnce(refreshingAccess.promise)
      .mockReturnValueOnce(obsolete.promise);
    const reads = vi.spyOn(host.client, "catalog");
    const subscribe = vi.mocked(host.bridge.subscribe).getMockImplementation()!;
    vi.mocked(host.bridge.subscribe).mockImplementationOnce(async (...args) => {
      await subscription.promise;
      return subscribe(...args);
    });
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = host.view.result.current.refresh();
      host.invalidate();
    });
    await act(async () => host.emit(host.event(2, "resync-required")));
    await act(async () => {
      refreshingAccess.resolve(accepted);
      await Promise.resolve();
      obsolete.resolve(accepted);
      await refreshing;
    });
    expect(reads).toHaveBeenCalledOnce();
    await act(async () => subscription.resolve());
    expect(host.view.result.current.error).toBe(false);
  });

  it("bounds failed baseline recoveries and restarts observation only on explicit refresh", async () => {
    const host = fixture(true);
    await waitFor(() => expect(host.view.result.current.error).toBe(true));
    expect(host.bridge.subscribe).toHaveBeenCalledTimes(4);
    expect(host.bridge.unsubscribe).toHaveBeenCalledTimes(4);
    expect(host.pending.size).toBe(0);
    host.validBootstrap();
    await act(async () => {
      await host.view.result.current.refresh();
      for (const listener of host.retiredListeners) listener(host.event(2));
    });
    expect(host.bridge.subscribe).toHaveBeenCalledTimes(4);
    expect(host.view.result.current.error).toBe(true);
    await act(async () => {
      host.setTitle("Explicit recovery");
      await host.view.result.current.refresh(true);
    });
    expect(host.bridge.subscribe).toHaveBeenCalledTimes(5);
    expect(host.view.result.current.error).toBe(false);
    expect(host.view.result.current.sessions[0].title).toBe("Explicit recovery");
    await act(async () => {
      host.setTitle("Observation resumed");
      host.invalidate();
    });
    expect(host.view.result.current.sessions[0].title).toBe("Observation resumed");
    expect(vi.mocked(host.bridge.request).mock.calls.every(([, body]) => body === undefined)).toBe(
      true,
    );
  });

  it.each(["revoke", "unmount"])(
    "ignores closed-stream events and pending reads after %s",
    async (ending) => {
      const host = fixture();
      await ready(host);
      const obsolete = deferred<Awaited<ReturnType<WebClient["catalog"]>>>();
      const reads = vi.spyOn(host.client, "catalog").mockReturnValueOnce(obsolete.promise);
      await act(async () => host.invalidate());
      if (ending === "revoke") {
        host.revoke();
        await act(async () => host.view.result.current.refresh());
        expect(host.view.result.current.access?.status).toBe("ended");
        expect(host.view.result.current.sessions).toEqual([]);
      } else host.view.unmount();
      await act(async () => {
        obsolete.resolve({ indexEnabled: true, sessions: [] });
        for (const listener of host.retiredListeners) listener(host.event(2, "resync-required"));
        host.controlChanged();
        host.unavailable();
      });
      expect(reads).toHaveBeenCalledOnce();
      expect(host.bridge.subscribe).toHaveBeenCalledOnce();
      expect(host.bridge.unsubscribe).toHaveBeenCalledOnce();
    },
  );

  it("cancels an already queued resubscription when the controller unmounts", async () => {
    const host = fixture();
    await ready(host);
    await act(async () => {
      host.emit(host.event(1, "resync-required"));
      host.view.unmount();
    });
    expect(host.bridge.subscribe).toHaveBeenCalledOnce();
    expect(host.bridge.unsubscribe).toHaveBeenCalledOnce();
  });
});
