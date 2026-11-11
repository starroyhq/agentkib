import { isSessionVisible, sortSessions, type CatalogSession } from "./index";

/** What a session on the home waits for from the person. */
export type HomeNeed = "approval" | "question" | "verify";
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
  };
  externalTurn?: { status: string; startedAt?: string | null } | null;
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
 * Sorts this computer's sessions into the home's groups, newest first, as the phone's first tab
 * does: what waits for the person, then unread results, then running turns. Each session appears
 * once; a running session that waits for the person is under "needs you" only. Only what the
 * catalog reports counts, so a session another client merely has open shows nothing.
 *
 * `unconfirmed` names sessions whose last decision may or may not have reached the Agent; they
 * wait for the person to verify the result and are never offered for answering again.
 */
export function homeSessionGroups<S extends HomeSession>(
  sessions: readonly S[],
  { recent = 8, unconfirmed }: { recent?: number; unconfirmed?: ReadonlySet<string> } = {},
): HomeSessionGroups<S> {
  const groups: HomeSessionGroups<S> = { needsYou: [], review: [], running: [], recent: [] };
  for (const session of sortSessions(sessions)) {
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
