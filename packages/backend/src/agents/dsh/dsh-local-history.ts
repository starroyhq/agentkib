import type { DshBridgeHistoryPage, DshBridgeHistoryRecord } from "@agentkib/runtime-protocol";
import { constants, type Stats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { DSH_HIDDEN_COMMANDS } from "agentkib-dsh-bridge/commands.js";
import {
  createQuestionHistoryProjector,
  historyRecord,
  quitInterruptionId,
} from "agentkib-dsh-bridge/projection.js";
import { isReparseOrSymlink } from "../../native-files";

const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_BYTES = 256 * 1024 * 1024;
const MAX_LINE_CHARS = 4 * 1024 * 1024;
const MAX_HISTORY_PAGE_CHARS = 1536 * 1024;
const MAX_PENDING_COMMANDS = 128;
const MAX_RECENT_HISTORIES = 2;
const MAX_TURN_CHECKPOINTS = 128;
const CHECKPOINT_SAMPLE_BYTES = 512;
const MAX_READ_MS = 5_000;
const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_DICTIONARY_ID_SIZES = [0, 1, 2, 4];

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
        stat.size === 0
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

type ReadSnapshot = (offset: number, length: number) => Promise<Buffer | null>;

// RFC 8878 sections 3.1.1.1–2. DSH writes independently decodable frames. Node 22 can
// lose concatenated frames and accept truncated ones, so establish their bounds first.
async function zstdFrameEnd(read: ReadSnapshot, offset: number, signal: AbortSignal) {
  const header = await read(offset, 5);
  if (!header) return null;
  const descriptor = header[4]!;
  if (header.readUInt32LE() !== ZSTD_MAGIC || (descriptor & 0x08) !== 0)
    throw new Error("dsh-history-invalid-zstd-frame");

  const singleSegment = (descriptor & 0x20) !== 0;
  const hasChecksum = (descriptor & 0x04) !== 0;
  const contentSizeFlag = descriptor >>> 6;
  const contentSizeLength = contentSizeFlag === 0 ? Number(singleSegment) : 1 << contentSizeFlag;
  const dictionaryLength = ZSTD_DICTIONARY_ID_SIZES[descriptor & 0x03]!;
  let blockOffset = offset + 5 + Number(!singleSegment) + dictionaryLength + contentSizeLength;
  for (;;) {
    signal.throwIfAborted();
    const bytes = await read(blockOffset, 3);
    if (!bytes) return null;
    const block = bytes.readUIntLE(0, 3);
    const blockType = (block >>> 1) & 0x03;
    if (blockType === 3) throw new Error("dsh-history-invalid-zstd-block");
    // A run-length block stores one byte, regardless of its decompressed size.
    blockOffset += 3 + (blockType === 1 ? 1 : block >>> 3);
    if ((block & 1) !== 0) return blockOffset + (hasChecksum ? 4 : 0);
  }
}

async function decodeDshLog(
  handle: FileHandle,
  start: number,
  size: number,
  readLine: (line: string) => void,
  complete: boolean,
): Promise<number> {
  if (size - start > MAX_COMPRESSED_BYTES) throw new Error("dsh-history-byte-limit");
  let bytes = 0;
  let offset = start;
  let partial = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const signal = AbortSignal.timeout(MAX_READ_MS);
  // Reuse one buffer and stay within the size captured before DSH can append.
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bufferStart = -1;
  let bufferEnd = -1;
  const probe = Buffer.allocUnsafe(5);
  const readFrameHeader: ReadSnapshot = async (offset, length) => {
    if (offset + length > size) return null;
    if (offset >= bufferStart && offset + length <= bufferEnd)
      return buffer.subarray(offset - bufferStart, offset - bufferStart + length);
    // Boundaries can jump over large blocks. Probe their headers without replacing the
    // payload buffer, so decoding the frame doesn't then fetch those blocks a second time.
    const { bytesRead } = await handle.read(probe, 0, length, offset);
    return bytesRead === length ? probe.subarray(0, length) : null;
  };
  const readSnapshot: ReadSnapshot = async (offset, length) => {
    if (offset + length > size) return null;
    if (offset < bufferStart || offset + length > bufferEnd) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - offset),
        offset,
      );
      bufferStart = offset;
      bufferEnd = offset + bytesRead;
    }
    return offset + length <= bufferEnd
      ? buffer.subarray(offset - bufferStart, offset - bufferStart + length)
      : null;
  };

  async function* compressedFrames() {
    while (offset < size) {
      signal.throwIfAborted();
      if (!(await readSnapshot(offset, 5))) break;
      const end = await zstdFrameEnd(readFrameHeader, offset, signal);
      if (end === null || end > size) break;
      // Input chunks can split a large frame, but must never span two frames.
      while (offset < end) {
        const available =
          offset >= bufferStart && offset < bufferEnd ? bufferEnd - offset : buffer.length;
        const data = await readSnapshot(offset, Math.min(available, end - offset));
        if (!data) throw new Error("dsh-history-incomplete-frame");
        yield Buffer.from(data);
        offset += data.length;
      }
    }
    if (complete && offset !== size) throw new Error("dsh-history-incomplete-frame");
  }

  await pipeline(
    compressedFrames(),
    createZstdDecompress(),
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
    { signal },
  );
  if (partial || decoder.decode()) {
    if (complete) throw new Error("dsh-history-incomplete-line");
    return 0;
  }
  return offset;
}

