// Synthetic D-batch visual QA only; production handlers and authorization stay unchanged.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, ipcMain, session, shell, safeStorage } = require("electron");
const file = process.env.AGENTKIB_V15_B_FIXTURE;
assert.match(file ?? "", /^\/private\/tmp\/agentkib-v15-b-d-[a-z0-9-]+\/fixture-private\.json$/);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(config.owner, "agentkib-v15-b-sandbox");
assert.equal(fs.realpathSync(config.root), config.root);
for (const key of [
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "AGENTKIB_BENCHMARK_DATA_DIR",
  "AGENTKIB_BENCHMARK_USER_DATA",
  "AGENTKIB_HOME",
]) {
  assert.ok(process.env[key]?.startsWith(config.root + "/"));
  assert.ok(fs.realpathSync(process.env[key]).startsWith(config.root + "/"));
}
const workspace = {
  id: "demo-northstar",
  name: "northstar-api",
  path: "/Users/demo/projects/northstar-api",
  status: "healthy",
  asset_count: 2,
  warning_count: 0,
  sources: [
    {
      agent: "claude-code",
      scope: "workspace",
      path: "/Users/demo/projects/northstar-api/.claude",
    },
  ],
};
const support = {
  workspace_discovery: true,
  session_list: true,
  history_read: true,
  continuation: true,
  control: "experimental",
};
const installations = [
  "codex",
  "claude-code",
  "opencode",
  "cursor",
  "gemini",
  "grok",
  "openclaw",
  "hermes",
  "deepseek",
].map((agent) => ({
  agent,
  installed: ["codex", "claude-code"].includes(agent),
  configured: ["codex", "claude-code"].includes(agent),
  home:
    agent === "codex"
      ? "/Users/demo/.codex"
      : agent === "claude-code"
        ? "/Users/demo/.claude"
        : undefined,
  warnings: [],
  support,
}));
const observations = ["release-notes", "api-checks"].map((name, index) => ({
  id: "native-" + index,
  name,
  path: workspace.path + "/.claude/skills/" + name,
  resolved_path: workspace.path + "/.claude/skills/" + name,
  scope: "workspace",
  workspace_id: workspace.id,
  agents: ["claude-code"],
  kind: "directory",
  status: "visible",
  owner: "external",
  library_id: null,
  diagnostics: [],
}));
const server = {
  config: {
    id: "github",
    name: "github",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "@example/github-mcp"],
    env: {},
    headers: {},
    targets: ["claude-code", "codex"],
    allow_tools: [],
    lan_allow_tools: [],
    supports_parallel_tool_calls: false,
  },
  scope: "workspace",
  inherited: false,
  required_env: [],
  required_headers: [],
  configured_env: [],
  configured_headers: [],
  oauth_configured: false,
};
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  originalHandle(channel, async (event, ...args) => {
    switch (channel) {
      case "agentkib:paths:display-context":
        return { homeDirectory: "/Users/demo" };
      case "agentkib:home:workspaces":
        return [workspace];
      case "agentkib:home:agent-installations":
        return installations;
      case "agentkib:home:catalog-assets":
      case "agentkib:home:global-memories":
      case "agentkib:home:activity":
      case "agentkib:home:remote-gateways":
        return [];
      case "agentkib:home:insights-status":
        return { providers: [], running: false };
      case "agentkib:skills:installed":
      case "agentkib:skills:removed":
      case "agentkib:skills:list-deployments":
      case "agentkib:skills:sync-runs":
        return [];
      case "agentkib:skills:inventory":
        return { observations, warnings: [] };
      case "agentkib:skills:sync-state":
        return { library: [], observations: [], deployments: [], warnings: [] };
      case "agentkib:skills:catalog":
        return { entries: [], cached_at: "2026-10-22", stale: false };
      case "agentkib:mcp:management-state":
        return {
          revision: args[0]?.project ? "fixture-project" : "fixture-global",
          servers: args[0]?.project === workspace.path ? [server] : [],
        };
      case "agentkib:mcp:probe-runtime":
        return [];
      case "agentkib:mcp:list-installations":
      case "agentkib:mcp:list-runtimes":
        return [];
      case "agentkib:account:request":
        assert.equal(args[0]?.operation, "status");
        return { phase: "signed-out", secureStorage: true };
      case "agentkib:remote:request":
        assert.ok(["status", "discover"].includes(args[0]?.operation));
        return {
          local: {
            id: "example-computer",
            name: "Example computer",
            enabled: false,
            address: null,
          },
          interfaces: [{ name: "Example Wi-Fi", address: "192.0.2.10" }],
          discovered: [],
          pending: [],
          authorized: [],
          connections: [],
          pairing_code: null,
          pairing_expires_at: null,
        };
    }
    if (
      /^agentkib:(skills|mcp):/.test(channel) &&
      /(?:apply|save|remove|install|uninstall|prepare|import|recover)/.test(channel)
    )
      throw new Error("Visual QA blocks configuration writes");
    return handler(event, ...args);
  });
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => {
  throw new Error("Visual QA blocks keychain operations");
};
for (const method of ["openExternal", "openPath", "showItemInFolder"])
  shell[method] = () => {
    throw new Error("Visual QA blocks external applications");
  };
app.on("browser-window-created", (_event, window) => {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://bundle/")) event.preventDefault();
  });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed =
        ["app:", "data:", "devtools:"].includes(url.protocol) ||
        (["http:", "https:"].includes(url.protocol) &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
    } catch {}
    callback({ cancel: !allowed });
  });
});
require(path.join(config.repository, "apps/desktop/dist-electron/main.cjs"));
