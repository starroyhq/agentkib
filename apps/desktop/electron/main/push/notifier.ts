import { createHash } from "node:crypto";
import {
  displaySessionTitle,
  homeSessionGroups,
  type HomeNeed,
  type HomeSession,
} from "@agentkib/session-catalog";
import type { PushSendInput, PushSendResult } from "../web/relay/manager";
import { sealPushEnvelope } from "./envelope";

/** A phone that asked this computer for notifications. */
export interface PushTarget {
  /** The phone's account login; the relay delivers to it and nothing else. */
  session: string;
  /** The phone's X25519 key that alerts are encrypted to. */
  publicKey: string;
  /** The phone's own name for this computer, returned inside every alert. */
  ref: string;
  alerts: boolean;
  liveActivity: boolean;
  /** Changes when the phone changes its subscription; refusals remembered for the old one are dropped. */
  updatedAt: number;
}

/** Why an alert is sent: the session waits for the person, or its turn ended. */
export type PushAlertKind = HomeNeed | "completed" | "failed";

/** What an alert says once the phone opens it. */
export interface PushAlertMessage {
  v: 1;
  ref: string;
  kind: PushAlertKind;
  sessionId: string;
  agent: string;
  title?: string;
  computer?: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/**
 * The Live Activity's content. Apple delivers it as plain JSON, so it keeps to counts and times,
 * plus the session title when exactly one session works. Times are UNIX seconds.
 */
export interface PushActivityContent {
  running: number;
  waiting: number;
  /** What the only waiting session waits for. */
  need?: HomeNeed;
  title?: string;
  startedAt: number;
  endedAt?: number;
}

export interface PushNotifierOptions {
  /** The phones that asked for notifications, one entry per login. */
  targets(): readonly PushTarget[];
  /** This computer's relay device id; undefined while nothing can be sent. */
  deviceId(): string | undefined;
  send(input: PushSendInput): Promise<PushSendResult>;
  computerName?(): Promise<string | undefined>;
  /** Whether someone uses this computer now. Alerts wait until they leave. */
  present?(): boolean;
  now?(): number;
  /** Work must last this long before a Live Activity starts, so short turns never start one. */
  activityDelayMs?: number;
  /** The Live Activity ends after nothing has worked for this long, so the gap between turns keeps it. */
  activityEndDelayMs?: number;
  /** How often pending work is checked while something runs, waits or is shown. */
  tickMs?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** An unseen result is not worth an alert after the person sat at the computer this long. */
const RESULT_HOLD_MS = 15 * MINUTE;
/** A waiting session stays worth an alert this long. */
const NEED_HOLD_MS = 8 * HOUR;
/** Alerts one phone receives from this computer at most, per hour. */
const ALERTS_PER_HOUR = 30;
/** Live Activity updates are at least this far apart; Apple budgets them. */
const UPDATE_INTERVAL_MS = 30_000;
/** An unchanged Live Activity is refreshed this often, so it does not turn stale while work goes on. */
const HEARTBEAT_MS = 15 * MINUTE;
/** The phone shows the activity as outdated when no update came for this long (the computer slept or quit). */
const STALE_AFTER_MS = 20 * MINUTE;
/** The phone reports a remotely started activity's update token in this time; later it was dismissed. */
const ACTIVITY_REGISTRATION_MS = 3 * MINUTE;
/** iOS ends a Live Activity after eight hours; a new one replaces it a little earlier. */
const ACTIVITY_LIFETIME_MS = 8 * HOUR - 10 * MINUTE;
/** How long an ended activity stays on the Lock Screen. */
const ENDED_VISIBLE_MS = 5 * MINUTE;
/** A refusal for one phone (no token, no Live Activities) is tried again after this long. */
const TARGET_OFF_MS = HOUR;
/** No answer, or push is off on the relay: wait this long before sending again. */
const RETRY_MS = MINUTE;
/** On quit, ending the Live Activities may take this long. */
const STOP_TIMEOUT_MS = 3_000;
/** The menu bar reads the catalog at least once a minute; older content is not sent. */
const SNAPSHOT_FRESH_MS = 5 * MINUTE;
const TITLE_LIMIT = 100;
const COMPUTER_NAME_LIMIT = 64;

type SessionState = `needs:${HomeNeed}` | "running" | "result:completed" | "result:failed";
interface PendingAlert {
  kind: PushAlertKind;
  state: SessionState;
  session: HomeSession;
  at: number;
}
interface Activity {
  /** An update reached it, so the phone reported its update token after the remote start. */
  confirmed: boolean;
  startedAt: number;
  sentAt: number;
  content: string;
  waiting: number;
}
interface TargetState {
  updatedAt: number;
  alertsOffUntil: number;
  activityOffUntil: number;
  blockedUntil: number;
  /** The phone removed this episode's activity; none starts again until work stops. */
  dismissed: boolean;
  alertTimes: number[];
  activity?: Activity;
  busy: boolean;
}

function clip(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined;
  const characters = [...value];
  return characters.length > limit ? characters.slice(0, limit - 1).join("") + "…" : value;
}
const title = (session: HomeSession) => clip(displaySessionTitle(session.title, ""), TITLE_LIMIT);
const seconds = (ms: number) => Math.floor(ms / 1000);
/** One notification per session on the phone: a later alert replaces the earlier one. */
const collapseId = (sessionId: string) =>
  "s" + createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
const retryable = (error: string) =>
  error === "push_unavailable" ||
  error === "relay_unavailable" ||
  error === "relay_unreachable" ||
  /^http_(5\d\d|403)$/.test(error);

/**
 * Tells the phones that asked about this computer's sessions: an encrypted alert when a session
 * waits for the person or its turn ends, and a Live Activity while sessions work. It reads the
 * catalog snapshots the menu bar already takes, so it adds no catalog reads of its own.
 *
 * Alerts wait while someone uses this computer and go out once they leave, unless the session
 * moved on meanwhile. Sessions found in their state when the notifier starts alert nothing.
 */
export class PushNotifier {
  readonly #options: PushNotifierOptions;
  readonly #now: () => number;
  readonly #activityDelayMs: number;
  readonly #activityEndDelayMs: number;
  readonly #tickMs: number;
  #states = new Map<string, SessionState>();
  #known = false;
  #pending = new Map<string, PendingAlert>();
  /** Work started at `since`; `idleSince` is when the last session stopped working. */
  #episode: { since: number; idleSince?: number } | undefined;
  #content: PushActivityContent | undefined;
  #snapshotAt = -Infinity;
  #targets = new Map<string, TargetState>();
  #blockedUntil = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;
  #inflight = new Set<Promise<void>>();

