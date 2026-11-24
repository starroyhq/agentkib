import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeBridgePluginUpdater } from "../../../packages/backend/src/agents/claude/claude-bridge-plugin-update";
import * as commandResolution from "../../../packages/backend/src/command-resolution";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as { createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv };

const pluginId = "agentkib-bridge@agentkib-local";
const existingVersion = "0.5.4";
const bundledVersion = "0.5.5";
const expectedUpdate = ["plugin", "update", pluginId, "--scope", "user"];
const cliError = "Plugin update denied by policy.";
const cleanups: Array<() => void> = [];
type Outcome = "success" | "unchanged" | "failure" | "timeout";

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
});

function fixture({
  installedVersion = existingVersion,
  matchingMarketplace = true,
  staleInstallLocation = false,
  hasCli = true,
  outcome = "success",
}: {
  installedVersion?: string | null;
  matchingMarketplace?: boolean;
  staleInstallLocation?: boolean;
  hasCli?: boolean;
  outcome?: Outcome;
} = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-bridge-plugin-update-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const home = path.join(root, "home");
  const config = path.join(root, "claude config");
  const dataDir = path.join(root, "data");
  const bin = path.join(root, "bin");
  const pluginDirectory = path.join(root, "bundled plugin");
  const plugins = path.join(config, "plugins");
  for (const dir of [home, dataDir, bin, plugins, path.join(pluginDirectory, ".claude-plugin")])
    mkdirSync(dir, { recursive: true });

  const writeJson = (name: string, data: unknown) => writeFileSync(name, JSON.stringify(data));
  const installedFile = path.join(plugins, "installed_plugins.json");
  const marketplacesFile = path.join(plugins, "known_marketplaces.json");
  const settingsFile = path.join(config, "settings.json");
  const outcomeFile = path.join(root, "outcome");
  const callsFile = path.join(root, "calls.jsonl");
  const cache = path.join(plugins, "cache", "agentkib-local", "agentkib-bridge");
  const otherMarketplace = path.join(root, "another marketplace");
  mkdirSync(otherMarketplace);
  if (installedVersion) mkdirSync(path.join(cache, installedVersion), { recursive: true });
  writeJson(installedFile, {
    version: 2,
    plugins: installedVersion
      ? {
          [pluginId]: [
            {
              scope: "user",
              version: installedVersion,
              installPath: path.join(cache, installedVersion),
            },
          ],
        }
      : {},
  });
  writeJson(marketplacesFile, {
    "agentkib-local": {
      source: {
        source: "directory",
        path: matchingMarketplace ? pluginDirectory : otherMarketplace,
      },
      installLocation:
        matchingMarketplace && !staleInstallLocation ? pluginDirectory : otherMarketplace,
    },
  });
  writeJson(settingsFile, { enabledPlugins: { [pluginId]: true } });
  writeJson(path.join(pluginDirectory, ".claude-plugin", "plugin.json"), {
    name: "agentkib-bridge",
    version: bundledVersion,
  });
  writeJson(path.join(pluginDirectory, ".claude-plugin", "marketplace.json"), {
    name: "agentkib-local",
    owner: { name: "AgentKib" },
    plugins: [{ name: "agentkib-bridge", source: "./", version: bundledVersion }],
  });

  const setOutcome = (value: Outcome) => writeFileSync(outcomeFile, value);
  setOutcome(outcome);
  writeFileSync(callsFile, "");
  const environment: NodeJS.ProcessEnv = {
    ...createIsolatedWorkerEnvironment(home),
    PATH: bin,
    CLAUDE_CONFIG_DIR: config,
  };
  if (process.platform === "win32") {
    const systemRoot = environment.SystemRoot;
    if (!systemRoot) throw new Error("Windows Claude fixture requires SystemRoot");
    environment.PATH = bin + path.delimiter + path.join(systemRoot, "System32");
  }

  if (hasCli) {
    const script = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (process.env.CLAUDE_CONFIG_DIR !== ${JSON.stringify(config)}) {
  process.stderr.write("Wrong Claude configuration directory");
  process.exit(1);
}
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(expectedUpdate))}) {
  process.stderr.write("Unexpected Claude command");
  process.exit(1);
}
switch (fs.readFileSync(${JSON.stringify(outcomeFile)}, "utf8")) {
  case "success": {
    const installedFile = ${JSON.stringify(installedFile)};
    const installed = JSON.parse(fs.readFileSync(installedFile, "utf8"));
    const record = installed.plugins[${JSON.stringify(pluginId)}][0];
    record.version = ${JSON.stringify(bundledVersion)};
    record.installPath = path.join(${JSON.stringify(cache)}, record.version);
    fs.mkdirSync(record.installPath, { recursive: true });
    fs.writeFileSync(installedFile, JSON.stringify(installed));
    break;
  }
  case "unchanged":
    process.stdout.write("Plugin is already up to date.");
    break;
  case "failure":
    process.stderr.write(${JSON.stringify(cliError)});
    process.exitCode = 1;
    break;
  case "timeout":
    setTimeout(() => {}, 60_000);
    break;
}
`;
    if (process.platform === "win32") {
      const scriptPath = path.join(bin, "claude.cjs");
      writeFileSync(scriptPath, script);
      writeFileSync(
        path.join(bin, "claude.cmd"),
        `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`,
      );
    } else {
      writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\n${script}`, { mode: 0o700 });
    }
  } else {
    // The native resolver also searches system paths, which may contain a real Claude CLI.
    const resolveCommand = commandResolution.resolveCommand;
    vi.spyOn(commandResolution, "resolveCommand").mockImplementation((command, ...args) =>
      command === "claude" ? null : resolveCommand(command, ...args),
    );
  }

  const makeUpdater = (timeoutMs = 3_000) => {
    const updater = new ClaudeBridgePluginUpdater({
      dataDir,
      environment,
      pluginDirectory,
      timeoutMs,
    });
    cleanups.push(() => updater.close());
    return updater;
  };
  const calls = () =>
    readFileSync(callsFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const nativeSettings = () =>
    [marketplacesFile, settingsFile].map((name) => readFileSync(name, "utf8"));

  return {
    makeUpdater,
    calls,
    nativeSettings,
    setOutcome,
    interruptPreviousAttempt: () => {
      const receipts = path.join(dataDir, "claude-bridge", "plugin-updates");
      mkdirSync(receipts, { recursive: true });
      writeFileSync(path.join(receipts, bundledVersion + ".json"), "");
    },
    installManually: (version: string) =>
      writeJson(installedFile, {
        version: 2,
        plugins: { [pluginId]: [{ scope: "user", version }] },
      }),
  };
}

