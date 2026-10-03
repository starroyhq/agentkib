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
import { isReparseOrSymlink } from "./native-files";
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
  parseEventRecord,
  associationCount,
  associationBytes,
  type EventState,
} from "./session-event-parser";
const SCAN_BYTES = 16 * 1024 * 1024,
  SCAN_LINES = 20_000,
  BLOCK_BYTES = 64 * 1024,
  MAX_STATES = 32,
  MAX_CACHE_BYTES = 64 * 1024 * 1024,
  TTL = 15 * 60 * 1000;
interface Snapshot {
  path: string;
  length: number;
  modified: bigint;
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
    if (!size) throw new Error("TRANSCRIPT_CURSOR_STALE");
    count += size;
  }
  return bytes;
}
function fingerprint(fd: number, length: number): string {
  const count = Math.min(length, 4096);
  return createHash("sha256")
    .update(readExact(fd, count, 0))
    .update(readExact(fd, count, Math.max(0, length - count)))
    .digest("hex");
}
function identity(metadata: BigIntStats): string {
  return process.platform === "win32"
    ? String(metadata.birthtimeNs)
    : `${metadata.dev}:${metadata.ino}`;
}
type RecordRead =
  | { type: "line"; offset: number; bytes: Buffer }
  | { type: "oversized" | "budget" | "end" };
