import {
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  projectAgentRoleReason,
  sessionHistoryReadReason,
  type RemoteErrorCode,
  type RemoteErrorRetry,
  type REMOTE_CONTROL_OUTCOMES,
} from "@agentkib/runtime-protocol";

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

export function parseHistoryEventError(code: unknown, reason: unknown) {
  const registered = projectAgentRoleReason(code) ?? REMOTE_ERROR_CODES.requestFailed;
  return {
    code: registered,
    reason:
      registered === REMOTE_ERROR_CODES.requestFailed
        ? sessionHistoryReadReason(reason)
        : undefined,
  };
}

export type ConversationHistoryFailure = { reason: RemoteErrorCode; retry: RemoteErrorRetry };

const historyFailures = new Map<string, ConversationHistoryFailure>(
  Object.values(REMOTE_ERROR_CONTRACT).map(({ code, retry }) => [code, { reason: code, retry }]),
);
const historyReadFailed = {
  reason: REMOTE_ERROR_CONTRACT.historyReadFailed.code,
  retry: REMOTE_ERROR_CONTRACT.historyReadFailed.retry,
};

export function conversationHistoryFailure(error: unknown): ConversationHistoryFailure {
  const code =
    error instanceof ApiError
      ? (parseHistoryEventError(error.code, error.reason).reason ?? error.code)
      : error instanceof Error
        ? sessionHistoryReadReason(error.message)
        : undefined;
  return !code || code === REMOTE_ERROR_CODES.requestFailed
    ? historyReadFailed
    : (historyFailures.get(code) ?? historyReadFailed);
}
