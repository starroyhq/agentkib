import { PROJECT_AGENT_MAX_WORKERS } from "@agentkib/runtime-protocol";

export function leadAuthorizedWorkspaces(params: Record<string, unknown>): string[] | undefined {
  const ids = params.authorizedWorkspaceIds;
  if (ids === undefined) return;
  if (
    !Array.isArray(ids) ||
    (params.operation !== "lead-status" && ids.length > PROJECT_AGENT_MAX_WORKERS + 1) ||
    ids.some((id) => typeof id !== "string" || !id || id.length > 256)
  )
    throw new Error("invalid-lead-request");
  return ids;
}

export function leadWorkerId(params: Record<string, unknown>): string {
  const value = typeof params.worker === "string" ? params.worker : "";
  if (!value || value.length > 256) throw new Error("invalid-lead-request");
  return value;
}
