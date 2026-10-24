// E2 finalization uses the existing real-backend sandbox and never substitutes IPC results.
// prepare does not launch anything; initialize must wait for the current worktree build.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const command = process.argv[2];
assert.ok(
  ["prepare", "initialize", "locale", "disk-conflict", "launch-config", "files"].includes(command),
);
const options = {};
for (let index = 3; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert.ok(["--root", "--electron", "--locale", "--cdp-port", "--workspace"].includes(key));
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"));
  options[key.slice(2)] = process.argv[index + 1];
}
const root = path
  .resolve(options.root ?? "/tmp/agentkib-v15-e2-finalize-qa")
  .replace(/^\/tmp\//, "/private/tmp/");
assert.match(root, /^\/private\/tmp\/agentkib-v15-e2-finalize-[a-z0-9-]+$/);
const configFile = path.join(root, "fixture-private.json");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const inheritedArgs = ["--root", root];
for (const name of ["electron", "locale", "cdp-port"])
  if (options[name]) inheritedArgs.push(`--${name}`, options[name]);
function existing(action) {
  const result = spawnSync(
    process.execPath,
    [path.join(repository, "qa/probes/v15-e2-sandbox.mjs"), action, ...inheritedArgs],
    {
      cwd: repository,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.status !== 0)
    throw new Error(result.stderr || result.stdout || `Sandbox ${action} failed`);
  process.stdout.write(result.stdout);
}
async function config() {
  for (const file of [root, configFile]) assert.ok(!(await lstat(file)).isSymbolicLink());
  const value = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(value.owner, "agentkib-v15-e2-sandbox");
  assert.equal(value.root, root);
  assert.equal(value.repository, repository);
  assert.equal(await realpath(root), root);
  assert.ok(value.paths.home.startsWith(`${root}/`));
  for (const directory of Object.values(value.paths))
    assert.ok((await realpath(directory)).startsWith(`${root}/`));
  return value;
}
async function noUi() {
  try {
    const record = JSON.parse(await readFile(path.join(root, "ui-owned-pid.json"), "utf8"));
    assert.ok(Number.isInteger(record.pid) && record.pid > 1);
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    assert.fail("Close the owned UI before changing fixture setup");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
function sanitize(value, home) {
  const sanitized = JSON.stringify(value).replaceAll(home, "~").replaceAll(root, "<owned-sandbox>");
  assert.doesNotMatch(sanitized, /\/Users\/|\/private\/tmp\/|192\.168\.|10\.0\.\d+\./);
  return JSON.parse(sanitized);
}
if (command === "prepare") {
  existing("prepare");
} else if (["locale", "launch-config"].includes(command)) {
  existing(command);
} else {
  const value = await config();
  const name = options.workspace ?? "northstar-api";
  assert.ok(value.workspaceNames.includes(name));
  const workspace = path.join(value.paths.home, "projects", name);
  assert.ok((await realpath(workspace)).startsWith(`${value.paths.home}/projects/`));
  const manifestFile = path.join(workspace, ".agentkib/manifest.yaml");
  if (command === "initialize") {
    await noUi();
    assert.equal(value.phase, "prepared");
    existing("discover");
    existing("ready");
    // ready legitimately completes onboarding through production APIs. Preserve its synthetic
    // prepared manifest as private fixture input, then remove it before the first UI process.
    // The acceptance scenario intentionally starts with no manifest on disk.
    const prepared = await readFile(path.join(value.workspace, ".agentkib/manifest.yaml"), "utf8");
    await writeFile(path.join(root, "prepared-manifest-private.yaml"), prepared, { mode: 0o600 });
    await unlink(path.join(value.workspace, ".agentkib/manifest.yaml"));
    console.log(
      json({
        initialized: true,
        firstAdoptionHasManifest: false,
        productionResultsReplaced: false,
      }),
    );
  } else if (command === "disk-conflict") {
    // Deliberate external write of synthetic disk input; the running UI performs the real reread.
    const require = createRequire(path.join(repository, "packages/backend/package.json"));
    const yaml = require("yaml");
    let content;
    let firstManifest = false;
    try {
      assert.ok(!(await lstat(manifestFile)).isSymbolicLink());
      content = await readFile(manifestFile, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      content = await readFile(path.join(root, "prepared-manifest-private.yaml"), "utf8");
      firstManifest = true;
    }
    const manifest = yaml.parse(content);
    const found = (await config()).workspaces.find((item) => item.path === workspace);
    assert.ok(found);
    manifest.workspace.id = found.id;
    manifest.workspace.name = name;
    if (firstManifest) {
      const instructionsFile = path.join(workspace, "AGENTS.md");
      assert.ok((await realpath(instructionsFile)).startsWith(`${workspace}/`));
      manifest.instructions.shared = await readFile(instructionsFile, "utf8");
    }
    manifest.instructions.shared += "\nExternal synthetic disk change\n";
    await mkdir(path.dirname(manifestFile), { recursive: true, mode: 0o700 });
    assert.ok((await realpath(path.dirname(manifestFile))).startsWith(`${workspace}/`));
    await writeFile(manifestFile, yaml.stringify(manifest), { mode: 0o600 });
    console.log(
      json({
        syntheticExternalManifestChange: true,
        workspace: name,
        productionResultsReplaced: false,
      }),
    );
  } else {
    const files = {};
    for (const relative of ["AGENTS.md", "CLAUDE.md", ".agentkib/manifest.yaml"]) {
      const file = path.join(workspace, relative);
      try {
        assert.ok(!(await lstat(file)).isSymbolicLink());
        assert.ok((await realpath(file)).startsWith(`${workspace}/`));
        files[relative] = await readFile(file, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        files[relative] = null;
      }
    }
    console.log(
      json(
        sanitize({ workspace: name, files, productionResultsReplaced: false }, value.paths.home),
      ),
    );
  }
}
