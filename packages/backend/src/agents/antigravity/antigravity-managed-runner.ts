import { performance } from "node:perf_hooks";
import path from "node:path";
import type {
  AcpEvent,
  AcpId,
  AcpMcpServer,
  AcpPermission,
  AntigravityAcp,
} from "./antigravity-acp";
import {
  AcpCompactionState,
  AcpUndispatchedError,
  AntigravityAcp as AcpClient,
  verifyAcpControlIdentity,
} from "./antigravity-acp";
import { stringifyAcpJson } from "../../acp-json";
import { sanitizeHandoffExport } from "../../session-handoff";
import { antigravityAcpArgs } from "./antigravity-sessions";
import {
  createContextUsageGeneration,
  projectContextUsage,
  type ContextUsage,
} from "../../context-usage";
import type { LeadToolRegistration } from "../../orchestration-endpoint";

const ATTACH_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_APPROVAL_DETAILS_BYTES = 64 * 1024;
const MAX_UPDATES = 4096;
const CONFIGURED_MCP_TOOL = "call_mcp_tool";
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
export type AntigravityAttachOptions = {
  /** The Project Agent MCP tools registered for this session, if any. */
  leadTools?: LeadToolRegistration;
  /** Start a new session with `session/new` instead of resuming one. */
  create?: boolean;
  /** ACP option values the session should run with, set before its next turn. */
  config?: Record<string, string>;
};

/** The ACP options (`configOptions`) a session response or update carries. */
export function configOptionsOf(value: unknown): JsonRecord[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.configOptions)) return undefined;
  return value.configOptions.filter(
    (option): option is JsonRecord => isRecord(option) && typeof option.id === "string",
  );
}

/** Why Antigravity could not run a turn, in the reason codes clients explain. */
export function antigravityTurnFailure(message: string): string {
  if (/quota|resource[ _-]?exhausted|rate[ _-]?limit|usage limit|out of credits/i.test(message))
    return "antigravity-usage-limited";
  if (/unauthenticated|not (signed|logged) in|sign[ -]?in|log[ -]?in|credential/i.test(message))
    return "antigravity-login-required";
  return "antigravity-run-failed";
}

