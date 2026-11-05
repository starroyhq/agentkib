import { createHash } from "node:crypto";
import type {
  LocalCostDay,
  LocalCostModel,
  LocalCostProvider,
  LocalCostSnapshot,
} from "@agentkib/runtime-protocol";

type RecordValue = Record<string, unknown>;
export type CostBackend = "codex-bar-cli" | "win-codex-bar";

export interface CostParseScope {
  scope_key: string;
  timezone: string;
  now?: Date;
}

/** Parse only allow-listed aggregates. Project/source records never leave the collector. */
export function parseLocalCosts(
  bytes: Buffer,
  backend: CostBackend,
  provider: LocalCostProvider,
  scope: CostParseScope,
): LocalCostSnapshot {
  const input: unknown = JSON.parse(bytes.toString("utf8"));
  const payloads = Array.isArray(input) ? input : [input];
  const matches = payloads.filter(
    (item): item is RecordValue => record(item) && item.provider === provider,
  );
  if (matches.length !== 1)
    throw new Error("cost collector did not return exactly one requested provider");
  const raw = matches[0];
  if (raw.agentkibNativeOnly !== true)
    throw new Error("cost collector did not confirm native-only scope; update collector");
  const now = scope.now ?? new Date();
  const rangeEnd = localDay(now, scope.timezone);
  const start = new Date(`${rangeEnd}T12:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 29);
  const rangeStart = start.toISOString().slice(0, 10);
  const win = backend === "win-codex-bar";
  const contract = win && record(raw.spendContract) ? raw.spendContract : undefined;
  if (win && !contract)
    throw new Error("cost collector does not support the native spend contract; update collector");
  if (
    raw.supported === false ||
    (raw.source !== undefined && !["local", "native-local"].includes(String(raw.source)))
  )
    throw new Error("cost collector returned an unsupported source");
  if (
    win &&
    (contract!.providerId !== provider ||
      (Array.isArray(contract!.imports) && contract!.imports.length > 0))
  )
    throw new Error("cost collector returned a non-native source; update collector");
  const currency = win ? (record(raw.cost) ? raw.cost.currency : "USD") : raw.currencyCode;
  if (currency !== undefined && currency !== null && currency !== "USD")
    throw new Error("cost collector returned a non-USD currency");
  const reporting = win ? contract!.reportingPeriod : raw.reportingPeriod;
  if (reporting !== undefined && reporting !== "rolling:30")
    throw new Error("cost collector returned a different reporting period");
  const historyDays = win ? contract!.historyDays : raw.historyDays;
  if (historyDays !== undefined && historyDays !== null && historyDays !== 30)
    throw new Error("cost collector returned a different history window");
  const dailyRaw = win ? contract!.daily : raw.daily;
  if (!Array.isArray(dailyRaw)) throw new Error("cost collector returned no daily aggregates");
  const unpriced = new Set<string>();
  const rawCompleteness =
    record(raw.modelPricingCompleteness) && record(raw.modelPricingCompleteness.partial)
      ? raw.modelPricingCompleteness.partial.unpriced_models
      : [];
  if (Array.isArray(rawCompleteness))
    for (const value of rawCompleteness)
      if (typeof value === "string") unpriced.add(modelName(value));
  const daily = dailyRaw
    .map((entry): LocalCostDay => {
      if (!record(entry)) throw new Error("invalid cost day");
      const date = String(win ? entry.day : entry.date);
      if (!validDay(date)) throw new Error("invalid cost date");
      const models = win ? [] : modelRows(entry.modelBreakdowns, false, unpriced);
      const cost = amount(win ? entry.costUsd : entry.totalCost);
      const tokens = count(entry.totalTokens);
      return {
        date,
        cost_usd: cost,
        tokens,
        partial:
          cost === null ||
          models.some((model) => model.partial) ||
          positive(entry.incompleteRequestCount),
        models,
      };
    })
    .filter((entry) => entry.date >= rangeStart && entry.date <= rangeEnd)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (new Set(daily.map((entry) => entry.date)).size !== daily.length)
    throw new Error("duplicate cost day");
  const historyComplete =
    (win ? contract!.historyCoverageEstablished : raw.historyCoverageIsEstablished) === true;
  const models = win ? modelRows(contract!.models, true, unpriced) : aggregateModels(daily);
  const coverage = win ? contract!.priceCoverage : raw.coverage;
  const hasUnknown =
    models.some((model) => model.partial) ||
    unpriced.size > 0 ||
    (record(coverage) && (positive(coverage.unpriced) || positive(coverage.unmetered)));
  const lastCost = amount(win ? contract!.knownCostUsd : raw.last30DaysCostUSD);
  const pricedSubtotal = lastCost ?? sumKnown(daily.map((entry) => entry.cost_usd));
  // The contract's totals already include cached tokens according to that scanner's semantics.
  // Never add token_mix/cache classes on top of them.
  const totals = record(raw.totals) ? raw.totals : {};
  const lastTokens = count(win ? totals.totalTokens : raw.last30DaysTokens);
  const effectiveTokens = lastTokens ?? sumKnown(daily.map((entry) => entry.tokens));
  const measured = win ? raw.updatedAt : raw.updatedAt;
  const updatedAt =
    typeof measured === "string" && Number.isFinite(Date.parse(measured))
      ? new Date(measured).toISOString()
      : now.toISOString();
  if (raw.error && pricedSubtotal === null && effectiveTokens === null && daily.length === 0)
    throw new Error("cost collector returned no usable aggregates");
  let today = daily.find((entry) => entry.date === rangeEnd);
  if (!today)
    today = {
      date: rangeEnd,
      cost_usd: win ? null : amount(raw.sessionCostUSD),
      tokens: win ? null : count(raw.sessionTokens),
      partial: true,
      models: [],
    };
  if (raw.error) today = { ...today, partial: true };
  const normalized = {
    schema_version: 1 as const,
    provider,
    scope_key: scope.scope_key,
    source: "native-local" as const,
    currency: "USD" as const,
    timezone: scope.timezone,
    period_days: 30 as const,
    range_start: rangeStart,
    range_end: rangeEnd,
    updated_at: updatedAt,
    fetched_at: now.toISOString(),
    today,
    last_30_days: {
      cost_usd: pricedSubtotal,
      tokens: effectiveTokens,
      partial:
        Boolean(raw.error) ||
        hasUnknown ||
        lastCost === null ||
        positive(raw.incompleteRequestCount),
    },
    daily,
    models,
    history_complete: historyComplete,
    unpriced_models: [...unpriced].sort(),
  };
  return {
    ...normalized,
    data_version: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
  };
}

function modelRows(value: unknown, win: boolean, unpriced: Set<string>): LocalCostModel[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("invalid cost model aggregates");
  return value.map((entry) => {
    if (!record(entry)) throw new Error("invalid cost model");
    const name = modelName(win ? entry.model : entry.modelName);
    const cost = amount(win ? entry.costUsd : entry.cost);
    const partial = cost === null || positive(entry.incompleteRequestCount);
    if (cost === null) unpriced.add(name);
    return { model: name, cost_usd: cost, tokens: count(entry.totalTokens), partial };
  });
}

function aggregateModels(days: LocalCostDay[]): LocalCostModel[] {
  const grouped = new Map<string, LocalCostModel[]>();
  for (const day of days)
    for (const model of day.models)
      grouped.set(model.model, [...(grouped.get(model.model) ?? []), model]);
  return [...grouped]
    .map(([model, entries]) => ({
      model,
      cost_usd: sumKnown(entries.map((entry) => entry.cost_usd)),
      tokens: sumKnown(entries.map((entry) => entry.tokens)),
      partial: entries.some((entry) => entry.partial),
    }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

function sumKnown(values: Array<number | null>): number | null {
  const known = values.filter((value): value is number => value !== null);
  if (!known.length) return null;
  const sum = known.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER)
    throw new Error("cost aggregate overflow");
  return sum;
}
function modelName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 240 ||
    !/^[\p{L}\p{N}._:+@ /-]+$/u.test(value) ||
    value.includes("..") ||
    value.startsWith("/") ||
    value.includes("\\")
  )
    throw new Error("invalid cost model name");
  return value;
}
function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}
function amount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new Error("invalid cost amount");
  return value;
}
function count(value: unknown): number | null {
  const result = amount(value);
  if (result !== null && !Number.isSafeInteger(result)) throw new Error("invalid cost token count");
  return result;
}
function validDay(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value
  );
}
export function localDay(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
