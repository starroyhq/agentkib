import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CODEX_PROTOCOL_CONTRACT,
  compatibilityEnvironment,
  contractFor,
  installedBinary,
  minimumVersion,
  protocolGaps,
  requestedVersion,
  sandboxPolicy,
} from "./codex-protocol-compatibility.mjs";

const variants = (methods) => ({
  oneOf: methods.map((method) => ({ properties: { method: { enum: [method] } } })),
});
const all = (key) => [
  ...CODEX_PROTOCOL_CONTRACT.required[key],
  ...CODEX_PROTOCOL_CONTRACT.current[key],
];
/** A schema directory laid out like `generate-json-schema --experimental` writes it. */
async function schemaDirectory({ drop = {}, renameField } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "agentkib-codex-schema-"));
  await mkdir(path.join(directory, "v2"));
  const files = {
    ClientRequest: variants(all("clientRequests").filter((name) => name !== drop.method)),
    ServerRequest: variants(all("serverRequests")),
    ServerNotification: variants(all("serverNotifications")),
  };
  for (const [name, value] of Object.entries(files))
    await writeFile(path.join(directory, `${name}.json`), JSON.stringify(value));
  const types = {};
  for (const contract of [CODEX_PROTOCOL_CONTRACT.required, CODEX_PROTOCOL_CONTRACT.current])
    for (const [type, names] of Object.entries(contract.properties))
      types[type] = [...(types[type] ?? []), ...names];
  for (const [type, names] of Object.entries(types)) {
    if (type === drop.type) continue;
    const properties = Object.fromEntries(
      names.map((name) => [name === renameField ? `${name}Renamed` : name, {}]),
    );
    const schema = { properties };
    if (type === "CollaborationModeListResponse")
      schema.definitions = { ModeKind: { enum: drop.mode ? ["default"] : ["plan", "default"] } };
    // Server-request types sit at the top; v2 API types in v2/.
    const folder = type.startsWith("McpServer") ? directory : path.join(directory, "v2");
    await writeFile(path.join(folder, `${type}.json`), JSON.stringify(schema));
  }
  return directory;
}

test("a schema with the whole contract has no gaps", async () => {
  const directory = await schemaDirectory();
  try {
    assert.deepEqual(await protocolGaps(directory, contractFor("latest")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing methods, types, fields and Plan's mode are reported by fixed labels", async () => {
  const cases = [
    [
      { drop: { method: "thread/compact/start" } },
      "missing-method:ClientRequest:thread/compact/start",
    ],
    [{ drop: { type: "ErrorNotification" } }, "missing-schema:ErrorNotification"],
    [{ renameField: "expectedTurnId" }, "missing-field:TurnSteerParams.expectedTurnId"],
    [{ drop: { mode: true } }, "missing-value:CollaborationModeListResponse.ModeKind:plan"],
  ];
  for (const [options, gap] of cases) {
    const directory = await schemaDirectory(options);
    try {
      assert.deepEqual(await protocolGaps(directory, contractFor("latest")), [gap]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("the minimum version is held to what every supported CLI offers", async () => {
  // Plan is probed and MCP requests come only from CLIs that send them; queued messages are
  // probed too, because 0.147.0 has no thread/queue (0.148.0 adds it).
  const directory = await schemaDirectory({ drop: { method: "collaborationMode/list" } });
  try {
    assert.deepEqual(await protocolGaps(directory, contractFor("minimum")), []);
    assert.deepEqual(await protocolGaps(directory, contractFor("latest")), [
      "missing-method:ClientRequest:collaborationMode/list",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  for (const method of ["thread/queue/add", "thread/queue/list", "collaborationMode/list"])
    assert.ok(!CODEX_PROTOCOL_CONTRACT.required.clientRequests.includes(method), method);
  for (const method of ["thread/compact/start", "thread/backgroundTerminals/clean", "turn/start"])
    assert.ok(CODEX_PROTOCOL_CONTRACT.required.clientRequests.includes(method), method);
});

test("versions come from the backend's minimum or an exact release", async () => {
  const source = await readFile(
    new URL("../../packages/backend/src/codex-runtime-preflight.ts", import.meta.url),
    "utf8",
  );
  const minimum = /MINIMUM_CODEX_WRITER_VERSION = "([^"]+)"/.exec(source)[1];
  assert.equal(await minimumVersion(), minimum);
  assert.equal(await requestedVersion("minimum"), minimum);
  assert.equal(await requestedVersion("latest"), "latest");
  assert.equal(await requestedVersion("0.163.0"), "0.163.0");
  for (const value of ["0.163", "v0.163.0", "0.163.0 --global", "latest;rm"])
    await assert.rejects(requestedVersion(value), /invalid-version-selector/);
});

test("the CLI runs without the network, personal directories or inherited accounts", () => {
  const policy = sandboxPolicy();
  assert.match(policy, /\(deny network\*\)/);
  assert.match(policy, /\(subpath "\/Users"\)/);
  assert.doesNotMatch(policy, /allow network/);
  // The script runs on macOS only; its tests also run in the Linux and Windows helper jobs.
  const environment = compatibilityEnvironment("/private/tmp/root");
  assert.equal(environment.CODEX_HOME, path.join("/private/tmp/root", "codex"));
  assert.equal(environment.HOME, path.join("/private/tmp/root", "home"));
  for (const key of Object.keys(environment)) assert.ok(!/API_KEY|TOKEN|OPENAI/.test(key), key);
});

test("finds the native binary in the platform package", async () => {
  const prefix = await mkdtemp(path.join(tmpdir(), "agentkib-codex-prefix-"));
  try {
    const binary = path.join(
      prefix,
      "node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    );
    await mkdir(path.dirname(binary), { recursive: true });
    await writeFile(binary, "");
    // Temporary directories sit behind a link on macOS and a short name on Windows runners.
    assert.equal(await installedBinary(prefix, "arm64"), await realpath(binary));
    await assert.rejects(installedBinary(prefix, "x64"), /installed-cli-binary-not-found/);
  } finally {
    await rm(prefix, { recursive: true, force: true });
  }
});

test("the workflow checks both ends daily and on protocol changes, read-only", async () => {
  // Windows checkouts may convert line endings.
  const workflow = (
    await readFile(
      new URL("../workflows/codex-protocol-compatibility.yml", import.meta.url),
      "utf8",
    )
  ).replaceAll("\r\n", "\n");
  assert.match(workflow, /cron: "47 4 \* \* \*"/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /version: \[minimum, latest\]/);
  assert.match(workflow, /permissions:\n {2}contents: read/);
  assert.match(workflow, /node --test \.github\/scripts\/codex-protocol-compatibility\.test\.mjs/);
  for (const watched of [
    ".github/scripts/codex-protocol-compatibility*.mjs",
    "packages/backend/src/managed-codex-state.ts",
    "packages/backend/src/web-read.ts",
    "packages/backend/src/codex-runtime-preflight.ts",
  ])
    assert.ok(workflow.includes(`- ${watched}`), watched);
});
