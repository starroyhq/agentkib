import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSessions } from "../../../packages/backend/src/codex-sessions";
import { Sql } from "../../../packages/backend/src/sql";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const fixtures: string[] = [];
const readers: CodexSessions[] = [];
const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const otherId = "11111111-2222-4333-8444-555555555555";

function fixture(sourceColumn = true, retainDatabase = false) {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-codex-classification-"));
  fixtures.push(root);
  const home = path.join(root, "home"),
    codexHome = path.join(home, ".codex"),
    workspace = path.join(root, "workspace"),
    file = path.join(codexHome, "state_1.sqlite");
  for (const directory of [home, codexHome, workspace]) mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT,
    ${sourceColumn ? "source TEXT," : ""}
    thread_source TEXT, parent_thread_id TEXT, forked_from_id TEXT, project_id TEXT
  )`);
  db.close();
  const reader = new CodexSessions(
    { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome },
    { retainDatabase },
  );
  readers.push(reader);
  const add = (
    id: string,
    options: {
      source?: string | null;
      threadSource?: string | null;
      parent?: string | null;
      fork?: string | null;
      cwd?: string;
      project?: string | null;
      payload?: Record<string, unknown>;
      contents?: string;
      transcript?: string;
      write?: boolean;
    } = {},
  ) => {
    const transcript = options.transcript ?? path.join(codexHome, `${id}.jsonl`),
      cwd = options.cwd ?? workspace;
    if (options.write !== false)
      writeFileSync(
        transcript,
        options.contents ??
          JSON.stringify({
            type: "session_meta",
            payload: { id, cwd, source: "cli", ...options.payload },
          }) + "\n",
      );
    const db = new DatabaseSync(file);
    try {
      const columns = [
          "id",
          "rollout_path",
          "cwd",
          "title",
          ...(sourceColumn ? ["source"] : []),
          "thread_source",
          "parent_thread_id",
          "forked_from_id",
          "project_id",
        ],
        values = [
          id,
          path.relative(codexHome, transcript),
          cwd,
          "Synthetic conversation",
          ...(sourceColumn ? [options.source ?? null] : []),
          options.threadSource ?? null,
          options.parent ?? null,
          options.fork ?? null,
          options.project ?? null,
        ];
      db.prepare(
        `INSERT INTO threads (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
      ).run(...values);
    } finally {
      db.close();
    }
    return transcript;
  };
  return { root, home, codexHome, workspace, file, reader, add };
}

