import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { WebAccessService } from "./web/service";
import { acceptanceSession } from "./web/acceptance";
import { requireRemoteRequest } from "./ipc/remote-validation";
import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  protocol,
  powerMonitor,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { autoUpdater } from "electron-updater";
import type { QuotaSnapshot, RefreshJobStatus, SupportedLocale } from "../../src/core/types";
import { RUNTIME_METHODS, type RuntimeHandshakeResult } from "../generated/runtime-protocol";
import { DesktopRuntimeHost, type RuntimeHostStatus } from "./runtime-host";
import { registerRuntimeIpc } from "./ipc/runtime";
import { ElectronNativeShell, resolveNativeShellTrayIcon } from "./native-shell";
import { ElectronRefreshCoordinator } from "./refresh-coordinator";
import { StartupBenchmark } from "./startup-benchmark";
import { firstCloseDecision } from "./close-behavior";
import { normalizeReleaseNotes } from "./release-notes";
import {
  optionalCloseBehavior,
  optionalPositiveInteger,
  optionalString,
  requireAccentThemePreference,
  requireAppIconPreference,
  requireBoolean,
  requireObject,
  requirePositiveInteger,
  requireSidebarWidthPreference,
  requireString,
  requireText,
  requireThemePreference,
} from "./ipc/validation";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const isDevelopmentApp = process.env.AGENTKIB_DEV === "1" || !app.isPackaged;
const appDisplayName = isDevelopmentApp ? "AgentKib Dev" : "AgentKib";
const appFlavor = isDevelopmentApp ? "ai.agentkib.dev" : "ai.agentkib";
app.setName(appDisplayName);
const electronDataPath =
  process.env.AGENTKIB_BENCHMARK_USER_DATA ??
  path.join(app.getPath("appData"), appFlavor, "electron");
app.setPath("userData", electronDataPath);
app.setPath("sessionData", electronDataPath);

let mainWindow: BrowserWindow | undefined;
let systemSuspended = false;
let screenLocked = false;
let nativeShell: ElectronNativeShell | undefined;
let refreshCoordinator: ElectronRefreshCoordinator | undefined;
let runtimeHost: DesktopRuntimeHost | undefined;
let webAccess: WebAccessService | undefined;
let runtimeHandshake: RuntimeHandshakeResult | undefined;
let shutdownStarted = false;
let quitApproved = false;
let closeBehavior: "minimize-to-tray" | "quit" | undefined;
let appIconPreference: "white" | "black" = "white";
let pendingUpdateVersion: string | undefined;
let applicationInitialized = false;
let applicationInitialization: Promise<void> | undefined;
let startupFailureWindow: BrowserWindow | undefined;
let ipcHandlersRegistered = false;
let closePromptOpen = false;
let benchmarkCompletionStarted = false;
const startupBenchmark = new StartupBenchmark();

// Keep the desktop window comfortably above the renderer's 1024px compact breakpoint.
// 1280px is Tailwind's default `xl` breakpoint and leaves room for the desktop layout.
const MAIN_WINDOW_MIN_WIDTH = 1280;

interface ElectronRuntimeInfo {
  close_behavior?: "minimize-to-tray" | "quit";
  app_icon_preference?: "white" | "black";
  theme_preference?: "system" | "light" | "dark";
  accent_theme_preference?:
    | "minimal-neutral"
    | "vtron"
    | "claude"
    | "sakura"
    | "ocean-breeze"
    | null;
  sidebar_width_preference?: number | null;
  effective_theme?: "light" | "dark";
  effective_locale?: SupportedLocale;
  quota_auto_refresh_enabled?: boolean;
  local_auto_refresh_enabled?: boolean;
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(startApplication).catch(handleStartupFailure);
}

app.on("activate", () => {
  if (!applicationInitialized) return;
  if (!mainWindow || mainWindow.isDestroyed()) void createMainWindow();
  else showMainWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (shutdownStarted || !runtimeHost) return;
  if (!quitApproved) {
    event.preventDefault();
    requestRendererQuitGuard();
    return;
  }
  event.preventDefault();
  shutdownStarted = true;
  refreshCoordinator?.stop();
  nativeShell?.destroy();
  void (async () => {
    try {
      await webAccess?.shutdown();
    } finally {
      await runtimeHost?.stop();
    }
  })().finally(() => app.quit());
});

nativeTheme.on("updated", () => {
  sendRendererEvent("agentkib:theme-changed", nativeTheme.shouldUseDarkColors ? "dark" : "light");
});

