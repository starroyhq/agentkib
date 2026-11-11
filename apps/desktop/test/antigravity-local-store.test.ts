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
import { afterEach, describe, expect, it } from "vitest";
import { AntigravityLocalStore } from "../../../packages/backend/src/antigravity-local-store";
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
    expect(f.store.list()).toEqual({ records: [], incomplete: true });
  });
  it("rejects oversized or malformed summaries", () => {
    const f = fixture();
    f.add();
    f.db
      .prepare("UPDATE conversation_summaries SET raw_summary=?")
      .run(Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(f.store.list()).toEqual({ records: [], incomplete: true });
    writeFileSync(path.join(f.ide, "agyhub_summaries_proto.pb"), Buffer.from([10, 255]));
    expect(f.store.list().incomplete).toBe(true);
  });
});
