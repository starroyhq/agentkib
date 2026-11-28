// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "@/features/sessions/conversation/desktop-reader-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationWords } from "@/core/i18n";
import { SessionReader } from "./desktop-session-reader";
import { useSession } from "../../desktop-session-context";
import { webLayoutCopy } from "@agentkib/session-ui";
import { contextUsageCopy } from "@agentkib/session-ui";
import type { ConversationEvent } from "@agentkib/web-client";

vi.mock("../../desktop-session-context", () => ({ useSession: vi.fn() }));
vi.mock("./desktop-session-operations", () => ({ DesktopSessionOperations: () => null }));

type Session = ReturnType<typeof useSession>;
let state: Session;
let viewportHeight: number;
let contentHeight: number;
let composerHeight: number;
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

const item = (
  id: string,
  content: string,
  kind: ConversationEvent["kind"] = "agent-message",
): ConversationEvent => ({
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
  composerHeight = 80;
  frameId = 0;
  frames = new Map();
  observers = new Set();
  positions = new WeakMap();
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return new DOMRect(0, 0, 0, this.classList.contains("reader-composer") ? composerHeight : 0);
  });
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

it.each([
  ["en-US", "Codex could not start the turn."],
  ["zh-CN", "Codex 无法开始本轮。"],
  ["zh-Hant", "Codex 無法開始這一輪。"],
  ["ja-JP", "Codex がターンを開始できませんでした。"],
] as const)("shows Codex's start rejection in the %s reader", (locale, label) => {
  const message = "The selected model is unavailable for this account.";
  state = {
    ...state,
    locale,
    t: conversationWords(locale),
    notice: "notDispatched",
    noticeReason: undefined,
    noticeSource: "send",
    live: {
      ...state.live!,
      turnStartError: { reason: "codex-turn-start-rejected", message },
    },
  };
  const view = reader();
  expect(screen.getByText(`${label} ${message}`)).toBeVisible();
  state = { ...state, notice: undefined, live: { ...state.live!, turnStartError: null } };
  view.update();
  expect(screen.queryByText(message, { exact: false })).not.toBeInTheDocument();
});

it("updates activities for the displayed session without showing another session's activity", () => {
  const activity = {
    id: "review",
    kind: "subagent",
    title: "Review changes",
    status: "running",
  } as const;
  localStorage.setItem("agentkib.session-activities.open", "true");
  const view = reader();
  const panel = screen.getByRole("region", { name: "Session activities" });
  expect(view.viewport).not.toContainElement(panel);
  expect(panel.parentElement).toHaveStyle({ bottom: "80px" });

  state = { ...state, live: { ...state.live!, activities: [activity] } };
  view.update();
  expect(screen.getByText(activity.title)).toBeVisible();
  expect(screen.getByText("Running")).toBeVisible();

  composerHeight = 160;
  resize();
  expect(panel.parentElement).toHaveStyle({ bottom: "160px" });

  state = {
    ...state,
    live: { ...state.live!, activities: [{ ...activity, status: "completed" }] },
  };
  view.update();
  expect(screen.getByText("Completed")).toBeVisible();

  state = { ...state, live: { ...state.live!, sessionId: "another-session" } };
  view.update();
  expect(panel).toBeVisible();
  expect(screen.queryByText(activity.title)).not.toBeInTheDocument();
  localStorage.removeItem("agentkib.session-activities.open");
});

it.each(["live-first", "history-first"])(
  "renders the persisted terminal reply once when projection overlaps (%s)",
  (order) => {
    const nativeTurnId = "native-prompt";
    const text = "One native assistant response";
    const history = {
      ...state.page!,
      events: [
        ...state.page!.events,
        { ...item("native-user", "Question", "user-message"), turn_id: nativeTurnId },
        { ...item("native-assistant", text), turn_id: nativeTurnId },
      ],
    };
    const live = {
      ...state.live!,
      executionMode: "claude-follower",
      executionLocation: "terminal",
      status: "running",
      turnId: "bridge-turn",
      transcriptTurnId: nativeTurnId,
      streamText: text,
    } satisfies Session["live"];
    state = {
      ...state,
      current: { ...state.current!, agent: "claude-code" },
      page: order === "history-first" ? history : state.page,
      live: order === "live-first" ? live : state.live,
    };
    const view = reader();
    expect(screen.getAllByText(text)).toHaveLength(1);
    state = { ...state, page: history, live };
    view.update();

    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(view.container.querySelector('[data-event-id="native-assistant"]')).toBeTruthy();
    expect(view.container.querySelector('[data-event-id^="session-live:"]')).toBeNull();
    // Live can be ahead of the saved transcript or replay a shorter preview.
    state = { ...state, live: { ...live, streamText: text + " Still streaming" } };
    view.update();
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(screen.getByText("Still streaming")).toBeVisible();
    expect(
      view.container.querySelector('[data-event-id="session-live:native-prompt"]'),
    ).toBeTruthy();

    state = { ...state, live: { ...live, streamText: "One native" } };
    view.update();
    expect(screen.getAllByText(text)).toHaveLength(1);
    expect(view.container.querySelector('[data-event-id^="session-live:"]')).toBeNull();

    state = { ...state, live: { ...live, transcriptTurnId: "another-prompt" } };
    view.update();
    expect(screen.getAllByText(text)).toHaveLength(2);
  },
);

