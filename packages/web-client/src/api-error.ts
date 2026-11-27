import { REMOTE_CONTROL_OUTCOMES, type projectAgentRoleReason } from "@agentkib/runtime-protocol";

export class ApiError extends Error {
  retryAfterMs?: number;

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

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  if (/^\d+$/.test(header)) {
    const milliseconds = Number(header) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
  }
  if (!/^\w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) return undefined;
  const deadline = Date.parse(header);
  return Number.isFinite(deadline) ? Math.max(0, deadline - now) : undefined;
}
