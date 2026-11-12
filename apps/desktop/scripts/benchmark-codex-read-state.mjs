/** macOS, offline: compare the committed observer with the working tree on one synthetic rollout.
 * node apps/desktop/scripts/benchmark-codex-read-state.mjs [baseline-ref] [codex-binary]
 * No model turn, personal configuration, credentials, or external server is used.
 */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { SharedRpcClient } from "./verify-codex-shared-server.mjs";

assert.equal(
  process.platform,
  "darwin",
  "This measurement requires macOS proc_pid_rusage and sandbox-exec; it must not silently skip.",
);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baselineRef = process.argv[2] ?? "HEAD";
const executable = process.argv[3] ?? "/opt/homebrew/bin/codex";
const root = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "agentkib-read-state-benchmark-")),
);
const home = path.join(root, "codex");
const workspace = path.join(root, "workspace");
await fs.mkdir(home);
await fs.mkdir(workspace);
const children = new Set();
const env = { PATH: process.env.PATH, HOME: root, CODEX_HOME: home };
const metricsCode = `import ctypes,json,struct,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
buf=ctypes.create_string_buffer(1024)
assert lib.proc_pid_rusage(int(sys.argv[1]),4,ctypes.byref(buf)) == 0
v=struct.unpack_from('35Q',buf,16)
class Timebase(ctypes.Structure):
 _fields_=[('numer',ctypes.c_uint),('denom',ctypes.c_uint)]
t=Timebase(); ctypes.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(ctypes.byref(t))
print(json.dumps({'cpuMs':(v[0]+v[1])*t.numer/t.denom/1e6,'diskReadBytes':v[16],'diskWriteBytes':v[17],'logicalWriteBytes':v[27]}))`;
const metrics = (pid) =>
  JSON.parse(execFileSync("python3", ["-c", metricsCode, String(pid)], { encoding: "utf8" }));

async function start(notification = () => {}, counts = {}) {
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-p",
      "(version 1)(allow default)(deny network*)",
      executable,
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      'cli_auth_credentials_store="file"',
      "app-server",
      "--stdio",
    ],
    { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  children.add(child);
  const exited = once(child, "close");
  const client = new SharedRpcClient(
    (frame) => child.stdin.write(frame + "\n"),
    () => child.kill("SIGTERM"),
    (direction, frame) => {
      if (direction === "out" && frame.method)
        counts[frame.method] = (counts[frame.method] ?? 0) + 1;
    },
  );
  createInterface({ input: child.stdout }).on("line", (line) => client.receive(Buffer.from(line)));
  child.stderr.resume();
  child.on("error", (error) => client.fail(error));
  child.on("close", () => {
    children.delete(child);
    client.fail();
    client.emit("close");
  });
  client.on("frame", (frame) => {
    if (typeof frame.method === "string") notification(frame);
  });
  await client.initialize("agentkib_isolated_read_state_benchmark");
  return {
    client,
    child,
    async close() {
      client.close();
      await exited;
    },
  };
}

