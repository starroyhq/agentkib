// SYNTHETIC VISUAL QA ONLY. This wrapper never changes production source or protocol.
// Bridge/live fixture payloads are scoped to the single seeded synthetic session.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, ipcMain, session, shell } = require("electron");
process.umask(0o077);
const config = JSON.parse(fs.readFileSync(process.env.AGENTKIB_V15_B_FIXTURE, "utf8"));
const owner = "agentkib-v15-b-sandbox";
assert.equal(config.owner, owner, "Missing owned QA sandbox");
assert.ok(/^\/private\/tmp\/agentkib-v15-b-[^/]+$/.test(config.root));
assert.equal(config.stateFile, path.join(config.root, "bridge-state-private.json"));
assert.equal(typeof config.sessionId, "string", "Run the synthetic session seed first");
for (const name of [
  "HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "AGENTKIB_BENCHMARK_DATA_DIR",
  "AGENTKIB_BENCHMARK_USER_DATA",
  "AGENTKIB_HOME",
]) {
  assert.ok(
    process.env[name] && path.resolve(process.env[name]).startsWith(`${config.root}/`),
    `Unsafe QA root: ${name}`,
  );
  assert.ok(
    fs.realpathSync(process.env[name]).startsWith(`${config.root}/`),
    `Unsafe symlinked QA root: ${name}`,
  );
}
const lifecycleFile = path.join(config.root, "lifecycle.jsonl");
const lifecycle = (event, details = {}) =>
  fs.appendFileSync(
    lifecycleFile,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...details })}\n`,
    { mode: 0o600 },
  );
lifecycle("synthetic-visual-bootstrap");
process.on("exit", (code) => lifecycle("process-exit", { code }));
app.on("before-quit", () => lifecycle("before-quit"));
app.on("quit", (_event, exitCode) => lifecycle("quit", { exitCode }));
function bridgeState() {
  const stat = fs.lstatSync(config.stateFile);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "Unsafe fixture state file");
  const state = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  assert.equal(state.owner, owner);
  assert.ok(
    [
      "unconnected",
      "waiting",
      "connected",
      "expired",
      "failed",
      "disconnected",
      "reconnecting",
      "unsupported",
    ].includes(state.mode),
  );
  return state;
}
function saveState(next) {
  const temporary = `${config.stateFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, config.stateFile);
}
const examplePlugin = "/opt/agentkib-qa/plugins/agentkib-bridge";
// This complete, deliberately public code cannot connect: no server uses its
// synthetic socket/ticket. It contains no real challenge or credential.
const publicCode = Buffer.from(
  JSON.stringify({
    protocol: 1,
    socketPath: "/tmp/agentkib-v15-b-SYNTHETIC-VISUAL-ONLY.sock",
    ticket: "0000000000000000000000000000000000000000000000000000000000000000",
    fixture: "SYNTHETIC_VISUAL_ONLY_NOT_A_REAL_CREDENTIAL",
  }),
).toString("base64url");
function hasBinding(state) {
  return state.hasBinding ?? ["connected", "disconnected", "reconnecting"].includes(state.mode);
}
function connectionGeneration(state) {
  return state.connectionGeneration ?? `synthetic-visual-${state.revision ?? 1}`;
}
function statusFor(state) {
  return {
    supported: state.mode !== "unsupported",
    connected: state.mode === "connected",
    hasBinding: hasBinding(state),
    sessionId: config.sessionId,
    version: "2.1.301",
    pluginDirectory: examplePlugin,
    installInstructions: [
      `claude plugin marketplace add '${examplePlugin}'`,
      "claude plugin install agentkib-bridge@agentkib-local",
      "claude plugin update agentkib-bridge@agentkib-local",
      "/reload-plugins",
    ].join("\n"),
    reason:
      state.mode === "unsupported"
        ? "platform-unsupported"
        : state.mode === "connected"
          ? undefined
          : state.mode === "disconnected"
            ? "claude-bridge-disconnected"
            : "claude-bridge-not-connected",
    connectionError:
      state.mode === "expired"
        ? "expired-bridge-challenge"
        : state.mode === "failed"
          ? (state.connectionError ?? "bridge-version-mismatch")
          : undefined,
    connectionCliVersion: state.cliVersion,
    bridgeCompatibility:
      state.mode === "connected" && state.cliVersion
        ? {
            cliVersion: state.cliVersion,
            status: state.cliVersion === "2.1.301" ? "verified" : "unverified",
          }
        : null,
  };
}
function liveFor(live) {
  const state = bridgeState();
  const follower = ["connected", "disconnected"].includes(state.mode);
  return {
    ...live,
    sessionId: config.sessionId,
    executionMode: follower ? "claude-follower" : "managed-resume",
    executionLocation: state.mode === "connected" ? "terminal" : null,
    connectionGeneration: connectionGeneration(state),
    status: state.mode === "disconnected" ? "unsupported" : "idle",
    reason:
      state.mode === "disconnected"
        ? "claude-bridge-disconnected"
        : state.mode === "connected"
          ? "claude-follower-send-unverified"
          : undefined,
    terminalSend: false,
    bridgeCompatibility:
      state.mode === "connected" && state.cliVersion
        ? {
            cliVersion: state.cliVersion,
            status: state.cliVersion === "2.1.301" ? "verified" : "unverified",
          }
        : null,
    sendEnabled: false,
    stopEnabled: false,
    turnId: null,
    approvals: [],
    questions: [],
    streamText: "",
  };
}
function streamEvent(value) {
  if (value?.sessionId !== config.sessionId) return value;
  if (value.type === "snapshot" && value.payload?.live)
    return { ...value, payload: { ...value.payload, live: liveFor(value.payload.live) } };
  if (value.type === "state") return { ...value, payload: liveFor(value.payload) };
  return value;
}
app.on("browser-window-created", (_event, window) => {
  window.on("closed", () => lifecycle("window-closed"));
  // Keep subscription envelopes/cursors/ACKs real, replacing only synthetic live
  // display fields after the production event path has enforced its permissions.
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) =>
    send(
      channel,
      ...(channel === "agentkib:conversation:event"
        ? [streamEvent(args[0]), ...args.slice(1)]
        : args),
    );
});
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) =>
  originalHandle(channel, async (event, ...args) => {
    if (channel === "agentkib:claude:request") {
      const input = args[0];
      if (
        ["send", "stop", "approve", "answer", "create", "adopt", "release", "reconcile"].includes(
          input?.operation,
        )
      )
        throw new Error("Synthetic visual QA never runs model or session controls");
      if (["bridge-status", "bridge-challenge", "bridge-disconnect"].includes(input?.operation)) {
        assert.equal(input.sessionId, config.sessionId, "Fixture is only for the seeded session");
        // Keep production sender/owner/session read errors. Supported/version/live
        // results are deliberately synthetic: this is not capability acceptance.
        // Never invoke the real challenge or disconnect operation.
        await handler(event, { operation: "bridge-status", sessionId: input.sessionId });
        const state = bridgeState();
        if (input.operation === "bridge-status") return statusFor(state);
        if (input.operation === "bridge-disconnect") {
          saveState({ owner, mode: "unconnected", revision: (state.revision ?? 0) + 1 });
          return { disconnected: true };
        }
        assert.notEqual(state.mode, "unsupported", "platform-unsupported");
        const expiresAt = new Date(Date.now() + 120_000).toISOString();
        saveState({
          owner,
          mode: "waiting",
          revision: (state.revision ?? 0) + 1,
          expiresAt,
          hasBinding: hasBinding(state),
          // Creating a challenge does not establish or replace a terminal lease.
          connectionGeneration: connectionGeneration(state),
        });
        return {
          challenge: publicCode,
          expiresAt,
          instructions: `/agentkib-connect ${publicCode}`,
        };
      }
    }
    if (channel === "agentkib:account:request" && args[0]?.operation !== "status")
      throw new Error("Synthetic visual QA never logs in or changes accounts");
    if (
      [
        "agentkib:shell:open-external",
        "agentkib:shell:open-directory",
        "agentkib:shell:open-files-and-folders-settings",
        "agentkib:shell:open-quota-dashboard",
      ].includes(channel)
    )
      throw new Error("Synthetic visual QA blocks external UI actions");
    if (
      channel === "agentkib:remote:request" &&
      !["status", "discover"].includes(args[0]?.operation)
    )
      throw new Error("Synthetic visual QA does not pair or share computers");
    // B2 may pair one local read-only test browser. Keep control grants and all
    // configuration/remote mutations blocked; the real handler owns the code.
    if (
      channel === "agentkib:web:request" &&
      args[0]?.operation !== "status" &&
      !(args[0]?.operation === "generate-code" && args[0]?.access === "read")
    )
      throw new Error("Synthetic visual QA does not change remote access");
    if (channel === "agentkib:conversation:request") {
      const route = typeof args[0] === "string" ? args[0].replace(/^\//, "").split("?")[0] : "";
      if (args[1] !== undefined && !route.startsWith("history/"))
        throw new Error("Synthetic visual QA blocks conversation mutations");
    }
    const result = await handler(event, ...args);
    if (channel === "agentkib:account:request") return { phase: "signed-out", secureStorage: true };
    if (channel === "agentkib:web:request" && result && typeof result === "object")
      return {
        ...result,
        addresses: [{ name: "Example Wi-Fi", address: "192.0.2.10" }],
        localUrl: `http://127.0.0.1:${config.webPort}`,
        connectionUrl: undefined,
      };
    if (channel === "agentkib:conversation:request" && result?.status === 200) {
      const route = new URL(args[0], "http://127.0.0.1");
      if (
        route.pathname.replace(/^\//, "") === "live" &&
        route.searchParams.get("sessionId") === config.sessionId
      )
        return { ...result, body: liveFor(result.body) };
    }
    if (channel === "agentkib:conversation:subscribe" && args[0] === config.sessionId)
      return { ...result, events: result.events.map(streamEvent) };
    return result;
  });
shell.openExternal = async () => {
  throw new Error("Synthetic visual QA blocks external navigation");
};
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed =
        ["app:", "file:", "data:", "devtools:"].includes(url.protocol) ||
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    } catch {}
    callback({ cancel: !allowed });
  });
});
require(path.join(config.repository, "apps/desktop/dist-electron/main.cjs"));
