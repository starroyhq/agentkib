import { describe, expect, it } from "vitest";
import type { HeatmapPoint } from "@/core/types";
import { buildTrendSeries, smoothTrendPath } from "./insights-trend";

function point(date: string, tokens: number): HeatmapPoint {
  return {
    date,
    tokens,
    my_commits: tokens * 2,
    all_commits: 0,
    attributed_commits: 0,
    sessions: 0,
    quality: "exact",
  };
}
function days(from: string, to: string, value = 1) {
  const current = new Date(`${from}T12:00:00`);
  const result: HeatmapPoint[] = [];
  while (true) {
    const date = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
    if (date > to) return result;
    result.push(point(date, value));
    current.setDate(current.getDate() + 1);
  }
}

describe("insight trend aggregation", () => {
  it("keeps recorded zeroes and inserts explicit gaps between missing days", () => {
    expect(
      buildTrendSeries([point("2026-11-03", 4), point("2026-11-01", 0)], "tokens", "day"),
    ).toEqual([
      { date: "2026-11-01", endDate: "2026-11-01", value: 0 },
      { date: "2026-11-02", endDate: "2026-11-02", value: null },
      { date: "2026-11-03", endDate: "2026-11-03", value: 4 },
    ]);
  });
  it("aggregates Monday-based weeks across years and clips first/last buckets", () => {
    expect(buildTrendSeries(days("2025-12-31", "2026-01-06"), "tokens", "week")).toEqual([
      { date: "2025-12-31", endDate: "2026-01-04", value: 5 },
      { date: "2026-01-05", endDate: "2026-01-06", value: 2 },
    ]);
  });
  it("does not sum incomplete weeks as if missing days were zero", () => {
    const points = days("2026-11-02", "2026-11-10").filter((row) => row.date !== "2026-11-05");
    expect(buildTrendSeries(points, "tokens", "week")).toEqual([
      { date: "2026-11-02", endDate: "2026-11-08", value: null },
      { date: "2026-11-09", endDate: "2026-11-10", value: 2 },
    ]);
  });
  it("keeps all months, including more than nine buckets, and selected metric totals", () => {
    const result = buildTrendSeries(days("2025-12-30", "2026-11-02"), "my_commits", "month");
    expect(result).toHaveLength(12);
    expect(result[0]).toEqual({ date: "2025-12-30", endDate: "2025-12-31", value: 4 });
    expect(result[1]).toEqual({ date: "2026-01-01", endDate: "2026-01-31", value: 62 });
    expect(result.at(-1)).toEqual({ date: "2026-11-01", endDate: "2026-11-02", value: 4 });
  });
  it("marks entire missing months as gaps without losing their calendar positions", () => {
    const points = [...days("2026-01-30", "2026-01-31"), ...days("2026-03-01", "2026-03-02")];
    expect(buildTrendSeries(points, "tokens", "month")).toEqual([
      { date: "2026-01-30", endDate: "2026-01-31", value: 2 },
      { date: "2026-02-01", endDate: "2026-02-28", value: null },
      { date: "2026-03-01", endDate: "2026-03-02", value: 2 },
    ]);
  });
  it("retains leap days and local calendar dates through seasonal clock changes", () => {
    expect(
      buildTrendSeries(days("2024-02-28", "2024-03-01"), "tokens", "day").map((row) => row.date),
    ).toEqual(["2024-02-28", "2024-02-29", "2024-03-01"]);
    expect(
      buildTrendSeries(days("2026-03-07", "2026-03-10"), "tokens", "day").map((row) => row.date),
    ).toEqual(["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
  });
  it("does not double-count duplicate days or accept malformed calendar values", () => {
    expect(buildTrendSeries([point("2026-02-30", 8)], "tokens", "day")).toEqual([]);
    expect(
      buildTrendSeries([point("2026-11-01", 3), point("2026-11-01", 3)], "tokens", "day")[0].value,
    ).toBe(3);
    expect(
      buildTrendSeries([point("2026-11-01", 3), point("2026-11-01", 4)], "tokens", "day")[0].value,
    ).toBeNull();
    expect(
      buildTrendSeries([point("2026-11-01", Number.NaN)], "tokens", "day")[0].value,
    ).toBeNull();
  });
  it("handles empty and single-day input", () => {
    expect(buildTrendSeries([], "tokens", "week")).toEqual([]);
    expect(buildTrendSeries([point("2026-11-10", 0)], "tokens", "month")).toEqual([
      { date: "2026-11-10", endDate: "2026-11-10", value: 0 },
    ]);
  });
});

describe("shape-preserving trend curves", () => {
  it("handles empty, isolated and two-point series without inventing data", () => {
    expect(smoothTrendPath([])).toBe("");
    expect(smoothTrendPath([null, { x: 4, y: 9 }, null])).toBe("M 4 9");
    expect(
      smoothTrendPath([
        { x: 0, y: 0 },
        { x: 9, y: 9 },
      ]),
    ).toBe("M 0 0 C 3 3 6 6 9 9");
  });
  it("starts a new subpath after gaps, invalid numbers, or a non-increasing date", () => {
    const path = smoothTrendPath([
      { x: 0, y: 1 },
      null,
      { x: 3, y: 2 },
      { x: 4, y: 3 },
      { x: 5, y: Number.NaN },
      { x: 6, y: 4 },
      { x: 6, y: 8 },
    ]);
    expect(path.match(/\bM /g)).toHaveLength(4);
    expect(path).not.toMatch(/NaN|Infinity/);
    expect(path).not.toContain("C 1");
  });
  it.each([
    [0, 100, 0, 10, 0],
    [100, 100, 100, 100, 100],
    [0, 1, 1, 90, 91],
    [100, 90, 1, 1, 0],
    [0, 0, 0, 100, 0],
  ])("preserves every data point and remains inside neighboring values for %j", (...values) => {
    const points = values.map((y, index) => ({ x: index * index + index, y }));
    const path = smoothTrendPath(points);
    const pieces = path.split(" C ");
    expect(pieces[0]).toBe(`M ${points[0].x} ${points[0].y}`);
    expect(pieces).toHaveLength(points.length);
    for (let index = 1; index < pieces.length; index++) {
      const [x1, y1, x2, y2, x3, y3] = pieces[index].split(" ").map(Number);
      const previous = points[index - 1],
        current = points[index];
      expect([x3, y3]).toEqual([current.x, current.y]);
      expect(x1).toBeGreaterThan(previous.x);
      expect(x2).toBeLessThan(current.x);
      const lower = Math.min(previous.y, current.y),
        upper = Math.max(previous.y, current.y);
      for (const y of [y1, y2]) {
        expect(y).toBeGreaterThanOrEqual(lower);
        expect(y).toBeLessThanOrEqual(upper);
      }
      for (let sample = 0; sample <= 100; sample++) {
        const t = sample / 100,
          u = 1 - t;
        const y = u ** 3 * previous.y + 3 * u ** 2 * t * y1 + 3 * u * t ** 2 * y2 + t ** 3 * y3;
        expect(y).toBeGreaterThanOrEqual(lower - 1e-10);
        expect(y).toBeLessThanOrEqual(upper + 1e-10);
      }
    }
  });
});
