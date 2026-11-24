export type SessionInteractionRiskReason =
  | "deletion"
  | "network"
  | "dependency-install"
  | "outside-workspace"
  | "git-push"
  | "unknown-operation"
  | "unknown-workspace"
  | "workspace-write"
  | "read-only"
  | "test"
  | "static-check"
  | "question";

export interface SessionInteractionRisk {
  level: "high" | "file-modification" | "low";
  reason: SessionInteractionRiskReason;
}

export interface SessionInteractionDecision {
  /** Only valid for this interaction binding. */
  id: string;
  kind: "allow" | "deny" | "cancel" | "answer";
  scope: "once" | "session" | "persistent";
  verification: "none" | "confirmation" | "device-user-verification";
  lockScreen: boolean;
  available: boolean;
  reason?: "verification-unavailable";
}

export interface SessionInteractionQuestion {
  id: string;
  header?: string;
  question: string;
  options: { label: string; description?: string }[];
  isSecret?: boolean;
  secret?: boolean;
  multiSelect: boolean;
  allowCustom: boolean;
}

export interface SessionPendingInteraction {
  version: 1;
  kind: "approval" | "question";
  binding: {
    sessionId: string;
    runtimeBootId: string;
    turnId: string;
    /** Native request identity, separate from the UUID of the submission receipt. */
    requestId: string | number;
    revision: number;
  };
  /** Verbatim, untrusted agent text. Absent if the agent gave no explanation. */
  summary?: string;
  toolName?: string;
  command?: string | readonly string[];
  cwd?: string;
  parameters?: unknown;
  risk: SessionInteractionRisk;
  decisions: SessionInteractionDecision[];
  questions?: SessionInteractionQuestion[];
}
