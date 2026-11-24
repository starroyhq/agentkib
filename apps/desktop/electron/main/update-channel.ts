import type { AppUpdater } from "electron-updater";

export function configureUpdateChannel(
  updater: AppUpdater,
  platform: NodeJS.Platform,
  arch: string,
): void {
  if (platform === "darwin" || platform === "win32") updater.channel = arch;
  if (updater.allowPrerelease) {
    // GitHub treats the architecture channel as a prerelease tag filter in prerelease mode.
    updater.allowPrerelease = false;
    // Setting channel enables downgrades. A preview may be ahead of the latest stable release.
    updater.allowDowngrade = false;
  }
}
