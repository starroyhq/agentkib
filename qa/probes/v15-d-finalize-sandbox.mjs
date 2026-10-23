// Real production reads over synthetic native files. This probe never replaces IPC handlers.
// node qa/probes/v15-d-finalize-sandbox.mjs prepare|seed|launch-config --root /tmp/agentkib-v15-d-finalize-qa
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
  ["prepare", "seed", "launch-config"].includes(command),
  "Use prepare, seed or launch-config",
);
const options = {};
for (let index = 3; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert.ok(["--root", "--electron", "--locale", "--cdp-port", "--scenario"].includes(key));
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  options[key.slice(2)] = process.argv[index + 1];
}
const root = path
  .resolve(options.root ?? "/tmp/agentkib-v15-d-finalize-qa")
  .replace(/^\/tmp\//, "/private/tmp/");
assert.match(root, /^\/private\/tmp\/agentkib-v15-d-finalize-[a-z0-9-]+$/);
const owner = "agentkib-v15-d-finalize-sandbox";
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
const workspace = path.join(home, "projects/northstar-api");
assert.ok(options.scenario === undefined || options.scenario === "d-revalidation");
const longWorkspaceName = "northstar-payments-reconciliation-release-workflow-"
  .repeat(3)
  .slice(0, 112);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function put(file, value) {
  assert.ok(file.startsWith(`${root}/`));
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
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
    AGENTKIB_V15_D_FINALIZE_FIXTURE: configFile,
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
    cwd: workspace,
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
  const cdpPort = Number(options["cdp-port"] ?? 19347);
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
    nativeId: "11111111-1111-4111-8111-111111111111",
    revalidationWorkspace:
      options.scenario === "d-revalidation" ? path.join(home, "projects", longWorkspaceName) : null,
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
  await put(path.join(paths.profile, "web-lan/web-access.json"), {
    config: {
      enabled: false,
      port: await freePort(),
      externalOrigin: "",
      experimentalEnabled: false,
    },
    credentials: [],
  });
  await put(path.join(workspace, "package.json"), { name: "northstar-api", private: true });
  await put(
    path.join(workspace, "AGENTS.md"),
    "# Northstar API\nSynthetic offline UI acceptance workspace\n",
  );
  await put(
    path.join(workspace, "CLAUDE.md"),
    "# Northstar API\nSynthetic offline UI acceptance workspace\n",
  );
  // No .git: OpenCode really discovers the personal skill through this project's ancestor roots.
  for (const [directory, name, description] of [
    [path.join(paths.claude, "skills/code-style"), "code-style", "Review consistent code style"],
    [
      path.join(workspace, ".claude/skills/release-notes"),
      "release-notes",
      "Summarize release changes",
    ],
    [path.join(workspace, ".agents/skills/api-checks"), "api-checks", "Review API contracts"],
  ])
    await put(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSynthetic offline acceptance Skill\n`,
    );
  await put(path.join(paths.codex, "config.toml"), "# Synthetic offline QA configuration\n");
  await put(path.join(paths.claude, "settings.json"), {});
  if (config.revalidationWorkspace) {
    await put(path.join(config.revalidationWorkspace, "package.json"), {
      name: longWorkspaceName,
      private: true,
    });
    await put(
      path.join(config.revalidationWorkspace, "AGENTS.md"),
      "# Long workspace\nSynthetic offline revalidation workspace\n",
    );
    await put(
      path.join(config.revalidationWorkspace, ".claude/skills/project-rules/SKILL.md"),
      "---\nname: project-rules\ndescription: Synthetic project rules\n---\n\n# Project rules\n\nSynthetic offline acceptance Skill\n",
    );
  }
  await put(path.join(workspace, ".agentkib/mcp.json"), {
    schema_version: 1,
    servers: [
      {
        id: "github",
        name: "github",
        enabled: true,
        transport: "stdio",
        command: "agentkib-v15-qa-never-run",
        args: [],
        env: {},
        headers: {},
        targets: ["claude-code", "codex"],
        allow_tools: [],
        lan_allow_tools: [],
        supports_parallel_tool_calls: false,
      },
    ],
  });
  const project = path.join(paths.claude, "projects", workspace.replaceAll("/", "-"));
  const fullPath = path.join(project, `${config.nativeId}.jsonl`);
  const title = "检查 Northstar API 发布说明";
  const lines = [
    {
      type: "user",
      uuid: `${config.nativeId}-u`,
      sessionId: config.nativeId,
      cwd: workspace,
      timestamp: "2026-10-23T01:00:00Z",
      message: { role: "user", content: title },
    },
    {
      type: "assistant",
      uuid: `${config.nativeId}-a`,
      parentUuid: `${config.nativeId}-u`,
      sessionId: config.nativeId,
      cwd: workspace,
      timestamp: "2026-10-23T01:01:00Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "这是一条合成会话，仅供离线界面验收" }],
      },
    },
  ];
  await put(fullPath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  await put(path.join(project, "sessions-index.json"), {
    version: 1,
    entries: [
      {
        sessionId: config.nativeId,
        fullPath,
        projectPath: workspace,
        summary: title,
        created: "2026-10-23T01:00:00Z",
        modified: "2026-10-23T01:01:00Z",
        messageCount: 2,
      },
    ],
  });
  await put(
    path.join(paths.claude, "history.jsonl"),
    `${JSON.stringify({ display: title, pastedContents: {}, timestamp: Date.parse("2026-10-23T01:00:00Z"), project: workspace, sessionId: config.nativeId })}\n`,
  );
  await put(path.join(paths.app, "package.json"), {
    name: owner,
    version: "0.20.2",
    main: "bootstrap.cjs",
  });
  await put(
    path.join(paths.app, "bootstrap.cjs"),
    `require(${JSON.stringify(path.join(repository, "qa/probes/v15-d-finalize-bootstrap.cjs"))});\n`,
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
    workspace: "~/projects/northstar-api",
    skills: ["code-style", "release-notes", "api-checks"],
    sessionCount: 1,
    modelRequests: 0,
    accounts: "signed-out",
    credentials: [],
    network: "OS Seatbelt allows loopback only; local Web enabled, relay and LAN disabled",
    limitations: [
      "No real account, model, tool startup, pairing, relay readiness or CLI continuation",
      "Connect new phone dialog requires relay ready and cannot be covered in this offline sandbox",
      "QA --no-sandbox uses outer Seatbelt and does not verify Chromium renderer sandbox",
    ],
  });
  await put(path.join(root, "launch-private.json"), launchConfig(config));
  console.log(
    json({
      prepared: true,
      root,
      next: "Build current sources, then seed; use launch-config in an owned persistent REPL",
    }),
  );
} else {
  const config = await readConfig();
  if (command === "launch-config") {
    console.log(json(launchConfig(config)));
  } else {
    const entry = path.join(desktop, "dist-electron/backend.cjs");
    assert.ok((await lstat(entry)).isFile(), "Build the current worktree backend before seed");
    const child = spawn(
      "/usr/bin/sandbox-exec",
      ["-f", path.join(root, "network.sb"), config.electron, entry],
      {
        cwd: workspace,
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
      const addWorkspace = async (directory) => {
        const context = await rpc("backend.nativeContext");
        const plan = await rpc("backend.planWorkspace", {
          operation: "add",
          path: directory,
          context,
        });
        const inspections = await rpc("backend.inspectWorkspaces", {
          workspaces: [{ id: plan.id, path: plan.path }],
        });
        return rpc("workspace.add", {
          path: directory,
          _plan: plan,
          _inspection: inspections[0].inspection,
        });
      };
      const added = await addWorkspace(workspace);
      if (config.revalidationWorkspace) await addWorkspace(config.revalidationWorkspace);
      await rpc("workspace.refreshSessions", { workspaceId: added.id, force: true });
      const sessions = await rpc("workspace.sessions", { workspaceId: added.id });
      assert.equal(sessions.length, 1, "Expected one real-read synthetic Claude session");
      const inventory = await rpc("skills.inventory");
      const personal = inventory.observations.find(
        (item) => item.scope === "personal" && item.name === "code-style",
      );
      assert.ok(personal, "Personal Claude skill missing");
      for (const agent of ["claude-code", "cursor", "opencode", "grok-build"])
        assert.ok(personal.agents.includes(agent), `Personal visibility missing ${agent}`);
      assert.ok(
        inventory.observations.some(
          (item) => item.scope === "workspace" && item.path === personal.path,
        ),
        "Expected a real personal/workspace ancestor relationship",
      );
      assert.ok(
        inventory.observations.every((item) => item.status === "observed"),
        "Normal native status must come from the backend",
      );
      const mcp = await rpc("mcp.managementState", { project: workspace });
      assert.ok(
        mcp.servers.some((item) => item.config.id === "github"),
        "Project MCP service missing",
      );
      await put(configFile, { ...config, workspaceId: added.id, sessionId: sessions[0].id });
      await put(path.join(root, "seed-result-private.json"), {
        workspaceId: added.id,
        sessionId: sessions[0].id,
        inventory,
        mcp,
      });
      await put(path.join(root, "seed-result.json"), {
        seeded: true,
        realBackendReads: true,
        sessionCount: sessions.length,
        skillGroups: new Set(inventory.observations.map((item) => item.resolved_path ?? item.path))
          .size,
        personalAgents: personal.agents,
        personalWorkspaceRelationship: true,
        mcpIds: mcp.servers.map((item) => item.config.id),
      });
      console.log(await readFile(path.join(root, "seed-result.json"), "utf8"));
      await rpc("agentkib.shutdown");
    } finally {
      child.stdin.end();
      if (child.exitCode === null) child.kill("SIGTERM");
    }
  }
}
