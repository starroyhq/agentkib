import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HandoffWork, readHandoff } from "../../../packages/backend/src/handoff-work";
import { TaskContext } from "../../../packages/backend/src/task-executor";
import { BackendStore } from "../../../packages/backend/src/store";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function observeFixtureCli() {
  const started = Promise.withResolvers<Socket>();
  const stopped = Promise.withResolvers<void>();
  let peer: Socket | undefined;
  const server = createServer((socket) => {
    peer = socket;
    socket.on("error", () => {}); // Windows tree termination can reset the connection.
    socket.once("close", () => stopped.resolve());
    started.resolve(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    peer?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return { port: (server.address() as { port: number }).port, started, stopped };
}

type Frame = {
  id: number;
  result?: { draft?: { content: string } };
  error?: { data?: { detail?: string } };
};
async function fixture(mode: "hash" | "cli" | "crash") {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "handoff-executor-")));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"),
    project = path.join(root, "project"),
    dist = path.join(root, "dist"),
    bin = path.join(root, "bin");
  await Promise.all(
    [project, dist, bin, path.join(root, ".claude/projects/fixture")].map((p) =>
      fs.mkdir(p, { recursive: true }),
    ),
  );
  const native = randomUUID(),
    log = path.join(root, ".claude/projects/fixture", native + ".jsonl");
  const userId = randomUUID();
  const content =
    [
      {
        type: "user",
        uuid: userId,
        parentUuid: null,
        sessionId: native,
        cwd: project,
        timestamp: "2026-10-07T00:00:00.000Z",
        message: { role: "user", content: "handoff-random-marker: " + native },
      },
      {
        type: "assistant",
        uuid: randomUUID(),
        parentUuid: userId,
        sessionId: native,
        cwd: project,
        timestamp: "2026-10-07T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Project decision: keep the ledger append-only." }],
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
  await fs.writeFile(log, content);
  const store = new BackendStore(path.join(dataDir, "agentkib.db"));
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    "fixture",
    project,
    "Fixture",
    "fixture",
    "healthy",
    "2026-10-07T00:00:00.000Z",
  );
  store.sessions.sync("fixture", "claude-code", [
    {
      native_ref: native,
      agent: "claude-code",
      title: "Fixture",
      created_at: null,
      updated_at: null,
      message_count: 2,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    },
  ]);
  const sessionId = store.sessions.id("claude-code", native);
  store.close();
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  await fs.writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
      session_index_enabled: false,
    }),
  );
  for (const name of await fs.readdir("dist-electron"))
    if (name.startsWith("backend") && name.endsWith(".cjs"))
      await fs.copyFile(path.join("dist-electron", name), path.join(dist, name));
  if (process.platform === "win32")
    await fs.cp("dist-electron/native", path.join(dist, "native"), { recursive: true });
  const marker = path.join(root, "entered"),
    attempts = path.join(root, "attempts");
  await fs.rename(path.join(dist, "backend-handoff-read.cjs"), path.join(dist, "read-real.cjs"));
  await fs.writeFile(
    path.join(dist, "backend-handoff-read.cjs"),
    `
const fs=require('node:fs'),crypto=require('node:crypto');const createHash=crypto.createHash;let held=false;
crypto.createHash=function(...args){if(!held){held=true;fs.appendFileSync(${JSON.stringify(attempts)},'1');fs.writeFileSync(${JSON.stringify(marker)},'hash');${mode === "crash" ? "process.exit(17);" : mode === "hash" ? "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1800);" : ""}}return createHash.apply(this,args)};
require('./read-real.cjs');`,
  );
  const cliLifetime = mode === "cli" ? await observeFixtureCli() : undefined;
  const cli = path.join(bin, "slow.cjs");
  if (cliLifetime) {
    // Leave the peer open until the Runtime terminates the CLI. Close it if the test host dies.
    await fs.writeFile(
      cli,
      `const peer = require('node:net').createConnection(${cliLifetime.port}, '127.0.0.1');
peer.once('end', () => process.exit(0));
peer.once('error', () => process.exit(1));
setTimeout(() => process.exit(2), 30_000).unref();`,
    );
    // The CLI resolves only to this isolated fake.
    if (process.platform === "win32")
      await fs.writeFile(
        path.join(bin, "codex.CMD"),
        `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`,
      );
    else
      await fs.writeFile(
        path.join(bin, "codex"),
        `#!${process.execPath}\nrequire(${JSON.stringify(cli)});`,
        { mode: 0o755 },
      );
  }
  const child = spawn(process.execPath, [path.join(dist, "backend.cjs")], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      AGENTKIB_HOME: path.join(root, "library"),
      CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
      CODEX_HOME: path.join(root, ".codex"),
      PATH: bin,
    },
    stdio: "pipe",
  });
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  cleanups.push(async () => {
    if (!exited) {
      child.kill();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
  let sequence = 0,
    errors = "";
  const pending = new Map<number, { resolve(frame: Frame): void; reject(error: Error): void }>(),
    counts = new Map<number, number>(),
    order: number[] = [];
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    if (typeof frame.id !== "number") return;
    counts.set(frame.id, (counts.get(frame.id) ?? 0) + 1);
    order.push(frame.id);
    pending.get(frame.id)?.resolve(frame);
    pending.delete(frame.id);
  });
  child.on("exit", () => {
    for (const waiter of pending.values()) waiter.reject(new Error(errors || "Backend exited"));
    pending.clear();
  });
  const request = (method: string, params: Record<string, unknown> = {}) => {
    const id = ++sequence;
    return {
      id,
      promise: new Promise<Frame>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      }),
    };
  };
  expect((await request("backend.initialize", { dataDir }).promise).error).toBeUndefined();
  const prepare = () =>
    request("sessions.prepareHandoff", {
      request: {
        session_id: sessionId,
        target_agent: mode === "cli" ? "codex" : "grok-build",
        format: "markdown",
        history_budget_tokens: 64000,
      },
      mcpHubStatus: { running: false, port },
    });
  const observed = () =>
    cliLifetime?.started.promise ??
    vi.waitFor(async () => expect(await fs.readFile(marker, "utf8")).not.toBe(""), {
      timeout: 5000,
    });
  return {
    root,
    project,
    log,
    content,
    native,
    marker,
    attempts,
    request,
    prepare,
    observed,
    cliLifetime,
    counts,
    order,
    child,
  };
}

