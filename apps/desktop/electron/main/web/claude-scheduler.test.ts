import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeHostScheduler,
  type ClaudeScheduledSession,
  type ClaudeScheduleAuthority,
} from "./claude-scheduler";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const session: ClaudeScheduledSession = {
    sessionId: "session",
    workspaceId: "workspace",
    runtimeBootId: "runtime",
    revision: 7,
    paused: false,
    next: {
      itemId: "work",
      requestId: "request",
      deviceId: "phone",
      kind: "queue",
      requiresAttachments: true,
    },
  };
  const invoke = vi.fn(async (input: unknown): Promise<unknown> => {
    const value = input as Record<string, unknown>;
    if (value.operation === "schedule-list") return { sessions: [structuredClone(session)] };
    if (value.operation === "schedule-prepare")
      return { accepted: true, permitId: "permit", expectedRevision: 8, runtimeBootId: "runtime" };
    return { accepted: true };
  });
  const authority: ClaudeScheduleAuthority = {
    owns: (id) => id === "phone",
    authorize: vi.fn(async () => {}),
    reserve: vi.fn(() => true),
    release: vi.fn(),
    settled: vi.fn(async () => {}),
  };
  const scheduler = new ClaudeHostScheduler(invoke);
  const unregister = scheduler.register(authority);
  cleanups.push(unregister);
  return {
    session,
    invoke,
    authority,
    scheduler,
    unregister,
    operations: () =>
      invoke.mock.calls.map(([value]) => (value as Record<string, unknown>).operation),
  };
}
describe("shared Claude host scheduler", () => {
  it("authorizes the original device before prepare and again immediately before dispatch", async () => {
    const f = fixture();
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list", "schedule-prepare", "schedule-dispatch"]);
    expect(f.authority.authorize).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({
        deviceId: "phone",
        expectedRevision: 8,
        permitId: "permit",
        requestId: "request",
      }),
    );
    expect(f.authority.release).toHaveBeenCalledWith("session");
  });
  it("coalesces ticks and fences a revoke that races the asynchronous native handshake", async () => {
    const f = fixture();
    let ready!: () => void;
    let prepare!: (value: unknown) => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.invoke.mockImplementation(async (input) => {
      const value = input as Record<string, unknown>;
      if (value.operation === "schedule-list") return { sessions: [f.session] };
      if (value.operation === "schedule-prepare") {
        ready();
        return new Promise((resolve) => {
          prepare = resolve;
        });
      }
      return { accepted: true };
    });
    const tick = f.scheduler.tick();
    expect(f.scheduler.tick()).toBe(tick);
    await started;
    await f.scheduler.invalidate("phone");
    prepare({ accepted: true, permitId: "permit", expectedRevision: 8, runtimeBootId: "runtime" });
    await tick;
    expect(f.operations()).not.toContain("schedule-dispatch");
    expect(f.operations()).toContain("schedule-invalidate");
    expect(f.operations()).toContain("schedule-pause");
  });
  it("tells the backend when the host stops because the app quits", async () => {
    const f = fixture();
    await f.scheduler.invalidate("phone", "host-stopped");
    await f.scheduler.invalidate("phone", "host-stopped", true);
    expect(
      f.invoke.mock.calls
        .map(([value]) => value as Record<string, unknown>)
        .filter((value) => value.operation === "schedule-invalidate"),
    ).toEqual([
      { operation: "schedule-invalidate", deviceId: "phone" },
      { operation: "schedule-invalidate", deviceId: "phone", quitting: true },
    ]);
  });
  it("does not consume work after workspace, attachment or device authorization fails", async () => {
    const f = fixture();
    vi.mocked(f.authority.authorize).mockRejectedValueOnce(new Error("attachment revoked"));
    await f.scheduler.tick();
    expect(f.operations()).not.toContain("schedule-prepare");
    expect(f.operations()).not.toContain("schedule-dispatch");
    expect(f.operations()).toContain("schedule-pause");
    expect(f.authority.release).toHaveBeenCalledOnce();
  });
  it("pauses an unknown dispatch and never retries it within the same tick", async () => {
    const f = fixture();
    f.invoke.mockImplementation(async (input) => {
      const value = input as Record<string, unknown>;
      if (value.operation === "schedule-list") return { sessions: [f.session] };
      if (value.operation === "schedule-prepare")
        return {
          accepted: true,
          permitId: "permit",
          expectedRevision: 8,
          runtimeBootId: "runtime",
        };
      if (value.operation === "schedule-dispatch") throw new Error("response lost");
      return { accepted: true };
    });
    await f.scheduler.tick();
    expect(f.operations().filter((operation) => operation === "schedule-dispatch")).toHaveLength(1);
    expect(f.invoke).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: "schedule-pause", reason: "scheduled-outcome-unknown" }),
    );
  });
  it("respects restart pause and human command admission", async () => {
    const f = fixture();
    f.session.paused = true;
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list"]);
    f.session.paused = false;
    vi.mocked(f.authority.reserve).mockReturnValue(false);
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list", "schedule-list"]);
  });
  it("settles receipts when the native turn no longer presents runnable work", async () => {
    const f = fixture();
    await f.scheduler.tick();
    vi.mocked(f.authority.settled).mockClear();
    f.session.next = null;
    await f.scheduler.tick();
    expect(f.authority.settled).toHaveBeenCalledWith("session");
  });
});
