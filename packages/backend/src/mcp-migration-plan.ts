import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { parseDocument, stringify as stringifyYaml } from "yaml";
import type { Agent } from "./doctor-files";
import { safeTarget } from "./doctor-files";
import { pushChange, type ChangeSet, type FileChange } from "./change-plan";
import { effectiveMcp, mcpDocumentSchema, type McpServer } from "./mcp-config-read";
import type { McpManager } from "./mcp";
import type { NativeMcpCandidate } from "./mcp-native-scan";
import { scanNativeMcp } from "./mcp-native-scan";
import type { BackendStore } from "./store";
import { loadManifest } from "./manifest";
import { canonicalize, pathIdentity } from "./paths";

type JsonObject = Record<string, unknown>;
const POINTERS: Record<Agent, string[]> = {
  codex: ["mcp_servers"],
  "claude-code": ["mcpServers"],
  cursor: ["mcpServers"],
  opencode: ["mcp"],
  "open-claw": ["mcp", "servers"],
  hermes: ["mcp_servers"],
  "grok-build": ["mcp_servers"],
  antigravity: ["mcpServers"],
  "deepseek-harness": ["mcpServers"],
};

export async function planNativeMcpMigration(
  params: unknown,
  store: BackendStore,
  manager: McpManager,
  environment: NodeJS.ProcessEnv,
): Promise<ChangeSet> {
  const request = params as {
    project?: unknown;
    candidateIds?: unknown;
    mcpHubStatus?: unknown;
  } | null;
  if (!request || typeof request.project !== "string") throw new Error("Project is required");
  if (!Array.isArray(request.candidateIds) || request.candidateIds.length === 0)
    throw new Error("Select at least one native MCP candidate");
  if (!request.candidateIds.every((id) => typeof id === "string"))
    throw new Error("Candidate IDs must be strings");
  const candidateIds = request.candidateIds as string[];
  const uniqueIds = new Set(candidateIds);
  if (uniqueIds.size !== candidateIds.length) throw new Error("Duplicate native MCP candidate ID");

  const project = registeredProject(store, request.project);
  const candidates = scanNativeMcp({ project }, store, environment);
  const selected = candidateIds.map((id) => candidates.find((item) => item.id === id));
  if (selected.some((item) => !item)) throw new Error("Native MCP candidates changed; scan again");
  const chosen = selected as NativeMcpCandidate[];
  if (chosen.some((item) => !item.supported))
    throw new Error("Unsupported native MCP candidates cannot be migrated automatically");

  const hub = asObject(request.mcpHubStatus);
  if (
    !hub ||
    typeof hub.port !== "number" ||
    !Number.isInteger(hub.port) ||
    hub.port < 1 ||
    hub.port > 65535
  )
    throw new Error("MCP Hub settings are unavailable");
  const manifest = loadManifest(project);
  const gateway = `http://127.0.0.1:${hub.port}/mcp/v1/workspaces/${encodeSegment(manifest.workspace.id)}/agents/{agent}`;
  const effective = effectiveMcp(project, environment);
  const servers: McpServer[] = [];
  const serverIds = new Set<string>();
  for (const candidate of chosen) {
    const server = migrationServer(candidate);
    if (!server.id)
      throw new Error(`Native MCP server name cannot be converted to an ID: ${candidate.name}`);
    if (serverIds.has(server.id))
      throw new Error(`Selected native MCP servers map to the same AgentKib ID: ${server.id}`);
    serverIds.add(server.id);
    if (server.transport === "sse")
      throw new Error("Legacy SSE server must be converted before migration");
    if (candidate.has_secret_values) {
      const entered = effective.find(
        (item) =>
          item.name === candidate.name &&
          (Object.keys(item.env).length > 0 ||
            Object.keys(item.headers).length > 0 ||
            item.oauth_credentials != null),
      );
      if (!entered)
        throw new Error(
          `Re-enter local secret values and probe \`${candidate.name}\` before removing its native configuration`,
        );
      server.env = entered.env;
      server.headers = entered.headers;
      server.oauth_credentials = entered.oauth_credentials;
    }
    await manager.probeConfig(server);
    servers.push(server);
  }

  const configPath = path.join(project, ".agentkib/mcp.json");
  if (!safeTarget(project, configPath)) throw new Error(`Unsafe MCP config path: ${configPath}`);
  const before = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const parsed = before.trim()
    ? mcpDocumentSchema.parse(JSON.parse(before))
    : mcpDocumentSchema.parse({ schema_version: 1, servers: [] });
  for (const server of servers) {
    const publicServer = { ...server, env: {}, headers: {}, oauth_credentials: undefined };
    const index = parsed.servers.findIndex((item) => item.id === publicServer.id);
    if (index < 0) parsed.servers.push(publicServer);
    else parsed.servers[index] = publicServer;
  }
  parsed.servers.sort((left, right) => left.name.localeCompare(right.name));
  const changes: FileChange[] = [];
  const publicJson = JSON.stringify(parsed, null, 2) + "\n";
  if (before !== publicJson)
    pushChange(changes, configPath, publicJson, "project", "medium", "json");

  const bySource = new Map<string, NativeMcpCandidate[]>();
  for (const candidate of chosen) {
    const group = bySource.get(candidate.source_path) ?? [];
    group.push(candidate);
    bySource.set(candidate.source_path, group);
  }
  for (const [source, sourceCandidates] of [...bySource].sort(([a], [b]) => a.localeCompare(b))) {
    const sourceBefore = readFileSync(source, "utf8");
    const sourceAfter = rewriteSource(source, sourceBefore, sourceCandidates, gateway);
    if (sourceBefore === sourceAfter) continue;
    const inProject = isWithin(source, project);
    if (inProject && !safeTarget(project, source))
      throw new Error(`Unsafe native MCP config path: ${source}`);
    pushChange(
      changes,
      source,
      sourceAfter,
      inProject ? "project" : "agent-home",
      inProject ? "medium" : "high",
      validatorFor(source),
    );
  }
  return {
    id: randomUUID(),
    project_root: project,
    created_at: new Date().toISOString(),
    requires_home_approval: changes.some((item) => item.scope === "agent-home"),
    changes,
  };
}

