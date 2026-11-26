import type { UsageLimitView } from "./usage-limit";

export const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type WorkerLimit = Pick<UsageLimitView, "kind" | "resetsAt" | "continueAt" | "manual">;

export function reasonCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(value) ? value : null;
}

export function dateField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8.64e15
    ? value
    : null;
}

export function workerLimit(live: Record<string, unknown> | null): WorkerLimit | null {
  const limit = live?.usageLimit;
  if (!isObject(limit)) return null;
  return {
    kind: reasonCode(limit.kind) as WorkerLimit["kind"],
    resetsAt: dateField(limit.resetsAt),
    continueAt: dateField(limit.continueAt),
    manual: reasonCode(limit.manual) as WorkerLimit["manual"],
  };
}
