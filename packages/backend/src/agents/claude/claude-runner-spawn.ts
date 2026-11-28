import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { restrictRemotePath } from "../../remote-tls";

/** An owned process group cannot confirm the exit of descendants that made their own group. */
export class UnixProcessGroup {
  constructor(readonly processGroupId: number) {}

  static attach(child: ChildProcess): UnixProcessGroup {
    if (!child.pid) throw new Error("owned process has no PID");
    return new UnixProcessGroup(child.pid);
  }

  async terminate(child: ChildProcess): Promise<void> {
    let failure: unknown;
    try {
      process.kill(-this.processGroupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error;
    }
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("close", onClose);
          reject(new Error("owned process group exit unconfirmed"));
        }, 2000);
        const onClose = () => {
          clearTimeout(timer);
          resolve();
        };
        child.once("close", onClose);
      }).catch((error: unknown) => {
        failure ??= error;
      });
    }
    if (failure) throw failure;
  }
}

export function spawnClaudeRunner(
  executable: string,
  args: (mcpConfigFile?: string) => string[],
  options: SpawnOptions,
  mcpConfig?: Record<string, unknown>,
) {
  if (!mcpConfig) return spawn(executable, args(), options);

  // The config contains loopback capabilities. Process arguments can be visible to other users.
  const directory = mkdtempSync(path.resolve(tmpdir(), "agentkib-claude-mcp-"));
  const file = path.join(directory, "mcp.json");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    try {
      rmSync(directory, { recursive: true, force: true });
      cleaned = true;
    } catch {
      // A cleanup failure leaves only a private, per-process directory.
    }
  };
  try {
    restrictRemotePath(directory, true);
    writeFileSync(file, JSON.stringify(mcpConfig), { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") restrictRemotePath(file);
    // `close` also covers a spawn that fails before emitting `exit`.
    return spawn(executable, args(file), options).once("exit", cleanup).once("close", cleanup);
  } catch (error) {
    cleanup();
    throw error;
  }
}
