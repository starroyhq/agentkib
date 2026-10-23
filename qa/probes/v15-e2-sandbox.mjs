// Real production reads over synthetic native files. This probe never replaces IPC handlers.
// node qa/probes/v15-e2-sandbox.mjs prepare|discover|ready|locale|disk-conflict|launch-config --root /tmp/agentkib-v15-e2-qa
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
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
assert.ok(
  ["prepare", "discover", "ready", "locale", "disk-conflict", "launch-config"].includes(command),
  "Use prepare, discover, ready, locale, disk-conflict or launch-config",
);
const options = {};
for (let index = 3; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert.ok(["--root", "--electron", "--locale", "--cdp-port"].includes(key));
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  options[key.slice(2)] = process.argv[index + 1];
}
const root = path
  .resolve(options.root ?? "/tmp/agentkib-v15-e2-qa")
  .replace(/^\/tmp\//, "/private/tmp/");
assert.match(root, /^\/private\/tmp\/agentkib-v15-e2-[a-z0-9-]+$/);
const owner = "agentkib-v15-e2-sandbox";
const configFile = path.join(root, "fixture-private.json");
const home = path.join(root, "home");
const paths = {
  home,
  codex: path.join(home, ".codex"),
  claude: path.join(home, ".claude"),
  data: path.join(root, "runtime-data"),
  profile: path.join(root, "electron-profile"),
  library: path.join(root, "library"),
  app: path.join(root, "desktop"),
};
const workspaceNames = ["northstar-api", "atlas-studio", "design-system", "data-pipeline"];
const workspacePaths = workspaceNames.map((name) => path.join(home, "projects", name));
const workspace = workspacePaths[0];
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function put(file, value) {
  assert.ok(file.startsWith(`${root}/`));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const parent = await realpath(path.dirname(file));
  assert.ok(
    parent === root || parent.startsWith(`${root}/`),
    "Fixture writes must stay in the owned root",
  );
  try {
    assert.ok(!(await lstat(file)).isSymbolicLink(), "Refuse to overwrite a symlink");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(file, typeof value === "string" ? value : json(value), { mode: 0o600 });
  await chmod(file, 0o600);
}
async function readConfig() {
  for (const file of [root, configFile]) assert.ok(!(await lstat(file)).isSymbolicLink());
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.owner, owner);
  assert.equal(config.repository, repository);
  assert.equal(config.root, root);
  assert.deepEqual(config.paths, paths);
  for (const directory of Object.values(paths))
    assert.ok((await realpath(directory)).startsWith(`${root}/`));
  return config;
}
async function assertRecordedUiClosed() {
  const file = path.join(root, "ui-owned-pid.json");
  let record;
  try {
    assert.ok(!(await lstat(file)).isSymbolicLink());
    record = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  assert.ok(Number.isInteger(record.pid) && record.pid > 1);
  let running = true;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") running = false;
    else throw error;
  }
  assert.equal(running, false, "Close the recorded owned UI before changing fixture input");
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function environment(config) {
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: paths.home,
    USERPROFILE: paths.home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    TMPDIR: root,
    CODEX_HOME: paths.codex,
    CLAUDE_CONFIG_DIR: paths.claude,
    AGENTKIB_HOME: paths.library,
    AGENTKIB_BENCHMARK_DATA_DIR: paths.data,
    AGENTKIB_BENCHMARK_USER_DATA: paths.profile,
    AGENTKIB_DEV: "1",
    AGENTKIB_APP_FLAVOR: "ai.agentkib.dev",
    AGENTKIB_LOCALE: config.locale,
    AGENTKIB_SYSTEM_THEME: "light",
    AGENTKIB_V15_E2_FIXTURE: configFile,
    LANG: "en_US.UTF-8",
  };
}
function launchConfig(config) {
  return {
    executable: "/usr/bin/sandbox-exec",
    args: [
      "-f",
      path.join(root, "network.sb"),
      config.electron,
      "--use-mock-keychain",
      "--no-sandbox",
      `--remote-debugging-port=${config.cdpPort}`,
      paths.app,
    ],
    cwd: home,
    env: environment(config),
    cdp: `http://127.0.0.1:${config.cdpPort}`,
  };
}
if (command === "prepare") {
  await mkdir(root, { recursive: true, mode: 0o700 });
  assert.ok((await lstat(root)).isDirectory() && !(await lstat(root)).isSymbolicLink());
  assert.deepEqual(
    await readdir(root),
    [],
    "Use a fresh owned directory; prepare never overwrites a sandbox",
  );
  for (const directory of Object.values(paths))
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const locale = options.locale ?? "zh-CN";
  assert.ok(["zh-CN", "zh-TW", "en-US", "ja-JP"].includes(locale));
  const cdpPort = Number(options["cdp-port"] ?? 19357);
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 1024 && cdpPort < 65536);
  const requireDesktop = createRequire(path.join(desktop, "package.json"));
  const electron = options.electron ?? requireDesktop("electron");
  assert.ok(path.isAbsolute(electron) && (await lstat(electron)).isFile());
  const config = {
    owner,
    root,
    repository,
    paths,
    workspace,
    locale,
    cdpPort,
    electron,
    webPort: await freePort(),
    mcpPort: await freePort(),
    phase: "prepared",
    workspaceNames,
    workspacePaths,
    nativeIds: workspaceNames.map((_, index) => `${index + 1}1111111-1111-4111-8111-111111111111`),
  };
  await put(configFile, config);
  await put(path.join(paths.data, "preferences.json"), {
    locale_preference: locale,
    theme_preference: "light",
    accent_theme_preference: "vtron",
    close_behavior: "quit",
    session_index_enabled: true,
    local_auto_refresh_enabled: false,
    quota_auto_refresh_enabled: false,
    quota_auto_refresh_prompt_seen: true,
    mcp_network: { port: config.mcpPort, lan_enabled: false, lan_risk_accepted: false },
    onboarding: {
      acknowledged_version: 0,
      workspace_id: null,
      doctor_completed: false,
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
  await put(path.join(paths.profile, "web-lan/web-access.json"), {
    config: {
      enabled: false,
      port: await freePort(),
      externalOrigin: "",
      experimentalEnabled: false,
    },
    credentials: [],
  });
  await put(path.join(paths.codex, "config.toml"), "# Synthetic offline QA configuration\n");
  await put(path.join(paths.claude, "settings.json"), {});
  await put(path.join(paths.app, "package.json"), {
    name: owner,
    version: "0.20.2",
    main: "bootstrap.cjs",
  });
  await put(
    path.join(paths.app, "bootstrap.cjs"),
    `require(${JSON.stringify(path.join(repository, "qa/probes/v15-e2-bootstrap.cjs"))});\n`,
  );
  for (const [target, link] of [
    [path.join(desktop, "dist"), path.join(paths.app, "dist")],
    [path.join(desktop, "build"), path.join(paths.app, "build")],
    [path.join(repository, "apps/web/dist"), path.join(root, "web/dist")],
  ]) {
    await mkdir(path.dirname(link), { recursive: true, mode: 0o700 });
    await symlink(target, link, "dir");
  }
  // HOME is deliberately isolated; ask the OS for the account root used by Seatbelt guards.
  const actualHome = os.userInfo().homedir;
  assert.ok(
    !repository.startsWith(path.join(actualHome, "Documents") + "/"),
    "Use the managed worktree outside personal Documents",
  );
  const deniedDirectories = [
    ".claude",
    ".codex/sessions",
    ".gemini",
    ".codex/archived_sessions",
    ".cursor",
    ".agents",
    ".agentkib",
    ".agentkib-dev",
    ".config",
    ".openclaw",
    ".hermes",
    ".grok",
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
    "Library/Application Support/ai.agentkib",
    "Library/Application Support/ai.agentkib.dev",
    "Library/Application Support/Claude",
    "Library/Application Support/ClaudeCode",
  ].map((directory) => path.join(actualHome, directory));
  deniedDirectories.push("/Library/Application Support/ClaudeCode");
  const deniedFiles = [
    ".claude.json",
    ".codex/auth.json",
    ".codex/config.toml",
    ".codex/history.jsonl",
    ".codex/session_index.jsonl",
  ].map((file) => path.join(actualHome, file));
  const guards =
    deniedDirectories
      .map(
        (directory) =>
          `(deny file-read* (subpath ${JSON.stringify(directory)}))(deny file-write* (subpath ${JSON.stringify(directory)}))`,
      )
      .join("") +
    deniedFiles
      .map(
        (file) =>
          `(deny file-read* (literal ${JSON.stringify(file)}))(deny file-write* (literal ${JSON.stringify(file)}))`,
      )
      .join("");
  await put(
    path.join(root, "network.sb"),
    `(version 1)(allow default)(deny network*)(allow network-bind (local ip "localhost:*"))(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))(allow network* (local unix-socket))(allow network* (remote unix-socket))(deny mach-lookup (global-name "com.apple.securityd"))(deny mach-lookup (global-name "com.apple.securityd.xpc"))${guards}\n`,
  );
  await put(path.join(root, "inventory.json"), {
    owner,
    syntheticOnly: true,
    realBackendReads: true,
    replacedIpcHandlers: false,
    phase: "prepared",
    workspaceCount: 0,
    sessionCount: 0,
    pendingMemoryCount: 0,
    modelRequests: 0,
    accounts: "signed-out",
    credentials: [],
    network: "OS Seatbelt allows loopback only; local Web enabled, relay and LAN disabled",
    limitations: [
      "No real account, model, tool startup, pairing, relay readiness or CLI continuation",
      "QA --no-sandbox uses outer Seatbelt and does not verify Chromium renderer sandbox",
    ],
  });
  await writeDiscoveryFiles(config);
  await put(path.join(root, "launch-private.json"), launchConfig(config));
  console.log(
    json({
      prepared: true,
      root,
      next: "Wait for the current worktree build, then discover and ready; close the UI before setup transitions",
    }),
  );
} else {
  const config = await readConfig();
  if (["locale", "discover", "ready"].includes(command)) await assertRecordedUiClosed();
  if (command === "launch-config") {
    console.log(json(launchConfig(config)));
  } else if (command === "locale") {
    const locale = options.locale;
    assert.ok(["zh-CN", "zh-TW", "en-US", "ja-JP"].includes(locale));
    const preferences = JSON.parse(
      await readFile(path.join(paths.data, "preferences.json"), "utf8"),
    );
    await put(path.join(paths.data, "preferences.json"), {
      ...preferences,
      locale_preference: locale,
    });
    await put(configFile, { ...config, locale });
    await put(path.join(root, "launch-private.json"), launchConfig({ ...config, locale }));
    console.log(json({ locale, next: "Restart the owned sandbox application" }));
  } else if (command === "disk-conflict") {
    assert.equal(config.phase, "ready");
    const file = path.join(workspace, ".agentkib/manifest.yaml");
    const requireBackend = createRequire(path.join(repository, "packages/backend/package.json"));
    const manifest = requireBackend("yaml").parse(await readFile(file, "utf8"));
    assert.equal(typeof manifest.instructions.shared, "string");
    // Deliberate external edit of synthetic disk input, through the same file the backend rereads.
    manifest.instructions.shared += "\nExternal synthetic disk edit for conflict verification.\n";
    await put(file, manifest);
    console.log(json({ syntheticDiskEdit: true, replacedIpcHandlers: false }));
  } else {
    assert.equal(
      config.phase,
      command === "discover" ? "prepared" : "discovered",
      "Each phase runs once; use a new root to repeat",
    );
    const entry = path.join(desktop, "dist-electron/backend.cjs");
    assert.ok(
      (await lstat(entry)).isFile(),
      "Build the current worktree backend before discover or ready",
    );
    if (command === "discover") await writeDiscoveryFiles(config);
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-f", path.join(root, "network.sb"), config.electron, entry],
      {
        cwd: home,
        env: { ...environment(config), ELECTRON_RUN_AS_NODE: "1" },
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
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        failPending(new Error("Backend emitted invalid JSON-RPC"));
        return;
      }
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(new Error(frame.error.message));
      else waiter.resolve(frame.result);
    });
    child.stderr.on("data", (value) => {
      diagnostic = (diagnostic + String(value)).slice(-4000);
    });
    child.on("error", failPending);
    child.on("exit", () => failPending(new Error(`Sandbox backend exited: ${diagnostic}`)));
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, {
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Sandbox ${method} timeout`));
          }, 30_000),
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    try {
      await rpc("backend.initialize", { dataDir: paths.data });
      if (command === "discover") {
        const [scanRoots, configured] = await Promise.all([
          rpc("backend.nativeScanRootDiscovery", { roots: [] }),
          rpc("backend.nativeConfiguredDiscovery"),
        ]);
        const snapshot = {
          non_workspace_paths: configured.non_workspace_paths,
          candidates: [...scanRoots.candidates, ...configured.candidates],
          installations: configured.installations,
          home_assets: configured.home_assets,
          errors: [...scanRoots.errors, ...configured.errors],
          source_diagnostics: [...scanRoots.source_diagnostics, ...configured.source_diagnostics],
        };
        const context = await rpc("backend.nativeContext");
        const plan = await rpc("backend.planDiscovery", { snapshot, context });
        assert.equal(
          plan.workspaces.length,
          4,
          "Expected exactly four workspaces from real Claude history reads",
        );
        const inspections = await rpc("backend.inspectWorkspaces", {
          workspaces: plan.workspaces.map(({ id, path }) => ({ id, path })),
        });
        const now = new Date().toISOString();
        await rpc("discovery.refresh", {
          _plan: plan,
          _snapshot: snapshot,
          _inspections: inspections,
          _queuedAt: now,
          _startedAt: now,
        });
        const found = await rpc("workspaces.list");
        assert.equal(found.length, 4);
        assert.deepEqual(new Set(found.map((item) => item.path)), new Set(workspacePaths));
        const counts = {};
        for (const item of found) {
          await rpc("workspace.refreshSessions", { workspaceId: item.id, force: true });
          const sessions = await rpc("workspace.sessions", { workspaceId: item.id });
          assert.equal(
            sessions.length,
            1,
            "Each fixture workspace must have one real-read session",
          );
          const report = await rpc("workspace.doctorReport", { id: item.id });
          counts[item.name] = {
            sessions: sessions.length,
            errors: report.summary.error_count,
            warnings: report.summary.warning_count,
          };
        }
        assert.ok(
          counts["northstar-api"].warnings > 0,
          "Duplicate instructions must produce a real diagnostic warning",
        );
        assert.equal(
          counts["atlas-studio"].errors + counts["atlas-studio"].warnings,
          0,
          "Atlas fixture should be healthy",
        );
        await put(configFile, {
          ...config,
          phase: "discovered",
          workspaces: found.map(({ id, path, name }) => ({ id, path, name })),
        });
        await put(path.join(root, "discover-result.json"), {
          phase: "discovered",
          realBackendReads: true,
          workspaceCount: found.length,
          counts,
          sources:
            "Claude Code synthetic history; Antigravity configured without an ACP executable",
          modelRequests: 0,
        });
        await put(path.join(root, "inventory.json"), {
          ...JSON.parse(await readFile(path.join(root, "inventory.json"), "utf8")),
          phase: "discovered",
          workspaceCount: found.length,
          sessionCount: found.length,
        });
        console.log(await readFile(path.join(root, "discover-result.json"), "utf8"));
      } else {
        const target = config.workspaces.find((item) => item.name === "northstar-api");
        assert.ok(target && target.path === workspace);
        // A native manifest is synthetic input; discovery, reports and onboarding use production APIs.
        const manifest = await rpc("workspace.prepareManifest", { project: workspace });
        manifest.workspace.id = target.id;
        await put(path.join(workspace, ".agentkib/manifest.yaml"), manifest);
        const report = await rpc("workspace.doctorReport", { id: target.id });
        await rpc("onboarding.update", {
          event: {
            event: "doctor-completed",
            workspace_id: target.id,
            repairable_count: report.summary.repairable_count,
          },
        });
        const runtime = await rpc("onboarding.update", { event: { event: "dismissed" } });
        assert.equal(runtime.onboarding.acknowledged_version, 1);
        assert.equal(runtime.onboarding.doctor_completed, true);
        await put(configFile, { ...config, phase: "ready" });
        await put(path.join(root, "ready-result.json"), {
          phase: "ready",
          realBackendReads: true,
          pendingMemoryCount: 0,
          diagnosticIssues: report.summary.error_count + report.summary.warning_count,
          onboardingComplete: true,
          modelRequests: 0,
        });
        await put(path.join(root, "inventory.json"), {
          ...JSON.parse(await readFile(path.join(root, "inventory.json"), "utf8")),
          phase: "ready",
          pendingMemoryCount: 0,
        });
        console.log(await readFile(path.join(root, "ready-result.json"), "utf8"));
      }
      await rpc("agentkib.shutdown");
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}

async function writeDiscoveryFiles(config) {
  // Real discovery marks Antigravity as installed from this isolated configuration directory.
  // No ACP executable exists in the whitelisted PATH, so production session reads report unavailable.
  await mkdir(path.join(home, ".gemini"), { recursive: true, mode: 0o700 });
  const histories = [];
  for (const [index, directory] of workspacePaths.entries()) {
    await put(path.join(directory, "package.json"), { name: workspaceNames[index], private: true });
    const instructions = `# ${workspaceNames[index]}\n\n使用 pnpm 管理依赖\n提交前运行 pnpm test\n`;
    await put(path.join(directory, "AGENTS.md"), instructions);
    if (index === 0) await put(path.join(directory, "CLAUDE.md"), instructions);
    const nativeId = config.nativeIds[index];
    const created = new Date(Date.now() - (index + 1) * 3600000).toISOString();
    const modified = new Date(Date.parse(created) + 60000).toISOString();
    const title = [
      "检查 API 发布说明",
      "整理 Atlas 项目结构",
      "更新组件使用说明",
      "核对数据管道检查项",
    ][index];
    const project = path.join(paths.claude, "projects", directory.replaceAll("/", "-"));
    const fullPath = path.join(project, `${nativeId}.jsonl`);
    const lines = [
      {
        type: "user",
        uuid: `${nativeId}-u`,
        sessionId: nativeId,
        cwd: directory,
        timestamp: created,
        message: { role: "user", content: title },
      },
      {
        type: "assistant",
        uuid: `${nativeId}-a`,
        parentUuid: `${nativeId}-u`,
        sessionId: nativeId,
        cwd: directory,
        timestamp: modified,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "这是一条合成会话，仅供离线界面验收。" }],
        },
      },
    ];
    await put(fullPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    await put(path.join(project, "sessions-index.json"), {
      version: 1,
      entries: [
        {
          sessionId: nativeId,
          fullPath,
          projectPath: directory,
          summary: title,
          created,
          modified,
          messageCount: 2,
        },
      ],
    });
    histories.push({
      display: title,
      pastedContents: {},
      timestamp: Date.parse(created),
      project: directory,
      sessionId: nativeId,
    });
  }
  await put(
    path.join(paths.claude, "history.jsonl"),
    `${histories.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
}
