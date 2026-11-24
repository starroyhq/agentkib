// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CodexOwnerWait,
  OWNER_WAIT_REASON,
  codexWriterLockPath,
  type OwnerWaitEntry,
} from "../../../packages/backend/src/agents/codex/owner-wait";
import { replayManagedCommand } from "../../../packages/backend/src/managed-ledger";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";

type OwnerWaitDependencies = ConstructorParameters<typeof CodexOwnerWait>[0];
const roots: string[] = [];
const releases: Array<() => void> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  for (const release of releases.splice(0)) release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentkib-owner-wait-"));
  roots.push(dataDir);
  const home = path.join(dataDir, "codex");
  mkdirSync(path.join(home, "thread-writer-locks"), { recursive: true });

  const send = vi.fn();
  const deliver = vi.fn<OwnerWaitDependencies["deliver"]>(async (_entry, beforeDispatch) => {
    beforeDispatch();
    send();
    return { status: "sent", interveningExternalTurns: false };
  });
  const canDeliver = vi.fn<OwnerWaitDependencies["canDeliver"]>(() => "ready");
  const report = vi.fn<OwnerWaitDependencies["report"]>();
  const changed = vi.fn<(sessionId: string) => void>();
  const open = (bootId: string) =>
    new CodexOwnerWait({ dataDir, bootId, deliver, canDeliver, report, changed });
  const ownerWait = open("first-boot");
  const nativeId = randomUUID();
  const parentId = randomUUID();
  const transcript = path.join(
    home,
    "sessions",
    `rollout-2026-11-23T01-02-03-${parentId}_${nativeId}.jsonl`,
  );
  const lock = codexWriterLockPath(home, nativeId, transcript);
  const entry: OwnerWaitEntry = {
    request: {
      operation: "send",
      sessionId: "fixture-session",
      requestId: randomUUID(),
      deviceId: "desktop-local",
      runtimeBootId: "first-boot",
      expectedRevision: 0,
      experimentalEnabled: true,
      text: "A queued fixture message",
    },
    nativeId,
    workspaceId: "fixture-workspace",
    home,
    lock,
    acceptedAt: Date.now(),
    restrictNativePolicy: true,
  };
  const accept = (value = entry) =>
    ownerWait.accept(value, value.request.requestId, {
      operation: "send",
      workspaceId: value.workspaceId,
      runtimeBootId: value.request.runtimeBootId,
    });
  const read = () => ownerWait.read(entry.request.sessionId);
  return {
    accept,
    canDeliver,
    changed,
    dataDir,
    deliver,
    entry,
    home,
    lock,
    open,
    ownerWait,
    read,
    report,
    send,
  };
}

function holdLock(file: string): () => void {
  const release = acquirePortableFileLease(file);
  releases.push(release);
  return release;
}

