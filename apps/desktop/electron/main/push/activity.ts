import { createHash } from "node:crypto";
import type {
  NotificationActivityCategory,
  NotificationActivitySnapshot,
} from "@agentkib/runtime-protocol";
import {
  homeSessionGroups,
  isSessionVisible,
  type HomeSession,
  type HomeSessionGroups,
} from "@agentkib/session-catalog";
import { notificationTitle } from "./notification-title";

export type NotificationActivitySession = HomeSession & { sidechain?: boolean };
export type NotificationActivityObservation = {
  snapshot: NotificationActivitySnapshot;
  /** This work map stays on the host and never enters a push or HTTP response. */
  work: ReadonlyMap<string, "running" | "waiting">;
};

/** Worker turns do not start or extend the computer's Live Activity. */
export function notificationActivitySessions<T extends NotificationActivitySession>(
  sessions: readonly T[],
): T[] {
  return sessions.filter((session) => session?.orchestration?.role !== "worker");
}

const MAX_MISSING_WORK = 4096;

type WorkStart = { sequence: number; at: number };
type ObservedWork = { idle: true } | { idle: false; turnId?: string; start?: WorkStart };

/** Tracks observed turns once, independently of any phone's active request or authorization. */
export class NotificationActivityWork {
  #observed = new Map<string, ObservedWork>();
  #sequence = 0;

  get sequence(): number {
    return this.#sequence;
  }

  observe(
    sessions: readonly NotificationActivitySession[],
    groups: HomeSessionGroups<NotificationActivitySession>,
    at: number,
  ): void {
    const observed = new Map<string, ObservedWork>();
    const active = (session: NotificationActivitySession, inTurn: boolean) => {
      const previous = this.#observed.get(session.id);
      const lastActive = previous?.idle === false ? previous : undefined;
      const turnId =
        session.externalTurn?.status === "running" ? session.externalTurn.turnId : undefined;
      const newTurn = !!turnId && !!lastActive?.turnId && turnId !== lastActive.turnId;
      const start =
        newTurn || (inTurn && previous?.idle)
          ? { sequence: ++this.#sequence, at }
          : lastActive?.start;
      observed.set(session.id, { idle: false, turnId: turnId ?? lastActive?.turnId, start });
    };
    for (const { session } of groups.running) active(session, true);
    for (const { session, need } of groups.needsYou)
      active(session, need === "approval" || need === "question");
    for (const session of sessions) {
      if (
        !observed.has(session.id) &&
        session.continuation?.status === "idle" &&
        !session.remote &&
        !session.archived &&
        !session.sidechain &&
        session.availability === "readable" &&
        isSessionVisible(session)
      )
        observed.set(session.id, { idle: true });
    }
    // Retain last observations across holes, with a bound for deletions or removed sources.
    // An evicted ID has no work evidence and cannot establish a new turn.
    let missing = 0;
    for (const [id, work] of this.#observed) {
      if (observed.has(id)) continue;
      observed.set(id, work);
      if (++missing === MAX_MISSING_WORK) break;
    }
    this.#observed = observed;
  }

  startAfter(
    work: NotificationActivityObservation["work"],
    boundary: number,
  ): WorkStart | undefined {
    let first: WorkStart | undefined;
    for (const [id, phase] of work) {
      if (phase !== "running") continue;
      const observed = this.#observed.get(id);
      const start = observed?.idle === false ? observed.start : undefined;
      if (start && start.sequence > boundary && (!first || start.sequence < first.sequence))
        first = start;
    }
    return first;
  }
}

const priorityOrder: readonly NotificationActivityCategory[] = [
  "approval",
  "question",
  "verify",
  "delegation",
];

function sessionTime(session: HomeSession): number | undefined {
  for (const source of [session.updated_at, session.created_at]) {
    const time = Date.parse(source ?? "");
    if (Number.isFinite(time)) return time;
  }
}

function selectPriority(
  needs: HomeSessionGroups<NotificationActivitySession>["needsYou"],
): NotificationActivitySnapshot["priority"] {
  for (const category of priorityOrder) {
    const candidates = needs.filter((row) => row.need === category);
    const first = candidates[0];
    if (!first) continue;
    // Home groups order by the latest session time. Break equal-time ties by ID so catalog
    // ordering changes do not change a widget or generate a version on reconnect.
    const time = sessionTime(first.session);
    const session = candidates.reduce(
      (current, { session: candidate }) =>
        (sessionTime(candidate) ?? 0) === (time ?? 0) && candidate.id < current.id
          ? candidate
          : current,
      first.session,
    );
    const selectedTime = sessionTime(session);
    return {
      sessionId: session.id,
      agent: session.agent,
      category,
      count: candidates.length,
      title: notificationTitle(session),
      ...(selectedTime === undefined ? {} : { time: new Date(selectedTime).toISOString() }),
    };
  }
}

/** Uses the host's current authorized workspace scope before counting or choosing a session. */
export function projectNotificationActivity(
  sessions: readonly NotificationActivitySession[],
  scope: {
    workspaceIds: readonly string[];
    versionScope: string;
    unconfirmed?: ReadonlySet<string>;
  },
  now = Date.now(),
): NotificationActivityObservation {
  const workspaceIds = new Set(scope.workspaceIds);
  const visible = notificationActivitySessions(sessions).filter(
    (row) =>
      row &&
      typeof row.id === "string" &&
      typeof row.agent === "string" &&
      workspaceIds.has(row.workspace_id) &&
      !row.sidechain,
  );
  const groups = homeSessionGroups(visible, {
    recent: 0,
    pinnedFirst: false,
    unconfirmed: scope.unconfirmed,
  });
  const waiting = groups.needsYou.length;
  const running = groups.running.length;
  const priority = selectPriority(groups.needsYou);
  const work = new Map<string, "running" | "waiting">();
  for (const { session } of groups.needsYou) work.set(session.id, "waiting");
  for (const { session } of groups.running) work.set(session.id, "running");
  const version = createHash("sha256")
    .update(
      JSON.stringify([scope.versionScope, [...workspaceIds].sort(), waiting, running, priority]),
    )
    .digest("base64url");
  return {
    work,
    snapshot: { version, observedAt: now, waiting, running, ...(priority ? { priority } : {}) },
  };
}
