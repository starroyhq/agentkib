import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PendingReviewLane,
  pendingReviewSessions,
  readSnapshotMatches,
  requestReadReview,
  requestReadStateRefresh,
  sessionContinuationListState,
  SessionContinuationDot,
  useVisibleReadState,
  type SessionReadState,
} from "@agentkib/session-ui";
import {
  ApiError,
  ReadStateReconciliationError,
  WebClient,
  type ConversationEvent,
} from "@agentkib/web-client";

type FixtureEvent = Omit<ConversationEvent, "kind"> & { kind: string };

const event = {
  id: "answer",
  kind: "agent-message",
  turn_id: "turn",
  content: "Fresh answer",
  attachment_count: 0,
  truncated: false,
};
const events = [event];
const unread = (extra: Partial<SessionReadState> = {}): SessionReadState => ({
  source: "codex-native",
  status: "unread",
  freshness: "current",
  version: "native:revision-1",
  firstUnread: { type: "result", resultId: "result", turnId: "turn" },
  latestResult: {
    id: "result",
    turnId: "turn",
    itemId: "answer",
    outcome: "completed",
    completedAt: null,
  },
  ...extra,
});
function fixture(state = unread(), fresh: FixtureEvent[] = events) {
  return {
    events: vi.fn(async () => ({ events: fresh, warnings: [] })),
    readState: vi.fn(async () => ({ readState: state })),
    acknowledgeReadState: vi.fn(
      async (): Promise<{
        readState: SessionReadState;
        acknowledged: boolean;
        conflict?: true;
      }> => ({
        readState: { ...state, status: "read" as const },
        acknowledged: true,
      }),
    ),
  };
}
type Client = ReturnType<typeof fixture>;
function Probe({
  client,
  id = "session",
  scope = "owner-a",
  rows = events,
  supported = true,
  blocked = false,
  source = "codex-native",
  ready = true,
  catalogVersion,
  imagePending = false,
  folded,
  activeTurnId,
  subscribe,
  onAcknowledged,
}: {
  client: Client;
  id?: string;
  scope?: string;
  rows?: FixtureEvent[];
  supported?: boolean;
  blocked?: boolean;
  source?: SessionReadState["source"];
  ready?: boolean;
  catalogVersion?: string;
  imagePending?: boolean | string;
  folded?: boolean;
  activeTurnId?: string;
  subscribe?: Parameters<typeof useVisibleReadState>[0]["subscribe"];
  onAcknowledged?: Parameters<typeof useVisibleReadState>[0]["onAcknowledged"];
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const observed = useVisibleReadState({
    client,
    sessionId: id,
    scope,
    supported,
    ready,
    blocked,
    source,
    catalogVersion,
    activeTurnId,
    events: rows,
    viewportRef: viewport,
    subscribe,
    onAcknowledged,
  });
  return (
    <div data-testid="viewport" ref={viewport}>
      <output data-testid="read-observation">
        {observed.readState?.status}:{observed.readState?.version}
      </output>
      {!folded &&
        rows.map((row) => (
          <article data-event-id={row.id} key={row.id}>
            {row.content}
            <span
              data-message-image-pending={
                (typeof imagePending === "string" ? row.id === imagePending : imagePending) ||
                undefined
              }
            />
          </article>
        ))}
      {folded && (
        <p data-terminal-turn-id="turn" data-terminal-outcome="aborted">
          Interrupted
        </p>
      )}
      {!folded && observed.events && (
        <p data-read-result={observed.readState?.latestResult?.id ?? "threadStart"}>Result</p>
      )}
    </div>
  );
}
let atBottom = true;
const rect = (top: number, bottom: number) => ({
  x: 0,
  y: top,
  left: 0,
  top,
  right: 400,
  bottom,
  width: 400,
  height: bottom - top,
  toJSON() {},
});
async function advanceReadClock(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function settle() {
  for (let n = 0; n < 5; n++) await advanceReadClock(120);
}
beforeEach(() => {
  vi.useFakeTimers();
  atBottom = true;
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1_200);
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(() =>
    atBottom ? 600 : 0,
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("visible result read acknowledgements", () => {
  it.each([
    { status: "read", firstUnread: null },
    { status: "unknown" },
    { freshness: "stale" },
  ] satisfies Partial<SessionReadState>[])(
    "reads only metadata when the state does not require a transcript proof (%j)",
    async (state) => {
      const client = fixture(unread(state));
      render(<Probe client={client} />);
      await advanceReadClock(160);
      expect(screen.getByTestId("read-observation")).toHaveTextContent("native:revision-1");
      expect(client.readState).toHaveBeenCalledTimes(1);
      expect(client.events).not.toHaveBeenCalled();
      expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge a reported ending for the current running turn", async () => {
    const client = fixture();
    const view = render(<Probe client={client} activeTurnId="turn" />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();

    view.rerender(<Probe client={client} activeTurnId="new-turn" />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
  });

  it("does not acknowledge a cancellation with no observed terminal or end time", async () => {
    const client = fixture(
      unread({ latestResult: { ...unread().latestResult!, outcome: "cancelled" } }),
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector("[data-read-result]"),
    });
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
  });

  it("uses the exact native message to locate a managed Claude result", async () => {
    const rows = [{ ...event, turn_id: null }];
    const client = fixture(
      unread({
        source: "agentkib",
        latestResult: { ...unread().latestResult!, turnId: "managed-turn", outcome: "ended" },
      }),
      rows,
    );
    render(<Probe client={client} rows={rows} source="agentkib" />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
  });

  it("acknowledges an interrupted turn only at the end of the transcript", async () => {
    const rows = [
      event,
      {
        ...event,
        id: "codex-turn-end:turn",
        content: "",
        turn_meta: { outcome: "aborted" as const },
      },
    ];
    const client = fixture(
      unread({ latestResult: { ...unread().latestResult!, outcome: "cancelled" } }),
      rows,
    );
    atBottom = false;
    render(<Probe client={client} rows={rows} folded />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    atBottom = true;
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
  });

  it("waits for an image-only result to display successfully before acknowledging it", async () => {
    const rows = [{ ...event, content: "", attachment_count: 1 }];
    const client = fixture(unread(), rows);
    const view = render(<Probe client={client} rows={rows} imagePending />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    // Removing the loading/failure marker must wake observation without a scroll.
    view.rerender(<Probe client={client} rows={rows} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
  });
  it("does not acknowledge above the bottom; scrolling to the bottom acknowledges that result once", async () => {
    const client = fixture();
    atBottom = false;
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    atBottom = true;
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
  });
  it("coalesces repeated scrolling into viewport checks and reuses the in-flight reading proof", async () => {
    atBottom = false;
    const client = fixture();
    let finishRead!: (value: { readState: SessionReadState }) => void;
    let firstSignal: AbortSignal | undefined;
    client.readState.mockImplementationOnce((_id?: string, signal?: AbortSignal) => {
      firstSignal = signal;
      return new Promise((resolve) => {
        finishRead = resolve;
      });
    });
    render(<Probe client={client} />);
    await advanceReadClock(160);
    expect(client.readState).toHaveBeenCalledOnce();

    const viewport = screen.getByTestId("viewport");
    for (let index = 0; index < 8; index++) {
      atBottom = index % 2 === 0;
      fireEvent.wheel(viewport, { deltaY: atBottom ? 300 : -300 });
      fireEvent.scroll(viewport);
      // Cross the ordinary observation delay between gestures.
      await advanceReadClock(160);
    }
    expect(client.readState).toHaveBeenCalledOnce();
    expect(firstSignal?.aborted).toBe(false);
    expect(client.events).not.toHaveBeenCalled();
    await act(async () => finishRead({ readState: unread() }));
    expect(client.readState).toHaveBeenCalledTimes(2);
    expect(client.events).toHaveBeenCalledOnce();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();

    atBottom = true;
    fireEvent.wheel(viewport, { deltaY: 300 });
    fireEvent.scroll(viewport);
    await advanceReadClock(260);
    expect(client.readState).toHaveBeenCalledTimes(2);
    expect(client.events).toHaveBeenCalledOnce();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
  });
  it("coalesces invalidations that arrive during a read into one trailing refresh", async () => {
    const initial = unread({ status: "read", firstUnread: null });
    const current = { ...initial, version: "native:current-result" };
    const client = fixture(current);
    let finishRead!: (value: { readState: SessionReadState }) => void;
    client.readState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    let invalidate!: (userAction?: boolean) => void;
    const subscribe = (listener: typeof invalidate) => {
      invalidate = listener;
      return () => {};
    };
    render(<Probe client={client} subscribe={subscribe} />);
    await advanceReadClock(160);
    expect(client.readState).toHaveBeenCalledOnce();
    for (let index = 0; index < 6; index++) {
      act(() => invalidate());
      await advanceReadClock(160);
    }
    expect(client.readState).toHaveBeenCalledOnce();

    await act(async () => finishRead({ readState: initial }));
    await advanceReadClock(250);
    expect(client.readState).toHaveBeenCalledOnce();
    await advanceReadClock(200);
    expect(client.readState).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("read-observation")).toHaveTextContent("read:native:current-result");
    expect(client.events).not.toHaveBeenCalled();
  });
  it.each([
    new ApiError(429, "rate_limited"),
    new ApiError(409, "operation_busy"),
    new ApiError(504, "runtime_read_timeout"),
  ])("backs off a transient GET error (%s) and later acknowledges once", async (error) => {
    const client = fixture();
    client.readState.mockRejectedValueOnce(error);
    render(<Probe client={client} />);
    await advanceReadClock(160);
    expect(client.readState).toHaveBeenCalledOnce();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();

    const viewport = screen.getByTestId("viewport");
    fireEvent.wheel(viewport, { deltaY: 120 });
    fireEvent.scroll(viewport);
    await advanceReadClock(200);
    expect(client.readState).toHaveBeenCalledOnce();
    await advanceReadClock(500);
    await advanceReadClock(260);
    expect(client.readState).toHaveBeenCalledTimes(3);
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
  });
  it.each(["above the bottom", "out of focus"])(
    "pauses a temporary read retry while %s and resumes on return",
    async (condition) => {
      const client = fixture();
      client.readState.mockRejectedValueOnce(new ApiError(429, "rate_limited"));
      render(<Probe client={client} />);
      await advanceReadClock(160);
      expect(client.readState).toHaveBeenCalledOnce();
      const viewport = screen.getByTestId("viewport");
      if (condition === "above the bottom") {
        atBottom = false;
        fireEvent.scroll(viewport);
      } else {
        vi.mocked(document.hasFocus).mockReturnValue(false);
        fireEvent.blur(window);
      }
      await advanceReadClock(2_000);
      expect(client.readState).toHaveBeenCalledOnce();
      expect(client.acknowledgeReadState).not.toHaveBeenCalled();

      if (condition === "above the bottom") {
        atBottom = true;
        fireEvent.scroll(viewport);
      } else {
        vi.mocked(document.hasFocus).mockReturnValue(true);
        fireEvent.focus(window);
      }
      await advanceReadClock(620);
      await advanceReadClock(260);
      expect(client.readState).toHaveBeenCalledTimes(3);
      expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
        "session",
        "native:revision-1",
        "result",
        expect.any(AbortSignal),
      );
    },
  );
  it.each(["above the bottom", "out of focus", "hidden"])(
    "does not continue an in-flight automatic retry after the reader becomes %s",
    async (condition) => {
      const client = fixture();
      let finishRetry!: (value: { readState: SessionReadState }) => void;
      client.readState.mockRejectedValueOnce(new ApiError(429, "rate_limited"));
      client.readState.mockImplementationOnce(
        () => new Promise((resolve) => void (finishRetry = resolve)),
      );
      render(<Probe client={client} />);
      await advanceReadClock(160);
      expect(client.readState).toHaveBeenCalledOnce();
      await advanceReadClock(550);
      expect(client.readState).toHaveBeenCalledTimes(2);
      expect(finishRetry).toBeTypeOf("function");

      if (condition === "above the bottom") {
        atBottom = false;
        fireEvent.scroll(screen.getByTestId("viewport"));
      } else if (condition === "out of focus") {
        vi.mocked(document.hasFocus).mockReturnValue(false);
        fireEvent.blur(window);
      } else {
        vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
        fireEvent(document, new Event("visibilitychange"));
      }
      // The first RPC can still finish after a view abort on some transports.
      await act(async () => finishRetry({ readState: unread() }));
      await advanceReadClock(60_000);
      expect(client.readState).toHaveBeenCalledTimes(2);
      expect(client.events).not.toHaveBeenCalled();
      expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    },
  );
  it("requires foreground and a current reader with no open modal", async () => {
    const client = fixture();
    const view = render(<Probe client={client} blocked />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(false);
    view.rerender(<Probe client={client} />);
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    vi.spyOn(dialog, "getClientRects").mockReturnValue([rect(0, 200)] as unknown as DOMRectList);
    document.body.append(dialog);
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    dialog.remove();
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
  });
  it("waits for the actual Base UI preview to close even without an aria-modal attribute", async () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("data-slot", "dialog-content");
    dialog.setAttribute("data-open", "");
    vi.spyOn(dialog, "getClientRects").mockReturnValue([rect(0, 200)] as unknown as DOMRectList);
    document.body.append(dialog);
    const client = fixture();
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    // Base UI can keep the popup mounted during its closing animation.
    dialog.removeAttribute("data-open");
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    dialog.remove();
  });
  it("never treats a cached or missing result as a fresh visible snapshot", async () => {
    const fresh = [{ ...event, content: "New answer" }],
      client = fixture(unread(), fresh);
    const view = render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    view.rerender(<Probe client={client} rows={fresh} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    expect(readSnapshotMatches([{ ...event, content: "New answer" }], fresh)).toBe(true);
  });
  it("only a pending-review entry scrolls to its result; ordinary opening preserves the viewport", async () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    const client = fixture();
    const view = render(<Probe client={client} />);
    await settle();
    expect(scroll).not.toHaveBeenCalled();
    view.unmount();
    const other = fixture();
    requestReadReview("other", unread(), other);
    render(<Probe client={other} id="other" />);
    await settle();
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center", behavior: "auto" });
  });
  it.each([
    ["catalog version and result both match", "catalog-revision", "result", true],
    ["catalog version changed", "different-revision", "result", false],
    ["clicked result was replaced", "catalog-revision", "different-result", false],
  ])(
    "reviews a result with an opaque detail proof when %s",
    async (_, catalogVersion, id, shouldScroll) => {
      const scroll = vi.fn();
      HTMLElement.prototype.scrollIntoView = scroll;
      const catalogState = unread({ version: "catalog-revision" });
      const detailState = unread({
        version: "opaque-detail-proof",
        latestResult: { ...catalogState.latestResult!, id },
        firstUnread: { type: "result", resultId: id, turnId: "turn" },
      });
      const client = fixture(detailState);
      atBottom = false;
      requestReadReview("session", catalogState, client);
      render(<Probe client={client} catalogVersion={catalogVersion} />);
      await settle();
      if (shouldScroll)
        expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center", behavior: "auto" });
      else expect(scroll).not.toHaveBeenCalled();
      expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    },
  );
  it("acknowledges the failed tool-only turn at the bottom", async () => {
    const tools = [{ ...event, id: "tool", kind: "tool-summary", content: "Tool output" }];
    const client = fixture(
      unread({ latestResult: { ...unread().latestResult!, itemId: null, outcome: "failed" } }),
      tools,
    );
    atBottom = false;
    render(<Probe client={client} rows={tools} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    atBottom = true;
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      "result",
      expect.any(AbortSignal),
    );
  });
  it("allows a fresh visible empty manually unread thread, without manufacturing a result", async () => {
    const empty: typeof events = [];
    const client = fixture(
      unread({ latestResult: null, firstUnread: { type: "threadStart" } }),
      empty,
    );
    render(<Probe client={client} rows={empty} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      null,
      expect.any(AbortSignal),
    );
  });
  it("clears a manually unread non-empty thread at the bottom even without a terminal result", async () => {
    const history = [
      {
        ...event,
        id: "prompt",
        kind: "user-message",
        content: "Existing prompt without a terminal result",
      },
    ];
    const client = fixture(
      unread({ latestResult: null, firstUnread: { type: "threadStart" } }),
      history,
    );
    atBottom = false;
    render(<Probe client={client} rows={history} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    atBottom = true;
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      null,
      expect.any(AbortSignal),
    );
  });
  it("waits for the latest image in a manually unread thread, even when its separate marker is visible", async () => {
    const rows = [{ ...event, kind: "user-message", content: "", attachment_count: 1 }];
    const client = fixture(
      unread({ latestResult: null, firstUnread: { type: "threadStart" } }),
      rows,
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector("[data-read-result]"),
    });
    const view = render(<Probe client={client} rows={rows} imagePending />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    view.rerender(<Probe client={client} rows={rows} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      null,
      expect.any(AbortSignal),
    );
  });
  it("does not let an older off-screen image block a newly viewed manual-unread marker", async () => {
    const rows = [
      { ...event, id: "old-image", kind: "user-message", content: "", attachment_count: 1 },
      { ...event, id: "latest-text", kind: "user-message", content: "Latest request" },
    ];
    const client = fixture(
      unread({ latestResult: null, firstUnread: { type: "threadStart" } }),
      rows,
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector("[data-read-result]"),
    });
    render(<Probe client={client} rows={rows} imagePending="old-image" />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "native:revision-1",
      null,
      expect.any(AbortSignal),
    );
  });
  it.each([unread({ freshness: "stale" }), unread({ status: "unknown", version: null })])(
    "never writes stale/unknown observations",
    async (state) => {
      const client = fixture(state);
      render(<Probe client={client} />);
      await settle();
      expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    },
  );
  it("requires history fetched between two matching versions before acknowledging a reused result ID", async () => {
    const before = unread({ version: "old-detail-proof" });
    const after = unread({ version: "new-detail-proof" });
    const replacement = [{ ...event, content: "Replacement answer under the same result ID" }];
    const client = fixture(before);
    client.events.mockImplementationOnce(async () => {
      // The original page is served, then the record changes before the second detail read.
      client.readState.mockResolvedValue({ readState: after });
      return { events, warnings: [] };
    });
    const view = render(<Probe client={client} catalogVersion="unchanged-catalog-revision" />);
    await settle();
    expect(screen.getByTestId("read-observation")).toHaveTextContent("unread:new-detail-proof");
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();

    client.events.mockResolvedValue({ events: replacement, warnings: [] });
    view.rerender(
      <Probe client={client} rows={replacement} catalogVersion="unchanged-catalog-revision" />,
    );
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "new-detail-proof",
      "result",
      expect.any(AbortSignal),
    );
  });
  it("does not acknowledge a newer result whose answer is absent from the displayed history", async () => {
    const client = fixture();
    const latestResult = {
      ...unread().latestResult!,
      id: "new",
      itemId: "new-answer",
      turnId: "new-turn",
    };
    // Even an unchanged detail version cannot turn this page into proof of a different result.
    client.readState
      .mockResolvedValueOnce({ readState: unread() })
      .mockResolvedValue({ readState: unread({ latestResult }) });
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
  });
  it("does not use a page containing only the next prompt as proof of its new result", async () => {
    const prompt = { ...event, kind: "user-message", id: "prompt", turn_id: "next-turn" };
    const oldPage = [event, prompt];
    const next = unread({
      version: "next-version",
      latestResult: { ...unread().latestResult!, id: "next", turnId: "next-turn", itemId: null },
      firstUnread: { type: "result", resultId: "next", turnId: "next-turn" },
    });
    const client = fixture(unread(), oldPage);
    client.readState.mockResolvedValueOnce({ readState: unread() }).mockResolvedValue({
      readState: next,
    });
    const view = render(<Probe client={client} rows={oldPage} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    view.rerender(<Probe client={client} rows={oldPage} catalogVersion="next-version" />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();

    const newPage = [...oldPage, { ...event, id: "next-answer", turn_id: "next-turn" }];
    client.events.mockResolvedValue({ events: newPage, warnings: [] });
    view.rerender(<Probe client={client} rows={newPage} catalogVersion="next-version" />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "next-version",
      "next",
      expect.any(AbortSignal),
    );
  });
  it("acknowledges all known completed results through the visible bottom, even if the older reply was not loaded", async () => {
    const rows = [
      {
        ...event,
        id: "follow-up",
        kind: "user-message",
        turn_id: "new-turn",
        timestamp: "2026-11-27T01:02:00Z",
      },
      { ...event, id: "progress", turn_id: "new-turn", message_phase: "commentary" as const },
    ];
    const state = unread({
      latestResult: { ...unread().latestResult!, completedAt: "2026-11-27T01:01:00Z" },
    });
    const client = fixture(state, rows);
    render(<Probe client={client} rows={rows} activeTurnId="new-turn" />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      state.version,
      "result",
      expect.any(AbortSignal),
    );
  });
  it.each([
    { unavailableAt: "first read", keepVersion: false },
    { unavailableAt: "second read", keepVersion: false },
    { unavailableAt: "second read", keepVersion: true },
  ] as const)(
    "rechecks proof after the $unavailableAt disallows acknowledgement (version retained: $keepVersion)",
    async ({ unavailableAt, keepVersion }) => {
      const rows = [
        {
          ...event,
          id: "follow-up",
          kind: "user-message",
          turn_id: "new-turn",
          timestamp: "2026-11-27T01:02:00Z",
        },
      ];
      const unavailable = unread({
        source: "agentkib",
        version: keepVersion ? "ledger:previous-proof" : null,
        manualVersion: "ledger:manual-version",
        canAcknowledge: false,
        latestResult: { ...unread().latestResult!, completedAt: "2026-11-27T01:01:00Z" },
      });
      const client = fixture(unavailable, rows);
      if (unavailableAt === "second read")
        client.readState.mockResolvedValueOnce({
          readState: { ...unavailable, version: "ledger:previous-proof", canAcknowledge: true },
        });
      const invalidations = new EventTarget();
      const subscribe = (listener: () => void) => {
        const notify = () => listener();
        invalidations.addEventListener("change", notify);
        return () => invalidations.removeEventListener("change", notify);
      };
      const invalidate = () =>
        act(() => {
          invalidations.dispatchEvent(new Event("change"));
        });
      render(<Probe client={client} rows={rows} source="agentkib" subscribe={subscribe} />);
      await advanceReadClock(160);
      expect(screen.getByTestId("read-observation")).toHaveTextContent(
        keepVersion ? "unread:ledger:previous-proof" : /^unread:$/,
      );
      expect(client.readState).toHaveBeenCalledTimes(unavailableAt === "first read" ? 1 : 2);
      expect(client.events).toHaveBeenCalledTimes(unavailableAt === "first read" ? 0 : 1);
      expect(client.acknowledgeReadState).not.toHaveBeenCalled();

      client.readState.mockResolvedValue({
        readState: { ...unavailable, version: "ledger:proof-version", canAcknowledge: true },
      });
      await advanceReadClock(620);
      await advanceReadClock(260);
      invalidate();
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
        "session",
        "ledger:proof-version",
        "result",
        expect.any(AbortSignal),
      );
    },
  );
  it("does not acknowledge a completion newer than the bottom of the rendered history", async () => {
    const rows = [
      {
        ...event,
        id: "follow-up",
        kind: "user-message",
        turn_id: "last-rendered-turn",
        timestamp: "2026-11-27T01:02:00Z",
      },
      {
        ...event,
        id: "progress",
        turn_id: "last-rendered-turn",
        message_phase: "commentary" as const,
      },
    ];
    const state = unread({
      latestResult: {
        ...unread().latestResult!,
        itemId: "new-answer",
        completedAt: "2026-11-27T01:03:00Z",
      },
    });
    const client = fixture(state, rows);
    // The live stream can miss the newer reply while the host's read state already knows it.
    render(<Probe client={client} rows={rows} activeTurnId="last-rendered-turn" />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
  });
  it("a matching explicit refresh clears unknown suppression, while a different host refresh cannot", async () => {
    const client = fixture();
    client.acknowledgeReadState.mockResolvedValueOnce({ readState: unread(), acknowledged: false });
    render(<Probe client={client} />);
    await settle();
    requestReadStateRefresh({}, "session");
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    const readsBeforeExplicitAction = client.readState.mock.calls.length;
    requestReadStateRefresh(client, "session");
    // The new action releases the write fence but does not skip read backoff.
    await advanceReadClock(8_500);
    await advanceReadClock(260);
    expect(client.readState.mock.calls.length).toBeGreaterThanOrEqual(
      readsBeforeExplicitAction + 2,
    );
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(2);
  });
  it("does not reuse a pending navigation from a different host with the same session/version", async () => {
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    requestReadReview("session", unread(), fixture());
    render(<Probe client={fixture()} />);
    await settle();
    expect(scroll).not.toHaveBeenCalled();
  });
  it("does not probe unsupported routes", async () => {
    const client = fixture();
    render(<Probe client={client} supported={false} />);
    await settle();
    expect(client.events).not.toHaveBeenCalled();
    expect(client.readState).not.toHaveBeenCalled();
  });
  it("fences delayed observations when host/account/source changes", async () => {
    const first = fixture();
    let complete!: (value: { readState: SessionReadState }) => void;
    first.readState.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const view = render(<Probe client={first} />);
    await settle();
    const next = fixture(unread({ source: "agentkib", version: "ledger:2" }));
    view.rerender(<Probe client={next} scope="owner-b" source="agentkib" />);
    await settle();
    await act(async () => complete({ readState: unread() }));
    await settle();
    expect(first.acknowledgeReadState).not.toHaveBeenCalled();
    expect(next.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "ledger:2",
      "result",
      expect.any(AbortSignal),
    );
    expect(screen.getByTestId("read-observation")).toHaveTextContent("read:ledger:2");
  });
  it.each([false, true])(
    "preserves native manual unread for the same visible result until a new reading action (empty=%s)",
    async (empty) => {
      const rows = empty ? [] : events;
      const initial = unread(
        empty ? { latestResult: null, firstUnread: { type: "threadStart" } } : {},
      );
      const client = fixture(initial, rows);
      const view = render(<Probe client={client} rows={rows} />);
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
      const manual = {
        ...initial,
        version: "native:manual-unread",
        firstUnread: { type: "threadStart" as const },
      };
      client.readState.mockResolvedValue({ readState: manual });
      view.rerender(<Probe client={client} rows={rows} catalogVersion={manual.version} />);
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("read-observation")).toHaveTextContent(
        "unread:native:manual-unread",
      );
      fireEvent.wheel(screen.getByTestId("viewport"), { deltaY: 80 });
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledTimes(2);
      expect(client.acknowledgeReadState).toHaveBeenLastCalledWith(
        "session",
        "native:manual-unread",
        empty ? null : "result",
        expect.any(AbortSignal),
      );
    },
  );
  it("automatically acknowledges a genuinely new visible result without resetting the reading action", async () => {
    const client = fixture();
    const view = render(<Probe client={client} />);
    await settle();
    const nextEvents = [
      { ...event, id: "next-answer", turn_id: "next-turn", content: "Next fresh result" },
    ];
    const next = unread({
      version: "native:next-result",
      firstUnread: { type: "result", resultId: "next-result", turnId: "next-turn" },
      latestResult: {
        ...unread().latestResult!,
        id: "next-result",
        itemId: "next-answer",
        turnId: "next-turn",
      },
    });
    client.events.mockResolvedValue({ events: nextEvents, warnings: [] });
    client.readState.mockResolvedValue({ readState: next });
    view.rerender(<Probe client={client} rows={nextEvents} catalogVersion={next.version!} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(2);
    expect(client.acknowledgeReadState).toHaveBeenLastCalledWith(
      "session",
      "native:next-result",
      "next-result",
      expect.any(AbortSignal),
    );
  });
  it("keeps a manual unread mark on an already open session until another reading action", async () => {
    const client = fixture(unread({ status: "read", firstUnread: null }));
    const view = render(<Probe client={client} />);
    await settle();
    const manual = unread({ version: "marked", firstUnread: { type: "threadStart" } });
    client.readState.mockResolvedValue({ readState: manual });
    view.rerender(<Probe client={client} catalogVersion={manual.version!} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    fireEvent.wheel(screen.getByTestId("viewport"), { deltaY: 80 });
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
      "session",
      "marked",
      "result",
      expect.any(AbortSignal),
    );
  });
  it.each([true, false])(
    "a late probe cannot overwrite a newer ACK or its readback (acknowledged=%s)",
    async (acknowledged) => {
      const client = fixture();
      let finishAck!: (value: { readState: SessionReadState; acknowledged: boolean }) => void;
      client.acknowledgeReadState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAck = resolve;
          }),
      );
      let invalidate!: (userAction?: boolean) => void;
      const subscribe = (listener: typeof invalidate) => {
        invalidate = listener;
        return () => {};
      };
      render(<Probe client={client} subscribe={subscribe} />);
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
      let finishProbe!: (value: { readState: SessionReadState }) => void;
      client.readState.mockResolvedValueOnce({ readState: unread() }).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishProbe = resolve;
          }),
      );
      act(() => invalidate());
      await settle();
      expect(finishProbe).toBeTypeOf("function");
      await act(async () =>
        finishAck({
          readState: unread({ status: "read", firstUnread: null, version: "native:newer" }),
          acknowledged,
        }),
      );
      expect(screen.getByTestId("read-observation")).toHaveTextContent("read:native:newer");
      await act(async () => finishProbe({ readState: unread() }));
      await settle();
      expect(screen.getByTestId("read-observation")).toHaveTextContent("read:native:newer");
      expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps a different device's newer manual unread state when an older ACK arrives", async () => {
    const client = fixture();
    let finishAck!: (value: { readState: SessionReadState; acknowledged: boolean }) => void;
    client.acknowledgeReadState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishAck = resolve;
        }),
    );
    const view = render(<Probe client={client} catalogVersion="native:revision-1" />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
    client.readState.mockResolvedValue({
      readState: unread({ firstUnread: { type: "threadStart" }, version: "device-marked" }),
    });
    view.rerender(<Probe client={client} catalogVersion="device-marked" />);
    await settle();
    expect(screen.getByTestId("read-observation")).toHaveTextContent("unread:device-marked");

    await act(async () =>
      finishAck({
        acknowledged: true,
        readState: unread({ status: "read", firstUnread: null, version: "local-receipt" }),
      }),
    );
    expect(screen.getByTestId("read-observation")).toHaveTextContent("unread:device-marked");
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
  });
  it("drops a delayed receipt read when the catalog advances to a different device's manual unread", async () => {
    const client = fixture();
    const onAcknowledged = vi.fn();
    client.acknowledgeReadState.mockRejectedValueOnce(
      new ReadStateReconciliationError(new ApiError(429, "rate_limited"), false),
    );
    let finishReadback!: (value: { readState: SessionReadState }) => void;
    client.readState
      .mockResolvedValueOnce({ readState: unread() })
      .mockResolvedValueOnce({ readState: unread() })
      .mockImplementationOnce(() => new Promise((resolve) => void (finishReadback = resolve)));
    const view = render(
      <Probe client={client} catalogVersion="native:revision-1" onAcknowledged={onAcknowledged} />,
    );
    await advanceReadClock(160);
    await advanceReadClock(260);
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
    await advanceReadClock(550);
    expect(finishReadback).toBeTypeOf("function");

    const manual = unread({ version: "device-marked", firstUnread: { type: "threadStart" } });
    client.readState.mockResolvedValue({ readState: manual });
    view.rerender(
      <Probe client={client} catalogVersion="device-marked" onAcknowledged={onAcknowledged} />,
    );
    await act(async () =>
      finishReadback({
        readState: unread({ status: "read", firstUnread: null, version: "old-readback" }),
      }),
    );
    expect(screen.getByTestId("read-observation")).not.toHaveTextContent("old-readback");
    expect(onAcknowledged).not.toHaveBeenCalled();
    await settle();
    expect(screen.getByTestId("read-observation")).toHaveTextContent("unread:device-marked");
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
  });
  it.each(["immediate readback", "rate-limited readback"])(
    "respects manual unread after a conflict and permits explicit review (%s)",
    async (kind) => {
      const client = fixture();
      const manual = unread({ version: "device-marked", firstUnread: { type: "threadStart" } });
      client.acknowledgeReadState.mockImplementationOnce(async () => {
        client.readState.mockResolvedValue({ readState: manual });
        if (kind === "rate-limited readback")
          throw new ReadStateReconciliationError(new ApiError(429, "rate_limited"), true);
        return { readState: manual, acknowledged: false, conflict: true };
      });
      const view = render(<Probe client={client} catalogVersion="native:revision-1" />);
      await settle();
      await settle();
      expect(screen.getByTestId("read-observation")).toHaveTextContent("unread:device-marked");
      view.rerender(<Probe client={client} catalogVersion="device-marked" />);
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith(
        "session",
        "native:revision-1",
        "result",
        expect.any(AbortSignal),
      );

      act(() => requestReadReview("session", manual, client));
      await settle();
      expect(client.acknowledgeReadState.mock.calls).toEqual([
        ["session", "native:revision-1", "result", expect.any(AbortSignal)],
        ["session", "device-marked", "result", expect.any(AbortSignal)],
      ]);
    },
  );
  it("takes fresh reading evidence for a new version after an explicit conflict", async () => {
    const client = fixture();
    const current = unread({ version: "native:new" });
    client.acknowledgeReadState.mockImplementationOnce(async () => {
      client.readState.mockResolvedValue({ readState: current });
      return { readState: current, acknowledged: false, conflict: true };
    });
    render(<Probe client={client} />);
    await settle();
    await settle();
    expect(client.acknowledgeReadState.mock.calls).toEqual([
      ["session", "native:revision-1", "result", expect.any(AbortSignal)],
      ["session", "native:new", "result", expect.any(AbortSignal)],
    ]);
  });
  it.each(["proof already restored", "readback rate-limited"])(
    "retries a known conflict after the same proof can be checked again (%s)",
    async (condition) => {
      const client = fixture();
      if (condition === "proof already restored") {
        client.acknowledgeReadState.mockResolvedValueOnce({
          readState: unread(),
          acknowledged: false,
          conflict: true,
        });
      } else {
        client.acknowledgeReadState.mockRejectedValueOnce(
          new ReadStateReconciliationError(new ApiError(429, "rate_limited"), true),
        );
      }
      render(<Probe client={client} />);
      await advanceReadClock(160);
      await advanceReadClock(260);
      expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
      expect(client.readState).toHaveBeenCalledTimes(2);
      await advanceReadClock(620);
      await advanceReadClock(260);
      expect(client.readState).toHaveBeenCalledTimes(4);
      expect(client.events).toHaveBeenCalledTimes(2);
      expect(client.acknowledgeReadState.mock.calls).toEqual([
        ["session", "native:revision-1", "result", expect.any(AbortSignal)],
        ["session", "native:revision-1", "result", expect.any(AbortSignal)],
      ]);
    },
  );
  it.each([new ApiError(429, "rate_limited"), new ApiError(409, "operation_busy")])(
    "retries an acknowledgement refused before dispatch (%s) using fresh proof",
    async (error) => {
      const client = fixture();
      client.acknowledgeReadState.mockRejectedValueOnce(error);
      render(<Probe client={client} />);
      await advanceReadClock(160);
      await advanceReadClock(260);
      expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
      expect(client.readState).toHaveBeenCalledTimes(2);

      const fresh = unread({ version: "native:fresh-retry" });
      client.readState.mockResolvedValue({ readState: fresh });
      client.acknowledgeReadState.mockResolvedValue({
        readState: { ...fresh, status: "read", firstUnread: null },
        acknowledged: true,
      });
      await advanceReadClock(620);
      await advanceReadClock(260);
      expect(client.readState).toHaveBeenCalledTimes(4);
      expect(client.acknowledgeReadState.mock.calls).toEqual([
        ["session", "native:revision-1", "result", expect.any(AbortSignal)],
        ["session", "native:fresh-retry", "result", expect.any(AbortSignal)],
      ]);
    },
  );
  it("keeps increasing the backoff for refused acknowledgements despite successful reads", async () => {
    const client = fixture();
    const refusal = new ApiError(429, "rate_limited");
    client.acknowledgeReadState.mockRejectedValueOnce(refusal).mockRejectedValueOnce(refusal);
    render(<Probe client={client} />);
    await advanceReadClock(160);
    await advanceReadClock(260);
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
    await advanceReadClock(460);
    await advanceReadClock(225);
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(2);
    expect(client.events).toHaveBeenCalledTimes(2);

    // The second refusal waits longer than the first despite a successful proof in between.
    await advanceReadClock(460);
    await advanceReadClock(225);
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(2);
    await advanceReadClock(500);
    await advanceReadClock(260);
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(3);
    expect(client.events).toHaveBeenCalledTimes(3);
  });
  it("only retries reads after a lost acknowledgement and rate-limited reconciliation", async () => {
    const client = fixture();
    client.acknowledgeReadState.mockRejectedValueOnce(
      new ReadStateReconciliationError(new ApiError(429, "rate_limited"), false),
    );
    const view = render(<Probe client={client} />);
    await advanceReadClock(160);
    await advanceReadClock(260);
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();

    await advanceReadClock(620);
    await advanceReadClock(260);
    expect(client.readState.mock.calls.length).toBeGreaterThan(2);
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();

    const rows = [
      ...events,
      { ...event, id: "next-answer", turn_id: "next-turn", content: "Next fresh result" },
    ];
    const next = unread({
      version: "native:next-result",
      firstUnread: { type: "result", resultId: "next-result", turnId: "next-turn" },
      latestResult: {
        ...unread().latestResult!,
        id: "next-result",
        itemId: "next-answer",
        turnId: "next-turn",
      },
    });
    client.readState.mockResolvedValue({ readState: next });
    client.events.mockResolvedValue({ events: rows, warnings: [] });
    view.rerender(<Probe client={client} rows={rows} catalogVersion={next.version!} />);
    await advanceReadClock(620);
    await advanceReadClock(260);
    expect(client.acknowledgeReadState.mock.calls).toEqual([
      ["session", "native:revision-1", "result", expect.any(AbortSignal)],
      ["session", "native:next-result", "next-result", expect.any(AbortSignal)],
    ]);
  });
  it.each(["immediate readback", "rate-limited readback"])(
    "stops reading when a lost acknowledgement reconciles as current and unread (%s)",
    async (kind) => {
      const client = fixture();
      if (kind === "rate-limited readback")
        client.acknowledgeReadState.mockRejectedValueOnce(
          new ReadStateReconciliationError(new ApiError(429, "rate_limited"), false),
        );
      else
        client.acknowledgeReadState.mockResolvedValueOnce({
          readState: unread(),
          acknowledged: false,
        });
      render(<Probe client={client} />);
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
      expect(client.readState).toHaveBeenCalledTimes(2);

      await advanceReadClock(60_000);
      expect(client.readState).toHaveBeenCalledTimes(kind === "rate-limited readback" ? 3 : 2);
      expect(client.events).toHaveBeenCalledOnce();
      expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
      expect(screen.getByTestId("read-observation")).toHaveTextContent("unread:native:revision-1");
    },
  );
  it("bounds failed receipt reads and keeps a lost write fenced when the window is exhausted", async () => {
    const client = fixture();
    const limited = new ApiError(429, "rate_limited");
    client.acknowledgeReadState.mockRejectedValueOnce(
      new ReadStateReconciliationError(limited, false),
    );
    client.readState
      .mockResolvedValueOnce({ readState: unread() })
      .mockResolvedValueOnce({ readState: unread() })
      .mockRejectedValue(limited);
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
    expect(client.readState).toHaveBeenCalledTimes(2);
    await advanceReadClock(60_000);
    expect(client.readState).toHaveBeenCalledTimes(5);
    expect(client.events).toHaveBeenCalledOnce();
    expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
  });
  it.each(["above the bottom", "out of focus"])(
    "cancels pending receipt readback after the reader goes %s",
    async (condition) => {
      const client = fixture();
      let readbackSignal: AbortSignal | undefined;
      let finishAck!: () => void;
      client.acknowledgeReadState.mockImplementationOnce(
        (_id?: string, _version?: string, _resultId?: string, signal?: AbortSignal) => {
          readbackSignal = signal;
          return new Promise((_, reject) => {
            finishAck = () =>
              reject(new ReadStateReconciliationError(new ApiError(429, "rate_limited"), false));
          });
        },
      );
      render(<Probe client={client} />);
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
      expect(readbackSignal?.aborted).toBe(false);
      if (condition === "above the bottom") {
        atBottom = false;
        fireEvent.scroll(screen.getByTestId("viewport"));
      } else {
        vi.mocked(document.hasFocus).mockReturnValue(false);
        fireEvent.blur(window);
      }
      await advanceReadClock(50);
      expect(readbackSignal?.aborted).toBe(true);

      await act(async () => finishAck());
      await advanceReadClock(60_000);
      expect(client.readState).toHaveBeenCalledTimes(2);
      expect(client.events).toHaveBeenCalledOnce();
      expect(client.acknowledgeReadState).toHaveBeenCalledOnce();
    },
  );
  it("only reads on foreground resume after an unknown ACK, without automatically re-allowing a write", async () => {
    const client = fixture();
    client.acknowledgeReadState.mockResolvedValueOnce({ readState: unread(), acknowledged: false });
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    const initialReads = client.readState.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(client.readState.mock.calls.length).toBeGreaterThan(initialReads);
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    const hiddenReads = client.readState.mock.calls.length;
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(client.readState.mock.calls.length).toBeGreaterThan(hiddenReads);
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
  });
  it("an unknown ACK requires new user action and a fresh visible read before another write", async () => {
    const client = fixture();
    client.acknowledgeReadState.mockResolvedValueOnce({ readState: unread(), acknowledged: false });
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    const input = document.createElement("textarea"),
      settings = document.createElement("button");
    document.body.append(input, settings);
    fireEvent.pointerDown(input);
    fireEvent.keyDown(input, { key: "a" });
    fireEvent.pointerDown(settings);
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    input.remove();
    settings.remove();
    fireEvent.wheel(screen.getByTestId("viewport"), { deltaY: 80 });
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
    const readsBeforeExplicitAction = client.readState.mock.calls.length;
    fireEvent.pointerDown(screen.getByText("Fresh answer"));
    await advanceReadClock(8_500);
    await advanceReadClock(260);
    expect(client.readState.mock.calls.length).toBeGreaterThanOrEqual(
      readsBeforeExplicitAction + 2,
    );
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(2);
  });
});

