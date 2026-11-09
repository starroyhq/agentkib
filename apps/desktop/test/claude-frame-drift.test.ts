import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ClaudeRunnerState } from "../../../packages/backend/src/claude-managed-runner";
import { ClaudeProtocolError } from "../../../packages/backend/src/claude-frame-policy";

// What the runner state does with frames it does not fully understand. Every frame is hand-built
// after the stream-json shape of the Agent SDK reference and the 2.1.285 QA capture. No Claude
// session is started, and that a real CLI sends any of these frames in this form is NOT verified:
// the shapes still to confirm are listed in docs/agents/claude-code-managed.md.

const SPAWN = "toolu_agent_spawn";
const backgroundRefused = "Claude background tasks are unsupported in managed sessions";
const unverifiedStart = "unverified Claude foreground Bash task";

function turn(contract = true, turnId: string = randomUUID()) {
  const state = new ClaudeRunnerState(randomUUID());
  state.foregroundBashContract = contract;
  state.initialized = true;
  state.begin("synthetic turn", turnId);
  return state;
}
const bashUse = (id: string) => ({ type: "tool_use", id, name: "Bash", input: { command: "ls" } });
const assistantWith = (blocks: unknown[], parent: unknown = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { content: blocks },
});
const taskStarted = (extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: "task-1",
  tool_use_id: "bash-1",
  task_type: "local_bash",
  is_backgrounded: false,
  ...extra,
});
const tasksChanged = (...types: unknown[]) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks: types.map((task_type) => ({ task_id: "t", task_type })),
});
const finished = { type: "result", subtype: "success", is_error: false };

/** The fields a frame that is only observed must leave alone. */
const watched = (state: ClaudeRunnerState) =>
  JSON.stringify({
    status: state.status,
    revision: state.revision,
    streamText: state.streamText,
    streamItemId: state.streamItemId,
    streamItemText: state.streamItemText,
    partial: state.partial,
    approvals: state.approvals,
    questions: state.questions,
    seenRequests: [...state.seenRequests],
    bash: [...state.bashToolIds],
    tasks: [...state.foregroundTasks],
    sub: [...state.subagentBashToolIds, ...state.subagentTasks],
    reason: state.reason,
  });

/** The error a frame raises, with its termination code (`undefined` for a plain Error). */
function stopped(state: ClaudeRunnerState, frame: unknown) {
  try {
    state.frame(frame);
  } catch (error) {
    return {
      message: (error as Error).message,
      code: error instanceof ClaudeProtocolError ? error.code : undefined,
    };
  }
  return null;
}

const canUse = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "control_request",
  request_id: id,
  request: {
    subtype: "can_use_tool",
    tool_name: "Write",
    input: { file_path: "a.txt" },
    tool_use_id: "toolu_1",
    ...extra,
  },
});
const control = (id: unknown, request: unknown) => ({
  type: "control_request",
  request_id: id,
  request,
});

describe("P1: a frame type this version does not know", () => {
  it.each(["attachment", "tombstone", "session_notice", "queued_notification", "future_x"])(
    "ignores %s without touching any state and counts it",
    (type) => {
      const state = turn();
      state.frame({ type: "stream_event", event: { type: "message_start", message: {} } });
      state.frame({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Hi" },
        },
      });
      const before = watched(state);
      expect(
        state.frame({ type, session_id: state.sessionId, payload: { any: "thing" } }),
      ).toBeNull();
      expect(watched(state)).toBe(before);
      expect(state.diagnostics.snapshot().ignoredFrameTypes).toEqual({ [type]: 1 });
    },
  );

  it("ignores one while idle and never lets it stand in for a result", () => {
    const state = turn();
    state.frame({ type: "future_x" });
    expect(state.status).toBe("running");
    state.frame(finished);
    expect(() => state.frame({ type: "future_x" })).not.toThrow();
    expect(state.status).toBe("idle");
  });

  it("keeps the basic checks: a frame needs a type and the session's ID", () => {
    const state = turn();
    expect(() => state.frame({ no: "type" })).toThrow("Claude frame missing type");
    expect(() => state.frame({ type: "future_x", session_id: randomUUID() })).toThrow(
      "Claude session ID changed unexpectedly",
    );
    expect(state.diagnostics.snapshot()).toEqual({});
  });

  it("does not let a hostile type name reach the diagnostics unfiltered", () => {
    const state = turn();
    state.frame({ type: 'x"; rm -rf /\n' });
    expect(state.diagnostics.snapshot().ignoredFrameTypes).toEqual({ other: 1 });
  });
});

