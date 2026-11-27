// @vitest-environment node
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationReadStates } from "../../../packages/backend/src/conversation-read-state";
import { claudeReadStateProvider } from "../../../packages/backend/src/agents/claude/read-state-provider";
import { CodexAppServerSession } from "../../../packages/backend/src/agents/codex/codex-app-server";
import { BackendStore } from "../../../packages/backend/src/store";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { CodexSessions } from "../../../packages/backend/src/agents/codex/codex-sessions";
import { Commands } from "../../../packages/backend/src/commands";
import { saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import { conversationReadKey } from "../../../packages/backend/src/read-state-ledger";
import type { CursorBridge } from "../../../packages/backend/src/cursor-bridge";
import type { ConversationReadState } from "@agentkib/runtime-protocol";
import { WebAccessService } from "../electron/main/web/service";

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
    updates = 0,
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
      const type = (params.operation as { type: unknown }).type;
      expect(["read", "unread"]).toContain(type);
      revision = `update:${++updates}`;
      firstUnread = type === "unread" ? { type: "threadStart" } : null;
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
        connected: true,
        request,
        close: async () => undefined,
      }) as unknown as CodexAppServerSession,
  );
  const changed = vi.fn();
  const makeOwner = (
    claudeTarget: ConstructorParameters<typeof ConversationReadStates>[4] = () => null,
  ) => {
    const owner = new ConversationReadStates(
      store,
      sessions,
      root,
      environment,
      claudeTarget,
      changed,
      () => false,
    );
    cleanups.push(() => owner.close());
    return owner;
  };
  return {
    root,
    home,
    workspace,
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

const bridgeChanges = [
  "unchanged",
  "reply rewritten",
  "parent detached",
  "proof temporarily unavailable",
  "proof lost before acknowledgement",
] as const;
async function verifyBridgeAcknowledgement(change: (typeof bridgeChanges)[number]) {
  const f = fixture();
  const sessionId = randomUUID();
  const user = randomUUID();
  const reply = randomUUID();
  const bridgeTurn = randomUUID();
  const transcript = path.join(f.root, "claude.jsonl");
  const target = {
    provider: "claude-code" as const,
    home: f.home,
    nativeId: sessionId,
    workspace: f.workspace,
    transcript,
  };
  const start = "2026-11-27T08:56:00.615Z";
  const bridgeResult = {
    id: `turn:${bridgeTurn}`,
    turnId: bridgeTurn,
    itemId: null,
    outcome: "ended" as const,
    completedAt: "2026-11-27T08:56:03.743Z",
  };
  const select = (id: string) => (id === sessionId ? target : null);
  const first = f.makeOwner(select);
  first.recordTerminal(target, bridgeResult, { turnStartedAt: start });
  writeFileSync(
    transcript,
    [
      {
        type: "user",
        uuid: user,
        sessionId,
        timestamp: start,
        isMeta: true,
        origin: { kind: "plugin", name: "agentkib-bridge" },
        message: {
          role: "user",
          content: [{ type: "text", text: "[AgentKib report] Worker finished." }],
        },
      },
      {
        type: "assistant",
        uuid: reply,
        sessionId,
        parentUuid: user,
        timestamp: "2026-11-27T08:56:02.000Z",
        message: { role: "assistant", content: "Answer" },
      },
      {
        type: "system",
        subtype: "turn_duration",
        sessionId,
        parentUuid: reply,
        timestamp: "2026-11-27T08:56:03.742Z",
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  utimesSync(transcript, new Date(start), new Date(start));
  // Reproduce an existing ledger that has already seen the complete native record.
  await first.get(sessionId, "local");
  await first.close();

  const owner = f.makeOwner(select);
  const service = new WebAccessService({
    dataDir: path.join(f.root, "desktop"),
    staticDir: f.root,
    account: {
      signedIn: () => true,
      accountId: () => "fixture",
      ensureDeviceOwner: async () => undefined,
      registerDevice: async () => ({}),
    },
    workspaceRequest: async () => [{ id: "workspace", name: "Fixture", path: f.workspace }],
    sessionRequest: async ({ host: { request } }) => {
      if (request.operation === "catalog")
        return {
          workspaces: [{ id: "workspace" }],
          sessions: [{ id: sessionId, workspace_id: "workspace", agent: "claude-code" }],
        };
      expect(request.readerScope).toBe("account:fixture");
      return {
        readState:
          request.operation === "read-state"
            ? await owner.get(sessionId, "account:fixture")
            : await owner.update(
                sessionId,
                "account:fixture",
                String(request.expectedVersion),
                String(request.seenResultId),
                request.mark === "read" || request.mark === "unread" ? request.mark : undefined,
              ),
      };
    },
  });
  cleanups.push(() => service.shutdown());
  await service.initialize();
  const key = conversationReadKey(target.provider, target.home, target.nativeId);
  const db = new DatabaseSync(path.join(f.root, "codex-managed", "executions.sqlite"), {
    readOnly: true,
  });
  cleanups.push(() => db.close());
  const cursors = () =>
    db
      .prepare("SELECT reader_scope, read_sequence FROM conversation_read_cursors WHERE key=?")
      .all(key);
  const get = async () => {
    const response = await service.localRequest(`/read-state?sessionId=${sessionId}`);
    expect(response.status).toBe(200);
    return (response.body as { readState: ConversationReadState }).readState;
  };
  expect(cursors()).toEqual([]);
  const state = await get();
  expect(state).toMatchObject({
    status: "unread",
    canAcknowledge: true,
    latestResult: { ...bridgeResult, itemId: reply },
  });
  expect(await get()).toMatchObject({ version: state.version });
  const post = {
    sessionId,
    expectedVersion: state.version,
    seenResultId: state.latestResult!.id,
  };
  if (change === "proof temporarily unavailable") {
    const postReceipt = vi.fn((request: typeof post) =>
      service.localRequest("/read-state", request),
    );
    const attemptedResults = new Set<string>();
    const acknowledge = async ({
      status,
      freshness,
      version,
      latestResult,
    }: ConversationReadState) => {
      // Model the existing Web and mobile version gate and the mobile result-level attempt guard.
      if (status !== "unread" || freshness !== "current" || !version || !latestResult) return;
      if (attemptedResults.has(latestResult.id)) return;
      attemptedResults.add(latestResult.id);
      return postReceipt({ sessionId, expectedVersion: version, seenResultId: latestResult.id });
    };
    const verify = vi
      .spyOn(claudeReadStateProvider, "verifyTranscriptResult")
      .mockResolvedValue(undefined);
    const pending = await get();
    expect(pending).toMatchObject({
      status: "unread",
      freshness: "current",
      version: null,
      latestResult: { id: bridgeResult.id },
    });
    await acknowledge(pending);
    expect(postReceipt).not.toHaveBeenCalled();
    expect(cursors()).toEqual([]);
    verify.mockRestore();

    const recovered = await get();
    expect(recovered).toMatchObject({
      status: "unread",
      version: expect.any(String),
      latestResult: { id: pending.latestResult!.id, itemId: reply },
    });
    expect(await get()).toMatchObject({ version: recovered.version });
    expect(await acknowledge(recovered)).toMatchObject({
      status: 200,
      body: { readState: { status: "read" } },
    });
    await acknowledge(recovered);
    expect(postReceipt).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      expectedVersion: recovered.version,
      seenResultId: bridgeResult.id,
    });
  } else if (change === "proof lost before acknowledgement") {
    const verify = vi
      .spyOn(claudeReadStateProvider, "verifyTranscriptResult")
      .mockResolvedValue(undefined);
    try {
      const manualVersion = owner.ledger.get(key, "account:fixture").version;
      const pending = await get();
      expect(pending).toMatchObject({
        status: "unread",
        version: null,
        manualVersion,
        canAcknowledge: false,
      });
      expect(await service.localRequest("/read-state", post)).toMatchObject({
        status: 409,
        body: { error: "read_state_conflict" },
      });
      const manual = { ...post, expectedVersion: pending.manualVersion };
      expect(await service.localRequest("/read-state", manual)).toMatchObject({
        status: 409,
        body: { error: "read_state_conflict" },
      });
      expect(cursors()).toEqual([]);
      expect(await service.localRequest("/read-state", { ...manual, mark: "read" })).toMatchObject({
        status: 200,
        body: { readState: { status: "read" } },
      });
    } finally {
      verify.mockRestore();
    }
  } else if (change !== "unchanged") {
    const ledgerVersion = owner.ledger.get(key, "account:fixture").version;
    const before = statSync(transcript);
    const original = readFileSync(transcript, "utf8");
    const rewritten =
      change === "reply rewritten"
        ? original.replace('"content":"Answer"', '"content":"Edited"')
        : original.replace(`"parentUuid":"${user}"`, `"parentUuid":"${randomUUID()}"`);
    expect(rewritten).not.toBe(original);
    writeFileSync(transcript, rewritten);
    const rewrittenAt = new Date("2026-11-27T08:57:00Z");
    utimesSync(transcript, rewrittenAt, rewrittenAt);
    expect(statSync(transcript)).toMatchObject({ ino: before.ino, size: before.size });

    expect(await service.localRequest("/read-state", post)).toMatchObject({
      status: 409,
      body: { error: "read_state_conflict" },
    });
    expect(cursors()).toEqual([]);
    expect(owner.ledger.get(key, "account:fixture").version).toBe(ledgerVersion);
    const refreshed = await service.localRequest(`/read-state?sessionId=${sessionId}`);
    const refreshedState = (refreshed.body as { readState: ConversationReadState }).readState;
    expect(refreshedState).toMatchObject({
      status: "unread",
      latestResult: { id: bridgeResult.id, itemId: change === "reply rewritten" ? reply : null },
    });
    expect(refreshedState.version).not.toBe(state.version);

    // Explicit marks use the captured ledger revision even if the native proof changed.
    expect(await service.localRequest("/read-state", { ...post, mark: "read" })).toMatchObject({
      status: 200,
      body: { readState: { status: "read" } },
    });
  } else {
    expect(await service.localRequest("/read-state", post)).toMatchObject({
      status: 200,
      body: { readState: { status: "read" } },
    });
  }
  expect(cursors()).toEqual([
    { reader_scope: "account:fixture", read_sequence: expect.any(Number) },
  ]);
  expect(await owner.get(sessionId, "local")).toMatchObject({ status: "unread" });
}

it.each(bridgeChanges)(
  "checks signed-in account acknowledgements for a legacy bridge report after restart (%s)",
  verifyBridgeAcknowledgement,
);

describe("conversation read-state coordination", () => {
  it("does not broadcast unchanged polling cycles but still detects native manual unread", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const f = fixture(),
      owner = f.makeOwner();
    await owner.get(f.alias, "a");
    f.changed.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.request.mock.calls.some(([method]) => method === "thread/list")).toBe(true);
    expect(f.changed).not.toHaveBeenCalled();
    f.manualUnread();
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.changed).toHaveBeenCalled();
    expect(await owner.get(f.alias, "a")).toMatchObject({
      status: "unread",
      source: "codex-native",
      firstUnread: { type: "threadStart" },
    });
  });

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

  it.each([true, false])(
    "marks read and unread across aliases with native receipts %s",
    async (native) => {
      const f = fixture(native),
        owner = f.makeOwner();
      const first = await owner.get(f.alias, "account:a");
      const seen = first.latestResult!.id;
      const read = await owner.update(f.alias, "account:a", first.version!, seen, "read");
      expect(read).toMatchObject({ status: "read", firstUnread: null });
      const manual = await owner.update("managed", "account:a", read.version!, seen, "unread");
      expect(manual).toMatchObject({
        source: native ? "codex-native" : "agentkib",
        status: "unread",
        firstUnread: { type: "threadStart" },
      });
      expect(await owner.get(f.alias, "account:a")).toEqual(manual);
      await expect(
        owner.update(f.alias, "account:b", manual.version!, seen, "read"),
      ).rejects.toThrow("read-state-conflict");
      expect(await owner.update(f.alias, "account:a", manual.version!, seen)).toMatchObject({
        status: "read",
        firstUnread: null,
      });
      expect(
        f.request.mock.calls
          .filter(([method]) => method === "thread/readState/update")
          .map(([, params]) => params.operation),
      ).toEqual(native ? [{ type: "read" }, { type: "unread" }, { type: "read" }] : []);
    },
  );

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
