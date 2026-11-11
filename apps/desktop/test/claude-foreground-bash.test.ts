import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  ClaudeRunnerState,
  type ClaudeRunnerTerminalResult,
} from "../../../packages/backend/src/claude-managed-runner";

// Every frame is hand-built after the stream-json shape of the Agent SDK reference: assistant,
// user and stream_event frames carry parent_tool_use_id (null on the main thread, the spawning
// Agent call's tool_use ID inside a sub-agent) and system/task_started carries task_type,
// is_backgrounded and owned_by_subagent. The main-thread frames follow the recorded 2.1.285
// capture in qa/claude-managed-2026-09-30/foreground-complete-results-frames.jsonl, whose
// projection dropped parent_tool_use_id; the SDK sends it on every one of these frames.
// No Claude session is started. That a real CLI emits the sub-agent frames below in exactly this
// form is NOT verified.

const MAIN = null;
// The main-thread Agent call that spawned the sub-agent.
const SPAWN = "toolu_agent_spawn";

const bashUse = (id: unknown) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls" } });
const assistantWith = (blocks: unknown[], parent: unknown = MAIN) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: blocks },
});
const streamBash = (id: string, parent: unknown = MAIN) => ({
  type: "stream_event",
  parent_tool_use_id: parent,
  event: { type: "content_block_start", index: 0, content_block: { ...bashUse(id), input: {} } },
});
const taskStarted = (task: string, tool: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: task,
  tool_use_id: tool,
  task_type: "local_bash",
  is_backgrounded: false,
  ...extra,
});
const taskUpdated = (task: string, patch: Record<string, unknown>) => ({
  type: "system",
  subtype: "task_updated",
  task_id: task,
  patch,
});
const taskDone = (task: string, tool: string, status = "completed") => ({
  type: "system",
  subtype: "task_notification",
  task_id: task,
  tool_use_id: tool,
  status,
});
const noBackgroundTasks = { type: "system", subtype: "background_tasks_changed", tasks: [] };
const finished = { type: "result", subtype: "success", is_error: false };

function turn(contract = true) {
  const state = new ClaudeRunnerState(randomUUID());
  state.foregroundBashContract = contract;
  state.initialized = true;
  state.begin("synthetic turn", randomUUID());
  return state;
}
/** A main-thread foreground Bash call that the turn tracks: bash-1 running as task-1. */
function tracked() {
  const state = turn();
  state.frame(assistantWith([bashUse("bash-1")]));
  state.frame(taskStarted("task-1", "bash-1"));
  return state;
}
const outside = "Claude Bash outside current top-level turn";
const unverifiedStart = "unverified Claude foreground Bash task";
const backgroundRefused = "Claude background tasks are unsupported in managed sessions";

