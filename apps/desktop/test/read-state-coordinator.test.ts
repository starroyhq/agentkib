// @vitest-environment node
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationReadStates } from "../../../packages/backend/src/conversation-read-state";
import { CodexAppServerSession } from "../../../packages/backend/src/codex-app-server";
import { BackendStore } from "../../../packages/backend/src/store";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { Commands } from "../../../packages/backend/src/commands";
import { saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import type { ConversationReadState } from "@agentkib/runtime-protocol";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const terminal = (id: string) =>
  [
    { type: "event_msg", payload: { type: "task_started", turn_id: id } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: id } },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n") + "\n";
function fixture(native = true) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-read-coordinator-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"),
    workspace = path.join(root, "project"),
    bin = path.join(root, "bin");
  for (const directory of [home, workspace, bin, path.join(home, "sessions")])
    mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(bin, "codex"), "offline", { mode: 0o700 });
  const nativeId = randomUUID(),
    file = path.join(home, "sessions", `${nativeId}.jsonl`);
  writeFileSync(
    file,
    JSON.stringify({
      type: "session_meta",
      payload: { id: nativeId, cwd: workspace, source: "cli" },
    }) +
      "\n" +
      terminal("old"),
  );
  const nativeDb = new DatabaseSync(path.join(home, "state_5.sqlite"));
  cleanups.push(() => nativeDb.close());
  nativeDb.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT,title TEXT,source TEXT,archived INTEGER)",
  );
  nativeDb
    .prepare("INSERT INTO threads VALUES(?,?,?,?,?,?)")
    .run(nativeId, file, workspace, "Fixture", "cli", 0);
  const environment = { HOME: root, CODEX_HOME: home, PATH: bin };
  const store = new BackendStore(path.join(root, "backend.db"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "workspace",
    workspace,
    "Fixture",
    "healthy",
    "2026-10-01T00:00:00Z",
  );
  store.sessions.sync(
    "workspace",
    "codex",
    new CodexSessions(environment).list(workspace).sessions.map((source) => source.session),
  );
  const alias = store.sessions.id("codex", nativeId);
  saveManagedRecord(root, {
    id: "managed",
    workspace_id: "workspace",
    workspace,
    home,
    native_id: nativeId,
    title: "Fixture",
    created_at: "2026-10-01T00:00:00Z",
    released: false,
    adopted: true,
  });
  const commands = new Commands();
  cleanups.push(() => commands.close());
  const sessions = new SessionReaders(store.sessions, commands, environment, {
    profiles: () => [],
  } as unknown as CursorBridge);
  cleanups.push(() => sessions.close());
  let supported = native,
    revision = "one",
    firstUnread: unknown = { type: "turn", turnId: "old" };
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "thread/read")
      return {
        thread: { id: nativeId, cwd: workspace },
        readState: supported ? { revision, firstUnread } : null,
      };
    if (method === "thread/turns/list") return { data: [{ id: "old", status: "completed" }] };
    if (method === "thread/readState/update") {
      expect(params.expectedRevision).toBe(revision);
      revision = "read";
      firstUnread = null;
      return { readState: { revision, firstUnread } };
    }
    if (method === "thread/list")
      return {
        data: [{ id: nativeId }],
        readStates: { [nativeId]: { revision, firstUnread } },
        nextCursor: null,
      };
    throw new Error("unexpected native mutation");
  });
  vi.spyOn(CodexAppServerSession, "start").mockImplementation(
    async () =>
      Object.assign(new EventEmitter(), {
        request,
        close: async () => undefined,
      }) as unknown as CodexAppServerSession,
  );
  const changed = vi.fn();
  const makeOwner = () => {
    const owner = new ConversationReadStates(
      store,
      sessions,
      root,
      environment,
      () => null,
      changed,
      () => false,
    );
    cleanups.push(() => owner.close());
    return owner;
  };
  return {
    root,
    home,
    file,
    nativeId,
    alias,
    makeOwner,
    request,
    sessions,
    changed,
    manualUnread: () => {
      revision = "manually-unread";
      firstUnread = { type: "threadStart" };
    },
    unsupported: () => {
      supported = false;
    },
  };
}

