// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";
import { useSidebarViewStore } from "@/features/app/sidebar-view-store";
import { SettingsSidebar } from "./SettingsSidebar";
import { settingsTargetId } from "./components/SettingsLayout";

describe("SettingsSidebar v9 navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => useSidebarViewStore.setState({ settingsQuery: "" }));
  afterEach(cleanup);

  it("keeps the settings search when the embedded sidebar remounts", () => {
    const view = render(<SettingsSidebar active="general" onSelect={() => undefined} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings…" }), {
      target: { value: "Vault" },
    });
    view.unmount();
    render(<SettingsSidebar active="general" onSelect={() => undefined} />);
    expect(
      (screen.getByRole("searchbox", { name: "Search settings…" }) as HTMLInputElement).value,
    ).toBe("Vault");
    expect(screen.getByRole("button", { name: "Obsidian" })).toBeTruthy();
  });

  it("shows the nine settings sections and the local search without a back entry", () => {
    const { container } = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar active="general" onSelect={() => undefined} />
      </ShortcutHelpProvider>,
    );

    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Keyboard shortcuts" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Theme & appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tools & updates" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search settings…" })).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(9);
    expect(screen.getByRole("button", { name: "Remote connections" })).toBeTruthy();
  });

  it("searches settings content and selects the matching target", () => {
    const onSelect = vi.fn();
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <SettingsSidebar active="general" onSelect={onSelect} />
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
        <SettingsSidebar active="general" onSelect={() => undefined} />
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
        <SettingsSidebar active="general" onSelect={() => undefined} />
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
  it("opens the Agent tab from the renamed section and exposes the Agent search destination", () => {
    const onSelect = vi.fn();
    render(<SettingsSidebar active="general" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: tr("settings.section.integrations") }));
    expect(onSelect).toHaveBeenLastCalledWith("integrations", "integrations-agents");
    fireEvent.change(screen.getByRole("searchbox", { name: tr("settings.search.placeholder") }), {
      target: { value: "Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: tr("nav.agents") }));
    expect(onSelect).toHaveBeenLastCalledWith("integrations", "integrations-agents");
  });
});
