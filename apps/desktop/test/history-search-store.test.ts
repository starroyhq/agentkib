import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HistorySearchStore,
  contentHash,
  matchRanges,
  textChunks,
  type SearchRecord,
  type SearchSession,
} from "../../../packages/backend/src/history-search-store";

const roots: string[] = [];
const stores: HistorySearchStore[] = [];
afterEach(() => {
  for (const db of stores.splice(0).reverse()) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(limit?: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-index-"));
  roots.push(root);
  const db = new HistorySearchStore(path.join(root, "search.sqlite"), true, limit);
  stores.push(db);
  return db;
}
function session(
  id: string,
  workspaceId = "w1",
  updatedAt = "2026-10-08T00:00:00Z",
): SearchSession {
  return {
    sessionId: id,
    workspaceId,
    agent: "claude-code",
    title: id,
    updatedAt,
    archived: false,
    ownerKey: "owner-" + id,
  };
}
function record(
  id: string,
  ordinal: number,
  content: string,
  kind: SearchRecord["kind"] = "user",
): SearchRecord {
  return {
    recordId: id,
    ordinal,
    content,
    kind,
    timestamp: null,
    toolName: kind.startsWith("tool") ? "read" : null,
  };
}
function publish(
  db: HistorySearchStore,
  s: SearchSession,
  records: SearchRecord[],
  revision = "rev-1",
) {
  const generation = db.begin(s);
  for (const r of records) db.append(s.sessionId, generation, r, () => {});
  db.finish(s.sessionId, generation, revision, "ready", []);
  return generation;
}
describe("committed history content cache", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    it.skipIf(process.platform === "win32")(
      `rejects a dangling ${suffix || "database"} link before SQLite creates files`,
      () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "history-cache-link-"));
        roots.push(root);
        const filename = path.join(root, "cache", "search.sqlite");
        const outside = path.join(root, "outside.sqlite");
        mkdirSync(path.dirname(filename));
        symlinkSync(outside, filename + suffix);
        expect(existsSync(filename + suffix)).toBe(false);
        for (const writable of [false, true])
          expect(() => new HistorySearchStore(filename, writable)).toThrow(
            "Unsafe content search cache",
          );
        expect(existsSync(outside)).toBe(false);
        expect(lstatSync(filename + suffix).isSymbolicLink()).toBe(true);
        if (suffix) expect(existsSync(filename)).toBe(false);
      },
    );
  }
  it("reuses a source revision only for committed content with matching ownership and metadata", () => {
    const db = fixture(),
      original = session("a");
    publish(db, original, [record("r", 0, "body")]);
    expect(db.cachedSourceRevision(original)).toBe("rev-1");
    for (const change of [
      { workspaceId: "w2" },
      { ownerKey: "different" },
      { agent: "codex" },
      { title: "changed" },
      { updatedAt: "2026-10-09T00:00:00Z" },
      { archived: true },
    ])
      expect(db.cachedSourceRevision({ ...original, ...change })).toBeUndefined();
    const stage = db.begin(original);
    expect(db.cachedSourceRevision(original)).toBeUndefined();
    db.abort("a", stage, false);
    expect(db.cachedSourceRevision(original)).toBeUndefined();
  });
  it("finds literal Unicode, paths, code, quotes, and repeated records without evaluating FTS expressions", () => {
    const db = fixture();
    publish(db, session("a"), [
      record("one", 0, '大小写中文🙂 /src/app.ts $foo::bar OR "quoted" İ X'),
      record("two", 1, '大小写中文🙂 /src/app.ts $foo::bar OR "quoted" İ X'),
      record("tool", 2, "tool-only sentinel", "tool-output"),
    ]);
    for (const query of ["中文", "文🙂", "/SRC/APP.TS", "$foo::bar", '"quoted"', " OR ", "i̇", "X"])
      expect(db.query({ query }, ["a"], () => {}).hits.map((h) => h.location.recordId)).toEqual([
        "two",
        "one",
      ]);
    expect(db.query({ query: "one OR two" }, ["a"], () => {}).hits).toHaveLength(0);
    const tool = db.query({ query: "sentinel", kinds: ["tool-output"] }, ["a"], () => {}).hits[0]!;
    expect(db.locate(tool.location, ["a"])).toMatchObject({
      kind: "tool-output",
      toolName: "read",
      content: "tool-only sentinel",
    });
    expect(matchRanges("İ🙂Z", "i̇")).toEqual([[0, 1]]);
  });
  it.each([
    ["ΟΣ", "Σ", [1, 2]],
    ["ΟΣΑ", "ΟΣ", [0, 2]],
    ["ΚΟΣΜΟΣ", "ΚΟΣ", [0, 3]],
    ["ΚΟΣΜΟΣ", "κος", [0, 3]],
    ["x𐐀İΣz", "𐐨i̇σ", [1, 5]],
  ] as const)("searches %s for %s with original UTF-16 highlights", (content, query, range) => {
    const db = fixture();
    publish(db, session("unicode"), [record("text", 0, content)]);
    expect(matchRanges(content, query)).toEqual([range]);
    const hits = db.query({ query }, ["unicode"], () => {}).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ snippet: content, matchRanges: [range] });
    expect(db.locate(hits[0]!.location, ["unicode"]).content).toBe(content);
  });
  it("preserves existing lowercase distinctions and maps repeated sigma variants to original spans", () => {
    expect(matchRanges("ı", "I")).toEqual([]);
    expect(matchRanges("ſ", "s")).toEqual([]);
    expect(matchRanges("ß", "SS")).toEqual([]);
    expect(matchRanges("İ", "i̇")).toEqual([[0, 1]]);
    expect(matchRanges("Σςσ İ🙂Σ", "σ")).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [7, 8],
    ]);
  });
  it("covers a maximum-length query whose case variants expand across a chunk boundary", () => {
    const db = fixture(),
      query = "İ".repeat(256),
      content = "x".repeat(7800) + "i̇".repeat(256) + "z".repeat(200);
    publish(db, session("expanded"), [record("text", 0, content)]);
    const hits = db.query({ query }, ["expanded"], () => {}).hits;
    expect(hits).toHaveLength(1);
    expect(db.locate(hits[0]!.location, ["expanded"]).content).toContain("i̇".repeat(256));
  });
  it("covers boundary matches in long text, deduplicates chunks, and paginates original records", () => {
    const db = fixture(),
      needle = "界🙂".repeat(100);
    const text = "a".repeat(8100) + needle + "b".repeat(300_000) + needle;
    publish(db, session("a"), [record("old", 0, text), record("new", 1, text)]);
    const first = db.query({ query: needle, limit: 1 }, ["a"], () => {});
    expect(first.hits).toHaveLength(1);
    expect(first.hits[0]!.location.recordId).toBe("new");
    const second = db.query(
      { query: needle, limit: 1, cursor: first.nextCursor! },
      ["a"],
      () => {},
    );
    expect(second.hits.map((hit) => hit.location.recordId)).toEqual(["old"]);
    expect(db.locate(first.hits[0]!.location, ["a"]).content).toContain(needle);
    expect([...textChunks(text)].every((chunk) => chunk.content.length <= 8192)).toBe(true);
  });
  it("preserves NUL-containing content and metadata across queries, locations and cache reopening", () => {
    const writer = fixture(),
      original = { ...session("nul"), title: "Title\0after-title" };
    const content = "before\0AFTER_NUL_TOKEN🙂\0ending",
      toolName = "read\0after-tool";
    publish(writer, original, [{ ...record("nul-record", 0, content, "tool-output"), toolName }]);
    const reader = new HistorySearchStore(writer.filename, false);
    stores.push(reader);
    for (const db of [writer, reader]) {
      expect(db.cachedSourceRevision(original)).toBe("rev-1");
      expect(db.status([original.sessionId]).bytes).toBe(Buffer.byteLength(content));
      for (const query of ["NU", "NUL_TOKEN", "\0AFTER", "before\0A", "🙂\0e"]) {
        const result = db.query({ query }, [original.sessionId], () => {});
        expect(result.hits).toHaveLength(1);
        const hit = result.hits[0]!;
        expect(hit).toMatchObject({ title: original.title, toolName, snippet: content });
        const start = content.toLowerCase().indexOf(query.toLowerCase());
        expect(hit.matchRanges).toEqual([[start, start + query.length]]);
        expect(db.locate(hit.location, [original.sessionId])).toMatchObject({
          content,
          contentHash: contentHash(content),
          title: original.title,
          toolName,
        });
      }
    }
    for (const db of [reader, writer]) {
      db.close();
      stores.splice(stores.indexOf(db), 1);
    }
    const reopened = new HistorySearchStore(writer.filename, true);
    stores.push(reopened);
    const hit = reopened.query({ query: "NUL_TOKEN" }, [original.sessionId], () => {}).hits[0]!;
    expect(hit).toBeDefined();
    expect(reopened.locate(hit.location, [original.sessionId]).content).toBe(content);
    expect(reopened.cachedSourceRevision(original)).toBe("rev-1");
  });
  it("filters authorization before hits, coverage, bytes and cursors; owner changes immediately hide old data", () => {
    const db = fixture();
    publish(db, session("a"), [record("r", 0, "public token")]);
    const before = db.status(["a"]);
    publish(db, session("secret", "w2"), [record("r", 0, "private token".repeat(1000))]);
    expect(db.status(["a"]).bytes).toBe(before.bytes);
    expect(db.status(["a"]).coverage.total).toBe(1);
    expect(db.status(["a"]).generation).toBe(before.generation);
    expect(
      db.query({ query: "token" }, ["a"], () => {}).hits.map((h) => h.location.sessionId),
    ).toEqual(["a"]);
    expect(db.query({ query: "token", workspaceIds: ["w2"] }, ["a"], () => {}).hits).toEqual([]);
    expect(db.authorizedOwners([{ sessionId: "a", ownerKey: "rebound" }])).toEqual([]);
    const location = db.query({ query: "private" }, ["secret"], () => {}).hits[0]!.location;
    expect(() => db.locate(location, ["a"])).toThrow("unavailable");
  });
  it("reports complete Cursor text separately from unsupported tools, including an existing cache", () => {
    const writer = fixture();
    const source = { ...session("cursor-complete"), agent: "cursor" };
    const stage = writer.begin(source);
    writer.append(source.sessionId, stage, record("text", 0, "complete cursor marker"), () => {});
    writer.finish(source.sessionId, stage, "cursor-revision", "partial", [
      "cursor-tools-unsupported",
    ]);
    const reader = new HistorySearchStore(writer.filename, false);
    stores.push(reader);
    for (const db of [writer, reader]) {
      const result = db.query({ query: "cursor marker" }, [source.sessionId], () => {});
      expect(result.hits).toHaveLength(1);
      expect(db.locate(result.hits[0]!.location, [source.sessionId]).content).toBe(
        "complete cursor marker",
      );
      expect(result.status.sources).toMatchObject([
        { agent: "cursor", body: "supported", tools: "unsupported" },
      ]);
      // The whole source is still partial because tool history is unsupported.
      expect(result.status.coverage).toMatchObject({ total: 1, ready: 0, partial: 1 });
    }
  });
  it("includes unvisited sessions in their agent coverage in status and search responses", () => {
    const db = fixture();
    const owners = ["ready", "pending"].map((id) => ({ ...session(id), agent: "codex" }));
    publish(db, owners[0]!, [record("text", 0, "indexed marker")]);
    const allowed = db.authorizedOwners(owners);
    const expected = {
      coverage: { total: 2, ready: 1, building: 1 },
      sources: [
        {
          agent: "codex",
          body: "partial",
          tools: "partial",
          coverage: { total: 2, ready: 1, building: 1 },
        },
      ],
    };
    expect(db.status(allowed, owners)).toMatchObject(expected);
    const result = db.query({ query: "marker" }, allowed, () => {}, owners);
    expect(result.status).toMatchObject(expected);
    expect(result.hits.map((hit) => hit.location.sessionId)).toEqual(["ready"]);
  });
  it("reports all authorized agents before their first index row exists", () => {
    const db = fixture();
    const owners = [
      "claude-code",
      "codex",
      "opencode",
      "hermes",
      "grok-build",
      "cursor",
      "antigravity",
      "open-claw",
    ].map((agent) => ({ ...session(agent), agent }));
    const allowed = db.authorizedOwners(owners);
    const status = db.status(allowed, owners);
    expect(status.coverage).toMatchObject({ total: 8, building: 8, ready: 0 });
    expect(status.sources).toHaveLength(8);
    for (const owner of owners)
      expect(status.sources).toContainEqual({
        agent: owner.agent,
        body: "unavailable",
        tools: owner.agent === "cursor" ? "unsupported" : "unavailable",
        coverage: {
          total: 1,
          ready: 0,
          building: 1,
          partial: 0,
          stale: 0,
          unavailable: 0,
          limitations: [],
        },
      });
  });
  it("does not double count pending metadata or include sources outside the authorized scope", () => {
    const db = fixture();
    const ready = { ...session("ready"), agent: "cursor" };
    const pending = { ...session("pending"), agent: "cursor" };
    const foreign = { ...session("foreign", "other-workspace"), agent: "hermes" };
    const revoked = { ...session("revoked"), agent: "codex" };
    const stage = db.begin(ready);
    db.append(ready.sessionId, stage, record("body", 0, "complete body"), () => {});
    db.finish(ready.sessionId, stage, "revision", "partial", ["cursor-tools-unsupported"]);
    publish(db, revoked, [record("secret", 0, "foreign marker")]);
    const owners = [ready, pending, pending, foreign, { ...revoked, ownerKey: "new-owner" }];
    const allowed = db.authorizedOwners(owners.filter((owner) => owner !== foreign));
    const before = db.status(allowed, owners);
    expect(before.coverage).toMatchObject({ total: 2, partial: 1, building: 1 });
    expect(before.sources).toMatchObject([
      { agent: "cursor", body: "partial", tools: "unsupported", coverage: { total: 2 } },
    ]);
    expect(db.status([], owners).sources).toEqual([]);
    const next = db.begin(pending);
    expect(db.status(allowed, owners).coverage).toMatchObject({ total: 2, building: 1 });
    db.append(pending.sessionId, next, record("new", 0, "new complete body"), () => {});
    db.finish(pending.sessionId, next, "revision-2", "partial", ["cursor-tools-unsupported"]);
    expect(db.status(allowed, owners)).toMatchObject({
      coverage: { total: 2, partial: 2, building: 0 },
      sources: [
        {
          agent: "cursor",
          body: "supported",
          tools: "unsupported",
          coverage: { total: 2, partial: 2, building: 0 },
        },
      ],
    });
  });
  it.each(["damaged-record", "source-record-limit", "source-byte-limit", "unknown-limit"])(
    "does not promote Cursor text affected by %s or leak another source's coverage",
    (limitation) => {
      const db = fixture();
      for (const [id, limitations] of [
        ["complete", ["cursor-tools-unsupported"]],
        ["partial", ["cursor-tools-unsupported", limitation]],
      ] as const) {
        const source = { ...session(id, id), agent: "cursor" };
        const stage = db.begin(source);
        db.append(id, stage, record("text", 0, "readable marker"), () => {});
        db.finish(id, stage, `revision-${id}`, "partial", [...limitations]);
      }
      expect(db.status(["complete"]).sources).toMatchObject([
        { body: "supported", tools: "unsupported", coverage: { total: 1 } },
      ]);
      for (const allowed of [["partial"], ["complete", "partial"]])
        expect(db.status(allowed).sources).toMatchObject([
          { body: "partial", tools: "unsupported", coverage: { total: allowed.length } },
        ]);
    },
  );
  it.each([
    ["grok-build", "unsupported-tool-record", "supported", "partial"],
    ["claude-code", "damaged-tool-input", "supported", "partial"],
    ["codex", "damaged-tool-output", "supported", "partial"],
    ["antigravity", "unsupported-tool-content", "supported", "partial"],
    ["antigravity", "unsupported-text-content", "partial", "supported"],
    ["claude-code", "damaged-text-block", "partial", "supported"],
    ["hermes", "unsupported-message-content", "partial", "partial"],
    ["grok-build", "unsupported-content-block", "partial", "partial"],
    ["codex", "cursor-tools-unsupported", "partial", "partial"],
  ])("separates %s coverage for %s", (agent, limitation, body, tools) => {
    const db = fixture();
    const source = { ...session("source"), agent };
    const stage = db.begin(source);
    db.append(source.sessionId, stage, record("text", 0, "readable body"), () => {});
    db.finish(source.sessionId, stage, "revision", "partial", [limitation]);
    expect(db.status([source.sessionId]).sources).toMatchObject([{ body, tools }]);
  });
  it("retains pending, stale and revoked Cursor coverage instead of certifying its cached text", () => {
    const db = fixture();
    const source = { ...session("cursor"), agent: "cursor" };
    let stage = db.begin(source);
    db.append(source.sessionId, stage, record("text", 0, "cached marker"), () => {});
    db.finish(source.sessionId, stage, "revision", "partial", ["cursor-tools-unsupported"]);
    expect(db.status([source.sessionId]).sources).toMatchObject([{ body: "supported" }]);
    stage = db.begin(source);
    expect(db.status([source.sessionId]).sources).toMatchObject([
      { body: "unavailable", tools: "unsupported", coverage: { building: 1 } },
    ]);
    db.abort(source.sessionId, stage, false);
    expect(db.status([source.sessionId]).sources).toMatchObject([
      { body: "partial", tools: "unsupported", coverage: { stale: 1 } },
    ]);
    db.abort(source.sessionId, db.begin(source), false, { ownerChanged: true });
    expect(db.status([source.sessionId]).sources).toMatchObject([
      { body: "unavailable", tools: "unsupported", coverage: { unavailable: 1 } },
    ]);
    expect(db.query({ query: "marker" }, [source.sessionId], () => {}).hits).toEqual([]);
  });
  it("publishes complete generations atomically to the query connection; failure preserves stale previous content", () => {
    const writer = fixture();
    publish(writer, session("a"), [record("r", 0, "first body")]);
    const reader = new HistorySearchStore(writer.filename, false);
    stores.push(reader);
    const old = reader.query({ query: "first" }, ["a"], () => {}).hits[0]!.location;
    const stage = writer.begin(session("a"));
    writer.append("a", stage, record("r", 0, "second body"), () => {});
    expect(reader.query({ query: "second" }, ["a"], () => {}).hits).toHaveLength(0);
    expect(reader.query({ query: "first" }, ["a"], () => {}).hits).toHaveLength(1);
    writer.abort("a", stage, false);
    expect(reader.status(["a"]).coverage.stale).toBe(1);
    publish(writer, session("a"), [record("r", 0, "third body")], "rev-3");
    expect(reader.query({ query: "third" }, ["a"], () => {}).hits).toHaveLength(1);
    expect(() => reader.locate(old, ["a"])).toThrow("stale");
  });
  it("rejects oversized queries and stale/forged pagination rather than mislocating messages", () => {
    const db = fixture();
    publish(db, session("a"), [record("r", 0, "test")]);
    expect(() => db.query({ query: "🙂".repeat(257) }, ["a"], () => {})).toThrow();
    const page = db.query({ query: "test", limit: 1 }, ["a"], () => {});
    expect(() =>
      db.query({ query: "different", cursor: page.nextCursor! }, ["a"], () => {}),
    ).toThrow("stale");
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString());
    decoded.after[2] = { injection: "test" };
    expect(() =>
      db.query(
        { query: "test", cursor: Buffer.from(JSON.stringify(decoded)).toString("base64url") },
        ["a"],
        () => {},
      ),
    ).toThrow("invalid");
    expect(contentHash("a")).toHaveLength(64);
  });
  it("stops cache growth at the configured budget and reports omitted histories", () => {
    const db = fixture(100_000),
      stage = db.begin(session("large"));
    expect(() =>
      db.append("large", stage, record("r", 0, "large content ".repeat(100_000)), () => {}),
    ).toThrow("budget-exceeded");
    db.abort("large", stage, true);
    expect(db.status(["large", "pending"])).toMatchObject({
      budgetExceeded: true,
      coverage: { total: 2, unavailable: 1, building: 1 },
    });
    expect(db.query({ query: "large" }, ["large"], () => {}).hits).toHaveLength(0);
  });
  it("honors cancellation during a bounded short-term scan", () => {
    const db = fixture();
    publish(
      db,
      session("a"),
      Array.from({ length: 20 }, (_, i) => record(String(i), i, "does not match")),
    );
    let inspected = 0;
    expect(() =>
      db.query({ query: "Z" }, ["a"], () => {
        if (++inspected === 3) throw new Error("cancelled");
      }),
    ).toThrow("cancelled");
    expect(inspected).toBe(3);
  });
  it("recovers only the committed generation after a writer is lost mid-ingestion", () => {
    const writer = fixture();
    publish(writer, session("a"), [record("r", 0, "committed body")]);
    const stage = writer.begin(session("a"));
    writer.append("a", stage, record("r", 0, "unfinished body"), () => {});
    writer.close();
    stores.splice(stores.indexOf(writer), 1);
    const recovered = new HistorySearchStore(writer.filename, true);
    stores.push(recovered);
    expect(recovered.status(["a"]).coverage.stale).toBe(1);
    expect(recovered.query({ query: "unfinished" }, ["a"], () => {}).hits).toHaveLength(0);
    expect(recovered.query({ query: "committed" }, ["a"], () => {}).hits).toHaveLength(1);
  });
  it.each(["sanitizer_version", "source_validation_version", "normalization_version"])(
    "rebuilds caches missing %s without exposing their old content",
    (marker) => {
      const writer = fixture();
      publish(writer, session("a"), [record("r", 0, "synthetic-obsolete-sensitive-cache")]);
      writer.db.prepare("DELETE FROM metadata WHERE key=?").run(marker);
      writer.close();
      stores.splice(stores.indexOf(writer), 1);
      expect(() => new HistorySearchStore(writer.filename, false)).toThrow("rebuild required");
      const recovered = new HistorySearchStore(writer.filename, true);
      stores.push(recovered);
      expect(recovered.query({ query: "sensitive-cache" }, ["a"], () => {}).hits).toEqual([]);
      expect(recovered.cachedSourceRevision(session("a"))).toBeUndefined();
      expect(recovered.status(["a"]).coverage).toMatchObject({ ready: 0, building: 1 });
      publish(recovered, session("a"), [record("r", 0, "new sanitized cache")], "rev-new");
      expect(recovered.query({ query: "sanitized" }, ["a"], () => {}).hits).toHaveLength(1);
    },
  );
  it.each(["1", "2", "3", "4", "5"])(
    "rebuilds source-validation v%s caches before exposing obsolete ownership or coverage",
    (version) => {
      const writer = fixture();
      publish(writer, session("a"), [record("r", 0, "obsolete-owner-sensitive-cache")]);
      writer.db
        .prepare("UPDATE metadata SET value=? WHERE key='source_validation_version'")
        .run(version);
      writer.close();
      stores.splice(stores.indexOf(writer), 1);
      expect(() => new HistorySearchStore(writer.filename, false)).toThrow("rebuild required");
      const recovered = new HistorySearchStore(writer.filename, true);
      stores.push(recovered);
      expect(recovered.query({ query: "sensitive-cache" }, ["a"], () => {}).hits).toEqual([]);
      expect(recovered.cachedSourceRevision(session("a"))).toBeUndefined();
      expect(recovered.status(["a"]).coverage).toMatchObject({ ready: 0, building: 1 });
      publish(recovered, session("a"), [record("r", 0, "revalidated body")], "rev-new");
      expect(recovered.query({ query: "revalidated" }, ["a"], () => {}).hits).toHaveLength(1);
    },
  );
  it("withdraws only the rejected owner and removes its text from the committed cache", () => {
    const db = fixture();
    publish(db, session("rejected"), [record("r", 0, "withdrawal marker")]);
    publish(db, session("retained"), [record("r", 0, "withdrawal marker")]);
    db.withdraw("rejected", "obsolete-owner");
    expect(db.query({ query: "withdrawal" }, ["rejected", "retained"], () => {}).hits).toHaveLength(
      2,
    );
    db.withdraw("rejected", "owner-rejected");
    db.withdraw("rejected", "owner-rejected");
    expect(
      db
        .query({ query: "withdrawal" }, ["rejected", "retained"], () => {})
        .hits.map((hit) => hit.location.sessionId),
    ).toEqual(["retained"]);
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE session_id='rejected'").get()!
        .count,
    ).toBe(0);
  });
  it.each(["0", "1:obsolete-unicode"])(
    "rebuilds caches with obsolete normalization %s before serving candidates",
    (version) => {
      const writer = fixture();
      publish(writer, session("a"), [record("r", 0, "ΚΟΣΜΟΣ")]);
      const old = writer.query({ query: "ΚΟΣ" }, ["a"], () => {}).hits[0]!.location;
      writer.db
        .prepare("UPDATE metadata SET value=? WHERE key='normalization_version'")
        .run(version);
      writer.close();
      stores.splice(stores.indexOf(writer), 1);
      expect(() => new HistorySearchStore(writer.filename, false)).toThrow("rebuild required");
      const recovered = new HistorySearchStore(writer.filename, true);
      stores.push(recovered);
      expect(recovered.query({ query: "ΚΟΣ" }, ["a"], () => {}).hits).toEqual([]);
      expect(() => recovered.locate(old, ["a"])).toThrow("stale");
      publish(recovered, session("a"), [record("r", 0, "ΚΟΣΜΟΣ")], "rev-rebuilt");
      expect(recovered.query({ query: "ΚΟΣ" }, ["a"], () => {}).hits).toHaveLength(1);
    },
  );
  it("withdraws both committed and staged content after a native ownership failure", () => {
    const db = fixture();
    publish(db, session("a"), [record("r", 0, "old body")]);
    publish(db, session("b"), [record("r", 0, "other safe body")]);
    const stage = db.begin(session("a"));
    db.append("a", stage, record("r", 0, "foreign body"), () => {});
    db.abort("a", stage, false, { ownerChanged: true });
    expect(db.query({ query: "body" }, ["a"], () => {}).hits).toEqual([]);
    expect(db.query({ query: "safe" }, ["b"], () => {}).hits).toHaveLength(1);
    expect(db.status(["a"]).coverage).toMatchObject({
      unavailable: 1,
      stale: 0,
      limitations: ["source-owner-changed"],
    });
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE session_id='a'").get()?.count,
    ).toBe(0);
  });
  it("persists exact OpenClaw bindings with committed content, retains stale evidence and removes revoked/pruned bindings", () => {
    const writer = fixture();
    const source = { ...session("openclaw"), agent: "open-claw" };
    const other = { ...session("other-openclaw"), agent: "open-claw" };
    const binding = {
      home: path.join(writer.filename, "home"),
      agentId: "main",
      sessionId: "native",
      cwd: path.dirname(writer.filename),
    };
    for (const entry of [source, other]) {
      const stage = writer.begin(entry);
      writer.append(entry.sessionId, stage, record("r", 0, "committed body"), () => {});
      writer.finish(entry.sessionId, stage, "rev", "ready", [], binding);
    }
    expect(writer.cachedOpenClawBinding(source)).toEqual(binding);
    expect(writer.cachedOpenClawBinding({ ...source, ownerKey: "another-owner" })).toBeUndefined();
    writer.close();
    stores.splice(stores.indexOf(writer), 1);
    const recovered = new HistorySearchStore(writer.filename, true);
    stores.push(recovered);
    expect(recovered.cachedOpenClawBinding(source)).toEqual(binding);
    recovered.abort(source.sessionId, recovered.begin(source), false);
    expect(recovered.cachedOpenClawBinding(source)).toEqual(binding);
    recovered.abort(source.sessionId, recovered.begin(source), false, { ownerChanged: true });
    expect(recovered.cachedOpenClawBinding(source)).toBeUndefined();
    expect(recovered.cachedOpenClawBinding(other)).toEqual(binding);
    recovered.prune([]);
    expect(recovered.db.prepare("SELECT count(*) AS count FROM source_bindings").get()?.count).toBe(
      0,
    );
  });
  it("discards the entire affected generation on redaction failure while retaining other sessions", () => {
    const db = fixture();
    publish(db, session("a"), [record("r", 0, "obsolete-sensitive-cache")]);
    publish(db, session("b"), [record("r", 0, "unaffected-cache")]);
    const stage = db.begin(session("a"));
    db.append("a", stage, record("new", 1, "partially parsed"), () => {});
    db.abort("a", stage, false, { unsafeContent: true });
    expect(
      db.query({ query: "cache" }, ["a", "b"], () => {}).hits.map((hit) => hit.location.sessionId),
    ).toEqual(["b"]);
    expect(db.status(["a"]).coverage).toMatchObject({
      unavailable: 1,
      stale: 0,
      limitations: ["source-redaction-failed"],
    });
    expect(
      db.db.prepare("SELECT COUNT(*) AS count FROM chunks WHERE session_id='a'").get()?.count,
    ).toBe(0);
  });

  describe("write volume", () => {
    const ids = (db: HistorySearchStore, id: string) =>
      db.db
        .prepare("SELECT id FROM chunks WHERE session_id=? ORDER BY ordinal,start")
        .all(id)
        .map((row) => Number(row.id));
    /** Counts commits by the writer, as another connection sees them. */
    function commits(db: HistorySearchStore) {
      const reader = new HistorySearchStore(db.filename, false);
      stores.push(reader);
      const version = () => Number(reader.db.prepare("PRAGMA data_version").get()!.data_version);
      let last = version();
      return () => {
        const now = version(),
          changed = now !== last;
        last = now;
        return changed;
      };
    }
    it("rewrites only the chunks that changed when a grown session is rebuilt", () => {
      const db = fixture(),
        s = session("grown");
      const turns = Array.from({ length: 40 }, (_, index) =>
        record(`r${index}`, index, `turn ${index} ${"body ".repeat(200)}`),
      );
      const generation = publish(db, s, turns);
      const before = ids(db, "grown");
      const next = publish(
        db,
        s,
        [...turns, record("r40", 40, "turn 40 appended-marker")],
        "rev-2",
      );
      const after = ids(db, "grown");
      // The forty earlier turns keep their rows; one row was written for the new turn.
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after).toHaveLength(before.length + 1);
      expect(next).not.toBe(generation);
      expect(db.cachedSourceRevision(s)).toBe("rev-2");
      expect(db.query({ query: "appended-marker" }, ["grown"], () => {}).hits).toHaveLength(1);
      expect(db.query({ query: "turn 7 " }, ["grown"], () => {}).hits).toHaveLength(1);
    });
    it("replaces an edited record and drops removed ones without touching the rest", () => {
      const db = fixture(),
        s = session("edited");
      publish(db, s, [
        record("a", 0, "first unchanged-text"),
        record("b", 1, "second before-edit"),
        record("c", 2, "third removed-text"),
      ]);
      const [first] = ids(db, "edited");
      publish(
        db,
        s,
        [record("a", 0, "first unchanged-text"), record("b", 1, "second after-edit")],
        "rev-2",
      );
      expect(ids(db, "edited")[0]).toBe(first);
      expect(ids(db, "edited")).toHaveLength(2);
      const hits = (query: string) => db.query({ query }, ["edited"], () => {}).hits.length;
      expect([hits("unchanged-text"), hits("after-edit")]).toEqual([1, 1]);
      expect([hits("before-edit"), hits("removed-text")]).toEqual([0, 0]);
    });
    it("keeps the committed chunks when a rebuild is abandoned", () => {
      const db = fixture(),
        s = session("abandoned");
      publish(db, s, [record("a", 0, "kept-original")]);
      const before = ids(db, "abandoned");
      const stage = db.begin(s);
      db.append("abandoned", stage, record("a", 0, "kept-original"), () => {});
      db.append("abandoned", stage, record("b", 1, "never-published"), () => {});
      db.abort("abandoned", stage, false);
      expect(ids(db, "abandoned")).toEqual(before);
      expect(db.query({ query: "never-published" }, ["abandoned"], () => {}).hits).toHaveLength(0);
      expect(db.query({ query: "kept-original" }, ["abandoned"], () => {}).hits).toHaveLength(1);
    });
    it("records a session that cannot be indexed once, not on every pass", () => {
      const db = fixture(),
        changed = commits(db);
      db.markUnindexed(session("broken"), "source-unavailable");
      expect(changed()).toBe(true);
      for (let pass = 0; pass < 5; pass++)
        db.markUnindexed(session("broken"), "source-unavailable");
      expect(changed()).toBe(false);
      expect(db.status(["broken"]).coverage).toMatchObject({
        unavailable: 1,
        limitations: ["source-unavailable"],
      });
      // A changed title is new information and is recorded.
      db.markUnindexed({ ...session("broken"), title: "renamed" }, "source-unavailable");
      expect(changed()).toBe(true);
    });
    it("keeps committed text searchable while its source cannot be read", () => {
      const db = fixture(),
        s = session("offline");
      publish(db, s, [record("a", 0, "offline-marker")]);
      db.markUnindexed(s, "source-unavailable");
      expect(db.cachedSourceRevision(s)).toBeUndefined();
      expect(db.status(["offline"]).coverage).toMatchObject({ stale: 1 });
      expect(db.query({ query: "offline-marker" }, ["offline"], () => {}).hits).toHaveLength(1);
    });
    it("drops older sessions to make room for a newer one and never the reverse", () => {
      const text = (name: string) => `${name} ${"filler-text ".repeat(4000)}`;
      const bytes = (db: HistorySearchStore) =>
        Number(db.db.prepare("PRAGMA page_count").get()!.page_count) *
        Number(db.db.prepare("PRAGMA page_size").get()!.page_size);
      // Sized from a real record, so that five of them do not fit and four do.
      const probe = fixture(),
        empty = bytes(probe);
      publish(probe, session("probe"), [record("r", 0, text("probe"))]);
      const db = fixture(empty + Math.round((bytes(probe) - empty) * 4.5));
      const old = session("old", "w1", "2026-10-01T00:00:00Z"),
        middle = session("middle", "w1", "2026-10-02T00:00:00Z"),
        recent = session("recent", "w1", "2026-10-03T00:00:00Z");
      publish(db, old, [record("r", 0, text("old-marker"))]);
      publish(db, middle, [record("r", 0, text("middle-marker"))]);
      publish(db, recent, [
        record("r", 0, text("recent-marker")),
        record("s", 1, text("recent-second")),
        record("t", 2, text("recent-third")),
      ]);
      const hits = (query: string) =>
        db.query({ query }, ["old", "middle", "recent"], () => {}).hits.length;
      expect(hits("recent-third")).toBe(1);
      expect(hits("middle-marker")).toBe(1);
      expect(hits("old-marker")).toBe(0);
      expect(db.status(["old"]).coverage).toMatchObject({
        unavailable: 1,
        limitations: ["cache-budget-exceeded"],
      });
      // The oldest session finds nothing older to displace, so it waits and writes nothing more.
      expect(db.canMakeRoom(old)).toBe(false);
      const stage = db.begin(old);
      expect(() => {
        for (let index = 0; index < 20; index++)
          db.append("old", stage, record(`r${index}`, index, text("old-again")), () => {});
      }).toThrow("budget-exceeded");
      db.abort("old", stage, true);
      expect(hits("recent-third")).toBe(1);
      expect(db.budgetExceeded()).toBe(true);
      const changed = commits(db);
      db.markUnindexed(old, "cache-budget-exceeded");
      expect(changed()).toBe(false);
    });
    it("resumes indexing after removed sessions leave room", () => {
      const db = fixture(300_000),
        large = session("large", "w1", "2026-10-02T00:00:00Z");
      const stage = db.begin(large);
      expect(() => {
        for (let index = 0; index < 40; index++)
          db.append("large", stage, record(`r${index}`, index, "x ".repeat(20_000)), () => {});
      }).toThrow("budget-exceeded");
      db.abort("large", stage, true);
      expect(db.budgetExceeded()).toBe(true);
      db.prune([]);
      expect(db.budgetExceeded()).toBe(false);
    });
    it("keeps the beginning of an over-long session and does not rewrite it as the session grows", () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "history-index-"));
      roots.push(root);
      const db = new HistorySearchStore(path.join(root, "search.sqlite"), true, undefined, 20_000);
      stores.push(db);
      const s = session("long");
      const turns = (count: number) =>
        Array.from({ length: count }, (_, index) =>
          record(`r${index}`, index, `turn-${index}-marker ${"body ".repeat(1000)}`),
        );
      publish(db, s, turns(10));
      const kept = ids(db, "long");
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(10);
      expect(db.status(["long"]).coverage).toMatchObject({
        partial: 1,
        limitations: ["cache-session-limit"],
      });
      const hits = (query: string) => db.query({ query }, ["long"], () => {}).hits.length;
      expect([hits("turn-0-marker"), hits("turn-9-marker")]).toEqual([1, 0]);
      publish(db, s, turns(30), "rev-2");
      expect(ids(db, "long")).toEqual(kept);
    });
    it("trusts a file stamp only for the revision it was saved with", () => {
      const db = fixture(),
        s = session("stamped");
      const generation = db.begin(s);
      db.append("stamped", generation, record("a", 0, "stamped-text"), () => {});
      db.finish("stamped", generation, "rev-1", "ready", [], undefined, "stamp-1");
      expect(db.sourceStamp("stamped", "rev-1")).toBe("stamp-1");
      expect(db.sourceStamp("stamped", "rev-2")).toBeUndefined();
      // A rebuild from a source that offers no stamp forgets the old one.
      publish(db, s, [record("a", 0, "stamped-text")], "rev-2");
      expect(db.sourceStamp("stamped", "rev-2")).toBeUndefined();
      db.rememberStamp("stamped", "rev-2", "stamp-2");
      expect(db.sourceStamp("stamped", "rev-2")).toBe("stamp-2");
    });
  });
});
