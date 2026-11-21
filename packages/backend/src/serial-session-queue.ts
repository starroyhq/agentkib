import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ClaudeHostStateStore,
  validClaudeDeviceId,
  type ClaudeHostState,
  type ClaudeHostWork,
} from "./agents/claude/claude-host-state";

export type SerialQueueTarget = {
  agent: "devin" | "antigravity";
  workspaceId: string;
  nativeId: string;
};

type QueueScope = SerialQueueTarget & { sessionId: string; key: string };
type State = Record<string, unknown>;
type Permit = {
  scope: QueueScope;
  item: ClaudeHostWork;
  revision: number;
  expiresAt: number;
  sending?: boolean;
};

const KEY_PREFIX = "serial-session-queue:";
const executionModes: Record<SerialQueueTarget["agent"], string> = {
  devin: "devin-print",
  antigravity: "antigravity-acp-managed",
};
const operations = [
  "queue-add",
  "queue-update",
  "queue-delete",
  "queue-pause",
  "queue-resume",
] as const;
const identifiers = {
  sessionId: z.string().min(1).max(256),
  requestId: z.uuid(),
  deviceId: z.string().refine(validClaudeDeviceId),
  runtimeBootId: z.string(),
};
const controlRequest = z.strictObject({
  ...identifiers,
  operation: z.enum(operations),
  expectedRevision: z.number().int().nonnegative(),
  experimentalEnabled: z.literal(true),
  text: z
    .string()
    .max(64 * 1024)
    .optional(),
  queuedSubmissionId: z.uuid().optional(),
  publicInputHash: z.string().max(256).optional(),
});
const scheduleTarget = {
  ...identifiers,
  expectedRevision: z.number().int().nonnegative(),
  itemId: z.uuid(),
};
const scheduleRequest = z.discriminatedUnion("operation", [
  z.strictObject({ ...scheduleTarget, operation: z.literal("schedule-prepare") }),
  z.strictObject({
    ...scheduleTarget,
    operation: z.literal("schedule-dispatch"),
    permitId: z.uuid(),
  }),
  z.strictObject({
    ...identifiers,
    operation: z.literal("schedule-pause"),
    reason: z.string().max(256).optional(),
  }),
]);
const isPendingWork = (item: ClaudeHostWork) =>
  ["pending", "claimed", "dispatched", "unknown"].includes(item.status);
const ready = (live: State) =>
  live.status === "idle" &&
  live.sendEnabled === true &&
  live.activity !== "compacting" &&
  !live.usageLimit;

function textOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 64 * 1024)
    throw new Error("invalid-text");
  return value;
}

function submission(item: ClaudeHostWork) {
  return {
    id: item.id,
    requestId: item.requestId,
    clientUserMessageId: item.originRequestId,
    status: item.status,
  };
}

/** Host-scheduled text for providers that run one turn at a time without a native queue. */
export class SerialSessionQueue {
  #store: ClaudeHostStateStore;
  #permits = new Map<string, Permit>();

  constructor(
    dataDir: string,
    readonly bootId: string,
    private readonly target: (sessionId: string) => SerialQueueTarget | undefined,
    private readonly live: (sessionId: string) => Promise<State>,
    private readonly send: (
      request: Record<string, unknown>,
      beforeNativeDispatch: () => void,
    ) => Promise<unknown>,
    private readonly changed?: (sessionId: string) => void,
  ) {
    this.#store = new ClaudeHostStateStore(dataDir, bootId);
  }

