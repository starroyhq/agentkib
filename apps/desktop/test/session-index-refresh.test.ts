// @vitest-environment node
import {
  projectCatalogSourceIssues,
  REMOTE_ERROR_CODES,
  RUNTIME_METHODS,
} from "@agentkib/runtime-protocol";
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
import {
  catalogClaudeTranscripts,
  ClaudeSessions,
} from "../../../packages/backend/src/agents/claude/claude-sessions";
import { localRuntimeRequestResult } from "../../../packages/backend/src/local-runtime-request-result";
import { applyNativeCatalogListing } from "../../../packages/backend/src/session-catalog-index";
import { SessionCatalogStream } from "../../../packages/backend/src/session-catalog-stream";
import { migrateSharedSchema } from "../../../packages/backend/src/store-migrations";
import { Sql } from "../../../packages/backend/src/sql";
import { BackendTaskError } from "../../../packages/backend/src/task-executor";

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
  metadataChanged = sourceChanged,
) {
  const db = new DatabaseSync(":memory:");
  migrateSharedSchema(db);
  const sql = new Sql(db);
  sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES ('workspace','/fixture/project','Project','healthy',?)",
    new Date().toISOString(),
  );
  const store = new SessionStore(sql, (id) =>
    id === "workspace" ? "/fixture/project" : `/fixture/${id}`,
  );
  let enabled = true;
  const index = new SessionIndex(
    store,
    { list },
    () => enabled,
    undefined,
    undefined,
    sourceChanged,
    metadataChanged,
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
  it("keeps a mixed Claude transcript batch from turning a readable source into a catalog failure", () => {
    const f = fixture(async () => ({ sessions: [], incomplete: false }));
    const projects = mkdtempSync(path.join(tmpdir(), "agentkib-catalog-scan-"));
    cleanup.push(() => rmSync(projects, { recursive: true, force: true }));
    const readable = path.join(projects, "readable.jsonl");
    const growing = path.join(projects, "growing.jsonl");
    writeFileSync(
      readable,
      JSON.stringify({
        type: "user",
        cwd: "/fixture/project",
        sessionId: "readable",
        entrypoint: "cli",
        message: { role: "user", content: "Current title" },
      }) + "\n",
    );
    writeFileSync(growing, "");
    for (const agent of SESSION_AGENTS) f.store.sync("workspace", agent, []);
    f.store.sync("workspace", "claude-code", [
      native("claude-code", "readable"),
      native("claude-code", "growing"),
    ]);

    const listing = catalogClaudeTranscripts(projects, [readable, growing]);
    expect(listing).toMatchObject({ incomplete: true, nativeRefs: ["readable"] });
    expect(
      applyNativeCatalogListing(f.store, "claude-code", listing, (sessions) => sessions),
    ).toEqual({ changed: true, rowsChanged: true });
    expect(f.store.list("workspace").map(({ title }) => title)).toEqual(
      expect.arrayContaining(["Current title", "growing"]),
    );

    const complete = f.index.complete(["workspace"]);
    const sources = f.index.catalogSources(["workspace"]);
    expect(sources).toContainEqual({
      workspaceId: "workspace",
      agent: "claude-code",
      complete: true,
    });
    expect(
      localRuntimeRequestResult(
        { method: RUNTIME_METHODS.sessionRequest, operation: "catalog" },
        {
          result: {
            complete,
            taskSummarySourceCoverage: { indexEnabled: true, managedComplete: true, sources },
          },
        },
      ),
    ).toEqual({ stage: "runtime-dispatch", outcome: "completed" });
  });

  it("reports an unreadable Claude index only for its verified workspace, then clears the warning on a full read", () => {
    const f = fixture(async () => ({ sessions: [], incomplete: false }));
    f.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES ('other','/fixture/other','Other','healthy',?)",
      new Date().toISOString(),
    );
    const home = mkdtempSync(path.join(tmpdir(), "agentkib-catalog-index-issue-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const reader = new ClaudeSessions({ CLAUDE_CONFIG_DIR: home });
    const projects = reader.projects();
    const writeTranscript = (ref: string, cwd: string) => {
      const directory = path.join(projects, ref);
      mkdirSync(directory, { recursive: true });
      const transcript = path.join(directory, `${ref}.jsonl`);
      writeFileSync(
        transcript,
        JSON.stringify({
          type: "user",
          cwd,
          sessionId: ref,
          message: { role: "user", content: `Title for ${ref}` },
        }) + "\n",
      );
      return { transcript, index: path.join(directory, "sessions-index.json") };
    };
    const broken = writeTranscript("broken", "/fixture/project/subdir");
    const readable = writeTranscript("readable", "/fixture/other");
    const outside = writeTranscript("outside", "/unregistered");
    for (const { index } of [broken, outside]) writeFileSync(index, "{broken");
    for (const workspace of ["workspace", "other"])
      for (const agent of SESSION_AGENTS) f.store.sync(workspace, agent, []);
    f.store.sync("workspace", "claude-code", [native("claude-code", "broken")]);

    const apply = (listing: ReturnType<typeof catalogClaudeTranscripts>) =>
      applyNativeCatalogListing(f.store, "claude-code", listing, (sessions) => sessions);
    const targeted = () =>
      catalogClaudeTranscripts(
        projects,
        [broken, readable, outside].map(({ transcript }) => transcript),
      );
    apply(targeted());
    const health = () => f.index.catalogSources(["workspace", "other"]);
    expect(health()).toContainEqual({
      workspaceId: "workspace",
      agent: "claude-code",
      complete: false,
      reasons: [REMOTE_ERROR_CODES.sourcePartial],
    });
    expect(health()).toContainEqual({ workspaceId: "other", agent: "claude-code", complete: true });
    expect(f.store.list("workspace").map(({ title }) => title)).toEqual(["broken"]);
    expect(f.store.list("other").map(({ title }) => title)).toEqual(["Title for readable"]);
    expect(apply(targeted())).toEqual({ changed: false, rowsChanged: false });

    // The watcher refreshes the full source when a project index is replaced.
    for (const { index } of [broken, outside])
      writeFileSync(index, JSON.stringify({ version: 1, entries: [] }));
    const recovered = reader.list(null);
    expect(recovered.incomplete).toBe(false);
    apply({
      incomplete: recovered.incomplete,
      sessions: recovered.sessions.map(({ cwd, session }) => ({ ...session, cwd })),
    });
    for (const workspaceId of ["workspace", "other"]) {
      expect(health()).toContainEqual({
        workspaceId,
        agent: "claude-code",
        complete: true,
      });
    }
    expect(f.store.list("workspace").map(({ title }) => title)).toEqual(["Title for broken"]);
  });

  it("reconciles repeated provider scans without announcing unchanged source failures", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const unavailable = new Set<SessionAgent>(["claude-code"]);
    const stream = new SessionCatalogStream({});
    const f = fixture(
      async (agent) => {
        if (unavailable.has(agent)) throw new Error("Synthetic read failure");
        return { sessions: [], incomplete: false };
      },
      vi.fn(() => stream.invalidate(0, true)),
      vi.fn(() => stream.invalidate(0, false)),
    );
    for (const agent of SESSION_AGENTS) f.store.sync("workspace", agent, []);
    const snapshot = () => ({
      sessions: [],
      complete: f.index.complete(["workspace"]),
      incompleteSources: f.index.incompleteSources(["workspace"]),
    });
    let last = snapshot();
    const scan = async () => {
      await f.index.refresh({ workspaceId: "workspace", force: true });
      await vi.runOnlyPendingTimersAsync();
      const next = snapshot();
      expect(stream.take(last, 0)).toBe("reconcile");
      const result = stream.reconcile(last, next, false);
      last = next;
      return result;
    };
    await expect(scan()).resolves.toEqual({ domains: ["catalog"] });
    expect(last.complete).toBe(false);
    await expect(scan()).resolves.toBeUndefined();
    unavailable.clear();
    await expect(scan()).resolves.toEqual({ domains: ["catalog"] });
    expect(last.complete).toBe(true);
  });

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
    expect(f.index.catalogSources(["workspace"])).toEqual(
      expect.arrayContaining([
        { workspaceId: "workspace", agent: "codex", complete: true },
        {
          workspaceId: "workspace",
          agent: "claude-code",
          complete: false,
          reasons: ["not-scanned", "refreshing"],
        },
      ]),
    );
    waiting.resolve({ sessions: [], incomplete: false });
    await refresh;
    expect(f.index.complete(["workspace"])).toBe(true);
    expect(f.index.catalogSources(["workspace"])).toContainEqual({
      workspaceId: "workspace",
      agent: "claude-code",
      complete: true,
    });
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
  it("serializes discovery for distinct workspaces and still coalesces queued readers", async () => {
    const waiting = deferred<NativeListing>();
    const list = vi.fn(async (_agent: SessionAgent, workspace: string) =>
      workspace === "/fixture/project" ? waiting.promise : { sessions: [], incomplete: false },
    );
    const f = fixture(list);
    f.sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES ('other','/fixture/other','Other','healthy',?)",
      new Date().toISOString(),
    );
    const first = f.index.refresh({ workspaceId: "workspace", force: true });
    const second = f.index.refresh({ workspaceId: "other" });
    const forced = f.index.refresh({ workspaceId: "other", force: true });
    expect(second).toBe(forced);
    await vi.waitFor(() => expect(list).toHaveBeenCalledWith("codex", "/fixture/project"));
    expect(list).toHaveBeenCalledTimes(1);
    waiting.resolve({ sessions: [], incomplete: false });
    await Promise.all([first, second, forced]);
    expect(list.mock.calls.map(([, workspace]) => workspace)).toEqual([
      ...SESSION_AGENTS.map(() => "/fixture/project"),
      ...SESSION_AGENTS.map(() => "/fixture/other"),
    ]);
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
    expect(f.index.catalogSources(["workspace"])).toEqual(
      expect.arrayContaining([
        {
          workspaceId: "workspace",
          agent: "claude-code",
          complete: false,
          reasons: ["source-partial"],
        },
        {
          workspaceId: "workspace",
          agent: "antigravity",
          complete: false,
          reasons: ["source-unavailable"],
        },
      ]),
    );
  });
  it("persists a retryable task reason without the exception message", async () => {
    const reads: Partial<Record<SessionAgent, () => NativeListing>> = {
      devin: () => {
        throw new BackendTaskError("queue-full", "Synthetic private path");
      },
    };
    const f = fixture(async (agent) => reads[agent]?.() ?? { sessions: [], incomplete: false });
    await f.index.refresh({ workspaceId: "workspace", force: true });
    expect(f.store.status("workspace")).toContainEqual(
      expect.objectContaining({
        agent: "devin",
        error_key: "errors.conversations.sourceUnavailable",
        error_detail: '["queue-full"]',
      }),
    );
    expect(f.index.catalogSources(["workspace"])).toContainEqual({
      workspaceId: "workspace",
      agent: "devin",
      complete: false,
      reasons: ["queue-full"],
    });
  });
  it("keeps cached history without a retry prompt when a source requires external repair", async () => {
    const results: Partial<Record<SessionAgent, NativeListing>> = {
      devin: {
        sessions: [],
        incomplete: true,
        sourceFailed: true,
        issues: [{ code: "devin-source-denied", scope: "source" }],
      },
    };
    const f = fixture(async (agent) => results[agent] ?? { sessions: [], incomplete: false });
    f.store.sync("workspace", "devin", [native("devin", "cached")]);
    const previousSuccess = "2026-01-01T12:00:00Z";
    f.sql.run(
      "UPDATE conversation_index_status SET last_success_at=? WHERE workspace_id=? AND agent=?",
      previousSuccess,
      "workspace",
      "devin",
    );
    await f.index.refresh({ workspaceId: "workspace", force: true });
    expect(f.store.list("workspace")).toContainEqual(
      expect.objectContaining({ agent: "devin", title: "cached" }),
    );
    expect(f.store.status("workspace")).toContainEqual(
      expect.objectContaining({
        agent: "devin",
        error_key: null,
        error_detail: '["devin-source-denied"]',
        last_success_at: previousSuccess,
      }),
    );
    expect(f.index.incompleteSources(["workspace"])).toEqual([]);
    expect(f.index.catalogSources(["workspace"])).toContainEqual({
      workspaceId: "workspace",
      agent: "devin",
      complete: false,
      reasons: ["devin-source-denied"],
    });
  });
  it("keeps disabled ACP out of source failures even when eligibility advertises that reason", async () => {
    const disabled = "antigravity-acp-disabled";
    const issue = { code: disabled, scope: "source" } as const;
    const listings: Partial<Record<SessionAgent, NativeListing>> = {
      antigravity: { sessions: [], incomplete: true, issues: [issue] },
    };
    const f = fixture(async (agent) => listings[agent] ?? { sessions: [], incomplete: false });
    f.store.sync("workspace", "antigravity", [native("antigravity", "cached")]);
    await f.index.refresh({ workspaceId: "workspace", force: true });
    expect(f.index.incompleteSources(["workspace"])).toEqual([]);
    expect(f.store.list("workspace").map(({ title }) => title)).toContain("cached");
    expect(f.store.status("workspace")).toContainEqual(
      expect.objectContaining({ agent: "antigravity", error_key: null, error_detail: null }),
    );

    const failure = REMOTE_ERROR_CODES.antigravityDatabaseSource;
    listings.antigravity!.issues!.push({ code: failure, scope: "source" });
    await f.index.refresh({ workspaceId: "workspace", force: true });
    const source = { workspaceId: "workspace", agent: "antigravity", reasons: [failure] };
    expect(f.store.status("workspace")).toContainEqual(
      expect.objectContaining({ agent: "antigravity", error_detail: JSON.stringify([failure]) }),
    );
    expect(
      projectCatalogSourceIssues(
        [{ ...source, reasons: [disabled, failure] }],
        new Set(["workspace"]),
      ),
    ).toEqual([source]);
  });
  it("records actionable Antigravity reasons separately from unattributed records", async () => {
    const f = fixture(async (agent) =>
      agent === "antigravity"
        ? {
            sessions: [native(agent, "new")],
            incomplete: true,
            issues: [
              { code: "antigravity-acp-list", scope: "source" as const },
              { code: "antigravity-database-record", scope: "workspace" as const },
              { code: "antigravity-database-record", scope: "workspace" as const },
              { code: "antigravity-summary-record", scope: "unattributed" as const },
            ],
          }
        : { sessions: [], incomplete: false },
    );
    f.store.sync("workspace", "antigravity", [native("antigravity", "cached")]);
    await f.index.refresh({ workspaceId: "workspace", force: true });
    expect(f.store.list("workspace").map((row) => row.title)).toEqual(
      expect.arrayContaining(["cached", "new"]),
    );
    const status = f.store.status("workspace").find((row) => row.agent === "antigravity");
    expect(JSON.parse(status!.error_detail!)).toEqual([
      "antigravity-acp-list",
      "antigravity-database-record",
    ]);
    expect(f.index.catalogSources(["workspace"])).toContainEqual({
      workspaceId: "workspace",
      agent: "antigravity",
      complete: false,
      reasons: ["antigravity-acp-list", "antigravity-database-record"],
    });
  });
  it("reports disabled inventory without starting scans or changing legacy completeness", () => {
    const list = vi.fn(async () => ({ sessions: [], incomplete: false }));
    const f = fixture(list);
    f.disable();
    expect(f.index.incompleteSources(["workspace"])).toEqual([]);
    expect(f.index.catalogSources(["workspace"])).toEqual(
      SESSION_AGENTS.map((agent) => ({
        workspaceId: "workspace",
        agent,
        complete: false,
        reasons: ["index-disabled"],
      })),
    );
    expect(list).not.toHaveBeenCalled();
  });
  it("omits disabled ACP from persisted source failures while preserving real failures", () => {
    const f = fixture(async () => ({ sessions: [], incomplete: false }));
    f.store.sync("workspace", "antigravity", [native("antigravity", "cached")]);
    f.store.failure("workspace", "antigravity", '["antigravity-acp-disabled"]');
    expect(f.index.incompleteSources(["workspace"])).not.toContainEqual({
      workspaceId: "workspace",
      agent: "antigravity",
    });
    expect(f.store.list("workspace").map((row) => row.title)).toContain("cached");

    f.store.failure(
      "workspace",
      "antigravity",
      '["antigravity-acp-disabled","antigravity-database-record"]',
    );
    expect(f.index.catalogSources(["workspace"])).toContainEqual({
      workspaceId: "workspace",
      agent: "antigravity",
      complete: false,
      reasons: ["antigravity-database-record"],
    });
  });
  it("logs an unattributed record ID once without failing any refresh", async () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const category = "antigravity-acp-workspace-unavailable";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const f = fixture(async (agent) =>
        agent === "antigravity"
          ? {
              sessions: [],
              incomplete: false,
              issues: [{ code: category, scope: "unattributed" as const, id }],
            }
          : { sessions: [], incomplete: false },
      );
      await f.index.refresh({ workspaceId: "workspace", force: true });
      await f.index.refresh({ workspaceId: "workspace", force: true });
      expect(f.index.complete(["workspace"])).toBe(true);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "Skipped conversation records:",
        JSON.stringify([{ category, count: 1, ids: [id] }]),
      );
    } finally {
      warn.mockRestore();
    }
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
