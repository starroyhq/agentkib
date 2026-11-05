import { CodexFollowerConnection } from "./codex-follower-connection";
import { CodexFollowerState } from "./codex-follower-state";

const OWNER_CHECK_INTERVAL_MS = 2_000;
const FULL_REFRESH_INTERVAL_MS = 60_000;
const DRAIN_BUDGET_MS = 50;
const DRAIN_LIMIT = 32;
const SNAPSHOT_TIMEOUT_MS = 3_000;

type JsonRecord = Record<string, unknown>;

/** Session facade over the one-owner desktop bridge and its bounded state reducer. */
export class CodexFollowerBridge {
  #state: CodexFollowerState | null = null;
  #lastOwnerCheck = 0;
  #lastFullRefresh = 0;
  #resyncAfterMutation = false;
  #closed = false;
  #operations: Promise<void> = Promise.resolve();
  #stopObserving?: () => void;
  #drainScheduled = false;
  #drainTimer?: ReturnType<typeof setImmediate>;

  private constructor(
    readonly connection: CodexFollowerConnection,
    private readonly onSnapshot?: (
      snapshot: ReturnType<CodexFollowerState["streamSnapshot"]>,
    ) => void,
  ) {}

  static async connect(
    endpoint: string,
    conversationId: string,
    onSnapshot?: (snapshot: ReturnType<CodexFollowerState["streamSnapshot"]>) => void,
  ): Promise<CodexFollowerBridge> {
    const connection = await CodexFollowerConnection.connectInstalled(endpoint);
    const bridge = new CodexFollowerBridge(connection, onSnapshot);
    try {
      await bridge.select(conversationId);
      bridge.#stopObserving = connection.onReadable(() => bridge.#scheduleDrain());
      return bridge;
    } catch (error) {
      bridge.close();
      throw error;
    }
  }

  get connected(): boolean {
    return !this.#closed && this.connection.connected;
  }

  get selectedState(): CodexFollowerState | null {
    return this.#state;
  }

  get supportsThreadSettings(): boolean {
    return this.connection.supportsThreadSettings;
  }

  async select(conversationId: string): Promise<void> {
    return this.#enqueue(() => this.#select(conversationId));
  }

