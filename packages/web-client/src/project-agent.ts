import type {
  REMOTE_WORKER_ROLE_CONTRACT,
  WorkerRole,
  WorkerRoleChange,
  WorkerRoleInput,
} from "@agentkib/runtime-protocol";

/** What a Project Agent may use and decide for its workers (docs/agents/project-agent.md). */
export interface ProjectAgentScope {
  workspaceIds: string[];
  policies: string[];
  maxLanes: number;
  maxAutoTurns: number;
  /** Stall threshold in minutes. Hosts with supervision default it to 10. */
  stallMinutes?: number;
  /** "file-change" and "command": approvals it may decide; absent on older hosts. */
  approvals?: string[];
  answers?: boolean;
}

export interface ManageProjectAgentInput {
  sessionId: string;
  operation:
    | "designate"
    | "update"
    | "pause"
    | "resume"
    | "release"
    | "remove-worker"
    | "stop-worker"
    | typeof REMOTE_WORKER_ROLE_CONTRACT.operation;
  scope?: Partial<ProjectAgentScope>;
  worker?: string;
  /** Required for worker-role; null clears the role. */
  role?: WorkerRoleInput | null;
}

export interface WorkerModelSettings {
  model: { id: string; label: string } | null;
  reasoningEffort: string | null;
  speed: { id: string | null; label?: string } | null;
  editable: boolean;
  reason?: string;
}

export interface ProjectAgentState {
  sessionId: string;
  paused: boolean;
  /** The host will resume delegation once recovery completes. */
  recovering?: true;
  reason: string | null;
  scope: ProjectAgentScope;
  pendingReports: number;
  /** Worker role edits, oldest first. Absent on hosts without role editing. */
  roleChanges?: WorkerRoleChange[];
  workers: Array<{
    name: string;
    sessionId: string;
    status: string;
    /** Whether a turn runs that the person can stop from the panel; absent on older hosts. */
    stopEnabled?: boolean;
    title: string | null;
    role?: WorkerRole;
    lastReportAt: string | null;
    /** The host's current Worker model settings, when available. */
    settings?: WorkerModelSettings;
  }>;
}
