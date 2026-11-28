// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDateTime, initializeI18n, tr } from "@/core/i18n";
import type { QuotaCollectorStatus, RuntimeInfo } from "@/core/types";
import { useAppStore } from "@/stores/app-store";
import { QuotaDiagnostics } from "./QuotaDiagnostics";

const status: QuotaCollectorStatus = {
  backend: "codex-bar-cli",
  platform_supported: true,
  sidecar_available: true,
  config_source: "agentkib-managed",
  running: false,
  last_attempt_at: "2026-10-08T05:57:00Z",
  last_success_at: "2026-09-09T01:00:00Z",
  error_key: "errors.quotaUnavailable",
  error_detail: "codex: request timed out; claude: usage unavailable",
};

describe("quota diagnostics", () => {
  beforeEach(async () => {
    await initializeI18n("en-US");
    useAppStore.getState().reset();
  });
  afterEach(() => {
    cleanup();
    useAppStore.getState().reset();
  });

  it("distinguishes the failed attempt from cached success and exposes its detail", () => {
    render(<QuotaDiagnostics status={status} />);
    const attemptRow = screen.getByText(tr("quota.lastAttempt")).parentElement!;
    const successRow = screen.getByText(tr("quota.lastSuccess")).parentElement!;
    expect(within(attemptRow).getByText(formatDateTime(status.last_attempt_at!))).toBeTruthy();
    expect(within(successRow).getByText(formatDateTime(status.last_success_at!))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("common.details") }));
    expect(screen.getByText(status.error_detail!)).toBeTruthy();
  });

  it("reports unknown, disabled and enabled automatic refresh without changing it", () => {
    render(<QuotaDiagnostics status={status} />);
    const row = screen.getByText(tr("settings.quotaAutoRefresh")).parentElement!;
    expect(within(row).getByText("—")).toBeTruthy();
    act(() =>
      useAppStore.getState().setRuntime({ quota_auto_refresh_enabled: false } as RuntimeInfo),
    );
    expect(within(row).getByText(tr("common.disabled"))).toBeTruthy();
    act(() =>
      useAppStore.getState().setRuntime({ quota_auto_refresh_enabled: true } as RuntimeInfo),
    );
    expect(within(row).getByText(tr("common.enabled"))).toBeTruthy();
  });

  it("uses natural quota collector service wording without exposing internal collector names", async () => {
    await initializeI18n("zh-CN");
    render(<QuotaDiagnostics status={{ ...status, backend_version: "0.4.2" }} />);
    expect(screen.getByText("额度采集服务")).toBeTruthy();
    expect(screen.getByText("可用 · 0.4.2")).toBeTruthy();
    expect(screen.queryByText(/CodexBarCLI|Sidecar/i)).toBeNull();
  });
});
