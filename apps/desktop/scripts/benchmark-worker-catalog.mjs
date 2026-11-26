import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { cpus, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const desktop = path.resolve(import.meta.dirname, "..");
const contract = JSON.parse(
  await readFile(
    path.join(desktop, "../../packages/runtime-protocol/remote-contract.json"),
    "utf8",
  ),
);
const protocolVersion = contract.versions.runtime.major;
const workerCount = 5;
const workerPeriodMs = 4_000;
const leadHistoryBytes = 800 * 1024 * 1024;
const deviceId = "worker-catalog-benchmark";
const concurrency = { workspaces: 24, rowsPerWorkspace: 25 };
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.info(
    "Usage: node apps/desktop/scripts/benchmark-worker-catalog.mjs " +
      "[--baseline /path/to/baseline/backend.cjs] [--backend /path/to/candidate/backend.cjs] " +
      "[--client legacy|push] [--seconds 60] [--workspaces 24] [--rows-per-workspace 25]",
  );
  process.exit(0);
}

const options = {};
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  assert.ok(
    [
      "--baseline",
      "--backend",
      "--client",
      "--seconds",
      "--workspaces",
      "--rows-per-workspace",
    ].includes(flag) && args[index + 1],
    `Unknown or incomplete option ${flag}`,
  );
  options[flag.slice(2)] = args[index + 1];
}
function integer(option, defaultValue, min, max) {
  const value = Number(options[option] ?? defaultValue);
  assert.ok(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid --${option}`);
  return value;
}
const durationMs = integer("seconds", 60, 1, 300) * 1_000;
const workspaceCount = integer("workspaces", concurrency.workspaces, 1, 48);
const rowsPerWorkspace = integer("rows-per-workspace", concurrency.rowsPerWorkspace, 1, 100);
const candidate = path.resolve(options.backend ?? path.join(desktop, "dist-electron/backend.cjs"));
const candidateClient = options.client ?? "push";
assert.ok(["push", "legacy"].includes(candidateClient), "Invalid --client");
const artifacts = [
  ...(options.baseline
    ? [{ label: "baseline", filename: path.resolve(options.baseline), client: "legacy" }]
    : []),
  { label: "candidate", filename: candidate, client: candidateClient },
];

function jsonLine(value) {
  return JSON.stringify(value) + "\n";
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function fixture(directory) {
  const home = path.join(directory, "home");
  const data = path.join(directory, "data");
  const codex = path.join(home, "codex");
  const claude = path.join(home, "claude");
  const bin = path.join(directory, "bin");
  const rollouts = path.join(codex, "sessions");
  const claudeProject = path.join(claude, "projects", "benchmark");
  const workspaces = Array.from({ length: workspaceCount }, (_, index) =>
    path.join(directory, `workspace-${index}`),
  );
  await Promise.all(
    [data, rollouts, claudeProject, bin, ...workspaces].map((folder) =>
      mkdir(folder, { recursive: true }),
    ),
  );
  await writeFile(
    path.join(data, "preferences.json"),
    JSON.stringify({
      mcp_network: { port: await freePort(), lan_enabled: false, lan_risk_accepted: false },
    }),
  );

  const nativeDatabase = path.join(codex, "state_5.sqlite");
  const database = new DatabaseSync(nativeDatabase);
  const since = Date.now() - 120_000;
  try {
    database.exec(
      "PRAGMA journal_mode = WAL; " +
        "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT NOT NULL, " +
        "title TEXT, source TEXT, thread_source TEXT, updated_at_ms INTEGER, preview TEXT, archived INTEGER);",
    );
    const insert = database.prepare(
      "INSERT INTO threads VALUES (?, ?, ?, ?, 'cli', 'user', ?, '', 0)",
    );
    for (const [index, cwd] of workspaces.entries()) {
      for (let row = 0; row < rowsPerWorkspace; row++) {
        const id = randomUUID();
        const rollout = path.join(rollouts, `rollout-${id}.jsonl`);
        await writeFile(
          rollout,
          jsonLine({
            type: "session_meta",
            payload: { id, cwd, source: "cli", thread_source: "user" },
          }),
        );
        insert.run(id, rollout, cwd, `Quiet session ${index}-${row}`, since + row);
      }
    }
  } finally {
    database.close();
  }

  const sessionId = randomUUID();
  const lead = path.join(claudeProject, `${sessionId}.jsonl`);
  const cwd = workspaces[0];
  const records = Array.from({ length: 48 }, (_, index) => {
    const role = index % 2 ? "assistant" : "user";
    return jsonLine({
      type: role,
      sessionId,
      cwd,
      timestamp: new Date(since + index * 100).toISOString(),
      uuid: randomUUID(),
      message: { role, content: [{ type: "text", text: `Lead turn ${index} ${"x".repeat(256)}` }] },
    });
  });
  // A sparse transcript exercises the real first-page budget without creating 800 MiB of I/O.
  await writeFile(lead, records[0]);
  const tail = Buffer.from("\n" + records.slice(1).join(""));
  const handle = await open(lead, "r+");
  try {
    await handle.write(tail, 0, tail.length, leadHistoryBytes - tail.length);
  } finally {
    await handle.close();
  }
  await writeFile(
    path.join(claudeProject, "sessions-index.json"),
    jsonLine({
      version: 1,
      entries: [
        {
          sessionId,
          fullPath: lead,
          projectPath: cwd,
          summary: "Synthetic Claude lead",
          created: since,
          modified: since + records.length * 100,
          messageCount: records.length,
        },
      ],
    }),
  );

  const mock = await readFile(path.join(desktop, "scripts/fixtures/codex_mock.py"), "utf8");
  const anchors = [
    "def save():",
    " if native:(home/(native+'.json')).write_text(json.dumps(history))",
    "  time.sleep(0.08)",
  ];
  for (const anchor of anchors)
    assert.ok(mock.includes(anchor), `Missing Codex fixture hook: ${anchor}`);
  const executable = path.join(bin, "codex");
  await writeFile(
    executable,
    mock
      .replace(
        "home=pathlib.Path(os.environ['CODEX_HOME']);",
        `sys.stderr=open(${JSON.stringify(path.join(directory, "mock-errors.log"))},'a',buffering=1)
home=pathlib.Path(os.environ['CODEX_HOME']);`,
      )
      .replace(anchors[0], nativeWriter + "\n" + anchors[0])
      .replace(anchors[1], anchors[1] + "\n if native:save_native_turn()")
      .replaceAll(
        "'networkAccess':False",
        "'networkAccess':False,'excludeTmpdirEnvVar':True,'excludeSlashTmp':True",
      )
      .replace(anchors[2], "  append_native('agent_message', {'message':delta})\n" + anchors[2]),
  );
  await chmod(executable, 0o700);
  const telemetry = path.join(directory, "telemetry.cjs");
  await writeFile(telemetry, telemetrySource);
  return { data, home, bin, codex, claude, workspaces, nativeDatabase, telemetry };
}

class Backend {
  #child;
  #id = 0;
  #pending = new Map();
  #pendingSamples = new Map();
  #stderr = "";
  #failure;
  samples = [];
  counts;
  onEvent = () => {};
  constructor(filename, profile, directory) {
    this.#child = spawn(
      process.execPath,
      ["--expose-gc", "--require", profile.telemetry, filename],
      {
        env: {
          HOME: profile.home,
          USERPROFILE: profile.home,
          XDG_CONFIG_HOME: profile.home,
          XDG_DATA_HOME: profile.home,
          XDG_CACHE_HOME: profile.home,
          TMPDIR: directory,
          PATH: profile.bin,
          CODEX_HOME: profile.codex,
          CLAUDE_CONFIG_DIR: profile.claude,
          AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
          AGENTKIB_BENCHMARK_DATA_DIR: profile.data,
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      },
    );
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-3000);
    });
    this.#child.stdin.on("error", () => {});
    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#receive(line));
    this.#child.on("message", (message) => {
      if (message.id) this.#pendingSamples.get(message.id)?.resolve(message.sample);
      else if (message.sample) this.samples.push(message.sample);
    });
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) =>
      this.#fail(new Error(`Backend exited (${code ?? signal}): ${this.#stderr}`)),
    );
  }
  #fail(error) {
    this.#failure ??= error;
    for (const { reject } of [...this.#pending.values(), ...this.#pendingSamples.values()])
      reject(error);
  }
  #receive(line) {
    try {
      const result = JSON.parse(line);
      if (result.method === "sessions.event") {
        this.onEvent(result.params, Buffer.byteLength(line));
        return;
      }
      const entry = this.#pending.get(result.id);
      if (!entry) return;
      if (entry.counter) entry.counter.responseBytes += Buffer.byteLength(line);
      if (result.error) {
        const detail = result.error.data?.detail ?? result.error.message;
        entry.reject(new Error(`${entry.key}: ${JSON.stringify(detail)}`));
      } else entry.resolve(result.result);
    } catch (error) {
      this.#fail(error);
    }
  }
  #send(pending, key, send, timeoutMs, counter) {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const settled = (settle, value) => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        settle(value);
      };
      const timer = setTimeout(() => settled(reject, new Error(`Timed out: ${key}`)), timeoutMs);
      pending.set(id, {
        key,
        counter,
        resolve: (value) => settled(resolve, value),
        reject: (error) => settled(reject, error),
      });
      send(id);
    });
  }
  request(method, params = {}, timeoutMs = 15_000) {
    const operation = params.host?.request?.operation;
    const key = operation ? `${method}:${operation}` : method;
    const counter = this.counts && (this.counts[key] ??= { calls: 0, responseBytes: 0 });
    if (counter) counter.calls++;
    return this.#send(
      this.#pending,
      key,
      (id) => this.#child.stdin.write(jsonLine({ jsonrpc: "2.0", id, method, params })),
      timeoutMs,
      counter,
    );
  }
  checkpoint(forceGc = false) {
    return this.#send(
      this.#pendingSamples,
      "memory checkpoint",
      (id) => this.#child.send({ id, forceGc }),
      10_000,
    );
  }
  async stop() {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    const exited = once(this.#child, "exit").catch(() => undefined);
    await this.request("agentkib.shutdown", {}, 2_500).catch(() => undefined);
    await Promise.race([exited, delay(2_000)]);
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await Promise.race([exited, delay(2_000)]);
    }
  }
}

