// C-only visual QA. Reuses B's build/seed/process lifecycle without changing B files.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { OWNER, MODES, validateState, BROKER } = require("./v15-c-fixtures.cjs");
process.umask(0o077);
const repository = fileURLToPath(new URL("../../", import.meta.url));
const baseProbe = path.join(repository, "qa/probes/v15-b-sandbox.mjs");
const command = process.argv[2];
assert.ok(
  ["prepare", "seed", "start", "stop", "state", "check", "cleanup"].includes(command),
  "Use prepare|seed|start|stop|state|check|cleanup",
);
const options = {};
for (let index = 3; index < process.argv.length; index += 2) {
  assert.ok(["--root", "--state", "--locale", "--cdp-port"].includes(process.argv[index]));
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  options[process.argv[index].slice(2)] = process.argv[index + 1];
}
const root = path
  .resolve(options.root ?? "/tmp/agentkib-v15-b-c-remote")
  .replace(/^\/tmp\//, "/private/tmp/");
assert.ok(
  /^\/private\/tmp\/agentkib-v15-b-c-[a-zA-Z0-9-]+$/.test(root),
  "Use a dedicated B-compatible C root",
);
const marker = path.join(root, "c-fixture-private.json");
const stateFile = path.join(root, "c-state-private.json");
const baseFile = path.join(root, "fixture-private.json");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function readOwned(file) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Unsafe sandbox file");
  assert.equal(info.uid, process.getuid());
  assert.ok(info.size < 64 * 1024);
  return JSON.parse(await readFile(file, "utf8"));
}
async function put(file, value) {
  assert.ok(file.startsWith(`${root}/`));
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporary, typeof value === "string" ? value : json(value), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, file);
}
async function owned() {
  const info = await lstat(root);
  assert.ok(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(info.uid, process.getuid());
  assert.equal(await realpath(root), root);
  const config = await readOwned(marker);
  const base = await readOwned(baseFile);
  assert.equal(config.owner, OWNER);
  assert.equal(config.root, root);
  assert.equal(config.repository, repository);
  assert.equal(config.stateFile, stateFile);
  assert.equal(base.owner, "agentkib-v15-b-sandbox");
  assert.equal(base.root, root);
  assert.equal(base.repository, repository);
  for (const name of ["home", "codex", "claude", "data", "profile", "library", "app"]) {
    assert.ok(base.paths[name].startsWith(`${root}/`));
    assert.ok((await realpath(base.paths[name])).startsWith(`${root}/`));
  }
  return { config, base };
}
function invokeBase(action, extra = []) {
  const result = spawnSync(process.execPath, [baseProbe, action, "--root", root, ...extra], {
    cwd: repository,
    stdio: "inherit",
  });
  assert.equal(result.error, undefined, "Base probe could not start");
  assert.equal(result.status, 0, "Base probe failed");
}
function processIdentity(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
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
async function running() {
  try {
    const processInfo = await readOwned(path.join(root, "owned-process.json"));
    assert.equal(typeof processInfo.identity, "string");
    return processIdentity(processInfo.pid) === processInfo.identity;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function assertDisabled(base) {
  for (const name of ["web", "web-lan"]) {
    const saved = await readOwned(path.join(base.paths.profile, name, "web-access.json"));
    assert.equal(saved.config.enabled, false, "Real remote listeners must remain disabled");
    assert.ok(!saved.config.relay?.enabled);
    assert.deepEqual(saved.credentials, []);
  }
}

if (command === "prepare") {
  // Never adopt or overwrite a pre-existing nonempty B sandbox.
  try {
    assert.deepEqual(await readdir(root), [], "Use a fresh C sandbox root");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const extra = [];
  if (options.locale) extra.push("--locale", options.locale);
  extra.push("--cdp-port", options["cdp-port"] ?? "19345");
  invokeBase("prepare", extra);
  const base = await readOwned(baseFile);
  assert.equal(base.owner, "agentkib-v15-b-sandbox");
  assert.equal(base.root, root);
  await put(marker, { owner: OWNER, root, repository, stateFile });
  await put(stateFile, { owner: OWNER, mode: "first-time", revision: 1 });
  await put(
    path.join(base.paths.app, "bootstrap.cjs"),
    `require(${JSON.stringify(path.join(repository, "qa/probes/v15-c-bootstrap.cjs"))});\n`,
  );
  await put(path.join(base.paths.profile, "web/web-access.json"), {
    config: {
      enabled: false,
      port: base.webPort,
      externalOrigin: "",
      experimentalEnabled: false,
      relay: { enabled: false, brokerUrl: BROKER },
    },
    credentials: [],
    remotePairingInitialized: false,
  });
  await put(path.join(base.paths.profile, "web-lan/web-access.json"), {
    config: {
      enabled: false,
      port: 1422,
      externalOrigin: "https://remote.agentkib.com",
      experimentalEnabled: false,
      lanAddress: "",
      allowPlaintext: false,
    },
    credentials: [],
    remotePairingInitialized: false,
  });
  // B uses os.homedir(); also protect the actual OS account home when the caller
  // already has a temporary HOME. These rules only name paths, never read them.
  const personalHome = os.userInfo().homedir;
  const directories = [
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
    ".gemini",
    ".ssh",
    ".aws",
    ".gnupg",
    ".kube",
    ".local/share/keyrings",
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
  ];
  const files = [
    ".claude.json",
    ".codex/auth.json",
    ".codex/config.toml",
    ".codex/history.jsonl",
    ".codex/session_index.jsonl",
    ".netrc",
    ".npmrc",
    ".git-credentials",
  ];
  const guards = [
    ...directories.map((name) => ["subpath", path.join(personalHome, name)]),
    ...files.map((name) => ["literal", path.join(personalHome, name)]),
  ]
    .map(
      ([kind, file]) =>
        `(deny file-read* (${kind} ${JSON.stringify(file)}))(deny file-write* (${kind} ${JSON.stringify(file)}))`,
    )
    .join("");
  assert.ok(
    !directories.some((name) => repository.startsWith(`${path.join(personalHome, name)}/`)),
    "Use a checkout outside protected personal data directories",
  );
  const network = await readFile(path.join(root, "network.sb"), "utf8");
  await put(
    path.join(root, "network.sb"),
    `${network}${guards}(deny mach-lookup (global-name "com.apple.securityd"))(deny mach-lookup (global-name "com.apple.securityd.xpc"))\n`,
  );
  await put(path.join(root, "c-inventory.json"), {
    fixture: "v15-c",
    owner: OWNER,
    syntheticOnly: true,
    accounts: "signed-out or synthetic example.invalid",
    modelRequests: 0,
    realRemoteListeners: 0,
    realAuthorizations: 0,
    publicTestCode: "12345678",
    displayInterface: "192.168.1.23",
    modes: MODES,
    isolation:
      "Six private roots, Seatbelt personal-path/securityd/non-loopback denial, mock keychain, external UI actions blocked.",
    validation:
      "Corresponding original IPC status read must succeed for the local main renderer before any fixture. Synthetic mutations never call their production mutation handlers.",
    limitations:
      "Visual fixtures only. No account, relay, credentials, pairing, network reachability or permission acceptance. Production backend MCP and CDP use local-only infrastructure ports; Web/LAN/native remote listeners stay disabled. --no-sandbox retains the outer OS guard but does not validate Chromium renderer isolation.",
  });
  console.log(
    json({ prepared: true, fixture: "v15-c", root, next: "Build desktop, seed, then start" }),
  );
} else {
  const { base } = await owned();
  if (command === "state") {
    assert.ok(MODES.includes(options.state), `Use --state ${MODES.join("|")}`);
    const current = validateState(await readOwned(stateFile));
    await put(stateFile, {
      owner: OWNER,
      mode: options.state,
      revision: (current.revision ?? 0) + 1,
      access: "full",
      expiresAt: Date.now() + 300_000,
    });
    console.log(json({ state: options.state, syntheticOnly: true, reloadRenderer: true }));
  } else if (command === "cleanup") {
    if (await running()) invokeBase("stop");
    assert.ok(!(await running()), "Stop the owned process before cleanup");
    await rm(root, { recursive: true });
    console.log(json({ cleaned: true, fixture: "v15-c" }));
  } else if (command === "check") {
    await assertDisabled(base);
    validateState(await readOwned(stateFile));
    console.log(json({ owned: true, realRemoteListeners: "disabled", running: await running() }));
  } else {
    if (["seed", "start"].includes(command)) {
      await assertDisabled(base);
      assert.ok(!(await running()), "Sandbox is already running");
    }
    invokeBase(
      command,
      command === "start" && options["cdp-port"] ? ["--cdp-port", options["cdp-port"]] : [],
    );
  }
}
