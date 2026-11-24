import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCommand } from "../../command-resolution";
import { Commands } from "../../commands";
import { isNetworkOrDevicePath } from "../../context-claude-sources";
import { readText } from "../../files";
import { userHome } from "../../mcp-config-read";
import { versionAtLeast } from "../../native-version";
import { canonicalize, lexicalPathIdentity } from "../../paths";
import { claudePluginsRoot, resolveClaudeConfig } from "./claude-config";
import { redactText } from "./claude-settings";

const PLUGIN = "agentkib-bridge";
const MARKETPLACE = "agentkib-local";
const PLUGIN_ID = PLUGIN + "@" + MARKETPLACE;
const ALREADY_ATTEMPTED = "The automatic update for this bundled version was already attempted.";

export type ClaudeBridgePluginUpdateStatus = {
  installedVersion: string | null;
  bundledVersion: string;
  status: "idle" | "updating" | "updated" | "failed";
  reason?: string;
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

function installedVersion(pluginsRoot: string): string | null {
  const entries = readJson(path.join(pluginsRoot, "installed_plugins.json"));
  if (entries === undefined) return null;
  if (!isRecord(entries) || !isRecord(entries.plugins)) throw new Error("invalid-plugin-record");
  const installs = entries.plugins[PLUGIN_ID];
  if (installs === undefined) return null;
  if (!Array.isArray(installs)) throw new Error("invalid-plugin-record");
  const userInstalls = installs.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && entry.scope === "user",
  );
  if (!userInstalls.length) return null;
  const version = versionOf(userInstalls[0]?.version);
  if (userInstalls.length !== 1 || !version) throw new Error("invalid-plugin-record");
  return version;
}

function updatePluginsRoot(environment: NodeJS.ProcessEnv): string | undefined {
  const config = resolveClaudeConfig(environment, userHome(environment));
  if (config.invalid) return undefined;
  const root = claudePluginsRoot(config, environment);
  const override = environment.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  // A display reader can fall back, but the command must use the metadata we verified.
  if (override && override !== root) return undefined;
  return root;
}

function usesBundledMarketplace(pluginsRoot: string, directory: string): boolean {
  const marketplaces = readJson(path.join(pluginsRoot, "known_marketplaces.json"));
  const marketplace = isRecord(marketplaces) ? marketplaces[MARKETPLACE] : undefined;
  const source = isRecord(marketplace) ? marketplace.source : undefined;
  if (
    !isRecord(source) ||
    source.source !== "directory" ||
    typeof source.path !== "string" ||
    !path.isAbsolute(source.path) ||
    isNetworkOrDevicePath(source.path, process.platform)
  )
    return false;
  try {
    return lexicalPathIdentity(canonicalize(source.path)) === lexicalPathIdentity(directory);
  } catch {
    return false;
  }
}

/** Owns startup checks and explicit retries. Claude Code alone writes its plugin records. */
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
    if (!current || current.status === "updating") return current;
    const pluginsRoot = updatePluginsRoot(this.options.environment);
    if (!pluginsRoot) return undefined;
    try {
      // The manual install command can change the ledger while AgentKib is open.
      const installed = installedVersion(pluginsRoot);
      if (installed !== current.installedVersion) {
        this.#status = {
          installedVersion: installed,
          bundledVersion: current.bundledVersion,
          status: "idle",
        };
      }
      return this.#status;
    } catch {
      return undefined;
    }
  }

  start() {
    return this.#run(false);
  }

  retry() {
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
        if (this.#status) this.#fail("Claude Code plugin update could not be checked.");
      })
      .then(() => this.#status)
      .finally(() => {
        this.#flight = undefined;
      });
    return this.#flight;
  }

  #fail(reason: string): void {
    if (this.#status) this.#status = { ...this.#status, status: "failed", reason };
  }

  async #check(manual: boolean): Promise<void> {
    if (this.#closed) return;
    const { dataDir, environment, pluginDirectory } = this.options;
    if (!path.isAbsolute(pluginDirectory)) return;
    const directory = canonicalize(pluginDirectory);
    const manifest = readJson(path.join(directory, ".claude-plugin", "plugin.json"));
    const bundledVersion =
      isRecord(manifest) && manifest.name === PLUGIN ? versionOf(manifest.version) : undefined;
    if (!bundledVersion) return;

    const pluginsRoot = updatePluginsRoot(environment);
    if (!pluginsRoot) return;
    const installed = installedVersion(pluginsRoot);
    this.#status = { installedVersion: installed, bundledVersion, status: "idle" };
    if (!installed || versionAtLeast(installed, bundledVersion)) return;

    const receipts = path.join(dataDir, "claude-bridge", "plugin-updates");
    const receipt = path.join(receipts, bundledVersion + ".json");
    const previous = readJson(receipt);
    if (!manual && previous !== undefined) {
      this.#fail(
        isRecord(previous) && typeof previous.reason === "string"
          ? previous.reason
          : ALREADY_ATTEMPTED,
      );
      return;
    }

    const executable = resolveCommand("claude", environment);
    if (!executable) {
      if (manual) this.#fail("Claude Code was not found.");
      return;
    }
    if (!usesBundledMarketplace(pluginsRoot, directory)) {
      this.#fail("The agentkib-local marketplace does not point to this AgentKib installation.");
      return;
    }
    mkdirSync(receipts, { recursive: true, mode: 0o700 });
    try {
      // Claim before starting the CLI so a crash cannot cause another automatic attempt.
      writeFileSync(receipt, "{}", { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!manual) {
        this.#fail(ALREADY_ATTEMPTED);
        return;
      }
    }

    this.#status.status = "updating";
    let reason: string | undefined;
    try {
      // A directory marketplace already resolves to the current bundle.
      const result = await this.#commands.run(
        executable,
        ["plugin", "update", PLUGIN_ID, "--scope", "user"],
        {
          cwd: directory,
          env: { ...environment, CI: "1", GIT_TERMINAL_PROMPT: "0" },
          timeout: this.options.timeoutMs ?? 15_000,
          limit: 16 * 1024,
          allowFailure: true,
          terminateDescendantsOnExit: true,
        },
      );
      if (!result.success) {
        reason =
          redactText(result.error || result.bytes.toString("utf8"), 500).trim() ||
          "Claude Code could not update the plugin.";
      } else {
        const current = installedVersion(pluginsRoot);
        this.#status.installedVersion = current;
        if (!current || !versionAtLeast(current, bundledVersion))
          reason = "Claude Code did not install the bundled version.";
      }
    } catch (error) {
      reason =
        error instanceof Error && error.message.endsWith(" command timed out")
          ? "Claude Code plugin update timed out."
          : "Claude Code plugin update could not be completed.";
    }

    if (reason) this.#fail(reason);
    else this.#status.status = "updated";

    const temporary = receipt + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({ reason }), { flag: "wx", mode: 0o600 });
      renameSync(temporary, receipt);
    } catch {
      // The original claim still prevents a duplicate startup attempt.
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
