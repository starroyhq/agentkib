import { isReparseOrSymlink } from "./native-files";
import path from "node:path";
import { lstatSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { isFile, readBytes, readText, withinLexical } from "./files";
import { MANAGED_START } from "./default-manifest";
import { AGENTS, type agentSchema } from "./rpc";
import type { z } from "zod";
import type { Manifest } from "./manifest";
export type Agent = z.infer<typeof agentSchema>;
export type Skill = Manifest["skills"][number];
export const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
export const normalize = (value: string) =>
  value
    .split(/\p{White_Space}+/u)
    .filter(Boolean)
    .join(" ");
export function adapterEnabled(manifest: Manifest, agent: Agent): boolean {
  return (
    manifest.adapters[agent]?.enabled ?? !["opencode", "grok-build", "antigravity"].includes(agent)
  );
}
export function safeTarget(project: string, target: string): boolean {
  if (!withinLexical(target, project)) return false;
  const suffix = target.slice(project.length).replace(/^[\\/]/, "");
  const parts = (process.platform === "win32" ? suffix.split(/[\\/]/) : suffix.split("/")).filter(
    (part) => part && part !== ".",
  );
  if (parts.includes("..")) return false;
  let current = project;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]!);
    try {
      const metadata = lstatSync(current);
      if (
        isReparseOrSymlink(current, metadata) ||
        (index < parts.length - 1 && !metadata.isDirectory())
      )
        return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }
  return true;
}
export function boundedText(file: string): string | null {
  try {
    return readText(file, 8 * 1024 * 1024);
  } catch {
    return null;
  }
}
export function plannedFileSafe(project: string, target: string): boolean {
  if (!safeTarget(project, target)) return false;
  try {
    return lstatSync(target).isFile() && boundedText(target) !== null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
export function fileHash(
  file: string,
): { kind: "missing" | "unavailable"; value?: undefined } | { kind: "hashed"; value: string } {
  try {
    const bytes = readBytes(file, 8 * 1024 * 1024);
    return { kind: "hashed", value: hash(bytes) };
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" };
  }
}
// Every entry must be safe; skipping unreadable files would incorrectly allow repair.
function tree(root: string, visit: (file: string, directory: boolean) => boolean): boolean {
  const pending = [root];
  while (pending.length) {
    const file = pending.pop()!;
    try {
      const metadata = lstatSync(file);
      if (
        isReparseOrSymlink(file, metadata) ||
        (!metadata.isFile() && !metadata.isDirectory()) ||
        !visit(file, metadata.isDirectory())
      )
        return false;
      if (metadata.isDirectory())
        for (const name of readdirSync(file)) pending.push(path.join(file, name));
    } catch {
      return false;
    }
  }
  return true;
}
export function skillFiles(project: string, source: string): Map<string, string> | null {
  if (!safeTarget(project, source)) return null;
  const files = new Map<string, string>();
  let total = 0;
  const add = (file: string, key: string) => {
    try {
      if (files.size >= 512) return false;
      const bytes = readBytes(file, 8 * 1024 * 1024);
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      total += bytes.length;
      if (total > 32 * 1024 * 1024) return false;
      files.set(key, hash(bytes));
      return true;
    } catch {
      return false;
    }
  };
  if (isFile(source)) {
    if (path.basename(source) !== "SKILL.md" || !add(source, "SKILL.md")) return null;
    return files;
  }
  if (
    !tree(source, (file, directory) => directory || add(file, path.relative(source, file))) ||
    !files.has("SKILL.md")
  )
    return null;
  return files;
}
const roots: Record<Agent, string[]> = {
  codex: [".agents/skills"],
  "claude-code": [".claude/skills"],
  cursor: [".cursor/skills", ".agents/skills"],
  opencode: [".opencode/skills", ".claude/skills", ".agents/skills"],
  "open-claw": ["skills", ".agents/skills"],
  hermes: [".agents/skills"],
  "grok-build": [".grok/skills", ".agents/skills", ".claude/skills", ".cursor/skills"],
  antigravity: [".agents/skills"],
  "deepseek-harness": [".dsh/skills", ".agents/skills"],
};
const equal = (a: Map<string, string> | null, b: Map<string, string>) =>
  a !== null && a.size === b.size && [...b].every(([key, value]) => a.get(key) === value);
export function cursorSkillRoot(manifest: Manifest, skill: Skill): string {
  return ["codex", "opencode", "open-claw", "hermes", "antigravity"].some(
    (agent) =>
      adapterEnabled(manifest, agent as Agent) &&
      (!skill.targets.length || skill.targets.includes(agent as Agent)),
  )
    ? ".agents/skills"
    : ".cursor/skills";
}
export function skillCurrent(
  project: string,
  manifest: Manifest,
  agent: Agent,
  skill: Skill,
): boolean {
  const source = skillFiles(project, path.join(project, skill.path));
  if (!source) return false;
  if (["cursor", "opencode", "open-claw"].includes(agent)) {
    const expected = agent === "cursor" ? cursorSkillRoot(manifest, skill) : ".agents/skills";
    if (!equal(skillFiles(project, path.join(project, expected, skill.name)), source)) return false;
    return roots[agent]
      .filter((root) => root !== expected)
      .every((root) => {
        const alternate = path.join(project, root, skill.name);
        try {
          lstatSync(alternate);
          return equal(skillFiles(project, alternate), source);
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === "ENOENT";
        }
      });
  }
  return roots[agent].some((root) =>
    equal(skillFiles(project, path.join(project, root, skill.name)), source),
  );
}
export function skillRepairable(
  project: string,
  manifest: Manifest,
  agent: Agent,
  skill: Skill,
): boolean {
  const source = skillFiles(project, path.join(project, skill.path));
  if (!source || agent === "deepseek-harness") return false;
  const root =
    agent === "claude-code"
      ? ".claude/skills"
      : agent === "cursor"
        ? cursorSkillRoot(manifest, skill)
        : agent === "grok-build"
          ? ".grok/skills"
          : ".agents/skills";
  if (["cursor", "opencode", "open-claw"].includes(agent))
    for (const alternateRoot of roots[agent])
      if (alternateRoot !== root) {
        const alternate = path.join(project, alternateRoot, skill.name);
        try {
          lstatSync(alternate);
          if (!equal(skillFiles(project, alternate), source)) return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
        }
      }
  const target = path.join(project, root, skill.name);
  if (!safeTarget(project, target)) return false;
  try {
    if (!lstatSync(target).isDirectory()) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  return tree(target, (file, directory) => directory || source.has(path.relative(target, file)));
}
export function instructionRepairable(
  project: string,
  cwd: string,
  agent: Agent,
  manifest: Manifest | null,
  expected: string,
  scoped: boolean,
): boolean {
  const override = manifest?.instructions.platform_overrides[agent]?.trim(),
    platform = !scoped && cwd === project && !!override && override === expected.trim();
  if (agent === "claude-code" && !platform) {
    if (
      !manifest ||
      !AGENTS.filter((agent) => !["claude-code", "deepseek-harness"].includes(agent)).some(
        (agent) => adapterEnabled(manifest, agent),
      ) ||
      !plannedFileSafe(project, path.join(cwd, "AGENTS.md"))
    )
      return false;
  }
  let relative: string;
  if (platform) {
    const names: Partial<Record<Agent, string>> = {
      codex: "AGENTS.override.md",
      "claude-code": "CLAUDE.md",
      cursor: ".cursor/rules/agentkib.mdc",
      opencode: ".opencode/agentkib-instructions.md",
      "open-claw": "TOOLS.md",
      hermes: ".hermes.md",
      antigravity: "GEMINI.md",
    };
    if (!names[agent]) return false;
    relative = names[agent]!;
  } else if (agent === "deepseek-harness") return false;
  else if (agent === "claude-code") relative = "CLAUDE.md";
  else if (agent === "codex") {
    if (isFile(path.join(cwd, "AGENTS.override.md"))) {
      if (cwd !== project) return false;
      relative = "AGENTS.override.md";
    } else relative = "AGENTS.md";
  } else if (agent === "hermes") {
    const privateFile = path.join(cwd, ".hermes.md");
    if (isFile(privateFile) || isFile(path.join(cwd, "HERMES.md"))) {
      if (cwd !== project || (!override && !boundedText(privateFile)?.includes(MANAGED_START)))
        return false;
      relative = ".hermes.md";
    } else relative = "AGENTS.md";
  } else relative = "AGENTS.md";
  return plannedFileSafe(project, path.join(cwd, relative));
}
export function mcpRepairable(project: string, agent: Agent): boolean {
  let relative: string | undefined = (
    {
      codex: ".codex/config.toml",
      "claude-code": ".mcp.json",
      cursor: ".cursor/mcp.json",
      opencode: ".opencode/opencode.json",
      "grok-build": ".grok/config.toml",
      antigravity: ".agents/mcp_config.json",
    } as Partial<Record<Agent, string>>
  )[agent];
  if (!relative) return false;
  if (agent === "opencode")
    for (const name of [
      "opencode.json",
      "opencode.jsonc",
      ".opencode/opencode.json",
      ".opencode/opencode.jsonc",
    ])
      try {
        lstatSync(path.join(project, name));
        relative = name;
      } catch {}
  return plannedFileSafe(project, path.join(project, relative));
}
export function assetKind(file: string): string {
  const normalized = file.replaceAll("\\", "/").toLowerCase(),
    parts = normalized.split("/"),
    name = parts.at(-1);
  if (parts.includes("skills")) return "skill";
  if (
    [
      "agents.md",
      "agents.override.md",
      "claude.md",
      "tools.md",
      ".hermes.md",
      "hermes.md",
    ].includes(name ?? "") ||
    normalized.includes("/.cursor/rules/")
  )
    return "instruction";
  if (
    normalized.includes("mcp") ||
    name === "config.toml" ||
    normalized.endsWith("/.openclaw/openclaw.json") ||
    normalized.endsWith("/.hermes/config.yaml")
  )
    return "connection";
  return "configuration";
}
