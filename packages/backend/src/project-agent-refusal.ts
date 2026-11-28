import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES as codes,
  REMOTE_ERROR_CONTRACT,
  projectAgentRoleReason,
  type ProjectAgentRoleReason,
} from "@agentkib/runtime-protocol";
import { RpcFault } from "./rpc";

/** The assignment never entered persistence, so the requester may distinguish it from a lost reply. */
export class AssignmentNotDispatched extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : codes.projectAgentFailed, { cause });
  }
}

/**
 * Older clients match the original refusal in RPC detail. Attaching the precise reason lets
 * newer clients distinguish a changed assignment, a disconnected terminal and a failed read.
 */
export function projectAgentRpcRefusal(error: unknown, operation: string): RpcFault {
  const reason =
    projectAgentRoleReason(error instanceof Error ? error.message : undefined) ??
    codes.projectAgentFailed;
  let detail: ProjectAgentRoleReason = reason;
  if (
    reason === codes.workerNotAssigned ||
    reason === codes.workerAssignmentChanged ||
    (operation === "lead-assign-workers" &&
      [codes.workerNotControllable, codes.workerTerminalDisconnected, codes.workerProbeFailed].some(
        (code) => code === reason,
      ))
  ) {
    detail = codes.workerUnavailable;
  } else if (
    ["lead-assign-workers", "lead-designate", "lead-update", "lead-resume"].includes(operation) &&
    [
      codes.leadNotControllable,
      codes.leadClaudeTerminalDisconnected,
      codes.leadToolsUnavailable,
      codes.sessionWorkspaceUnavailable,
      codes.antigravityAcpDisabled,
    ].some((code) => code === reason)
  ) {
    detail = codes.leadRequiresManagedClaude;
  }
  return new RpcFault(
    REMOTE_ERROR_CONTRACT.rpcApplicationFailure.ipc.rpcCode,
    "AgentKib command failed",
    {
      detail,
      reason,
      ...(error instanceof AssignmentNotDispatched && {
        controlOutcome: REMOTE_CONTROL_OUTCOMES.notDispatched,
      }),
    },
  );
}
