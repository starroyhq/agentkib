import { randomUUID } from "node:crypto";

export interface ClaudeScheduledSession {
  sessionId: string;
  workspaceId: string;
  runtimeBootId: string;
  revision: number;
  paused: boolean;
  next: null | {
    itemId: string;
    requestId: string;
    deviceId: string;
    originDeviceId?: string;
    kind: "queue" | "goal" | "report";
    requiresAttachments?: boolean;
  };
}

export interface ClaudeScheduleAuthority {
  owns(deviceId: string): boolean;
  authorize(session: ClaudeScheduledSession): Promise<void>;
  reserve(sessionId: string): boolean;
  release(sessionId: string): void;
  settled(sessionId: string): Promise<void>;
}

/** A single desktop coordinator serves every transport. The backend never starts an
 * automatic turn without a fresh, device-scoped host authorization. */
export class ClaudeHostScheduler {
  private authorities = new Set<ClaudeScheduleAuthority>();
  private epochs = new Map<string, number>();
  private sessions = new Map<string, ClaudeScheduledSession>();
  private timer?: ReturnType<typeof setInterval>;
  private flight?: Promise<void>;

  constructor(private readonly invoke: (input: unknown) => Promise<unknown>) {}

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

  async invalidate(deviceId: string, reason = "authorization-changed"): Promise<void> {
    // Advance before the first await: an in-flight prepare can no longer dispatch.
    this.epochs.set(deviceId, (this.epochs.get(deviceId) ?? 0) + 1);
    // A disconnected backend must not prevent the host from persisting revocation.
    // The epoch still fences any pending host dispatch; recovery requires confirmation.
    await this.invoke({ operation: "schedule-invalidate", deviceId }).catch(() => undefined);
    for (const session of this.sessions.values()) {
      if (session.next?.deviceId !== deviceId) continue;
      await this.pause(session, reason).catch(() => undefined);
    }
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
      sessionId: session.sessionId,
      deviceId: session.next.deviceId,
      requestId: randomUUID(),
      runtimeBootId: session.runtimeBootId,
      reason,
    });
  }

  private async run() {
    const result = (await this.invoke({ operation: "schedule-list" })) as {
      sessions?: ClaudeScheduledSession[];
    };
    if (!Array.isArray(result?.sessions)) return;
    for (const session of result.sessions) {
      const previous = this.sessions.get(session.sessionId);
      this.sessions.set(
        session.sessionId,
        session.next ? session : previous ? { ...session, next: previous.next } : session,
      );
      if (!session.next || session.paused) {
        const owner = previous?.next?.deviceId;
        const authority = [...this.authorities].find((entry) => owner && entry.owns(owner));
        await authority?.settled(session.sessionId);
        continue;
      }
      const work = session.next;
      const authority = [...this.authorities].find((entry) => entry.owns(work.deviceId));
      if (!authority) {
        await this.pause(session, "authorization-unavailable");
        continue;
      }
      const epoch = this.epochs.get(work.deviceId) ?? 0;
      if (!authority.reserve(session.sessionId)) continue;
      let dispatched = false;
      try {
        await authority.authorize(session);
        const prepared = (await this.invoke({
          operation: "schedule-prepare",
          sessionId: session.sessionId,
          itemId: work.itemId,
          deviceId: work.deviceId,
          requestId: work.requestId,
          expectedRevision: session.revision,
          runtimeBootId: session.runtimeBootId,
        })) as Record<string, unknown>;
        if (prepared?.accepted !== true || typeof prepared.permitId !== "string") continue;
        await authority.authorize(session);
        if (!this.authorities.has(authority) || epoch !== (this.epochs.get(work.deviceId) ?? 0)) {
          await this.pause(session, "authorization-changed");
          continue;
        }
        dispatched = true;
        const outcome = (await this.invoke({
          operation: "schedule-dispatch",
          sessionId: session.sessionId,
          itemId: work.itemId,
          deviceId: work.deviceId,
          requestId: work.requestId,
          expectedRevision: prepared.expectedRevision,
          runtimeBootId: prepared.runtimeBootId,
          permitId: prepared.permitId,
        })) as Record<string, unknown>;
        if (outcome?.accepted !== true) await this.pause(session, "scheduled-dispatch-unconfirmed");
      } catch {
        // Invalidate the prepared permit even when the backend's completion is uncertain.
        await this.invoke({ operation: "schedule-invalidate", deviceId: work.deviceId }).catch(
          () => undefined,
        );
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
