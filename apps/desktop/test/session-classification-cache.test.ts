import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SESSION_COLLECTIONS } from "@agentkib/runtime-protocol";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { SessionStore, type NativeSession } from "../../../packages/backend/src/session-store";
import { Sql } from "../../../packages/backend/src/sql";
import {
  CODEX_SESSION_CLASSIFICATION_REVISION,
  migrateSharedSchema,
} from "../../../packages/backend/src/store-migrations";

const databases: DatabaseSync[] = [];
const indexes: SessionIndex[] = [];
const native = (ref: string, origin: NativeSession["origin"] = "unknown"): NativeSession => ({
  native_ref: ref,
  agent: "codex",
  title: ref,
  created_at: null,
  updated_at: null,
  message_count: 1,
  git_branch: null,
  archived: false,
  sidechain: false,
  availability: "readable",
  origin,
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  migrateSharedSchema(database);
  const sql = new Sql(database);
  for (const id of ["workspace", "other"])
    sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES (?,?,?,'healthy',?)",
      id,
      `/fixture/${id}`,
      id,
      new Date().toISOString(),
    );
  const store = new SessionStore(sql, (id) => `/fixture/${id}`);
  const upgrade = () => {
    sql.run("DELETE FROM schema_meta WHERE key='codex_session_classification_revision'");
    migrateSharedSchema(database);
  };
  return { database, sql, store, upgrade };
}