  #scope(sessionId: string): QueueScope | undefined {
    const target = this.target(sessionId);
    if (!target || !target.workspaceId || !target.nativeId) return;
    const identity = createHash("sha256")
      .update(JSON.stringify([target.agent, target.workspaceId, target.nativeId]))
      .digest("hex");
    return { ...target, sessionId, key: `${KEY_PREFIX}${sessionId}:${identity}` };
  }

  #requireScope(sessionId: string): QueueScope {
    const scope = this.#scope(sessionId);
    if (!scope) throw new Error("session-unavailable");
    return scope;
  }

  #state(scope: QueueScope): ClaudeHostState | null {
    const state = this.#store.peek(scope.key);
    return state && state.bootId !== this.bootId ? this.#store.read(scope.key) : state;
  }

  #scopes(): QueueScope[] {
    return this.#store.keysWithPrefix(KEY_PREFIX).flatMap((key) => {
      const scope = this.#scope(key.slice(KEY_PREFIX.length, key.lastIndexOf(":")));
      return scope?.key === key ? [scope] : [];
    });
  }

  #assertLive(scope: QueueScope, live: State, expectedRevision?: number): void {
    if (
      this.#scope(scope.sessionId)?.key !== scope.key ||
      live.sessionId !== scope.sessionId ||
      live.workspaceId !== scope.workspaceId
    )
      throw new Error("session-workspace-mismatch");
    if (
      live.runtimeBootId !== this.bootId ||
      (expectedRevision !== undefined && expectedRevision !== live.revision)
    )
      throw new Error("stale-or-disabled-control");
  }

  features(sessionId: string, live: State, experimentalEnabled: boolean) {
    const scope = this.#scope(sessionId);
    const readable = !!scope && live.status !== "unsupported";
    const writable = readable && experimentalEnabled;
    const state = scope && this.#state(scope);
    const unresolved = state?.work.some(
      ({ status }) => status === "unknown" || status === "dispatched",
    );
    const grant = (available: boolean, reason = "queue-unavailable") =>
      available ? { available: true } : { available: false, reason };
    return {
      queue: grant(writable),
      "queue-list": grant(readable),
      "queue-add": grant(writable),
      "queue-update": grant(writable),
      "queue-delete": grant(writable),
      "queue-pause": grant(writable && !state?.paused),
      "queue-resume": grant(
        writable && state?.paused === true && !unresolved,
        unresolved ? "control-outcome-unconfirmed" : "queue-unavailable",
      ),
    };
  }

  list(sessionId: string, limit = 100) {
    const scope = this.#requireScope(sessionId);
    const state = this.#state(scope);
    return {
      sessionId,
      paused: state?.paused ?? false,
      requiresResume: state?.paused ?? false,
      reason: state?.reason ?? null,
      data: (state?.work ?? [])
        .filter(isPendingWork)
        .slice(0, Math.min(100, Math.max(1, limit)))
        .map((item) => ({
          ...submission(item),
          hasAttachments: false,
          text: item.input,
          input: [{ type: "text" as const, text: item.input }],
        })),
    };
  }

  async control(value: unknown): Promise<Record<string, unknown>> {
    const request = controlRequest.parse(value);
    if (request.runtimeBootId !== this.bootId) throw new Error("stale-or-disabled-control");
    const scope = this.#requireScope(request.sessionId);
    const live = await this.live(scope.sessionId);
    if (this.#scope(scope.sessionId)?.key !== scope.key)
      throw new Error("session-workspace-mismatch");
    let mutated = false;
    const result = this.#store.command(
      scope.key,
      { ...request, serialQueueTarget: scope.key },
      scope.workspaceId,
      (state) => {
        this.#assertLive(scope, live, request.expectedRevision);
        if (live.status === "unsupported") throw new Error("queue-unavailable");
        mutated = true;
        if (request.operation === "queue-add") {
          if (state.work.filter(isPendingWork).length >= 100) throw new Error("queue-limit");
          const item: ClaudeHostWork = {
            id: randomUUID(),
            requestId: randomUUID(),
            originRequestId: request.requestId,
            deviceId: request.deviceId,
            originDeviceId: request.deviceId,
            kind: "queue",
            status: "pending",
            input: textOf(request.text),
            createdAt: new Date().toISOString(),
            requiresAttachments: false,
            report: null,
            usage: null,
          };
          state.work.push(item);
          return { completed: false, queuedSubmission: submission(item) };
        }
        if (request.operation === "queue-pause") {
          state.paused = true;
          state.reason = "user-paused";
          for (const item of state.work) if (item.status === "claimed") item.status = "pending";
          return {};
        }
        if (request.operation === "queue-resume") {
          if (state.work.some(({ status }) => status === "unknown" || status === "dispatched"))
            throw new Error("control-outcome-unconfirmed");
          state.paused = false;
          state.reason = null;
          return {};
        }
        const item = state.work.find(({ id }) => id === request.queuedSubmissionId);
        if (
          !item ||
          (item.status !== "pending" &&
            !(item.status === "unknown" && request.operation === "queue-delete"))
        )
          throw new Error("queue-item-unavailable");
        if (item.originRequestId) state.settledRequests.push(item.originRequestId);
        state.settledRequests = state.settledRequests.slice(-200);
        if (request.operation === "queue-delete") {
          state.work = state.work.filter((work) => work !== item);
          return {};
        }
        item.input = textOf(request.text);
        item.originRequestId = request.requestId;
        return { completed: false, queuedSubmission: submission(item) };
      },
      false,
      { sessionId: scope.sessionId, executionMode: executionModes[scope.agent] },
    );
    if (mutated) {
      if (request.operation === "queue-pause") this.#releasePermits(scope);
      this.changed?.(scope.sessionId);
    }
    return result;
  }

  #releasePermit(id: string, permit: Permit): void {
    this.#permits.delete(id);
    this.#store.update(permit.scope.key, (state) => {
      const item = state.work.find(({ requestId }) => requestId === permit.item.requestId);
      if (!item || (item.status !== "claimed" && item.status !== "pending")) return;
      item.status = "pending";
      // The old send may have opened a receipt while waiting at native preflight.
      if (permit.sending) item.requestId = randomUUID();
    });
  }

  #releasePermits(scope: QueueScope, deviceId?: string): void {
    for (const [id, permit] of this.#permits)
      if (permit.scope.key === scope.key && (!deviceId || permit.item.deviceId === deviceId))
        this.#releasePermit(id, permit);
  }

  invalidate(deviceId: string, quitting = false): void {
    for (const scope of this.#scopes()) {
      this.#releasePermits(scope, deviceId);
      const state = this.#state(scope);
      if (!state?.work.some((item) => item.deviceId === deviceId && isPendingWork(item))) continue;
      this.#store.pause(
        scope.key,
        quitting ? "restart-confirmation-required" : "authorization-changed",
      );
      this.changed?.(scope.sessionId);
    }
  }

  async scheduleList() {
    for (const [id, permit] of this.#permits) {
      if (permit.expiresAt >= Date.now()) continue;
      this.#releasePermit(id, permit);
    }
    const sessions = [];
    for (const scope of this.#scopes()) {
      if (!this.#state(scope)?.work.some(isPendingWork)) continue;
      try {
        const live = await this.live(scope.sessionId);
        this.#assertLive(scope, live);
        const next = ready(live) ? this.#store.next(scope.key) : null;
        const state = this.#state(scope);
        sessions.push({
          sessionId: scope.sessionId,
          agent: scope.agent,
          workspaceId: scope.workspaceId,
          runtimeBootId: this.bootId,
          revision: live.revision,
          paused: state?.paused ?? false,
          next: next
            ? {
                itemId: next.id,
                requestId: next.requestId,
                deviceId: next.deviceId,
                originDeviceId: next.originDeviceId,
                kind: "queue" as const,
                requiresAttachments: false,
              }
            : null,
        });
      } catch {
        // A stale or unavailable provider cannot authorize dispatch.
      }
    }
    return sessions;
  }

  async schedule(value: unknown): Promise<Record<string, unknown>> {
    const request = scheduleRequest.parse(value);
    if (request.runtimeBootId !== this.bootId) throw new Error("invalid-schedule-request");
    const scope = this.#requireScope(request.sessionId);
    if (request.operation === "schedule-pause") {
      if (
        this.#state(scope)?.work.some(
          (item) => item.deviceId === request.deviceId && isPendingWork(item),
        )
      ) {
        this.#releasePermits(scope);
        this.#store.pause(scope.key, request.reason ?? "authorization-ended");
        this.changed?.(scope.sessionId);
      }
      return { accepted: true, completed: true };
    }
    const live = await this.live(scope.sessionId);
    this.#assertLive(scope, live, request.expectedRevision);
    if (!ready(live)) throw new Error("session-busy");
    if (request.operation === "schedule-prepare") {
      const item = this.#store.claim(scope.key, request.itemId, request.deviceId);
      if (item.requestId !== request.requestId) {
        this.#store.releaseClaim(scope.key, item.id);
        throw new Error("stale-schedule-item");
      }
      const permitId = randomUUID();
      const expiresAt = Date.now() + 15_000;
      this.#permits.set(permitId, { scope, item, revision: request.expectedRevision, expiresAt });
      return {
        accepted: true,
        permitId,
        expectedRevision: request.expectedRevision,
        runtimeBootId: this.bootId,
        expiresAt,
      };
    }
    const permit = this.#permits.get(request.permitId);
    if (
      !permit ||
      permit.sending ||
      permit.scope.key !== scope.key ||
      permit.item.id !== request.itemId ||
      permit.item.requestId !== request.requestId ||
      permit.item.deviceId !== request.deviceId ||
      permit.revision !== request.expectedRevision ||
      permit.expiresAt < Date.now()
    )
      throw new Error("schedule-permit-unavailable");

    permit.sending = true;
    let dispatched = false;
    const beforeNativeDispatch = () => {
      if (
        this.#permits.get(request.permitId) !== permit ||
        permit.expiresAt < Date.now() ||
        this.#scope(scope.sessionId)?.key !== scope.key
      )
        throw new Error("schedule-permit-unavailable");
      this.#store.dispatched(scope.key, permit.item.id);
      this.#permits.delete(request.permitId);
      dispatched = true;
    };
    let result: State;
    try {
      const response = await this.send(
        {
          operation: "send",
          sessionId: scope.sessionId,
          requestId: request.requestId,
          deviceId: request.deviceId,
          runtimeBootId: this.bootId,
          expectedRevision: request.expectedRevision,
          experimentalEnabled: true,
          text: permit.item.input,
        },
        beforeNativeDispatch,
      );
      result = response && typeof response === "object" ? (response as State) : {};
    } catch {
      result = dispatched
        ? { accepted: false, controlOutcome: "unknown", reason: "control-outcome-unconfirmed" }
        : {
            accepted: false,
            controlOutcome: "not-dispatched",
            reason: "scheduled-dispatch-refused",
          };
    }
    if (!dispatched && this.#permits.get(request.permitId) !== permit)
      return {
        accepted: false,
        controlOutcome: "not-dispatched",
        reason: "schedule-permit-unavailable",
      };
    this.#permits.delete(request.permitId);
    if (!dispatched || result.controlOutcome === "not-dispatched") {
      const unknown = result.accepted === true || result.controlOutcome === "unknown";
      this.#store.update(scope.key, (state) => {
        const item = state.work.find(({ requestId }) => requestId === permit.item.requestId);
        if (item && ["claimed", "dispatched"].includes(item.status)) {
          item.status = unknown ? "unknown" : "pending";
          if (item.status === "pending") item.requestId = randomUUID();
        }
        state.paused = true;
        state.reason = unknown ? "control-outcome-unconfirmed" : "scheduled-dispatch-refused";
      });
      if (result.accepted === true)
        result = {
          accepted: false,
          controlOutcome: "unknown",
          reason: "control-outcome-unconfirmed",
        };
    } else {
      this.#store.complete(scope.key, permit.item.requestId, {
        success: result.accepted === true,
        usage: null,
        unknown: result.accepted !== true,
      });
    }
    this.changed?.(scope.sessionId);
    return result;
  }
}