export class AntigravityManagedRunner {
  /** The CLI's own `agy acp`, whose tool inputs are normalized before they are shown. */
  #cli = false;
  /** The session's own ACP options (model, thought level, mode), as Antigravity last told. */
  #configOptions: JsonRecord[] = [];
  /** Requests whose answers a caller awaits while the event pump reads them. */
  #pendingResponses = new Map<
    string,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  /** Fully qualified MCP names this connection offered from the Project Agent endpoint. */
  readonly #leadToolNames = new Set<string>();
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
  #toolStartedAt = new Map<string, number>();
  #workerProgress = 0;
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
    /** Empty until a session AgentKib starts gets its ID from `session/new`. */
    public sessionId: string,
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
    options: AntigravityAttachOptions = {},
  ): Promise<AntigravityManagedRunner> {
    if (
      !path.isAbsolute(executable) ||
      !path.isAbsolute(workspace) ||
      (!sessionId && !options.create)
    )
      throw new Error("invalid Antigravity session target");
    const deadline = performance.now() + ATTACH_TIMEOUT_MS;
    const client = AcpClient.spawn(executable, antigravityAcpArgs(executable), workspace, env, {
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
      runner.#cli =
        isRecord(initialized) && isRecord(initialized.agentInfo)
          ? initialized.agentInfo.name === "Antigravity ACP Server"
          : false;
      const { leadTools } = options;
      const mcpServers: AcpMcpServer[] = leadTools
        ? [{ type: "http", name: leadTools.serverName, url: leadTools.url, headers: [] }]
        : [];
      let attached: unknown;
      if (options.create) {
        attached = await runner.#waitForResponse(
          await client.newSession(workspace, mcpServers),
          "session/new",
          deadline,
        );
        const created = isRecord(attached) ? attached.sessionId : undefined;
        if (typeof created !== "string" || !created)
          throw new Error("Antigravity ACP session/new returned no session");
        runner.sessionId = created;
      } else {
        const compatibility = client.compatibility;
        if (!compatibility?.loadSession && !compatibility?.resumeSession)
          throw new Error("Antigravity ACP server cannot resume or load native sessions");
        const method = compatibility.resumeSession ? "session/resume" : "session/load";
        const attach =
          method === "session/resume"
            ? await client.resumeSession(sessionId, workspace, mcpServers)
            : await client.loadSession(sessionId, workspace, mcpServers);
        attached = await runner.#waitForResponse(attach, method, deadline);
      }
      runner.#configOptions = configOptionsOf(attached) ?? [];
      if (leadTools) {
        for (const toolName of leadTools.toolNames)
          runner.#leadToolNames.add(`mcp_${leadTools.serverName}_${toolName}`);
      }
      // The person's choices apply before the next message: Antigravity keeps a session's model
      // and mode, but a resumed session starts again at the default thought level.
      let confirmedMode = runner.option("mode");
      for (const [id, value] of Object.entries(options.config ?? {})) {
        const verify = options.create && id === "mode";
        if ((verify ? confirmedMode : runner.option(id)) === value) continue;
        let changed: unknown;
        try {
          changed = await runner.#waitForResponse(
            await client.setConfigOption(runner.sessionId, id, value),
            "session/set_config_option",
            deadline,
          );
        } catch (error) {
          if (verify) throw new Error("create-permission-unconfirmed", { cause: error });
          throw error;
        }
        const config = configOptionsOf(changed);
        runner.#configOptions = config ?? runner.#configOptions;
        // An option change can reset other settings. Do not verify mode from the cached options.
        confirmedMode = config ? runner.option("mode") : undefined;
        if (verify && confirmedMode !== value) throw new Error("create-permission-unconfirmed");
      }
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

  /** The session's ACP options as Antigravity last reported them. */
  get configOptions(): readonly JsonRecord[] {
    return this.#configOptions;
  }

  option(id: string): string | undefined {
    const value = this.#configOptions.find((option) => option.id === id)?.currentValue;
    return typeof value === "string" ? value : undefined;
  }

  /** Sets the session's own ACP options while no turn runs; the next turn uses them. */
  async setOptions(
    changes: Record<string, string>,
    expectedRevision: number,
    beforeDispatch?: () => void,
  ): Promise<void> {
    this.#checkRevision(expectedRevision);
    if (this.#status !== "idle" || this.#turnId !== null || this.#recoveringHistory)
      throw new Error("session-busy");
    const pending = Object.entries(changes).filter(([id, value]) => this.option(id) !== value);
    if (!pending.length) return;
    beforeDispatch?.();
    try {
      for (const [id, value] of pending) {
        const request = await this.client.setConfigOption(this.sessionId, id, value);
        const result = await new Promise<unknown>((resolve, reject) =>
          this.#pendingResponses.set(acpIdText(request), { resolve, reject }),
        );
        this.#configOptions = configOptionsOf(result) ?? this.#configOptions;
      }
    } finally {
      this.#revision += 1;
      this.#publishSnapshot();
    }
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
        method: "session/request_permission",
        presentation: "tool",
      })),
      reason: this.#reason,
      historySyncPending: this.#historySyncPending,
    };
  }

  workerObservation() {
    if (!this.connected || !this.#turnId || this.#turnId === DISPATCHING_TURN_ID) return {};
    let incomplete = false;
    const commands = [...this.#toolCalls].flatMap(([id, call]) => {
      if (call.status === "pending" || call.status === "in_progress")
        return [{ id, startedAt: this.#toolStartedAt.get(id) }];
      if (call.status !== "completed" && call.status !== "failed") incomplete = true;
      return [];
    });
    return {
      workerProgress: String(this.#workerProgress),
      commands: !incomplete || commands.length ? commands : undefined,
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
      this.#toolStartedAt.clear();
      this.#workerProgress = 0;
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
    if (!permission.availableDecisions.includes(optionId))
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
    for (const pending of this.#pendingResponses.values())
      pending.reject(new Error("session-runner-unavailable"));
    this.#pendingResponses.clear();
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
      // Antigravity announces a new session's commands before `session/new` names it.
      if (!this.sessionId && replay) return;
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
    } else if (event.type === "response" && this.#pendingResponses.has(acpIdText(event.id))) {
      const pending = this.#pendingResponses.get(acpIdText(event.id))!;
      this.#pendingResponses.delete(acpIdText(event.id));
      if (event.error) pending.reject(new Error(event.error.message));
      else pending.resolve(event.result);
    } else if (event.type === "response" && event.method === "session/prompt") {
      if (this.#turnId !== acpIdText(event.id))
        throw new Error("unexpected Antigravity prompt response");
      // A turn Antigravity could not run ends as failed; the session stays usable.
      const result = isRecord(event.result) ? event.result : {};
      if (
        !event.error &&
        (typeof result.stopReason !== "string" || !PROMPT_STOP_REASONS.has(result.stopReason))
      )
        throw new Error("Antigravity prompt response has no valid stop reason");
      outcome = event.error
        ? "failed"
        : result.stopReason === "end_turn"
          ? "completed"
          : String(result.stopReason);
      if (event.error) this.#reason = antigravityTurnFailure(event.error.message);
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
    if (update.sessionUpdate === "config_option_update") {
      this.#configOptions = configOptionsOf(update) ?? this.#configOptions;
      return;
    }
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
      if (text) this.#workerProgress++;
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
    if (
      update.sessionUpdate === "agent_thought_chunk" &&
      isRecord(update.content) &&
      update.content.type === "text" &&
      typeof update.content.text === "string" &&
      update.content.text.length > 0
    )
      this.#workerProgress++;
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
      if (call.status !== old.status || update.sessionUpdate === "tool_call")
        this.#workerProgress++;
      if (
        call.status === "in_progress" &&
        call.kind === "execute" &&
        !this.#toolStartedAt.has(update.toolCallId)
      )
        this.#toolStartedAt.set(update.toolCallId, Date.now());
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
    // Designating the session a Project Agent is the person's permission for its worker tools.
    const lead = request.options.find((option) => option.kind === "allow_once");
    if (
      lead &&
      typeof request.toolCall.name === "string" &&
      this.#leadToolNames.has(request.toolCall.name)
    ) {
      void this.client.respondPermission(id, lead.optionId).catch((error) => this.#fail(error));
      return;
    }
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
    const offered = this.#cli
      ? request.options.filter(({ kind }) => kind === "allow_once" || kind === "reject_once")
      : request.options;
    const options = offered.map(({ optionId, name, kind }) => ({
      optionId,
      name: sanitizeHandoffExport(name, "markdown").slice(0, 512),
      kind: sanitizeHandoffExport(kind, "markdown").slice(0, 256),
    }));
    const projected = projectPermissionToolCall(
      this.#cli ? normalizeCliToolCall(request.toolCall) : request.toolCall,
      this.#cli,
    );
    const toolCall = projected.value ?? { toolCallId: "[unavailable]" };
    const idSupported =
      typeof id === "bigint"
        ? id >= -(1n << 53n) + 1n && id <= (1n << 53n) - 1n
        : safeWebField(key);
    const optionsSupported =
      offered.length > 0 && offered.every(({ optionId }) => safeWebField(optionId));
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
      availableDecisions: supported ? offered.map(({ optionId }) => optionId) : [],
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
    for (const pending of this.#pendingResponses.values())
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    this.#pendingResponses.clear();
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

function isCliMcpToolName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^mcp_[A-Za-z0-9][A-Za-z0-9_-]*_[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)
  );
}

function configuredMcpDetails(input: JsonRecord) {
  const { Arguments: args, ServerName: server, ToolName: tool } = input;
  const label = /^[A-Za-z0-9_.-]{1,256}$/;
  if (
    Object.keys(input).length !== 3 ||
    typeof server !== "string" ||
    !label.test(server) ||
    typeof tool !== "string" ||
    !label.test(tool) ||
    !isRecord(args)
  )
    return null;
  // The orchestrator may delegate shell approvals to a lead, but not MCP approvals.
  return { kind: "other", title: `${server} / ${tool}`, rawInput: args };
}

/**
 * The CLI's `agy acp` (1.5.14) names its tools' inputs its own way (`CommandLine`; `Path`,
 * `Target` and `Replacement` beside a diff) and repeats them as `args`. They are mapped onto the
 * shapes checked below; an edit is shown by its diff alone, whose paths the CLI also lists as
 * locations under another spelling of the same directory.
 */
function normalizeCliToolCall(source: JsonRecord): JsonRecord {
  const { sessionUpdate: _update, args: _args, ...call } = source;
  const input = isRecord(source.rawInput)
    ? source.rawInput
    : isRecord(source.args)
      ? source.args
      : undefined;
  // Locally configured MCP calls use kind "execute" but do not run a shell command.
  if (
    source.name === CONFIGURED_MCP_TOOL ||
    (source.kind === "other" && isCliMcpToolName(source.name))
  ) {
    const matching =
      source.rawInput == null ||
      source.args == null ||
      stringifyAcpJson(source.rawInput) === stringifyAcpJson(source.args);
    return { ...call, rawInput: matching ? input : undefined };
  }
  if (source.kind === "execute" && input && typeof input.CommandLine === "string") {
    const cwd = typeof input.Cwd === "string" ? input.Cwd : undefined;
    return { ...call, rawInput: { command: input.CommandLine, ...(cwd ? { cwd } : {}) } };
  }
  if (source.kind === "edit" && Array.isArray(source.content) && source.content.length) {
    const { rawInput: _input, locations: _locations, ...rest } = call;
    return {
      ...rest,
      // A new file's diff has no old text.
      content: source.content.map((part) =>
        isRecord(part) && part.type === "diff" && part.oldText === undefined
          ? { ...part, oldText: null }
          : part,
      ),
    };
  }
  return call;
}

function projectPermissionToolCall(
  source: JsonRecord,
  cli: boolean,
): {
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

  const configuredMcp = cli && source.name === CONFIGURED_MCP_TOOL;
  const mcp = configuredMcp || (cli && source.kind === "other" && isCliMcpToolName(source.name));
  let projected: JsonRecord;
  try {
    const encoded = JSON.stringify(source, (_key, value: unknown) => {
      if (!mcp) return value;
      // ACP preserves wire integers. The Web card must show their exact value.
      const display = typeof value === "bigint" ? Number(value) : value;
      if (
        typeof display === "number" &&
        Number.isInteger(display) &&
        !Number.isSafeInteger(display)
      )
        throw new Error("unreviewable Antigravity argument");
      return display;
    });
    projected = JSON.parse(sanitizeHandoffExport(encoded, "json")) as JsonRecord;
  } catch {
    return { value: null, supported: false };
  }
  if (Buffer.byteLength(JSON.stringify(projected)) > MAX_APPROVAL_DETAILS_BYTES)
    return { value: null, supported: false };
  const kind = projected.kind;
  const input = projected.rawInput;
  if (mcp) {
    const reviewable =
      isRecord(input) &&
      !containsRedacted(input) &&
      [projected.content, projected.locations].every(
        (value) => value == null || (Array.isArray(value) && value.length === 0),
      );
    if (configuredMcp) {
      const details = kind === "execute" && reviewable ? configuredMcpDetails(input) : null;
      return { value: details ? { ...projected, ...details } : projected, supported: !!details };
    }
    if (isCliMcpToolName(projected.name))
      return { value: { ...projected, title: projected.name }, supported: reviewable };
    return { value: projected, supported: false };
  }
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
