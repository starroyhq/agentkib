// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshLeadWatch } from "../../../packages/backend/src/dsh-lanes";
import {
  CodexLeadTurns,
  dshTurnOrigin,
  haltOwnTurns,
} from "../../../packages/backend/src/lead-turn-origin";

// Which of a Project Agent's turns its agent started by itself. The Codex notification orders are
// those Codex 0.167.0's app-server sent against a local mock model (2026-11-16): a turn AgentKib
// starts opens with its user message, carrying AgentKib's request id as `clientId`; a goal's
// automatic round opens with the agent's reply.

const notify = (turns: CodexLeadTurns, method: string, params: Record<string, unknown>) =>
  turns.observe({ method, params });
const started = (turns: CodexLeadTurns, id: string) =>
  notify(turns, "turn/started", { threadId: "t", turn: { id } });
const item = (turns: CodexLeadTurns, turnId: string, value: Record<string, unknown>) =>
  notify(turns, "item/started", { threadId: "t", turnId, item: value });
const completed = (turns: CodexLeadTurns, id: string) =>
  notify(turns, "turn/completed", { threadId: "t", turn: { id } });

describe("a Codex Project Agent's own turns", () => {
  it("leaves a turn opened by a message AgentKib sent, or a manual compaction, alone", () => {
    const turns = new CodexLeadTurns();
    expect(started(turns, "sent")).toBeNull();
    expect(item(turns, "sent", { type: "userMessage", id: "m", clientId: "request-1" })).toBeNull();
    expect(item(turns, "sent", { type: "agentMessage", id: "a" })).toBeNull();
    expect(completed(turns, "sent")).toBeNull();
    started(turns, "compact");
    expect(item(turns, "compact", { type: "contextCompaction", id: "c" })).toBeNull();
    expect(completed(turns, "compact")).toBeNull();
  });

  it("tells a goal's automatic round, and a message nobody in AgentKib sent, once", () => {
    const turns = new CodexLeadTurns();
    started(turns, "round");
    expect(item(turns, "round", { type: "agentMessage", id: "a" })).toBe("round");
    expect(
      notify(turns, "item/completed", { turnId: "round", item: { type: "agentMessage" } }),
    ).toBeNull();
    expect(completed(turns, "round")).toBeNull();
    started(turns, "typed");
    expect(item(turns, "typed", { type: "userMessage", id: "m", clientId: null })).toBe("typed");
    // A turn that ends with no item at all was nobody's message either.
    started(turns, "empty");
    expect(completed(turns, "empty")).toBe("empty");
    // Notifications of turns it never saw start are not its to judge.
    expect(item(turns, "unknown", { type: "agentMessage" })).toBeNull();
    expect(notify(turns, "thread/goal/updated", { goal: { status: "active" } })).toBeNull();
  });
});

describe("a DeepSeek Harness turn's origin", () => {
  const id = (turn: unknown) => (typeof turn === "number" ? `dsh-turn-${turn}` : null);
  const start = (turn: number) => ({ kind: "turn-start", turn });

  it("is the person's message, AgentKib's, or none", () => {
    expect(dshTurnOrigin([start(1), { kind: "user", rpcId: null }], "dsh-turn-1", id)).toBe(
      "person",
    );
    expect(dshTurnOrigin([start(1), { kind: "user", rpcId: "request-1" }], "dsh-turn-1", id)).toBe(
      "agentkib",
    );
    // A goal's round: its prompt is the goal's, which the history leaves out.
    expect(dshTurnOrigin([start(1), { kind: "assistant", turn: 1 }], "dsh-turn-1", id)).toBe(
      "self",
    );
    expect(dshTurnOrigin([start(1), { kind: "turn-end", turn: 1 }], "dsh-turn-1", id)).toBe("self");
    // Earlier turns do not decide this one.
    expect(
      dshTurnOrigin(
        [start(1), { kind: "user", rpcId: null }, start(2), { kind: "tool-call" }],
        "dsh-turn-2",
        id,
      ),
    ).toBe("self");
  });

  it("is not known yet while the history shows only the start, or not even that", () => {
    expect(dshTurnOrigin([start(1)], "dsh-turn-1", id)).toBeNull();
    expect(dshTurnOrigin([start(1), { kind: "user" }], "dsh-turn-2", id)).toBeNull();
  });
});

