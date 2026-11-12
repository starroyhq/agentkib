export interface ContextUsage {
  available: boolean;
  state?: "ready" | "pending" | "stale" | "unavailable";
  /** Last saved report from native history, outside the live report sequence. */
  historical?: true;
  reason?: string;
  revision?: number;
  /** Native observer instance, ordered within the current backend process. */
  reportGeneration?: number;
  reportId?: number;
  usedTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
  percent?: number;
  updatedAt?: string;
}

let contextUsageGeneration = 0;

/** A rebuilt native observer must not reuse its predecessor's report-ID namespace. */
export function createContextUsageGeneration(): number {
  if (contextUsageGeneration === Number.MAX_SAFE_INTEGER)
    throw new Error("context-usage-generation-exhausted");
  return ++contextUsageGeneration;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const count = (value: unknown): number | undefined => {
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
    return Number(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};
const tokens = (value: unknown): number | undefined => {
  const direct = count(value);
  if (direct !== undefined) return direct;
  const data = object(value);
  return data ? count(data.totalTokens ?? data.total_tokens ?? data.tokens) : undefined;
};

/** Normalize native reports; cumulative consumption never substitutes for context occupancy. */
export function projectContextUsage(raw: unknown, revision?: number): ContextUsage | undefined {
  const data = object(raw);
  if (!data) return undefined;
  const native = object(data.tokenUsage);
  const usedTokens = native ? tokens(native.last) : count(data.usedTokens);
  const totalTokens = native ? tokens(native.total) : count(data.totalTokens);
  const window = native ? count(native.modelContextWindow) : count(data.contextWindow);
  const contextWindow = window !== undefined && window > 0 ? window : undefined;
  const available = data.available === true;
  const valid = usedTokens !== undefined && contextWindow !== undefined;
  const declared = ["ready", "pending", "stale", "unavailable"].includes(String(data.state))
    ? (data.state as NonNullable<ContextUsage["state"]>)
    : undefined;
  const state = !available
    ? "unavailable"
    : declared === "ready" && !valid
      ? "pending"
      : (declared ?? (valid ? "ready" : "pending"));
  const historical = data.historical === true && state === "stale" && valid;
  const reportId = historical ? undefined : count(data.reportId);
  const reportGeneration = historical ? undefined : count(data.reportGeneration);
  const controlRevision = historical ? undefined : (count(data.revision) ?? count(revision));
  return {
    available,
    state,
    ...(historical ? { historical: true } : {}),
    ...(typeof data.reason === "string" && data.reason.length <= 4096
      ? { reason: data.reason }
      : {}),
    ...(controlRevision !== undefined ? { revision: controlRevision } : {}),
    ...(reportGeneration !== undefined ? { reportGeneration } : {}),
    ...(reportId !== undefined ? { reportId } : {}),
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(state === "ready" && valid
      ? { percent: Math.min(100, (usedTokens! / contextWindow!) * 100) }
      : {}),
    ...(typeof data.updatedAt === "string" && data.updatedAt.length <= 128
      ? { updatedAt: data.updatedAt }
      : {}),
  };
}
