import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  shell,
  systemPreferences,
  Tray,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type NativeImage,
  type Rectangle,
  type WebContents,
} from "electron";
import enUS from "../../src/locales/en-US.json";
import jaJP from "../../src/locales/ja-JP.json";
import zhCN from "../../src/locales/zh-CN.json";
import zhTW from "../../src/locales/zh-TW.json";
import type { AppMenuCommand, AppNavigationRequest, SupportedLocale } from "../../src/core/types";
import {
  RUNNING_FRAMES,
  RUNNING_MARK_SIZE,
  TEMPLATE_COLOR,
  TRAY_CANVAS,
  runningFrame,
  waitingImage,
  type TrayBitmap,
  type TrayColor,
} from "./tray-icon-images";
import { IDLE_TRAY_STATUS, type TraySessionStatus } from "./tray-sessions";

const POPOVER_WIDTH = 360;
const POPOVER_MIN_HEIGHT = 200;
const POPOVER_MAX_HEIGHT = 720;
/** Between the popover and the menu bar or taskbar, and the screen edges. */
const POPOVER_GAP = 6;
/** One step of the running arc; a turn takes RUNNING_FRAMES of them. */
const FRAME_MS = 125;
/** The arc where the design draws it, on the right, when motion is reduced. */
const STILL_FRAME = 1;
/** Windows icons are colour; the running arc and the waiting dot get the mark's blue and a badge red. */
const WINDOWS_ARC: TrayColor = { r: 59, g: 108, b: 246 };
const WINDOWS_DOT: TrayColor = { r: 239, g: 68, b: 68 };

