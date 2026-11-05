import { describe, expect, it } from "vitest";
import {
  flattenQuotaWindows,
  lowestRemaining,
  isQuotaProviderSupported,
  providerHasPartialData,
  providerIsUnavailable,
  visibleQuotaWindows,
} from "./quota";
import type { QuotaProvider } from "@/core/types";

describe("quota display model", () => {
  it("keeps provider and account windows independently selectable", () => {
    const provider = fixture();
    const windows = flattenQuotaWindows(provider);

    expect(windows).toHaveLength(2);
    expect(windows[0].selector.account_id).toBeUndefined();
    expect(windows[1].selector.account_id).toBe("secondary");
    expect(
      visibleQuotaWindows(provider, {
        hidden_providers: [],
        hidden_windows: [windows[1].selector],
      }),
    ).toEqual([windows[0]]);
  });

  it("treats errors with usable windows as partial instead of unavailable", () => {
    const provider = { ...fixture(), error: "secondary endpoint unavailable" };

    expect(providerHasPartialData(provider)).toBe(true);
    expect(providerIsUnavailable(provider)).toBe(false);
  });

  it.each(["antigravity", "gemini", "kiro"])("does not expose unsupported provider %s", (id) => {
    expect(isQuotaProviderSupported({ id })).toBe(false);
  });

  it("keeps unknown providers available for future dashboard-v1 integrations", () => {
    expect(isQuotaProviderSupported({ id: "custom-coding-plan" })).toBe(true);
  });

  it("excludes unknown placeholder quota while keeping a genuine zero", () => {
    const provider = fixture();
    provider.windows = [
      {
        kind: "session",
        label: "Session",
        used_percent: 0,
        remaining_percent: 100,
        usage_known: false,
      },
    ];
    provider.accounts = [];
    expect(lowestRemaining(provider)).toBeUndefined();
    expect(providerIsUnavailable(provider)).toBe(true);
    provider.windows = [
      { ...provider.windows[0], used_percent: 100, remaining_percent: 0, usage_known: true },
    ];
    expect(lowestRemaining(provider)).toBe(0);
    expect(providerIsUnavailable(provider)).toBe(false);
  });
});

function fixture(): QuotaProvider {
  return {
    id: "codex",
    name: "Codex",
    enabled: true,
    windows: [{ kind: "weekly", label: "Weekly", used_percent: 20, remaining_percent: 80 }],
    accounts: [
      {
        id: "secondary",
        label: "Secondary",
        active: false,
        identity: { account_email: "secondary@example.com" },
        windows: [{ kind: "session", label: "5 hour", used_percent: 40, remaining_percent: 60 }],
      },
    ],
  };
}
