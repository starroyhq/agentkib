import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { MacOwnedProcessTree } from "./mac-owned-process-tree";
import { acquirePortableFileLease } from "./managed-session-lock";
import { truncateUtf8 } from "./session-events";
import { claudeToolDetail, claudeToolResult, compactClaudeInput } from "./conversation-tools";
import {
  boundedUnknownFields,
  ClaudeProtocolDiagnostics,
  ClaudeProtocolError,
  ClaudeTurnFailure,
  controlDeny,
  controlError,
  formatTermination,
  frameOrigin,
  MAX_UNKNOWN_REQUESTS_PER_TURN,
  type ClaudeTerminationCode,
  type FrameOrigin,
} from "./claude-frame-policy";
import { CLAUDE_MANAGED_VERIFIED_THROUGH, isNewerThanVerified } from "./claude-version";
import {
  createContextUsageGeneration,
  projectContextUsage,
  type ContextUsage,
} from "./context-usage";

const MAX_TEXT = 4 * 1024 * 1024;
const MAX_LINE = 6 * MAX_TEXT + 1024 * 1024;
const MAX_INTERACTIONS = 1024 * 1024;
// Stable texts that tests and logs match on.
const BACKGROUND_REFUSED = "Claude background tasks are unsupported in managed sessions";
const UNVERIFIED_START = "unverified Claude foreground Bash task";
const PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "subtype",
  "tool_name",
  "input",
  "tool_use_id",
  "permission_suggestions",
  "blocked_path",
  "decision_reason",
  "agent_id",
  "title",
  "display_name",
  "description",
  "decision_reason_type",
  "matched_ask_rule",
  "classifier_approvable",
  "suppress_always_allow_rule",
  "default_to_no",
  "requires_user_interaction",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, any>;
export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudePermissionMode = "default" | "plan" | "acceptEdits";
/**
 * Modes the CLI can report in stream-json (`system/init` and `system/status` carry
 * `permissionMode`). Only `ClaudePermissionMode` can be selected from AgentKib; the rest are
 * observed and displayed, never offered as choices.
 */
export type ClaudeObservedPermissionMode =
  | ClaudePermissionMode
  | "auto"
  | "dontAsk"
  | "bypassPermissions";
export type ClaudeRunnerSettings = {
  model: string | null;
  effort: ClaudeEffort | null;
  permissionMode: ClaudePermissionMode;
};
export type ClaudeRunnerEffectiveSettings = Omit<ClaudeRunnerSettings, "permissionMode"> & {
  permissionMode: ClaudePermissionMode | null;
};
export type ClaudeModelOption = {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description?: string;
  supportedEffortLevels?: ClaudeEffort[];
};
export type ClaudeRunnerOptionsSnapshot = {
  models: ClaudeModelOption[];
  commands: Array<{ name: string; description?: string; argumentHint?: string }>;
  settings: ClaudeRunnerEffectiveSettings;
  settingsAcknowledged: boolean;
};
export type ClaudeRunnerTerminalResult = {
  turnId: string;
  success: boolean;
  subtype: string;
  terminalReason: string | null;
  usage: Record<string, unknown> | null;
  modelUsage: Record<string, unknown> | null;
  costUsd: number | null;
};
export type ClaudeRunnerOptions = {
  model?: string;
  effort?: ClaudeEffort;
  permissionMode?: ClaudePermissionMode;
  forkSourceNativeId?: string;
  forkCutoff?: string;
  mcpConfig?: Record<string, unknown>;
  onResult?: (result: ClaudeRunnerTerminalResult) => void;
  controlTimeoutMs?: number;
  /** Revalidate native ownership immediately before every new worker, including retirement reuse. */
  beforeStart?: () => Promise<void>;
  /** Persist cleanup proof before an undispatched startup publishes a retryable state. */
  onUndispatchedStartup?: (proof: ClaudeStartupCleanupProof) => void;
  /** `claude --version` output; only used to explain a failure when the CLI is newer than verified. */
  cliVersion?: string;
};
export type ClaudeStartupFailureCode =
  | "initialize-timeout"
  | "initialize-write-failed"
  | "process-start-failed"
  | "process-exited"
  | "stream-closed";
export type ClaudeStartupCleanupKind = "not-started" | "mac-owned-process-tree";
export type ClaudeStartupCleanupProof = {
  requestId: string;
  code: ClaudeStartupFailureCode;
  cleanupKind: ClaudeStartupCleanupKind;
  failedRevision: number;
  checkpoint: { revision: number; turnId: string };
};
export class ClaudeUndispatchedError extends Error {
  constructor(message = "session-compacting") {
    super(message);
  }
}
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export type ClaudeRunnerSnapshot = {
  terminalResult: ClaudeRunnerTerminalResult | null;
  lastOutcome: string | null;
  model: string | null;
  tokenUsage: unknown;
  usage: ContextUsage;
  activity: "compacting" | null;
  status: string;
  sendEnabled: boolean;
  stopEnabled: boolean;
  revision: number;
  turnId: string;
  approvals: JsonObject[];
  questions: JsonObject[];
  streamText: string;
  streamTextTruncated: boolean;
  reason: string | null;
};

/** Claude stream-json protocol state shared by the managed process transport. */
export class ClaudeRunnerState {
  revision = 0;
  turnId = "";
  status = "idle";
  approvals: JsonObject[] = [];
  questions: JsonObject[] = [];
  seenRequests = new Set<string>();
  streamText = "";
  streamItemId = "";
  streamItemText = "";
  textBlockSerial = 0;
  activeTextBlockIndex = -1;
  textBlocks = new Map<number, { id: string; text: string }>();
  finalizedTextBlocks: Array<{
    index: number;
    temporaryId: string;
    id: string;
    text: string;
  }> = [];
  reason: string | null = null;
  initialized = false;
  initId = "";
  pendingUser: JsonObject | null = null;
  model: string | null = null;
  usage: unknown = null;
  contextUsage: ContextUsage = { available: false, state: "unavailable" };
  activity: "compacting" | null = null;
  usageModel: string | null = null;
  usageReportId = 0;
  readonly #usageGeneration = createContextUsageGeneration();
  modelWindows = new Map<string, number>();
  lastOutcome: string | null = null;
  partial = false;
  foregroundBashContract = false;
  bashToolIds = new Set<string>();
  foregroundTasks = new Map<string, string>();
  // What sub-agents did, observed only: Bash tool ID -> spawning Agent call, task ID -> Bash tool
  // ID. They never feed bashToolIds or foregroundTasks, which gate `result` and the stop
  // semantics of the current top-level turn, and nothing here can end the session.
  subagentBashToolIds = new Map<string, string>();
  subagentTasks = new Map<string, string>();
  terminalResult: ClaudeRunnerTerminalResult | null = null;
  // Control requests refused in the current turn; a stream that keeps sending them is broken.
  unknownRequests = 0;
  // What was ignored or refused, by category. Not part of any snapshot or checkpoint.
  readonly diagnostics = new ClaudeProtocolDiagnostics();

  constructor(readonly sessionId: string) {}

  checkpoint() {
    return {
      revision: this.revision,
      turnId: this.turnId,
      status: this.status,
      approvals: structuredClone(this.approvals),
      questions: structuredClone(this.questions),
      seenRequests: new Set(this.seenRequests),
      streamText: this.streamText,
      streamItemId: this.streamItemId,
      streamItemText: this.streamItemText,
      textBlockSerial: this.textBlockSerial,
      activeTextBlockIndex: this.activeTextBlockIndex,
      textBlocks: structuredClone(this.textBlocks),
      finalizedTextBlocks: structuredClone(this.finalizedTextBlocks),
      reason: this.reason,
      initialized: this.initialized,
      initId: this.initId,
      pendingUser: this.pendingUser ? structuredClone(this.pendingUser) : null,
      model: this.model,
      usage: this.usage ? structuredClone(this.usage) : null,
      contextUsage: structuredClone(this.contextUsage),
      activity: this.activity,
      usageModel: this.usageModel,
      usageReportId: this.usageReportId,
      modelWindows: new Map(this.modelWindows),
      lastOutcome: this.lastOutcome,
      partial: this.partial,
      foregroundBashContract: this.foregroundBashContract,
      bashToolIds: new Set(this.bashToolIds),
      foregroundTasks: new Map(this.foregroundTasks),
      subagentBashToolIds: new Map(this.subagentBashToolIds),
      subagentTasks: new Map(this.subagentTasks),
      terminalResult: this.terminalResult ? structuredClone(this.terminalResult) : null,
      unknownRequests: this.unknownRequests,
    };
  }

  restoreStartup(checkpoint: ReturnType<ClaudeRunnerState["checkpoint"]>, reason: string): void {
    const revision = Math.max(this.revision, checkpoint.revision) + 1;
    Object.assign(this, checkpoint);
    this.revision = revision;
    this.reason = reason;
  }

  restoreUndispatched(checkpoint: ReturnType<ClaudeRunnerState["checkpoint"]>): void {
    const native = {
      activity: this.activity,
      contextUsage: this.contextUsage,
      usage: this.usage,
      usageModel: this.usageModel,
      usageReportId: this.usageReportId,
      model: this.model,
      modelWindows: this.modelWindows,
      initialized: this.initialized,
      initId: this.initId,
      pendingUser: null,
      revision: Math.max(this.revision, checkpoint.revision) + 1,
    };
    Object.assign(this, checkpoint, native);
  }

  initialize(pendingUser: JsonObject | null = null): JsonObject {
    if (this.initialized || this.pendingUser) throw new Error("Claude runner already initialized");
    this.initId = randomUUID();
    this.pendingUser = pendingUser;
    return {
      type: "control_request",
      request_id: this.initId,
      request: { subtype: "initialize", hooks: null },
    };
  }

