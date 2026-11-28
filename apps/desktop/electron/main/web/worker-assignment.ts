import { REMOTE_ERROR_CODES as codes } from "@agentkib/runtime-protocol";
import {
  groupSessions,
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

export function workerAssignmentProject(
  catalog: unknown,
  sessionId: string,
  authorizedWorkspaceIds?: readonly string[],
) {
  const rows = snapshotField(catalog, "sessions");
  const projects = snapshotField(catalog, "workspaces");
  if (!Array.isArray(rows) || !Array.isArray(projects))
    throw new Error(codes.orchestrationUnavailable);
  const allowed = authorizedWorkspaceIds && new Set(authorizedWorkspaceIds);
  const sessions = (rows as AssignmentSession[]).filter(
    (session) => !session.remote && (!allowed || allowed.has(session.workspace_id)),
  );
  const workspaces = (projects as CatalogWorkspace[]).filter(
    (workspace) => !workspace.remote && (!allowed || allowed.has(workspace.id)),
  );
  const group = groupSessions(sessions, workspaces, { execution: true }).find((item) =>
    item.sessions.some((session) => session.id === sessionId),
  );
  const lead = group?.sessions.find((session) => session.id === sessionId);
  if (!group || !lead || lead.archived || lead.sidechain || lead.availability !== "readable")
    throw new Error(codes.leadNotControllable);
  const candidates = group.sessions.filter(
    (session) =>
      session.id !== sessionId &&
      !session.sidechain &&
      ((!session.archived && session.availability === "readable") ||
        session.orchestration?.leadId === sessionId),
  );
  return { lead, candidates, visibleIds: new Set(sessions.map(({ id }) => id)) };
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