class ReverseReader {
  buffer: Buffer = Buffer.alloc(0);
  index = 0;
  bytes = 0;
  constructor(readonly fd: number) {}
  next(state: State): RecordRead {
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
        if (this.bytes >= SCAN_BYTES) return { type: "budget" };
        const count = Math.min(state.position, BLOCK_BYTES, SCAN_BYTES - this.bytes);
        this.buffer = readExact(this.fd, count, state.position - count);
        this.index = count;
        this.bytes += count;
      }
      const newline = this.buffer.lastIndexOf(10, this.index - 1),
        start = Math.max(0, newline + 1),
        part = this.buffer.subarray(start, this.index);
      state.position -= part.length;
      this.index = start;
      if (!state.oversized) {
        if (state.fragmentBytes + part.length > MAX_LINE_BYTES) {
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
function estimatedBytes(state: State): number {
  return (
    state.fragmentBytes +
    associationBytes(state) +
    state.pending.reduce(
      (sum, event) =>
        sum +
        256 +
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
/** Snapshot-bound reverse pages remain replayable without loading the whole native transcript. */
export class SessionPaging {
  #states = new Map<string, { created: number; state: State }>();
  clear(): void {
    this.#states.clear();
  }
  read(
    file: string,
    cursor: string | null,
    limit: number,
    format: HistoryFormat,
  ): ConversationEventPage {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid event limit");
    let fd: number;
    try {
      const metadata = lstatSync(file);
      if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
        throw new Error("Unsafe history source");
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      throw new Error("TRANSCRIPT_UNREADABLE");
    }
    try {
      const metadata = fstatSync(fd, { bigint: true });
      if (!metadata.isFile() || metadata.size > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("TRANSCRIPT_UNREADABLE");
      let state: State;
      if (cursor !== null) {
        if (!cursor.startsWith("history-v1-") || Buffer.byteLength(cursor) > 64)
          throw new Error("TRANSCRIPT_CURSOR_INVALID");
        const cached = this.#states.get(cursor);
        if (!cached || performance.now() - cached.created >= TTL)
          throw new Error("TRANSCRIPT_CURSOR_STALE");
        state = clone(cached.state);
      } else {
        const length = Number(metadata.size);
        state = {
          ...initialEventState(format),
          snapshot: {
            path: file,
            length,
            modified: metadata.mtimeNs,
            identity: identity(metadata),
            fingerprint: fingerprint(fd, length),
          },
          position: length,
          fragments: [],
          fragmentBytes: 0,
          oversized: false,
          trailing: true,
        };
      }
      this.#validate(fd, file, format, state);
      state.turnRangeStart = 0;
      const reader = new ReverseReader(fd),
        events: ConversationEvent[] = [],
        warnings = new Set<string>();
      let lines = 0,
        eventBytes = 0;
      for (;;) {
        if (state.pending.length) {
          const next = state.pending[0]!,
            bytes = next.content ? Buffer.byteLength(next.content) : 0;
          if (
            events.length >= Math.min(100, Math.max(1, limit)) ||
            eventBytes + bytes > MAX_PAGE_BYTES
          )
            break;
          eventBytes += bytes;
          events.push(state.pending.shift()!);
          continue;
        }
        if (lines >= SCAN_LINES) {
          warnings.add("TRANSCRIPT_SCAN_BUDGET");
          break;
        }
        const record = reader.next(state);
        if (record.type === "budget") {
          warnings.add("TRANSCRIPT_SCAN_BUDGET");
          break;
        }
        if (record.type === "end") break;
        if (record.type === "oversized") {
          state.trailing = false;
          state.candidateTurn = null;
          state.turnRangeStart = events.length;
          state.associationWarning = true;
          warnings.add("TRANSCRIPT_OVERSIZED_LINES");
          continue;
        }
        if (record.type !== "line") continue;
        if (state.trailing) {
          state.trailing = false;
          if (!record.bytes.length || record.bytes.equals(Buffer.from("\r"))) continue;
        }
        lines++;
        state.sequence++;
        if (!record.bytes.length) continue;
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(record.bytes),
          );
          finiteJson(value);
        } catch {
          state.candidateTurn = null;
          state.turnRangeStart = events.length;
          state.associationWarning = true;
          warnings.add("TRANSCRIPT_DAMAGED_LINES");
          continue;
        }
        parseEventRecord(state, record.offset, value, events);
        if (
          associationCount(state) > 20_000 ||
          state.pending.reduce(
            (sum, event) => sum + (event.content ? Buffer.byteLength(event.content) : 0),
            0,
          ) >
            8 * MAX_PAGE_BYTES
        )
          throw new Error("TRANSCRIPT_SCAN_STATE_LIMIT");
      }
      this.#validate(fd, file, format, state);
      if (state.associationWarning) warnings.add("TRANSCRIPT_ASSOCIATION_WINDOW");
      let next: string | null = null;
      if (state.position > 0 || state.pending.length || state.fragmentBytes) {
        const now = performance.now(),
          size = estimatedBytes(state);
        if (size > MAX_CACHE_BYTES) throw new Error("TRANSCRIPT_SCAN_STATE_LIMIT");
        for (const [key, cached] of this.#states)
          if (now - cached.created >= TTL) this.#states.delete(key);
        while (
          this.#states.size >= MAX_STATES ||
          [...this.#states.values()].reduce(
            (sum, cached) => sum + estimatedBytes(cached.state),
            0,
          ) +
            size >
            MAX_CACHE_BYTES
        ) {
          const oldest = [...this.#states].sort((a, b) => a[1].created - b[1].created)[0];
          if (!oldest) break;
          this.#states.delete(oldest[0]);
        }
        next = `history-v1-${randomUUID()}`;
        this.#states.set(next, { created: now, state: clone(state) });
      }
      return {
        events: events.reverse(),
        next_cursor: next,
        warnings: [...warnings].sort(compareUtf8),
      };
    } finally {
      closeSync(fd);
    }
  }
  #validate(fd: number, file: string, format: HistoryFormat, state: State): void {
    const metadata = fstatSync(fd, { bigint: true }),
      snapshot = state.snapshot;
    if (snapshot.path !== file || state.format !== format)
      throw new Error("TRANSCRIPT_CURSOR_INVALID");
    if (
      metadata.size < BigInt(snapshot.length) ||
      identity(metadata) !== snapshot.identity ||
      (metadata.size === BigInt(snapshot.length) && metadata.mtimeNs !== snapshot.modified) ||
      fingerprint(fd, snapshot.length) !== snapshot.fingerprint
    )
      throw new Error("TRANSCRIPT_CURSOR_STALE");
  }
}