async function startApplication(): Promise<void> {
  startupBenchmark.mark("app-ready");
  await registerRendererProtocol();

  runtimeHost = new DesktopRuntimeHost({
    executablePath: resolveRuntimeExecutable(),
    clientVersion: app.getVersion(),
    environment: {
      AGENTKIB_APP_FLAVOR: appFlavor,
      AGENTKIB_APP_NAME: appDisplayName,
      AGENTKIB_APP_VERSION: app.getVersion(),
      AGENTKIB_LOCALE: normalizeSystemLocale(app.getLocale()),
      AGENTKIB_SYSTEM_THEME: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      AGENTKIB_QUOTA_SIDECAR: resolveQuotaSidecar(),
    },
  });
  runtimeHost.on("ready", (handshake: RuntimeHandshakeResult) => {
    runtimeHandshake = handshake;
    startupBenchmark.setRuntimePid(handshake.pid);
    startupBenchmark.mark("runtime-handshake");
    refreshCoordinator?.setRuntimeAvailable(true);
    void initializeRuntimeServices().catch((error: unknown) => {
      process.stderr.write(`AgentKib runtime services failed: ${String(error)}\n`);
    });
  });
  runtimeHost.on("state", (status: RuntimeHostStatus) => {
    sendRendererEvent("agentkib:runtime:status", status);
  });
  runtimeHost.on("exit", ({ expected }: { expected: boolean }) => {
    runtimeHandshake = undefined;
    webAccess?.runtimeUnavailable();
    if (!expected) refreshCoordinator?.setRuntimeAvailable(false);
  });
  runtimeHost.on("restart-error", (error: unknown) => {
    process.stderr.write(`AgentKib runtime restart failed: ${String(error)}\n`);
  });
  runtimeHost.on("crash-loop", (error: Error) => {
    process.stderr.write(`AgentKib runtime entered a crash loop: ${error.message}\n`);
  });

  webAccess = new WebAccessService({
    acceptanceSessionId: acceptanceSession(process.env),
    dataDir: path.join(electronDataPath, "web"),
    staticDir: app.isPackaged
      ? path.join(process.resourcesPath, "web")
      : path.resolve(app.getAppPath(), "../web/dist"),
    runtimeRequest: (params) => {
      if (!runtimeHandshake) return Promise.reject(new Error("runtime_unavailable"));
      return requireRuntime().request(RUNTIME_METHODS.webRequest, params);
    },
  });
  await webAccess.initialize();
  registerApplicationIpc();
  refreshCoordinator = new ElectronRefreshCoordinator({
    runtime: requireRuntime,
    loadQuotaSchedule: async () =>
      JSON.parse(await readFile(path.join(electronDataPath, "refresh-state.json"), "utf8")),
    saveQuotaSchedule: async (state) => {
      await mkdir(electronDataPath, { recursive: true });
      const destination = path.join(electronDataPath, "refresh-state.json");
      await writeFile(`${destination}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${destination}.tmp`, destination);
    },
    isMainWindowVisible: () =>
      Boolean(
        mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        !mainWindow.isMinimized(),
      ),
    onStatus: emitElectronRefreshState,
    onQuotaSnapshot: (snapshot: QuotaSnapshot) =>
      sendRendererEvent("agentkib:quota-updated", snapshot),
  });

  const updatePowerActivity = () => {
    const paused = systemSuspended || screenLocked;
    refreshCoordinator?.setSuspended(paused);
    sendRendererEvent(
      "agentkib:window-activity",
      !paused && Boolean(mainWindow?.isVisible() && !mainWindow?.isMinimized()),
    );
  };
  powerMonitor.on("suspend", () => {
    systemSuspended = true;
    updatePowerActivity();
  });
  powerMonitor.on("lock-screen", () => {
    screenLocked = true;
    updatePowerActivity();
  });
  powerMonitor.on("resume", () => {
    systemSuspended = false;
    updatePowerActivity();
  });
  powerMonitor.on("unlock-screen", () => {
    screenLocked = false;
    updatePowerActivity();
  });

  startupBenchmark.mark("runtime-spawn");
  void runtimeHost.start().catch((error: unknown) => {
    if (!startupBenchmark.enabled) return;
    process.stderr.write(`AgentKib benchmark runtime startup failed: ${String(error)}\n`);
    app.exit(1);
  });
  await createMainWindow();
  applicationInitialized = true;
}

