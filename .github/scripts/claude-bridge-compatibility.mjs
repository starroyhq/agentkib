import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_BRIDGE_COMPATIBILITY,
  CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
} from "../../packages/claude-bridge-plugin/hooks/compatibility.js";

const repository = path.resolve(import.meta.dirname, "../..");
const registry = "https://registry.npmjs.org";
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

/** No inherited account/provider variables, npm configuration, or user directories. */
export function compatibilityEnvironment(root, nodeDirectory = path.dirname(process.execPath)) {
  return {
    PATH: `${nodeDirectory}:${systemPath}`,
    HOME: path.join(root, "home"),
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    AGENTKIB_HOME: path.join(root, "library"),
    AGENTKIB_BENCHMARK_DATA_DIR: path.join(root, "data"),
    AGENTKIB_BENCHMARK_USER_DATA: path.join(root, "profile"),
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(root, "global-npmrc"),
    NPM_CONFIG_REGISTRY: registry,
    TMPDIR: path.join(root, "tmp"),
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

export function requestedVersion(value) {
  if (value === "minimum") return CLAUDE_BRIDGE_COMPATIBILITY.minimumCliVersion;
  if (value === "latest" || /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value))
    return value;
  throw new Error("invalid-version-selector");
}

export function sandboxPolicy({ sourceDirectory, nodeDirectory } = {}) {
  // CLI checks have no network at all. Bridge regressions only use private Unix
  // sockets/loopback and may read the checkout and the selected Node runtime.
  const ancestors = new Set();
  for (const directory of [sourceDirectory, nodeDirectory].filter(Boolean)) {
    for (
      let parent = path.dirname(directory);
      parent !== path.dirname(parent);
      parent = path.dirname(parent)
    )
      ancestors.add(parent);
  }
  const checkoutAccess = sourceDirectory
    ? `(allow file-read* file-write* (subpath ${JSON.stringify(sourceDirectory)}))\n` +
      `(allow file-read* (subpath ${JSON.stringify(nodeDirectory)}))\n` +
      // Node's realpath loader stats ancestors. Metadata access does not permit
      // opening their contents or any sibling personal configuration.
      [...ancestors]
        .map((directory) => `(allow file-read-metadata (literal ${JSON.stringify(directory)}))\n`)
        .join("")
    : "";
  const bridgeNetwork = sourceDirectory
    ? '(allow network-bind (local ip "localhost:*"))\n' +
      '(allow network-inbound (local ip "localhost:*"))\n' +
      '(allow network-outbound (remote ip "localhost:*"))\n' +
      "(allow network* (local unix-socket))\n(allow network* (remote unix-socket))\n"
    : "";
  return (
    "(version 1)\n(allow default)\n(deny network*)\n" +
    bridgeNetwork +
    '(deny file-read* file-write* (subpath "/Users") (subpath "/System/Volumes/Data/Users") (subpath "/Volumes") (subpath "/Library/Keychains"))\n' +
    checkoutAccess +
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))\n'
  );
}

/** Never forward terminal output: it may contain paths or an accidental secret. */
export function failureSummary(label, result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const nativeNames = {
    "session-identity": ["session.id", "session.cwd", "session.version"],
    "session-messages": ["session.messages"],
    "session-usage": ["session.usage"],
    "credential-store": ["store.get", "store.set"],
    "credential-read": ["fs.read", "plugin.root"],
  };
  const capabilities = CLAUDE_BRIDGE_REQUIRED_CAPABILITIES.filter((name) =>
    [name, ...(nativeNames[name] ?? [])].some((value) => output.includes(value)),
  );
  return {
    check: label,
    result: "failed",
    exitCode: Number.isInteger(result.status) ? result.status : null,
    timedOut: result.error?.code === "ETIMEDOUT",
    capabilities,
  };
}

