import { CLAUDE_COMMAND_REFUSALS, DSH_COMMAND_REFUSALS } from "@agentkib/runtime-protocol";

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
      "follower-operation-unverified",
      // The executor refused an image: its model takes none, or the image is outside its limits.
      "model-images-unsupported",
      "attachment-invalid",
      // The attachment file no longer held the checked bytes when the executor read it.
      "attachment-changed",
      "attachment-unavailable",
      "dsh-attachments-unavailable",
      // DeepSeek Harness: a slash command it did not take or did not finish, and goal changes it
      // refused because the goal changed meanwhile or allows no such change now.
      ...DSH_COMMAND_REFUSALS,
      "dsh-command-unavailable",
      "dsh-command-failed",
      // Starting DeepSeek Harness in the background failed, or another DSH holds the session.
      "dsh-start-failed",
      "dsh-version-unsupported",
      "dsh-launcher-unavailable",
      "dsh-exited",
      "dsh-session-in-use",
      "goal-changed",
      "goal-action-unavailable",
      "goal-rounds-exhausted",
      "goal-token-budget-unavailable",
    ]).has(reason)
    ? reason
    : fallback;
}
