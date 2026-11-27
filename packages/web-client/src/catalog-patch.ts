import type { ConversationSessionSummary } from "./index";

type Continuation = NonNullable<ConversationSessionSummary["continuation"]>;
type ExternalTurn = NonNullable<ConversationSessionSummary["externalTurn"]>;
type CatalogPatchRow = Omit<ConversationSessionSummary, "readState" | "pendingInteraction">;

interface CatalogUpdate {
  sessionId: string;
  workspaceId: string;
  continuation?: Continuation | null;
  updatedAt?: string | null;
  externalTurn?: ExternalTurn | null;
  auxiliary?: boolean;
  title?: string | null;
  archived?: boolean;
  row?: CatalogPatchRow;
  removed?: true;
}

export interface ConversationCatalogPatch {
  updates: CatalogUpdate[];
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function continuationOf(value: unknown): Continuation | null | undefined {
  if (value === null) return null;
  if (!record(value) || typeof value.status !== "string") return;
  const { status, executionLocation, ownershipReason, reason, backgroundTasks } = value;
  return {
    status,
    ...(executionLocation === "agentkib" ||
    executionLocation === "terminal" ||
    executionLocation === "external" ||
    executionLocation === null
      ? { executionLocation }
      : {}),
    ...(typeof ownershipReason === "string" || ownershipReason === null ? { ownershipReason } : {}),
    ...(typeof reason === "string" || reason === null ? { reason } : {}),
    ...(typeof backgroundTasks === "number" &&
    Number.isSafeInteger(backgroundTasks) &&
    backgroundTasks >= 0
      ? { backgroundTasks }
      : {}),
  };
}

function externalTurnOf(value: unknown): ExternalTurn | null | undefined {
  if (value === null) return null;
  if (
    !record(value) ||
    value.status !== "running" ||
    !(typeof value.startedAt === "string" || value.startedAt === null)
  )
    return;
  const { status, startedAt, turnId } = value;
  return {
    status,
    startedAt,
    ...(typeof turnId === "string" || turnId === null ? { turnId } : {}),
  };
}

function nullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function patchRowOf(
  value: unknown,
  sessionId: string,
  workspaceId: string,
  auxiliary: unknown,
): CatalogPatchRow | undefined {
  if (
    !record(value) ||
    value.id !== sessionId ||
    value.workspace_id !== workspaceId ||
    typeof value.agent !== "string" ||
    !value.agent ||
    typeof value.archived !== "boolean" ||
    typeof value.sidechain !== "boolean" ||
    (value.availability !== "readable" && value.availability !== "metadata-only") ||
    (value.origin === "auxiliary") !== auxiliary
  )
    return;
  const {
    agent,
    archived,
    availability,
    sidechain,
    title,
    created_at,
    updated_at,
    origin,
    spawned_by_session_id,
    forked_from_session_id,
    git_branch,
    message_count,
    indexedSessionId,
    indexedSessionIds,
    pinned,
    pinningAvailable,
    projectAgent,
    orchestration,
    worktree,
  } = value;
  const continuation = continuationOf(value.continuation);
  const externalTurn = externalTurnOf(value.externalTurn);
  const delegation = record(orchestration) ? orchestrationField(orchestration) : undefined;
  return {
    id: sessionId,
    workspace_id: workspaceId,
    agent: agent as CatalogPatchRow["agent"],
    archived,
    availability,
    sidechain,
    ...(typeof title === "string" ? { title } : {}),
    ...(nullableString(created_at) ? { created_at } : {}),
    ...(typeof updated_at === "string" ? { updated_at } : {}),
    ...(origin === "interactive" ||
    origin === "auxiliary" ||
    origin === "execution" ||
    origin === "unknown"
      ? { origin }
      : {}),
    ...(nullableString(spawned_by_session_id) ? { spawned_by_session_id } : {}),
    ...(nullableString(forked_from_session_id) ? { forked_from_session_id } : {}),
    ...(nullableString(git_branch) ? { git_branch } : {}),
    ...(typeof message_count === "number" || message_count === null ? { message_count } : {}),
    ...(typeof indexedSessionId === "string" ? { indexedSessionId } : {}),
    ...(Array.isArray(indexedSessionIds) &&
    indexedSessionIds.every((id): id is string => typeof id === "string")
      ? { indexedSessionIds }
      : {}),
    ...(typeof pinned === "boolean" ? { pinned } : {}),
    ...(typeof pinningAvailable === "boolean" ? { pinningAvailable } : {}),
    ...(record(projectAgent) &&
    typeof projectAgent.lead === "boolean" &&
    typeof projectAgent.worker === "boolean"
      ? {
          projectAgent: {
            lead: projectAgent.lead,
            worker: projectAgent.worker,
            ...(projectAgent.workerServiceTiers === true ? { workerServiceTiers: true } : {}),
          },
        }
      : {}),
    ...(delegation ? { orchestration: delegation } : {}),
    ...(record(worktree) &&
    nullableString(worktree.repository_group_id) &&
    typeof worktree.name === "string" &&
    typeof worktree.path === "string" &&
    nullableString(worktree.branch) &&
    (worktree.status === "present" ||
      worktree.status === "deleted" ||
      worktree.status === "unknown")
      ? {
          worktree: {
            repository_group_id: worktree.repository_group_id,
            name: worktree.name,
            path: worktree.path,
            branch: worktree.branch,
            status: worktree.status,
          },
        }
      : {}),
    ...(continuation ? { continuation } : {}),
    ...(externalTurn !== undefined ? { externalTurn } : {}),
  };
}

function orchestrationField(value: Record<string, unknown>): CatalogPatchRow["orchestration"] {
  const { role, workers, paused, recovering, reason, reports, leadId, name } = value;
  if (role === "lead" && typeof workers === "number" && typeof paused === "boolean")
    return {
      role,
      workers,
      paused,
      ...(recovering === true ? { recovering } : {}),
      ...(nullableString(reason) ? { reason } : {}),
      ...(typeof reports === "number" ? { reports } : {}),
    };
  if (role === "worker" && typeof leadId === "string" && typeof name === "string")
    return { role, leadId, name };
}

export function conversationCatalogPatch(payload: unknown): ConversationCatalogPatch | undefined {
  if (!record(payload) || !record(payload.catalogPatch)) return;
  const { updates } = payload.catalogPatch;
  if (!Array.isArray(updates) || updates.length > 256) return;
  const verified: CatalogUpdate[] = [];
  for (const update of updates) {
    if (
      !record(update) ||
      typeof update.sessionId !== "string" ||
      typeof update.workspaceId !== "string"
    )
      return;
    const { sessionId, workspaceId, auxiliary, removed } = update;
    const continuation = continuationOf(update.continuation);
    const externalTurn = externalTurnOf(update.externalTurn);
    const updatedAt = nullableString(update.updatedAt) ? update.updatedAt : undefined;
    const title = nullableString(update.title) ? update.title : undefined;
    const archived = typeof update.archived === "boolean" ? update.archived : undefined;
    const row = patchRowOf(update.row, sessionId, workspaceId, auxiliary);
    const fields = { continuation, externalTurn, updatedAt, title, archived };
    if (
      Object.entries(fields).some(([key, value]) => key in update && value === undefined) ||
      ("row" in update && row === undefined) ||
      ("removed" in update && removed !== true) ||
      (removed === true &&
        (typeof auxiliary !== "boolean" ||
          row ||
          Object.values(fields).some((v) => v !== undefined))) ||
      (!row && !removed && Object.values(fields).every((value) => value === undefined))
    )
      return;
    verified.push({
      sessionId,
      workspaceId,
      ...(typeof auxiliary === "boolean" ? { auxiliary } : {}),
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      ...(row ? { row } : {}),
      ...(removed === true ? { removed } : {}),
    });
  }
  return { updates: verified };
}

type CatalogRow = {
  id: string;
  workspace_id: string;
  updated_at?: string | null;
  title?: string | null;
  archived?: boolean;
  continuation?: Omit<Continuation, "executionLocation"> & { executionLocation?: string | null };
  externalTurn?: { status: string; startedAt?: string | null; turnId?: string | null } | null;
};

function key(workspaceId: string, sessionId: string): string {
  return JSON.stringify([workspaceId, sessionId]);
}

export function rememberConversationCatalogPatch(
  updates: Map<string, CatalogUpdate>,
  patch: ConversationCatalogPatch,
) {
  for (const update of patch.updates) {
    const id = key(update.workspaceId, update.sessionId);
    const previous = updates.get(id);
    if (update.row || update.removed) {
      if (previous || updates.size < 20_000) updates.set(id, update);
    } else if (!previous?.removed && (previous || updates.size < 20_000)) {
      updates.set(id, { ...previous, ...update });
    }
  }
}

function sameContinuation(before: CatalogRow["continuation"], after: CatalogRow["continuation"]) {
  return (
    before?.status === after?.status &&
    before?.executionLocation === after?.executionLocation &&
    before?.ownershipReason === after?.ownershipReason &&
    before?.reason === after?.reason &&
    before?.backgroundTasks === after?.backgroundTasks
  );
}

function sameExternalTurn(before: CatalogRow["externalTurn"], after: CatalogRow["externalTurn"]) {
  return (
    before?.status === after?.status &&
    before?.startedAt === after?.startedAt &&
    before?.turnId === after?.turnId
  );
}

export function needsCatalogPatchV2(patch: ConversationCatalogPatch): boolean {
  return patch.updates.some(
    ({ title, archived, row, removed }) =>
      title !== undefined || archived !== undefined || row !== undefined || removed === true,
  );
}

function applyFields<T extends CatalogRow>(session: T, update: CatalogUpdate): T {
  const continuation =
    update.continuation !== undefined ? (update.continuation ?? undefined) : session.continuation;
  const externalTurn =
    update.externalTurn !== undefined ? update.externalTurn : session.externalTurn;
  const updated_at =
    update.updatedAt !== undefined ? (update.updatedAt ?? undefined) : session.updated_at;
  const title = update.title !== undefined ? (update.title ?? undefined) : session.title;
  const archived = update.archived ?? session.archived;
  if (
    sameContinuation(session.continuation, continuation) &&
    sameExternalTurn(session.externalTurn, externalTurn) &&
    session.updated_at === updated_at &&
    session.title === title &&
    session.archived === archived
  )
    return session;
  return {
    ...session,
    continuation,
    externalTurn,
    updated_at,
    title,
    archived,
  };
}

/** Only an authoritative row may add a session, after the caller verifies its workspace scope. */
export function applyConversationCatalogPatch<T extends CatalogRow>(
  sessions: T[],
  patch: ConversationCatalogPatch,
  projectRow?: (row: CatalogPatchRow, previous?: T) => T | undefined,
): T[] {
  if (!patch.updates.length) return sessions;
  const updates = new Map<string, CatalogUpdate>();
  rememberConversationCatalogPatch(updates, patch);
  let changed = false;
  const next: T[] = [];
  for (const session of sessions) {
    const id = key(session.workspace_id, session.id);
    const update = updates.get(id);
    if (!update) {
      next.push(session);
      continue;
    }
    updates.delete(id);
    if (update.removed) {
      changed = true;
      continue;
    }
    const replacement = update.row ? projectRow?.(update.row, session) : undefined;
    const patched = applyFields(replacement ?? session, update);
    changed ||= patched !== session;
    next.push(patched);
  }
  if (projectRow) {
    for (const update of updates.values()) {
      if (!update.row) continue;
      const row = projectRow(update.row);
      if (row) {
        changed = true;
        next.push(applyFields(row, update));
      }
    }
  }
  return changed ? next : sessions;
}
