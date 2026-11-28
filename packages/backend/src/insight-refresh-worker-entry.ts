import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { Commands } from "./commands";
import { Git } from "./git";
import { InsightRefresh } from "./insight-refresh";
import { Insights } from "./insights";
import { Sql } from "./sql";

async function run(port: NonNullable<typeof parentPort>) {
  const { databasePath, cancelled } = workerData as {
    databasePath: string;
    cancelled: Int32Array;
  };
  const commands = new Commands();
  let database: DatabaseSync | undefined;
  const checkpoint = () => {
    if (Atomics.load(cancelled, 0) !== 0) throw new Error("Insights refresh was cancelled");
  };
  port.once("message", () => commands.close());
  try {
    checkpoint();
    // The owner has already migrated the shared WAL database. Open just a second connection.
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const sql = new Sql(database);
    const git = new Git(
      commands,
      (id) => {
        const row = sql.one("SELECT canonical_path FROM workspaces WHERE id=?", id);
        if (typeof row?.canonical_path !== "string") throw new Error("Workspace is unavailable");
        return row.canonical_path;
      },
      process.env,
    );
    const insights = new Insights(sql);
    const receipt = await new InsightRefresh(sql, commands, git, process.env, () =>
      insights.achievements(),
    ).refresh(checkpoint);
    port.postMessage({ receipt });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    commands.close();
    database?.close();
    port.close();
  }
}

if (parentPort) void run(parentPort);
