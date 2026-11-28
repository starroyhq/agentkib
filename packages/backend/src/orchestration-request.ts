import {
  PROJECT_AGENT_MAX_WORKERS,
  REMOTE_ERROR_CODES,
  REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT,
} from "@agentkib/runtime-protocol";
import type { ActiveAssignmentAdmissions } from "./orchestration-assignment";

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
};

export async function scopedProjectAgentRequest<T>(
  params: Record<string, unknown>,
  admissions: ActiveAssignmentAdmissions,
  run: (scope: ProjectAgentRequestScope) => Promise<T>,
): Promise<T> {
  const sessionId = projectAgentId(params.sessionId);
  const deviceId = projectAgentId(params.deviceId);
  const assignmentWorkspaces = remoteAssignmentWorkspaces(params, deviceId);
  const tracked =
    assignmentWorkspaces &&
    params.operation === REMOTE_PROJECT_AGENT_ASSIGNMENT_CONTRACT.assignOperation
      ? admissions.track(deviceId)
      : undefined;
  try {
    return await run({ sessionId, deviceId, assignmentWorkspaces, admission: tracked?.signal });
  } finally {
    tracked?.release();
  }
}
