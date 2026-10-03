import path from "node:path";
import { z } from "zod";
import { canonicalProject, within } from "./files";
import { canonicalize } from "./paths";
import { loadManifest, manifestPath, type Manifest } from "./manifest";
import { agentSchema, parameters } from "./rpc";
import { Catalog } from "./catalog";
import { Commands } from "./commands";
import { sources } from "./context-sources";
import { antigravitySources } from "./context-antigravity";
import { budgetWarning, loadImports, TOTAL_CHARS } from "./context-files";
import {
  deepseekRoot,
  deepseekSections,
  deepseekSkills,
  grokSections,
  type Section,
} from "./context-special";
import { visibleMcpNames } from "./mcp-config-read";
export class Context {
  constructor(
    readonly catalog: Catalog,
    readonly commands: Commands,
    readonly environment: NodeJS.ProcessEnv,
  ) {}
  async request(value: unknown) {
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
    const preview = await this.resolve(project, cwd, agent, manifest, memories);
    preview.visible_connections = visibleMcpNames(project, agent, this.environment);
    return preview;
  }
  async resolve(
    project: string,
    workingDirectory: string,
    agent: string,
    manifest: Manifest | null,
    approvedMemories: string[],
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
    if (agent === "deepseek-harness")
      sections = deepseekSections(contextRoot, dirs, warnings, this.environment);
    else if (agent === "grok-build")
      sections = await grokSections(root, dirs, warnings, this.environment, this.commands);
    else {
      const files =
          agent === "antigravity"
            ? antigravitySources(dirs, warnings, this.environment)
            : sources(agent, dirs, warnings, this.environment),
        budget = { remaining: TOTAL_CHARS };
      for (const source of files) {
        if (!budget.remaining) {
          budgetWarning(warnings);
          break;
        }
        const external = ["opencode", "antigravity"].includes(agent) && !within(source, root);
        let externalRoot: string | null = null;
        try {
          if (external) externalRoot = canonicalize(path.dirname(source));
        } catch {}
        const start = warnings.length;
        try {
          const content = loadImports(source, externalRoot ?? root, budget, warnings);
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
    const hasProject = sections.some((section) => section.scope !== "agent-home");
    if (!hasProject) warnings.push("No project instruction file was found for this Agent");
    const override =
      manifest?.instructions.platform_overrides[agent as z.infer<typeof agentSchema>];
    if (
      override?.trim() &&
      !sections.some((section) => section.content.includes(override.trim()))
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
      visible_skills:
        agent === "deepseek-harness"
          ? deepseekSkills(contextRoot, this.environment)
          : (manifest?.skills
              .filter(
                (skill) =>
                  !skill.targets.length ||
                  skill.targets.includes(agent as z.infer<typeof agentSchema>),
              )
              .map((skill) => skill.name) ?? []),
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