it("replaces only the matching pending terminal input after the send boundary", () => {
  const text = "Repeat this prompt";
  state = {
    ...state,
    current: { ...state.current!, agent: "claude-code" },
    live: { ...state.live!, executionMode: "claude-follower", executionLocation: "terminal" },
    page: {
      ...state.page!,
      events: [
        { ...item("previous-input", text, "user-message"), turn_id: "previous-input" },
        ...state.page!.events,
      ],
    },
    pendingSend: { sessionId: "session", text, afterEventId: "initial" },
  };
  const view = reader();
  expect(screen.getAllByText(text)).toHaveLength(2);
  expect(view.container.querySelector('[data-event-id="session-pending:user"]')).toBeTruthy();

  state = {
    ...state,
    page: {
      ...state.page!,
      events: [
        ...state.page!.events,
        { ...item("new-input", text, "user-message"), turn_id: "new-input" },
      ],
    },
  };
  view.update();
  expect(screen.getAllByText(text)).toHaveLength(2);
  expect(view.container.querySelector('[data-event-id="session-pending:user"]')).toBeNull();
  expect(view.container.querySelector('[data-event-id="new-input"]')).toBeTruthy();
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
      screen.queryByRole("button", { name: webLayoutCopy["en-US"].jumpToLatest }),
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

  it("keeps the latest result above a growing sticky composer with a full-height viewport", () => {
    const view = reader();
    expect(view.viewport.style.scrollPaddingBottom).toBe("80px");
    composerHeight = 200;
    contentHeight = 1120;
    resize();
    expect(view.viewport.clientHeight).toBe(400);
    expect(view.viewport.scrollTop).toBe(720);
    expect(view.viewport.style.scrollPaddingBottom).toBe("200px");
    expect(state.control).not.toHaveBeenCalled();
  });

  it("preserves an older reading position when the sticky composer grows", () => {
    const view = reader();
    fireEvent.wheel(view.viewport, { deltaY: -200 });
    view.viewport.scrollTop = 200;
    fireEvent.scroll(view.viewport);
    composerHeight = 200;
    contentHeight = 1120;
    resize();
    expect(view.viewport.style.scrollPaddingBottom).toBe("200px");
    expect(view.viewport.scrollTop).toBe(200);
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
    const latest = screen.getByRole("button", { name: webLayoutCopy["en-US"].jumpToLatest });
    expect(latest).toBeVisible();
    fireEvent.click(latest);
    flushFrames();
    expect(view.viewport.scrollTop).toBe(900);
    expect(
      screen.queryByRole("button", { name: webLayoutCopy["en-US"].jumpToLatest }),
    ).not.toBeInTheDocument();
    contentHeight = 1500;
    resize();
    expect(view.viewport.scrollTop).toBe(1100);
  });

  it("shows an icon-only bottom control for older content without waiting for new messages", () => {
    const view = reader();
    view.viewport.scrollTop = 450;
    fireEvent.scroll(view.viewport);
    const bottom = screen.getByRole("button", { name: webLayoutCopy["en-US"].jumpToLatest });
    expect(bottom).toBeVisible();
    expect(bottom.textContent).toBe("");
    expect(screen.queryByText(webLayoutCopy["en-US"].jumpToLatest)).not.toBeInTheDocument();
    fireEvent.click(bottom);
    flushFrames();
    expect(view.viewport.scrollTop).toBe(600);
    expect(
      screen.queryByRole("button", { name: webLayoutCopy["en-US"].jumpToLatest }),
    ).not.toBeInTheDocument();
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
    const loadEarlier = vi.fn(async () => {
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
    state = { ...state, earlier: loadEarlier };
    view.update();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: state.t.earlier })));
    resize();
    expect(loadEarlier).toHaveBeenCalledOnce();
    expect(screen.getByText("Older page")).toBeInTheDocument();
    expect(view.viewport.scrollTop).toBe(300);
    expect(
      screen.queryByRole("button", { name: webLayoutCopy["en-US"].jumpToLatest }),
    ).toBeVisible();
  });

  it("anchors to bottom synchronously on first mount and auto-loads earlier once near top", async () => {
    const loadEarlier = vi.fn(async () => {});
    state = {
      ...state,
      page: { ...state.page!, next_cursor: "cursor-1" },
      earlier: loadEarlier,
    };
    const view = render(<SessionReader />);
    const viewport = view.container.querySelector<HTMLElement>("section.reader-scroll")!;
    // Synchronously anchored to bottom before any animation frame fires (no top flash).
    expect(viewport.scrollTop).toBe(600);

    fireEvent.wheel(viewport, { deltaY: -500 });
    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    expect(loadEarlier).toHaveBeenCalledOnce();

    // Subsequent scroll with the same cursor does not double-trigger.
    viewport.scrollTop = 40;
    fireEvent.scroll(viewport);
    expect(loadEarlier).toHaveBeenCalledOnce();
  });
});

