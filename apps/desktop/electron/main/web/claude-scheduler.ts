import { randomUUID } from "node:crypto";
import { REMOTE_ERROR_CODES } from "@agentkib/runtime-protocol";
import type { DelegationAuthorizationSource } from "@agentkib/backend/local-runtime-trace";
import { CLAUDE_LOCAL_OWNER } from "./local-claude";

export type ScheduleInvalidationSource =
  | "application-quit"
  | Exclude<DelegationAuthorizationSource, "legacy-device-invalidation">;

function scheduleInvalidationRequest(deviceId: string, source: ScheduleInvalidationSource) {
  return {
    operation: "schedule-invalidate",
    deviceId,
    ...(source === "application-quit" ? { quitting: true } : { authorizationSource: source }),
  };
}

const localScheduleDevice = (deviceId: string) =>
  deviceId === CLAUDE_LOCAL_OWNER || deviceId === "desktop-local";

export async function invalidateHostSchedule(
  scheduler: ClaudeHostScheduler | undefined,
  invoke: ((input: unknown) => Promise<unknown>) | undefined,
  deviceId: string,
  source: ScheduleInvalidationSource,
): Promise<void> {
  if (scheduler) return scheduler.invalidate(deviceId, source);
  if (localScheduleDevice(deviceId)) return;
  await invoke?.(scheduleInvalidationRequest(deviceId, source)).catch(() => undefined);
}

export interface ClaudeScheduledSession {
  sessionId: string;
  /** Absent on the existing Claude host path. */
  agent?: "devin" | "antigravity" | "codex";
  workspaceId: string;
  runtimeBootId: string;
  revision: number;
  paused: boolean;
  /**
   * When a continue armed after a usage limit is due (ms since the epoch). The backend resumes
   * the session then, and its continue goes out as scheduled work like any other.
   */
  continueAt?: number | null;
  next: null | {
    itemId: string;
    requestId: string;
    deviceId: string;
    originDeviceId?: string;
    kind: "queue" | "goal" | "report" | "continue";
    requiresAttachments?: boolean;
  };
}

type ScheduleRecovery = {
  operation: "schedule-recover";
  sessionId: string;
  itemId: string;
  deviceId: string;
  requestId: string;
  runtimeBootId: string;
  permitId: string;
};

const CLAUDE_SCHEDULE_REQUEST_MS = 20_000;

export interface ClaudeScheduleAuthority {
  owns(deviceId: string, agent?: ClaudeScheduledSession["agent"]): boolean;
  authorize(session: ClaudeScheduledSession): Promise<void | { restrictNativePolicy: boolean }>;
  reserve(sessionId: string): boolean;
  release(sessionId: string): void;
  settled(sessionId: string): Promise<void>;
}

/** A single desktop coordinator serves every transport. The backend never starts an
 * automatic turn without a fresh, device-scoped host authorization. */
export class ClaudeHostScheduler {
  private authorities = new Set<ClaudeScheduleAuthority>();
  private invalidations = new Map<string, { source: ScheduleInvalidationSource }>();
  private pendingPairingEnds = new Map<string, Promise<void> | undefined>();
  private sessions = new Map<string, ClaudeScheduledSession>();
  private pendingRecoveries = new Map<string, ScheduleRecovery>();
  private recoveryChecks = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;
  private sharedRuntimePrimary?: boolean;

  constructor(
    private readonly invoke: (input: unknown) => Promise<unknown>,
    private readonly serialOnly = false,
  ) {}

  setSharedRuntimePrimary(primary: boolean): void {
    this.sharedRuntimePrimary = primary;
  }

