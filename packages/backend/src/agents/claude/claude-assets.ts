import path from "node:path";
import { parse as parseYaml } from "yaml";
import { claudeConfigFiles, resolveClaudeConfig, type ClaudeConfig } from "./claude-config";
import { claudeProjectKeyForm } from "./claude-project-config";
import {
  redactText,
  summarizeHooks,
  type ClaudeSettings,
  type HookSummary,
} from "./claude-settings";
import {
  defaultIo,
  flavor,
  isInside,
  isNetworkOrDevicePath,
  pathKey,
  probe,
  walkRules,
  type ClaudeIo,
  type OutsideMode,
  type ProbeContext,
  type RuleLimits,
} from "../../context-claude-sources";
import { userHome } from "../../mcp-config-read";

// Plugins and the assets next to them, read-only. Basis, https://code.claude.com/docs/en/:
// - plugins/loading ("Find plugins on disk"): `<config>/plugins` (`CLAUDE_CODE_PLUGIN_CACHE_DIR`
//   moves it) holds `installed_plugins.json`, which records each install with its `scope`,
//   `installPath` and `version`. Whether a plugin is on comes from `enabledPlugins` in settings.
// - plugins/components: a plugin has `.claude-plugin/plugin.json` and the default places
//   `commands/`, `agents/`, `skills/`, `output-styles/`, `hooks/hooks.json` and `.mcp.json`.
//   A manifest path for commands, agents or output styles replaces the default folder; skills
//   supplement the default folder, while hooks and MCP servers merge into the default file.
//   plugins-reference: MCP definitions merge in declaration order, with later names winning.
// - claude-directory: `commands/`, `agents/`, `output-styles/` and `workflows/` exist in the
//   project's `.claude` and in the configuration folder.
//
// Everything here is bounded (counts, depth, file size), and file text is read only for the front
// matter of command, agent and output style files. A description or a tool list is redacted like
// any other text from a settings file before it is shown. Not listed: skills (they have their own
// page), LSP servers, monitors, themes, channels and executables of plugins.

export type AssetTier = "project" | "user" | "plugin";
export interface AssetItem {
  name: string;
  description?: string;
  tools?: string;
  model?: string;
  tier: AssetTier;
  /** `project`, `user` or the plugin id. */
  origin: string;
  /** The file lies below the workspace root. */
  inside: boolean;
}
export interface PluginMcp {
  plugin: string;
  /** The file the definitions came from (the manifest for inline ones), as written. */
  file: string;
  /** Raw definitions, for the MCP view, which redacts them. Never put into text. */
  servers: Record<string, unknown>;
}
export interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  enabled: boolean;
  /** Which settings layer decides `enabled`. */
  layer?: string;
  installed: boolean;
  commands: AssetItem[];
  agents: AssetItem[];
  outputStyles: AssetItem[];
  skills: string[];
  hooks: HookSummary[];
  mcp: PluginMcp[];
  /** Why the components could not be listed, when they could not. */
  problem?: string;
}
export interface ClaudeAssets {
  plugins: PluginInfo[];
  /** Plugin ids that are installed but not enabled. */
  installedOnly: string[];
  marketplaces: number;
  commands: AssetItem[];
  agents: AssetItem[];
  outputStyles: AssetItem[];
  workflows: AssetItem[];
  /** Some listing hit a bound, so it is incomplete. */
  limited: boolean;
}
export interface ClaudeAssetsOptions {
  root: string;
  /** Directories from the root down to the working directory. */
  dirs: string[];
  environment: NodeJS.ProcessEnv;
  mode: OutsideMode;
  settings: ClaudeSettings;
  config?: ClaudeConfig;
  platform?: NodeJS.Platform;
  io?: ClaudeIo;
  sensitive?: (written: string, real: string) => boolean;
  /** Skip the project and user folders: only the plugins are wanted. */
  pluginsOnly?: boolean;
  /** Global scans have no project, even when `root` happens to be the user's home. */
  withoutProject?: boolean;
}

