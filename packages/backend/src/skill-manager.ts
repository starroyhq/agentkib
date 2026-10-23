import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { claudeConfigFiles, isClaudeConfigDirSet, resolveClaudeConfig } from "./claude-config";
import { isReparseOrSymlink } from "./native-files";
import { copySkillPackage, skillPackage, skillPreviewFile } from "./skill-package";
import { commitTask, currentTask } from "./task-executor";
import { SkillStateStore, SKILL_HASH_ALGORITHM, withSkillTargetLocks } from "./skill-state";
import { readSkillSyncTargetJournals, safeSkillDirectoryName } from "./skill-sync-journal";

type Agent =
  | "codex"
  | "claude-code"
  | "cursor"
  | "opencode"
  | "open-claw"
  | "hermes"
  | "grok-build"
  | "antigravity"
  | "deepseek-harness";
type Scope = "personal" | "workspace";
type Workspace = { id: string; path: string };
type Target = {
  id: string;
  agent: Agent;
  scope: Scope;
  workspace_id: string | null;
  profile: string | null;
  root: string;
  scope_root: string;
  visible_to: Agent[];
  writable: boolean;
  reason: string | null;
  conditions: string[];
};
type Observation = {
  id: string;
  name: string;
  path: string;
  resolved_path: string | null;
  scope: Scope;
  workspace_id: string | null;
  agents: Agent[];
  kind: string;
  status: string;
  owner: string;
  library_id: string | null;
  diagnostics: string[];
};
type Deployment = {
  id: string;
  library_id: string;
  library_root: string | null;
  package_name: string;
  display_name?: string;
  package_hash: string;
  scope: Scope;
  workspace_id: string | null;
  scope_root: string;
  target: string;
  agents: Agent[];
  visible_to: Agent[];
  status: string;
  diagnostics: string[];
  previous_hash: string | null;
  operation_id: string;
  updated_at: string;
  hash_algorithm?: string;
  base_snapshot_hash?: string;
  origin?: "agentkib" | "adopted" | "legacy-unknown";
  adopted_at?: string;
  adoption_operation_id?: string;
};
export type SkillSyncLocation = {
  target: Target;
  destination: string;
  receipt_file: string;
  receipt: Deployment | null;
  target_hash: string | null;
  target_identity?: string | null;
  owner_key: string;
  target_key: string;
  observation_id?: string;
};
type SyncLocationParams = { deployment_id?: string; observation_id?: string };
type SyncLocationRead = {
  targets: readonly Target[];
  receipts: Deployment[];
  inventory?: { observations: Observation[]; warnings: string[] };
};
type SyncMutation = "write" | "adopt" | "baseline" | "detach" | "bind";
type DeploymentOperation = "deploy" | "update" | "undeploy" | "rollback";
type PlannedTarget = {
  target: Target;
  agents: Agent[];
  visibleTo: Agent[];
  destination: string;
  displayName: string;
  receiptFile: string;
  receipt: Deployment | null;
  expectedHash: string | null;
  source: string | null;
  sourceHash: string | null;
  incomingHash: string | null;
  backup: string | null;
  added: string[];
  modified: string[];
  removed: string[];
  conflicts: string[];
  syncMutation?: SyncMutation;
  expectedLibraryLock?: string;
  expectedIdentity?: string | null;
};
type PreparedDeployment = {
  token: string;
  operation: DeploymentOperation;
  libraryId: string | null;
  expires: number;
  targets: PlannedTarget[];
};
type Journal = {
  schema_version: 1 | 2;
  operation_id: string;
  operation: DeploymentOperation;
  target_id: string;
  destination: string;
  receipt_file: string;
  backup: string | null;
  prior_receipt: Deployment | null;
  next_receipt: Deployment;
  expected_hash: string | null;
  incoming_hash: string | null;
  state: "prepared" | "activated" | "receipt-written";
  metadata_only?: boolean;
  expected_identity?: string | null;
};

const AGENTS: Agent[] = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
];
const MAX_SKILL_SCAN_ENTRIES = 1_024;
const MAX_SKILL_SCAN_DEPTH = 32;
const PERSONAL_ROOTS: Record<Agent, string> = {
  codex: ".agents/skills",
  "claude-code": ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".config/opencode/skills",
  "open-claw": ".openclaw/skills",
  hermes: ".hermes/skills",
  "grok-build": ".grok/skills",
  antigravity: ".gemini/antigravity-cli/skills",
  "deepseek-harness": ".dsh/skills",
};
const PROJECT_ROOTS: Record<Agent, string> = {
  codex: ".agents/skills",
  "claude-code": ".claude/skills",
  cursor: ".cursor/skills",
  opencode: ".opencode/skills",
  "open-claw": "skills",
  hermes: ".hermes/skills",
  "grok-build": ".grok/skills",
  antigravity: ".agents/skills",
  "deepseek-harness": "skills",
};

