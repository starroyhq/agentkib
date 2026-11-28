const requestReasons = new Set([
  "invalid-bridge-challenge",
  "expired-bridge-challenge",
  "bridge-version-mismatch",
  "bridge-cli-too-old",
  "bridge-cli-unsupported",
  "bridge-capabilities-missing",
  "bridge-plugin-update-required",
  "unsupported-native-identity",
  "native-identity-changed",
  "bridge-identity-mismatch",
  "control-outcome-unconfirmed",
  "claude-bridge-binding-limit",
  "bridge-auto-unavailable",
  "bridge-auto-disabled",
  "bridge-auto-declined",
]);

export function publicClaudeBridgeRequestError(error: unknown) {
  return error instanceof Error && requestReasons.has(error.message)
    ? error.message
    : "bridge-request-rejected";
}

/** Keep the original error for plugins that only understand the old reply. */
export function claudeBridgeManagedRefusal(error: unknown) {
  return error instanceof Error && error.message === "session-already-managed"
    ? "session-already-managed"
    : undefined;
}
