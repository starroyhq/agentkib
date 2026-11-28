import { assignmentProjectKeys, REMOTE_ERROR_CODES as codes } from "@agentkib/runtime-protocol";
import {
  isSessionListed,
  pinnedSessionsFirst,
  sortSessions,
  type CatalogSession,
  type CatalogWorkspace,
} from "@agentkib/session-catalog";
import { snapshotField } from "./catalog-stream";

type AssignmentSession = CatalogSession & {
  sidechain?: boolean;
  remote?: unknown;
  indexedSessionIds?: string[];
  orchestration?: { role: "lead" | "worker"; leadId?: string };
};

export function assignmentCatalog(catalog: unknown, authorizedWorkspaceIds?: readonly string[]) {
  const rows = snapshotField(catalog, "sessions");
  const projects = snapshotField(catalog, "workspaces");
  if (!Array.isArray(rows) || !Array.isArray(projects))
    throw new Error(codes.orchestrationUnavailable);
  const allSessions = rows as AssignmentSession[];
  const allowed = authorizedWorkspaceIds && new Set(authorizedWorkspaceIds);
  const workspaces = (projects as CatalogWorkspace[]).filter(
    (workspace) => !workspace.remote && (!allowed || allowed.has(workspace.id)),
  );
  const workspaceIds = new Set(workspaces.map(({ id }) => id));
  const sessions = allSessions.filter(
    (session) => !session.remote && workspaceIds.has(session.workspace_id),
  );
  const visibleIds = new Set(sessions.map(({ id }) => id));
  const canonicalIds = new Set(allSessions.map(({ id }) => id));
  const aliasOwners = new Map<string, string | null>();
  for (const { id, indexedSessionIds } of allSessions) {
    for (const alias of indexedSessionIds ?? []) {
      if (canonicalIds.has(alias)) continue;
      const owner = aliasOwners.get(alias);
      aliasOwners.set(alias, owner === undefined || owner === id ? id : null);
    }
  }
  const aliases = new Map<string, Set<string>>();
  const workspaceById = new Map(sessions.map(({ id, workspace_id }) => [id, workspace_id]));
  for (const [alias, owner] of aliasOwners) {
    if (!owner || !visibleIds.has(owner)) continue;
    const ids = aliases.get(owner) ?? new Set<string>();
    ids.add(alias);
    aliases.set(owner, ids);
  }
  for (const [id, entries] of aliases)
    for (const alias of entries) workspaceById.set(alias, workspaceById.get(id)!);
  return { sessions, workspaces, visibleIds, workspaceById, aliases };
}

export function workerAssignmentProject(
  catalog: unknown,
  sessionId: string,
  authorizedWorkspaceIds?: readonly string[],
) {
  const { sessions, workspaces, visibleIds, aliases } = assignmentCatalog(
    catalog,
    authorizedWorkspaceIds,
  );
  const listed = sessions.filter((session) => isSessionListed(session, { execution: true }));
  const projectKeys = assignmentProjectKeys(listed, workspaces);
  const projectKey = projectKeys.get(sessionId);
  const lead = listed.find((session) => session.id === sessionId);
  if (!projectKey || !lead || lead.archived || lead.sidechain || lead.availability !== "readable")
    throw new Error(codes.leadNotControllable);
  const candidates = listed.filter(
    (session) =>
      session.id !== sessionId &&
      projectKeys.get(session.id) === projectKey &&
      !session.sidechain &&
      ((!session.archived && session.availability === "readable") ||
        session.orchestration?.leadId === sessionId),
  );
  return {
    lead,
    projectKey,
    candidates: pinnedSessionsFirst(sortSessions(candidates)),
    visibleIds,
    aliases,
  };
}

export function assertAssignmentWorkers(
  { lead, candidates, visibleIds }: ReturnType<typeof workerAssignmentProject>,
  workers: readonly string[],
  scoped = false,
) {
  if (lead.orchestration?.role === "worker") throw new Error(codes.sessionIsAWorker);
  const byId = new Map(candidates.map((session) => [session.id, session]));
  for (const id of workers) {
    if (scoped && !visibleIds.has(id)) throw new Error(codes.workspaceNotAuthorized);
    const candidate = byId.get(id);
    if (!candidate) throw new Error(codes.workerOutsideProject);
    if (candidate.orchestration?.role === "lead") throw new Error(codes.sessionIsAProjectAgent);
    if (candidate.orchestration?.role === "worker") throw new Error(codes.sessionIsAWorker);
  }
}
