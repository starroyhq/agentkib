// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSessionForegroundRefresh } from "@agentkib/session-ui";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes on focus or visibility, merging the events for the same foreground wake", () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const refresh = vi.fn();
  renderHook(() => useSessionForegroundRefresh("selected", refresh));

  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(refresh).not.toHaveBeenCalled();

  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  window.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(1);

  act(() => vi.advanceTimersByTime(300));
  window.dispatchEvent(new Event("focus"));
  expect(refresh).toHaveBeenCalledTimes(2);
});

it("uses the latest callback and stops refreshing when the selected session closes", () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const previous = vi.fn();
  const current = vi.fn();
  const { rerender } = renderHook<void, { id?: string; refresh: () => void }>(
    ({ id, refresh }) => useSessionForegroundRefresh(id, refresh),
    { initialProps: { id: "selected", refresh: previous } },
  );
  rerender({ id: "selected", refresh: current });
  window.dispatchEvent(new Event("focus"));
  expect(previous).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledTimes(1);

  rerender({ id: undefined, refresh: current });
  act(() => vi.advanceTimersByTime(300));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(current).toHaveBeenCalledTimes(1);
});
