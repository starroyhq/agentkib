import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDesktopDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(sourceDesktopDirectory, "../..");
const options = parseArguments(process.argv.slice(2));
const desktopDirectory = path.resolve(options.desktop ?? sourceDesktopDirectory);
const label = options.label ?? "typescript";
const typescriptBackendPath = path.resolve(
  desktopDirectory,
  options.backendEntry ?? path.join("dist-electron", "backend.cjs"),
);
const electronPath = path.resolve(
  desktopDirectory,
  options.electron ??
    path.join("node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron"),
);
const electronEntry = path.resolve(desktopDirectory, options.entry ?? "dist-electron/main.cjs");
const outputPath = path.resolve(
  repositoryRoot,
  options.output ?? path.join("qa", `runtime-benchmark-${label}.json`),
);
const runtimeProtocolSource = await readFile(
  path.join(repositoryRoot, "packages/runtime-protocol/src/index.ts"),
  "utf8",
);
const protocolVersion = Number(
  runtimeProtocolSource.match(/export const PROTOCOL_VERSION = (\d+) as const/)?.[1],
);
if (!Number.isInteger(protocolVersion)) throw new Error("Unable to read runtime protocol version");
const cleanRuns = integerOption(options["clean-runs"], 5);
const reuseRuns = integerOption(options["reuse-runs"], 10);
const workloadRuns =
  options["workload-runs"] === undefined ? undefined : integerOption(options["workload-runs"], 100);
const skillCount = integerOption(options["skill-count"], 0);
const transcriptLineCount = integerOption(options["transcript-lines"], 5_000);
const sessionCount = integerOption(options["session-count"], 1);
const sqliteWorkspaceCount = integerOption(options["workspace-count"], 100);
if (!transcriptLineCount || !sessionCount)
  throw new Error("Transcript and session counts must be positive");
const idleMs = integerOption(options["idle-ms"], 0);
if (workloadRuns === 0) throw new Error("--workload-runs must be positive");
if (idleMs > 0 && idleMs < 2_000) throw new Error("--idle-ms must be at least 2000");

let scratch;