  constructor(options: PushNotifierOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#activityDelayMs = options.activityDelayMs ?? MINUTE;
    this.#activityEndDelayMs = options.activityEndDelayMs ?? 30_000;
    this.#tickMs = options.tickMs ?? 15_000;
  }

  /** A catalog snapshot; undefined while the catalog cannot be read, which changes nothing. */
  update(sessions: readonly HomeSession[] | undefined): void {
    if (this.#stopped || !sessions) return;
    const now = this.#now();
    this.#snapshotAt = now;
    const groups = homeSessionGroups(sessions, { recent: 0 });
    const next = new Map<string, SessionState>();
    for (const entry of groups.needsYou) next.set(entry.session.id, `needs:${entry.need}`);
    for (const entry of groups.running) next.set(entry.session.id, "running");
    for (const entry of groups.review)
      if (entry.result === "completed" || entry.result === "failed")
        next.set(entry.session.id, `result:${entry.result}`);
    if (this.#known) {
      const byId = new Map(sessions.map((session) => [session.id, session]));
      for (const [id, state] of next) {
        const previous = this.#states.get(id);
        if (previous === state) continue;
        const session = byId.get(id)!;
        if (state.startsWith("needs:"))
          this.#pending.set(id, {
            kind: state.slice(6) as HomeNeed,
            state,
            session,
            at: now,
          });
        // Only a turn seen working counts as ended: marking a session unread alerts nothing.
        else if (
          (state === "result:completed" || state === "result:failed") &&
          (previous === "running" || previous?.startsWith("needs:"))
        )
          this.#pending.set(id, {
            kind: state === "result:completed" ? "completed" : "failed",
            state,
            session,
            at: now,
          });
      }
    }
    this.#states = next;
    this.#known = true;
    const working = [...groups.needsYou, ...groups.running];
    if (working.length) {
      this.#episode ??= { since: now };
      this.#episode.idleSince = undefined;
      const only = working.length === 1 ? working[0]!.session : undefined;
      const onlyTitle = only ? title(only) : undefined;
      this.#content = {
        running: groups.running.length,
        waiting: groups.needsYou.length,
        ...(groups.needsYou.length === 1 ? { need: groups.needsYou[0]!.need } : {}),
        ...(onlyTitle ? { title: onlyTitle } : {}),
        startedAt: seconds(this.#episode.since),
      };
    } else if (this.#episode) this.#episode.idleSince ??= now;
    this.#evaluate();
  }

