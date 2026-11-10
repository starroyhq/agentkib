import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RUNTIME_METHODS as M,
  type NativeMemorySnapshot,
  type NativeMemoryDetail,
} from "@agentkib/runtime-protocol";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { BACKEND_INITIALIZE } from "../../../packages/backend/src/migration";
import { BackendStore } from "../../../packages/backend/src/store";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { claudeProjectKey } from "../../../packages/backend/src/claude-project-path";
import { canonicalize } from "../../../packages/backend/src/paths";
import { Context } from "../../../packages/backend/src/context";
import { Commands } from "../../../packages/backend/src/commands";
import { McpBuiltins, BUILTIN_MCP_TOOLS } from "../../../packages/backend/src/mcp-builtin";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function fixture() {
  const root = canonicalize(mkdtempSync(path.join(os.tmpdir(), "claude-native-memory-rpc-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data"),
    project = path.join(root, "project"),
    config = path.join(root, "claude");
  for (const dir of [data, project, config]) mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(data, "preferences.json"),
    JSON.stringify({
      session_index_enabled: false,
      session_content_search_enabled: false,
      quota_auto_refresh_enabled: false,
    }),
  );
  const store = new BackendStore(path.join(data, "agentkib.db"));
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "native-fixture",
    project,
    "Native fixture",
    "healthy",
    new Date().toISOString(),
  );
  store.close();
  const key = claudeProjectKey(project);
  if (!key.ok) throw new Error("Invalid fixture key");
  const memory = path.join(config, "projects", key.key, "memory");
  mkdirSync(memory, { recursive: true });
  const file = path.join(memory, "MEMORY.md");
  const original = "# Synthetic memory\n[Testing](testing.md)\n构建流程 使用 pnpm\n";
  writeFileSync(file, original);
  writeFileSync(path.join(memory, "testing.md"), "# Testing\n隔离测试，不调用模型。\n");
  vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
  vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
  const notifications: string[] = [];
  const environment = {
    HOME: root,
    USERPROFILE: root,
    CLAUDE_CONFIG_DIR: config,
    CODEX_HOME: path.join(root, "codex"),
    PATH: path.join(root, "bin"),
    APPDATA: path.join(root, "appdata"),
  };
  const backend = new TypeScriptBackend(environment, (method) => notifications.push(method));
  cleanups.push(() => backend.closeAsync());
  const request = (method: string, params: Record<string, unknown> = {}) =>
    backend.handleAsync({ jsonrpc: "2.0", id: 1, method, params });
  expect((await request(BACKEND_INITIALIZE, { dataDir: data })).error).toBeUndefined();
  return { request, file, original, notifications, project, data, environment };
}
describe("Claude native memory real runtime contract", () => {
  it("reads ungoverned workspace files and indexes updates without writing native files or platform memories", async () => {
    const f = await fixture();
    expect((await f.request(M.nativeMemoryList)).error).toBeUndefined();
    expect((await f.request(M.nativeMemoryRefresh)).error).toBeUndefined();
    const snapshot = (await f.request(M.nativeMemoryList)).result as NativeMemorySnapshot;
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.sources[0].workspaces).toEqual([
      { id: "native-fixture", name: "Native fixture" },
    ]);
    const index = snapshot.files.find((file) => file.kind === "index")!;
    const detail = (await f.request(M.nativeMemoryRead, { fileId: index.id }))
      .result as NativeMemoryDetail;
    expect(detail.content).toContain("构建流程");
    expect(detail.links[0]?.label).toBe("Testing");
    expect((await f.request(M.listGlobalMemories)).result).toEqual([]);
    expect(readFileSync(f.file, "utf8")).toBe(f.original);
    writeFileSync(f.file, "# Changed\n构建流程 新版本\n");
    await f.request(M.nativeMemoryObserve, { active: true });
    await vi.waitFor(
      async () => {
        const changed = (await f.request(M.nativeMemorySearch, { query: "构建流程 新版本" }))
          .result as NativeMemorySnapshot;
        expect(changed.files).toHaveLength(1);
      },
      { timeout: 7000 },
    );
    await f.request(M.nativeMemoryObserve, { active: false });
    await vi.waitFor(() => expect(f.notifications).toContain("memories.nativeChanged"));
    expect((await f.request(M.listGlobalMemories)).result).toEqual([]);
  });
  it("rejects path injection, malformed paging and arbitrary observer identities", async () => {
    const f = await fixture();
    for (const params of [{ project: "/" }, { offset: -1 }, { query: "x".repeat(513) }])
      expect((await f.request(M.nativeMemoryList, params)).error).toBeDefined();
    expect((await f.request(M.nativeMemoryRead, { fileId: f.file })).error).toBeDefined();
    expect(
      (await f.request(M.nativeMemoryObserve, { active: true, observerId: "other-user" })).error,
    ).toBeDefined();
    expect((await f.request(M.nativeMemoryRefresh, { directory: "/" })).error).toBeDefined();
  });
  it("keeps native bodies out of MCP memory search and preserves approved-only platform retrieval", async () => {
    const f = await fixture();
    await f.request(M.nativeMemoryRefresh);
    expect(
      (
        (await f.request(M.nativeMemorySearch, { query: "构建流程" }))
          .result as NativeMemorySnapshot
      ).total,
    ).toBe(1);
    mkdirSync(path.join(f.project, ".agentkib"));
    writeFileSync(
      path.join(f.project, ".agentkib/manifest.yaml"),
      "schema_version: 2\nworkspace:\n  id: native-fixture\n  name: Synthetic\n",
    );
    const store = new BackendStore(path.join(f.data, "agentkib.db"));
    cleanups.push(() => store.close());
    const commands = new Commands();
    cleanups.push(() => commands.close());
    const builtins = new McpBuiltins(
      store,
      new Context(store.catalog, commands, f.environment),
      f.data,
    );
    const search = (query: string) =>
      builtins.call(f.project, "native-fixture", "claude-code", "memory_search", { query });
    expect(await search("构建流程")).toEqual([]);
    const proposal = store.catalog.propose({
      project_id: "native-fixture",
      memory_type: "project_fact",
      content: "platform canary",
    });
    expect(await search("platform")).toEqual([]);
    store.catalog.review(proposal.id, "approved", null);
    expect(await search("platform")).toHaveLength(1);
    expect(BUILTIN_MCP_TOOLS.some((tool) => /native/i.test(tool.name))).toBe(false);
    expect(readFileSync(f.file, "utf8")).toBe(f.original);
  });
});
