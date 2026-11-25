import { createHash } from "node:crypto";
import type {
  NotificationActivitySnapshot,
  PushApprovalAction,
  SessionPendingInteraction,
} from "@agentkib/runtime-protocol";
import {
  displaySessionTitle,
  homeSessionGroups,
  isSessionVisible,
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
  approvalActions?: 1;
  activityDetails?: 1;
  /** Changes when the phone changes its subscription; refusals remembered for the old one are dropped. */
  updatedAt: number;
}

/** Why an alert is sent: the session waits for the person, or its turn ended. */
export type PushAlertKind = HomeNeed | "completed" | "failed";

export interface PushAlertContext {
  summary?: string;
  interaction?: SessionPendingInteraction;
  action?: PushApprovalAction;
}

/** What an alert says once the phone opens it. */
export interface PushAlertMessage {
  v: 1;
  ref: string;
  kind: PushAlertKind;
  sessionId: string;
  agent: string;
  title?: string;
  computer?: string;
  summary?: string;
  interaction?: SessionPendingInteraction;
  action?: PushApprovalAction;
  /** Open the session to view a terminal interaction. The notification offers no decisions. */
  readOnly?: true;
  /** Milliseconds since the epoch. */
  at: number;
}

/**
 * Live Activity content carries counts, times, the waiting category and an optional version
 * in plain JSON. Session details are sealed for the phone. Times are UNIX seconds.
 */
export interface PushActivityContent {
  running: number;
  waiting: number;
  /** What the only waiting session waits for. */
  need?: HomeNeed;
  startedAt: number;
  endedAt?: number;
  version?: string;
  /** Sealed {v: 1, activity: NotificationActivitySnapshot}; the relay cannot read its priority. */
  activityEnvelope?: string;
}