describe("P2: a control request of an unknown kind", () => {
  it.each(["hook_callback", "elicitation", "request_user_dialog", "mcp_message", "future_x"])(
    "answers %s with an error and carries on",
    (subtype) => {
      const state = turn();
      const before = watched(state);
      const answer = state.frame(control("req-1", { subtype, payload: 1 }));
      expect(answer).toEqual({
        type: "control_response",
        response: {
          subtype: "error",
          request_id: "req-1",
          error: "This request is not supported by AgentKib managed sessions.",
        },
      });
      expect(watched(state)).toBe(before);
      expect(state.diagnostics.snapshot().refusedRequests).toEqual({ [subtype]: 1 });
    },
  );

  it("answers in any state: idle and before initialize as well", () => {
    const idle = turn();
    idle.frame(finished);
    expect(idle.frame(control("req-1", { subtype: "elicitation" }))).toMatchObject({
      response: { subtype: "error", request_id: "req-1" },
    });
    const fresh = new ClaudeRunnerState(randomUUID());
    expect(fresh.frame(control("req-2", { subtype: "hook_callback" }))).toMatchObject({
      response: { subtype: "error", request_id: "req-2" },
    });
  });

  it("never answers anything but an error, whatever the request carries", () => {
    const state = turn();
    for (const request of [
      { subtype: "hook_callback", behavior: "allow", updatedInput: {} },
      { subtype: "future_x", tool_name: "Bash", input: { command: "rm -rf /" } },
      { subtype: "elicitation", permission_suggestions: ["allow"] },
      { subtype: "CAN_USE_TOOL", tool_name: "Bash", input: {} },
      { subtype: "can_use_tool ", tool_name: "Bash", input: {} },
    ]) {
      const answer = state.frame(control("req", request));
      expect(JSON.stringify(answer)).not.toMatch(/allow/);
      expect(answer).toMatchObject({ response: { subtype: "error" } });
    }
    expect(state.approvals).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["a missing request_id", control(undefined, { subtype: "x" })],
    ["a numeric request_id", control(7, { subtype: "x" })],
    ["an empty request_id", control("", { subtype: "x" })],
    ["a missing request", control("r", undefined)],
    ["a request that is not an object", control("r", "x")],
    ["a request without a subtype", control("r", {})],
    ["a numeric subtype", control("r", { subtype: 7 })],
    ["an empty subtype", control("r", { subtype: "" })],
  ])("stops on %s, which cannot be answered or classified", (_label, frame) => {
    const state = turn();
    expect(() => state.frame(frame)).toThrow();
    expect(state.diagnostics.snapshot()).toEqual({});
  });

  it("does not remember the request, so the same ID may be a real approval later", () => {
    const state = turn();
    state.frame(control("req-1", { subtype: "elicitation" }));
    expect(state.seenRequests.size).toBe(0);
    state.frame(canUse("req-1"));
    expect(state.approvals).toHaveLength(1);
  });

  it("allows 1024 per turn, stops on the 1025th, and starts counting again next turn", () => {
    const state = turn();
    for (let index = 0; index < 1024; index++)
      expect(state.frame(control(`r${index}`, { subtype: "future_x" }))).not.toBeNull();
    expect(() => state.frame(control("r-over", { subtype: "future_x" }))).toThrow(
      "too many unsupported Claude control requests",
    );
    const next = turn();
    for (let index = 0; index < 1024; index++) next.frame(control(`r${index}`, { subtype: "x" }));
    next.frame(finished);
    next.begin("next turn", randomUUID());
    expect(next.unknownRequests).toBe(0);
    expect(() => next.frame(control("again", { subtype: "x" }))).not.toThrow();
  });

  it("restores the counter with a checkpoint", () => {
    const state = turn();
    state.frame(control("r1", { subtype: "x" }));
    const checkpoint = state.checkpoint();
    expect(checkpoint.unknownRequests).toBe(1);
    state.frame(control("r2", { subtype: "x" }));
    state.restoreUndispatched(checkpoint);
    expect(state.unknownRequests).toBe(1);
  });
});