it.each([bundledVersion, "0.6.0"])(
  "keeps an installed version already at %s",
  async (installedVersion) => {
    const f = fixture({ installedVersion });
    const updater = f.makeUpdater();
    await updater.start();
    expect(updater.status()).toMatchObject({ installedVersion, bundledVersion, status: "idle" });
    expect(f.calls()).toEqual([]);
  },
);

it("updates an older user-scope bridge through the registered bundled marketplace", async () => {
  const f = fixture();
  const nativeSettings = f.nativeSettings();
  const updater = f.makeUpdater();
  await updater.start();

  expect(updater.status()).toMatchObject({
    installedVersion: bundledVersion,
    bundledVersion,
    status: "updated",
  });
  expect(f.calls()).toEqual([expectedUpdate]);
  expect(f.nativeSettings()).toEqual(nativeSettings);
});

it("leaves Claude Code alone when the bridge plugin has not been installed", async () => {
  const f = fixture({ installedVersion: null });
  const updater = f.makeUpdater();
  await updater.start();

  expect(updater.status()).toMatchObject({ installedVersion: null, bundledVersion });
  expect(f.calls()).toEqual([]);
});

it("shows a manual installation made while AgentKib is open", async () => {
  const f = fixture({ installedVersion: null });
  const updater = f.makeUpdater();
  await updater.start();
  expect(updater.status()?.installedVersion).toBeNull();

  f.installManually(existingVersion);

  expect(updater.status()).toMatchObject({
    installedVersion: existingVersion,
    bundledVersion,
    status: "idle",
  });
  expect(f.calls()).toEqual([]);
});

it("skips an installed bridge when Claude Code is unavailable", async () => {
  const f = fixture({ hasCli: false });
  const updater = f.makeUpdater();
  await updater.start();

  expect(updater.status()).toMatchObject({ installedVersion: existingVersion, bundledVersion });
  expect(f.calls()).toEqual([]);
});

it("does not update an identically named marketplace registered from another directory", async () => {
  const f = fixture({ matchingMarketplace: false });
  const updater = f.makeUpdater();
  await updater.start();

  expect(updater.status()).toMatchObject({ installedVersion: existingVersion, bundledVersion });
  expect(f.calls()).toEqual([]);
});

it("refuses an inconsistent marketplace install location", async () => {
  const f = fixture({ staleInstallLocation: true });
  await f.makeUpdater().start();
  expect(f.calls()).toEqual([]);
});

it("allows explicit retry after an interrupted version claim", async () => {
  const f = fixture();
  f.interruptPreviousAttempt();
  const updater = f.makeUpdater();
  await updater.start();
  expect(updater.status()?.status).toBe("failed");
  expect(f.calls()).toEqual([]);

  expect(await updater.retry()).toMatchObject({
    installedVersion: bundledVersion,
    bundledVersion,
    status: "updated",
  });
  expect(f.calls()).toEqual([expectedUpdate]);
});

it("shows an update failure with Claude Code's error", async () => {
  const f = fixture({ outcome: "failure" });
  const updater = f.makeUpdater();
  await updater.start();

  expect(updater.status()).toMatchObject({
    installedVersion: existingVersion,
    bundledVersion,
    status: "failed",
    reason: expect.stringContaining(cliError),
  });
  expect(f.calls()).toEqual([expectedUpdate]);
});

it("verifies the installed version after Claude Code reports success", async () => {
  const f = fixture({ outcome: "unchanged" });
  const updater = f.makeUpdater();
  await updater.start();

  expect(updater.status()).toMatchObject({
    installedVersion: existingVersion,
    bundledVersion,
    status: "failed",
  });
  expect(f.calls()).toEqual([expectedUpdate]);
});

it("times out a stuck Claude Code update", async () => {
  const f = fixture({ outcome: "timeout" });
  const updater = f.makeUpdater(1_500);
  await updater.start();

  expect(updater.status()).toMatchObject({
    installedVersion: existingVersion,
    bundledVersion,
    status: "failed",
    reason: expect.stringMatching(/timed.out|timeout/i),
  });
  expect(f.calls()).toEqual([expectedUpdate]);
});

it("attempts a bundle version only once across restarts and allows a manual retry", async () => {
  const f = fixture({ outcome: "failure" });
  const first = f.makeUpdater();
  await first.start();
  first.close();

  const restarted = f.makeUpdater();
  await restarted.start();
  expect(restarted.status()).toMatchObject({
    installedVersion: existingVersion,
    bundledVersion,
    status: "failed",
    reason: expect.stringContaining(cliError),
  });
  expect(f.calls()).toEqual([expectedUpdate]);

  f.setOutcome("success");
  expect(await restarted.retry()).toMatchObject({
    installedVersion: bundledVersion,
    bundledVersion,
    status: "updated",
  });
  expect(f.calls()).toEqual([expectedUpdate, expectedUpdate]);
});
