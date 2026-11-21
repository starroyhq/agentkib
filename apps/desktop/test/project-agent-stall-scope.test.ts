import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openManagedLedger } from "../../../packages/backend/src/managed-ledger";
import {
  OrchestrationService,
  type LaneHost,
} from "../../../packages/backend/src/orchestration-service";

const owner = { sessionId: "lead", deviceId: "device", workspaceId: "workspace" };
const lanes: LaneHost = {
  control: async () => ({}),
  live: async () => ({}),
  events: async () => [],
  session: () => ({ agent: "codex", workspaceId: owner.workspaceId, title: null }),
  managed: async () => true,
  workspaces: () => [{ id: owner.workspaceId, name: "Workspace" }],
};

describe("Project Agent stall threshold", () => {
  let directory: string;
  let service: OrchestrationService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "agentkib-stall-scope-"));
    service = new OrchestrationService(directory, "boot", lanes, () => true);
  });

  afterEach(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("loads a version 1 record without a stall threshold, and saves the new setting in version 1", async () => {
    const legacy = service.registry.create({
      sessionId: owner.sessionId,
      deviceId: owner.deviceId,
      createdAt: "2026-11-21T00:00:00.000Z",
      paused: false,
      reason: null,
      scope: { workspaceIds: [owner.workspaceId], policies: [], maxLanes: 10, maxAutoTurns: 25 },
    });
    expect(legacy.scope).not.toHaveProperty("stallMinutes");
    expect(service.registry.list()[0]).toMatchObject({ version: 1, scope: { stallMinutes: 10 } });
    expect(service.status(owner.sessionId)?.scope.stallMinutes).toBe(10);

    await expect(service.update({ ...owner, scope: { stallMinutes: 3 } })).resolves.toBe(false);
    await service.update({ ...owner, scope: { maxAutoTurns: 12 } });
    const database = openManagedLedger(directory)!;
    try {
      const row = database
        .prepare("SELECT record FROM orchestration_leads WHERE session_id=?")
        .get(owner.sessionId) as { record: string };
      expect(JSON.parse(row.record)).toMatchObject({
        version: 1,
        scope: { stallMinutes: 3, maxAutoTurns: 12 },
      });
    } finally {
      database.close();
    }
  });

  it("rejects invalid settings without changing the saved threshold", async () => {
    service.designate({ ...owner, scope: { stallMinutes: 120 } });
    for (const value of [2, 121, 10.5, "10", null]) {
      await expect(
        service.update({ ...owner, scope: { stallMinutes: value as number } }),
      ).rejects.toThrow("invalid-lead-delegation");
      expect(service.status(owner.sessionId)?.scope.stallMinutes).toBe(120);
    }
  });
});
