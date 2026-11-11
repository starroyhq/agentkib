import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpBuiltins } from "./mcp-builtin";
import { BUILTIN_MCP_TOOLS } from "./mcp-builtin";
import type { McpManager } from "./mcp";
import type { McpOAuth } from "./mcp-oauth";
import type { BackendStore } from "./store";
import { lexicalPathIdentity } from "./paths";
import { resolveWorkspaceIdentity, requireUniqueContinuationWorkspace } from "./workspace-identity";

export interface McpNetworkSettings {
  port: number;
  lan_enabled: boolean;
  lan_risk_accepted: boolean;
}

type Scope = {
  workspaceId: string;
  registeredWorkspaceId: string;
  project: string;
  agent: string;
  remote: boolean;
};
type HubSession = {
  transport: StreamableHTTPServerTransport;
  server: Server;
  scope: Scope;
  usedAt: number;
};
/**
 * An Agent CLI that exits without ending its session leaves the session here until the Hub
 * stops. Sessions unused this long, or the least recently used beyond the limit, are closed;
 * a client that comes back is answered 404 and starts a new session, as MCP requires.
 */
const SESSION_IDLE_MS = 24 * 60 * 60_000;
const SESSION_LIMIT = 512;

export class McpHub {
  #server?: HttpServer;
  #settings: McpNetworkSettings;
  #sessions = new Map<string, HubSession>();
  #lastError?: string;

  constructor(
    readonly manager: McpManager,
    readonly store: BackendStore,
    readonly builtins: McpBuiltins,
    readonly oauth: McpOAuth,
    settings: McpNetworkSettings,
    readonly limits: { sessions?: number; sessionIdleMs?: number } = {},
  ) {
    this.#settings = { ...settings };
  }

  async start(): Promise<void> {
    if (this.#server) return;
    this.#server = await this.#listen(this.#settings);
    this.#lastError = undefined;
  }

  async update(settings: McpNetworkSettings) {
    if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)
      throw new Error("MCP Hub port must be between 1 and 65535");
    if (settings.lan_enabled && !settings.lan_risk_accepted)
      throw new Error("Enabling MCP Hub LAN access requires explicit risk acceptance");
    const previous = this.#settings;
    const sameEndpoint =
      settings.port === previous.port && settings.lan_enabled === previous.lan_enabled;
    if (sameEndpoint) {
      this.#settings = { ...settings };
      return this.status();
    }
    const oldServer = this.#server;
    let replacement: HttpServer;
    if (settings.port !== previous.port) {
      replacement = await this.#listen(settings);
    } else {
      await this.#closeSessions();
      if (oldServer) await closeServer(oldServer);
      this.#server = undefined;
      try {
        replacement = await this.#listen(settings);
      } catch (error) {
        if (oldServer) this.#server = await this.#listen(previous);
        throw error;
      }
    }
    this.#settings = { ...settings };
    this.#server = replacement;
    this.#lastError = undefined;
    if (oldServer && settings.port !== previous.port) {
      await this.#closeSessions();
      await closeServer(oldServer);
    }
    return this.status();
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    const closing = server ? closeServer(server) : Promise.resolve();
    await this.#closeSessions();
    await closing;
  }

  /** Makes room for one new session. */
  #retireSessions(): void {
    const now = Date.now();
    const idle = this.limits.sessionIdleMs ?? SESSION_IDLE_MS;
    const limit = this.limits.sessions ?? SESSION_LIMIT;
    let excess = this.#sessions.size + 1 - limit;
    // The map is kept in order of use, least recent first.
    for (const [id, session] of [...this.#sessions]) {
      if (excess <= 0 && now - session.usedAt <= idle) break;
      this.#sessions.delete(id);
      excess--;
      void session.transport.close().catch(() => undefined);
      void session.server.close().catch(() => undefined);
    }
  }

