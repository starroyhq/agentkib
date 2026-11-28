import {
  parseRemoteErrorCode,
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  REMOTE_ERROR_CONTRACT,
  REMOTE_REQUEST_PATH,
  sessionHistoryReadReason,
  type RemoteErrorCode,
  type RemoteErrorRetry,
} from "@agentkib/runtime-protocol";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public controlOutcome?:
      | typeof REMOTE_CONTROL_OUTCOMES.notDispatched
      | typeof REMOTE_CONTROL_OUTCOMES.unknown,
    public reason?: RemoteErrorCode,
  ) {
    super(code);
  }
}

function historyEventReason(status: number, code: RemoteErrorCode | undefined, reason: unknown) {
  const timeout = REMOTE_ERROR_CONTRACT.runtimeReadTimeout;
  if (status === timeout.http.status && code === timeout.http.reasonFor && reason === timeout.code)
    return timeout.code;
  return status === REMOTE_ERROR_CONTRACT.requestFailed.http.status &&
    code === REMOTE_ERROR_CODES.requestFailed
    ? sessionHistoryReadReason(reason)
    : undefined;
}

export function decodeApiError(status: number, body: unknown, path?: string): ApiError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = parseRemoteErrorCode(record.code ?? record.error);
  const outcome = record.controlOutcome;
  return new ApiError(
    status,
    code ?? REMOTE_ERROR_CODES.requestFailed,
    outcome === REMOTE_CONTROL_OUTCOMES.notDispatched || outcome === REMOTE_CONTROL_OUTCOMES.unknown
      ? outcome
      : undefined,
    path?.replace(/^\//, "").split("?")[0] === REMOTE_REQUEST_PATH.events
      ? historyEventReason(status, code, record.reason)
      : parseRemoteErrorCode(record.reason),
  );
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
      ? (historyEventReason(error.status, parseRemoteErrorCode(error.code), error.reason) ??
        error.code)
      : error instanceof Error
        ? sessionHistoryReadReason(error.message)
        : undefined;
  return !code || code === REMOTE_ERROR_CODES.requestFailed
    ? historyReadFailed
    : (historyFailures.get(code) ?? historyReadFailed);
}
