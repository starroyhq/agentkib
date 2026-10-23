import { describe, expect, it } from "vitest";
import type { ContextDoctorSummary, MemoryRecord } from "@/core/types";
import { getWorkspaceStatus } from "./workspace-status";

const summary: ContextDoctorSummary = {
  workspace_id: "workspace",
  error_count: 1,
  warning_count: 2,
  info_count: 8,
  repairable_count: 1,
  checked_at: "2026-10-23T00:00:00Z",
};
const memory = (project_id: string, status = "pending") => ({ project_id, status }) as MemoryRecord;

describe("workspace display status", () => {
  it("counts errors, warnings and this workspace's pending memories once", () => {
    expect(
      getWorkspaceStatus("workspace", summary, [
        memory("workspace"),
        memory("elsewhere"),
        memory("workspace", "approved"),
      ]),
    ).toEqual({
      state: "attention",
      issueCount: 4,
      diagnosticIssueCount: 3,
      pendingMemoryCount: 1,
    });
  });
  it("keeps a missing or failed diagnosis neutral", () => {
    expect(getWorkspaceStatus("workspace").state).toBe("undiagnosed");
    expect(getWorkspaceStatus("other-workspace", summary).state).toBe("undiagnosed");
  });
  it("can surface known pending memories while a diagnosis is unavailable", () => {
    expect(getWorkspaceStatus("workspace", undefined, [memory("workspace")])).toMatchObject({
      state: "attention",
      issueCount: 1,
    });
  });
  it("treats information-only results as healthy", () => {
    expect(
      getWorkspaceStatus("workspace", { ...summary, error_count: 0, warning_count: 0 }),
    ).toMatchObject({
      state: "healthy",
      issueCount: 0,
    });
  });
});