describe("built Backend handoff isolation", () => {
  it.each(["hash", "cli"] as const)(
    "keeps ordinary requests responsive during real %s work and cancels cleanly",
    async (mode) => {
      const f = await fixture(mode);
      const slow = f.prepare();
      await f.observed();
      const start = performance.now();
      const frames = await Promise.all([
        f.request("runtime.info").promise,
        f.request("workspaces.list").promise,
        f.request("workspace.sessions", { workspaceId: "fixture" }).promise,
      ]);
      expect(performance.now() - start).toBeLessThan(1000);
      for (const frame of frames) expect(frame.error).toBeUndefined();
      if (f.cliLifetime) expect((await f.cliLifetime.started.promise).destroyed).toBe(false);
      const shutdown = f.request("agentkib.shutdown");
      expect((await slow.promise).error).toBeDefined();
      expect((await shutdown.promise).error).toBeUndefined();
      expect(await fs.readFile(f.log, "utf8")).toBe(f.content);
      for (const count of f.counts.values()) expect(count).toBe(1);
      // The RPC acknowledges cancellation before Windows finishes terminating the tree.
      if (f.cliLifetime) await f.cliLifetime.stopped.promise;
    },
    15000,
  );
  it("admits exactly eight waiters, preserves FIFO and renders the actual source", async () => {
    const f = await fixture("hash"),
      first = f.prepare();
    await f.observed();
    const waiting = Array.from({ length: 8 }, () => f.prepare());
    expect((await f.prepare().promise).error?.data?.detail).toContain("queue is full");
    const accepted = [first, ...waiting];
    const frames = await Promise.all(accepted.map((r) => r.promise));
    for (const frame of frames) {
      expect(frame.error).toBeUndefined();
      expect(JSON.stringify(frame.result)).toContain(f.native);
      expect(JSON.stringify(frame.result)).toContain("keep the ledger append-only");
    }
    expect(f.order.filter((id) => accepted.some((r) => r.id === id))).toEqual(
      accepted.map((r) => r.id),
    );
    await f.request("agentkib.shutdown").promise;
    for (const count of f.counts.values()) expect(count).toBe(1);
  }, 20000);
  it("rejects subsequent work after a read Worker crash without replaying the failed operation", async () => {
    const f = await fixture("crash");
    expect((await f.prepare().promise).error).toBeDefined();
    expect((await f.prepare().promise).error).toBeDefined();
    expect(await fs.readFile(f.attempts, "utf8")).toBe("1");
    expect((await f.request("runtime.info").promise).error).toBeUndefined();
    await f.request("agentkib.shutdown").promise;
    expect(await fs.readFile(f.log, "utf8")).toBe(f.content);
    for (const count of f.counts.values()) expect(count).toBe(1);
  }, 15000);
});

describe("handoff read deadline", () => {
  it("terminates a CPU-bound read at the deadline and permits only a new request afterward", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "handoff-read-deadline-"));
    cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
    const marker = path.join(root, "blocked"),
      filename = path.join(root, "read.cjs");
    await fs.writeFile(
      filename,
      `const fs=require('node:fs');if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'1');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}require(${JSON.stringify(path.resolve("dist-electron/backend-handoff-read.cjs"))});`,
    );
    const owner = new HandoffWork({ filename });
    cleanups.push(() => owner.close());
    const task = new TaskContext({ id: "timed-read", deadlineAt: Date.now() + 300 });
    const result = owner.run(task, () =>
      readHandoff("serialize", { value: { marker: 1 }, pretty: false, newline: false }, () => {
        throw new Error("must use worker");
      }),
    );
    await expect(result).rejects.toMatchObject({ reason: "deadline-exceeded" });
    task.dispose();
    const next = new TaskContext({ id: "new-read", deadlineAt: Date.now() + 5000 });
    await expect(
      owner.run(next, () =>
        readHandoff("serialize", { value: { marker: 2 }, pretty: false, newline: false }, () => {
          throw new Error("must use worker");
        }),
      ),
    ).resolves.toMatchObject({ content: '{"marker":2}' });
    next.dispose();
    expect(await fs.readFile(marker, "utf8")).toBe("1");
  });
});
