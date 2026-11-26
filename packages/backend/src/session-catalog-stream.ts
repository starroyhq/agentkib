import { isDeepStrictEqual } from "node:util";

const CATALOG_SETTLE_MS = 2_500;
const MAX_CATALOG_UPDATES = 256;
const CATALOG_MUTATIONS = new Set([
  "create",
  "provider-create",
  "dsh-create",
  "devin-create",
  "archive",
  "unarchive",
  "rename",
  "delete",
  "fork",
]);
export const CATALOG_RECONCILE_MS = 15_000;
export const CATALOG_DOMAIN = { domains: ["catalog"] };

type RecordValue = Record<string, unknown>;
type ExternalTurn = { status: "running"; startedAt: string | null; turnId?: string | null };
type CatalogFields = {
  continuation?: RecordValue | null;
  updatedAt?: string | null;
  externalTurn?: ExternalTurn | null;
};
type CatalogUpdate = {
  sessionId: string;
  workspaceId: string;
  auxiliary: boolean;
} & CatalogFields;
type CatalogPayload = typeof CATALOG_DOMAIN & { catalogPatch?: { updates: CatalogUpdate[] } };

/** Only share overlapping projections. Readers arriving after a mutation wait for a fresh one. */
export class SessionCatalogRead {
  #generation = 0;
  #flight?: { generation: number; promise: Promise<unknown> };

  invalidate() {
    this.#generation += 1;
  }

