import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Commands } from "../../../packages/backend/src/commands";
import { Context } from "../../../packages/backend/src/context";
import { McpManager, mcpToolCacheKey } from "../../../packages/backend/src/mcp";
import { BUILTIN_MCP_TOOLS, McpBuiltins } from "../../../packages/backend/src/mcp-builtin";
import { type McpServer } from "../../../packages/backend/src/mcp-config-read";
import {
  mcpConnectionInfo,
  planMcpConnection,
  verifyMcpConnection,
} from "../../../packages/backend/src/mcp-connection";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { McpOAuth } from "../../../packages/backend/src/mcp-oauth";
import { buildSessionArchive } from "../../../packages/backend/src/session-archive";
import { BackendStore } from "../../../packages/backend/src/store";
import { canonicalize } from "../../../packages/backend/src/paths";

const requireBackend = createRequire(
  new URL("../../../packages/backend/package.json", import.meta.url),
);
const { Client } = requireBackend("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = requireBackend(
  "@modelcontextprotocol/sdk/client/streamableHttp.js",
);

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function availablePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return address.port;
}

function server(
  id: string,
  overrides: Partial<Pick<McpServer, "enabled" | "targets" | "allow_tools">> = {},
): McpServer {
  return {
    id,
    name: id,
    enabled: true,
    transport: "stdio",
    command: "fixture-mcp-must-not-run",
    args: [],
    env: {},
    headers: {},
    targets: [],
    allow_tools: [],
    lan_allow_tools: [],
    supports_parallel_tool_calls: false,
    ...overrides,
  };
}

