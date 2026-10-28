import type { CodexAppServerSession } from "./codex-app-server";
import { isDeepStrictEqual } from "node:util";
import { createContextUsageGeneration, projectContextUsage } from "./context-usage";
import { codexItemTool, type ToolContext } from "./conversation-tools";
import { codexErrorText, codexTurnErrorEvent } from "./codex-turn-error";

type JsonObject = Record<string, unknown>;
type ManagedRecord = JsonObject & {
  id: string;
  workspace_id: string;
  workspace: string;
  native_id?: string | null;
  snapshot?: JsonObject;
  token_usage?: unknown;
  goal?: unknown;
  native_settings?: unknown;
};

const MAX_STREAM_BYTES = 128 * 1024;
const MAX_ITEMS = 1024;
const MAX_PENDING = 32;

/** The JSON-RPC reply to a server request, sent by the event bridge. */
export type ServerRequestReply =
  | { id: unknown; result: unknown }
  | { id: unknown; error: { code: number; message: string } };

/**
 * The CLI's latest retry of a failed model request in the running turn, for display only. Same
 * shape as Claude's report; `detail` is the CLI's own text about what failed.
 */
export type CodexApiRetry = {
  attempt: number;
  maxRetries: number | null;
  status: number | null;
  error: string | null;
  detail: string | null;
};

/** Mutable projection of one AgentKib-owned app-server thread. */
export class ManagedCodexState {
  #record: ManagedRecord;
  #revision = 0;
  #mutationRevision = 0;
  #goalRevision = 0;
  #status = "starting";
  #turn: string | null = null;
  #stream = "";
  #approvals = new Map<string, JsonObject>();
  #questions = new Map<string, JsonObject>();
  #pendingTurns = new Map<string, string>();
  #resolved = new Set<string>();
  #items = new Map<string, JsonObject>();
  #reason: string | null = null;
  #runtimeRevision = 0;
  #compactions = new Map<string, string>();
  #finishedCompactions = new Set<string>();
  #closedTurns = new Set<string>();
  #lastTurn: string | null = null;
  /** Last item projected in the running turn; turn/completed adds the turn duration to it. */
  #lastTurnEvent: JsonObject | null = null;
  readonly #usageGeneration = createContextUsageGeneration();
  #usageReport = 0;
  #usageUpdatedAt: string | undefined;
  #usageState: "ready" | "pending" | "stale" = "pending";
  #usageBarrierTurn: string | null | undefined;
  #compactionRecoveryTurn: string | null | undefined;
  #retry: CodexApiRetry | null = null;
  /** The final `error` of the running turn, for a completion that carries none itself. */
  #turnError: { turnId: string; text: string } | null = null;

  constructor(record: ManagedRecord, initialRevision = 0) {
    this.#record = structuredClone(record);
    this.#revision =
      Number.isSafeInteger(initialRevision) && initialRevision >= 0 ? initialRevision : 0;
    this.#mutationRevision = this.#revision;
    if (isObject(record.token_usage)) this.#usageState = "stale";
    if (record.snapshot?.activity === "compacting") {
      this.#usageBarrierTurn =
        typeof record.snapshot.turnId === "string" ? record.snapshot.turnId : null;
      this.#compactionRecoveryTurn = this.#usageBarrierTurn;
    }
  }

  get revision(): number {
    return this.#revision;
  }

  /** Observation-only usage updates do not advance this resume-local CAS guard. */
  get mutationRevision(): number {
    return this.#mutationRevision;
  }

  get goalRevision(): number {
    return this.#goalRevision;
  }

  get nativeId(): string | null {
    return typeof this.#record.native_id === "string" ? this.#record.native_id : null;
  }

  get status(): string {
    return this.#status;
  }

  get turnId(): string | null {
    return this.#turn;
  }

  get reason(): string | null {
    return this.#reason;
  }

  get activity(): "compacting" | null {
    return this.#compactions.size > 0 ? "compacting" : null;
  }

  hasResolvedRequest(turnId: string, requestId: unknown): boolean {
    return this.#resolved.has(`${turnId}:${requestKey(requestId)}`);
  }

  get record(): Readonly<ManagedRecord> {
    return this.#record;
  }

