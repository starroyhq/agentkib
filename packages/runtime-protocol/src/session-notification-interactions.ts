/** Local Runtime notification. Only native request identities cross this boundary. */
export const SESSION_NOTIFICATION_INTERACTIONS_CHANGED =
  "session-notifications.interactions-changed";
export const SESSION_NOTIFICATION_INTERACTION_LIMIT = 64;
export const SESSION_NOTIFICATION_INTERACTION_KEY_LIMIT = 2048;
export type SessionNotificationInteractions = {
  sessionId: string;
  approval?: readonly string[];
  question?: readonly string[];
};
export function parseSessionNotificationInteractions(
  value: unknown,
): SessionNotificationInteractions | undefined {
  if (!value || typeof value !== "object" || !("sessionId" in value)) return;
  const { sessionId } = value;
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) return;
  const approval = "approval" in value ? interactionKeys(value.approval) : undefined;
  const question = "question" in value ? interactionKeys(value.question) : undefined;
  if (approval === undefined && question === undefined) return;
  return {
    sessionId,
    ...(approval !== undefined && { approval }),
    ...(question !== undefined && { question }),
  };
}

function interactionKeys(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > SESSION_NOTIFICATION_INTERACTION_LIMIT) return;
  return value.every(
    (key) =>
      typeof key === "string" &&
      key.length > 0 &&
      key.length <= SESSION_NOTIFICATION_INTERACTION_KEY_LIMIT,
  )
    ? value
    : undefined;
}

/** A missing or unconfirmed list says nothing about whether its latest request is resolved. */
export function sessionNotificationInteractions(
  sessionId: string,
  live: unknown,
): SessionNotificationInteractions | undefined {
  if (!live || typeof live !== "object" || Array.isArray(live)) return;
  const state = live as Record<string, unknown>;
  if (sessionId !== state.sessionId || !workspaceStateConfirmed(state)) return;
  const approval = projectKeys(
    state.approvals,
    state.status === "awaiting-approval" || state.status === "waiting-approval",
    state.turnId,
  );
  const question = projectKeys(state.questions, state.status === "waiting-input", state.turnId);
  if (approval === undefined && question === undefined) return;
  return {
    sessionId,
    ...(approval !== undefined && { approval }),
    ...(question !== undefined && { question }),
  };
}

const knownStatuses = new Set([
  "idle",
  "running",
  "awaiting-approval",
  "waiting-approval",
  "waiting-input",
]);
const knownReasons = new Set([
  "session-compacting",
  "claude-terminal-approval",
  "claude-terminal-question",
  "dsh-approval-pending",
  "dsh-question-pending",
]);

function workspaceStateConfirmed(state: Record<string, unknown>): boolean {
  return (
    typeof state.workspaceId === "string" &&
    !!state.workspaceId &&
    typeof state.runtimeBootId === "string" &&
    !!state.runtimeBootId &&
    typeof state.status === "string" &&
    knownStatuses.has(state.status) &&
    state.ownershipReason == null &&
    (state.reason == null || (typeof state.reason === "string" && knownReasons.has(state.reason)))
  );
}

function projectKeys(
  rows: unknown,
  waiting: boolean,
  currentTurnId: unknown,
): string[] | undefined {
  if (!Array.isArray(rows) || rows.length > SESSION_NOTIFICATION_INTERACTION_LIMIT) return;
  if (waiting && rows.length === 0) return;
  const keys = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object") return;
    const { requestId, turnId = currentTurnId } = row as Record<string, unknown>;
    if (
      !(
        (typeof requestId === "string" && requestId.length > 0 && requestId.length <= 256) ||
        (typeof requestId === "number" && Number.isSafeInteger(requestId))
      ) ||
      (turnId != null && (typeof turnId !== "string" || !turnId || turnId.length > 256))
    )
      return;
    const key = JSON.stringify([turnId ?? null, requestId]);
    if (key.length > SESSION_NOTIFICATION_INTERACTION_KEY_LIMIT) return;
    keys.add(key);
  }
  return [...keys].sort();
}
