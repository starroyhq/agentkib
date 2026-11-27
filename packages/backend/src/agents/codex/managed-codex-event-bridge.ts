import type { CodexAppServerSession } from "./codex-app-server";
import type {
  AppliedCodexEvent,
  ManagedCodexState,
  ServerRequestReply,
} from "./managed-codex-state";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ManagedCodexEventBridge {
  #pending: Promise<void> = Promise.resolve();
  #closed = false;
  #closing?: Promise<void>;
  #streamDirty = false;
  #checkpointTimer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly session: CodexAppServerSession,
    readonly state: ManagedCodexState,
    readonly persist: (state: ManagedCodexState, event?: JsonObject) => Promise<void> | void,
    readonly onApplied?: (
      value: unknown,
      result: AppliedCodexEvent,
      state: ManagedCodexState,
    ) => void,
    /**
     * Messages of another thread on the same app-server that are none of the session's, such as
     * the temporary thread that names it (`codex-thread-title.ts`): never applied or persisted.
     */
    readonly ignore?: (value: unknown) => boolean,
  ) {
    session.on("notification", (value: unknown) => this.#enqueue(value));
    session.on("serverRequest", (value: unknown) => this.#enqueue(value));
    session.on("close", () => this.#enqueue({ method: "agentkib/disconnected", params: {} }));
  }

  async snapshot(runtimeBootId: string, controls: boolean): Promise<JsonObject> {
    await this.#pending;
    return this.state.snapshot(runtimeBootId, controls && this.session.connected);
  }

  async acceptVerifiedCompletion(
    threadId: string,
    turn: JsonObject,
    current: () => boolean,
    replyText?: string,
  ) {
    this.#enqueue(
      { method: "turn/completed", params: { threadId, turn } },
      {
        current: () =>
          this.session.connected &&
          this.state.nativeId === threadId &&
          this.state.turnId === turn.id &&
          current(),
        replyText,
      },
    );
    await this.#pending;
  }

  async flush(): Promise<void> {
    this.#cancelCheckpoint();
    this.#queue(async () => {
      if (this.#streamDirty) await this.#persist();
    });
    await this.#pending;
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#closed = true;
    await this.flush();
    await this.session.close();
  }

  #reply(reply: ServerRequestReply): void {
    if (!this.session.connected) return;
    try {
      if ("error" in reply)
        this.session.respondError(reply.id, reply.error.code, reply.error.message);
      else this.session.respond(reply.id, reply.result);
    } catch {
      // A closed connection drops its pending requests; the close itself is handled below.
    }
  }

  #enqueue(value: unknown, verified?: { current: () => boolean; replyText?: string }): void {
    if (this.#closed || this.ignore?.(value)) return;
    this.#queue(async () => {
      if (verified && (this.#closed || !verified.current())) return;
      const result = this.state.apply(value);
      if (result.reply) this.#reply(result.reply);
      if (result.changed) {
        const method = isObject(value) ? value.method : null;
        if (
          !result.event &&
          (method === "item/agentMessage/delta" || method === "item/plan/delta")
        ) {
          // Stream text is an ephemeral preview. Publish immediately, but checkpoint at most
          // every 250 ms instead of rewriting the growing record for every token. All durable
          // events, control boundaries, explicit flushes and shutdown still persist immediately.
          this.#streamDirty = true;
          this.#scheduleCheckpoint();
        } else {
          await this.#persist(result.event);
        }
        const observed = verified?.replyText
          ? { ...result, turnReply: verified.replyText }
          : result;
        this.onApplied?.(value, observed, this.state);
      }
    });
  }

  #scheduleCheckpoint(): void {
    if (this.#checkpointTimer) return;
    this.#checkpointTimer = setTimeout(() => {
      this.#checkpointTimer = undefined;
      this.#queue(async () => {
        if (this.#streamDirty) await this.#persist();
      });
    }, 250);
    this.#checkpointTimer.unref?.();
  }

  #cancelCheckpoint(): void {
    if (this.#checkpointTimer) clearTimeout(this.#checkpointTimer);
    this.#checkpointTimer = undefined;
  }

  async #persist(event?: JsonObject): Promise<void> {
    this.#cancelCheckpoint();
    await this.persist(this.state, event);
    this.#streamDirty = false;
  }

  #queue(work: () => Promise<void>): void {
    this.#pending = this.#pending.then(work);
    this.#pending = this.#pending.catch(async () => {
      this.#cancelCheckpoint();
      this.#streamDirty = false;
      this.state.fail("invalid-codex-event");
      try {
        await this.persist(this.state);
      } catch {
        // A stale ledger is never overwritten while recording a failed bridge.
      }
    });
  }
}