  async #closeSessions(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      sessions.flatMap((session) => [
        session.transport.close().catch(() => undefined),
        session.server.close().catch(() => undefined),
      ]),
    );
  }

  status() {
    const statuses = this.manager.runtimes();
    const settings = this.#settings;
    return {
      running: Boolean(this.#server?.listening),
      bind_address: bindHost(settings),
      port: settings.port,
      lan_enabled: settings.lan_enabled,
      accessible_addresses: settings.lan_enabled
        ? accessibleAddresses(settings.port)
        : [`127.0.0.1:${settings.port}`],
      runtime_count: statuses.filter((status) => status.state === "running").length,
      error_count: statuses.filter((status) => status.state === "error").length,
      ...(this.#lastError ? { last_error: this.#lastError } : {}),
    };
  }

  async #listen(settings: McpNetworkSettings): Promise<HttpServer> {
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error) => {
        this.#lastError = error instanceof Error ? error.message : "MCP Hub request failed";
        if (!response.headersSent) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "MCP Hub request failed" }));
        } else response.destroy();
      });
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(settings.port, bindHost(settings), () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
    return server;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("ok");
      return;
    }
    const oauthMatch = /^\/oauth\/callback\/([^/]+)$/.exec(url.pathname);
    if (request.method === "GET" && oauthMatch) {
      try {
        const serverId = decodeURIComponent(oauthMatch[1]!);
        if (url.searchParams.get("error")) throw new Error("OAuth authorization was denied");
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) throw new Error("OAuth callback is missing parameters");
        await this.oauth.complete(serverId, code, state, url.searchParams.get("iss") ?? undefined);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><title>AgentKib</title><p>AgentKib MCP authorization completed. You can close this window.</p>",
        );
      } catch {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(
          "<!doctype html><title>AgentKib</title><p>AgentKib MCP authorization failed. Return to AgentKib and try again.</p>",
        );
      }
      return;
    }
    const match = /^\/mcp\/v1\/workspaces\/([^/]+)\/agents\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      response.writeHead(404).end();
      return;
    }
    let scope: Scope;
    let project: string;
    try {
      const workspaceId = decodeURIComponent(match[1]!);
      const workspace = resolveWorkspaceIdentity(this.store, workspaceId);
      scope = {
        workspaceId,
        registeredWorkspaceId: workspace.registeredId,
        project: workspace.project,
        agent: parseAgent(decodeURIComponent(match[2]!)),
        remote: !isLoopback(request.socket.remoteAddress),
      };
      project = workspace.project;
    } catch {
      response.writeHead(400).end();
      return;
    }
    const host = headerValue(request.headers.host)?.toLowerCase();
    const allowedOrigins = [
      `http://127.0.0.1:${this.#settings.port}`,
      `http://localhost:${this.#settings.port}`,
    ];
    const origin = headerValue(request.headers.origin);
    if (
      (origin !== undefined && !allowedOrigins.includes(origin)) ||
      (scope.remote && !this.#settings.lan_enabled) ||
      (!this.#settings.lan_enabled &&
        host !== undefined &&
        !new Set([
          "127.0.0.1",
          "localhost",
          `127.0.0.1:${this.#settings.port}`,
          `localhost:${this.#settings.port}`,
        ]).has(host))
    ) {
      response.writeHead(403).end();
      return;
    }
    const sessionId = headerValue(request.headers["mcp-session-id"]);
    if (sessionId) {
      const existing = this.#sessions.get(sessionId);
      if (
        !existing ||
        existing.scope.workspaceId !== scope.workspaceId ||
        existing.scope.registeredWorkspaceId !== scope.registeredWorkspaceId ||
        lexicalPathIdentity(existing.scope.project) !== lexicalPathIdentity(scope.project) ||
        existing.scope.agent !== scope.agent ||
        existing.scope.remote !== scope.remote
      ) {
        response.writeHead(404).end();
        return;
      }
      existing.usedAt = Date.now();
      this.#sessions.delete(sessionId);
      this.#sessions.set(sessionId, existing);
      await existing.transport.handleRequest(request, response);
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(400).end();
      return;
    }
    const [
      { Server },
      { StreamableHTTPServerTransport },
      { CallToolRequestSchema, ListToolsRequestSchema },
    ] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    let sessionIdCreated: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      enableDnsRebindingProtection: true,
      allowedOrigins,
      ...(!this.#settings.lan_enabled
        ? {
            allowedHosts: [
              "127.0.0.1",
              "localhost",
              `127.0.0.1:${this.#settings.port}`,
              `localhost:${this.#settings.port}`,
            ],
          }
        : {}),
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessionIdCreated = id;
        this.#retireSessions();
        this.#sessions.set(id, { transport, server: mcpServer, scope, usedAt: Date.now() });
      },
      onsessionclosed: (id) => {
        this.#sessions.delete(id);
      },
    });
    const mcpServer = new Server(
      { name: "agentkib", version: "0.13.0" },
      { capabilities: { tools: {} }, instructions: "AgentKib local MCP Hub" },
    );
    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.#listTools(project, scope),
    }));
    mcpServer.setRequestHandler(CallToolRequestSchema, async (rpcRequest) => {
      try {
        const name = rpcRequest.params.name;
        const args = rpcRequest.params.arguments ?? {};
        const current = this.#assertScope(scope, name);
        if (
          BUILTIN_MCP_TOOLS.some((tool) => tool.name === name) &&
          !this.manager.builtinAllowed(project, scope.agent, name)
        )
          throw new Error("AgentKib tool is not allowed by the current Agent policy");
        const payload = BUILTIN_MCP_TOOLS.some((tool) => tool.name === name)
          ? scope.remote
            ? (() => {
                throw new Error(
                  "Built-in AgentKib tools are not exposed over unauthenticated LAN mode",
                );
              })()
            : await this.builtins.call(project, current.archiveWorkspaceId, scope.agent, name, args)
          : await this.manager.callHubTool(project, scope.agent, name, args, scope.remote, () => {
              this.#assertScope(scope, name);
            });
        if (isMcpToolResult(payload)) return payload;
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          ...(typeof payload === "object" && payload !== null && !Array.isArray(payload)
            ? { structuredContent: payload as Record<string, unknown> }
            : {}),
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text", text: error instanceof Error ? error.message : "MCP tool failed" },
          ],
        };
      }
    });
    transport.onclose = () => {
      if (sessionIdCreated) this.#sessions.delete(sessionIdCreated);
      void mcpServer.close();
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(request, response);
  }

  #assertScope(scope: Scope, name?: string) {
    const current =
      name === "session_search" || name === "session_read_chunk"
        ? requireUniqueContinuationWorkspace(this.store, scope.workspaceId, scope.project)
        : resolveWorkspaceIdentity(this.store, scope.workspaceId);
    if (
      current.registeredId !== scope.registeredWorkspaceId ||
      lexicalPathIdentity(current.project) !== lexicalPathIdentity(scope.project)
    )
      throw new Error("MCP workspace identity changed; reconnect before reading");
    return current;
  }

  #listTools(project: string, scope: Scope) {
    this.#assertScope(scope);
    const external = this.manager.hubTools(project, scope.agent, scope.remote).map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.input_schema,
      annotations: { readOnlyHint: tool.read_only },
    }));
    return scope.remote
      ? external
      : [
          ...BUILTIN_MCP_TOOLS.filter((tool) =>
            this.manager.builtinAllowed(project, scope.agent, tool.name),
          ).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: { readOnlyHint: tool.readOnlyHint },
          })),
          ...external,
        ];
  }
}

