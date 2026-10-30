import path from "node:path";
import { z } from "zod";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { CodexSessions } from "./codex-sessions";
import { readManagedCatalogSnapshot } from "./managed-ledger";
import { canonicalize, pathIdentity } from "./paths";
import { within } from "./files";
import type { SessionReaders } from "./session-readers";
import type { BackendStore } from "./store";
import type { NativeSession } from "./session-store";

export const managedRecordSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  workspace: z.string(),
  cwd: z.string().optional(),
  home: z.string(),
  native_id: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  service_tier: z.string().nullable().optional(),
  policy_id: z.string().optional(),
  default_model: z.string().nullable().optional(),
  default_effort: z.string().nullable().optional(),
  default_service_tier: z.string().nullable().optional(),
  native_settings: z.unknown().optional(),
  mode: z.string().nullable().optional(),
  source_session_id: z.string().nullable().optional(),
  title: z.string(),
  created_at: z.string(),
  released: z.boolean(),
  adopted: z.boolean(),
  archived: z.boolean().default(false),
  token_usage: z.unknown().optional(),
  goal: z.unknown().optional(),
  snapshot: z
    .object({ revision: z.number().int().nonnegative().optional() })
    .passthrough()
    .optional(),
});

export type ManagedCatalogRecord = z.infer<typeof managedRecordSchema>;
export interface ManagedCatalog {
  records: ManagedCatalogRecord[];
  complete: boolean;
}
type IndexedSession = ReturnType<BackendStore["sessions"]["list"]>[number];

export function readManagedCatalog(dataDir: string): ManagedCatalog {
  const snapshot = readManagedCatalogSnapshot(dataDir);
  return {
    records: snapshot.records
      .map((record) => {
        const parsed = managedRecordSchema.safeParse(record);
        if (!parsed.success) throw new Error("Invalid managed Codex session record");
        return parsed.data;
      })
      .filter((record) => !record.released || !record.adopted),
    complete: snapshot.complete,
  };
}

export function hasManagedCatalogWorkspace(store: BackendStore, record: ManagedCatalogRecord) {
  try {
    return (
      path.isAbsolute(record.workspace) &&
      pathIdentity(canonicalize(store.workspacePath(record.workspace_id))) ===
        pathIdentity(canonicalize(record.workspace))
    );
  } catch {
    return false;
  }
}

/** Return only native aliases whose global ownership and bounded header agree. */
export async function managedCatalogAliases(
  store: BackendStore,
  readers: SessionReaders,
  catalog: ManagedCatalog,
): Promise<Map<string, Set<string>>> {
  return (await managedCatalogProjection(store, readers, catalog)).aliases;
}