  snapshot(): ClaudeRunnerSnapshot {
    const max = Math.floor((512 * 1024 - 2) / 6);
    let end = 0;
    for (const character of this.streamText) {
      const next = end + character.length;
      if (Buffer.byteLength(this.streamText.slice(0, next)) > max) break;
      end = next;
    }
    return {
      terminalResult: this.terminalResult ? structuredClone(this.terminalResult) : null,
      lastOutcome: this.lastOutcome,
      model: this.model,
      tokenUsage: this.usage,
      usage: projectContextUsage(
        { ...this.contextUsage, reportGeneration: this.#usageGeneration },
        this.revision,
      )!,
      activity: this.activity,
      status: this.status,
      sendEnabled: this.status === "idle" && this.activity !== "compacting",
      stopEnabled: this.status !== "idle" && this.turnId.length > 0 && this.reason === null,
      revision: this.revision,
      turnId: this.turnId,
      approvals: structuredClone(this.approvals),
      questions: structuredClone(this.questions),
      streamText: this.streamText.slice(0, end),
      streamTextTruncated: end < this.streamText.length,
      reason: this.reason,
    };
  }

  begin(content: unknown, turnId: string = randomUUID()): JsonObject {
    validateClaudeContent(content);
    if (!uuidPattern.test(turnId)) throw new Error("invalid Claude turn ID");
    if (this.activity === "compacting") throw new ClaudeUndispatchedError();
    if (this.status !== "idle") throw new Error("Claude session is busy or failed");
    this.turnId = turnId;
    this.streamText = "";
    this.streamItemId = "";
    this.streamItemText = "";
    this.textBlockSerial = 0;
    this.activeTextBlockIndex = -1;
    this.textBlocks.clear();
    this.finalizedTextBlocks = [];
    this.partial = false;
    this.reason = null;
    this.lastOutcome = null;
    this.terminalResult = null;
    this.bashToolIds.clear();
    this.foregroundTasks.clear();
    this.subagentBashToolIds.clear();
    this.subagentTasks.clear();
    this.unknownRequests = 0;
    this.status = "running";
    this.#pendingUsage();
    this.revision++;
    return {
      type: "user",
      session_id: this.sessionId,
      parent_tool_use_id: null,
      uuid: turnId,
      message: { role: "user", content },
    };
  }

  steer(content: unknown, requestId: string, turnId: string, revision: number): JsonObject {
    validateClaudeContent(content);
    if (!uuidPattern.test(requestId) || requestId === turnId)
      throw new Error("invalid Claude steering ID");
    if (revision !== this.revision || turnId !== this.turnId) throw new Error("stale Claude turn");
    if (!this.initialized || this.status !== "running" || this.reason !== null)
      throw new Error("Claude steering requires an active turn");
    if (this.activity === "compacting") throw new ClaudeUndispatchedError();
    return {
      type: "user",
      session_id: this.sessionId,
      parent_tool_use_id: null,
      uuid: requestId,
      priority: "next",
      message: { role: "user", content },
    };
  }

  approve(requestId: unknown, turnId: string, decision: string, revision: number): JsonObject {
    if (revision !== this.revision) throw new Error("stale Claude revision");
    if (turnId !== this.turnId || !["waiting-approval", "waiting-input"].includes(this.status))
      throw new Error("stale Claude turn");
    if (decision !== "allow" && decision !== "deny")
      throw new Error("unsupported Claude approval decision");
    const index = this.approvals.findIndex((item) => item.requestId === requestId);
    if (index < 0) throw new Error("unknown or already answered Claude approval");
    const [approval] = this.approvals.splice(index, 1);
    this.revision++;
    this.status = this.questions.length
      ? "waiting-input"
      : this.approvals.length
        ? "waiting-approval"
        : "running";
    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response:
          decision === "allow"
            ? { behavior: "allow", updatedInput: approval.input }
            : { behavior: "deny", message: "Denied by the user" },
      },
    };
  }

  answer(requestId: unknown, turnId: string, answers: unknown, revision: number): JsonObject {
    if (revision !== this.revision || turnId !== this.turnId)
      throw new Error("stale Claude question");
    const index = this.questions.findIndex((item) => item.requestId === requestId);
    if (index < 0) throw new Error("question no longer pending");
    const pending = this.questions[index]!;
    const rows = pending.questions as JsonObject[];
    if (!object(answers)) throw new Error("invalid answers");
    const keys = Object.keys(answers);
    if (rows.length !== keys.length) throw new Error("answer keys mismatch");
    const native: Record<string, string> = {};
    for (const row of rows) {
      const key = row.id;
      const values = answers[key];
      if (
        typeof key !== "string" ||
        !Array.isArray(values) ||
        values.length === 0 ||
        values.length > 16 ||
        (!row.multiSelect && values.length !== 1)
      )
        throw new Error("invalid answer cardinality");
      const unique = new Set<string>();
      const selected = values.map((value: unknown) => {
        if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 8192)
          throw new Error("invalid answer text");
        if (unique.has(value)) throw new Error("duplicate answer");
        unique.add(value);
        return value;
      });
      native[key] = selected.join(", ");
    }
    const input = structuredClone(pending.input) as JsonObject;
    input.answers = native;
    this.questions.splice(index, 1);
    this.revision++;
    this.status = this.questions.length
      ? "waiting-input"
      : this.approvals.length
        ? "waiting-approval"
        : "running";
    return {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "allow", updatedInput: input },
      },
    };
  }

  assertCanStop(turnId: string, revision: number): void {
    if (
      revision !== this.revision ||
      turnId !== this.turnId ||
      !["running", "waiting-approval", "waiting-input"].includes(this.status) ||
      this.reason !== null
    )
      throw new Error("stale Claude turn");
  }

  stop(turnId: string, revision: number): void {
    this.assertCanStop(turnId, revision);
    this.bashToolIds.clear();
    this.foregroundTasks.clear();
    this.subagentBashToolIds.clear();
    this.subagentTasks.clear();
    this.unknownRequests = 0;
    this.status = "idle";
    this.lastOutcome = "cancelled";
    this.terminalResult = null;
    this.initialized = false;
    this.initId = "";
    this.seenRequests.clear();
    this.partial = false;
    this.approvals = [];
    this.questions = [];
    this.pendingUser = null;
    this.reason = null;
    this.activity = null;
    this.#pendingUsage();
    this.revision++;
  }

  fail(reason: string): void {
    this.status = "outcome-unknown";
    this.activity = null;
    this.contextUsage = {
      ...this.contextUsage,
      state: this.contextUsage.available ? "stale" : "unavailable",
      reason: "connection-unavailable",
    };
    if (Buffer.byteLength(reason) > 4096) {
      let end = Math.min(reason.length, 4096);
      while (Buffer.byteLength(reason.slice(0, end)) > 4096) end--;
      reason = `${reason.slice(0, end)}… [truncated]`;
    }
    this.reason = reason;
    this.lastOutcome = null;
    this.approvals = [];
    this.questions = [];
    this.pendingUser = null;
    this.revision++;
  }

  frame(frame: unknown): JsonObject | null {
    if (!object(frame) || typeof frame.type !== "string")
      throw new Error("Claude frame missing type");
    this.finalizedTextBlocks = [];
    if (frame.session_id !== undefined && frame.session_id !== this.sessionId)
      throw new Error("Claude session ID changed unexpectedly");
    switch (frame.type) {
      case "command_lifecycle":
      case "keep_alive":
      case "transcript_mirror":
      case "active_goal":
      case "autocompact_state":
        return null;
      case "control_response":
        if (this.initialized || frame.response?.request_id !== this.initId)
          throw new Error("unexpected Claude control response");
        if (frame.response?.subtype !== "success") throw new Error("Claude initialize failed");
        this.initialized = true;
        this.revision++;
        const pending = this.pendingUser;
        this.pendingUser = null;
        return pending;
      case "control_request":
        return this.#controlRequest(frame);
      case "control_cancel_request":
        if (typeof frame.request_id !== "string") throw new Error("invalid Claude cancellation");
        this.approvals = this.approvals.filter((item) => item.requestId !== frame.request_id);
        this.questions = this.questions.filter((item) => item.requestId !== frame.request_id);
        if (!this.questions.length && this.status === "waiting-input")
          this.status = this.approvals.length ? "waiting-approval" : "running";
        if (!this.approvals.length && this.status === "waiting-approval") this.status = "running";
        break;
      case "stream_event": {
        const origin = frameOrigin(frame);
        if (origin.kind !== "main") {
          this.#observeOtherThread(frame, origin);
          return null;
        }
        this.#assertTurnActive("stream_event");
        const event = frame.event;
        if (event?.type === "message_start") {
          if (this.activity !== "compacting") this.#pendingUsage();
          this.#observeUsage(event.message);
          this.streamItemId = "";
          this.streamItemText = "";
          this.activeTextBlockIndex = -1;
          this.textBlocks.clear();
          this.partial = false;
        }
        if (event?.type === "content_block_start" && event.content_block?.type === "text") {
          const index = Number.isSafeInteger(event.index) ? event.index : this.textBlockSerial;
          this.#startTextBlock(index);
          if (typeof event.content_block.text === "string") this.#append(event.content_block.text);
          this.partial = true;
        }
        if (event?.type === "content_block_start") this.#observeBash(event.content_block, origin);
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          if (typeof event.delta.text !== "string") throw new Error("invalid Claude text delta");
          const index = Number.isSafeInteger(event.index) ? event.index : this.activeTextBlockIndex;
          if (!this.textBlocks.has(index)) this.#startTextBlock(index);
          else this.activeTextBlockIndex = index;
          this.#append(event.delta.text);
          this.partial = true;
        }
        break;
      }
      case "assistant": {
        const origin = frameOrigin(frame);
        if (origin.kind !== "main") {
          this.#observeOtherThread(frame, origin);
          return null;
        }
        this.#assertTurnActive("assistant");
        if (frame.isUnmetered !== true) this.#observeUsage(frame.message);
        const blocks = frame.message?.content;
        const nativeId =
          (typeof frame.uuid === "string" && uuidPattern.test(frame.uuid) && frame.uuid) ||
          (typeof frame.message?.id === "string" &&
            uuidPattern.test(frame.message.id) &&
            frame.message.id) ||
          "";
        const hasText =
          Array.isArray(blocks) && blocks.some((block: JsonObject) => block?.type === "text");
        if (Array.isArray(blocks)) for (const block of blocks) this.#observeBash(block, origin);
        if (hasText && nativeId && Array.isArray(blocks)) {
          const textBlocks = blocks.flatMap((block: JsonObject, index: number) => {
            if (block?.type !== "text") return [];
            if (typeof block.text !== "string") throw new Error("invalid Claude text");
            const streamed = this.textBlocks.get(index);
            return [
              {
                index,
                temporaryId: streamed?.id ?? "",
                id: index === 0 ? nativeId : `${nativeId}:text:${index}`,
                text: block.text,
              },
            ];
          });
          this.finalizedTextBlocks = textBlocks;
          this.streamItemId = textBlocks[0]?.id ?? nativeId;
          this.streamItemText = textBlocks[0]?.text ?? "";
          if (!this.partial) for (const block of textBlocks) this.#append(block.text);
        }
        this.partial = false;
        break;
      }
      case "result":
        if (this.foregroundTasks.size)
          throw new Error("Claude result with unresolved foreground tasks");
        // result usage is a per-turn aggregate; only the latest main-loop API input
        // report measures context occupancy. modelUsage supplies the native limit.
        if (object(frame.modelUsage) && this.usageModel) {
          const window = frame.modelUsage[this.usageModel]?.contextWindow;
          if (Number.isSafeInteger(window) && window > 0) {
            this.modelWindows.set(this.usageModel, window);
            const waitingForWindow =
              this.contextUsage.state === "pending" &&
              this.contextUsage.reason === "model-context-window-unavailable";
            this.contextUsage = {
              ...this.contextUsage,
              contextWindow: window,
              state: waitingForWindow ? "ready" : this.contextUsage.state,
              reason: waitingForWindow ? undefined : this.contextUsage.reason,
            };
          }
        }
        if (!this.initialized) throw new Error("Claude resume failed before initialization");
        if (!this.turnId || this.status === "idle")
          throw new ClaudeProtocolError(
            "claude-unrequested-turn",
            "Claude result outside an active turn",
          );
        if (this.approvals.length || this.questions.length)
          throw new Error("Claude result with unresolved approvals");
        this.terminalResult = {
          turnId: this.turnId,
          success:
            frame.is_error !== true &&
            frame.subtype === "success" &&
            (frame.terminal_reason === undefined || frame.terminal_reason === "completed"),
          subtype: typeof frame.subtype === "string" ? frame.subtype : "unknown",
          terminalReason: typeof frame.terminal_reason === "string" ? frame.terminal_reason : null,
          usage: object(frame.usage) ? structuredClone(frame.usage) : null,
          modelUsage: object(frame.modelUsage) ? structuredClone(frame.modelUsage) : null,
          costUsd:
            typeof frame.total_cost_usd === "number" &&
            Number.isFinite(frame.total_cost_usd) &&
            frame.total_cost_usd >= 0
              ? frame.total_cost_usd
              : null,
        };
        if (frame.is_error === true || frame.subtype !== "success") {
          const detail = Array.isArray(frame.errors)
            ? frame.errors.filter((item: unknown) => typeof item === "string").join("; ")
            : "";
          throw new ClaudeTurnFailure(
            `Claude turn failed: ${detail || frame.result || "unknown execution error"}`,
          );
        }
        if (!this.streamText && typeof frame.result === "string") this.#append(frame.result);
        this.status = "idle";
        this.lastOutcome = this.terminalResult.success ? "succeeded" : "cancelled";
        if (this.activity === "compacting") this.#staleUsage();
        this.activity = null;
        this.streamText = "";
        break;
      case "system":
        if (frame.subtype === "init" && typeof frame.model === "string") this.model = frame.model;
        if (frame.subtype === "status") {
          if (frame.status === "compacting") {
            this.activity = "compacting";
            this.#pendingUsage();
          } else if (frame.status === null || frame.status === "requesting") {
            if (this.activity === "compacting") this.#staleUsage();
            this.activity = null;
          }
        }
        if (frame.subtype === "compact_boundary") {
          this.activity = null;
          this.#staleUsage();
        }
        if (
          [
            "task_started",
            "background_tasks_changed",
            "task_updated",
            "task_notification",
          ].includes(frame.subtype)
        ) {
          if (
            !this.foregroundBashContract &&
            ["task_updated", "task_notification"].includes(frame.subtype)
          )
            return null;
          // Observing another task must not invalidate an outstanding approval or question.
          if (!this.#taskFrame(frame)) return null;
        }
        break;
      case "user": {
        const origin = frameOrigin(frame);
        if (origin.kind !== "main") {
          this.#observeOtherThread(frame, origin);
          return null;
        }
        this.#assertTurnActive("user");
        break;
      }
      case "tool_progress":
      case "tool_use_summary":
      case "rate_limit_event":
      case "auth_status":
      case "prompt_suggestion":
        break;
      default:
        // A frame type this version does not know cannot approve anything: approvals only arrive
        // as control requests. Ignore it without touching state, and keep a count.
        this.diagnostics.record("ignoredFrameTypes", frame.type);
        return null;
    }
    this.revision++;
    return null;
  }

  #pendingUsage(): void {
    this.contextUsage = {
      ...this.contextUsage,
      state: this.contextUsage.available ? "pending" : "unavailable",
      reason: "context-report-pending",
    };
  }

  #staleUsage(reason = "compaction-completed"): void {
    this.contextUsage = {
      ...this.contextUsage,
      state: this.contextUsage.available ? "stale" : "unavailable",
      reason,
    };
  }

  #observeUsage(message: unknown): void {
    if (!object(message)) return;
    if (!object(message.usage) || message.model === "<synthetic>") return;
    if (typeof message.model !== "string" || !message.model) {
      this.#staleUsage("model-context-window-unavailable");
      return;
    }
    let usage = message.usage;
    if (Array.isArray(usage.iterations)) {
      const iteration = [...usage.iterations]
        .reverse()
        .find((item) => object(item) && !["advisor_message", "compaction"].includes(item.type));
      if (object(iteration) && ["message", "fallback_message"].includes(iteration.type))
        usage = iteration;
      else if (usage.iterations.length) return;
    }
    const input = usage.input_tokens;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    if (
      ![input, cacheRead, cacheCreation].every((value) => Number.isSafeInteger(value) && value >= 0)
    ) {
      this.#staleUsage("invalid-context-report");
      return;
    }
    const usedTokens = input + cacheRead + cacheCreation;
    if (!Number.isSafeInteger(usedTokens)) {
      this.#staleUsage("invalid-context-report");
      return;
    }
    this.usage = structuredClone(usage);
    this.usageModel = message.model;
    this.model = message.model;
    const contextWindow = this.modelWindows.get(message.model);
    // A report received during compaction is a candidate, not proof that the
    // ordinary request now uses the compacted context. A later normal report
    // must restore its current qualification, even if the native limit is known.
    const compacting = this.activity === "compacting";
    this.contextUsage = {
      available: true,
      state: compacting || contextWindow === undefined ? "pending" : "ready",
      ...(compacting
        ? { reason: "context-report-pending" }
        : contextWindow === undefined
          ? { reason: "model-context-window-unavailable" }
          : {}),
      usedTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      reportId: ++this.usageReportId,
      updatedAt: new Date().toISOString(),
    };
  }

  #controlRequest(frame: JsonObject): JsonObject | null {
    const id = frame.request_id;
    if (typeof id !== "string" || !id) throw new Error("invalid Claude request id");
    const request = frame.request;
    if (!object(request) || typeof request.subtype !== "string" || !request.subtype)
      throw new Error("invalid Claude control request");
    if (request.subtype !== "can_use_tool") {
      // The CLI waits for an answer to every request, so it gets one: an error, which it treats as
      // a refusal. Nothing here can ever answer with an allow.
      if (++this.unknownRequests > MAX_UNKNOWN_REQUESTS_PER_TURN)
        throw new Error("too many unsupported Claude control requests");
      this.diagnostics.record("refusedRequests", request.subtype);
      return controlError(id);
    }
    if (!this.initialized) throw new Error("Claude requested interaction before initialize");
    if (!["running", "waiting-approval", "waiting-input"].includes(this.status))
      throw new ClaudeProtocolError(
        "claude-unrequested-turn",
        "Claude interaction outside active turn",
      );
    if (this.seenRequests.size >= 4096 || this.seenRequests.has(id))
      throw new Error("duplicate Claude control request");
    this.seenRequests.add(id);
    const name = request.tool_name;
    if (typeof name !== "string" || !name || !object(request.input))
      throw new Error("invalid Claude tool input");
    if (this.approvals.length >= 32) throw new Error("too many pending Claude approvals");
    if (name === "AskUserQuestion") {
      const questions = questionSchema(request.input);
      if (this.questions.length >= 32) throw new Error("too many pending questions");
      const pending = {
        requestId: id,
        turnId: this.turnId,
        method: "claude/AskUserQuestion",
        supported: true,
        questions,
        input: request.input,
      };
      this.#interactionBudget(pending);
      this.questions.push(pending);
      this.status = "waiting-input";
      this.revision++;
      return null;
    }
    if (
      request.requires_user_interaction !== undefined &&
      request.requires_user_interaction !== false
    ) {
      // A tool that needs its own interface cannot be answered from an approval card. Deny with an
      // explanation the model can pass on; allowing it would run it without that interaction.
      this.diagnostics.record("refusedTools", name);
      return controlDeny(id);
    }
    const context: JsonObject = {};
    for (const [key, value] of Object.entries(request))
      if (PERMISSION_KEYS.has(key)) context[key] = value;
    delete context.input;
    delete context.tool_name;
    delete context.subtype;
    context.blockedPath = request.blocked_path ?? null;
    context.decisionReason = request.decision_reason ?? null;
    context.permissionSuggestions = request.permission_suggestions ?? null;
    delete context.blocked_path;
    delete context.decision_reason;
    delete context.permission_suggestions;
    // Fields a newer CLI adds (for example which MCP server asked) are shown, bounded, so the user
    // decides with what the CLI sent. They are display only: the answer is the decision plus the
    // original input.
    const unknown = boundedUnknownFields(request, PERMISSION_KEYS, new Set(Object.keys(context)));
    Object.assign(context, unknown.fields);
    for (const field of [...unknown.accepted, ...unknown.dropped])
      this.diagnostics.record("unknownPermissionFields", field);
    const pending = {
      requestId: id,
      turnId: this.turnId,
      method: "claude/can_use_tool",
      supported: true,
      toolName: name,
      input: request.input,
      context,
      availableDecisions: ["allow", "deny"],
    };
    this.#interactionBudget(pending);
    this.approvals.push(pending);
    this.status = this.questions.length ? "waiting-input" : "waiting-approval";
    this.revision++;
    return null;
  }

  #interactionBudget(pending: JsonObject): void {
    if (
      Buffer.byteLength(JSON.stringify([this.approvals, this.questions, pending])) >
      MAX_INTERACTIONS
    )
      throw new Error("Claude pending interaction exceeds Web delivery budget; process stopped");
  }

  #startTextBlock(index: number): void {
    this.textBlockSerial++;
    this.activeTextBlockIndex = index;
    this.streamItemId = `live:${this.turnId}:assistant:${this.textBlockSerial}`;
    this.streamItemText = "";
    this.textBlocks.set(index, { id: this.streamItemId, text: "" });
  }

  #append(value: string): void {
    if (Buffer.byteLength(this.streamText) + Buffer.byteLength(value) > MAX_TEXT)
      throw new Error("Claude output exceeds 4 MiB");
    this.streamText += value;
    this.streamItemText += value;
    const block = this.textBlocks.get(this.activeTextBlockIndex);
    if (block) block.text += value;
  }

  /**
   * Main-thread frames only are tracked; a sub-agent's Bash call is recorded for display and an
   * unattributable frame is not looked at.
   */
  #observeBash(block: JsonObject, origin: FrameOrigin): void {
    if (!this.foregroundBashContract || block?.type !== "tool_use" || block.name !== "Bash") return;
    if (origin.kind === "unattributed") return;
    if (origin.kind === "subagent") {
      this.#observeSubagentBash(block, origin.spawner);
      return;
    }
    if (!this.initialized || this.status !== "running" || !this.turnId)
      throw new Error("Claude Bash outside current top-level turn");
    if (typeof block.id !== "string" || !block.id || Buffer.byteLength(block.id) > 256)
      throw new Error("invalid Claude Bash tool ID");
    if (this.bashToolIds.size >= 4096) throw new Error("too many Claude Bash tools");
    this.bashToolIds.add(block.id);
  }

  /**
   * A main-thread content frame while the session is idle is the CLI working on its own after the
   * turn AgentKib started has ended. The next `result` would then be booked as the result of a new
   * turn, so this stops at the first frame. Not after stop() or an idle retirement, which clear
   * `initialized`: the dying process may still flush frames.
   */
  #assertTurnActive(type: string): void {
    if (this.initialized && this.status === "idle")
      throw new ClaudeProtocolError(
        "claude-unrequested-turn",
        `Claude ${type} frame outside an active turn`,
      );
  }

  /**
   * What a sub-agent (or a frame that cannot be attributed) sends never reaches the main thread's
   * stream, usage, text or conversation items: only its Bash calls are recorded.
   */
  #observeOtherThread(frame: JsonObject, origin: FrameOrigin): void {
    if (origin.kind === "unattributed") {
      this.diagnostics.record("unattributedFrames", frame.type);
      return;
    }
    if (frame.type === "assistant" && Array.isArray(frame.message?.content)) {
      for (const block of frame.message.content) this.#observeBash(block, origin);
    } else if (frame.type === "stream_event" && frame.event?.type === "content_block_start") {
      this.#observeBash(frame.event.content_block, origin);
    }
  }

  /**
   * A Bash call made inside a sub-agent is the sub-agent's own tool call; the current turn only
   * sees the Agent call that spawned it. It is recorded for display and never tracked as a
   * foreground task of this turn, so it can neither end the session nor change what `result`
   * and stop require. A call that cannot be recorded is skipped, not rejected.
   */
  #observeSubagentBash(block: JsonObject, spawner: string): void {
    const id = block.id;
    if (typeof id !== "string" || !id || Buffer.byteLength(id) > 256) return;
    if (this.subagentBashToolIds.size >= 4096 && !this.subagentBashToolIds.has(id)) return;
    this.subagentBashToolIds.set(id, spawner);
  }

  /**
   * Observes the foreground Bash task lifecycle of a sub-agent and returns true, or returns false
   * for any other task frame, which then follows the main-thread rules unchanged. Only frames that
   * are positively a sub-agent's foreground local_bash task are taken: the CLI marks the owner
   * (`owned_by_subagent`, 2.1.285), and a Bash call first seen inside a sub-agent's frames is the
   * same fact when the flag is absent. A main-thread call or task is never reassigned, an explicit
   * contradiction falls back to the main-thread rules, and backgrounding keeps its meaning for
   * every Bash task: it would outlive the turn, so it still ends the session.
   */
  #observeSubagentTask(frame: JsonObject, subtype: string): boolean {
    const task = frame.task_id;
    if (typeof task !== "string" || !task || Buffer.byteLength(task) > 256) return false;
    if (subtype === "task_started") {
      const tool = frame.tool_use_id;
      if (
        frame.task_type !== "local_bash" ||
        frame.is_backgrounded !== false ||
        typeof tool !== "string" ||
        !tool ||
        Buffer.byteLength(tool) > 256 ||
        !(
          frame.owned_by_subagent === true ||
          (frame.owned_by_subagent == null && this.subagentBashToolIds.has(tool))
        ) ||
        this.bashToolIds.has(tool) ||
        this.foregroundTasks.has(task)
      )
        return false;
      if (this.subagentTasks.size < 4096 || this.subagentTasks.has(task))
        this.subagentTasks.set(task, tool);
      return true;
    }
    if (this.foregroundTasks.has(task) || !this.subagentTasks.has(task)) return false;
    if (subtype === "task_updated") {
      if (
        object(frame.patch) &&
        frame.patch.is_backgrounded !== undefined &&
        frame.patch.is_backgrounded !== false
      )
        throw new ClaudeProtocolError("claude-background-task", BACKGROUND_REFUSED);
      return true;
    }
    if (subtype === "task_notification") {
      if (this.subagentTasks.get(task) === frame.tool_use_id) this.subagentTasks.delete(task);
      return true;
    }
    return false;
  }

  /**
   * Task lifecycle frames. A sub-agent (`local_agent`) runs inside the CLI, so its task frames are
   * observed and change nothing; its tool calls still come through `can_use_tool`. A background
   * Bash command, or a task of any kind this version does not know, is an OS-level or unbounded
   * lifetime that the turn cannot supervise, so it stops the session with a stated reason.
   */
  #taskFrame(frame: JsonObject): boolean {
    const subtype = typeof frame.subtype === "string" ? frame.subtype : "";
    if (subtype === "background_tasks_changed") {
      this.#backgroundTasksChanged(frame);
      return false;
    }
    if (subtype === "task_started") return this.#taskStarted(frame);
    // task_updated and task_notification, with the contract on.
    if (this.#observeSubagentTask(frame, subtype)) return false;
    const task = frame.task_id;
    // A task this turn never saw start (an earlier process's task closed on resume, or a frame
    // outside a turn) has nothing to track: observe it.
    if (typeof task !== "string" || !this.foregroundTasks.has(task)) {
      this.diagnostics.record("observedTaskTypes", `untracked_${subtype}`);
      return false;
    }
    if (subtype === "task_updated") {
      if (!object(frame.patch)) throw new Error("unknown Claude foreground task");
      if (frame.patch.is_backgrounded !== undefined && frame.patch.is_backgrounded !== false)
        throw new ClaudeProtocolError("claude-background-task", BACKGROUND_REFUSED);
      if (
        frame.patch.status !== undefined &&
        !["pending", "running", "completed", "failed", "killed", "paused"].includes(
          frame.patch.status,
        )
      )
        throw new Error("invalid Claude task status");
      return true;
    }
    if (subtype === "task_notification") {
      if (
        this.foregroundTasks.get(task) !== frame.tool_use_id ||
        !["completed", "failed", "stopped"].includes(frame.status)
      )
        throw new Error("unverified Claude task completion");
      this.foregroundTasks.delete(task);
      return true;
    }
    throw new Error("unsupported Claude task update");
  }

  #taskStarted(frame: JsonObject): boolean {
    const type = frame.task_type;
    if (type === "local_agent") {
      this.diagnostics.record("observedTaskTypes", type);
      return false;
    }
    if (type !== "local_bash") {
      this.diagnostics.record("observedTaskTypes", type);
      throw new ClaudeProtocolError(
        "claude-background-task",
        this.foregroundBashContract ? UNVERIFIED_START : BACKGROUND_REFUSED,
      );
    }
    // Below 2.1.285 a Bash task frame cannot be told apart from a background one.
    if (!this.foregroundBashContract)
      throw new ClaudeProtocolError("claude-protocol-violation", BACKGROUND_REFUSED);
    if (this.#observeSubagentTask(frame, "task_started")) return false;
    if (
      !this.initialized ||
      !["running", "waiting-approval", "waiting-input"].includes(this.status)
    )
      throw new Error("Claude task outside active turn");
    const task = frame.task_id;
    if (typeof task !== "string" || !task || Buffer.byteLength(task) > 256)
      throw new Error("invalid Claude task ID");
    if (frame.is_backgrounded !== false)
      throw new ClaudeProtocolError("claude-background-task", UNVERIFIED_START);
    const tool = frame.tool_use_id;
    if (
      frame.owned_by_subagent === true ||
      typeof tool !== "string" ||
      !this.bashToolIds.has(tool) ||
      this.foregroundTasks.size >= 4096 ||
      this.foregroundTasks.has(task) ||
      [...this.foregroundTasks.values()].includes(tool)
    )
      throw new Error(UNVERIFIED_START);
    this.foregroundTasks.set(task, tool);
    return true;
  }

  #backgroundTasksChanged(frame: JsonObject): void {
    const tasks = frame.tasks;
    if (!Array.isArray(tasks))
      throw new ClaudeProtocolError("claude-protocol-violation", BACKGROUND_REFUSED);
    // The list is the full live set, replaced each time. An empty one means nothing runs.
    let supervised = true;
    for (const member of tasks) {
      const type = object(member) ? member.task_type : undefined;
      this.diagnostics.record("observedTaskTypes", type);
      if (type !== "local_agent") supervised = false;
    }
    if (!supervised) throw new ClaudeProtocolError("claude-background-task", BACKGROUND_REFUSED);
  }
}

