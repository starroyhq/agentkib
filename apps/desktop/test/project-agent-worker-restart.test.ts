import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import {
  OrchestrationService,
  type LaneHost,
  type WorkerRestartRequest,
  type WorkerRestartResult,
} from "../../../packages/backend/src/orchestration-service";

const owner = { sessionId: "lead", deviceId: "desktop-local", workspaceId: "workspace" };
const worker = "worker";
const hour = 60 * 60_000;
const now = Date.parse("2026-11-21T00:00:00Z");
const accepted: WorkerRestartResult = { accepted: true, controlOutcome: "accepted" };

let dataDir: string;
const services: OrchestrationService[] = [];
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "agentkib-worker-restart-"));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  vi.useRealTimers();
  rmSync(dataDir, { recursive: true, force: true });
});

function fixture(agent = "codex") {
  const live: Record<string, unknown> = {
    executionLocation: "agentkib",
    workspaceId: owner.workspaceId,
    runtimeBootId: "worker-boot",
    revision: 12,
    status: "running",
    turnId: "turn",
  };
  const restart = vi.fn<NonNullable<LaneHost["restart"]>>(async (_request, beforeDispatch) => {
    beforeDispatch();
    return accepted;
  });
  const sent = vi.fn(() => false);
  const host: LaneHost = {
    antigravityAcpEnabled: agent === "antigravity",
    restart,
    live: async () => live,
    control: async () => {
      throw new Error("unexpected ordinary session control");
    },
    events: async () => [],
    session: (id) => ({
      agent: id === owner.sessionId ? "claude-code" : agent,
      workspaceId: owner.workspaceId,
      title: null,
    }),
    managed: async () => true,
    workspaces: () => [{ id: owner.workspaceId, name: "Workspace" }],
  };
  const open = (boot = "boot-1") => {
    const service = new OrchestrationService(
      dataDir,
      boot,
      host,
      (id) => id === owner.sessionId,
      sent,
    );
    services.push(service);
    return service;
  };
  return { open, live, restart, sent };
}

async function assign(service: OrchestrationService) {
  await service.assignWorkers({ ...owner, workers: [worker] });
}

async function restart(service: OrchestrationService, name = "worker-1") {
  const result = await service.call(owner.sessionId, "worker_restart", { worker: name });
  return JSON.parse(result.text);
}

