import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { Commands } from "../../../packages/backend/src/commands";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import {
  listManagedRecords,
  readManagedCatalogSnapshot,
  readManagedRecord,
  replayManagedCommand,
} from "../../../packages/backend/src/managed-ledger";
import {
  managedCatalogAliases,
  projectPairedManagedSessions,
  readManagedCatalog,
  type ManagedCatalogRecord,
} from "../../../packages/backend/src/managed-session-catalog";
import { RemoteAgent } from "../../../packages/backend/src/remote-agent";
import type { RemoteTlsRequestHandler } from "../../../packages/backend/src/remote-tls";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";
import { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import { CodexFollowerBridge } from "../../../packages/backend/src/codex-follower-bridge";
import { CodexRuntimePreflight } from "../../../packages/backend/src/codex-runtime-preflight";

const remote = vi.hoisted(() => ({ serve: undefined as RemoteTlsRequestHandler | undefined }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  networkInterfaces: () => ({
    synthetic: [{ address: "192.168.50.10", family: "IPv4", internal: false }],
  }),
}));
vi.mock("bonjour-service", () => ({
  default: class {
    find() {
      return { on() {}, start() {}, stop() {}, update() {} };
    }
    publish() {
      return { stop() {}, on() {} };
    }
    destroy() {}
  },
}));
vi.mock("../../../packages/backend/src/remote-tls", async (original) => ({
  ...(await original<typeof import("../../../packages/backend/src/remote-tls")>()),
  loadRemoteTlsIdentity: () => ({ id: "synthetic-host" }),
  listenRemoteAgent: async (
    _identity: unknown,
    address: string,
    serve: RemoteTlsRequestHandler,
  ) => {
    remote.serve = serve;
    return { address, async close() {}, disconnectPeer() {} };
  },
}));

