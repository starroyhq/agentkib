// @vitest-environment node
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { plainTerminalText } from "../../../packages/backend/src/conversation-tools";
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