describe("P3: permission fields this version does not know", () => {
  it("shows an unknown field, bounded, and answers exactly as before", () => {
    const state = turn();
    state.frame(
      canUse("req-1", {
        mcp_server: { name: "docs", source: "project" },
        title: "Write a file",
        blocked_path: "/tmp/x",
        decision_reason: "rule",
      }),
    );
    expect(state.status).toBe("waiting-approval");
    expect(state.approvals[0]).toMatchObject({
      requestId: "req-1",
      toolName: "Write",
      input: { file_path: "a.txt" },
      context: {
        title: "Write a file",
        blockedPath: "/tmp/x",
        decisionReason: "rule",
        permissionSuggestions: null,
        tool_use_id: "toolu_1",
        mcp_server: '{"name":"docs","source":"project"}',
      },
      availableDecisions: ["allow", "deny"],
    });
    const allow = state.approve("req-1", state.turnId, "allow", state.revision);
    expect(allow).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "allow", updatedInput: { file_path: "a.txt" } },
      },
    });
    expect(state.diagnostics.snapshot().unknownPermissionFields).toEqual({ mcp_server: 1 });
  });

  it("answers a denial exactly as before", () => {
    const state = turn();
    state.frame(canUse("req-1", { future_flag: true }));
    expect(state.approve("req-1", state.turnId, "deny", state.revision)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "deny", message: "Denied by the user" },
      },
    });
  });

  it("keeps the known fields as they were", () => {
    const state = turn();
    state.frame(
      canUse("req-1", {
        permission_suggestions: [{ type: "addRules" }],
        agent_id: "agent-1",
        display_name: "Write",
        description: "d",
        decision_reason_type: "rule",
        matched_ask_rule: "Write(*)",
        classifier_approvable: true,
        suppress_always_allow_rule: false,
        default_to_no: false,
        requires_user_interaction: false,
      }),
    );
    expect(state.approvals[0]!.context).toEqual({
      tool_use_id: "toolu_1",
      agent_id: "agent-1",
      display_name: "Write",
      description: "d",
      decision_reason_type: "rule",
      matched_ask_rule: "Write(*)",
      classifier_approvable: true,
      suppress_always_allow_rule: false,
      default_to_no: false,
      requires_user_interaction: false,
      blockedPath: null,
      decisionReason: null,
      permissionSuggestions: [{ type: "addRules" }],
    });
    expect(state.diagnostics.snapshot()).toEqual({});
  });

  it("keeps 32 unknown fields, drops the rest and illegal names, and leaves the prototype alone", () => {
    const state = turn();
    const request: Record<string, unknown> = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"x","bad-key":1,"blockedPath":"forged"}',
    );
    for (let index = 0; index < 40; index++) request[`extra_${index}`] = index;
    state.frame(canUse("req-1", request));
    const context = state.approvals[0]!.context as Record<string, unknown>;
    const extras = Object.keys(context).filter((key) => key.startsWith("extra_"));
    expect(extras).toHaveLength(32);
    expect(context.blockedPath).toBeNull();
    expect(Object.hasOwn(context, "__proto__")).toBe(false);
    expect(Object.hasOwn(context, "constructor")).toBe(false);
    expect(Object.hasOwn(context, "bad-key")).toBe(false);
    expect(Object.getPrototypeOf(context)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(state.diagnostics.snapshot().unknownPermissionFields).toMatchObject({
      other: expect.any(Number),
    });
  });

  it("clips a huge value and still honors the pending-interaction budget", () => {
    const state = turn();
    state.frame(canUse("req-1", { note: "n".repeat(100_000) }));
    const note = (state.approvals[0]!.context as Record<string, string>).note!;
    expect(note.endsWith("[truncated]")).toBe(true);
    expect(Buffer.byteLength(note)).toBeLessThanOrEqual(4096 + 11);
    // The input is not clipped, so the shared 1 MiB budget still ends an oversized request.
    const huge = canUse("req-2");
    huge.request.input = { x: "y".repeat(1024 * 1024) };
    expect(() => state.frame(huge)).toThrow("exceeds Web delivery budget");
  });
});