describe("following a DeepSeek Harness Project Agent's turns", () => {
  afterEach(() => vi.useRealTimers());

  function watch(origins: Array<"agentkib" | "person" | "self" | null>, lead = true) {
    const calls: string[] = [];
    const turnOrigin = vi.fn(async () => origins.shift() ?? null);
    const watcher = new DshLeadWatch({
      isLead: () => lead,
      turnOrigin,
      userSpoke: (sessionId) => void calls.push(`spoke:${sessionId}`),
      ownTurn: async (sessionId, turnId) => void calls.push(`own:${sessionId}:${turnId}`),
      retryMs: 10,
      retries: 2,
    });
    return { watcher, calls, turnOrigin };
  }
  const running = (turnId: string | null) => ({ status: turnId ? "running" : "idle", turnId });

  it("looks each new turn up once: the person's restarts the count, its own counts", async () => {
    const { watcher, calls, turnOrigin } = watch(["person", "agentkib", "self"]);
    watcher.observe("lead", running("dsh-turn-1"));
    await vi.waitFor(() => expect(calls).toEqual(["spoke:lead"]));
    // The same turn again, and idle in between, are not new turns.
    watcher.observe("lead", running("dsh-turn-1"));
    watcher.observe("lead", running(null));
    watcher.observe("lead", running("dsh-turn-2"));
    watcher.observe("lead", running("dsh-turn-3"));
    await vi.waitFor(() => expect(calls).toEqual(["spoke:lead", "own:lead:dsh-turn-3"]));
    expect(turnOrigin).toHaveBeenCalledTimes(3);
    watcher.close();
  });

  it("asks again while the history does not show the turn's opening yet", async () => {
    const { watcher, calls, turnOrigin } = watch([null, null, "self"]);
    watcher.observe("lead", running("dsh-turn-4"));
    await vi.waitFor(() => expect(calls).toEqual(["own:lead:dsh-turn-4"]));
    expect(turnOrigin).toHaveBeenCalledTimes(3);
    watcher.close();
  });

  it("leaves a session that is no Project Agent alone", async () => {
    const { watcher, turnOrigin } = watch(["self"], false);
    watcher.observe("other", running("dsh-turn-1"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turnOrigin).not.toHaveBeenCalled();
    watcher.close();
  });
});

describe("stopping a Project Agent's own turn past its limit", () => {
  /** A session whose live states come in order, and whose controls answer as `answers` say. */
  function target(states: Array<Record<string, unknown>>, answers: Array<Error | unknown> = []) {
    const controls: Array<Record<string, unknown>> = [];
    return {
      controls,
      live: async () => states.shift() ?? {},
      control: async (value: Record<string, unknown>) => {
        controls.push(value);
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  }
  const running = (revision: number, goal: unknown = null, turnId = "round-3") => ({
    runtimeBootId: "boot",
    revision,
    turnId,
    stopEnabled: true,
    goal,
  });
  const stale = () => new Error("AgentKib command failed: stale-or-disabled-control");

  it("pauses a Codex goal, in the name of the lead's device; the round under way ends by itself", async () => {
    const t = target([running(5, { status: "active" })]);
    await haltOwnTurns(t, "lead", "round-3", "phone-1", "codex");
    expect(t.controls).toEqual([
      expect.objectContaining({
        operation: "goal-pause",
        sessionId: "lead",
        deviceId: "phone-1",
        expectedRevision: 5,
        experimentalEnabled: true,
      }),
    ]);
  });

  it("tries again with a fresh revision while the session moves on", async () => {
    const t = target(
      [running(5, { status: "active" }), running(9, { status: "active" })],
      [stale()],
    );
    await haltOwnTurns(t, "lead", "round-3", "phone-1", "codex");
    expect(t.controls.map((control) => [control.operation, control.expectedRevision])).toEqual([
      ["goal-pause", 5],
      ["goal-pause", 9],
    ]);
    // A goal that is not active any more needs nothing.
    const paused = target([running(5, { status: "paused" })]);
    await haltOwnTurns(paused, "lead", "round-3", "phone-1", "codex");
    expect(paused.controls).toEqual([]);
  });

  it("stops a DSH round while it runs, and nothing once that turn is over", async () => {
    const dsh = target([running(2, { status: "active" })]);
    await haltOwnTurns(dsh, "lead", "round-3", "desktop-local", "deepseek-harness");
    expect(dsh.controls).toEqual([
      expect.objectContaining({ operation: "stop", turnId: "round-3", expectedRevision: 2 }),
    ]);
    const over = target([running(7, null, "round-4")]);
    await haltOwnTurns(over, "lead", "round-3", "desktop-local", "deepseek-harness");
    expect(over.controls).toEqual([]);
  });
});
