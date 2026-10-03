import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { globMatches } from "./context-glob";
import { inspectSkill } from "./asset-scanner";
import { isFile, readText, walk } from "./files";
import {
  loadManifest,
  manifestPath,
  manifestSchema,
  manifestWire,
  type Manifest,
} from "./manifest";
import { AGENTS } from "./rpc";
import { compareUtf8 } from "./workspaces";
export const MANAGED_START = "<!-- agentkib:managed:start -->";
export const MANAGED_END = "<!-- agentkib:managed:end -->";
export function managedContent(content: string): string | null {
  const start = content.indexOf(MANAGED_START);
  if (start < 0) return null;
  const rest = content.slice(start + MANAGED_START.length),
    end = rest.indexOf(MANAGED_END);
  return end < 0 ? null : rest.slice(0, end).trim();
}
function optionalRead(value: string): string | null {
  try {
    return readText(value, Infinity, false);
  } catch {
    return null;
  }
}
function importsAgents(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === "@AGENTS.md");
}
function delta(shared: string, content: string): string | null {
  shared = shared.trim();
  content = content.trim();
  if (!content || content === shared) return null;
  return content.startsWith(shared) && content.slice(shared.length).trim()
    ? content.slice(shared.length).trim()
    : content;
}
export function openCodeInstructionPatterns(project: string): string[] {
  const result: string[] = [];
  for (const name of [
    "opencode.json",
    "opencode.jsonc",
    ".opencode/opencode.json",
    ".opencode/opencode.jsonc",
  ]) {
    try {
      const content = readText(path.join(project, name));
      const value = name.endsWith(".jsonc") ? JSON5.parse(content) : JSON.parse(content);
      if (Array.isArray(value.instructions))
        for (const item of value.instructions)
          if (typeof item === "string" && !result.includes(item)) result.push(item);
    } catch {}
  }
  return result;
}
export function openCodeManagedRegistered(project: string): boolean {
  return openCodeInstructionPatterns(project).some((pattern) =>
    globMatches(pattern.replace(/^(?:\.\/)+/, ""), ".opencode/agentkib-instructions.md"),
  );
}
export function prepareManifest(project: string) {
  return manifestWire(
    isFile(manifestPath(project)) ? loadManifest(project) : defaultManifest(project),
  );
}
export function defaultManifest(project: string): Manifest {
  const root = project,
    agents = optionalRead(path.join(root, "AGENTS.md")),
    claude = optionalRead(path.join(root, "CLAUDE.md")),
    gemini = optionalRead(path.join(root, "GEMINI.md"));
  const shared =
    agents ??
    (claude !== null && !importsAgents(claude) ? claude : null) ??
    (gemini !== null && !importsAgents(gemini) ? gemini : null) ??
    "";
  const overrides: Manifest["instructions"]["platform_overrides"] = {};
  const override = optionalRead(path.join(root, "AGENTS.override.md"));
  if (override !== null) {
    const value = delta(shared, override);
    if (value) overrides.codex = value;
  }
  if (agents !== null && claude !== null) {
    const value = (
      importsAgents(claude)
        ? claude
            .split(/\r?\n/)
            .filter(
              (line) =>
                ![
                  "@AGENTS.md",
                  "Claude Code uses AGENTS.md as the shared project instructions.",
                ].includes(line.trim()),
            )
            .join("\n")
        : claude
    ).trim();
    if (value) overrides["claude-code"] = value;
  }
  if (agents !== null && gemini !== null) {
    let content = gemini;
    const managed = managedContent(agents);
    if (managed !== null && content.startsWith(managed)) {
      const rest = content.slice(managed.length);
      if (!rest || /^\s/.test(rest)) content = rest.trimStart();
    }
    const value = (
      managedContent(content) ??
      (importsAgents(content)
        ? content
            .split(/\r?\n/)
            .filter((line) => line.trim() !== "@AGENTS.md")
            .join("\n")
        : content)
    ).trim();
    if (value) overrides.antigravity = value;
  }
  for (const [agent, name] of [
    ["cursor", ".cursor/rules/agentkib.mdc"],
    ["opencode", ".opencode/agentkib-instructions.md"],
  ] as const) {
    if (agent === "opencode" && !openCodeManagedRegistered(root)) continue;
    const content = optionalRead(path.join(root, name)),
      value = content === null ? null : managedContent(content);
    if (value?.trim()) overrides[agent] = value;
  }
  const hermes =
    optionalRead(path.join(root, ".hermes.md")) ?? optionalRead(path.join(root, "HERMES.md"));
  if (hermes !== null) {
    const value = delta(shared, hermes);
    if (value) overrides.hermes = value;
  }
  const skills: Manifest["skills"] = [];
  try {
    for (const entry of readdirSync(path.join(root, ".agents/skills"), { withFileTypes: true })) {
      try {
        const skill = inspectSkill(path.join(root, ".agents/skills", entry.name, "SKILL.md"));
        skills.push({ name: skill.name, path: `.agents/skills/${entry.name}`, targets: [] });
      } catch {}
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  skills.sort((a, b) => compareUtf8(a.name, b.name));
  const scoped = walk(
    root,
    8,
    (value, directory) =>
      !directory ||
      ![".git", ".agentkib", "node_modules", "target", "dist"].includes(path.basename(value)),
    true,
  )
    .filter((value) => path.basename(value) === "AGENTS.md" && path.dirname(value) !== root)
    .map((value) => ({
      path: path.relative(root, path.dirname(value)).split(path.sep).join("/"),
      content: readText(value, Infinity, false),
    }))
    .sort((a, b) => compareUtf8(a.path, b.path));
  return manifestSchema.parse({
    schema_version: 2,
    workspace: { id: randomUUID(), name: path.basename(root) || "workspace" },
    instructions: { shared, scoped, platform_overrides: overrides },
    skills,
    adapters: Object.fromEntries(
      AGENTS.filter((agent) => agent !== "deepseek-harness").map((agent) => [
        agent,
        { enabled: true, generated_hashes: {} },
      ]),
    ),
  });
}