describe("reader active turn status", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "keeps one localized label for the same running turn in %s",
    (locale) => {
      state = {
        ...state,
        locale,
        t: conversationWords(locale),
        live: { ...state.live!, status: "running", turnId: "turn-1" },
        canStop: false,
      };
      const view = reader();
      const status = () => view.container.querySelector('[data-session-turn-status="running"]');
      expect(status()).toBeVisible();
      expect(status()).toHaveTextContent(/…/);
      expect(status()?.closest(".reader-composer")).toBeNull();
      expect(status()?.querySelector("svg")).toHaveClass("motion-safe:animate-spin");
      const text = status()?.textContent;
      state = { ...state, live: { ...state.live!, revision: 10, streamText: "Live update" } };
      view.update();
      expect(status()?.textContent).toBe(text);

      state = { ...state, live: { ...state.live!, status: "waiting-input" } };
      view.update();
      expect(status()).toBeNull();
    },
  );

  it("falls back to verified external activity when the owner has not attached", () => {
    state = {
      ...state,
      current: {
        ...state.current!,
        externalTurn: { status: "running", startedAt: "2026-11-19T07:02:00.000Z" },
      },
      live: { ...state.live!, status: "idle", ownershipReason: "claude-owner-busy" },
    };
    const view = reader();
    const status = () => view.container.querySelector('[data-session-turn-status="running"]');
    expect(status()).toBeVisible();

    state = { ...state, live: { ...state.live!, ownershipReason: undefined } };
    view.update();
    expect(status()).toBeNull();
  });
});

describe("reader compaction status belongs to the conversation", () => {
  it.each(["zh-CN", "zh-Hant", "en-US", "ja-JP"] as const)(
    "shows a single concise status after the transcript in %s",
    (locale) => {
      state = {
        ...state,
        locale,
        t: conversationWords(locale),
        live: { ...state.live!, activity: "compacting" },
      };
      const view = reader();
      const status = screen.getByText(contextUsageCopy[locale].compacting);
      expect(status).toHaveAttribute("role", "status");
      expect(status.closest(".reader-content")).not.toBeNull();
      expect(status.closest(".reader-composer")).toBeNull();
      const transcript = screen.getByText("Earlier reply");
      expect(
        transcript.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getAllByText(contextUsageCopy[locale].compacting)).toHaveLength(1);

      state = { ...state, live: { ...state.live!, activity: undefined } };
      view.update();
      expect(screen.queryByText(contextUsageCopy[locale].compacting)).not.toBeInTheDocument();
    },
  );

  it("does not show a previous session's compaction after selection changes", () => {
    state = { ...state, live: { ...state.live!, activity: "compacting" } };
    const view = reader();
    expect(screen.getByText(contextUsageCopy["en-US"].compacting)).toBeInTheDocument();
    state = {
      ...state,
      selected: "other-session",
      current: { ...state.current!, id: "other-session" },
    };
    view.update();
    expect(screen.queryByText(contextUsageCopy["en-US"].compacting)).not.toBeInTheDocument();
  });
});
