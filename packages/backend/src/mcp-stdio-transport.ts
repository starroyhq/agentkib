import spawn from "cross-spawn";
import type { ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { windowsProcessTree, type NativeProcessTree } from "./native-process";

/** Own a process group (or Windows job) from spawn through pipe shutdown. */
export class McpStdioTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  #child?: ChildProcess;
  #tree?: NativeProcessTree;
  #buffer = new ReadBuffer({ maxBufferSize: 10 * 1024 * 1024 });
  #closing?: Promise<void>;
  #started = false;
  #notified = false;

  constructor(
    readonly options: {
      command: string;
      args: string[];
      cwd?: string;
      env: Record<string, string>;
    },
  ) {}

  async start(): Promise<void> {
    if (this.#started) throw new Error("MCP stdio transport already started");
    this.#started = true;
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.#child = child;
    child.once("exit", () => this.#terminate());
    child.once("close", () => {
      this.#terminate();
      this.#tree?.close();
      this.#notifyClose();
    });
    child.stdin!.on("error", (error) => this.onerror?.(error));
    child.stdout!.on("error", (error) => this.onerror?.(error));
    child.stdout!.on("data", (chunk: Buffer) => {
      try {
        this.#buffer.append(chunk);
        for (;;) {
          const message = this.#buffer.readMessage();
          if (message === null) break;
          this.onmessage?.(message);
        }
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        void this.close();
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.on("error", (error) => {
        this.onerror?.(error);
        reject(error);
      });
      child.once("spawn", () => {
        try {
          if (process.platform === "win32" && child.pid) this.#tree = windowsProcessTree(child.pid);
          resolve();
        } catch (error) {
          this.#terminate();
          reject(error);
        }
      });
    });
  }

  #terminate(): void {
    const child = this.#child;
    if (!child?.pid) return;
    if (this.#tree) {
      this.#tree.terminate();
      return;
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
      }
    } else child.kill("SIGKILL");
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    return (this.#closing = (async () => {
      const child = this.#child;
      if (child) {
        const exited = new Promise<void>((resolve) => {
          if (this.#notified) resolve();
          else child.once("close", resolve);
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          child.stdin?.end();
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 500);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          // The root can already have exited while its descendants still own the pipes.
          this.#terminate();
          this.#tree?.close();
          child.stdin?.destroy();
          child.stdout?.destroy();
        }
      }
      this.#buffer.clear();
      this.#notifyClose();
    })());
  }

  #notifyClose(): void {
    if (this.#notified) return;
    this.#notified = true;
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    const child = this.#child;
    if (!child?.stdin || this.#closing || this.#notified)
      return Promise.reject(new Error("MCP transport is closed"));
    return new Promise((resolve, reject) =>
      child.stdin!.write(serializeMessage(message), (error) => (error ? reject(error) : resolve())),
    );
  }
}
