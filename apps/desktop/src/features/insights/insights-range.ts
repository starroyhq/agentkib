import type { InsightsRange } from "./InsightsTypes";

export interface InsightsDates {
  from: string;
  to: string;
}
export interface InsightsRangeSelection {
  range: InsightsRange;
  custom: InsightsDates;
}
export const INSIGHTS_RANGE_STORAGE_KEY = "agentkib.insights.range.v1";
export const insightRanges: InsightsRange[] = ["7d", "30d", "90d", "year", "52w", "custom"];
export function localDate(value: Date) {
  return `${String(value.getFullYear()).padStart(4, "0")}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
function validDay(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function dateSpan({ from, to }: InsightsDates) {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}
export function validCustomDates(value: InsightsDates, today: string) {
  return (
    validDay(today) &&
    validDay(value.from) &&
    validDay(value.to) &&
    value.from <= value.to &&
    value.to <= today &&
    dateSpan(value) <= 366
  );
}
export function insightsDates(
  range: InsightsRange,
  today: string,
  custom?: InsightsDates,
): InsightsDates {
  if (range === "custom" && custom && validCustomDates(custom, today)) return custom;
  if (range === "year") return { from: `${today.slice(0, 4)}-01-01`, to: today };
  const days = range === "7d" ? 7 : range === "90d" ? 90 : range === "52w" ? 364 : 30;
  const from = new Date(`${today}T12:00:00`);
  from.setDate(from.getDate() - days + 1);
  return { from: localDate(from), to: today };
}
export function readInsightsRange(today: string): InsightsRangeSelection {
  const fallback: InsightsRangeSelection = { range: "30d", custom: insightsDates("30d", today) };
  try {
    const stored: unknown = JSON.parse(
      window.localStorage.getItem(INSIGHTS_RANGE_STORAGE_KEY) ?? "null",
    );
    if (!stored || typeof stored !== "object") return fallback;
    const value = stored as Record<string, unknown>;
    if (typeof value.range !== "string" || !insightRanges.includes(value.range as InsightsRange))
      return fallback;
    const custom = value.custom as InsightsDates | undefined;
    if (
      !custom ||
      typeof custom.from !== "string" ||
      typeof custom.to !== "string" ||
      !validCustomDates(custom, today)
    )
      return value.range === "custom"
        ? fallback
        : { ...fallback, range: value.range as InsightsRange };
    return { range: value.range as InsightsRange, custom };
  } catch {
    return fallback;
  }
}
export function saveInsightsRange(selection: InsightsRangeSelection) {
  try {
    window.localStorage.setItem(INSIGHTS_RANGE_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    /* Browsing remains available when preference storage is disabled. */
  }
}
