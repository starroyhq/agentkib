// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { HistoryError, HistoryWarning } from "./HistoryFeedback";

describe("HistoryFeedback", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it.each([
    ["TRANSCRIPT_CURSOR_INVALID", "history.error.cursor"],
    ["TRANSCRIPT_CURSOR_STALE", "history.error.cursor"],
    ["TRANSCRIPT_UNREADABLE", "history.error.unavailable"],
    ["REMOTE_SESSION_NOT_FOUND", "history.error.unavailable"],
    ["TRANSCRIPT_SCAN_STATE_LIMIT", "history.error.scanState"],
    ["Transcript exceeds the 256 MiB read limit", "history.error.legacyLimit"],
    ["Unexpected provider detail", "history.error.read"],
  ])("presents %s with a translated explanation and collapsed diagnostic", (code, key) => {
    const retry = vi.fn();
    render(<HistoryError error={new Error(`RuntimeRequestError: ${code}`)} onRetry={retry} />);
    expect(screen.getByText(tr(key))).toBeVisible();
    const disclosure = screen.getByRole("button", { name: tr("errors.details") });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(`RuntimeRequestError: ${code}`)).toBeNull();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(`RuntimeRequestError: ${code}`)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: tr("sessions.retry") }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("updates known errors and budget warnings across all languages without remounting", async () => {
    render(
      <>
        <HistoryError error="TRANSCRIPT_CURSOR_STALE" />
        <HistoryWarning warning="TRANSCRIPT_SCAN_BUDGET" />
        <HistoryWarning warning="TRANSCRIPT_ASSOCIATION_WINDOW" />
      </>,
    );
    const alert = screen.getByRole("alert");
    try {
      for (const locale of ["zh-CN", "zh-Hant", "ja-JP", "en-US"] as const) {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("alert")).toBe(alert);
        expect(screen.getByText(tr("history.error.cursor"))).toBeVisible();
        expect(screen.getByText(tr("history.warning.scanBudget"))).toBeVisible();
        expect(screen.getByText(tr("history.warning.associationWindow"))).toBeVisible();
      }
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
});
