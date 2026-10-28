import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Checks that an official Codex CLI still offers the app-server protocol AgentKib's managed
 * sessions use. The CLI writes its own JSON Schema (`app-server generate-json-schema
 * --experimental`); nothing logs in, starts a session or reaches a model.
 */
const repository = path.resolve(import.meta.dirname, "../..");
const registry = "https://registry.npmjs.org";
const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * What packages/backend calls, handles and reads. `required` holds for every supported CLI,
 * from MINIMUM_CODEX_WRITER_VERSION on; `current` adds what newer features use, which degrade
 * without it (Plan and queued messages are probed, MCP requests only arrive from CLIs that send
 * them), so it is checked against the latest release only.
 */
export const CODEX_PROTOCOL_CONTRACT = {
  required: {
    clientRequests: [
      "initialize",
      "model/list",
      "skills/list",
      "thread/start",
      "thread/resume",
      "thread/fork",
      "thread/read",
      "thread/archive",
      "thread/unarchive",
      "thread/name/set",
      "thread/goal/get",
      "thread/goal/set",
      "thread/goal/clear",
      "thread/compact/start",
      "thread/backgroundTerminals/clean",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ],
    serverRequests: [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/tool/requestUserInput",
    ],
    serverNotifications: [
      "thread/started",
      "thread/status/changed",
      "thread/tokenUsage/updated",
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "serverRequest/resolved",
      "error",
    ],
    properties: {
      TurnStartParams: [
        "threadId",
        "input",
        "cwd",
        "model",
        "effort",
        "serviceTier",
        "approvalPolicy",
        "approvalsReviewer",
        "sandboxPolicy",
      ],
      TurnSteerParams: ["threadId", "expectedTurnId", "input"],
      ThreadCompactStartParams: ["threadId"],
      ThreadBackgroundTerminalsCleanParams: ["threadId"],
      ErrorNotification: ["error", "threadId", "turnId", "willRetry"],
    },
    enums: [],
  },
  current: {
    clientRequests: [
      "collaborationMode/list",
      // 0.147.0 has no native queue; 0.148.0 adds it. The runner probes thread/queue/list.
      "thread/queue/list",
      "thread/queue/add",
      "thread/queue/update",
      "thread/queue/delete",
      "thread/queue/reorder",
    ],
    serverRequests: ["item/permissions/requestApproval", "mcpServer/elicitation/request"],
    serverNotifications: [
      "thread/settings/updated",
      "thread/goal/updated",
      "thread/goal/cleared",
      "item/plan/delta",
    ],
    properties: {
      TurnStartParams: ["clientUserMessageId", "collaborationMode"],
      ThreadQueueAddParams: ["threadId", "clientUserMessageId", "input"],
      ThreadResumeResponse: ["collaborationMode"],
      ThreadSettingsUpdatedNotification: ["threadId", "threadSettings"],
      McpServerElicitationRequestParams: ["serverName", "threadId", "turnId"],
      McpServerElicitationRequestResponse: ["action", "content", "_meta"],
      CollaborationModeListResponse: ["data"],
    },
    enums: [["CollaborationModeListResponse", "ModeKind", ["plan", "default"]]],
  },
};

/** The contract a version selector is checked against. */
export function contractFor(selector) {
  if (selector === "minimum") return [CODEX_PROTOCOL_CONTRACT.required];
  return [CODEX_PROTOCOL_CONTRACT.required, CODEX_PROTOCOL_CONTRACT.current];
}

export async function minimumVersion() {
  const source = await readFile(
    path.join(repository, "packages/backend/src/codex-runtime-preflight.ts"),
    "utf8",
  );
  const version = /MINIMUM_CODEX_WRITER_VERSION = "(\d+\.\d+\.\d+)"/.exec(source)?.[1];
  if (!version) throw new Error("minimum-version-unreadable");
  return version;
}

export async function requestedVersion(value) {
  if (value === "minimum") return minimumVersion();
  if (value === "latest" || /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value))
    return value;
  throw new Error("invalid-version-selector");
}

async function readSchema(directory, name) {
  for (const file of [
    path.join(directory, `${name}.json`),
    path.join(directory, "v2", `${name}.json`),
  ])
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  return null;
}

function methods(schema) {
  const variants = schema?.oneOf ?? schema?.anyOf ?? [];
  return new Set(
    variants.flatMap((variant) =>
      Array.isArray(variant?.properties?.method?.enum) ? variant.properties.method.enum : [],
    ),
  );
}

/** Every part of the contracts the generated schema directory lacks, as fixed labels. */
export async function protocolGaps(directory, contracts) {
  const gaps = [];
  for (const contract of contracts) {
    for (const [file, key] of [
      ["ClientRequest", "clientRequests"],
      ["ServerRequest", "serverRequests"],
      ["ServerNotification", "serverNotifications"],
    ]) {
      const schema = await readSchema(directory, file);
      if (!schema) {
        gaps.push(`missing-schema:${file}`);
        continue;
      }
      const listed = methods(schema);
      for (const method of contract[key])
        if (!listed.has(method)) gaps.push(`missing-method:${file}:${method}`);
    }
    for (const [type, names] of Object.entries(contract.properties)) {
      const schema = await readSchema(directory, type);
      if (!schema) {
        gaps.push(`missing-schema:${type}`);
        continue;
      }
      const properties = schema.properties ?? {};
      for (const name of names)
        if (!Object.hasOwn(properties, name)) gaps.push(`missing-field:${type}.${name}`);
    }
    for (const [type, definition, values] of contract.enums) {
      const schema = await readSchema(directory, type);
      const listed = schema?.definitions?.[definition]?.enum ?? [];
      for (const value of values)
        if (!listed.includes(value)) gaps.push(`missing-value:${type}.${definition}:${value}`);
    }
  }
  return [...new Set(gaps)];
}

