import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  captureBaseline,
  registryEntries,
  scanSource,
  tightenedBaseline,
  validateBaseline,
  violations,
} from "./check-architecture.mjs";

const app = "apps/desktop/src/session.tsx";
const empty = { agent: {}, large: {}, compatibility: {} };
const heading = "## Tracked branches\n";
const table = (rows) =>
  heading +
  "| 代码位置 | 标识符或注释片段 | 保留原因 | 支持版本 | 删除条件 |\n" +
  "| --- | --- | --- | --- | --- |\n" +
  rows;
const record = (file, marker, removal = "Delete after readers migrate") =>
  `| \`${file}\` | \`${marker}\` | Reads old data | Through 0.38.0 | ${removal} |\n`;
const lines = (amount) => "run();\r\n".repeat(amount);
const scan = (sources) =>
  new Map(
    Object.entries(sources).map(([file, source]) => [
      file,
      { source, ...scanSource(file, source) },
    ]),
  );

test("finds real Agent comparisons, including reversed, wrapped, loose and switch cases", () => {
  const source = [
    'if (agent === "codex") run();',
    "if ('claude-code' !== agent) run();",
    'if (agent == ("deepseek-harness" as const)) run();',
    'switch (agent) { case "devin": run(); }',
    "if (agent != `antigravity`) run();",
    'if (agent === /* split */\n "grok-build") run();',
    '// agent === "codex"',
    'const example = `agent === "devin"`;',
    'type Agent = "codex" | "devin";',
    'const identity = { "claude-code": "Claude Code" };',
    'const doc = <span>case "codex":</span>;',
    'if (agent === "native") run();',
  ].join("\n");
  const result = scanSource(app, source);
  assert.equal(result.agentJudgments.length, 6);
  assert.match(violations(scan({ [app]: source }), empty, new Map())[0], /session\.tsx:1/);
});

test("exempts Agent implementation directories and the central Provider declaration from comparisons", () => {
  const text = 'agent === "codex";\n// legacy bridge';
  assert.equal(
    scanSource("packages/backend/src/agents/codex/control.ts", text).agentJudgments.length,
    0,
  );
  assert.equal(
    scanSource("packages/runtime-protocol/src/session-providers.ts", text).agentJudgments.length,
    0,
  );
  assert.equal(
    scanSource("packages/session-ui/src/session-provider.ts", text).agentJudgments.length,
    1,
  );
  assert.equal(scanSource("packages/backend/src/agents/codex/control.ts", text).markers.size, 1);
});

test("uses each file's own comparison limit", () => {
  const source = 'agent === "codex";';
  const baseline = captureBaseline(scan({ [app]: source }));
  assert.deepEqual(violations(scan({ [app]: source }), baseline, new Map()), []);
  const changes = violations(
    scan({
      [app]: source + '\nagent === "devin";',
      "packages/backend/src/control.ts": source,
    }),
    baseline,
    new Map(),
  );
  assert.equal(changes.length, 2);
  assert.match(changes[0], /increased from 1 to 2/);
  assert.match(changes[1], /increased from 0 to 1/);
});

test("counts physical lines, enforces caps for old and new product files, and skips tests", () => {
  const old = "packages/backend/src/old.ts";
  const baseline = captureBaseline(scan({ [old]: lines(1502) }));
  const changes = violations(
    scan({
      [old]: lines(1503).trimEnd(),
      "packages/backend/src/new.ts": lines(1501),
      "packages/backend/src/exact.ts": lines(1500),
      "packages/backend/src/new.test.ts": lines(1501),
      "apps/desktop/test/fixture.ts": lines(1501),
      "apps/desktop/src/styles.css": "\r".repeat(1501),
      "docs/guide.md": lines(1501),
    }),
    baseline,
    new Map(),
  );
  assert.equal(changes.length, 3);
  assert.match(changes[0], /1503 lines.*1502-line budget/);
  assert.match(changes[1], /1501 lines.*1500-line budget/);
  assert.match(changes[2], /styles\.css/);
});

test("exempts generated contracts from Agent comparisons and line caps only", () => {
  const generatedTs = "packages/runtime-protocol/src/generated/remote-contract.ts";
  const generatedDart = "packages/runtime-protocol/generated/remote_protocol.g.dart";
  const handwritten = "packages/runtime-protocol/src/remote-contract.ts";
  const source = 'agent === "codex";\nconst legacyMode = 1;\n' + lines(1501);
  const baseline = captureBaseline(
    scan({ [generatedTs]: source, [generatedDart]: lines(1501), [handwritten]: source }),
  );
  assert.deepEqual(baseline.agent, { [handwritten]: 1 });
  assert.deepEqual(baseline.large, { [handwritten]: 1503 });
  assert.deepEqual(baseline.compatibility[generatedTs], { "identifier: legacyMode": 1 });
});