afterEach(() => {
  for (const index of indexes.splice(0)) index.close();
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("Codex classification cache upgrade", () => {
  it("invalidates both cache kinds once without deleting history identities or other providers", () => {
    const { database, sql, store, upgrade } = fixture();
    const session = native("ordinary");
    store.sync("workspace", "codex", [session]);
    store.sync(SESSION_COLLECTIONS.projectless, "codex", [native("collection")]);
    store.sync("workspace", "claude-code", [{ ...native("claude"), agent: "claude-code" }]);
    const id = store.id("codex", session.native_ref);
    upgrade();

    expect(store.list("workspace").map((item) => item.agent)).toEqual(["claude-code"]);
    expect(store.list(SESSION_COLLECTIONS.projectless)).toEqual([]);
    expect(store.get(id)?.id).toBe(id);
    expect(store.codexClassificationPending("workspace")).toBe(true);
    expect(store.codexClassificationPending(SESSION_COLLECTIONS.projectless)).toBe(true);
    expect(store.status("workspace").find((item) => item.agent === "codex")?.freshness).toBe(
      "unavailable",
    );
    expect(store.status("workspace").find((item) => item.agent === "claude-code")?.freshness).toBe(
      "fresh",
    );
    expect(sql.one("SELECT value FROM schema_meta WHERE key='schema_version'")?.value).toBe("15");

    store.sync("workspace", "codex", [native("ordinary", "execution")]);
    migrateSharedSchema(database);
    expect(store.codexClassificationPending("workspace")).toBe(false);
    expect(store.list("workspace").find((item) => item.id === id)?.origin).toBe("execution");
    expect(
      sql.one("SELECT value FROM schema_meta WHERE key='codex_session_classification_revision'")
        ?.value,
    ).toBe(CODEX_SESSION_CLASSIFICATION_REVISION);
  });

  it("retains unverified rows during partial refresh and clears pending once all rows are classified", () => {
    const { store, upgrade } = fixture();
    store.sync("workspace", "codex", [native("first"), native("second")]);
    upgrade();
    store.sync("workspace", "codex", [native("first", "execution")], false);
    expect(store.list("workspace").map((item) => item.title)).toEqual(["first"]);
    expect(store.get(store.id("codex", "second"))).not.toBeNull();
    expect(store.codexClassificationPending("workspace")).toBe(true);

    store.sync("workspace", "codex", [native("second", "interactive")], false);
    expect(store.codexClassificationPending("workspace")).toBe(false);
    expect(store.list("workspace")).toHaveLength(2);
  });

  it("clears stale rows after a complete empty scan", () => {
    const { store, upgrade } = fixture();
    store.sync("workspace", "codex", [native("gone")]);
    upgrade();
    store.sync("workspace", "codex", []);
    expect(store.get(store.id("codex", "gone"))).toBeNull();
    expect(store.codexClassificationPending("workspace")).toBe(false);
  });

  it("moves a classified row between collection and workspace without a stale marker re-hiding it", () => {
    const { store, upgrade } = fixture();
    store.sync(SESSION_COLLECTIONS.unclassified, "codex", [native("move")]);
    const id = store.id("codex", "move");
    upgrade();
    store.sync("workspace", "codex", [native("move", "interactive")], false);
    expect(store.list("workspace").map((item) => item.id)).toEqual([id]);
    expect(store.list(SESSION_COLLECTIONS.unclassified)).toEqual([]);
    store.sync(SESSION_COLLECTIONS.unclassified, "codex", [], false);
    expect(store.codexClassificationPending(SESSION_COLLECTIONS.unclassified)).toBe(false);
    store.sync(SESSION_COLLECTIONS.projectless, "codex", [native("move", "execution")]);
    expect(store.list("workspace")).toEqual([]);
    expect(store.get(id)?.workspace_id).toBe(SESSION_COLLECTIONS.projectless);
  });

  it("clearing one cache removes only its classification markers", () => {
    const { store, upgrade } = fixture();
    store.sync("workspace", "codex", [native("first")]);
    store.sync("other", "codex", [native("other")]);
    store.sync(SESSION_COLLECTIONS.projectless, "codex", [native("collection")]);
    upgrade();
    store.clear("workspace");
    expect(store.codexClassificationPending("workspace")).toBe(false);
    expect(store.codexClassificationPending("other")).toBe(true);
    expect(store.codexClassificationPending(SESSION_COLLECTIONS.projectless)).toBe(true);
    expect(store.get(store.id("codex", "other"))).not.toBeNull();
    store.clear(null);
    expect(store.codexClassificationPending("other")).toBe(false);
    expect(store.codexClassificationPending(SESSION_COLLECTIONS.projectless)).toBe(false);
  });
});

describe("directory reads during reclassification", () => {
  it("returns trusted cache immediately and coalesces background Codex classification", async () => {
    const { store, upgrade } = fixture();
    store.sync("workspace", "codex", [native("old")]);
    upgrade();
    const list = vi.fn(async () => ({ sessions: [native("old", "execution")], incomplete: false }));
    const index = new SessionIndex(store, { list }, () => true);
    indexes.push(index);
    const [first, second] = await Promise.all([index.read("workspace"), index.read("workspace")]);
    expect(list).not.toHaveBeenCalled();
    expect(first).toEqual([]);
    expect(second).toEqual(first);
    await vi.waitFor(() => expect(store.list("workspace")[0]?.origin).toBe("execution"));
    expect(list).toHaveBeenCalledExactlyOnceWith("codex", "/fixture/workspace");
    await index.read("workspace");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("returns reclassified rows while retaining failed-source history for a later read", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { store, upgrade } = fixture();
    store.sync("workspace", "codex", [native("verified"), native("unverified")]);
    upgrade();
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error("source unavailable"))
      .mockResolvedValueOnce({ sessions: [native("verified", "interactive")], incomplete: true })
      .mockResolvedValueOnce({ sessions: [native("unverified", "execution")], incomplete: true });
    const index = new SessionIndex(store, { list }, () => true);
    indexes.push(index);
    expect(await index.read("workspace")).toEqual([]);
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(store.get(store.id("codex", "unverified"))).not.toBeNull();
    expect(await index.read("workspace")).toEqual([]);
    expect(list).toHaveBeenCalledTimes(1);
    now += 5_000;
    await index.read("workspace");
    await vi.waitFor(() =>
      expect(store.list("workspace").map((item) => item.title)).toEqual(["verified"]),
    );
    expect((await index.read("workspace")).map((item) => item.title)).toEqual(["verified"]);
    expect(list).toHaveBeenCalledTimes(2);
    now += 5_000;
    await index.read("workspace");
    await vi.waitFor(() => expect(store.list("workspace")).toHaveLength(2));
    expect(store.codexClassificationPending("workspace")).toBe(false);
    await index.read("workspace");
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("reclassifies collections without treating them as filesystem workspaces", async () => {
    const { store, upgrade } = fixture();
    store.sync(SESSION_COLLECTIONS.projectless, "codex", [native("old")]);
    upgrade();
    const list = vi.fn(async () => ({ sessions: [native("old", "execution")] }));
    const index = new SessionIndex(store, { list }, () => true);
    indexes.push(index);
    expect(await index.read(SESSION_COLLECTIONS.projectless)).toEqual([]);
    await vi.waitFor(() =>
      expect(store.list(SESSION_COLLECTIONS.projectless)[0]?.origin).toBe("execution"),
    );
    expect(list).toHaveBeenCalledExactlyOnceWith("codex", SESSION_COLLECTIONS.projectless);
  });

  it("invalidating an in-flight read does not repopulate a cleared cache", async () => {
    const { store, upgrade } = fixture();
    store.sync("workspace", "codex", [native("old")]);
    upgrade();
    let finish!: (value: { sessions: NativeSession[] }) => void;
    const list = vi.fn(
      () =>
        new Promise<{ sessions: NativeSession[] }>((resolve) => {
          finish = resolve;
        }),
    );
    const index = new SessionIndex(store, { list }, () => true);
    indexes.push(index);
    const read = index.read("workspace");
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    index.clear({ workspaceId: "workspace" });
    finish({ sessions: [native("old", "execution")] });
    expect(await read).toEqual([]);
    expect(store.list("workspace")).toEqual([]);
  });
});
