import type { DshBridgeHistoryPage, DshBridgeHistoryRecord } from "@agentkib/runtime-protocol";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { constants as zlib, createZstdDecompress } from "node:zlib";
import { DSH_HIDDEN_COMMANDS } from "../../dsh-bridge-plugin/commands.js";
import { historyRecord } from "../../dsh-bridge-plugin/projection.js";
import { isReparseOrSymlink } from "./native-files";

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const MAX_HISTORY_PAGE_CHARS = 1536 * 1024;
const MAX_PENDING_COMMANDS = 128;
const MAX_READ_MS = 5_000;

async function readLocalDshLog<T>(
  directory: string,
  read: (handle: FileHandle, stat: Stats, file: string) => Promise<T | null>,
): Promise<T | null> {
  const file = path.join(directory, "session.v4.jsonl.zstd");
  try {
    const listed = await lstat(file);
    if (!listed.isFile() || listed.nlink !== 1 || isReparseOrSymlink(file, listed)) return null;
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (
        stat.dev !== listed.dev ||
        stat.ino !== listed.ino ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (process.getuid && stat.uid !== process.getuid()) ||
        stat.size === 0 ||
        stat.size > MAX_COMPRESSED_BYTES
      )
        return null;

      return await read(handle, stat, file);
    } finally {
      await handle.close();
    }
  } catch {
    // Unsupported and damaged files, or a budget hit, leave the last successful cache usable.
    return null;
  }
}

async function decodeDshLog(
  handle: FileHandle,
  start: number,
  size: number,
  readLine: (line: string) => void,
  complete: boolean,
): Promise<void> {
  let bytes = 0;
  let partial = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // The read is bounded to the opened size even while DSH appends to it.
  await pipeline(
    handle.createReadStream({ start, end: size - 1, autoClose: false }),
    createZstdDecompress({ finishFlush: complete ? zlib.ZSTD_e_end : zlib.ZSTD_e_continue }),
    async (chunks: AsyncIterable<Buffer>) => {
      for await (const chunk of chunks) {
        bytes += chunk.length;
        if (bytes > MAX_DECODED_BYTES) throw new Error("dsh-history-byte-limit");
        const lines = (partial + decoder.decode(chunk, { stream: true })).split("\n");
        partial = lines.pop()!;
        if (partial.length > MAX_LINE_CHARS) throw new Error("dsh-history-line-limit");
        for (const line of lines) {
          if (line.length > MAX_LINE_CHARS) throw new Error("dsh-history-line-limit");
          if (line) readLine(line);
        }
      }
    },
    { signal: AbortSignal.timeout(MAX_READ_MS) },
  );
  if (complete && (partial || decoder.decode())) throw new Error("dsh-history-incomplete-line");
}

function isDshLogHeader(event: Record<string, unknown>, nativeId: string): boolean {
  return event.type === "session" && event.version === 4 && event.id === nativeId;
}

/** Reads a fixed snapshot of the rc.5 history file under a verified DSH session directory. */
export async function readLocalDshHistory(
  directory: string,
  nativeId: string,
  before: number | undefined,
  limit: number,
): Promise<DshBridgeHistoryPage | null> {
  return readLocalDshLog(directory, async (handle, stat) => {
    const pageSize = Math.min(Math.max(limit, 1), 100);
    const records: DshBridgeHistoryRecord[] = [];
    const pending = new Map<string, DshBridgeHistoryRecord>();
    let header: { cwd: string | null; createdAt: number | null } | undefined;
    let cursor = -1;

    const retain = (record: DshBridgeHistoryRecord) => {
      records.push(record);
      // A failed or unfinished hidden command is kept at its original sequence.
      if (records.length > 1 && records.at(-2)!.seq > record.seq)
        records.sort((a, b) => a.seq - b.seq);
      if (records.length > pageSize + 1) records.shift();
    };
    const readLine = (line: string) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (!header) {
        if (!isDshLogHeader(event, nativeId)) throw new Error("dsh-history-header-unknown");
        header = {
          cwd: typeof event.cwd === "string" ? event.cwd : null,
          createdAt: typeof event.createdAt === "number" ? event.createdAt : null,
        };
        return;
      }
      const seq = event.seq;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= cursor)
        throw new Error("dsh-history-sequence-invalid");
      cursor = seq;

      const inPage = before === undefined || seq < before;
      if (!inPage && event.type !== "command/done") return;
      const record = historyRecord(event);
      if (!record) return;
      if (record.kind === "command" && DSH_HIDDEN_COMMANDS.includes(record.name)) {
        if (pending.size >= MAX_PENDING_COMMANDS) throw new Error("dsh-history-command-limit");
        pending.set(record.commandId, record);
        return;
      }
      if (record.kind === "command-result") {
        const command = pending.get(record.commandId);
        if (command) {
          pending.delete(record.commandId);
          if (record.ok) return;
          retain(command);
        }
      }
      if (inPage) retain(record);
    };

    // History can still project complete lines from an incomplete trailing compressed frame.
    await decodeDshLog(handle, 0, stat.size, readLine, false);
    if (!header) return null;
    for (const command of pending.values()) retain(command);
    let pageChars = 0;
    let first = records.length;
    while (first > 0 && records.length - first < pageSize) {
      pageChars += JSON.stringify(records[first - 1]).length;
      if (first < records.length && pageChars > MAX_HISTORY_PAGE_CHARS) break;
      first -= 1;
    }
    return {
      sessionId: nativeId,
      ...header,
      cursor: Math.max(0, cursor),
      records: records.slice(first),
      nextBefore: first > 0 ? (records[first]?.seq ?? null) : null,
    };
  });
}

