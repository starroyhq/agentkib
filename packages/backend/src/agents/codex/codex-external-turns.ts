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
import { lstat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isCompressedRollout, resolveRollout } from "./codex-rollout-files";
import { CodexSessions } from "./codex-sessions";
import { within } from "../../files";
import { existingFileLeaseBusy } from "../../managed-session-lock";
import { isReparseOrSymlink } from "../../native-files";
import { sanitizeSessionText } from "../../session-handoff";
import { Sql } from "../../sql";
import { timestamp } from "../../timestamps";
import {
  openSessionLog,
  SESSION_LOG_BLOCK_BYTES,
  type SessionLogSnapshot,
} from "../../session-log-reader";

/**
 * A turn that a Codex client outside AgentKib, such as the Codex app or the CLI, is running
 * now. For display only: it never grants or blocks a control.
 */
export type ExternalTurn = { status: "running"; startedAt: string | null; turnId?: string };

/** A turn whose end a thread's rollout records, whoever ran it. */
export type EndedTurn = {
  turnId: string;
  outcome: "completed" | "cancelled" | "failed";
  startedAt: string | null;
  endedAt: string | null;
  /** A distinct subsequent turn started in the same native rollout. */
  superseded?: true;
  replyText?: string;
};

const LOCK_DIRECTORY = "thread-writer-locks";
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HISTORY_DATABASE = /^thread_history_(\d+)\.sqlite$/;
const TURN_EVENTS = ["task_started", "task_complete", "turn_aborted"];
const TURN_MARKERS = TURN_EVENTS.map((type) => Buffer.from(`"${type}"`));
const EVENT_MARKER = Buffer.from('"event_msg"');
const ROW_HEAD =
  /^\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?"type"\s*:\s*"([^"\\]+)"(?:\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"([^"\\]+)")?/;
const WORKER_EVENT_TYPES = [
  "agent_message",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "item_started",
  "item_completed",
  "exec_command_begin",
  "exec_command_end",
];
const WORKER_MARKERS = [...WORKER_EVENT_TYPES, "response_item"].map((type) =>
  Buffer.from(`"${type}"`),
);
const SHELL_CALLS = new Set(["exec", "exec_command", "shell", "shell_command"]);
const MAX_COMMANDS = 1024;
const CHUNK_BYTES = SESSION_LOG_BLOCK_BYTES;
/** How far back from its end a rollout is read for its latest turn. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const ACTIVE_TAIL_BYTES = 4 * 1024 * 1024;
const APPEND_WITNESS_BYTES = 1024;
/** Bound unfinished-line bytes retained by each of the two scan caches. */
const MAX_CACHED_TAIL_BYTES = MAX_SCAN_BYTES;
/** A rollout not written for this long is not running, whatever its latest turn says. */
const MAX_QUIET_MS = 6 * 60 * 60_000;
/** How long one writer lock probe stands. */
const LOCK_TTL_MS = 5_000;
/** How long a thread missing from Codex's database is not looked up again. */
const MISSING_TTL_MS = 60_000;
const LOOKUP_RETRY_MS = 1_000;
/** Turn times come from the rollout and lock times from the file system. */
const CLOCK_SLACK_MS = 2_000;
/** How far back a rollout is read for its ended turns the first time. */
const ENDED_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_ENDED = 20;
const MAX_TRACKED_THREADS = 64;
const MAX_ENDED_REPLY = 4_096;

type TurnEvent = {
  started: boolean;
  outcome: EndedTurn["outcome"];
  turnId: string | null;
  at: string | null;
  replyText?: string;
};
/** The latest turn to start in a thread. */
type Turn = {
  id: string | null;
  open: boolean;
  startedAt: string | null;
  interrupted?: true;
};
type CommandEvidence = {
  call?: { startedAt?: number } | null;
  execution?: { startedAt?: number } | null;
};
/** Identity and last observed bytes, including the final incomplete line. */
type RolloutScan = {
  file: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  boundary: Buffer;
  // Null means the start of the current line was outside the bounded read.
  tail: Buffer | null;
};
/** Where a rollout was read up to, and its latest turn there. */
type Scan = RolloutScan & {
  turn: Turn | null;
  progressOffset: number | null;
  // Undefined if a scan couldn't read from the start of the turn.
  commands?: Map<string, CommandEvidence>;
};
/** Where a rollout was read up to for ended turns: the turns begun and not ended, the ended. */
type EndedScan = RolloutScan & {
  open: Map<string, string | null>;
  ended: EndedTurn[];
};
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
  #missingUntil = new Map<string, number>();
  #scans = new Map<string, Scan>();
  #scanFlights = new Map<string, Promise<Scan | undefined>>();
  #activeGuards = new Map<string, RolloutScan & { turn: Turn | null }>();
  #locks = new Map<string, { at: number; ino: number; dev: number; busy: boolean }>();
  // Kept apart from the running-turn caches, which `observe` prunes to the locked threads.
  #endedThreads = new Map<string, Thread>();
  #ended = new Map<string, EndedScan>();
  #endedFlights = new Map<string, Promise<EndedScan | undefined>>();

  constructor(private readonly home: () => string) {}

  /** The running external turns, by thread ID as Codex records it. Never throws. */
  async observe(now = Date.now()): Promise<Map<string, ExternalTurn>> {
    const running = new Map<string, ExternalTurn>();
    try {
      const home = this.home();
      const locks = new Map<string, string>();
      for (const name of lockFiles(home)) {
        const id = name.slice(0, -".lock".length);
        if (THREAD_ID.test(id)) locks.set(id.toLowerCase(), name);
      }
      prune(this.#threads, locks);
      prune(this.#missingUntil, locks);
      prune(this.#scans, locks);
      prune(this.#locks, locks);
      prune(this.#activeGuards, locks);
      for (const [key, name] of locks) if (!this.#heldLock(home, key, name, now)) locks.delete(key);
      this.#lookUp(home, [...locks.keys()], now);
      for (const [key, name] of locks) {
        const thread = this.#threads.get(key);
        const turn = thread && (await this.#turn(home, key, thread, name, now));
        if (turn) running.set(thread.id, turn);
      }
    } catch {
      // Display only: a failed observation shows nothing rather than breaking the catalog.
    }
    return running;
  }

  /**
   * The running external turn of one thread with a verified writer lock. Never throws.
   */
  async turnOf(threadId: string, now = Date.now()): Promise<ExternalTurn | null> {
    try {
      if (!THREAD_ID.test(threadId)) return null;
      const home = this.home();
      const key = threadId.toLowerCase();
      const lockName = `${threadId}.lock`;
      if (!this.#heldLock(home, key, lockName, now)) return null;
      this.#lookUp(home, [key], now);
      const thread = this.#threads.get(key);
      return thread ? await this.#turn(home, key, thread, lockName, now) : null;
    } catch {
      return null;
    }
  }

  /** A lock-verified external turn and the latest observed progress in its rollout. */
  async workerTurnOf(threadId: string) {
    const externalTurn = await this.turnOf(threadId);
    const scan = this.#scans.get(threadId.toLowerCase());
    return externalTurn && scan
      ? {
          externalTurn,
          workerProgress: `${scan.dev}:${scan.ino}:${scan.progressOffset ?? ""}`,
          ...(scan.tail?.length === 0 &&
            scan.commands && {
              commands: [...scan.commands].flatMap(([id, { call, execution }]) => {
                // A tool request can return before the process exits. A recorded execution owns
                // the process lifecycle even when its ID also appears as a function call.
                const active = execution === undefined ? call : execution;
                return active ? [{ id, ...active }] : [];
              }),
            }),
        }
      : null;
  }

  /**
   * The latest turns of one thread whose end its rollout records, oldest first, whoever ran them:
   * for a Project Agent's worker that ran while AgentKib did not watch it. Reads where the rollout
   * grew since the last call, or its end the first time. Never throws.
   */
  async endedTurns(
    threadId: string,
    now = Date.now(),
    verifiedTranscript?: string,
  ): Promise<EndedTurn[]> {
    try {
      if (!THREAD_ID.test(threadId)) return [];
      const home = this.home();
      const key = threadId.toLowerCase();
      let recorded = verifiedTranscript;
      if (!recorded) {
        const thread = this.#endedThreads.get(key);
        if (!thread) this.#lookUp(home, [key], now);
        recorded = (thread ?? this.#threads.get(key))?.recorded;
      }
      if (!recorded) return [];
      if (!this.#endedThreads.has(key)) {
        if (this.#endedThreads.size >= MAX_TRACKED_THREADS) {
          const oldest = this.#endedThreads.keys().next().value!;
          this.#endedThreads.delete(oldest);
          this.#ended.delete(oldest);
        }
        this.#endedThreads.set(key, { id: threadId, recorded });
      }
      const file = resolveRollout(path.isAbsolute(recorded) ? recorded : path.join(home, recorded));
      if (!within(file, home)) {
        this.#endedThreads.delete(key);
        return [];
      }
      // Codex compresses only idle threads' rollouts: nothing ended since the last read.
      if (isCompressedRollout(file)) return this.#ended.get(key)?.ended.slice() ?? [];
      const scan = await this.#endedScan(key, file);
      // The rollout moved, as an archived thread's does: look it up again next time.
      if (!scan) this.#endedThreads.delete(key);
      return scan?.ended.slice() ?? [];
    } catch {
      return [];
    }
  }

  async #endedScan(key: string, file: string): Promise<EndedScan | undefined> {
    const seen = await rolloutStat(file);
    if (!seen) return;
    return this.#readScan(
      key,
      file,
      seen,
      this.#ended,
      this.#endedFlights,
      async (handle, stat, previous) => {
        const from = previous?.size ?? Math.max(0, stat.size - ENDED_TAIL_BYTES);
        const scan: EndedScan = {
          ...rolloutIdentity(file, stat),
          open: new Map(previous?.open),
          ended: previous?.ended.slice() ?? [],
        };
        scan.tail = await readRows(
          handle,
          from,
          stat.size,
          previous ? previous.tail : from > 0 ? null : Buffer.alloc(0),
          (line) => recordEndedTurn(scan, line),
        );
        return scan;
      },
    );
  }

  /** Finds the rollouts of threads not looked up yet in Codex's thread databases. */
  #lookUp(home: string, keys: string[], now: number) {
    const wanted = keys.filter(
      (key) => !this.#threads.has(key) && now >= (this.#missingUntil.get(key) ?? 0),
    );
    if (!wanted.length) return;
    const current = codex.databases(home);
    let retrySoon = false;
    for (const file of current.length ? current : codex.databases(path.join(home, "sqlite"))) {
      const pending = wanted.filter((key) => !this.#threads.has(key));
      if (!pending.length) break;
      try {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
          db.exec("PRAGMA busy_timeout=0");
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
        // A busy or migrating database is not evidence the thread is absent.
        retrySoon = true;
      }
    }
    for (const key of wanted)
      if (this.#threads.has(key)) this.#missingUntil.delete(key);
      else this.#missingUntil.set(key, now + (retrySoon ? LOOKUP_RETRY_MS : MISSING_TTL_MS));
  }

  // Read-state compares against a fresh writer observation around a native receipt. Its
  // synchronous guard only scans on a held lock, and only when the async cache is not current.
  activeTurnId(threadId: string, now = Date.now()): string | null {
    try {
      if (!THREAD_ID.test(threadId)) return null;
      const home = this.home();
      const key = threadId.toLowerCase();
      const held = this.#heldLock(home, key, `${threadId}.lock`, now);
      if (!held) return null;
      this.#lookUp(home, [key], now);
      const thread = this.#threads.get(key);
      const file = thread && this.#rollout(home, thread);
      if (!file) return null;
      const stat = lstatSync(file);
      if (!this.#isCurrentRollout(file, stat, now)) return null;
      for (const candidate of [this.#scans.get(key), this.#activeGuards.get(key)]) {
        if (sameRollout(candidate, file, stat))
          return this.#displayTurn(candidate?.turn, held)?.turnId ?? null;
      }
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const current = fstatSync(fd);
        if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino) return null;
        const floor = Math.max(0, current.size - MAX_SCAN_BYTES);
        const turn =
          latestTurn(fd, current.size, floor).turn ??
          (floor > 0 ? projectedTurn(home, threadId, floor, current.size) : null);
        if (!this.#activeGuards.has(key) && this.#activeGuards.size >= MAX_TRACKED_THREADS)
          this.#activeGuards.delete(this.#activeGuards.keys().next().value!);
        this.#activeGuards.set(key, { ...rolloutIdentity(file, current), turn });
        return this.#displayTurn(turn, held)?.turnId ?? null;
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  #rollout(home: string, thread: Thread): string | undefined {
    const file = resolveRollout(
      path.isAbsolute(thread.recorded) ? thread.recorded : path.join(home, thread.recorded),
    );
    // Codex compresses only the rollouts of idle threads.
    if (within(file, home) && !isCompressedRollout(file)) return file;
  }

  #isCurrentRollout(file: string, stat: Stats, now: number): boolean {
    return stat.isFile() && !isReparseOrSymlink(file, stat) && now - stat.mtimeMs <= MAX_QUIET_MS;
  }

  #heldLock(home: string, key: string, name: string, now: number): Stats | undefined {
    const lock = path.join(home, LOCK_DIRECTORY, name);
    try {
      const stat = lstatSync(lock);
      if (stat.isFile() && this.#lockHeld(key, lock, stat, now)) return stat;
    } catch {
      // No lock means there can be no active turn to read.
    }
  }

  #displayTurn(turn: Turn | null | undefined, lock: Stats): ExternalTurn | null {
    if (!turn?.open) return null;
    // A lock file newer than the turn belongs to a client that opened it after
    // the turn began, and the client that began it is gone.
    const started = turn.startedAt === null ? Number.NaN : Date.parse(turn.startedAt);
    if (Number.isFinite(started) && lock.mtimeMs > started + CLOCK_SLACK_MS) return null;
    return {
      status: "running",
      startedAt: turn.startedAt,
      ...(turn.id ? { turnId: turn.id } : {}),
    };
  }

  async #turn(
    home: string,
    key: string,
    thread: Thread,
    lockName: string,
    now: number,
  ): Promise<ExternalTurn | null> {
    const held = this.#heldLock(home, key, lockName, now);
    const file = held && this.#rollout(home, thread);
    if (!held || !file) return null;
    const stat = await rolloutStat(file);
    if (!stat) {
      // The rollout moved, as an archived thread's does. Look it up again later.
      this.#threads.delete(key);
      this.#scans.delete(key);
      this.#missingUntil.set(key, now + MISSING_TTL_MS);
      return null;
    }
    if (!this.#isCurrentRollout(file, stat, now)) return null;
    const scan = await this.#scan(home, key, thread.id, file, stat);
    // A long cold read can outlive the writer lock. Never project that turn as active.
    const lock = this.#heldLock(home, key, lockName, Date.now());
    if (!lock || lock.dev !== held.dev || lock.ino !== held.ino) return null;
    return this.#displayTurn(scan?.turn, lock);
  }

  #lockHeld(key: string, lock: string, stat: Stats, now: number): boolean {
    const cached = this.#locks.get(key);
    if (
      cached &&
      cached.dev === stat.dev &&
      cached.ino === stat.ino &&
      now - cached.at < LOCK_TTL_MS
    )
      return cached.busy;
    let busy: boolean;
    try {
      busy = existingFileLeaseBusy(lock);
    } catch {
      busy = false;
    }
    this.#locks.set(key, { at: now, dev: stat.dev, ino: stat.ino, busy });
    return busy;
  }

  /** Reads what the rollout gained since the last scan, or its end when it is new or replaced. */
  #scan(home: string, key: string, threadId: string, file: string, seen: Stats) {
    return this.#readScan(
      key,
      file,
      seen,
      this.#scans,
      this.#scanFlights,
      async (handle, stat, previous) => {
        if (previous) {
          const scan: Scan = {
            ...previous,
            ...rolloutIdentity(file, stat),
            commands: previous.commands && new Map(previous.commands),
          };
          scan.tail = await readRows(
            handle,
            previous.size,
            stat.size,
            previous.tail,
            (line, end) => {
              const event = turnEvent(line);
              if (
                event?.started &&
                (!scan.turn?.open || !event.turnId || event.turnId !== scan.turn.id)
              ) {
                scan.progressOffset = null;
                scan.commands = new Map();
              }
              scan.turn = nextTurn(scan.turn, event);
              if (scan.turn?.open) recordWorkerActivity(scan, line, end);
            },
          );
          return scan;
        }
        const floor = Math.max(0, stat.size - ACTIVE_TAIL_BYTES);
        const latest = await latestTurnAsync(handle, stat.size, floor);
        const scan: Scan = {
          ...rolloutIdentity(file, stat),
          progressOffset: latest.progressOffset,
          // A turn that began before the bytes read is found in Codex's own turn history.
          turn: latest.turn ?? (floor > 0 ? projectedTurn(home, threadId, floor, stat.size) : null),
        };
        if (scan.turn?.open && latest.startedAfter !== undefined) {
          scan.progressOffset = null;
          scan.commands = new Map();
          scan.tail = await readRows(
            handle,
            latest.startedAfter,
            stat.size,
            scan.tail,
            (line, end) => {
              recordWorkerActivity(scan, line, end);
            },
          );
        } else {
          scan.tail = await readRows(
            handle,
            latest.offset,
            stat.size,
            latest.offset === floor && floor > 0 ? null : scan.tail,
            () => {},
          );
        }
        return scan;
      },
    );
  }

  async #readScan<T extends RolloutScan>(
    key: string,
    file: string,
    seen: Stats,
    cache: Map<string, T>,
    flights: Map<string, Promise<T | undefined>>,
    read: (handle: SessionLogSnapshot, stat: Stats, previous?: T) => Promise<T>,
  ): Promise<T | undefined> {
    const previous = cache.get(key);
    if (sameRollout(previous, file, seen)) return previous;
    const flightKey = `${key}\0${file}\0${seen.dev}:${seen.ino}`;
    const inFlight = flights.get(flightKey);
    if (inFlight) return inFlight;
    const pending = (async () => {
      let handle: SessionLogSnapshot | undefined;
      try {
        handle = await openSessionLog(file);
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== seen.dev || stat.ino !== seen.ino) return;
        if (sameRollout(previous, file, stat)) return previous;
        const resume =
          previous?.file === file &&
          previous.dev === stat.dev &&
          previous.ino === stat.ino &&
          previous.size < stat.size &&
          stat.size - previous.size <= MAX_SCAN_BYTES &&
          previous.boundary.equals(await readBoundary(handle, previous.size, true))
            ? previous
            : undefined;
        const scan = await read(handle, stat, resume);
        scan.boundary = await readBoundary(handle, stat.size);
        const after = await handle.stat();
        if (after.size < stat.size || (after.size === stat.size && !sameRollout(scan, file, after)))
          return;
        // A newer inode may have been observed while this read was in flight.
        if (cache.get(key) === previous) cacheScan(cache, key, scan);
        return scan;
      } catch {
        // Missing or rewritten rollouts are retried on the next observation.
      } finally {
        await handle?.close().catch(() => undefined);
      }
    })();
    flights.set(flightKey, pending);
    try {
      return await pending;
    } finally {
      flights.delete(flightKey);
    }
  }
}

function cacheScan<T extends RolloutScan>(cache: Map<string, T>, key: string, scan: T) {
  cache.delete(key);
  cache.set(key, scan);
  let total = 0;
  for (const entry of cache.values()) total += entry.tail?.length ?? 0;
  for (const [oldKey, entry] of cache) {
    if (total <= MAX_CACHED_TAIL_BYTES) break;
    if (entry.tail?.length) {
      total -= entry.tail.length;
      cache.delete(oldKey);
    }
  }
}

async function rolloutStat(file: string): Promise<Stats | undefined> {
  try {
    const stat = await lstat(file);
    if (stat.isFile() && !isReparseOrSymlink(file, stat)) return stat;
  } catch {}
}

function rolloutIdentity(file: string, stat: Stats): RolloutScan {
  return {
    file,
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    boundary: Buffer.alloc(0),
    tail: Buffer.alloc(0),
  };
}

function sameRollout(scan: RolloutScan | undefined, file: string, stat: Stats): boolean {
  return (
    scan?.file === file &&
    scan.dev === stat.dev &&
    scan.ino === stat.ino &&
    scan.size === stat.size &&
    scan.mtimeMs === stat.mtimeMs &&
    scan.ctimeMs === stat.ctimeMs
  );
}

async function readChunk(
  handle: SessionLogSnapshot,
  position: number,
  length: number,
  current = false,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(length);
  let count = 0;
  while (count < length) {
    const { bytesRead } = await handle[current ? "readCurrent" : "read"](
      bytes,
      count,
      length - count,
      position + count,
    );
    if (!bytesRead) throw new Error("rollout truncated during read");
    count += bytesRead;
  }
  return bytes;
}

function readBoundary(handle: SessionLogSnapshot, size: number, current = false): Promise<Buffer> {
  const length = Math.min(size, APPEND_WITNESS_BYTES);
  return readChunk(handle, size - length, length, current);
}

/** No complete line needs an allocation unless it crosses a chunk boundary. */
async function readRows(
  handle: SessionLogSnapshot,
  from: number,
  size: number,
  tail: Buffer | null,
  consume: (line: Buffer, newlineAt: number) => void,
): Promise<Buffer | null> {
  let pending: Buffer[] | null = tail === null ? null : tail.length ? [tail] : [];
  let lineBytes = tail?.length ?? 0;
  const take = (bytes: Buffer) => {
    if (pending === null || bytes.length === 0) return;
    lineBytes += bytes.length;
    if (lineBytes > MAX_SCAN_BYTES) pending = null;
    else pending.push(bytes);
  };
  for (let at = from; at < size;) {
    const bytes = await readChunk(handle, at, Math.min(CHUNK_BYTES, size - at));
    let start = 0;
    for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
      take(bytes.subarray(start, end));
      if (pending?.length)
        consume(pending.length === 1 ? pending[0] : Buffer.concat(pending, lineBytes), at + end);
      pending = [];
      lineBytes = 0;
      start = end + 1;
    }
    take(bytes.subarray(start));
    at += bytes.length;
  }
  return pending && Buffer.concat(pending, lineBytes);
}

function recordEndedTurn(scan: EndedScan, line: Buffer): void {
  const event = turnEvent(line);
  if (event?.turnId && event.started) {
    const id = event.turnId;
    if (!scan.open.has(id) && !scan.ended.some((turn) => turn.turnId === id)) {
      scan.open.set(id, event.at);
      if (scan.open.size > MAX_ENDED) scan.open.delete(scan.open.keys().next().value!);
      const started = event.at === null ? NaN : Date.parse(event.at);
      // Require source order and trustworthy timestamps. Old replayed starts do
      // not supersede a more recent completion.
      scan.ended = scan.ended.map((turn) =>
        !turn.superseded && turn.endedAt !== null && started >= Date.parse(turn.endedAt)
          ? { ...turn, superseded: true }
          : turn,
      );
    }
  } else if (event?.turnId) {
    const index = scan.ended.findIndex((turn) => turn.turnId === event.turnId);
    const previous = scan.ended[index];
    const replyText = event.replyText?.trim()
      ? sanitizeSessionText(event.replyText, { value: 0 }).slice(0, MAX_ENDED_REPLY)
      : previous?.replyText;
    const turn: EndedTurn = {
      turnId: event.turnId,
      outcome: previous?.outcome === "failed" ? "failed" : event.outcome,
      startedAt: scan.open.get(event.turnId) ?? previous?.startedAt ?? null,
      endedAt: previous?.endedAt ?? event.at,
      ...(previous?.superseded ? { superseded: true } : {}),
      ...(replyText ? { replyText } : {}),
    };
    if (index < 0) scan.ended.push(turn);
    else scan.ended[index] = turn;
    scan.open.delete(event.turnId);
    if (scan.ended.length > MAX_ENDED) scan.ended.shift();
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

function workerRow(
  line: Buffer,
): (Record<string, unknown> & { payload: Record<string, unknown> }) | undefined {
  if (line[0] !== 0x7b) return undefined;
  const head = ROW_HEAD.exec(line.toString("utf8", 0, 384));
  if (head) {
    const [, kind, type] = head;
    if (
      kind !== "response_item" &&
      (kind !== "event_msg" || (type !== undefined && !WORKER_EVENT_TYPES.includes(type)))
    )
      return undefined;
  } else if (!WORKER_MARKERS.some((marker) => line.indexOf(marker) >= 0)) {
    return undefined;
  }
  try {
    const row: unknown = JSON.parse(line.toString("utf8"));
    if (
      isRecord(row) &&
      (row.type === "event_msg" || row.type === "response_item") &&
      isRecord(row.payload)
    )
      return { ...row, payload: row.payload };
  } catch {
    // A malformed rollout row supplies no evidence.
  }
  return undefined;
}

function modelActivity(row: NonNullable<ReturnType<typeof workerRow>>): boolean {
  const { payload } = row;
  if (row.type === "response_item") {
    if (payload.type === "reasoning")
      return (
        (Array.isArray(payload.summary) && payload.summary.length > 0) ||
        (Array.isArray(payload.content) && payload.content.length > 0) ||
        (typeof payload.encrypted_content === "string" && payload.encrypted_content.length > 0)
      );
    return (
      payload.type === "message" &&
      payload.role === "assistant" &&
      Array.isArray(payload.content) &&
      payload.content.length > 0
    );
  }
  if (row.type !== "event_msg") return false;
  if (payload.type === "agent_message")
    return typeof payload.message === "string" && payload.message.length > 0;
  if (payload.type === "agent_reasoning" || payload.type === "agent_reasoning_raw_content")
    return typeof payload.text === "string" && payload.text.length > 0;
  return (
    (payload.type === "item_started" || payload.type === "item_completed") &&
    isRecord(payload.item) &&
    ["AgentMessage", "Reasoning", "Plan"].includes(String(payload.item.type))
  );
}

function recordWorkerActivity(scan: Scan, line: Buffer, offset: number) {
  const row = workerRow(line);
  if (!row) return;
  const { payload } = row;
  const turn = payload.turn_id ?? row.turn_id;
  if (scan.turn?.id && typeof turn === "string" && turn !== scan.turn.id) return;
  if (modelActivity(row)) scan.progressOffset = offset;

  const commands = scan.commands;
  if (!commands) return;
  const item = isRecord(payload.item) ? payload.item : undefined;
  let id: unknown;
  let started: boolean;
  let source: keyof CommandEvidence;
  if (row.type === "response_item") {
    source = "call";
    id = payload.call_id;
    started = payload.type === "function_call" || payload.type === "custom_tool_call";
    if (
      started
        ? typeof payload.name !== "string" || !SHELL_CALLS.has(payload.name)
        : payload.type !== "function_call_output" && payload.type !== "custom_tool_call_output"
    )
      return;
  } else if (row.type === "event_msg") {
    source = "execution";
    if (
      item?.type === "CommandExecution" &&
      ["item_started", "item_completed"].includes(String(payload.type))
    ) {
      id = item.id;
      started = payload.type === "item_started";
    } else if (payload.type === "exec_command_begin" || payload.type === "exec_command_end") {
      id = payload.call_id;
      started = payload.type === "exec_command_begin";
    } else return;
  } else return;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    if (started) scan.commands = undefined;
    return;
  }
  const prior = commands.get(id);
  if (!started) {
    if (prior && prior[source] !== null) {
      if (prior[source]) scan.progressOffset = offset;
      commands.set(id, { ...prior, [source]: null });
    }
    return;
  }
  if (prior?.[source] !== undefined) return;
  if (!prior && commands.size >= MAX_COMMANDS) {
    scan.commands = undefined;
    return;
  }
  const startedAt = Date.parse(timestamp(row.timestamp, true) ?? "");
  commands.set(id, { ...prior, [source]: Number.isFinite(startedAt) ? { startedAt } : {} });
  scan.progressOffset = offset;
}

/** The turn event of one rollout line, if it is one. */
function turnEvent(line: Buffer): TurnEvent | undefined {
  // Cheap checks first: most lines are not turn events, and some are megabytes long.
  if (line[0] !== 0x7b) return undefined;
  const head = ROW_HEAD.exec(line.toString("utf8", 0, 384));
  if (head) {
    const [, kind, type] = head;
    if (kind !== "event_msg" || (type !== undefined && !TURN_EVENTS.includes(type)))
      return undefined;
  } else if (line.indexOf(EVENT_MARKER) < 0) {
    return undefined;
  }
  if (!head?.[2] && !TURN_MARKERS.some((marker) => line.indexOf(marker) >= 0)) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(line.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isRecord(row) || row.type !== "event_msg" || !isRecord(row.payload)) return undefined;
  const { type, turn_id: turnId, error, last_agent_message: replyText } = row.payload;
  if (typeof type !== "string" || !TURN_EVENTS.includes(type)) return undefined;
  return {
    started: type === "task_started",
    outcome: type === "turn_aborted" ? "cancelled" : error == null ? "completed" : "failed",
    turnId: typeof turnId === "string" && turnId ? turnId : null,
    at: timestamp(row.timestamp),
    ...(type === "task_complete" && typeof replyText === "string" ? { replyText } : {}),
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
type LatestTurn = {
  offset: number;
  turn: Turn | null;
  progressOffset: number | null;
  startedAfter?: number;
  /** A lone, explicitly identified abort, with no start in the scanned window. */
  unmatchedAbortId?: string;
};

function latestTurn(fd: number, size: number, floor: number): LatestTurn {
  const scan = latestTurnReads(size, floor, false);
  let next = scan.next();
  while (!next.done) next = scan.next(readAt(fd, next.value.position, next.value.length));
  return next.value;
}

async function latestTurnAsync(
  handle: SessionLogSnapshot,
  size: number,
  floor: number,
): Promise<LatestTurn> {
  const scan = latestTurnReads(size, floor, true);
  let next = scan.next();
  while (!next.done)
    next = scan.next(await readChunk(handle, next.value.position, next.value.length));
  return next.value;
}

function* latestTurnReads(
  size: number,
  floor: number,
  activity: boolean,
): Generator<{ position: number; length: number }, LatestTurn, Buffer> {
  let offset: number | undefined;
  let progressOffset: number | null = null;
  /** The turns that ended after the latest start found so far. */
  const ended = new Map<string | null, EndedTurn["outcome"]>();
  let endCount = 0;
  /** Later parts of the line that ends at the first newline of the chunk read last. */
  let tail: Buffer[] = [];
  const read = (line: Buffer, position: number): Turn | undefined => {
    const event = turnEvent(line);
    if (!event) {
      if (activity && progressOffset === null) {
        const row = workerRow(line);
        if (row && modelActivity(row)) progressOffset = position;
      }
      return undefined;
    }
    if (!event.started) {
      endCount++;
      if (!ended.has(event.turnId)) ended.set(event.turnId, event.outcome);
      return undefined;
    }
    // A start or an end without a turn ID is matched by order alone.
    const byOrder = event.turnId === null || ended.has(null);
    const open = byOrder ? ended.size === 0 : !ended.has(event.turnId);
    return {
      id: event.turnId,
      open,
      startedAt: open ? event.at : null,
      ...(!byOrder && ended.get(event.turnId) === "cancelled" && { interrupted: true }),
    };
  };
  let position = size;
  let lineEnd = size;
  while (position > floor) {
    const start = Math.max(floor, Math.floor((position - 1) / CHUNK_BYTES) * CHUNK_BYTES);
    const chunk = yield { position: start, length: position - start };
    // The file shrank under the read; a later scan sees it replaced.
    if (chunk.length < position - start) break;
    position = start;
    let end = chunk.length;
    for (let newline = lastNewline(chunk, end); newline >= 0; newline = lastNewline(chunk, end)) {
      if (offset === undefined) offset = start + newline + 1;
      else {
        const line = chunk.subarray(newline + 1, end);
        const turn = read(tail.length ? Buffer.concat([line, ...tail]) : line, lineEnd);
        if (turn) return { offset, turn, progressOffset, startedAfter: lineEnd + 1 };
      }
      tail = [];
      lineEnd = start + newline;
      end = newline;
    }
    // Before the first newline, the bytes either begin the file or continue an earlier line.
    if (offset === undefined) continue;
    tail.unshift(chunk.subarray(0, end));
    if (start === 0) {
      const turn = read(Buffer.concat(tail), lineEnd);
      if (turn) return { offset, turn, progressOffset, startedAfter: lineEnd + 1 };
    }
  }
  const terminal = floor > 0 && endCount === 1 ? ended.entries().next().value : undefined;
  return {
    offset: offset ?? floor,
    turn: ended.size ? { id: null, open: false, startedAt: null } : null,
    progressOffset,
    ...(terminal?.[0] && terminal[1] === "cancelled" && { unmatchedAbortId: terminal[0] }),
  };
}

/** Bounded proof that the latest durable turn was interrupted, with no later start. */
export function codexQuitHistoryProof(
  file: string | null,
  turnId: string,
  requireUnmatchedAbort = false,
): string | undefined {
  if (!file || isCompressedRollout(file)) return;
  const entry = lstatSync(file);
  if (!entry.isFile() || isReparseOrSymlink(file, entry)) return;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) return;
    const scan = latestTurn(fd, stat.size, Math.max(0, stat.size - MAX_SCAN_BYTES));
    const after = fstatSync(fd);
    // An owned, interrupted turn can be longer than the window. Resume still checks the
    // native app-server's latest turn and settings before submitting any input.
    const interrupted =
      scan.unmatchedAbortId === turnId ||
      (!requireUnmatchedAbort && scan.turn?.id === turnId && scan.turn.interrupted === true);
    if (
      scan.offset !== stat.size ||
      !interrupted ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      return;
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } finally {
    closeSync(fd);
  }
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
        db.exec("PRAGMA busy_timeout=0");
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
