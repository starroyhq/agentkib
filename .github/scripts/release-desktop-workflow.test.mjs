import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const { parseDocument } = createRequire(
  new URL("../../apps/desktop/package.json", import.meta.url),
)("yaml");
const source = await readFile(new URL("../workflows/release-desktop.yml", import.meta.url), "utf8");
const document = parseDocument(source);
assert.deepEqual(document.errors, []);
const workflow = document.toJS();
const { jobs } = workflow;

function expression(value) {
  return value
    ?.replace(/^\s*\$\{\{\s*|\s*\}\}\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkout(job) {
  return job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
}

function named(job, name) {
  const step = job.steps.find((item) => item.name === name);
  assert.ok(step, `Missing step: ${name}`);
  return step;
}

const selectedSha = "needs.preflight.outputs.release_sha";
const collectorRun = "needs.preflight.outputs.collector_run_id";
const shouldPublish = "needs.preflight.outputs.should_publish == 'true'";
const signOnMac = "runner.os == 'macOS' && env.SHOULD_PUBLISH == 'true'";

test("revision selection grants publication only for a verified version tag on main", () => {
  assert.deepEqual(workflow.on.push.tags, ["v*.*.*"]);
  const { release_tag: requestedTag } = workflow.on.workflow_dispatch.inputs;
  assert.equal(requestedTag.required, false);
  assert.equal(requestedTag.type, "string");
  const preflight = jobs.preflight;
  assert.equal(expression(checkout(preflight).with.ref), "inputs.release_tag || github.sha");
  assert.equal(checkout(preflight).with["fetch-depth"], 0);
  const version = preflight.steps.find((step) => step.id === "version");
  assert.match(version.run, /apps\/desktop\/package\.json/);
  const release = preflight.steps.find((step) => step.id === "release");
  const pushedTag = expression(release.env.PUSHED_TAG);
  assert.ok(
    [
      "github.event_name == 'push' && github.ref_type == 'tag' && github.ref_name || ''",
      "github.ref_type == 'tag' && github.event_name == 'push' && github.ref_name || ''",
    ].includes(pushedTag),
  );
  assert.equal(expression(release.env.REQUESTED_TAG), "inputs.release_tag || ''");
  assert.equal(expression(preflight.outputs.should_publish), "steps.release.outputs.should_publish");
  assert.equal(expression(preflight.outputs.release_sha), "steps.release.outputs.release_sha");
  assert.doesNotMatch(source, /inputs\.(?:should_publish|publish)\b/);
  assert.match(release.run, /release_sha=\$\(git rev-parse 'HEAD\^\{commit\}'\)/);
  assert.match(release.run, /should_publish=false\s+if \[\[ -n "\$release_tag" \]\]; then/);
  assert.match(release.run, /expected_tag="v\$APP_VERSION"[\s\S]*"\$release_tag" != "\$expected_tag"/);
  assert.match(
    release.run,
    /tag_sha=\$\(git rev-list -n 1 "refs\/tags\/\$release_tag"\)[\s\S]*"\$tag_sha" != "\$release_sha"/,
  );
  assert.match(
    release.run,
    /git merge-base --is-ancestor "\$release_sha" origin\/main[\s\S]*should_publish=true\s+fi/,
  );
  assert.equal(
    expression(named(preflight, "Validate release signing secrets").if),
    "steps.release.outputs.should_publish == 'true'",
  );
  for (const step of preflight.steps) {
    assert.doesNotMatch(
      step.run ?? "",
      /^\s*(?:sudo apt-get|pnpm (?:install|test|typecheck|build))\b/m,
    );
  }
});

test("full selected-revision tests run independently of quota preparation and packaging", () => {
  const tests = jobs["selected-tests"];
  assert.deepEqual([tests.needs].flat(), ["preflight"]);
  assert.equal(tests.if, undefined);
  assert.equal(expression(checkout(tests).with.ref), selectedSha);
  for (const command of ["pnpm test", "pnpm typecheck", "pnpm build"]) {
    const step = tests.steps.find((item) => item.run?.trim() === command);
    assert.ok(step, `Missing selected-revision check: ${command}`);
    assert.equal(step.if, undefined);
    assert.equal(step["continue-on-error"], undefined);
  }
  const helpers = jobs["release-helpers"];
  assert.equal(expression(checkout(helpers).with.ref), "github.sha");
  assert.ok(helpers.steps.some((step) => step.run?.includes("node --test .github/scripts/*.test.mjs")));
  const quota = jobs["quota-collectors"];
  assert.deepEqual([quota.needs].flat(), ["preflight"]);
  assert.equal(expression(quota.if), `${collectorRun} == ''`);
  assert.equal(expression(quota.with.source_ref), selectedSha);

  const collectorGate =
    "!cancelled() && needs.preflight.result == 'success' && " +
    "(needs.quota-collectors.result == 'success' || " +
    `(needs.quota-collectors.result == 'skipped' && ${collectorRun} != ''))`;
  for (const id of ["desktop", "fedora-x64"]) {
    const job = jobs[id];
    assert.deepEqual([...job.needs].sort(), ["preflight", "quota-collectors"]);
    assert.equal(expression(job.if), collectorGate);
    assert.equal(expression(checkout(job).with.ref), selectedSha);
    const reuse = named(job, "Download matching collector from a successful release");
    assert.equal(reuse.uses, "actions/download-artifact@v8");
    assert.equal(reuse.with["digest-mismatch"], "error");
    assert.equal(expression(reuse.with["github-token"]), "github.token");
    assert.equal(expression(reuse.with["run-id"]), collectorRun);
    const build = named(job, id === "desktop" ? "Build Electron bundles" : "Build Electron RPM");
    assert.match(build.run, /^\s*pnpm quota:prepare\s*$/m);
    assert.match(build.run, /^\s*pnpm quota:stage\s*$/m);
  }
});

test("manual collector rebuild skips reuse before the existing source-build gate", () => {
  const input = workflow.on.workflow_dispatch.inputs.force_rebuild_collectors;
  assert.equal(input.type, "boolean");
  assert.equal(input.default, false);
  assert.equal(input.required, false);

  const preflight = jobs.preflight;
  const lookup = named(preflight, "Find verified collectors with identical build inputs");
  assert.equal(expression(lookup.if), "!inputs.force_rebuild_collectors");
  assert.equal(
    expression(named(preflight, "Checkout collector selection helper").if),
    expression(lookup.if),
  );
  assert.equal(lookup.id, "collectors");
  assert.equal(
    expression(preflight.outputs.collector_run_id),
    "steps.collectors.outputs.collector_run_id",
  );
  assert.equal(expression(jobs["quota-collectors"].if), `${collectorRun} == ''`);
  for (const [job, prefix] of [
    [jobs.desktop, "matrix.quota_target != 'unsupported' && "],
    [jobs["fedora-x64"], ""],
  ]) {
    const fresh = named(job, "Download validated patched collector");
    const reused = named(job, "Download matching collector from a successful release");
    assert.equal(expression(fresh.if), `${prefix}${collectorRun} == ''`);
    assert.equal(expression(reused.if), `${prefix}${collectorRun} != ''`);
  }
});

test("artifact-only jobs do not receive Apple signing credentials", () => {
  const desktop = jobs.desktop;
  assert.equal(expression(desktop.env.SHOULD_PUBLISH), "needs.preflight.outputs.should_publish");
  const key = named(desktop, "Prepare Apple notarization private key");
  assert.equal(expression(key.if), signOnMac);
  const build = named(desktop, "Build Electron bundles");
  for (const variable of [
    "APPLE_API_ISSUER",
    "APPLE_API_KEY_ID",
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
  ]) {
    const secret = variable === "APPLE_API_KEY_ID" ? "APPLE_API_KEY" : variable;
    assert.equal(expression(build.env[variable]), `${signOnMac} && secrets.${secret} || ''`);
  }
  assert.match(
    build.run,
    /if \[\[ "\$SHOULD_PUBLISH" == true \]\]; then[\s\S]*--config\.mac\.notarize=true/,
  );
  const verify = named(desktop, "Verify signed and notarized macOS release");
  assert.equal(expression(verify.if), signOnMac);
  assert.match(verify.run, /codesign --verify --deep --strict/);
  assert.match(verify.run, /Authority=\$APPLE_SIGNING_IDENTITY/);
  assert.match(verify.run, /TeamIdentifier=\$\{APPLE_TEAM_ID\}/);
  assert.match(verify.run, /xcrun stapler validate/);
  assert.match(verify.run, /spctl --assess --type execute/);
  const retained = named(desktop, "Retain verified collectors for future releases");
  assert.equal(
    expression(retained.if),
    `matrix.quota_target != 'unsupported' && env.SHOULD_PUBLISH == 'true' && ${collectorRun} != ''`,
  );
  assert.equal(retained.with.name, "quota-collector-${{ matrix.quota_target }}");
  assert.equal(retained.with.path, "apps/desktop/resources/quota/");
});

test("publishing requires successful tests, verified platform packages and an unchanged tag", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const [id, job] of Object.entries(jobs)) {
    assert.equal(job["continue-on-error"], undefined);
    if (id !== "publish-release") assert.notEqual(job.permissions?.contents, "write");
  }
  const publish = jobs["publish-release"];
  assert.deepEqual(publish.permissions, { contents: "write" });
  assert.deepEqual([...publish.needs].sort(), [
    "desktop",
    "fedora-x64",
    "preflight",
    "release-helpers",
    "selected-tests",
  ]);
  assert.equal(
    expression(publish.if),
    [
      "!cancelled()",
      shouldPublish,
      ...publish.needs.map((job) => `needs.${job}.result == 'success'`),
    ].join(" && "),
  );
  assert.equal(expression(checkout(publish).with.ref), selectedSha);
  assert.match(named(publish, "Validate release assets and checksums").run, /sha256sum -c/);
  const metadata = named(publish, "Validate Electron updater metadata").run;
  assert.match(
    metadata,
    /for metadata in latest-linux\.yml latest-linux-arm64\.yml arm64-mac\.yml x64-mac\.yml arm64\.yml x64\.yml;/,
  );
  assert.match(metadata, /version: \$\{APP_VERSION/);
  assert.match(metadata, /sha512:/);
  const draft = named(publish, "Prepare draft release").run;
  assert.match(draft, /commits\/\$RELEASE_TAG/);
  assert.match(draft, /"\$remote_tag_sha" != "\$RELEASE_SHA"/);
  assert.match(draft, /--verify-tag/);
  assert.match(named(publish, "Verify uploaded release assets").run, /diff -u/);
  assert.match(named(publish, "Publish verified release").run, /--draft=false/);
});
