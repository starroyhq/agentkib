import type { HomeNeed, HomeSession, HomeSessionGroups } from "@agentkib/session-catalog";

export type NotificationState =
  | `needs:${HomeNeed}`
  | "running"
  | "result:completed"
  | "result:failed";

export function notificationSessionIds(session: HomeSession): string[] {
  return [
    ...new Set([
      session.id,
      ...(session.indexedSessionId ? [session.indexedSessionId] : []),
      ...(session.indexedSessionIds ?? []).slice(0, 15),
    ]),
  ].slice(0, 16);
}
export function notificationStates(groups: HomeSessionGroups): Map<string, NotificationState> {
  const next = new Map<string, NotificationState>();
  for (const entry of groups.needsYou) next.set(entry.session.id, `needs:${entry.need}`);
  for (const entry of groups.running) next.set(entry.session.id, "running");
  for (const entry of groups.review)
    if (entry.result === "completed" || entry.result === "failed")
      next.set(entry.session.id, `result:${entry.result}`);
  return next;
}

/**
 * A Project Agent still has work in progress: a Worker running or waiting for the person, a
 * report on its way into its next turn, or a background task of its own.
 */
export function leadNotificationBusy(
  lead: HomeSession | undefined,
  sessions: readonly HomeSession[],
  states: ReadonlyMap<string, NotificationState>,
): boolean {
  const role = lead?.orchestration;
  if (!lead || role?.role !== "lead") return false;
  if (
    role.reportsUnavailable ||
    (role.reports ?? 0) > 0 ||
    (lead.continuation?.backgroundTasks ?? 0) > 0
  )
    return true;
  const leadIds = new Set(notificationSessionIds(lead));
  return sessions.some((session) => {
    if (
      session.orchestration?.role !== "worker" ||
      !leadIds.has(session.orchestration.leadId ?? "")
    )
      return false;
    const state = states.get(session.id);
    return state === "running" || !!state?.startsWith("needs:");
  });
}
