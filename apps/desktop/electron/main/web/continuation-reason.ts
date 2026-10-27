import { CLAUDE_COMMAND_REFUSALS } from "@agentkib/runtime-protocol";

/** Only these owner diagnostics may cross the host boundary as public reasons. */
export function continuationPreflightReason(
  reason: unknown,
  fallback = "control_preflight_rejected",
): string {
  return typeof reason === "string" &&
    new Set<string>([
      // A slash command AgentKib did not send; clients explain each one.
      ...CLAUDE_COMMAND_REFUSALS,
      "session-compacting",
      "codex-owner-busy",
      "codex-cli-version-too-old",
      "codex-cli-unavailable",
      "codex-cli-version-unavailable",
      "codex-owner-check-unavailable",
      "unsupported-codex-cli-version",
      "unsupported-model",
      "unsupported-effort",
      "native-model-unconfirmed",
      "native-effort-unconfirmed",
      "claude-owner-busy",
      "claude-background-session-running",
      "claude-owner-check-unavailable",
      "owner-opened-elsewhere",
      "claude-cli-unavailable",
      "platform-unsupported",
    ]).has(reason)
    ? reason
    : fallback;
}
