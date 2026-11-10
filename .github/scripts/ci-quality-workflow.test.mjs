import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const { parseDocument } = createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
)("yaml");

async function readYaml(relativePath) {
  const document = parseDocument(await readFile(new URL(relativePath, import.meta.url), "utf8"));
  assert.deepEqual(document.errors, []);
  return document.toJS();
}

function expression(value) {
  return value?.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "").trim();
}

function commands(job) {
  return job.steps.flatMap(
    (step) =>
      step.run
        ?.trim()
        .split("\n")
        .map((line) => line.trim()) ?? [],
  );
}

function checkout(job) {
  return job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
}

const branches = ["checks", "desktop", "safety", "web"];

test("quality keeps the required check and waits for scope and every quality branch", async () => {
  const workflow = await readYaml("../workflows/ci.yml");
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(workflow.on.pull_request.branches, ["main"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ["changes", ...branches, "quality"].sort());

  const gate = workflow.jobs.quality;
  assert.equal(gate.name, "Test, lint and build");
  assert.deepEqual([...gate.needs].sort(), ["changes", ...branches].sort());
  assert.equal(expression(gate.if), "always()");
  const aggregate = gate.steps.find(
    (step) => step.run?.trim() === "node .github/scripts/ci-quality.mjs gate",
  );
  assert.ok(aggregate);
  assert.equal(expression(aggregate.env?.CI_QUALITY_NEEDS), "toJSON(needs)");
  assert.equal(checkout(gate)?.with?.["persist-credentials"], false);

  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job["continue-on-error"], undefined);
    for (const step of job.steps) {
      assert.equal(step["continue-on-error"], undefined);
      assert.doesNotMatch(
        step.run ?? "",
        /\|\||\bretry\b|--(?:test-name-pattern|test-skip-pattern|passWithNoTests)\b/i,
      );
    }
  }
});

test("only a successful docs scope skips quality branches before dependency installation", async () => {
  const { jobs } = await readYaml("../workflows/ci.yml");
  const changes = jobs.changes;
  assert.equal(changes.needs, undefined);
  assert.equal(checkout(changes)?.with?.["fetch-depth"], 0);
  assert.equal(checkout(changes)?.with?.["persist-credentials"], false);
  const classify = changes.steps.find(
    (step) => step.run?.trim() === "node .github/scripts/ci-quality.mjs changes",
  );
  assert.ok(classify?.id);
  assert.equal(expression(changes.outputs.mode), `steps.${classify.id}.outputs.mode`);
  assert.equal(
    changes.steps.some((step) => step.uses === "./.github/actions/setup-quality"),
    false,
  );

  for (const name of branches) {
    const job = jobs[name];
    assert.deepEqual([job.needs].flat(), ["changes"]);
    // GitHub's implicit success() also prevents a failed scope from starting work.
    assert.equal(expression(job.if), "needs.changes.outputs.mode != 'docs'");
    assert.equal(job["runs-on"], "ubuntu-22.04");
    assert.equal(job["timeout-minutes"], 20);
    assert.equal(checkout(job)?.with?.["persist-credentials"], false);
    const setup = job.steps.filter((step) => step.uses === "./.github/actions/setup-quality");
    assert.equal(setup.length, 1);
    assert.equal(setup[0].with?.native ?? "false", name === "web" ? "false" : "true");
    assert.ok(job.steps.indexOf(checkout(job)) < job.steps.indexOf(setup[0]));
    assert.ok(job.steps.every((step) => step.if === undefined));
  }
});

test("ordinary desktop shards and serial safety projects retain all original quality commands", async () => {
  const { jobs } = await readYaml("../workflows/ci.yml");
  assert.equal(jobs.desktop.strategy["fail-fast"], false);
  assert.deepEqual(jobs.desktop.strategy.matrix, { shard: [1, 2] });
  const backendBuild = "pnpm --filter @agentkib/desktop backend:build";
  const desktopCommands = commands(jobs.desktop);
  const desktopTest = desktopCommands.find((command) => command.includes("exec vitest run"));
  assert.match(
    desktopTest ?? "",
    /^pnpm --filter @agentkib\/desktop exec vitest run --project(?:=| )desktop --shard(?:=| )\$\{\{\s*matrix\.shard\s*\}\}\/2$/,
  );
  assert.ok(desktopCommands.indexOf(backendBuild) >= 0);
  assert.ok(desktopCommands.indexOf(backendBuild) < desktopCommands.indexOf(desktopTest));

  assert.equal(jobs.safety.strategy, undefined);
  const safetyCommands = commands(jobs.safety);
  const safetyTest = safetyCommands.find((command) => command.includes("exec vitest run"));
  assert.match(
    safetyTest ?? "",
    /^pnpm --filter @agentkib\/desktop exec vitest run --project(?:=| )filesystem --project(?:=| )mcp-latency$/,
  );
  assert.ok(safetyCommands.indexOf(backendBuild) >= 0);
  assert.ok(safetyCommands.indexOf(backendBuild) < safetyCommands.indexOf(safetyTest));
  assert.ok(commands(jobs.web).includes("pnpm test:web"));
  const suiteCommands = branches.flatMap((name) =>
    commands(jobs[name]).filter((command) => /\bvitest run\b|^pnpm test(?:\b|:)/.test(command)),
  );
  assert.deepEqual(
    suiteCommands.sort(),
    [desktopTest, safetyTest, "pnpm test:web"].sort(),
    "Each quality branch must run only its assigned suite",
  );

  const checks = commands(jobs.checks);
  for (const command of [
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm build",
    "pnpm build:web:hosted",
    "node .github/scripts/verify-ci-quality-partition.mjs",
  ]) {
    assert.ok(checks.includes(command), `Missing quality command: ${command}`);
  }
  assert.ok(
    checks.some((command) =>
      /^node --test(?: --test-concurrency=1)? \.github\/scripts\/\*\.test\.mjs$/.test(command),
    ),
    "All release helper tests must still run",
  );
});

