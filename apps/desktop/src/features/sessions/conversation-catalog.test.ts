// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionStreamEvent } from "@agentkib/conversation-state";
import type { Live } from "@agentkib/web-client";
import type {
  DesktopConversationBridge,
  DesktopConversationResponse,
} from "@/core/conversation-bridge";
import { refreshConversationCatalog, useConversationCatalog } from "./conversation-catalog";

function catalog(id: string): DesktopConversationResponse {
  return {
    status: 200,
    body: {
      workspaces: [],
      sessions: [
        {
          id,
          workspace_id: "workspace",
          agent: "codex",
          title: id,
          availability: "readable",
          archived: false,
          sidechain: false,
        },
      ],
    },
  };
}

function fixture() {
  let receive = (_event: SessionStreamEvent<Live>) => {};
  let controlChanged = (_sessionId: string) => {};
  const bridge: DesktopConversationBridge = {
    request: vi.fn(async () => catalog("initial")),
    upload: vi.fn(async () => ({ status: 400, body: {} })),
    subscribe: vi.fn(async () => ({
      subscriptionId: "catalog",
      cursor: "epoch:0",
      events: [
        {
          protocolVersion: 2 as const,
          sessionId: "",
          subscriptionId: "catalog",
          runtimeBootId: "boot",
          epoch: "epoch",
          seq: 0,
          cursor: "epoch:0",
          type: "snapshot" as const,
          payload: {
            live: { sessionId: "", status: "idle", revision: 0, sendEnabled: false, approvals: [] },
          },
        },
      ],
    })),
    acknowledge: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
    onEvent: (listener) => {
      receive = listener;
      return () => {
        receive = () => {};
      };
    },
    onUnavailable: () => () => {},
    onControlChanged: (listener) => {
      controlChanged = listener;
      return () => {
        controlChanged = () => {};
      };
    },
  };
  window.desktopConversation = bridge;
  return {
    bridge,
    emit: (event: SessionStreamEvent<Live>) => receive(event),
    settled: () => controlChanged("session"),
  };
}

afterEach(() => {
  cleanup();
  delete window.desktopConversation;
});

