import { createHash } from "node:crypto";
import type {
  NotificationActivityCategory,
  NotificationActivitySnapshot,
} from "@agentkib/runtime-protocol";
import {
  displaySessionTitle,
  homeSessionGroups,
  type HomeSession,
  type HomeSessionGroups,
} from "@agentkib/session-catalog";

export type NotificationActivitySession = HomeSession & { sidechain?: boolean };

const priorityOrder: readonly NotificationActivityCategory[] = [
  "approval",
  "question",
  "verify",
  "delegation",
];
const TITLE_LIMIT = 100;

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
    const title = Array.from(displaySessionTitle(session.title, "").replace(/\s+/g, " "));
    const selectedTime = sessionTime(session);
    return {
      sessionId: session.id,
      agent: session.agent,
      category,
      count: candidates.length,
      ...(title.length
        ? {
            title:
              title.length > TITLE_LIMIT
                ? title.slice(0, TITLE_LIMIT - 1).join("") + "…"
                : title.join(""),
          }
        : {}),
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
): NotificationActivitySnapshot {
  const workspaceIds = new Set(scope.workspaceIds);
  const visible = sessions.filter(
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
  const version = createHash("sha256")
    .update(
      JSON.stringify([scope.versionScope, [...workspaceIds].sort(), waiting, running, priority]),
    )
    .digest("base64url");
  return { version, observedAt: now, waiting, running, ...(priority ? { priority } : {}) };
}