describe("Project Agent Worker restart", () => {
  it.each(["codex", "claude-code", "devin"])(
    "binds a supported %s restart to the assigned session, revision and device",
    async (agent) => {
      const f = fixture(agent);
      const service = f.open();
      await assign(service);
      const reply = await restart(service);
      expect(reply).toMatchObject({ accepted: true, requestId: expect.any(String) });
      expect(f.restart.mock.calls[0]?.[0]).toEqual({
        ...owner,
        sessionId: worker,
        requestId: reply.requestId,
        runtimeBootId: "worker-boot",
        expectedRevision: 12,
        turnId: "turn",
        experimentalEnabled: true,
      });
      expect(service.status(owner.sessionId)?.records).toContainEqual(
        expect.objectContaining({
          kind: "restart",
          requestId: reply.requestId,
          outcome: "accepted",
        }),
      );
      expect(f.sent).toHaveBeenCalledExactlyOnceWith(
        owner.sessionId,
        owner.deviceId,
        expect.stringContaining("restart action accepted"),
        expect.any(Function),
        expect.stringMatching(/^[a-f0-9-]{36}$/),
      );
    },
  );

  it.each(["deepseek-harness", "antigravity"])(
    "does not dispatch a restart for an AgentKib-run %s Worker",
    async (agent) => {
      const f = fixture(agent);
      const service = f.open();
      await assign(service);
      expect(await restart(service)).toEqual({
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "worker-restart-unsupported",
      });
      expect(f.restart).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["claude-code", "terminal", "claude-follower"],
    ["codex", "external", "codex-follower"],
    ["deepseek-harness", "external", "dsh-follower"],
    ["devin", "external", "devin-managed"],
    ["antigravity", "external", "acp-managed"],
  ])("leaves the %s %s Worker to the user and reports only once", async (agent, location, mode) => {
    const f = fixture(agent);
    const service = f.open();
    await assign(service);
    f.live.executionLocation = location;
    f.live.executionMode = mode;
    expect(await restart(service)).toEqual({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "worker-restart-user-only",
    });
    expect(await restart(service)).toEqual({
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "worker-restart-user-only",
    });
    expect(f.restart).not.toHaveBeenCalled();
    expect(f.sent).toHaveBeenCalledExactlyOnceWith(
      owner.sessionId,
      owner.deviceId,
      expect.stringContaining("requires user action"),
      expect.any(Function),
      expect.stringMatching(/^[a-f0-9-]{36}$/),
    );
  });

  it("rejects an unassigned name, a moved workspace and paused delegation", async () => {
    const f = fixture();
    const service = f.open();
    await assign(service);
    expect(await restart(service, "worker-2")).toMatchObject({ reason: "worker-not-assigned" });
    f.live.workspaceId = "other";
    expect(await restart(service)).toMatchObject({ reason: "workspace-not-allowed" });
    f.live.workspaceId = owner.workspaceId;
    service.pause(owner.sessionId);
    expect(await restart(service)).toMatchObject({ reason: "delegation-paused" });
    expect(f.restart).not.toHaveBeenCalled();
  });

  it("rechecks delegation before dispatch and never consumes an attempt on refusal", async () => {
    const f = fixture();
    const service = f.open();
    await assign(service);
    f.restart.mockImplementationOnce(async (_request, beforeDispatch) => {
      service.pause(owner.sessionId);
      beforeDispatch();
      throw new Error("unexpected dispatch");
    });
    expect(await restart(service)).toMatchObject({ reason: "delegation-paused" });
    expect(service.status(owner.sessionId)?.records.some(({ kind }) => kind === "restart")).toBe(
      false,
    );
    service.resume(owner.sessionId, owner.deviceId);
    for (let i = 0; i < 3; i++) expect(await restart(service)).toMatchObject({ accepted: true });
  });

  it.each(["auto-turn-limit", "restart-confirmation-required"])(
    "keeps a revoked device paused after a user message during %s",
    async (reason) => {
      const f = fixture();
      const service = f.open();
      await assign(service);
      service.pause(owner.sessionId, reason);
      service.invalidateDevice(owner.deviceId);
      service.userSpoke(owner.sessionId);
      expect(await restart(service)).toMatchObject({
        reason: "delegation-paused",
        why: "authorization-changed",
      });
      expect(f.restart).not.toHaveBeenCalled();
    },
  );

  it("does not dispatch a second restart while the first waits for its receipt", async () => {
    const f = fixture();
    const service = f.open();
    await assign(service);
    let finish!: (result: WorkerRestartResult) => void;
    f.restart.mockImplementationOnce(async (_request, beforeDispatch) => {
      beforeDispatch();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = restart(service);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(await restart(service)).toMatchObject({ reason: "worker-restart-in-progress" });
    finish(accepted);
    expect(await first).toMatchObject({ accepted: true });
    expect(f.restart).toHaveBeenCalledTimes(1);
  });

  it("enforces a rolling three-attempt budget across reassignment and host restart", async () => {
    const f = fixture();
    const original = f.open();
    await assign(original);
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(now + i * 60_000);
      expect(await restart(original)).toMatchObject({ accepted: true });
    }
    original.removeWorker(owner.sessionId, worker);
    await assign(original);
    await original.close();

    const restored = f.open("boot-2");
    restored.resume(owner.sessionId, owner.deviceId);
    vi.setSystemTime(now + hour - 1);
    const limited = {
      accepted: false,
      controlOutcome: "not-dispatched",
      reason: "worker-restart-rate-limit",
      retryAt: now + hour,
    };
    expect(await restart(restored)).toEqual(limited);
    expect(await restart(restored)).toEqual(limited);
    expect(f.restart).toHaveBeenCalledTimes(3);
    expect(f.sent.mock.calls).toHaveLength(4);
    expect(f.sent).toHaveBeenLastCalledWith(
      owner.sessionId,
      owner.deviceId,
      expect.stringContaining("Requires user action"),
      expect.any(Function),
      expect.stringMatching(/^[a-f0-9-]{36}$/),
    );
    vi.setSystemTime(now + hour);
    expect(await restart(restored)).toMatchObject({ accepted: true });
  });

  it("blocks new restart dispatches until the ambiguous native receipt is settled", async () => {
    const f = fixture();
    const original = f.open();
    await assign(original);
    let prior!: WorkerRestartRequest;
    f.restart.mockImplementationOnce(async (request, beforeDispatch) => {
      prior = request;
      beforeDispatch();
      claimManagedCommand(dataDir, request.requestId, request.sessionId, "stop", request.deviceId, {
        operation: "stop",
        workspaceId: request.workspaceId,
      });
      return { accepted: false, controlOutcome: "unknown", reason: "control-outcome-unconfirmed" };
    });
    expect(await restart(original)).toMatchObject({
      outcome: "unknown",
      requestId: prior.requestId,
    });
    await original.close();

    const restored = f.open("boot-2");
    restored.resume(owner.sessionId, owner.deviceId);
    expect(await restart(restored)).toEqual({
      accepted: false,
      controlOutcome: "unknown",
      reason: "worker-restart-outcome-unknown",
      outcome: "unknown",
      requestId: prior.requestId,
    });
    expect(f.restart).toHaveBeenCalledTimes(1);
    dispatchManagedCommand(dataDir, prior.requestId);
    expect(await restart(restored)).toMatchObject({
      outcome: "unknown",
      requestId: prior.requestId,
    });
    expect(f.restart).toHaveBeenCalledTimes(1);
    finishManagedCommand(dataDir, prior.requestId, accepted);
    expect(await restart(restored)).toMatchObject({ accepted: true });
    expect(f.restart).toHaveBeenCalledTimes(2);
  });
});
