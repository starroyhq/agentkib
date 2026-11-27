// @vitest-environment node
import { execFile } from "node:child_process";
import { once, EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ClaudeSessions } from "../../../packages/backend/src/agents/claude/claude-sessions";
import {
  catalogWatchSources,
  SessionCatalogWatch,
  type CatalogSourceChange,
} from "../../../packages/backend/src/session-catalog-watch";
import { devinSessionDatabase } from "../../../packages/backend/src/agents/devin/devin-sessions";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-catalog-watch-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const environment = {
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: path.join(root, "codex"),
    DEVIN_SESSIONS_DIR: path.join(root, "devin"),
  };
  const events = new EventEmitter();
  return {
    root,
    environment,
    start() {
      const watcher = new SessionCatalogWatch(catalogWatchSources(environment), (changes) => {
        for (const change of changes) events.emit(change.agent, change);
      });
      cleanup.push(() => watcher.close());
    },
    async write(
      agent: CatalogSourceChange["agent"],
      write: () => void | Promise<unknown>,
      operation = "source change",
    ) {
      const pending = once(events, agent, { signal: AbortSignal.timeout(4_000) });
      const [args] = await Promise.all([pending, Promise.resolve().then(write)]).catch(
        (error: unknown) => {
          throw new Error(`Did not observe ${agent} ${operation}`, { cause: error });
        },
      );
      return args[0] as CatalogSourceChange;
    },
  };
}

it("observes real Claude transcript creation, generated and explicit titles, and removal", async () => {
  const f = fixture();
  const projects = path.join(f.environment.CLAUDE_CONFIG_DIR, "projects");
  const bucket = path.join(projects, "opaque-native-project-directory");
  const workspace = path.join(f.root, "actual-workspace");
  mkdirSync(bucket, { recursive: true });
  mkdirSync(workspace);
  const id = "eedec861-8cfc-44fb-bc97-dbf9e4a5dd8f";
  const transcript = path.join(bucket, `${id}.jsonl`);
  const line = (value: Record<string, unknown>) =>
    JSON.stringify({ cwd: workspace, sessionId: id, ...value }) + "\n";
  const changed = { agent: "claude-code", paths: [transcript] };
  writeFileSync(
    path.join(bucket, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [
        { sessionId: id, projectPath: workspace, summary: "Indexed title", messageCount: 7 },
      ],
    }),
  );
  const reader = new ClaudeSessions(f.environment);
  f.start();
  expect(
    await f.write("claude-code", () =>
      writeFileSync(transcript, line({ type: "assistant", entrypoint: "cli" })),
    ),
  ).toMatchObject({ agent: "claude-code" });
  expect(reader.catalogTranscript(transcript)).toMatchObject({
    sessions: [
      {
        cwd: workspace,
        native_ref: id,
        title: "Indexed title",
        message_count: 7,
        origin: "interactive",
      },
    ],
    incomplete: false,
  });

  expect(
    await f.write("claude-code", () =>
      appendFileSync(
        transcript,
        line({ type: "assistant", message: { content: "Ordinary reply" } }),
      ),
    ),
  ).toEqual(changed);
  expect(reader.catalogTranscript(transcript).sessions[0]).toMatchObject({
    title: "Indexed title",
    message_count: 7,
  });

  expect(
    await f.write("claude-code", () =>
      appendFileSync(transcript, line({ type: "ai-title", aiTitle: "Generated title" })),
    ),
  ).toEqual(changed);
  const {
    sessions: [generated],
  } = reader.catalogTranscript(transcript);
  expect(generated).toMatchObject({ title: "Generated title", message_count: 7 });

  expect(
    await f.write("claude-code", () =>
      appendFileSync(transcript, line({ type: "custom-title", customTitle: "架构设计" })),
    ),
  ).toEqual(changed);
  const {
    sessions: [renamed],
  } = reader.catalogTranscript(transcript);
  expect(renamed).toMatchObject({ title: "架构设计", message_count: 7 });
  expect(Date.parse(renamed?.updated_at ?? "")).toBeGreaterThan(
    Date.parse(generated?.updated_at ?? ""),
  );

  expect(await f.write("claude-code", () => rmSync(transcript))).toEqual(changed);
  expect(reader.catalogTranscript(transcript)).toEqual({ sessions: [], incomplete: false });
});

it("detects the native sources created after the watch starts", async () => {
  const f = fixture();
  f.start();
  const project = path.join(
    f.environment.CLAUDE_CONFIG_DIR,
    "projects",
    "created",
    "session.jsonl",
  );
  expect(
    await f.write(
      "claude-code",
      () => {
        mkdirSync(path.dirname(project), { recursive: true });
        writeFileSync(project, "{}\n");
      },
      "root discovery",
    ),
  ).toEqual({ agent: "claude-code" });
  expect(
    await f.write(
      "claude-code",
      () => appendFileSync(project, JSON.stringify({ cwd: f.root, type: "assistant" }) + "\n"),
      "transcript append after root discovery",
    ),
  ).toEqual({ agent: "claude-code", paths: [project] });
});

it("observes metadata commits in SQLite WAL and a Codex rollout moved into the archive", async () => {
  const f = fixture();
  const devinFile = devinSessionDatabase(f.environment);
  mkdirSync(path.dirname(devinFile), { recursive: true });
  const codex = f.environment.CODEX_HOME;
  const sessions = path.join(codex, "sessions", "2026", "11", "27");
  const archive = path.join(codex, "archived_sessions");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(archive);
  const rollout = path.join(
    sessions,
    "rollout-2026-11-27-eedec861-8cfc-44fb-bc97-dbf9e4a5dd8f.jsonl",
  );
  writeFileSync(rollout, "{}\n");
  const codexFile = path.join(codex, "state_5.sqlite");
  const codexDb = new DatabaseSync(codexFile);
  cleanup.push(() => codexDb.close());
  const devinDb = new DatabaseSync(devinFile);
  cleanup.push(() => devinDb.close());
  codexDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT, title TEXT);");
  devinDb.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT, title TEXT);");
  f.start();

  const nativeCommit = (database: string, statement: string) =>
    promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite";
          const db = new DatabaseSync(process.argv[1]);
          db.exec(process.argv[2]);
          db.close();`,
        database,
        statement,
      ],
      { timeout: 3_000 },
    );
  expect(
    await f.write("devin", () =>
      nativeCommit(devinFile, "INSERT INTO sessions VALUES ('fixture', 'Title')"),
    ),
  ).toEqual({ agent: "devin" });
  expect(
    await f.write("codex", () =>
      nativeCommit(codexFile, "INSERT INTO threads VALUES ('fixture', 'Title')"),
    ),
  ).toEqual({ agent: "codex" });

  const archived = path.join(archive, path.basename(rollout));
  const moved = await f.write("codex", () => renameSync(rollout, archived));
  expect(moved.paths).toEqual(expect.arrayContaining([archived]));
});
