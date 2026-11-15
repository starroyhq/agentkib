/**
 * Which turns of a Codex or DeepSeek Harness Project Agent its agent started by itself, such as a
 * goal's next round, and which a person started in the agent's own window. A Project Agent's
 * turns without the person count toward its limit of automatic turns, as a Claude Code one's do
 * (docs/agents/project-agent.md); a person's message restarts the count.
 */

import { randomUUID } from "node:crypto";

/** Where a turn came from. AgentKib's own messages were counted, or not, when it sent them. */
export type LeadTurnOrigin = "agentkib" | "person" | "self";

type Json = Record<string, unknown>;
const object = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};

const MAX_PENDING = 64;

/**
 * Follows a Codex app-server's notifications for one thread. AgentKib marks every message it sends
 * with its request id, which Codex keeps as the user message's `clientId`, and a manual compaction
 * is a turn AgentKib asked for. Only AgentKib writes to a thread it runs, so a turn whose first
 * item is anything else, or that ends with none, is Codex's own: a goal's automatic continuation.
 */
export class CodexLeadTurns {
  #pending = new Set<string>();

  /** One notification; answers the turn it shows Codex started by itself, once. */
  observe(value: unknown): string | null {
    const envelope = object(value);
    const params = object(envelope.params);
    switch (envelope.method) {
      case "turn/started": {
        const id = object(params.turn).id;
        if (typeof id !== "string" || !id) return null;
        this.#pending.add(id);
        if (this.#pending.size > MAX_PENDING)
          this.#pending.delete(this.#pending.values().next().value!);
        return null;
      }
      case "item/started":
      case "item/completed": {
        const turnId = params.turnId;
        if (typeof turnId !== "string" || !this.#pending.delete(turnId)) return null;
        const item = object(params.item);
        const ours =
          (item.type === "userMessage" && typeof item.clientId === "string" && !!item.clientId) ||
          item.type === "contextCompaction";
        return ours ? null : turnId;
      }
      case "turn/completed": {
        const id = object(params.turn).id;
        return typeof id === "string" && this.#pending.delete(id) ? id : null;
      }
      default:
        return null;
    }
  }
}

/**
 * Where a DeepSeek Harness turn came from, from the session's history as AgentKib's DSH plugin
 * projects it: DSH records a turn's start and then the message that opened it. A person's message
 * typed in DSH's window has no request id; one AgentKib sent (the person's, or a report) has its
 * request id. A turn that goes on without a person's message first is DSH's own: a goal's next
 * round, whose prompt DSH marks as the goal's, or a turn after a sub-agent ends. Null while the
 * history shows the turn's start and nothing after it yet.
 */
export function dshTurnOrigin(
  records: ReadonlyArray<Json>,
  turnId: string,
  turnIdOf: (turn: unknown) => string | null,
): LeadTurnOrigin | null {
  const start = records.findIndex(
    (record) => record.kind === "turn-start" && turnIdOf(record.turn) === turnId,
  );
  if (start < 0) return null;
  const next = records[start + 1];
  if (!next) return null;
  if (next.kind !== "user") return "self";
  return typeof next.rpcId === "string" && next.rpcId ? "agentkib" : "person";
}

/**
 * Keeps a Project Agent from starting more turns by itself once it is past its limit, in the name
 * of `deviceId`, with the session's own controls. A Codex goal is paused and the round under way
 * ends by itself: stopping it can meet the round's end, which leaves the session's outcome
 * unconfirmed (seen with Codex 0.167.0 when rounds are short). A DeepSeek Harness round is stopped
 * while it runs, and DSH pauses its goal when the round is stopped. A goal that cannot be paused
 * now goes on, and its next round, counted in its turn, tries again.
 */
export async function haltOwnTurns(
  target: {
    live(sessionId: string): Promise<Json>;
    control(value: Json): Promise<unknown>;
  },
  sessionId: string,
  turnId: string,
  deviceId: string,
  agent: "codex" | "deepseek-harness",
  attempts = 8,
): Promise<void> {
  /**
   * One control while `due` holds: true once accepted, null when no longer due, false when
   * refused. A running session's revision moves with every event, so each try reads it afresh.
   */
  const act = async (
    operation: string,
    due: (live: Json) => boolean,
    extra: Json = {},
  ): Promise<boolean | null> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const live = await target.live(sessionId);
      if (!due(live)) return null;
      try {
        const outcome = object(
          await target.control({
            operation,
            sessionId,
            requestId: randomUUID(),
            deviceId,
            runtimeBootId: live.runtimeBootId,
            expectedRevision: live.revision,
            experimentalEnabled: true,
            ...extra,
          }),
        );
        return outcome.accepted !== false;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("stale-or-disabled-control")))
          return false;
      }
    }
    return false;
  };
  if (agent === "codex") await act("goal-pause", (live) => object(live.goal).status === "active");
  else await act("stop", (live) => live.turnId === turnId && live.stopEnabled === true, { turnId });
}
