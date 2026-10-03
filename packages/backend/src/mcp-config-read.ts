import path from "node:path";
import { homedir } from "node:os";
import { statSync } from "node:fs";
import { z } from "zod";
import { agentSchema, unsigned } from "./rpc";
import { readText } from "./files";
import { compareUtf8 } from "./workspaces";
export function userHome(environment: NodeJS.ProcessEnv): string {
  return environment.HOME ?? environment.USERPROFILE ?? homedir();
}
const common = {
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  oauth_credentials: z.unknown().optional(),
  targets: z.array(agentSchema).default([]),
  allow_tools: z.array(z.string()).default([]),
  lan_allow_tools: z.array(z.string()).default([]),
  supports_parallel_tool_calls: z.boolean().default(false),
  package: z
    .object({
      kind: z.enum(["npm", "pypi", "remote", "local"]),
      identifier: z.string(),
      version: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
};
const serverSchema = z.discriminatedUnion("transport", [
  z.object({
    ...common,
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string().nullable().optional(),
  }),
  z.object({ ...common, transport: z.literal("streamable-http"), url: z.string() }),
  z.object({ ...common, transport: z.literal("sse"), url: z.string() }),
]);
export const mcpDocumentSchema = z.object({
  schema_version: unsigned.max(4294967295).default(1),
  servers: z.array(serverSchema).default([]),
});
export type McpServer = z.infer<typeof serverSchema>;
export function readMcpDocument(file: string): McpServer[] {
  let metadata;
  try {
    metadata = statSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Unable to inspect MCP config ${file}`);
  }
  if (!metadata.isFile()) throw new Error(`MCP config must be a regular file: ${file}`);
  if (metadata.size > 1024 * 1024)
    throw new Error(`MCP config exceeds the 1 MiB read limit: ${file}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readText(file, 1024 * 1024, false));
  } catch {
    throw new Error(`Invalid MCP JSON config ${file}`);
  }
  const result = mcpDocumentSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid MCP JSON config ${file}`);
  if (result.data.schema_version !== 1)
    throw new Error("Only MCP config schema_version 1 is supported");
  const ids = new Set<string>();
  for (const server of result.data.servers) {
    if (!server.id.trim() || !server.name.trim())
      throw new Error("MCP server id and name cannot be empty");
    if (ids.has(server.id)) throw new Error(`Duplicate MCP server id: ${server.id}`);
    ids.add(server.id);
    if (
      path.basename(file) !== "mcp.local.json" &&
      (Object.keys(server.env).length ||
        Object.keys(server.headers).length ||
        server.oauth_credentials != null)
    )
      throw new Error("env and headers must be stored in mcp.local.json");
    if (server.transport === "stdio" && !server.command.trim())
      throw new Error("MCP stdio command cannot be empty");
    if (
      server.transport !== "stdio" &&
      !server.url.startsWith("http://") &&
      !server.url.startsWith("https://")
    )
      throw new Error("MCP HTTP URL is invalid");
  }
  return result.data.servers;
}
export function effectiveMcp(project: string | null, environment: NodeJS.ProcessEnv): McpServer[] {
  const global = path.join(userHome(environment), ".agentkib"),
    roots = project === null ? [global] : [global, path.join(project, ".agentkib")],
    servers = new Map<string, McpServer>();
  for (const root of roots)
    for (const name of ["mcp.json", "mcp.local.json"])
      for (const overlay of readMcpDocument(path.join(root, name))) {
        const base = servers.get(overlay.id);
        if (!base) {
          servers.set(overlay.id, overlay);
          continue;
        }
        servers.set(overlay.id, {
          ...overlay,
          targets: overlay.targets.length ? overlay.targets : base.targets,
          allow_tools: overlay.allow_tools.length ? overlay.allow_tools : base.allow_tools,
          lan_allow_tools: overlay.lan_allow_tools.length
            ? overlay.lan_allow_tools
            : base.lan_allow_tools,
          package: overlay.package ?? base.package,
          env: { ...base.env, ...overlay.env },
          headers: { ...base.headers, ...overlay.headers },
          oauth_credentials: overlay.oauth_credentials ?? base.oauth_credentials,
        });
      }
  return [...servers.entries()].sort(([a], [b]) => compareUtf8(a, b)).map(([, server]) => server);
}
export function visibleMcpNames(
  project: string,
  agent: string,
  environment: NodeJS.ProcessEnv,
): string[] {
  return effectiveMcp(project, environment)
    .filter(
      (server) =>
        server.enabled &&
        (!server.targets.length || server.targets.includes(agent as z.infer<typeof agentSchema>)),
    )
    .map((server) => server.name);
}
