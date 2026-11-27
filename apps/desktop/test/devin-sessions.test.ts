// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_METHODS, type SessionSubscription } from "@agentkib/runtime-protocol";
import {
  DevinSessions,
  type DevinSearchRecord,
} from "../../../packages/backend/src/agents/devin/devin-sessions";
import { sources } from "../../../packages/backend/src/context-sources";
import { Commands } from "../../../packages/backend/src/commands";
import { ConversationReadStates } from "../../../packages/backend/src/conversation-read-state";
import { discoverConfiguredWorkspaces } from "../../../packages/backend/src/native-discovery-configured";
import { NativeHistoryWork } from "../../../packages/backend/src/native-history-work";
import { conversationReadKey } from "../../../packages/backend/src/read-state-ledger";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { AUTO_CONTINUE_TEXT } from "../../../packages/backend/src/usage-limit";
import { startBackend } from "./session-baseline/harness";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
// A 1×1 PNG.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function temp(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-devin-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface Message {
  node: number;
  parent: number | null;
  role: string;
  content?: string;
  input?: boolean;
  id?: string;
  calls?: { id: string; name: string; arguments: string }[];
  result?: string;
  phase?: string;
  thinking?: boolean;
  images?: { mime_type: string; base64_data: string }[];
  summarizedFrom?: number;
  generationModel?: string;
  contextInputTokens?: number;
}

