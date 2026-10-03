import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { windowsProcessTree, type NativeProcessTree } from "./native-process";
import { resolveCommand } from "./command-resolution";
export interface CommandOutput {
  bytes: Buffer;
  error: string;
  success: boolean;
  truncated: boolean;
  exitCode: number | null;
}
/** Drain both pipes without retaining unbounded output, and supervise the whole process group. */
export class Commands {
  #running = new Set<ChildProcess>();
  #trees = new Map<ChildProcess, NativeProcessTree>();
  #closed = false;
  close(): void {
    this.#closed = true;
    for (const child of this.#running) this.#kill(child);
  }
  async run(
    program: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      limit?: number;
      timeout?: number;
      allowFailure?: boolean;
      input?: Buffer;
      strictOutput?: boolean;
      terminateDescendantsOnExit?: boolean;
    } = {},
  ): Promise<CommandOutput> {
    if (this.#closed) throw new Error("Backend command supervisor is closed");
    const limit = options.limit ?? 2 * 1024 * 1024;
    const environment = options.env ?? process.env;
    const executable =
      resolveCommand(program, environment, options.cwd ?? process.cwd()) ?? program;
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: options.cwd,
        env: environment,
        stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      this.#running.add(child);
      let supervisionError: unknown;
      if (process.platform === "win32" && options.terminateDescendantsOnExit && child.pid) {
        try {
          this.#trees.set(child, windowsProcessTree(child.pid));
        } catch (error) {
          supervisionError = error;
          child.kill("SIGKILL");
        }
      }
      if (options.input) {
        child.stdin!.on("error", () => {});
        child.stdin!.end(options.input);
      }
      const output: Buffer[] = [],
        errors: Buffer[] = [];
      let count = 0,
        errorCount = 0,
        truncated = false,
        expired = false,
        failure: string | null = null;
      const overflow = (maximum: number) => {
        if (!options.strictOutput || failure !== null) return;
        failure = `${program} output exceeds the ${maximum}-byte limit`;
        this.#kill(child);
      };
      child.stdout!.on("data", (chunk: Buffer) => {
        const room = Math.max(0, limit - count);
        if (chunk.length > room) {
          truncated = true;
          overflow(limit);
        }
        if (room) output.push(chunk.subarray(0, room));
        count += Math.min(room, chunk.length);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        const room = Math.max(0, 65536 - errorCount);
        if (chunk.length > room) overflow(65536);
        if (room) errors.push(chunk.subarray(0, room));
        errorCount += Math.min(room, chunk.length);
      });
      const timer = setTimeout(() => {
        expired = true;
        this.#kill(child);
      }, options.timeout ?? 15000);
      const finish = () => {
        clearTimeout(timer);
        this.#running.delete(child);
        this.#trees.get(child)?.close();
        this.#trees.delete(child);
      };
      child.once("error", (error) => {
        finish();
        reject(error);
      });
      child.once("exit", () => {
        if (options.terminateDescendantsOnExit) this.#kill(child);
      });
      child.once("close", (code) => {
        finish();
        if (supervisionError !== undefined) {
          reject(supervisionError);
          return;
        }
        if (failure !== null) {
          reject(new Error(failure));
          return;
        }
        if (expired) {
          reject(new Error(`${program} command timed out`));
          return;
        }
        const error = [...Buffer.concat(errors).toString("utf8").trim()].slice(0, 500).join("");
        const result = {
          bytes: Buffer.concat(output),
          error,
          success: code === 0,
          truncated,
          exitCode: code,
        };
        if (!result.success && !options.allowFailure)
          reject(new Error(`${program} command failed: ${error}`));
        else resolve(result);
      });
    });
  }
  #kill(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      const tree = this.#trees.get(child);
      if (tree) {
        tree.terminate();
        return;
      }
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => child.kill("SIGKILL"));
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }
}
