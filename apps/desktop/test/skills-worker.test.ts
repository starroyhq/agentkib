import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Skills } from "../../../packages/backend/src/skills";
import {
  TaskContext,
  BackendTaskError,
  runWithTask,
} from "../../../packages/backend/src/task-executor";
import { SkillsWorker } from "../../../packages/backend/src/skills-worker";
import { BackendStore } from "../../../packages/backend/src/store";

const homes: string[] = [];
const workers: SkillsWorker[] = [];
const children: Array<{ child: ChildProcessWithoutNullStreams; closed: Promise<void> }> = [];
const built = path.resolve("dist-electron/backend-skills.cjs");
const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as {
  createIsolatedWorkerEnvironment(root: string, source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
};
const environment = (home: string) => ({
  HOME: home,
  USERPROFILE: home,
  AGENTKIB_HOME: path.join(home, "library"),
});
async function home() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-worker-"));
  homes.push(value);
  return value;
}
async function wrapper(directory: string, source: string) {
  const filename = path.join(directory, "worker.cjs");
  await fs.writeFile(filename, `${source}\nrequire(${JSON.stringify(built)});\n`);
  return filename;
}
async function fixture(source = "", timeoutMs = 180_000) {
  const directory = await home();
  const filename = await wrapper(directory, source);
  const worker = new SkillsWorker(environment(directory), path.join(directory, "data"), () => [], {
    filename,
    timeoutMs,
  });
  workers.push(worker);
  return { directory, worker };
}
async function local(directory: string) {
  const folder = path.join(directory, ".claude/skills/reviewer");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(
    path.join(folder, "SKILL.md"),
    "---\nname: reviewer\ndescription: Local fixture\n---\nPreserve this text.\n",
  );
  return folder;
}
async function prepare(worker: SkillsWorker) {
  const result = (await worker.request("skills.inventory", {})) as {
    observations: Array<{ id: string }>;
  };
  expect(result.observations.length).toBeGreaterThan(0);
  return (await worker.request("skills.prepareImport", {
    observation_id: result.observations[0]!.id,
  })) as { token: string; library_id: string };
}
const stalledNetwork = `
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');
const marker = path.join(workerData.environment.HOME, 'network-entered');
global.fetch = (_url, options) => new Promise((_resolve, reject) => {
  fs.appendFileSync(marker, 'request\\n');
  if (options.signal.aborted) reject(options.signal.reason);
  else options.signal.addEventListener('abort', () => reject(options.signal.reason), {once:true});
});`;
async function observed(file: string) {
  await vi.waitFor(async () => expect(await fs.readFile(file, "utf8")).not.toBe(""), {
    timeout: 5000,
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  // Windows keeps native DLLs locked until the owning process has actually closed.
  await Promise.all(
    children.splice(0).map(async ({ child, closed }) => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await closed;
    }),
  );
  await Promise.all(
    homes.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("persistent Skills worker", () => {
  it("keeps preview ownership across requests and applies the real package once", async () => {
    const { directory, worker } = await fixture();
    const original = await local(directory);
    const preview = await prepare(worker);
    const result = await worker.request("skills.applyOperation", {
      token: preview.token,
      confirmed: true,
    });
    expect(result).toBeDefined();
    expect(
      await fs.readFile(
        path.join(directory, "library/skills", preview.library_id, "SKILL.md"),
        "utf8",
      ),
    ).toBe(await fs.readFile(path.join(original, "SKILL.md"), "utf8"));
    await expect(
      worker.request("skills.applyOperation", { token: preview.token, confirmed: true }),
    ).rejects.toThrow();
  });

  it("admits eight waiting requests and cancels network and pending work exactly once on shutdown", async () => {
    const { directory, worker } = await fixture(stalledNetwork);
    const active = worker.request("skills.discover", { url: "https://github.com/example/skills" });
    const rejected = expect(active).rejects.toMatchObject({ reason: "backend-closing" });
    await observed(path.join(directory, "network-entered"));
    const waiting = Array.from({ length: 8 }, () => worker.request("skills.listInstalled", {}));
    const rejectedWaiters = waiting.map((promise) =>
      expect(promise).rejects.toMatchObject({ reason: "backend-closing" }),
    );
    await expect(worker.request("skills.listInstalled", {})).rejects.toMatchObject({
      reason: "queue-full",
    });
    await worker.close();
    await Promise.all([rejected, ...rejectedWaiters]);
    expect(
      (await fs.readFile(path.join(directory, "network-entered"), "utf8")).trim().split("\n"),
    ).toHaveLength(1);
  });

  it("returns the stale catalog after its admission deadline without starting new scans", async () => {
    const { directory, worker } = await fixture(stalledNetwork, 500);
    const cache = path.join(directory, "data/skill-cache/curated-skills.json");
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(
      cache,
      JSON.stringify({
        cached_at: "2000-01-01T00:00:00.000Z",
        entries: [{ candidate: { name: "cached" }, installed: true }],
      }),
    );
    await expect(worker.request("skills.listCatalog", { force: true })).resolves.toMatchObject({
      stale: true,
      entries: [{ name: "cached", installed: true }],
    });
    expect(JSON.parse(await fs.readFile(cache, "utf8")).cached_at).toBe("2000-01-01T00:00:00.000Z");
  });

  it.each(["task", "request"])(
    "rejects %s timeout update checks instead of reporting all skills current",
    async (kind) => {
      const { directory, worker } = await fixture(
        kind === "task"
          ? stalledNetwork
          : `global.fetch = async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };`,
        600,
      );
      await local(directory);
      const preview = await prepare(worker);
      await worker.request("skills.applyOperation", { token: preview.token, confirmed: true });
      const lockFile = path.join(directory, "library/skills.lock.json");
      const lock = JSON.parse(await fs.readFile(lockFile, "utf8"));
      lock.skills[preview.library_id].source = {
        kind: "github",
        repository: "example/skills",
        ref: "main",
        ref_type: "branch",
        path: "reviewer",
        resolved_commit: "a".repeat(40),
        tree_sha: "tree",
      };
      await fs.writeFile(lockFile, JSON.stringify(lock));
      if (kind === "task")
        await expect(worker.request("skills.checkUpdates", {})).rejects.toMatchObject({
          reason: "deadline-exceeded",
        });
      else await expect(worker.request("skills.checkUpdates", {})).rejects.toThrow("timeout");
    },
  );

  it("does not replay a request when its worker crashes", async () => {
    const { directory, worker } = await fixture(
      `const fs=require('node:fs');const path=require('node:path');const {workerData}=require('node:worker_threads');global.fetch=()=>{fs.appendFileSync(path.join(workerData.environment.HOME,'attempts'),'1');process.exit(17)};`,
    );
    await expect(
      worker.request("skills.discover", { url: "https://github.com/example/skills" }),
    ).rejects.toMatchObject({ reason: "worker-failed" });
    await expect(
      worker.request("skills.discover", { url: "https://github.com/example/skills" }),
    ).rejects.toMatchObject({ reason: "worker-failed" });
    expect(await fs.readFile(path.join(directory, "attempts"), "utf8")).toBe("1");
  });

  it("rechecks workspace ownership after staging and preserves the target when registration is revoked", async () => {
    const directory = await home();
    const workspace = path.join(directory, "project");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    let registered = true;
    const filename = await wrapper(
      directory,
      `
const fs=require('node:fs');const path=require('node:path');const {workerData}=require('node:worker_threads');
const dir=workerData.environment.HOME;const copy=fs.promises.copyFile.bind(fs.promises);
fs.promises.copyFile=async(from,to,...args)=>{await copy(from,to,...args);if(String(to).includes(path.join('new','SKILL.md'))){fs.writeFileSync(path.join(dir,'staged'),'1');while(!fs.existsSync(path.join(dir,'release')))await new Promise(r=>setTimeout(r,5));}};
`,
    );
    const worker = new SkillsWorker(
      environment(directory),
      path.join(directory, "data"),
      () => (registered ? [{ id: "workspace", path: workspace }] : []),
      { filename },
    );
    workers.push(worker);
    await local(directory);
    const preview = await prepare(worker);
    await worker.request("skills.applyOperation", { token: preview.token, confirmed: true });
    const targets = (await worker.request("skills.targets", {})) as Array<{
      id: string;
      workspace_id: string;
      agent: string;
    }>;
    const target = targets.find(
      (item) => item.workspace_id === "workspace" && item.agent === "claude-code",
    );
    expect(target).toBeDefined();
    const deployment = (await worker.request("skills.prepareDeployment", {
      operation: "deploy",
      library_id: preview.library_id,
      target_ids: [target!.id],
    })) as { token: string };
    const applying = worker.request("skills.applyDeployment", {
      token: deployment.token,
      confirmed: true,
    });
    await observed(path.join(directory, "staged"));
    registered = false;
    await fs.writeFile(path.join(directory, "release"), "1");
    await expect(applying).resolves.toMatchObject({
      results: [{ success: false, error: expect.stringContaining("workspace changed") }],
    });
    await expect(fs.access(path.join(workspace, ".claude/skills/reviewer"))).rejects.toThrow();
  });

  it("finishes a started local commit before shutdown closes the worker", async () => {
    const { directory, worker } = await fixture(`
const fs=require('node:fs');const path=require('node:path');const {workerData}=require('node:worker_threads');
const dir=workerData.environment.HOME;const rename=fs.promises.rename.bind(fs.promises);
fs.promises.rename=async(from,to)=>{if(String(to).includes(path.join('skills','reviewer'))){fs.writeFileSync(path.join(dir,'writing'),'1');while(!fs.existsSync(path.join(dir,'release'))) await new Promise(r=>setTimeout(r,5));}return rename(from,to)};
`);
    await local(directory);
    const preview = await prepare(worker);
    const result = worker.request("skills.applyOperation", {
      token: preview.token,
      confirmed: true,
    });
    await observed(path.join(directory, "writing"));
    let closed = false;
    const close = worker.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    await fs.writeFile(path.join(directory, "release"), "1");
    await result;
    await close;
    expect(
      await fs.readFile(
        path.join(directory, "library/skills", preview.library_id, "SKILL.md"),
        "utf8",
      ),
    ).toContain("Preserve this text");
  });
});

type Frame = { id: number; result?: unknown; error?: { message: string; data?: unknown } };
async function backend(directory: string, workerPatch: string) {
  // OpenCode compatibility scans stop at the nearest Git root, independently of HOME.
  await fs.mkdir(path.join(directory, ".git"), { recursive: true });
  const dist = path.join(directory, "dist");
  await fs.mkdir(dist);
  for (const entry of await fs.readdir(path.dirname(built)))
    if (entry.endsWith(".cjs") && entry.startsWith("backend"))
      await fs.copyFile(path.join(path.dirname(built), entry), path.join(dist, entry));
  if (process.platform === "win32")
    await fs.cp(path.join(path.dirname(built), "native"), path.join(dist, "native"), {
      recursive: true,
    });
  await fs.rename(path.join(dist, "backend-skills.cjs"), path.join(dist, "skills-real.cjs"));
  await fs.writeFile(
    path.join(dist, "backend-skills.cjs"),
    `${workerPatch}\nrequire('./skills-real.cjs');`,
  );
  const isolatedEnvironment = createIsolatedWorkerEnvironment(directory);
  await fs.mkdir(isolatedEnvironment.TMPDIR!, { recursive: true });
  const child = spawn(process.execPath, [path.join(dist, "backend.cjs")], {
    env: isolatedEnvironment,
    stdio: "pipe",
  });
  children.push({
    child,
    closed: new Promise<void>((resolve) => child.once("close", () => resolve())),
  });
  let sequence = 0;
  const pending = new Map<number, { resolve(value: Frame): void; reject(error: Error): void }>();
  const counts = new Map<number, number>();
  let errors = "";
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line) as Frame;
    if (typeof frame.id !== "number") return;
    counts.set(frame.id, (counts.get(frame.id) ?? 0) + 1);
    pending.get(frame.id)?.resolve(frame);
    pending.delete(frame.id);
  });
  // The last RPC reply can still be in the stdout pipe when the process exits.
  child.once("close", (code, signal) => {
    if (!pending.size) return;
    const detail = errors.trim();
    const failure = new Error(
      `Backend closed (${signal ?? `exit code ${code}`}) before replying to RPC IDs ${[...pending.keys()].join(", ")}${detail ? `\n${detail}` : ""}`,
    );
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  });
  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Frame>((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { request, counts, child };
}

describe("built backend Skills isolation", () => {
  it("finds the workspace fixture without scanning its synthetic parent skills", async () => {
    const parent = await home();
    await fs.mkdir(path.join(parent, ".git"));
    const sentinel = path.join(parent, ".opencode/skills/ancestor-sentinel");
    await fs.mkdir(sentinel, { recursive: true });
    await fs.writeFile(
      path.join(sentinel, "SKILL.md"),
      "---\nname: ancestor-sentinel\ndescription: Synthetic parent fixture\n---\nFixture text.\n",
    );
    const directory = path.join(parent, "workspace");
    await local(directory);
    const dataDir = path.join(directory, "data");
    const store = new BackendStore(path.join(dataDir, "agentkib.db"));
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
      "fixture",
      directory,
      "Fixture",
      "fixture",
      "healthy",
      "2026-10-07T00:00:00.000Z",
    );
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
    const rpc = await backend(directory, "");
    expect((await rpc.request("backend.initialize", { dataDir })).error).toBeUndefined();
    const inventory = await rpc.request("skills.inventory");
    expect(inventory.error).toBeUndefined();
    const observations = (inventory.result as { observations: Array<{ name: string }> })
      .observations;
    expect([...new Set(observations.map((item) => item.name))]).toEqual(["reviewer"]);
    // Force the shutdown reply to be read when Node drains stdout after the exit event.
    rpc.child.stdout.pause();
    expect((await rpc.request("agentkib.shutdown")).error).toBeUndefined();
  }, 15_000);

  it.each(["network", "synchronous-hash"])(
    "answers workspace/session/runtime requests within one second during %s work",
    async (mode) => {
      const directory = await home();
      await local(directory);
      const dataDir = path.join(directory, "data");
      const store = new BackendStore(path.join(dataDir, "agentkib.db"));
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
        "fixture",
        directory,
        "Fixture",
        "fixture",
        "healthy",
        "2026-10-07T00:00:00.000Z",
      );
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
      const patch =
        mode === "network"
          ? stalledNetwork
          : `
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');const {workerData}=require('node:worker_threads');let held=false;const createHash=crypto.createHash;
crypto.createHash=function(...args){if(!held){held=true;fs.writeFileSync(path.join(workerData.environment.HOME,'network-entered'),'hash');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1800);}return createHash.apply(this,args)};
`;
      const rpc = await backend(directory, patch);
      expect((await rpc.request("backend.initialize", { dataDir })).error).toBeUndefined();
      const slow = rpc.request(
        mode === "network" ? "skills.discover" : "skills.inventory",
        mode === "network" ? { url: "https://github.com/example/skills" } : {},
      );
      await observed(path.join(directory, "network-entered"));
      const start = performance.now();
      const frames = await Promise.all([
        rpc.request("runtime.info"),
        rpc.request("workspaces.list"),
        rpc.request("workspace.sessions", { workspaceId: "fixture" }),
      ]);
      expect(performance.now() - start).toBeLessThan(1000);
      for (const frame of frames) expect(frame.error).toBeUndefined();
      const shutdown = rpc.request("agentkib.shutdown");
      expect((await rpc.request("runtime.info")).error).toMatchObject({
        code: -32000,
        data: { detail: "Backend is closing" },
      });
      await slow;
      expect((await shutdown).error).toBeUndefined();
      for (const count of rpc.counts.values()) expect(count).toBe(1);
    },
    15_000,
  );
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}
describe("Skills checks its deadline immediately before mutation", () => {
  it.each(["deadline", "shutdown"])(
    "does not install when %s interrupts read-only preflight",
    async (reason) => {
      const directory = await home();
      await local(directory);
      const skills = new Skills(environment(directory), path.join(directory, "data"));
      const inventory = (await skills.request("skills.inventory", {})) as {
        observations: Array<{ id: string }>;
      };
      const preview = (await skills.request("skills.prepareImport", {
        observation_id: inventory.observations[0]!.id,
      })) as { token: string; library_id: string };
      const entered = deferred(),
        release = deferred();
      const lstat = fs.lstat.bind(fs);
      let paused = false;
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        if (!paused) {
          paused = true;
          entered.resolve();
          await release.promise;
        }
        return lstat(...args);
      });
      vi.useFakeTimers();
      const task = new TaskContext({ id: "preflight", deadlineAt: Date.now() + 100 });
      const operation = runWithTask(task, () =>
        skills.request("skills.applyOperation", { token: preview.token, confirmed: true }),
      );
      const rejected = expect(operation).rejects.toMatchObject({
        reason: reason === "deadline" ? "deadline-exceeded" : "backend-closing",
      });
      await entered.promise;
      if (reason === "deadline") await vi.advanceTimersByTimeAsync(101);
      else task.cancel(new BackendTaskError("backend-closing"));
      expect(task.signal.aborted).toBe(true);
      release.resolve();
      await rejected;
      task.dispose();
      await expect(
        fs.access(path.join(directory, "library/skills", preview.library_id)),
      ).rejects.toThrow();
      await expect(fs.access(path.join(directory, "library/skills.lock.json"))).rejects.toThrow();
    },
  );

  it("finishes the active batch item but does not start a later item after the deadline", async () => {
    const directory = await home();
    await local(directory);
    const other = path.join(directory, ".claude/skills/second");
    await fs.mkdir(other, { recursive: true });
    await fs.writeFile(
      path.join(other, "SKILL.md"),
      "---\nname: second\ndescription: second fixture\n---\nSecond item.\n",
    );
    const skills = new Skills(environment(directory), path.join(directory, "data"));
    const inventory = (await skills.request("skills.inventory", {})) as {
      observations: Array<{ id: string }>;
    };
    const preview = (await skills.request("skills.prepareImports", {
      observation_ids: inventory.observations.map((item) => item.id),
    })) as { token: string };
    const entered = deferred(),
      release = deferred();
    const rename = fs.rename.bind(fs);
    let paused = false;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (!paused && String(to).startsWith(path.join(directory, "library/skills") + path.sep)) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
      return rename(from, to);
    });
    vi.useFakeTimers();
    const task = new TaskContext({ id: "batch", deadlineAt: Date.now() + 100 });
    const pending = runWithTask(task, () =>
      skills.request("skills.applyImports", { token: preview.token, confirmed: true }),
    );
    await entered.promise;
    await vi.advanceTimersByTimeAsync(101);
    release.resolve();
    const result = (await pending) as {
      items: Array<{ status: string; error?: string; library_id?: string }>;
    };
    task.dispose();
    expect(result.items.map((item) => item.status)).toEqual(["imported", "failed"]);
    expect(result.items[1]!.error).toBe("deadline-exceeded");
    expect(await fs.readdir(path.join(directory, "library/skills"))).toEqual([
      result.items[0]!.library_id,
    ]);
    expect(task.committed).toBe(true);
  });
});