function additionalIndex(
  f: ReturnType<typeof fixture>,
  id: string,
  cwd: string,
  payload: Record<string, unknown> = {},
  omittedColumn?: "cwd" | "rollout_path",
) {
  const transcript = path.join(f.codexHome, "second-database.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({ type: "session_meta", payload: { id, cwd, source: "exec", ...payload } }) +
      "\n",
  );
  const db = new DatabaseSync(path.join(f.codexHome, "state_2.sqlite"));
  try {
    db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT)");
    db.prepare("INSERT INTO threads VALUES (?,?,?)").run(id, transcript, cwd);
    if (omittedColumn) db.exec(`ALTER TABLE threads DROP COLUMN ${omittedColumn}`);
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.clearAllMocks();
  for (const reader of readers.splice(0)) reader.close();
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Codex session classification", () => {
  it.each([
    ["exec", "execution"],
    ['"exec"', "execution"],
    [null, "execution"],
    ["", "execution"],
    ["  ", "execution"],
    ["cli", "interactive"],
    ["vscode", "interactive"],
    ["subagent", "auxiliary"],
    ['{"subagent":{"review":{}}}', "auxiliary"],
    ["{broken", "unknown"],
    ["mcp", "interactive"],
  ])("prefers explicit database source %s over header and user fallback", (source, expected) => {
    const f = fixture();
    f.add(nativeId, {
      source,
      threadSource: "user",
      payload: { source: "exec", thread_source: "user" },
    });
    expect(f.reader.list(f.workspace).sessions[0].session.origin).toBe(expected);
  });

  it.each([
    ["cli", {}, "interactive"],
    ["vscode", {}, "interactive"],
    ["exec", { thread_source: "user" }, "execution"],
    ["subagent", {}, "auxiliary"],
    [{ subagent: { review: {} } }, {}, "auxiliary"],
    [
      { subagent: { thread_spawn: { parent_thread_id: "parent", agent_path: "/root/worker" } } },
      { forked_from_id: "fork" },
      "auxiliary",
    ],
    [{ subagent: { thread_spawn: { depth: 1 } } }, {}, "auxiliary"],
    ["mcp", {}, "unknown"],
    ["review", {}, "unknown"],
    ["mcp", { thread_source: "user" }, "interactive"],
    [{ not_subagent: true }, { thread_source: "user" }, "unknown"],
    [
      { subagent: { thread_spawn: { parent_thread_id: "" } } },
      { thread_source: "user" },
      "unknown",
    ],
  ])(
    "enriches missing database source from the first native header %#",
    (source, extra, expected) => {
      const f = fixture(false);
      f.add(nativeId, { payload: { source, ...extra } });
      const session = f.reader.list(f.workspace).sessions[0].session;
      expect(session.origin).toBe(expected);
      if ("forked_from_id" in extra) {
        expect(session.spawned_by_session_id).toBe("parent");
        expect(session.forked_from_session_id).toBe("fork");
      }
    },
  );

  it("keeps unknown source visible and never infers source or relations from body records", () => {
    const f = fixture();
    f.add(nativeId, {
      contents:
        JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: f.workspace } }) +
        "\n" +
        JSON.stringify({
          type: "session_meta",
          payload: { source: "exec", parent_thread_id: "body-parent" },
        }) +
        "\n",
    });
    expect(f.reader.list(f.workspace).sessions[0].session).toMatchObject({
      origin: "unknown",
      spawned_by_session_id: null,
      forked_from_session_id: null,
    });
  });

  it("retains database parent and fork when conflicting native metadata fills missing source", () => {
    const f = fixture();
    f.add(nativeId, {
      parent: "database-parent",
      fork: "database-fork",
      payload: { source: "exec", parent_thread_id: "header-parent", forked_from_id: "header-fork" },
    });
    expect(f.reader.list(f.workspace).sessions[0].session).toMatchObject({
      origin: "execution",
      spawned_by_session_id: "database-parent",
      forked_from_session_id: "database-fork",
    });
  });

  it.each(["missing", "malformed", "oversized", "body-only"])(
    "keeps unavailable %s header metadata conservative",
    (kind) => {
      const f = fixture();
      f.add(nativeId, {
        threadSource: "user",
        write: kind !== "missing",
        contents:
          kind === "malformed"
            ? "{broken}\n"
            : kind === "oversized"
              ? JSON.stringify({
                  type: "session_meta",
                  payload: { source: "exec", padding: "x".repeat(256 * 1024) },
                }) + "\n"
              : "{}\n" +
                JSON.stringify({ type: "session_meta", payload: { source: "exec" } }) +
                "\n",
      });
      expect(f.reader.list(f.workspace).sessions[0].session.origin).toBe("interactive");
    },
  );

  it("filters unrelated workspaces before reading native headers", () => {
    const f = fixture();
    f.add(nativeId, { cwd: path.join(f.root, "other-workspace"), payload: { source: "exec" } });
    vi.mocked(openSync).mockClear();
    expect(f.reader.list(f.workspace).sessions).toEqual([]);
    expect(openSync).not.toHaveBeenCalled();
  });
});

