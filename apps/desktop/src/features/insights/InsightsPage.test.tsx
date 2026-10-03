// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { HeatmapPoint } from "@/core/types";
import { InsightsPage } from "./InsightsPage";

const state = vi.hoisted(() => ({
  view: {} as Record<string, unknown>,
  job: { data: undefined } as Record<string, unknown>,
  queries: [] as unknown[],
}));
vi.mock("./insights-query", () => ({
  useInsightsRefreshJob: () => state.job,
  useInsightsView: (query: unknown) => {
    state.queries.push(query);
    return state.view;
  },
}));

function point(date: string): HeatmapPoint {
  return {
    date,
    tokens: 1,
    my_commits: 0,
    all_commits: 0,
    attributed_commits: 0,
    sessions: 1,
    quality: "exact",
  };
}
function days(from: string, count: number) {
  const start = Date.parse(`${from}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    point(new Date(start + index * 86_400_000).toISOString().slice(0, 10)),
  );
}
const summary = {
  total_tokens: 1,
  my_commits: 0,
  all_commits: 0,
  session_count: 1,
  current_streak: 1,
  longest_streak: 1,
  active_days: 1,
  quality: "exact",
};
function heatmapGrid(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("div[style]")].find((element) =>
    element.className.includes("grid-rows-[repeat(7,11px)]"),
  )!;
}

describe("InsightsPage", () => {
  beforeEach(() => {
    initializeI18n("en-US");
    state.job = { data: undefined };
    state.queries = [];
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows the load error with a retry instead of an endless skeleton", () => {
    const refetch = vi.fn();
    state.view = { data: undefined, isError: true, error: new Error("boom"), refetch };
    render(<InsightsPage section="overview" workspaces={[]} />);
    expect(screen.getByRole("alert").textContent).toContain(tr("insights.loadFailed"));
    fireEvent.click(screen.getByRole("button", { name: tr("insights.retry") }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("marks placeholder data from the previous filters as loading", () => {
    state.view = {
      data: { summary, status: { running: false }, heatmap: days("2026-01-01", 7) },
      isPlaceholderData: true,
    };
    const { container, rerender } = render(<InsightsPage section="overview" workspaces={[]} />);
    expect(screen.getByRole("status").textContent).toBe(tr("insights.refreshing"));
    expect(container.firstElementChild!.getAttribute("aria-busy")).toBe("true");
    state.view = { ...state.view, isPlaceholderData: false };
    rerender(<InsightsPage section="overview" workspaces={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.firstElementChild!.hasAttribute("aria-busy")).toBe(false);
  });

  it("stops filtering by a workspace that was removed, matching the All label", async () => {
    state.view = { data: { summary, status: { running: false }, heatmap: [] } };
    const workspaces = [{ id: "w1", name: "Alpha" }] as never[];
    const { rerender } = render(<InsightsPage section="tokens" workspaces={workspaces} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: tr("insights.workspaceFilter") }));
    await user.click(await screen.findByRole("option", { name: "Alpha" }));
    expect(state.queries.at(-1)).toMatchObject({ workspace_id: "w1" });

    const before = state.queries.length;
    rerender(<InsightsPage section="tokens" workspaces={[]} />);
    // 移除后的第一次渲染就不能再带旧 id（不依赖 Select 组件自己把值重置回去）。
    for (const query of state.queries.slice(before))
      expect((query as { workspace_id?: string }).workspace_id).toBeUndefined();
    expect(
      screen.getByRole("combobox", { name: tr("insights.workspaceFilter") }).textContent,
    ).toContain(tr("workspace.all"));
  });

  it("moves the query range to the new day after midnight while the page stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 1, 23, 59, 30));
    state.view = { data: { summary, status: { running: false }, heatmap: [] } };
    render(<InsightsPage section="overview" workspaces={[]} />);
    expect(state.queries.at(-1)).toMatchObject({ to: "2026-03-01" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(state.queries.at(-1)).toMatchObject({ from: "2025-03-04", to: "2026-03-02" });
  });

  it("names filters by purpose and summarizes the heatmap and trend for screen readers", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 1, 12));
    const heatmap = days("2026-02-01", 3).map((value, index) => ({ ...value, tokens: index * 5 }));
    state.view = { data: { summary, status: { running: false }, heatmap } };
    render(<InsightsPage section="overview" workspaces={[]} />);
    for (const key of [
      "insights.agentFilter",
      "insights.workspaceFilter",
      "insights.repositoryFilter",
      "insights.range",
    ])
      expect(screen.getByRole("combobox", { name: tr(key) })).toBeTruthy();
    const map = screen.getByRole("img", { name: /Mar 1, 2026/ });
    expect(map.getAttribute("aria-label")).toBe(
      "Token, Mar 3, 2025 to Mar 1, 2026: 2 active days, peak 10",
    );
    expect(screen.getByRole("img", { name: /Token Trend: Feb 15/ })).toBeTruthy();
  });

  it("lays out the whole calendar year, even while last year's 52-week data is a placeholder", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 2, 1, 12));
    // 占位数据仍是旧范围（从 2025 年开始），年份必须取自新请求。
    state.view = {
      data: { summary, status: { running: false }, heatmap: days("2025-03-03", 364) },
      isPlaceholderData: true,
    };
    const { container } = render(<InsightsPage section="overview" workspaces={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: tr("insights.range") }));
    await user.click(await screen.findByRole("option", { name: tr("insights.rangeYear") }));
    expect(state.queries.at(-1)).toMatchObject({ from: "2026-01-01", to: "2026-03-01" });
    // 2026-01-01 是周四：前面补 3 格，(3 + 365) / 7 → 53 列。
    state.view = {
      data: { summary, status: { running: false }, heatmap: days("2026-01-01", 60) },
    };
    fireEvent.click(screen.getByRole("tab", { name: tr("common.sessions") }));
    expect(heatmapGrid(container).style.gridTemplateColumns).toBe(
      "repeat(53, var(--heatmap-cell-size))",
    );
    expect(heatmapGrid(container).querySelectorAll('[aria-hidden="true"]')).toHaveLength(365 - 60);
  });
});
