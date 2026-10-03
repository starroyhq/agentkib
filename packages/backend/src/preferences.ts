import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const THEMES = ["system", "light", "dark"];
const ACCENTS = ["minimal-neutral", "vtron", "claude", "sakura", "ocean-breeze"];
const ICONS = ["white", "black"];
const CLOSE_BEHAVIORS = ["minimize-to-tray", "quit"];

export function readPreferences(dataDir: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(readFileSync(path.join(dataDir, "preferences.json"), "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return {};
    throw error;
  }
}

/** Callers serialize updates to preferences.json through the TypeScript owner. */
export function writePreference(dataDir: string, key: string, value: unknown): void {
  writePreferences(dataDir, { [key]: value });
}

export function writePreferences(dataDir: string, changes: Record<string, unknown>): void {
  const preferences = { ...readPreferences(dataDir), ...changes };
  mkdirSync(dataDir, { recursive: true });
  const destination = path.join(dataDir, "preferences.json");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function preferenceSnapshot(dataDir: string, environment: NodeJS.ProcessEnv) {
  const preferences = readPreferences(dataDir);
  const locale =
    typeof preferences.locale_preference === "string" ? preferences.locale_preference : "system";
  const theme = member(preferences.theme_preference, THEMES) ?? "system";
  const width = preferences.sidebar_width_preference;
  return {
    close_behavior: member(preferences.close_behavior, CLOSE_BEHAVIORS),
    locale_preference: locale,
    effective_locale: locale === "system" ? (environment.AGENTKIB_LOCALE ?? "en-US") : locale,
    theme_preference: theme,
    effective_theme: theme === "system" ? (environment.AGENTKIB_SYSTEM_THEME ?? "light") : theme,
    accent_theme_preference: member(preferences.accent_theme_preference, ACCENTS),
    sidebar_width_preference:
      typeof width === "number" && Number.isInteger(width) && width >= 250 && width <= 400
        ? width
        : null,
    app_icon_preference: member(preferences.app_icon_preference, ICONS) ?? "white",
    session_index_enabled: booleanPreference(preferences.session_index_enabled, true),
    quota_auto_refresh_enabled: booleanPreference(preferences.quota_auto_refresh_enabled, false),
    local_auto_refresh_enabled: booleanPreference(preferences.local_auto_refresh_enabled, true),
    quota_auto_refresh_prompt_seen: booleanPreference(
      preferences.quota_auto_refresh_prompt_seen,
      false,
    ),
    onboarding: { version: 1, ...readOnboarding(preferences.onboarding) },
  };
}

function member(value: unknown, values: string[]): string | null {
  return typeof value === "string" && values.includes(value) ? value : null;
}

function booleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export interface OnboardingPreferences {
  acknowledged_version: number;
  workspace_id: string | null;
  doctor_completed: boolean;
  repairable_count: number;
  repair_applied: boolean;
}
export function readOnboarding(value: unknown): OnboardingPreferences {
  const empty = {
    acknowledged_version: 0,
    workspace_id: null,
    doctor_completed: false,
    repairable_count: 0,
    repair_applied: false,
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return empty;
  const row = value as Record<string, unknown>;
  const result = {
    ...empty,
    ...Object.fromEntries(
      Object.keys(empty)
        .filter((key) => key in row)
        .map((key) => [key, row[key]]),
    ),
  };
  if (
    !Number.isSafeInteger(result.acknowledged_version) ||
    result.acknowledged_version < 0 ||
    result.acknowledged_version > 4294967295 ||
    !Number.isSafeInteger(result.repairable_count) ||
    result.repairable_count < 0 ||
    !(result.workspace_id === null || typeof result.workspace_id === "string") ||
    typeof result.doctor_completed !== "boolean" ||
    typeof result.repair_applied !== "boolean"
  )
    return empty;
  return result;
}

export interface QuotaPreferences {
  hidden_providers: string[];
  hidden_windows: { provider_id: string; account_id?: string; kind: string; label: string }[];
}
export function parseQuotaPreferences(value: unknown): QuotaPreferences | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const providers = row.hidden_providers === undefined ? [] : row.hidden_providers;
  const windows = row.hidden_windows === undefined ? [] : row.hidden_windows;
  if (
    !Array.isArray(providers) ||
    providers.some((provider) => typeof provider !== "string") ||
    !Array.isArray(windows)
  )
    return null;
  const selectors: QuotaPreferences["hidden_windows"] = [];
  for (const window of windows) {
    if (typeof window !== "object" || window === null || Array.isArray(window)) return null;
    const { provider_id, account_id, kind, label } = window;
    if (
      typeof provider_id !== "string" ||
      typeof kind !== "string" ||
      typeof label !== "string" ||
      !(account_id == null || typeof account_id === "string")
    )
      return null;
    selectors.push({ provider_id, ...(account_id == null ? {} : { account_id }), kind, label });
  }
  return { hidden_providers: providers, hidden_windows: selectors };
}

export function normalizeQuotaPreferences(preferences: QuotaPreferences): QuotaPreferences {
  const compare = (left: string, right: string) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right));
  const windows = preferences.hidden_windows
    .filter((value) => value.provider_id.trim() && value.kind.trim() && value.label.trim())
    .sort(
      (left, right) =>
        compare(left.provider_id, right.provider_id) ||
        (left.account_id === undefined
          ? right.account_id === undefined
            ? 0
            : -1
          : right.account_id === undefined
            ? 1
            : compare(left.account_id, right.account_id)) ||
        compare(left.kind, right.kind) ||
        compare(left.label, right.label),
    );
  return {
    hidden_providers: [
      ...new Set(preferences.hidden_providers.filter((value) => value.trim())),
    ].sort(compare),
    hidden_windows: windows.filter(
      (value, index) => index === 0 || JSON.stringify(windows[index - 1]) !== JSON.stringify(value),
    ),
  };
}
