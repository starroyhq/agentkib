import { homeSessionGroups, type HomeSession } from "@agentkib/session-catalog";
import {
  applyConversationCatalogPatch,
  conversationCatalogPatch,
  rememberConversationCatalogPatch,
  type ConversationCatalogPatch,
} from "@agentkib/web-client";
import type { ConversationHub } from "./conversation-hub";
import type { WebAccessService } from "./web/service";

function trayRow(
  row: NonNullable<ConversationCatalogPatch["updates"][number]["row"]>,
  previous?: HomeSession,
): HomeSession {
  return { ...row, readState: previous?.readState };
}

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
  follow(onChange: (patch?: ConversationCatalogPatch) => void): Promise<() => void>;
}

/** The tray reads the same local catalog and change stream as the session window. */
export function traySessionSource(
  service: Pick<WebAccessService, "localRequest" | "localSubscribe">,
  hub: Pick<ConversationHub, "unsubscribe">,
  indexEnabled: () => Promise<boolean>,
): TraySessionSource {
  return {
    async readSessions() {
      if (!(await indexEnabled())) return;
      const { status, body } = await service.localRequest("/catalog");
      const catalog = body as { sessions?: unknown; orchestrationUnavailable?: true } | undefined;
      if (status === 200 && !catalog?.orchestrationUnavailable && Array.isArray(catalog?.sessions))
        return catalog.sessions as HomeSession[];
    },
    async follow(onChange) {
      const subscription = await service.localSubscribe("", undefined, (event) => {
        if (
          event.type === "invalidate" &&
          Array.isArray(event.payload.domains) &&
          event.payload.domains.includes("catalog")
        )
          onChange(conversationCatalogPatch(event.payload));
        else if (event.type === "snapshot" || event.type === "resync-required") onChange();
      });
      return () => void hub.unsubscribe(subscription.subscriptionId).catch(() => undefined);
    },
  };
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
 * While a turn is running, update the menu bar counts and notification inputs
 * from pushed continuations. Broad changes use a bounded background refresh.
 * An idle tray can reuse changes another window already observes.
 */
export class TraySessionWatcher {
  readonly #source: TraySessionSource;
  readonly #onStatus: (status: TraySessionStatus) => void;
  readonly #idleMs: number;
  readonly #settleMs: number;
  readonly #onSessions: TraySessionWatcherOptions["onSessions"];
  #status = IDLE_TRAY_STATUS;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #nextReadAt = Infinity;
  #lastBackgroundReadAt = -Infinity;
  #sessions: HomeSession[] | undefined;
  #updatesDuringRead: Map<string, ConversationCatalogPatch["updates"][number]> | undefined;
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
    this.#nextReadAt = Infinity;
    this.#sessions = undefined;
    this.#updatesDuringRead = undefined;
    this.#unfollow();
  }

  /** Reads the catalog soon; calls that arrive within the settle delay read it once. */
  refresh(delay = this.#settleMs): void {
    if (this.#stopped) return;
    const at = Date.now() + delay;
    if (this.#nextReadAt <= at) return;
    clearTimeout(this.#timer);
    this.#nextReadAt = at;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#nextReadAt = Infinity;
      if (delay < this.#idleMs && delay !== 0) this.#lastBackgroundReadAt = Date.now();
      void this.#read();
    }, delay);
    this.#timer.unref?.();
  }

  /** The runtime restarted and dropped its followers: follow again if a session still runs. */
  restart(): void {
    this.#unfollow();
    this.#sessions = undefined;
    this.refresh();
  }

  otherObserverChanged(patch?: ConversationCatalogPatch): void {
    if (!this.#following) this.#catalogChanged(patch);
  }

  #catalogChanged(patch?: ConversationCatalogPatch): void {
    if (this.#stopped) return;
    if (!patch) {
      this.refresh(Math.max(this.#settleMs, this.#lastBackgroundReadAt + 3_000 - Date.now()));
      return;
    }
    if (this.#updatesDuringRead) rememberConversationCatalogPatch(this.#updatesDuringRead, patch);
    if (!this.#sessions) return;
    const next = applyConversationCatalogPatch(this.#sessions, patch, trayRow);
    if (next !== this.#sessions) this.#publish(next);
  }

  async #read(): Promise<void> {
    if (this.#reading) {
      this.#readAgain = true;
      return;
    }
    this.#reading = true;
    const updates = new Map<string, ConversationCatalogPatch["updates"][number]>();
    this.#updatesDuringRead = updates;
    try {
      let sessions: readonly HomeSession[] | undefined;
      try {
        sessions = await this.#source.readSessions();
      } catch {
        sessions = undefined;
      }
      if (this.#stopped) return;
      this.#publish(
        sessions
          ? applyConversationCatalogPatch(
              [...sessions],
              { updates: [...updates.values()] },
              trayRow,
            )
          : undefined,
      );
    } finally {
      this.#reading = false;
      this.#updatesDuringRead = undefined;
      if (this.#readAgain) {
        this.#readAgain = false;
        this.refresh(0);
      } else this.refresh(this.#idleMs);
    }
  }

  #publish(sessions: HomeSession[] | undefined): void {
    this.#sessions = sessions;
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
  }

  #follow(): void {
    if (this.#following) return;
    const attempt = this.#source
      .follow((patch) => {
        if (this.#following === attempt) this.#catalogChanged(patch);
      })
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
