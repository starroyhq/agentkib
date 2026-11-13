import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type EndpointTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
};
export type EndpointResult = { text: string; isError?: boolean };

export type LeadEndpoint = {
  /** `--mcp-config` content naming only this endpoint. */
  mcpConfig: Record<string, unknown>;
  url: string;
  close(): Promise<void>;
};

const MAX_BODY = 256 * 1024;
const MAX_CONNECTIONS = 4;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * A private MCP endpoint for one lead session: loopback only, at a random capability path that
 * exists only in this process and in that session's launch arguments, as the goal reporter's
 * (`claude-goal-report.ts`). The tools act for the session the endpoint was opened for; a call
 * cannot name another session or device.
 */
export async function openLeadEndpoint(options: {
  serverName: string;
  instructions: string;
  tools: () => EndpointTool[];
  call: (name: string, input: Record<string, unknown>) => Promise<EndpointResult>;
}): Promise<LeadEndpoint> {
  const [
    { Server: McpServer },
    { StreamableHTTPServerTransport: McpTransport },
    { CallToolRequestSchema, ListToolsRequestSchema },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  const endpointPath = `/lead/${randomBytes(32).toString("hex")}`;
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  const connections = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>();
  let closed = false;
  let host = "";

  const http = createServer((request, response) => {
    void (async () => {
      if (
        closed ||
        request.url !== endpointPath ||
        request.headers.host !== host ||
        request.headers.origin !== undefined ||
        request.socket.remoteAddress !== "127.0.0.1"
      ) {
        response.writeHead(404).end();
        return;
      }
      const sessionId = request.headers["mcp-session-id"];
      if (sessionId !== undefined) {
        const session = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
        if (!session) {
          response.writeHead(404).end();
          return;
        }
        const body = request.method === "POST" ? await readBody(request) : undefined;
        await session.transport.handleRequest(request, response, body);
        return;
      }
      if (request.method !== "POST" || connections.size >= MAX_CONNECTIONS) {
        response.writeHead(400).end();
        return;
      }
      const body = await readBody(request);
      if (
        closed ||
        connections.size >= MAX_CONNECTIONS ||
        !isObject(body) ||
        body.method !== "initialize"
      ) {
        response.writeHead(400).end();
        return;
      }
      const server = new McpServer(
        { name: options.serverName, version: "1.0.0" },
        { capabilities: { tools: {} }, instructions: options.instructions },
      );
      let createdId: string | undefined;
      const transport = new McpTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [host],
        allowedOrigins: [],
        onsessioninitialized: (id) => {
          createdId = id;
          sessions.set(id, { server, transport });
        },
      });
      const connection = { server, transport };
      connections.add(connection);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: options.tools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: tool.readOnly,
            destructiveHint: false,
            idempotentHint: tool.readOnly,
            openWorldHint: false,
          },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (message) => {
        if (closed) return { isError: true, content: [{ type: "text", text: "lead-unavailable" }] };
        const input = isObject(message.params.arguments) ? message.params.arguments : {};
        try {
          const result = await options.call(message.params.name, input);
          return {
            ...(result.isError ? { isError: true } : {}),
            content: [{ type: "text", text: result.text }],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: error instanceof Error ? error.message : "failed" }],
          };
        }
      });
      transport.onclose = () => {
        if (createdId) sessions.delete(createdId);
        connections.delete(connection);
        void server.close();
      };
      try {
        await server.connect(transport);
        if (closed) throw new Error("lead endpoint closed");
        await transport.handleRequest(request, response, body);
      } catch (error) {
        await server.close();
        connections.delete(connection);
        throw error;
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  http.requestTimeout = 30_000;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string") {
    http.close();
    throw new Error("lead endpoint listener unavailable");
  }
  host = `127.0.0.1:${address.port}`;
  const url = `http://${host}${endpointPath}`;
  let closing: Promise<void> | undefined;
  return {
    url,
    mcpConfig: { mcpServers: { [options.serverName]: { type: "http", url } } },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        for (const session of connections) {
          await session.transport.close().catch(() => undefined);
          await session.server.close().catch(() => undefined);
        }
        connections.clear();
        sessions.clear();
        await new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        });
      })();
      return closing;
    },
  };
}