async function main() {
  await Promise.all([
    assertExists(electronPath),
    assertExists(electronEntry),
    assertExists(typescriptBackendPath),
  ]);
  scratch = await mkdtemp(path.join(os.tmpdir(), "agentkib-typescript-benchmark-"));
  try {
    const startup = {
      clean: await runStartupGroup("clean", cleanRuns),
      reused: await runStartupGroup("reused", reuseRuns),
    };
    const workloads = await runRuntimeWorkloads();
    const result = {
      schemaVersion: 1,
      label,
      createdAt: new Date().toISOString(),
      machine: {
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        cpu: os.cpus()[0]?.model,
        logicalCpuCount: os.cpus().length,
        totalMemoryBytes: os.totalmem(),
      },
      build: {
        backend: "typescript",
        runtimeArtifact: path.basename(typescriptBackendPath),
        electronEntry: path.relative(desktopDirectory, electronEntry),
      },
      configuration: {
        cleanRuns,
        reuseRuns,
        workloadRuns,
        skillCount,
        idleMs,
        transcriptLineCount,
        sessionCount,
        sqliteWorkspaceCount,
      },
      startup,
      workloads,
    };
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${outputPath}\n`);
  } finally {
    if (process.env.AGENTKIB_BENCHMARK_KEEP_SCRATCH === "1") {
      process.stderr.write(`Benchmark scratch retained at ${scratch}\n`);
    } else {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}

async function runStartupGroup(profileKind, count) {
  if (count === 0) return [];
  const sharedProfile =
    profileKind === "reused"
      ? await createProfile(path.join(scratch, "startup-reused"))
      : undefined;
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const profile =
      sharedProfile ?? (await createProfile(path.join(scratch, `startup-clean-${index + 1}`)));
    const timelinePath = path.join(profile.root, `timeline-${index + 1}.json`);
    const stderrPath = path.join(profile.root, `electron-${index + 1}.stderr.log`);
    // Launch the package directory so Electron resolves app.getAppPath() to the
    // desktop root, matching packaged builds. Launching main.cjs directly makes
    // it resolve to dist-electron and breaks the app:// renderer path.
    const child = spawn(electronPath, [desktopDirectory], {
      cwd: desktopDirectory,
      env: {
        ...process.env,
        AGENTKIB_BENCHMARK_DATA_DIR: profile.data,
        AGENTKIB_BENCHMARK_USER_DATA: profile.electron,
        AGENTKIB_STARTUP_BENCHMARK_FILE: timelinePath,
        AGENTKIB_BENCHMARK_EXIT_AFTER_READY: "1",
        CODEX_HOME: profile.codex,
        CLAUDE_CONFIG_DIR: profile.claude,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.pipe(createWriteStream(stderrPath));
    await waitForExit(child, 60_000, `startup ${profileKind} run ${index + 1}`);
    const timeline = JSON.parse(await readFile(timelinePath, "utf8"));
    results.push({ run: index + 1, profileKind, ...timeline });
  }
  return results;
}

async function runRuntimeWorkloads() {
  const profile = await createProfile(path.join(scratch, "workloads"));
  const fixture = await createWorkloadFixture(profile);
  const runtimeEnvironment = {
    ...process.env,
    AGENTKIB_BENCHMARK_DATA_DIR: profile.data,
    AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
    AGENTKIB_LOCALE: "en-US",
    AGENTKIB_SYSTEM_THEME: "light",
    CODEX_HOME: profile.codex,
    CLAUDE_CONFIG_DIR: profile.claude,
  };
  const argumentsList = [typescriptBackendPath];
  if (idleMs > 0) {
    const telemetryPath = path.join(profile.root, "benchmark-telemetry.cjs");
    await writeFile(
      telemetryPath,
      `
let cpu = process.cpuUsage(), at = performance.now();
setInterval(() => {
  const delta = process.cpuUsage(cpu), now = performance.now();
  process.stderr.write("AGENTKIB_BENCHMARK_TELEMETRY:" + JSON.stringify({
    memory: process.memoryUsage(),
    cpuPercent: (delta.user + delta.system) / ((now - at) * 1000) * 100,
  }) + "\\n");
  cpu = process.cpuUsage(); at = now;
}, 1000).unref();
`,
    );
    argumentsList.unshift("--require", telemetryPath);
  }
  const client = new RuntimeClient(process.execPath, runtimeEnvironment, argumentsList);
  await client.start();
  try {
    await client.request("agentkib.handshake", {
      protocolVersion,
      client: { name: "agentkib-benchmark", version: "1" },
    });
    await client.request("backend.initialize", { dataDir: profile.data });
    await client.request("runtime.info", {});
    let idle;
    if (idleMs > 0) {
      // Discard the first interval, which includes module loading and initialization.
      await new Promise((resolve) => setTimeout(resolve, idleMs + 1_000));
      const samples = client.telemetry.slice(1);
      if (!samples.length) throw new Error("No backend idle telemetry was captured");
      idle = {
        sampleCount: samples.length,
        cpuPercentMean:
          samples.reduce((total, sample) => total + sample.cpuPercent, 0) / samples.length,
        samples,
      };
    }

    const added = await addWorkspace(client, fixture.workspace);
    for (const workspace of fixture.sqliteWorkspaces) {
      await addWorkspace(client, workspace);
    }

    const scanMs = await measureRequests(workloadRuns ?? 10, () =>
      client.request("workspace.scan", { project: fixture.workspace }),
    );
    const sessionIndexMs = await measureRequests(workloadRuns ?? 5, () =>
      client.request("workspace.refreshSessions", { workspaceId: added.id, force: true }),
    );
    const sessions = await client.request("workspace.sessions", { workspaceId: added.id });
    if (sessions.length !== sessionCount)
      throw new Error(`Expected ${sessionCount} sessions, got ${sessions.length}`);
    const sessionId = sessions.find(
      (session) => session.title === "Large deterministic session",
    )?.id;
    if (!sessionId) throw new Error("The deterministic session fixture was not indexed");
    const sessionParseMs = await measureRequests(workloadRuns ?? 10, () =>
      client.request("session.events", { sessionId, limit: 500 }),
    );
    const sqliteQueryMs = await measureRequests(workloadRuns ?? 25, () =>
      client.request("workspaces.list", {}),
    );
    const activityQueryMs = await measureRequests(workloadRuns ?? 25, () =>
      client.request("activity.list", { limit: 200 }),
    );
    const runtimeRssKb = await processTreeRssKb(client.pid);

    return {
      fixture: {
        workspaceFiles: fixture.workspaceFiles,
        transcriptLines: fixture.transcriptLines,
        sqliteWorkspaceCount: fixture.sqliteWorkspaces.length + 1,
        skillCount,
        sessionCount,
      },
      idle,
      runtimeRssKb,
      workspaceScan: summarize(scanMs),
      sessionIndex: summarize(sessionIndexMs),
      largeSessionParse: summarize(sessionParseMs),
      sqliteWorkspaceList: summarize(sqliteQueryMs),
      sqliteActivityList: summarize(activityQueryMs),
      rawMilliseconds: {
        workspaceScan: scanMs,
        sessionIndex: sessionIndexMs,
        largeSessionParse: sessionParseMs,
        sqliteWorkspaceList: sqliteQueryMs,
        sqliteActivityList: activityQueryMs,
      },
    };
  } finally {
    await client.stop();
  }
}

async function addWorkspace(client, workspacePath) {
  const context = await client.request("backend.nativeContext", {});
  const plan = await client.request("backend.planWorkspace", {
    operation: "add",
    path: workspacePath,
    context,
  });
  const inspections = await client.request("backend.inspectWorkspaces", {
    workspaces: [{ id: plan.id, path: plan.path }],
  });
  if (!plan || !inspections[0]?.inspection)
    throw new Error("TypeScript benchmark could not prepare workspace inspection");
  return client.request("workspace.add", {
    path: workspacePath,
    _plan: plan,
    _inspection: inspections[0].inspection,
  });
}

async function createProfile(root) {
  const data = path.join(root, "runtime-data");
  const electron = path.join(root, "electron-data");
  const codex = path.join(root, "codex-home");
  const claude = path.join(root, "claude-home");
  await Promise.all(
    [data, electron, codex, claude].map((directory) => mkdir(directory, { recursive: true })),
  );
  const preferencesPath = path.join(data, "preferences.json");
  try {
    await access(preferencesPath);
  } catch {
    await writeFile(
      preferencesPath,
      `${JSON.stringify({ mcp_network: { port: await freePort(), lan_enabled: false, lan_risk_accepted: false } }, null, 2)}\n`,
    );
  }
  return { root, data, electron, codex, claude };
}

async function createWorkloadFixture(profile) {
  const requestedWorkspace = path.join(profile.root, "fixture-workspace");
  await mkdir(requestedWorkspace, { recursive: true });
  const workspace = await realpath(requestedWorkspace);
  let workspaceFiles = 0;
  for (let directoryIndex = 0; directoryIndex < 40; directoryIndex += 1) {
    const directory = path.join(
      workspace,
      "src",
      `module-${String(directoryIndex).padStart(2, "0")}`,
    );
    await mkdir(directory, { recursive: true });
    for (let fileIndex = 0; fileIndex < 10; fileIndex += 1) {
      await writeFile(
        path.join(directory, `file-${String(fileIndex).padStart(2, "0")}.ts`),
        `export const value${fileIndex} = ${JSON.stringify("x".repeat(512))};\n`,
      );
      workspaceFiles += 1;
    }
  }
  await writeFile(path.join(workspace, "AGENTS.md"), "# Deterministic benchmark fixture\n");
  workspaceFiles += 1;

  const projectDirectory = path.join(profile.claude, "projects", "benchmark");
  await mkdir(projectDirectory, { recursive: true });
  const transcript = path.join(projectDirectory, "large-session.jsonl");
  const transcriptLines = transcriptLineCount;
  const lines = [];
  for (let index = 0; index < transcriptLines; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    lines.push(
      JSON.stringify({
        type: role,
        sessionId: "large-session",
        cwd: workspace,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        message: { role, content: `${role} benchmark message ${index} ${"y".repeat(256)}` },
      }),
    );
  }
  await writeFile(transcript, `${lines.join("\n")}\n`);
  const entries = [];
  for (let index = 1; index < sessionCount; index += 1) {
    const sessionId = `session-${String(index).padStart(5, "0")}`;
    const fullPath = path.join(projectDirectory, `${sessionId}.jsonl`);
    await writeFile(
      fullPath,
      `${JSON.stringify({ type: "user", sessionId, cwd: workspace, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `Fixture ${index}` } })}\n`,
    );
    entries.push({
      sessionId,
      fullPath,
      projectPath: workspace,
      summary: `Session ${index}`,
      created: 1_767_225_600_000,
      modified: 1_767_230_600_000,
      messageCount: 1,
    });
  }
  await writeFile(
    path.join(projectDirectory, "sessions-index.json"),
    `${JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId: "large-session",
          fullPath: transcript,
          projectPath: workspace,
          summary: "Large deterministic session",
          created: 1_767_225_600_000,
          modified: 1_767_230_600_000,
          messageCount: transcriptLines,
        },
        ...entries,
      ],
    })}\n`,
  );

  const sqliteWorkspaces = [];
  for (let index = 0; index < skillCount; index += 1) {
    const directory = path.join(workspace, ".agents", "skills", String(index).padStart(4, "0"));
    await mkdir(path.join(directory, "references"), { recursive: true });
    await writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: skill-${index}\ndescription: Benchmark skill\n---\n# Benchmark\n`,
    );
    for (let file = 0; file < 5; file += 1) {
      await writeFile(
        path.join(directory, "references", `${file}.md`),
        "Example benchmark content\n".repeat(20),
      );
      workspaceFiles += 1;
    }
    workspaceFiles += 1;
  }
  for (let index = 0; index < sqliteWorkspaceCount; index += 1) {
    const directory = path.join(
      profile.root,
      "sqlite-workspaces",
      `workspace-${String(index).padStart(3, "0")}`,
    );
    await mkdir(directory, { recursive: true });
    sqliteWorkspaces.push(directory);
  }
  return { workspace, workspaceFiles, transcriptLines, sqliteWorkspaces };
}

