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
    control: async () => ({ accepted: true }),
    live: async (id) =>
      id === owner.sessionId
        ? readLead()
        : {
            status: "idle",
            executionMode: "codex-managed",
            sendEnabled: true,
            runtimeBootId: "worker-boot",
            revision: 1,
            workspaceId: owner.workspaceId,
          },
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

  it.each([
    [new LeadReportNotDispatched("session-unavailable"), "route", "session-unavailable"],
    [new Error("private fixture error"), "confirmation", "outcome-unknown"],
  ])(
    "backs off and retries the same report without pausing delegation",
    async (error, phase, code) => {
      let attempt = 0;
      const runtime = harness(
        "codex",
        cleared,
        () => false,
        () => {
          if (++attempt === 1) throw error;
          return false;
        },
      );
      const service = runtime.open("boot");
      await prepare(service);
      await report(service, "first", "Private report body.");
      const pending = service.status(owner.sessionId)!;
      expect(pending).toMatchObject({ paused: false, reason: null });
      const [entry] = pending.reportDeliveries!;
      const diagnostic = pending.records.find((item) => item.kind === "report-delivery");
      expect(diagnostic).toMatchObject({
        requestId: entry!.reportId,
        outcome: "retrying",
        reportFailure: { phase, code },
      });
      expect(JSON.stringify(diagnostic)).not.toContain("private");
      expect(JSON.stringify(diagnostic)).not.toContain("Private");
      expect(
        JSON.parse(
          (
            await service.call(owner.sessionId, "worker_send", {
              worker: "worker-1",
              text: "Continue the work",
            })
          ).text,
        ),
      ).toMatchObject({ accepted: true });
      await report(service, "second", "The next report can pass.");
      expect(runtime.delivered.mock.calls[1]?.[2]).toContain("The next report can pass.");
      await service.catchUp(entry!.retryAt! - 1);
      expect(runtime.delivered).toHaveBeenCalledTimes(2);
      await service.catchUp(entry!.retryAt!);
      expect(runtime.delivered.mock.calls.map((call) => call[4])).toEqual([
        entry!.reportId,
        expect.not.stringMatching(entry!.reportId),
        entry!.reportId,
      ]);
      expect(service.status(owner.sessionId)).toMatchObject({
        paused: false,
        reason: null,
        autoTurns: 2,
        reportDeliveries: [],
      });
    },
  );

  it("delivers large held reports in complete batches", async () => {
    const runtime = harness("codex", cleared);
    const service = runtime.open("boot");
    await prepare(service);
    service.pause(owner.sessionId);
    const reports = ["a", "b", "c"].map((letter) => letter.repeat(9_000));
    service.registry.update(owner.sessionId, (lead) => {
      lead.pendingReports = reports;
    });
    service.resume(owner.sessionId, owner.deviceId);
    expect(runtime.delivered.mock.calls.map((call) => call[2])).toEqual(reports);
    expect(new Set(runtime.delivered.mock.calls.map((call) => call[4])).size).toBe(reports.length);
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

  it("persists the report ID across service restart after an ambiguous outcome", async () => {
    let attempt = 0;
    const runtime = harness(
      "codex",
      cleared,
      () => false,
      () => {
        if (++attempt === 1) throw new Error("control-outcome-unconfirmed");
        return false;
      },
    );
    const service = runtime.open("boot");
    await prepare(service);
    await report(service, "first", "Check the outcome.");
    const [waiting] = service.status(owner.sessionId)!.reportDeliveries!;
    await service.close();
    const restored = runtime.open("boot");
    await restored.catchUp(waiting!.retryAt!);
    expect(runtime.delivered.mock.calls.map((call) => call[4])).toEqual([
      waiting!.reportId,
      waiting!.reportId,
    ]);
    expect(restored.status(owner.sessionId)).toMatchObject({
      paused: false,
      reason: null,
      reportDeliveries: [],
    });
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
      expect.any(String),
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
      receipt: () => ({ found: false }),
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
      expect.any(Function),
      expect.any(String),
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
