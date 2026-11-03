// @vitest-environment jsdom
import { useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscriptFollow } from "../../../packages/session-ui/src/use-transcript-follow";

let hook: ReturnType<typeof useTranscriptFollow>;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let observers: TestResizeObserver[];
const changed = vi.fn();
class TestResizeObserver {
  targets = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
}
function Harness({
  sessionId = "one",
  version = 0,
  pending,
  enabled = true,
}: {
  sessionId?: string;
  version?: number;
  pending?: string;
  enabled?: boolean;
}) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const { following, contentRef, pause, resume, awayFromBottom } = useTranscriptFollow({
    viewportRef,
    sessionId,
    enabled,
    layoutVersion: [version, pending],
    onFollowingChange: changed,
  });
  useLayoutEffect(() => {
    hook = { following, contentRef, pause, resume, awayFromBottom };
  });
  return (
    <>
      <button onClick={pause}>Load earlier</button>
      <button onClick={resume}>Latest</button>
      <section ref={viewportRef} data-testid="viewport" tabIndex={0}>
        <div ref={contentRef} data-testid="content">
          <p>{pending || "Native message"}</p>
          <textarea aria-label="Editable child" />
          <div contentEditable suppressContentEditableWarning data-testid="editable">
            Editable
          </div>
          <pre data-testid="terminal" style={{ overflowY: "auto" }}>
            Nested output
          </pre>
        </div>
      </section>
    </>
  );
}
function geometry() {
  const viewport = screen.getByTestId("viewport");
  const state = { top: 600, height: 400, content: 1000, writes: 0 };
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => state.height },
    scrollHeight: { configurable: true, get: () => state.content },
    scrollTop: {
      configurable: true,
      get: () => state.top,
      set: (value: number) => {
        state.top = Math.max(0, Math.min(value, state.content - state.height));
        state.writes++;
      },
    },
  });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue({ right: 800 } as DOMRect);
  return { viewport, state };
}
function flushFrame() {
  act(() => {
    const current = [...frames.values()];
    frames.clear();
    current.forEach((callback) => callback(performance.now()));
  });
}
function resize(element: Element) {
  act(() => {
    for (const observer of observers)
      if (observer.targets.has(element))
        observer.callback(
          [{ target: element } as ResizeObserverEntry],
          observer as unknown as ResizeObserver,
        );
  });
}
function advance(ms = 501) {
  act(() => vi.advanceTimersByTime(ms));
}