class RuntimeClient {
  constructor(executable, environment, argumentsList = []) {
    this.executable = executable;
    this.environment = environment;
    this.argumentsList = argumentsList;
    this.nextId = 1;
    this.pending = new Map();
    this.telemetry = [];
  }

  async start() {
    this.child = spawn(this.executable, this.argumentsList, {
      env: this.environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid;
    let stderr = "";
    this.child.stderr.on("data", (chunk) => {
      stderr += chunk;
      let end;
      while ((end = stderr.indexOf("\n")) >= 0) {
        const line = stderr.slice(0, end);
        stderr = stderr.slice(end + 1);
        const prefix = "AGENTKIB_BENCHMARK_TELEMETRY:";
        if (line.startsWith(prefix)) this.telemetry.push(JSON.parse(line.slice(prefix.length)));
      }
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      const response = JSON.parse(line);
      const pending = this.pending.get(response.id);
      if (!pending) return;
      this.pending.delete(response.id);
      if (response.error) {
        const detail = response.error.data?.detail;
        const reason = detail ? `${response.error.message}: ${detail}` : response.error.message;
        pending.reject(new Error(`${pending.method}: ${reason}`));
      } else pending.resolve(response.result);
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(
        `Runtime exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
      );
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    });
    await new Promise((resolve, reject) => {
      this.child.once("spawn", resolve);
      this.child.once("error", reject);
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    const gracefulShutdown = (async () => {
      try {
        await this.request("agentkib.shutdown", {});
      } catch {
        // The bounded process exit below handles an already-failed runtime.
      }
      await exited;
    })();
    await Promise.race([gracefulShutdown, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (this.child.exitCode === null) {
      this.child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  }
}

async function measureRequests(iterations, operation) {
  const values = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation();
    values.push(round(performance.now() - startedAt));
  }
  return values;
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    iterations: values.length,
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0],
    maxMs: sorted.at(-1),
  };
}

function percentile(sorted, percentileValue) {
  if (!sorted.length) return undefined;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

async function processTreeRssKb(rootPid) {
  if (!rootPid || process.platform === "win32") return undefined;
  const child = spawn("ps", ["-axo", "pid=,ppid=,rss="], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  await new Promise((resolve) => child.once("exit", resolve));
  const rows = output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3);
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of rows) {
      if (descendants.has(parentPid) && !descendants.has(pid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return rows.filter(([pid]) => descendants.has(pid)).reduce((total, [, , rss]) => total + rss, 0);
}

function waitForExit(child, timeoutMs, labelValue) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${labelValue} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `${labelValue} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}`,
          ),
        );
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) =>
        error || !port ? reject(error ?? new Error("No free port")) : resolve(port),
      );
    });
  });
}

function parseArguments(argumentsList) {
  const parsed = {};
  const allowed = new Set([
    "label",
    "desktop",
    "backendEntry",
    "electron",
    "entry",
    "output",
    "clean-runs",
    "reuse-runs",
    "workload-runs",
    "skill-count",
    "transcript-lines",
    "session-count",
    "workspace-count",
    "idle-ms",
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--") continue;
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (!allowed.has(key)) throw new Error(`Unsupported benchmark option: --${key}`);
    const value = argumentsList[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    parsed[key] = value;
    index += 1;
  }
  return parsed;
}

function integerOption(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`Invalid non-negative integer: ${value}`);
  return parsed;
}

async function assertExists(filePath) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Required benchmark artifact is missing: ${filePath}`);
  }
}

function round(value) {
  return Math.round(value * 100) / 100;
}

await main();
