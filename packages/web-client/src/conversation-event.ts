import type {
  ConversationQuestionnaire,
  ConversationToolDetail,
  ConversationTurnMeta,
  WorkerReportView,
} from "@agentkib/runtime-protocol";

export interface ConversationImage {
  id: string;
  mimeType?: string;
  name?: string;
}
export interface ConversationImageData {
  mimeType: string;
  base64: string;
}
export interface ConversationEvent {
  id: string;
  /** Native protocols without item identity may expose a temporary live overlay. */
  ephemeral?: boolean;
  kind: "user-message" | "agent-message" | "tool-summary";
  turn_id?: string | null;
  message_phase?: "commentary" | "final_answer" | null;
  timestamp?: string;
  content?: string;
  tool_name?: string;
  tool_status?: string;
  duration_ms?: number | null;
  attachment_count: number;
  /** Original message images are read separately, never embedded in event pages. */
  images?: ConversationImage[];
  truncated: boolean;
  /** Absent on older hosts; clients then show the tool name and status. */
  tool?: ConversationToolDetail;
  /** Read-only history, independent of any live answer controls. */
  questionnaire?: ConversationQuestionnaire;
  /** Structured display fields for a recorded Worker report delivery. */
  worker_reports?: WorkerReportView;
  turn_meta?: ConversationTurnMeta;
  /**
   * Text the CLI wrote itself (a Claude Code local command's output, an API or failed-turn error
   * from Claude Code or Codex), shown with its line breaks and `<name>` placeholders as written.
   * Absent on older hosts.
   */
  cli_output?: boolean;
}
export interface ConversationEventPage {
  events: ConversationEvent[];
  next_cursor?: string;
  warnings: string[];
}
