import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { classifyRawDiff, determineChangeMode, evaluateGate } from "./ci-quality.mjs";

const script = fileURLToPath(new URL("./ci-quality.mjs", import.meta.url));
const oldBlob = "1".repeat(40);
const newBlob = "2".repeat(40);
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

function rawRecord(file, { status = "M", oldMode = "100644", newMode = "100644" } = {}) {
  const source = status === "A" ? "0".repeat(40) : oldBlob;
  const destination = status === "D" ? "0".repeat(40) : newBlob;
  return `:${oldMode} ${newMode} ${source} ${destination} ${status}\0${file}\0`;
}

function rawDiff(...records) {
  return Buffer.from(records.join(""));
}

function pullRequest(base = baseSha, head = headSha) {
  return { pull_request: { base: { sha: base }, head: { sha: head } } };
}

function needsFor(mode, result = mode === "docs" ? "skipped" : "success") {
  return {
    changes: { result: "success", outputs: { mode } },
    checks: { result },
    desktop: { result },
    safety: { result },
    web: { result },
  };
}

async function gitFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agentkib-ci-quality-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  await mkdir(repository);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "CI fixture");
  git("config", "user.email", "ci-fixture@example.invalid");
  git("config", "core.autocrlf", "false");
  const write = async (file, content) => {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), content);
  };
  const commit = () => {
    git("add", "--all");
    git("commit", "--quiet", "--message", "fixture");
    return git("rev-parse", "HEAD");
  };
  await write("README.md", "# Fixture documentation\n\nOriginal documentation content.\n");
  await write("docs/DEVELOPMENT.md", "# Development\n");
  await write("qa/baseline.md", "# Baseline validation\n");
  await write("source.ts", "export const answer = 1;\n");
  const base = commit();
  const changes = async (eventName, event, { eventText, cwd = repository } = {}) => {
    const eventPath = path.join(directory, "event.json");
    const outputPath = path.join(directory, "output");
    await writeFile(eventPath, eventText ?? JSON.stringify(event));
    await writeFile(outputPath, "");
    const result = spawnSync(process.execPath, [script, "changes"], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: eventName,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
      },
    });
    const output = await readFile(outputPath, "utf8");
    assert.equal(result.status, 0, result.stderr);
    assert.match(output, /^mode=(?:docs|full)\n$/);
    return { ...result, output };
  };
  return { directory, repository, base, git, write, commit, changes };
}

test("only explicitly scoped ordinary documentation additions and modifications use docs mode", () => {
  const paths = [
    "README.md",
    "README.zh-CN.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "docs/DEVELOPMENT.md",
    "qa/v15-b3-c-finalize-2026-10-22.md",
  ];
  for (const file of paths) {
    assert.equal(classifyRawDiff(rawDiff(rawRecord(file))), "docs", file);
    assert.equal(
      classifyRawDiff(rawDiff(rawRecord(file, { status: "A", oldMode: "000000" }))),
      "docs",
      file,
    );
  }
  assert.equal(classifyRawDiff(rawDiff(...paths.map((file) => rawRecord(file)))), "docs");
});

test("sources, executable probes, nested files, assets and unreviewed markdown paths require full mode", () => {
  for (const file of [
    "source.ts",
    "package.json",
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    ".github/scripts/ci-quality.mjs",
    ".github/pull_request_template.md",
    "AGENTS.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "design-qa.md",
    "apps/web/README.md",
    "packages/claude-bridge-plugin/README.md",
    "docs/assets/home.png",
    "docs/screenshots/guide/README.md",
    "docs/new-script.mjs",
    "qa/probes/probe.py",
    "qa/probes/v15-c-README.md",
    "qa/nested/report.md",
    "qa/evidence.json",
    "qa/results.jsonl",
    "qa/screenshot.png",
  ]) {
    assert.equal(classifyRawDiff(rawDiff(rawRecord(file))), "full", file);
    assert.equal(classifyRawDiff(rawDiff(rawRecord("README.md"), rawRecord(file))), "full", file);
  }
});

test("deleted, renamed, copied, executable, symlink and irregular Git entries require full mode", () => {
  for (const record of [
    rawRecord("README.md", { status: "D", newMode: "000000" }),
    rawRecord("docs/old.md", { status: "R100" }) + "docs/new.md\0",
    rawRecord("README.md", { status: "C100" }) + "docs/copied.md\0",
    rawRecord("README.md", { status: "T", newMode: "120000" }),
    rawRecord("README.md", { status: "U" }),
    rawRecord("README.md", { status: "X" }),
    rawRecord("README.md", { status: "M100" }),
    rawRecord("README.md", { oldMode: "100755", newMode: "100755" }),
    rawRecord("README.md", { newMode: "100755" }),
    rawRecord("README.md", { oldMode: "120000", newMode: "120000" }),
    rawRecord("README.md", { oldMode: "160000", newMode: "160000" }),
    rawRecord("README.md", { status: "A", oldMode: "100644" }),
    rawRecord("README.md", { oldMode: "000000" }),
  ]) {
    assert.equal(classifyRawDiff(rawDiff(record)), "full");
  }
});

