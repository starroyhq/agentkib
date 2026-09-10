// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";
import { SettingsSidebar } from "./SettingsSidebar";
import { settingsTargetId } from "./components/SettingsLayout";

describe("SettingsSidebar v9 navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  afterEach(cleanup);

  it("closes the settings drawer when global search opens without losing the search action", () => {
    const onOpenSearch = vi.fn();
    const props = {
      active: "general" as const,
      onSelect: vi.fn(),
      onBack: vi.fn(),
      onOpenSearch,
      collapsed: false,
    };
    const { container, rerender } = render(<SettingsSidebar {...props} searchOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: tr("settings.navigation") }));
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("search.open") }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    rerender(<SettingsSidebar {...props} searchOpen />);
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
    rerender(<SettingsSidebar {...props} searchOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: tr("settings.navigation") }));
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    rerender(<SettingsSidebar {...props} searchOpen />);
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("keeps global search separate from the local settings filter", () => {
    const onOpenSearch = vi.fn();
    const onSelect = vi.fn();
    const { container } = render(
      <SettingsSidebar
        active="general"
        onBack={() => undefined}
        onSelect={onSelect}
        onOpenSearch={onOpenSearch}
        collapsed={false}
      />,
    );
    const localSearch = screen.getByRole("searchbox", { name: "Search settings…" });
    fireEvent.change(localSearch, { target: { value: "Vault" } });
    fireEvent.click(screen.getByRole("button", { name: tr("search.open") }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    expect((localSearch as HTMLInputElement).value).toBe("Vault");
    expect(onSelect).not.toHaveBeenCalled();
    const row = container.querySelector(".app-sidebar-header-row")!;
    expect(row.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Obsidian" })).toBeTruthy();
  });

  it("shows only the back entry and eight settings sections", () => {
    const { container } = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="general"
          onSelect={() => undefined}
          onBack={() => undefined}
          onSettings={() => undefined}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Theme & appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tools & updates" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search settings…" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(10);
    expect(screen.getByRole("button", { name: "Remote connections" })).toBeTruthy();
  });

  it("searches settings content and selects the matching target", () => {
    const onSelect = vi.fn();
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="general"
          onSelect={onSelect}
          onBack={() => undefined}
          collapsed={false}
        />
      </ShortcutHelpProvider>,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings…" }), {
      target: { value: "Vault" },
    });

    expect(screen.queryByRole("button", { name: "General" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Obsidian" }));
    expect(onSelect).toHaveBeenCalledWith("integrations", "integrations-obsidian");
  });

  it("scrolls to an already-active search result every time it is selected", () => {
    const onSelect = vi.fn();
    const view = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="integrations"
          activeTarget="integrations-obsidian"
          onSelect={onSelect}
          onBack={() => undefined}
          collapsed={false}
        />
        <div id={settingsTargetId("integrations-obsidian")} tabIndex={-1} />
      </ShortcutHelpProvider>,
    );
    const target = view.container.querySelector<HTMLElement>(
      `#${settingsTargetId("integrations-obsidian")}`,
    )!;
    const scrollIntoView = vi.spyOn(target, "scrollIntoView");
    const focus = vi.spyOn(target, "focus");
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false })),
    });

    try {
      fireEvent.change(screen.getByRole("searchbox", { name: "Search settings…" }), {
        target: { value: "Vault" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Obsidian" }));
      fireEvent.click(screen.getByRole("button", { name: "Obsidian" }));

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
      expect(focus).toHaveBeenCalledTimes(2);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("shows an empty state and clears the search", () => {
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="general"
          onSelect={() => undefined}
          onBack={() => undefined}
          collapsed={false}
        />
      </ShortcutHelpProvider>,
    );

    const search = screen.getByRole("searchbox", { name: "Search settings…" });
    fireEvent.change(search, { target: { value: "not-a-setting" } });
    expect(screen.getByText("No matching settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear settings search" }));
    expect(screen.getByRole("button", { name: "General" })).toBeTruthy();
  });

  it("recomputes search matches when the locale changes", async () => {
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar
          active="general"
          onSelect={() => undefined}
          onBack={() => undefined}
          collapsed={false}
        />
      </ShortcutHelpProvider>,
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings…" }), {
      target: { value: "Privacy" },
    });
    expect(screen.getByRole("button", { name: "Local Data" })).toBeTruthy();

    try {
      await act(() => changeLocale("zh-CN"));
      expect(
        screen.getByRole("searchbox", { name: tr("settings.search.placeholder") }),
      ).toBeTruthy();
      expect(screen.getByText("没有匹配的设置")).toBeTruthy();
    } finally {
      await act(() => changeLocale("en-US"));
    }
  });
});
