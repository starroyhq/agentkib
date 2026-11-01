import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isCompressedRollout, resolveRollout } from "./codex-rollout-files";
import { CodexSessions } from "./codex-sessions";
import { existingFileLeaseBusy } from "./managed-session-lock";
import { isReparseOrSymlink } from "./native-files";
import { Sql } from "./sql";
import { timestamp } from "./timestamps";

/**
 * A turn that a Codex client outside AgentKib, such as the Codex app or the CLI, is running
 * now. For display only: it never grants or blocks a control.
 */
export type ExternalTurn = { status: "running"; startedAt: string | null };

const LOCK_DIRECTORY = "thread-writer-locks";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_DATABASE = /^thread_history_(\d+)\.sqlite$/;
const TURN_EVENTS = ["task_started", "task_complete", "turn_aborted"];
const TURN_MARKERS = TURN_EVENTS.map((type) => Buffer.from(`"${type}"`));
const EVENT_MARKER = Buffer.from('"event_msg"');
const CHUNK_BYTES = 64 * 1024;
/** How far back from its end a rollout is read for its latest turn. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** A rollout not written for this long is not running, whatever its latest turn says. */
const MAX_QUIET_MS = 6 * 60 * 60_000;
/** How long one writer lock probe stands. */
const LOCK_TTL_MS = 5_000;
/** How long a thread missing from Codex's database is not looked up again. */
const MISSING_TTL_MS = 60_000;
/** Turn times come from the rollout and lock times from the file system. */
const CLOCK_SLACK_MS = 2_000;

type TurnEvent = { started: boolean; turnId: string | null; at: string | null };
/** The latest turn to start in a thread. */
type Turn = { id: string | null; open: boolean; startedAt: string | null };
/** Where a rollout was read up to, and its latest turn there. */
type Scan = { file: string; dev: number; ino: number; offset: number; turn: Turn | null };
type Thread = { id: string; recorded: string };

const codex = new CodexSessions({});

/**
 * Finds the Codex turns that run outside AgentKib. While a client has a thread open, Codex holds
 * the thread's writer lock, `thread-writer-locks/<id>.lock`, and it deletes the file when it lets
 * go. The thread's rollout records each turn as `task_started`, then `task_complete` or
 * `turn_aborted`. A turn runs when both agree: the lock alone means the thread is only open, and
 * a rollout whose latest turn never ended may belong to a client that exited mid-turn. Only the
 * threads that have a lock file are looked at, and a rollout is read only where it grew.
 */
export class CodexExternalTurns {
  #threads = new Map<string, Thread>();
  #missing = new Map<string, number>();
  #scans = new Map<string, Scan>();
  #locks = new Map<string, { at: number; busy: boolean }>();

  constructor(private readonly home: () => string) {}

