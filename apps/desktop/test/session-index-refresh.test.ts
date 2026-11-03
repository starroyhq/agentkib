// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { SessionStore, type NativeSession } from "../../../packages/backend/src/session-store";
import {
  SESSION_AGENTS,
  type SessionAgent,
  type NativeListing,
} from "../../../packages/backend/src/session-readers";
import { ClaudeSessions } from "../../../packages/backend/src/claude-sessions";
import { migrateSharedSchema } from "../../../packages/backend/src/store-migrations";
import { Sql } from "../../../packages/backend/src/sql";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.useRealTimers();
});
const native = (agent: SessionAgent, ref: string): NativeSession => ({
  native_ref: ref,
  agent,
  title: ref,
  created_at: null,
  updated_at: null,
  message_count: 1,
  git_branch: null,
  archived: false,
  sidechain: false,
  availability: "readable",
  origin: "interactive",
});
function fixture(
  list: (agent: SessionAgent, workspace: string) => Promise<NativeListing>,
  sourceChanged = vi.fn(),
) {
  const db = new DatabaseSync(":memory:");
  migrateSharedSchema(db);
  const sql = new Sql(db);
  sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES ('workspace','/fixture/project','Project','healthy',?)",
    new Date().toISOString(),
  );
  const store = new SessionStore(sql, () => "/fixture/project");
  let enabled = true;
  const index = new SessionIndex(
    store,
    { list },
    () => enabled,
    undefined,
    undefined,
    sourceChanged,
  );
  cleanup.push(() => {
    index.close();
    db.close();
  });
  return {
    store,
    sql,
    index,
    disable: () => {
      enabled = false;
      index.invalidate();
      store.clear(null);
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("cached directory refresh", () => {
  it("bounds automatic classification retries through real invalidation reads and allows immediate force", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let failed = true;
    const list = vi.fn(async (agent: SessionAgent) => {
      if (agent === "codex" && failed) throw new Error("Temporary classification failure");
      return { sessions: agent === "codex" ? [native(agent, "verified")] : [], incomplete: false };
    });
    let f!: ReturnType<typeof fixture>;
    const invalidate = vi.fn(() => {
      void f.index.read("workspace");
    });
    f = fixture(list, invalidate);
    f.store.sync("workspace", "codex", [native("codex", "verified")]);
    f.sql.run(
      "INSERT INTO schema_meta(key,value) VALUES ('codex_session_classification_pending:workspace','test')",
    );
    f.sql.run(
      "INSERT INTO schema_meta(key,value) VALUES (?,?)",
      `codex_session_classification_stale:${f.store.id("codex", "verified")}`,
      "workspace",
    );
    expect(await f.index.read("workspace")).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (let count = 0; count < 40; count++) {
      await f.index.read("workspace");
      await vi.advanceTimersByTimeAsync(90);
    }
    expect(list).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledOnce();
    // User refresh remains immediate despite the automatic retry interval.
    await f.index.refresh({ workspaceId: "workspace", force: true });
    expect(list.mock.calls.filter(([agent]) => agent === "codex")).toHaveLength(2);
    failed = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await f.index.read("workspace");
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(list.mock.calls.filter(([agent]) => agent === "codex")).toHaveLength(3);
    expect(f.store.list("workspace").map((row) => row.title)).toEqual(["verified"]);
  });

  it("clears automatic classification backoff at the epoch boundary", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const list = vi.fn(async () => {
      throw new Error("Unavailable");
    });
    const f = fixture(list);
    f.sql.run(
      "INSERT INTO schema_meta(key,value) VALUES ('codex_session_classification_pending:workspace','test')",
    );
    await f.index.read("workspace");
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(1);
    f.index.invalidate();
    await f.index.read("workspace");
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(list).toHaveBeenCalledTimes(2);
  });
  it("publishes the committed first source while a later source still waits", async () => {
    const waiting = deferred<NativeListing>();
    const changed = vi.fn();
    const list = vi.fn(async (agent: SessionAgent) =>
      agent === "claude-code"
        ? waiting.promise
        : { sessions: agent === "codex" ? [native(agent, "new-codex")] : [], incomplete: false },
    );
    const f = fixture(list, changed);
    const refresh = f.index.refresh({ workspaceId: "workspace", force: true });
    await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect((await f.index.read("workspace")).map((row) => row.title)).toEqual(["new-codex"]);
    const partial = f.index.incompleteSources(["workspace"]);
    expect(partial).not.toContainEqual({ workspaceId: "workspace", agent: "codex" });
    expect(partial).toContainEqual({ workspaceId: "workspace", agent: "claude-code" });
    waiting.resolve({ sessions: [], incomplete: false });
    await refresh;
    expect(f.index.complete(["workspace"])).toBe(true);
  });
  it("coalesces concurrent full/force requests instead of queueing repeated scans", async () => {
    const list = vi.fn(async () => ({ sessions: [], incomplete: false }));
    const f = fixture(list);
    const a = f.index.refresh({ workspaceId: "workspace" });
    const b = f.index.refresh({ workspaceId: "workspace", force: true });
    const c = f.index.refresh({ workspaceId: "workspace", force: true });
    expect(a).toBe(b);
    expect(b).toBe(c);
    await Promise.all([a, b, c]);
    expect(list).toHaveBeenCalledTimes(SESSION_AGENTS.length);
    await f.index.refresh({ workspaceId: "workspace" });
    expect(list).toHaveBeenCalledTimes(SESSION_AGENTS.length);
  });
  it("retains one necessary forced follow-up when force arrives during a non-force pass", async () => {
    const first = deferred<NativeListing>();
    let codexReads = 0;
    const list = vi.fn(async (agent: SessionAgent) =>
      agent === "codex" && ++codexReads === 1 ? first.promise : { sessions: [], incomplete: false },
    );
    const f = fixture(list);
    for (const agent of SESSION_AGENTS) f.store.sync("workspace", agent, []);
    f.store.failure("workspace", "codex", "Temporary issue");
    const a = f.index.refresh({ workspaceId: "workspace" });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    const b = f.index.refresh({ workspaceId: "workspace", force: true });
    const c = f.index.refresh({ workspaceId: "workspace", force: true });
    first.resolve({ sessions: [], incomplete: false });
    await Promise.all([a, b, c]);
    expect(list.mock.calls.filter(([agent]) => agent === "codex")).toHaveLength(2);
    for (const agent of SESSION_AGENTS.filter((agent) => agent !== "codex"))
      expect(list.mock.calls.filter(([value]) => value === agent)).toHaveLength(1);
  });
  it("keeps failed/partial source rows and isolates authority to those source scopes", async () => {
    const f = fixture(async (agent) => {
      if (agent === "antigravity") throw new Error("Unavailable");
      return {
        sessions: agent === "claude-code" ? [native(agent, "new")] : [],
        incomplete: agent === "claude-code",
      };
    });
    f.store.sync("workspace", "claude-code", [native("claude-code", "old")]);
    f.store.sync("workspace", "antigravity", [native("antigravity", "cached")]);
    const result = await f.index.refresh({ workspaceId: "workspace", force: true });
    expect(result.map((row) => row.title)).toEqual(
      expect.arrayContaining(["old", "new", "cached"]),
    );
    expect(f.index.incompleteSources(["workspace"])).toEqual([
      { workspaceId: "workspace", agent: "claude-code" },
      { workspaceId: "workspace", agent: "antigravity" },
    ]);
    expect(
      f.store.status("workspace").find((row) => row.agent === "antigravity")?.error_key,
    ).toBeTruthy();
  });
  it.each(["clear", "disable"])(
    "rejects an invalidated %s scan instead of resolving a false empty snapshot",
    async (action) => {
      const waiting = deferred<NativeListing>();
      const list = vi.fn(async () => waiting.promise);
      const f = fixture(list);
      const running = f.index.refresh({ workspaceId: "workspace", force: true });
      const rejected = expect(running).rejects.toThrow("session-index-stale");
      await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
      if (action === "clear") f.index.clear({ workspaceId: "workspace" });
      else f.disable();
      waiting.resolve({ sessions: [native("codex", "late")], incomplete: false });
      await rejected;
      expect(await f.index.read("workspace")).toEqual([]);
    },
  );
});

it("marks a real Claude listing partial when one index is unreadable but another transcript is valid", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-partial-claude-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project"),
    home = path.join(root, "claude"),
    directory = path.join(home, "projects", "project");
  mkdirSync(project);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "sessions-index.json"), "{invalid");
  writeFileSync(
    path.join(directory, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl"),
    JSON.stringify({
      type: "user",
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      cwd: project,
      isSidechain: false,
      message: { role: "user", content: "Valid user message" },
    }) + "\n",
  );
  const listing = new ClaudeSessions({ CLAUDE_CONFIG_DIR: home }).list(project);
  expect(listing.sessions).toHaveLength(1);
  expect(listing.incomplete).toBe(true);
});

it("distinguishes an absent Claude installation from an invalid source root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-claude-source-root-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "claude");
  const provider = new ClaudeSessions({ CLAUDE_CONFIG_DIR: home });
  expect(provider.list(null)).toEqual({ sessions: [], incomplete: false });
  mkdirSync(home);
  writeFileSync(path.join(home, "projects"), "invalid directory");
  expect(() => provider.list(null)).toThrow("Claude projects path is not a directory");
});
