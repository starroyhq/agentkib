import { performance } from "node:perf_hooks";
import path from "node:path";
import type { AcpEvent, AcpId, AcpPermission, AntigravityAcp } from "./antigravity-acp";
import {
  AcpCompactionState,
  AcpUndispatchedError,
  AntigravityAcp as AcpClient,
  verifyAcpControlIdentity,
} from "./antigravity-acp";
import { sanitizeHandoffExport } from "../../session-handoff";
import {
  createContextUsageGeneration,
  projectContextUsage,
  type ContextUsage,
} from "../../context-usage";

const ATTACH_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_APPROVAL_DETAILS_BYTES = 64 * 1024;
const MAX_UPDATES = 4096;
const DISPATCHING_TURN_ID = "agentkib-prompt-dispatch-in-progress";
const PROMPT_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "max_turn_requests",
  "refusal",
  "cancelled",
]);

type JsonRecord = Record<string, unknown>;
type PermissionState = AcpPermission & {
  id: AcpId;
  turnId: string;
  supported: boolean;
  toolCall: JsonRecord;
  availableDecisions: string[];
  unsupportedReason: string | null;
};
type ReportableSend = { requestId: string; accepted: Promise<boolean> };
type AntigravityTurnObserver = {
  waiting(turnId: string): void;
  ended(turnId: string, outcome: string, durationMs: number, replyText: string | null): void;
};

function acpIdText(value: AcpId): string {
  return typeof value === "bigint" ? value.toString() : value;
}

