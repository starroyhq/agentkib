import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import {
  isCatalogSourceReason,
  REMOTE_ERROR_CODES,
  SESSION_COLLECTIONS,
} from "@agentkib/runtime-protocol";
import { withinIdentity } from "./files";
import { pathIdentity } from "./paths";
import type { SessionAgent } from "./session-readers";
import type { SessionStore } from "./session-store";
import type { NativeCatalogListing, NativeListing } from "./sessions/history-provider";
import { canRetrySessionSource } from "./session-source-reasons";
import { timestamp } from "./timestamps";

function catalogRow(
  store: SessionStore,
  session: NativeCatalogListing["sessions"][number],
  workspace: string,
) {
  const {
    native_ref,
    cwd: _cwd,
    git_origin_url: _origin,
    collection: _collection,
    ...metadata
  } = session;
  const parent = (ref: string | null | undefined) =>
    ref && ref !== native_ref ? store.id(session.agent, ref) : null;
  return {
    ...metadata,
    id: store.id(session.agent, native_ref),
    workspace_id: workspace,
    created_at: timestamp(session.created_at),
    updated_at: timestamp(session.updated_at),
    spawned_by_session_id: parent(session.spawned_by_session_id),
    forked_from_session_id: parent(session.forked_from_session_id),
  };
}

/** Reconcile one native metadata source. The index owns serialization and invalidation. */
export function applyNativeCatalogListing(
  store: SessionStore,
  agent: SessionAgent,
  listing: NativeCatalogListing,
  normalize: (sessions: NativeListing["sessions"]) => NativeListing["sessions"],
): { changed: boolean; rowsChanged: boolean } {
  const workspaces = store.sql
    .rows("SELECT id,canonical_path FROM workspaces ORDER BY length(canonical_path) DESC,id")
    .map((row) => ({ id: String(row.id), root: pathIdentity(String(row.canonical_path)) }));
  const scopes = new Map<string, NativeListing["sessions"]>(workspaces.map(({ id }) => [id, []]));
  const lookup = new Map(listing.sessions.map((row) => [row.native_ref, row.collection]));
  // Virtual Codex collections are separate from registered workspace ownership.
  for (const workspace of new Set([...store.catalogCollections(agent), ...lookup.values()])) {
    if (workspace) scopes.set(SESSION_COLLECTIONS[workspace], []);
  }
  const ids = listing.nativeRefs && new Set(listing.nativeRefs.map((ref) => store.id(agent, ref)));
  for (const session of normalize(listing.sessions)) {
    const collection = lookup.get(session.native_ref);
    const cwd = session.cwd;
    const directory = cwd && path.isAbsolute(cwd) ? pathIdentity(cwd) : null;
    const owner = collection
      ? SESSION_COLLECTIONS[collection]
      : directory
        ? workspaces.find(({ root }) => withinIdentity(directory, root))?.id
        : undefined;
    if (owner) scopes.get(owner)?.push(session);
  }
  const complete = !!ids || !listing.incomplete;
  const reasonCodes = [
    ...new Set(
      listing.issues
        ?.filter(({ scope }) => scope !== "unattributed")
        .map(({ code }) => code)
        .filter(isCatalogSourceReason),
    ),
  ].sort();
  const reasons = reasonCodes.length ? reasonCodes : [REMOTE_ERROR_CODES.sourceUnavailable];
  let changed = false;
  let rowsChanged = false;
  for (const [workspace, sessions] of scopes) {
    const current = store
      .list(workspace)
      .filter((row) => row.agent === agent && (!ids || ids.has(row.id)));
    const status = store.status(workspace).find((value) => value.agent === agent);
    const map = new Map(current.map((row) => [row.id, row]));
    const rows = listing.retainUnobservedTitles
      ? sessions.map((session) => {
          const previousTitle = map.get(store.id(agent, session.native_ref))?.title;
          return !session.sidechain && session.title === null && previousTitle != null
            ? { ...session, title: previousTitle }
            : session;
        })
      : sessions;
    const previousDirectories = store.directories(map.keys());
    const differs =
      rows.some((session) => {
        const row = catalogRow(store, session, workspace);
        const directory = previousDirectories.get(row.id);
        return (
          !isDeepStrictEqual(row, map.get(row.id)) ||
          (session.cwd ?? null) !== (directory?.cwd ?? null) ||
          (session.git_origin_url ?? null) !== (directory?.git_origin_url ?? null)
        );
      }) ||
      (complete && current.length !== rows.length);
    if (
      !listing.sourceFailed &&
      (differs || (!ids && !listing.incomplete && status?.error_detail))
    ) {
      store.sync(workspace, agent, rows, complete, undefined, [], listing.nativeRefs);
      changed = true;
      rowsChanged ||= differs;
    }
    // A transcript hint can fail verification while another file in the same
    // batch yields valid metadata. Keep unverified rows without marking the
    // healthy workspace's whole source as unavailable.
    if (listing.incomplete && (!ids || (reasonCodes.length && (rows.length || current.length)))) {
      const detail = JSON.stringify(reasons);
      if (differs || status?.error_detail !== detail) {
        store.failure(workspace, agent, detail, reasons.some(canRetrySessionSource));
        changed = true;
      }
    }
  }
  return { changed, rowsChanged };
}