function isMcpToolResult(value: unknown): value is CallToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "content" in value &&
    Array.isArray(value.content) &&
    value.content.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        "type" in item &&
        typeof item.type === "string",
    )
  );
}

function bindHost(settings: McpNetworkSettings): string {
  return settings.lan_enabled ? "0.0.0.0" : "127.0.0.1";
}
function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address?.startsWith("127.") === true
  );
}
function accessibleAddresses(port: number): string[] {
  const values = new Set<string>([`127.0.0.1:${port}`]);
  for (const interfaces of Object.values(networkInterfaces()))
    for (const entry of interfaces ?? [])
      if (!entry.internal && entry.family === "IPv4") values.add(`${entry.address}:${port}`);
  return [...values].sort();
}
function parseAgent(value: string): string {
  const aliases: Record<string, string> = {
    codex: "codex",
    "claude-code": "claude-code",
    cursor: "cursor",
    opencode: "opencode",
    openclaw: "open-claw",
    "open-claw": "open-claw",
    hermes: "hermes",
    grok: "grok-build",
    "grok-build": "grok-build",
    antigravity: "antigravity",
    "deepseek-harness": "deepseek-harness",
    dsh: "deepseek-harness",
  };
  const agent = aliases[value];
  if (!agent) throw new Error("Unknown Agent");
  return agent;
}