describe("P4: a tool that needs its own interface", () => {
  it("is denied with an explanation and never becomes an approval", () => {
    const state = turn();
    const before = watched(state);
    const answer = state.frame(
      canUse("req-1", { tool_name: "ExitPlanMode", requires_user_interaction: true }),
    );
    expect(answer).toMatchObject({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: {
          behavior: "deny",
          message: expect.stringContaining("Claude Code terminal"),
        },
      },
    });
    expect(JSON.stringify(answer)).not.toContain('"allow"');
    expect(state.approvals).toEqual([]);
    expect(state.status).toBe("running");
    expect(state.revision).toBe(JSON.parse(before).revision);
    expect(state.diagnostics.snapshot().refusedTools).toEqual({ ExitPlanMode: 1 });
  });

  it.each<[string, unknown]>([
    ["true", true],
    ["a truthy string", "yes"],
    ["1", 1],
    ["null", null],
  ])("treats a requires_user_interaction of %s as set", (_label, flag) => {
    const state = turn();
    expect(state.frame(canUse("req-1", { requires_user_interaction: flag }))).toMatchObject({
      response: { response: { behavior: "deny" } },
    });
  });

  it("leaves AskUserQuestion alone even when the flag is set", () => {
    const state = turn();
    state.frame({
      ...canUse("req-1", { tool_name: "AskUserQuestion", requires_user_interaction: true }),
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        requires_user_interaction: true,
        input: {
          questions: [
            {
              question: "Which one?",
              header: "Pick",
              options: [{ label: "A" }, { label: "B" }],
              multiSelect: false,
            },
          ],
        },
      },
    });
    expect(state.status).toBe("waiting-input");
    expect(state.questions).toHaveLength(1);
  });

  it("treats an explicit false or an absent flag as an ordinary approval", () => {
    const state = turn();
    state.frame(canUse("req-1", { requires_user_interaction: false }));
    state.frame(canUse("req-2"));
    expect(state.approvals).toHaveLength(2);
  });
});

describe("P6, P18, P19: the checks that stay", () => {
  it("stops on an approval request outside a turn (unrequested) or before initialize", () => {
    const idle = turn();
    idle.frame(finished);
    expect(stopped(idle, canUse("r1"))).toEqual({
      message: "Claude interaction outside active turn",
      code: "claude-unrequested-turn",
    });
    const fresh = new ClaudeRunnerState(randomUUID());
    expect(stopped(fresh, canUse("r1"))).toEqual({
      message: "Claude requested interaction before initialize",
      code: undefined,
    });
  });

  it("stops on a result outside a turn with the unrequested-turn code", () => {
    const state = turn();
    state.frame(finished);
    expect(stopped(state, finished)).toEqual({
      message: "Claude result outside an active turn",
      code: "claude-unrequested-turn",
    });
  });

  it("ignores a cancellation of an unknown request and stops on one without an ID", () => {
    const state = turn();
    state.frame(canUse("req-1"));
    const before = JSON.stringify(state.approvals);
    state.frame({ type: "control_cancel_request", request_id: "nope" });
    expect(JSON.stringify(state.approvals)).toBe(before);
    expect(stopped(state, { type: "control_cancel_request", request_id: 7 })).toEqual({
      message: "invalid Claude cancellation",
      code: undefined,
    });
    state.frame({ type: "control_cancel_request", request_id: "req-1" });
    expect(state.approvals).toEqual([]);
    expect(state.status).toBe("running");
  });

  it("keeps the limits on real approvals", () => {
    const state = turn();
    state.frame(canUse("req-1"));
    expect(() => state.frame(canUse("req-1"))).toThrow("duplicate Claude control request");
    expect(() =>
      state.frame({
        ...canUse("req-2"),
        request: { subtype: "can_use_tool", tool_name: "W", input: 5 },
      }),
    ).toThrow("invalid Claude tool input");
    for (let index = 3; index <= 33; index++) state.frame(canUse(`req-${index}`));
    expect(state.approvals).toHaveLength(32);
    expect(() => state.frame(canUse("req-34"))).toThrow("too many pending Claude approvals");
  });
});