function registerApplicationIpc(): void {
  if (ipcHandlersRegistered) return;
  ipcMain.handle("agentkib:runtime:handshake", (event) => {
    assertTrustedRenderer(event);
    if (!runtimeHandshake) throw new Error("AgentKib runtime is not ready");
    return runtimeHandshake;
  });
  ipcMain.handle("agentkib:runtime:status", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().status;
  });
  ipcMain.handle("agentkib:runtime:retry", async (event) => {
    assertTrustedRenderer(event);
    await requireRuntime().retry();
  });
  ipcMain.handle("agentkib:benchmark:mark", async (event, name: unknown) => {
    assertTrustedRenderer(event);
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
    if (
      name !== "renderer-first-commit" &&
      name !== "home-data-ready" &&
      name !== "home-data-failed"
    )
      return;
    if (name === "home-data-failed") {
      if (startupBenchmark.enabled) {
        process.stderr.write("AgentKib benchmark failed because a required home query failed.\n");
        app.exit(1);
      }
      return;
    }
    startupBenchmark.mark(name);
    if (name === "renderer-first-commit") {
      startupBenchmark.mark("window-shown");
      mainWindow.show();
    }
    if (name === "home-data-ready") {
      await completeStartupBenchmarkWhenReady();
    }
  });
  registerRuntimeIpc({
    runtime: requireRuntime,
    assertTrustedRenderer,
    withRuntimeCapabilities: withElectronRuntimeCapabilities,
  });
  registerHomeIpc();
  registerShellIpc();
  registerUpdateIpc();
  ipcHandlersRegistered = true;
}

async function initializeRuntimeServices(): Promise<void> {
  if (applicationInitialization) return applicationInitialization;

  applicationInitialization = (async () => {
    const runtime = await requireRuntime().request<ElectronRuntimeInfo>(
      RUNTIME_METHODS.runtimeInfo,
      {},
    );
    startupBenchmark.mark("runtime-info");
    closeBehavior = runtime.close_behavior;
    appIconPreference = runtime.app_icon_preference ?? "white";
    applyApplicationIcon(appIconPreference);
    if (runtime.theme_preference) nativeTheme.themeSource = runtime.theme_preference;
    else if (runtime.effective_theme) nativeTheme.themeSource = runtime.effective_theme;

    if (!nativeShell) {
      nativeShell = new ElectronNativeShell({
        runtime: requireRuntime,
        mainWindow: () => mainWindow,
        preloadPath: path.join(__dirname, "preload.cjs"),
        rendererUrl,
        trayIconPath: resolveNativeShellTrayIcon(),
        locale: runtime.effective_locale ?? normalizeSystemLocale(app.getLocale()),
        refreshStatus: () => refreshCoordinator?.statuses() ?? [],
        showMainWindow,
        requestQuit: requestRendererQuitGuard,
        requestRefresh: requestNativeRefresh,
      });
      nativeShell.create();
    }
    refreshCoordinator?.start();
  })();

  try {
    await applicationInitialization;
  } catch (error) {
    applicationInitialization = undefined;
    throw error;
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (process.platform === "darwin") app.dock?.show();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function requestRendererQuitGuard(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    quitApproved = true;
    app.quit();
    return;
  }
  showMainWindow();
  window.webContents.send("agentkib:quit-requested");
}

function requestNativeRefresh(kind: "discovery" | "insights" | "quota" | "all"): void {
  const request =
    kind === "all"
      ? requireRefreshCoordinator().requestAll(true)
      : requireRefreshCoordinator().request(kind, true);
  void request.finally(() => nativeShell?.refreshTrayStatus()).catch(() => undefined);
}

function withElectronRuntimeCapabilities(runtime: unknown): unknown {
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) return runtime;
  const enriched = { ...(runtime as Record<string, unknown>) };
  enriched.tray_available = nativeShell?.trayAvailable ?? false;
  if (enriched.theme_preference === "system") {
    enriched.effective_theme = nativeTheme.shouldUseDarkColors ? "dark" : "light";
  }
  return enriched;
}

function emitElectronRefreshState(status: RefreshJobStatus): void {
  sendRendererEvent("agentkib:electron-refresh-state", status);
  void nativeShell?.refreshTrayStatus();
}

