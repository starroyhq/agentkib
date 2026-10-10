import type { useI18n } from "@/core/useI18n";

export function formatDateTime(value: string, locale: ReturnType<typeof useI18n>["locale"]) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function formatNumber(value: number, locale: ReturnType<typeof useI18n>["locale"]) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}