function stableId(prefix: string, value: string) {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function inside(file: string, root: string) {
  const relative = path.relative(root, file);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function physicalPathIdentity(value: string, preserveFinalEntry = false) {
  let current = path.resolve(value);
  const suffix = preserveFinalEntry ? [path.basename(current)] : [];
  if (preserveFinalEntry) current = path.dirname(current);
  while (true) {
    try {
      current = realpathSync.native(current);
      break;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
  const identity = path.join(current, ...suffix);
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

function samePath(left: string, right: string) {
  return physicalPathIdentity(left) === physicalPathIdentity(right);
}

function sameEntryPath(left: string, right: string) {
  return physicalPathIdentity(left, true) === physicalPathIdentity(right, true);
}

function physicalPathKey(value: string) {
  return physicalPathIdentity(value);
}

function groupForTarget(groups: Map<string, Target[]>, target: Target): Target[] {
  return groups.get(physicalPathKey(target.root)) ?? [target];
}

function wildcardMatches(pattern: string, value: string): boolean {
  if (pattern.endsWith(" *") && wildcardMatches(pattern.slice(0, -2), value)) return true;
  let expression = "^";
  for (const character of pattern) {
    expression +=
      character === "*"
        ? ".*"
        : character === "?"
          ? "."
          : character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  expression += "$";
  try {
    return new RegExp(expression, process.platform === "win32" ? "i" : "").test(value);
  } catch {
    return false;
  }
}

async function exists(file: string) {
  return fs.lstat(file).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

export class SkillManager {
  readonly #root: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #workspaces: () => unknown[];
  readonly #prepared = new Map<string, PreparedDeployment>();
  #writing = false;
  #beforeRollback?: (deploymentId: string) => Promise<void>;

  constructor(root: string, env: NodeJS.ProcessEnv, workspaces: () => unknown[]) {
    this.#root = root;
    this.#env = env;
    this.#workspaces = workspaces;
  }

  setSyncPolicyHooks(hooks: { beforeRollback: (deploymentId: string) => Promise<void> }) {
    this.#beforeRollback = hooks.beforeRollback;
  }

  #workspaceList(): Workspace[] {
    return this.#workspaces().flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const row = value as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.path === "string"
        ? [{ id: row.id, path: row.path }]
        : [];
    });
  }

  #home() {
    return this.#env.HOME ?? this.#env.USERPROFILE ?? os.homedir();
  }

  #expand(value: string): string | null {
    let expanded = value
      .trim()
      .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => this.#env[key] ?? whole);
    if (expanded.includes("${")) return null;
    if (expanded === "~") expanded = this.#home();
    else if (expanded.startsWith("~/")) expanded = path.join(this.#home(), expanded.slice(2));
    return path.isAbsolute(expanded) ? path.normalize(expanded) : null;
  }

  #configured(name: string, fallback: string): { path: string; invalid: boolean } {
    const value = this.#env[name];
    if (!value) return { path: fallback, invalid: false };
    return { path: this.#expand(value) ?? fallback, invalid: this.#expand(value) === null };
  }

  #agentHome(agent: Agent): { path: string; invalid: boolean } {
    const home = this.#home();
    if (agent === "claude-code") {
      // The value is taken literally (a settings file needs an absolute path): `~` and `${VAR}`
      // are not expanded, unlike the other homes below.
      const config = resolveClaudeConfig(this.#env, home);
      return { path: config.dir, invalid: config.invalid !== undefined };
    }
    if (agent === "opencode") {
      const xdg = this.#configured("XDG_CONFIG_HOME", path.join(home, ".config"));
      return { path: path.join(xdg.path, "opencode"), invalid: xdg.invalid };
    }
    if (agent === "open-claw") {
      const root = this.#configured("OPENCLAW_HOME", home);
      const profile = this.#env.OPENCLAW_PROFILE?.trim();
      const validProfile =
        profile && !/^default$/i.test(profile) && /^[A-Za-z0-9_-]+$/.test(profile);
      const state = this.#configured(
        "OPENCLAW_STATE_DIR",
        path.join(root.path, validProfile ? `.openclaw-${profile}` : ".openclaw"),
      );
      return {
        path: state.path,
        invalid:
          root.invalid ||
          state.invalid ||
          Boolean(profile && !validProfile && !/^default$/i.test(profile)),
      };
    }
    if (agent === "hermes") return this.#configured("HERMES_HOME", path.join(home, ".hermes"));
    if (agent === "grok-build") return this.#configured("GROK_HOME", path.join(home, ".grok"));
    if (agent === "deepseek-harness") return this.#configured("DSH_HOME", path.join(home, ".dsh"));
    return { path: path.join(home, PERSONAL_ROOTS[agent], ".."), invalid: false };
  }

  async #openClawWorkspaceEntries(): Promise<Array<{ id: string; workspace: string }>> {
    const state = this.#agentHome("open-claw");
    if (state.invalid) return [];
    const configured = this.#configured(
      "OPENCLAW_CONFIG_PATH",
      path.join(state.path, "openclaw.json"),
    );
    if (configured.invalid) return [];
    const file = configured.path;
    const info = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && (!info.isFile() || info.size > 1024 * 1024))
      throw new Error("OpenClaw configuration is not a readable file");
    const config = info
      ? (JSON5.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>)
      : {};
    const values: Record<string, string> = {};
    const dotenv = path.join(state.path, ".env");
    const envInfo = await fs.stat(dotenv).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (envInfo) {
      if (!envInfo.isFile() || envInfo.size > 1024 * 1024)
        throw new Error("OpenClaw environment file is not readable");
      for (const line of (await fs.readFile(dotenv, "utf8")).split(/\r?\n/)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
      }
    }
    const configEnv =
      config.env && typeof config.env === "object"
        ? (config.env as Record<string, unknown>).vars
        : null;
    if (configEnv && typeof configEnv === "object") {
      for (const [key, value] of Object.entries(configEnv)) {
        if (typeof value === "string" && values[key] === undefined) values[key] = value;
      }
    }
    Object.assign(
      values,
      Object.fromEntries(Object.entries(this.#env).filter(([, v]) => v !== undefined)),
    );
    const resolveWorkspace = (input: unknown): string | null => {
      if (typeof input !== "string") return null;
      let missing = false;
      let value = input.trim().replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
        if (values[key] === undefined) missing = true;
        return values[key] ?? "";
      });
      if (missing) return null;
      if (value === "~") value = this.#home();
      else if (value.startsWith("~/")) value = path.join(this.#home(), value.slice(2));
      return path.isAbsolute(value) ? path.normalize(value) : null;
    };
    const agents =
      config.agents && typeof config.agents === "object"
        ? (config.agents as Record<string, unknown>)
        : {};
    const defaults =
      agents.defaults && typeof agents.defaults === "object"
        ? (agents.defaults as Record<string, unknown>)
        : {};
    const base =
      defaults.workspace === undefined
        ? values.OPENCLAW_WORKSPACE_DIR === undefined
          ? path.join(state.path, "workspace")
          : resolveWorkspace(values.OPENCLAW_WORKSPACE_DIR)
        : resolveWorkspace(defaults.workspace);
    if (!base) return [];
    const roots: Array<{ id: string; workspace: string }> = [];
    if (agents.entries !== undefined) {
      if (!agents.entries || typeof agents.entries !== "object" || Array.isArray(agents.entries))
        return [];
      const entries = Object.entries(agents.entries);
      const legacyDefault = entries.find(([, entry]) =>
        entry && typeof entry === "object"
          ? (entry as Record<string, unknown>).default === true
          : false,
      )?.[0];
      for (const [id, entry] of entries) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !entry || typeof entry !== "object")
          return [];
        const workspace = (entry as Record<string, unknown>).workspace;
        const resolved =
          workspace !== undefined
            ? resolveWorkspace(workspace)
            : entries.length === 1 || legacyDefault === id
              ? base
              : defaults.workspace !== undefined
                ? path.join(base, id.toLowerCase())
                : path.join(state.path, `workspace-${id.toLowerCase()}`);
        if (!resolved) return [];
        roots.push({ id, workspace: resolved });
      }
    } else {
      if (agents.list !== undefined) {
        if (!Array.isArray(agents.list)) return [];
        for (const [index, entry] of agents.list.entries()) {
          if (!entry || typeof entry !== "object") return [];
          const workspace = (entry as Record<string, unknown>).workspace;
          const resolved = workspace === undefined ? base : resolveWorkspace(workspace);
          if (!resolved) return [];
          const id = (entry as Record<string, unknown>).id;
          roots.push({ id: typeof id === "string" ? id : String(index), workspace: resolved });
        }
      } else roots.push({ id: "default", workspace: base });
    }
    return roots;
  }

  async #openClawWorkspaces(): Promise<string[]> {
    return [...new Set((await this.#openClawWorkspaceEntries()).map((entry) => entry.workspace))];
  }

  async #hermesHomes(): Promise<string[]> {
    const base = this.#agentHome("hermes");
    const profiles = await fs
      .readdir(path.join(base.path, "profiles"), { withFileTypes: true })
      .catch(() => []);
    const homes = [base.path];
    for (const entry of profiles) {
      if (!entry.isDirectory()) continue;
      const home = path.join(base.path, "profiles", entry.name);
      const markers = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];
      const found = await Promise.any(
        markers.map(async (marker) => {
          if (await exists(path.join(home, marker))) return true;
          throw new Error("missing");
        }),
      ).catch(() => false);
      if (found) homes.push(home);
    }
    return [...new Set(homes)];
  }

  async #hermesExternalDirs(): Promise<string[]> {
    const roots: string[] = [];
    for (const home of await this.#hermesHomes()) {
      const configPath = path.join(home, "config.yaml");
      const info = await fs.stat(configPath).catch(() => null);
      if (!info || !info.isFile() || info.size > 1024 * 1024) continue;
      const config = parseYaml(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
      const skills =
        config.skills && typeof config.skills === "object"
          ? (config.skills as Record<string, unknown>)
          : {};
      const entries = Array.isArray(skills.external_dirs) ? skills.external_dirs : [];
      for (const value of entries)
        if (typeof value === "string") {
          const resolved = this.#expand(value);
          if (resolved) roots.push(resolved);
        }
      if (typeof skills.create_dir === "string") {
        const resolved =
          this.#expand(skills.create_dir) ??
          (path.isAbsolute(skills.create_dir)
            ? path.normalize(skills.create_dir)
            : path.resolve(home, skills.create_dir));
        roots.push(resolved);
      }
    }
    return [...new Set(roots)];
  }

  async #hermesProjectConditions(workspace: string): Promise<string[]> {
    let gitRoot: string | null = null;
    for (let current = path.resolve(workspace); ; current = path.dirname(current)) {
      if (await exists(path.join(current, ".git"))) {
        gitRoot = current;
        break;
      }
      if (path.dirname(current) === current) break;
    }
    if (!gitRoot)
      return ["Hermes: project skills are not loaded because this project has no Git root"];
    const conditions: string[] = [];
    if (!samePath(gitRoot, workspace))
      conditions.push(
        `Hermes: native project discovery reads the nearest Git root ${gitRoot}, not this nested project directory`,
      );
    for (const home of await this.#hermesHomes()) {
      const label = `Hermes profile ${home}`;
      const configPath = path.join(home, "config.yaml");
      try {
        const info = await fs.stat(configPath);
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error("unreadable config");
        const config = parseYaml(await fs.readFile(configPath, "utf8")) as Record<string, unknown>;
        const skills =
          config.skills && typeof config.skills === "object"
            ? (config.skills as Record<string, unknown>)
            : {};
        if (skills.project_discovery === false) {
          conditions.push(`${label}: project discovery is disabled in config.yaml`);
          continue;
        }
        const trusted =
          Array.isArray(skills.trusted_project_dirs) &&
          skills.trusted_project_dirs.some((item) => {
            if (typeof item !== "string") return false;
            const resolved = this.#expand(item);
            return resolved ? samePath(resolved, gitRoot!) : false;
          });
        conditions.push(
          trusted
            ? `${label}: Git root is trusted; native content quarantine and session refresh still apply`
            : `${label}: Git root is not trusted; run hermes skills trust yourself before native loading`,
        );
      } catch {
        conditions.push(`${label}: project trust is unknown because config.yaml could not be read`);
      }
    }
    return conditions;
  }

  async #openClawRestrictions(name: string, workspacePath: string | null) {
    const state = this.#agentHome("open-claw");
    const configPath = this.#configured(
      "OPENCLAW_CONFIG_PATH",
      path.join(state.path, "openclaw.json"),
    );
    try {
      if (state.invalid || configPath.invalid) throw new Error("invalid config location");
      const info = await fs.stat(configPath.path);
      if (!info.isFile() || info.size > 1024 * 1024) throw new Error("invalid config file");
      const config = JSON5.parse(await fs.readFile(configPath.path, "utf8")) as Record<
        string,
        unknown
      >;
      const skillsConfig =
        config.skills && typeof config.skills === "object"
          ? (config.skills as Record<string, unknown>)
          : {};
      const entriesConfig =
        skillsConfig.entries && typeof skillsConfig.entries === "object"
          ? (skillsConfig.entries as Record<string, unknown>)
          : {};
      const skillEntry = entriesConfig[name];
      if (
        skillEntry &&
        typeof skillEntry === "object" &&
        (skillEntry as Record<string, unknown>).enabled === false
      )
        return {
          restricted: true,
          unknown: false,
          diagnostics: [
            "OpenClaw: this Skill name is disabled by skills.entries in openclaw.json; metadata skillKey aliases may differ",
          ],
        };
      const agents =
        config.agents && typeof config.agents === "object"
          ? (config.agents as Record<string, unknown>)
          : {};
      const defaults =
        agents.defaults && typeof agents.defaults === "object"
          ? (agents.defaults as Record<string, unknown>)
          : {};
      const defaultSkills = Array.isArray(defaults.skills)
        ? defaults.skills.filter((item): item is string => typeof item === "string")
        : null;
      const entries: Array<[string, unknown]> =
        agents.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries)
          ? Object.entries(agents.entries)
          : Array.isArray(agents.list)
            ? agents.list.map((item, index) => [
                item &&
                typeof item === "object" &&
                typeof (item as Record<string, unknown>).id === "string"
                  ? String((item as Record<string, unknown>).id)
                  : String(index),
                item,
              ])
            : [];
      let matching: Array<[string, unknown]> = [];
      if (workspacePath) {
        const roots = await this.#openClawWorkspaceEntries();
        matching = entries.filter(([id]) =>
          roots.some((entry) => entry.id === id && samePath(entry.workspace, workspacePath)),
        );
        if (!entries.length && roots.some((entry) => samePath(entry.workspace, workspacePath)))
          matching = [["default", defaults]];
      } else if (entries.length) matching = entries;
      if (!matching.length && workspacePath)
        return {
          restricted: true,
          unknown: false,
          diagnostics: [
            "OpenClaw: this project has no configured native Agent workspace, so its Skill files are not discoverable",
          ],
        };
      if (!matching.length) matching = [["default", defaults]];
      const diagnostics = matching.map(([id, value]) => {
        const item = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const allowlist = Array.isArray(item.skills)
          ? item.skills.filter((skill): skill is string => typeof skill === "string")
          : defaultSkills;
        const allowed = allowlist === null || allowlist.includes(name);
        return `OpenClaw Agent ${id}: ${allowed ? "allowed" : "excluded"} by its effective skills allowlist (per-Agent settings replace defaults)`;
      });
      const restricted = diagnostics.every((line) =>
        line.includes(": excluded by its effective skills allowlist"),
      );
      return { restricted, unknown: false, diagnostics };
    } catch {
      return {
        restricted: false,
        unknown: true,
        diagnostics: [
          "OpenClaw: native enablement is unknown because workspace or skills configuration could not be resolved",
        ],
      };
    }
  }

  async #openClawExtraDirs(): Promise<string[]> {
    const state = this.#agentHome("open-claw");
    const configPath = this.#configured(
      "OPENCLAW_CONFIG_PATH",
      path.join(state.path, "openclaw.json"),
    );
    if (state.invalid || configPath.invalid) return [];
    try {
      const info = await fs.stat(configPath.path);
      if (!info.isFile() || info.size > 1024 * 1024) return [];
      const config = JSON5.parse(await fs.readFile(configPath.path, "utf8")) as Record<
        string,
        unknown
      >;
      const skills =
        config.skills && typeof config.skills === "object"
          ? (config.skills as Record<string, unknown>)
          : {};
      const load =
        skills.load && typeof skills.load === "object"
          ? (skills.load as Record<string, unknown>)
          : {};
      if (!Array.isArray(load.extraDirs)) return [];
      const env =
        config.env && typeof config.env === "object" ? (config.env as Record<string, unknown>) : {};
      const vars =
        env.vars && typeof env.vars === "object" ? (env.vars as Record<string, unknown>) : {};
      const values = {
        ...Object.fromEntries(
          Object.entries(vars).filter(([, value]) => typeof value === "string"),
        ),
        ...this.#env,
      } as Record<string, string | undefined>;
      return load.extraDirs.flatMap((value) => {
        if (typeof value !== "string") return [];
        let missing = false;
        const expanded = value
          .trim()
          .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
            if (values[key] === undefined) missing = true;
            return values[key] ?? "";
          });
        if (missing) return [];
        const resolved =
          this.#expand(expanded) ?? (path.isAbsolute(expanded) ? path.normalize(expanded) : null);
        return resolved ? [resolved] : [];
      });
    } catch {
      return [];
    }
  }

  async #toml(file: string): Promise<Record<string, unknown>> {
    const info = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return {};
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error("Native agent config is not readable");
    return parseToml(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  }

  async #codexRestriction(observation: Observation) {
    const home = this.#configured("CODEX_HOME", path.join(this.#home(), ".codex"));
    try {
      if (home.invalid) throw new Error("invalid Codex home");
      const config = await this.#toml(path.join(home.path, "config.toml"));
      const skills =
        config.skills && typeof config.skills === "object"
          ? (config.skills as Record<string, unknown>)
          : {};
      const entries = Array.isArray(skills.config) ? skills.config : [];
      const disabled = entries.some((value) => {
        if (!value || typeof value !== "object") return false;
        const item = value as Record<string, unknown>;
        if (item.enabled !== false || typeof item.path !== "string") return false;
        const resolved = this.#expand(item.path);
        return (
          resolved !== null &&
          (samePath(resolved, observation.path) ||
            samePath(resolved, path.join(observation.path, "SKILL.md")))
        );
      });
      return {
        restricted: disabled,
        unknown: false,
        diagnostics: disabled
          ? ["Codex: this Skill is disabled by skills.config in config.toml"]
          : [],
      };
    } catch {
      return {
        restricted: false,
        unknown: true,
        diagnostics: ["Codex: native enablement is unknown because config.toml could not be read"],
      };
    }
  }

  async #grokRestriction(observation: Observation, workspacePath: string | null) {
    const root = this.#agentHome("grok-build");
    const files = [
      path.join(root.path, "config.toml"),
      ...(workspacePath ? [path.join(workspacePath, ".grok/config.toml")] : []),
    ];
    let disabled = false;
    const diagnostics: string[] = [];
    let unknown = false;
    for (const file of files) {
      try {
        const config = await this.#toml(file);
        const skills =
          config.skills && typeof config.skills === "object"
            ? (config.skills as Record<string, unknown>)
            : {};
        if (Array.isArray(skills.disabled)) disabled ||= skills.disabled.includes(observation.name);
        if (Array.isArray(skills.ignore)) {
          for (const value of skills.ignore) {
            if (typeof value !== "string") continue;
            const configured =
              this.#expand(value) ??
              (workspacePath && !path.isAbsolute(value)
                ? path.resolve(workspacePath, value)
                : null);
            if (configured && inside(observation.path, configured)) disabled = true;
          }
        }
        for (const [name, relative] of [
          ["claude", ".claude"],
          ["cursor", ".cursor"],
        ] as const) {
          const compat =
            config.compat && typeof config.compat === "object"
              ? (config.compat as Record<string, unknown>)
              : {};
          const item =
            compat[name] && typeof compat[name] === "object"
              ? (compat[name] as Record<string, unknown>)
              : {};
          const base = workspacePath ?? this.#home();
          if (inside(observation.path, path.join(base, relative)) && item.skills === false) {
            disabled = true;
            diagnostics.push(`Grok: compat.${name}.skills is disabled`);
          }
        }
      } catch {
        unknown = true;
      }
    }
    for (const [key, relative] of [
      ["GROK_CLAUDE_SKILLS_ENABLED", ".claude"],
      ["GROK_CURSOR_SKILLS_ENABLED", ".cursor"],
    ] as const) {
      const value = this.#env[key]?.toLowerCase();
      if (
        inside(observation.path, path.join(workspacePath ?? this.#home(), relative)) &&
        (value === "false" || value === "0")
      )
        disabled = true;
    }
    if (disabled)
      diagnostics.push(
        "Grok: native skills.disabled, skills.ignore or compatibility settings restrict this Skill",
      );
    if (unknown)
      diagnostics.push("Grok: native enablement is unknown because config.toml could not be read");
    return { restricted: disabled, unknown, diagnostics };
  }

  async #openCodePermission(name: string, workspacePath: string | null) {
    const home = this.#agentHome("opencode");
    const files = [
      path.join(home.path, "config.json"),
      path.join(home.path, "opencode.json"),
      path.join(home.path, "opencode.jsonc"),
    ];
    const resolveConfig = (value: string) =>
      this.#expand(value) ?? (workspacePath ? path.resolve(workspacePath, value) : null);
    if (this.#env.OPENCODE_CONFIG) {
      const configured = resolveConfig(this.#env.OPENCODE_CONFIG);
      if (!configured) return { action: null, unknown: true };
      files.push(configured);
    }
    const projectRoots: string[] = [];
    if (
      workspacePath &&
      !["1", "true"].includes(this.#env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? "")
    ) {
      for (let current = path.resolve(workspacePath); ; current = path.dirname(current)) {
        projectRoots.push(current);
        if ((await exists(path.join(current, ".git"))) || path.dirname(current) === current) break;
      }
      for (const root of projectRoots.reverse())
        files.push(path.join(root, "opencode.json"), path.join(root, "opencode.jsonc"));
    }
    const directories = [
      home.path,
      ...projectRoots.map((root) => path.join(root, ".opencode")),
      path.join(this.#home(), ".opencode"),
    ];
    if (this.#env.OPENCODE_CONFIG_DIR) {
      const configured = resolveConfig(this.#env.OPENCODE_CONFIG_DIR);
      if (!configured) return { action: null, unknown: true };
      directories.push(configured);
    }
    for (const directory of directories)
      files.push(path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc"));
    const uniqueFiles = [...new Set(files)];
    let action: "allow" | "ask" | "deny" | null = null;
    const applyRule = (rule: unknown, namePattern = "*") => {
      if (
        typeof rule === "string" &&
        ["allow", "ask", "deny"].includes(rule) &&
        wildcardMatches(namePattern, name)
      ) {
        action = rule as "allow" | "ask" | "deny";
      } else if (rule && typeof rule === "object" && !Array.isArray(rule)) {
        for (const [pattern, value] of Object.entries(rule))
          if (
            typeof value === "string" &&
            ["allow", "ask", "deny"].includes(value) &&
            wildcardMatches(pattern, name)
          )
            action = value as "allow" | "ask" | "deny";
      }
    };
    let unknown = false;
    for (const file of uniqueFiles) {
      try {
        const info = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!info) continue;
        if (!info.isFile() || info.size > 1024 * 1024) throw new Error("invalid config");
        const config = JSON5.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
        const permission = config.permission;
        if (typeof permission === "string") applyRule(permission);
        else if (permission && typeof permission === "object") {
          const skill = (permission as Record<string, unknown>).skill;
          applyRule(skill);
        }
      } catch {
        unknown = true;
      }
    }
    for (const [key, direct] of [
      ["OPENCODE_CONFIG_CONTENT", false],
      ["OPENCODE_PERMISSION", true],
    ] as const) {
      const content = this.#env[key];
      if (!content) continue;
      try {
        if (Buffer.byteLength(content) > 1024 * 1024) throw new Error("oversized config");
        const parsed = JSON5.parse(content) as unknown;
        if (!direct && parsed && typeof parsed === "object") {
          const permission = (parsed as Record<string, unknown>).permission;
          applyRule(
            typeof permission === "object"
              ? (permission as Record<string, unknown>)?.skill
              : permission,
          );
        } else applyRule(parsed);
      } catch {
        unknown = true;
      }
    }
    return { action, unknown };
  }

  async #openCodeExtraRoots(workspacePath: string): Promise<string[]> {
    if (["1", "true"].includes(this.#env.OPENCODE_DISABLE_EXTERNAL_SKILLS?.toLowerCase() ?? ""))
      return [];
    const home = this.#agentHome("opencode").path;
    const disableProject = ["1", "true"].includes(
      this.#env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase() ?? "",
    );
    const files = [
      path.join(home, "config.json"),
      path.join(home, "opencode.json"),
      path.join(home, "opencode.jsonc"),
    ];
    const resolveConfig = (value: string) =>
      this.#expand(value) ?? path.resolve(workspacePath, value);
    if (this.#env.OPENCODE_CONFIG) files.push(resolveConfig(this.#env.OPENCODE_CONFIG));
    const projectRoots: string[] = [];
    for (let current = path.resolve(workspacePath); ; current = path.dirname(current)) {
      projectRoots.push(current);
      if ((await exists(path.join(current, ".git"))) || path.dirname(current) === current) break;
    }
    if (!disableProject)
      for (const root of projectRoots.reverse())
        files.push(path.join(root, "opencode.json"), path.join(root, "opencode.jsonc"));
    const directories = [
      home,
      ...(disableProject ? [] : projectRoots.map((root) => path.join(root, ".opencode"))),
      path.join(this.#home(), ".opencode"),
    ];
    if (this.#env.OPENCODE_CONFIG_DIR)
      directories.push(resolveConfig(this.#env.OPENCODE_CONFIG_DIR));
    for (const directory of directories) {
      files.push(path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc"));
    }
    const roots = new Set<string>([
      ...directories.flatMap((directory) => [
        path.join(directory, "skill"),
        path.join(directory, "skills"),
      ]),
    ]);
    let configuredPaths: unknown[] | null = null;
    for (const file of new Set(files)) {
      const info = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!info) continue;
      if (!info.isFile() || info.size > 1024 * 1024) continue;
      try {
        const config = JSON5.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
        const skills =
          config.skills && typeof config.skills === "object"
            ? (config.skills as Record<string, unknown>)
            : {};
        if (Array.isArray(skills.paths)) configuredPaths = skills.paths;
      } catch {
        continue;
      }
    }
    if (this.#env.OPENCODE_CONFIG_CONTENT) {
      try {
        const config = JSON5.parse(this.#env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>;
        const skills =
          config.skills && typeof config.skills === "object"
            ? (config.skills as Record<string, unknown>)
            : {};
        if (Array.isArray(skills.paths)) configuredPaths = skills.paths;
      } catch {}
    }
    for (const value of configuredPaths ?? []) {
      if (typeof value !== "string") continue;
      let unresolved = false;
      const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => {
        const replacement = this.#env[key];
        if (replacement === undefined) unresolved = true;
        return replacement ?? "";
      });
      if (unresolved) continue;
      const resolved = this.#expand(expanded) ?? path.resolve(workspacePath, expanded);
      roots.add(resolved);
    }
    return [...roots];
  }

  async targets(): Promise<Target[]> {
    const home = this.#home();
    const targets: Target[] = [];
    const openClawWorkspaces = await this.#openClawWorkspaces().catch(() => []);
    for (const agent of AGENTS) {
      const configured = this.#agentHome(agent);
      const root =
        agent === "codex"
          ? path.join(home, ".agents", "skills")
          : path.join(configured.path, "skills");
      const personal = this.#target(agent, "personal", null, root, path.dirname(root));
      if (
        agent === "codex" &&
        (await this.#hermesExternalDirs()).some((item) => samePath(item, root))
      )
        personal.visible_to.push("hermes");
      if (configured.invalid) {
        personal.writable = false;
        personal.reason = "Native Skill home environment override is invalid";
      }
      targets.push(personal);
      if (agent === "hermes") {
        const profiles = path.join(configured.path, "profiles");
        const entries = await fs.readdir(profiles, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const directory = path.join(profiles, entry.name);
          const markers = [
            "config.yaml",
            ".env",
            "SOUL.md",
            "profile.yaml",
            "auth.json",
            "state.db",
          ];
          if (
            !(await Promise.any(
              markers.map(async (marker) => {
                if (await exists(path.join(directory, marker))) return true;
                throw new Error("missing");
              }),
            ).catch(() => false))
          )
            continue;
          const profile = this.#target(
            "hermes",
            "personal",
            null,
            path.join(directory, "skills"),
            directory,
          );
          profile.profile = entry.name;
          targets.push(profile);
        }
      }
    }
    for (const workspace of this.#workspaceList()) {
      for (const agent of AGENTS) {
        const root = path.join(workspace.path, PROJECT_ROOTS[agent]);
        const target = this.#target(agent, "workspace", workspace.id, root, workspace.path);
        if (agent === "hermes")
          target.conditions.push(...(await this.#hermesProjectConditions(workspace.path)));
        if (
          !(await fs.stat(workspace.path).then(
            (info) => info.isDirectory(),
            () => false,
          ))
        ) {
          target.writable = false;
          target.reason = "Workspace is missing or is not a directory";
        }
        if (
          targets.some(
            (personal) =>
              personal.scope === "personal" &&
              (inside(root, personal.root) || inside(personal.root, root)),
          )
        ) {
          target.writable = false;
          target.reason = "Project location overlaps a personal Skill directory";
        }
        if (
          agent === "open-claw" &&
          !openClawWorkspaces.some((item) => samePath(item, workspace.path))
        ) {
          target.writable = false;
          target.reason =
            "OpenClaw project deployment requires a verified native workspace configuration";
        }
        targets.push(target);
      }
    }
    for (const target of targets) {
      for (
        let current = target.root;
        inside(current, target.scope_root);
        current = path.dirname(current)
      ) {
        try {
          const metadata = await fs.lstat(current);
          if (isReparseOrSymlink(current, metadata) || !metadata.isDirectory()) {
            target.writable = false;
            target.reason = "Skill target contains a symbolic link or non-directory path component";
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            target.writable = false;
            target.reason = "Skill target path could not be verified";
            break;
          }
        }
        if (samePath(current, target.scope_root)) break;
      }
    }
    return targets.sort((left, right) => left.id.localeCompare(right.id));
  }

  #target(
    agent: Agent,
    scope: Scope,
    workspaceId: string | null,
    root: string,
    scopeRoot: string,
  ): Target {
    const visibleTo: Agent[] =
      agent === "codex"
        ? [
            "codex",
            "cursor",
            "opencode",
            "open-claw",
            "hermes",
            "grok-build",
            "antigravity",
            "deepseek-harness",
          ]
        : agent === "claude-code"
          ? ["claude-code", "cursor", "opencode", "grok-build"]
          : agent === "cursor"
            ? ["cursor", "grok-build"]
            : [agent];
    const target: Target = {
      id: stableId(
        "target",
        `${agent}:${scope}:${workspaceId ?? "personal"}:${path.resolve(root)}`,
      ),
      agent,
      scope,
      workspace_id: workspaceId,
      profile: null,
      root,
      scope_root: scopeRoot,
      visible_to: visibleTo,
      writable: true,
      reason: null,
      conditions: ["Files are copied; running agents may need to reload their skills"],
    };
    const enabled = (key: string) => ["1", "true"].includes(this.#env[key]?.toLowerCase() ?? "");
    if (
      enabled("OPENCODE_DISABLE_EXTERNAL_SKILLS") ||
      (agent === "claude-code" &&
        (enabled("OPENCODE_DISABLE_CLAUDE_CODE") ||
          enabled("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"))) ||
      (scope === "workspace" && agent === "opencode" && enabled("OPENCODE_DISABLE_PROJECT_CONFIG"))
    ) {
      target.visible_to = target.visible_to.filter((item) => item !== "opencode");
      target.conditions.push("OpenCode configuration may disable this Skill source");
    }
    if (
      agent === "claude-code" &&
      scope === "personal" &&
      isClaudeConfigDirSet(this.#env) &&
      !samePath(root, path.join(this.#home(), ".claude/skills"))
    )
      target.visible_to = target.visible_to.filter((item) => item !== "opencode");
    if (agent === "codex" && scope === "personal") {
      if (!samePath(this.#agentHome("open-claw").path, path.join(this.#home(), ".openclaw")))
        target.visible_to = target.visible_to.filter((item) => item !== "open-claw");
      target.visible_to = target.visible_to.filter((item) => item !== "hermes");
    }
    return target;
  }

  async #inventoryRoots(currentTargets: readonly Target[]): Promise<Target[]> {
    const targets = [...currentTargets];
    const home = this.#home();
    const extra: Array<{
      path: string;
      agents: Agent[];
      agent: Agent;
      workspaceId?: string;
      scopeRoot?: string;
    }> = [
      {
        path: path.join(this.#configured("CODEX_HOME", path.join(home, ".codex")).path, "skills"),
        agents: ["codex", "cursor"] as Agent[],
        agent: "codex" as Agent,
      },
      {
        path: path.join(home, ".gemini/config/skills"),
        agents: ["antigravity"] as Agent[],
        agent: "antigravity" as Agent,
      },
      {
        path: path.join(home, ".gemini/antigravity/skills"),
        agents: ["antigravity"] as Agent[],
        agent: "antigravity" as Agent,
      },
      {
        path: path.join(home, ".cc-switch/skills"),
        agents: [] as Agent[],
        agent: "codex" as Agent,
      },
      {
        path: path.join(this.#agentHome("deepseek-harness").path, "skills"),
        agents: ["deepseek-harness"] as Agent[],
        agent: "deepseek-harness" as Agent,
      },
      {
        path: path.join(home, ".opencode/skills"),
        agents: ["opencode"] as Agent[],
        agent: "opencode" as Agent,
      },
      {
        path: path.join(home, ".opencode/skill"),
        agents: ["opencode"] as Agent[],
        agent: "opencode" as Agent,
      },
    ];
    const opencodeClaudeSkillsDisabled = [
      "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS",
      "OPENCODE_DISABLE_CLAUDE_CODE",
    ].some((key) => ["1", "true"].includes(this.#env[key]?.toLowerCase() ?? ""));
    const defaultClaudeSkills = path.join(home, ".claude/skills");
    const configuredClaudeSkills = claudeConfigFiles(resolveClaudeConfig(this.#env, home)).skills;
    if (!opencodeClaudeSkillsDisabled && !samePath(defaultClaudeSkills, configuredClaudeSkills))
      extra.push({
        path: defaultClaudeSkills,
        agents: ["opencode"],
        agent: "opencode",
      });
    for (const root of await this.#hermesExternalDirs())
      extra.push({ path: root, agents: ["hermes"], agent: "hermes" });
    for (const root of await this.#openClawExtraDirs())
      extra.push({ path: root, agents: ["open-claw"], agent: "open-claw" });
    for (const workspace of this.#workspaceList()) {
      for (const root of await this.#openCodeExtraRoots(workspace.path))
        extra.push({
          path: root,
          agents: ["opencode"],
          agent: "opencode",
          workspaceId: workspace.id,
          scopeRoot: workspace.path,
        });
      let current = path.resolve(workspace.path);
      for (let depth = 0; depth < 64; depth++) {
        for (const relative of [
          ".claude/skills",
          ".agents/skills",
          ".opencode/skills",
          ".opencode/skill",
        ]) {
          if (relative === ".claude/skills" && opencodeClaudeSkillsDisabled) continue;
          extra.push({
            path: path.join(current, relative),
            agents: ["opencode"],
            agent: "opencode",
            workspaceId: workspace.id,
            scopeRoot: workspace.path,
          });
        }
        if ((await exists(path.join(current, ".git"))) || path.dirname(current) === current) break;
        current = path.dirname(current);
      }
    }
    for (const source of extra) {
      if (
        targets.some(
          (item) =>
            item.scope === (source.workspaceId ? "workspace" : "personal") &&
            item.workspace_id === (source.workspaceId ?? null) &&
            samePath(item.root, source.path),
        )
      )
        continue;
      const root = this.#target(
        source.agent,
        source.workspaceId ? "workspace" : "personal",
        source.workspaceId ?? null,
        source.path,
        source.scopeRoot ?? path.dirname(source.path),
      );
      root.visible_to = source.agents;
      root.writable = false;
      targets.push(root);
    }
    return targets;
  }

  async inventory(): Promise<{ observations: Observation[]; warnings: string[] }> {
    return this.#inventory(await this.targets());
  }

  async #inventory(targets: readonly Target[]) {
    const observations = new Map<string, Observation>();
    const warnings: string[] = [];
    for (const target of await this.#inventoryRoots(targets)) {
      const pathParts = path.resolve(target.root).split(path.sep);
      const compatibilityRoot =
        path.basename(target.root) === "skills" &&
        [".claude", ".agents"].includes(pathParts.at(-2) ?? "");
      const scanNested = compatibilityRoot && target.visible_to.includes("opencode");
      const candidates: Array<{
        name: string;
        path: string;
        resolvedPath: string | null;
        symbolicLink: boolean;
        nested: boolean;
      }> = [];
      let scannedEntries = 0;
      let limitReached = false;
      const visit = async (directory: string, depth: number, nested: boolean): Promise<void> => {
        const entries = await fs
          .readdir(directory, { withFileTypes: true })
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return [];
            warnings.push(`${directory}: ${error.message}`);
            return [];
          });
        for (const entry of entries) {
          if (++scannedEntries > MAX_SKILL_SCAN_ENTRIES) {
            limitReached = true;
            return;
          }
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const entryPath = path.join(directory, entry.name);
          const resolved = await fs.realpath(entryPath).catch(() => null);
          const hasEntrypoint = resolved ? await exists(path.join(resolved, "SKILL.md")) : false;
          if (scanNested && entry.isDirectory()) {
            if (depth >= MAX_SKILL_SCAN_DEPTH) {
              warnings.push(`${entryPath}: nested Skill scan depth limit reached`);
            } else {
              await visit(entryPath, depth + 1, true);
              if (limitReached) return;
            }
          }
          if (!hasEntrypoint && !entry.isSymbolicLink()) {
            continue;
          }
          candidates.push({
            name: entry.name,
            path: entryPath,
            resolvedPath: resolved,
            symbolicLink: entry.isSymbolicLink(),
            nested,
          });
        }
      };
      await visit(target.root, 0, false);
      if (limitReached) warnings.push(`${target.root}: Skill scan limit reached`);
      for (const candidate of candidates) {
        const { name, path: entryPath, resolvedPath: resolved, symbolicLink, nested } = candidate;
        const observationId = stableId(
          "observation",
          `${target.scope}:${target.workspace_id ?? ""}:${symbolicLink ? entryPath : resolved}`,
        );
        const existing = observations.get(observationId);
        if (existing) {
          existing.agents = [
            ...new Set([
              ...existing.agents,
              ...(nested ? ["opencode" as Agent] : target.visible_to),
            ]),
          ];
          continue;
        }
        observations.set(observationId, {
          id: observationId,
          name,
          path: entryPath,
          resolved_path: resolved,
          scope: target.scope,
          workspace_id: target.workspace_id,
          agents: nested ? ["opencode"] : [...target.visible_to],
          kind: symbolicLink ? "symlink" : "directory",
          status: !resolved ? "broken-link" : "observed",
          owner: "external",
          library_id: null,
          diagnostics: symbolicLink
            ? ["Linked Skill is read-only until copied to the library"]
            : [],
        });
      }
    }
    const output = [...observations.values()].sort((left, right) =>
      left.path.localeCompare(right.path),
    );
    for (const observation of output) {
      if (observation.scope !== "workspace" || !observation.agents.includes("hermes")) continue;
      const workspace = this.#workspaceList().find((item) => item.id === observation.workspace_id);
      if (!workspace) continue;
      const conditions = await this.#hermesProjectConditions(workspace.path);
      observation.diagnostics.push(...conditions);
      if (observation.agents.length !== 1 || observation.agents[0] !== "hermes") continue;
      if (
        conditions.some(
          (item) =>
            item.includes("no Git root") ||
            item.includes("not this nested project directory") ||
            item.includes("discovery is disabled"),
        )
      )
        observation.status = "native-restricted";
      else if (conditions.some((item) => item.includes("is unknown")))
        observation.status = "unverified";
      else if (conditions.length > 0 && conditions.every((item) => item.includes("not trusted")))
        observation.status = "pending-trust";
    }
    for (const observation of output) {
      if (!observation.agents.includes("open-claw")) continue;
      const workspace = observation.workspace_id
        ? (this.#workspaceList().find((item) => item.id === observation.workspace_id)?.path ?? null)
        : null;
      const state = await this.#openClawRestrictions(observation.name, workspace);
      observation.diagnostics.push(...state.diagnostics);
      if (observation.agents.length === 1 && observation.agents[0] === "open-claw") {
        if (state.restricted) observation.status = "native-restricted";
        else if (state.unknown) observation.status = "unverified";
      }
    }
    for (const observation of output) {
      const workspace = observation.workspace_id
        ? (this.#workspaceList().find((item) => item.id === observation.workspace_id)?.path ?? null)
        : null;
      if (observation.agents.includes("opencode")) {
        const permission = await this.#openCodePermission(observation.name, workspace);
        if (permission.action === "deny")
          observation.diagnostics.push("OpenCode: permission.skill is deny for this Skill");
        else if (permission.action === "ask")
          observation.diagnostics.push("OpenCode: permission.skill is ask for this Skill");
        if (permission.unknown)
          observation.diagnostics.push(
            "OpenCode: native enablement is unknown because a configuration file could not be read or parsed",
          );
        if (observation.agents.length === 1 && observation.agents[0] === "opencode") {
          if (permission.action === "deny") observation.status = "native-restricted";
          else if (permission.unknown) observation.status = "unverified";
        }
      }
      const states = await Promise.all([
        ...(observation.agents.includes("codex") ? [this.#codexRestriction(observation)] : []),
        ...(observation.agents.includes("grok-build")
          ? [this.#grokRestriction(observation, workspace)]
          : []),
      ]);
      for (const state of states) observation.diagnostics.push(...state.diagnostics);
      if (observation.agents.length === 1 && states.some((state) => state.restricted))
        observation.status = "native-restricted";
      else if (observation.agents.length === 1 && states.some((state) => state.unknown))
        observation.status = "unverified";
    }
    const unverifiedOwnership: string[] = [];
    for (const receipt of await this.#allReceipts(
      {
        tolerateUnavailableLibraries: true,
        tolerateUnreadableReceipts: true,
        warnings,
        unverified: unverifiedOwnership,
      },
      targets,
    )) {
      if (receipt.status === "inactive") continue;
      for (const observation of output) {
        if (!sameEntryPath(observation.path, receipt.target)) continue;
        observation.owner = "agentkib";
        observation.library_id =
          receipt.library_root && samePath(receipt.library_root, this.#root)
            ? receipt.library_id
            : null;
      }
    }
    if (unverifiedOwnership.length > 0) {
      const diagnostic = "Deployment ownership could not be verified";
      for (const observation of output) {
        if (observation.status !== "native-restricted") observation.status = "unverified";
        if (!observation.diagnostics.includes(diagnostic)) observation.diagnostics.push(diagnostic);
      }
    }
    const pendingTargets = [
      ...(await this.#allReservations(targets)).map((row) => ({ destination: row.target })),
      ...(await this.#syncRecoveryTargets(targets)),
    ];
    for (const observation of output)
      if (pendingTargets.some((row) => sameEntryPath(row.destination, observation.path))) {
        observation.status = "recovery-required";
        observation.diagnostics.push("Interrupted Skill synchronization requires recovery");
      }
    return { observations: output, warnings };
  }

  async detail(params: Record<string, unknown>) {
    const libraryId = typeof params.library_id === "string" ? params.library_id : null;
    const observationId = typeof params.observation_id === "string" ? params.observation_id : null;
    if (Boolean(libraryId) === Boolean(observationId))
      throw new Error("Choose exactly one library or observation ID");
    let root: string;
    let origin: string;
    if (libraryId) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(libraryId))
        throw new Error("Invalid Skill identity");
      origin = path.join(this.#root, "skills", libraryId);
      if ((await fs.lstat(origin)).isSymbolicLink())
        throw new Error("Library Skill must be a regular directory");
      root = await fs.realpath(origin);
    } else {
      const observation = (await this.inventory()).observations.find(
        (item) => item.id === observationId,
      );
      if (!observation?.resolved_path)
        throw new Error("Skill observation no longer exists; refresh the inventory");
      root = observation.resolved_path;
      origin = observation.path;
    }
    const packageInfo = await skillPackage(root);
    const previousRoot = libraryId ? path.join(this.#root, "backups/skills", libraryId) : null;
    const previous =
      previousRoot && (await exists(previousRoot)) ? await skillPackage(previousRoot) : null;
    const lock = libraryId ? await this.#lock() : null;
    const record = libraryId ? lock?.skills?.[libraryId] : null;
    const metadata = await this.#metadata(
      root,
      typeof record?.display_name === "string" ? record.display_name : path.basename(origin),
    );
    return {
      library_id: libraryId,
      observation_id: observationId,
      name: metadata.name,
      description: metadata.description,
      source: record?.source ?? null,
      local_source: record?.local_source ?? null,
      local_resolved_path: record?.local_resolved_path ?? null,
      files: packageInfo.files,
      previous_files: previous?.files ?? [],
      total_size: packageInfo.totalSize,
      diagnostics: packageInfo.diagnostics,
    };
  }

  async readDetailFile(params: Record<string, unknown>) {
    if (typeof params.path !== "string") throw new Error("Skill path is required");
    const detail = await this.detail(params);
    const root = detail.library_id
      ? path.join(this.#root, "skills", detail.library_id)
      : (await this.inventory()).observations.find((item) => item.id === detail.observation_id)
          ?.resolved_path;
    if (!root) throw new Error("Skill location is unavailable");
    const previous = detail.library_id
      ? path.join(this.#root, "backups/skills", detail.library_id)
      : null;
    return skillPreviewFile(
      previous && (await exists(previous)) ? previous : null,
      root,
      params.path,
    );
  }

  #receiptFile(scope: Scope, scopeRoot: string) {
    return scope === "personal"
      ? path.join(this.#root, "skill-deployments.json")
      : path.join(scopeRoot, ".agentkib", "skill-deployments.json");
  }

  #reservationFile(scope: Scope, scopeRoot: string) {
    return scope === "personal"
      ? path.join(this.#root, "skill-deployment-reservations.json")
      : path.join(scopeRoot, ".agentkib", "skill-deployment-reservations.json");
  }

  #libraryIndexFile(scope: Scope, scopeRoot: string) {
    return path.join(
      scopeRoot,
      ".agentkib",
      scope === "personal" ? "skill-personal-library-roots.json" : "skill-library-roots.json",
    );
  }

  async #readLibraries(scope: Scope, scopeRoot: string): Promise<string[]> {
    const file = this.#libraryIndexFile(scope, scopeRoot);
    const metadata = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return [];
    const parent = await fs.lstat(path.dirname(file));
    if (
      !metadata.isFile() ||
      isReparseOrSymlink(file, metadata) ||
      metadata.size > 1024 * 1024 ||
      !parent.isDirectory() ||
      isReparseOrSymlink(path.dirname(file), parent)
    )
      throw new Error(`Skill ownership index is unsafe: ${file}`);
    const index = JSON.parse(await fs.readFile(file, "utf8")) as {
      schema_version?: number;
      libraries?: unknown[];
    };
    if (
      index.schema_version !== 1 ||
      !Array.isArray(index.libraries) ||
      index.libraries.length > 128 ||
      index.libraries.some(
        (root) =>
          typeof root !== "string" || !path.isAbsolute(root) || root.split(path.sep).includes(".."),
      )
    )
      throw new Error(`Skill ownership index is invalid: ${file}`);
    return index.libraries as string[];
  }

  async #assertLibraryAvailable(libraryRoot: string) {
    const metadata = await fs.lstat(libraryRoot);
    if (!metadata.isDirectory() || isReparseOrSymlink(libraryRoot, metadata))
      throw new Error(`Associated Skill library is unavailable or unsafe: ${libraryRoot}`);
  }

  async #prepareLibraryRegistration(scope: Scope, scopeRoot: string) {
    const roots = await this.#readLibraries(scope, scopeRoot);
    if (roots.some((root) => samePath(root, this.#root))) return;
    roots.push(await fs.realpath(this.#root));
    const file = this.#libraryIndexFile(scope, scopeRoot);
    return async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const parent = await fs.lstat(path.dirname(file));
      if (!parent.isDirectory() || isReparseOrSymlink(path.dirname(file), parent))
        throw new Error("Skill ownership index directory is unsafe");
      const bytes = JSON.stringify({ schema_version: 1, libraries: roots }, null, 2);
      if (roots.length > 128 || Buffer.byteLength(bytes) > 1024 * 1024)
        throw new Error("Skill ownership index is full");
      const temp = `${file}.tmp-${randomUUID()}`;
      await fs.writeFile(temp, bytes, { mode: 0o600 });
      try {
        await fs.rename(temp, file);
      } catch (error) {
        await fs.rm(temp, { force: true });
        throw error;
      }
    };
  }

  async #reserve(record: Deployment) {
    const file = this.#reservationFile(record.scope, record.scope_root);
    const reservations = await this.#readReceipts(file);
    if (
      reservations.some(
        (item) =>
          sameEntryPath(item.target, record.target) && item.operation_id !== record.operation_id,
      )
    )
      throw new Error("Skill target is reserved by another operation");
    await this.#writeReceipts(file, [
      ...reservations.filter((item) => !sameEntryPath(item.target, record.target)),
      record,
    ]);
  }

  async #releaseReservation(
    record: Pick<Deployment, "scope" | "scope_root" | "target" | "operation_id">,
  ) {
    const file = this.#reservationFile(record.scope, record.scope_root);
    const reservations = await this.#readReceipts(file);
    if (
      !reservations.some(
        (item) =>
          item.operation_id === record.operation_id && sameEntryPath(item.target, record.target),
      )
    )
      return;
    await this.#writeReceipts(
      file,
      reservations.filter(
        (item) =>
          item.operation_id !== record.operation_id || !sameEntryPath(item.target, record.target),
      ),
    );
  }

  async #readReceipts(file: string): Promise<Deployment[]> {
    const metadata = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return [];
    if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
      throw new Error(`Skill receipts must be a regular file: ${file}`);
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || isReparseOrSymlink(path.dirname(file), parent))
      throw new Error(`Skill receipt directory must be a regular directory: ${file}`);
    if (metadata.size > 4 * 1024 * 1024) throw new Error(`Skill receipts exceed 4 MiB: ${file}`);
    const value = JSON.parse(await fs.readFile(file, "utf8")) as {
      schema_version?: number;
      deployments?: Deployment[];
    };
    if (
      (value.schema_version !== 1 && value.schema_version !== 2) ||
      !Array.isArray(value.deployments) ||
      value.deployments.length > 4_096
    )
      throw new Error(`Skill receipts have an invalid schema: ${file}`);
    for (const record of value.deployments) {
      if (
        !record ||
        typeof record.id !== "string" ||
        typeof record.library_id !== "string" ||
        !safeSkillDirectoryName(record.package_name) ||
        (record.display_name !== undefined && typeof record.display_name !== "string") ||
        typeof record.package_hash !== "string" ||
        (record.scope !== "personal" && record.scope !== "workspace") ||
        typeof record.scope_root !== "string" ||
        !path.isAbsolute(record.scope_root) ||
        record.scope_root.split(path.sep).includes("..") ||
        typeof record.target !== "string" ||
        record.package_name !== path.basename(record.target) ||
        !path.isAbsolute(record.target) ||
        record.target.split(path.sep).includes("..") ||
        !inside(record.target, record.scope_root) ||
        samePath(record.target, record.scope_root) ||
        (record.library_root !== null &&
          record.library_root !== undefined &&
          (typeof record.library_root !== "string" ||
            !path.isAbsolute(record.library_root) ||
            record.library_root.split(path.sep).includes(".."))) ||
        !Array.isArray(record.agents) ||
        !Array.isArray(record.visible_to) ||
        typeof record.status !== "string"
      )
        throw new Error(`Skill receipts contain an invalid deployment: ${file}`);
    }
    return value.deployments;
  }

  async #writeReceipts(file: string, deployments: Deployment[]) {
    if (deployments.length > 4_096) throw new Error("Skill receipt limit exceeded");
    const body = JSON.stringify({ schema_version: 2, deployments }, null, 2);
    if (Buffer.byteLength(body) > 4 * 1024 * 1024) throw new Error("Skill receipts exceed 4 MiB");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || isReparseOrSymlink(path.dirname(file), parent))
      throw new Error("Skill receipt directory is unsafe");
    if (await exists(file)) {
      const metadata = await fs.lstat(file);
      if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
        throw new Error("Skill receipt file is unsafe");
    }
    const temp = `${file}.tmp-${randomUUID()}`;
    await fs.writeFile(temp, body, { mode: 0o600 });
    try {
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  async #allReceipts(
    options: {
      tolerateUnavailableLibraries?: boolean;
      tolerateUnreadableReceipts?: boolean;
      warnings?: string[];
      unverified?: string[];
    } = {},
    targets?: readonly Target[],
  ) {
    const files = new Set([this.#receiptFile("personal", this.#root)]);
    const addLibraryReceipts = async (library: string) => {
      try {
        await this.#assertLibraryAvailable(library);
        files.add(path.join(library, "skill-deployments.json"));
      } catch (error) {
        if (!options.tolerateUnavailableLibraries) throw error;
        const warning = `Skill ownership could not be verified for ${library}`;
        options.warnings?.push(warning);
        options.unverified?.push(warning);
      }
    };
    for (const workspace of this.#workspaceList()) {
      files.add(this.#receiptFile("workspace", workspace.path));
      for (const library of await this.#readLibraries("workspace", workspace.path))
        await addLibraryReceipts(library);
    }
    for (const target of targets ?? (await this.targets())) {
      if (target.scope !== "personal") continue;
      for (const library of await this.#readLibraries("personal", target.scope_root))
        await addLibraryReceipts(library);
    }
    const groups: Deployment[][] = [];
    const identities = new Set<string>();
    const reported = new Set<string>();
    for (const file of files) {
      let records: Deployment[];
      try {
        // Validate each lexical source before collapsing physical aliases.
        records = await this.#readReceipts(file);
      } catch (error) {
        if (!options.tolerateUnreadableReceipts) throw error;
        const identity = physicalPathIdentity(file);
        if (!reported.has(identity)) {
          reported.add(identity);
          const warning = `Skill ownership could not be verified for ${file}: ${error instanceof Error ? error.message : String(error)}`;
          options.warnings?.push(warning);
          options.unverified?.push(warning);
        }
        continue;
      }
      const identity = physicalPathIdentity(file);
      if (identities.has(identity)) continue;
      identities.add(identity);
      groups.push(records);
    }
    return groups.flat();
  }

  async #allReservations(targets?: readonly Target[]): Promise<Deployment[]> {
    const files = new Set([this.#reservationFile("personal", this.#root)]);
    for (const workspace of this.#workspaceList()) {
      files.add(this.#reservationFile("workspace", workspace.path));
      for (const library of await this.#readLibraries("workspace", workspace.path)) {
        await this.#assertLibraryAvailable(library);
        files.add(path.join(library, "skill-deployment-reservations.json"));
      }
    }
    for (const target of targets ?? (await this.targets())) {
      if (target.scope !== "personal") continue;
      for (const library of await this.#readLibraries("personal", target.scope_root)) {
        await this.#assertLibraryAvailable(library);
        files.add(path.join(library, "skill-deployment-reservations.json"));
      }
    }
    const groups = await Promise.all([...files].map((file) => this.#readReceipts(file)));
    return groups.flat();
  }

  async #syncRecoveryTargets(targets?: readonly Target[]) {
    const roots = new Set([this.#root]);
    for (const workspace of this.#workspaceList())
      for (const root of await this.#readLibraries("workspace", workspace.path)) roots.add(root);
    for (const target of targets ?? (await this.targets())) {
      if (target.scope !== "personal") continue;
      for (const root of await this.#readLibraries("personal", target.scope_root)) roots.add(root);
    }
    return (await Promise.all([...roots].map(readSkillSyncTargetJournals))).flat();
  }

  async assertSyncOperationAvailable(destination: string, operationId?: string): Promise<void> {
    return this.#assertSyncOperationAvailable(destination, operationId, await this.targets());
  }

  async #assertSyncOperationAvailable(
    destination: string,
    operationId: string | undefined,
    targets: readonly Target[],
  ): Promise<void> {
    const pending = [
      ...(await this.#allReservations(targets)).map((row) => ({
        operation_id: row.operation_id,
        destination: row.target,
      })),
      ...(await this.#activeJournals(targets)).map(({ journal }) => ({
        operation_id: journal.operation_id,
        destination: journal.destination,
      })),
      ...(await this.#syncRecoveryTargets(targets)),
    ];
    if (
      pending.some(
        (row) => row.operation_id !== operationId && sameEntryPath(row.destination, destination),
      )
    )
      throw new Error("Skill location has an unfinished operation requiring recovery");
  }

  /** The sync executor already holds the shared library and target leases. */
  async reserveSyncLocationLocked(
    location: SkillSyncLocation,
    operationId: string,
    libraryId: string | null,
    packageHash: string | null,
  ): Promise<void> {
    await this.assertSyncOperationAvailable(location.destination, operationId);
    const reservedHash = packageHash ?? location.receipt?.package_hash;
    if (!reservedHash) throw new Error("Skill synchronization reservation has no package hash");
    const record: Deployment = {
      ...(location.receipt ?? {
        id: operationId,
        library_id: libraryId ?? operationId,
        library_root: this.#root,
        package_name: path.basename(location.destination),
        package_hash: reservedHash,
        scope: location.target.scope,
        workspace_id: location.target.workspace_id,
        scope_root: location.target.scope_root,
        target: location.destination,
        agents: [location.target.agent],
        visible_to: location.target.visible_to,
        diagnostics: [],
        previous_hash: null,
      }),
      status: "recovery-required",
      operation_id: operationId,
      updated_at: new Date().toISOString(),
    };
    const register = await this.#prepareLibraryRegistration(
      location.target.scope,
      location.target.scope_root,
    );
    await register?.();
    await this.#reserve(record);
  }

  async releaseSyncReservationLocked(
    location: SkillSyncLocation,
    operationId: string,
  ): Promise<void> {
    await this.#releaseReservation({
      scope: location.target.scope,
      scope_root: location.target.scope_root,
      target: location.destination,
      operation_id: operationId,
    });
  }

  /** Keep discovery within one read aggregate; mutation paths never receive this snapshot. */
  async readSyncState() {
    const targets = await this.targets();
    const inventory = await this.#inventory(targets);
    const deployments = await this.#listDeployments(targets, inventory.observations);
    let receipts: Promise<Deployment[]> | undefined;
    return {
      inventory,
      deployments,
      resolveLocation: async (params: SyncLocationParams) => {
        if (params.deployment_id && params.observation_id)
          throw new Error("Choose exactly one deployment or observation ID");
        // Strict reads stay lazy: corrupt ownership must block the location,
        // without losing the inventory's existing warnings and readable rows.
        receipts ??= this.#allReceipts({}, targets);
        return this.#syncLocation(params, "package", undefined, {
          targets,
          receipts: await receipts,
          inventory,
        });
      },
    };
  }

  async listDeployments(ignoreSyncOperationId?: string) {
    // Reuse discovery only within this read. Writers retain their separate checks
    // before and after staging, and the next read always discovers targets again.
    const targets = await this.targets();
    const inventory = await this.#inventory(targets);
    return this.#listDeployments(targets, inventory.observations, ignoreSyncOperationId);
  }

  async #listDeployments(
    targets: readonly Target[],
    observations: readonly Observation[],
    ignoreSyncOperationId?: string,
  ) {
    const deployments = await this.#allReceipts(
      {
        tolerateUnavailableLibraries: true,
        tolerateUnreadableReceipts: true,
      },
      targets,
    );
    const journals = await this.#activeJournals(targets);
    const reservations = (await this.#allReservations(targets)).filter(
      (row) => row.operation_id !== ignoreSyncOperationId,
    );
    const syncTargets = (await this.#syncRecoveryTargets(targets)).filter(
      (row) => row.operation_id !== ignoreSyncOperationId,
    );
    const known = await Promise.all(
      deployments.map(async (record) => {
        const displayName = await this.#deploymentDisplayName(record);
        const output = {
          ...record,
          origin: record.origin ?? "legacy-unknown",
          lifecycle_status:
            record.status === "inactive" ? ("inactive" as const) : ("active" as const),
          display_name: displayName,
          diagnostics: [...record.diagnostics],
          visible_to: [] as Agent[],
        };
        const currentLibrary =
          typeof record.library_root === "string" && samePath(record.library_root, this.#root);
        const pending = journals.find((item) =>
          sameEntryPath(item.journal.destination, record.target),
        );
        const reserved = reservations.find((item) => sameEntryPath(item.target, record.target));
        const sync = syncTargets.find((item) => sameEntryPath(item.destination, record.target));
        if (pending || reserved || sync) {
          output.status = "recovery-required";
          output.operation_id =
            pending?.journal.operation_id ?? reserved?.operation_id ?? sync!.operation_id;
          output.diagnostics.push("Interrupted Skill operation requires recovery");
        }
        if (record.status !== "inactive") {
          const actual = await this.#currentHash(record.target).catch(() => null);
          if (actual !== record.package_hash && !pending && !reserved && !sync) {
            output.status = "modified";
            output.diagnostics.push("Deployed package changed or is missing");
          }
          for (const observation of observations) {
            if (
              sameEntryPath(observation.path, record.target) ||
              (observation.resolved_path !== null &&
                samePath(observation.resolved_path, record.target))
            ) {
              output.visible_to.push(...observation.agents);
              output.diagnostics.push(...observation.diagnostics);
            }
          }
          output.visible_to = [...new Set(output.visible_to)];
        }
        return { ...output, source_is_current_library: currentLibrary };
      }),
    );
    for (const journal of [
      ...journals.map(({ journal }) => journal),
      ...reservations.map((row) => ({
        destination: row.target,
        next_receipt: row,
        operation_id: row.operation_id,
      })),
    ]) {
      if (known.some((item) => sameEntryPath(item.target, journal.destination))) continue;
      const displayName = await this.#deploymentDisplayName(journal.next_receipt);
      known.push({
        ...journal.next_receipt,
        origin: journal.next_receipt.origin ?? "legacy-unknown",
        lifecycle_status:
          journal.next_receipt.status === "inactive" ? ("inactive" as const) : ("active" as const),
        display_name: displayName,
        status: "recovery-required",
        operation_id: journal.operation_id,
        diagnostics: ["Interrupted Skill operation requires recovery"],
        visible_to: [],
        source_is_current_library:
          typeof journal.next_receipt.library_root === "string" &&
          samePath(journal.next_receipt.library_root, this.#root),
      });
    }
    return known;
  }

  /** Resolves only scanned IDs; callers cannot turn a wire path into a writable location. */
  async syncLocation(
    params: SyncLocationParams,
    mode: "package" | "ownership" = "package",
    operationId?: string,
  ): Promise<SkillSyncLocation> {
    if (params.deployment_id && params.observation_id)
      throw new Error("Choose exactly one deployment or observation ID");
    const targets = await this.targets();
    const receipts = await this.#allReceipts({}, targets);
    return this.#syncLocation(params, mode, operationId, { targets, receipts });
  }

  async #syncLocation(
    params: SyncLocationParams,
    mode: "package" | "ownership",
    operationId: string | undefined,
    read: SyncLocationRead,
  ): Promise<SkillSyncLocation> {
    const { targets, receipts } = read;
    let receipt: Deployment | null = null;
    let destination: string;
    if (params.deployment_id) {
      receipt = receipts.find((item) => item.id === params.deployment_id) ?? null;
      if (!receipt) throw new Error("Skill deployment no longer exists");
      if (receipt.library_root && !samePath(receipt.library_root, this.#root))
        throw new Error("Skill deployment belongs to another library");
      destination = receipt.target;
    } else if (params.observation_id) {
      const inventory = read.inventory ?? (await this.#inventory(targets));
      const observation = inventory.observations.find((item) => item.id === params.observation_id);
      if (!observation) throw new Error("Skill observation no longer exists");
      if (observation.kind !== "directory")
        throw new Error("Linked Skills can only be copied into the library");
      destination = observation.path;
      if (
        receipts.some(
          (item) => item.status !== "inactive" && sameEntryPath(item.target, destination),
        )
      )
        throw new Error("Skill location is already managed");
    } else throw new Error("Choose a deployment or observation ID");
    if (!safeSkillDirectoryName(path.basename(destination)))
      throw new Error("Skill native directory must have a safe single name");
    const target = targets.find(
      (item) =>
        (!receipt || item.scope === receipt.scope) &&
        sameEntryPath(item.root, path.dirname(destination)),
    );
    if (!target || !target.writable)
      throw new Error(target?.reason ?? "Skill location is not a writable native target");
    await this.#assertSyncOperationAvailable(destination, operationId, targets);
    const rootIdentity = physicalPathIdentity(this.#root);
    const entryIdentity = mode === "ownership" ? await this.#ownershipIdentity(destination) : null;
    const targetHash = await this.#currentHash(destination, mode);
    if (mode === "ownership" && entryIdentity !== (await this.#ownershipIdentity(destination)))
      throw new Error("Skill directory changed while checking ownership");
    return {
      target,
      destination,
      receipt_file: this.#receiptFile(target.scope, target.scope_root),
      receipt,
      target_hash: targetHash,
      ...(mode === "ownership" ? { target_identity: entryIdentity } : {}),
      owner_key: stableId(
        "owner",
        `${rootIdentity}:${receipt?.library_root ? "verified" : "unverified"}:${receipt?.library_id ?? "unbound"}:${receipt?.adoption_operation_id ?? receipt?.id ?? "external"}`,
      ),
      target_key: stableId(
        "location",
        `${target.id}:${physicalPathIdentity(destination, true)}:${[...target.visible_to].sort().join(",")}`,
      ),
      ...(params.observation_id ? { observation_id: params.observation_id } : {}),
    };
  }

  async syncBaseline(location: SkillSyncLocation): Promise<string | null> {
    const receipt = location.receipt;
    if (!receipt || !receipt.library_root || !samePath(receipt.library_root, this.#root))
      return null;
    const store = new SkillStateStore(this.#root);
    try {
      return await store.verifySnapshot(receipt.base_snapshot_hash ?? receipt.package_hash);
    } catch {
      return null;
    }
  }

  async recoverSyncOperation(
    operationId: string,
    approveHome: boolean,
    preserveSyncReservation = false,
  ) {
    const entries = (await this.#activeJournals()).filter(
      (item) => item.journal.operation_id === operationId,
    );
    const targets = entries.map((item) => ({
      destination: item.journal.destination,
      scope_root: item.journal.next_receipt.scope_root,
    }));
    const targetIdentities = new Set(
      entries.map(({ journal }) => this.#recoveryTargetIdentity(journal)),
    );
    return withSkillTargetLocks(this.#root, targets, () =>
      this.#recoverOperation(operationId, approveHome, targetIdentities, preserveSyncReservation),
    );
  }

  async commitSync(input: {
    location: SkillSyncLocation;
    kind: SyncMutation;
    libraryId: string;
    snapshotHash: string | null;
    displayName: string;
    operationId: string;
    allowTargetDrift?: boolean;
  }): Promise<Deployment> {
    const { location, kind } = input;
    return withSkillTargetLocks(
      this.#root,
      [{ destination: location.destination, scope_root: location.target.scope_root }],
      async () => {
        const fresh = await this.syncLocation(
          location.receipt
            ? { deployment_id: location.receipt.id }
            : {
                observation_id: location.observation_id,
              },
          kind === "detach" ? "ownership" : "package",
          input.operationId,
        );
        if (
          JSON.stringify(fresh.receipt) !== JSON.stringify(location.receipt) ||
          fresh.target_key !== location.target_key ||
          (kind === "detach" && fresh.target_identity !== location.target_identity)
        )
          throw new Error("Skill deployment ownership changed after preview");
        if (!input.allowTargetDrift && fresh.target_hash !== location.target_hash)
          throw new Error("Skill destination changed after preview");
        if (kind !== "bind" && kind !== "detach" && fresh.receipt && !fresh.receipt.library_root)
          throw new Error("Skill deployment has no verified library; bind it explicitly first");
        const source = input.snapshotHash
          ? await new SkillStateStore(this.#root).verifySnapshot(input.snapshotHash)
          : null;
        const plan: PlannedTarget = {
          target: fresh.target,
          agents: [fresh.target.agent],
          visibleTo: fresh.target.visible_to,
          destination: fresh.destination,
          displayName: input.displayName,
          receiptFile: fresh.receipt_file,
          receipt: fresh.receipt,
          expectedHash: fresh.target_hash,
          source,
          sourceHash: input.snapshotHash,
          incomingHash: input.snapshotHash,
          backup: fresh.receipt ? this.#backupPath(fresh.receipt) : null,
          added: [],
          modified: [],
          removed: [],
          conflicts: [],
          syncMutation: kind,
          ...(kind === "detach" ? { expectedIdentity: fresh.target_identity } : {}),
        };
        return this.#applyTarget(
          {
            token: input.operationId,
            operation: kind === "detach" ? "undeploy" : fresh.receipt ? "update" : "deploy",
            libraryId: input.libraryId,
            expires: Date.now() + 60_000,
            targets: [plan],
          },
          plan,
          input.operationId,
        );
      },
    );
  }

  async prepareDeployment(params: Record<string, unknown>) {
    const operation = params.operation;
    if (!(["deploy", "update", "undeploy", "rollback"] as unknown[]).includes(operation))
      throw new Error("Unsupported Skill deployment operation");
    const action = operation as DeploymentOperation;
    const currentTargets = await this.targets();
    const receipts = await this.#allReceipts({}, currentTargets);
    const allReservations = await this.#allReservations(currentTargets);
    const syncTargets = await this.#syncRecoveryTargets(currentTargets);
    let selected: Target[];
    let libraryId: string | null;
    let receipt: Deployment | null = null;
    if (action === "deploy") {
      if (
        typeof params.library_id !== "string" ||
        !Array.isArray(params.target_ids) ||
        !params.target_ids.length
      )
        throw new Error("Select a library Skill and targets");
      libraryId = params.library_id;
      selected = params.target_ids.map((id) => {
        const target = currentTargets.find((candidate) => candidate.id === id);
        if (!target) throw new Error("Skill target changed; refresh and retry");
        return target;
      });
    } else {
      if (typeof params.deployment_id !== "string") throw new Error("Deployment ID is required");
      receipt = receipts.find((item) => item.id === params.deployment_id) ?? null;
      if (!receipt) throw new Error("Skill deployment no longer exists");
      libraryId = receipt.library_id;
      selected = currentTargets.filter(
        (target) =>
          target.scope === receipt!.scope &&
          sameEntryPath(path.join(target.root, receipt!.package_name), receipt!.target),
      );
      if (!selected.length) throw new Error("Skill target changed; refresh and retry");
    }
    const grouped = new Map<string, Target[]>();
    for (const target of selected) {
      const key = physicalPathKey(target.root);
      if (!grouped.has(key))
        grouped.set(
          key,
          currentTargets.filter(
            (candidate) =>
              candidate.scope === target.scope && samePath(candidate.root, target.root),
          ),
        );
    }
    const planned: PlannedTarget[] = [];
    for (const group of grouped.values()) {
      const target = group[0]!;
      const packageName = receipt?.package_name ?? libraryId!;
      if (
        receipt
          ? !safeSkillDirectoryName(packageName)
          : !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packageName)
      )
        throw new Error("Invalid Skill package identity");
      const destination = path.join(target.root, packageName);
      const owned =
        receipts.find(
          (item) => item.status !== "inactive" && sameEntryPath(item.target, destination),
        ) ?? null;
      const conflicts: string[] = [];
      const reservations = allReservations;
      if (reservations.some((item) => sameEntryPath(item.target, destination)))
        conflicts.push("Skill target has an unfinished operation requiring recovery");
      if (syncTargets.some((item) => sameEntryPath(item.destination, destination)))
        conflicts.push("Skill target has an unfinished synchronization requiring recovery");
      if (group.some((item) => !item.writable))
        conflicts.push(...group.flatMap((item) => (item.reason ? [item.reason] : [])));
      if (action === "deploy" && owned) conflicts.push("Destination is already owned by AgentKib");
      if (action !== "deploy" && (!owned || owned.id !== receipt?.id))
        conflicts.push("Deployment ownership changed");
      if (
        action === "update" &&
        (!receipt?.library_root || !samePath(receipt.library_root, this.#root))
      )
        conflicts.push("Deployment has no verified source in this Skill library");
      const actualHash = await this.#currentHash(destination);
      if (action === "deploy" && (await exists(destination)))
        conflicts.push("Destination already exists and is not available for deployment");
      if (action !== "deploy" && actualHash !== receipt?.package_hash)
        conflicts.push("Deployed package was modified or removed");
      const source =
        action === "undeploy"
          ? null
          : action === "rollback"
            ? this.#backupPath(receipt!)
            : path.join(this.#root, "skills", libraryId!);
      const sourceInfo = source && (await exists(source)) ? await skillPackage(source) : null;
      let expectedLibraryLock: string | undefined;
      if ((action === "deploy" || action === "update") && libraryId && sourceInfo) {
        const lockEntry = (await this.#lock()).skills[libraryId];
        expectedLibraryLock = JSON.stringify(lockEntry);
        if (!lockEntry || lockEntry.content_sha256 !== sourceInfo.hash)
          conflicts.push("Library package contains unaccepted local changes");
      }
      if (source && !sourceInfo) conflicts.push("Library or previous Skill package is unavailable");
      if (sourceInfo?.diagnostics.length) conflicts.push(...sourceInfo.diagnostics);
      const displayName =
        receipt?.display_name ??
        (libraryId
          ? await this.#libraryDisplayName(libraryId).catch(() => packageName)
          : packageName);
      const previous =
        actualHash && (await exists(destination)) ? await skillPackage(destination) : null;
      const before = new Map(previous?.files.map((file) => [file.path, file]));
      const after = new Map(sourceInfo?.files.map((file) => [file.path, file]));
      const added = [...after.keys()].filter((key) => !before.has(key));
      const removed = [...before.keys()].filter((key) => !after.has(key));
      const modified = [...after.keys()].filter((key) => {
        const old = before.get(key);
        const next = after.get(key)!;
        return old && (old.sha256 !== next.sha256 || old.executable !== next.executable);
      });
      planned.push({
        target,
        agents: group.map((item) => item.agent),
        visibleTo: [...new Set(group.flatMap((item) => item.visible_to))],
        destination,
        displayName,
        receiptFile: this.#receiptFile(target.scope, target.scope_root),
        receipt: owned,
        expectedHash: actualHash,
        source,
        sourceHash: sourceInfo?.hash ?? null,
        incomingHash: sourceInfo?.hash ?? null,
        backup: owned ? this.#backupPath(owned) : null,
        added,
        modified,
        removed,
        conflicts,
        expectedLibraryLock,
      });
    }
    const token = randomUUID();
    const expires = Date.now() + 15 * 60_000;
    const prepared: PreparedDeployment = {
      token,
      operation: action,
      libraryId,
      expires,
      targets: planned,
    };
    this.#prepared.set(token, prepared);
    if (this.#prepared.size > 8) this.#prepared.delete(this.#prepared.keys().next().value!);
    return {
      token,
      operation: action,
      library_id: libraryId,
      expires_at: new Date(expires).toISOString(),
      requires_home_approval: planned.some((item) => item.target.scope === "personal"),
      targets: planned.map((item) => ({
        target_id: item.target.id,
        deployment_id: item.receipt?.id ?? null,
        path: item.destination,
        scope: item.target.scope,
        workspace_id: item.target.workspace_id,
        agents: groupForTarget(grouped, item.target).map((target) => target.agent),
        visible_to: [
          ...new Set(groupForTarget(grouped, item.target).flatMap((target) => target.visible_to)),
        ],
        added: item.added,
        modified: item.modified,
        removed: item.removed,
        conflicts: item.conflicts,
        conditions: item.target.conditions,
      })),
    };
  }

  #backupPath(record: Deployment) {
    return path.join(
      path.dirname(path.dirname(record.target)),
      ".agentkib-skill-state",
      "backups",
      record.id,
    );
  }

  async #ownershipIdentity(directory: string): Promise<string | null> {
    const metadata = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return null;
    if (!metadata.isDirectory() || isReparseOrSymlink(directory, metadata))
      throw new Error("Skill ownership location must remain a regular directory");
    return `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`;
  }

  async #currentHash(
    directory: string,
    mode: "package" | "ownership" = "package",
  ): Promise<string | null> {
    const metadata = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return null;
    if (!metadata.isDirectory() || isReparseOrSymlink(directory, metadata)) return null;
    const packageInfo = await skillPackage(directory);
    if (packageInfo.diagnostics.length) throw new Error(packageInfo.diagnostics.join("; "));
    // Releasing ownership does not require the user's retained files to remain a valid Skill.
    if (mode === "ownership") return packageInfo.hash;
    const entry = packageInfo.files.find((file) => file.path === "SKILL.md");
    if (!entry || entry.binary || entry.size > 1024 * 1024)
      throw new Error("Skill package requires a readable SKILL.md entry point within 1 MiB");
    const text = await fs.readFile(path.join(directory, "SKILL.md"), "utf8");
    const front = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!front) throw new Error("SKILL.md must start with YAML frontmatter");
    const value = parseYaml(front[1]!) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Skill frontmatter must be a mapping");
    const declaredName = Object.hasOwn(value, "name");
    const name = declaredName ? value.name : path.basename(directory);
    if (typeof name !== "string" || !name.trim() || Buffer.byteLength(name) > 64)
      throw new Error("Skill name is invalid");
    if (declaredName && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name.trim()))
      throw new Error("Skill name must use lowercase letters, numbers, and single hyphens");
    if (
      typeof value.description !== "string" ||
      !value.description.trim() ||
      Buffer.byteLength(value.description) > 1024
    )
      throw new Error("Skill description is invalid");
    return packageInfo.hash;
  }

  async #libraryDisplayName(libraryId: string, libraryRoot = this.#root): Promise<string> {
    const lockPath = path.join(libraryRoot, "skills.lock.json");
    const lock = await fs.readFile(lockPath, "utf8").then(
      (value) => JSON.parse(value) as { skills?: Record<string, { display_name?: unknown }> },
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    const saved = lock?.skills?.[libraryId]?.display_name;
    if (typeof saved === "string" && saved.trim()) return saved;
    return (await this.#metadata(path.join(libraryRoot, "skills", libraryId), libraryId)).name;
  }

  async #deploymentDisplayName(record: Deployment): Promise<string> {
    if (typeof record.display_name === "string" && record.display_name.trim())
      return record.display_name;
    return this.#libraryDisplayName(record.library_id, record.library_root ?? this.#root).catch(
      () => record.package_name,
    );
  }

  async readPreviewFile(params: Record<string, unknown>) {
    if (
      typeof params.token !== "string" ||
      typeof params.path !== "string" ||
      typeof params.target_id !== "string"
    )
      throw new Error("Skill deployment preview is invalid");
    const preview = this.#prepared.get(params.token);
    if (!preview || preview.expires <= Date.now()) throw new Error("Skill preview has expired");
    const target = preview.targets.find((item) => item.target.id === params.target_id);
    if (!target) throw new Error("Skill target is not in the preview");
    return skillPreviewFile(
      target.expectedHash ? target.destination : null,
      target.source,
      params.path,
    );
  }

  #operationDir(target: Target, operationId: string) {
    return path.join(
      path.dirname(target.root),
      ".agentkib-skill-state",
      "operations",
      operationId,
      target.id,
    );
  }

  async #writeJournal(directory: string, journal: Journal) {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "journal.json");
    const temp = `${file}.tmp-${randomUUID()}`;
    await fs.writeFile(temp, JSON.stringify(journal, null, 2), { mode: 0o600 });
    try {
      await fs.rename(temp, file);
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  async #activeJournals(
    currentTargets?: readonly Target[],
  ): Promise<Array<{ directory: string; journal: Journal }>> {
    const targets = currentTargets ?? (await this.targets());
    const roots = new Set(targets.map((target) => path.dirname(target.root)));
    const journals: Array<{ directory: string; journal: Journal }> = [];
    for (const root of roots) {
      const operationRoot = path.join(root, ".agentkib-skill-state", "operations");
      const operations = await fs.readdir(operationRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const operationId of operations.slice(0, 4_096)) {
        if (!/^[0-9a-f-]{36}$/i.test(operationId)) continue;
        const targetIds = await fs.readdir(path.join(operationRoot, operationId));
        for (const targetId of targetIds.slice(0, 256)) {
          const directory = path.join(operationRoot, operationId, targetId);
          const file = path.join(directory, "journal.json");
          const data = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
          if (!data) continue;
          if (Buffer.byteLength(data) > 4 * 1024 * 1024)
            throw new Error(`Skill operation journal exceeds its size limit: ${file}`);
          const journal = JSON.parse(data) as Journal;
          const target = targets.find((item) => item.id === targetId);
          if (
            (journal.schema_version !== 1 && journal.schema_version !== 2) ||
            journal.operation_id !== operationId ||
            journal.target_id !== targetId ||
            !target ||
            !journal.next_receipt ||
            typeof journal.destination !== "string" ||
            !path.isAbsolute(journal.destination) ||
            journal.destination.split(/[\\/]/).includes("..") ||
            !safeSkillDirectoryName(path.basename(journal.destination)) ||
            !safeSkillDirectoryName(journal.next_receipt.package_name) ||
            journal.next_receipt.package_name !== path.basename(journal.destination) ||
            !sameEntryPath(path.dirname(journal.destination), target.root) ||
            !sameEntryPath(journal.next_receipt.target, journal.destination) ||
            journal.next_receipt.scope !== target.scope ||
            !samePath(journal.next_receipt.scope_root, target.scope_root) ||
            !sameEntryPath(
              journal.receipt_file,
              this.#receiptFile(target.scope, target.scope_root),
            ) ||
            (journal.backup !== null &&
              !sameEntryPath(journal.backup, this.#backupPath(journal.next_receipt)))
          )
            throw new Error(`Invalid Skill operation journal: ${file}`);
          for (
            let current = directory;
            inside(current, target.scope_root);
            current = path.dirname(current)
          ) {
            const metadata = await fs.lstat(current);
            if (!metadata.isDirectory() || isReparseOrSymlink(current, metadata))
              throw new Error(`Unsafe Skill operation journal path: ${file}`);
            if (samePath(current, target.scope_root)) break;
          }
          const metadata = await fs.lstat(file);
          if (!metadata.isFile() || isReparseOrSymlink(file, metadata))
            throw new Error(`Unsafe Skill operation journal: ${file}`);
          journals.push({ directory, journal });
        }
      }
    }
    return journals;
  }

  async applyDeployment(params: Record<string, unknown>) {
    if (params.confirmed !== true || typeof params.token !== "string")
      throw new Error("Skill deployment requires confirmation and a preview token");
    if (this.#writing) throw new Error("Another Skill operation is already running");
    this.#writing = true;
    try {
      const preview = this.#prepared.get(params.token);
      if (!preview) return this.recoverSyncOperation(params.token, params.approve_home === true);
      if (preview.expires <= Date.now()) throw new Error("Skill deployment preview has expired");
      if (
        preview.targets.some((item) => item.target.scope === "personal") &&
        params.approve_home !== true
      )
        throw new Error("Personal Skill deployment requires Agent Home approval");
      this.#prepared.delete(params.token);
      const operationId = randomUUID();
      const results = [];
      for (const target of preview.targets) {
        try {
          currentTask()?.checkpoint();
          const deployment = await withSkillTargetLocks(
            this.#root,
            [{ destination: target.destination, scope_root: target.target.scope_root }],
            () => this.#applyTarget(preview, target, operationId),
          );
          results.push({
            target_id: target.target.id,
            deployment_id: deployment.id,
            path: target.destination,
            success: true,
            status: deployment.status,
            error: null,
          });
        } catch (error) {
          const journal = await exists(
            path.join(this.#operationDir(target.target, operationId), "journal.json"),
          );
          results.push({
            target_id: target.target.id,
            deployment_id: target.receipt?.id ?? null,
            path: target.destination,
            success: false,
            status: journal ? "recovery-required" : "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { operation_id: operationId, results, warnings: [] };
    } finally {
      this.#writing = false;
    }
  }

  async #applyTarget(preview: PreparedDeployment, plan: PlannedTarget, operationId: string) {
    const workspaceId = plan.target.workspace_id;
    const workspacePath = workspaceId
      ? this.#workspaceList().find((item) => item.id === workspaceId)?.path
      : undefined;
    if (workspaceId && !workspacePath) throw new Error("Skill workspace is no longer registered");
    currentTask()?.checkpoint();
    if (workspaceId && workspacePath)
      await currentTask()?.verifyWorkspace?.({ workspaceId, workspacePath });
    currentTask()?.checkpoint();
    return this.#applyVerifiedTarget(preview, plan, operationId);
  }

  async #applyVerifiedTarget(
    preview: PreparedDeployment,
    plan: PlannedTarget,
    operationId: string,
  ) {
    if (plan.conflicts.length) throw new Error(plan.conflicts.join("; "));
    // Share discovery only within this locked validation phase; staging is
    // followed by an independent discovery and content/ownership check below.
    const currentTargets = await this.targets();
    const current = currentTargets.find((item) => item.id === plan.target.id);
    if (!current || !current.writable || !samePath(current.root, plan.target.root))
      throw new Error("Skill target changed after preview");
    const mode = plan.syncMutation === "detach" ? "ownership" : "package";
    const actual = await this.#currentHash(plan.destination, mode);
    if (actual !== plan.expectedHash || (actual === null && (await exists(plan.destination))))
      throw new Error("Skill destination changed after preview");
    if (
      mode === "ownership" &&
      (await this.#ownershipIdentity(plan.destination)) !== plan.expectedIdentity
    )
      throw new Error("Skill directory changed after preview");
    const receipts = await this.#readReceipts(plan.receiptFile);
    const currentReceipt = receipts.find((item) => item.id === plan.receipt?.id) ?? null;
    if (
      Boolean(currentReceipt) !== Boolean(plan.receipt) ||
      (currentReceipt && JSON.stringify(currentReceipt) !== JSON.stringify(plan.receipt))
    )
      throw new Error("Skill deployment ownership changed after preview");
    const otherOwners = (await this.#allReceipts({}, currentTargets)).filter(
      (item) => item.status !== "inactive" && sameEntryPath(item.target, plan.destination),
    );
    if (otherOwners.some((item) => item.id !== currentReceipt?.id))
      throw new Error("Skill destination is owned by another library");
    await this.#assertSyncOperationAvailable(plan.destination, operationId, currentTargets);
    const sourceHash = plan.source ? await this.#currentHash(plan.source) : null;
    if (sourceHash !== plan.sourceHash) throw new Error("Skill source changed after preview");
    if (
      plan.expectedLibraryLock !== undefined &&
      JSON.stringify((await this.#lock()).skills[preview.libraryId!]) !== plan.expectedLibraryLock
    )
      throw new Error("Skill library record changed after preview");
    const snapshots = new SkillStateStore(this.#root);
    if (mode !== "ownership" && currentReceipt && actual === currentReceipt.package_hash)
      await snapshots.snapshot(plan.destination, actual);
    if (plan.source && sourceHash) await snapshots.snapshot(plan.source, sourceHash);
    const directory = this.#operationDir(plan.target, operationId);
    const stage = path.join(directory, "new");
    const old = path.join(directory, "old");
    const previousBackup = path.join(directory, "previous-backup");
    const backup = plan.backup;
    const now = new Date().toISOString();
    const next: Deployment = currentReceipt
      ? {
          ...currentReceipt,
          ...(plan.syncMutation === "bind"
            ? { library_root: this.#root, library_id: preview.libraryId! }
            : {}),
          display_name: plan.displayName,
          package_hash: plan.incomingHash ?? currentReceipt.package_hash,
          previous_hash:
            (!plan.syncMutation || plan.syncMutation === "write") &&
            (preview.operation === "update" || preview.operation === "rollback")
              ? plan.expectedHash
              : currentReceipt.previous_hash,
          visible_to: plan.visibleTo,
          agents: plan.agents,
          workspace_id: plan.target.workspace_id,
          status: preview.operation === "undeploy" ? "inactive" : "active",
          diagnostics: [],
          operation_id: operationId,
          updated_at: now,
        }
      : {
          id: randomUUID(),
          library_id: preview.libraryId!,
          library_root: this.#root,
          package_name: path.basename(plan.destination),
          display_name: plan.displayName,
          package_hash: plan.incomingHash!,
          scope: plan.target.scope,
          workspace_id: plan.target.workspace_id,
          scope_root: plan.target.scope_root,
          target: plan.destination,
          agents: plan.agents,
          visible_to: plan.visibleTo,
          status: "active",
          diagnostics: [],
          previous_hash: null,
          operation_id: operationId,
          updated_at: now,
        };
    next.hash_algorithm = SKILL_HASH_ALGORITHM;
    next.origin ??= currentReceipt
      ? "legacy-unknown"
      : plan.syncMutation === "adopt" ||
          (plan.syncMutation === "write" && plan.expectedHash !== null)
        ? "adopted"
        : "agentkib";
    if (plan.syncMutation === "bind") {
      next.origin = "adopted";
      next.adopted_at = now;
      next.adoption_operation_id = operationId;
    }
    if (next.origin === "adopted" && !next.adopted_at) {
      next.adopted_at = now;
      next.adoption_operation_id = operationId;
    }
    if (plan.incomingHash) next.base_snapshot_hash = plan.incomingHash;
    const journal: Journal = {
      schema_version: 2,
      operation_id: operationId,
      operation: preview.operation,
      target_id: plan.target.id,
      destination: plan.destination,
      receipt_file: plan.receiptFile,
      backup,
      prior_receipt: currentReceipt,
      next_receipt: next,
      expected_hash: plan.expectedHash,
      incoming_hash: plan.incomingHash,
      state: "prepared",
      metadata_only: plan.syncMutation !== undefined && plan.syncMutation !== "write",
      ...(mode === "ownership" ? { expected_identity: plan.expectedIdentity } : {}),
    };
    currentTask()?.checkpoint();
    await fs.mkdir(directory, { recursive: true });
    try {
      if (plan.source) await copySkillPackage(plan.source, stage);
      if (plan.source && (await this.#currentHash(stage)) !== plan.sourceHash)
        throw new Error("Staged Skill package changed");
      if (plan.target.workspace_id)
        await currentTask()?.verifyWorkspace?.({
          workspaceId: plan.target.workspace_id,
          workspacePath: plan.target.scope_root,
        });
      const registerLibrary = await this.#prepareLibraryRegistration(
        plan.target.scope,
        plan.target.scope_root,
      );
      const hasBackup = !journal.metadata_only && backup && (await exists(backup));
      if (preview.operation === "rollback" && currentReceipt)
        await this.#beforeRollback?.(currentReceipt.id);
      const finalTarget = (await this.targets()).find((item) => item.id === plan.target.id);
      if (!finalTarget?.writable || !samePath(finalTarget.root, plan.target.root))
        throw new Error("Skill target changed while staging");
      if (
        (await this.#currentHash(plan.destination, mode)) !== plan.expectedHash ||
        (mode === "ownership" &&
          (await this.#ownershipIdentity(plan.destination)) !== plan.expectedIdentity) ||
        JSON.stringify(
          (await this.#readReceipts(plan.receiptFile)).find(
            (item) => item.id === plan.receipt?.id,
          ) ?? null,
        ) !== JSON.stringify(currentReceipt) ||
        (plan.source ? await this.#currentHash(plan.source) : null) !== plan.sourceHash
      )
        throw new Error("Skill contents or ownership changed while staging");
      return await commitTask(
        async () => {
          await registerLibrary?.();
          await this.#writeJournal(directory, journal);
          await this.#reserve(next);
          if (hasBackup) await fs.rename(backup!, previousBackup);
          if (journal.metadata_only) {
            const updated = receipts.filter((item) => item.id !== next.id);
            updated.push(next);
            await this.#writeReceipts(plan.receiptFile, updated);
            journal.state = "receipt-written";
            await this.#writeJournal(directory, journal);
            if (!plan.syncMutation) await this.#releaseReservation(next);
            await fs.rm(directory, { recursive: true, force: true });
            return next;
          }
          await fs.mkdir(plan.target.root, { recursive: true });
          if (plan.expectedHash) await fs.rename(plan.destination, old);
          if (preview.operation !== "undeploy") await fs.rename(stage, plan.destination);
          journal.state = "activated";
          await this.#writeJournal(directory, journal);
          const updated = receipts.filter((item) => item.id !== next.id);
          updated.push(next);
          await this.#writeReceipts(plan.receiptFile, updated);
          journal.state = "receipt-written";
          await this.#writeJournal(directory, journal);
          if (backup && (await exists(old)) && preview.operation !== "undeploy") {
            await fs.mkdir(path.dirname(backup), { recursive: true });
            await fs.rename(old, backup);
          }
          if (!plan.syncMutation) await this.#releaseReservation(next);
          await fs.rm(directory, { recursive: true, force: true });
          return next;
        },
        plan.target.workspace_id
          ? { workspaceId: plan.target.workspace_id, workspacePath: plan.target.scope_root }
          : undefined,
      );
    } catch (error) {
      if (!(await exists(path.join(directory, "journal.json")))) {
        if (backup && (await exists(previousBackup))) await fs.rename(previousBackup, backup);
        await fs.rm(directory, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async #recoverOperation(
    operationId: string,
    approveHome: boolean,
    lockedTargets: ReadonlySet<string>,
    preserveSyncReservation: boolean,
  ) {
    const entries = (await this.#activeJournals()).filter(
      (item) => item.journal.operation_id === operationId,
    );
    if (!entries.length) throw new Error("Skill operation does not exist or has already completed");
    if (entries.some(({ journal }) => !lockedTargets.has(this.#recoveryTargetIdentity(journal))))
      throw new Error("Skill recovery targets changed while acquiring locks; retry recovery");
    const results = [];
    for (const { directory, journal } of entries) {
      if (!approveHome && journal.next_receipt.scope === "personal") {
        results.push({
          target_id: journal.target_id,
          deployment_id: journal.next_receipt.id,
          path: journal.destination,
          success: false,
          status: "recovery-required",
          error: "Personal Skill recovery requires Agent Home approval",
        });
        continue;
      }
      try {
        currentTask()?.checkpoint();
        if (
          journal.next_receipt.library_root &&
          !samePath(journal.next_receipt.library_root, this.#root)
        )
          throw new Error("Skill operation belongs to another library");
        const workspaceId = journal.next_receipt.workspace_id;
        if (workspaceId) {
          const workspacePath = journal.next_receipt.scope_root;
          if (
            !this.#workspaceList().some(
              (item) => item.id === workspaceId && item.path === workspacePath,
            )
          )
            throw new Error("Skill workspace is no longer registered");
          await currentTask()?.verifyWorkspace?.({ workspaceId, workspacePath });
        }
        const receipts = await this.#readReceipts(journal.receipt_file);
        const active = receipts.find((item) => item.id === journal.next_receipt.id) ?? null;
        const committed = active?.operation_id === operationId;
        const ownershipOnly = journal.metadata_only && journal.operation === "undeploy";
        const actual = await this.#currentHash(
          journal.destination,
          ownershipOnly ? "ownership" : "package",
        );
        if (
          ownershipOnly &&
          (actual !== journal.expected_hash ||
            (journal.expected_identity !== undefined &&
              (await this.#ownershipIdentity(journal.destination)) !== journal.expected_identity))
        )
          throw new Error("Skill destination changed externally; recovery preserved the files");
        const old = path.join(directory, "old");
        const priorBackup = path.join(directory, "previous-backup");
        const oldExists = await exists(old);
        const priorBackupExists = await exists(priorBackup);
        const newExists = await exists(path.join(directory, "new"));
        await commitTask(
          async () => {
            if (journal.metadata_only) {
              // Metadata-only commits never claim or remove native bytes during recovery.
            } else if (committed && actual === journal.incoming_hash) {
              if (journal.backup && oldExists) {
                await fs.mkdir(path.dirname(journal.backup), { recursive: true });
                await fs.rename(old, journal.backup);
              }
            } else if (
              !committed &&
              journal.state === "prepared" &&
              actual !== null &&
              actual === journal.incoming_hash &&
              actual !== journal.expected_hash &&
              newExists
            ) {
              throw new Error("Skill destination changed externally; recovery preserved the files");
            } else if (!committed && actual === journal.expected_hash) {
              if (journal.backup && priorBackupExists) await fs.rename(priorBackup, journal.backup);
            } else if (!committed && (actual === journal.incoming_hash || actual === null)) {
              if (actual !== null)
                await fs.rename(journal.destination, path.join(directory, "abandoned"));
              if (oldExists) await fs.rename(old, journal.destination);
              if (journal.backup && priorBackupExists) await fs.rename(priorBackup, journal.backup);
            } else {
              throw new Error("Skill destination changed externally; recovery preserved the files");
            }
            if (!preserveSyncReservation) await this.#releaseReservation(journal.next_receipt);
            await fs.rm(directory, { recursive: true, force: true });
          },
          workspaceId ? { workspaceId, workspacePath: journal.next_receipt.scope_root } : undefined,
        );
        results.push({
          target_id: journal.target_id,
          deployment_id: journal.next_receipt.id,
          path: journal.destination,
          success: committed,
          status: committed ? journal.next_receipt.status : "recovered",
          error: null,
        });
      } catch (error) {
        results.push({
          target_id: journal.target_id,
          deployment_id: journal.next_receipt.id,
          path: journal.destination,
          success: false,
          status: "recovery-required",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { operation_id: operationId, results, warnings: [] };
  }

  #recoveryTargetIdentity(journal: Journal): string {
    return JSON.stringify([
      journal.target_id,
      physicalPathIdentity(journal.destination, true),
      physicalPathIdentity(journal.next_receipt.scope_root),
    ]);
  }

  async #metadata(root: string, fallback: string) {
    const text = await fs.readFile(path.join(root, "SKILL.md"), "utf8");
    const front = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!front) return { name: fallback, description: "" };
    const parsed = parseYaml(front[1] ?? "") as Record<string, unknown> | null;
    return {
      name: typeof parsed?.name === "string" && parsed.name ? parsed.name : fallback,
      description: typeof parsed?.description === "string" ? parsed.description : "",
    };
  }

  async #lock(): Promise<{ skills: Record<string, Record<string, unknown>> }> {
    const file = path.join(this.#root, "skills.lock.json");
    return fs.readFile(file, "utf8").then(
      (text) => JSON.parse(text) as { skills: Record<string, Record<string, unknown>> },
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { skills: {} };
        throw error;
      },
    );
  }
}
