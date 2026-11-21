/**
 * A failed Codex turn ends with the CLI's own error text. The app-server reports it as the
 * turn's `error` (`TurnError {message, additionalDetails}`) and the rollout keeps it in
 * `task_complete.error {message}`; both become the same conversation row.
 */

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The message, then the detail when that adds anything. */
export function codexErrorText(error: unknown): string | null {
  if (!isObject(error)) return null;
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const raw = error.additionalDetails ?? error.additional_details;
  const detail = typeof raw === "string" ? raw.trim() : "";
  const text =
    detail && detail !== message ? (message ? `${message}\n${detail}` : detail) : message;
  return text || null;
}

/** The row for a failed turn, the last of that turn. */
export function codexTurnErrorEvent(turnId: string, text: string, timestamp: string | null) {
  const characters = [...text];
  return {
    id: `codex-turn-error:${turnId}`,
    kind: "agent-message" as const,
    turn_id: turnId,
    timestamp,
    content: characters.slice(0, 32768).join(""),
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: characters.length > 32768,
    // Codex wrote this text, not the model; clients show it as written.
    cli_output: true as const,
  };
}
