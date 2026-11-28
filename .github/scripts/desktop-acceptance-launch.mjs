import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { createIsolatedWorkerEnvironment } from "../../apps/desktop/scripts/backend-worker-smoke-environment.cjs";

const exec = promisify(execFile);
const loopback = "127.0.0.1";
const portNames = ["mcp", "web", "cdp"];

function reservePort() {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, loopback, () => resolve(server));
  });
}

function releasePort(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function untilReady(cdpUrl, browserEndpoint, signal) {
  for (;;) {
    signal.throwIfAborted();
    const endpoint = browserEndpoint();
    if (endpoint) {
      try {
        const request = { signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]) };
        const version = await fetch(new URL("/json/version", cdpUrl), request).then((res) =>
          res.json(),
        );
        if (version.webSocketDebuggerUrl === endpoint) {
          const targets = await fetch(new URL("/json/list", cdpUrl), request).then((res) =>
            res.json(),
          );
          if (
            targets.some(
              (target) =>
                target.type === "page" && target.url.startsWith("app://bundle/index.html"),
            )
          ) {
            return;
          }
        }
      } catch {
        // The renderer and debugger start independently.
      }
    }
    await delay(125, undefined, { signal });
  }
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

export function hasLiveDesktopGroupMembers(processes, pid) {
  return processes.split("\n").some((line) => {
    const [group, state] = line.trim().split(/\s+/);
    return group === String(pid) && Boolean(state) && !state.startsWith("Z");
  });
}

async function desktopGroupIsRunning(pid) {
  // Darwin can return EPERM for kill(-pid, 0) while the group is shutting down.
  // A zombie has exited and can no longer use the fixture's data or sockets.
  const { stdout } = await exec("/bin/ps", ["-ax", "-o", "pgid=,state="], { timeout: 4_000 });
  return hasLiveDesktopGroupMembers(stdout, pid);
}

async function waitForGroupExit(pid) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await desktopGroupIsRunning(pid))) return true;
    await delay(100);
  }
  return !(await desktopGroupIsRunning(pid));
}

async function stopDesktop(child) {
  if (!child?.pid || !signalGroup(child.pid, "SIGTERM")) return;
  if (await waitForGroupExit(child.pid)) return;
  signalGroup(child.pid, "SIGKILL");
  if (!(await waitForGroupExit(child.pid))) {
    throw new Error("The isolated desktop process group is still running");
  }
}

// The broker binds outside the profile to stay within macOS's Unix socket limit.
export function acceptanceClaudeSocket(data) {
  const broker = path.join(data, "claude-bridge");
  const hash = createHash("sha256").update(broker).digest("hex").slice(0, 20);
  return path.join("/private/tmp", `akcb-${process.getuid()}-${hash}`, "b.sock");
}

async function removeClaudeSocket(data) {
  const socket = acceptanceClaudeSocket(data);
  const directory = path.dirname(socket);
  const owned = (info) => info.uid === process.getuid();
  const stat = await lstat(directory).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || !owned(stat))
    throw new Error("Unsafe Claude fixture socket directory");
  try {
    const entry = await lstat(socket);
    if (!entry.isSocket() || !owned(entry)) throw new Error("Unsafe Claude fixture socket");
    await rm(socket);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await rmdir(directory);
}

async function writeSandbox(scratch, bundle) {
  const homes = new Set(
    await Promise.all([homedir(), userInfo().homedir].map((home) => realpath(home))),
  );
  const quoted = (file) => JSON.stringify(file);
  const personalState = [
    ".claude",
    ".claude.json",
    ".codex",
    ".agentkib",
    ".agentkib-dev",
    ".dsh",
    ".deepseek-harness",
    "Library/Application Support/ai.agentkib",
    "Library/Application Support/ai.agentkib.dev",
    "Library/Application Support/AgentKib",
    "Library/Application Support/com.agentkib.desktop",
    "Library/Keychains",
  ];
  const clauses = [
    "(version 1)",
    "(allow default)",
    ...[...homes].flatMap((home) =>
      personalState.map(
        (entry) => `(deny file-read* file-write* (subpath ${quoted(path.join(home, entry))}))`,
      ),
    ),
    '(deny file-read* (subpath "/Applications/AgentKib.app"))',
    '(deny file-write* (subpath "/Applications"))',
    `(deny file-write* (subpath ${quoted(bundle)}))`,
    '(deny process-exec (literal "/usr/bin/security"))',
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))',
    '(allow process-exec (with no-sandbox) (literal "/bin/ps"))',
    '(deny network-outbound (remote ip "*:*"))',
    '(allow network-outbound (remote ip "localhost:*"))',
    "(allow network* (local unix-socket))",
    "(allow network* (remote unix-socket))",
  ];
  const sandbox = path.join(scratch, "acceptance.sb");
  await writeFile(sandbox, clauses.join("\n") + "\n", { mode: 0o600 });
  return sandbox;
}

/**
 * Launch a native packaged desktop with an isolated profile and an owned CDP
 * endpoint. Callbacks use the supplied paths and abort signal for fixture I/O.
 */