async function fixture(
  servers: McpServer[],
  manifestId: string = "manifest-workspace",
  workspaceId: string = "registered-workspace",
  limits: ConstructorParameters<typeof McpHub>[5] = {},
) {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "agentkib-mcp-hub-check-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const data = path.join(root, "data");
  const configDirectory = path.join(home, ".agentkib");
  mkdirSync(configDirectory, { recursive: true });
  mkdirSync(project);
  // The manager reads only this temporary Home and workspace; no upstream command may run.
  const environment = { HOME: home, USERPROFILE: home, PATH: path.join(root, "empty-bin") };
  writeFileSync(
    path.join(configDirectory, "mcp.json"),
    JSON.stringify({ schema_version: 1, servers }),
  );
  const store = new BackendStore(path.join(data, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
    workspaceId,
    project,
    "Fixture workspace",
    manifestId,
    "healthy",
    "2026-10-06T00:00:00Z",
  );
  function seedCatalog(item: McpServer, scopedProject: string) {
    store.sql.run(
      "INSERT INTO mcp_tool_cache(server_id,tool_name,descriptor_json,probed_at) VALUES(?,?,?,?)",
      mcpToolCacheKey(item, scopedProject, environment),
      "",
      JSON.stringify({
        schema_version: 2,
        tools: ["read", "write"].map((name) => ({
          server_id: item.id,
          name,
          input_schema: { type: "object" },
          read_only: name === "read",
        })),
      }),
      "2026-10-06T00:00:00Z",
    );
  }
  for (const item of servers) seedCatalog(item, project);
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const manager = new McpManager(store.sql, environment, data, commands);
  cleanups.push(() => manager.closeAsync());
  const builtins = new McpBuiltins(store, new Context(store.catalog, commands, environment), data);
  const port = await availablePort();
  const hub = new McpHub(
    manager,
    store,
    builtins,
    new McpOAuth(manager, () => port),
    {
      port,
      lan_enabled: false,
      lan_risk_accepted: false,
    },
    limits,
  );
  cleanups.push(() => hub.close());
  const probe = vi.spyOn(manager, "probe").mockRejectedValue(new Error("Unexpected probe"));
  const callHubTool = vi
    .spyOn(manager, "callHubTool")
    .mockRejectedValue(new Error("Unexpected upstream tool call"));
  const callBuiltin = vi
    .spyOn(builtins, "call")
    .mockRejectedValue(new Error("Unexpected builtin tool call"));
  const runCommand = vi
    .spyOn(commands, "run")
    .mockRejectedValue(new Error("Unexpected command execution"));
  await hub.start();
  return {
    project,
    registerWorkspace(id: string, manifest: string = manifestId) {
      const directory = mkdtempSync(path.join(root, "extra-project-"));
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,manifest_workspace_id,status,last_discovered_at) VALUES(?,?,?,?,?,?)",
        id,
        directory,
        "Another fixture workspace",
        manifest,
        "healthy",
        "2026-10-06T00:00:00Z",
      );
      for (const item of servers) seedCatalog(item, directory);
      return directory;
    },
    setManifest(id: string, manifest: string) {
      store.sql.run("UPDATE workspaces SET manifest_workspace_id = ? WHERE id = ?", manifest, id);
    },
    info: (id: string) =>
      mcpConnectionInfo(
        { workspaceId: id, targetAgent: "cursor" },
        store,
        hub.status(),
        environment,
      ),
    plan: (id: string) =>
      planMcpConnection(
        { workspaceId: id, targetAgent: "cursor" },
        store,
        hub.status(),
        environment,
      ),
    verify: (targetAgent: "cursor" | "codex", id: string = workspaceId) =>
      verifyMcpConnection({ workspaceId: id, targetAgent }, store, () => hub.status(), environment),
    /** A client that keeps its session open, like an Agent CLI that never ends it. */
    async openClient(id = workspaceId) {
      const client = new Client({ name: "fixture-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${port}/mcp/v1/workspaces/${encodeURIComponent(id)}/agents/cursor`,
        ),
      );
      await client.connect(transport);
      cleanups.push(() => client.close());
      return client as { listTools(): Promise<{ tools: Array<{ name: string }> }> };
    },
    async listRoute(
      id: string,
      beforeList?: () => void,
    ): Promise<{ tools: Array<{ name: string }> }> {
      const client = new Client({ name: "fixture-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${port}/mcp/v1/workspaces/${encodeURIComponent(id)}/agents/cursor`,
        ),
      );
      try {
        await client.connect(transport);
        beforeList?.();
        return await client.listTools();
      } finally {
        await transport.terminateSession().catch(() => undefined);
        await client.close();
      }
    },
    async readArchiveRoute(id: string) {
      const archiveId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const archive = buildSessionArchive(
        {
          schema_version: 1,
          source: { agent: "codex", workspace_id: manifestId },
          turns: [
            {
              id: "turn-1",
              role: "user",
              blocks: [{ type: "text", text: "Existing continuation archive" }],
            },
          ],
          losses: [],
          redaction_count: 0,
        },
        manifestId,
        archiveId,
        "fixture-fingerprint",
      );
      const directory = path.join(
        data,
        "continuations",
        createHash("sha256").update(manifestId).digest("hex").slice(0, 32),
        archiveId,
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "manifest.json"), archive.manifest_content);
      writeFileSync(path.join(directory, "document.json"), archive.document_content);
      writeFileSync(path.join(directory, "chunks.jsonl"), archive.chunks_content);
      callBuiltin.mockImplementation((...args) => {
        if (!["session_search", "session_read_chunk"].includes(args[3]))
          throw new Error("Unexpected builtin tool call");
        return McpBuiltins.prototype.call.apply(builtins, args);
      });
      const client = new Client({ name: "fixture-archive-client", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(
        new URL(
          `http://127.0.0.1:${port}/mcp/v1/workspaces/${encodeURIComponent(id)}/agents/cursor`,
        ),
      );
      try {
        await client.connect(transport);
        const search = await client.callTool({
          name: "session_search",
          arguments: { archive_id: archiveId, query: "Existing" },
        });
        const chunk = await client.callTool({
          name: "session_read_chunk",
          arguments: { archive_id: archiveId, chunk_id: "chunk-000001" },
        });
        expect(probe).not.toHaveBeenCalled();
        expect(callHubTool).not.toHaveBeenCalled();
        expect(runCommand).not.toHaveBeenCalled();
        return { search, chunk };
      } finally {
        await transport.terminateSession().catch(() => undefined);
        await client.close();
      }
    },
    assertDirectoryOnly() {
      expect(probe).not.toHaveBeenCalled();
      expect(callHubTool).not.toHaveBeenCalled();
      expect(callBuiltin).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expect(manager.runtimes()).toEqual([]);
      expect(store.sql.rows("SELECT server_id FROM mcp_tool_cache")).toHaveLength(
        servers.length * store.sql.rows("SELECT id FROM workspaces").length,
      );
    },
  };
}