describe("P7, P7b, P8: task frames", () => {
  const agentFrames = [
    taskStarted({ task_type: "local_agent", is_backgrounded: false, tool_use_id: "toolu_agent" }),
    taskStarted({ task_type: "local_agent", is_backgrounded: true, tool_use_id: "toolu_agent" }),
    {
      type: "system",
      subtype: "task_updated",
      task_id: "task-1",
      patch: { is_backgrounded: true },
    },
    {
      type: "system",
      subtype: "task_notification",
      task_id: "task-1",
      tool_use_id: "x",
      status: "completed",
    },
    taskStarted({ task_type: "local_agent", task_id: 5 }),
  ];

  it.each([true, false])(
    "observes sub-agent task frames and changes nothing (foreground contract %s)",
    (contract) => {
      const state = turn(contract);
      state.frame(assistantWith([bashUse("bash-1")]));
      state.frame({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "Hi" },
        },
      });
      const before = watched(state);
      for (const frame of agentFrames) expect(() => state.frame(frame)).not.toThrow();
      state.frame(tasksChanged("local_agent", "local_agent"));
      expect(watched(state)).toBe(before);
      expect(state.diagnostics.snapshot().observedTaskTypes?.local_agent).toBeGreaterThan(0);
      // The sub-agent never blocks the end of the turn.
      state.frame(finished);
      expect(state.status).toBe("idle");
    },
  );

  it.each(["approval", "question"] as const)(
    "keeps a pending %s usable after observation-only task frames",
    (interaction) => {
      for (const contract of [true, false]) {
        const state = turn(contract);
        state.frame(
          canUse(
            "req-pending",
            interaction === "question"
              ? {
                  tool_name: "AskUserQuestion",
                  input: {
                    questions: [
                      {
                        question: "Which one?",
                        header: "Pick",
                        options: [{ label: "A" }, { label: "B" }],
                        multiSelect: false,
                      },
                    ],
                  },
                }
              : {},
          ),
        );
        const before = watched(state);
        const revision = state.revision;
        for (const frame of [...agentFrames, tasksChanged(), tasksChanged("local_agent")]) {
          state.frame(frame);
          expect(watched(state)).toBe(before);
        }
        const submit = () =>
          interaction === "approval"
            ? state.approve("req-pending", state.turnId, "allow", revision)
            : state.answer("req-pending", state.turnId, { "Which one?": ["A"] }, revision);
        expect(submit()).toMatchObject({
          response: { request_id: "req-pending", response: { behavior: "allow" } },
        });
        expect(state.status).toBe("running");
        expect(state.approvals).toEqual([]);
        expect(state.questions).toEqual([]);
        expect(() => submit()).toThrow(/stale Claude/);
      }
    },
  );

  it("observes a sub-agent task start even outside a turn", () => {
    const state = turn();
    state.frame(finished);
    expect(() => state.frame(taskStarted({ task_type: "local_agent" }))).not.toThrow();
  });

  it.each<[string, unknown]>([
    ["remote_agent", "remote_agent"],
    ["mcp_task", "mcp_task"],
    ["monitor_mcp", "monitor_mcp"],
    ["in_process_teammate", "in_process_teammate"],
    ["local_workflow", "local_workflow"],
    ["a missing type", undefined],
    ["a numeric type", 7],
    ["a 65-character type", "t".repeat(65)],
  ])(
    "stops on a task start of %s with the background-task code, with or without the contract",
    (label, type) => {
      for (const [contract, message] of [
        [true, unverifiedStart],
        [false, backgroundRefused],
      ] as const) {
        const state = turn(contract);
        state.frame(assistantWith([bashUse("bash-1")]));
        const before = watched(state);
        expect(stopped(state, taskStarted({ task_type: type }))).toEqual({
          message,
          code: "claude-background-task",
        });
        expect(watched(state)).toBe(before);
        const key = typeof type === "string" && type.length <= 64 ? type : "other";
        expect(state.diagnostics.snapshot().observedTaskTypes).toEqual({ [key]: 1 });
        void label;
      }
    },
  );

  it("judges a task type before the turn or the task ID are looked at", () => {
    const idle = turn();
    idle.frame(finished);
    expect(
      stopped(idle, taskStarted({ task_type: "remote_agent", task_id: undefined })),
    ).toMatchObject({
      code: "claude-background-task",
    });
  });

  it("accepts an empty background set for every version, and a set of sub-agents only", () => {
    for (const contract of [true, false]) {
      const state = turn(contract);
      expect(() => state.frame(tasksChanged())).not.toThrow();
      expect(() => state.frame(tasksChanged("local_agent"))).not.toThrow();
      expect(() => state.frame(tasksChanged("local_agent", "local_agent"))).not.toThrow();
      expect(state.status).toBe("running");
    }
  });

  it.each<[string, unknown[]]>([
    ["a Bash command", ["local_bash"]],
    ["an MCP task", ["mcp_task"]],
    ["a remote agent", ["remote_agent"]],
    ["an unknown kind", ["ambient"]],
    ["a member without a type", [undefined]],
    ["a sub-agent next to a Bash command", ["local_agent", "local_bash"]],
  ])("stops when the background set holds %s", (_label, types) => {
    for (const contract of [true, false]) {
      const state = turn(contract);
      expect(stopped(state, tasksChanged(...types))).toEqual({
        message: backgroundRefused,
        code: "claude-background-task",
      });
    }
  });

  it("stops, as a protocol violation, on a background set that is not a list", () => {
    const state = turn();
    expect(
      stopped(state, { type: "system", subtype: "background_tasks_changed", tasks: "x" }),
    ).toEqual({ message: backgroundRefused, code: "claude-protocol-violation" });
    expect(
      stopped(state, { type: "system", subtype: "background_tasks_changed", tasks: [7] }),
    ).toMatchObject({ code: "claude-background-task" });
  });
});

