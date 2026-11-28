import assert from "node:assert/strict";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  captureTranscriptShape,
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_RECORD_BYTES,
  MAX_TRANSCRIPT_RECORDS,
} from "../../qa/probes/session-shape-transcript.mjs";

function fixture(t, name = "private-file-name.jsonl") {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkib-shape-transcript-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, name);
}

test("capture preserves safe sequence, types and relationships, without input keys or values", (t) => {
  const file = fixture(t);
  const secret = "PRIVATE_test_value";
  const uuid = "2b15bf37-951b-4642-b432-deb95616e034";
  const assistantId = "614b80e2-9a1e-4ba9-9372-4b7a141ac828";
  const sessionId = "ae688092-dabc-4406-ab7d-a2a46a612f71";
  const toolId = "toolu_TEST_PRIVATE_ID";
  const input = [
    {
      type: "user",
      uuid,
      sessionId,
      parentUuid: null,
      isMeta: true,
      cwd: `/tmp/${secret}`,
      message: { role: "user", content: [{ type: "text", text: secret }] },
    },
    { type: "permission-mode", permissionMode: secret },
    { type: "custom-title", customTitle: secret },
    {
      type: "assistant",
      entrypoint: "sdk-cli",
      uuid: assistantId,
      parentUuid: uuid,
      sessionId,
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        model: secret,
        content: [{ type: "tool_use", id: toolId, input: { [secret]: [secret] } }],
      },
    },
    {
      type: "user",
      parentUuid: assistantId,
      sessionId,
      message: { content: [{ type: "tool_result", tool_use_id: toolId, content: secret }] },
    },
    { type: "system", subtype: "turn_duration", error: null },
    { type: "api-request-blob", data: { [secret]: [secret, { Authorization: secret }] } },
    { type: secret, subtype: secret, entrypoint: secret, request: [], [secret]: secret },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n");
  const bytes = Buffer.from(`${input}\n{\"${secret}\":}\n{\"type\":\"${secret}`);
  writeFileSync(file, bytes);

  const result = captureTranscriptShape(file);
  assert.equal(result.status, "ok");
  assert.equal(result.bytesRead, bytes.length);
  assert.equal(result.byteLength, bytes.length);
  assert.deepEqual(result.coverage, {
    earlierBytesOmitted: false,
    earlierLinesOmitted: false,
    trailingPartialLine: true,
    oversizedLines: 0,
    malformedLines: 1,
  });
  assert.deepEqual(
    result.records.map(({ type }) => type),
    [
      "user",
      "permission-mode",
      "custom-title",
      "assistant",
      "user",
      "system",
      "api-request-blob",
      "other",
    ],
  );
  const [user, permission, title, assistant, answer, system, blob, unknown] = result.records;
  assert.equal(user.fields.parentUuid, "null");
  assert.equal(user.fields.isMeta, "boolean");
  assert.deepEqual(user.flags, { isMeta: true });
  assert.equal(user.message.blocks[0].fields.text, "string");
  assert.equal(permission.fields.permissionMode, "string");
  assert.equal(title.fields.customTitle, "string");
  assert.equal(assistant.entrypoint, "sdk-cli");
  assert.equal(assistant.parent, user.record);
  assert.equal(answer.parent, assistant.record);
  assert.equal(assistant.session, user.session);
  assert.equal(answer.session, user.session);
  assert.equal(assistant.message.stopReason, "tool_use");
  assert.equal(assistant.message.blocks[0].tool, answer.message.blocks[0].toolResultFor);
  assert.equal(system.fields.error, "null");
  assert.equal(blob.fields.data, "object");
  assert.equal(unknown.fields.request, "array");
  assert.equal(unknown.subtype, "other");
  assert.equal(unknown.entrypoint, "other");
  const serialized = JSON.stringify(result);
  for (const value of [file, secret, uuid, assistantId, sessionId, toolId, "Authorization"]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.deepEqual(readFileSync(file), bytes);
});

test("capture reads only a bounded tail and skips an oversized complete row", (t) => {
  const file = fixture(t);
  const largeRow = `{"type":"api-request-blob","data":"${"a".repeat(MAX_TRANSCRIPT_RECORD_BYTES)}"}`;
  const tail = Buffer.from(
    `\n${largeRow}\n{"type":"file-history-snapshot"}\n{"type":"assistant"}\n`,
  );
  // Exercise GiB offsets in a sparse file without allocating a GiB on Windows filesystems.
  const size = process.platform === "win32" ? 2 * MAX_TRANSCRIPT_BYTES : 1024 ** 3;
  const descriptor = openSync(file, "wx", 0o600);
  try {
    assert.equal(writeSync(descriptor, tail, 0, tail.length, size - tail.length), tail.length);
  } finally {
    closeSync(descriptor);
  }

  const result = captureTranscriptShape(file);
  assert.equal(result.status, "ok");
  assert.equal(result.byteLength, size);
  assert.equal(result.bytesRead, MAX_TRANSCRIPT_BYTES);
  assert.equal(result.coverage.earlierBytesOmitted, true);
  assert.equal(result.coverage.trailingPartialLine, false);
  assert.equal(result.coverage.oversizedLines, 1);
  assert.deepEqual(
    result.records.map(({ type }) => type),
    ["file-history-snapshot", "assistant"],
  );
});

test("capture bounds record and content-block counts and keeps the most recent lines", (t) => {
  const file = fixture(t);
  const content = Array.from({ length: 70 }, () => ({ type: "text", text: "synthetic" }));
  writeFileSync(
    file,
    `{"type":"user"}\n${'{"type":"progress"}\n'.repeat(MAX_TRANSCRIPT_RECORDS - 1)}${JSON.stringify({ type: "assistant", message: { content } })}\n`,
  );

  const result = captureTranscriptShape(file);
  assert.equal(result.status, "ok");
  assert.equal(result.coverage.earlierLinesOmitted, true);
  assert.equal(result.records.length, MAX_TRANSCRIPT_RECORDS);
  assert.equal(result.records[0].type, "progress");
  assert.equal(result.records.at(-1).message.blockCount, 70);
  assert.equal(result.records.at(-1).message.blocks.length, 64);
});

test("capture reserves a shared block budget for the newest lines", (t) => {
  const file = fixture(t);
  const content = Array.from({ length: 64 }, () => ({ type: "text", text: "synthetic" }));
  writeFileSync(
    file,
    (JSON.stringify({ type: "assistant", message: { content } }) + "\n").repeat(40),
  );

  const { records } = captureTranscriptShape(file);
  assert.deepEqual(
    records.map(({ message }) => [message.blockCount, message.blocks.length]),
    [...Array(8).fill([64, 0]), ...Array(32).fill([64, 64])],
  );
});

test("capture reports missing, unsafe, and empty inputs without filesystem details", (t) => {
  const file = fixture(t);
  assert.deepEqual(captureTranscriptShape(file), { status: "missing" });
  const directoryInput = path.join(path.dirname(file), "not-a-file.jsonl");
  mkdirSync(directoryInput);
  assert.deepEqual(captureTranscriptShape(directoryInput), { status: "unavailable" });
  writeFileSync(file, "");
  const result = captureTranscriptShape(file);
  assert.equal(result.status, "ok");
  assert.equal(result.coverage.trailingPartialLine, false);
  assert.deepEqual(result.records, []);

  const link = path.join(path.dirname(file), "not-a-transcript.jsonl");
  if (process.platform === "win32") symlinkSync(directoryInput, link, "junction");
  else symlinkSync(file, link);
  assert.deepEqual(captureTranscriptShape(link), { status: "unavailable" });
});
