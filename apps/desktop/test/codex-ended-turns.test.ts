// @vitest-environment node
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { CodexExternalTurns } from "../../../packages/backend/src/agents/codex/codex-external-turns";
import { acquirePortableFileLease } from "../../../packages/backend/src/managed-session-lock";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const THREAD = "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";
const row = (at: string, type: string, turnId: string, fields?: Record<string, unknown>) =>
  JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type, turn_id: turnId, ...fields },
  }) + "\n";

/** A Codex home whose thread database points at one rollout. */
function codexHome() {
  const home = mkdtempSync(path.join(tmpdir(), "ak-ended-turns-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const rollout = path.join(home, "sessions", `rollout-${THREAD}.jsonl`);
  mkdirSync(path.dirname(rollout), { recursive: true });
  writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { id: THREAD } }) + "\n");
  const db = new DatabaseSync(path.join(home, "state_5.sqlite"));
  try {
    db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)");
    db.prepare("INSERT INTO threads VALUES(?,?)").run(THREAD, rollout);
  } finally {
    db.close();
  }
  return { home, rollout };
}

describe("a Codex thread's ended turns, from its rollout", () => {
  it("lists the turns it ended, whoever ran them, reading only what it gained", async () => {
    const { home, rollout } = codexHome();
    appendFileSync(
      rollout,
      row("2026-11-13T10:00:00Z", "task_started", "t1") +
        row("2026-11-13T10:00:42Z", "task_complete", "t1") +
        row("2026-11-13T10:01:00Z", "task_started", "t2") +
        row("2026-11-13T10:01:05Z", "turn_aborted", "t2") +
        row("2026-11-13T10:02:00Z", "task_started", "t3"),
    );
    const turns = new CodexExternalTurns(() => home);
    expect(await turns.endedTurns(THREAD)).toEqual([
      {
        turnId: "t1",
        outcome: "completed",
        startedAt: "2026-11-13T10:00:00Z",
        endedAt: "2026-11-13T10:00:42Z",
        superseded: true,
      },
      {
        turnId: "t2",
        outcome: "cancelled",
        startedAt: "2026-11-13T10:01:00Z",
        endedAt: "2026-11-13T10:01:05Z",
        superseded: true,
      },
    ]);
    // A line still being written counts once it ends.
    const end = row("2026-11-13T10:03:00Z", "task_complete", "t3");
    appendFileSync(rollout, end.slice(0, 20));
    expect((await turns.endedTurns(THREAD)).map((turn) => turn.turnId)).toEqual(["t1", "t2"]);
    appendFileSync(rollout, end.slice(20));
    expect((await turns.endedTurns(THREAD)).at(-1)).toEqual({
      turnId: "t3",
      outcome: "completed",
      startedAt: "2026-11-13T10:02:00Z",
      endedAt: "2026-11-13T10:03:00Z",
    });
    expect(await turns.endedTurns("not-a-thread")).toEqual([]);
    expect(await turns.endedTurns("0199a3b4-5c6d-7e8f-9a0b-000000000000")).toEqual([]);
  });

  it("marks an older completion only when a distinct later start is recorded", async () => {
    const { home, rollout } = codexHome();
    const turns = new CodexExternalTurns(() => home);
    appendFileSync(
      rollout,
      row("2026-11-13T10:00:00Z", "task_started", "old") +
        row("2026-11-13T10:00:42Z", "task_complete", "old", { last_agent_message: null }),
    );
    expect((await turns.endedTurns(THREAD))[0]).not.toHaveProperty("superseded");

    appendFileSync(
      rollout,
      row("2026-11-13T10:05:00Z", "task_started", "old") +
        row("2026-11-13T09:59:00Z", "task_started", "replayed-earlier"),
    );
    expect((await turns.endedTurns(THREAD))[0]).not.toHaveProperty("superseded");

    const later = row("2026-11-13T10:05:10Z", "task_started", "new");
    appendFileSync(rollout, later.slice(0, -1));
    expect((await turns.endedTurns(THREAD))[0]).not.toHaveProperty("superseded");
    appendFileSync(rollout, "\n");
    expect(await turns.endedTurns(THREAD)).toEqual([
      {
        turnId: "old",
        outcome: "completed",
        startedAt: "2026-11-13T10:00:00Z",
        endedAt: "2026-11-13T10:00:42Z",
        superseded: true,
      },
    ]);
  });

  it("retains the final reply and failure information from native completion markers", async () => {
    const { home, rollout } = codexHome();
    const turns = new CodexExternalTurns(() => home);
    appendFileSync(
      rollout,
      row("2026-11-13T10:00:00Z", "task_started", "result") +
        row("2026-11-13T10:01:00Z", "task_complete", "result", { last_agent_message: "Done." }) +
        row("2026-11-13T10:02:00Z", "task_started", "failed") +
        row("2026-11-13T10:03:00Z", "task_complete", "failed", {
          error: {},
          last_agent_message: " ",
        }) +
        row("2026-11-13T10:04:00Z", "task_started", "new") +
        row("2026-11-13T10:01:00Z", "task_complete", "result"),
    );
    expect(await turns.endedTurns(THREAD)).toEqual([
      {
        turnId: "result",
        outcome: "completed",
        startedAt: "2026-11-13T10:00:00Z",
        endedAt: "2026-11-13T10:01:00Z",
        superseded: true,
        replyText: "Done.",
      },
      {
        turnId: "failed",
        outcome: "failed",
        startedAt: "2026-11-13T10:02:00Z",
        endedAt: "2026-11-13T10:03:00Z",
        superseded: true,
      },
    ]);
  });
});