function sendRendererEvent(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function registerUpdateIpc(): void {
  const updaterChannel =
    process.platform === "darwin" || process.platform === "win32" ? process.arch : undefined;
  if (updaterChannel) autoUpdater.channel = updaterChannel;
  nativeAutoUpdater.on("before-quit-for-update", () => {
    quitApproved = true;
  });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  ipcMain.handle("agentkib:updates:check", async (event) => {
    assertTrustedRenderer(event);
    if (!app.isPackaged || process.env.AGENTKIB_DEV === "1") return undefined;
    const result = await autoUpdater.checkForUpdates();
    const update = result?.updateInfo;
    if (!update || update.version === app.getVersion()) {
      pendingUpdateVersion = undefined;
      return undefined;
    }
    pendingUpdateVersion = update.version;
    return {
      current_version: app.getVersion(),
      version: update.version,
      published_at: update.releaseDate || undefined,
      notes: normalizeReleaseNotes(update.releaseNotes),
      release_url: `https://github.com/starroyhq/agentkib/releases/tag/v${update.version}`,
      install_mode: process.platform === "linux" && !process.env.APPIMAGE ? "manual" : "in-app",
    };
  });
  ipcMain.handle("agentkib:updates:install", async (event, version: unknown) => {
    assertTrustedRenderer(event);
    if (!app.isPackaged || process.env.AGENTKIB_DEV === "1") {
      throw new Error("errors.updateUnavailableInDevelopment");
    }
    const expectedVersion = requireString(version, "version");
    if (process.platform === "linux" && !process.env.APPIMAGE) {
      throw new Error("errors.updateManualInstallRequired");
    }
    if (pendingUpdateVersion !== expectedVersion) {
      throw new Error("errors.updateChanged");
    }
    const progressChannel = "agentkib:updates:progress";
    const onProgress = (progress: { transferred: number; total: number }) => {
      event.sender.send(progressChannel, {
        event: "progress",
        data: {
          downloaded: progress.transferred,
          content_length: progress.total || undefined,
        },
      });
    };
    autoUpdater.on("download-progress", onProgress);
    try {
      event.sender.send(progressChannel, { event: "started", data: {} });
      await autoUpdater.downloadUpdate();
      event.sender.send(progressChannel, { event: "finished" });
      pendingUpdateVersion = undefined;
      autoUpdater.quitAndInstall();
    } finally {
      autoUpdater.removeListener("download-progress", onProgress);
    }
  });
}

function registerShellIpc(): void {
  ipcMain.handle("agentkib:shell:open-directory", async (event, title: unknown) => {
    assertTrustedRenderer(event);
    const window = mainWindow;
    if (!window) throw new Error("AgentKib window is not ready");
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
      title: title === undefined ? undefined : requireText(title, "title"),
    });
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle("agentkib:shell:open-external", async (event, value: unknown) => {
    assertTrustedRenderer(event);
    const target = new URL(requireText(value, "url"));
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new Error("Only HTTP(S) external URLs are supported");
    }
    await shell.openExternal(target.toString());
  });
  ipcMain.handle("agentkib:shell:open-files-and-folders-settings", (event) => {
    assertTrustedRenderer(event);
    const settingsUrl =
      process.platform === "darwin"
        ? "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
        : process.platform === "win32"
          ? "ms-settings:privacy-broadfilesystemaccess"
          : undefined;
    if (!settingsUrl) throw new Error("Opening file and folder settings is not supported");
    return shell.openExternal(settingsUrl);
  });
  ipcMain.handle("agentkib:shell:open-quota-dashboard", (event, request: unknown) => {
    assertTrustedRenderer(event);
    const navigation = requireObject(request, "navigation request");
    if (navigation.page !== "quota") throw new Error("Only quota navigation is supported");
    showMainWindow();
    mainWindow?.webContents.send("agentkib:navigate", navigation);
  });
  ipcMain.handle("agentkib:shell:hide-window", (event) => {
    assertTrustedRenderer(event);
    BrowserWindow.fromWebContents(event.sender)?.hide();
  });
  ipcMain.handle("agentkib:shell:quit", (event) => {
    assertTrustedRenderer(event);
    quitApproved = true;
    app.quit();
  });
  ipcMain.handle("agentkib:settings:set-close-behavior", (event, value: unknown) => {
    assertTrustedRenderer(event);
    const next = optionalCloseBehavior(value);
    closeBehavior = next;
    return requireRuntime().request(RUNTIME_METHODS.setCloseBehavior, { value: next ?? null });
  });
  ipcMain.handle("agentkib:settings:set-locale", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request<ElectronRuntimeInfo>(RUNTIME_METHODS.setLocale, {
        preference: requireString(preference, "preference"),
      })
      .then((runtime) => {
        if (runtime.effective_locale) nativeShell?.setLocale(runtime.effective_locale);
        return withElectronRuntimeCapabilities(runtime);
      });
  });
  ipcMain.handle("agentkib:settings:set-theme", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    const next = requireThemePreference(preference);
    nativeTheme.themeSource = next;
    return requireRuntime()
      .request(RUNTIME_METHODS.setThemePreference, { preference: next })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:settings:set-accent-theme", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    const next = requireAccentThemePreference(preference);
    return requireRuntime()
      .request(RUNTIME_METHODS.setAccentThemePreference, { preference: next })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:settings:set-app-icon", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    const next = requireAppIconPreference(preference);
    return requireRuntime()
      .request(RUNTIME_METHODS.setAppIconPreference, { preference: next })
      .then((runtime) => {
        appIconPreference = next;
        applyApplicationIcon(appIconPreference);
        return withElectronRuntimeCapabilities(runtime);
      });
  });
  ipcMain.handle("agentkib:settings:set-sidebar-width", (event, preference: unknown) => {
    assertTrustedRenderer(event);
    const next = requireSidebarWidthPreference(preference);
    return requireRuntime()
      .request(RUNTIME_METHODS.setSidebarWidthPreference, { preference: next })
      .then(withElectronRuntimeCapabilities);
  });
}