const MAX_PLUGINS = 64;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const FRONT_MATTER_BYTES = 16 * 1024;
const MAX_DESCRIPTION = 200;
const FILE_LIMITS: RuleLimits = { files: 128, depth: 4, entries: 512 };
const MAX_WORKFLOWS = 128;
const MAX_LISTED = 40;

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = MAX_DESCRIPTION): string | undefined => {
  const raw = Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string").join(", ")
    : typeof value === "string"
      ? value
      : undefined;
  if (raw === undefined || raw.trim() === "") return undefined;
  const flat = redactText(raw).replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

/** The front matter of a Markdown file as an object, or an empty one when there is none or it is broken. */
export function parseFrontMatter(content: string): Record<string, unknown> {
  const body = content.startsWith("\uFEFF") ? content.slice(1) : content;
  const opening = /^---[ \t]*\r?\n/.exec(body);
  if (!opening) return {};
  const rest = body.slice(opening[0].length);
  const closing = /^(---|\.\.\.)[ \t]*$/m.exec(rest);
  if (!closing) return {};
  try {
    const data: unknown = parseYaml(rest.slice(0, closing.index), {
      maxAliasCount: 10,
      logLevel: "error",
    });
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

class Reader {
  readonly p: typeof path.posix;
  readonly context: ProbeContext;
  readonly projectKey: string | undefined;
  limited = false;
  constructor(readonly options: ClaudeAssetsOptions) {
    const platform = options.platform ?? process.platform;
    this.p = flavor(platform);
    this.context = { io: options.io ?? defaultIo, platform };
    if (!options.withoutProject) {
      const root = probe(options.root, null, this.context);
      if (root.kind === "dir")
        this.projectKey = claudeProjectKeyForm(this.p.normalize(root.real), platform);
    }
  }
  get platform() {
    return this.context.platform;
  }
  inside = (real: string) => isInside(real, this.options.root, this.platform);
  refused = (written: string, real: string) => this.options.sensitive?.(written, real) === true;

  /** A small JSON file, or undefined when it is missing, too large, a link out of `within`, or broken. */
  json(file: string, base: string | null, within?: string, limit = MAX_JSON_BYTES): unknown {
    const found = probe(file, base, this.context);
    if (found.kind !== "file" || found.size > limit) return undefined;
    if (within !== undefined && !isInside(found.real, within, this.platform)) return undefined;
    if (this.refused(file, found.real)) return undefined;
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          this.context.io.readFile(found.real, limit + 1).subarray(0, limit),
        ),
      ) as unknown;
    } catch {
      return undefined;
    }
  }

  /** Items for the Markdown files below `directory`, listed with the name and fields from their front matter. */
  markdown(
    directory: string,
    base: string | null,
    tier: AssetTier,
    origin: string,
    within?: string,
  ): AssetItem[] {
    const top = probe(directory, base, this.context);
    if (top.kind !== "dir") return [];
    if (within !== undefined && !isInside(top.real, within, this.platform)) return [];
    const walk = walkRules(top, directory, FILE_LIMITS, this.context, (real) =>
      within === undefined ? true : isInside(real, within, this.platform),
    );
    if (walk.limited) this.limited = true;
    const items: AssetItem[] = [];
    for (const file of walk.files) {
      if (within !== undefined && !isInside(file.real, within, this.platform)) continue;
      if (this.refused(file.written, file.real) || file.size > MAX_JSON_BYTES) continue;
      let data: Record<string, unknown> = {};
      try {
        data = parseFrontMatter(
          new TextDecoder("utf-8").decode(this.context.io.readFile(file.real, FRONT_MATTER_BYTES)),
        );
      } catch {
        // A file that cannot be read is listed by its name.
      }
      const stem = file.relative.replace(/\.md$/, "").split("/").join(":");
      const description = text(data.description);
      const tools = text(data.tools, 120);
      const model = text(data.model, 60);
      items.push({
        name: text(data.name, 80) ?? stem,
        ...(description ? { description } : {}),
        ...(tools ? { tools } : {}),
        ...(model ? { model } : {}),
        tier,
        origin,
        inside: this.inside(file.real),
      });
    }
    return items;
  }
}

