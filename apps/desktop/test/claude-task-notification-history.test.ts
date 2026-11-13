import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionPaging } from "../../../packages/backend/src/session-paging";
import { claudeTaskNotification } from "../../../packages/backend/src/claude-command-records";

// Rows follow what Claude Code 2.1.263, 2.1.299 and 2.1.322 wrote when a background command, a
// Monitor or a background agent ended and the CLI started a turn of its own (captured against a
// local model stub); ids and paths are synthetic.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
const workspace = "/home/tester/work/project";
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;
const at = (second: number) => new Date(Date.UTC(2026, 10, 13, 9, 0, second)).toISOString();
const base = () => ({ uuid: uuid(), timestamp: at(sequence), sessionId: "s", cwd: workspace });
const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  ...base(),
  type: "user",
  message: { role: "user", content },
  ...extra,
});
const assistant = (text: string) => ({
  ...base(),
  type: "assistant",
  message: { id: uuid(), role: "assistant", content: [{ type: "text", text }] },
});
const fromTask = { kind: "task-notification", producer: "session-task", runId: "run-1" };
const commandEnded = `<task-notification>
<task-id>bivan0lkj</task-id>
<tool-use-id>toolu_probe_1</tool-use-id>
<output-file>/home/tester/.tmp/tasks/bivan0lkj.output</output-file>
<status>completed</status>
<summary>Background command "Run the tests" completed (exit code 0)</summary>
</task-notification>`;
function read(rows: unknown[]) {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkib-claude-notifications-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "session.jsonl");
  writeFileSync(file, rows.map((value) => JSON.stringify(value)).join("\n") + "\n");
  return new SessionPaging().read(file, null, 100, "claude-code", {
    workspace,
    home: "/home/tester",
  }).events;
}

describe("background task notifications in Claude Code history", () => {
  it("shows the notice that starts the CLI's own turn as a line of the CLI's", () => {
    const notice = user(commandEnded, { origin: fromTask });
    const events = read([
      user("Run the tests in the background."),
      assistant("Started."),
      notice,
      assistant("The tests passed."),
    ]);
    expect(events.map(({ kind, content, cli_output }) => ({ kind, content, cli_output }))).toEqual([
      { kind: "user-message", content: "Run the tests in the background.", cli_output: undefined },
      { kind: "agent-message", content: "Started.", cli_output: undefined },
      {
        kind: "agent-message",
        content: 'Background command "Run the tests" completed (exit code 0)',
        cli_output: true,
      },
      { kind: "agent-message", content: "The tests passed.", cli_output: undefined },
    ]);
    // The row keeps its own identity.
    expect(events[2]!.id).toBe(notice.uuid);
  });

  it("reads Monitor events, agents and commands stopped with the previous process", () => {
    const monitor = `<task-notification>
<task-id>bvdib6a85</task-id>
<summary>Monitor event: "Watch the log"</summary>
<event>build finished</event>
</task-notification>`;
    const agent = `<task-notification>
<task-id>a2a92fc4b0cffee39</task-id>
<tool-use-id>toolu_kind_1</tool-use-id>
<status>completed</status>
<summary>Agent "Review the diff" finished</summary>
<note>A task-notification fires each time this agent stops.</note>
<result>Long result the reply relays.</result>
<usage><subagent_tokens>120</subagent_tokens></usage>
</task-notification>`;
    const stopped = `<task-notification>
<task-id>bwj98gwve</task-id>
<tool-use-id>toolu_probe_1</tool-use-id>
<status>stopped</status>
<summary>Background shell command didn't finish before the previous session ended</summary>
<note>No completion record was found for it in the previous session.</note>
</task-notification>`;
    expect(claudeTaskNotification(user(monitor, { origin: fromTask }))).toBe(
      'Monitor event: "Watch the log"\nbuild finished',
    );
    expect(claudeTaskNotification(user(agent, { origin: fromTask }))).toBe(
      'Agent "Review the diff" finished',
    );
    // 2.1.263 and 2.1.299 mark the origin without a producer.
    expect(claudeTaskNotification(user(stopped, { origin: { kind: "task-notification" } }))).toBe(
      "Background shell command didn't finish before the previous session ended",
    );
    // Several notices in one row read as one line each.
    expect(
      claudeTaskNotification(
        user([{ type: "text", text: `${commandEnded}\n${monitor}` }], {
          origin: fromTask,
        }),
      ),
    ).toBe(
      'Background command "Run the tests" completed (exit code 0)\nMonitor event: "Watch the log"\nbuild finished',
    );
  });

  it("leaves the person's messages alone", () => {
    // Quoting the tag, or a row another origin wrote, is a message.
    expect(claudeTaskNotification(user(`What does this mean?\n${commandEnded}`))).toBeNull();
    expect(
      claudeTaskNotification(
        user(commandEnded, { origin: { kind: "plugin", name: "agentkib-bridge" } }),
      ),
    ).toBeNull();
    expect(claudeTaskNotification(assistant(commandEnded))).toBeNull();
    // A transcript written without the origin field still reads a row that is only notices.
    expect(claudeTaskNotification(user(commandEnded))).toBe(
      'Background command "Run the tests" completed (exit code 0)',
    );
    const events = read([user(`Explain <task-notification> please`)]);
    expect(events).toMatchObject([
      { kind: "user-message", content: "Explain <task-notification> please" },
    ]);
  });
});
