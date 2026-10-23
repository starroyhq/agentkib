import childProcesses from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartupClaude, createStartupClaudeSpawn } from "./fixtures/claude-startup-cli";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const f = createStartupClaude();
  f.setPlan({});
  cleanups.push(() => rmSync(f.root, { recursive: true, force: true }));
  return f;
}

function clock(onWait: (count: number) => void = () => undefined) {
  let now = 0;
  let waits = 0;
  return {
    now: () => now,
    wait: vi.fn(() => {
      now += 10;
      onWait(++waits);
    }),
  };
}

function child(pid: number | null = 123456) {
  return { pid: pid ?? undefined } as ReturnType<typeof childProcesses.spawn>;
}

describe("Claude startup fixture readiness", () => {
  it("waits for this shell generation before returning the same owned child", () => {
    const f = fixture();
    const owned = child();
    writeFileSync(f.environment.STARTUP_READY, "old generation\n");
    const spawn = vi.fn(() => {
      expect(existsSync(f.environment.STARTUP_READY)).toBe(false);
      return owned;
    });
    const waiting = clock((count) => {
      if (count === 3) writeFileSync(f.environment.STARTUP_READY, `${owned.pid}\n`);
    });
    const gate = createStartupClaudeSpawn(spawn, waiting);
    const options = { cwd: f.workspace, env: f.environment };
    expect(gate.spawn(f.executable, ["--print"], options)).toBe(owned);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(f.executable, ["--print"], options);
    expect(waiting.wait).toHaveBeenCalledTimes(3);
    expect(gate.failures).toEqual([]);
    expect(f.frames()).toEqual([]);
  });

  it("rejects an old PID left by another generation without retrying spawn", () => {
    const f = fixture();
    const owned = child();
    const spawn = vi.fn(() => {
      writeFileSync(f.environment.STARTUP_READY, `${owned.pid! - 1}\n`);
      return owned;
    });
    const waiting = clock();
    const gate = createStartupClaudeSpawn(spawn, waiting);
    expect(gate.spawn(f.executable, [], { env: f.environment })).toBe(owned);
    expect(gate.failures).toEqual(["startup fixture readiness timed out"]);
    expect(waiting.now()).toBe(2000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("bounds missing readiness and keeps the real child available for runner cleanup", () => {
    const f = fixture();
    const owned = child();
    const spawn = vi.fn(() => owned);
    const waiting = clock();
    const gate = createStartupClaudeSpawn(spawn, waiting);
    expect(gate.spawn(f.executable, [], { env: f.environment })).toBe(owned);
    expect(gate.failures).toEqual(["startup fixture readiness timed out"]);
    expect(waiting.now()).toBe(2000);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(f.frames()).toEqual([]);
  });

  it("returns a failed-spawn child immediately so its error can be handled and cleaned", () => {
    const f = fixture();
    const owned = child(null);
    const spawn = vi.fn(() => owned);
    const waiting = clock();
    const gate = createStartupClaudeSpawn(spawn, waiting);
    expect(gate.spawn(f.executable, [], { env: f.environment })).toBe(owned);
    expect(gate.failures).toEqual(["startup fixture has no process identity"]);
    expect(waiting.wait).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each(["missing marker", "another executable", "another mode file"] as const)(
    "passes through a non-fixture spawn: %s",
    (kind) => {
      const f = fixture();
      const owned = child();
      const environment: NodeJS.ProcessEnv = { ...f.environment };
      if (kind === "missing marker") delete environment.STARTUP_READY;
      if (kind === "another mode file") environment.STARTUP_MODE += ".other";
      const command = kind === "another executable" ? "/bin/sh" : f.executable;
      const spawn = vi.fn(() => owned);
      const waiting = clock();
      const gate = createStartupClaudeSpawn(spawn, waiting);
      const options = { env: environment };
      expect(gate.spawn(command, [], options)).toBe(owned);
      expect(spawn).toHaveBeenCalledExactlyOnceWith(command, [], options);
      expect(waiting.wait).not.toHaveBeenCalled();
      expect(gate.failures).toEqual([]);
    },
  );

  it("invalidates readiness when the next startup plan is selected", () => {
    const f = fixture();
    writeFileSync(f.environment.STARTUP_READY, "123456\n");
    f.setPlan({ silentInitialize: true });
    expect(existsSync(f.environment.STARTUP_READY)).toBe(false);
    expect(readFileSync(f.environment.STARTUP_MODE, "utf8")).toBe("silent\n");
  });

  it.skipIf(!["darwin", "linux"].includes(process.platform))(
    "announces real shell readiness before receiving initialize or any user frame",
    async () => {
      const f = fixture();
      const gate = createStartupClaudeSpawn();
      const owned = gate.spawn(f.executable, [], {
        cwd: f.workspace,
        env: f.environment,
        stdio: ["pipe", "pipe", "ignore"],
      });
      cleanups.push(async () => {
        if (owned.exitCode !== null || owned.signalCode !== null) return;
        const exited = once(owned, "close");
        owned.kill("SIGKILL");
        await exited;
      });
      expect(gate.failures).toEqual([]);
      expect(readFileSync(f.environment.STARTUP_READY, "utf8").trim()).toBe(String(owned.pid));
      expect(f.frames()).toEqual([]);
      const response = once(owned.stdout!, "data");
      const requestId = randomUUID();
      owned.stdin!.write(
        `${JSON.stringify({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "initialize", hooks: null },
        })}\n`,
      );
      const [frame] = await response;
      expect(JSON.parse(String(frame))).toMatchObject({
        type: "control_response",
        response: { subtype: "success", request_id: requestId },
      });
      expect(f.frames()).toHaveLength(1);
      expect(f.frames()[0].type).toBe("control_request");
    },
    30_000,
  );
});
