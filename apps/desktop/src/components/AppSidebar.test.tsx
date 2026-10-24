// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLocale, initializeI18n, tr } from "@/core/i18n";
import { AppSidebar } from "./AppSidebar";
import { ShortcutHelpProvider } from "@/features/app/ShortcutHelpContext";
import { createGlobalNavigation } from "@/features/app/global-navigation";
import { useAppStore } from "@/stores/app-store";
import type { WorkspaceSummary } from "@/core/types";
import { useSidebarViewStore } from "@/features/app/sidebar-view-store";
import { currentAppPlatform } from "@/core/keyboard-shortcuts";

vi.mock("@/features/sessions/SessionDirectory", () => ({
  SessionDirectory: () => <button data-session-entry>Example session</button>,
}));

function mockDesktopLayout(desktop: boolean) {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (media: string) => ({
      media,
      matches: desktop,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  return () => Object.defineProperty(window, "matchMedia", { configurable: true, value: original });
}

describe("AppSidebar v8 navigation", () => {
  beforeAll(() => initializeI18n("en-US"));
  beforeEach(() => useAppStore.getState().reset());
  afterEach(cleanup);

  it.each([0, 2])(
    "keeps the pending changes entry but only badges a positive count: %i",
    (count) => {
      const workspace: WorkspaceSummary = {
        id: "fixture",
        name: "Example",
        path: "/example",
        status: "healthy",
        asset_count: 0,
        warning_count: 0,
        sources: [],
      };
      useSidebarViewStore.setState({ expandedWorkspaces: { fixture: true } });
      render(
        <AppSidebar
          active="workspaces"
          activeWorkspaceId="fixture"
          workspaces={[workspace]}
          workspacePage="changes"
          changeCount={count}
          entries={createGlobalNavigation(0)}
          onNavigate={vi.fn()}
          onSettings={vi.fn()}
          collapsed={false}
        />,
      );
      const entry = screen.getByRole("button", { name: /Pending changes/ });
      expect(entry).toBeTruthy();
      expect(entry.querySelector("em")?.textContent ?? null).toBe(count ? String(count) : null);
      useSidebarViewStore.setState({ expandedWorkspaces: {} });
    },
  );

  it("toggles the current workspace by name and opens other workspaces expanded", async () => {
    useSidebarViewStore.setState({ expandedWorkspaces: {} });
    const workspace: WorkspaceSummary = {
      id: "current",
      name: "Current workspace",
      path: "/current",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const other = { ...workspace, id: "other", name: "Other workspace", path: "/other" };
    const onOpenWorkspace = vi.fn();
    const { container } = render(
      <AppSidebar
        active="workspaces"
        activeWorkspaceId={workspace.id}
        workspaces={[workspace, other]}
        entries={createGlobalNavigation(0)}
        onNavigate={vi.fn()}
        onSettings={vi.fn()}
        onOpenWorkspace={onOpenWorkspace}
        collapsed={false}
      />,
    );
    const user = userEvent.setup();
    const currentRow = container.querySelectorAll(".workspace-sidebar-group")[0];
    expect(currentRow.querySelector(".workspace-sidebar-children")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: workspace.name }));
    expect(currentRow.querySelector(".workspace-sidebar-children")).toBeNull();
    await user.click(screen.getByRole("button", { name: workspace.name }));
    expect(currentRow.querySelector(".workspace-sidebar-children")).toBeTruthy();
    expect(onOpenWorkspace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: other.name }));
    expect(onOpenWorkspace).toHaveBeenCalledWith(other);
    expect(container.querySelectorAll(".workspace-sidebar-children")).toHaveLength(2);
    useSidebarViewStore.setState({ expandedWorkspaces: {} });
  });

  it.each([
    ["zh-CN", "设置", "远程连接"],
    ["zh-TW", "設定", "遠端連線"],
    ["ja-JP", "設定", "リモート接続"],
    ["en-US", "Settings", "Remote connections"],
  ] as const)(
    "updates activity bar labels in %s without parent rerender",
    async (locale, settings, remote) => {
      render(
        <AppSidebar
          active="home"
          entries={createGlobalNavigation(0)}
          onNavigate={vi.fn()}
          onSettings={vi.fn()}
          collapsed={false}
        />,
      );
      const original = screen.getByRole("button", { name: "Settings" });
      try {
        await act(() => changeLocale(locale));
        expect(screen.getByRole("button", { name: settings })).toBe(original);
        expect(screen.getByRole("button", { name: remote })).toBeTruthy();
      } finally {
        await act(() => changeLocale("en-US"));
      }
    },
  );

  it("closes the navigation drawer when global search opens, including shortcut activation", () => {
    const onOpenSearch = vi.fn();
    const props = {
      active: "home" as const,
      entries: createGlobalNavigation(0),
      onNavigate: vi.fn(),
      onSettings: vi.fn(),
      onOpenSearch,
      collapsed: false,
    };
    const { container, rerender } = render(<AppSidebar {...props} searchOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: tr("common.primaryNavigation") }));
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: tr("search.open") }));
    expect(onOpenSearch).toHaveBeenCalledOnce();
    rerender(<AppSidebar {...props} searchOpen />);
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
    rerender(<AppSidebar {...props} searchOpen={false} />);
    fireEvent.click(screen.getByRole("button", { name: tr("common.primaryNavigation") }));
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    // A keyboard shortcut changes parent state without clicking the sidebar search button.
    rerender(<AppSidebar {...props} searchOpen />);
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("keeps the activity bar accessible while the context panel is collapsed", async () => {
    const restore = mockDesktopLayout(true);
    try {
      useAppStore.getState().setSidebarCollapsed(true);
      const onNavigate = vi.fn();
      const { container } = render(
        <AppSidebar
          active="sessions"
          entries={createGlobalNavigation(0)}
          onNavigate={onNavigate}
          onSettings={vi.fn()}
          collapsed
          context={{ kind: "sessions" }}
        />,
      );
      expect(container.querySelector(".app-context-sidebar")?.hasAttribute("inert")).toBe(true);
      await userEvent.setup().click(screen.getByRole("button", { name: tr("nav.catalog") }));
      expect(onNavigate).toHaveBeenCalledWith("catalog");
      expect(useAppStore.getState().sidebarCollapsed).toBe(false);
    } finally {
      restore();
    }
  });

  it("does not rewrite the desktop collapse preference from the narrow-window drawer", async () => {
    const restore = mockDesktopLayout(false);
    try {
      useAppStore.getState().setSidebarCollapsed(true);
      const onNavigate = vi.fn();
      render(
        <AppSidebar
          active="home"
          entries={createGlobalNavigation(0)}
          onNavigate={onNavigate}
          onSettings={vi.fn()}
          collapsed
        />,
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: tr("common.primaryNavigation") }));
      await user.click(screen.getByRole("button", { name: tr("nav.catalog") }));
      expect(onNavigate).toHaveBeenCalledWith("catalog");
      // A primary destination with a context panel keeps the drawer available for its next selection.
      expect(screen.getByRole("dialog", { name: tr("common.primaryNavigation") })).toBeTruthy();
      expect(useAppStore.getState().sidebarCollapsed).toBe(true);
    } finally {
      restore();
    }
  });

  it("moves focus into the drawer, closes on Escape and returns focus to the trigger", async () => {
    render(
      <AppSidebar
        active="home"
        entries={createGlobalNavigation(0)}
        onNavigate={vi.fn()}
        onSettings={vi.fn()}
        collapsed={false}
      />,
    );
    // 焦点陷阱只考虑可见元素（getClientRects 非空）；jsdom 没有布局，这里模拟为可见。
    const rects = vi
      .spyOn(HTMLElement.prototype, "getClientRects")
      .mockReturnValue([{}] as unknown as DOMRectList);
    try {
      const user = userEvent.setup();
      const trigger = screen.getByRole("button", { name: tr("common.primaryNavigation") });
      await user.click(trigger);
      const drawer = screen.getByRole("dialog", { name: tr("common.primaryNavigation") });
      expect(drawer.contains(document.activeElement)).toBe(true);
      // 第一个可聚焦项带 tooltip：第一次 Escape 先关闭 tooltip，第二次才关闭抽屉。
      await user.keyboard("{Escape}");
      if (screen.queryByRole("dialog")) await user.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(document.activeElement).toBe(trigger);
    } finally {
      rects.mockRestore();
    }
  });

  it("names workspace toggles by workspace and shows an empty state without workspaces", () => {
    const workspace: WorkspaceSummary = {
      id: "repo",
      name: "repo",
      path: "/repo",
      status: "healthy",
      asset_count: 0,
      warning_count: 0,
      sources: [],
    };
    const props = {
      active: "workspaces" as const,
      entries: createGlobalNavigation(0),
      onNavigate: vi.fn(),
      onSettings: vi.fn(),
      collapsed: false,
    };
    const view = render(<AppSidebar {...props} workspaces={[workspace]} />);
    expect(screen.getByRole("button", { name: "Expand repo" })).toBeTruthy();
    view.unmount();
    render(<AppSidebar {...props} workspaces={[]} />);
    expect(screen.getByText(tr("sidebar.noWorkspaces"))).toBeTruthy();
  });

  it("opens global search beside the non-clickable brand", async () => {
    const onOpenSearch = vi.fn();
    const { container } = render(
      <AppSidebar
        active="home"
        entries={createGlobalNavigation(0)}
        onNavigate={() => undefined}
        onSettings={() => undefined}
        onOpenSearch={onOpenSearch}
        collapsed={false}
      />,
    );
    const header = container.querySelector(".app-activity-bar")!;
    const search = within(header as HTMLElement).getByRole("button", { name: tr("search.open") });
    expect(search.getAttribute("aria-keyshortcuts")).toBe("Control+K");
    expect(header.querySelector(".activity-bar-brand")?.closest("button, a")).toBeNull();
    await userEvent.setup().click(search);
    expect(onOpenSearch).toHaveBeenCalledOnce();
  });

  it("exposes settings and remote connection actions directly in the activity bar", async () => {
    const onSettings = vi.fn();
    render(
      <AppSidebar
        active="home"
        entries={createGlobalNavigation(0)}
        onNavigate={vi.fn()}
        onSettings={onSettings}
        collapsed={false}
      />,
    );
    expect(screen.queryByRole("button", { name: tr("sessions.more") })).toBeNull();
    const settings = screen.getByRole("button", { name: tr("nav.settings") });
    expect(settings.getAttribute("aria-keyshortcuts")).toBe("Control+,");
    expect(
      screen.getByRole("button", { name: tr("sessions.remote") }).hasAttribute("disabled"),
    ).toBe(false);
    useAppStore.getState().setSidebarCollapsed(true);
    await userEvent.setup().click(settings);
    expect(onSettings).toHaveBeenCalledOnce();
    expect(useAppStore.getState().sidebarCollapsed).toBe(true);
  });

  it("keeps six activity destinations with sessions after workspaces and preserves the tool navigation", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { container, rerender } = render(
      <AppSidebar
        active="sessions"
        entries={createGlobalNavigation(0)}
        onNavigate={onNavigate}
        onSettings={() => undefined}
        collapsed={false}
        context={{ kind: "sessions" }}
      />,
    );
    const sidebar = container.querySelector(".app-sidebar")!;
    expect(sidebar.classList.contains("app-sidebar-sessions")).toBe(true);
    const primary = sidebar.querySelector(".activity-bar-navigation")!;
    const names = within(primary as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([
      tr("nav.home"),
      tr("nav.workspaces"),
      tr("sessions.nav"),
      tr("nav.catalog"),
      tr("nav.quota"),
      tr("nav.insights"),
    ]);
    expect(
      within(primary as HTMLElement).queryByRole("button", { name: tr("nav.agents") }),
    ).toBeNull();
    const sessions = screen.getByRole("button", { name: tr("sessions.nav") });
    expect(sessions.getAttribute("aria-current")).toBe("page");
    expect(sessions.getAttribute("aria-keyshortcuts")).toBe(
      currentAppPlatform() === "macos" ? "Meta+3" : "Control+3",
    );
    expect(within(sidebar as HTMLElement).getByText("Example session")).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("nav.catalog") })).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("nav.quota") })).toBeTruthy();
    expect(screen.getByRole("button", { name: tr("nav.insights") })).toBeTruthy();
    await user.click(sessions);
    expect(onNavigate).toHaveBeenCalledWith("sessions");
    rerender(
      <AppSidebar
        active="catalog"
        entries={createGlobalNavigation(0)}
        onNavigate={onNavigate}
        onSettings={() => undefined}
        collapsed={false}
        context={{ kind: "global" }}
      />,
    );
    expect(container.querySelector(".app-sidebar-sessions")).toBeNull();
    expect(screen.queryByText("Example session")).toBeNull();
  });

  it("closes the narrow-window navigation drawer after selecting a session", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <AppSidebar
        active="sessions"
        entries={createGlobalNavigation(0)}
        onNavigate={() => undefined}
        onSettings={() => undefined}
        collapsed={false}
        context={{ kind: "sessions" }}
      />,
    );
    const trigger = screen.getByRole("button", { name: tr("common.primaryNavigation") });
    await user.click(trigger);
    expect(container.querySelector(".app-sidebar-open")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Example session" }));
    expect(container.querySelector(".app-sidebar-open")).toBeNull();
  });

  it("keeps shortcut semantics without rendering inline shortcut hints", () => {
    const { container } = render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <AppSidebar
          active="home"
          entries={[{ id: "home", label: "nav.home", icon: () => null, shortcut: "navigate-home" }]}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          collapsed={false}
          onCollapsedChange={() => undefined}
        />
      </ShortcutHelpProvider>,
    );

    expect(container.querySelectorAll("kbd")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Today" }).getAttribute("aria-keyshortcuts")).toBe(
      "Control+1",
    );
  });

  it("only exposes agent filters backed by installation metadata", () => {
    render(
      <ShortcutHelpProvider openShortcutHelp={() => undefined}>
        <AppSidebar
          active="agents"
          entries={[{ id: "agents", label: "nav.agents", icon: () => null }]}
          onNavigate={() => undefined}
          onSettings={() => undefined}
          collapsed={false}
          context={{ kind: "agents", filter: "all", onFilterChange: () => undefined }}
        />
      </ShortcutHelpProvider>,
    );

    expect(screen.getByRole("button", { name: "All" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Enabled" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Available" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Updates" })).toBeNull();
  });
});
