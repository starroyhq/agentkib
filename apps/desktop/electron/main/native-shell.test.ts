import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { ElectronNativeShell } from "./native-shell";
import type { SupportedLocale } from "../../src/core/types";

const electron = vi.hoisted(() => ({
  buildFromTemplate: vi.fn((items: MenuItemConstructorOptions[]) => ({ items })),
  setApplicationMenu: vi.fn(),
  send: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getName: () => "AgentKib" },
  BrowserWindow: class {
    webContents = { send: electron.send };
  },
  Menu: {
    buildFromTemplate: electron.buildFromTemplate,
    setApplicationMenu: electron.setApplicationMenu,
  },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  screen: {},
  shell: {},
  Tray: class {},
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
function platform(value: string) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value });
}

function start(locale: SupportedLocale = "en-US") {
  const mainWindow = new BrowserWindow({ show: false });
  const showMainWindow = vi.fn();
  const shell = new ElectronNativeShell({
    runtime: () => {
      throw new Error("Menu construction must not request runtime services");
    },
    mainWindow: () => mainWindow,
    preloadPath: "/test/preload",
    rendererUrl: () => "http://localhost/test",
    trayIconPath: "/test/tray.png",
    locale,
    refreshStatus: () => [],
    showMainWindow,
    requestQuit: vi.fn(),
    requestRefresh: vi.fn(),
  });
  shell.create();
  return { shell, showMainWindow };
}

function submenu(label: string) {
  const template = electron.buildFromTemplate.mock.calls[0][0];
  const menu = template.find((item) => item.label === label)?.submenu;
  if (!Array.isArray(menu)) throw new Error(`Missing submenu: ${label}`);
  return menu;
}

beforeEach(() => {
  platform("darwin");
  vi.clearAllMocks();
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("native navigation shortcuts", () => {
  it.each(["zh-CN", "zh-TW", "en-US", "ja-JP"] as const)(
    "dispatches all six sidebar destinations with matching labels in %s",
    (locale) => {
      const { shell, showMainWindow } = start(locale);
      const items = submenu(shell.translate("menu.view")).filter((item) =>
        /^CmdOrCtrl\+[1-6]$/.test(item.accelerator ?? ""),
      );
      const entries = [
        { id: "home", label: "nav.home" },
        { id: "workspaces", label: "nav.workspaces" },
        { id: "sessions", label: "sessions.nav" },
        { id: "catalog", label: "nav.catalog" },
        { id: "quota", label: "nav.quota" },
        { id: "insights", label: "nav.insights" },
      ];
      expect(items.map((item) => item.label)).toEqual(
        entries.map((entry) => shell.translate(entry.label)),
      );
      expect(items.map((item) => item.accelerator)).toEqual([
        "CmdOrCtrl+1",
        "CmdOrCtrl+2",
        "CmdOrCtrl+3",
        "CmdOrCtrl+4",
        "CmdOrCtrl+5",
        "CmdOrCtrl+6",
      ]);
      for (const item of items) Reflect.apply(item.click!, undefined, []);
      expect(electron.send.mock.calls).toEqual(
        entries.map((entry) => [
          "agentkib:navigate",
          { page: entry.id, settings_section: undefined, configure_popover: false },
        ]),
      );
      expect(showMainWindow).toHaveBeenCalledTimes(6);
    },
  );

  it.each(["win32", "linux"])("leaves keyboard navigation to the frontend on %s", (value) => {
    platform(value);
    start();
    expect(electron.setApplicationMenu).toHaveBeenCalledExactlyOnceWith(null);
    expect(electron.buildFromTemplate).not.toHaveBeenCalled();
    expect(electron.send).not.toHaveBeenCalled();
  });

  it("retains native refresh and workspace action commands", () => {
    const { shell } = start();
    for (const [section, accelerator] of [
      ["menu.file", "CmdOrCtrl+O"],
      ["menu.file", "CmdOrCtrl+Shift+O"],
      ["menu.view", "CmdOrCtrl+R"],
    ]) {
      const item = submenu(shell.translate(section)).find(
        (entry) => entry.accelerator === accelerator,
      );
      expect(item).toBeDefined();
      Reflect.apply(item!.click!, undefined, []);
    }
    expect(electron.send.mock.calls).toEqual([
      ["agentkib:app-command", { command: "add-workspace" }],
      ["agentkib:app-command", { command: "add-scan-root" }],
      ["agentkib:app-command", { command: "refresh-current" }],
    ]);
  });
});
