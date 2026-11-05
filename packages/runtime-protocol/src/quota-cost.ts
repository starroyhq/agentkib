/** Only normalized aggregates cross the runtime boundary; never include log/project paths. */
export type LocalCostProvider = "codex" | "claude";
export type LocalCostRefreshState =
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface LocalCostModel {
  model: string;
  cost_usd: number | null;
  tokens: number | null;
  partial: boolean;
}

export interface LocalCostDay {
  date: string;
  cost_usd: number | null;
  tokens: number | null;
  partial: boolean;
  models: LocalCostModel[];
}

export interface LocalCostTotal {
  cost_usd: number | null;
  tokens: number | null;
  partial: boolean;
}

export interface LocalCostSnapshot {
  schema_version: 1;
  provider: LocalCostProvider;
  scope_key: string;
  data_version: string;
  source: "native-local";
  currency: "USD";
  timezone: string;
  period_days: 30;
  range_start: string;
  range_end: string;
  /** Collector measurement time, independent of the quota snapshot. */
  updated_at: string;
  fetched_at: string;
  today: LocalCostDay;
  last_30_days: LocalCostTotal;
  daily: LocalCostDay[];
  models: LocalCostModel[];
  history_complete: boolean;
  unpriced_models: string[];
}

export interface LocalCostStatus {
  provider: LocalCostProvider;
  scope_key: string;
  state: LocalCostRefreshState;
  data_version?: string;
  last_attempt_at?: string;
  last_success_at?: string;
  error_key?: string;
  error_detail?: string;
}

export interface LocalCostUpdate {
  provider: LocalCostProvider;
  snapshot?: LocalCostSnapshot;
  status: LocalCostStatus;
}
