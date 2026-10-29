import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore, type NativeSession } from "../../../packages/backend/src/session-store";
import { Sql } from "../../../packages/backend/src/sql";
import { migrateSharedSchema } from "../../../packages/backend/src/store-migrations";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const native = (ref: string, agent: NativeSession["agent"] = "claude-code"): NativeSession => ({
  native_ref: ref,
  agent,
  title: ref,
  created_at: null,
  updated_at: null,
  message_count: null,
  git_branch: null,
  archived: false,
  sidechain: false,
  availability: "readable",
  origin: "interactive",
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateSharedSchema(database);
  const sql = new Sql(database);
  const paths: Record<string, string> = {
    root: "/",
    home: "/fixture/home",
    repo: "/fixture/home/repo",
    sibling: "/fixture/sibling",
  };
  for (const [id, canonical] of Object.entries(paths))
    sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES (?,?,?,'healthy',?)",
      id,
      canonical,
      id,
      new Date().toISOString(),
    );
  const store = new SessionStore(sql, (id) => paths[id]!);
  const owners = () =>
    Object.fromEntries(
      sql
        .rows("SELECT title,workspace_id FROM conversation_sessions ORDER BY title")
        .map((row) => [String(row.title), String(row.workspace_id)]),
    );
  const count = (workspace: string) =>
    store.status(workspace).find((status) => status.agent === "claude-code")?.session_count;
  return { sql, store, owners, count, database };
}

describe("nested workspace session ownership", () => {
  it("never lets an enclosing workspace take rows a nested workspace holds", () => {
    const f = fixture();
    f.store.sync("repo", "claude-code", [native("in-repo")]);
    f.store.sync("home", "claude-code", [native("in-repo"), native("in-home")]);
    f.store.sync("root", "claude-code", [native("in-repo"), native("in-home"), native("tmp")]);
    expect(f.owners()).toEqual({ "in-home": "home", "in-repo": "repo", tmp: "root" });
    expect(f.store.list("repo").map((row) => row.title)).toEqual(["in-repo"]);
    expect([f.count("root"), f.count("home"), f.count("repo")]).toEqual([1, 1, 1]);
  });

  it("lets the nested workspace reclaim rows an enclosing scan took first", () => {
    const f = fixture();
    f.store.sync("home", "claude-code", [native("in-repo")]);
    expect(f.owners()).toEqual({ "in-repo": "home" });
    f.store.sync("repo", "claude-code", [native("in-repo")]);
    f.store.sync("home", "claude-code", [native("in-repo")]);
    expect(f.owners()).toEqual({ "in-repo": "repo" });
    expect(f.count("home")).toBe(0);
  });

  it("hands a row back once the nested workspace no longer lists it", () => {
    const f = fixture();
    f.store.sync("repo", "claude-code", [native("moved")]);
    f.store.sync("repo", "claude-code", []);
    f.store.sync("home", "claude-code", [native("moved")]);
    expect(f.owners()).toEqual({ moved: "home" });
  });

  it("does not treat a sibling or an equal path as nested", () => {
    const f = fixture();
    f.store.sync("sibling", "claude-code", [native("shared")]);
    f.store.sync("home", "claude-code", [native("shared")]);
    expect(f.owners()).toEqual({ shared: "home" });
  });

  it("records each session's directory and Codex remote without listing them", () => {
    const f = fixture();
    f.store.sync("repo", "codex", [
      {
        ...native("thread", "codex"),
        cwd: "/fixture/home/repo/app",
        git_origin_url: " https://example.invalid/r.git ",
      },
      { ...native("relative", "codex"), cwd: "relative/dir", git_origin_url: " " },
    ]);
    const id = f.store.id("codex", "thread");
    expect(f.store.directories([id, f.store.id("codex", "relative"), "missing"])).toEqual(
      new Map([
        [id, { cwd: "/fixture/home/repo/app", git_origin_url: "https://example.invalid/r.git" }],
      ]),
    );
    expect(f.store.list("repo")[0]).not.toHaveProperty("cwd");
    f.store.sync("home", "codex", [{ ...native("thread", "codex"), cwd: "/elsewhere" }]);
    expect(f.store.directories([id]).get(id)?.cwd).toBe("/fixture/home/repo/app");
  });

  it("keeps the Codex reclassification marker on rows it did not rewrite", () => {
    const f = fixture();
    f.store.sync("repo", "codex", [native("thread", "codex")]);
    f.sql.run("DELETE FROM schema_meta WHERE key='codex_session_classification_revision'");
    migrateSharedSchema(f.database);
    f.store.sync("home", "codex", [native("thread", "codex")]);
    expect(f.store.list("repo")).toEqual([]);
    expect(f.store.list("home")).toEqual([]);
    f.store.sync("repo", "codex", [native("thread", "codex")]);
    expect(f.store.list("repo").map((row) => row.title)).toEqual(["thread"]);
  });
});
