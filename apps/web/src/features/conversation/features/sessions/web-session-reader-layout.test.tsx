// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "@/features/conversation/web-reader-test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { dictionaries } from "../../i18n";
const conversationWords = (locale: keyof typeof dictionaries) => dictionaries[locale];
import { SessionReader } from "./web-session-reader";
import { useSession } from "../../web-session-context";
import { webLayoutCopy } from "@agentkib/session-ui";
import { contextUsageCopyForSurface } from "@agentkib/session-ui";

vi.mock("../../web-session-context", () => ({ useSession: vi.fn() }));
vi.mock("./web-session-operations", () => ({ WebSessionOperations: () => null }));

type Session = ReturnType<typeof useSession>;
let state: Session;
let viewportHeight: number;
let contentHeight: number;
let frameId: number;
let frames: Map<number, FrameRequestCallback>;
let positions: WeakMap<Element, number>;

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

function reader() {
  const view = render(<SessionReader />);
  const viewport = view.container.querySelector<HTMLElement>("section.reader-scroll")!;
  flushFrames();
  return { ...view, viewport, update: () => view.rerender(<SessionReader />) };
}

beforeEach(() => {
  viewportHeight = 400;
  contentHeight = 1000;
  frameId = 0;
  frames = new Map();
  positions = new WeakMap();
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

it("uses the same reader status slot for execution and compaction", () => {
  state = { ...state, live: { ...state.live!, status: "running", turnId: "turn-1" } };
  const view = reader();
  const status = () => view.viewport.querySelector("[data-session-turn-status]");
  expect(status()).toHaveAttribute("data-session-turn-status", "running");
  state = { ...state, live: { ...state.live!, activity: "compacting" } };
  view.update();
  const copy = contextUsageCopyForSurface("en-US", "web");
  expect(screen.getAllByText(copy.compacting)).toHaveLength(1);
  expect(status()).toHaveAttribute("data-session-turn-status", "compacting");
  expect(screen.queryByText(copy.compactingDetail)).not.toBeInTheDocument();

  state = { ...state, online: false };
  view.update();
  expect(status()).toBeNull();
});

it("shows the return-to-bottom control on Web before new output arrives", () => {
  const view = reader();
  fireEvent.wheel(view.viewport, { deltaY: -200 });
  view.viewport.scrollTop = 200;
  fireEvent.scroll(view.viewport);

  const jump = screen.getByRole("button", { name: webLayoutCopy["en-US"].jumpToLatest });
  expect(jump).toHaveTextContent(webLayoutCopy["en-US"].jumpToLatest);
  fireEvent.click(jump);
  flushFrames();
  expect(view.viewport.scrollTop).toBe(600);
  expect(jump).not.toBeInTheDocument();
});
