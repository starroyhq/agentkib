import { randomUUID } from "node:crypto";
import type { LeadTurnOrigin } from "../../lead-turn-origin";

/**
 * DeepSeek Harness sessions as a Project Agent's workers (docs/agents/project-agent.md): how one
 * starts, and how its turns are reported. Everything goes through AgentKib's DSH bridge, which
 * talks to the AgentKib plugin inside the DSH that has the session.
 */

/** What a worker needs of the DSH bridge (`DshBridge`). */
export type DshLaneBridge = {
  create(value: Record<string, unknown>): Promise<Record<string, unknown>>;
  request(value: Record<string, unknown>): Promise<unknown>;
  live(id: string, controls: boolean): Record<string, unknown>;
};

export type DshEndedTurn = {
  turnId: string;
  outcome: string;
  startedAt: string | null;
  endedAt: string | null;
};

/** DSH presets a worker may run in: the one it is moved to, and the stricter read-only. */
const WORKER_PRESET = "workspace-write";
const WORKER_PRESETS = new Set([WORKER_PRESET, "read-only"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Starts a DSH session for a worker. A new DSH session runs in the preset the user made DSH's
 * default, which may run every tool without asking; before anything is sent the worker is moved
 * to DSH's workspace-write preset (writes in the workspace, asks for anything wider). When that
 * cannot be confirmed the session stays an ordinary one and the answer is a refusal naming it.
 */
export async function createDshWorker(
  bridge: DshLaneBridge,
  value: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const created = await bridge.create(value);
  if (created.accepted !== true || typeof created.sessionId !== "string") return created;
  const sessionId = created.sessionId;
  const refused = {
    ...created,
    accepted: false,
    controlOutcome: "not-dispatched",
    reason: "dsh-worker-preset-unavailable",
  };
  // The session's settings as the settings dialog reads them; `current.policyId` is its preset.
  const settings = async () => {
    const state = await bridge.request({
      operation: "settings-state",
      sessionId,
      experimentalEnabled: true,
    });
    return isObject(state) ? state : {};
  };
  const presetOf = (state: Record<string, unknown>) =>
    isObject(state.current) && typeof state.current.policyId === "string"
      ? state.current.policyId
      : null;
  try {
    const state = await settings();
    const current = presetOf(state);
    if (current && WORKER_PRESETS.has(current)) return created;
    const offered = Array.isArray(state.policies) ? state.policies : [];
    if (!offered.some((option) => isObject(option) && option.id === WORKER_PRESET)) return refused;
    const live = bridge.live(sessionId, true);
    const changed = await bridge.request({
      operation: "settings",
      sessionId,
      requestId: randomUUID(),
      deviceId: value.deviceId,
      runtimeBootId: live.runtimeBootId,
      expectedRevision: live.revision,
      experimentalEnabled: true,
      policyId: WORKER_PRESET,
    });
    if (!isObject(changed) || changed.accepted !== true) return refused;
    // DSH runs the change as its own `/permission` command; read back what it applied.
    return presetOf(await settings()) === WORKER_PRESET ? created : refused;
  } catch {
    return refused;
  }
}

export type DshLaneWatchOptions = {
  /** Whether a session is a Project Agent's worker; asked when one of its turns ends. */
  isLane(sessionId: string): boolean;
  endedTurns(sessionId: string): Promise<DshEndedTurn[]>;
  turnEnded(
    sessionId: string,
    turnId: string,
    outcome: string,
    durationMs: number | null,
  ): Promise<void>;
  waiting(sessionId: string, turnId: string | null, status: string): Promise<void>;
  /** DSH may publish the idle state before the turn's end is in its history. */
  retryMs?: number;
  retries?: number;
};

/**
 * Reports a DSH worker's turns from the session states the bridge publishes: a turn ended when
 * the state moves off it, and the turn's outcome and length come from DSH's history. A state
 * that waits for the person is reported at once. A turn that ended while DSH was offline is left
 * to the orchestration's catch-up, which reads the same history later.
 */
export class DshLaneWatch {
  #last = new Map<string, { status: string; turnId: string | null }>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(private readonly options: DshLaneWatchOptions) {}

  observe(sessionId: string, live: Record<string, unknown>): void {
    if (this.#closed) return;
    const status = typeof live.status === "string" ? live.status : "";
    const turnId = typeof live.turnId === "string" ? live.turnId : null;
    const before = this.#last.get(sessionId);
    // Idle sessions need no memory; any other state is compared with the next one.
    if (turnId || status !== "idle") this.#last.set(sessionId, { status, turnId });
    else this.#last.delete(sessionId);
    if (before?.turnId && before.turnId !== turnId) this.#ended(sessionId, before.turnId, 0);
    // `waiting` finds out itself whether the session is a worker, as it does for Codex.
    if (
      (status === "awaiting-approval" || status === "waiting-input") &&
      (before?.status !== status || before.turnId !== turnId)
    )
      void this.options.waiting(sessionId, turnId, status).catch(() => undefined);
  }

  #ended(sessionId: string, turnId: string, attempt: number): void {
    try {
      if (this.#closed || !this.options.isLane(sessionId)) return;
    } catch {
      return;
    }
    void this.options
      .endedTurns(sessionId)
      // A read failure leaves the exact turn unverified, just like a delayed history write.
      .catch(() => [])
      .then((turns) => {
        const turn = turns.find((item) => item.turnId === turnId);
        if (!turn) {
          if (attempt < (this.options.retries ?? 2)) {
            const timer = setTimeout(() => {
              this.#timers.delete(timer);
              this.#ended(sessionId, turnId, attempt + 1);
            }, this.options.retryMs ?? 2_000);
            timer.unref?.();
            this.#timers.add(timer);
          }
          return;
        }
        const started = turn.startedAt === null ? Number.NaN : Date.parse(turn.startedAt);
        const ended = turn.endedAt === null ? Number.NaN : Date.parse(turn.endedAt);
        return this.options.turnEnded(
          sessionId,
          turnId,
          turn.outcome,
          ended >= started ? ended - started : null,
        );
      })
      .catch(() => undefined);
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#last.clear();
  }
}

export type DshLeadWatchOptions = {
  isLead(sessionId: string): boolean;
  /** Where the turn came from, from DSH's history; null while that is not known yet. */
  turnOrigin(sessionId: string, turnId: string): Promise<LeadTurnOrigin | null>;
  /** The person wrote to it in DSH's own window. */
  userSpoke(sessionId: string): void;
  /** DSH started the turn by itself: it counts, and past the limit it stops. */
  ownTurn(sessionId: string, turnId: string): Promise<void>;
  /** The opening message may reach DSH's history a moment after the turn's start. */
  retryMs?: number;
  retries?: number;
};

/**
 * Follows a DSH Project Agent's turns from the session states the bridge publishes, as
 * `DshLaneWatch` follows a worker's: each new turn is looked up in DSH's history once. A turn the
 * person opened in DSH's own window restarts the count of turns without them, as a message sent in
 * AgentKib does; one DSH started by itself counts (`LeadTurnOrigin`).
 */
export class DshLeadWatch {
  #last = new Map<string, string>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(private readonly options: DshLeadWatchOptions) {}

  observe(sessionId: string, live: Record<string, unknown>): void {
    if (this.#closed) return;
    try {
      if (!this.options.isLead(sessionId)) {
        this.#last.delete(sessionId);
        return;
      }
    } catch {
      return;
    }
    const turnId = typeof live.turnId === "string" ? live.turnId : null;
    // The last turn is kept while idle, so that it is looked up once.
    if (!turnId || this.#last.get(sessionId) === turnId) return;
    this.#last.set(sessionId, turnId);
    this.#classify(sessionId, turnId, 0);
  }

  #classify(sessionId: string, turnId: string, attempt: number): void {
    void this.options
      .turnOrigin(sessionId, turnId)
      .then((origin) => {
        if (this.#closed) return;
        if (origin === null) {
          if (attempt < (this.options.retries ?? 3)) {
            const timer = setTimeout(() => {
              this.#timers.delete(timer);
              this.#classify(sessionId, turnId, attempt + 1);
            }, this.options.retryMs ?? 1_000);
            timer.unref?.();
            this.#timers.add(timer);
          }
          return;
        }
        if (origin === "person") this.options.userSpoke(sessionId);
        else if (origin === "self") return this.options.ownTurn(sessionId, turnId);
      })
      .catch(() => undefined);
  }

  close(): void {
    this.#closed = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#last.clear();
  }
}
