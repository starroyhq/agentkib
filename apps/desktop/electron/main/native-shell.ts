import path from "node:path";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
  type MenuItemConstructorOptions,
  type Rectangle,
  type WebContents,
} from "electron";
import enUS from "../../src/locales/en-US.json";
import jaJP from "../../src/locales/ja-JP.json";
import zhCN from "../../src/locales/zh-CN.json";
import zhTW from "../../src/locales/zh-TW.json";
import type {
  AppMenuCommand,
  AppNavigationRequest,
  McpHubStatus,
  RefreshJobStatus,
  SupportedLocale,
  WorkspaceSummary,
} from "../../src/core/types";
import { RUNTIME_METHODS } from "../generated/runtime-protocol";
import type { RuntimeHost } from "./runtime-host";

const QUOTA_POPOVER_WIDTH = 392;
const QUOTA_POPOVER_HEIGHT = 560;

const messages: Record<SupportedLocale, Record<string, string>> = {
  "en-US": enUS,
  "ja-JP": jaJP,
  "zh-CN": zhCN,
  "zh-TW": zhTW,
};

interface NativeShellOptions {
  runtime(): RuntimeHost;
  mainWindow(): BrowserWindow | undefined;
  preloadPath: string;
  rendererUrl(surface?: "quota-popover"): string;
  trayIconPath: string;
  locale: SupportedLocale;
  refreshStatus(): RefreshJobStatus[];
  showMainWindow(): void;
  requestQuit(): void;
  requestRefresh(kind: "discovery" | "insights" | "quota" | "all"): void;
}

export class ElectronNativeShell {
  readonly #options: NativeShellOptions;
  #locale: SupportedLocale;
  #tray: Tray | undefined;
  #quotaPopover: BrowserWindow | undefined;
  #trayRefresh: Promise<void> | undefined;
  #trayRefreshPending = false;

  constructor(options: NativeShellOptions) {
    this.#options = options;
    this.#locale = options.locale;
  }

  create(): void {
    this.#installApplicationMenu();
    this.#createTray();
    void this.refreshTrayStatus();
  }

