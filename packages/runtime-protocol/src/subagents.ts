/** Additive, read-only child projection. Child IDs have meaning only inside their parent. */
export type SubagentStatus =
  | "starting"
  | "running"
  | "waiting-input"
  | "waiting-approval"
  | "completed"
  | "failed"
  | "stopped"
  | "unknown";

export interface SubagentSummary {
  id: string;
  parentId?: string;
  name: string;
  agent: "codex" | "claude-code" | "deepseek-harness";
  status: SubagentStatus;
  updatedAt?: string;
  readable: boolean;
}

export interface SubagentCatalog {
  version: 1;
  sessionId: string;
  agents: SubagentSummary[];
  truncated: boolean;
  /** Observer updates only upsert these children; absence is not removal. */
  partial?: true;
}
