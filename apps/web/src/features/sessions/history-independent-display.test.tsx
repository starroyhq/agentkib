// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebClient,
  type ConversationClientBridge,
  type ConversationEventPage,
  type Live,
  type SessionStreamHandlers,
} from "@agentkib/web-client";
import { useSessionController } from "@/features/conversation/features/sessions/use-session-controller";

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const page = (text: string, id = text): ConversationEventPage => ({
  events: [{ id, kind: "agent-message", content: text, attachment_count: 0, truncated: false }],
  warnings: [],
});
const live = (sessionId = "first", revision = 1): Live => ({
  sessionId,
  revision,
  status: "idle",
  executionMode: "claude-managed",
  sendEnabled: true,
  approvals: [],
  questions: [],
});

async function fixture() {
  const streams = new Map<string, SessionStreamHandlers>();
  const bridge: ConversationClientBridge = {
    async request<Result>(path: string) {
      const operation = path.split("?")[0];
      const id = new URLSearchParams(path.split("?")[1]).get("sessionId") ?? "";
      const result =
        operation === "access"
          ? {
              status: "approved",
              protocolVersion: 2,
              csrfToken: "synthetic",
              bootId: "boot",
              experimentalEnabled: true,
              device: { id: "test", send: true, approve: true, manage: true },
            }
          : operation === "catalog"
            ? {
                indexEnabled: true,
                sessions: ["first", "second"].map((id) => ({
                  id,
                  agent: "claude-code",
                  workspace_id: "workspace",
                  availability: "readable",
                  archived: false,
                  sidechain: false,
                })),
              }
            : operation === "events"
              ? page(`${id} history`)
              : operation === "live"
                ? live(id)
                : {};
      return result as Result;
    },
    stream(id, handlers) {
      streams.set(id, handlers);
      return () => {};
    },
    uploadAttachment: vi.fn(),
  };
  const client = new WebClient(undefined, { type: "same-origin" }, bridge);
  const view = renderHook(() => useSessionController({ client, embedded: true }));
  await waitFor(() => expect(view.result.current.sessions).toHaveLength(2));
  const emit = (seq: number, type = "snapshot", payload: unknown = { live: live() }) =>
    act(() => {
      streams.get("first")!.event(
        "session-event",
        JSON.stringify({
          protocolVersion: 2,
          subscriptionId: "first",
          sessionId: "first",
          runtimeBootId: "runtime",
          epoch: "epoch",
          seq,
          cursor: `cursor-${seq}`,
          type,
          payload,
        }),
      );
    });
  return { client, ...view, emit };
}

