import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const provider = "claude-code";
const mode = "claude-managed";
const title = "Fixture workshop notes";
const createdAt = "2025-08-14T10:00:00.000Z";

function within(directory, file) {
  const relative = path.relative(directory, file);
  return (
    relative &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

function assertFixturePaths(...locations) {
  const paths = locations.map((directory) => realpathSync(directory));
  // macOS tests use both the per-user temporary directory and /private/tmp.
  const bases = [realpathSync(tmpdir())];
  if (process.platform === "darwin") bases.push(realpathSync("/tmp"));
  if (
    !bases.some((base) => {
      if (!paths.every((entry) => within(base, entry))) return false;
      const roots = paths.map((entry) => path.relative(base, entry).split(path.sep)[0]);
      return roots.every((root) => root === roots[0]);
    })
  )
    throw new Error("Shape fixtures require a common temporary sandbox");
  if (paths.some((directory, index) => directory !== locations[index])) {
    throw new Error("Shape fixtures require canonical paths");
  }
}

function privateDirectory(parent, name) {
  const directory = path.join(parent, name);
  if (!lstatSync(directory, { throwIfNoEntry: false })) mkdirSync(directory, { mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw new Error("Invalid fixture directory");
  return directory;
}

function writeJson(file, data) {
  const existing = lstatSync(file, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error("Invalid fixture file");
  writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
}

function transcript(nativeId, workspace, turnId, replyId) {
  const base = { sessionId: nativeId };
  const latest = {
    ...base,
    cwd: workspace,
    timestamp: createdAt,
    entrypoint: "sdk-cli",
    isSidechain: false,
  };
  const prompt = "Draft a two-step fixture checklist.";
  const lines = [];
  const save = (row) => lines.push(JSON.stringify({ ...base, ...row }) + "\n");
  const terminal = { ...latest, entrypoint: "cli" };
  const pastPromptId = randomUUID();
  const pastReplyId = randomUUID();
  save({
    ...terminal,
    type: "user",
    uuid: pastPromptId,
    parentUuid: null,
    message: { role: "user", content: "Start a fixture workshop." },
  });
  save({
    ...terminal,
    type: "assistant",
    uuid: pastReplyId,
    parentUuid: pastPromptId,
    message: {
      id: "msg_" + pastReplyId.replaceAll("-", ""),
      role: "assistant",
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The fixture workshop is ready." }],
    },
  });
  // Keep a larger history than the shape report's record-count window. The filler is
  // fabricated JSONL, with no dependency on the original log or its individual line sizes.
  for (let index = 0; index < 1_152; index++) {
    save({ type: "fixture-cache", index, text: "fixture filler ".repeat(272) });
  }
  save({
    ...latest,
    type: "user",
    uuid: turnId,
    parentUuid: pastReplyId,
    message: { role: "user", content: prompt },
  });
  const attachmentId = randomUUID();
  save({
    ...latest,
    type: "attachment",
    uuid: attachmentId,
    parentUuid: turnId,
    attachment: { type: "fixture-note", content: "Synthetic turn attachment" },
  });
  save({ type: "queue-operation", operation: "dequeue" });
  save({
    type: "api-request-blob",
    hash: "fixture-request",
    message: { role: "user", content: "Synthetic API metadata" },
  });
  save({
    ...latest,
    type: "assistant",
    uuid: replyId,
    parentUuid: attachmentId,
    message: {
      id: "msg_" + replyId.replaceAll("-", ""),
      role: "assistant",
      model: "claude-haiku-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "1. Check the counter. 2. Mark the fixture ready." }],
    },
  });
  save({
    ...latest,
    type: "system",
    subtype: "stop_hook_summary",
    uuid: randomUUID(),
    parentUuid: replyId,
    isMeta: false,
  });
  save({ type: "last-prompt", lastPrompt: prompt });
  save({ type: "custom-title", customTitle: title });
  save({ type: "ai-title", aiTitle: "Fixture checklist" });
  save({ type: "agent-name", agentName: "Fixture assistant" });
  save({ type: "mode", mode: "default" });
  save({ type: "permission-mode", permissionMode: "auto" });
  save({ type: "fixture-footer", bookkeeping: true });
  save({ type: "fixture-close", turnCount: 2 });
  return lines.join("");
}

function stageLedger({
  dataDir,
  home,
  sessionId,
  nativeId,
  workspaceId,
  deviceId,
  previousBootId,
  turnId,
  settingsRequestId,
}) {
  const file = path.join(privateDirectory(dataDir, "codex-managed"), "executions.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const existing = lstatSync(file + suffix, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) throw new Error("Invalid fixture ledger");
  }
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS managed_commands(
        request_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,fingerprint TEXT NOT NULL,
        phase TEXT NOT NULL,result TEXT,evidence TEXT,device_id TEXT NOT NULL,claim_version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claude_host_states(session_id TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_read_cursors(
        key TEXT NOT NULL,reader_scope TEXT NOT NULL,read_sequence INTEGER NOT NULL DEFAULT 0,
        manual_unread INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(key,reader_scope)
      );
    `);
    if (db.prepare("SELECT 1 FROM managed_commands WHERE session_id=? LIMIT 1").get(sessionId)) {
      throw new Error("Shape fixture must have its own session receipts");
    }
    const insert = db.prepare(`
      INSERT INTO managed_commands(request_id,session_id,fingerprint,phase,result,evidence,device_id,claim_version)
      VALUES(?,?,?,?,?,?,?,1)
    `);
    const before = { workspaceId, executionMode: mode, runtimeBootId: previousBootId };
    const put = (requestId, operation, resolved) => {
      const phase = resolved ? "resolved" : "dispatched";
      const result = resolved
        ? JSON.stringify({
            requestId,
            sessionId,
            accepted: true,
            completed: operation === "settings",
            runtimeBootId: previousBootId,
            controlOutcome: "accepted",
          })
        : null;
      const evidence = JSON.stringify({
        ...before,
        operation,
        ...(operation === "send" && { turnId: null }),
      });
      insert.run(
        requestId,
        sessionId,
        createHash("sha256").update(requestId).digest("hex"),
        phase,
        result,
        evidence,
        deviceId,
      );
    };
    for (let index = 0; index < 3; index++) put(randomUUID(), "settings", true);
    put(turnId, "send", true);
    put(settingsRequestId, "settings", false);
    db.prepare("INSERT INTO claude_host_states(session_id,record) VALUES(?,?)").run(
      sessionId,
      JSON.stringify({
        version: 1,
        bootId: previousBootId,
        revision: 1,
        title: null,
        settings: { permissionMode: "auto" },
        paused: false,
        reason: null,
        goal: null,
        work: [],
        settledRequests: [],
      }),
    );
    const key = createHash("sha256")
      .update(JSON.stringify([provider, home, nativeId]))
      .digest("hex");
    db.prepare(
      "INSERT INTO conversation_read_cursors(key,reader_scope,read_sequence) VALUES(?,?,1)",
    ).run(key, `account:fixture-${randomUUID()}`);
    db.exec("COMMIT");
  } finally {
    if (db.isTransaction) db.exec("ROLLBACK");
    db.close();
  }
}

function stageBinding({ dataDir, sessionId, nativeId, workspaceId, workspace }) {
  const file = path.join(privateDirectory(dataDir, "claude-bridge"), "bindings-v1.json");
  const previous = lstatSync(file, { throwIfNoEntry: false });
  if (previous && !previous.isFile()) throw new Error("Invalid fixture binding registry");
  const registry = previous ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, bindings: [] };
  if (registry.bindings.some((binding) => binding.target.sessionId === sessionId)) {
    throw new Error("Shape fixture must have its own binding");
  }
  registry.bindings.push({
    version: 1,
    bindingId: randomUUID(),
    target: { sessionId, nativeId, workspaceId, workspace, registeredWorkspace: workspace },
    token: randomBytes(32).toString("hex"),
    revoked: false,
    inflight: null,
  });
  writeJson(file, registry);
}

/** Materialize a cold, transported session in a private test sandbox with no live writers. */
export function seedClaudeHandoverSettings({
  dataDir,
  workspaceId,
  workspace,
  home,
  sessionId = randomUUID(),
  nativeId = randomUUID(),
  deviceId,
  previousBootId,
}) {
  assertFixturePaths(dataDir, home, workspace);
  if (
    !/^[A-Za-z0-9-]{1,128}$/.test(sessionId) ||
    !/^[a-f0-9-]{36}$/.test(nativeId) ||
    !workspaceId ||
    !deviceId ||
    !previousBootId
  )
    throw new Error("Invalid fixture identifiers");
  const turnId = randomUUID();
  const replyId = randomUUID();
  const settingsRequestId = randomUUID();
  const session = { dataDir, home, workspace, sessionId, nativeId, workspaceId };
  const project = privateDirectory(
    privateDirectory(home, "projects"),
    workspace.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  const transcriptPath = path.join(project, nativeId + ".jsonl");
  writeFileSync(transcriptPath, transcript(nativeId, workspace, turnId, replyId), {
    flag: "wx",
    mode: 0o600,
  });
  stageLedger({ ...session, deviceId, previousBootId, turnId, settingsRequestId });
  stageBinding(session);
  writeJson(path.join(privateDirectory(dataDir, "claude-managed"), sessionId + ".json"), {
    version: 1,
    id: sessionId,
    workspaceId,
    workspace,
    registeredWorkspace: workspace,
    home,
    nativeId,
    title,
    createdAt,
    adopted: true,
    terminalHandover: true,
    released: false,
    fresh: false,
    fingerprint: null,
    snapshot: {
      status: "outcome-unknown",
      turnOrigin: "host",
      turnId,
      lastOutcome: null,
      terminalResult: { turnId, success: true, uuid: replyId },
      reason: "claude-unrequested-turn: Synthetic frame after the completed turn",
      revision: 1,
      sendEnabled: false,
      stopEnabled: false,
      permissionMode: "auto",
    },
    completedRequests: [turnId],
  });
  return { sessionId, nativeId, turnId, settingsRequestId, transcriptPath };
}