describe("large external Codex rollouts", () => {
  it("reads new row types and hundreds of item completions without blocking observation", async () => {
    const { home, rollout } = codexHome();
    const locks = path.join(home, "thread-writer-locks");
    mkdirSync(locks);
    cleanups.unshift(acquirePortableFileLease(path.join(locks, `${THREAD}.lock`)));
    const now = new Date().toISOString();
    const running = "large-turn";
    const newRows = [
      ...["world_state", "inter_agent_communication_metadata", "token_usage_record"].map(
        (type) =>
          JSON.stringify({
            timestamp: now,
            type,
            payload: { type: "task_complete", turn_id: running, data: "x".repeat(873 * 1024) },
          }) + "\n",
      ),
      row(now, "thread_settings_applied", running, { change: "settings" }),
    ];
    const item = row(now, "item_completed", running, {
      item: { type: "CommandExecution", id: "cmd", output: "x".repeat(10 * 1024) },
    });
    appendFileSync(
      rollout,
      item.repeat(400) +
        row(now, "task_started", running) +
        newRows.join("") +
        item.repeat(93) +
        row(now, "agent_message", running, { message: "worker output" }),
    );
    const turns = new CodexExternalTurns(() => home);
    const started = performance.now();
    let finished = false;
    const reading = turns.workerTurnOf(THREAD).then((result) => {
      finished = true;
      return result;
    });
    await setImmediate();
    expect(finished).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
    const first = await reading;
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(first).toMatchObject({
      externalTurn: { turnId: running, status: "running" },
      workerProgress: expect.stringMatching(/:\d+$/),
      commands: [],
    });
    expect(await turns.workerTurnOf(THREAD)).toEqual(first);

    const end = row(now, "task_complete", running, { last_agent_message: "done" });
    appendFileSync(rollout, end.slice(0, 20));
    expect(await turns.workerTurnOf(THREAD)).not.toHaveProperty("commands");
    appendFileSync(rollout, end.slice(20));
    expect(await turns.workerTurnOf(THREAD)).toBeNull();
  });

  it("invalidates the cached turns on same-size edits, truncation and replacement", async () => {
    const { home, rollout } = codexHome();
    const turns = new CodexExternalTurns(() => home);
    const at = "2026-11-13T10:00:00Z";
    writeFileSync(rollout, row(at, "task_complete", "old"));
    expect((await turns.endedTurns(THREAD))[0]?.turnId).toBe("old");

    writeFileSync(rollout, row(at, "task_complete", "new"));
    // Coarse filesystem timestamps must never make this fixture look unchanged.
    utimesSync(rollout, new Date(at), new Date(at));
    expect((await turns.endedTurns(THREAD))[0]?.turnId).toBe("new");

    writeFileSync(rollout, row(at, "task_complete", "rewritten-much-longer"));
    expect((await turns.endedTurns(THREAD)).map((turn) => turn.turnId)).toEqual([
      "rewritten-much-longer",
    ]);

    writeFileSync(rollout, "");
    expect(await turns.endedTurns(THREAD)).toEqual([]);

    writeFileSync(rollout + ".replacement", row(at, "task_complete", "replacement"));
    renameSync(rollout + ".replacement", rollout);
    expect((await turns.endedTurns(THREAD))[0]?.turnId).toBe("replacement");
  });
});