describe("independent history display", () => {
  it("displays initial history while live checks are pending and keeps controls fenced", async () => {
    const host = await fixture();
    const pending = deferred<Live>();
    vi.spyOn(host.client, "live").mockReturnValueOnce(pending.promise);
    let opening!: Promise<void>;
    act(() => {
      opening = host.result.current.choose("first");
    });
    await waitFor(() => expect(host.result.current.page?.events[0].content).toBe("first history"));
    expect(host.result.current.live).toBeUndefined();
    expect(host.result.current.canSend).toBe(false);
    await act(async () => {
      pending.resolve(live());
      await opening;
    });
    expect(host.result.current.canSend).toBe(false);
    host.emit(0);
    expect(host.result.current.canSend).toBe(true);
  });

  it("keeps a 20 ms history display independent from a 2 s ownership check", async () => {
    const host = await fixture();
    vi.useFakeTimers();
    vi.spyOn(host.client, "events").mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(page("Fast history")), 20)),
    );
    vi.spyOn(host.client, "live").mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(live()), 2_000)),
    );
    let completed = false;
    let opening!: Promise<void>;
    const startedAt = Date.now();
    await act(async () => {
      opening = host.result.current.choose("first").then(() => {
        completed = true;
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(host.result.current.page?.events[0].content).toBe("Fast history");
    expect(Date.now() - startedAt).toBe(20);
    expect(completed).toBe(false);
    expect(host.result.current.canSend).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_980);
      await opening;
    });
    expect(completed).toBe(true);
    expect(host.result.current.page?.events[0].content).toBe("Fast history");
  });

  it("reopens a recently viewed session from cache instead of clearing to a spinner", async () => {
    const host = await fixture();
    const events = vi.spyOn(host.client, "events");
    await act(async () => void (await host.result.current.choose("first")));
    await waitFor(() => expect(host.result.current.page?.events[0].content).toBe("first history"));
    await act(async () => void (await host.result.current.choose("second")));
    await waitFor(() => expect(host.result.current.page?.events[0].content).toBe("second history"));
    const readsBeforeReopen = events.mock.calls.length;

    // Reopening "first" shows its cached transcript synchronously; it never clears to undefined
    // (which is what renders the loading spinner).
    const revalidation = deferred<ConversationEventPage>();
    events.mockReturnValueOnce(revalidation.promise);
    let reopening!: Promise<void>;
    act(() => {
      reopening = host.result.current.choose("first");
    });
    expect(host.result.current.page?.events[0].content).toBe("first history");

    // It still reads fresh history in the background rather than trusting the cache forever.
    await waitFor(() => expect(events.mock.calls.length).toBeGreaterThan(readsBeforeReopen));
    await act(async () => {
      revalidation.resolve(page("first history", "first history"));
      await reopening;
    });
    expect(host.result.current.page?.events[0].content).toBe("first history");
  });

  it.each(["choose", "refresh"] as const)(
    "keeps readable history when %s live checks fail before history completes",
    async (operation) => {
      const host = await fixture();
      if (operation === "refresh") await act(async () => host.result.current.choose("first"));
      const pending = deferred<ConversationEventPage>();
      vi.spyOn(host.client, "events").mockReturnValueOnce(pending.promise);
      vi.spyOn(host.client, "live").mockRejectedValueOnce(new Error("ownership check failed"));
      await act(async () =>
        operation === "choose"
          ? host.result.current.choose("first")
          : host.result.current.refresh(),
      );
      expect(host.result.current.error).toBe(true);
      await act(async () => pending.resolve(page("Readable despite unavailable live state")));
      expect(host.result.current.page?.events[0].content).toBe(
        "Readable despite unavailable live state",
      );
      expect(host.result.current.error).toBe(true);
      expect(host.result.current.canSend).toBe(false);
    },
  );

  it("displays refreshed history before live checks settle without releasing refresh controls", async () => {
    const host = await fixture();
    await act(async () => host.result.current.choose("first"));
    host.emit(0);
    expect(host.result.current.canSend).toBe(true);
    const pending = deferred<Live>();
    vi.spyOn(host.client, "live").mockReturnValueOnce(pending.promise);
    vi.spyOn(host.client, "events").mockResolvedValueOnce(page("Refreshed history"));
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = host.result.current.refresh();
    });
    await waitFor(() =>
      expect(host.result.current.page?.events[0].content).toBe("Refreshed history"),
    );
    expect(host.result.current.canSend).toBe(false);
    host.emit(1, "state", { revision: 2 });
    expect(host.result.current.canSend).toBe(false);
    await act(async () => {
      pending.resolve(live());
      await refreshing;
    });
    expect(host.result.current.live?.revision).toBe(2);
    expect(host.result.current.canSend).toBe(true);
  });

  it("does not replace the new session with a late history response", async () => {
    const host = await fixture();
    const pending = deferred<ConversationEventPage>();
    const events = vi.spyOn(host.client, "events").mockReturnValueOnce(pending.promise);
    let opening!: Promise<void>;
    act(() => {
      opening = host.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    await act(async () => host.result.current.choose("second"));
    await act(async () => {
      pending.resolve(page("Obsolete first history"));
      await opening;
    });
    expect(host.result.current.selected).toBe("second");
    expect(host.result.current.page?.events[0].content).toBe("second history");
  });

  it("retains the error and empty reader when initial history fails", async () => {
    const host = await fixture();
    vi.spyOn(host.client, "events").mockRejectedValueOnce(new Error("history unavailable"));
    await act(async () => host.result.current.choose("first"));
    expect(host.result.current.page).toBeUndefined();
    expect(host.result.current.error).toBe(true);
    expect(host.result.current.canSend).toBe(false);
  });

  it("does not let an older initial history overwrite a newer refresh projection", async () => {
    const host = await fixture();
    const pending = deferred<ConversationEventPage>();
    const events = vi.spyOn(host.client, "events").mockReturnValueOnce(pending.promise);
    let opening!: Promise<void>;
    act(() => {
      opening = host.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    events.mockResolvedValueOnce({
      ...page("Newer refresh history", "shared"),
      next_cursor: "newer-cursor",
    });
    await act(async () => host.result.current.refresh());
    await act(async () => {
      pending.resolve(page("Obsolete initial history", "shared"));
      await opening;
    });
    expect(host.result.current.page?.events.map((event) => event.content)).toEqual([
      "Newer refresh history",
    ]);
    expect(host.result.current.page?.next_cursor).toBe("newer-cursor");
  });

  it("does not let an older initial history overwrite stream-invalidated history", async () => {
    const host = await fixture();
    const pending = deferred<ConversationEventPage>();
    const events = vi.spyOn(host.client, "events").mockReturnValueOnce(pending.promise);
    let opening!: Promise<void>;
    act(() => {
      opening = host.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    host.emit(0);
    events.mockResolvedValueOnce({
      ...page("Native updated history", "shared"),
      next_cursor: "native-cursor",
    });
    host.emit(1, "invalidate", { domains: ["history"] });
    await waitFor(() =>
      expect(host.result.current.page?.events[0].content).toBe("Native updated history"),
    );
    await act(async () => {
      pending.resolve(page("Obsolete initial history", "shared"));
      await opening;
    });
    expect(host.result.current.page?.events.map((event) => event.content)).toEqual([
      "Native updated history",
    ]);
    expect(host.result.current.page?.next_cursor).toBe("native-cursor");
  });

  it("does not restore a pre-reset history after the stream replaces its cache epoch", async () => {
    const host = await fixture();
    const pending = deferred<ConversationEventPage>();
    const events = vi.spyOn(host.client, "events").mockReturnValueOnce(pending.promise);
    let opening!: Promise<void>;
    act(() => {
      opening = host.result.current.choose("first");
    });
    await waitFor(() => expect(events).toHaveBeenCalledOnce());
    host.emit(0, "snapshot", { live: live(), items: [], historyCacheEpoch: "replacement" });
    await waitFor(() => expect(host.result.current.page?.events[0].content).toBe("first history"));
    await act(async () => {
      pending.resolve(page("Deleted cache rows"));
      await opening;
    });
    expect(host.result.current.page?.events.map((event) => event.content)).toEqual([
      "first history",
    ]);
  });
});
