import type { projectAgentRoleReason, REMOTE_CONTROL_OUTCOMES } from "@agentkib/runtime-protocol";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public controlOutcome?:
      | typeof REMOTE_CONTROL_OUTCOMES.notDispatched
      | typeof REMOTE_CONTROL_OUTCOMES.unknown,
    public reason?: ReturnType<typeof projectAgentRoleReason>,
  ) {
    super(code);
  }
}