describe("desktop conversation catalog", () => {
  it("keeps the catalog's verified global CLI floor alongside its controlled rows", async () => {
    const { bridge } = fixture();
    vi.mocked(bridge.request).mockResolvedValue({
      ...catalog("initial"),
      body: {
        ...(catalog("initial").body as object),
        codexRuntimeReason: "codex-cli-version-too-old",
      },
    });
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() =>
      expect(view.result.current.codexRuntimeReason).toBe("codex-cli-version-too-old"),
    );
  });

  it("silently retries bounded read contention without replacing the loaded catalog", async () => {
    const { bridge } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("initial"));
    vi.mocked(bridge.request)
      .mockResolvedValueOnce({ status: 409, body: { error: "operation_busy" } })
      .mockResolvedValueOnce(catalog("recovered"));
    await act(async () => {
      await refreshConversationCatalog();
    });
    expect(view.result.current.error).toBeUndefined();
    expect(view.result.current.sessions[0]?.id).toBe("recovered");
  });

  it("stops after three busy reads and retains the previous rows", async () => {
    const { bridge } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("initial"));
    const reads = vi.mocked(bridge.request).mock.calls.length;
    vi.mocked(bridge.request).mockResolvedValue({ status: 409, body: { error: "operation_busy" } });
    await act(async () => {
      await expect(refreshConversationCatalog()).rejects.toMatchObject({ code: "operation_busy" });
    });
    expect(bridge.request).toHaveBeenCalledTimes(reads + 3);
    expect(view.result.current.sessions[0]?.id).toBe("initial");
    expect(view.result.current.ready).toBe(true);
    expect(view.result.current.error).toBeUndefined();
  });
  it.each(["control", "catalog"] as const)(
    "waits for %s settlement after exhausted contention without pretending the initial catalog is ready",
    async (source) => {
      const { bridge, settled, emit } = fixture();
      vi.mocked(bridge.request).mockResolvedValue({
        status: 409,
        body: { error: "operation_busy" },
      });
      const view = renderHook(() => useConversationCatalog(true));
      await act(async () => {
        await expect(refreshConversationCatalog()).rejects.toMatchObject({
          code: "operation_busy",
        });
      });
      const reads = vi.mocked(bridge.request).mock.calls.length;
      expect(view.result.current.ready).toBe(false);
      expect(view.result.current.error).toBeUndefined();
      expect(view.result.current.sessions).toEqual([]);
      await act(async () => {});
      expect(bridge.request).toHaveBeenCalledTimes(reads);
      vi.mocked(bridge.request).mockResolvedValue(catalog("settled"));
      act(() => {
        if (source === "control") settled();
        else
          emit({
            protocolVersion: 2,
            sessionId: "",
            subscriptionId: "catalog",
            runtimeBootId: "boot",
            epoch: "epoch",
            seq: 1,
            cursor: "epoch:1",
            type: "invalidate",
            payload: { domains: ["catalog"] },
          });
      });
      await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("settled"));
      expect(view.result.current.ready).toBe(true);
      expect(view.result.current.error).toBeUndefined();
      expect(bridge.request).toHaveBeenCalledTimes(reads + 1);
      act(() => settled());
      expect(bridge.request).toHaveBeenCalledTimes(reads + 1);
    },
  );

  it("does not lose settlement delivered before the final busy response", async () => {
    const { bridge, settled } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("initial"));
    const reads = vi.mocked(bridge.request).mock.calls.length;
    let reject!: (error: Error) => void;
    vi.mocked(bridge.request)
      .mockResolvedValueOnce({ status: 409, body: { error: "operation_busy" } })
      .mockResolvedValueOnce({ status: 409, body: { error: "operation_busy" } })
      .mockReturnValueOnce(new Promise((_resolve, fail) => (reject = fail)))
      .mockResolvedValue(catalog("settled-before-response"));
    const refresh = refreshConversationCatalog();
    void refresh.catch(() => {});
    await waitFor(() => expect(bridge.request).toHaveBeenCalledTimes(reads + 3));
    await act(async () => {
      settled();
      reject(new Error("operation_busy"));
      await refresh;
    });
    expect(view.result.current.sessions[0]?.id).toBe("settled-before-response");
    expect(view.result.current.error).toBeUndefined();
  });

  it("keeps a real catalog failure visible when a later read only encounters contention", async () => {
    const { bridge } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("initial"));
    const failure = new Error("catalog storage unavailable");
    vi.mocked(bridge.request).mockRejectedValueOnce(failure);
    await act(async () => {
      await expect(refreshConversationCatalog()).rejects.toBe(failure);
    });
    expect(view.result.current.error).toBe(failure);
    vi.mocked(bridge.request).mockResolvedValue({ status: 409, body: { error: "operation_busy" } });
    await act(async () => {
      await expect(refreshConversationCatalog()).rejects.toMatchObject({ code: "operation_busy" });
    });
    expect(view.result.current.error).toBe(failure);
    expect(view.result.current.sessions[0]?.id).toBe("initial");
  });
  it("shares one observation across consumers and keeps it alive when another consumer is disabled", async () => {
    const { bridge, emit } = fixture();
    const first = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(first.result.current.sessions[0]?.id).toBe("initial"));
    const second = renderHook(({ enabled }) => useConversationCatalog(enabled), {
      initialProps: { enabled: true },
    });
    const disabled = renderHook(() => useConversationCatalog(false));
    await waitFor(() => expect(second.result.current.sessions[0]?.id).toBe("initial"));
    expect(bridge.subscribe).toHaveBeenCalledTimes(1);
    expect(disabled.result.current.sessions).toEqual([]);
    first.unmount();
    expect(bridge.unsubscribe).not.toHaveBeenCalled();
    vi.mocked(bridge.request).mockResolvedValue(catalog("updated"));
    act(() =>
      emit({
        protocolVersion: 2,
        sessionId: "",
        subscriptionId: "catalog",
        runtimeBootId: "boot",
        epoch: "epoch",
        seq: 1,
        cursor: "epoch:1",
        type: "invalidate",
        payload: { domains: ["catalog"] },
      }),
    );
    await waitFor(() => expect(second.result.current.sessions[0]?.id).toBe("updated"));
    second.rerender({ enabled: false });
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(1);
    second.rerender({ enabled: true });
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(2));
    disabled.unmount();
    expect(second.result.current.sessions[0]?.id).toBe("updated");
  });

  it("normalizes Claude's verified history alias for desktop links and continuation", async () => {
    const { bridge } = fixture();
    vi.mocked(bridge.request).mockResolvedValue({
      status: 200,
      body: {
        sessions: [
          {
            id: "managed-claude",
            indexedSessionId: "indexed-claude",
            workspace_id: "workspace",
            agent: "claude-code",
            availability: "readable",
            archived: false,
            sidechain: false,
          },
        ],
      },
    });
    expect(await refreshConversationCatalog()).toEqual([
      expect.objectContaining({
        id: "managed-claude",
        indexedSessionIds: ["indexed-claude"],
      }),
    ]);
  });

  it("keeps transport errors visible across successful reads until the stream recovers", async () => {
    const { bridge } = fixture();
    const disconnected = new Error("runtime_unavailable");
    vi.mocked(bridge.subscribe).mockRejectedValueOnce(disconnected);
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.error).toBe(disconnected));
    await act(async () => {
      await refreshConversationCatalog();
    });
    expect(view.result.current.error).toBe(disconnected);
    await waitFor(() => expect(view.result.current.error).toBeUndefined());
    expect(bridge.subscribe).toHaveBeenCalledTimes(2);
  });

  it("reports exhausted recovery and reconnects on explicit refresh without remounting", async () => {
    const { bridge, emit } = fixture();
    const successful = await bridge.subscribe("", undefined);
    vi.mocked(bridge.subscribe)
      .mockClear()
      .mockResolvedValue({
        ...successful,
        events: [
          { ...successful.events[0], type: "resync-required", payload: { reason: "overflow" } },
        ],
      });
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.error).toBeInstanceOf(Error));
    expect(bridge.subscribe).toHaveBeenCalledTimes(4);
    expect(view.result.current.sessions[0]?.id).toBe("initial");
    expect(bridge.unsubscribe).toHaveBeenCalledTimes(4);

    // The fetch succeeds before the new baseline. It must not hide the broken stream.
    let baseline!: (value: typeof successful) => void;
    vi.mocked(bridge.subscribe).mockReturnValueOnce(new Promise((done) => (baseline = done)));
    vi.mocked(bridge.request).mockResolvedValue(catalog("refreshed"));
    await act(async () => {
      await refreshConversationCatalog();
    });
    expect(bridge.subscribe).toHaveBeenCalledTimes(5);
    expect(view.result.current.sessions[0]?.id).toBe("refreshed");
    expect(view.result.current.error).toBeInstanceOf(Error);
    await act(async () => baseline(successful));
    await waitFor(() => expect(view.result.current.error).toBeUndefined());

    vi.mocked(bridge.request).mockResolvedValue(catalog("live-again"));
    act(() =>
      emit({
        ...successful.events[0],
        seq: 1,
        cursor: "epoch:1",
        type: "invalidate",
        payload: { domains: ["catalog"] },
      }),
    );
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("live-again"));
    view.unmount();
    await refreshConversationCatalog();
    expect(bridge.subscribe).toHaveBeenCalledTimes(5);
  });

  it("subscribes to catalog invalidations even with no open live conversation", async () => {
    const { bridge, emit } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("initial"));
    expect(bridge.subscribe).toHaveBeenCalledWith("", undefined);
    vi.mocked(bridge.request).mockResolvedValue(catalog("created"));
    act(() =>
      emit({
        protocolVersion: 2,
        sessionId: "",
        subscriptionId: "catalog",
        runtimeBootId: "boot",
        epoch: "epoch",
        seq: 1,
        cursor: "epoch:1",
        type: "invalidate",
        payload: { domains: ["catalog"] },
      }),
    );
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("created"));
    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledWith("catalog");
  });

  it("does not lose a mutation refresh that arrives during an older catalog request", async () => {
    const { bridge } = fixture();
    let resolve!: (response: DesktopConversationResponse) => void;
    vi.mocked(bridge.request).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    vi.mocked(bridge.request).mockResolvedValue(catalog("after-fork"));
    const old = refreshConversationCatalog();
    const afterFork = refreshConversationCatalog();
    resolve(catalog("before-fork"));
    expect((await afterFork)[0].id).toBe("after-fork");
    expect((await old)[0].id).toBe("after-fork");
    expect(bridge.request).toHaveBeenCalledTimes(2);
  });

  it("allows later independent gaps after successful baseline recovery", async () => {
    const { bridge, emit } = fixture();
    const view = renderHook(() => useConversationCatalog(true));
    await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(1));
    for (let attempt = 1; attempt <= 5; attempt++) {
      await act(async () => {
        emit({
          protocolVersion: 2,
          sessionId: "",
          subscriptionId: "catalog",
          runtimeBootId: "boot",
          epoch: "epoch",
          seq: 2,
          cursor: "epoch:2",
          type: "invalidate",
          payload: { domains: ["catalog"] },
        });
      });
      await waitFor(() => expect(bridge.subscribe).toHaveBeenCalledTimes(attempt + 1));
    }
    vi.mocked(bridge.request).mockResolvedValue(catalog("recovered"));
    await act(async () => {
      emit({
        protocolVersion: 2,
        sessionId: "",
        subscriptionId: "catalog",
        runtimeBootId: "boot",
        epoch: "epoch",
        seq: 1,
        cursor: "epoch:1",
        type: "invalidate",
        payload: { domains: ["catalog"] },
      });
    });
    await waitFor(() => expect(view.result.current.sessions[0]?.id).toBe("recovered"));
  });
});

