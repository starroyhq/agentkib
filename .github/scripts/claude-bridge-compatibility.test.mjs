import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  compatibilityEnvironment,
  bridgeTestSummary,
  failureSummary,
  pluginTestSummary,
  requestedVersion,
  sandboxPolicy,
  verifySandboxBoundaries,
} from "./claude-bridge-compatibility.mjs";
import { CLAUDE_BRIDGE_COMPATIBILITY } from "../../packages/claude-bridge-plugin/hooks/compatibility.js";

test("only the minimum, latest or an unambiguous stable CLI can be installed", () => {
  assert.equal(requestedVersion("minimum"), CLAUDE_BRIDGE_COMPATIBILITY.minimumCliVersion);
  assert.equal(requestedVersion("latest"), "latest");
  assert.equal(requestedVersion("2.1.307"), "2.1.307");
  for (const value of [
    "next",
    "^2.1.301",
    "2.1.301-beta.1",
    "02.1.301",
    "--registry=other",
    "latest; echo credential",
  ])
    assert.throws(() => requestedVersion(value), /invalid-version-selector/);
});

test("CLI execution uses five isolated directories and inherits no account variables", () => {
  const root = "/private/tmp/synthetic";
  const environment = compatibilityEnvironment(root, "/synthetic/node");
  for (const key of [
    "HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "AGENTKIB_BENCHMARK_DATA_DIR",
    "AGENTKIB_BENCHMARK_USER_DATA",
    "AGENTKIB_HOME",
    "NPM_CONFIG_USERCONFIG",
    "NPM_CONFIG_GLOBALCONFIG",
    "NPM_CONFIG_CACHE",
    "TMPDIR",
  ])
    assert.equal(path.dirname(environment[key]), path.normalize(root));
  assert.equal(environment.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org");
  assert.equal(environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "GITHUB_TOKEN",
    "SSH_AUTH_SOCK",
    "HTTP_PROXY",
    "NODE_OPTIONS",
  ])
    assert.equal(Object.hasOwn(environment, key), false);
});

test("native plugin checks deny all network and personal data without granting exceptions", () => {
  const policy = sandboxPolicy();
  assert.match(policy, /\(deny network\*\)/);
  assert.doesNotMatch(policy, /\(allow network/);
  for (const location of ["/Users", "/System/Volumes/Data/Users", "/Volumes", "/Library/Keychains"])
    assert.ok(policy.includes(`(subpath "${location}")`));
  assert.match(policy, /\(deny mach-lookup/);
  assert.ok(policy.includes('"com.apple.securityd"'));
});

test("bridge regressions permit only loopback/sockets and explicit source/runtime reads", () => {
  const policy = sandboxPolicy({
    sourceDirectory: "/synthetic/checkout",
    nodeDirectory: "/synthetic/node",
  });
  assert.match(policy, /\(deny network\*\)/);
  assert.match(policy, /\(remote ip "localhost:\*"\)/);
  assert.match(policy, /\(remote unix-socket\)/);
  assert.match(policy, /\(subpath "\/synthetic\/checkout"\)/);
  assert.match(policy, /\(allow file-read\* \(subpath "\/synthetic\/node"\)\)/);
  assert.doesNotMatch(policy, /\(remote ip "\*"\)/);
  assert.match(policy, /\(deny mach-lookup/);
});

test("failure summaries include known capability names but discard raw paths and secrets", () => {
  const raw = {
    status: 1,
    stdout: "failure session-messages token=synthetic-secret /Users/example/private",
    stderr: "credential-read AUTHORIZATION=synthetic-bearer",
  };
  const summary = failureSummary("plugin-test-and-capability-contract", raw);
  assert.deepEqual(summary, {
    check: "plugin-test-and-capability-contract",
    result: "failed",
    exitCode: 1,
    timedOut: false,
    capabilities: ["session-messages", "credential-read"],
  });
  assert.doesNotMatch(JSON.stringify(summary), /synthetic-secret|synthetic-bearer|\/Users/);
  assert.deepEqual(
    failureSummary("plugin-validate-strict", {
      status: 1,
      stderr: "Unknown host API $.session.messages and $.store.get",
    }).capabilities,
    ["session-messages", "credential-store"],
  );
  assert.deepEqual(
    failureSummary("plugin-validate-strict", { status: null, error: { code: "ETIMEDOUT" } }),
    {
      check: "plugin-validate-strict",
      result: "failed",
      exitCode: null,
      timedOut: true,
      capabilities: [],
    },
  );
});

test("a successful exit cannot replace evidence that explicit capability cases actually ran", () => {
  const complete = [
    "(pass) required readonly capabilities use explicit safe calls and preserve the observed CLI version [1ms]",
    "(pass) missing session-messages is reported without accepting a compatible version alone [1ms]",
    " 7 pass",
    " 0 fail",
  ].join("\n");
  assert.deepEqual(pluginTestSummary(complete), { passed: 7, failed: 0, capabilityProbeCases: 2 });
  assert.throws(
    () => pluginTestSummary("0 pass\n0 fail"),
    /capability-contract-tests-not-confirmed/,
  );
  assert.throws(
    () => pluginTestSummary(complete.replace("(pass) missing", "(skip) missing")),
    /capability-contract-tests-not-confirmed/,
  );
  assert.throws(
    () => pluginTestSummary(complete.replace("0 fail", "1 fail")),
    /capability-contract-tests-not-confirmed/,
  );
});

test("bridge checks require all six requested suites to complete successfully", () => {
  assert.deepEqual(bridgeTestSummary("Test Files  6 passed (6)\n Tests  127 passed (127)"), {
    files: 6,
    passed: 127,
  });
  for (const output of [
    "Test Files  5 passed (5)\n Tests  127 passed (127)",
    "Test Files  1 failed | 6 passed (7)\n Tests  127 passed (127)",
    "Test Files  6 passed (6)\n Tests  1 failed | 127 passed (128)",
    "no tests found",
  ])
    assert.throws(() => bridgeTestSummary(output), /bridge-regression-tests-not-confirmed/);
});

test(
  "macOS enforces both sandbox profiles including the loopback-only exception",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp("/private/tmp/agentkib-bridge-barrier-test-");
    try {
      await mkdir(path.join(root, "home"));
      const environment = compatibilityEnvironment(root);
      for (const bridge of [false, true]) {
        const profile = path.join(root, `${bridge ? "bridge" : "cli"}.sb`);
        await writeFile(
          profile,
          sandboxPolicy(
            bridge
              ? { sourceDirectory: "/Users/synthetic/checkout", nodeDirectory: "/synthetic/node" }
              : {},
          ),
        );
        verifySandboxBoundaries(profile, { env: environment, cwd: root, timeout: 5000 }, bridge);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
