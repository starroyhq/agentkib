import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { captureSessionShape } from "../../qa/probes/session-shape-store.mjs";

const cli = fileURLToPath(new URL("../../qa/probes/capture-session-shape.mjs", import.meta.url));
const privateMarker = "private-fixture-sentinel";
const sessionId = "synthetic-session-id";
const nativeId = "face0000-0000-4000-8000-000000000001";

function setup(t, wal = false) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "agentkib-shape-test-")));
  const data = path.join(root, privateMarker);
  mkdirSync(data);
  writeFileSync(path.join(root, ".git"), "synthetic-checkout");
  let liveLedger;
  t.after(() => {
    liveLedger?.close();
    rmSync(root, { recursive: true, force: true });
  });

  for (const directory of ["claude-managed", "claude-bridge", "codex-managed"]) {
    mkdirSync(path.join(data, directory));
  }
  const transcript = path.join(data, nativeId + ".jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({ type: "last-prompt", lastPrompt: privateMarker }) +
      "\n" +
      JSON.stringify({ type: "api-request-blob", request: { api_key: privateMarker } }) +
      "\n",
  );
  const managed = path.join(data, "claude-managed", sessionId + ".json");
  writeFileSync(
    managed,
    JSON.stringify({
      id: sessionId,
      nativeId,
      home: data,
      workspace: data,
      title: privateMarker,
      adopted: true,
      released: false,
      fresh: false,
      terminalHandover: true,
      terminalHandoverLeaseId: privateMarker,
      completedRequests: [],
      snapshot: {
        status: "outcome-unknown",
        turnOrigin: "host",
        turnId: privateMarker,
        terminalResult: { turnId: privateMarker, success: false, text: privateMarker },
      },
    }),
  );
  writeFileSync(
    path.join(data, "claude-bridge", "bindings-v1.json"),
    JSON.stringify({
      bindings: [
        {
          target: { sessionId, cwd: data },
          token: privateMarker,
          revoked: false,
          inflight: { turnId: privateMarker },
        },
        { target: { sessionId: "different-session" }, revoked: true },
      ],
    }),
  );

  const ledgerPath = path.join(data, "codex-managed", "executions.sqlite");
  const ledger = new DatabaseSync(ledgerPath);
  if (wal) {
    ledger.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    liveLedger = ledger;
  }
  try {
    ledger.exec(`
      CREATE TABLE managed_commands(session_id TEXT, phase TEXT, evidence TEXT, result TEXT);
      CREATE TABLE claude_host_states(session_id TEXT PRIMARY KEY, record TEXT);
      CREATE TABLE orchestration_leads(session_id TEXT PRIMARY KEY, record TEXT);
      CREATE TABLE conversation_read_cursors(key TEXT, reader_scope TEXT, read_sequence INTEGER);
    `);
    const command = ledger.prepare("INSERT INTO managed_commands VALUES (?, ?, ?, ?)");
    command.run(
      sessionId,
      "dispatched",
      JSON.stringify({
        operation: "settings",
        executionMode: "claude-managed",
        secret: privateMarker,
      }),
      null,
    );
    command.run(
      sessionId,
      "resolved",
      JSON.stringify({ operation: privateMarker, executionMode: privateMarker }),
      privateMarker,
    );
    command.run("different-session", "prepared", "{}", null);
    ledger.prepare("INSERT INTO claude_host_states VALUES (?, ?)").run(
      sessionId,
      JSON.stringify({
        paused: false,
        settings: { permissionMode: "auto", model: privateMarker },
        work: [
          { kind: "queue", status: "pending", input: privateMarker, requiresAttachments: true },
          { kind: "report", status: "dispatched", input: privateMarker },
        ],
      }),
    );
    ledger
      .prepare("INSERT INTO orchestration_leads VALUES (?, ?)")
      .run(sessionId, JSON.stringify({ pendingReports: [privateMarker], paused: true }));

    const key = createHash("sha256")
      .update(
        JSON.stringify([
          "claude-code",
          process.platform === "win32" ? data.toLowerCase() : data,
          nativeId,
        ]),
      )
      .digest("hex");
    const cursor = ledger.prepare("INSERT INTO conversation_read_cursors VALUES (?, ?, ?)");
    cursor.run(key, "local", 0);
    cursor.run(key, "account:" + privateMarker, 117);
    cursor.run(privateMarker, "local", 0);
  } finally {
    if (!wal) ledger.close();
  }

  const catalog = new DatabaseSync(path.join(data, "agentkib.db"));
  try {
    catalog.exec(`
      CREATE TABLE workspaces(id TEXT);
      INSERT INTO workspaces VALUES ('synthetic-workspace');
      CREATE TABLE conversation_sessions(id TEXT);
      INSERT INTO conversation_sessions VALUES ('one'), ('two');
    `);
  } finally {
    catalog.close();
  }

  return {
    root,
    data,
    ledgerPath,
    managed,
    transcript,
    args: ["--data-dir", data, "--session-id", sessionId, "--transcript", transcript],
  };
}

