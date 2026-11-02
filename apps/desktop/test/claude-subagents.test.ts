import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  ClaudeRunnerState,
} from "../../../packages/backend/src/claude-managed-runner";
import { createFakeClaude } from "./fixtures/claude-fake-cli";

const assistant = (content: unknown[], parent: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  uuid: randomUUID(),
  message: { content },
});
const agent = (id: string, background = false) => ({
  type: "tool_use",
  id,
  name: "Agent",
  input: { description: "Synthetic reviewer", run_in_background: background },
});
const task = (id = "spawn-1", extra = {}) => ({
  type: "system",
  subtype: "task_started",
  task_type: "local_agent",
  tool_use_id: id,
  task_id: `task-${id}`,
  is_backgrounded: false,
  ...extra,
});
const result = (id: string, extra = {}, parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
  tool_use_result: extra,
});
const finished = {
  type: "result",
  subtype: "success",
  is_error: false,
  terminal_reason: "completed",
};
const turn = () => {
  const state = new ClaudeRunnerState(randomUUID());
  state.initialized = true;
  state.foregroundBashContract = true;
  state.begin("synthetic question");
  return state;
};
const one = (state: ClaudeRunnerState, id = "spawn-1") =>
  state.snapshot().subagents!.find((row) => row.id === id)!;