function registerHomeIpc(): void {
  ipcMain.handle("agentkib:remote:request", (event, input: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.remoteRequest, requireRemoteRequest(input));
  });
  ipcMain.handle("agentkib:web:request", (event, input: unknown) => {
    assertTrustedRenderer(event);
    if (!webAccess) throw new Error("web_unavailable");
    return webAccess.request(input as Parameters<WebAccessService["request"]>[0]);
  });
  ipcMain.handle("agentkib:home:runtime", async (event) => {
    assertTrustedRenderer(event);
    const runtime = await requireRuntime().request(RUNTIME_METHODS.runtimeInfo, {});
    return withElectronRuntimeCapabilities(runtime);
  });
  ipcMain.handle("agentkib:home:workspaces", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listWorkspaces, {});
  });
  ipcMain.handle("agentkib:home:agent-installations", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listAgentInstallations, {});
  });
  ipcMain.handle("agentkib:home:agent-tools", (event, force: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.agentToolsStatus, {
      force: force === undefined ? false : requireBoolean(force, "force"),
    });
  });
  ipcMain.handle("agentkib:home:execute-agent-tool", (event, agent: unknown, actionId: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.agentToolExecute, {
      agent: requireString(agent, "agent"),
      action_id: requireText(actionId, "actionId"),
      confirmed: true,
    });
  });
  ipcMain.handle("agentkib:home:catalog-assets", (event, input: unknown) => {
    assertTrustedRenderer(event);
    const value = requireObject(input, "catalog query");
    return requireRuntime().request(RUNTIME_METHODS.searchCatalogAssets, {
      query: value.query === undefined ? "" : requireText(value.query, "query"),
      agent: optionalString(value.agent, "agent"),
      workspaceId: optionalString(value.workspaceId, "workspaceId"),
      limit: optionalPositiveInteger(value.limit, "limit") ?? 500,
    });
  });
  ipcMain.handle("agentkib:home:global-memories", (event, status: unknown) => {
    assertTrustedRenderer(event);
    if (status !== undefined && !MEMORY_STATUSES.has(requireString(status, "status"))) {
      throw new Error(`Unsupported memory status: ${String(status)}`);
    }
    return requireRuntime().request(RUNTIME_METHODS.listGlobalMemories, { status });
  });
  ipcMain.handle("agentkib:home:activity", (event, limit: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listActivity, {
      limit: optionalPositiveInteger(limit, "limit") ?? 200,
    });
  });
  ipcMain.handle("agentkib:home:scan-roots", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listScanRoots, {});
  });
  ipcMain.handle("agentkib:home:add-scan-root", (event, rootPath: unknown, maxDepth: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.addScanRoot, {
      path: requireString(rootPath, "path"),
      maxDepth: requirePositiveInteger(maxDepth, "maxDepth"),
    });
  });
  ipcMain.handle("agentkib:home:remove-scan-root", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.removeScanRoot, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-discovery", (event, force: unknown) => {
    assertTrustedRenderer(event);
    return requireRefreshCoordinator().request(
      "discovery",
      force === undefined ? true : requireBoolean(force, "force"),
    );
  });
  ipcMain.handle("agentkib:home:discovery-report", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.discoveryReport, {});
  });
  ipcMain.handle("agentkib:home:excluded-workspaces", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listExcludedWorkspaces, {});
  });
  ipcMain.handle("agentkib:home:remote-gateways", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.listRemoteGateways, {});
  });
  ipcMain.handle("agentkib:home:refresh-gateways", (event, force: unknown) => {
    assertTrustedRenderer(event);
    return requireRefreshCoordinator().request(
      "gateways",
      force === undefined ? true : requireBoolean(force, "force"),
    );
  });
  ipcMain.handle("agentkib:home:save-remote-gateway", (event, input: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.saveRemoteGateway, {
      input: requireObject(input, "remote gateway"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-remote-gateway", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.refreshRemoteGateway, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:home:remove-remote-gateway", (event, id: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.removeRemoteGateway, {
      id: requireString(id, "id"),
    });
  });
  ipcMain.handle("agentkib:home:insights-view", (event, query: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.insightsView, {
      query: requireObject(query, "insights query"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-insights", (event, force: unknown) => {
    assertTrustedRenderer(event);
    return requireRefreshCoordinator().request(
      "insights",
      force === undefined ? true : requireBoolean(force, "force"),
    );
  });
  ipcMain.handle("agentkib:home:insights-summary", (event, query: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.insightsSummary, {
      query: requireObject(query, "insights query"),
    });
  });
  ipcMain.handle("agentkib:home:insights-status", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.insightsStatus, {});
  });
  ipcMain.handle("agentkib:home:quota-collector-status", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.quotaCollectorStatus, {});
  });
  ipcMain.handle("agentkib:home:quota-snapshot", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.quotaSnapshot, {});
  });
  ipcMain.handle("agentkib:home:quota-preferences", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.quotaPreferences, {});
  });
  ipcMain.handle("agentkib:home:set-quota-preferences", (event, preferences: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.setQuotaPreferences, {
      preferences: requireObject(preferences, "quota preferences"),
    });
  });
  ipcMain.handle("agentkib:home:refresh-quota", (event, force: unknown) => {
    assertTrustedRenderer(event);
    return requireRefreshCoordinator().request(
      "quota",
      force === undefined ? true : requireBoolean(force, "force"),
    );
  });
  ipcMain.handle("agentkib:home:set-local-auto-refresh", async (event, enabled: unknown) => {
    assertTrustedRenderer(event);
    const runtime = await requireRuntime().request<ElectronRuntimeInfo>(
      RUNTIME_METHODS.setLocalAutoRefresh,
      {
        value: requireBoolean(enabled, "enabled"),
      },
    );
    requireRefreshCoordinator().activityChanged();
    return withElectronRuntimeCapabilities(runtime);
  });
  ipcMain.handle("agentkib:home:set-quota-auto-refresh", (event, enabled: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request<ElectronRuntimeInfo>(RUNTIME_METHODS.setQuotaAutoRefresh, {
        value: requireBoolean(enabled, "enabled"),
      })
      .then((runtime) => {
        if (runtime.quota_auto_refresh_enabled) {
          void requireRefreshCoordinator().refreshIfDue();
        }
        return withElectronRuntimeCapabilities(runtime);
      });
  });
  ipcMain.handle("agentkib:home:set-quota-prompt-seen", (event, seen: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request(RUNTIME_METHODS.setQuotaPromptSeen, {
        value: requireBoolean(seen, "seen"),
      })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:home:refresh-status", (event) => {
    assertTrustedRenderer(event);
    return requireRefreshCoordinator().statuses();
  });
  ipcMain.handle("agentkib:home:storage-overview", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.storageOverview, {});
  });
  ipcMain.handle(
    "agentkib:home:storage-children",
    (event, workspaceId: unknown, relativePath: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.storageChildren, {
        workspaceId: requireString(workspaceId, "workspaceId"),
        relativePath: requireText(relativePath, "relativePath"),
      });
    },
  );
  ipcMain.handle("agentkib:home:refresh-storage", (event, force: unknown) => {
    assertTrustedRenderer(event);
    return requireRefreshCoordinator().request(
      "storage",
      force === undefined ? true : requireBoolean(force, "force"),
    );
  });
  ipcMain.handle(
    "agentkib:home:open-storage-path",
    async (event, workspaceId: unknown, relativePath: unknown) => {
      assertTrustedRenderer(event);
      const target = await requireRuntime().request<string>(RUNTIME_METHODS.resolveStoragePath, {
        workspaceId: requireString(workspaceId, "workspaceId"),
        relativePath: requireText(relativePath, "relativePath"),
      });
      const error = await shell.openPath(target);
      if (error) throw new Error(error);
    },
  );
  ipcMain.handle("agentkib:home:cancel-storage", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.cancelStorage, {});
  });
  ipcMain.handle("agentkib:home:update-onboarding", (event, onboardingEvent: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime()
      .request(RUNTIME_METHODS.updateOnboarding, {
        event: requireObject(onboardingEvent, "onboarding event"),
      })
      .then(withElectronRuntimeCapabilities);
  });
  ipcMain.handle("agentkib:home:obsidian-integration", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.obsidianIntegration, {});
  });
  ipcMain.handle("agentkib:home:add-obsidian-vault", (event, vaultPath: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.addObsidianVault, {
      path: requireString(vaultPath, "path"),
    });
  });
  ipcMain.handle(
    "agentkib:home:link-obsidian-workspace",
    (event, workspaceId: unknown, vaultPath: unknown, relativeTarget: unknown) => {
      assertTrustedRenderer(event);
      return requireRuntime().request(RUNTIME_METHODS.linkObsidianWorkspace, {
        workspaceId: requireString(workspaceId, "workspaceId"),
        vaultPath: requireString(vaultPath, "vaultPath"),
        relativeTarget: optionalString(relativeTarget, "relativeTarget"),
      });
    },
  );
  ipcMain.handle("agentkib:home:unlink-obsidian-workspace", (event, workspaceId: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.unlinkObsidianWorkspace, {
      id: requireString(workspaceId, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:home:open-obsidian", (event) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.openObsidian, {});
  });
  ipcMain.handle("agentkib:home:open-obsidian-workspace", (event, workspaceId: unknown) => {
    assertTrustedRenderer(event);
    return requireRuntime().request(RUNTIME_METHODS.openObsidianWorkspace, {
      id: requireString(workspaceId, "workspaceId"),
    });
  });
  ipcMain.handle("agentkib:workspace:doctor-summaries", (event, ids: unknown) => {
    assertTrustedRenderer(event);
    if (!Array.isArray(ids)) throw new TypeError("workspaceIds must be an array");
    const workspaceIds = ids.map((id) => requireString(id, "workspaceId"));
    if (workspaceIds.length > 100) throw new RangeError("workspaceIds cannot exceed 100 items");
    return requireRuntime().request(RUNTIME_METHODS.workspaceDoctorSummaries, { workspaceIds });
  });
}

const MEMORY_STATUSES = new Set(["pending", "approved", "rejected", "invalidated"]);

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  if (mainWindow && event.sender === mainWindow.webContents) return;
  if (nativeShell?.ownsWebContents(event.sender)) return;
  throw new Error("Rejected IPC from an unknown renderer");
}

