import {
  REMOTE_READ_STATE_UPDATE_CONTRACT,
  type ConversationReadStateMark,
} from "./generated/remote-contract";

/** Host-issued versions are opaque and must only be compared for equality. */
export interface ConversationReadState {
  source: "codex-native" | "agentkib";
  status: "read" | "unread" | "unknown";
  freshness: "current" | "stale";
  version: string | null;
  /** When proof is pending, use this version only for explicit marks. Otherwise, use version. */
  manualVersion?: string;
  /** Detail reads report whether the host can verify an automatic acknowledgement. */
  canAcknowledge?: boolean;
  firstUnread:
    | { type: "threadStart" }
    | { type: "result"; resultId: string; turnId: string | null }
    | null;
  latestResult: ConversationReadResult | null;
}

export interface ConversationReadResult {
  id: string;
  turnId: string | null;
  itemId: string | null;
  outcome: "completed" | "failed" | "cancelled" | "ended";
  completedAt: string | null;
}

export interface ConversationReadStateRequest {
  operation: "read-state";
  sessionId: string;
  /** Set by the host, never taken from a public request body. */
  readerScope: string;
}

export interface ConversationReadStateUpdate {
  operation: "read-state-update";
  sessionId: string;
  readerScope: string;
  expectedVersion: string;
  seenResultId: string | null;
  mark?: ConversationReadStateMark;
}

export function isConversationReadStateMark(value: unknown): value is ConversationReadStateMark {
  return REMOTE_READ_STATE_UPDATE_CONTRACT.properties.mark.enum.some((mark) => mark === value);
}
