import { homeSessionGroups, type HomeSession } from "@agentkib/session-catalog";

/** What the menu bar icon shows without being opened. */
export interface TraySessionStatus {
  /** Sessions that wait for an approval, an answer or a check from the person. */
  needsYou: number;
  /** Sessions with a turn running now. */
  running: number;
}

export const IDLE_TRAY_STATUS: TraySessionStatus = { needsYou: 0, running: 0 };

export interface TraySessionSource {
  /** This computer's sessions; undefined while the session index is off or cannot be read. */
  readSessions(): Promise<readonly HomeSession[] | undefined>;
  /** Follows the catalog's changes until the returned function is called. */
  follow(onChange: () => void): Promise<() => void>;
}

export interface TraySessionWatcherOptions {
  /** How often the catalog is read while nothing runs. */
  idleMs?: number;
  /** Changes arriving within this delay are read once. */
  settleMs?: number;
  /** Receives every snapshot read, undefined when the catalog could not be read. */
  onSessions?: (sessions: readonly HomeSession[] | undefined) => void;
}

/**
 * Keeps the menu bar icon's counts current without keeping the catalog busy. Following the
 * catalog makes the runtime read it every two seconds, so the watcher follows it only while a
 * session runs, which is when it changes by itself. Otherwise it reads the catalog once a
 * minute, and whenever `refresh` says something changed: a control settled, or another window
 * that follows the catalog saw a change.
 */
export class TraySessionWatcher {
  readonly #source: TraySessionSource;
  readonly #onStatus: (status: TraySessionStatus) => void;
  readonly #idleMs: number;
  readonly #settleMs: number;
  readonly #onSessions: TraySessionWatcherOptions["onSessions"];
  #status = IDLE_TRAY_STATUS;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #reading = false;
  #readAgain = false;
  #stopped = true;
  /** The running follow, or the attempt to start one. */
  #following: Promise<(() => void) | undefined> | undefined;

  constructor(
    source: TraySessionSource,
    onStatus: (status: TraySessionStatus) => void,
    { idleMs = 60_000, settleMs = 750, onSessions }: TraySessionWatcherOptions = {},
  ) {
    this.#source = source;
    this.#onStatus = onStatus;
    this.#idleMs = idleMs;
    this.#settleMs = settleMs;
    this.#onSessions = onSessions;
  }

  get status(): TraySessionStatus {
    return this.#status;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.refresh(0);
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#unfollow();
  }

  /** Reads the catalog soon; calls that arrive within the settle delay read it once. */
  refresh(delay = this.#settleMs): void {
    if (this.#stopped) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.#read(), delay);
    this.#timer.unref?.();
  }

  /** The runtime restarted and dropped its followers: follow again if a session still runs. */
  restart(): void {
    this.#following = undefined;
    this.refresh();
  }

  async #read(): Promise<void> {
    if (this.#reading) {
      this.#readAgain = true;
      return;
    }
    this.#reading = true;
    try {
      let sessions: readonly HomeSession[] | undefined;
      try {
        sessions = await this.#source.readSessions();
      } catch {
        sessions = undefined;
      }
      if (this.#stopped) return;
      this.#onSessions?.(sessions);
      const groups = sessions ? homeSessionGroups(sessions, { recent: 0 }) : undefined;
      const status = groups
        ? { needsYou: groups.needsYou.length, running: groups.running.length }
        : IDLE_TRAY_STATUS;
      if (status.needsYou !== this.#status.needsYou || status.running !== this.#status.running) {
        this.#status = status;
        this.#onStatus(status);
      }
      if (status.running > 0) this.#follow();
      else this.#unfollow();
    } finally {
      this.#reading = false;
      if (this.#readAgain) {
        this.#readAgain = false;
        this.refresh(0);
      } else this.refresh(this.#idleMs);
    }
  }

  #follow(): void {
    if (this.#following) return;
    const attempt = this.#source
      .follow(() => this.refresh())
      .then(
        (stop) => {
          // Nothing runs any more, or the watcher stopped, while the follow was starting.
          if (this.#following !== attempt) {
            stop();
            return undefined;
          }
          return stop;
        },
        () => {
          // The next read tries again.
          if (this.#following === attempt) this.#following = undefined;
          return undefined;
        },
      );
    this.#following = attempt;
  }

  #unfollow(): void {
    const following = this.#following;
    this.#following = undefined;
    void following?.then((stop) => stop?.());
  }
}
