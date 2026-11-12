import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { canonicalize, pathIdentity } from "./paths";
import { Sql } from "./sql";
import { Commands } from "./commands";
import { resolveCommand } from "./command-resolution";
import {
  type McpServer,
  effectiveMcp,
  mcpDocumentSchema,
  readMcpDocument,
  userHome,
} from "./mcp-config-read";
import { oauthProvider } from "./mcp-oauth";
import { BUILTIN_MCP_TOOLS } from "./mcp-builtin";
import {
  mcpToolAllowed,
  readMcpPolicy,
  saveMcpPolicy,
  type McpToolPolicyState,
} from "./mcp-policy";

type NetworkSettings = { port: number; lan_enabled: boolean; lan_risk_accepted: boolean };
export type ToolDescriptor = {
  server_id: string;
  name: string;
  description?: string;
  input_schema: unknown;
  read_only: boolean;
};
export type RegistryEntry = {
  name: string;
  description: string;
  version: string;
  package_kind: "npm" | "pypi" | "remote" | "local";
  identifier: string;
  runtime_hint?: string;
  url?: string;
  required_env: string[];
  runtime_arguments: string[];
  package_arguments: string[];
};
type Installation = {
  id: string;
  name: string;
  package_kind: string;
  identifier: string;
  version?: string;
  install_path?: string;
  status: string;
  installed_at: string;
  updated_at: string;
};
type ConnectionIdentity = { key: string; fingerprint: string };
type ActiveConnection = {
  client: Client;
  transport: Transport;
  server_id: string;
  tools: ToolDescriptor[];
  scope: string;
  identity: ConnectionIdentity;
};
type ToolDispatch = {
  identity: ConnectionIdentity;
  toolName: string;
  requestId?: string | number;
  check: () => void;
};
class McpDispatchDenied extends Error {}

const AGENTS = new Set([
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "open-claw",
  "hermes",
  "grok-build",
  "antigravity",
  "deepseek-harness",
  "devin",
]);

