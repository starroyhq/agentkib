import type { ConversationSessionSummary } from "@/core/types";
import { isSessionVisible, sortSessions } from "@/features/sessions/session-catalog";

/** What a session on the home waits for from the person. */
export type HomeNeed = "approval" | "question" | "verify";
/** The unread result of a session; "unread" is a session marked unread without a result. */
export type HomeResult = "completed" | "failed" | "cancelled" | "ended" | "unread";
/** Where a turn runs now: in AgentKib, in a connected terminal, or in another client. */
export type HomePlace = "agentkib" | "terminal" | "external";

export interface HomeSessionGroups {
  needsYou: { session: ConversationSessionSummary; need: HomeNeed }[];
  review: { session: ConversationSessionSummary; result: HomeResult }[];
  running: { session: ConversationSessionSummary; place: HomePlace; startedAt?: string }[];
  recent: ConversationSessionSummary[];
}

const WAITING: Record<string, HomeNeed> = {
  "awaiting-approval": "approval",
  "waiting-input": "question",
};

/**
 * Sorts this computer's sessions into the home's groups, newest first, as the phone's first tab
 * does: what waits for the person, then unread results, then running turns. Each session appears
 * once; a running session that waits for the person is under "needs you" only. Only what the
 * catalog reports counts, so a session another client merely has open shows nothing.
 */
export function homeSessionGroups(
  sessions: readonly ConversationSessionSummary[],
  recentLimit = 8,
): HomeSessionGroups {
  const groups: HomeSessionGroups = { needsYou: [], review: [], running: [], recent: [] };
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
    if (need) groups.needsYou.push({ session, need });
    else if (state?.status === "outcome-unknown" || state?.reason === "control-outcome-unconfirmed")
      groups.needsYou.push({ session, need: "verify" });
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
    else if (session.readState?.status === "unread")
      groups.review.push({
        session,
        result:
          session.readState.firstUnread?.type === "threadStart"
            ? "unread"
            : (session.readState.latestResult?.outcome ?? "unread"),
      });
    else if (groups.recent.length < recentLimit) groups.recent.push(session);
  }
  return groups;
}

/** How long a turn has run, in whole minutes or hours, for the start of its row's detail line. */
export function formatRunningTime(startedAt: string, locale: string, now = Date.now()) {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return undefined;
  const minutes = Math.max(1, Math.round((now - started) / 60_000));
  const [value, unit] = minutes < 60 ? [minutes, "minute"] : [Math.round(minutes / 60), "hour"];
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(value);
}