describe("Codex owner wait", () => {
  it("uses the first UUID of a fork rollout only for its matching native thread", () => {
    const home = path.join(tmpdir(), "fixture-codex");
    const parentId = randomUUID();
    const childId = randomUUID();
    const rollout = `rollout-2026-11-23T01-02-03-${parentId}_${childId}.jsonl`;
    const parentLock = path.join(home, "thread-writer-locks", `${parentId}.lock`);
    expect(codexWriterLockPath(home, childId, rollout)).toBe(parentLock);
    expect(codexWriterLockPath(home, childId, rollout + ".zst")).toBe(parentLock);
    expect(codexWriterLockPath(home, childId, rollout.replace(childId, randomUUID()))).toBe(
      path.join(home, "thread-writer-locks", `${childId}.lock`),
    );
    expect(() => codexWriterLockPath(home, "../another-lock", rollout)).toThrow(
      "native-session-unconfirmed",
    );
  });

  it("records one receipt, waits on the exact held lock, and sends on the first probe after release", async () => {
    const f = fixture();
    const release = holdLock(f.lock);
    holdLock(codexWriterLockPath(f.home, f.entry.nativeId));

    const acknowledged = f.accept();
    expect(acknowledged).toMatchObject({
      accepted: true,
      status: "waiting-for-owner",
      reason: OWNER_WAIT_REASON,
      requestId: f.entry.request.requestId,
    });
    expect(
      replayManagedCommand(f.dataDir, f.entry.request.requestId, f.entry.request.requestId),
    ).toEqual(acknowledged);
    const duplicate = { ...f.entry, request: { ...f.entry.request, requestId: randomUUID() } };
    expect(f.accept(duplicate)).toBeUndefined();
    expect(
      replayManagedCommand(f.dataDir, duplicate.request.requestId, duplicate.request.requestId),
    ).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.read()?.request).toEqual(f.entry.request);

    release();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(f.deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(statSync(f.lock).size).toBe(0);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.read()).toBeUndefined();
    expect(f.report).toHaveBeenCalledWith(f.entry, {
      status: "sent",
      interveningExternalTurns: false,
    });
    expect(f.changed.mock.calls).toEqual([
      [f.entry.request.sessionId],
      [f.entry.request.sessionId],
    ]);
  });

  it("sends on the first probe when an unheld lock file remains", async () => {
    const f = fixture();
    writeFileSync(f.lock, "");
    const leftBehind = statSync(f.lock);
    f.deliver.mockImplementation(async (entry, beforeDispatch) => {
      // Taking the lock in the fake native resume also proves that the probe released it.
      const release = acquirePortableFileLease(entry.lock);
      try {
        beforeDispatch();
        f.send();
        return { status: "sent", interveningExternalTurns: false };
      } finally {
        release();
      }
    });

    f.accept();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.read()).toBeUndefined();
    expect(statSync(f.lock)).toMatchObject({ ino: leftBehind.ino, size: 0 });
  });

  it("continues polling after a lock probe error", async () => {
    const f = fixture();
    mkdirSync(f.lock);
    f.accept();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.ownerWait.paused(f.read()!)).toBe(false);

    rmdirSync(f.lock);
    writeFileSync(f.lock, "");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("can cancel an entry while the lock is still held", async () => {
    const f = fixture();
    writeFileSync(f.lock, "");
    f.accept();
    expect(f.ownerWait.cancel(f.read()!)).toBe(true);
    unlinkSync(f.lock);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.read()).toBeUndefined();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("rechecks cancellation at the write boundary after delivery preflight starts", async () => {
    const f = fixture();
    const preflight = Promise.withResolvers<void>();
    const refused = vi.fn();
    f.deliver.mockImplementation(async (_entry, beforeDispatch) => {
      await preflight.promise;
      try {
        beforeDispatch();
      } catch (error) {
        refused(error);
        return { status: "refused", reason: "codex-owner-wait-cancelled" };
      }
      f.send();
      return { status: "sent", interveningExternalTurns: false };
    });
    f.accept();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.ownerWait.cancel(f.read()!)).toBe(true);
    preflight.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.read()).toBeUndefined();
    expect(refused).toHaveBeenCalledExactlyOnceWith(new Error("codex-owner-wait-cancelled"));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("does not cancel a dispatch that has crossed the write boundary", async () => {
    const f = fixture();
    const sent = Promise.withResolvers<void>();
    f.deliver.mockImplementation(async (_entry, beforeDispatch) => {
      beforeDispatch();
      await sent.promise;
      return { status: "sent", interveningExternalTurns: true };
    });
    f.accept();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.read()?.delivering).toBe(true);
    expect(f.ownerWait.cancel(f.read()!)).toBe(false);
    sent.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.read()).toBeUndefined();
    expect(f.report).toHaveBeenCalledWith(f.entry, {
      status: "sent",
      interveningExternalTurns: true,
    });
  });

  it("retains a wait across restarts and requires an explicit resume", async () => {
    const f = fixture();
    writeFileSync(f.lock, "");
    f.accept();
    f.ownerWait.stop();
    unlinkSync(f.lock);
    const next = f.open("second-boot");
    const retained = next.read(f.entry.request.sessionId)!;
    expect(retained.request).toEqual(f.entry.request);
    expect(next.paused(retained)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(next.resume(retained)).toBe(true);
    expect(next.paused(next.read(f.entry.request.sessionId)!)).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(next.read(f.entry.request.sessionId)).toBeUndefined();
  });

  it("does not retry an interrupted dispatch and can dismiss its unknown receipt", async () => {
    const f = fixture();
    const pending = Promise.withResolvers<void>();
    f.deliver.mockImplementation(async (_entry, beforeDispatch) => {
      beforeDispatch();
      await pending.promise;
      return { status: "sent", interveningExternalTurns: false };
    });
    f.accept();
    await vi.advanceTimersByTimeAsync(2_000);
    f.ownerWait.stop();
    const next = f.open("second-boot");
    const interrupted = next.read(f.entry.request.sessionId)!;
    expect(interrupted.delivering).toBe(true);
    expect(next.resume(interrupted)).toBe(false);
    expect(next.dismissInterrupted(interrupted)).toBe(true);
    expect(next.read(f.entry.request.sessionId)).toBeUndefined();
    expect(
      replayManagedCommand(f.dataDir, f.entry.request.requestId, f.entry.request.requestId),
    ).toMatchObject({ accepted: false, controlOutcome: "unknown" });
    pending.resolve();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.report).not.toHaveBeenCalled();
  });

  it("reports a definitive refusal and does not attempt a second delivery", async () => {
    const f = fixture();
    const refused = { status: "refused", reason: "native-policy-unconfirmed" } as const;
    f.deliver.mockResolvedValue(refused);
    f.accept();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    expect(f.read()).toBeUndefined();
    expect(f.report).toHaveBeenCalledExactlyOnceWith(f.entry, refused);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("requires a fresh permit bound to the paired device before remote dispatch", async () => {
    const f = fixture();
    const remote = {
      ...f.entry,
      request: { ...f.entry.request, deviceId: "paired-device" },
      restrictNativePolicy: false,
    };
    f.accept(remote);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.ownerWait.scheduleList()).toMatchObject([
      {
        agent: "codex",
        sessionId: remote.request.sessionId,
        workspaceId: remote.workspaceId,
        next: { deviceId: "paired-device" },
      },
    ]);
    const args = {
      sessionId: remote.request.sessionId,
      deviceId: "paired-device",
      requestId: remote.request.requestId,
      itemId: remote.request.requestId,
      runtimeBootId: remote.request.runtimeBootId,
      expectedRevision: 0,
    };
    await expect(
      f.ownerWait.schedule({ ...args, operation: "schedule-dispatch", permitId: randomUUID() }),
    ).rejects.toThrow("schedule-permit-unavailable");
    const permit = await f.ownerWait.schedule({ ...args, operation: "schedule-prepare" });
    await expect(
      f.ownerWait.schedule({
        ...args,
        operation: "schedule-dispatch",
        permitId: permit.permitId,
        deviceId: "different-device",
      }),
    ).rejects.toThrow("stale-schedule-item");
    await expect(
      f.ownerWait.schedule({
        ...args,
        operation: "schedule-dispatch",
        permitId: permit.permitId,
        restrictNativePolicy: true,
      }),
    ).resolves.toEqual({ accepted: true });
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
      {
        ...remote,
        restrictNativePolicy: true,
      },
      expect.any(Function),
    );
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.ownerWait.scheduleList()).toEqual([]);
  });

  it("fences a remote permit if the device is revoked during startup", async () => {
    const f = fixture();
    const remote = { ...f.entry, request: { ...f.entry.request, deviceId: "paired-device" } };
    const preflight = Promise.withResolvers<void>();
    const rejected = vi.fn();
    f.deliver.mockImplementation(async (_entry, beforeDispatch) => {
      await preflight.promise;
      try {
        beforeDispatch();
        f.send();
      } catch (error) {
        rejected(error);
      }
      return { status: "refused", reason: "schedule-permit-unavailable" };
    });
    f.accept(remote);
    await vi.advanceTimersByTimeAsync(2_000);
    const args = {
      sessionId: remote.request.sessionId,
      deviceId: "paired-device",
      requestId: remote.request.requestId,
      itemId: remote.request.requestId,
      runtimeBootId: remote.request.runtimeBootId,
      expectedRevision: 0,
    };
    const permit = await f.ownerWait.schedule({ ...args, operation: "schedule-prepare" });
    const pending = f.ownerWait.schedule({
      ...args,
      operation: "schedule-dispatch",
      permitId: permit.permitId,
    });
    f.ownerWait.invalidateDevice("paired-device");
    preflight.resolve();
    await pending;
    expect(rejected).toHaveBeenCalledExactlyOnceWith(new Error("schedule-permit-unavailable"));
    expect(f.send).not.toHaveBeenCalled();
    expect(f.read()).toBeUndefined();
  });

  it("withdraws a ready remote wait at shutdown and retains the accepted message", async () => {
    const f = fixture();
    const remote = { ...f.entry, request: { ...f.entry.request, deviceId: "paired-device" } };
    f.accept(remote);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.ownerWait.scheduleList()).toHaveLength(1);
    f.ownerWait.suspendDevice("paired-device");
    expect(f.ownerWait.scheduleList()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.ownerWait.paused(f.read()!)).toBe(true);
    expect(f.read()?.request).toEqual(remote.request);
    expect(f.send).not.toHaveBeenCalled();
  });

  it("removes only the revoked device's waits and does not deliver them", async () => {
    const f = fixture();
    const other = {
      ...f.entry,
      request: {
        ...f.entry.request,
        sessionId: "other-session",
        requestId: randomUUID(),
        deviceId: undefined,
      },
    };
    f.accept();
    f.accept(other);
    f.ownerWait.invalidateDevice(f.entry.request.deviceId!);
    expect(f.read()).toBeUndefined();
    expect(f.ownerWait.read(other.request.sessionId)?.request).toEqual(other.request);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith(other, expect.any(Function));
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});
