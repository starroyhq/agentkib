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

// Registering these Codex reasons must not change the established adoption conflict.
const codexLeadUnavailableReasons = new Set<ProjectAgentRoleReason>([
  codes.codexAppServerUnavailable,
  codes.codexHomeChanged,
  codes.codexHomeUnavailable,
  codes.codexSessionDirectoryMissing,
  codes.codexSessionDirectoryNotDirectory,
  codes.codexSessionDirectoryUnsafe,
  codes.codexSessionDirectoryUnverified,
  codes.nativeSessionUnconfirmed,
  codes.sessionAlreadyManaged,
  codes.unverifiedSessionIdentity,
  codes.workerStaleOrDisabledControl,
]);

export function leadDesignationWireReason(reason: ProjectAgentRoleReason): ProjectAgentRoleReason {
  return codexLeadUnavailableReasons.has(reason) ? codes.leadUnavailable : reason;
}

export class ProjectAgentCommandRefusal extends Error {
  constructor(
    reason: string,
    readonly rpcReason?: ProjectAgentRoleReason,
  ) {
    super(reason);
  }
}

/**
 * Older clients match the original refusal in RPC detail. Attaching the precise reason lets
 * newer clients distinguish a changed assignment, a disconnected terminal and a failed read.
 */
export function projectAgentRpcRefusal(error: unknown, operation: string): RpcFault {
  const refused = error instanceof AssignmentNotDispatched ? error.cause : error;
  const reason =
    projectAgentRoleReason(refused instanceof Error ? refused.message : undefined) ??
    codes.projectAgentFailed;
  const wireReason =
    (refused instanceof ProjectAgentCommandRefusal ? refused.rpcReason : undefined) ?? reason;
  let detail: ProjectAgentRoleReason = wireReason;
  if (
    wireReason === codes.workerNotAssigned ||
    wireReason === codes.workerAssignmentChanged ||
    (operation === "lead-assign-workers" &&
      [codes.workerNotControllable, codes.workerTerminalDisconnected, codes.workerProbeFailed].some(
        (code) => code === wireReason,
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
    ].some((code) => code === wireReason)
  ) {
    detail = codes.leadRequiresManagedClaude;
  } else if (operation === "lead-assign-workers" || operation === "lead-designate") {
    detail = leadDesignationWireReason(wireReason);
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
