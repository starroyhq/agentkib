// @vitest-environment node
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { expect, it, vi } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerSnapshot,
} from "../../../packages/backend/src/agents/claude/claude-managed-runner";
import { createFakeClaude } from "./fixtures/claude-fake-cli";

const todoWrite = (id: string, content: string, parent: string | null = null) => ({
  type: "assistant",
  uuid: randomUUID(),
  parent_tool_use_id: parent,
  message: {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "TodoWrite",
        input: { todos: [{ content, status: "in_progress" }] },
      },
    ],
  },
});

const todoResult = (toolId: string, isError = false, parent: string | null = null) => ({
  type: "user",
  parent_tool_use_id: parent,
  message: {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: toolId, is_error: isError, content: "TodoWrite result" },
    ],
  },
});

it.skipIf(!["darwin", "linux"].includes(process.platform))(
  "projects confirmed main-thread TodoWrite results and rejects late results from another turn",
  async () => {
    const f = createFakeClaude("agentkib-claude-plan-");
    const snapshots: ClaudeRunnerSnapshot[] = [];
    const runner = new ClaudeManagedRunnerProcess(
      f.workspace,
      randomUUID(),
      true,
      0,
      f.environment,
      (snapshot) => snapshots.push(snapshot),
    );
    try {
      f.setPlan({
        onUser: [
          todoWrite("toolu_running", "Check the failing case"),
          todoResult("toolu_running"),
          todoWrite("toolu_refused", "A failed write"),
          todoResult("toolu_refused", true),
          todoWrite("toolu_subagent", "A sub-agent's plan", "toolu_agent"),
          todoResult("toolu_subagent", false, "toolu_agent"),
          todoWrite("toolu_late", "Waited for a prior result"),
        ],
      });
      const firstTurn = randomUUID();
      await runner.send(f.executable, "start the plan", firstTurn, runner.snapshot().revision);
      await vi.waitFor(() => expect(runner.snapshot().status).toBe("idle"));
      const plan = runner.snapshot().planProgress;
      expect(plan).toMatchObject({
        turnId: firstTurn,
        steps: [{ text: "Check the failing case", status: "in_progress" }],
        currentStepId: plan?.steps[0]?.id,
      });
      expect(
        snapshots.some((snapshot) => snapshot.status === "running" && snapshot.planProgress),
      ).toBe(true);

      f.setPlan({ onUser: [todoResult("toolu_late")] });
      const secondTurn = randomUUID();
      await runner.send(f.executable, "next turn", secondTurn, runner.snapshot().revision);
      await vi.waitFor(() => expect(runner.snapshot().status).toBe("idle"));
      expect(runner.snapshot().planProgress).toBeNull();
      expect(
        snapshots.filter(({ turnId }) => turnId === secondTurn).map((s) => s.planProgress),
      ).not.toContainEqual(expect.objectContaining({ turnId: firstTurn }));
    } finally {
      await runner.shutdown();
      rmSync(f.root, { recursive: true, force: true });
    }
  },
);