describe("P9, P10, P16: Bash tasks keep their protection", () => {
  const tracked = () => {
    const state = turn();
    state.frame(assistantWith([bashUse("bash-1")]));
    state.frame(taskStarted());
    return state;
  };

  it("stops with the background-task code on a background Bash start, however it is flagged", () => {
    for (const flag of [true, null, "yes", undefined]) {
      const state = turn();
      state.frame(assistantWith([bashUse("bash-1")]));
      expect(stopped(state, taskStarted({ is_backgrounded: flag }))).toEqual({
        message: unverifiedStart,
        code: "claude-background-task",
      });
      expect(state.foregroundTasks.size).toBe(0);
    }
  });

  it("stops with the background-task code when a tracked foreground task moves to the background", () => {
    const state = tracked();
    expect(
      stopped(state, {
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { is_backgrounded: true },
      }),
    ).toEqual({ message: backgroundRefused, code: "claude-background-task" });
  });

  it("stops with the background-task code when a sub-agent's Bash task moves to the background", () => {
    const state = turn();
    state.frame(assistantWith([bashUse("sub-bash")], SPAWN));
    state.frame(
      taskStarted({ task_id: "sub-task", tool_use_id: "sub-bash", owned_by_subagent: true }),
    );
    expect(
      stopped(state, {
        type: "system",
        subtype: "task_updated",
        task_id: "sub-task",
        patch: { is_backgrounded: true },
      }),
    ).toEqual({ message: backgroundRefused, code: "claude-background-task" });
  });

  it("keeps the other checks as plain errors (a protocol violation, not a background task)", () => {
    const state = tracked();
    expect(stopped(state, taskStarted({ task_id: "task-2", tool_use_id: "other" }))).toEqual({
      message: unverifiedStart,
      code: undefined,
    });
    expect(
      stopped(state, {
        type: "system",
        subtype: "task_notification",
        task_id: "task-1",
        tool_use_id: "other",
        status: "completed",
      }),
    ).toEqual({ message: "unverified Claude task completion", code: undefined });
    expect(
      stopped(state, {
        type: "system",
        subtype: "task_updated",
        task_id: "task-1",
        patch: { status: "mystery" },
      }),
    ).toEqual({ message: "invalid Claude task status", code: undefined });
    expect(stopped(state, finished)).toEqual({
      message: "Claude result with unresolved foreground tasks",
      code: undefined,
    });
  });

  it("stops a Bash task below 2.1.285 as a protocol violation, with the old text", () => {
    const state = turn(false);
    expect(stopped(state, taskStarted())).toEqual({
      message: backgroundRefused,
      code: "claude-protocol-violation",
    });
  });

  it("stops on a Bash task start outside a turn, but only observes updates for tasks it never saw", () => {
    const state = turn();
    state.frame(finished);
    expect(stopped(state, taskStarted())).toEqual({
      message: "Claude task outside active turn",
      code: undefined,
    });
    expect(() =>
      state.frame({
        type: "system",
        subtype: "task_notification",
        task_id: "old",
        tool_use_id: "t",
        status: "completed",
      }),
    ).not.toThrow();
    expect(() =>
      state.frame({ type: "system", subtype: "task_updated", task_id: "old", patch: {} }),
    ).not.toThrow();
    expect(() =>
      state.frame({ type: "system", subtype: "task_updated", task_id: 5, patch: {} }),
    ).not.toThrow();
    expect(state.diagnostics.snapshot().observedTaskTypes).toMatchObject({
      untracked_task_notification: 1,
      untracked_task_updated: 2,
    });
  });
});

