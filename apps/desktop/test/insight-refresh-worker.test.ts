// @vitest-environment node
import { appendFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { InsightRefreshWorker } from "../../../packages/backend/src/insight-refresh-worker";
import { BackendStore } from "../../../packages/backend/src/store";

it("coalesces concurrent requests and publishes incremental usage from the bundled worker", async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), "ak-insight-worker-"));
  const home = path.join(directory, "home");
  const codex = path.join(home, ".codex");
  const folder = path.join(codex, "sessions");
  const filename = path.join(folder, "rollout.jsonl");
  const database = path.join(directory, "agentkib.db");
  const worker = new InsightRefreshWorker(
    database,
    {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: codex,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      PATH: path.join(home, "bin"),
    },
    path.resolve("dist-electron/backend-insights.cjs"),
  );
  const store = new BackendStore(database);
  const day = "2026-11-28T12:00:00Z";
  const usage = (tokens: number) => ({
    type: "event_msg",
    timestamp: day,
    payload: { type: "token_count", info: { last_token_usage: { total_tokens: tokens } } },
  });
  const append = (...records: object[]) =>
    appendFile(filename, records.map((record) => JSON.stringify(record) + "\n").join(""));
  const totals = () =>
    store.sql.rows(
      "SELECT total_tokens,session_count FROM usage_events WHERE surface_agent='codex'",
    );
  const auditCount = () =>
    store.sql.one("SELECT COUNT(*) AS value FROM audit_events WHERE action='insights.refresh'")
      ?.value;
  try {
    await mkdir(folder, { recursive: true });
    await append({ type: "session_meta", payload: { cwd: directory } }, usage(17));
    const [first, same] = await Promise.all([worker.refresh(), worker.refresh()]);
    expect(first.status.state).toBe("succeeded");
    expect(first).toEqual(same);
    expect(totals()).toEqual([{ total_tokens: 17n, session_count: 1n }]);
    expect(auditCount()).toBe(1n);

    await append(usage(23));
    await expect(worker.refresh()).resolves.toMatchObject({ status: { state: "succeeded" } });
    expect(totals()).toEqual([{ total_tokens: 40n, session_count: 1n }]);
    expect(auditCount()).toBe(2n);
  } finally {
    await worker.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
