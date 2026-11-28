import {
  PROJECT_AGENT_MAX_WORKERS,
  REMOTE_ERROR_CODES,
  REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT,
} from "@agentkib/runtime-protocol";
import type { ActiveAssignmentAdmissions } from "./orchestration-assignment";
import type { AssignmentProject, AssignWorkersInput } from "./orchestration-assignment-project";
import { AssignmentNotDispatched } from "./project-agent-refusal";

export const PROJECT_AGENT_LOCAL_OWNER = "agentkib-local-owner";

export function projectAgentId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256)
    throw new Error(REMOTE_ERROR_CODES.invalidLeadRequest);
  return value;
}

export function authorizedLeadWorkspaces(params: Record<string, unknown>): string[] | undefined {
  const ids = params.authorizedWorkspaceIds;
  if (ids === undefined) return;
  if (
    !Array.isArray(ids) ||
    (params.operation !== "lead-status" && ids.length > PROJECT_AGENT_MAX_WORKERS + 1) ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 256)
  )
    throw new Error(REMOTE_ERROR_CODES.invalidLeadRequest);
  return ids;
}

export const MAX_PROJECT_ASSIGNMENT_IDS = 20_000;

export function projectSessionIds(value: unknown, limit: number): string[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error(REMOTE_ERROR_CODES.invalidLeadRequest);
  return Array.from(value, projectAgentId);
}

function projectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(REMOTE_ERROR_CODES.invalidLeadRequest);
  return value as Record<string, unknown>;
}

export function projectAssignmentBinding(value: unknown, workers: string[]): AssignmentProject {
  const project = projectRecord(value);
  const { projectKey } = project;
  if (
    !Array.isArray(project.workers) ||
    project.workers.length !== workers.length ||
    typeof projectKey !== "string" ||
    projectKey.length > 512 ||
    !/^(repository|workspace):./.test(projectKey)
  )
    throw new Error(REMOTE_ERROR_CODES.invalidLeadRequest);
  return {
    projectKey,
    leadWorkspaceId: projectAgentId(project.leadWorkspaceId),
    workers: project.workers.map((raw, index) => {
      const { sessionId, workspaceId } = projectRecord(raw);
      if (sessionId !== workers[index]) throw new Error(REMOTE_ERROR_CODES.invalidLeadRequest);
      return { sessionId: projectAgentId(sessionId), workspaceId: projectAgentId(workspaceId) };
    }),
  };
}

function remoteAssignmentWorkspaces(
  params: Record<string, unknown>,
  deviceId: string,
): string[] | undefined {
  const { optionsOperation, assignOperation } = REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT;
  if (
    deviceId === PROJECT_AGENT_LOCAL_OWNER ||
    (params.operation !== optionsOperation && params.operation !== assignOperation)
  )
    return;
  if (params.authorizedWorkspaceIds === undefined)
    throw new Error(REMOTE_ERROR_CODES.workspaceNotAuthorized);
  return projectSessionIds(params.authorizedWorkspaceIds, MAX_PROJECT_ASSIGNMENT_IDS);
}

export type ProjectAgentRequestScope = {
  sessionId: string;
  deviceId: string;
  assignmentWorkspaces?: string[];
  admission?: AbortSignal;
  beforeRegistration?: () => void;
};

export function assignedWorkersInput(
  params: Record<string, unknown>,
  {
    sessionId,
    deviceId,
    assignmentWorkspaces,
    admission,
    beforeRegistration,
  }: ProjectAgentRequestScope,
  workspaceId: string | undefined,
): AssignWorkersInput {
  const workers = projectSessionIds(params.workers, PROJECT_AGENT_MAX_WORKERS);
  if (!workspaceId) throw new Error(REMOTE_ERROR_CODES.sessionWorkspaceUnavailable);
  return {
    sessionId,
    deviceId,
    workspaceId,
    workers,
    authorizedWorkspaceIds: assignmentWorkspaces,
    assignmentProject: assignmentWorkspaces
      ? projectAssignmentBinding(params.assignmentProject, workers)
      : undefined,
    mayDelegateApprovals: params.mayDelegateApprovals === true,
    admission,
    beforeRegistration,
  };
}

export async function scopedProjectAgentRequest<T>(
  params: Record<string, unknown>,
  admissions: ActiveAssignmentAdmissions,
  run: (scope: ProjectAgentRequestScope) => Promise<T>,
): Promise<T> {
  const assigning =
    params.deviceId !== PROJECT_AGENT_LOCAL_OWNER &&
    params.operation === REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT.assignOperation;
  let tracked: ReturnType<ActiveAssignmentAdmissions["track"]> | undefined;
  let enteredRegistration = false;
  try {
    const sessionId = projectAgentId(params.sessionId);
    const deviceId = projectAgentId(params.deviceId);
    const assignmentWorkspaces = remoteAssignmentWorkspaces(params, deviceId);
    if (assigning) tracked = admissions.track(deviceId);
    return await run({
      sessionId,
      deviceId,
      assignmentWorkspaces,
      admission: tracked?.signal,
      beforeRegistration: assigning ? () => (enteredRegistration = true) : undefined,
    });
  } catch (error) {
    // A storage failure while entering registration may leave a committed assignment.
    throw assigning && !enteredRegistration ? new AssignmentNotDispatched(error) : error;
  } finally {
    tracked?.release();
  }
}