describe("P11, P13: whose frames are whose", () => {
  const textStart = (parent?: unknown) => ({
    type: "stream_event",
    ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
    event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  });
  const delta = (text: string, parent?: unknown) => ({
    type: "stream_event",
    ...(parent === undefined ? {} : { parent_tool_use_id: parent }),
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  });
  const messageStart = (parent: unknown, usage: Record<string, unknown> = { input_tokens: 5 }) => ({
    type: "stream_event",
    parent_tool_use_id: parent,
    event: { type: "message_start", message: { model: "sub-model", usage } },
  });
  const finalMessage = (text: string, id: string, parent: unknown = null) => ({
    type: "assistant",
    parent_tool_use_id: parent,
    uuid: id,
    message: { id, model: "main-model", content: [{ type: "text", text }] },
  });
  const observable = (state: ClaudeRunnerState) =>
    JSON.stringify({
      revision: state.revision,
      status: state.status,
      streamText: state.streamText,
      streamItemId: state.streamItemId,
      streamItemText: state.streamItemText,
      partial: state.partial,
      activeTextBlockIndex: state.activeTextBlockIndex,
      textBlocks: [...state.textBlocks],
      textBlockSerial: state.textBlockSerial,
      finalizedTextBlocks: state.finalizedTextBlocks,
      model: state.model,
      usage: state.usage,
      usageModel: state.usageModel,
      usageReportId: state.usageReportId,
      contextUsage: { ...state.contextUsage, updatedAt: undefined },
    });
  const mainId = randomUUID();
  const mainSequence = [textStart(), delta("Hel"), delta("lo"), finalMessage("Hello", mainId)];

  const turnId = randomUUID();
  const run = (interleave: (index: number) => unknown[]) => {
    const state = turn(true, turnId);
    const seen: string[] = [];
    mainSequence.forEach((frame, index) => {
      for (const extra of interleave(index)) state.frame(extra);
      state.frame(frame);
      seen.push(observable(state));
    });
    return { state, seen };
  };

  it("is not disturbed by a sub-agent's frames inside the main thread's stream", () => {
    const reference = run(() => []);
    const noisy = run((index) => [
      messageStart(SPAWN),
      textStart(SPAWN),
      delta("sub words", SPAWN),
      finalMessage("sub answer", randomUUID(), SPAWN),
      {
        type: "user",
        parent_tool_use_id: SPAWN,
        uuid: randomUUID(),
        message: { role: "user", content: "the prompt that drives the sub-agent" },
      },
      ...(index === 2
        ? [finalMessage("parallel sub-agent message", randomUUID(), "toolu_other")]
        : []),
    ]);
    expect(noisy.seen).toEqual(reference.seen);
    expect(noisy.state.streamText).toBe("Hello");
    expect(noisy.state.usage).toBeNull();
    // The sub-agent's model never leaks into the main thread's.
    expect(noisy.state.model).toBeNull();
  });

  it("does not append the final text twice when a sub-agent's message lands between delta and final", () => {
    const state = turn();
    state.frame(textStart());
    state.frame(delta("Hello"));
    state.frame(finalMessage("a sub-agent said this", randomUUID(), SPAWN));
    expect(state.partial).toBe(true);
    state.frame(finalMessage("Hello", randomUUID()));
    expect(state.streamText).toBe("Hello");
  });

  it("does not let a sub-agent's message_start reset the stream or reach usage", () => {
    const state = turn();
    state.frame(textStart());
    state.frame(delta("Hi"));
    const before = observable(state);
    state.frame(messageStart(SPAWN, { input_tokens: 999 }));
    expect(observable(state)).toBe(before);
  });

  it("treats frames of an unattributable origin as noise: counted, never applied", () => {
    const state = turn();
    state.frame(textStart());
    state.frame(delta("Hi"));
    const before = observable(state);
    for (const parent of [7, {}, "", "x".repeat(257)]) {
      state.frame(messageStart(parent));
      state.frame(delta("stray", parent));
      state.frame(finalMessage("stray", randomUUID(), parent));
      state.frame({ type: "user", parent_tool_use_id: parent, message: { content: "stray" } });
    }
    expect(observable(state)).toBe(before);
    expect(state.diagnostics.snapshot().unattributedFrames).toEqual({
      stream_event: 8,
      assistant: 4,
      user: 4,
    });
  });

  it("applies a main-thread frame whether the field is null or missing", () => {
    for (const parent of [null, undefined]) {
      const state = turn();
      state.frame(textStart(parent));
      state.frame(delta("Hi", parent));
      expect(state.streamText).toBe("Hi");
    }
  });

  it("lets a sub-agent's frames pass in the idle state without ending the session", () => {
    const state = turn();
    state.frame(finished);
    for (const frame of [
      messageStart(SPAWN),
      delta("x", SPAWN),
      finalMessage("x", randomUUID(), SPAWN),
      { type: "user", parent_tool_use_id: SPAWN, message: { content: "x" } },
    ])
      expect(() => state.frame(frame)).not.toThrow();
    expect(state.status).toBe("idle");
  });
});

