import type { SessionQuestionOption } from "./generated/remote-contract";

/**
 * Typed details for a conversation `tool-summary` item.
 *
 * The shape follows the ACP ToolCall (kind, title, locations, content). It
 * carries bounded, redacted previews instead of raw tool input and output: a
 * diff gives line counts plus a shortened unified diff, and a command gives
 * its output tail. Every field is optional on the wire. Older hosts omit
 * `tool` entirely and clients then show the tool name and status as before.
 */
export const CONVERSATION_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;
export type ConversationToolKind = (typeof CONVERSATION_TOOL_KINDS)[number];

export type ConversationAgentAction =
  | "spawn"
  | "message"
  | "wait"
  | "interrupt"
  | "complete"
  | "other";

/** A display path: relative inside the workspace, `~/…` under the home directory. */
export interface ConversationToolLocation {
  path: string;
  line?: number;
}

export type ConversationToolContent =
  | {
      type: "text";
      /** What the text shows; clients may label it. */
      label?: "input" | "output";
      text: string;
      truncated?: boolean;
    }
  | {
      type: "terminal";
      command?: string;
      /** The end of the output, which usually holds the result or the error. */
      output?: string;
      exit_code?: number | null;
      truncated?: boolean;
    }
  | {
      type: "diff";
      path: string;
      change: "add" | "update" | "delete" | "move";
      move_path?: string;
      /** Counted before redaction and before the preview was shortened. */
      added: number;
      removed: number;
      /** Unified diff lines (`+`, `-`, ` `, `@@`), bounded and redacted. */
      preview?: string;
      truncated?: boolean;
    };

export interface ConversationToolDetail {
  kind: ConversationToolKind;
  /** One readable line: a command, a path, a query or `server · tool`. */
  title?: string;
  locations?: ConversationToolLocation[];
  /** Clients ignore entries whose `type` they do not know. */
  content?: ConversationToolContent[];
  /**
   * Native items recorded inside this call. A wrapper call (Codex code mode
   * `exec`) is then shown through those items instead of its own row.
   */
  children?: number;
  mcp?: { server: string; tool: string };
  agent?: { action: ConversationAgentAction; name?: string };
  /** Some previews were removed to keep the item within its size budget. */
  truncated?: boolean;
}

/** A read-only record of a questionnaire in a conversation. */
export interface ConversationQuestionnaire {
  status: "pending" | "answered" | "closed";
  questions: {
    id: string;
    question: string;
    header?: string;
    multiSelect: boolean;
    options: SessionQuestionOption[];
    answer?: { selected: string[]; custom?: string; preview?: string; notes?: string };
  }[];
  /** Which answer received the event's separately loaded images, if known. */
  imageQuestionId?: string;
}

/** Evidence from the provider's tool records for a single ended turn. */
export interface ConversationTurnSummary {
  /** Workspace paths and sums from observed successful edits, not a net working-tree diff. */
  files?: { path: string; added?: number; removed?: number }[];
  /** Each entry is an observed run. A repeated check can have different results. */
  checks?: {
    name: string;
    status: "passed" | "failed" | "unknown";
    exit_code?: number;
  }[];
  /** True when records or statistics were missing, omitted or reached a projection limit. */
  partial?: true;
}

/** Carried by the last item of a turn; clients read it from any item of that turn. */
export interface ConversationTurnMeta {
  duration_ms?: number;
  outcome?: "completed" | "aborted" | "failed";
  summary?: ConversationTurnSummary;
}
