// QA-only visual sandbox. No personal profile, credential, session or CLI is imported.
// node qa/probes/v15-b-sandbox.mjs prepare|seed|start|stop|state [--root ...]
// The bridge/live payloads are SYNTHETIC and do not accept the real bridge protocol.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const desktop = path.join(repository, "apps/desktop");
const command = process.argv[2];
const options = {};
for (let index = 3; index < process.argv.length; index += 2) {
  assert.ok(["--root", "--cdp-port", "--state"].includes(process.argv[index]));
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
const root = path
  .resolve(options.root ?? "/tmp/agentkib-v15-b-sandbox")
  .replace(/^\/tmp\//, "/private/tmp/");
assert.ok(/^\/(?:private\/)?tmp\/agentkib-v15-b-[^/]+$/.test(root), "Use a dedicated QA root");
const owner = "agentkib-v15-b-sandbox";
const states = [
  "unconnected",
  "waiting",
  "connected",
  "expired",
  "failed",
  "disconnected",
  "unsupported",
];
const paths = {
  home: path.join(root, "home"),
  codex: path.join(root, "codex"),
  claude: path.join(root, "claude"),
  data: path.join(root, "runtime-data"),
  profile: path.join(root, "electron-profile"),
  library: path.join(root, "library"),
  app: path.join(root, "desktop"),
};
const workspace = path.join(paths.home, "projects/northstar-api");
const configFile = path.join(root, "fixture-private.json");
const stateFile = path.join(root, "bridge-state-private.json");
const requireDesktop = createRequire(path.join(desktop, "package.json"));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function put(file, value) {
  await mkdir(path.dirname(file), { mode: 0o700, recursive: true });
  await writeFile(file, typeof value === "string" ? value : json(value), { mode: 0o600 });
  await chmod(file, 0o600);
}
async function readConfig() {
  const rootStat = await lstat(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Unsafe QA root");
  const configStat = await lstat(configFile);
  assert.ok(configStat.isFile() && !configStat.isSymbolicLink(), "Unsafe fixture file");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.owner, owner);
  assert.equal(config.repository, repository);
  assert.equal(config.root, root);
  assert.deepEqual(config.paths, paths);
  return config;
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function environment() {
  // Deliberately do not inherit provider/account variables or any personal roots.
  return {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: path.join(paths.home, ".config"),
    XDG_DATA_HOME: path.join(paths.home, ".local/share"),
    TMPDIR: root,
    CODEX_HOME: paths.codex,
    CLAUDE_CONFIG_DIR: paths.claude,
    AGENTKIB_HOME: paths.library,
    AGENTKIB_BENCHMARK_DATA_DIR: paths.data,
    AGENTKIB_BENCHMARK_USER_DATA: paths.profile,
    AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
    AGENTKIB_DEV: "1",
    AGENTKIB_LOCALE: "zh-CN",
    AGENTKIB_SYSTEM_THEME: "light",
    AGENTKIB_V15_B_FIXTURE: configFile,
    LANG: "zh_CN.UTF-8",
  };
}
function identity(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}

if (command === "prepare") {
  await mkdir(root, { mode: 0o700, recursive: true });
  const rootStat = await lstat(root);
  assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink(), "Unsafe QA root");
  try {
    await readConfig();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    assert.deepEqual(await readdir(root), [], "Refusing an existing unowned directory");
  }
  await chmod(root, 0o700);
  for (const directory of Object.values(paths)) {
    await mkdir(directory, { mode: 0o700, recursive: true });
    assert.ok((await realpath(directory)).startsWith(`${root}/`), "Unsafe isolated directory");
    await chmod(directory, 0o700);
  }
  const cdpPort = Number(options["cdp-port"] ?? 19343);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 1024 && cdpPort < 65536);
  const config = {
    owner,
    repository,
    root,
    paths,
    workspace,
    stateFile,
    webPort: await freePort(),
    mcpPort: await freePort(),
    cdpPort,
    sessionId: null,
    nativeId: "11111111-1111-4111-8111-111111111111",
  };
  await put(configFile, config);
  await put(stateFile, { owner, mode: "unconnected", revision: 1 });
  await put(path.join(paths.data, "preferences.json"), {
    locale_preference: "zh-CN",
    theme_preference: "light",
    accent_theme_preference: "vtron",
    close_behavior: "quit",
    session_index_enabled: true,
    local_auto_refresh_enabled: false,
    quota_auto_refresh_enabled: false,
    quota_auto_refresh_prompt_seen: true,
    mcp_network: { port: config.mcpPort, lan_enabled: false, lan_risk_accepted: false },
    onboarding: {
      acknowledged_version: 1,
      workspace_id: null,
      doctor_completed: true,
      repairable_count: 0,
      repair_applied: false,
    },
  });
  await put(path.join(paths.profile, "web/web-access.json"), {
    config: {
      enabled: true,
      port: config.webPort,
      externalOrigin: "",
      experimentalEnabled: false,
      relay: { enabled: false, brokerUrl: "https://example.invalid" },
    },
    credentials: [],
    remotePairingInitialized: false,
  });
  await put(path.join(workspace, "AGENTS.md"), "# Northstar API\nSynthetic visual QA only.\n");
  await put(path.join(workspace, "CLAUDE.md"), "# Northstar API\nSynthetic visual QA only.\n");
  await put(path.join(workspace, "package.json"), { name: "northstar-api", private: true });
  const project = path.join(paths.claude, "projects", workspace.replaceAll("/", "-"));
  const title = "检查连接终端指引";
  const lines = [
    {
      type: "user",
      uuid: `${config.nativeId}-u`,
      sessionId: config.nativeId,
      cwd: workspace,
      timestamp: "2026-10-22T01:00:00Z",
      message: { role: "user", content: title },
    },
    {
      type: "assistant",
      uuid: `${config.nativeId}-a`,
      parentUuid: `${config.nativeId}-u`,
      sessionId: config.nativeId,
      cwd: workspace,
      timestamp: "2026-10-22T01:01:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "这是合成会话。终端连接状态由 QA fixture 提供。" }],
      },
    },
  ];
  const fullPath = path.join(project, `${config.nativeId}.jsonl`);
  await put(fullPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  await put(path.join(project, "sessions-index.json"), {
    version: 1,
    entries: [
      {
        sessionId: config.nativeId,
        fullPath,
        projectPath: workspace,
        summary: title,
        created: "2026-10-22T01:00:00Z",
        modified: "2026-10-22T01:01:00Z",
        messageCount: 2,
      },
    ],
  });
  await put(path.join(paths.app, "package.json"), {
    name: owner,
    version: "0.20.2",
    main: "bootstrap.cjs",
  });
  await put(
    path.join(paths.app, "bootstrap.cjs"),
    `require(${JSON.stringify(path.join(repository, "qa/probes/v15-b-bootstrap.cjs"))});\n`,
  );
  for (const [target, link] of [
    [path.join(desktop, "dist"), path.join(paths.app, "dist")],
    [path.join(desktop, "build"), path.join(paths.app, "build")],
    [path.join(repository, "apps/web/dist"), path.join(root, "web/dist")],
  ]) {
    await mkdir(path.dirname(link), { mode: 0o700, recursive: true });
    try {
      await symlink(target, link, "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      assert.equal(await realpath(link), await realpath(target), "Unsafe existing build link");
    }
  }
  const realHome = os.homedir();
  const denied = [
    ".claude",
    ".codex/sessions",
    ".codex/archived_sessions",
    ".cursor",
    ".agents",
    ".agentkib",
    ".agentkib-dev",
    ".config",
    ".openclaw",
    ".hermes",
    ".grok",
    ".gemini",
    ".dsh",
    ".ssh",
    ".aws",
    "Documents",
    "Desktop",
    "Downloads",
    "Pictures",
    "Movies",
    "Music",
    "Library/Keychains",
    "Library/Application Support/AgentKib",
    "Library/Application Support/Claude",
    "Library/Application Support/ClaudeCode",
  ].map((directory) => path.join(realHome, directory));
  denied.push("/Library/Application Support/ClaudeCode");
  assert.ok(
    !denied.some((directory) => repository.startsWith(`${directory}/`)),
    "This launcher needs a checkout outside personal data directories",
  );
  const fileGuards = denied
    .map(
      (directory) =>
        `(deny file-read* (subpath ${JSON.stringify(directory)}))(deny file-write* (subpath ${JSON.stringify(directory)}))`,
    )
    .join("");
  const personalFiles = [
    ".claude.json",
    ".codex/auth.json",
    ".codex/config.toml",
    ".codex/history.jsonl",
    ".codex/session_index.jsonl",
  ]
    .map(
      (file) =>
        `(deny file-read* (literal ${JSON.stringify(path.join(realHome, file))}))(deny file-write* (literal ${JSON.stringify(path.join(realHome, file))}))`,
    )
    .join("");
  await put(
    path.join(root, "network.sb"),
    `(version 1)(allow default)(deny network*)(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(allow network* (local unix-socket))(allow network* (remote unix-socket))${fileGuards}${personalFiles}\n`,
  );
  await put(path.join(root, "inventory.json"), {
    fixture: "v15-b",
    syntheticOnly: true,
    accounts: "signed-out",
    modelRequests: 0,
    workspace: "~/projects/northstar-api",
    session: { id: config.nativeId, title },
    network: "Seatbelt denies non-loopback. Electron also denies external requests/navigation.",
    isolation:
      "HOME, CODEX_HOME, CLAUDE_CONFIG_DIR, runtime data, Electron profile and AGENTKIB_HOME are private synthetic directories.",
    browserSandbox:
      "QA-only --no-sandbox avoids nested Seatbelt; outer OS guards remain. This does not accept Chromium renderer isolation.",
    bridgeFixture:
      "Only the seeded synthetic session receives bridge/live fixture payloads. Original handler bridge-status validates the trusted renderer, local owner and selected catalog session before synthetic bridge responses; original live completes before display fields are replaced. Real challenge/disconnect/send/stop are never invoked.",
    limitations:
      "Visual component acceptance only; not real bridge IPC end-to-end, CLI, credentials, plugin, login, remote authorization or pairing acceptance.",
    displayPath: "~/Library/Application Support/AgentKib/plugins/agentkib-bridge",
    states,
  });
  console.log(json({ prepared: true, root, cdpPort, next: "Build desktop, then seed and start" }));
} else {
  assert.ok(
    ["seed", "start", "stop", "state"].includes(command),
    "Use prepare, seed, start, stop or state",
  );
  const config = await readConfig();
  if (command === "state") {
    assert.ok(states.includes(options.state), `Use --state ${states.join("|")}`);
    const previous = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(previous.owner, owner);
    const next = {
      owner,
      mode: options.state,
      revision: (previous.revision ?? 0) + 1,
      expiresAt: new Date(
        Date.now() + (options.state === "expired" ? -1000 : 120_000),
      ).toISOString(),
    };
    await put(`${stateFile}.tmp`, next);
    await rename(`${stateFile}.tmp`, stateFile);
    console.log(json({ state: next.mode, syntheticOnly: true }));
    process.exit(0);
  }
  if (command === "stop") {
    const owned = JSON.parse(await readFile(path.join(root, "owned-process.json"), "utf8"));
    const current = identity(owned.pid);
    if (current) {
      assert.equal(current, owned.identity, "Owned process identity changed; refusing signal");
      process.kill(owned.detached ? -owned.pid : owned.pid, "SIGTERM");
      for (let index = 0; index < 200 && identity(owned.pid) === owned.identity; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.notEqual(identity(owned.pid), owned.identity, "Owned Electron process did not exit");
    }
    console.log(json({ stopped: true }));
    process.exit(0);
  }
  const electron = requireDesktop("electron");
  if (command === "seed") {
    await access(path.join(desktop, "dist-electron/backend.cjs"));
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        path.join(root, "network.sb"),
        electron,
        path.join(desktop, "dist-electron/backend.cjs"),
      ],
      {
        cwd: workspace,
        env: { ...environment(), ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const pending = new Map();
    let sequence = 0;
    let diagnostic = "";
    const failPending = (error) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      pending.clear();
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line);
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      frame.error ? waiter.reject(new Error(frame.error.message)) : waiter.resolve(frame.result);
    });
    child.stderr.on("data", (value) => {
      diagnostic = (diagnostic + String(value)).slice(-2000);
    });
    child.on("error", failPending);
    child.on("exit", () => failPending(new Error(`Seed backend exited: ${diagnostic}`)));
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Seed ${method} timeout`));
          }, 30_000),
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    try {
      await rpc("backend.initialize", { dataDir: paths.data });
      const context = await rpc("backend.nativeContext");
      const plan = await rpc("backend.planWorkspace", {
        operation: "add",
        path: workspace,
        context,
      });
      const inspections = await rpc("backend.inspectWorkspaces", {
        workspaces: [{ id: plan.id, path: plan.path }],
      });
      const added = await rpc("workspace.add", {
        path: workspace,
        _plan: plan,
        _inspection: inspections[0].inspection,
      });
      await rpc("workspace.refreshSessions", { workspaceId: added.id, force: true });
      const sessions = await rpc("workspace.sessions", { workspaceId: added.id });
      assert.equal(sessions.length, 1, "Expected exactly one synthetic Claude session");
      assert.equal(typeof sessions[0].id, "string");
      await put(configFile, { ...config, sessionId: sessions[0].id });
      await put(path.join(root, "seed-result.json"), {
        workspaceId: added.id,
        sessionId: sessions[0].id,
        sessionCount: 1,
      });
      console.log(json({ seeded: true, sessionCount: 1 }));
      await rpc("agentkib.shutdown");
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  } else {
    assert.equal(typeof config.sessionId, "string", "Run seed before start");
    try {
      const previous = JSON.parse(await readFile(path.join(root, "owned-process.json"), "utf8"));
      assert.notEqual(identity(previous.pid), previous.identity, "Sandbox is already running");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    for (const file of ["dist-electron/main.cjs", "dist-electron/preload.cjs", "dist/index.html"])
      await access(path.join(desktop, file));
    const cdpPort = Number(options["cdp-port"] ?? config.cdpPort);
    assert.ok(Number.isInteger(cdpPort) && cdpPort > 1024 && cdpPort < 65536);
    const log = await open(path.join(root, "electron.stderr.log"), "a", 0o600);
    const child = spawn(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        path.join(root, "network.sb"),
        electron,
        "--use-mock-keychain",
        "--no-sandbox",
        `--remote-debugging-port=${cdpPort}`,
        paths.app,
      ],
      {
        cwd: workspace,
        env: environment(),
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    await log.close();
    child.unref();
    let ownedIdentity = "";
    for (let index = 0; index < 200; index += 1) {
      ownedIdentity = identity(child.pid);
      if (ownedIdentity && !ownedIdentity.includes("/usr/bin/sandbox-exec")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      ownedIdentity && !ownedIdentity.includes("/usr/bin/sandbox-exec"),
      "Electron did not start",
    );
    await put(path.join(root, "owned-process.json"), {
      pid: child.pid,
      identity: ownedIdentity,
      detached: true,
    });
    console.log(
      json({
        started: true,
        pid: child.pid,
        cdp: `http://127.0.0.1:${cdpPort}`,
        web: `http://127.0.0.1:${config.webPort}`,
        root,
      }),
    );
  }
}
