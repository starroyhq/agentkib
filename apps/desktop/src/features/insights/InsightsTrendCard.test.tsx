// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { HeatmapPoint } from "@/core/types";
import { TokenTrendCard } from "./InsightsComponents";

const point = (date: string, tokens: number): HeatmapPoint => ({
  date,
  tokens,
  my_commits: 0,
  all_commits: 0,
  attributed_commits: 0,
  sessions: 0,
  quality: "exact",
});
describe("Insights trend details", () => {
  beforeEach(() => initializeI18n("en-US"));
  afterEach(cleanup);
  it("exposes exact daily values on hover and keyboard focus without permanent dots", () => {
    const { container } = render(
      <TokenTrendCard
        points={[point("2026-11-01", 0), point("2026-11-02", 100), point("2026-11-03", 20)]}
        metric="tokens"
        metricLabel="Token"
        granularity="day"
      />,
    );
    expect(container.querySelector('path[stroke-width="2.25"]')?.getAttribute("d")).toContain(
      " C ",
    );
    expect(container.querySelector('path[stroke-width="2.25"]')).toBeTruthy();
    const first = screen.getByRole("img", { name: "Nov 1, 2026, Token: 0" });
    const second = screen.getByRole("img", { name: "Nov 2, 2026, Token: 100" });
    expect(container.querySelectorAll('circle[style="opacity: 0;"]')).toHaveLength(3);
    fireEvent.mouseEnter(second);
    expect(screen.getByRole("tooltip").textContent).toBe("Nov 2, 2026, Token: 100");
    fireEvent.focus(first);
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(second);
    expect(screen.getByRole("tooltip").textContent).toContain("100");
    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Nov 3, 2026, Token: 20");
    fireEvent.blur(document.activeElement!);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
  it("keeps missing dates disconnected and allows daily detail from weekly aggregation", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <TokenTrendCard
        points={[point("2026-11-01", 10), point("2026-11-03", 30), point("2026-11-04", 40)]}
        metric="tokens"
        metricLabel="Token"
        granularity="week"
      />,
    );
    await user.click(screen.getByRole("combobox", { name: tr("insights.trendGranularity") }));
    await user.click(await screen.findByRole("option", { name: tr("insights.byDay") }));
    const path = container.querySelector('path[stroke-width="2.25"]')!.getAttribute("d")!;
    expect(path.match(/M /g)).toHaveLength(2);
    expect(screen.queryByRole("img", { name: "Nov 2, 2026, Token: 0" })).toBeNull();
    expect(screen.getByRole("img", { name: "Nov 3, 2026, Token: 30" })).toBeTruthy();
  });
});
