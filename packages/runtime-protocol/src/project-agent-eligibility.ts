import { REMOTE_ERROR_CODES } from "./generated/remote-contract";

export type ProjectAgentRoleReason = (typeof REMOTE_ERROR_CODES)[keyof typeof REMOTE_ERROR_CODES];

const registered = new Set<string>(Object.values(REMOTE_ERROR_CODES));

export function projectAgentRoleReason(value: unknown): ProjectAgentRoleReason | undefined {
  return typeof value === "string" && registered.has(value)
    ? (value as ProjectAgentRoleReason)
    : undefined;
}

export type ProjectAgentRoleAvailability =
  | { available: true }
  | { available: false; reason: ProjectAgentRoleReason };

export type ProjectAgentExecutionSide = "agentkib" | "terminal" | "external" | null;
export type ProjectAgentWorkerAction = "send" | "queue" | "steer" | "stop" | "restart";

export interface ProjectAgentWorkerEligibility {
  executionSide: ProjectAgentExecutionSide;
  /** Declared actions and whether they can be used at the time of the read. */
  actions: Partial<Record<ProjectAgentWorkerAction, boolean | null>>;
  availability: ProjectAgentRoleAvailability;
}

export interface ProjectAgentLeadEligibility {
  executionSide: ProjectAgentExecutionSide;
  availability: ProjectAgentRoleAvailability;
  /** Null means the provider has no positive observation of tool registration. */
  toolsReady: boolean | null;
}