let vite;
try {
  const bootstrap = await start();
  const thread = (
    await bootstrap.client.request("thread/start", {
      cwd: workspace,
      ephemeral: false,
      modelProvider: "openai",
    })
  ).thread;
  await bootstrap.close();
  assert.ok(
    thread.path.startsWith(home + path.sep),
    "Synthetic rollout must stay inside the isolated CODEX_HOME",
  );
  const stamp = new Date().toISOString();
  const line = (type, payload) => JSON.stringify({ timestamp: stamp, type, payload }) + "\n";
  await fs.mkdir(path.dirname(thread.path), { recursive: true });
  const file = await fs.open(thread.path, "w");
  await file.write(
    line("session_meta", {
      id: thread.id,
      timestamp: stamp,
      cwd: workspace,
      originator: "isolated_probe",
      cli_version: "0.167.0",
      source: "cli",
      model_provider: "openai",
    }),
  );
  for (let turn = 0; turn < 100; turn++) {
    await file.write(
      line("event_msg", {
        type: "task_started",
        turn_id: String(turn),
        model_context_window: 100000,
      }),
    );
    await file.write(
      line("event_msg", {
        type: "user_message",
        message: "synthetic request",
        images: [],
        local_images: [],
        text_elements: [],
      }),
    );
    for (let item = 0; item < 20; item++)
      await file.write(
        line("response_item", {
          type: "function_call_output",
          call_id: `${turn}-${item}`,
          output: "x".repeat(32768),
        }),
      );
    await file.write(
      line("event_msg", {
        type: "task_complete",
        turn_id: String(turn),
        last_agent_message: "synthetic done",
      }),
    );
  }
  await file.close();
  const dbFile = (await fs.readdir(home)).find((name) => /^state_\d+\.sqlite$/.test(name));
  assert.ok(dbFile, "Native Codex state database was not created");
  const db = new DatabaseSync(path.join(home, dbFile));
  db.prepare(
    "UPDATE threads SET has_user_event=1,source='cli',preview='synthetic test',title='synthetic test' WHERE id=?",
  ).run(thread.id);
  db.close();

  const source = "packages/backend/src/codex-read-state.ts";
  const previous = execFileSync("git", ["show", `${baselineRef}:${source}`], {
    cwd: repo,
    encoding: "utf8",
  });
  const baselinePath = path.join(root, "baseline-observer.ts");
  await fs.writeFile(
    baselinePath,
    previous.replace(
      /from "\.\/(.*?)"/g,
      (_, name) => `from ${JSON.stringify(path.join(repo, "packages/backend/src", name))}`,
    ),
  );
  vite = await createServer({
    root: path.join(repo, "apps/desktop"),
    configFile: false,
    cacheDir: path.join(root, "vite-cache"),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
    clearScreen: false,
  });
  const Baseline = (await vite.ssrLoadModule(baselinePath)).CodexReadStateObserver;
  const Candidate = (await vite.ssrLoadModule(path.join(repo, source))).CodexReadStateObserver;
  const target = { key: "synthetic-session", home, workspace, nativeId: thread.id, executable };
  const results = {};
  for (const [name, Observer] of [
    ["baseline", Baseline],
    ["candidate", Candidate],
  ]) {
    let server;
    const counts = {};
    let changes = 0;
    const observer = new Observer(
      env,
      () => changes++,
      async (_binary, _workspace, _home, _env, notification) => {
        server = await start(notification, counts);
        return server.client;
      },
    );
    const primed = await observer.refresh(target, "synthetic-owner");
    assert.equal(primed.source, "codex-native");
    assert.equal(primed.freshness, "current");
    assert.equal(primed.latestResult.turnId, "99");
    for (const key of Object.keys(counts)) delete counts[key];
    changes = 0;
    const before = metrics(server.child.pid),
      started = performance.now();
    console.log(`${name}: four unchanged foreground polls, five seconds apart`);
    for (let cycle = 0; cycle < 4; cycle++) {
      await delay(5000);
      await observer.pollPage(target);
      const state = await observer.refresh(target, "synthetic-owner");
      assert.equal(state.freshness, "current");
      assert.equal(state.status, primed.status);
      assert.deepEqual(state.latestResult, primed.latestResult);
    }
    const after = metrics(server.child.pid);
    results[name] = {
      wallMs: Math.round(performance.now() - started),
      cpuMs: after.cpuMs - before.cpuMs,
      diskReadBytes: after.diskReadBytes - before.diskReadBytes,
      diskWriteBytes: after.diskWriteBytes - before.diskWriteBytes,
      logicalWriteBytes: after.logicalWriteBytes - before.logicalWriteBytes,
      rpc: { ...counts },
      changeNotifications: changes,
    };
    if (name === "candidate") {
      assert.equal(counts["thread/read"] ?? 0, 0);
      assert.equal(counts["thread/turns/list"] ?? 0, 0);
      for (const operation of ["unread", "read"]) {
        await server.client.request("thread/readState/update", {
          threadId: thread.id,
          expectedRevision: observer.revision(target),
          operation: { type: operation },
        });
        await observer.pollPage(target);
        const state = await observer.refresh(target, "synthetic-owner");
        assert.equal(state.status, operation);
        assert.equal(state.freshness, "current");
      }
      await fs.appendFile(
        thread.path,
        line("event_msg", { type: "task_started", turn_id: "100", model_context_window: 100000 }) +
          line("event_msg", {
            type: "user_message",
            message: "new synthetic request",
            images: [],
            local_images: [],
            text_elements: [],
          }) +
          line("event_msg", {
            type: "task_complete",
            turn_id: "100",
            last_agent_message: "new synthetic done",
          }),
      );
      const state = await observer.refresh(target, "synthetic-owner");
      assert.equal(state.latestResult.turnId, "100");
      assert.equal(state.freshness, "current");
      results.authorityChecks = { manualUnread: true, nativeRead: true, appendedResult: true };
    }
    await observer.close();
    await server.close();
  }
  console.log(
    JSON.stringify(
      {
        codex: execFileSync(executable, ["--version"], { env, encoding: "utf8" }).trim(),
        baselineRef,
        rolloutBytes: (await fs.stat(thread.path)).size,
        note: "macOS process-attributed disk I/O excludes page-cache hits; zero disk reads do not mean zero rollout decoding. RPC counts identify repeat full-history work. logicalWriteBytes includes cache-backed writes; neither is SSD/NAND wear.",
        ...results,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(
    [...children].map(async (child) => {
      const exited = once(child, "close");
      child.kill("SIGTERM");
      await exited;
    }),
  );
  await vite?.close();
  await fs.rm(root, { recursive: true, force: true });
}