  /** The running external turns, by thread ID as Codex records it. Never throws. */
  observe(now = Date.now()): Map<string, ExternalTurn> {
    const running = new Map<string, ExternalTurn>();
    try {
      const home = this.home();
      const locks = new Map<string, string>();
      for (const name of lockFiles(home)) {
        const id = name.slice(0, -".lock".length);
        if (THREAD_ID.test(id)) locks.set(id.toLowerCase(), name);
      }
      prune(this.#threads, locks);
      prune(this.#missing, locks);
      prune(this.#scans, locks);
      prune(this.#locks, locks);
      this.#lookUp(home, [...locks.keys()], now);
      for (const [key, name] of locks) {
        const thread = this.#threads.get(key);
        const turn = thread && this.#turn(home, key, thread, name, undefined, now);
        if (turn) running.set(thread.id, turn);
      }
    } catch {
      // Display only: a failed observation shows nothing rather than breaking the catalog.
    }
    return running;
  }

  /**
   * The running external turn of one thread whose writer lock was just found held, as the
   * session's live state reports it. Never throws.
   */
  turnOf(threadId: string, now = Date.now()): ExternalTurn | null {
    try {
      if (!THREAD_ID.test(threadId)) return null;
      const home = this.home();
      const key = threadId.toLowerCase();
      this.#lookUp(home, [key], now);
      const thread = this.#threads.get(key);
      return thread ? this.#turn(home, key, thread, `${threadId}.lock`, true, now) : null;
    } catch {
      return null;
    }
  }

  /** Finds the rollouts of threads not looked up yet in Codex's thread databases. */
  #lookUp(home: string, keys: string[], now: number) {
    const wanted = keys.filter(
      (key) =>
        !this.#threads.has(key) && now - (this.#missing.get(key) ?? -Infinity) >= MISSING_TTL_MS,
    );
    if (!wanted.length) return;
    const current = codex.databases(home);
    for (const file of current.length ? current : codex.databases(path.join(home, "sqlite"))) {
      const pending = wanted.filter((key) => !this.#threads.has(key));
      if (!pending.length) break;
      try {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout=1000");
          const sql = new Sql(db);
          const columns = new Set(
            sql.rows("PRAGMA table_info(threads)").map((row) => String(row.name)),
          );
          if (!columns.has("id") || !columns.has("rollout_path")) continue;
          for (let start = 0; start < pending.length; start += 500) {
            const ids = pending.slice(start, start + 500);
            for (const row of sql.rows(
              `SELECT id, rollout_path FROM threads WHERE id COLLATE NOCASE IN (${ids.map(() => "?").join(",")})`,
              ...ids,
            )) {
              if (typeof row.id !== "string" || typeof row.rollout_path !== "string") continue;
              const key = row.id.toLowerCase();
              if (row.rollout_path.trim() && !this.#threads.has(key))
                this.#threads.set(key, { id: row.id, recorded: row.rollout_path });
            }
          }
        } finally {
          db.close();
        }
      } catch {
        // A database Codex is migrating or has locked is read on a later observation.
      }
    }
    for (const key of wanted)
      if (this.#threads.has(key)) this.#missing.delete(key);
      else this.#missing.set(key, now);
  }

  #turn(
    home: string,
    key: string,
    thread: Thread,
    lockName: string,
    held: boolean | undefined,
    now: number,
  ): ExternalTurn | null {
    const file = resolveRollout(
      path.isAbsolute(thread.recorded) ? thread.recorded : path.join(home, thread.recorded),
    );
    // Codex compresses only the rollouts of idle threads.
    if (isCompressedRollout(file)) return null;
    let stat: Stats;
    try {
      stat = lstatSync(file);
    } catch {
      // The rollout moved, as an archived thread's does. Look it up again later.
      this.#threads.delete(key);
      this.#scans.delete(key);
      this.#missing.set(key, now);
      return null;
    }
    if (!stat.isFile() || isReparseOrSymlink(file, stat) || now - stat.mtimeMs > MAX_QUIET_MS)
      return null;
    const turn = this.#scan(home, key, thread.id, file, stat)?.turn;
    if (!turn?.open) return null;
    const lock = path.join(home, LOCK_DIRECTORY, lockName);
    let lockStat: Stats;
    try {
      lockStat = lstatSync(lock);
    } catch {
      return null;
    }
    // Codex never writes to a lock file, deletes it on release, and deletes the unheld ones when
    // a new process first takes a lock. A lock file newer than the turn therefore belongs to a
    // client that opened the thread after the turn began, and the client that began it is gone.
    const started = turn.startedAt === null ? Number.NaN : Date.parse(turn.startedAt);
    if (
      !lockStat.isFile() ||
      (Number.isFinite(started) && lockStat.mtimeMs > started + CLOCK_SLACK_MS)
    )
      return null;
    if (!(held ?? this.#lockHeld(key, lock, now))) return null;
    return { status: "running", startedAt: turn.startedAt };
  }

  #lockHeld(key: string, lock: string, now: number): boolean {
    const cached = this.#locks.get(key);
    if (cached && now - cached.at < LOCK_TTL_MS) return cached.busy;
    let busy: boolean;
    try {
      busy = existingFileLeaseBusy(lock);
    } catch {
      busy = false;
    }
    this.#locks.set(key, { at: now, busy });
    return busy;
  }

  /** Reads what the rollout gained since the last scan, or its end when it is new or replaced. */
  #scan(home: string, key: string, threadId: string, file: string, seen: Stats): Scan | undefined {
    const previous = this.#scans.get(key);
    if (
      previous?.file === file &&
      previous.dev === seen.dev &&
      previous.ino === seen.ino &&
      previous.offset === seen.size
    )
      return previous;
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      return undefined;
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return undefined;
      let scan: Scan;
      if (
        previous &&
        previous.file === file &&
        previous.dev === stat.dev &&
        previous.ino === stat.ino &&
        previous.offset <= stat.size &&
        stat.size - previous.offset <= MAX_SCAN_BYTES
      ) {
        scan = { ...previous };
        const bytes = readAt(fd, previous.offset, stat.size - previous.offset);
        let start = 0;
        for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
          scan.turn = nextTurn(scan.turn, turnEvent(bytes.subarray(start, end)));
          start = end + 1;
        }
        // The bytes after the last newline are a line still being written.
        scan.offset = previous.offset + start;
      } else {
        const floor = Math.max(0, stat.size - MAX_SCAN_BYTES);
        const latest = latestTurn(fd, stat.size, floor);
        scan = {
          file,
          dev: stat.dev,
          ino: stat.ino,
          offset: latest.offset,
          // A turn that began before the bytes read is found in Codex's own turn history.
          turn: latest.turn ?? (floor > 0 ? projectedTurn(home, threadId, floor, stat.size) : null),
        };
      }
      this.#scans.set(key, scan);
      return scan;
    } finally {
      closeSync(fd);
    }
  }
}

function prune(cache: Map<string, unknown>, keep: Map<string, unknown>) {
  for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key);
}

function lockFiles(home: string): string[] {
  try {
    return readdirSync(path.join(home, LOCK_DIRECTORY)).filter((name) => name.endsWith(".lock"));
  } catch {
    return [];
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let count = 0;
  while (count < length) {
    const size = readSync(fd, bytes, count, length - count, position + count);
    if (!size) break;
    count += size;
  }
  return bytes.subarray(0, count);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The turn event of one rollout line, if it is one. */
function turnEvent(line: Buffer): TurnEvent | undefined {
  // Cheap checks first: most lines are not turn events, and some are megabytes long.
  if (line[0] !== 0x7b || line.indexOf(EVENT_MARKER) < 0) return undefined;
  if (!TURN_MARKERS.some((marker) => line.indexOf(marker) >= 0)) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(row) || row.type !== "event_msg" || !isRecord(row.payload)) return undefined;
  const { type, turn_id: turnId } = row.payload;
  if (typeof type !== "string" || !TURN_EVENTS.includes(type)) return undefined;
  return {
    started: type === "task_started",
    turnId: typeof turnId === "string" && turnId ? turnId : null,
    at: timestamp(row.timestamp),
  };
}

/**
 * The latest turn after one more rollout line. A forked thread's rollout begins with its
 * parent's history, whose turns may never end there, so only the end of the latest turn counts.
 */
function nextTurn(turn: Turn | null, event: TurnEvent | undefined): Turn | null {
  if (!event) return turn;
  if (event.started) return { id: event.turnId, open: true, startedAt: event.at };
  if (!turn) return { id: event.turnId, open: false, startedAt: null };
  return turn.id === null || event.turnId === null || event.turnId === turn.id
    ? { ...turn, open: false, startedAt: null }
    : turn;
}

function lastNewline(bytes: Buffer, end: number): number {
  // A negative offset would search from the end of the buffer.
  return end > 0 ? bytes.lastIndexOf(10, end - 1) : -1;
}

/**
 * The latest turn in the rollout bytes from [floor] to [size], read from the end, and where a
 * later read resumes: past the last newline, since the line after it may still be written.
 * Null when those bytes hold no turn event.
 */
function latestTurn(
  fd: number,
  size: number,
  floor: number,
): { offset: number; turn: Turn | null } {
  let offset: number | undefined;
  /** The turns that ended after the latest start found so far. */
  const ended = new Set<string | null>();
  /** Later parts of the line that ends at the first newline of the chunk read last. */
  let tail: Buffer[] = [];
  const read = (line: Buffer): Turn | undefined => {
    const event = turnEvent(line);
    if (!event) return undefined;
    if (!event.started) {
      ended.add(event.turnId);
      return undefined;
    }
    // A start or an end without a turn ID is matched by order alone.
    const byOrder = event.turnId === null || ended.has(null);
    const open = byOrder ? ended.size === 0 : !ended.has(event.turnId);
    return { id: event.turnId, open, startedAt: open ? event.at : null };
  };
  let position = size;
  while (position > floor) {
    const start = Math.max(floor, position - CHUNK_BYTES);
    const chunk = readAt(fd, start, position - start);
    // The file shrank under the read; a later scan sees it replaced.
    if (chunk.length < position - start) break;
    position = start;
    let end = chunk.length;
    for (let newline = lastNewline(chunk, end); newline >= 0; newline = lastNewline(chunk, end)) {
      if (offset === undefined) offset = start + newline + 1;
      else {
        const line = chunk.subarray(newline + 1, end);
        const turn = read(tail.length ? Buffer.concat([line, ...tail]) : line);
        if (turn) return { offset, turn };
      }
      tail = [];
      end = newline;
    }
    // Before the first newline, the bytes either begin the file or continue an earlier line.
    if (offset === undefined) continue;
    tail.unshift(chunk.subarray(0, end));
    if (start === 0) {
      const turn = read(Buffer.concat(tail));
      if (turn) return { offset, turn };
    }
  }
  return {
    offset: offset ?? floor,
    turn: ended.size ? { id: null, open: false, startedAt: null } : null,
  };
}

/** Codex's turn history databases beside its thread databases, newest schema first. */
function historyDatabases(home: string): string[] {
  for (const directory of [home, path.join(home, "sqlite")]) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    const found = names
      .flatMap((name) => {
        const match = HISTORY_DATABASE.exec(name);
        return match ? [{ name, version: Number(match[1]) }] : [];
      })
      .sort((left, right) => right.version - left.version)
      .map(({ name }) => path.join(directory, name));
    if (found.length) return found;
  }
  return [];
}

/**
 * The latest turn as Codex's own turn history records it, which newer Codex keeps beside the
 * rollout. It counts only when its checkpoint lies in the bytes from [floor] to [size]: those
 * held no turn event, so the turn has not changed since the checkpoint.
 */
function projectedTurn(home: string, threadId: string, floor: number, size: number): Turn | null {
  for (const file of historyDatabases(home)) {
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout=1000");
        const sql = new Sql(db);
        const has = (table: string, columns: string[]) => {
          const names = new Set(
            sql.rows(`PRAGMA table_info(${table})`).map((row) => String(row.name)),
          );
          return columns.every((column) => names.has(column));
        };
        if (
          !has("thread_history_projection_state", ["thread_id", "next_rollout_byte_offset"]) ||
          !has("thread_turns", ["thread_id", "turn_id", "rollout_ordinal", "status", "started_at"])
        )
          continue;
        const row = sql.one(
          `SELECT p.next_rollout_byte_offset AS checkpoint, t.turn_id AS turn_id, t.status AS status, t.started_at AS started_at
           FROM thread_history_projection_state AS p
           LEFT JOIN thread_turns AS t ON t.thread_id = p.thread_id
           WHERE p.thread_id = ?
           ORDER BY t.rollout_ordinal DESC
           LIMIT 1`,
          threadId,
        );
        if (!row) continue;
        const checkpoint = Number(row.checkpoint);
        if (!Number.isSafeInteger(checkpoint) || checkpoint < floor || checkpoint > size)
          return null;
        if (typeof row.status !== "string") return null;
        const open = row.status === "inProgress";
        return {
          id: typeof row.turn_id === "string" ? row.turn_id : null,
          open,
          startedAt: open ? timestamp(row.started_at, true) : null,
        };
      } finally {
        db.close();
      }
    } catch {
      // An unreadable history leaves the turn unknown, which shows as not running.
    }
  }
  return null;
}
