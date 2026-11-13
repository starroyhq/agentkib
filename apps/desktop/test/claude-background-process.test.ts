import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeManagedRunnerProcess,
  type ClaudeRunnerOptions,
  type ClaudeRunnerSnapshot,
  type ClaudeRunnerTerminalResult,
} from "../../../packages/backend/src/claude-managed-runner";
import { createFakeClaude, processAlive, type FakeClaudePlan } from "./fixtures/claude-fake-cli";

// The managed process with background work allowed, against a scripted stand-in for the CLI. The
// frames follow the captures of the real CLI in fixtures/claude-background (see
// claude-background-turns.test.ts); here they are hand-made so the script can hold them back.

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function start(plan: FakeClaudePlan, options: ClaudeRunnerOptions = {}) {
  const fake = createFakeClaude("agentkib-claude-background-");
  // The real CLI reports when the turn of a message starts; where background work is allowed
  // the runner waits for that report.
  fake.setPlan({ lifecycle: true, ...plan });
  cleanups.push(() => rmSync(fake.root, { recursive: true, force: true }));
  const snapshots: ClaudeRunnerSnapshot[] = [];
  const results: ClaudeRunnerTerminalResult[] = [];
  const items: Array<Record<string, unknown>> = [];
  const runner = new ClaudeManagedRunnerProcess(
    fake.workspace,
    randomUUID(),
    true,
    0,
    fake.environment,
    (snapshot) => snapshots.push(snapshot),
    true,
    (type, payload) => {
      if (type === "item-upsert") items.push(structuredClone(payload));
    },
    { ...options, onResult: (result) => results.push(result) },
  );
  cleanups.push(async () => {
    await runner.shutdown().catch(() => undefined);
  });
  const turnId = randomUUID();
  const sent = runner.send(fake.executable, "synthetic turn", turnId, runner.snapshot().revision);
  return { fake, runner, snapshots, results, items, turnId, sent };
}

const BASH = "toolu_background";
const TASK = "task-background";
const startsBackgroundCommand = [
  {
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: BASH, name: "Bash", input: {} }] },
  },
  {
    type: "system",
    subtype: "background_tasks_changed",
    tasks: [{ task_id: TASK, task_type: "local_bash", description: "Watch the build" }],
  },
  {
    type: "system",
    subtype: "task_started",
    task_id: TASK,
    tool_use_id: BASH,
    description: "Watch the build",
    is_backgrounded: true,
    task_type: "local_bash",
  },
];
/** What the CLI sends when it starts a turn by itself and ends it. */
const ownTurn = (text: string) => [
  { type: "system", subtype: "status", status: "requesting" },
  {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: randomUUID(),
    message: { model: "fixture-model", content: [{ type: "text", text }] },
  },
  { type: "result", subtype: "success", is_error: false, num_turns: 1, result: text },
];
const commandEnded = [
  { type: "system", subtype: "task_notification", task_id: TASK, status: "completed" },
  { type: "system", subtype: "background_tasks_changed", tasks: [] },
];

describe.skipIf(!["darwin", "linux"].includes(process.platform))(
  "managed Claude process and background work",
  () => {
    it("turns background work off at the CLI unless it is allowed and can be ended", async () => {
      for (const allowed of [false, true]) {
        const { fake, runner, sent } = start({}, { backgroundTasks: allowed });
        await sent;
        await expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe("idle");
        // Only the macOS process-tree supervisor reaches work that left the process group.
        const enabled = allowed && process.platform === "darwin";
        expect(fake.frames()[0]!.env.background).toBe(enabled ? null : "1");
        expect(runner.state.backgroundTasksEnabled).toBe(enabled);
      }
    }, 60_000);

    it("stops the session at a background command when it is not allowed", async () => {
      const { runner, sent } = start({ onUser: startsBackgroundCommand });
      await sent;
      await expect
        .poll(() => runner.snapshot().status, { timeout: 15_000 })
        .toBe("outcome-unknown");
      expect(runner.snapshot().reason).toContain("claude-background-task");
      expect(runner.hasWorker).toBe(false);
    }, 30_000);
  },
);