  get trayAvailable(): boolean {
    return Boolean(this.#tray && !this.#tray.isDestroyed());
  }

  ownsWebContents(sender: WebContents): boolean {
    return Boolean(
      this.#quotaPopover &&
      !this.#quotaPopover.isDestroyed() &&
      sender === this.#quotaPopover.webContents,
    );
  }

  setLocale(locale: SupportedLocale): void {
    if (this.#locale === locale) return;
    this.#locale = locale;
    this.#installApplicationMenu();
    this.#setTrayTooltip();
    void this.refreshTrayStatus();
  }

  translate(key: string, params: Record<string, string | number> = {}): string {
    return this.#tr(key, params);
  }

  async refreshTrayStatus(): Promise<void> {
    if (!this.trayAvailable) return;
    if (this.#trayRefresh) {
      this.#trayRefreshPending = true;
      return this.#trayRefresh;
    }

    const refresh = this.#loadTrayStatus()
      .then(({ workspaces, hub, refreshJobs }) => {
        if (!this.trayAvailable) return;
        this.#tray?.setContextMenu(this.#buildTrayMenu(workspaces, hub, refreshJobs));
      })
      .catch(() => {
        if (this.trayAvailable) this.#tray?.setContextMenu(this.#buildTrayMenu([], undefined, []));
      })
      .finally(() => {
        if (this.#trayRefresh !== refresh) return;
        this.#trayRefresh = undefined;
        if (this.#trayRefreshPending) {
          this.#trayRefreshPending = false;
          void this.refreshTrayStatus();
        }
      });
    this.#trayRefresh = refresh;
    return refresh;
  }

  hideMainWindow(): void {
    const window = this.#options.mainWindow();
    if (!window || window.isDestroyed()) return;
    this.#quotaPopover?.hide();
    if (this.trayAvailable) {
      window.hide();
      if (process.platform === "darwin") app.dock?.hide();
      return;
    }
    window.minimize();
  }

  destroy(): void {
    if (this.#quotaPopover && !this.#quotaPopover.isDestroyed()) this.#quotaPopover.destroy();
    this.#quotaPopover = undefined;
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
          { label: this.#tr("nav.assets"), accelerator: "CmdOrCtrl+3", click: navigate("catalog") },
          { label: this.#tr("nav.agents"), accelerator: "CmdOrCtrl+4", click: navigate("agents") },
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
    const image = this.#createTrayImage();
    if (image.isEmpty()) return;
    if (process.platform === "darwin") image.setTemplateImage(true);
    this.#tray = new Tray(image);
    this.#setTrayTooltip();
    this.#tray.setContextMenu(this.#buildTrayMenu([], undefined, []));
    this.#tray.on("click", (_event, bounds) => {
      if (process.platform === "darwin") {
        void this.#toggleQuotaPopover(bounds);
        return;
      }
      this.#options.showMainWindow();
    });
  }

  #setTrayTooltip(): void {
    this.#tray?.setToolTip(this.#tr("tray.tooltip", { appName: app.getName() }));
  }

  #buildTrayMenu(
    workspaces: WorkspaceSummary[],
    hub: McpHubStatus | undefined,
    refreshJobs: RefreshJobStatus[],
  ): Menu {
    const activeKinds = refreshJobs
      .filter((status) => status.state === "queued" || status.state === "running")
      .map((status) => status.kind);
    const attention = workspaces.filter((workspace) => workspace.status !== "healthy").length;
    const statusLabel =
      this.#activeRefreshLabel(activeKinds) ??
      this.#tr("tray.status", {
        workspaces: workspaces.length,
        attention,
      });
    const hubLabel = hub
      ? `MCP Hub · ${this.#tr(hub.running ? "mcp.running" : "mcp.stopped")} · ${hub.runtime_count}`
      : `MCP Hub · ${this.#tr("mcp.stopped")} · 0`;
    return Menu.buildFromTemplate([
      {
        label: this.#tr("tray.open", { appName: app.getName() }),
        click: () => this.#options.showMainWindow(),
      },
      {
        label: this.#tr("tray.quotaAll"),
        click: () => this.#sendNavigation({ page: "quota", configure_popover: false }),
      },
      {
        label: this.#tr("tray.refreshQuotaAction"),
        click: () => this.#options.requestRefresh("quota"),
      },
      { type: "separator" },
      { label: statusLabel, enabled: false },
      { label: hubLabel, enabled: false },
      {
        label: this.#tr("nav.settings"),
        click: () =>
          this.#sendNavigation({
            page: "settings",
            settings_section: "general",
            configure_popover: false,
          }),
      },
      { label: this.#tr("tray.refreshAll"), click: () => this.#options.requestRefresh("all") },
      { type: "separator" },
      {
        label: this.#tr("tray.quit", { appName: app.getName() }),
        click: () => this.#options.requestQuit(),
      },
    ]);
  }

  async #loadTrayStatus(): Promise<{
    workspaces: WorkspaceSummary[];
    hub: McpHubStatus;
    refreshJobs: RefreshJobStatus[];
  }> {
    const runtime = this.#options.runtime();
    const [workspaces, hub] = await Promise.all([
      runtime.request<WorkspaceSummary[]>(RUNTIME_METHODS.listWorkspaces, {}),
      runtime.request<McpHubStatus>(RUNTIME_METHODS.mcpHubStatus, {}),
    ]);
    const refreshJobs = this.#options.refreshStatus();
    return { workspaces, hub, refreshJobs };
  }

  #activeRefreshLabel(kinds: RefreshJobStatus["kind"][]): string | undefined {
    if (kinds.length > 1) return this.#tr("tray.refreshMultiple");
    switch (kinds[0]) {
      case "discovery":
        return this.#tr("tray.refreshDiscovery");
      case "insights":
        return this.#tr("tray.refreshInsights");
      case "gateways":
        return this.#tr("tray.refreshGateways");
      case "quota":
        return this.#tr("tray.refreshQuota");
      default:
        return undefined;
    }
  }

  #sendCommand(command: AppMenuCommand): void {
    this.#options.showMainWindow();
    this.#options.mainWindow()?.webContents.send("agentkib:app-command", { command });
  }

  #sendNavigation(request: AppNavigationRequest): void {
    this.#quotaPopover?.hide();
    this.#options.showMainWindow();
    this.#options.mainWindow()?.webContents.send("agentkib:navigate", request);
  }

  async #toggleQuotaPopover(trayBounds: Rectangle): Promise<void> {
    const popover = await this.#getQuotaPopover();
    if (popover.isVisible()) {
      popover.hide();
      return;
    }
    this.#positionQuotaPopover(popover, trayBounds);
    popover.show();
    popover.focus();
    void this.refreshTrayStatus();
  }

  async #getQuotaPopover(): Promise<BrowserWindow> {
    if (this.#quotaPopover && !this.#quotaPopover.isDestroyed()) return this.#quotaPopover;
    const popover = new BrowserWindow({
      width: QUOTA_POPOVER_WIDTH,
      height: QUOTA_POPOVER_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: true,
      backgroundColor: "#0a0a0a",
      webPreferences: {
        preload: this.#options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.#quotaPopover = popover;
    popover.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    popover.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    popover.webContents.on("will-navigate", (event, targetUrl) => {
      if (new URL(targetUrl).origin !== new URL(this.#options.rendererUrl()).origin) {
        event.preventDefault();
      }
    });
    popover.on("blur", () => popover.hide());
    popover.once("closed", () => {
      if (this.#quotaPopover === popover) this.#quotaPopover = undefined;
    });
    await popover.loadURL(this.#options.rendererUrl("quota-popover"));
    return popover;
  }

  #positionQuotaPopover(popover: BrowserWindow, trayBounds: Rectangle): void {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(trayBounds.x + trayBounds.width / 2),
      y: Math.round(trayBounds.y + trayBounds.height / 2),
    });
    const area = display.workArea;
    const x = Math.min(
      Math.max(Math.round(trayBounds.x + trayBounds.width / 2 - QUOTA_POPOVER_WIDTH / 2), area.x),
      area.x + area.width - QUOTA_POPOVER_WIDTH,
    );
    const below = Math.round(trayBounds.y + trayBounds.height + 6);
    const above = Math.round(trayBounds.y - QUOTA_POPOVER_HEIGHT - 6);
    const y = below + QUOTA_POPOVER_HEIGHT <= area.y + area.height ? below : above;
    popover.setPosition(x, Math.max(area.y, y), false);
  }

  #createTrayImage(): Electron.NativeImage {
    const source = nativeImage.createFromPath(this.#options.trayIconPath);
    if (source.isEmpty() || process.platform !== "darwin") return source;
    const image = nativeImage.createEmpty();
    image.addRepresentation({
      scaleFactor: 1,
      width: 16,
      height: 16,
      buffer: source.resize({ width: 16, height: 16 }).toPNG(),
    });
    image.addRepresentation({
      scaleFactor: 2,
      width: 32,
      height: 32,
      buffer: source.resize({ width: 32, height: 32 }).toPNG(),
    });
    return image;
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
