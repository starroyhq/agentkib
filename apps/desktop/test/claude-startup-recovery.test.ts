import { randomUUID } from "node:crypto";
import childProcesses, { execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  ClaudeUndispatchedError,
} from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { ClaudeSessionOwnerProbe } from "../../../packages/backend/src/claude-session-owner";
import { openManagedLedger } from "../../../packages/backend/src/managed-ledger";
import {
  claimManagedCommand,
  dispatchManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import { MacOwnedProcessTree } from "../../../packages/backend/src/mac-owned-process-tree";
import * as leases from "../../../packages/backend/src/managed-session-lock";
import { Duplex } from "node:stream";
import type { BackendStore } from "../../../packages/backend/src/store";
import type { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { Commands } from "../../../packages/backend/src/commands";
import { processAlive, type FakeClaudePlan } from "./fixtures/claude-fake-cli";
import { createStartupClaude, createStartupClaudeSpawn } from "./fixtures/claude-startup-cli";

const cleanups: Array<() => void | Promise<void>> = [];
const confirmsOwnedTree = process.platform === "darwin";
let startupSpawn: ReturnType<typeof createStartupClaudeSpawn>;
beforeEach(() => {
  // Preparing the real synthetic shell is not the protocol fault under test. Keep it outside
  // the unchanged 300 ms initialize deadline, as for the detached-child setup below.
  startupSpawn = createStartupClaudeSpawn();
  vi.spyOn(childProcesses, "spawn").mockImplementation(startupSpawn.spawn);
  syncBuiltinESMExports();
});
afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  // A missing fixture prerequisite must fail even if an expected protocol timeout occurred.
  expect(startupSpawn.failures).toEqual([]);
});

function fixture(plan: FakeClaudePlan) {
  const f = createStartupClaude();
  f.setPlan(plan);
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  const runner = new ClaudeManagedRunnerProcess(
    f.workspace,
    randomUUID(),
    true,
    0,
    f.environment,
    () => undefined,
    true,
    undefined,
    { controlTimeoutMs: 300 },
  );
  cleanups.push(() => runner.shutdown().catch(() => undefined));
  return { ...f, runner };
}

function host(
  f: ReturnType<typeof fixture>,
  indexedNativeId?: string,
  publish?: (live: Record<string, unknown>) => void,
) {
  const owner = new ClaudeManagedReadOwner(
    {
      workspacePath: () => f.workspace,
      sessions: {
        id: (_agent: string, id: string) => id,
        get: (id: string) =>
          indexedNativeId && id === indexedNativeId
            ? { agent: "claude-code", workspace_id: "workspace", sidechain: false }
            : undefined,
      },
    } as unknown as BackendStore,
    {
      verifiedClaudeControlTarget: (id: string) => path.join(f.config, `${id}.jsonl`),
      verifiedClaudeReadSource: (id: string) => ({
        nativeId: id,
        workspaceId: "workspace",
        workspace: f.workspace,
        transcript: path.join(f.config, `${id}.jsonl`),
      }),
      list: async () => ({
        sessions: indexedNativeId ? [{ native_ref: indexedNativeId, sidechain: false }] : [],
      }),
      document: async () => ({ source: { agent: "claude-code", workspace_id: "workspace" } }),
      claudeControlWorkspace: () => f.workspace,
    } as unknown as SessionReaders,
    {
      run: vi.fn(async (command: string, args: string[]) => ({
        success: true,
        bytes: Buffer.from(
          command === "/bin/ps" ? "" : args[0] === "agents" ? "[]\n" : "2.1.303 (Claude Code)\n",
        ),
      })),
    } as unknown as Commands,
    f.root,
    f.environment,
    randomUUID(),
    { publish: (_id, _type, _payload, live) => publish?.(live), alias: () => undefined },
  );
  cleanups.push(() => owner.shutdown());
  return owner;
}

async function create(owner: ClaudeManagedReadOwner) {
  return (await owner.request({
    operation: "create",
    workspaceId: "workspace",
    requestId: randomUUID(),
    deviceId: "browser-device",
  })) as { sessionId: string };
}

