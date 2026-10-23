// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import type { WorkspaceSummary } from "@/core/types";
import { PendingTasksCard } from "./HomeTaskCards";

const first: WorkspaceSummary = {
  id: "first",
  name: "Alpha",
  path: "/alpha",
  status: "healthy",
  sources: [],
  asset_count: 0,
  warning_count: 0,
};
const second: WorkspaceSummary = { ...first, id: "second", name: "Beta", path: "/beta" };
const locales = [
  ["zh-CN", "查看诊断"],
  ["zh-TW", "查看診斷"],
  ["ja-JP", "診断を表示"],
  ["en-US", "View diagnostics"],
] as const;

function renderCard(workspaces: WorkspaceSummary[], attention: WorkspaceSummary[] = []) {
  const onOpenDoctor = vi.fn().mockResolvedValue(undefined);
  render(
    <PendingTasksCard
      pending={0}
      issueCount={0}
      issuesPending={false}
      workspaces={workspaces}
      attention={attention}
      doctorSummaries={{}}
      onOpenDoctor={onOpenDoctor}
      onOpenAssets={vi.fn()}
    />,
  );
  return onOpenDoctor;
}

afterEach(cleanup);

describe("empty pending-task diagnostics action", () => {
  it.each(locales)(
    "uses the diagnostics name and opens the sole workspace in %s",
    async (locale, label) => {
      await initializeI18n(locale);
      const onOpenDoctor = renderCard([first]);
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onOpenDoctor).toHaveBeenCalledExactlyOnceWith(first);
    },
  );

  it.each(locales)(
    "names the selected workspace when several exist in %s",
    async (locale, label) => {
      await initializeI18n(locale);
      const onOpenDoctor = renderCard([first, second]);
      const button = screen.getByRole("button");
      expect(button).toHaveTextContent(label);
      expect(button).toHaveTextContent(first.name);
      expect(button).not.toHaveTextContent(second.name);
      fireEvent.click(button);
      expect(onOpenDoctor).toHaveBeenCalledExactlyOnceWith(first);
    },
  );

  it("keeps the displayed name aligned with the preferred attention workspace", async () => {
    await initializeI18n("en-US");
    const onOpenDoctor = renderCard([first, second], [second]);
    const button = screen.getByRole("button", { name: "View diagnostics: Beta" });
    fireEvent.click(button);
    expect(onOpenDoctor).toHaveBeenCalledExactlyOnceWith(second);
  });

  it("does not offer diagnostics when there is no workspace", async () => {
    await initializeI18n("en-US");
    renderCard([]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not call an unchecked workspace healthy", async () => {
    await initializeI18n("en-US");
    renderCard([first]);
    expect(screen.getByText(tr("home.uncheckedWorkspaces"))).toBeVisible();
    expect(screen.queryByText(tr("home.allClear"))).toBeNull();
  });

  it("updates the named action when switching languages without changing its destination", async () => {
    await initializeI18n("en-US");
    const onOpenDoctor = renderCard([first, second]);
    const button = screen.getByRole("button", { name: "View diagnostics: Alpha" });
    await act(() => changeLocale("zh-CN"));
    expect(screen.getByRole("button", { name: "查看诊断：Alpha" })).toBe(button);
    fireEvent.click(button);
    expect(onOpenDoctor).toHaveBeenCalledExactlyOnceWith(first);
  });
});
