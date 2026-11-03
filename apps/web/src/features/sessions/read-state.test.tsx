import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PendingReviewLane,
  ReadStateNotice,
  pendingReviewSessions,
  readSnapshotMatches,
  requestReadReview,
  requestReadStateRefresh,
  sessionContinuationListState,
  SessionContinuationDot,
  useVisibleReadState,
  type SessionReadState,
} from "@agentkib/session-ui";
import { ApiError, WebClient } from "@agentkib/web-client";

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
function fixture(state = unread(), fresh = events) {
  return {
    events: vi.fn(async () => ({ events: fresh, warnings: [] })),
    readState: vi.fn(async () => ({ readState: state })),
    acknowledgeReadState: vi.fn(
      async (): Promise<{ readState: SessionReadState; acknowledged: boolean }> => ({
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
}: {
  client: Client;
  id?: string;
  scope?: string;
  rows?: typeof events;
  supported?: boolean;
  blocked?: boolean;
  source?: SessionReadState["source"];
  ready?: boolean;
  catalogVersion?: string;
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
    events: rows,
    viewportRef: viewport,
  });
  return (
    <div data-testid="viewport" ref={viewport}>
      <output data-testid="read-observation">
        {observed.readState?.status}:{observed.readState?.version}
      </output>
      {rows.map((row) => (
        <article data-event-id={row.id} key={row.id}>
          {row.content}
        </article>
      ))}
      {observed.events && (
        <p data-read-result={observed.readState?.latestResult?.id ?? "threadStart"}>Result</p>
      )}
      <ReadStateNotice locale="en-US" observation={observed} />
    </div>
  );
}
let offscreen = false;
let covered = false;
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
  offscreen = false;
  covered = false;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === "viewport"
        ? rect(0, 600)
        : offscreen
          ? rect(1000, 1100)
          : rect(40, 100);
    },
  );
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() =>
      covered ? document.body : document.querySelector("[data-event-id], [data-read-result]"),
    ),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("visible result read acknowledgements", () => {
  it("does not acknowledge an off-screen row; actual scrolling into view acknowledges exactly that result", async () => {
    const client = fixture();
    offscreen = true;
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    offscreen = false;
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
  it("requires foreground, uncovered content and the current reader route", async () => {
    const client = fixture();
    covered = true;
    const view = render(<Probe client={client} blocked />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    view.rerender(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    covered = false;
    vi.mocked(document.hasFocus).mockReturnValue(false);
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.append(dialog);
    fireEvent.scroll(screen.getByTestId("viewport"));
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    dialog.remove();
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledTimes(1);
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
  it("does not acknowledge a failed tool-only turn until its terminal marker is visible", async () => {
    const tools = [{ ...event, id: "tool", kind: "tool-summary", content: "Tool output" }];
    const client = fixture(
      unread({ latestResult: { ...unread().latestResult!, itemId: null, outcome: "failed" } }),
      tools,
    );
    let markerVisible = false;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "viewport"
          ? rect(0, 600)
          : this.hasAttribute("data-read-result") && !markerVisible
            ? rect(1000, 1100)
            : rect(40, 100);
      },
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector(markerVisible ? "[data-read-result]" : "[data-event-id]"),
    });
    render(<Probe client={client} rows={tools} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    markerVisible = true;
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
  it("requires the latest manual-unread marker for a non-empty thread without a terminal result", async () => {
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
    let markerVisible = false;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "viewport"
          ? rect(0, 600)
          : this.hasAttribute("data-read-result") && !markerVisible
            ? rect(1000, 1100)
            : rect(40, 100);
      },
    );
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector(markerVisible ? "[data-read-result]" : "[data-event-id]"),
    });
    render(<Probe client={client} rows={history} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    markerVisible = true;
    fireEvent.scroll(screen.getByTestId("viewport"));
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
      expect(screen.getByText("Read state may be out of date")).toBeVisible();
    },
  );
  it("rejects a result arriving between the fresh history and the second state read", async () => {
    const client = fixture();
    client.readState
      .mockResolvedValueOnce({ readState: unread({ version: "old" }) })
      .mockResolvedValue({ readState: unread({ version: "new" }) });
    render(<Probe client={client} />);
    await settle();
    expect(client.acknowledgeReadState).not.toHaveBeenCalled();
    fireEvent.wheel(screen.getByTestId("viewport"), { deltaY: 80 });
    await settle();
    expect(client.acknowledgeReadState).toHaveBeenCalledExactlyOnceWith("session", "new", "result");
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
  it("shows old-host upgrade guidance and does not probe unsupported routes", async () => {
    const client = fixture();
    render(<Probe client={client} supported={false} />);
    await settle();
    expect(client.events).not.toHaveBeenCalled();
    expect(client.readState).not.toHaveBeenCalled();
    expect(screen.getByText("Update the host to sync read state")).toBeVisible();
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
    expect(screen.getByText("Read state syncs within AgentKib only")).toBeVisible();
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
  it.each(["zh-CN", "zh-TW", "ja-JP", "en-US"])(
    "provides old-host, stale and fallback scope copy in %s",
    (locale) => {
      const view = render(
        <ReadStateNotice locale={locale} observation={{ status: "unsupported" }} />,
      );
      expect(screen.getByRole("status").textContent).toBeTruthy();
      view.rerender(
        <ReadStateNotice
          locale={locale}
          observation={{ status: "ready", readState: unread({ freshness: "stale" }) }}
        />,
      );
      const stale = screen.getByRole("status").textContent;
      view.rerender(
        <ReadStateNotice
          locale={locale}
          observation={{ status: "ready", readState: unread({ source: "agentkib" }) }}
        />,
      );
      expect(screen.getByRole("status").textContent).not.toBe(stale);
      view.rerender(
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
          "zh-TW": "未讀對話",
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
