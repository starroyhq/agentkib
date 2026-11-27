import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from "node:fs";
import { setImmediate } from "node:timers/promises";
import {
  openSessionLog,
  SESSION_LOG_BLOCK_BYTES,
  type SessionLogSnapshot,
} from "./session-log-reader";
import { isReparseOrSymlink } from "./native-files";
import { transcriptOpenError } from "./session-history-errors";
import { finiteJson } from "./config-merge";
import { compareUtf8 } from "./workspaces";
import {
  MAX_LINE_BYTES,
  MAX_PAGE_BYTES,
  type HistoryFormat,
  type ConversationEvent,
  type ConversationEventPage,
} from "./session-events";
import {
  initialEventState,
  nativeHistoryRules,
  unknownHistoryHeader,
  parseEventRecord,
  associationCount,
  associationBytes,
  type EventState,
} from "./session-event-parser";
import { toolEventBytes, type ToolContext } from "./conversation-tools";
import { TurnSummaryProjection } from "./session-turn-summary";
import { MAX_IMAGE_RECORD_BYTES, SessionImages } from "./session-images";
const EMPTY_BLOCK = Buffer.alloc(0);
const SCAN_BYTES = 16 * 1024 * 1024,
  SCAN_LINES = 20_000,
  FIRST_PAGE_BYTES = 4 * 1024 * 1024,
  FIRST_PAGE_TURNS = 20,
  TURN_LOOKAHEAD_LINES = 1024,
  TURN_LOOKAHEAD_ITEMS = 512,
  MAX_STATES = 32,
  MAX_LIVE_PAGES = 2,
  MAX_CACHE_BYTES = 64 * 1024 * 1024,
  TTL = 15 * 60 * 1000;
interface Snapshot {
  path: string;
  length: number;
  modified: bigint;
  changed: bigint;
  identity: string;
  fingerprint: string;
}
interface State extends EventState {
  snapshot: Snapshot;
  position: number;
  fragments: Buffer[];
  fragmentBytes: number;
  oversized: boolean;
  trailing: boolean;
}
function readExact(fd: number, length: number, offset: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let count = 0;
  while (count < length) {
    const size = readSync(fd, bytes, count, length - count, offset + count);
    if (!size) throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
    count += size;
  }
  return bytes;
}
async function readExactAsync(
  fd: SessionLogSnapshot,
  { count, position, fresh }: BlockRead,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(count);
  let filled = 0;
  while (filled < count) {
    const { bytesRead } = await (fresh ? fd.readCurrent : fd.read)(
      buffer,
      filled,
      count - filled,
      position + filled,
    );
    if (!bytesRead) throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
    filled += bytesRead;
  }
  return buffer;
}
function openHistory(file: string): number {
  try {
    const metadata = lstatSync(file);
    if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
      throw new Error("Unsafe history source");
    return openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    throw transcriptOpenError(error);
  }
}
function* fingerprint(length: number, fresh = false): ReadSteps<string> {
  const count = Math.min(length, 4096);
  const head = (yield { count, position: 0, fresh }) as Buffer;
  const tail = (yield { count, position: Math.max(0, length - count), fresh }) as Buffer;
  return createHash("sha256").update(head).update(tail).digest("hex");
}
function identity(metadata: BigIntStats): string {
  return process.platform === "win32"
    ? String(metadata.birthtimeNs)
    : `${metadata.dev}:${metadata.ino}`;
}
type RecordRead =
  | { type: "line"; offset: number; bytes: Buffer }
  | { type: "oversized" | "budget" | "end" };
type BlockRead = { count: number; position: number; fresh?: boolean };
type StatRead = { stat: true };
type ReadSteps<R> = Generator<BlockRead | StatRead | null, R, Buffer | BigIntStats>;

