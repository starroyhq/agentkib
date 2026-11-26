// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcp } from "../../../packages/backend/src/agents/antigravity/antigravity-acp";
import {
  AntigravityHistory,
  antigravityLocalRef,
} from "../../../packages/backend/src/agents/antigravity/antigravity-history";
import { AntigravityLocalStore } from "../../../packages/backend/src/agents/antigravity/antigravity-local-store";
import * as resolution from "../../../packages/backend/src/command-resolution";
import { Commands } from "../../../packages/backend/src/commands";
import { readHistorySearchSource } from "../../../packages/backend/src/history-search-source";
import { prepareSessionHandoff } from "../../../packages/backend/src/session-continuation";
import { planSessionHandoff } from "../../../packages/backend/src/session-handoff-plan";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { continueNativeImport } from "../../../packages/backend/src/session-native-import-owner";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import type { NativeSession } from "../../../packages/backend/src/session-store";
import { BackendStore } from "../../../packages/backend/src/store";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
const ID = "12345678-1234-1234-1234-123456789abc";
const SECOND = "12345678-1234-1234-1234-123456789abd";
function varint(input: number | bigint): Buffer {
  let value = BigInt(input);
  const bytes: number[] = [];
  do {
    const byte = Number(value & 127n);
    value >>= 7n;
    bytes.push(value ? byte | 128 : byte);
  } while (value);
  return Buffer.from(bytes);
}
function field(number: number, value: string | Buffer): Buffer {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function summary(id: string, workspace: string, title = "Synthetic title") {
  return Buffer.concat([
    field(1, title),
    field(4, id),
    field(3, Buffer.concat([varint(8), varint(1_790_000_000)])),
    field(9, field(1, pathToFileURL(workspace).href)),
  ]);
}
function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "antigravity-local-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const workspace = path.join(home, "workspace");
  mkdirSync(workspace);
  const app = path.join(home, ".gemini/antigravity"),
    ide = path.join(home, ".gemini/antigravity-ide");
  for (const root of [app, ide]) mkdirSync(path.join(root, "conversations"), { recursive: true });
  const file = path.join(app, "conversation_summaries.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE conversation_summaries(conversation_id TEXT PRIMARY KEY,title TEXT,workspace_uris TEXT,last_modified_time TEXT,raw_summary BLOB);
 CREATE TABLE conversations_fts(conversation_id TEXT,chunk_index INTEGER,chunk_first_step INTEGER,chunk_last_step INTEGER,user_body TEXT,agent_body TEXT,user_step_byte_offsets BLOB,agent_step_byte_offsets BLOB);`);
  function add(id = ID, w = workspace) {
    writeFileSync(path.join(app, `conversations/${id}.pb`), Buffer.from([10, 255, 14]));
    db.prepare("INSERT INTO conversation_summaries VALUES(?,?,?,?,?)").run(
      id,
      "",
      JSON.stringify([pathToFileURL(w).href]),
      "2026-11-10T00:00:00Z",
      summary(id, w),
    );
  }
  function chunk(
    id = ID,
    values = {
      user: "你好\nSecond",
      agent: "Reply\nDone",
      userOffsets: [
        [0, 0],
        [2, 7],
      ],
      agentOffsets: [
        [1, 0],
        [3, 6],
      ],
    },
  ) {
    db.prepare("INSERT INTO conversations_fts VALUES(?,0,0,3,?,?,?,?)").run(
      id,
      values.user,
      values.agent,
      Buffer.from(JSON.stringify(values.userOffsets)),
      Buffer.from(JSON.stringify(values.agentOffsets)),
    );
  }
  const store = new AntigravityLocalStore({ HOME: home });
  cleanup.push(() => {
    if (db.isOpen) db.close();
  });
  return { home, workspace, app, ide, file, db, store, add, chunk };
}
describe("offline Antigravity histories", () => {
  it("preserves indexed session identities and imports and indexes local text without ACP", async () => {
    const f = fixture();
    for (const nativeId of [ID, SECOND]) {
      f.add(nativeId);
      f.chunk(nativeId);
    }
    const executable = path.join(f.home, "agy");
    writeFileSync(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const environment = { HOME: f.home, PATH: f.home, AGENTKIB_ANTIGRAVITY_ACP_BIN: executable };
    const spawn = vi.spyOn(AntigravityAcp, "spawn");
    cleanup.push(() => spawn.mockRestore());
    const data = path.join(f.home, "data");
    const backend = new BackendStore(path.join(data, "agentkib.db"));
    cleanup.push(() => backend.close());
    backend.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
      "workspace",
      f.workspace,
      "Offline workspace",
      "healthy",
      "2026-11-20T00:00:00Z",
    );
    const cached = (native_ref: string): NativeSession => ({
      native_ref,
      agent: "antigravity",
      title: native_ref,
      created_at: null,
      updated_at: null,
      message_count: null,
      git_branch: null,
      archived: false,
      sidechain: false,
      availability: "readable",
      origin: "interactive",
    });
    const nativeRefs = [ID, antigravityLocalRef("ide", SECOND), "acp-only-session"];
    const ids = nativeRefs.map((ref) => backend.sessions.id("antigravity", ref));
    backend.sessions.sync("workspace", "antigravity", nativeRefs.map(cached));
    const commands = new Commands();
    const readers = new SessionReaders(backend.sessions, commands, environment, {
      profiles: () => [],
    });
    cleanup.push(() => {
      readers.close();
      commands.close();
    });
    const index = new SessionIndex(
      backend.sessions,
      {
        list: (provider, workspace, selection) =>
          provider === "antigravity"
            ? readers.list(provider, workspace, selection)
            : Promise.resolve({ sessions: [], incomplete: false }),
      },
      () => true,
    );
    cleanup.push(() => index.close());
    const refresh = async () =>
      (await index.refresh({ workspaceId: "workspace", force: true })).map(({ id }) => id);
    expect(await refresh()).toEqual(expect.arrayContaining(ids));
    expect(await refresh()).toHaveLength(ids.length);
    expect(index.catalogSources(["workspace"])).toContainEqual({
      workspaceId: "workspace",
      agent: "antigravity",
      complete: false,
      reasons: ["antigravity-acp-disabled"],
    });
    for (const sessionId of [ids[0]!, ids[1]!])
      await expect(readers.events({ sessionId })).resolves.toMatchObject({
        events: expect.arrayContaining([expect.objectContaining({ content: "Reply\n" })]),
        warnings: ["history.warning.partial"],
      });
    await expect(readers.events({ sessionId: ids[2] })).rejects.toThrow("antigravity-acp-disabled");
    const texts = ["你好\n", "Reply\n", "Second", "Done"];
    const target = path.join(f.home, "opencode");
    const exported = path.join(f.home, "opencode-export.json");
    writeFileSync(target, "fixture", { mode: 0o755 });
    const resolve = resolution.resolveCommand;
    const resolveTarget = vi
      .spyOn(resolution, "resolveCommand")
      .mockImplementation((name, env) => (name === "opencode" ? target : resolve(name, env)));
    const run = vi.spyOn(commands, "run").mockImplementation(async (program, args) => {
      expect(program).toBe(target);
      let output = "";
      if (args[0] === "--version") output = "1.18.32";
      else if (args[0] === "debug") output = JSON.stringify({ model: "fixture/model" });
      else if (args[0] === "import") writeFileSync(exported, readFileSync(args[1]!));
      else if (args[0] === "export") output = readFileSync(exported, "utf8");
      else throw new Error("Unexpected OpenCode fixture command");
      return {
        bytes: Buffer.from(output),
        success: true,
        error: "",
        truncated: false,
        exitCode: 0,
      };
    });
    cleanup.push(() => {
      run.mockRestore();
      resolveTarget.mockRestore();
    });
    const sessionId = ids[0]!;
    const mcpHubStatus = { running: false, port: 4010 };
    const prepared = (await prepareSessionHandoff(
      {
        request: {
          session_id: sessionId,
          target_agent: "opencode",
          format: "markdown",
          history_budget_tokens: 64000,
        },
        mcpHubStatus,
      },
      readers,
      backend.sessions,
      backend,
      commands,
      environment,
    )) as { draft: { filename: string; source_fingerprint: string; target_fingerprint: string } };
    expect(prepared.draft).toMatchObject({
      mode: "native-session",
      losses: [{ code: "source-content-truncated", count: 1 }],
    });
    const plan = (acceptLosses: boolean) =>
      planSessionHandoff(
        {
          sessionId,
          workspaceId: "workspace",
          targetAgent: "opencode",
          mode: "native-session",
          format: "markdown",
          filename: prepared.draft.filename,
          sourceFingerprint: prepared.draft.source_fingerprint,
          targetFingerprint: prepared.draft.target_fingerprint,
          acceptLosses,
          historyBudgetTokens: 64000,
          mcpHubStatus,
        },
        readers,
        backend.sessions,
        backend,
        data,
        environment,
        commands,
      );
    await expect(plan(false)).rejects.toThrow("Continuation losses must be acknowledged");
    const approved = await plan(true);
    await expect(
      continueNativeImport(
        {
          changeSet: approved.change_set,
          launchRequest: approved.launch_request,
          approveHome: true,
        },
        readers,
        backend.sessions,
        backend,
        data,
        environment,
        commands,
      ),
    ).resolves.toMatchObject({
      status: "verified",
      targetSessionId: expect.stringMatching(/^ses_/),
    });
    const written = JSON.parse(readFileSync(exported, "utf8")) as {
      messages: Array<{ parts: Array<{ text: string }> }>;
    };
    expect(written.messages.slice(1).map(({ parts }) => parts[0]?.text)).toEqual(texts);

    const records: string[] = [];
    const search = await readHistorySearchSource(
      {
        sessionId: ids[0]!,
        summary: backend.sessions.get(ids[0]!)!,
        workspacePath: f.workspace,
        environment,
        identitySalt: backend.sessions.identitySalt(),
        profiles: [],
      },
      ({ content }) => {
        records.push(content);
      },
    );
    expect(search.status).toBe("partial");
    expect(records).toEqual(texts);
    expect(spawn).not.toHaveBeenCalled();
  });
  it("lists native metadata and keeps the database unchanged", () => {
    const f = fixture();
    f.add();
    f.chunk();
    const before = readFileSync(f.file);
    expect(f.store.list(f.workspace)).toMatchObject({
      incomplete: false,
      records: [
        {
          surface: "app",
          id: ID,
          title: "Synthetic title",
          workspace: f.workspace,
          created_at: null,
          updated_at: "2026-11-10T00:00:00Z",
          availability: "readable",
        },
      ],
    });
    expect(readFileSync(f.file)).toEqual(before);
  });
  it("reads committed WAL entries and leaves a closed database without sidecar files", () => {
    const f = fixture();
    f.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
    f.add();
    f.chunk();
    expect(f.store.events("app", ID, f.workspace, null, 20).events).toHaveLength(4);
    f.db.close();
    const before = readdirSync(f.app).sort();
    expect(before).toEqual(["conversation_summaries.db", "conversations"]);
    expect(f.store.events("app", ID, f.workspace, null, 20).events).toHaveLength(4);
    expect(readdirSync(f.app).sort()).toEqual(before);
  });
  it("reads IDE summary maps as metadata-only", () => {
    const f = fixture();
    writeFileSync(path.join(f.ide, `conversations/${ID}.pb`), Buffer.from([1, 2]));
    writeFileSync(
      path.join(f.ide, "agyhub_summaries_proto.pb"),
      field(1, Buffer.concat([field(1, ID), field(2, summary(ID, f.workspace))])),
    );
    expect(f.store.list(f.workspace).records).toMatchObject([
      {
        surface: "ide",
        id: ID,
        availability: "metadata-only",
        updated_at: new Date(1_790_000_000_000).toISOString(),
      },
    ]);
    expect(() => f.store.events("ide", ID, f.workspace, null, 20)).toThrow();
  });
  it("uses a malformed summary's verified workspace without dropping other entries", () => {
    const f = fixture();
    const other = path.join(f.home, "elsewhere");
    mkdirSync(other);
    writeFileSync(path.join(f.ide, `conversations/${SECOND}.pb`), Buffer.from([1]));
    const malformed = Buffer.concat([
      field(1, Buffer.from([0xff])),
      field(9, field(1, pathToFileURL(f.workspace).href)),
    ]);
    writeFileSync(
      path.join(f.ide, "agyhub_summaries_proto.pb"),
      Buffer.concat([
        field(1, Buffer.concat([field(1, ID), field(2, malformed)])),
        field(1, Buffer.concat([field(1, SECOND), field(2, summary(SECOND, other))])),
      ]),
    );
    expect(f.store.list(f.workspace)).toMatchObject({
      records: [],
      incomplete: true,
      issues: [{ code: "antigravity-summary-record", surface: "ide", scope: "workspace", id: ID }],
    });
    expect(f.store.list(other)).toMatchObject({ records: [{ id: SECOND }], incomplete: false });
  });
  it("recognizes migrated IDs without assigning orphan trajectories to a project", () => {
    const f = fixture();
    f.add();
    f.chunk();
    const ideFile = path.join(f.ide, "conversation_summaries.db");
    copyFileSync(f.file, ideFile);
    const ideDb = new DatabaseSync(ideFile);
    try {
      ideDb.exec("DELETE FROM conversation_summaries");
    } finally {
      ideDb.close();
    }
    for (const id of [ID, SECOND])
      writeFileSync(path.join(f.ide, `conversations/${id}.pb`), Buffer.from([1]));
    expect(f.store.list(f.workspace).records).toMatchObject([
      { surface: "app", id: ID, availability: "readable" },
      { surface: "ide", id: ID, availability: "metadata-only" },
    ]);
  });
  it("keeps absent optional sources silent", () => {
    const f = fixture();
    rmSync(path.join(f.home, ".gemini"), { recursive: true });
    expect(f.store.list()).toEqual({ records: [], incomplete: false });
  });
  it("rejects foreign workspaces and missing trajectory files", () => {
    const f = fixture();
    f.add();
    f.chunk();
    const other = path.join(f.home, "elsewhere");
    expect(f.store.list(other).records).toEqual([]);
    expect(() => f.store.events("app", ID, other, null, 20)).toThrow("session-workspace-mismatch");
    rmSync(path.join(f.app, `conversations/${ID}.pb`));
    expect(f.store.list().records).toEqual([]);
  });
  it("merges role text in native step order with UTF-8 byte offsets", () => {
    const f = fixture();
    f.add();
    f.chunk();
    const page = f.store.events("app", ID, f.workspace, null, 20);
    expect(page.events.map((x) => [x.kind, x.content])).toEqual([
      ["user-message", "你好\n"],
      ["agent-message", "Reply\n"],
      ["user-message", "Second"],
      ["agent-message", "Done"],
    ]);
    expect(page.warnings).toEqual(["history.warning.partial"]);
    expect(page.events.every((x) => x.timestamp === null && x.attachment_count === 0)).toBe(true);
  });
  it("binds pagination to the immutable text projection", () => {
    const f = fixture();
    f.add();
    f.chunk();
    const latest = f.store.events("app", ID, f.workspace, null, 2);
    expect(latest.events.map((x) => x.content)).toEqual(["Second", "Done"]);
    expect(
      f.store.events("app", ID, f.workspace, latest.next_cursor, 2).events.map((x) => x.content),
    ).toEqual(["你好\n", "Reply\n"]);
    f.db.prepare("UPDATE conversations_fts SET agent_body='Other\\nDone'").run();
    expect(() => f.store.events("app", ID, f.workspace, latest.next_cursor, 2)).toThrow("cursor");
  });
  it("pages through a large native FTS store with a bounded materialized window", async () => {
    const f = fixture();
    f.add();
    f.db.exec(`DROP TABLE conversations_fts;
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        conversation_id UNINDEXED, chunk_index UNINDEXED,
        chunk_first_step UNINDEXED, chunk_last_step UNINDEXED,
        user_body UNINDEXED, agent_body UNINDEXED,
        user_step_byte_offsets UNINDEXED, agent_step_byte_offsets UNINDEXED
      ); BEGIN IMMEDIATE;`);
    const add = f.db.prepare("INSERT INTO conversations_fts VALUES(?,?,?,?,?,?,?,?)");
    const body = "x".repeat(256 * 1024);
    const chunkCount = 320;
    for (let step = 0; step < chunkCount; step++)
      add.run(ID, step, step, step, `${step}:${body}`, "", `[[${step},0]]`, "[]");
    f.db.exec("COMMIT;");
    f.db.close();
    const reads: number[] = [];
    const store = new AntigravityLocalStore({ HOME: f.home }, (bytes) => reads.push(bytes));
    const latest = store.events("app", ID, f.workspace, null, 3);
    expect(latest.events.map((event) => event.id.split("-").at(-1))).toEqual(["317", "318", "319"]);
    expect(latest.events.every((event) => event.truncated)).toBe(true);
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(2 * 1024 * 1024);
    reads.length = 0;
    const older = store.events("app", ID, f.workspace, latest.next_cursor, 3);
    expect(older.events.map((event) => event.id.split("-").at(-1))).toEqual(["314", "315", "316"]);
    expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBeLessThan(2 * 1024 * 1024);

    const history = new AntigravityHistory(
      { HOME: f.home },
      { workerFilename: path.resolve("dist-electron/backend-antigravity-history.cjs") },
    );
    try {
      const [page, listing] = await Promise.all([
        history.readEvents(antigravityLocalRef("app", ID), null, 3, f.workspace),
        history.list(f.workspace),
      ]);
      expect(page).toEqual(latest);
      expect(listing.sessions).toMatchObject([{ native_ref: antigravityLocalRef("app", ID) }]);
    } finally {
      await history.close();
    }
  });
  it.each([
    [
      [0, 0],
      [2, 1],
    ],
    [
      [2, 0],
      [0, 7],
    ],
    [[0, -1]],
    [[0, 999]],
    [
      [0, 0],
      [0, 7],
    ],
  ])("rejects malformed offset positions (%j)", (userOffsets) => {
    const f = fixture();
    f.add();
    f.chunk(ID, {
      user: "你好\nSecond",
      agent: "Reply\nDone",
      userOffsets,
      agentOffsets: [
        [1, 0],
        [3, 6],
      ],
    });
    expect(() => f.store.events("app", ID, f.workspace, null, 20)).toThrow();
  });
  it("uses the primary key rather than the unrelated UUID inside a summary", () => {
    const f = fixture();
    f.add();
    f.db
      .prepare("UPDATE conversation_summaries SET raw_summary=?")
      .run(summary(SECOND, f.workspace));
    expect(f.store.list().records[0]?.id).toBe(ID);
    expect(() => f.store.events("app", "../escape", f.workspace, null, 10)).toThrow(
      "invalid-request",
    );
  });
  it("does not trust remote workspace URIs", () => {
    const f = fixture();
    f.add();
    f.db
      .prepare("UPDATE conversation_summaries SET workspace_uris=?,raw_summary=NULL")
      .run(JSON.stringify(["file://remote-host/secret"]));
    expect(f.store.list().records).toEqual([]);
  });
  it("keeps a malformed database row from marking a different workspace incomplete", () => {
    const f = fixture();
    const other = path.join(f.home, "elsewhere");
    mkdirSync(other);
    f.add();
    f.add(SECOND, other);
    f.db
      .prepare("UPDATE conversation_summaries SET raw_summary=? WHERE conversation_id=?")
      .run(Buffer.from([10, 255]), ID);
    expect(f.store.list(f.workspace)).toMatchObject({
      records: [],
      incomplete: true,
      issues: [{ code: "antigravity-database-record", surface: "app", scope: "workspace", id: ID }],
    });
    const unrelated = f.store.list(other);
    expect(unrelated).toMatchObject({ records: [{ id: SECOND }], incomplete: false });
    expect(unrelated.issues).toBeUndefined();
  });
  it("ignores an unscoped corrupt row while listing a valid workspace", () => {
    const f = fixture();
    f.add();
    f.add(SECOND);
    f.db
      .prepare(
        "UPDATE conversation_summaries SET workspace_uris=?,raw_summary=NULL WHERE conversation_id=?",
      )
      .run("invalid json", SECOND);
    expect(f.store.list(f.workspace)).toMatchObject({
      records: [{ id: ID }],
      incomplete: false,
      issues: [
        { code: "antigravity-database-record", surface: "app", scope: "unattributed", id: SECOND },
      ],
    });
  });
  it("keeps readable records when a row exceeds the metadata limit", () => {
    const f = fixture();
    f.add();
    f.add(SECOND);
    f.db
      .prepare("UPDATE conversation_summaries SET raw_summary=? WHERE conversation_id=?")
      .run(Buffer.alloc(2 * 1024 * 1024 + 1), SECOND);
    expect(f.store.list(f.workspace)).toMatchObject({ records: [{ id: ID }], incomplete: true });
  });
  it("flags corrupt configured databases without recreating them", () => {
    const f = fixture();
    const broken = path.join(f.ide, "conversation_summaries.db");
    writeFileSync(broken, "not sqlite");
    expect(f.store.list().incomplete).toBe(true);
    expect(readFileSync(broken, "utf8")).toBe("not sqlite");
  });
  it("rejects symlinked sources", () => {
    const f = fixture();
    f.add();
    const target = path.join(f.app, `conversations/${ID}.pb`);
    rmSync(target);
    symlinkSync(f.file, target);
    expect(f.store.list()).toMatchObject({
      records: [],
      incomplete: true,
      issues: [
        { code: "antigravity-trajectory-record", surface: "app", scope: "workspace", id: ID },
      ],
    });
  });
  it("rejects oversized or malformed summaries", () => {
    const f = fixture();
    f.add();
    f.db
      .prepare("UPDATE conversation_summaries SET raw_summary=?")
      .run(Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(f.store.list()).toMatchObject({ records: [], incomplete: true });
    writeFileSync(path.join(f.ide, "agyhub_summaries_proto.pb"), Buffer.from([10, 255]));
    expect(f.store.list().incomplete).toBe(true);
  });
});
