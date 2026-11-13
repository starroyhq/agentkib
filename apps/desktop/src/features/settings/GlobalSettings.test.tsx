// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { changeLocale, formatDateTime, initializeI18n, tr } from "@/core/i18n";
import { AppDialogProvider } from "@/components/AppDialogProvider";
import type { GlobalSettingsProps } from "./GlobalSettings";
import { GlobalSettings } from "./GlobalSettings";

const noop = async () => undefined;
const baseProps: GlobalSettingsProps = {
  section: "diagnostics",
  workspaces: [],
  remoteGateways: [],
  scanRoots: [],
  excluded: [],
  activity: [],
  onAddRoot: noop,
  onRemoveRoot: noop,
  onRestore: noop,
  onCloseBehaviorChanged: noop,
  onLocaleChanged: () => undefined,
  onSessionIndexCleared: () => undefined,
  onOnboardingRestarted: noop,
  onRemoteGatewaysChanged: noop,
  onRefreshDiagnostics: noop,
};

const quotaStatus: NonNullable<GlobalSettingsProps["quotaStatus"]> = {
  backend: "codex-bar-cli",
  platform_supported: true,
  sidecar_available: true,
  config_source: "bundled",
  running: false,
};

const insightsStatus: NonNullable<GlobalSettingsProps["insightsStatus"]> = {
  providers: [],
  running: false,
};

describe("GlobalSettings diagnostics health", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("refreshes nested activity labels and dates for every supported locale", async () => {
    const createdAt = "2026-09-02T08:00:00Z";
    const { container } = render(
      <GlobalSettings
        {...baseProps}
        quotaStatus={quotaStatus}
        insightsStatus={insightsStatus}
        activity={[
          {
            id: "discovery",
            action: "discovery.complete",
            detail: "2 workspaces, 0 errors",
            created_at: createdAt,
          },
        ]}
      />,
    );
    const time = container.querySelector("time");
    expect(time?.textContent).toBe(formatDateTime(createdAt));

    try {
      for (const locale of ["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByText(tr("activity.action.discovery.complete"))).toBeTruthy();
        expect(container.querySelector("time")).toBe(time);
        expect(time?.textContent).toBe(formatDateTime(createdAt));
        expect(
          screen.getByRole("heading", { name: tr("settings.section.diagnostics") }),
        ).toBeTruthy();
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it("gives adjacent settings controls localized accessible names", async () => {
    try {
      for (const locale of ["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));

        const general = render(<GlobalSettings {...baseProps} section="general" />);
        expect(screen.getByRole("switch", { name: tr("settings.localAutoRefresh") })).toBeTruthy();
        expect(screen.getByRole("switch", { name: tr("settings.quotaAutoRefresh") })).toBeTruthy();
        general.unmount();

        const privacy = render(
          <AppDialogProvider>
            <GlobalSettings {...baseProps} section="privacy" />
          </AppDialogProvider>,
        );
        expect(screen.getByRole("switch", { name: tr("conversations.indexSetting") })).toBeTruthy();
        expect(
          screen.getByRole("textbox", { name: tr("settings.gitAliasPlaceholder") }),
        ).toBeTruthy();
        privacy.unmount();
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });

  it.each([
    { quotaStatus: undefined, insightsStatus },
    { quotaStatus, insightsStatus: undefined },
  ])("does not report healthy until both diagnostic datasets load", (statusProps) => {
    render(<GlobalSettings {...baseProps} {...statusProps} />);

    expect(screen.queryByText("Running normally")).toBeNull();
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });

  it("reports healthy only when both datasets are available without issues", () => {
    render(
      <GlobalSettings {...baseProps} quotaStatus={quotaStatus} insightsStatus={insightsStatus} />,
    );

    expect(screen.getByText("Running normally")).toBeTruthy();
  });

  it("reports attention when a supported provider is unavailable", () => {
    render(
      <GlobalSettings
        {...baseProps}
        quotaStatus={quotaStatus}
        insightsStatus={{
          ...insightsStatus,
          providers: [
            {
              agent: "codex",
              available: false,
              quality: "incomplete",
              imported_events: 0,
            },
          ],
        }}
      />,
    );

    expect(screen.queryByText("Running normally")).toBeNull();
    expect(screen.getByText("Needs attention")).toBeTruthy();
  });

  it("renders source diagnostics and their full path when the runtime provides them", () => {
    render(
      <GlobalSettings
        {...baseProps}
        section="discovery"
        discovery={{
          started_at: "2026-09-08T08:00:00Z",
          finished_at: "2026-09-08T08:00:01Z",
          discovered_count: 1,
          removed_count: 0,
          errors: [],
          source_diagnostics: [
            {
              agent: "open-claw",
              source: "sessions",
              path: "/Users/example/.open-claw/very/deep/sessions.jsonl",
              status: "partial",
              started_at: "2026-09-08T08:00:00Z",
              finished_at: "2026-09-08T08:00:01Z",
              candidate_count: 4,
              included_count: 1,
              skipped_count: 3,
              reasons: ["source-read-failed"],
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Discovery sources" })).toBeTruthy();
    expect(screen.getByText("OpenClaw · sessions")).toBeTruthy();
    expect(screen.getByText("Partial")).toBeTruthy();
    expect(screen.getByText("/Users/example/.open-claw/very/deep/sessions.jsonl")).toBeTruthy();
    expect(screen.queryByText("source-read-failed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /OpenClaw · sessions/ }));
    expect(screen.getAllByText("/Users/example/.open-claw/very/deep/sessions.jsonl").length).toBe(
      2,
    );
    expect(screen.getByText("Source could not be read")).toBeTruthy();
  });

  it("explains when an old runtime has no source diagnostics", () => {
    render(
      <GlobalSettings
        {...baseProps}
        section="discovery"
        discovery={{
          started_at: "2026-09-08T08:00:00Z",
          finished_at: "2026-09-08T08:00:01Z",
          discovered_count: 0,
          removed_count: 0,
          errors: [],
        }}
      />,
    );

    expect(
      screen.getByText("Detailed source diagnostics are unavailable in this runtime."),
    ).toBeTruthy();
  });
});