  register(authority: ClaudeScheduleAuthority) {
    this.authorities.add(authority);
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 1000);
      this.timer.unref();
    }
    return () => {
      this.authorities.delete(authority);
      if (!this.authorities.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  /** A pairing change or app quit, never a listener restart or an unsuccessful attempt. */
  async invalidate(deviceId: string, source: ScheduleInvalidationSource): Promise<void> {
    if (localScheduleDevice(deviceId)) return;
    const quitting = source === "application-quit";
    const reason = quitting
      ? "host-stopped"
      : source === "access-downgraded"
        ? "authorization-changed"
        : "authorization-revoked";
    // Advance before the first await: an in-flight prepare can no longer dispatch.
    this.invalidations.set(deviceId, { source });
    if (source === "pairing-ended") await this.notifyPairingEnd(deviceId);
    else await this.invoke(scheduleInvalidationRequest(deviceId, source)).catch(() => undefined);
    for (const session of this.sessions.values()) {
      if (session.next?.deviceId !== deviceId || (quitting && session.agent === "codex")) continue;
      await this.pause(session, reason).catch(() => undefined);
    }
  }

  private notifyPairingEnd(deviceId: string): Promise<void> {
    const inFlight = this.pendingPairingEnds.get(deviceId);
    if (inFlight) return inFlight;
    const notification = this.invoke(scheduleInvalidationRequest(deviceId, "pairing-ended")).then(
      () => {
        this.pendingPairingEnds.delete(deviceId);
      },
      () => {
        // Pairing IDs are never reused. Keep the fence and retry after a reconnect.
        this.pendingPairingEnds.set(deviceId, undefined);
      },
    );
    this.pendingPairingEnds.set(deviceId, notification);
    return notification;
  }

  tick(): Promise<void> {
    // The delegation ledger can be reachable even when the managed session list is not.
    for (const [deviceId, inFlight] of this.pendingPairingEnds)
      if (!inFlight) void this.notifyPairingEnd(deviceId);
    if (this.flight) return this.flight;
    this.flight = this.run()
      .catch(() => {
        // Runtime disconnection retains durable work; the replacement backend starts paused.
      })
      .finally(() => {
        this.flight = undefined;
      });
    return this.flight;
  }

  private async pause(session: ClaudeScheduledSession, reason: string) {
    if (!session.next) return;
    await this.invoke({
      operation: "schedule-pause",
      ...(session.agent === "codex" ? { agent: "codex", itemId: session.next.itemId } : {}),
      sessionId: session.sessionId,
      deviceId: session.next.deviceId,
      requestId: randomUUID(),
      runtimeBootId: session.runtimeBootId,
      reason,
    });
  }

  private async waitForClaudeSchedule<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(REMOTE_ERROR_CODES.outcomeUnknown)),
            CLAUDE_SCHEDULE_REQUEST_MS,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async recover(request: ScheduleRecovery): Promise<void> {
    const id = request.sessionId;
    // A deadline only releases the host's wait. The same raw lookup may still be queued in
    // the provider's session lane, so keep at most one check and accept a late reply from it.
    if (this.recoveryChecks.has(id)) return;
    this.recoveryChecks.add(id);
    const lookup = (async () => {
      const reply = (await this.invoke(request)) as { status?: unknown } | undefined;
      if (
        this.pendingRecoveries.get(id) === request &&
        (reply?.status === "not-dispatched" ||
          reply?.status === "dispatched" ||
          reply?.status === "unknown")
      )
        this.pendingRecoveries.delete(id);
    })().finally(() => this.recoveryChecks.delete(id));
    await this.waitForClaudeSchedule(lookup).catch(() => undefined);
  }

  private async run() {
    // A lost lookup blocks only the original session. Resolve ready queues independently;
    // even a definite non-dispatch is retried on a new tick with fresh authorization.
    const blocked = new Set(this.pendingRecoveries.keys());
    const recoveries = [...this.pendingRecoveries.values()].map((request) => this.recover(request));
    try {
      await this.dispatchReady(blocked, recoveries);
    } finally {
      await Promise.all(recoveries);
    }
  }

  private async dispatchReady(blocked: ReadonlySet<string>, recoveries: Promise<void>[]) {
    const result = (await this.invoke({
      operation: "schedule-list",
      ...(this.serialOnly ? { serialOnly: true } : {}),
    })) as {
      sessions?: ClaudeScheduledSession[];
    };
    if (!Array.isArray(result?.sessions)) return;
    const reported = new Set(result.sessions.map(({ sessionId }) => sessionId));
    for (const [id, session] of this.sessions)
      if (session.agent === "codex" && !reported.has(id)) this.sessions.delete(id);
    for (const session of result.sessions) {
      if (this.serialOnly && session.agent === undefined) continue;
      const previous = this.sessions.get(session.sessionId);
      this.sessions.set(
        session.sessionId,
        session.next ? session : previous ? { ...session, next: previous.next } : session,
      );
      if (blocked.has(session.sessionId)) continue;
      if (session.paused && typeof session.continueAt === "number") {
        if (this.sharedRuntimePrimary === false || Date.now() < session.continueAt) continue;
        // The backend checks again that it is due; the next tick dispatches what it queued.
        await this.invoke({ operation: "schedule-continue", sessionId: session.sessionId }).catch(
          () => undefined,
        );
        continue;
      }
      if (!session.next || session.paused) {
        const owner = previous?.next?.deviceId;
        const authority = [...this.authorities].find(
          (entry) => owner && entry.owns(owner, session.agent),
        );
        await authority?.settled(session.sessionId);
        continue;
      }
      const work = session.next;
      const invalidation = this.invalidations.get(work.deviceId);
      // While the pairing-end RPC is outstanding, skip that device and service other queues.
      if (this.pendingPairingEnds.has(work.deviceId)) continue;
      if (session.agent === "codex" && invalidation?.source === "application-quit") continue;
      const authority = [...this.authorities].find((entry) =>
        entry.owns(work.deviceId, session.agent),
      );
      if (!authority) {
        // An explicitly ended pairing can have queued work the scheduler has not seen yet.
        // A missing transport alone is not a revocation.
        if (
          invalidation &&
          invalidation.source !== "application-quit" &&
          invalidation.source !== "access-downgraded"
        )
          await this.pause(session, "authorization-revoked");
        continue;
      }
      const authorityIsCurrent = () =>
        this.authorities.has(authority) &&
        authority.owns(work.deviceId, session.agent) &&
        invalidation === this.invalidations.get(work.deviceId);
      if (!authority.reserve(session.sessionId)) continue;
      let dispatched = false;
      let preparing = false;
      let recovery: ScheduleRecovery | undefined;
      const recoverDispatch = (request: ScheduleRecovery) => {
        this.pendingRecoveries.set(request.sessionId, request);
        recoveries.push(this.recover(request));
      };
      try {
        await authority.authorize(session);
        if (!authorityIsCurrent()) continue;
        preparing = true;
        const prepared = (await this.invoke({
          operation: "schedule-prepare",
          ...(session.agent === "codex" ? { agent: "codex" } : {}),
          sessionId: session.sessionId,
          itemId: work.itemId,
          deviceId: work.deviceId,
          requestId: work.requestId,
          expectedRevision: session.revision,
          runtimeBootId: session.runtimeBootId,
        })) as Record<string, unknown>;
        preparing = false;
        if (prepared?.accepted !== true || typeof prepared.permitId !== "string") continue;
        if (!authorityIsCurrent()) continue;
        const verified = await authority.authorize(session);
        if (!authorityIsCurrent()) continue;
        dispatched = true;
        if (session.agent === undefined)
          recovery = {
            operation: "schedule-recover",
            sessionId: session.sessionId,
            itemId: work.itemId,
            deviceId: work.deviceId,
            requestId: work.requestId,
            runtimeBootId: session.runtimeBootId,
            permitId: prepared.permitId,
          };
        const dispatch = this.invoke({
          operation: "schedule-dispatch",
          ...(session.agent === "codex" ? { agent: "codex" } : {}),
          sessionId: session.sessionId,
          itemId: work.itemId,
          deviceId: work.deviceId,
          requestId: work.requestId,
          expectedRevision: prepared.expectedRevision,
          runtimeBootId: prepared.runtimeBootId,
          permitId: prepared.permitId,
          ...(session.agent === "codex" && {
            restrictNativePolicy: verified?.restrictNativePolicy !== false,
          }),
        });
        const outcome = (await (recovery ? this.waitForClaudeSchedule(dispatch) : dispatch)) as
          | Record<string, unknown>
          | undefined;
        if (outcome?.accepted !== true) {
          if (recovery) recoverDispatch(recovery);
          else if (authorityIsCurrent())
            await this.pause(session, "scheduled-dispatch-unconfirmed");
        }
      } catch {
        if (recovery) {
          recoverDispatch(recovery);
          continue;
        }
        // A Claude prepare can only leave a claim and an expiring permit. No dispatch was made.
        if (!authorityIsCurrent() || (preparing && session.agent === undefined)) continue;
        // Fence this session's permit without revoking the device.
        await this.pause(
          session,
          dispatched ? "scheduled-outcome-unknown" : "authorization-or-prepare-failed",
        ).catch(() => undefined);
      } finally {
        authority.release(session.sessionId);
        await authority.settled(session.sessionId);
      }
    }
  }
}
