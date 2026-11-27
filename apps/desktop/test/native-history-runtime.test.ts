// @vitest-environment node
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RUNTIME_METHODS } from "@agentkib/runtime-protocol";
import { expect, it } from "vitest";
import { BACKEND_INITIALIZE } from "../../../packages/backend/src/migration";
import { NativeHistoryWork } from "../../../packages/backend/src/native-history-work";
import { BackendStore } from "../../../packages/backend/src/store";
import { DesktopRuntimeHost } from "../electron/main/runtime-host";
import { createStdioTransport, type RuntimeTransport } from "../electron/main/runtime-transport";

const { createIsolatedWorkerEnvironment } = createRequire(import.meta.url)(
  "../scripts/backend-worker-smoke-environment.cjs",
) as { createIsolatedWorkerEnvironment(root: string): NodeJS.ProcessEnv };

it("labels an exited native worker without replacing a structured read failure", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ak-native-history-worker-"));
  const filename = path.join(root, "worker.cjs");
  const work = new NativeHistoryWork(filename);
  const read = () => work.read("devin-list", [path.join(root, "sessions.db"), null]);
  try {
    writeFileSync(
      filename,
      'require("node:worker_threads").parentPort.once("message", () => process.exit(1));',
    );
    await expect(read()).rejects.toMatchObject({
      name: "BackendTaskError",
      reason: "worker-failed",
    });

    writeFileSync(
      filename,
      `
        const { parentPort } = require("node:worker_threads");
        parentPort.on("message", ({ id }) => parentPort.postMessage({
          kind: "result",
          id,
          error: "Fixture read exceeded its deadline",
          reason: "deadline-exceeded",
        }));
      `,
    );
    await expect(read()).rejects.toMatchObject({
      name: "BackendTaskError",
      reason: "deadline-exceeded",
    });
  } finally {
    await work.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads changed Claude transcripts and their indexed titles through the bundled worker", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-native-claude-catalog-")));
  const projects = path.join(root, "claude", "projects");
  const directory = path.join(projects, "fixture");
  const work = new NativeHistoryWork(path.resolve("dist-electron/backend-handoff-read.cjs"));
  try {
    mkdirSync(directory, { recursive: true });
    const ids = ["first", "second"];
    const files = ids.map((id) => path.join(directory, id + ".jsonl"));
    for (const [position, id] of ids.entries())
      writeFileSync(
        files[position]!,
        JSON.stringify({
          type: "user",
          sessionId: id,
          cwd: root,
          message: { role: "user", content: "First prompt" },
        }) + "\n",
      );
    writeFileSync(
      path.join(directory, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: ids.map((id) => ({
          sessionId: id,
          projectPath: root,
          summary: "Title for " + id,
        })),
      }),
    );
    await expect(work.read("claude-catalog-transcripts", [projects, files])).resolves.toMatchObject(
      {
        incomplete: false,
        nativeRefs: ids,
        sessions: ids.map((id) => ({ native_ref: id, title: "Title for " + id })),
      },
    );
  } finally {
    await work.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads Devin through the bundled worker on both initializations and shuts down", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ak-native-history-")));
  const workspace = path.join(root, "workspace");
  const dataDir = path.join(root, "data");
  const devinDir = path.join(root, "devin");
  const environment = {
    ...createIsolatedWorkerEnvironment(root),
    DEVIN_SESSIONS_DIR: devinDir,
    PATH: path.join(root, "bin"),
  };
  let transport: RuntimeTransport | undefined;
  const host = new DesktopRuntimeHost({
    executablePath: process.execPath,
    args: [path.resolve("dist-electron/backend.cjs")],
    clientVersion: "test",
    maxRestarts: 0,
    createTransport: (options) => (transport = createStdioTransport({ ...options, environment })),
  });
  let database: DatabaseSync | undefined;
  try {
    for (const directory of [
      workspace,
      dataDir,
      path.join(devinDir, "cli"),
      path.join(root, "tmp"),
    ])
      mkdirSync(directory, { recursive: true });
    const reservation = createServer().listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const { port } = reservation.address() as AddressInfo;
    const closed = once(reservation, "close");
    reservation.close();
    await closed;
    writeFileSync(
      path.join(dataDir, "preferences.json"),
      JSON.stringify({
        session_index_enabled: true,
        session_content_search_enabled: false,
        mcp_network: { port, lan_enabled: false, lan_risk_accepted: false },
      }),
    );
    const store = new BackendStore(path.join(dataDir, "agentkib.db"));
    try {
      store.sql.run(
        "INSERT INTO workspaces(id,canonical_path,name,status,last_discovered_at) VALUES(?,?,?,?,?)",
        "workspace",
        workspace,
        "Fixture",
        "healthy",
        "2026-11-27T00:00:00Z",
      );
    } finally {
      store.close();
    }
    database = new DatabaseSync(path.join(devinDir, "cli", "sessions.db"));
    database.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL,
        title TEXT, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0);
    `);
    database
      .prepare("INSERT INTO sessions VALUES ('native-fixture', ?, ?, 1794400000, 1794400000, 0)")
      .run(workspace, "First title");

    const initialize = () => host.request(BACKEND_INITIALIZE, { dataDir });
    const refresh = () =>
      host.request(RUNTIME_METHODS.refreshWorkspaceSessions, {
        workspaceId: "workspace",
        force: true,
      });
    await host.start();
    await initialize();
    expect(await refresh()).toEqual(
      expect.arrayContaining([expect.objectContaining({ agent: "devin", title: "First title" })]),
    );

    database.prepare("UPDATE sessions SET title=?").run("Second title");
    await initialize();
    expect(await refresh()).toEqual(
      expect.arrayContaining([expect.objectContaining({ agent: "devin", title: "Second title" })]),
    );
    await host.stop();
    expect(transport?.hasExited).toBe(true);
  } finally {
    await host.stop();
    database?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 20_000);
