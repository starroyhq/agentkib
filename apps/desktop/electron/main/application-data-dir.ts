import { mkdir, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const APP_DATA_DIRECTORY = "ai.agentkib";
const DEVELOPMENT_DATA_DIRECTORY = "ai.agentkib.dev";
const LEGACY_APP_DATA_DIRECTORY = "com.agentkib.desktop";

export async function resolveApplicationDataDir(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  development: boolean,
  homeDirectory = os.homedir(),
): Promise<string> {
  const override = environment.AGENTKIB_BENCHMARK_DATA_DIR;
  if (override) return path.resolve(override);

  let base: string;
  if (platform === "win32") {
    base = environment.LOCALAPPDATA || path.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    base = path.join(homeDirectory, "Library", "Application Support");
  } else {
    base = environment.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share");
  }

  const directory = path.join(base, development ? DEVELOPMENT_DATA_DIRECTORY : APP_DATA_DIRECTORY);
  if (!development) await migrateLegacyDataDirectory(base, directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

async function migrateLegacyDataDirectory(base: string, current: string): Promise<void> {
  if (await exists(current)) return;
  const legacy = path.join(base, LEGACY_APP_DATA_DIRECTORY);
  if (!(await exists(legacy))) return;

  try {
    await rename(legacy, current);
  } catch (error) {
    // Another startup path may have won the one-time migration race.
    if ((await exists(current)) && !(await exists(legacy))) return;
    throw new Error(`Could not migrate AgentKib data from ${legacy} to ${current}`, {
      cause: error,
    });
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}
