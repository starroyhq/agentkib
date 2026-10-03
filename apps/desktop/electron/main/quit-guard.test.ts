// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQuitGuard,
  QUIT_ACKNOWLEDGEMENT_TIMEOUT_MS,
  type QuitGuardWindow,
} from "./quit-guard";

function fakeWindow(overrides: Partial<QuitGuardWindow> = {}): QuitGuardWindow {
  return {
    isAlive: () => true,
    isUnresponsive: () => false,
    show: vi.fn(),
    sendQuitRequest: vi.fn(),
    ...overrides,
  };
}

describe("createQuitGuard", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("quits immediately without a live renderer", () => {
    const approveQuit = vi.fn();
    const guard = createQuitGuard({ approveQuit });
    guard.request(undefined);
    guard.request(fakeWindow({ isAlive: () => false }));
    expect(approveQuit).toHaveBeenCalledTimes(2);
  });

  it("quits immediately when Electron already reports the renderer unresponsive", () => {
    const approveQuit = vi.fn();
    const window = fakeWindow({ isUnresponsive: () => true });
    createQuitGuard({ approveQuit }).request(window);
    expect(approveQuit).toHaveBeenCalledOnce();
    expect(window.sendQuitRequest).not.toHaveBeenCalled();
  });

  it("waits for the renderer once it acknowledges, however long the user takes", () => {
    const approveQuit = vi.fn();
    const window = fakeWindow();
    const guard = createQuitGuard({ approveQuit });
    guard.request(window);
    expect(window.sendQuitRequest).toHaveBeenCalledOnce();
    guard.acknowledged();
    vi.advanceTimersByTime(QUIT_ACKNOWLEDGEMENT_TIMEOUT_MS * 10);
    expect(approveQuit).not.toHaveBeenCalled();
  });

  it("does not give up on a renderer that is briefly busy", () => {
    const approveQuit = vi.fn();
    const guard = createQuitGuard({ approveQuit });
    guard.request(fakeWindow());
    vi.advanceTimersByTime(5_000);
    expect(approveQuit).not.toHaveBeenCalled();
    guard.acknowledged();
    vi.advanceTimersByTime(QUIT_ACKNOWLEDGEMENT_TIMEOUT_MS);
    expect(approveQuit).not.toHaveBeenCalled();
  });

  it("quits when the renderer crashes or hangs while the quit request is pending", () => {
    const approveQuit = vi.fn();
    const guard = createQuitGuard({ approveQuit });
    guard.rendererUnavailable();
    expect(approveQuit).not.toHaveBeenCalled();
    guard.request(fakeWindow());
    guard.rendererUnavailable();
    expect(approveQuit).toHaveBeenCalledOnce();
  });

  it("falls back to quitting when no acknowledgement ever arrives", () => {
    const approveQuit = vi.fn();
    const onTimeout = vi.fn();
    const guard = createQuitGuard({ approveQuit, onTimeout });
    guard.request(fakeWindow());
    vi.advanceTimersByTime(QUIT_ACKNOWLEDGEMENT_TIMEOUT_MS);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(approveQuit).toHaveBeenCalledOnce();
  });

  it("does not send a second quit request while waiting for an acknowledgement", () => {
    const window = fakeWindow();
    const guard = createQuitGuard({ approveQuit: vi.fn() });
    guard.request(window);
    guard.request(window);
    expect(window.sendQuitRequest).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledTimes(2);
  });
});
