import { isSessionVisible, pinnedSessionsFirst, sortSessions, type CatalogSession } from "./index";

/** What a session on the home waits for from the person. */
/** "delegation": a Project Agent whose delegation paused until the person looks at it. */
export type HomeNeed = "approval" | "question" | "verify" | "delegation";
/** The unread result of a session; "unread" is a session marked unread without a result. */
export type HomeResult = "completed" | "failed" | "cancelled" | "ended" | "unread";
/** Where a turn runs now: in AgentKib, in a connected terminal, or in another client. */
export type HomePlace = "agentkib" | "terminal" | "external";

/** The catalog fields the home reads; desktop and Web summaries both carry them. */
export interface HomeSession extends CatalogSession {
  remote?: unknown;
  archived?: boolean;
  continuation?: {
    status: string;
    executionLocation?: string | null;
    reason?: string | null;
    /** Background tasks running in AgentKib's process after their turn. */
    backgroundTasks?: number;
  };
  externalTurn?: { status: string; startedAt?: string | null } | null;
  /** A Project Agent or its Worker (docs/agents/project-agent.md). */
  orchestration?: {
    role: string;
    paused?: boolean;
    reason?: string | null;
    reports?: number;
    leadId?: string;
  };
  readState?: {
    status: string;
    firstUnread?: { type: string } | null;
    latestResult?: { outcome?: string | null } | null;
  };
}

export interface HomeSessionGroups<S extends HomeSession = HomeSession> {
  needsYou: { session: S; need: HomeNeed }[];
  review: { session: S; result: HomeResult }[];
  running: { session: S; place: HomePlace; startedAt?: string }[];
  recent: S[];
}

const WAITING: Record<string, HomeNeed> = {
  "awaiting-approval": "approval",
  "waiting-input": "question",
};
const RESULTS = new Set<string>(["completed", "failed", "cancelled", "ended"]);
/**
 * Why a Project Agent's delegation pauses until the person looks: its automatic turns ran out, a
 * report's delivery is unknown, or AgentKib restarted. A pause they chose is not a need.
 */
const DELEGATION_NEEDS = new Set([
  "auto-turn-limit",
  "report-undelivered",
  "restart-confirmation-required",
]);

/**
 * Sorts this computer's sessions into the home's groups, pinned first then newest first, as the phone's first tab
 * does: what waits for the person, then unread results, then running turns. Each session appears
 * once; a running session that waits for the person is under "needs you" only. Only what the
 * catalog reports counts, so a session another client merely has open shows nothing.
 *
 * `unconfirmed` names sessions whose last decision may or may not have reached the Agent; they
 * wait for the person to verify the result and are never offered for answering again.
 */
export function homeSessionGroups<S extends HomeSession>(
  sessions: readonly S[],
  {
    recent = 8,
    unconfirmed,
    pinnedFirst = true,
  }: { recent?: number; unconfirmed?: ReadonlySet<string>; pinnedFirst?: boolean } = {},
): HomeSessionGroups<S> {
  const groups: HomeSessionGroups<S> = { needsYou: [], review: [], running: [], recent: [] };
  const sorted = sortSessions(sessions);
  for (const session of pinnedFirst ? pinnedSessionsFirst(sorted) : sorted) {
    if (
      session.remote ||
      session.archived ||
      session.availability !== "readable" ||
      !isSessionVisible(session)
    )
      continue;
    const state = session.continuation;
    const need = state ? WAITING[state.status] : undefined;
    if (
      unconfirmed?.has(session.id) ||
      state?.status === "outcome-unknown" ||
      state?.reason === "control-outcome-unconfirmed"
    )
      groups.needsYou.push({ session, need: "verify" });
    else if (need) groups.needsYou.push({ session, need });
    else if (state?.status === "running" || state?.status === "starting")
      groups.running.push({
        session,
        place:
          state.executionLocation === "terminal" || state.executionLocation === "external"
            ? state.executionLocation
            : "agentkib",
      });
    else if (session.externalTurn?.status === "running")
      groups.running.push({
        session,
        place: "external",
        startedAt: session.externalTurn.startedAt ?? undefined,
      });
    else if (
      session.orchestration?.role === "lead" &&
      session.orchestration.paused &&
      DELEGATION_NEEDS.has(session.orchestration.reason ?? "")
    )
      groups.needsYou.push({ session, need: "delegation" });
    else if (session.readState?.status === "unread") {
      const outcome = session.readState.latestResult?.outcome;
      groups.review.push({
        session,
        result:
          session.readState.firstUnread?.type !== "threadStart" && outcome && RESULTS.has(outcome)
            ? (outcome as HomeResult)
            : "unread",
      });
    } else if (groups.recent.length < recent) groups.recent.push(session);
  }
  return groups;
}

/**
 * Sessions whose work stops when AgentKib quits: a turn running, or waiting for the person, in
 * a process AgentKib started (managed Codex, Claude Code and Antigravity, Devin's `devin -p`, and
 * a DeepSeek Harness it started in the background), and Claude Code background tasks still
 * running in one. Turns in a connected terminal or another client go on.
 */
export function workStoppedByQuit<S extends HomeSession>(sessions: readonly S[]): S[] {
  const groups = homeSessionGroups(sessions, { recent: 0, pinnedFirst: false });
  const here = (session: S) => {
    const place = session.continuation?.executionLocation;
    return place !== "terminal" && place !== "external";
  };
  const work = [
    ...groups.needsYou
      .filter(
        (entry) => (entry.need === "approval" || entry.need === "question") && here(entry.session),
      )
      .map((entry) => entry.session),
    ...groups.running.filter((entry) => entry.place === "agentkib").map((entry) => entry.session),
  ];
  // Background tasks end with the process that runs them, even while no turn runs.
  const listed = new Set(work);
  for (const session of sessions)
    if (
      !listed.has(session) &&
      !session.archived &&
      session.continuation?.executionLocation === "agentkib" &&
      (session.continuation.backgroundTasks ?? 0) > 0
    )
      work.push(session);
  return work;
}
