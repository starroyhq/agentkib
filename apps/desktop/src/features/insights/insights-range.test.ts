// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dateSpan,
  insightsDates,
  INSIGHTS_RANGE_STORAGE_KEY,
  localDate,
  readInsightsRange,
  saveInsightsRange,
  validCustomDates,
} from "./insights-range";

const today = "2026-11-10";
const fallback = {
  range: "30d",
  custom: { from: "2026-10-12", to: today },
};

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("insight calendar ranges", () => {
  it.each([
    ["7d", "2026-11-04", 7],
    ["30d", "2026-10-12", 30],
    ["90d", "2026-08-13", 90],
    ["52w", "2025-11-12", 364],
  ] as const)("includes today in %s", (range, from, count) => {
    const dates = insightsDates(range, today);
    expect(dates).toEqual({ from, to: today });
    expect(dateSpan(dates)).toBe(count);
  });

  it("starts the year at January 1 and includes leap day", () => {
    expect(insightsDates("year", "2024-02-29")).toEqual({
      from: "2024-01-01",
      to: "2024-02-29",
    });
    expect(dateSpan(insightsDates("year", "2024-12-31"))).toBe(366);
    expect(dateSpan(insightsDates("year", "2026-01-01"))).toBe(1);
  });

  it("crosses leap days and year boundaries without shifting calendar dates", () => {
    expect(insightsDates("30d", "2024-02-29")).toEqual({
      from: "2024-01-31",
      to: "2024-02-29",
    });
    expect(insightsDates("7d", "2026-01-03")).toEqual({
      from: "2025-12-28",
      to: "2026-01-03",
    });
  });

  it.each([
    ["2026-03-10", "2026-03-04"],
    ["2026-11-03", "2026-10-28"],
  ])("keeps seven local days across DST around %s", (end, start) => {
    const dates = insightsDates("7d", end);
    expect(dates).toEqual({ from: start, to: end });
    expect(dateSpan(dates)).toBe(7);
  });

  it("formats the local natural day at both ends of the day", () => {
    expect(localDate(new Date(2026, 0, 2, 0, 1))).toBe("2026-01-02");
    expect(localDate(new Date(2026, 0, 2, 23, 59))).toBe("2026-01-02");
    const historical = new Date(0);
    historical.setFullYear(999, 0, 2);
    expect(localDate(historical)).toBe("0999-01-02");
  });

  it("accepts a same-day custom range and exactly 366 inclusive days", () => {
    expect(validCustomDates({ from: today, to: today }, today)).toBe(true);
    expect(validCustomDates({ from: "2024-01-01", to: "2024-12-31" }, today)).toBe(true);
    expect(validCustomDates({ from: "2024-01-01", to: "2025-01-01" }, today)).toBe(false);
  });

  it.each([
    { from: "2026-11-10", to: "2026-11-11" },
    { from: "2026-11-10", to: "2026-11-09" },
    { from: "2026-02-29", to: "2026-03-01" },
    { from: "2024-02-30", to: "2024-03-01" },
    { from: "2026-1-01", to: "2026-01-02" },
    { from: "2026-00-01", to: "2026-01-02" },
    { from: "", to: today },
  ])("rejects invalid custom dates %j", (dates) => {
    expect(validCustomDates(dates, today)).toBe(false);
  });

  it("rejects an invalid today boundary", () => {
    expect(validCustomDates({ from: "2026-01-01", to: "2026-01-02" }, "invalid")).toBe(false);
  });

  it("uses valid custom dates and falls back to 30 days for invalid ones", () => {
    const custom = { from: "2026-01-01", to: "2026-01-05" };
    expect(insightsDates("custom", today, custom)).toEqual(custom);
    expect(insightsDates("custom", today, { from: today, to: "2026-11-11" })).toEqual(
      fallback.custom,
    );
    expect(insightsDates("custom", today)).toEqual(fallback.custom);
  });
});

describe("insight range preferences", () => {
  it("round-trips both the preset and custom range", () => {
    const selection = { range: "90d", custom: { from: "2026-01-01", to: "2026-01-05" } } as const;
    saveInsightsRange(selection);
    expect(JSON.parse(window.localStorage.getItem(INSIGHTS_RANGE_STORAGE_KEY)!)).toEqual(selection);
    expect(readInsightsRange(today)).toEqual(selection);
  });

  it.each([null, "{", "null", "[]", "1", '"30d"', '{"range":"forever"}', "{}"])(
    "falls back for absent or invalid JSON preference %s",
    (stored) => {
      if (stored !== null) window.localStorage.setItem(INSIGHTS_RANGE_STORAGE_KEY, stored);
      expect(readInsightsRange(today)).toEqual(fallback);
    },
  );

  it("keeps a valid preset but replaces an invalid custom preference", () => {
    window.localStorage.setItem(
      INSIGHTS_RANGE_STORAGE_KEY,
      JSON.stringify({ range: "7d", custom: { from: 1, to: today } }),
    );
    expect(readInsightsRange(today)).toEqual({ ...fallback, range: "7d" });
  });

  it("rejects stale future custom ranges while preserving valid historical ones", () => {
    saveInsightsRange({ range: "custom", custom: { from: today, to: "2026-11-11" } });
    expect(readInsightsRange(today)).toEqual(fallback);
    const selection = {
      range: "custom",
      custom: { from: "2024-02-29", to: "2024-03-01" },
    } as const;
    saveInsightsRange(selection);
    expect(readInsightsRange(today)).toEqual(selection);
  });

  it("remains usable when storage access is denied", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(readInsightsRange(today)).toEqual(fallback);
  });

  it("does not throw or replace the saved preference when storage is full", () => {
    saveInsightsRange({ range: "7d", custom: fallback.custom });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(() => saveInsightsRange({ range: "90d", custom: fallback.custom })).not.toThrow();
    expect(readInsightsRange(today)).toEqual({ ...fallback, range: "7d" });
  });
});
