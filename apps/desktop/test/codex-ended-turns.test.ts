// @vitest-environment node
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CodexExternalTurns } from "../../../packages/backend/src/agents/codex/codex-external-turns";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const THREAD = "0199a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b";
const row = (at: string, type: string, turnId: string) =>
  JSON.stringify({ timestamp: at, type: "event_msg", payload: { type, turn_id: turnId } }) + "\n";

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
  it("lists the turns it ended, whoever ran them, reading only what it gained", () => {
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
    expect(turns.endedTurns(THREAD)).toEqual([
      {
        turnId: "t1",
        outcome: "completed",
        startedAt: "2026-11-13T10:00:00Z",
        endedAt: "2026-11-13T10:00:42Z",
      },
      {
        turnId: "t2",
        outcome: "cancelled",
        startedAt: "2026-11-13T10:01:00Z",
        endedAt: "2026-11-13T10:01:05Z",
      },
    ]);
    // A line still being written counts once it ends.
    const end = row("2026-11-13T10:03:00Z", "task_complete", "t3");
    appendFileSync(rollout, end.slice(0, 20));
    expect(turns.endedTurns(THREAD).map((turn) => turn.turnId)).toEqual(["t1", "t2"]);
    appendFileSync(rollout, end.slice(20));
    expect(turns.endedTurns(THREAD).at(-1)).toEqual({
      turnId: "t3",
      outcome: "completed",
      startedAt: "2026-11-13T10:02:00Z",
      endedAt: "2026-11-13T10:03:00Z",
    });
    expect(turns.endedTurns("not-a-thread")).toEqual([]);
    expect(turns.endedTurns("0199a3b4-5c6d-7e8f-9a0b-000000000000")).toEqual([]);
  });
});