it("clears account read cursors immediately and refuses an old catalog after switching account", async () => {
  const originalApi = window.agentkibDesktop;
  const profile = (id: string) => ({
    phase: "signed-in" as const,
    secureStorage: true,
    account: {
      id,
      username: id,
      status: "active",
      deviceLimit: 3,
      deviceCount: 1,
      totpEnabled: false,
    },
  });
  let status = profile("account-a");
  let receive!: (
    value: ReturnType<typeof profile> | { phase: "signing-in"; secureStorage: boolean },
  ) => void;
  Object.defineProperty(window, "agentkibDesktop", {
    configurable: true,
    value: {
      ...originalApi,
      account: {
        request: async () => status,
        onStatus: (listener: typeof receive) => {
          receive = listener;
          return () => {};
        },
      },
    },
  });
  const { bridge } = fixture();
  const response = (version: string): DesktopConversationResponse => ({
    status: 200,
    body: {
      workspaces: [],
      sessions: [
        {
          id: "s",
          workspace_id: "w",
          agent: "codex",
          title: "Same session",
          availability: "readable",
          archived: false,
          sidechain: false,
          readState: {
            source: "agentkib",
            status: "unread",
            freshness: "current",
            version,
            firstUnread: { type: "threadStart" },
            latestResult: null,
          },
        },
      ],
    },
  });
  vi.mocked(bridge.request).mockImplementation(async () => response(status.account.id));
  const view = renderHook(() => useConversationCatalog(true));
  try {
    await waitFor(() =>
      expect(view.result.current.sessions[0]?.readState?.version).toBe("account-a"),
    );
    let finish!: (value: DesktopConversationResponse) => void;
    vi.mocked(bridge.request).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let prior!: Promise<unknown>;
    act(() => {
      prior = refreshConversationCatalog();
    });
    act(() => receive({ phase: "signing-in", secureStorage: true }));
    expect(view.result.current.sessions[0]?.readState).toBeUndefined();
    act(() => {
      status = profile("account-b");
      receive(status);
    });
    await waitFor(() =>
      expect(view.result.current.sessions[0]?.readState?.version).toBe("account-b"),
    );
    await act(async () => {
      finish(response("account-a-late"));
      await prior;
    });
    expect(view.result.current.sessions[0]?.readState?.version).toBe("account-b");
  } finally {
    view.unmount();
    Object.defineProperty(window, "agentkibDesktop", { configurable: true, value: originalApi });
  }
});
