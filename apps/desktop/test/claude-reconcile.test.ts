// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  claudeReconcileBlockReason,
  reconcileColdClaudeSession,
  runClaudeReconcile,
} from "../../../packages/backend/src/agents/claude/claude-reconcile";
import type { ClaudeRecord } from "../../../packages/backend/src/agents/claude/claude-managed-record";
import { readControlReceipt } from "../../../packages/backend/src/control-receipt";
import {
  claimManagedCommand,
  dispatchManagedCommand,
  finishManagedCommand,
  replayManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import { admitControlReceipt } from "../../../packages/backend/src/sessions/control-receipts";

it("claims the reconcile request before releasing either session's fence", async () => {
  const data = mkdtempSync(join(tmpdir(), "claude-reconcile-"));
  try {
    const requestId = randomUUID();
    const first = admitControlReceipt(data, requestId, "first session");
    const second = admitControlReceipt(data, requestId, "second session");
    expect(first.previous).toBeNull();
    expect(second.previous).toBeNull();
    const scope = {
      requestId,
      deviceId: "desktop-local",
      workspaceId: "workspace",
      runtimeBootId: "boot",
    };
    const entered = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<boolean>();
    const firstRecovery = vi.fn(() => {
      entered.resolve();
      return settled.promise;
    });
    const secondRecovery = vi.fn(async () => true);
    const read = vi
      .fn()
      .mockResolvedValueOnce({ status: "outcome-unknown" })
      .mockResolvedValue({ status: "idle" });
    const original = runClaudeReconcile(
      first,
      { ...scope, sessionId: "first" },
      read,
      firstRecovery,
    );
    await entered.promise;
    try {
      await expect(
        runClaudeReconcile(
          second,
          { ...scope, sessionId: "second" },
          async () => ({ status: "outcome-unknown" }),
          secondRecovery,
        ),
      ).rejects.toThrow("request-id-reused-with-different-input");
      expect(secondRecovery).not.toHaveBeenCalled();
    } finally {
      settled.resolve(true);
      await expect(original).resolves.toMatchObject({ sessionId: "first", reconciled: true });
    }
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

function interruptedSteering(dataDir: string, operations: string[]) {
  const inputIds = operations.map(() => randomUUID());
  const original = randomUUID();
  const record: ClaudeRecord = {
    version: 1,
    id: "adopted-session",
    workspaceId: "workspace",
    workspace: dataDir,
    registeredWorkspace: dataDir,
    home: dataDir,
    nativeId: randomUUID(),
    title: "Fixture",
    createdAt: "2026-11-28T00:00:00Z",
    adopted: true,
    terminalHandover: true,
    released: false,
    fresh: false,
    fingerprint: null,
    snapshot: {
      status: "outcome-unknown",
      turnId: original,
      turnOrigin: "host",
      reason: "claude-unrequested-turn: interrupted native input",
      pendingSteeringIds: inputIds,
      steeringRecovery: { version: 1, inputIds },
    },
    completedRequests: [original],
  };
  const owner = "desktop-local";
  const fingerprint = "e".repeat(64);
  const store = (requestId: string, operation: string, complete: boolean) => {
    claimManagedCommand(dataDir, requestId, record.id, fingerprint, owner, {
      workspaceId: record.workspaceId,
      executionMode: "claude-managed",
      operation,
      turnId: original,
    });
    dispatchManagedCommand(dataDir, requestId);
    finishManagedCommand(dataDir, requestId, {
      accepted: true,
      completed: complete,
      completionObserved: complete,
      requestId,
      sessionId: record.id,
    });
  };
  store(original, "send", true);
  operations.forEach((operation, index) => store(inputIds[index]!, operation, false));
  return { record, inputIds, original, owner, fingerprint };
}

it("explicitly retires only interrupted steering receipts and leaves the original result complete", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "claude-steering-reconcile-"));
  try {
    const { record, inputIds, owner, original, fingerprint } = interruptedSteering(dataDir, [
      "steer",
      "queue-steer",
    ]);
    const before = structuredClone(record);
    const lookup = (requestId: string) =>
      readControlReceipt(dataDir, { requestId, deviceId: owner });
    const verifyNoOwner = vi.fn(async () => {});
    const options = { dataDir, current: () => true, transcript: vi.fn(), verifyNoOwner };
    expect(claudeReconcileBlockReason(record)).toBeNull();
    expect(await reconcileColdClaudeSession(record, options)).toBe(false);
    expect(verifyNoOwner).not.toHaveBeenCalled();
    expect(record).toEqual(before);

    const explicit = { ...options, reconcileId: randomUUID() };
    const occupied = async () => {
      throw new Error("claude-owner-busy");
    };
    await expect(
      reconcileColdClaudeSession(record, { ...explicit, verifyNoOwner: occupied }),
    ).rejects.toThrow("claude-owner-busy");
    expect(lookup(inputIds[0]!)).toMatchObject({ status: "accepted", completionObserved: false });
    expect(await reconcileColdClaudeSession(record, explicit)).toBe(true);
    expect(options.transcript).not.toHaveBeenCalled();
    expect(record.snapshot).toMatchObject({ status: "idle", lastOutcome: null, sendEnabled: true });
    expect(record.snapshot).not.toHaveProperty("steeringRecovery");
    expect(record.snapshot).not.toHaveProperty("pendingSteeringIds");
    expect(record.completedRequests).toEqual([original]);
    expect(lookup(original)).toMatchObject({ status: "accepted", completionObserved: true });
    for (const id of inputIds) {
      const receipt = {
        recovery: "orphaned-claude-command",
        controlOutcome: "unknown",
        completed: false,
      };
      expect(lookup(id)).toMatchObject({
        status: "unknown",
        completionObserved: false,
        ack: receipt,
      });
      expect(replayManagedCommand(dataDir, id, fingerprint)).toMatchObject(receipt);
    }
    // A crash after the ledger commit but before the snapshot write can finish the same recovery.
    expect(await reconcileColdClaudeSession(before, explicit)).toBe(true);
    expect(before).toEqual(record);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("keeps a protocol stop or a mis-scoped receipt from retiring any of the batch", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "claude-steering-unproved-"));
  try {
    const { record, inputIds, owner } = interruptedSteering(dataDir, ["steer", "settings"]);
    const verifyNoOwner = vi.fn(async () => {});
    const options = {
      dataDir,
      reconcileId: randomUUID(),
      current: () => true,
      transcript: vi.fn(),
      verifyNoOwner,
    };
    const unconfirmed = structuredClone(record);
    delete unconfirmed.snapshot.steeringRecovery;
    expect(claudeReconcileBlockReason(unconfirmed)).toBe("claude-unrequested-turn");
    expect(await reconcileColdClaudeSession(unconfirmed, options)).toBe(false);
    expect(verifyNoOwner).not.toHaveBeenCalled();
    expect(await reconcileColdClaudeSession(record, options)).toBe(false);
    expect(record.snapshot.status).toBe("outcome-unknown");
    for (const requestId of inputIds)
      expect(readControlReceipt(dataDir, { requestId, deviceId: owner })).toMatchObject({
        status: "accepted",
      });
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
