import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export type ClaudeGoalReportBinding = {
  goalId: string;
  goalGeneration: string;
  stepId: string;
  bootId: string;
};
export type ClaudeGoalReport = ClaudeGoalReportBinding & {
  reportId: string;
  outcome: "continue" | "complete" | "blocked";
  summary: string;
  evidence: string[];
  remainingWork: string[];
};
export type ClaudeGoalReportEndpoint = {
  mcpConfig: Record<string, unknown>;
  close(): Promise<void>;
};

const toolName = "report_goal_step";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  Buffer.byteLength(value) <= max &&
  !value.includes("\0");

/** A private, boot/goal/step-scoped reporter. Reports are claims, never completion authority. */
export async function createClaudeGoalReportEndpoint(
  suppliedBinding: ClaudeGoalReportBinding,
  onReport: (report: ClaudeGoalReport) => void | Promise<void>,
): Promise<ClaudeGoalReportEndpoint> {
  const binding = Object.freeze({ ...suppliedBinding });
  if (
    Object.keys(binding).length !== 4 ||
    ![binding.goalId, binding.goalGeneration, binding.stepId, binding.bootId].every((value) =>
      boundedText(value, 256),
    )
  )
    throw new Error("invalid Claude goal report binding");
  const [
    { Server: McpServer },
    { StreamableHTTPServerTransport: McpTransport },
    { CallToolRequestSchema, ListToolsRequestSchema },
  ] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/types.js"),
  ]);
  // The capability URL exists only in this process and this runner's launch config.
  // A new boot/step gets a new listener and token; nothing is written to user settings.
  const endpointPath = `/goal/${randomBytes(32).toString("hex")}`;
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  const connections = new Set<{ server: Server; transport: StreamableHTTPServerTransport }>();
  let closed = false;
  let report: ClaudeGoalReport | undefined;
  let fingerprint: string | undefined;
  let recording: Promise<void> | undefined;
  let recordingFailed = false;
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
      if (request.method !== "POST" || connections.size >= 4) {
        response.writeHead(400).end();
        return;
      }
      const body = await readBody(request);
      if (closed || connections.size >= 4 || !isObject(body) || body.method !== "initialize") {
        response.writeHead(400).end();
        return;
      }
      const server = new McpServer(
        { name: "agentkib-goal-report", version: "1.0.0" },
        {
          capabilities: { tools: {} },
          instructions:
            "Report this goal step's evidence with report_goal_step before finishing. A report is pending until the host verifies the same step's successful native result. Never infer completion from text alone.",
        },
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
      // Count initialization before awaiting connect: concurrent request bodies cannot
      // overrun the limit, and close() also owns transports without a session ID yet.
      connections.add(connection);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: toolName,
            description:
              "Submit one pending report for the current AgentKib goal step. Use complete only with concrete evidence; blocked requires the missing condition. This tool does not complete or schedule a goal itself.",
            inputSchema: {
              type: "object",
              properties: {
                reportId: { type: "string", format: "uuid" },
                outcome: { type: "string", enum: ["continue", "complete", "blocked"] },
                summary: { type: "string", minLength: 1, maxLength: 4096 },
                evidence: {
                  type: "array",
                  maxItems: 16,
                  items: { type: "string", minLength: 1, maxLength: 2048 },
                },
                remainingWork: {
                  type: "array",
                  maxItems: 16,
                  items: { type: "string", minLength: 1, maxLength: 2048 },
                },
              },
              required: ["reportId", "outcome", "summary", "evidence", "remainingWork"],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
        ],
      }));
      server.setRequestHandler(CallToolRequestSchema, async (message) => {
        try {
          if (closed || recordingFailed || message.params.name !== toolName)
            throw new Error("Claude goal report endpoint unavailable");
          const input = validateReport(message.params.arguments);
          const candidate = { ...binding, ...input };
          const candidateFingerprint = JSON.stringify(candidate);
          const duplicate = report !== undefined;
          if (duplicate && candidateFingerprint !== fingerprint)
            throw new Error("Claude goal step already has a different pending report");
          if (!duplicate) {
            report = candidate;
            fingerprint = candidateFingerprint;
            // Reserve before awaiting persistence so concurrent retries never duplicate a write.
            recording = Promise.resolve()
              .then(() => {
                if (closed) throw new Error("Claude goal report endpoint closed");
                return onReport(structuredClone(candidate));
              })
              .catch((error: unknown) => {
                recordingFailed = true;
                throw error;
              });
          }
          await recording;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  accepted: true,
                  status: "pending",
                  reportId: report!.reportId,
                  stepId: binding.stepId,
                  duplicate,
                }),
              },
            ],
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Goal report rejected; the host has not confirmed completion. Check this step's report and state.",
              },
            ],
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
        if (closed) throw new Error("Claude goal report endpoint closed");
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
  http.requestTimeout = 10_000;
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
    throw new Error("Claude goal report listener unavailable");
  }
  host = `127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return {
    mcpConfig: {
      mcpServers: { agentkib_goal_report: { type: "http", url: `http://${host}${endpointPath}` } },
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const failures: unknown[] = [];
        if (recording) await recording.catch((error: unknown) => failures.push(error));
        for (const session of connections) {
          await session.transport.close().catch((error: unknown) => failures.push(error));
          await session.server.close().catch((error: unknown) => failures.push(error));
        }
        connections.clear();
        sessions.clear();
        await new Promise<void>((resolve, reject) => {
          http.close((error) => (error ? reject(error) : resolve()));
          http.closeAllConnections();
        });
        if (failures.length)
          throw new AggregateError(failures, "Claude goal report cleanup failed");
      })();
      return closing;
    },
  };
}

function validateReport(value: unknown): Omit<ClaudeGoalReport, keyof ClaudeGoalReportBinding> {
  if (
    !isObject(value) ||
    Object.keys(value).length !== 5 ||
    Object.keys(value).some(
      (key) => !["reportId", "outcome", "summary", "evidence", "remainingWork"].includes(key),
    ) ||
    typeof value.reportId !== "string" ||
    !uuidPattern.test(value.reportId) ||
    !["continue", "complete", "blocked"].includes(String(value.outcome)) ||
    !boundedText(value.summary, 4096)
  )
    throw new Error("invalid Claude goal report");
  const evidence = stringList(value.evidence);
  const remainingWork = stringList(value.remainingWork);
  if (value.outcome === "complete" && (evidence.length === 0 || remainingWork.length !== 0))
    throw new Error("Claude completion report requires evidence and no remaining work");
  if (value.outcome !== "complete" && remainingWork.length === 0)
    throw new Error("Claude unfinished goal report requires remaining work");
  return {
    reportId: value.reportId,
    outcome: value.outcome as ClaudeGoalReport["outcome"],
    summary: value.summary,
    evidence,
    remainingWork,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => !boundedText(item, 2048)))
    throw new Error("invalid Claude goal report list");
  return [...value];
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").startsWith("application/json"))
    throw new Error("JSON required");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > 64 * 1024) throw new Error("Claude goal request too large");
    chunks.push(data);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
