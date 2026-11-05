// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import { LocalCostPanel } from "./LocalCostPanel";
import { localCostFixture } from "./__fixtures__/local-cost";
import type { LocalCostsQuery } from "./local-cost-query";

function costsFixture(): LocalCostsQuery {
  return {
    snapshot: localCostFixture(),
    status: { provider: "codex", scope_key: "scope-codex", state: "running" },
    loading: false,
    busy: true,
    error: null,
    refresh: vi.fn().mockResolvedValue(null),
  };
}

describe("local usage estimate panel", () => {
  beforeEach(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("keeps cached estimates visible during scans and distinguishes unknown amounts from genuine zero", () => {
    render(<LocalCostPanel costs={costsFixture()} />);
    expect(screen.getByText(tr("quota.cost.state.running"))).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/USD\s*1\.25/).length).toBeGreaterThan(0);
    expect(screen.getByText(tr("quota.cost.timezone", { timezone: "Asia/Shanghai" }))).toBeTruthy();
    expect(screen.getByText(tr("quota.cost.historyIncomplete"))).toBeTruthy();
    expect(screen.getAllByText(tr("quota.cost.partial")).length).toBeGreaterThan(0);
    expect(screen.getByText(tr("quota.cost.explanation"))).toBeTruthy();

    const trend = screen.getByRole("group", { name: /Daily usage from/ });
    const days = within(trend).getAllByRole("img");
    expect(days).toHaveLength(2);
    expect(days[0].getAttribute("aria-label")).toMatch(/2026-11-03: USD\s*0\.00, 0 tokens/);
    expect(days[1].getAttribute("aria-label")).toContain("2026-11-05: —, 42 tokens");
    expect(days.every((day) => day.getAttribute("tabindex") === "0")).toBe(true);
    // No fabricated zero for the missing November 4 bucket.
    expect(within(trend).queryByRole("img", { name: /2026-11-04:/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: tr("quota.cost.metric.tokens") }));
    expect(
      screen
        .getByRole("button", { name: tr("quota.cost.metric.tokens") })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(within(trend).getAllByRole("img")).toHaveLength(2);
  });

  it("shows failures alongside the last successful aggregates and allows an independent retry", async () => {
    const costs = costsFixture();
    costs.busy = false;
    costs.status = {
      provider: "codex",
      scope_key: "scope-codex",
      state: "failed",
      error_key: "errors.localCostsUnavailable",
    };
    render(<LocalCostPanel costs={costs} />);
    expect(screen.getByRole("alert").textContent).toContain(tr("quota.cost.refreshFailed"));
    expect(screen.getAllByText(/USD\s*1\.25/).length).toBeGreaterThan(0);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: tr("quota.cost.refresh") })),
    );
    expect(costs.refresh).toHaveBeenCalledTimes(1);
  });

  it("labels the previous 30-day cache while today's estimate is awaiting a new local-day scan", () => {
    const costs = costsFixture();
    costs.snapshot = {
      ...localCostFixture(),
      today: { date: "2026-11-06", cost_usd: null, tokens: null, partial: false, models: [] },
    };
    render(<LocalCostPanel costs={costs} />);
    expect(screen.getByText(tr("quota.cost.previousPeriod", { date: "2026-11-05" }))).toBeTruthy();
    expect(screen.getAllByText("—").length).toBeGreaterThan(1);
  });

  it.each(["en-US", "zh-CN", "zh-TW", "ja-JP"] as const)(
    "localizes all cost content in %s",
    async (locale) => {
      await initializeI18n(locale);
      render(<LocalCostPanel costs={costsFixture()} />);
      expect(screen.getByRole("heading", { name: tr("quota.cost.title") })).toBeTruthy();
      expect(screen.getByRole("button", { name: tr("quota.cost.refresh") })).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/quota\.cost\.|errors\.localCosts/);
      fireEvent.click(screen.getByRole("button", { name: tr("quota.cost.models") }));
      expect(
        screen.getByRole("button", { name: tr("quota.cost.models") }).getAttribute("aria-expanded"),
      ).toBe("true");
      expect(document.querySelector("table")).toBeTruthy();
    },
  );
});
