// Run against built artifacts with isolated data. No installed app preferences are changed.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(desktop, "../..");
const minutes = Number(process.argv[2] ?? 10);
if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Expected positive sample minutes");
const scratch = await mkdtemp(path.join(os.tmpdir(), "agentkib-energy-"));
const output = path.resolve(process.argv[3] ?? path.join(root, "output/energy-benchmark.json"));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function run(mode) {
  const profile = path.join(scratch, mode);
  const data = path.join(profile, "data");
  await mkdir(data, { recursive: true });
  await mkdir(path.join(profile, "codex"), { recursive: true });
  await writeFile(
    path.join(data, "preferences.json"),
    JSON.stringify({
      local_auto_refresh_enabled: true,
      quota_auto_refresh_enabled: false,
      close_behavior: "quit",
      mcp_network: { port: await freePort(), lan_enabled: false, lan_risk_accepted: false },
    }),
  );
  const resultPath = path.join(profile, "result.json");
  const wrapper = path.join(profile, "entry.cjs");
  await writeFile(
    wrapper,
    `
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const cp = require("node:child_process");
const startedAt = Date.now();
const samples = [];
const requests = [];
const children = new Set();
let sampleStart;
function save(finishedAt) {
  fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({mode:${JSON.stringify(mode)},startedAt,sampleStart,finishedAt,samples,requests}));
}
app.on("will-quit", () => save());
const originalSpawn = cp.spawn;
cp.spawn = function(executable, args, options) {
  const child = originalSpawn.call(this, executable, args, options);
  if (String(executable).includes("agentkib-runtime")) {
    children.add(child.pid);
    const write = child.stdin.write;
    let pending = "";
    child.stdin.write = function(chunk, ...rest) {
      pending += String(chunk);
      let end;
      while ((end = pending.indexOf("\\n")) !== -1) {
        try { const message = JSON.parse(pending.slice(0, end)); if (message.method) requests.push({ at: Date.now(), method: message.method }); } catch {}
        pending = pending.slice(end + 1);
      }
      return write.call(this, chunk, ...rest);
    };
  }
  return child;
};
app.setAppPath(${JSON.stringify(desktop)});
app.on("browser-window-created", (_event, window) => {
  if (${JSON.stringify(mode)} === "background") {
    window.show = () => {};
    window.showInactive = () => {};
    window.hide();
  }
});
const resourceScript = ${JSON.stringify(`import ctypes,json,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib')
class Timebase(ctypes.Structure):
 _fields_=[('numer',ctypes.c_uint32),('denom',ctypes.c_uint32)]
timebase=Timebase()
ctypes.CDLL('/usr/lib/libSystem.B.dylib').mach_timebase_info(ctypes.byref(timebase))
class Usage(ctypes.Structure):
 _fields_=[('uuid',ctypes.c_uint8*16)]+[(name,ctypes.c_uint64) for name in ['user','system','idle','interrupt','pageins','wired','resident','footprint','start','exit','child_user','child_system','child_idle','child_interrupt','child_pageins','child_elapsed','disk_read','disk_write']]
rows=[]
for pid in sys.argv[1:]:
 u=Usage()
 if lib.proc_pid_rusage(int(pid),2,ctypes.byref(u))==0: rows.append({'pid':int(pid),'cpuTicks':u.user+u.system,'cpuNs':(u.user+u.system)*timebase.numer//timebase.denom,'diskReadBytes':u.disk_read,'diskWriteBytes':u.disk_write})
print(json.dumps(rows))
`)};
async function sample() {
  const metrics = app.getAppMetrics();
  let resources = [];
  if (process.platform === "darwin") {
    const pids = [...new Set([...metrics.map(m => m.pid), ...children])];
    resources = await new Promise(resolve => cp.execFile("python3", ["-c", resourceScript, ...pids.map(String)], (error, stdout) => {
      if (error) return resolve([]);
      try { resolve(JSON.parse(stdout)); } catch { resolve([]); }
    }));
  }
  samples.push({ at: Date.now(), visible: BrowserWindow.getAllWindows().some(w => w.isVisible() && !w.isMinimized()),
    metrics: metrics.map(m => ({ pid:m.pid, type:m.type, cpu:m.cpu.percentCPUUsage })), resources });
  save();
}
require(${JSON.stringify(path.join(desktop, "dist-electron/main.cjs"))});
app.whenReady().then(() => {
  setTimeout(async () => {
    sampleStart = Date.now();
    await sample();
    const timer = setInterval(() => void sample(), 5000);
    setTimeout(async () => {
      clearInterval(timer);
      await sample();
      save(Date.now());
      app.exit(0);
    }, ${Math.round(minutes * 60_000)});
  }, 40_000);
});
`,
  );
  await new Promise((resolve, reject) => {
    const child = spawn(path.join(desktop, "node_modules/.bin/electron"), [wrapper], {
      cwd: desktop,
      env: {
        ...process.env,
        AGENTKIB_DEV: "1",
        AGENTKIB_BENCHMARK_EXIT_AFTER_READY: "0",
        VITE_DEV_SERVER_URL: "app://bundle/index.html",
        AGENTKIB_BENCHMARK_DATA_DIR: data,
        AGENTKIB_BENCHMARK_USER_DATA: path.join(profile, "electron"),
        AGENTKIB_RUNTIME_PATH: path.join(root, "target/debug/agentkib-runtime"),
        CODEX_HOME: path.join(profile, "codex"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errorText = "";
    child.stderr.on("data", (data) => {
      errorText = (errorText + data).slice(-3000);
    });
    const timer = setTimeout(
      () => {
        child.kill("SIGTERM");
        reject(new Error(`${mode}: benchmark timeout`));
      },
      minutes * 60_000 + 100_000,
    );
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      void writeFile(path.join(profile, "stderr.log"), errorText);
      if (code === 0) resolve();
      else reject(new Error(`${mode}: exit ${code}: ${errorText}`));
    });
  });
  return JSON.parse(await readFile(resultPath, "utf8"));
}

const results = await Promise.all([run("foreground"), run("background")]);
for (const result of results) {
  if (!result.requests.some((request) => request.method === "agentkib.handshake")) {
    throw new Error(`${result.mode}: runtime handshake was not observed`);
  }
  if (
    !result.finishedAt ||
    result.samples.length < 2 ||
    result.finishedAt - result.sampleStart < minutes * 60_000
  ) {
    throw new Error(`${result.mode}: sample duration was incomplete`);
  }
  if (result.samples.some((sample) => sample.visible !== (result.mode === "foreground"))) {
    throw new Error(`${result.mode}: window visibility did not match the requested scenario`);
  }
  if (
    result.mode === "background" &&
    result.requests.some(
      (request) =>
        request.at >= result.sampleStart &&
        ["discovery.refresh", "insights.refresh", "remote.request"].includes(request.method),
    )
  ) {
    throw new Error("background: unexpected local refresh or remote polling during idle sampling");
  }
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify({ schemaVersion: 1, minutes, scratch, results }, null, 2) + "\n",
);
process.stdout.write(output + "\n");
