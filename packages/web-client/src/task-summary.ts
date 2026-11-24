export type ConversationTaskKind =
  | "pendingApproval"
  | "pendingAnswer"
  | "running"
  | "needsReview"
  | "failed"
  | "completed";

export interface ConversationTaskEntry {
  sessionId: string;
  agent: string;
  workspaceId: string;
  /** When the task started or ended, or the session's last observed update. */
  time: string | null;
  summary: string;
  place?: "agentkib" | "terminal" | "external";
  outcome?: "completed" | "failed";
}

export type ConversationTaskSourceReason =
  | "source-unavailable"
  | "source-partial"
  | "not-scanned"
  | "refreshing"
  | "classification-pending"
  | "index-disabled"
  | "coverage-unknown"
  | "read-state-stale"
  | "antigravity-database-record"
  | "antigravity-summary-record"
  | "antigravity-trajectory-record"
  | "antigravity-database-source"
  | "antigravity-summary-source"
  | "antigravity-local-limit"
  | "antigravity-acp-list"
  | "antigravity-acp-record"
  | "antigravity-native-list";

export interface ConversationTaskSource {
  workspaceId: string;
  agent: string;
  complete: boolean;
  reasons?: ConversationTaskSourceReason[];
}

export interface ConversationTaskCoverage {
  complete: boolean;
  sources: ConversationTaskSource[];
  /** Gaps that cannot be attributed to a single authorized source. */
  reasons?: ConversationTaskSourceReason[];
}

export interface ConversationTaskSummary {
  /** Scoped snapshot version. Compare for equality within one authorized connection. */
  version: string;
  groups: Record<ConversationTaskKind, { count: number; entries: ConversationTaskEntry[] }>;
  coverage: ConversationTaskCoverage;
}

/** Optional fields on global session-ready and catalog-invalidated events. */
export interface ConversationTaskStreamFields {
  taskSummary?: ConversationTaskSummary;
  /** An oversized SSE snapshot can be read through GET /catalog?taskSummary=1. */
  taskSummaryVersion?: string;
}
