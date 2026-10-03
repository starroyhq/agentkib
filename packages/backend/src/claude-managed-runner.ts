import { randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { MacOwnedProcessTree } from "./mac-owned-process-tree";
import { acquirePortableFileLease } from "./managed-session-lock";

const MAX_TEXT = 4 * 1024 * 1024;
const MAX_LINE = 6 * MAX_TEXT + 1024 * 1024;
const MAX_INTERACTIONS = 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type ClaudeRunnerSnapshot = {
  lastOutcome: string | null;
  model: string | null;
  tokenUsage: unknown;
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
  reason: string | null = null;
  initialized = false;
  initId = "";
  pendingUser: JsonObject | null = null;
  model: string | null = null;
  usage: unknown = null;
  lastOutcome: string | null = null;
  partial = false;
  foregroundBashContract = false;
  bashToolIds = new Set<string>();
  foregroundTasks = new Map<string, string>();

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
      reason: this.reason,
      initialized: this.initialized,
      initId: this.initId,
      pendingUser: this.pendingUser ? structuredClone(this.pendingUser) : null,
      model: this.model,
      usage: this.usage ? structuredClone(this.usage) : null,
      lastOutcome: this.lastOutcome,
      partial: this.partial,
      foregroundBashContract: this.foregroundBashContract,
      bashToolIds: new Set(this.bashToolIds),
      foregroundTasks: new Map(this.foregroundTasks),
    };
  }

  restoreStartup(checkpoint: ReturnType<ClaudeRunnerState["checkpoint"]>, reason: string): void {
    Object.assign(this, checkpoint);
    this.revision = checkpoint.revision + 1;
    this.reason = reason;
  }

  initialize(pendingUser: JsonObject): JsonObject {
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
      lastOutcome: this.lastOutcome,
      model: this.model,
      tokenUsage: this.usage,
      status: this.status,
      sendEnabled: this.status === "idle",
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
    if (this.status !== "idle") throw new Error("Claude session is busy or failed");
    this.turnId = turnId;
    this.streamText = "";
    this.partial = false;
    this.reason = null;
    this.lastOutcome = null;
    this.bashToolIds.clear();
    this.foregroundTasks.clear();
    this.status = "running";
    this.revision++;
    return {
      type: "user",
      session_id: this.sessionId,
      parent_tool_use_id: null,
      uuid: turnId,
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
    this.status = "idle";
    this.lastOutcome = "cancelled";
    this.initialized = false;
    this.initId = "";
    this.seenRequests.clear();
    this.partial = false;
    this.approvals = [];
    this.questions = [];
    this.pendingUser = null;
    this.reason = null;
    this.revision++;
  }

  fail(reason: string): void {
    this.status = "outcome-unknown";
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
        const event = frame.event;
        if (event?.type === "content_block_start")
          this.#observeBash(event.content_block, frame.parent_tool_use_id);
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          if (typeof event.delta.text !== "string") throw new Error("invalid Claude text delta");
          this.#append(event.delta.text);
          this.partial = true;
        }
        break;
      }
      case "assistant": {
        const blocks = frame.message?.content;
        if (Array.isArray(blocks))
          for (const block of blocks) this.#observeBash(block, frame.parent_tool_use_id);
        if (!this.partial && Array.isArray(blocks))
          for (const block of blocks)
            if (block?.type === "text") {
              if (typeof block.text !== "string") throw new Error("invalid Claude text");
              this.#append(block.text);
            }
        this.partial = false;
        break;
      }
      case "result":
        if (this.foregroundTasks.size)
          throw new Error("Claude result with unresolved foreground tasks");
        this.usage = frame.usage ?? null;
        if (!this.initialized) throw new Error("Claude resume failed before initialization");
        if (this.approvals.length || this.questions.length)
          throw new Error("Claude result with unresolved approvals");
        if (frame.is_error === true || frame.subtype !== "success") {
          const detail = Array.isArray(frame.errors)
            ? frame.errors.filter((item: unknown) => typeof item === "string").join("; ")
            : "";
          throw new Error(
            `Claude turn failed: ${detail || frame.result || "unknown execution error"}`,
          );
        }
        if (!this.streamText && typeof frame.result === "string") this.#append(frame.result);
        this.status = "idle";
        this.streamText = "";
        break;
      case "system":
        if (frame.subtype === "init" && typeof frame.model === "string") this.model = frame.model;
        if (
          ["task_started", "background_tasks_changed"].includes(frame.subtype) ||
          (this.foregroundBashContract &&
            ["task_updated", "task_notification"].includes(frame.subtype))
        )
          this.#taskFrame(frame);
        break;
      case "user":
      case "tool_progress":
      case "tool_use_summary":
      case "rate_limit_event":
      case "auth_status":
      case "prompt_suggestion":
        break;
      default:
        throw new Error(
          `unsupported Claude stream frame (${String(frame.type).slice(0, 64)}); process stopped`,
        );
    }
    this.revision++;
    return null;
  }

  #controlRequest(frame: JsonObject): null {
    if (!this.initialized) throw new Error("Claude requested interaction before initialize");
    if (!["running", "waiting-approval", "waiting-input"].includes(this.status))
      throw new Error("Claude interaction outside active turn");
    const id = frame.request_id;
    if (typeof id !== "string" || !id) throw new Error("invalid Claude request id");
    if (this.seenRequests.size >= 4096 || this.seenRequests.has(id))
      throw new Error("duplicate Claude control request");
    this.seenRequests.add(id);
    const request = frame.request;
    if (!object(request) || request.subtype !== "can_use_tool")
      throw new Error("unsupported Claude control request; process stopped");
    const name = request.tool_name;
    if (typeof name !== "string" || !name || !object(request.input))
      throw new Error("invalid Claude tool input");
    if (this.approvals.length >= 32) throw new Error("too many pending Claude approvals");
    const allowed = new Set([
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
    if (Object.keys(request).some((key) => !allowed.has(key)))
      throw new Error("unsupported Claude permission scope");
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
    )
      throw new Error("unsupported Claude user interaction; process stopped");
    const context = { ...request };
    delete context.input;
    delete context.tool_name;
    delete context.subtype;
    context.blockedPath = request.blocked_path ?? null;
    context.decisionReason = request.decision_reason ?? null;
    context.permissionSuggestions = request.permission_suggestions ?? null;
    delete context.blocked_path;
    delete context.decision_reason;
    delete context.permission_suggestions;
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

  #append(value: string): void {
    if (Buffer.byteLength(this.streamText) + Buffer.byteLength(value) > MAX_TEXT)
      throw new Error("Claude output exceeds 4 MiB");
    this.streamText += value;
  }

  #observeBash(block: JsonObject, parent: unknown): void {
    if (!this.foregroundBashContract || block?.type !== "tool_use" || block.name !== "Bash") return;
    if (!this.initialized || this.status !== "running" || !this.turnId || parent !== null)
      throw new Error("Claude Bash outside current top-level turn");
    if (typeof block.id !== "string" || !block.id || Buffer.byteLength(block.id) > 256)
      throw new Error("invalid Claude Bash tool ID");
    if (this.bashToolIds.size >= 4096) throw new Error("too many Claude Bash tools");
    this.bashToolIds.add(block.id);
  }

  #taskFrame(frame: JsonObject): void {
    if (!this.foregroundBashContract)
      throw new Error("Claude background tasks are unsupported in managed sessions");
    const subtype = typeof frame.subtype === "string" ? frame.subtype : "";
    if (subtype === "background_tasks_changed") {
      if (!Array.isArray(frame.tasks) || frame.tasks.length)
        throw new Error("Claude background tasks are unsupported in managed sessions");
      return;
    }
    if (
      !this.initialized ||
      !["running", "waiting-approval", "waiting-input"].includes(this.status)
    )
      throw new Error("Claude task outside active turn");
    const task = frame.task_id;
    if (typeof task !== "string" || !task || Buffer.byteLength(task) > 256)
      throw new Error("invalid Claude task ID");
    if (subtype === "task_started") {
      const tool = frame.tool_use_id;
      if (
        frame.task_type !== "local_bash" ||
        frame.is_backgrounded !== false ||
        frame.owned_by_subagent === true ||
        typeof tool !== "string" ||
        !this.bashToolIds.has(tool) ||
        this.foregroundTasks.size >= 4096 ||
        this.foregroundTasks.has(task) ||
        [...this.foregroundTasks.values()].includes(tool)
      )
        throw new Error("unverified Claude foreground Bash task");
      this.foregroundTasks.set(task, tool);
      return;
    }
    if (subtype === "task_updated") {
      if (!this.foregroundTasks.has(task) || !object(frame.patch))
        throw new Error("unknown Claude foreground task");
      if (frame.patch.is_backgrounded !== undefined && frame.patch.is_backgrounded !== false)
        throw new Error("Claude background tasks are unsupported in managed sessions");
      if (
        frame.patch.status !== undefined &&
        !["pending", "running", "completed", "failed", "killed", "paused"].includes(
          frame.patch.status,
        )
      )
        throw new Error("invalid Claude task status");
      return;
    }
    if (subtype === "task_notification") {
      if (
        this.foregroundTasks.get(task) !== frame.tool_use_id ||
        !["completed", "failed", "stopped"].includes(frame.status)
      )
        throw new Error("unverified Claude task completion");
      this.foregroundTasks.delete(task);
      return;
    }
    throw new Error("unsupported Claude task update");
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

  constructor(
    readonly workspace: string,
    readonly sessionId: string,
    fresh: boolean,
    revision: number,
    readonly environment: NodeJS.ProcessEnv,
    readonly onSnapshot: (snapshot: ClaudeRunnerSnapshot) => void,
    foregroundBashContract = false,
  ) {
    if (process.platform !== "darwin" && process.platform !== "linux")
      throw new Error("managed Claude process groups require Unix");
    this.state = new ClaudeRunnerState(sessionId);
    this.state.revision = revision;
    this.state.foregroundBashContract = foregroundBashContract;
    this.#fresh = fresh;
  }

  snapshot(): ClaudeRunnerSnapshot {
    return this.state.snapshot();
  }

  get hasWorker(): boolean {
    return this.#child !== undefined;
  }

  get isRetiring(): boolean {
    return this.#retiring;
  }

  retireIfInactive(): Promise<boolean> | null {
    if (!this.#child || this.#retiring || this.state.status !== "idle") return null;
    this.#retiring = true;
    return (async () => {
      try {
        await this.shutdown();
        this.state.initialized = false;
        this.state.initId = "";
        this.state.seenRequests.clear();
        this.state.bashToolIds.clear();
        this.state.foregroundTasks.clear();
        this.state.revision++;
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
  ): Promise<void> {
    if (this.#retiring) throw new Error("Claude runner is being retired");
    const checkpoint = this.state.checkpoint();
    if (this.state.revision !== revision) throw new Error("stale Claude revision");
    if (this.#child && !this.state.initialized) throw new Error("Claude initialize is incomplete");
    const user = this.state.begin(content, requestId);
    if (this.#child) {
      try {
        await this.#write(user);
      } catch (error) {
        this.#fail(`Claude user write failed: ${errorMessage(error)}`);
        throw error;
      }
      return;
    }
    const init = this.state.initialize(user);
    let started: ChildProcess | undefined;
    try {
      started = this.#start(executable);
      await this.#write(init);
      await this.#initializing;
      this.#fresh = false;
    } catch (error) {
      if (!started?.pid) {
        this.state.restoreStartup(checkpoint, errorMessage(error));
      } else {
        this.#fail(errorMessage(error));
      }
      throw error;
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
    this.#acquireLease();
    let child: ChildProcess;
    try {
      child = spawn(
        executable,
        [
          `${this.#fresh ? "--session-id" : "--resume"}=${this.sessionId}`,
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
        ],
        {
          cwd: this.workspace,
          env: this.environment,
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
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      this.#child = undefined;
      this.#releaseLease();
      throw error;
    }
    this.#initializing = new Promise<void>((resolve, reject) => {
      this.#resolveInitialization = resolve;
      this.#rejectInitialization = reject;
      this.#initializationTimer = setTimeout(() => {
        const error = new Error("Claude initialize timed out");
        this.#rejectInitialization?.(error);
        this.#fail(error.message);
      }, 30_000);
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
    child.stdout?.on("data", (chunk: Buffer) => this.#data(chunk));
    child.stdout?.on("end", () => {
      if (this.#bufferLength) {
        const final = Buffer.concat(this.#fragments, this.#bufferLength);
        this.#fragments = [];
        this.#bufferLength = 0;
        this.#enqueueFrame(final);
      }
      if (!this.#intentional.has(child))
        void this.#frameChain.finally(() => this.#fail("Claude stream closed"));
    });
    child.stdin?.on("error", (error) => {
      if (!this.#intentional.has(child)) this.#fail("Claude stdin write failed");
      this.#rejectInitialization?.(error instanceof Error ? error : new Error(String(error)));
    });
    child.on("error", (error) => {
      this.#rejectInitialization?.(error);
      if (!this.#intentional.has(child)) this.#fail(error.message);
    });
    child.on("close", (code) => {
      if (!this.#intentional.has(child)) this.#fail(`Claude process exited (${code ?? "unknown"})`);
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

  #data(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      if (newline < 0) {
        const fragment = chunk.subarray(offset);
        this.#fragments.push(Buffer.from(fragment));
        this.#bufferLength += fragment.length;
        if (this.#bufferLength > MAX_LINE) {
          this.#fail("Claude frame exceeds 25 MiB");
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
        this.#fail("Claude frame exceeds 25 MiB");
        return;
      }
      this.#enqueueFrame(line);
      offset = newline + 1;
    }
  }

  #enqueueFrame(line: Buffer): void {
    this.#queuedFrames++;
    if (this.#queuedFrames >= 32) this.#child?.stdout?.pause();
    this.#frameChain = this.#frameChain
      .then(async () => {
        const frame = parseClaudeFrame(line);
        const wasInitialized = this.state.initialized;
        const response = this.state.frame(frame);
        this.#notify();
        if (!wasInitialized && this.state.initialized) {
          if (response) await this.#write(response);
          this.#resolveInitialization?.();
          this.#resolveInitialization = undefined;
          this.#rejectInitialization = undefined;
        } else if (response) {
          await this.#write(response);
        }
      })
      .catch((error: unknown) => {
        const reason = errorMessage(error);
        this.#fail(reason);
        this.#rejectInitialization?.(error instanceof Error ? error : new Error(reason));
      })
      .finally(() => {
        this.#queuedFrames--;
        if (this.#queuedFrames < 16) this.#child?.stdout?.resume();
      });
  }

  async #write(frame: JsonObject): Promise<void> {
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

  #fail(reason: string): void {
    if (this.state.status !== "outcome-unknown") this.state.fail(reason);
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
    const child = this.#child;
    const tree = this.#tree;
    if (!child || !tree) return;
    this.#stopping = true;
    this.#closed = true;
    this.#intentional.add(child);
    try {
      await tree.terminate(child);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