class ReverseReader {
  buffer: Buffer = Buffer.alloc(0);
  index = 0;
  bytes = 0;
  constructor(readonly byteLimit: number) {}
  *next(state: State): ReadSteps<RecordRead> {
    const finish = (offset: number): RecordRead => {
      const oversized = state.oversized;
      state.oversized = false;
      const bytes = Buffer.concat(state.fragments.reverse(), state.fragmentBytes);
      state.fragments = [];
      state.fragmentBytes = 0;
      return oversized ? { type: "oversized" } : { type: "line", offset, bytes };
    };
    for (;;) {
      if (state.position === 0)
        return state.fragmentBytes || state.oversized ? finish(0) : { type: "end" };
      if (this.index === 0) {
        if (this.bytes >= this.byteLimit) return { type: "budget" };
        const count = Math.min(
          state.position % SESSION_LOG_BLOCK_BYTES || SESSION_LOG_BLOCK_BYTES,
          state.position,
          this.byteLimit - this.bytes,
        );
        this.buffer = (yield { count, position: state.position - count }) as Buffer;
        this.index = count;
        this.bytes += count;
      }
      const newline = this.buffer.lastIndexOf(10, this.index - 1),
        start = Math.max(0, newline + 1),
        part = this.buffer.subarray(start, this.index);
      state.position -= part.length;
      this.index = start;
      if (!state.oversized) {
        const limit = ["codex", "claude-code"].includes(state.format)
          ? MAX_IMAGE_RECORD_BYTES
          : MAX_LINE_BYTES;
        if (state.fragmentBytes + part.length > limit) {
          state.fragments = [];
          state.fragmentBytes = 0;
          state.oversized = true;
        } else if (part.length) {
          state.fragments.push(part);
          state.fragmentBytes += part.length;
        }
      }
      if (newline >= 0) {
        this.index--;
        state.position--;
        return finish(state.position + 1);
      }
    }
  }
}
/** Bytes an event adds to a page: its text plus any tool detail and turn data. */
function eventPageBytes(event: ConversationEvent): number {
  return (
    (event.content ? Buffer.byteLength(event.content) : 0) +
    toolEventBytes(event) +
    (event.images ? Buffer.byteLength(JSON.stringify(event.images)) : 0)
  );
}