describe("foreground Bash contract on the main thread (behavior that must not change)", () => {
  it("tracks a Bash call from start to notification and lets the turn finish", () => {
    const state = turn();
    state.frame(assistantWith([bashUse("bash-1")]));
    expect([...state.bashToolIds]).toEqual(["bash-1"]);
    const revision = state.revision;
    state.frame(taskStarted("task-1", "bash-1"));
    expect([...state.foregroundTasks]).toEqual([["task-1", "bash-1"]]);
    expect(state.revision).toBe(revision + 1);
    state.frame(noBackgroundTasks);
    expect(state.revision).toBe(revision + 1);
    state.frame(taskUpdated("task-1", { status: "completed", is_backgrounded: false }));
    expect(state.revision).toBe(revision + 2);
    expect(state.status).toBe("running");
    state.frame(taskDone("task-1", "bash-1"));
    expect(state.revision).toBe(revision + 3);
    expect(state.foregroundTasks.size).toBe(0);
    expect(state.status).toBe("running");
    state.frame(finished);
    expect(state.status).toBe("idle");
  });

  it("anchors a task on a streamed Bash start, but never on one from an earlier turn", () => {
    const state = turn();
    state.frame(streamBash("bash-1"));
    state.frame(taskStarted("task-1", "bash-1"));
    state.frame(taskDone("task-1", "bash-1", "stopped"));
    state.frame(finished);
    state.begin("next turn", randomUUID());
    expect(() => state.frame(taskStarted("task-2", "bash-1"))).toThrow(unverifiedStart);
  });

  it.each<[string, Record<string, unknown>]>([
    ["another tool ID", { tool_use_id: "other" }],
    ["a background start", { is_backgrounded: true }],
    ["an unknown background flag", { is_backgrounded: null }],
    ["a sub-agent owner flag on a main-thread call", { owned_by_subagent: true }],
  ])("refuses a task start with %s", (_label, extra) => {
    const state = turn();
    state.frame(assistantWith([bashUse("bash-1")]));
    expect(() => state.frame(taskStarted("task-1", "bash-1", extra))).toThrow(unverifiedStart);
    expect(state.foregroundTasks.size).toBe(0);
  });

  // A task of a kind this version cannot supervise ends the session, with or without the
  // foreground contract; only the sub-agent task type is observed (see claude-frame-drift.test.ts).
  it.each<[string, Record<string, unknown>]>([
    ["remote_agent", { task_type: "remote_agent" }],
    ["mcp_task", { task_type: "mcp_task" }],
    ["monitor_mcp", { task_type: "monitor_mcp" }],
    ["a missing type", { task_type: undefined }],
    ["a numeric type", { task_type: 7 }],
  ])("refuses a task start of %s", (_label, extra) => {
    for (const [contract, message] of [
      [true, unverifiedStart],
      [false, backgroundRefused],
    ] as const) {
      const state = turn(contract);
      state.frame(assistantWith([bashUse("bash-1")]));
      expect(() => state.frame(taskStarted("task-1", "bash-1", extra))).toThrow(message);
      expect(state.foregroundTasks.size).toBe(0);
    }
  });

  it.each(["task_id", "tool_use_id", "task_type", "is_backgrounded"])(
    "refuses a task start that lacks %s",
    (key) => {
      const state = turn();
      state.frame(assistantWith([bashUse("bash-1")]));
      const frame: Record<string, unknown> = taskStarted("task-1", "bash-1");
      delete frame[key];
      expect(() => state.frame(frame)).toThrow();
    },
  );

  it("refuses a task for a Bash call it never saw, and any task without the contract", () => {
    expect(() => turn().frame(taskStarted("task-1", "bash-1"))).toThrow(unverifiedStart);
    const old = turn(false);
    expect(() => old.frame(taskStarted("task-1", "bash-1"))).toThrow(backgroundRefused);
    // An empty background set says nothing runs, which holds for any version.
    expect(() => old.frame(noBackgroundTasks)).not.toThrow();
    expect(() => old.frame({ ...noBackgroundTasks, tasks: [{ task_type: "local_bash" }] })).toThrow(
      backgroundRefused,
    );
  });

  it("fails closed on a background upgrade, a background set, a mismatched or unknown completion and a repeated start", () => {
    const state = tracked();
    expect(() => state.frame(taskUpdated("task-1", { is_backgrounded: true }))).toThrow(
      backgroundRefused,
    );
    expect(() => state.frame({ ...noBackgroundTasks, tasks: [{ task_id: "task-1" }] })).toThrow(
      backgroundRefused,
    );
    expect(() => state.frame(taskDone("task-1", "other"))).toThrow("unverified Claude task");
    // A task this turn never saw start is only observed (a resumed process closes older ones).
    expect(() => state.frame(taskDone("unknown", "bash-1"))).not.toThrow();
    expect(() => state.frame(taskUpdated("unknown", {}))).not.toThrow();
    expect(() => state.frame(taskStarted("task-1", "bash-1"))).toThrow(unverifiedStart);
    expect([...state.foregroundTasks]).toEqual([["task-1", "bash-1"]]);
  });

  it("will not end a turn while a main-thread foreground task is unresolved", () => {
    const state = tracked();
    expect(() => state.frame(finished)).toThrow("Claude result with unresolved foreground tasks");
    state.frame(taskDone("task-1", "bash-1"));
    state.frame(finished);
    expect(state.status).toBe("idle");
  });

  it("still refuses a Bash call outside the current turn that no sub-agent owns", () => {
    // While idle, any main-thread content frame is already the CLI working on its own.
    const ended = turn();
    ended.frame(finished);
    expect(() => ended.frame(assistantWith([bashUse("late")]))).toThrow(
      "Claude assistant frame outside an active turn",
    );
    expect(() => ended.frame(streamBash("late"))).toThrow(
      "Claude stream_event frame outside an active turn",
    );

    const fresh = new ClaudeRunnerState(randomUUID());
    fresh.foregroundBashContract = true;
    expect(() => fresh.frame(assistantWith([bashUse("early")]))).toThrow(outside);
  });

  it("treats a missing parent ID as the main thread, as the SDK's null", () => {
    const state = turn();
    const frame: Record<string, unknown> = assistantWith([bashUse("bash-1")]);
    delete frame.parent_tool_use_id;
    state.frame(frame);
    expect([...state.bashToolIds]).toEqual(["bash-1"]);
  });

  it.each<[string, unknown]>([
    ["a number", 7],
    ["an object", {}],
    ["an empty string", ""],
    ["a 257-byte string", "p".repeat(257)],
  ])("does not mistake %s for the main thread or a sub-agent", (_label, parent) => {
    const state = turn();
    const revision = state.revision;
    expect(() => state.frame(assistantWith([bashUse("bash-1")], parent))).not.toThrow();
    expect(() => state.frame(streamBash("bash-2", parent))).not.toThrow();
    // Not tracked as a main-thread call (so no task can anchor on it) and not a sub-agent's either.
    expect(state.bashToolIds.size).toBe(0);
    expect(state.subagentBashToolIds.size).toBe(0);
    expect(state.revision).toBe(revision);
  });

  it("rejects a Bash call without a usable ID and caps tracking at 4096 calls", () => {
    const state = turn();
    expect(() => state.frame(assistantWith([bashUse("")]))).toThrow("invalid Claude Bash tool ID");
    expect(() => state.frame(assistantWith([bashUse("x".repeat(257))]))).toThrow(
      "invalid Claude Bash tool ID",
    );
    for (let index = 0; index < 4096; index++)
      state.frame(assistantWith([bashUse(`bash-${index}`)]));
    expect(() => state.frame(assistantWith([bashUse("bash-over")]))).toThrow(
      "too many Claude Bash tools",
    );
  });

  it("drops tracking when the turn is stopped or the next turn begins", () => {
    const stopped = tracked();
    stopped.stop(stopped.turnId, stopped.revision);
    expect(stopped.bashToolIds.size).toBe(0);
    expect(stopped.foregroundTasks.size).toBe(0);
    expect(stopped.status).toBe("idle");
    expect(stopped.lastOutcome).toBe("cancelled");

    const next = turn();
    next.frame(assistantWith([bashUse("bash-1")]));
    next.frame(finished);
    next.begin("next turn", randomUUID());
    expect(next.bashToolIds.size).toBe(0);
  });

  it("ignores Bash blocks without the contract, as for CLIs below 2.1.285", () => {
    const state = turn(false);
    state.frame(assistantWith([bashUse("bash-1")]));
    state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN));
    expect(state.bashToolIds.size).toBe(0);
    expect(state.status).toBe("running");
  });
});