describe("review lane and shared list semantics", () => {
  it("keeps all explicit outcomes and manual unread once per session, with running unread in its existing row", () => {
    const rows = ["completed", "failed", "cancelled", "ended"].map((outcome) => ({
      id: outcome,
      title: outcome,
      agent: "codex",
      readState: unread({
        latestResult: { ...unread().latestResult!, outcome: outcome as "completed" },
      }),
    }));
    const manual = {
      id: "manual",
      agent: "codex",
      readState: unread({ latestResult: null, firstUnread: { type: "threadStart" } }),
    };
    const running = { ...rows[0], id: "running", continuation: { status: "running" } };
    expect(pendingReviewSessions([...rows, rows[0], manual, running]).map((row) => row.id)).toEqual(
      ["completed", "failed", "cancelled", "ended", "manual"],
    );
    const status = sessionContinuationListState(running, "en-US")!;
    const { container } = render(
      <>
        <PendingReviewLane
          sessions={[...rows, manual, running]}
          locale="en-US"
          onSelect={vi.fn()}
        />
        <SessionContinuationDot {...status} />
      </>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(5);
    expect(container.querySelectorAll('[data-unread="true"]')).toHaveLength(1);
    expect(status.label).toContain("Unread");
  });
  it.each(["zh-CN", "zh-Hant", "ja-JP", "en-US"])(
    "shows the manual unread label in %s",
    (locale) => {
      render(
        <PendingReviewLane
          locale={locale}
          sessions={[
            {
              id: "manual",
              readState: unread({ latestResult: null, firstUnread: { type: "threadStart" } }),
            },
          ]}
          onSelect={vi.fn()}
        />,
      );
      const manualLabel = (
        {
          "zh-CN": "未读会话",
          "zh-Hant": "未讀對話",
          "ja-JP": "未読の会話",
          "en-US": "Unread conversation",
        } as Record<string, string>
      )[locale];
      expect(screen.getByText(manualLabel!)).toBeVisible();
    },
  );
});

describe("Web SDK ACK recovery", () => {
  it.each([
    new ApiError(409, "read_state_conflict"),
    new TypeError("connection lost"),
    new ApiError(503, "read_state_unavailable"),
  ])("only reads back after conflict/unknown results", async (failure) => {
    const request = vi.fn(async (path: string, body?: unknown) => {
      if (body) throw failure;
      return { readState: unread() };
    });
    const client = new WebClient(undefined, { type: "same-origin" }, { request } as never);
    // access initializes the normal protocol fence, as in the real host transport.
    request.mockImplementationOnce(
      async () =>
        ({
          status: "approved",
          protocolVersion: 2,
          csrfToken: "csrf",
          bootId: "boot",
          experimentalEnabled: false,
        }) as never,
    );
    await client.access();
    expect(await client.acknowledgeReadState("session", "version", "result")).toMatchObject({
      acknowledged: false,
    });
    expect(request.mock.calls.slice(1).map(([path]) => path)).toEqual([
      "read-state",
      "read-state?sessionId=session",
    ]);
    expect(request.mock.calls.filter(([, body]) => body)).toHaveLength(1);
  });
  it("does not turn a permission rejection into a second request", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        status: "approved",
        protocolVersion: 2,
        csrfToken: "csrf",
        bootId: "boot",
      })
      .mockRejectedValue(new ApiError(403, "read_forbidden"));
    const client = new WebClient(undefined, { type: "same-origin" }, { request } as never);
    await client.access();
    await expect(client.acknowledgeReadState("session", "version", "result")).rejects.toMatchObject(
      { status: 403 },
    );
    expect(request).toHaveBeenCalledTimes(2);
  });
});
