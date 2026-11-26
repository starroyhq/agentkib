// @vitest-environment node
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ opens: 0, bytes: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      io.opens++;
      const read = handle.read.bind(handle);
      handle.read = (async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        io.bytes += result.bytesRead;
        return result;
      }) as FileHandle["read"];
      return handle;
    },
  };
});

import { openSessionLog } from "../../../packages/backend/src/session-log-reader";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

const fixtures: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agentkib-shared-log-"));
  fixtures.push(directory);
  return join(directory, "session.jsonl");
}
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { force: true, recursive: true });
  io.opens = io.bytes = 0;
});

async function read(file: string, offset: number, length: number) {
  const reader = await openSessionLog(file);
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await reader.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString();
  } finally {
    await reader.close();
  }
}

it("shares a descriptor and concurrent physical reads for the same transcript", async () => {
  const file = fixture();
  writeFileSync(file, "synthetic\n");
  expect(await Promise.all([read(file, 0, 10), read(file, 0, 10)])).toEqual([
    "synthetic\n",
    "synthetic\n",
  ]);
  expect(io.opens).toBe(1);
  expect(io.bytes).toBe(10);
});

it("reuses the old bytes after append and discards them after rewrite, truncate or replace", async () => {
  const file = fixture();
  const prefix = "a".repeat(10_000);
  writeFileSync(file, prefix);
  expect(await read(file, 0, prefix.length)).toBe(prefix);
  appendFileSync(file, "next");
  io.bytes = 0;
  expect(await read(file, 0, prefix.length + 4)).toBe(prefix + "next");
  expect(io.bytes).toBeLessThanOrEqual(2048 + 4);

  const oldModified = statSync(file).mtimeMs;
  writeFileSync(file, "b" + prefix.slice(1) + "next");
  // Linux can give two writes in one filesystem tick the same version stamps.
  const rewrittenAt = new Date(oldModified - 60_000);
  utimesSync(file, rewrittenAt, rewrittenAt);
  expect(await read(file, 0, 1)).toBe("b");
  writeFileSync(file, "c");
  expect(await read(file, 0, 4)).toBe("c");
  const replacement = `${file}.new`;
  writeFileSync(replacement, "d");
  renameSync(replacement, file);
  expect(await read(file, 0, 1)).toBe("d");
});

it("opens a 1 GiB Claude transcript from the tail and paginates past the recent twenty turns", async () => {
  const file = fixture();
  writeFileSync(file, "\n");
  truncateSync(file, 1024 ** 3);
  const row = (i: number) =>
    JSON.stringify({
      type: "user",
      uuid: `user-${i}`,
      message: { role: "user", content: `Message ${i}` },
    });
  appendFileSync(file, "\n" + Array.from({ length: 27 }, (_, i) => row(i)).join("\n") + "\n");
  const paging = new SessionPaging();
  try {
    const start = performance.now();
    const pending = paging.readTranscript(file, null, 100, "claude-code", {}, true);
    const heartbeat = setImmediate().then(() => performance.now() - start);
    const first = await pending;
    expect(await heartbeat).toBeLessThan(50);
    expect(io.bytes).toBeLessThanOrEqual(4 * 1024 ** 2);
    expect(first.events.map(({ content }) => content)).toEqual(
      Array.from({ length: 20 }, (_, i) => `Message ${i + 7}`),
    );
    expect(first.next_cursor).toBeTruthy();
    const older = await paging.readTranscript(file, first.next_cursor, 7, "claude-code", {}, true);
    expect(older.events.map(({ content }) => content)).toEqual(
      Array.from({ length: 7 }, (_, i) => `Message ${i}`),
    );
  } finally {
    paging.clear();
  }
});