export async function managedCatalogProjection(
  store: BackendStore,
  readers: SessionReaders,
  catalog: ManagedCatalog,
) {
  const aliases = new Map<string, Set<string>>();
  const nativeByOwner = new Map<string, NativeSession>();
  const projection = { aliases, nativeByOwner };
  if (!catalog.complete || catalog.records.length === 0) return projection;
  const owners = new Map<string, ManagedCatalogRecord | null>();
  // Check the complete active ledger before ignoring inaccessible workspaces.
  // Otherwise an unregistered conflicting owner could grant an exception.
  for (const record of catalog.records) {
    const native = uuid(record.native_id);
    if (!native) continue;
    owners.set(native, owners.has(native) ? null : record);
  }
  let home: string;
  try {
    home = canonicalize(readers.codexHome());
  } catch {
    return projection;
  }
  const workspaces = new Map<string, Map<string, ManagedCatalogRecord>>();
  for (const [native, record] of owners) {
    if (!record || !hasManagedCatalogWorkspace(store, record)) continue;
    try {
      if (
        !path.isAbsolute(record.home) ||
        pathIdentity(canonicalize(record.home)) !== pathIdentity(home)
      )
        continue;
    } catch {
      continue;
    }
    let workspaceOwners = workspaces.get(record.workspace_id);
    if (!workspaceOwners) workspaces.set(record.workspace_id, (workspaceOwners = new Map()));
    workspaceOwners.set(native, record);
  }
  const candidates: Array<{
    native: string;
    ref: string;
    record: ManagedCatalogRecord;
    session: NativeSession;
  }> = [];
  const scopes = [...workspaces].map(([workspaceId, workspaceOwners]) => ({
    workspace: store.workspacePath(workspaceId),
    workspaceOwners,
  }));
  const eligible = new Map([...workspaces.values()].flatMap((records) => [...records]));
  if (eligible.size)
    for (const collection of Object.values(SESSION_COLLECTIONS))
      scopes.push({ workspace: collection, workspaceOwners: eligible });
  for (const { workspace, workspaceOwners } of scopes) {
    try {
      // Only owned threads can become aliases; skip classifying every other thread.
      const listing = await readers.list("codex", workspace, {
        matches: (ref) => {
          const native = uuid(ref);
          return native !== null && workspaceOwners.has(native);
        },
      });
      for (const candidate of listing.sessions) {
        if (candidate.origin === "auxiliary") continue;
        const native = uuid(candidate.native_ref);
        const record = native ? workspaceOwners.get(native) : undefined;
        if (native && record)
          candidates.push({ native, ref: candidate.native_ref, record, session: candidate });
      }
    } catch {
      // An unavailable native source cannot prove a directory ownership alias.
    }
  }
  if (candidates.length === 0) return projection;
  const identities = new CodexSessions({ CODEX_HOME: home }).verifiedIndexedIdentities(
    candidates.map((candidate) => candidate.ref),
  );
  // The alias ID helper can create a salt. A directory only projects existing
  // index identities, which always have their salt already recorded.
  if (
    typeof store.sessions.sql.one("SELECT value FROM schema_meta WHERE key='conversation_salt'")
      ?.value !== "string"
  )
    return projection;
  for (const { native, ref, record, session } of candidates) {
    const verified = identities.get(native);
    // Legacy display ownership can be proved by its native UUID/header even
    // before the first safe resume adds a separate execution cwd to the ledger.
    const executionDirectory = record.cwd ?? verified?.cwd;
    try {
      if (
        !verified ||
        !executionDirectory ||
        !path.isAbsolute(executionDirectory) ||
        pathIdentity(verified.cwd) !== pathIdentity(executionDirectory) ||
        !within(canonicalize(verified.cwd), canonicalize(record.workspace))
      )
        continue;
    } catch {
      continue;
    }
    let owned = aliases.get(record.id);
    if (!owned) aliases.set(record.id, (owned = new Set()));
    owned.add(store.sessions.id("codex", ref));
    const previous = nativeByOwner.get(record.id);
    if (
      !previous ||
      (session.updated_at &&
        (!previous.updated_at || Date.parse(session.updated_at) > Date.parse(previous.updated_at)))
    )
      nativeByOwner.set(record.id, session);
  }
  return projection;
}

/** Project display ownership without returning ledger identity or control grants. */
export async function projectPairedManagedSessions(
  store: BackendStore,
  readers: SessionReaders,
  dataDir: string,
  sessions: IndexedSession[],
): Promise<IndexedSession[]> {
  if (!sessions.some((session) => session.agent === "codex" && session.origin !== "auxiliary"))
    return sessions;
  const catalog = readManagedCatalog(dataDir);
  const aliases = await managedCatalogAliases(store, readers, catalog);
  const owners = new Map<string, string>();
  for (const record of catalog.records)
    for (const alias of aliases.get(record.id) ?? [])
      owners.set(JSON.stringify([record.workspace_id, alias]), record.id);
  // Finish all fallible ownership reads before producing the changed catalog.
  const seen = new Set<string>();
  return sessions.flatMap((session) => {
    if (session.agent !== "codex" || session.origin === "auxiliary") return [session];
    const owner = owners.get(JSON.stringify([session.workspace_id, session.id]));
    if (!owner) return [session];
    if (seen.has(owner)) return [];
    seen.add(owner);
    return [session.origin === "execution" ? { ...session, origin: "interactive" } : session];
  });
}

function uuid(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : null;
}