type ClaudeProcessTree = { terminate(child: ChildProcess): Promise<void> };
type RunnerLease = { release: () => void };

class UnixProcessGroup implements ClaudeProcessTree {
  constructor(readonly processGroupId: number) {}

  static attach(child: ChildProcess): UnixProcessGroup {
    if (!child.pid) throw new Error("owned process has no PID");
    return new UnixProcessGroup(child.pid);
  }

  async terminate(child: ChildProcess): Promise<void> {
    let failure: unknown;
    try {
      process.kill(-this.processGroupId, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure = error;
    }
    try {
      child.kill("SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("close", onClose);
          reject(new Error("owned process group exit unconfirmed"));
        }, 2000);
        const onClose = () => {
          clearTimeout(timer);
          resolve();
        };
        child.once("close", onClose);
      }).catch((error: unknown) => {
        failure ??= error;
      });
    }
    if (failure) throw failure;
  }
}

/** Persistent Claude CLI stream-json process with an owned-process-tree fence. */
export class ClaudeManagedRunnerProcess {
  readonly state: ClaudeRunnerState;
  #child?: ChildProcess;
  #tree?: ClaudeProcessTree;
  #lease?: RunnerLease;
  #stopping = false;
  #terminating?: Promise<void>;
  #retiring = false;
  #closed = false;
  #initializing?: Promise<void>;
  #resolveInitialization?: () => void;
  #rejectInitialization?: (error: Error) => void;
  #initializationTimer?: NodeJS.Timeout;
  #fragments: Buffer[] = [];
  #bufferLength = 0;
  #frameChain: Promise<void> = Promise.resolve();
  #queuedFrames = 0;
  #writeCount = 0;
  #cleanupError: string | null = null;
  #fresh: boolean;
  #intentional = new WeakSet<ChildProcess>();
  #serializedTail: Promise<void> = Promise.resolve();
  #pendingDispatch?: () => void;
  #startupFailure?: { code: ClaudeStartupFailureCode; reason: string };
  #startupRecoveryBlocked = false;
  #startupAttempt = false;
  #startupDispatched = false;
  #startupCleanupKind?: ClaudeStartupCleanupKind;
  #toolItems = new Map<string, Record<string, unknown>>();
  /** Compact tool_use inputs kept until their result arrives. */
  #toolInputs = new Map<string, unknown>();
  #controls = new Map<
    string,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  #models: ClaudeModelOption[] = [];
  #commands: ClaudeRunnerOptionsSnapshot["commands"] = [];
  // Only explicit selections are relaunched; observing a host default does not select it.
  #settings: ClaudeRunnerEffectiveSettings;
  #effectiveSettings: ClaudeRunnerEffectiveSettings = {
    model: null,
    effort: null,
    permissionMode: null,
  };
  #settingsAcknowledged = false;
  // What the CLI says it runs in (null until the current worker reports). Kept apart from
  // #settings, which records only explicit selections and is what a relaunch replays.
  #observedPermissionMode: ClaudeObservedPermissionMode | null = null;
  #configuring = false;
  #steeringIds = new Set<string>();
  #reportedResult?: ClaudeRunnerTerminalResult;
  /** The current turn's last native agent message, which carries the turn end when it comes. */
  #lastAgentItem: Record<string, unknown> | null = null;

  constructor(
    readonly workspace: string,
    readonly sessionId: string,
    fresh: boolean,
    revision: number,
    readonly environment: NodeJS.ProcessEnv,
    readonly onSnapshot: (snapshot: ClaudeRunnerSnapshot) => void,
    foregroundBashContract = false,
    readonly onConversationEvent?: (
      type: "text-delta" | "item-upsert" | "item-alias" | "snapshot",
      payload: Record<string, unknown>,
      live: ClaudeRunnerSnapshot,
    ) => void,
    readonly options: ClaudeRunnerOptions = {},
  ) {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("managed Claude process groups require Unix");
    this.state = new ClaudeRunnerState(sessionId);
    this.state.revision = revision;
    this.state.foregroundBashContract = foregroundBashContract;
    this.#fresh = fresh;
    this.#settings = {
      model: options.model ?? null,
      effort: options.effort ?? null,
      permissionMode: options.permissionMode ?? null,
    };
    validateRunnerSettings(this.#settings);
    if (
      options.forkSourceNativeId !== undefined &&
      (!uuidPattern.test(options.forkSourceNativeId) ||
        !uuidPattern.test(sessionId) ||
        options.forkSourceNativeId === sessionId ||
        !fresh)
    )
      throw new Error("invalid Claude fork source");
    if (
      options.forkCutoff !== undefined &&
      (!options.forkSourceNativeId || !uuidPattern.test(options.forkCutoff))
    )
      throw new Error("invalid Claude fork cutoff");
    if (
      options.controlTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.controlTimeoutMs) ||
        options.controlTimeoutMs < 1 ||
        options.controlTimeoutMs > 30_000)
    )
      throw new Error("invalid Claude control timeout");
  }

  snapshot(): ClaudeRunnerSnapshot {
    return this.state.snapshot();
  }

  /** Catalog polling needs only protocol state, without cloning or truncating response text. */
  get status(): string {
    return this.state.status;
  }

  get optionsSnapshot(): ClaudeRunnerOptionsSnapshot {
    return structuredClone({
      models: this.#models,
      commands: this.#commands,
      settings: this.#effectiveSettings,
      settingsAcknowledged: this.#settingsAcknowledged && this.state.initialized,
    });
  }

  /**
   * The permission mode the current worker reported, or null while none has. This is a getter,
   * not part of optionsSnapshot: snapshots clone the model and command catalogs, and the host
   * reads this on every CLI frame.
   */
  get observedPermissionMode(): ClaudeObservedPermissionMode | null {
    return this.#observedPermissionMode;
  }

  /** Presentation only. Internal snapshots and the ledger remain fenced during cleanup. */
  get startupPending(): boolean {
    return this.#startupAttempt && !this.#startupDispatched && !this.#startupRecoveryBlocked;
  }

  /** Discover capabilities with initialize only: never enqueue a user/model turn. */
  async prepare(executable: string): Promise<ClaudeRunnerOptionsSnapshot> {
    if (this.#retiring || this.state.status !== "idle" || this.#configuring)
      throw new Error("Claude runner cannot prepare while busy");
    if (this.#child) {
      await this.#initializing;
      return this.optionsSnapshot;
    }
    if (this.options.beforeStart) await this.options.beforeStart();
    if (this.#retiring || this.state.status !== "idle" || this.#configuring)
      throw new Error("Claude runner cannot prepare while busy");
    if (this.#child) {
      await this.#initializing;
      return this.optionsSnapshot;
    }
    const checkpoint = this.state.checkpoint();
    const init = this.state.initialize();
    let started: ChildProcess | undefined;
    this.#startupAttempt = true;
    try {
      started = this.#start(executable);
      try {
        await this.#write(init);
      } catch (error) {
        this.#fail(errorMessage(error), undefined, "initialize-write-failed");
        throw error;
      }
      await this.#initializing;
      return this.optionsSnapshot;
    } catch (error) {
      if (!started?.pid && !this.processId && !this.#cleanupError) {
        this.state.restoreStartup(checkpoint, errorMessage(error));
        this.#notify();
      } else if (this.#startupFailure && !this.#startupRecoveryBlocked) {
        // Capability discovery dispatches neither a user turn nor a setting mutation. Only
        // a recognized startup failure and a confirmed owned-tree cleanup permit retry.
        const failure = this.#startupFailure;
        try {
          await this.#terminate();
          if (this.processId || this.#cleanupError)
            throw new Error("Claude process cleanup unconfirmed");
          if (this.#startupCleanupKind !== "mac-owned-process-tree") throw error;
          this.state.restoreStartup(checkpoint, failure.reason);
          this.#notify();
        } catch (cleanupError) {
          this.#fail(errorMessage(cleanupError));
          throw cleanupError;
        }
      } else this.#fail(errorMessage(error));
      throw error;
    } finally {
      this.#startupAttempt = false;
    }
  }

  /** Only allow the three session-scoped settings; never persist user configuration. */
  async configure(
    settings: Partial<ClaudeRunnerSettings>,
    revision: number,
  ): Promise<ClaudeRunnerOptionsSnapshot> {
    if (this.state.revision !== revision) throw new Error("stale Claude revision");
    if (
      !this.#child ||
      !this.state.initialized ||
      this.state.status !== "idle" ||
      this.state.activity === "compacting" ||
      this.#configuring ||
      this.#retiring
    )
      throw new Error("Claude settings require an idle prepared session");
    if (Object.keys(settings).some((key) => !["model", "effort", "permissionMode"].includes(key)))
      throw new Error("unsupported Claude setting");
    if (settings.permissionMode !== undefined && !isPermissionMode(settings.permissionMode))
      throw new Error("unsupported Claude permission mode");
    const next = { ...this.#settings, ...settings };
    validateRunnerSettings(next);
    if (
      next.model !== null &&
      settings.model !== undefined &&
      !this.#models.some((entry) => entry.value === next.model)
    )
      throw new Error("unsupported Claude model");
    const modelId = next.model ?? this.#effectiveSettings.model;
    const model = this.#models.find(
      (entry) => entry.value === modelId || entry.resolvedModel === modelId,
    );
    if (
      settings.effort !== undefined &&
      next.effort !== null &&
      !model?.supportedEffortLevels?.includes(next.effort)
    )
      throw new Error("unsupported Claude effort");
    this.#configuring = true;
    this.#settingsAcknowledged = false;
    try {
      if (settings.model !== undefined)
        await this.#requestControl({ subtype: "set_model", model: next.model ?? "default" });
      if (settings.effort !== undefined)
        await this.#requestControl({
          subtype: "apply_flag_settings",
          settings: { effortLevel: next.effort },
        });
      if (settings.permissionMode !== undefined)
        await this.#requestControl({ subtype: "set_permission_mode", mode: next.permissionMode });
      this.#settings = next;
      this.#effectiveSettings = { ...this.#effectiveSettings, ...settings };
      // The CLI acknowledged the change, so this is the mode it now runs in.
      if (settings.permissionMode !== undefined) this.#observePermission(settings.permissionMode);
      this.#settingsAcknowledged = true;
      this.state.revision++;
      this.#notify();
      return this.optionsSnapshot;
    } catch (error) {
      // A partial or lost acknowledgement cannot be represented as the old effective settings.
      this.#fail(`Claude settings unconfirmed: ${errorMessage(error)}`);
      throw error;
    } finally {
      this.#configuring = false;
    }
  }

  async steer(
    content: unknown,
    requestId: string,
    turnId: string,
    revision: number,
    beforeDispatch?: () => void,
  ): Promise<void> {
    if (!this.#child || this.#retiring || this.#configuring || this.#steeringIds.has(requestId))
      throw new Error("Claude steering unavailable or already dispatched");
    const user = this.state.steer(content, requestId, turnId, revision);
    // The serialized write guard rechecks the turn after any preceding writes/frames.
    this.#steeringIds.add(requestId);
    let dispatched = false;
    try {
      await this.#write(user, () => {
        this.state.steer(content, requestId, turnId, revision);
        beforeDispatch?.();
        dispatched = true;
      });
      this.state.revision++;
      this.#notify();
    } catch (error) {
      if (!dispatched) {
        this.#steeringIds.delete(requestId);
        throw error;
      }
      this.#fail(`Claude steering write failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  /** What was ignored or refused so far, by category. Counts only; for diagnostics and tests. */
  get protocolDiagnostics() {
    return this.state.diagnostics.snapshot();
  }

  get hasWorker(): boolean {
    return this.#child !== undefined;
  }

  get processId(): number | null {
    return this.#child?.pid ?? null;
  }

  get isRetiring(): boolean {
    return this.#retiring;
  }

  retireIfInactive(): Promise<boolean> | null {
    if (
      !this.#child ||
      this.#retiring ||
      this.#configuring ||
      this.state.status !== "idle" ||
      this.state.activity === "compacting"
    )
      return null;
    this.#retiring = true;
    return (async () => {
      try {
        await this.shutdown();
        this.state.initialized = false;
        this.state.initId = "";
        this.state.seenRequests.clear();
        this.state.bashToolIds.clear();
        this.state.foregroundTasks.clear();
        this.state.subagentBashToolIds.clear();
        this.state.subagentTasks.clear();
        this.state.contextUsage = {
          ...this.state.contextUsage,
          state: this.state.contextUsage.available ? "stale" : "unavailable",
          reason: "connection-unavailable",
        };
        this.state.revision++;
        this.#notify();
        return true;
      } finally {
        this.#retiring = false;
      }
    })();
  }

  async send(
    executable: string,
    content: unknown,
    requestId: string,
    revision: number,
    beforeDispatch?: () => void,
  ): Promise<void> {
    if (this.#retiring || this.#configuring)
      throw new Error("Claude runner is being retired or configured");
    if (!this.#child && this.options.beforeStart) await this.options.beforeStart();
    if (this.#retiring || this.#configuring)
      throw new Error("Claude runner is being retired or configured");
    const checkpoint = this.state.checkpoint();
    if (this.state.revision !== revision) throw new Error("stale Claude revision");
    if (this.#child && !this.state.initialized) throw new Error("Claude initialize is incomplete");
    const user = this.state.begin(content, requestId);
    this.#steeringIds.clear();
    this.#lastAgentItem = null;
    // The ledger callback may be absent, or may throw before dispatch. Neither the callback's
    // presence nor its later removal proves whether the user frame reached stdin.
    let dispatched = false;
    this.#pendingDispatch = () => {
      beforeDispatch?.();
      dispatched = true;
      this.#startupDispatched = true;
    };
    if (this.#child) {
      try {
        await this.#write(user);
        this.#fresh = false;
      } catch (error) {
        if (error instanceof ClaudeUndispatchedError) {
          this.#pendingDispatch = undefined;
          this.state.restoreUndispatched(checkpoint);
          this.#notify();
          throw error;
        }
        this.#fail(`Claude user write failed: ${errorMessage(error)}`);
        throw error;
      }
      return;
    }
    const init = this.state.initialize(user);
    let started: ChildProcess | undefined;
    this.#startupAttempt = true;
    try {
      started = this.#start(executable);
      try {
        await this.#write(init);
      } catch (error) {
        this.#fail(errorMessage(error), undefined, "initialize-write-failed");
        throw error;
      }
      await this.#initializing;
      this.#fresh = false;
    } catch (error) {
      if (error instanceof ClaudeUndispatchedError) {
        this.#pendingDispatch = undefined;
        this.state.restoreUndispatched(checkpoint);
        this.#notify();
        throw error;
      }
      const failure =
        this.#startupFailure ??
        (!started?.pid && !this.processId && !this.#cleanupError
          ? { code: "process-start-failed" as const, reason: errorMessage(error) }
          : undefined);
      // Capture this before cleanup: an absent root afterward cannot prove no process started.
      const neverStarted = !started?.pid && !this.processId && !this.#cleanupError;
      if (!dispatched && failure && !this.#startupRecoveryBlocked) {
        try {
          if (this.state.status !== "outcome-unknown")
            this.#fail(failure.reason, undefined, failure.code);
          await this.#terminate();
          const cleanupKind = neverStarted ? "not-started" : this.#startupCleanupKind;
          if (this.#child || this.#cleanupError)
            throw new Error("Claude process cleanup unconfirmed");
          if (!cleanupKind) throw error;
          this.options.onUndispatchedStartup?.({
            requestId,
            code: failure.code,
            cleanupKind,
            failedRevision: this.state.revision,
            checkpoint: { revision: checkpoint.revision, turnId: checkpoint.turnId },
          });
        } catch (cleanupError) {
          this.#fail(errorMessage(cleanupError));
          throw cleanupError;
        }
        this.#pendingDispatch = undefined;
        this.state.restoreStartup(checkpoint, failure.reason);
        this.#notify();
        if (this.state.status === "idle") throw new ClaudeUndispatchedError(failure.reason);
      } else {
        this.#fail(errorMessage(error));
      }
      throw error;
    } finally {
      this.#startupAttempt = false;
    }
  }

  async approve(
    requestId: unknown,
    turnId: string,
    decision: string,
    revision: number,
  ): Promise<void> {
    const response = this.state.approve(requestId, turnId, decision, revision);
    await this.#writeInteraction(response);
  }

  async answer(
    requestId: unknown,
    turnId: string,
    answers: unknown,
    revision: number,
  ): Promise<void> {
    const response = this.state.answer(requestId, turnId, answers, revision);
    await this.#writeInteraction(response);
  }

  async stop(turnId: string, revision: number): Promise<void> {
    this.state.assertCanStop(turnId, revision);
    if (!this.#child) throw new Error("Claude session has not started");
    await this.#terminate();
    this.state.stop(turnId, revision);
    this.#notify();
  }

  async shutdown(): Promise<void> {
    if (!this.#child) return;
    await this.#terminate();
  }

  get cleanupError(): string | null {
    return this.#cleanupError;
  }

  #start(executable: string): ChildProcess {
    if (this.#child) throw new Error("Claude runner already started");
    this.#startupFailure = undefined;
    this.#startupRecoveryBlocked = false;
    this.#startupDispatched = false;
    this.#startupCleanupKind = undefined;
    this.#acquireLease();
    this.#effectiveSettings = { model: null, effort: null, permissionMode: null };
    this.#observedPermissionMode = null;
    let child: ChildProcess;
    try {
      child = spawn(
        executable,
        [
          ...(this.#fresh && this.options.forkSourceNativeId
            ? [
                `--resume=${this.options.forkSourceNativeId}`,
                "--fork-session",
                `--session-id=${this.sessionId}`,
                ...(this.options.forkCutoff
                  ? [`--resume-session-at=${this.options.forkCutoff}`]
                  : []),
              ]
            : [`${this.#fresh ? "--session-id" : "--resume"}=${this.sessionId}`]),
          "--print",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          "--permission-prompts",
          "host",
          "--permission-prompt-tool",
          "stdio",
          ...(this.#settings.model ? ["--model", this.#settings.model] : []),
          ...(this.#settings.effort ? ["--effort", this.#settings.effort] : []),
          ...(this.#settings.permissionMode !== null
            ? ["--permission-mode", this.#settings.permissionMode]
            : []),
          ...(this.options.mcpConfig
            ? ["--mcp-config", JSON.stringify(this.options.mcpConfig)]
            : []),
        ],
        {
          cwd: this.workspace,
          // Background work (Bash run_in_background, background sub-agents) outlives the turn
          // AgentKib starts and makes the CLI start turns of its own, which a managed session
          // cannot follow. Turn it off at the source, over whatever the user's environment says.
          env: { ...this.environment, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
          detached: true,
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        },
      );
    } catch (error) {
      this.#releaseLease();
      throw error;
    }
    this.#child = child;
    try {
      this.#tree =
        process.platform === "darwin"
          ? MacOwnedProcessTree.attach(child)
          : UnixProcessGroup.attach(child);
    } catch (error) {
      // A failed spawn has no process identity or descendants. A running root whose tree
      // could not be captured must retain its lease and unknown-state protection.
      child.once("error", () => undefined);
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      if (!child.pid) {
        this.#child = undefined;
        this.#releaseLease();
      } else {
        this.#cleanupError = errorMessage(error);
        this.#fail(`Claude process cleanup unconfirmed: ${this.#cleanupError}`);
      }
      throw error;
    }
    this.#initializing = new Promise<void>((resolve, reject) => {
      this.#resolveInitialization = resolve;
      this.#rejectInitialization = reject;
      this.#initializationTimer = setTimeout(() => {
        const error = new Error("Claude initialize timed out");
        this.#rejectInitialization?.(error);
        this.#fail(error.message, undefined, "initialize-timeout");
      }, this.options.controlTimeoutMs ?? 30_000);
      this.#resolveInitialization = () => {
        if (this.#initializationTimer) clearTimeout(this.#initializationTimer);
        this.#initializationTimer = undefined;
        resolve();
      };
      this.#rejectInitialization = (error) => {
        if (this.#initializationTimer) clearTimeout(this.#initializationTimer);
        this.#initializationTimer = undefined;
        reject(error);
      };
    });
    // A process can fail while stdin's first write is still pending.
    void this.#initializing.catch(() => undefined);
    child.stdout?.on("data", (chunk: Buffer) => this.#data(child, chunk));
    child.stdout?.on("end", () => {
      if (!this.#acceptsFrames(child)) return;
      if (this.#bufferLength) {
        const final = Buffer.concat(this.#fragments, this.#bufferLength);
        this.#fragments = [];
        this.#bufferLength = 0;
        this.#enqueueFrame(child, final);
      }
      void this.#frameChain.finally(() => {
        if (this.#acceptsFrames(child))
          this.#fail("Claude stream closed", undefined, "stream-closed");
      });
    });
    child.stdin?.on("error", (error) => {
      if (!this.#acceptsFrames(child)) return;
      this.#fail("Claude stdin write failed", undefined, "initialize-write-failed");
      this.#rejectInitialization?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("error", (error) => {
      if (!this.#acceptsFrames(child)) return;
      this.#rejectInitialization?.(error);
      this.#fail(error.message, undefined, "process-start-failed");
    });
    child.on("close", (code) => {
      if (this.#acceptsFrames(child))
        this.#fail(`Claude process exited (${code ?? "unknown"})`, undefined, "process-exited");
    });
    return child;
  }

  #acquireLease(): void {
    const home = this.environment.HOME ?? homedir();
    const dataHome =
      process.platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : this.environment.XDG_DATA_HOME && path.isAbsolute(this.environment.XDG_DATA_HOME)
          ? this.environment.XDG_DATA_HOME
          : path.join(home, ".local", "share");
    const directory = path.join(dataHome, "agentkib", "claude-runner-locks");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const lockPath = path.join(directory, `${this.sessionId}.lock`);
    try {
      const release = acquirePortableFileLease(lockPath);
      this.#lease = { release };
    } catch (error) {
      if (error instanceof Error && error.message === "session-managed-by-another-runtime")
        throw new Error("Claude session is managed by another process");
      throw error;
    }
  }

  #releaseLease(): void {
    const lease = this.#lease;
    if (!lease) return;
    this.#lease = undefined;
    lease.release();
  }

  #acceptsFrames(child: ChildProcess): boolean {
    return (
      child === this.#child &&
      !this.#closed &&
      !this.#intentional.has(child) &&
      this.state.status !== "outcome-unknown"
    );
  }

  #data(child: ChildProcess, chunk: Buffer): void {
    if (!this.#acceptsFrames(child)) return;
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      if (newline < 0) {
        const fragment = chunk.subarray(offset);
        this.#fragments.push(Buffer.from(fragment));
        this.#bufferLength += fragment.length;
        if (this.#bufferLength > MAX_LINE) {
          this.#fail("Claude frame exceeds 25 MiB", "claude-protocol-violation");
          return;
        }
        break;
      }
      const fragment = chunk.subarray(offset, newline);
      const parts = this.#fragments.concat(fragment.length ? [fragment] : []);
      const size = this.#bufferLength + fragment.length;
      const line =
        parts.length > 1 ? Buffer.concat(parts, size) : Buffer.from(parts[0] ?? Buffer.alloc(0));
      this.#fragments = [];
      this.#bufferLength = 0;
      if (line.length + 1 > MAX_LINE) {
        this.#fail("Claude frame exceeds 25 MiB", "claude-protocol-violation");
        return;
      }
      this.#enqueueFrame(child, line);
      offset = newline + 1;
    }
  }

  #enqueueFrame(child: ChildProcess, line: Buffer): void {
    this.#queuedFrames++;
    if (this.#queuedFrames >= 32) child.stdout?.pause();
    this.#frameChain = this.#frameChain
      .then(async () => {
        // A chunk can queue multiple frames before one fails. Killing the process does not
        // remove that queued work, and an old process must never update its replacement.
        if (!this.#acceptsFrames(child)) return;
        const frame = inbound(() => parseClaudeFrame(line));
        if (frame.session_id !== undefined && frame.session_id !== this.sessionId)
          throw new ClaudeProtocolError(
            "claude-protocol-violation",
            "Claude session ID changed unexpectedly",
          );
        if (frame.type === "control_response" && frame.response?.request_id !== this.state.initId) {
          inbound(() => this.#controlResponse(frame));
          return;
        }
        const wasInitialized = this.state.initialized;
        const previousItemId = this.state.streamItemId;
        const previousItemText = this.state.streamItemText;
        const origin = frameOrigin(frame);
        let response: JsonObject | null;
        try {
          response = inbound(() => this.state.frame(frame));
        } finally {
          this.#logDiagnostics();
          const result = this.state.terminalResult;
          if (result && result !== this.#reportedResult) {
            this.#reportedResult = result;
            this.options.onResult?.(structuredClone(result));
            this.#emitTurnEnd(frame, result);
          }
        }
        if (!wasInitialized && this.state.initialized) {
          inbound(() => this.#discoverOptions(frame.response?.response));
          // Initialization confirms explicit launch options, never inherited host defaults.
          this.#effectiveSettings = {
            model: this.#effectiveSettings.model ?? this.#settings.model,
            effort: this.#effectiveSettings.effort ?? this.#settings.effort,
            // A mode the CLI already reported (system/init can precede this response) wins
            // over the launch selection, including an unselectable one that left this null.
            permissionMode:
              this.#observedPermissionMode !== null
                ? this.#effectiveSettings.permissionMode
                : (this.#effectiveSettings.permissionMode ?? this.#settings.permissionMode),
          };
          this.#settingsAcknowledged = true;
        }
        if (frame.type === "system" && frame.subtype === "init") {
          if (shortString(frame.model, 256)) this.#effectiveSettings.model = frame.model;
        }
        if (frame.type === "system" && (frame.subtype === "init" || frame.subtype === "status")) {
          // Unknown or malformed values are ignored: observing never ends the process.
          const mode = normalizeObservedPermissionMode(frame.permissionMode);
          if (mode !== null) this.#observePermission(mode);
        }
        if (frame.type === "system" && frame.subtype === "commands_changed")
          this.#commands = projectCommands(frame.commands);
        const live = this.state.snapshot();
        const itemId = this.state.streamItemId;
        const itemText = this.state.streamItemText;
        const conversationItems = this.#conversationItems(frame);
        const hasFinalizedText = this.state.finalizedTextBlocks.length > 0;
        if (frame.type === "assistant" && hasFinalizedText) {
          const ordered = [
            ...this.state.finalizedTextBlocks.map((block) => {
              const clipped = truncateUtf8(block.text);
              return {
                index: block.index,
                previousId: block.temporaryId,
                item: {
                  id: block.id,
                  kind: "agent-message",
                  turn_id: this.state.turnId,
                  content: clipped.content,
                  attachment_count: 0,
                  truncated: clipped.truncated,
                  ephemeral: false,
                } satisfies Record<string, unknown>,
              };
            }),
            ...conversationItems.map(({ index, item }) => ({ index, previousId: "", item })),
          ].sort((left, right) => left.index - right.index);
          this.#emit(
            "snapshot",
            {
              items: ordered.map(({ item }) => item),
              replaceItemIds: [
                ...ordered.flatMap(({ previousId, item }) =>
                  previousId ? [previousId, String(item.id)] : [String(item.id)],
                ),
              ],
              completeItems: false,
            },
            live,
          );
        } else {
          for (const block of this.state.finalizedTextBlocks) {
            const clipped = truncateUtf8(block.text);
            if (block.temporaryId && block.temporaryId !== block.id)
              this.#emit("item-alias", { previousId: block.temporaryId, itemId: block.id }, live);
            this.#emit(
              "item-upsert",
              {
                id: block.id,
                kind: "agent-message",
                turn_id: this.state.turnId,
                content: clipped.content,
                attachment_count: 0,
                truncated: clipped.truncated,
                ephemeral: false,
              },
              live,
            );
          }
          for (const item of conversationItems) this.#emit("item-upsert", item.item, live);
        }
        if (
          itemId &&
          itemId === previousItemId &&
          itemText.startsWith(previousItemText) &&
          itemText.length > previousItemText.length
        ) {
          this.#emit(
            "text-delta",
            {
              itemId,
              turnId: this.state.turnId,
              text: itemText.slice(previousItemText.length),
              offset: previousItemText.length,
              ephemeral: itemId.startsWith("live:"),
            },
            live,
          );
        }
        if (
          frame.type === "assistant" &&
          origin.kind === "main" &&
          !this.state.finalizedTextBlocks.length &&
          itemId &&
          itemText
        ) {
          this.#emit(
            "item-upsert",
            {
              id: itemId,
              kind: "agent-message",
              turn_id: this.state.turnId,
              content: itemText,
              attachment_count: 0,
              truncated: false,
              ephemeral: itemId.startsWith("live:"),
            },
            live,
          );
        }
        this.#notify();
        if (!wasInitialized && this.state.initialized) {
          if (response) await this.#write(response);
          if (!this.#acceptsFrames(child)) return;
          this.#resolveInitialization?.();
          this.#resolveInitialization = undefined;
          this.#rejectInitialization = undefined;
        } else if (response) {
          await this.#write(response);
        }
      })
      .catch((error: unknown) => {
        if (!this.#acceptsFrames(child)) return;
        if (error instanceof ClaudeUndispatchedError) {
          this.#rejectInitialization?.(error);
          return;
        }
        const reason = errorMessage(error);
        this.#fail(reason, error instanceof ClaudeProtocolError ? error.code : undefined);
        this.#rejectInitialization?.(error instanceof Error ? error : new Error(reason));
      })
      .finally(() => {
        this.#queuedFrames--;
        if (this.#queuedFrames < 16 && this.#acceptsFrames(child)) child.stdout?.resume();
      });
  }

  /** Every frame-path conversation event; the last native agent message is remembered. */
  #emit(
    type: "text-delta" | "item-upsert" | "item-alias" | "snapshot",
    payload: Record<string, unknown>,
    live: ClaudeRunnerSnapshot,
  ): void {
    const items =
      type === "snapshot" && Array.isArray(payload.items)
        ? (payload.items as Array<Record<string, unknown>>)
        : type === "item-upsert"
          ? [payload]
          : [];
    for (const item of items)
      if (
        item.kind === "agent-message" &&
        item.ephemeral !== true &&
        typeof item.id === "string" &&
        !item.id.startsWith("live:")
      )
        this.#lastAgentItem = { ...item };
    this.onConversationEvent?.(type, payload, live);
  }

  /**
   * Re-sends the turn's last agent message with the turn end, which history readers attach to the
   * same item (`turn_meta`). Only `result` carries the duration in print mode. Display only: a
   * turn without a native agent message gets none, and a failed delivery never changes the turn.
   */
  #emitTurnEnd(frame: JsonObject, result: ClaudeRunnerTerminalResult): void {
    const item = this.#lastAgentItem;
    if (frame.type !== "result" || !item || item.turn_id !== result.turnId) return;
    const meta: Record<string, unknown> = {
      outcome: frame.is_error === true ? "failed" : result.success ? "completed" : "aborted",
    };
    if (Number.isSafeInteger(frame.duration_ms) && frame.duration_ms >= 0)
      meta.duration_ms = frame.duration_ms;
    const ended = { ...item, turn_meta: meta };
    this.#lastAgentItem = null;
    try {
      this.onConversationEvent?.("item-upsert", ended, this.state.snapshot());
    } catch {
      // The turn already ended; its duration is presentation only.
    }
  }

  #conversationItems(frame: JsonObject): Array<{ index: number; item: Record<string, unknown> }> {
    const items: Array<{ index: number; item: Record<string, unknown> }> = [];
    const origin = frameOrigin(frame);
    // State ignores these frames; projecting their tools would still mutate the conversation.
    if (origin.kind === "unattributed") return items;
    const blocks = Array.isArray(frame.message?.content) ? frame.message.content : [];
    if (frame.type === "user") {
      // A sub-agent's first user frame is the prompt that drives it; it is not the user's message.
      const mainThread = origin.kind === "main";
      const id =
        (mainThread &&
          typeof frame.uuid === "string" &&
          uuidPattern.test(frame.uuid) &&
          frame.uuid) ||
        (mainThread &&
          typeof frame.message?.id === "string" &&
          uuidPattern.test(frame.message.id) &&
          frame.message.id) ||
        "";
      if (id && frame.isCompactSummary !== true) {
        const content = frame.message?.content;
        const text =
          typeof content === "string"
            ? content
            : blocks
                .filter((block: JsonObject) =>
                  ["text", "input_text", "output_text"].includes(String(block?.type)),
                )
                .map((block: JsonObject) => (typeof block.text === "string" ? block.text : ""))
                .filter(Boolean)
                .join("\n");
        const attachmentCount = blocks.filter((block: JsonObject) =>
          ["image", "document"].includes(String(block?.type)),
        ).length;
        if (text || attachmentCount)
          items.push({
            index: -1,
            item: {
              id,
              kind: "user-message",
              content: text,
              attachment_count: attachmentCount,
              truncated: false,
            },
          });
      }
      const results = blocks.filter((block: JsonObject) => block?.type === "tool_result").length;
      for (const block of blocks) {
        const toolId = typeof block?.tool_use_id === "string" ? block.tool_use_id : "";
        const item = toolId ? this.#toolItems.get(toolId) : undefined;
        if (block?.type === "tool_result" && item) {
          item.tool_status = block.is_error === true ? "failed" : "completed";
          // The structured result is unverified on this stream; it is used
          // only when present and only for a frame's sole tool result.
          const structured =
            results === 1 ? (frame.tool_use_result ?? frame.toolUseResult) : undefined;
          const detail = claudeToolDetail(
            typeof item.tool_name === "string" ? item.tool_name : "",
            this.#toolInputs.get(toolId),
            claudeToolResult(structured, block.content),
            { workspace: this.workspace },
          );
          if (detail) item.tool = detail;
          this.#toolInputs.delete(toolId);
          items.push({ index: blocks.indexOf(block), item: { ...item } });
        }
      }
    } else if (frame.type === "assistant") {
      for (const block of blocks) {
        const id = typeof block?.id === "string" ? block.id : "";
        if (block?.type !== "tool_use" || !id || id.length > 256) continue;
        if (this.#toolItems.size >= 1024 && !this.#toolItems.has(id)) continue;
        const item: Record<string, unknown> = {
          id,
          kind: "tool-summary",
          turn_id: this.state.turnId,
          tool_name: block.name,
          tool_status: "running",
          attachment_count: 0,
          truncated: false,
        };
        const detail = claudeToolDetail(
          typeof block.name === "string" ? block.name : "",
          block.input,
          undefined,
          { workspace: this.workspace },
        );
        if (detail) item.tool = detail;
        this.#toolItems.set(id, item);
        if (this.#toolInputs.size < 256) this.#toolInputs.set(id, compactClaudeInput(block.input));
        items.push({ index: blocks.indexOf(block), item });
      }
    }
    return items;
  }

  async #write(frame: JsonObject, beforeWrite?: () => void): Promise<void> {
    const child = this.#child;
    if (!child?.stdin || this.#closed) throw new Error("Claude worker unavailable");
    if (++this.#writeCount > 32) {
      this.#writeCount--;
      throw new Error("Claude stdin queue unavailable");
    }
    const data = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (data.length > MAX_LINE) {
      this.#writeCount--;
      throw new Error("Claude frame exceeds 25 MiB");
    }
    const previous = this.#serializedTail;
    let release!: () => void;
    this.#serializedTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      if (child !== this.#child || this.#closed)
        throw new Error("Claude worker changed before write");
      if (frame.type === "user" && this.state.activity === "compacting")
        throw new ClaudeUndispatchedError();
      beforeWrite?.();
      if (frame.type === "user") {
        this.#pendingDispatch?.();
        this.#pendingDispatch = undefined;
      }
      await new Promise<void>((resolve, reject) => {
        child.stdin!.write(data, (error) => (error ? reject(error) : resolve()));
      });
    } finally {
      this.#writeCount--;
      release();
    }
  }

  async #writeInteraction(frame: JsonObject): Promise<void> {
    try {
      await this.#write(frame);
    } catch (error) {
      this.#fail(`Claude control write failed: ${errorMessage(error)}`);
      throw error;
    }
  }

  /**
   * Record the mode the CLI runs in. A mode that cannot be selected clears the effective
   * selection, so `settings.current` never shows a stale plan or default beside an observed
   * auto mode. Must not throw: it runs on the frame path, where an error ends the session.
   */
  #observePermission(mode: ClaudeObservedPermissionMode): void {
    this.#observedPermissionMode = mode;
    this.#effectiveSettings.permissionMode = isPermissionMode(mode) ? mode : null;
  }

  #discoverOptions(value: unknown): void {
    if (value !== undefined && !object(value))
      throw new Error("invalid Claude initialization data");
    const payload = object(value) ? value : {};
    if (
      payload.models !== undefined &&
      (!Array.isArray(payload.models) || payload.models.length > 256)
    )
      throw new Error("invalid Claude model catalog");
    this.#models = (payload.models ?? []).map((entry: unknown) => {
      if (!object(entry) || !shortString(entry.value, 256) || !shortString(entry.displayName, 512))
        throw new Error("invalid Claude model option");
      if (entry.resolvedModel !== undefined && !shortString(entry.resolvedModel, 256))
        throw new Error("invalid Claude resolved model");
      const levels = entry.supportedEffortLevels;
      if (
        levels !== undefined &&
        (!Array.isArray(levels) ||
          levels.length > 5 ||
          levels.some((level: unknown) => !effortLevels.includes(level as ClaudeEffort)))
      )
        throw new Error("invalid Claude model effort options");
      return {
        value: entry.value,
        ...(entry.resolvedModel !== undefined ? { resolvedModel: entry.resolvedModel } : {}),
        displayName: entry.displayName,
        ...(shortString(entry.description, 4096) ? { description: entry.description } : {}),
        ...(levels ? { supportedEffortLevels: [...new Set(levels)] as ClaudeEffort[] } : {}),
      };
    });
    this.#commands = projectCommands(payload.commands);
  }

  async #requestControl(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#child || !this.state.initialized || this.#controls.size >= 8)
      throw new Error("Claude control unavailable");
    const requestId = randomUUID();
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#controls.delete(requestId);
        const error = new Error("Claude control acknowledgement timed out");
        reject(error);
        this.#fail(error.message);
      }, this.options.controlTimeoutMs ?? 30_000);
      this.#controls.set(requestId, { resolve, reject, timer });
    });
    // Observe early transport failures even when the pipe write has not settled.
    void response.catch(() => undefined);
    try {
      await this.#write({ type: "control_request", request_id: requestId, request });
      return await response;
    } catch (error) {
      const pending = this.#controls.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.#controls.delete(requestId);
        pending.reject(error instanceof Error ? error : new Error(errorMessage(error)));
      }
      throw error;
    }
  }

  #controlResponse(frame: JsonObject): void {
    const response = frame.response;
    const requestId = response?.request_id;
    const pending = typeof requestId === "string" ? this.#controls.get(requestId) : undefined;
    if (!pending) throw new Error("unexpected Claude control response");
    this.#controls.delete(requestId);
    clearTimeout(pending.timer);
    if (response.subtype !== "success") {
      pending.reject(new Error("Claude control request rejected"));
      return;
    }
    if (response.response !== undefined && !object(response.response)) {
      pending.reject(new Error("invalid Claude control acknowledgement"));
      return;
    }
    pending.resolve(response.response ?? {});
  }

  #rejectControls(error: Error): void {
    for (const pending of this.#controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#controls.clear();
  }

  #notify(): void {
    try {
      this.onSnapshot(this.state.snapshot());
    } catch (error) {
      if (this.state.status !== "outcome-unknown") {
        this.state.fail(errorMessage(error));
        void this.#killOnFailure();
      }
    }
  }

  /** The CLI's version number when it is newer than the version managed sessions were verified through. */
  #versionNumber(): string | null {
    return /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(this.options.cliVersion ?? "")?.[1] ?? null;
  }

  #logDiagnostics(): void {
    try {
      const version = this.#versionNumber();
      for (const { label, key } of this.state.diagnostics.takeNew())
        console.warn(
          `Claude Code protocol: ${label} "${key}"${version ? ` (Claude Code ${version})` : ""}`,
        );
    } catch {
      // A log line must never change what happens to the frame.
    }
  }

  /**
   * `code` marks a reason AgentKib can explain to the user; the stored reason is then
   * `<code>: <detail>` and the UI shows the explanation. Other failures keep their plain text.
   */
  #fail(
    reason: string,
    code?: ClaudeTerminationCode,
    startupCode?: ClaudeStartupFailureCode,
  ): void {
    if (startupCode && !this.#startupRecoveryBlocked) {
      this.#startupFailure ??= { code: startupCode, reason };
    } else if (!startupCode) this.#startupRecoveryBlocked = true;
    this.#settingsAcknowledged = false;
    // A failed process no longer runs in any mode; the next worker reports its own.
    this.#observedPermissionMode = null;
    this.#effectiveSettings.permissionMode = null;
    this.#rejectControls(new Error(reason));
    if (this.state.status !== "outcome-unknown")
      this.state.fail(
        code
          ? formatTermination(
              code,
              reason,
              isNewerThanVerified(this.options.cliVersion)
                ? {
                    version: this.#versionNumber()!,
                    verified: CLAUDE_MANAGED_VERIFIED_THROUGH,
                  }
                : undefined,
            )
          : reason,
      );
    this.#notify();
    this.#rejectInitialization?.(new Error(reason));
    void this.#killOnFailure();
  }

  async #killOnFailure(): Promise<void> {
    if (!this.#child || this.#stopping || this.#cleanupError) return;
    try {
      await this.#terminate();
    } catch (error) {
      this.#cleanupError = errorMessage(error);
      if (this.state.status !== "outcome-unknown")
        this.state.fail(`Claude process cleanup unconfirmed: ${this.#cleanupError}`);
      this.#notify();
    }
  }

  async #terminate(): Promise<void> {
    // Failure cleanup and host shutdown can arrive together for the same owned process tree.
    if (this.#terminating) return this.#terminating;
    const terminating = this.#terminateWorker();
    this.#terminating = terminating;
    try {
      await terminating;
    } finally {
      if (this.#terminating === terminating) this.#terminating = undefined;
    }
  }

  async #terminateWorker(): Promise<void> {
    const child = this.#child;
    const tree = this.#tree;
    if (!child) return;
    if (!tree)
      throw new Error(
        `Claude process cleanup unconfirmed: ${this.#cleanupError ?? "missing owned tree"}`,
      );
    this.#stopping = true;
    this.#closed = true;
    this.#intentional.add(child);
    this.#settingsAcknowledged = false;
    this.#rejectControls(new Error("Claude worker stopped before control acknowledgement"));
    this.#rejectInitialization?.(new Error("Claude worker stopped before initialization"));
    try {
      await tree.terminate(child);
      // A Unix process-group signal does not cover children that created another group.
      // Only the owned-tree supervisor confirms all captured descendants have ended.
      this.#startupCleanupKind =
        tree instanceof MacOwnedProcessTree ? "mac-owned-process-tree" : undefined;
      this.#child = undefined;
      this.#tree = undefined;
      this.#fragments = [];
      this.#bufferLength = 0;
      this.#releaseLease();
      this.#closed = false;
      this.#stopping = false;
      this.#initializing = undefined;
    } catch (error) {
      this.#cleanupError = errorMessage(error);
      this.state.fail(`Claude process cleanup unconfirmed: ${this.#cleanupError}`);
      this.#notify();
      this.#intentional.delete(child);
      this.#closed = false;
      this.#stopping = false;
      throw new Error(`Claude process cleanup unconfirmed: ${this.#cleanupError}`);
    }
  }
}

