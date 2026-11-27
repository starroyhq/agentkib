import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { selectReleaseCollectors } from "./select-release-collectors.mjs";

const repository = { full_name: "starroyhq/agentkib", id: 200 };
const workflow = ".github/workflows/release-desktop.yml";
const apiUrl = "https://api.github.test";
const now = () => Date.parse("2026-11-28T00:00:00Z");
const runId = 100;
const targets = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
];

let directory;
let released;
let selected;
let changedRecipe;
let unrelated;

before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "agentkib-select-collectors-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8", timeout: 2_000 }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Release Fixture");
  git("config", "user.email", "release-fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgSign", "false");
  for (const name of [
    ".gitattributes",
    ".github/workflows/quota-collector.yml",
    "apps/desktop/resources/quota/manifest.json",
    "apps/desktop/scripts/prepare-quota-sidecar.mjs",
    "apps/desktop/scripts/quota-collector/lock.json",
    "apps/desktop/scripts/stage-electron-quota.mjs",
  ]) {
    const file = path.join(directory, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, name);
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "published release");
  released = git("rev-parse", "HEAD");
  git("tag", "-a", "v0.36.2", "-m", "release");
  unrelated = git("commit-tree", "HEAD^{tree}", "-m", "no parents");
  git("tag", "v0.36.1", unrelated);
  git("commit", "--quiet", "--allow-empty", "-m", "new app changes");
  selected = git("rev-parse", "HEAD");
  await writeFile(
    path.join(directory, "apps/desktop/scripts/quota-collector/lock.json"),
    "new lock",
  );
  git("commit", "--quiet", "-am", "collector update");
  changedRecipe = git("rev-parse", "HEAD");
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const run = {
    id: runId,
    run_attempt: 2,
    path: workflow,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "v0.36.2",
    head_sha: released,
    repository,
    head_repository: repository,
  };
  const jobs = [
    {
      name: "Publish GitHub Release",
      run_id: runId,
      run_attempt: 2,
      head_sha: released,
      status: "completed",
      conclusion: "success",
    },
  ];
  const artifacts = targets.map((target, index) => ({
    id: 300 + index,
    name: `quota-collector-${target}`,
    digest: `sha256:${"a".repeat(64)}`,
    expired: false,
    expires_at: "2026-12-04T00:00:00Z",
    workflow_run: {
      id: runId,
      repository_id: repository.id,
      head_repository_id: repository.id,
      head_branch: run.head_branch,
      head_sha: released,
    },
  }));
  const calls = [];
  const request = async (address, options) => {
    const { origin, pathname } = new URL(address);
    assert.equal(origin, apiUrl);
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(pathname.startsWith(`/repos/${repository.full_name}/actions/`));
    const route = pathname.split("/actions/")[1];
    calls.push(route);
    const responses = {
      "workflows/release-desktop.yml/runs": { workflow_runs: [run] },
      [`runs/${runId}/attempts/2/jobs`]: { total_count: jobs.length, jobs },
      [`runs/${runId}/artifacts`]: { total_count: artifacts.length, artifacts },
    };
    return Response.json(responses[route] ?? {}, { status: route in responses ? 200 : 404 });
  };
  return { run, jobs, artifacts, calls, request };
}

function select(request, releaseSha = selected) {
  return selectReleaseCollectors({
    releaseSha,
    repository: repository.full_name,
    apiUrl,
    token: "fake-token",
    cwd: directory,
    request,
    now,
  });
}

test("selects the verified release for its own revision or an unchanged descendant", async () => {
  for (const sha of [released, selected]) {
    const { request, calls } = fixture();
    assert.equal(await select(request, sha), runId);
    assert.deepEqual(calls, [
      "workflows/release-desktop.yml/runs",
      `runs/${runId}/attempts/2/jobs`,
      `runs/${runId}/artifacts`,
    ]);
  }
});

test("skips non-push, fork, non-tag, mismatched tag, divergent or changed inputs", async () => {
  for (const override of [
    { event: "workflow_dispatch" },
    { head_repository: { ...repository, id: 999 } },
    { head_branch: "main" },
    { head_sha: selected },
    { head_branch: "v0.36.1", head_sha: unrelated },
  ]) {
    const { request, calls, run } = fixture();
    Object.assign(run, override);
    assert.equal(await select(request), undefined);
    assert.deepEqual(calls, ["workflows/release-desktop.yml/runs"]);
  }
  const { request, calls } = fixture();
  assert.equal(await select(request, changedRecipe), undefined);
  assert.deepEqual(calls, ["workflows/release-desktop.yml/runs"]);
});

test("falls back when the publish job or any exact collector fails verification", async () => {
  for (const invalidate of [
    ({ jobs }) => jobs.pop(),
    ({ jobs }) => (jobs[0].conclusion = "skipped"),
    ({ artifacts }) => artifacts.pop(),
    ({ artifacts }) => artifacts.push({ ...artifacts[0], id: 999 }),
    ({ artifacts }) => (artifacts[0].expired = true),
    ({ artifacts }) => (artifacts[0].expires_at = "2026-11-27T00:00:00Z"),
    ({ artifacts }) => (artifacts[0].expires_at = "2026-11-28T00:59:59Z"),
    ({ artifacts }) => (artifacts[0].digest = null),
    ({ artifacts }) => (artifacts[0].workflow_run.head_sha = unrelated),
  ]) {
    const data = fixture();
    invalidate(data);
    assert.equal(await select(data.request), undefined);
  }
});

test("falls back on API failure and writes the empty output for unavailable metadata", async () => {
  assert.equal(await select(async () => new Response(null, { status: 503 })), undefined);
  const output = path.join(directory, "output");
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./select-release-collectors.mjs", import.meta.url))],
    { cwd: directory, env: { GITHUB_OUTPUT: output }, timeout: 2_000 },
  );
  assert.equal(await readFile(output, "utf8"), "collector_run_id=\n");
});
