// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevinSessions } from "../../../packages/backend/src/devin-sessions";
import { sources } from "../../../packages/backend/src/context-sources";

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
            ...(value.input ? { is_user_input: true } : {}),
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

describe("Devin sessions", () => {
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

  it("serves a user image and the records content search indexes", () => {
    const { project, readers, id } = fixture();
    expect(readers.image(id, project, "devin-image-1-0")).toEqual({
      mimeType: "image/png",
      base64: PNG,
    });
    expect(() => readers.image(id, project, "devin-image-11-0")).toThrow(
      "session-image-unavailable",
    );
    const search = readers.searchRecords(id, project);
    expect(search.records.map((record) => [record.recordId, record.kind])).toEqual([
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
    expect(search.fingerprint).toMatch(/^[0-9a-f]{64}$/);
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
      new DevinSessions({ HOME: elsewhere, DEVIN_SESSIONS_DIR: path.dirname(file) }).list(project)
        .sessions,
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