const messages: Record<SupportedLocale, Record<string, string>> = {
  "en-US": enUS,
  "ja-JP": jaJP,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

interface NativeShellOptions {
  mainWindow(): BrowserWindow | undefined;
  preloadPath: string;
  rendererUrl(surface?: "menubar"): string;
  trayIconPath: string;
  locale: SupportedLocale;
  showMainWindow(): void;
  requestQuit(): void;
  /** The menu bar popover opened; its counts should be read again. */
  onPopoverShown?(): void;
}

interface TrayImages {
  idle: NativeImage;
  running: NativeImage[];
  waiting: NativeImage;
}

export class ElectronNativeShell {
  readonly #options: NativeShellOptions;
  #locale: SupportedLocale;
  #tray: Tray | undefined;
  #images: TrayImages | undefined;
  #status: TraySessionStatus = IDLE_TRAY_STATUS;
  #frame = 0;
  #frameTimer: ReturnType<typeof setInterval> | undefined;
  #popover: BrowserWindow | undefined;
  #popoverTray: Rectangle | undefined;
  #popoverHeight = 480;
  #popoverHiddenAt = 0;

  constructor(options: NativeShellOptions) {
    this.#options = options;
    this.#locale = options.locale;
  }

  create(): void {
    this.#installApplicationMenu();
    this.#createTray();
  }

  get trayAvailable(): boolean {
    return Boolean(this.#tray && !this.#tray.isDestroyed());
  }

  ownsWebContents(sender: WebContents): boolean {
    return Boolean(
      this.#popover && !this.#popover.isDestroyed() && sender === this.#popover.webContents,
    );
  }

  setLocale(locale: SupportedLocale): void {
    if (this.#locale === locale) return;
    this.#locale = locale;
    this.#installApplicationMenu();
    this.#applyStatus();
  }

  translate(key: string, params: Record<string, string | number> = {}): string {
    return this.#tr(key, params);
  }

  showSelectionMenu(
    window: BrowserWindow,
    params: Pick<
      ContextMenuParams,
      "frame" | "isEditable" | "selectionText" | "editFlags" | "menuSourceType"
    >,
  ): void {
    if (
      window !== this.#options.mainWindow() ||
      window.isDestroyed() ||
      !params.frame ||
      params.frame !== window.webContents.mainFrame ||
      params.isEditable ||
      !params.editFlags.canCopy ||
      !params.selectionText.trim()
    )
      return;
    Menu.buildFromTemplate([{ role: "copy", label: this.#tr("menu.copy") }]).popup({
      window,
      frame: params.frame,
      sourceType: params.menuSourceType,
    });
  }

  /** What the icon shows: a dot and the count while something waits, a turning arc while a session runs. */
  setSessionStatus(status: TraySessionStatus): void {
    this.#status = status;
    this.#applyStatus();
  }

  /** Tells the popover, once it has been opened, what the main window hears too. */
  sendToPopover(channel: string, payload: unknown): void {
    if (this.#popover && !this.#popover.isDestroyed())
      this.#popover.webContents.send(channel, payload);
  }

  /** Opens or closes the popover under the menu bar icon, as a click on the icon does. */
  togglePopover(): void {
    if (!this.#tray || this.#tray.isDestroyed() || process.platform === "linux") return;
    void this.#togglePopover(this.#tray.getBounds());
  }

  /** Opens the main window from the popover, at the page it names. */
  openMainWindow(request?: AppNavigationRequest): void {
    this.#popover?.hide();
    this.#options.showMainWindow();
    if (request) this.#options.mainWindow()?.webContents.send("agentkib:navigate", request);
  }

  /** The popover's content is this tall; the window follows it within the screen. */
  resizePopover(sender: WebContents, height: number): void {
    if (!this.ownsWebContents(sender) || !Number.isFinite(height)) return;
    this.#popoverHeight = Math.round(
      Math.min(Math.max(height, POPOVER_MIN_HEIGHT), POPOVER_MAX_HEIGHT),
    );
    const popover = this.#popover!;
    if (popover.isVisible()) this.#placePopover(popover);
  }

  hideMainWindow(): void {
    const window = this.#options.mainWindow();
    if (!window || window.isDestroyed()) return;
    this.#popover?.hide();
    if (this.trayAvailable) {
      window.hide();
      if (process.platform === "darwin") app.dock?.hide();
      return;
    }
    window.minimize();
  }

  destroy(): void {
    this.#stopFrames();
    if (this.#popover && !this.#popover.isDestroyed()) this.#popover.destroy();
    this.#popover = undefined;
    if (this.#tray && !this.#tray.isDestroyed()) this.#tray.destroy();
    this.#tray = undefined;
  }

  #installApplicationMenu(): void {
    if (process.platform !== "darwin") {
      Menu.setApplicationMenu(null);
      return;
    }

    const appName = app.getName();
    const navigate =
      (
        page: AppNavigationRequest["page"],
        settingsSection?: AppNavigationRequest["settings_section"],
      ) =>
      () => {
        this.#sendNavigation({
          page,
          settings_section: settingsSection,
          configure_popover: false,
        });
      };
    const command = (value: AppMenuCommand) => () => this.#sendCommand(value);
    const template: MenuItemConstructorOptions[] = [
      {
        label: appName,
        submenu: [
          { role: "about", label: this.#tr("menu.about", { appName }) },
          {
            label: this.#tr("menu.settings"),
            accelerator: "CmdOrCtrl+,",
            click: navigate("settings", "general"),
          },
          { type: "separator" },
          { role: "services", label: this.#tr("menu.services") },
          { type: "separator" },
          { role: "hide", label: this.#tr("menu.hide", { appName }) },
          { role: "hideOthers", label: this.#tr("menu.hideOthers") },
          { role: "unhide", label: this.#tr("menu.showAll") },
          { type: "separator" },
          {
            label: this.#tr("menu.quit", { appName }),
            accelerator: "CmdOrCtrl+Q",
            click: () => this.#options.requestQuit(),
          },
        ],
      },
      {
        label: this.#tr("menu.file"),
        submenu: [
          {
            label: this.#tr("menu.addWorkspace"),
            accelerator: "CmdOrCtrl+O",
            click: command("add-workspace"),
          },
          {
            label: this.#tr("menu.addScanRoot"),
            accelerator: "CmdOrCtrl+Shift+O",
            click: command("add-scan-root"),
          },
          { type: "separator" },
          { role: "close", label: this.#tr("menu.closeWindow") },
        ],
      },
      {
        label: this.#tr("menu.edit"),
        submenu: [
          { role: "undo", label: this.#tr("menu.undo") },
          { role: "redo", label: this.#tr("menu.redo") },
          { type: "separator" },
          { role: "cut", label: this.#tr("menu.cut") },
          { role: "copy", label: this.#tr("menu.copy") },
          { role: "paste", label: this.#tr("menu.paste") },
          { role: "selectAll", label: this.#tr("menu.selectAll") },
        ],
      },
      {
        label: this.#tr("menu.view"),
        submenu: [
          { label: this.#tr("nav.home"), accelerator: "CmdOrCtrl+1", click: navigate("home") },
          {
            label: this.#tr("nav.workspaces"),
            accelerator: "CmdOrCtrl+2",
            click: navigate("workspaces"),
          },
          {
            label: this.#tr("sessions.nav"),
            accelerator: "CmdOrCtrl+3",
            click: navigate("sessions"),
          },
          {
            label: this.#tr("nav.catalog"),
            accelerator: "CmdOrCtrl+4",
            click: navigate("catalog"),
          },
          { label: this.#tr("nav.quota"), accelerator: "CmdOrCtrl+5", click: navigate("quota") },
          {
            label: this.#tr("nav.insights"),
            accelerator: "CmdOrCtrl+6",
            click: navigate("insights"),
          },
          { type: "separator" },
          {
            label: this.#tr("menu.refreshCurrent"),
            accelerator: "CmdOrCtrl+R",
            click: command("refresh-current"),
          },
          { label: this.#tr("menu.refreshAll"), click: command("refresh-all") },
          { type: "separator" },
          { role: "togglefullscreen", label: this.#tr("menu.fullscreen") },
        ],
      },
      {
        label: this.#tr("menu.window"),
        submenu: [
          { role: "minimize", label: this.#tr("menu.minimize") },
          { role: "zoom", label: this.#tr("menu.zoom") },
        ],
      },
      {
        label: this.#tr("menu.help"),
        submenu: [
          {
            label: this.#tr("menu.helpDocs"),
            click: () => void shell.openExternal("https://github.com/starroyhq/agentkib#readme"),
          },
          { type: "separator" },
          { label: this.#tr("menu.dataPrivacy"), click: navigate("settings", "privacy") },
          {
            label: this.#tr("menu.diagnostics"),
            click: navigate("settings", "diagnostics"),
          },
          { type: "separator" },
          {
            label: this.#tr("menu.reportIssue"),
            click: () =>
              void shell.openExternal("https://github.com/starroyhq/agentkib/issues/new"),
          },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  #createTray(): void {
    this.#images = this.#createTrayImages();
    if (!this.#images) return;
    this.#tray = new Tray(this.#images.idle);
    if (process.platform === "linux") {
      // Most Linux panels only show a native menu; the click opens the window where they report one.
      this.#tray.on("click", () => this.#options.showMainWindow());
    } else {
      // Everything else lives in the popover; the context menu only opens or quits the app.
      this.#tray.on("click", (_event, bounds) => void this.#togglePopover(bounds));
      this.#tray.on("right-click", () => this.#tray?.popUpContextMenu(this.#contextMenu()));
    }
    this.#applyStatus();
  }

  #contextMenu(): Menu {
    const appName = app.getName();
    const needsYou = this.#status.needsYou;
    return Menu.buildFromTemplate([
      { label: this.#tr("tray.open", { appName }), click: () => this.openMainWindow() },
      ...(process.platform === "linux" && needsYou > 0
        ? [
            {
              label: this.#tr("tray.needsYou", { count: needsYou }),
              click: () => this.openMainWindow({ page: "home", configure_popover: false }),
            },
          ]
        : []),
      { type: "separator" },
      { label: this.#tr("tray.quit", { appName }), click: () => this.#options.requestQuit() },
    ] satisfies MenuItemConstructorOptions[]);
  }

  #applyStatus(): void {
    const tray = this.#tray;
    if (!tray || tray.isDestroyed() || !this.#images) return;
    const { needsYou, running } = this.#status;
    const appName = app.getName();
    // Waiting for the person wins over running: it is the state that needs an action.
    if (needsYou > 0) {
      this.#stopFrames();
      tray.setImage(this.#images.waiting);
    } else if (running > 0) {
      if (this.#reducedMotion()) {
        this.#stopFrames();
        tray.setImage(this.#images.running[STILL_FRAME]);
      } else this.#startFrames();
    } else {
      this.#stopFrames();
      tray.setImage(this.#images.idle);
    }
    if (process.platform === "darwin")
      tray.setTitle(needsYou > 0 ? String(needsYou) : "", { fontType: "monospacedDigit" });
    tray.setToolTip(
      needsYou > 0
        ? this.#tr("tray.tooltipNeedsYou", { appName, count: needsYou })
        : running > 0
          ? this.#tr("tray.tooltipRunning", { appName, count: running })
          : this.#tr("tray.tooltip", { appName }),
    );
    if (process.platform === "linux") tray.setContextMenu(this.#contextMenu());
  }

  #startFrames(): void {
    if (this.#frameTimer) return;
    const show = () => {
      if (!this.trayAvailable || !this.#images) return;
      this.#tray!.setImage(this.#images.running[this.#frame]);
      this.#frame = (this.#frame + 1) % RUNNING_FRAMES;
    };
    show();
    this.#frameTimer = setInterval(show, FRAME_MS);
  }

  #stopFrames(): void {
    clearInterval(this.#frameTimer);
    this.#frameTimer = undefined;
  }

  #reducedMotion(): boolean {
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      return false;
    }
  }

  #createTrayImages(): TrayImages | undefined {
    const source = nativeImage.createFromPath(this.#options.trayIconPath);
    if (source.isEmpty()) return undefined;
    const template = process.platform === "darwin";
    const bitmap = (image: NativeImage, size: number): TrayBitmap => ({
      width: size,
      height: size,
      data: image.resize({ width: size, height: size, quality: "best" }).toBitmap(),
    });
    const mark = bitmap(source, TRAY_CANVAS);
    const smallMark = bitmap(source, RUNNING_MARK_SIZE);
    const arc = template ? TEMPLATE_COLOR : WINDOWS_ARC;
    const dot = template ? TEMPLATE_COLOR : WINDOWS_DOT;
    const image = (value: TrayBitmap) =>
      this.#trayImage(
        nativeImage.createFromBitmap(Buffer.from(value.data), {
          width: value.width,
          height: value.height,
        }),
      );
    return {
      idle: this.#trayImage(source),
      running: Array.from({ length: RUNNING_FRAMES }, (_, frame) =>
        image(runningFrame(smallMark, frame, arc)),
      ),
      waiting: image(waitingImage(mark, dot)),
    };
  }

  /** On macOS, the 44 px drawing becomes a 22 pt template image with both resolutions. */
  #trayImage(source: NativeImage): NativeImage {
    if (process.platform !== "darwin") return source;
    // The 44 px asset is designed for a 22 pt menu bar slot, including its padding.
    const image = nativeImage.createEmpty();
    image.addRepresentation({
      scaleFactor: 1,
      width: 22,
      height: 22,
      buffer: source.resize({ width: 22, height: 22, quality: "best" }).toPNG(),
    });
    image.addRepresentation({
      scaleFactor: 2,
      width: TRAY_CANVAS,
      height: TRAY_CANVAS,
      buffer: source.resize({ width: TRAY_CANVAS, height: TRAY_CANVAS, quality: "best" }).toPNG(),
    });
    image.setTemplateImage(true);
    return image;
  }

  #sendCommand(command: AppMenuCommand): void {
    this.#options.showMainWindow();
    this.#options.mainWindow()?.webContents.send("agentkib:app-command", { command });
  }

  #sendNavigation(request: AppNavigationRequest): void {
    this.openMainWindow(request);
  }

  async #togglePopover(trayBounds: Rectangle): Promise<void> {
    const popover = await this.#getPopover();
    if (popover.isVisible()) {
      popover.hide();
      return;
    }
    // A click on the icon can first take focus from the open popover, which hides it; that same
    // click must not open it again.
    if (Date.now() - this.#popoverHiddenAt < 300) return;
    this.#popoverTray = trayBounds;
    this.#placePopover(popover);
    popover.show();
    popover.focus();
    this.#options.onPopoverShown?.();
  }

  async #getPopover(): Promise<BrowserWindow> {
    if (this.#popover && !this.#popover.isDestroyed()) return this.#popover;
    const popover = new BrowserWindow({
      width: POPOVER_WIDTH,
      height: this.#popoverHeight,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#fafafa",
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.#popover = popover;
    popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    popover.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    popover.webContents.on("will-navigate", (event, targetUrl) => {
      if (new URL(targetUrl).origin !== new URL(this.#options.rendererUrl()).origin) {
        event.preventDefault();
      }
    });
    popover.on("blur", () => popover.hide());
    popover.on("hide", () => {
      this.#popoverHiddenAt = Date.now();
    });
    popover.once("closed", () => {
      if (this.#popover === popover) this.#popover = undefined;
    });
    await popover.loadURL(this.#options.rendererUrl("menubar"));
    return popover;
  }

  /** Below the menu bar icon, or above it when the taskbar is at the bottom; inside the screen. */
  #placePopover(popover: BrowserWindow): void {
    const tray = this.#popoverTray;
    if (!tray) return;
    const display = screen.getDisplayNearestPoint({
      x: Math.round(tray.x + tray.width / 2),
      y: Math.round(tray.y + tray.height / 2),
    });
    const area = display.workArea;
    const x = Math.min(
      Math.max(Math.round(tray.x + tray.width / 2 - POPOVER_WIDTH / 2), area.x + POPOVER_GAP),
      area.x + area.width - POPOVER_WIDTH - POPOVER_GAP,
    );
    const top = Math.max(area.y, Math.round(tray.y + tray.height + POPOVER_GAP));
    const bottom = Math.min(area.y + area.height, Math.round(tray.y - POPOVER_GAP));
    // The menu bar or a top taskbar leaves room below the icon; a bottom taskbar, above it.
    const below = tray.y + tray.height / 2 < area.y + area.height / 2;
    const room = below ? area.y + area.height - POPOVER_GAP - top : bottom - area.y - POPOVER_GAP;
    const height = Math.max(POPOVER_MIN_HEIGHT, Math.min(this.#popoverHeight, room));
    popover.setBounds({ x, y: below ? top : bottom - height, width: POPOVER_WIDTH, height }, false);
  }

  #tr(key: string, params: Record<string, string | number> = {}): string {
    const template = messages[this.#locale][key] ?? messages["en-US"][key] ?? key;
    return Object.entries(params).reduce(
      (value, [name, replacement]) => value.replaceAll(`{{${name}}}`, String(replacement)),
      template,
    );
  }
}

export function resolveNativeShellTrayIcon(): string {
  const filename = process.platform === "win32" ? "tray-icon-windows.png" : "tray-icon.png";
  if (app.isPackaged) return path.join(process.resourcesPath, "icons", filename);
  return path.resolve(__dirname, "../resources/icons", filename);
}
