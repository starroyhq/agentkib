import path from "node:path";
import { readdirSync } from "node:fs";
import { z } from "zod";
import { canonicalProject, within } from "./files";
import { canonicalize } from "./paths";
import { loadManifest, manifestPath, type Manifest } from "./manifest";
import { agentSchema, parameters } from "./rpc";
import { Catalog } from "./catalog";
import { Commands } from "./commands";
import { sources } from "./context-sources";
import { antigravitySources } from "./context-antigravity";
import { claudeSections, stripBlockComments } from "./context-claude";
import { readClaudeVersion } from "./claude-version";
import {
  CONTEXT_NOTE_PREFIX,
  budgetWarning,
  isProjectScope,
  loadImports,
  TOTAL_CHARS,
} from "./context-files";
import {
  defaultIo,
  isInside,
  isNetworkOrDevicePath,
  pathKey,
  probe,
  type ClaudeIo,
} from "./context-claude-sources";
import {
  deepseekRoot,
  deepseekSections,
  deepseekSkills,
  grokSections,
  type Section,
} from "./context-special";
import { userHome, visibleMcpNames } from "./mcp-config-read";
import { SkillManager } from "./skill-manager";
export interface ContextOptions {
  /**
   * Whether the contents of Claude Code sources outside the workspace are returned: imports
   * outside the project, and the user-level, managed, parent-directory and auto memory files.
   * In-process only, never part of an RPC payload: the MCP tool turns it off, so a connected
   * Agent gets sizes and counts but no text and no paths, and cannot read through the preview
   * what Claude Code itself would ask the user about or what is private to the user.
   */
  externalBodies?: boolean;
  /**
   * Whether Claude Code sources outside the workspace are looked at at all. In-process only.
   * The Doctor turns it off, so that files it does not manage can never become a finding.
   */
  includeOutsideSources?: boolean;
}
/** Test seams for the Claude Code sources; the application never sets them. */
export interface ClaudeContextInternals {
  /** Where organization policy files live; `null` for none. */
  managedDir?: string | null;
  platform?: NodeJS.Platform;
  io?: ClaudeIo;
  ancestorRules?: boolean;
}
export class Context {
  #version?: { at: number; value: string | null };
  #probe?: Promise<string | null>;
  constructor(
    readonly catalog: Catalog,
    readonly commands: Commands,
    readonly environment: NodeJS.ProcessEnv,
    readonly claude: ClaudeContextInternals = {},
  ) {}
  /** `claude --version`, cached for 30 seconds; concurrent callers share one probe. */
  #claudeVersion(): Promise<string | null> {
    if (this.#version && Date.now() - this.#version.at < 30_000)
      return Promise.resolve(this.#version.value);
    this.#probe ??= readClaudeVersion(this.commands, this.environment)
      .then((value) => {
        this.#version = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.#probe = undefined;
      });
    return this.#probe;
  }
  async request(value: unknown, options: ContextOptions = {}) {
    const { project, cwd, agent } = parameters(
      z.object({ project: z.string(), cwd: z.string(), agent: agentSchema }),
      value,
    );
    let manifest: Manifest | null = null;
    try {
      manifest = loadManifest(project);
    } catch {}
    let memories: string[] = [];
    if (manifest)
      try {
        memories = this.catalog
          .memories(manifest.workspace.id, "approved")
          .map((value) => value.content);
      } catch {}
    const preview = await this.resolve(project, cwd, agent, manifest, memories, options);
    preview.visible_connections = visibleMcpNames(project, agent, this.environment);
    return preview;
  }
  async resolve(
    project: string,
    workingDirectory: string,
    agent: string,
    manifest: Manifest | null,
    approvedMemories: string[],
    options: ContextOptions = {},
  ) {
    const root = canonicalProject(project),
      requested = path.isAbsolute(workingDirectory)
        ? workingDirectory
        : path.join(root, workingDirectory);
    let cwd: string;
    try {
      cwd = canonicalize(requested);
    } catch {
      throw new Error(`Working directory does not exist: ${requested}`);
    }
    if (!within(cwd, root)) throw new Error("Working directory must be inside the project");
    const contextRoot = agent === "deepseek-harness" ? deepseekRoot(root, cwd) : root,
      dirs: string[] = [];
    for (let current = cwd; ; current = path.dirname(current)) {
      dirs.unshift(current);
      if (current === contextRoot) break;
      if (path.dirname(current) === current)
        throw new Error("Working directory must be inside the project");
    }
    const warnings: string[] = [];
    let sections: Section[] = [];
    // Other Agents read Claude Code's personal folder too (OpenCode reads ~/.claude/CLAUDE.md, Grok
    // Build its CLAUDE.md and rules). Over MCP those files are personal content of another tool,
    // so the connected Agent gets their number and size, and neither text nor path.
    const personal = new PersonalClaudeFiles(
      agent !== "claude-code" && options.externalBodies === false,
      this.environment,
    );
    // Discovery also reads activation rules and instruction configuration. Apply the same
    // check there and to nested imports, before any of those reads can affect the preview.
    const skipPersonal = (file: string) => personal.skips(file);
    if (agent === "deepseek-harness")
      sections = deepseekSections(contextRoot, dirs, warnings, this.environment, skipPersonal);
    else if (agent === "grok-build")
      sections = await grokSections(
        root,
        dirs,
        warnings,
        this.environment,
        this.commands,
        skipPersonal,
      );
    else if (agent === "claude-code")
      sections = await claudeSections({
        root,
        cwd,
        dirs,
        environment: this.environment,
        budget: { remaining: TOTAL_CHARS },
        warnings,
        externalBodies: options.externalBodies !== false,
        // Both off means the stricter one: the Doctor never touches the outside.
        outside:
          options.includeOutsideSources === false
            ? "none"
            : options.externalBodies === false
              ? "metadata"
              : "full",
        version: () => this.#claudeVersion(),
        ...this.claude,
      });
    else {
      const files =
          agent === "antigravity"
            ? antigravitySources(dirs, warnings, this.environment, skipPersonal)
            : sources(agent, dirs, warnings, this.environment, skipPersonal),
        budget = { remaining: TOTAL_CHARS };
      for (const source of files) {
        if (!budget.remaining) {
          budgetWarning(warnings);
          break;
        }
        if (personal.skips(source)) continue;
        const external =
          ["opencode", "antigravity", "devin"].includes(agent) && !within(source, root);
        let externalRoot: string | null = null;
        try {
          if (external) externalRoot = canonicalize(path.dirname(source));
        } catch {}
        const start = warnings.length;
        try {
          const content = loadImports(
            source,
            externalRoot ?? root,
            budget,
            warnings,
            new Set(),
            0,
            skipPersonal,
          );
          sections.push({
            source,
            scope: external ? "agent-home" : path.relative(root, path.dirname(source)),
            content,
            precedence: sections.length,
          });
        } catch (error) {
          warnings.push((error as Error).message);
        }
        if (external)
          for (let i = start; i < warnings.length; i++) warnings[i] = `Agent home: ${warnings[i]}`;
      }
    }
    const legacyDeclaredSkills =
      manifest?.skills
        .filter(
          (skill) =>
            !skill.targets.length || skill.targets.includes(agent as z.infer<typeof agentSchema>),
        )
        .map((skill) => skill.name) ?? [];
    const skills =
      agent === "deepseek-harness"
        ? deepseekSkills(contextRoot, this.environment, skipPersonal)
        : options.externalBodies === false || options.includeOutsideSources === false
          ? workspaceSkillNames(contextRoot, dirs, agent, this.environment, skipPersonal, warnings)
          : await nativeSkillNames(contextRoot, dirs, agent, this.environment, warnings);
    personal.report(warnings);
    const hasProject = sections.some((section) => isProjectScope(agent, section.scope));
    if (!hasProject) warnings.push("No project instruction file was found for this Agent");
    const override =
      manifest?.instructions.platform_overrides[agent as z.infer<typeof agentSchema>];
    // Claude Code drops block-level HTML comments from CLAUDE.md files, so the preview text may
    // lack a comment the override has; both sides are compared without them.
    const plain = agent === "claude-code" ? stripBlockComments : (text: string) => text;
    // For Claude Code only the project's own sources can carry the override; what is outside the
    // workspace is not there in every mode, and must not change the answer.
    const counts = (section: Section) =>
      agent !== "claude-code" || isProjectScope(agent, section.scope);
    if (
      override?.trim() &&
      !sections.some(
        (section) => counts(section) && plain(section.content).includes(plain(override.trim())),
      )
    ) {
      if (hasProject)
        warnings.push(
          "The platform override is applied after native project instructions; check for semantic conflicts",
        );
      sections.push({
        source: manifestPath(root),
        scope: "platform-override",
        content: override,
        precedence: sections.length,
      });
    }
    return {
      agent,
      project: contextRoot,
      cwd,
      sections,
      visible_skills: skills,
      legacy_declared_skills: legacyDeclaredSkills,
      visible_connections:
        agent === "deepseek-harness"
          ? []
          : (manifest?.connections
              .filter(
                (connection) =>
                  !connection.targets.length ||
                  connection.targets.includes(agent as z.infer<typeof agentSchema>),
              )
              .map((connection) => connection.name) ?? []),
      approved_memories: agent === "deepseek-harness" ? [] : approvedMemories,
      warnings,
    };
  }
}

async function nativeSkillNames(
  root: string,
  directories: string[],
  agent: string,
  environment: NodeJS.ProcessEnv,
  warnings: string[],
): Promise<string[]> {
  const library =
    environment.AGENTKIB_HOME ??
    path.join(
      userHome(environment),
      environment.AGENTKIB_APP_FLAVOR === "ai.agentkib.dev" ? ".agentkib-dev" : ".agentkib",
    );
  try {
    const inventory = await new SkillManager(library, environment, () =>
      directories.map((directory, index) => ({ id: `context-${index}`, path: directory })),
    ).inventory();
    const names = inventory.observations
      .filter((observation) => {
        if (!observation.agents.includes(agent as (typeof observation.agents)[number]))
          return false;
        if (
          ["broken-link", "native-restricted", "pending-trust", "unverified"].includes(
            observation.status,
          )
        )
          return false;
        // Shared roots retain a common status; native restrictions remain Agent-specific
        // diagnostics, including Hermes profile trust and OpenClaw per-Agent allowlists.
        if (agent === "hermes") {
          const conditions = observation.diagnostics.filter((line) =>
            /^Hermes(?::| profile )/.test(line),
          );
          return (
            !conditions.some(
              (line) =>
                (line.startsWith("Hermes:") &&
                  /no Git root|not this nested project directory/.test(line)) ||
                /: project discovery is disabled in config.yaml$|: project trust is unknown because config.yaml could not be read$/.test(
                  line,
                ),
            ) &&
            !(
              conditions.length > 0 &&
              conditions.every((line) =>
                line.endsWith(
                  ": Git root is not trusted; run hermes skills trust yourself before native loading",
                ),
              )
            )
          );
        }
        if (agent === "open-claw") {
          const conditions = observation.diagnostics.filter((line) => line.startsWith("OpenClaw"));
          if (
            conditions.some(
              (line) =>
                line.startsWith("OpenClaw:") &&
                /: this Skill name is disabled|not discoverable|is unknown/.test(line),
            )
          )
            return false;
          const agents = conditions.filter((line) => line.startsWith("OpenClaw Agent "));
          return (
            !agents.length ||
            !agents.every((line) =>
              line.endsWith(
                ": excluded by its effective skills allowlist (per-Agent settings replace defaults)",
              ),
            )
          );
        }
        const prefix = (
          { codex: "Codex:", opencode: "OpenCode:", "grok-build": "Grok:" } as Record<
            string,
            string
          >
        )[agent];
        return (
          !prefix ||
          !observation.diagnostics.some(
            (diagnostic) =>
              diagnostic.startsWith(prefix) && /disabled|deny|restrict|unknown/.test(diagnostic),
          )
        );
      })
      .map((observation) => observation.name);
    return [...new Set(names)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  } catch {
    warnings.push(
      "Note: Native Skill visibility could not be verified; legacy declarations are listed separately.",
    );
    return [];
  }
}

/** Restricted context never initializes the full inventory, which can read other tools' homes. */
function workspaceSkillNames(
  root: string,
  directories: string[],
  agent: string,
  environment: NodeJS.ProcessEnv,
  skipSource: (file: string) => boolean,
  warnings: string[],
): string[] {
  const roots: Record<string, string[]> = {
    codex: [".agents/skills"],
    "claude-code": [".claude/skills"],
    cursor: [".cursor/skills", ".agents/skills", ".claude/skills"],
    opencode: [".opencode/skills", ".opencode/skill", ".agents/skills", ".claude/skills"],
    "open-claw": ["skills", ".agents/skills"],
    hermes: [".hermes/skills", ".agents/skills"],
    "grok-build": [".grok/skills", ".agents/skills", ".claude/skills", ".cursor/skills"],
    antigravity: [".agents/skills"],
    devin: [".devin/skills", ".agents/skills", ".windsurf/skills", ".claude/skills"],
  };
  const names = new Set<string>();
  const personalRestrictions = ["codex", "opencode", "open-claw", "hermes", "grok-build"].includes(
    agent,
  );
  let discovered = 0;
  const enabled = (key: string) => ["1", "true"].includes(environment[key]?.toLowerCase() ?? "");
  const locations = (roots[agent] ?? []).filter((relative) => {
    if (agent !== "opencode") return true;
    if (
      relative === ".claude/skills" &&
      (enabled("OPENCODE_DISABLE_CLAUDE_CODE") || enabled("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"))
    )
      return false;
    if (relative.startsWith(".opencode/") && enabled("OPENCODE_DISABLE_PROJECT_CONFIG"))
      return false;
    return !enabled("OPENCODE_DISABLE_EXTERNAL_SKILLS") || relative.startsWith(".opencode/");
  });
  let inspected = 0;
  const visit = (directory: string, nested: boolean, depth: number): void => {
    if (depth > 32 || inspected >= 1024) return;
    try {
      if (!isInside(defaultIo.realpath(directory), root, process.platform)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++inspected > 1024) break;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const candidate = path.join(directory, entry.name);
        const entrypoint = path.join(candidate, "SKILL.md");
        const found = probe(entrypoint, null, { io: defaultIo, platform: process.platform });
        if (
          found.kind === "file" &&
          isInside(found.real, root, process.platform) &&
          !skipSource(entrypoint)
        ) {
          discovered++;
          // A package directory proves presence, not native enablement. These Agents can
          // restrict it in personal policy, which this preview deliberately does not read.
          if (!personalRestrictions) names.add(entry.name);
        }
        if (nested && entry.isDirectory()) visit(candidate, true, depth + 1);
      }
    } catch {
      // Missing or externally linked locations are outside this restricted view.
    }
  };
  for (const directory of directories)
    for (const relative of locations)
      visit(
        path.join(directory, relative),
        agent === "opencode" && /\.(agents|claude)\//.test(relative),
        0,
      );
  if (discovered)
    warnings.push(
      "Note: Skill visibility in this restricted preview covers workspace package directories; personal and custom-config sources were not inspected.",
    );
  if (discovered && personalRestrictions)
    warnings.push(
      "Note: Native Skill visibility could not be verified in this restricted preview; personal and custom-config restrictions were not inspected.",
    );
  return [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

const FOLDER = ".claude";
/** Files in `~/.claude` that an Agent other than Claude Code reads, held back from the MCP tool. */
class PersonalClaudeFiles {
  readonly #folders: string[] = [];
  readonly #files = new Map<string, number>();
  readonly #skipped = new Set<string>();
  #unknownFolder = false;
  #unverified = false;
  constructor(
    readonly active: boolean,
    environment: NodeJS.ProcessEnv,
  ) {
    if (!active) return;
    // The literal folder: these Agents read `~/.claude` themselves and know nothing of
    // CLAUDE_CONFIG_DIR, so this is deliberately not taken from claude-config.
    const folder = path.join(userHome(environment), FOLDER);
    this.#folders.push(folder);
    const found = this.#probe(folder);
    if (found.kind === "dir") this.#folders.push(found.real);
    // With an inaccessible identity we cannot prove an apparent Agent-owned path is not an
    // alias of the personal directory. Leave its body out rather than guessing ownership.
    else if (found.kind !== "missing") this.#unknownFolder = true;
  }
  #probe(file: string) {
    if (isNetworkOrDevicePath(file, process.platform)) return { kind: "network" } as const;
    const found = probe(file, null, { io: defaultIo, platform: process.platform });
    if (found.kind !== "file" && found.kind !== "dir") return found;
    try {
      // Normalize the filesystem's spelling too: macOS can discover CLAUDE.md and Claude.md
      // as the same file even when no symbolic link is involved.
      return { ...found, real: defaultIo.realpath(found.real) };
    } catch {
      return { kind: "unreadable" } as const;
    }
  }
  /** True for a source that is held back (and counted); nothing of it is read. */
  skips(file: string): boolean {
    if (!this.active) return false;
    const found = this.#probe(file);
    const personal = this.#folders.some(
      (folder) =>
        isInside(file, folder, process.platform) ||
        (found.kind === "file" && isInside(found.real, folder, process.platform)),
    );
    if ((found.kind === "file" || found.kind === "missing") && !personal && !this.#unknownFolder)
      return false;
    if (found.kind === "file" && personal)
      this.#files.set(pathKey(found.real, process.platform), found.size);
    else if (found.kind !== "missing") this.#unverified = true;
    this.#skipped.add(file);
    return true;
  }
  report(warnings: string[]): void {
    // Discovery warnings must not disclose the names of sources subsequently held back.
    const names = [...this.#skipped, ...this.#files.keys()];
    for (let index = warnings.length - 1; index >= 0; index--)
      if (names.some((name) => warnings[index]!.includes(name))) warnings.splice(index, 1);
    if (this.#unverified)
      warnings.push(
        `${CONTEXT_NOTE_PREFIX}Some instruction sources could not be checked against Claude Code's personal directory; their content is not included in this result.`,
      );
    if (!this.#files.size) return;
    const bytes = [...this.#files.values()].reduce((sum, size) => sum + size, 0);
    warnings.push(
      `${CONTEXT_NOTE_PREFIX}Claude Code user files that this Agent reads exist (${this.#files.size} ${this.#files.size === 1 ? "file" : "files"}, ${bytes} ${bytes === 1 ? "byte" : "bytes"}); their content is not included in this result.`,
    );
  }
}
