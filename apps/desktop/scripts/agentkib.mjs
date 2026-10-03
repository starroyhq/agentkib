#!/usr/bin/env node
import spawn from "cross-spawn";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";

class JsonRpcProcess {
  #child;
  #id = 0;
  #pending = new Map();

  constructor(entry, environment) {
    this.entry = entry;
    this.environment = environment;
  }

  async start() {
    this.#child = spawn(process.execPath, [this.entry], {
      cwd: desktopRoot,
      env: this.environment,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = readline.createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => {
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        this.#rejectAll(new Error("TypeScript backend returned invalid JSON-RPC output"));
        return;
      }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.error)
        pending.reject(
          new Error(
            response.error.data
              ? `${response.error.message}: ${JSON.stringify(response.error.data)}`
              : (response.error.message ?? "TypeScript backend request failed"),
          ),
        );
      else pending.resolve(response.result);
    });
    this.#child.once("error", (error) => this.#rejectAll(error));
    this.#child.once("exit", (code) => {
      if (code !== 0) this.#rejectAll(new Error(`TypeScript backend exited with ${code}`));
    });
  }

  request(method, params) {
    const id = ++this.#id;
    const result = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }

  async stop() {
    if (!this.#child || this.#child.exitCode !== null) return;
    try {
      await this.request("runtime.shutdown", {});
    } catch {
      this.#child.kill("SIGTERM");
    }
  }

  #rejectAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(desktopRoot, "../..");
const backendPath = path.join(desktopRoot, "dist-electron/backend.cjs");
const args = process.argv.slice(2);
const [command, projectArg, agentArg, cwdArg] = args;
const desktopVersion = JSON.parse(
  await readFile(path.join(desktopRoot, "package.json"), "utf8"),
).version;

const usage =
  "agentkib scan <project>\n" +
  "agentkib context <project> <codex|claude-code|cursor|opencode|openclaw|hermes|grok-build|antigravity|deepseek-harness> [cwd]\n" +
  "agentkib plan <project>\n" +
  "agentkib validate <project>\n" +
  "agentkib manifest <project>";

if (!command || command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}

if (!["scan", "context", "plan", "validate", "manifest"].includes(command)) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
if (!projectArg) throw new Error(`Missing project path\n\n${usage}`);

const project = path.resolve(projectArg);
const aliases = new Map([
  ["claude", "claude-code"],
  ["openclaw", "open-claw"],
  ["grok", "grok-build"],
  ["dsh", "deepseek-harness"],
]);
const agent = aliases.get(agentArg) ?? agentArg;
const supportedAgents = new Set([
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "deepseek-harness",
]);
if (command === "context" && !supportedAgents.has(agent))
  throw new Error(`Unknown Agent: ${agentArg ?? ""}`);
const protocolSource = await readFile(
  path.join(repositoryRoot, "packages/runtime-protocol/src/index.ts"),
  "utf8",
);
const protocolVersion = Number(
  protocolSource.match(/export const PROTOCOL_VERSION = (\d+) as const/)?.[1],
);
if (!Number.isInteger(protocolVersion)) throw new Error("Unable to read runtime protocol version");

await access(backendPath).catch(async () => {
  await run("pnpm", ["--filter", "@agentkib/desktop", "backend:build"]);
});

const dataDir = await mkdtemp(path.join(os.tmpdir(), "agentkib-cli-"));
const portServer = createServer();
await new Promise((resolve, reject) => {
  portServer.once("error", reject);
  portServer.listen(0, "127.0.0.1", resolve);
});
const mcpPort = portServer.address().port;
await new Promise((resolve, reject) =>
  portServer.close((error) => (error ? reject(error) : resolve())),
);
await writeFile(
  path.join(dataDir, "preferences.json"),
  JSON.stringify({ mcp_network: { port: mcpPort, lan_enabled: false, lan_risk_accepted: false } }),
);
const runtime = new JsonRpcProcess(backendPath, {
  ...process.env,
  AGENTKIB_APP_FLAVOR: "ai.agentkib.cli",
  AGENTKIB_DATA_DIR: dataDir,
});

try {
  await runtime.start();
  await runtime.request("agentkib.handshake", {
    protocolVersion,
    client: { name: "agentkib-cli", version: desktopVersion },
  });
  await runtime.request("backend.initialize", { dataDir });

  let result;
  switch (command) {
    case "scan":
      result = await runtime.request("workspace.scan", { project });
      break;
    case "context":
      if (!agentArg) throw new Error(`Missing agent argument\n\n${usage}`);
      result = await runtime.request("workspace.resolveContext", {
        project,
        cwd: cwdArg ?? project,
        agent,
      });
      break;
    case "plan": {
      const manifest = await runtime.request("workspace.prepareManifest", { project });
      result = await runtime.request("backend.planProjectAssets", { project, manifest });
      break;
    }
    case "manifest": {
      const manifest = await runtime.request("backend.defaultManifest", { project });
      process.stdout.write(stringify(manifest));
      break;
    }
    case "validate": {
      const scan = await runtime.request("workspace.scan", { project });
      result = { valid: scan.warnings.length === 0, warnings: scan.warnings };
      break;
    }
  }
  if (command !== "manifest") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await runtime.stop();
  await rm(dataDir, { recursive: true, force: true });
}

function run(executable, argumentsList) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, { cwd: repositoryRoot, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${executable} exited with ${code}`)),
    );
  });
}