function assertShape(report) {
  assert.equal(report.consistency, "independent-sources");
  assert.equal(report.managed.terminalHandover, true);
  assert.deepEqual(report.managed.snapshot, {
    status: "outcome-unknown",
    turnOrigin: "host",
    lastOutcome: "absent",
    turnId: "string",
    terminalResult: "object",
    terminalResultMatchesTurn: true,
    terminalResultSuccess: false,
  });
  assert.deepEqual(report.ledger.receipts.commands, [
    {
      phase: "dispatched",
      evidence: {
        status: "ok",
        operation: "settings",
        executionMode: "claude-managed",
        turnId: "absent",
      },
      hasResult: false,
    },
    {
      phase: "resolved",
      evidence: { status: "ok", operation: "other", executionMode: "other", turnId: "absent" },
      hasResult: true,
    },
  ]);
  assert.deepEqual(report.ledger.host.work, [
    { kind: "queue", status: "pending", requiresAttachments: true },
    { kind: "report", status: "dispatched", requiresAttachments: "absent" },
  ]);
  assert.equal(report.ledger.lead.pendingReports, 1);
  assert.deepEqual(report.ledger.readCursors.scopes, [
    { scope: "account", rows: 1, advanced: 1 },
    { scope: "local", rows: 1, advanced: 0 },
  ]);
  assert.deepEqual(report.bridge.bindings, [
    { revoked: false, inflight: "object", hasInflightTurn: true },
  ]);
  assert.equal(report.bridge.liveLease, "not-observed");
  assert.deepEqual(report.catalog.tables, {
    workspaces: 1,
    conversation_sessions: 2,
    conversation_collection_sessions: "missing",
  });
  assert.equal(report.transcript.status, "ok");
  const serialized = JSON.stringify(report);
  for (const privateValue of [privateMarker, sessionId, nativeId, "api_key", "different-session"]) {
    assert.ok(!serialized.includes(privateValue));
  }
}

test("captures intersecting managed, receipt, queue and catalog shapes from one session", (t) => {
  const fixture = setup(t);
  const report = captureSessionShape({
    root: fixture.data,
    sessionId,
    transcript: fixture.transcript,
  });
  assertShape(report);
  assert.deepEqual(readdirSync(path.dirname(fixture.ledgerPath)), ["executions.sqlite"]);
});

test("refuses unrelated or linked input instead of falling back to another session", (t) => {
  const fixture = setup(t);
  const wrongTranscript = path.join(fixture.data, "wrong.jsonl");
  writeFileSync(wrongTranscript, JSON.stringify({ type: "user", text: privateMarker }) + "\n");
  const options = { root: fixture.data, sessionId, transcript: wrongTranscript };
  assert.deepEqual(captureSessionShape(options).transcript, { status: "mismatch" });
  rmSync(fixture.managed);
  if (process.platform === "win32") {
    const directory = path.join(fixture.root, "link-target");
    mkdirSync(directory);
    symlinkSync(directory, fixture.managed, "junction");
  } else symlinkSync(wrongTranscript, fixture.managed);
  assert.deepEqual(captureSessionShape(options).managed, { status: "unavailable" });
});