export interface PushNotifierOptions {
  /** The phones that asked for notifications, one entry per login. */
  targets(): readonly PushTarget[];
  /** Existing subscriptions whose official relay is temporarily unavailable. */
  recoveringTargets?(): readonly PushTarget[];
  /** This computer's relay device id; undefined while nothing can be sent. */
  deviceId(): string | undefined;
  send(input: PushSendInput): Promise<PushSendResult>;
  terminalSummary?(
    target: PushTarget,
    sessionId: string,
    kind: "approval" | "question",
  ): Promise<string | undefined>;
  /** Resolve current workspace access and any interaction details for this recipient. */
  alertContext?(
    target: PushTarget,
    session: HomeSession,
    kind: PushAlertKind,
  ): Promise<PushAlertContext | undefined>;
  activitySnapshot?(
    target: PushTarget,
    sessions: readonly HomeSession[],
  ): Promise<NotificationActivitySnapshot | undefined>;
  delivery?(kind: PushAlertKind, present: boolean, now: number): "send" | "hold" | "drop";
  /** The host's notification switch also controls the Live Activity. */
  enabled?(): boolean;
  /** An ActivityKit remote start shows an alert, unlike its later passive updates. */
  activityStartAllowed?(now: number): boolean;
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
/** Allow the native permission prompt to publish its summary after the initial wait state. */
const TERMINAL_APPROVAL_DETAILS_WAIT_MS = 8_000;
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
const ALERT_ENVELOPE_LIMIT = 3_000;
const ACTIVITY_CONTENT_LIMIT = 2_048;

type SessionState = `needs:${HomeNeed}` | "running" | "result:completed" | "result:failed";
interface PendingAlert {
  kind: PushAlertKind;
  state: SessionState | "supervision";
  session: HomeSession;
  at: number;
  /** A Project Agent's result held while its work went on (`#leadBusy`). */
  held?: boolean;
  sending?: boolean;
  processed?: Set<string>;
  relayHold?: ReadonlyMap<string, PushTarget>;
}
function terminalWaitKind(alert: PendingAlert): "approval" | "question" | undefined {
  if (
    alert.session.agent === "claude-code" &&
    alert.session.continuation?.executionLocation === "terminal" &&
    (alert.kind === "approval" || alert.kind === "question")
  )
    return alert.kind;
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
  scopedSince?: number;
  scopedIdleSince?: number;
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

function sameSubscription(current: PushTarget | undefined, target: PushTarget): boolean {
  return (
    current?.session === target.session &&
    current.updatedAt === target.updatedAt &&
    current.publicKey === target.publicKey &&
    current.ref === target.ref &&
    current.activityDetails === target.activityDetails &&
    current.approvalActions === target.approvalActions &&
    current.alerts === target.alerts &&
    current.liveActivity === target.liveActivity
  );
}

function sealAlert(
  target: PushTarget,
  deviceId: string,
  message: PushAlertMessage,
  terminal: boolean,
): string | undefined {
  const { title, computer, summary, interaction, action, ...base } = message;
  const minimal = terminal ? { ...base, readOnly: true as const } : base;
  const candidates = [
    message,
    ...(interaction ? [{ ...base, interaction, action }] : []),
    { ...minimal, title, computer, summary },
    { ...minimal, title, computer },
    minimal,
  ];
  for (const payload of candidates) {
    // The envelope has a 61-byte header and tag in addition to its plaintext bytes.
    if (
      Math.ceil(((Buffer.byteLength(JSON.stringify(payload)) + 61) * 4) / 3) > ALERT_ENVELOPE_LIMIT
    )
      continue;
    return sealPushEnvelope(target.publicKey, deviceId, payload);
  }
}

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
  #supervision = new Set<string>();
  /** The last catalog snapshot, for what a Project Agent's alert waits on. */
  #sessions: readonly HomeSession[] = [];
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
    this.#sessions = sessions;
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
        // Only a turn seen working counts as ended: marking a session unread alerts nothing. A
        // Worker's turn goes to its Project Agent as a report; the person hears from that one.
        else if (
          (state === "result:completed" || state === "result:failed") &&
          (previous === "running" || previous?.startsWith("needs:")) &&
          session.orchestration?.role !== "worker"
        )
          this.#pending.set(id, {
            kind: state === "result:completed" ? "completed" : "failed",
            state,
            session,
            at: now,
          });
      }
    }
    const supervision = new Set<string>();
    for (const session of sessions) {
      const role = session.orchestration;
      if (
        (role?.role !== "lead" && role?.role !== "worker") ||
        !("requiresUser" in role) ||
        role.requiresUser !== true ||
        session.remote ||
        session.archived ||
        session.availability !== "readable" ||
        !isSessionVisible(session)
      )
        continue;
      supervision.add(session.id);
      // An existing approval, question or other request already gives the phone an alert.
      if (
        this.#known &&
        !this.#supervision.has(session.id) &&
        !next.get(session.id)?.startsWith("needs:")
      )
        this.#pending.set(session.id, {
          kind: "verify",
          state: "supervision",
          session,
          at: now,
        });
    }
    this.#supervision = supervision;
    this.#states = next;
    this.#known = true;
    if (groups.needsYou.length || groups.running.length) {
      this.#episode ??= { since: now };
      this.#episode.idleSince = undefined;
      this.#content = {
        running: groups.running.length,
        waiting: groups.needsYou.length,
        ...(groups.needsYou.length === 1 ? { need: groups.needsYou[0]!.need } : {}),
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
    const recovering = this.#options.recoveringTargets?.() ?? [];
    const recoveringBySession = new Map(recovering.map((target) => [target.session, target]));
    // A phone that stopped asking, or whose pairing ended, keeps no Live Activity of this computer.
    for (const [session, state] of this.#targets)
      if (
        !targets.has(session) &&
        recoveringBySession.get(session)?.updatedAt !== state.updatedAt
      ) {
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
          scopedSince: undefined,
          scopedIdleSince: undefined,
        });
    }
    this.#flushAlerts(now, targets, recoveringBySession);
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

  #delivery(kind: PushAlertKind, now: number) {
    const present = this.#options.present?.() ?? false;
    return this.#options.delivery?.(kind, present, now) ?? (present ? "hold" : "send");
  }

  #currentTarget(target: PushTarget): boolean {
    return this.#options.targets().some((current) => sameSubscription(current, target));
  }

  #currentAlert(alert: PendingAlert): boolean {
    const id = alert.session.id;
    return (
      this.#pending.get(id) === alert &&
      (alert.state === "supervision"
        ? this.#supervision.has(id)
        : this.#states.get(id) === alert.state)
    );
  }

  #flushAlerts(
    now: number,
    targets: Map<string, PushTarget>,
    recovering: ReadonlyMap<string, PushTarget>,
  ): void {
    for (const [id, alert] of this.#pending) {
      const result = alert.kind === "completed" || alert.kind === "failed";
      const current = this.#currentAlert(alert);
      const delivery = this.#delivery(alert.kind, now);
      if (!current || delivery === "drop") {
        this.#pending.delete(id);
        continue;
      }
      // A Project Agent's turn ended while its work goes on: one alert once all of it stops,
      // counted from when that is seen.
      if (result) {
        if (this.#leadBusy(id)) {
          alert.held = true;
          continue;
        }
        if (alert.held) {
          alert.held = false;
          alert.at = now;
        }
      }
      const expired = now - alert.at > (result ? RESULT_HOLD_MS : NEED_HOLD_MS);
      if (expired) this.#pending.delete(id);
      else if (recovering.size) {
        // Keep the original subscriptions across reconnects. Changing the map also invalidates
        // any authorization read that was already in flight when the relay paused.
        alert.relayHold = alert.relayHold
          ? new Map(
              [...alert.relayHold].filter(([session, target]) =>
                sameSubscription(recovering.get(session), target),
              ),
            )
          : recovering;
      } else if (delivery === "send" && !alert.sending) {
        if (
          (this.#options.alertContext || this.#options.terminalSummary) &&
          terminalWaitKind(alert) === "approval" &&
          now - alert.at < TERMINAL_APPROVAL_DETAILS_WAIT_MS
        )
          continue;
        this.#sendAlert(alert, now, targets);
      }
    }
  }

  /**
   * A Project Agent still has work in progress: a Worker running or waiting for the person, a
   * report on its way into its next turn, or a background task of its own.
   */
  #leadBusy(id: string): boolean {
    const lead = this.#sessions.find((session) => session.id === id);
    const role = lead?.orchestration;
    if (!lead || role?.role !== "lead") return false;
    if ((role.reports ?? 0) > 0 || (lead.continuation?.backgroundTasks ?? 0) > 0) return true;
    return this.#sessions.some((session) => {
      if (session.orchestration?.role !== "worker" || session.orchestration.leadId !== id)
        return false;
      const state = this.#states.get(session.id);
      return state === "running" || !!state?.startsWith("needs:");
    });
  }

  #sendAlert(alert: PendingAlert, now: number, targets: Map<string, PushTarget>): void {
    const deviceId = this.#options.deviceId();
    if (!deviceId || this.#blockedUntil > now) {
      if (!deviceId || !alert.relayHold) this.#pending.delete(alert.session.id);
      return;
    }
    const relayHold = alert.relayHold;
    const recipients = [...targets.values()].filter((target) => {
      const state = this.#targets.get(target.session);
      if (
        !target.alerts ||
        !state ||
        state.alertsOffUntil > now ||
        state.blockedUntil > now ||
        (relayHold !== undefined && !sameSubscription(relayHold.get(target.session), target)) ||
        alert.processed?.has(target.session)
      )
        return false;
      state.alertTimes = state.alertTimes.filter((at) => now - at < HOUR);
      return state.alertTimes.length < ALERTS_PER_HOUR;
    });
    if (!recipients.length) {
      this.#pending.delete(alert.session.id);
      return;
    }
    const alertTitle = title(alert.session);
    const terminalKind = terminalWaitKind(alert);
    alert.sending = true;
    const processed = (alert.processed ??= new Set());
    this.#track(async () => {
      const computer = clip(
        await (this.#options.computerName?.() ?? Promise.resolve(undefined)).catch(() => undefined),
        COMPUTER_NAME_LIMIT,
      );
      let held = false;
      try {
        await Promise.allSettled(
          recipients.map(async (target) => {
            if (this.#stopped || !this.#currentAlert(alert) || !this.#currentTarget(target)) return;
            const authorize = this.#options.alertContext;
            let context = authorize ? await authorize(target, alert.session, alert.kind) : {};
            if (
              !context ||
              this.#stopped ||
              !this.#currentAlert(alert) ||
              !this.#currentTarget(target)
            )
              return;
            let preview = context.summary;
            const readTerminalSummary = this.#options.terminalSummary;
            if (!preview && terminalKind && readTerminalSummary) {
              preview = await readTerminalSummary(target, alert.session.id, terminalKind).catch(
                () => undefined,
              );
              // A missing preview can also indicate that the target lost workspace access.
              if (!preview && authorize) {
                context = await authorize(target, alert.session, alert.kind);
                if (!context) return;
                preview = context.summary;
              }
            }
            const time = this.#now();
            const state = this.#targets.get(target.session);
            const delivery = this.#delivery(alert.kind, time);
            const result = alert.kind === "completed" || alert.kind === "failed";
            if (
              this.#stopped ||
              !state ||
              alert.relayHold !== relayHold ||
              !this.#currentAlert(alert) ||
              !this.#currentTarget(target) ||
              deviceId !== this.#options.deviceId() ||
              time - alert.at > (result ? RESULT_HOLD_MS : NEED_HOLD_MS)
            )
              return;
            if (delivery === "hold" || (result && this.#leadBusy(alert.session.id))) {
              held = true;
              return;
            }
            if (delivery !== "send") return;
            processed.add(target.session);
            state.alertTimes = state.alertTimes.filter((at) => time - at < HOUR);
            if (
              state.alertTimes.length >= ALERTS_PER_HOUR ||
              state.alertsOffUntil > time ||
              state.blockedUntil > time ||
              this.#blockedUntil > time
            )
              return;
            const summary = clip(preview, 256);
            const interaction = target.approvalActions === 1 ? context.interaction : undefined;
            const action =
              interaction && context.action && context.action.expiresAt > time
                ? context.action
                : undefined;
            const message: PushAlertMessage = {
              v: 1,
              ref: target.ref,
              kind: alert.kind,
              sessionId: alert.session.id,
              agent: alert.session.agent,
              ...(alertTitle ? { title: alertTitle } : {}),
              ...(computer ? { computer } : {}),
              ...(terminalKind && !action ? { readOnly: true } : {}),
              ...(summary ? { summary } : {}),
              ...(interaction ? { interaction } : {}),
              ...(action ? { action } : {}),
              at: alert.at,
            };
            const envelope = sealAlert(target, deviceId, message, terminalKind !== undefined);
            if (!envelope) return;
            state.alertTimes.push(time);
            const sent = await this.#options.send({
              session: target.session,
              kind: "alert",
              envelope,
              collapseId: collapseId(alert.session.id),
            });
            if (!sent.delivered && this.#currentTarget(target))
              this.#refused(state, sent, "alerts");
          }),
        );
      } finally {
        alert.sending = false;
        if (!held && alert.relayHold === relayHold && this.#pending.get(alert.session.id) === alert)
          this.#pending.delete(alert.session.id);
      }
    });
  }

  #updateActivities(now: number, targets: Map<string, PushTarget>): void {
    if (
      this.#episode?.idleSince !== undefined &&
      now - this.#episode.idleSince >= this.#activityEndDelayMs
    ) {
      this.#episode = undefined;
      for (const state of this.#targets.values()) {
        state.dismissed = false;
        state.scopedSince = undefined;
        state.scopedIdleSince = undefined;
      }
    }
    const episode = this.#episode;
    const content = this.#content;
    // Without recent snapshots the content may be wrong: nothing is sent, and the phone marks
    // the activity outdated at its stale date.
    for (const target of targets.values()) {
      const state = this.#targets.get(target.session)!;
      // Checked again on the next tick, once the send in flight settled.
      if (state.busy) continue;
      const enabled = this.#options.enabled?.() ?? true;
      if (state.activity && (!episode || !target.liveActivity || !enabled)) {
        this.#end(target.session, state, now, !!episode || !enabled);
        continue;
      }
      if (
        !episode ||
        !enabled ||
        !target.liveActivity ||
        now - this.#snapshotAt >= SNAPSHOT_FRESH_MS ||
        !this.#options.deviceId()
      )
        continue;
      if (target.activityDetails === 1) {
        this.#scopedActivity(target, state);
        continue;
      }
      if (
        content &&
        episode.idleSince === undefined &&
        now - episode.since >= this.#activityDelayMs
      )
        this.#showActivity(target, state, content, now);
    }
  }

  #scopedActivity(target: PushTarget, state: TargetState): void {
    const read = this.#options.activitySnapshot;
    const deviceId = this.#options.deviceId();
    if (!read || !deviceId) return;
    const sessions = this.#sessions;
    state.busy = true;
    this.#track(async () => {
      let snapshot: NotificationActivitySnapshot | undefined;
      try {
        snapshot = await read(target, sessions);
      } finally {
        state.busy = false;
      }
      const now = this.#now();
      if (
        this.#stopped ||
        !(this.#options.enabled?.() ?? true) ||
        !this.#currentTarget(target) ||
        deviceId !== this.#options.deviceId() ||
        sessions !== this.#sessions ||
        now - this.#snapshotAt >= SNAPSHOT_FRESH_MS
      )
        return;
      if (!snapshot || (!snapshot.running && !snapshot.waiting)) {
        state.scopedIdleSince ??= now;
        if (!snapshot || now - state.scopedIdleSince >= this.#activityEndDelayMs) {
          state.scopedSince = undefined;
          state.scopedIdleSince = undefined;
          state.dismissed = false;
          if (state.activity) this.#end(target.session, state, now, !snapshot);
        }
        return;
      }
      state.scopedIdleSince = undefined;
      state.scopedSince ??= now;
      if (now - state.scopedSince < this.#activityDelayMs) return;
      this.#showActivity(
        target,
        state,
        {
          running: snapshot.running,
          waiting: snapshot.waiting,
          ...(snapshot.waiting === 1 && snapshot.priority
            ? { need: snapshot.priority.category }
            : {}),
          startedAt: seconds(state.scopedSince),
          version: snapshot.version,
        },
        now,
        snapshot,
      );
    });
  }

  #showActivity(
    target: PushTarget,
    state: TargetState,
    content: PushActivityContent,
    now: number,
    snapshot?: NotificationActivitySnapshot,
  ): void {
    if (state.dismissed || this.#blockedUntil > now || state.blockedUntil > now) return;
    const text = JSON.stringify(content);
    if (!state.activity) {
      if (state.activityOffUntil <= now && (this.#options.activityStartAllowed?.(now) ?? true))
        this.#start(target, state, content, now, snapshot);
    } else if (now - state.activity.startedAt >= ACTIVITY_LIFETIME_MS)
      this.#end(target.session, state, now, true);
    else if (
      (text !== state.activity.content && now - state.activity.sentAt >= UPDATE_INTERVAL_MS) ||
      now - state.activity.sentAt >= HEARTBEAT_MS
    )
      this.#update(target, state, content, now, snapshot);
  }

  #activityPayload(
    target: PushTarget,
    content: PushActivityContent,
    snapshot?: NotificationActivitySnapshot,
  ): PushActivityContent {
    const deviceId = this.#options.deviceId();
    if (!snapshot || !deviceId) return content;
    try {
      const activityEnvelope = sealPushEnvelope(target.publicKey, deviceId, {
        v: 1,
        activity: snapshot,
      });
      const payload = { ...content, activityEnvelope };
      if (Buffer.byteLength(JSON.stringify(payload)) <= ACTIVITY_CONTENT_LIMIT) return payload;
    } catch {
      // The relay can still deliver the scoped counters alone.
    }
    return content;
  }

  #start(
    target: PushTarget,
    state: TargetState,
    content: PushActivityContent,
    now: number,
    snapshot?: NotificationActivitySnapshot,
  ): void {
    state.busy = true;
    this.#track(async () => {
      try {
        const result = await this.#options.send({
          session: target.session,
          kind: "activity",
          event: "start",
          contentState: { ...this.#activityPayload(target, content, snapshot) },
          // Once per stretch of work, and it should appear while the work is fresh.
          priority: 10,
          staleDate: seconds(now + STALE_AFTER_MS),
        });
        if (result.delivered) {
          state.activity = {
            confirmed: false,
            startedAt: now,
            sentAt: now,
            content: JSON.stringify(content),
            waiting: content.waiting,
          };
        } else this.#refused(state, result, "activity");
      } finally {
        state.busy = false;
      }
      if (
        state.activity &&
        (this.#stopped ||
          !(this.#options.enabled?.() ?? true) ||
          (!this.#currentTarget(target) &&
            !this.#options.recoveringTargets?.().some((entry) => sameSubscription(entry, target))))
      )
        this.#end(target.session, state, this.#now(), true);
    });
  }

  #update(
    target: PushTarget,
    state: TargetState,
    content: PushActivityContent,
    now: number,
    snapshot?: NotificationActivitySnapshot,
  ): void {
    const activity = state.activity!;
    state.busy = true;
    const text = JSON.stringify(content);
    this.#track(async () => {
      try {
        const result = await this.#options.send({
          session: target.session,
          kind: "activity",
          event: "update",
          contentState: { ...this.#activityPayload(target, content, snapshot) },
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