/** Plugin ids look like `name@origin`; anything else is not trusted as a display name. */
function pluginParts(id: string): { name: string; origin: string } {
  const at = id.lastIndexOf("@");
  return at > 0 ? { name: id.slice(0, at), origin: id.slice(at + 1) } : { name: id, origin: "" };
}

/** A path from a plugin manifest: relative, inside the plugin, without `..` or backslashes. */
function manifestPaths(value: unknown, allowRoot = false): string[] | undefined {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!items) return undefined;
  return items
    .filter((item): item is string => typeof item === "string")
    .filter((item) => !item.includes("\\") && !item.split("/").includes(".."))
    .map((item) => (allowRoot && item === "./" ? "." : item.replace(/^\.\//, "")))
    .filter((item) => item !== "" && !path.posix.isAbsolute(item))
    .slice(0, 16);
}

function resolvePluginsRoot(
  options: ClaudeAssetsOptions,
  config: ClaudeConfig,
  reader: Reader,
): string {
  const configured = options.environment.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  if (
    configured &&
    configured.trim() === configured &&
    reader.p.isAbsolute(configured) &&
    !configured.split(/[\\/]+/).includes("..") &&
    !isNetworkOrDevicePath(configured, reader.platform)
  )
    return configured;
  return claudeConfigFiles(config, reader.platform).plugins;
}

function applicableInstalls(reader: Reader, records: unknown): Record<string, unknown>[] {
  return (Array.isArray(records) ? records : []).filter(
    (record): record is Record<string, unknown> => {
      if (!isObject(record) || typeof record.installPath !== "string") return false;
      if (record.scope === "user" || record.scope === "managed") return true;
      if (record.scope !== "project" && record.scope !== "local") return false;
      const project = record.projectPath;
      if (
        reader.projectKey === undefined ||
        typeof project !== "string" ||
        project.length > 4096 ||
        !reader.p.isAbsolute(project) ||
        project.split(/[\\/]+/).includes("..") ||
        isNetworkOrDevicePath(project, reader.platform)
      )
        return false;
      // Match the canonical workspace exactly. Do not probe other projects or guess that an
      // unresolved alias belongs here. The JSON is already size-bounded; filter all its records
      // before choosing an install so unrelated projects cannot consume a prefix budget.
      return (
        claudeProjectKeyForm(reader.p.normalize(project), reader.platform) === reader.projectKey
      );
    },
  );
}

/** Skills may be declared as a collection directory or as an individual skill directory. */
function pluginSkills(reader: Reader, home: string, declared: unknown): string[] {
  const { p } = reader;
  const names: string[] = [];
  const seenFiles = new Set<string>();
  const seenFolders = new Set<string>();
  let remaining = FILE_LIMITS.entries;
  let full = false;
  const add = (directory: string): boolean => {
    const file = p.join(directory, "SKILL.md");
    const found = probe(file, null, reader.context);
    if (
      found.kind !== "file" ||
      found.size > MAX_JSON_BYTES ||
      !isInside(found.real, home, reader.platform) ||
      reader.refused(file, found.real)
    )
      return false;
    const key = pathKey(found.real, reader.platform);
    if (seenFiles.has(key)) return true;
    seenFiles.add(key);
    if (names.length === MAX_LISTED) {
      reader.limited = full = true;
      return true;
    }
    names.push(text(p.basename(directory), 80) ?? "");
    return true;
  };
  for (const relative of ["skills", ...(manifestPaths(declared, true) ?? [])]) {
    const target = p.join(home, ...relative.split("/"));
    const top = probe(target, null, reader.context);
    if (
      top.kind !== "dir" ||
      !isInside(top.real, home, reader.platform) ||
      reader.refused(target, top.real)
    )
      continue;
    const key = pathKey(top.real, reader.platform);
    if (seenFolders.has(key)) continue;
    seenFolders.add(key);
    if (!add(target)) {
      try {
        const entries = reader.context.io.readdir(top.real).sort();
        if (entries.length > remaining) reader.limited = true;
        for (const entry of entries.slice(0, remaining)) {
          remaining--;
          add(p.join(target, entry));
          if (full) break;
        }
      } catch {
        // An unreadable collection contributes no skills.
      }
    }
    if (full) break;
  }
  return names;
}

function readPlugin(
  reader: Reader,
  id: string,
  enabled: boolean,
  layer: string | undefined,
  records: unknown,
): PluginInfo {
  const { name } = pluginParts(id);
  const info: PluginInfo = {
    id,
    name,
    enabled,
    ...(layer ? { layer } : {}),
    installed: false,
    commands: [],
    agents: [],
    outputStyles: [],
    skills: [],
    hooks: [],
    mcp: [],
  };
  const candidates = applicableInstalls(reader, records);
  // The user's own and organization installs first; project and local ones are for one project.
  candidates.sort(
    (left, right) =>
      Number(["user", "managed"].includes(String(right.scope))) -
      Number(["user", "managed"].includes(String(left.scope))),
  );
  const record = candidates[0];
  if (!record) return info;
  info.installed = true;
  if (typeof record.version === "string") info.version = text(record.version, 40);
  const written = record.installPath as string;
  const { p } = reader;
  if (
    written.length > 4096 ||
    !p.isAbsolute(written) ||
    written.split(/[\\/]+/).includes("..") ||
    isNetworkOrDevicePath(written, reader.platform)
  ) {
    info.problem = "the install path is not usable";
    return info;
  }
  const top = probe(written, null, reader.context);
  if (top.kind !== "dir" || reader.refused(written, top.real)) {
    info.problem = top.kind === "missing" ? "not found on disk" : "could not be read";
    return info;
  }
  const home = top.real;
  const manifest = reader.json(p.join(home, ".claude-plugin", "plugin.json"), null, home);
  const declared = isObject(manifest) ? manifest : {};
  if (typeof declared.version === "string" && !info.version)
    info.version = text(declared.version, 40);

  // Components. A manifest path replaces the default folder; an unusable path lists nothing.
  const folder = (declaredPaths: unknown, fallback: string) => {
    const custom = manifestPaths(declaredPaths);
    return custom && custom.length ? custom : [fallback];
  };
  const listMarkdown = (relatives: string[]) =>
    relatives.flatMap((relative) => {
      const target = p.join(home, ...relative.split("/"));
      if (relative.endsWith(".md")) {
        const found = probe(target, null, reader.context);
        if (
          found.kind !== "file" ||
          found.size > MAX_JSON_BYTES ||
          !isInside(found.real, home, reader.platform) ||
          reader.refused(target, found.real)
        )
          return [];
        let data: Record<string, unknown> = {};
        try {
          data = parseFrontMatter(
            new TextDecoder("utf-8").decode(
              reader.context.io.readFile(found.real, FRONT_MATTER_BYTES),
            ),
          );
        } catch {
          // Listed by its name.
        }
        const description = text(data.description);
        return [
          {
            name: text(data.name, 80) ?? path.posix.basename(relative, ".md"),
            ...(description ? { description } : {}),
            tier: "plugin" as const,
            origin: id,
            inside: false,
          },
        ];
      }
      return reader.markdown(target, null, "plugin", id, home);
    });
  info.commands =
    isObject(declared.commands) && !Array.isArray(declared.commands)
      ? Object.keys(declared.commands)
          .slice(0, MAX_LISTED)
          .map((key) => ({
            name: text(key, 80) ?? "",
            tier: "plugin" as const,
            origin: id,
            inside: false,
          }))
      : listMarkdown(folder(declared.commands, "commands"));
  info.agents = listMarkdown(folder(declared.agents, "agents"));
  info.outputStyles = listMarkdown(folder(declared.outputStyles, "output-styles"));
  info.skills = pluginSkills(reader, home, declared.skills);

  // Hooks and MCP servers merge: the default file first, then what the manifest declares.
  const hookSources: unknown[] = [reader.json(p.join(home, "hooks", "hooks.json"), null, home)];
  const mcpSources: { file: string; value: unknown }[] = [
    { file: p.join(home, ".mcp.json"), value: reader.json(p.join(home, ".mcp.json"), null, home) },
  ];
  const manifestFile = p.join(home, ".claude-plugin", "plugin.json");
  for (const entry of Array.isArray(declared.hooks) ? declared.hooks : [declared.hooks]) {
    if (typeof entry === "string") {
      const relative = manifestPaths(entry)?.[0];
      if (relative && relative.endsWith(".json"))
        hookSources.push(reader.json(p.join(home, ...relative.split("/")), null, home));
    } else if (isObject(entry)) hookSources.push({ hooks: entry });
  }
  for (const entry of Array.isArray(declared.mcpServers)
    ? declared.mcpServers
    : [declared.mcpServers]) {
    if (typeof entry === "string") {
      const relative = manifestPaths(entry)?.[0];
      if (relative && relative.endsWith(".json")) {
        const file = p.join(home, ...relative.split("/"));
        mcpSources.push({ file, value: reader.json(file, null, home) });
      }
    } else if (isObject(entry))
      mcpSources.push({ file: manifestFile, value: { mcpServers: entry } });
  }
  for (const source of hookSources)
    info.hooks.push(
      ...summarizeHooks(
        isObject(source) && isObject(source.hooks) ? source.hooks : undefined,
        `plugin:${id}`,
      ),
    );
  const mergedMcp = new Map<string, { file: string; server: unknown }>();
  for (const { file, value } of mcpSources) {
    // Plugin files accept either a server map or the usual mcpServers wrapper. A present
    // but malformed wrapper must not become a server named "mcpServers" (or expose siblings).
    const servers = !isObject(value)
      ? undefined
      : Object.hasOwn(value, "mcpServers")
        ? isObject(value.mcpServers)
          ? value.mcpServers
          : undefined
        : value;
    for (const [name, server] of Object.entries(servers ?? {}))
      mergedMcp.set(name, { file, server });
  }
  // Resolve overrides before the MCP scanner assigns identities and deduplicates candidates.
  // Keep each winning definition's source so the view points to the effective configuration.
  const byFile = new Map<string, Array<[string, unknown]>>();
  for (const [name, { file, server }] of mergedMcp) {
    const entries = byFile.get(file) ?? [];
    entries.push([name, server]);
    byFile.set(file, entries);
  }
  info.mcp = [...byFile].map(([file, entries]) => ({
    plugin: id,
    file,
    servers: Object.fromEntries(entries),
  }));
  return info;
}

/**
 * The plugins that settings enable (and the installed ones that they do not), and, unless asked
 * not to, the commands, agents, output styles and workflows of the project and the user.
 */
export function readClaudeAssets(options: ClaudeAssetsOptions): ClaudeAssets {
  const empty: ClaudeAssets = {
    plugins: [],
    installedOnly: [],
    marketplaces: 0,
    commands: [],
    agents: [],
    outputStyles: [],
    workflows: [],
    limited: false,
  };
  if (options.mode === "none") return empty;
  const reader = new Reader(options);
  const { p } = reader;
  const home = userHome(options.environment);
  const config = options.config ?? resolveClaudeConfig(options.environment, home, reader.platform);
  const files = claudeConfigFiles(config, reader.platform);
  const result = empty;

  // Plugins: what settings enable, matched against the install records.
  const root = resolvePluginsRoot(options, config, reader);
  const installed = reader.json(
    p.join(root, "installed_plugins.json"),
    null,
    undefined,
    MAX_RECORD_BYTES,
  );
  const records =
    isObject(installed) && isObject(installed.plugins)
      ? (installed.plugins as Record<string, unknown>)
      : {};
  const known = reader.json(p.join(root, "known_marketplaces.json"), null);
  result.marketplaces = isObject(known) ? Object.keys(known).length : 0;
  const enabledMap = options.settings.enabledPlugins();
  const wanted = [...enabledMap].filter(([, state]) => state.enabled).map(([id]) => id);
  const wantedIds = new Set(wanted);
  for (const id of wanted.slice(0, MAX_PLUGINS)) {
    const state = enabledMap.get(id)!;
    result.plugins.push(
      readPlugin(
        reader,
        id,
        true,
        state.layer,
        Object.hasOwn(records, id) ? records[id] : undefined,
      ),
    );
  }
  if (wanted.length > MAX_PLUGINS) reader.limited = true;
  result.installedOnly = Object.keys(records)
    .filter((id) => !wantedIds.has(id) && applicableInstalls(reader, records[id]).length > 0)
    .slice(0, MAX_LISTED)
    .map((id) => text(id, 80) ?? "");

  if (!options.pluginsOnly) {
    // Project folders from the root to the working directory, then the user's.
    const collect = (kind: "commands" | "agents" | "output-styles") => {
      const items: AssetItem[] = [];
      for (const dir of options.dirs)
        items.push(...reader.markdown(p.join(dir, ".claude", kind), dir, "project", "project"));
      const user =
        kind === "commands"
          ? files.commands
          : kind === "agents"
            ? files.agents
            : files.outputStyles;
      items.push(...reader.markdown(user, null, "user", "user"));
      return items;
    };
    result.commands = collect("commands");
    result.agents = collect("agents");
    result.outputStyles = collect("output-styles");
    // Dynamic workflows are scripts: only their names are listed.
    const workflowDirs: [string, string | null, AssetTier][] = [
      ...options.dirs.map((dir): [string, string | null, AssetTier] => [
        p.join(dir, ".claude", "workflows"),
        dir,
        "project",
      ]),
      [files.workflows, null, "user"],
    ];
    for (const [directory, base, tier] of workflowDirs) {
      const found = probe(directory, base, reader.context);
      if (found.kind !== "dir") continue;
      let names: string[] = [];
      try {
        names = reader.context.io.readdir(found.real);
      } catch {
        continue;
      }
      for (const name of names
        .filter((entry) => entry.endsWith(".js"))
        .sort()
        .slice(0, MAX_WORKFLOWS)) {
        const file = p.join(found.real, name);
        if (reader.refused(file, file)) continue;
        result.workflows.push({
          name: text(name.slice(0, -3), 80) ?? "",
          tier,
          origin: tier,
          inside: reader.inside(found.real),
        });
      }
    }
  }
  result.limited = reader.limited;
  return result;
}

// ---- text ------------------------------------------------------------------------------------

export interface AssetBlock {
  /** Names the block in the Context page. */
  title: string;
  content: string;
}

const where = (item: AssetItem) => (item.tier === "plugin" ? `plugin ${item.origin}` : item.tier);
function itemLine(item: AssetItem): string {
  const extra = [item.tools ? `tools: ${item.tools}` : "", item.model ? `model: ${item.model}` : ""]
    .filter(Boolean)
    .join("; ");
  return `- ${item.name} [${where(item)}]${item.description ? ` - ${item.description}` : ""}${extra ? ` (${extra})` : ""}`;
}
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Lists for the app (everything) or for the MCP tool (`metadata`: the project's own items by name
 * and description, and only counts for the user's items and for plugins, which are personal).
 */
export function describeAssets(
  assets: ClaudeAssets,
  settings: ClaudeSettings,
  view: "full" | "metadata",
): { blocks: AssetBlock[]; notes: string[] } {
  const full = view === "full";
  const blocks: AssetBlock[] = [];
  const notes: string[] = [];
  const categories: [string, AssetItem[], string][] = [
    ["Claude Code commands", assets.commands, "command"],
    ["Claude Code agents", assets.agents, "agent"],
    ["Claude Code output styles", assets.outputStyles, "output style"],
    ["Claude Code workflows", assets.workflows, "workflow"],
  ];
  for (const [title, items, noun] of categories) {
    const shown = items.filter((item) => full || (item.tier === "project" && item.inside));
    const hidden = items.length - shown.length;
    if (shown.length)
      blocks.push({
        title,
        content: [
          ...shown.slice(0, MAX_LISTED * 3).map(itemLine),
          ...(shown.length > MAX_LISTED * 3 ? [`… (+${shown.length - MAX_LISTED * 3} more)`] : []),
        ].join("\n"),
      });
    if (hidden)
      notes.push(
        `${title}: ${plural(hidden, noun)} outside the workspace (user level or linked from outside); their details are not included in this result.`,
      );
  }

  const hooks = [...settings.hooks(), ...assets.plugins.flatMap((plugin) => plugin.hooks)];
  const pluginHooks = assets.plugins.reduce((sum, plugin) => sum + plugin.hooks.length, 0);
  if (full && hooks.length)
    blocks.push({
      title: "Claude Code hooks",
      content: hooks
        .slice(0, MAX_LISTED * 3)
        .map(
          (hook) =>
            `- ${hook.event}${hook.matcher ? ` [${hook.matcher}]` : ""}: ${hook.type}${hook.detail ? ` ${hook.detail}` : ""} (${hook.layer})`,
        )
        .join("\n"),
    });
  else if (!full && pluginHooks)
    notes.push(
      `Claude Code hooks: ${plural(pluginHooks, "hook")} from plugins; their commands are not included in this result.`,
    );

  if (assets.plugins.length || assets.installedOnly.length || assets.marketplaces) {
    if (full) {
      const lines: string[] = [];
      for (const plugin of assets.plugins) {
        const parts = [
          plural(plugin.commands.length, "command"),
          plural(plugin.agents.length, "agent"),
          plural(plugin.skills.length, "skill"),
          plural(plugin.outputStyles.length, "output style"),
          plural(plugin.hooks.length, "hook"),
          plural(
            plugin.mcp.reduce((sum, entry) => sum + Object.keys(entry.servers).length, 0),
            "MCP server",
          ),
        ];
        lines.push(
          `- ${plugin.id}${plugin.version ? ` ${plugin.version}` : ""}: enabled${plugin.layer ? ` (${plugin.layer} settings)` : ""}${
            plugin.installed ? "" : ", not installed"
          }${plugin.problem ? `, ${plugin.problem}` : `; ${parts.join(", ")}`}`,
        );
        const named = (label: string, items: string[]) => {
          if (items.length) lines.push(`    ${label}: ${items.slice(0, MAX_LISTED).join(", ")}`);
        };
        named(
          "commands",
          plugin.commands.map((item) => item.name),
        );
        named(
          "agents",
          plugin.agents.map((item) => item.name),
        );
        named("skills", plugin.skills);
        named(
          "output styles",
          plugin.outputStyles.map((item) => item.name),
        );
        named(
          "MCP servers",
          plugin.mcp.flatMap((entry) =>
            Object.keys(entry.servers).map((key) => text(key, 80) ?? ""),
          ),
        );
      }
      if (assets.installedOnly.length)
        lines.push(`Installed, not enabled: ${assets.installedOnly.join(", ")}`);
      if (assets.marketplaces) lines.push(`Marketplaces fetched: ${assets.marketplaces}`);
      lines.push(
        "Not listed: skills (see the skills page), LSP servers, monitors, themes, channels and executables of plugins.",
      );
      blocks.push({ title: "Claude Code plugins", content: lines.join("\n") });
    } else {
      const count = (pick: (plugin: PluginInfo) => number) =>
        assets.plugins.reduce((sum, plugin) => sum + pick(plugin), 0);
      notes.push(
        `Claude Code plugins: ${plural(assets.plugins.length, "plugin")} enabled, ${assets.installedOnly.length + assets.plugins.filter((plugin) => plugin.installed).length} installed, providing ${plural(
          count((plugin) => plugin.commands.length),
          "command",
        )}, ${plural(
          count((plugin) => plugin.agents.length),
          "agent",
        )}, ${plural(
          count((plugin) => plugin.outputStyles.length),
          "output style",
        )}, ${plural(
          count((plugin) => plugin.hooks.length),
          "hook",
        )} and ${plural(
          count((plugin) =>
            plugin.mcp.reduce((sum, entry) => sum + Object.keys(entry.servers).length, 0),
          ),
          "MCP server",
        )}; their details are not included in this result.`,
      );
    }
  }
  if (assets.limited)
    notes.push("Some asset folders hold more files than AgentKib lists; the lists are incomplete.");
  return { blocks, notes };
}