function requireRuntime(): DesktopRuntimeHost {
  if (!runtimeHost) throw new Error("AgentKib runtime host is not initialized");
  return runtimeHost;
}

function requireRefreshCoordinator(): ElectronRefreshCoordinator {
  if (!refreshCoordinator) throw new Error("AgentKib refresh coordinator is not ready");
  return refreshCoordinator;
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    title: "AgentKib",
    width: 1360,
    height: 860,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: 680,
    show: false,
    backgroundColor: "#0a0a0a",
    ...(process.platform !== "darwin" ? { icon: resolveApplicationIcon() } : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 15, y: 17 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  startupBenchmark.mark("window-created");
  mainWindow = window;

  window.on("close", (event) => {
    if (shutdownStarted || quitApproved) return;
    event.preventDefault();
    if (closeBehavior === "minimize-to-tray") {
      if (nativeShell?.trayAvailable) nativeShell.hideMainWindow();
      else window.minimize();
      return;
    }
    if (closeBehavior === "quit") {
      requestRendererQuitGuard();
      return;
    }
    void showFirstClosePrompt(window);
  });
  const updateWindowActivity = () => {
    refreshCoordinator?.activityChanged();
    sendRendererEvent(
      "agentkib:window-activity",
      !systemSuspended && !screenLocked && window.isVisible() && !window.isMinimized(),
    );
  };
  window.on("show", updateWindowActivity);
  window.on("hide", updateWindowActivity);
  window.on("minimize", updateWindowActivity);
  window.on("restore", updateWindowActivity);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    const allowedOrigin = process.env.VITE_DEV_SERVER_URL
      ? new URL(process.env.VITE_DEV_SERVER_URL).origin
      : "app://bundle";
    if (new URL(targetUrl).origin !== allowedOrigin) event.preventDefault();
  });
  window.once("ready-to-show", () => {
    startupBenchmark.mark("window-shown");
    if (!window.isVisible()) window.show();
    void completeStartupBenchmarkWhenReady();
  });
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
  });

  await window.loadURL(rendererUrl());
}

