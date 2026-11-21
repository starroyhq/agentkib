import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  markPossiblyOverwritten,
  readClaudeGlobalWrites,
  recordClaudeGlobalWrite,
} from "../../../packages/backend/src/agents/claude/claude-global-writes";
import { Commands } from "../../../packages/backend/src/commands";
import { McpManager } from "../../../packages/backend/src/mcp";
import { McpManagement } from "../../../packages/backend/src/mcp-management";
import { scanNativeMcp } from "../../../packages/backend/src/mcp-native-scan";
import { canonicalize } from "../../../packages/backend/src/paths";
import { BackendStore } from "../../../packages/backend/src/store";

// Claude Code may write its own copy of the global configuration file back over what AgentKib
// changed. The migration leaves a record (path, names, hash; no value), and the next scan marks
// servers that were taken out but are back in a file that no longer matches what was written.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const KEY = "mcp.manage.diagnostic.native_possibly_overwritten";
const codes = (item: { warning_messages?: { key: string }[] }) =>
  (item.warning_messages ?? []).map((message) => message.key);

function directory() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-global-writes-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const candidate = (file: string, name: string, extra: Record<string, unknown> = {}) => ({
  agent: "claude-code",
  scope: "home",
  name,
  source_path: file,
  warnings: [] as string[],
  warning_messages: [] as { key: string }[],
  ...extra,
});

