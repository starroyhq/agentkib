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
import { ApiError, WebClient, type ConversationEvent } from "@agentkib/web-client";

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
async function settle() {
  for (let n = 0; n < 5; n++)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120);
    });
}
beforeEach(() => {
  vi.useFakeTimers();
  atBottom = true;
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
      await settle();
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
    );
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
  });
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
    );
  });
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
    requestReadStateRefresh(client, "session");
    await settle();
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
      render(<Probe client={client} />);
      await settle();
      expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
      let finishProbe!: (value: { readState: SessionReadState }) => void;
      client.readState.mockResolvedValueOnce({ readState: unread() }).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishProbe = resolve;
          }),
      );
      fireEvent.wheel(screen.getByTestId("viewport"), { deltaY: 80 });
      await settle();
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
      ["session", "native:revision-1", "result"],
      ["session", "native:new", "result"],
    ]);
  });
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
    expect(client.readState).toHaveBeenCalledTimes(4);
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
