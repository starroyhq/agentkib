import { AppUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider";
import { expect, it, vi } from "vitest";
import { configureUpdateChannel } from "./update-channel";

const releases = "/starroyhq/agentkib/releases";
const stableTag = "v0.33.0";
const macMetadata = `${releases}/download/${stableTag}/arm64-mac.yml`;

class FixtureUpdater extends AppUpdater {
  private readonly provider: GitHubProvider;

  constructor(version: string, executor: ElectronHttpExecutor) {
    super(null, {
      version,
      name: "AgentKib",
      isPackaged: true,
      appUpdateConfigPath: "",
      userDataPath: "",
      baseCachePath: "",
      whenReady: async () => {},
      relaunch: () => {},
      quit: () => {},
      onQuit: () => {},
    });
    this.logger = null;
    this.autoDownload = false;
    this.provider = new GitHubProvider(
      { provider: "github", owner: "starroyhq", repo: "agentkib" },
      this,
      { platform: "darwin", executor, isUseMultipleRangeRequest: false },
    );
  }

  protected async getUpdateInfoAndProvider() {
    return { info: await this.provider.getLatestVersion(), provider: this.provider };
  }

  protected async doDownloadUpdate(): Promise<string[]> {
    throw new Error("Unexpected update download");
  }

  quitAndInstall(): void {
    throw new Error("Unexpected update installation");
  }
}

it.each([
  ["0.33.0-dev.4", true],
  ["0.32.0", true],
  ["0.34.0-dev.1", false],
])("checks the stable macOS release from %s (update available: %s)", async (version, available) => {
  const executor = new ElectronHttpExecutor();
  const responses = new Map([
    [
      `${releases}.atom`,
      `<feed>
        <entry><link href="https://github.com${releases}/tag/v0.34.0-dev.2" /></entry>
        <entry><link href="https://github.com${releases}/tag/${stableTag}" /></entry>
      </feed>`,
    ],
    [`${releases}/latest`, JSON.stringify({ tag_name: stableTag })],
    [
      macMetadata,
      "version: 0.33.0\nfiles:\n  - url: AgentKib_0.33.0_macos-arm64.zip\n    sha512: fixture\n",
    ],
  ]);
  const request = vi.spyOn(executor, "request").mockImplementation(async ({ path }) => {
    const response = path ? responses.get(path) : undefined;
    if (response === undefined) throw new Error(`Unexpected update request: ${path}`);
    return response;
  });
  const updater = new FixtureUpdater(version, executor);
  configureUpdateChannel(updater, "darwin", "arm64");

  await expect(updater.checkForUpdates()).resolves.toMatchObject({
    isUpdateAvailable: available,
    updateInfo: { version: "0.33.0" },
  });
  expect(request.mock.calls.map(([options]) => options.path)).toEqual([...responses.keys()]);
});
