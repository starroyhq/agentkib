import { REMOTE_CONVERSATION_EVENTS } from "@agentkib/runtime-protocol";
import type { ConversationEvent } from "./session-events";

/** A completed compaction is metadata only. Summary/replacement-history text stays private. */
export function compactionBoundaryEvent(
  id: string,
  timestamp: string | null,
  nativeTrigger?: unknown,
): ConversationEvent {
  const { kind, triggers } = REMOTE_CONVERSATION_EVENTS.compactionBoundary;
  return {
    id,
    kind,
    timestamp,
    compaction_trigger: triggers.find((trigger) => trigger === nativeTrigger) ?? "unknown",
    content: null,
    tool_name: null,
    tool_status: null,
    duration_ms: null,
    attachment_count: 0,
    truncated: false,
  };
}
