import { managedAgentOf, type ManagedAgent, type SessionAction } from "@agentkib/web-client";
/** Only command identity and timestamps are persisted; never prompts, answers or approval details. */
export type PendingControl = {
  requestId: string;
  agent?: ManagedAgent;
  sessionId?: string;
  workspaceId?: string;
  createdAt?: number;
  expectedRevision?: number;
  runtimeBootId?: string;
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
  "adopt-terminal": true,
  "handover-terminal": true,
  release: true,
  reconcile: true,
  resume: true,
  inspect: true,
  steer: true,
  "queue-add": true,
  "queue-update": true,
  "queue-delete": true,
  "queue-steer": true,
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
  "open-model-picker": true,
  "goal-set": true,
  "goal-pause": true,
  "goal-resume": true,
  "goal-clear": true,
  compact: true,
  "terminals-clean": true,
  "usage-limit-cancel": true,
  "usage-limit-continue": true,
} satisfies Record<PendingControl["kind"], true>;
const sessionPendingStoragePrefix = "agentkib:codex-pending:v1:";
const pendingLimit = 100;
const abandonedLimit = 100;
export const ABANDONED_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
type StoredPendingControl = PendingControl & { createdAt: number; abandonedAt?: number };
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
  return `${sessionPendingStoragePrefix}${JSON.stringify([origin || window.location.origin, deviceId])}`;
}
function writeStored(scope: string, entries: StoredPendingControl[]): void {
  if (entries.length) sessionStorage.setItem(scope, JSON.stringify(entries));
  else sessionStorage.removeItem(scope);
}

function invalidTimestamp(value: unknown): boolean {
  return (
    value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
  );
}

function readStored(scope: string): StoredPendingControl[] {
  const raw = sessionStorage.getItem(scope);
  if (raw === null) return [];
  const entries: unknown = JSON.parse(raw);
  if (
    !Array.isArray(entries) ||
    entries.length > pendingLimit + abandonedLimit ||
    entries.some(
      (value) =>
        !value ||
        typeof value !== "object" ||
        typeof value.requestId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(value.requestId) ||
        (value.sessionId !== undefined &&
          (typeof value.sessionId !== "string" ||
            !value.sessionId ||
            value.sessionId.length > 256)) ||
        (value.workspaceId !== undefined &&
          (typeof value.workspaceId !== "string" ||
            !value.workspaceId ||
            value.workspaceId.length > 256)) ||
        (value.agent !== undefined &&
          // Every managed Agent a control can name; one missing here would make every later
          // read of the store throw and block all controls in this browser.
          !managedAgentOf(value.agent)) ||
        invalidTimestamp(value.createdAt) ||
        invalidTimestamp(value.abandonedAt) ||
        invalidTimestamp(value.expectedRevision) ||
        (value.runtimeBootId !== undefined &&
          (typeof value.runtimeBootId !== "string" || value.runtimeBootId.length > 256)) ||
        typeof value.kind !== "string" ||
        !Object.hasOwn(pendingKinds, value.kind),
    )
  )
    throw new Error("pending_control_storage_invalid");
  const now = Date.now();
  const retained: StoredPendingControl[] = [];
  let migrated = false;
  for (const {
    requestId,
    sessionId,
    workspaceId,
    kind,
    agent,
    createdAt,
    abandonedAt,
    expectedRevision,
    runtimeBootId,
  } of entries) {
    // A workspace-scoped creation only gets a session ID in its receipt. Other
    // identities without a session cannot fence or recover a specific operation.
    if (!sessionId && !(kind === "create" && workspaceId)) continue;
    if (abandonedAt !== undefined && now - abandonedAt >= ABANDONED_PENDING_TTL_MS) continue;
    migrated ||= createdAt === undefined;
    retained.push({
      requestId,
      sessionId,
      workspaceId,
      kind,
      ...(agent ? { agent } : {}),
      createdAt: createdAt ?? now,
      expectedRevision,
      runtimeBootId,
      ...(abandonedAt !== undefined ? { abandonedAt } : {}),
    });
  }
  if (migrated || retained.length !== entries.length) writeStored(scope, retained);
  return retained;
}

export function readPending(scope: string): PendingControl[] {
  return readStored(scope).filter((entry) => entry.abandonedAt === undefined);
}
export function pendingCreateMatches(
  pending: PendingControl,
  agent: ManagedAgent,
  workspaceId: string,
): boolean {
  // The original Codex-only creator saved a workspace but no Agent.
  return (
    pending.kind === "create" &&
    pending.workspaceId === workspaceId &&
    (pending.agent ?? "codex") === agent
  );
}

export function rememberPending(scope: string, pending: PendingControl): void {
  const entries = readStored(scope);
  const active = entries.filter((entry) => entry.abandonedAt === undefined);
  const { requestId, sessionId, workspaceId, kind, agent, expectedRevision, runtimeBootId } =
    pending;
  if (!sessionId && !(kind === "create" && workspaceId))
    throw new Error("pending_control_storage_invalid");
  if (
    entries.some((entry) => entry.requestId === requestId) ||
    active.some((entry) =>
      sessionId
        ? entry.sessionId === sessionId && entry.kind === kind
        : pendingCreateMatches(entry, agent ?? "codex", workspaceId!),
    )
  )
    throw new Error("control_outcome_unconfirmed");
  if (active.length >= pendingLimit) throw new Error("pending_control_capacity");
  writeStored(scope, [
    ...entries,
    {
      requestId,
      sessionId,
      workspaceId,
      kind,
      ...(agent ? { agent } : {}),
      createdAt: Date.now(),
      expectedRevision,
      runtimeBootId,
    },
  ]);
  changed();
}

export function forgetPending(scope: string, requestId: string): void {
  const entries = readStored(scope);
  const remaining = entries.filter(
    (entry) => entry.requestId !== requestId || entry.abandonedAt !== undefined,
  );
  if (remaining.length === entries.length) return;
  writeStored(scope, remaining);
  changed();
}

export function abandonPending(scope: string, requestId: string): boolean {
  const entries = readStored(scope);
  const index = entries.findIndex(
    (entry) => entry.requestId === requestId && entry.abandonedAt === undefined,
  );
  const entry = entries[index];
  if (!entry) return false;
  entries.splice(index, 1);
  if (entries.filter((entry) => entry.abandonedAt !== undefined).length >= abandonedLimit) {
    const oldest = entries.findIndex((entry) => entry.abandonedAt !== undefined);
    entries.splice(oldest, 1);
  }
  entries.push({ ...entry, abandonedAt: Date.now() });
  writeStored(scope, entries);
  changed();
  return true;
}
