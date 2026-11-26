import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCommand } from "../../command-resolution";
import { Commands } from "../../commands";
import { isNetworkOrDevicePath } from "../../context-claude-sources";
import { readText } from "../../files";
import { userHome } from "../../mcp-config-read";
import { versionAtLeast } from "../../native-version";
import { canonicalize, isDirectory, lexicalPathIdentity } from "../../paths";
import { readPreferences, writePreference } from "../../preferences";
import { claudeConfigFiles, claudePluginsRoot, resolveClaudeConfig } from "./claude-config";
import { redactText } from "./claude-settings";

const PLUGIN = "agentkib-bridge";
const MARKETPLACE = "agentkib-local";
const PLUGIN_ID = PLUGIN + "@" + MARKETPLACE;
const AUTOMATIC = "claude_bridge_plugin_automatic";
const ALREADY_ATTEMPTED =
  "The automatic plugin change for this bundled version was already attempted.";
const WRONG_MARKETPLACE =
  "The agentkib-local marketplace does not point to this AgentKib installation.";
const USER_INSTALL_DISABLED = "Claude Code's user settings disable the AgentKib bridge plugin.";

export type ClaudeBridgePluginInstallation = { version: string } & (
  | { scope: "user"; projectPath?: never }
  | { scope: "project" | "local"; projectPath: string }
);