/** Associate only rows the native reader assigned to exactly the same turn. */
function attachTurnSummaries(events: ConversationEvent[], older: boolean, damaged: boolean) {
  const turns = new Map<string, { end: ConversationEvent; evidence: TurnSummaryProjection }>();
  for (const event of events) {
    if (!event.turn_id || !event.turn_meta?.outcome || turns.has(event.turn_id)) continue;
    turns.set(event.turn_id, {
      end: event,
      evidence: new TurnSummaryProjection(event.turn_id),
    });
  }
  if (!turns.size) return;
  // Reverse scan order is newest-first. Supply evidence in transcript order.
  let oldestTurn: string | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.turn_id) {
      oldestTurn ??= event.turn_id;
      turns.get(event.turn_id)?.evidence.add(event);
    }
  }
  let budget = MAX_PAGE_BYTES - events.reduce((bytes, event) => bytes + eventPageBytes(event), 0);
  for (const [turnId, { end, evidence }] of turns) {
    const summary = evidence.summary(damaged || (older && oldestTurn === turnId));
    if (!summary) continue;
    const bytes = 16 + Buffer.byteLength(JSON.stringify(summary));
    if (bytes > budget) continue;
    budget -= bytes;
    end.turn_meta = { ...end.turn_meta, summary };
  }
}
function estimatedBytes(state: State): number {
  return (
    state.fragmentBytes +
    associationBytes(state) +
    state.pending.reduce(
      (sum, event) =>
        sum +
        256 +
        toolEventBytes(event) +
        (event.images ? Buffer.byteLength(JSON.stringify(event.images)) : 0) +
        [event.id, event.content, event.turn_id, event.tool_name, event.tool_status].reduce<number>(
          (size, value) => size + (value ? Buffer.byteLength(value) : 0),
          0,
        ),
      0,
    )
  );
}
function clone(state: State): State {
  const { fragments, ...values } = state;
  return {
    ...structuredClone(values),
    fragments: state.fragmentBytes
      ? [Buffer.concat([...fragments].reverse(), state.fragmentBytes)]
      : [],
  };
}
/** A page read with `retain` false: older history exists, but no cursor was kept for it. */
export const UNRETAINED_CURSOR = "history-v1-unretained";
/** Snapshot-bound reverse pages remain replayable without loading the whole native transcript. */
export class SessionPaging {
  #states = new Map<string, { created: number; state: State }>();
  #expiry?: ReturnType<typeof setTimeout>;
  #generation = 0;
  #livePages = new Map<string, { version: string; page: ConversationEventPage }>();
  #liveReads = new Map<string, Promise<ConversationEventPage>>();
  /**
   * Drops expired scan states when they expire. They were dropped only when another one was
   * stored, so the last ones read kept up to the whole cache budget while the app sat idle.
   */
  #expireLater(): void {
    if (this.#expiry || !this.#states.size) return;
    const oldest = Math.min(...[...this.#states.values()].map((cached) => cached.created));
    this.#expiry = setTimeout(
      () => {
        this.#expiry = undefined;
        const now = performance.now();
        for (const [key, cached] of this.#states)
          if (now - cached.created >= TTL) this.#states.delete(key);
        this.#expireLater();
      },
      Math.max(0, oldest + TTL - performance.now()),
    );
    this.#expiry.unref();
  }
  #images = new SessionImages();
  clear(): void {
    this.#generation++;
    this.#states.clear();
    this.#livePages.clear();
    this.#liveReads.clear();
    this.#images.clear();
    if (this.#expiry) clearTimeout(this.#expiry);
    this.#expiry = undefined;
  }
  image(file: string, imageId: string, scope = file) {
    return this.#images.read(scope, file, imageId);
  }

  hasImageReferences(ids: readonly string[]): boolean {
    return this.#images.hasReferences(ids);
  }
  /**
   * `context` only changes how tool paths are shown; cursors keep the first read's.
   * `retain` false is for readers that only need this page and whether older history exists,
   * such as stream snapshots polled every 250 ms: they keep no cursor, so they cannot push the
   * cursors that clients hold out of the cache. Their `next_cursor` is [UNRETAINED_CURSOR].
   */
  read(
    file: string,
    cursor: string | null,
    limit: number,
    format: HistoryFormat,
    context: ToolContext = {},
    retain = true,
    imageScope = file,
    imageScanBudget?: { remainingBytes: number },
  ): ConversationEventPage {
    const fd = openHistory(file);
    try {
      const page = this.#readPage(
        file,
        cursor,
        limit,
        format,
        context,
        retain,
        imageScope,
        imageScanBudget,
      );
      let next = page.next();
      while (!next.done) {
        const block = next.value;
        next = page.next(
          !block
            ? EMPTY_BLOCK
            : "stat" in block
              ? fstatSync(fd, { bigint: true })
              : readExact(fd, block.count, block.position),
        );
      }
      return next.value;
    } finally {
      closeSync(fd);
    }
  }

  async readTranscript(
    file: string,
    cursor: string | null,
    limit: number,
    format: "codex" | "claude-code",
    context: ToolContext,
    retain: boolean,
    imageScope: string = file,
    imageScanBudget?: { remainingBytes: number },
  ): Promise<ConversationEventPage> {
    const generation = this.#generation;
    const fd = await openSessionLog(file).catch((error) => {
      throw transcriptOpenError(error);
    });
    try {
      if (generation !== this.#generation)
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
      // Only background snapshots have no cursor or image-scan budget to update.
      if (cursor !== null || retain || imageScanBudget)
        return await this.#readTranscriptPage(
          fd,
          file,
          cursor,
          limit,
          format,
          context,
          retain,
          imageScope,
          imageScanBudget,
        );

      const metadata = await fd.stat({ bigint: true });
      if (generation !== this.#generation)
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
      const key = JSON.stringify([
        file,
        imageScope,
        limit,
        format,
        context.workspace,
        context.cwd,
        context.home,
      ]);
      const version = [identity(metadata), metadata.size, metadata.mtimeNs, metadata.ctimeNs].join(
        ":",
      );
      const cached = this.#livePages.get(key);
      if (
        cached?.version === version &&
        this.#images.hasReferences(
          cached.page.events.flatMap((event) => event.images?.map((image) => image.id) ?? []),
        )
      ) {
        this.#livePages.delete(key);
        this.#livePages.set(key, cached);
        return structuredClone(cached.page);
      }
      const request = JSON.stringify([key, version]);
      const active = this.#liveReads.get(request);
      if (active) return structuredClone(await active);
      const loading = this.#readTranscriptPage(
        fd,
        file,
        cursor,
        limit,
        format,
        context,
        retain,
        imageScope,
      );
      this.#liveReads.set(request, loading);
      try {
        const page = await loading;
        const current = await fd.stat({ bigint: true });
        if (
          this.#liveReads.get(request) === loading &&
          identity(current) === identity(metadata) &&
          current.size === metadata.size &&
          current.mtimeNs === metadata.mtimeNs &&
          current.ctimeNs === metadata.ctimeNs
        ) {
          this.#livePages.delete(key);
          if (this.#livePages.size >= MAX_LIVE_PAGES)
            this.#livePages.delete(this.#livePages.keys().next().value!);
          this.#livePages.set(key, {
            version,
            page: structuredClone(page),
          });
        }
        return page;
      } finally {
        if (this.#liveReads.get(request) === loading) this.#liveReads.delete(request);
      }
    } finally {
      await fd.close();
    }
  }

  async #readTranscriptPage(
    fd: SessionLogSnapshot,
    file: string,
    cursor: string | null,
    limit: number,
    format: "codex" | "claude-code",
    context: ToolContext,
    retain: boolean,
    imageScope: string,
    imageScanBudget?: { remainingBytes: number },
  ): Promise<ConversationEventPage> {
    const generation = this.#generation;
    const page = this.#readPage(
      file,
      cursor,
      limit,
      format,
      context,
      retain,
      imageScope,
      imageScanBudget,
      cursor === null,
    );
    let next = page.next();
    while (!next.done) {
      const block = next.value;
      const bytes = block
        ? "stat" in block
          ? await fd.stat({ bigint: true })
          : await readExactAsync(fd, block)
        : await setImmediate(EMPTY_BLOCK);
      if (this.#generation !== generation)
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
      next = page.next(bytes);
    }
    return next.value;
  }

