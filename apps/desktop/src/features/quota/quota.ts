import type {
  QuotaAccount,
  QuotaPopoverPreferences,
  QuotaProvider,
  QuotaWindow,
  QuotaWindowSelector,
} from "@/core/types";

export type QuotaSeverity = "healthy" | "warning" | "danger";

// CodexBar may report providers that AgentKib has not verified end to end yet.
// Keep parsing their data, but do not present them as broken integrations.
const unsupportedQuotaProviderIds = new Set(["antigravity", "gemini", "kiro"]);

export interface QuotaDisplayWindow {
  key: string;
  selector: QuotaWindowSelector;
  providerId: string;
  providerName: string;
  account?: QuotaAccount;
  accountLabel?: string;
  window: QuotaWindow;
}

export function isQuotaProviderSupported(provider: Pick<QuotaProvider, "id">) {
  return !unsupportedQuotaProviderIds.has(provider.id.trim().toLocaleLowerCase());
}

export function quotaWindowKey(selector: QuotaWindowSelector) {
  return JSON.stringify([
    selector.provider_id,
    selector.account_id ?? null,
    selector.kind,
    selector.label,
  ]);
}

export function flattenQuotaWindows(provider: QuotaProvider): QuotaDisplayWindow[] {
  const direct = provider.windows.map((window) => displayWindow(provider, undefined, window));
  const accounts = provider.accounts.flatMap((account) =>
    account.windows.map((window) => displayWindow(provider, account, window)),
  );
  return [...direct, ...accounts];
}

function displayWindow(
  provider: QuotaProvider,
  account: QuotaAccount | undefined,
  window: QuotaWindow,
): QuotaDisplayWindow {
  const selector: QuotaWindowSelector = {
    provider_id: provider.id,
    account_id: account?.id,
    kind: window.kind,
    label: window.label,
  };
  return {
    key: quotaWindowKey(selector),
    selector,
    providerId: provider.id,
    providerName: provider.name,
    account,
    accountLabel: account?.identity?.account_email ?? account?.label,
    window,
  };
}

export function visibleQuotaWindows(provider: QuotaProvider, preferences: QuotaPopoverPreferences) {
  if (preferences.hidden_providers.includes(provider.id)) return [];
  const hidden = new Set(preferences.hidden_windows.map(quotaWindowKey));
  return flattenQuotaWindows(provider).filter((item) => !hidden.has(item.key));
}

export function lowestRemaining(provider: QuotaProvider) {
  const values = flattenQuotaWindows(provider)
    .filter(({ window }) => window.usage_known !== false)
    .map(({ window }) => window.remaining_percent)
    .filter(
      (remaining): remaining is number =>
        typeof remaining === "number" && Number.isFinite(remaining),
    );
  return values.length ? Math.min(...values) : undefined;
}

export function quotaSeverity(remaining: number): QuotaSeverity {
  return remaining <= 10 ? "danger" : remaining <= 20 ? "warning" : "healthy";
}

export function compareQuotaProviders(left: QuotaProvider, right: QuotaProvider) {
  return (
    (lowestRemaining(left) ?? 101) - (lowestRemaining(right) ?? 101) ||
    left.name.localeCompare(right.name)
  );
}

export function providerIsUnavailable(provider: QuotaProvider) {
  return lowestRemaining(provider) === undefined;
}

export function providerHasPartialData(provider: QuotaProvider) {
  return Boolean(provider.error) && !providerIsUnavailable(provider);
}
