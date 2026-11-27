import { PROJECT_AGENT_MAX_WORKERS, REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";

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

export function localProjectSessionIds(deviceId: string, value: unknown, limit: number): string[] {
  if (deviceId !== PROJECT_AGENT_LOCAL_OWNER || !Array.isArray(value) || value.length > limit)
    throw new Error(REMOTE_ERROR_CODES.invalidLeadRequest);
  return value.map(projectAgentId);
}
