import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeSessions } from "../../../packages/backend/src/claude-sessions";
import { SessionIndex } from "../../../packages/backend/src/session-index";
import { SessionStore, type NativeSession } from "../../../packages/backend/src/session-store";
import { Sql } from "../../../packages/backend/src/sql";
import { migrateSharedSchema } from "../../../packages/backend/src/store-migrations";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const database of databases.splice(0)) database.close();
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "claude-session-origin-"));
  roots.push(root);
  const home = path.join(root, "claude"),
    project = path.join(root, "project"),
    directory = path.join(home, "projects", "project");
  mkdirSync(directory, { recursive: true });
  mkdirSync(project);
  const write = (sessionId: string, rows: unknown[]) => {
    const file = path.join(directory, `${sessionId}.jsonl`);
    writeFileSync(file, rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
    return file;
  };
  const prompt = (sessionId: string, content: unknown, extra: Record<string, unknown> = {}) => ({
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content },
    uuid: randomUUID(),
    userType: "external",
    cwd: project,
    sessionId,
    version: "2.1.311",
    ...extra,
  });
  const origin = (sessionId: string) =>
    new ClaudeSessions({ CLAUDE_CONFIG_DIR: home })
      .list(project)
      .sessions.find((source) => source.session.native_ref === sessionId)?.session.origin;
  return { write, prompt, origin, directory, project };
}

describe("Claude Code programmatic sessions", () => {
  it.each([
    ["cli", "interactive"],
    ["sdk-cli", "execution"],
    ["sdk-ts", "execution"],
    ["sdk-py", "execution"],
    ["claude-desktop", "interactive"],
  ])("classifies entrypoint %s as %s", (entrypoint, expected) => {
    const f = fixture(),
      id = randomUUID();
    f.write(id, [
      { type: "queue-operation", operation: "enqueue", sessionId: id },
      f.prompt(id, "Design the landing page", { entrypoint }),
    ]);
    expect(f.origin(id)).toBe(expected);
  });

  it("keeps transcripts that predate the entrypoint field", () => {
    const f = fixture(),
      id = randomUUID();
    f.write(id, [f.prompt(id, "Old question")]);
    expect(f.origin(id)).toBe("interactive");
  });

  it("lets the first record decide, as Claude Code does", () => {
    const f = fixture(),
      terminal = randomUUID(),
      print = randomUUID();
    f.write(terminal, [
      f.prompt(terminal, "Started in the terminal", { entrypoint: "cli" }),
      f.prompt(terminal, "Continued with -p", { entrypoint: "sdk-cli" }),
    ]);
    f.write(print, [
      f.prompt(print, "Started with -p", { entrypoint: "sdk-cli" }),
      f.prompt(print, "Continued in the terminal", { entrypoint: "cli" }),
    ]);
    expect(f.origin(terminal)).toBe("interactive");
    expect(f.origin(print)).toBe("execution");
  });

  it("falls back to the newest entrypoint in the tail when the header has none", () => {
    const f = fixture(),
      resumed = randomUUID(),
      reopened = randomUUID();
    const header = (id: string) => [
      f.prompt(id, "Old question"),
      ...Array.from({ length: 300 }, () => ({ type: "progress", sessionId: id })),
    ];
    f.write(resumed, [...header(resumed), f.prompt(resumed, "Later", { entrypoint: "sdk-cli" })]);
    f.write(reopened, [
      ...header(reopened),
      f.prompt(reopened, "Script", { entrypoint: "sdk-cli" }),
      f.prompt(reopened, "Terminal", { entrypoint: "cli" }),
    ]);
    expect(f.origin(resumed)).toBe("execution");
    expect(f.origin(reopened)).toBe("interactive");
  });

  it.each([
    ["daemon", "execution"],
    ["daemon-worker", "execution"],
    ["bg", "interactive"],
  ])("classifies session kind %s as %s", (sessionKind, expected) => {
    const f = fixture(),
      id = randomUUID();
    f.write(id, [f.prompt(id, "Background task", { entrypoint: "cli", sessionKind })]);
    expect(f.origin(id)).toBe(expected);
  });

  it("reads the session kind from the first message record before any other record", () => {
    const f = fixture(),
      message = randomUUID(),
      header = randomUUID();
    f.write(message, [
      { type: "mode", mode: "normal", sessionId: message, sessionKind: "daemon" },
      f.prompt(message, "Ordinary prompt", { entrypoint: "cli" }),
    ]);
    f.write(header, [
      { type: "mode", mode: "normal", sessionId: header, sessionKind: "daemon" },
      { type: "summary", summary: "No message records", sessionId: header, cwd: f.project },
    ]);
    expect(f.origin(message)).toBe("interactive");
    expect(f.origin(header)).toBe("execution");
  });

  it("hides sessions whose first prompt is /loop", () => {
    const f = fixture(),
      loop = randomUUID(),
      later = randomUUID(),
      blocks = randomUUID();
    const command = "<command-name>/loop</command-name>\n<command-args>5m /babysit</command-args>";
    f.write(loop, [
      f.prompt(loop, "<local-command-caveat>Caveat</local-command-caveat>", { isMeta: true }),
      f.prompt(loop, command, { entrypoint: "cli" }),
    ]);
    f.write(later, [
      f.prompt(later, "Check the build", { entrypoint: "cli" }),
      f.prompt(later, command, { entrypoint: "cli" }),
    ]);
    f.write(blocks, [
      f.prompt(blocks, [{ type: "tool_result", content: "output" }], { entrypoint: "cli" }),
      f.prompt(blocks, [{ type: "text", text: command }], { entrypoint: "cli" }),
    ]);
    expect(f.origin(loop)).toBe("execution");
    expect(f.origin(later)).toBe("interactive");
    expect(f.origin(blocks)).toBe("execution");
  });

  it("keeps sidechains auxiliary and classifies indexed entries from their transcript", () => {
    const f = fixture(),
      side = randomUUID(),
      indexed = randomUUID();
    f.write(side, [f.prompt(side, "Subagent", { entrypoint: "sdk-cli", isSidechain: true })]);
    const file = f.write(indexed, [f.prompt(indexed, "Indexed", { entrypoint: "sdk-ts" })]);
    writeFileSync(
      path.join(f.directory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [{ sessionId: indexed, projectPath: f.project, fullPath: file, summary: "Pen" }],
      }),
    );
    expect(f.origin(side)).toBe("auxiliary");
    expect(f.origin(indexed)).toBe("execution");
  });
});

