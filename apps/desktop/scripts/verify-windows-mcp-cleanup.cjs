// Run from the repository root: pnpm verify:windows:mcp-cleanup [--force]
const { app, utilityProcess } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createServer } = require("node:net");
const protocolSource = fs.readFileSync(
  path.resolve(__dirname, "../../..", "packages/runtime-protocol/src/index.ts"),
  "utf8",
);
const protocolVersion = Number(
  protocolSource.match(/export const PROTOCOL_VERSION = (\d+) as const/)?.[1],
);
assert.ok(Number.isInteger(protocolVersion), "Unable to read runtime protocol version");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-cleanup-"));
const node = process.argv[2];
let backend;
const tracked = new Set();
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function gone(pids) {
  for (let i = 0; i < 50 && pids.some(alive); i++) await delay(100);
  assert.deepEqual(pids.filter(alive), [], "Processes remained alive");
}
app
  .whenReady()
  .then(async () => {
    assert.equal(process.platform, "win32");
    assert.ok(node, "Pass the node.exe path");
    const fixture = path.join(root, "fixture.cjs");
    fs.writeFileSync(
      fixture,
      `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [role, file] = process.argv.slice(2);
fs.appendFileSync(file, JSON.stringify({role, pid: process.pid, parent: process.ppid}) + '\\n');
if (role !== 'grandchild') spawn(process.execPath, [__filename, role === 'server' ? 'child' : 'grandchild', file], {stdio:'ignore', windowsHide:true});
setInterval(() => {}, 1000);
if (role === 'server') {
 require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  const result = m.method === 'initialize' ? {protocolVersion:m.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'cleanup-fixture', version:'1'}} : m.method === 'tools/list' ? {tools:[]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:m.id, result})+'\\n');
 });
}
`,
    );
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir);
    const listener = createServer();
    await new Promise((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    fs.writeFileSync(
      path.join(dataDir, "preferences.json"),
      JSON.stringify({ mcp_network: { port, lan_enabled: false, lan_risk_accepted: false } }),
    );
    backend = utilityProcess.fork(path.resolve(__dirname, "../dist-electron/backend.cjs"), [], {
      env: { ...process.env, HOME: root, USERPROFILE: root, AGENTKIB_DATA_DIR: dataDir },
      stdio: "pipe",
    });
    backend.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const pending = new Map();
    let id = 0;
    backend.on("message", (m) => {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => reject(new Error("RPC timeout: " + method)), 15000);
        pending.set(key, { resolve, reject, timer });
        backend.postMessage({ jsonrpc: "2.0", id: key, method, params });
      });
    await rpc("agentkib.handshake", {
      protocolVersion,
      client: { name: "cleanup-verification", version: "1" },
    });
    await rpc("backend.initialize", { dataDir });
    async function start(label) {
      const file = path.join(root, label + ".jsonl");
      await rpc("mcp.saveServer", {
        server: {
          id: label,
          name: label,
          transport: "stdio",
          command: node,
          args: [fixture, "server", file],
        },
      });
      await rpc("mcp.probeRuntime", { serverId: label });
      let rows = [];
      for (let i = 0; i < 50; i++) {
        rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
        rows.forEach((row) => tracked.add(row.pid));
        if (rows.length === 3) break;
        await delay(100);
      }
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => alive(row.pid)));
      console.log("LIVE " + label + " " + JSON.stringify(rows));
      return rows.map((row) => row.pid);
    }
    const stopped = await start("explicit-stop");
    await rpc("mcp.stopRuntime", { serverId: "explicit-stop" });
    await gone(stopped);
    console.log("PASS explicit MCP stop: all three processes exited");
    if (process.argv.includes("--force")) {
      const forced = await start("forced-backend-exit");
      const exited = new Promise((resolve) => backend.once("exit", resolve));
      backend.kill();
      await Promise.race([
        exited,
        delay(5000).then(() => {
          throw new Error("Backend did not exit");
        }),
      ]);
      await gone(forced);
      console.log("PASS forced backend exit: all three processes exited");
      return;
    }
    const shutdown = await start("runtime-shutdown");
    const exited = new Promise((resolve) => backend.once("exit", resolve));
    await rpc("agentkib.shutdown");
    await Promise.race([
      exited,
      delay(5000).then(() => {
        throw new Error("Backend did not exit");
      }),
    ]);
    await gone(shutdown);
    console.log("PASS agentkib.shutdown: all three processes exited");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    backend?.kill();
    for (const pid of tracked)
      if (alive(pid)) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
    await require("node:fs/promises").rm(root, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
    app.exit(process.exitCode || 0);
  });
