import { REMOTE_ERROR_CODES as codes, projectAgentRoleReason } from "@agentkib/runtime-protocol";
import { RuntimeRequestError } from "../runtime-host";

const conflicts = new Set<string>([
  codes.leadExists,
  codes.leadRequiresManagedClaude,
  codes.workerUnavailable,
  codes.sessionIsAWorker,
  codes.leadUnavailable,
  codes.invalidLeadWorkspaces,
  codes.invalidLeadTurnLimit,
  codes.invalidLeadDelegation,
  codes.workerNotRunning,
]);

export function projectAgentResponseError(error: unknown) {
  const data =
    error instanceof RuntimeRequestError && error.data && typeof error.data === "object"
      ? (error.data as Record<string, unknown>)
      : undefined;
  const code = projectAgentRoleReason(
    data?.detail ?? (error instanceof Error ? error.message : undefined),
  );
  if (code === codes.workspaceNotAuthorized) return { status: 403, code };
  const reason = projectAgentRoleReason(data?.reason ?? code) ?? codes.projectAgentFailed;
  return code && conflicts.has(code)
    ? { status: 409, code, reason }
    : { status: 500, code: codes.projectAgentFailed, reason };
}