describe("Legacy AgentKib history import display exception", () => {
  const changes: Array<[string, string | null, unknown]> = [
    ["complete", null, null],
    ["missing-originator", "originator", undefined],
    ["wrong-originator", "originator", "codex-tui"],
    ["missing-source", "source", undefined],
    ["wrong-source", "source", "cli"],
    ["missing-thread-source", "thread_source", undefined],
    ["wrong-thread-source", "thread_source", "user"],
    ["missing-history-mode", "history_mode", undefined],
    ["wrong-history-mode", "history_mode", "modern"],
    ["missing-id", "id", undefined],
    ["wrong-id", "id", otherId],
    ["missing-cwd", "cwd", undefined],
    ["wrong-cwd", "cwd", "OTHER"],
    ["descendant-cwd", "cwd", "CHILD"],
    ["relative-cwd", "cwd", "workspace"],
  ];
  it.each(changes)(
    "only preserves complete matching legacy header: %s",
    (kind, field, replacement) => {
      for (const source of ["exec", '"exec"', null]) {
        const f = fixture();
        const payload: Record<string, unknown> = {
          id: nativeId,
          cwd: f.workspace,
          source: "exec",
          originator: "agentkib",
          thread_source: "exec",
          history_mode: "legacy",
        };
        if (field) {
          if (replacement === undefined) delete payload[field];
          else
            payload[field] =
              replacement === "OTHER"
                ? path.join(f.root, "other")
                : replacement === "CHILD"
                  ? path.join(f.workspace, "child")
                  : replacement;
        }
        const transcript = f.add(nativeId, {
          source,
          threadSource: "user",
          parent: "parent",
          fork: "fork",
          contents: JSON.stringify({ type: "session_meta", payload }) + "\n",
        });
        const before = readFileSync(transcript);
        const session = f.reader.list(f.workspace).sessions[0].session;
        expect(session.origin).toBe(
          kind === "complete" ||
            (source === null && ["missing-source", "wrong-source"].includes(kind))
            ? "interactive"
            : "execution",
        );
        expect(session.spawned_by_session_id).toBe("parent");
        expect(session.forked_from_session_id).toBe("fork");
        expect(readFileSync(transcript)).toEqual(before);
      }
    },
  );

  it.each(["oversized", "body-only"])("rejects %s import markers", (kind) => {
    const f = fixture();
    const header = JSON.stringify({
      type: "session_meta",
      payload: {
        id: nativeId,
        cwd: f.workspace,
        source: "exec",
        originator: "agentkib",
        thread_source: "exec",
        history_mode: "legacy",
        ...(kind === "oversized" ? { padding: "x".repeat(256 * 1024) } : {}),
      },
    });
    f.add(nativeId, {
      source: "exec",
      contents: (kind === "body-only" ? "{}\n" : "") + header + "\n",
    });
    expect(f.reader.list(f.workspace).sessions[0].session.origin).toBe("execution");
  });

  it("accepts equivalent absolute paths for the same indexed import", () => {
    const f = fixture();
    f.add(nativeId, {
      source: "exec",
      payload: {
        source: "exec",
        originator: "agentkib",
        thread_source: "exec",
        history_mode: "legacy",
        cwd: f.workspace + path.sep,
      },
    });
    expect(f.reader.list(f.workspace).sessions[0].session.origin).toBe("interactive");
  });
});

