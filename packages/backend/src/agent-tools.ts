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
    const urls = [...new Set(SPECS.filter((spec) => spec.npm).map((spec) => `npm:${spec.npm}`))];
    const github = [
      ...new Set(SPECS.filter((spec) => spec.github).map((spec) => `github:${spec.github}`)),
    ];
    const keys = [...urls, ...github];
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
      const manager = resolveCommand(current?.manager_path ?? managerName);
      if (!manager)
        throw new Error("Agent tool package manager is no longer available; detect again");
      const args = this.#managerArgs(
        action.channel,
        agent,
        action.target_version,
        current?.version !== undefined,
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
      const after = updated.tools
        .find((item) => item.agent === agent)
        ?.installations.find((item) => item.id === action.installation_id)?.version;
      const ok = outcome.code === 0 && after === action.target_version;
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
        installation_id: action.installation_id,
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
        const identity = pathIdentity(executable);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    const installations: Installation[] = [];
    for (const executable of unique) {
      const version = await this.#probe(executable);
      const resolved = await fs.realpath(executable).catch(() => executable);
      const channel = this.#inferChannel(spec, executable, resolved);
      const managerChannel = this.#managerChannel(executable, resolved, channel);
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
        ...(managerChannel ? { manager_path: resolveCommand(managerChannel) ?? undefined } : {}),
        is_path_default: defaults.has(pathIdentity(executable)),
      });
    }
    const primary =
      installations.find((item) => item.is_path_default) ??
      (installations.length === 1 ? installations[0] : undefined);
    const channel = primary?.channel ?? "unknown";
    const npmKey = spec.npm ? `npm:${spec.npm}` : undefined;
    const githubKey = spec.github ? `github:${spec.github}` : undefined;
    const latest = ["npm", "pnpm", "bun", "yarn", "volta"].includes(channel)
      ? npmKey
        ? cache[npmKey]?.version
        : githubKey
          ? cache[githubKey]?.version
          : undefined
      : githubKey
        ? cache[githubKey]?.version
        : npmKey
          ? cache[npmKey]?.version
          : undefined;
    const upstream = githubKey ? cache[githubKey]?.version : latest;
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
    const comparison = current && latest ? this.#compare(current, latest) : null;
    const conflict = installations.length > 1;
    const state = conflict
      ? "conflict"
      : !installations.length
        ? "uninstalled"
        : !current ||
            !["npm", "pnpm", "bun", "yarn", "homebrew", "official-installer", "nix"].includes(
              channel,
            )
          ? "unknown"
          : comparison === -1
            ? "update-available"
            : comparison === null
              ? "unknown"
              : "current";
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
      actions: this.#actions(spec, state, primary, latest),
    };
  }

  #actions(
    spec: Spec,
    state: string,
    primary: Installation | undefined,
    latest: string | undefined,
  ): Action[] {
    if (state === "uninstalled") {
      const actions = CHANNELS[spec.agent]!.map((channel) =>
        this.#installAction(spec, channel, latest),
      ).filter((item): item is Action => Boolean(item));
      return actions.length ? actions : [this.#docAction(spec, "unknown")];
    }
    if (
      state === "update-available" &&
      primary &&
      latest &&
      ["npm", "pnpm", "bun", "homebrew"].includes(primary.channel)
    ) {
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
              manager,
              this.#managerArgs(primary.channel, spec.agent, latest, true),
            ),
            url: spec.official,
            target_version: latest,
            installation_id: primary.id,
            manager_path: this.#redactPath(manager),
          },
        ];
      }
    }
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
          command: `${path.basename(primary.path)} ${spec.agent === "opencode" ? "upgrade" : "update"}`,
          url: spec.official,
          target_version: latest,
          installation_id: primary.id,
        },
      ];
    return [this.#docAction(spec, primary?.channel ?? "unknown")];
  }

  #installAction(spec: Spec, channel: Channel, target?: string): Action | null {
    const managerName = channel === "homebrew" ? "brew" : channel;
    const manager = ["npm", "pnpm", "bun", "yarn", "homebrew"].includes(channel)
      ? resolveCommand(managerName)
      : null;
    const command = this.#installCommand(spec, channel, target, manager ?? undefined);
    if (!command) return null;
    const shell = process.platform === "win32" ? "powershell" : "posix";
    const mode =
      ["npm", "pnpm", "bun"].includes(channel) && manager && target
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

  #installCommand(spec: Spec, channel: Channel, target?: string, manager?: string): string | null {
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
      ? this.#command(manager, this.#managerArgs(channel, spec.agent, target ?? "latest", false))
      : null;
    if (managerCmd) return managerCmd;
    if (channel === "npm")
      return spec.agent === "open-claw"
        ? `npm install -g ${packageRef} --allow-scripts=openclaw`
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

  #managerArgs(channel: string, agent: string, target: string, update: boolean) {
    const pkg = PACKAGES[agent];
    if (!pkg) throw new Error("Agent tool package is unsupported");
    const ref = `${pkg}@${target}`;
    if (channel === "homebrew")
      return [
        update ? "upgrade" : "install",
        ...(agent === "opencode" ? [] : ["--cask"]),
        agent === "codex" ? "codex" : agent === "claude-code" ? "claude-code" : "opencode",
      ];
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
    return update ? ["install", "-g", ref] : ["install", "-g", ref];
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
    if (inferred === "npm") {
      // A shim can live outside its npm prefix. Bind updates to the package's
      // physical installation, never to whichever npm happens to be on PATH.
      const marker = `${path.sep}node_modules${path.sep}`;
      const index = resolved.indexOf(marker);
      if (index >= 0) {
        const modulesParent = resolved.slice(0, index);
        const prefix =
          path.basename(modulesParent) === "lib" ? path.dirname(modulesParent) : modulesParent;
        return (
          resolveCommand(path.join(prefix, process.platform === "win32" ? "npm" : "bin/npm")) ??
          undefined
        );
      }
      return resolveCommand(path.join(path.dirname(resolved), "npm")) ?? undefined;
    }
    if (
      inferred === "pnpm" ||
      inferred === "bun" ||
      inferred === "yarn" ||
      inferred === "homebrew" ||
      inferred === "volta"
    )
      return (
        resolveCommand(
          path.join(path.dirname(executable), inferred === "homebrew" ? "brew" : inferred),
        ) ??
        resolveCommand(inferred === "homebrew" ? "brew" : inferred) ??
        undefined
      );
    return undefined;
  }
  #inferChannel(spec: Spec, executable: string, resolved: string): Channel {
    const value = `${executable}|${resolved}`.replaceAll("\\", "/").toLowerCase();
    if (value.includes("/caskroom/") || value.includes("/cellar/")) return "homebrew";
    if (value.includes("/.bun/") || value.includes("/bun/")) return "bun";
    if (value.includes("/pnpm/")) return "pnpm";
    if (value.includes("/volta/")) return "volta";
    if (value.includes("/.config/yarn/global/")) return "yarn";
    if (value.includes("/node_modules/") || value.includes("/.nvm/") || value.includes("/fnm/"))
      return "npm";
    if (value.includes("/nix/store/")) return "nix";
    if (value.includes("/mise/")) return "unknown";
    if (spec.agent === "claude-code" && value.includes("/.local/share/claude/"))
      return "official-installer";
    if (
      ["codex", "claude-code", "hermes", "grok-build", "opencode", "open-claw"].includes(
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
  async #probe(executable: string): Promise<string | undefined> {
    const result = await this.#run(executable, ["--version"], 2_000, 64 * 1024);
    if (result.code !== 0 || result.timedOut) return undefined;
    const version = result.output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
    return version;
  }
  async #latest(key: string) {
    const [kind, id] = key.split(":", 2) as [string, string];
    const url =
      kind === "npm"
        ? `https://registry.npmjs.org/${id.replace("/", "%2f")}/latest`
        : `https://api.github.com/repos/${id}/releases/latest`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: "application/json", "User-Agent": "AgentKib tool inspector" },
    });
    if (!response.ok) throw new Error(`release lookup failed (${response.status})`);
    const data = (await response.json()) as { version?: unknown; tag_name?: unknown };
    const version =
      kind === "npm"
        ? data.version
        : typeof data.tag_name === "string"
          ? data.tag_name.replace(/^rust-v|^v/, "")
          : undefined;
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
  #compare(current: string, latest: string): number | null {
    const parse = (value: string) =>
      value
        .replace(/^[^\d]*/, "")
        .split(/[.+-]/)
        .slice(0, 3)
        .map(Number);
    const left = parse(current);
    const right = parse(latest);
    if (
      !left.length ||
      !right.length ||
      [...left, ...right].some((value) => !Number.isFinite(value))
    )
      return null;
    for (let i = 0; i < 3; i++)
      if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0) ? -1 : 1;
    return 0;
  }
  #command(program: string, args: string[]) {
    if (process.platform === "win32") {
      const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
      return `& ${quote(program)} ${args.map(quote).join(" ")}`;
    }
    return `${JSON.stringify(program)} ${args.map((arg) => (/^[A-Za-z0-9@%_+=:,./~-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ")}`;
  }
  #redactPath(value: string) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    return home && (value === home || value.startsWith(home + path.sep))
      ? `~${value.slice(home.length).replaceAll("\\", "/")}`
      : value.replaceAll("\\", "/");
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
    return new Promise<{ code: number | null; output: string; timedOut: boolean }>(
      (resolve, reject) => {
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
        let output = Buffer.alloc(0);
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
            if (finish())
              resolve({ code: child.exitCode, output: output.toString("utf8"), timedOut });
          }, 500);
        }, timeout);
        const read = (chunk: Buffer) => {
          if (output.length < maxOutput)
            output = Buffer.concat([output, chunk.subarray(0, maxOutput - output.length)]);
        };
        child.stdout!.on("data", read);
        child.stderr!.on("data", read);
        child.once("exit", terminate);
        child.once("error", (error) => {
          if (finish()) reject(error);
        });
        child.once("close", (code) => {
          if (finish()) resolve({ code, output: output.toString("utf8"), timedOut });
        });
      },
    );
  }
}
