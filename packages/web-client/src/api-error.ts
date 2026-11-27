import {
  parseRemoteErrorCode,
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  type RemoteErrorCode,
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

export function decodeApiError(status: number, body: unknown): ApiError {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = record.code ?? record.error;
  const outcome = record.controlOutcome;
  return new ApiError(
    status,
    parseRemoteErrorCode(code) ?? REMOTE_ERROR_CODES.requestFailed,
    outcome === REMOTE_CONTROL_OUTCOMES.notDispatched || outcome === REMOTE_CONTROL_OUTCOMES.unknown
      ? outcome
      : undefined,
    parseRemoteErrorCode(record.reason),
  );
}
