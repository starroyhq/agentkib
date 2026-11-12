import { EventEmitter } from "node:events";
import {
  RUNTIME_METHODS,
  SESSION_EVENT_NOTIFICATION,
  type SessionStreamEvent,
  type SessionSubscription,
} from "../generated/runtime-protocol";

interface PendingCleanup {
  subscriptionId: string;
  runtimeGeneration: number;
  failures: number;
  retryAt: number;
}

/** One dispatcher for both IPC and SSE. Observation never acquires native write ownership. */
export class ConversationHub extends EventEmitter {
  private observers = new Map<string, (event: SessionStreamEvent) => void>();
  private early = new Map<string, SessionStreamEvent[]>();
  private earlyBytes = new Map<string, number>();
  private generation = 0;
  private runtimeGeneration = 0;
  private pending = 0;
  private cleanups = new Map<string, PendingCleanup>();
  private cleanupFlight?: PendingCleanup;
  private cleanupTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly request: (method: string, params: unknown) => Promise<unknown>) {
    super();
  }

  notification(method: string, params: unknown) {
    if (method !== SESSION_EVENT_NOTIFICATION || !params || typeof params !== "object") return;
    const event = params as SessionStreamEvent;
    if (event.protocolVersion !== 2 || typeof event.subscriptionId !== "string") return;
    if (this.cleanups.has(event.subscriptionId)) return;
    if (
      event.type === "invalidate" &&
      Array.isArray(event.payload?.domains) &&
      event.payload.domains.includes("catalog")
    )
      this.emit("catalog-invalidated");
    const observer = this.observers.get(event.subscriptionId);
    if (observer) observer(event);
    else if (this.pending) {
      // Notifications may arrive before their subscribe RPC response on stdout.
      const queued = this.early.get(event.subscriptionId) ?? [];
      if (queued[0]?.type === "resync-required") return;
      const bytes =
        (this.earlyBytes.get(event.subscriptionId) ?? 0) + Buffer.byteLength(JSON.stringify(event));
      if (queued.length >= 256 || bytes > 4 * 1024 * 1024) {
        this.earlyBytes.delete(event.subscriptionId);
        this.early.set(event.subscriptionId, [
          { ...event, type: "resync-required", payload: { reason: "subscriber_overflow" } },
        ]);
      } else {
        this.earlyBytes.set(event.subscriptionId, bytes);
        queued.push(event);
        this.early.set(event.subscriptionId, queued);
      }
    }
  }

  async subscribe(
    sessionId: string,
    afterCursor: string | undefined,
    listener: (event: SessionStreamEvent) => void,
  ): Promise<SessionSubscription> {
    const generation = this.generation;
    const runtimeGeneration = this.runtimeGeneration;
    this.pending++;
    try {
      const result = (await this.request(RUNTIME_METHODS.sessionsSubscribe, {
        sessionId,
        afterCursor,
      })) as SessionSubscription;
      if (generation !== this.generation) {
        // A scope change still needs cleanup in the same Runtime. An exited
        // Runtime has already lost its subscriptions; never send its IDs again.
        void this.queueCleanup(result.subscriptionId, runtimeGeneration);
        throw new Error("runtime_restarted");
      }
      this.observers.set(result.subscriptionId, listener);
      const early = this.early.get(result.subscriptionId) ?? [];
      this.early.delete(result.subscriptionId);
      this.earlyBytes.delete(result.subscriptionId);
      const last = result.events.at(-1);
      const events = [
        ...result.events,
        ...early.filter((event) => !last || event.epoch !== last.epoch || event.seq > last.seq),
      ];
      return { ...result, events, cursor: events.at(-1)?.cursor ?? result.cursor };
    } finally {
      this.pending--;
      if (!this.pending) {
        this.early.clear();
        this.earlyBytes.clear();
      }
    }
  }

  async unsubscribe(subscriptionId: string) {
    const known = this.observers.delete(subscriptionId);
    this.early.delete(subscriptionId);
    this.earlyBytes.delete(subscriptionId);
    if (known || this.cleanups.has(subscriptionId))
      await this.queueCleanup(subscriptionId, this.runtimeGeneration);
  }

  private queueCleanup(subscriptionId: string, runtimeGeneration: number): Promise<void> {
    if (runtimeGeneration !== this.runtimeGeneration) return Promise.resolve();
    if (!this.cleanups.has(subscriptionId))
      this.cleanups.set(subscriptionId, {
        subscriptionId,
        runtimeGeneration,
        failures: 0,
        retryAt: 0,
      });
    return this.flushCleanup();
  }

  private async flushCleanup() {
    if (this.cleanupFlight) return;
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    const next = [...this.cleanups.values()].sort((a, b) => a.retryAt - b.retryAt)[0];
    if (!next) return;
    if (next.retryAt > Date.now()) {
      this.scheduleCleanup(next.retryAt - Date.now());
      return;
    }
    this.cleanupFlight = next;
    try {
      await this.request(RUNTIME_METHODS.sessionsUnsubscribe, {
        subscriptionId: next.subscriptionId,
      });
      if (this.cleanups.get(next.subscriptionId) === next)
        this.cleanups.delete(next.subscriptionId);
    } catch {
      // This idempotent observer cleanup can be rejected by the Runtime's
      // bounded read queue. Retain it, without retrying any control or subscribe.
      next.retryAt = Date.now() + Math.min(100 * 2 ** Math.min(next.failures++, 6), 5_000);
    } finally {
      if (this.cleanupFlight === next) {
        this.cleanupFlight = undefined;
        if (next.runtimeGeneration === this.runtimeGeneration && this.cleanups.size)
          this.scheduleCleanup();
      }
    }
  }

  private scheduleCleanup(delay?: number) {
    clearTimeout(this.cleanupTimer);
    const earliest = Math.min(...[...this.cleanups.values()].map((entry) => entry.retryAt));
    this.cleanupTimer = setTimeout(
      () => {
        this.cleanupTimer = undefined;
        void this.flushCleanup();
      },
      delay ?? Math.max(0, earliest - Date.now()),
    );
    // Pending observer cleanup must not keep Electron alive during shutdown.
    this.cleanupTimer.unref();
  }

  unavailable() {
    this.runtimeGeneration++;
    this.cleanups.clear();
    this.cleanupFlight = undefined;
    clearTimeout(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.invalidateObservers();
  }

  private invalidateObservers() {
    this.generation++;
    this.observers.clear();
    this.early.clear();
    this.earlyBytes.clear();
    this.emit("unavailable");
  }

  scopesChanged() {
    const subscriptions = [...this.observers.keys()];
    // The process is unchanged, so failed cleanups must survive scope changes.
    for (const subscriptionId of subscriptions)
      void this.queueCleanup(subscriptionId, this.runtimeGeneration);
    this.invalidateObservers();
  }
}