/**
 * Runs the part of frame handling that reads what the CLI sent. Anything it throws that is not
 * already classified is a protocol violation, so a new `throw` added later fails closed with the
 * generic explanation instead of an unexplained stop. Outbound writes and host callbacks are not
 * wrapped: their failures are not the CLI's fault.
 */
function inbound<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (
      error instanceof ClaudeProtocolError ||
      error instanceof ClaudeTurnFailure ||
      error instanceof ClaudeUndispatchedError
    )
      throw error;
    throw new ClaudeProtocolError("claude-protocol-violation", errorMessage(error));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const effortLevels: ClaudeEffort[] = ["low", "medium", "high", "xhigh", "max"];
const shortString = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= max &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );

const isPermissionMode = (value: unknown): value is ClaudePermissionMode =>
  value === "default" || value === "plan" || value === "acceptEdits";

/**
 * Maps a `permissionMode` the CLI reported to the closed set AgentKib can show. The CLI's
 * `--permission-mode manual` spelling means `default`; anything else, including values a newer
 * CLI might add, is unknown (null) rather than guessed.
 */
export function normalizeObservedPermissionMode(
  value: unknown,
): ClaudeObservedPermissionMode | null {
  if (value === "manual") return "default";
  if (
    isPermissionMode(value) ||
    value === "auto" ||
    value === "dontAsk" ||
    value === "bypassPermissions"
  )
    return value;
  return null;
}

