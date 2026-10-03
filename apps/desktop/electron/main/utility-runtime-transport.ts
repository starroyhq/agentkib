import { EventEmitter } from "node:events";
import { utilityProcess, type UtilityProcess } from "electron";
import type { RuntimeTransport, RuntimeTransportOptions } from "./runtime-transport";

export function createUtilityTransport(options: RuntimeTransportOptions): RuntimeTransport {
  return new UtilityTransport(
    utilityProcess.fork(options.executablePath, options.args, {
      env: options.environment,
      stdio: "pipe",
      serviceName: "AgentKib TypeScript Backend",
    }),
  );
}

class UtilityTransport extends EventEmitter implements RuntimeTransport {
  #exited = false;

  constructor(readonly child: UtilityProcess) {
    super();
    child.once("spawn", () => this.emit("spawn"));
    child.on("message", (message) => this.emit("message", message));
    child.on("error", (type, location) => this.emit("failure", new Error(`${type}: ${location}`)));
    child.stderr?.on("data", (chunk: Buffer) => this.emit("diagnostic", chunk.toString()));
    child.once("exit", (code) => {
      this.#exited = true;
      this.emit("exit", code, null);
    });
  }

  get hasExited(): boolean {
    return this.#exited;
  }

  async send(message: unknown): Promise<void> {
    this.child.postMessage(message);
  }

  terminate(): void {
    this.child.kill();
  }

  forceKill(): void {
    const pid = this.child.pid;
    if (pid !== undefined && !this.#exited) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  }
}