export async function withDesktopAcceptance({ executable, prepare, exercise, timeoutMs = 90_000 }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Packaged desktop acceptance requires native macOS arm64");
  }
  if (typeof executable !== "string" || typeof exercise !== "function") {
    throw new Error("Expected a packaged desktop executable and an exercise callback");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new Error("Desktop acceptance timeout must be between 1 and 300000 ms");
  }

  const target = await realpath(executable);
  const bundle = path.resolve(path.dirname(target), "../..");
  if (!bundle.endsWith(".app") || path.dirname(target) !== path.join(bundle, "Contents/MacOS")) {
    throw new Error("Expected an executable inside a macOS application bundle");
  }
  if (bundle.startsWith("/Applications/")) {
    throw new Error("Supply a separately unpacked AgentKib application");
  }
  const { stdout: architecture } = await exec("/usr/bin/lipo", ["-archs", target], {
    timeout: 4_000,
  });
  if (architecture.trim() !== "arm64") {
    throw new Error("Packaged desktop acceptance requires an arm64 application");
  }

  const scratch = await realpath(await mkdtemp("/private/tmp/agentkib-desktop-acceptance-"));
  const home = path.join(scratch, "home");
  const data = path.join(scratch, "data");
  const profile = path.join(scratch, "profile");
  const localWeb = path.join(profile, "web");
  const env = {
    ...createIsolatedWorkerEnvironment(home),
    CFFIXED_USER_HOME: home,
    AGENTKIB_DATA_DIR: data,
    AGENTKIB_BENCHMARK_DATA_DIR: data,
    AGENTKIB_BENCHMARK_USER_DATA: profile,
  };
  const controller = new AbortController();
  const { signal } = controller;
  const aborted = new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // The deadline can fire before a callback's promise is available to race.
  void aborted.catch(() => {});
  const interrupt = () => controller.abort(new Error("Packaged desktop acceptance interrupted"));
  const timer = setTimeout(
    () =>
      controller.abort(new Error(`Packaged desktop acceptance timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  const reservations = [];
  let child;
  let result;
  let failure;
  try {
    for (const name of portNames) {
      signal.throwIfAborted();
      reservations.push([name, await reservePort()]);
    }
    const ports = Object.fromEntries(
      reservations.map(([name, server]) => [name, server.address().port]),
    );
    await Promise.all(
      [home, data, profile, localWeb, env.TMPDIR, env.CLAUDE_CONFIG_DIR, env.CODEX_HOME].map(
        (folder) => mkdir(folder, { mode: 0o700, recursive: true }),
      ),
    );
    await writeFile(
      path.join(data, "preferences.json"),
      JSON.stringify({
        mcp_network: { port: ports.mcp, lan_enabled: false, lan_risk_accepted: false },
        local_auto_refresh_enabled: false,
        quota_auto_refresh_enabled: false,
      }),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(localWeb, "web-access.json"),
      JSON.stringify({
        config: { enabled: false, port: ports.web, externalOrigin: "", experimentalEnabled: false },
        credentials: [],
        remotePairingInitialized: false,
      }),
      { mode: 0o600 },
    );
    const sandbox = await writeSandbox(scratch, bundle);
    const context = { scratch, home, data, profile, ports, sandbox, signal };
    const prepared = await Promise.race([Promise.resolve(prepare?.(context)), aborted]);
    await Promise.all(reservations.map(([, server]) => releasePort(server)));
    signal.throwIfAborted();

    const cdpUrl = `http://${loopback}:${ports.cdp}`;
    child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        sandbox,
        target,
        // The outer Seatbelt profile applies to Electron and its descendants.
        "--no-sandbox",
        "--use-mock-keychain",
        `--remote-debugging-address=${loopback}`,
        `--remote-debugging-port=${ports.cdp}`,
      ],
      { cwd: home, env, detached: true, stdio: ["ignore", "ignore", "pipe"] },
    );
    let logTail = "";
    let browserEndpoint;
    child.stderr.on("data", (chunk) => {
      logTail = (logTail + chunk).slice(-4_096);
      browserEndpoint ??= logTail.match(
        /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/,
      )?.[1];
    });
    child.once("error", (error) => controller.abort(error));
    child.once("exit", (code, reason) => {
      if (!signal.aborted) {
        controller.abort(
          new Error(`Packaged desktop exited during acceptance (${reason ?? code})\n${logTail}`),
        );
      }
    });
    await untilReady(cdpUrl, () => browserEndpoint, signal);
    result = await Promise.race([
      Promise.resolve(exercise({ ...context, cdpUrl, prepared })),
      aborted,
    ]);
  } catch (error) {
    failure = signal.reason ?? error;
  } finally {
    controller.abort();
    clearTimeout(timer);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    try {
      await stopDesktop(child);
      await removeClaudeSocket(data);
      await Promise.all(
        reservations
          .filter(([, server]) => server.listening)
          .map(([, server]) => releasePort(server)),
      );
      await rm(scratch, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      failure = failure ? new AggregateError([failure, error], "Desktop acceptance failed") : error;
    } finally {
      child?.stderr?.destroy();
    }
  }
  if (failure) throw failure;
  return result;
}