type Catalog = {
  complete?: boolean;
  incompleteSources?: Array<{ workspaceId: string; agent: string }>;
  codexRuntimeReason?: "codex-cli-version-too-old" | null;
  sessions: Array<
    ReturnType<BackendStore["sessions"]["list"]>[number] & {
      indexedSessionIds?: string[];
      executionMode?: string;
      continuation?: { status: string; reason?: string };
    }
  >;
  workspaces: Array<{ id: string }>;
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  remote.serve = undefined;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-managed-catalog-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    workspace = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(workspace);
  const store = new BackendStore(path.join(root, "agentkib.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Project",
    "healthy",
    "2026-10-06T00:00:00Z",
  );
  const nativeDatabase = new DatabaseSync(path.join(home, "state_1.sqlite"));
  cleanups.push(() => nativeDatabase.close());
  nativeDatabase.exec(
    "CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,thread_source TEXT,forked_from_id TEXT)",
  );
  const commands = new Commands();
  const run = vi.spyOn(commands, "run").mockRejectedValue(new Error("unexpected-native-command"));
  cleanups.push(() => commands.close());
  const environment = { CODEX_HOME: home, HOME: root, USERPROFILE: root, PATH: "" };
  const readers = new SessionReaders(store.sessions, commands, environment, {} as CursorBridge);
  cleanups.push(() => readers.close());
  const index = new SessionIndex(store.sessions, readers, () => true);
  cleanups.push(() => index.close());
  const web = new WebReadRequests(
    store,
    readers,
    root,
    () => index.generation(),
    environment,
    undefined,
    undefined,
    index,
  );
  cleanups.push(() => web.close());
  const owner: ManagedCatalogRecord = {
    id: "private-managed-owner",
    workspace_id: "workspace",
    workspace,
    home,
    native_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    title: "Private owner title",
    created_at: "2026-10-06T00:00:00Z",
    released: false,
    adopted: false,
    archived: false,
    source_session_id: "private-parent",
    snapshot: { revision: 0, private: "private-snapshot" },
  };
  const ledgerPath = path.join(root, "codex-managed", "executions.sqlite");
  function addNative(native: string, source = "exec", fork: string | null = null) {
    const file = path.join(home, `${native}.jsonl`);
    writeFileSync(
      file,
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: native,
          cwd: workspace,
          source,
          thread_source: "user",
        },
      }) + "\n",
    );
    nativeDatabase
      .prepare(
        "INSERT INTO threads(id,rollout_path,cwd,title,source,thread_source,forked_from_id) VALUES(?,?,?,?,?,?,?)",
      )
      .run(native, file, workspace, `Native ${source}`, source, "user", fork);
    return file;
  }
  function sync() {
    store.sessions.sync(
      "workspace",
      "codex",
      new CodexSessions(environment).list(workspace).sessions.map((source) => source.session),
    );
  }
  function saveOwners(records: ManagedCatalogRecord[]) {
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const database = new DatabaseSync(ledgerPath);
    try {
      database.exec(
        "CREATE TABLE IF NOT EXISTS managed_sessions(id TEXT PRIMARY KEY,record TEXT NOT NULL); BEGIN;",
      );
      const statement = database.prepare(
        "INSERT INTO managed_sessions VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      );
      for (const record of records) statement.run(record.id, JSON.stringify(record));
      database.exec("COMMIT");
    } finally {
      database.close();
    }
  }
  function inactiveOwners(count: number) {
    return Array.from({ length: count }, (_, index) => ({
      ...owner,
      id: `inactive-${index}`,
      native_id: null,
      released: true,
      adopted: true,
    }));
  }
  async function localCatalog() {
    return (await web.request({ operation: "catalog" })) as Catalog;
  }
  async function pairedCatalog() {
    return projectPairedManagedSessions(store, readers, root, store.sessions.list("workspace"));
  }
  async function startRemote() {
    mkdirSync(path.join(root, "remote"));
    writeFileSync(
      path.join(root, "remote", "devices.json"),
      JSON.stringify({
        name: "Synthetic host",
        enabled: false,
        address: null,
        connections: {},
        authorized: {
          "synthetic-peer": {
            id: "synthetic-peer",
            name: "Peer",
            approved_at: 1,
            last_seen: null,
            grant_id: "grant",
          },
        },
      }),
    );
    const agent = new RemoteAgent(root, store, readers, index);
    cleanups.push(() => agent.close());
    await agent.request({
      operation: "configure",
      enabled: true,
      address: "192.168.50.10:42987",
      name: "Synthetic host",
    });
    return async () =>
      (await remote.serve!(
        "synthetic-peer",
        "verification",
        { op: "catalog" },
        new AbortController().signal,
      )) as Catalog;
  }
  return {
    root,
    home,
    workspace,
    store,
    readers,
    index,
    web,
    owner,
    ledgerPath,
    nativeDatabase,
    addNative,
    sync,
    saveOwners,
    inactiveOwners,
    localCatalog,
    pairedCatalog,
    startRemote,
    run,
  };
}