  /** Sends what is due now; the phones' subscriptions or this computer's presence may have changed. */
  refresh(): void {
    if (!this.#stopped) this.#evaluate();
  }

  /** Ends the Live Activities on quit, waiting a little for the relay to take them. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    const now = this.#now();
    for (const [session, state] of this.#targets)
      if (state.activity) this.#end(session, state, now, true);
    await Promise.race([
      Promise.allSettled([...this.#inflight]),
      new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS).unref?.()),
    ]);
  }

  #evaluate(): void {
    const now = this.#now();
    const targets = new Map(this.#options.targets().map((target) => [target.session, target]));
    // A phone that stopped asking, or whose pairing ended, keeps no Live Activity of this computer.
    for (const [session, state] of this.#targets)
      if (!targets.has(session)) {
        if (state.activity && !state.busy) this.#end(session, state, now, true);
        if (!state.activity && !state.busy) this.#targets.delete(session);
      }
    for (const target of targets.values()) {
      const state = this.#targets.get(target.session);
      if (!state) this.#targets.set(target.session, this.#targetState(target));
      else if (state.updatedAt !== target.updatedAt)
        Object.assign(state, {
          updatedAt: target.updatedAt,
          alertsOffUntil: 0,
          activityOffUntil: 0,
          dismissed: false,
        });
    }
    this.#flushAlerts(now, targets);
    this.#updateActivities(now, targets);
    const busy =
      !!this.#episode ||
      this.#pending.size > 0 ||
      [...this.#targets.values()].some((state) => state.activity || state.busy);
    if (busy && !this.#timer) {
      this.#timer = setInterval(() => this.#evaluate(), this.#tickMs);
      this.#timer.unref?.();
    } else if (!busy && this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #targetState(target: PushTarget): TargetState {
    return {
      updatedAt: target.updatedAt,
      alertsOffUntil: 0,
      activityOffUntil: 0,
      blockedUntil: 0,
      dismissed: false,
      alertTimes: [],
      busy: false,
    };
  }

  #flushAlerts(now: number, targets: Map<string, PushTarget>): void {
    if (!this.#pending.size) return;
    const present = this.#options.present?.() ?? false;
    for (const [id, alert] of this.#pending) {
      const expired =
        now - alert.at >
        (alert.kind === "completed" || alert.kind === "failed" ? RESULT_HOLD_MS : NEED_HOLD_MS);
      if (this.#states.get(id) !== alert.state || expired) this.#pending.delete(id);
      else if (!present) {
        this.#pending.delete(id);
        this.#sendAlert(alert, now, targets);
      }
    }
  }

  #sendAlert(alert: PendingAlert, now: number, targets: Map<string, PushTarget>): void {
    const deviceId = this.#options.deviceId();
    if (!deviceId || this.#blockedUntil > now) return;
    const recipients = [...targets.values()].filter((target) => {
      const state = this.#targets.get(target.session);
      if (!target.alerts || !state || state.alertsOffUntil > now || state.blockedUntil > now)
        return false;
      state.alertTimes = state.alertTimes.filter((at) => now - at < HOUR);
      if (state.alertTimes.length >= ALERTS_PER_HOUR) return false;
      state.alertTimes.push(now);
      return true;
    });
    if (!recipients.length) return;
    const alertTitle = title(alert.session);
    this.#track(async () => {
      const computer = clip(
        await (this.#options.computerName?.() ?? Promise.resolve(undefined)).catch(() => undefined),
        COMPUTER_NAME_LIMIT,
      );
      await Promise.all(
        recipients.map(async (target) => {
          const message: PushAlertMessage = {
            v: 1,
            ref: target.ref,
            kind: alert.kind,
            sessionId: alert.session.id,
            agent: alert.session.agent,
            ...(alertTitle ? { title: alertTitle } : {}),
            ...(computer ? { computer } : {}),
            at: alert.at,
          };
          let envelope: string;
          try {
            envelope = sealPushEnvelope(target.publicKey, deviceId, message);
          } catch {
            return;
          }
          const result = await this.#options.send({
            session: target.session,
            kind: "alert",
            envelope,
            collapseId: collapseId(alert.session.id),
          });
          const state = this.#targets.get(target.session);
          if (!result.delivered && state) this.#refused(state, result, "alerts");
        }),
      );
    });
  }

  #updateActivities(now: number, targets: Map<string, PushTarget>): void {
    if (
      this.#episode?.idleSince !== undefined &&
      now - this.#episode.idleSince >= this.#activityEndDelayMs
    ) {
      this.#episode = undefined;
      for (const state of this.#targets.values()) state.dismissed = false;
    }
    const episode = this.#episode;
    const content = this.#content;
    // Without recent snapshots the content may be wrong: nothing is sent, and the phone marks
    // the activity outdated at its stale date.
    const shown =
      !!episode &&
      episode.idleSince === undefined &&
      now - episode.since >= this.#activityDelayMs &&
      now - this.#snapshotAt < SNAPSHOT_FRESH_MS &&
      !!content &&
      !!this.#options.deviceId();
    for (const target of targets.values()) {
      const state = this.#targets.get(target.session)!;
      // Checked again on the next tick, once the send in flight settled.
      if (state.busy) continue;
      if (state.activity && (!episode || !target.liveActivity)) {
        this.#end(target.session, state, now, !!episode);
        continue;
      }
      if (
        !shown ||
        !target.liveActivity ||
        state.dismissed ||
        this.#blockedUntil > now ||
        state.blockedUntil > now
      )
        continue;
      const text = JSON.stringify(content);
      if (!state.activity) {
        if (state.activityOffUntil <= now) this.#start(target.session, state, content!, now);
      } else if (now - state.activity.startedAt >= ACTIVITY_LIFETIME_MS)
        // A new one starts on a later check, once this one ended.
        this.#end(target.session, state, now, true);
      else if (
        (text !== state.activity.content && now - state.activity.sentAt >= UPDATE_INTERVAL_MS) ||
        now - state.activity.sentAt >= HEARTBEAT_MS
      )
        this.#update(target.session, state, content!, now);
    }
  }

  #start(session: string, state: TargetState, content: PushActivityContent, now: number): void {
    state.busy = true;
    this.#track(async () => {
      try {
        const result = await this.#options.send({
          session,
          kind: "activity",
          event: "start",
          contentState: { ...content },
          // Once per stretch of work, and it should appear while the work is fresh.
          priority: 10,
          staleDate: seconds(now + STALE_AFTER_MS),
        });
        if (result.delivered)
          state.activity = {
            confirmed: false,
            startedAt: now,
            sentAt: now,
            content: JSON.stringify(content),
            waiting: content.waiting,
          };
        else this.#refused(state, result, "activity");
      } finally {
        state.busy = false;
      }
    });
  }

  #update(session: string, state: TargetState, content: PushActivityContent, now: number): void {
    const activity = state.activity!;
    state.busy = true;
    const text = JSON.stringify(content);
    this.#track(async () => {
      try {
        const result = await this.#options.send({
          session,
          kind: "activity",
          event: "update",
          contentState: { ...content },
          // Someone waiting is worth showing at once; the rest waits for a good moment.
          priority: content.waiting > activity.waiting ? 10 : 5,
          staleDate: seconds(now + STALE_AFTER_MS),
        });
        activity.sentAt = now;
        if (result.delivered) {
          Object.assign(activity, { confirmed: true, content: text, waiting: content.waiting });
          return;
        }
        if (
          result.error === "activity_unknown" &&
          !activity.confirmed &&
          now - activity.startedAt < ACTIVITY_REGISTRATION_MS
        )
          return;
        if (result.error === "activity_unknown" || result.error === "push_target_gone") {
          // The person removed it, or the phone never got its token: no new one until work stops.
          state.activity = undefined;
          state.dismissed = true;
          return;
        }
        this.#refused(state, result, "activity");
      } finally {
        state.busy = false;
      }
    });
  }

  /** `dismiss` removes it from the Lock Screen at once; otherwise it shows the outcome for a while. */
  #end(session: string, state: TargetState, now: number, dismiss: boolean): void {
    const activity = state.activity!;
    state.activity = undefined;
    state.busy = true;
    const last = JSON.parse(activity.content) as PushActivityContent;
    const content: PushActivityContent = {
      running: 0,
      waiting: 0,
      startedAt: last.startedAt,
      endedAt: seconds(now),
    };
    this.#track(async () => {
      try {
        await this.#options.send({
          session,
          kind: "activity",
          event: "end",
          contentState: { ...content },
          priority: 10,
          dismissalDate: seconds(dismiss ? now : now + ENDED_VISIBLE_MS),
        });
      } finally {
        state.busy = false;
      }
    });
  }

  #refused(
    state: TargetState,
    result: Extract<PushSendResult, { delivered: false }>,
    kind: "alerts" | "activity",
  ): void {
    const now = this.#now();
    if (result.error === "push_throttled" || result.error === "http_429")
      state.blockedUntil = now + Math.max(result.retryAfterSeconds ?? 0, 600) * 1000;
    else if (retryable(result.error)) this.#blockedUntil = now + RETRY_MS;
    // No token for this kind, or a refusal that repeats: a relay without push, a rejected payload.
    else if (kind === "alerts") state.alertsOffUntil = now + TARGET_OFF_MS;
    else state.activityOffUntil = now + TARGET_OFF_MS;
  }

  #track(work: () => Promise<void>): void {
    const promise = work().catch(() => undefined);
    this.#inflight.add(promise);
    void promise.finally(() => this.#inflight.delete(promise));
  }
}
