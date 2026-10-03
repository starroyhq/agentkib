import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2).filter((value) => value !== "--");
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!["--label", "--output", "--backend"].includes(args[index]) || !args[index + 1])
    throw new Error(`Unsupported or incomplete option: ${args[index]}`);
  options[args[index].slice(2)] = args[index + 1];
}
const output = path.resolve(desktop, "../..", options.output ?? "qa/backend-memory.json");
const backend = path.resolve(desktop, options.backend ?? "dist-electron/backend.cjs");
const protocol = Number(
  (
    await readFile(path.join(desktop, "../../packages/runtime-protocol/src/index.ts"), "utf8")
  ).match(/export const PROTOCOL_VERSION = (\d+) as const/)?.[1],
);
if (!Number.isInteger(protocol)) throw new Error("Unable to read runtime protocol version");
const root = await mkdtemp(path.join(os.tmpdir(), "agentkib-memory-benchmark-"));
try {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  for (const directory of ["data", "codex", "claude", "workspace"])
    await mkdir(path.join(root, directory));
  await writeFile(path.join(root, "workspace/AGENTS.md"), "# Memory benchmark\n");
  await writeFile(
    path.join(root, "data/preferences.json"),
    JSON.stringify({
      mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  await writeFile(
    path.join(root, "worker.cjs"),
    `
require(${JSON.stringify(backend)});
setInterval(() => process.parentPort.postMessage({
  memoryBenchmark: true, memory: process.memoryUsage(),
}), 1000).unref();
`,
  );
  const configuration = { root, port, protocol, output, label: options.label ?? "typescript" };
  await writeFile(
    path.join(root, "main.cjs"),
    `(${electronProbe.toString()})(${JSON.stringify(configuration)});`,
  );
  const child = spawn(
    path.join(desktop, "node_modules/.bin/electron"),
    [path.join(root, "main.cjs")],
    {
      cwd: desktop,
      env: {
        ...process.env,
        CODEX_HOME: path.join(root, "codex"),
        CLAUDE_CONFIG_DIR: path.join(root, "claude"),
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Memory benchmark timed out"));
    }, 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Electron exited: ${code}`));
    });
  });
  const result = JSON.parse(await readFile(output, "utf8"));
  result.machine = { platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model };
  const artifact = backend.includes(".asar/") ? `${backend.split(".asar/")[0]}.asar` : backend;
  result.backendArtifactSha256 = createHash("sha256")
    .update(await readFile(artifact))
    .digest("hex");
  result.hashScope = artifact === backend ? "entry" : "archive";
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(output);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function electronProbe(configuration) {
  const { app, utilityProcess } = require("electron");
  const { mkdir, writeFile } = require("node:fs/promises");
  const path = require("node:path");
  app.setPath("userData", path.join(configuration.root, "electron"));
  let child;
  try {
    await app.whenReady();
    child = utilityProcess.fork(path.join(configuration.root, "worker.cjs"), [], {
      stdio: "pipe",
      serviceName: "AgentKib backend memory benchmark",
    });
    child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
    const samples = [],
      pending = new Map();
    let phase = "loaded",
      nextId = 1;
    child.on("message", (message) => {
      if (message.memoryBenchmark) {
        samples.push({ phase, ...message.memory });
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timeout);
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(JSON.stringify(message.error)))
        : request.resolve(message.result);
    });
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timed out: ${method}`));
        }, 20_000);
        pending.set(id, { resolve, reject, timeout });
        child.postMessage({ jsonrpc: "2.0", id, method, params });
      });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("exit", () => reject(new Error("Backend exited before spawn")));
    });
    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    await rpc("agentkib.handshake", {
      protocolVersion: configuration.protocol,
      client: { name: "memory-benchmark", version: "1" },
    });
    await delay(3_000);
    await rpc("backend.initialize", { dataDir: path.join(configuration.root, "data") });
    phase = "initialized-idle";
    await delay(8_000);
    const project = path.join(configuration.root, "workspace");
    const context = await rpc("backend.nativeContext");
    const plan = await rpc("backend.planWorkspace", { operation: "add", path: project, context });
    const inspections = await rpc("backend.inspectWorkspaces", {
      workspaces: [{ id: plan.id, path: plan.path }],
    });
    const workspace = await rpc("workspace.add", {
      path: project,
      _plan: plan,
      _inspection: inspections[0].inspection,
    });
    const url = `http://127.0.0.1:${configuration.port}/mcp/v1/workspaces/${encodeURIComponent(workspace.id)}/agents/codex`;
    let session;
    const mcp = async (body) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(session ? { "mcp-session-id": session, "mcp-protocol-version": "2025-03-26" } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(`MCP HTTP failure: ${response.status} ${await response.text()}`);
      session ??= response.headers.get("mcp-session-id");
      const text = await response.text();
      if (!text) return;
      const data = text.startsWith("{")
        ? text
        : text
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice(6);
      if (!data) throw new Error(`Unexpected MCP response: ${text}`);
      const result = JSON.parse(data);
      if (result.error) throw new Error(JSON.stringify(result.error));
      return result.result;
    };
    const started = performance.now();
    await mcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "memory-benchmark", version: "1" },
      },
    });
    await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
    const tools = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    if (!tools.tools.some((tool) => tool.name === "session_search"))
      throw new Error("Built-in MCP tools are missing");
    const firstMcpMs = performance.now() - started;
    phase = "after-mcp-idle";
    await delay(8_000);
    const webStarted = performance.now();
    const catalogs = await Promise.all([
      rpc("web.request", { operation: "catalog" }),
      rpc("web.request", { operation: "catalog" }),
    ]);
    if (
      !catalogs.every(
        (catalog) => Array.isArray(catalog.sessions) && Array.isArray(catalog.workspaces),
      ) ||
      JSON.stringify(catalogs[0]) !== JSON.stringify(catalogs[1])
    )
      throw new Error("Concurrent lazy web requests returned inconsistent catalogs");
    const firstWebMs = performance.now() - webStarted;
    phase = "after-web-and-mcp-idle";
    await delay(8_000);
    const phases = {};
    for (const name of ["loaded", "initialized-idle", "after-mcp-idle", "after-web-and-mcp-idle"]) {
      const values = samples.filter((sample) => sample.phase === name),
        rss = values.map((sample) => sample.rss).sort((a, b) => a - b);
      if (!rss.length) throw new Error(`Missing memory samples: ${name}`);
      phases[name] = { rssP50MiB: rss[Math.ceil(rss.length * 0.5) - 1] / 1048576, samples: values };
    }
    phase = "lifecycle-validation";
    const portServer = require("node:net").createServer();
    await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
    const replacementPort = portServer.address().port;
    await new Promise((resolve) => portServer.close(resolve));
    const replacementData = path.join(configuration.root, "replacement-data");
    await mkdir(replacementData, { recursive: true });
    await writeFile(
      path.join(replacementData, "preferences.json"),
      JSON.stringify({
        mcp_network: { port: replacementPort, lan_enabled: false, lan_risk_accepted: false },
      }),
    );
    await rpc("backend.initialize", { dataDir: replacementData });
    const replacementCatalog = await rpc("web.request", { operation: "catalog" });
    if (replacementCatalog.workspaces.length || replacementCatalog.sessions.length)
      throw new Error("Lazy web owner retained data from the previous initialization");
    await mkdir(path.dirname(configuration.output), { recursive: true });
    await writeFile(
      configuration.output,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        label: configuration.label,
        runtime: "electron-utility-process",
        electron: process.versions.electron,
        phases,
        firstMcpMs,
        firstWebMs,
        builtinToolCount: tools.tools.length,
        lifecycleValidation: "passed",
      }),
    );
    await rpc("agentkib.shutdown");
    app.exit(0);
  } catch (error) {
    console.error(error);
    child?.kill();
    app.exit(1);
  }
}