function migrationServer(candidate: NativeMcpCandidate): McpServer {
  const source = readFileSync(candidate.source_path, "utf8");
  let value: unknown;
  if (candidate.agent === "codex" || candidate.agent === "grok-build") value = parseToml(source);
  else if (candidate.agent === "hermes") value = parseDocument(source).toJS();
  else if (
    candidate.agent === "open-claw" ||
    (candidate.agent === "opencode" && candidate.source_path.endsWith(".jsonc"))
  )
    value = JSON5.parse(source);
  else value = JSON.parse(source);
  const pointer = POINTERS[candidate.agent];
  const container = pointerValue(value, pointer);
  const raw = asObject(container?.[candidate.name]);
  if (!raw) throw new Error(`Native MCP candidate no longer exists: ${candidate.name}`);
  let transport: JsonObject;
  if (candidate.agent === "opencode") {
    if (raw.type === "remote") {
      if (typeof raw.url !== "string") throw new Error("OpenCode MCP URL is missing");
      if (raw.oauth !== undefined && raw.oauth !== false)
        throw new Error("OpenCode OAuth configuration cannot be migrated automatically");
      transport = { transport: "streamable-http", url: raw.url };
    } else if (
      raw.type === "local" &&
      Array.isArray(raw.command) &&
      raw.command.every((part) => typeof part === "string") &&
      raw.command.length
    ) {
      const [command, ...args] = raw.command as string[];
      transport = { transport: "stdio", command: command!, args };
    } else throw new Error("Unsupported OpenCode MCP configuration");
  } else {
    const url = string(raw.url) ?? string(raw.serverUrl);
    if (url) {
      const type = string(raw.transport) ?? string(raw.type);
      transport =
        type === "sse" ? { transport: "sse", url } : { transport: "streamable-http", url };
    } else {
      const command = string(raw.command);
      if (!command) throw new Error("Native MCP command is missing");
      transport = {
        transport: "stdio",
        command,
        args: strings(raw.args),
        ...(string(raw.cwd) ? { cwd: string(raw.cwd)! } : {}),
      };
    }
  }
  const id = candidate.name
    .replace(/[^A-Za-z0-9_-]/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  const server = mcpDocumentSchema.parse({
    schema_version: 1,
    servers: [
      {
        id,
        name: candidate.name,
        enabled: candidate.agent === "opencode" ? raw.enabled !== false : true,
        ...transport,
        env: candidate.agent === "opencode" ? stringMap(raw.environment) : {},
        headers: stringMap(raw.headers),
        targets: [candidate.agent],
        allow_tools:
          candidate.agent === "codex" || candidate.agent === "grok-build"
            ? strings(raw.enabled_tools)
            : candidate.agent === "antigravity"
              ? antigravityTools(raw)
              : [],
        lan_allow_tools: [],
        supports_parallel_tool_calls: false,
      },
    ],
  }).servers[0];
  if (!server) throw new Error("Native MCP configuration could not be converted");
  return server;
}

function rewriteSource(
  source: string,
  before: string,
  candidates: NativeMcpCandidate[],
  gateway: string,
): string {
  const agent = candidates[0]?.agent;
  if (!agent || candidates.some((candidate) => candidate.agent !== agent))
    throw new Error("Native MCP source contains inconsistent Agent types");
  const names = new Set(candidates.map((candidate) => candidate.name));
  const pointer = POINTERS[agent];
  if (agent === "codex" || agent === "grok-build") {
    const value = parseToml(before) as JsonObject;
    const servers = pointerValue(value, pointer);
    if (!servers) throw new Error("TOML mcp_servers table is missing");
    for (const name of names) delete servers[name];
    delete servers.agentkib;
    const output = stringifyToml(value).replace(/\n*$/, "\n");
    return `${output}\n# agentkib:managed:start\n[mcp_servers.agentkib]\nurl = ${JSON.stringify(gatewayFor(gateway, agent))}\n# agentkib:managed:end\n`;
  }
  const value =
    agent === "hermes"
      ? parseDocument(before).toJS()
      : agent === "open-claw" || (agent === "opencode" && source.endsWith(".jsonc"))
        ? JSON5.parse(before)
        : JSON.parse(before);
  const servers = pointerValue(value, pointer);
  if (!servers) throw new Error("Native MCP server object is missing");
  for (const name of names) delete servers[name];
  const url = gatewayFor(gateway, agent);
  const gatewayEntry: JsonObject = { url };
  if (agent === "claude-code") gatewayEntry.type = "http";
  if (agent === "open-claw") gatewayEntry.transport = "streamable-http";
  if (agent === "opencode") Object.assign(gatewayEntry, { type: "remote", enabled: true });
  if (agent === "antigravity") {
    delete gatewayEntry.url;
    gatewayEntry.serverUrl = url;
    const existing = asObject(servers.agentkib);
    if (
      existing &&
      JSON.stringify(existing) !== JSON.stringify(gatewayEntry) &&
      !isPriorAntigravityGateway(existing, url)
    )
      throw new Error(
        "Antigravity MCP `agentkib` entry is not the planned gateway; reconcile it before migrating other servers",
      );
  }
  servers.agentkib = gatewayEntry;
  if (agent === "hermes") return stringifyYaml(value);
  return JSON.stringify(value, null, 2) + "\n";
}

function pointerValue(root: unknown, pointer: string[]): JsonObject | undefined {
  let current: unknown = root;
  for (const segment of pointer) current = asObject(current)?.[segment];
  return asObject(current);
}
function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}
function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function stringMap(value: unknown): Record<string, string> {
  const object = asObject(value);
  return object
    ? Object.fromEntries(
        Object.entries(object).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};
}
function antigravityTools(server: JsonObject): string[] {
  if (server.disabled === true) return [];
  if (server.enabledTools === undefined) return [];
  const enabled = strings(server.enabledTools);
  const disabled = new Set(strings(server.disabledTools));
  return enabled.filter((tool) => !disabled.has(tool));
}
function gatewayFor(template: string, agent: Agent): string {
  return template.replace("{agent}", agent);
}
function isPriorAntigravityGateway(existing: JsonObject, plannedUrl: string): boolean {
  if (
    !Object.keys(existing).every((key) => key === "serverUrl" || key === "disabled") ||
    (existing.disabled !== undefined && existing.disabled !== false) ||
    typeof existing.serverUrl !== "string"
  )
    return false;
  try {
    const oldUrl = new URL(existing.serverUrl);
    const newUrl = new URL(plannedUrl);
    const workspace = newUrl.pathname
      .replace(/^\/mcp\/v1\/workspaces\//, "")
      .replace(/\/agents\/antigravity$/, "");
    return (
      newUrl.pathname.endsWith("/agents/antigravity") &&
      workspace.length > 0 &&
      !workspace.includes("/") &&
      oldUrl.protocol === "http:" &&
      newUrl.protocol === "http:" &&
      (oldUrl.hostname === "127.0.0.1" || oldUrl.hostname === "localhost") &&
      oldUrl.hostname === newUrl.hostname &&
      Boolean(oldUrl.port) &&
      Boolean(newUrl.port) &&
      !oldUrl.username &&
      !oldUrl.password &&
      !oldUrl.search &&
      !oldUrl.hash &&
      !newUrl.username &&
      !newUrl.password &&
      !newUrl.search &&
      !newUrl.hash &&
      oldUrl.pathname === newUrl.pathname
    );
  } catch {
    return false;
  }
}
function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
function registeredProject(store: BackendStore, value: string): string {
  const project = canonicalize(value);
  if (
    !store.sql
      .rows("SELECT canonical_path FROM workspaces")
      .some((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(project))
  )
    throw new Error("MCP project scope must be a registered AgentKib workspace");
  return project;
}
function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
function validatorFor(source: string): string {
  if (/\.toml$/i.test(source)) return "toml";
  if (/\.ya?ml$/i.test(source)) return "yaml";
  return "json";
}