describe("foreground Bash contract inside a sub-agent (observed, never fatal)", () => {
  it("does not end the session for a Bash tool_use in a sub-agent assistant frame", () => {
    const state = turn();
    expect(() => state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN))).not.toThrow();
    expect(state.status).toBe("running");
    expect(state.reason).toBeNull();
  });

  it("does not end the session for a streamed Bash start inside a sub-agent", () => {
    const state = turn();
    expect(() => state.frame(streamBash("sub-bash-1", SPAWN))).not.toThrow();
    expect(state.status).toBe("running");
  });

  it("records the call against its spawning Agent call and leaves main-thread tracking alone", () => {
    const state = tracked();
    state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN));
    state.frame(streamBash("sub-bash-2", "toolu_other_spawn"));
    expect([...state.subagentBashToolIds]).toEqual([
      ["sub-bash-1", SPAWN],
      ["sub-bash-2", "toolu_other_spawn"],
    ]);
    expect([...state.bashToolIds]).toEqual(["bash-1"]);
    expect([...state.foregroundTasks]).toEqual([["task-1", "bash-1"]]);
  });

  it("observes a sub-agent's Bash outside a running turn, while the same call on the main thread is still refused", () => {
    const state = turn();
    state.frame(finished);
    expect(() => state.frame(assistantWith([bashUse("late-sub")], SPAWN))).not.toThrow();
    expect(() => state.frame(assistantWith([bashUse("late-main")], MAIN))).toThrow(
      "Claude assistant frame outside an active turn",
    );
    // After a stop the process may still flush frames: that is not the CLI acting on its own.
    const stopped = turn();
    stopped.stop(stopped.turnId, stopped.revision);
    expect(() => stopped.frame(assistantWith([bashUse("late-main")], MAIN))).toThrow(outside);
  });

  it.each<[string, unknown]>([
    ["no ID", undefined],
    ["an empty ID", ""],
    ["a non-string ID", 5],
    ["a 257-byte ID", "x".repeat(257)],
  ])("skips a sub-agent Bash call with %s instead of rejecting it", (_label, id) => {
    const state = turn();
    expect(() => state.frame(assistantWith([bashUse(id)], SPAWN))).not.toThrow();
    expect(state.subagentBashToolIds.size).toBe(0);
  });

  it("bounds the sub-agent record without ever failing", () => {
    const state = turn();
    for (let index = 0; index < 4100; index++)
      expect(() => state.frame(assistantWith([bashUse(`sub-${index}`)], SPAWN))).not.toThrow();
    expect(state.subagentBashToolIds.size).toBe(4096);
    expect(state.bashToolIds.size).toBe(0);
  });

  it("observes a sub-agent's foreground Bash task from start to notification", () => {
    const state = tracked();
    const revision = state.revision;
    state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN));
    state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true }));
    expect([...state.subagentTasks]).toEqual([["sub-task-1", "sub-bash-1"]]);
    state.frame(taskUpdated("sub-task-1", { status: "running", is_backgrounded: false }));
    state.frame(taskUpdated("sub-task-1", { status: "mystery" }));
    state.frame(taskDone("sub-task-1", "sub-bash-1"));
    expect(state.subagentTasks.size).toBe(0);
    expect([...state.foregroundTasks]).toEqual([["task-1", "bash-1"]]);
    expect(state.status).toBe("running");
    expect(state.revision).toBe(revision);
  });

  it("takes the owner from the Bash call when the task carries no owner flag", () => {
    const state = turn();
    state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN));
    state.frame(taskStarted("sub-task-1", "sub-bash-1"));
    expect([...state.subagentTasks]).toEqual([["sub-task-1", "sub-bash-1"]]);
    expect(state.foregroundTasks.size).toBe(0);
  });

  it("ignores a completion that does not match the recorded sub-agent task", () => {
    const state = turn();
    state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true }));
    expect(() => state.frame(taskDone("sub-task-1", "another-bash"))).not.toThrow();
    expect(state.subagentTasks.size).toBe(1);
    state.frame(taskDone("sub-task-1", "sub-bash-1"));
    expect(state.subagentTasks.size).toBe(0);
  });

  it("lets the turn finish while a sub-agent task is still open", () => {
    const state = turn();
    state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true }));
    expect(() => state.frame(finished)).not.toThrow();
    expect(state.status).toBe("idle");
  });

  it("keeps guarding the main thread while sub-agent tasks interleave", () => {
    const state = tracked();
    state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN));
    state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true }));
    state.frame(taskDone("sub-task-1", "sub-bash-1"));
    expect(() => state.frame(finished)).toThrow("Claude result with unresolved foreground tasks");
    expect(() => state.frame(taskDone("task-1", "sub-bash-1"))).toThrow("unverified Claude task");
    state.frame(taskDone("task-1", "bash-1"));
    state.frame(finished);
    expect(state.status).toBe("idle");
  });

  it.each<[string, Record<string, unknown>]>([
    ["a background start", { is_backgrounded: true }],
    ["an unknown background flag", { is_backgrounded: null }],
    ["an explicit not-a-sub-agent flag", { owned_by_subagent: false }],
    ["a missing tool ID", { tool_use_id: "" }],
  ])("still refuses a sub-agent task start with %s", (_label, extra) => {
    const state = turn();
    state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN));
    expect(() =>
      state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true, ...extra })),
    ).toThrow(unverifiedStart);
    expect(state.subagentTasks.size).toBe(0);
  });

  it("still refuses to let a sub-agent's task move to the background", () => {
    const state = turn();
    state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true }));
    expect(() => state.frame(taskUpdated("sub-task-1", { is_backgrounded: true }))).toThrow(
      backgroundRefused,
    );
    expect(() => state.frame({ ...noBackgroundTasks, tasks: [{ task_id: "sub-task-1" }] })).toThrow(
      backgroundRefused,
    );
  });

  it("still refuses a task it cannot attribute", () => {
    const state = tracked();
    expect(() => state.frame(taskUpdated("unknown", {}))).not.toThrow();
    expect(() => state.frame(taskDone("unknown", "sub-bash-1"))).not.toThrow();
    expect([...state.foregroundTasks]).toEqual([["task-1", "bash-1"]]);
    // A sub-agent task may not take over a main-thread task ID or tool call.
    expect(() =>
      state.frame(taskStarted("task-1", "sub-bash-1", { owned_by_subagent: true })),
    ).toThrow(unverifiedStart);
    expect(() => state.frame(taskStarted("task-2", "bash-1", { owned_by_subagent: true }))).toThrow(
      unverifiedStart,
    );
    expect([...state.foregroundTasks]).toEqual([["task-1", "bash-1"]]);
    expect(state.subagentTasks.size).toBe(0);
  });

  it("does not observe sub-agent tasks without the contract, as for CLIs below 2.1.285", () => {
    const state = turn(false);
    expect(() =>
      state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true })),
    ).toThrow(backgroundRefused);
    expect(state.subagentTasks.size).toBe(0);
  });

  it("clears the sub-agent record with the main-thread tracking", () => {
    const record = (state: ClaudeRunnerState) => {
      state.frame(assistantWith([bashUse("sub-bash-1")], SPAWN));
      state.frame(taskStarted("sub-task-1", "sub-bash-1", { owned_by_subagent: true }));
    };
    const stopped = turn();
    record(stopped);
    stopped.stop(stopped.turnId, stopped.revision);
    expect(stopped.subagentBashToolIds.size).toBe(0);
    expect(stopped.subagentTasks.size).toBe(0);

    const next = turn();
    record(next);
    next.frame(finished);
    const checkpoint = next.checkpoint();
    next.begin("next turn", randomUUID());
    expect(next.subagentBashToolIds.size).toBe(0);
    expect(next.subagentTasks.size).toBe(0);
    next.restoreUndispatched(checkpoint);
    expect([...next.subagentBashToolIds]).toEqual([["sub-bash-1", SPAWN]]);
    expect([...next.subagentTasks]).toEqual([["sub-task-1", "sub-bash-1"]]);
  });
});