describe("managed directory ownership", () => {
  it("reads one indexed Codex history page without building the workspace catalog", async () => {
    const f = fixture();
    const file = f.addNative(f.owner.native_id!, "vscode");
    appendFileSync(
      file,
      JSON.stringify({
        type: "event_msg",
        payload: { type: "agent_message", message: "Indexed answer" },
      }) + "\n",
    );
    f.sync();
    const list = vi.spyOn(f.store.sessions, "list");
    const input = {
      operation: "events",
      sessionId: f.store.sessions.id("codex", f.owner.native_id!),
    };
    await expect(f.web.indexedCodexEvents(input)).resolves.toMatchObject({
      handled: true,
      page: { events: [expect.objectContaining({ content: "Indexed answer" })] },
    });
    expect(list).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();

    f.saveOwners([f.owner]);
    expect((await f.localCatalog()).sessions.map((item) => item.id)).toEqual([f.owner.id]);
    await expect(f.web.indexedCodexEvents(input)).resolves.toEqual({ handled: false });
  });

  it.each(["classification", "disabled", "workspace"])(
    "does not serve a page after its %s changes",
    async (kind) => {
      const f = fixture();
      f.addNative(f.owner.native_id!, "vscode");
      f.sync();
      const sessionId = f.store.sessions.id("codex", f.owner.native_id!);
      const read = vi.spyOn(f.readers, "events").mockImplementationOnce(async () => {
        if (kind === "disabled")
          writeFileSync(
            path.join(f.root, "preferences.json"),
            JSON.stringify({ session_index_enabled: false }),
          );
        else if (kind === "classification")
          f.store.sql.run(
            "INSERT INTO schema_meta(key,value) VALUES(?,?)",
            `codex_session_classification_stale:${sessionId}`,
            "workspace",
          );
        else f.store.sql.run("DELETE FROM workspaces WHERE id='workspace'");
        return { events: [], next_cursor: null, warnings: [] };
      });
      const input = { operation: "events", sessionId };
      await expect(f.web.indexedCodexEvents(input)).rejects.toThrow("session-unavailable");
      await expect(f.web.indexedCodexEvents(input)).resolves.toEqual({ handled: false });
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it.each(
    (["projectless", "unclassified"] as const).flatMap((collection) =>
      [true, false].map((persisted) => [collection, persisted] as const),
    ),
  )(
    "proves native %s collection aliases after restart without using titles (cwd persisted: %s)",
    async (collection, persisted) => {
      const f = fixture();
      const cwd =
        collection === "unclassified"
          ? path.join(f.root, "Documents", "Codex", "project")
          : f.workspace;
      mkdirSync(cwd, { recursive: true });
      if (collection === "unclassified")
        f.store.sql.run("UPDATE workspaces SET canonical_path=? WHERE id='workspace'", f.root);
      const file = f.addNative(f.owner.native_id!);
      const header = JSON.parse(readFileSync(file, "utf8"));
      header.payload.cwd = cwd;
      writeFileSync(file, JSON.stringify(header) + "\n");
      f.nativeDatabase.prepare("UPDATE threads SET cwd=? WHERE id=?").run(cwd, f.owner.native_id!);
      if (collection === "projectless")
        writeFileSync(
          path.join(f.home, ".codex-global-state.json"),
          JSON.stringify({ "projectless-thread-ids": [f.owner.native_id!] }),
        );
      const workspaceId = `session-collection:codex:${collection}`;
      f.store.sessions.sync(
        workspaceId,
        "codex",
        (await f.readers.list("codex", workspaceId)).sessions,
      );
      f.saveOwners([
        {
          ...f.owner,
          workspace: collection === "unclassified" ? f.root : f.workspace,
          ...(persisted ? { cwd } : {}),
          title: "Different display title",
        },
      ]);
      expect(
        (await f.localCatalog()).sessions.find((record) => record.id === f.owner.id)
          ?.indexedSessionIds,
      ).toEqual([f.store.sessions.id("codex", f.owner.native_id!)]);
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("uses verified native activity time without inventing activity when a catalog is read", async () => {
    const f = fixture();
    f.nativeDatabase.exec("ALTER TABLE threads ADD COLUMN updated_at_ms INTEGER");
    f.addNative(f.owner.native_id!);
    const timestamp = Date.parse("2026-10-20T00:00:00Z");
    f.nativeDatabase.prepare("UPDATE threads SET updated_at_ms=?").run(timestamp);
    f.sync();
    f.saveOwners([f.owner]);
    expect((await f.localCatalog()).sessions.find((row) => row.id === f.owner.id)?.updated_at).toBe(
      "2026-10-20T00:00:00Z",
    );
    f.nativeDatabase.prepare("UPDATE threads SET updated_at_ms=?").run(timestamp + 60_000);
    expect((await f.localCatalog()).sessions.find((row) => row.id === f.owner.id)?.updated_at).toBe(
      "2026-10-20T00:01:00Z",
    );
    expect((await f.localCatalog()).sessions.find((row) => row.id === f.owner.id)?.updated_at).toBe(
      "2026-10-20T00:01:00Z",
    );
    const file = path.join(f.home, `${f.owner.native_id!}.jsonl`);
    const header = JSON.parse(readFileSync(file, "utf8"));
    header.payload.id = "11111111-2222-4333-8444-555555555555";
    writeFileSync(file, JSON.stringify(header) + "\n");
    expect((await f.localCatalog()).sessions.find((row) => row.id === f.owner.id)?.updated_at).toBe(
      f.owner.created_at,
    );
  });

  it("shares one version probe across catalog rows and refreshes a known older version", async () => {
    const f = fixture();
    const check = vi
      .spyOn(CodexRuntimePreflight.prototype, "check")
      .mockResolvedValue({ reason: "codex-cli-version-too-old" });
    f.addNative(f.owner.native_id!, "cli");
    f.addNative("11111111-2222-4333-8444-555555555555", "cli");
    f.sync();
    const first = await f.localCatalog();
    expect(check).toHaveBeenCalledOnce();
    expect(first.codexRuntimeReason).toBeNull();
    const catalog = await f.localCatalog();
    expect(catalog.codexRuntimeReason).toBe("codex-cli-version-too-old");
    expect(
      catalog.sessions.every(
        (row) =>
          row.continuation?.status === "unsupported" &&
          row.continuation.reason === "codex-cli-version-too-old",
      ),
    ).toBe(true);
    check.mockResolvedValue({ reason: null });
    await f.localCatalog();
    expect(
      (await f.localCatalog()).sessions.every(
        (row) => row.continuation?.reason !== "codex-cli-version-too-old",
      ),
    ).toBe(true);
  });

  it("returns persisted sessions while the CLI version probe is still pending", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!, "cli");
    f.sync();
    let finish!: (value: { reason: string | null }) => void;
    const check = vi.spyOn(CodexRuntimePreflight.prototype, "check").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = await f.localCatalog();
    expect(first.sessions).toHaveLength(1);
    expect(first.codexRuntimeReason).toBeNull();
    expect(check).toHaveBeenCalledOnce();
    expect((await f.localCatalog()).sessions).toHaveLength(1);
    expect(check).toHaveBeenCalledOnce();
    finish({ reason: "codex-cli-version-too-old" });
    await Promise.resolve();
    expect((await f.localCatalog()).codexRuntimeReason).toBe("codex-cli-version-too-old");
  });

  it("rejects an invalidated catalog instead of returning a successful empty disabled catalog", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!, "cli");
    f.sync();
    f.saveOwners([f.owner]);
    const list = f.readers.list.bind(f.readers);
    vi.spyOn(f.readers, "list").mockImplementationOnce(async (...args) => {
      const result = await list(...args);
      f.index.invalidate();
      return result;
    });
    await expect(f.localCatalog()).rejects.toThrow("catalog-stale");
    expect((await f.localCatalog()).sessions.some((row) => row.id === f.owner.id)).toBe(true);
    writeFileSync(
      path.join(f.root, "preferences.json"),
      JSON.stringify({ session_index_enabled: false }),
    );
    f.saveOwners([{ ...f.owner, released: true, adopted: true }]);
    expect(await f.localCatalog()).toMatchObject({
      sessions: [],
      workspaces: [],
      indexEnabled: false,
    });
  });

  it("projects only a global old-version reason for raw native collections without exposing their sessions", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!, "cli");
    writeFileSync(
      path.join(f.home, ".codex-global-state.json"),
      JSON.stringify({ "projectless-thread-ids": [f.owner.native_id!] }),
    );
    const collection = "session-collection:codex:projectless";
    f.store.sessions.sync(
      collection,
      "codex",
      (await f.readers.list("codex", collection)).sessions,
    );
    const check = vi
      .spyOn(CodexRuntimePreflight.prototype, "check")
      .mockResolvedValue({ reason: "codex-cli-version-too-old" });
    expect(await f.localCatalog()).toMatchObject({ sessions: [], codexRuntimeReason: null });
    expect(check).toHaveBeenCalledOnce();
    expect(await f.localCatalog()).toMatchObject({
      sessions: [],
      codexRuntimeReason: "codex-cli-version-too-old",
    });
    check.mockResolvedValue({ reason: "codex-cli-version-unavailable" });
    await f.localCatalog();
    expect(await f.localCatalog()).toMatchObject({ sessions: [], codexRuntimeReason: null });
  });

  it.each([false, true])(
    "refreshes inactive managed native history without a server (compressed: %s)",
    async (compressed) => {
      const f = fixture();
      const file = f.addNative(f.owner.native_id!);
      appendFileSync(
        file,
        Array.from({ length: 4 }, (_, index) =>
          JSON.stringify({
            type: "event_msg",
            timestamp: `2026-10-20T00:00:0${index}Z`,
            payload: { type: "agent_message", message: `Terminal answer ${index}` },
          }),
        ).join("\n") + "\n",
      );
      const nativeContent = readFileSync(file);
      if (compressed) {
        writeFileSync(`${file}.zst`, zstdCompressSync(nativeContent));
        rmSync(file);
      }
      f.saveOwners([f.owner]);
      const start = vi.spyOn(CodexAppServerSession, "start");
      const follower = vi.spyOn(CodexFollowerBridge, "connect");
      const page = await f.web.request({ operation: "events", sessionId: f.owner.id, limit: 2 });
      expect(page.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Terminal answer 3" })]),
      );
      expect(page.next_cursor).toBeTruthy();
      expect(
        (
          await f.web.request({
            operation: "events",
            sessionId: f.owner.id,
            limit: 2,
            cursor: page.next_cursor,
          })
        ).events,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Terminal answer 0" })]),
      );
      const addition =
        JSON.stringify({
          type: "event_msg",
          payload: { type: "agent_message", message: "Newest terminal answer" },
        }) + "\n";
      if (compressed)
        writeFileSync(
          `${file}.zst`,
          zstdCompressSync(Buffer.concat([nativeContent, Buffer.from(addition)])),
        );
      else appendFileSync(file, addition);
      expect(
        (await f.web.request({ operation: "events", sessionId: f.owner.id, limit: 2 })).events,
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Newest terminal answer" })]),
      );
      await expect(
        f.web.request({ operation: "events", sessionId: f.owner.id, limit: 2, cursor: "42" }),
      ).rejects.toThrow("TRANSCRIPT_CURSOR_STALE");
      expect(start).not.toHaveBeenCalled();
      expect(follower).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it.each(["identity", "home", "cwd", "missing-directory"])(
    "does not read inactive native contents when %s is not verified",
    async (kind) => {
      const f = fixture();
      const file = f.addNative(f.owner.native_id!);
      const record = { ...f.owner, cwd: f.workspace };
      if (kind === "home") record.home = f.workspace;
      else {
        const header = JSON.parse(readFileSync(file, "utf8"));
        if (kind === "identity") header.payload.id = "11111111-2222-4333-8444-555555555555";
        else header.payload.cwd = kind === "cwd" ? f.home : path.join(f.workspace, "removed");
        writeFileSync(file, JSON.stringify(header) + "\n");
      }
      f.saveOwners([record]);
      const read = vi.spyOn(f.readers, "eventsForNative");
      await expect(
        f.web.request({ operation: "events", sessionId: f.owner.id, limit: 2 }),
      ).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it("matches a verified execution subdirectory while preserving its registered workspace owner", async () => {
    const f = fixture();
    const cwd = path.join(f.workspace, "subproject");
    mkdirSync(cwd);
    const file = f.addNative(f.owner.native_id!);
    const header = JSON.parse(readFileSync(file, "utf8"));
    header.payload.cwd = cwd;
    writeFileSync(file, JSON.stringify(header) + "\n");
    f.nativeDatabase.prepare("UPDATE threads SET cwd=? WHERE id=?").run(cwd, f.owner.native_id!);
    f.sync();
    f.saveOwners([{ ...f.owner, cwd }]);
    expect(
      (await f.localCatalog()).sessions.find((record) => record.id === f.owner.id)
        ?.indexedSessionIds,
    ).toHaveLength(1);
    expect((await f.pairedCatalog())[0].origin).toBe("interactive");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("does not assign a persisted usage generation to the current backend without an observer", async () => {
    const f = fixture();
    f.saveOwners([
      {
        ...f.owner,
        snapshot: {
          ...f.owner.snapshot,
          runtimeBootId: "previous-backend",
          usage: {
            available: true,
            state: "ready",
            usedTokens: 80,
            contextWindow: 100,
            reportGeneration: Number.MAX_SAFE_INTEGER,
            reportId: 500,
          },
        },
      },
    ]);
    const live = (await f.web.request({ operation: "live", sessionId: f.owner.id })) as {
      runtimeBootId: string;
      usage: unknown;
    };
    expect(live.runtimeBootId).not.toBe("previous-backend");
    expect(live.usage).toMatchObject({ state: "stale", usedTokens: 80, reportId: 500 });
    expect(live.usage).not.toHaveProperty("reportGeneration");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("retains verified managed/native aliases, ordinary forks and unknown sources without granting paired controls", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!);
    f.addNative(f.owner.native_id!.toUpperCase());
    const fork = "11111111-2222-4333-8444-555555555555";
    f.addNative(fork, "cli", f.owner.native_id!);
    f.addNative("22222222-3333-4444-8555-666666666666", "subagent");
    f.addNative("33333333-4444-4555-8666-777777777777", "mcp");
    f.addNative("44444444-5555-4666-8777-888888888888");
    f.sync();
    f.saveOwners([f.owner]);
    const local = await f.localCatalog();
    const managed = local.sessions.find((record) => record.id === f.owner.id)!;
    expect(managed.origin).toBe("interactive");
    expect(managed.indexedSessionIds).toHaveLength(2);
    expect(
      local.sessions.filter((record) => managed.indexedSessionIds!.includes(record.id)),
    ).toEqual([]);
    const paired = await f.pairedCatalog();
    const aliases = new Set(managed.indexedSessionIds);
    expect(paired.filter((record) => aliases.has(record.id))).toHaveLength(1);
    expect(paired.find((record) => aliases.has(record.id))?.origin).toBe("interactive");
    expect(
      paired.find((record) => record.id === f.store.sessions.id("codex", fork))
        ?.forked_from_session_id,
    ).toBe(f.store.sessions.id("codex", f.owner.native_id!));
    expect(paired.filter((record) => record.origin === "execution")).toHaveLength(1);
    expect(paired.filter((record) => record.origin === "auxiliary")).toHaveLength(1);
    const encoded = JSON.stringify(paired);
    for (const privateField of [
      f.owner.id,
      f.owner.title,
      "private-parent",
      "private-snapshot",
      "executionMode",
      "indexedSessionIds",
    ])
      expect(encoded).not.toContain(privateField);
    expect(
      f.store.sessions
        .list("workspace")
        .filter((record) => aliases.has(record.id))
        .every((record) => record.origin === "execution"),
    ).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each(["registered", "unregistered"])(
    "rejects global ownership conflicts including a %s workspace",
    async (where) => {
      const f = fixture();
      f.addNative(f.owner.native_id!);
      f.sync();
      const other = path.join(f.root, "other");
      mkdirSync(other);
      if (where === "registered")
        f.store.sql.run(
          "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
          "other",
          other,
          "Other",
          "healthy",
          f.owner.created_at,
        );
      f.saveOwners([
        f.owner,
        {
          ...f.owner,
          id: "conflict",
          workspace_id: "other",
          workspace: other,
          native_id: f.owner.native_id!.toUpperCase(),
        },
      ]);
      expect(
        (await f.localCatalog()).sessions.find((record) => record.id === f.owner.id)
          ?.indexedSessionIds,
      ).toEqual([]);
      expect((await f.pairedCatalog())[0].origin).toBe("execution");
    },
  );

  it.each([true, false])(
    "proves unique ownership at 20,000 records (owner first: %s)",
    async (first) => {
      const f = fixture();
      f.addNative(f.owner.native_id!);
      f.sync();
      const inactive = f.inactiveOwners(19_999);
      f.saveOwners(first ? [f.owner, ...inactive] : [...inactive, f.owner]);
      expect(readManagedCatalogSnapshot(f.root).complete).toBe(true);
      expect(
        (await f.localCatalog()).sessions.find((record) => record.id === f.owner.id)
          ?.indexedSessionIds,
      ).toHaveLength(1);
      expect((await f.pairedCatalog())[0].origin).toBe("interactive");
    },
  );

  it.each(["owner-first", "owner-last", "conflict-outside-limit", "conflict-inside-limit"])(
    "does not grant truncated ownership at 20,001 records: %s",
    async (caseName) => {
      const f = fixture();
      f.addNative(f.owner.native_id!);
      f.addNative(f.owner.native_id!.toUpperCase());
      f.sync();
      const conflict = { ...f.owner, id: "conflict", released: true };
      const hasConflict = caseName.startsWith("conflict");
      const inactive = f.inactiveOwners(20_001 - (hasConflict ? 2 : 1));
      const records =
        caseName === "owner-first"
          ? [f.owner, ...inactive]
          : caseName === "conflict-outside-limit"
            ? [conflict, ...inactive, f.owner]
            : caseName === "conflict-inside-limit"
              ? [...inactive, conflict, f.owner]
              : [...inactive, f.owner];
      f.saveOwners(records);
      const snapshot = readManagedCatalogSnapshot(f.root);
      expect(snapshot.complete).toBe(false);
      expect(snapshot.records).toHaveLength(20_000);
      const local = await f.localCatalog();
      expect(local.complete).toBe(false);
      expect(local.incompleteSources).toBeUndefined();
      expect(
        local.sessions
          .filter((record) => record.executionMode === "codex-managed")
          .map((record) => record.id)
          .sort(),
      ).toEqual(
        snapshot.records
          .filter((record) => !record.released || !record.adopted)
          .map((record) => record.id)
          .sort(),
      );
      expect(
        local.sessions
          .filter((record) => record.executionMode === "codex-managed")
          .every((record) => record.indexedSessionIds?.length === 0),
      ).toBe(true);
      expect((await f.pairedCatalog()).map((record) => record.origin)).toEqual([
        "execution",
        "execution",
      ]);
      expect(listManagedRecords(f.root)).toHaveLength(20_000);
    },
  );

  it.each(["missing", "directory", "symlink", ...(process.platform === "win32" ? [] : ["fifo"])])(
    "skips a %s transcript without opening native commands",
    async (kind) => {
      const f = fixture();
      const file = f.addNative(f.owner.native_id!);
      const ordinary = "11111111-2222-4333-8444-555555555555";
      f.addNative(ordinary, "cli");
      f.sync();
      f.saveOwners([f.owner]);
      if (kind === "symlink") {
        const target = `${file}.regular`;
        renameSync(file, target);
        symlinkSync(target, file);
      } else {
        rmSync(file);
        if (kind === "directory") mkdirSync(file);
        if (kind === "fifo") execFileSync("mkfifo", [file]);
      }
      expect(
        (await f.localCatalog()).sessions.find((record) => record.id === f.owner.id)
          ?.indexedSessionIds,
      ).toEqual([]);
      const paired = await f.pairedCatalog();
      expect(
        paired.find((record) => record.id === f.store.sessions.id("codex", f.owner.native_id!))
          ?.origin,
      ).toBe("execution");
      expect(
        paired.find((record) => record.id === f.store.sessions.id("codex", ordinary))?.origin,
      ).toBe("interactive");
      expect(f.run).not.toHaveBeenCalled();
    },
  );

  it("keeps auxiliary sessions hidden from managed display exceptions", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!, "subagent");
    f.sync();
    f.saveOwners([f.owner]);
    expect(
      (await f.localCatalog()).sessions.find((record) => record.id === f.owner.id)
        ?.indexedSessionIds,
    ).toEqual([]);
    expect((await f.pairedCatalog())[0].origin).toBe("auxiliary");
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([
    "missing-home",
    "wrong-home",
    "wrong-workspace",
    "wrong-header",
    "released-adopted",
    "released-created",
  ])("requires live identity for aliases: %s", async (kind) => {
    const f = fixture();
    const file = f.addNative(f.owner.native_id!);
    f.sync();
    const owner = { ...f.owner };
    if (kind === "wrong-home") owner.home = f.workspace;
    if (kind === "wrong-workspace") owner.workspace = f.home;
    if (kind === "released-adopted") {
      owner.released = true;
      owner.adopted = true;
    }
    if (kind === "released-created") owner.released = true;
    if (kind === "wrong-header") {
      const header = JSON.parse(readFileSync(file, "utf8"));
      header.payload.cwd = f.home;
      writeFileSync(file, JSON.stringify(header) + "\n");
    }
    f.saveOwners([owner]);
    if (kind === "missing-home") renameSync(f.home, `${f.home}.removed`);
    const expected = kind === "released-created" ? "interactive" : "execution";
    expect((await f.pairedCatalog())[0].origin).toBe(expected);
    if (kind === "missing-home")
      expect((await f.localCatalog()).sessions.some((record) => record.id === owner.id)).toBe(true);
  });

  it("does not create, migrate or chmod the directory ledger", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!);
    f.sync();
    expect((await f.localCatalog()).sessions[0].origin).toBe("execution");
    expect(existsSync(path.dirname(f.ledgerPath))).toBe(false);
    f.saveOwners([f.owner]);
    chmodSync(path.dirname(f.ledgerPath), 0o750);
    chmodSync(f.ledgerPath, 0o640);
    const bytes = readFileSync(f.ledgerPath),
      files = readdirSync(path.dirname(f.ledgerPath));
    const modes = [statSync(path.dirname(f.ledgerPath)).mode, statSync(f.ledgerPath).mode];
    expect(
      (await f.localCatalog()).sessions.find((record) => record.id === f.owner.id)
        ?.indexedSessionIds,
    ).toHaveLength(1);
    expect((await f.pairedCatalog())[0].origin).toBe("interactive");
    expect(readFileSync(f.ledgerPath)).toEqual(bytes);
    expect(readdirSync(path.dirname(f.ledgerPath))).toEqual(files);
    expect([statSync(path.dirname(f.ledgerPath)).mode, statSync(f.ledgerPath).mode]).toEqual(modes);
    const database = new DatabaseSync(f.ledgerPath, { readOnly: true });
    try {
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get()
          ?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  it("reads pending classifications through SessionIndex for both directories", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!, "cli");
    f.sync();
    const read = vi.spyOn(f.index, "read");
    await f.localCatalog();
    expect(read).toHaveBeenCalledWith("workspace");
    read.mockClear();
    const catalog = await f.startRemote();
    await catalog();
    expect(read).toHaveBeenCalledWith("workspace");
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe("paired optional ownership failures", () => {
  it.each(["missing-table", "corrupt-database", "corrupt-json", "locked"])(
    "retains ordinary native catalog after %s and keeps strict control errors",
    async (kind) => {
      const f = fixture();
      f.addNative(f.owner.native_id!);
      f.addNative("11111111-2222-4333-8444-555555555555", "cli");
      f.sync();
      mkdirSync(path.dirname(f.ledgerPath));
      let locked: DatabaseSync | undefined;
      if (kind === "corrupt-database")
        writeFileSync(f.ledgerPath, "corrupt private ledger /secret/path");
      else {
        const database = new DatabaseSync(f.ledgerPath);
        if (kind !== "missing-table") {
          database.exec("CREATE TABLE managed_sessions(id TEXT PRIMARY KEY,record TEXT NOT NULL)");
          database
            .prepare("INSERT INTO managed_sessions VALUES(?,?)")
            .run(f.owner.id, kind === "corrupt-json" ? "{secret-invalid" : JSON.stringify(f.owner));
        }
        database.close();
        if (kind === "locked") {
          locked = new DatabaseSync(f.ledgerPath);
          locked.exec("BEGIN EXCLUSIVE");
          cleanups.push(() => {
            locked!.exec("ROLLBACK");
            locked!.close();
          });
        }
      }
      const bytes = readFileSync(f.ledgerPath);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const serve = await f.startRemote();
      const result = await serve();
      expect(result.sessions.map((record) => record.origin).sort()).toEqual([
        "execution",
        "interactive",
      ]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Managed session catalog projection unavailable",
      );
      expect(readFileSync(f.ledgerPath)).toEqual(bytes);
      // The optional display failure must not loosen the existing control reads.
      await expect(f.web.request({ operation: "usage", sessionId: f.owner.id })).rejects.toThrow();
      if (kind === "corrupt-database" || kind === "corrupt-json") {
        expect(() => listManagedRecords(f.root)).toThrow();
        expect(() => readManagedRecord(f.root, f.owner.id)).toThrow();
      }
      if (kind === "corrupt-database")
        expect(() => replayManagedCommand(f.root, "request", "fingerprint")).toThrow();
      expect(f.run).not.toHaveBeenCalled();
    },
    15_000,
  );

  it("does not change indexed sessions when native identity verification fails after reading owners", async () => {
    const f = fixture();
    f.addNative(f.owner.native_id!);
    f.sync();
    f.saveOwners([f.owner]);
    const indexed = f.store.sessions.list("workspace");
    vi.spyOn(CodexSessions.prototype, "verifiedIndexedIdentities").mockImplementation(() => {
      throw new Error("private native path must not be logged");
    });
    await expect(
      managedCatalogAliases(f.store, f.readers, readManagedCatalog(f.root)),
    ).rejects.toThrow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const serve = await f.startRemote();
    expect((await serve()).sessions).toEqual(indexed);
    expect(warn).toHaveBeenCalledExactlyOnceWith("Managed session catalog projection unavailable");
    expect(f.store.sessions.list("workspace")).toEqual(indexed);
  });
});