  async #select(conversationId: string): Promise<void> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId))
      throw new Error("select an explicit Codex conversation UUID");
    const usageRecovery =
      this.#state?.conversationId === conversationId ? this.#state.usageRecovery() : undefined;
    this.#unfollow();
    const response = await this.connection.request("thread-owner-discovery", {
      hostId: "local",
      conversationId,
    });
    const ownerClientId = isRecord(response) ? response.handledByClientId : null;
    if (typeof ownerClientId !== "string" || !ownerClientId)
      throw new Error("no Codex session owner found");
    if (ownerClientId === this.connection.clientId) throw new Error("cannot follow this client");
    const state = new CodexFollowerState(conversationId, ownerClientId, usageRecovery);
    this.#state = state;
    try {
      await this.#followAndAwaitSnapshot(0);
      this.#lastOwnerCheck = Date.now();
      this.#lastFullRefresh = this.#lastOwnerCheck;
      this.#resyncAfterMutation = false;
      this.#publishSnapshot(state);
    } catch (error) {
      if (state.revision !== null) state.invalidate("unsupported");
      throw error;
    }
  }

  async observeLive(): Promise<CodexFollowerState> {
    return this.#enqueue(() => this.#observeLive());
  }

  async #observeLive(): Promise<CodexFollowerState> {
    const state = this.#requireState();
    if (state.revision === null) {
      await this.#select(state.conversationId);
      return this.#requireState();
    }
    if (
      this.#resyncAfterMutation ||
      Date.now() - this.#lastFullRefresh >= FULL_REFRESH_INTERVAL_MS
    ) {
      await this.#refresh();
      return this.#requireState();
    }
    const before = state.snapshotCount;
    try {
      if (Date.now() - this.#lastOwnerCheck >= OWNER_CHECK_INTERVAL_MS) {
        let resubscribe = false;
        const response = await this.connection.request(
          "thread-owner-discovery",
          { hostId: "local", conversationId: state.conversationId },
          undefined,
          (message) => {
            if (isFollowingStatusRequest(message, state)) resubscribe = true;
            else {
              state.notification(message);
              this.#publishSnapshot(state);
            }
          },
        );
        if (!isRecord(response) || response.handledByClientId !== state.ownerClientId)
          throw new Error("Codex session owner changed");
        this.#lastOwnerCheck = Date.now();
        if (resubscribe) {
          await this.#followAndAwaitSnapshot(before);
          this.#lastFullRefresh = Date.now();
          return state;
        }
      }
      const deadline = Date.now() + DRAIN_BUDGET_MS;
      for (let index = 0; index < DRAIN_LIMIT && Date.now() < deadline; index += 1) {
        const message = await this.connection.receive(index === 0 ? 10 : 1);
        if (message === null) break;
        if (await this.#resubscribeIfRequested(message, state)) {
          await this.#awaitSnapshot(state.snapshotCount);
          this.#lastFullRefresh = Date.now();
          break;
        }
        state.notification(message);
        this.#publishSnapshot(state);
      }
      if (state.revision === null) throw new Error("Codex follower state was invalidated");
      if (state.snapshotCount > before) this.#lastFullRefresh = Date.now();
      return state;
    } catch (error) {
      if (state.revision !== null) state.invalidate("unsupported");
      throw error;
    }
  }

  async refresh(): Promise<CodexFollowerState> {
    return this.#enqueue(() => this.#refresh());
  }

  async #refresh(): Promise<CodexFollowerState> {
    const state = this.#requireState();
    if (state.revision === null) {
      await this.#select(state.conversationId);
      return this.#requireState();
    }
    try {
      const response = await this.connection.request(
        "thread-owner-discovery",
        { hostId: "local", conversationId: state.conversationId },
        undefined,
        (message) => {
          if (!isFollowingStatusRequest(message, state)) {
            state.notification(message);
            this.#publishSnapshot(state);
          }
        },
      );
      if (!isRecord(response) || response.handledByClientId !== state.ownerClientId)
        throw new Error("Codex session owner changed");
      await this.#followAndAwaitSnapshot(state.snapshotCount);
      this.#lastOwnerCheck = Date.now();
      this.#lastFullRefresh = this.#lastOwnerCheck;
      this.#resyncAfterMutation = false;
      this.#publishSnapshot(state);
      return state;
    } catch (error) {
      if (state.revision !== null) state.invalidate("unsupported");
      throw error;
    }
  }

  async mutate(
    method: string,
    params: JsonRecord,
    expectedRevision: number,
    onDispatch: () => void,
  ): Promise<unknown> {
    return this.#enqueue(() => this.#mutate(method, params, expectedRevision, onDispatch));
  }

  async #mutate(
    method: string,
    params: JsonRecord,
    expectedRevision: number,
    onDispatch: () => void,
  ): Promise<unknown> {
    const state = await this.#observeLive();
    state.assertMutationAllowed(method, params, expectedRevision);
    let dispatched = false;
    let followingRequested = false;
    try {
      const response = await this.connection.request(
        method,
        params,
        state.ownerClientId,
        (message) => {
          if (isFollowingStatusRequest(message, state)) followingRequested = true;
          else {
            state.notification(message);
            this.#publishSnapshot(state);
          }
        },
        () => {
          state.assertMutationAllowed(method, params, expectedRevision);
          dispatched = true;
          state.markMutationDispatched();
          onDispatch();
        },
      );
      if (!isRecord(response) || response.method !== method || !Object.hasOwn(response, "result"))
        throw new Error("unrecognized owner acknowledgement");
      this.#resyncAfterMutation = true;
      if (followingRequested && this.connection.connected)
        await this.connection.broadcast(
          "thread-stream-following-changed",
          { conversationId: state.conversationId, hostId: "local", following: true },
          state.ownerClientId,
        );
      return response.result;
    } catch (error) {
      if (dispatched) {
        this.#resyncAfterMutation = true;
        state.markMutationDispatched();
      }
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopObserving?.();
    clearImmediate(this.#drainTimer);
    this.#unfollow();
    this.connection.disconnect();
  }

  #scheduleDrain(): void {
    if (this.#closed || this.#drainScheduled) return;
    this.#drainScheduled = true;
    this.#drainTimer = setImmediate(() => {
      this.#drainTimer = undefined;
      // Never run a second socket reader alongside discovery or a mutation ACK.
      // The bounded drain yields between bursts so controls and other sessions
      // retain their place in the same operation queue.
      void this.#enqueue(async () => {
        if (!this.connected) return;
        try {
          await this.#observeLive();
        } catch {
          // A malformed stream cannot leave an unconsumed queue spinning. The
          // normal live read will reconnect and revalidate the native owner.
          this.connection.disconnect();
        }
      }).finally(() => {
        this.#drainScheduled = false;
        if (this.connection.hasPendingMessages) this.#scheduleDrain();
      });
    });
    this.#drainTimer.unref();
  }

  // Requests and notification drains share a single-consumer connection. Keep
  // each whole operation together, including the read before a mutation.
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operations.then(operation);
    this.#operations = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  #requireState(): CodexFollowerState {
    if (!this.connected) throw new Error("Codex IPC disconnected");
    if (!this.#state) throw new Error("no Codex session selected");
    return this.#state;
  }

  #publishSnapshot(state: CodexFollowerState): void {
    if (state.revision === null) return;
    this.onSnapshot?.(state.streamSnapshot());
  }

  async #followAndAwaitSnapshot(baseline: number): Promise<void> {
    const state = this.#requireState();
    await this.connection.broadcast(
      "thread-stream-following-changed",
      { conversationId: state.conversationId, hostId: "local", following: true },
      state.ownerClientId,
    );
    await this.#awaitSnapshot(baseline);
  }

  async #awaitSnapshot(baseline: number): Promise<void> {
    const state = this.#requireState();
    const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const message = await this.connection.receive(deadline - Date.now());
      if (message === null) break;
      if (await this.#resubscribeIfRequested(message, state)) continue;
      state.notification(message);
      this.#publishSnapshot(state);
      if (state.revision !== null && state.snapshotCount > baseline) return;
    }
    throw new Error("no compatible Codex owner snapshot received");
  }

  async #resubscribeIfRequested(value: unknown, state: CodexFollowerState): Promise<boolean> {
    if (!isFollowingStatusRequest(value, state)) return false;
    await this.connection.broadcast(
      "thread-stream-following-changed",
      { conversationId: state.conversationId, hostId: "local", following: true },
      state.ownerClientId,
    );
    return true;
  }

  #unfollow(): void {
    this.#lastOwnerCheck = 0;
    this.#lastFullRefresh = 0;
    this.#resyncAfterMutation = false;
    const state = this.#state;
    this.#state = null;
    if (state && this.connection.connected)
      void this.connection.broadcast(
        "thread-stream-following-changed",
        { conversationId: state.conversationId, hostId: "local", following: false },
        state.ownerClientId,
      );
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFollowingStatusRequest(value: unknown, state: CodexFollowerState): boolean {
  return (
    isRecord(value) &&
    value.type === "broadcast" &&
    value.method === "thread-stream-following-status-requested" &&
    value.version === 1 &&
    value.sourceClientId === state.ownerClientId &&
    isRecord(value.params) &&
    value.params.conversationId === state.conversationId &&
    value.params.hostId === "local"
  );
}
