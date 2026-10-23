// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { ContextDoctorSummary, MemoryRecord, WorkspaceSummary } from "@/core/types";
import { RecentWorkspacesCard } from "./HomeRecentSections";

const workspace: WorkspaceSummary = {
  id: "healthy",
  name: "Healthy",
  path: "/fixture/healthy",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
};
const summary: ContextDoctorSummary = {
  workspace_id: workspace.id,
  error_count: 0,
  warning_count: 0,
  info_count: 0,
  repairable_count: 0,
  checked_at: "2026-10-23T00:00:00Z",
};

function renderCard(
  workspaces = [workspace],
  doctorSummaries = { [workspace.id]: summary },
  memories: MemoryRecord[] = [],
) {
  const onOpen = vi.fn().mockResolvedValue(undefined);
  const onAddWorkspace = vi.fn().mockResolvedValue(undefined);
  const onAddRoot = vi.fn().mockResolvedValue(undefined);
  render(
    <RecentWorkspacesCard
      workspaces={workspaces}
      doctorSummaries={doctorSummaries}
      memories={memories}
      assetCounts={new Map()}
      onOpen={onOpen}
      onShowWorkspaces={vi.fn()}
      onAddWorkspace={onAddWorkspace}
      onAddRoot={onAddRoot}
    />,
  );
  return { onOpen, onAddWorkspace, onAddRoot };
}

describe("RecentWorkspacesCard", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("prioritizes workspaces with diagnostic issues over recent healthy workspaces", () => {
    const attention = { ...workspace, id: "attention", name: "Attention" };
    const { onOpen } = renderCard(
      [{ ...workspace, last_active_at: "2026-10-23T01:00:00Z" }, attention],
      { healthy: summary, attention: { ...summary, workspace_id: attention.id, warning_count: 2 } },
    );
    const rows = screen
      .getAllByRole("button")
      .filter((button) => button.textContent?.includes("assets"));
    expect(rows[0]).toHaveTextContent("Attention");
    expect(rows[0]).toHaveTextContent(tr("workspace.status.attention", { count: 2 }));
    expect(rows[1]).toHaveTextContent(tr("workspace.status.healthy"));
    fireEvent.click(rows[0]!);
    expect(onOpen).toHaveBeenCalledWith(attention);
  });

  it("includes pending memories in workspace attention without relying on the old status", () => {
    renderCard([workspace], { healthy: summary }, [
      { project_id: workspace.id, status: "pending" },
    ] as MemoryRecord[]);
    expect(screen.getByText(tr("workspace.status.attention", { count: 1 }))).toHaveClass(
      "text-warning",
    );
  });

  it("shows unchecked neutrally when no diagnostic summary is available", () => {
    renderCard([{ ...workspace, status: "attention", warning_count: 4 }], {});
    expect(screen.getByText(tr("workspace.status.undiagnosed"))).toHaveClass(
      "text-muted-foreground",
    );
    expect(screen.queryByText(tr("workspace.status.attention", { count: 4 }))).toBeNull();
  });

  it("keeps both add actions secondary and separate", () => {
    const { onAddWorkspace, onAddRoot } = renderCard();
    const addWorkspace = screen.getByRole("button", { name: tr("home.addWorkspace") });
    const addRoot = screen.getByRole("button", { name: tr("home.addScanRoot") });
    expect(addWorkspace).toHaveClass("border-border");
    expect(addRoot).toHaveClass("border-border");
    fireEvent.click(addWorkspace);
    expect(onAddWorkspace).toHaveBeenCalledTimes(1);
    expect(onAddRoot).not.toHaveBeenCalled();
    fireEvent.click(addRoot);
    expect(onAddRoot).toHaveBeenCalledTimes(1);
  });
});