/** A validated event boundary at the end of a complete compressed frame. */
export type DshLocalTurnCheckpoint = {
  nativeId: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  seq: number;
  lastEventAt: number | null;
  open: { turn: number; startedAt: number } | null;
};

/**
 * Reads only turn evidence from persisted events. A validated end offset can
 * start the next read because DSH appends an independent Zstandard frame per batch.
 * A partial frame never advances the checkpoint or reports a new turn.
 */
export async function readLocalDshTurn(
  directory: string,
  nativeId: string,
  previous?: DshLocalTurnCheckpoint,
): Promise<DshLocalTurnCheckpoint | null> {
  return readLocalDshLog(directory, async (handle, stat, file) => {
    const sameFile =
      previous &&
      previous.nativeId === nativeId &&
      previous.dev === stat.dev &&
      previous.ino === stat.ino;
    if (sameFile && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs)
      return previous;
    const checkpoint = sameFile && previous.size < stat.size ? previous : undefined;
    let headerSeen = !!checkpoint;
    let seq = checkpoint?.seq ?? -1;
    let lastEventAt = checkpoint?.lastEventAt ?? null;
    let openTurn = checkpoint?.open ?? null;

    await decodeDshLog(
      handle,
      checkpoint?.size ?? 0,
      stat.size,
      (line) => {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (!headerSeen) {
          if (!isDshLogHeader(event, nativeId)) throw new Error("dsh-history-header-unknown");
          headerSeen = true;
          return;
        }
        const next = event.seq;
        if (
          typeof next !== "number" ||
          !Number.isSafeInteger(next) ||
          next < 0 ||
          (seq >= 0 && next !== seq + 1)
        )
          throw new Error("dsh-history-sequence-invalid");
        seq = next;

        const time = event.time;
        if (typeof time === "number" && Number.isFinite(time)) lastEventAt = time;
        if (event.type !== "turn/start" && event.type !== "turn/end") return;
        const turn = (event.data as { turn?: unknown } | null)?.turn;
        if (
          typeof turn !== "number" ||
          !Number.isSafeInteger(turn) ||
          turn <= 0 ||
          typeof time !== "number" ||
          !Number.isFinite(time)
        )
          throw new Error("dsh-history-turn-invalid");
        if (event.type === "turn/start") {
          if (openTurn) throw new Error("dsh-history-unbalanced-turn");
          openTurn = { turn, startedAt: time };
        } else {
          if (openTurn?.turn !== turn) throw new Error("dsh-history-unbalanced-turn");
          openTurn = null;
        }
      },
      true,
    );

    if (!headerSeen) return null;
    const current = await lstat(file);
    if (
      current.dev !== stat.dev ||
      current.ino !== stat.ino ||
      current.size < stat.size ||
      (current.size === stat.size && current.mtimeMs !== stat.mtimeMs)
    )
      return null;
    return {
      nativeId,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      seq,
      lastEventAt,
      open: openTurn,
    };
  });
}