test("empty, malformed, ambiguous and unsafe raw diff records fail closed", () => {
  for (const raw of [
    Buffer.alloc(0),
    undefined,
    null,
    {},
    rawDiff("M\0README.md\0"),
    rawDiff(rawRecord("README.md").slice(0, -1)),
    rawDiff(rawRecord("README.md"), "unparsed\0"),
    rawDiff(rawRecord("README.md").replace(oldBlob, "invalid")),
    rawDiff(rawRecord("README.md").replace(" M\0", " M\n\0")),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), rawDiff(rawRecord("README.md"))]),
    rawDiff(rawRecord("README.md").replace(newBlob, "0".repeat(40))),
    rawDiff(
      rawRecord("README.md", { status: "A", oldMode: "000000" }).replace("0".repeat(40), oldBlob),
    ),
    rawDiff(rawRecord("README.md"), rawRecord("README.md")),
    ...[
      "/README.md",
      "./README.md",
      "../README.md",
      "docs/../README.md",
      "docs//guide.md",
      "docs\\guide.md",
      "docs/a\nb.md",
      "docs/guide.md\n",
      "docs/guide.md\r",
      "qa/a\tb.md",
      "docs/.hidden.md",
      "docs/guide.md\0source.ts",
      "docs/guide.MD",
    ].map((file) => rawDiff(rawRecord(file))),
    Buffer.concat([rawDiff(rawRecord("docs/")), Buffer.from([0xff]), Buffer.from(".md\0")]),
  ]) {
    assert.equal(classifyRawDiff(raw), "full");
  }
});

test("only valid pull request SHA pairs can request the complete diff", () => {
  const calls = [];
  assert.equal(
    determineChangeMode({
      eventName: "pull_request",
      event: pullRequest(),
      readDiff: (base, head) => {
        calls.push([base, head]);
        return rawDiff(rawRecord("README.md"));
      },
    }),
    "docs",
  );
  assert.deepEqual(calls, [[baseSha, headSha]]);
  for (const event of [
    undefined,
    null,
    [],
    {},
    { pull_request: null },
    { pull_request: { base: {}, head: {} } },
    pullRequest("main", headSha),
    pullRequest(baseSha, "HEAD~1"),
    pullRequest(baseSha, `${headSha}\n`),
  ]) {
    let readCalls = 0;
    assert.equal(
      determineChangeMode({
        eventName: "pull_request",
        event,
        readDiff: () => {
          readCalls += 1;
          return rawDiff(rawRecord("README.md"));
        },
      }),
      "full",
    );
    assert.equal(readCalls, 0, "invalid events must not invoke Git");
  }
});

test("pushes, other events, read failures and empty PR diffs always use full mode", () => {
  for (const eventName of ["push", "workflow_dispatch", "pull_request_target", "", undefined]) {
    assert.equal(
      determineChangeMode({
        eventName,
        event: pullRequest(),
        readDiff: () => assert.fail("non-PR events must not invoke Git"),
      }),
      "full",
    );
  }
  for (const readDiff of [
    undefined,
    () => Buffer.alloc(0),
    () => {
      throw new Error("fixture private payload must never be printed");
    },
  ]) {
    assert.equal(
      determineChangeMode({ eventName: "pull_request", event: pullRequest(), readDiff }),
      "full",
    );
  }
});

test("changes CLI detects a real documentation-only PR and emits only a fixed mode output", async (t) => {
  const f = await gitFixture(t);
  await f.write("docs/DEVELOPMENT.md", "# Development\n\nUpdated instructions.\n");
  await f.write("qa/new-report.md", "# Documentation review\n");
  const head = f.commit();
  const result = await f.changes("pull_request", pullRequest(f.base, head));
  assert.equal(result.output, "mode=docs\n");
  assert.doesNotMatch(result.stdout + result.stderr, /event\.json|repository|private|fixture/i);
});

test("changes CLI evaluates the whole PR when a code commit is followed by QA only", async (t) => {
  const f = await gitFixture(t);
  await f.write("source.ts", "export const answer = 2;\n");
  f.commit();
  await f.write("qa/new-report.md", "# Follow-up validation\n");
  const head = f.commit();
  assert.equal((await f.changes("pull_request", pullRequest(f.base, head))).output, "mode=full\n");
});

