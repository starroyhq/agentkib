import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const acceptanceAccountId = "at01-fixture-owner";

const run = promisify(execFile);

const seedScript = `
const { app, safeStorage } = require("electron");
const { randomBytes } = require("node:crypto");
const { lstatSync, mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

app.setName("AgentKib");
app.setPath("userData", process.cwd());
app.setPath("sessionData", process.cwd());
app.whenReady().then(() => {
  if (!app.commandLine.hasSwitch("use-mock-keychain") || !safeStorage.isEncryptionAvailable()) {
    throw new Error("Isolated Electron mock keychain unavailable");
  }
  const profile = process.env.AGENTKIB_BENCHMARK_USER_DATA;
  const directory = path.join(profile, "account");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  if (!lstatSync(profile).isDirectory()) throw new Error("Expected a dedicated Electron profile");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) {
    throw new Error("Expected a dedicated account fixture directory");
  }
  const record = {
    version: 1,
    refreshToken: randomBytes(32).toString("base64url"),
    refreshRecovery: true,
    account: {
      id: ${JSON.stringify(acceptanceAccountId)},
      username: "AT01 Fixture",
      status: "active",
      deviceLimit: 2,
      deviceCount: 0,
      totpEnabled: false,
    },
    access: { value: randomBytes(32).toString("base64url"), until: Date.now() + 9 * 60_000 },
  };
  writeFileSync(path.join(directory, "refresh.enc"), safeStorage.encryptString(JSON.stringify(record)), {
    flag: "wx",
    mode: 0o600,
  });
  app.exit(0);
}).catch((error) => {
  console.error(error.message);
  app.exit(1);
});
`;

/** Create only the synthetic cached session read by the packaged main process at startup. */
export async function seedAcceptanceAccount({ electron, profile, home, scratch, sandbox, signal }) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The packaged account acceptance fixture requires macOS arm64");
  }
  if (![electron, profile, home, scratch, sandbox].every(path.isAbsolute)) {
    throw new Error("The account acceptance fixture requires absolute paths");
  }
  const fixture = await mkdtemp(path.join(scratch, "mock-account-"));
  try {
    await mkdir(home, { recursive: true });
    const entry = path.join(fixture, "seed-account.cjs");
    await writeFile(entry, seedScript, { mode: 0o600 });
    await run(
      "/usr/bin/sandbox-exec",
      [
        "-f",
        sandbox,
        electron,
        entry,
        "--no-sandbox",
        "--use-mock-keychain",
        "--disable-background-networking",
        "--disable-breakpad",
        "--disable-gpu",
      ],
      {
        cwd: fixture,
        env: {
          HOME: home,
          CFFIXED_USER_HOME: home,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: fixture,
          XDG_CACHE_HOME: path.join(fixture, "cache"),
          XDG_CONFIG_HOME: path.join(fixture, "config"),
          XDG_DATA_HOME: path.join(fixture, "data"),
          AGENTKIB_BENCHMARK_USER_DATA: profile,
          AGENTKIB_BENCHMARK_DATA_DIR: path.join(fixture, "runtime"),
        },
        signal,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      },
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}
