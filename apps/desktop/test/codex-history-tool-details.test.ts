import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_PAGE_BYTES } from "../../../packages/backend/src/session-events";
import { SessionPaging } from "../../../packages/backend/src/session-paging";

// Synthetic rollouts in the current Codex layout: response items carry the
// turn in `internal_chat_message_metadata_passthrough`, executed work is
// written as `event_msg/item_completed`. No real session content is used.
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const workspace = "/home/tester/work/project";
const context = { workspace, home: "/home/tester" };
const at = (second: number) => new Date(Date.UTC(2026, 9, 27, 8, 0, second)).toISOString();
const pass = (turn: string) => ({ internal_chat_message_metadata_passthrough: { turn_id: turn } });
let clock = 0;
const row = (type: string, payload: Record<string, unknown>) => ({
  timestamp: at(clock++),
  type,
  payload,
});
const user = (turn: string, text: string) =>
  row("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
    ...pass(turn),
  });
const agent = (turn: string, text: string, phase: string) =>
  row("response_item", {
    type: "message",
    role: "assistant",
    phase,
    content: [{ type: "output_text", text }],
    ...pass(turn),
  });
const call = (turn: string, id: string, name: string, type = "custom_tool_call") =>
  row("response_item", {
    type,
    call_id: id,
    name,
    status: "completed",
    ...(type === "custom_tool_call" ? { input: "code" } : { arguments: "{}" }),
    ...pass(turn),
  });
const output = (turn: string, id: string, type = "custom_tool_call_output") =>
  row("response_item", { type, call_id: id, output: "ok", ...pass(turn) });
const item = (turn: string, value: Record<string, unknown>) =>
  row("event_msg", {
    type: "item_completed",
    thread_id: "thread",
    turn_id: turn,
    item: value,
    started_at_ms: 1_000,
    completed_at_ms: 1_250,
  });
const command = (id: string, script: string, exit = 0) => ({
  type: "CommandExecution",
  id,
  command: ["/bin/zsh", "-lc", script],
  cwd: workspace,
  parsed_cmd: [{ type: "unknown", cmd: script }],
  source: "unified_exec_startup",
  status: exit === 0 ? "completed" : "failed",
  aggregated_output: exit === 0 ? "ok\n" : "1 failed\n",
  exit_code: exit,
  duration: { secs: 1, nanos: 0 },
});
const patch = (id: string, file = "src/app.ts") => ({
  type: "FileChange",
  id,
  changes: {
    [`${workspace}/${file}`]: {
      type: "update",
      unified_diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n",
      move_path: null,
    },
  },
  status: "completed",
  stdout: "",
  stderr: "",
});
function rollout(rows: unknown[]): string {
  const directory = mkdtempSync(path.join(tmpdir(), "agentkib-codex-tools-"));
  directories.push(directory);
  const file = path.join(directory, "rollout.jsonl");
  const meta = {
    timestamp: at(0),
    type: "session_meta",
    payload: { id: "thread", cwd: workspace },
  };
  writeFileSync(file, [meta, ...rows].map((value) => JSON.stringify(value)).join("\n") + "\n");
  return file;
}
function read(
  file: string,
  limit = 100,
  cursor: string | null = null,
  paging = new SessionPaging(),
) {
  return paging.read(file, cursor, limit, "codex", context);
}
function turnRows(turn: string, duration = 127_000) {
  return [
    row("turn_context", { turn_id: turn }),
    row("event_msg", { type: "task_started", turn_id: turn }),
    user(turn, "Fix the failing test"),
    agent(turn, "Looking at the test.", "commentary"),
    call(turn, `exec-${turn}`, "exec"),
    item(turn, command(`cmd-${turn}`, "pnpm test", 1)),
    item(turn, patch(`patch-${turn}`)),
    output(turn, `exec-${turn}`),
    call(turn, `mcp-${turn}`, "js", "function_call"),
    item(turn, {
      type: "McpToolCall",
      id: `mcp-${turn}`,
      server: "docs",
      tool: "lookup",
      arguments: "{}",
      status: "completed",
      result: { content: [{ type: "text", text: "two hits" }], isError: false },
      duration: { secs: 0, nanos: 300_000_000 },
    }),
    output(turn, `mcp-${turn}`, "function_call_output"),
    item(turn, {
      type: "Reasoning",
      id: `reasoning-${turn}`,
      summary_text: "hidden",
      raw_content: "hidden",
    }),
    agent(turn, "Fixed.", "final_answer"),
    row("event_msg", {
      type: "task_complete",
      turn_id: turn,
      duration_ms: duration,
      last_agent_message: "Fixed.",
      error: null,
    }),
  ];
}

