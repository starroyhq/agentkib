import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { Agent } from "./doctor-files";

type JsonObject = Record<string, unknown>;
type NativeMcpFormat = "toml" | "yaml" | "json5" | "json";
const SERVER_PATHS: Record<Agent, readonly string[]> = {
  codex: ["mcp_servers"],
  "claude-code": ["mcpServers"],
  cursor: ["mcpServers"],
  opencode: ["mcp"],
  "open-claw": ["mcp", "servers"],
  hermes: ["mcp_servers"],
  "grok-build": ["mcp_servers"],
  antigravity: ["mcpServers"],
  "deepseek-harness": ["mcpServers"],
  devin: ["mcpServers"],
};

/** Parse only; callers retain responsibility for source ownership and safe file reads. */
export function parseNativeMcpDocument(
  content: string,
  agent: Agent,
  sourcePath: string,
): { format: NativeMcpFormat; root: unknown; servers: JsonObject | undefined } {
  const format =
    agent === "codex" || agent === "grok-build"
      ? "toml"
      : agent === "hermes"
        ? "yaml"
        : agent === "open-claw" || sourcePath.endsWith(".jsonc")
          ? "json5"
          : "json";
  // Use the same strict parser for scanning, collection and migration: a YAML
  // document with parse errors must never become eligible only during rewriting.
  const root: unknown =
    format === "toml"
      ? parseToml(content)
      : format === "yaml"
        ? parseYaml(content)
        : format === "json5"
          ? JSON5.parse(content)
          : JSON.parse(content);
  let servers: unknown = root;
  for (const segment of SERVER_PATHS[agent]) servers = asObject(servers)?.[segment];
  return { format, root, servers: asObject(servers) };
}

/** Replace only the MCP path; other YAML aliases must retain their original values. */
export function replaceNativeMcpServers(
  root: unknown,
  agent: Agent,
  servers: JsonObject,
): JsonObject {
  const segments = SERVER_PATHS[agent];
  const replace = (value: unknown, index: number): JsonObject => {
    const object = asObject(value),
      segment = segments[index]!;
    if (!object) throw new Error("Native MCP server object is missing");
    return {
      ...object,
      [segment]: index === segments.length - 1 ? servers : replace(object[segment], index + 1),
    };
  };
  return replace(root, 0);
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
