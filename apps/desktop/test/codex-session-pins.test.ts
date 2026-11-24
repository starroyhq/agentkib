// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SESSION_COLLECTIONS, type SessionCollection } from "@agentkib/runtime-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CodexAppServerSession } from "../../../packages/backend/src/agents/codex/codex-app-server";
import { CodexSessions } from "../../../packages/backend/src/agents/codex/codex-sessions";
import { CodexRuntimePreflight } from "../../../packages/backend/src/agents/codex/codex-runtime-preflight";
import type { CodexSessionProvider } from "../../../packages/backend/src/agents/codex/session-provider";
import type { Commands } from "../../../packages/backend/src/commands";
import { saveManagedRecord } from "../../../packages/backend/src/managed-ledger";
import { SessionReaders } from "../../../packages/backend/src/session-readers";
import { BackendStore } from "../../../packages/backend/src/store";
import { WebReadRequests } from "../../../packages/backend/src/web-read";

const pin = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
const nativeId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

function fixture(supportsPins = true, collection?: SessionCollection) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-codex-pins-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "codex"),
    workspace = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(workspace);
  const nativeCwd =
    collection === "unclassified"
      ? path.join(root, "Documents", "Codex", "missing")
      : collection === "projectless"
        ? path.join(root, "missing-projectless")
        : workspace;
  if (collection === "projectless")
    writeFileSync(
      path.join(home, ".codex-global-state.json"),
      JSON.stringify({ "projectless-thread-ids": [nativeId] }),
    );
  const file = path.join(home, "state_5.sqlite");
  const native = new DatabaseSync(file);
  cleanups.push(() => native.close());
  native.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, cwd TEXT, title TEXT, source TEXT, archived INTEGER${supportsPins ? ", thread_section_id TEXT" : ""});`);
  if (supportsPins) {
    native.exec("CREATE TABLE thread_sections(id TEXT PRIMARY KEY, name TEXT)");
    native.prepare("INSERT INTO thread_sections VALUES (?, 'Pinned')").run(pin);
  }
  const transcript = path.join(home, "rollout.jsonl");
  writeFileSync(
    transcript,
    JSON.stringify({ type: "session_meta", payload: { id: nativeId, cwd: nativeCwd } }) + "\n",
  );
  native
    .prepare("INSERT INTO threads(id,rollout_path,cwd,title,source,archived) VALUES(?,?,?,?,?,0)")
    .run(nativeId, transcript, nativeCwd, "Fixture", "cli");

  const store = new BackendStore(path.join(root, "agentkib.sqlite"));
  cleanups.push(() => store.close());
  store.sql.run(
    "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
    "project",
    workspace,
    "Fixture",
    "healthy",
    "2026-11-24T00:00:00Z",
  );
  const environment = { CODEX_HOME: home, HOME: root, USERPROFILE: root, PATH: "" };
  store.sessions.sync(
    collection ? SESSION_COLLECTIONS[collection] : "project",
    "codex",
    new CodexSessions(environment)
      .list(collection ? null : workspace, { collection })
      .sessions.map(({ session }) => session),
  );
  const sessions = new SessionReaders(store.sessions, {} as Commands, environment, {} as never);
  cleanups.push(() => sessions.close());
  const changed = vi.fn();
  const web = new WebReadRequests(
    store,
    sessions,
    root,
    () => 0n,
    environment,
    undefined,
    undefined,
    undefined,
    changed,
  );
  cleanups.push(() => web.close());
  const provider = web.codexSessionProvider() as CodexSessionProvider;
  const sessionId = store.sessions.id("codex", nativeId);
  const writeSection = (section: string | null) =>
    native.prepare("UPDATE threads SET thread_section_id=? WHERE id=?").run(section, nativeId);
  const section = (): string | null =>
    native.prepare("SELECT thread_section_id FROM threads WHERE id=?").get(nativeId)
      ?.thread_section_id as string | null;

  const request = vi.fn(
    async (method: string, params: Record<string, unknown>, dispatch?: () => void) => {
      dispatch?.();
      if (method === "thread/read")
        return {
          thread: { id: nativeId, cwd: nativeCwd, section: section() ? { id: section() } : null },
        };
      if (method === "thread/section/move") {
        writeSection(params.sectionId as string | null);
        return {};
      }
      throw new Error("unexpected native method");
    },
  );
  const start = vi
    .spyOn(CodexAppServerSession, "start")
    .mockImplementation(async (_bin, _cwd, _home, _env, _onEvent, started) => {
      const fake = new EventEmitter();
      Object.assign(fake, { request, close: async () => fake.emit("close") });
      started?.(fake as unknown as CodexAppServerSession);
      return fake as unknown as CodexAppServerSession;
    });
  vi.spyOn(CodexRuntimePreflight.prototype, "preferred").mockReturnValue("/fixture/codex");
  return {
    root,
    workspace,
    home,
    native,
    provider,
    sessionId,
    section,
    writeSection,
    request,
    start,
    changed,
  };
}

it("offers fallback for legacy Codex SQLite without using the CLI", () => {
  const f = fixture(false);
  expect(f.provider.pinStates([f.sessionId]).has(f.sessionId)).toBe(false);
  expect(f.start).not.toHaveBeenCalled();
});

it("observes WAL-only pin and unpin for indexed and managed aliases without rescanning history", () => {
  const f = fixture();
  const owner = "managed-pin-fixture";
  saveManagedRecord(f.root, {
    id: owner,
    workspace_id: "project",
    workspace: f.workspace,
    cwd: f.workspace,
    home: f.home,
    native_id: nativeId,
    title: "Fixture",
    created_at: "2026-11-24T00:00:00Z",
    released: true,
    adopted: true,
  });
  expect(f.provider.pinStates([f.sessionId]).get(f.sessionId)).toEqual({
    pinned: false,
    available: true,
  });
  f.writeSection(pin);
  expect(f.provider.pinStates([f.sessionId, owner])).toEqual(
    new Map([
      [f.sessionId, { pinned: true, available: true }],
      [owner, { pinned: true, available: true }],
    ]),
  );
  f.writeSection(null);
  expect(f.provider.pinStates([f.sessionId]).get(f.sessionId)).toEqual({
    pinned: false,
    available: true,
  });
  expect(f.start).not.toHaveBeenCalled();
});

it("uses bounded pin RPCs only and keeps existing custom sections when already unpinned", async () => {
  const f = fixture();
  f.writeSection("custom-section");
  await expect(f.provider.setPinned(f.sessionId, false)).resolves.toBe(false);
  expect(f.section()).toBe("custom-section");
  expect(f.request).not.toHaveBeenCalledWith(
    "thread/section/move",
    expect.anything(),
    expect.anything(),
  );
  await expect(f.provider.setPinned(f.sessionId, true)).resolves.toBe(true);
  expect(f.section()).toBe(pin);
  await expect(f.provider.setPinned(f.sessionId, true)).resolves.toBe(true);
  await expect(f.provider.setPinned(f.sessionId, false)).resolves.toBe(false);
  expect(f.section()).toBeNull();
  expect(
    f.request.mock.calls
      .filter(([method]) => method === "thread/section/move")
      .map(([, params]) => params),
  ).toEqual([
    { threadId: nativeId, sectionId: pin, beforeThreadId: null },
    { threadId: nativeId, sectionId: null, beforeThreadId: null },
  ]);
  expect(new Set(f.request.mock.calls.map(([method]) => method))).toEqual(
    new Set(["thread/read", "thread/section/move"]),
  );
  expect(f.changed).toHaveBeenCalledTimes(2);
});

it("refuses a response for a different thread before dispatch", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ thread: { id: "wrong", cwd: f.workspace, section: null } });
  await expect(f.provider.setPinned(f.sessionId, true)).rejects.toThrow("thread-identity-mismatch");
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.section()).toBeNull();
});

it("retains the previous pin when a supported state database is temporarily unavailable", () => {
  const f = fixture();
  f.writeSection(pin);
  expect(f.provider.pinStates([f.sessionId]).get(f.sessionId)).toEqual({
    pinned: true,
    available: true,
  });
  vi.spyOn(CodexSessions.prototype, "pinSnapshot").mockImplementationOnce(() => {
    throw new Error("database is busy");
  });
  expect(f.provider.pinStates([f.sessionId]).get(f.sessionId)).toEqual({
    pinned: true,
    available: false,
  });
});

it("keeps a custom section selected before the unpin dispatch", async () => {
  const f = fixture();
  f.writeSection(pin);
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (...args) => {
    if (args[0] === "thread/section/move") f.writeSection("custom-section");
    return request(...args);
  });
  await expect(f.provider.setPinned(f.sessionId, false)).resolves.toBe(false);
  expect(f.section()).toBe("custom-section");
});

it.each(["projectless", "unclassified"] as const)(
  "pins a verified %s thread with a missing cwd from the trusted CODEX_HOME",
  async (collection) => {
    const f = fixture(true, collection);
    expect(f.provider.pinStates([f.sessionId]).get(f.sessionId)).toEqual({
      pinned: false,
      available: true,
    });
    await expect(f.provider.setPinned(f.sessionId, true)).resolves.toBe(true);
    expect(f.section()).toBe(pin);
    expect(f.start).toHaveBeenCalledWith(
      "/fixture/codex",
      f.home,
      f.home,
      expect.anything(),
      undefined,
      expect.any(Function),
    );
    await expect(f.provider.setPinned(f.sessionId, false)).resolves.toBe(false);
    expect(f.section()).toBeNull();
  },
);

it("refuses to pin when the collected native thread's cwd changes before dispatch", async () => {
  const f = fixture(true, "projectless");
  const request = f.request.getMockImplementation()!;
  f.request.mockImplementation(async (...args) => {
    if (args[0] === "thread/section/move")
      f.native.prepare("UPDATE threads SET cwd=? WHERE id=?").run(f.workspace, nativeId);
    return request(...args);
  });
  await expect(f.provider.setPinned(f.sessionId, true)).rejects.toThrow("session-pin-unavailable");
  expect(f.section()).toBeNull();
});
