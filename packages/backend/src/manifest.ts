import path from "node:path";
import { z } from "zod";
import { parse, stringify } from "yaml";
import { agentSchema, unsigned } from "./rpc";
import { readText, relativePath } from "./files";
const targets = z.array(agentSchema).default([]);
const connection = z
  .object({
    name: z.string(),
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    allow_tools: z.array(z.string()).default([]),
    targets,
  })
  .or(
    z.object({
      name: z.string(),
      transport: z.literal("http"),
      url: z.string(),
      env: z.record(z.string(), z.string()).default({}),
      allow_tools: z.array(z.string()).default([]),
      targets,
    }),
  );
export const manifestSchema = z.object({
  schema_version: unsigned.max(4294967295),
  workspace: z.object({ id: z.string(), name: z.string() }),
  instructions: z
    .object({
      shared: z.string().default(""),
      scoped: z.array(z.object({ path: z.string(), content: z.string() })).default([]),
      platform_overrides: z.partialRecord(agentSchema, z.string()).default({}),
    })
    .prefault({}),
  skills: z.array(z.object({ name: z.string(), path: z.string(), targets })).default([]),
  mcp: z.object({ config: z.string().default("mcp.json") }).prefault({}),
  connections: z.array(connection).default([]),
  memories: z.object({ require_approval: z.boolean().default(true) }).prefault({}),
  adapters: z
    .partialRecord(
      agentSchema,
      z.object({
        enabled: z.boolean().default(true),
        generated_hashes: z.record(z.string(), z.string()).default({}),
      }),
    )
    .default({}),
});
export type Manifest = z.infer<typeof manifestSchema>;
export function manifestPath(project: string): string {
  return path.join(project, ".agentkib", "manifest.yaml");
}
export function loadManifest(project: string): Manifest {
  return parseManifest(readText(manifestPath(project), 1024 * 1024));
}
export function parseManifest(content: string): Manifest {
  const parsed = manifestSchema.safeParse(parse(content, { uniqueKeys: true }));
  if (!parsed.success) throw new Error(`manifest.yaml is invalid: ${parsed.error.message}`);
  validateManifest(parsed.data);
  return parsed.data;
}
export function validateManifest(value: Manifest): void {
  if (value.schema_version !== 1 && value.schema_version !== 2)
    throw new Error("Only schema_version 1 or 2 is supported");
  if (!value.workspace.id.trim() || !value.workspace.name.trim())
    throw new Error("workspace.id and workspace.name cannot be empty");
  if ([".", ".."].includes(value.workspace.id))
    throw new Error("workspace.id cannot be `.` or `..`");
  const names = new Set<string>();
  for (const skill of value.skills) {
    readOnly(skill.targets);
    relativePath(skill.path, "Skill path");
    if (!skill.name.trim()) throw new Error("Skill name cannot be empty");
    if (/[\\/]/.test(skill.name) || [".", ".."].includes(skill.name))
      throw new Error(`Skill name must be a single path-safe name: ${skill.name}`);
    if (names.has(skill.name)) throw new Error(`Duplicate Skill name: ${skill.name}`);
    names.add(skill.name);
  }
  for (const rule of value.instructions.scoped) relativePath(rule.path, "Scoped instruction path");
  if (value.schema_version >= 2) relativePath(value.mcp.config, "MCP config");
  names.clear();
  for (const connection of value.connections) {
    readOnly(connection.targets);
    if (!connection.name.trim()) throw new Error("MCP connection name cannot be empty");
    if (names.has(connection.name))
      throw new Error(`Duplicate MCP connection name: ${connection.name}`);
    names.add(connection.name);
    for (const [name, env] of Object.entries(connection.env))
      if (!env.startsWith("${") || !env.endsWith("}"))
        throw new Error(
          `Environment variable ${name} for connection ${connection.name} must use a \${VAR} reference`,
        );
    if (connection.transport === "stdio" && !connection.command.trim())
      throw new Error("stdio command cannot be empty");
    if (connection.transport === "http" && !/^https?:\/\//.test(connection.url))
      throw new Error("HTTP MCP URL is invalid");
  }
  if (
    "deepseek-harness" in value.instructions.platform_overrides ||
    "deepseek-harness" in value.adapters
  )
    throw new Error("DeepSeek Harness Beta is read-only and cannot be a manifest write target");
  if (value.instructions.platform_overrides["grok-build"]?.trim())
    throw new Error(
      "Grok Build does not support a safe AgentKib-specific instruction override; use shared or scoped AGENTS.md instructions",
    );
}
function readOnly(targets: string[]): void {
  if (targets.includes("deepseek-harness"))
    throw new Error("DeepSeek Harness Beta is read-only and cannot be a manifest write target");
}
export function manifestWire(value: Manifest) {
  const { connections, ...rest } = value;
  return { ...rest, ...(connections.length ? { connections } : {}) };
}
export function manifestYaml(value: Manifest): string {
  return stringify(manifestWire(value), { lineWidth: 0 });
}
