import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { ElectronNativeShell } from "./native-shell";
import type { SupportedLocale } from "../../src/core/types";

interface FakeImage {
  tag: string;
  size: number;
  template?: boolean;
  isEmpty(): boolean;
  resize(options: { width: number }): FakeImage;
  toBitmap(): Uint8Array;
  toPNG(): Buffer;
  addRepresentation(options: { buffer?: Buffer }): void;
  setTemplateImage(value: boolean): void;
}

const electron = vi.hoisted(() => {
  // Images carry a tag through resizing and encoding, so a test can tell which state is shown.
  const image = (tag: string, size = 44): FakeImage => {
    const value: FakeImage = {
      tag,
      size,
      isEmpty: () => tag === "",
      resize: ({ width }) => image(value.tag, width),
      toBitmap: () => new Uint8Array(size * size * 4),
      toPNG: () => Buffer.from(value.tag),
      addRepresentation: ({ buffer }) => {
        if (buffer) value.tag = buffer.toString();
      },
      setTemplateImage: (template) => {
        value.template = template;
      },
    };
    return value;
  };
  return {
    image,
    trayIcon: "",
    reducedMotion: false,
    workArea: { x: 0, y: 25, width: 1440, height: 875 },
    trays: [] as FakeTray[],
    windows: [] as FakeWindow[],
    popup: vi.fn(),
    buildFromTemplate: vi.fn((items: MenuItemConstructorOptions[]) => ({
      items,
      popup: electron.popup,
    })),
    setApplicationMenu: vi.fn(),
    send: vi.fn(),
  };
});

interface FakeTray {
  handlers: Map<string, (...args: unknown[]) => void>;
  image: FakeImage;
  title?: string;
  tooltip?: string;
  contextMenu?: { items: MenuItemConstructorOptions[] };
  popped: { items: MenuItemConstructorOptions[] }[];
  getBounds(): { x: number; y: number; width: number; height: number };
}
interface FakeWindow {
  options: Record<string, unknown>;
  url?: string;
  visible: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  webContents: { send: ReturnType<typeof vi.fn> };
}

vi.mock("electron", () => ({
  app: { getName: () => "AgentKib" },
  BrowserWindow: class {
    options: Record<string, unknown>;
    url?: string;
    visible = false;
    bounds?: FakeWindow["bounds"];
    handlers = new Map<string, () => void>();
    webContents = {
      send: electron.send,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      mainFrame: {},
    };
    constructor(options: Record<string, unknown> = {}) {
      this.options = options;
      electron.windows.push(this as unknown as FakeWindow);
    }
    setVisibleOnAllWorkspaces() {}
    on(event: string, handler: () => void) {
      this.handlers.set(event, handler);
    }
    once(event: string, handler: () => void) {
      this.handlers.set(event, handler);
    }
    async loadURL(url: string) {
      this.url = url;
    }
    isVisible() {
      return this.visible;
    }
    isDestroyed() {
      return false;
    }
    show() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
      this.handlers.get("hide")?.();
    }
    focus() {}
    destroy() {}
    setBounds(bounds: FakeWindow["bounds"]) {
      this.bounds = bounds;
    }
  },
  Menu: {
    buildFromTemplate: electron.buildFromTemplate,
    setApplicationMenu: electron.setApplicationMenu,
  },
  nativeImage: {
    createFromPath: () => electron.image(electron.trayIcon),
    createFromBitmap: (buffer: Buffer) => electron.image(buffer.toString()),
    createEmpty: () => electron.image("empty"),
  },
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getDisplayNearestPoint: () => ({ workArea: electron.workArea }) },
  shell: {},
  systemPreferences: {
    getAnimationSettings: () => ({ prefersReducedMotion: electron.reducedMotion }),
  },
  Tray: class {
    handlers = new Map<string, (...args: unknown[]) => void>();
    image: FakeImage;
    title?: string;
    tooltip?: string;
    contextMenu?: FakeTray["contextMenu"];
    popped: FakeTray["popped"] = [];
    constructor(image: FakeImage) {
      this.image = image;
      electron.trays.push(this as unknown as FakeTray);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
    }
    setImage(image: FakeImage) {
      this.image = image;
    }
    setTitle(title: string) {
      this.title = title;
    }
    setToolTip(tooltip: string) {
      this.tooltip = tooltip;
    }
    setContextMenu(menu: FakeTray["contextMenu"]) {
      this.contextMenu = menu;
    }
    popUpContextMenu(menu: FakeTray["popped"][number]) {
      this.popped.push(menu);
    }
    getBounds() {
      return { x: 1000, y: 0, width: 24, height: 24 };
    }
    isDestroyed() {
      return false;
    }
    destroy() {}
  },
}));
// The drawings themselves are tested in tray-icon-images.test.ts; here each state is a tag.
vi.mock("./tray-icon-images", async (original) => ({
  ...(await original<typeof import("./tray-icon-images")>()),
  runningFrame: (_mark: unknown, frame: number) => ({
    width: 44,
    height: 44,
    data: Buffer.from(`running-${frame}`),
  }),
  waitingImage: () => ({ width: 44, height: 44, data: Buffer.from("waiting") }),
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
function platform(value: string) {
  Object.defineProperty(process, "platform", { ...platformDescriptor, value });
}

function start(locale: SupportedLocale = "en-US") {
  const mainWindow = new BrowserWindow({ show: false });
  const showMainWindow = vi.fn();
  const shell = new ElectronNativeShell({
    mainWindow: () => mainWindow,
    preloadPath: "/test/preload",
    rendererUrl: (surface?: string) =>
      surface ? `http://localhost/test?surface=${surface}` : "http://localhost/test",
    trayIconPath: "/test/tray.png",
    locale,
    showMainWindow,
    requestQuit: vi.fn(),
  });
  shell.create();
  return { shell, showMainWindow, mainWindow };
}

function selection(window: BrowserWindow): Parameters<ElectronNativeShell["showSelectionMenu"]>[1] {
  return {
    frame: window.webContents.mainFrame,
    isEditable: false,
    selectionText: "selected message text",
    editFlags: {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: false,
      canDelete: false,
      canSelectAll: true,
      canEditRichly: false,
    },
    menuSourceType: "mouse",
  };
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
  electron.trayIcon = "";
  electron.reducedMotion = false;
  electron.workArea = { x: 0, y: 25, width: 1440, height: 875 };
  electron.trays.length = 0;
  electron.windows.length = 0;
});
afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
});