describe("AgentKib-managed Claude sessions", () => {
  const native = (ref: string, origin: NativeSession["origin"]): NativeSession => ({
    native_ref: ref,
    agent: "claude-code",
    title: ref,
    created_at: null,
    updated_at: null,
    message_count: null,
    git_branch: null,
    archived: false,
    sidechain: false,
    availability: "readable",
    origin,
  });

  it("keeps print-mode sessions AgentKib runs itself as conversations", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    migrateSharedSchema(database);
    const sql = new Sql(database);
    sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES ('w','/fixture/w','w','healthy',?)",
      new Date().toISOString(),
    );
    const store = new SessionStore(sql, () => "/fixture/w");
    const managed = "6F2C6C49-46B1-4E7B-9B0B-6D5E8D0E2F11";
    const list = vi.fn(async (agent: string) => ({
      sessions:
        agent === "claude-code"
          ? [native(managed, "execution"), native("pen", "execution"), native("cli", "interactive")]
          : [],
      incomplete: false,
    }));
    const index = new SessionIndex(
      store,
      { list },
      () => true,
      () => {},
      () => new Set([managed.toLowerCase()]),
    );
    const rows = await index.refresh({ workspaceId: "w", force: true });
    expect(Object.fromEntries(rows.map((row) => [row.title, row.origin]))).toEqual({
      [managed]: "interactive",
      pen: "execution",
      cli: "interactive",
    });
  });

  it("indexes Claude sessions normally when the managed catalog cannot be read", async () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    migrateSharedSchema(database);
    const sql = new Sql(database);
    sql.run(
      "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES ('w','/fixture/w','w','healthy',?)",
      new Date().toISOString(),
    );
    const store = new SessionStore(sql, () => "/fixture/w");
    const list = vi.fn(async (agent: string) => ({
      sessions: agent === "claude-code" ? [native("pen", "execution")] : [],
      incomplete: false,
    }));
    const index = new SessionIndex(
      store,
      { list },
      () => true,
      () => {},
      () => {
        throw new Error("catalog unavailable");
      },
    );
    const rows = await index.refresh({ workspaceId: "w", force: true });
    expect(rows.map((row) => row.origin)).toEqual(["execution"]);
  });
});
