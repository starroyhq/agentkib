import type { ConversationTurnMeta } from "@agentkib/runtime-protocol";

/** The terminal status reported by a Codex native turn. */
export function codexTurnMeta(turn: Record<string, unknown>): ConversationTurnMeta | undefined {
  const outcome =
    turn.status === "completed"
      ? turn.error != null
        ? "failed"
        : "completed"
      : turn.status === "interrupted"
        ? "aborted"
        : turn.status === "failed"
          ? "failed"
          : undefined;
  if (!outcome) return undefined;
  const duration = turn.durationMs;
  return {
    outcome,
    ...(typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0
      ? { duration_ms: duration }
      : {}),
  };
}

/** An explicit end whose producer has no suitable conversation item to carry the status. */
export function codexTurnEndEvent(
  turnId: string,
  meta: ConversationTurnMeta,
  timestamp: string | null,
) {
  return {
    id: `codex-turn-end:${turnId}`,
    kind: "agent-message" as const,
    turn_id: turnId,
    timestamp,
    content: null,
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
    turn_meta: meta,
  };
}

export function isCodexTurnEndEvent(item: Record<string, unknown>): boolean {
  return typeof item.turn_id === "string" && item.id === `codex-turn-end:${item.turn_id}`;
}
