import type { LocalCostProvider, LocalCostSnapshot } from "@/core/types";

export function localCostFixture(provider: LocalCostProvider = "codex"): LocalCostSnapshot {
  return {
    schema_version: 1,
    provider,
    scope_key: `scope-${provider}`,
    data_version: "v1",
    source: "native-local",
    currency: "USD",
    timezone: "Asia/Shanghai",
    period_days: 30,
    range_start: "2026-10-07",
    range_end: "2026-11-05",
    updated_at: "2026-11-05T04:00:00Z",
    fetched_at: "2026-11-05T04:01:00Z",
    today: { date: "2026-11-05", cost_usd: null, tokens: 42, partial: true, models: [] },
    last_30_days: { cost_usd: 1.25, tokens: 142, partial: true },
    daily: [
      { date: "2026-11-03", cost_usd: 0, tokens: 0, partial: false, models: [] },
      { date: "2026-11-05", cost_usd: null, tokens: 42, partial: true, models: [] },
    ],
    models: [
      { model: "priced-model", cost_usd: 1.25, tokens: 100, partial: false },
      { model: "unknown-model", cost_usd: null, tokens: 42, partial: true },
    ],
    history_complete: false,
    unpriced_models: ["unknown-model"],
  };
}
