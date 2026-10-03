import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

export type RuntimeProcessFactory = (
  executablePath: string,
  args: string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcessWithoutNullStreams;

export interface RuntimeTransportOptions {
  executablePath: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

/** One independently terminable process. Both transports use the same host lifecycle. */
export interface RuntimeTransport extends EventEmitter {
  readonly hasExited: boolean;
  send(message: unknown): Promise<void>;
  terminate(): void;
  forceKill(): void;
}

export type RuntimeTransportFactory = (options: RuntimeTransportOptions) => RuntimeTransport;

export function createStdioTransport(
  options: RuntimeTransportOptions,
  spawnProcess: RuntimeProcessFactory = spawn as RuntimeProcessFactory,
): RuntimeTransport {
  const child = spawnProcess(options.executablePath, options.args, {
    env: options.environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new StdioTransport(child);
}

class StdioTransport extends EventEmitter implements RuntimeTransport {
  constructor(readonly child: ChildProcessWithoutNullStreams) {
    super();
    child.once("spawn", () => this.emit("spawn"));
    child.on("error", (error: Error) => this.emit("failure", error));
    // Retain this listener after exit: late EPIPE on an old stream is expected.
    child.stdin.on("error", (error: Error) => this.emit("failure", error));
    child.stderr.on("data", (chunk: Buffer) => this.emit("diagnostic", chunk.toString()));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        this.emit("message", JSON.parse(line));
      } catch (error) {
        this.emit("protocol-error", new Error(`Invalid runtime JSON: ${String(error)}`));
      }
    });
    child.once("exit", (code, signal) => {
      lines.close();
      this.emit("exit", code, signal);
    });
    child.once("close", () => lines.close());
  }

  get hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null;
  }

  send(message: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  terminate(): void {
    this.child.kill("SIGTERM");
  }

  forceKill(): void {
    this.child.kill("SIGKILL");
  }
}