describe("transcript reader following", () => {
  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    observers = [];
    changed.mockReset();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps pending messages and native replacements at the bottom despite layout scrolls", () => {
    const view = render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    state.content = 1150;
    view.rerender(<Harness pending="Local send" />);
    // Browser anchoring/layout generates a scroll with no preceding reader input.
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(true);
    flushFrame();
    expect(state.top).toBe(750);
    state.content = 1250;
    view.rerender(<Harness version={1} />);
    fireEvent.scroll(viewport);
    flushFrame();
    expect(state.top).toBe(850);
    expect(changed).not.toHaveBeenCalledWith(false);
  });

  it("reports the actual distance threshold without new messages or changing follow intent", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    expect(hook.awayFromBottom).toBe(false);
    state.top = 505;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(false);
    state.top = 504;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(true);
    expect(hook.following.current).toBe(true);
    state.top = 600;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(false);
  });

  it("updates distance after paused viewport and content resizing", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    fireEvent.click(screen.getByText("Load earlier"));
    state.top = 400;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(true);
    state.height = 550;
    resize(viewport);
    expect(hook.awayFromBottom).toBe(false);
    state.content = 1200;
    resize(screen.getByTestId("content"));
    expect(hook.awayFromBottom).toBe(true);
    expect(state.top).toBe(400);
    expect(frames.size).toBe(0);
  });

  it("clears distance only after Latest actually returns to the bottom", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    fireEvent.click(screen.getByText("Load earlier"));
    state.top = 300;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(true);
    fireEvent.click(screen.getByText("Latest"));
    expect(hook.awayFromBottom).toBe(true);
    flushFrame();
    expect(state.top).toBe(600);
    expect(hook.awayFromBottom).toBe(false);
  });

  it("keeps short transcripts near the bottom and ignores nested output scrolls", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    state.top = 300;
    fireEvent.scroll(screen.getByTestId("terminal"), { bubbles: true });
    expect(hook.awayFromBottom).toBe(false);
    state.top = 0;
    state.content = 200;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(false);
    resize(viewport);
    flushFrame();
    expect(hook.awayFromBottom).toBe(false);
  });

  it("isolates distance across session switches, disabling and stale resize callbacks", () => {
    const view = render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    state.top = 300;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(true);
    const old = observers.at(-1)!;
    view.rerender(<Harness sessionId="two" />);
    expect(hook.awayFromBottom).toBe(false);
    act(() => old.callback([], old as unknown as ResizeObserver));
    expect(hook.awayFromBottom).toBe(false);
    flushFrame();
    expect(state.top).toBe(600);
    state.top = 300;
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(true);
    const disabled = observers.at(-1)!;
    view.rerender(<Harness sessionId="two" enabled={false} />);
    expect(hook.awayFromBottom).toBe(false);
    act(() => disabled.callback([], disabled as unknown as ResizeObserver));
    fireEvent.scroll(viewport);
    expect(hook.awayFromBottom).toBe(false);
  });

  it("observes both viewport and content and coalesces resize frames", () => {
    render(<Harness />);
    const { viewport, state } = geometry();
    flushFrame();
    const content = screen.getByTestId("content");
    expect(observers.some((o) => o.targets.has(viewport) && o.targets.has(content))).toBe(true);
    state.height = 300;
    resize(viewport);
    resize(viewport);
    resize(content);
    expect(frames.size).toBe(1);
    flushFrame();
    expect(state.top).toBe(700);
    state.content = 1300;
    resize(content);
    flushFrame();
    expect(state.top).toBe(1000);
  });

  it("cancels a queued follow when the reader wheels upward and preserves history during updates", () => {
    const view = render(<Harness />);
    const { viewport, state } = geometry();
    flushFrame();
    state.content = 1200;
    resize(screen.getByTestId("content"));
    expect(frames.size).toBe(1);
    fireEvent.wheel(viewport, { deltaY: -180 });
    state.top = 400;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(false);
    expect(frames.size).toBe(0);
    state.content = 1500;
    view.rerender(<Harness version={1} pending="New row" />);
    resize(viewport);
    resize(screen.getByTestId("content"));
    advance();
    flushFrame();
    expect(state.top).toBe(400);
  });

  it("recovers after the only resize occurs inside a short input window", () => {
    render(<Harness />);
    const { viewport, state } = geometry();
    flushFrame();
    fireEvent.wheel(viewport, { deltaY: 1 });
    state.height = 300;
    resize(viewport);
    expect(frames.size).toBe(0);
    advance();
    expect(frames.size).toBe(1);
    flushFrame();
    expect(state.top).toBe(700);
  });

  it("resumes after natural scrolling back to the bottom", () => {
    render(<Harness />);
    const { viewport, state } = geometry();
    flushFrame();
    fireEvent.wheel(viewport, { deltaY: -200 });
    state.top = 300;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(false);
    fireEvent.wheel(viewport, { deltaY: 300 });
    state.top = 600;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(true);
    state.content = 1100;
    resize(viewport);
    advance();
    flushFrame();
    expect(state.top).toBe(700);
  });

  it("Latest restores following after a history pause", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    fireEvent.click(screen.getByText("Load earlier"));
    state.top = 300;
    state.content = 1300;
    fireEvent.scroll(viewport);
    resize(viewport);
    flushFrame();
    expect(state.top).toBe(300);
    fireEvent.click(screen.getByText("Latest"));
    flushFrame();
    expect(state.top).toBe(900);
    expect(hook.following.current).toBe(true);
  });

  it("does not let programmatic scrolling restore a paused history reader", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    fireEvent.keyDown(viewport, { key: " " });
    fireEvent.click(screen.getByText("Load earlier"));
    state.top = 600;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(false);
    advance();
    expect(frames.size).toBe(0);
  });

  it.each(["PageUp", "Home", "ArrowUp"])(
    "honors %s reader navigation but ignores editing keys",
    (key) => {
      render(<Harness />);
      const { state, viewport } = geometry();
      flushFrame();
      fireEvent.keyDown(screen.getByLabelText("Editable child"), { key });
      fireEvent.keyDown(screen.getByTestId("editable"), { key });
      state.content = 1200;
      fireEvent.scroll(viewport);
      expect(hook.following.current).toBe(true);
      fireEvent.keyDown(viewport, { key });
      state.top = 200;
      fireEvent.scroll(viewport);
      expect(hook.following.current).toBe(false);
    },
  );

  it("ignores wheels consumed by nested terminal scrolling", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    const terminal = screen.getByTestId("terminal");
    Object.defineProperties(terminal, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 400 },
      scrollTop: { value: 150 },
    });
    state.content = 1200;
    fireEvent.wheel(terminal, { deltaY: -100 });
    fireEvent.scroll(viewport);
    resize(viewport);
    flushFrame();
    expect(hook.following.current).toBe(true);
    expect(state.top).toBe(800);
  });

  it("keeps keyboard navigation scoped to the focusable reader", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    viewport.focus();
    fireEvent.keyDown(viewport, { key: "PageUp" });
    state.top = 200;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(false);
    fireEvent.click(screen.getByText("Latest"));
    flushFrame();
    fireEvent.keyDown(document.body, { key: "PageUp" });
    state.content = 1200;
    fireEvent.scroll(viewport);
    resize(viewport);
    flushFrame();
    expect(hook.following.current).toBe(true);
    expect(state.top).toBe(800);
  });

  it("recognizes a scrollbar drag and touch scrolling", () => {
    render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    fireEvent.pointerDown(viewport, { clientX: 795 });
    state.top = 250;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(false);
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByText("Latest"));
    flushFrame();
    fireEvent.touchStart(viewport, { touches: [{ clientY: 100 }] });
    fireEvent.touchMove(viewport, { touches: [{ clientY: 200 }] });
    state.top = 200;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(false);
    fireEvent.touchEnd(viewport);
  });

  it("switches session with no old timer or frame and resets follow intent", () => {
    const view = render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    fireEvent.wheel(viewport, { deltaY: -100 });
    state.top = 250;
    fireEvent.scroll(viewport);
    expect(hook.following.current).toBe(false);
    const old = observers.at(-1)!;
    view.rerender(<Harness sessionId="two" />);
    expect(old.disconnected).toBe(true);
    expect(hook.following.current).toBe(true);
    flushFrame();
    expect(state.top).toBe(600);
    advance();
    expect(frames.size).toBe(0);
  });

  it("disconnects observers, listeners, input timers and frames on unmount", () => {
    const view = render(<Harness />);
    const { state, viewport } = geometry();
    flushFrame();
    fireEvent.wheel(viewport, { deltaY: 1 });
    state.height = 300;
    resize(viewport);
    view.unmount();
    advance();
    flushFrame();
    expect(observers.every((o) => o.disconnected)).toBe(true);
    expect(state.top).toBe(600);
    expect(frames.size).toBe(0);
  });

  it("still responds to committed layout inputs without ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const view = render(<Harness />);
    const { state } = geometry();
    flushFrame();
    state.content = 1250;
    view.rerender(<Harness pending="Local row" />);
    flushFrame();
    expect(state.top).toBe(850);
  });
});
