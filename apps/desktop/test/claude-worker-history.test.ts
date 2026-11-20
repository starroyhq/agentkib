import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import {
  claudeWorkerHistoryTurns,
  claudeWorkerUnobservedTurns,
} from "../../../packages/backend/src/claude-worker-turns";

it("recovers bounded, confirmed parent turns and does not duplicate live completions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "agentkib-claude-worker-history-"));
  try {
    const file = path.join(root, "fixture.jsonl");
    const sessionId = randomUUID();
    const real = randomUUID();
    const reply = randomUUID();
    const marker = randomUUID();
    const second = randomUUID();
    const previous = "2026-01-01T10:00:00Z";
    const firstEnd = "2026-01-01T10:01:00Z";
    const secondEnd = "2026-01-01T10:06:00Z";
    const thirdEnd = "2026-01-01T10:08:00Z";
    const rows = [
      { sessionId, type: "user", uuid: real, timestamp: previous, message: { content: "Work" } },
      { sessionId, type: "assistant", uuid: reply, message: { content: "Done" } },
      { sessionId, type: "system", subtype: "turn_duration", uuid: marker, timestamp: firstEnd },
      {
        sessionId,
        type: "system",
        subtype: "turn_duration",
        turn_id: second,
        durationMs: 120_000,
        timestamp: secondEnd,
        error: "fixture",
      },
      { sessionId, type: "assistant", uuid: randomUUID(), message: { content: "Still working" } },
      {
        sessionId,
        type: "system",
        subtype: "turn_duration",
        uuid: randomUUID(),
        durationMs: 1000,
        timestamp: thirdEnd,
        isSidechain: true,
      },
      {
        sessionId: randomUUID(),
        type: "system",
        subtype: "turn_duration",
        uuid: randomUUID(),
        durationMs: 1000,
        timestamp: thirdEnd,
      },
      // The last record is not a complete native record yet.
      {
        sessionId,
        type: "system",
        subtype: "turn_duration",
        uuid: randomUUID(),
        durationMs: 1000,
        timestamp: thirdEnd,
      },
    ];
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
    const turns = claudeWorkerHistoryTurns(file, sessionId);
    expect(turns).toMatchObject([
      {
        turnId: `claude-history:${marker}`,
        outcome: "completed",
        startedAt: previous,
        endedAt: firstEnd,
        historyTurnId: reply,
      },
      {
        turnId: second,
        outcome: "failed",
        startedAt: "2026-01-01T10:04:00.000Z",
        endedAt: secondEnd,
      },
    ]);
    expect(
      claudeWorkerUnobservedTurns(turns, [
        {
          turnId: randomUUID(),
          outcome: "completed",
          startedAt: null,
          endedAt: "2026-01-01T10:00:59.900Z",
        },
      ]),
    ).toEqual([turns[1]]);
    expect(claudeWorkerUnobservedTurns(turns, [{ ...turns[1]!, endedAt: thirdEnd }])).toEqual([
      turns[0],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
