import type { ContextDoctorSummary, MemoryRecord } from "@/core/types";

export type WorkspaceDisplayState = "healthy" | "attention" | "undiagnosed";

/** Use the same actionable items in every workspace status; info findings are not tasks. */
export function getWorkspaceStatus(
  workspaceId: string,
  summary?: ContextDoctorSummary,
  memories: MemoryRecord[] = [],
) {
  const currentSummary = summary?.workspace_id === workspaceId ? summary : undefined;
  const diagnosticIssueCount = currentSummary
    ? currentSummary.error_count + currentSummary.warning_count
    : 0;
  const pendingMemoryCount = memories.filter(
    (memory) => memory.project_id === workspaceId && memory.status === "pending",
  ).length;
  const issueCount = diagnosticIssueCount + pendingMemoryCount;
  const state: WorkspaceDisplayState =
    issueCount > 0 ? "attention" : currentSummary ? "healthy" : "undiagnosed";
  return { state, issueCount, diagnosticIssueCount, pendingMemoryCount };
}
