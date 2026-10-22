// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentAppPlatform } from "@/core/keyboard-shortcuts";
import { useAppShortcuts, type AppShortcutActions } from "./useAppShortcuts";

function ShortcutHarness(actions: AppShortcutActions) {
  useAppShortcuts(actions);
  return <input aria-label="Editor" />;
}

function createActions(overrides: Partial<AppShortcutActions> = {}): AppShortcutActions {
  return {
    onNavigate: vi.fn(),
    onOpenSettings: vi.fn(),
    onRefreshCurrent: vi.fn().mockResolvedValue(undefined),
    onAddWorkspace: vi.fn().mockResolvedValue(undefined),
    onAddScanRoot: vi.fn().mockResolvedValue(undefined),
    onToggleSidebar: vi.fn(),
    onGoBack: vi.fn(),
    onGoForward: vi.fn(),
    onOpenSearch: vi.fn(),
    onOpenHelp: vi.fn(),
    helpOpen: false,
    ...overrides,
  };
}

describe("useAppShortcuts", () => {
  beforeEach(() => {
    document.documentElement.dataset.platform = "windows";
  });

  afterEach(cleanup);

  it("routes navigation, refresh, sidebar, search, and help shortcuts", () => {
    const actions = createActions();
    render(<ShortcutHarness {...actions} />);

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    fireEvent.keyDown(window, { key: "r", ctrlKey: true });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.keyDown(window, { key: "/", ctrlKey: true });
    fireEvent.keyDown(window, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });

    expect(actions.onNavigate).toHaveBeenCalledWith("home");
    expect(actions.onRefreshCurrent).toHaveBeenCalledOnce();
    expect(actions.onToggleSidebar).toHaveBeenCalledOnce();
    expect(actions.onOpenSearch).toHaveBeenCalledOnce();
    expect(actions.onOpenHelp).toHaveBeenCalledOnce();
    expect(actions.onGoBack).toHaveBeenCalledOnce();
    expect(actions.onGoForward).toHaveBeenCalledOnce();
  });

  it("routes settings and file action shortcuts", () => {
    const actions = createActions();
    render(<ShortcutHarness {...actions} />);

    fireEvent.keyDown(window, { key: ",", ctrlKey: true });
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    fireEvent.keyDown(window, { key: "o", ctrlKey: true, shiftKey: true });

    expect(actions.onOpenSettings).toHaveBeenCalledOnce();
    expect(actions.onAddWorkspace).toHaveBeenCalledOnce();
    expect(actions.onAddScanRoot).toHaveBeenCalledOnce();
  });

  it.each(["windows", "linux"] as const)(
    "navigates all six sidebar destinations on %s",
    (platform) => {
      document.documentElement.dataset.platform = platform;
      const actions = createActions();
      render(<ShortcutHarness {...actions} />);
      for (let index = 1; index <= 6; index++) {
        const event = new KeyboardEvent("keydown", {
          key: String(index),
          ctrlKey: true,
          cancelable: true,
        });
        window.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(actions.onNavigate).toHaveBeenNthCalledWith(1, "home");
      expect(actions.onNavigate).toHaveBeenNthCalledWith(2, "workspaces");
      expect(actions.onNavigate).toHaveBeenNthCalledWith(3, "sessions");
      expect(actions.onNavigate).toHaveBeenNthCalledWith(4, "catalog");
      expect(actions.onNavigate).toHaveBeenNthCalledWith(5, "quota");
      expect(actions.onNavigate).toHaveBeenNthCalledWith(6, "insights");
      expect(actions.onNavigate).toHaveBeenCalledTimes(6);
      expect(actions.onOpenSettings).not.toHaveBeenCalled();
    },
  );

  it("does not hijack editable fields, composition, or repeated keys", () => {
    const actions = createActions();
    const { getByRole } = render(<ShortcutHarness {...actions} />);
    const editor = getByRole("textbox");

    fireEvent.keyDown(editor, { key: "1", ctrlKey: true });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true, repeat: true });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true, repeat: true });
    for (const tag of ["textarea", "select"] as const) {
      const field = document.createElement(tag);
      document.body.append(field);
      fireEvent.keyDown(field, { key: "3", ctrlKey: true });
      field.remove();
    }
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editable.append(child);
    document.body.append(editable);
    fireEvent.keyDown(child, { key: "3", ctrlKey: true });
    editable.remove();

    expect(actions.onNavigate).not.toHaveBeenCalled();
  });

  it("keeps modifier and already-handled-event guards for the new sessions shortcut", () => {
    const actions = createActions();
    render(<ShortcutHarness {...actions} />);
    for (const modifiers of [
      {},
      { metaKey: true },
      { ctrlKey: true, metaKey: true },
      { ctrlKey: true, shiftKey: true },
      { ctrlKey: true, altKey: true },
    ])
      fireEvent.keyDown(window, { key: "3", ...modifiers });
    const handled = new KeyboardEvent("keydown", { key: "3", ctrlKey: true, cancelable: true });
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(actions.onNavigate).not.toHaveBeenCalled();
  });

  it("does not navigate while the help dialog is open", () => {
    const actions = createActions({ helpOpen: true });
    render(<ShortcutHarness {...actions} />);

    fireEvent.keyDown(window, { key: "3", ctrlKey: true });

    expect(actions.onNavigate).not.toHaveBeenCalled();
  });

  it("handles new shortcuts on macOS while leaving native menu shortcuts alone", () => {
    document.documentElement.dataset.platform = "macos";
    expect(currentAppPlatform()).toBe("macos");
    const actions = createActions();
    render(<ShortcutHarness {...actions} />);

    for (let index = 1; index <= 6; index++)
      fireEvent.keyDown(window, { key: String(index), metaKey: true });
    fireEvent.keyDown(window, { key: "b", metaKey: true });
    fireEvent.keyDown(window, { key: "/", metaKey: true });
    fireEvent.keyDown(window, { key: "[", metaKey: true });
    fireEvent.keyDown(window, { key: "]", metaKey: true });

    expect(actions.onNavigate).not.toHaveBeenCalled();
    expect(actions.onToggleSidebar).toHaveBeenCalledOnce();
    expect(actions.onOpenHelp).toHaveBeenCalledOnce();
    expect(actions.onGoBack).toHaveBeenCalledOnce();
    expect(actions.onGoForward).toHaveBeenCalledOnce();
  });
});
