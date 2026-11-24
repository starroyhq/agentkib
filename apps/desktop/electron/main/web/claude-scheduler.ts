import { randomUUID } from "node:crypto";

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
  private epochs = new Map<string, number>();
  private quittingDevices = new Set<string>();
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

  /** `quitting`: the host stops because AgentKib quits, which the backend is told. */
  async invalidate(
    deviceId: string,
    reason = "authorization-changed",
    quitting = false,
  ): Promise<void> {
    // Advance before the first await: an in-flight prepare can no longer dispatch.
    this.epochs.set(deviceId, (this.epochs.get(deviceId) ?? 0) + 1);
    if (quitting) this.quittingDevices.add(deviceId);
    else this.quittingDevices.delete(deviceId);
    // A disconnected backend must not prevent the host from persisting revocation.
    // The epoch still fences any pending host dispatch; recovery requires confirmation.
    await this.invoke({
      operation: "schedule-invalidate",
      deviceId,
      ...(quitting ? { quitting: true } : {}),
    }).catch(() => undefined);
    for (const session of this.sessions.values()) {
      if (session.next?.deviceId !== deviceId || (quitting && session.agent === "codex")) continue;
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
      const quitting = () => session.agent === "codex" && this.quittingDevices.has(work.deviceId);
      if (quitting()) continue;
      const authority = [...this.authorities].find((entry) =>
        entry.owns(work.deviceId, session.agent),
      );
      if (!authority) {
        // The device can belong to a different desktop connected to the same runtime.
        if (this.sharedRuntimePrimary === undefined)
          await this.pause(session, "authorization-unavailable");
        continue;
      }
      const ownershipChanged = () =>
        this.sharedRuntimePrimary !== undefined &&
        (!this.authorities.has(authority) || !authority.owns(work.deviceId, session.agent));
      const epoch = this.epochs.get(work.deviceId) ?? 0;
      if (!authority.reserve(session.sessionId)) continue;
      let dispatched = false;
      try {
        await authority.authorize(session);
        if (ownershipChanged()) continue;
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
        if (ownershipChanged()) continue;
        const verified = await authority.authorize(session);
        if (ownershipChanged()) continue;
        if (!this.authorities.has(authority) || epoch !== (this.epochs.get(work.deviceId) ?? 0)) {
          if (quitting()) continue;
          await this.pause(session, "authorization-changed");
          continue;
        }
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
        if (outcome?.accepted !== true && !ownershipChanged())
          await this.pause(session, "scheduled-dispatch-unconfirmed");
      } catch {
        // A replacement desktop can now authorize this item. A prepared but undispatched
        // permit expires in the runtime without invalidating the replacement's authorization.
        if (ownershipChanged() || quitting()) continue;
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