test("counts parsed identifiers and comments, including private names and multiline comments", () => {
  const file = "packages/backend/src/native.js";
  const source = [
    "const legacyMode = 1; const item = {legacyMode};",
    "class Reader { #compatPath() {} }",
    "/* Fallback to old settings.",
    " * Keep legacy settings readable. */",
    'const example = "fallback // legacy";',
  ].join("\n");
  const markers = scanSource(file, source).markers;
  assert.equal(markers.get("identifier: legacyMode").length, 2);
  assert.equal(markers.get("identifier: #compatPath").length, 1);
  assert.equal(markers.get("comment: Fallback to old settings.").length, 1);
  assert.equal(markers.get("comment: Keep legacy settings readable.").length, 1);
  assert.equal(markers.size, 4);
});

test("requires registration for new occurrences, tied to the path and exact marker", () => {
  const baseline = captureBaseline(scan({ [app]: "const legacyMode = 1;" }));
  const source = "const legacyMode = 1; use(legacyMode);\n// Fallback to old settings.";
  const files = scan({ [app]: source, "packages/backend/src/new.ts": source });
  const registry = registryEntries(
    table(record(app, "legacyMode") + record(app, "Fallback to old settings")),
  );
  const changes = violations(files, baseline, registry);
  assert.equal(changes.length, 2);
  assert.ok(changes.every((error) => error.startsWith("packages/backend/src/new.ts:")));
  const bad = registryEntries(table(record(app, "legacy")));
  assert.equal(violations(scan({ [app]: source }), baseline, bad).length, 2);
});

test("rejects malformed and duplicate registry entries", () => {
  assert.throws(() => registryEntries(table(record(app, "legacyMode", " "))), /Invalid/);
  assert.throws(() => registryEntries(table(record(app, "legacyMode").repeat(2))), /Duplicate/);
  assert.throws(() => registryEntries(table(record(app, "normalIdentifier"))), /Invalid/);
  assert.throws(() => registryEntries("## Another table"), /Missing/);
});

test("tightening lowers existing budgets, removes resolved files, and never accepts new entries", () => {
  const old = {
    agent: { [app]: 3, "missing.ts": 1 },
    large: { [app]: 2200, "other.ts": 1600 },
    compatibility: { [app]: { "identifier: legacyName": 5, "comment: fallback": 1 } },
  };
  const actual = {
    agent: { [app]: 2, "new.ts": 4 },
    large: { [app]: 1700, "new.ts": 4000 },
    compatibility: { [app]: { "identifier: legacyName": 4, "identifier: legacyNew": 1 } },
  };
  assert.deepEqual(tightenedBaseline(old, actual), {
    agent: { [app]: 2 },
    large: { [app]: 1700 },
    compatibility: { [app]: { "identifier: legacyName": 4 } },
  });
  assert.throws(() => validateBaseline({ ...old, large: { [app]: 0 } }), /Invalid/);
});

test("CLI uses the trusted Git tree for adoption and blocks raised limits or removed registry rows", (t) => {
  const root = mkdtempSync(join(tmpdir(), "arch-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const script = fileURLToPath(new URL("./check-architecture.mjs", import.meta.url));
  const lint = (...args) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
  const baselineFile = "scripts/architecture-baseline.json";
  const registry = "docs/development/compat-registry.md";
  const write = (file, text) => writeFileSync(join(root, file), text);
  const writeBaseline = (baseline) => write(baselineFile, JSON.stringify(baseline));
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "user.name=Fixture",
      "commit",
      "-qm",
      "fixture",
    );
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q");
  mkdirSync(join(root, "apps/desktop/src"), { recursive: true });
  write(app, 'check(é === "devin");');
  const initial = commit();
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "docs/development"), { recursive: true });
  write(registry, table(""));
  writeBaseline({ ...empty, agent: { [app]: 2 } });
  assert.match(lint("--base", initial).stderr, /baseline grew/);
  writeBaseline({ ...empty, agent: { [app]: 1 } });
  const adoption = lint("--base", initial);
  assert.equal(adoption.status, 0, adoption.stderr);
  const admitted = commit();

  write(app, "const legacyMode = 1;");
  const rejected = lint("--tighten", "--base", admitted);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /register identifier: legacyMode/);
  write(registry, table(record(app, "legacyMode")));
  const tightened = lint("--tighten", "--base", admitted);
  assert.equal(tightened.status, 0, tightened.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(root, baselineFile), "utf8")), empty);
  const shrunk = commit();
  writeBaseline({ ...empty, agent: { [app]: 1 } });
  assert.match(lint("--base", shrunk).stderr, /baseline grew/);
  writeBaseline(empty);
  write(registry, table(""));
  assert.match(lint("--base", shrunk).stderr, /register identifier: legacyMode/);
});
