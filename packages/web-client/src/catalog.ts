export interface IncompleteSessionSource {
  workspaceId: string;
  agent: string;
}

interface CatalogIdentity {
  id: string;
  workspace_id: string;
  agent: string;
  indexedSessionId?: string | null;
  indexedSessionIds?: readonly string[] | null;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const old = left as Record<string, unknown>;
  const next = right as Record<string, unknown>;
  const keys = Object.keys(old);
  return (
    keys.length === Object.keys(next).length &&
    keys.every((key) => Object.hasOwn(next, key) && equalValue(old[key], next[key]))
  );
}

/** Only an unfinished source retains records missing from the new snapshot. */
export function mergeCatalogSessions<T extends CatalogIdentity>(
  previous: T[],
  records: T[],
  incompleteSources: readonly IncompleteSessionSource[] = [],
  retainMissing = false,
  reconcile: (previous: T | undefined, record: T) => T = (old, record) =>
    old && equalValue(old, record) ? old : record,
): T[] {
  // Session IDs are global within a provider. A verified move to another
  // workspace must replace its old row even while the old source is partial.
  const identity = (agent: string, id: string) => JSON.stringify([agent, id]);
  const key = (session: T) => identity(session.agent, session.id);
  const aliases = (session: T): string[] =>
    [
      ...(typeof session.indexedSessionId === "string" ? [session.indexedSessionId] : []),
      ...(Array.isArray(session.indexedSessionIds) ? session.indexedSessionIds : []),
    ].filter((id) => typeof id === "string" && id.length > 0);
  const old = new Map(previous.map((session) => [key(session), session]));
  const seen = new Set<string>();
  const accepted = records.flatMap((session) => {
    const id = key(session);
    if (seen.has(id)) return [];
    seen.add(id);
    return [reconcile(old.get(id), session)];
  });
  const incomplete = new Set(
    incompleteSources.map((source) => JSON.stringify([source.workspaceId, source.agent])),
  );
  // Only a newly verified managed alias supersedes another canonical row;
  // a native row alone does not prove a temporarily missing owner disappeared.
  const superseded = new Set(
    accepted.flatMap((session) =>
      aliases(session)
        .filter((id) => id !== session.id)
        .map((id) => identity(session.agent, id)),
    ),
  );
  const retained: T[] = [];
  for (const session of previous)
    if (
      !seen.has(key(session)) &&
      ![session.id, ...aliases(session)].some((id) =>
        superseded.has(identity(session.agent, id)),
      ) &&
      (retainMissing || incomplete.has(JSON.stringify([session.workspace_id, session.agent])))
    )
      retained.push(session);
  // A partial source may temporarily expose its native row without returning
  // the already verified managed owner. Keep that owner and suppress only its
  // explicit native aliases; another positively verified owner still wins above.
  const retainedAliases = new Set(
    retained.flatMap((session) =>
      aliases(session)
        .filter((id) => id !== session.id)
        .map((id) => identity(session.agent, id)),
    ),
  );
  const next = accepted.filter(
    (session) =>
      !superseded.has(key(session)) &&
      (!retainedAliases.has(key(session)) || aliases(session).some((id) => id !== session.id)),
  );
  next.push(...retained);
  return next.length === previous.length &&
    next.every((session, index) => session === previous[index])
    ? previous
    : next;
}

export function isStaleCatalogRead(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const values = [
    "code" in error ? error.code : undefined,
    "message" in error ? error.message : undefined,
  ];
  return values.some(
    (value) =>
      typeof value === "string" && /^(?:catalog[-_]stale|session[-_]index[-_]stale)$/.test(value),
  );
}

/** This helper only repeats reads; scans and business commands must never use it. */
export async function retryStaleCatalogRead<T>(
  read: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await read();
    } catch (error) {
      if (!isStaleCatalogRead(error) || attempt >= 2) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
    }
  }
}
