export type SessionPlanStepStatus = "pending" | "in_progress" | "completed";

export interface SessionPlanStep {
  /** Opaque identity within the plan. Sources without native IDs use reported order. */
  id: string;
  text: string;
  status: SessionPlanStepStatus;
}

export interface SessionPlanProgress {
  turnId: string;
  steps: SessionPlanStep[];
  /** Reported in-progress step, when only one can be identified. */
  currentStepId: string | null;
  /** Some steps or text were omitted to bound the projection. */
  truncated?: true;
}
