import type { ManagedAgent } from "./agents";

export interface ApprovalRuleCapability {
  list: boolean;
  revoke: boolean;
}

export interface ApprovalRule {
  /** Opaque identity from the host, bound to its rule source and content. */
  id: string;
  agent: ManagedAgent;
  scope: "global" | "project" | "session";
  source: string;
  content: string;
  revocable: boolean;
  lastUsedAt?: string;
}

export interface ApprovalRuleList {
  providers: Record<ManagedAgent, ApprovalRuleCapability>;
  rules: ApprovalRule[];
}

export type SessionApprovalAuditOutcome = "executed" | "denied" | "expired" | "unknown";

export interface SessionApprovalAuditRisk {
  level: "high" | "file-modification" | "low";
  reason: string;
}

export interface SessionApprovalAuditDecision {
  kind: "allow" | "deny" | "cancel" | "answer" | "native";
  scope: "once" | "session" | "persistent" | "unknown";
}

export interface SessionApprovalAuditSource {
  kind: "desktop" | "web" | "phone" | "project-agent";
  deviceId?: string;
  deviceName?: string;
}

/** Authenticated host metadata, separate from native control input and receipt fingerprints. */
export interface SessionApprovalAuditContext {
  source: SessionApprovalAuditSource;
  risk?: SessionApprovalAuditRisk;
  decision?: SessionApprovalAuditDecision;
}

export interface SessionApprovalAuditEntry {
  id: string;
  sessionId: string;
  agent: ManagedAgent;
  workspaceId?: string;
  kind: "approval" | "question";
  summary: string;
  risk: SessionApprovalAuditRisk;
  decision: SessionApprovalAuditDecision;
  source: SessionApprovalAuditSource;
  time: string;
  result: SessionApprovalAuditOutcome;
}

export interface SessionApprovalAuditPage {
  entries: SessionApprovalAuditEntry[];
  nextCursor?: string;
}