  *#readPage(
    file: string,
    cursor: string | null,
    limit: number,
    format: HistoryFormat,
    context: ToolContext,
    retain: boolean,
    imageScope: string,
    imageScanBudget?: { remainingBytes: number },
    firstScreen = false,
  ): ReadSteps<ConversationEventPage> {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid event limit");
    const metadata = (yield { stat: true }) as BigIntStats;
    if (!metadata.isFile() || metadata.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("TRANSCRIPT_UNREADABLE");
    let state: State;
    if (cursor !== null) {
      if (!cursor.startsWith("history-v1-") || Buffer.byteLength(cursor) > 64)
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorInvalid);
      const cached = this.#states.get(cursor);
      if (!cached || performance.now() - cached.created >= TTL)
        throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
      state = clone(cached.state);
    } else {
      const length = Number(metadata.size);
      state = {
        ...initialEventState(format, context),
        snapshot: {
          path: file,
          length,
          modified: metadata.mtimeNs,
          changed: metadata.ctimeNs,
          identity: identity(metadata),
          fingerprint: yield* fingerprint(length),
        },
        position: length,
        fragments: [],
        fragmentBytes: 0,
        oversized: false,
        trailing: true,
      };
    }
    yield* this.#validate(file, format, state);
    const rules = nativeHistoryRules[format];
    const groupByOpeningRecord = rules?.groupByOpeningRecord;
    if (!groupByOpeningRecord) state.turnRangeStart = 0;
    const reader = new ReverseReader(
        Math.min(
          firstScreen ? FIRST_PAGE_BYTES - 24 * 1024 : SCAN_BYTES,
          imageScanBudget?.remainingBytes ?? SCAN_BYTES,
        ),
      ),
      events: ConversationEvent[] = [],
      warnings = new Set<string>();
    let lines = 0,
      eventBytes = 0,
      pendingBytes = state.pending.reduce((sum, event) => sum + eventPageBytes(event), 0);
    let lookahead: number | undefined;
    let fullAtLine: number | undefined;
    const turns = new Set<string | number>();
    let yieldAt = performance.now() + 8;
    const damaged = (oversized = false) => {
      state.candidateTurn = null;
      if (!oversized || groupByOpeningRecord) state.turnMeta = null;
      state.turnRangeStart = events.length + (groupByOpeningRecord ? state.pending.length : 0);
      state.associationWarning = true;
      warnings.add(oversized ? "TRANSCRIPT_OVERSIZED_LINES" : "TRANSCRIPT_DAMAGED_LINES");
    };
    for (;;) {
      const next = state.pending[0];
      const full =
        events.length >= Math.min(100, Math.max(1, limit)) ||
        (next !== undefined && eventBytes + eventPageBytes(next) > MAX_PAGE_BYTES);
      if (full) {
        // An image-bearing message can have its only usable image on the
        // immediately older mirror row. Resolve that bounded mirror window
        // before sending the page, keeping other newly parsed items pending.
        lookahead ??= events.at(-1)?.attachment_count ? 64 : 0;
        fullAtLine ??= lines;
        // Keep the opener in the cursor's pending window, even when it falls
        // on an older page. A damaged or very long turn can stay unidentified.
        const needOpener =
          groupByOpeningRecord &&
          state.turnRangeStart < events.length &&
          lines - fullAtLine < TURN_LOOKAHEAD_LINES &&
          state.pending.length < TURN_LOOKAHEAD_ITEMS &&
          pendingBytes < MAX_PAGE_BYTES;
        if (lookahead <= 0 && !needOpener) break;
      }
      if (state.pending.length && !full) {
        const next = state.pending[0]!,
          bytes = eventPageBytes(next);
        if (
          events.length >= Math.min(100, Math.max(1, limit)) ||
          eventBytes + bytes > MAX_PAGE_BYTES
        )
          break;
        eventBytes += bytes;
        pendingBytes -= bytes;
        events.push(state.pending.shift()!);
        continue;
      }
      if (turns.size >= FIRST_PAGE_TURNS) break;
      if (lines >= SCAN_LINES) {
        warnings.add("TRANSCRIPT_SCAN_BUDGET");
        break;
      }
      const record = yield* reader.next(state);
      if (record.type === "budget") {
        warnings.add("TRANSCRIPT_SCAN_BUDGET");
        break;
      }
      if (record.type === "end") break;
      if (record.type === "oversized") {
        state.trailing = false;
        damaged(true);
        continue;
      }
      if (record.type !== "line") continue;
      if (lookahead !== undefined) lookahead--;
      if (state.trailing) {
        state.trailing = false;
        if (!record.bytes.length || record.bytes.equals(Buffer.from("\r"))) continue;
      }
      lines++;
      state.sequence++;
      if (lines % 16 === 0 && performance.now() >= yieldAt) {
        yield null;
        yieldAt = performance.now() + 8;
      }
      if (!record.bytes.length) continue;
      if (rules && unknownHistoryHeader(record.bytes, rules)) continue;
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(record.bytes),
        );
        if (rules && !rules.include(value)) continue;
        finiteJson(value);
      } catch {
        damaged();
        continue;
      }
      const images = this.#images.register(
        imageScope,
        record.offset,
        record.bytes,
        value,
        format,
        context.cwd ?? context.workspace ?? "",
      );
      if (record.bytes.length > MAX_LINE_BYTES && !images.length) {
        damaged(true);
        continue;
      }
      const pending = state.pending.length;
      try {
        const start = parseEventRecord(
          state,
          record.offset,
          value,
          events,
          images,
          record.offset + record.bytes.length + 1,
        );
        if (firstScreen && start !== undefined) turns.add(start);
      } catch (error) {
        if (!(error instanceof TypeError || error instanceof RangeError)) throw error;
        state.pending.length = pending;
        damaged();
        continue;
      }
      if (groupByOpeningRecord) {
        for (let index = pending; index < state.pending.length; index++)
          pendingBytes += eventPageBytes(state.pending[index]!);
      } else {
        // Mirror rows can update an item already in the queue.
        pendingBytes = state.pending.reduce((sum, event) => sum + eventPageBytes(event), 0);
      }
      if (associationCount(state) > 20_000 || pendingBytes > 8 * MAX_PAGE_BYTES)
        throw new Error("TRANSCRIPT_SCAN_STATE_LIMIT");
    }
    yield* this.#validate(file, format, state);
    if (imageScanBudget) imageScanBudget.remainingBytes -= reader.bytes;
    while (
      events.length > 1 &&
      events.reduce((total, event) => total + eventPageBytes(event), 0) > MAX_PAGE_BYTES
    )
      state.pending.unshift(events.pop()!);
    if (groupByOpeningRecord)
      state.turnRangeStart = Math.max(0, state.turnRangeStart - events.length);
    if (state.associationWarning) warnings.add("TRANSCRIPT_ASSOCIATION_WINDOW");
    let next: string | null = null;
    const older = state.position > 0 || state.pending.length > 0 || state.fragmentBytes > 0;
    attachTurnSummaries(events, older, warnings.size > 0);
    if (older && !retain) next = UNRETAINED_CURSOR;
    else if (older) {
      const now = performance.now(),
        size = estimatedBytes(state);
      if (size > MAX_CACHE_BYTES) throw new Error("TRANSCRIPT_SCAN_STATE_LIMIT");
      for (const [key, cached] of this.#states)
        if (now - cached.created >= TTL) this.#states.delete(key);
      while (
        this.#states.size >= MAX_STATES ||
        [...this.#states.values()].reduce((sum, cached) => sum + estimatedBytes(cached.state), 0) +
          size >
          MAX_CACHE_BYTES
      ) {
        const oldest = [...this.#states].sort((a, b) => a[1].created - b[1].created)[0];
        if (!oldest) break;
        this.#states.delete(oldest[0]);
      }
      next = `history-v1-${randomUUID()}`;
      this.#states.set(next, { created: now, state: clone(state) });
      this.#expireLater();
    }
    return {
      events: events.reverse(),
      next_cursor: next,
      warnings: [...warnings].sort(compareUtf8),
    };
  }
  *#validate(file: string, format: HistoryFormat, state: State): ReadSteps<void> {
    const metadata = (yield { stat: true }) as BigIntStats,
      snapshot = state.snapshot;
    if (snapshot.path !== file || state.format !== format)
      throw new Error(REMOTE_ERROR_CODES.transcriptCursorInvalid);
    if (
      metadata.size < BigInt(snapshot.length) ||
      identity(metadata) !== snapshot.identity ||
      (metadata.size === BigInt(snapshot.length) &&
        (metadata.mtimeNs !== snapshot.modified || metadata.ctimeNs !== snapshot.changed)) ||
      (yield* fingerprint(snapshot.length, metadata.size !== BigInt(snapshot.length))) !==
        snapshot.fingerprint
    )
      throw new Error(REMOTE_ERROR_CODES.transcriptCursorStale);
  }
}