describe("conversation read-state coordination", () => {
  it("normalizes unavailable source resolution without leaking native paths or writing receipts", async () => {
    const f = fixture(),
      owner = f.makeOwner();
    vi.spyOn(f.sessions, "resolve").mockRejectedValue(
      new Error("ENOENT: private native directory"),
    );
    await expect(Promise.all([owner.get(f.alias, "a"), owner.get(f.alias, "a")])).rejects.toThrow(
      /^read-state-unavailable$/,
    );
    await expect(owner.update(f.alias, "a", "old-version", null)).rejects.toThrow(
      /^read-state-unavailable$/,
    );
    expect(f.request).not.toHaveBeenCalled();
  });

  it("retains native manual unread in account catalogs when an observer discovers a downgrade", async () => {
    const f = fixture(),
      owner = f.makeOwner();
    f.manualUnread();
    await owner.get(f.alias, "account:a");
    await owner.close();
    f.unsupported();
    const fallback = f.makeOwner();
    await fallback.get(f.alias, "observer");
    const rows = [
      { id: f.alias, agent: "codex", readState: undefined as ConversationReadState | undefined },
    ];
    expect(fallback.project(rows, "account:a")[0].readState).toMatchObject({
      source: "agentkib",
      status: "unread",
      freshness: "stale",
      firstUnread: { type: "threadStart" },
    });
    const shown = await fallback.get(f.alias, "account:a");
    await fallback.update(f.alias, "account:a", shown.version!, shown.latestResult!.id);
    expect(fallback.project(rows, "account:a")[0].readState?.status).toBe("read");
  });
  it("uses verified managed/index aliases and account scope for the same authoritative native receipt", async () => {
    const f = fixture(),
      owner = f.makeOwner();
    const indexed = await owner.get(f.alias, "account:a"),
      managed = await owner.get("managed", "account:a");
    expect(indexed.version).toBe(managed.version);
    expect((await owner.get("managed", "account:b")).version).not.toBe(managed.version);
    expect(
      (await owner.update("managed", "account:a", indexed.version!, indexed.latestResult!.id))
        .status,
    ).toBe("read");
    expect((await owner.get(f.alias, "account:a")).status).toBe("read");
    expect(
      f.request.mock.calls.some(([method]) => /resume|thread\/start|turn\/start/.test(method)),
    ).toBe(false);
  });

  it("persists fallback baseline and reader cursors across owner restarts and aliases", async () => {
    const f = fixture(false),
      owner = f.makeOwner();
    expect(await owner.get(f.alias, "a")).toMatchObject({ source: "agentkib", status: "read" });
    appendFileSync(f.file, terminal("new"));
    const unread = await owner.get("managed", "a");
    expect(unread).toMatchObject({ status: "unread", latestResult: { id: "turn:new" } });
    await owner.update("managed", "a", unread.version!, "turn:new");
    await owner.close();
    const restarted = f.makeOwner();
    expect(await restarted.get(f.alias, "a")).toMatchObject({ source: "agentkib", status: "read" });
    expect(await restarted.get(f.alias, "b")).toMatchObject({
      source: "agentkib",
      status: "unread",
    });
  });

  it("retains verified native unread across process restart into an older unsupported service", async () => {
    const f = fixture(),
      owner = f.makeOwner();
    expect((await owner.get(f.alias, "a")).status).toBe("unread");
    await owner.close();
    f.unsupported();
    const fallback = f.makeOwner(),
      current = await fallback.get("managed", "a");
    expect(current).toMatchObject({
      source: "agentkib",
      status: "unread",
      latestResult: { id: "turn:old" },
    });
    await fallback.update("managed", "a", current.version!, "turn:old");
    await fallback.close();
    expect((await f.makeOwner().get(f.alias, "a")).status).toBe("read");
  });

  it("observes unopened catalog entries on the five second scheduler and invalidates the shared catalog", async () => {
    const f = fixture();
    vi.useFakeTimers();
    const owner = f.makeOwner();
    expect(
      owner.project(
        [
          {
            id: f.alias,
            agent: "codex",
            readState: undefined as ConversationReadState | undefined,
          },
        ],
        "a",
      )[0].readState?.status,
    ).toBe("unknown");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(
      owner.project(
        [
          {
            id: f.alias,
            agent: "codex",
            readState: undefined as ConversationReadState | undefined,
          },
        ],
        "a",
      )[0].readState?.status,
    ).toBe("unread");
    expect(f.changed).toHaveBeenCalled();
  });
});
