import type { HeatmapPoint } from "@/core/types";
import type { HeatmapMetric } from "./InsightsTypes";

export type TrendGranularity = "day" | "week" | "month";
export interface TrendPoint {
  date: string;
  endDate: string;
  value: number | null;
}
export interface TrendCoordinate {
  x: number;
  y: number;
}

function localDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const result = new Date(0);
  // Noon avoids changes to the local date in zones that advance the clock at midnight.
  result.setHours(12, 0, 0, 0);
  result.setFullYear(year, month - 1, day);
  return result.getFullYear() === year &&
    result.getMonth() === month - 1 &&
    result.getDate() === day
    ? result
    : null;
}

function dateKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function bucketKey(date: Date, granularity: TrendGranularity): string {
  if (granularity === "month") return dateKey(date).slice(0, 7);
  if (granularity === "day") return dateKey(date);
  const monday = new Date(date);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return dateKey(monday);
}

/** Missing dates invalidate their bucket; recorded zeroes remain meaningful zeroes. */
export function buildTrendSeries(
  points: HeatmapPoint[],
  metric: HeatmapMetric,
  granularity: TrendGranularity,
): TrendPoint[] {
  const values = new Map<string, number | null>();
  for (const point of points) {
    if (!localDay(point.date)) continue;
    const value = point[metric];
    const valid = Number.isFinite(value) && value >= 0 ? value : null;
    const previous = values.get(point.date);
    // Conflicting duplicates do not establish an exact value for that day.
    values.set(point.date, values.has(point.date) && previous !== valid ? null : valid);
  }
  const dates = [...values.keys()].sort();
  if (!dates.length) return [];
  const current = localDay(dates[0])!;
  const last = localDay(dates.at(-1)!)!.getTime();
  const result: TrendPoint[] = [];
  let key: string | undefined;
  while (current.getTime() <= last) {
    const date = dateKey(current);
    const nextKey = bucketKey(current, granularity);
    if (nextKey !== key) {
      result.push({ date, endDate: date, value: 0 });
      key = nextKey;
    }
    const bucket = result[result.length - 1];
    bucket.endDate = date;
    const value = values.get(date);
    if (value === undefined || value === null) bucket.value = null;
    else if (bucket.value !== null) {
      const sum = bucket.value + value;
      bucket.value = Number.isFinite(sum) ? sum : null;
    }
    // Natural calendar days keep the range correct across DST changes.
    current.setDate(current.getDate() + 1);
  }
  return result;
}

/** C1 cubic interpolation whose control points stay inside each pair's value bounds. */
function segmentPath(points: TrendCoordinate[]): string {
  if (!points.length) return "";
  let result = `M ${points[0].x} ${points[0].y}`;
  if (points.length === 1) return result;
  const slopes = points.slice(1).map((point, index) => {
    const previous = points[index];
    const slope = (point.y - previous.y) / (point.x - previous.x);
    return Number.isFinite(slope) ? slope : 0;
  });
  const tangents = points.map((_point, index) => {
    if (index === 0) return slopes[0];
    if (index === points.length - 1) return slopes[slopes.length - 1];
    const left = slopes[index - 1];
    const right = slopes[index];
    if (!left || !right || Math.sign(left) !== Math.sign(right)) return 0;
    const small = Math.min(Math.abs(left), Math.abs(right));
    const large = Math.max(Math.abs(left), Math.abs(right));
    const tangent = (2 * small) / (1 + small / large);
    return Number.isFinite(tangent) ? Math.sign(left) * tangent : 0;
  });
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1];
    const point = points[index];
    const third = (point.x - previous.x) / 3;
    const lower = Math.min(previous.y, point.y);
    const upper = Math.max(previous.y, point.y);
    const clamp = (value: number) => Math.max(lower, Math.min(upper, value));
    result += ` C ${previous.x + third} ${clamp(previous.y + third * tangents[index - 1])} ${point.x - third} ${clamp(point.y - third * tangents[index])} ${point.x} ${point.y}`;
  }
  return result;
}

/** Null/invalid points and non-increasing positions start a new, disconnected segment. */
export function smoothTrendPath(points: Array<TrendCoordinate | null>): string {
  const paths: string[] = [];
  let segment: TrendCoordinate[] = [];
  const finish = () => {
    if (segment.length) paths.push(segmentPath(segment));
    segment = [];
  };
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      finish();
      continue;
    }
    if (segment.length && point.x <= segment[segment.length - 1].x) finish();
    segment.push(point);
  }
  finish();
  return paths.join(" ");
}
