// @vitest-environment node
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import { plainTerminalText } from "../../../packages/backend/src/conversation-tools";
import { rpcFailure } from "../../../packages/backend/src/rpc";
import { readSessionHistory } from "../../../packages/backend/src/session-history-errors";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

const timestamp = "2026-11-25T00:00:00.000Z";
const row = (type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp, payload });
const event = (type: string, payload: Record<string, unknown> = {}) =>
  row("event_msg", { type, turn_id: "synthetic-turn", ...payload });

it("cleans terminal overwrites without changing ordinary lines, ANSI or CRLF", () => {
  expect(plainTerminalText("\u001b[31mfirst\u001b[0m\r\n10%\r20%\rfinished\nkeep\r\r\nlast")).toBe(
    "first\nfinished\nkeep\nlast",
  );
  const long = "x".repeat(150_000);
  expect(plainTerminalText(`${long}\nupdated\rvalue`)).toBe(`${long}\nvalue`);
});

it("distinguishes a missing transcript from an unreadable history path", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ak-missing-history-"));
  const paging = new SessionPaging();
  const read = (file: string) =>
    paging.readTranscript(file, null, 10, "codex", { workspace: directory }, false);
  try {
    const pending = join(directory, "pending.jsonl");
    await expect(read(pending)).rejects.toThrow(REMOTE_ERROR_CODES.historyReadMissing);
    await expect(read(directory)).rejects.toThrow(REMOTE_ERROR_CODES.transcriptUnreadable);
    writeFileSync(pending, event("agent_message", { message: "Restored history" }) + "\n");
    expect((await read(pending)).events.at(-1)?.content).toBe("Restored history");
  } finally {
    paging.clear();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reports a stale reason for a moved transcript only within the cursor's original session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ak-moved-history-"));
  const original = join(directory, "original.jsonl");
  const moved = join(directory, "moved.jsonl");
  const paging = new SessionPaging();
  const read = (file: string, cursor: string | null, scope: string) =>
    readSessionHistory(() =>
      paging.readTranscript(file, cursor, 1, "codex", { workspace: directory }, true, scope),
    );
  const wireError = async (file: string, cursor: string, scope: string) => {
    const failure = await read(file, cursor, scope).catch((error) => rpcFailure("read", error));
    expect(failure).toHaveProperty("error");
    return failure;
  };
  try {
    const records = [
      event("agent_message", { message: "Older reply" }),
      event("agent_message", { message: "Latest reply" }),
    ];
    writeFileSync(original, records.join("\n") + "\n");
    const scope = "native-session";
    const latest = await read(original, null, scope);
    expect(latest.next_cursor).toEqual(expect.any(String));
    const cursor = latest.next_cursor!;
    renameSync(original, moved);

    const invalid = { detail: REMOTE_ERROR_CODES.transcriptCursorInvalid };
    expect(await wireError(moved, cursor, scope)).toMatchObject({
      error: {
        code: -32000,
        data: { ...invalid, reason: REMOTE_ERROR_CODES.transcriptCursorStale },
      },
    });
    for (const [token, owner] of [
      [cursor, "another-session"],
      ["malformed-cursor", scope],
    ]) {
      const rejected = await wireError(moved, token, owner);
      expect(rejected).toMatchObject({ error: { code: -32000, data: invalid } });
      expect(rejected).not.toHaveProperty("error.data.reason");
    }

    const refreshed = await read(moved, null, scope);
    expect(refreshed.events.at(-1)?.content).toBe("Latest reply");
    expect((await read(moved, refreshed.next_cursor!, scope)).events[0]?.content).toBe(
      "Older reply",
    );
  } finally {
    paging.clear();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("keeps Codex history report provenance on its own persisted user message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ak-codex-report-history-"));
  const paginated = join(directory, "paginated.jsonl");
  const legacy = join(directory, "legacy.jsonl");
  const paging = new SessionPaging();
  const responseItem = (text: string, turnId = "synthetic-turn") =>
    row("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    });
  const nativeItem = (id: string, text: string, clientId?: string) =>
    event("item_completed", {
      item: {
        type: "UserMessage",
        id,
        client_id: clientId,
        content: [{ type: "text", text, text_elements: [] }],
      },
    });
  try {
    writeFileSync(
      paginated,
      [
        event("task_started"),
        responseItem("identical report text"),
        nativeItem("report-item", "identical report text", "report-request"),
        responseItem("identical report text"),
        nativeItem("ordinary-item", "identical report text"),
        responseItem("separated text"),
        row("world_state", { hidden: true }),
        nativeItem("separated-item", "separated text", "separated-request"),
        responseItem("different turn", "other-turn"),
        nativeItem("other-turn-item", "different turn", "other-turn-request"),
        event("task_complete"),
      ].join("\n") + "\n",
    );
    writeFileSync(
      legacy,
      [
        event("task_started"),
        responseItem("legacy report"),
        event("user_message", { message: "legacy report", client_id: "legacy-request" }),
      ].join("\n") + "\n",
    );
    const read = (file: string) =>
      paging.readTranscript(file, null, 100, "codex", { workspace: directory }, false);
    const claims = (page: Awaited<ReturnType<typeof read>>) =>
      page.events
        .filter(({ kind }) => kind === "user-message")
        .map(({ content, worker_report_request_id }) => [content, worker_report_request_id]);
    expect(claims(await read(paginated))).toEqual([
      ["identical report text", "report-request"],
      ["identical report text", undefined],
      ["separated text", undefined],
      ["different turn", undefined],
    ]);
    expect(claims(await read(legacy))).toEqual([["legacy report", "legacy-request"]]);
  } finally {
    paging.clear();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("reads large Codex pages without blocking the loop and refreshes an appended snapshot", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ak-large-history-"));
  const file = join(directory, "synthetic.jsonl");
  const paging = new SessionPaging();
  try {
    const records = [event("task_started")];
    for (let index = 0; index < 1_800; index++) {
      if (index % 4 === 0) {
        records.push(
          event("item_completed", {
            item: {
              type: "CommandExecution",
              id: `command-${index}`,
              command: "printf synthetic",
              status: "completed",
              exit_code: 0,
              aggregated_output: "x".repeat(4_600),
            },
          }),
        );
      } else {
        const text = "x".repeat(index === 1 ? 893_000 : 3_550);
        records.push(
          index % 4 === 1
            ? row("world_state", { text })
            : index % 4 === 2
              ? row("inter_agent_communication_metadata", { text })
              : row("token_usage_record", { text }),
        );
      }
    }
    records.push(event("agent_message", { message: "before append" }));
    records.push(event("thread_settings_applied", { settings: { model: "fixture" } }));
    // Ignored metadata must not upset history's number or turn validation.
    records.push('{"type":"world_state","payload":{"irrelevant":1e999}}');
    const transcript = records.join("\n") + "\n";
    expect(Buffer.byteLength(transcript)).toBeGreaterThan(7 * 1024 * 1024);
    writeFileSync(file, transcript);
    const read = () =>
      paging.readTranscript(file, null, 100, "codex", { workspace: directory }, false);
    const start = performance.now();
    let last = start;
    let longestGap = 0;
    const measure = () => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - last);
      last = now;
    };
    const sampling = setInterval(measure, 10);
    const loading = read();
    const heartbeat = setImmediate().then(() => performance.now() - start);
    const page = await loading.finally(() => {
      clearInterval(sampling);
      measure();
    });
    expect(await heartbeat).toBeLessThan(500);
    expect(longestGap).toBeLessThan(500);
    expect(performance.now() - start).toBeLessThan(1_500);
    expect(page.events).toHaveLength(100);
    expect(page.events.at(-1)?.content).toBe("before append");
    expect(page.warnings).toEqual([]);
    expect(await read()).toEqual(page);

    appendFileSync(file, event("agent_message", { message: "after append" }) + "\n");
    expect((await read()).events.at(-1)?.content).toBe("after append");
    writeFileSync(file, transcript.replace("before append", "after rewrite"));
    expect((await read()).events.at(-1)?.content).toBe("after rewrite");
  } finally {
    paging.clear();
    rmSync(directory, { recursive: true, force: true });
  }
});
