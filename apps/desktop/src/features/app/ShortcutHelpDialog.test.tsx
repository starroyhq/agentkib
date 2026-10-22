// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog";
import { createGlobalNavigation } from "./global-navigation";
import { KeyboardShortcutsSettings } from "@/features/settings/KeyboardShortcutsSettings";

const displayCases = (["macos", "windows", "linux"] as const).flatMap((platform) =>
  (["zh-CN", "zh-TW", "en-US", "ja-JP"] as const).map((locale) => ({ platform, locale })),
);

function navigationRows() {
  const section = screen
    .getByRole("heading", { name: tr("shortcuts.group.navigation") })
    .closest("section")!;
  return Array.from(section.querySelectorAll("kbd")).map((key) => [
    key.previousElementSibling?.textContent,
    key.textContent,
  ]);
}

describe("ShortcutHelpDialog", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("shows navigation and action shortcuts for the current platform", () => {
    document.documentElement.dataset.platform = "windows";
    render(<ShortcutHelpDialog open onOpenChange={() => undefined} />);

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Navigation")).toBeTruthy();
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Ctrl+1")).toBeTruthy();
    expect(screen.getByText("Ctrl+Shift+O")).toBeTruthy();
    expect(screen.getByText("Toggle sidebar")).toBeTruthy();
  });

  it.each(displayCases)(
    "matches sidebar labels and page order in help and settings for $platform/$locale",
    async ({ platform, locale }) => {
      document.documentElement.dataset.platform = platform;
      await act(() => changeLocale(locale));
      try {
        const entries = createGlobalNavigation(0);
        expect(entries.map((entry) => entry.id)).toEqual([
          "home",
          "workspaces",
          "sessions",
          "catalog",
          "quota",
          "insights",
        ]);
        const expectedPages = entries.map((entry, index) => [
          tr(entry.label),
          `${platform === "macos" ? "⌘" : "Ctrl+"}${index + 1}`,
        ]);
        const settingsShortcut = `${platform === "macos" ? "⌘" : "Ctrl+"},`;
        const expected = [
          ...expectedPages,
          [tr("menu.settings"), settingsShortcut],
          [tr("shortcuts.back"), platform === "macos" ? "⌘[" : "Alt+←"],
          [tr("shortcuts.forward"), platform === "macos" ? "⌘]" : "Alt+→"],
        ];
        const help = render(<ShortcutHelpDialog open onOpenChange={() => undefined} />);
        expect(navigationRows()).toEqual(expected);
        expect(navigationRows().filter(([label]) => label === tr("menu.settings"))).toEqual([
          [tr("menu.settings"), settingsShortcut],
        ]);
        help.unmount();
        render(<KeyboardShortcutsSettings />);
        expect(navigationRows()).toEqual(expected);
        expect(navigationRows().filter(([label]) => label === tr("menu.settings"))).toEqual([
          [tr("menu.settings"), settingsShortcut],
        ]);
        expect(screen.getByText(tr("sessions.nav"))).toBeVisible();
        expect(screen.getByText(tr("nav.catalog"))).toBeVisible();
      } finally {
        await act(() => changeLocale("en-US"));
      }
    },
  );
});
