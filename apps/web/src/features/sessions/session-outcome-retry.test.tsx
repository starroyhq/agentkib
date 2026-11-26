import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PendingControl } from "@agentkib/session-ui";
import {
  SESSION_OUTCOME_GRACE_MS,
  useSessionOutcomeRetry,
} from "../../../../../packages/session-ui/src/conversation/sessions/use-session-outcome-retry";

const start = 1_000;
const pending: PendingControl = {
  requestId: "00000000-0000-4000-8000-000000000001",
  sessionId: "session",
  kind: "send",
  createdAt: start,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(start);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("checks immediately, backs off to 30 seconds and stops when the receipt settles", async () => {
  const check = vi.fn(async () => {});
  const { rerender } = renderHook(
    ({ entries }: { entries: PendingControl[] }) =>
      useSessionOutcomeRetry("access", entries, check),
    { initialProps: { entries: [pending] } },
  );
  expect(check).toHaveBeenCalledTimes(1);
  for (const [index, delay] of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000].entries()) {
    await act(async () => vi.advanceTimersByTimeAsync(delay - 1));
    expect(check).toHaveBeenCalledTimes(index + 1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(check).toHaveBeenCalledTimes(index + 2);
  }

  rerender({ entries: [] });
  await act(async () => vi.advanceTimersByTimeAsync(2 * SESSION_OUTCOME_GRACE_MS));
  expect(check).toHaveBeenCalledTimes(8);
});

it("reaches each grace deadline with one unsettled read and ignores its late return after access changes", async () => {
  let finishRead!: () => void;
  const check = vi.fn(() => new Promise<void>((resolve) => (finishRead = resolve)));
  const entries: PendingControl[] = [
    pending,
    {
      ...pending,
      requestId: "00000000-0000-4000-8000-000000000002",
      kind: "stop",
      createdAt: start + 5_000,
    },
  ];
  const initialProps: { scope?: string } = { scope: "access" };
  const { result, rerender } = renderHook(
    ({ scope }: { scope?: string }) => useSessionOutcomeRetry(scope, entries, check),
    { initialProps },
  );
  await act(async () => vi.advanceTimersByTimeAsync(SESSION_OUTCOME_GRACE_MS - 1));
  expect(result.current).toBe(start);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(result.current).toBe(start + SESSION_OUTCOME_GRACE_MS);
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(result.current).toBe(start + SESSION_OUTCOME_GRACE_MS + 5_000);
  expect(check).toHaveBeenCalledOnce();

  rerender({ scope: undefined });
  await act(async () => finishRead());
  await act(async () => vi.advanceTimersByTimeAsync(SESSION_OUTCOME_GRACE_MS));
  expect(check).toHaveBeenCalledOnce();
});