function validateRunnerSettings(value: ClaudeRunnerEffectiveSettings): void {
  if (value.model !== null && !shortString(value.model, 256))
    throw new Error("invalid Claude model");
  if (value.effort !== null && !effortLevels.includes(value.effort))
    throw new Error("invalid Claude effort");
  if (value.permissionMode !== null && !isPermissionMode(value.permissionMode))
    throw new Error("unsupported Claude permission mode");
}

function projectCommands(value: unknown): ClaudeRunnerOptionsSnapshot["commands"] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 2048)
    throw new Error("invalid Claude command catalog");
  return value.map((entry: unknown) => {
    if (!object(entry) || !shortString(entry.name, 256)) throw new Error("invalid Claude command");
    return {
      name: entry.name,
      ...(shortString(entry.description, 4096) ? { description: entry.description } : {}),
      ...(shortString(entry.argumentHint, 1024) ? { argumentHint: entry.argumentHint } : {}),
    };
  });
}

export function parseClaudeFrame(line: string | Buffer): JsonObject {
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(line);
  if (bytes.length > MAX_LINE) throw new Error("Claude frame exceeds 25 MiB");
  if (!isUtf8(bytes)) throw new Error("malformed Claude stream JSON");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (!object(value)) throw new Error("malformed Claude stream JSON");
  return value;
}

