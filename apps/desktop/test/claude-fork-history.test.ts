// @vitest-environment node
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { readClaudeForkHistory } from "../../../packages/backend/src/agents/claude/claude-fork-history";
import {
  openSessionLog,
  SESSION_LOG_BLOCK_BYTES,
} from "../../../packages/backend/src/session-log-reader";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("finds only the appropriate native cutoff in the tail of a sparse 1 GiB transcript", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ak-claude-fork-tail-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "fixture.jsonl");
  const sessionId = randomUUID();
  const user = randomUUID();
  const assistant = randomUUID();
  const next = randomUUID();
  const tail = Buffer.from(
    "\n" +
      [
        { type: "user", sessionId, uuid: user },
        { type: "assistant", sessionId, uuid: assistant, message: { stop_reason: "end_turn" } },
        { type: "user", sessionId, uuid: next },
        { type: "unknown", sessionId, data: "x".repeat(128 * 1024) },
        { type: "assistant", sessionId: randomUUID(), uuid: randomUUID() },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
  );
  const fd = openSync(transcript, "w");
  try {
    // Leave a sparse prefix and make the final row valid even without a newline.
    writeSync(fd, tail, 0, tail.length, 1024 ** 3 - tail.length);
  } finally {
    closeSync(fd);
  }
  const started = performance.now();
  let finished = false;
  const read = readClaudeForkHistory(transcript, sessionId, /^[0-9a-f-]{36}$/, true).finally(() => {
    finished = true;
  });
  await setImmediate();
  expect(finished).toBe(false);
  expect(await read).toMatchObject({ anchor: { type: "user", uuid: next }, userUuid: next });
  expect(
    await readClaudeForkHistory(transcript, sessionId, /^[0-9a-f-]{36}$/, false),
  ).toMatchObject({ anchor: { type: "assistant", uuid: assistant }, userUuid: next });
  expect(performance.now() - started).toBeLessThan(1000);
});

it("does not admit a fork cutoff from earlier cached bytes after a rewrite and append", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ak-claude-fork-proof-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const transcript = path.join(root, "fixture.jsonl");
  const sessionId = randomUUID();
  const stale = randomUUID();
  const current = randomUUID();
  const row = (uuid: string) =>
    JSON.stringify({ type: "assistant", sessionId, uuid, message: { stop_reason: "end_turn" } }) +
    "\n";
  const spacer = " ".repeat(SESSION_LOG_BLOCK_BYTES - 1) + "\n";
  const first = spacer + row(stale) + spacer;
  writeFileSync(transcript, first);
  const snapshot = await openSessionLog(transcript);
  try {
    const size = Buffer.byteLength(first);
    expect((await snapshot.read(Buffer.alloc(size), 0, size, 0)).bytesRead).toBe(size);
  } finally {
    await snapshot.close();
  }
  const fd = openSync(transcript, "r+");
  try {
    const replacement = Buffer.from(row(current));
    writeSync(fd, replacement, 0, replacement.length, SESSION_LOG_BLOCK_BYTES);
  } finally {
    closeSync(fd);
  }
  appendFileSync(transcript, "\n");
  expect(await readClaudeForkHistory(transcript, sessionId, /^[0-9a-f-]{36}$/, true)).toMatchObject(
    { anchor: { uuid: current } },
  );
});