  #toolContext(): ToolContext {
    return {
      workspace: typeof this.#record.workspace === "string" ? this.#record.workspace : null,
    };
  }

  snapshot(runtimeBootId: string, controls: boolean): JsonObject {
    const healthy = this.#reason === null;
    return {
      sessionId: this.#record.id,
      workspaceId: this.#record.workspace_id,
      runtimeBootId,
      executionMode: "codex-managed",
      executionLocation: "agentkib",
      ownershipReason: null,
      status: this.#status,
      activity: this.activity,
      revision: this.#revision,
      turnId: this.#turn,
      sendEnabled: controls && healthy && this.#status === "idle" && this.activity === null,
      stopEnabled:
        controls &&
        healthy &&
        this.#turn !== null &&
        ["running", "awaiting-approval", "waiting-input"].includes(this.#status),
      approvals: [...this.#approvals.values()].map((approval) =>
        controls ? structuredClone(approval) : { ...approval, supported: false },
      ),
      questions: [...this.#questions.values()].map((question) =>
        controls ? structuredClone(question) : { ...question, supported: false },
      ),
      streamText: this.#stream,
      settings: managedSettingsProjection(this.#record),
      tokenUsage: this.#record.token_usage ?? null,
      usage: projectContextUsage(
        {
          available: true,
          tokenUsage: this.#record.token_usage,
          state: this.activity ? "pending" : this.#usageState,
          reportGeneration: this.#usageGeneration,
          reportId: this.#usageReport,
          updatedAt: this.#usageUpdatedAt,
          reason: this.activity
            ? "session-compacting"
            : this.#usageState === "stale"
              ? "context-usage-unconfirmed"
              : undefined,
        },
        this.#revision,
      ),
      goal: this.#record.goal ?? null,
      apiRetry: this.#retry && this.#turn !== null ? { ...this.#retry } : null,
      reason: this.#reason,
    };
  }

  /**
   * Apply one app-server notification or request; return the ledger event to persist, and the
   * reply a request gets at once when AgentKib does not show it to the user.
   */
  apply(value: unknown): { changed: boolean; event?: JsonObject; reply?: ServerRequestReply } {
    if (!isObject(value)) throw new Error("invalid-codex-notification");
    const method = typeof value.method === "string" ? value.method : "";
    const params = isObject(value.params) ? value.params : {};
    let runtimeChanged = false;
    if (method === "agentkib/disconnected") {
      if (this.#record.released !== true) {
        this.fail("codex-disconnected");
        return this.#changed();
      }
      return { changed: false };
    }
    if (this.nativeId && typeof params.threadId === "string" && params.threadId !== this.nativeId)
      return { changed: false };

    switch (method) {
      case "thread/started": {
        const thread = isObject(params.thread) ? params.thread : {};
        const id = requiredString(thread.id, "invalid-thread");
        if (this.nativeId) return { changed: false };
        this.#record.native_id = id;
        break;
      }
      case "turn/started": {
        const turn = isObject(params.turn) ? params.turn : {};
        if (typeof turn.id === "string" && this.#closedTurns.has(turn.id))
          return { changed: false };
        this.#turn = requiredString(turn.id, "invalid-turn");
        this.#lastTurn = this.#turn;
        for (const [key, id] of this.#compactions)
          if (id !== this.#turn) this.#compactions.delete(key);
        runtimeChanged = true;
        this.#status = "running";
        this.#stream = "";
        this.#reason = null;
        this.#lastTurnEvent = null;
        this.#retry = null;
        this.#turnError = null;
        break;
      }
      case "turn/completed": {
        if (!isObject(params.turn) || typeof params.turn.id !== "string") return { changed: false };
        const id = params.turn.id;
        if (id !== this.#turn && ![...this.#compactions.values()].includes(id))
          return { changed: false };
        this.#lastTurn = id;
        this.#remember(this.#closedTurns, id);
        for (const [key, turnId] of this.#compactions)
          if (turnId === id) this.#compactions.delete(key);
        runtimeChanged = true;
        this.#turn = null;
        this.#status = "idle";
        this.#approvals.clear();
        this.#questions.clear();
        this.#items.clear();
        this.#retry = null;
        const reported = this.#turnError?.turnId === id ? this.#turnError.text : null;
        this.#turnError = null;
        // The native turn reports its duration; history readers attach the same
        // value to the turn's last item, so the live row carries it too.
        const meta = turnMeta(params.turn);
        const last = this.#lastTurnEvent;
        this.#lastTurnEvent = null;
        // A failed turn ends with the CLI's own error text, which the rollout keeps as well.
        const failure = turnErrorEvent(params.turn, reported);
        if (failure)
          return {
            ...this.#changed(runtimeChanged),
            event: meta ? { ...failure, turn_meta: meta } : failure,
          };
        if (meta && last?.turn_id === id)
          return { ...this.#changed(runtimeChanged), event: { ...last, turn_meta: meta } };
        break;
      }
      case "error": {
        // The CLI reports each retry of a failed model request, then the final error before the
        // turn completes (0.163.0). Retries are shown while the turn runs; neither is a control
        // change.
        if (this.#turn === null || params.turnId !== this.#turn || !isObject(params.error))
          return { changed: false };
        if (params.willRetry === true) {
          this.#retry = codexRetry(params.error, this.#retry);
          return this.#changed(false, true);
        }
        const text = codexErrorText(params.error);
        if (text) this.#turnError = { turnId: this.#turn, text };
        if (this.#retry === null) return { changed: false };
        this.#retry = null;
        return this.#changed(false, true);
      }
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        if (params.turnId !== this.#turn || typeof params.delta !== "string")
          return { changed: false };
        // Streamed output means the request a retry was waiting for got through.
        this.#retry = null;
        if (Buffer.byteLength(this.#stream + params.delta, "utf8") <= MAX_STREAM_BYTES)
          this.#stream += params.delta;
        break;
      }
      case "item/started":
      case "item/completed": {
        if (isObject(params.item) && params.item.type === "contextCompaction") {
          if (
            typeof params.turnId !== "string" ||
            !params.turnId ||
            this.#closedTurns.has(params.turnId) ||
            (this.#turn !== null && params.turnId !== this.#turn)
          )
            return { changed: false };
          const id = requiredString(params.item.id, "invalid-item");
          const key = `${params.turnId}:${id}`;
          if (
            this.#compactionRecoveryTurn !== undefined &&
            (this.#compactionRecoveryTurn === null ||
              this.#compactionRecoveryTurn === params.turnId)
          ) {
            this.#compactionRecoveryTurn = undefined;
            if (this.#reason === "compaction-state-unconfirmed") {
              this.#reason = null;
              this.#status = this.#turn === null ? "idle" : "running";
            }
          }
          if (method === "item/started") {
            if (this.#finishedCompactions.has(key) || this.#compactions.has(key))
              return { changed: false };
            if (this.#compactions.size >= MAX_ITEMS) throw new Error("too-many-items");
            this.#compactions.set(key, params.turnId);
            this.#usageBarrierTurn = params.turnId;
            this.#usageState = "stale";
          } else {
            if (
              !this.#compactions.has(key) &&
              this.#lastTurn !== null &&
              this.#lastTurn !== params.turnId
            )
              return { changed: false };
            this.#compactions.delete(key);
            this.#remember(this.#finishedCompactions, key);
            this.#usageBarrierTurn = params.turnId;
            this.#usageState = "stale";
          }
          runtimeChanged = true;
          break;
        }
        if (this.#turn === null || params.turnId !== this.#turn || !isObject(params.item))
          return { changed: false };
        const id = requiredString(params.item.id, "invalid-item");
        if (this.#items.size >= MAX_ITEMS && !this.#items.has(id))
          throw new Error("too-many-items");
        // Only the user's own message precedes the model's first reply.
        if (params.item.type !== "userMessage") this.#retry = null;
        this.#items.set(id, structuredClone(params.item));
        if (method === "item/completed") {
          const event = projectItem(params.item, this.#turn, this.#toolContext());
          if (event) this.#lastTurnEvent = event;
          this.#mutationRevision = ++this.#revision;
          return { changed: true, ...(event ? { event } : {}) };
        }
        break;
      }
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval": {
        if (this.#turn === null || params.turnId !== this.#turn) return { changed: false };
        if (this.#approvals.size >= MAX_PENDING) throw new Error("too-many-approvals");
        const requestId = requiredRequestId(value.id);
        const turnId = this.#turn;
        this.#pendingTurns.set(requestId, turnId);
        const details = { ...params };
        if (method === "item/fileChange/requestApproval" && typeof params.itemId === "string") {
          const item = this.#items.get(params.itemId);
          if (item && "changes" in item) details.changes = item.changes;
        }
        this.#approvals.set(requestId, projectApproval(value.id, turnId, method, details));
        this.#status = "awaiting-approval";
        runtimeChanged = true;
        break;
      }
      case "mcpServer/elicitation/request": {
        const requestId = requiredRequestId(value.id);
        // The request may name no turn; one that cannot be shown with the running turn is
        // declined at once, which lets the MCP call, and the turn, go on.
        const turnId = this.#turn;
        if (
          turnId === null ||
          (params.turnId != null && params.turnId !== turnId) ||
          this.#approvals.size >= MAX_PENDING
        )
          return { changed: false, reply: { id: value.id, result: { action: "decline" } } };
        this.#pendingTurns.set(requestId, turnId);
        this.#approvals.set(requestId, projectElicitation(value.id, turnId, params));
        this.#status = "awaiting-approval";
        runtimeChanged = true;
        break;
      }
      case "item/tool/requestUserInput": {
        if (this.#turn === null || params.turnId !== this.#turn) return { changed: false };
        if (this.#questions.size >= MAX_PENDING) throw new Error("too-many-questions");
        const requestId = requiredRequestId(value.id);
        const turnId = this.#turn;
        this.#pendingTurns.set(requestId, turnId);
        const projection = projectNativeQuestions(params);
        this.#questions.set(requestId, {
          requestId: value.id,
          turnId,
          method,
          supported: projection.supported,
          questions: projection.questions,
        });
        this.#status = "waiting-input";
        runtimeChanged = true;
        break;
      }
      case "serverRequest/resolved": {
        const requestId = requestKey(params.requestId);
        if (this.#resolved.size >= 256) this.#resolved.clear();
        const turn = this.#pendingTurns.get(requestId);
        if (turn) this.#resolved.add(`${turn}:${requestId}`);
        this.#pendingTurns.delete(requestId);
        this.#approvals.delete(requestId);
        this.#questions.delete(requestId);
        if (this.#approvals.size === 0 && this.#questions.size === 0 && this.#turn)
          this.#status = "running";
        runtimeChanged = true;
        break;
      }
      case "thread/status/changed":
        // `systemError` marks a thread whose last turn ended on an error, until the next turn
        // starts (0.163.0 thread_status.rs). That turn's completion carries the error and the
        // thread stays usable, so the status itself changes nothing here.
        return { changed: false };
      case "thread/settings/updated": {
        if (!isObject(params.threadSettings)) throw new Error("invalid-thread-settings");
        if (isDeepStrictEqual(this.#record.native_settings, params.threadSettings))
          return { changed: false };
        const previousModel = currentManagedModel(this.#record);
        const applyingSelection =
          managedModelPending(this.#record) && params.threadSettings.model === this.#record.model;
        this.#record.native_settings = structuredClone(params.threadSettings);
        if (currentManagedModel(this.#record) !== previousModel)
          this.#invalidateUsage(applyingSelection);
        break;
      }
      case "thread/tokenUsage/updated": {
        if (!isObject(params.tokenUsage)) throw new Error("invalid-token-usage");
        const turnId = typeof params.turnId === "string" ? params.turnId : null;
        if (turnId !== null && this.#lastTurn !== null && turnId !== this.#lastTurn)
          return { changed: false };
        this.#record.token_usage = structuredClone(params.tokenUsage);
        this.#usageReport += 1;
        this.#usageUpdatedAt = new Date().toISOString();
        const associated = turnId !== null && turnId === this.#lastTurn;
        if (
          associated &&
          this.activity === null &&
          (this.#usageBarrierTurn === undefined || turnId !== this.#usageBarrierTurn) &&
          !managedModelPending(this.#record)
        ) {
          this.#usageBarrierTurn = undefined;
          this.#usageState = "ready";
        } else this.#usageState = "stale";
        return this.#changed(false, true);
      }
      case "thread/goal/updated":
        if (!isObject(params.goal)) throw new Error("invalid-goal");
        this.#record.goal = structuredClone(params.goal);
        this.#goalRevision += 1;
        break;
      case "thread/goal/cleared":
        if (this.#record.goal == null) return { changed: false };
        this.#record.goal = null;
        this.#goalRevision += 1;
        break;
      default:
        // A request AgentKib has no answer for gets an error at once, so the turn goes on instead
        // of waiting for a reply that never comes (0.163.0: item/tool/call, attestation/generate,
        // account/chatgptAuthTokens/refresh, currentTime/read and the v1 approvals).
        if ("id" in value)
          return {
            changed: false,
            reply: {
              id: value.id,
              error: {
                code: -32601,
                message: `AgentKib does not handle ${[...(method || "this request")].slice(0, 128).join("")}`,
              },
            },
          };
        return { changed: false };
    }
    return this.#changed(runtimeChanged);
  }

  hydrate(
    thread: unknown,
    incrementRevision = true,
    readRevision?: number,
  ): { snapshot: JsonObject; events: JsonObject[] } {
    if (!isObject(thread) || typeof thread.id !== "string") throw new Error("invalid-thread");
    if (this.nativeId && this.nativeId !== thread.id) throw new Error("thread-identity-mismatch");
    const events: JsonObject[] = [];
    let active: string | null = null;
    let latest: JsonObject | undefined;
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      if (!isObject(turn)) continue;
      latest = turn;
      if (turn.status === "inProgress") {
        active = typeof turn.id === "string" ? turn.id : null;
      }
      const first = events.length;
      for (const item of Array.isArray(turn.items) ? turn.items : []) {
        if (!isObject(item) || typeof turn.id !== "string") continue;
        const event = projectItem(item, turn.id, this.#toolContext());
        if (event) events.push(event);
      }
      const failure = turnErrorEvent(turn, null);
      if (failure) events.push(failure);
      const meta = turnMeta(turn);
      if (meta && events.length > first) events[events.length - 1]!.turn_meta = meta;
    }
    // History reads can finish after newer lifecycle notifications were applied.
    // Those events, including compaction, own the current live state.
    if (readRevision !== undefined && this.#runtimeRevision > readRevision)
      return { snapshot: this.snapshot("", false), events };
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      if (
        isObject(turn) &&
        typeof turn.id === "string" &&
        ["completed", "failed", "interrupted"].includes(String(turn.status))
      )
        this.#remember(this.#closedTurns, turn.id);
    }
    this.#record.native_id = thread.id;
    this.#turn = active;
    this.#lastTurn = active ?? (typeof latest?.id === "string" ? latest.id : this.#lastTurn);
    this.#status = active === null ? "idle" : "running";
    this.#reason = null;
    this.#approvals.clear();
    this.#questions.clear();
    this.#items.clear();
    this.#retry = null;
    if (this.#turnError?.turnId !== active) this.#turnError = null;
    // An attached running turn can still end with a duration; keep its last row.
    this.#lastTurnEvent =
      active === null
        ? null
        : ([...events].reverse().find((event) => event.turn_id === active) ?? null);
    if (this.#compactionRecoveryTurn !== undefined) {
      if (
        active !== null &&
        (this.#compactionRecoveryTurn === null || active === this.#compactionRecoveryTurn)
      ) {
        this.#status = "outcome-unknown";
        this.#reason = "compaction-state-unconfirmed";
      } else this.#compactionRecoveryTurn = undefined;
    }
    if (readRevision !== undefined || this.#compactions.size === 0) {
      for (const [key, id] of this.#compactions) if (id !== active) this.#compactions.delete(key);
    }
    if (
      this.#usageReport === 0 &&
      latest &&
      Array.isArray(latest.items) &&
      latest.items.some((item) => isObject(item) && item.type === "contextCompaction")
    ) {
      this.#usageBarrierTurn = typeof latest.id === "string" ? latest.id : null;
      this.#usageState = "stale";
    }
    if (isObject(thread.status) && thread.status.type === "active" && this.#turn === null)
      this.fail("unconfirmed-active-turn");
    if (incrementRevision) this.#runtimeRevision = this.#mutationRevision = ++this.#revision;
    return { snapshot: this.snapshot("", false), events };
  }

  fail(reason: string): void {
    this.#status = "outcome-unknown";
    this.#reason = reason;
    this.#record.native_settings = null;
    this.#compactions.clear();
    this.#retry = null;
    this.#usageState = "stale";
    this.#runtimeRevision = this.#mutationRevision = ++this.#revision;
  }

  restoreReconciledTurn(): boolean {
    if (this.#turn === null || this.#reason !== "control-outcome-unconfirmed") return false;
    this.#reason = null;
    this.#status =
      this.#questions.size > 0
        ? "waiting-input"
        : this.#approvals.size > 0
          ? "awaiting-approval"
          : "running";
    this.#runtimeRevision = this.#mutationRevision = ++this.#revision;
    return true;
  }

  acceptStartedTurn(turnId: string, expectedRevision: number): void {
    if (
      this.#revision !== expectedRevision ||
      this.#turn !== null ||
      this.#status !== "idle" ||
      this.activity !== null
    )
      throw new Error("stale-or-disabled-control");
    this.#turn = turnId;
    this.#lastTurn = turnId;
    this.#status = "running";
    this.#reason = null;
    this.#runtimeRevision = this.#mutationRevision = ++this.#revision;
  }

  commitManagedMutation(
    update: Partial<
      Pick<
        ManagedRecord,
        "model" | "effort" | "service_tier" | "policy_id" | "mode" | "title" | "goal" | "archived"
      >
    >,
    status?: string,
  ): void {
    const previousModel = this.#record.model ?? null;
    Object.assign(this.#record, update);
    if (Object.hasOwn(update, "model") && (this.#record.model ?? null) !== previousModel)
      this.#invalidateUsage();
    if (status) this.#status = status;
    this.#mutationRevision = ++this.#revision;
    if (status) this.#runtimeRevision = this.#revision;
  }

  #invalidateUsage(preserveBarrier = false): void {
    this.#usageState = "stale";
    if (!preserveBarrier || this.#usageBarrierTurn === undefined)
      this.#usageBarrierTurn = this.#lastTurn;
  }

  #remember(set: Set<string>, key: string): void {
    if (set.size >= MAX_ITEMS) set.delete(set.values().next().value!);
    set.add(key);
  }

  #changed(runtimeChanged = false, observationOnly = false): { changed: true } {
    this.#revision += 1;
    if (!observationOnly) this.#mutationRevision = this.#revision;
    if (runtimeChanged) this.#runtimeRevision = this.#revision;
    return { changed: true };
  }
}

export class ManagedCodexEventBridge {
  #pending: Promise<void> = Promise.resolve();
  #closed = false;
  #closing?: Promise<void>;

  constructor(
    readonly session: CodexAppServerSession,
    readonly state: ManagedCodexState,
    readonly persist: (state: ManagedCodexState, event?: JsonObject) => Promise<void> | void,
    readonly onApplied?: (
      value: unknown,
      result: { changed: boolean; event?: JsonObject },
      state: ManagedCodexState,
    ) => void,
  ) {
    session.on("notification", (value: unknown) => this.#enqueue(value));
    session.on("serverRequest", (value: unknown) => this.#enqueue(value));
    session.on("close", () => this.#enqueue({ method: "agentkib/disconnected", params: {} }));
  }

  async snapshot(runtimeBootId: string, controls: boolean): Promise<JsonObject> {
    await this.#pending;
    return this.state.snapshot(runtimeBootId, controls && this.session.connected);
  }

  async flush(): Promise<void> {
    await this.#pending;
  }

  close(): Promise<void> {
    return (this.#closing ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#closed = true;
    await this.#pending;
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

  #enqueue(value: unknown): void {
    if (this.#closed) return;
    this.#pending = this.#pending.then(async () => {
      const result = this.state.apply(value);
      if (result.reply) this.#reply(result.reply);
      if (result.changed) {
        await this.persist(this.state, result.event);
        this.onApplied?.(value, result, this.state);
      }
    });
    this.#pending = this.#pending.catch(async () => {
      this.state.fail("invalid-codex-event");
      try {
        await this.persist(this.state);
      } catch {
        // A stale ledger is never overwritten while recording a failed bridge.
      }
    });
  }
}

function currentManagedModel(record: ManagedRecord): string | null {
  const native = isObject(record.native_settings) ? record.native_settings : null;
  return typeof native?.model === "string" ? native.model : null;
}

function managedModelPending(record: ManagedRecord): boolean {
  const selected = record.model;
  const current = currentManagedModel(record);
  return typeof selected === "string" && current !== null && selected !== current;
}

function managedSettingsProjection(record: ManagedRecord): JsonObject {
  const selected = {
    model: record.model ?? null,
    effort: record.effort ?? null,
    mode: record.mode ?? null,
    serviceTier: record.service_tier ?? null,
    policyId: record.policy_id ?? "workspace-write-on-request",
  };
  const native = isObject(record.native_settings) ? record.native_settings : null;
  const current = native
    ? {
        model: native.model ?? null,
        effort: native.effort ?? null,
        mode: isObject(native.collaborationMode) ? (native.collaborationMode.mode ?? null) : null,
        serviceTier: normalizeServiceTier(native.serviceTier),
        policyId: policyIdFromSettings(native, record.workspace),
      }
    : { model: null, effort: null, mode: null, serviceTier: null, policyId: null };
  const confirmed =
    native !== null &&
    ["model", "effort", "serviceTier", "policyId"].every(
      (key) => current[key as keyof typeof current] === selected[key as keyof typeof selected],
    ) &&
    (record.mode == null || current.mode === selected.mode);
  return {
    current,
    selected,
    applicationStatus: !native ? "unknown" : confirmed ? "confirmed" : "pending",
    defaults: {
      model: record.default_model ?? null,
      effort: record.default_effort ?? null,
      serviceTier: record.default_service_tier ?? null,
    },
  };
}

function normalizeServiceTier(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value !== "default" ? value : null;
}

function policyIdFromSettings(settings: JsonObject, workspace: string): string | null {
  for (const policy of [
    ["workspace-write-on-request", "on-request", "user", "workspaceWrite"],
    ["full-access-on-request", "never", "user", "dangerFullAccess"],
    ["workspace-write-auto-review", "on-request", "auto_review", "workspaceWrite"],
  ]) {
    const [id, approval, reviewer, sandbox] = policy;
    const sandboxPolicy = isObject(settings.sandboxPolicy) ? settings.sandboxPolicy : {};
    if (
      settings.approvalPolicy === approval &&
      settings.approvalsReviewer === reviewer &&
      sandboxPolicy.type === sandbox &&
      (sandbox === "dangerFullAccess" ||
        (sandboxPolicy.networkAccess === false &&
          Array.isArray(sandboxPolicy.writableRoots) &&
          sandboxPolicy.writableRoots.every((root) => root === workspace)))
    )
      return id;
  }
  return null;
}

function projectItem(
  item: JsonObject,
  turnId: string,
  context: ToolContext = {},
): JsonObject | undefined {
  const id = typeof item.id === "string" ? item.id : null;
  if (!id) throw new Error("invalid-item");
  let kind: string;
  let content = "";
  switch (item.type) {
    case "agentMessage":
    case "plan":
      kind = "agent-message";
      content = typeof item.text === "string" ? item.text : "";
      break;
    case "userMessage":
      kind = "user-message";
      content = Array.isArray(item.content)
        ? item.content
            .filter(isObject)
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("\n")
        : "";
      break;
    default: {
      // Same normalizer as rollout history, so the history that replaces this
      // turn's live rows shows them the same way.
      const tool = codexItemTool(item, context);
      if (!tool) return;
      return {
        id,
        kind: "tool-summary",
        turn_id: turnId,
        timestamp: new Date().toISOString(),
        content: "",
        tool_name: tool.name,
        tool_status: tool.status,
        duration_ms: tool.durationMs,
        attachment_count: 0,
        truncated: false,
        tool: tool.detail,
      };
    }
  }
  const truncated = Buffer.byteLength(content, "utf8") > 128 * 1024;
  const boundedContent = [...content].slice(0, 32768).join("");
  // app-server agent messages carry the same phase as rollout messages; without it
  // a connected session groups commentary and tools differently from its history.
  const phase =
    item.type === "agentMessage" && (item.phase === "commentary" || item.phase === "final_answer")
      ? item.phase
      : undefined;
  return {
    id,
    kind,
    turn_id: turnId,
    ...(phase ? { message_phase: phase } : {}),
    timestamp: new Date().toISOString(),
    content: boundedContent,
    tool_name: null,
    tool_status: null,
    attachment_count: 0,
    truncated,
  };
}

function projectApproval(
  requestId: unknown,
  turnId: string,
  method: string,
  details: JsonObject,
): JsonObject {
  const command = method === "item/commandExecution/requestApproval";
  const permissions = method === "item/permissions/requestApproval";
  const complete = command
    ? typeof details.command === "string" &&
      details.command.trim() !== "" &&
      details.command.length <= 16 * 1024 &&
      !details.command.includes("\0") &&
      absolutePath(details.cwd)
    : permissions
      ? bounded(details.cwd, 4096) && validPermissionProfile(details.permissions)
      : method === "item/fileChange/requestApproval" &&
        Array.isArray(details.changes) &&
        details.changes.length > 0 &&
        details.changes.length <= 100 &&
        details.changes.every(completeFileChange);
  const allowedKeys = new Set([
    "threadId",
    "turnId",
    "itemId",
    "cwd",
    "reason",
    ...(command
      ? [
          "approvalId",
          "command",
          "commandActions",
          "availableDecisions",
          "kind",
          "startedAtMs",
          "environmentId",
          "proposedExecpolicyAmendment",
          "proposedNetworkPolicyAmendments",
          "networkApprovalContext",
          "additionalPermissions",
        ]
      : method === "item/fileChange/requestApproval"
        ? ["changes", "grantRoot", "availableDecisions"]
        : permissions
          ? ["permissions"]
          : []),
  ]);
  const unknownMetadata = Object.entries(details)
    .filter(([key, value]) => value !== null && !allowedKeys.has(key))
    .slice(0, 32)
    .map(([key, value]) => ({
      field: [...key].slice(0, 80).join(""),
      type: valueType(value),
    }));
  const validMetadata =
    !command ||
    ((details.kind == null || details.kind === "command") &&
      (details.startedAtMs == null ||
        (Number.isSafeInteger(details.startedAtMs) && Number(details.startedAtMs) >= 0)) &&
      (details.environmentId == null || details.environmentId === "local") &&
      (details.additionalPermissions == null ||
        validPermissionProfile(details.additionalPermissions)) &&
      (details.networkApprovalContext == null ||
        (isObject(details.networkApprovalContext) &&
          Object.keys(details.networkApprovalContext).every((key) =>
            ["host", "protocol"].includes(key),
          ) &&
          bounded(details.networkApprovalContext.host, 1024) &&
          ["http", "https", "tcp", "udp"].includes(
            String(details.networkApprovalContext.protocol),
          ))) &&
      (details.proposedExecpolicyAmendment == null ||
        (Array.isArray(details.proposedExecpolicyAmendment) &&
          details.proposedExecpolicyAmendment.length > 0 &&
          details.proposedExecpolicyAmendment.length <= 100 &&
          details.proposedExecpolicyAmendment.every(
            (value) => typeof value === "string" && value.length > 0 && value.length <= 4096,
          ))) &&
      (details.proposedNetworkPolicyAmendments == null ||
        (Array.isArray(details.proposedNetworkPolicyAmendments) &&
          details.proposedNetworkPolicyAmendments.length <= 100 &&
          details.proposedNetworkPolicyAmendments.every(validNetworkRule))));
  const validDecisions =
    details.availableDecisions == null || Array.isArray(details.availableDecisions);
  const offered = Array.isArray(details.availableDecisions)
    ? details.availableDecisions
    : ["accept", "decline", "cancel"];
  const decisions = offered.filter((value) =>
    ["accept", "decline", "cancel"].includes(String(value)),
  );
  const basicSupported =
    ((typeof requestId === "string" && requestId.length > 0 && requestId.length <= 256) ||
      (typeof requestId === "number" && Number.isSafeInteger(requestId))) &&
    turnId !== "" &&
    (typeof details.turnId !== "string" || details.turnId === turnId) &&
    validMetadata &&
    validDecisions &&
    complete &&
    !permissions &&
    unknownMetadata.length === 0 &&
    [
      "additionalPermissions",
      "networkApprovalContext",
      "proposedNetworkPolicyAmendments",
      "grantRoot",
    ].every((key) => details[key] == null) &&
    decisions.length > 0;
  const decisionOptions = nativeApprovalOptions(method, details);
  const extendedSupported =
    ((typeof requestId === "string" && requestId.length > 0 && requestId.length <= 256) ||
      (typeof requestId === "number" && Number.isSafeInteger(requestId))) &&
    turnId !== "" &&
    (typeof details.turnId !== "string" || details.turnId === turnId) &&
    validMetadata &&
    validDecisions &&
    complete &&
    unknownMetadata.length === 0 &&
    decisionOptions.length > 0;
  const supported = basicSupported || extendedSupported;
  return {
    requestId,
    turnId,
    method,
    command: details.command ?? null,
    cwd: details.cwd ?? null,
    changes: details.changes ?? null,
    availableDecisions: basicSupported ? decisions : [],
    ...(extendedSupported ? { decisionOptions } : {}),
    ...(extendedSupported
      ? {
          requiresExtendedApproval: !basicSupported,
          requestContext: {
            reason: details.reason ?? null,
            cwd: details.cwd ?? null,
            networkApprovalContext: details.networkApprovalContext ?? null,
            additionalPermissions: details.additionalPermissions ?? null,
            permissions: details.permissions ?? null,
            grantRoot: details.grantRoot ?? null,
            proposedExecpolicyAmendment: details.proposedExecpolicyAmendment ?? null,
            proposedNetworkPolicyAmendments: details.proposedNetworkPolicyAmendments ?? null,
          },
        }
      : {}),
    supported,
    unsupportedReason: supported
      ? null
      : !complete
        ? "incomplete-operation-details"
        : unknownMetadata.length > 0
          ? "unsupported-metadata"
          : "unsupported-approval-contract",
    unsupportedMetadata: unknownMetadata,
    proposedExecpolicyAmendment:
      command && validMetadata ? (details.proposedExecpolicyAmendment ?? null) : null,
    environmentId: command && validMetadata ? (details.environmentId ?? null) : null,
  };
}

/**
 * An MCP request for the user (`mcpServer/elicitation/request`), as an approval. Codex 0.163.0
 * asks this way before a non-read-only MCP tool runs: `_meta.codex_approval_kind` is
 * `mcp_tool_call` and the form is empty. MCP servers ask for their own input the same way. An
 * empty form is a confirmation that can be accepted; a form with fields, a link or another mode
 * can only be declined here, which lets the MCP call and the turn go on.
 */
function projectElicitation(requestId: unknown, turnId: string, params: JsonObject): JsonObject {
  const meta = isObject(params._meta) ? params._meta : {};
  const schema = isObject(params.requestedSchema) ? params.requestedSchema : null;
  const fields = schema && isObject(schema.properties) ? Object.entries(schema.properties) : null;
  const confirmation = params.mode === "form" && fields !== null && fields.length === 0;
  const toolApproval = confirmation && meta.codex_approval_kind === "mcp_tool_call";
  const kind = toolApproval
    ? "tool-approval"
    : confirmation
      ? "confirmation"
      : params.mode === "form"
        ? "form"
        : params.mode === "url"
          ? "url"
          : "other";
  const server = boundedText(params.serverName, 256) ?? "MCP";
  const tool = toolApproval ? boundedText(meta.tool_title, 256) : null;
  const toolParams =
    toolApproval && meta.tool_params !== undefined && jsonSize(meta.tool_params) <= 16 * 1024
      ? meta.tool_params
      : undefined;
  const accept = { action: "accept", content: {} };
  // Cancel aborts the turn for a tool approval; for a server's own request it only dismisses
  // it, which the user can do by declining.
  const availableDecisions = confirmation
    ? toolApproval
      ? ["accept", "decline", "cancel"]
      : ["accept", "decline"]
    : ["decline"];
  const persist = Array.isArray(meta.persist) ? meta.persist : [];
  return {
    requestId,
    turnId,
    method: "mcpServer/elicitation/request",
    toolName: tool ? `${server} · ${tool}` : server,
    input: {
      kind,
      server,
      message: boundedText(params.message, 16_384),
      ...(tool ? { tool } : {}),
      ...(toolApproval && boundedText(meta.tool_description, 4096)
        ? { description: boundedText(meta.tool_description, 4096) }
        : {}),
      ...(toolParams !== undefined ? { params: structuredClone(toolParams) } : {}),
      ...(kind === "url" && boundedText(params.url, 4096) ? { url: params.url } : {}),
      ...(kind === "form"
        ? {
            fields: fields!.slice(0, 32).map(([name, field]) => ({
              name: [...name].slice(0, 128).join(""),
              ...(isObject(field) && boundedText(field.title, 256) ? { title: field.title } : {}),
            })),
          }
        : {}),
    },
    command: null,
    cwd: null,
    changes: null,
    availableDecisions,
    ...(toolApproval && persist.includes("session")
      ? {
          decisionOptions: [
            { id: "native-accept", label: "accept", scope: "once", decision: accept },
            {
              id: "native-session",
              label: "acceptForSession",
              scope: "session",
              decision: { ...accept, _meta: { persist: "session" } },
            },
            {
              id: "native-decline",
              label: "decline",
              scope: "once",
              decision: { action: "decline" },
            },
            { id: "native-cancel", label: "cancel", scope: "once", decision: { action: "cancel" } },
          ],
          requiresExtendedApproval: false,
        }
      : {}),
    supported: true,
    unsupportedReason: null,
    unsupportedMetadata: [],
    proposedExecpolicyAmendment: null,
    environmentId: null,
  };
}

/** The `McpServerElicitationRequestResponse` for a decision offered by `projectElicitation`. */
export function elicitationResponse(decision: unknown): unknown {
  if (decision === "accept") return { action: "accept", content: {} };
  if (decision === "decline" || decision === "cancel") return { action: decision };
  return decision;
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max && !value.includes("\0")
    ? value
    : null;
}

function jsonSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function nativeApprovalOptions(method: string, details: JsonObject): JsonObject[] {
  if (Buffer.byteLength(JSON.stringify(details), "utf8") > 1024 * 1024) return [];
  const common = new Set([
    "threadId",
    "turnId",
    "itemId",
    "reason",
    "startedAtMs",
    "environmentId",
    "cwd",
  ]);
  const extra =
    method === "item/commandExecution/requestApproval"
      ? [
          "approvalId",
          "command",
          "commandActions",
          "kind",
          "availableDecisions",
          "proposedExecpolicyAmendment",
          "proposedNetworkPolicyAmendments",
          "networkApprovalContext",
          "additionalPermissions",
        ]
      : method === "item/fileChange/requestApproval"
        ? ["changes", "grantRoot", "availableDecisions"]
        : method === "item/permissions/requestApproval"
          ? ["permissions"]
          : null;
  if (
    !extra ||
    Object.entries(details).some(
      ([key, value]) => value != null && !common.has(key) && !extra.includes(key),
    ) ||
    (details.environmentId != null && details.environmentId !== "local") ||
    (details.reason != null && !bounded(details.reason, 16_384)) ||
    (details.startedAtMs != null &&
      (!Number.isSafeInteger(details.startedAtMs) || Number(details.startedAtMs) < 0))
  )
    return [];

  if (method === "item/permissions/requestApproval") {
    if (!bounded(details.cwd, 4096) || !validPermissionProfile(details.permissions)) return [];
    return [
      {
        id: "grant-turn",
        label: "grant-turn",
        scope: "once",
        decision: { permissions: details.permissions, scope: "turn" },
      },
      {
        id: "grant-session",
        label: "grant-session",
        scope: "session",
        decision: { permissions: details.permissions, scope: "session" },
      },
      {
        id: "deny-permissions",
        label: "deny-permissions",
        scope: "once",
        decision: { permissions: {}, scope: "turn" },
      },
    ];
  }

  if (method === "item/commandExecution/requestApproval") {
    if (
      !bounded(details.command, 16_384) ||
      !bounded(details.cwd, 4096) ||
      (details.kind != null && details.kind !== "command") ||
      (details.additionalPermissions != null &&
        !validPermissionProfile(details.additionalPermissions)) ||
      (details.networkApprovalContext != null &&
        !validNetworkApprovalContext(details.networkApprovalContext)) ||
      (details.proposedExecpolicyAmendment != null &&
        !validStringList(details.proposedExecpolicyAmendment)) ||
      (details.proposedNetworkPolicyAmendments != null &&
        (!Array.isArray(details.proposedNetworkPolicyAmendments) ||
          details.proposedNetworkPolicyAmendments.length > 100 ||
          !details.proposedNetworkPolicyAmendments.every(validNetworkRule)))
    )
      return [];
  } else if (
    !Array.isArray(details.changes) ||
    details.changes.length === 0 ||
    details.changes.length > 100 ||
    (details.grantRoot != null && !bounded(details.grantRoot, 4096))
  ) {
    return [];
  }

  const offered = details.availableDecisions ?? ["accept", "decline", "cancel"];
  if (!Array.isArray(offered) || offered.length > 32) return [];
  const result: JsonObject[] = [];
  for (const [index, decision] of offered.entries()) {
    let label: string | undefined;
    let scope: string | undefined;
    if (decision === "accept") {
      label = "accept";
      scope = details.grantRoot != null ? "session" : "once";
    } else if (decision === "decline" || decision === "cancel") {
      label = decision;
      scope = "once";
    } else if (decision === "acceptForSession") {
      label = decision;
      scope = "session";
    } else if (method === "item/commandExecution/requestApproval" && isObject(decision)) {
      const exec = decision.acceptWithExecpolicyAmendment;
      const network = decision.applyNetworkPolicyAmendment;
      if (
        isObject(exec) &&
        Object.keys(decision).length === 1 &&
        Object.keys(exec).length === 1 &&
        validStringList(exec.execpolicy_amendment) &&
        sameJson(exec.execpolicy_amendment, details.proposedExecpolicyAmendment)
      ) {
        label = "acceptWithExecpolicyAmendment";
        scope = "persistent";
      } else if (
        isObject(network) &&
        Object.keys(decision).length === 1 &&
        Object.keys(network).length === 1 &&
        validNetworkRule(network.network_policy_amendment) &&
        Array.isArray(details.proposedNetworkPolicyAmendments) &&
        details.proposedNetworkPolicyAmendments.some((item) =>
          sameJson(item, network.network_policy_amendment),
        )
      ) {
        label = "applyNetworkPolicyAmendment";
        scope = "persistent";
      }
    }
    if (label && scope) result.push({ id: `native-${index}`, label, scope, decision });
  }
  return result;
}

function validPermissionProfile(value: unknown): boolean {
  if (
    !isObject(value) ||
    Object.keys(value).some((key) => !["network", "fileSystem"].includes(key))
  )
    return false;
  const network = value.network;
  if (
    network != null &&
    (!isObject(network) ||
      Object.keys(network).some((key) => key !== "enabled") ||
      (network.enabled != null && typeof network.enabled !== "boolean"))
  )
    return false;
  const fileSystem = value.fileSystem;
  if (fileSystem == null) return true;
  if (
    !isObject(fileSystem) ||
    Object.keys(fileSystem).some(
      (key) => !["entries", "read", "write", "globScanMaxDepth"].includes(key),
    )
  )
    return false;
  const stringList = (list: unknown) =>
    list == null ||
    (Array.isArray(list) && list.length <= 100 && list.every((item) => bounded(item, 4096)));
  if (!stringList(fileSystem.read) || !stringList(fileSystem.write)) return false;
  if (
    fileSystem.globScanMaxDepth != null &&
    (!Number.isSafeInteger(fileSystem.globScanMaxDepth) || Number(fileSystem.globScanMaxDepth) <= 0)
  )
    return false;
  if (fileSystem.entries == null) return true;
  return (
    Array.isArray(fileSystem.entries) &&
    fileSystem.entries.length <= 100 &&
    fileSystem.entries.every((entry) => {
      if (
        !isObject(entry) ||
        Object.keys(entry).some((key) => !["access", "path"].includes(key)) ||
        !["read", "write", "deny"].includes(String(entry.access)) ||
        !isObject(entry.path)
      )
        return false;
      if (entry.path.type === "path")
        return (
          Object.keys(entry.path).every((key) => ["type", "path"].includes(key)) &&
          bounded(entry.path.path, 4096)
        );
      if (entry.path.type === "glob_pattern")
        return (
          Object.keys(entry.path).every((key) => ["type", "pattern"].includes(key)) &&
          bounded(entry.path.pattern, 4096)
        );
      return false;
    })
  );
}

function validStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every((item) => bounded(item, 4096));
}

function validNetworkRule(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => ["action", "host"].includes(key)) &&
    ["allow", "deny"].includes(String(value.action)) &&
    bounded(value.host, 1024)
  );
}

function validNetworkApprovalContext(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => ["host", "protocol"].includes(key)) &&
    bounded(value.host, 1024) &&
    ["http", "https", "tcp", "udp"].includes(String(value.protocol))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return approvalStableJson(left) === approvalStableJson(right);
}

function approvalStableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(approvalStableJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${approvalStableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function completeFileChange(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (Object.keys(value).some((key) => !["path", "kind", "diff"].includes(key))) return false;
  if (!absolutePath(value.path) || typeof value.diff !== "string" || value.diff.length > 256 * 1024)
    return false;
  if (
    !isObject(value.kind) ||
    Object.keys(value.kind).some((key) => !["type", "movePath"].includes(key))
  )
    return false;
  return (
    ["add", "update", "delete"].includes(String(value.kind.type)) &&
    (value.kind.movePath == null || absolutePath(value.kind.movePath))
  );
}

function projectNativeQuestions(params: JsonObject): {
  supported: boolean;
  questions: JsonObject[];
} {
  const rows = Array.isArray(params.questions) ? params.questions : [];
  if (rows.length === 0 || rows.length > MAX_PENDING) return { supported: false, questions: [] };
  let supported = true;
  const ids = new Set<string>();
  const questions = rows.map((value) => {
    const row = isObject(value) ? value : {};
    const options = Array.isArray(row.options) ? row.options : [];
    const custom = row.isOther === true || row.options == null;
    const labels = new Set<string>();
    const valid =
      Object.keys(row).every((key) =>
        ["id", "header", "question", "isOther", "isSecret", "options"].includes(key),
      ) &&
      bounded(row.id, 256) &&
      !ids.has(String(row.id)) &&
      bounded(row.question, 16_384) &&
      (row.header == null || bounded(row.header, 1024)) &&
      (row.isOther == null || typeof row.isOther === "boolean") &&
      (row.isSecret == null || typeof row.isSecret === "boolean") &&
      (row.options == null || Array.isArray(row.options)) &&
      (custom || options.length > 0) &&
      options.length <= 100 &&
      options.every((option) => {
        if (!isObject(option)) return false;
        const label = option.label;
        const good =
          Object.keys(option).every((key) => ["label", "description"].includes(key)) &&
          bounded(label, 4096) &&
          !labels.has(String(label)) &&
          (option.description == null || bounded(option.description, 16_384));
        if (good) labels.add(String(label));
        return good;
      });
    supported &&= valid;
    if (typeof row.id === "string") ids.add(row.id);
    return {
      id: row.id ?? null,
      header: row.header ?? null,
      question: row.question ?? null,
      options,
      multiSelect: false,
      allowCustom: custom,
      isSecret: row.isSecret === true,
    };
  });
  return { supported, questions };
}

function requiredRequestId(value: unknown): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error("invalid-request-id");
}

function requiredString(value: unknown, reason: string): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
  throw new Error(reason);
}

function requestKey(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return JSON.stringify(value);
}

function absolutePath(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.startsWith("/") && !value.includes("\0")
  );
}

function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
  );
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  return typeof value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{responseStreamDisconnected: {httpStatusCode}}` and its siblings carry the HTTP status. */
function codexErrorStatus(info: unknown): number | null {
  if (!isObject(info)) return null;
  for (const value of Object.values(info)) {
    const status = isObject(value) ? value.httpStatusCode : undefined;
    if (Number.isSafeInteger(status) && Number(status) >= 100 && Number(status) <= 599)
      return Number(status);
  }
  return null;
}

/** The `CodexErrorInfo` variant: a string, or the single key of an object variant. */
function codexErrorKind(info: unknown): string | null {
  const kind = typeof info === "string" ? info : isObject(info) ? Object.keys(info)[0] : undefined;
  return typeof kind === "string" && /^[A-Za-z_]{1,64}$/.test(kind) ? kind : null;
}

function codexRetry(error: JsonObject, previous: CodexApiRetry | null): CodexApiRetry {
  const message = typeof error.message === "string" ? error.message : "";
  // 0.163.0 words each retry `Reconnecting... <attempt>/<max>`; otherwise count the reports.
  const counted = /(\d{1,4})\s*\/\s*(\d{1,4})/.exec(message);
  const attempt = counted ? Number(counted[1]) : (previous?.attempt ?? 0) + 1;
  const maxRetries = counted ? Number(counted[2]) : (previous?.maxRetries ?? null);
  const detail = typeof error.additionalDetails === "string" ? error.additionalDetails.trim() : "";
  return {
    attempt: attempt > 0 ? attempt : 1,
    maxRetries: maxRetries !== null && maxRetries > 0 ? maxRetries : null,
    status: codexErrorStatus(error.codexErrorInfo),
    error: codexErrorKind(error.codexErrorInfo),
    detail: detail ? [...detail].slice(0, 1024).join("") : null,
  };
}

/**
 * The CLI's own error text for a failed turn, as the last row of that turn. The rollout keeps the
 * same text in `task_complete.error`, and its reader shows the same row.
 */
function turnErrorEvent(turn: JsonObject, reported: string | null): JsonObject | undefined {
  if (typeof turn.id !== "string" || !turn.id) return undefined;
  const failed = turn.status === "failed" || (turn.status === "completed" && turn.error != null);
  const text = failed ? (codexErrorText(turn.error) ?? reported) : null;
  // Stamped like the other live rows: `completedAt` has whole seconds and can precede them.
  return text ? codexTurnErrorEvent(turn.id, text, new Date().toISOString()) : undefined;
}

/**
 * The `turn_meta` of a finished app-server turn, matching what the rollout
 * reader derives from task_complete / turn_aborted. Unfinished turns have none.
 */
function turnMeta(turn: unknown): JsonObject | undefined {
  if (!isObject(turn)) return undefined;
  const outcome =
    turn.status === "completed"
      ? turn.error !== undefined && turn.error !== null
        ? "failed"
        : "completed"
      : turn.status === "interrupted"
        ? "aborted"
        : turn.status === "failed"
          ? "failed"
          : undefined;
  if (!outcome) return undefined;
  const meta: JsonObject = { outcome };
  const duration = turn.durationMs;
  if (typeof duration === "number" && Number.isSafeInteger(duration) && duration >= 0)
    meta.duration_ms = duration;
  return meta;
}
