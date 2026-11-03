export type RelayUsage = {
  periodStart: number;
  periodEnd: number;
  limitBytes: number;
  usedBytes: number;
  remainingBytes: number;
  exhausted: boolean;
  updatedAt: number;
};

export function checkedRelayUsage(value: unknown): RelayUsage {
  const data = value as RelayUsage;
  const fields = [
    "periodStart",
    "periodEnd",
    "limitBytes",
    "usedBytes",
    "remainingBytes",
    "updatedAt",
  ] as const;
  if (
    !data ||
    fields.some((key) => !Number.isSafeInteger(data[key]) || data[key] < 0) ||
    data.limitBytes < 1 ||
    data.periodEnd <= data.periodStart ||
    typeof data.exhausted !== "boolean" ||
    data.remainingBytes !== Math.max(0, data.limitBytes - data.usedBytes) ||
    data.exhausted !== data.usedBytes >= data.limitBytes
  )
    throw new Error("account_response_invalid");
  return {
    periodStart: data.periodStart,
    periodEnd: data.periodEnd,
    limitBytes: data.limitBytes,
    usedBytes: data.usedBytes,
    remainingBytes: data.remainingBytes,
    exhausted: data.exhausted,
    updatedAt: data.updatedAt,
  };
}

export function trafficAmount(bytes: number, locale: string): string {
  const unit =
    bytes >= 1_000_000_000 ? "GB" : bytes >= 1_000_000 ? "MB" : bytes >= 1_000 ? "KB" : "B";
  const divisor = { GB: 1_000_000_000, MB: 1_000_000, KB: 1_000, B: 1 }[unit];
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === "B" ? 0 : 2 }).format(bytes / divisor)} ${unit}`;
}