const nativeWriter = `import datetime,sqlite3
last_native_turn=None
def native_rollout():
 return home/'sessions'/('rollout-'+native+'.jsonl')
def append_native(kind,fields):
 stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with native_rollout().open('a') as out:
  out.write(json.dumps({'timestamp':stamp,'type':'event_msg','payload':{'type':kind,'turn_id':history[-1]['id'],**fields}})+'\\n')
 with sqlite3.connect(str(home/'state_5.sqlite'),timeout=5) as db:
  db.execute('UPDATE threads SET updated_at_ms=? WHERE id=?',(int(time.time()*1000),native))
def save_native_turn():
 global last_native_turn
 rollout=native_rollout()
 if not rollout.exists():
  with rollout.open('w') as out:
   out.write(json.dumps({'type':'session_meta','payload':{'id':native,'cwd':os.getcwd(),'source':'exec','thread_source':'user'}})+'\\n')
  with sqlite3.connect(str(home/'state_5.sqlite'),timeout=5) as db:
   db.execute("INSERT INTO threads VALUES (?,?,?,'Synthetic Worker','exec','user',?,'',0)",(native,str(rollout),os.getcwd(),int(time.time()*1000)))
 if history:
  latest=history[-1]
  marker=(latest['id'],latest['status'])
  if marker!=last_native_turn:
   last_native_turn=marker
   append_native('task_started' if marker[1]=='inProgress' else 'task_complete',{})
`;

