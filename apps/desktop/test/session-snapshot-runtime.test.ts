import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { TypeScriptBackend } from "../../../packages/backend/src/index";
import { BACKEND_INITIALIZE } from "../../../packages/backend/src/migration";
import { ClaudeManagedReadOwner } from "../../../packages/backend/src/claude-managed-read";
import { McpHub } from "../../../packages/backend/src/mcp-hub";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(managed = true, agent: "claude-code" | "codex" = "claude-code") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "session-snapshot-runtime-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, "data");
  const config = path.join(root, ".claude");
  const bin = path.join(root, "bin");
  for (const directory of [data, config, bin]) mkdirSync(directory);
  writeFileSync(
    path.join(data, "preferences.json"),
    JSON.stringify({ session_content_search_enabled: false }),
  );
  if (!managed) {
    const store = new BackendStore(path.join(data, "agentkib.db"));
    try {
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        "workspace",
        root,
        "Synthetic",
        "healthy",
        "2026-10-20T00:00:00Z",
      );
      store.sql.run(
        "INSERT INTO conversation_sessions(id,workspace_id,agent,archived,sidechain,availability,origin,last_indexed_at) VALUES(?,?,?,?,?,?,?,?)",
        "session",
        "workspace",
        agent,
        0,
        0,
        "readable",
        "interactive",
        "2026-10-20T00:00:00Z",
      );
    } finally {
      store.close();
    }
  }
  vi.spyOn(McpHub.prototype, "start").mockResolvedValue();
  vi.spyOn(RemoteAgent.prototype, "start").mockResolvedValue();
  vi.spyOn(ClaudeManagedReadOwner.prototype, "hasManagedSession").mockReturnValue(managed);
  let version = "initial";
  let status = "idle";
  let unavailable = false;
  const versionRead = vi
    .spyOn(
      agent === "codex" ? WebReadRequests.prototype : ClaudeManagedReadOwner.prototype,
      agent === "codex" ? "indexedCodexHistoryVersion" : "historyVersion",
    )
    .mockImplementation(async () => {
      if (unavailable) throw new Error("session-unavailable");
      return version;
    });
  const provider = vi
    .spyOn(
      agent === "codex" ? WebReadRequests.prototype : ClaudeManagedReadOwner.prototype,
      "request",
    )
    .mockImplementation(async (params) => {
      params = params as Record<string, unknown>;
      if (params.operation === "subagents") return { subagents: [] };
      if (params.operation === "live") return { sessionId: params.sessionId, status, revision: 1 };
      if (params.operation === "events")
        return {
          events: [{ id: "message", content: version }],
          warnings: [],
          next_cursor: "history-v1-private-cursor",
        };
      throw new Error("Unexpected observation operation");
    });
  const backend = new TypeScriptBackend({ HOME: root, CLAUDE_CONFIG_DIR: config, PATH: bin });
  cleanups.push(() => backend.closeAsync());
  const request = async (method: string, params: Record<string, unknown>) => {
    const result = await backend.handleAsync({ jsonrpc: "2.0", id: 1, method, params });
    if (result.error) throw new Error(JSON.stringify(result.error));
    return result.result as Record<string, any>;
  };
  await request(BACKEND_INITIALIZE, { dataDir: data });
  const subscribe = () => request(RUNTIME_METHODS.sessionsSubscribe, { sessionId: "session" });
  return {
    root,
    data,
    backend,
    request,
    subscribe,
    provider,
    versionRead,
    change: (next: string) => {
      version = next;
    },
    running: () => {
      status = "running";
    },
    unavailable: () => {
      unavailable = true;
    },
  };
}

describe("runtime Claude snapshot history reuse", () => {
  it("reads live state afresh while reusing only unchanged stream history", async () => {
    const f = await fixture();
    const first = await f.subscribe();
    f.running();
    const second = await f.subscribe();
    expect(second.events[0].payload.live.status).toBe("running");
    expect(second.events[0].payload.items).toEqual([{ id: "message", content: "initial" }]);
    expect(second.events[0].payload).not.toHaveProperty("next_cursor");
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "live")).toHaveLength(2);
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      1,
    );
    f.change("appended");
    const third = await f.subscribe();
    expect(third.events[0].payload.items).toEqual([{ id: "message", content: "appended" }]);
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      2,
    );
    expect(first.subscriptionId).not.toBe(second.subscriptionId);
  });

  it("keeps direct history reads independent of the stream cache and rejects lost identity", async () => {
    const f = await fixture();
    await f.subscribe();
    const page = await f.request(RUNTIME_METHODS.webRequest, {
      operation: "events",
      sessionId: "session",
      limit: 50,
    });
    expect(page.next_cursor).toBe("history-v1-private-cursor");
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      2,
    );
    f.unavailable();
    await expect(f.subscribe()).rejects.toThrow("session-unavailable");
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      2,
    );
  });

  it("does not reuse history after the index is disabled", async () => {
    const f = await fixture(false);
    await f.subscribe();
    writeFileSync(
      path.join(f.data, "preferences.json"),
      JSON.stringify({ session_index_enabled: false, session_content_search_enabled: false }),
    );
    await expect(f.subscribe()).rejects.toThrow("session-unavailable");
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      1,
    );
  });

  it.each(["disable", "clear"] as const)(
    "rejects a cached snapshot when index %s happens during its identity check",
    async (operation) => {
      const f = await fixture(false);
      await f.subscribe();
      let release!: (value: string) => void;
      let checking!: () => void;
      const started = new Promise<void>((resolve) => {
        checking = resolve;
      });
      f.versionRead.mockImplementationOnce(() => {
        checking();
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      });
      const pending = f.subscribe();
      await started;
      if (operation === "disable")
        await f.request(RUNTIME_METHODS.setSessionIndexEnabled, { enabled: false });
      else await f.request(RUNTIME_METHODS.clearSessionIndex, {});
      release("initial");
      await expect(pending).rejects.toThrow("session-unavailable");
      expect(
        f.provider.mock.calls.filter(([params]) => params.operation === "events"),
      ).toHaveLength(1);
    },
  );

  it("keeps actively created managed sessions observable when native indexing is disabled", async () => {
    const f = await fixture();
    await f.subscribe();
    await f.request(RUNTIME_METHODS.setSessionIndexEnabled, { enabled: false });
    const result = await f.subscribe();
    expect(result.events[0].payload.items).toEqual([{ id: "message", content: "initial" }]);
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      2,
    );
  });
});

describe("runtime indexed Codex snapshot history reuse", () => {
  it("rechecks live state and file identity without rereading unchanged history", async () => {
    const f = await fixture(false, "codex");
    await f.subscribe();
    f.running();
    const second = await f.subscribe();
    expect(second.events[0].payload.live.status).toBe("running");
    expect(second.events[0].payload.items).toEqual([{ id: "message", content: "initial" }]);
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "live")).toHaveLength(2);
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      1,
    );
    expect(f.versionRead).toHaveBeenCalledTimes(3);
    f.change("appended");
    const third = await f.subscribe();
    expect(third.events[0].payload.items).toEqual([{ id: "message", content: "appended" }]);
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      2,
    );
    expect(f.provider).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "events", retainCursor: false }),
    );
  });

  it("rejects a removed source before returning its cached history", async () => {
    const f = await fixture(false, "codex");
    await f.subscribe();
    f.unavailable();
    await expect(f.subscribe()).rejects.toThrow("session-unavailable");
    expect(f.provider.mock.calls.filter(([params]) => params.operation === "events")).toHaveLength(
      1,
    );
  });
});
