import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeRunnerState } from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeProtocolError } from "../../../packages/backend/src/claude-frame-policy";

// Background work (Bash commands, Monitor, sub-agents) and the turns the CLI starts by itself to
// report on it. The captures in
// fixtures/claude-background are frames of the real CLI (2.1.263, 2.1.299, 2.1.322) run with the
// managed runner's arguments against a mock model, reduced to the fields the state reads; see
// qa/claude-background-tasks-probe-2026-11-13.md. Tests named "synthetic" build their frames by
// hand.

type Frame = Record<string, any>;

const capture = (name: string): Frame[] =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/claude-background/${name}.json`, import.meta.url), "utf8"),
  ).frames;

/**
 * Feeds a capture to the state as the managed process does: the first message goes out with
 * initialization, a later one when the CLI reports it queued, and approvals are allowed.
 */
function replay(name: string, background: boolean) {
  const frames = capture(name);
  const state = new ClaudeRunnerState(randomUUID());
  state.foregroundBashContract = true;
  state.backgroundTasksEnabled = background;
  const sent = frames
    .filter((frame) => frame.type === "command_lifecycle" && frame.state === "queued")
    .map((frame) => frame.command_uuid as string);
  state.initialize(sent[0] ? state.begin("first message", sent[0]) : null);
  state.initId = frames.find((frame) => frame.type === "control_response")!.response.request_id;
  const turns: Array<{ id: string; origin: string; outcome: string | null }> = [];
  const approvals: Array<{ turnId: string; origin: string }> = [];
  // What the session looked like each time it came to rest.
  const rests: Array<{ background: number; wakes: number }> = [];
  let reported: unknown = null;
  let status = state.status;
  for (const frame of frames) {
    if (
      frame.type === "command_lifecycle" &&
      frame.state === "queued" &&
      frame.command_uuid !== sent[0]
    )
      state.begin("later message", frame.command_uuid);
    state.frame(frame);
    if (frame.type === "control_request" && frame.request.subtype === "can_use_tool") {
      const pending = state.snapshot();
      approvals.push({ turnId: pending.approvals[0]!.turnId, origin: pending.turnOrigin });
      state.approve(frame.request_id, pending.turnId, "allow", pending.revision);
    }
    if (state.terminalResult && state.terminalResult !== reported) {
      reported = state.terminalResult;
      turns.push({
        id: state.terminalResult.turnId,
        origin: state.turnOrigin,
        outcome: state.lastOutcome,
      });
    }
    if (state.status === "idle" && status !== "idle")
      rests.push({ background: state.backgroundTasks.size, wakes: state.pendingWakes });
    status = state.status;
  }
  return { state, turns, sent, approvals, rests };
}

/** Sends a message and has the CLI report its turn as started, as the real CLI does. */
function beginStarted(state: ClaudeRunnerState, turn: string = randomUUID()): string {
  state.begin("message", turn);
  state.frame({ type: "command_lifecycle", command_uuid: turn, state: "queued" });
  state.frame({ type: "command_lifecycle", command_uuid: turn, state: "started" });
  return turn;
}

const codeOf = (run: () => unknown): string | null => {
  try {
    run();
  } catch (error) {
    return error instanceof ClaudeProtocolError ? error.code : `other: ${String(error)}`;
  }
  return null;
};

describe("a session started after a background command was left running", () => {
  // The CLI reports the command as stopped and sends an empty result before the turn of the
  // message it was given. The same happens with background commands turned off.
  for (const version of ["2.1.322", "2.1.263"])
    for (const background of [false, true])
      it(`keeps the turn AgentKib sent (${version}, background ${background ? "on" : "off"})`, () => {
        const { state, turns, sent } = replay(`restart-with-message-${version}`, background);
        expect(turns).toEqual([{ id: sent[0], origin: "host", outcome: "succeeded" }]);
        expect(state.status).toBe("idle");
        expect(state.reason).toBeNull();
        expect(state.diagnostics.snapshot().strayResults).toEqual({ before_turn_start: 1 });
      });

  it("stays idle when no message was sent", () => {
    for (const background of [false, true]) {
      const { state, turns } = replay("restart-without-message-2.1.322", background);
      expect(turns).toEqual([]);
      expect(state.status).toBe("idle");
      expect(state.turnId).toBe("");
      expect(state.diagnostics.snapshot().strayResults).toEqual({ idle: 1 });
    }
  });
});

describe("a background command that ends after its turn", () => {
  for (const version of ["2.1.322", "2.1.299", "2.1.263"])
    it(`is followed by a turn the CLI starts by itself (${version})`, () => {
      const { state, turns, sent, rests } = replay(`self-turn-${version}`, true);
      expect(turns.map((turn) => [turn.origin, turn.outcome])).toEqual([
        ["host", "succeeded"],
        ["self", "succeeded"],
      ]);
      expect(turns[0]!.id).toBe(sent[0]);
      expect(turns[1]!.id).not.toBe(sent[0]);
      // After the first turn the command still runs; after the second nothing is left.
      expect(rests).toEqual([
        { background: 1, wakes: 0 },
        { background: 0, wakes: 0 },
      ]);
      expect(state.status).toBe("idle");
      expect(state.selfTurns).toBe(1);
      expect(state.snapshot().backgroundTasks).toEqual([]);
    });

  it("names the command while it runs", () => {
    const frames = capture("self-turn-2.1.322");
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = true;
    const turn = frames.find((frame) => frame.type === "command_lifecycle")!.command_uuid;
    state.initialize(state.begin("message", turn));
    state.initId = frames.find((frame) => frame.type === "control_response")!.response.request_id;
    for (const frame of frames) {
      state.frame(frame);
      if (frame.type === "result") break;
    }
    const snapshot = state.snapshot();
    expect(snapshot.status).toBe("idle");
    expect(snapshot.sendEnabled).toBe(true);
    expect(snapshot.backgroundTasks).toHaveLength(1);
    expect(snapshot.backgroundTasks[0]).toMatchObject({
      toolUseId: "toolu_bgprobe_1",
      description: "Background probe",
    });
  });

  it("stops the session when background commands are not allowed", () => {
    expect(codeOf(() => replay("self-turn-2.1.322", false))).toBe("claude-background-task");
  });
});

describe("several background commands", () => {
  it("ending together: the empty result ends nothing and one turn reports both", () => {
    const { state, turns, rests } = replay("two-together-2.1.322", true);
    expect(turns.map((turn) => turn.origin)).toEqual(["host", "self"]);
    expect(rests.at(0)).toEqual({ background: 2, wakes: 0 });
    // Two ends were counted and one turn reported both: the second count is left over.
    expect(rests.at(-1)).toEqual({ background: 0, wakes: 1 });
    expect(state.diagnostics.snapshot().strayResults).toEqual({ idle: 1 });
    expect(state.status).toBe("idle");
  });

  it("ending apart: one turn for each", () => {
    const { state, turns, rests } = replay("two-apart-2.1.322", true);
    expect(turns.map((turn) => turn.origin)).toEqual(["host", "self", "self"]);
    expect(new Set(turns.map((turn) => turn.id)).size).toBe(3);
    expect(rests).toEqual([
      { background: 2, wakes: 0 },
      { background: 1, wakes: 0 },
      { background: 0, wakes: 0 },
    ]);
    expect(state.selfTurns).toBe(2);
  });
});

describe("a background command and the messages AgentKib sends", () => {
  it("ending inside a later turn is reported in that turn, with no turn of its own", () => {
    const { state, turns, sent } = replay("ends-during-turn-2.1.322", true);
    expect(turns).toEqual([
      { id: sent[0], origin: "host", outcome: "succeeded" },
      { id: sent[1], origin: "host", outcome: "succeeded" },
    ]);
    expect(state.backgroundTasks.size).toBe(0);
    // Whether an end was reported inside the running turn cannot be seen, so its count stays.
    expect(state.pendingWakes).toBe(1);
  });

  it("a message while the command runs is an ordinary turn; the CLI's own turn follows", () => {
    const { state, turns, sent } = replay("message-while-running-2.1.322", true);
    expect(turns.map((turn) => turn.origin)).toEqual(["host", "host", "self"]);
    expect(turns.slice(0, 2).map((turn) => turn.id)).toEqual(sent);
    // A message from AgentKib starts the count of the CLI's own turns again.
    expect(state.selfTurns).toBe(1);
  });

  it("an approval in the CLI's own turn belongs to that turn", () => {
    const { turns, approvals, sent } = replay("approval-in-self-turn-2.1.322", true);
    expect(turns.map((turn) => turn.origin)).toEqual(["host", "self"]);
    expect(approvals).toEqual([{ turnId: turns[1]!.id, origin: "self" }]);
    expect(approvals[0]!.turnId).not.toBe(sent[0]);
  });
});

describe("other background work", () => {
  it("a Monitor event starts a turn while its command still runs", () => {
    const { state, turns, rests } = replay("monitor-2.1.322", true);
    expect(turns.map((turn) => turn.origin)).toEqual(["host", "self", "self"]);
    expect(rests).toEqual([
      { background: 1, wakes: 0 },
      { background: 1, wakes: 0 },
      { background: 0, wakes: 0 },
    ]);
    expect(state.status).toBe("idle");
  });

  it("a Monitor stops the session when background work is not allowed", () => {
    // The Monitor tool is offered even with CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1.
    expect(codeOf(() => replay("monitor-2.1.322", false))).toBe("claude-background-task");
  });

  it("a background sub-agent is followed, and its end is reported in a turn of the CLI", () => {
    const frames = capture("background-agent-2.1.322");
    const started = frames.findIndex(
      (frame) => frame.subtype === "task_started" && frame.task_type === "local_agent",
    );
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = true;
    const turn = frames.find((frame) => frame.type === "command_lifecycle")!.command_uuid;
    state.initialize(state.begin("message", turn));
    state.initId = frames.find((frame) => frame.type === "control_response")!.response.request_id;
    for (const frame of frames.slice(0, started + 1)) state.frame(frame);
    expect(state.snapshot().backgroundTasks).toMatchObject([
      { kind: "agent", toolUseId: "toolu_kind_1", description: "Background agent" },
    ]);
    const { turns, rests } = replay("background-agent-2.1.322", true);
    expect(turns.map((turn) => turn.origin)).toEqual(["host", "self"]);
    expect(rests.at(-1)).toEqual({ background: 0, wakes: 0 });
  });

  it("a background sub-agent is left alone when background work is not allowed", () => {
    // Without run_in_background the CLI cannot start one; these frames are then only observed,
    // and the turn the CLI starts afterwards stops the session.
    expect(codeOf(() => replay("background-agent-2.1.322", false))).toBe("claude-unrequested-turn");
  });
});

describe("synthetic: an approval asked while no turn runs", () => {
  const request = {
    type: "control_request",
    request_id: "request-1",
    request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "touch x" } },
  };
  const idleWith = (tasks: unknown[]) => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = true;
    state.initialized = true;
    beginStarted(state);
    for (const task of tasks) state.frame(task);
    state.frame({ type: "result", subtype: "success", num_turns: 1, result: "done" });
    return state;
  };

  it("is denied, never shown, while background work runs", () => {
    const state = idleWith([
      {
        type: "system",
        subtype: "task_started",
        task_id: "agent-1",
        tool_use_id: "toolu_agent",
        task_type: "local_agent",
        is_backgrounded: true,
      },
    ]);
    const response = state.frame(request);
    expect(response).toMatchObject({
      type: "control_response",
      response: { subtype: "success", request_id: "request-1", response: { behavior: "deny" } },
    });
    expect(state.status).toBe("idle");
    expect(state.approvals).toEqual([]);
  });

  it("stops the session when nothing runs in the background", () => {
    expect(codeOf(() => idleWith([]).frame(request))).toBe("claude-unrequested-turn");
  });
});

describe("synthetic: a result before the turn AgentKib sent has started", () => {
  const sent = (background: boolean) => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = background;
    state.initialized = true;
    const turn = randomUUID();
    state.begin("message", turn);
    return { state, turn };
  };
  const lifecycle = (turn: string, phase: string) => ({
    type: "command_lifecycle",
    command_uuid: turn,
    state: phase,
  });
  const empty = { type: "result", subtype: "success", is_error: false, num_turns: 0, result: "" };
  const answered = {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 1,
    result: "x",
  };

  it("an empty one is left alone even when it comes before the message is reported queued", () => {
    // The order the managed process sees: it writes the message after initialization, and the
    // CLI may send its empty result first.
    for (const background of [false, true]) {
      const { state, turn } = sent(background);
      state.frame(empty);
      expect(state.status).toBe("running");
      state.frame(lifecycle(turn, "queued"));
      state.frame(empty);
      expect(state.status).toBe("running");
      state.frame(lifecycle(turn, "started"));
      state.frame(answered);
      expect(state).toMatchObject({ status: "idle", lastOutcome: "succeeded" });
      expect(state.terminalResult?.turnId).toBe(turn);
      expect(state.diagnostics.snapshot().strayResults).toEqual({ before_turn_start: 2 });
    }
  });

  it("with background work allowed, the result of the CLI's own turn is not this turn's", () => {
    const { state, turn } = sent(true);
    state.frame(lifecycle(turn, "queued"));
    state.frame({ type: "assistant", parent_tool_use_id: null, message: { content: [] } });
    state.frame(answered);
    expect(state.status).toBe("running");
    state.frame(lifecycle(turn, "started"));
    state.frame(answered);
    expect(state.status).toBe("idle");
  });

  it("a CLI that reports no lifecycle ends the turn with its result, as before", () => {
    const { state } = sent(false);
    state.frame({ type: "assistant", parent_tool_use_id: null, message: { content: [] } });
    state.frame({ type: "result", subtype: "success", is_error: false, result: "x" });
    expect(state).toMatchObject({ status: "idle", lastOutcome: "succeeded" });
  });
});

describe("synthetic: prompts scheduled for later (/loop, reminders)", () => {
  // The frames 2.1.323 sends for a scheduling call and its answer (claude-background-native).
  const call = (id: string, name: string, input: Frame) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const answer = (id: string, content: string, error = false) => ({
    type: "user",
    parent_tool_use_id: null,
    message: {
      content: [{ type: "tool_result", tool_use_id: id, content, ...(error ? { is_error: true } : {}) }],
    },
  });
  const done = { type: "result", subtype: "success", num_turns: 1, result: "done" };
  const fire = { type: "assistant", parent_tool_use_id: null, message: { content: [] } };
  /** A turn AgentKib sent in which the model calls these tools, then the session rests. */
  const scheduling = (background: boolean, ...calls: Array<[string, string, Frame, string, boolean?]>) => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = background;
    state.initialized = true;
    beginStarted(state);
    for (const [id, name, input, result, error] of calls) {
      state.frame(call(id, name, input));
      state.frame(answer(id, result, error));
    }
    state.frame(done);
    return state;
  };
  const created = "Scheduled recurring job 05cd54a7 (Every minute). Session-only.";

  it("a job's turn is the CLI's own, as one for ended background work", () => {
    const state = scheduling(true, ["toolu_c", "CronCreate", { cron: "*/1 * * * *", prompt: "tick" }, created]);
    expect(state.hasScheduledWork()).toBe(true);
    state.frame(fire);
    expect(state).toMatchObject({ status: "running", turnOrigin: "self" });
    state.frame(done);
    expect(state.terminalResult).toMatchObject({ success: true });
    // A recurring job fires again.
    state.frame(fire);
    expect(state.turnOrigin).toBe("self");
  });

  it("deleting the job, or a refused one, leaves nothing that may start a turn", () => {
    const deleted = scheduling(
      true,
      ["toolu_c", "CronCreate", { cron: "*/1 * * * *", prompt: "tick" }, created],
      ["toolu_d", "CronDelete", { id: "05cd54a7" }, "Cancelled job 05cd54a7."],
    );
    expect(deleted.hasScheduledWork()).toBe(false);
    expect(codeOf(() => deleted.frame(fire))).toBe("claude-unrequested-turn");
    const refused = scheduling(true, ["toolu_c", "CronCreate", { cron: "bad" }, "Invalid cron", true]);
    expect(refused.hasScheduledWork()).toBe(false);
  });

  it("a wakeup waits its delay; stopping the loop ends it", () => {
    const state = scheduling(true, ["toolu_w", "ScheduleWakeup", { delaySeconds: 1200, prompt: "go" }, "Scheduled."]);
    const now = Date.now();
    expect(state.hasScheduledWork(now + 1_000_000)).toBe(true);
    expect(state.hasScheduledWork(now + 1_200_000 + 11 * 60_000)).toBe(false);
    const stopped = scheduling(
      true,
      ["toolu_w", "ScheduleWakeup", { delaySeconds: 1200, prompt: "go" }, "Scheduled."],
      ["toolu_s", "ScheduleWakeup", { stop: true }, "Stopped."],
    );
    expect(stopped.hasScheduledWork()).toBe(false);
  });

  it("is not followed where background work is not allowed, and ends with the worker", () => {
    expect(
      scheduling(false, ["toolu_c", "CronCreate", { cron: "*/1 * * * *", prompt: "tick" }, created]).hasScheduledWork(),
    ).toBe(false);
    const state = scheduling(true, ["toolu_c", "CronCreate", { cron: "*/1 * * * *", prompt: "tick" }, created]);
    state.workerEnded();
    expect(state.hasScheduledWork()).toBe(false);
  });

  it("a durable job of this session lets a later worker take its turn", () => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = true;
    state.initialized = true;
    state.durableJobs = () => true;
    state.frame(fire);
    expect(state.turnOrigin).toBe("self");
  });
});

describe("synthetic: what still stops the session", () => {
  const idle = (background: boolean) => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = background;
    state.initialized = true;
    return state;
  };
  const text = { type: "assistant", parent_tool_use_id: null, message: { content: [] } };
  const requesting = { type: "system", subtype: "status", status: "requesting" };

  it("the CLI working by itself when no background command ended", () => {
    for (const background of [false, true]) {
      const state = idle(background);
      state.frame(requesting);
      expect(state.status).toBe("idle");
      expect(codeOf(() => state.frame(text))).toBe("claude-unrequested-turn");
    }
  });

  it("a result with turns when nothing was running", () => {
    for (const background of [false, true])
      expect(
        codeOf(() =>
          idle(background).frame({ type: "result", subtype: "success", num_turns: 1, result: "x" }),
        ),
      ).toBe("claude-unrequested-turn");
  });

  it("a background task of a kind that is not a Bash command", () => {
    const state = idle(true);
    state.begin("message");
    expect(
      codeOf(() =>
        state.frame({
          type: "system",
          subtype: "background_tasks_changed",
          tasks: [{ task_id: "t1", task_type: "remote_agent" }],
        }),
      ),
    ).toBe("claude-background-task");
  });
});

describe("synthetic: a foreground command moved to the background", () => {
  const running = (background: boolean) => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = background;
    state.initialized = true;
    beginStarted(state);
    state.frame({
      type: "assistant",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: {} }] },
    });
    state.frame({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "bash-1",
      task_type: "local_bash",
      is_backgrounded: false,
    });
    return state;
  };
  const moved = {
    type: "system",
    subtype: "task_updated",
    task_id: "task-1",
    patch: { is_backgrounded: true },
  };

  it("no longer holds the turn open", () => {
    const state = running(true);
    state.frame(moved);
    expect(state.foregroundTasks.size).toBe(0);
    expect(state.snapshot().backgroundTasks).toMatchObject([{ id: "task-1", toolUseId: "bash-1" }]);
    state.frame({ type: "result", subtype: "success", num_turns: 1, result: "done" });
    expect(state.status).toBe("idle");
    expect(state.backgroundTasks.size).toBe(1);
  });

  it("stops the session when background commands are not allowed", () => {
    expect(codeOf(() => running(false).frame(moved))).toBe("claude-background-task");
  });
});

describe("synthetic: what the worker's end clears", () => {
  const withTask = () => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = true;
    state.initialized = true;
    const turn = beginStarted(state);
    state.frame({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "task-1", task_type: "local_bash", description: "Watch the build" }],
    });
    return { state, turn };
  };

  it("stopping the turn ends the worker and its background commands", () => {
    const { state, turn } = withTask();
    state.stop(turn, state.revision);
    expect(state.backgroundTasks.size).toBe(0);
    expect(state.pendingWakes).toBe(0);
  });

  it("a failure does the same", () => {
    const { state } = withTask();
    state.fail("broken");
    expect(state.snapshot().backgroundTasks).toEqual([]);
  });

  it("a message that was not dispatched leaves them as the worker reports them", () => {
    const { state } = withTask();
    state.frame({ type: "result", subtype: "success", num_turns: 1, result: "done" });
    const checkpoint = state.checkpoint();
    state.begin("next message");
    state.frame({
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      status: "completed",
    });
    state.restoreUndispatched(checkpoint);
    expect(state.status).toBe("idle");
    // The command ended while the message was being sent: the CLI's own turn is still due.
    expect(state.backgroundTasks.size).toBe(0);
    expect(state.pendingWakes).toBe(1);
  });
});
