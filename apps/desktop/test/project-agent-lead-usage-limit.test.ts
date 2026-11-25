import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LeadReportNotDispatched,
  MessageLeadReports,
} from "../../../packages/backend/src/message-lead-reports";
import {
  OrchestrationService,
  type LaneHost,
} from "../../../packages/backend/src/orchestration-service";

const owner = { sessionId: "lead", deviceId: "desktop-local", workspaceId: "workspace" };
const worker = "worker";
const start = new Date("2026-11-21T00:00:00.000Z");

let directory: string;
const services: OrchestrationService[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agentkib-lead-limit-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

type LimitSignal = OrchestrationService["leadLimited"];

function harness(
  agent: "codex" | "deepseek-harness" | "claude-code",
  initialLive: Record<string, unknown>,
  limited: LimitSignal = () => false,
  sendReport: OrchestrationService["sendReport"] = () => false,
) {
  let readLead = async () => initialLive;
  const delivered = vi.fn(sendReport);
  const lanes: LaneHost = {
    control: async () => ({}),
    live: async (id) => (id === owner.sessionId ? readLead() : { status: "idle" }),
    events: async () => [],
    session: (id) => ({
      agent: id === owner.sessionId ? agent : "codex",
      workspaceId: owner.workspaceId,
      title: null,
    }),
    managed: async () => true,
    workspaces: () => [{ id: owner.workspaceId, name: "Workspace" }],
  };
  function open(bootId: string) {
    const service = new OrchestrationService(
      directory,
      bootId,
      lanes,
      (id) => id === owner.sessionId,
      delivered,
      () => 0,
      limited,
    );
    services.push(service);
    return service;
  }
  return {
    open,
    delivered,
    read: (next: () => Promise<Record<string, unknown>>) => {
      readLead = next;
    },
  };
}

async function prepare(service: OrchestrationService) {
  service.designate({ ...owner, scope: {} });
  await service.assignWorkers({ ...owner, workers: [worker] });
}

function report(service: OrchestrationService, turnId: string, reply: string) {
  return service.laneTurnEnded(worker, turnId, "completed", null, undefined, reply);
}

const codexIdle = { status: "idle", executionMode: "codex-managed", sendEnabled: true };
const armed = {
  ...codexIdle,
  usageLimit: {
    kind: "weekly",
    resetsAt: start.getTime() + 60_000,
    continueAt: start.getTime() + 90_000,
    manual: null,
  },
};
const cleared = { ...codexIdle, usageLimit: null };

describe("a Project Agent at its own usage limit", () => {
  it("keeps delegation paused until a terminal lead accepts the held reports", async () => {
    let limited = true;
    const accepted = Promise.withResolvers<boolean>();
    const runtime = harness(
      "claude-code",
      {
        status: "idle",
        executionMode: "claude-follower",
        executionLocation: "terminal",
        terminalSend: true,
      },
      () => limited,
      () => accepted.promise,
    );
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Done.");
    limited = false;
    service.limitEnded(owner.sessionId);
    await vi.waitFor(() => expect(runtime.delivered).toHaveBeenCalledTimes(1));
    expect(service.status(owner.sessionId)).toMatchObject({ paused: true, reason: "usage-limit" });
    expect(service.roles().get(owner.sessionId)).toHaveProperty("recovering", true);
    expect(
      JSON.parse(
        (
          await service.call(owner.sessionId, "worker_send", {
            worker: "worker-1",
            text: "New work",
          })
        ).text,
      ),
    ).toMatchObject({ accepted: false, reason: "delegation-paused" });
    accepted.resolve(false);
    await vi.waitFor(() => expect(service.status(owner.sessionId)?.paused).toBe(false));
  });

  it("rechecks a terminal that reconnects without an explicit limit-ended callback", async () => {
    let limited = true;
    const terminal = {
      status: "idle",
      executionMode: "claude-follower",
      executionLocation: "terminal",
      terminalSend: true,
    };
    const runtime = harness("claude-code", terminal, () => limited);
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Done.");
    limited = false;
    await service.catchUp();
    expect(runtime.delivered).not.toHaveBeenCalled();
    runtime.read(async () => ({ ...terminal, leadReportsPaused: false }));
    await service.catchUp();
    expect(runtime.delivered).toHaveBeenCalledTimes(1);
    expect(service.status(owner.sessionId)?.paused).toBe(false);
  });

  it("retries a confirmed unsent report and waits for reports added during recovery", async () => {
    const first = Promise.withResolvers<boolean>();
    const second = Promise.withResolvers<boolean>();
    let dispatch = 0;
    const runtime = harness(
      "codex",
      cleared,
      () => false,
      () => {
        dispatch++;
        if (dispatch === 1) throw new LeadReportNotDispatched("session-unavailable");
        return dispatch === 2 ? first.promise : second.promise;
      },
    );
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "First reply.");
    expect(service.status(owner.sessionId)).toMatchObject({
      paused: true,
      reason: "report-undelivered",
    });
    const recovery = service.catchUp();
    await vi.waitFor(() => expect(runtime.delivered).toHaveBeenCalledTimes(2));
    await report(service, "second", "Second reply.");
    expect(service.status(owner.sessionId)?.paused).toBe(true);
    first.resolve(false);
    await vi.waitFor(() => expect(runtime.delivered).toHaveBeenCalledTimes(3));
    expect(service.status(owner.sessionId)?.paused).toBe(true);
    second.resolve(false);
    await recovery;
    await vi.waitFor(() => expect(service.status(owner.sessionId)?.paused).toBe(false));
    expect(runtime.delivered.mock.calls[1]?.[2]).toContain("First reply.");
    expect(runtime.delivered.mock.calls[2]?.[2]).toContain("Second reply.");
    expect(service.status(owner.sessionId)?.pendingReports).toEqual([]);
  });

  it.each(["user-paused", "authorization-changed"])(
    "leaves %s in place when an in-flight report settles",
    async (reason) => {
      let limited = true;
      const accepted = Promise.withResolvers<boolean>();
      const runtime = harness(
        "codex",
        cleared,
        () => limited,
        () => accepted.promise,
      );
      const service = runtime.open("boot");
      await prepare(service);
      await report(service, "first", "Done.");
      limited = false;
      service.limitEnded(owner.sessionId);
      await vi.waitFor(() => expect(runtime.delivered).toHaveBeenCalledTimes(1));
      service.pause(owner.sessionId, reason);
      accepted.resolve(false);
      await service.catchUp();
      expect(service.status(owner.sessionId)).toMatchObject({ paused: true, reason });
    },
  );

  it("keeps an unconfirmed delivery held across restart without sending it again", async () => {
    let attempt = 0;
    const runtime = harness(
      "codex",
      cleared,
      () => false,
      () => {
        if (++attempt === 1) throw new LeadReportNotDispatched("session-unavailable");
        throw new Error("control-outcome-unconfirmed");
      },
    );
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Check the outcome.");
    await service.catchUp();
    expect(service.status(owner.sessionId)?.deliveringReports).toEqual([
      expect.stringContaining("Check the outcome."),
    ]);
    await service.close();
    const restored = runtime.open("new-boot");
    await restored.catchUp();
    expect(runtime.delivered).toHaveBeenCalledTimes(2);
    expect(restored.status(owner.sessionId)?.paused).toBe(true);
    expect(restored.roles().get(owner.sessionId)).not.toHaveProperty("recovering");
  });

  it("holds all Codex reports and releases them once when polling confirms the reset", async () => {
    let limited = true;
    const runtime = harness("codex", armed, () => limited);
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "First worker reply.");
    await report(service, "second", "Second worker reply.");
    expect(service.status(owner.sessionId)).toMatchObject({
      paused: true,
      reason: "usage-limit",
      autoTurns: 0,
      pendingReports: [expect.any(String), expect.any(String)],
    });
    expect(runtime.delivered).not.toHaveBeenCalled();

    await service.catchUp();
    expect(service.roles().get(owner.sessionId)).not.toHaveProperty("requiresUser");
    runtime.read(async () => ({
      ...armed,
      usageLimit: { ...armed.usageLimit, continueAt: null, manual: "cancelled" },
    }));
    await service.catchUp();
    expect(service.roles().get(owner.sessionId)).toMatchObject({ requiresUser: true });

    vi.setSystemTime(start.getTime() + 120_000);
    limited = false;
    runtime.read(async () => ({
      ...cleared,
      status: "unsupported",
      sendEnabled: false,
      reason: "codex-not-connected",
    }));
    await service.catchUp();
    expect(runtime.delivered).not.toHaveBeenCalled();
    runtime.read(async () => cleared);
    await service.catchUp();
    service.limitEnded(owner.sessionId);
    await service.catchUp();

    expect(runtime.delivered).toHaveBeenCalledExactlyOnceWith(
      owner.sessionId,
      owner.deviceId,
      expect.stringMatching(/First worker reply\.[\s\S]*Second worker reply\./),
      expect.any(Function),
    );
    expect(service.status(owner.sessionId)).toMatchObject({
      paused: false,
      reason: null,
      autoTurns: 1,
      pendingReports: [],
    });
  });

  it("deduplicates a Codex limitEnded callback during a live read", async () => {
    let limited = true;
    const runtime = harness("codex", armed, () => limited);
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Done.");

    limited = false;
    runtime.read(async () => {
      service.limitEnded(owner.sessionId);
      return cleared;
    });
    await service.catchUp();
    expect(runtime.delivered).toHaveBeenCalledTimes(1);
    expect(
      service.status(owner.sessionId)?.records.filter((record) => record.kind === "resume"),
    ).toHaveLength(1);
  });

  it("saves a Codex report that would displace a native continue in flight", async () => {
    const continuing = {
      ...armed,
      status: "running",
      usageLimit: { ...armed.usageLimit, continueAt: null },
    };
    let live: Record<string, unknown> = continuing;
    const control = vi.fn(async () => ({ accepted: true }));
    const transport = new MessageLeadReports({
      live: async () => live,
      control,
      queue: async () => null,
    });
    // The fast quota callback is false while the native continue is in flight.
    const runtime = harness("codex", continuing, () => false, transport.send.bind(transport));
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Done.");
    await vi.waitFor(() => expect(service.status(owner.sessionId)?.reason).toBe("usage-limit"));
    expect(control).not.toHaveBeenCalled();
    await service.catchUp();
    expect(service.roles().get(owner.sessionId)).not.toHaveProperty("requiresUser");

    live = cleared;
    runtime.read(async () => live);
    service.limitEnded(owner.sessionId);
    await vi.waitFor(() => expect(control).toHaveBeenCalledTimes(1));
    await service.catchUp();
    expect(control).toHaveBeenCalledTimes(1);
  });

  it("keeps a restored Codex hold until the user returns", async () => {
    let limited = true;
    const runtime = harness("codex", armed, () => limited);
    const before = runtime.open("boot");
    await prepare(before);
    await report(before, "first", "Done.");
    await before.close();

    limited = false;
    runtime.read(async () => cleared);
    const restored = runtime.open("new-boot");
    await restored.catchUp();
    expect(runtime.delivered).not.toHaveBeenCalled();
    restored.userSpoke(owner.sessionId);
    await restored.catchUp();
    expect(runtime.delivered).toHaveBeenCalledTimes(1);
  });

  it("keeps held reports out of a device that lost access", async () => {
    let limited = true;
    const runtime = harness("codex", armed, () => limited);
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Done.");
    service.invalidateDevice(owner.deviceId);

    limited = false;
    runtime.read(async () => cleared);
    await service.catchUp();
    service.limitEnded(owner.sessionId);
    service.userSpoke(owner.sessionId);
    expect(runtime.delivered).not.toHaveBeenCalled();
    expect(service.status(owner.sessionId)).toMatchObject({
      paused: true,
      reason: "authorization-changed",
      pendingReports: [expect.any(String)],
    });
  });

  it.each(["message", "panel"] as const)("retries a DSH hold once on a user %s", async (action) => {
    const runtime = harness(
      "deepseek-harness",
      { status: "idle", executionMode: "dsh-follower" },
      () => "manual-resume",
    );
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "First worker reply.");
    await report(service, "second", "Second worker reply.");
    expect(service.roles().get(owner.sessionId)).toMatchObject({
      paused: true,
      reason: "usage-limit",
      requiresUser: true,
    });
    expect(service.status(owner.sessionId)?.autoTurns).toBe(0);

    vi.setSystemTime(start.getTime() + 3_600_000);
    await service.catchUp();
    await service.catchUp();
    expect(runtime.delivered).not.toHaveBeenCalled();

    if (action === "message") {
      runtime.read(async () => ({
        status: "running",
        executionMode: "dsh-follower",
        sendEnabled: false,
        queueEnabled: false,
      }));
      service.userSpoke(owner.sessionId);
      await service.catchUp();
      expect(runtime.delivered).not.toHaveBeenCalled();
      runtime.read(async () => ({
        status: "running",
        executionMode: "dsh-follower",
        sendEnabled: false,
        queueEnabled: true,
      }));
    } else {
      service.resume(owner.sessionId, "phone-1", [owner.workspaceId], owner.workspaceId);
    }
    await service.catchUp();
    expect(runtime.delivered).toHaveBeenCalledExactlyOnceWith(
      owner.sessionId,
      action === "message" ? owner.deviceId : "phone-1",
      expect.stringMatching(/First worker reply\.[\s\S]*Second worker reply\./),
      ...(action === "message" ? [expect.any(Function)] : []),
    );
    expect(service.status(owner.sessionId)).toMatchObject({
      paused: false,
      reason: null,
      autoTurns: 1,
      pendingReports: [],
    });
    await report(service, "third", "A new report.");
    expect(runtime.delivered).toHaveBeenCalledTimes(1);
    expect(service.status(owner.sessionId)?.reason).toBe("usage-limit");
  });

  it("leaves a managed Claude Code lead's report on its existing transport queue", async () => {
    const runtime = harness(
      "claude-code",
      { ...armed, executionMode: "claude-managed" },
      () => false,
      () => true,
    );
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Done.");
    await service.catchUp();

    expect(runtime.delivered).toHaveBeenCalledTimes(1);
    expect(service.status(owner.sessionId)).toMatchObject({
      paused: false,
      reason: null,
      autoTurns: 0,
      pendingReports: [],
    });
  });
});
