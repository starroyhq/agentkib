// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { force: true, recursive: true });
});

function transcript(rows: object[]) {
  const directory = mkdtempSync(join(tmpdir(), "agentkib-compaction-history-"));
  scratch.push(directory);
  const file = join(directory, "transcript.jsonl");
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return file;
}

const at = "2026-11-26T15:40:00Z";

it("keeps Claude boundaries in transcript order without projecting their summaries", () => {
  const message = (type: "user" | "assistant", content: string, fields = {}) => ({
    type,
    message: { role: type, content },
    ...fields,
  });
  const boundary = (trigger?: string, fields = {}) => ({
    type: "system",
    subtype: "compact_boundary",
    timestamp: at,
    compactMetadata: { trigger },
    ...fields,
  });
  const file = transcript([
    message("assistant", "Before", { uuid: "10000000-0000-4000-8000-000000000001" }),
    boundary("auto"),
    message("user", "Private compaction summary", { isCompactSummary: true }),
    boundary("manual", { isMeta: true }),
    boundary("auto", { isSidechain: true }),
    boundary("future", { timestamp: "invalid" }),
    { type: "system", subtype: "status", status: "compacting", timestamp: at },
    message("user", "After", { uuid: "10000000-0000-4000-8000-000000000002" }),
  ]);
  const { events } = new SessionPaging().read(file, null, 20, "claude-code");
  expect(events.map(({ kind, content }) => [kind, content])).toEqual([
    ["agent-message", "Before"],
    ["compaction-boundary", null],
    ["compaction-boundary", null],
    ["compaction-boundary", null],
    ["user-message", "After"],
  ]);
  expect(
    events.slice(1, 4).map(({ timestamp, compaction_trigger }) => [timestamp, compaction_trigger]),
  ).toEqual([
    [at, "auto"],
    [at, "manual"],
    [null, "unknown"],
  ]);
  for (const event of events.slice(1, 4))
    expect(event).toMatchObject({
      tool_name: null,
      tool_status: null,
      duration_ms: null,
      attachment_count: 0,
      truncated: false,
    });
});

it("reads Codex completion markers for both history modes and skips replacement payloads", () => {
  const row = (payload: object) => ({ timestamp: at, type: "event_msg", payload });
  const checkpoint = { timestamp: at, type: "compacted", payload: { message: "Internal summary" } };
  const completion = (id: string) =>
    row({ type: "item_completed", item: { type: "ContextCompaction", id }, turn_id: "turn-1" });
  const file = transcript([
    row({ type: "user_message", message: "Before" }),
    checkpoint,
    row({ type: "context_compacted" }),
    row({ type: "item_started", item: { type: "ContextCompaction", id: "pending" } }),
    checkpoint,
    completion("compaction-one"),
    completion("compaction-one"),
    row({ type: "agent_message", message: "After" }),
  ]);
  const paging = new SessionPaging();
  const newest = paging.read(file, null, 2, "codex");
  expect(newest.next_cursor).toBeTruthy();
  const older = paging.read(file, newest.next_cursor, 10, "codex");
  const events = [...older.events, ...newest.events];
  expect(events.map(({ kind, content }) => [kind, content])).toEqual([
    ["user-message", "Before"],
    ["compaction-boundary", null],
    ["compaction-boundary", null],
    ["agent-message", "After"],
  ]);
  expect(events[2]).toMatchObject({ id: "codex-compaction:compaction-one" });
  for (const event of events.slice(1, 3)) {
    expect(event).toMatchObject({ timestamp: at, compaction_trigger: "unknown" });
    expect(event.turn_id).toBeUndefined();
    expect(event.turn_meta).toBeUndefined();
  }
});

it("keeps a Codex turn outcome on its reply when the turn ends with compaction", () => {
  const row = (payload: object) => ({ timestamp: at, type: "event_msg", payload });
  const file = transcript([
    row({ type: "task_started", turn_id: "turn-1" }),
    row({ type: "agent_message", message: "Reply", turn_id: "turn-1" }),
    row({
      type: "item_completed",
      item: { type: "ContextCompaction", id: "compacted" },
      turn_id: "turn-1",
    }),
    row({ type: "task_complete", turn_id: "turn-1" }),
  ]);
  const { events } = new SessionPaging().read(file, null, 20, "codex");
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({
    content: "Reply",
    turn_id: "turn-1",
    turn_meta: { outcome: "completed" },
  });
  expect(events[1]).toMatchObject({ kind: "compaction-boundary" });
  expect(events[1]?.turn_meta).toBeUndefined();
  expect(events[1]?.turn_id).toBeUndefined();
});