export class McpManager {
  static readonly #idleTimeoutMs = 15 * 60_000;
  static readonly #failureWindowMs = 5 * 60_000;
  static readonly #failureLimit = 3;
  #network: NetworkSettings = { port: 47653, lan_enabled: false, lan_risk_accepted: false };
  #active = new Map<string, ActiveConnection>();
  #starting = new Map<
    string,
    {
      serverId: string;
      controller: AbortController;
      promise: Promise<ToolDescriptor[]>;
      scope: string;
      identity: ConnectionIdentity;
    }
  >();
  #callQueues = new Map<string, Promise<void>>();
  #toolDispatch = new AsyncLocalStorage<ToolDispatch>();
  #connecting = new Set<{
    serverId: string;
    scope: string;
    controller: AbortController;
    promise: Promise<ToolDescriptor[]>;
  }>();
  #pendingConnections = new Set<Promise<ToolDescriptor[]>>();
  #closingClients = new Set<Promise<void>>();
  #restarting = new Map<string, Promise<void>>();
  #closed = false;
  #reaper: NodeJS.Timeout;
  #failures = new Map<string, { serverId: string; count: number; since: number; scope: string }>();
  #runtimeStatus = new Map<
    string,
    {
      server_id: string;
      server_name: string;
      config_hash: string;
      project: string | null;
      state: string;
      started_at?: string;
      last_used_at?: string;
      error?: string;
    }
  >();

  constructor(
    readonly sql: Sql,
    readonly environment: NodeJS.ProcessEnv,
    readonly dataDir: string,
    readonly commands: Commands,
  ) {
    this.#reaper = setInterval(() => this.#reapIdle(), 60_000);
    this.#reaper.unref();
  }

  close(): void {
    this.#closed = true;
    clearInterval(this.#reaper);
    this.stop();
    this.#runtimeStatus.clear();
  }

  async closeAsync(): Promise<void> {
    const starting = [...this.#starting.values()].map(({ promise }) =>
      promise.catch(() => undefined),
    );
    const connections = [...this.#pendingConnections].map((promise) =>
      promise.catch(() => undefined),
    );
    this.close();
    await Promise.allSettled([...this.#closingClients, ...starting, ...connections]);
  }

  list(project?: string): McpServer[] {
    return effectiveMcp(this.#project(project), this.environment).map(maskServer);
  }

  get(serverId: string, project?: string): McpServer | null {
    return this.list(project).find((server) => server.id === serverId) ?? null;
  }

  getPrivate(serverId: string, project?: string): McpServer | null {
    return (
      effectiveMcp(this.#project(project), this.environment).find(
        (server) => server.id === serverId,
      ) ?? null
    );
  }

  ensureOAuthStore(server: McpServer, project?: string): void {
    const selectedProject = this.#project(project);
    const file = this.#configPath(selectedProject, true);
    const local = readMcpDocument(file);
    if (local.some((item) => item.id === server.id)) return;
    local.push({ ...server, local_values_only: true, oauth_credentials: undefined });
    this.#write(file, local, true);
  }

  saveOAuthCredentials(serverId: string, credentials: unknown, project?: string): void {
    const selectedProject = this.#project(project);
    const file = this.#configPath(selectedProject, true);
    const local = readMcpDocument(file);
    const server = local.find((item) => item.id === serverId);
    if (!server) throw new Error("MCP local server entry is missing");
    server.oauth_credentials = credentials;
    delete server.clear_oauth;
    this.#write(file, local, true);
  }

  clearOAuthCredentials(serverId: string, project?: string): void {
    const selectedProject = this.#project(project);
    const file = this.#configPath(selectedProject, true);
    const local = readMcpDocument(file);
    const server = local.find((item) => item.id === serverId);
    if (server) {
      server.oauth_credentials = undefined;
      server.clear_oauth = true;
    }
    this.#write(file, local, true);
  }

  serversForHub(project: string, agent: string): McpServer[] {
    if (!AGENTS.has(agent)) throw new Error("Unsupported MCP target agent");
    return effectiveMcp(this.#project(project), this.environment).filter(
      (server) =>
        server.enabled && (!server.targets.length || server.targets.includes(agent as never)),
    );
  }

  getPolicy(project?: string) {
    const scope = this.#project(project);
    const policy = readMcpPolicy(scope, this.environment);
    return {
      ...policy,
      catalog: [
        {
          server_id: null,
          name: "AgentKib",
          probed: true,
          tools: BUILTIN_MCP_TOOLS.map((tool) => ({
            server_id: "agentkib",
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            read_only: tool.readOnlyHint,
          })),
        },
        ...effectiveMcp(scope, this.environment).map((server) => {
          const cached = this.#cachedCatalog(server, scope);
          return {
            server_id: server.id,
            name: server.name,
            probed: cached !== null,
            tools: cached ?? [],
          };
        }),
      ],
    };
  }

  savePolicy(value: unknown, project?: string) {
    const scope = this.#project(project);
    saveMcpPolicy(value, scope, this.environment, this.dataDir);
    return this.getPolicy(project);
  }

  builtinAllowed(project: string, agent: string, tool: string): boolean {
    if (!AGENTS.has(agent)) throw new Error("Unsupported MCP target agent");
    return mcpToolAllowed(
      readMcpPolicy(this.#project(project), this.environment),
      agent,
      null,
      tool,
    );
  }

  hubTools(project: string, agent: string, remote: boolean): ToolDescriptor[] {
    const scope = this.#project(project);
    const policy = readMcpPolicy(scope, this.environment);
    const namespace = this.#publicToolNamespace(project);
    return this.serversForHub(project, agent).flatMap((server) =>
      (this.#cachedCatalog(server, scope) ?? [])
        .filter((tool) => this.#toolAllowed(server, policy, agent, tool.name, remote))
        .filter((tool) => {
          try {
            const resolved = this.#resolvePublicTool(namespace, `${server.id}__${tool.name}`);
            return resolved.serverId === server.id && resolved.toolName === tool.name;
          } catch {
            return false;
          }
        })
        .map((tool) => ({ ...tool, name: `${server.id}__${tool.name}` })),
    );
  }

  #toolAllowed(
    server: McpServer,
    policy: McpToolPolicyState,
    agent: string,
    name: string,
    remote: boolean,
  ) {
    return (
      (!server.allow_tools.length || server.allow_tools.includes(name)) &&
      (!remote || server.lan_allow_tools.includes(name)) &&
      mcpToolAllowed(policy, agent, server.id, name)
    );
  }

  #publicToolNamespace(project: string) {
    const scope = this.#project(project);
    return effectiveMcp(scope, this.environment).map((server) => {
      const catalog = this.#cachedCatalog(server, scope);
      return {
        serverId: server.id,
        prefix: `${server.id}__`,
        tools: catalog === null ? null : new Set(catalog.map((tool) => tool.name)),
      };
    });
  }

  #resolvePublicTool(
    namespace: Array<{ serverId: string; prefix: string; tools: Set<string> | null }>,
    publicName: string,
  ) {
    const candidates = namespace.flatMap(({ serverId, prefix, tools }) => {
      if (!publicName.startsWith(prefix) || publicName.length === prefix.length) return [];
      const toolName = publicName.slice(prefix.length);
      // An unprobed overlapping namespace cannot safely be presumed empty. This
      // includes disabled services, so permission changes cannot reroute old names.
      return tools === null || tools.has(toolName) ? [{ serverId, toolName }] : [];
    });
    if (candidates.length > 1)
      throw new Error("Ambiguous MCP tool name; rename the conflicting service before calling it");
    if (!candidates.length) throw new Error("Unknown MCP tool");
    return candidates[0]!;
  }

  async callHubTool(
    project: string,
    agent: string,
    publicName: string,
    arguments_: Record<string, unknown>,
    remote: boolean,
    assertIdentity: () => void = () => undefined,
  ): Promise<unknown> {
    const { serverId, toolName } = this.#resolvePublicTool(
      this.#publicToolNamespace(project),
      publicName,
    );
    const assertAllowed = () => {
      assertIdentity();
      const resolved = this.#resolvePublicTool(this.#publicToolNamespace(project), publicName);
      if (resolved.serverId !== serverId || resolved.toolName !== toolName)
        throw new Error("MCP tool identity changed before dispatch");
      const server = this.serversForHub(project, agent).find((item) => item.id === serverId);
      if (!server) throw new Error("MCP server is not visible in this scope");
      if (
        !this.#toolAllowed(
          server,
          readMcpPolicy(this.#project(project), this.environment),
          agent,
          toolName,
          remote,
        )
      )
        throw new Error("MCP tool is not allowed by the current Agent policy");
      return server;
    };
    const server = assertAllowed();
    return this.callTool(server, toolName, arguments_, project, () => {
      assertAllowed();
    });
  }

  cachedTools(serverId: string, project?: string): ToolDescriptor[] {
    const scope = this.#project(project);
    const server = effectiveMcp(scope, this.environment).find((item) => item.id === serverId);
    return server ? (this.#cachedCatalog(server, scope) ?? []) : [];
  }

  hasCurrentProbe(serverId: string, project?: string): boolean {
    const scope = this.#project(project);
    const server = effectiveMcp(scope, this.environment).find((item) => item.id === serverId);
    return server !== undefined && this.#cachedCatalog(server, scope) !== null;
  }

  #cachedCatalog(server: McpServer, project: string | null): ToolDescriptor[] | null {
    const row = this.sql.rows(
      "SELECT descriptor_json FROM mcp_tool_cache WHERE server_id=? AND tool_name=''",
      mcpToolCacheKey(server, project, this.environment),
    )[0];
    if (!row) return null;
    try {
      const value = JSON.parse(String(row.descriptor_json)) as {
        schema_version?: unknown;
        tools?: ToolDescriptor[];
      };
      if (value.schema_version !== 2 || !Array.isArray(value.tools)) return null;
      if (
        !value.tools.every(
          (tool) =>
            tool.server_id === server.id && typeof tool.name === "string" && tool.name.length > 0,
        )
      )
        return null;
      return value.tools;
    } catch {
      return null;
    }
  }

  async callTool(
    server: McpServer,
    toolName: string,
    arguments_: Record<string, unknown>,
    project?: string,
    assertAllowed: () => void = () => undefined,
  ): Promise<unknown> {
    assertAllowed();
    if (server.allow_tools.length && !server.allow_tools.includes(toolName))
      throw new Error("Tool is not allowed by this MCP server configuration");
    const fingerprint = mcpToolCacheKey(server, this.#project(project), this.environment),
      configHash = this.#runtimeKey(fingerprint);
    if (this.#closed) throw new Error("MCP manager is closed");
    this.#assertRestartAllowed(configHash);
    let active = this.#active.get(configHash);
    if (active?.identity.fingerprint !== fingerprint) active = undefined;
    if (!active) {
      await this.#start(server, project);
      active = this.#active.get(configHash);
    }
    if (!active) throw new Error("MCP server connection was not retained");
    const connection = active;
    const assertDispatch = () => {
      if (this.#closed || this.#active.get(configHash) !== connection)
        throw new Error("MCP server connection was stopped");
      assertAllowed();
      const current = this.getPrivate(server.id, project);
      if (
        !current ||
        mcpToolCacheKey(current, this.#project(project), this.environment) !==
          connection.identity.fingerprint
      )
        throw new Error("MCP connection configuration changed before dispatch");
      if (current.allow_tools.length && !current.allow_tools.includes(toolName))
        throw new Error("Tool is not allowed by this MCP server configuration");
      if (!connection.tools.some((tool) => tool.name === toolName))
        throw new Error("Unknown MCP tool");
      return current;
    };
    const execute = () =>
      this.#callTool(
        configHash,
        connection,
        assertDispatch(),
        toolName,
        arguments_,
        assertDispatch,
      );
    if (server.supports_parallel_tool_calls) return execute();
    const result = (this.#callQueues.get(configHash) ?? Promise.resolve()).then(execute);
    const queued = result.then(
      () => undefined,
      () => undefined,
    );
    this.#callQueues.set(configHash, queued);
    void queued.then(() => {
      if (this.#callQueues.get(configHash) === queued) this.#callQueues.delete(configHash);
    });
    return result;
  }

  async #callTool(
    configHash: string,
    active: ActiveConnection,
    server: McpServer,
    toolName: string,
    arguments_: Record<string, unknown>,
    assertDispatch: () => void,
  ): Promise<unknown> {
    try {
      const status = this.#runtimeStatus.get(configHash);
      if (status && this.#active.get(configHash) === active)
        this.#runtimeStatus.set(configHash, { ...status, last_used_at: new Date().toISOString() });
      const result = await this.#toolDispatch.run(
        { identity: active.identity, toolName, check: assertDispatch },
        () =>
          active.client.callTool({ name: toolName, arguments: arguments_ }, undefined, {
            timeout: 60_000,
          }),
      );
      return result;
    } catch (error) {
      // A local revocation only rejects this request, not other Agents sharing
      // the same transport or their already dispatched parallel calls.
      if (error instanceof McpDispatchDenied) throw error;
      this.#recordFailure(configHash, server.id, active.scope);
      const status = this.#runtimeStatus.get(configHash);
      if (status && this.#active.get(configHash) === active)
        this.#runtimeStatus.set(configHash, {
          ...status,
          state: "error",
          error: redactMcpError(error, server),
        });
      await this.#closeClient(active).catch(() => undefined);
      if (this.#active.get(configHash) === active) this.#active.delete(configHash);
      throw error;
    }
  }

  save(server: McpServer, project?: string): McpServer {
    const selectedProject = this.#project(project);
    const validated = mcpDocumentSchema.parse({ schema_version: 1, servers: [server] }).servers[0];
    if (!validated) throw new Error("MCP server configuration is incomplete");
    if (validated.transport === "sse")
      throw new Error("Legacy SSE is import-only; use Streamable HTTP");
    if (validated.targets.some((target) => !AGENTS.has(target)))
      throw new Error("Unsupported MCP target agent");
    const clean = { ...validated, env: {}, headers: {} } as McpServer;
    const file = this.#configPath(selectedProject, false);
    const servers = readMcpDocument(file).filter((item) => item.id !== clean.id);
    servers.push(clean);
    servers.sort((a, b) => a.name.localeCompare(b.name));
    this.#write(file, servers, false);
    return maskServer(clean);
  }

  saveLocal(
    serverId: string,
    env: Record<string, string>,
    headers: Record<string, string>,
    project?: string,
  ): void {
    const selectedProject = this.#project(project);
    const current = effectiveMcp(selectedProject, this.environment).find(
      (server) => server.id === serverId,
    );
    if (!current) throw new Error("Unknown MCP server");
    const file = this.#configPath(selectedProject, true);
    const local = readMcpDocument(file);
    const existing = local.find((item) => item.id === serverId);
    const servers = local.filter((item) => item.id !== serverId);
    // Legacy local entries can define the service itself or override its endpoint.
    // Only a newly created entry is known to contain private values alone.
    const updated: McpServer = {
      ...(existing ?? { ...current, local_values_only: true }),
      env: stringMap(env),
      headers: stringMap(headers),
    };
    // Explicit replacements restore only those keys, preserving other inherited-value revocations.
    updated.deleted_env = updated.deleted_env?.filter((key) => !Object.hasOwn(updated.env, key));
    updated.deleted_headers = updated.deleted_headers?.filter(
      (key) => !Object.hasOwn(updated.headers, key),
    );
    servers.push(updated);
    this.#write(file, servers, true);
  }

  remove(serverId: string, project?: string): void {
    const selectedProject = this.#project(project);
    for (const local of [false, true]) {
      const file = this.#configPath(selectedProject, local);
      const servers = readMcpDocument(file).filter((item) => item.id !== serverId);
      this.#write(file, servers, local);
    }
    this.stop(serverId);
  }

  hubStatus() {
    const statuses = [...this.#runtimeStatus.values()];
    const lastError = [...statuses].reverse().find((item) => item.error)?.error;
    return {
      running: false,
      bind_address: "127.0.0.1",
      port: this.#network.port,
      lan_enabled: this.#network.lan_enabled,
      accessible_addresses: [],
      runtime_count: statuses.filter((item) => item.state === "running").length,
      error_count: statuses.filter((item) => item.state === "error").length,
      ...(lastError ? { last_error: lastError } : {}),
    };
  }

  updateNetwork(settings: NetworkSettings) {
    if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
      throw new Error("MCP Hub port must be between 1 and 65535");
    if (settings.lan_enabled && !settings.lan_risk_accepted)
      throw new Error("Enabling MCP Hub LAN access requires explicit risk acceptance");
    this.#network = { ...settings };
    this.sql.run(
      "INSERT INTO preferences(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
      "mcp_network",
      JSON.stringify(settings),
    );
    return this.hubStatus();
  }

  setNetwork(settings: NetworkSettings): void {
    this.#network = { ...settings };
  }

  runtimes() {
    const statuses = [...this.#runtimeStatus.values()];
    if (statuses.length)
      this.sql.transaction(() => {
        for (const status of statuses)
          this.sql.run(
            "INSERT INTO mcp_runtime_snapshots(config_hash,server_id,snapshot_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(config_hash) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at",
            status.config_hash,
            status.server_id,
            JSON.stringify(status),
            new Date().toISOString(),
          );
      });
    return statuses;
  }

  async searchRegistry(query: string, refresh = false): Promise<RegistryEntry[]> {
    const normalized = query.trim().slice(0, 200);
    try {
      const url = new URL("https://registry.modelcontextprotocol.io/v0.1/servers");
      url.searchParams.set("search", normalized);
      url.searchParams.set("version", "latest");
      url.searchParams.set("limit", "100");
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`MCP registry returned HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const entries = parseRegistryEntries(payload);
      this.sql.transaction(() => {
        this.sql.run("DELETE FROM mcp_registry_cache");
        const cachedAt = new Date().toISOString();
        for (const entry of entries)
          this.sql.run(
            "INSERT INTO mcp_registry_cache(name,entry_json,schema_version,cached_at) VALUES(?,?,?,?)",
            entry.name,
            JSON.stringify(entry),
            "v0.1",
            cachedAt,
          );
      });
      return entries;
    } catch (error) {
      if (refresh) throw error;
      const escaped = `%${normalized.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const rows = this.sql.rows(
        "SELECT entry_json FROM mcp_registry_cache WHERE name LIKE ? ESCAPE '\\' OR entry_json LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100",
        escaped,
        escaped,
      );
      const cached = rows.flatMap((row) => {
        try {
          return [JSON.parse(String(row.entry_json)) as RegistryEntry];
        } catch {
          return [];
        }
      });
      if (cached.length || !normalized) return cached;
      throw new Error(
        `Registry request failed: ${error instanceof Error ? error.message : "network error"}`,
      );
    }
  }

  installations(): Installation[] {
    return this.sql
      .rows(
        "SELECT id,name,package_kind,identifier,version,install_path,status,installed_at,updated_at FROM mcp_installations ORDER BY name",
      )
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        package_kind: String(row.package_kind),
        identifier: String(row.identifier),
        ...(row.version == null ? {} : { version: String(row.version) }),
        ...(row.install_path == null ? {} : { install_path: String(row.install_path) }),
        status: String(row.status),
        installed_at: String(row.installed_at),
        updated_at: String(row.updated_at),
      }));
  }

  async install(entry: RegistryEntry, project: string | undefined, confirmed: boolean) {
    if (!confirmed) throw new Error("MCP installation requires explicit confirmation");
    validateRegistryEntry(entry);
    const installationId = `mcp-${createHash("sha256").update(`${entry.name}@${entry.version}`).digest("hex").slice(0, 16)}`;
    const target = path.join(this.dataDir, "mcp", "packages", installationId);
    let command: string | undefined;
    let args = entry.package_arguments;
    let packagePath: string | undefined;
    if (this.installations().some((item) => item.id === installationId)) this.stop(installationId);
    if (entry.package_kind === "remote") {
      if (!entry.url || !/^https?:\/\//i.test(entry.url))
        throw new Error("Registry remote has no valid URL");
    } else if (entry.package_kind === "npm" || entry.package_kind === "pypi") {
      const temp = `${target}.installing`;
      mkdirSync(path.dirname(target), { recursive: true });
      rmSync(temp, { recursive: true, force: true });
      mkdirSync(temp, { recursive: true });
      try {
        if (entry.package_kind === "npm") {
          await this.commands.run(
            "npm",
            [
              "install",
              "--prefix",
              temp,
              "--no-save",
              "--ignore-scripts",
              `${entry.identifier}@${entry.version}`,
            ],
            {
              timeout: 600_000,
              terminateDescendantsOnExit: true,
              env: safeEnvironment(this.environment),
            },
          );
          const manifestPath = path.join(temp, "node_modules", entry.identifier, "package.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
            bin?: string | Record<string, string>;
          };
          const binName =
            typeof manifest.bin === "string"
              ? entry.identifier.split("/").at(-1)!
              : Object.keys(manifest.bin ?? {})[0];
          if (!binName || binName.includes("/") || binName.includes("\\"))
            throw new Error("npm package does not declare a safe executable");
          const launcher = path.join(
            temp,
            "node_modules",
            ".bin",
            `${binName}${process.platform === "win32" ? ".cmd" : ""}`,
          );
          if (!existsSync(launcher)) throw new Error("npm package executable was not created");
          command = path.join(target, path.relative(temp, launcher));
        } else {
          const venv = path.join(temp, "venv");
          const python =
            process.platform === "win32"
              ? path.join(venv, "Scripts", "python.exe")
              : path.join(venv, "bin", "python");
          await this.commands.run("uv", ["venv", venv], {
            timeout: 600_000,
            terminateDescendantsOnExit: true,
            env: safeEnvironment(this.environment),
          });
          await this.commands.run(
            "uv",
            ["pip", "install", "--python", python, `${entry.identifier}==${entry.version}`],
            {
              timeout: 600_000,
              terminateDescendantsOnExit: true,
              env: safeEnvironment(this.environment),
            },
          );
          const binDir =
            process.platform === "win32" ? path.join(venv, "Scripts") : path.join(venv, "bin");
          const normalized = entry.identifier.replaceAll("_", "-").toLowerCase();
          const executables = readdirSync(binDir)
            .filter((name) => !/^(activate|deactivate|pip|python|pydoc)/i.test(name))
            .sort();
          const executable =
            executables.find(
              (name) =>
                name
                  .replace(/\.(exe|cmd|bat)$/i, "")
                  .replaceAll("_", "-")
                  .toLowerCase() === normalized,
            ) ?? executables[0];
          if (!executable)
            throw new Error("PyPI package did not install an executable entry point");
          command = path.join(
            target,
            "venv",
            process.platform === "win32" ? "Scripts" : "bin",
            executable,
          );
        }
        const backup = `${target}.replaced`;
        rmSync(backup, { recursive: true, force: true });
        if (existsSync(target)) renameSync(target, backup);
        try {
          renameSync(temp, target);
        } catch (error) {
          if (existsSync(backup)) renameSync(backup, target);
          throw error;
        }
        rmSync(backup, { recursive: true, force: true });
        packagePath = target;
      } catch (error) {
        rmSync(temp, { recursive: true, force: true });
        throw error;
      }
    } else {
      throw new Error("Local MCP commands are registered without an installer");
    }
    const now = new Date().toISOString();
    const existing = this.installations().find((item) => item.id === installationId);
    const installation: Installation = {
      id: installationId,
      name: entry.name,
      package_kind: entry.package_kind,
      identifier: entry.identifier,
      version: entry.version,
      ...(packagePath ? { install_path: packagePath } : {}),
      status: "installed",
      installed_at: existing?.installed_at ?? now,
      updated_at: now,
    };
    const server: McpServer = {
      id: installationId,
      name: entry.name,
      enabled: true,
      ...(entry.package_kind === "remote"
        ? { transport: "streamable-http" as const, url: entry.url! }
        : { transport: "stdio" as const, command: command!, args }),
      env: {},
      headers: {},
      targets: [],
      allow_tools: [],
      lan_allow_tools: [],
      supports_parallel_tool_calls: false,
      package: { kind: entry.package_kind, identifier: entry.identifier, version: entry.version },
    } as McpServer;
    const savedServer = this.save(server, project);
    this.sql.run(
      "INSERT INTO mcp_installations(id,name,package_kind,identifier,version,install_path,status,installed_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,package_kind=excluded.package_kind,identifier=excluded.identifier,version=excluded.version,install_path=excluded.install_path,status=excluded.status,updated_at=excluded.updated_at",
      installation.id,
      installation.name,
      installation.package_kind,
      installation.identifier,
      installation.version ?? null,
      installation.install_path ?? null,
      installation.status,
      installation.installed_at,
      installation.updated_at,
    );
    const serverConfig = effectiveMcp(this.#project(project), this.environment).find(
      (item) => item.id === installationId,
    );
    const tools = serverConfig ? await this.#connect(serverConfig, false).catch(() => []) : [];
    return { installation, server: savedServer, tools };
  }

  async update(
    installationId: string,
    entry: RegistryEntry,
    project: string | undefined,
    confirmed: boolean,
  ) {
    if (!confirmed) throw new Error("MCP update requires explicit confirmation");
    const previous = this.installations().find((item) => item.id === installationId);
    if (!previous) throw new Error("Unknown MCP installation");
    const result = await this.install(entry, project, true);
    if (result.installation.id !== previous.id) {
      this.stop(previous.id);
      this.remove(previous.id, project);
      this.#removePackage(previous);
      this.sql.run("DELETE FROM mcp_installations WHERE id=?", previous.id);
    }
    return result;
  }

  uninstall(installationId: string, confirmed: boolean): void {
    if (!confirmed) throw new Error("MCP uninstall requires explicit confirmation");
    const installation = this.installations().find((item) => item.id === installationId);
    if (!installation) throw new Error("Unknown MCP installation");
    this.stop(installationId);
    if (installation.install_path) {
      this.#removePackage(installation);
    }
    const configs = [
      null,
      ...this.sql
        .rows("SELECT canonical_path FROM workspaces")
        .map((row) => String(row.canonical_path)),
    ];
    for (const project of configs) this.remove(installationId, project ?? undefined);
    this.sql.run("DELETE FROM mcp_installations WHERE id=?", installationId);
  }

  #removePackage(installation: Installation): void {
    if (!installation.install_path) return;
    const root = path.resolve(this.dataDir, "mcp", "packages");
    const target = path.resolve(installation.install_path);
    if (path.dirname(target) !== root || !target.startsWith(`${root}${path.sep}`))
      throw new Error("Refusing to remove an MCP installation outside AgentKib data");
    rmSync(target, { recursive: true, force: true });
  }

  async probe(serverId: string, project?: string): Promise<ToolDescriptor[]> {
    const server = effectiveMcp(this.#project(project), this.environment).find(
      (item) => item.id === serverId,
    );
    if (!server) throw new Error("Unknown MCP server");
    return this.#start(server, project);
  }

  async probeConfig(server: McpServer): Promise<ToolDescriptor[]> {
    return this.#connect(server, false);
  }

  restart(serverId: string, project?: string): Promise<ToolDescriptor[]> {
    const scope = this.#connectionScope(project),
      restartKey = JSON.stringify([scope, serverId]);
    const previous = this.#restarting.get(restartKey) ?? Promise.resolve();
    const restart = previous.then(async () => {
      const connecting = [...this.#connecting]
        .filter((item) => item.serverId === serverId && item.scope === scope)
        .map((item) => item.promise);
      const children = [...this.#active.values()]
        .filter((item) => item.server_id === serverId && item.scope === scope)
        .map(
          (item) =>
            (item.transport as Transport & { _process?: import("node:child_process").ChildProcess })
              ._process,
        )
        .filter((child) => child !== undefined);
      const closing = this.#stop(serverId, scope);
      await Promise.allSettled([...connecting, ...closing]);
      if (children.some((child) => child.exitCode === null && child.signalCode === null))
        throw new Error("MCP server did not exit before restart");
      const server = effectiveMcp(this.#project(project), this.environment).find(
        (item) => item.id === serverId,
      );
      if (!server) throw new Error("Unknown MCP server");
      return this.#start(server, project, true);
    });
    const completed = restart.then(
      () => undefined,
      () => undefined,
    );
    this.#restarting.set(restartKey, completed);
    void completed.then(() => {
      if (this.#restarting.get(restartKey) === completed) this.#restarting.delete(restartKey);
    });
    return restart;
  }

  stop(serverId?: string): void {
    // The legacy explicit stop operation still addresses all scopes.
    this.#stop(serverId);
  }

  #stop(serverId?: string, scope?: string): Promise<void>[] {
    const closing: Promise<void>[] = [];
    for (const [configHash, failure] of this.#failures) {
      if ((!serverId || failure.serverId === serverId) && (!scope || failure.scope === scope))
        this.#failures.delete(configHash);
    }
    for (const connecting of this.#connecting) {
      if ((!serverId || connecting.serverId === serverId) && (!scope || connecting.scope === scope))
        connecting.controller.abort();
    }
    for (const starting of this.#starting.values()) {
      if ((!serverId || starting.serverId === serverId) && (!scope || starting.scope === scope))
        starting.controller.abort();
    }
    for (const [configHash, active] of this.#active) {
      if ((!serverId || active.server_id === serverId) && (!scope || active.scope === scope)) {
        closing.push(this.#dispose(active));
        this.#active.delete(configHash);
        const state = this.#runtimeStatus.get(configHash);
        if (state) this.#runtimeStatus.set(configHash, { ...state, state: "stopped" });
      }
    }
    return closing;
  }

  #connectionScope(project?: string): string {
    const selected = this.#project(project);
    return JSON.stringify([
      selected === null ? "global" : "workspace",
      pathIdentity(selected ?? userHome(this.environment)),
    ]);
  }

  #runtimeKey(fingerprint: string): string {
    // A connection's queue stays stable while its own SDK rotates credentials.
    // Only the latest, fully verified fingerprint may find that connection.
    for (const [key, connection] of [...this.#active, ...this.#starting])
      if (connection.identity.fingerprint === fingerprint) return key;
    return fingerprint;
  }

  #start(server: McpServer, project?: string, bypassRestart = false): Promise<ToolDescriptor[]> {
    const scope = this.#connectionScope(project),
      fingerprint = mcpToolCacheKey(server, this.#project(project), this.environment),
      configHash = this.#runtimeKey(fingerprint);
    const restarting = this.#restarting.get(JSON.stringify([scope, server.id]));
    if (restarting && !bypassRestart)
      return restarting.then(() => {
        const active = this.#active.get(configHash),
          current = this.getPrivate(server.id, project);
        // Restart may have rotated credentials while this request was waiting.
        // Reuse only that retained connection and its verified current snapshot.
        if (
          active &&
          current &&
          mcpToolCacheKey(current, this.#project(project), this.environment) ===
            active.identity.fingerprint
        )
          return active.tools;
        return this.#start(server, project);
      });
    this.#assertRestartAllowed(configHash);
    const active = this.#active.get(configHash);
    if (active?.identity.fingerprint === fingerprint) return Promise.resolve(active.tools);
    if (active) {
      void this.#dispose(active);
      this.#active.delete(configHash);
    }
    const existing = this.#starting.get(configHash);
    if (existing?.identity.fingerprint === fingerprint && !existing.controller.signal.aborted)
      return existing.promise;
    if (existing) {
      existing.controller.abort();
      this.#starting.delete(configHash);
    }
    const controller = new AbortController();
    const identity = { key: configHash, fingerprint };
    const promise = this.#connect(server, true, project, controller.signal, identity);
    const starting = { serverId: server.id, scope, controller, promise, identity };
    this.#starting.set(configHash, starting);
    void promise
      .finally(() => {
        if (this.#starting.get(configHash) === starting) this.#starting.delete(configHash);
      })
      .catch(() => undefined);
    return promise;
  }

  #dispose(active: { client: Client; transport: Transport }): Promise<void> {
    const closing = this.#closeClient(active).catch(() => undefined);
    this.#closingClients.add(closing);
    void closing.finally(() => this.#closingClients.delete(closing));
    return closing;
  }

  async #closeClient(active: { client: Client; transport: Transport }): Promise<void> {
    const closing = active.client.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1_500);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await active.transport.close();
    }
  }

  async #connect(
    server: McpServer,
    retain: boolean,
    project?: string,
    signal?: AbortSignal,
    identity?: ConnectionIdentity,
  ): Promise<ToolDescriptor[]> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    const scope = this.#connectionScope(project);
    const fingerprint = mcpToolCacheKey(server, this.#project(project), this.environment);
    const connection = this.#connectNow(
      server,
      retain,
      project,
      controller.signal,
      identity ?? { key: fingerprint, fingerprint },
    );
    const attempt = { serverId: server.id, scope, controller, promise: connection };
    this.#connecting.add(attempt);
    this.#pendingConnections.add(connection);
    try {
      return await connection;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.#connecting.delete(attempt);
      this.#pendingConnections.delete(connection);
    }
  }

  async #connectNow(
    server: McpServer,
    retain: boolean,
    project: string | undefined,
    signal: AbortSignal,
    identity: ConnectionIdentity,
  ): Promise<ToolDescriptor[]> {
    const selectedProject = this.#project(project),
      configHash = identity.key;
    let retained = false;
    const checkCurrent = () => {
      if (
        this.#closed ||
        signal.aborted ||
        (retained && this.#active.get(configHash)?.identity !== identity)
      )
        throw new Error("MCP server connection was stopped");
      if (retain) {
        const current = this.getPrivate(server.id, project);
        if (
          !current ||
          mcpToolCacheKey(current, selectedProject, this.environment) !== identity.fingerprint
        )
          throw new Error("MCP connection configuration changed before dispatch");
      }
    };
    checkCurrent();
    const scope = this.#connectionScope(project);
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    let transport: Transport;
    if (server.transport === "stdio") {
      const { McpStdioTransport } = await import("./mcp-stdio-transport");
      const environment = { ...process.env, ...this.environment, ...server.env };
      const executable = resolveCommand(server.command, environment, server.cwd ?? undefined);
      if (!executable) throw new Error(`MCP executable is unavailable: ${server.command}`);
      transport = new McpStdioTransport({
        command: executable,
        args: server.args,
        cwd: server.cwd ?? undefined,
        env: safeEnvironment(environment),
      });
    } else {
      const { StreamableHTTPClientTransport } =
        await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const url = new URL(server.url);
      const headers = { ...server.headers };
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
        fetch: async (input, init) => {
          // The SDK can retry tools/call after awaiting OAuth. Its custom fetch
          // is the last boundary before each actual HTTP dispatch, including retries.
          const request = input as string | URL | Request,
            endpoint = request instanceof Request ? request.url : String(request),
            method = init?.method ?? (request instanceof Request ? request.method : "GET");
          if (new URL(endpoint).href === url.href && method.toUpperCase() === "POST") {
            const serialized =
              init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
            let body: unknown;
            try {
              if (typeof serialized === "string") body = JSON.parse(serialized);
            } catch {
              /* OAuth form bodies are not RPC. */
            }
            for (const value of Array.isArray(body) ? body : [body]) {
              if (value === null || typeof value !== "object") continue;
              const message = value as {
                method?: unknown;
                id?: unknown;
                params?: { name?: unknown };
              };
              if (message.method !== "tools/call") continue;
              const dispatch = this.#toolDispatch.getStore();
              if (
                !dispatch ||
                dispatch.identity !== identity ||
                message.params?.name !== dispatch.toolName ||
                (typeof message.id !== "string" && typeof message.id !== "number") ||
                (dispatch.requestId !== undefined && dispatch.requestId !== message.id)
              )
                throw new McpDispatchDenied("MCP tool dispatch context is unavailable or changed");
              dispatch.requestId = message.id;
              try {
                dispatch.check();
              } catch (error) {
                throw new McpDispatchDenied(
                  error instanceof Error ? error.message : "MCP tool dispatch denied",
                  { cause: error },
                );
              }
            }
          }
          return fetch(input, init);
        },
        ...(server.transport === "streamable-http"
          ? {
              authProvider: oauthProvider(
                server,
                this,
                project,
                this.#network.port,
                (write, invalidatesAuthorization) => {
                  checkCurrent();
                  const current = this.getPrivate(server.id, project);
                  // The provider holds its original credential snapshot. Never let a
                  // delayed refresh overwrite a user edit, account change or revocation.
                  if (
                    !current ||
                    mcpToolCacheKey(current, selectedProject, this.environment) !==
                      identity.fingerprint
                  )
                    throw new Error("MCP OAuth configuration changed before saving credentials");
                  const previous = identity.fingerprint;
                  write();
                  const updated = this.getPrivate(server.id, project);
                  if (!updated) throw new Error("MCP OAuth server was removed");
                  identity.fingerprint = mcpToolCacheKey(
                    updated,
                    selectedProject,
                    this.environment,
                  );
                  const sameAuthorization =
                    !invalidatesAuthorization &&
                    isDeepStrictEqual(
                      oauthAuthorizationIdentity(current.oauth_credentials),
                      oauthAuthorizationIdentity(updated.oauth_credentials),
                    );
                  if (retain && (previous !== identity.fingerprint || !sameAuthorization))
                    this.sql.transaction(() => {
                      this.sql.run(
                        "DELETE FROM mcp_tool_cache WHERE server_id=?",
                        identity.fingerprint,
                      );
                      if (sameAuthorization)
                        this.sql.run(
                          "UPDATE mcp_tool_cache SET server_id=? WHERE server_id=?",
                          identity.fingerprint,
                          previous,
                        );
                      else this.sql.run("DELETE FROM mcp_tool_cache WHERE server_id=?", previous);
                    });
                  // An invalid grant or a changed authorization identity needs a new
                  // connection and discovery, not the directory of the previous login.
                  if (!sameAuthorization && retained) {
                    const active = this.#active.get(configHash);
                    if (active?.identity === identity) {
                      this.#active.delete(configHash);
                      void this.#dispose(active);
                      const status = this.#runtimeStatus.get(configHash);
                      if (status)
                        this.#runtimeStatus.set(configHash, { ...status, state: "stopped" });
                    }
                    throw new Error("MCP OAuth authorization changed; reconnect before dispatch");
                  }
                },
              ),
            }
          : {}),
      });
    }
    const client = new Client({ name: "agentkib", version: "0.13.0" });
    const cancel = () => {
      void client.close().catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const started = new Date().toISOString();
    this.#runtimeStatus.set(configHash, {
      server_id: server.id,
      server_name: server.name,
      config_hash: configHash,
      project: selectedProject,
      state: "starting",
      started_at: started,
    });
    try {
      checkCurrent();
      await client.connect(transport, { timeout: 15_000 });
      checkCurrent();
      const allTools: Awaited<ReturnType<typeof client.listTools>>["tools"] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 });
        checkCurrent();
        allTools.push(...result.tools);
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === 99) throw new Error("MCP tool listing exceeded the pagination limit");
      }
      const tools = allTools.map((tool) => ({
        server_id: server.id,
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        input_schema: tool.inputSchema,
        read_only: tool.annotations?.readOnlyHint === true,
      }));
      // Cache the raw directory. Revocation must not depend on probing again, and
      // a same-named service in another workspace must never borrow this catalog.
      if (retain)
        this.sql.transaction(() => {
          this.sql.run("DELETE FROM mcp_tool_cache WHERE server_id=?", identity.fingerprint);
          this.sql.run(
            "INSERT INTO mcp_tool_cache(server_id,tool_name,descriptor_json,probed_at) VALUES(?,?,?,?)",
            identity.fingerprint,
            "",
            JSON.stringify({ schema_version: 2, tools }),
            new Date().toISOString(),
          );
        });
      const previousOnclose = transport.onclose;
      const previousOnerror = transport.onerror;
      transport.onclose = () => {
        previousOnclose?.();
        if (this.#active.get(configHash)?.client !== client) return;
        const current = this.#runtimeStatus.get(configHash);
        if (current?.state === "running")
          this.#runtimeStatus.set(configHash, { ...current, state: "stopped" });
        this.#active.delete(configHash);
      };
      transport.onerror = (transportError) => {
        if (transportError instanceof McpDispatchDenied) return;
        previousOnerror?.(transportError);
        if (this.#active.get(configHash)?.client !== client) return;
        const current = this.#runtimeStatus.get(configHash);
        if (current)
          this.#runtimeStatus.set(configHash, {
            ...current,
            state: "error",
            error: redactMcpError(transportError, server),
          });
      };
      this.#runtimeStatus.set(configHash, {
        server_id: server.id,
        server_name: server.name,
        config_hash: configHash,
        project: selectedProject,
        state: "running",
        started_at: started,
        last_used_at: new Date().toISOString(),
      });
      this.#failures.delete(configHash);
      if (retain) {
        this.#active.set(configHash, {
          client,
          transport,
          server_id: server.id,
          tools,
          scope,
          identity,
        });
        retained = true;
      } else {
        await this.#closeClient({ client, transport });
        this.#runtimeStatus.set(configHash, {
          server_id: server.id,
          server_name: server.name,
          config_hash: configHash,
          project: selectedProject,
          state: "stopped",
          started_at: started,
        });
      }
      return tools;
    } catch (error) {
      if (!this.#closed && !signal.aborted) this.#recordFailure(configHash, server.id, scope);
      await this.#closeClient({ client, transport }).catch(() => undefined);
      const detail = redactMcpError(error, server);
      if (!this.#closed)
        this.#runtimeStatus.set(configHash, {
          server_id: server.id,
          server_name: server.name,
          config_hash: configHash,
          project: selectedProject,
          state: signal?.aborted ? "stopped" : "error",
          started_at: started,
          error: detail,
        });
      throw new Error(detail, { cause: error });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  #recordFailure(configHash: string, serverId: string, scope: string): void {
    const now = Date.now();
    const previous = this.#failures.get(configHash);
    this.#failures.set(
      configHash,
      previous && now - previous.since <= McpManager.#failureWindowMs
        ? { ...previous, count: previous.count + 1 }
        : { serverId, scope, count: 1, since: now },
    );
  }

  #assertRestartAllowed(configHash: string): void {
    const failure = this.#failures.get(configHash);
    if (!failure) return;
    if (Date.now() - failure.since > McpManager.#failureWindowMs) {
      this.#failures.delete(configHash);
      return;
    }
    if (failure.count >= McpManager.#failureLimit)
      throw new Error("MCP server restart limit reached; restart it explicitly from AgentKib");
  }

  #reapIdle(): void {
    const cutoff = Date.now() - McpManager.#idleTimeoutMs;
    for (const [configHash, active] of this.#active) {
      const lastUsed = Date.parse(this.#runtimeStatus.get(configHash)?.last_used_at ?? "");
      if (!Number.isFinite(lastUsed) || lastUsed > cutoff) continue;
      this.#dispose(active);
      this.#active.delete(configHash);
      const status = this.#runtimeStatus.get(configHash);
      if (status) this.#runtimeStatus.set(configHash, { ...status, state: "stopped" });
    }
  }

  #project(project?: string): string | null {
    if (!project) return null;
    const canonical = canonicalize(project);
    const rows = this.sql.rows("SELECT canonical_path FROM workspaces");
    if (!rows.some((row) => pathIdentity(String(row.canonical_path)) === pathIdentity(canonical)))
      throw new Error("MCP project scope must be a registered AgentKib workspace");
    return canonical;
  }

  #configPath(project: string | null, local: boolean): string {
    const directory = project
      ? path.join(project, ".agentkib")
      : path.join(userHome(this.environment), ".agentkib");
    return path.join(directory, local ? "mcp.local.json" : "mcp.json");
  }

  #write(file: string, servers: McpServer[], local: boolean): void {
    if (
      !local &&
      servers.some(
        (server) =>
          Object.keys(server.env).length ||
          Object.keys(server.headers).length ||
          server.oauth_credentials != null,
      )
    )
      throw new Error("env and headers must be stored in mcp.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    const parsed = mcpDocumentSchema.parse({ schema_version: 1, servers });
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(parsed, null, 2)}\n`, {
      mode: local ? 0o600 : 0o644,
      flag: "wx",
    });
    if (local) chmodSync(temp, 0o600);
    renameSync(temp, file);
    if (local && process.platform !== "win32") chmodSync(file, 0o600);
    const configDirectory = path.dirname(file);
    if (local && path.dirname(configDirectory) !== userHome(this.environment))
      ensureGitIgnored(configDirectory);
  }
}

function stringMap(value: Record<string, string>): Record<string, string> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((item) => typeof item !== "string")
  )
    throw new Error("MCP environment and headers must be string maps");
  return { ...value };
}

function safeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function redactMcpError(error: unknown, server: McpServer): string {
  let value = error instanceof Error ? error.message : "MCP connection failed";
  for (const secret of [...Object.values(server.env), ...Object.values(server.headers)])
    if (secret) value = value.replaceAll(secret, "[redacted]");
  return value.length > 1_024 ? `${value.slice(0, 1_024)}…` : value;
}

function maskServer(server: McpServer): McpServer {
  return {
    ...server,
    env: Object.fromEntries(
      Object.entries(server.env).map(([key, value]) => [key, value ? "••••••••" : ""]),
    ),
    headers: Object.fromEntries(
      Object.entries(server.headers).map(([key, value]) => [key, value ? "••••••••" : ""]),
    ),
    ...(server.oauth_credentials == null ? {} : { oauth_credentials: { status: "configured" } }),
  } as McpServer;
}

function ensureGitIgnored(agentkibDirectory: string): void {
  const gitignore = path.join(path.dirname(agentkibDirectory), ".gitignore");
  let lines: string[] = [];
  try {
    lines = readFileSync(gitignore, "utf8").split(/\r?\n/);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    lines.some(
      (line) => line.trim() === ".agentkib/mcp.local.json" || line.trim() === "mcp.local.json",
    )
  )
    return;
  const prefix = lines.length && lines.at(-1) !== "" ? "\n" : "";
  writeFileSync(gitignore, `${lines.join("\n")}${prefix}.agentkib/mcp.local.json\n`, {
    mode: 0o644,
  });
}

function parseRegistryEntries(value: unknown): RegistryEntry[] {
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray((value as { servers?: unknown }).servers)
  )
    return [];
  const entries: RegistryEntry[] = [];
  for (const wrapper of (value as { servers: unknown[] }).servers) {
    if (!wrapper || typeof wrapper !== "object" || !("server" in wrapper)) continue;
    const server = (wrapper as { server: unknown }).server;
    if (!server || typeof server !== "object") continue;
    const source = server as Record<string, unknown>;
    if (typeof source.name !== "string" || typeof source.version !== "string") continue;
    const remotes = Array.isArray(source.remotes) ? source.remotes : [];
    const remote = remotes.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const item = entry as Record<string, unknown>;
      const transport =
        item.transport && typeof item.transport === "object"
          ? (item.transport as Record<string, unknown>)
          : undefined;
      return item.type === "streamable-http" || transport?.type === "streamable-http";
    }) as Record<string, unknown> | undefined;
    const remoteTransport =
      remote?.transport && typeof remote.transport === "object"
        ? (remote.transport as Record<string, unknown>)
        : undefined;
    const remoteUrl =
      remote &&
      (typeof remote.url === "string"
        ? remote.url
        : typeof remoteTransport?.url === "string"
          ? remoteTransport.url
          : undefined);
    if (remoteUrl) {
      entries.push({
        name: source.name,
        description: typeof source.description === "string" ? source.description : "",
        version: source.version,
        package_kind: "remote",
        identifier: remoteUrl,
        url: remoteUrl,
        required_env: [],
        runtime_arguments: [],
        package_arguments: [],
      });
      continue;
    }
    const packages = Array.isArray(source.packages) ? source.packages : [];
    const pkg = packages.find(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        ["npm", "pypi"].includes(String((entry as Record<string, unknown>).registryType)),
    ) as Record<string, unknown> | undefined;
    if (!pkg || typeof pkg.identifier !== "string") continue;
    const kind = pkg.registryType as "npm" | "pypi";
    const requiredEnv = Array.isArray(pkg.environmentVariables)
      ? pkg.environmentVariables.flatMap((env) =>
          env &&
          typeof env === "object" &&
          (env as Record<string, unknown>).isRequired === true &&
          typeof (env as Record<string, unknown>).name === "string"
            ? [(env as Record<string, string>).name]
            : [],
        )
      : [];
    entries.push({
      name: source.name,
      description: typeof source.description === "string" ? source.description : "",
      version: typeof pkg.version === "string" ? pkg.version : source.version,
      package_kind: kind,
      identifier: pkg.identifier,
      ...(typeof pkg.runtimeHint === "string" ? { runtime_hint: pkg.runtimeHint } : {}),
      required_env: requiredEnv,
      runtime_arguments: argumentValues(pkg.runtimeArguments),
      package_arguments: argumentValues(pkg.packageArguments),
    });
  }
  return entries;
}

function argumentValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    const selected = typeof item.value === "string" ? item.value : item.default;
    return typeof selected === "string" ? [selected] : [];
  });
}

function validateRegistryEntry(entry: RegistryEntry): void {
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.name !== "string" ||
    !entry.name.trim() ||
    typeof entry.version !== "string" ||
    !entry.version.trim() ||
    typeof entry.identifier !== "string" ||
    !entry.identifier.trim()
  )
    throw new Error("MCP registry entry is incomplete");
  if (!["npm", "pypi", "remote", "local"].includes(entry.package_kind))
    throw new Error("Unsupported MCP package kind");
  if (
    entry.package_kind === "npm" &&
    (!/^@?[A-Za-z0-9._/-]+$/.test(entry.identifier) ||
      entry.identifier.split("/").some((part) => !part || part === "." || part === ".."))
  )
    throw new Error("Invalid npm package identifier");
  if (entry.package_kind === "pypi" && !/^[A-Za-z0-9._-]+$/.test(entry.identifier))
    throw new Error("Invalid PyPI package identifier");
  if (entry.package_kind === "remote" && (!entry.url || !/^https?:\/\//i.test(entry.url)))
    throw new Error("Registry remote has no valid URL");
  for (const value of [...entry.package_arguments, ...entry.runtime_arguments])
    if (typeof value !== "string" || value.includes("\0"))
      throw new Error("Invalid MCP package argument");
}

function oauthAuthorizationIdentity(value: unknown) {
  const record = (input: unknown): Record<string, unknown> =>
    input !== null && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const credentials = record(value),
    tokens = record(credentials.token_response),
    client = record(credentials.client_information),
    discovery = record(credentials.discovery_state);
  return {
    client,
    issuer: tokens.issuer ?? client.issuer ?? null,
    authorizationServer: discovery.authorizationServerUrl ?? tokens.issuer ?? client.issuer ?? null,
    scopes:
      typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean).sort() : [],
  };
}

/** A derived key in the existing cache table; old ID-only catalogs have no verified owner. */
export function mcpToolCacheKey(
  server: McpServer,
  project: string | null,
  environment: NodeJS.ProcessEnv,
): string {
  const scope = pathIdentity(project ?? userHome(environment));
  const connection =
    server.transport === "stdio"
      ? {
          transport: server.transport,
          command: server.command,
          args: server.args,
          cwd: server.cwd ?? null,
        }
      : { transport: server.transport, url: server.url };
  return `mcp-v2:${createHash("sha256")
    .update(
      JSON.stringify([
        scope,
        project === null ? "global" : "workspace",
        server.id,
        connection,
        Object.entries(server.env).sort(),
        Object.entries(server.headers).sort(),
        server.oauth_credentials ?? null,
      ]),
    )
    .digest("hex")}`;
}