test("shared setup preserves native prerequisites and the pinned dependency installation", async () => {
  const action = await readYaml("../actions/setup-quality/action.yml");
  assert.equal(action.runs.using, "composite");
  assert.equal(action.inputs.native.default, "false");
  const steps = action.runs.steps;
  const nativeInstall = steps.find((step) => /apt-get.*install/.test(step.run ?? ""));
  assert.ok(nativeInstall);
  assert.equal(expression(nativeInstall.if), "inputs.native == 'true'");
  assert.equal(nativeInstall["timeout-minutes"], undefined);
  assert.match(nativeInstall.run, /timeout --kill-after=10s 120s apt-get .* update/);
  assert.match(nativeInstall.run, /timeout --kill-after=10s 180s apt-get .* install/);
  assert.match(nativeInstall.run, /Acquire::Retries=2/);
  assert.match(nativeInstall.run, /Acquire::http::Timeout=20/);
  assert.match(nativeInstall.run, /Acquire::https::Timeout=20/);
  assert.match(nativeInstall.run, /APT::Update::Error-Mode=any update/);
  for (const dependency of ["build-essential", "pkg-config", "libssl-dev", "libgtk-3-dev"]) {
    assert.ok(nativeInstall.run.includes(dependency), `Missing native dependency: ${dependency}`);
  }
  const diagnose = steps.find(
    (step) => step.run?.trim() === "apps/desktop/scripts/diagnose-linux.sh --strict",
  );
  assert.ok(diagnose);
  assert.equal(expression(diagnose.if), "inputs.native == 'true'");
  const pnpm = steps.find((step) => step.uses?.startsWith("pnpm/action-setup@"));
  assert.equal(pnpm?.with?.run_install, false);
  const node = steps.find((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.equal(String(node?.with?.["node-version"]), "22");
  assert.equal(node?.with?.cache, "pnpm");
  assert.equal(node?.with?.["cache-dependency-path"], "pnpm-lock.yaml");
  assert.ok(steps.some((step) => step.run?.trim() === "pnpm install --frozen-lockfile"));
  assert.ok(steps.every((step) => step["continue-on-error"] === undefined));
});

test(
  "native setup bounds both apt requests and never installs after an index failure",
  {
    skip: process.platform === "win32" ? "The Linux apt setup requires /bin/bash" : false,
  },
  async () => {
    const action = await readYaml("../actions/setup-quality/action.yml");
    const command = action.runs.steps.find((step) => /apt-get.*install/.test(step.run ?? "")).run;
    const directory = await mkdtemp(path.join(tmpdir(), "agentkib-quality-apt-"));
    try {
      await writeFile(path.join(directory, "sudo"), '#!/bin/bash\nexec "$@"\n', { mode: 0o755 });
      await writeFile(
        path.join(directory, "timeout"),
        `#!/bin/bash
printf '%s\\n' "$1 $2" >> "$TIMEOUT_CALLS"
shift 2
exec "$@"
`,
        { mode: 0o755 },
      );
      await writeFile(
        path.join(directory, "apt-get"),
        `#!/bin/bash
printf '%s\\n' "$*" >> "$APT_CALLS"
if [[ "$*" == *" update" ]]; then exit "$APT_EXIT"; fi
`,
        { mode: 0o755 },
      );
      for (const updateExit of [0, 100, 124]) {
        const failUpdate = updateExit !== 0;
        const callsFile = path.join(directory, `apt-calls-${updateExit}`);
        const timeoutsFile = path.join(directory, `timeout-calls-${updateExit}`);
        const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", command], {
          env: {
            ...process.env,
            PATH: `${directory}${path.delimiter}${process.env.PATH}`,
            APT_CALLS: callsFile,
            APT_EXIT: String(updateExit),
            TIMEOUT_CALLS: timeoutsFile,
          },
          encoding: "utf8",
          timeout: 5_000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, updateExit, result.stderr);
        const calls = (await readFile(callsFile, "utf8")).trim().split("\n");
        assert.equal(calls.length, failUpdate ? 1 : 2);
        const deadlines = (await readFile(timeoutsFile, "utf8")).trim().split("\n");
        assert.deepEqual(
          deadlines,
          failUpdate
            ? ["--kill-after=10s 120s"]
            : ["--kill-after=10s 120s", "--kill-after=10s 180s"],
        );
        for (const call of calls) {
          for (const option of [
            "Acquire::Retries=2",
            "Acquire::http::Timeout=20",
            "Acquire::https::Timeout=20",
          ]) {
            assert.ok(call.includes(option), `Missing network bound: ${option}`);
          }
        }
        assert.match(calls[0], /APT::Update::Error-Mode=any update$/);
        if (!failUpdate)
          assert.match(
            calls[1],
            /install -y --no-install-recommends build-essential pkg-config libssl-dev libgtk-3-dev$/,
          );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
