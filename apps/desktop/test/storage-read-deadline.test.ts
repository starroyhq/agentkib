import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { BACKEND_INITIALIZE } from "../../../packages/backend/src/migration";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { WorkspaceStorageOwner } from "../../../packages/backend/src/storage";
import { BackendStore } from "../../../packages/backend/src/store";

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof filesystem>();
  return { ...actual, lstat: vi.fn(actual.lstat), readdir: vi.fn(actual.readdir) };
});

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("stops storage.children before reading descendants or siblings after the runtime deadline", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-storage-deadline-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  const first = path.join(workspace, "a");
  mkdirSync(first, { recursive: true });
  mkdirSync(path.join(workspace, "b"));
  writeFileSync(path.join(first, "child"), "fixture");
  mkdirSync(dataDir);
  writeFileSync(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({
      session_index_enabled: false,
      session_content_search_enabled: false,
      quota_auto_refresh_enabled: false,
    }),
  );
  const store = new BackendStore(path.join(dataDir, "agentkib.db"));
  try {
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "workspace",
      workspace,
      "Workspace",
      "healthy",
      "2026-11-12T00:00:00Z",
    );
  } finally {
    store.close();
  }
  vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
  vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
  const backend = new TypeScriptBackend({
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    APPDATA: path.join(root, "appdata"),
    PATH: path.join(root, "empty-bin"),
  });
  cleanups.push(() => backend.closeAsync());
  const request = (method: string, params: Record<string, unknown>) =>
    backend.handleAsync({ jsonrpc: "2.0", id: 1, method, params });
  expect((await request(BACKEND_INITIALIZE, { dataDir })).error).toBeUndefined();

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const settled = Promise.withResolvers<void>();
  const { lstat } = await vi.importActual<typeof filesystem>("node:fs/promises");
  const inspected = vi
    .mocked(filesystem.lstat)
    .mockClear()
    .mockImplementation(async (...args) => {
      if (String(args[0]) === first) {
        entered.resolve();
        await release.promise;
      }
      return lstat(...args);
    });
  const listed = vi.mocked(filesystem.readdir).mockClear();
  const children = WorkspaceStorageOwner.prototype.children;
  vi.spyOn(WorkspaceStorageOwner.prototype, "children").mockImplementation(async function (
    this: WorkspaceStorageOwner,
    ...args
  ) {
    try {
      return await children.apply(this, args);
    } finally {
      settled.resolve();
    }
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  try {
    const reply = request(RUNTIME_METHODS.storageChildren, {
      workspaceId: "workspace",
      relativePath: "",
    });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(reply).resolves.toMatchObject({
      error: { data: { detail: "deadline-exceeded" } },
    });
  } finally {
    release.resolve();
  }
  await settled.promise;
  const underWorkspace = (file: unknown) =>
    String(file) === workspace || String(file).startsWith(workspace + path.sep);
  expect(inspected.mock.calls.map(([file]) => file).filter(underWorkspace)).toEqual([
    workspace,
    first,
  ]);
  expect(listed.mock.calls.map(([file]) => file).filter(underWorkspace)).toEqual([workspace]);
});