describe.skipIf(process.platform !== "darwin")(
  "managed Claude process with background work allowed",
  () => {
    it("keeps the worker while a background command runs and follows the CLI's own turn", async () => {
      const { runner, results, items, snapshots, turnId, sent } = start(
        {
          onUser: startsBackgroundCommand,
          afterResult: [{ __sleep: 1200 }, ...commandEnded, ...ownTurn("The build passed.")],
        },
        { backgroundTasks: true },
      );
      await sent;
      await expect.poll(() => results.length, { timeout: 15_000 }).toBe(1);
      // The turn AgentKib sent has ended and the command still runs.
      const resting = runner.snapshot();
      expect(resting).toMatchObject({ status: "idle", sendEnabled: true, turnOrigin: "host" });
      expect(resting.backgroundTasks).toMatchObject([
        { id: TASK, kind: "command", toolUseId: BASH, description: "Watch the build" },
      ]);
      expect(runner.backgroundTaskCount).toBe(1);
      expect(runner.retireIfInactive()).toBeNull();
      expect(runner.hasWorker).toBe(true);

      await expect.poll(() => results.length, { timeout: 15_000 }).toBe(2);
      await expect.poll(() => runner.snapshot().status, { timeout: 15_000 }).toBe("idle");
      expect(results.map((result) => result.turnId)[0]).toBe(turnId);
      const ownTurnId = results[1]!.turnId;
      expect(ownTurnId).not.toBe(turnId);
      expect(results[1]).toMatchObject({ success: true });
      expect(runner.snapshot()).toMatchObject({
        status: "idle",
        turnId: ownTurnId,
        turnOrigin: "self",
        lastOutcome: "succeeded",
        backgroundTasks: [],
      });
      // While it ran, the session showed a running turn of the CLI's own.
      expect(
        snapshots.some(
          (snapshot) => snapshot.status === "running" && snapshot.turnOrigin === "self",
        ),
      ).toBe(true);
      // Its message belongs to its own turn, not to the one AgentKib sent.
      expect(
        items.find((item) => item.kind === "agent-message" && item.content === "The build passed."),
      ).toMatchObject({ turn_id: ownTurnId });
      // Nothing is left running: the worker may go.
      const retiring = runner.retireIfInactive();
      expect(retiring).not.toBeNull();
      await retiring;
      expect(runner.hasWorker).toBe(false);
    }, 60_000);

    it("ends background work with the worker", async () => {
      const { fake, runner, results, sent } = start(
        {
          // A process in a group of its own, as the CLI starts a background command.
          onUser: [...startsBackgroundCommand, { __spawn: "command", detached: true }],
        },
        { backgroundTasks: true },
      );
      await sent;
      await expect.poll(() => results.length, { timeout: 15_000 }).toBe(1);
      await expect.poll(() => fake.childPid("command"), { timeout: 15_000 }).not.toBeNull();
      const pid = fake.childPid("command")!;
      expect(processAlive(pid)).toBe(true);
      expect(runner.snapshot().backgroundTasks).toHaveLength(1);
      await runner.shutdown();
      // Killed with the tree; launchd reaps it a moment later.
      await expect.poll(() => processAlive(pid), { timeout: 8000 }).toBe(false);
      expect(runner.hasWorker).toBe(false);
      expect(runner.snapshot().backgroundTasks).toEqual([]);
    }, 60_000);

    it("stops the worker when the CLI keeps starting turns by itself", async () => {
      let limited = 0;
      const { fake, runner, results, sent } = start(
        {
          onUser: [...startsBackgroundCommand, { __spawn: "command", detached: true }],
          // A Monitor that reports event after event while nobody sends anything.
          afterResult: [
            { __sleep: 200 },
            ...ownTurn("event 1"),
            ...ownTurn("event 2"),
            ...ownTurn("event 3"),
            ...ownTurn("event 4"),
          ],
        },
        { backgroundTasks: true, selfTurnLimit: 2, onSelfTurnLimit: () => limited++ },
      );
      await sent;
      await expect.poll(() => limited, { timeout: 15_000 }).toBe(1);
      await expect.poll(() => runner.hasWorker, { timeout: 15_000 }).toBe(false);
      // Two turns of its own were allowed; the third was cut short and the worker ended.
      expect(results).toHaveLength(3);
      expect(runner.snapshot()).toMatchObject({
        status: "idle",
        sendEnabled: true,
        lastOutcome: "cancelled",
        reason: null,
        backgroundTasks: [],
      });
      await expect
        .poll(() => processAlive(fake.childPid("command")!), { timeout: 8000 })
        .toBe(false);
    }, 60_000);
  },
);
