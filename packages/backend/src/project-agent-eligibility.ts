import {
  REMOTE_ERROR_CODES as codes,
  sessionProviderDeclaration,
  type ProjectAgentLeadEligibility,
  type ProjectAgentRoleAvailability,
  type ProjectAgentRoleReason,
  type ProjectAgentWorkerAction,
  type ProjectAgentWorkerEligibility,
} from "@agentkib/runtime-protocol";
import type { ProviderRoleFacts } from "./agents/project-agent-role-adapters";

export function roleAvailability(reason?: ProjectAgentRoleReason): ProjectAgentRoleAvailability {
  return reason ? { available: false, reason } : { available: true };
}

export function leadEligibility(facts: ProviderRoleFacts): ProjectAgentLeadEligibility {
  return {
    executionSide: facts.executionSide,
    availability: roleAvailability(facts.reason),
    toolsReady: facts.toolsReady ?? null,
  };
}

export function workerEligibility(
  agent: string | undefined,
  facts: ProviderRoleFacts,
  live?: Record<string, unknown> | null,
): ProjectAgentWorkerEligibility {
  const { reason, executionSide } = facts;
  const supported = sessionProviderDeclaration(agent)?.projectAgent?.workerActions ?? [];
  const actions: ProjectAgentWorkerEligibility["actions"] = {};
  const enabled: Record<ProjectAgentWorkerAction, boolean> = {
    send: live?.sendEnabled === true || live?.ownerWaitAvailable === true,
    queue: live?.queueEnabled === true || live?.ownerWaitAvailable === true,
    steer: live?.steerEnabled === true,
    stop: live?.stopEnabled === true && typeof live.turnId === "string",
    restart:
      executionSide === "agentkib" &&
      live !== null &&
      live !== undefined &&
      !["unsupported", "disconnected", "outcome-unknown"].includes(String(live.status)),
  };
  for (const operation of supported)
    actions[operation] = reason ? false : live ? enabled[operation] : null;
  return { executionSide, actions, availability: roleAvailability(reason) };
}

export function boundRoleProbe(read: Promise<ProviderRoleFacts>): Promise<ProviderRoleFacts> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const failed = { reason: codes.workerProbeFailed, executionSide: null };
  return Promise.race([
    read.catch(() => failed),
    new Promise<ProviderRoleFacts>((resolve) => {
      timeout = setTimeout(() => resolve(failed), 3_000);
    }),
  ]).finally(() => clearTimeout(timeout));
}
