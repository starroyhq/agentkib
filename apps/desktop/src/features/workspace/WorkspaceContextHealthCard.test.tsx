// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { ContextDoctorSummary, DoctorIssue } from "@/core/types";
import { WorkspaceContextHealthCard } from "./WorkspaceContextHealthCard";
import { doctorIssueTitle } from "./doctor-presentation";

const healthy: ContextDoctorSummary = {
  workspace_id: "workspace-1",
  error_count: 0,
  warning_count: 0,
  info_count: 0,
  repairable_count: 0,
  checked_at: "2026-08-27T00:00:00Z",
};

function renderCard(summary?: ContextDoctorSummary, pendingReview = false) {
  const onOpenDoctor = vi.fn();
  const onOpenChanges = vi.fn();
  render(
    <WorkspaceContextHealthCard
      summary={summary}
      pendingReview={pendingReview}
      onOpenDoctor={onOpenDoctor}
      onOpenChanges={onOpenChanges}
    />,
  );
  return { onOpenDoctor, onOpenChanges };
}

describe("WorkspaceContextHealthCard", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => changeLocale("en-US"));
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "uses the Doctor issue title for context and unmanaged duplicates in %s",
    async (locale) => {
      await changeLocale(locale);
      for (const code of ["context.warning", "instruction.unmanaged-duplicate"]) {
        const issue: DoctorIssue = {
          id: code,
          code,
          severity: "warning",
          agent: "deepseek-harness",
          repairable: false,
          evidence: [
            {
              path: "/workspace/CLAUDE.md",
              detail:
                "DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import",
            },
          ],
        };
        const view = render(
          <WorkspaceContextHealthCard
            summary={{ ...healthy, warning_count: 1 }}
            issues={[issue]}
            pendingReview={false}
            onOpenDoctor={vi.fn()}
            onOpenChanges={vi.fn()}
          />,
        );
        expect(screen.getByRole("heading", { level: 2 }).textContent).toContain(
          doctorIssueTitle(issue, locale, tr),
        );
        view.unmount();
      }
      await changeLocale("en-US");
    },
  );

  it.each([
    ["zh-CN", "诊断正常 · 检查于 刚刚", "检查于 刚刚"],
    ["zh-TW", "診斷正常 · 檢查於 剛剛", "檢查於 剛剛"],
    ["en-US", "Diagnostics healthy · Checked just now", "Checked just now"],
    ["ja-JP", "診断は正常 · 最終確認：たった今", "最終確認：たった今"],
  ] as const)(
    "uses the Doctor recent check time for healthy and problematic results in %s",
    async (locale, healthyText, checkedText) => {
      await changeLocale(locale);
      const now = Date.parse("2026-10-24T12:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(now);
      const summary = { ...healthy, checked_at: new Date(now).toISOString() };
      const props = { pendingReview: false, onOpenDoctor: vi.fn(), onOpenChanges: vi.fn() };
      const view = render(<WorkspaceContextHealthCard {...props} summary={summary} />);
      expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(healthyText);
      view.rerender(
        <WorkspaceContextHealthCard {...props} summary={{ ...summary, warning_count: 1 }} />,
      );
      expect(
        screen.getByText(
          (content, element) => element?.tagName === "P" && content.endsWith(checkedText),
        ),
      ).toBeTruthy();
      await changeLocale("en-US");
    },
  );

  it("offers a diagnosis when no summary is available", () => {
    const { onOpenDoctor } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /View diagnostics/i }));

    expect(onOpenDoctor).toHaveBeenCalledOnce();
  });

  it("shows healthy and manual-only results", () => {
    const { rerender } = render(
      <WorkspaceContextHealthCard
        summary={healthy}
        pendingReview={false}
        onOpenDoctor={vi.fn()}
        onOpenChanges={vi.fn()}
      />,
    );
    expect(screen.getByText(/^Diagnostics healthy/)).toBeTruthy();

    rerender(
      <WorkspaceContextHealthCard
        summary={{ ...healthy, warning_count: 2 }}
        pendingReview={false}
        onOpenDoctor={vi.fn()}
        onOpenChanges={vi.fn()}
      />,
    );
    expect(screen.getByText("2 diagnostic issues found")).toBeTruthy();
  });

  it("opens Doctor for a repairable diagnosis", () => {
    const { onOpenDoctor } = renderCard({
      ...healthy,
      error_count: 3,
      repairable_count: 2,
    });

    expect(screen.getByText("3 diagnostic issues found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /View diagnostics/i }));
    expect(onOpenDoctor).toHaveBeenCalledOnce();
  });

  it.each([
    [1, 0, "1 warning"],
    [0, 1, "1 error"],
    [2, 3, "2 warnings · 3 errors"],
  ] as const)("omits zero counts for %i warnings and %i errors", (warnings, errors, expected) => {
    renderCard({ ...healthy, warning_count: warnings, error_count: errors });
    expect(screen.getByText(new RegExp(`^${expected} · Checked`))).toBeTruthy();
    expect(screen.queryByText(/\b0 (warnings|errors)\b/)).toBeNull();
  });

  it("retains pending review without hiding the diagnosis summary", () => {
    const { onOpenChanges } = renderCard({ ...healthy, error_count: 3, repairable_count: 2 }, true);

    expect(screen.getByText("Repair plan awaiting review")).toBeTruthy();
    expect(screen.getByText("3 diagnostic issues found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Review pending changes/i }));
    expect(onOpenChanges).toHaveBeenCalledOnce();
  });

  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "names the duplicate files in %s without exposing raw evidence",
    async (locale) => {
      await initializeI18n(locale);
      render(
        <WorkspaceContextHealthCard
          summary={{ ...healthy, warning_count: 1 }}
          issues={[
            {
              id: "duplicate",
              code: "instruction.exact-duplicate",
              severity: "warning",
              agent: "grok-build",
              repairable: false,
              evidence: [
                {
                  path: "/fixture/project/CLAUDE.md",
                  detail: "Exact duplicate of /fixture/project/AGENTS.md",
                },
              ],
            },
          ]}
          pendingReview={false}
          onOpenDoctor={vi.fn()}
          onOpenChanges={vi.fn()}
        />,
      );
      const files = {
        "zh-CN": "CLAUDE.md 与 AGENTS.md",
        "zh-TW": "CLAUDE.md 與 AGENTS.md",
        "en-US": "CLAUDE.md and AGENTS.md",
        "ja-JP": "CLAUDE.md と AGENTS.md",
      };
      expect(screen.getByRole("heading").textContent).toContain(files[locale]);
      expect(screen.queryByText(/Exact duplicate of/)).toBeNull();
      expect(screen.getByRole("button").className).toContain("border");
      await initializeI18n("en-US");
    },
  );
});
