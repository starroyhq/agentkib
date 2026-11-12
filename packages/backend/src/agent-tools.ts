import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import spawn from "cross-spawn";
import path from "node:path";
import { resolveCommand, resolveCommands } from "./command-resolution";
import { pathIdentity } from "./paths";
import { windowsProcessTree, type NativeProcessTree } from "./native-process";

type Channel =
  | "official-installer"
  | "npm"
  | "pnpm"
  | "bun"
  | "yarn"
  | "homebrew"
  | "volta"
  | "desktop-app"
  | "nix"
  | "local"
  | "unknown";
type Spec = {
  agent: string;
  command: string;
  official: string;
  releases?: string;
  npm?: string;
  github?: string;
  prefix?: string;
};
type Installation = {
  id: string;
  path: string;
  resolved_path: string;
  version?: string;
  runnable: boolean;
  error?: string;
  channel: Channel;
  environment: string;
  manager_path?: string;
  is_path_default: boolean;
};
type Action = {
  id: string;
  kind: string;
  mode: string;
  channel: Channel;
  shell?: string;
  command?: string;
  url?: string;
  target_version?: string;
  installation_id?: string;
  manager_path?: string;
};

const SPECS: Spec[] = [
  {
    agent: "codex",
    command: "codex",
    official: "https://learn.chatgpt.com/docs/codex/cli",
    releases: "https://github.com/openai/codex/releases",
    github: "openai/codex",
    prefix: "rust-v",
    npm: "@openai/codex",
  },
  {
    agent: "claude-code",
    command: "claude",
    official: "https://code.claude.com/docs/en/setup",
    npm: "@anthropic-ai/claude-code",
  },
  {
    agent: "cursor",
    command: "cursor-agent",
    official: "https://cursor.com/docs/cli/installation",
    releases: "https://cursor.com/download",
  },
  {
    agent: "opencode",
    command: "opencode",
    official: "https://opencode.ai/docs/",
    releases: "https://github.com/anomalyco/opencode/releases",
    github: "anomalyco/opencode",
    prefix: "v",
    npm: "opencode-ai",
  },
  {
    agent: "open-claw",
    command: "openclaw",
    official: "https://docs.openclaw.ai/install",
    releases: "https://github.com/openclaw/openclaw/releases",
    npm: "openclaw",
  },
  {
    agent: "hermes",
    command: "hermes",
    official: "https://hermes-agent.nousresearch.com/docs/",
    releases: "https://github.com/NousResearch/hermes-agent/releases",
    github: "NousResearch/hermes-agent",
    prefix: "v",
  },
  {
    agent: "grok-build",
    command: "grok",
    official: "https://docs.x.ai/build/overview",
    releases: "https://github.com/xai-org/grok-build/releases",
    github: "xai-org/grok-build",
    prefix: "v",
    npm: "@xai-official/grok",
  },
  {
    agent: "antigravity",
    command: "agy",
    official: "https://antigravity.google/docs/cli/overview/",
  },
  {
    agent: "devin",
    command: "devin",
    official: "https://docs.devin.ai/cli",
  },
];
const CHANNELS: Record<string, Channel[]> = {
  codex: ["official-installer", "npm", "pnpm", "bun", "homebrew"],
  "claude-code": ["official-installer", "npm", "homebrew"],
  cursor: ["official-installer", "desktop-app"],
  opencode: ["official-installer", "npm", "pnpm", "bun", "yarn", "homebrew"],
  "open-claw": ["official-installer", "npm", "pnpm", "bun", "desktop-app"],
  hermes: ["official-installer", "desktop-app", "nix"],
  "grok-build": ["official-installer", "npm"],
  antigravity: [],
  // Devin Desktop bundles its own CLI; only the official installer is offered from here.
  devin: ["official-installer"],
};
const PACKAGES: Record<string, string> = {
  codex: "@openai/codex",
  "claude-code": "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
  "open-claw": "openclaw",
  "grok-build": "@xai-official/grok",
};

export class AgentTools {
  #cachePath: string;
  #running = false;
  constructor(dataDir: string) {
    this.#cachePath = path.join(dataDir, "tool-cache", "agent-tools.json");
  }