describe("Claude managed read-only subagent projection", () => {
  it("observes the foreground child lifecycle without changing parent control revision", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1")]));
    expect(one(state)).toMatchObject({
      name: "Synthetic reviewer",
      status: "starting",
      readable: false,
    });
    const revision = state.revision;
    state.frame(task());
    expect(state.revision).toBe(revision);
    expect(state.status).toBe("running");
    expect(one(state).status).toBe("running");
    state.frame(result("spawn-1", { agentId: "abc123" }));
    expect(one(state)).toMatchObject({
      status: "completed",
      nativeAgentId: "abc123",
      readable: true,
    });
    state.frame(finished);
    expect(state.status).toBe("idle");
    expect(one(state).status).toBe("completed");
  });

  it("does not mistake background dispatch or the parent result for child completion", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1", true)]));
    state.frame(task("spawn-1", { is_backgrounded: true }));
    state.frame(result("spawn-1", { agentId: "abc123", status: "async_launched" }));
    expect(one(state).status).toBe("running");
    state.frame(finished);
    expect(one(state).status).toBe("running");
    state.begin("another synthetic turn");
    expect(one(state).status).toBe("running");
    state.frame({
      type: "system",
      subtype: "task_notification",
      task_id: "task-spawn-1",
      tool_use_id: "spawn-1",
      status: "completed",
    });
    expect(one(state).status).toBe("completed");
  });

  it("keeps distinct IDs for same-name agents and rejects a mismatched completion", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1"), agent("spawn-2")]));
    state.frame(task());
    state.frame({
      type: "system",
      subtype: "task_notification",
      task_id: "task-spawn-1",
      tool_use_id: "spawn-2",
      status: "completed",
    });
    expect(state.snapshot().subagents).toHaveLength(2);
    expect(one(state).status).toBe("running");
    expect(one(state, "spawn-2").status).toBe("starting");
  });

  it("does not attribute an unlabelled structured result to multiple sibling agents", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1", true), agent("spawn-2", true)]));
    state.frame(task());
    state.frame(task("spawn-2"));
    state.frame({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [
          { type: "tool_result", tool_use_id: "spawn-1", content: "dispatched" },
          { type: "tool_result", tool_use_id: "spawn-2", content: "dispatched" },
        ],
      },
      tool_use_result: { agentId: "unattributed", status: "completed" },
    });
    expect(one(state)).toMatchObject({ status: "running" });
    expect(one(state, "spawn-2")).toMatchObject({ status: "running" });
    expect(one(state).nativeAgentId).toBeUndefined();
    expect(one(state, "spawn-2").nativeAgentId).toBeUndefined();
  });

  it("keeps nested transcripts separate from the parent and returns clones", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1")]));
    const parent = { revision: state.revision, stream: state.streamText, turnId: state.turnId };
    state.frame({
      type: "user",
      parent_tool_use_id: "spawn-1",
      uuid: randomUUID(),
      message: { content: "synthetic child prompt" },
    });
    state.frame(
      assistant([{ type: "text", text: "synthetic child reply" }, agent("nested")], "spawn-1"),
    );
    expect(state.revision).toBe(parent.revision);
    expect(state.streamText).toBe(parent.stream);
    expect(state.turnId).toBe(parent.turnId);
    expect(one(state, "nested").parentId).toBe("spawn-1");
    const events = state.subagentObservation.events("spawn-1")!;
    expect(events.map((entry) => entry.content)).toContain("synthetic child prompt");
    expect(events.map((entry) => entry.content)).toContain("synthetic child reply");
    events[0]!.content = "mutated";
    expect(state.subagentObservation.events("spawn-1")![0]!.content).toBe("synthetic child prompt");
    expect(one(state).readable).toBe(true);
    state.frame(result("nested", {}, "spawn-1"));
    expect(one(state, "nested").status).toBe("completed");
  });

  it("shows streamed child text once after finalization and never fills parent text", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1")]));
    state.frame({
      type: "stream_event",
      parent_tool_use_id: "spawn-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "streamed child" } },
    });
    expect(state.subagentObservation.events("spawn-1")![0]!.content).toBe("streamed child");
    expect(state.subagentObservation.events("spawn-1")![0]).toMatchObject({ ephemeral: true });
    state.frame(assistant([{ type: "text", text: "streamed child finalized" }], "spawn-1"));
    const rows = state.subagentObservation.events("spawn-1")!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("streamed child finalized");
    expect(rows[0]).not.toHaveProperty("ephemeral");
    expect(state.streamText).toBe("");
  });

  it("associates a child question with an observed child tool and preserves parent gates", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1")]));
    const input = {
      questions: [
        {
          header: "Pick",
          question: "Which?",
          options: [{ label: "A" }, { label: "B" }],
          multiSelect: false,
        },
      ],
    };
    state.frame(
      assistant(
        [{ type: "tool_use", id: "child-question", name: "AskUserQuestion", input }],
        "spawn-1",
      ),
    );
    state.frame({
      type: "control_request",
      request_id: "question-1",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "child-question",
        agent_id: "abc123",
        input,
      },
    });
    expect(one(state)).toMatchObject({ nativeAgentId: "abc123", status: "waiting-input" });
    expect(state.status).toBe("waiting-input");
    const revision = state.revision;
    state.frame(task("spawn-1", { is_backgrounded: true }));
    state.frame({
      type: "system",
      subtype: "task_updated",
      task_id: "task-spawn-1",
      patch: { status: "running" },
    });
    state.frame({
      type: "system",
      subtype: "background_tasks_changed",
      tasks: [{ task_id: "task-spawn-1", task_type: "local_agent" }],
    });
    state.frame({ type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(one(state).status).toBe("waiting-input");
    expect(state.revision).toBe(revision);
    state.answer("question-1", state.turnId, { "Which?": ["A"] }, state.revision);
    expect(state.status).toBe("running");
    expect(one(state).status).toBe("running");
  });

  it("never lets late task or tool receipts reverse a terminal child state", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1", true)]));
    state.frame(task());
    state.frame({
      type: "system",
      subtype: "task_notification",
      task_id: "task-spawn-1",
      tool_use_id: "spawn-1",
      status: "completed",
    });
    state.frame(result("spawn-1", { status: "running" }));
    state.frame(task());
    state.frame({
      type: "system",
      subtype: "task_updated",
      task_id: "task-spawn-1",
      patch: { status: "failed" },
    });
    expect(one(state).status).toBe("completed");
  });

  it("does not infer a new child from unknown task types or an unattributed frame", () => {
    const state = turn();
    state.frame(assistant([agent("forged")], "unseen-owner"));
    state.frame(task("unknown"));
    state.frame({
      type: "stream_event",
      parent_tool_use_id: {},
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "unattributed" } },
    });
    expect(state.snapshot().subagents).toEqual([]);
  });

  it("never applies another child's tool result to a top-level child", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1")]));
    state.frame(task());
    state.frame(result("spawn-1", { status: "completed" }, "unseen-owner"));
    expect(one(state).status).toBe("running");
    state.frame({
      type: "system",
      subtype: "task_notification",
      task_type: "local_bash",
      task_id: "task-spawn-1",
      tool_use_id: "spawn-1",
      status: "completed",
    });
    expect(one(state).status).toBe("running");
  });

  it("shows unknown on loss and stopped only after the owning process is stopped", () => {
    const lost = turn();
    lost.frame(assistant([agent("spawn-1")]));
    lost.frame(task());
    lost.fail("synthetic transport loss");
    expect(one(lost).status).toBe("unknown");
    const stopped = turn();
    stopped.frame(assistant([agent("spawn-1")]));
    stopped.frame(task());
    stopped.stop(stopped.turnId, stopped.revision);
    expect(one(stopped).status).toBe("stopped");
  });

  it("bounds retained agents and child history without throwing or touching parent text", () => {
    const state = turn();
    state.frame(assistant(Array.from({ length: 140 }, (_, index) => agent(`spawn-${index}`))));
    expect(state.snapshot().subagents).toHaveLength(128);
    for (let index = 0; index < 150; index++)
      state.frame(assistant([{ type: "text", text: `child-${index}` }], "spawn-1"));
    expect(state.subagentObservation.events("spawn-1")).toHaveLength(128);
    expect(one(state).truncated).toBe(true);
    expect(state.streamText).toBe("");
  });

  it("restores child observation with undispatched startup checkpoints", () => {
    const state = turn();
    state.frame(assistant([agent("spawn-1")]));
    const checkpoint = state.checkpoint();
    state.frame(task());
    expect(one(state).status).toBe("running");
    state.restoreUndispatched(checkpoint);
    expect(one(state).status).toBe("starting");
  });

  it("retains new active children after the completed observation window fills", () => {
    const state = turn();
    for (let index = 0; index < 128; index++) {
      state.frame(assistant([agent(`old-${index}`)]));
      state.frame(result(`old-${index}`));
    }
    state.frame(assistant([agent("spawn-1")]));
    state.frame(task());
    expect(state.snapshot().subagents).toHaveLength(128);
    expect(one(state).status).toBe("running");
  });
});

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "Claude child observation through a scripted process",
  () => {
    it("publishes child summaries and exposes child text without emitting it as parent text", async () => {
      const fixture = createFakeClaude("agentkib-subagent-read-");
      fixture.setPlan({
        onUser: [
          assistant([agent("spawn-1")]),
          task(),
          assistant([{ type: "text", text: "synthetic private child reply" }], "spawn-1"),
          result("spawn-1", { agentId: "abc123" }),
        ],
      });
      const published: ReturnType<ClaudeRunnerState["snapshot"]>[] = [];
      const parentEvents: unknown[] = [];
      const runner = new ClaudeManagedRunnerProcess(
        fixture.workspace,
        randomUUID(),
        true,
        0,
        fixture.environment,
        (snapshot) => published.push(snapshot),
        true,
        (_type, payload) => parentEvents.push(payload),
      );
      try {
        await runner.send(
          fixture.executable,
          "synthetic test",
          randomUUID(),
          runner.snapshot().revision,
        );
        await expect.poll(() => runner.snapshot().status).toBe("idle");
        expect(published.some((snapshot) => snapshot.subagents?.[0]?.status === "running")).toBe(
          true,
        );
        expect(runner.snapshot().subagents?.[0]).toMatchObject({
          status: "completed",
          nativeAgentId: "abc123",
        });
        expect(
          runner
            .subagentEvents("spawn-1")
            ?.some((item) => item.content === "synthetic private child reply"),
        ).toBe(true);
        expect(JSON.stringify(parentEvents)).not.toContain("synthetic private child reply");
        expect(runner.snapshot().lastOutcome).toBe("succeeded");
      } finally {
        await runner.shutdown();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });

    it("expires live child evidence when an idle worker is retired", async () => {
      const fixture = createFakeClaude("agentkib-subagent-retire-");
      fixture.setPlan({
        onUser: [
          assistant([agent("spawn-1", true)]),
          task("spawn-1", { is_backgrounded: true }),
          result("spawn-1", { status: "async_launched" }),
        ],
      });
      const runner = new ClaudeManagedRunnerProcess(
        fixture.workspace,
        randomUUID(),
        true,
        0,
        fixture.environment,
        () => {},
        true,
      );
      try {
        await runner.send(
          fixture.executable,
          "synthetic test",
          randomUUID(),
          runner.snapshot().revision,
        );
        await expect.poll(() => runner.snapshot().status).toBe("idle");
        expect(runner.snapshot().subagents?.[0]?.status).toBe("running");
        await runner.retireIfInactive();
        expect(runner.snapshot().subagents?.[0]?.status).toBe("unknown");
      } finally {
        await runner.shutdown();
        rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  },
);
