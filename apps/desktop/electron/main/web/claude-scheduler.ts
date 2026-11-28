import { randomUUID } from "node:crypto";
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
  private pendingPairingEnds = new Set<string>();
  private sessions = new Map<string, ClaudeScheduledSession>();
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
    await this.notifyInvalidation(deviceId, source);
    for (const session of this.sessions.values()) {
      if (session.next?.deviceId !== deviceId || (quitting && session.agent === "codex")) continue;
      await this.pause(session, reason).catch(() => undefined);
    }
  }

  private async notifyInvalidation(deviceId: string, source: ScheduleInvalidationSource) {
    if (source === "pairing-ended") this.pendingPairingEnds.delete(deviceId);
    await this.invoke(scheduleInvalidationRequest(deviceId, source)).catch(() => {
      // A pairing can end before runtime startup or during a reconnect. Its ID is
      // never reused, so keep the fence and deliver the confirmed change when ready.
      if (source === "pairing-ended") this.pendingPairingEnds.add(deviceId);
    });
  }

  tick(): Promise<void> {
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

  private async run() {
    const result = (await this.invoke({
      operation: "schedule-list",
      ...(this.serialOnly ? { serialOnly: true } : {}),
    })) as {
      sessions?: ClaudeScheduledSession[];
    };
    if (!Array.isArray(result?.sessions)) return;
    for (const deviceId of [...this.pendingPairingEnds])
      await this.notifyInvalidation(deviceId, "pairing-ended");
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
      try {
        await authority.authorize(session);
        if (!authorityIsCurrent()) continue;
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
        if (prepared?.accepted !== true || typeof prepared.permitId !== "string") continue;
        if (!authorityIsCurrent()) continue;
        const verified = await authority.authorize(session);
        if (!authorityIsCurrent()) continue;
        dispatched = true;
        const outcome = (await this.invoke({
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
        })) as Record<string, unknown>;
        if (outcome?.accepted !== true && authorityIsCurrent())
          await this.pause(session, "scheduled-dispatch-unconfirmed");
      } catch {
        // A replacement host can authorize the item after the prepared permit expires.
        if (!authorityIsCurrent()) continue;
        // Fence this session's permit or unknown dispatch without revoking the device.
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
