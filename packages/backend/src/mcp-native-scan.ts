import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { AGENTS } from "./rpc";
import type { Agent } from "./doctor-files";
import { canonicalize, pathIdentity } from "./paths";
import { compareUtf8 } from "./workspaces";
import type { BackendStore } from "./store";

export type NativeMcpCandidate = {
  id: string;
  agent: Agent;
  scope: string;
  name: string;
  source_path: string;
  transport: string;
  endpoint: string;
  has_secret_values: boolean;
  supported: boolean;
  warnings: string[];
};
type Candidate = NativeMcpCandidate;
type JsonObject = Record<string, unknown>;
type CandidateContext = {
  output: Candidate[];
  project?: string;
  home: string;
  opencodeHome: string;
  grokHome?: string;
};

export function scanNativeMcp(
  request: unknown,
  store: BackendStore,
  environment: NodeJS.ProcessEnv,
): Candidate[] {
  const value = request as { project?: unknown } | null;
  const projectValue = value?.project;
  if (projectValue != null && typeof projectValue !== "string")
    throw new Error("Project must be a registered workspace path");
  const project =
    typeof projectValue === "string" ? registeredProject(store, projectValue) : undefined;
  const home = environment.HOME ?? environment.USERPROFILE ?? os.homedir();
  const configRoot = environment.XDG_CONFIG_HOME;
  const opencodeHome = path.join(
    configRoot && path.isAbsolute(configRoot) ? configRoot : path.join(home, ".config"),
    "opencode",
  );
  const grokRoot = environment.GROK_HOME ?? path.join(home, ".grok");
  const context: CandidateContext = {
    output: [],
    project,
    home,
    opencodeHome,
    ...(isDirectory(grokRoot) ? { grokHome: canonicalPath(grokRoot) } : {}),
  };
  if (project) scanProject(context, project);
  scanHome(context);
  scanOpenCodeHome(context);
  scanGrokHome(context);

  const seen = new Set<string>();
  const result = context.output.filter((candidate) => {
    if (candidate.name === "agentkib" || seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
  markLayeredOpenCode(result);
  result.sort(
    (left, right) =>
      AGENTS.indexOf(left.agent) - AGENTS.indexOf(right.agent) ||
      compareUtf8(left.name, right.name),
  );
  return result;
}

function registeredProject(store: BackendStore, value: string): string {
  const canonical = canonicalize(value);
  const registered = store.sql
    .rows("SELECT canonical_path FROM workspaces")
    .some((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(canonical));
  if (!registered) throw new Error("MCP project scope must be a registered AgentKib workspace");
  return canonical;
}

function scanProject(context: CandidateContext, project: string): void {
  scanToml(path.join(project, ".codex/config.toml"), "codex", "project", context);
  scanToml(path.join(project, ".grok/config.toml"), "grok-build", "project", context);
  scanJson(path.join(project, ".mcp.json"), "claude-code", "project", ["mcpServers"], context);
  scanJson(path.join(project, ".cursor/mcp.json"), "cursor", "project", ["mcpServers"], context);
  scanJson(
    path.join(project, ".agents/mcp_config.json"),
    "antigravity",
    "project",
    ["mcpServers"],
    context,
  );
  for (const name of ["opencode.json", "opencode.jsonc"])
    scanOpenCode(path.join(project, name), "project", context);
  for (const name of ["opencode.json", "opencode.jsonc"])
    scanOpenCode(path.join(project, ".opencode", name), "project", context);
}

function scanHome(context: CandidateContext): void {
  const home = context.home;
  scanToml(path.join(home, ".codex/config.toml"), "codex", "home", context);
  scanJson(path.join(home, ".claude.json"), "claude-code", "home", ["mcpServers"], context);
  scanJson(path.join(home, ".cursor/mcp.json"), "cursor", "home", ["mcpServers"], context);
  scanJson5(
    path.join(home, ".openclaw/openclaw.json"),
    "open-claw",
    "home",
    ["mcp", "servers"],
    context,
  );
  scanHermes(path.join(home, ".hermes/config.yaml"), context);
  scanJson(
    path.join(home, ".gemini/config/mcp_config.json"),
    "antigravity",
    "home",
    ["mcpServers"],
    context,
  );
}

function scanOpenCodeHome(context: CandidateContext): void {
  for (const name of ["opencode.json", "opencode.jsonc"])
    scanOpenCode(path.join(context.opencodeHome, name), "home", context);
}

function scanGrokHome(context: CandidateContext): void {
  if (context.grokHome)
    scanToml(path.join(context.grokHome, "config.toml"), "grok-build", "home", context);
}

function scanToml(file: string, agent: Agent, scope: string, context: CandidateContext): void {
  const content = readConfig(file);
  if (content === undefined) return;
  const root = asObject(parseToml(content));
  const servers = asObject(root?.mcp_servers);
  if (!servers) return;
  for (const [name, raw] of Object.entries(servers)) {
    const server = asObject(raw);
    const endpoint = stringField(server, ["url", "serverUrl", "command"]) ?? "unavailable";
    context.output.push(
      candidate(
        file,
        agent,
        scope,
        name,
        server && Object.hasOwn(server, "url") ? "http" : "stdio",
        endpoint,
        !!server && ["env", "headers", "http_headers"].some((key) => Object.hasOwn(server, key)),
      ),
    );
  }
}

function scanJson(
  file: string,
  agent: Agent,
  scope: string,
  pointer: string[],
  context: CandidateContext,
): void {
  const content = readConfig(file);
  if (content === undefined) return;
  collectJsonServers(file, agent, scope, pointerValue(JSON.parse(content), pointer), context);
}

function scanJson5(
  file: string,
  agent: Agent,
  scope: string,
  pointer: string[],
  context: CandidateContext,
): void {
  const content = readConfig(file);
  if (content === undefined) return;
  collectJsonServers(file, agent, scope, pointerValue(JSON5.parse(content), pointer), context);
}

function scanOpenCode(file: string, scope: string, context: CandidateContext): void {
  const content = readConfig(file);
  if (content === undefined) return;
  const value: unknown = file.endsWith(".jsonc") ? JSON5.parse(content) : JSON.parse(content);
  collectJsonServers(file, "opencode", scope, asObject(value)?.mcp, context);
}

function scanHermes(file: string, context: CandidateContext): void {
  const content = readConfig(file);
  if (content === undefined) return;
  const value: unknown = parseYaml(content);
  collectJsonServers(file, "hermes", "home", asObject(value)?.mcp_servers, context);
}

function readConfig(file: string): string | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    const content = readFileSync(file, "utf8");
    return content.trim() ? content : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function collectJsonServers(
  file: string,
  agent: Agent,
  scope: string,
  value: unknown,
  context: CandidateContext,
): void {
  const servers = asObject(value);
  if (!servers) return;
  for (const [name, raw] of Object.entries(servers)) {
    const server = asObject(raw);
    const endpoint = endpointField(server) ?? "unavailable";
    const declared = stringField(server, ["transport", "type"]);
    const transport =
      declared ??
      (server && (Object.hasOwn(server, "url") || Object.hasOwn(server, "serverUrl"))
        ? "http"
        : "stdio");
    const hasSecretValues =
      (!!server && ["env", "environment", "headers"].some((key) => hasValues(server[key]))) ||
      (!!server && asObject(server.oauth) !== undefined && hasValues(server.oauth));
    const result = candidate(file, agent, scope, name, transport, endpoint, hasSecretValues);
    if (
      (agent === "opencode" && !opencodeServerCanBeMigrated(server)) ||
      (agent === "antigravity" && !antigravityPolicyCanBeMigrated(server))
    ) {
      result.supported = false;
      if (!result.warnings.includes("Unsupported native MCP fields or transport"))
        result.warnings.push("Unsupported native MCP fields or transport");
    }
    context.output.push(result);
  }
}

function endpointField(value: JsonObject | undefined): string | undefined {
  for (const key of ["url", "serverUrl", "command"]) {
    const field = value?.[key];
    if (typeof field === "string") return field;
    if (Array.isArray(field) && typeof field[0] === "string") return field[0];
  }
  return undefined;
}

function candidate(
  file: string,
  agent: Agent,
  scope: string,
  name: string,
  transport: string,
  endpoint: string,
  hasSecretValues: boolean,
): Candidate {
  const sourcePath = canonicalPath(file);
  const id = createHash("sha256").update(`${sourcePath}:${name}`).digest("hex").slice(0, 24);
  const supported =
    ["stdio", "http", "streamable-http", "sse"].includes(transport) ||
    ((agent === "opencode" || agent === "antigravity") && ["local", "remote"].includes(transport));
  return {
    id,
    agent,
    scope,
    name,
    source_path: sourcePath,
    transport,
    endpoint,
    has_secret_values: hasSecretValues,
    supported,
    warnings: hasSecretValues
      ? ["Secret values must be re-entered into mcp.local.json"]
      : supported
        ? []
        : ["Unsupported native MCP fields or transport"],
  };
}

function opencodeServerCanBeMigrated(server: JsonObject | undefined): boolean {
  if (!server || (server.enabled !== undefined && typeof server.enabled !== "boolean"))
    return false;
  if (server.type === "local") {
    return (
      Object.keys(server).every((key) =>
        ["type", "command", "environment", "enabled"].includes(key),
      ) &&
      Array.isArray(server.command) &&
      server.command.length > 0 &&
      server.command.every((item) => typeof item === "string") &&
      stringMapValid(server.environment)
    );
  }
  if (server.type === "remote") {
    return (
      Object.keys(server).every((key) =>
        ["type", "url", "enabled", "headers", "oauth"].includes(key),
      ) &&
      typeof server.url === "string" &&
      stringMapValid(server.headers) &&
      (server.oauth === undefined || server.oauth === false)
    );
  }
  return false;
}

function antigravityPolicyCanBeMigrated(server: JsonObject | undefined): boolean {
  if (!server) return false;
  const fields = [
    "command",
    "args",
    "env",
    "cwd",
    "serverUrl",
    "url",
    "headers",
    "transport",
    "type",
    "disabled",
    "enabledTools",
    "disabledTools",
  ];
  return (
    Object.keys(server).every((key) => fields.includes(key)) &&
    (server.disabled === undefined || typeof server.disabled === "boolean") &&
    antigravityTransportCanBeMigrated(server) &&
    antigravityAllowToolsCanBeMigrated(server)
  );
}

function antigravityTransportCanBeMigrated(server: JsonObject): boolean {
  const command = server.command;
  const serverUrl = server.serverUrl;
  const legacyUrl = server.url;
  const remoteUrl = serverUrl ?? legacyUrl;
  if (serverUrl !== undefined && legacyUrl !== undefined && serverUrl !== legacyUrl) return false;
  if ((command !== undefined) === (remoteUrl !== undefined)) return false;
  if (command !== undefined && typeof command !== "string") return false;
  if (remoteUrl !== undefined && typeof remoteUrl !== "string") return false;
  if (server.cwd !== undefined && typeof server.cwd !== "string") return false;
  if (
    server.args !== undefined &&
    (!Array.isArray(server.args) || !server.args.every((item) => typeof item === "string"))
  )
    return false;
  if (!stringMapValid(server.env) || !stringMapValid(server.headers)) return false;
  if (server.transport !== undefined && typeof server.transport !== "string") return false;
  if (server.type !== undefined && typeof server.type !== "string") return false;
  if (
    server.transport !== undefined &&
    server.type !== undefined &&
    server.transport !== server.type
  )
    return false;
  const declared = server.transport ?? server.type;
  return command !== undefined
    ? declared === undefined || ["stdio", "local"].includes(String(declared))
    : declared === undefined || ["http", "streamable-http", "remote"].includes(String(declared));
}

function antigravityAllowToolsCanBeMigrated(server: JsonObject): boolean {
  const enabled = optionalStringArray(server.enabledTools);
  const disabled = optionalStringArray(server.disabledTools);
  if (enabled === false || disabled === false) return false;
  const excluded = disabled ?? [];
  if (enabled === undefined) return excluded.length === 0;
  return enabled.length > 0 && enabled.some((tool) => !excluded.includes(tool));
}

function optionalStringArray(value: unknown): string[] | undefined | false {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : false;
}

function stringMapValid(value: unknown): boolean {
  return (
    value === undefined ||
    (asObject(value) !== undefined &&
      Object.values(value as JsonObject).every((item) => typeof item === "string"))
  );
}

function hasValues(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "object") return Object.keys(value).length > 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}

function markLayeredOpenCode(candidates: Candidate[]): void {
  for (const candidate of candidates) {
    if (candidate.agent !== "opencode") continue;
    const layered = candidates.some(
      (other) =>
        other.agent === "opencode" &&
        other.name === candidate.name &&
        other.source_path !== candidate.source_path,
    );
    if (!layered) continue;
    candidate.supported = false;
    const warning =
      "Layered OpenCode MCP entries with the same name cannot be migrated automatically";
    if (!candidate.warnings.includes(warning)) candidate.warnings.push(warning);
  }
}

function pointerValue(value: unknown, pathSegments: string[]): unknown {
  let current: unknown = value;
  for (const segment of pathSegments) current = asObject(current)?.[segment];
  return current;
}

function stringField(value: JsonObject | undefined, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value?.[key] === "string") return value[key] as string;
  return undefined;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function canonicalPath(value: string): string {
  try {
    return canonicalize(value);
  } catch {
    return path.resolve(value);
  }
}

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}