  async snapshot(force: boolean) {
    const now = new Date();
    const cache = await this.#readCache();
    const keys = [
      ...new Set(
        SPECS.flatMap((spec) => [
          ...(spec.npm ? [`npm:${spec.npm}`] : []),
          ...(spec.github ? [`github:${spec.github}`] : []),
          ...(spec.agent === "cursor" ? ["cursor:installer"] : []),
          ...(spec.agent === "codex" ? ["homebrew-cask:codex"] : []),
          ...(spec.agent === "claude-code" ? ["homebrew-cask:claude-code"] : []),
          ...(spec.agent === "opencode" ? ["homebrew-formula:opencode"] : []),
        ]),
      ),
    ];
    const stale = keys.filter(
      (key) =>
        force ||
        !cache.versions[key] ||
        now.getTime() - Date.parse(cache.versions[key]!.checked_at) >= 6 * 60 * 60_000,
    );
    const errors: string[] = [];
    await Promise.all(
      stale.map(async (key) => {
        try {
          const version = await this.#latest(key);
          cache.versions[key] = { version, checked_at: now.toISOString() };
        } catch (error) {
          errors.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    if (stale.length) await this.#writeCache(cache);
    const tools = await Promise.all(SPECS.map(async (spec) => this.#inspect(spec, cache.versions)));
    const checked = Object.values(cache.versions)
      .map((entry) => Date.parse(entry.checked_at))
      .filter(Number.isFinite);
    return {
      tools,
      checked_at: now.toISOString(),
      latest_checked_at: checked.length ? new Date(Math.max(...checked)).toISOString() : null,
      cache_status: stale.length ? (errors.length ? "cached" : "fresh") : "fresh",
      errors,
    };
  }

  async execute(params: Record<string, unknown>) {
    const agent = typeof params.agent === "string" ? params.agent : "";
    const actionId = typeof params.action_id === "string" ? params.action_id : "";
    if (params.confirmed !== true)
      throw new Error("Agent tool execution requires explicit confirmation");
    if (this.#running)
      return {
        agent,
        action_id: actionId,
        status: "busy",
        output: "",
        completed_at: new Date().toISOString(),
      };
    this.#running = true;
    try {
      const snapshot = await this.snapshot(false);
      const tool = snapshot.tools.find((item) => item.agent === agent);
      const action = tool?.actions.find((item) => item.id === actionId);
      if (!tool || !action)
        throw new Error("Agent tool action is no longer available; detect again");
      if (action.mode !== "execute" || !action.manager_path || !action.target_version)
        throw new Error("This action cannot be executed inside AgentKib");
      const current = tool.installations.find((item) => item.id === action.installation_id);
      const managerName = action.channel === "homebrew" ? "brew" : action.channel;
      const manager = resolveCommand(
        this.#expandPath(current?.manager_path ?? action.manager_path ?? managerName),
      );
      if (!manager)
        throw new Error("Agent tool package manager is no longer available; detect again");
      const npmAllowScripts =
        action.channel === "npm" && agent === "open-claw"
          ? await this.#npmAllowsScripts(manager)
          : true;
      if (npmAllowScripts === null)
        throw new Error("Agent tool package manager version is unavailable; detect again");
      const args = this.#managerArgs(
        action.channel,
        agent,
        action.target_version,
        current?.version !== undefined,
        npmAllowScripts,
      );
      const environment = { ...process.env };
      const pathKey =
        Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
      const managerDirectory = path.dirname(manager);
      environment[pathKey] = [managerDirectory, environment[pathKey]]
        .filter(Boolean)
        .join(path.delimiter);
      const outcome = await this.#run(manager, args, 5 * 60_000, 256 * 1024, environment);
      const updated = await this.snapshot(true);
      const updatedInstallations =
        updated.tools.find((item) => item.agent === agent)?.installations ?? [];
      const verified =
        action.kind === "install"
          ? updatedInstallations
              .filter(
                (item) => item.channel === action.channel && item.runnable && item.is_path_default,
              )
              .find(
                (item) =>
                  item.version &&
                  (this.#compare(item.version, action.target_version!, agent) ?? -1) >= 0,
              )
          : updatedInstallations.find((item) => item.id === action.installation_id);
      const after = verified?.version;
      const ok =
        outcome.code === 0 &&
        Boolean(after && (this.#compare(after, action.target_version, agent) ?? -1) >= 0);
      return {
        agent,
        action_id: action.id,
        status: outcome.timedOut
          ? "timed-out"
          : outcome.code !== 0
            ? "failed"
            : ok
              ? "succeeded"
              : "verification-failed",
        exit_code: outcome.code,
        output: this.#redact(outcome.output),
        installation_id: verified?.id ?? action.installation_id,
        before_version: current?.version,
        after_version: after,
        completed_at: new Date().toISOString(),
      };
    } finally {
      this.#running = false;
    }
  }

  async #inspect(spec: Spec, cache: Record<string, { version: string; checked_at: string }>) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    const additional: string[] = [];
    if (home) {
      additional.push(path.join(home, ".opencode/bin"), path.join(home, ".grok/bin"));
      const versions = path.join(process.env.NVM_DIR ?? path.join(home, ".nvm"), "versions/node");
      const entries = await fs.readdir(versions, { withFileTypes: true }).catch(() => []);
      additional.push(
        ...entries
          .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
          .map((entry) => path.join(versions, entry.name, "bin"))
          .sort(),
      );
    }
    const names = [spec.command, ...(spec.agent === "cursor" ? ["agent"] : [])];
    const defaults = new Set(
      names.flatMap((command) => {
        const candidate = resolveCommand(command);
        return candidate ? [pathIdentity(candidate)] : [];
      }),
    );
    const seen = new Set<string>();
    const unique = names
      .flatMap((command) => resolveCommands(command, process.env, additional))
      .filter((executable) => {
        if (
          spec.agent === "cursor" &&
          path.basename(executable).replace(/\.(exe|cmd|bat)$/i, "") === "agent" &&
          this.#inferChannel(spec, executable, pathIdentity(executable)) !== "official-installer"
        )
          return false;
        const identity = pathIdentity(executable);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    const installations: Installation[] = [];
    for (const executable of unique) {
      const resolved = await fs.realpath(executable).catch(() => executable);
      const channel = this.#inferChannel(spec, executable, resolved);
      const managerChannel = this.#managerChannel(executable, resolved, channel);
      const manager = managerChannel ? resolveCommand(managerChannel) : null;
      const version = await this.#probe(executable, manager ?? undefined).catch(() => undefined);
      const verifiedManager =
        manager && (await this.#ownsPackage(spec, channel, executable, resolved, manager))
          ? manager
          : undefined;
      const id = `${spec.agent}-${createHash("sha256").update(executable).digest("hex").slice(0, 12)}`;
      installations.push({
        id,
        path: this.#redactPath(executable),
        resolved_path: this.#redactPath(resolved),
        ...(version ? { version } : {}),
        runnable: Boolean(version),
        ...(version ? {} : { error: "version-unavailable" }),
        channel,
        environment: this.#environment(resolved),
        ...(verifiedManager ? { manager_path: this.#redactPath(verifiedManager) } : {}),
        is_path_default: defaults.has(pathIdentity(executable)),
      });
    }
    const primary =
      installations.find((item) => item.is_path_default) ??
      (installations.length === 1 ? installations[0] : undefined);
    const channel = primary?.channel ?? "unknown";
    const upstreamKey = this.#upstreamKey(spec);
    const latest = this.#versionFor(spec, channel, cache);
    const upstream = upstreamKey ? cache[upstreamKey]?.version : undefined;
    const warnings = [
      ...(installations.length > 1 ? ["multiple-executables"] : []),
      ...(installations.some((item) => !item.runnable) ? ["installation-not-runnable"] : []),
      ...(installations.length && !primary?.version ? ["version-unavailable"] : []),
      ...(installations.length && !latest ? ["latest-unavailable"] : []),
      ...(installations.length && ["unknown", "local"].includes(channel)
        ? ["channel-unverified"]
        : []),
    ];
    const current = primary?.version;
    const comparison = current && latest ? this.#compare(current, latest, spec.agent) : null;
    const conflict = installations.length > 1;
    const state = conflict
      ? "conflict"
      : !installations.length
        ? "uninstalled"
        : !current ||
            ![
              "npm",
              "pnpm",
              "bun",
              "yarn",
              "homebrew",
              "official-installer",
              "nix",
              "volta",
            ].includes(channel)
          ? "unknown"
          : comparison === -1
            ? "update-available"
            : comparison === null
              ? "unknown"
              : "current";
    const npmManager =
      spec.agent === "open-claw" &&
      (state === "uninstalled" || (state === "update-available" && channel === "npm"))
        ? resolveCommand(this.#expandPath(primary?.manager_path ?? "npm"))
        : null;
    const npmAllowScripts = npmManager ? await this.#npmAllowsScripts(npmManager) : true;
    return {
      agent: spec.agent,
      installed: installations.length > 0,
      current_version: current,
      latest_version: latest,
      recommended_version: latest,
      upstream_version: upstream,
      state,
      channel,
      installations,
      warnings,
      official_url: spec.official,
      ...(spec.releases ? { release_url: spec.releases } : {}),
      actions: this.#actions(spec, state, primary, latest, cache, npmAllowScripts),
    };
  }

  #upstreamKey(spec: Spec) {
    return spec.agent === "cursor"
      ? "cursor:installer"
      : spec.github
        ? `github:${spec.github}`
        : spec.npm
          ? `npm:${spec.npm}`
          : undefined;
  }

  #versionFor(
    spec: Spec,
    channel: Channel,
    cache: Record<string, { version: string; checked_at: string }>,
  ) {
    const key =
      channel === "homebrew"
        ? spec.agent === "opencode"
          ? "homebrew-formula:opencode"
          : spec.agent === "codex" || spec.agent === "claude-code"
            ? `homebrew-cask:${spec.agent}`
            : this.#upstreamKey(spec)
        : ["npm", "pnpm", "bun", "yarn", "volta"].includes(channel) && spec.npm
          ? `npm:${spec.npm}`
          : this.#upstreamKey(spec);
    return key ? cache[key]?.version : undefined;
  }

  #actions(
    spec: Spec,
    state: string,
    primary: Installation | undefined,
    latest: string | undefined,
    cache: Record<string, { version: string; checked_at: string }>,
    npmAllowScripts: boolean | null,
  ): Action[] {
    if (state === "uninstalled") {
      const actions = CHANNELS[spec.agent]!.map((channel) =>
        this.#installAction(spec, channel, this.#versionFor(spec, channel, cache), npmAllowScripts),
      ).filter((item): item is Action => Boolean(item));
      return actions.length ? actions : [this.#docAction(spec, "unknown")];
    }
    if (
      state === "update-available" &&
      primary &&
      latest &&
      ["npm", "pnpm", "bun", "homebrew", "volta"].includes(primary.channel)
    ) {
      if (primary.channel === "npm" && spec.agent === "open-claw" && npmAllowScripts === null)
        return [this.#docAction(spec, "npm")];
      const manager = primary.manager_path;
      if (manager) {
        const shell = process.platform === "win32" ? "powershell" : "posix";
        return [
          {
            id: this.#actionId(spec.agent, "update", primary.channel, latest, primary.id, manager),
            kind: "update",
            mode: "execute",
            channel: primary.channel,
            shell,
            command: this.#command(
              this.#expandPath(manager),
              this.#managerArgs(primary.channel, spec.agent, latest, true, npmAllowScripts ?? true),
            ),
            url: spec.official,
            target_version: latest,
            installation_id: primary.id,
            manager_path: this.#redactPath(manager),
          },
        ];
      }
      const managerName = primary.channel === "homebrew" ? "brew" : primary.channel;
      return [
        {
          id: this.#actionId(spec.agent, "update", primary.channel, latest, primary.id),
          kind: "update",
          mode: "copy-command",
          channel: primary.channel,
          shell: process.platform === "win32" ? "powershell" : "posix",
          command: this.#command(
            managerName,
            this.#managerArgs(primary.channel, spec.agent, latest, true, npmAllowScripts ?? true),
          ),
          url: spec.official,
          target_version: latest,
          installation_id: primary.id,
        },
      ];
    }
    if (state === "update-available" && primary && latest && primary.channel === "yarn")
      return [
        {
          id: this.#actionId(spec.agent, "update", "yarn", latest, primary.id),
          kind: "update",
          mode: "copy-command",
          channel: "yarn",
          shell: process.platform === "win32" ? "powershell" : "posix",
          command: this.#command("yarn", this.#managerArgs("yarn", spec.agent, latest, true)),
          url: spec.official,
          target_version: latest,
          installation_id: primary.id,
        },
      ];
    if (
      state === "update-available" &&
      primary &&
      latest &&
      primary.channel === "nix" &&
      spec.agent === "hermes"
    )
      return [
        {
          id: this.#actionId(spec.agent, "update", "nix", latest, primary.id),
          kind: "update",
          mode: "copy-command",
          channel: "nix",
          shell: "posix",
          command: "nix profile upgrade hermes-agent",
          url: spec.official,
          target_version: latest,
          installation_id: primary.id,
        },
      ];
    if (
      state === "update-available" &&
      primary &&
      latest &&
      primary.channel === "official-installer"
    )
      return [
        {
          id: this.#actionId(
            spec.agent,
            "update",
            primary.channel,
            latest,
            primary.id,
            primary.path,
          ),
          kind: "update",
          mode: "copy-command",
          channel: primary.channel,
          shell: process.platform === "win32" ? "powershell" : "posix",
          command: this.#command(this.#expandPath(primary.path), [
            spec.agent === "opencode" ? "upgrade" : "update",
          ]),
          url: spec.official,
          target_version: latest,
          installation_id: primary.id,
        },
      ];
    return [this.#docAction(spec, primary?.channel ?? "unknown")];
  }

  #installAction(
    spec: Spec,
    channel: Channel,
    target?: string,
    npmAllowScripts: boolean | null = true,
  ): Action | null {
    if (channel === "npm" && spec.agent === "open-claw" && npmAllowScripts === null) return null;
    const managerName = channel === "homebrew" ? "brew" : channel;
    const manager = ["npm", "pnpm", "bun", "yarn", "homebrew", "volta"].includes(channel)
      ? resolveCommand(managerName)
      : null;
    const command = this.#installCommand(
      spec,
      channel,
      target,
      manager ?? undefined,
      npmAllowScripts ?? true,
    );
    if (!command) return null;
    const shell = process.platform === "win32" ? "powershell" : "posix";
    const mode =
      ["npm", "pnpm", "bun", "volta"].includes(channel) && manager && target
        ? "execute"
        : channel === "desktop-app"
          ? "open-documentation"
          : "copy-command";
    return {
      id: this.#actionId(spec.agent, "install", channel, target, undefined, manager ?? undefined),
      kind: "install",
      mode,
      channel,
      ...(mode !== "open-documentation" ? { shell } : {}),
      command,
      url: spec.official,
      ...(target ? { target_version: target } : {}),
      ...(manager ? { manager_path: this.#redactPath(manager) } : {}),
    };
  }

  #installCommand(
    spec: Spec,
    channel: Channel,
    target?: string,
    manager?: string,
    npmAllowScripts = true,
  ): string | null {
    const shell = process.platform === "win32";
    if (channel === "official-installer") {
      const commands: Record<string, string> = {
        codex: shell
          ? "irm https://chatgpt.com/codex/install.ps1 | iex"
          : "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
        "claude-code": shell
          ? "irm https://claude.ai/install.ps1 | iex"
          : "curl -fsSL https://claude.ai/install.sh | bash",
        cursor: shell
          ? "irm 'https://cursor.com/install?win32=true' | iex"
          : "curl https://cursor.com/install -fsS | bash",
        opencode: shell ? "" : "curl -fsSL https://opencode.ai/install | bash",
        "open-claw": shell
          ? "iwr -useb https://openclaw.ai/install.ps1 | iex"
          : "curl -fsSL https://openclaw.ai/install.sh | bash",
        hermes: shell
          ? "iex (irm https://hermes-agent.nousresearch.com/install.ps1)"
          : "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
        "grok-build": shell
          ? "irm https://x.ai/cli/install.ps1 | iex"
          : "curl -fsSL https://x.ai/cli/install.sh | bash",
        devin: shell
          ? "irm https://static.devin.ai/cli/setup.ps1 | iex"
          : "curl -fsSL https://cli.devin.ai/install.sh | bash",
      };
      return commands[spec.agent] || null;
    }
    if (channel === "desktop-app") return null;
    if (channel === "nix" && spec.agent === "hermes")
      return "nix profile install github:NousResearch/hermes-agent";
    const pkg = PACKAGES[spec.agent];
    if (!pkg) return null;
    const packageRef = `${pkg}@${target ?? "latest"}`;
    const managerCmd = manager
      ? this.#command(
          manager,
          this.#managerArgs(channel, spec.agent, target ?? "latest", false, npmAllowScripts),
        )
      : null;
    if (managerCmd) return managerCmd;
    if (channel === "npm")
      return spec.agent === "open-claw"
        ? `npm install -g ${packageRef}${npmAllowScripts ? " --allow-scripts=openclaw" : ""}`
        : `npm install -g ${packageRef}`;
    if (channel === "pnpm")
      return spec.agent === "open-claw"
        ? `pnpm add -g --allow-build=openclaw ${packageRef}`
        : `pnpm add -g ${packageRef}`;
    if (channel === "bun")
      return spec.agent === "open-claw"
        ? `bun add -g --trust ${packageRef}`
        : `bun add -g ${packageRef}`;
    if (channel === "yarn" && spec.agent === "opencode") return `yarn global add ${packageRef}`;
    if (channel === "homebrew")
      return this.#command(
        "brew",
        this.#managerArgs(channel, spec.agent, target ?? "latest", false),
      );
    return null;
  }

  #managerArgs(
    channel: string,
    agent: string,
    target: string,
    update: boolean,
    npmAllowScripts = true,
  ) {
    const pkg = PACKAGES[agent];
    if (!pkg) throw new Error("Agent tool package is unsupported");
    const ref = `${pkg}@${target}`;
    if (channel === "homebrew")
      return [
        update ? "upgrade" : "install",
        ...(agent === "opencode" ? [] : ["--cask"]),
        agent === "codex" ? "codex" : agent === "claude-code" ? "claude-code" : "opencode",
      ];
    if (channel === "volta") return ["install", ref];
    if (channel === "pnpm")
      return agent === "open-claw"
        ? [...(update ? ["update", "-g"] : ["add", "-g"]), "--allow-build=openclaw", ref]
        : update
          ? ["update", "-g", ref]
          : ["add", "-g", ref];
    if (channel === "bun")
      return agent === "open-claw"
        ? [...(update ? ["update", "-g"] : ["add", "-g"]), "--trust", ref]
        : update
          ? ["update", "-g", ref]
          : ["add", "-g", ref];
    if (channel === "yarn") return ["global", "add", ref];
    if (channel === "npm" && agent === "open-claw")
      return ["install", "-g", ref, ...(npmAllowScripts ? ["--allow-scripts=openclaw"] : [])];
    return update ? ["install", "-g", ref] : ["install", "-g", ref];
  }

  async #npmAllowsScripts(manager: string): Promise<boolean | null> {
    try {
      const result = await this.#run(manager, ["--version"], 5_000, 4096);
      const match =
        result.code === 0 && !result.timedOut
          ? result.stdout.trim().match(/^(\d+)\.(\d+)\./)
          : null;
      if (!match) return null;
      const major = Number(match[1]);
      const minor = Number(match[2]);
      return major > 11 || (major === 11 && minor >= 16);
    } catch {
      return null;
    }
  }

  #docAction(spec: Spec, channel: Channel): Action {
    return {
      id: this.#actionId(spec.agent, "open-documentation", channel),
      kind: "open-documentation",
      mode: "open-documentation",
      channel,
      url: spec.official,
    };
  }
  #actionId(
    agent: string,
    kind: string,
    channel: string,
    version?: string,
    installation?: string,
    manager?: string,
  ) {
    const binding = manager
      ? createHash("sha256").update(manager).digest("hex").slice(0, 12)
      : "manual";
    return `${agent}:${kind}:${channel}:${version ?? "unversioned"}:${installation ?? "new"}:${binding}`;
  }
  #managerChannel(executable: string, resolved: string, inferred: Channel) {
    const name = inferred === "homebrew" ? "brew" : inferred;
    if (!["npm", "pnpm", "bun", "yarn", "homebrew", "volta"].includes(inferred)) return undefined;
    const directories = [path.dirname(executable), path.dirname(resolved)];
    const marker = `${path.sep}node_modules${path.sep}`;
    const index = resolved.indexOf(marker);
    if (inferred === "npm" && index >= 0) {
      const modulesParent = resolved.slice(0, index);
      const prefix =
        path.basename(modulesParent) === "lib" ? path.dirname(modulesParent) : modulesParent;
      directories.unshift(process.platform === "win32" ? prefix : path.join(prefix, "bin"));
    }
    if (inferred === "homebrew") {
      const target = resolved.replaceAll("\\", "/");
      if (target.startsWith("/opt/homebrew/")) directories.unshift("/opt/homebrew/bin");
      if (target.startsWith("/usr/local/")) directories.unshift("/usr/local/bin");
    }
    for (const directory of [...new Set(directories)]) {
      const manager = resolveCommand(path.join(directory, name));
      if (manager) return manager;
    }
    // A standard pnpm global shim can live in PNPM_HOME while pnpm itself is
    // elsewhere. Its reported global root is checked against the shim below.
    if (inferred === "pnpm") return resolveCommand("pnpm") ?? undefined;
    return undefined;
  }
  async #ownsPackage(
    spec: Spec,
    channel: Channel,
    executable: string,
    resolved: string,
    manager: string,
  ): Promise<boolean> {
    const packageName = PACKAGES[spec.agent];
    const value = `${executable}|${resolved}`.replaceAll("\\", "/").toLowerCase();
    const brewToken = spec.agent === "claude-code" ? "claude-code" : spec.agent;
    const brewKind = spec.agent === "opencode" ? "--formula" : "--cask";
    const windowsNpmShim =
      process.platform === "win32" &&
      channel === "npm" &&
      /\/appdata\/roaming\/npm\/[^/]+\.(?:cmd|bat)$/.test(
        executable.replaceAll("\\", "/").toLowerCase(),
      ) &&
      path
        .basename(executable)
        .replace(/\.(?:cmd|bat)$/i, "")
        .toLowerCase() === spec.command;
    const pathMatches =
      channel === "homebrew"
        ? value.includes(`/${brewKind === "--formula" ? "cellar" : "caskroom"}/${brewToken}/`)
        : channel === "volta"
          ? value.includes("/volta/")
          : channel === "pnpm"
            ? value.includes("/pnpm/") || value.includes("/.pnpm/")
            : packageName !== undefined &&
              (windowsNpmShim ||
                value.includes(`/node_modules/${packageName.toLowerCase()}/`) ||
                value.includes(`/${packageName.toLowerCase().replace("/", "+")}@`));
    if (!pathMatches) return false;
    const args =
      channel === "npm"
        ? ["ls", "-g", "--depth=0", "--json"]
        : channel === "pnpm"
          ? ["list", "-g", "--depth=0", "--json"]
          : channel === "bun"
            ? ["pm", "-g", "ls"]
            : channel === "volta"
              ? ["list", "--format", "plain"]
              : channel === "homebrew"
                ? ["list", brewKind, "--versions", brewToken]
                : null;
    if (!args) return false;
    try {
      const environment = { ...process.env };
      const pathKey =
        Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
      environment[pathKey] = [path.dirname(manager), environment[pathKey]]
        .filter(Boolean)
        .join(path.delimiter);
      const result = await this.#run(manager, args, 5_000, 64 * 1024, environment);
      if (result.code !== 0 || result.timedOut) return false;
      if (channel === "homebrew")
        return result.stdout.trim().split(/\s+/)[0]?.toLowerCase() === brewToken;
      if (channel === "bun" || channel === "volta")
        return result.stdout.split(/\s+/).some((word) => {
          const entry = word.replace(/^[^\w@]+/, "");
          return entry === packageName || entry.startsWith(`${packageName}@`);
        });
      const jsonStart = result.stdout.search(/(?:^|\n)\s*(?:\[(?=\s*[{\]])|\{(?=\s*"))/);
      if (jsonStart < 0) return false;
      const listing = JSON.parse(result.stdout.slice(jsonStart).trim()) as unknown;
      const packageEntry = (entry: unknown): Record<string, unknown> | null => {
        if (Array.isArray(entry)) {
          for (const item of entry) {
            const found = packageEntry(item);
            if (found) return found;
          }
          return null;
        }
        if (!entry || typeof entry !== "object") return null;
        const data = entry as Record<string, unknown>;
        for (const key of ["dependencies", "devDependencies", "optionalDependencies"]) {
          const packages = data[key];
          if (packages && typeof packages === "object" && Object.hasOwn(packages, packageName!)) {
            const found = (packages as Record<string, unknown>)[packageName!];
            return found && typeof found === "object" ? (found as Record<string, unknown>) : {};
          }
        }
        return null;
      };
      const entry = packageEntry(listing);
      if (!entry) return false;
      const rootResult = await this.#run(manager, ["root", "-g"], 5_000, 4096, environment);
      const root = rootResult.stdout.trim().split(/\r?\n/).at(-1) ?? "";
      if (rootResult.code !== 0 || !path.isAbsolute(root) || !packageName) return false;
      const packageDirectory =
        typeof entry.path === "string" && path.isAbsolute(entry.path)
          ? entry.path
          : path.join(root, packageName);
      const rootTarget = await fs.realpath(root).catch(() => null);
      const packageTarget = await fs.realpath(packageDirectory).catch(() => null);
      if (!rootTarget || !packageTarget) return false;
      const within = (base: string, candidate: string) => {
        const relative = path.relative(base, candidate);
        return (
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        );
      };
      if (!within(root, packageDirectory) && !within(rootTarget, packageDirectory)) return false;
      const target = pathIdentity(resolved);
      const owned = pathIdentity(packageTarget);
      if (target === owned || target.startsWith(`${owned}${path.sep}`)) return true;
      if (windowsNpmShim) {
        if (pathIdentity(path.dirname(executable)) !== pathIdentity(path.dirname(rootTarget)))
          return false;
        const metadata = await fs.stat(executable);
        if (!metadata.isFile() || metadata.size > 64 * 1024) return false;
        const shim = (await fs.readFile(executable, "utf8")).replaceAll("\\", "/").toLowerCase();
        return shim.includes(`node_modules/${packageName.toLowerCase()}/`);
      }
      if (channel !== "pnpm") return false;
      const globalMarker = `${path.sep}global${path.sep}`;
      const globalIndex = root.lastIndexOf(globalMarker);
      if (globalIndex < 0) return false;
      const pnpmHome = root.slice(0, globalIndex);
      if (pathIdentity(path.dirname(executable)) !== pathIdentity(pnpmHome)) return false;
      const metadata = await fs.stat(executable);
      if (!metadata.isFile() || metadata.size > 64 * 1024) return false;
      const shim = await fs.readFile(executable, "utf8");
      return shim.includes(`node_modules/${packageName}/`);
    } catch {
      return false;
    }
  }
  #inferChannel(spec: Spec, executable: string, resolved: string): Channel {
    const value = `${executable}|${resolved}`.replaceAll("\\", "/").toLowerCase();
    if (value.includes("/caskroom/") || value.includes("/cellar/")) return "homebrew";
    if (value.includes("/.bun/") || value.includes("/bun/")) return "bun";
    if (value.includes("/pnpm/") || value.includes("/.pnpm/")) return "pnpm";
    if (value.includes("/volta/")) return "volta";
    if (value.includes("/.config/yarn/global/")) return "yarn";
    if (value.includes("/node_modules/") || value.includes("/.nvm/") || value.includes("/fnm/"))
      return "npm";
    if (process.platform === "win32" && /\/appdata\/roaming\/npm\/[^/]+\.(?:cmd|bat)\b/.test(value))
      return "npm";
    if (value.includes("/nix/store/")) return "nix";
    if (value.includes("/mise/")) return "unknown";
    if (spec.agent === "claude-code" && value.includes("/.local/share/claude/"))
      return "official-installer";
    // Devin Desktop runs the CLI from its own bundle and updates it with the app.
    if (spec.agent === "devin" && value.includes("/extensions/windsurf/devin/bin/"))
      return "desktop-app";
    if (spec.agent === "devin" && value.includes("/devin/cli/_versions/"))
      return "official-installer";
    if (
      spec.agent === "cursor" &&
      (value.includes("/.local/share/cursor-agent/") ||
        value.includes("/appdata/local/cursor-agent/"))
    )
      return "official-installer";
    if (
      ["codex", "claude-code", "hermes", "grok-build", "opencode", "open-claw", "devin"].includes(
        spec.agent,
      ) &&
      path
        .basename(executable)
        .toLowerCase()
        .replace(/\.(exe|cmd|bat)$/, "") === spec.command
    )
      return "official-installer";
    return "local";
  }
  #environment(executable: string) {
    const value = executable.replaceAll("\\", "/");
    return value.includes("/.nvm/")
      ? "nvm"
      : value.includes("/.fnm/")
        ? "fnm"
        : value.includes("/.volta/")
          ? "volta"
          : value.includes("/.mise/")
            ? "mise"
            : value.startsWith("/usr/")
              ? "system"
              : "unknown";
  }
  async #probe(executable: string, manager?: string): Promise<string | undefined> {
    const environment = { ...process.env };
    const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
    environment[pathKey] = [
      path.dirname(executable),
      manager && path.dirname(manager),
      environment[pathKey],
    ]
      .filter(Boolean)
      .join(path.delimiter);
    const result = await this.#run(executable, ["--version"], 2_000, 64 * 1024, environment);
    if (result.code !== 0 || result.timedOut) return undefined;
    const version = result.output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
    return version;
  }
  async #latest(key: string) {
    const [kind, id] = key.split(":", 2) as [string, string];
    const url =
      kind === "npm"
        ? `https://registry.npmjs.org/${id.replace("/", "%2f")}/latest`
        : kind === "github"
          ? `https://api.github.com/repos/${id}/releases/latest`
          : kind === "cursor"
            ? "https://cursor.com/install"
            : kind === "homebrew-cask" || kind === "homebrew-formula"
              ? `https://formulae.brew.sh/api/${kind === "homebrew-cask" ? "cask" : "formula"}/${id}.json`
              : "";
    if (!url) throw new Error("unknown release source");
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: {
        Accept: kind === "cursor" ? "text/plain" : "application/json",
        "User-Agent": "AgentKib tool inspector",
      },
    });
    if (!response.ok) throw new Error(`release lookup failed (${response.status})`);
    if (kind === "cursor") {
      const script = await response.text();
      for (const marker of ["cursor-agent/versions/", "downloads.cursor.com/lab/"]) {
        const start = script.indexOf(marker);
        if (start < 0) continue;
        const version = script
          .slice(start + marker.length)
          .split(/[/'\"]/)[0]
          ?.trim();
        if (version && !version.includes("$")) return version;
      }
      throw new Error("Cursor installer did not expose a version identifier");
    }
    const data = (await response.json()) as {
      version?: unknown;
      tag_name?: unknown;
      versions?: { stable?: unknown };
    };
    const version =
      kind === "npm"
        ? data.version
        : kind === "github"
          ? typeof data.tag_name === "string"
            ? data.tag_name.replace(/^rust-v|^v/, "")
            : undefined
          : kind === "homebrew-formula"
            ? data.versions?.stable
            : data.version;
    if (typeof version !== "string") throw new Error("release version is unavailable");
    return version;
  }
  async #readCache() {
    try {
      const value = JSON.parse(await fs.readFile(this.#cachePath, "utf8")) as {
        versions?: Record<string, { version: string; checked_at: string }>;
      };
      return { versions: value.versions ?? {} };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { versions: {} };
      throw error;
    }
  }
  async #writeCache(value: { versions: Record<string, { version: string; checked_at: string }> }) {
    await fs.mkdir(path.dirname(this.#cachePath), { recursive: true });
    const temp = `${this.#cachePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temp, this.#cachePath);
  }
  #compare(current: string, latest: string, agent: string): number | null {
    if (agent === "cursor") {
      const build = (value: string) => {
        const match = value.match(/(?:^|\s)(\d{4})\.(\d{1,2})\.(\d{1,2})-([0-9a-z]+)/i);
        if (!match) return null;
        const parts = match.slice(1, 4).map(Number);
        return parts[1]! >= 1 && parts[1]! <= 12 && parts[2]! >= 1 && parts[2]! <= 31
          ? parts
          : null;
      };
      const left = build(current);
      const right = build(latest);
      if (!left || !right) return null;
      for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
      return current.trim() === latest.trim() ? 0 : -1;
    }
    const parse = (value: string) => {
      const match = value.match(
        /(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/,
      );
      return match
        ? {
            numbers: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)],
            prerelease: match[4]?.slice(1).split(".") ?? [],
          }
        : null;
    };
    const left = parse(current);
    const right = parse(latest);
    if (!left || !right) return null;
    for (let i = 0; i < 3; i++)
      if (left.numbers[i] !== right.numbers[i])
        return left.numbers[i]! < right.numbers[i]! ? -1 : 1;
    if (!left.prerelease.length || !right.prerelease.length)
      return left.prerelease.length === right.prerelease.length
        ? 0
        : left.prerelease.length
          ? -1
          : 1;
    for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
      const a = left.prerelease[i];
      const b = right.prerelease[i];
      if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
      if (a === b) continue;
      const aNumeric = /^\d+$/.test(a);
      const bNumeric = /^\d+$/.test(b);
      if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
      if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
      return a < b ? -1 : 1;
    }
    return 0;
  }
  #command(program: string, args: string[]) {
    if (process.platform === "win32") {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      return `& ${quote(program)} ${args.map(quote).join(" ")}`;
    }
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    return `${quote(program)} ${args.map((arg) => (/^[A-Za-z0-9@%_+=:,./~-]+$/.test(arg) ? arg : quote(arg))).join(" ")}`;
  }
  #redactPath(value: string) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home && (value === home || value.startsWith(home + path.sep))
      ? `~${value.slice(home.length).replaceAll("\\", "/")}`
      : value.replaceAll("\\", "/");
  }
  #expandPath(value: string) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home && (value === "~" || value.startsWith("~/"))
      ? path.join(home, value.slice(2))
      : value;
  }
  #redact(value: string) {
    return value
      .split(/\r?\n/)
      .filter(
        (line) =>
          !/https?:\/\/[^\s:@/]+:[^\s@/]+@/i.test(line) &&
          !/(?:token|secret|password|authorization)\s*[:=]/i.test(line),
      )
      .join("\n")
      .slice(0, 256 * 1024);
  }

  #run(
    program: string,
    args: string[],
    timeout = 5 * 60_000,
    maxOutput = 256 * 1024,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    return new Promise<{
      code: number | null;
      output: string;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn(program, args, {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        detached: process.platform !== "win32",
      });
      let tree: NativeProcessTree | undefined;
      const terminate = () => {
        if (tree) {
          tree.terminate();
          return;
        }
        if (process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      };
      child.once("spawn", () => {
        if (process.platform === "win32" && child.pid) {
          try {
            tree = windowsProcessTree(child.pid);
          } catch (error) {
            terminate();
            finish();
            reject(error);
          }
        }
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let timedOut = false;
      let finished = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return false;
        finished = true;
        clearTimeout(timer);
        clearTimeout(drainTimer);
        tree?.close();
        child.stdout?.destroy();
        child.stderr?.destroy();
        return true;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
        // Detached descendants must not keep a version probe waiting on inherited pipes.
        drainTimer = setTimeout(() => {
          if (finish()) resolve(result(child.exitCode));
        }, 500);
      }, timeout);
      const result = (code: number | null) => ({
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        output: `${stdout.toString("utf8")}${stderr.toString("utf8")}`,
        timedOut,
      });
      const read = (stream: "stdout" | "stderr", chunk: Buffer) => {
        const current = stream === "stdout" ? stdout : stderr;
        if (current.length >= maxOutput) return;
        const next = Buffer.concat([current, chunk.subarray(0, maxOutput - current.length)]);
        if (stream === "stdout") stdout = next;
        else stderr = next;
      };
      child.stdout!.on("data", (chunk: Buffer) => read("stdout", chunk));
      child.stderr!.on("data", (chunk: Buffer) => read("stderr", chunk));
      child.once("exit", terminate);
      child.once("error", (error) => {
        if (finish()) reject(error);
      });
      child.once("close", (code) => {
        if (finish()) resolve(result(code));
      });
    });
  }
}