/** The parts of Devin CLI's `sessions.db` schema (refinery v20) that AgentKib reads. */
function database(file: string, compat = "0") {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
      backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT,
      main_chain_id INTEGER, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
    CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
      created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));
    CREATE TABLE tool_call_state (session_id TEXT NOT NULL, tool_call_id TEXT NOT NULL,
      tool_call_json TEXT, tool_call_update_json TEXT, source_node_ids TEXT,
      PRIMARY KEY (session_id, tool_call_id));
    CREATE TABLE app_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`);
  db.prepare("INSERT INTO app_state VALUES ('schema_compat_version', ?)").run(compat);
  return {
    session(id: string, cwd: string, head: number | null, hidden = 0, updated = 1_794_400_000) {
      db.prepare(
        "INSERT INTO sessions VALUES (?,?,'windsurf','swe-1-6','normal',?,?,?,?,'[]',?,'{}')",
      ).run(id, cwd, updated - 600, updated, `Title of ${id}`, head, hidden);
    },
    head(id: string, node: number) {
      db.prepare("UPDATE sessions SET main_chain_id=? WHERE id=?").run(node, id);
    },
    message(session: string, value: Message) {
      db.prepare("INSERT INTO message_nodes VALUES (NULL,?,?,?,?,?,?)").run(
        session,
        value.node,
        value.parent,
        JSON.stringify({
          message_id: value.id ?? `msg-${value.node}`,
          role: value.role,
          content: value.content ?? "",
          ...(value.calls ? { tool_calls: value.calls } : {}),
          ...(value.result ? { tool_call_id: value.result } : {}),
          ...(value.phase ? { phase: value.phase } : {}),
          ...(value.thinking ? { thinking: { thinking: "private reasoning" } } : {}),
          ...(value.images ? { images: value.images } : {}),
          metadata: {
            ...(value.input !== undefined ? { is_user_input: value.input } : {}),
            ...(value.generationModel ? { generation_model: value.generationModel } : {}),
            ...(value.contextInputTokens !== undefined
              ? { metrics: { context_input_tokens: value.contextInputTokens } }
              : {}),
            created_at: new Date(Date.UTC(2026, 10, 12, 0, 0, value.node)).toISOString(),
          },
        }),
        1_794_400_000 + value.node,
        value.summarizedFrom === undefined
          ? null
          : JSON.stringify({ summarized_from: value.summarizedFrom }),
      );
    },
    tool(session: string, id: string, call: unknown, update: unknown) {
      db.prepare("INSERT INTO tool_call_state VALUES (?,?,?,?,NULL)").run(
        session,
        id,
        JSON.stringify(call),
        JSON.stringify(update),
      );
    },
    close: () => db.close(),
  };
}

/** One compaction: the main chain restarts from the system prompt with a summary of nodes 1–7. */
function fixture(compat = "0") {
  const home = temp();
  const project = path.join(home, "project");
  mkdirSync(path.join(project, "src"), { recursive: true });
  const other = path.join(home, "other");
  mkdirSync(other);
  const file = path.join(home, ".local/share/devin/cli/sessions.db");
  const db = database(file, compat);
  const id = "brisk-otter";
  db.session(id, project, 11);
  db.session("quiet-hidden", project, null, 1);
  db.session("far-away", other, null);
  const messages: Message[] = [
    { node: 0, parent: null, role: "system", content: "system prompt" },
    {
      node: 1,
      parent: 0,
      role: "user",
      input: true,
      id: "m1",
      content: "Fix the bug",
      images: [{ mime_type: "image/png", base64_data: PNG }],
    },
    {
      node: 2,
      parent: 1,
      role: "assistant",
      id: "m2",
      content: "Looking",
      thinking: true,
      calls: [{ id: "call-1", name: "exec", arguments: '{"command":"git status"}' }],
    },
    { node: 3, parent: 2, role: "tool", result: "call-1", content: "On branch main" },
    { node: 4, parent: 3, role: "assistant", id: "m3", content: "Done with the first part" },
    { node: 5, parent: 4, role: "user", input: true, id: "m4", content: "Now refactor" },
    { node: 6, parent: 5, role: "user", content: "injected context" },
    {
      node: 7,
      parent: 6,
      role: "assistant",
      id: "m5",
      content: "Refactoring",
      calls: [{ id: "call-2", name: "edit", arguments: '{"file_path":"src/a.ts"}' }],
    },
    { node: 8, parent: 7, role: "tool", result: "call-2", content: "Edited" },
    {
      node: 9,
      parent: 0,
      role: "system",
      content: "Summary of the earlier work",
      summarizedFrom: 8,
    },
    {
      node: 10,
      parent: 9,
      role: "assistant",
      id: "m6",
      content: "Continuing the refactor",
      calls: [{ id: "call-3", name: "read", arguments: '{"file_path":"README.md"}' }],
    },
    { node: 11, parent: 10, role: "tool", result: "call-3", content: "# Readme" },
    // A copy Devin made on another root (after a model switch, say) is never shown.
    { node: 20, parent: null, role: "system", content: "other system prompt" },
    { node: 21, parent: 20, role: "user", input: true, id: "m1", content: "Fix the bug" },
  ];
  for (const message of messages) db.message(id, message);
  db.message(id, {
    node: 12,
    parent: 11,
    role: "assistant",
    id: "m7",
    content: "All done",
    phase: "final_answer",
  });
  db.tool(
    id,
    "call-1",
    {
      toolCallId: "call-1",
      title: "Ran git",
      kind: "execute",
      rawInput: { command: "git status" },
    },
    {
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "On branch main" } }],
    },
  );
  db.tool(
    id,
    "call-2",
    {
      toolCallId: "call-2",
      title: "Edited file",
      kind: "edit",
      locations: [{ path: path.join(project, "src/a.ts") }],
      content: [
        { type: "diff", path: path.join(project, "src/a.ts"), oldText: "a\n", newText: "b\n" },
      ],
    },
    { toolCallId: "call-2", status: "completed" },
  );
  db.tool(
    id,
    "call-3",
    {
      toolCallId: "call-3",
      title: "Read file",
      kind: "read",
      locations: [{ path: path.join(project, "README.md") }],
    },
    { toolCallId: "call-3", status: "completed" },
  );
  db.close();
  // Head 12 follows the final answer appended after node 11.
  const update = new DatabaseSync(file);
  update.prepare("UPDATE sessions SET main_chain_id=12 WHERE id=?").run(id);
  update.close();
  return { home, project, file, id, readers: new DevinSessions({ HOME: home }) };
}

describe("Devin context input reports", () => {
  it("reads the latest matching generation on the active main chain", () => {
    const home = temp();
    const project = path.join(home, "project");
    const db = database(path.join(home, ".local/share/devin/cli/sessions.db"));
    const model = "swe-1-6";
    const buildReport = (node: number, parent: number | null, tokens: number): Message => ({
      node,
      parent,
      role: "assistant",
      generationModel: model,
      contextInputTokens: tokens,
    });
    try {
      db.session("active", project, 5);
      db.message("active", buildReport(1, null, 1900));
      db.message("active", buildReport(2, 1, 2100));
      db.message("active", { node: 3, parent: 2, role: "tool" });
      db.message("active", buildReport(4, 1, 9900));
      db.message("active", { node: 5, parent: 3, role: "user", input: false });
      db.session("hidden", project, 1, 1);
      db.message("hidden", buildReport(1, null, 1900));
    } finally {
      db.close();
    }
    const reader = new DevinSessions({ HOME: home });
    expect(reader.lastContextInput("active", project, model)).toEqual({
      usedTokens: 2100,
      updatedAt: "2026-11-12T00:00:02Z",
    });
    expect(reader.lastContextInput("active", project, "different-model")).toBeUndefined();
    expect(reader.lastContextInput("active", path.join(home, "other"), model)).toBeUndefined();
    expect(reader.lastContextInput("hidden", project, model)).toBeUndefined();
  });

  it("does not cross a compaction, new user input or unreported generation", () => {
    const home = temp();
    const project = path.join(home, "project");
    const db = database(path.join(home, ".local/share/devin/cli/sessions.db"));
    const model = "swe-1-6";
    const barriers: Record<string, Message> = {
      compacted: { node: 2, parent: 1, role: "system", summarizedFrom: 1 },
      pending: { node: 2, parent: 1, role: "user", input: true },
      unknown: { node: 2, parent: 1, role: "user" },
      unreported: { node: 2, parent: 1, role: "assistant", generationModel: model },
      switched: {
        node: 2,
        parent: 1,
        role: "assistant",
        generationModel: "different-model",
        contextInputTokens: 3500,
      },
    };
    try {
      for (const [id, barrier] of Object.entries(barriers)) {
        db.session(id, project, 2);
        db.message(id, {
          node: 1,
          parent: null,
          role: "assistant",
          generationModel: model,
          contextInputTokens: 1900,
        });
        db.message(id, barrier);
      }
    } finally {
      db.close();
    }
    const reader = new DevinSessions({ HOME: home });
    for (const id of Object.keys(barriers))
      expect(reader.lastContextInput(id, project, model)).toBeUndefined();
  });
});

describe("Devin sessions", () => {
  function readStateFixture() {
    const home = temp();
    const project = path.join(home, "project");
    const environment = { HOME: home, DEVIN_SESSIONS_DIR: path.join(home, "devin") };
    const devinHome = path.join(environment.DEVIN_SESSIONS_DIR, "cli");
    mkdirSync(project);
    const nativeId = "patient-otter";
    const db = database(path.join(devinHome, "sessions.db"));
    cleanup.push(() => db.close());
    db.session(nativeId, project, 2);
    db.message(nativeId, {
      node: 1,
      parent: null,
      role: "user",
      input: true,
      content: "Old task",
    });
    db.message(nativeId, { node: 2, parent: 1, role: "assistant", content: "Old answer" });

    const store = new BackendStore(path.join(home, "backend.db"));
    cleanup.push(() => store.close());
    store.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "workspace",
      project,
      "Fixture",
      "healthy",
      "2026-11-12T00:00:00Z",
    );
    store.sessions.sync(
      "workspace",
      "devin",
      new DevinSessions(environment).list(project).sessions,
    );
    const sessionId = store.sessions.id("devin", nativeId);
    const commands = new Commands();
    const owners: ConversationReadStates[] = [];
    const open = () => {
      const readers = new SessionReaders(store.sessions, commands, environment, {
        profiles: () => [],
      });
      cleanup.push(() => readers.close());
      const owner = new ConversationReadStates(
        store,
        readers,
        home,
        environment,
        () => null,
        () => undefined,
        () => false,
      );
      owners.push(owner);
      return owner;
    };
    const key = conversationReadKey("devin", devinHome, nativeId);
    const account = "account:fixture";
    const target = { provider: "devin" as const, nativeId, workspace: project, home: devinHome };
    const close = async () => {
      await Promise.all(owners.map((owner) => owner.close()));
      await commands.close();
    };
    return { account, close, db, home, key, nativeId, open, sessionId, target };
  }

  async function verifyDelayedReply(text: string, turnId: string) {
    const { account, close, db, home, key, nativeId, open, sessionId, target } = readStateFixture();
    const result = {
      id: "turn:acp-completion",
      turnId: "devin-msg-1",
      itemId: "devin-msg-2",
      outcome: "completed" as const,
      completedAt: "2026-11-12T00:00:07.000Z",
    };
    const unproven = { ...result, turnId: null, itemId: null };
    try {
      const first = open();
      first.recordTerminal(target, result, {
        turnStartedAt: "2026-11-12T00:00:03.500Z",
      });
      const ledger = new DatabaseSync(path.join(home, "codex-managed", "executions.sqlite"), {
        readOnly: true,
      });
      cleanup.push(() => ledger.close());
      const before = await first.get(sessionId, account);
      expect(before).toMatchObject({ status: "unread", latestResult: unproven });
      await expect(first.update(sessionId, account, before.version!, result.id)).rejects.toThrow(
        "read-state-unavailable",
      );
      const manualScope = "account:manual-fixture";
      const manuallyUnread = await first.get(sessionId, manualScope);
      await expect(
        first.update(sessionId, manualScope, manuallyUnread.version!, result.id, "read"),
      ).resolves.toMatchObject({ status: "read", latestResult: unproven });
      const original = ledger
        .prepare("SELECT sequence FROM conversation_read_results WHERE key=? AND result_id=?")
        .get(key, result.id) as { sequence: number };
      await first.close();

      db.message(nativeId, {
        node: 4,
        parent: 2,
        role: "assistant",
        content: "Late reply to the old task",
      });
      db.head(nativeId, 4);
      const restarted = open();
      expect(await restarted.get(sessionId, account)).toMatchObject({ latestResult: unproven });

      db.message(nativeId, { node: 5, parent: 2, role: "user", input: true, content: text });
      db.head(nativeId, 5);
      expect(await restarted.get(sessionId, account)).toMatchObject({ latestResult: unproven });

      db.message(nativeId, {
        node: 8,
        parent: 5,
        role: "user",
        input: true,
        content: "Later task",
      });
      db.message(nativeId, { node: 9, parent: 8, role: "assistant", content: "Later answer" });
      db.head(nativeId, 9);
      expect(await restarted.get(sessionId, account)).toMatchObject({ latestResult: unproven });

      db.message(nativeId, {
        node: 6,
        parent: 5,
        role: "assistant",
        content: "The delayed answer",
      });
      db.head(nativeId, 6);
      const anchored = await restarted.get(sessionId, account);
      expect(anchored).toMatchObject({
        status: "unread",
        latestResult: { ...result, turnId, itemId: "devin-msg-6" },
      });
      expect(anchored.version).not.toBe(before.version);
      await expect(
        restarted.update(sessionId, account, before.version!, result.id),
      ).rejects.toThrow("read-state-conflict");
      await expect(
        restarted.update(sessionId, account, anchored.version!, result.id),
      ).resolves.toMatchObject({
        status: "read",
      });
      expect(
        ledger.prepare("SELECT sequence FROM conversation_read_results WHERE key=?").all(key),
      ).toEqual([original]);
      expect(
        ledger
          .prepare(
            "SELECT read_sequence FROM conversation_read_cursors WHERE key=? AND reader_scope=?",
          )
          .get(key, account),
      ).toEqual({ read_sequence: original.sequence });
      expect(await restarted.get(sessionId, "local")).toMatchObject({ status: "unread" });
    } finally {
      await close();
    }
  }

  it("verifies a delayed native reply after the read-state owner restarts", () =>
    verifyDelayedReply("New task", "devin-msg-5"));

  it("verifies an auto-resume reply only with its persisted native prompt", () =>
    verifyDelayedReply(AUTO_CONTINUE_TEXT.devin, "devin-msg-1"));

  it.each(["failed", "cancelled"] as const)(
    "advances the cursor for a %s turn with a unique native input and no reply",
    async (outcome) => {
      const { account, close, db, home, key, nativeId, open, sessionId, target } =
        readStateFixture();
      try {
        const owner = open();
        const result = {
          id: "turn:acp-without-reply",
          // The reply left behind by the preceding turn cannot anchor this result.
          turnId: "devin-msg-1",
          itemId: "devin-msg-2",
          outcome,
          completedAt: "2026-11-12T00:00:07.000Z",
        };
        owner.recordTerminal(target, result, { turnStartedAt: "2026-11-12T00:00:03.500Z" });
        const ledger = new DatabaseSync(path.join(home, "codex-managed", "executions.sqlite"), {
          readOnly: true,
        });
        cleanup.push(() => ledger.close());
        const cursor = () =>
          ledger
            .prepare(
              "SELECT read_sequence FROM conversation_read_cursors WHERE key=? AND reader_scope=?",
            )
            .get(key, account);
        expect(cursor()).toBeUndefined();
        const unproven = await owner.get(sessionId, account);
        expect(unproven).toMatchObject({
          status: "unread",
          latestResult: { ...result, turnId: null, itemId: null },
        });

        db.message(nativeId, {
          node: 5,
          parent: 2,
          role: "user",
          input: true,
          content: "End this task",
        });
        db.message(nativeId, {
          node: 8,
          parent: 5,
          role: "user",
          input: true,
          content: "A later task",
        });
        db.head(nativeId, 8);
        const proven = await owner.get(sessionId, account);
        expect(proven).toMatchObject({
          status: "unread",
          firstUnread: { type: "result", resultId: result.id, turnId: "devin-msg-5" },
          latestResult: { ...result, turnId: "devin-msg-5", itemId: null },
        });
        expect(proven.version).not.toBe(unproven.version);

        db.message(nativeId, {
          node: 6,
          parent: 5,
          role: "user",
          input: true,
          content: "Competing task",
        });
        db.head(nativeId, 6);
        expect(await owner.get(sessionId, account)).toMatchObject({
          status: "unread",
          latestResult: { ...result, turnId: null, itemId: null },
        });
        await expect(owner.update(sessionId, account, proven.version!, result.id)).rejects.toThrow(
          "read-state-conflict",
        );
        expect(cursor()).toBeUndefined();

        db.head(nativeId, 8);
        const fresh = await owner.get(sessionId, account);
        await expect(
          owner.update(sessionId, account, fresh.version!, result.id),
        ).resolves.toMatchObject({
          status: "read",
        });
        const terminal = ledger
          .prepare("SELECT sequence FROM conversation_read_results WHERE key=? AND result_id=?")
          .get(key, result.id) as { sequence: number };
        expect(cursor()).toEqual({ read_sequence: terminal.sequence });
        expect(await owner.get(sessionId, "local")).toMatchObject({ status: "unread" });
      } finally {
        await close();
      }
    },
  );

  it("checks the complete turn interval even when a history page omits a competing reply", () => {
    const home = temp();
    const project = path.join(home, "project");
    const environment = { HOME: home, DEVIN_SESSIONS_DIR: path.join(home, "devin") };
    mkdirSync(project);
    const id = "patient-otter";
    const db = database(path.join(environment.DEVIN_SESSIONS_DIR, "cli", "sessions.db"));
    cleanup.push(() => db.close());
    db.session(id, project, 105);
    db.message(id, { node: 1, parent: null, role: "user", input: true, content: "First task" });
    db.message(id, {
      node: 2,
      parent: 1,
      role: "assistant",
      content: "First answer",
      phase: "final_answer",
    });
    for (let node = 3; node <= 103; node++) {
      db.message(id, {
        node,
        parent: node - 1,
        role: "assistant",
        calls: [{ id: `call-${node}`, name: "Read", arguments: "{}" }],
      });
    }
    db.message(id, { node: 104, parent: 103, role: "user", input: true, content: "Second task" });
    db.message(id, { node: 105, parent: 104, role: "assistant", content: "Second answer" });
    const reader = new DevinSessions(environment);
    const page = reader.events(id, project, null, 100);
    expect(page.next_cursor).not.toBeNull();
    expect(page.warnings).toEqual([]);
    expect(
      page.events.filter((event) => event.kind !== "tool-summary").map((event) => event.id),
    ).toEqual(["devin-msg-104", "devin-msg-105"]);
    const time = (seconds: number) => Date.UTC(2026, 10, 12, 0, 0, seconds);
    expect(reader.readStateReply(id, project, time(1), time(105))).toBeUndefined();
    expect(reader.readStateReply(id, project, time(104), time(105))).toMatchObject({
      turnId: "devin-msg-104",
      itemId: "devin-msg-105",
    });
  });

  it("keeps the receipt stable after another session writes, but detects database replacement", () => {
    const { id, project, file, readers } = fixture();
    const start = Date.UTC(2026, 10, 12, 0, 0, 5);
    const end = Date.UTC(2026, 10, 12, 0, 0, 12);
    const proof = readers.readStateReply(id, project, start, end);
    expect(proof).toMatchObject({ turnId: "devin-m4", itemId: "devin-m7" });
    const db = new DatabaseSync(file);
    try {
      db.prepare("UPDATE sessions SET title=? WHERE id=?").run("Unrelated title", "far-away");
    } finally {
      db.close();
    }
    expect(readers.readStateReply(id, project, start, end)).toEqual(proof);

    const replaced = `${file}.previous`;
    renameSync(file, replaced);
    copyFileSync(replaced, file);
    const current = readers.readStateReply(id, project, start, end);
    expect(current).toMatchObject({ turnId: "devin-m4", itemId: "devin-m7" });
    expect(current?.evidence).not.toBe(proof?.evidence);
  });

  it("lists visible sessions of a workspace without changing the closed database", () => {
    const { project, file, readers, id } = fixture();
    expect(readers.list(project).sessions).toEqual([
      expect.objectContaining({
        native_ref: id,
        agent: "devin",
        title: `Title of ${id}`,
        availability: "readable",
        origin: "interactive",
        cwd: project,
      }),
    ]);
    expect(
      readers
        .list(null)
        .sessions.map((session) => session.native_ref)
        .sort(),
    ).toEqual(["brisk-otter", "far-away"]);
    for (const suffix of ["-wal", "-shm", "-journal"])
      expect(existsSync(file + suffix)).toBe(false);
  });

  it("reads one catalog for 59 workspaces and refreshes it on a WAL commit", () => {
    const { home, project, file, readers, id } = fixture();
    const writer = new DatabaseSync(file);
    cleanup.push(() => writer.close());
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    writer.prepare("UPDATE sessions SET title=? WHERE id=?").run("First WAL snapshot", id);
    expect(statSync(file + "-wal").size).toBeGreaterThan(0);
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    cleanup.push(() => prepare.mockRestore());
    const catalogReads = () =>
      prepare.mock.calls.filter(([sql]) => sql.includes("FROM sessions WHERE hidden=0 ORDER BY"));
    const workspaces = [
      ...Array.from({ length: 57 }, (_, index) => path.join(home, `moved-${index}`)),
      project,
      path.join(home, "other"),
    ];
    const lists = workspaces.map((workspace) => readers.list(workspace));
    expect(lists.every(({ incomplete }) => !incomplete)).toBe(true);
    expect(lists.flatMap(({ sessions }) => sessions.map((session) => session.title))).toEqual([
      "First WAL snapshot",
      "Title of far-away",
    ]);
    expect(catalogReads()).toHaveLength(1);
    const workspaceList = readers.list(project);
    workspaceList.sessions[0]!.title = "caller changes";
    expect(readers.list(project).sessions[0]!.title).toBe("First WAL snapshot");
    writer.prepare("UPDATE sessions SET title=? WHERE id=?").run("Second WAL snapshot", id);
    expect(readers.list(project).sessions[0]!.title).toBe("Second WAL snapshot");
    expect(catalogReads()).toHaveLength(2);
  });

  it("invalidates the catalog when the database is replaced or removed", () => {
    const { project, file, readers, id } = fixture();
    expect(readers.list(project).sessions.map((session) => session.native_ref)).toEqual([id]);
    const replacement = file + ".replacement";
    const db = database(replacement);
    db.session("replacement", project, null);
    db.close();
    renameSync(replacement, file);
    expect(readers.list(project).sessions.map((session) => session.native_ref)).toEqual([
      "replacement",
    ]);
    rmSync(file);
    expect(readers.list(project)).toEqual({ sessions: [], incomplete: false });
  });

  it("checks workspace probe markers even when the cached catalog has not changed", () => {
    const { project, readers, id } = fixture();
    const marker = path.join(project, ".codexbar-session-id");
    expect(readers.list(project).sessions.map((session) => session.native_ref)).toEqual([id]);
    writeFileSync(marker, "");
    expect(readers.list(project).sessions).toEqual([]);
    rmSync(marker);
    expect(readers.list(project).sessions.map((session) => session.native_ref)).toEqual([id]);
  });

  it("lists an empty source on a machine without Devin or a trust file", () => {
    const home = temp();
    const dataHome = path.join(home, "agent-data");
    const readers = new DevinSessions({
      HOME: home,
      XDG_DATA_HOME: dataHome,
      APPDATA: dataHome,
      PATH: path.join(home, "no-cli"),
    });
    expect(readers.list(home)).toEqual({ sessions: [], incomplete: false });
    expect(existsSync(dataHome)).toBe(false);
  });

  it("reports a busy database and reads it again after the writer releases it", () => {
    const { project, file, readers, id } = fixture();
    const writer = new DatabaseSync(file);
    cleanup.push(() => writer.close());
    writer.exec("BEGIN EXCLUSIVE; UPDATE sessions SET title='Uncommitted'");
    expect(existsSync(file + "-journal")).toBe(true);
    expect(readers.list(project)).toEqual({
      sessions: [],
      incomplete: true,
      sourceFailed: true,
      issues: [{ code: "devin-source-busy", scope: "source" }],
    });
    writer.exec("ROLLBACK");
    expect(readers.list(project).sessions[0]!.title).toBe(`Title of ${id}`);
  });

  it("reports unsafe, corrupt, and unsupported stores without exposing paths", () => {
    const home = temp();
    const file = path.join(home, "fake-sessions.db");
    const readers = new DevinSessions({ HOME: home }, file);
    const failures = (code: string) => ({
      sessions: [],
      incomplete: true,
      sourceFailed: true,
      issues: [{ code, scope: "source" }],
    });
    mkdirSync(file);
    expect(readers.list(home)).toEqual(failures("devin-source-unsafe"));
    rmSync(file, { recursive: true });
    writeFileSync(file, "not SQLite");
    expect(readers.list(home)).toEqual(failures("devin-source-corrupt"));
    rmSync(file);
    const wrongSchema = new DatabaseSync(file);
    wrongSchema.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    wrongSchema.close();
    expect(readers.list(home)).toEqual(failures("devin-source-unsupported"));
  });

  it("reports an unreadable Devin database as a configured discovery failure", () => {
    const home = temp();
    const environment = {
      HOME: home,
      APPDATA: path.join(home, "appdata"),
      DEVIN_SESSIONS_DIR: path.join(home, "moved-devin"),
      PATH: path.join(home, "no-cli"),
    };
    const file = new DevinSessions(environment).database();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "not SQLite");
    const discovery = discoverConfiguredWorkspaces(environment);
    expect(discovery.errors).toContain("devin workspace discovery failed: devin-source-corrupt");
    expect(discovery.source_diagnostics).toContainEqual(
      expect.objectContaining({
        agent: "devin",
        source: "sessions-db",
        status: "failed",
        reasons: ["source-read-failed"],
      }),
    );
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a database that the process has no permission to read",
    () => {
      const { project, file, readers } = fixture();
      expect(readers.list(project).sessions).toHaveLength(1);
      chmodSync(file, 0o000);
      expect(readers.list(project)).toEqual({
        sessions: [],
        incomplete: true,
        sourceFailed: true,
        issues: [{ code: "devin-source-denied", scope: "source" }],
      });
    },
  );

  it("titles a session Devin has not titled yet with what the user first typed", () => {
    const { project, file, readers, id } = fixture();
    const update = new DatabaseSync(file);
    update.prepare("UPDATE sessions SET title=? WHERE id=?").run("  ", id);
    update.prepare("UPDATE sessions SET title=NULL WHERE id='far-away'").run();
    update.close();
    // The system prompt and the context Devin injects are not something the user typed.
    expect(readers.list(project).sessions[0]!.title).toBe("Fix the bug");
    // A session without any typed message keeps no title.
    expect(
      readers.list(null).sessions.find((session) => session.native_ref === "far-away")!.title,
    ).toBeNull();
  });

  it("follows compactions into one timeline with answers and tool details", () => {
    const { project, readers, id } = fixture();
    const page = readers.events(id, project, null, 100);
    expect(page.next_cursor).toBeNull();
    expect(page.warnings).toEqual([]);
    expect(page.events.map((event) => [event.id, event.kind, event.message_phase])).toEqual([
      ["devin-m1", "user-message", undefined],
      ["devin-m2", "agent-message", "commentary"],
      ["devin-tool-call-1", "tool-summary", undefined],
      ["devin-m3", "agent-message", "final_answer"],
      ["devin-m4", "user-message", undefined],
      ["devin-m5", "agent-message", "commentary"],
      ["devin-tool-call-2", "tool-summary", undefined],
      ["devin-m6", "agent-message", "commentary"],
      ["devin-tool-call-3", "tool-summary", undefined],
      ["devin-m7", "agent-message", "final_answer"],
    ]);
    expect(page.events[0]).toMatchObject({
      content: "Fix the bug",
      attachment_count: 1,
      images: [{ id: "devin-image-1-0", mimeType: "image/png" }],
      turn_id: "devin-m1",
    });
    const [exec, edit, read] = page.events.filter((event) => event.kind === "tool-summary");
    expect(exec).toMatchObject({
      tool_name: "exec",
      tool_status: "completed",
      turn_id: "devin-m1",
      tool: {
        kind: "execute",
        title: "git status",
        content: [{ type: "terminal", command: "git status", output: "On branch main" }],
      },
    });
    expect(edit!.tool).toMatchObject({
      kind: "edit",
      title: "src/a.ts",
      content: [{ type: "diff", path: "src/a.ts", change: "update", added: 1, removed: 1 }],
    });
    expect(read!.tool).toEqual({
      kind: "read",
      title: "README.md",
      locations: [{ path: "README.md" }],
    });
  });

  it("leaves out AgentKib's continue after a usage limit, as Claude Code shows none of its own", async () => {
    const { project, file, readers, id } = fixture();
    const db = new DatabaseSync(file);
    const insert = db.prepare("INSERT INTO message_nodes VALUES (NULL,?,?,?,?,?,NULL)");
    for (const [node, parent, message] of [
      [13, 12, { message_id: "m8", role: "user", content: `${AUTO_CONTINUE_TEXT.devin}\n` }],
      [
        14,
        13,
        { message_id: "m9", role: "assistant", content: "Picked up again", phase: "final_answer" },
      ],
    ] as const)
      insert.run(
        id,
        node,
        parent,
        JSON.stringify({ ...message, metadata: { is_user_input: true } }),
        1_794_400_100 + node,
      );
    db.prepare("UPDATE sessions SET main_chain_id=14 WHERE id=?").run(id);
    db.close();
    const page = readers.events(id, project, null, 100);
    expect(page.events.some((event) => event.content?.includes("usage quota has reset"))).toBe(
      false,
    );
    // Devin's answer belongs to the turn it continues.
    expect(
      page.events.slice(-2).map((event) => [event.id, event.turn_id, event.message_phase]),
    ).toEqual([
      ["devin-m7", "devin-m4", "commentary"],
      ["devin-m9", "devin-m4", "final_answer"],
    ]);
    const records: string[] = [];
    await readers.scanSearchRecords(id, project, (record) => {
      records.push(record.recordId);
    });
    expect(records).not.toContain("devin-m8:text");
  });

  it("pages backwards from the newest item", () => {
    const { project, readers, id } = fixture();
    const latest = readers.events(id, project, null, 4);
    expect(latest.events.map((event) => event.id)).toEqual([
      "devin-tool-call-2",
      "devin-m6",
      "devin-tool-call-3",
      "devin-m7",
    ]);
    expect(latest.next_cursor).toBe("devin-v1:devin-tool-call-2");
    const earlier = readers.events(id, project, latest.next_cursor, 4);
    expect(earlier.events.map((event) => event.id)).toEqual([
      "devin-tool-call-1",
      "devin-m3",
      "devin-m4",
      "devin-m5",
    ]);
    expect(() => readers.events(id, project, "devin-v1:devin-gone", 4)).toThrow(
      "Devin history changed while it was being read",
    );
  });

  it("runs a large native page off-loop and only loads bodies within the page budget", async () => {
    const home = temp();
    const project = path.join(home, "project");
    mkdirSync(project);
    const file = path.join(home, "devin", "sessions.db");
    const db = database(file);
    const content = "s".repeat(512 * 1024);
    const rows = process.env.AGENTKIB_READ_BENCHMARK === "large" ? 512 : 72;
    try {
      db.session("long", project, rows);
      for (let node = 1; node <= rows; node++)
        db.message("long", {
          node,
          parent: node > 1 ? node - 1 : null,
          role: node % 2 ? "user" : "assistant",
          input: node % 2 === 1,
          content,
        });
    } finally {
      db.close();
    }
    const reader = new DevinSessions({}, file);
    const prepare = DatabaseSync.prototype.prepare;
    let bodyReads = 0;
    let bodyBytes = 0;
    const meter = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql) {
        const statement = prepare.call(this, sql);
        if (sql.startsWith("SELECT node_id AS node,")) {
          const iterate = statement.iterate.bind(statement);
          statement.iterate = function* (...args: Parameters<typeof iterate>) {
            for (const row of iterate(...args)) {
              bodyReads++;
              if (typeof row.content === "string") bodyBytes += Buffer.byteLength(row.content);
              yield row;
            }
          } as typeof statement.iterate;
        }
        return statement;
      });
    const reference = (() => {
      try {
        return reader.events("long", project, null, 100);
      } finally {
        meter.mockRestore();
      }
    })();
    expect(statSync(file).size).toBeGreaterThan(36 * 1024 * 1024);
    expect(reference.events).toHaveLength(7);
    expect(reference.events.every((event) => event.truncated)).toBe(true);
    expect(bodyReads).toBe(8);
    expect(bodyBytes).toBeLessThan(3 * 1024 * 1024);
    expect(reference.next_cursor).toBe(`devin-v1:devin-msg-${rows - 6}`);

    const work = new NativeHistoryWork(path.resolve("dist-electron/backend-handoff-read.cjs"));
    const delay = monitorEventLoopDelay({ resolution: 1 });
    try {
      delay.enable();
      await setTimeout(5);
      const baselineRss = process.memoryUsage.rss();
      expect(await work.read("devin-events", [file, "long", project, null, 100])).toEqual(
        reference,
      );
      await setTimeout(5);
      if (process.env.AGENTKIB_READ_BENCHMARK)
        console.info({
          devinDatabaseBytes: statSync(file).size,
          devinPageBodyBytes: bodyBytes,
          maxLoopDelayMs: delay.max / 1e6,
          baselineRss,
          processPeakRss: process.resourceUsage().maxRSS * 1024,
        });
    } finally {
      delay.disable();
      await work.close();
    }
  });

  it("builds handoff documents from the current context or the whole history", () => {
    const { project, readers, id } = fixture();
    const source = {
      workspace_id: "workspace",
      agent: "devin" as const,
      title: "Title",
      created_at: null,
      updated_at: null,
      git_branch: null,
    };
    const current = readers.document(id, project, source);
    expect(current.turns.map((turn) => [turn.role, turn.kind ?? null])).toEqual([
      ["user", "context-summary"],
      ["assistant", null],
      ["tool", null],
      ["assistant", null],
    ]);
    expect(current.turns[0]!.blocks[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Summary of the earlier work"),
    });
    expect(current.losses).toEqual([{ code: "compacted-history", count: 7 }]);
    const full = readers.document(id, project, source, { includePreCompactionHistory: true });
    expect(full.turns.map((turn) => [turn.role, turn.kind ?? null])).toEqual([
      ["user", null],
      ["assistant", null],
      ["tool", null],
      ["assistant", null],
      ["user", null],
      ["assistant", null],
      ["tool", null],
      ["user", "compaction-boundary"],
      ["user", "context-summary"],
      ["assistant", null],
      ["tool", null],
      ["assistant", null],
    ]);
    expect(full.turns[0]!.blocks).toEqual([
      { type: "text", text: "Fix the bug" },
      { type: "attachment", kind: "image", media_type: "image/png", inline_base64: PNG },
    ]);
    expect(full.turns[1]!.blocks).toEqual([
      { type: "text", text: "Looking" },
      { type: "tool-call", call_id: "call-1", name: "exec", input: '{"command":"git status"}' },
    ]);
    expect(full.losses).toEqual([{ code: "reasoning-excluded", count: 1 }]);
  });

  it("serves a user image and the records content search indexes", async () => {
    const { project, readers, id } = fixture();
    expect(readers.image(id, project, "devin-image-1-0")).toEqual({
      mimeType: "image/png",
      base64: PNG,
    });
    expect(() => readers.image(id, project, "devin-image-11-0")).toThrow(
      "session-image-unavailable",
    );
    const records: DevinSearchRecord[] = [];
    const fingerprint = await readers.scanSearchRecords(id, project, (record) => {
      records.push(record);
    });
    expect(records.map((record) => [record.recordId, record.kind])).toEqual([
      ["devin-m1:text", "user"],
      ["devin-m2:text", "assistant"],
      ["call:call-1:input", "tool-input"],
      ["call:call-1:output", "tool-output"],
      ["devin-m3:text", "assistant"],
      ["devin-m4:text", "user"],
      ["devin-m5:text", "assistant"],
      ["call:call-2:input", "tool-input"],
      ["call:call-2:output", "tool-output"],
      ["devin-m6:text", "assistant"],
      ["call:call-3:input", "tool-input"],
      ["call:call-3:output", "tool-output"],
      ["devin-m7:text", "assistant"],
    ]);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps sessions as metadata when Devin's store format is not a known one", () => {
    const { project, readers, id } = fixture("7");
    expect(readers.list(project).sessions[0]).toMatchObject({
      native_ref: id,
      availability: "metadata-only",
    });
    expect(() => readers.events(id, project, null, 10)).toThrow(
      "This Devin version stores history in a format AgentKib cannot read yet",
    );
  });

  it("refuses sessions outside the workspace and reads DEVIN_SESSIONS_DIR", () => {
    const { home, project, file, id } = fixture();
    const elsewhere = path.join(home, "elsewhere");
    mkdirSync(elsewhere);
    expect(() =>
      new DevinSessions({ HOME: home }).events(id, path.join(home, "other"), null, 10),
    ).toThrow("Devin session is no longer available in this workspace");
    expect(new DevinSessions({ HOME: elsewhere }).list(project).sessions).toEqual([]);
    expect(
      // Devin keeps `cli/sessions.db` under the moved directory.
      new DevinSessions({
        HOME: elsewhere,
        DEVIN_SESSIONS_DIR: path.dirname(path.dirname(file)),
      }).list(project).sessions,
    ).toHaveLength(1);
  });
});

describe("Devin context sources", () => {
  it("loads always-on rules and honors read_config_from", () => {
    const home = temp();
    const project = path.join(home, "project");
    mkdirSync(path.join(project, ".devin/rules"), { recursive: true });
    writeFileSync(path.join(project, "AGENTS.md"), "shared");
    writeFileSync(path.join(project, "CLAUDE.md"), "claude");
    writeFileSync(path.join(project, ".devin/global_rules.md"), "devin");
    writeFileSync(path.join(project, ".devin/rules/always.md"), "---\ntrigger: always_on\n---\nA");
    writeFileSync(path.join(project, ".devin/rules/manual.md"), "---\ntrigger: manual\n---\nB");
    const warnings: string[] = [];
    const environment = { HOME: home };
    expect(sources("devin", [project], warnings, environment)).toEqual([
      path.join(project, "AGENTS.md"),
      path.join(project, "CLAUDE.md"),
      path.join(project, ".devin/global_rules.md"),
      path.join(project, ".devin/rules/always.md"),
    ]);
    expect(warnings).toEqual([
      `Devin rule is not always active and is excluded from the preview: ${path.join(project, ".devin/rules/manual.md")}`,
    ]);
    writeFileSync(
      path.join(project, ".devin/config.json"),
      JSON.stringify({ read_config_from: { claude: false } }),
    );
    expect(sources("devin", [project], [], environment)).not.toContain(
      path.join(project, "CLAUDE.md"),
    );
  });
});

describe("Devin subagents", () => {
  it("lists a session's subagents and reads each one's own chain", () => {
    const { home, project, file, id } = fixture();
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE subagent_heads (session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      chain_node_id INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, agent_id))`);
    const insert = db.prepare("INSERT INTO message_nodes VALUES (NULL,?,?,?,?,?,?)");
    const message = (node: number, parent: number | null, role: string, content: string) =>
      insert.run(
        id,
        node,
        parent,
        JSON.stringify({
          message_id: `sub-${node}`,
          role,
          content,
          metadata: {
            ...(role === "user" ? { is_user_input: true } : {}),
            created_at: new Date(Date.UTC(2026, 10, 12, 0, 1, node)).toISOString(),
          },
        }),
        1_794_400_100 + node,
        null,
      );
    message(40, null, "system", "subagent system prompt");
    message(41, 40, "user", "Find where the config is read");
    message(42, 41, "assistant", "It is read in config.ts");
    db.prepare("INSERT INTO subagent_heads VALUES (?,?,?,?)").run(id, "a1b2c3", 42, 1_794_400_200);
    db.close();
    const reader = new DevinSessions({ HOME: home });
    const catalog = reader.subagents(id, project, "parent-1");
    expect(catalog.truncated).toBe(false);
    expect(catalog.agents).toHaveLength(1);
    expect(catalog.agents[0]).toMatchObject({
      name: "Find where the config is read",
      agent: "devin",
      status: "unknown",
      readable: true,
    });
    expect(catalog.agents[0]!.id).toMatch(/^[a-f0-9]{64}$/);
    const page = reader.subagentEvents(id, project, "parent-1", catalog.agents[0]!.id, null, 50);
    expect(page.events.map((event) => event.content)).toEqual([
      "Find where the config is read",
      "It is read in config.ts",
    ]);
    // The subagent's chain is not part of the session's own history.
    expect(
      reader
        .events(id, project, null, 50)
        .events.some((event) => event.content === "It is read in config.ts"),
    ).toBe(false);
    expect(() => reader.subagentEvents(id, project, "parent-1", "0".repeat(64), null, 50)).toThrow(
      "subagent-unavailable",
    );
  });

  it("has no subagents where Devin keeps no subagent table", () => {
    const { home, project, id } = fixture();
    expect(new DevinSessions({ HOME: home }).subagents(id, project, "parent-1").agents).toEqual([]);
  });

  it("projects unknown Devin activities and links only readable child chains", async () => {
    const { home, project, file, id } = fixture();
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE subagent_heads (session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      chain_node_id INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, agent_id))`);
    const node = db.prepare("INSERT INTO message_nodes VALUES (NULL,?,?,?,?,?,?)");
    node.run(
      id,
      40,
      null,
      JSON.stringify({
        role: "user",
        content: "Verify the build",
        metadata: { is_user_input: true },
      }),
      1_794_400_100,
      null,
    );
    node.run("far-away", 50, null, '{"role":"system"}', 1_794_400_100, null);
    const head = db.prepare("INSERT INTO subagent_heads VALUES (?,?,?,?)");
    head.run(id, "readable-native-child", 40, 1_794_400_102);
    head.run(id, "foreign-native-child", 50, 1_794_400_101);
    db.close();

    const data = path.join(home, "backend");
    const environment = {
      HOME: home,
      DEVIN_SESSIONS_DIR: path.dirname(path.dirname(file)),
      PATH: path.join(home, "bin"),
    };
    const runtime = await startBackend({
      data,
      workspace: project,
      environment,
      indexSessions: true,
    });
    try {
      const store = new BackendStore(path.join(data, "agentkib.db"));
      const sessionId = store.sessions.id("devin", id);
      try {
        store.sessions.sync(
          "workspace",
          "devin",
          new DevinSessions(environment).list(project).sessions,
        );
      } finally {
        store.close();
      }
      const readable = DevinSessions.subagentId(sessionId, "readable-native-child");
      const foreign = DevinSessions.subagentId(sessionId, "foreign-native-child");
      const web = (operation: string, fields: Record<string, unknown> = {}) =>
        runtime.rpc(RUNTIME_METHODS.webRequest, { operation, sessionId, ...fields });
      const subscription = (await runtime.rpc(RUNTIME_METHODS.sessionsSubscribe, {
        sessionId,
      })) as SessionSubscription;
      try {
        const snapshot = subscription.events.find(({ type }) => type === "snapshot")?.payload
          .live as
          | {
              activities: { childId?: string }[];
            }
          | undefined;
        expect(snapshot).toMatchObject({
          subagents: { agents: [], available: false },
          activities: [
            {
              id: readable,
              childId: readable,
              kind: "subagent",
              title: "Verify the build",
              status: "unknown",
            },
            { id: foreign, kind: "subagent", title: "Devin", status: "unknown" },
          ],
        });
        expect(snapshot?.activities[1]).not.toHaveProperty("childId");
        expect(await web("live", { experimentalEnabled: true })).not.toHaveProperty("activities");
        expect(await web("subagent-events", { subagentId: readable })).toMatchObject({
          events: [{ content: "Verify the build" }],
        });
        expect(await web("subagents")).toMatchObject({
          agents: [
            { id: readable, readable: true },
            { id: foreign, readable: true },
          ],
        });
      } finally {
        await runtime.rpc(RUNTIME_METHODS.sessionsUnsubscribe, {
          subscriptionId: subscription.subscriptionId,
        });
      }
    } finally {
      await runtime.close();
    }
  });
});
