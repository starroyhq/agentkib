import type { SessionAction, ManagedAgent } from "@agentkib/web-client";
/** Only command identity is persisted; never prompts, answers, tokens or approval details. */
export type PendingControl = {
  requestId: string;
  agent?: ManagedAgent;
  sessionId?: string;
  workspaceId?: string;
  kind:
    | "send"
    | "stop"
    | "approve"
    | "answer"
    | "create"
    | "adopt"
    | "release"
    | "reconcile"
    | SessionAction;
};
// Keep persisted identities exhaustive when native actions are added.
const pendingKinds = {
  send: true,
  stop: true,
  approve: true,
  answer: true,
  create: true,
  adopt: true,
  release: true,
  reconcile: true,
  resume: true,
  inspect: true,
  steer: true,
  "queue-add": true,
  "queue-update": true,
  "queue-delete": true,
  "queue-reorder": true,
  "queue-start": true,
  "queue-pause": true,
  "queue-resume": true,
  rename: true,
  archive: true,
  unarchive: true,
  delete: true,
  fork: true,
  settings: true,
  "goal-set": true,
  "goal-pause": true,
  "goal-resume": true,
  "goal-clear": true,
  compact: true,
  "terminals-clean": true,
} satisfies Record<PendingControl["kind"], true>;
const prefix = "agentkib:codex-pending:v1:";
const listeners = new Set<() => void>();
export function subscribePending(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function changed() {
  for (const listener of listeners) listener();
}
export function pendingScope(origin: string, deviceId: string): string {
  return `${prefix}${JSON.stringify([origin || window.location.origin, deviceId])}`;
}
export function readPending(scope: string): PendingControl[] {
  const raw = sessionStorage.getItem(scope);
  if (raw === null) return [];
  const entries: unknown = JSON.parse(raw);
  if (
    !Array.isArray(entries) ||
    entries.length > 100 ||
    entries.some(
      (value) =>
        !value ||
        typeof value !== "object" ||
        !/^[a-f0-9-]{36}$/i.test(value.requestId) ||
        (value.sessionId !== undefined &&
          (typeof value.sessionId !== "string" ||
            !value.sessionId ||
            value.sessionId.length > 256)) ||
        (value.workspaceId !== undefined &&
          (typeof value.workspaceId !== "string" ||
            !value.workspaceId ||
            value.workspaceId.length > 256)) ||
        (value.agent !== undefined && value.agent !== "codex" && value.agent !== "claude-code") ||
        (!value.sessionId && !value.workspaceId) ||
        typeof value.kind !== "string" ||
        !Object.hasOwn(pendingKinds, value.kind),
    )
  )
    throw new Error("pending_control_storage_invalid");
  return entries.map(({ requestId, sessionId, workspaceId, kind, agent }) => ({
    requestId,
    sessionId,
    workspaceId,
    kind,
    ...(agent ? { agent } : {}),
  }));
}
export function rememberPending(scope: string, pending: PendingControl): void {
  const entries = readPending(scope);
  if (
    entries.some((entry) =>
      pending.sessionId
        ? entry.sessionId === pending.sessionId &&
          (pending.kind !== "reconcile" || entry.kind === "reconcile")
        : entry.kind === "create",
    )
  )
    throw new Error("control_outcome_unconfirmed");
  if (entries.length >= 100) throw new Error("pending_control_capacity");
  const { requestId, sessionId, workspaceId, kind, agent } = pending;
  sessionStorage.setItem(
    scope,
    JSON.stringify([
      ...entries,
      { requestId, sessionId, workspaceId, kind, ...(agent ? { agent } : {}) },
    ]),
  );
  changed();
}
export function forgetPending(scope: string, requestId: string): void {
  const entries = readPending(scope).filter((entry) => entry.requestId !== requestId);
  if (entries.length) sessionStorage.setItem(scope, JSON.stringify(entries));
  else sessionStorage.removeItem(scope);
  changed();
}