export function pluginTestSummary(output) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const passed = Number(/^\s*(\d+) pass\s*$/m.exec(clean)?.[1] ?? 0);
  const failed = Number(/^\s*(\d+) fail\s*$/m.exec(clean)?.[1] ?? -1);
  const probes = [
    "required readonly capabilities use explicit safe calls and preserve the observed CLI version",
    "missing session-messages is reported without accepting a compatible version alone",
  ].every((name) => clean.includes(`(pass) ${name}`));
  if (!probes || passed < 7 || failed !== 0)
    throw new Error("capability-contract-tests-not-confirmed");
  return { passed, failed, capabilityProbeCases: 2 };
}

export function bridgeTestSummary(output) {
  const clean = output.replace(/\u001b\[[0-9;]*m/g, "");
  const files = Number(/Test Files\s+(\d+) passed/.exec(clean)?.[1] ?? 0);
  const passed = Number(/Tests\s+(\d+) passed/.exec(clean)?.[1] ?? 0);
  if (files !== 6 || passed === 0 || /(?:Test Files|Tests)[^\n]*\d+ failed/.test(clean))
    throw new Error("bridge-regression-tests-not-confirmed");
  return { files, passed };
}

function run(label, executable, args, options) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0 || result.error) {
    console.error(JSON.stringify(failureSummary(label, result)));
    throw new Error(`${label}-failed`);
  }
  console.log(JSON.stringify({ check: label, result: "passed" }));
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export function verifySandboxBoundaries(profile, options, bridge = false) {
  // Test-net is only used with the loopback-enabled profile: the deny rule
  // prevents the connection before any packet can leave the machine.
  const remote = bridge ? "203.0.113.1" : "127.0.0.1";
  for (const [label, code] of [
    [
      "network-barrier",
      `import socket,sys\ns=socket.socket()\ntry: s.connect(('${remote}',9))\nexcept PermissionError as e: sys.exit(0 if e.errno == 1 else 1)\nsys.exit(1)`,
    ],
    [
      "personal-directory-barrier",
      "import os,sys\ntry: os.listdir('/Users')\nexcept PermissionError as e: sys.exit(0 if e.errno == 1 else 1)\nsys.exit(1)",
    ],
  ])
    run(label, "/usr/bin/sandbox-exec", ["-f", profile, "/usr/bin/python3", "-c", code], options);
  if (bridge)
    run(
      "loopback-bind",
      "/usr/bin/sandbox-exec",
      [
        "-f",
        profile,
        "/usr/bin/python3",
        "-c",
        "import socket\ns=socket.socket()\ns.bind(('127.0.0.1',0))\ns.listen(1)\ns.close()",
      ],
      options,
    );
}