describe("MCP connection verification through the actual AgentKib Hub", () => {
  it("uses enabled, target-Agent and allow-list filters without probing or calling tools", async () => {
    const f = await fixture([
      server("all"),
      server("disabled", { enabled: false }),
      server("cursor-only", { targets: ["cursor"] }),
      server("codex-only", { targets: ["codex"] }),
      server("limited", { allow_tools: ["read"] }),
    ]);

    const cursor = await f.verify("cursor");
    expect(cursor.external_tools).toEqual([
      "all__read",
      "all__write",
      "cursor-only__read",
      "cursor-only__write",
      "limited__read",
    ]);
    const codex = await f.verify("codex");
    expect(codex.external_tools).toEqual([
      "all__read",
      "all__write",
      "codex-only__read",
      "codex-only__write",
      "limited__read",
    ]);
    expect(cursor.builtin_tools).toBe(BUILTIN_MCP_TOOLS.length);
    f.assertDirectoryOnly();
  });

  it("reports only builtins when cached upstream tools are not enabled for the Agent", async () => {
    const f = await fixture([
      server("disabled", { enabled: false }),
      server("codex-only", { targets: ["codex"] }),
    ]);

    expect(await f.verify("cursor")).toMatchObject({
      builtin_tools: BUILTIN_MCP_TOOLS.length,
      external_tools: [],
    });
    f.assertDirectoryOnly();
  });

  it("resolves the encoded registered identity on the real Hub route", async () => {
    const f = await fixture([server("shared")], "manifest-workspace", "workspace /雪!'()*");

    const result = await f.verify("cursor");
    expect(result.url).toContain(
      "/mcp/v1/workspaces/workspace%20%2F%E9%9B%AA%21%27%28%29%2A/agents/cursor",
    );
    expect(result.external_tools).toEqual(["shared__read", "shared__write"]);
    f.assertDirectoryOnly();
  });

  it("applies workspace service overrides while the connection remains workspace-scoped", async () => {
    const f = await fixture([server("shared")]);
    mkdirSync(path.join(f.project, ".agentkib"));
    writeFileSync(
      path.join(f.project, ".agentkib", "mcp.json"),
      JSON.stringify({ schema_version: 1, servers: [server("shared", { enabled: false })] }),
    );

    const result = await f.verify("cursor");
    expect(result.url).toContain("/workspaces/registered-workspace/agents/cursor");
    expect(result.external_tools).toEqual([]);
    expect(result.builtin_tools).toBe(BUILTIN_MCP_TOOLS.length);
    f.assertDirectoryOnly();
  });

  it("keeps workspaces with a shared manifest ID on separate registered endpoints", async () => {
    const f = await fixture([server("shared")]);
    const selected = f.registerWorkspace("selected-workspace");
    mkdirSync(path.join(f.project, ".agentkib"));
    writeFileSync(
      path.join(f.project, ".agentkib", "mcp.json"),
      JSON.stringify({ schema_version: 1, servers: [server("shared", { enabled: false })] }),
    );

    const selectedInfo = f.info("selected-workspace");
    expect(selectedInfo.workspace_id).toBe("selected-workspace");
    expect(selectedInfo.target).toBe(path.join(selected, ".cursor/mcp.json"));
    expect(selectedInfo.url).not.toBe(f.info("registered-workspace").url);
    expect(f.plan("selected-workspace").changes.map((change) => change.target)).toEqual([
      selectedInfo.target,
    ]);
    expect((await f.verify("cursor", "selected-workspace")).external_tools).toEqual([
      "shared__read",
      "shared__write",
    ]);
    expect((await f.verify("cursor")).external_tools).toEqual([]);
    await expect(f.listRoute("manifest-workspace")).rejects.toMatchObject({ code: 400 });
    f.assertDirectoryOnly();
  });

  it("prefers a registered ID over another workspace's manifest alias", async () => {
    const f = await fixture([server("shared")], "selected-workspace");
    const selected = f.registerWorkspace("selected-workspace", "another-manifest");
    mkdirSync(path.join(f.project, ".agentkib"));
    writeFileSync(
      path.join(f.project, ".agentkib", "mcp.json"),
      JSON.stringify({ schema_version: 1, servers: [server("shared", { enabled: false })] }),
    );

    expect(f.info("selected-workspace").target).toBe(path.join(selected, ".cursor/mcp.json"));
    expect(f.plan("selected-workspace").project_root).toBe(selected);
    const listed = await f.listRoute("selected-workspace");
    expect(listed.tools.map((tool) => tool.name)).toContain("shared__read");
    expect((await f.verify("cursor", "selected-workspace")).external_tools).toEqual([
      "shared__read",
      "shared__write",
    ]);
    f.assertDirectoryOnly();
  });

  it("keeps an unambiguous legacy manifest route working", async () => {
    const f = await fixture([server("shared")], "legacy /雪!'()*");
    const listed = await f.listRoute("legacy /雪!'()*");

    expect(listed.tools.map((tool) => tool.name)).toContain("shared__read");
    expect(listed.tools).toHaveLength(BUILTIN_MCP_TOOLS.length + 2);
    f.assertDirectoryOnly();
  });

  it.each(["registered-workspace", "manifest-workspace"])(
    "reads existing continuation archives through the %s route",
    async (id) => {
      const f = await fixture([]);
      await f.verify("cursor");
      f.assertDirectoryOnly();

      const { search, chunk } = await f.readArchiveRoute(id);
      expect(search.isError).not.toBe(true);
      expect(search.structuredContent).toMatchObject({
        hits: [{ content: "Existing continuation archive" }],
      });
      expect(chunk.isError).not.toBe(true);
      expect(chunk.structuredContent).toMatchObject({ content: "Existing continuation archive" });
    },
  );

  it("rejects ambiguous legacy routes before exposing either workspace's directory", async () => {
    const f = await fixture([server("shared")]);
    f.registerWorkspace("second-workspace");

    await expect(f.listRoute("manifest-workspace")).rejects.toMatchObject({ code: 400 });
    f.assertDirectoryOnly();
  });

  it("closes the least recently used session beyond the limit", async () => {
    const f = await fixture([server("shared")], undefined, undefined, { sessions: 2 });
    const first = await f.openClient();
    const second = await f.openClient();
    // Using the first session makes the second the least recently used one.
    await first.listTools();
    const third = await f.openClient();
    await expect(second.listTools()).rejects.toMatchObject({ code: 404 });
    expect((await first.listTools()).tools.length).toBeGreaterThan(0);
    expect((await third.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("closes sessions left unused for the idle time when a new one starts", async () => {
    const f = await fixture([server("shared")], undefined, undefined, { sessionIdleMs: 60_000 });
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    const abandoned = await f.openClient();
    const active = await f.openClient();
    now.mockReturnValue(1_050_000);
    await active.listTools();
    now.mockReturnValue(1_070_000);
    await f.openClient();
    await expect(abandoned.listTools()).rejects.toMatchObject({ code: 404 });
    expect((await active.listTools()).tools.length).toBeGreaterThan(0);
  });

  it("rejects a legacy session after its alias moves to a different registered workspace", async () => {
    const f = await fixture([server("shared")]);
    f.registerWorkspace("second-workspace", "another-manifest");

    await expect(
      f.listRoute("manifest-workspace", () => {
        f.setManifest("registered-workspace", "retired-manifest");
        f.setManifest("second-workspace", "manifest-workspace");
      }),
    ).rejects.toMatchObject({ code: 404 });
    f.assertDirectoryOnly();
  });
});
