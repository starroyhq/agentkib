// @vitest-environment node
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalRuntimeActivity } from "../../../packages/backend/src/local-runtime-activity";
import type { LocalRuntimeTraceEvent } from "../../../packages/backend/src/local-runtime-trace";

describe("local runtime stalls", () => {
  let now: number;
  const record = vi.fn<(event: LocalRuntimeTraceEvent) => void>();
  let activity: LocalRuntimeActivity;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    activity = new LocalRuntimeActivity({ record });
    record.mockClear();
  });

  afterEach(() => {
    activity.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps the blocking request when it completes before the overdue timer", () => {
    const finish = activity.beginRequest({
      jsonrpc: "2.0",
      method: RUNTIME_METHODS.sessionRequest,
      params: {
        host: {
          request: {
            operation: "send",
            sessionId: "private-id",
            text: "private-message",
            cwd: "/private-workspace",
          },
        },
      },
    });
    now = 2_101;
    finish?.();
    vi.advanceTimersByTime(100);

    const context = {
      method: RUNTIME_METHODS.sessionRequest,
      operation: "send",
      session: expect.stringMatching(/^[0-9a-f]{16}$/),
    };
    expect(record.mock.calls).toEqual([
      [{ kind: "stall", durationMs: 2_001, active: [context], activeCount: 1 }],
      [{ kind: "request", durationMs: 2_101, ...context }],
    ]);
    expect(JSON.stringify(record.mock.calls)).not.toContain("private-");
  });

  it("distinguishes a slow asynchronous request from an event-loop stall", () => {
    const finish = activity.begin(RUNTIME_METHODS.sessionRequest, {
      operation: "/untrusted-operation",
      sessionId: "synthetic-session",
    });
    for (let tick = 0; tick < 30; tick++) {
      now += 100;
      vi.advanceTimersByTime(100);
    }
    finish?.();
    expect(record.mock.calls).toEqual([
      [
        {
          kind: "request",
          method: RUNTIME_METHODS.sessionRequest,
          session: expect.stringMatching(/^[0-9a-f]{16}$/),
          durationMs: 3_000,
        },
      ],
    ]);
    now += 2_100;
    vi.advanceTimersByTime(100);
    expect(record).toHaveBeenCalledTimes(1);
    now += 2_101;
    vi.advanceTimersByTime(100);
    expect(record).toHaveBeenLastCalledWith({
      kind: "stall",
      durationMs: 2_001,
      active: [],
      activeCount: 0,
    });
  });

  it("bounds the stall context and aliases session IDs within one runtime", () => {
    const request = [RUNTIME_METHODS.sessionsSubscribe, { sessionId: "same-session" }] as const;
    const finishes = Array.from({ length: 150 }, () => activity.begin(...request));
    now = 3_000;
    vi.advanceTimersByTime(100);
    const event = record.mock.calls[0]?.[0];
    expect(event).toMatchObject({ kind: "stall", activeCount: 150 });
    if (event?.kind !== "stall") throw new Error("Expected a stall");
    expect(event.active).toHaveLength(8);
    expect(new Set(event.active.map((context) => context.session)).size).toBe(1);
    for (const finish of finishes) finish?.();

    const anotherRuntime = new LocalRuntimeActivity({ record });
    try {
      anotherRuntime.begin(...request)?.();
      expect(record).toHaveBeenLastCalledWith(
        expect.objectContaining({ session: expect.not.stringMatching(event.active[0]!.session!) }),
      );
    } finally {
      anotherRuntime.close();
    }
  });
});