describe("Codex indexed identity verification", () => {
  it("reuses the narrow ID scan and rechecks rollout proofs across WAL updates", () => {
    const f = fixture(true, true);
    const writer = new DatabaseSync(f.file);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("SELECT id FROM threads LIMIT 1").get();
    const queries = vi.spyOn(Sql.prototype, "rows");
    try {
      const mixedCase = "aaaAAAAA-BBbB-4ccc-8ddd-eeeeeeeeeeee";
      f.add(nativeId);
      f.add(otherId);
      const listed = () => f.reader.list(null, { nativeRefs: [nativeId.toUpperCase()] }).sessions;
      const verified = () => f.reader.verifiedIndexedIdentities([nativeId]);
      expect(listed().map(({ session }) => session.native_ref)).toEqual([nativeId]);
      expect(verified().has(nativeId)).toBe(true);

      const idScans = () =>
        queries.mock.calls.filter(([sql]) => sql.startsWith("SELECT id FROM threads "));
      expect(idScans()).toHaveLength(process.platform === "win32" ? 2 : 1);
      expect(
        queries.mock.calls.filter(([sql]) => sql.includes("FROM threads WHERE id COLLATE BINARY")),
      ).toHaveLength(2);

      const variant = f.add(mixedCase, {
        transcript: path.join(f.codexHome, "mixed-case.jsonl"),
        payload: { id: otherId },
      });
      expect(verified().size).toBe(0);
      expect(listed().map(({ session }) => session.native_ref)).toEqual([mixedCase, nativeId]);
      expect(idScans()).toHaveLength(process.platform === "win32" ? 4 : 2);

      writeFileSync(
        variant,
        JSON.stringify({
          type: "session_meta",
          payload: { id: mixedCase, cwd: f.workspace, source: "cli" },
        }) + "\n",
      );
      expect(verified().has(nativeId)).toBe(true);
      expect(idScans()).toHaveLength(process.platform === "win32" ? 5 : 2);

      writer.prepare("DELETE FROM threads WHERE id=?").run(nativeId);
      expect(listed().map(({ session }) => session.native_ref)).toEqual([mixedCase]);
    } finally {
      queries.mockRestore();
      writer.close();
    }
  });

  it("discards retained IDs and metadata when the native database is replaced", () => {
    const f = fixture(true, true);
    const transcript = f.add(nativeId);
    expect(f.reader.verifiedIndexedIdentities([nativeId]).has(nativeId)).toBe(true);
    const nextFile = path.join(f.codexHome, "replacement.sqlite");
    const next = new DatabaseSync(nextFile);
    try {
      next.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,cwd TEXT)");
      next
        .prepare("INSERT INTO threads VALUES(?,?,?)")
        .run(nativeId.toUpperCase(), transcript, f.workspace);
    } finally {
      next.close();
    }
    renameSync(f.file, `${f.file}.old`);
    renameSync(nextFile, f.file);

    expect(f.reader.verifiedIndexedIdentities([nativeId]).has(nativeId)).toBe(true);
    expect(
      f.reader
        .list(null, { nativeRefs: [nativeId] })
        .sessions.map(({ session }) => session.native_ref),
    ).toEqual([nativeId.toUpperCase()]);
  });

  it.skipIf(process.platform === "win32")(
    "resolves relative rollout paths from the canonical home when supplied",
    () => {
      const f = fixture(true, true);
      const alternateParent = path.join(f.root, "alternate");
      const alternateHome = path.join(alternateParent, "codex");
      mkdirSync(alternateParent);
      symlinkSync(f.codexHome, alternateHome);
      f.add(nativeId, { transcript: path.join(f.home, "relative-rollout.jsonl") });
      const reader = new CodexSessions({ CODEX_HOME: alternateHome }, { retainDatabase: true });
      readers.push(reader);

      expect(reader.verifiedIndexedIdentities([nativeId]).size).toBe(0);
      expect(reader.verifiedIndexedIdentities([nativeId], f.codexHome).has(nativeId)).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "reopens the native database when WAL sidecars are recreated",
    () => {
      const f = fixture(true, true);
      f.add(nativeId);
      const writer = new DatabaseSync(f.file);
      writer.exec("PRAGMA journal_mode=WAL");
      writer.close();
      expect(f.reader.verifiedIndexedIdentities([nativeId]).has(nativeId)).toBe(true);

      for (const suffix of ["-wal", "-shm"])
        renameSync(`${f.file}${suffix}`, `${f.file}${suffix}.old`);
      const queries = vi.spyOn(Sql.prototype, "rows");
      try {
        expect(f.reader.verifiedIndexedIdentities([nativeId]).has(nativeId)).toBe(true);
        expect(queries.mock.calls.some(([sql]) => sql.startsWith("SELECT id FROM threads "))).toBe(
          true,
        );
      } finally {
        queries.mockRestore();
      }
    },
  );

  it("keeps the raw ID candidates for each workspace when querying several indexed scopes", () => {
    const f = fixture(true, true);
    const otherWorkspace = path.join(f.root, "other-workspace");
    mkdirSync(otherWorkspace);
    const transcript = f.add(nativeId);
    additionalIndex(f, nativeId, otherWorkspace);

    expect(
      f.reader
        .list(null, { nativeRefs: [nativeId], matchesScope: () => true })
        .sessions.map(({ cwd }) => cwd),
    ).toEqual([f.workspace, otherWorkspace]);
    expect(f.reader.list(null, { nativeRefs: [nativeId] }).sessions.map(({ cwd }) => cwd)).toEqual([
      otherWorkspace,
    ]);
    expect(f.reader.list(f.workspace, { nativeRefs: [nativeId] }).sessions).toMatchObject([
      { cwd: f.workspace, transcript },
    ]);
    vi.mocked(openSync).mockClear();
    expect(
      f.reader.list(null, {
        nativeRefs: [nativeId],
        matchesScope: (_id, cwd) => cwd === f.workspace,
      }).sessions,
    ).toMatchObject([{ cwd: f.workspace, transcript }]);
    expect(new Set(vi.mocked(openSync).mock.calls.map(([file]) => file))).toEqual(
      new Set([transcript]),
    );
    expect(f.reader.verifiedIndexedIdentities([nativeId]).size).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "bounds retained ID maps and falls back to a narrow index scan for a large database",
    () => {
      const f = fixture(true, true);
      const transcript = f.add(nativeId.toUpperCase());
      const writer = new DatabaseSync(f.file);
      try {
        writer.exec(`WITH RECURSIVE ids(n) AS (
          VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n<20000
        )
        INSERT INTO threads(id) SELECT printf('%08x-aaaa-bbbb-cccc-%012x',n,n) FROM ids`);
      } finally {
        writer.close();
      }
      const queries = vi.spyOn(Sql.prototype, "rows");
      try {
        expect(f.reader.verifiedIndexedIdentities([nativeId]).has(nativeId)).toBe(true);
        expect(f.reader.list(null, { nativeRefs: [nativeId] }).sessions).toMatchObject([
          { transcript, session: { native_ref: nativeId.toUpperCase() } },
        ]);
        const sql = queries.mock.calls.map(([statement]) => statement);
        expect(
          sql.filter((statement) => statement.startsWith("SELECT id FROM threads WHERE length")),
        ).toHaveLength(1);
        expect(
          sql.filter((statement) =>
            statement.startsWith("SELECT id FROM threads WHERE id COLLATE NOCASE"),
          ),
        ).toHaveLength(2);
      } finally {
        queries.mockRestore();
      }
    },
  );

  it.each(["lower", "upper"])(
    "does not borrow another case variant's valid header when the %s variant is invalid",
    (invalidCase) => {
      const f = fixture();
      const invalid = invalidCase === "lower" ? nativeId : nativeId.toUpperCase(),
        valid = invalidCase === "lower" ? nativeId.toUpperCase() : nativeId;
      f.add(invalid, {
        transcript: path.join(f.codexHome, "invalid-header.jsonl"),
        payload: { id: otherId },
      });
      f.add(valid, { transcript: path.join(f.codexHome, "valid-header.jsonl") });
      for (const refs of [[invalid], [valid], [invalid, valid]])
        expect(f.reader.verifiedIndexedIdentities(refs).size).toBe(0);
      // Control lookup keeps its prior case-sensitive database query and ID-only proof.
      expect(f.reader.verifiedControlIds([nativeId])).toEqual(
        new Set(invalidCase === "lower" ? [] : [nativeId]),
      );
    },
  );

  it.each([true, false])(
    "does not stop before an invalid UUID variant in another database (first valid: %s)",
    (firstValid) => {
      const f = fixture();
      f.add(nativeId, { payload: { id: firstValid ? nativeId : otherId } });
      additionalIndex(f, nativeId.toUpperCase(), f.workspace, {
        id: firstValid ? otherId : nativeId,
      });
      for (const refs of [[nativeId], [nativeId.toUpperCase()], [nativeId, nativeId.toUpperCase()]])
        expect(f.reader.verifiedIndexedIdentities(refs).size).toBe(0);
      expect(f.reader.verifiedControlIds([nativeId])).toEqual(
        new Set(firstValid ? [nativeId] : []),
      );
    },
  );

  it.each(["same-database", "different-database"])(
    "rejects valid UUID variants whose indexed/header cwds conflict in %s",
    (location) => {
      const f = fixture();
      const otherWorkspace = path.join(f.root, "other-workspace");
      mkdirSync(otherWorkspace);
      f.add(nativeId, { transcript: path.join(f.codexHome, "first-workspace.jsonl") });
      if (location === "same-database")
        f.add(nativeId.toUpperCase(), {
          transcript: path.join(f.codexHome, "other-workspace.jsonl"),
          cwd: otherWorkspace,
        });
      else additionalIndex(f, nativeId.toUpperCase(), otherWorkspace);
      expect(f.reader.verifiedIndexedIdentities([nativeId]).size).toBe(0);
      expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set([nativeId]));
    },
  );

  it.each(["cwd", "rollout_path"] as const)(
    "does not borrow proof across an indexed row missing %s",
    (column) => {
      const f = fixture();
      f.add(nativeId);
      additionalIndex(f, nativeId.toUpperCase(), f.workspace, {}, column);
      expect(f.reader.verifiedIndexedIdentities([nativeId]).size).toBe(0);
      expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set([nativeId]));
    },
  );

  it("preserves consistent UUID variants across databases", () => {
    const f = fixture();
    f.add(nativeId);
    additionalIndex(f, nativeId.toUpperCase(), f.workspace + path.sep);
    const verified = f.reader.verifiedIndexedIdentities([nativeId, nativeId.toUpperCase()]);
    expect(verified.size).toBe(1);
    expect(verified.get(nativeId)?.id).toBe(nativeId);
    expect(verified.get(nativeId)?.cwd.replace(/[/\\]+$/, "")).toBe(f.workspace);
    expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set([nativeId]));
  });

  it.each([64 * 1024, 64 * 1024 + 1])(
    "bounds native identity headers at %i total bytes",
    (size) => {
      const f = fixture();
      const payload = { id: nativeId, cwd: f.workspace, source: "exec", padding: "" };
      const empty = JSON.stringify({ type: "session_meta", payload }) + "\n";
      payload.padding = "x".repeat(size - Buffer.byteLength(empty));
      const contents = JSON.stringify({ type: "session_meta", payload }) + "\n";
      expect(Buffer.byteLength(contents)).toBe(size);
      f.add(nativeId, { source: "exec", contents });
      expect(f.reader.verifiedIndexedIdentities([nativeId]).size).toBe(size === 64 * 1024 ? 1 : 0);
      expect(f.reader.verifiedControlIds([nativeId]).size).toBe(size === 64 * 1024 ? 1 : 0);
    },
  );

  it("keeps control verification available for database schemas without cwd", () => {
    const f = fixture();
    const transcript = f.add(nativeId);
    const db = new DatabaseSync(f.file);
    try {
      db.exec("DROP TABLE threads; CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
      db.prepare("INSERT INTO threads VALUES (?,?)").run(nativeId, transcript);
    } finally {
      db.close();
    }
    expect(f.reader.verifiedIndexedIdentities([nativeId]).size).toBe(0);
    expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set([nativeId]));
  });

  it.each([
    "valid",
    "missing-id",
    "wrong-id",
    "invalid-id",
    "missing-cwd",
    "wrong-cwd",
    "relative-cwd",
    "oversized",
    "body-only",
    "invalid-utf8",
  ])("verifies UUID and cwd without changing control ID checks: %s", (kind) => {
    const f = fixture();
    const payload: Record<string, unknown> = {
      id: nativeId.toUpperCase(),
      cwd: f.workspace,
      source: "exec",
    };
    if (kind === "missing-id") delete payload.id;
    if (kind === "wrong-id") payload.id = otherId;
    if (kind === "invalid-id") payload.id = "not-a-uuid";
    if (kind === "missing-cwd") delete payload.cwd;
    if (kind === "wrong-cwd") payload.cwd = path.join(f.root, "other");
    if (kind === "relative-cwd") payload.cwd = "workspace";
    if (kind === "oversized") payload.padding = "x".repeat(64 * 1024);
    const transcript = f.add(nativeId, {
      source: "exec",
      contents:
        (kind === "body-only" ? "{}\n" : "") +
        JSON.stringify({ type: "session_meta", payload }) +
        "\n",
    });
    if (kind === "invalid-utf8") writeFileSync(transcript, Buffer.from([0xff, 0x0a]));
    const identities = f.reader.verifiedIndexedIdentities([nativeId.toUpperCase(), "not-a-uuid"]);
    expect([...identities]).toEqual(
      kind === "valid" ? [[nativeId, { id: nativeId, cwd: f.workspace }]] : [],
    );
    const control = f.reader.verifiedControlIds([nativeId]);
    expect([...control]).toEqual(
      ["valid", "missing-cwd", "wrong-cwd", "relative-cwd"].includes(kind) ? [nativeId] : [],
    );
  });

  it("canonicalizes UUID case in indexed rows and equivalent absolute cwd", () => {
    const f = fixture();
    f.add(nativeId.toUpperCase(), { payload: { id: nativeId, cwd: f.workspace + path.sep } });
    expect(f.reader.verifiedIndexedIdentities([nativeId])).toEqual(
      new Map([[nativeId, { id: nativeId, cwd: f.workspace + path.sep }]]),
    );
  });

  it("does not verify an identity when the indexed cwd is relative", () => {
    const f = fixture();
    f.add(nativeId, { cwd: "workspace", payload: { cwd: f.workspace } });
    expect(f.reader.verifiedIndexedIdentities([nativeId]).size).toBe(0);
    expect(f.reader.verifiedControlIds([nativeId])).toEqual(new Set([nativeId]));
  });

  it("queries multiple candidate batches and preserves current-database precedence", () => {
    const f = fixture();
    const expected = new Map<string, { id: string; cwd: string }>();
    for (let index = 0; index < 501; index++) {
      const id = `aaaaaaaa-bbbb-4ccc-8ddd-${index.toString(16).padStart(12, "0")}`;
      f.add(id);
      expected.set(id, { id, cwd: f.workspace });
    }
    const legacy = path.join(f.codexHome, "sqlite");
    mkdirSync(legacy);
    const db = new DatabaseSync(path.join(legacy, "state_0.sqlite"));
    db.exec("CREATE TABLE threads(id TEXT,rollout_path TEXT,cwd TEXT)");
    db.prepare("INSERT INTO threads VALUES(?,?,?)").run(otherId, `${nativeId}.jsonl`, f.workspace);
    db.close();
    expect(f.reader.verifiedIndexedIdentities([...expected.keys(), otherId])).toEqual(expected);
    expect(f.reader.verifiedControlIds(expected.keys())).toEqual(new Set(expected.keys()));
  });

  it.each(["missing", "directory", ...(process.platform === "win32" ? [] : ["symlink", "fifo"])])(
    "never opens nonregular %s native transcripts",
    (kind) => {
      const f = fixture();
      const transcript = path.join(f.codexHome, "nonregular.jsonl");
      if (kind === "directory") mkdirSync(transcript);
      if (kind === "symlink") {
        const target = path.join(f.codexHome, "regular.jsonl");
        writeFileSync(
          target,
          JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: f.workspace } }) +
            "\n",
        );
        symlinkSync(target, transcript);
      }
      if (kind === "fifo") expect(spawnSync("mkfifo", [transcript]).status).toBe(0);
      f.add(nativeId, { source: "exec", transcript, write: false });
      const originalOpen = vi.mocked(openSync).getMockImplementation()!;
      vi.mocked(openSync)
        .mockClear()
        .mockImplementation(() => {
          throw new Error("Nonregular transcript must not be opened");
        });
      try {
        expect(f.reader.list(f.workspace).sessions[0].session).toMatchObject({
          origin: "execution",
          availability: "metadata-only",
        });
        expect(f.reader.verifiedIndexedIdentities([nativeId]).size).toBe(0);
        expect(f.reader.verifiedControlIds([nativeId]).size).toBe(0);
        expect(openSync).not.toHaveBeenCalled();
      } finally {
        vi.mocked(openSync).mockImplementation(originalOpen);
      }
    },
  );
});