export async function checkCompatibility({ version = "latest", cli, bridgeTests = true } = {}) {
  if (process.platform !== "darwin") throw new Error("compatibility-check-requires-macos");
  const selected = requestedVersion(version);
  // /private/tmp keeps native commands outside the blocked personal directory,
  // including on hosted macOS runners whose checkout/toolcache is under /Users.
  const root = await mkdtemp("/private/tmp/agentkib-bridge-compatibility-");
  const environment = compatibilityEnvironment(root);
  try {
    for (const directory of [
      "home",
      "codex",
      "claude",
      "library",
      "data",
      "profile",
      "npm-cache",
      "tmp",
      "workspace",
    ])
      await mkdir(path.join(root, directory), { mode: 0o700 });
    for (const file of ["npmrc", "global-npmrc"])
      await writeFile(path.join(root, file), "manage-package-manager-versions=false\n", {
        mode: 0o600,
      });
    const options = { env: environment, cwd: path.join(root, "workspace"), timeout: 45_000 };
    let executable = cli;
    if (!executable) {
      run(
        "install-official-cli",
        path.join(path.dirname(process.execPath), "npm"),
        [
          "install",
          "--prefix",
          path.join(root, "prefix"),
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry",
          registry,
          `@anthropic-ai/claude-code@${selected}`,
        ],
        { ...options, timeout: 180_000 },
      );
      executable = path.join(
        root,
        "prefix/node_modules/@anthropic-ai",
        `claude-code-darwin-${process.arch}`,
        "claude",
      );
    }
    executable = await realpath(executable);
    // Local reuse is supported only from the same non-personal area as installs.
    if (!executable.startsWith("/private/tmp/") && !executable.startsWith("/tmp/"))
      throw new Error("cli-must-be-in-isolated-temporary-directory");
    const plugin = path.join(root, "plugin");
    await cp(path.join(repository, "packages/claude-bridge-plugin"), plugin, { recursive: true });
    const profile = path.join(root, "cli.sb");
    await writeFile(profile, sandboxPolicy(), { mode: 0o600 });
    const sandbox = (label, args) =>
      run(label, "/usr/bin/sandbox-exec", ["-f", profile, ...args], options);
    // Fail closed if the sandbox does not enforce either boundary. These
    // probes never open a user file or connect to a remote endpoint.
    verifySandboxBoundaries(profile, options);
    const versionOutput = sandbox("cli-version", [executable, "--version"]);
    const observed = /^\s*(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(versionOutput)?.[1];
    if (!observed || (selected !== "latest" && observed !== selected))
      throw new Error("installed-cli-version-mismatch");
    console.log(JSON.stringify({ check: "observed-cli-version", version: observed }));
    sandbox("plugin-validate-strict", [executable, "plugin", "validate", plugin, "--strict"]);
    const pluginTests = sandbox("plugin-test-and-capability-contract", [
      executable,
      "plugin",
      "test",
      plugin,
    ]);
    console.log(JSON.stringify({ check: "plugin-test-counts", ...pluginTestSummary(pluginTests) }));
    console.log(
      JSON.stringify({
        check: "capability-probe-scope",
        engine: "official-cli-plugin-engine",
        host: "synthetic-test-host",
        requiredCapabilities: CLAUDE_BRIDGE_REQUIRED_CAPABILITIES,
        realTerminalPairing: "not-covered",
        modelRequests: 0,
      }),
    );
    if (bridgeTests) {
      const bridgeProfile = path.join(root, "bridge.sb");
      const nodeDirectory = path.dirname(await realpath(process.execPath));
      await writeFile(
        bridgeProfile,
        sandboxPolicy({ sourceDirectory: repository, nodeDirectory }),
        { mode: 0o600 },
      );
      verifySandboxBoundaries(bridgeProfile, options, true);
      const bridgeOutput = run(
        "bridge-security-regressions",
        "/usr/bin/sandbox-exec",
        [
          "-f",
          bridgeProfile,
          process.execPath,
          path.join(repository, "apps/desktop/node_modules/vitest/vitest.mjs"),
          "run",
          "test/claude-bridge-plugin.test.ts",
          "test/claude-bridge-capability-contract.test.ts",
          "test/claude-bridge-compatibility.test.ts",
          "test/claude-bridge.test.ts",
          "test/claude-bridge-runtime.test.ts",
          "test/claude-bridge-auto-continue.test.ts",
        ],
        { ...options, cwd: path.join(repository, "apps/desktop"), timeout: 120_000 },
      );
      console.log(
        JSON.stringify({ check: "bridge-test-counts", ...bridgeTestSummary(bridgeOutput) }),
      );
    }
    return { version: observed, requiredCapabilities: CLAUDE_BRIDGE_REQUIRED_CAPABILITIES };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--version" && args[index + 1]) options.version = args[++index];
      else if (args[index] === "--cli" && args[index + 1]) options.cli = args[++index];
      else if (args[index] === "--skip-bridge-tests") options.bridgeTests = false;
      else throw new Error("invalid-compatibility-check-argument");
    }
    await checkCompatibility(options);
  } catch (error) {
    // Our errors contain fixed labels only, never raw child output or paths.
    const message =
      error instanceof Error && /^[a-z-]+$/.test(error.message)
        ? error.message
        : "compatibility-check-failed";
    console.error(JSON.stringify({ result: "failed", reason: message }));
    process.exitCode = 1;
  }
}
