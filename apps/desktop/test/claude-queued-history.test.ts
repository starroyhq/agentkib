// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeWorkerHistoryTurns } from "../../../packages/backend/src/agents/claude/claude-worker-turns";
import { SessionPaging } from "../../../packages/backend/src/session-paging";
import {
  bindWorkerReportMessage,
  projectWorkerReports,
  rememberWorkerReport,
} from "../../../packages/backend/src/worker-report-ledger";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = id(100);
const body = "Check the exit status too.";
const row = (n: number) => ({
  uuid: id(n),
  parentUuid: n === 1 ? null : id(n - 1),
  sessionId,
  timestamp: new Date(Date.UTC(2026, 10, 26, 8, 0, n)).toISOString().replace(".000Z", "Z"),
});
const prompt = (n: number, content: unknown, extra = {}) => ({
  ...row(n),
  type: "user",
  message: { role: "user", content },
  ...extra,
});
const reply = (n: number, content: unknown) => ({
  ...row(n),
  type: "assistant",
  message: { role: "assistant", content },
});
const call = { type: "tool_use", id: "toolu_test", name: "Bash", input: { command: "true" } };
const tool = reply(2, [call]);
const output = prompt(3, [{ type: "tool_result", tool_use_id: "toolu_test", content: "ok" }]);
const enqueue = { type: "queue-operation", operation: "enqueue", content: body, sessionId };
const remove = {
  type: "queue-operation",
  operation: "remove",
  reason: "absorbed_mid_turn",
  deliveryId: id(101),
  commandUuid: id(102),
  sessionId,
};

// The tool-result and attachment are separate native conversation rows. The queue rows
// document delivery, but the rendered reminder is for the model rather than the user bubble.
const terminal = {
  ...row(4),
  type: "attachment",
  entrypoint: "cli",
  attachment: {
    type: "queued_command",
    prompt: body,
    commandMode: "prompt",
    origin: { kind: "human" },
    humanTurn: true,
    delivery_id: remove.deliveryId,
    source_uuid: remove.commandUuid,
  },
  renderedRole: "system",
  rendered: `<system-reminder>${body}</system-reminder>`,
};
const managed = {
  ...row(4),
  type: "attachment",
  entrypoint: "sdk-cli",
  attachment: {
    type: "queued_command",
    prompt: body,
    commandMode: "prompt",
    rowSource: "local",
    hostsOwnTurn: true,
    delivery_id: remove.deliveryId,
    source_uuid: remove.commandUuid,
  },
};
const bridgeNote = {
  ...row(4),
  type: "attachment",
  attachment: {
    type: "plugin_note",
    plugin: "agentkib-bridge",
    rowUuid: id(4),
    content: [body],
    sentAs: "system",
  },
  renderedRole: "system",
  rendered: `<system-reminder>${body}</system-reminder>`,
};
const bridgeOrigin = { kind: "plugin", name: "agentkib-bridge" };

