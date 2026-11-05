// @vitest-environment node
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("cross-spawn", () => ({ default: spawn }));
vi.mock("../../../packages/backend/src/command-resolution", () => ({
  resolveCommand: () => "synthetic-cli.CMD",
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "win32" });
  vi.stubEnv("SystemRoot", "R:\\Windows");
  vi.stubEnv("PATH", "R:\\isolated-tools");
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
  spawn.mockReset();
  vi.useRealTimers();
});

describe("Windows command cancellation with an isolated PATH", () => {
  it.each(["abort", "timeout", "close"] as const)(
    "uses the system tree terminator on %s rather than resolving it in the CLI PATH",
    async (reason) => {
      const child = Object.assign(new EventEmitter(), {
        pid: 12345,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const killer = new EventEmitter();
      spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
      const commands = new Commands();
      const controller = new AbortController();
      const result = commands.run("synthetic-cli", [], {
        env: { PATH: "R:\\isolated-tools" },
        signal: controller.signal,
        timeout: 100,
      });
      const failure = expect(result).rejects.toThrow();
      if (reason === "abort") controller.abort(new Error("cancelled"));
      else if (reason === "timeout") await vi.advanceTimersByTimeAsync(100);
      else commands.close();

      expect(spawn).toHaveBeenLastCalledWith(
        "R:\\Windows\\System32\\taskkill.exe",
        ["/PID", "12345", "/T", "/F"],
        { stdio: "ignore", windowsHide: true },
      );
      expect(child.kill).not.toHaveBeenCalled();
      child.emit("close", 1);
      await failure;
      expect(vi.getTimerCount()).toBe(0);
      child.stdout.destroy();
      child.stderr.destroy();
    },
  );
});