test("changes CLI uses the PR merge base when the target branch has advanced", async (t) => {
  const f = await gitFixture(t);
  f.git("switch", "--quiet", "--create", "documentation");
  await f.write("docs/DEVELOPMENT.md", "# Development\n\nPR documentation.\n");
  const head = f.commit();
  f.git("switch", "--quiet", "main");
  await f.write("source.ts", "export const answer = 3;\n");
  const advancedBase = f.commit();
  assert.equal(
    (await f.changes("pull_request", pullRequest(advancedBase, head))).output,
    "mode=docs\n",
  );
});

test("changes CLI detects real documentation renames and copies conservatively", async (t) => {
  for (const operation of ["rename", "copy"]) {
    const f = await gitFixture(t);
    if (operation === "rename") f.git("mv", "README.md", "docs/renamed.md");
    else
      await f.write("docs/copied.md", await readFile(path.join(f.repository, "README.md"), "utf8"));
    const head = f.commit();
    assert.equal(
      (await f.changes("pull_request", pullRequest(f.base, head))).output,
      "mode=full\n",
    );
  }
});

test("changes CLI falls back without exposing malformed event or Git error details", async (t) => {
  const f = await gitFixture(t);
  const invalidCases = [
    ["push", pullRequest(), {}],
    ["pull_request", {}, {}],
    ["pull_request", {}, { eventText: '{"private-payload":"never-print-me"' }],
    ["pull_request", pullRequest(baseSha, headSha), {}],
    ["pull_request", pullRequest(f.base, f.base), {}],
    ["pull_request", pullRequest(f.base, f.base), { cwd: f.directory }],
  ];
  for (const [eventName, event, options] of invalidCases) {
    const result = await f.changes(eventName, event, options);
    assert.equal(result.output, "mode=full\n");
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /private-payload|never-print-me|event\.json|fatal:|repository|fixture/i,
    );
  }
  const result = spawnSync(process.execPath, [script, "changes"], {
    cwd: f.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: path.join(f.directory, "missing-private-event.json"),
      GITHUB_OUTPUT: path.join(f.directory, "missing-event-output"),
    },
  });
  assert.equal(result.status, 0);
  assert.equal(
    await readFile(path.join(f.directory, "missing-event-output"), "utf8"),
    "mode=full\n",
  );
  assert.doesNotMatch(result.stdout + result.stderr, /missing-private|ENOENT|repository|fixture/i);
});

test("gate accepts only complete full success or deliberately skipped docs leaves", () => {
  assert.equal(evaluateGate(needsFor("full")), true);
  assert.equal(evaluateGate(needsFor("docs")), true);
  for (const mode of ["full", "docs"]) {
    for (const key of ["changes", "checks", "desktop", "safety", "web"]) {
      for (const result of ["failure", "cancelled", "unknown", "", undefined]) {
        const needs = needsFor(mode);
        needs[key].result = result;
        assert.equal(evaluateGate(needs), false, `${mode}/${key}/${result}`);
      }
      const needs = needsFor(mode);
      delete needs[key];
      assert.equal(evaluateGate(needs), false, `${mode}/${key}/missing`);
    }
    for (const key of ["checks", "desktop", "safety", "web"]) {
      const needs = needsFor(mode);
      needs[key].result = mode === "full" ? "skipped" : "success";
      assert.equal(evaluateGate(needs), false, `${mode}/${key}/unexpected`);
    }
  }
});

test("gate rejects absent, invalid and ambiguous change classification", () => {
  for (const mode of [undefined, null, "", "unknown", "FULL", "docs\n", true]) {
    assert.equal(evaluateGate(needsFor(mode)), false);
  }
  for (const needs of [undefined, null, [], {}, { ...needsFor("full"), changes: null }]) {
    assert.equal(evaluateGate(needs), false);
  }
  const missingOutputs = needsFor("full");
  delete missingOutputs.changes.outputs;
  assert.equal(evaluateGate(missingOutputs), false);
  const skippedClassifier = needsFor("docs");
  skippedClassifier.changes.result = "skipped";
  assert.equal(evaluateGate(skippedClassifier), false);
});

test("gate CLI rejects malformed input and failures with fixed diagnostics", () => {
  const cases = [
    [JSON.stringify(needsFor("full")), true],
    [JSON.stringify(needsFor("docs")), true],
    [JSON.stringify(needsFor("full", "skipped")), false],
    [JSON.stringify(needsFor("docs", "success")), false],
    [JSON.stringify({ ...needsFor("full"), desktop: { result: "cancelled" } }), false],
    ['{"private-payload":"never-print-me"', false],
    ["", false],
  ];
  for (const [input, accepted] of cases) {
    const result = spawnSync(process.execPath, [script, "gate"], {
      encoding: "utf8",
      env: { ...process.env, CI_QUALITY_NEEDS: input },
    });
    assert.equal(result.status, accepted ? 0 : 1);
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /private-payload|never-print-me|SyntaxError/,
    );
    if (!accepted) assert.match(result.stderr, /CI quality gate rejected/i);
  }
});
