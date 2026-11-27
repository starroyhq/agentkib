import {
  REMOTE_CONTROL_OUTCOMES,
  REMOTE_ERROR_CODES,
  parseRemoteErrorCode,
  type RemoteErrorCode,
} from "@agentkib/runtime-protocol";

export function codexControlReason(error: unknown): RemoteErrorCode {
  return (
    parseRemoteErrorCode(error instanceof Error ? error.message : error) ??
    REMOTE_ERROR_CODES.requestFailed
  );
}

/** Keep the binding and phase intact when publishing a previously stored rejection. */
export function projectCodexControlAck(
  ack: Record<string, unknown>,
  executionMode: unknown,
): Record<string, unknown> {
  if (executionMode !== "codex-managed" || ack.accepted !== false) return ack;
  const hasReason = Object.hasOwn(ack, "reason");
  const hasError = Object.hasOwn(ack, "error");
  const registeredError = parseRemoteErrorCode(ack.error);
  const reason =
    parseRemoteErrorCode(ack.reason) ??
    registeredError ??
    (ack.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown
      ? REMOTE_ERROR_CODES.controlOutcomeUnconfirmed
      : REMOTE_ERROR_CODES.requestFailed);
  if (!hasReason && !hasError) return ack;
  return {
    ...ack,
    ...(hasReason ? { reason } : {}),
    ...(hasError ? { error: registeredError ?? reason } : {}),
  };
}