const telemetrySource = `
if (typeof process.send !== "function") return;
const histogram = require("node:perf_hooks").monitorEventLoopDelay({ resolution: 20 });
histogram.enable();
function sample() {
  return {
    at: performance.now(),
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
    eventLoopP95Ms: histogram.percentile(95) / 1e6,
  };
}
setInterval(() => process.send({ sample: sample() }), 1000).unref();
process.on("message", ({ id, forceGc }) => {
  if (forceGc) {
    global.gc();
    global.gc();
  }
  process.send({ id, sample: sample() });
});
`;

async function run({ label, filename, client }, directory) {
  await stat(filename);
  const profile = await fixture(directory);
  await writeFile(
    path.join(profile.codex, "allow-stream-benchmark"),
    "isolated synthetic fixture\n",
  );
  const backend = new Backend(filename, profile, directory);
  const host = (operation, fields = {}, target) =>
    backend.request("session.request", {
      host: { ...(target ? { target } : {}), request: { operation, ...fields } },
    });
  const listener = {
    invalidations: 0,
    patchedRows: 0,
    leadEvents: 0,
    bytes: 0,
    failedReads: [],
  };
  const workerRuns = Array(workerCount).fill(0);
  let measuring = false;
  const observers = [
    { name: "sidebar", delayMs: 40 },
    ...(client === "legacy" ? [{ name: "embedded", delayMs: 0 }] : []),
    { name: "tray", delayMs: 750 },
  ].map((observer) => ({ ...observer, fullReads: 0, lastReadAt: -Infinity }));
  const fullCatalog = async (observer) => {
    if (observer?.name === "tray") await backend.request("runtime.info");
    const catalog = await host("catalog");
    // The local bridge filters every full-access catalog against current registration.
    await backend.request("workspaces.list");
    return catalog;
  };
  const refreshAfterInvalidate = (observer) => {
    if (!measuring || observer.flight) return;
    if (observer.timer) {
      if (client !== "legacy" || observer.name !== "tray") return;
      // The original tray restarts the settle window on each event.
      clearTimeout(observer.timer);
    }
    const waitMs =
      client === "legacy"
        ? observer.delayMs
        : Math.max(observer.delayMs, observer.lastReadAt + 3_000 - performance.now());
    observer.timer = setTimeout(() => {
      observer.timer = undefined;
      observer.dirty = false;
      observer.fullReads++;
      observer.lastReadAt = performance.now();
      observer.flight = fullCatalog(observer)
        .catch((error) => listener.failedReads.push(error.message))
        .finally(() => {
          observer.flight = undefined;
          if (observer.dirty) refreshAfterInvalidate(observer);
        });
    }, waitMs);
  };
  try {
    await backend.request("agentkib.handshake", {
      protocolVersion,
      client: { name: deviceId, version: "1" },
    });
    await backend.request("backend.initialize", { dataDir: profile.data });
    const context = await backend.request("backend.nativeContext");
    const ids = [];
    for (const cwd of profile.workspaces) {
      const plan = await backend.request("backend.planWorkspace", {
        operation: "add",
        path: cwd,
        context,
      });
      const [inspection] = await backend.request("backend.inspectWorkspaces", {
        workspaces: [{ id: plan.id, path: plan.path }],
      });
      const workspace = await backend.request("workspace.add", {
        path: cwd,
        _plan: plan,
        _inspection: inspection.inspection,
      });
      ids.push(workspace.id);
    }
    for (const workspaceId of ids)
      await backend.request("workspace.refreshSessions", { workspaceId, force: true }, 60_000);
    const sessions = await backend.request("workspace.sessions", { workspaceId: ids[0] });
    const lead = sessions.find(
      (session) => session.agent === "claude-code" && session.title === "Synthetic Claude lead",
    );
    assert.ok(lead, "Synthetic Claude lead did not enter the index");

    const workers = [];
    for (let index = 0; index < workerCount; index++) {
      const created = await host(
        "create",
        {
          workspaceId: ids[index % ids.length],
          deviceId,
          requestId: randomUUID(),
          policyId: "workspace-write-on-request",
          model: "mock-model",
          effort: "medium",
        },
        "codex",
      );
      if (!created.accepted) {
        const error = await readFile(path.join(directory, "mock-errors.log"), "utf8").catch(
          () => "",
        );
        throw new Error(
          `Synthetic Codex Worker did not start: ${created.reason ?? "unknown"}\n${error.slice(-2000)}`,
        );
      }
      workers.push(created.sessionId);
    }
    const catalog = await fullCatalog();
    assert.ok(catalog.sessions?.length >= workerCount + 1, "Missing synthetic catalog rows");
    const sidebar = await backend.request("sessions.subscribe", { sessionId: "" });
    const detail = await backend.request("sessions.subscribe", { sessionId: lead.id });
    assert.ok(
      detail.events.some((event) => event.type === "snapshot" && event.payload?.items?.length),
      "Claude detail subscription did not load its synthetic history",
    );
    backend.onEvent = (event, bytes) => {
      if (!measuring) return;
      if (event.subscriptionId === detail.subscriptionId) listener.leadEvents++;
      if (event.subscriptionId !== sidebar.subscriptionId || event.type !== "invalidate") return;
      listener.bytes += bytes;
      const updates = event.payload?.catalogPatch?.updates;
      if (Array.isArray(updates)) {
        listener.patchedRows += updates.length;
      } else if (event.payload?.domains?.includes("catalog")) {
        listener.invalidations++;
        for (const observer of observers) {
          observer.dirty = true;
          refreshAfterInvalidate(observer);
        }
      }
    };

    await delay(1_000);
    const before = await backend.checkpoint(true);
    const started = performance.now();
    const deadline = started + durationMs;
    backend.counts = {};
    measuring = true;
    try {
      await Promise.all(
        workers.map(async (sessionId, index) => {
          for (let tick = started + index * 175; tick < deadline; tick += workerPeriodMs) {
            await delay(Math.max(0, tick - performance.now()));
            if (performance.now() >= deadline) break;
            const live = await host("live", { sessionId, experimentalEnabled: true });
            if (!live.sendEnabled) continue;
            const sent = await host(
              "send",
              {
                sessionId,
                deviceId,
                requestId: randomUUID(),
                runtimeBootId: live.runtimeBootId,
                expectedRevision: live.revision,
                experimentalEnabled: true,
                text: "stream-benchmark",
              },
              "codex",
            );
            if (sent.accepted) workerRuns[index]++;
          }
        }),
      );
      await delay(Math.max(0, deadline - performance.now()));
    } finally {
      measuring = false;
      for (const observer of observers) clearTimeout(observer.timer);
    }
    await Promise.all(observers.map((observer) => observer.flight));
    const end = await backend.checkpoint();
    const counts = backend.counts;
    backend.counts = undefined;
    await backend.request("sessions.unsubscribe", { subscriptionId: sidebar.subscriptionId });
    await backend.request("sessions.unsubscribe", { subscriptionId: detail.subscriptionId });
    await delay(4_000);
    const after = await backend.checkpoint(true);
    const elapsedSeconds = (end.at - before.at) / 1_000;
    assert.ok(
      workerRuns.every((runs) => runs > 0),
      "Every synthetic Worker must write during the workload",
    );
    assert.deepEqual(listener.failedReads, []);
    const native = new DatabaseSync(profile.nativeDatabase, { readOnly: true });
    let writerRows;
    try {
      writerRows = native.prepare("SELECT rollout_path FROM threads WHERE source='exec'").all();
    } finally {
      native.close();
    }
    assert.equal(writerRows.length, workerCount);
    const rolloutBytes = await Promise.all(
      writerRows.map(async (row) => (await stat(row.rollout_path)).size),
    );
    const samples = [
      before,
      ...backend.samples.filter(({ at }) => at > before.at && at < end.at),
      end,
    ];
    const cpuMicros = end.cpu.user - before.cpu.user + end.cpu.system - before.cpu.system;
    return {
      label,
      client,
      elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
      workerRuns,
      rolloutBytes,
      initialCatalogRows: catalog.sessions.length,
      requests: counts,
      requestsPerMinute: Object.fromEntries(
        Object.entries(counts).map(([method, { calls }]) => [
          method,
          Number(((calls * 60) / elapsedSeconds).toFixed(1)),
        ]),
      ),
      listener,
      catalogReadsByObserver: Object.fromEntries(
        observers.map(({ name, fullReads }) => [name, fullReads]),
      ),
      backendCpuPercent: Number((cpuMicros / (elapsedSeconds * 10_000)).toFixed(2)),
      eventLoopP95Ms: Number(end.eventLoopP95Ms.toFixed(2)),
      rssMiB: {
        start: mib(before.memory.rss),
        peak: mib(Math.max(...samples.map(({ memory }) => memory.rss))),
        afterGc: mib(after.memory.rss),
      },
      heapUsedAfterGcMiB: { start: mib(before.memory.heapUsed), end: mib(after.memory.heapUsed) },
      externalAfterGcMiB: { start: mib(before.memory.external), end: mib(after.memory.external) },
      arrayBuffersAfterGcMiB: {
        start: mib(before.memory.arrayBuffers),
        end: mib(after.memory.arrayBuffers),
      },
    };
  } finally {
    await backend.stop();
  }
}

function mib(bytes) {
  return Number((bytes / 1_048_576).toFixed(1));
}

const root = await realpath(await mkdtemp(path.join(tmpdir(), "agentkib-worker-catalog-")));
try {
  const results = [];
  for (const artifact of artifacts)
    results.push(await run(artifact, path.join(root, artifact.label)));
  console.info(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpu: cpus()[0]?.model,
        scenario: {
          workerCount,
          workerPeriodMs,
          workspaceCount,
          rowsPerWorkspace,
          leadHistoryBytes,
        },
        scope:
          "Real backend over attached stdio with isolated SQLite and five mock Codex app-servers. " +
          "The driver models catalog observers (legacy sidebar, embedded conversation and tray; " +
          "push clients share the sidebar feed with the conversation) and opens a Claude detail subscription. " +
          "Backend CPU/RSS exclude the mock CLI and driver. No renderer, real Agent CLI or account.",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