async function completeStartupBenchmarkWhenReady(): Promise<void> {
  if (
    benchmarkCompletionStarted ||
    !startupBenchmark.enabled ||
    !startupBenchmark.hasMark("window-shown") ||
    !startupBenchmark.hasMark("home-data-ready")
  ) {
    return;
  }
  benchmarkCompletionStarted = true;
  await startupBenchmark.complete();
  if (process.env.AGENTKIB_BENCHMARK_EXIT_AFTER_READY === "1") {
    quitApproved = true;
    app.quit();
  }
}

async function showFirstClosePrompt(window: BrowserWindow): Promise<void> {
  if (closePromptOpen || window.isDestroyed()) return;
  closePromptOpen = true;
  const appName = app.getName();
  const trayAvailable = nativeShell?.trayAvailable ?? false;
  const isLinuxTray = trayAvailable && process.platform === "linux";
  const translate = (key: string) => nativeShell?.translate(key, { appName }) ?? key;
  try {
    const result = await dialog.showMessageBox(window, {
      type: "question",
      title: translate("dialog.close.title"),
      message: translate(
        trayAvailable
          ? isLinuxTray
            ? "dialog.close.messageSystemTray"
            : "dialog.close.message"
          : "dialog.close.messageNoTray",
      ),
      buttons: [
        translate(
          trayAvailable
            ? isLinuxTray
              ? "dialog.close.hideSystemTray"
              : "dialog.close.hide"
            : "dialog.close.minimize",
        ),
        translate("dialog.close.quit"),
        translate("dialog.close.cancel"),
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    const decision = firstCloseDecision(result.response, trayAvailable);
    if (!decision) return;
    persistCloseBehaviorBestEffort(decision.behavior);
    if (decision.action === "hide") {
      if (nativeShell?.trayAvailable) nativeShell.hideMainWindow();
      else window.minimize();
    } else if (decision.action === "minimize") window.minimize();
    else requestRendererQuitGuard();
  } finally {
    closePromptOpen = false;
  }
}

function persistCloseBehaviorBestEffort(value: "minimize-to-tray" | "quit"): void {
  closeBehavior = value;
  if (!runtimeHost) return;
  void runtimeHost
    .request(RUNTIME_METHODS.setCloseBehavior, { value })
    .catch((error: unknown) =>
      process.stderr.write(`AgentKib could not persist close behavior: ${String(error)}\n`),
    );
}

function rendererUrl(surface?: "quota-popover"): string {
  const base = process.env.VITE_DEV_SERVER_URL ?? "app://bundle/index.html";
  if (!surface) return base;
  const url = new URL(base);
  url.searchParams.set("surface", surface);
  return url.toString();
}

async function registerRendererProtocol(): Promise<void> {
  const rendererRoot = path.resolve(app.getAppPath(), "dist");
  await protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "bundle") return new Response("Not found", { status: 404 });

    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    let assetPath = path.resolve(rendererRoot, relativePath);
    if (!isWithin(rendererRoot, assetPath)) return new Response("Forbidden", { status: 403 });

    let contents: Buffer;
    try {
      contents = await readFile(assetPath);
    } catch {
      assetPath = path.join(rendererRoot, "index.html");
      contents = await readFile(assetPath);
    }

    return new Response(contents as unknown as BodyInit, {
      headers: {
        "content-type": contentType(assetPath),
        "content-security-policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'",
      },
    });
  });
}

