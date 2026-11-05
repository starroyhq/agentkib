// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import { initializeI18n, tr } from "@/core/i18n";
import type { QuotaSnapshot, RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { QuotaPage } from "./QuotaPage";
import { localCostFixture } from "./__fixtures__/local-cost";

vi.mock("@/core/api", () => ({
  api: {
    quotaSnapshot: vi.fn(),
    quotaCollectorStatus: vi.fn(),
    quotaPopoverPreferences: vi.fn(),
    refreshStatus: vi.fn(),
    refreshQuota: vi.fn(),
    localCostSnapshot: vi.fn(),
    localCostStatus: vi.fn(),
    refreshLocalCost: vi.fn(),
    observeLocalCosts: vi.fn(),
  },
}));

const snapshot: QuotaSnapshot = {
  schema_version: 1,
  backend: "codex-bar-cli",
  generated_at: "2026-09-09T01:00:00Z",
  fetched_at: "2026-09-09T01:00:00Z",
  stale_after_seconds: 300,
  freshness: "stale",
  providers: [
    {
      id: "codex",
      name: "Codex",
      enabled: true,
      accounts: [],
      error: "codex cost refresh timed out",
      windows: [
        {
          kind: "weekly",
          label: "Weekly",
          remaining_percent: 13,
          used_percent: 87,
          reset_at: "2026-09-10T01:00:00Z",
        },
      ],
    },
  ],
};

describe("quota page diagnostics", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
    vi.clearAllMocks();
    useAppStore.getState().setRuntime({
      quota_auto_refresh_enabled: false,
      quota_auto_refresh_prompt_seen: true,
    } as RuntimeInfo);
    vi.mocked(api.quotaSnapshot).mockResolvedValue(snapshot);
    vi.mocked(api.quotaCollectorStatus).mockResolvedValue({
      backend: "codex-bar-cli",
      platform_supported: true,
      sidecar_available: true,
      config_source: "agentkib-managed",
      running: false,
      last_attempt_at: "2026-10-08T05:57:00Z",
    });
    vi.mocked(api.quotaPopoverPreferences).mockResolvedValue({
      hidden_providers: [],
      hidden_windows: [],
    });
    vi.mocked(api.refreshStatus).mockResolvedValue([]);
    vi.mocked(api.localCostSnapshot).mockResolvedValue(undefined);
    vi.mocked(api.localCostStatus).mockResolvedValue({
      provider: "codex",
      scope_key: "scope-codex",
      state: "idle",
    });
    vi.mocked(api.observeLocalCosts).mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
  });

  it("exposes partial collection warnings and current diagnostics alongside cached quota", async () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <QuotaPage popoverSupported={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(tr("quota.staleReset"))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("quota.partialData") }));
    expect(screen.getByText("codex cost refresh timed out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("quota.diagnostics") }));
    expect(screen.getByText(tr("quota.lastAttempt"))).toBeTruthy();
    expect(screen.getByText(tr("common.disabled"))).toBeTruthy();
    expect(api.refreshQuota).not.toHaveBeenCalled();
    client.clear();
  });

  it("refreshes quota without waiting for a slow independent cost scan", async () => {
    vi.mocked(api.localCostSnapshot).mockResolvedValue(localCostFixture());
    vi.mocked(api.refreshLocalCost).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.refreshQuota).mockResolvedValue({
      kind: "quota",
      disposition: "queued",
      request_id: "quota-now",
      status: { kind: "quota", state: "succeeded", request_id: "quota-now" },
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <QuotaPage popoverSupported={false} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: tr("quota.cost.title") })).toBeTruthy();
    const refresh = screen.getByRole("button", { name: tr("quota.refresh") });
    fireEvent.click(refresh);
    await waitFor(() => expect(api.refreshQuota).toHaveBeenCalledTimes(1));
    expect(api.refreshLocalCost).toHaveBeenCalledWith("codex", true);
    await waitFor(() => expect(refresh.getAttribute("aria-busy")).toBe("false"));
    expect(screen.getAllByText("13%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/USD\s*1\.25/).length).toBeGreaterThan(0);
    client.clear();
  });

  it.each(["idle", "failed"] as const)(
    "keeps local cost available before any quota collection has succeeded (%s)",
    async (state) => {
      vi.mocked(api.quotaSnapshot).mockResolvedValue(undefined);
      vi.mocked(api.quotaCollectorStatus).mockResolvedValue({
        backend: "codex-bar-cli",
        platform_supported: true,
        sidecar_available: true,
        config_source: "agentkib-managed",
        running: false,
        providers: { codex: { state } },
      });
      vi.mocked(api.localCostSnapshot).mockResolvedValue(localCostFixture());
      const client = new QueryClient();
      render(
        <QueryClientProvider client={client}>
          <QuotaPage popoverSupported={false} />
        </QueryClientProvider>,
      );
      expect(await screen.findByRole("heading", { name: tr("quota.cost.title") })).toBeTruthy();
      expect(screen.getByRole("tab", { name: /Codex/ })).toBeTruthy();
      expect(screen.getAllByText(/USD\s*1\.25/).length).toBeGreaterThan(0);
      expect(screen.queryByRole("progressbar")).toBeNull();
      client.clear();
    },
  );
});
