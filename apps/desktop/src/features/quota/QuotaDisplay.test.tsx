// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n, tr } from "@/core/i18n";
import type { QuotaSnapshot } from "@/core/types";
import { QuotaWindowRow } from "./QuotaDisplay";
import type { QuotaDisplayWindow } from "./quota";

const now = Date.parse("2026-10-09T02:00:00Z");
const item = (resetOffset: number): QuotaDisplayWindow => ({
  key: "codex-weekly",
  providerId: "codex",
  providerName: "Codex",
  selector: { provider_id: "codex", kind: "weekly", label: "Weekly" },
  window: {
    kind: "weekly",
    label: "Weekly",
    remaining_percent: 13,
    used_percent: 87,
    reset_at: new Date(now + resetOffset).toISOString(),
  },
});
const snapshot = (freshness: QuotaSnapshot["freshness"] = "fresh"): QuotaSnapshot => ({
  schema_version: 1,
  backend: "codex-bar-cli",
  generated_at: new Date(now).toISOString(),
  fetched_at: new Date(now).toISOString(),
  stale_after_seconds: 300,
  freshness,
  providers: [],
});

describe("quota reset labels", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    await initializeI18n("en-US");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each([-29 * 86_400_000, 0])("does not show a future reset for offset %i", (offset) => {
    render(<QuotaWindowRow item={item(offset)} snapshot={snapshot()} />);
    expect(screen.getByText(tr("quota.resetElapsed"))).toBeTruthy();
    expect(screen.queryByText("Resets in 1 min")).toBeNull();
  });

  it("shows a future reset, then updates at the deadline without another query", () => {
    render(<QuotaWindowRow item={item(1_500)} snapshot={snapshot()} />);
    expect(screen.getByText("Resets in 1 min")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.getByText(tr("quota.resetElapsed"))).toBeTruthy();
  });

  it("does not give a live countdown from a stale cached snapshot", () => {
    render(<QuotaWindowRow item={item(7 * 86_400_000)} snapshot={snapshot("stale")} />);
    expect(screen.getByText(tr("quota.staleReset"))).toBeTruthy();
    expect(screen.queryByText("Resets in 7 days")).toBeNull();
  });

  it("stops the countdown when a mounted snapshot ages out", () => {
    render(<QuotaWindowRow item={item(3_600_000)} snapshot={snapshot()} />);
    expect(screen.getByText("Resets in 1 hr")).toBeTruthy();
    act(() => vi.advanceTimersByTime(300_000));
    expect(screen.getByText(tr("quota.staleReset"))).toBeTruthy();
  });

  it("treats a missing or invalid reset as unknown", () => {
    const invalid = item(0);
    invalid.window.reset_at = "not-a-date";
    const view = render(<QuotaWindowRow item={invalid} />);
    expect(screen.getByText(tr("quota.noReset"))).toBeTruthy();
    view.rerender(
      <QuotaWindowRow item={{ ...invalid, window: { ...invalid.window, reset_at: undefined } }} />,
    );
    expect(screen.getByText(tr("quota.noReset"))).toBeTruthy();
  });

  it("does not display unknown Windows placeholder values as real quota", () => {
    const unknown = item(3_600_000);
    unknown.window = {
      ...unknown.window,
      usage_known: false,
      used_percent: 0,
      remaining_percent: 100,
    };
    render(<QuotaWindowRow item={unknown} snapshot={snapshot()} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("100%")).toBeNull();
  });
});