function resolveRuntimeExecutable(): string {
  if (process.env.AGENTKIB_RUNTIME_PATH) return process.env.AGENTKIB_RUNTIME_PATH;
  const executable = process.platform === "win32" ? "agentkib-runtime.exe" : "agentkib-runtime";
  if (app.isPackaged) return path.join(process.resourcesPath, "bin", executable);
  return path.resolve(process.cwd(), "../../target/debug", executable);
}

function resolveQuotaSidecar(): string {
  if (process.env.AGENTKIB_QUOTA_SIDECAR) return process.env.AGENTKIB_QUOTA_SIDECAR;
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "bin",
      process.platform === "win32" ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar",
    );
  }
  return path.resolve(
    process.cwd(),
    "build/quota",
    process.platform === "win32" ? "agentkib-quota-sidecar.exe" : "agentkib-quota-sidecar",
  );
}

function resolveApplicationIcon(preference = appIconPreference): string {
  const suffix = process.platform === "darwin" ? "-macos" : "";
  const filename = `app-icon-${preference}${suffix}.png`;
  if (app.isPackaged) return path.join(process.resourcesPath, "icons", filename);
  return path.resolve(__dirname, "../resources/icons", filename);
}

function applyApplicationIcon(preference: "white" | "black"): void {
  const image = nativeImage.createFromPath(resolveApplicationIcon(preference));
  if (image.isEmpty()) return;
  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setIcon(image);
}

function normalizeSystemLocale(locale: string | undefined): "zh-CN" | "zh-TW" | "ja-JP" | "en-US" {
  const normalized = locale?.replaceAll("_", "-").toLowerCase() ?? "";
  if (/^(zh|yue)-(hant|tw|hk|mo)(-|$)/.test(normalized)) return "zh-TW";
  if (/^zh-(hans|cn|sg)(-|$)/.test(normalized) || normalized === "zh") return "zh-CN";
  if (normalized === "ja" || normalized.startsWith("ja-")) return "ja-JP";
  return "en-US";
}

async function showStartupFailure(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AgentKib failed to start: ${message}\n`);
  if (!app.isReady()) return;

  if (startupFailureWindow && !startupFailureWindow.isDestroyed()) {
    startupFailureWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    title: "AgentKib startup error",
    width: 720,
    height: 420,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  startupFailureWindow = window;
  window.once("closed", () => {
    if (startupFailureWindow === window) startupFailureWindow = undefined;
  });
  const html = `<!doctype html><meta charset="utf-8"><title>AgentKib startup error</title><style>body{font:14px system-ui;background:#111;color:#eee;padding:32px}code{white-space:pre-wrap;color:#fca5a5}</style><h1>AgentKib could not start</h1><p>The Rust runtime did not become ready.</p><code>${escapeHtml(message)}</code>`;
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

async function handleStartupFailure(error: unknown): Promise<void> {
  if (startupBenchmark.enabled) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`AgentKib benchmark startup failed: ${message}\n`);
    app.exit(1);
    return;
  }
  await showStartupFailure(error);
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function contentType(filePath: string): string {
  switch (path.extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[character];
  });
}
