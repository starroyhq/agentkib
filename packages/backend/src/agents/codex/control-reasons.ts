import { REMOTE_CONTROL_OUTCOMES, REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";

const fixedReasons = new Set<string>([
  ...Object.values(REMOTE_ERROR_CODES),
  // Established Codex controls also return these fixed values.
  "codex-app-server-unavailable",
  "codex-context-outside-workspace",
  "codex-desktop-owner-missing",
  "codex-home-changed",
  "codex-home-unavailable",
  "codex-session-directory-missing",
  "codex-session-directory-not-directory",
  "codex-session-directory-unsafe",
  "codex-session-directory-unverified",
  "control-preflight-rejected",
  "native-collaboration-modes-unavailable",
  "native-session-unconfirmed",
  "recovery-required",
  "request-interrupted",
  "session-already-managed",
  "session-busy",
  "session-not-running",
  "session-runner-unavailable",
  "session-workspace-mismatch",
  "unverified-session-identity",
]);

function fixedReason(value: unknown): string | undefined {
  return typeof value === "string" && fixedReasons.has(value) ? value : undefined;
}

export function codexControlReason(error: unknown): string {
  return (
    fixedReason(error instanceof Error ? error.message : error) ?? REMOTE_ERROR_CODES.requestFailed
  );
}

/** Keep the binding and phase intact when publishing a previously stored rejection. */
export function projectCodexControlAck(
  ack: Record<string, unknown>,
  executionMode: unknown,
): Record<string, unknown> {
  if (executionMode !== "codex-managed" || ack.accepted !== false) return ack;
  const hasReason = typeof ack.reason === "string";
  const hasError = typeof ack.error === "string";
  const reason =
    fixedReason(ack.reason) ??
    fixedReason(ack.error) ??
    (ack.controlOutcome === REMOTE_CONTROL_OUTCOMES.unknown
      ? REMOTE_ERROR_CODES.controlOutcomeUnconfirmed
      : REMOTE_ERROR_CODES.requestFailed);
  if (!hasReason && !hasError) return ack;
  return {
    ...ack,
    ...(hasReason ? { reason } : {}),
    ...(hasError ? { error: fixedReason(ack.error) ?? reason } : {}),
  };
}
