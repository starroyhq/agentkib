import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ClaudeRunnerState } from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeTurnFailure } from "../../../packages/backend/src/claude-frame-policy";

// Stopping a turn with the CLI's `interrupt` control request where background work is allowed,
// so that only the turn ends. The captures in fixtures/claude-interrupt are frames of the real
// CLI (2.1.263, 2.1.299, 2.1.323) run with the managed runner's arguments against a mock model,
// reduced as in fixtures/claude-background; `<host interrupt>` marks where the host sent the
// request. See qa/claude-interrupt-2026-11-13.md. Tests named "synthetic" build their frames
// by hand.

type Frame = Record<string, any>;
type Capture = { unanswered: string[]; steered: string[]; frames: Frame[] };

const capture = (name: string): Capture =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/claude-interrupt/${name}.json`, import.meta.url), "utf8"),
  );

/**
 * Feeds a capture to the state as the managed process does: messages go out when the CLI reports
 * them queued (a message added to the running turn is not a turn of its own), approvals are
 * allowed unless the capture left them unanswered, and the interrupt's acknowledgement goes to
 * the process rather than the state.
 */
function replay(name: string) {
  const { unanswered, steered, frames } = capture(name);
  const state = new ClaudeRunnerState(randomUUID());
  state.foregroundBashContract = true;
  state.backgroundTasksEnabled = true;
  const first = frames.find((frame) => frame.type === "command_lifecycle")!.command_uuid as string;
  state.initialize(state.begin("first message", first));
  state.initId = frames.find((frame) => frame.type === "control_response")!.response.request_id;
  let interrupted: { turnId: string; status: string; background: number } | null = null;
  let acknowledgement: Frame | null = null;
  const outcomes: Array<{ turnId: string; outcome: string | null }> = [];
  let status = state.status;
  for (const frame of frames) {
    if (frame.type === "<host interrupt>") {
      const before = state.snapshot();
      interrupted = {
        turnId: before.turnId!,
        status: before.status,
        background: state.backgroundTasks.size,
      };
      state.beginInterrupt(before.turnId!, before.revision);
      continue;
    }
    if (frame.type === "control_response" && frame.response.request_id === "<interrupt>") {
      acknowledgement = frame.response.response;
      continue;
    }
    if (
      frame.type === "command_lifecycle" &&
      frame.state === "queued" &&
      frame.command_uuid !== first &&
      !steered.includes(frame.command_uuid)
    )
      state.begin("later message", frame.command_uuid);
    state.frame(frame);
    if (
      frame.type === "control_request" &&
      frame.request.subtype === "can_use_tool" &&
      !unanswered.includes(frame.request.tool_use_id)
    ) {
      const pending = state.snapshot();
      state.approve(frame.request_id, pending.turnId, "allow", pending.revision);
    }
    if (state.status === "idle" && status !== "idle")
      outcomes.push({ turnId: state.turnId, outcome: state.lastOutcome });
    status = state.status;
  }
  return { state, interrupted: interrupted!, acknowledgement, outcomes };
}

describe("stopping a managed Claude turn with interrupt", () => {
  it.each([
    ["foreground-command-2.1.323", "running"],
    ["foreground-command-2.1.263", "running"],
    ["approval-2.1.323", "waiting-approval"],
    ["approval-2.1.263", "waiting-approval"],
    ["model-2.1.299", "running"],
    ["queued-message-2.1.323", "running"],
  ])("ends only the turn, as cancelled, and keeps the background command (%s)", (name, waiting) => {
    const { state, interrupted, acknowledgement, outcomes } = replay(name);
    expect(interrupted).toMatchObject({ status: waiting, background: 1 });
    expect(acknowledgement).toMatchObject({ still_queued: [] });
    const stopped = outcomes.findIndex((turn) => turn.turnId === interrupted.turnId);
    // The first message's turn ended before; the interrupted one ends cancelled; the third
    // message's turn, sent afterwards to the same process, ends normally.
    expect(outcomes.slice(stopped - 1, stopped + 2)).toEqual([
      { turnId: expect.any(String), outcome: "succeeded" },
      { turnId: interrupted.turnId, outcome: "cancelled" },
      { turnId: expect.not.stringMatching(interrupted.turnId), outcome: "succeeded" },
    ]);
    expect(state.interrupting).toBeNull();
    expect(state.reason).toBeNull();
    expect(state.initialized).toBe(true);
    expect(state.approvals).toEqual([]);
    expect(state.foregroundTasks.size).toBe(0);
  });

  it("cancels the message added to the turn with it", () => {
    const { steered } = capture("queued-message-2.1.323");
    const { acknowledgement } = replay("queued-message-2.1.323");
    expect(steered).toHaveLength(1);
    expect(acknowledgement).toEqual({ still_queued: [], cancelled: steered });
  });

  it("synthetic: ends a turn the CLI started by itself", () => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = true;
    const turn = randomUUID();
    state.initialize(state.begin("message", turn));
    for (const frame of [
      { type: "control_response", response: { subtype: "success", request_id: state.initId } },
      { type: "command_lifecycle", command_uuid: turn, state: "queued" },
      { type: "command_lifecycle", command_uuid: turn, state: "started" },
      {
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "toolu_watch", name: "Bash", input: {} }] },
      },
      {
        type: "system",
        subtype: "task_started",
        task_id: "watch",
        tool_use_id: "toolu_watch",
        description: "Watch the build",
        is_backgrounded: true,
        task_type: "local_bash",
      },
      { type: "result", subtype: "success", is_error: false, num_turns: 1, result: "ok" },
      { type: "command_lifecycle", command_uuid: turn, state: "completed" },
      // The command reports, and the CLI starts a turn of its own to tell the model.
      { type: "system", subtype: "task_notification", task_id: "watch", status: "completed" },
      { type: "system", subtype: "status", status: "requesting" },
    ])
      state.frame(frame);
    const own = state.snapshot();
    expect(own).toMatchObject({ status: "running", turnOrigin: "self" });
    state.beginInterrupt(own.turnId!, own.revision);
    state.frame({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    });
    state.frame({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      num_turns: 1,
    });
    expect(state.snapshot()).toMatchObject({
      status: "idle",
      lastOutcome: "cancelled",
      reason: null,
    });
    expect(state.interrupting).toBeNull();
  });

  it("synthetic: preserves a normal result if it arrives while stop is pending", () => {
    const state = new ClaudeRunnerState(randomUUID());
    state.backgroundTasksEnabled = true;
    const turnId = randomUUID();
    state.initialize(state.begin("message", turnId));
    state.frame({
      type: "control_response",
      response: { subtype: "success", request_id: state.initId },
    });
    state.frame({ type: "command_lifecycle", command_uuid: turnId, state: "queued" });
    state.frame({ type: "command_lifecycle", command_uuid: turnId, state: "started" });
    state.beginInterrupt(turnId, state.snapshot().revision);
    state.frame({ type: "result", subtype: "success", is_error: false, num_turns: 1 });
    expect(state.interrupting).toBeNull();
    expect(state.snapshot()).toMatchObject({ status: "idle", lastOutcome: "succeeded" });
    expect(state.terminalResult).toMatchObject({ turnId, success: true });
  });

  it("synthetic: still fails a turn that ends in an error nobody asked for", () => {
    const state = new ClaudeRunnerState(randomUUID());
    state.foregroundBashContract = true;
    state.backgroundTasksEnabled = true;
    const turn = randomUUID();
    state.initialize(state.begin("message", turn));
    state.frame({
      type: "control_response",
      response: { subtype: "success", request_id: state.initId },
    });
    state.frame({ type: "command_lifecycle", command_uuid: turn, state: "queued" });
    state.frame({ type: "command_lifecycle", command_uuid: turn, state: "started" });
    expect(() =>
      state.frame({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        num_turns: 1,
      }),
    ).toThrow(ClaudeTurnFailure);
  });
});
