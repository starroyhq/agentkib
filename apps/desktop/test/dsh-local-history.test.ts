// @vitest-environment node
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { constants as zlib, zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  readLocalDshHistory,
  readLocalDshTurn,
} from "../../../packages/backend/src/dsh-local-history";

const nativeId = "session-a";
const logName = "session.v4.jsonl.zstd";
const header = { type: "session", version: 4, id: nativeId, cwd: "/work", createdAt: 123 };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ak-dsh-history-"));
  roots.push(root);
  return root;
}

function encode(...items: unknown[]) {
  return zstdCompressSync(Buffer.from(items.map((item) => JSON.stringify(item)).join("\n") + "\n"));
}

describe("DSH local history", () => {
  it("pages projected native records across frames and ignores an unfinished line", async () => {
    const dir = fixture();
    const nativeOnly = {
      seq: 2,
      type: "system/message",
      data: { content: randomBytes(128 * 1024).toString("base64") },
    };
    const assistant = {
      seq: 3,
      type: "assistant/message",
      data: { turn: 1, message: { content: [{ type: "text", text: "收到" }] } },
    };
    const appending = encode({ seq: 4, type: "turn/end", data: { turn: 1 } });
    const initial = encode(header, { seq: 1, type: "turn/start", data: { turn: 1 } }, nativeOnly);
    expect(initial.length).toBeGreaterThan(64 * 1024);
    writeFileSync(
      path.join(dir, logName),
      Buffer.concat([initial, encode(assistant), appending.subarray(0, appending.length - 8)]),
    );
    const page = await readLocalDshHistory(dir, nativeId, undefined, 1);
    expect(page).toMatchObject({
      sessionId: nativeId,
      cwd: "/work",
      createdAt: 123,
      cursor: 3,
      nextBefore: 3,
      records: [{ seq: 3, kind: "assistant", text: "收到" }],
    });
    expect(await readLocalDshHistory(dir, nativeId, page!.nextBefore!, 1)).toMatchObject({
      cursor: 3,
      nextBefore: null,
      records: [{ seq: 1, kind: "turn-start" }],
    });
  });

  it("applies the bridge's hidden command filtering across pages", async () => {
    const dir = fixture();
    writeFileSync(
      path.join(dir, logName),
      encode(
        header,
        { seq: 1, type: "turn/start", data: { turn: 1 } },
        { seq: 2, type: "command/run", data: { commandId: "a", name: "permission" } },
        { seq: 3, type: "command/run", data: { commandId: "b", name: "permission" } },
        { seq: 4, type: "command/done", data: { commandId: "a", kind: "success" } },
        { seq: 5, type: "command/done", data: { commandId: "b", kind: "error" } },
      ),
    );
    expect(
      (await readLocalDshHistory(dir, nativeId, 4, 10))?.records.map(({ seq }) => seq),
    ).toEqual([1, 3]);
    expect(
      (await readLocalDshHistory(dir, nativeId, undefined, 10))?.records.map(({ seq }) => seq),
    ).toEqual([1, 3, 5]);
  });

  it("rejects a mismatched native id and unknown versions", async () => {
    const dir = fixture();
    const log = path.join(dir, logName);
    writeFileSync(log, encode({ ...header, id: "other" }));
    expect(await readLocalDshHistory(dir, nativeId, undefined, 10)).toBeNull();
    writeFileSync(log, encode({ ...header, version: 3 }));
    expect(await readLocalDshHistory(dir, nativeId, undefined, 10)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("rejects a linked history source", async () => {
    const dir = fixture();
    const log = path.join(dir, logName);
    const other = path.join(dir, "other");
    writeFileSync(other, encode(header));
    symlinkSync(other, log);
    expect(await readLocalDshHistory(dir, nativeId, undefined, 10)).toBeNull();
  });
});

describe("DSH persisted turn evidence", () => {
  const started = { seq: 1, type: "turn/start", time: 100, data: { turn: 3 } };
  const ended = {
    seq: 3,
    type: "turn/end",
    time: 120,
    data: { turn: 3, reason: { kind: "completed" } },
  };

  it("keeps an open turn across native-only appends and clears it only on its end", async () => {
    const dir = fixture();
    const log = path.join(dir, logName);
    writeFileSync(log, encode(header, started));
    const first = (await readLocalDshTurn(dir, nativeId))!;
    expect(first).toMatchObject({ seq: 1, lastEventAt: 100, open: { turn: 3, startedAt: 100 } });
    expect(await readLocalDshTurn(dir, nativeId, first)).toBe(first);
    appendFileSync(log, encode({ seq: 2, time: 110, type: "job/registered", data: {} }));
    const next = (await readLocalDshTurn(dir, nativeId, first))!;
    expect(next).toMatchObject({ seq: 2, lastEventAt: 110, open: first.open, ino: first.ino });

    appendFileSync(log, encode(ended));
    expect(await readLocalDshTurn(dir, nativeId, next)).toMatchObject({
      seq: 3,
      lastEventAt: 120,
      open: null,
      ino: first.ino,
    });
  });

  it("waits for a complete compressed frame before advancing a checkpoint", async () => {
    const dir = fixture();
    const log = path.join(dir, logName);
    writeFileSync(log, encode(header, started, { seq: 2, time: 115, type: "step/end" }));
    const first = (await readLocalDshTurn(dir, nativeId))!;
    expect(first).toMatchObject({ seq: 2, open: { turn: 3, startedAt: 100 } });

    const endingFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(ended)}\n`), {
      params: { [zlib.ZSTD_c_checksumFlag]: 1 },
    });
    appendFileSync(log, endingFrame.subarray(0, -1));
    expect(await readLocalDshTurn(dir, nativeId, first)).toBeNull();
    appendFileSync(log, endingFrame.subarray(-1));
    expect(await readLocalDshTurn(dir, nativeId, first)).toMatchObject({ seq: 3, open: null });
  });

  it("revalidates the header when the file is replaced, including an equally sized generation", async () => {
    const dir = fixture();
    const log = path.join(dir, logName);
    const replacement = path.join(dir, "new-generation");
    writeFileSync(log, encode(header, started));
    const first = (await readLocalDshTurn(dir, nativeId))!;
    expect(await readLocalDshTurn(dir, "other", first)).toBeNull();
    writeFileSync(replacement, encode(header, { ...started, data: { turn: 4 } }));
    renameSync(replacement, log);
    const next = (await readLocalDshTurn(dir, nativeId, first))!;
    expect(next).toMatchObject({ seq: 1, open: { turn: 4, startedAt: 100 } });
    expect(next.ino).not.toBe(first.ino);

    writeFileSync(replacement, encode({ ...header, id: "unrelated" }));
    renameSync(replacement, log);
    expect(await readLocalDshTurn(dir, nativeId, next)).toBeNull();
  });

  it("rejects an append with a gap or an end belonging to another turn", async () => {
    const dir = fixture();
    const log = path.join(dir, logName);
    writeFileSync(log, encode(header, started));
    const first = (await readLocalDshTurn(dir, nativeId))!;
    appendFileSync(log, encode(ended)); // The sequence skips 2.
    expect(await readLocalDshTurn(dir, nativeId, first)).toBeNull();
    writeFileSync(log, encode(header, started, { ...ended, seq: 2, data: { turn: 9 } }));
    expect(await readLocalDshTurn(dir, nativeId)).toBeNull();
  });
});
