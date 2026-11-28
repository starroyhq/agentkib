import { sessionCollection } from "@agentkib/runtime-protocol";
import { z } from "zod";
import type { ClaudeManagedReadOwner } from "./agents/claude/claude-managed-read";
import {
  hasManagedCatalogWorkspace,
  managedCatalogProjection,
  readManagedCatalog,
} from "./agents/codex/managed-session-catalog";
import type { SessionReaders } from "./session-readers";
import type { BackendStore } from "./store";

const request = z.strictObject({
  operation: z.literal("assignment-reply-scope"),
  sessionIds: z.array(z.string().min(1).max(256)).max(21_000),
});

type Binding = { id: string; workspace_id: string; agent: string; aliases: string[] };

export function assignmentReplyScope(
  value: unknown,
  store: BackendStore,
  readers: SessionReaders,
  dataDir: string,
  claude: Pick<ClaudeManagedReadOwner, "catalog">,
  indexEnabled: boolean,
) {
  const { sessionIds } = request.parse(value);
  const wanted = new Set(sessionIds);
  // Read the authoritative stores synchronously. The catalog invalidation event can
  // arrive after the indexed ownership has already changed.
  const codex = readManagedCatalog(dataDir);
  const codexAliases = managedCatalogProjection(store, readers, codex).aliases;
  const managed: Binding[] = [
    ...claude.catalog(undefined, true, "scope").map((row) => ({
      id: String(row.id),
      workspace_id: String(row.workspace_id),
      agent: String(row.agent),
      aliases: typeof row.indexedSessionId === "string" ? [row.indexedSessionId] : [],
    })),
    ...codex.records
      .filter((record) => hasManagedCatalogWorkspace(store, record))
      .map((record) => ({
        id: record.id,
        workspace_id: record.workspace_id,
        agent: "codex",
        aliases: [...(codexAliases.get(record.id) ?? [])],
      })),
  ];
  const indexed = new Map<string, { workspace: string; agent: string }>();
  // Include aliases in the exact lookup even when an alias only appears in a write reply.
  const ids = JSON.stringify([
    ...new Set([
      ...wanted,
      ...managed
        .filter(({ id, aliases }) => wanted.has(id) || aliases.some((alias) => wanted.has(alias)))
        .flatMap(({ id, aliases }) => [id, ...aliases]),
    ]),
  ]);
  const registered = new Set<string>();
  for (const row of store.sql.rows(
    `SELECT id, NULL AS workspace_id, NULL AS agent FROM workspaces
     UNION ALL SELECT id, workspace_id, agent FROM conversation_sessions
       WHERE id IN (SELECT value FROM json_each(?))
     UNION ALL SELECT id, workspace_id, agent FROM conversation_collection_sessions
       WHERE id IN (SELECT value FROM json_each(?))`,
    ids,
    ids,
  )) {
    const id = String(row.id);
    if (row.workspace_id === null) registered.add(id);
    else if (!indexed.has(id))
      indexed.set(id, {
        workspace: String(row.workspace_id),
        agent: String(row.agent),
      });
  }

  const canonical = new Map<string, Binding | null>();
  const aliasOwners = new Map<string, string | null>();
  for (const row of managed) {
    canonical.set(row.id, canonical.has(row.id) ? null : row);
    for (const alias of row.aliases) {
      const owner = aliasOwners.get(alias);
      aliasOwners.set(alias, owner === undefined || owner === row.id ? row.id : null);
    }
  }
  const sessions = [];
  for (const [id, row] of canonical) {
    if (!row || !registered.has(row.workspace_id)) continue;
    const current = indexed.get(id);
    if (
      current &&
      (current.agent !== row.agent ||
        (current.workspace !== row.workspace_id && !sessionCollection(current.workspace)))
    )
      continue;
    const aliases = row.aliases.filter((alias) => {
      if (canonical.has(alias) || aliasOwners.get(alias) !== id) return false;
      const native = indexed.get(alias);
      return (
        !native ||
        (native.agent === row.agent &&
          (native.workspace === row.workspace_id || !!sessionCollection(native.workspace)))
      );
    });
    if (wanted.has(id) || aliases.some((alias) => wanted.has(alias)))
      sessions.push({ id, workspace_id: row.workspace_id, indexedSessionIds: aliases });
  }
  if (indexEnabled)
    for (const [id, row] of indexed)
      if (
        wanted.has(id) &&
        registered.has(row.workspace) &&
        !canonical.has(id) &&
        !aliasOwners.has(id)
      )
        sessions.push({ id, workspace_id: row.workspace, indexedSessionIds: [] });
  return { workspaces: [...registered].sort(), sessions };
}
