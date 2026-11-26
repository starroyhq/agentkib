import type { IpcMainInvokeEvent } from "electron";
import { beforeEach, expect, it, vi } from "vitest";
import type { TrustedIpcHandler } from "./ipc/registrar";
import { registerUpdateIpc } from "./app-updates";

const updater = vi.hoisted(() => ({
  channel: undefined as string | undefined,
  autoDownload: true,
  autoInstallOnAppQuit: true,
  checkForUpdates: vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.1.0", releaseNotes: "Installer fixes" },
  })),
  downloadUpdate: vi.fn(async () => []),
  quitAndInstall: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({ app: { getVersion: () => "1.0.0" } }));
vi.mock("electron-updater", () => ({ autoUpdater: updater }));

function setup(updatesManagedByStore: boolean, development = false) {
  const handlers = new Map<string, TrustedIpcHandler>();
  const send = vi.fn();
  const event = { sender: { send } } as unknown as IpcMainInvokeEvent;
  registerUpdateIpc(
    (channel, handler) => handlers.set(channel, handler),
    development,
    updatesManagedByStore,
  );
  return {
    check: async () => handlers.get("agentkib:updates:check")!(event),
    install: async (version: string) => handlers.get("agentkib:updates:install")!(event, version),
    send,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updater.channel = undefined;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
});

it("does not configure, query, download or install updates for a Store package", async () => {
  const ipc = setup(true);

  await expect(ipc.check()).resolves.toBeUndefined();
  await expect(ipc.install("1.1.0")).rejects.toThrow("errors.updateManagedByStore");
  expect(updater.channel).toBeUndefined();
  expect(updater.autoDownload).toBe(true);
  expect(updater.autoInstallOnAppQuit).toBe(true);
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  expect(updater.downloadUpdate).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
  expect(ipc.send).not.toHaveBeenCalled();
});

it("continues to check and install updates for the direct Windows installer", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    const ipc = setup(false);

    expect(updater.channel).toBe(process.arch);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    await expect(ipc.check()).resolves.toMatchObject({
      current_version: "1.0.0",
      version: "1.1.0",
      notes: "Installer fixes",
      install_mode: "in-app",
    });
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    await expect(ipc.install("1.0.0")).rejects.toThrow("errors.updateChanged");
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    await ipc.install("1.1.0");
    expect(updater.downloadUpdate).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(ipc.send).toHaveBeenLastCalledWith("agentkib:updates:progress", { event: "finished" });
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

it("continues to disable in-app updates in development", async () => {
  const ipc = setup(false, true);
  await expect(ipc.check()).resolves.toBeUndefined();
  await expect(ipc.install("1.1.0")).rejects.toThrow("errors.updateUnavailableInDevelopment");
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
});