/** No inherited account or provider variables, npm configuration, or user directories. */
export function compatibilityEnvironment(root) {
  return {
    PATH: `${path.dirname(process.execPath)}:${systemPath}`,
    HOME: path.join(root, "home"),
    CODEX_HOME: path.join(root, "codex"),
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    NPM_CONFIG_USERCONFIG: path.join(root, "npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(root, "global-npmrc"),
    NPM_CONFIG_REGISTRY: registry,
    TMPDIR: path.join(root, "tmp"),
    LC_ALL: "en_US.UTF-8",
    TERM: "dumb",
    CI: "1",
  };
}

/** Schema generation needs neither the network nor any personal directory. */
export function sandboxPolicy() {
  return (
    "(version 1)\n(allow default)\n(deny network*)\n" +
    '(deny file-read* file-write* (subpath "/Users") (subpath "/System/Volumes/Data/Users") (subpath "/Volumes") (subpath "/Library/Keychains"))\n' +
    '(deny mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc"))\n'
  );
}

/** The native binary of an installed `@openai/codex`, without the Node launcher. */
export async function installedBinary(prefix, arch = process.arch) {
  const target = arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const candidates = [
    // 0.147.0 and 0.163.0 ship the binary in the platform package.
    path.join(
      prefix,
      "node_modules/@openai",
      `codex-darwin-${arch}`,
      "vendor",
      target,
      "bin",
      "codex",
    ),
    path.join(prefix, "node_modules/@openai/codex/vendor", target, "bin", "codex"),
  ];
  for (const candidate of candidates)
    try {
      return await realpath(candidate);
    } catch {
      // Layouts differ between releases; try the next one.
    }
  // Fall back to a search inside the package directories only.
  for (const directory of [
    path.join(prefix, "node_modules/@openai", `codex-darwin-${arch}`),
    path.join(prefix, "node_modules/@openai/codex"),
  ]) {
    const found = await findFile(directory, "codex", 6);
    if (found) return realpath(found);
  }
  throw new Error("installed-cli-binary-not-found");
}

async function findFile(directory, name, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) {
      const found = await findFile(file, name, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

/** Never forward child output: it may contain paths. */
function run(label, executable, args, options) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0 || result.error) {
    console.error(
      JSON.stringify({
        check: label,
        result: "failed",
        exitCode: Number.isInteger(result.status) ? result.status : null,
        timedOut: result.error?.code === "ETIMEDOUT",
      }),
    );
    throw new Error(`${label}-failed`);
  }
  console.log(JSON.stringify({ check: label, result: "passed" }));
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

export async function checkCompatibility({ version = "latest", cli } = {}) {
  if (process.platform !== "darwin") throw new Error("compatibility-check-requires-macos");
  const selected = await requestedVersion(version);
  // /private/tmp keeps native commands outside the blocked personal directory.
  const root = await mkdtemp("/private/tmp/agentkib-codex-compatibility-");
  const environment = compatibilityEnvironment(root);
  try {
    for (const directory of ["home", "codex", "npm-cache", "tmp", "workspace", "schema"])
      await mkdir(path.join(root, directory), { mode: 0o700 });
    for (const file of ["npmrc", "global-npmrc"])
      await writeFile(path.join(root, file), "manage-package-manager-versions=false\n", {
        mode: 0o600,
      });
    const options = { env: environment, cwd: path.join(root, "workspace"), timeout: 60_000 };
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
          `@openai/codex@${selected}`,
        ],
        { ...options, timeout: 300_000 },
      );
      executable = await installedBinary(path.join(root, "prefix"));
    }
    executable = await realpath(executable);
    const profile = path.join(root, "cli.sb");
    await writeFile(profile, sandboxPolicy(), { mode: 0o600 });
    const sandbox = (label, args) =>
      run(label, "/usr/bin/sandbox-exec", ["-f", profile, executable, ...args], options);
    const versionOutput = sandbox("cli-version", ["--version"]);
    const observed = /codex-cli (\d+\.\d+\.\d+)/.exec(versionOutput)?.[1];
    if (!observed || (selected !== "latest" && observed !== selected))
      throw new Error("installed-cli-version-mismatch");
    console.log(JSON.stringify({ check: "observed-cli-version", version: observed }));
    const schema = path.join(root, "schema");
    sandbox("generate-json-schema", [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      schema,
    ]);
    const gaps = await protocolGaps(schema, contractFor(version));
    console.log(JSON.stringify({ check: "protocol-contract", version: observed, gaps }));
    if (gaps.length) throw new Error("protocol-contract-gaps");
    return { version: observed, gaps };
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
      else throw new Error("invalid-compatibility-check-argument");
    }
    await checkCompatibility(options);
  } catch (error) {
    // Our errors are fixed labels only, never child output or paths.
    const message =
      error instanceof Error && /^[a-z-]+$/.test(error.message)
        ? error.message
        : "compatibility-check-failed";
    console.error(JSON.stringify({ result: "failed", reason: message }));
    process.exitCode = 1;
  }
}