// The process-level cases start a real worker process, so they need the Unix process fence.
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  try {
    // A zombie is dead; whoever adopted it has only not reaped it yet. Linux exposes that state.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return true;
  }
};

function synthetic(scenario: "finish" | "finish-open" | "in-flight" | "many-tools") {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "agentkib-claude-foreground-")));
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  for (const directory of [home, workspace, config]) mkdirSync(directory, { mode: 0o700 });
  const executable = path.join(root, "synthetic-claude");
  const children = path.join(root, "child");
  // A detached child leaves the CLI's process group, like a Bash command that starts its own
  // group. Only the macOS owned-tree cleanup is specified to reach it; the group kill used
  // elsewhere is not, so the case is not asserted there.
  const detached = process.platform === "darwin";
  // The scripted CLI answers one user turn with the frames of a sub-agent that runs Bash. It
  // does not emit the Agent call's own task frames; those are outside this contract change.
  writeFileSync(
    executable,
    `#!${process.execPath}\n${String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const use = (id, name, input, parent) => send({type: 'assistant', parent_tool_use_id: parent,
  message: {model: 'fixture-model', content: [{type: 'tool_use', id, name, input}]}});
const answer = (id, parent) => send({type: 'user', parent_tool_use_id: parent,
  message: {role: 'user', content: [{type: 'tool_result', tool_use_id: id, content: 'ok'}]}});
const system = (subtype, fields) => send(Object.assign({type: 'system', subtype}, fields));
const child = (name, detached) => {
  const started = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore', detached});
  fs.writeFileSync(process.env.FG_CHILDREN + '.' + name, String(started.pid));
};
readline.createInterface({input: process.stdin}).on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request') {
    const initialize = frame.request.subtype === 'initialize';
    send({type: 'control_response', response: {subtype: 'success', request_id: frame.request_id,
      response: initialize ? {models: [{value: 'fixture-model', displayName: 'Fixture'}], commands: []} : {}}});
  } else if (frame.type === 'user') {
    if (process.env.FG_SCENARIO === 'many-tools') {
      // More tools in one worker than its table of running tools holds.
      for (let index = 0; index < 1030; index++) {
        use('toolu_many_' + index, 'Read', {file_path: 'notes-' + index + '.md'}, null);
        answer('toolu_many_' + index, null);
      }
      const id = randomUUID();
      send({type: 'assistant', uuid: id, parent_tool_use_id: null,
        message: {id, model: 'fixture-model', content: [{type: 'text', text: 'Read them all'}]}});
      send({type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed'});
      return;
    }
    use('toolu_agent', 'Agent', {description: 'inspect', prompt: 'list files'}, null);
    use('toolu_sub_bash', 'Bash', {command: 'ls'}, 'toolu_agent');
    system('task_started', {task_id: 'sub-task', tool_use_id: 'toolu_sub_bash',
      task_type: 'local_bash', is_backgrounded: false, owned_by_subagent: true});
    if (process.env.FG_SCENARIO === 'in-flight') {
      child('same', false);
      if (process.env.FG_DETACHED === '1') child('detached', true);
      use('toolu_main_bash', 'Bash', {command: 'sleep 600'}, null);
      system('task_started', {task_id: 'main-task', tool_use_id: 'toolu_main_bash',
        task_type: 'local_bash', is_backgrounded: false});
      return; // the turn stays in flight until the host stops it
    }
    answer('toolu_sub_bash', 'toolu_agent');
    if (process.env.FG_SCENARIO !== 'finish-open')
      system('task_notification', {task_id: 'sub-task', tool_use_id: 'toolu_sub_bash', status: 'completed'});
    answer('toolu_agent', null);
    const id = randomUUID();
    send({type: 'assistant', uuid: id, parent_tool_use_id: null,
      message: {id, model: 'fixture-model', content: [{type: 'text', text: 'All done'}]}});
    send({type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed'});
  }
});
`}`,
    { mode: 0o700 },
  );
  const events: Array<{ type: string; payload: Record<string, any> }> = [];
  const results: ClaudeRunnerTerminalResult[] = [];
  const runner = new ClaudeManagedRunnerProcess(
    workspace,
    randomUUID(),
    true,
    0,
    {
      HOME: home,
      PATH: root,
      XDG_DATA_HOME: path.join(home, "data"),
      CLAUDE_CONFIG_DIR: config,
      FG_SCENARIO: scenario,
      FG_CHILDREN: children,
      ...(detached ? { FG_DETACHED: "1" } : {}),
    },
    () => undefined,
    true,
    (type, payload) => events.push({ type, payload }),
    { onResult: (result) => results.push(result) },
  );
  const childPids = () =>
    ["same", ...(detached ? ["detached"] : [])]
      .filter((name) => existsSync(`${children}.${name}`))
      .map((name) => Number(readFileSync(`${children}.${name}`, "utf8")));
  cleanups.push(async () => {
    await runner.shutdown().catch(() => undefined);
    // A failing assertion must not leave scripted children behind.
    for (const pid of childPids()) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const published = (id: string) =>
    events
      .flatMap(({ type, payload }) =>
        type === "item-upsert" ? [payload] : type === "snapshot" ? (payload.items ?? []) : [],
      )
      .filter((item: Record<string, any>) => item.id === id)
      .at(-1);
  return { runner, executable, results, childPids, published, expectedChildren: detached ? 2 : 1 };
}

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude managed runner with a sub-agent that runs Bash",
  () => {
    it("completes the turn and publishes the sub-agent's calls as tool entries", async () => {
      const f = synthetic("finish");
      await f.runner.send(f.executable, "delegate", randomUUID(), 0);
      await expect.poll(() => f.runner.snapshot().status, { timeout: 8000 }).not.toBe("running");
      expect({ ...f.runner.snapshot(), hasWorker: f.runner.hasWorker }).toMatchObject({
        status: "idle",
        reason: null,
        lastOutcome: "succeeded",
        hasWorker: true,
      });
      expect(f.results).toHaveLength(1);
      expect(f.published("toolu_sub_bash")).toMatchObject({
        kind: "tool-summary",
        tool_name: "Bash",
        tool_status: "completed",
      });
      expect(f.published("toolu_agent")).toMatchObject({
        tool_name: "Agent",
        tool_status: "completed",
      });
      expect(f.runner.state.foregroundTasks.size).toBe(0);
    }, 20_000);

    it("keeps publishing tools after a worker has run more than a thousand", async () => {
      const f = synthetic("many-tools");
      await f.runner.send(f.executable, "read every note", randomUUID(), 0);
      await expect.poll(() => f.runner.snapshot().status, { timeout: 8000 }).toBe("idle");
      for (const index of [0, 1023, 1024, 1029])
        expect(f.published(`toolu_many_${index}`)).toMatchObject({
          kind: "tool-summary",
          tool_name: "Read",
          tool_status: "completed",
        });
    }, 20_000);

    it("lets the turn finish with a sub-agent task still open, and forgets it when the idle worker is retired", async () => {
      const f = synthetic("finish-open");
      await f.runner.send(f.executable, "delegate", randomUUID(), 0);
      await expect.poll(() => f.runner.snapshot().status, { timeout: 8000 }).toBe("idle");
      expect(f.runner.snapshot().reason).toBeNull();
      expect([...f.runner.state.subagentBashToolIds]).toEqual([["toolu_sub_bash", "toolu_agent"]]);
      expect([...f.runner.state.subagentTasks]).toEqual([["sub-task", "toolu_sub_bash"]]);
      await expect(f.runner.retireIfInactive()).resolves.toBe(true);
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.state.subagentBashToolIds.size).toBe(0);
      expect(f.runner.state.subagentTasks.size).toBe(0);
    }, 20_000);

    it("stops a turn with sub-agent and main-thread Bash in flight and cleans up the whole process tree", async () => {
      const f = synthetic("in-flight");
      const turnId = randomUUID();
      await f.runner.send(f.executable, "delegate", turnId, 0);
      await expect.poll(() => f.runner.state.foregroundTasks.size, { timeout: 8000 }).toBe(1);
      expect([...f.runner.state.foregroundTasks]).toEqual([["main-task", "toolu_main_bash"]]);
      expect([...f.runner.state.subagentTasks]).toEqual([["sub-task", "toolu_sub_bash"]]);
      expect(f.runner.snapshot()).toMatchObject({ status: "running", reason: null });
      const pids = f.childPids();
      expect(pids).toHaveLength(f.expectedChildren);
      expect(pids.every(alive)).toBe(true);

      await f.runner.stop(turnId, f.runner.snapshot().revision);

      expect(f.runner.snapshot()).toMatchObject({
        status: "idle",
        lastOutcome: "cancelled",
        stopEnabled: false,
      });
      expect(f.runner.hasWorker).toBe(false);
      expect(f.runner.cleanupError).toBeNull();
      for (const set of [
        f.runner.state.bashToolIds,
        f.runner.state.foregroundTasks,
        f.runner.state.subagentBashToolIds,
        f.runner.state.subagentTasks,
      ])
        expect(set.size).toBe(0);
      for (const pid of pids) await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
    }, 30_000);
  },
);
