import type { AgentKind, ConversationSessionSummary, WorkspaceSummary } from "@/core/types";
import {
  filterSessions as sharedFilterSessions,
  isSessionVisible,
} from "@agentkib/session-catalog";
export {
  isAuxiliarySession,
  isExecutionSession,
  isSessionListed,
  isSessionVisible,
  sortSessions,
  groupSessions,
  sessionGroupLabels,
  type SessionGroup,
} from "@agentkib/session-catalog";
import { tr } from "@/core/i18n";

export type SessionRecordFilter = "current" | "archived" | "metadata" | "all";

export interface SessionCatalogFilter {
  query: string;
  agent: AgentKind | "all";
  filter: SessionRecordFilter;
  /** Also list sessions a program started. */
  execution?: boolean;
}

export function filterSessions(
  sessions: ConversationSessionSummary[],
  workspaces: WorkspaceSummary[],
  filters: SessionCatalogFilter,
  translate = tr,
) {
  return sharedFilterSessions(sessions, workspaces, filters, translate("conversations.untitled"));
}

export function sessionCatalogStats(sessions: ConversationSessionSummary[]) {
  const visible = sessions.filter(isSessionVisible);
  return {
    total: visible.length,
    readable: visible.filter((session) => session.availability === "readable").length,
    archived: visible.filter((session) => session.archived).length,
    metadata: visible.filter((session) => session.availability === "metadata-only").length,
  };
}

/** Keeps native history IDs while recognizing only Runtime-verified managed aliases. */
export function projectManagedSessionAliases(
  indexed: ConversationSessionSummary[],
  authoritative: ConversationSessionSummary[],
  preferredId?: string,
) {
  const ownership = new Map<string, ConversationSessionSummary | null>();
  const identity = (session: ConversationSessionSummary, id: string) =>
    JSON.stringify([session.workspace_id, session.agent, id]);
  for (const owner of authoritative) {
    if (owner.remote || owner.origin !== "interactive") continue;
    for (const alias of owner.indexedSessionIds ?? []) {
      const key = identity(owner, alias);
      const previous = ownership.get(key);
      ownership.set(key, previous !== undefined && previous?.id !== owner.id ? null : owner);
    }
  }
  const preferred = indexed.find(
    (session) => session.id === preferredId && !session.remote && session.origin !== "auxiliary",
  );
  const preferredOwner = preferred ? ownership.get(identity(preferred, preferred.id)) : undefined;
  const seenOwners = new Set<string>();
  return indexed.flatMap((session) => {
    const owner = !session.remote ? ownership.get(identity(session, session.id)) : undefined;
    if (!owner || session.origin === "auxiliary") return [session];
    if (owner.id === preferredOwner?.id && session.id !== preferredId) return [];
    if (seenOwners.has(owner.id)) return [];
    seenOwners.add(owner.id);
    return [
      session.origin === "execution" ? { ...session, origin: "interactive" as const } : session,
    ];
  });
}

/** Include newly managed sessions before native history has been indexed, once per identity. */
export function workspaceSessionEntries(
  workspaceId: string,
  indexed: ConversationSessionSummary[],
  authoritative: ConversationSessionSummary[],
  preferredId?: string,
) {
  const owners = authoritative.filter((session) => session.workspace_id === workspaceId);
  const projected = projectManagedSessionAliases(
    indexed.filter((session) => session.workspace_id === workspaceId),
    owners,
    preferredId,
  );
  const identity = (agent: string, id: string) => JSON.stringify([agent, id]);
  const present = new Set(projected.map((session) => identity(session.agent, session.id)));
  return [
    ...projected,
    ...owners.filter(
      (owner) =>
        !present.has(identity(owner.agent, owner.id)) &&
        !(owner.indexedSessionIds ?? []).some((id) => present.has(identity(owner.agent, id))),
    ),
  ];
}
