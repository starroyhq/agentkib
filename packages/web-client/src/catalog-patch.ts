import type { ConversationSessionSummary } from "./index";

type Continuation = NonNullable<ConversationSessionSummary["continuation"]>;
type ExternalTurn = NonNullable<ConversationSessionSummary["externalTurn"]>;

interface CatalogUpdate {
  sessionId: string;
  workspaceId: string;
  continuation?: Continuation | null;
  updatedAt?: string | null;
  externalTurn?: ExternalTurn | null;
  auxiliary?: boolean;
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
    const continuation = continuationOf(update.continuation);
    const externalTurn = externalTurnOf(update.externalTurn);
    const updatedAt =
      typeof update.updatedAt === "string" || update.updatedAt === null
        ? update.updatedAt
        : undefined;
    if (
      ("continuation" in update && continuation === undefined) ||
      ("externalTurn" in update && externalTurn === undefined) ||
      ("updatedAt" in update && updatedAt === undefined) ||
      (continuation === undefined && externalTurn === undefined && updatedAt === undefined)
    )
      return;
    verified.push({
      sessionId: update.sessionId,
      workspaceId: update.workspaceId,
      ...(typeof update.auxiliary === "boolean" ? { auxiliary: update.auxiliary } : {}),
      ...(continuation !== undefined ? { continuation } : {}),
      ...(externalTurn !== undefined ? { externalTurn } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
  }
  return { updates: verified };
}

type CatalogRow = {
  id: string;
  workspace_id: string;
  updated_at?: string | null;
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
    if (previous || updates.size < 20_000) updates.set(id, { ...previous, ...update });
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

/** A patch can update existing rows, but cannot add rows or change access. */
export function applyConversationCatalogPatch<T extends CatalogRow>(
  sessions: T[],
  patch: ConversationCatalogPatch,
): T[] {
  if (!patch.updates.length) return sessions;
  const updates = new Map<string, CatalogUpdate>();
  rememberConversationCatalogPatch(updates, patch);
  let changed = false;
  const next = sessions.map((session) => {
    const update = updates.get(key(session.workspace_id, session.id));
    if (!update) return session;
    const continuation =
      update.continuation !== undefined ? (update.continuation ?? undefined) : session.continuation;
    const externalTurn =
      update.externalTurn !== undefined ? update.externalTurn : session.externalTurn;
    const updated_at =
      update.updatedAt !== undefined ? (update.updatedAt ?? undefined) : session.updated_at;
    if (
      sameContinuation(session.continuation, continuation) &&
      sameExternalTurn(session.externalTurn, externalTurn) &&
      session.updated_at === updated_at
    )
      return session;
    changed = true;
    return { ...session, continuation, externalTurn, updated_at };
  });
  return changed ? next : sessions;
}
