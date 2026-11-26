// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
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

describe("GlobalSettings session preferences", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("loads and saves the quit continuation default under Sessions", async () => {
    const label = "Tasks in progress when quitting";
    const initialRuntime = {
      resume_after_quit: true,
    } as NonNullable<GlobalSettingsProps["runtime"]>;
    let saved = true;
    const setQuitResumePreference = vi.fn(async (value: boolean) => {
      saved = value;
    });
    const runtime = vi.fn(async () => ({ ...initialRuntime, resume_after_quit: saved }));
    vi.stubGlobal("agentkibDesktop", {
      ...window.agentkibDesktop,
      home: { runtime },
      settings: { setQuitResumePreference },
    });
    function Settings({ section }: Pick<GlobalSettingsProps, "section">) {
      const [current, setCurrent] = useState(initialRuntime);
      return (
        <GlobalSettings
          {...baseProps}
          section={section}
          runtime={current}
          onLocaleChanged={setCurrent}
        />
      );
    }

    try {
      const user = userEvent.setup();
      const view = render(<Settings section="general" />);
      expect(screen.queryByRole("combobox", { name: label })).toBeNull();
      view.rerender(<Settings section="sessions" />);
      const select = screen.getByRole<HTMLSelectElement>("combobox", { name: label });
      expect(select.value).toBe("continue");
      expect([...select.options].map((option) => option.text)).toEqual([
        "Continue next time AgentKib opens",
        "Do not continue",
      ]);

      await user.selectOptions(select, "stop");
      await waitFor(() => expect(select.value).toBe("stop"));
      expect(setQuitResumePreference).toHaveBeenLastCalledWith(false);
      expect(runtime).toHaveBeenCalledTimes(1);

      view.rerender(<Settings section="general" />);
      view.rerender(<Settings section="sessions" />);
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: label }).value).toBe("stop");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the existing send and auto-continue preferences readable and writable under Sessions", async () => {
    const key = "agentkib.send-while-running";
    const previous = localStorage.getItem(key);
    const request = vi.fn().mockResolvedValueOnce({ autoContinue: false });
    vi.stubGlobal("agentkibDesktop", {
      ...window.agentkibDesktop,
      claude: { request },
    });
    localStorage.setItem(key, "steer");
    const user = userEvent.setup();
    const sendLabel = tr("conversation.sendWhileRunning");
    const autoContinueLabel = tr("settings.usageLimitAutoContinue");

    try {
      const view = render(<GlobalSettings {...baseProps} section="general" />);
      expect(screen.queryByRole("combobox", { name: sendLabel })).toBeNull();
      expect(screen.queryByRole("switch", { name: autoContinueLabel })).toBeNull();

      view.rerender(<GlobalSettings {...baseProps} section="sessions" />);
      expect(screen.getByRole("heading", { name: "Sessions" })).toBeTruthy();
      const sendMode = screen.getByRole("combobox", { name: sendLabel });
      expect(sendMode.textContent).toContain(tr("conversation.sendWhileRunningSteer"));
      const autoContinue = screen.getByRole("switch", { name: autoContinueLabel });
      await waitFor(() => expect(autoContinue.getAttribute("aria-checked")).toBe("false"));
      expect(request).toHaveBeenLastCalledWith({ operation: "usage-limit-auto-continue" });

      await user.click(sendMode);
      await user.click(
        await screen.findByRole("option", { name: tr("conversation.sendWhileRunningQueue") }),
      );
      expect(localStorage.getItem(key)).toBe("queue");
      request.mockResolvedValueOnce({ autoContinue: true });
      await user.click(autoContinue);
      await waitFor(() => expect(autoContinue.getAttribute("aria-checked")).toBe("true"));
      expect(request).toHaveBeenLastCalledWith({
        operation: "usage-limit-auto-continue",
        enabled: true,
      });
    } finally {
      if (previous === null) localStorage.removeItem(key);
      else localStorage.setItem(key, previous);
      vi.unstubAllGlobals();
    }
  });
});

describe("GlobalSettings diagnostics health", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("exports from the diagnostics header and keeps the action disabled until it settles", async () => {
    let finish!: () => void;
    const exportReport = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    vi.stubGlobal("agentkibDesktop", {
      ...window.agentkibDesktop,
      diagnostics: { exportReport },
    });
    try {
      render(<GlobalSettings {...baseProps} />);
      const header = screen.getByRole("heading", { name: tr("settings.section.diagnostics") });
      const button = screen.getByRole<HTMLButtonElement>("button", {
        name: tr("settings.diagnostics.export"),
      });
      expect(header.closest("header")?.contains(button)).toBe(true);
      await userEvent.click(button);
      expect(exportReport).toHaveBeenCalledOnce();
      expect(button.disabled).toBe(true);
      await act(() => finish());
      expect(button.disabled).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

  it("offers a diagnostics retry only after a failed read", async () => {
    const retry = vi.fn().mockResolvedValue(undefined);
    const props = { ...baseProps, quotaStatus, insightsStatus, onRefreshDiagnostics: retry };
    const { rerender } = render(<GlobalSettings {...props} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: tr("menu.refreshCurrent") })).toBeNull();
    rerender(<GlobalSettings {...props} diagnosticsFailed />);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    rerender(<GlobalSettings {...props} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
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