describe("the record", () => {
  it("holds a path, names, a time and a hash, and nothing from the file", () => {
    const root = directory();
    const file = path.join(root, ".claude.json");
    recordClaudeGlobalWrite(root, { file, names: ["alpha"], content: '{"token":"VALUE-CANARY"}' });
    const raw = readFileSync(path.join(root, "claude-global-writes.json"), "utf8");
    expect(raw).not.toContain("VALUE-CANARY");
    expect(readClaudeGlobalWrites(root)).toEqual([
      expect.objectContaining({
        file,
        names: ["alpha"],
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    ]);
  });

  it("ignores a broken or oversized record, and old entries", () => {
    const root = directory();
    writeFileSync(path.join(root, "claude-global-writes.json"), "{not json");
    expect(readClaudeGlobalWrites(root)).toEqual([]);
    writeFileSync(
      path.join(root, "claude-global-writes.json"),
      JSON.stringify([
        {
          file: "/x",
          names: ["a"],
          hash: "h",
          at: new Date(Date.now() - 40 * 86_400_000).toISOString(),
        },
      ]),
    );
    expect(readClaudeGlobalWrites(root)).toEqual([]);
  });

  it("keeps one entry per file", () => {
    const root = directory();
    const file = path.join(root, ".claude.json");
    recordClaudeGlobalWrite(root, { file, names: ["a"], content: "1" });
    recordClaudeGlobalWrite(root, { file, names: ["b"], content: "2" });
    expect(readClaudeGlobalWrites(root).map((item) => item.names)).toEqual([["b"]]);
  });
});

describe("marking a server that came back", () => {
  function setup(content: string) {
    const root = directory();
    const file = path.join(root, ".claude.json");
    writeFileSync(file, content);
    recordClaudeGlobalWrite(root, { file, names: ["moved"], content });
    return { root, file };
  }

  it("marks it when the file no longer matches what AgentKib wrote", () => {
    const { root, file } = setup('{"mcpServers":{"agentkib":{}}}');
    writeFileSync(file, '{"mcpServers":{"moved":{},"agentkib":{}}}');
    const [marked, other] = markPossiblyOverwritten(
      [candidate(file, "moved"), candidate(file, "never-migrated")],
      root,
    );
    expect(codes(marked!)).toEqual([KEY]);
    expect(marked!.warnings[0]).toContain("Close Claude Code, then migrate again");
    expect(codes(other!)).toEqual([]);
  });

  it("says nothing while the file is exactly what AgentKib wrote", () => {
    const { root, file } = setup('{"mcpServers":{"moved":{}}}');
    expect(codes(markPossiblyOverwritten([candidate(file, "moved")], root)[0]!)).toEqual([]);
  });

  it("only concerns the user-scope servers of that very file", () => {
    const { root, file } = setup("{}");
    writeFileSync(file, '{"x":1}');
    const items = markPossiblyOverwritten(
      [
        candidate(file, "moved", { scope: "local" }),
        candidate(file, "moved", { agent: "codex" }),
        candidate(path.join(root, "other.json"), "moved"),
      ],
      root,
    );
    for (const item of items) expect(codes(item)).toEqual([]);
  });

  it("marks a server once", () => {
    const { root, file } = setup("{}");
    writeFileSync(file, '{"x":1}');
    const [item] = markPossiblyOverwritten([candidate(file, "moved")], root);
    markPossiblyOverwritten([item!], root);
    expect(codes(item!)).toEqual([KEY]);
  });
});

describe("after a real migration", () => {
  it("records what the migration took out and flags it when an older copy is written back", async () => {
    const root = directory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const data = path.join(root, "data");
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(project, ".agentkib"), { recursive: true });
    writeFileSync(
      path.join(project, ".agentkib/manifest.yaml"),
      "schema_version: 2\nworkspace:\n  id: registered\n  name: fixture\n",
    );
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (message.id === undefined) return void response.writeHead(202).end();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result:
            message.method === "initialize"
              ? {
                  protocolVersion: message.params.protocolVersion,
                  serverInfo: { name: "fixture", version: "1" },
                  capabilities: { tools: {} },
                }
              : { tools: [{ name: "read", inputSchema: { type: "object" } }] },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("port");
    const environment = { HOME: home, USERPROFILE: home };
    const store = new BackendStore(path.join(data, "db.sqlite"));
    cleanups.push(() => store.close());
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "registered",
      project,
      "fixture",
      "healthy",
      new Date().toISOString(),
    );
    const commands = new Commands();
    cleanups.push(() => commands.close());
    const manager = new McpManager(store.sql, environment, data, commands);
    cleanups.push(() => manager.closeAsync());
    const management = new McpManagement(store, environment, data, manager);
    const hub = { running: true, port: 47653 };
    const file = path.join(home, ".claude.json");
    const before = JSON.stringify({
      numStartups: 3,
      mcpServers: { tool: { type: "http", url: `http://127.0.0.1:${address.port}/mcp` } },
    });
    writeFileSync(file, before);
    const found = () =>
      scanNativeMcp({ project }, store, environment).filter(
        (item) => item.agent === "claude-code" && item.scope === "home",
      );
    const toMigrate = found().find((item) => item.name === "tool")!;
    expect(toMigrate.supported).toBe(true);
    const preview = management.previewImport({ project, candidateIds: [toMigrate.id] });
    management.applyImport({
      project,
      token: preview.token,
      revision: preview.revision,
      selections: [{ key: toMigrate.id, action: "add" }],
    });
    const state = management.state({ project });
    management.save({
      project,
      revision: state.revision,
      originalId: "tool",
      server: { ...state.servers[0]!.config, enabled: true },
    });
    await manager.probe("tool", project);
    const migration = await management.previewMigration(
      { project, revision: management.state({ project }).revision, candidateIds: [toMigrate.id] },
      hub,
    );
    expect(
      migration.changes.map((change) => [path.basename(change.target), change.scope]),
    ).toContainEqual([".claude.json", "agent-home"]);
    management.applyMigration({ token: migration.token, approveHome: true }, hub);

    // The record names the server that left the file, and nothing else.
    const records = readClaudeGlobalWrites(data);
    expect(records).toEqual([expect.objectContaining({ file, names: ["tool"] })]);
    expect(readFileSync(path.join(data, "claude-global-writes.json"), "utf8")).not.toContain(
      "127.0.0.1",
    );
    // Right after the write nothing is wrong.
    expect(found().map((item) => item.name)).toEqual([]);
    // A running Claude Code writes its older copy of the file back.
    writeFileSync(file, before);
    const flagged = markPossiblyOverwritten(found(), data);
    expect(flagged.map((item) => [item.name, codes(item)])).toEqual([["tool", [KEY]]]);
  });
});