describe("Codex workspace-less collections", () => {
  it("retains explicit projectless and unclassified ownership while classifying exec", () => {
    const f = fixture();
    writeFileSync(
      path.join(f.codexHome, ".codex-global-state.json"),
      JSON.stringify({
        "projectless-thread-ids": ["projectless"],
        "thread-project-assignments": { assigned: "project" },
        "thread-projectless-output-directories": { output: f.workspace },
      }),
    );
    f.add("projectless", { source: "exec" });
    f.add("output", { payload: { source: "exec" } });
    f.add("unclassified", { cwd: f.home, source: "exec" });
    f.add("assigned", { source: "cli" });
    f.add("normal", { source: "vscode" });
    f.add("project-column", { source: "cli", project: "project" });
    const sessions = f.reader.list(null).sessions;
    expect(
      sessions
        .filter((value) => value.collection === "projectless")
        .map((value) => [value.session.native_ref, value.session.origin]),
    ).toEqual([
      ["output", "execution"],
      ["projectless", "execution"],
    ]);
    expect(sessions.find((value) => value.session.native_ref === "unclassified")).toMatchObject({
      collection: "unclassified",
      session: { origin: "execution" },
    });
    expect(f.reader.list(f.workspace).sessions.map((value) => value.session.native_ref)).toEqual([
      "assigned",
      "normal",
      "project-column",
    ]);
    expect(
      f.reader
        .list(null, { collection: "projectless" })
        .sessions.map((value) => value.session.native_ref),
    ).toEqual(["output", "projectless"]);
    expect(
      f.reader.list(null, { collection: "unclassified", matches: (id) => id === "unclassified" })
        .sessions,
    ).toHaveLength(1);
  });
});