  read<T>(read: () => Promise<T>): Promise<T> {
    const ongoing = this.#flight;
    if (ongoing) {
      if (ongoing.generation === this.#generation) return ongoing.promise as Promise<T>;
      const again = () => this.read(read);
      return ongoing.promise.then(again, again);
    }
    const flight = { generation: this.#generation, promise: Promise.resolve().then(read) };
    this.#flight = flight;
    const release = () => {
      if (this.#flight === flight) this.#flight = undefined;
    };
    void flight.promise.then(release, release);
    return flight.promise;
  }
}

export function isCatalogRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function afterCatalogMutation(
  operation: unknown,
  response: unknown,
  host: boolean,
  changed: () => void,
): unknown {
  if (typeof operation !== "string" || !CATALOG_MUTATIONS.has(operation)) return response;
  return Promise.resolve(response).then((result) => {
    const control = !host && isCatalogRecord(result) ? result.result : result;
    if (
      !isCatalogRecord(control) ||
      (control.accepted !== false && control.controlOutcome !== "not-dispatched")
    )
      changed();
    return result;
  });
}

function code(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,127}$/.test(value);
}

function rowUpdate<T extends CatalogFields>(row: RecordValue, fields: T) {
  if (typeof row.id !== "string" || typeof row.workspace_id !== "string") return;
  return {
    sessionId: row.id,
    workspaceId: row.workspace_id,
    auxiliary: row.origin === "auxiliary",
    ...fields,
  };
}

function continuationOf(live: RecordValue): RecordValue | undefined {
  const { status, executionLocation, ownershipReason, reason, backgroundTasks } = live;
  if (!code(status)) return;
  const location =
    executionLocation === "agentkib" ||
    executionLocation === "terminal" ||
    executionLocation === "external" ||
    executionLocation === null;
  const taskCount = Array.isArray(backgroundTasks) ? backgroundTasks.length : backgroundTasks;
  return {
    status: status === "waiting-approval" ? "awaiting-approval" : status,
    ...(location ? { executionLocation } : {}),
    ...(code(ownershipReason) || ownershipReason === null ? { ownershipReason } : {}),
    ...(code(reason) || reason === null ? { reason } : {}),
    ...(typeof taskCount === "number" && Number.isSafeInteger(taskCount) && taskCount > 0
      ? { backgroundTasks: taskCount }
      : {}),
  };
}

function date(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function externalTurnOf(value: unknown): ExternalTurn | null | undefined {
  if (value == null) return null;
  if (!isCatalogRecord(value) || value.status !== "running" || !date(value.startedAt)) return;
  const { startedAt, turnId } = value;
  if (turnId != null && (typeof turnId !== "string" || !/^[\w.:-]{1,256}$/.test(turnId))) return;
  return { status: "running", startedAt, ...(turnId === undefined ? {} : { turnId }) };
}

function changedFields(before: RecordValue, after: RecordValue): CatalogFields | undefined {
  const {
    continuation: priorContinuation,
    externalTurn: priorTurn,
    updated_at: priorTimestamp,
    ...priorMetadata
  } = before;
  const { continuation, externalTurn, updated_at: timestamp, ...metadata } = after;
  if (!isDeepStrictEqual(priorMetadata, metadata)) return;
  const fields: CatalogFields = {};
  if (!isDeepStrictEqual(priorContinuation, continuation)) {
    if (continuation == null) fields.continuation = null;
    else {
      const current = isCatalogRecord(continuation) && continuationOf(continuation);
      if (!current) return;
      fields.continuation = current;
    }
  }
  if (!isDeepStrictEqual(priorTurn, externalTurn)) {
    const current = externalTurnOf(externalTurn);
    if (current === undefined) return;
    fields.externalTurn = current;
  }
  if (priorTimestamp !== timestamp) {
    const current = timestamp ?? null;
    if (!date(current)) return;
    fields.updatedAt = current;
  }
  return fields;
}

function patch(updates: CatalogUpdate[]): CatalogPayload {
  return { ...CATALOG_DOMAIN, catalogPatch: { updates } };
}

/** Known runtime states change only their existing row. Discovery and scoped fields still reconcile. */
export class SessionCatalogStream {
  #rows = new Map<string, number>();
  #updates = new Map<string, CatalogUpdate & { continuation: RecordValue }>();
  #full = false;
  #dueAt = Infinity;

  constructor(live: RecordValue) {
    this.index(live);
  }

  index(live: RecordValue) {
    this.#rows.clear();
    if (!Array.isArray(live.sessions)) return;
    for (const [index, row] of live.sessions.entries())
      if (isCatalogRecord(row) && typeof row.id === "string") this.#rows.set(row.id, index);
  }

  invalidate(dueAt = Date.now() + CATALOG_SETTLE_MS) {
    this.#full = true;
    this.#updates.clear();
    this.#dueAt = Math.min(this.#dueAt, dueAt);
  }

  update(live: RecordValue, sessionId: string, observed: RecordValue) {
    if (this.#full || !Array.isArray(live.sessions)) return;
    const index = this.#rows.get(sessionId);
    // New / hidden sessions wait for discovery; a live event is not catalog admission.
    if (index === undefined) return;
    const row = live.sessions[index] as RecordValue;
    const continuation = continuationOf(observed);
    const update = continuation && rowUpdate(row, { continuation });
    if (!update) return;
    const previous = this.#updates.get(sessionId)?.continuation ?? row.continuation;
    if (isDeepStrictEqual(previous, continuation)) return;
    // External activity also carries a verified native turn identity. Reconcile
    // before replacing it with a different owner or dropping the external turn.
    if (
      row.externalTurn ||
      (!this.#updates.has(sessionId) && this.#updates.size >= MAX_CATALOG_UPDATES)
    ) {
      this.invalidate();
      return;
    }
    if (isDeepStrictEqual(row.continuation, continuation)) this.#updates.delete(sessionId);
    else this.#updates.set(sessionId, update);
    this.#dueAt = this.#updates.size
      ? Math.min(this.#dueAt, Date.now() + CATALOG_SETTLE_MS)
      : Infinity;
  }

  take(
    live: RecordValue,
    now: number,
  ): "refresh" | { live: RecordValue; payload: CatalogPayload } | undefined {
    if (now < this.#dueAt) return;
    this.#dueAt = Infinity;
    if (this.#full) {
      this.#full = false;
      return "refresh";
    }
    const sessions = Array.isArray(live.sessions) ? live.sessions.slice() : [];
    const updates: CatalogUpdate[] = [];
    for (const update of this.#updates.values()) {
      const index = this.#rows.get(update.sessionId);
      if (index === undefined) continue;
      const row = sessions[index];
      if (row.workspace_id !== update.workspaceId || row.externalTurn) continue;
      if (isDeepStrictEqual(row.continuation, update.continuation)) continue;
      sessions[index] = { ...row, continuation: update.continuation };
      updates.push(update);
    }
    this.#updates.clear();
    if (updates.length) return { live: { ...live, sessions }, payload: patch(updates) };
  }

  reconcile(previous: RecordValue, live: RecordValue, full: boolean): CatalogPayload | undefined {
    this.index(live);
    if (full) return CATALOG_DOMAIN;
    if (isDeepStrictEqual(previous, live)) return;
    const { sessions: before, ...beforeMetadata } = previous;
    const { sessions: after, ...afterMetadata } = live;
    if (
      !Array.isArray(before) ||
      !Array.isArray(after) ||
      before.length !== after.length ||
      !isDeepStrictEqual(beforeMetadata, afterMetadata)
    )
      return CATALOG_DOMAIN;
    const byId = new Map<string, RecordValue>();
    for (const row of before) {
      if (!isCatalogRecord(row) || typeof row.id !== "string" || byId.has(row.id))
        return CATALOG_DOMAIN;
      byId.set(row.id, row);
    }
    const updates: CatalogUpdate[] = [];
    for (const row of after) {
      if (!isCatalogRecord(row) || typeof row.id !== "string") return CATALOG_DOMAIN;
      const prior = byId.get(row.id);
      if (!prior) return CATALOG_DOMAIN;
      byId.delete(row.id);
      if (isDeepStrictEqual(prior, row)) continue;
      const fields = changedFields(prior, row);
      if (!fields) return CATALOG_DOMAIN;
      if (!Object.keys(fields).length) continue;
      const update = rowUpdate(row, fields);
      if (!update) return CATALOG_DOMAIN;
      updates.push(update);
      if (updates.length > MAX_CATALOG_UPDATES) return CATALOG_DOMAIN;
    }
    if (updates.length) return patch(updates);
  }
}