function textUpdate(update: JsonRecord): string | null {
  if (
    update.sessionUpdate !== "agent_message_chunk" ||
    !isRecord(update.content) ||
    update.content.type !== "text" ||
    typeof update.content.text !== "string"
  )
    return null;
  return update.content.text;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Owns one verified native Antigravity ACP session and publishes bounded live projections. */
export class AntigravityManagedRunner {
  #status = "idle";
  #revision = 0;
  #turnId: string | null = null;
  #completedTurn: string | null = null;
  #reportableTurn?: ReportableSend & { startedAt: number };
  #streamText = "";
  #messageText = new Map<string, string>();
  #items = new Map<string, JsonRecord>();
  #lastWorkerReply?: { kind: "agent-message"; turn_id: string; content: string };
  #toolCalls = new Map<string, JsonRecord>();
  #approvals = new Map<string, PermissionState>();
  #seenPermissions = new Set<string>();
  #updateCount = 0;
  #legacyMessageIndex = 0;
  #historySyncPending = false;
  #hasCompleteNativeHistory = false;
  #recoveringHistory = false;
  #reason: string | null = null;
  #cancellingAt: number | null = null;
  #closed = false;
  #pump?: Promise<void>;
  #compactions = new AcpCompactionState();
  #liveCompactionIds = new Set<string>();
  #usage: ContextUsage = { available: false, state: "unavailable" };
  #usageReportId = 0;
  readonly #usageGeneration = createContextUsageGeneration();
  #awaitingOrdinaryContext = false;

  private constructor(
    readonly client: AntigravityAcp,
    readonly sessionId: string,
    readonly workspace: string,
    private readonly publish?: (
      type: "state" | "text-delta" | "item-upsert" | "snapshot",
      payload: JsonRecord,
      live: JsonRecord,
    ) => void,
    private readonly recoverHistory?: () => Promise<JsonRecord[]>,
    private readonly observeTurn?: AntigravityTurnObserver,
  ) {}

  static async connect(
    executable: string,
    workspace: string,
    sessionId: string,
    env: NodeJS.ProcessEnv,
    publish?: AntigravityManagedRunner["publish"],
    recoverHistory?: AntigravityManagedRunner["recoverHistory"],
    initialRevision = 0,
    observeTurn?: AntigravityTurnObserver,
  ): Promise<AntigravityManagedRunner> {
    if (!path.isAbsolute(executable) || !path.isAbsolute(workspace) || !sessionId)
      throw new Error("invalid Antigravity session target");
    const deadline = performance.now() + ATTACH_TIMEOUT_MS;
    const client = AcpClient.spawn(executable, [], workspace, env, {
      timeout: ATTACH_TIMEOUT_MS,
      version: "0.15.1",
    });
    const runner = new AntigravityManagedRunner(
      client,
      sessionId,
      workspace,
      publish,
      recoverHistory,
      observeTurn,
    );
    // Replacing a retired transport must not make an old control revision current again.
    runner.#revision = initialRevision;
    try {
      const initialize = await client.initialize();
      const initialized = await runner.#waitForResponse(initialize, "initialize", deadline);
      verifyAcpControlIdentity(initialized);
      const compatibility = client.compatibility;
      if (!compatibility?.loadSession && !compatibility?.resumeSession)
        throw new Error("Antigravity ACP server cannot resume or load native sessions");
      const method = compatibility.resumeSession ? "session/resume" : "session/load";
      const attach =
        method === "session/resume"
          ? await client.resumeSession(sessionId, workspace)
          : await client.loadSession(sessionId, workspace);
      await runner.#waitForResponse(attach, method, deadline);
      // Attachment replays native history. It establishes the baseline, not a live turn.
      runner.#items.clear();
      runner.#messageText.clear();
      runner.#toolCalls.clear();
      runner.#streamText = "";
      runner.#updateCount = 0;
      runner.#legacyMessageIndex = 0;
      runner.#status = "idle";
      runner.#revision = initialRevision;
      runner.#publishSnapshot();
      runner.#pump = runner.#consume();
      return runner;
    } catch (error) {
      client.shutdown();
      throw error;
    }
  }

  get connected(): boolean {
    return !this.#closed && this.client.compatibility !== null;
  }

  recentWorkerReplies(limit: number): JsonRecord[] {
    const replies = [...this.#items.values()].filter((item) => item.kind === "agent-message");
    const last = this.#lastWorkerReply;
    if (last && !replies.some((item) => item.content === last.content)) {
      // A successful native history reload can still omit the just-finished turn.
      const active = replies.findIndex((item) => item.turn_id === this.#turnId);
      replies.splice(active < 0 ? replies.length : active, 0, last);
    }
    return replies.slice(-limit);
  }

  snapshot(): JsonRecord {
    return {
      sessionId: this.sessionId,
      executionMode: "acp-managed",
      status: this.#status,
      revision: this.#revision,
      turnId: this.#turnId,
      completedTurnId: this.#completedTurn,
      activity: this.#liveCompactionIds.size ? "compacting" : null,
      usage: projectContextUsage(
        { ...this.#usage, reportGeneration: this.#usageGeneration },
        this.#revision,
      ),
      sendEnabled:
        !this.#closed &&
        this.#status === "idle" &&
        this.#turnId === null &&
        !this.#recoveringHistory &&
        !this.#liveCompactionIds.size,
      stopEnabled:
        !this.#closed &&
        this.#turnId !== null &&
        ["running", "waiting-approval"].includes(this.#status),
      cancelling: this.#cancellingAt !== null,
      streamText: this.#streamText,
      approvals: [...this.#approvals.values()].map(({ id, ...permission }) => ({
        ...permission,
        requestId: acpIdText(id),
      })),
      reason: this.#reason,
      historySyncPending: this.#historySyncPending,
    };
  }

  async send(
    text: string,
    expectedRevision: number,
    beforeDispatch?: () => void,
    reporting?: ReportableSend,
  ): Promise<void> {
    if (!text.trim() || Buffer.byteLength(text) > 65_536)
      throw new Error("invalid Antigravity prompt");
    this.#checkRevision(expectedRevision);
    if (this.#liveCompactionIds.size) throw new AcpUndispatchedError();
    if (this.#status !== "idle" || this.#turnId !== null || this.#recoveringHistory)
      throw new Error("session-busy");
    this.#turnId = DISPATCHING_TURN_ID;
    this.#status = "running";
    this.#pendingUsage();
    this.#revision += 1;
    this.#publishSnapshot();
    try {
      const startedAt = performance.now();
      const id = await this.client.prompt(this.sessionId, text, () => {
        if (this.#liveCompactionIds.size) throw new AcpUndispatchedError();
        beforeDispatch?.();
      });
      this.#awaitingOrdinaryContext = false;
      this.#turnId = acpIdText(id);
      this.#reportableTurn = reporting && { ...reporting, startedAt };
      this.#completedTurn = null;
      this.#streamText = "";
      this.#messageText.clear();
      this.#toolCalls.clear();
      this.#approvals.clear();
      this.#seenPermissions.clear();
      this.#updateCount = 0;
      this.#legacyMessageIndex = 0;
      const item: JsonRecord = {
        id: `live:${this.#turnId}:user`,
        kind: "user-message",
        turn_id: this.#turnId,
        content: text,
        attachment_count: 0,
        truncated: false,
        ephemeral: true,
      };
      this.#items.set(String(item.id), item);
      this.#reason = null;
      this.#revision += 1;
      this.#publishSnapshot();
    } catch (error) {
      if (error instanceof AcpUndispatchedError) {
        this.#turnId = null;
        this.#status = "idle";
        this.#revision += 1;
        this.#publishSnapshot();
        throw error;
      }
      this.#fail(error);
      throw error;
    }
  }

  async stop(turnId: string, expectedRevision: number, beforeDispatch?: () => void): Promise<void> {
    this.#checkRevision(expectedRevision);
    if (
      this.#turnId !== turnId ||
      !["running", "waiting-approval"].includes(this.#status) ||
      this.#cancellingAt !== null
    )
      throw new Error("stale Antigravity turn");
    try {
      beforeDispatch?.();
      await this.client.cancel(this.sessionId);
      this.#cancellingAt = Date.now();
      this.#approvals.clear();
      this.#status = "running";
      this.#revision += 1;
      this.#publishSnapshot();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async approve(
    requestId: string,
    turnId: string,
    optionId: string,
    expectedRevision: number,
    beforeDispatch?: () => void,
  ) {
    this.#checkRevision(expectedRevision);
    if (this.#turnId !== turnId || this.#cancellingAt !== null)
      throw new Error("stale Antigravity turn");
    const permission = this.#approvals.get(requestId);
    if (!permission || !permission.supported || permission.turnId !== turnId)
      throw new Error("Antigravity approval is unavailable");
    if (!permission.options.some((option) => option.optionId === optionId))
      throw new Error("Antigravity approval option is unavailable");
    try {
      beforeDispatch?.();
      await this.client.respondPermission(permission.id, optionId);
      this.#approvals.delete(requestId);
      this.#status = this.#approvals.size ? "waiting-approval" : "running";
      this.#revision += 1;
      this.#publishSnapshot();
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#usage = {
      ...this.#usage,
      state: this.#usage.available ? "stale" : "unavailable",
      reason: "connection-unavailable",
    };
    this.client.shutdown();
  }

  async #waitForResponse(id: AcpId, method: string, deadline: number): Promise<unknown> {
    while (performance.now() < deadline) {
      const event = await this.client.nextEvent(Math.max(0, deadline - performance.now()));
      if (!event) throw new Error(`Antigravity ACP ${method} timed out`);
      if (event.type === "response" && event.id === id) {
        if (event.method !== method) throw new Error("Antigravity ACP response method mismatch");
        if (event.error)
          throw new Error(`Antigravity ACP ${method} failed: ${event.error.message}`);
        return event.result;
      }
      this.#apply(event, true);
    }
    throw new Error(`Antigravity ACP ${method} timed out`);
  }

  async #consume(): Promise<void> {
    while (!this.#closed) {
      try {
        const event = await this.client.nextEvent(POLL_MS);
        if (!event) {
          if (this.#cancellingAt !== null && Date.now() - this.#cancellingAt > 15_000)
            throw new Error("Antigravity stop timed out; outcome unknown");
          continue;
        }
        this.#apply(event, false);
      } catch (error) {
        if (!this.#closed) {
          this.#fail(error);
          this.client.shutdown();
        }
        return;
      }
    }
  }

  #apply(event: AcpEvent, replay: boolean): void {
    let changed = false;
    let outcome: string | undefined;
    const previousStatus = this.#status;
    if (event.type === "session-update") {
      if (event.sessionId !== this.sessionId) throw new Error("ACP session identity changed");
      this.#applyUpdate(event.update, replay);
      changed = true;
    } else if (event.type === "permission") {
      if (event.request.sessionId !== this.sessionId)
        throw new Error("ACP permission session mismatch");
      if (!replay) {
        if (this.#cancellingAt === null) this.#permission(event.id, event.request);
        changed = this.#cancellingAt === null;
      }
    } else if (event.type === "permission-cancelled") {
      if (event.sessionId !== this.sessionId) throw new Error("ACP cancellation session mismatch");
      changed = this.#approvals.delete(acpIdText(event.id));
      if (this.#approvals.size === 0 && this.#status === "waiting-approval")
        this.#status = "running";
    } else if (event.type === "response" && event.method === "session/prompt") {
      if (this.#turnId !== acpIdText(event.id))
        throw new Error("unexpected Antigravity prompt response");
      if (event.error) throw new Error(`Antigravity prompt failed: ${event.error.message}`);
      const result = isRecord(event.result) ? event.result : {};
      if (typeof result.stopReason !== "string" || !PROMPT_STOP_REASONS.has(result.stopReason))
        throw new Error("Antigravity prompt response has no valid stop reason");
      outcome = result.stopReason === "end_turn" ? "completed" : result.stopReason;
      this.#completedTurn = this.#turnId;
      this.#turnId = null;
      this.#status = "idle";
      this.#cancellingAt = null;
      this.#approvals.clear();
      this.#historySyncPending = true;
      this.#recoveringHistory = Boolean(
        this.recoverHistory && this.client.compatibility?.loadSession,
      );
      changed = true;
    }
    if (!replay && changed) {
      this.#revision += 1;
      this.#publishSnapshot();
      const turn = this.#reportableTurn;
      const observer = this.observeTurn;
      if (turn && observer) {
        // ACP RPC ids repeat across attachments. The accepted send identifies the turn
        // in orchestration, while the live/control projection keeps the native RPC id.
        if (outcome !== undefined) {
          this.#reportableTurn = undefined;
          const durationMs = performance.now() - turn.startedAt;
          const replyText = Array.from(this.#messageText.values()).at(-1) ?? null;
          const terminalOutcome = outcome;
          void turn.accepted.then((accepted) => {
            if (!accepted) return;
            if (replyText !== null)
              this.#lastWorkerReply = {
                kind: "agent-message",
                turn_id: turn.requestId,
                content: replyText,
              };
            observer.ended(turn.requestId, terminalOutcome, durationMs, replyText);
          });
        } else if (previousStatus !== "waiting-approval" && this.#status === "waiting-approval") {
          void turn.accepted.then((accepted) => {
            if (accepted) observer.waiting(turn.requestId);
          });
        }
      }
    }
    if (
      !replay &&
      changed &&
      event.type === "response" &&
      event.method === "session/prompt" &&
      this.#recoveringHistory
    )
      void this.#recoverNativeHistory();
  }

  #applyUpdate(update: JsonRecord, replay: boolean): void {
    if (!replay && ++this.#updateCount > MAX_UPDATES)
      throw new Error("too many Antigravity ACP updates");
    const wasCompacting = this.#liveCompactionIds.size > 0;
    if (this.#compactions.apply(update)) {
      if (replay) return;
      const id = String(update.compactionId);
      if (update.sessionUpdate === "compaction_update") {
        if (this.#compactions.isTerminal(id)) this.#liveCompactionIds.delete(id);
        else this.#liveCompactionIds.add(id);
      }
      if (this.#liveCompactionIds.size) this.#pendingUsage();
      else if (wasCompacting) {
        this.#awaitingOrdinaryContext = true;
        this.#usage = {
          ...this.#usage,
          state: this.#usage.available ? "stale" : "unavailable",
          reason: "compaction-completed",
        };
      }
      return;
    }
    if (["current_model_update", "config_option_update"].includes(String(update.sessionUpdate))) {
      this.#awaitingOrdinaryContext = true;
      this.#usage = {
        ...this.#usage,
        state: this.#usage.available ? "stale" : "unavailable",
        reason: "model-context-changed",
      };
      return;
    }
    if (update.sessionUpdate === "usage_update") {
      // ACP has no usage-to-call identity. A report after terminal compaction may
      // still belong to compaction; require a normal prompt/output boundary first.
      // A later active compaction can still replace the pending candidate without
      // confirming ordinary context or promoting that report to ready.
      if (this.#awaitingOrdinaryContext && !this.#liveCompactionIds.size) return;
      const report = projectContextUsage({
        available: true,
        state: replay ? "stale" : this.#liveCompactionIds.size ? "pending" : "ready",
        usedTokens: update.used,
        contextWindow: update.size,
        reportId: ++this.#usageReportId,
        updatedAt: new Date().toISOString(),
      })!;
      this.#usage =
        report.usedTokens === undefined || report.contextWindow === undefined
          ? {
              available: false,
              state: "unavailable",
              reason: "invalid-context-report",
              reportId: this.#usageReportId,
            }
          : report;
      return;
    }
    if (
      !replay &&
      !this.#liveCompactionIds.size &&
      ["agent_message_chunk", "user_message_chunk"].includes(String(update.sessionUpdate))
    )
      this.#awaitingOrdinaryContext = false;
    if (replay) {
      const replayText = textUpdate(update);
      if (replayText !== null && Buffer.byteLength(replayText) > MAX_CONTENT_BYTES)
        throw new Error("ACP output exceeds 512 KiB");
      if (
        ["tool_call", "tool_call_update"].includes(String(update.sessionUpdate)) &&
        (typeof update.toolCallId !== "string" || !update.toolCallId)
      )
        throw new Error("invalid ACP tool ID");
      return;
    }
    const text = textUpdate(update);
    if (text !== null) {
      if (
        update.messageId !== undefined &&
        (typeof update.messageId !== "string" ||
          !update.messageId ||
          Buffer.byteLength(update.messageId) > 256)
      )
        throw new Error("invalid Antigravity message ID");
      const nativeId =
        typeof update.messageId === "string"
          ? update.messageId
          : `live:${this.#turnId ?? this.#completedTurn ?? "unknown"}:assistant:${this.#legacyMessageIndex}`;
      const previous = this.#messageText.get(nativeId) ?? "";
      if (Buffer.byteLength(previous + text) > MAX_CONTENT_BYTES)
        throw new Error("ACP output exceeds 512 KiB");
      this.#messageText.set(nativeId, previous + text);
      if (Buffer.byteLength(this.#streamText + text) > MAX_CONTENT_BYTES)
        throw new Error("ACP output exceeds 512 KiB");
      this.#streamText += text;
      const item = {
        id: nativeId,
        kind: "agent-message",
        turn_id: this.#turnId ?? this.#completedTurn,
        content: this.#messageText.get(nativeId),
        attachment_count: 0,
        truncated: false,
        ephemeral: nativeId.startsWith("live:"),
      };
      this.#items.set(nativeId, item);
      if (text)
        this.publish?.(
          "text-delta",
          {
            itemId: nativeId,
            turnId: item.turn_id,
            text,
            offset: previous.length,
            ephemeral: item.ephemeral,
          },
          this.snapshot(),
        );
    }
    if (update.sessionUpdate === "user_message_chunk") {
      const content =
        isRecord(update.content) && typeof update.content.text === "string"
          ? update.content.text
          : "";
      const id =
        typeof update.messageId === "string"
          ? update.messageId
          : `live:${this.#turnId ?? this.#completedTurn ?? "unknown"}:user`;
      const previous = this.#items.get(id);
      const item = {
        id,
        kind: "user-message",
        turn_id: this.#turnId ?? this.#completedTurn,
        content: `${typeof previous?.content === "string" ? previous.content : ""}${content}`,
        attachment_count: 0,
        truncated: false,
        ephemeral: id.startsWith("live:"),
      };
      this.#items.set(id, item);
      if (typeof update.messageId !== "string") this.#legacyMessageIndex += 1;
    }
    if (["tool_call", "tool_call_update"].includes(String(update.sessionUpdate))) {
      if (typeof update.toolCallId !== "string" || !update.toolCallId)
        throw new Error("invalid ACP tool ID");
      const old = this.#toolCalls.get(update.toolCallId) ?? {};
      const call = { ...old, ...update };
      this.#toolCalls.set(update.toolCallId, call);
      const rawName = [call.title, call.name, call.kind].find(visible);
      const toolName = rawName ? sanitizeHandoffExport(rawName, "markdown").slice(0, 512) : "tool";
      this.#items.set(update.toolCallId, {
        id: update.toolCallId,
        kind: "tool-summary",
        turn_id: this.#turnId ?? this.#completedTurn,
        content: "",
        tool_name: toolName,
        tool_status: call.status ?? null,
        attachment_count: 0,
        truncated: false,
        ephemeral: true,
      });
      this.#legacyMessageIndex += 1;
    }
  }

  #permission(id: AcpId, request: AcpPermission): void {
    if (!this.#turnId || !["running", "waiting-approval"].includes(this.#status))
      throw new Error("ACP permission outside active turn");
    const key = acpIdText(id);
    if (
      this.#seenPermissions.size >= MAX_UPDATES ||
      this.#seenPermissions.has(key) ||
      this.#approvals.size >= 32
    )
      throw new Error("reused or excessive ACP permission request");
    this.#seenPermissions.add(key);
    if (
      !request.options.length ||
      new Set(request.options.map((option) => option.optionId)).size !== request.options.length
    )
      throw new Error("invalid Antigravity permission options");
    if (
      request.options.some(
        (option) =>
          !option.name.trim() ||
          Buffer.byteLength(option.name) > 512 ||
          !option.kind.trim() ||
          Buffer.byteLength(option.kind) > 256,
      )
    )
      throw new Error("invalid Antigravity permission presentation");
    const options = request.options.map(({ optionId, name, kind }) => ({
      optionId,
      name: sanitizeHandoffExport(name, "markdown").slice(0, 512),
      kind: sanitizeHandoffExport(kind, "markdown").slice(0, 256),
    }));
    const projected = projectPermissionToolCall(request.toolCall);
    const toolCall = projected.value ?? { toolCallId: "[unavailable]" };
    const idSupported =
      typeof id === "bigint"
        ? id >= -(1n << 53n) + 1n && id <= (1n << 53n) - 1n
        : safeWebField(key);
    const optionsSupported = request.options.every((option) => safeWebField(option.optionId));
    const supported = projected.supported && idSupported && optionsSupported;
    this.#approvals.set(key, {
      sessionId: this.sessionId,
      options,
      toolCall,
      id,
      turnId: this.#turnId,
      supported,
      unsupportedReason: supported
        ? null
        : !projected.supported
          ? "incomplete-operation-details"
          : !idSupported
            ? "unsupported-request-id"
            : "unsupported-option-id",
      availableDecisions: supported ? request.options.map((option) => option.optionId) : [],
    });
    this.#status = "waiting-approval";
  }

  async #recoverNativeHistory(): Promise<void> {
    try {
      const items = await this.recoverHistory?.();
      if (items) {
        let bytes = 0;
        for (const item of items) {
          bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
          if (bytes > 1024 * 1024) break;
        }
        if (items.length > 4096 || bytes > 1024 * 1024) {
          this.#historySyncPending = true;
          return;
        }
        this.#items.clear();
        for (const item of items) {
          if (typeof item.id === "string") this.#items.set(item.id, item);
        }
        this.#historySyncPending = false;
        this.#hasCompleteNativeHistory = true;
      }
    } catch (error) {
      this.#fail(error);
      this.close();
    } finally {
      if (this.#closed) return;
      this.#recoveringHistory = false;
      this.#revision += 1;
      this.#publishSnapshot();
    }
  }

  #checkRevision(revision: number): void {
    if (this.#closed || !this.client.compatibility) throw new Error("session-runner-unavailable");
    if (["failed", "outcome-unknown"].includes(this.#status))
      throw new Error("session-recovery-required");
    if (this.#revision !== revision) throw new Error("stale Antigravity revision");
  }

  #pendingUsage(): void {
    this.#usage = {
      ...this.#usage,
      state: this.#usage.available ? "pending" : "unavailable",
      reason: "context-report-pending",
    };
  }

  #fail(error: unknown): void {
    this.#status = this.#turnId ? "outcome-unknown" : "failed";
    this.#approvals.clear();
    this.#cancellingAt = null;
    this.#reason = (error instanceof Error ? error.message : String(error)).slice(0, 512);
    this.#usage = {
      ...this.#usage,
      state: this.#usage.available ? "stale" : "unavailable",
      reason: "connection-unavailable",
    };
    this.#revision += 1;
    this.#publishSnapshot();
  }

  #publishSnapshot(): void {
    const completeItems = this.#hasCompleteNativeHistory && this.#completeHistoryProjection();
    if (this.#hasCompleteNativeHistory && !completeItems) this.#historySyncPending = true;
    const snapshot = this.snapshot();
    const items = [...this.#items.values()];
    this.publish?.(
      "snapshot",
      {
        live: snapshot,
        items: completeItems ? items : items.slice(-100),
        replaceItems: true,
        preserveItemsOutsideCoverage: true,
        completeItems,
      },
      snapshot,
    );
  }

  #completeHistoryProjection(): boolean {
    if (this.#historySyncPending || this.#items.size > 4096) return false;
    let bytes = 0;
    for (const item of this.#items.values()) {
      bytes += Buffer.byteLength(JSON.stringify(item), "utf8");
      if (bytes > 1024 * 1024) return false;
    }
    return true;
  }
}

function safeWebField(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256 && !/[\p{Cc}]/u.test(value);
}

function visible(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("[REDACTED");
}

function containsRedacted(value: unknown): boolean {
  if (typeof value === "string") return value.includes("[REDACTED");
  if (Array.isArray(value)) return value.some(containsRedacted);
  if (isRecord(value)) return Object.values(value).some(containsRedacted);
  return false;
}

function visibleActionDetail(value: unknown): boolean {
  if (typeof value === "string") return visible(value);
  if (Array.isArray(value)) return value.some(visibleActionDetail);
  if (isRecord(value)) {
    const ignored = new Set([
      "type",
      "kind",
      "mimeType",
      "status",
      "encoding",
      "cwd",
      "workingDirectory",
      "env",
      "environment",
      "headers",
      "metadata",
      "mode",
      "operation",
      "action",
      "method",
      "title",
      "name",
      "label",
      "description",
      "summary",
      "reason",
    ]);
    return Object.entries(value).some(
      ([key, child]) => !ignored.has(key) && visibleActionDetail(child),
    );
  }
  return false;
}

function hasHiddenCommand(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasHiddenCommand);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) =>
    ["command", "cmd", "script"].includes(key)
      ? !visibleActionDetail(child)
      : hasHiddenCommand(child),
  );
}

function noParentSegment(value: string): boolean {
  return !value.split(/[\\/]/).includes("..");
}

function samePermissionPath(left: string, right: string, cwd: string | null): boolean {
  if (!visible(left) || !visible(right) || !noParentSegment(left) || !noParentSegment(right))
    return false;
  const normalize = (value: string) =>
    path.resolve(path.isAbsolute(value) ? value : (cwd ?? "/"), value);
  return normalize(left) === normalize(right);
}

function permissionLocationsMatch(
  locations: unknown,
  paths: string[],
  cwd: string | null,
): boolean {
  if (locations === undefined) return true;
  return (
    Array.isArray(locations) &&
    locations.every(
      (location) =>
        isRecord(location) &&
        Object.keys(location).every((key) => ["path", "line"].includes(key)) &&
        typeof location.path === "string" &&
        paths.some((known) => samePermissionPath(location.path as string, known, cwd)) &&
        (location.line === undefined ||
          location.line === null ||
          (Number.isInteger(location.line) &&
            Number(location.line) >= 0 &&
            Number(location.line) <= 0xffff_ffff)),
    )
  );
}

function projectPermissionToolCall(source: JsonRecord): {
  value: JsonRecord | null;
  supported: boolean;
} {
  const allowed = new Set([
    "toolCallId",
    "title",
    "name",
    "kind",
    "status",
    "rawInput",
    "content",
    "locations",
  ]);
  const callId = source.toolCallId;
  if (
    Object.keys(source).some((key) => !allowed.has(key)) ||
    typeof callId !== "string" ||
    !callId ||
    Buffer.byteLength(callId) > 4096 ||
    ["title", "name", "kind", "status"].some(
      (key) =>
        source[key] !== undefined &&
        source[key] !== null &&
        (typeof source[key] !== "string" ||
          Buffer.byteLength(source[key]) > 16 * 1024 ||
          source[key].includes("\0")),
    ) ||
    ["content", "locations"].some(
      (key) => source[key] !== undefined && source[key] !== null && !Array.isArray(source[key]),
    )
  )
    return { value: null, supported: false };

  let projected: JsonRecord;
  try {
    projected = JSON.parse(sanitizeHandoffExport(JSON.stringify(source), "json")) as JsonRecord;
  } catch {
    return { value: null, supported: false };
  }
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_APPROVAL_DETAILS_BYTES)
    return { value: null, supported: false };
  const kind = projected.kind;
  const input = projected.rawInput;
  let actionVisible = false;
  if (["execute", "command", "terminal", "shell"].includes(String(kind)) && isRecord(input)) {
    const command = [input.command, input.cmd, input.script].some(visible);
    const args = [input.args, input.arguments].filter((part) => part !== undefined);
    const cwd = input.cwd ?? input.workingDirectory;
    actionVisible =
      command &&
      args.every((part) => Array.isArray(part) && part.every(visible)) &&
      (cwd === undefined ||
        (typeof cwd === "string" &&
          visible(cwd) &&
          path.isAbsolute(cwd) &&
          noParentSegment(cwd))) &&
      !hasHiddenCommand(input);
  } else if (kind === "read" && isRecord(input)) {
    const paths = [input.path, input.filePath].filter(
      (part): part is string => typeof part === "string",
    );
    const cwdValue = input.cwd ?? input.workingDirectory;
    const cwd = typeof cwdValue === "string" ? cwdValue : null;
    actionVisible =
      projected.content === undefined &&
      paths.length > 0 &&
      paths.every((part) => visible(part) && noParentSegment(part)) &&
      (cwdValue === undefined ||
        (typeof cwdValue === "string" &&
          visible(cwdValue) &&
          path.isAbsolute(cwdValue) &&
          noParentSegment(cwdValue))) &&
      Object.keys(input).every((key) =>
        ["path", "filePath", "cwd", "workingDirectory"].includes(key),
      ) &&
      (input.path === undefined ||
        input.filePath === undefined ||
        (typeof input.path === "string" &&
          typeof input.filePath === "string" &&
          samePermissionPath(input.path, input.filePath, cwd))) &&
      permissionLocationsMatch(projected.locations, paths, cwd);
  } else if (kind === "edit") {
    const inputFields = isRecord(input) ? input : null;
    const inputChange =
      inputFields !== null &&
      Object.keys(inputFields).every((key) =>
        ["path", "filePath", "cwd", "workingDirectory", "oldText", "newText"].includes(key),
      ) &&
      visible(inputFields?.newText) &&
      (inputFields?.oldText === null ||
        (visible(inputFields?.oldText) && inputFields?.oldText !== inputFields?.newText)) &&
      [inputFields?.path, inputFields?.filePath].some(
        (part) => visible(part) && noParentSegment(part),
      );
    const content = projected.content;
    const contentChange =
      Array.isArray(content) &&
      content.length > 0 &&
      content.every(
        (part) =>
          isRecord(part) &&
          part.type === "diff" &&
          visible(part.path) &&
          noParentSegment(part.path) &&
          visible(part.newText) &&
          (part.oldText === null || (visible(part.oldText) && part.oldText !== part.newText)) &&
          Object.keys(part).every((key) => ["type", "path", "oldText", "newText"].includes(key)),
      );
    const cwdValue = inputFields?.cwd ?? inputFields?.workingDirectory;
    const cwd = typeof cwdValue === "string" ? cwdValue : null;
    const inputPath = [inputFields?.path, inputFields?.filePath].find(
      (part): part is string => typeof part === "string",
    );
    const locationPaths = Array.isArray(content)
      ? content
          .map((part) => (isRecord(part) ? part.path : undefined))
          .filter((part): part is string => typeof part === "string")
      : inputPath
        ? [inputPath]
        : [];
    const consistentChanges =
      !inputChange ||
      !contentChange ||
      (Array.isArray(content) &&
        content.length === 1 &&
        inputFields?.oldText === content[0]?.oldText &&
        inputFields?.newText === content[0]?.newText &&
        (!inputPath ||
          (typeof content[0]?.path === "string" &&
            samePermissionPath(inputPath, content[0].path, cwd))));
    actionVisible =
      Boolean(inputChange || contentChange) &&
      consistentChanges &&
      (input === undefined || inputChange) &&
      (content === undefined || contentChange) &&
      (inputFields?.path === undefined ||
        inputFields.filePath === undefined ||
        (typeof inputFields.path === "string" &&
          typeof inputFields.filePath === "string" &&
          samePermissionPath(inputFields.path, inputFields.filePath, cwd))) &&
      (cwdValue === undefined ||
        (typeof cwdValue === "string" &&
          visible(cwdValue) &&
          path.isAbsolute(cwdValue) &&
          noParentSegment(cwdValue))) &&
      (!inputPath || (visible(inputPath) && noParentSegment(inputPath))) &&
      permissionLocationsMatch(projected.locations, locationPaths, cwd);
  }
  const hasAction =
    (isRecord(projected.rawInput) &&
      !containsRedacted(projected.rawInput) &&
      visibleActionDetail(projected.rawInput)) ||
    (Array.isArray(projected.content) &&
      !containsRedacted(projected.content) &&
      visibleActionDetail(projected.content));
  return {
    value: projected,
    supported: actionVisible && hasAction,
  };
}