describe("Codex history tool details", () => {
  it("shows code-mode work as items under their wrapper and keeps the turn duration", () => {
    const page = read(rollout(turnRows("t1")));
    expect(page.warnings).toEqual([]);
    expect(
      page.events.map((event) => [event.kind, event.tool_name, event.tool_status, event.content]),
    ).toEqual([
      ["user-message", null, null, "Fix the failing test"],
      ["agent-message", null, null, "Looking at the test."],
      ["tool-summary", "exec", "completed", null],
      ["tool-summary", "shell", "failed", null],
      ["tool-summary", "apply_patch", "completed", null],
      ["tool-summary", "lookup", "completed", null],
      ["agent-message", null, null, "Fixed."],
    ]);
    const [, , wrapper, shell, edit, mcp, final] = page.events;
    expect(wrapper!.tool).toEqual({ kind: "other", children: 2 });
    expect(shell).toMatchObject({ id: "codex-item:cmd-t1", turn_id: "t1", duration_ms: 1000 });
    expect(shell!.tool).toMatchObject({
      kind: "execute",
      title: "pnpm test",
      content: [{ type: "terminal", command: "pnpm test", output: "1 failed\n", exit_code: 1 }],
    });
    expect(edit!.tool).toMatchObject({
      kind: "edit",
      title: "src/app.ts",
      content: [{ type: "diff", path: "src/app.ts", added: 2, removed: 1 }],
    });
    expect(mcp!.tool).toMatchObject({
      title: "docs · lookup",
      mcp: { server: "docs", tool: "lookup" },
    });
    expect(mcp!.duration_ms).toBe(300);
    expect(final!.turn_meta).toEqual({ outcome: "completed", duration_ms: 127_000 });
    expect(page.events.filter((event) => event.turn_meta)).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain("hidden");
  });

  it("does not guess a parent when two calls of the turn are open", () => {
    const turn = "t2";
    const page = read(
      rollout([
        user(turn, "Run both"),
        call(turn, "exec-a", "exec"),
        call(turn, "exec-b", "exec"),
        item(turn, command("cmd-a", "pnpm lint")),
        output(turn, "exec-a"),
        output(turn, "exec-b"),
        agent(turn, "Both done.", "final_answer"),
      ]),
    );
    const wrappers = page.events.filter((event) => event.tool_name === "exec");
    expect(wrappers).toHaveLength(2);
    expect(wrappers.every((event) => event.tool?.children === undefined)).toBe(true);
    expect(page.events.find((event) => event.id === "codex-item:cmd-a")?.tool?.title).toBe(
      "pnpm lint",
    );
  });

  it("keeps nesting and turn data across page boundaries", () => {
    const file = rollout(turnRows("t3", 9_000));
    const paging = new SessionPaging();
    const first = read(file, 2, null, paging);
    expect(first.events.map((event) => [event.kind, event.tool_name])).toEqual([
      ["tool-summary", "lookup"],
      ["agent-message", null],
    ]);
    expect(first.events.at(-1)?.turn_meta).toEqual({ outcome: "completed", duration_ms: 9_000 });
    const events = [...first.events];
    let cursor = first.next_cursor;
    while (cursor) {
      const next = read(file, 2, cursor, paging);
      events.unshift(...next.events);
      cursor = next.next_cursor;
    }
    expect(events.find((event) => event.tool_name === "exec")?.tool).toEqual({
      kind: "other",
      children: 2,
    });
    expect(events.filter((event) => event.kind === "tool-summary")).toHaveLength(4);
  });

  it("marks an aborted turn on its last item", () => {
    const turn = "t4";
    const page = read(
      rollout([
        user(turn, "Start"),
        call(turn, "exec-x", "exec"),
        item(turn, command("cmd-x", "sleep 100", 130)),
        row("event_msg", {
          type: "turn_aborted",
          turn_id: turn,
          reason: "interrupted",
          duration_ms: 4_200,
        }),
      ]),
    );
    const last = page.events.at(-1)!;
    expect(last.id).toBe("codex-item:cmd-x");
    expect(last.turn_meta).toEqual({ outcome: "aborted", duration_ms: 4_200 });
    // The wrapper's output was never written: the command stays a plain row.
    expect(page.events.find((event) => event.tool_name === "exec")?.tool).toBeUndefined();
  });

  it("keeps the earlier exec_command_end layout working", () => {
    const turn = "t5";
    const page = read(
      rollout([
        user(turn, "Old layout"),
        call(turn, "old-1", "shell", "function_call"),
        row("event_msg", {
          type: "exec_command_end",
          call_id: "old-1",
          exit_code: 0,
          duration: 0.5,
          success: true,
          ...pass(turn),
        }),
        output(turn, "old-1", "function_call_output"),
      ]),
    );
    const tools = page.events.filter((event) => event.kind === "tool-summary");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      tool_name: "shell",
      tool_status: "completed",
      duration_ms: 500,
    });
    expect(tools[0]!.tool).toBeUndefined();
  });

  it("counts tool details against the page byte budget", () => {
    const turn = "t6";
    const rows: unknown[] = [user(turn, "Big change")];
    const body = Array.from({ length: 40 }, (_, line) => `+${"z".repeat(180)} ${line}`).join("\n");
    for (let index = 0; index < 120; index++) {
      const changes: Record<string, unknown> = {};
      for (let file = 0; file < 4; file++)
        changes[`${workspace}/src/f-${index}-${file}.ts`] = {
          type: "update",
          unified_diff: `@@ -1 +1,40 @@\n-a\n${body}\n`,
          move_path: null,
        };
      rows.push(
        item(turn, { type: "FileChange", id: `fc-${index}`, changes, status: "completed" }),
      );
    }
    const page = read(rollout(rows), 100);
    const bytes = page.events.reduce(
      (sum, event) => sum + JSON.stringify(event.tool ?? {}).length,
      0,
    );
    expect(page.events.length).toBeLessThan(100);
    expect(page.next_cursor).not.toBeNull();
    expect(bytes).toBeLessThanOrEqual(MAX_PAGE_BYTES);
  });
});
