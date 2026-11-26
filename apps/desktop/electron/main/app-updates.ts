import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdateInfo } from "../api/app-updates";
import type { IpcRegistrar } from "./ipc/registrar";
import { requireString } from "./ipc/validation";
import { normalizeReleaseNotes } from "./release-notes";
import { configureUpdateChannel } from "./update-channel";

export function registerUpdateIpc(
  handle: IpcRegistrar["handle"],
  isDevelopmentApp: boolean,
  updatesManagedByStore: boolean,
): void {
  if (isDevelopmentApp || updatesManagedByStore) {
    handle("agentkib:updates:check", () => undefined);
    handle("agentkib:updates:install", () => {
      throw new Error(
        updatesManagedByStore
          ? "errors.updateManagedByStore"
          : "errors.updateUnavailableInDevelopment",
      );
    });
    return;
  }
  let pendingUpdateVersion: string | undefined;
  configureUpdateChannel(autoUpdater, process.platform, process.arch);
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  handle("agentkib:updates:check", async (): Promise<AppUpdateInfo | undefined> => {
    const result = await autoUpdater.checkForUpdates();
    const update = result?.updateInfo;
    // updateInfo 在"没有更新"时也会返回远端最新版本；远端比本地旧（例如本地是
    // 预发布版）时按字符串比较会误报更新，随后 downloadUpdate 失败。
    if (!result?.isUpdateAvailable || !update) {
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
  handle("agentkib:updates:install", async (event, version: unknown) => {
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
