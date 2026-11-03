import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";

const NEAR_END = 96;
const INPUT_WINDOW_MS = 500;

/** Follow is reader intent, not a conclusion drawn from layout-generated scrolls. */
export function useTranscriptFollow({
  viewportRef,
  sessionId,
  enabled,
  layoutVersion,
  onFollowingChange,
}: {
  viewportRef: RefObject<HTMLElement | null>;
  sessionId: string | undefined;
  enabled: boolean;
  layoutVersion: readonly unknown[];
  onFollowingChange?: (following: boolean) => void;
}) {
  const following = useRef(true);
  const frame = useRef<number | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputUntil = useRef(0);
  const previousSession = useRef(sessionId);
  const previousLayout = useRef<readonly unknown[]>([]);
  const notify = useRef(onFollowingChange);
  const active = useRef(enabled);
  const [content, contentRef] = useState<HTMLDivElement | null>(null);

  const cancelFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const cancelInput = useCallback(() => {
    if (settleTimer.current !== null) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    inputUntil.current = 0;
  }, []);
  const setFollowing = useCallback((value: boolean) => {
    if (following.current === value) return;
    following.current = value;
    notify.current?.(value);
  }, []);
  const schedule = useCallback(() => {
    if (!active.current || !following.current || frame.current !== null) return;
    // A wheel/drag can precede its scroll event. Do not race that input with a
    // resize-triggered frame which would pull the reader back to the bottom.
    if (performance.now() < inputUntil.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!active.current || !following.current) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const bottom = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      if (Math.abs(viewport.scrollTop - bottom) > 0.5) viewport.scrollTop = bottom;
    });
  }, [viewportRef]);
  const pause = useCallback(() => {
    cancelFrame();
    cancelInput();
    setFollowing(false);
  }, [cancelFrame, cancelInput, setFollowing]);
  const resume = useCallback(() => {
    cancelInput();
    setFollowing(true);
    schedule();
  }, [cancelInput, schedule, setFollowing]);

  useLayoutEffect(() => {
    notify.current = onFollowingChange;
    active.current = enabled;
    if (!enabled) {
      cancelFrame();
      cancelInput();
    }
    if (previousSession.current !== sessionId) {
      cancelFrame();
      cancelInput();
      previousSession.current = sessionId;
      previousLayout.current = [];
      setFollowing(true);
    }
  }, [cancelFrame, cancelInput, enabled, onFollowingChange, sessionId, setFollowing]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!enabled || !viewport) return;
    let pointerActive = false;
    let touching = false;
    let touchY = 0;
    let previousTop = viewport.scrollTop;
    const distance = () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    const intent = (up = false) => {
      cancelFrame();
      cancelInput();
      inputUntil.current = performance.now() + INPUT_WINDOW_MS;
      settleTimer.current = setTimeout(() => {
        settleTimer.current = null;
        inputUntil.current = 0;
        if (!pointerActive && !touching) schedule();
      }, INPUT_WINDOW_MS);
      previousTop = viewport.scrollTop;
      if (up && distance() >= NEAR_END) setFollowing(false);
    };
    const nestedScroll = (target: EventTarget | null, up: boolean) => {
      for (
        let node = target instanceof Element ? target : null;
        node && node !== viewport;
        node = node.parentElement
      ) {
        if (!(node instanceof HTMLElement)) continue;
        const overflow = getComputedStyle(node).overflowY;
        if (
          ["auto", "scroll", "overlay"].includes(overflow) &&
          node.scrollHeight > node.clientHeight &&
          (up ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight)
        )
          return true;
      }
      return false;
    };
    const scroll = () => {
      const top = viewport.scrollTop;
      if (pointerActive || touching || performance.now() < inputUntil.current) {
        if (distance() < NEAR_END) {
          setFollowing(true);
        } else if (top < previousTop - 0.5) pause();
      }
      previousTop = top;
    };
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.deltaY === 0) return;
      if (!nestedScroll(event.target, event.deltaY < 0)) intent(event.deltaY < 0);
    };
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented) return;
      if (
        target instanceof Element &&
        target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
      )
        return;
      const up =
        ["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey);
      const down = ["ArrowDown", "PageDown", "End", " "].includes(event.key);
      if ((up || down) && !nestedScroll(target, up)) intent(up);
    };
    const pointerdown = (event: PointerEvent) => {
      // Overlay scrollbars have no offsetWidth/clientWidth difference. Their
      // native pointer target is the viewport, unlike selections in its text.
      if (event.target !== viewport || event.clientX < viewport.getBoundingClientRect().right - 20)
        return;
      pointerActive = true;
      intent();
    };
    const pointerup = () => {
      if (pointerActive) intent();
      pointerActive = false;
    };
    const touchstart = (event: TouchEvent) => {
      if (!event.touches[0]) return;
      touching = false;
      touchY = event.touches[0].clientY;
    };
    const touchmove = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (next === undefined) return;
      touching = !nestedScroll(event.target, next > touchY);
      if (touching) intent(next > touchY);
      touchY = next;
    };
    const touchend = () => {
      const wasTouching = touching;
      touching = false;
      if (wasTouching) intent();
    };
    viewport.addEventListener("scroll", scroll, { passive: true });
    viewport.addEventListener("wheel", wheel, { passive: true });
    viewport.addEventListener("keydown", keydown);
    viewport.addEventListener("pointerdown", pointerdown, { passive: true });
    viewport.addEventListener("touchstart", touchstart, { passive: true });
    viewport.addEventListener("touchmove", touchmove, { passive: true });
    viewport.addEventListener("touchend", touchend, { passive: true });
    viewport.addEventListener("touchcancel", touchend, { passive: true });
    window.addEventListener("pointerup", pointerup, { passive: true });
    window.addEventListener("pointercancel", pointerup, { passive: true });
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(viewport);
    if (content) observer?.observe(content);
    schedule();
    return () => {
      cancelFrame();
      cancelInput();
      observer?.disconnect();
      viewport.removeEventListener("scroll", scroll);
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("keydown", keydown);
      viewport.removeEventListener("pointerdown", pointerdown);
      viewport.removeEventListener("touchstart", touchstart);
      viewport.removeEventListener("touchmove", touchmove);
      viewport.removeEventListener("touchend", touchend);
      viewport.removeEventListener("touchcancel", touchend);
      window.removeEventListener("pointerup", pointerup);
      window.removeEventListener("pointercancel", pointerup);
    };
  }, [
    cancelFrame,
    cancelInput,
    content,
    enabled,
    pause,
    schedule,
    sessionId,
    setFollowing,
    viewportRef,
  ]);

  // The list of render inputs can include pending local rows as well as native
  // events. A pending row need not advance the server's content version.
  useLayoutEffect(() => {
    const previous = previousLayout.current;
    if (
      previous.length !== layoutVersion.length ||
      layoutVersion.some((value, index) => !Object.is(value, previous[index]))
    ) {
      previousLayout.current = layoutVersion;
      schedule();
    }
  });

  return { following, contentRef, pause, resume };
}