function isDshLogHeader(event: Record<string, unknown>, nativeId: string): boolean {
  return event.type === "session" && event.version === 4 && event.id === nativeId;
}

function createHistoryProjection(nativeId: string, before: number | undefined, pageSize: number) {
  const records: { record: DshBridgeHistoryRecord; chars: number }[] = [];
  const pending = new Map<string, DshBridgeHistoryRecord>();
  const projectQuestions = createQuestionHistoryProjector();
  let header: { cwd: string | null; createdAt: number | null } | undefined;
  let cursor = -1;
  let retainedChars = 0;
  let hasOlder = false;

  function retain(record: DshBridgeHistoryRecord) {
    const chars = JSON.stringify(record).length;
    records.push({ record, chars });
    retainedChars += chars;
    // A failed hidden command keeps its original sequence.
    if (records.length > 1 && records.at(-2)!.record.seq > record.seq)
      records.sort((a, b) => a.record.seq - b.record.seq);
    while (
      records.length > pageSize ||
      (records.length > 1 && retainedChars - records[0]!.chars >= MAX_HISTORY_PAGE_CHARS)
    ) {
      retainedChars -= records.shift()!.chars;
      hasOlder = true;
    }
  }

  return {
    readLine(line: string) {
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
      const projected = inPage || event.type === "command/done" ? historyRecord(event) : null;
      // A clipped string can otherwise keep the full decoded event in the checkpoint.
      const record =
        projected && "truncated" in projected && projected.truncated
          ? structuredClone(projected)
          : projected;
      projectQuestions(event, record);
      if (!record) return;
      if (record.kind === "command" && DSH_HIDDEN_COMMANDS.includes(record.name)) {
        if (pending.size >= MAX_PENDING_COMMANDS) throw new Error("dsh-history-command-limit");
        pending.set(record.commandId, structuredClone(record));
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
    },
    page(limit: number): DshBridgeHistoryPage | null {
      if (!header) return null;
      const candidates = records.map(({ record }) => record);
      for (const record of pending.values())
        if (!hasOlder || record.seq > candidates[0]!.seq) candidates.push(record);
      if (pending.size) candidates.sort((a, b) => a.seq - b.seq);
      let pageChars = 0;
      let first = candidates.length;
      while (first > 0 && candidates.length - first < limit) {
        pageChars += JSON.stringify(candidates[first - 1]).length;
        if (first < candidates.length && pageChars > MAX_HISTORY_PAGE_CHARS) break;
        first -= 1;
      }
      return {
        sessionId: nativeId,
        ...header,
        cursor: Math.max(0, cursor),
        records: candidates.slice(first),
        nextBefore: first > 0 || hasOlder ? (candidates[first]?.seq ?? null) : null,
      };
    },
  };
}

async function samples(handle: FileHandle, end: number): Promise<Buffer | null> {
  const size = Math.min(end, CHECKPOINT_SAMPLE_BYTES);
  const result = Buffer.allocUnsafe(2 * size);
  const first = await handle.read(result, 0, size, 0);
  const last = await handle.read(result, size, size, end - size);
  return first.bytesRead === size && last.bytesRead === size ? result : null;
}

type RecentHistory = {
  stat: Stats;
  offset: number;
  samples: Buffer;
  projection: ReturnType<typeof createHistoryProjection>;
};
const recentHistories = new Map<string, RecentHistory>();

/** Reads a fixed snapshot of the v4 history. Recent pages advance from a complete frame. */
export async function readLocalDshHistory(
  directory: string,
  nativeId: string,
  before: number | undefined,
  limit: number,
): Promise<DshBridgeHistoryPage | null> {
  return readLocalDshLog(directory, async (handle, stat, file) => {
    const pageSize = Math.min(Math.max(limit, 1), 100);
    const key = JSON.stringify([stat.dev, stat.ino, nativeId]);
    const cached = before === undefined ? recentHistories.get(key) : undefined;
    const unchanged =
      cached?.stat.size === stat.size &&
      cached.stat.mtimeMs === stat.mtimeMs &&
      cached.stat.ctimeMs === stat.ctimeMs;
    if (cached) recentHistories.delete(key);
    const checkpoint =
      cached &&
      (unchanged ||
        (stat.size > cached.stat.size &&
          (await samples(handle, cached.offset))?.equals(cached.samples)))
        ? cached
        : undefined;
    const projection =
      checkpoint?.projection ??
      createHistoryProjection(nativeId, before, before === undefined ? 100 : pageSize);
    // An incomplete trailing frame does not hide the already saved history.
    const offset =
      unchanged && checkpoint
        ? checkpoint.offset
        : await decodeDshLog(
            handle,
            checkpoint?.offset ?? 0,
            stat.size,
            projection.readLine,
            false,
          );
    const page = projection.page(pageSize);
    const signature =
      offset === checkpoint?.offset
        ? checkpoint.samples
        : page && before === undefined && offset > 0
          ? await samples(handle, offset)
          : null;
    if (!(await sameSnapshot(file, stat))) return null;
    if (page && before === undefined && offset > 0) {
      if (signature) {
        recentHistories.set(key, {
          stat,
          offset,
          samples: signature,
          projection,
        });
        while (recentHistories.size > MAX_RECENT_HISTORIES)
          recentHistories.delete(recentHistories.keys().next().value!);
      }
    }
    // Later answer events can annotate retained tool records. Earlier callers own their snapshot.
    return page ? structuredClone(page) : null;
  });
}

async function sameSnapshot(file: string, stat: Stats): Promise<boolean> {
  const current = await lstat(file);
  return (
    current.dev === stat.dev &&
    current.ino === stat.ino &&
    (current.size > stat.size ||
      (current.size === stat.size &&
        current.mtimeMs === stat.mtimeMs &&
        current.ctimeMs === stat.ctimeMs))
  );
}

/** A validated event boundary at the end of a complete compressed frame. */
export type DshLocalTurnCheckpoint = {
  nativeId: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  samples?: string;
  seq: number;
  lastEventAt: number | null;
  open: { turn: number; startedAt: number } | null;
  quitInterruption?: {
    turn: number;
    interruptionId: string;
    endSeq: number;
    cleanup?: "next-step" | "next-turn";
  };
};
const turnCheckpoints = new Map<string, DshLocalTurnCheckpoint>();

/** The only native writes rc.5 performs after its quit-abort closes are its two inbox clears. */
function quitInboxCleanup(event: Record<string, unknown>) {
  const { data } = event;
  if (event.type !== "agent/inbox/spliced" || !data || typeof data !== "object") return null;
  const { target, start, removedCount, inserted, outcome } = data as Record<string, unknown>;
  return (target === "next-step" || target === "next-turn") &&
    start === 0 &&
    typeof removedCount === "number" &&
    Number.isSafeInteger(removedCount) &&
    removedCount > 0 &&
    Array.isArray(inserted) &&
    inserted.length === 0 &&
    outcome === "canceled"
    ? target
    : null;
}

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
    const key = JSON.stringify([stat.dev, stat.ino, nativeId]);
    const cached = turnCheckpoints.get(key);
    const baseline = cached && (!previous || cached.size >= previous.size) ? cached : previous;
    const sameFile =
      baseline?.nativeId === nativeId && baseline.dev === stat.dev && baseline.ino === stat.ino;
    if (
      sameFile &&
      baseline.size === stat.size &&
      baseline.mtimeMs === stat.mtimeMs &&
      baseline.ctimeMs === stat.ctimeMs
    )
      return (await sameSnapshot(file, stat)) ? baseline : null;
    const checkpoint =
      sameFile &&
      baseline.size < stat.size &&
      baseline.samples &&
      (await samples(handle, baseline.size))?.toString("base64") === baseline.samples
        ? baseline
        : undefined;
    let headerSeen = !!checkpoint;
    let seq = checkpoint?.seq ?? -1;
    let lastEventAt = checkpoint?.lastEventAt ?? null;
    let openTurn = checkpoint?.open ?? null;
    let quitInterruption = checkpoint?.quitInterruption;

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
        if (quitInterruption) {
          const cleanup = quitInboxCleanup(event);
          // Native clear() writes next-step before next-turn and skips either empty list.
          quitInterruption =
            cleanup &&
            (!quitInterruption.cleanup ||
              (quitInterruption.cleanup === "next-step" && cleanup === "next-turn"))
              ? { ...quitInterruption, cleanup }
              : undefined;
        }

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
          const interruptionId = quitInterruptionId(event);
          if (interruptionId) quitInterruption = { turn, interruptionId, endSeq: next };
        }
      },
      true,
    );

    if (!headerSeen) return null;
    const signature = await samples(handle, stat.size);
    if (!signature || !(await sameSnapshot(file, stat))) return null;
    const snapshot: DshLocalTurnCheckpoint = {
      nativeId,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      samples: signature.toString("base64"),
      seq,
      lastEventAt,
      open: openTurn,
      ...(quitInterruption ? { quitInterruption } : {}),
    };
    turnCheckpoints.delete(key);
    turnCheckpoints.set(key, snapshot);
    if (turnCheckpoints.size > MAX_TURN_CHECKPOINTS)
      turnCheckpoints.delete(turnCheckpoints.keys().next().value!);
    return snapshot;
  });
}