export type ClaudeBridgePluginUpdateStatus = {
  installedVersion: string | null;
  installations: ClaudeBridgePluginInstallation[];
  bundledVersion: string;
  automaticEnabled: boolean;
  canChangeAutomatic: boolean;
  status: "idle" | "updating" | "updated" | "failed";
  reason?: string;
  installInstructions?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function versionOf(value: unknown): string | undefined {
  return typeof value === "string" && versionAtLeast(value, "0.0.0") ? value : undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readText(file)) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function installationsAt(pluginsRoot: string): ClaudeBridgePluginInstallation[] {
  const entries = readJson(path.join(pluginsRoot, "installed_plugins.json"));
  if (entries === undefined) return [];
  if (!isRecord(entries) || !isRecord(entries.plugins)) throw new Error("invalid-plugin-record");
  const installs = entries.plugins[PLUGIN_ID];
  if (installs === undefined) return [];
  if (!Array.isArray(installs)) throw new Error("invalid-plugin-record");
  const rows = new Map<string, ClaudeBridgePluginInstallation>();
  for (const entry of installs) {
    if (!isRecord(entry)) throw new Error("invalid-plugin-record");
    const { scope, projectPath } = entry;
    if (scope !== "user" && scope !== "project" && scope !== "local") continue;
    const version = versionOf(entry.version);
    if (!version) throw new Error("invalid-plugin-record");
    let row: ClaudeBridgePluginInstallation;
    if (scope === "user") row = { scope, version };
    else if (
      typeof projectPath === "string" &&
      projectPath.length <= 4096 &&
      !/\p{Cc}/u.test(projectPath)
    )
      row = { scope, version, projectPath };
    else throw new Error("invalid-plugin-record");
    const key = installKey(row);
    if (rows.has(key)) throw new Error("invalid-plugin-record");
    rows.set(key, row);
  }
  return [...rows.values()];
}

function installKey(installation: ClaudeBridgePluginInstallation): string {
  return installation.projectPath === undefined
    ? "user"
    : installation.scope + ":" + lexicalPathIdentity(installation.projectPath);
}

function userVersion(installations: ClaudeBridgePluginInstallation[]) {
  return installations.find(({ scope }) => scope === "user")?.version;
}

function pluginConfiguration(environment: NodeJS.ProcessEnv) {
  const config = resolveClaudeConfig(environment, userHome(environment));
  if (config.invalid) return undefined;
  const pluginsRoot = claudePluginsRoot(config, environment);
  const override = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  // A display reader can fall back, but the command must use the metadata we verified.
  if (override && override !== pluginsRoot) return undefined;
  return { pluginsRoot, userSettings: claudeConfigFiles(config).settings };
}

function userPluginDisabled(file: string): boolean {
  const settings = readJson(file);
  return (
    isRecord(settings) &&
    isRecord(settings.enabledPlugins) &&
    settings.enabledPlugins[PLUGIN_ID] === false
  );
}

function marketplaceState(pluginsRoot: string, directory: string): "missing" | "bundled" | "other" {
  const marketplaces = readJson(path.join(pluginsRoot, "known_marketplaces.json"));
  const marketplace = isRecord(marketplaces) ? marketplaces[MARKETPLACE] : undefined;
  if (marketplaces === undefined || (isRecord(marketplaces) && marketplace === undefined))
    return "missing";
  if (!isRecord(marketplace) || !isRecord(marketplace.source)) return "other";
  const sameDirectory = (value: unknown) => {
    if (
      typeof value !== "string" ||
      !path.isAbsolute(value) ||
      isNetworkOrDevicePath(value, process.platform)
    )
      return false;
    try {
      return lexicalPathIdentity(canonicalize(value)) === lexicalPathIdentity(directory);
    } catch {
      return false;
    }
  };
  return marketplace.source.source === "directory" &&
    sameDirectory(marketplace.source.path) &&
    (marketplace.installLocation === undefined || sameDirectory(marketplace.installLocation))
    ? "bundled"
    : "other";
}

function isLocalProject(value: string): boolean {
  return (
    value.length <= 4096 &&
    !/\p{Cc}/u.test(value) &&
    path.isAbsolute(value) &&
    !value.split(/[\\/]+/).includes("..") &&
    !isNetworkOrDevicePath(value, process.platform) &&
    isDirectory(value)
  );
}

function recoveryInstructions(directory: string): string {
  return [
    `claude plugin marketplace add '${directory.replaceAll("'", "'\\''")}'`,
    `claude plugin install ${PLUGIN_ID} --scope user`,
  ].join("\n");
}

/** Owns automatic setup, updates and migration. Claude Code alone writes its plugin records. */
export class ClaudeBridgePluginUpdater {
  readonly #commands = new Commands();
  #status?: ClaudeBridgePluginUpdateStatus;
  #flight?: Promise<ClaudeBridgePluginUpdateStatus | undefined>;
  #closed = false;

  constructor(
    private readonly options: {
      dataDir: string;
      environment: NodeJS.ProcessEnv;
      pluginDirectory: string;
      timeoutMs?: number;
    },
  ) {}

  status(): ClaudeBridgePluginUpdateStatus | undefined {
    const current = this.#status;
    try {
      const automaticEnabled = this.#automaticEnabled();
      if (current?.status === "updating") return { ...current, automaticEnabled };
      const bundledVersion = current?.bundledVersion ?? this.#bundle()?.bundledVersion;
      if (!bundledVersion) return undefined;
      const pluginsRoot = pluginConfiguration(this.options.environment)?.pluginsRoot;
      const installs = pluginsRoot ? installationsAt(pluginsRoot) : [];
      // Native Claude operations may change the ledger while AgentKib is open.
      this.#status =
        current && JSON.stringify(installs) === JSON.stringify(current.installations)
          ? { ...current, automaticEnabled }
          : this.#snapshot(bundledVersion, installs);
      return this.#status;
    } catch {
      if (!current) return undefined;
      return {
        ...current,
        status: "failed",
        reason: "Could not read Claude Code plugin installations.",
        installInstructions: undefined,
      };
    }
  }

  start() {
    return this.#run(false);
  }

  retry() {
    return this.#run(true);
  }

  async setAutomatic(enabled: boolean) {
    const changed = enabled !== this.#automaticEnabled();
    writePreference(this.options.dataDir, AUTOMATIC, enabled);
    if (!enabled || !changed) return this.status();
    await this.#flight;
    return this.#run(true);
  }

  close(): void {
    this.#closed = true;
    this.#commands.close();
  }

  #run(manual: boolean): Promise<ClaudeBridgePluginUpdateStatus | undefined> {
    if (this.#closed) return Promise.resolve(this.#status);
    this.#flight ??= Promise.resolve()
      .then(() => this.#check(manual))
      .catch(() => {
        this.#fail(
          "Could not read Claude Code plugin installations or complete the plugin change.",
        );
      })
      .then(() => this.status())
      .finally(() => {
        this.#flight = undefined;
      });
    return this.#flight;
  }

  #automaticEnabled(): boolean {
    return readPreferences(this.options.dataDir)[AUTOMATIC] !== false;
  }

  #bundle() {
    const { pluginDirectory } = this.options;
    if (!path.isAbsolute(pluginDirectory)) return;
    const directory = canonicalize(pluginDirectory);
    const manifest = readJson(path.join(directory, ".claude-plugin", "plugin.json"));
    const bundledVersion =
      isRecord(manifest) && manifest.name === PLUGIN ? versionOf(manifest.version) : undefined;
    return bundledVersion ? { directory, bundledVersion } : undefined;
  }

  #snapshot(
    bundledVersion: string,
    installations: ClaudeBridgePluginInstallation[],
  ): ClaudeBridgePluginUpdateStatus {
    return {
      installedVersion: userVersion(installations) ?? installations[0]?.version ?? null,
      installations,
      bundledVersion,
      automaticEnabled: this.#automaticEnabled(),
      canChangeAutomatic: true,
      status: "idle",
    };
  }

  #fail(reason: string, installDirectory?: string): void {
    if (this.#status) {
      this.#status = {
        ...this.#status,
        status: "failed",
        reason,
        installInstructions: installDirectory ? recoveryInstructions(installDirectory) : undefined,
      };
    }
  }

  async #check(manual: boolean): Promise<void> {
    if (this.#closed) return;
    const bundle = this.#bundle();
    if (!bundle) return;
    const { directory, bundledVersion } = bundle;
    const { environment } = this.options;
    const config = pluginConfiguration(environment);
    this.#status = this.#snapshot(bundledVersion, []);
    if (!config) {
      this.#fail("Claude Code's plugin configuration directory is unavailable.");
      return;
    }
    const { pluginsRoot, userSettings } = config;
    let installs = installationsAt(pluginsRoot);
    this.#status = this.#snapshot(bundledVersion, installs);
    if (!this.#automaticEnabled()) return;

    let current = userVersion(installs);
    const installUser = !current;
    const updateUser = current !== undefined && !versionAtLeast(current, bundledVersion);
    if (!installUser && !updateUser && installs.length === 1) return;
    if (!installUser && userPluginDisabled(userSettings)) {
      this.#fail(USER_INSTALL_DISABLED);
      return;
    }
    const executable = resolveCommand("claude", environment);
    if (!executable) {
      if (installs.length || manual) this.#fail("Claude Code was not found.");
      return;
    }
    const enabled = () => !this.#closed && this.#automaticEnabled();
    let changed = false;

    if (installUser || updateUser) {
      const key = (installUser ? "install-" : "") + bundledVersion;
      const reason = await this.#attempt(key, manual, async () => {
        const marketplace = marketplaceState(pluginsRoot, directory);
        if (marketplace === "other") return WRONG_MARKETPLACE;
        if (marketplace === "missing") {
          const failed = await this.#cli(executable, ["marketplace", "add", directory], directory);
          if (failed) return failed;
          if (marketplaceState(pluginsRoot, directory) !== "bundled") return WRONG_MARKETPLACE;
        }
        if (!enabled()) return undefined;
        if (!installUser && userPluginDisabled(userSettings)) return USER_INSTALL_DISABLED;
        const operation = installUser ? "install" : "update";
        const failed = await this.#cli(
          executable,
          [operation, PLUGIN_ID, "--scope", "user"],
          directory,
        );
        if (failed) return failed;
        installs = installationsAt(pluginsRoot);
        current = userVersion(installs);
        if (!current || !versionAtLeast(current, bundledVersion))
          return "Claude Code did not install the bundled version at user scope.";
        changed = true;
      });
      installs = installationsAt(pluginsRoot);
      this.#status = this.#snapshot(bundledVersion, installs);
      if (reason) {
        this.#fail(reason, installUser ? directory : undefined);
        return;
      }
    }

    // Only the verified user installation may replace narrower scopes. The native uninstall
    // removes the scope setting and ledger entry but leaves the versioned cache in place.
    const failures: string[] = [];
    if (current && versionAtLeast(current, bundledVersion)) {
      for (const installation of installs) {
        if (!enabled()) break;
        if (installation.scope === "user") continue;
        const { scope, projectPath, version } = installation;
        const key = installKey(installation);
        const digest = createHash("sha256").update(key).digest("hex");
        const reason = await this.#attempt(
          `migrate-${bundledVersion}-${digest}`,
          manual,
          async () => {
            if (marketplaceState(pluginsRoot, directory) !== "bundled") return WRONG_MARKETPLACE;
            if (!isLocalProject(projectPath))
              return "The installed project's directory is unavailable.";
            const latestInstalls = installationsAt(pluginsRoot);
            const latest = userVersion(latestInstalls);
            if (
              !latest ||
              !versionAtLeast(latest, version) ||
              !versionAtLeast(latest, bundledVersion)
            )
              return "The user-scope replacement is missing or older than this installation.";
            if (userPluginDisabled(userSettings)) return USER_INSTALL_DISABLED;
            if (!latestInstalls.some((row) => installKey(row) === key)) return;
            const failed = await this.#cli(
              executable,
              ["uninstall", PLUGIN_ID, "--scope", scope, "--keep-data"],
              projectPath,
            );
            if (failed) return failed;
            installs = installationsAt(pluginsRoot);
            if (installs.some((row) => installKey(row) === key))
              return "Claude Code did not remove the previous installation.";
            changed = true;
          },
        );
        if (reason) failures.push(`${scope} (${projectPath}): ${reason}`);
      }
    }
    installs = installationsAt(pluginsRoot);
    this.#status = this.#snapshot(bundledVersion, installs);
    if (failures.length) this.#fail(failures.join("\n"));
    else if (changed) this.#status.status = "updated";
  }

  async #attempt(
    key: string,
    manual: boolean,
    operation: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    const receipts = path.join(this.options.dataDir, "claude-bridge", "plugin-updates");
    const receipt = path.join(receipts, key + ".json");
    mkdirSync(receipts, { recursive: true, mode: 0o700 });
    try {
      // Claim before starting the CLI so a crash cannot cause another automatic attempt.
      writeFileSync(receipt, "{}", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!manual) return readReason(receipt) ?? ALREADY_ATTEMPTED;
    }

    let reason: string | undefined;
    try {
      if (this.#status) this.#status.status = "updating";
      reason = await operation();
    } catch (error) {
      reason =
        error instanceof Error && error.message.endsWith(" command timed out")
          ? "Claude Code plugin update timed out."
          : "Claude Code plugin update could not be completed.";
    }

    const temporary = receipt + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({ reason }), { flag: "wx", mode: 0o600 });
      renameSync(temporary, receipt);
    } catch {
      // The original claim still prevents a duplicate startup attempt.
    } finally {
      rmSync(temporary, { force: true });
    }
    return reason;
  }

  async #cli(executable: string, args: string[], cwd: string): Promise<string | undefined> {
    const result = await this.#commands.run(executable, ["plugin", ...args], {
      cwd,
      env: { ...this.options.environment, CI: "1", GIT_TERMINAL_PROMPT: "0" },
      timeout: this.options.timeoutMs ?? 15_000,
      limit: 16 * 1024,
      allowFailure: true,
      terminateDescendantsOnExit: true,
    });
    if (!result.success)
      return (
        redactText(result.error || result.bytes.toString("utf8"), 500).trim() ||
        "Claude Code could not complete the plugin change."
      );
  }
}

function readReason(receipt: string): string | undefined {
  try {
    const previous = readJson(receipt);
    if (isRecord(previous) && typeof previous.reason === "string") return previous.reason;
  } catch {
    // An interrupted claim has no failure message.
  }
}