export function validateClaudeContent(content: unknown): void {
  if (typeof content === "string") {
    if (!content.trim() || Buffer.byteLength(content) > 128 * 1024)
      throw new Error("invalid Claude text");
    return;
  }
  if (!Array.isArray(content) || content.length === 0 || content.length > 32)
    throw new Error("invalid Claude input blocks");
  let textBytes = 0;
  let imageBytes = 0;
  for (const block of content) {
    if (!object(block)) throw new Error("unsupported Claude input block");
    if (block.type === "text") {
      if (Object.keys(block).length !== 2 || typeof block.text !== "string" || !block.text.trim())
        throw new Error("invalid Claude text block");
      textBytes += Buffer.byteLength(block.text);
      continue;
    }
    if (block.type !== "image" || Object.keys(block).length !== 2 || !object(block.source))
      throw new Error("unsupported Claude input block");
    const { type, media_type: mediaType, data } = block.source;
    if (Object.keys(block.source).length !== 3 || type !== "base64" || typeof data !== "string")
      throw new Error("invalid Claude image source");
    if (data.length > Math.ceil((4 * 1024 * 1024) / 3) * 4)
      throw new Error("Claude image exceeds 4 MiB");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 4 * 1024 * 1024)
      throw new Error("Claude image exceeds 4 MiB");
    if (bytes.toString("base64") !== data) throw new Error("invalid Claude image data");
    const valid =
      (mediaType === "image/png" &&
        bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
      (mediaType === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ||
      (mediaType === "image/gif" &&
        ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())) ||
      (mediaType === "image/webp" &&
        bytes.subarray(0, 4).toString() === "RIFF" &&
        bytes.subarray(8, 12).toString() === "WEBP");
    if (!valid) throw new Error("Claude image format mismatch");
    imageBytes += bytes.length;
  }
  if (textBytes > 128 * 1024) throw new Error("Claude text exceeds 128 KiB");
  if (imageBytes > 12 * 1024 * 1024) throw new Error("Claude images exceed 12 MiB");
}

