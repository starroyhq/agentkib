import { spawnSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const collectorInputs = [
  ".gitattributes",
  ".github/workflows/quota-collector.yml",
  "apps/desktop/resources/quota",
  "apps/desktop/scripts/prepare-quota-sidecar.mjs",
  "apps/desktop/scripts/quota-collector",
  "apps/desktop/scripts/stage-electron-quota.mjs",
];

const collectorArtifacts = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-pc-windows-msvc",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
].map((target) => `quota-collector-${target}`);

const releaseWorkflow = ".github/workflows/release-desktop.yml";
const versionTag = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const commitSha = /^[a-f0-9]{40}$/;
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const pageSize = 100;
const runLimit = 12;

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2_000 });
  return result.status === 0 ? result.stdout : undefined;
}

function inputTree(sha, cwd) {
  const tree = git(["ls-tree", "--full-tree", "-z", sha, "--", ...collectorInputs], cwd);
  return tree?.split("\0").filter(Boolean).length === collectorInputs.length ? tree : undefined;
}

function trustedRun(run, repository, releaseSha, selectedTree, cwd) {
  if (
    !positiveId(run?.id) ||
    !positiveId(run.run_attempt) ||
    run.path !== releaseWorkflow ||
    run.event !== "push" ||
    run.status !== "completed" ||
    run.conclusion !== "success" ||
    run.repository?.full_name !== repository ||
    !positiveId(run.repository.id) ||
    run.head_repository?.full_name !== repository ||
    run.head_repository.id !== run.repository.id ||
    !versionTag.test(run.head_branch ?? "") ||
    !commitSha.test(run.head_sha ?? "")
  )
    return false;

  const { head_branch: tag, head_sha: sha } = run;
  if (git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], cwd)?.trim() !== sha)
    return false;
  if (git(["merge-base", "--is-ancestor", sha, releaseSha], cwd) === undefined) return false;
  return inputTree(sha, cwd) === selectedTree;
}

function completePage(response, key) {
  const rows = response?.[key];
  return Array.isArray(rows) && rows.length === response.total_count ? rows : [];
}

function verifiedPublish(response, run) {
  const jobs = completePage(response, "jobs").filter(
    (job) => job?.name === "Publish GitHub Release",
  );
  return (
    jobs.length === 1 &&
    jobs[0].run_id === run.id &&
    jobs[0].run_attempt === run.run_attempt &&
    jobs[0].head_sha === run.head_sha &&
    jobs[0].status === "completed" &&
    jobs[0].conclusion === "success"
  );
}

function verifiedArtifacts(response, run, now) {
  const artifacts = completePage(response, "artifacts");
  return collectorArtifacts.every((name) => {
    const matches = artifacts.filter((artifact) => artifact?.name === name);
    if (matches.length !== 1) return false;
    const [artifact] = matches;
    const source = artifact.workflow_run;
    return (
      positiveId(artifact.id) &&
      artifact.expired === false &&
      Date.parse(artifact.expires_at) > now &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") &&
      source?.id === run.id &&
      source.repository_id === run.repository.id &&
      source.head_repository_id === run.repository.id &&
      source.head_branch === run.head_branch &&
      source.head_sha === run.head_sha
    );
  });
}

export async function selectReleaseCollectors({
  releaseSha,
  repository,
  apiUrl,
  token,
  cwd,
  request = fetch,
  now = Date.now,
}) {
  if (!commitSha.test(releaseSha ?? "") || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !token)
    return;
  const selectedTree = inputTree(releaseSha, cwd);
  if (!selectedTree) return;

  try {
    const api = new URL(apiUrl);
    if (api.protocol !== "https:" || api.username || api.password || api.search || api.hash) return;
    const repoUrl = `${api.href.replace(/\/$/, "")}/repos/${repository}`;
    const deadline = AbortSignal.timeout(18_000);
    const get = async (route) => {
      const response = await request(`${repoUrl}/${route}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.any([deadline, AbortSignal.timeout(4_000)]),
      });
      if (!response.ok) throw new Error("GitHub Actions metadata unavailable");
      return response.json();
    };

    const { workflow_runs: runs } = await get(
      `actions/workflows/release-desktop.yml/runs?event=push&status=success&per_page=${runLimit}`,
    );
    if (!Array.isArray(runs)) return;
    for (const run of runs.slice(0, runLimit)) {
      if (deadline.aborted) return;
      if (!trustedRun(run, repository, releaseSha, selectedTree, cwd)) continue;
      const path = `actions/runs/${run.id}`;
      const [jobs, artifacts] = await Promise.all([
        get(`${path}/attempts/${run.run_attempt}/jobs?per_page=${pageSize}`),
        get(`${path}/artifacts?per_page=${pageSize}`),
      ]);
      if (verifiedPublish(jobs, run) && verifiedArtifacts(artifacts, run, now())) return run.id;
    }
  } catch {
    // Selection is optional. A failed or ambiguous lookup leaves the full build enabled.
  }
}

async function main() {
  const env = process.env;
  const runId = await selectReleaseCollectors({
    releaseSha: env.RELEASE_SHA,
    repository: env.GITHUB_REPOSITORY,
    apiUrl: env.GITHUB_API_URL,
    token: env.GH_TOKEN,
  });
  await appendFile(env.GITHUB_OUTPUT, `collector_run_id=${runId ?? ""}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
