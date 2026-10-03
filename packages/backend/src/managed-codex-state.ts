import type { CodexAppServerSession } from "./codex-app-server";

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

/** Mutable projection of one AgentKib-owned app-server thread. */
export class ManagedCodexState {
  #record: ManagedRecord;
  #revision = 0;
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

  constructor(record: ManagedRecord, initialRevision = 0) {
    this.#record = structuredClone(record);
    this.#revision =
      Number.isSafeInteger(initialRevision) && initialRevision >= 0 ? initialRevision : 0;
  }

  get revision(): number {
    return this.#revision;
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

  hasResolvedRequest(turnId: string, requestId: unknown): boolean {
    return this.#resolved.has(`${turnId}:${requestKey(requestId)}`);
  }

  get record(): Readonly<ManagedRecord> {
    return this.#record;
  }

  snapshot(runtimeBootId: string, controls: boolean): JsonObject {
    const healthy = this.#reason === null;
    return {
      sessionId: this.#record.id,
      workspaceId: this.#record.workspace_id,
      runtimeBootId,
      executionMode: "codex-managed",
      status: this.#status,
      revision: this.#revision,
      turnId: this.#turn,
      sendEnabled: controls && healthy && this.#status === "idle",
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
      goal: this.#record.goal ?? null,
      reason: this.#reason,
    };
  }

  /** Apply one app-server notification or request; return the ledger event to persist. */
  apply(value: unknown): { changed: boolean; event?: JsonObject } {
    if (!isObject(value)) throw new Error("invalid-codex-notification");
    const method = typeof value.method === "string" ? value.method : "";
    const params = isObject(value.params) ? value.params : {};
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
        if (this.nativeId && this.nativeId !== id) return { changed: false };
        this.#record.native_id = id;
        break;
      }
      case "turn/started": {
        const turn = isObject(params.turn) ? params.turn : {};
        this.#turn = requiredString(turn.id, "invalid-turn");
        this.#status = "running";
        this.#stream = "";
        this.#reason = null;
        break;
      }
      case "turn/completed": {
        if (!isObject(params.turn) || params.turn.id !== this.#turn) return { changed: false };
        this.#turn = null;
        this.#status = "idle";
        this.#approvals.clear();
        this.#questions.clear();
        this.#items.clear();
        break;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta": {
        if (params.turnId !== this.#turn || typeof params.delta !== "string")
          return { changed: false };
        if (Buffer.byteLength(this.#stream + params.delta, "utf8") <= MAX_STREAM_BYTES)
          this.#stream += params.delta;
        break;
      }
      case "item/started":
      case "item/completed": {
        if (this.#turn === null || params.turnId !== this.#turn || !isObject(params.item))
          return { changed: false };
        const id = requiredString(params.item.id, "invalid-item");
        if (this.#items.size >= MAX_ITEMS && !this.#items.has(id))
          throw new Error("too-many-items");
        this.#items.set(id, structuredClone(params.item));
        if (method === "item/completed") {
          const event = projectItem(params.item, this.#turn);
          this.#revision += 1;
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
        break;
      }
      case "thread/status/changed":
        if (isObject(params.status) && params.status.type === "systemError")
          this.fail("codex-thread-error");
        else return { changed: false };
        break;
      case "thread/settings/updated":
        if (!isObject(params.threadSettings)) throw new Error("invalid-thread-settings");
        this.#record.native_settings = structuredClone(params.threadSettings);
        break;
      case "thread/tokenUsage/updated":
        if (!isObject(params.tokenUsage)) throw new Error("invalid-token-usage");
        this.#record.token_usage = structuredClone(params.tokenUsage);
        break;
      case "thread/goal/updated":
        if (!isObject(params.goal)) throw new Error("invalid-goal");
        this.#record.goal = structuredClone(params.goal);
        this.#goalRevision += 1;
        break;
      case "thread/goal/cleared":
        this.#record.goal = null;
        this.#goalRevision += 1;
        break;
      default:
        if ("id" in value) {
          this.#status = "waiting-input";
          this.#reason = "unsupported-codex-request";
        } else {
          return { changed: false };
        }
    }
    return this.#changed();
  }

  hydrate(
    thread: unknown,
    incrementRevision = true,
  ): { snapshot: JsonObject; events: JsonObject[] } {
    if (!isObject(thread) || typeof thread.id !== "string") throw new Error("invalid-thread");
    if (this.nativeId && this.nativeId !== thread.id) throw new Error("thread-identity-mismatch");
    this.#record.native_id = thread.id;
    this.#turn = null;
    this.#status = "idle";
    this.#reason = null;
    this.#approvals.clear();
    this.#questions.clear();
    const events: JsonObject[] = [];
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      if (!isObject(turn)) continue;
      if (turn.status === "inProgress") {
        this.#turn = typeof turn.id === "string" ? turn.id : null;
        this.#status = "running";
      }
      for (const item of Array.isArray(turn.items) ? turn.items : []) {
        if (!isObject(item) || typeof turn.id !== "string") continue;
        const event = projectItem(item, turn.id);
        if (event) events.push(event);
      }
    }
    if (isObject(thread.status) && thread.status.type === "active" && this.#turn === null)
      this.fail("unconfirmed-active-turn");
    if (incrementRevision) this.#revision += 1;
    return { snapshot: this.snapshot("", false), events };
  }

  fail(reason: string): void {
    this.#status = "outcome-unknown";
    this.#reason = reason;
    this.#record.native_settings = null;
    this.#revision += 1;
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
    this.#revision += 1;
    return true;
  }

  acceptStartedTurn(turnId: string, expectedRevision: number): void {
    if (this.#revision !== expectedRevision || this.#turn !== null || this.#status !== "idle")
      throw new Error("stale-or-disabled-control");
    this.#turn = turnId;
    this.#status = "running";
    this.#reason = null;
    this.#revision += 1;
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
    Object.assign(this.#record, update);
    if (status) this.#status = status;
    this.#revision += 1;
  }

  #changed(): { changed: true } {
    this.#revision += 1;
    return { changed: true };
  }
}

export class ManagedCodexEventBridge {
  #pending: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    readonly session: CodexAppServerSession,
    readonly state: ManagedCodexState,
    readonly persist: (state: ManagedCodexState, event?: JsonObject) => Promise<void> | void,
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#pending;
    await this.session.close();
  }

  #enqueue(value: unknown): void {
    if (this.#closed) return;
    this.#pending = this.#pending.then(async () => {
      const result = this.state.apply(value);
      if (result.changed) await this.persist(this.state, result.event);
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

function projectItem(item: JsonObject, turnId: string): JsonObject | undefined {
  const id = typeof item.id === "string" ? item.id : null;
  if (!id) throw new Error("invalid-item");
  let kind: string;
  let content = "";
  let toolName: string | null = null;
  let toolStatus: string | null = null;
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
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "webSearch":
      kind = "tool-summary";
      toolName = item.type;
      toolStatus = typeof item.status === "string" ? item.status : null;
      break;
    default:
      return;
  }
  const truncated = Buffer.byteLength(content, "utf8") > 128 * 1024;
  const boundedContent = [...content].slice(0, 32768).join("");
  return {
    id,
    kind,
    turn_id: turnId,
    timestamp: new Date().toISOString(),
    content: boundedContent,
    tool_name: toolName,
    tool_status: toolStatus,
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
