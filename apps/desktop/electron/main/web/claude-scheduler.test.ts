import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeHostScheduler,
  type ClaudeScheduledSession,
  type ClaudeScheduleAuthority,
} from "./claude-scheduler";
import { createWebControlState, WebAccessService } from "./service";

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

  it("leaves another desktop's browser work to the authorized desktop", async () => {
    const f = fixture();
    f.scheduler.setSharedRuntimePrimary(false);
    f.session.next!.deviceId = "other-phone";
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list"]);

    f.session.next!.deviceId = "phone";
    await f.scheduler.tick();
    expect(f.operations().slice(1)).toEqual([
      "schedule-list",
      "schedule-prepare",
      "schedule-dispatch",
    ]);
  });

  it("leaves a prepared permit to expire when a replacement desktop takes over", async () => {
    const f = fixture();
    f.scheduler.setSharedRuntimePrimary(true);
    let resolvePrepare!: (value: unknown) => void;
    f.invoke.mockImplementation(async (input) => {
      const { operation } = input as Record<string, unknown>;
      if (operation === "schedule-list") return { sessions: [f.session] };
      if (operation === "schedule-prepare")
        return new Promise((resolve) => {
          resolvePrepare = resolve;
        });
      return { accepted: true };
    });
    const tick = f.scheduler.tick();
    await expect.poll(() => f.operations().at(-1)).toBe("schedule-prepare");
    f.authority.owns = () => false;
    f.scheduler.setSharedRuntimePrimary(false);
    resolvePrepare({
      accepted: true,
      permitId: "permit",
      expectedRevision: 8,
      runtimeBootId: "runtime",
    });
    await tick;
    expect(f.operations()).toEqual(["schedule-list", "schedule-prepare"]);
    expect(f.authority.release).toHaveBeenCalledWith("session");
  });

  it("lets only the primary desktop queue a due usage-limit continuation", async () => {
    const f = fixture();
    Object.assign(f.session, { paused: true, continueAt: Date.now(), next: null });
    f.scheduler.setSharedRuntimePrimary(false);
    await f.scheduler.tick();
    expect(f.operations()).toEqual(["schedule-list"]);
    f.scheduler.setSharedRuntimePrimary(true);
    await f.scheduler.tick();
    expect(f.operations().slice(1)).toEqual(["schedule-list", "schedule-continue"]);
  });

  it("moves local scheduling to the elected Web service without pausing the shared queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "ak-shared-scheduler-"));
    const f = fixture();
    f.unregister();
    f.session.next!.deviceId = "agentkib-local-owner";
    f.session.next!.requiresAttachments = false;
    const make = (profile: string, primary: boolean) => {
      const control = createWebControlState();
      const service = new WebAccessService({
        dataDir: join(root, profile),
        staticDir: root,
        runtimeRequest: async () => ({}),
        workspaceRequest: async () => [{ id: "workspace", name: "Workspace", path: root }],
        claudeManagedRequest: f.invoke,
        enableClaudeScheduler: true,
        verifiedClaudeManaged: true,
        sharedControl: control,
      });
      service.setSharedRuntimePrimary(primary);
      return { service, scheduler: control.claudeScheduler! };
    };
    const first = make("formal", true);
    const second = make("dev", false);
    try {
      await first.service.initialize();
      await second.service.initialize();
      await second.scheduler.tick();
      expect(f.operations()).toEqual(["schedule-list"]);
      await first.scheduler.tick();
      expect(f.operations().slice(1)).toEqual([
        "schedule-list",
        "schedule-prepare",
        "schedule-dispatch",
      ]);

      first.service.setSharedRuntimePrimary(false);
      second.service.setSharedRuntimePrimary(true);
      await first.service.dispose();
      await second.scheduler.tick();
      expect(f.operations().slice(4)).toEqual([
        "schedule-list",
        "schedule-prepare",
        "schedule-dispatch",
      ]);
    } finally {
      await Promise.all([first.service.dispose(), second.service.dispose()]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