function transcript(...records: unknown[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkib-claude-queued-history-"));
  roots.push(directory);
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

describe("Claude queued user messages in persisted history", () => {
  it.each([
    ["terminal input", terminal, [enqueue, remove], []],
    ["managed SDK input", managed, [enqueue], [remove]],
    ["terminal bridge note", bridgeNote, [], []],
  ])("reads %s once in place across history pages and reopens", (_, interrupt, before, after) => {
    const file = transcript(
      prompt(1, "Run the checks."),
      tool,
      ...before,
      output,
      ...after,
      interrupt,
      reply(5, "The exit status was zero."),
      { ...row(6), type: "system", subtype: "turn_duration", durationMs: 5_000 },
    );
    const paging = new SessionPaging();
    const latest = paging.read(file, null, 2, "claude-code");
    expect(latest.next_cursor).toBeTruthy();
    const older = paging.read(file, latest.next_cursor, 2, "claude-code");
    const expected = [
      { id: id(1), kind: "user-message", content: "Run the checks." },
      { id: "toolu_test", kind: "tool-summary", tool_status: "completed" },
      { id: id(4), kind: "user-message", content: body, timestamp: row(4).timestamp },
      { id: id(5), kind: "agent-message", content: "The exit status was zero." },
    ];
    expect([...older.events, ...latest.events]).toMatchObject(expected);
    expect([...older.events, ...latest.events].map(({ turn_id }) => turn_id)).toEqual(
      expected.map(() => id(1)),
    );
    expect(new SessionPaging().read(file, null, 10, "claude-code").events).toMatchObject(expected);
    expect(claudeWorkerHistoryTurns(file, sessionId)).toEqual([
      {
        turnId: `claude-history:${id(6)}`,
        outcome: "completed",
        startedAt: row(1).timestamp,
        endedAt: row(6).timestamp,
        historyTurnId: id(5),
      },
    ]);
  });

  it("shows a queued prompt that opens the next turn only as its ordinary user row", () => {
    const file = transcript(
      prompt(1, "Run the checks."),
      enqueue,
      { type: "queue-operation", operation: "dequeue", sessionId },
      reply(2, "Checks passed."),
      prompt(3, body),
      reply(4, "The status was zero."),
    );
    const events = new SessionPaging().read(file, null, 10, "claude-code").events;
    expect(
      events
        .filter((event) => event.kind === "user-message")
        .map(({ id, content }) => ({ id, content })),
    ).toEqual([
      { id: id(1), content: "Run the checks." },
      { id: id(3), content: body },
    ]);
  });

  it("ignores undelivered commands and queued attachments from non-human origins", () => {
    const automation = {
      ...terminal,
      attachment: { ...terminal.attachment, origin: { kind: "task-notification" } },
    };
    const rewritten = {
      ...managed,
      attachment: { ...managed.attachment, promptRewritten: true },
    };
    const held = {
      ...bridgeNote,
      attachment: { ...bridgeNote.attachment, content: [], heldContent: [body] },
    };
    const unrelated = {
      ...bridgeNote,
      attachment: { ...bridgeNote.attachment, plugin: "unrelated-plugin" },
    };
    const file = transcript(
      prompt(1, "Run the checks."),
      tool,
      output,
      enqueue,
      automation,
      rewritten,
      held,
      unrelated,
    );
    const events = new SessionPaging().read(file, null, 10, "claude-code").events;
    expect(events.map(({ kind, content }) => [kind, content])).toEqual([
      ["user-message", "Run the checks."],
      ["tool-summary", null],
    ]);
  });

  it("preserves completion on the last assistant text even when an insertion follows it", () => {
    const file = transcript(
      prompt(1, "Run the checks."),
      reply(2, [{ type: "text", text: "Running the checks." }, call]),
      output,
      terminal,
      { ...row(5), type: "system", subtype: "turn_duration", durationMs: 4_000 },
    );
    const events = new SessionPaging().read(file, null, 10, "claude-code").events;
    expect(events.find((event) => event.id === id(2))?.turn_meta).toEqual({
      outcome: "completed",
      duration_ms: 4_000,
    });
  });

  it("keeps an ordinary bridge prompt as the boundary of the next turn", () => {
    const file = transcript(
      prompt(1, "Run the checks."),
      reply(2, "Starting the checks."),
      prompt(3, body, { origin: { kind: "plugin", name: "agentkib-bridge", asUser: true } }),
      reply(4, [call]),
      { ...output, ...row(5) },
      { ...row(6), type: "system", subtype: "turn_duration", durationMs: 3_000 },
    );
    const events = new SessionPaging().read(file, null, 10, "claude-code").events;
    expect(events.some((event) => event.turn_meta)).toBe(false);
    expect(events.find((event) => event.id === id(3))).toMatchObject({
      kind: "user-message",
      content: body,
    });
  });

  it.each([
    ["older", { isMeta: true, origin: bridgeOrigin }],
    ["current", { origin: { ...bridgeOrigin, asUser: true } }],
  ])("starts a separate turn for the %s bridge report", (_, metadata) => {
    const reportId = id(101);
    const text = "[AgentKib report] Worker finished the checks.";
    const nativeText = `${text}\n\n[AgentKib report ID: ${reportId}]`;
    const part = {
      kind: "turn-ended" as const,
      workerSessionId: id(102),
      workerName: "fixture-worker",
      agent: "codex",
      occurredAt: row(3).timestamp,
      outcome: "completed" as const,
      requiresUser: false,
      reply: "All checks passed.",
    };
    const file = transcript(
      prompt(1, nativeText),
      reply(2, "Starting the checks."),
      prompt(3, [{ type: "text", text: nativeText }], metadata),
      {
        ...row(4),
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "auto" },
      },
      reply(5, "I received the Worker report."),
      { ...row(6), type: "system", subtype: "turn_duration", durationMs: 3_000 },
    );
    const dataDir = path.dirname(file);
    rememberWorkerReport(dataDir, sessionId, { reportId, text, parts: [{ text, meta: part }] });
    bindWorkerReportMessage(
      dataDir,
      sessionId,
      { type: "native-message", id: id(3) },
      [reportId],
      nativeText,
    );
    const paging = new SessionPaging();
    const latest = paging.read(file, null, 1, "claude-code");
    expect(latest.next_cursor).toBeTruthy();
    const older = paging.read(file, latest.next_cursor, 4, "claude-code");
    const expected = [
      { id: id(1), kind: "user-message", content: nativeText, turn_id: id(1) },
      { id: id(2), kind: "agent-message", turn_id: id(1) },
      {
        id: id(3),
        kind: "user-message",
        content: nativeText,
        turn_id: id(3),
        worker_reports: { reportId, parts: [part] },
      },
      { id: `claude-compaction:${id(4)}`, kind: "compaction-boundary", compaction_trigger: "auto" },
      {
        id: id(5),
        kind: "agent-message",
        content: "I received the Worker report.",
        turn_id: id(3),
        turn_meta: { outcome: "completed", duration_ms: 3_000 },
      },
    ];
    for (const events of [
      [...older.events, ...latest.events],
      new SessionPaging().read(file, null, 10, "claude-code").events,
    ]) {
      const projected = projectWorkerReports(dataDir, sessionId, { events }).events;
      expect(projected).toMatchObject(expected);
      expect(projected.filter((event) => event.worker_reports).map(({ id }) => id)).toEqual([
        id(3),
      ]);
      expect(projected[3]).not.toHaveProperty("turn_id");
      expect(projected[3]).not.toHaveProperty("turn_meta");
    }
  });
});
