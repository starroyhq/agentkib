// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationWords } from "@/core/i18n";
import { SessionReader } from "./session-reader";
import { useSession } from "./session-context";
import { webLayoutCopy } from "./web-layout-copy";

vi.mock("./session-context", () => ({ useSession: vi.fn() }));
vi.mock("./session-operations", () => ({ SessionOperations: () => null }));
vi.mock("./artifact-browser", () => ({ ArtifactBrowser: () => null }));

type Session = ReturnType<typeof useSession>;
let state: Session;
let viewportHeight: number;
let contentHeight: number;
let frameId: number;
let frames: Map<number, FrameRequestCallback>;
let observers: Set<TestResizeObserver>;
let positions: WeakMap<Element, number>;

class TestResizeObserver implements ResizeObserver {
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
    observers.delete(this);
  }
}

const item = (id: string, content: string, kind = "agent-message") => ({
  id,
  kind,
  content,
  attachment_count: 0,
  truncated: false,
});

function flushFrames() {
  act(() => {
    for (let round = 0; frames.size && round < 20; round++) {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback(0);
    }
  });
  expect(frames.size).toBe(0);
}

function resize() {
  act(() => {
    for (const observer of [...observers]) {
      const entries = [...observer.targets].map((target) => ({
        target,
        contentRect: target.getBoundingClientRect(),
      })) as ResizeObserverEntry[];
      observer.callback(entries, observer);
    }
  });
  flushFrames();
}

function reader() {
  const view = render(<SessionReader />);
  const viewport = view.container.querySelector<HTMLElement>("section.reader-scroll")!;
  flushFrames();
  return { ...view, viewport, update: () => view.rerender(<SessionReader />) };
}

function reply(content = "Native reply") {
  state = {
    ...state,
    pendingSend: undefined,
    liveContentVersion: (state.liveContentVersion ?? 0) + 1,
    page: { ...state.page!, events: [...state.page!.events, item("reply", content)] },
  } as Session;
}

beforeEach(() => {
  viewportHeight = 400;
  contentHeight = 1000;
  frameId = 0;
  frames = new Map();
  observers = new Set();
  positions = new WeakMap();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("reader-scroll") ? viewportHeight : 0;
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("reader-scroll") ? contentHeight : 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
    return positions.get(this) ?? 0;
  });
  vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (
    this: Element,
    next: number,
  ) {
    positions.set(this, Math.max(0, Math.min(next, contentHeight - viewportHeight)));
  });
  state = {
    selected: "session",
    current: { id: "session", agent: "codex" },
    locale: "en-US",
    t: conversationWords("en-US"),
    access: { protocolVersion: 2, experimentalEnabled: false },
    page: { events: [item("initial", "Earlier reply")], warnings: [], next_cursor: null },
    live: { sessionId: "session", status: "idle", revision: 1, sendEnabled: true, approvals: [] },
    liveContentVersion: 1,
    online: true,
    controlReady: true,
    busy: false,
    canSend: false,
    canStop: false,
    message: "Saved draft",
    setMessage: vi.fn(),
    scroll: { current: null },
    setModal: vi.fn(),
    control: vi.fn(),
    earlier: vi.fn(),
  } as unknown as Session;
  vi.mocked(useSession).mockImplementation(() => state);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("reader follows user intent across transcript and viewport layout", () => {
  it("keeps following a pending row and its native replacement despite layout scroll events", () => {
    const view = reader();
    expect(view.viewport.scrollTop).toBe(600);
    contentHeight = 1160;
    state = {
      ...state,
      pendingSend: { sessionId: "session", text: "My pending message", afterEventId: "initial" },
    };
    view.update();
    expect(screen.getByText("My pending message")).toBeInTheDocument();
    flushFrames();
    expect(view.viewport.scrollTop).toBe(760);

    // Browser anchoring/layout can emit scroll without a wheel, touch, key, or
    // scrollbar gesture. Its new gap must not revoke the existing follow intent.
    contentHeight = 1360;
    fireEvent.scroll(view.viewport);
    state = {
      ...state,
      page: {
        ...state.page!,
        events: [...state.page!.events, item("native-user", "My pending message", "user-message")],
      },
    } as Session;
    reply();
    view.update();
    resize();
    expect(view.viewport.scrollTop).toBe(960);
    expect(screen.getAllByText("My pending message")).toHaveLength(1);
    expect(screen.getByText("Native reply")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: webLayoutCopy["en-US"].newMessages }),
    ).not.toBeInTheDocument();
  });

  it("stays at the bottom when only the composer changes the viewport height", () => {
    const view = reader();
    viewportHeight = 280;
    fireEvent.scroll(view.viewport);
    resize();
    expect(view.viewport.scrollTop).toBe(720);
    expect(state.control).not.toHaveBeenCalled();
  });

  it("preserves a deliberate upward read and resumes when returning to latest", () => {
    const view = reader();
    fireEvent.wheel(view.viewport, { deltaY: -200 });
    view.viewport.scrollTop = 200;
    fireEvent.scroll(view.viewport);
    contentHeight = 1300;
    reply();
    view.update();
    resize();
    expect(view.viewport.scrollTop).toBe(200);
    const latest = screen.getByRole("button", { name: webLayoutCopy["en-US"].newMessages });
    expect(latest).toBeVisible();
    fireEvent.click(latest);
    flushFrames();
    expect(view.viewport.scrollTop).toBe(900);
    expect(
      screen.queryByRole("button", { name: webLayoutCopy["en-US"].newMessages }),
    ).not.toBeInTheDocument();
    contentHeight = 1500;
    resize();
    expect(view.viewport.scrollTop).toBe(1100);
  });

  it("does not pull an older reading position down for a new local pending message", () => {
    const view = reader();
    fireEvent.wheel(view.viewport, { deltaY: -200 });
    view.viewport.scrollTop = 200;
    fireEvent.scroll(view.viewport);
    contentHeight = 1200;
    state = {
      ...state,
      pendingSend: { sessionId: "session", text: "Send while reading", afterEventId: "initial" },
    };
    view.update();
    resize();
    expect(view.viewport.scrollTop).toBe(200);
    expect(screen.getByText("Send while reading")).toBeInTheDocument();
  });

  it("keeps the earlier-history anchor after prepend and later layout changes", async () => {
    state = { ...state, page: { ...state.page!, next_cursor: "older" } };
    const view = reader();
    fireEvent.wheel(view.viewport, { deltaY: -600 });
    view.viewport.scrollTop = 0;
    fireEvent.scroll(view.viewport);
    state.earlier = vi.fn(async () => {
      contentHeight += 300;
      state = {
        ...state,
        page: { ...state.page!, events: [item("older", "Older page"), ...state.page!.events] },
      } as Session;
      view.update();
      // The controller restores the prepended page's existing message anchor.
      view.viewport.scrollTop = 300;
      fireEvent.scroll(view.viewport);
    });
    view.update();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: state.t.earlier })));
    resize();
    expect(state.earlier).toHaveBeenCalledOnce();
    expect(screen.getByText("Older page")).toBeInTheDocument();
    expect(view.viewport.scrollTop).toBe(300);
    expect(
      screen.queryByRole("button", { name: webLayoutCopy["en-US"].newMessages }),
    ).not.toBeInTheDocument();
  });
});