function questionSchema(input: JsonObject): JsonObject[] {
  if (Object.keys(input).some((key) => !["questions", "metadata"].includes(key)))
    throw new Error("unsupported question input");
  const rows = input.questions;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 4)
    throw new Error("unsupported question count");
  const ids = new Set<string>();
  return rows.map((row: unknown) => {
    if (
      !object(row) ||
      Object.keys(row).some(
        (key) => !["question", "header", "options", "multiSelect"].includes(key),
      )
    )
      throw new Error("unsupported question fields");
    if (typeof row.question !== "string" || !row.question || ids.has(row.question))
      throw new Error("invalid or duplicate Claude question");
    ids.add(row.question);
    if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 4)
      throw new Error("unsupported choices");
    const labels = new Set<string>();
    for (const option of row.options) {
      if (
        !object(option) ||
        Object.keys(option).some((key) => !["label", "description"].includes(key))
      )
        throw new Error("unsupported choice fields");
      if (typeof option.label !== "string" || !option.label || labels.has(option.label))
        throw new Error("invalid or duplicate Claude choice");
      labels.add(option.label);
    }
    if (row.multiSelect !== undefined && typeof row.multiSelect !== "boolean")
      throw new Error("invalid multiSelect");
    return {
      id: row.question,
      header: row.header,
      question: row.question,
      options: row.options,
      multiSelect: row.multiSelect ?? false,
      allowCustom: true,
    };
  });
}