async function send(owner: ClaudeManagedReadOwner, id: string, requestId = randomUUID()) {
  const live = (await owner.live(id, true)) as { revision: number };
  return owner.request({
    operation: "send",
    sessionId: id,
    deviceId: "browser-device",
    requestId,
    runtimeBootId: owner.bootId,
    expectedRevision: live.revision,
    experimentalEnabled: true,
    text: "synthetic draft",
  });
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))("Claude startup recovery", () => {
  it.skipIf(process.platform !== "darwin").each(["idle", "external", "replacement"] as const)(
    "rechecks %s ownership when a live read outlives startup cleanup",
    async (next) => {
      const f = fixture({ beforeInitialize: [{ __closeOutput: true }], silentInitialize: true });
      const owner = host(f);
      const { sessionId } = await create(owner);
      const wallNow = Date.now.bind(Date);
      let clockOffset = 0;
      vi.spyOn(Date, "now").mockImplementation(() => wallNow() + clockOffset);
      let activeRunner: ClaudeManagedRunnerProcess | undefined;
      const runnerSend = ClaudeManagedRunnerProcess.prototype.send;
      vi.spyOn(ClaudeManagedRunnerProcess.prototype, "send").mockImplementation(function (
        this: ClaudeManagedRunnerProcess,
        ...args
      ) {
        activeRunner = this;
        return runnerSend.apply(this, args);
      });
      let finishCleanup!: () => void;
      let cleaning = false;
      const cleanupGate = new Promise<void>((resolve) => (finishCleanup = resolve));
      const terminate = MacOwnedProcessTree.prototype.terminate;
      vi.spyOn(MacOwnedProcessTree.prototype, "terminate").mockImplementation(
        async function (this: MacOwnedProcessTree, child) {
          cleaning = true;
          await cleanupGate;
          return terminate.call(this, child);
        },
      );
      let release!: () => void;
      let observed!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const blocked = new Promise<void>((resolve) => (observed = resolve));
      let armed = false;
      let held = false;
      let settled = false;
      const checkedPids: Array<number | null> = [];
      const check = ClaudeSessionOwnerProbe.prototype.check;
      vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockImplementation(async function (
        this: ClaudeSessionOwnerProbe,
        nativeId,
        ownedPid = null,
        share,
      ) {
        if (!armed) return check.call(this, nativeId, ownedPid, share);
        checkedPids.push(ownedPid);
        if (!held && ownedPid !== null) {
          held = true;
          observed();
          await gate;
          return { kind: "idle" };
        }
        return settled && next === "external"
          ? { kind: "interactive", pid: 234567, source: "ps" }
          : { kind: "idle" };
      });
      const pending = send(owner, sessionId);
      let read: Promise<Record<string, unknown>> | undefined;
      try {
        await expect.poll(() => cleaning).toBe(true);
        expect(activeRunner?.startupPending).toBe(true);
        const initialPid = activeRunner!.processId;
        // Expire the ordinary three-second read cache without changing its production TTL.
        clockOffset += 3001;
        armed = true;
        read = owner.live(sessionId, true);
        await blocked;
        finishCleanup();
        expect(await pending).toMatchObject({ controlOutcome: "not-dispatched" });
        expect(activeRunner?.snapshot().status).toBe("idle");
        if (next === "replacement") {
          f.setPlan({});
          await send(owner, sessionId);
          await expect.poll(() => activeRunner?.snapshot().status).toBe("idle");
          expect(activeRunner?.processId).not.toBe(initialPid);
          expect(activeRunner?.hasWorker).toBe(true);
        }
        settled = true;
        release();
        expect(await read).toMatchObject({
          status: "idle",
          sendEnabled: next !== "external",
          ownershipReason: next === "external" ? "claude-owner-busy" : null,
          executionLocation:
            next === "external" ? "external" : next === "replacement" ? "agentkib" : null,
        });
        expect(checkedPids.at(-1)).toBe(next === "replacement" ? activeRunner!.processId : null);
        expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(
          next === "replacement" ? 1 : 0,
        );
      } finally {
        finishCleanup();
        release();
        await read?.catch(() => undefined);
        await pending.catch(() => undefined);
      }
    },
    30_000,
  );

  it("bounds live recovery when record generation keeps changing during owner checks", async () => {
    const f = fixture({});
    const owner = host(f);
    const { sessionId } = await create(owner);
    const file = path.join(f.root, "claude-managed", `${sessionId}.json`);
    const wallNow = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => wallNow() + 3001);
    let checks = 0;
    let latestCreatedAt = "";
    vi.spyOn(ClaudeSessionOwnerProbe.prototype, "check").mockImplementation(async () => {
      const record = JSON.parse(readFileSync(file, "utf8"));
      latestCreatedAt = new Date(Date.parse(record.createdAt) + 1).toISOString();
      record.createdAt = latestCreatedAt;
      writeFileSync(file, JSON.stringify(record));
      checks++;
      return { kind: "idle" };
    });
    await expect(owner.live(sessionId, true)).rejects.toThrow("claude-owner-check-unavailable");
    expect(checks).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).createdAt).toBe(latestCreatedAt);
    expect(f.frames()).toEqual([]);
  });

  it.each(["protocol", "dispatched"] as const)(
    "keeps a %s failure visibly unknown instead of restarting its presentation",
    async (kind) => {
      const f = fixture(
        kind === "protocol"
          ? { beforeInitialize: [{ __raw: "invalid frame" }], silentInitialize: true }
          : { onUser: [{ __closeOutput: true }], noResult: true },
      );
      const states: Array<Record<string, unknown>> = [];
      const owner = host(f, undefined, (live) => states.push(live));
      const { sessionId } = await create(owner);
      await send(owner, sessionId);
      await expect.poll(() => states.at(-1)?.status).toBe("outcome-unknown");
      const first = states.findIndex((live) => live.status === "outcome-unknown");
      expect(states.slice(first).some((live) => live.status === "starting")).toBe(false);
      expect(states.at(-1)).toMatchObject({ sendEnabled: false });
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(
        kind === "protocol" ? 0 : 1,
      );
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "publishes a single starting state until undispatched cleanup settles",
    async () => {
      const f = fixture({ beforeInitialize: [{ __closeOutput: true }], silentInitialize: true });
      const states: Array<Record<string, unknown>> = [];
      const owner = host(f, undefined, (live) => states.push(live));
      const { sessionId } = await create(owner);
      let resolve!: () => void;
      const gate = new Promise<void>((done) => {
        resolve = done;
      });
      let cleaning = false;
      const terminate = MacOwnedProcessTree.prototype.terminate;
      vi.spyOn(MacOwnedProcessTree.prototype, "terminate").mockImplementation(
        async function (this: MacOwnedProcessTree, child) {
          cleaning = true;
          await gate;
          return terminate.call(this, child);
        },
      );
      const pending = send(owner, sessionId);
      try {
        await expect.poll(() => cleaning).toBe(true);
        expect(states.at(-1)).toMatchObject({ status: "starting", sendEnabled: false });
        const record = JSON.parse(
          readFileSync(path.join(f.root, "claude-managed", `${sessionId}.json`), "utf8"),
        );
        expect(record.snapshot.status).toBe("outcome-unknown");
      } finally {
        resolve();
      }
      expect(await pending).toMatchObject({ controlOutcome: "not-dispatched" });
      expect(states.at(-1)).toMatchObject({ status: "idle", sendEnabled: true });
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    },
    30_000,
  );

  it.each(["send", "prepare"] as const)(
    "keeps a Linux %s startup unknown when process-group cleanup leaves a detached child alive",
    async (operation) => {
      const f = fixture({ silentInitialize: true });
      const childPidFile = path.join(f.root, "detached-child-pid");
      const identities = new Map<number, string>();
      const identity = (pid: number) => {
        try {
          return execFileSync("/bin/ps", ["-p", String(pid), "-o", "pgid=,lstart="], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }).trim();
        } catch {
          return "";
        }
      };
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const proof = vi.fn();
      // Keep the implementation rather than the spy object that the override below reuses.
      const actualSpawn = startupSpawn.spawn;
      let childReady = false;
      const spawning = vi
        .spyOn(childProcesses, "spawn")
        .mockImplementation((...args: Parameters<typeof childProcesses.spawn>) => {
          const child = actualSpawn(...args);
          if (args[0] === f.executable) {
            // Establish the real detached-child fixture before the runner starts its unchanged
            // 300 ms initialize deadline. Always return the child, even if readiness fails.
            const deadline = Date.now() + 2000;
            while (!existsSync(childPidFile) && Date.now() < deadline)
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            childReady = existsSync(childPidFile);
          }
          return child;
        });
      syncBuiltinESMExports();
      let runner: ClaudeManagedRunnerProcess | undefined;
      writeFileSync(
        f.executable,
        `#!/bin/bash
set -m
(while :; do :; done) < /dev/null > /dev/null 2>&1 &
printf '%s' "$!" > "$TEST_CHILD_PID"
while IFS= read -r frame; do printf '%s\\n' "$frame" >> "$FAKE_LOG"; done
`,
        { mode: 0o700 },
      );
      try {
        // Warm the actual host's flock binding before exercising the Linux POSIX group branch.
        leases.acquirePortableFileLease(path.join(f.root, "platform-bootstrap.lock"))();
        Object.defineProperty(process, "platform", { value: "linux" });
        runner = new ClaudeManagedRunnerProcess(
          f.workspace,
          randomUUID(),
          true,
          0,
          // This custom shell has its own detached-child readiness handshake above.
          { ...f.environment, STARTUP_READY: undefined, TEST_CHILD_PID: childPidFile },
          () => undefined,
          true,
          undefined,
          { controlTimeoutMs: 300, onUndispatchedStartup: proof },
        );
        const pending = (
          operation === "send"
            ? runner.send(f.executable, "synthetic draft", randomUUID(), 0)
            : runner.prepare(f.executable)
        ).catch((error: unknown) => error);
        const rootPid = runner.processId!;
        identities.set(rootPid, identity(rootPid));
        const error = await pending;
        expect(childReady).toBe(true);
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(ClaudeUndispatchedError);
        expect(error).toMatchObject({ message: "Claude initialize timed out" });
        expect(runner.snapshot()).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
        expect(proof).not.toHaveBeenCalled();
        expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
        expect(existsSync(childPidFile)).toBe(true);
        const childPid = Number(readFileSync(childPidFile, "utf8"));
        const childIdentity = identity(childPid);
        identities.set(childPid, childIdentity);
        expect(childIdentity).toMatch(new RegExp(`^${childPid}\\s`));
        expect(childPid).not.toBe(rootPid);
      } finally {
        await runner?.shutdown().catch(() => undefined);
        if (existsSync(childPidFile)) {
          const pid = Number(readFileSync(childPidFile, "utf8"));
          if (!identities.has(pid)) identities.set(pid, identity(pid));
        }
        for (const [pid, started] of identities) {
          if (!started || identity(pid) !== started) continue;
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            // This exact test process group already exited.
          }
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // The group signal already ended this exact test process.
          }
        }
        Object.defineProperty(process, "platform", originalPlatform);
        spawning.mockRestore();
        syncBuiltinESMExports();
      }
    },
    30_000,
  );

  it.each([0, 350])(
    "restores an explicit settings initialize timeout after confirmed cleanup without a user frame (fixture restart delay: %i ms)",
    async (startupDelay) => {
      const f = fixture({ silentInitialize: true });
      await expect(f.runner.prepare(f.executable)).rejects.toThrow("Claude initialize timed out");
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.snapshot()).toMatchObject({
        status: confirmsOwnedTree ? "idle" : "outcome-unknown",
        sendEnabled: confirmsOwnedTree,
      });
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      f.setPlan({});
      if (startupDelay)
        writeFileSync(
          f.executable,
          readFileSync(f.executable, "utf8").replace(
            "#!/bin/sh\n",
            `#!/bin/sh\n/bin/sleep ${startupDelay / 1000}\n`,
          ),
          { mode: 0o700 },
        );
      if (!confirmsOwnedTree) {
        await expect(f.runner.prepare(f.executable)).rejects.toThrow("busy");
        return;
      }
      await expect(f.runner.prepare(f.executable)).resolves.toMatchObject({
        settingsAcknowledged: true,
      });
    },
    30_000,
  );

  it("keeps a settings initialize protocol failure unknown", async () => {
    const f = fixture({ beforeInitialize: [{ __raw: "invalid frame" }], silentInitialize: true });
    await expect(f.runner.prepare(f.executable)).rejects.toThrow();
    expect(f.evidence()).toContain("bad-frame");
    expect(f.runner.snapshot().status).toBe("outcome-unknown");
    expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
  }, 30_000);
  it.each([0, 350])(
    "restores an undispatched initialize timeout after confirming worker cleanup, then permits a new send (fixture restart delay: %i ms)",
    async (startupDelay) => {
      const f = fixture({ silentInitialize: true });
      const dispatched = vi.fn();
      const proof = vi.fn();
      f.runner.options.onUndispatchedStartup = proof;
      await expect(
        f.runner.send(f.executable, "synthetic draft", randomUUID(), 0, dispatched),
      ).rejects.toBeInstanceOf(confirmsOwnedTree ? ClaudeUndispatchedError : Error);
      expect(dispatched).not.toHaveBeenCalled();
      expect(f.frames().filter((frame) => frame.type === "control_request")).toHaveLength(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.snapshot()).toMatchObject({
        status: confirmsOwnedTree ? "idle" : "outcome-unknown",
        sendEnabled: confirmsOwnedTree,
        ...(confirmsOwnedTree ? { turnId: "" } : {}),
        reason: "Claude initialize timed out",
      });
      if (!confirmsOwnedTree) {
        expect(proof).not.toHaveBeenCalled();
        return;
      }
      expect(proof).toHaveBeenCalledWith(
        expect.objectContaining({ cleanupKind: "mac-owned-process-tree" }),
      );
      f.setPlan({});
      if (startupDelay)
        writeFileSync(
          f.executable,
          readFileSync(f.executable, "utf8").replace(
            "#!/bin/sh\n",
            `#!/bin/sh\n/bin/sleep ${startupDelay / 1000}\n`,
          ),
          { mode: 0o700 },
        );
      await f.runner.send(
        f.executable,
        "synthetic draft",
        randomUUID(),
        f.runner.snapshot().revision,
        dispatched,
      );
      await expect.poll(() => f.runner.snapshot().status).toBe("idle");
      expect(dispatched).toHaveBeenCalledTimes(1);
      expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    },
    30_000,
  );

  it.each(["send", "prepare"] as const)(
    "restores a failed %s initialize write only after the owned tree is gone",
    async (operation) => {
      const f = fixture({});
      const original = Duplex.prototype.write;
      const writing = vi.spyOn(Duplex.prototype, "write").mockImplementation(function (
        this: Duplex,
        ...args: Parameters<Duplex["write"]>
      ) {
        const chunk = args[0];
        if (Buffer.isBuffer(chunk) && chunk.includes(Buffer.from('"subtype":"initialize"'))) {
          const callback = args.at(-1);
          queueMicrotask(() => {
            if (typeof callback === "function")
              callback(new Error("synthetic initialize write failure"));
          });
          return false;
        }
        return Reflect.apply(original, this, args);
      });
      await expect(
        operation === "send"
          ? f.runner.send(f.executable, "synthetic draft", randomUUID(), 0)
          : f.runner.prepare(f.executable),
      ).rejects.toBeInstanceOf(
        operation === "send" && confirmsOwnedTree ? ClaudeUndispatchedError : Error,
      );
      writing.mockRestore();
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.snapshot()).toMatchObject({
        status: confirmsOwnedTree ? "idle" : "outcome-unknown",
        reason: "synthetic initialize write failure",
      });
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    },
    30_000,
  );

  it.skipIf(process.platform !== "darwin")(
    "keeps cleanup failure unknown and does not publish a cleanup receipt",
    async () => {
      const f = fixture({ silentInitialize: true });
      const proof = vi.fn();
      const stop = vi
        .spyOn(MacOwnedProcessTree.prototype, "terminate")
        .mockRejectedValueOnce(new Error("synthetic tree cleanup failure"));
      const runner = new ClaudeManagedRunnerProcess(
        f.workspace,
        randomUUID(),
        true,
        0,
        f.environment,
        () => undefined,
        true,
        undefined,
        { controlTimeoutMs: 300, onUndispatchedStartup: proof },
      );
      cleanups.push(() => runner.shutdown().catch(() => undefined));
      await expect(runner.send(f.executable, "synthetic draft", randomUUID(), 0)).rejects.toThrow(
        "cleanup",
      );
      expect(runner.snapshot().status).toBe("outcome-unknown");
      expect(proof).not.toHaveBeenCalled();
      expect(runner.hasWorker).toBe(true);
      stop.mockRestore();
    },
    30_000,
  );

  it("keeps a failed durable proof write unknown even when physical cleanup succeeded", async () => {
    const f = fixture({ silentInitialize: true });
    const proof = vi.fn(() => {
      throw new Error("synthetic proof write failure");
    });
    const runner = new ClaudeManagedRunnerProcess(
      f.workspace,
      randomUUID(),
      true,
      0,
      f.environment,
      () => undefined,
      true,
      undefined,
      {
        controlTimeoutMs: 300,
        onUndispatchedStartup: proof,
      },
    );
    cleanups.push(() => runner.shutdown().catch(() => undefined));
    await expect(runner.send(f.executable, "synthetic draft", randomUUID(), 0)).rejects.toThrow(
      confirmsOwnedTree ? "synthetic proof write failure" : "Claude initialize timed out",
    );
    expect(proof).toHaveBeenCalledTimes(confirmsOwnedTree ? 1 : 0);
    expect(runner.hasWorker).toBe(false);
    expect(runner.snapshot().status).toBe("outcome-unknown");
  }, 30_000);

  it.skipIf(process.platform !== "darwin")(
    "keeps a pre-initialize root exit unknown when descendant capture cannot be confirmed",
    async () => {
      const f = fixture({ beforeInitialize: [{ __exit: true }], silentInitialize: true });
      const terminate = MacOwnedProcessTree.prototype.terminate;
      vi.spyOn(MacOwnedProcessTree.prototype, "terminate").mockImplementation(
        async function (this: MacOwnedProcessTree, child) {
          // Force the root-exit ordering without weakening the real tree capture assertion.
          if (child.exitCode === null && child.signalCode === null) await once(child, "close");
          return terminate.call(this, child);
        },
      );
      await expect(f.runner.send(f.executable, "synthetic draft", randomUUID(), 0)).rejects.toThrow(
        "owned root exited before frozen capture",
      );
      expect(f.runner.snapshot().status).toBe("outcome-unknown");
      expect(f.runner.cleanupError).toContain("owned root exited before frozen capture");
      expect(f.runner.processId).not.toBeNull();
      expect(processAlive(f.runner.processId!)).toBe(false);
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
    },
    30_000,
  );

  it("keeps protocol drift before initialization unknown", async () => {
    const f = fixture({ beforeInitialize: [{ __raw: "invalid frame" }], silentInitialize: true });
    await expect(
      f.runner.send(f.executable, "synthetic draft", randomUUID(), 0),
    ).rejects.not.toBeInstanceOf(ClaudeUndispatchedError);
    expect(f.evidence()).toContain("bad-frame");
    expect(f.runner.snapshot().status).toBe("outcome-unknown");
    expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
  }, 30_000);

  it("keeps a dispatched user turn unknown even without a host dispatch callback", async () => {
    const f = fixture({ onUser: [{ __closeOutput: true }], noResult: true });
    await f.runner.send(f.executable, "synthetic draft", randomUUID(), 0).catch(() => undefined);
    await expect.poll(() => f.runner.snapshot().status).toBe("outcome-unknown");
    expect(f.frames().filter((frame) => frame.type === "user")).toHaveLength(1);
    expect(f.evidence()).toContain("close-user");
  }, 30_000);

  it("finishes a pre-initialize stream failure as not-dispatched and keeps the session usable after restart", async () => {
    const f = fixture({ beforeInitialize: [{ __closeOutput: true }], silentInitialize: true });
    const owner = host(f);
    const { sessionId } = await create(owner);
    const requestId = randomUUID();
    expect(await send(owner, sessionId, requestId)).toMatchObject({
      accepted: false,
      controlOutcome: confirmsOwnedTree ? "not-dispatched" : "unknown",
    });
    expect(await owner.live(sessionId, true)).toMatchObject({
      status: confirmsOwnedTree ? "idle" : "outcome-unknown",
      sendEnabled: confirmsOwnedTree,
    });
    const database = openManagedLedger(f.root)!;
    try {
      const row = database
        .prepare("SELECT phase,result,evidence FROM managed_commands WHERE request_id=?")
        .get(requestId) as { phase: string; result: string; evidence: string };
      expect(row.phase).toBe(confirmsOwnedTree ? "resolved" : "prepared");
      if (confirmsOwnedTree) {
        expect(JSON.parse(row.result)).toMatchObject({ controlOutcome: "not-dispatched" });
        expect(JSON.parse(row.evidence)).toMatchObject({
          startupCleanup: { version: 2, cleanupKind: "mac-owned-process-tree" },
        });
      } else {
        expect(row.result).toBeNull();
        expect(JSON.parse(row.evidence)).not.toHaveProperty("startupCleanup");
      }
    } finally {
      database.close();
    }
    await owner.shutdown();
    const restarted = host(f);
    expect(await restarted.live(sessionId, true)).toMatchObject({
      status: confirmsOwnedTree ? "idle" : "outcome-unknown",
      sendEnabled: confirmsOwnedTree,
    });
    if (!confirmsOwnedTree) {
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      return;
    }
    f.setPlan({});
    expect(await send(restarted, sessionId)).toMatchObject({ accepted: true });
    await expect.poll(async () => (await restarted.live(sessionId, true)).status).toBe("idle");
  }, 30_000);

  it.each([
    "valid",
    "resolved-outcome",
    "restored-metadata",
    "native-id",
    "generation",
    "revision",
    "cleanup",
    "dispatched",
    "user-dispatched",
    "other-command",
    "new-owner-completed",
    "legacy-proof",
    "invalid-kind",
    "missing-kind",
    "foreign-mac-kind",
    "not-started-linux",
    "legacy-restored",
    "legacy-restored-unrelated-native",
    "legacy-restored-later-revision",
    "legacy-restored-later-turn",
    "legacy-restored-max-revision",
    "legacy-restored-released-send",
    "legacy-restored-released-adopt",
    "legacy-restored-indexed-alias-send",
    "legacy-restored-indexed-alias-adopt",
    "legacy-restored-indexed-alias-unseen-send",
    "legacy-restored-indexed-alias-unseen-adopt",
    "legacy-restored-indexed-alias-unseen-locked-adopt",
    "ordinary-idle-no-legacy-proof",
    "foreign-mac-restored",
    "missing-kind-restored",
  ] as const)(
    "recovers an interrupted durable startup only with matching cleanup proof: %s",
    async (kind) => {
      const f = fixture({ beforeInitialize: [{ __closeOutput: true }], silentInitialize: true });
      const owner = host(f);
      const { sessionId } = await create(owner);
      const requestId = randomUUID();
      // A missing interpreter proves no PID started on both supported Unix platforms.
      writeFileSync(f.executable, "#!/agentkib-nonexistent-interpreter\n", { mode: 0o700 });
      f.environment.STARTUP_READY = "";
      const failed = (await send(owner, sessionId, requestId)) as { error: string };
      expect(failed).toMatchObject({
        controlOutcome: "not-dispatched",
      });
      await owner.shutdown();
      const database = openManagedLedger(f.root)!;
      const file = path.join(f.root, "claude-managed", `${sessionId}.json`);
      const record = JSON.parse(readFileSync(file, "utf8"));
      const recoverable = [
        "valid",
        "resolved-outcome",
        "restored-metadata",
        "not-started-linux",
      ].includes(kind);
      const legacyRestored = kind.startsWith("legacy-restored");
      const releasedLegacy = kind.startsWith("legacy-restored-released-");
      const aliasLegacy = kind.startsWith("legacy-restored-indexed-alias-");
      let previousCommandCount = 0;
      let previousHostRevision = 0;
      const unsupportedRestored = ["foreign-mac-restored", "missing-kind-restored"].includes(kind);
      const untouchedIdle = [
        "legacy-restored-unrelated-native",
        "legacy-restored-later-revision",
        "legacy-restored-later-turn",
        "ordinary-idle-no-legacy-proof",
      ].includes(kind);
      try {
        const row = database
          .prepare("SELECT evidence,result FROM managed_commands WHERE request_id=?")
          .get(requestId) as { evidence: string; result: string };
        expect(row.evidence).not.toContain("synthetic draft");
        const evidence = JSON.parse(row.evidence);
        const proof = evidence.startupCleanup;
        expect(proof).toMatchObject({
          version: 2,
          cleanupKind: "not-started",
          cleanupConfirmed: true,
          userDispatched: false,
        });
        if (
          kind !== "restored-metadata" &&
          !legacyRestored &&
          !unsupportedRestored &&
          kind !== "ordinary-idle-no-legacy-proof"
        ) {
          record.snapshot.status = "outcome-unknown";
          record.snapshot.revision = proof.failedRevision;
          record.snapshot.turnId = requestId;
        }
        if (kind === "native-id") proof.nativeId = randomUUID();
        if (kind === "generation") proof.recordCreatedAt = "old record generation";
        if (kind === "revision") record.snapshot.revision++;
        if (kind === "cleanup") proof.cleanupConfirmed = false;
        if (kind === "user-dispatched") proof.userDispatched = true;
        if (kind === "legacy-proof") proof.version = 1;
        if (kind === "invalid-kind") proof.cleanupKind = "unix-process-group";
        if (["missing-kind", "missing-kind-restored"].includes(kind)) delete proof.cleanupKind;
        if (["foreign-mac-kind", "foreign-mac-restored"].includes(kind))
          proof.cleanupKind = "mac-owned-process-tree";
        if (legacyRestored) {
          proof.version = 1;
          delete proof.cleanupKind;
        }
        if (kind === "legacy-restored-unrelated-native") proof.nativeId = randomUUID();
        if (kind === "legacy-restored-later-revision") record.snapshot.revision++;
        if (kind === "legacy-restored-later-turn") record.snapshot.turnId = randomUUID();
        if (kind === "legacy-restored-max-revision") {
          proof.failedRevision = Number.MAX_SAFE_INTEGER - 1;
          record.snapshot.revision = Number.MAX_SAFE_INTEGER;
        }
        if (releasedLegacy || aliasLegacy) {
          if (releasedLegacy) record.released = true;
          previousCommandCount = (
            database.prepare("SELECT COUNT(*) AS count FROM managed_commands").get() as {
              count: number;
            }
          ).count;
          const hostRow = database
            .prepare("SELECT record FROM claude_host_states WHERE session_id=?")
            .get(sessionId) as { record: string };
          previousHostRevision = JSON.parse(hostRow.record).revision;
        }
        if (kind === "ordinary-idle-no-legacy-proof") delete evidence.startupCleanup;
        const resolved =
          kind === "resolved-outcome" ||
          legacyRestored ||
          unsupportedRestored ||
          kind === "ordinary-idle-no-legacy-proof";
        database
          .prepare("UPDATE managed_commands SET phase=?,result=?,evidence=? WHERE request_id=?")
          .run(
            resolved ? "resolved" : kind === "dispatched" ? "dispatched" : "prepared",
            resolved ? row.result : null,
            JSON.stringify(evidence),
            requestId,
          );
      } finally {
        database.close();
      }
      writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
      if (kind === "other-command") {
        const other = randomUUID();
        claimManagedCommand(
          f.root,
          other,
          sessionId,
          "synthetic independent mutation",
          "browser-device",
          { operation: "settings" },
        );
        dispatchManagedCommand(f.root, other);
      }
      if (aliasLegacy)
        writeFileSync(
          path.join(f.config, `${record.nativeId}.jsonl`),
          `${JSON.stringify({
            type: "user",
            sessionId: record.nativeId,
            uuid: randomUUID(),
            cwd: f.workspace,
            message: { role: "user", content: "synthetic native history" },
          })}\n`,
          { mode: 0o600 },
        );
      const restarted = host(f, aliasLegacy ? record.nativeId : undefined);
      if (releasedLegacy) {
        const actionRequestId = randomUUID();
        await expect(
          restarted.request(
            kind === "legacy-restored-released-send"
              ? {
                  operation: "send",
                  sessionId,
                  requestId: actionRequestId,
                  deviceId: "browser-device",
                  runtimeBootId: restarted.bootId,
                  // The new host boot advances its own revision exactly once on first read.
                  expectedRevision: record.snapshot.revision + previousHostRevision + 1,
                  experimentalEnabled: true,
                  text: "synthetic blocked retry",
                }
              : {
                  operation: "adopt",
                  sessionId,
                  requestId: actionRequestId,
                  deviceId: "browser-device",
                },
          ),
        ).rejects.toThrow("control-outcome-unconfirmed");
        expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
          createdAt: record.createdAt,
          nativeId: record.nativeId,
          released: true,
          snapshot: { status: "outcome-unknown", sendEnabled: false },
        });
        const ledger = openManagedLedger(f.root)!;
        try {
          expect(ledger.prepare("SELECT COUNT(*) AS count FROM managed_commands").get()).toEqual({
            count: previousCommandCount,
          });
        } finally {
          ledger.close();
        }
      }
      if (aliasLegacy) {
        if (!kind.includes("-unseen-"))
          expect(await restarted.live(sessionId, true)).toMatchObject({
            status: "outcome-unknown",
            sendEnabled: false,
          });
        if (kind.includes("-locked-")) {
          const previousRecord = readFileSync(file, "utf8");
          const release = leases.acquirePortableFileLease(file.replace(/\.json$/, ".lock"));
          try {
            await expect(
              restarted.request({
                operation: "adopt",
                sessionId: record.nativeId,
                requestId: randomUUID(),
                deviceId: "browser-device",
              }),
            ).rejects.toThrow("session-managed-by-another-runtime");
            expect(readFileSync(file, "utf8")).toBe(previousRecord);
            expect(existsSync(path.join(f.root, "claude-managed", `${record.nativeId}.json`))).toBe(
              false,
            );
            const ledger = openManagedLedger(f.root)!;
            try {
              expect(
                ledger.prepare("SELECT COUNT(*) AS count FROM managed_commands").get(),
              ).toEqual({ count: previousCommandCount });
            } finally {
              ledger.close();
            }
          } finally {
            release();
          }
        }
        const actionRequestId = randomUUID();
        await expect(
          restarted.request(
            kind.endsWith("-send")
              ? {
                  operation: "send",
                  sessionId: record.nativeId,
                  requestId: actionRequestId,
                  deviceId: "browser-device",
                  runtimeBootId: restarted.bootId,
                  expectedRevision: 0,
                  experimentalEnabled: true,
                  text: "synthetic blocked alias retry",
                }
              : {
                  operation: "adopt",
                  sessionId: record.nativeId,
                  requestId: actionRequestId,
                  deviceId: "browser-device",
                },
          ),
        ).rejects.toThrow("control-outcome-unconfirmed");
        expect(existsSync(path.join(f.root, "claude-managed", `${record.nativeId}.json`))).toBe(
          false,
        );
        expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
          createdAt: record.createdAt,
          snapshot: { status: "outcome-unknown", sendEnabled: false },
        });
        const ledger = openManagedLedger(f.root)!;
        try {
          expect(ledger.prepare("SELECT COUNT(*) AS count FROM managed_commands").get()).toEqual({
            count: previousCommandCount,
          });
        } finally {
          ledger.close();
        }
      }
      const laterTurnId = randomUUID();
      if (kind === "new-owner-completed") {
        const acquire = leases.acquirePortableFileLease;
        let updated = false;
        vi.spyOn(leases, "acquirePortableFileLease").mockImplementation((lock) => {
          if (!updated && lock === file.replace(/\.json$/, ".lock")) {
            updated = true;
            const release = acquire(lock);
            try {
              // Another runtime writes and releases between our metadata read and lease.
              const latest = JSON.parse(readFileSync(file, "utf8"));
              latest.title = "Later owner title";
              latest.snapshot = {
                ...latest.snapshot,
                status: "idle",
                revision: latest.snapshot.revision + 10,
                turnId: laterTurnId,
                reason: null,
                sendEnabled: true,
              };
              writeFileSync(file, JSON.stringify(latest), { mode: 0o600 });
            } finally {
              release();
            }
          }
          return acquire(lock);
        });
      }
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
      try {
        if (["foreign-mac-kind", "foreign-mac-restored", "not-started-linux"].includes(kind))
          Object.defineProperty(process, "platform", { value: "linux" });
        expect(await restarted.live(sessionId, true)).toMatchObject(
          kind === "new-owner-completed"
            ? { status: "idle", sendEnabled: true, turnId: laterTurnId }
            : untouchedIdle
              ? { status: "idle", sendEnabled: true, turnId: record.snapshot.turnId }
              : recoverable
                ? { status: "idle", sendEnabled: true, turnId: "", reason: failed.error }
                : { status: "outcome-unknown", sendEnabled: false },
        );
      } finally {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      if (kind === "new-owner-completed") {
        expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
          title: "Later owner title",
          snapshot: { turnId: laterTurnId, revision: record.snapshot.revision + 10 },
        });
      }
      if (untouchedIdle) {
        expect(JSON.parse(readFileSync(file, "utf8")).snapshot).toMatchObject({
          status: "idle",
          revision: record.snapshot.revision,
          turnId: record.snapshot.turnId,
        });
      }
      if (
        kind === "legacy-restored" ||
        kind === "legacy-restored-max-revision" ||
        releasedLegacy ||
        aliasLegacy ||
        unsupportedRestored
      ) {
        const quarantined = JSON.parse(readFileSync(file, "utf8")).snapshot;
        expect(quarantined).toMatchObject({ status: "outcome-unknown", sendEnabled: false });
        if (kind === "legacy-restored-max-revision")
          expect(quarantined.revision).toBe(Number.MAX_SAFE_INTEGER);
        else expect(quarantined.revision).toBeGreaterThan(record.snapshot.revision);
      }
      expect(f.frames().filter((frame) => frame.type === "user")).toEqual([]);
      if (recoverable) {
        const ledger = openManagedLedger(f.root)!;
        try {
          const row = ledger
            .prepare("SELECT phase,result FROM managed_commands WHERE request_id=?")
            .get(requestId) as { phase: string; result: string };
          expect(row.phase).toBe("resolved");
          expect(JSON.parse(row.result)).toMatchObject({ controlOutcome: "not-dispatched" });
        } finally {
          ledger.close();
        }
      }
    },
    30_000,
  );

  it("keeps a legacy startup failure unknown when it has no verifiable cleanup receipt", async () => {
    const f = fixture({});
    const owner = host(f);
    const { sessionId } = await create(owner);
    await owner.shutdown();
    const file = path.join(f.root, "claude-managed", `${sessionId}.json`);
    const record = JSON.parse(readFileSync(file, "utf8"));
    record.snapshot.status = "outcome-unknown";
    record.snapshot.reason = "Claude initialize timed out";
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    const restarted = host(f);
    expect(await restarted.live(sessionId, true)).toMatchObject({
      status: "outcome-unknown",
      sendEnabled: false,
    });
    expect(f.frames()).toEqual([]);
  });
});