test("preserves old dispatched receipts and self-turn waiting states", (t) => {
  const fixture = setup(t);
  const ledger = new DatabaseSync(fixture.ledgerPath);
  try {
    const append = ledger.prepare(
      "INSERT INTO managed_commands VALUES (?, 'resolved', '{}', NULL)",
    );
    for (let index = 0; index < 130; index++) append.run(sessionId);
  } finally {
    ledger.close();
  }
  const record = JSON.parse(readFileSync(fixture.managed, "utf8"));
  for (const status of ["waiting-input", "waiting-approval"]) {
    Object.assign(record.snapshot, { status, turnOrigin: "self", lastOutcome: null });
    writeFileSync(fixture.managed, JSON.stringify(record));
    const report = captureSessionShape({
      root: fixture.data,
      sessionId,
      transcript: fixture.transcript,
    });
    assert.equal(report.managed.snapshot.status, status);
    assert.equal(report.managed.snapshot.turnOrigin, "self");
    assert.equal(report.managed.snapshot.lastOutcome, null);
    assert.equal(report.ledger.receipts.limited, true);
    assert.equal(report.ledger.receipts.commands.length, 128);
    assert.equal(report.ledger.receipts.commands[0].phase, "dispatched");
    assert.equal(report.ledger.receipts.commands[0].evidence.operation, "settings");
  }
});

function runCli(fixture) {
  return spawnSync(process.execPath, [cli, ...fixture.args], {
    cwd: fixture.root,
    encoding: "utf8",
    timeout: 20_000,
  });
}

test(
  "macOS command sees committed WAL rows and writes only a private projection",
  {
    skip: process.platform !== "darwin",
  },
  (t) => {
    const fixture = setup(t, true);
    const observedFiles = [
      fixture.managed,
      fixture.transcript,
      fixture.ledgerPath,
      fixture.ledgerPath + "-wal",
      fixture.ledgerPath + "-shm",
    ];
    const before = observedFiles.map((file) => ({
      digest: createHash("sha256").update(readFileSync(file)).digest("hex"),
      mode: statSync(file).mode,
    }));

    const result = runCli(fixture);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^designs\/shapes\/session-shape-[a-z0-9-]+\.json\n$/);
    const reportPath = path.join(fixture.root, result.stdout.trim());
    assert.equal(statSync(reportPath).mode & 0o777, 0o600);
    assertShape(JSON.parse(readFileSync(reportPath, "utf8")));

    assert.deepEqual(
      observedFiles.map((file) => ({
        digest: createHash("sha256").update(readFileSync(file)).digest("hex"),
        mode: statSync(file).mode,
      })),
      before,
    );
    assert.deepEqual(readdirSync(path.dirname(fixture.ledgerPath)).sort(), [
      "executions.sqlite",
      "executions.sqlite-shm",
      "executions.sqlite-wal",
    ]);
  },
);

test(
  "macOS command cannot write its report inside a source",
  {
    skip: process.platform !== "darwin",
  },
  (t) => {
    const fixture = setup(t);
    writeFileSync(path.join(fixture.data, ".git"), "synthetic-checkout");
    const result = runCli({ ...fixture, root: fixture.data });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(existsSync(path.join(fixture.data, "designs")), false);
  },
);

test("command errors never echo input paths or values", (t) => {
  const fixture = setup(t);
  const result = runCli({ ...fixture, args: ["--unknown-input", privateMarker] });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(privateMarker), false);
  assert.equal(existsSync(path.join(fixture.root, "designs")), false);
});