describe("native text selection menu", () => {
  it("opens the localized native Copy action for a main-window selection", () => {
    const { shell, mainWindow } = start();
    shell.setLocale("zh-CN");
    shell.showSelectionMenu(mainWindow, selection(mainWindow));

    expect(electron.buildFromTemplate).toHaveBeenLastCalledWith([{ role: "copy", label: "复制" }]);
    expect(electron.popup).toHaveBeenCalledExactlyOnceWith({
      window: mainWindow,
      frame: mainWindow.webContents.mainFrame,
      sourceType: "mouse",
    });
  });

  it("leaves empty, non-copyable, editable and embedded selections alone", () => {
    const { shell, mainWindow } = start();
    const params = selection(mainWindow);
    shell.showSelectionMenu(mainWindow, { ...params, selectionText: "  " });
    shell.showSelectionMenu(mainWindow, {
      ...params,
      editFlags: { ...params.editFlags, canCopy: false },
    });
    shell.showSelectionMenu(mainWindow, { ...params, isEditable: true });
    shell.showSelectionMenu(mainWindow, { ...params, frame: null });
    const other = new BrowserWindow({ show: false });
    shell.showSelectionMenu(mainWindow, { ...params, frame: other.webContents.mainFrame });
    shell.showSelectionMenu(other, selection(other));

    expect(electron.popup).not.toHaveBeenCalled();
  });
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

describe("menu bar icon and popover", () => {
  const appName = "AgentKib";
  function startTray(value: string) {
    platform(value);
    electron.trayIcon = "idle";
    const started = start();
    return { ...started, tray: electron.trays[0], popover: () => electron.windows.at(-1)! };
  }
  const labels = (items: MenuItemConstructorOptions[]) =>
    items.map((item) => item.label ?? item.type);

  it("opens the popover on click and keeps only open and quit for the right click", async () => {
    const { shell, tray, popover, showMainWindow } = startTray("darwin");
    expect(tray.contextMenu).toBeUndefined();
    tray.handlers.get("right-click")!();
    expect(labels(tray.popped[0].items)).toEqual([
      shell.translate("tray.open", { appName }),
      "separator",
      shell.translate("tray.quit", { appName }),
    ]);
    Reflect.apply(tray.popped[0].items[0].click!, undefined, []);
    expect(showMainWindow).toHaveBeenCalledTimes(1);

    tray.handlers.get("click")!({}, tray.getBounds());
    await vi.waitFor(() => expect(popover().visible).toBe(true));
    expect(popover().url).toBe("http://localhost/test?surface=menubar");
    // Centred under the icon, just below the menu bar.
    expect(popover().bounds).toEqual({ x: 832, y: 30, width: 360, height: 480 });
    tray.handlers.get("click")!({}, tray.getBounds());
    await vi.waitFor(() => expect(popover().visible).toBe(false));
  });

  it("follows the content's height within the screen", async () => {
    const { shell, tray, popover } = startTray("darwin");
    tray.handlers.get("click")!({}, tray.getBounds());
    await vi.waitFor(() => expect(popover().visible).toBe(true));
    const sender = popover().webContents as never;
    shell.resizePopover(sender, 900);
    expect(popover().bounds?.height).toBe(720);
    shell.resizePopover(sender, 120);
    expect(popover().bounds?.height).toBe(200);
    // Only the popover's own page sizes it.
    shell.resizePopover({} as never, 600);
    expect(popover().bounds?.height).toBe(200);
  });

  it("shows a dot and the count while something waits", () => {
    const { shell, tray } = startTray("darwin");
    expect(tray.image.tag).toBe("idle");
    expect(tray.image.template).toBe(true);
    shell.setSessionStatus({ needsYou: 2, running: 1 });
    expect(tray.image.tag).toBe("waiting");
    expect(tray.title).toBe("2");
    expect(tray.tooltip).toBe(shell.translate("tray.tooltipNeedsYou", { appName, count: 2 }));
    shell.setSessionStatus({ needsYou: 0, running: 0 });
    expect(tray.image.tag).toBe("idle");
    expect(tray.title).toBe("");
    expect(tray.tooltip).toBe(shell.translate("tray.tooltip", { appName }));
  });

  it("turns the arc while a session runs, and holds it still when motion is reduced", () => {
    vi.useFakeTimers();
    try {
      const { shell, tray } = startTray("darwin");
      shell.setSessionStatus({ needsYou: 0, running: 1 });
      expect(tray.image.tag).toBe("running-0");
      expect(tray.tooltip).toBe(shell.translate("tray.tooltipRunning", { appName, count: 1 }));
      vi.advanceTimersByTime(125);
      expect(tray.image.tag).toBe("running-1");
      vi.advanceTimersByTime(125 * 11);
      expect(tray.image.tag).toBe("running-0");
      shell.setSessionStatus({ needsYou: 0, running: 0 });
      vi.advanceTimersByTime(1_000);
      expect(tray.image.tag).toBe("idle");
      electron.reducedMotion = true;
      shell.setSessionStatus({ needsYou: 0, running: 2 });
      expect(tray.image.tag).toBe("running-1");
      vi.advanceTimersByTime(1_000);
      expect(tray.image.tag).toBe("running-1");
      shell.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists what waits in Linux's native menu, which opens the home", () => {
    const { shell, tray, showMainWindow } = startTray("linux");
    shell.setSessionStatus({ needsYou: 3, running: 0 });
    const items = tray.contextMenu!.items;
    expect(labels(items)).toEqual([
      shell.translate("tray.open", { appName }),
      shell.translate("tray.needsYou", { count: 3 }),
      "separator",
      shell.translate("tray.quit", { appName }),
    ]);
    Reflect.apply(items[1].click!, undefined, []);
    expect(electron.send).toHaveBeenCalledWith("agentkib:navigate", {
      page: "home",
      configure_popover: false,
    });
    expect(tray.title).toBeUndefined();
    tray.handlers.get("click")!();
    expect(showMainWindow).toHaveBeenCalledTimes(2);
    shell.setSessionStatus({ needsYou: 0, running: 0 });
    expect(labels(tray.contextMenu!.items)).toEqual([
      shell.translate("tray.open", { appName }),
      "separator",
      shell.translate("tray.quit", { appName }),
    ]);
  });

  it("opens the popover above a Windows taskbar icon, with the count in the tooltip", async () => {
    const { shell, tray, popover } = startTray("win32");
    electron.workArea = { x: 0, y: 0, width: 1920, height: 1040 };
    shell.setSessionStatus({ needsYou: 1, running: 0 });
    expect(tray.title).toBeUndefined();
    expect(tray.image.tag).toBe("waiting");
    expect(tray.tooltip).toBe(shell.translate("tray.tooltipNeedsYou", { appName, count: 1 }));
    tray.handlers.get("click")!({}, { x: 1800, y: 1045, width: 24, height: 30 });
    await vi.waitFor(() => expect(popover().visible).toBe(true));
    expect(popover().bounds).toEqual({ x: 1554, y: 559, width: 360, height: 480 });
  });

  it("opens the main window at the page the popover asks for", async () => {
    const { shell, tray, popover, showMainWindow } = startTray("darwin");
    tray.handlers.get("click")!({}, tray.getBounds());
    await vi.waitFor(() => expect(popover().visible).toBe(true));
    shell.openMainWindow({ page: "sessions", session_id: "s1", configure_popover: false });
    expect(popover().visible).toBe(false);
    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(electron.send).toHaveBeenCalledWith("agentkib:navigate", {
      page: "sessions",
      session_id: "s1",
      configure_popover: false,
    });
  });
});
