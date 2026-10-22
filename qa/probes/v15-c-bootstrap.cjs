// SYNTHETIC VISUAL QA ONLY. Production source and authorization checks stay intact.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { app, ipcMain, session, shell, safeStorage } = require("electron");
const { OWNER, validateState, accountStatus, createBoundary } = require("./v15-c-fixtures.cjs");
process.umask(0o077);

function ownedJson(file) {
  const info = fs.lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Unsafe visual fixture file");
  assert.equal(info.uid, process.getuid());
  assert.ok(info.size < 64 * 1024);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
const baseFile = process.env.AGENTKIB_V15_B_FIXTURE;
assert.ok(
  /^\/private\/tmp\/agentkib-v15-b-c-[a-zA-Z0-9-]+\/fixture-private\.json$/.test(baseFile ?? ""),
);
const root = path.dirname(baseFile);
assert.equal(fs.realpathSync(root), root, "Unsafe sandbox root");
const base = ownedJson(baseFile);
const config = ownedJson(path.join(root, "c-fixture-private.json"));
assert.equal(base.owner, "agentkib-v15-b-sandbox");
assert.equal(base.root, root);
assert.equal(config.owner, OWNER);
assert.equal(config.root, root);
assert.equal(config.repository, base.repository);
assert.equal(config.stateFile, path.join(root, "c-state-private.json"));
assert.equal(typeof base.sessionId, "string", "Seed the synthetic session first");
for (const name of [
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "AGENTKIB_HOME",
  "AGENTKIB_BENCHMARK_DATA_DIR",
  "AGENTKIB_BENCHMARK_USER_DATA",
]) {
  assert.ok(process.env[name]?.startsWith(`${root}/`), "Unsafe isolated environment");
  assert.ok(fs.realpathSync(process.env[name]).startsWith(`${root}/`), "Unsafe isolated symlink");
}
for (const directory of ["web", "web-lan"]) {
  const saved = ownedJson(path.join(base.paths.profile, directory, "web-access.json"));
  assert.equal(saved.config.enabled, false, "Real remote listeners must remain disabled");
  assert.ok(!saved.config.relay?.enabled);
  assert.deepEqual(saved.credentials, [], "Visual QA never loads browser credentials");
}
function readState() {
  return validateState(ownedJson(config.stateFile));
}
function writeState(next) {
  validateState(next);
  const temporary = `${config.stateFile}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, config.stateFile);
}
readState();

// Avoid asking securityd for any host keychain entry, even an availability probe.
safeStorage.isEncryptionAvailable = () => false;
safeStorage.encryptString = safeStorage.decryptString = () => {
  throw new Error("Visual QA never encrypts or decrypts credentials");
};
const wrap = createBoundary({ readState, writeState, sessionId: base.sessionId });
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => originalHandle(channel, wrap(channel, handler));
for (const method of ["openExternal", "openPath", "showItemInFolder"]) {
  shell[method] = () => {
    throw new Error("Visual QA blocks external applications");
  };
}
const lifecycleFile = path.join(root, "c-lifecycle.jsonl");
const lifecycle = (event) =>
  fs.appendFileSync(
    lifecycleFile,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event })}\n`,
    { mode: 0o600 },
  );
lifecycle("bootstrap");
process.on("exit", () => lifecycle("process-exit"));
app.on("before-quit", () => lifecycle("before-quit"));
app.on("browser-window-created", (_event, window) => {
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) =>
    send(channel, ...(channel === "agentkib:account:status" ? [accountStatus(readState())] : args));
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
      if (url.protocol === "file:") {
        const file = require("node:url").fileURLToPath(url);
        allowed = [root, config.repository].some((directory) => file.startsWith(`${directory}/`));
      }
    } catch {}
    callback({ cancel: !allowed });
  });
});
require(path.join(base.repository, "apps/desktop/dist-electron/main.cjs"));
