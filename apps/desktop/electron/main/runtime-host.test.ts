import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../generated/runtime-protocol";
import {
  DesktopRuntimeHost,
  RuntimeUnavailableError,
  type RuntimeHostStatus,
} from "./runtime-host";

const fakeRuntimeSource = String.raw`
const readline = require("node:readline");
const fs = require("node:fs");
const mode = process.env.FAKE_RUNTIME_MODE;
if (mode === "exit-before-handshake") process.exit(12);
if (mode === "restart-once") {
  const marker = process.env.FAKE_RUNTIME_MARKER;
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, "failed");
    process.exit(13);
  }
}
const lines = readline.createInterface({ input: process.stdin });
const respond = (request, result) => process.stdout.write(JSON.stringify({
  jsonrpc: "2.0",
  id: request.id,
  result,
}) + "\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "agentkib.handshake") {
    if (mode === "never-handshake") return;
    const send = () => respond(request, {
      protocolVersion: ${PROTOCOL_VERSION},
      runtime: { name: "fake-runtime", version: "0.0.0" },
      pid: process.pid,
    });
    if (mode === "delayed") setTimeout(send, 60);
    else send();
    return;
  }
  if (request.method === "agentkib.shutdown") {
    if (mode === "ignore-shutdown") return;
    respond(request, null);
    process.exit(0);
  }
  if (request.method === "crash") process.exit(14);
  else if (request.method === "hold") return;
  else respond(request, request.params);
});
`;

describe("DesktopRuntimeHost", () => {
  let directory: string;
  let script: string;
  let hosts: DesktopRuntimeHost[];
  let children: ChildProcessWithoutNullStreams[];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "agentkib-runtime-host-"));
    script = path.join(directory, "fake-runtime.cjs");
    await writeFile(script, fakeRuntimeSource);
    hosts = [];
    children = [];
  });

  afterEach(async () => {
    await Promise.all(hosts.map((host) => host.stop()));
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function createHost(mode: () => string, maxRestarts = 3) {
    const marker = path.join(directory, "restart.marker");
    const host = new DesktopRuntimeHost({
      executablePath: process.execPath,
      clientVersion: "test",
      maxRestarts,
      shutdownTimeoutMs: 200,
      spawnProcess: (_executablePath, _args, options) => {
        const child = spawn(process.execPath, [script], {
          ...options,
          env: {
            ...options?.env,
            FAKE_RUNTIME_MODE: mode(),
            FAKE_RUNTIME_MARKER: marker,
          },
        }) as ChildProcessWithoutNullStreams;
        children.push(child);
        return child;
      },
    });
    hosts.push(host);
    return host;
  }

  it("queues requests until the handshake succeeds", async () => {
    const host = createHost(() => "delayed");
    const starting = host.start();
    const request = host.request<{ value: number }>("echo", { value: 7 });

    await expect(starting).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    await expect(request).resolves.toEqual({ value: 7 });
    expect(host.status.state).toBe("ready");
  });

  it("classifies requests awaiting a failed handshake as runtime outages", async () => {
    const host = createHost(() => "exit-before-handshake", 0);
    const starting = expect(host.start()).rejects.toBeInstanceOf(RuntimeUnavailableError);
    const waiting = expect(host.request("echo", {})).rejects.toBeInstanceOf(
      RuntimeUnavailableError,
    );
    await Promise.all([starting, waiting]);
  });

  it("recovers queued startup requests after a failed first process", async () => {
    const statuses: RuntimeHostStatus[] = [];
    const host = createHost(() => "restart-once");
    host.on("state", (status: RuntimeHostStatus) => statuses.push(status));

    const starting = host.start();
    const request = host.request("echo", { recovered: true });

    await expect(starting).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    await expect(request).resolves.toEqual({ recovered: true });
    expect(statuses.some((status) => status.state === "restarting")).toBe(true);
    expect(host.status.state).toBe("ready");
  });

  it("rejects an in-flight request when the runtime exits", async () => {
    const host = createHost(() => "ready", 0);
    await host.start();

    await expect(host.request("crash", {})).rejects.toBeInstanceOf(RuntimeUnavailableError);
    await vi.waitFor(() => expect(host.status.state).toBe("failed"));
  });

  it("allows a terminal failure to be retried manually", async () => {
    let mode = "exit-before-handshake";
    const host = createHost(() => mode, 0);

    await expect(host.start()).rejects.toThrow();
    expect(host.status.state).toBe("failed");
    await expect(host.request("echo", {})).rejects.toBeInstanceOf(RuntimeUnavailableError);

    mode = "ready";
    await expect(host.retry()).resolves.toMatchObject({ protocolVersion: PROTOCOL_VERSION });
    expect(host.status.state).toBe("ready");
  });

  it("contains startup stdin errors and can retry without a stale error", async () => {
    let mode = "never-handshake";
    const host = createHost(() => mode, 0);
    const starting = expect(host.start()).rejects.toThrow("EPIPE");
    children[0].stdin.destroy(new Error("EPIPE"));
    await starting;
    expect(host.status.state).toBe("failed");

    mode = "ready";
    await host.retry();
    expect(host.status).toMatchObject({ state: "ready", restartCount: 0 });
    expect(host.status.error).toBeUndefined();
    // Old pipes can emit after the replacement process is already ready.
    expect(() => children[0].stdin.emit("error", new Error("late EPIPE"))).not.toThrow();
    await expect(host.request("echo", { recovered: true })).resolves.toEqual({ recovered: true });
  });

  it("rejects all pending requests on a broken pipe and restarts only once", async () => {
    const host = createHost(() => "ready", 1);
    await host.start();
    const exited = vi.fn();
    host.on("exit", exited);
    const first = expect(host.request("hold", {})).rejects.toBeInstanceOf(RuntimeUnavailableError);
    const second = expect(host.request("hold", {})).rejects.toThrow("EPIPE");
    children[0].stdin.destroy(new Error("EPIPE"));
    await Promise.all([first, second]);
    await expect(host.request("echo", { recovered: true })).resolves.toEqual({ recovered: true });
    expect(children).toHaveLength(2);
    expect(host.status.state).toBe("ready");
    expect(exited).toHaveBeenCalledTimes(1);
    expect(exited).toHaveBeenCalledWith(expect.objectContaining({ expected: false }));
  });

  it("handles synchronous write failure through the same recovery path", async () => {
    const host = createHost(() => "ready", 0);
    await host.start();
    vi.spyOn(children[0].stdin, "write").mockImplementation(() => {
      throw new Error("synchronous pipe failure");
    });
    await expect(host.request("echo", {})).rejects.toBeInstanceOf(RuntimeUnavailableError);
    expect(host.status.state).toBe("failed");
  });

  it("cancels startup waiters when stopped", async () => {
    const host = createHost(() => "never-handshake");
    const starting = host.start();
    const request = host.request("echo", {});
    const startingResult = expect(starting).rejects.toThrow("stopping");
    const requestResult = expect(request).rejects.toBeInstanceOf(RuntimeUnavailableError);

    await host.stop();
    await startingResult;
    await requestResult;
    expect(host.status.state).toBe("stopping");
    await expect(host.request("echo", {})).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  it("bounds shutdown when the runtime ignores the shutdown request", async () => {
    const host = createHost(() => "ignore-shutdown");
    await host.start();
    const startedAt = Date.now();

    await host.stop();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(host.status.state).toBe("stopping");
  });
});
