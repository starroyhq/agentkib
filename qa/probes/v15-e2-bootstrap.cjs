// Safety boundary only. Production IPC registration, reads and results stay untouched.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, session, shell, safeStorage, utilityProcess } = require("electron");
const file = process.env.AGENTKIB_V15_E2_FIXTURE;
assert.match(file ?? "", /^\/private\/tmp\/agentkib-v15-e2-[a-z0-9-]+\/fixture-private\.json$/);
const config = JSON.parse(fs.readFileSync(file, "utf8"));
assert.equal(config.owner, "agentkib-v15-e2-sandbox");
assert.equal(fs.realpathSync(config.root), config.root);
for (const [key, directory] of Object.entries({
  HOME: "home",
  CODEX_HOME: "codex",
  CLAUDE_CONFIG_DIR: "claude",
  AGENTKIB_BENCHMARK_DATA_DIR: "data",
  AGENTKIB_BENCHMARK_USER_DATA: "profile",
  AGENTKIB_HOME: "library",
})) {
  assert.equal(process.env[key], config.paths[directory]);
  assert.ok(fs.realpathSync(process.env[key]).startsWith(config.root + "/"));
}
assert.equal(config.paths.claude, path.join(config.paths.home, ".claude"));
assert.equal(config.paths.codex, path.join(config.paths.home, ".codex"));
require("./v15-e2-response-delay.cjs").installPlanResponseDelay(utilityProcess, config.root);
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => {
  throw new Error("Offline QA blocks Keychain encryption and decryption");
};
for (const method of ["openExternal", "openPath", "showItemInFolder"])
  shell[method] = () => {
    throw new Error("Offline QA blocks external applications");
  };
const allowed = (value) => {
  try {
    const url = new URL(value);
    return (
      ["app:", "data:", "devtools:"].includes(url.protocol) ||
      (["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
};
app.on("browser-window-created", (_event, window) => {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!allowed(url)) event.preventDefault();
  });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !allowed(details.url) }),
  );
});
require(path.join(config.repository, "apps/desktop/dist-electron/main.cjs"));