describe("P17: the CLI working on its own", () => {
  const frames: Array<[string, unknown]> = [
    ["assistant", assistantWith([{ type: "text", text: "hi" }])],
    [
      "stream_event",
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "hi" },
        },
      },
    ],
    ["user", { type: "user", message: { content: "hi" } }],
  ];

  it.each(frames)("stops at the first main-thread %s frame while idle", (type, frame) => {
    const state = turn();
    state.frame(finished);
    expect(stopped(state, frame)).toEqual({
      message: `Claude ${type} frame outside an active turn`,
      code: "claude-unrequested-turn",
    });
    // Nothing was appended before it stopped.
    expect(state.streamText).toBe("");
  });

  it("stops even for a frame that carries a Bash call", () => {
    const state = turn();
    state.frame(finished);
    expect(stopped(state, assistantWith([bashUse("late")]))).toMatchObject({
      code: "claude-unrequested-turn",
    });
    expect(state.bashToolIds.size).toBe(0);
  });

  it.each(frames)(
    "does not stop on a stale %s frame after stop() (the process may still flush)",
    (_type, frame) => {
      const state = turn();
      state.stop(state.turnId, state.revision);
      expect(state.initialized).toBe(false);
      expect(() => state.frame(frame)).not.toThrow();
    },
  );

  it("does not stop before the session is initialized", () => {
    const state = new ClaudeRunnerState(randomUUID());
    expect(() => state.frame(frames[2]![1])).not.toThrow();
  });

  it("only observes progress frames while idle", () => {
    const state = turn();
    state.frame(finished);
    for (const type of [
      "tool_progress",
      "tool_use_summary",
      "rate_limit_event",
      "auth_status",
      "prompt_suggestion",
    ])
      expect(() => state.frame({ type })).not.toThrow();
  });

  it("still lets frames through while a turn is running, waiting for approval or for an answer", () => {
    const state = turn();
    state.frame(canUse("req-1"));
    expect(state.status).toBe("waiting-approval");
    expect(() => state.frame(frames[0]![1])).not.toThrow();
  });
});

describe("P14: damaged frames still stop the session", () => {
  it("keeps the message of a damaged text delta", () => {
    const state = turn();
    expect(
      stopped(state, {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: 5 } },
      }),
    ).toEqual({ message: "invalid Claude text delta", code: undefined });
  });

  it("keeps the failure of a result that reports a failed turn", () => {
    const state = turn();
    try {
      state.frame({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["boom"],
      });
      throw new Error("expected a failure");
    } catch (error) {
      expect((error as Error).message).toBe("Claude turn failed: boom");
      expect(error).not.toBeInstanceOf(ClaudeProtocolError);
    }
  });
});
